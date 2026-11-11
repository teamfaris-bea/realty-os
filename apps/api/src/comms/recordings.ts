// Call recordings and transcripts (R-CONSENT-16, R-PERM-8, R-PERM-9, R-DATA-1, R-TEN-9; E47).
//
//   onRecordingReady  the provider's recording of an outbound/inbound call: kept ONLY when the call's
//                     stored recording decision allows it (announced mode ⇒ the announcement played,
//                     E47); copied into tenant-keyed encrypted storage (per-object DEK, key
//                     tenants/{tenant}/recording/{id}); a comms.transcribe job follows.
//   transcribe        provider transcription; segments field-encrypted with the tenant key (AAD = row).
//   playback          POST …/stream-token issues a 60-second single-use token (only its SHA-256 is
//                     stored); GET …/stream redeems it once and streams the decrypted audio; the play is
//                     audited in the redeeming transaction (recording.play). Transcript views are
//                     audited too (transcript.view). The recording-scope RESTRICTIVE policy (R-PERM-8)
//                     applies to every read here, so an agent outside the scope sees 404.
// Provider-side deletion: when the provider supports it (TelephonyProvider.deleteRecording, Twilio), its copy
// is deleted once ours is stored (provider_copy_deleted_at is set), and also when the recording may not be
// kept (E47). A failed delete is retried by the job (the copy step is idempotent on the recording ref).
import type { ContactId, ResourceFacts, SystemActor, TenantId, UserActor } from '@realty/core/foundation';
import { DAY_MS, plusMs, toIso } from '@realty/core/foundation';
import { type Tx, enqueueJob, lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { getObject, putObject } from '../crypto/objects.js';
import { ciphertextKeyVersion, randomBytes, sha256 } from '../crypto/primitives.js';
import { AppError } from '../errors.js';
import { mayKeepRecording } from './dial.js';
import { telephonyAccount } from './repos/credentials.js';
import { tenantFacts } from './repos/gate.js';
import { asUser } from './runtime.js';
import type { CommsDeps } from './types.js';

export interface RecordingReady {
  tenantId: string;
  providerCallRef: string;
  recordingRef: string;
  durationS?: number;
  /** a voicemail the caller left (comms/voice.ts): kept when the call went to voicemail and the notice played */
  voicemail?: boolean;
}

export const TRANSCRIBE_JOB = { kind: 'comms.transcribe', queue: 'default' as const, dedupeKey: (id: string) => `comms.transcribe:${id}` };
export const RECORDING_COPY_JOB = { kind: 'comms.recording_copy', queue: 'default' as const, dedupeKey: (ref: string) => `comms.recording_copy:${ref}` };

export type RecordingOutcome = { kind: 'stored'; recordingId: string } | { kind: 'refused'; reason: 'RECORDING_NOT_PERMITTED' | 'CALL_UNKNOWN' } | { kind: 'duplicate'; recordingId: string };

interface CallRow {
  id: string;
  contact_id: string;
  agent_user_id: string | null;
  recording_mode: string;
  recording_decision: { announce?: boolean; voicemailNoticeAt?: string };
  recording_announced_at: Date | null;
  handled_by: string;
  direction: string;
}

/**
 * A voicemail may be kept when the call really went to voicemail (handled_by, set when the voicemail
 * TwiML was served) and the greeting with its fixed recording notice was played to the caller.
 * VERIFY WITH COUNSEL that the notice is enough in every launch state.
 */
export function mayKeepVoicemail(c: Pick<CallRow, 'handled_by' | 'direction' | 'recording_decision'>): boolean {
  return c.direction === 'inbound' && c.handled_by === 'voicemail' && typeof c.recording_decision.voicemailNoticeAt === 'string';
}

async function callByRef(tx: Tx, ref: string): Promise<CallRow | null> {
  const r = await sql<CallRow>`
    SELECT id, contact_id, agent_user_id, recording_mode, recording_decision, recording_announced_at, handled_by, direction FROM calls
     WHERE tenant_id = app.tenant_id() AND provider_call_ref = ${ref}`.execute(tx);
  return r.rows[0] ?? null;
}

/** BUILD_PLAN interface: copy → encrypt → (provider delete: not in the Phase 1 interface) → transcription job. */
export async function onRecordingReady(e: RecordingReady, deps: CommsDeps, actor: SystemActor): Promise<RecordingOutcome> {
  const pre = await withTenantTx(actor, async (tx) => {
    const call = await callByRef(tx, e.providerCallRef);
    if (!call) return { kind: 'refused', reason: 'CALL_UNKNOWN' } as const;
    const dup = await sql<{ id: string }>`SELECT id FROM recordings WHERE tenant_id = app.tenant_id() AND provider_recording_ref = ${e.recordingRef}`.execute(tx);
    if (dup.rows[0]) return { kind: 'duplicate', recordingId: dup.rows[0].id } as const;
    if (e.voicemail ? !mayKeepVoicemail(call) : !mayKeepRecording(call)) return { kind: 'refused', reason: 'RECORDING_NOT_PERMITTED' } as const;
    return { kind: 'ok', call } as const;
  }, { db: deps.db });
  if (pre.kind === 'refused' && pre.reason === 'CALL_UNKNOWN') return pre;
  const account = await withTenantTx(actor, (tx) => telephonyAccount(tx, deps.envelope, e.tenantId), { db: deps.db });
  if (!account) throw new Error('TELEPHONY_ACCOUNT_MISSING');
  const discard = async (recordingId: string | null) => {
    if (!deps.providers.telephony.deleteRecording) return;
    await deps.providers.telephony.deleteRecording(account, e.recordingRef);
    if (recordingId) {
      await withTenantTx(actor, async (tx) => {
        await sql`UPDATE recordings SET provider_copy_deleted_at = clock_timestamp() WHERE tenant_id = app.tenant_id() AND id = ${recordingId} AND provider_copy_deleted_at IS NULL`.execute(tx);
      }, { db: deps.db });
    }
  };
  // a recording that may not be kept is not kept at the provider either
  if (pre.kind === 'refused') {
    await discard(null);
    return pre;
  }
  if (pre.kind === 'duplicate') {
    await discard(pre.recordingId);
    return pre;
  }
  const audio = await deps.providers.telephony.fetchRecording(account, e.recordingRef);
  const out = await withTenantTx(actor, async (tx, now) => {
    const call = pre.call;
    await lockContact(tx, call.contact_id as ContactId);
    const dup = await sql<{ id: string }>`SELECT id FROM recordings WHERE tenant_id = app.tenant_id() AND provider_recording_ref = ${e.recordingRef}`.execute(tx);
    if (dup.rows[0]) return { kind: 'duplicate', recordingId: dup.rows[0].id } as const;
    const settings = await tenantFacts(tx);
    const objectId = deps.ids.next<'StoredObjectId'>();
    const recordingId = deps.ids.next<'RecordingId'>();
    const tenantId = e.tenantId as TenantId;
    const sealed = await putObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, objectId, 'recording', audio.bytes, audio.contentType);
    const retain = plusMs(now, settings.recordingRetentionDays * DAY_MS);
    await sql`
      INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, retention_until)
      VALUES (app.tenant_id(), ${objectId}, 'recording', ${sealed.storageKey}, ${audio.contentType}, ${sealed.byteSize}, ${Buffer.from(sealed.sha256)},
              ${Buffer.from(sealed.dekWrapped)}, ${sealed.keyVersion}, ${toIso(retain)}::timestamptz)`.execute(tx);
    await sql`
      INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, object_id, duration_s, source, consent_basis, status, retain_until,
        provider_recording_ref)
      VALUES (app.tenant_id(), ${recordingId}, ${call.id}, ${call.contact_id}, ${call.agent_user_id}, ${objectId},
              ${e.durationS ?? Math.round(audio.durationMs / 1000)}, 'provider',
              ${!e.voicemail && call.recording_mode === 'one_party_no_announcement' ? 'one_party_policy' : 'announced_all_parties'}, 'stored', ${toIso(retain)}::timestamptz,
              ${e.recordingRef})`.execute(tx);
    await enqueueJob(tx, { queue: TRANSCRIBE_JOB.queue, kind: TRANSCRIBE_JOB.kind, payload: { recordingId }, dedupeKey: TRANSCRIBE_JOB.dedupeKey(recordingId) });
    return { kind: 'stored', recordingId } as const;
  }, { db: deps.db, retries: 2 });
  await discard(out.recordingId);
  return out;
}

