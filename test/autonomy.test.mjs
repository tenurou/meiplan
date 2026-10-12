import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { createUserRecord, makeUserId, verifyBasicAuthorization, writeUsers } from '../auth.mjs';
import { forceKillChromium, recordBrowserActivity } from '../browser-cleanup.mjs';
import { assertCompleteCheckCoverage, expandSpannedCells, expectedCheckKeys, verifyCoreChecks } from '../reconcile.mjs';
import { auditIsClear, identityAlerts } from '../public/audit-status.js';
import { relationRows } from '../public/relation-audit.js';
import { calculationModel, conversionSourceColumn, corePlacementGroup, eligiblePlanMetrics, formatCalculationColumn, isManualEntryHeader, normalizePlanPercentage, planPlacementGroup, planSourceNameColumn, validatePlanBudget } from '../public/plan-rules.js';
import { isMissingSourceValue, parseNumericValue } from '../public/numeric.js';
import { inferPlanMonth, matchPromotionName, promotionColumn, rankFactTables } from '../public/report-selector.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AGM_PLAYWRIGHT_MODULE || 'playwright');
const python = process.env.AGM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-autonomy-'));
const spawned = [];
after(async () => {
  await Promise.all(spawned.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve); child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 8000).unref();
  })));
  await delay(750);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

test('saved-table reconciliation enforces row identity, exact leads, and a 10 RUB budget tolerance', () => {
  const checks = [
    { rowIndex: 1, colIndex: 1, nameCol: 0, rowKey: 'ЖК Тест', header: 'Бюджет, руб.', value: '100000' },
    { rowIndex: 1, colIndex: 2, nameCol: 0, rowKey: 'ЖК Тест', header: 'Целевые лиды, шт', value: '12' },
    { rowIndex: 1, colIndex: 3, nameCol: 0, rowKey: 'ЖК Тест', header: 'Клики, шт', value: '250' }
  ];
  const parseDisplayNumber = raw => {
    const normalized = String(raw ?? '').replace(/[₽\s\u00a0]/g, '').replace(',', '.');
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  };
  const sameCellValue = (actual, expected) => parseDisplayNumber(actual) === parseDisplayNumber(expected);
  const table = [['Описание', 'Бюджет, руб.', 'Целевые лиды, шт', 'Клики, шт'], ['ЖК Тест', '100009.99', '12', '250']];

  const withinTolerance = verifyCoreChecks(checks, table, { sameCellValue, parseDisplayNumber });
  assert.equal(withinTolerance.ok, false, 'a cell-level value difference must still be visible even if the aggregate amount is within tolerance');
  assert.equal(withinTolerance.totalsVerified, true);
  assert.ok(Math.abs(withinTolerance.totals.find(total => total.metric === 'сумма').delta - 9.99) < 1e-8);
  assert.equal(verifyCoreChecks(checks, table, { sameCellValue, parseDisplayNumber, amountTolerance: 5 }).totalsVerified, false, 'the selected lower amount tolerance must be enforced');

  table[1][2] = '13';
  const wrongLeads = verifyCoreChecks(checks, table, { sameCellValue, parseDisplayNumber });
  assert.equal(wrongLeads.ok, false);
  assert.equal(wrongLeads.verifiedChecks, 1);
  assert.equal(wrongLeads.totals.find(total => total.metric === 'целевые лиды').ok, false);

  table[1][0] = 'Другое ЖК';
  const wrongRow = verifyCoreChecks(checks, table, { sameCellValue, parseDisplayNumber });
  assert.equal(wrongRow.ok, false);
  assert.equal(wrongRow.rows.every(result => !result.ok), true);
});

test('object promotion relation flags duplicate rows as ambiguous instead of collapsing them', () => {
  const relation = relationRows(
    [['ЖК Альфа'], ['ЖК Альфа'], ['ЖК Бета'], ['AdRiver'], ['Итого']], 0,
    [['ЖК Альфа'], ['ЖК Бета'], ['ЖК Бета'], ['ЖК Гамма'], ['Botfaqtor']], 0,
    value => value.toLocaleLowerCase('ru-RU')
  );
  assert.equal(relation.length, 3, 'totals and excluded sources are ignored');
  assert.deepEqual(relation.map(row => [row.object.replace(/ \(строк: \d+\)$/, ''), row.description.replace(/ \(строк: \d+\)$/, ''), row.state]), [
    ['ЖК Альфа', 'ЖК Альфа', 'Неоднозначно · DataLens: 2, МП: 1'],
    ['ЖК Бета', 'ЖК Бета', 'Неоднозначно · DataLens: 1, МП: 2'],
    ['—', 'ЖК Гамма', 'Нет объекта в DataLens · МП: 1']
  ]);
});

test('audit status can only be green when every comparison passes', () => {
  assert.equal(auditIsClear(true, [{ type: 'pass' }, { type: 'pass' }]), true);
  assert.equal(auditIsClear(true, [{ type: 'pass' }, { type: 'warn' }]), false);
  assert.equal(auditIsClear(true, [{ type: 'error' }]), false);
  assert.equal(auditIsClear(true, []), false);
  assert.equal(auditIsClear(false, [{ type: 'pass' }]), false);
});

test('audit identity checks prevent green status when row links are missing, duplicated, or unavailable', () => {
  const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const matched = identityAlerts([['Alpha']], 0, [['Alpha']], 0, normalize, 'Excel');
  assert.equal(matched[0].type, 'pass');
  assert.equal(auditIsClear(true, matched), true);

  const duplicated = identityAlerts([['Alpha'], ['Alpha']], 0, [['Alpha']], 0, normalize, 'Excel');
  assert.equal(duplicated[0].type, 'error');
  assert.equal(auditIsClear(true, duplicated), false);

  const missing = identityAlerts([['Alpha']], 0, [['Beta']], 0, normalize, 'DataLens');
  assert.equal(missing[0].type, 'error');
  assert.equal(auditIsClear(true, missing), false);

  const unavailable = identityAlerts([['Alpha']], -1, [['Alpha']], 0, normalize, 'Excel');
  assert.equal(unavailable[0].type, 'error');
  assert.equal(auditIsClear(true, unavailable), false);

  const excludedOnly = identityAlerts([['Botfaqtor']], 0, [['Botfaqtor']], 0, normalize, 'DataLens');
  assert.equal(excludedOnly[0].type, 'warn');
  assert.equal(auditIsClear(true, excludedOnly), false);
});

test('spanned Core cells map to physical inputs and block editing a merged field', () => {
  const { rows, cellMaps } = expandSpannedCells([
    [
      { value: 'Объект', rowSpan: 2 },
      { value: 'Показатели группы', colSpan: 2 }
    ],
    [
      { value: 'Клики' },
      { value: 'Бюджет' }
    ]
  ]);
  assert.deepEqual(rows, [['Объект', 'Показатели группы', ''], ['', 'Клики', 'Бюджет']]);
  assert.equal(cellMaps[0][1].editable, false, 'a colspan cell must not be used for a child metric');
  assert.deepEqual(cellMaps[1][0], { rowIndex: 0, physicalCellIndex: 0, editable: false }, 'a rowspan cell is not an editable cell in the following row');
  assert.deepEqual(cellMaps[1][1], { rowIndex: 1, physicalCellIndex: 0, editable: true });
  assert.deepEqual(cellMaps[1][2], { rowIndex: 1, physicalCellIndex: 1, editable: true });
});

