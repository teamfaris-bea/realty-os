// Test helpers for api/coaching (imported by *.test.ts and the e2e stack only).
//
// Everything the application does goes through the real server or this module's functions as app_user
// (RLS-bound). The superuser pool only reads state back, clears the platform:coaching pack (platform data:
// counsel's review is recorded by the platform, never by a tenant) and writes recorded calls, which have no
// application path outside the provider webhooks (as api/assistant's tests do).
import type { Instant, TenantId, UserActor, UserId } from '@realty/core/foundation';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { runJobs as commsJobs, telephonyWebhook } from '../comms/testing.js';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, call, depsOf, ownedContact, transcribedCall } from '../assistant/testing.js';
import { freshReauth } from '../admin/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { reconcileDailyFixes } from './fix.js';
import { reviewCall } from './review.js';

export { call, depsOf, freshReauth, ownedContact };

export type CoachingWorld = AssistantWorld;

/** A tenant with two agents in a team led by a Team Lead (call reviews are about the team's own calls). */
export async function coachingWorld(h: ApiHarness): Promise<CoachingWorld> {
  return assistantWorld(h, { agents: 2, teamLead: true });
}

/** Counsel reviewed the platform:coaching pack (platform data, written by the platform: the superuser here). */
export async function setPackCleared(h: ApiHarness, cleared: boolean): Promise<void> {
  await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${cleared ? 'now()' : 'NULL'} WHERE key = 'platform:coaching'`);
}

/** The Owner turns call scoring on (and optionally Team Lead access) through the settings route. */
export async function scoringOn(h: ApiHarness, owner: TestClient, o: { tl?: boolean; disabledKeys?: string[] } = {}): Promise<void> {
  await freshReauth(h, owner);
  const r = await call(owner, 'PUT', '/admin/coaching', { scoringEnabled: true, tlSeesCallScores: o.tl ?? false, disabledKeys: o.disabledKeys ?? [] });
  if (r.status !== 200) throw new Error(`scoring on: ${r.status} ${JSON.stringify(r.body)}`);
}

/** A complete call that hits every checklist item except those in `skip` (the fake reviewer's words). */
export function callLines(skip: readonly string[] = []): [string, string][] {
  const L: [string, string, string][] = [
    ['introduced_self', 'agent', 'Hi, this is Dana Reyes with Harbor Realty, thanks for calling back.'],
    ['', 'lead', 'Hi Dana, yes, we saw the house on Maple Street.'],
    ['asked_timeline', 'agent', 'Great. When are you hoping to be moved in?'],
    ['', 'lead', 'Probably by the end of March.'],
    ['asked_financing', 'agent', 'Have you had a chance to talk with a lender yet?'],
    ['', 'lead', 'Not yet, we were going to do that next week.'],
    ['asked_motivation', 'agent', 'What has you thinking about a move right now?'],
    ['', 'lead', 'We need another bedroom.'],
    ['confirmed_contact_preference', 'agent', 'Is text or a call better for you?'],
    ['', 'lead', 'Text is best.'],
    ['proposed_next_step', 'agent', 'Would Tuesday at 5 or Wednesday at 6 work for a showing?'],
    ['', 'lead', 'Tuesday at 5 works.'],
    ['set_follow_up', 'agent', 'Great, I will text you a reminder on Monday.'],
    ['recapped_call', 'agent', 'So to recap, Tuesday at 5 at Maple Street.'],
    ['', 'agent', 'Thanks so much, talk soon.'],
    ['', 'lead', 'Perfect, thanks.'],
  ];
  return L.filter(([k]) => k === '' || !skip.includes(k)).map(([, s, t]) => [s, t]);
}

export function segments(lines: readonly [string, string][]): { startMs: number; endMs: number; speaker: string; text: string }[] {
  return lines.map(([speaker, text], i) => ({ speaker, text, startMs: i * 5000, endMs: i * 5000 + 4500 }));
}

export interface CallOpts {
  skip?: string[];
  startedAt?: Date;
  /** turn the recorded call into something that must never be reviewed */
  variant?: 'import_fub' | 'imported_call' | 'ai_handled' | 'voicemail' | 'shredded' | 'no_recording' | 'one_party';
}

/** A recorded, transcribed, human-handled call of `agentUserId` with `contactId` (then altered by `variant`). */
export async function recordedCall(h: ApiHarness, w: CoachingWorld, contactId: string, agentUserId: string | null, o: CallOpts = {}): Promise<string> {
  if (!agentUserId) throw new Error('recordedCall: no agent');
  const id = await transcribedCall(h, w, contactId, agentUserId, segments(callLines(o.skip)), { startedAt: o.startedAt ?? new Date(Date.now() - 3_600_000) });
  switch (o.variant) {
    case 'import_fub': {
      // an imported FUB recording: unknown basis (the 0001 CHECK ties import_fub to unknown_imported)
      await h.su.query(`UPDATE recordings SET source = 'import_fub', consent_basis = 'unknown_imported' WHERE call_id = $1`, [id]);
      break;
    }
    case 'imported_call':
      await h.su.query(`UPDATE calls SET imported = true, initiator = 'import' WHERE id = $1`, [id]);
      break;
    case 'ai_handled': {
      // an answered AI call (Phase 3 voice): disclosed, announced, under a voice playbook (fixture: FKs and
      // voice triggers off in replica mode; the CHECKs still hold)
      const c = await h.su.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(`UPDATE calls SET handled_by = 'assistant', initiator = 'client', direction = 'inbound', ai_disclosed_at = started_at, voice_playbook_version_id = gen_random_uuid() WHERE id = $1`, [id]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      break;
    }
    case 'voicemail':
      await h.su.query(`UPDATE calls SET handled_by = 'voicemail' WHERE id = $1`, [id]);
      break;
    case 'shredded':
      await h.su.query(`UPDATE recordings SET status = 'shredded', shredded_at = now() WHERE call_id = $1`, [id]);
      break;
    case 'no_recording':
      await h.su.query(`DELETE FROM recordings WHERE call_id = $1`, [id]);
      break;
    case 'one_party':
      await h.su.query(`UPDATE recordings SET consent_basis = 'one_party_policy' WHERE call_id = $1`, [id]);
      break;
    default:
      break;
  }
  return id;
}

export const review = (h: ApiHarness, tenantId: string, callId: string) => reviewCall(systemActor(tenantId, 'assistant'), callId, depsOf(h));

export const reconcile = (h: ApiHarness, tenantId: string, at?: Instant) =>
  withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => reconcileDailyFixes(tx, depsOf(h).ids, at ?? now), { db: h.database });

export async function cardsOf(h: ApiHarness, userId: string | null): Promise<{ id: string; dedupe_key: string; state: string; resolved_by: string | null; reasons: { code: string; label: string; fix?: { item: string; quotes: { callId: string; evidenceId: string }[] } }[] }[]> {
  return (await h.su.query(`SELECT id, dedupe_key, state, resolved_by, reasons FROM priority_feed_items WHERE user_id = $1 AND item_type = 'coaching_fix' ORDER BY created_at, id`, [userId])).rows;
}

export const DAY_MS = 24 * 3_600_000;

/** The user actor of a signed-in test client (for RLS proofs as that person, straight against the DB). */
export function actorOf(c: TestClient): UserActor {
  if (!c.userId || !c.tenantId || !c.role) throw new Error('client not signed in');
  return { kind: 'user', userId: c.userId as UserId, tenantId: c.tenantId as TenantId, role: c.role, sessionId: 'rls-proof' };
}

/**
 * A call that is really playable: dialed through the API, announced, completed and recorded through the
 * provider webhooks, the recording copied into tenant storage by the comms job (as production does), and
 * then its transcript set to `lines` (the fake transcriber's text is fixed; the transcript is encrypted as
 * comms writes it). Returns the call id.
 */
export async function playableCall(h: ApiHarness, w: CoachingWorld, agent: TestClient, contactId: string, o: { skip?: string[] } = {}): Promise<string> {
  await alertPhone(h, agent);
  const r = await call<{ callId: string }>(agent, 'POST', `/contacts/${contactId}/calls`, {});
  if (r.status !== 200) throw new Error(`dial: ${r.status} ${JSON.stringify(r.body)}`);
  const callId = r.body.callId;
  const ref = (await h.su.query<{ r: string }>('SELECT provider_call_ref AS r FROM calls WHERE id = $1', [callId])).rows[0]!.r;
  const voice = (status: string, extra: Record<string, string> = {}) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: ref, From: w.mainNumber, To: '+14155550000', CallStatus: status, Direction: 'outbound-api', ...extra });
  await voice('ringing');
  await voice('in-progress', { AnnouncementStatus: 'played' });
  await voice('completed', { CallDuration: '80' });
  const rec = await telephonyWebhook(h, '/webhooks/telephony/recording', { CallSid: ref, RecordingSid: `RE${randomUUID().replace(/-/g, '').slice(0, 30)}`, RecordingDuration: '80', From: w.mainNumber });
  if (rec.statusCode !== 200) throw new Error(`recording webhook: ${rec.statusCode}`);
  await commsJobs(h, w.tenantId, ['comms.recording_copy', 'comms.transcribe']);
  const t = (await h.su.query<{ id: string }>('SELECT t.id FROM transcripts t JOIN recordings r ON r.tenant_id = t.tenant_id AND r.id = t.recording_id WHERE r.call_id = $1', [callId])).rows[0];
  if (!t) throw new Error('playableCall: no transcript');
  const deps = depsOf(h);
  await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
    const enc = await deps.envelope.inTx(tx, w.tenantId as TenantId).encrypt(w.tenantId as TenantId, { table: 'transcripts', column: 'segments_enc', rowId: t.id }, Buffer.from(JSON.stringify(segments(callLines(o.skip)))));
    await sql`UPDATE transcripts SET segments_enc = ${Buffer.from(enc)}, status = 'ready', key_version = 1 WHERE tenant_id = app.tenant_id() AND id = ${t.id}`.execute(tx);
  }, { db: h.database });
  return callId;
}

const verified = new WeakSet<TestClient>();
/** The agent's verified alert phone (the dial path bridges the agent first). */
export async function alertPhone(h: ApiHarness, c: TestClient): Promise<void> {
  if (verified.has(c)) return;
  const phone = `+1415${String(2000000 + Math.floor(Math.random() * 7_000_000)).padStart(7, '0')}`;
  const ch = await c.post('/api/me/alert-phone', { phone });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  verified.add(c);
}
