import { calculationModel, conversionSourceColumn, corePlacementGroup, eligiblePlanMetrics, formatCalculationColumn, isManualEntryHeader, planMetric, planPlacementGroup, planSourceNameColumn } from './public/plan-rules.js';
import { isMissingSourceValue } from './public/numeric.js';
import { aggregateFactRows } from './public/fact-aggregation.js';
import { matchPromotionName, promotionColumn } from './public/report-selector.js';

/**
 * Compare a saved Core table with the source-backed cells approved in a proposal.
 * Kept independent from HTTP and browser code so the reconciliation rules can be
 * exercised against synthetic tables without opening or editing Core.
 */
export function expandSpannedCells(sourceRows) {
  const rows = [], cellMaps = [];
  sourceRows.forEach((sourceCells, rowIndex) => {
    const values = rows[rowIndex] ||= [];
    cellMaps[rowIndex] ||= [];
    let column = 0;
    for (let physicalCellIndex = 0; physicalCellIndex < sourceCells.length; physicalCellIndex++) {
      const cell = sourceCells[physicalCellIndex];
      while (values[column] !== undefined) column++;
      const colSpan = Math.max(1, Number(cell.colSpan) || 1);
      const rowSpan = Number(cell.rowSpan) === 0 ? sourceRows.length - rowIndex : Math.max(1, Number(cell.rowSpan) || 1);
      for (let targetRow = rowIndex; targetRow < Math.min(sourceRows.length, rowIndex + rowSpan); targetRow++) {
        const target = rows[targetRow] ||= [];
        const targetMap = cellMaps[targetRow] ||= [];
        for (let targetColumn = column; targetColumn < column + colSpan; targetColumn++) {
          if (target[targetColumn] !== undefined) continue;
          target[targetColumn] = targetRow === rowIndex && targetColumn === column ? String(cell.value ?? '') : '';
          targetMap[targetColumn] = {
            rowIndex,
            physicalCellIndex,
            editable: targetRow === rowIndex && colSpan === 1 && rowSpan === 1
          };
        }
      }
      column += colSpan;
    }
  });
  return { rows: rows.map(row => row.map(value => value ?? '')), cellMaps };
}

const norm = value => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const relation = value => norm(value).replace(/^лср\s+/, '').replace(/\bлейк\b/g, 'lake');
const uniqueColumn = (headers, label) => {
  const matches = headers.map((header, index) => norm(header) === norm(label) ? index : -1).filter(index => index >= 0);
  return matches.length === 1 ? matches[0] : -1;
};
const metricForHeader = header => isManualEntryHeader(header) ? 'manualAK' : planMetric(header);

function sourceNameColumn(headers, mode) {
  if (mode === 'fact') return promotionColumn(headers).index;
  return planSourceNameColumn(headers);
}

function normalizedFactSource({sourceRows,sourceHeaders,targetRows,nameCol}) {
  const promotion=promotionColumn(sourceHeaders);
  if(promotion.index<0)throw new Error('Не найден единственный столбец объекта, кампании или UTM Source DataLens.');
  const expectedObjects=targetRows.slice(1).map(row=>String(row[nameCol]??'').trim()).filter(name=>name&&!/^(?:итого|всего|total)\b/i.test(name)&&!/ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(name));
  return aggregateFactRows({headers:sourceHeaders,rows:sourceRows.slice(1),nameColumn:promotion.index,nameKind:promotion.kind,expectedObjects});
}

/** Server-derived fact values, including campaign aggregation, for tamper-proof preview checks. */
export function expectedFactValues({sourceRows,sourceHeaders,targetRows,nameCol,parseDisplayNumber,impressionsInThousands=true}) {
  const aggregated=normalizedFactSource({sourceRows,sourceHeaders,targetRows,nameCol});
  const targetNames=new Map();
  for(let rowIndex=1;rowIndex<targetRows.length;rowIndex++){
    const name=String(targetRows[rowIndex]?.[nameCol]??'').trim();if(!name||/^(?:итого|всего|total)\b/i.test(name)||/ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(name))continue;
    const key=relation(name);if(!targetNames.has(key))targetNames.set(key,[]);targetNames.get(key).push({rowIndex,name});
  }
  const values=new Map();
  for(const source of aggregated.groups){
    const targets=targetNames.get(relation(source.object))||[];
    if(targets.length!==1)continue;
    const target=targets[0];
    for(let column=0;column<(targetRows[0]||[]).length;column++){
      const header=String(targetRows[0][column]??'').trim(),metric=metricForHeader(header);
      if(!metric||metric==='manualAK'||isManualEntryHeader(header))continue;
      const sourceColumn=sourceMetricColumn(header,sourceHeaders,'fact');if(sourceColumn<0)continue;
      const raw=source.row[sourceColumn];if(raw===undefined||String(raw).trim()===''||isMissingSourceValue(raw))continue;
      let value=parseDisplayNumber(raw);if(value===null)continue;
      if(['cr1','cr2','cr3'].includes(metric)){
        if(String(raw).includes('%'))value/=100;
        else if(String(sourceHeaders[sourceColumn]||'').includes('%'))continue;
      }
      if(metric==='impressions'&&impressionsInThousands)value/=1000;
      values.set(`${target.rowIndex}:${column}`,String(Number(value.toFixed(6))));
    }
  }
  return {values,issues:aggregated.issues};
}

