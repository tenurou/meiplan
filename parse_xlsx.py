"""Read cached cell values from an uploaded .xlsx using only Python's stdlib."""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

def col_index(ref):
    letters = "".join(ch for ch in ref if ch.isalpha())
    result = 0
    for ch in letters.upper():
        result = result * 26 + ord(ch) - 64
    return result - 1

def parse(path):
    with zipfile.ZipFile(path) as book:
        entries = book.infolist()
        if len(entries) > 2000 or sum(entry.file_size for entry in entries) > 120 * 1024 * 1024:
            raise ValueError("Книга слишком большая для безопасной обработки")
        names = set(book.namelist())
        number_formats = {}
        style_formats = []
        if "xl/styles.xml" in names:
            style_root = ET.fromstring(book.read("xl/styles.xml"))
            custom_formats = {
                int(item.attrib["numFmtId"]): item.attrib.get("formatCode", "")
                for item in style_root.findall(f"{{{MAIN}}}numFmts/{{{MAIN}}}numFmt")
            }
            for xf in style_root.findall(f"{{{MAIN}}}cellXfs/{{{MAIN}}}xf"):
                fmt_id = int(xf.attrib.get("numFmtId", "0"))
                fmt = custom_formats.get(fmt_id, "")
                # Built-in Excel percent formats are 9 and 10. Ignore quoted or
                # escaped percent signs in custom literal strings.
                visible_format = re.sub(r'"[^"]*"|\\.', "", fmt)
                is_percent = fmt_id in (9, 10) or "%" in visible_format
                style_formats.append("percent" if is_percent else "number")
        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(book.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{{{MAIN}}}si"):
                shared.append("".join(t.text or "" for t in item.iter(f"{{{MAIN}}}t")))

        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        rel_root = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        rels = {r.attrib["Id"]: r.attrib["Target"] for r in rel_root.findall(f"{{{PKG}}}Relationship")}
        sheets = []
        for sheet in workbook.findall(f".//{{{MAIN}}}sheet"):
            target = rels.get(sheet.attrib.get(f"{{{REL}}}id"), "")
            path_in_zip = target.lstrip("/") if target.startswith("/") else "xl/" + target
            parts = []
            for part in path_in_zip.split("/"):
                if part == "..":
                    if parts: parts.pop()
                elif part not in ("", "."):
                    parts.append(part)
            path_in_zip = "/".join(parts)
            if path_in_zip not in names:
                continue
            root = ET.fromstring(book.read(path_in_zip))
            row_values = []
            for row in root.findall(f".//{{{MAIN}}}sheetData/{{{MAIN}}}row"):
                if len(row_values) >= 100000:
                    raise ValueError("На листе больше 100 000 строк")
                cells = []
                cell_formats = []
                for cell in row.findall(f"{{{MAIN}}}c"):
                    idx = col_index(cell.attrib.get("r", "A1"))
                    if idx < 0 or idx >= 500:
                        raise ValueError("На листе больше 500 колонок")
                    while len(cells) <= idx: cells.append("")
                    while len(cell_formats) <= idx: cell_formats.append("")
                    value = cell.find(f"{{{MAIN}}}v")
                    inline = cell.find(f"{{{MAIN}}}is")
                    text = ""
                    if cell.attrib.get("t") == "s" and value is not None:
                        try: text = shared[int(value.text or "0")]
                        except (ValueError, IndexError): text = ""
                    elif cell.attrib.get("t") == "inlineStr" and inline is not None:
                        text = "".join(t.text or "" for t in inline.iter(f"{{{MAIN}}}t"))
                    elif cell.attrib.get("t") == "b" and value is not None:
                        text = "TRUE" if value.text == "1" else "FALSE"
                    elif value is not None:
                        text = value.text or ""
                    cells[idx] = text
                    style_index = int(cell.attrib.get("s", "0"))
                    cell_formats[idx] = style_formats[style_index] if style_index < len(style_formats) else "number"
                row_values.append({"number": int(row.attrib.get("r", str(len(row_values) + 1))), "values": cells, "cellFormats": cell_formats})
            sheets.append({"name": sheet.attrib.get("name", "Sheet"), "rows": row_values})
        return {"sheets": sheets}

if __name__ == "__main__":
    try:
        print(json.dumps(parse(sys.argv[1]), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
