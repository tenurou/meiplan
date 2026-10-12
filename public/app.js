const token = document.querySelector('meta[name="agm-token"]').content;
import { relationRows } from './relation-audit.js';
import { auditIsClear, identityAlerts } from './audit-status.js';
import { calculationModel, conversionSourceColumn, corePlacementGroup, eligiblePlanMetrics, formatCalculationColumn, isManualEntryHeader, normalizePlanPercentage, planPlacementGroup, planSourceNameColumn, validatePlanBudget } from './plan-rules.js';
import { isMissingSourceValue, parseNumericValue } from './numeric.js';
import { inferPlanMonth, matchPromotionName } from './report-selector.js';

const $ = id => document.getElementById(id);
let sheets = [], selectedSheet = null, reportTables = [], selectedReport = null, coreTable = null, workbookName = '';
let latestProposal = null;
let activeBrowserPage = 0, browserPages = [], snapshotBusy = false;
let adminFeedbackLoaded = false;
const headerTerms = ['площад', 'назван', 'кампан', 'описан', 'расход', 'бюджет', 'клик', 'показ', 'лид', 'цель', 'cr1', 'cpc', 'cpm', 'cpl'];

function setTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('agm-theme', dark ? 'dark' : 'light'); } catch { /* Theme still changes for this page when storage is unavailable. */ }
  const button = $('theme-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Переключить на светлую тему' : 'Переключить на чёрную тему');
    button.innerHTML = dark ? '<span aria-hidden="true">☀</span> Светлая тема' : '<span aria-hidden="true">☾</span> Чёрная тема';
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101014' : '#ffffff');
}
let savedTheme = 'dark';
try { savedTheme = localStorage.getItem('agm-theme') || 'dark'; } catch { /* Keep the default theme if storage is unavailable. */ }
setTheme(savedTheme);
$('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark' ? 'dark' : 'light'));
const brandImage = document.querySelector('.brand-mark');
if (brandImage) fetch(brandImage.src).then(response => {
  if (!response.ok) throw new Error('Logo image request failed');
  return response.arrayBuffer();
}).then(bytes => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(new Blob([bytes], { type: 'image/png' }));
})).then(dataUrl => { brandImage.src = dataUrl; }).catch(() => { brandImage.hidden = true; });

