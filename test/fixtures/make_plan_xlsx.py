import sys
import zipfile
from xml.sax.saxutils import escape

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'

HEADERS = [
    'Название кампании',
    'Тип семантики/категории интересов',
    'Таргетинги (интересы, соцдем, R&F)',
    'Показы, шт', 'CTR, %', 'Прогноз CR', 'Прогноз CR', 'Клики, шт',
    'Прогноз обращения', 'Прогноз лиды по Last Click', 'CPM',
    'Рекламная площадка', 'Формат размещения', 'Формат расчётов',
    'Цена за единицу с НДС', 'Стоимость с НДС'
]
VALUES = ['ЖК Альфа', 'Медийное размещение Баннер', '', 100000, 0.42, 2.22, 60, 900, 20, 12, 145,
          'Яндекс.Директ', 'Баннеры', 'CPM', 145, 14500]

def column_name(index):
    result = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result

def cell_xml(column, row_number, value):
    ref = f'{column_name(column)}{row_number}'
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'

def make(path):
    header_cells = ''.join(cell_xml(i + 1, 1, value) for i, value in enumerate(HEADERS))
    value_cells = ''.join(cell_xml(i + 1, 2, value) for i, value in enumerate(VALUES))
    sheet = f'<worksheet xmlns="{MAIN}"><sheetData><row r="1">{header_cells}</row><row r="2">{value_cells}</row></sheetData></worksheet>'
    parts = {
        'xl/workbook.xml': f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets><sheet name="План" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': sheet,
    }
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as workbook:
        for name, value in parts.items():
            workbook.writestr(name, value)

if __name__ == '__main__':
    make(sys.argv[1])
