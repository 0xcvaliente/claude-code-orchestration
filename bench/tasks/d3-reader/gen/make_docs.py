#!/usr/bin/env python3
"""Generates the documents of bench task d3-reader (stdlib only, plus mutool and pdftoppm for the two raster files).

    python3 -I bench/tasks/d3-reader/gen/make_docs.py bench/tasks/d3-reader/setup/docs

Adapted from bench/tasks/d2-docs/gen/make_docs.py (same PDF, xlsx and chart writers), without the .txt memo and with a
docx. Writes report.pdf (text PDF), pricing.pdf (a table), inspection.pdf (a scan: one page image with legible text, no
text layer), budget.xlsx (formulas without cached values), chart.png (a bar chart), agreement.docx (a table) and
manual.pdf (60 pages, the answer needs pages 6 and 54). The answers live in ../score.mjs and ../ref/answers.json, never in
setup/; file names say nothing about the answers. Deterministic: same seed, same text.
"""
import os
import random
import subprocess
import sys
import tempfile
import zipfile
import zlib

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "docs")


# ---------- minimal PDF writer ----------
def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_ops(lines, x=56, y=780, size=11, lead=15, font="F1"):
    ops = [f"BT /{font} {size} Tf {lead} TL {x} {y} Td"]
    for ln in lines:
        ops.append(f"({esc(ln)}) Tj T*")
    ops.append("ET")
    return "\n".join(ops)


