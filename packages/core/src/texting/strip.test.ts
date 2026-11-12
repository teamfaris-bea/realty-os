import { describe, expect, it } from 'vitest';
import { stripMediaMetadata, type StripResult } from './index.js';
import {
  EOI,
  GIF_TRAILER,
  PNG_SIG,
  SOI,
  XYZ,
  baselineJpeg,
  box,
  bytes,
  cat,
  chunk,
  com,
  dht,
  dqt,
  exifApp1,
  ftyp,
  gce,
  gifComment,
  gifHeader,
  gifImage,
  gifXmp,
  idat,
  iend,
  ihdr,
  indexOfBytes,
  jfif,
  largeBox,
  mdatPayload,
  mp4,
  netscape,
  png,
  scanData,
  seg,
  sof,
  sos,
  xmpApp1,
} from './testing/fixtures.js';

function ok(r: StripResult): Uint8Array {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.bytes;
}

/** The expected minimal Exif, written out by hand: APP1, "Exif\0\0", TIFF header, IFD0 {0x0112 SHORT 1 = v}, next 0. */
function minimalExifLE(v: number): Uint8Array {
  return seg(0xe1, cat('Exif\0\0', 'II', [0x2a, 0], [8, 0, 0, 0], [1, 0], [0x12, 0x01], [3, 0], [1, 0, 0, 0], [v, 0, 0, 0], [0, 0, 0, 0]));
}
function minimalExifBE(v: number): Uint8Array {
  return seg(0xe1, cat('Exif\0\0', 'MM', [0, 0x2a], [0, 0, 0, 8], [0, 1], [0x01, 0x12], [0, 3], [0, 0, 0, 1], [0, v, 0, 0], [0, 0, 0, 0]));
}

const scanOf = (b: Uint8Array): Uint8Array => {
  const at = indexOfBytes(b, sos());
  return b.subarray(at, b.length - 2);
};

// every fixture the idempotency test runs over
const fixtures: [string, string, Uint8Array][] = [];
const idempotent = (name: string, type: string, b: Uint8Array): void => {
  const once = stripMediaMetadata(type, b);
  if (!once.ok) return; // a refused fixture has nothing to re-strip
  expect(stripMediaMetadata(type, once.bytes), `${name} idempotent`).toEqual(once);
};
// each fixture is checked for idempotency where it is built, so a test run on its own still checks its own fixtures
const add = (name: string, type: string, b: Uint8Array): Uint8Array => {
  fixtures.push([name, type, b]);
  idempotent(name, type, b);
  return b;
};