function sourceMetricColumn(targetHeader, sourceHeaders, mode) {
  const targetNorm = norm(targetHeader), metric = metricForHeader(targetHeader);
  if (!metric || metric === 'manualAK' || isManualEntryHeader(targetHeader)) return -1;
  if (['cr1', 'cr2', 'cr3'].includes(metric)) return conversionSourceColumn(metric, sourceHeaders, mode);
  const exact = sourceHeaders.map((header, index) => norm(header) === targetNorm ? index : -1).filter(index => index >= 0);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return -1;
  const headers = sourceHeaders.map((header, index) => ({ header: norm(header), index }));
  let candidates = [];
  if (metric === 'budget') candidates = headers.filter(x => /^(?:расход.*ндс|стоимость с ндс|бюджет)(?: |$)/.test(x.header) && !/(?:^| )(?:и ак|ак|рекламн.*сбор)(?: |$)/.test(x.header) && (mode !== 'fact' || x.header.includes('ндс')));
  if (metric === 'impressions') candidates = headers.filter(x => /показ/.test(x.header));
  if (metric === 'clicks') candidates = headers.filter(x => /клик/.test(x.header));
  if (metric === 'allLeads') candidates = headers.filter(x => /все лид|лиды$|валов.*лид/.test(x.header));
  if (metric === 'targetLeads') candidates = headers.filter(x => /целев.*лид|конверс/.test(x.header));
  if (mode === 'plan' && metric === 'allLeads') {
    let matches = sourceHeaders.map((header, index) => /^прогноз обращения(?: шт)?$/.test(norm(header)) ? index : -1).filter(index => index >= 0);
    if (!matches.length) matches = sourceHeaders.map((header, index) => /^валовые лиды(?: шт)?$/.test(norm(header)) ? index : -1).filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  }
  if (mode === 'plan' && metric === 'targetLeads') {
    let matches = sourceHeaders.map((header, index) => /прогноз лиды по last click/.test(norm(header)) ? index : -1).filter(index => index >= 0);
    if (!matches.length) matches = sourceHeaders.map((header, index) => /^прогноз лиды(?: шт)?$/.test(norm(header)) ? index : -1).filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  }
  if (metric === 'cpl') candidates = headers.filter(x => /cpl\b|cpa.*уник|cpa.*валов/.test(x.header));
  if (metric === 'cpa') candidates = headers.filter(x => /cpa.*целев/.test(x.header));
  if (metric === 'cpc') candidates = headers.filter(x => /^cpc\b|^срс\b|цена за клик|стоимост.*клик/.test(x.header));
  if (metric === 'cpm') candidates = headers.filter(x => /^cpm\b|^срм\b|цена за тысячу/.test(x.header));
  if (mode === 'plan' && metric === 'cpc' && !candidates.length) candidates = headers.filter(x => /цена за единицу/.test(x.header));
  if (mode === 'plan' && metric === 'cpm' && !candidates.length) candidates = headers.filter(x => /цена за единицу/.test(x.header));
  if (metric === 'cr1') candidates = headers.filter(x => /^ctr\b|^cr1\b/.test(x.header));
  if (metric === 'cr2') candidates = mode === 'plan' ? headers.filter(x => /^прогноз cr\b/.test(x.header)).slice(0, 1) : headers.filter(x => /^cr2\b/.test(x.header));
  if (metric === 'cr3') candidates = mode === 'plan' ? headers.filter(x => /^прогноз cr\b/.test(x.header)).slice(1, 2) : headers.filter(x => /^cr3\b/.test(x.header));
  if (candidates.length === 1) return candidates[0].index;
  if (mode === 'fact' && metric === 'cr1') {
    const ctr = headers.filter(x => x.header.includes('ctr'));
    if (ctr.length === 1) return ctr[0].index;
  }
  return -1;
}

function placementGroup(headers, row) {
  return planPlacementGroup(headers,row);
}

