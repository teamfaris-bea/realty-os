// The live transfer of an AI call to the contact's own agent (R-VOICE-6, R-VOICE-16; E432, E433, E434).
//
// Core decided the transfer (warm_transfer allowed: the owner, inside routing hours, a hot caller, within the hold).
// Module 48 rings only that owner, on their verified alert phone, from the team number, for the hold, then the
// owner's leg hears a whisper and presses 1 (comms/voice.ts's screen + accept routes, AI branches). No announcement is
// played to the caller here: the AI call already announced the recording. `calls.transfer_outcome` is the single
// arbiter of how the transfer ended: every write is `WHERE transfer_outcome IS NULL`, so of a late key press, the
// hold end and the dial result exactly one wins and the others read what won.
import type { ContactId, SystemActor } from '@realty/core/foundation';
import type { TransferOutcome } from '@realty/core/voice';
import { lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { inboundUrls } from '../comms/voice.js';
import { BRIDGE_TWIML, ringTwiml, sayAndHangupTwiml, screenTwiml } from '../providers/twilio/voiceTwiml.js';
import type { VoiceDeps } from './runtime.js';

/** The owner leg's whisper. VERIFY WITH COUNSEL (C2). */
export const TRANSFER_WHISPER = "Call from the team's automated assistant: a caller asked for you. This call is recorded. Press 1 to take it.";
export const LATE_PRESS_TEXT = 'This call has ended.';

export type StartTransfer = { kind: 'ring'; twiml: string } | { kind: 'no_phone' };

/** Rings the owner (the user core named) or reports that they have no verified alert phone (E434). */
export async function startTransfer(actor: SystemActor, deps: Pick<VoiceDeps, 'db' | 'comms'>, callId: string, ownerUserId: string, holdSeconds: number): Promise<StartTransfer> {
  const r = await withTenantTx(actor, async (tx) => {
    const c = (await sql<{ contact_id: string; e164: string | null }>`
      SELECT c.contact_id, n.e164 FROM calls c LEFT JOIN phone_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.phone_number_id
       WHERE c.tenant_id = app.tenant_id() AND c.id = ${callId} AND c.handled_by = 'assistant'`.execute(tx)).rows[0];
    if (!c?.e164) return null;
    await lockContact(tx, c.contact_id as ContactId);
    const m = (await sql<{ phone: string | null }>`
      SELECT alert_phone_e164 AS phone FROM memberships
       WHERE tenant_id = app.tenant_id() AND user_id = ${ownerUserId} AND status = 'active' AND alert_phone_verified_at IS NOT NULL`.execute(tx)).rows[0];
    if (!m?.phone) return null;
    const u = await sql`
      UPDATE calls SET ring_user_id = ${ownerUserId}, transferred_to_user_id = ${ownerUserId}
       WHERE tenant_id = app.tenant_id() AND id = ${callId} AND handled_by = 'assistant' AND transferred_to_user_id IS NULL AND transfer_outcome IS NULL`.execute(tx);
    if (Number(u.numAffectedRows ?? 0) === 0) return null;
    return { teamNumber: c.e164, phone: m.phone };
  }, { db: deps.db, retries: 2 });
  if (!r) return { kind: 'no_phone' };
  const urls = inboundUrls(deps.comms, actor.tenantId, callId);
  return {
    kind: 'ring',
    twiml: ringTwiml({ announcement: null, callerId: r.teamNumber, agentPhone: r.phone, timeoutS: holdSeconds, record: true, screenUrl: urls.screen, actionUrl: urls.dialResult, recordingStatusCallbackUrl: urls.callRecording }),
  };
}

/**
 * Claims the transfer's outcome once. `won`: this write decided it; otherwise `stored` is what an earlier write
 * decided. 'connected' also makes the owner the call's agent.
 */
export async function claimTransferOutcome(actor: SystemActor, deps: Pick<VoiceDeps, 'db'>, callId: string, outcome: TransferOutcome): Promise<{ won: boolean; stored: TransferOutcome | null }> {
  return withTenantTx(actor, async (tx) => {
    const u = await sql<{ transfer_outcome: TransferOutcome }>`
      UPDATE calls SET transfer_outcome = ${outcome},
             agent_user_id = CASE WHEN ${outcome} = 'connected' THEN transferred_to_user_id ELSE agent_user_id END
       WHERE tenant_id = app.tenant_id() AND id = ${callId} AND handled_by = 'assistant' AND transferred_to_user_id IS NOT NULL AND transfer_outcome IS NULL
       RETURNING transfer_outcome`.execute(tx);
    if (u.rows[0]) return { won: true, stored: outcome };
    const r = await sql<{ transfer_outcome: TransferOutcome | null }>`SELECT transfer_outcome FROM calls WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    return { won: false, stored: r.rows[0]?.transfer_outcome ?? null };
  }, { db: deps.db, retries: 2 });
}

export interface AiCallState {
  handledBy: string;
  transferredToUserId: string | null;
  transferOutcome: TransferOutcome | null;
  endedAt: Date | null;
  answeredAt: Date | null;
  status: string;
}

export async function aiCallState(actor: SystemActor, deps: Pick<VoiceDeps, 'db'>, callId: string): Promise<AiCallState | null> {
  return withTenantTx(actor, async (tx) => {
    const r = await sql<{ handled_by: string; transferred_to_user_id: string | null; transfer_outcome: TransferOutcome | null; ended_at: Date | null; answered_at: Date | null; status: string }>`
      SELECT handled_by, transferred_to_user_id, transfer_outcome, ended_at, answered_at, status FROM calls WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    const x = r.rows[0];
    return x ? { handledBy: x.handled_by, transferredToUserId: x.transferred_to_user_id, transferOutcome: x.transfer_outcome, endedAt: x.ended_at, answeredAt: x.answered_at, status: x.status } : null;
  }, { db: deps.db });
}

/** /voice/screen for an AI call: the whisper while the transfer is open; null for a call that is not an AI call. */
export async function aiScreen(actor: SystemActor, deps: Pick<VoiceDeps, 'db' | 'comms'>, callId: string): Promise<string | null> {
  const s = await aiCallState(actor, deps, callId);
  if (!s || s.handledBy !== 'assistant') return null;
  if (!s.transferredToUserId || s.transferOutcome !== null) return sayAndHangupTwiml(null);
  return screenTwiml({ prompt: TRANSFER_WHISPER, acceptUrl: inboundUrls(deps.comms, actor.tenantId, callId).accept });
}

/** /voice/accept for an AI call: 1 connects (if the hold is still open), any other key declines. null: not an AI call. */
export async function aiAccept(actor: SystemActor, deps: Pick<VoiceDeps, 'db'>, callId: string, digits: string): Promise<string | null> {
  const s = await aiCallState(actor, deps, callId);
  if (!s || s.handledBy !== 'assistant') return null;
  if (!s.transferredToUserId) return sayAndHangupTwiml(null);
  if (digits === '1') {
    const c = await claimTransferOutcome(actor, deps, callId, 'connected');
    // a retried accept of the won press still bridges
    return c.won || c.stored === 'connected' ? BRIDGE_TWIML : sayAndHangupTwiml(LATE_PRESS_TEXT);
  }
  await claimTransferOutcome(actor, deps, callId, 'declined');
  return sayAndHangupTwiml(null);
}
