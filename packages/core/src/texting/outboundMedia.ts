// Outbound MMS media (R-MMS-3, R-MMS-4): which files we send, and removal of the metadata that could
// reveal a location (Exif GPS, XMP, comments, QuickTime/MP4 user data) before a file leaves the system.
// Pure byte walking: nothing is decoded or re-encoded, and there is no dependency.
//
// checkOutboundMedia runs AFTER the inbound-style checkMedia (apps/api/src/comms/media.ts) and narrows it:
// five types only, the file brand for video, and the carrier size limits.
//
// stripMediaMetadata design choices
// - JPEG: the minimal Exif carrying the source Orientation is inserted right after the APP0 JFIF segment
//   when that segment directly follows SOI (JFIF requires APP0 first), otherwise right after SOI. Only an
//   Orientation SHORT (type 3) with value 2-8 in IFD0 of the first Exif APP1 that has one is carried over.
//   Fill bytes (FF FF ...) before a marker outside scan data are dropped; scan data are copied verbatim.
// - PNG: CRCs are not verified (kept chunks are copied byte-identical, so a bad CRC stays bad, never
//   becomes good). IHDR must be the first chunk.
// - GIF: unknown extension labels are dropped (they are outside the kept set).
// - MP4/QuickTime: only the top level, moov, and each moov/trak are walked (box sizes are validated there);
//   udta/meta/uuid there become same-size `free` boxes. A size-0 box is accepted only at the top level
//   (where it necessarily runs to the end of the file and so is last).
// - A declared type outside OUTBOUND_MEDIA_TYPES is MALFORMED (call checkOutboundMedia first).

export const OUTBOUND_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/quicktime'] as const;
export type OutboundMediaType = (typeof OUTBOUND_MEDIA_TYPES)[number];

export const MMS_LIMITS = { maxItems: 10, totalBytes: 5_000_000, imageBytes: 5_000_000, videoBytes: 500_000 } as const;

/** ftyp major brands accepted for video/mp4. */
export const MP4_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V '] as const;
/** ftyp major brands accepted for video/quicktime. */
export const QUICKTIME_BRANDS = ['qt  '] as const;
/** Brands that are explicitly never sent as video (HEIF stills, audio-only, 3GPP). Not in MP4_BRANDS either. */
const REFUSED_BRAND = /^(?:heic|heix|mif1|msf1|M4A |3gp.)$/;

export type OutboundMediaRefusal = 'TYPE_NOT_ALLOWED' | 'BRAND_NOT_ALLOWED' | 'CONTENT_MISMATCH' | 'TOO_LARGE';
export type OutboundMediaCheck = { ok: true } | { ok: false; reason: OutboundMediaRefusal; limitBytes?: number };
export type StripFailure = 'MALFORMED' | 'LOCATION_REMAINS';
export type StripResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: StripFailure };