function targetPlacement(rows, rowIndex, nameCol, placementCol) {
  for (let index = rowIndex - 1; index >= 1; index--) {
    const description = String(rows[index][nameCol] || '').trim(), placement = String(rows[index][placementCol] || '').trim();
    if (description || !placement) continue;
    const groupKey = corePlacementGroup(placement);
    return { groupKey, model: groupKey.split('|').at(-1)||'' };
  }
  return { groupKey: '', model: '' };
}

/** Rebuild the complete set of source-backed cell checks without trusting the browser client. */
export function expectedCheckKeys({ mode, sourceRows, sourceHeaders, headerRowIndex = 0, targetRows, nameCol, placementCol, parseDisplayNumber, allowPartial = false }) {
  const nameSourceCol = sourceNameColumn(sourceHeaders, mode);
  if (nameSourceCol < 0 || nameCol < 0 || nameCol >= (targetRows[0] || []).length) throw new Error('Не удалось заново определить колонки названия источника и МП на сервере.');
  const targetHeaders = targetRows[0] || [];
  const calculationColumn=mode==='plan'?formatCalculationColumn(sourceHeaders):-1;
  const factSource=mode==='fact'?normalizedFactSource({sourceRows,sourceHeaders,targetRows,nameCol}):null;
  if(mode==='fact'&&factSource.issues.length&&!allowPartial)throw new Error(factSource.issues[0]);
  const effectiveSourceRows=mode==='fact'?factSource.rows:sourceRows;
  const sourceStart = mode === 'plan' ? headerRowIndex + 1 : 1;
  const ignore = value => /ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(value);
  const sourceByKey = new Map(), targetByKey = new Map();
  for (let index = sourceStart; index < effectiveSourceRows.length; index++) {
    const row = effectiveSourceRows[index] || [], name = String(row[nameSourceCol] || '').trim();
    if (!name || /^(?:итого|всего|total)\b/i.test(name) || ignore(name)) continue;
    const sourceModel=mode==='plan'&&calculationColumn>=0?calculationModel(String(row[calculationColumn]??'').trim()):'';
    if(mode==='plan'&&calculationColumn>=0&&(!String(row[calculationColumn]??'').trim()||!sourceModel))continue;
    const group = mode === 'plan' ? placementGroup(sourceHeaders, row) : '';
    if(mode==='plan'&&sourceModel==='STATIC'&&!group.startsWith('yandex-maps-'))continue;
    if (mode === 'plan' && !group) {
      if (allowPartial) continue;
      throw new Error(`Не удалось подтвердить группу размещения для строки «${name}» в Excel.`);
    }
    const key = `${mode === 'plan' ? `${group}|` : ''}${relation(name)}`;
    if (!sourceByKey.has(key)) sourceByKey.set(key, []);
    sourceByKey.get(key).push({ row, rowIndex: index, name });
  }
  for (let index = 1; index < targetRows.length; index++) {
    const row = targetRows[index] || [], name = String(row[nameCol] || '').trim();
    if (!name || /^(?:итого|всего|total)\b/i.test(name) || ignore(name)) continue;
    const placement = mode === 'plan' ? targetPlacement(targetRows, index, nameCol, placementCol) : null;
    const key = `${mode === 'plan' ? `${placement.groupKey}|` : ''}${relation(name)}`;
    if (!targetByKey.has(key)) targetByKey.set(key, []);
    targetByKey.get(key).push({ rowIndex: index, name, placement });
  }
  const expected = new Set();
  for (const [key, sourceMatches] of sourceByKey) {
    const targets = targetByKey.get(key) || [];
    if (sourceMatches.length !== 1 || targets.length !== 1) {
      if (allowPartial) continue;
      throw new Error(`Сервер не подтвердил однозначное соответствие источника и МП для «${sourceMatches[0].name}».`);
    }
    const source = sourceMatches[0], target = targets[0];
    if (mode === 'plan' && (!target.placement.groupKey || !target.placement.model)) {
      if (allowPartial) continue;
      throw new Error(`Не удалось подтвердить группу и модель строки «${target.name}» в МП.`);
    }
    const classified = /avito|domclick|домклик|cian|циан|realty|недвижим|классиф/i.test(target.name)
      || (mode === 'plan' && target.placement.groupKey.startsWith('classifieds|'));
    for (let column = 0; column < targetHeaders.length; column++) {
      const header = String(targetHeaders[column] || '').trim(), metric = metricForHeader(header);
      if (!metric || metric === 'manualAK' || isManualEntryHeader(header)) continue;
      if (mode === 'plan') {
        const derivedBudgetCheck=metric==='budget'&&!['FIX','STATIC'].includes(target.placement.model);
        if (!eligiblePlanMetrics(target.placement.model).includes(metric)&&!derivedBudgetCheck) continue;
      }
      if (classified && !['cpl', 'allLeads', 'targetLeads'].includes(metric)) continue;
      let sourceColumnIndex = -1;
      if (mode === 'plan' && metric === 'cpm') sourceColumnIndex = sourceMetricColumn(header, sourceHeaders, mode);
      else if (mode === 'plan' && metric === 'budget') sourceColumnIndex = sourceMetricColumn('Стоимость с НДС', sourceHeaders, mode);
      else sourceColumnIndex = sourceMetricColumn(header, sourceHeaders, mode);
      if (sourceColumnIndex < 0) {
        if (allowPartial) continue;
        throw new Error(`Сервер не смог однозначно сопоставить исходное поле для «${target.name} · ${header}».`);
      }
      const raw = source.row[sourceColumnIndex];
      if (raw === undefined || String(raw).trim() === '') {
        if (allowPartial) continue;
        throw new Error(`В источнике пусто для «${target.name} · ${header}».`);
      }
      if (isMissingSourceValue(raw)) continue;
      if (parseDisplayNumber(raw) === null) {
        if (allowPartial) continue;
        throw new Error(`В источнике нечисловое значение для «${target.name} · ${header}».`);
      }
      if (mode === 'fact' && ['cr1', 'cr2', 'cr3'].includes(metric) && String(sourceHeaders[sourceColumnIndex] || '').includes('%') && !String(raw).includes('%')) {
        throw new Error(`Единицы процента для источника «${sourceHeaders[sourceColumnIndex]}» неоднозначны.`);
      }
      expected.add(`${target.rowIndex}:${column}`);
    }
  }
  return expected;
}

