const normalized = value => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const calculationToken = value => String(value ?? '').trim().toLowerCase().replace(/[сра]/g, character => ({ 'с': 'c', 'р': 'p', 'а': 'a' })[character] || character);
const supportedModels = new Set(['CPC', 'CPM', 'CPL', 'CPA', 'FIX', 'STATIC']);

export function isManualEntryHeader(header) {
  const value = normalized(header);
  return /(?:^| )ак(?: |$)/.test(value)
    || /агентск.*(?:комисс|вознагражд)|(?:комисс|вознагражд).*агентск/.test(value)
    || /(?:^| )рекла[мс]н\p{L}* сбор(?: |$)|(?:^| )сбор рекла[мс]н\p{L}*(?: |$)|^рс(?: |$)/u.test(value);
}

export function calculationModel(value) {
  const tokens = String(value ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const token of tokens) {
    const model = calculationToken(token).toUpperCase();
    if (supportedModels.has(model)) return model;
  }
  return '';
}

export function formatCalculationColumn(headers) {
  const matches = headers.map((header, index) => normalized(header) === 'формат расчетов' ? index : -1).filter(index => index >= 0);
  return matches.length === 1 ? matches[0] : -1;
}

/** Map Core conversion columns to the corresponding source funnel stage. */
export function conversionSourceColumn(metric, headers, mode) {
  const normalizedHeaders = headers.map(normalized);
  if (metric === 'cr1') {
    const found = normalizedHeaders.map((header, index) => /^(?:ctr|cr1)(?: |$)/.test(header) ? index : -1).filter(index => index >= 0);
    // CTR is authoritative for Core CR1 when present in either source.
    const ctr = normalizedHeaders.map((header, index) => /^ctr(?: |$)/.test(header) ? index : -1).filter(index => index >= 0);
    return ctr.length === 1 ? ctr[0] : ctr.length === 0 && mode === 'fact' && found.length === 1 ? found[0] : -1;
  }
  if (metric === 'cr2' && mode === 'fact') {
    const found = normalizedHeaders.map((header, index) => /^cr1(?: |$)/.test(header) ? index : -1).filter(index => index >= 0);
    return found.length === 1 ? found[0] : -1;
  }
  if (metric === 'cr3' && mode === 'fact') {
    const found = normalizedHeaders.map((header, index) => /^cr2(?: |$)/.test(header) ? index : -1).filter(index => index >= 0);
    return found.length === 1 ? found[0] : -1;
  }
  if (metric === 'cr2' && mode === 'plan' || metric === 'cr3' && mode === 'plan') {
    const forecasts = normalizedHeaders.map((header, index) => /^прогноз cr(?: |$)/.test(header) ? index : -1).filter(index => index >= 0);
    const position = metric === 'cr2' ? 0 : 1;
    return forecasts.length > position ? forecasts[position] : -1;
  }
  return -1;
}

export function planSourceNameColumn(headers) {
  const values = headers.map(normalized);
  const priorities = [
    value => value === 'описание размещения',
    value => /назван.*(?:кампан|строк|объект)|^название$|^кампания$/.test(value),
    value => value === 'объект рекламирования',
    value => value === 'тип семантики категории интересов',
    value => value === 'объект продвижения',
    value => /описан/.test(value),
    value => /utm source/.test(value),
    value => /площад/.test(value)
  ];
  for (const match of priorities) {
    const index = values.findIndex(match);
    if (index >= 0) return index;
  }
  return -1;
}