test('Core edit selectors ignore nested-table rows and cells', async () => {
  const context = await chromium.launchPersistentContext(path.join(tempRoot, 'nested-table-profile'), { headless: true });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.setContent('<table id="core"><tbody><tr><td>ЖК</td><td><table><tbody><tr><td>вложенная</td></tr></tbody></table></td></tr><tr><td>Строка</td><td>99</td></tr></tbody></table>');
    const table = page.locator('table').first();
    const rows = table.locator(':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr');
    assert.equal(await rows.count(), 2);
    const cells = rows.nth(1).locator(':scope > th, :scope > td');
    assert.equal(await cells.count(), 2);
    assert.equal(await cells.nth(1).innerText(), '99');
  } finally { await context.close(); }
});

test('server independently rebuilds complete fact and Excel-plan check coverage', () => {
  const parseDisplayNumber = parseNumericValue;
  assert.ok(Math.abs(parseDisplayNumber('2.0999999999999999E-3') - 0.0021) < 1e-12);
  assert.equal(parseDisplayNumber('1 234,56 ₽'), 1234.56);
  assert.equal(isMissingSourceValue('-'), true);
  assert.equal(isMissingSourceValue('—'), true);
  assert.equal(isMissingSourceValue(''), false, 'a blank remains a blocking missing value, not a dash placeholder');
  assert.equal(isMissingSourceValue('#DIV/0!'), true, 'Excel formula errors are skipped per cell');
  assert.equal(parseNumericValue('#DIV/0!'), null);
  assert.equal(normalizePlanPercentage(0.0042,{sourceFormat:'percent'}),0.0042,'Excel percentage number formats already store fractional rates');
  assert.equal(normalizePlanPercentage(0.42,{hasPercentSign:true}),0.0042,'literal percent text is normalized to Core fractional rates');
  assert.deepEqual(validatePlanBudget({model:'CPM',price:52,impressions:1260,sourceBudget:65520}).status,'ok');
  assert.equal(validatePlanBudget({model:'CPM',price:52,impressions:1260,sourceBudget:65519.98}).difference,0.02);
  assert.equal(validatePlanBudget({model:'CPM',price:null,impressions:1260,sourceBudget:65520}).status,'review','missing CPM must not be treated as zero');
  assert.ok(eligiblePlanMetrics('CPA').includes('cpl'));
  assert.equal(eligiblePlanMetrics('CPA').includes('cpa'),false,'the same row cannot write CPL and CPA together');
  assert.equal(corePlacementGroup('Яндекс медийная реклама CPM'),'yandex-display-banner|CPM');
  assert.equal(isManualEntryHeader('АК, %'), true);
  assert.equal(isManualEntryHeader('Рекламный сбор, руб.'), true);
  assert.equal(isManualEntryHeader('Расходы на рекламный сбор'), true);
  assert.equal(isManualEntryHeader('Бюджет, руб.'), false);
  const factHeaders = ['Объект продвижения', 'Расход с НДС, руб.', 'CTR, %', 'CR1, %', 'CR2, %', 'CR3, %', 'Клики, шт', 'Все лиды, шт', 'Целевые лиды, шт', 'Показы, шт'];
  const factRows = [factHeaders, ['ЖК Альфа', '120000', '0.42%', '2.22%', '60%', '75%', '900', '20', '12', '140000']];
  const factTarget = [['Описание', 'Бюджет, руб.', 'CR1, %', 'Клики, шт', 'Все лиды, шт', 'Целевые лиды, шт', 'CR2, %', 'CR3, %', 'Показы, шт'], ['ЖК Альфа', '', '', '', '', '', '', '', '']];
  const manualFeeRows = [['Объект продвижения', 'Рекламный сбор, руб.'], ['ЖК Альфа', '100']];
  const manualFeeTarget = [['Описание', 'Рекламный сбор, руб.', 'РС'], ['ЖК Альфа', '', '']];
  assert.deepEqual([...expectedCheckKeys({ mode: 'fact', sourceRows: manualFeeRows, sourceHeaders: manualFeeRows[0], targetRows: manualFeeTarget, nameCol: 0, placementCol: -1, parseDisplayNumber })], [], 'manual fee fields must not enter automated reconciliation');
  const factKeys = expectedCheckKeys({ mode: 'fact', sourceRows: factRows, sourceHeaders: factHeaders, targetRows: factTarget, nameCol: 0, placementCol: -1, parseDisplayNumber });
  assert.deepEqual([...factKeys].sort(), ['1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8']);
  assert.equal(conversionSourceColumn('cr1', factHeaders, 'fact'), 2, 'DataLens CTR feeds Core CR1');
  assert.equal(conversionSourceColumn('cr2', factHeaders, 'fact'), 3, 'DataLens CR1 feeds Core CR2');
  assert.equal(conversionSourceColumn('cr3', factHeaders, 'fact'), 4, 'DataLens CR2 feeds Core CR3');
  assert.equal(assertCompleteCheckCoverage(factKeys, new Set(factKeys)), true);
  const omittedCheck = new Set(factKeys);
  omittedCheck.delete('1:8');
  assert.throws(() => assertCompleteCheckCoverage(factKeys, omittedCheck), /неполный или содержит лишние поля/);
  const unexpectedCheck = new Set(factKeys);
  unexpectedCheck.add('1:9');
  assert.throws(() => assertCompleteCheckCoverage(factKeys, unexpectedCheck), /неполный или содержит лишние поля/);
  factRows[1][1] = '';
  assert.throws(() => expectedCheckKeys({ mode: 'fact', sourceRows: factRows, sourceHeaders: factHeaders, targetRows: factTarget, nameCol: 0, placementCol: -1, parseDisplayNumber }), /пусто/);

  const planHeaders = ['Название кампании', 'Тип семантики/категории интересов', 'Таргетинги (интересы, соцдем, R&F)', 'Показы, шт', 'CTR, %', 'Прогноз CR', 'Прогноз CR', 'Клики, шт', 'Прогноз обращения', 'Прогноз лиды по Last Click', 'CPM', 'Рекламная площадка', 'Формат расчётов', 'Стоимость с НДС'];
  const planRows = [['Площадка', ...planHeaders.slice(1)], ['ЖК Альфа', 'Медийное размещение Баннер', '', '140000', '0.42%', '2.22%', '60%', '900', '20', '12', '145', 'Яндекс.Директ', 'CPM', '20300'], ['ЖК Бета', 'Медийное размещение Баннер', '', '90000', '0.30%', '1%', '50%', '500', '10', '6', '120', 'Яндекс.Директ', 'CPM', '10800']];
  assert.equal(conversionSourceColumn('cr1', planHeaders, 'plan'), 4, 'Excel CTR feeds Core CR1');
  assert.equal(conversionSourceColumn('cr2', planHeaders, 'plan'), 5, 'first forecast CR feeds Core CR2');
  assert.equal(conversionSourceColumn('cr3', planHeaders, 'plan'), 6, 'second forecast CR feeds Core CR3');
  const planTarget = [['Описание', 'Площадка', 'Показы, шт', 'CR1, %', 'CR2, %', 'CR3, %', 'Клики, шт', 'Все лиды, шт', 'Целевые лиды, шт', 'CPM'], ['', 'Яндекс медийная реклама CPM'], ['ЖК Альфа', ''], ['ЖК Бета', '']];
  const planKeys = expectedCheckKeys({ mode: 'plan', sourceRows: planRows, sourceHeaders: planHeaders, headerRowIndex: 0, targetRows: planTarget, nameCol: 0, placementCol: 1, parseDisplayNumber });
  assert.deepEqual([...planKeys].sort(), ['2:2', '2:3', '2:4', '2:5', '2:6', '2:7', '2:8', '2:9', '3:2', '3:3', '3:4', '3:5', '3:6', '3:7', '3:8', '3:9']);
  const formulaErrorRows=[planRows[0],[...planRows[1]],[...planRows[2]]];
  formulaErrorRows[1][4]='#DIV/0!';
  const formulaErrorKeys=expectedCheckKeys({mode:'plan',sourceRows:formulaErrorRows,sourceHeaders:planHeaders,headerRowIndex:0,targetRows:planTarget,nameCol:0,placementCol:1,parseDisplayNumber});
  assert.equal(formulaErrorKeys.has('2:3'),false,'only the target cell sourced from #DIV/0! stays untouched');
  assert.equal(formulaErrorKeys.has('2:2'),true,'valid metrics on the same row remain importable');

  const partialPlanRows = [planRows[0], [...planRows[1]], [...planRows[2]], ['ЖК Гамма', 'Медийное размещение Баннер', '', '—', '—', '—', '—', '—', '—', '—', '—']];
  partialPlanRows[1][5] = '';
  const partialPlanTarget = [planTarget[0], planTarget[1], planTarget[2]];
  assert.throws(() => expectedCheckKeys({ mode: 'plan', sourceRows: partialPlanRows, sourceHeaders: planHeaders, headerRowIndex: 0, targetRows: partialPlanTarget, nameCol: 0, placementCol: 1, parseDisplayNumber }), /пусто/);
  const partialPlanKeys = expectedCheckKeys({ mode: 'plan', sourceRows: partialPlanRows, sourceHeaders: planHeaders, headerRowIndex: 0, targetRows: partialPlanTarget, nameCol: 0, placementCol: 1, parseDisplayNumber, allowPartial: true });
  assert.equal(partialPlanKeys.has('2:4'), false, 'a blank source metric is excluded in partial mode');
  assert.equal(partialPlanKeys.has('2:2'), true, 'valid cells from the same source row remain verifiable');
  assert.equal([...partialPlanKeys].some(key => key.startsWith('4:')), false, 'unmatched source rows are omitted only in partial mode');

  const staticHeaders=['Тип семантики/категории интересов','Объект рекламирования','Рекламная площадка','Таргетинги (интересы, соцдем, R&F)','Формат размещения','Формат расчетов','Показов','Стоимость с НДС','CTR','Кликов','Прогноз CR, %','Прогноз Обращения, шт.','Прогноз CR, %','Прогноз Лиды по Last click, шт.','Прогноз CR, %','CPL, руб.'];
  const staticRows=[staticHeaders,['Геосервисы - Карты','ЖК Альфа','Яндекс Карты','Брендированное приоритетное размещение','пин-акция','Static',2800,18372.15,0.2710714286,759,0.002635,2,0.5,1,0.1,18372.15]];
  const staticTarget=[['Описание','Площадка','Бюджет, руб.','Показы, шт','CR1, %','CR2, %','Клики, шт','Все лиды, шт','Целевые лиды, шт','CPL, руб.'],['','Яндекс Карты Брендированное размещение'],['ЖК Альфа','','','','','','','','','']];
  const staticKeys=expectedCheckKeys({mode:'plan',sourceRows:staticRows,sourceHeaders:staticHeaders,headerRowIndex:0,targetRows:staticTarget,nameCol:0,placementCol:1,parseDisplayNumber});
  assert.deepEqual([...staticKeys].sort(),['2:2','2:3','2:4','2:5','2:6','2:7','2:8'],'static map rows remain source-backed for direct budget, impressions, conversions, clicks and leads');

  const rubezhHeaders=['Тип семантики/категории интересов','Рекламная площадка','Формат расчётов','Валовые лиды','Прогноз Лиды, шт.'];
  const rubezhRows=[rubezhHeaders,['Раздел кампаний','', '', '', ''],['Рубеж','Avito','СРА',5,4],['Услуги','-','Static',20,10],['Сомнительная строка','-','21',20,10]];
  const rubezhTarget=[['Описание','Площадка','Лиды','ЦО'],['','Классифайды CPA'],['Рубеж','','','']];
  const rubezhKeys=expectedCheckKeys({mode:'plan',sourceRows:rubezhRows,sourceHeaders:rubezhHeaders,headerRowIndex:0,targetRows:rubezhTarget,nameCol:0,placementCol:1,parseDisplayNumber});
  assert.deepEqual([...rubezhKeys].sort(),['2:2','2:3']);
  assert.equal(calculationModel('СРА'),'CPA');
  assert.equal(formatCalculationColumn(rubezhHeaders),2);
  assert.equal(planPlacementGroup(rubezhHeaders,rubezhRows[2]),'classifieds|CPA');
  assert.equal(planSourceNameColumn(['Объект рекламирования','Описание размещения']),1);
  assert.equal(planSourceNameColumn(['Тип семантики/категории интересов','Объект рекламирования','Формат расчетов']),1);

  const businessHeaders=['Тип семантики/категории интересов','Объект рекламирования','Рекламная площадка','Таргетинги (интересы, соцдем, R&F)','Формат размещения','Формат расчетов'];
  const businessRows=[
    ['Медийное размещение - баннеры','Бульвар Грина','Яндекс.Директ','','Баннеры','CPM'],
    ['Медийное размещение - баннеры','Измайловский','Яндекс.Директ','','Баннеры','CPM'],
    ['Медийное размещение - баннеры','Морская набережная','Яндекс.Директ','','Баннеры','CPM'],
    ['Медийное размещение - баннеры','Цивилизация на Неве','Яндекс.Директ','','Баннеры','CPM'],
    ['Медийное размещение - баннеры','Большая Охта','Яндекс.Директ','','Баннеры','CPM'],
    ['Медийное размещение - видео','Бульвар Грина','Яндекс.Директ','','Видео','CPM'],
    ['Медийное размещение - видео','Цивилизация на Неве','Яндекс.Директ','','Видео','CPM'],
    ['Urban Ads','Бульвар Грина','Urban Ads','','Banner','CPM']
  ];
  const businessNameColumn=planSourceNameColumn(businessHeaders);
  const businessKeys=businessRows.map(row=>`${planPlacementGroup(businessHeaders,row)}|${String(row[businessNameColumn]).trim().toLocaleLowerCase('ru-RU')}`);
  assert.equal(businessNameColumn,1);
  assert.equal(new Set(businessKeys).size,8,'repeated placement categories must remain distinct by promoted object');
  assert.equal(businessKeys.filter(key=>key.startsWith('yandex-display-banner|CPM')).length,5);
  assert.equal(businessKeys.filter(key=>key.startsWith('yandex-display-video|CPM')).length,2);
  assert.equal(businessKeys.filter(key=>key.startsWith('urban-ads|CPM')).length,1);

  const dashHeaders=['Тип семантики/категории интересов','Объект рекламирования','Рекламная площадка','Таргетинги (интересы, соцдем, R&F)','Формат размещения','Формат расчетов','Показов, шт','CTR, %','Клики, шт','Прогноз Обращения, шт.','Прогноз Лиды по Last Click, шт','Прогноз CR, %','Прогноз CR, %','Цена за единицу с НДС'];
  const dashRows=[dashHeaders,['Медийное размещение - баннеры','ЖК Альфа','Яндекс.Директ','','Баннеры','CPM','500000','1.8E-3','900','—','0','-','-','52']];
  const dashTarget=[['Описание','Площадка','Показы, шт','CR1, %','CR2, %','CR3, %','Клики, шт','Все лиды, шт','Целевые лиды, шт','CPM'],['','Яндекс медийная реклама CPM'],['ЖК Альфа','','','','','','','','','']];
  const dashKeys=expectedCheckKeys({mode:'plan',sourceRows:dashRows,sourceHeaders:dashHeaders,headerRowIndex:0,targetRows:dashTarget,nameCol:0,placementCol:1,parseDisplayNumber});
  assert.deepEqual([...dashKeys].sort(),['2:2','2:3','2:6','2:8','2:9'],'scientific notation remains verifiable while dash-valued metrics are excluded rather than changed to zero');
});

