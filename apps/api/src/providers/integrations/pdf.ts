// The DocumentRenderer on pdf-lib (module 29: flyer PDFs; new dependency N16, pending the owner's approval).
//
// Local and deterministic: no network, no clock (the PDF's creation and modification dates are fixed, so the same
// input gives the same bytes and hash), no fonts from disk (the standard Helvetica set). It lays out the blocks the
// caller rendered (core/marketing renderPiece) in order: each field key is `NN:role:prominence` and its value the
// block's text; the prominence decides the type size, so a jurisdiction rule on brokerage-name prominence (E92) that
// the guard checked on the rendering holds on the PDF too. Images (PNG or JPEG bytes) are drawn below the text,
// at most four; anything else is skipped. Text is reduced to WinAnsi (the standard fonts' encoding): characters
// outside it become '?', never dropped silently into a different word.
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { DocumentRenderer, RenderedPdf } from './types.js';

const SIZE: Record<string, number> = { display: 28, heading: 18, body: 12, small: 9, footnote: 7 };
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const PAGE: [number, number] = [612, 792]; // US Letter
const MARGIN = 54;

/** WinAnsi-safe text: common punctuation mapped, anything else outside Latin-1 printable becomes '?'. */
export function winAnsi(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E\xA1-\xFF\n]/g, '?');
}

function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= width || line === '') line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export class PdfLibRenderer implements DocumentRenderer {
  async renderPdf(i: { templateKey: string; fields: Record<string, string>; imageCount: number; images?: Uint8Array[] }): Promise<RenderedPdf> {
    const doc = await PDFDocument.create();
    doc.setTitle(winAnsi(i.templateKey));
    doc.setProducer('Realty OS');
    doc.setCreator('Realty OS');
    doc.setCreationDate(FIXED_DATE);
    doc.setModificationDate(FIXED_DATE);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    let page = doc.addPage(PAGE);
    let y = PAGE[1] - MARGIN;
    const width = PAGE[0] - 2 * MARGIN;
    const keys = Object.keys(i.fields).sort();
    for (const k of keys) {
      const prominence = k.split(':')[2] ?? 'body';
      const size = SIZE[prominence] ?? 12;
      const font = size >= 18 ? bold : regular;
      const text = winAnsi(i.fields[k] ?? '');
      for (const line of wrap(text, width, (s) => font.widthOfTextAtSize(s, size))) {
        if (y - size < MARGIN) {
          page = doc.addPage(PAGE);
          y = PAGE[1] - MARGIN;
        }
        y -= size * 1.3;
        page.drawText(line, { x: MARGIN, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      }
      y -= size * 0.4;
    }
    for (const bytes of (i.images ?? []).slice(0, 4)) {
      const png = bytes[0] === 0x89 && bytes[1] === 0x50;
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!png && !jpg) continue;
      const img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const scale = Math.min(width / img.width, 220 / img.height, 1);
      const h = img.height * scale;
      if (y - h < MARGIN) {
        page = doc.addPage(PAGE);
        y = PAGE[1] - MARGIN;
      }
      y -= h + 8;
      page.drawImage(img, { x: MARGIN, y, width: img.width * scale, height: h });
    }
    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, contentType: 'application/pdf', sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
