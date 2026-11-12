// Outbound photo and video texts, one-to-one human sends only (owner decision D5a; DATA_MODEL R-MMS-1..9, E290-E299;
// ARCHITECTURE §21.20). Reuses inbound MMS storage (purpose 'mms', per-object DEK, media.ts checkMedia) and the one
// send path (dispatch.ts): nothing here sends.
//
//   upload    POST /contacts/:id/outbound-media (comms.send): decode → checkMedia (the declared type must BE the bytes)
//             → core checkOutboundMedia (allowlist, video brands, per-kind size) → core stripMediaMetadata (location and
//             other metadata removed, fail closed) → size again → as the user: the person seen in detail, not merged
//             away, at most 20 live uploads per uploader, encrypted object + outbound_media_uploads row (24 h, DB clock).
//             60 uploads per hour per user (DB-backed limit). The file name is never sent, stored or logged.
//   remove    DELETE /contacts/:id/outbound-media/:uploadId: the uploader's own; the shred trigger shreds the object.
//   attach    compose.ts → attachUploadsInTx, in the compose transaction as the user: read under RLS, INSERT
//             message_media (app.message_media_outbound_guard re-checks), then claim the upload by DELETE … RETURNING.
//             A second send naming the same upload waits on that row and then finds nothing (MEDIA_UPLOAD_GONE).
//   send      dispatch.ts → mediaUrlsFor: one signed URL per item (minted only for an allowed send, after TX1).
//   fetch     GET /api/mms/media?token= (public, global limiter off): the provider fetches each item. One 404 for
//             every refusal; the token is never logged, stored in a job, an audit row or a response.
//   cleanup   comms.outbound_media_purge (every 15 min, per tenant): expired uploads deleted ⇒ shredded ⇒ blob_delete.
//             comms.mms_provider_cleanup (24 h after dispatch): the provider's stored copies deleted (R-MMS-7, E298).
import { MMS_LIMITS, type OutboundMediaType, SMS_TEXT_MAX_UNITS, checkOutboundMedia, stripMediaMetadata } from '@realty/core/texting';
import { HOUR_MS, MINUTE_MS, type TenantId, type UserActor } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { enforceLimits } from '../auth/rateLimit.js';
import { getObject, putObject } from '../crypto/objects.js';
import { AppError } from '../errors.js';
import { jobPayload, zId, zInstant } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import type { Providers } from '../providers/index.js';
import { checkMedia, mediaPresentation } from './media.js';
import { refuseMergedAway } from './merged.js';
import { type RenderIdentity, renderHumanBody } from './render.js';
import { detailVisibleContact } from './repos/contacts.js';
import { telephonyAccount } from './repos/credentials.js';
import { asSystem, asUser, linkMac } from './runtime.js';
import type { CommsDeps } from './types.js';

export const MAX_LIVE_UPLOADS = 20;
export const UPLOADS_PER_HOUR = 60;
export const FETCHES_PER_ITEM_PER_HOUR = 12;
/** Twilio's maximum and default ValidityPeriod (36,000 s) plus the dispatching lease (20 min, R-GATE-8). */
export const MEDIA_URL_LIFETIME_S = 36_000 + 20 * 60;
export const MEDIA_TOKEN_PURPOSE = 'mms-media';

export interface UploadView {
  id: string;
  contentType: OutboundMediaType;
  byteSize: number;
  expiresAt: string;
}

const isVideo = (t: string) => t.startsWith('video/');
const itemLimit = (t: string) => (isVideo(t) ? MMS_LIMITS.videoBytes : MMS_LIMITS.imageBytes);
const tooLarge = (limitBytes: number, scope: 'item' | 'total') => new AppError('MEDIA_TOO_LARGE', { limitBytes, scope });

// ---- upload / remove ------------------------------------------------------------------------------------

