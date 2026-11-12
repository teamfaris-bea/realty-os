// Synthetic media fixtures for the texting tests: every file is assembled byte by byte here (JPEG markers,
// PNG chunks with real CRCs, GIF blocks, ISO-BMFF boxes). No real photo; every coordinate is invented.

export const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function cat(...parts: (Uint8Array | number[] | string)[]): Uint8Array {
  const arrs = parts.map((p) => (typeof p === 'string' ? bytes(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export function indexOfBytes(hay: Uint8Array, needle: Uint8Array | number[] | string): number {
  const n = cat(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

const be16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

// ---- JPEG ----------------------------------------------------------------------------------------------

export const SOI = [0xff, 0xd8];
export const EOI = [0xff, 0xd9];

export function seg(marker: number, payload: Uint8Array | number[] | string): Uint8Array {
  const p = cat(payload);
  return cat([0xff, marker], be16(p.length + 2), p);
}

export const jfif = (): Uint8Array => seg(0xe0, cat('JFIF\0', [1, 2, 0, 0, 1, 0, 1, 0, 0]));
export const dqt = (): Uint8Array => seg(0xdb, cat([0], new Uint8Array(64).fill(1)));
export const sof = (m = 0xc0): Uint8Array => seg(m, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]);
export const dht = (cls = 0): Uint8Array => seg(0xc4, cat([cls], [0, 1, ...new Array<number>(14).fill(0)], [0]));
export const sos = (ss = 0, se = 63): Uint8Array => seg(0xda, [1, 1, 0, ss, se, 0]);
/** entropy-coded data with byte stuffing (FF00) and a restart marker (FFD0) */
export const scanData = (seed = 1): Uint8Array => cat([0x12 * seed & 0xff, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a, 0xff, 0x00, seed & 0xff]);

/** A TIFF structure: IFD0 {Orientation?, GPSInfo pointer} + GPS IFD {LatitudeRef 'N', Latitude 12/1 34/1 5600/100}. */
export function tiffWithGps(le: boolean, orientation: number | null): Uint8Array {
  const w16 = (v: number): number[] => (le ? [v & 0xff, (v >> 8) & 0xff] : be16(v));
  const w32 = (v: number): number[] => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff] : be32(v));
  const ifd0Entries = orientation === null ? 1 : 2;
  const ifd0Len = 2 + 12 * ifd0Entries + 4;
  const gpsAt = 8 + ifd0Len;
  const gpsLen = 2 + 24 + 4;
  const dataAt = gpsAt + gpsLen;
  const ifd0 = [
    ...w16(ifd0Entries),
    ...(orientation === null ? [] : [...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0]),
    ...w16(0x8825), ...w16(4), ...w32(1), ...w32(gpsAt),
    ...w32(0),
  ];
  const gps = [
    ...w16(2),
    ...w16(0x0001), ...w16(2), ...w32(2), 0x4e, 0, 0, 0, // GPSLatitudeRef "N"
    ...w16(0x0002), ...w16(5), ...w32(3), ...w32(dataAt), // GPSLatitude -> rationals
    ...w32(0),
  ];
  const data = [...w32(12), ...w32(1), ...w32(34), ...w32(1), ...w32(5600), ...w32(100)];
  return cat(le ? 'II' : 'MM', w16(42), w32(8), ifd0, gps, data);
}

export const exifApp1 = (le: boolean, orientation: number | null): Uint8Array => seg(0xe1, cat('Exif\0\0', tiffWithGps(le, orientation)));
export const xmpApp1 = (): Uint8Array => seg(0xe1, cat('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta><exif:GPSLatitude>12,34.56N</exif:GPSLatitude></x:xmpmeta>'));
export const com = (text = 'taken at 12.3456,-65.4321'): Uint8Array => seg(0xfe, text);

export function baselineJpeg(opts: { exif?: Uint8Array; jfif?: boolean; extra?: Uint8Array[] } = {}): Uint8Array {
  return cat(SOI, opts.jfif === false ? [] : jfif(), opts.exif ?? [], ...(opts.extra ?? []), dqt(), sof(), dht(), sos(), scanData(), EOI);
}

// ---- PNG -----------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function chunk(type: string, data: Uint8Array | number[] | string = []): Uint8Array {
  const d = cat(data);
  const td = cat(type, d);
  return cat(be32(d.length), td, be32(crc32(td)));
}

export const ihdr = (): Uint8Array => chunk('IHDR', [...be32(1), ...be32(1), 8, 2, 0, 0, 0]);
export const idat = (): Uint8Array => chunk('IDAT', [0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x01, 0x01, 0x01, 0x00]);
export const iend = (): Uint8Array => chunk('IEND');
export const png = (...middle: Uint8Array[]): Uint8Array => cat(PNG_SIG, ihdr(), ...middle, idat(), iend());

// ---- GIF -----------------------------------------------------------------------------------------------

export const gifHeader = (): Uint8Array => cat('GIF89a', [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 0xff, 0xff, 0xff]);
export const netscape = (): Uint8Array => cat([0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0]);
export const gce = (): Uint8Array => cat([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);
export const gifComment = (text = 'at 12.3456,-65.4321'): Uint8Array => cat([0x21, 0xfe, text.length], text, [0]);
export function gifXmp(): Uint8Array {
  const xmp = '<x:xmpmeta><exif:GPSLatitude>12,34.56N</exif:GPSLatitude></x:xmpmeta>';
  return cat([0x21, 0xff, 11], 'XMP DataXMP', [xmp.length], xmp, [0]);
}
export const gifImage = (): Uint8Array => cat([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2], [2, 0x44, 0x01], [0]);
export const GIF_TRAILER = [0x3b];

// ---- ISO-BMFF (MP4 / QuickTime) ------------------------------------------------------------------------

export function box(type: string | number[], ...payload: (Uint8Array | number[] | string)[]): Uint8Array {
  const p = cat(...payload);
  return cat(be32(p.length + 8), typeof type === 'string' ? bytes(type) : type, p);
}

export function largeBox(type: string, payload: Uint8Array): Uint8Array {
  return cat(be32(1), type, be32(0), be32(payload.length + 16), payload);
}

export const ftyp = (brand: string): Uint8Array => box('ftyp', brand, be32(0), brand, 'isom');
export const XYZ = [0xa9, 0x78, 0x79, 0x7a];
/** moov/udta/©xyz with an invented ISO 6709 location */
export const udtaXyz = (): Uint8Array => box('udta', box(XYZ, be16(18), be16(0), '+12.3456-065.4321/'));
export const mdatPayload = (n = 64): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0x7f);

export function stsd(extra: Uint8Array | string = ''): Uint8Array {
  return box('stsd', [0, 0, 0, 0], be32(1), box('avc1', new Uint8Array(78)), extra);
}

export function trak(opts: { udta?: boolean; stsdExtra?: Uint8Array | string } = {}): Uint8Array {
  const stbl = box('stbl', stsd(opts.stsdExtra ?? ''), box('stco', [0, 0, 0, 0], be32(0)));
  const minf = box('minf', box('vmhd', new Uint8Array(12)), stbl);
  const mdia = box('mdia', box('mdhd', new Uint8Array(24)), box('hdlr', new Uint8Array(25)), minf);
  return box('trak', box('tkhd', new Uint8Array(84)), mdia, opts.udta ? box('udta', box('name', 'cam')) : []);
}

export function mp4(opts: { brand?: string; udta?: boolean; meta?: boolean; uuid?: boolean; trakUdta?: boolean; stsdExtra?: Uint8Array | string; mdat?: Uint8Array } = {}): Uint8Array {
  const moov = box(
    'moov',
    box('mvhd', new Uint8Array(100)),
    trak({ udta: opts.trakUdta ?? false, stsdExtra: opts.stsdExtra ?? '' }),
    opts.udta === false ? [] : udtaXyz(),
    opts.meta ? box('meta', [0, 0, 0, 0], box('keys', 'mdta', 'com.apple.quicktime.location.ISO6709')) : [],
  );
  return cat(ftyp(opts.brand ?? 'isom'), moov, opts.uuid ? box('uuid', new Uint8Array(16).fill(0xab), 'xmp GPS') : [], box('mdat', opts.mdat ?? mdatPayload()));
}