export function planPlacementGroup(headers, row) {
  const column = label => {
    const matches = headers.map((header, index) => normalized(header) === normalized(label) ? index : -1).filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  };
  const type = column('Тип семантики/категории интересов');
  const targeting = column('Таргетинги (интересы, соцдем, R&F)');
  const placement = column('Рекламная площадка');
  const formatPlacement = column('Формат размещения');
  const format = formatCalculationColumn(headers);
  const category = normalized(type >= 0 ? row[type] : '');
  const detail = normalized(targeting >= 0 ? row[targeting] : '');
  const site = normalized(placement >= 0 ? row[placement] : '');
  const formatText = normalized(formatPlacement >= 0 ? row[formatPlacement] : '');
  const model = calculationModel(format >= 0 ? row[format] : '');
  const combined = `${category} ${site} ${formatText} ${detail}`;
  const platform = platformKey(site || category);
  if (/urban ads/.test(combined)) return model ? `urban-ads|${model}` : '';
  if (/медийн(?:ое размещение|ая кампания).*видео|медийное видео/.test(combined)) {
    return platform === 'yandex' && model === 'CPM' ? 'yandex-display-video|CPM' : '';
  }
  if (/медийн(?:ое размещение|ая кампания).*баннер|медийная реклама.*баннер/.test(combined)) {
    return platform === 'yandex' && model === 'CPM' ? 'yandex-display-banner|CPM' : '';
  }
  if (/геосервисы.*карты/.test(category) || (category === 'геосервисы' && /яндекс карты/.test(site))) {
    if (platform !== 'yandex' || model !== 'STATIC') return '';
    if (/супербренд/.test(`${detail} ${formatText}`)) return 'yandex-maps-superbrand|STATIC';
    if (/брендирован/.test(`${detail} ${formatText}`)) return 'yandex-maps-brand|STATIC';
  }
  if (/классиф/.test(combined)) return model ? `classifieds|${model}` : '';
  if (['avito', 'domclick', 'cian'].includes(platform)) return model ? `classifieds|${model}` : '';
  if (/контекстная реклама медийка/.test(category) && platform === 'yandex' && model === 'CPM') return 'yandex-display-banner|CPM';
  if (/социальные сети/.test(category) && platform === 'vk' && model === 'CPM' && formatText) return `vk|${formatText}|CPM`;
  // A payment model by itself does not identify a placement. Unknown groups
  // stay unmatched instead of being assigned to a same-named ЖК by chance.
  return '';
}

function platformKey(value) {
  const text = normalized(value);
  if (/yandex|яндекс/.test(text)) return 'yandex';
  if (/(?:^| )vk(?: |$)|вконтакт|вк ads|вк рекл/.test(text)) return 'vk';
  if (/urban ads/.test(text)) return 'urban';
  if (/avito|авито/.test(text)) return 'avito';
  if (/domclick|домклик/.test(text)) return 'domclick';
  if (/cian|циан/.test(text)) return 'cian';
  return '';
}

/** Canonicalize a Core parent placement label using the same strict aliases as Excel. */
export function corePlacementGroup(value) {
  const text = normalized(value);
  let model = calculationModel(text);
  if (/urban ads/.test(text)) return model ? `urban-ads|${model}` : '';
  if (/яндекс карт/.test(text) && model === 'STATIC') {
    if (/супербренд/.test(text)) return 'yandex-maps-superbrand|STATIC';
    if (/брендирован/.test(text)) return 'yandex-maps-brand|STATIC';
  }
  if (/яндекс карт/.test(text) && !model) {
    if (/супербренд/.test(text)) return 'yandex-maps-superbrand|STATIC';
    if (/брендирован/.test(text)) return 'yandex-maps-brand|STATIC';
  }
  if (/медийн.*видео|дисплей.*видео/.test(text) && /яндекс/.test(text) && model === 'CPM') return 'yandex-display-video|CPM';
  if (/медийн.*баннер|медийная реклама/.test(text) && /яндекс/.test(text) && model === 'CPM') return 'yandex-display-banner|CPM';
  if (/классиф/.test(text)) return model ? `classifieds|${model}` : '';
  if (['avito', 'domclick', 'cian'].includes(platformKey(text))) return model ? `classifieds|${model}` : '';
  if (/социальные сети/.test(text) && /vk|вконтакт|вк/.test(text) && model === 'CPM') {
    const detail = text.replace(/^(?:социальные сети|vk|вконтакте|вк ads)\s*/, '').replace(/\b(?:cpc|cpm|cpl|cpa|fix|static)\b/g, '').trim();
    return detail ? `vk|${detail}|CPM` : '';
  }
  return '';
}

