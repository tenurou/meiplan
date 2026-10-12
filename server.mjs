import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLicenseService } from './licensing.mjs';
import { makeUserId, readUsers, verifyBasicAuthorization } from './auth.mjs';
import { forceKillChromium, recordBrowserActivity } from './browser-cleanup.mjs';
import { assertCompleteCheckCoverage, expandSpannedCells, expectedCheckKeys, verifyCoreChecks } from './reconcile.mjs';
import { calculationModel, corePlacementGroup, eligiblePlanMetrics, isManualEntryHeader, planMetric, planPlacementGroup } from './public/plan-rules.js';
import { parseNumericValue } from './public/numeric.js';
import { rankFactTables } from './public/report-selector.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = path.resolve(process.env.AGM_DATA_DIR || path.join(here, 'data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const require = createRequire(import.meta.url);
let chromium;
for (const candidate of [process.env.AGM_PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
  try { ({ chromium } = require(candidate)); break; } catch { /* try the next installed runtime */ }
}
if (!chromium) throw new Error('Playwright не найден. Выполни npm install в папке приложения.');
const python = process.env.AGM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const browserChannel = process.env.AGM_BROWSER_CHANNEL || '';
const usersFile = path.resolve(process.env.AGM_USERS_FILE || path.join(dataDir, 'users.json'));
const users = readUsers(usersFile);
const host = process.env.AGM_HOST || '127.0.0.1';
const port = Number(process.env.AGM_PORT || 8765);
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase());
const publicOrigin = (process.env.AGM_PUBLIC_ORIGIN || '').replace(/\/$/, '');
const allowedHosts = new Set((process.env.AGM_ALLOWED_HOSTS || `127.0.0.1,localhost,${host}`).split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
if (!isLoopback && (!users.length || !/^https:\/\//i.test(publicOrigin))) throw new Error('Для сетевого запуска задай AGM_USERS_FILE с пользователями и AGM_PUBLIC_ORIGIN=https://...; без них сервер остаётся loopback-only.');
if (!isLoopback && !process.env.AGM_ALLOWED_HOSTS) throw new Error('Для сетевого запуска явно задай AGM_ALLOWED_HOSTS для reverse proxy.');
function isAllowedOrigin(origin) {
  if (!publicOrigin) return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
  if (isLoopback && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return true;
  if (origin === publicOrigin) return true;
  try { const parsed = new URL(origin); return parsed.protocol === 'https:' && allowedHosts.has(parsed.hostname.toLowerCase()); } catch { return false; }
}
const requestStorage = new AsyncLocalStorage();
const sessions = new Map();
const authCache = new Map();
const adminLoginFailures = new Map();
const activeLaunches = new Set();
const maxBrowsersValue = Number(process.env.AGM_MAX_BROWSERS || 18);
const maxBrowsers = Number.isFinite(maxBrowsersValue) ? Math.max(1, Math.min(18, Math.floor(maxBrowsersValue))) : 18;
const idleMinutesValue = Number(process.env.AGM_IDLE_BROWSER_MINUTES || 60);
const idleBrowserMs = (Number.isFinite(idleMinutesValue) ? Math.max(5, idleMinutesValue) : 60) * 60 * 1000;
function current() { return requestStorage.getStore(); }
function sessionFor(user) {
  const id = user.sessionId || makeUserId(user.username).slice(0, 32);
  if (!sessions.has(id)) {
    const userDir = path.join(dataDir, 'users', id);
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const profileDir = path.join(userDir, 'browser-profile');
    const workbookPath = path.join(userDir, 'uploaded-plan.xlsx');
    sessions.set(id, { id, username: user.username, adminUser: null, adminExpiresAt: 0, userDir, profileDir, workbookPath, secret: crypto.randomBytes(24).toString('hex'), context: null, workbook: null, workbookFileName: null, activeReport: null, proposals: new Map(), lastActivity: Date.now(), loading: null });
  }
  return sessions.get(id);
}
async function loadUserData(state) {
  if (!state.loading) state.loading = (async () => {
    fs.mkdirSync(state.profileDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(state.workbookPath)) {
      try {
        const restored = await runPython(state.workbookPath);
        if (!restored.error) { state.workbook = restored; state.workbookFileName = 'uploaded-plan.xlsx'; }
      } catch (error) { console.warn(`Не удалось восстановить книгу пользователя ${state.username}: ${error.message}`); }
    }
  })();
  await state.loading;
}
const license = createLicenseService({ dataDir });

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) res.end(body);
  else res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req, max = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > max) { reject(new Error('Файл больше 40 МБ')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseMultipart(body, contentType) {
  const match = String(contentType || '').match(/\bboundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (match?.[1] || match?.[2] || '').trim();
  if (!boundary || boundary.length > 200) throw new Error('Не удалось прочитать вложения формы.');
  const delimiter = Buffer.from(`--${boundary}`), separator = Buffer.from(`\r\n--${boundary}`), headerBreak = Buffer.from('\r\n\r\n');
  const fields = new Map(), files = [];
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString() === '--') break;
    if (body.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = body.indexOf(headerBreak, cursor);
    if (headerEnd < 0) throw new Error('Вложение передано в неверном формате.');
    const headers = body.subarray(cursor, headerEnd).toString('latin1');
    const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!disposition) throw new Error('Вложение передано в неверном формате.');
    const name = disposition[1], filename = disposition[2];
    const valueStart = headerEnd + headerBreak.length, valueEnd = body.indexOf(separator, valueStart);
    if (valueEnd < 0) throw new Error('Вложение передано в неверном формате.');
    const value = body.subarray(valueStart, valueEnd);
    if (filename !== undefined) {
      if (filename) files.push({ name, filename: Buffer.from(filename, 'latin1').toString('utf8'), bytes: Buffer.from(value), contentType: headers.match(/\r\ncontent-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream' });
    } else {
      if (!['category', 'message', 'contact'].includes(name) || fields.has(name)) throw new Error('В форме обратной связи есть неизвестные или повторяющиеся поля.');
      fields.set(name, value.toString('utf8'));
    }
    cursor = valueEnd + 2;
  }
  return { fields, files };
}
function runPython(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(here, 'parse_xlsx.py'), filePath], { ...(process.platform === 'win32' ? { windowsHide: true } : {}), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    child.stdout.on('data', b => out += b.toString('utf8'));
    child.stderr.on('data', b => err += b.toString('utf8'));
    child.on('error', () => reject(new Error('Python 3 не найден. Установи Python 3 или задай переменную AGM_PYTHON с путём к интерпретатору.')));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err || out || `Excel reader exited ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Не удалось прочитать структуру Excel')); }
    });
  });
}
function safePlanUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'core.ag-media.ru' || !/^\/documents\/mediaplans\/\d+\/edit\/?$/.test(url.pathname)) throw new Error('Открой ссылку формата core.ag-media.ru/documents/mediaplans/ID/edit');
  return url.href;
}
function isReportPageUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' && url.hostname === 'reports.core.ag-media.ru')
      || (url.protocol === 'https:' && url.hostname === 'core.ag-media.ru' && /^\/reports\/client-reports\/\d+\/view\/?$/.test(url.pathname));
  } catch { return false; }
}
function parseDisplayNumber(raw) {
  return parseNumericValue(raw);
}
function sameCellValue(actual, expected, header = '') {
  const a=String(actual??'').trim(),e=String(expected??'').trim();
  if(a===e)return true;
  let an=parseDisplayNumber(a),en=parseDisplayNumber(e);
  if(an!==null&&en!==null){
    const h=String(header).toLowerCase().replace(/ё/g,'е');
    if(/(?:cr[123]|ctr)/.test(h)){if(a.includes('%'))an/=100;if(e.includes('%'))en/=100;return Math.abs(an-en)<0.00005;}
    if(/(?:^| )(?:все )?лиды?(?: |$)|^цо(?: |$)|целев.*лид/.test(h))return an===en;
    if(/показ/.test(h))return Math.abs(an-en)<0.5;
    if(/бюджет|расход|стоимост|^cpm|^cpc|^cpl|^cpa/.test(h))return Math.abs(an-en)<0.005;
    return Math.abs(an-en)<0.00001;
  }
  return a.includes(e);
}
function normText(value) {
  return String(value||'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
function uniqueHeaderIndex(headers, name) {
  const found=headers.map((header,index)=>normText(header)===normText(name)?index:-1).filter(index=>index>=0);
  return found.length===1?found[0]:-1;
}
function excelPlacementGroup(headers,row) {
  return planPlacementGroup(headers,row);
}
function corePlacementContext(rows,rowIndex,nameCol,placementCol) {
  for(let i=rowIndex-1;i>=1;i--){
    const description=String(rows[i][nameCol]||'').trim(),placement=String(rows[i][placementCol]||'').trim();
    if(description||!placement)continue;
    const groupKey=corePlacementGroup(placement);
    return {groupKey,model:groupKey.split('|').at(-1)||''};
  }
  return {groupKey:'',model:''};
}
function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function pagesState() {
  const state = current();
  if (!state?.context) return [];
  return Promise.all(state.context.pages().map(async (page, i) => ({ i, url: page.url(), title: await page.title().catch(() => ''), closed: page.isClosed() })));
}
async function tableCandidates() {
  const result = [];
  const state = current();
  if (!state?.context) return result;
  for (const [pageIndex, page] of state.context.pages().entries()) {
    for (const [frameIndex, frame] of page.frames().entries()) {
      if (!/^https:\/\/(reports\.core\.ag-media\.ru|datalens\.(?:yandex|yandex\.ru|yandexcloud\.net))(\/|$)/.test(frame.url())) continue;
      try {
        const [tables, reportContext] = await Promise.all([
          frame.evaluate(async () => {
          const candidates = [];
          const norm = el => (el.innerText || el.textContent || '').trim();
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          async function collect(root, rowSelector, cellSelector) {
            const rowMap = new Map();
            const take = () => {
              const ownerSelector=root.matches('table')?'table':'[role="grid"]';
              const rowElements=[...root.querySelectorAll(rowSelector)].filter(row=>row.closest(ownerSelector)===root);
              const matrix=[];
              rowElements.forEach((row,rowIndex)=>{
                const values=matrix[rowIndex] ||= [];
                let column=0;
                const cells=[...row.querySelectorAll(cellSelector)].filter(cell=>cell.closest(rowSelector)===row&&cell.closest(ownerSelector)===root);
                for(const cell of cells){
                  while(column<values.length&&values[column]!==undefined)column++;
                  const value=norm(cell);
                  const colSpan=Math.max(1,Number(cell.colSpan||cell.getAttribute('aria-colspan'))||1);
                  const rawRowSpan=Number(cell.rowSpan??cell.getAttribute('aria-rowspan')??1);
                  const rowSpan=rawRowSpan===0?rowElements.length-rowIndex:rawRowSpan;
                  for(let r=rowIndex;r<Math.min(rowElements.length,rowIndex+rowSpan);r++){
                    const target=matrix[r] ||= [];
                    for(let c=column;c<column+colSpan;c++)if(target[c]===undefined)target[c]=c===column?value:'';
                  }
                  column+=colSpan;
                }
              });
              for (const values0 of matrix) {
                const values=values0.map(value=>value??'');
                if(values.some(Boolean)) rowMap.set(JSON.stringify(values),values);
                if(rowMap.size>=3000)break;
              }
            };
            take();
            let scroller=root.parentElement;
            while(scroller&&scroller!==document.body&&scroller!==document.documentElement){
              const style=getComputedStyle(scroller);
              if(scroller.scrollHeight>scroller.clientHeight+40&&/(auto|scroll)/.test(style.overflowY))break;
              scroller=scroller.parentElement;
            }
            if(scroller&&scroller!==document.body&&scroller!==document.documentElement&&scroller.scrollHeight>scroller.clientHeight+40){
              const start=scroller.scrollTop, step=Math.max(120,Math.floor(scroller.clientHeight*.75));
              let previous=-1;
              for(let y=0;y<scroller.scrollHeight&&rowMap.size<3000;y+=step){
                scroller.scrollTop=y; await wait(35); take();
                if(y===previous)break; previous=y;
              }
              scroller.scrollTop=scroller.scrollHeight;await wait(50);take();scroller.scrollTop=start;await wait(30);
            }
            return [...rowMap.values()];
          }
          for (const table of document.querySelectorAll('table')) {
            const rows = await collect(table,'tr','th,td');
            if (rows.length > 1 && Math.max(...rows.map(r => r.length)) > 1) candidates.push({ kind: 'table', rows });
          }
          const grids = [...document.querySelectorAll('[role="grid"]')];
          for (const grid of grids) {
            const rows = await collect(grid,'[role="row"]','[role="columnheader"],[role="gridcell"],[role="cell"]');
            if (rows.length > 1) candidates.push({ kind: 'grid', rows });
          }
          const unique=new Map();
          for(const candidate of candidates.filter(c=>c.rows.length>1)){
            const key=JSON.stringify([candidate.rows.length,candidate.rows.slice(0,5),candidate.rows.slice(-2)]);
            if(!unique.has(key))unique.set(key,candidate);
          }
          return [...unique.values()].sort((a,b) => b.rows.length * Math.max(...b.rows.map(r=>r.length)) - a.rows.length * Math.max(...a.rows.map(r=>r.length))).slice(0, 40);
          }),
          frame.evaluate(() => {
            const visible = el => { const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'; };
            const text = el => (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,180);
            const controls=[...document.querySelectorAll('input,button,[role="button"],[role="combobox"],[aria-haspopup]')]
              .filter(visible).map(el=>({label:el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||'',value:el.value||el.getAttribute('aria-valuetext')||'',text:text(el)}))
              .filter(x=>x.label||x.value||x.text).slice(0,80);
            const keywords=/^(дата|текущий месяц|объект продвижения|медиаплан|класс|группа объявлений)\\b/i;
            const labels=[...document.querySelectorAll('label,[role="label"],span,div')].filter(visible).filter(el=>keywords.test(text(el))&&el.children.length<4).slice(0,30).map(el=>({label:text(el),nearby:text(el.parentElement||el)}));
            return {title:document.title,controls,labels};
          })
        ]);
        const pageTitle = await page.title().catch(() => '');
        tables.forEach((table, tableIndex) => result.push({ id: `${pageIndex}:${frameIndex}:${tableIndex}`, pageIndex, frameIndex, tableIndex, kind: table.kind, pageUrl: page.url(), frameUrl: frame.url(), pageTitle, reportContext, rows: table.rows }));
      } catch { /* inaccessible or unloading frame */ }
    }
  }
  return result;
}
async function readCoreTable(pageIndex) {
  const state = current();
  if (!state?.context || !state.context.pages()[pageIndex]) throw new Error('Вкладка Core не подключена');
  const page = state.context.pages()[pageIndex];
  if (!page.url().startsWith('https://core.ag-media.ru/documents/mediaplans/')) throw new Error('Выбранная вкладка не является медиапланом Core');
  const rawTables = await page.evaluate(() => {
    return [...document.querySelectorAll('table')].map((table, index) => ({
      index,
      sourceRows: [...table.querySelectorAll('tr')]
        .filter(tr => tr.closest('table') === table)
        .map(tr => [...tr.querySelectorAll('th,td')]
          .filter(cell => cell.closest('tr') === tr)
          .map(cell => ({
            value: (cell.querySelector('input,textarea')?.value || cell.innerText || cell.textContent || '').trim(),
            colSpan: cell.colSpan || Number(cell.getAttribute('aria-colspan')) || 1,
            rowSpan: cell.rowSpan ?? Number(cell.getAttribute('aria-rowspan')) ?? 1
          })))
    }));
  });
  const tables=rawTables.map(table=>({index:table.index,...expandSpannedCells(table.sourceRows)}))
    .filter(table=>table.rows.length>1)
    .sort((a,b)=>b.rows.length*Math.max(...b.rows.map(row=>row.length))-a.rows.length*Math.max(...a.rows.map(row=>row.length)));
  if (!tables.length) throw new Error('Не нашёл таблицу МП на странице. Открой редактирование факта или плана и попробуй снова.');
  const pageContext=await page.evaluate(()=>({title:document.title||'',text:(document.body?.innerText||'').slice(0,5000)}));
  return { pageIndex, url: page.url(), title:pageContext.title, contextText:pageContext.text, table: tables[0] };
}

async function authenticateRequest(req, res) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(pair => { const index = pair.indexOf('='); return index > 0 ? [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] : ['', '']; }).filter(([name]) => name));
  const enteringApp = req.method === 'GET' && req.url === '/';
  let sessionToken = cookies['agm-session'];
  let id = /^[A-Za-z0-9_-]{40,64}$/.test(sessionToken || '') ? crypto.createHash('sha256').update(sessionToken).digest('hex').slice(0, 32) : null;
  if (id && enteringApp) {
    const previous = sessions.get(id) || sessionFor({ username: `staff-${id.slice(0, 8)}`, key: id, role: 'user', sessionId: id });
    await clearSessionWorkspace(previous);
    sessions.delete(id);
    id = null;
  }
  if (!id) {
    sessionToken = crypto.randomBytes(32).toString('base64url');
    id = crypto.createHash('sha256').update(sessionToken).digest('hex').slice(0, 32);
    const secure = req.headers['x-forwarded-proto'] === 'https' || (!isLoopback && publicOrigin.startsWith('https://')) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `agm-session=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${secure}`);
  }
  const state = sessions.get(id) || sessionFor({ username: `staff-${id.slice(0, 8)}`, key: id, role: 'user', sessionId: id });
  await loadUserData(state);
  return state;
}

const server = http.createServer(async (req, res) => {
  const requestHost = String(req.headers.host || '').toLowerCase();
  let hostname = '';
  try { hostname = new URL(`http://${requestHost}`).hostname.toLowerCase(); } catch { /* malformed Host */ }
  if (!hostname || !allowedHosts.has(hostname)) return send(res, 403, { error: 'Этот адрес не разрешён сервером.' });
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) return send(res, 403, { error: 'Origin запроса не разрешён.' });
  const state = await authenticateRequest(req, res);
  if (!state) return;
  return requestStorage.run(state, async () => {
  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__APP_TOKEN__', state.secret);
    return send(res, 200, html, mime['.html']);
  }
  if (req.url?.startsWith('/public/')) {
    const file = path.resolve(publicDir, '.' + req.url.slice('/public'.length).split('?')[0]);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) return send(res, 404, 'Не найдено', 'text/plain');
    return send(res, 200, fs.readFileSync(file), mime[path.extname(file)] || 'application/octet-stream');
  }
  if (!req.url?.startsWith('/api/')) return send(res, 404, { error: 'Не найдено' });
  if (req.headers['x-agm-token'] !== state.secret) return send(res, 403, { error: 'Обнови страницу приложения.' });
  recordBrowserActivity(state, req.url);

  try {
    if (req.method === 'GET' && req.url === '/api/state') return send(res, 200, { connected: !!current().context, isAdmin: !!current().adminUser && current().adminExpiresAt > Date.now(), pages: await pagesState(), workbook: current().workbook ? current().workbook.sheets.map(s => ({ name: s.name, rows: s.rows.length })) : [], workbookFileName: current().workbookFileName, reportCaptured: !!current().activeReport, licensing: { ...license.getStatus(), enforcement: false } });
    if (req.method === 'POST' && req.url === '/api/admin/login') {
      const body = JSON.parse((await readBody(req, 4000)).toString('utf8'));
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const remoteKey = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
      const failures = adminLoginFailures.get(remoteKey) || { count: 0, until: 0 };
      if (failures.until > Date.now()) return send(res, 429, { error: 'Слишком много попыток. Подожди несколько минут и попробуй снова.' });
      const authHeader = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
      const user = await verifyBasicAuthorization(authHeader, users, authCache);
      if (!user || user.role !== 'admin') {
        failures.count++;
        failures.until = failures.count >= 5 ? Date.now() + 5 * 60 * 1000 : 0;
        adminLoginFailures.set(remoteKey, failures);
        return send(res, 401, { error: 'Неверное имя пользователя или пароль администратора.' });
      }
      adminLoginFailures.delete(remoteKey);
      current().adminUser = user.username;
      current().adminExpiresAt = Date.now() + 30 * 60 * 1000;
      return send(res, 200, { ok: true, isAdmin: true, username: user.username, expiresInSeconds: 1800 });
    }
    if (req.method === 'POST' && req.url === '/api/admin/logout') {
      current().adminUser = null;
      current().adminExpiresAt = 0;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/disconnect') {
      await clearSessionWorkspace(current());
      return send(res, 200, { ok: true, connected: false });
    }
    if (req.method === 'POST' && req.url === '/api/connect') {
      if (!current().context) {
        const active = [...sessions.values()].filter(item => item.context).length + activeLaunches.size;
        if (activeLaunches.has(state.id)) throw new Error('Браузер этого пользователя уже запускается. Подожди и обнови состояние.');
        if (active >= maxBrowsers) throw new Error(`Достигнут предел: одновременно запущено ${maxBrowsers} браузеров.`);
        activeLaunches.add(state.id);
        try {
        // Each authenticated user gets a separate persistent browser profile.
        current().context = await chromium.launchPersistentContext(current().profileDir, { ...(browserChannel ? { channel: browserChannel } : {}), headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
        if (process.env.NODE_ENV === 'test' && process.env.AGM_TEST_CORE_FIXTURE === '1') {
          const fixturePath=path.join(here,'test','fixtures','mock-core-mediaplan.html');
          const factFixturePath=path.join(here,'test','fixtures','mock-core-fact-mediaplan.html');
          const reportFixturePath=path.join(here,'test','fixtures','mock-datalens-report.html');
          const reportShellPath=path.join(here,'test','fixtures','mock-datalens-shell.html');
          await current().context.route('https://core.ag-media.ru/documents/mediaplans/999/edit',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fs.readFileSync(fixturePath,'utf8')}));
          await current().context.route('https://core.ag-media.ru/documents/mediaplans/998/edit',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fs.readFileSync(factFixturePath,'utf8')}));
          await current().context.route('https://core.ag-media.ru/reports/client-reports/20/view',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fs.readFileSync(reportShellPath,'utf8')}));
          await current().context.route('https://reports.core.ag-media.ru/fixture/datalens',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fs.readFileSync(reportShellPath,'utf8')}));
          await current().context.route('https://reports.core.ag-media.ru/fixture/datalens-frame',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fs.readFileSync(reportFixturePath,'utf8')}));
        }
        current().context.on('close', () => { state.context = null; state.activeReport = null; state.proposals.clear(); });
        } finally { activeLaunches.delete(state.id); }
      }
      const page = current().context.pages().find(p=>p.url()==='about:blank') || await current().context.newPage();
      return send(res, 200, { pages: await pagesState(), activePage: current().context.pages().indexOf(page), message: 'Встроенный браузер готов. Открой только те ссылки Core и DataLens, которые указал пользователь; профиль авторизации остаётся локальным.' });
    }
    if (req.method === 'POST' && req.url === '/api/new-tab') {
      if (!current().context) throw new Error('Сначала подключи браузер');
      const page = await current().context.newPage();
      return send(res, 200, { pages: await pagesState(), activePage: current().context.pages().indexOf(page) });
    }
    if (req.method === 'POST' && req.url === '/api/browser-open') {
      const body = JSON.parse((await readBody(req, 20000)).toString('utf8'));
      const url = new URL(String(body.url || ''));
      if (url.protocol !== 'https:' || !['core.ag-media.ru', 'reports.core.ag-media.ru'].includes(url.hostname)) throw new Error('Можно открыть только Core или DataLens.');
      if (!current().context) throw new Error('Сначала подключи браузер');
      let page = current().context.pages()[Number(body.pageIndex)];
      if (!page || page.isClosed()) page = await current().context.newPage();
      else if(page.url()!=='about:blank'&&!isReportPageUrl(page.url()))page=await current().context.newPage();
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return send(res, 200, { pages: await pagesState(), activePage: current().context.pages().indexOf(page) });
    }
    if (req.method === 'POST' && req.url === '/api/browser-action') {
      const body = JSON.parse((await readBody(req, 20000)).toString('utf8'));
      if (!current().context || !current().context.pages()[Number(body.pageIndex)]) throw new Error('Вкладка не подключена');
      const page = current().context.pages()[Number(body.pageIndex)];
      const host = new URL(page.url()).hostname;
      if (!['core.ag-media.ru','reports.core.ag-media.ru','auth.ag-media.ru','accounts.google.com','passport.yandex.ru','login.yandex.ru'].includes(host)) throw new Error('Управление разрешено только для Core, DataLens и известных страниц их авторизации.');
      if (body.action === 'click') {
        const x = Number(body.x), y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1440 || y > 1000) throw new Error('Координаты вне встроенной страницы.');
        await page.mouse.click(x, y);
      } else if (body.action === 'wheel') {
        await page.mouse.move(Number(body.x) || 50, Number(body.y) || 50);
        await page.mouse.wheel(0, Math.max(-1000, Math.min(1000, Number(body.deltaY) || 0)));
      } else if (body.action === 'key') {
        const allowed = new Set(['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown',' ']);
        const key = String(body.key || '');
        if (allowed.has(key)) await page.keyboard.press(key);
        else if (/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(key)) await page.keyboard.insertText(key);
        else throw new Error('Недопустимая клавиша.');
      } else if (body.action === 'text') {
        const text = String(body.text ?? '');
        if (!text || text.length > 10000) throw new Error('Вставляемый текст должен содержать от 1 до 10 000 символов.');
        await page.keyboard.insertText(text);
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/browser-snapshot?')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pageIndex = Number(url.searchParams.get('pageIndex'));
      if (!current().context || !current().context.pages()[pageIndex]) return send(res, 404, { error: 'Вкладка не подключена' });
      const page = current().context.pages()[pageIndex];
      const [image, title] = await Promise.all([page.screenshot({ type: 'jpeg', quality: 68, timeout: 10000 }), page.title().catch(() => '')]);
      return send(res, 200, { image: image.toString('base64'), title, url: page.url(), pages: await pagesState() });
    }
    if (req.method === 'POST' && req.url === '/api/open-plan') {
      const body = JSON.parse((await readBody(req, 20000)).toString('utf8'));
      const url = safePlanUrl(body.url);
      if (!current().context) throw new Error('Сначала подключи браузер');
      let page = current().context.pages()[Number(body.pageIndex)];
      if (!page || page.isClosed()) page = await current().context.newPage();
      else if(page.url()!=='about:blank'&&!/^https:\/\/core\.ag-media\.ru\/documents\/mediaplans\/\d+\/edit\/?(?:[?#]|$)/.test(page.url()))page=await current().context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return send(res, 200, { pages: await pagesState(), activePage: current().context.pages().indexOf(page) });
    }
    if (req.method === 'POST' && req.url === '/api/workbook') {
      const bytes = await readBody(req);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Нужен файл .xlsx');
      const fileName=decodeURIComponent(req.headers['x-file-name']||'plan.xlsx');
      if(!/\.xlsx$/i.test(fileName))throw new Error('Пока поддерживается только .xlsx');
      const tempTarget = path.join(state.userDir, `upload-${crypto.randomBytes(8).toString('hex')}.tmp`);
      let parsed;
      try {
        fs.writeFileSync(tempTarget, bytes, { mode: 0o600, flag: 'wx' });
        parsed = await runPython(tempTarget);
        if (parsed.error) throw new Error(parsed.error);
        fs.renameSync(tempTarget, current().workbookPath);
        try { fs.chmodSync(current().workbookPath, 0o600); } catch { /* Windows permissions use the account ACL. */ }
      } finally {
        if (fs.existsSync(tempTarget)) fs.unlinkSync(tempTarget);
      }
      current().workbook = parsed;
      current().workbookFileName = fileName;
      return send(res, 200, { fileName, sheets: current().workbook.sheets.map(s => ({ name: s.name, rows: s.rows.length })) });
    }
    if (req.method === 'POST' && req.url === '/api/feedback') {
      const contentType = String(req.headers['content-type'] || '');
      let body, files = [];
      if (/^multipart\/form-data\b/i.test(contentType)) {
        const parsed = parseMultipart(await readBody(req, 22 * 1024 * 1024), contentType);
        body = Object.fromEntries(parsed.fields);
        files = parsed.files;
      } else body = JSON.parse((await readBody(req, 12000)).toString('utf8'));
      const categories = new Set(['Ошибка', 'Идея', 'Вопрос', 'Другое']);
      const category = String(body.category || '').trim();
      const message = String(body.message || '').trim();
      const contact = String(body.contact || '').trim();
      if (!categories.has(category)) throw new Error('Выбери тему обратной связи.');
      if (message.length < 3 || message.length > 4000) throw new Error('Сообщение должно содержать от 3 до 4000 символов.');
      if (contact.length > 200) throw new Error('Контакт должен быть не длиннее 200 символов.');
      if (files.length > 5) throw new Error('Можно прикрепить не больше 5 файлов.');
      const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.txt', '.zip']);
      let totalBytes = 0;
      files = files.map(file => {
        const originalName = path.basename(String(file.filename || '').replaceAll('\\', '/').replace(/[\r\n\0]/g, '')).slice(0, 180);
        const extension = path.extname(originalName).toLowerCase();
        if (!originalName || !allowedExtensions.has(extension)) throw new Error(`Тип файла «${extension || originalName}» не поддерживается.`);
        if (!file.bytes.length || file.bytes.length > 10 * 1024 * 1024) throw new Error(`Файл «${originalName}» пустой или превышает 10 МБ.`);
        totalBytes += file.bytes.length;
        if (totalBytes > 20 * 1024 * 1024) throw new Error('Общий размер вложений не должен превышать 20 МБ.');
        return { ...file, filename: originalName, id: crypto.randomUUID() };
      });
      const item = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), username: state.username, category, message, contact: contact || null, attachments: files.map(file => ({ id: file.id, name: file.filename, size: file.bytes.length })) };
      const feedbackPath = path.join(dataDir, 'feedback.jsonl');
      const attachmentDir = path.join(dataDir, 'feedback-files', item.id);
      if (files.length) fs.mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
      try {
        for (const file of files) fs.writeFileSync(path.join(attachmentDir, file.id), file.bytes, { mode: 0o600, flag: 'wx' });
        fs.appendFileSync(feedbackPath, `${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(feedbackPath, 0o600); } catch { /* Windows permissions use the account ACL. */ }
      } catch (error) {
        fs.rmSync(attachmentDir, { recursive: true, force: true });
        throw error;
      }
      return send(res, 201, { ok: true, id: item.id, message: 'Спасибо, обратная связь сохранена.' });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/admin/feedback-file?')) {
      if (!current().adminUser || current().adminExpiresAt <= Date.now()) return send(res, 403, { error: 'Сначала войди в администраторскую панель.' });
      const url = new URL(req.url, 'http://127.0.0.1'), itemId = url.searchParams.get('item') || '', fileId = url.searchParams.get('file') || '';
      if (!/^[0-9a-f-]{36}$/i.test(itemId) || !/^[0-9a-f-]{36}$/i.test(fileId)) return send(res, 404, { error: 'Вложение не найдено.' });
      const feedbackPath = path.join(dataDir, 'feedback.jsonl');
      const item = fs.existsSync(feedbackPath) ? fs.readFileSync(feedbackPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(entry => entry.id === itemId) : null;
      const attachment = item?.attachments?.find(entry => entry.id === fileId);
      if (!attachment) return send(res, 404, { error: 'Вложение не найдено.' });
      const filePath = path.join(dataDir, 'feedback-files', itemId, fileId);
      if (!fs.existsSync(filePath)) return send(res, 404, { error: 'Файл вложения отсутствует.' });
      const bytes = fs.readFileSync(filePath), asciiName = attachment.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(bytes);
    }
    if (req.method === 'GET' && req.url === '/api/admin/feedback') {
      if (!current().adminUser || current().adminExpiresAt <= Date.now()) return send(res, 403, { error: 'Сначала войди в администраторскую панель.' });
      const feedbackPath = path.join(dataDir, 'feedback.jsonl');
      let items = [];
      if (fs.existsSync(feedbackPath)) {
        items = fs.readFileSync(feedbackPath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
          try {
            const item = JSON.parse(line);
            if (typeof item.id !== 'string' || typeof item.createdAt !== 'string' || typeof item.message !== 'string') return [];
            return [{ id: item.id, createdAt: item.createdAt, username: String(item.username || '—'), category: String(item.category || 'Другое'), message: item.message, contact: item.contact == null ? null : String(item.contact), attachments: Array.isArray(item.attachments) ? item.attachments.filter(file => file && /^[0-9a-f-]{36}$/i.test(file.id) && typeof file.name === 'string').map(file => ({ id: file.id, name: file.name, size: Number(file.size) || 0 })) : [] }];
          } catch { return []; }
        }).slice(-500).reverse();
      }
      return send(res, 200, { items, total: items.length });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/sheet?')) {
      if (!current().workbook) throw new Error('Сначала загрузи книгу Excel');
      const index=Number(new URL(req.url,'http://127.0.0.1').searchParams.get('index'));
      if (!Number.isInteger(index)||index<0||index>=current().workbook.sheets.length) throw new Error('Такого листа в книге нет');
      return send(res,200,current().workbook.sheets[index]);
    }
    if (req.method === 'POST' && req.url === '/api/capture') {
      const body = JSON.parse((await readBody(req, 20000)).toString('utf8'));
      const pageIndex=Number(body.pageIndex), page=current().context?.pages()[pageIndex];
      if(!page||!isReportPageUrl(page.url()))throw new Error('Открой ссылку на отчёт DataLens во встроенной вкладке. Для Core подойдёт страница /reports/client-reports/ID/view.');
      const preparation=[];
      if(body.period){
        const {start,end}=body.period;
        if(!/^01\.\d{2}\.20\d{2}$/.test(String(start))||!/^\d{2}\.\d{2}\.20\d{2}$/.test(String(end)))throw new Error('Период МП не удалось подтвердить как полный календарный месяц.');
        const [day,month,year]=String(start).split('.').map(Number),lastDay=new Date(Date.UTC(year,month,0)).getUTCDate();
        if(day!==1||String(end)!==`${String(lastDay).padStart(2,'0')}.${String(month).padStart(2,'0')}.${year}`)throw new Error('Период DataLens должен точно соответствовать одному календарному месяцу.');
        const reportFrames=page.frames().filter(frame=>/^https:\/\/(?:reports\.core\.ag-media\.ru|datalens\.(?:yandex|yandex\.ru|yandexcloud\.net))(\/|$)/.test(frame.url())||(frame===page.mainFrame()&&isReportPageUrl(frame.url())));
        const dateMatches=[];
        for(const frame of reportFrames){const inputs=frame.locator('input[placeholder*="ДД.ММ.ГГГГ"]');const count=await inputs.count();if(count)dateMatches.push({frame,inputs,count});}
        if(dateMatches.length!==1||dateMatches[0].count!==1)throw new Error('Фильтр даты не найден однозначно в отчёте DataLens. DataLens не менял; выставь период вручную.');
        const {frame:reportFrame,inputs:dateInputs}=dateMatches[0];
        const title=reportFrame.locator('.dash-fixed-header__controls .chartkit-control-item__title-text').filter({hasText:'Текущий месяц'});
        const titleCount=await title.count();
        if(titleCount>1)throw new Error(`Фильтр «Текущий месяц» найден ${titleCount} раз; дату не менял.`);
        if(titleCount===1){
          const control=title.locator('xpath=../..').locator('.yc-select-control');
          if(await control.count()!==1)throw new Error('Контрол «Текущий месяц» не найден однозначно; дату не менял.');
          {
            let value=(await title.locator('xpath=../..').innerText()).replace(/\s+/g,' ').trim();
            if(!/Нет выбранных значений/.test(value)){
              let option=page.locator('.g-popup_open .yc-select-item_selected');
              if(await option.count()===0){await control.click({timeout:5000});await page.waitForTimeout(150);option=page.locator('.g-popup_open .yc-select-item_selected');}
              if(await option.count()!==1)throw new Error('Не удалось однозначно снять фильтр «Текущий месяц»; дату не менял.');
              await option.click({timeout:5000});await page.waitForTimeout(500);
              value=(await title.locator('xpath=../..').innerText()).replace(/\s+/g,' ').trim();
              if(!/Нет выбранных значений/.test(value))throw new Error(`Фильтр «Текущий месяц» после очистки показывает «${value}».`);
              preparation.push('фильтр «Текущий месяц» снят');
            }
          }
        }
        const date=`${start} - ${end}`;
        if(await dateInputs.inputValue()!==date){await dateInputs.fill(date);await dateInputs.press('Enter');await page.keyboard.press('Escape').catch(()=>{});await page.waitForTimeout(900);}
        const confirmed=await dateInputs.inputValue();
        if(confirmed!==date)throw new Error(`DataLens не подтвердил период «${date}»; сейчас указано «${confirmed}».`);
        preparation.push(`период ${date}`);
      }
      const candidates = (await tableCandidates()).filter(c=>c.pageIndex===pageIndex);
      if (!candidates.length) throw new Error('Не нашёл таблицы. Перейди в отчёт DataLens, выставь нужные фильтры и нажми «Снять таблицу» ещё раз.');
      const ranked=rankFactTables(candidates,Array.isArray(body.expectedObjects)?body.expectedObjects:[]);
      const selected=ranked.candidates.find(candidate=>candidate.id===ranked.recommendedId)||null;
      current().activeReport=selected;
      return send(res, 200, { candidates: ranked.candidates.map(c => ({ ...c, truncated: c.rows.length>=3000, rows: c.rows.slice(0, 3000) })), selectedId: selected?.id||null, selectionReason:ranked.reason, preparation });
    }
    if (req.method === 'POST' && req.url === '/api/read-plan') {
      const body = JSON.parse((await readBody(req, 20000)).toString('utf8'));
      return send(res, 200, await readCoreTable(Number(body.pageIndex)));
    }
    if (req.method === 'POST' && req.url === '/api/inspect-page') {
      const body = JSON.parse((await readBody(req, 10000)).toString('utf8'));
      if (!current().context || !current().context.pages()[Number(body.pageIndex)]) throw new Error('Вкладка не подключена');
      const page = current().context.pages()[Number(body.pageIndex)];
      const snapshot = await page.evaluate(() => {
        const visible = el => { const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'; };
        const targetNodes=[...document.querySelectorAll('body *')].filter(el=>visible(el)&&/^Фактический медиаплан(?:\s+27)?$/.test((el.innerText||el.textContent||'').replace(/\s+/g,' ').trim())).slice(0,8).map(el=>({tag:el.tagName,className:String(el.className||'').slice(0,180),role:el.getAttribute('role')||'',tabindex:el.getAttribute('tabindex')||'',onclick:!!el.onclick,text:(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim(),parent:el.parentElement?{tag:el.parentElement.tagName,className:String(el.parentElement.className||'').slice(0,180),role:el.parentElement.getAttribute('role')||'',tabindex:el.parentElement.getAttribute('tabindex')||'',onclick:!!el.parentElement.onclick}:null}));
        return {
          text: (document.body?.innerText||'').slice(0,10000),
          controls: [...document.querySelectorAll('button,[role="tab"],[role="button"],a,input,select,[role="combobox"]')].filter(visible).map(el=>({tag:el.tagName,role:el.getAttribute('role')||'',text:(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,160),value:el.value||'',href:el.href||'',aria:el.getAttribute('aria-label')||''})).slice(0,180),
          targetNodes
        };
      });
      return send(res, 200, {url:page.url(),title:await page.title().catch(()=>''),...snapshot});
    }
    if (req.method === 'POST' && req.url === '/api/select-view') {
      const body = JSON.parse((await readBody(req, 10000)).toString('utf8'));
      if (!current().context || !current().context.pages()[Number(body.pageIndex)]) throw new Error('Вкладка не подключена');
      if (!['fact','plan'].includes(body.view)) throw new Error('Доступны только представления fact и plan');
      const page=current().context.pages()[Number(body.pageIndex)], label=body.view==='fact'?'Фактический медиаплан':'Прогнозный медиаплан';
      const selector=await page.evaluate(label=>{
        const norm=el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
        const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
        const candidates=[...document.querySelectorAll('body *')].filter(el=>visible(el)&&norm(el).startsWith(label)&&norm(el).length<100);
        if(!candidates.length)return null;
        candidates.sort((a,b)=>norm(a).length-norm(b).length);
        let el=candidates[0];
        while(el&&el!==document.body){const s=getComputedStyle(el);if(el.matches('button,[role="tab"],[role="button"],a')||el.tabIndex>=0||el.onclick||s.cursor==='pointer')break;el=el.parentElement;}
        if(!el||el===document.body)return null;
        const parts=[];while(el&&el!==document.body){let part=el.tagName.toLowerCase();if(el.id){part+='#'+CSS.escape(el.id);parts.unshift(part);break;}if(el.classList.length)part+='.'+[...el.classList].slice(0,2).map(CSS.escape).join('.');const siblings=[...el.parentElement.children].filter(x=>x.tagName===el.tagName);if(siblings.length>1)part+=`:nth-of-type(${siblings.indexOf(el)+1})`;parts.unshift(part);el=el.parentElement;}return parts.join(' > ');
      },label);
      if(!selector) throw new Error('Не удалось однозначно определить переключатель представления; оставил страницу без изменений.');
      await page.locator(selector).click({timeout:5000});
      await page.waitForTimeout(500);
      return send(res,200,{ok:true,view:body.view,label,url:page.url()});
    }
    if (req.method === 'POST' && req.url === '/api/inspect-text') {
      const body=JSON.parse((await readBody(req,10000)).toString('utf8'));
      if(!current().context||!current().context.pages()[Number(body.pageIndex)])throw new Error('Вкладка не подключена');
      const page=current().context.pages()[Number(body.pageIndex)];
      const result=await page.evaluate(labels=>{
        const norm=el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
        const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';};
        return (Array.isArray(labels)?labels:[]).map(label=>({
          label,
          matches:[...document.querySelectorAll('body *')].filter(el=>visible(el)&&norm(el)===label).slice(0,6).map(el=>{
            let p=el;const chain=[];
            for(let i=0;i<4&&p&&p!==document.body;i++,p=p.parentElement){
              const s=getComputedStyle(p);
              chain.push({tag:p.tagName,className:String(p.className||'').slice(0,120),role:p.getAttribute('role')||'',aria:p.getAttribute('aria-label')||'',title:p.getAttribute('title')||'',value:p.value||'',tabindex:p.tabIndex,cursor:s.cursor,text:norm(p).slice(0,240)});
            }
            return chain;
          })
        }));
      },Array.isArray(body.labels)?body.labels:[]);
      return send(res,200,{url:page.url(),results:result});
    }
    if (req.method === 'POST' && req.url === '/api/open-filter') {
      const body=JSON.parse((await readBody(req,10000)).toString('utf8'));
      if(!current().context||!current().context.pages()[Number(body.pageIndex)])throw new Error('Вкладка не подключена');
      if(!['Текущий месяц','Медиаплан','Объект продвижения'].includes(body.label))throw new Error('Этот фильтр не разрешён для выбора');
      const page=current().context.pages()[Number(body.pageIndex)];
      const title=page.locator('.dash-fixed-header__controls .chartkit-control-item__title-text').filter({hasText:body.label});
      const count=await title.count();
      if(count!==1)throw new Error(`В верхней панели нашёл элементов «${body.label}»: ${count}; фильтр не открывал.`);
      const select=title.locator('xpath=../..').locator('.yc-select-control');
      const selectCount=await select.count();
      if(selectCount!==1)throw new Error(`Неоднозначный контрол «${body.label}»: ${selectCount}; фильтр не открывал.`);
      await page.keyboard.press('Escape').catch(()=>{});
      await select.click({timeout:5000});
      await page.waitForTimeout(200);
      const snapshot=await page.evaluate(()=>({text:(document.body?.innerText||'').slice(0,7000),options:[...document.querySelectorAll('[role="option"],[role="listbox"],.yc-select-option,.yc-select-control__popup')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0}).map(el=>(el.innerText||el.textContent||'').trim()).slice(0,80)}));
      return send(res,200,{ok:true,label:body.label,...snapshot});
    }
    if (req.method === 'POST' && req.url === '/api/clear-current-month') {
      const body=JSON.parse((await readBody(req,10000)).toString('utf8'));
      if(!current().context||!current().context.pages()[Number(body.pageIndex)])throw new Error('Вкладка не подключена');
      const page=current().context.pages()[Number(body.pageIndex)];
      if(!isReportPageUrl(page.url()))throw new Error('Это не вкладка отчёта DataLens');
      await page.keyboard.press('Escape').catch(()=>{});
      const title=page.locator('.dash-fixed-header__controls .chartkit-control-item__title-text').filter({hasText:'Текущий месяц'});
      if(await title.count()!==1)throw new Error('Фильтр «Текущий месяц» не найден однозначно; ничего не менял.');
      const control=title.locator('xpath=../..').locator('.yc-select-control');
      if(await control.count()!==1)throw new Error('Контрол «Текущий месяц» не найден однозначно; ничего не менял.');
      const current=(await title.locator('xpath=../..').innerText()).replace(/\s+/g,' ').trim();
      if(!/Текущий месяц да(?:\s|$)/.test(current))return send(res,200,{ok:true,changed:false,current});
      let option=page.locator('.g-popup_open .yc-select-item_selected');
      if(await option.count()===0){await control.click({timeout:5000});await page.waitForTimeout(200);option=page.locator('.g-popup_open .yc-select-item_selected');}
      if(await option.count()!==1)throw new Error('Выбранная опция фильтра не найдена однозначно; оставил фильтр без изменений.');
      if((await option.innerText()).trim()!=='да')throw new Error('Выбрана не опция «да»; фильтр не менял.');
      await option.click({timeout:5000});
      await page.waitForTimeout(700);
      const after=(await title.locator('xpath=../..').innerText()).replace(/\s+/g,' ').trim();
      if(!/Нет выбранных значений/.test(after))throw new Error(`После очистки фильтр показывает «${after}». Проверь его вручную.`);
      return send(res,200,{ok:true,changed:true,before:current,after});
    }
    if (req.method === 'POST' && req.url === '/api/set-report-period') {
      const body=JSON.parse((await readBody(req,10000)).toString('utf8'));
      if(!current().context||!current().context.pages()[Number(body.pageIndex)])throw new Error('Вкладка не подключена');
      const page=current().context.pages()[Number(body.pageIndex)];
      if(!isReportPageUrl(page.url()))throw new Error('Это не вкладка отчёта DataLens');
      if(body.start!=='01.09.2026'||body.end!=='30.09.2026')throw new Error('Для этой проверки разрешён только подтверждённый период 01.09.2026–30.09.2026.');
      const input=page.locator('input[placeholder*="ДД.ММ.ГГГГ"]');
      if(await input.count()!==1)throw new Error('Поле периода не найдено однозначно; дату не менял.');
      await input.fill(`${body.start} - ${body.end}`);
      await input.press('Enter');
      await page.keyboard.press('Escape').catch(()=>{});
      await page.waitForTimeout(1200);
      const value=await input.inputValue();
      if(value!==`${body.start} - ${body.end}`)throw new Error(`Поле периода вернуло «${value}». Проверь фильтр.`);
      return send(res,200,{ok:true,date:value,url:page.url()});
    }
    if (req.method === 'POST' && req.url === '/api/goto-report-tab') {
      const body=JSON.parse((await readBody(req,10000)).toString('utf8'));
      if(!current().context||!current().context.pages()[Number(body.pageIndex)])throw new Error('Вкладка не подключена');
      const page=current().context.pages()[Number(body.pageIndex)], ids={sources:'6a',direct:'D1M',promo:'D80'};
      if(!ids[body.tab]||!isReportPageUrl(page.url()))throw new Error('Недопустимая вкладка отчёта');
      const url=new URL(page.url());
      if(!await page.locator('a[href*="tab='+ids[body.tab]+'"]').count())throw new Error('Ссылка отчёта не найдена; вкладку не менял.');
      url.searchParams.set('tab',ids[body.tab]);
      await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:15000});
      await page.waitForTimeout(900);
      return send(res,200,{ok:true,tab:body.tab,url:page.url(),title:await page.title().catch(()=>'' )});
    }
    if (req.method === 'POST' && req.url === '/api/open-report-tab') {
      const body=JSON.parse((await readBody(req,10000)).toString('utf8'));
      if(!current().context||!current().context.pages()[Number(body.pageIndex)])throw new Error('Вкладка не подключена');
      const page=current().context.pages()[Number(body.pageIndex)];
      const tabs={sources:'Все источники',direct:'Яндекс Директ',promo:'Промостраницы'};
      if(!tabs[body.tab]||!isReportPageUrl(page.url()))throw new Error('Недопустимая вкладка отчёта');
      const link=page.locator('a').filter({hasText:tabs[body.tab]});
      const links=await link.count();
      if(!links)throw new Error(`Ссылка «${tabs[body.tab]}» не найдена; вкладку отчёта не менял.`);
      await link.first().click({timeout:5000});
      await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});
      await page.waitForTimeout(900);
      return send(res,200,{ok:true,tab:tabs[body.tab],url:page.url(),title:await page.title().catch(()=>'' )});
    }
    if (req.method === 'POST' && req.url === '/api/use-report-table') {
      const body = JSON.parse((await readBody(req, 10000)).toString('utf8'));
      const candidates = await tableCandidates();
      current().activeReport = candidates.find(c => c.id === body.id) || null;
      if (!current().activeReport) throw new Error('Эта таблица уже изменилась или исчезла. Сними её заново.');
      return send(res, 200, { ok: true, rows: current().activeReport.rows.length, frameUrl: current().activeReport.frameUrl });
    }
    if (req.method === 'POST' && req.url === '/api/prepare-apply') {
      const body = JSON.parse((await readBody(req, 2_000_000)).toString('utf8'));
      if (!['plan','fact'].includes(body.mode)) throw new Error('Не указан допустимый режим переноса.');
      const amountTolerance = body.amountTolerance == null ? 10 : Number(body.amountTolerance);
      if (!Number.isInteger(amountTolerance) || amountTolerance < 1 || amountTolerance > 10) throw new Error('Допуск по сумме должен быть целым числом от 1 до 10 ₽.');
      const allowPartial = body.allowPartial === true;
      if (!Array.isArray(body.issues) || (body.issues.length && !allowPartial)) throw new Error('Предпросмотр содержит нерешённые расхождения. Исправь их или используй частичный перенос для проверенных полей.');
      if (allowPartial && body.mode !== 'plan' && body.mode !== 'fact') throw new Error('Частичный перенос недоступен для этого источника.');
      const pageIndex = Number(body.pageIndex), data = await readCoreTable(pageIndex);
      if (!body.planUrl || body.planUrl !== data.url) throw new Error('Открытый медиаплан изменился после предпросмотра. Перечитай таблицу и подготовь перенос заново.');
      let sourceFingerprint = null, sourceRows = null, sourceHeaders = null;
      if (body.mode === 'fact') {
        if (!current().activeReport || body.sourceId !== current().activeReport.id) throw new Error('Выбранная таблица DataLens не подтверждена сервером. Выбери её заново и подготовь перенос повторно.');
        const reportHost = new URL(current().activeReport.frameUrl).hostname;
        if (reportHost !== 'reports.core.ag-media.ru' && !/^datalens\.(?:yandex|yandex\.ru|yandexcloud\.net)$/.test(reportHost)) throw new Error('Для переноса факта выбери таблицу DataLens, а не таблицу Core.');
        const freshReport = (await tableCandidates()).find(candidate => candidate.id === current().activeReport.id);
        if (!freshReport || fingerprint(freshReport.rows) !== fingerprint(current().activeReport.rows)) throw new Error('Таблица DataLens изменилась. Сними её заново и перепроверь фильтры.');
        if (allowPartial && freshReport.truncated) throw new Error('Частичный перенос заблокирован: DataLens достиг лимита 3000 строк, источник неполный. Сузь фильтр отчёта.');
        sourceFingerprint = fingerprint(freshReport.rows);
        sourceRows = freshReport.rows;
        sourceHeaders = freshReport.rows[0] || [];
        const reportHeaders = sourceHeaders;
        for (const change of (Array.isArray(body.changes) ? body.changes : [])) {
          const rowKey = String(change.sourceRowKey || '').trim();
          const sourceHeader = String(change.sourceHeader || '').trim();
          const sourceNameHeader = String(change.sourceNameHeader || '').trim();
          const sourceColumnIndexes = reportHeaders.map((header, index) => String(header || '').trim() === sourceHeader ? index : -1).filter(index => index >= 0);
          const sourceNameIndexes = reportHeaders.map((header, index) => String(header || '').trim() === sourceNameHeader ? index : -1).filter(index => index >= 0);
          if (!rowKey || sourceColumnIndexes.length !== 1 || sourceNameIndexes.length !== 1) throw new Error('Для одной из ячеек не подтверждена исходная строка или колонка DataLens.');
          const sourceRows = freshReport.rows.slice(1).filter(row => String(row[sourceNameIndexes[0]] || '').trim() === rowKey);
          if (sourceRows.length !== 1 || String(sourceRows[0][sourceColumnIndexes[0]] ?? '').trim() !== String(change.sourceValue ?? '').trim()) throw new Error(`Источник DataLens для строки «${rowKey}» изменился. Сними отчёт заново.`);
        }
      }
      const changes = Array.isArray(body.changes) ? body.changes : [];
      if (!changes.length || changes.length > 2500) throw new Error('В предварительном списке нет изменений или их слишком много');
      const tableRows = data.table.rows, tableHeaders = tableRows[0] || [], nameCol=Number(body.nameCol);
      if (!Number.isInteger(nameCol) || nameCol<0 || nameCol>=tableHeaders.length) throw new Error('Колонка названия строки не подтверждена. Перечитай медиаплан.');
      const normalizedNameHeader=String(tableHeaders[nameCol]||'').toLowerCase().replace(/ё/g,'е').trim();
      if (!/^(?:описание|название|наименование|кампания|объект продвижения|объект рекламирования|utm source|площадка)(?:\s|$)/.test(normalizedNameHeader)) throw new Error('Выбрана неподходящая колонка для названия строки.');
      const placementCol=body.mode==='plan'?uniqueHeaderIndex(tableHeaders,'Площадка'):-1;
      if(body.mode==='plan'&&placementCol<0)throw new Error('В МП не найдена единственная колонка «Площадка» для проверки группы размещения.');
      const changeKeys=new Set();
      const safeChanges = changes.map(c => {
        const rowIndex=Number(c.rowIndex), colIndex=Number(c.colIndex);
        if (!Number.isInteger(rowIndex)||rowIndex<1||rowIndex>=tableRows.length||!Number.isInteger(colIndex)||colIndex<0||colIndex>=tableHeaders.length) throw new Error('В изменениях есть ячейка вне таблицы');
        const changeKey=`${rowIndex}:${colIndex}`;
        if(changeKeys.has(changeKey))throw new Error('Одна целевая ячейка включена в перенос несколько раз. Подготовь предпросмотр заново.');
        changeKeys.add(changeKey);
        const header=String(tableHeaders[colIndex]||'').trim();
        const normalizedHeader=header.toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}%]+/gu,' ').trim();
        const allowedMetric=/^(?:бюджет|расход|стоимость|показы?|клики?|лиды|все лиды|целевые лиды|цо|cpl|cpa|cpc|cpm|ctr|cr[123]%?)(?:\s.*)?$/i.test(normalizedHeader);
        if (!allowedMetric || isManualEntryHeader(header)) throw new Error(`Изменение запрещено для столбца «${header}»`);
        const rowKey=String(c.rowKey||'').trim(), currentKey=String(tableRows[rowIndex][Number(body.nameCol)]||'').trim();
        if (!rowKey||rowKey!==currentKey) throw new Error(`Строка ${rowIndex+1} не подтверждена по названию`);
        if (/ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(rowKey)) throw new Error('AdRiver и Botfaqtor исключены из изменений');
        const oldValue=String(tableRows[rowIndex][colIndex]||'').trim();
        if (oldValue !== String(c.oldValue ?? '').trim()) throw new Error(`Ячейка «${rowKey} · ${header}» изменилась после чтения МП. Перечитай таблицу и подготовь перенос заново.`);
        const value=String(c.value??'');
        if (value.length>80 || /[<>]/.test(value)) throw new Error('В значении обнаружен неподдерживаемый текст');
        if (parseDisplayNumber(value) === null) throw new Error(`В столбце «${header}» значение должно быть числом`);
        return {rowIndex,colIndex,rowKey,nameCol:Number(body.nameCol),header,oldValue,value};
      });
      const checks = Array.isArray(body.checks) ? body.checks : [];
      if (!checks.length || checks.length > 12000) throw new Error('Не собран полный список построчной сверки; запись заблокирована.');
      let sourceHeaderRowIndex=0;
      if (body.mode === 'plan') {
        const sheetIndex=Number(body.sourceSheetIndex);
        if(!current().workbook||!Number.isInteger(sheetIndex)||sheetIndex<0||sheetIndex>=current().workbook.sheets.length)throw new Error('Исходный лист Excel не подтверждён сервером. Выбери лист заново.');
        const sheetRows=current().workbook.sheets[sheetIndex].rows;
        sourceHeaderRowIndex=Number(body.sourceHeaderRowIndex);
        if(!Number.isInteger(sourceHeaderRowIndex)||sourceHeaderRowIndex<0||sourceHeaderRowIndex>=sheetRows.length)throw new Error('Строка заголовков Excel не подтверждена сервером.');
        sourceRows=sheetRows.map(row=>row.values);
        sourceHeaders=sourceRows[sourceHeaderRowIndex]||null;
        if(!sourceHeaders)throw new Error('Заголовки листа Excel не подтверждены. Перечитай лист и подготовь перенос повторно.');
      }
      const checkKeys=new Set();
      const safeChecks = checks.map(c => {
        const rowIndex=Number(c.rowIndex), colIndex=Number(c.colIndex), rowKey=String(c.rowKey||'').trim();
        if(!Number.isInteger(rowIndex)||rowIndex<1||rowIndex>=tableRows.length||!Number.isInteger(colIndex)||colIndex<0||colIndex>=tableHeaders.length)throw new Error('Построчная сверка содержит ячейку вне таблицы.');
        const header=String(tableHeaders[colIndex]||'').trim(), normalizedHeader=header.toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}%]+/gu,' ').trim();
        if(!/^(?:бюджет|расход|стоимость|показы?|клики?|лиды|все лиды|целевые лиды|цо|cpl|cpa|cpc|cpm|ctr|cr[123]%?)(?:\s.*)?$/i.test(normalizedHeader)||isManualEntryHeader(header))throw new Error(`Нельзя включить «${header}» в построчную сверку.`);
        if(!rowKey||String(tableRows[rowIndex][nameCol]||'').trim()!==rowKey)throw new Error(`Строка ${rowIndex+1} сверки не подтверждена по названию.`);
        if(/ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(rowKey))throw new Error('AdRiver и Botfaqtor исключены из сверки.');
        const value=String(c.value??'');if(parseDisplayNumber(value)===null)throw new Error(`Ожидаемое значение «${header}» не числовое.`);
        const checkKey=`${rowIndex}:${colIndex}`;
        if(checkKeys.has(checkKey))throw new Error(`Построчная сверка повторяет ячейку «${rowKey} · ${header}».`);
        checkKeys.add(checkKey);
        const sourceRowIndex=Number(c.sourceRowIndex),sourceColIndex=Number(c.sourceColIndex),sourceNameCol=Number(c.sourceNameCol);
        if(!Number.isInteger(sourceRowIndex)||sourceRowIndex<0||sourceRowIndex>=sourceRows.length||!Number.isInteger(sourceColIndex)||sourceColIndex<0||sourceColIndex>=sourceHeaders.length||!Number.isInteger(sourceNameCol)||sourceNameCol<0||sourceNameCol>=sourceHeaders.length)throw new Error(`Источник сверки «${rowKey} · ${header}» не указывает на допустимую ячейку.`);
        if(String(sourceHeaders[sourceColIndex]||'').trim()!==String(c.sourceHeader||'').trim()||String(sourceHeaders[sourceNameCol]||'').trim()!==String(c.sourceNameHeader||'').trim())throw new Error(`Заголовки источника для «${rowKey} · ${header}» изменились.`);
        const sourceRow=sourceRows[sourceRowIndex]||[];
        if(String(sourceRow[sourceNameCol]||'').trim()!==String(c.sourceRowKey||'').trim()||String(sourceRow[sourceColIndex]??'').trim()!==String(c.sourceValue??'').trim())throw new Error(`Исходная ячейка для «${rowKey} · ${header}» изменилась или указана неверно.`);
        const sourceNameKey=String(c.sourceRowKey||'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ').replace(/^лср\s+/,'').replace(/\bлейк\b/g,'lake');
        const targetNameKey=rowKey.toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ').replace(/^лср\s+/,'').replace(/\bлейк\b/g,'lake');
        if(!sourceNameKey||sourceNameKey!==targetNameKey)throw new Error(`Строка источника «${c.sourceRowKey}» не соответствует строке МП «${rowKey}».`);
        const sourceRaw=String(c.sourceValue??'');let expectedValue=parseDisplayNumber(sourceRaw);
        if(expectedValue===null)throw new Error(`Значение источника для «${rowKey} · ${header}» не числовое.`);
        if(body.mode==='fact'&&/(?:cr[123]|ctr)/i.test(normalizedHeader)){
          if(sourceRaw.includes('%'))expectedValue/=100;
          else if(String(c.sourceHeader||'').includes('%'))throw new Error(`Единицы процента для источника «${c.sourceHeader}» неоднозначны.`);
        }
        if(/показ/i.test(normalizedHeader)&&(body.mode==='plan'||body.impressionsInThousands===true))expectedValue/=1000;
        if(body.mode==='plan'&&/клик/i.test(normalizedHeader))expectedValue=Math.round(expectedValue);
        if(!sameCellValue(value,String(Number(expectedValue.toFixed(6))),header))throw new Error(`Ожидаемое значение для «${rowKey} · ${header}» не соответствует подтверждённой ячейке источника.`);
        if(body.mode==='plan'){
          const sourceGroup=excelPlacementGroup(sourceHeaders,sourceRow),targetContext=corePlacementContext(tableRows,rowIndex,nameCol,placementCol);
          if(!sourceGroup||sourceGroup!==targetContext.groupKey)throw new Error(`Строка Excel «${c.sourceRowKey}» находится в другой или неопределённой группе размещения для «${rowKey}».`);
          if(!targetContext.model)throw new Error(`Модель расчёта строки МП «${rowKey}» не подтверждена по группе.`);
          const metric=planMetric(header),eligible=eligiblePlanMetrics(targetContext.model);
          const derivedBudgetCheck=metric==='budget'&&!['FIX','STATIC'].includes(targetContext.model);
          if(!eligible.includes(metric)&&!derivedBudgetCheck)throw new Error(`Поле «${header}» не переносится для модели ${targetContext.model} в строке «${rowKey}».`);
          if((targetContext.groupKey.startsWith('classifieds|')||/avito|domclick|домклик|cian|циан|realty|недвижим|классиф/i.test(rowKey))&&!['cpl','allLeads','targetLeads'].includes(metric))throw new Error(`Для классифайда «${rowKey}» разрешены только CPL и количество лидов.`);
        }
        return {rowIndex,colIndex,rowKey,nameCol,header,value};
      });
      const expectedChecks=expectedCheckKeys({mode:body.mode,sourceRows,sourceHeaders,headerRowIndex:sourceHeaderRowIndex,targetRows:tableRows,nameCol,placementCol,parseDisplayNumber,allowPartial});
      const providedChecks=new Set(safeChecks.map(check=>`${check.rowIndex}:${check.colIndex}`));
      assertCompleteCheckCoverage(expectedChecks,providedChecks);
      for (const change of safeChanges) {
        const check=safeChecks.find(c=>c.rowIndex===change.rowIndex&&c.colIndex===change.colIndex);
        if(!check||check.rowKey!==change.rowKey||!sameCellValue(check.value,change.value,change.header))throw new Error(`Для изменения «${change.rowKey} · ${change.header}» нет совпадающей построчной проверки.`);
      }
      const id=crypto.randomBytes(18).toString('hex');
      const item={id,pageIndex,tableIndex:data.table.index,planUrl:data.url,mode:body.mode,changes:safeChanges,checks:safeChecks,amountTolerance,sourceId:body.mode==='fact'?body.sourceId:null,sourceFingerprint,createdAt:Date.now()};
      current().proposals.set(id,item);
      setTimeout(()=>current().proposals.delete(id),10*60*1000).unref();
      return send(res,200,{id,planUrl:data.url,changes:safeChanges,expiresInSeconds:600});
    }
    if (req.method === 'POST' && req.url === '/api/apply') {
      const body=JSON.parse((await readBody(req,20000)).toString('utf8'));
      const item=current().proposals.get(body.id);
      if (!item) throw new Error('Предпросмотр устарел. Сними таблицу МП и создай его заново.');
      if (item.staged) throw new Error('Этот предпросмотр уже внесён в форму Core. Проверь значения и подтверди отдельное сохранение.');
      if (item.sourceFingerprint) {
        const currentSource = (await tableCandidates()).find(candidate => candidate.id === item.sourceId);
        if (!currentSource || fingerprint(currentSource.rows) !== item.sourceFingerprint) throw new Error('DataLens изменился после предпросмотра. Ничего не внес; сними отчёт заново.');
      }
      if (current().context.pages()[item.pageIndex]?.url()!==item.planUrl) throw new Error('Вкладка Core изменилась после предпросмотра. Остановил заполнение.');
      const beforeApply=await readCoreTable(item.pageIndex);
      const fresh=beforeApply.table.rows;
      for (const c of item.changes) {
        if (String(fresh[c.rowIndex]?.[c.nameCol]||'').trim()!==c.rowKey || String(fresh[c.rowIndex]?.[c.colIndex]||'').trim()!==c.oldValue) throw new Error(`Значение в строке «${c.rowKey}» изменилось после предпросмотра. Ничего не внес; обнови данные.`);
      }
      const page=current().context.pages()[item.pageIndex], outcomes=[];
      for (const c of item.changes) {
        try {
          const table=page.locator('table').nth(item.tableIndex);
          const row=table.locator(':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr').nth(c.rowIndex);
          const cells=row.locator(':scope > th, :scope > td');
          const cellMap=beforeApply.table.cellMaps?.[c.rowIndex]?.[c.colIndex];
          if(!cellMap?.editable||cellMap.rowIndex!==c.rowIndex)throw new Error(`Целевая ячейка «${c.rowKey} · ${c.header}» объединена или не сопоставлена однозначно; запись остановлена.`);
          const cell=cells.nth(cellMap.physicalCellIndex);
          await cell.scrollIntoViewIfNeeded();
          const clickTarget=cell.locator('p,[tabindex]').first();
          if (await clickTarget.count()) await clickTarget.click({timeout:3000}).catch(()=>cell.click({timeout:3000})); else await cell.click({timeout:3000});
          const input=cell.locator('input,textarea').first();
          await input.waitFor({state:'visible',timeout:3500});
          await input.fill(c.value);
          await input.press('Enter').catch(()=>{});
          await page.waitForTimeout(250);
          const after=(await cell.innerText().catch(()=>'' )).trim();
          outcomes.push({row:c.rowKey,column:c.header,value:c.value,after,ok:sameCellValue(after,c.value,c.header)});
        } catch(err) { outcomes.push({row:c.rowKey,column:c.header,ok:false,reason:err?.message||'не удалось открыть/записать ячейку'}); }
        if (!outcomes.at(-1).ok) break;
      }
      const succeeded=outcomes.filter(x=>x.ok).length;
      let staged=false, verification=null, stageNote='';
      if(succeeded===item.changes.length){
        const stagedTable=await readCoreTable(item.pageIndex);
        const remaining=item.changes.filter(c=>!sameCellValue(stagedTable.table.rows[c.rowIndex]?.[c.colIndex],c.value,c.header));
        if(remaining.length)stageNote=`В форме Core не подтвердились ${remaining.length} значений; сохранять нельзя.`;
        else{
          verification=verifyCoreChecks(item.checks,stagedTable.table.rows,{sameCellValue,parseDisplayNumber,amountTolerance:item.mode==='plan'?0.01:item.amountTolerance});
          staged=verification.ok===true;
          if(!staged)stageNote=`Черновые значения не прошли сверку: ${verification.verifiedChecks}/${verification.totalChecks} ячеек, агрегаты ${verification.totalsVerified?'сошлись':'не сошлись'}. Сохранение заблокировано.`;
        }
      }
      item.staged=staged;
      item.stageOutcomes=outcomes;
      return send(res,200,{ok:staged,staged,saved:false,outcomes,succeeded,total:item.changes.length,...(verification||{}),message:staged?'Поля внесены в форму Core как черновик. Ничего не сохранено; проверь изменения и отдельно подтверди сохранение.':stageNote||'Не удалось заполнить и проверить все поля. Ничего не сохранено.'});
    }
    if (req.method === 'POST' && req.url === '/api/save') {
      const body=JSON.parse((await readBody(req,20000)).toString('utf8'));
      if(body.approved!==true)throw new Error('Сохранение запрещено до отдельного подтверждения пользователя.');
      const item=current().proposals.get(body.id);
      if(!item||!item.staged)throw new Error('Нет проверенного черновика для сохранения. Сначала внеси значения без сохранения.');
      if(item.sourceFingerprint){
        const currentSource=(await tableCandidates()).find(candidate=>candidate.id===item.sourceId);
        if(!currentSource||fingerprint(currentSource.rows)!==item.sourceFingerprint)throw new Error('DataLens изменился после заполнения черновика. Не сохранил; сними отчёт заново.');
      }
      if(current().context.pages()[item.pageIndex]?.url()!==item.planUrl)throw new Error('Вкладка Core изменилась после заполнения черновика. Не сохранил.');
      const page=current().context.pages()[item.pageIndex];
      const stagedTable=await readCoreTable(item.pageIndex);
      const changedByUser=item.changes.filter(c=>String(stagedTable.table.rows[c.rowIndex]?.[c.nameCol]||'').trim()!==c.rowKey||!sameCellValue(stagedTable.table.rows[c.rowIndex]?.[c.colIndex],c.value,c.header));
      if(changedByUser.length)throw new Error(`Черновик изменился после проверки (${changedByUser.length} ячеек). Не сохранил; перечитай МП и подготовь изменения заново.`);
      const saveButtons=page.locator('button').filter({hasText:/^\s*Сохранить(?: изменения| медиаплан)?\s*$/i});
      if(await saveButtons.count()!==1)throw new Error('Не нашёл ровно одну кнопку «Сохранить». Ничего не сохранил; проверь страницу вручную.');
      await saveButtons.click({timeout:5000});
      await page.waitForLoadState('networkidle',{timeout:6000}).catch(()=>{});
      await page.waitForTimeout(500);
      await page.reload({waitUntil:'domcontentloaded',timeout:15000});
      await page.waitForTimeout(700);
      const afterSave=await readCoreTable(item.pageIndex);
      const remaining=item.changes.filter(c=>!sameCellValue(afterSave.table.rows[c.rowIndex]?.[c.colIndex],c.value,c.header));
      let verification=null,saveNote='';
      const saved=remaining.length===0;
      if(!saved)saveNote=`После нажатия «Сохранить» ${remaining.length} значений не подтвердились при повторном чтении.`;
      else{
        verification=verifyCoreChecks(item.checks,afterSave.table.rows,{sameCellValue,parseDisplayNumber,amountTolerance:item.mode==='plan'?0.01:item.amountTolerance});
        if(!verification.ok)saveNote=`После сохранения есть расхождения: ячейки ${verification.verifiedChecks}/${verification.totalChecks}, агрегаты ${verification.totalsVerified?'сошлись':'не сошлись'}.`;
      }
      current().proposals.delete(item.id);
      const ok=saved&&verification?.ok===true;
      return send(res,200,{ok,staged:true,saved,outcomes:item.stageOutcomes||[],succeeded:item.changes.length,total:item.changes.length,saveNote,...(verification||{}),message:ok?'Изменения сохранены. Все строки и контрольные суммы повторно сверены с источником.':saveNote||'Сохранение выполнено, но полная сверка не прошла.'});
    }
    return send(res, 404, { error: 'Неизвестный запрос' });
  } catch (err) {
    return send(res, 400, { error: err?.message || String(err) });
  }
  });
});

async function closeSession(state) {
  const context = state.context;
  if (!context) return;
  state.context = null;
  state.activeReport = null;
  state.proposals.clear();
  const closed = await Promise.race([
    context.close().then(() => true, () => true),
    new Promise(resolve => setTimeout(() => resolve(false), 8000))
  ]);
  if (!closed) {
    const browser = context.browser?.();
    const browserClose = browser ? browser.close().then(() => true, () => false) : Promise.resolve(false);
    const browserClosed = await Promise.race([browserClose, new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!browserClosed) await forceKillChromium(state.profileDir);
  }
}

async function clearSessionWorkspace(state) {
  if (state.loading) await state.loading.catch(() => {});
  await closeSession(state);
  state.workbook = null;
  state.workbookFileName = null;
  state.activeReport = null;
  state.proposals.clear();
  for (const target of [state.profileDir, state.workbookPath]) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* A later fresh session still receives a new isolated path. */ }
  }
  try {
    for (const name of fs.readdirSync(state.userDir)) if (/^upload-[0-9a-f]+\.tmp$/i.test(name)) fs.rmSync(path.join(state.userDir, name), { force: true });
  } catch { /* The session directory may already be gone. */ }
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const state of sessions.values()) {
    if (state.context && now - state.lastActivity > idleBrowserMs) {
      console.log(`Closing idle browser for ${state.username}`);
      void closeSession(state);
    }
  }
  for (const [key, entry] of authCache) if (entry.expiresAt <= now) authCache.delete(key);
}, 60_000).unref();

server.listen(port, host, () => {
  const address = publicOrigin || `http://127.0.0.1:${port}`;
  console.log(`AGM Plan Assistant listening on ${host}:${port}; public origin ${address}; browser limit ${maxBrowsers}`);
});

async function shutdown() {
  clearInterval(sweeper);
  await Promise.allSettled([...sessions.values()].map(closeSession));
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
