export function relationRows(sourceRows, sourceColumn, targetRows, targetColumn, normalize, sourceLabel = 'DataLens', targetLabel = 'МП') {
  const collect = (rows, column) => {
    const values = new Map();
    for (const row of rows) {
      const value = String(row[column] ?? '').trim();
      if (!value || /^(?:итого|всего|total)(?:\s|$)/i.test(value) || /ad\s?river|bot\s?(?:factor|faqtor)|бот\s?фактор/i.test(value)) continue;
      const key = normalize(value);
      if (!key) continue;
      if (!values.has(key)) values.set(key, []);
      values.get(key).push(value);
    }
    return values;
  };
  const source = collect(sourceRows, sourceColumn), target = collect(targetRows, targetColumn);
  const keys = [...new Set([...source.keys(), ...target.keys()])].sort();
  return keys.map(key => {
    const sourceValues = source.get(key) || [], targetValues = target.get(key) || [];
    let state;
    if (sourceValues.length > 1 || targetValues.length > 1) state = `Неоднозначно · ${sourceLabel}: ${sourceValues.length}, ${targetLabel}: ${targetValues.length}`;
    else if (sourceValues.length && targetValues.length) state = 'Совпало';
    else if (sourceValues.length) state = `Нет описания в ${targetLabel} · ${sourceLabel}: ${sourceValues.length}`;
    else state = `Нет объекта в ${sourceLabel} · ${targetLabel}: ${targetValues.length}`;
    const label = values => {
      if (!values.length) return '—';
      const unique = [...new Set(values)];
      return `${unique.join(' / ')}${values.length > 1 ? ` (строк: ${values.length})` : ''}`;
    };
    return { description: label(targetValues), object: label(sourceValues), state, sourceCount: sourceValues.length, targetCount: targetValues.length };
  });
}
