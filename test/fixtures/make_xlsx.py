import sys
import zipfile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

def make(path):
    parts = {
        "xl/workbook.xml": f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets><sheet name="Smoke" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/styles.xml": f'<styleSheet xmlns="{MAIN}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Описание</t></is></c><c r="B1" t="inlineStr"><is><t>Бюджет</t></is></c><c r="C1" t="inlineStr"><is><t>CTR, %</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Тестовая строка</t></is></c><c r="B2"><v>1250.5</v></c><c r="C2" s="1"><v>0.0042</v></c></row></sheetData></worksheet>',
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as book:
        for name, value in parts.items():
            book.writestr(name, value)

if __name__ == "__main__":
    make(sys.argv[1])
