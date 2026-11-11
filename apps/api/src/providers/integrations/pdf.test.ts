// The pdf-lib DocumentRenderer (module 29; N16): local, deterministic, a real PDF.
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { PdfLibRenderer, winAnsi } from './pdf.js';

const PNG_1X1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2b1d6a90000000049454e44ae426082', 'hex');

describe('PdfLibRenderer', () => {
  it('R-MKT-1: renders the blocks in order into a real one-page PDF, the same input giving the same bytes (no clock)', async () => {
    const r = new PdfLibRenderer();
    const fields = { '00:headline:display': 'A home in Charleston', '01:price:heading': '$450,000', '02:brokerage_name:heading': 'Harbor Realty LLC', '03:equal_housing:small': 'Equal Housing Opportunity.' };
    const a = await r.renderPdf({ templateKey: 'flyer.standard', fields, imageCount: 1, images: [new Uint8Array(PNG_1X1)] });
    const b = await r.renderPdf({ templateKey: 'flyer.standard', fields, imageCount: 1, images: [new Uint8Array(PNG_1X1)] });
    expect(a.contentType).toBe('application/pdf');
    expect(Buffer.from(a.bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
    expect(a.sha256).toBe(b.sha256);
    const doc = await PDFDocument.load(a.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe('flyer.standard');
  });

  it('text outside the standard fonts\' encoding becomes "?", never a crash; non-images are skipped', async () => {
    expect(winAnsi('Café “quoted” – ok \u{1F3E0}')).toBe('Café "quoted" - ok ?');
    const out = await new PdfLibRenderer().renderPdf({ templateKey: 't', fields: { '00:body:body': 'Ünïcode 中文 text' }, imageCount: 1, images: [new Uint8Array([1, 2, 3])] });
    expect(out.bytes.length).toBeGreaterThan(100);
  });
});

describe('PdfLibRenderer images', () => {
  it('an upload that only looks like a PNG (magic bytes) but does not parse is skipped, never a failed download', async () => {
    const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
    const out = await new PdfLibRenderer().renderPdf({ templateKey: 't', fields: { '00:body:body': 'x' }, imageCount: 1, images: [fake] });
    expect(Buffer.from(out.bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-');
  });
});