/** The upload pipeline's pure half: the bytes as they will be stored, or the refusal (E293, E294, E295). */
export function prepareUpload(contentType: string, bytes: Uint8Array): Uint8Array {
  const c = checkMedia(contentType, bytes);
  if (!c.ok) {
    if (c.reason === 'TOO_LARGE') throw tooLarge(itemLimit(contentType), 'item');
    throw new AppError('MEDIA_NOT_ALLOWED');
  }
  if (c.contentType !== contentType) throw new AppError('MEDIA_NOT_ALLOWED');
  const o = checkOutboundMedia(contentType, bytes);
  if (!o.ok) {
    if (o.reason === 'TOO_LARGE') throw tooLarge(o.limitBytes ?? itemLimit(contentType), 'item');
    throw new AppError('MEDIA_NOT_ALLOWED');
  }
  const s = stripMediaMetadata(contentType, bytes);
  if (!s.ok) throw new AppError(s.reason === 'LOCATION_REMAINS' ? 'MEDIA_LOCATION_NOT_REMOVED' : 'MEDIA_NOT_ALLOWED');
  // the minimal orientation Exif the strip inserts can add a few bytes
  if (s.bytes.byteLength > itemLimit(contentType)) throw tooLarge(itemLimit(contentType), 'item');
  return s.bytes;
}