def write_pdf(path, pages, image=None):
    """pages: list of content-stream strings. image: (jpeg bytes, w, h, components) drawn full page on page 1 as /Im1."""
    objs = []

    def add(b):
        objs.append(b if isinstance(b, bytes) else b.encode("latin-1"))
        return len(objs)

    catalog = add("")  # placeholder 1
    pages_id = add("")  # placeholder 2
    font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    img_id = None
    if image:
        data, w, h, ncomp = image
        cs = "/DeviceGray" if ncomp == 1 else "/DeviceRGB"
        img_id = add(
            f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace {cs} /BitsPerComponent 8 "
            f"/Filter /DCTDecode /Length {len(data)} >>\nstream\n".encode("latin-1") + data + b"\nendstream"
        )
    kids = []
    for content in pages:
        raw = zlib.compress(content.encode("latin-1"), 9)
        cid = add(f"<< /Length {len(raw)} /Filter /FlateDecode >>\nstream\n".encode("latin-1") + raw + b"\nendstream")
        res = f"/Font << /F1 {font} 0 R /F2 {bold} 0 R >>"
        if img_id:
            res += f" /XObject << /Im1 {img_id} 0 R >>"
        kids.append(add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 595 842] /Resources << {res} >> /Contents {cid} 0 R >>"))
    objs[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("latin-1")
    objs[pages_id - 1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode("latin-1")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, b in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + b + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offsets:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(path, "wb") as f:
        f.write(out)


def wrap(text, width=88):
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines


rng = random.Random(20261031)
VOCAB = ("the team reviewed schedule supplier quarterly output budget forecast logistics carrier inventory "
         "maintenance policy staff training audit customer region site capacity delivery quality process "
         "planning safety equipment contract review records shift volume target report").split()


def filler(n_sentences):
    out = []
    for _ in range(n_sentences):
        words = [rng.choice(VOCAB) for _ in range(rng.randint(8, 16))]
        out.append(" ".join(words).capitalize() + ".")
    return " ".join(out)


# ---------- 2. report.pdf (4 pages, fact on page 3) ----------
def report():
    pages = []
    texts = [
        ("Annual operations report", filler(10) + " Offices in Porto and Madrid continued normal operations."),
        ("Section 1. Market overview", filler(8) + " At year end the Madrid office had 186 staff, up from 171 a year "
         "earlier; the Porto office had 204 staff. " + filler(5)),
        ("Section 2. New offices", filler(5) + " After a delayed fit-out, the Lisbon office opened its doors on 9 March 2023, "
         "three months after the Porto office expansion of 12 December 2022. " + filler(6)),
        ("Section 3. Outlook", filler(12) + " A Valencia office is planned to open on 1 June 2025."),
    ]
    for i, (title, body) in enumerate(texts, 1):
        pages.append(text_ops([title], size=16, font="F2") + "\n" + text_ops(wrap(body), y=740) + "\n" + text_ops([f"Page {i} of 4"], x=270, y=40, size=9))
    write_pdf(os.path.join(OUT, "report.pdf"), pages)


# ---------- 3. pricing.pdf (table) ----------
PRICING = [
    ("KX-110", "Hinge, steel", "4.20", "3.95", "3.60", "3.25"),
    ("KX-210", "Hinge, brass", "5.10", "4.80", "4.45", "4.05"),
    ("KX-220", "Bracket, steel", "4.60", "4.25", "3.85", "3.40"),
    ("KX-230", "Bracket, alloy", "5.75", "5.30", "4.90", "4.35"),
    ("KR-220", "Rail, 1 m", "9.80", "9.10", "8.55", "7.90"),
    ("KX-310", "Latch, small", "2.15", "1.95", "1.80", "1.62"),
    ("KX-320", "Latch, large", "2.90", "2.70", "2.45", "2.20"),
]


def pricing():
    cols = [56, 130, 250, 330, 410, 490, 560]
    head = ["SKU", "Description", "1-99", "100-499", "500-999", "1000+"]
    ops = [text_ops(["Price list 2026 (unit price in EUR by order volume)"], size=14, font="F2", y=790)]
    top, rowh = 760, 22
    rows = [head] + [list(r) for r in PRICING]
    for i, r in enumerate(rows):
        y = top - i * rowh
        for j, cell in enumerate(r):
            ops.append(text_ops([cell], x=cols[j] + 4, y=y - 15, size=10, font="F2" if i == 0 else "F1"))
    bottom = top - len(rows) * rowh
    for i in range(len(rows) + 1):
        y = top - i * rowh
        ops.append(f"0.5 w {cols[0]} {y} m {cols[-1]} {y} l S")
    for x in cols:
        ops.append(f"0.5 w {x} {top} m {x} {bottom} l S")
    ops.append(text_ops(wrap("Prices exclude VAT and freight. Volume tiers apply per SKU per order. " + filler(3)), y=bottom - 30, size=9, lead=12))
    write_pdf(os.path.join(OUT, "pricing.pdf"), ["\n".join(ops)])


# ---------- 4. inspection.pdf (image only) ----------
def inspection(tmp):
    lines = ["", "Pressure vessel inspection certificate", "", "Site: Fenwick industrial estate, unit 4",
             "Vessel: receiver tank RT-2, 500 litres", "Inspection date: 14 August 2026", "Result: passed, next inspection due August 2027",
             "", "Certificate serial number: IC-58213-Q", "", "Inspector: M. Okafor (licence 7731)"]
    content = f"2 w 40 40 515 762 re S\n" + text_ops(lines[:2], size=18, font="F2", y=760, lead=24) + "\n" + text_ops(lines[2:], y=690, size=13, lead=22)
    src = os.path.join(tmp, "cert.pdf")
    write_pdf(src, [content])
    subprocess.run(["pdftoppm", "-jpeg", "-gray", "-r", "100", "-singlefile", src, os.path.join(tmp, "cert")], check=True)
    data = open(os.path.join(tmp, "cert.jpg"), "rb").read()
    w, h, ncomp = jpeg_size(data)
    write_pdf(os.path.join(OUT, "inspection.pdf"), ["q 595 0 0 842 0 0 cm /Im1 Do Q"], image=(data, w, h, ncomp))


def jpeg_size(data):
    i = 2
    while i < len(data):
        marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
        if 0xC0 <= marker <= 0xC3:
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big"), data[i + 9]
        i += 2 + length
    raise ValueError("no SOF marker")


# ---------- 5. budget.xlsx (formulas, no cached values) ----------
LINES = [("Pallet racking", 12, 185.50), ("Forklift lease (months)", 6, 940.00), ("Dock seals", 4, 612.25),
         ("LED high-bay lights", 40, 88.90), ("Safety barriers", 25, 47.60), ("Signage set", 3, 214.00)]


def budget():
    def cell(ref, v=None, f=None):
        if f:
            return f'<c r="{ref}"><f>{f}</f></c>'
        if isinstance(v, str):
            return f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>'
        return f'<c r="{ref}"><v>{v}</v></c>'

    def sheet(rows):
        body = "".join(f'<row r="{i}">{"".join(cs)}</row>' for i, cs in enumerate(rows, 1))
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
                f"{body}</sheetData></worksheet>")

    lines = [[cell("A1", "Item"), cell("B1", "Quantity"), cell("C1", "Unit cost"), cell("D1", "Line total")]]
    for i, (name, q, c) in enumerate(LINES, 2):
        lines.append([cell(f"A{i}", name), cell(f"B{i}", q), cell(f"C{i}", c), cell(f"D{i}", f=f"B{i}*C{i}")])
    summary = [
        [cell("A1", "Budget summary"), cell("B1", "Amount")],
        [cell("A2", "Gross"), cell("B2", f="SUM(Lines!D2:D7)")],
        [cell("A3", "Volume discount (8%)"), cell("B3", f="ROUND(B2*0.08,2)")],
        [cell("A4", "After discount"), cell("B4", f="B2-B3")],
        [cell("A5", "VAT (25%)"), cell("B5", f="ROUND(B4*0.25,2)")],
        [cell("A6", "Net total"), cell("B6", f="B4+B5")],
    ]
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/>'
        '<sheet name="Lines" sheetId="2" r:id="rId2"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": sheet(summary),
        "xl/worksheets/sheet2.xml": sheet(lines),
    }
    with zipfile.ZipFile(os.path.join(OUT, "budget.xlsx"), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 10, 31, 0, 0, 0)), data)
    gross = sum(round(q * c, 2) for _, q, c in LINES)
    disc = round(gross * 0.08, 2)
    after = round(gross - disc, 2)
    vat = round(after * 0.25, 2)
    return round(after + vat, 2), disc


