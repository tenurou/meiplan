import { matchPromotionName, promotionColumn } from './report-selector.js';
import { parseNumericValue, isMissingSourceValue } from './numeric.js';

const norm = value => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^\p{L}\p{N}%]+/gu,' ').trim().replace(/\s+/g,' ');
const columns = (headers, predicate) => headers.map((header,index)=>predicate(norm(header))?index:-1).filter(index=>index>=0);
const unique = (headers,predicate) => { const found=columns(headers,predicate); return found.length===1?found[0]:-1; };
const number = value => isMissingSourceValue(value) ? null : parseNumericValue(value);
const percent = value => { const parsed=number(value); return parsed===null?null:(String(value).includes('%')?parsed/100:null); };
const metric = header => {
  const value=norm(header);
  if (/расход|стоимост|бюджет/.test(value)&&!/(?:^| )ак(?: |$)|сбор/.test(value)) return 'spend';
  if (/показ/.test(value)) return 'impressions';
  if (/клик/.test(value)) return 'clicks';
  if (/все лид|валов.*лид|^лиды(?: |$)/.test(value)) return 'allLeads';
  if (/целев.*лид|^цо(?: |$)/.test(value)) return 'targetLeads';
  if (/^ctr(?: |$)/.test(value)) return 'ctr';
  if (/^cr1(?: |$)/.test(value)) return 'cr1';
  if (/^cr2(?: |$)/.test(value)) return 'cr2';
  if (/^cr3(?: |$)/.test(value)) return 'cr3';
  if (/^cpc(?: |$)|^cpc\b|^срс(?: |$)/.test(value)) return 'cpc';
  if (/^cpm(?: |$)|^срм(?: |$)/.test(value)) return 'cpm';
  if (/^cpl(?: |$)/.test(value)) return 'cpl';
  if (/^cpa(?: |$)/.test(value)) return 'cpa';
  return '';
};
const serialize = value => Number.isFinite(value) ? String(Number(value.toFixed(8))) : '';

const canonicalMetrics=[
  ['spend','Расход с НДС, руб.'],['impressions','Показы, шт'],['clicks','Клики, шт'],
  ['ctr','CTR, %'],['cr1','CR1, %'],['cr2','CR2, %'],['cr3','CR3, %'],
  ['allLeads','Все лиды, шт'],['targetLeads','Целевые лиды, шт'],['cpc','CPC, руб.'],['cpm','CPM, руб.'],['cpl','CPL, руб.'],['cpa','CPA, руб.']
];

/** Normalize compatible DataLens tables captured from different report tabs. */
export function combineFactSources(sources, expectedObjects=[]) {
  const headers=['Объект продвижения',...canonicalMetrics.map(([,label])=>label)],rows=[],issues=[],seen=new Set();
  for(const source of sources){
    const sourceHeaders=source.rows?.[0]||[],promotion=promotionColumn(sourceHeaders);
    if(promotion.index<0){issues.push(`${source.tabLabel||'Источник'}: нет однозначного столбца объекта, кампании или UTM Source.`);continue;}
    const mappings=canonicalMetrics.map(([key])=>{
      const found=columns(sourceHeaders,header=>metric(header)===key);
      return found.length===1?found[0]:-1;
    });
    const rowsWithData=source.rows.slice(1);
    for(const rawRow of rowsWithData){
      const rawName=String(rawRow[promotion.index]??'').trim();
      if(!rawName||/^(?:итого|всего|total)\b/i.test(rawName)||/ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(rawName))continue;
      const match=matchPromotionName(rawName,expectedObjects,promotion.kind);
      if(match.status!=='matched'){issues.push(`${rawName}: объект не связан с единственной строкой МП.`);continue;}
      const values=mappings.map((index,metricIndex)=>index<0?'':rawRow[index]??'');
      const duplicateKey=JSON.stringify([match.value,...values.map(value=>String(value).trim())]);
      if(seen.has(duplicateKey)){issues.push(`${rawName}: одинаковая строка уже учтена из другого источника; повтор не суммирован.`);continue;}
      seen.add(duplicateKey);rows.push([match.value,...values]);
    }
    if(mappings.some(index=>index<0))issues.push(`${source.tabLabel||'Источник'}: часть метрик не найдена однозначно; пустые поля останутся без изменений.`);
  }
  return {headers,rows:[headers,...rows],issues};
}