export async function uploadOutboundMedia(actor: UserActor, contactId: string, body: { contentType: OutboundMediaType; data: string }, deps: CommsDeps): Promise<UploadView> {
  // counted on every attempt, before any work (R-MMS-3)
  await enforceLimits(deps.db, deps.linkSecret, [{ kind: 'mms_upload_user', parts: [actor.tenantId, actor.userId], max: UPLOADS_PER_HOUR, windowSeconds: 3600 }]);
  const bytes = prepareUpload(body.contentType, new Uint8Array(Buffer.from(body.data, 'base64')));
  return asUser(deps, actor, async (tx) => {
    const c = await detailVisibleContact(tx, contactId);
    if (!c) throw new AppError('NOT_FOUND');
    await refuseMergedAway(tx, c);
    const live = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbound_media_uploads
       WHERE tenant_id = app.tenant_id() AND uploaded_by_user_id = ${actor.userId} AND expires_at > now()`.execute(tx);
    if (Number(live.rows[0]?.n ?? 0) >= MAX_LIVE_UPLOADS) throw new AppError('MEDIA_UPLOAD_LIMIT');
    const tenantId = actor.tenantId as TenantId;
    const objectId = deps.ids.next<'StoredObjectId'>();
    const uploadId = deps.ids.next<'OutboundMediaUploadId'>();
    const sealed = await putObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, objectId, 'mms', bytes, body.contentType);
    await sql`
      INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, created_by_user_id)
      VALUES (app.tenant_id(), ${objectId}, 'mms', ${sealed.storageKey}, ${body.contentType}, ${sealed.byteSize}, ${Buffer.from(sealed.sha256)},
              ${Buffer.from(sealed.dekWrapped)}, ${sealed.keyVersion}, ${actor.userId})`.execute(tx);
    const r = await sql<{ expires_at: Date }>`
      INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, expires_at)
      VALUES (app.tenant_id(), ${uploadId}, ${contactId}, ${actor.userId}, ${objectId}, ${body.contentType}, ${sealed.byteSize}, now())
      RETURNING expires_at`.execute(tx);
    return { id: uploadId, contentType: body.contentType, byteSize: sealed.byteSize, expiresAt: r.rows[0]!.expires_at.toISOString() };
  });
}

/** The uploader removes their own upload of that person (204); anything else is 404. The trigger shreds the object. */
export async function deleteOutboundMedia(actor: UserActor, contactId: string, uploadId: string, deps: CommsDeps): Promise<void> {
  await asUser(deps, actor, async (tx) => {
    const r = await sql<{ id: string }>`
      DELETE FROM outbound_media_uploads WHERE tenant_id = app.tenant_id() AND id = ${uploadId} AND contact_id = ${contactId}
       AND uploaded_by_user_id = ${actor.userId} RETURNING id`.execute(tx);
    if (!r.rows[0]) throw new AppError('NOT_FOUND');
  });
}

// ---- compose: the media rules and the attach -------------------------------------------------------------

export interface MediaComposeInput {
  channel: 'sms' | 'email' | 'web_chat';
  body: string;
  mediaIds?: readonly string[] | undefined;
  bulkActionId?: string | undefined;
  purposeOverride?: 'marketing' | undefined;
}

/**
 * Every media rule compose.ts applies before it creates anything, so HTTP and direct callers get the same
 * VALIDATION_FAILED issue codes (R-MMS-1, E292).
 */
export function mediaInputIssues(input: MediaComposeInput): { path: string; code: string }[] {
  const ids = input.mediaIds ?? [];
  const issues: { path: string; code: string }[] = [];
  if (ids.length > 0) {
    if (new Set(ids.map((x) => x.toLowerCase())).size !== ids.length) issues.push({ path: '/mediaIds', code: 'media_duplicate' });
    if (input.channel !== 'sms') issues.push({ path: '/mediaIds', code: 'media_text_only' });
    if (input.bulkActionId !== undefined || input.purposeOverride !== undefined) issues.push({ path: '/mediaIds', code: 'media_one_to_one_only' });
    if (ids.length > MMS_LIMITS.maxItems) issues.push({ path: '/mediaIds', code: 'media_too_many' });
  } else if (input.body.trim() === '') issues.push({ path: '/body', code: 'body_required' });
  return issues;
}

/** R-MMS-9: a one-to-one text whose rendered body is over 1,600 UTF-16 units is refused (bulk is unchanged). */
export function textTooLong(input: Pick<MediaComposeInput, 'channel' | 'bulkActionId'>, renderedBody: string): boolean {
  return input.channel === 'sms' && input.bulkActionId === undefined && renderedBody.length > SMS_TEXT_MAX_UNITS;
}

/** The staged uploads' total size under RLS (the sender's own, this person, unexpired); a missing one is GONE. */
export async function uploadsTotalBytes(tx: Tx, contactId: string, ids: readonly string[]): Promise<number> {
  const r = await sql<{ id: string; byte_size: string }>`
    SELECT id, byte_size FROM outbound_media_uploads
     WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[]) AND contact_id = ${contactId} AND expires_at > now()`.execute(tx);
  const found = new Map(r.rows.map((x) => [x.id, Number(x.byte_size)]));
  let total = 0;
  for (const id of ids) {
    const b = found.get(id.toLowerCase());
    if (b === undefined) throw new AppError('MEDIA_UPLOAD_GONE', { uploadId: id });
    total += b;
  }
  return total;
}

function guardRefusal(e: unknown, uploadId: string): AppError | null {
  const err = e as { code?: string; message?: string };
  if (err?.code !== '23514' || !String(err.message ?? '').startsWith('MMS_')) return null;
  if (String(err.message).startsWith('MMS_TOO_LARGE')) return tooLarge(MMS_LIMITS.totalBytes, 'total');
  return new AppError('MEDIA_UPLOAD_GONE', { uploadId });
}

/**
 * Right after insertOutbound, in the same transaction as the user (R-MMS-2): each upload, in order, becomes the item
 * at position i and is claimed by DELETE … RETURNING. No row back, or a guard refusal, rolls the whole send back.
 */
export async function attachUploadsInTx(tx: Tx, o: { messageId: string; contactId: string; mediaIds: readonly string[] }): Promise<void> {
  for (const [i, uploadId] of o.mediaIds.entries()) {
    const u = await sql<{ object_id: string }>`
      SELECT object_id FROM outbound_media_uploads
       WHERE tenant_id = app.tenant_id() AND id = ${uploadId} AND contact_id = ${o.contactId} AND expires_at > now()`.execute(tx);
    const objectId = u.rows[0]?.object_id;
    if (!objectId) throw new AppError('MEDIA_UPLOAD_GONE', { uploadId });
    try {
      await sql`
        INSERT INTO message_media (tenant_id, message_id, object_id, position)
        VALUES (app.tenant_id(), ${o.messageId}, ${objectId}, ${i})`.execute(tx);
    } catch (e) {
      throw guardRefusal(e, uploadId) ?? e;
    }
    const claimed = await sql<{ object_id: string }>`
      DELETE FROM public.outbound_media_uploads WHERE tenant_id = app.tenant_id() AND id = ${uploadId} AND contact_id = ${o.contactId}
         AND expires_at > now() RETURNING object_id`.execute(tx);
    if (!claimed.rows[0]) throw new AppError('MEDIA_UPLOAD_GONE', { uploadId });
  }
}

/**
 * A photo-only text (E297): its body is what the send adds to no words for its purpose ('' or the brokerage line
 * alone), so a reassigned one leaves no words to offer the new owner.
 */
export function isPhotoOnlyBody(body: string, purpose: 'marketing' | 'informational', identity: RenderIdentity): boolean {
  return body === renderHumanBody('', { channel: 'sms', purpose, identity, unsubscribe: null });
}

// ---- dispatch: the media URLs (minted only for an allowed send) ------------------------------------------

const uuidBytes = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');
const uuidOf = (b: Buffer) => {
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
const macInput = (t: { tenantId: string; messageId: string; position: number; expiry: number }) =>
  `${t.tenantId.toLowerCase()}.${t.messageId.toLowerCase()}.${t.position}.${t.expiry}`;

/** base64url(tenant ‖ message ‖ position (1 byte) ‖ expiry (unix s, 8 bytes BE)) "." linkMac — 55 + 1 + 32 characters. */
export function mediaToken(secret: Uint8Array, t: { tenantId: string; messageId: string; position: number; expiry: number }): string {
  const exp = Buffer.alloc(8);
  exp.writeBigUInt64BE(BigInt(t.expiry));
  const body = Buffer.concat([uuidBytes(t.tenantId), uuidBytes(t.messageId), Buffer.from([t.position]), exp]).toString('base64url');
  return `${body}.${linkMac(secret, MEDIA_TOKEN_PURPOSE, macInput(t))}`;
}

const TOKEN_RE = /^([A-Za-z0-9_-]{55})\.([A-Za-z0-9_-]{32})$/;

/** The token's claims when its MAC holds (constant-time compare), else null. Expiry is checked by the DB clock. */
export function verifyMediaToken(secret: Uint8Array, token: string): { tenantId: string; messageId: string; position: number; expiry: number } | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const raw = Buffer.from(m[1]!, 'base64url');
  if (raw.length !== 41) return null;
  const claims = { tenantId: uuidOf(raw.subarray(0, 16)), messageId: uuidOf(raw.subarray(16, 32)), position: raw[32]!, expiry: Number(raw.readBigUInt64BE(33)) };
  const expected = linkMac(secret, MEDIA_TOKEN_PURPOSE, macInput(claims));
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0 ? claims : null;
}

/**
 * The provider URLs of an allowed photo text, in position order (R-MMS-5, R-MMS-6), or null when its media are gone
 * (none, or an object shredded / without its DEK): the send then fails as MEDIA_UNAVAILABLE and no URL is minted.
 */
export async function mediaUrlsFor(deps: CommsDeps, tenantId: string, m: { id: string; dispatchedAt: number | null }): Promise<string[] | null> {
  const rows = await asSystem(deps, tenantId, 'worker', async (tx) =>
    (await sql<{ position: number; content_type: string; ok: boolean }>`
      SELECT mm.position, o.content_type, (o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL) AS ok
        FROM message_media mm JOIN stored_objects o ON o.tenant_id = mm.tenant_id AND o.id = mm.object_id
       WHERE mm.tenant_id = app.tenant_id() AND mm.message_id = ${m.id} ORDER BY mm.position`.execute(tx)).rows,
  );
  if (rows.length === 0 || rows.some((r) => !r.ok || r.position === null) || m.dispatchedAt === null) return null;
  const expiry = Math.floor(m.dispatchedAt / 1000) + MEDIA_URL_LIFETIME_S;
  return rows.map((r) => new URL(`/api/mms/media?token=${mediaToken(deps.linkSecret, { tenantId, messageId: m.id, position: r.position, expiry })}`, deps.publicBaseUrl).toString());
}

// ---- the provider fetch route (GET /api/mms/media?token=) --------------------------------------------------

/** The one refusal of the fetch route: the same status, code and headers every time (E296). */
const refused = () => new AppError('NOT_FOUND');

/** The token of a query with exactly one key, `token`, holding one string; anything else is null. */
export function tokenOfQuery(query: unknown): string | null {
  if (query === null || typeof query !== 'object') return null;
  const keys = Object.keys(query);
  if (keys.length !== 1 || keys[0] !== 'token') return null;
  const t = (query as Record<string, unknown>).token;
  return typeof t === 'string' ? t : null;
}

export async function serveProviderMedia(query: unknown, deps: CommsDeps): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  const token = tokenOfQuery(query);
  const claims = token === null ? null : verifyMediaToken(deps.linkSecret, token);
  if (!claims) throw refused();
  try {
    await enforceLimits(deps.db, deps.linkSecret, [{ kind: 'mms_fetch_item', parts: [claims.tenantId, claims.messageId, String(claims.position)], max: FETCHES_PER_ITEM_PER_HOUR, windowSeconds: 3600 }]);
  } catch {
    throw refused();
  }
  let out: { bytes: Uint8Array; contentType: string } | null;
  try {
    out = await asSystem(deps, claims.tenantId, 'provider', async (tx) => {
      const r = await sql<{ object_id: string; storage_key: string; dek_wrapped: Buffer | null; content_type: string }>`
        SELECT o.id AS object_id, o.storage_key, o.dek_wrapped, o.content_type
          FROM messages m JOIN message_media mm ON mm.tenant_id = m.tenant_id AND mm.message_id = m.id
          JOIN stored_objects o ON o.tenant_id = mm.tenant_id AND o.id = mm.object_id
         WHERE m.tenant_id = app.tenant_id() AND m.id = ${claims.messageId} AND mm.position = ${claims.position}
           AND m.direction = 'outbound' AND m.channel = 'mms' AND NOT m.imported AND m.status IN ('dispatching','dispatch_unknown','sent')
           AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL
           AND now() < to_timestamp(${claims.expiry})`.execute(tx);
      const x = r.rows[0];
      if (!x || !x.dek_wrapped) return null;
      const tenantId = claims.tenantId as TenantId;
      const bytes = await getObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, x.object_id, x.storage_key, new Uint8Array(x.dek_wrapped));
      return bytes ? { bytes, contentType: x.content_type } : null;
    });
  } catch {
    out = null;
  }
  if (!out) throw refused();
  return { ...out, filename: `media-${claims.position + 1}.${mediaPresentation(out.contentType).ext}` };
}

// ---- jobs ----------------------------------------------------------------------------------------------

export const OUTBOUND_MEDIA_PURGE = { kind: 'comms.outbound_media_purge' as const, queue: 'maintenance' as const };
export const MMS_PROVIDER_CLEANUP = { kind: 'comms.mms_provider_cleanup' as const, queue: 'default' as const, dedupeKey: (messageId: string) => `comms.mms_provider_cleanup:${messageId}` };

/** Ids and instants only (R-TEN-7): the provider's message SID, or the sending number's id and the dispatch instant. */
export const MmsProviderCleanupPayload = jobPayload({
  messageId: zId,
  providerRef: z.string().regex(/^MM[0-9a-f]{32}$/).optional(),
  phoneNumberId: zId.optional(),
  dispatchedAt: zInstant.optional(),
});
export type MmsProviderCleanupPayload = z.infer<typeof MmsProviderCleanupPayload>;

/** Enqueued by dispatch.ts when an mms is sent (or found, or unresolved): runs 24 h after dispatch (R-MMS-7). */
export async function enqueueProviderCleanup(tx: Tx, p: MmsProviderCleanupPayload, dispatchedAt: number): Promise<void> {
  await enqueueJob(tx, { queue: MMS_PROVIDER_CLEANUP.queue, kind: MMS_PROVIDER_CLEANUP.kind, payload: p, dedupeKey: MMS_PROVIDER_CLEANUP.dedupeKey(p.messageId), runAt: (dispatchedAt + 24 * HOUR_MS) as never });
}

export function outboundMediaPurgeHandler(): TxJobHandler<Record<string, never>> {
  return {
    kind: OUTBOUND_MEDIA_PURGE.kind,
    queue: OUTBOUND_MEDIA_PURGE.queue,
    via: 'worker',
    schema: jobPayload({}) as never,
    every: { ms: 15 * MINUTE_MS },
    periodicPayload: {},
    async run(ctx) {
      // the DB clock decides expiry; the shred trigger shreds each unattached object, storage.blob_delete the blob
      const r = await sql`DELETE FROM outbound_media_uploads WHERE tenant_id = app.tenant_id() AND expires_at <= now()`.execute(ctx.tx);
      const n = Number(r.numAffectedRows ?? 0);
      if (n > 0) ctx.log.info('expired uploads purged', { kind: OUTBOUND_MEDIA_PURGE.kind, jobId: ctx.job.id.toString(), count: n });
    },
  };
}

type DepsFor = (providers: Providers) => CommsDeps;

/** The provider's copies of one sent photo text (best effort; a 404 is done). Runs after an erasure too. */
export async function cleanupProviderCopies(deps: CommsDeps, tenantId: string, p: MmsProviderCleanupPayload): Promise<{ deleted: number; messages: number; complete: boolean }> {
  const tel = deps.providers.telephony;
  const account = await asSystem(deps, tenantId, 'provider', (tx) => telephonyAccount(tx, deps.envelope, tenantId));
  if (!account || !tel.listMessageMedia || !tel.deleteMedia) return { deleted: 0, messages: 0, complete: false };
  let refs: string[];
  let complete = true;
  if (p.providerRef) refs = [p.providerRef];
  else if (p.phoneNumberId && p.dispatchedAt !== undefined && tel.listOutboundMediaMessages) {
    const from = await asSystem(deps, tenantId, 'provider', async (tx) =>
      (await sql<{ e164: string }>`SELECT e164 FROM phone_numbers WHERE tenant_id = app.tenant_id() AND id = ${p.phoneNumberId!}`.execute(tx)).rows[0]?.e164 ?? null);
    if (!from) return { deleted: 0, messages: 0, complete: false };
    const found = await tel.listOutboundMediaMessages(account, { from, createdFrom: p.dispatchedAt - MINUTE_MS, createdTo: p.dispatchedAt + 20 * MINUTE_MS });
    refs = found.refs;
    complete = found.complete;
  } else return { deleted: 0, messages: 0, complete: false };
  let deleted = 0;
  for (const messageRef of refs) {
    const media = await tel.listMessageMedia(account, messageRef).catch(() => [] as string[]);
    for (const mediaRef of media) {
      await tel.deleteMedia(account, { messageRef, mediaRef }).then(() => deleted++, () => undefined);
    }
  }
  return { deleted, messages: refs.length, complete };
}

export function mmsProviderCleanupHandler(depsFor: DepsFor): StandaloneJobHandler<MmsProviderCleanupPayload> {
  return {
    kind: MMS_PROVIDER_CLEANUP.kind,
    queue: MMS_PROVIDER_CLEANUP.queue,
    mode: 'standalone',
    via: 'provider',
    schema: MmsProviderCleanupPayload,
    async run(ctx, p) {
      const r = await cleanupProviderCopies(depsFor(ctx.providers), ctx.actor.tenantId, p);
      ctx.log.info('mms provider cleanup', { kind: MMS_PROVIDER_CLEANUP.kind, jobId: ctx.job.id.toString(), code: `messages:${r.messages},deleted:${r.deleted}` });
      // an unknown-outcome submit whose copy was not found (or a window not fully listed) is an operator's job (E298)
      if (!p.providerRef && (r.messages === 0 || !r.complete)) {
        ctx.alerts.raise({ severity: 'P2', code: 'WORKER_ERROR', tenantId: ctx.actor.tenantId, details: { kind: MMS_PROVIDER_CLEANUP.kind, messageId: p.messageId, phoneNumberId: p.phoneNumberId ?? null, dispatchedAt: p.dispatchedAt ?? null } });
      }
    },
  };
}

export function outboundMediaHandlers(depsFor: DepsFor): JobHandler<unknown>[] {
  return [outboundMediaPurgeHandler(), mmsProviderCleanupHandler(depsFor)] as unknown as JobHandler<unknown>[];
}
