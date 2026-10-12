import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SMARTIS_CONFIG = JSON.parse(fs.readFileSync(path.join(here, 'sources.json'), 'utf8'));

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const asText = value => value == null ? '' : String(value).trim();

function locateHeader(rows) {
  const vk = SMARTIS_CONFIG.sources.vk.columns;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 40); rowIndex++) {
    const headers = (rows[rowIndex]?.values || []).map(normalize);
    const has = aliases => aliases.some(alias => headers.includes(normalize(alias)));
    const core = ['personId', 'leadType', 'createdAt', 'contact', 'platform', 'campaign', 'property', 'propertyType'];
    const count = core.filter(key => has(vk[key])).length;
    if (count >= 7 && has(vk.personId) && has(vk.platform)) return { rowIndex, headers };
  }
  throw new Error('Не нашёл строку заголовков Smartis: нужны Smartis Person ID и Площадка с остальными полями выгрузки.');
}

function columnIndex(headers, aliases, field, required) {
  const wanted = new Set(aliases.map(normalize));
  const found = headers.map((header, index) => wanted.has(header) ? index : -1).filter(index => index >= 0);
  if (found.length > 1) throw new Error(`Структура Excel неоднозначна: поле «${field}» найдено в нескольких колонках.`);
  if (!found.length && required) throw new Error(`Выгрузка не содержит обязательную колонку «${field}».`);
  return found[0] ?? -1;
}

function parseExcelDate(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 90000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear()).slice(-2)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }
  return asText(value);
}

export function normalizeContact(value) {
  const raw = asText(value);
  if (!raw) return { value: '', state: 'empty', warning: 'Контакт отсутствует.' };
  const candidates = raw.split(/[;,\n]+/).map(part => part.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const match = candidate.match(/\+?\d[\d\s().-]{7,}\d/);
    if (!match) continue;
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return { value: digits, state: 'phone', warning: '' };
  }
  return { value: raw, state: 'unrecognized', warning: 'Контакт не распознан как телефон; исходное значение сохранено для проверки.' };
}

export function detectSource(platform) {
  const value = normalize(platform);
  if (!value) return { id: null, title: 'Неизвестный источник' };
  for (const [id, source] of Object.entries(SMARTIS_CONFIG.sources)) {
    if (source.platformAliases?.some(alias => value.includes(normalize(alias)))) return { id, title: source.title };
  }
  if (/\b(?:urban|урбан)\b/.test(value)) return { id: 'urban-ads', title: SMARTIS_CONFIG.sources['urban-ads'].title };
  if (/\b(?:rtb|ртб)\b/.test(value)) return { id: 'yandex-rtb', title: SMARTIS_CONFIG.sources['yandex-rtb'].title };
  if (/\b(?:map|maps|карты)\b/.test(value)) return { id: 'yandex-maps', title: SMARTIS_CONFIG.sources['yandex-maps'].title };
  return { id: null, title: 'Неизвестный источник' };
}