test('DataLens fact table selection follows exact MP objects and infers only an unambiguous calendar month', () => {
  const candidates=[
    {id:'campaigns',rows:[['Кампания','Расход','Клики'],['Бульвар Грина','12','4']]},
    {id:'fact',rows:[['Объект продвижения','Расход с НДС, руб.','CTR, %','CR1, %','CR2, %','Клики, шт','Показы, шт'],['Бульвар Грина','100','0.2%','1%','10%','3','5000'],['Измайловский','200','0.3%','2%','20%','4','6000']]}
  ];
  const selection=rankFactTables(candidates,['Бульвар Грина','Измайловский']);
  assert.equal(selection.recommendedId,'fact');
  assert.match(selection.reason,/2 из 2/);
  const ambiguous=rankFactTables([candidates[1],{...candidates[1],id:'fact-copy'}],['Бульвар Грина','Измайловский']);
  assert.equal(ambiguous.recommendedId,null,'tied tables require a manual choice');
  const campaign=rankFactTables([{id:'utm',rows:[['UTMSource','Расход с НДС, руб.','Показы, шт','Клики, шт','Все лиды, шт'],['spb|agm|business|bulvar-grina|media|rtb_yandex',100,200,3,1],['spb|agm|business|izmajlovskij|media|rtb_yandex',200,300,4,2]]}],['Бульвар Грина','Измайловский']);
  assert.equal(campaign.recommendedId,'utm','UTM campaign slugs can identify Core objects');
  assert.equal(campaign.candidates[0].nameKind,'campaign');
  assert.equal(promotionColumn(['UTMSource']).index,0);
  assert.deepEqual(matchPromotionName('spb|agm|business|izmajlovskij|media',['Измайловский'],'campaign'),{value:'Измайловский',status:'matched'});
  const unrelated=rankFactTables([{id:'unrelated',rows:[['Название кампании','Расход, руб.','Показы, шт','Клики, шт'],['some-other-campaign',100,200,3]]}],['Бульвар Грина']);
  assert.equal(unrelated.recommendedId,null,'campaign table is never auto-selected without a matching MP object');
  assert.deepEqual(inferPlanMonth(['Бизнес_октябрь','01.10-31.10.2026']),{start:'01.10.2026',end:'31.10.2026'});
  assert.equal(inferPlanMonth(['Октябрь 2026','01.09.2026']),null,'conflicting periods are never guessed');
});

