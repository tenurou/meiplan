import { relationRows } from './relation-audit.js';

export function identityAlerts(sourceRows, sourceNameColumn, targetRows, targetNameColumn, normalize, sourceLabel, targetLabel = 'МП') {
  if (sourceNameColumn < 0 || targetNameColumn < 0) {
    return [{ type: 'error', text: `${sourceLabel} ↔ ${targetLabel}: не нашёл однозначные колонки названия строки; построчная связь не проверена.` }];
  }
  const relations = relationRows(sourceRows, sourceNameColumn, targetRows, targetNameColumn, normalize, sourceLabel, targetLabel);
  if (!relations.length) return [{ type: 'warn', text: `${sourceLabel} ↔ ${targetLabel}: нет сравнимых строк после исключений; построчная связь не подтверждена.` }];
  const mismatches = relations.filter(row => row.state !== 'Совпало');
  if (mismatches.length) {
    const details = mismatches.slice(0, 5).map(row => `${row.object} ↔ ${row.description}: ${row.state}`).join('; ');
    return [{ type: 'error', text: `${sourceLabel} ↔ ${targetLabel}: ${relations.length - mismatches.length}/${relations.length} связей однозначны; ${details}${mismatches.length > 5 ? '…' : ''}` }];
  }
  return [{ type: 'pass', text: `${sourceLabel} ↔ ${targetLabel}: все ${relations.length} строк связаны однозначно.` }];
}

export function auditIsClear(available, alerts) {
  return Boolean(available) && Array.isArray(alerts) && alerts.length > 0 && alerts.every(alert => alert?.type === 'pass');
}