export function prepareSmartisRows(sheet, { manualSource = 'auto' } = {}) {
  if (!sheet || !Array.isArray(sheet.rows)) throw new Error('Сначала загрузи выгрузку Smartis.');
  const { rowIndex: headerRowIndex, headers } = locateHeader(sheet.rows);
  const config = SMARTIS_CONFIG.sources.vk;
  const col = Object.fromEntries(Object.entries(config.columns).map(([key, aliases]) => [key, columnIndex(headers, aliases, key, !['rejectionReason', 'postView'].includes(key) && !(key === 'contact' && config.contactOptional))]));
  const rawRecords = [];
  let inputRowCount = 0, missingPersonIdRows = 0;
  for (const row of sheet.rows.slice(headerRowIndex + 1)) {
    const values = row.values || [];
    if (!values.some(value => String(value ?? '').trim())) continue;
    inputRowCount++;
    const at = key => col[key] < 0 ? '' : asText(values[col[key]]);
    const personId = at('personId').replace(/\.0$/, '');
    if (!personId) { missingPersonIdRows++; continue; }
    const detected = detectSource(at('platform'));
    const source = detected.id || (manualSource === 'vk' ? 'vk' : null);
    const warnings = [];
    if (!detected.id && manualSource === 'vk') warnings.push('Площадку вручную отнесли к VK; приложение не распознало её автоматически.');
    else if (!detected.id && !source) warnings.push('Неизвестная площадка: строка не относится к VK автоматически.');
    if (detected.id && detected.id !== 'vk') warnings.push(`Источник «${detected.title}» не поддерживается в MVP и пропущен без преобразования по правилам VK.`);
    const contact = normalizeContact(at('contact'));
    if (contact.warning) warnings.push(contact.warning);
    const lead = {
      personId,
      leadType: at('leadType'),
      createdAt: parseExcelDate(values[col.createdAt]),
      contact: contact.value,
      channel: config.channelValue,
      platform: at('platform'),
      campaign: at('campaign'),
      propertyType: at('propertyType'),
      property: at('property'),
      rejectionReason: at('rejectionReason'),
      postView: col.postView >= 0 && config.postViewHeaders?.length ? (at('postView') === '1' ? '1' : '') : '',
      source: source || detected.id,
      sourceTitle: detected.title,
      sourceRow: row.number || headerRowIndex + inputRowCount + 1,
      warnings
    };
    const missing = [['leadType', lead.leadType], ['createdAt', lead.createdAt], ['platform', lead.platform], ['campaign', lead.campaign], ['propertyType', lead.propertyType], ['property', lead.property]];
    for (const [name, value] of missing) if (!value) lead.warnings.push(`В исходной строке пустое поле «${name}».`);
    rawRecords.push(lead);
  }
  if (!rawRecords.length) throw new Error('В книге нет строк с заполненным Smartis Person ID.');

  const groups = new Map();
  for (const lead of rawRecords) {
    if (!groups.has(lead.personId)) groups.set(lead.personId, []);
    groups.get(lead.personId).push(lead);
  }
  const records = [], duplicateIds = [], conflictingIds = [], ignored = [];
  for (const [personId, group] of groups) {
    const crossSource = new Set(group.map(item => item.source || `unknown:${item.platform}`)).size > 1;
    const uniqueRecords = new Map(group.map(item => [JSON.stringify({ ...item, sourceRow: undefined, warnings: [] }), item]));
    if (group.length > 1) duplicateIds.push({ personId, count: group.length, conflicting: uniqueRecords.size > 1 || crossSource });
    if (uniqueRecords.size > 1 || crossSource) {
      conflictingIds.push(personId);
      for (const item of group) ignored.push({ personId, source: item.sourceTitle, sourceRow: item.sourceRow, reason: 'Один Smartis Person ID имеет разные данные в выгрузке; автоматическую запись заблокировал.' });
      continue;
    }
    const item = group[0];
    if (item.source !== 'vk') { ignored.push({ personId, source: item.sourceTitle, sourceRow: item.sourceRow, reason: item.warnings.join(' ') || 'Источник не поддерживается.' }); continue; }
    records.push(item);
  }
  return {
    sourceRows: inputRowCount,
    missingPersonIdRows,
    records,
    duplicateIds,
    conflictingIds,
    ignored,
    headerRow: sheet.rows[headerRowIndex]?.number || headerRowIndex + 1,
    warnings: records.flatMap(record => record.warnings.map(warning => ({ personId: record.personId, sourceRow: record.sourceRow, warning })))
  };
}

export function rowsForTarget(leads) {
  return leads.map(lead => [lead.personId, lead.leadType, lead.createdAt, lead.contact, lead.channel, lead.platform, lead.campaign, lead.propertyType, lead.property, lead.rejectionReason, lead.postView]);
}

export function reconcileSmartis(source, targetRows) {
  const existing = new Map();
  for (let index = 1; index < targetRows.length; index++) {
    const row = targetRows[index] || [];
    const id = asText(row[0]).replace(/\.0$/, '');
    if (!id) continue;
    if (!existing.has(id)) existing.set(id, []);
    existing.get(id).push(row.slice(0, 11).map(asText));
  }
  const additions = [], existingIds = [], existingMismatchIds = [];
  for (const lead of source.records) {
    const found = existing.get(lead.personId);
    if (!found) { additions.push(lead); continue; }
    existingIds.push(lead.personId);
    const expected = rowsForTarget([lead])[0];
    if (!found.some(row => expected.every((value, i) => !value || asText(row[i]) === asText(value)))) existingMismatchIds.push(lead.personId);
  }
  const duplicatedTarget = [...existing.entries()].filter(([, rows]) => rows.length > 1).map(([personId, rows]) => ({ personId, count: rows.length }));
  return { additions, existingIds, existingMismatchIds, duplicatedTarget, targetIds: [...existing.keys()], currentRowCount: targetRows.length };
}

export function summarizeLead(lead) {
  return { personId: lead.personId, leadType: lead.leadType, createdAt: lead.createdAt, contact: lead.contact, channel: lead.channel, platform: lead.platform, campaign: lead.campaign, propertyType: lead.propertyType, property: lead.property, rejectionReason: lead.rejectionReason, postView: lead.postView, sourceRow: lead.sourceRow, warnings: lead.warnings };
}
