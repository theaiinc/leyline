import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { METHOD_LABELS, formatUsd, vatLabel, vietnamDate, type Receipt } from './billing';

/**
 * Receipts as PDFs (pdf-lib: pure JS, runs in the Worker) and as printable HTML. The font is DejaVu Sans
 * (src/assets/fonts, free licence), embedded as a subset: it has the Vietnamese letters the seller's name needs.
 * (Vietnamese VAT invoices are not made here: Viettel S-Invoice issues them and renders their PDF.)
 */
export type DocumentFonts = { regular: Uint8Array; bold: Uint8Array };

export const LINE_DESCRIPTION = 'Valefront prepaid API credit';
export const SANDBOX_MARK = 'SANDBOX · NOT A REAL RECEIPT';

function vatNote(r: Receipt): string {
  if (r.vatRateBp === 0 && r.buyer.country !== 'VN') return 'VAT 0%: export of services to a customer outside Vietnam';
  return `VAT ${vatLabel(r.vatRateBp)} included in the amount received`;
}

function buyerLines(b: Receipt['buyer']): string[] {
  return [b.company || b.name, ...(b.company ? [b.name] : []), ...(b.taxId ? [`Tax ID: ${b.taxId}`] : []), ...(b.address ? [b.address] : []), `Country: ${b.country}`, b.email];
}

function sellerLines(s: Receipt['seller']): string[] {
  return [s.companyName, ...(s.localName ? [s.localName] : []), `Enterprise / tax code (MST): ${s.taxCode}`, s.address, s.email];
}

class Writer {
  private y = 800;
  constructor(readonly page: PDFPage, readonly regular: PDFFont, readonly bold: PDFFont) {}

  text(t: string, opts: { x?: number; size?: number; bold?: boolean; gap?: number; right?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const x = opts.right !== undefined ? opts.right - font.widthOfTextAtSize(t, size) : (opts.x ?? 50);
    this.page.drawText(t, { x, y: this.y, size, font, color: rgb(0.1, 0.1, 0.12) });
  }

  line(t: string, opts: { x?: number; size?: number; bold?: boolean } = {}): void {
    this.text(t, opts);
    this.down((opts.size ?? 10) + 5);
  }

  /** Long text, wrapped to `width`. */
  para(t: string, opts: { size?: number; width?: number } = {}): void {
    const size = opts.size ?? 9;
    const width = opts.width ?? 495;
    let current = '';
    for (const word of t.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (this.regular.widthOfTextAtSize(next, size) > width && current) {
        this.line(current, { size });
        current = word;
      } else current = next;
    }
    if (current) this.line(current, { size });
  }

  row(cells: Array<{ t: string; x?: number; right?: number; bold?: boolean }>, size = 10): void {
    for (const c of cells) this.text(c.t, { x: c.x, right: c.right, bold: c.bold, size });
    this.down(size + 7);
  }

  rule(): void {
    this.page.drawLine({ start: { x: 50, y: this.y + 4 }, end: { x: 545, y: this.y + 4 }, thickness: 0.6, color: rgb(0.75, 0.75, 0.78) });
    this.down(10);
  }

  down(by: number): void {
    this.y -= by;
  }

  get at(): number {
    return this.y;
  }

  set at(y: number) {
    this.y = y;
  }
}

async function start(fonts: DocumentFonts, title: string, subject: string): Promise<{ doc: PDFDocument; w: Writer }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title);
  doc.setSubject(subject);
  doc.setProducer('Valefront');
  doc.setCreator('Valefront');
  const regular = await doc.embedFont(fonts.regular, { subset: true });
  const bold = await doc.embedFont(fonts.bold, { subset: true });
  const page = doc.addPage([595.28, 841.89]);
  return { doc, w: new Writer(page, regular, bold) };
}

function columns(w: Writer, left: { title: string; lines: string[] }, right: { title: string; lines: string[] }): void {
  const top = w.at;
  w.line(left.title, { bold: true, size: 9 });
  for (const l of left.lines) w.line(l, { size: 9 });
  const leftEnd = w.at;
  w.at = top;
  w.line(right.title, { x: 310, bold: true, size: 9 });
  for (const l of right.lines) w.line(l, { x: 310, size: 9 });
  w.at = Math.min(leftEnd, w.at) - 8;
}