test('hidden browser placeholder does not cover the live screenshot or eat mouse clicks', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
    await page.setContent('<div id="browser-viewport" class="browser-viewport" style="width:500px;height:300px"><div id="browser-empty" class="browser-empty" hidden></div><img id="browser-image" hidden draggable="false"></div>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    assert.equal(await page.locator('#browser-empty').evaluate(el => getComputedStyle(el).display), 'none');
    await page.locator('#browser-image').evaluate(el => {
      el.hidden = false;
      el.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"/%3E';
      el.addEventListener('click', () => { window.browserImageClicked = true; });
    });
    await page.locator('#browser-image').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#browser-image').evaluate(el => getComputedStyle(el).display !== 'none'), true);
    await page.mouse.click(250, 150);
    assert.equal(await page.evaluate(() => window.browserImageClicked), true);
  } finally { await browser.close(); }
});

test('separate headless Chromium opens a fixture, reads DOM and interacts', async () => {
  const context = await chromium.launchPersistentContext(path.join(tempRoot, 'pw-profile'), { headless: true, viewport: { width: 900, height: 650 } });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(new URL('./fixtures/dom-smoke.html', import.meta.url).href);
    assert.equal(await page.title(), 'AGM Playwright smoke');
    assert.equal(await page.locator('#title').innerText(), 'Headless browser ready');
    await page.locator('#value').fill('isolated');
    await page.locator('#run').click();
    assert.equal(await page.locator('#result').innerText(), 'clicked:isolated');
    const relationModule = fs.readFileSync(new URL('../public/relation-audit.js', import.meta.url), 'utf8');
    const browserRelations = await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        const { relationRows } = await import(url);
        return relationRows([['ЖК Альфа'], ['ЖК Альфа']], 0, [['ЖК Альфа']], 0, value => value.toLowerCase());
      } finally { URL.revokeObjectURL(url); }
    }, relationModule);
    assert.equal(browserRelations[0].state, 'Неоднозначно · DataLens: 2, МП: 1');
  } finally { await context.close(); }
});

test('background polling does not reset the idle browser deadline', () => {
  const state = { lastActivity: 1000 };
  for (const url of ['/api/state', '/api/browser-snapshot?pageIndex=0', '/public/app.js', '/api/unknown']) {
    recordBrowserActivity(state, url, 61 * 60 * 1000);
  }
  assert.equal(state.lastActivity, 1000, 'an open but unused UI must still allow idle cleanup');
  for (const url of ['/api/connect', '/api/browser-action', '/api/read-plan', '/api/capture', '/api/apply', '/api/save']) {
    state.lastActivity = 1000;
    recordBrowserActivity(state, url, 5000);
    assert.equal(state.lastActivity, 5000, `${url} must keep an active browser alive`);
  }
});

test('stuck Chromium can be terminated by its isolated profile path', async () => {
  const profile = path.join(tempRoot, 'stuck-browser-profile');
  const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 800, height: 600 } });
  const closed = new Promise(resolve => context.once('close', resolve));
  try {
    await (context.pages()[0] || await context.newPage()).goto('about:blank');
    const killed = await forceKillChromium(profile);
    assert.ok(killed >= 1, 'no Chromium root process was found for this profile');
    const closedInTime = await Promise.race([closed.then(() => true), delay(8000).then(() => false)]);
    assert.equal(closedInTime, true, 'Chromium context remained open after its process tree was killed');
  } finally { await context.close().catch(() => {}); }
});

test('Python stdlib Excel reader parses an isolated generated workbook', () => {
  const workbook = path.join(tempRoot, 'smoke.xlsx');
  const pythonEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  const create = spawnSync(python, ['test/fixtures/make_xlsx.py', workbook], { encoding: 'utf8', env: pythonEnv });
  assert.equal(create.status, 0, create.stderr || create.stdout);
  const parse = spawnSync(python, ['parse_xlsx.py', workbook], { encoding: 'utf8', env: pythonEnv });
  assert.equal(parse.status, 0, parse.stderr || parse.stdout);
  const parsed = JSON.parse(parse.stdout);
  assert.equal(parsed.sheets[0].name, 'Smoke');
  assert.deepEqual(parsed.sheets[0].rows[1].values.slice(0, 2), ['Тестовая строка', '1250.5']);
  assert.equal(parsed.sheets[0].rows[1].cellFormats[2],'percent','Excel percent number formats must survive parsing');
});

test('hashed credentials validate and user storage keys do not collide', async () => {
  const first = await createUserRecord('analyst-one', 'SufficientlyLong!Pass1');
  const second = await createUserRecord('analyst-two', 'SufficientlyLong!Pass2');
  const users = path.join(tempRoot, 'users.json');
  writeUsers(users, [first, second]);
  const cache = new Map();
  const auth = `Basic ${Buffer.from('analyst-one:SufficientlyLong!Pass1').toString('base64')}`;
  const authenticated = await verifyBasicAuthorization(auth, [{ username: first.username, key: first.username, salt: Buffer.from(first.salt, 'base64'), hash: Buffer.from(first.hash, 'base64') }], cache);
  assert.equal(authenticated.username, 'analyst-one');
  assert.notEqual(makeUserId(first.username), makeUserId(second.username));
  if (process.platform !== 'win32') assert.equal(fs.statSync(users).mode & 0o777, 0o600);
});

