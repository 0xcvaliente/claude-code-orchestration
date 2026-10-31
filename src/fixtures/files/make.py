# Regenerates the file-profiler fixtures (src/file-profile.test.mjs) with the Python stdlib only.
# Run via make.sh: python3 -I make.py <outdir>. Output is deterministic (fixed zip dates, no timestamps in PDFs).
import struct
import sys
import zipfile
import zlib
from pathlib import Path

OUT = Path(sys.argv[1])

WORDS = ("the survey reports that regional output rose in every quarter while costs stayed flat and the board "
         "agreed to extend the pilot to three more sites after a review of safety staffing and supplier terms").split()


def prose_lines(seed, n, width=88):
    lines, line, i = [], [], seed
    while len(lines) < n:
        w = WORDS[i % len(WORDS)]
        i += 3
        if len(" ".join(line + [w])) > width:
            lines.append(" ".join(line))
            line = []
        line.append(w)
    return lines


def pdf_escape(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_pdf(path, pages):
    """pages: list of dicts with 'cells' [(x, y, text)] and optional 'image' (w, h, gray bytes, x, y, dw, dh)."""
    objs = {}
    n_pages = len(pages)
    # 1 catalog, 2 pages, 3 font, then per page: page, content, [image]
    kids, next_id = [], 4
    for p in pages:
        page_id, content_id = next_id, next_id + 1
        next_id += 2
        img_id = None
        if p.get("image"):
            img_id = next_id
            next_id += 1
        kids.append(page_id)
        ops = []
        for x, y, text in p.get("cells", []):
            ops.append(f"BT /F1 10 Tf {x} {y} Td ({pdf_escape(text)}) Tj ET")
        res = "/Font << /F1 3 0 R >>"
        if img_id:
            w, h, data, ix, iy, dw, dh = p["image"]
            ops.append(f"q {dw} 0 0 {dh} {ix} {iy} cm /Im1 Do Q")
            res += f" /XObject << /Im1 {img_id} 0 R >>"
            comp = zlib.compress(data, 9)
            objs[img_id] = (f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray "
                            f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(comp)} >>\nstream\n").encode() + comp + b"\nendstream"
        stream = zlib.compress("\n".join(ops).encode("latin-1"), 9)
        objs[content_id] = f"<< /Filter /FlateDecode /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"
        objs[page_id] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << {res} >> "
                         f"/Contents {content_id} 0 R >>").encode()
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = f"<< /Type /Pages /Count {n_pages} /Kids [{' '.join(f'{k} 0 R' for k in kids)}] >>".encode()
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for i in range(1, next_id):
        offsets[i] = len(out)
        out += f"{i} 0 obj\n".encode() + objs[i] + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {next_id}\n0000000000 65535 f \n".encode()
    for i in range(1, next_id):
        out += f"{offsets[i]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {next_id} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def text_page(seed, n=40):
    return {"cells": [(56, 740 - 16 * i, line) for i, line in enumerate(prose_lines(seed, n))]}


def gray_noise(w, h):
    # Scanline-free gray bytes with structure, so it compresses but is not blank.
    return bytes(((x * 7 + y * 13) ^ (x * y)) & 0xFF for y in range(h) for x in range(w))