async function api(url, options = {}) {
  const headers = { 'X-AGM-Token': token, ...(options.headers || {}) };
  if (options.body && !(options.body instanceof ArrayBuffer) && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}
async function loadAdminFeedback() {
  const status = $('admin-feedback-status'), list = $('admin-feedback-list');
  status.textContent = 'Загружаю обращения…';
  try {
    const result = await api('/api/admin/feedback');
    status.textContent = `Всего: ${result.total}`;
    list.innerHTML = result.items.length ? result.items.map(item => `<article class="result-note"><strong>${esc(item.category)} · ${esc(item.username)}</strong><small>${esc(new Date(item.createdAt).toLocaleString('ru-RU'))}${item.contact ? ` · ${esc(item.contact)}` : ''}</small><p>${esc(item.message).replace(/\n/g, '<br>')}</p>${item.attachments?.length ? `<div class="feedback-file-list">${item.attachments.map(file => `<button type="button" class="button ghost feedback-file-download" data-feedback-item="${esc(item.id)}" data-feedback-file="${esc(file.id)}" data-feedback-name="${esc(file.name)}">⇩ ${esc(file.name)} <small>${(file.size / 1024 / 1024).toFixed(1)} МБ</small></button>`).join('')}</div>` : ''}</article>`).join('') : '<div class="empty-state"><strong>Обращений пока нет</strong></div>';
    adminFeedbackLoaded = true;
  } catch (error) { status.textContent = error.message; }
}
function toast(text) { const el = $('toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 4200); }
function amountToleranceValue(){const raw=$('amount-tolerance').value,value=raw.trim()===''?10:Number(raw);return Number.isFinite(value)?Math.min(10,Math.max(1,Math.round(value))):10;}
function normalizeAmountTolerance(){const value=amountToleranceValue();$('amount-tolerance').value=String(value);return value;}
function setConnection(connected, pages = []) {
  browserPages = pages;
  const box = $('connection');
  const needsLogin=pages.some(p=>{let pathName='';try{pathName=new URL(p.url).pathname.toLowerCase();}catch{}return pathName==='/login'||/нужен вход|sign in|log in/i.test(p.title||'');});
  box.querySelector('strong').textContent = connected ? 'Браузер подключён' : 'Браузер не подключён';
  box.querySelector('div:nth-child(2) span').textContent = !connected ? 'Страницы Core и DataLens появятся во встроенной панели ниже.' : needsLogin ? 'Открыта форма входа. Авторизуйся на сайте; вход сбросится при обновлении План-контроля.' : 'Страницы и вход в сервисы доступны во встроенной панели до обновления План-контроля.';
  const chip = box.querySelector('.status-chip'); chip.textContent = !connected ? 'НЕ ПОДКЛЮЧЁН' : needsLogin ? 'НУЖЕН ВХОД' : 'ПОДКЛЮЧЁН'; chip.className = `status-chip ${!connected?'muted':needsLogin?'warn':'ok'}`;
  ['capture','read-plan'].forEach(id => $(id).disabled = !connected);
  const select = $('core-page');
  select.innerHTML = pages.length ? pages.map(p => { let host='about:blank'; try{host=new URL(p.url).hostname;}catch{} return `<option value="${p.i}">${esc(p.title || p.url)} · ${esc(host)}</option>`; }).join('') : '<option>Нет открытых вкладок</option>';
  select.disabled = !pages.length;
  if (!pages.some(p=>p.i===Number(select.value)) && pages.length) select.selectedIndex=0;
  const browserSelect=$('browser-page');
  browserSelect.innerHTML=pages.length?pages.map(p=>{let host='';try{host=new URL(p.url).hostname}catch{}return `<option value="${p.i}">${esc(p.title||host||p.url)} · ${esc(host)}</option>`}).join(''):'<option>Нет открытых вкладок</option>';
  browserSelect.disabled=!pages.length;
  if(pages.some(p=>p.i===activeBrowserPage))browserSelect.value=String(activeBrowserPage);else if(pages.length){activeBrowserPage=pages[0].i;browserSelect.value=String(activeBrowserPage)}
  $('browser-new-tab').disabled=!connected;
  if(!connected){$('browser-image').hidden=true;$('browser-empty').hidden=false;$('browser-caption').textContent='Подключи браузер — страницы появятся здесь'}
  updateActionButtons();
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function ntext(s) { return String(s || '').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' '); }
function relationKey(s) { return ntext(s).replace(/^лср\s+/,'').replace(/\bлейк\b/g,'lake'); }
function exactColumn(headers, label) { const wanted=ntext(label), found=headers.map((h,i)=>ntext(h)===wanted?i:-1).filter(i=>i>=0); return found.length===1?found[0]:-1; }
function autoHeader(rows) {
  let best = 0, score = -1;
  rows.slice(0, 20).forEach((r, i) => { const line = ntext(r.values.join(' ')); const next = headerTerms.reduce((n,t) => n + (line.includes(t) ? 1 : 0), 0); if (next > score) { score = next; best = i; } });
  return best;
}
function drawSheetSelect() {
  const el = $('sheet'); el.innerHTML = sheets.map((s,i)=>`<option value="${i}">${esc(s.name)} · ${s.rows} строк</option>`).join(''); el.disabled = !sheets.length;
  if (sheets.length) { const preferred = Math.max(0, sheets.findIndex(s=>/бизнес/i.test(s.name))); el.value = String(preferred); loadSheet(preferred); }
}
async function loadSheet(i) {
  try {
    selectedSheet = await api(`/api/sheet?index=${i}`);
    const rows = selectedSheet.rows.filter(r => r.values.some(v => String(v).trim()));
    const headerIdx = autoHeader(rows);
    $('header-row').disabled=false;
    $('header-row').value=rows[headerIdx]?.number||1;
    const shown = rows.slice(Math.max(0,headerIdx-1), headerIdx + 7);
    $('excel-preview').innerHTML = miniTable(shown.map(r=>r.values));
    runAudit(); updateActionButtons();
  } catch(e) { toast(e.message); }
}
function miniTable(rows) {
  if (!rows?.length) return '<span class="empty">Нет строк для показа</span>';
  const max = Math.min(12, Math.max(...rows.map(r=>r.length)));
  return `<table class="mini-table"><tbody>${rows.map((r,i)=>`<tr>${Array.from({length:max},(_,j)=>`<${i===0?'th':'td'}>${esc(r[j]||'')}</${i===0?'th':'td'}>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function findMetric(headers, metric) {
  const h = headers.map(ntext);
  if (metric === 'name') {
    return planSourceNameColumn(headers);
  }
  const tests = {
    spend: x => (/расход|стоимость/.test(x) && x.includes('ндс') && !/(?:^| )ак(?: |$)/.test(x)) || /^бюджет(?: .*)?$/.test(x),
    leads: x => (x==='цо' || (/целев/.test(x) && /лид/.test(x) && !/cpa/.test(x)) || /прогноз лиды по last click/.test(x)),
    totalLeads: x => /все лид/.test(x) || /^лиды(?: шт)?$/.test(x) || /валов.*лид/.test(x) || /прогноз обращения/.test(x),
    impressions: x => /показ/.test(x), clicks: x => /клик/.test(x),
  };
  const matching = h.map((x,i)=>tests[metric](x)?i:-1).filter(i=>i>=0);
  if (metric === 'spend' && matching.length) return matching.find(i=>!h[i].includes('и ак')) ?? matching[0];
  return matching[0] ?? -1;
}
function num(v) {
  return parseNumericValue(v);
}
function displayedValueMatches(header, actual, expected){
  const aText=String(actual??'').trim(), eText=String(expected??'').trim();
  if(aText===eText)return true;
  let a=num(aText),e=num(eText);if(a===null||e===null)return false;
  const h=ntext(header);
  if(/(?:cr[123]|ctr)/.test(h)){if(aText.includes('%'))a/=100;if(eText.includes('%'))e/=100;return Math.abs(a-e)<0.00005;}
  if(/(?:^| )(?:все )?лиды?(?: |$)|^цо(?: |$)|целев.*лид/.test(h))return a===e;
  if(/показ/.test(h))return Math.abs(a-e)<0.5;
  if(/бюджет|расход|стоимост|^cpm|^cpc|^cpl|^cpa/.test(h))return Math.abs(a-e)<0.005;
  return Math.abs(a-e)<0.00001;
}
function validRows(table, headerIndex, nameIdx) {
  const rows = table.slice(headerIndex + 1).filter(r => r.some(v => String(v ?? '').trim()));
  const skip = true;
  return rows.filter(r => {
    if (nameIdx >= 0 && !String(r[nameIdx] ?? '').trim()) return false;
    const name = ntext(nameIdx >= 0 ? r[nameIdx] : r.join(' '));
    if (/^(?:итого|всего|total)(?:\s|$)/.test(name)) return false;
    if (skip && /ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/.test(name)) return false;
    return true;
  });
}
function datasetForSheet() {
  if (!selectedSheet) return null;
  const rows = selectedSheet.rows.filter(r=>r.values.some(v=>String(v).trim()));
  let h = rows.findIndex(r=>r.number===Number($('header-row').value));
  if(h<0)h=autoHeader(rows);
  const headers = rows[h]?.values || [];
  const n = findMetric(headers,'name');
  return { headers, rows: validRows(rows.map(r=>r.values), h, n), headerIndex:h, title:`Excel · ${selectedSheet.name}` };
}
function datasetForReport() {
  if (!selectedReport?.rows?.length) return null;
  const rows=selectedReport.rows, headers=rows[0]||[], h=findMetric(headers,'name');
  return {headers,rows:validRows(rows,0,h),headerIndex:0,title:'DataLens'};
}
function datasetForCore() {
  if (!coreTable?.table?.rows?.length) return null;
  const rows=coreTable.table.rows, headers=rows[0]||[], h=findMetric(headers,'name');
  return {headers,rows:validRows(rows,0,h),headerIndex:0,title:'МП Core'};
}
function objectRelation(dl, core) {
  if(!dl||!core)return {state:'нет источников',rows:[]};
  const di=selectedReport?.nameColumn??exactColumn(dl.headers,'Объект продвижения'), ci=exactColumn(core.headers,'Описание');
  if(di<0||ci<0)return {state:'нет колонок',rows:[],di,ci};
  const kind=selectedReport?.nameKind||'object';
  const expected=core.rows.slice(1).map(row=>String(row[ci]||'').trim()).filter(Boolean);
  const resolvedRows=dl.rows.map(row=>{const match=matchPromotionName(row[di],expected,kind);return match.status==='matched'?row.map((value,index)=>index===di?match.value:value):row;});
  const rows=relationRows(resolvedRows,di,core.rows,ci,relationKey,kind==='campaign'?'DataLens кампании':'DataLens объект продвижения','МП описание');
  return {state:'ok',rows,di,ci,kind};
}
function objectRelationMarkup(dl,core){
  const rel=objectRelation(dl,core);
  if(rel.state==='нет источников')return '';
  if(rel.state==='нет колонок')return `<ul class="alert-list"><li class="error">Связь МП «Описание» ↔ DataLens «Объект продвижения» не проверена: ${rel.ci<0?'не нашёл единственную колонку «Описание» в МП.':''} ${rel.di<0?'не нашёл единственную колонку «Объект продвижения» в DataLens.':''}</li></ul>`;
  if(!rel.rows.length)return '<div class="empty">Нет названий объектов для проверки связи.</div>';
  const matches=rel.rows.filter(r=>r.state==='Совпало').length,issues=rel.rows.length-matches;
  return `<h3 style="font-size:12px;margin:16px 0 6px">Связь описания МП ↔ ${rel.kind==='campaign'?'кампаний':'объектов'} DataLens</h3><div class="table-wrap relation-table"><table class="mini-table"><thead><tr><th>Описание в МП</th><th>${rel.kind==='campaign'?'Кампания':'Объект продвижения'} в DataLens</th><th>Результат</th></tr></thead><tbody>${rel.rows.map(r=>`<tr><td>${esc(r.description)}</td><td>${esc(r.object)}</td><td class="${r.state==='Совпало'?'relation-match':r.state.includes('Неоднозначно')?'relation-ambiguous':'relation-missing'}">${esc(r.state)}</td></tr>`).join('')}</tbody></table></div><ul class="alert-list"><li class="${issues?'error':'pass'}">${issues?`Связь названий: совпало ${matches} из ${rel.rows.length}; ${issues} строк требуют проверки.`:`Все ${matches} названий МП и DataLens связаны однозначно.`}</li></ul>`;
}
function summarize(ds) {
  if (!ds) return null;
  const si=findMetric(ds.headers,'spend'), li=findMetric(ds.headers,'leads'), ti=findMetric(ds.headers,'totalLeads'), ii=findMetric(ds.headers,'impressions'), ci=findMetric(ds.headers,'clicks');
  const sum=idx=>idx<0?null:ds.rows.reduce((a,r)=>a+(num(r[idx])??0),0);
  const excelPlan=String(ds.title||'').startsWith('Excel');
  const roundedClicks=excelPlan&&ci>=0?ds.rows.reduce((a,r)=>a+Math.round(num(r[ci])??0),0):sum(ci);
  const roundedImpressions=excelPlan&&ii>=0?ds.rows.reduce((a,r)=>a+Math.round((num(r[ii])??0)/1000),0):null;
  return {title:ds.title,spend:sum(si), leads:sum(li), totalLeads:sum(ti), impressions:sum(ii), comparisonImpressions:roundedImpressions, clicks:roundedClicks, count:ds.rows.length, spendHeader:ds.headers[si], leadHeader:ds.headers[li]};
}
const rub = n => n == null ? 'нет колонки' : new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n)+' ₽';
const whole = n => n == null ? 'нет колонки' : new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n);
function compare(a,b,label) {
  if (!a || !b) return '';
  if (a.spend === undefined) a = summarize(a);
  if (b.spend === undefined) b = summarize(b);
  const tol=label.startsWith('План Excel')?0.01:amountToleranceValue(), spendDelta=a.spend!=null&&b.spend!=null?a.spend-b.spend:null, leadDelta=a.leads!=null&&b.leads!=null?a.leads-b.leads:null;
  const spendOK=spendDelta!==null&&Math.abs(spendDelta)<=tol, leadOK=leadDelta!==null&&leadDelta===0;
  const clicksDelta=a.clicks!=null&&b.clicks!=null?a.clicks-b.clicks:null, clicksOK=clicksDelta!==null&&clicksDelta===0;
  let ia=a.impressions, ib=b.impressions;
  if(a.title.startsWith('Excel')&&a.comparisonImpressions!=null)ia=a.comparisonImpressions;
  else if((a.title==='DataLens'||a.title.startsWith('Excel'))&&$('thousand-impressions').checked&&ia!=null)ia/=1000;
  if((b.title==='DataLens'||b.title.startsWith('Excel'))&&$('thousand-impressions').checked&&ib!=null)ib/=1000;
  const impDelta=ia!=null&&ib!=null?ia-ib:null, impOK=impDelta!==null&&Math.abs(impDelta)<0.001;
  const totalLeadDelta=a.totalLeads!=null&&b.totalLeads!=null?a.totalLeads-b.totalLeads:null, totalLeadsOK=totalLeadDelta!==null&&totalLeadDelta===0;
  return `<div class="metric"><small>${esc(label)} · Бюджет</small><strong>${rub(a.spend)}</strong><em>${b.title}: ${rub(b.spend)} · Δ ${spendDelta==null?'—':rub(spendDelta)}</em><em class="${spendOK?'positive':'negative'}">${spendOK?'В допуске':'Не сходится'}</em></div><div class="metric"><small>${esc(label)} · Целевые лиды</small><strong>${whole(a.leads)}</strong><em>${b.title}: ${whole(b.leads)} · Δ ${leadDelta==null?'—':whole(leadDelta)}</em><em class="${leadOK?'positive':'negative'}">${leadOK?'Совпали точно':'Не сходятся или колонка не найдена'}</em></div><div class="metric"><small>${esc(label)} · Все лиды</small><strong>${whole(a.totalLeads)}</strong><em>${b.title}: ${whole(b.totalLeads)} · Δ ${totalLeadDelta==null?'—':whole(totalLeadDelta)}</em><em class="${totalLeadsOK?'positive':'negative'}">${totalLeadsOK?'Совпали точно':'Не сходятся или колонка не найдена'}</em></div><div class="metric"><small>${esc(label)} · Клики</small><strong>${whole(a.clicks)}</strong><em>${b.title}: ${whole(b.clicks)} · Δ ${clicksDelta==null?'—':whole(clicksDelta)}</em><em class="${clicksOK?'positive':'negative'}">${clicksOK?'Совпали точно':'Не сходятся/нет столбца'}</em></div><div class="metric"><small>${esc(label)} · Показы</small><strong>${whole(ia)}</strong><em>${b.title}: ${whole(ib)} · Δ ${impDelta==null?'—':whole(impDelta)}</em><em class="${impOK?'positive':'negative'}">${impOK?'Совпали в тыс.':'Не сходятся/нет столбца'}</em></div>`;
}
function runAudit() {
  const xl=datasetForSheet(), dl=datasetForReport(), core=datasetForCore();
  const sums=[['Excel',xl],['DataLens',dl],['Core',core]].map(([name,ds])=>ds?{name,...summarize(ds)}:null).filter(Boolean);
  const available=sums.length>=2;
  const alerts=makeAlerts(xl,dl,core);
  $('audit-results').innerHTML=available?`<div class="metric-grid">${sums.map(s=>`<div class="metric"><small>${esc(s.name)} · ${s.count} строк</small><strong>${rub(s.spend)}</strong><em>целевые лиды: ${whole(s.leads)}${s.totalLeads!=null?' · все лиды: '+whole(s.totalLeads):''}</em><em>${s.clicks!=null?'клики: '+whole(s.clicks):'клики: нет колонки'}${s.impressions!=null?' · показы: '+whole(s.impressions):''}</em></div>`).join('')}</div><div class="metric-grid" style="margin-top:10px">${compare(xl,core,'План Excel ↔ МП')}${compare(dl,core,'DataLens ↔ МП факт')}</div><ul class="alert-list">${alerts.map(a=>`<li class="${a.type}">${esc(a.text)}</li>`).join('')}</ul>${objectRelationMarkup(dl,core)}`:'<div class="empty-state"><span>⌁</span><strong>Нужно загрузить источник и считать таблицу МП</strong><small>После этого здесь покажем несовпадения, пропущенные строки и суммы для проверки.</small></div>';
  const allOk=auditIsClear(available,alerts);
  $('audit-status').textContent=available?(allOk?'СХОДИТСЯ':'ЕСТЬ РАСХОЖДЕНИЯ'):'ЖДЁТ ДАННЫЕ';
  $('audit-status').className=`status-chip ${available?(allOk?'ok':'warn'):'muted'}`;
}
function updateActionButtons(){
  $('prepare-plan').disabled=!(selectedSheet&&coreTable);
  $('prepare-fact').disabled=!(selectedReport&&coreTable);
}
function headerMetric(header){
  const h=ntext(header);
  // АК and рекламный сбор are always entered manually.
  if(isManualEntryHeader(header)) return 'manualAK';
  if (/^бюджет(?:\s|$)|^расход|^стоимость/.test(h)) return 'budget';
  if (/показ/.test(h)) return 'impressions';
  if (/клик/.test(h)) return 'clicks';
  if (/^лиды$/.test(h)||/^все лиды/.test(h)) return 'allLeads';
  if (/^цо$|целев.*лид/.test(h)) return 'targetLeads';
  if (/^cpl\b|cpa.*уник|cpa.*валов/.test(h)) return 'cpl';
  if (/^cpa\b|cpa.*целев/.test(h)) return 'cpa';
  if (/^cpc\b|^срс\b/.test(h)) return 'cpc';
  if (/^cpm\b|^срм\b/.test(h)) return 'cpm';
  if (/^cr1\b|^ctr\b/.test(h)) return 'cr1';
  if (/^cr2\b/.test(h)) return 'cr2';
  if (/^cr3\b/.test(h)) return 'cr3';
  if (/назван|площад|кампан|описан|utm source/.test(h)) return 'name';
  return null;
}
function sourceColumn(targetHeader, sourceHeaders, mode){
  const targetNorm=ntext(targetHeader), targetMetric=headerMetric(targetHeader);
  // Manual-only fields are excluded before exact-name matching as a second safeguard.
  if(targetMetric==='manualAK') return -1;
  if(['cr1','cr2','cr3'].includes(targetMetric)) return conversionSourceColumn(targetMetric,sourceHeaders,mode);
  const exact=sourceHeaders.map((h,i)=>ntext(h)===targetNorm?i:-1).filter(i=>i>=0);
  if (exact.length===1) return exact[0];
  if (exact.length>1) return -1;
  const hs=sourceHeaders.map((h,i)=>({h:ntext(h),i}));
  let candidates=[];
  if(targetMetric==='budget') candidates=hs.filter(x=>(/расход|стоимост|бюджет/.test(x.h)) && (!/(?:^| )ак(?: |$)/.test(x.h)) && (mode==='fact' ? x.h.includes('ндс') : true));
  if(mode==='plan'&&targetMetric==='budget') candidates=hs.filter(x=>/^(?:стоимость с ндс|бюджет)(?: руб)?$/.test(x.h)&&!/(?:и ак|ак|сбор)/.test(x.h));
  if(targetMetric==='impressions') candidates=hs.filter(x=>/показ/.test(x.h));
  if(targetMetric==='clicks') candidates=hs.filter(x=>/клик/.test(x.h));
  if(targetMetric==='allLeads') candidates=hs.filter(x=>/все лид|лиды$|валов.*лид/.test(x.h));
  if(targetMetric==='targetLeads') candidates=hs.filter(x=>/целев.*лид|конверс/.test(x.h));
  if(mode==='plan'&&targetMetric==='allLeads') { let c=sourceHeaders.map((h,i)=>/^прогноз обращения(?: шт)?$/.test(ntext(h))?i:-1).filter(i=>i>=0);if(!c.length)c=sourceHeaders.map((h,i)=>/^валовые лиды(?: шт)?$/.test(ntext(h))?i:-1).filter(i=>i>=0);return c.length===1?c[0]:-1; }
  if(mode==='plan'&&targetMetric==='targetLeads') { let c=sourceHeaders.map((h,i)=>/прогноз лиды по last click/.test(ntext(h))?i:-1).filter(i=>i>=0);if(!c.length)c=sourceHeaders.map((h,i)=>/^прогноз лиды(?: шт)?$/.test(ntext(h))?i:-1).filter(i=>i>=0);return c.length===1?c[0]:-1; }
  if(targetMetric==='cpl') candidates=hs.filter(x=>/cpl\b|cpa.*уник|cpa.*валов/.test(x.h));
  if(targetMetric==='cpa') candidates=hs.filter(x=>/cpa.*целев/.test(x.h));
  if(targetMetric==='cpc') candidates=hs.filter(x=>/^cpc\b|^срс\b|цена за клик|стоимост.*клик/.test(x.h));
  if(targetMetric==='cpm') candidates=hs.filter(x=>/^cpm\b|^срм\b|цена за тысячу/.test(x.h));
  if(mode==='plan'&&targetMetric==='cpc'&&candidates.length===0)candidates=hs.filter(x=>/цена за единицу/.test(x.h));
  if(mode==='plan'&&targetMetric==='cpm'&&candidates.length===0)candidates=hs.filter(x=>/цена за единицу/.test(x.h));
  if(targetMetric==='cr1') candidates=hs.filter(x=>/^ctr\b|^cr1\b/.test(x.h));
  if(targetMetric==='cr2') candidates=mode==='plan'?hs.filter(x=>/^прогноз cr\b/.test(x.h)).slice(0,1):hs.filter(x=>/^cr2\b/.test(x.h));
  if(targetMetric==='cr3') candidates=mode==='plan'?hs.filter(x=>/^прогноз cr\b/.test(x.h)).slice(1,2):hs.filter(x=>/^cr3\b/.test(x.h));
  if(candidates.length===1) return candidates[0].i;
  // In DataLens fact tables, Core CR1 is CTR; CR2/CR3 keep their named report metrics.
  if(mode==='fact' && targetMetric==='cr1') { const c=hs.filter(x=>x.h.includes('ctr')); if(c.length===1)return c[0].i; }
  return -1;
}
function planSourceGroup(headers,row){
  return planPlacementGroup(headers,row);
}
function planCoreContext(rows,rowIndex,descriptionIndex,placementIndex){
  for(let i=rowIndex-1;i>=1;i--){
    const description=String(rows[i][descriptionIndex]||'').trim(), placement=String(rows[i][placementIndex]||'').trim();
    if(description||!placement)continue;
    const groupKey=corePlacementGroup(placement);
    const model=groupKey.split('|').at(-1)||'';
    return {groupKey,model,label:placement};
  }
  return {groupKey:'',model:'',label:''};
}
function makeProposal(mode){
  const src=mode==='fact'?datasetForReport():datasetForSheet(), dst=datasetForCore();
  if(!src||!dst) throw new Error('Нужны источник и считанная таблица МП.');
  const sName=mode==='fact'?(selectedReport?.nameColumn??exactColumn(src.headers,'Объект продвижения')):findMetric(src.headers,'name');
  const tName=mode==='fact'?exactColumn(dst.headers,'Описание'):findMetric(dst.headers,'name');
  if(sName<0||tName<0) throw new Error(mode==='fact'?'Для факта нужны однозначные колонки DataLens «Объект продвижения» и МП «Описание». Перенос остановлен.':'Не нашёл колонку с названием строки. Остановил перенос, чтобы не спутать размещения.');
  const sourceByName=new Map(), targetByName=new Map(), ignored=/ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i, issues=[], missingMappings=new Set();
  const corePlacement=mode==='plan'?exactColumn(dst.headers,'Площадка'):-1;
  if(mode==='plan'&&corePlacement<0)throw new Error('Для импорта плана не нашёл колонку «Площадка» в МП.');
  const changes=[], checks=[], warnings=[], skippedSourceValues=new Set(), rowStatuses=new Map();
  let partialBlocked=false;
  const expectedFactObjects=mode==='fact'?dst.rows.slice(1).map(row=>String(row[tName]||'').trim()).filter(Boolean):[];
  const calcColumn=mode==='plan'?formatCalculationColumn(src.headers):-1;
  if(mode==='plan')src.rows.forEach((row,i)=>{
    const name=String(row[sName]||'').trim();
    if(name)rowStatuses.set(i,{source:name,target:'—',group:'',model:'',status:'skipped',reason:'Нет однозначного размещения Core.'});
  });
  src.rows.forEach((row,i)=>{
    const name=String(row[sName]||'').trim(); if(!name||($('skip-excluded').checked&&ignored.test(name)))return;
    if(mode==='plan'&&calcColumn>=0){
      const rawModel=String(row[calcColumn]??'').trim(), model=calculationModel(rawModel);
      if(!rawModel)return;
      if(!model){warnings.push(`${name}: формат расчётов «${rawModel}» не распознан; строка останется без изменений.`);rowStatuses.set(i,{source:name,target:'—',group:'',model:'',status:'review',reason:`Не распознана модель «${rawModel}».`});return;}
      if(model==='STATIC'&&!planSourceGroup(src.headers,row).startsWith('yandex-maps-')){warnings.push(`${name}: статичная строка не является строкой Яндекс Карт и останется без изменений.`);rowStatuses.set(i,{source:name,target:'—',group:'',model,status:'skipped',reason:'Статичная строка вне поддерживаемой группы Яндекс Карт.'});return;}
    }
    const group=mode==='plan'?planSourceGroup(src.headers,row):'';
    if(mode==='plan'&&!group){issues.push(`${name}: не удалось однозначно определить площадку, формат и модель размещения в Excel.`);rowStatuses.set(i,{source:name,target:'—',group:'',model:'',status:'review',reason:'Не подтверждены площадка, формат и модель.'});return;}
    let matchName=name;
    if(mode==='fact'&&selectedReport?.nameKind==='campaign'){
      const resolved=matchPromotionName(name,expectedFactObjects,'campaign');
      if(resolved.status==='ambiguous'){issues.push(`${name}: кампания совпала с несколькими описаниями МП (${resolved.candidates.join(', ')}); строка оставлена без изменений.`);partialBlocked=true;return;}
      if(resolved.status==='missing'){issues.push(`${name}: кампания не сопоставилась ни с одним описанием МП; строка оставлена без изменений.`);return;}
      matchName=resolved.value;
    }
    const key=mode==='fact'?relationKey(matchName):`${group}|${relationKey(name)}`; if(!sourceByName.has(key))sourceByName.set(key,[]); sourceByName.get(key).push({row,i,name,group});
  });
  dst.rows.forEach((row,i)=>{
    const name=String(row[tName]||'').trim(); if(!name||($('skip-excluded').checked&&ignored.test(name)))return;
    const fullRowIndex=coreTable.table.rows.indexOf(row), context=mode==='plan'?planCoreContext(coreTable.table.rows,fullRowIndex,tName,corePlacement):null, group=context?.groupKey||'';
    const key=mode==='fact'?relationKey(name):`${group}|${relationKey(name)}`; if(!targetByName.has(key))targetByName.set(key,[]); targetByName.get(key).push({row,i,name,group,model:context?.model||'',groupLabel:context?.label||''});
  });
  if(mode==='fact'&&selectedReport?.truncated){issues.push('Таблица DataLens достигла лимита чтения 3000 строк; сузь фильтр отчёта, чтобы не внести неполные данные.');partialBlocked=true;}
  const sourceNames=[...sourceByName.entries()];
  for(const [key,srcItems] of sourceNames){
    const dstItems=targetByName.get(key)||[];
    const sourceGroup=srcItems[0].group;
    if(srcItems.length!==1||dstItems.length!==1){const reason=srcItems.length>1?'повторяется в Excel в одной группе':dstItems.length>1?'несколько строк Core подходят этой связке':'подходящего размещения Core нет';issues.push(`${srcItems[0].name}${sourceGroup?` · ${sourceGroup}`:''}: ${reason}; автоматический выбор запрещён.`);for(const item of srcItems)rowStatuses.set(item.i,{source:item.name,target:dstItems.map(x=>x.name).join(' / ')||'—',group:sourceGroup,model:'',status:dstItems.length?'review':'skipped',reason});continue;}
    const s=srcItems[0], t=dstItems[0], fullRowIndex=coreTable.table.rows.indexOf(t.row);
    const model=mode==='plan'?t.model:'';
    if(mode==='plan'&&(!t.group||!model)){issues.push(`${t.name}: в МП не удалось определить родительскую группу и модель расчёта; перенос остановлен для этой строки.`);rowStatuses.set(s.i,{source:s.name,target:t.name,group:s.group,model:'',status:'review',reason:'Модель или группа Core не подтверждена.'});continue;}
    const rowStatus={source:s.name,target:t.name,group:s.group,model,status:'ready',reason:'Сопоставление подтверждено',budgetCheck:null};
    rowStatuses.set(s.i,rowStatus);
    const classified=/avito|domclick|домклик|cian|циан|realty|недвижим|классиф/i.test(t.name)||s.group.startsWith('classifieds|');
    for(let colIndex=0;colIndex<dst.headers.length;colIndex++){
      const header=dst.headers[colIndex], metric=headerMetric(header);
      if(!metric||metric==='name'||metric==='manualAK')continue;
      const derivedBudgetCheck=mode==='plan'&&metric==='budget'&&!['FIX','STATIC'].includes(model);
      if(mode==='plan'&&!eligiblePlanMetrics(model).includes(metric)&&!derivedBudgetCheck)continue;
      if(classified&&!['cpl','allLeads','targetLeads'].includes(metric))continue;
      let sourceIdx=-1;
      if(mode==='plan'&&metric==='cpm')sourceIdx=sourceColumn(header,src.headers,mode);
      else if(mode==='plan'&&metric==='budget'&&['FIX','STATIC'].includes(model))sourceIdx=sourceColumn('Стоимость с НДС',src.headers,mode);
      else if(mode==='plan'&&metric==='budget')sourceIdx=sourceColumn('Стоимость с НДС',src.headers,mode);
      else if(mode==='plan'&&model==='STATIC')sourceIdx=sourceColumn(header,src.headers,mode);
      else if(mode==='plan'&&['cr1','cr2','cr3','impressions','clicks','allLeads','targetLeads'].includes(metric))sourceIdx=sourceColumn(header,src.headers,mode);
      else if(mode==='fact')sourceIdx=sourceColumn(header,src.headers,mode);
      if(sourceIdx<0){missingMappings.add(String(header));rowStatus.status=rowStatus.status==='review'?'review':'partial';rowStatus.reason='Для части полей Excel/Core нет точного заголовка-источника.';continue;}
      let raw=s.row[sourceIdx];
      if(raw===undefined||String(raw).trim()===''){
        issues.push(`${s.name}: пустое значение источника в колонке «${src.headers[sourceIdx]}» для показателя «${header}»; ячейка останется без изменений.`);rowStatus.status=rowStatus.status==='review'?'review':'partial';rowStatus.reason='Часть исходных значений пуста.';
        continue;
      }
      if(isMissingSourceValue(raw)){
        skippedSourceValues.add(`${s.name} · ${header}`);rowStatus.status=rowStatus.status==='review'?'review':'partial';rowStatus.reason='Часть значений пуста или содержит ошибку формулы Excel.';
        continue;
      }
      let value=num(raw);
      if(value===null){
        issues.push(`${s.name}: значение «${String(raw)}» в колонке «${src.headers[sourceIdx]}» не является числом; ячейка останется без изменений.`);rowStatus.status='review';rowStatus.reason='Нечисловое исходное значение.';
        continue;
      }
      if(mode==='fact'&&['cr1','cr2','cr3'].includes(metric)){
        const rawText=String(raw).trim(), sourceHeader=String(src.headers[sourceIdx]||'');
        if(rawText.includes('%'))value/=100;
        else if(sourceHeader.includes('%')){issues.push(`${s.name}: в DataLens поле «${sourceHeader}» не содержит знак %. Единицы CR неоднозначны, строка заблокирована.`);partialBlocked=true;continue;}
      }
      if(mode==='plan'&&['cr1','cr2','cr3'].includes(metric)){
        const sourceCell=selectedSheet.rows.find(source=>source.values===s.row);
        value=normalizePlanPercentage(value,{sourceFormat:sourceCell?.cellFormats?.[sourceIdx]||'',hasPercentSign:String(raw).includes('%')});
      }
      if(metric==='impressions'&&value!==null&&(mode==='plan'||$('thousand-impressions').checked))value=value/1000;
      if(mode==='plan'&&metric==='clicks')value=Math.round(value);
      const old=String(t.row[colIndex]||'').trim();
      const newValue=String(Number(value.toFixed(6)));
      const sourceRowIndex=mode==='fact'?selectedReport.rows.findIndex(row=>row===s.row):selectedSheet.rows.findIndex(row=>row.values===s.row);
      rowStatus.sourceRowIndex=sourceRowIndex;
      checks.push({rowIndex:fullRowIndex,colIndex,rowKey:t.name,value:newValue,header,sourceRowIndex,sourceColIndex:sourceIdx,sourceNameCol:sName,sourceRowKey:s.name,sourceHeader:String(src.headers[sourceIdx]||''),sourceNameHeader:String(src.headers[sName]||''),sourceValue:String(raw)});
      if(derivedBudgetCheck)continue;
      if(mode==='plan'&&metric==='clicks')continue;
      if(displayedValueMatches(header,old,newValue))continue;
      changes.push({rowIndex:fullRowIndex,colIndex,rowKey:t.name,value:newValue,oldValue:old,header,sourceValue:String(raw),sourceRowKey:s.name,sourceHeader:src.headers[sourceIdx],sourceNameHeader:src.headers[sName],sourceRowIndex});
    }
    if(mode==='plan'){
      const findUnique=(matcher)=>{const cols=src.headers.map((header,index)=>matcher(ntext(header))?index:-1).filter(index=>index>=0);return cols.length===1?cols[0]:-1;};
      const sourceNumber=(index)=>index<0||isMissingSourceValue(s.row[index])?null:num(s.row[index]);
      const budgetIndex=findUnique(h=>/^стоимость с ндс(?: руб)?$|^бюджет(?: руб)?$/.test(h)&&!/(?:и ак|сбор)/.test(h));
      let priceIndex=-1;
      if(model==='CPM'||model==='CPC'){
        priceIndex=findUnique(h=>/^цена за единицу с ндс$/.test(h));
        if(priceIndex<0)priceIndex=findUnique(h=>model==='CPM'?/^cpm$/.test(h):/^cpc$/.test(h));
      }else if(model==='CPL'||model==='CPA')priceIndex=findUnique(h=>/^cpl(?: руб)?$/.test(h));
      const impressionsIndex=findUnique(h=>/^показ(?:ы|ов)?(?: шт)?$/.test(h));
      const clicksIndex=findUnique(h=>/^клик(?:и|ов)?(?: шт)?$/.test(h));
      let leadsIndex=findUnique(h=>/^прогноз лиды по last click(?: шт)?$/.test(h));
      if(leadsIndex<0)leadsIndex=findUnique(h=>/^прогноз обращения(?: шт)?$/.test(h));
      let impressions=sourceNumber(impressionsIndex);if(model==='CPM'&&impressions!==null)impressions/=1000;
      const budgetInputs={price:sourceNumber(priceIndex),impressions,clicks:sourceNumber(clicksIndex),leads:sourceNumber(leadsIndex),sourceBudget:sourceNumber(budgetIndex)};
      const budgetCheck={...validatePlanBudget({model,...budgetInputs}),inputs:budgetInputs,sourceHeaders:{price:src.headers[priceIndex]||'',budget:src.headers[budgetIndex]||''}};
      rowStatus.budgetCheck=budgetCheck;
      if(budgetCheck.status!=='ok'){
        rowStatus.status='review';rowStatus.reason=budgetCheck.message;
        issues.push(`${s.name}: ${budgetCheck.message}`);
      }
    }
  }
  if(skippedSourceValues.size){const examples=[...skippedSourceValues].slice(0,6);warnings.push(`В источнике прочерки, null или ошибки формул Excel (например, #DIV/0!) в ${skippedSourceValues.size} ячейках; только эти показатели пропущены, остальные корректные значения можно внести: ${examples.join(', ')}${skippedSourceValues.size>examples.length?'…':''}.`);}
  const sourceObjectKeys=new Set([...sourceByName.values()].flat().map(item=>relationKey(item.name)));
  const untouchedRows=[...targetByName.values()].flat().filter(item=>!sourceObjectKeys.has(relationKey(item.name)));
  if(untouchedRows.length){
    const names=[...new Set(untouchedRows.map(item=>item.name))];
    warnings.push(`В МП есть строки без соответствия в источнике (${names.length}): ${names.slice(0,8).join(', ')}${names.length>8?'…':''}. Эти строки останутся без изменений.`);
  }
  for(const header of missingMappings)issues.push(`Для поля «${header}» в источнике нет единственного однозначного столбца; это поле не будет пропущено молча.`);
  const matched=sourceNames.filter(([k,v])=>v.length===1&&(targetByName.get(k)||[]).length===1).length;
  if(changes.length>2500){issues.push('В одной операции больше 2 500 ячеек; раздели перенос на несколько меньших операций.');partialBlocked=true;}
  if(!changes.length)issues.push('Нет значений для изменения: совпадающих строк и метрик не найдено либо значения уже равны.');
  return {mode,sourceTitle:src.title,changes,checks,issues,warnings,matched,sourceRows:sourceNames.length+issues.filter(x=>x.includes('не удалось определить тип размещения')).length,nameCol:tName,partialBlocked,rowResults:[...rowStatuses.values()]};
}
function showProposal(mode){
  let p;try{p=makeProposal(mode);}catch(e){toast(e.message);return;}
  latestProposal=p;
  const previewRows=p.changes.slice(0,2500).map(c=>`<tr><td>${esc(c.rowKey)}</td><td>${esc(c.header)}</td><td>${esc(c.oldValue||'—')} → <b>${esc(c.value)}</b></td></tr>`).join('');
  const noChanges=p.changes.length===0&&p.issues.length===1&&p.issues[0].startsWith('Нет значений для изменения:');
  const blocked=p.issues.length>0&&!noChanges;
  const visibleIssues=p.issues.filter(x=>!noChanges);
  const alertItems=[...visibleIssues.map(x=>`<li class="error">${esc(x)}</li>`),...(p.warnings||[]).map(x=>`<li class="warn">${esc(x)}</li>`)];
  const partialAvailable=blocked&&!p.partialBlocked&&p.changes.length>0&&p.changes.length<=2500;
  const stateNote=noChanges?(p.warnings.length?'Все однозначно сопоставленные поля уже совпадают; есть пропуски в предупреждениях.':'Уже совпадает: все поддерживаемые поля сверены с источником; изменений для записи нет.'):'Сначала значения будут внесены в форму Core без сохранения. Затем проверь черновик и отдельно подтверди кнопку «Сохранить».';
  const statusCounts={ready:0,partial:0,review:0,skipped:0};for(const row of p.rowResults||[])statusCounts[row.status]=(statusCounts[row.status]||0)+1;
  const statusMarkup=mode==='plan'?`<div class="plan-status-counts"><span>Готово к внесению: ${statusCounts.ready}</span><span>Частично готово: ${statusCounts.partial}</span><span>Требуется проверка: ${statusCounts.review}</span><span>Пропущено: ${statusCounts.skipped}</span></div><div class="table-wrap"><table class="mini-table"><thead><tr><th>Строка Excel → размещение Core</th><th>Модель</th><th>Статус / проверка бюджета</th></tr></thead><tbody>${(p.rowResults||[]).map(row=>`<tr><td>${esc(row.source)} → ${esc(row.target)}</td><td>${esc(row.model||'—')}</td><td>${esc(row.reason||'Сопоставление подтверждено')}${row.budgetCheck?.expected!=null?` · расчёт ${row.budgetCheck.expected.toFixed(2)} ₽ / Excel ${row.budgetCheck.actual.toFixed(2)} ₽ / Δ ${row.budgetCheck.difference.toFixed(2)} ₽`:` · Excel: цена ${row.budgetCheck?.inputs?.price??'—'} (${esc(row.budgetCheck?.sourceHeaders?.price||'нет колонки')}), показы ${row.budgetCheck?.inputs?.impressions??'—'}, бюджет ${row.budgetCheck?.inputs?.sourceBudget??'—'}`}</td></tr>`).join('')||'<tr><td colspan="3">Нет строк для классификации</td></tr>'}</tbody></table></div>`:'';
  $('audit-results').innerHTML=`<div class="proposal-head"><div><strong>${mode==='fact'?'Перенос факта':'Перенос плана'} · ${esc(p.sourceTitle)}</strong><small>Точных строк: ${p.matched} из ${p.sourceRows} · Ячеек к внесению: ${p.changes.length} · Ячеек к проверке после сохранения: ${p.checks.length}${p.changes.length>2500?' (перенос заблокирован)':''}</small></div><div class="proposal-actions"><button id="apply-proposal" class="button primary" ${!p.changes.length||blocked?'disabled':''}>Внести поля без сохранения</button>${partialAvailable?`<button id="apply-partial" class="button secondary">Внести ${p.changes.length} проверенных · пропустить проблемные</button>`:''}</div></div>${statusMarkup}${partialAvailable?'<p class="partial-note">Внесутся только ячейки строк со статусом «Готово» или «Частично готово». Неоднозначные строки и строки с несходящимся бюджетом будут пропущены. Сохранение требует отдельного подтверждения.</p>':''}${alertItems.length?`<ul class="alert-list">${alertItems.join('')}</ul>`:`<ul class="alert-list"><li class="pass">${stateNote}</li></ul>`}<div class="table-wrap"><table class="mini-table"><thead><tr><th>Строка МП</th><th>Поле</th><th>Было → станет</th></tr></thead><tbody>${previewRows||'<tr><td colspan="3">Нет изменений</td></tr>'}</tbody></table></div>`;
  $('audit-status').textContent=noChanges?(p.warnings.length?'СОВПАДАЮТ СОПОСТАВЛЕННЫЕ ПОЛЯ':'УЖЕ СОВПАДАЕТ'):blocked?'НУЖНА ПРОВЕРКА':'ГОТОВО К ВНЕСЕНИЮ';$('audit-status').className=`status-chip ${blocked?'warn':'ok'}`;
  const stageProposal=async(allowPartial)=>{
    if(!latestProposal?.changes.length)return;
    const btn=$(allowPartial?'apply-partial':'apply-proposal');btn.disabled=true;btn.textContent='Подготовка…';
    try{
      const acceptedRows=allowPartial?new Set((p.rowResults||[]).filter(row=>['ready','partial'].includes(row.status)).map(row=>row.sourceRowIndex)):null;
      const transferChanges=acceptedRows?p.changes.filter(change=>acceptedRows.has(change.sourceRowIndex)):p.changes;
      const transferChecks=acceptedRows?p.checks.filter(check=>acceptedRows.has(check.sourceRowIndex)):p.checks;
      if(!transferChanges.length)throw new Error('Нет строк без блокирующих проблем для частичного внесения.');
      const draft=await api('/api/prepare-apply',{method:'POST',body:JSON.stringify({pageIndex:Number($('core-page').value),planUrl:coreTable?.url,nameCol:p.nameCol,mode:p.mode,amountTolerance:amountToleranceValue(),sourceId:p.mode==='fact'?selectedReport?.id:null,sourceSheetIndex:p.mode==='plan'?Number($('sheet').value):null,sourceHeaderRowIndex:p.mode==='plan'?selectedSheet.rows.findIndex(row=>row.number===Number($('header-row').value)):null,impressionsInThousands:$('thousand-impressions').checked,changes:transferChanges,checks:transferChecks,issues:p.issues,allowPartial})});
      btn.textContent='Вношу…';
      const result=await api('/api/apply',{method:'POST',body:JSON.stringify({id:draft.id})});
      if(!result.ok||!result.staged)throw new Error(result.message||'Поля не прошли проверку; кнопка «Сохранить» осталась нетронутой.');
      toast(result.message);
      btn.textContent='Поля внесены · не сохранено';
      $('audit-status').textContent='ЧЕРНОВИК В CORE · НЕ СОХРАНЁН';$('audit-status').className='status-chip warn';
      $('audit-results').insertAdjacentHTML('afterbegin',`<div class="result-note failure" id="unsaved-draft-note">${esc(result.message)} Проверь значения в открытом медиаплане. Core «Сохранить» ещё не нажималась.</div><div class="proposal-head" id="save-approval"><div><strong>Черновик проверен?</strong><small>Нажатие ниже — аппрув на сохранение в Core.</small></div><button id="approve-save" class="button primary">Подтвердить и сохранить в Core</button></div>`);
      $('approve-save').addEventListener('click',async()=>{
        if(!confirm(`Подтверждаешь сохранение ${transferChanges.length} изменений в Core? После подтверждения приложение нажмёт кнопку «Сохранить» и перечитает таблицу.`))return;
        const saveButton=$('approve-save');saveButton.disabled=true;saveButton.textContent='Сохраняю…';
        try{
          const saved=await api('/api/save',{method:'POST',body:JSON.stringify({id:draft.id,approved:true})});
          $('save-approval')?.remove();
          let refreshNote='';
          if(saved.saved){
            try{coreTable=await api('/api/read-plan',{method:'POST',body:JSON.stringify({pageIndex:Number($('core-page').value)})});$('plan-preview').innerHTML=miniTable(coreTable.table.rows);runAudit();}
            catch(error){refreshNote=` Сохранение и сверка подтверждены сервером, но экран не удалось обновить: ${error.message}`;}
          }
          $('audit-results').insertAdjacentHTML('afterbegin',`<div class="result-note ${saved.ok?'success':'failure'}">${esc(saved.message)}${saved.totalRows!=null?` Построчно проверено ${saved.verifiedRows}/${saved.totalRows}; контрольные суммы ${saved.totalsVerified?'сверены':'не сошлись'}.`:''}${esc(refreshNote)}</div>`);
          if(!saved.ok){$('audit-status').textContent='СОХРАНЕНИЕ НЕ ПОДТВЕРЖДЕНО';$('audit-status').className='status-chip bad';}
        }catch(error){const message=error.message||'Не удалось подтвердить результат сохранения';toast(message);saveButton.disabled=true;saveButton.textContent='Результат не подтверждён — проверь Core';$('audit-status').textContent='ПРОВЕРЬ РЕЗУЛЬТАТ В CORE';$('audit-status').className='status-chip bad';$('audit-results').insertAdjacentHTML('afterbegin',`<div class="result-note failure">${esc(message)} Результат сохранения неизвестен. Проверь страницу Core вручную и не запускай сохранение повторно, пока не убедишься, что данные не записались.</div>`);}
      });
    }catch(e){const message=e.message||'Не удалось внести черновик';toast(message);$('audit-results').insertAdjacentHTML('afterbegin',`<div class="result-note failure">Черновик не проверен: ${esc(message)}. Core «Сохранить» не нажималась.</div>`);$('audit-status').textContent='НУЖНА ПРОВЕРКА';$('audit-status').className='status-chip bad';btn.disabled=true;btn.textContent='Пересобери предпросмотр';}
  };
  $('apply-proposal')?.addEventListener('click',()=>stageProposal(false));
  $('apply-partial')?.addEventListener('click',()=>stageProposal(true));
}
function makeAlerts(xl,dl,core) {
  const out=[];
  for (const [a,b,label] of [[xl,core,'Excel ↔ МП'],[dl,core,'DataLens ↔ МП']]) {
    if (!a||!b) continue;
    const sourceNameColumn=label.startsWith('DataLens')?exactColumn(a.headers,'Объект продвижения'):findMetric(a.headers,'name');
    const targetNameColumn=label.startsWith('DataLens')?exactColumn(b.headers,'Описание'):findMetric(b.headers,'name');
    out.push(...identityAlerts(a.rows,sourceNameColumn,b.rows,targetNameColumn,relationKey,label.split(' ↔ ')[0]));
    const s=summarize(a), t=summarize(b), tol=label.startsWith('Excel')?0.01:amountToleranceValue();
    if (s.spend==null||t.spend==null) out.push({type:'error',text:`${label}: не нашёл столбец суммы — выбери подходящую колонку в источнике или плане.`});
    else if (Math.abs(s.spend-t.spend)<=tol) out.push({type:'pass',text:`${label}: суммы в допуске ±${tol} ₽ (${rub(s.spend-t.spend)}).`});
    else out.push({type:'error',text:`${label}: разница по сумме ${rub(s.spend-t.spend)} превышает допуск ±${tol} ₽.`});
    if (s.leads==null||t.leads==null) out.push({type:'error',text:`${label}: не нашёл колонку целевых лидов для точного сравнения.`});
    else if (s.leads===t.leads) out.push({type:'pass',text:`${label}: целевые лиды совпадают точно (${whole(s.leads)}).`});
    else out.push({type:'error',text:`${label}: целевые лиды расходятся на ${whole(s.leads-t.leads)}.`});
    if (s.totalLeads==null||t.totalLeads==null) out.push({type:'error',text:`${label}: не нашёл колонку всех лидов для точного сравнения.`});
    else if (s.totalLeads===t.totalLeads) out.push({type:'pass',text:`${label}: все лиды совпадают точно (${whole(s.totalLeads)}).`});
    else out.push({type:'error',text:`${label}: все лиды расходятся на ${whole(s.totalLeads-t.totalLeads)}.`});
  }
  const xlDs=datasetForSheet(), dlDs=datasetForReport();
  if (xlDs&&dlDs) {
    const xNames=new Set(xlDs.rows.map(r=>relationKey(r[findMetric(xlDs.headers,'name')])).filter(Boolean));
    const dNames=new Set(dlDs.rows.map(r=>relationKey(r[findMetric(dlDs.headers,'name')])).filter(Boolean));
    const unmatched=[...xNames].filter(n=>n&&!dNames.has(n));
    if(unmatched.length) out.push({type:'warn',text:`Названия Excel без точного совпадения в DataLens: ${unmatched.slice(0,5).join(', ')}${unmatched.length>5?'…':''}. Это надо просмотреть отдельно.`});
  }
  const coreDs=datasetForCore();
  if(dlDs&&coreDs){
    const nm=findMetric(dlDs.headers,'name'), cm=findMetric(coreDs.headers,'name'), ds=findMetric(dlDs.headers,'spend'), cs=findMetric(coreDs.headers,'spend'), dl=findMetric(dlDs.headers,'leads'), cl=findMetric(coreDs.headers,'leads'), dt=findMetric(dlDs.headers,'totalLeads'), ct=findMetric(coreDs.headers,'totalLeads'), di=findMetric(dlDs.headers,'impressions'), ci=findMetric(coreDs.headers,'impressions'), dk=findMetric(dlDs.headers,'clicks'), ck=findMetric(coreDs.headers,'clicks');
    if(nm>=0&&cm>=0){
      const group=(ds,idx)=>{const m=new Map();ds.rows.forEach((r,i)=>{const k=relationKey(r[idx]);if(!k)return;if(!m.has(k))m.set(k,[]);m.get(k).push(r);});return m;};
      const dm=group(dlDs,nm),cmx=group(coreDs,cm), names=[...new Set([...dm.keys(),...cmx.keys()])], flagged=[];
      for(const name of names){const a=dm.get(name)||[],b=cmx.get(name)||[];if(a.length!==1||b.length!==1){if(a.length&&b.length)flagged.push(`${a[0][nm]} — неоднозначное соответствие: DataLens ${a.length} строк, МП ${b.length} строк`);continue;}const da=ds>=0?num(a[0][ds]):null, cb=cs>=0?num(b[0][cs]):null, dlead=dl>=0?num(a[0][dl]):null, clead=cl>=0?num(b[0][cl]):null, dtotal=dt>=0?num(a[0][dt]):null, ctotal=ct>=0?num(b[0][ct]):null, dclick=dk>=0?num(a[0][dk]):null, cclick=ck>=0?num(b[0][ck]):null;let dimp=di>=0?num(a[0][di]):null,cimp=ci>=0?num(b[0][ci]):null;if(dimp!==null&&$('thousand-impressions').checked)dimp/=1000;const why=[];if(da!==null&&cb!==null&&Math.abs(da-cb)>amountToleranceValue())why.push(`сумма Δ ${rub(da-cb)}`);if(dlead!==null&&clead!==null&&dlead!==clead)why.push(`целевые лиды Δ ${whole(dlead-clead)}`);if(dtotal!==null&&ctotal!==null&&dtotal!==ctotal)why.push(`все лиды Δ ${whole(dtotal-ctotal)}`);if(dclick!==null&&cclick!==null&&dclick!==cclick)why.push(`клики Δ ${whole(dclick-cclick)}`);if(dimp!==null&&cimp!==null&&Math.abs(dimp-cimp)>0.001)why.push(`показы Δ ${whole(dimp-cimp)} тыс.`);if(why.length)flagged.push(`${a[0][nm]} — ${why.join(', ')}`);}
      if(flagged.length)out.push({type:'error',text:`Строки DataLens ↔ МП с расхождением: ${flagged.slice(0,6).join('; ')}${flagged.length>6?'…':''}.`});
      const onlyReport=[...dm.keys()].filter(k=>!cmx.has(k));
      if(onlyReport.length)out.push({type:'warn',text:`Строки отчёта без точного названия в МП: ${onlyReport.slice(0,5).map(k=>dm.get(k)[0][nm]).join(', ')}${onlyReport.length>5?'…':''}.`});
      const onlyCore=[...cmx.keys()].filter(k=>!dm.has(k));
      if(onlyCore.length)out.push({type:'warn',text:`Строки МП без точного совпадения в DataLens: ${onlyCore.slice(0,5).map(k=>cmx.get(k)[0][cm]).join(', ')}${onlyCore.length>5?'…':''}.`});
    }
  }
  return out;
}
function renderReportOptions() {
  const el=$('report-options');
  el.innerHTML=reportTables.map((t,i)=>`<button class="table-choice ${selectedReport?.id===t.id?'active':''}" data-i="${i}">Таблица ${i+1} · ${t.rows.length} строк${t.id===selectedReport?.id&&selectedReport?.selectionReason?`<small>${esc(selectedReport.selectionReason)}</small>`:''}<small>${esc(t.frameUrl)}</small></button>`).join('');
  el.querySelectorAll('button').forEach(b=>b.onclick=async()=>{
    const candidate=reportTables[Number(b.dataset.i)];
    try {
      await api('/api/use-report-table',{method:'POST',body:JSON.stringify({id:candidate.id})});
      selectedReport=candidate; renderReportOptions(); showReport(); runAudit(); updateActionButtons();
    } catch(e) { toast(e.message); }
  });
}
function showReport(){ if(selectedReport){const shown=selectedReport.rows.slice(0,101);$('report-preview').innerHTML=miniTable(shown)+(selectedReport.rows.length>101?`<small class="preview-note">Показаны первые 100 строк из ${selectedReport.rows.length}. При переносе учитываются все считанные строки.</small>`:'');} }
function planObjectsForReport(){
  if(!coreTable?.table?.rows?.length)return [];
  const rows=coreTable.table.rows, nameCol=findMetric(rows[0]||[],'name');
  if(nameCol<0)return [];
  return [...new Set(rows.slice(1).map(row=>String(row[nameCol]||'').trim()).filter(name=>name&&!/^(?:итого|всего|total)$/i.test(name)&&!/(?:^|\s)ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(name)))];
}
function planPeriodForReport(){
  const hints=[workbookName,selectedSheet?.name,coreTable?.title,coreTable?.contextText];
  if(selectedSheet){
    const rows=selectedSheet.rows.filter(row=>row.values.some(value=>String(value??'').trim()));
    let headerIndex=rows.findIndex(row=>row.number===Number($('header-row').value));if(headerIndex<0)headerIndex=autoHeader(rows);
    const headers=rows[headerIndex]?.values||[];
    const periodCols=headers.map((header,index)=>/срок|период|дата/.test(ntext(header))?index:-1).filter(index=>index>=0);
    for(const row of rows.slice(headerIndex+1))for(const col of periodCols){const value=row.values[col];if(value)hints.push(value);}
  }
  return inferPlanMonth(hints.filter(Boolean));
}
async function refreshState(){
  try {
    const s=await api('/api/state'); setConnection(s.connected,s.pages);
    $('admin-feedback').hidden = !s.isAdmin;
    $('admin-login-toggle').hidden = !!s.isAdmin;
    if (s.isAdmin) $('admin-login-form').hidden = true;
    if (s.isAdmin && !adminFeedbackLoaded) await loadAdminFeedback();
    if (s.workbook?.length && !sheets.length) {
      sheets=s.workbook; workbookName=s.workbookFileName||'';
      $('file-name').textContent=workbookName||'Книга, загруженная ранее';
      drawSheetSelect();
    }
  }
  catch(e){ toast(e.message); }
}
async function refreshBrowserSnapshot(){
  if(snapshotBusy||!browserPages.some(p=>p.i===activeBrowserPage))return;
  snapshotBusy=true;
  try{
    const s=await api(`/api/browser-snapshot?pageIndex=${activeBrowserPage}`);
    $('browser-image').src=`data:image/jpeg;base64,${s.image}`;$('browser-image').hidden=false;$('browser-empty').hidden=true;
    $('browser-caption').textContent=`${s.title||'Страница'} · ${s.url}`;
    if(JSON.stringify(s.pages)!==JSON.stringify(browserPages))setConnection(true,s.pages);
  }catch(e){$('browser-caption').textContent=e.message}
  finally{snapshotBusy=false;}
}
async function browserAction(action){
  try{await api('/api/browser-action',{method:'POST',body:JSON.stringify({pageIndex:activeBrowserPage,...action})});setTimeout(refreshBrowserSnapshot,220)}catch(e){toast(e.message)}
}
async function pasteIntoBrowser(text){
  if(!text)return;
  try{await api('/api/browser-action',{method:'POST',body:JSON.stringify({pageIndex:activeBrowserPage,action:'text',text})});setTimeout(refreshBrowserSnapshot,220)}catch(e){toast(e.message)}
}
function refreshSheetHeader(){
  if(!selectedSheet)return;
  const rows=selectedSheet.rows.filter(r=>r.values.some(v=>String(v).trim()));
  let h=rows.findIndex(r=>r.number===Number($('header-row').value));if(h<0)h=autoHeader(rows);
  $('excel-preview').innerHTML=miniTable(rows.slice(Math.max(0,h-1),h+7).map(r=>r.values));
  runAudit();
}

$('connect').onclick=async()=>{ $('connect').disabled=true; $('connect').textContent='Подключаю…'; try{const r=await api('/api/connect',{method:'POST',body:'{}'});activeBrowserPage=r.activePage;setConnection(true,r.pages);toast(r.message);}catch(e){toast(e.message);}finally{$('connect').disabled=false;$('connect').innerHTML='<span class="icon">↗</span> Подключить браузер';} };
$('file').onchange=async e=>{const f=e.target.files[0];if(!f)return;workbookName=f.name;$('file-name').textContent=f.name;try{const r=await api('/api/workbook',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(f.name)},body:await f.arrayBuffer()});sheets=r.sheets;drawSheetSelect();toast(`Excel прочитан: ${sheets.length} листов`);}catch(err){toast(err.message);} };
$('sheet').onchange=()=>loadSheet(Number($('sheet').value));
$('header-row').onchange=refreshSheetHeader;
const dz=$('dropzone');for(const ev of ['dragenter','dragover'])dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag')});for(const ev of ['dragleave','drop'])dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag')});dz.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f){$('file').files=e.dataTransfer.files;$('file').dispatchEvent(new Event('change'));}});
$('open-plan').onclick=async()=>{try{const r=await api('/api/open-plan',{method:'POST',body:JSON.stringify({url:$('plan-url').value,pageIndex:activeBrowserPage})});activeBrowserPage=r.activePage;setConnection(true,r.pages);$('core-page').value=String(r.activePage);toast('Указанный МП открыт во встроенной вкладке');}catch(e){toast(e.message);}};
$('browser-page').onchange=()=>{activeBrowserPage=Number($('browser-page').value);refreshBrowserSnapshot();};
$('browser-new-tab').onclick=async()=>{try{const r=await api('/api/new-tab',{method:'POST',body:'{}'});activeBrowserPage=r.activePage;setConnection(true,r.pages);refreshBrowserSnapshot();}catch(e){toast(e.message);}};
$('open-report').onclick=async()=>{try{const r=await api('/api/browser-open',{method:'POST',body:JSON.stringify({url:$('report-url').value,pageIndex:activeBrowserPage})});activeBrowserPage=r.activePage;setConnection(true,r.pages);refreshBrowserSnapshot();toast('Открыта указанная ссылка отчёта');}catch(e){toast(e.message);}};
$('report-url').onkeydown=e=>{if(e.key==='Enter')$('open-report').click()};
$('browser-viewport').addEventListener('click',e=>{if(e.target!==$('browser-image'))return;const image=$('browser-image'),r=image.getBoundingClientRect();browserAction({action:'click',x:(e.clientX-r.left)*(image.naturalWidth||1440)/r.width,y:(e.clientY-r.top)*(image.naturalHeight||1000)/r.height});$('browser-viewport').focus()});
$('browser-viewport').addEventListener('wheel',e=>{if(e.target===$('browser-image')){e.preventDefault();const image=$('browser-image'),r=image.getBoundingClientRect();browserAction({action:'wheel',x:(image.naturalWidth||1440)/2,y:(image.naturalHeight||1000)/2,deltaY:e.deltaY*(image.naturalHeight||1000)/Math.max(1,r.height)})}},{passive:false});
$('browser-viewport').addEventListener('paste',e=>{const text=e.clipboardData?.getData('text/plain')||'';if(text){e.preventDefault();pasteIntoBrowser(text)}});
$('browser-viewport').addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v'){
    // Read the system clipboard directly during the user's key gesture. The remote
    // page is only a screenshot, so its password field cannot receive native paste.
    e.preventDefault();
    if(!navigator.clipboard?.readText){toast('Вставка недоступна: разреши чтение буфера обмена для meiplan.ru и повтори Ctrl+V.');return;}
    navigator.clipboard.readText().then(text=>{
      if(text)pasteIntoBrowser(text);
      else toast('Буфер обмена пуст.');
    }).catch(()=>toast('Браузер запретил чтение буфера. Разреши доступ к буферу обмена для meiplan.ru и повтори Ctrl+V.'));
    return;
  }
  if(e.ctrlKey||e.altKey||e.metaKey)return;
  if(e.key.length===1||['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown',' '].includes(e.key)){e.preventDefault();browserAction({action:'key',key:e.key})}
});
$('read-plan').onclick=async()=>{try{coreTable=await api('/api/read-plan',{method:'POST',body:JSON.stringify({pageIndex:Number($('core-page').value)})});$('plan-preview').innerHTML=miniTable(coreTable.table.rows);runAudit();updateActionButtons();toast(`Считал таблицу Core: ${coreTable.table.rows.length} строк`);}catch(e){toast(e.message);}};
$('core-page').onchange=()=>{activeBrowserPage=Number($('core-page').value);$('browser-page').value=String(activeBrowserPage);refreshBrowserSnapshot();};
$('capture').onclick=async()=>{try{const period=planPeriodForReport(),r=await api('/api/capture',{method:'POST',body:JSON.stringify({pageIndex:activeBrowserPage,period,expectedObjects:planObjectsForReport()})});reportTables=r.candidates;selectedReport=reportTables.find(t=>t.id===r.selectedId)||null;if(selectedReport)selectedReport.selectionReason=r.selectionReason||'';renderReportOptions();showReport();runAudit();updateActionButtons();const notices=[r.selectionReason,...(r.preparation||[])].filter(Boolean);if(!period)notices.unshift('Не удалось определить месяц МП — проверь период DataLens вручную.');toast(notices.join(' · ')||'Выбери таблицу DataLens вручную.');}catch(e){toast(e.message);}};
$('prepare-plan').onclick=()=>showProposal('plan');
$('prepare-fact').onclick=()=>showProposal('fact');
$('feedback-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),status=$('feedback-status');
  const data=new FormData(form),files=data.getAll('attachments').filter(file=>file instanceof File&&file.size>0),total=files.reduce((sum,file)=>sum+file.size,0);
  if(files.length>5||files.some(file=>file.size>10*1024*1024)||total>20*1024*1024){status.textContent='Можно прикрепить до 5 файлов: каждый до 10 МБ, всего до 20 МБ.';return;}
  button.disabled=true;status.textContent='Отправляю…';
  try{const result=await api('/api/feedback',{method:'POST',body:data});form.reset();status.textContent=result.message;}
  catch(error){status.textContent=error.message;}
  finally{button.disabled=false;}
});
$('admin-login-toggle').addEventListener('click',()=>{
  const form=$('admin-login-form');form.hidden=!form.hidden;
  if(!form.hidden)form.querySelector('[name="username"]').focus();
});
$('admin-login-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),status=$('admin-login-status');
  const data=new FormData(form);button.disabled=true;status.textContent='Проверяю учётную запись…';
  try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({username:data.get('username'),password:data.get('password')})});form.reset();form.hidden=true;adminFeedbackLoaded=false;await refreshState();}
  catch(error){status.textContent=error.message;}
  finally{form.elements.password.value='';button.disabled=false;}
});
$('refresh-feedback').addEventListener('click', loadAdminFeedback);
$('admin-feedback-list').addEventListener('click',async event=>{
  const button=event.target.closest('[data-feedback-file]');if(!button)return;
  button.disabled=true;
  try{
    const query=new URLSearchParams({item:button.dataset.feedbackItem,file:button.dataset.feedbackFile});
    const response=await fetch(`/api/admin/feedback-file?${query}`,{headers:{'X-AGM-Token':token}});
    if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error||`Ошибка ${response.status}`);}
    const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=button.dataset.feedbackName||'attachment';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){toast(error.message);}
  finally{button.disabled=false;}
});
$('admin-logout').addEventListener('click',async()=>{
  try{await api('/api/admin/logout',{method:'POST',body:'{}'});adminFeedbackLoaded=false;$('admin-feedback').hidden=true;$('admin-login-toggle').hidden=false;$('admin-login-form').hidden=true;}
  catch(error){toast(error.message);}
});
['exact-leads','thousand-impressions','skip-excluded'].forEach(id=>$(id).addEventListener('change',runAudit));
$('amount-tolerance').addEventListener('input',runAudit);
$('amount-tolerance').addEventListener('change',()=>{normalizeAmountTolerance();runAudit();});
refreshState();
setInterval(refreshState, 4000);
setInterval(refreshBrowserSnapshot, 1300);
window.addEventListener('pagehide', () => {
  fetch('/api/disconnect', { method: 'POST', headers: { 'X-AGM-Token': token, 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', keepalive: true }).catch(() => {});
});
