import sys
import zipfile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

def make(path, date1904=False):
    epoch = ' date1904="1"' if date1904 else ''
    styles = f'''<styleSheet xmlns="{MAIN}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="[h]:mm:ss"/></numFmts><cellXfs count="11"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="18"/><xf numFmtId="19"/><xf numFmtId="20"/><xf numFmtId="21"/><xf numFmtId="45"/><xf numFmtId="47"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>'''
    first_serial = '0' if date1904 else '1'
    row = '<row r="1">' + ''.join(f'<c r="{col}1" s="{style}"><v>{value}</v></c>' for col, style, value in [('A',1,first_serial),('B',1,'59'),('C',1,'60'),('D',1,'61'),('E',2,'46296.9'),('F',3,'0.5'),('G',4,'0.5'),('H',5,'0.5'),('I',6,'0.5'),('J',7,'0.5'),('K',8,'0.5'),('L',9,'46296.75'),('M',10,'46296')]) + '</row>'
    parts = {
        'xl/workbook.xml': f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"{epoch}><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/styles.xml': styles,
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{MAIN}"><sheetData>{row}</sheetData></worksheet>',
    }
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as book:
        for name, value in parts.items(): book.writestr(name, value)

if __name__ == '__main__':
    make(sys.argv[1], len(sys.argv) > 2 and sys.argv[2] == '1904')