// ---- byte helpers ---------------------------------------------------------------------------------------

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}
function u16(b: Uint8Array, at: number): number {
  return (b[at]! << 8) | b[at + 1]!;
}
function u32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}
function startsWith(b: Uint8Array, at: number, s: string): boolean {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}
function bytesOf(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function contains(b: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0]!;
  outer: for (let i = b.indexOf(first); i >= 0 && i + needle.length <= b.length; i = b.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function normalizeType(type: string): string {
  return (type.split(';')[0] ?? '').trim().toLowerCase();
}
function isOutboundType(t: string): t is OutboundMediaType {
  return (OUTBOUND_MEDIA_TYPES as readonly string[]).includes(t);
}
const isVideo = (t: OutboundMediaType): boolean => t === 'video/mp4' || t === 'video/quicktime';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniff(t: OutboundMediaType, b: Uint8Array): boolean {
  switch (t) {
    case 'image/jpeg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x);
    case 'image/gif':
      return startsWith(b, 0, 'GIF87a') || startsWith(b, 0, 'GIF89a');
    case 'video/mp4':
    case 'video/quicktime':
      return b.length >= 12 && startsWith(b, 4, 'ftyp');
  }
}

/** R-MMS-3: may this file be sent as outbound MMS media of the declared type? */
export function checkOutboundMedia(type: string, bytes: Uint8Array): OutboundMediaCheck {
  const t = normalizeType(type);
  if (!isOutboundType(t)) return { ok: false, reason: 'TYPE_NOT_ALLOWED' };
  if (!sniff(t, bytes)) return { ok: false, reason: 'CONTENT_MISMATCH' };
  if (isVideo(t)) {
    const brand = ascii(bytes, 8, 4);
    const allowed: readonly string[] = t === 'video/mp4' ? MP4_BRANDS : QUICKTIME_BRANDS;
    if (REFUSED_BRAND.test(brand) || !allowed.includes(brand)) return { ok: false, reason: 'BRAND_NOT_ALLOWED' };
  }
  const limitBytes = isVideo(t) ? MMS_LIMITS.videoBytes : MMS_LIMITS.imageBytes;
  if (bytes.byteLength > limitBytes) return { ok: false, reason: 'TOO_LARGE', limitBytes };
  return { ok: true };
}

// ---- JPEG -------------------------------------------------------------------------------------------------

interface JpegItem {
  /** marker byte (0 for entropy-coded scan data) */
  m: number;
  start: number;
  end: number;
}

const isRst = (m: number): boolean => m >= 0xd0 && m <= 0xd7;
const isApp = (m: number): boolean => m >= 0xe0 && m <= 0xef;

/** SOI .. first EOI as marker segments, standalone markers and scan data; null when malformed. */
function parseJpeg(b: Uint8Array): { items: JpegItem[]; end: number } | null {
  if (b.length < 2 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const items: JpegItem[] = [{ m: 0xd8, start: 0, end: 2 }];
  let pos = 2;
  for (;;) {
    if (pos >= b.length || b[pos] !== 0xff) return null;
    let p = pos;
    while (p < b.length && b[p] === 0xff) p++; // fill bytes
    if (p >= b.length) return null;
    const m = b[p]!;
    const start = p - 1;
    if (m === 0xd9) {
      items.push({ m, start, end: p + 1 });
      return { items, end: p + 1 };
    }
    if (m === 0x00 || m === 0xd8) return null;
    if (isRst(m) || m === 0x01) {
      items.push({ m, start, end: p + 1 });
      pos = p + 1;
      continue;
    }
    if (p + 3 > b.length) return null;
    const len = u16(b, p + 1);
    if (len < 2 || p + 1 + len > b.length) return null;
    const end = p + 1 + len;
    items.push({ m, start, end });
    pos = end;
    if (m !== 0xda) continue;
    // entropy-coded data: runs to the next marker that is not FF00, RSTn or fill
    let i = end;
    for (;;) {
      if (i >= b.length) return null;
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < b.length && b[j] === 0xff) j++;
      if (j >= b.length) return null;
      const c = b[j]!;
      if (c === 0x00 || isRst(c)) {
        i = j + 1;
        continue;
      }
      break;
    }
    if (i > end) items.push({ m: 0, start: end, end: i });
    pos = i;
  }
}

function keepApp(b: Uint8Array, it: JpegItem): boolean {
  const at = it.start + 4;
  if (it.m === 0xe0) return startsWith(b, at, 'JFIF\0');
  if (it.m === 0xe2) return startsWith(b, at, 'ICC_PROFILE\0');
  if (it.m === 0xee) return startsWith(b, at, 'Adobe');
  return false;
}

interface Orientation {
  le: boolean;
  value: number;
}

/** Orientation (2-8) from a TIFF structure (IFD0 only), or null. */
function exifOrientation(t: Uint8Array): Orientation | null {
  if (t.length < 8) return null;
  const order = ascii(t, 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const r16 = (o: number): number => (le ? t[o]! | (t[o + 1]! << 8) : u16(t, o));
  const r32 = (o: number): number => (le ? (t[o]! | (t[o + 1]! << 8) | (t[o + 2]! << 16) | (t[o + 3]! << 24)) >>> 0 : u32(t, o));
  if (r16(2) !== 42) return null;
  const ifd = r32(4);
  if (ifd + 2 > t.length) return null;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + 12 * i;
    if (e + 12 > t.length) return null;
    if (r16(e) !== 0x0112) continue;
    if (r16(e + 2) !== 3 || r32(e + 4) < 1) return null;
    const value = r16(e + 8);
    return value >= 2 && value <= 8 ? { le, value } : null;
  }
  return null;
}

function segmentOrientation(b: Uint8Array, it: JpegItem): Orientation | null {
  if (it.m !== 0xe1 || !startsWith(b, it.start + 4, 'Exif\0\0')) return null;
  return exifOrientation(b.subarray(it.start + 10, it.end));
}

/** APP1 "Exif\0\0" + TIFF header + IFD0 { Orientation SHORT 1 = value } + next IFD 0, in the source byte order. */
function minimalExif(o: Orientation): Uint8Array {
  const t = new Uint8Array(26);
  const w16 = (at: number, v: number): void => {
    t[at] = o.le ? v & 0xff : v >> 8;
    t[at + 1] = o.le ? v >> 8 : v & 0xff;
  };
  const w32 = (at: number, v: number): void => {
    if (o.le) {
      w16(at, v & 0xffff);
      w16(at + 2, v >>> 16);
    } else {
      w16(at, v >>> 16);
      w16(at + 2, v & 0xffff);
    }
  };
  t.set(bytesOf(o.le ? 'II' : 'MM'), 0);
  w16(2, 42);
  w32(4, 8); // IFD0 offset
  w16(8, 1); // one entry
  w16(10, 0x0112);
  w16(12, 3); // SHORT
  w32(14, 1); // count
  w16(18, o.value); // value, left-justified, 2 padding bytes stay 0
  w32(22, 0); // no next IFD
  return concat([Uint8Array.of(0xff, 0xe1, 0x00, 2 + 6 + t.length), bytesOf('Exif\0\0'), t]);
}

function isMinimalExif(b: Uint8Array, it: JpegItem): boolean {
  const o = segmentOrientation(b, it);
  if (!o) return false;
  const want = minimalExif(o);
  return it.end - it.start === want.length && want.every((x, i) => b[it.start + i] === x);
}

function stripJpeg(b: Uint8Array): StripResult {
  const parsed = parseJpeg(b);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };
  let orientation: Orientation | null = null;
  const kept: JpegItem[] = [];
  for (const it of parsed.items) {
    if (isApp(it.m)) {
      if (keepApp(b, it)) kept.push(it);
      else orientation ??= segmentOrientation(b, it);
    } else if (it.m !== 0xfe) kept.push(it); // COM is dropped
  }
  const pieces = kept.map((it) => b.subarray(it.start, it.end));
  if (orientation) {
    const second = kept[1];
    const at = second && second.m === 0xe0 ? 2 : 1; // after APP0 JFIF when it directly follows SOI
    pieces.splice(at, 0, minimalExif(orientation));
  }
  const out = concat(pieces);
  return verifyJpeg(out) ? { ok: true, bytes: out } : { ok: false, reason: 'LOCATION_REMAINS' };
}

function verifyJpeg(b: Uint8Array): boolean {
  const parsed = parseJpeg(b);
  if (!parsed || parsed.end !== b.length) return false;
  return parsed.items.every((it) => it.m !== 0xfe && (!isApp(it.m) || keepApp(b, it) || isMinimalExif(b, it)));
}

// ---- PNG --------------------------------------------------------------------------------------------------

const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const PNG_KEEP = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT']);

interface Chunk {
  type: string;
  start: number;
  end: number;
}

function parsePng(b: Uint8Array): { chunks: Chunk[]; end: number } | null {
  if (!sniff('image/png', b)) return null;
  const chunks: Chunk[] = [];
  let pos = 8;
  for (;;) {
    if (pos + 12 > b.length) return null;
    const len = u32(b, pos);
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > b.length) return null;
    const type = ascii(b, pos + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const critical = (b[pos + 4]! & 0x20) === 0;
    if (critical && !PNG_CRITICAL.has(type)) return null;
    if (chunks.length === 0 && type !== 'IHDR') return null;
    chunks.push({ type, start: pos, end });
    pos = end;
    if (type === 'IEND') return { chunks, end };
  }
}

const keepChunk = (c: Chunk): boolean => PNG_CRITICAL.has(c.type) || PNG_KEEP.has(c.type);

function stripPng(b: Uint8Array): StripResult {
  const parsed = parsePng(b);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };
  const out = concat([b.subarray(0, 8), ...parsed.chunks.filter(keepChunk).map((c) => b.subarray(c.start, c.end))]);
  const check = parsePng(out);
  const clean = check !== null && check.end === out.length && check.chunks.every(keepChunk);
  return clean ? { ok: true, bytes: out } : { ok: false, reason: 'LOCATION_REMAINS' };
}