export function planMetric(header) {
  const value = normalized(header);
  if (isManualEntryHeader(header)) return 'manual';
  if (/^(?:бюджет|расход|стоимость)(?: |$)/.test(value)) return 'budget';
  if (/показ/.test(value)) return 'impressions';
  if (/клик/.test(value)) return 'clicks';
  if (/^(?:лиды|все лиды)(?: |$)|валов.*лид/.test(value)) return 'allLeads';
  if (/^(?:цо|целевые лиды)(?: |$)|целев.*лид|прогноз.*лид/.test(value)) return 'targetLeads';
  if (/^cpl\b|cpa.*(?:уник|валов)/.test(value)) return 'cpl';
  if (/^cpa\b|cpa.*целев/.test(value)) return 'cpa';
  if (/^cpc\b|^срс\b/.test(value)) return 'cpc';
  if (/^cpm\b|^срм\b/.test(value)) return 'cpm';
  if (/^ctr\b|^cr1\b/.test(value)) return 'cr1';
  if (/^cr2\b/.test(value)) return 'cr2';
  if (/^cr3\b/.test(value)) return 'cr3';
  return '';
}

export function eligiblePlanMetrics(model) {
  return {
    CPM: ['impressions', 'cr1', 'cr2', 'cr3', 'clicks', 'allLeads', 'targetLeads', 'cpm'],
    CPC: ['clicks', 'cr1', 'cr2', 'cr3', 'allLeads', 'targetLeads', 'cpc'],
    CPL: ['allLeads', 'targetLeads', 'cr3', 'cpl'],
    CPA: ['allLeads', 'targetLeads', 'cr3', 'cpl'],
    FIX: ['budget', 'impressions', 'cr1', 'cr2', 'cr3', 'clicks', 'allLeads', 'targetLeads'],
    STATIC: ['budget', 'impressions', 'cr1', 'cr2', 'cr3', 'clicks', 'allLeads', 'targetLeads']
  }[model] || [];
}

/** Normalize explicit percent strings without guessing a scale from a number's magnitude. */
export function normalizePlanPercentage(value, { sourceFormat = '', hasPercentSign = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // Numeric Excel cells carry the workbook's stored value regardless of their
  // display format. Preserve that value and let staged Core readback verify it.
  // Only text with an explicit percent sign needs a conversion.
  return hasPercentSign ? number / 100 : number;
}

export function validatePlanBudget({ model, price, impressions, clicks, leads, sourceBudget }) {
  const numeric = value => value === null || value === undefined || String(value).trim() === '' ? null : Number(value);
  const budget = numeric(sourceBudget);
  if (budget === null || !Number.isFinite(budget)) return { status: 'review', message: 'В Excel не найдено достоверное значение бюджета строки.' };
  let expected;
  if (model === 'CPM') {
    const cpm = numeric(price), thousands = numeric(impressions);
    if (cpm === null || thousands === null || !Number.isFinite(cpm) || !Number.isFinite(thousands)) return { status: 'review', message: 'Для проверки CPM-бюджета нужны цена за 1000 показов и показы.' };
    expected = cpm * thousands;
  } else if (model === 'CPC') {
    const cpc = numeric(price), count = numeric(clicks);
    if (cpc === null || count === null || !Number.isFinite(cpc) || !Number.isFinite(count)) return { status: 'review', message: 'Для проверки CPC-бюджета нужны цена за клик и клики.' };
    expected = cpc * count;
  } else if (model === 'CPL' || model === 'CPA') {
    const cpl = numeric(price), count = numeric(leads);
    if (cpl === null || count === null || !Number.isFinite(cpl) || !Number.isFinite(count)) return { status: 'review', message: 'Для проверки CPL/CPA-бюджета нужны цена и количество лидов.' };
    expected = cpl * count;
  } else if (model === 'FIX' || model === 'STATIC') {
    expected = budget;
  } else return { status: 'review', message: 'Модель оплаты не подтверждена.' };
  const difference = Math.round((expected - budget) * 100) / 100;
  return { status: Math.abs(difference) <= 0.01 ? 'ok' : 'review', expected: Math.round(expected * 100) / 100, actual: Math.round(budget * 100) / 100, difference, message: Math.abs(difference) <= 0.01 ? '' : `Бюджет строки не сходится: расчёт ${expected.toFixed(2)} ₽, Excel ${budget.toFixed(2)} ₽, Δ ${difference.toFixed(2)} ₽.` };
}

export function supportedPlanModel(value) {
  return ['CPC', 'CPM', 'CPL', 'CPA', 'FIX'].includes(calculationModel(value));
}