/**
 * Collapse DataLens campaign/UTM rows only when each row resolves to one exact
 * MP description. Additive metrics are summed; rate metrics are recomputed from
 * summed funnel counts. Ambiguous identity or missing denominators stay visible.
 */
export function aggregateFactRows({headers, rows, nameColumn = -1, nameKind = 'object', expectedObjects = []}) {
  const promotion=nameColumn>=0?{index:nameColumn,kind:nameKind}:promotionColumn(headers);
  if(promotion.index<0)return {rows,groups:[],issues:['В таблице DataLens не найден однозначный объект, кампания или UTM Source.']};
  const groups=new Map(), issues=[];
  for(const [sourceIndex,row] of rows.entries()){
    const rawName=String(row[promotion.index]??'').trim();
    if(!rawName||/^(?:итого|всего|total)\b/i.test(rawName)||/ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(rawName))continue;
    const match=matchPromotionName(rawName,expectedObjects,promotion.kind);
    if(match.status!=='matched'){
      issues.push(`${rawName}: ${match.status==='ambiguous'?'название неоднозначно':'название не сопоставлено'} с описанием строки МП.`);
      continue;
    }
    if(!groups.has(match.value))groups.set(match.value,[]);
    groups.get(match.value).push({row,sourceIndex,rawName});
  }
  const additive=new Map();
  for(const key of ['spend','impressions','clicks','allLeads','targetLeads']){
    const cols=columns(headers,h=>metric(h)===key);
    if(cols.length===1)additive.set(key,cols[0]);
  }
  const rateDenominator={ctr:'impressions',cr1:'clicks',cr2:'allLeads',cr3:'targetLeads'};
  const aggregated=[];
  for(const [object,items] of groups){
    const out=[...items[0].row];out[promotion.index]=object;
    const sums={};
    for(const [key,index] of additive){
      const values=items.map(item=>number(item.row[index]));
      if(values.every(value=>value!==null)){sums[key]=values.reduce((sum,value)=>sum+value,0);out[index]=serialize(sums[key]);}
      else if(items.length>1)issues.push(`${object}: нельзя безопасно сложить «${headers[index]}» — есть пустые или нечисловые значения.`);
    }
    if(items.length>1){
      for(const [key,denomKey] of Object.entries(rateDenominator)){
        const rateCols=columns(headers,h=>metric(h)===key), denominatorIndex=additive.get(denomKey);
        if(rateCols.length!==1)continue;
        if(denominatorIndex===undefined||sums[denomKey]===undefined){issues.push(`${object}: нельзя агрегировать ${headers[rateCols[0]]} без подтверждённого знаменателя «${denomKey}».`);out[rateCols[0]]='';continue;}
        let numerator=0,complete=true;
        for(const item of items){
          const rate=percent(item.row[rateCols[0]]),denominator=number(item.row[denominatorIndex]);
          if(rate===null||denominator===null){complete=false;break;}
          numerator+=rate*denominator;
        }
        out[rateCols[0]]=complete&&sums[denomKey]!==0?`${serialize(numerator/sums[denomKey]*100)}%`:'';
        if(!complete||sums[denomKey]===0)issues.push(`${object}: процент «${headers[rateCols[0]]}» оставлен пустым: не хватает проверяемых исходных значений.`);
      }
      for(const [key,numeratorKey,denominatorKey,scale] of [['cpc','spend','clicks',1],['cpm','spend','impressions',1000],['cpl','spend','allLeads',1],['cpa','spend','targetLeads',1]]){
        const metricCols=columns(headers,h=>metric(h)===key);
        if(metricCols.length!==1)continue;
        const denominator=sums[denominatorKey],spend=sums[numeratorKey];
        if(spend!==undefined&&denominator!==undefined&&denominator!==0)out[metricCols[0]]=serialize(spend/(denominator/scale));
        else {out[metricCols[0]]='';issues.push(`${object}: нельзя пересчитать ${headers[metricCols[0]]} без суммы и знаменателя.`);}
      }
    }
    aggregated.push({row:out,object,sourceRows:items.map(item=>item.sourceIndex),sourceNames:items.map(item=>item.rawName)});
  }
  return {rows:[headers,...aggregated.map(item=>item.row)],groups:aggregated,issues};
}
