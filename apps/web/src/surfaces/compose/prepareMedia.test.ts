// R-MMS-8: preparing picked files before upload: decimal sizes rounded up, what is a photo or a video, stills
// re-encoded through the (injected) JPEG encoder, GIFs and videos as they are, and the carrier limits.
import { describe, expect, it } from 'vitest';
import { type MediaDeps, REFUSE_TYPE, REFUSE_UNREADABLE, REFUSE_VIDEO_FORMAT, blobToBase64, classifyFile, fileType, formatSize, prepareMedia } from './prepareMedia.js';

const deps = (encode: MediaDeps['encodeJpeg']): MediaDeps => ({ encodeJpeg: encode, objectUrl: () => null, revokeUrl: () => {} });
const file = (name: string, size: number, type: string) => new File([new Uint8Array(size)], name, { type });

describe('R-MMS-8 prepareMedia', () => {
  it('R-MMS-8: sizes are decimal and rounded up to one decimal place', () => {
    expect(formatSize(999)).toBe('999 bytes');
    expect(formatSize(1000)).toBe('1 KB');
    expect(formatSize(500_000)).toBe('500 KB');
    expect(formatSize(500_001)).toBe('500.1 KB');
    expect(formatSize(999_999)).toBe('1 MB');
    expect(formatSize(1_400_000)).toBe('1.4 MB');
    expect(formatSize(8_400_000)).toBe('8.4 MB');
    expect(formatSize(5_000_001)).toBe('5.1 MB');
  });

  it('R-MMS-8: types come from the browser, else the extension (HEIC and MOV often arrive without one)', () => {
    expect(fileType({ type: '', name: 'IMG_1.HEIC' })).toBe('image/heic');
    expect(fileType({ type: '', name: 'clip.mov' })).toBe('video/quicktime');
    expect(classifyFile(file('a.webp', 10, 'image/webp'))).toEqual({ ok: true, kind: 'photo' });
    expect(classifyFile(file('a.webm', 10, 'video/webm'))).toEqual({ ok: false, refusal: REFUSE_VIDEO_FORMAT });
    expect(classifyFile(file('a.pdf', 10, 'application/pdf'))).toEqual({ ok: false, refusal: REFUSE_TYPE });
  });

  it('R-MMS-8: stills go through the JPEG encoder; GIFs and videos go as they are; an undecodable photo and a video over 500 KB are refused', async () => {
    const jpeg = new Blob([new Uint8Array(1234)], { type: 'image/jpeg' });
    const seen: Blob[] = [];
    const d = deps(async (b) => {
      seen.push(b);
      return jpeg;
    });
    const heic = file('IMG.heic', 3_000_000, 'image/heic');
    expect(await prepareMedia(heic, d)).toEqual({ ok: true, media: { kind: 'photo', contentType: 'image/jpeg', blob: jpeg, byteSize: 1234 } });
    expect(seen).toEqual([heic]);
    const gif = file('a.gif', 2000, 'image/gif');
    expect(await prepareMedia(gif, d)).toMatchObject({ ok: true, media: { contentType: 'image/gif', blob: gif } });
    const mp4 = file('a.mp4', 500_000, 'video/mp4');
    expect(await prepareMedia(mp4, d)).toMatchObject({ ok: true, media: { kind: 'video', contentType: 'video/mp4', blob: mp4, byteSize: 500_000 } });
    expect(seen).toHaveLength(1);
    expect(await prepareMedia(file('b.mp4', 8_400_000, 'video/mp4'), d)).toEqual({ ok: false, refusal: 'This video is 8.4 MB. A text can carry a video of at most 500 KB. For a longer video, send a link instead.' });
    const broken = deps(async () => {
      throw new Error('no decoder');
    });
    expect(await prepareMedia(file('a.png', 10, 'image/png'), broken)).toEqual({ ok: false, refusal: REFUSE_UNREADABLE });
  });

  it('R-MMS-8: base64 is strict and padded', async () => {
    expect(await blobToBase64(new Blob([Uint8Array.of(1)]))).toBe('AQ==');
    expect(await blobToBase64(new Blob([Uint8Array.of(1, 2, 3)]))).toBe('AQID');
  });
});