const transcriptAad = (rowId: string) => ({ table: 'transcripts', column: 'segments_enc', rowId });

/** comms.transcribe: provider transcription, stored encrypted (never logged, never searchable). */
export async function transcribeRecording(recordingId: string, deps: CommsDeps, actor: SystemActor): Promise<'ready' | 'skipped'> {
  const tenantId = actor.tenantId as TenantId;
  const rec = await withTenantTx(actor, async (tx) => {
    const r = await sql<{ id: string; contact_id: string; status: string; storage_key: string; dek_wrapped: Buffer | null; content_type: string; object_id: string; has: boolean }>`
      SELECT r.id, r.contact_id, r.status, o.storage_key, o.dek_wrapped, o.content_type, o.id AS object_id,
             EXISTS (SELECT 1 FROM transcripts t WHERE t.tenant_id = r.tenant_id AND t.recording_id = r.id) AS has
        FROM recordings r JOIN stored_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id
       WHERE r.tenant_id = app.tenant_id() AND r.id = ${recordingId}`.execute(tx);
    const x = r.rows[0];
    if (!x || x.status !== 'stored' || x.has || !x.dek_wrapped) return null;
    const audio = await getObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, x.object_id, x.storage_key, new Uint8Array(x.dek_wrapped));
    return audio ? { ...x, audio } : null;
  }, { db: deps.db });
  if (!rec) return 'skipped';
  const t = await deps.providers.transcription.transcribe({ audio: rec.audio, contentType: rec.content_type });
  await withTenantTx(actor, async (tx) => {
    const id = deps.ids.next<'TranscriptId'>();
    const enc = await deps.envelope.inTx(tx, tenantId).encrypt(tenantId, transcriptAad(id), Buffer.from(JSON.stringify(t.segments)));
    await sql`
      INSERT INTO transcripts (tenant_id, id, recording_id, contact_id, status, language, segments_enc, key_version, provider)
      VALUES (app.tenant_id(), ${id}, ${recordingId}, ${rec.contact_id}, 'ready', ${t.language}, ${Buffer.from(enc)}, ${ciphertextKeyVersion(enc)}, 'fake')
      ON CONFLICT (tenant_id, recording_id) DO NOTHING`.execute(tx);
  }, { db: deps.db });
  return 'ready';
}