export async function receiptPdf(receipt: Receipt, fonts: DocumentFonts): Promise<Uint8Array> {
  const { doc, w } = await start(fonts, `Receipt ${receipt.number}`, `Receipt ${receipt.number}: ${LINE_DESCRIPTION}`);
  const { date } = vietnamDate(receipt.issuedAt);
  if (receipt.mode === 'sandbox') {
    // A test payment: say so across the page, so it can never pass for a real receipt.
    w.page.drawText(SANDBOX_MARK, { x: 90, y: 260, size: 46, font: w.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.22, rotate: degrees(40) });
  }
  w.line(receipt.mode === 'sandbox' ? 'RECEIPT (SANDBOX)' : 'RECEIPT', { size: 18, bold: true });
  w.down(4);
  w.line(`Receipt number: ${receipt.number}`, { bold: true });
  w.line(`Date: ${date}`);
  w.line(`Currency: ${receipt.currency}`);
  w.down(8);
  columns(w, { title: 'Received by', lines: sellerLines(receipt.seller) }, { title: 'Received from', lines: buyerLines(receipt.buyer) });
  w.rule();
  w.row([{ t: 'Description', bold: true }, { t: 'Qty', x: 330, bold: true }, { t: 'Unit price', right: 450, bold: true }, { t: 'Amount', right: 545, bold: true }]);
  w.rule();
  w.row([{ t: LINE_DESCRIPTION }, { t: '1', x: 330 }, { t: formatUsd(receipt.amountCents), right: 450 }, { t: formatUsd(receipt.amountCents), right: 545 }]);
  w.rule();
  w.row([{ t: 'Subtotal', x: 330 }, { t: formatUsd(receipt.amountCents), right: 545 }]);
  w.row([{ t: `VAT (${vatLabel(receipt.vatRateBp)})`, x: 330 }, { t: formatUsd(receipt.vatCents), right: 545 }]);
  w.row([{ t: 'Amount received', x: 330, bold: true }, { t: `${formatUsd(receipt.totalCents)} ${receipt.currency}`, right: 545, bold: true }], 11);
  w.down(6);
  w.line(vatNote(receipt), { size: 9 });
  w.down(8);
  w.line('Payment', { bold: true });
  w.line(`Method: ${METHOD_LABELS[receipt.method]}`, { size: 9 });
  w.line(`Order reference: ${receipt.reference}`, { size: 9 });
  if (receipt.providerReference) w.line(`Payment reference: ${receipt.providerReference}`, { size: 9 });
  w.line(`Received on ${date}. Credit added to your balance: ${formatUsd(receipt.amountCents)}.`, { size: 9 });
  w.down(10);
  w.para('Prepaid credit is used for Valefront API requests at the official provider price per token. Unused prepaid credit is refundable on request within 30 days of purchase (see valefront.com/refund).');
  return doc.save();
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, pdfHref?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#15171c;background:#fff;margin:0}main{max-width:760px;margin:0 auto;padding:28px 20px}
h1{font-size:22px;margin:0 0 8px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}@media(max-width:560px){.cols{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;margin:12px 0}td,th{padding:7px 4px;border-bottom:1px solid #ddd;text-align:left}td.n,th.n{text-align:right}
.muted{color:#5b606b;font-size:12px}.bar{display:flex;gap:8px;margin-bottom:18px}.bar a,.bar button{font:inherit;padding:6px 12px;border:1px solid #ccc;border-radius:8px;background:#f6f7f9;color:inherit;text-decoration:none;cursor:pointer}
@media print{.bar{display:none}main{padding:0}}</style></head><body><main>
<div class="bar"><button onclick="window.print()">Print</button>${pdfHref ? `<a href="${esc(pdfHref)}">Download PDF</a>` : ''}</div>${body}</main></body></html>`;
}

const lines = (ls: string[]) => ls.map(esc).join('<br>');

export function receiptHtml(receipt: Receipt, pdfHref?: string): string {
  const { date } = vietnamDate(receipt.issuedAt);
  return page(`Receipt ${receipt.number}`, `${receipt.mode === 'sandbox' ? `<p style="padding:8px 12px;border:2px solid #c33;color:#c33;font-weight:700">${SANDBOX_MARK}: a test payment in PayPal's sandbox.</p>` : ''}<h1>Receipt${receipt.mode === 'sandbox' ? ' (sandbox)' : ''}</h1>
<div>Receipt number: <strong>${esc(receipt.number)}</strong><br>Date: ${esc(date)}<br>Currency: ${receipt.currency}</div>
<div class="cols"><div><strong>Received by</strong><br>${lines(sellerLines(receipt.seller))}</div><div><strong>Received from</strong><br>${lines(buyerLines(receipt.buyer))}</div></div>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead>
<tbody><tr><td>${LINE_DESCRIPTION}</td><td class="n">1</td><td class="n">${formatUsd(receipt.amountCents)}</td><td class="n">${formatUsd(receipt.amountCents)}</td></tr>
<tr><td colspan="3" class="n">Subtotal</td><td class="n">${formatUsd(receipt.amountCents)}</td></tr>
<tr><td colspan="3" class="n">VAT (${vatLabel(receipt.vatRateBp)})</td><td class="n">${formatUsd(receipt.vatCents)}</td></tr>
<tr><td colspan="3" class="n"><strong>Amount received</strong></td><td class="n"><strong>${formatUsd(receipt.totalCents)} ${receipt.currency}</strong></td></tr></tbody></table>
<p class="muted">${esc(vatNote(receipt))}</p>
<p><strong>Payment</strong><br>Method: ${esc(METHOD_LABELS[receipt.method])}<br>Order reference: ${esc(receipt.reference)}${receipt.providerReference ? `<br>Payment reference: ${esc(receipt.providerReference)}` : ''}<br>Received on ${esc(date)}. Credit added: ${formatUsd(receipt.amountCents)}.</p>`, pdfHref);
}