export function assertCompleteCheckCoverage(expected, provided) {
  if (expected.size !== provided.size || [...expected].some(key => !provided.has(key))) {
    throw new Error(`Список построчной сверки неполный или содержит лишние поля (${provided.size}/${expected.size}). Предпросмотр нужно пересобрать.`);
  }
  return true;
}

export function verifyCoreChecks(checks, rows, { sameCellValue, parseDisplayNumber, amountTolerance = 10 }) {
  const cellResults = checks.map(check => {
    const actual = String(rows[check.rowIndex]?.[check.colIndex] ?? '').trim();
    return {
      row: check.rowKey,
      column: check.header,
      expected: check.value,
      actual,
      ok: String(rows[check.rowIndex]?.[check.nameCol] ?? check.rowKey).trim() === check.rowKey
        && sameCellValue(actual, check.value, check.header)
    };
  });

  const grouped = new Map();
  for (const check of checks) {
    const header = check.header.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();
    let metric = '';
    if (/^бюджет|^расход|^стоимость/.test(header)) metric = 'сумма';
    else if (/^цо$|целев.*лид/.test(header)) metric = 'целевые лиды';
    else if (/все лид|^лиды(?: |$)/.test(header)) metric = 'все лиды';
    else if (/клик/.test(header)) metric = 'клики';
    else if (/показ/.test(header)) metric = 'показы';
    if (!metric) continue;
    if (!grouped.has(metric)) grouped.set(metric, { expected: 0, actual: 0, count: 0, missing: false });
    const group = grouped.get(metric);
    const expected = parseDisplayNumber(check.value);
    const actual = parseDisplayNumber(rows[check.rowIndex]?.[check.colIndex]);
    if (expected === null || actual === null) group.missing = true;
    else { group.expected += expected; group.actual += actual; group.count++; }
  }

  const totals = [...grouped.entries()].map(([metric, group]) => {
    const delta = group.actual - group.expected;
    const ok = !group.missing && group.count > 0 && (
      metric === 'сумма' ? Math.abs(delta) <= amountTolerance
        : metric === 'показы' ? Math.abs(delta) <= group.count * 0.5
          : Math.abs(delta) < 0.000001
    );
    return { metric, expected: group.expected, actual: group.actual, delta, ok };
  });
  const verifiedChecks = cellResults.filter(result => result.ok).length;
  const totalRows = new Set(checks.map(check => check.rowIndex)).size;
  const verifiedRows = new Set(checks.filter((check, index) => cellResults[index]?.ok).map(check => check.rowIndex)).size;
  const totalsVerified = totals.length > 0 && totals.every(total => total.ok);
  return {
    totalChecks: cellResults.length,
    verifiedChecks,
    totalRows,
    verifiedRows,
    rows: cellResults,
    totals,
    totalsVerified,
    ok: verifiedChecks === cellResults.length && totalsVerified
  };
}