// ---- playback ----------------------------------------------------------------------------------------

export const STREAM_TOKEN_TTL_MS = 60_000;

/** core.can facts for recording.play / transcript.view, from RLS-visible rows (null ⇒ 404). */
export async function recordingFacts(tx: Tx, recordingId: string): Promise<ResourceFacts | null> {
  const r = await sql<{ own: boolean; on_call: boolean; team: boolean; deal: boolean; tl: boolean; tc: boolean }>`
    SELECT c.owner_user_id IS NOT DISTINCT FROM app.user_id() AND c.owner_user_id IS NOT NULL AS own,
           r.agent_user_id IS NOT DISTINCT FROM app.user_id() AND r.agent_user_id IS NOT NULL AS on_call,
           c.owner_user_id = ANY (app.my_team_member_ids()) AS team,
           r.contact_id = ANY (app.my_deal_contact_ids()) AS deal,
           s.team_lead_recording_access AS tl, s.tc_recording_access AS tc
      FROM recordings r JOIN contacts c ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
      JOIN tenant_settings s ON s.tenant_id = r.tenant_id
     WHERE r.tenant_id = app.tenant_id() AND r.id = ${recordingId}`.execute(tx);
  const f = r.rows[0];
  if (!f) return null;
  return { own: f.own, onCall: f.on_call, team: f.team, deal: f.deal, settings: { teamLeadRecordingAccess: f.tl, tcRecordingAccess: f.tc } };
}

