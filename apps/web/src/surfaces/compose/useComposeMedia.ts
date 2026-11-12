// D5a: the photos and videos attached to one compose box, in tray order (the order of mediaIds, i.e. positions).
//
// Each item moves through real states only: Preparing (re-encoding a photo; prepareMedia.ts), Uploading (the POST is
// in flight), Ready (the server staged it), or failed with a sentence. There is no progress percentage: nothing here
// knows one. A file refused before upload never becomes a tile; its refusal is said once (role="alert" in the tray).
//
// - Remove deletes the staged upload (once it exists) and revokes the thumbnail's object URL.
// - The box is remounted when a draft is opened from the feed (ThreadPage keys it by the draft) or the person is left:
//   on unmount every staged upload is deleted, best effort, and every thumbnail URL revoked. StrictMode's mount →
//   unmount → mount in development is not a real unmount: the cleanup waits a tick and does nothing if the box is
//   mounted again.
// - Once a send's response names a message (sent, scheduled, queued or blocked), the uploads belong to it: `sent()`
//   empties the tray WITHOUT deleting them. A refused send leaves them, and MEDIA_UPLOAD_GONE marks the tile it names.
import { MMS_LIMITS } from '@realty/core/texting';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../shell/index.js';
import { deleteMedia, goneSentence, goneUploadId, sendRefusalSentence, uploadMedia } from './mediaApi.js';
import { type MediaDeps, type MediaKind, REFUSE_COUNT, REFUSE_TOTAL, blobToBase64, classifyFile, mediaDeps, prepareMedia } from './prepareMedia.js';

export type TrayState = 'preparing' | 'uploading' | 'ready' | 'failed';

export interface TrayItem {
  key: string;
  kind: MediaKind;
  state: TrayState;
  /** the failure, in words (state failed) */
  error: string | null;
  uploadId: string | null;
  /** bytes as sent (after re-encoding); null while preparing */
  byteSize: number | null;
  /** thumbnail object URL (photos, once prepared) */
  url: string | null;
}

export interface ComposeMedia {
  items: TrayItem[];
  count: number;
  /** bytes of every prepared item */
  totalBytes: number;
  /** refusals of the last pick, before upload */
  refusals: string[];
  /** the latest tile change, for the tray's polite live region */
  announcement: string;
  /** an item is preparing or uploading */
  busy: boolean;
  /** an item failed */
  failed: boolean;
  /** the staged uploads, in tray order */
  ids: string[];
  add(files: Iterable<File>): void;
  remove(key: string): void;
  /** a response named a message: the uploads now belong to it; empty the tray without deleting them */
  sent(): void;
  /** a send was refused: mark the tile MEDIA_UPLOAD_GONE names; true when the refusal was that */
  refused(code: string, details: Record<string, unknown> | null): boolean;
}

/** "Photo 2" / "Video 2": the item's place in the tray. */
export function itemLabel(kind: MediaKind, position: number): string {
  return `${kind === 'photo' ? 'Photo' : 'Video'} ${position}`;
}

/** Why Send waits because of the attached media, or null. */
export function mediaHold(channel: string, media: Pick<ComposeMedia, 'count' | 'busy' | 'failed'>): string | null {
  if (media.count === 0) return null;
  if (channel !== 'sms') return 'Photos and videos go only by text.';
  if (media.failed) return "Remove the photo or video that couldn't be attached, then send.";
  if (media.busy) return 'Send waits until every photo and video is uploaded.';
  return null;
}

/** A refused send, as it concerns the media: marks the tile MEDIA_UPLOAD_GONE names; the words, or null when it is about something else. */
export function mediaRefusal(media: Pick<ComposeMedia, 'refused'>, r: { code: string; details: Record<string, unknown> | null }): string | null {
  media.refused(r.code, r.details);
  return sendRefusalSentence(r.code, r.details);
}

let seq = 0;

