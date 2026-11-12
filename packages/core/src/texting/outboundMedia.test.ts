import { describe, expect, it } from 'vitest';
import { MMS_LIMITS, OUTBOUND_MEDIA_TYPES, checkOutboundMedia } from './index.js';
import { EOI, GIF_TRAILER, baselineJpeg, box, bytes, cat, ftyp, gifHeader, gifImage, mdatPayload, mp4, png } from './testing/fixtures.js';

const gif = (): Uint8Array => cat(gifHeader(), gifImage(), GIF_TRAILER);
const mp4Plain = (brand: string): Uint8Array => cat(ftyp(brand), box('moov', box('mvhd', new Uint8Array(100))), box('mdat', mdatPayload()));

describe('R-MMS-3 (E294) checkOutboundMedia', () => {
  it('R-MMS-3 E294: the constants are the five types and the carrier limits', () => {
    expect(OUTBOUND_MEDIA_TYPES).toEqual(['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/quicktime']);
    expect(MMS_LIMITS).toEqual({ maxItems: 10, totalBytes: 5_000_000, imageBytes: 5_000_000, videoBytes: 500_000 });
  });

  it.each([
    ['image/jpeg', baselineJpeg()],
    ['image/png', png()],
    ['image/gif', gif()],
    ['video/mp4', mp4()],
    ['video/mp4', mp4Plain('mp42')],
    ['video/mp4', mp4Plain('M4V ')],
    ['video/quicktime', mp4Plain('qt  ')],
    ['IMAGE/JPEG; charset=binary', baselineJpeg()],
  ])('R-MMS-3 E294: accepts a valid %s fixture', (type, b) => {
    expect(checkOutboundMedia(type, b)).toEqual({ ok: true });
  });

  it('R-MMS-3 E294: refuses a PNG declared as JPEG', () => {
    expect(checkOutboundMedia('image/jpeg', png())).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
  });

  it.each([
    ['heic', 'BRAND_NOT_ALLOWED'],
    ['heix', 'BRAND_NOT_ALLOWED'],
    ['mif1', 'BRAND_NOT_ALLOWED'],
    ['msf1', 'BRAND_NOT_ALLOWED'],
    ['M4A ', 'BRAND_NOT_ALLOWED'],
    ['3gp4', 'BRAND_NOT_ALLOWED'],
    ['3gp5', 'BRAND_NOT_ALLOWED'],
    ['qt  ', 'BRAND_NOT_ALLOWED'],
    ['dash', 'BRAND_NOT_ALLOWED'],
  ])('R-MMS-3 E294: refuses brand %j declared as video/mp4', (brand, reason) => {
    expect(checkOutboundMedia('video/mp4', mp4Plain(brand))).toEqual({ ok: false, reason });
  });

  it('R-MMS-3 E294: QuickTime needs the qt brand, and a video needs an ftyp box', () => {
    expect(checkOutboundMedia('video/quicktime', mp4Plain('isom'))).toEqual({ ok: false, reason: 'BRAND_NOT_ALLOWED' });
    expect(checkOutboundMedia('video/quicktime', cat(box('moov', box('mvhd', new Uint8Array(100)))))).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' });
  });

  const svg = bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
  const html = bytes('<!doctype html><html><body><script>x()</script></body></html>');
  it.each([
    ['SVG as image/jpeg', 'image/jpeg', svg, 'CONTENT_MISMATCH'],
    ['SVG as image/svg+xml', 'image/svg+xml', svg, 'TYPE_NOT_ALLOWED'],
    ['HTML as image/jpeg', 'image/jpeg', html, 'CONTENT_MISMATCH'],
    ['HTML as text/html', 'text/html', html, 'TYPE_NOT_ALLOWED'],
    ['a JPEG as image/webp', 'image/webp', baselineJpeg(), 'TYPE_NOT_ALLOWED'],
    ['a JPEG as image/heic', 'image/heic', baselineJpeg(), 'TYPE_NOT_ALLOWED'],
    ['a GIF as image/png', 'image/png', gif(), 'CONTENT_MISMATCH'],
    ['empty bytes as image/gif', 'image/gif', new Uint8Array(0), 'CONTENT_MISMATCH'],
  ])('R-MMS-3 E294: refuses %s', (_n, type, b, reason) => {
    expect(checkOutboundMedia(type, b)).toEqual({ ok: false, reason });
  });

  it('R-MMS-3 E294: a video over 500,000 bytes is TOO_LARGE with limitBytes 500000', () => {
    const at = mp4({ mdat: mdatPayload(500_000 - mp4({ mdat: new Uint8Array(0) }).length) });
    expect(at.length).toBe(500_000);
    expect(checkOutboundMedia('video/mp4', at)).toEqual({ ok: true });
    const over = mp4({ mdat: mdatPayload(500_001 - mp4({ mdat: new Uint8Array(0) }).length) });
    expect(over.length).toBe(500_001);
    expect(checkOutboundMedia('video/mp4', over)).toEqual({ ok: false, reason: 'TOO_LARGE', limitBytes: 500_000 });
  });

  it('R-MMS-3 E294: an image over 5,000,000 bytes is TOO_LARGE with limitBytes 5000000', () => {
    const base = baselineJpeg();
    const pad = new Uint8Array(5_000_001 - base.length);
    const big = cat(base.subarray(0, base.length - 2), pad, EOI);
    expect(checkOutboundMedia('image/jpeg', big)).toEqual({ ok: false, reason: 'TOO_LARGE', limitBytes: 5_000_000 });
    expect(checkOutboundMedia('image/jpeg', big.subarray(0, 5_000_000))).toEqual({ ok: true });
  });
});
