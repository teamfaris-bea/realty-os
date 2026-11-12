// Inbound MMS media (stored encrypted, linked to the message, shown in the thread with a safe download).
//
//   webhook   the SMS webhook lists the media SIDs (from MediaUrl{n}: only the ME… SID is kept; the URL itself
//             is never fetched, so the body cannot point us anywhere) and enqueues comms.media_copy.
//   copy      per item, idempotent by (message, position): at most MAX_MEDIA_ITEMS; the declared type must
//             be allowed; the provider fetch (tenant subaccount) must be ≤ MAX_MEDIA_BYTES; the bytes must
//             BE the allowed type (magic bytes; the declared and served types are never trusted); then
//             per-object-DEK encryption into storage (purpose mms), stored_objects + message_media, and the
//             provider copy is deleted. Anything refused is a message_media_skipped row with its reason,
//             so the thread says honestly that an attachment was not saved, and why.
//   read      GET /contacts/:id/attachments lists what the caller may see (RLS: whoever sees the message);
//             GET /messages/:id/media/:position streams one item with nosniff, a sandboxing CSP, no-store,
//             and Content-Disposition attachment (inline only for raster images the browser shows as
//             <img>). SVG, HTML, scripts and archives are never accepted, so never served.
import type { ContactId, SystemActor, TenantId, UserActor } from '@realty/core/foundation';
import { type Tx, lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { getObject, putObject } from '../crypto/objects.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../providers/types.js';
import { TELEPHONY_LIVE_OFF } from '../providers/twilio/http.js';
import { telephonyAccount } from './repos/credentials.js';
import { asUser } from './runtime.js';
import type { CommsDeps } from './types.js';

export const MAX_MEDIA_ITEMS = 10;
/** Twilio accepts up to 5 MB per MMS; nothing larger is kept. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_COPY_JOB = { kind: 'comms.media_copy', queue: 'default' as const, dedupeKey: (messageId: string) => `comms.media_copy:${messageId}` };

export type SkipReason = 'TYPE_NOT_ALLOWED' | 'TOO_LARGE' | 'TOO_MANY' | 'CONTENT_MISMATCH' | 'FETCH_FAILED';

/** Allowed types → how to recognise their bytes and whether a browser may show them inline. */
const ALLOWED: Record<string, { sniff: (b: Uint8Array) => boolean; inline: boolean; ext: string }> = {
  'image/jpeg': { sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, inline: true, ext: 'jpg' },
  'image/png': { sniff: (b) => hex(b, 0, 8) === '89504e470d0a1a0a', inline: true, ext: 'png' },
  'image/gif': { sniff: (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a', inline: true, ext: 'gif' },
  'image/webp': { sniff: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP', inline: true, ext: 'webp' },
  'image/heic': { sniff: (b) => ftyp(b, ['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis']), inline: false, ext: 'heic' },
  'image/heif': { sniff: (b) => ftyp(b, ['mif1', 'msf1', 'heic', 'heix']), inline: false, ext: 'heif' },
  'video/mp4': { sniff: (b) => ftyp(b, null), inline: false, ext: 'mp4' },
  'video/3gpp': { sniff: (b) => ftyp(b, ['3gp4', '3gp5', '3gp6', '3ge6', '3gg6', '3gs6', 'isom', 'mp42']), inline: false, ext: '3gp' },
  'video/quicktime': { sniff: (b) => ftyp(b, ['qt  ']) || ascii(b, 4, 4) === 'moov' || ascii(b, 4, 4) === 'mdat', inline: false, ext: 'mov' },
  'audio/amr': { sniff: (b) => ascii(b, 0, 6) === '#!AMR\n', inline: false, ext: 'amr' },
  'audio/mpeg': { sniff: (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0), inline: false, ext: 'mp3' },
  'audio/mp4': { sniff: (b) => ftyp(b, null), inline: false, ext: 'm4a' },
  'application/pdf': { sniff: (b) => ascii(b, 0, 5) === '%PDF-', inline: false, ext: 'pdf' },
  'text/vcard': { sniff: (b) => /^\s*BEGIN:VCARD/i.test(ascii(b, 0, 64)), inline: false, ext: 'vcf' },
};
/** Vendor aliases of an allowed type. */
const ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'text/x-vcard': 'text/vcard', 'text/directory': 'text/vcard', 'audio/mp3': 'audio/mpeg', 'video/3gpp2': 'video/3gpp' };

function hex(b: Uint8Array, at: number, n: number): string {
  return Buffer.from(b.subarray(at, at + n)).toString('hex');
}
function ascii(b: Uint8Array, at: number, n: number): string {
  return Buffer.from(b.subarray(at, at + n)).toString('latin1');
}
/** ISO base media (mp4, mov, heic, 3gp): "ftyp" at offset 4, with one of `brands` (null: any). */
function ftyp(b: Uint8Array, brands: string[] | null): boolean {
  if (ascii(b, 4, 4) !== 'ftyp') return false;
  return brands === null || brands.includes(ascii(b, 8, 4));
}

/** The canonical allowed type for a declared one, or null when the type is not allowed. */
export function allowedType(declared: string | null | undefined): string | null {
  const t = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  const c = ALIASES[t] ?? t;
  return c in ALLOWED ? c : null;
}

/** Decides one fetched item: the stored type, or why it is refused. Pure. */
export function checkMedia(declared: string | null, bytes: Uint8Array): { ok: true; contentType: string } | { ok: false; reason: SkipReason } {
  const t = allowedType(declared);
  if (!t) return { ok: false, reason: 'TYPE_NOT_ALLOWED' };
  if (bytes.byteLength > MAX_MEDIA_BYTES) return { ok: false, reason: 'TOO_LARGE' };
  if (bytes.byteLength === 0 || !ALLOWED[t]!.sniff(bytes)) return { ok: false, reason: 'CONTENT_MISMATCH' };
  return { ok: true, contentType: t };
}

export function mediaPresentation(contentType: string): { inline: boolean; ext: string } {
  const a = ALLOWED[contentType];
  return a ? { inline: a.inline, ext: a.ext } : { inline: false, ext: 'bin' };
}

export interface MediaItem {
  position: number;
  /** the provider media SID (Twilio ME…), or null when the webhook URL did not name one */
  ref: string | null;
  declaredType: string | null;
}

const ME_SID = /\/Messages\/(?:SM|MM)[0-9a-f]{32}\/Media\/(ME[0-9a-f]{32})(?:\.json)?$/;

/** The media items of an inbound SMS/MMS webhook (Twilio form fields NumMedia, MediaUrl{n}, MediaContentType{n}). */
export function mediaItemsOf(form: Record<string, string>): MediaItem[] {
  const n = Math.min(Math.max(Number.parseInt(form.NumMedia ?? '0', 10) || 0, 0), 100);
  const out: MediaItem[] = [];
  for (let i = 0; i < n; i++) {
    let ref: string | null;
    try {
      ref = ME_SID.exec(new URL(form[`MediaUrl${i}`] ?? '').pathname)?.[1] ?? null;
    } catch {
      ref = null;
    }
    out.push({ position: i, ref, declaredType: (form[`MediaContentType${i}`] ?? '').slice(0, 100) || null });
  }
  return out;
}

// ---- copy job ----------------------------------------------------------------------------------------

async function skip(tx: Tx, messageId: string, position: number, reason: SkipReason, declared: string | null): Promise<void> {
  await sql`
    INSERT INTO message_media_skipped (tenant_id, message_id, position, reason, declared_type)
    VALUES (app.tenant_id(), ${messageId}, ${position}, ${reason}, ${declared})
    ON CONFLICT DO NOTHING`.execute(tx);
}

async function doneAt(tx: Tx, messageId: string): Promise<Set<number>> {
  const r = await sql<{ position: number }>`
    SELECT position FROM message_media WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND position IS NOT NULL
    UNION SELECT position FROM message_media_skipped WHERE tenant_id = app.tenant_id() AND message_id = ${messageId}`.execute(tx);
  return new Set(r.rows.map((x) => x.position));
}

/**
 * comms.media_copy: copies an inbound MMS's media into encrypted storage. Re-runnable: positions already
 * stored or skipped are left alone. A transient provider failure throws (the job retries); a refused
 * fetch is FETCH_FAILED.
 */
export async function copyInboundMedia(actor: SystemActor, messageId: string, items: MediaItem[], deps: CommsDeps): Promise<{ stored: number; skipped: number }> {
  const tenantId = actor.tenantId as TenantId;
  const pre = await withTenantTx(actor, async (tx) => {
    const m = await sql<{ provider_message_ref: string | null; contact_id: string }>`
      SELECT provider_message_ref, contact_id FROM messages WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND direction = 'inbound'`.execute(tx);
    if (!m.rows[0]) return null;
    return { messageRef: m.rows[0].provider_message_ref, contactId: m.rows[0].contact_id, done: await doneAt(tx, messageId) };
  }, { db: deps.db });
  if (!pre) return { stored: 0, skipped: 0 };
  const account = await withTenantTx(actor, (tx) => telephonyAccount(tx, deps.envelope, tenantId), { db: deps.db });
  let stored = 0;
  let skipped = 0;
  for (const it of items.slice(0, 100)) {
    if (pre.done.has(it.position)) continue;
    const decide = async (): Promise<{ reason: SkipReason } | { bytes: Uint8Array; contentType: string }> => {
      if (it.position >= MAX_MEDIA_ITEMS) return { reason: 'TOO_MANY' };
      if (!allowedType(it.declaredType)) return { reason: 'TYPE_NOT_ALLOWED' };
      if (!it.ref || !pre.messageRef || !account) return { reason: 'FETCH_FAILED' };
      let got: { bytes: Uint8Array; contentType: string };
      try {
        got = await deps.providers.telephony.fetchMedia(account, { messageRef: pre.messageRef, mediaRef: it.ref });
      } catch (e) {
        // R-TWL-1: the kill switch refused the fetch: a refused part, never a job retry loop
        if (e instanceof ProviderError && (e.kind === 'rejected' || e.providerCode === TELEPHONY_LIVE_OFF)) return { reason: 'FETCH_FAILED' };
        throw e; // unavailable / timeout: retried by the job
      }
      // the declared type must be allowed, and the bytes must be that type (the served type is not trusted)
      const c = checkMedia(it.declaredType, got.bytes);
      return c.ok ? { bytes: got.bytes, contentType: c.contentType } : { reason: c.reason };
    };
    const d = await decide();
    await withTenantTx(actor, async (tx) => {
      await lockContact(tx, pre.contactId as ContactId);
      if ((await doneAt(tx, messageId)).has(it.position)) return;
      if ('reason' in d) {
        await skip(tx, messageId, it.position, d.reason, it.declaredType);
        skipped++;
        return;
      }
      const objectId = deps.ids.next<'StoredObjectId'>();
      const sealed = await putObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, objectId, 'mms', d.bytes, d.contentType);
      await sql`
        INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version)
        VALUES (app.tenant_id(), ${objectId}, 'mms', ${sealed.storageKey}, ${d.contentType}, ${sealed.byteSize}, ${Buffer.from(sealed.sha256)},
                ${Buffer.from(sealed.dekWrapped)}, ${sealed.keyVersion})`.execute(tx);
      await sql`
        INSERT INTO message_media (tenant_id, message_id, object_id, position, provider_media_ref)
        VALUES (app.tenant_id(), ${messageId}, ${objectId}, ${it.position}, ${it.ref})`.execute(tx);
      stored++;
    }, { db: deps.db, retries: 2 });
    // the provider keeps no copy of what we stored or refused (best effort; a failure is not retried)
    if (it.ref && pre.messageRef && account && deps.providers.telephony.deleteMedia) {
      await deps.providers.telephony.deleteMedia(account, { messageRef: pre.messageRef, mediaRef: it.ref }).catch(() => undefined);
    }
  }
  return { stored, skipped };
}

// ---- read ----------------------------------------------------------------------------------------------

export interface AttachmentView {
  messageId: string;
  media: { position: number; contentType: string; byteSize: number; inline: boolean; url: string }[];
  skipped: { position: number; reason: SkipReason }[];
  /** R-TWL-11: text/plain parts (comms/mmsTextJob.ts): read ⇒ the text (plain, never HTML); pending ⇒ null */
  textParts: { position: number; status: 'read' | 'pending'; text: string | null }[];
}

export interface VoicemailView {
  callId: string;
  recordingId: string;
  durationS: number | null;
  transcriptReady: boolean;
}

/** Everything attached to a contact's thread that the caller may see (RLS decides; recordings: R-PERM-8 scope). */
export async function contactAttachments(actor: UserActor, contactId: string, deps: CommsDeps): Promise<{ messages: AttachmentView[]; voicemails: VoicemailView[] }> {
  return asUser(deps, actor, async (tx) => {
    const media = await sql<{ message_id: string; position: number; content_type: string; byte_size: string }>`
      SELECT mm.message_id, mm.position, o.content_type, o.byte_size
        FROM message_media mm JOIN messages m ON m.tenant_id = mm.tenant_id AND m.id = mm.message_id
        JOIN stored_objects o ON o.tenant_id = mm.tenant_id AND o.id = mm.object_id
       WHERE mm.tenant_id = app.tenant_id() AND m.contact_id = ${contactId} AND mm.position IS NOT NULL AND o.deleted_at IS NULL
       ORDER BY mm.message_id, mm.position LIMIT 500`.execute(tx);
    const skipped = await sql<{ message_id: string; position: number; reason: SkipReason }>`
      SELECT s.message_id, s.position, s.reason FROM message_media_skipped s JOIN messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
       WHERE s.tenant_id = app.tenant_id() AND m.contact_id = ${contactId} ORDER BY s.message_id, s.position LIMIT 500`.execute(tx);
    // R-TWL-11: text parts, visible exactly when the message is (text_parts_select); a skipped one is reported in `skipped`
    const parts = await sql<{ message_id: string; position: number; status: 'read' | 'pending'; body: string | null }>`
      SELECT t.message_id, t.position, t.status, t.body FROM message_text_parts t JOIN messages m ON m.tenant_id = t.tenant_id AND m.id = t.message_id
       WHERE t.tenant_id = app.tenant_id() AND m.contact_id = ${contactId}
         AND NOT EXISTS (SELECT 1 FROM message_media_skipped s WHERE s.tenant_id = t.tenant_id AND s.message_id = t.message_id AND s.position = t.position)
       ORDER BY t.message_id, t.position LIMIT 500`.execute(tx);
    const byMessage = new Map<string, AttachmentView>();
    const view = (id: string) => byMessage.get(id) ?? (byMessage.set(id, { messageId: id, media: [], skipped: [], textParts: [] }), byMessage.get(id)!);
    for (const x of media.rows) view(x.message_id).media.push({ position: x.position, contentType: x.content_type, byteSize: Number(x.byte_size), inline: mediaPresentation(x.content_type).inline, url: `/api/messages/${x.message_id}/media/${x.position}` });
    for (const x of skipped.rows) view(x.message_id).skipped.push({ position: x.position, reason: x.reason });
    for (const x of parts.rows) view(x.message_id).textParts.push({ position: x.position, status: x.status, text: x.status === 'read' ? x.body : null });
    const vm = await sql<{ call_id: string; recording_id: string; duration_s: number | null; ready: boolean }>`
      SELECT c.id AS call_id, r.id AS recording_id, r.duration_s,
             EXISTS (SELECT 1 FROM transcripts t WHERE t.tenant_id = r.tenant_id AND t.recording_id = r.id AND t.status = 'ready') AS ready
        FROM calls c JOIN recordings r ON r.tenant_id = c.tenant_id AND r.call_id = c.id
       WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ${contactId} AND c.direction = 'inbound' AND c.handled_by = 'voicemail'
         AND r.status = 'stored' ORDER BY c.started_at DESC LIMIT 100`.execute(tx);
    return {
      messages: [...byMessage.values()],
      voicemails: vm.rows.map((v) => ({ callId: v.call_id, recordingId: v.recording_id, durationS: v.duration_s, transcriptReady: v.ready })),
    };
  });
}

/** The contact of a visible message (facts for authorize), or null (404). */
export async function messageContact(tx: Tx, messageId: string): Promise<string | null> {
  const r = await sql<{ contact_id: string }>`SELECT contact_id FROM messages WHERE tenant_id = app.tenant_id() AND id = ${messageId}`.execute(tx);
  return r.rows[0]?.contact_id ?? null;
}

/** One stored media item, decrypted, for the download route. 404 when the caller cannot see the message. */
export async function readMedia(actor: UserActor, messageId: string, position: number, deps: CommsDeps): Promise<{ bytes: Uint8Array; contentType: string; filename: string; inline: boolean }> {
  return asUser(deps, actor, async (tx) => {
    const r = await sql<{ object_id: string; storage_key: string; dek_wrapped: Buffer | null; content_type: string }>`
      SELECT o.id AS object_id, o.storage_key, o.dek_wrapped, o.content_type
        FROM message_media mm JOIN messages m ON m.tenant_id = mm.tenant_id AND m.id = mm.message_id
        JOIN stored_objects o ON o.tenant_id = mm.tenant_id AND o.id = mm.object_id
       WHERE mm.tenant_id = app.tenant_id() AND mm.message_id = ${messageId} AND mm.position = ${position}`.execute(tx);
    const x = r.rows[0];
    if (!x || !x.dek_wrapped) throw new AppError('NOT_FOUND');
    const tenantId = actor.tenantId as TenantId;
    const bytes = await getObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, x.object_id, x.storage_key, new Uint8Array(x.dek_wrapped));
    if (!bytes) throw new AppError('NOT_FOUND');
    const p = mediaPresentation(x.content_type);
    return { bytes, contentType: x.content_type, filename: `attachment-${position + 1}.${p.ext}`, inline: p.inline };
  });
}