export function useComposeMedia(contactId: string, deps: MediaDeps = mediaDeps): ComposeMedia {
  const api = useApi();
  const [items, setItemsState] = useState<TrayItem[]>([]);
  const [refusals, setRefusals] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const itemsRef = useRef<TrayItem[]>([]);
  const mounted = useRef(true);
  const ctx = useRef({ api, contactId, deps });
  ctx.current = { api, contactId, deps };

  const setItems = useCallback((f: (prev: TrayItem[]) => TrayItem[]) => {
    itemsRef.current = f(itemsRef.current);
    setItemsState(itemsRef.current);
  }, []);
  const patch = useCallback((key: string, p: Partial<TrayItem>) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i))), [setItems]);
  const alive = (key: string) => mounted.current && itemsRef.current.some((i) => i.key === key);
  const positionOf = (key: string) => itemsRef.current.findIndex((i) => i.key === key) + 1;

  const process = useCallback(
    async (key: string, kind: MediaKind, file: File) => {
      const { api: client, contactId: cid, deps: d } = ctx.current;
      const r = await prepareMedia(file, d);
      if (!alive(key)) return;
      if (!r.ok) {
        setItems((prev) => prev.filter((i) => i.key !== key));
        setRefusals((prev) => (prev.includes(r.refusal) ? prev : [...prev, r.refusal]));
        return;
      }
      const others = itemsRef.current.reduce((n, i) => (i.key !== key && i.state !== 'failed' ? n + (i.byteSize ?? 0) : n), 0);
      if (others + r.media.byteSize > MMS_LIMITS.totalBytes) {
        setItems((prev) => prev.filter((i) => i.key !== key));
        setRefusals((prev) => (prev.includes(REFUSE_TOTAL) ? prev : [...prev, REFUSE_TOTAL]));
        return;
      }
      patch(key, { state: 'uploading', byteSize: r.media.byteSize, url: r.media.kind === 'photo' ? d.objectUrl(r.media.blob) : null });
      let out: Awaited<ReturnType<typeof uploadMedia>>;
      try {
        const data = await blobToBase64(r.media.blob);
        out = await uploadMedia(client, cid, { contentType: r.media.contentType, data }, kind);
      } catch {
        out = { ok: false, code: 'INTERNAL_ERROR', sentence: 'Something went wrong while uploading it.' };
      }
      if (!alive(key)) {
        // removed (or the box closed) while it was uploading: it must not stay staged
        if (out.ok) void deleteMedia(client, cid, out.upload.id);
        return;
      }
      const label = itemLabel(kind, positionOf(key));
      if (out.ok) {
        patch(key, { state: 'ready', uploadId: out.upload.id, byteSize: out.upload.byteSize });
        setAnnouncement(`${label} ready`);
      } else {
        patch(key, { state: 'failed', error: out.sentence });
        setAnnouncement(`${label} couldn't be uploaded: ${out.sentence}`);
      }
    },
    [patch, setItems],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      const picked = [...files];
      const out: string[] = [];
      const room = MMS_LIMITS.maxItems - itemsRef.current.length;
      if (picked.length > room) out.push(REFUSE_COUNT);
      const fresh: { item: TrayItem; file: File }[] = [];
      for (const file of picked.slice(0, Math.max(0, room))) {
        const c = classifyFile(file);
        if (!c.ok) {
          if (!out.includes(c.refusal)) out.push(c.refusal);
          continue;
        }
        seq += 1;
        fresh.push({ item: { key: `m${seq}`, kind: c.kind, state: 'preparing', error: null, uploadId: null, byteSize: null, url: null }, file });
      }
      setRefusals(out);
      if (fresh.length === 0) return;
      setItems((prev) => [...prev, ...fresh.map((f) => f.item)]);
      for (const f of fresh) void process(f.item.key, f.item.kind, f.file);
    },
    [process, setItems],
  );

  const remove = useCallback(
    (key: string) => {
      const it = itemsRef.current.find((i) => i.key === key);
      if (!it) return;
      const label = itemLabel(it.kind, positionOf(key));
      if (it.uploadId) void deleteMedia(ctx.current.api, ctx.current.contactId, it.uploadId);
      if (it.url) ctx.current.deps.revokeUrl(it.url);
      setItems((prev) => prev.filter((i) => i.key !== key));
      setRefusals([]);
      setAnnouncement(`${label} removed`);
    },
    [setItems],
  );

  const sent = useCallback(() => {
    for (const i of itemsRef.current) if (i.url) ctx.current.deps.revokeUrl(i.url);
    setItems(() => []);
    setRefusals([]);
  }, [setItems]);

  const refused = useCallback(
    (code: string, details: Record<string, unknown> | null) => {
      const id = goneUploadId(code, details);
      if (code !== 'MEDIA_UPLOAD_GONE') return false;
      const it = itemsRef.current.find((i) => i.uploadId !== null && i.uploadId === id);
      if (it) {
        patch(it.key, { state: 'failed', error: goneSentence(it.kind) });
        setAnnouncement(`${itemLabel(it.kind, positionOf(it.key))} couldn't be sent: ${goneSentence(it.kind)}`);
      }
      return true;
    },
    [patch],
  );

  // a real unmount (not StrictMode's rehearsal): delete what is staged, best effort, and revoke the thumbnails
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (mounted.current) return;
        const { api: client, contactId: cid, deps: d } = ctx.current;
        for (const i of itemsRef.current) {
          if (i.uploadId) void deleteMedia(client, cid, i.uploadId);
          if (i.url) d.revokeUrl(i.url);
        }
        itemsRef.current = [];
      }, 0);
    };
  }, []);

  return useMemo(() => {
    const ready = items.filter((i) => i.state === 'ready' && i.uploadId !== null);
    return {
      items,
      count: items.length,
      totalBytes: items.reduce((n, i) => n + (i.state === 'failed' ? 0 : (i.byteSize ?? 0)), 0),
      refusals,
      announcement,
      busy: items.some((i) => i.state === 'preparing' || i.state === 'uploading'),
      failed: items.some((i) => i.state === 'failed'),
      ids: ready.map((i) => i.uploadId!),
      add,
      remove,
      sent,
      refused,
    };
  }, [items, refusals, announcement, add, remove, sent, refused]);
}
