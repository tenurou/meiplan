const missingSourceValues = new Set(['-', '–', '—', '−', 'null', 'n/a', 'na']);
const spreadsheetError = /^#(?:DIV\/0!|N\/A|N\/A\?|VALUE!|REF!|NAME\?|NUM!|NULL!|SPILL!|CALC!|FIELD!|BLOCKED!|UNKNOWN!|GETTING_DATA)$/i;

export function isSpreadsheetErrorValue(value) {
  return spreadsheetError.test(String(value ?? '').trim());
}

export function isMissingSourceValue(value) {
  const text = String(value ?? '').trim();
  return missingSourceValues.has(text.toLocaleLowerCase('ru-RU')) || isSpreadsheetErrorValue(text);
}

export function parseNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value ?? '').trim();
  if (!text || isMissingSourceValue(text)) return null;
  text = text.replace(/[₽$€%\s\u00a0\u202f]/g, '').replace(/[−–]/g, '-');
  if (!text || !/\d/.test(text)) return null;

  // Excel may serialize fractions such as CTR as 2.09999E-3.
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    const number = Number(text.replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }

  // For localized currency text, the rightmost comma/dot is the decimal mark.
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (comma >= 0) {
    text = text.replace(',', '.');
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