# ---------- 6. chart.png (bar values only readable from the axis) ----------
BARS = [("North", 34), ("Coastal", 47), ("Valley", 22), ("Highlands", 61), ("Metro", 55)]


def chart(tmp):
    W, H, left, bottom, top = 640, 400, 70, 340, 40
    scale = (bottom - top) / 70
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"><rect width="{W}" height="{H}" fill="#fff"/>',
             f'<text x="{W / 2}" y="24" font-family="Helvetica" font-size="16" text-anchor="middle">Shipments by region, 2025 (thousand units)</text>']
    for v in range(0, 71, 10):
        y = bottom - v * scale
        parts.append(f'<line x1="{left}" y1="{y}" x2="{W - 20}" y2="{y}" stroke="#ccc"/>')
        parts.append(f'<text x="{left - 8}" y="{y + 4}" font-family="Helvetica" font-size="12" text-anchor="end">{v}</text>')
    bw, gap = 70, 34
    for i, (name, v) in enumerate(BARS):
        x = left + gap + i * (bw + gap)
        parts.append(f'<rect x="{x}" y="{bottom - v * scale}" width="{bw}" height="{v * scale}" fill="#3b6ea5"/>')
        parts.append(f'<text x="{x + bw / 2}" y="{bottom + 18}" font-family="Helvetica" font-size="12" text-anchor="middle">{name}</text>')
    parts.append(f'<line x1="{left}" y1="{bottom}" x2="{W - 20}" y2="{bottom}" stroke="#000"/></svg>')
    svg = os.path.join(tmp, "chart.svg")
    with open(svg, "w") as f:
        f.write("".join(parts))
    subprocess.run(["mutool", "draw", "-q", "-r", "72", "-o", os.path.join(OUT, "chart.png"), svg], check=True)


# ---------- 7. manual.pdf (60 pages, facts on pages 6 and 54) ----------
def manual():
    pages = []
    facts = {
        6: "Service intervals. The standard service interval for the MX-9 compressor is 750 operating hours. "
           "The smaller MX-7 uses a standard interval of 600 operating hours.",
        31: "Lubrication. Use only the approved synthetic oil. Oil changes for the MX-7 follow its standard interval.",
        54: "Site conditions. Sites classified as dusty shorten every standard service interval by a factor of 0.6 "
            "(multiply the interval by 0.6). Humid sites use a factor of 0.8.",
    }
    for p in range(1, 61):
        body = filler(6)
        if p in facts:
            body += " " + facts[p] + " "
        body += filler(8)
        title = f"Chapter {(p - 1) // 5 + 1}, part {(p - 1) % 5 + 1}"
        pages.append(text_ops([title], size=14, font="F2") + "\n" + text_ops(wrap(body), y=745) + "\n" + text_ops([f"MX series service manual - page {p}"], x=220, y=40, size=9))
    write_pdf(os.path.join(OUT, "manual.pdf"), pages)


# ---------- 8. agreement.docx (a table; the answer is a table cell) ----------
TIERS = [("Basic", "5 business days", "30", "120"), ("Standard", "2 business days", "30", "340"),
         ("Premium", "8 hours", "45", "780"), ("Enterprise", "2 hours", "60", "1450")]


def agreement():
    def para(text, bold=False):
        rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
        return f'<w:p><w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

    def row(cells, bold=False):
        return "<w:tr>" + "".join(f"<w:tc><w:tcPr><w:tcW w:w=\"2200\" w:type=\"dxa\"/></w:tcPr>{para(c, bold)}</w:tc>" for c in cells) + "</w:tr>"

    borders = "".join(f'<w:{b} w:val="single" w:sz="4" w:space="0" w:color="000000"/>' for b in ("top", "left", "bottom", "right", "insideH", "insideV"))
    table = (f'<w:tbl><w:tblPr><w:tblW w:w="8800" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
             + row(["Tier", "Response time", "Notice period (days)", "Monthly fee (EUR)"], True)
             + "".join(row(list(t)) for t in TIERS) + "</w:tbl>")
    body = (para("Service agreement", True)
            + para("This agreement covers maintenance of the receiving dock equipment at the Fenwick industrial estate. " + filler(3))
            + para("Termination. Either party may end the agreement in writing. The general notice period is 30 days, "
                   "unless the tier table below sets a different notice period for the customer's tier.")
            + table
            + para(filler(4))
            + para("Fees are invoiced monthly in advance and exclude VAT."))
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
           f'{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": doc,
    }
    with zipfile.ZipFile(os.path.join(OUT, "agreement.docx"), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 10, 31, 0, 0, 0)), data)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        report()
        pricing()
        inspection(tmp)
        net, disc = budget()
        chart(tmp)
        manual()
        agreement()
    print(f"wrote documents to {OUT}; budget Summary!B6 = {net:.2f}, B3 = {disc:.2f}")
