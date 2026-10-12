import crypto from 'node:crypto';

const OAUTH_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value !== '') || rows.length) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function safeId(value) {
  const match = String(value || '').match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(String(value || ''))) return String(value);
  throw new Error('Укажи ссылку docs.google.com/spreadsheets/d/… или Spreadsheet ID.');
}

function safeSheetTitle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function createGoogleSheetsService({ clientId = '', clientSecret = '', publicOrigin = '', serviceAccountEmail = '', serviceAccountPrivateKey = '', publicTarget = null } = {}) {
  const userOAuthConfigured = Boolean(clientId && clientSecret && /^https:\/\//i.test(publicOrigin));
  const privateKey = String(serviceAccountPrivateKey || '').replace(/\\n/g, '\n');
  const serviceAccountConfigured = Boolean(serviceAccountEmail && privateKey.includes('PRIVATE KEY'));
  const configured = serviceAccountConfigured || userOAuthConfigured;
  const authMode = serviceAccountConfigured ? 'service_account' : userOAuthConfigured ? 'user_oauth' : 'not_configured';
  const callbackUrl = userOAuthConfigured ? `${publicOrigin.replace(/\/$/, '')}/api/smartis/google/callback` : '';
  const flows = new Map();
  let bridgeUrl = '';
  let bridgeSecret = '';
  let serviceToken = null;
  let serviceTokenExpiresAt = 0;
  let serviceTokenPromise = null;

  async function publicValues(spreadsheetId, sheetId, sheetTitle) {
    if (!publicTarget || spreadsheetId !== publicTarget.spreadsheetId || Number(sheetId) !== Number(publicTarget.sheetId) || sheetTitle !== publicTarget.sheetTitle) {
      throw new Error('По публичной ссылке разрешено читать только лист «Лиды Смартис» стандартной таблицы.');
    }
    const url = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export`);
    url.searchParams.set('format', 'csv');
    url.searchParams.set('gid', String(sheetId));
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 MeiPlan/1.0' }, signal: AbortSignal.timeout(25_000), redirect: 'follow' });
    if (!response.ok) throw new Error(`Таблица недоступна по ссылке (HTTP ${response.status}). Проверь, что просмотр открыт по ссылке.`);
    if (!/text\/csv/i.test(response.headers.get('content-type') || '')) throw new Error('Google не отдал таблицу как CSV. Проверь доступ «Все, у кого есть ссылка — просмотр».');
    const csv = await response.text();
    if (csv.length > 25 * 1024 * 1024) throw new Error('Таблица слишком велика для безопасной проверки по ссылке.');
    const rows = parseCsv(csv).map(row => Array.from({ length: 11 }, (_, index) => row[index] ?? ''));
    if (!rows.length || !/person.?id|смарт.?ис/i.test(rows[0][0] || '')) throw new Error('Скачанный CSV не похож на лист «Лиды Смартис»: заголовок Person ID не найден.');
    return rows;
  }

  async function getServiceAccountToken() {
    if (!serviceAccountConfigured) throw new Error('Сервисный аккаунт Google ещё не настроен администратором приложения.');
    if (serviceToken && serviceTokenExpiresAt > Date.now() + 60_000) return serviceToken;
    if (serviceTokenPromise) return serviceTokenPromise;
    serviceTokenPromise = (async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: serviceAccountEmail, scope: SCOPES.join(' '), aud: OAUTH_ENDPOINT, iat: issuedAt, exp: issuedAt + 3600 })}`;
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(unsigned);
      signer.end();
      const assertion = `${unsigned}.${signer.sign(privateKey, 'base64url')}`;
      const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
      const response = await fetch(OAUTH_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Не удалось получить токен сервисного аккаунта Google (HTTP ${response.status}).`);
      const token = await response.json();
      if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw new Error('Google вернул неполный ответ авторизации сервисного аккаунта.');
      serviceToken = token.access_token;
      serviceTokenExpiresAt = Date.now() + Math.max(60, Number(token.expires_in) || 3600) * 1000;
      return serviceToken;
    })();
    try { return await serviceTokenPromise; }
    finally { serviceTokenPromise = null; }
  }

  function configureAppsScript(url, secret) {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(parsed.pathname)) throw new Error('Укажи URL развёрнутого Apps Script вида https://script.google.com/macros/s/…/exec.');
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512) throw new Error('Общий ключ должен содержать не менее 32 символов.');
    bridgeUrl = parsed.toString();
    bridgeSecret = secret;
  }

  async function bridgeRequest(action, args = {}) {
    if (!bridgeUrl || !bridgeSecret) throw new Error('Apps Script не подключён администратором.');
    const response = await fetch(bridgeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: bridgeSecret, action, ...args }), signal: AbortSignal.timeout(40_000), redirect: 'follow' });
    if (!response.ok) throw new Error(`Apps Script вернул HTTP ${response.status}.`);
    let data;
    try { data = await response.json(); } catch { throw new Error('Apps Script вернул пустой или неверный ответ. Проверь URL веб-приложения и его доступность.'); }
    if (data?.ok === false) throw new Error(String(data.error || 'Apps Script отклонил запрос.'));
    return data;
  }

  function begin(session) {
    if (bridgeUrl && bridgeSecret) throw new Error('Google Sheets подключён через Apps Script; отдельный Google-вход не нужен.');
    if (serviceAccountConfigured) throw new Error('Google Sheets подключён сервисным аккаунтом приложения.');
    if (!userOAuthConfigured) throw new Error('Подключение Google ещё не настроено администратором приложения.');
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    flows.set(state, { session, verifier, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async function callback(params) {
    const stateKey = params.get('state') || '';
    const flow = flows.get(stateKey);
    if (!flow) throw new Error('Ссылка входа Google устарела. Начни подключение заново.');
    try {
      if (flow.expiresAt < Date.now()) throw new Error('Ссылка входа Google устарела. Начни подключение заново.');
      if (params.has('error')) throw new Error('Google не завершил подключение. Вернись в приложение и повтори вход.');
      const code = params.get('code');
      if (!code) throw new Error('Google не вернул код авторизации. Повтори подключение.');
      const form = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: callbackUrl, grant_type: 'authorization_code', code_verifier: flow.verifier });
      const response = await fetch(OAUTH_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Не удалось получить токен Google (HTTP ${response.status}).`);
      const token = await response.json();
      if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw new Error('Google вернул неполный ответ авторизации.');
      flow.session.googleAuth = { accessToken: token.access_token, refreshToken: token.refresh_token || null, expiresAt: Date.now() + Math.max(60, Number(token.expires_in) || 3600) * 1000 };
      flow.session.googleError = null;
      return flow.session;
    } catch (error) {
      flow.session.googleError = error?.message || 'Подключение Google не завершено.';
      throw error;
    } finally { flows.delete(stateKey); }
  }

  function setCallbackError(params, message) {
    const flow = flows.get(params.get('state') || '');
    if (flow) { flow.session.googleError = String(message || 'Подключение Google не завершено.'); flows.delete(params.get('state')); }
  }
  function disconnect(session) {
    session.googleAuth = null;
    session.googleError = null;
    for (const [key, flow] of flows) if (flow.session === session) flows.delete(key);
  }

  async function accessToken(session) {
    if (bridgeUrl && bridgeSecret) throw new Error('Google Sheets подключён через Apps Script.');
    if (serviceAccountConfigured) return getServiceAccountToken();
    if (!userOAuthConfigured) throw new Error('Подключение Google ещё не настроено администратором приложения.');
    const auth = session.googleAuth;
    if (!auth) throw new Error('Сначала подключи Google во вкладке Smartis.');
    if (auth.expiresAt > Date.now() + 60_000) return auth.accessToken;
    if (!auth.refreshToken) throw new Error('Сеанс Google истёк. Подключи Google заново.');
    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: auth.refreshToken, grant_type: 'refresh_token' });
    const response = await fetch(OAUTH_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { session.googleAuth = null; throw new Error(`Сеанс Google истёк или отозван (HTTP ${response.status}); подключи аккаунт снова.`); }
    const token = await response.json();
    session.googleAuth = { ...auth, accessToken: token.access_token, expiresAt: Date.now() + Math.max(60, Number(token.expires_in) || 3600) * 1000 };
    return session.googleAuth.accessToken;
  }

  async function request(session, url, options = {}) {
    const send = token => fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    let response = await send(await accessToken(session));
    if (response.status === 401 && session.googleAuth?.refreshToken) {
      session.googleAuth.expiresAt = 0;
      response = await send(await accessToken(session));
    } else if (response.status === 401 && serviceAccountConfigured) {
      serviceToken = null;
      serviceTokenExpiresAt = 0;
      response = await send(await getServiceAccountToken());
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`Google Sheets API отказала в доступе (HTTP ${response.status}). Проверь доступ аккаунта к таблице и разрешение Google.`);
      if (response.status === 404) throw new Error('Google-таблица или лист не найдены. Проверь ссылку и доступ.');
      throw new Error(`Google Sheets API вернула HTTP ${response.status}. Данные не считаются успешно перенесёнными.`);
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    get configured() { return Boolean((bridgeUrl && bridgeSecret) || serviceAccountConfigured || userOAuthConfigured); },
    get authMode() { return bridgeUrl && bridgeSecret ? 'apps_script' : authMode; },
    get publicCsvAvailable() { return Boolean(publicTarget?.spreadsheetId && publicTarget?.sheetId && publicTarget?.sheetTitle); },
    serviceAccountEmail,
    get appsScriptUrl() { return bridgeUrl; },
    configureAppsScript,
    callbackUrl,
    begin,
    callback,
    setCallbackError,
    disconnect,
    hasSession: session => Boolean((bridgeUrl && bridgeSecret) || serviceAccountConfigured || session.googleAuth?.accessToken),
    hasReadAccess: session => Boolean((bridgeUrl && bridgeSecret) || serviceAccountConfigured || session.googleAuth?.accessToken || (publicTarget?.spreadsheetId && publicTarget?.sheetId && publicTarget?.sheetTitle)),
    hasWriteAccess: session => Boolean((bridgeUrl && bridgeSecret) || serviceAccountConfigured || session.googleAuth?.accessToken),
    spreadsheetId: safeId,
    async metadata(session, value) {
      const id = safeId(value);
      if (bridgeUrl && bridgeSecret) return bridgeRequest('metadata', { spreadsheetId: id });
      if (!hasCredentials(session) && publicTarget?.spreadsheetId === id) {
        const rows = await publicValues(id, publicTarget.sheetId, publicTarget.sheetTitle);
        return { spreadsheetId: id, title: 'Копия ЛСР // Накопительный отчет // 2025', sheets: [{ sheetId: publicTarget.sheetId, title: publicTarget.sheetTitle, index: 0, rowCount: rows.length, columnCount: 11 }] };
      }
      const url = new URL(`${SHEETS_API}/${encodeURIComponent(id)}`);
      url.searchParams.set('fields', 'spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))');
      const data = await request(session, url);
      return { spreadsheetId: data.spreadsheetId, title: data.properties?.title || '', sheets: (data.sheets || []).map(item => ({ sheetId: item.properties.sheetId, title: item.properties.title, index: item.properties.index, rowCount: item.properties.gridProperties?.rowCount || 0, columnCount: item.properties.gridProperties?.columnCount || 0 })) };
    },
    async values(session, spreadsheetId, sheetTitle) {
      const id = safeId(spreadsheetId), range = `${safeSheetTitle(sheetTitle)}!A:K`;
      if (bridgeUrl && bridgeSecret) {
        const data = await bridgeRequest('values', { spreadsheetId: id, sheetTitle });
        return (data.values || []).map(row => Array.from({ length: 11 }, (_, index) => row[index] == null ? '' : String(row[index])));
      }
      if (!hasCredentials(session) && publicTarget?.spreadsheetId === id) return publicValues(id, publicTarget.sheetId, sheetTitle);
      const url = new URL(`${SHEETS_API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`);
      url.searchParams.set('majorDimension', 'ROWS');
      url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
      const data = await request(session, url);
      return (data.values || []).map(row => Array.from({ length: 11 }, (_, index) => row[index] == null ? '' : String(row[index])));
    },
    async formats(session, spreadsheetId, sheetId, sheetTitle, startRowIndex, endRowIndex) {
      const id = safeId(spreadsheetId), range = `${safeSheetTitle(sheetTitle)}!A${startRowIndex + 1}:K${endRowIndex}`;
      if (bridgeUrl && bridgeSecret) return bridgeRequest('formats', { spreadsheetId: id, sheetId, sheetTitle, startRowIndex, endRowIndex });
      const url = new URL(`${SHEETS_API}/${encodeURIComponent(id)}`);
      url.searchParams.set('includeGridData', 'true');
      url.searchParams.set('ranges', range);
      url.searchParams.set('fields', 'sheets(data(rowData(values(userEnteredFormat(numberFormat,textFormat,backgroundColor,wrapStrategy,horizontalAlignment,verticalAlignment)))))');
      const data = await request(session, url);
      return (data.sheets?.[0]?.data?.[0]?.rowData || []).map(row => Array.from({ length: 11 }, (_, index) => row.values?.[index]?.userEnteredFormat || {}));
    },
    async batchUpdate(session, spreadsheetId, requests) {
      if (!hasCredentials(session) && !bridgeUrl) throw new Error('Таблица открыта только для чтения. Скопируй подготовленные строки и вставь их в Google Sheets вручную.');
      if (bridgeUrl && bridgeSecret) return bridgeRequest('batchUpdate', { spreadsheetId: safeId(spreadsheetId), requests });
      const url = `${SHEETS_API}/${encodeURIComponent(safeId(spreadsheetId))}:batchUpdate`;
      return request(session, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) });
    }
  };

  function hasCredentials(session) { return Boolean((bridgeUrl && bridgeSecret) || serviceAccountConfigured || session.googleAuth?.accessToken); }
}
