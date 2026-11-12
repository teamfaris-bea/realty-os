// D5a: getting a photo or video the agent picked ready to go by text, before anything is uploaded.
//
// - Every still image the browser can decode (JPEG, PNG, WebP, and HEIC/HEIF on Safari) is drawn again as a JPEG:
//   white background (a transparent PNG would turn black on some phones), longest edge at most 1600 px, quality 0.8,
//   the camera's orientation applied (createImageBitmap imageOrientation 'from-image'; the <img> fallback applies it
//   by default). Re-encoding also drops whatever metadata the original carried; the server strips it again anyway.
// - GIFs and videos (MP4, MOV) go up as they are, after the carrier limits are checked here (MMS_LIMITS from
//   @realty/core/texting, the same numbers the API applies).
// - Sizes are said in decimal units (1 KB = 1,000 bytes, 1 MB = 1,000,000), rounded UP to one decimal place, so a
//   file just over a limit never reads as exactly at it ("500.1 KB", never "500 KB"). Attachments.formatBytes is
//   1024-based and is not used here.
//
// jsdom has no canvas: the encoder, and the object URLs of the thumbnails, are injectable (`mediaDeps`).
import { MMS_LIMITS, type OutboundMediaType } from '@realty/core/texting';

export type MediaKind = 'photo' | 'video';

/** The refusals before upload, in exact words (role="alert" in the tray). */
export const REFUSE_TYPE = 'Only photos and videos can be sent by text.';
export const REFUSE_UNREADABLE = "This photo can't be read here. Try a JPEG or PNG.";
export const REFUSE_COUNT = 'Up to 10 photos or videos per text.';
export const REFUSE_TOTAL = 'That would make this text larger than 5 MB in all.';
export const REFUSE_VIDEO_FORMAT = "This kind of video can't be sent by text. Try an MP4 or MOV video.";
export const REFUSE_EMPTY = 'This file is empty.';

export function videoTooLarge(bytes: number): string {
  return `This video is ${formatSize(bytes)}. A text can carry a video of at most ${formatSize(MMS_LIMITS.videoBytes)}. For a longer video, send a link instead.`;
}

export function gifTooLarge(bytes: number): string {
  return `This GIF is ${formatSize(bytes)}. A text can carry a photo of at most ${formatSize(MMS_LIMITS.imageBytes)}.`;
}

const number1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Decimal size rounded up to one decimal place: 999 → "999 bytes", 500,001 → "500.1 KB", 8,400,000 → "8.4 MB". */
export function formatSize(bytes: number): string {
  const n = Math.max(0, Math.ceil(bytes));
  if (n < 1000) return n === 1 ? '1 byte' : `${n} bytes`;
  const tenthsKb = Math.ceil(n / 100);
  if (tenthsKb < 10_000) return `${number1.format(tenthsKb / 10)} KB`;
  return `${number1.format(Math.ceil(n / 100_000) / 10)} MB`;
}

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
};

/** The file's type, from the browser or (when it gives none, as some do for HEIC and MOV) from its extension. */
export function fileType(f: { type: string; name: string }): string {
  const t = (f.type.split(';')[0] ?? '').trim().toLowerCase();
  if (t !== '' && t !== 'application/octet-stream') return t;
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? t;
}

/** What a picked file is: a photo, a video, or a refusal in words. */
export function classifyFile(f: { type: string; name: string; size: number }): { ok: true; kind: MediaKind } | { ok: false; refusal: string } {
  const t = fileType(f);
  if (t.startsWith('image/')) return f.size === 0 ? { ok: false, refusal: REFUSE_EMPTY } : { ok: true, kind: 'photo' };
  if (t === 'video/mp4' || t === 'video/quicktime') return f.size === 0 ? { ok: false, refusal: REFUSE_EMPTY } : { ok: true, kind: 'video' };
  if (t.startsWith('video/')) return { ok: false, refusal: REFUSE_VIDEO_FORMAT };
  return { ok: false, refusal: REFUSE_TYPE };
}

export interface PreparedMedia {
  kind: MediaKind;
  contentType: OutboundMediaType;
  blob: Blob;
  byteSize: number;
}

export type PrepareResult = { ok: true; media: PreparedMedia } | { ok: false; refusal: string };

export interface MediaDeps {
  /** a still image as a JPEG (white background, longest edge ≤ 1600 px, quality 0.8, orientation applied); throws when it can't be decoded */
  encodeJpeg(file: Blob): Promise<Blob>;
  /** a thumbnail URL for a prepared photo, or null where there is none */
  objectUrl(blob: Blob): string | null;
  revokeUrl(url: string): void;
}

export const JPEG_MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.8;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: b, width: b.width, height: b.height, close: () => b.close() };
    } catch {
      // Safari decodes HEIC in <img> where createImageBitmap may refuse it: try that next
    }
  }
  if (typeof Image !== 'function' || typeof URL.createObjectURL !== 'function') throw new Error('no image decoder');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** The browser's encoder: canvas, white background, at most 1600 px on the longest edge, JPEG at 0.8. */
export async function canvasJpeg(file: Blob): Promise<Blob> {
  const img = await decode(file);
  try {
    if (!(img.width > 0 && img.height > 0)) throw new Error('empty image');
    const scale = Math.min(1, JPEG_MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, w, h);
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('encode failed'))), 'image/jpeg', JPEG_QUALITY));
  } finally {
    img.close();
  }
}

/** The real browser dependencies. Tests replace the members (jsdom has no canvas and no object URLs). */
export const mediaDeps: MediaDeps = {
  encodeJpeg: canvasJpeg,
  objectUrl: (b) => (typeof URL.createObjectURL === 'function' ? URL.createObjectURL(b) : null),
  revokeUrl: (u) => {
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(u);
  },
};

/** One picked file, ready to upload (re-encoded, or as it is), or why it can't go. Never throws. */
export async function prepareMedia(file: File, deps: MediaDeps = mediaDeps): Promise<PrepareResult> {
  const c = classifyFile(file);
  if (!c.ok) return c;
  const t = fileType(file);
  if (c.kind === 'video') {
    if (file.size > MMS_LIMITS.videoBytes) return { ok: false, refusal: videoTooLarge(file.size) };
    return { ok: true, media: { kind: 'video', contentType: t === 'video/quicktime' ? 'video/quicktime' : 'video/mp4', blob: file, byteSize: file.size } };
  }
  if (t === 'image/gif') {
    if (file.size > MMS_LIMITS.imageBytes) return { ok: false, refusal: gifTooLarge(file.size) };
    return { ok: true, media: { kind: 'photo', contentType: 'image/gif', blob: file, byteSize: file.size } };
  }
  let jpeg: Blob;
  try {
    jpeg = await deps.encodeJpeg(file);
  } catch {
    return { ok: false, refusal: REFUSE_UNREADABLE };
  }
  if (jpeg.size === 0) return { ok: false, refusal: REFUSE_UNREADABLE };
  if (jpeg.size > MMS_LIMITS.imageBytes) return { ok: false, refusal: REFUSE_TOTAL };
  return { ok: true, media: { kind: 'photo', contentType: 'image/jpeg', blob: jpeg, byteSize: jpeg.size } };
}

/** Strict padded base64 (what the upload route accepts), built in chunks so a 5 MB file doesn't overflow the stack. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
