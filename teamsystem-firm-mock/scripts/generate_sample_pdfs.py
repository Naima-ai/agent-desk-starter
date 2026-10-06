"""Generates realistic-looking Italian invoice PDFs for the TeamSystem Firm
mock's sample-documents/pdf folder — used to test the "Add documents" upload
feature with real PDF bytes and a real, if simple, letterhead logo.

Logos here are drawn programmatically (a monogram in a colored roundel) —
original shapes, not a trace of any real company's mark — paired with
entirely fictional Italian company names consistent with the rest of this
mock's seed data (Rossi Srl, Bianchi Studio, etc).
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "sample-documents" / "pdf"
OUT_DIR.mkdir(parents=True, exist_ok=True)

PAGE_W, PAGE_H = A4


def draw_logo(c, x, y, monogram, color):
    """A simple circular monogram letterhead mark — an original shape, not a
    copy of any real logo."""
    r = 9 * mm
    c.setFillColor(HexColor(color))
    c.circle(x + r, y - r, r, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 16)
    c.drawCentredString(x + r, y - r - 5.5, monogram)


def money(v):
    return f"€ {v:,.2f}".replace(",", "§").replace(".", ",").replace("§", ".")


def draw_invoice(filename, company, address, piva, cf, color, monogram,
                  buyer, buyer_piva, invoice_no, invoice_date, due_date,
                  items, iban, out_dir=None):
    path = (out_dir or OUT_DIR) / filename
    c = canvas.Canvas(str(path), pagesize=A4)

    margin = 20 * mm
    top = PAGE_H - margin

    # ---- Letterhead ----
    draw_logo(c, margin, top, monogram, color)
    c.setFillColor(HexColor("#111111"))
    c.setFont("Helvetica-Bold", 13)
    c.drawString(margin + 22 * mm, top - 6 * mm, company)
    c.setFont("Helvetica", 8.5)
    c.setFillColor(HexColor("#444444"))
    c.drawString(margin + 22 * mm, top - 11 * mm, address)
    c.drawString(margin + 22 * mm, top - 15.5 * mm, f"P.IVA {piva}  ·  C.F. {cf}")

    c.setStrokeColor(HexColor(color))
    c.setLineWidth(1.4)
    c.line(margin, top - 20 * mm, PAGE_W - margin, top - 20 * mm)

    # ---- Invoice title block (right) ----
    c.setFillColor(HexColor("#111111"))
    c.setFont("Helvetica-Bold", 18)
    c.drawRightString(PAGE_W - margin, top - 2 * mm, "FATTURA")
    c.setFont("Helvetica", 9.5)
    c.drawRightString(PAGE_W - margin, top - 8 * mm, f"Numero: {invoice_no}")
    c.drawRightString(PAGE_W - margin, top - 12.5 * mm, f"Data: {invoice_date}")
    c.drawRightString(PAGE_W - margin, top - 17 * mm, f"Scadenza: {due_date}")

    # ---- Buyer block ----
    y = top - 30 * mm
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(HexColor("#666666"))
    c.drawString(margin, y, "FATTURATO A")
    c.setFont("Helvetica-Bold", 11)
    c.setFillColor(HexColor("#111111"))
    c.drawString(margin, y - 5.5 * mm, buyer)
    c.setFont("Helvetica", 9)
    c.setFillColor(HexColor("#444444"))
    c.drawString(margin, y - 10.5 * mm, f"P.IVA {buyer_piva}")

    # ---- Line-items table ----
    table_y_top = y - 20 * mm
    data = [["Descrizione", "Qta", "Prezzo unit.", "Aliquota IVA", "Totale"]]
    subtotal = 0.0
    vat_total = 0.0
    for desc, qty, unit_price, rate in items:
        line_net = qty * unit_price
        line_vat = round(line_net * rate / 100, 2)
        subtotal += line_net
        vat_total += line_vat
        data.append([desc, str(qty), money(unit_price), f"{rate:g}%", money(line_net)])

    col_widths = [78 * mm, 14 * mm, 28 * mm, 26 * mm, 28 * mm]
    table = Table(data, colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor(color)),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, HexColor("#F4F6FA")]),
        ("GRID", (0, 0), (-1, -1), 0.4, HexColor("#D5E2F5")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
    ]))
    table_w, table_h = table.wrapOn(c, sum(col_widths), 200 * mm)
    table.drawOn(c, margin, table_y_top - table_h)

    # ---- Totals ----
    totals_y = table_y_top - table_h - 10 * mm
    total = subtotal + vat_total
    c.setFont("Helvetica", 9.5)
    c.setFillColor(HexColor("#444444"))
    c.drawRightString(PAGE_W - margin - 30 * mm, totals_y, "Imponibile")
    c.drawRightString(PAGE_W - margin, totals_y, money(subtotal))
    c.drawRightString(PAGE_W - margin - 30 * mm, totals_y - 5.5 * mm, "IVA")
    c.drawRightString(PAGE_W - margin, totals_y - 5.5 * mm, money(vat_total))
    c.setStrokeColor(HexColor("#D5E2F5"))
    c.line(PAGE_W - margin - 55 * mm, totals_y - 8.5 * mm, PAGE_W - margin, totals_y - 8.5 * mm)
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(HexColor("#111111"))
    c.drawRightString(PAGE_W - margin - 30 * mm, totals_y - 15 * mm, "TOTALE")
    c.drawRightString(PAGE_W - margin, totals_y - 15 * mm, money(total))

    # ---- Footer ----
    footer_y = margin + 12 * mm
    c.setStrokeColor(HexColor("#D5E2F5"))
    c.line(margin, footer_y + 8 * mm, PAGE_W - margin, footer_y + 8 * mm)
    c.setFont("Helvetica", 8)
    c.setFillColor(HexColor("#666666"))
    c.drawString(margin, footer_y, f"Pagamento a mezzo bonifico bancario — IBAN {iban}")
    c.drawString(margin, footer_y - 4.5 * mm, "Documento generato a scopo dimostrativo — non e' una fattura fiscalmente valida.")

    c.showPage()
    c.save()
    print("wrote", path.name)


draw_invoice(
    filename="invoice_marchetti_2026-0187.pdf",
    company="Marchetti Consulenza e Revisione Srl",
    address="Via Roma 42, 20121 Milano (MI)",
    piva="02345678904", cf="02345678904",
    color="#0A63E0", monogram="MC",
    buyer="Rossi Srl", buyer_piva="01234567897",
    invoice_no="2026/0187", invoice_date="14/08/2026", due_date="14/09/2026",
    items=[("Consulenza fiscale e revisione contabile - III trimestre 2026", 1, 1850.00, 22)],
    iban="IT60 X054 2811 1010 0000 0123 456",
)

draw_invoice(
    filename="invoice_edilservice_FE-2026-00934.pdf",
    company="EdilService Costruzioni Srl",
    address="Via delle Industrie 15, 40128 Bologna (BO)",
    piva="03456789019", cf="03456789019",
    color="#F08000", monogram="ES",
    buyer="Rossi Srl", buyer_piva="01234567897",
    invoice_no="FE-2026-00934", invoice_date="22/08/2026", due_date="21/10/2026",
    items=[("Manutenzione straordinaria impianto elettrico - sede operativa", 1, 4200.00, 22)],
    iban="IT91 Y030 6909 6061 0000 0654 321",
)

ERROR_DIR = Path(__file__).resolve().parent.parent / "sample-documents" / "error-cases"
ERROR_DIR.mkdir(parents=True, exist_ok=True)
draw_invoice(
    filename="bad_piva_invoice.pdf",
    company="Sartori Trasporti Srl",
    address="Via Argine 3, 43122 Parma (PR)",
    piva="05678901232", cf="05678901232",  # check digit should be 1, not 2 (FMT-03)
    color="#C0473C", monogram="ST",
    buyer="Rossi Srl", buyer_piva="01234567897",
    invoice_no="2026/0501", invoice_date="10/09/2026", due_date="10/10/2026",
    items=[("Trasporto merci conto terzi", 1, 640.00, 22)],
    iban="IT77 Z030 6912 3456 0000 0111 222",
    out_dir=ERROR_DIR,
)

draw_invoice(
    filename="invoice_bianchi_0056-PA.pdf",
    company="Bianchi Forniture per Ufficio Srl",
    address="Corso Vittorio Emanuele 8, 10121 Torino (TO)",
    piva="04567890126", cf="04567890126",
    color="#1F9D6B", monogram="BF",
    buyer="Rossi Srl", buyer_piva="01234567897",
    invoice_no="0056/PA", invoice_date="02/09/2026", due_date="02/10/2026",
    items=[
        ("Risme carta A4 80g", 20, 4.50, 22),
        ("Toner compatibile stampante laser", 6, 21.75, 22),
        ("Materiale di consumo vario ufficio", 1, 30.50, 22),
    ],
    iban="IT02 K030 6222 1000 0000 0789 012",
)