// ---- GIF --------------------------------------------------------------------------------------------------

const GIF_APP_KEEP = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

interface GifBlock {
  keep: boolean;
  start: number;
  end: number;
}

/** End of a data sub-block chain starting at `q`, or -1. */
function skipSubBlocks(b: Uint8Array, q: number): number {
  for (;;) {
    if (q >= b.length) return -1;
    const n = b[q]!;
    q += 1;
    if (n === 0) return q;
    q += n;
    if (q > b.length) return -1;
  }
}

const colorTableBytes = (packed: number): number => (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);

function parseGif(b: Uint8Array): { blocks: GifBlock[]; end: number } | null {
  if (b.length < 13 || !sniff('image/gif', b)) return null;
  let pos = 13 + colorTableBytes(b[10]!);
  if (pos > b.length) return null;
  const blocks: GifBlock[] = [{ keep: true, start: 0, end: pos }];
  for (;;) {
    if (pos >= b.length) return null;
    const s = b[pos]!;
    if (s === 0x3b) {
      blocks.push({ keep: true, start: pos, end: pos + 1 });
      return { blocks, end: pos + 1 };
    }
    let q: number;
    let keep: boolean;
    if (s === 0x2c) {
      if (pos + 10 > b.length) return null;
      q = pos + 10 + colorTableBytes(b[pos + 9]!) + 1; // + LZW minimum code size
      if (q > b.length) return null;
      q = skipSubBlocks(b, q);
      keep = true;
    } else if (s === 0x21) {
      if (pos + 2 > b.length) return null;
      const label = b[pos + 1]!;
      const first = pos + 2;
      q = skipSubBlocks(b, first);
      keep = label === 0xf9 || label === 0x01 || (label === 0xff && b[first] === 11 && GIF_APP_KEEP.has(ascii(b, first + 1, 11)));
    } else return null;
    if (q < 0) return null;
    blocks.push({ keep, start: pos, end: q });
    pos = q;
  }
}