export async function issueStreamToken(actor: UserActor, recordingId: string, purpose: 'play' | 'download', deps: CommsDeps): Promise<{ token: string; expiresAt: string; url: string }> {
  return asUser(deps, actor, async (tx, now) => {
    const r = await sql<{ status: string }>`SELECT status FROM recordings WHERE tenant_id = app.tenant_id() AND id = ${recordingId}`.execute(tx);
    if (!r.rows[0]) throw new AppError('NOT_FOUND');
    if (r.rows[0].status !== 'stored') throw new AppError('RECORDING_UNAVAILABLE');
    const token = Buffer.from(randomBytes(32)).toString('base64url');
    const expires = plusMs(now, STREAM_TOKEN_TTL_MS);
    await sql`
      INSERT INTO recording_stream_tokens (tenant_id, token_hash, recording_id, user_id, purpose, created_at, expires_at)
      VALUES (app.tenant_id(), ${Buffer.from(sha256(token))}, ${recordingId}, ${actor.userId}, ${purpose}, ${toIso(now)}::timestamptz, ${toIso(expires)}::timestamptz)`.execute(tx);
    return { token, expiresAt: toIso(expires), url: `/api/recordings/${recordingId}/stream?token=${token}` };
  });
}

/** Redeems the single-use token and returns the decrypted audio; the play is audited in this transaction. */
export async function streamRecording(actor: UserActor, recordingId: string, token: string, deps: CommsDeps): Promise<{ bytes: Uint8Array; contentType: string }> {
  return asUser(deps, actor, async (tx, now) => {
    const used = await sql<{ purpose: 'play' | 'download' }>`
      UPDATE recording_stream_tokens SET used_at = ${toIso(now)}::timestamptz
       WHERE tenant_id = app.tenant_id() AND token_hash = ${Buffer.from(sha256(token))} AND recording_id = ${recordingId}
         AND user_id = ${actor.userId} AND used_at IS NULL AND expires_at > ${toIso(now)}::timestamptz
      RETURNING purpose`.execute(tx);
    const t = used.rows[0];
    if (!t) throw new AppError('STREAM_TOKEN_INVALID');
    const r = await sql<{ status: string; storage_key: string; dek_wrapped: Buffer | null; content_type: string; object_id: string }>`
      SELECT r.status, o.storage_key, o.dek_wrapped, o.content_type, o.id AS object_id
        FROM recordings r JOIN stored_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id
       WHERE r.tenant_id = app.tenant_id() AND r.id = ${recordingId}`.execute(tx);
    const x = r.rows[0];
    if (!x) throw new AppError('NOT_FOUND');
    if (x.status !== 'stored' || !x.dek_wrapped) throw new AppError('RECORDING_UNAVAILABLE');
    const tenantId = actor.tenantId as TenantId;
    const bytes = await getObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, x.object_id, x.storage_key, new Uint8Array(x.dek_wrapped));
    if (!bytes) throw new AppError('RECORDING_UNAVAILABLE');
    await audit(tx, actor, { action: t.purpose === 'download' ? 'recording.download' : 'recording.play', entity: { type: 'recording', id: recordingId } });
    return { bytes, contentType: x.content_type };
  });
}

export async function viewTranscript(actor: UserActor, recordingId: string, deps: CommsDeps): Promise<{ status: string; language: string | null; segments: { startMs: number; endMs: number; speaker: string | null; text: string }[] }> {
  return asUser(deps, actor, async (tx) => {
    const r = await sql<{ id: string; status: string; language: string | null; segments_enc: Buffer | null }>`
      SELECT id, status, language, segments_enc FROM transcripts WHERE tenant_id = app.tenant_id() AND recording_id = ${recordingId}`.execute(tx);
    const x = r.rows[0];
    if (!x) throw new AppError('NOT_FOUND');
    const tenantId = actor.tenantId as TenantId;
    const segments = x.status === 'ready' && x.segments_enc ? JSON.parse(Buffer.from(await deps.envelope.inTx(tx, tenantId).decrypt(tenantId, transcriptAad(x.id), new Uint8Array(x.segments_enc))).toString('utf8')) : [];
    await audit(tx, actor, { action: 'transcript.view', entity: { type: 'transcript', id: x.id } });
    return { status: x.status, language: x.language, segments };
  });
}