describe('R-MMS-4 (E295) JPEG', () => {
  it('R-MMS-4 E295: Exif GPS + Orientation 6 keeps only a minimal Orientation Exif, scan data byte-identical', () => {
    for (const [le, want] of [
      [true, minimalExifLE(6)],
      [false, minimalExifBE(6)],
    ] as const) {
      const src = add(`jpeg exif gps ${le ? 'II' : 'MM'}`, 'image/jpeg', baselineJpeg({ exif: exifApp1(le, 6), extra: [xmpApp1(), com()] }));
      const out = ok(stripMediaMetadata('image/jpeg', src));
      expect(out).toEqual(cat(SOI, jfif(), want, dqt(), sof(), dht(), sos(), scanData(), EOI));
      expect(scanOf(out)).toEqual(scanOf(src));
      expect(indexOfBytes(out, 'http://ns.adobe.com')).toBe(-1);
      expect(out).not.toBe(src);
    }
  });

  it('R-MMS-4 E295: without APP0 JFIF the minimal Exif goes right after SOI; Orientation 1 adds no Exif', () => {
    const noJfif = add('jpeg no jfif', 'image/jpeg', baselineJpeg({ jfif: false, exif: exifApp1(true, 8) }));
    expect(ok(stripMediaMetadata('image/jpeg', noJfif))).toEqual(cat(SOI, minimalExifLE(8), dqt(), sof(), dht(), sos(), scanData(), EOI));
    const upright = add('jpeg orientation 1', 'image/jpeg', baselineJpeg({ exif: exifApp1(true, 1) }));
    expect(ok(stripMediaMetadata('image/jpeg', upright))).toEqual(baselineJpeg());
    const noOrientation = add('jpeg gps only', 'image/jpeg', baselineJpeg({ exif: exifApp1(false, null) }));
    expect(ok(stripMediaMetadata('image/jpeg', noOrientation))).toEqual(baselineJpeg());
  });

  it('R-MMS-4 E295: a progressive JPEG with an Exif-GPS APP1 (and a COM) between scans comes out without them', () => {
    const head = cat(SOI, jfif(), dqt(), sof(0xc2), dht(0));
    const scan1 = cat(sos(0, 0), scanData(1));
    const scan2 = cat(sos(1, 63), scanData(2));
    const src = add('jpeg progressive', 'image/jpeg', cat(head, scan1, dht(1), exifApp1(true, null), com(), scan2, [0xff, 0xff], EOI));
    expect(ok(stripMediaMetadata('image/jpeg', src))).toEqual(cat(head, scan1, dht(1), scan2, EOI));
  });

  it('R-MMS-4 E295: an MPF APP2 + secondary image and an MP4 appended after EOI are dropped', () => {
    const mpf = seg(0xe2, cat('MPF\0', 'II', [0x2a, 0], new Uint8Array(20)));
    const src = add('jpeg mpf', 'image/jpeg', cat(baselineJpeg({ extra: [mpf] }), baselineJpeg({ exif: exifApp1(true, 3) }), mp4()));
    expect(ok(stripMediaMetadata('image/jpeg', src))).toEqual(baselineJpeg());
  });

  it('R-MMS-4 E295: APP2 ICC_PROFILE and APP14 Adobe are kept; APP13 and other APPn are dropped', () => {
    const icc = seg(0xe2, cat('ICC_PROFILE\0', [1, 1], new Uint8Array(16).fill(7)));
    const adobe = seg(0xee, cat('Adobe', [0, 100, 0, 0, 0, 0, 1]));
    const app13 = seg(0xed, cat('Photoshop 3.0\0', '8BIM', new Uint8Array(8)));
    const app5 = seg(0xe5, 'vendor');
    const src = add('jpeg app mix', 'image/jpeg', baselineJpeg({ extra: [icc, app13, adobe, app5] }));
    expect(ok(stripMediaMetadata('image/jpeg', src))).toEqual(baselineJpeg({ extra: [icc, adobe] }));
  });

  it.each([
    ['no EOI', cat(SOI, jfif(), dqt(), sof(), sos(), scanData())],
    ['no EOI after markers', cat(SOI, jfif(), dqt())],
    ['a segment length below 2', cat(SOI, [0xff, 0xe1, 0x00, 0x01], EOI)],
    ['a segment running past the end', cat(SOI, [0xff, 0xdb, 0x01, 0x00, 1, 2, 3], EOI)],
    ['garbage between segments', cat(SOI, jfif(), [0x12, 0x34], EOI)],
    ['not a JPEG', bytes('GIF89a')],
  ])('R-MMS-4 E295: a JPEG with %s is MALFORMED', (_n, b) => {
    expect(stripMediaMetadata('image/jpeg', b)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('R-MMS-4 (E295) PNG', () => {
  it('R-MMS-4 E295: eXIf, tEXt, iTXt, zTXt and tIME are dropped, kept chunks byte-identical, bytes after IEND dropped', () => {
    const phys = chunk('pHYs', [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]);
    const srgb = chunk('sRGB', [0]);
    const exif = chunk('eXIf', cat('MM', [0, 0x2a], [0, 0, 0, 8], [0, 0]));
    const text = chunk('tEXt', 'Comment\0at 12.3456,-65.4321');
    const itxt = chunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>GPS</x:xmpmeta>');
    const ztxt = chunk('zTXt', 'Comment\0\0xx');
    const time = chunk('tIME', [0x07, 0xea, 1, 2, 3, 4, 5]);
    const src = add('png', 'image/png', cat(png(srgb, exif, phys, text, itxt, ztxt, time), 'trailing data GPS'));
    expect(ok(stripMediaMetadata('image/png', src))).toEqual(png(srgb, phys));
  });

  it.each([
    ['an unknown critical chunk', png(chunk('ABCD', [1, 2]))],
    ['a chunk length past the end', cat(PNG_SIG, ihdr(), [0, 0, 1, 0], 'IDAT', [1, 2, 3])],
    ['no IEND', cat(PNG_SIG, ihdr(), idat())],
    ['IHDR not first', cat(PNG_SIG, idat(), ihdr(), iend())],
    ['a non-letter chunk type', png(chunk('ab1d', [1]))],
  ])('R-MMS-4 E295: a PNG with %s is MALFORMED', (_n, b) => {
    expect(stripMediaMetadata('image/png', b)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('R-MMS-4 (E295) GIF', () => {
  it('R-MMS-4 E295: comment and XMP extensions are dropped, NETSCAPE2.0 and GCE kept, bytes after the trailer dropped', () => {
    const src = add('gif', 'image/gif', cat(gifHeader(), netscape(), gifComment(), gifXmp(), gce(), gifImage(), gifComment('x'), GIF_TRAILER, 'after trailer'));
    expect(ok(stripMediaMetadata('image/gif', src))).toEqual(cat(gifHeader(), netscape(), gce(), gifImage(), GIF_TRAILER));
  });

  it('R-MMS-4 E295: ANIMEXTS1.0 and plain-text extensions are kept', () => {
    const anim = cat([0x21, 0xff, 11], 'ANIMEXTS1.0', [3, 1, 0, 0, 0]);
    const plain = cat([0x21, 0x01, 12], new Uint8Array(12), [2, 0x41, 0x42, 0]);
    const src = add('gif anim', 'image/gif', cat(gifHeader(), anim, plain, gifImage(), GIF_TRAILER));
    expect(ok(stripMediaMetadata('image/gif', src))).toEqual(src);
  });

  it.each([
    ['a missing trailer', cat(gifHeader(), gifImage())],
    ['a sub-block past the end', cat(gifHeader(), [0x21, 0xfe, 40, 1, 2])],
    ['an unknown block', cat(gifHeader(), [0x99], GIF_TRAILER)],
  ])('R-MMS-4 E295: a GIF with %s is MALFORMED', (_n, b) => {
    expect(stripMediaMetadata('image/gif', b)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('R-MMS-4 (E295) MP4 / QuickTime', () => {
  const mdatAt = (b: Uint8Array): number => indexOfBytes(b, 'mdat');

  it('R-MMS-4 E295: an MP4 with moov/udta/©xyz keeps its length, its mdat is identical, udta becomes free', () => {
    const src = add('mp4 udta', 'video/mp4', mp4());
    expect(indexOfBytes(src, XYZ)).toBeGreaterThan(0);
    const out = ok(stripMediaMetadata('video/mp4', src));
    expect(out.length).toBe(src.length);
    expect(mdatAt(out)).toBe(mdatAt(src));
    expect(out.subarray(mdatAt(out))).toEqual(src.subarray(mdatAt(src)));
    expect(indexOfBytes(out, XYZ)).toBe(-1);
    const at = indexOfBytes(src, 'udta') - 4;
    expect(out.subarray(at, at + 8)).toEqual(cat(src.subarray(at, at + 4), 'free'));
    expect(out.subarray(at + 8, at + 8 + 30).every((x) => x === 0)).toBe(true);
  });

  it('R-MMS-4 E295: meta, uuid, trak/udta and moov/udta are all blanked; only those bytes change', () => {
    const src = add('mp4 all', 'video/mp4', mp4({ meta: true, uuid: true, trakUdta: true }));
    const out = ok(stripMediaMetadata('video/mp4', src));
    expect(out.length).toBe(src.length);
    expect(indexOfBytes(out, 'ISO6709')).toBe(-1);
    expect(indexOfBytes(out, 'xmp GPS')).toBe(-1);
    expect(indexOfBytes(out, 'cam')).toBe(-1);
    for (const t of ['udta', 'meta', 'uuid']) expect(indexOfBytes(out, t)).toBe(-1);
    expect(indexOfBytes(out, 'stsd')).toBe(indexOfBytes(src, 'stsd'));
  });

  it('R-MMS-4 E295: a QuickTime file with moov/meta location keys is stripped the same way', () => {
    const src = add('mov', 'video/quicktime', mp4({ brand: 'qt  ', meta: true }));
    const out = ok(stripMediaMetadata('video/quicktime', src));
    expect(out.length).toBe(src.length);
    expect(indexOfBytes(out, 'ISO6709')).toBe(-1);
  });

  it('R-MMS-4 E295: a 64-bit largesize mdat is accepted, and so is a largesize udta (16-byte header kept)', () => {
    const moov = box('moov', box('mvhd', new Uint8Array(100)), largeBox('udta', cat(box(XYZ, '+12.3456-065.4321/'))));
    const src = add('mp4 largesize', 'video/mp4', cat(ftyp('isom'), moov, largeBox('mdat', mdatPayload(100))));
    const out = ok(stripMediaMetadata('video/mp4', src));
    expect(out.length).toBe(src.length);
    const at = indexOfBytes(src, 'udta') - 4;
    expect(out.subarray(at, at + 16)).toEqual(cat(src.subarray(at, at + 4), 'free', src.subarray(at + 8, at + 16)));
    expect(indexOfBytes(out, XYZ)).toBe(-1);
  });

  it('R-MMS-4 E295: a size-0 last top-level box (runs to end of file) is accepted', () => {
    const src = add('mp4 size0', 'video/mp4', cat(ftyp('isom'), box('moov', box('mvhd', new Uint8Array(100)), box('udta', box(XYZ, 'x'))), [0, 0, 0, 0], 'mdat', mdatPayload(50)));
    const out = ok(stripMediaMetadata('video/mp4', src));
    expect(out.length).toBe(src.length);
    expect(indexOfBytes(out, XYZ)).toBe(-1);
  });

  it.each([
    ['an mebx stsd key "ISO6709"', box('mebx', new Uint8Array(8), box('keys', 'mdta', 'com.apple.quicktime.location.ISO6709'))],
    ['an stsd entry holding ©xyz', box('mebx', new Uint8Array(8), box(XYZ, '+12.3456-065.4321/'))],
  ])('R-MMS-4 E295: %s deep inside moov/trak/mdia/minf/stbl/stsd gives LOCATION_REMAINS', (_n, extra) => {
    expect(stripMediaMetadata('video/mp4', mp4({ udta: false, stsdExtra: extra }))).toEqual({ ok: false, reason: 'LOCATION_REMAINS' });
  });

  const mvhd = box('mvhd', new Uint8Array(100));
  it.each([
    ['a top-level size of 4', cat(ftyp('isom'), [0, 0, 0, 4], 'mdat', mdatPayload(8))],
    ['a size of 7 inside moov', cat(ftyp('isom'), box('moov', mvhd, [0, 0, 0, 7], 'udta'), box('mdat', mdatPayload()))],
    ['a box running past the end of the file', cat(ftyp('isom'), [0, 0, 1, 0], 'mdat', mdatPayload(8))],
    ['a box running past its parent', cat(ftyp('isom'), box('moov', [0, 0, 0, 200], 'trak'), box('mdat', mdatPayload()))],
    ['a size-0 box that is not last (inside moov)', cat(ftyp('isom'), box('moov', [0, 0, 0, 0], 'udta', mvhd), box('mdat', mdatPayload()))],
    ['a largesize below 16', cat(ftyp('isom'), [0, 0, 0, 1], 'mdat', [0, 0, 0, 0, 0, 0, 0, 8])],
    ['trailing bytes too short for a box header', cat(mp4({ udta: false }), [1, 2, 3])],
    ['a bad box inside a trak', cat(ftyp('isom'), box('moov', mvhd, box('trak', [0, 0, 0, 3], 'tkhd')), box('mdat', mdatPayload()))],
  ])('R-MMS-4 E295: %s is MALFORMED', (_n, b) => {
    expect(stripMediaMetadata('video/mp4', b)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('R-MMS-4 (E295) idempotency and fail-closed', () => {
  it('R-MMS-4 E295: stripping is idempotent for every fixture', () => {
    // the fixtures the earlier tests built (when run together), plus clean ones of every kind built here
    const own: [string, string, Uint8Array][] = [['clean jpeg', 'image/jpeg', baselineJpeg()], ['clean png', 'image/png', png()]];
    for (const [name, type, src] of [...fixtures, ...own]) {
      const once = ok(stripMediaMetadata(type, src));
      const twice = ok(stripMediaMetadata(type, once));
      expect(twice, name).toEqual(once);
    }
  });

  it('R-MMS-4 E295: a type outside the five is MALFORMED', () => {
    expect(stripMediaMetadata('image/webp', baselineJpeg())).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});
