// Google Apps Script bridge for the MeiPlan Smartis importer.
// Replace the placeholder with the same random secret entered in the app's
// administrator settings. Keep this script private to its owner.
const SHARED_SECRET = 'REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS';
const ALLOWED_SPREADSHEET_ID = '1YehJBnYD02D9xJzqISHhZDmQxaLNIG4Yk_dZ4mC8uOA';

function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents || '{}');
    if (request.secret !== SHARED_SECRET) return json({ ok: false, error: 'Неверный ключ интеграции.' });
    if (request.spreadsheetId !== ALLOWED_SPREADSHEET_ID) return json({ ok: false, error: 'Для интеграции разрешена только настроенная таблица ЛСР.' });

    const spreadsheet = SpreadsheetApp.openById(ALLOWED_SPREADSHEET_ID);
    if (request.action === 'metadata') {
      return json({
        spreadsheetId: spreadsheet.getId(),
        properties: { title: spreadsheet.getName() },
        sheets: spreadsheet.getSheets().map((sheet, index) => ({
          properties: {
            sheetId: sheet.getSheetId(), title: sheet.getName(), index,
            gridProperties: { rowCount: sheet.getMaxRows(), columnCount: sheet.getMaxColumns() }
          }
        }))
      });
    }

    const sheet = spreadsheet.getSheets().find(item => item.getName() === request.sheetTitle);
    if (!sheet) return json({ ok: false, error: 'Лист таблицы не найден.' });

    if (request.action === 'values') {
      const lastRow = sheet.getLastRow();
      return json({ values: lastRow ? sheet.getRange(1, 1, lastRow, 11).getDisplayValues() : [] });
    }

    if (request.action === 'formats') {
      return json({ ok: true, formats: [] });
    }

    if (request.action === 'batchUpdate') {
      for (const item of request.requests || []) {
        if (item.insertDimension?.range?.dimension === 'ROWS') {
          const range = item.insertDimension.range;
          sheet.insertRowsBefore(range.startIndex + 1, range.endIndex - range.startIndex);
        } else if (item.copyPaste?.pasteType === 'PASTE_FORMAT') {
          const copy = item.copyPaste, sourceRow = copy.source.startRowIndex + 1;
          for (let row = copy.destination.startRowIndex; row < copy.destination.endRowIndex; row++) {
            sheet.getRange(sourceRow, 1, 1, 11).copyTo(sheet.getRange(row + 1, 1, 1, 11), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
          }
        } else if (item.updateCells) {
          const update = item.updateCells, row = update.range.startRowIndex + 1, col = update.range.startColumnIndex + 1;
          const values = (update.rows || []).map(line => (line.values || []).map(cell => {
            const value = String(cell.userEnteredValue?.stringValue ?? '');
            return value.startsWith('=') ? `'${value}` : value;
          }));
          if (values.length) sheet.getRange(row, col, values.length, values[0].length).setValues(values);
        } else {
          return json({ ok: false, error: 'Apps Script получил неподдерживаемую операцию.' });
        }
      }
      return json({ ok: true });
    }
    return json({ ok: false, error: 'Неизвестная операция интеграции.' });
  } catch (error) {
    return json({ ok: false, error: String(error && error.message || error).slice(0, 300) });
  }
}

function json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