def png(path, w, h, pixel):
    raw = b"".join(b"\x00" + b"".join(pixel(x, y) for x in range(w)) for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def chart_pixel(x, y):
    bars = [(20, 50, 40), (70, 100, 80), (120, 150, 25), (170, 200, 95)]
    for x0, x1, top in bars:
        if x0 <= x < x1 and y >= 120 - top:
            return b"\x2a\x6f\xdb"
    return b"\x00\x00\x00" if y == 119 or x == 10 else b"\xff\xff\xff"


def write_zip(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
RELNS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
SS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


def xlsx(path, sheets, strings):
    """sheets: list of (name, rows_xml, extra_xml)."""
    files = {
        "[Content_Types].xml": CT + '<Default Extension="xml" ContentType="application/xml"/></Types>',
        "_rels/.rels": f'<Relationships {RELNS}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'<workbook {SS} {R}><sheets>' + "".join(
            f'<sheet name="{n}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, (n, _, _) in enumerate(sheets)) + "</sheets></workbook>",
        "xl/_rels/workbook.xml.rels": f"<Relationships {RELNS}>" + "".join(
            f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
            for i in range(len(sheets))) + "</Relationships>",
        "xl/sharedStrings.xml": f'<sst {SS} count="{len(strings)}" uniqueCount="{len(strings)}">' + "".join(
            f"<si><t>{s}</t></si>" for s in strings) + "</sst>",
    }
    for i, (_, rows, extra) in enumerate(sheets):
        files[f"xl/worksheets/sheet{i + 1}.xml"] = f"<worksheet {SS}><sheetData>{rows}</sheetData>{extra}</worksheet>"
    write_zip(path, files)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "plain.txt").write_text("\n".join(prose_lines(0, 12)) + "\n")

    write_pdf(OUT / "text.pdf", [text_page(s) for s in range(3)])
    write_pdf(OUT / "long.pdf", [text_page(s, 12) for s in range(55)])

    table = text_page(5, 12)
    cols = [56, 200, 300, 400, 500]
    rows = [["Region", "Q1", "Q2", "Q3", "Q4"], ["North", "120", "135", "150", "161"],
            ["South", "98", "102", "117", "125"], ["East", "143", "139", "152", "170"],
            ["West", "77", "81", "95", "104"], ["Total", "438", "457", "514", "560"]]
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            table["cells"].append((cols[c], 520 - 16 * r, cell))
    write_pdf(OUT / "table.pdf", [text_page(9), table])

    write_pdf(OUT / "scanned.pdf", [{"image": (160, 200, gray_noise(160, 200), 36, 36, 540, 720)} for _ in range(2)])

    fig = text_page(3, 14)
    fig["image"] = (120, 80, gray_noise(120, 80), 56, 120, 480, 320)
    write_pdf(OUT / "figure.pdf", [text_page(1), fig])

    png(OUT / "chart.png", 220, 130, chart_pixel)

    strings = ["Item", "Qty", "Price", "Total", "Widget", "Gadget", "Budget 2026"]
    def row(n, cells):
        return f'<row r="{n}">' + "".join(cells) + "</row>"
    formulas_rows = (row(1, ['<c r="A1" t="s"><v>0</v></c>', '<c r="B1" t="s"><v>1</v></c>', '<c r="C1" t="s"><v>2</v></c>', '<c r="D1" t="s"><v>3</v></c>'])
                     + row(2, ['<c r="A2" t="s"><v>4</v></c>', '<c r="B2"><v>3</v></c>', '<c r="C2"><v>2.5</v></c>', '<c r="D2"><f>B2*C2</f><v>7.5</v></c>'])
                     + row(3, ['<c r="A3" t="s"><v>5</v></c>', '<c r="B3"><v>4</v></c>', '<c r="C3"><v>10</v></c>', '<c r="D3"><f>B3*C3</f><v>40</v></c>'])
                     + row(4, ['<c r="D4"><f>SUM(D2:D3)</f><v>47.5</v></c>']))
    summary_rows = (row(1, ['<c r="A1" t="s"><v>6</v></c>'])
                    + row(2, ['<c r="A2" t="inlineStr"><is><t>Grand, total</t></is></c>', '<c r="B2"><f>Sheet1!D4</f><v>47.5</v></c>']))
    xlsx(OUT / "formulas.xlsx", [("Sheet1", formulas_rows, ""),
                                 ("Summary", summary_rows, '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>')], strings)
    plain_rows = row(1, ['<c r="A1" t="s"><v>0</v></c>', '<c r="B1" t="s"><v>1</v></c>']) + "".join(
        row(n, [f'<c r="A{n}" t="s"><v>{4 + n % 2}</v></c>', f'<c r="B{n}"><v>{n * 3}</v></c>']) for n in range(2, 7))
    xlsx(OUT / "plain.xlsx", [("Data", plain_rows, "")], strings)

    W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    paras = ["Quarterly note", "Output rose in every quarter &amp; costs stayed flat.", "The board extended the pilot."]
    write_zip(OUT / "doc.docx", {
        "[Content_Types].xml": CT + '<Default Extension="xml" ContentType="application/xml"/></Types>',
        "word/document.xml": f"<w:document {W}><w:body>" + "".join(
            f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paras) + "</w:body></w:document>",
    })

    A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
    slides = [["Pilot review", "Three more sites"], ["Results", "Output up 12 percent"]]
    files = {"[Content_Types].xml": CT + '<Default Extension="xml" ContentType="application/xml"/></Types>'}
    for i, texts in enumerate(slides):
        files[f"ppt/slides/slide{i + 1}.xml"] = f"<p:sld {A}><p:cSld><p:spTree>" + "".join(
            f"<p:sp><p:txBody><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:txBody></p:sp>" for t in texts) + "</p:spTree></p:cSld></p:sld>"
    files["ppt/media/image1.png"] = (OUT / "chart.png").read_bytes()
    write_zip(OUT / "deck.pptx", files)


main()