test('server refuses a public bind without users and an HTTPS origin', () => {
  const rejected = spawnSync(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, AGM_HOST: '0.0.0.0', AGM_PORT: '18765', AGM_DATA_DIR: path.join(tempRoot, 'unsafe-server'), AGM_USERS_FILE: path.join(tempRoot, 'no-such-users.json'), AGM_ALLOWED_HOSTS: 'plans.example.ru', AGM_PLAYWRIGHT_MODULE: process.env.AGM_PLAYWRIGHT_MODULE || 'playwright' } });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stderr}${rejected.stdout}`, /AGM_USERS_FILE.*AGM_PUBLIC_ORIGIN/);
});

test('standalone server isolates users and completes Excel and DataLens fact flows with Core readback fixtures', async () => {
  const userFile = path.join(tempRoot, 'accounts.json');
  writeUsers(userFile, [
    await createUserRecord('first', 'AnotherLongPassword!1'),
    await createUserRecord('second', 'AnotherLongPassword!2'),
    await createUserRecord('administrator', 'AnotherLongPassword!3', { role: 'admin' })
  ]);
  const workbook = path.join(tempRoot, 'integration.xlsx');
  const make = spawnSync(python, ['test/fixtures/make_xlsx.py', workbook], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(make.status, 0, make.stderr || make.stdout);
  const planWorkbook = path.join(tempRoot, 'plan-integration.xlsx');
  const makePlan = spawnSync(python, ['test/fixtures/make_plan_xlsx.py', planWorkbook], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(makePlan.status, 0, makePlan.stderr || makePlan.stdout);
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, NODE_ENV: 'test', AGM_TEST_CORE_FIXTURE: '1', AGM_HOST: '127.0.0.1', AGM_PORT: String(port), AGM_DATA_DIR: path.join(tempRoot, 'server-data'), AGM_USERS_FILE: userFile, AGM_ALLOWED_HOSTS: '127.0.0.1', AGM_PUBLIC_ORIGIN: 'https://app.example.test', AGM_PLAYWRIGHT_MODULE: process.env.AGM_PLAYWRIGHT_MODULE || 'playwright', AGM_PYTHON: python }, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(child);
  let output = '';
  child.stdout.on('data', data => output += data.toString());
  child.stderr.on('data', data => output += data.toString());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(base);
      if (response.ok) { ready = true; break; }
    } catch { /* app is starting */ }
    await delay(250);
  }
  assert.ok(ready, `server did not start; output: ${output}`);
  const unauthenticated = await fetch(base);
  assert.equal(unauthenticated.status, 200);
  assert.doesNotMatch(unauthenticated.headers.get('www-authenticate') || '', /Basic/i);
  const page = await fetch(base);
  const clients = [{ Cookie: page.headers.get('set-cookie').split(';')[0] }];
  const pageHtml = await page.text();
  assert.match(pageHtml, /id="feedback-form"/);
  assert.match(pageHtml, /id="admin-login-form"/);
  const tokenMatch = pageHtml.match(/name="agm-token" content="([^"]+)"/);
  assert.ok(tokenMatch);
  const invalidTolerance = await fetch(`${base}/api/prepare-apply`, { method: 'POST', headers: { ...clients[0], Origin: 'https://app.example.test', 'X-AGM-Token': tokenMatch[1], 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'plan', amountTolerance: 11 }) });
  assert.equal(invalidTolerance.status, 400);
  assert.match((await invalidTolerance.json()).error, /от 1 до 10/);
  const apiHeaders = { ...clients[0], 'X-AGM-Token': tokenMatch[1], 'Content-Type': 'application/octet-stream', 'X-File-Name': 'smoke.xlsx' };
  const upload = await fetch(`${base}/api/workbook`, { method: 'POST', headers: { ...apiHeaders, Origin: 'https://app.example.test' }, body: fs.readFileSync(workbook) });
  assert.equal(upload.status, 200, await upload.text());
  const connect = await fetch(`${base}/api/connect`, { method: 'POST', headers: { ...clients[0], Origin: 'https://app.example.test', 'X-AGM-Token': tokenMatch[1], 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(connect.status, 200, connect.status === 200 ? '' : await connect.text());
  const connectState = await connect.json();
  const secondPage = await fetch(base);
  clients.push({ Cookie: secondPage.headers.get('set-cookie').split(';')[0] });
  const secondHtml = await secondPage.text();
  const secondToken = secondHtml.match(/name="agm-token" content="([^"]+)"/)?.[1];
  assert.ok(secondToken);
  const secondConnect = await fetch(`${base}/api/connect`, { method: 'POST', headers: { ...clients[1], Origin: 'https://app.example.test', 'X-AGM-Token': secondToken, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(secondConnect.status, 200, await secondConnect.text());
  const secondTab = await fetch(`${base}/api/new-tab`, { method: 'POST', headers: { ...clients[1], 'X-AGM-Token': secondToken, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(secondTab.status, 200, await secondTab.text());
  const secondState = await fetch(`${base}/api/state`, { headers: { ...clients[1], 'X-AGM-Token': secondToken } });
  const state = await secondState.json();
  assert.equal(state.workbook.length, 0);
  assert.equal(state.connected, true);
  assert.equal(state.pages.length, 2);
  const dataRoot = path.join(tempRoot, 'server-data', 'users');
  const userDirFromCookie = cookie => path.join(dataRoot, crypto.createHash('sha256').update(cookie.Cookie.split('=')[1]).digest('hex').slice(0, 32));
  const firstUserDir = userDirFromCookie(clients[0]);
  const secondUserDir = userDirFromCookie(clients[1]);
  assert.notEqual(firstUserDir, secondUserDir);
  assert.ok(fs.existsSync(path.join(firstUserDir, 'browser-profile')));
  assert.ok(fs.existsSync(path.join(secondUserDir, 'browser-profile')));
  assert.ok(fs.existsSync(path.join(firstUserDir, 'uploaded-plan.xlsx')));
  assert.equal(fs.existsSync(path.join(secondUserDir, 'uploaded-plan.xlsx')), false);
  const firstState = await fetch(`${base}/api/state`, { headers: { ...clients[0], 'X-AGM-Token': tokenMatch[1] } });
  const firstStateData = await firstState.json();
  assert.equal(firstStateData.workbook[0].name, 'Smoke');
  assert.equal(firstStateData.connected, true);
  assert.equal(firstStateData.pages.length, 1);

  const appJsonHeaders = { ...clients[0], Origin: 'https://app.example.test', 'X-AGM-Token': tokenMatch[1], 'Content-Type': 'application/json' };
  const uploadPlan = await fetch(`${base}/api/workbook`, { method: 'POST', headers: { ...apiHeaders, 'X-File-Name': 'plan.xlsx' }, body: fs.readFileSync(planWorkbook) });
  assert.equal(uploadPlan.status, 200, await uploadPlan.text());
  const sheetResponse = await fetch(`${base}/api/sheet?index=0`, { headers: { ...clients[0], 'X-AGM-Token': tokenMatch[1] } });
  assert.equal(sheetResponse.status, 200);
  const sheet = await sheetResponse.json();
  const sourceHeaders = sheet.rows[0].values;
  const sourceRow = sheet.rows[1].values;
  const planUrl = 'https://core.ag-media.ru/documents/mediaplans/999/edit';
  const openPlan = await fetch(`${base}/api/open-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ url: planUrl, pageIndex: connectState.activePage }) });
  assert.equal(openPlan.status, 200, openPlan.status === 200 ? '' : await openPlan.text());
  const planPage = await openPlan.json();
  const coreRead = await fetch(`${base}/api/read-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: planPage.activePage }) });
  assert.equal(coreRead.status, 200, coreRead.status === 200 ? '' : await coreRead.text());
  const coreTable = (await coreRead.json()).table.rows;
  const sourceForTarget = new Map([[2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 15]]);
  const checks = [...sourceForTarget.entries()].map(([colIndex, sourceColIndex]) => {
    const raw = sourceRow[sourceColIndex];
    const value = String(colIndex === 2 ? Number(raw) / 1000 : Number(raw));
    return { rowIndex: 2, colIndex, rowKey: 'ЖК Альфа', nameCol: 0, header: coreTable[0][colIndex], value,
      sourceRowIndex: 1, sourceColIndex, sourceNameCol: 0, sourceRowKey: 'ЖК Альфа', sourceHeader: sourceHeaders[sourceColIndex],
      sourceNameHeader: sourceHeaders[0], sourceValue: String(raw) };
  });
  const changes = checks.filter(check => check.colIndex !== 6 && check.colIndex !== 10).map(check => ({ rowIndex: check.rowIndex, colIndex: check.colIndex,
    rowKey: check.rowKey, header: check.header, value: check.value, oldValue: String(coreTable[check.rowIndex][check.colIndex] || '').trim() }));
  const prepare = await fetch(`${base}/api/prepare-apply`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: planPage.activePage, planUrl, nameCol: 0, mode: 'plan', sourceSheetIndex: 0, sourceHeaderRowIndex: 0, impressionsInThousands: true, changes, checks, issues: [] }) });
  assert.equal(prepare.status, 200, prepare.status === 200 ? '' : await prepare.text());
  const prepared = await prepare.json();
  const previewRead = await fetch(`${base}/api/read-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: planPage.activePage }) });
  assert.equal(previewRead.status, 200);
  assert.deepEqual((await previewRead.json()).table.rows, coreTable, 'creating a preview must not edit or save Core');
  const stagePlan = await fetch(`${base}/api/apply`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: prepared.id }), signal: AbortSignal.timeout(25000) })
    .catch(error => { throw new Error(`Plan staging timed out or disconnected: ${error.message}\nTest server output:\n${output}`); });
  assert.equal(stagePlan.status, 200, stagePlan.status === 200 ? '' : await stagePlan.text());
  const stagedPlan = await stagePlan.json();
  assert.equal(stagedPlan.ok, true, JSON.stringify(stagedPlan));
  assert.equal(stagedPlan.staged, true);
  assert.equal(stagedPlan.saved, false, 'staging must not save Core');
  const stagedRead = await fetch(`${base}/api/read-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: planPage.activePage }) });
  assert.deepEqual((await stagedRead.json()).table.rows[2].slice(2), ['100', '0.42', '2.22', '60', '900', '20', '12', '145', '14500'], 'draft values should appear in Core before persistent save');
  const unapprovedSave = await fetch(`${base}/api/save`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: prepared.id }) });
  assert.equal(unapprovedSave.status, 400);
  assert.match((await unapprovedSave.json()).error, /подтверждения пользователя/i);
  const unsavedPage = await fetch(`${base}/api/inspect-page`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: planPage.activePage }) });
  assert.match((await unsavedPage.json()).text, /Не сохранено/);
  const apply = await fetch(`${base}/api/save`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: prepared.id, approved: true }), signal: AbortSignal.timeout(25000) })
    .catch(error => { throw new Error(`User-approved save timed out or disconnected: ${error.message}\nTest server output:\n${output}`); });
  assert.equal(apply.status, 200, apply.status === 200 ? '' : await apply.text());
  const applied = await apply.json();
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.saved, true);
  assert.equal(applied.verifiedChecks, checks.length);
  assert.equal(applied.totalRows, 1);
  const finalCore = await fetch(`${base}/api/read-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: planPage.activePage }) });
  assert.equal(finalCore.status, 200, finalCore.status === 200 ? '' : await finalCore.text());
  assert.deepEqual((await finalCore.json()).table.rows[2].slice(2), ['100', '0.42', '2.22', '60', '900', '20', '12', '145', '14500']);
  const savedPage = await fetch(`${base}/api/inspect-page`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: planPage.activePage }) });
  assert.match((await savedPage.json()).text, /Сохранено/);

  const reportUrl = 'https://core.ag-media.ru/reports/client-reports/20/view';
  const openReport = await fetch(`${base}/api/browser-open`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ url: reportUrl, pageIndex: planPage.activePage }) });
  assert.equal(openReport.status, 200, openReport.status === 200 ? '' : await openReport.text());
  let reportPage = await openReport.json();
  const coreRouteCapture = await fetch(`${base}/api/capture`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: reportPage.activePage,
    period: { start: '01.09.2026', end: '30.09.2026' }, expectedObjects: ['ЖК Альфа'] }) });
  const coreRouteCaptureText=await coreRouteCapture.text();
  assert.equal(coreRouteCapture.status, 200, coreRouteCaptureText);
  assert.ok(JSON.parse(coreRouteCaptureText).selectedId, 'Core report links must capture their embedded DataLens tables');
  const legacyReportTab = await fetch(`${base}/api/browser-open`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ url: 'https://reports.core.ag-media.ru/fixture/datalens', pageIndex: reportPage.activePage }) });
  const legacyReportTabText=await legacyReportTab.text();
  assert.equal(legacyReportTab.status, 200, legacyReportTabText);
  reportPage = JSON.parse(legacyReportTabText);
  const capture = await fetch(`${base}/api/capture`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: reportPage.activePage,
    period: { start: '01.09.2026', end: '30.09.2026' }, expectedObjects: ['ЖК Альфа'] }) });
  assert.equal(capture.status, 200, capture.status === 200 ? '' : await capture.text());
  const captured = await capture.json();
  assert.equal(captured.candidates.length, 2, 'capture keeps multiple report tables available for matching');
  assert.ok(captured.selectedId);
  assert.match(captured.selectionReason, /совпали 1 из 1 названий МП/);
  assert.deepEqual(captured.preparation, ['фильтр «Текущий месяц» снят', 'период 01.09.2026 - 30.09.2026']);
  const selectedFactTable = captured.candidates.find(candidate => candidate.id === captured.selectedId);
  assert.ok(selectedFactTable.rows.some(row => row.includes('ЖК Альфа')), 'auto-selection follows Core object names instead of taking the largest/first table');
  const reportRows = selectedFactTable.rows;
  const factHeaders = reportRows[0];
  const factRow = reportRows[1];

  const factPlanUrl = 'https://core.ag-media.ru/documents/mediaplans/998/edit';
  const openFactPlan = await fetch(`${base}/api/open-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ url: factPlanUrl, pageIndex: reportPage.activePage }) });
  assert.equal(openFactPlan.status, 200, openFactPlan.status === 200 ? '' : await openFactPlan.text());
  const factPlanPage = await openFactPlan.json();
  const readFactPlan = await fetch(`${base}/api/read-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: factPlanPage.activePage }) });
  assert.equal(readFactPlan.status, 200, readFactPlan.status === 200 ? '' : await readFactPlan.text());
  const factCore = (await readFactPlan.json()).table.rows;
  const factSourceForTarget = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 9]]);
  const makeFactChecks = rows => [...factSourceForTarget.entries()].map(([colIndex, sourceColIndex]) => {
    const raw = rows[1][sourceColIndex];
    const normalized = Number(String(raw).replace('%', '')) / (colIndex === 2 || colIndex === 6 || colIndex === 7 ? 100 : colIndex === 8 ? 1000 : 1);
    return { rowIndex: 1, colIndex, rowKey: 'ЖК Альфа', nameCol: 0, header: factCore[0][colIndex], value: String(Number(normalized.toFixed(6))),
      sourceRowIndex: 1, sourceColIndex, sourceNameCol: 0, sourceRowKey: 'ЖК Альфа', sourceHeader: factHeaders[sourceColIndex],
      sourceNameHeader: factHeaders[0], sourceValue: String(raw) };
  });
  const factChecks = makeFactChecks(reportRows);
  const makeFactChanges = checks => checks.map(check => ({ ...check,
    oldValue: String(factCore[check.rowIndex][check.colIndex] || '').trim() }));
  const factChanges = makeFactChanges(factChecks);
  const useReport = await fetch(`${base}/api/use-report-table`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: captured.selectedId }) });
  assert.equal(useReport.status, 200, useReport.status === 200 ? '' : await useReport.text());
  const incompleteFactPreview = await fetch(`${base}/api/prepare-apply`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: factPlanPage.activePage, planUrl: factPlanUrl,
    nameCol: 0, mode: 'fact', sourceId: captured.selectedId, impressionsInThousands: true, changes: factChanges.slice(1), checks: factChecks.slice(1), issues: [] }) });
  assert.equal(incompleteFactPreview.status, 400);
  assert.match((await incompleteFactPreview.json()).error, /построчной сверки неполный/i);
  const prepareStaleFact = await fetch(`${base}/api/prepare-apply`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: factPlanPage.activePage, planUrl: factPlanUrl,
    nameCol: 0, mode: 'fact', sourceId: captured.selectedId, impressionsInThousands: true, changes: factChanges, checks: factChecks, issues: [] }) });
  assert.equal(prepareStaleFact.status, 200, prepareStaleFact.status === 200 ? '' : `${await prepareStaleFact.text()}\n${JSON.stringify({ factHeaders, factRow, factChecks })}`);
  const stalePrepared = await prepareStaleFact.json();
  assert.equal(stalePrepared.changes.length, factChanges.length);
  const mutateSource = await fetch(`${base}/api/browser-action`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: reportPage.activePage, action: 'click', x: 80, y: 20 }) });
  assert.equal(mutateSource.status, 200, mutateSource.status === 200 ? '' : await mutateSource.text());
  const mutatedCapture = await fetch(`${base}/api/capture`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: reportPage.activePage }) });
  const mutatedCaptureText = await mutatedCapture.text();
  assert.equal(mutatedCapture.status, 200, mutatedCaptureText);
  assert.equal(JSON.parse(mutatedCaptureText).candidates.find(candidate=>candidate.id===captured.selectedId)?.rows[1][1], '120001', 'the fixture click must alter the embedded DataLens source');
  const staleApply = await fetch(`${base}/api/apply`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: stalePrepared.id }) });
  assert.equal(staleApply.status, 400);
  assert.match((await staleApply.json()).error, /DataLens изменился после предпросмотра/i);
  const coreAfterBlockedStaleApply = await fetch(`${base}/api/read-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: factPlanPage.activePage }) });
  assert.equal(coreAfterBlockedStaleApply.status, 200);
  assert.deepEqual((await coreAfterBlockedStaleApply.json()).table.rows[1].slice(1), ['1', '0.01', '1', '1', '1', '0.01', '0.01', '1']);

  const recaptureFact = await fetch(`${base}/api/capture`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: reportPage.activePage,
    period: { start: '01.09.2026', end: '30.09.2026' }, expectedObjects: ['ЖК Альфа'] }) });
  assert.equal(recaptureFact.status, 200, recaptureFact.status === 200 ? '' : await recaptureFact.text());
  const refreshedCapture = await recaptureFact.json();
  const refreshedRows = refreshedCapture.candidates.find(candidate => candidate.id === refreshedCapture.selectedId).rows;
  assert.equal(refreshedRows[1][1], '120001');
  const refreshedChecks = makeFactChecks(refreshedRows);
  const refreshedChanges = makeFactChanges(refreshedChecks);
  const selectRefreshedReport = await fetch(`${base}/api/use-report-table`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: refreshedCapture.selectedId }) });
  assert.equal(selectRefreshedReport.status, 200, selectRefreshedReport.status === 200 ? '' : await selectRefreshedReport.text());
  const prepareFact = await fetch(`${base}/api/prepare-apply`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: factPlanPage.activePage, planUrl: factPlanUrl,
    nameCol: 0, mode: 'fact', sourceId: refreshedCapture.selectedId, impressionsInThousands: true, changes: refreshedChanges, checks: refreshedChecks, issues: [] }) });
  assert.equal(prepareFact.status, 200, prepareFact.status === 200 ? '' : await prepareFact.text());
  const factPrepared = await prepareFact.json();
  assert.equal(factPrepared.changes.length, refreshedChanges.length);
  const stageFact = await fetch(`${base}/api/apply`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: factPrepared.id }), signal: AbortSignal.timeout(25000) })
    .catch(error => { throw new Error(`DataLens-to-Core fact staging timed out or disconnected: ${error.message}\nTest server output:\n${output}`); });
  assert.equal(stageFact.status, 200, stageFact.status === 200 ? '' : await stageFact.text());
  const stagedFact = await stageFact.json();
  assert.equal(stagedFact.ok, true, JSON.stringify(stagedFact));
  assert.equal(stagedFact.saved, false);
  const unapprovedFactPage = await fetch(`${base}/api/inspect-page`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: factPlanPage.activePage }) });
  assert.match((await unapprovedFactPage.json()).text, /Не сохранено/);
  const saveFact = await fetch(`${base}/api/save`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ id: factPrepared.id, approved: true }), signal: AbortSignal.timeout(25000) })
    .catch(error => { throw new Error(`User-approved fact save timed out or disconnected: ${error.message}\nTest server output:\n${output}`); });
  assert.equal(saveFact.status, 200, saveFact.status === 200 ? '' : await saveFact.text());
  const factApplied = await saveFact.json();
  assert.equal(factApplied.ok, true, JSON.stringify(factApplied));
  assert.equal(factApplied.saved, true);
  assert.equal(factApplied.verifiedChecks, refreshedChecks.length);
  const finalFact = await fetch(`${base}/api/read-plan`, { method: 'POST', headers: appJsonHeaders, body: JSON.stringify({ pageIndex: factPlanPage.activePage }) });
  assert.equal(finalFact.status, 200, finalFact.status === 200 ? '' : await finalFact.text());
  assert.deepEqual((await finalFact.json()).table.rows[1].slice(1), ['120001', '0.0042', '900', '20', '12', '0.0222', '0.6', '140']);

  const uiBrowser = await chromium.launch({ headless: true });
  try {
    const uiContext = await uiBrowser.newContext();
    const uiPage = await uiContext.newPage();
    await uiContext.addCookies([{ name: 'agm-session', value: clients[1].Cookie.split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
    const pageErrors = [];
    uiPage.on('pageerror', error => pageErrors.push(error.message));
    await uiPage.goto(base, { waitUntil: 'domcontentloaded' });
    assert.equal(await uiPage.locator('.rule input[type="checkbox"]:visible').count(), 0, 'fixed rules should not look like editable checkboxes');
    assert.equal(await uiPage.locator('.rule-status').count(), 5);
    assert.equal(await uiPage.locator('#amount-tolerance').isEditable(), true);
    assert.equal(await uiPage.locator('#amount-tolerance').getAttribute('min'), '1');
    assert.equal(await uiPage.locator('#amount-tolerance').getAttribute('max'), '10');
    const beforeTheme = await uiPage.locator('html').getAttribute('data-theme');
    await uiPage.locator('#theme-toggle').click();
    assert.notEqual(await uiPage.locator('html').getAttribute('data-theme'), beforeTheme, 'theme toggle must update the page theme');
    await uiPage.locator('#connect').click();
    await uiPage.waitForFunction(() => document.querySelector('#connection strong')?.textContent === 'Браузер подключён');
    assert.deepEqual(pageErrors, [], 'application UI must initialize without JavaScript errors');
    await uiPage.locator('#file').setInputFiles(planWorkbook);
    await uiPage.locator('#plan-url').fill('https://core.ag-media.ru/documents/mediaplans/999/edit');
    await uiPage.locator('#open-plan').click();
    await uiPage.locator('#read-plan').click();
    await uiPage.waitForFunction(() => document.querySelector('#prepare-plan')?.disabled === false);
    await uiPage.locator('#prepare-plan').click();
    await uiPage.locator('#apply-proposal').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => { throw new Error(`Plan preview did not render: toast=${await uiPage.locator('#toast').innerText().catch(()=>'<no toast>')}\n${await uiPage.locator('#audit-results').innerText().catch(()=>'<no preview>')}\n${error.message}`); });
    assert.match(await uiPage.locator('#audit-results').innerText(), /В МП есть строки без соответствия в источнике.*ЖК Бета.*останутся без изменений/s);
    assert.equal(await uiPage.locator('#approve-save').count(), 0, 'save approval must not appear before the form is staged');
    const partialButton=uiPage.locator('#apply-partial');
    const actionButton=await partialButton.count()?partialButton:uiPage.locator('#apply-proposal');
    await actionButton.click();
    await uiPage.locator('#approve-save').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => { throw new Error(`Stage did not complete: toast=${await uiPage.locator('#toast').innerText().catch(()=>'<no toast>')}\n${await uiPage.locator('#audit-results').innerText().catch(()=>'<no preview>')}\n${error.message}`); });
    const uiSessionCookie = (await uiContext.cookies(base)).find(cookie => cookie.name === 'agm-session')?.value;
    const uiToken = await uiPage.locator('meta[name="agm-token"]').getAttribute('content');
    const secondJsonHeaders = { Cookie: `agm-session=${uiSessionCookie}`, 'X-AGM-Token': uiToken, 'Content-Type': 'application/json' };
    const uiDraftState = await fetch(`${base}/api/inspect-page`, { method: 'POST', headers: secondJsonHeaders, body: JSON.stringify({ pageIndex: 0 }) });
    const uiDraftText = await uiDraftState.text();
    assert.equal(uiDraftState.status, 200, uiDraftText);
    assert.match(JSON.parse(uiDraftText).text, /Не сохранено/);
    uiPage.once('dialog', dialog => dialog.accept());
    await uiPage.locator('#approve-save').click();
    try {
      await uiPage.waitForFunction(() => document.querySelector('#audit-results')?.innerText.includes('Изменения сохранены'), null, { timeout: 20000 });
    } catch {
      const uiStatus = await uiPage.locator('#audit-results').innerText().catch(() => '<нет текста интерфейса>');
      const coreStatus = await fetch(`${base}/api/inspect-page`, { method: 'POST', headers: secondJsonHeaders, body: JSON.stringify({ pageIndex: 0 }) }).then(response => response.text()).catch(error => String(error));
      throw new Error(`UI save flow did not finish. UI: ${uiStatus}\nCore: ${coreStatus}\nServer: ${output}`);
    }
    const uiSavedState = await fetch(`${base}/api/inspect-page`, { method: 'POST', headers: secondJsonHeaders, body: JSON.stringify({ pageIndex: 0 }) });
    const uiSavedText = await uiSavedState.text();
    assert.equal(uiSavedState.status, 200, uiSavedText);
    assert.match(JSON.parse(uiSavedText).text, /Сохранено/);
  } finally {
    await uiBrowser.close();
  }

  const feedbackForm = new FormData();
  feedbackForm.set('category', 'Идея'); feedbackForm.set('message', 'Проверка тестовой формы');
  feedbackForm.append('attachments', new Blob(['тестовое вложение'], { type: 'text/plain' }), 'notes.txt');
  const feedback = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { ...clients[0], Origin: 'https://app.example.test', 'X-AGM-Token': tokenMatch[1] }, body: feedbackForm });
  assert.equal(feedback.status, 201);
  assert.equal(fs.readFileSync(path.join(tempRoot, 'server-data', 'feedback.jsonl'), 'utf8').trim().split('\n').length, 1);
  const feedbackResult = await feedback.json();
  const storedFeedback = JSON.parse(fs.readFileSync(path.join(tempRoot, 'server-data', 'feedback.jsonl'), 'utf8').trim());
  assert.equal(storedFeedback.attachments[0].name, 'notes.txt');
  assert.deepEqual(fs.readFileSync(path.join(tempRoot, 'server-data', 'feedback-files', feedbackResult.id, storedFeedback.attachments[0].id)), Buffer.from('тестовое вложение'));
  const forbiddenFeedback = await fetch(`${base}/api/admin/feedback`, { headers: { ...clients[0], 'X-AGM-Token': tokenMatch[1] } });
  assert.equal(forbiddenFeedback.status, 403);
  const adminPage = await fetch(base);
  const adminClient = { Cookie: adminPage.headers.get('set-cookie').split(';')[0] };
  const adminHtml = await adminPage.text();
  const adminToken = adminHtml.match(/name="agm-token" content="([^"]+)"/)?.[1];
  assert.ok(adminToken);
  const adminLogin = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { ...adminClient, Origin: 'https://app.example.test', 'X-AGM-Token': adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'administrator', password: 'AnotherLongPassword!3' }) });
  assert.equal(adminLogin.status, 200, await adminLogin.text());
  const adminState = await fetch(`${base}/api/state`, { headers: { ...adminClient, 'X-AGM-Token': adminToken } });
  assert.equal((await adminState.json()).isAdmin, true);
  const adminFeedback = await fetch(`${base}/api/admin/feedback`, { headers: { ...adminClient, 'X-AGM-Token': adminToken } });
  const adminFeedbackText = await adminFeedback.text();
  assert.equal(adminFeedback.status, 200, adminFeedbackText);
  const adminPayload = JSON.parse(adminFeedbackText);
  assert.equal(adminPayload.total, 1);
  assert.equal(adminPayload.items[0].message, 'Проверка тестовой формы');
  assert.equal(adminPayload.items[0].attachments[0].name, 'notes.txt');
  const downloadedFeedbackFile = await fetch(`${base}/api/admin/feedback-file?item=${feedbackResult.id}&file=${storedFeedback.attachments[0].id}`, { headers: { ...adminClient, 'X-AGM-Token': adminToken } });
  assert.equal(downloadedFeedbackFile.status, 200);
  assert.deepEqual(Buffer.from(await downloadedFeedbackFile.arrayBuffer()), Buffer.from('тестовое вложение'));
  const forbiddenFeedbackFile = await fetch(`${base}/api/admin/feedback-file?item=${feedbackResult.id}&file=${storedFeedback.attachments[0].id}`, { headers: { ...clients[0], 'X-AGM-Token': tokenMatch[1] } });
  assert.equal(forbiddenFeedbackFile.status, 403);

  const refreshedApp = await fetch(base, { headers: clients[0] });
  assert.equal(refreshedApp.status, 200);
  const refreshedCookie = refreshedApp.headers.get('set-cookie')?.split(';')[0];
  assert.ok(refreshedCookie);
  assert.notEqual(refreshedCookie, clients[0].Cookie, 'a full app reload rotates the internal session cookie');
  assert.equal(fs.existsSync(path.join(firstUserDir, 'uploaded-plan.xlsx')), false, 'reload removes the old uploaded workbook');
  assert.equal(fs.existsSync(path.join(firstUserDir, 'browser-profile')), false, 'reload removes the old Core/DataLens profile and cookies');
  const refreshedToken = (await refreshedApp.text()).match(/name="agm-token" content="([^"]+)"/)?.[1];
  assert.ok(refreshedToken);
  const refreshedStateResponse = await fetch(`${base}/api/state`, { headers: { Cookie: refreshedCookie, 'X-AGM-Token': refreshedToken } });
  const refreshedState = await refreshedStateResponse.json();
  assert.deepEqual(refreshedState.workbook, [], 'a reloaded app starts without the prior Excel file');
  assert.equal(refreshedState.connected, false, 'a reloaded app starts with no connected Core browser');
});
