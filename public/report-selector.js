const norm = value => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const relation = value => norm(value).replace(/^лср\s+/, '').replace(/\bлейк\b/g, 'lake');
const excluded = value => /ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(value);
const asciiAliases = new Map([
  ['измайловский', ['izmajlovskij', 'izmaylovskij', 'izmaylovskiy', 'izmailovskiy', 'izmailovskij']],
  ['лейк', ['lake', 'leik']]
]);
const transliterate = value => {
  const map = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
  return [...norm(value)].map(character => map[character] ?? character).join('');
};

export function promotionColumn(headers) {
  const normalized = headers.map(norm);
  const priorities = [
    header => header === 'объект продвижения',
    header => /назван.*(?:кампан|объект)|^кампания$/.test(header),
    header => /^(?:utm ?source|utmsource)$/.test(header)
  ];
  for (let priority = 0; priority < priorities.length; priority++) {
    const found = normalized.map((header, index) => priorities[priority](header) ? index : -1).filter(index => index >= 0);
    if (found.length) return found.length === 1 ? { index: found[0], kind: priority === 0 ? 'object' : 'campaign' } : { index: -1, kind: 'ambiguous' };
  }
  return { index: -1, kind: 'missing' };
}

/** Resolve a DataLens object name or campaign/UTM slug to one exact MP description. */
export function matchPromotionName(source, expectedObjects, kind = 'object') {
  const sourceKey = relation(source);
  const expected = [...new Set(expectedObjects.map(value => String(value ?? '').trim()).filter(Boolean))];
  const exact = expected.filter(value => relation(value) === sourceKey);
  if (exact.length === 1) return { value: exact[0], status: 'matched' };
  if (exact.length > 1) return { value: null, status: 'ambiguous', candidates: exact };
  if (kind !== 'campaign' || !sourceKey) return { value: null, status: 'missing', candidates: [] };
  const campaignKey = transliterate(sourceKey);
  const matches = expected.filter(value => {
    const name = relation(value);
    const aliases = [transliterate(name), ...(asciiAliases.get(name) || [])].filter(Boolean);
    const campaignText = ` ${campaignKey.replace(/[-]+/g, ' ')} `;
    return aliases.some(alias => campaignText.includes(` ${alias.toLocaleLowerCase('ru-RU').replace(/[-]+/g, ' ').trim()} `));
  });
  return matches.length === 1
    ? { value: matches[0], status: 'matched' }
    : { value: null, status: matches.length ? 'ambiguous' : 'missing', candidates: matches };
}

const metricRules = [
  ['spend', /расход|стоимост|бюджет/],
  ['impressions', /показ/],
  ['clicks', /клик/],
  ['ctr', /^ctr\b|^cr1\b/],
  ['cr2', /^cr2\b/],
  ['cr3', /^cr3\b/],
  ['allLeads', /все лид|валов.*лид|^лиды\b/],
  ['targetLeads', /целев.*лид|^цо\b/]
];

/** Rank visible DataLens tables by their schema and the exact Core row names. */
export function rankFactTables(candidates, expectedObjects = []) {
  const expected = [...new Set(expectedObjects.map(relation).filter(Boolean))];
  const ranked = (Array.isArray(candidates) ? candidates : []).map(candidate => {
    const rows = Array.isArray(candidate.rows) ? candidate.rows : [];
    const headers = (rows[0] || []).map(norm);
    const promotion = promotionColumn(headers);
    const nameColumn = promotion.index;
    const metrics = [...new Set(headers.flatMap(header => metricRules.filter(([, rule]) => rule.test(header)).map(([key]) => key)))];
    const names = rows.slice(1).map(row => String(row?.[nameColumn] ?? '')).filter(name => name && !excluded(name));
    const resolved = names.map(name => matchPromotionName(name, expectedObjects, promotion.kind));
    const matches = [...new Set(resolved.filter(result => result.status === 'matched').map(result => relation(result.value)))];
    const compatible = nameColumn >= 0 && metrics.length >= 2 && rows.length > 1;
    const score = compatible ? matches.length * 100 + metrics.length * 5 + (promotion.kind === 'object' ? 10 : 0) + (nameColumn === 0 ? 2 : 0) : -1;
    return { ...candidate, nameColumn, nameKind: promotion.kind, metricKeys: metrics, matchedObjects: matches.length, expectedObjects: expected.length, compatible, score };
  });
  const eligible = ranked.filter(candidate => candidate.compatible);
  eligible.sort((a, b) => b.score - a.score);
  const first = eligible[0], second = eligible[1];
  const uniqueBest = !!first && (!second || first.score > second.score);
  const recommendedId = uniqueBest && (first.matchedObjects > 0 || (first.nameKind === 'object' && expected.length === 0 && eligible.length === 1)) ? first.id : null;
  return {
    candidates: ranked,
    recommendedId,
    reason: recommendedId
      ? first.matchedObjects
        ? `Автоматически выбрана таблица: совпали ${first.matchedObjects} из ${first.expectedObjects} названий МП; найдены показатели ${first.metricKeys.join(', ')}.`
        : `Найдена единственная таблица с полем объекта/кампании и показателями ${first.metricKeys.join(', ')}.`
      : eligible.length
        ? 'Нашёл несколько похожих таблиц DataLens, но не смог доказать, какая соответствует объектам МП. Выбери таблицу вручную.'
        : 'Не нашёл таблицу с полем «Объект продвижения», «Название кампании» или UTMSource и метриками факта.'
  };
}

/** Infer a full calendar month only from explicit plan text or service dates. */
export function inferPlanMonth(values = []) {
  const months = [
    ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4], ['ма[йя]', 5], ['июн', 6],
    ['июл', 7], ['август', 8], ['сентябр', 9], ['октябр', 10], ['ноябр', 11], ['декабр', 12]
  ];
  const text = values.map(value => String(value ?? '')).join(' ');
  const found = new Set();
  for (const [stem, month] of months) {
    const match = text.match(new RegExp(`${stem}[\\p{L}]*[\\s_-]+(20\\d{2})`, 'iu'));
    if (match) found.add(`${match[1]}-${String(month).padStart(2, '0')}`);
  }
  const dates = [...text.matchAll(/(\d{1,2})[./-](\d{1,2})[./-](20\d{2})/g)];
  for (const [, , month, year] of dates) found.add(`${year}-${month.padStart(2, '0')}`);
  if (found.size !== 1) return null;
  const [yearText, monthText] = [...found][0].split('-');
  const year = Number(yearText), month = Number(monthText);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `01.${monthText}.${yearText}`, end: `${String(lastDay).padStart(2, '0')}.${monthText}.${yearText}` };
}