function stripGif(b: Uint8Array): StripResult {
  const parsed = parseGif(b);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };
  const out = concat(parsed.blocks.filter((x) => x.keep).map((x) => b.subarray(x.start, x.end)));
  const check = parseGif(out);
  const clean = check !== null && check.end === out.length && check.blocks.every((x) => x.keep);
  return clean ? { ok: true, bytes: out } : { ok: false, reason: 'LOCATION_REMAINS' };
}

// ---- MP4 / QuickTime --------------------------------------------------------------------------------------

interface Box {
  type: string;
  start: number;
  headerLen: number;
  end: number;
}

const BLANKED = new Set(['udta', 'meta', 'uuid']);

/** The boxes in [start, end); null when a size is invalid or a box runs past its parent. */
function readBoxes(b: Uint8Array, start: number, end: number, topLevel: boolean): Box[] | null {
  const boxes: Box[] = [];
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) return null;
    const size = u32(b, pos);
    const type = ascii(b, pos + 4, 4);
    let headerLen = 8;
    let boxEnd: number;
    if (size === 1) {
      if (end - pos < 16) return null;
      const large = u32(b, pos + 8) * 2 ** 32 + u32(b, pos + 12);
      if (large < 16) return null;
      headerLen = 16;
      boxEnd = pos + large;
    } else if (size === 0) {
      if (!topLevel) return null; // runs to the end of the file: only the last top-level box
      boxEnd = end;
    } else if (size < 8) return null;
    else boxEnd = pos + size;
    if (boxEnd > end) return null;
    boxes.push({ type, start: pos, headerLen, end: boxEnd });
    pos = boxEnd;
  }
  return boxes;
}

/** udta/meta/uuid at the top level, in moov and in each moov/trak; null when malformed. */
function metadataBoxes(b: Uint8Array): Box[] | null {
  const top = readBoxes(b, 0, b.length, true);
  if (!top) return null;
  const found = top.filter((x) => BLANKED.has(x.type));
  for (const moov of top.filter((x) => x.type === 'moov')) {
    const kids = readBoxes(b, moov.start + moov.headerLen, moov.end, false);
    if (!kids) return null;
    found.push(...kids.filter((x) => BLANKED.has(x.type)));
    for (const trak of kids.filter((x) => x.type === 'trak')) {
      const tk = readBoxes(b, trak.start + trak.headerLen, trak.end, false);
      if (!tk) return null;
      found.push(...tk.filter((x) => BLANKED.has(x.type)));
    }
  }
  return found;
}

const XYZ = Uint8Array.of(0xa9, 0x78, 0x79, 0x7a); // ©xyz
const ISO6709 = bytesOf('ISO6709');
const FREE = bytesOf('free');

function stripVideo(b: Uint8Array): StripResult {
  const out = b.slice();
  const boxes = metadataBoxes(out);
  if (!boxes) return { ok: false, reason: 'MALFORMED' };
  for (const x of boxes) {
    out.set(FREE, x.start + 4);
    out.fill(0, x.start + x.headerLen, x.end);
  }
  const again = metadataBoxes(out);
  const clean = again !== null && again.length === 0 && !contains(out, XYZ) && !contains(out, ISO6709);
  return clean ? { ok: true, bytes: out } : { ok: false, reason: 'LOCATION_REMAINS' };
}

// ---- entry point ------------------------------------------------------------------------------------------

/**
 * R-MMS-4: the file without location-bearing metadata, or why it cannot be sent. Never returns the input
 * array itself. Fails closed: the output is walked again and anything outside the kept sets refuses it.
 */
export function stripMediaMetadata(type: string, bytes: Uint8Array): StripResult {
  const t = normalizeType(type);
  if (!isOutboundType(t)) return { ok: false, reason: 'MALFORMED' };
  switch (t) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/gif':
      return stripGif(bytes);
    case 'video/mp4':
    case 'video/quicktime':
      return stripVideo(bytes);
  }
}
