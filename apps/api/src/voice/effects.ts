// The calls-row effects of an AI session (R-VOICE-2, R-VOICE-10; E116, E117, E425).
//
//   disclosed   ai_disclosed_at = the instant the platform reported the disclosure played
//   announced   one UPDATE: recording_announced_at = answered_at = that instant, status in_progress, only while the
//               call still rings and has not ended (calls_assistant_disclosed, 0018; answered_at needs both played).
//               Zero rows: the caller is gone; the runner feeds a hangup.
//   voicemail   the voicemail TwiML (the tenant's greeting and the fixed VOICEMAIL_NOTICE). An answered call records
//               under its announced basis (plain recording callback). A call never answered is a pre-answer fallback:
//               ?vm= with voicemailNoticeAt merged and status no_answer, committed BEFORE the hand-off, so the
//               recording job can keep the message whenever it runs (recordings.ts mayKeepVoicemail).
import type { ContactId, Instant, SystemActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { VOICEMAIL_MAX_S, VOICEMAIL_NOTICE, inboundUrls, voiceSettingsIn } from '../comms/voice.js';
import { voicemailTwiml } from '../providers/twilio/voiceTwiml.js';
import type { VoiceDeps } from './runtime.js';

export async function markDisclosed(actor: SystemActor, deps: Pick<VoiceDeps, 'db'>, callId: string, at: Instant): Promise<void> {
  await withTenantTx(actor, async (tx) => {
    await sql`UPDATE calls SET ai_disclosed_at = COALESCE(ai_disclosed_at, ${toIso(at)}::timestamptz)
               WHERE tenant_id = app.tenant_id() AND id = ${callId} AND handled_by = 'assistant'`.execute(tx);
  }, { db: deps.db, retries: 2 });
}

/** True when the call was still ringing (now answered by the assistant); false when it already ended. */
export async function markAnnounced(actor: SystemActor, deps: Pick<VoiceDeps, 'db'>, callId: string, at: Instant): Promise<boolean> {
  return withTenantTx(actor, async (tx) => {
    const r = await sql`
      UPDATE calls SET recording_announced_at = ${toIso(at)}::timestamptz, answered_at = ${toIso(at)}::timestamptz, status = 'in_progress'
       WHERE tenant_id = app.tenant_id() AND id = ${callId} AND handled_by = 'assistant' AND status = 'ringing' AND ended_at IS NULL
         AND ai_disclosed_at IS NOT NULL`.execute(tx);
    return Number(r.numAffectedRows ?? 0) > 0;
  }, { db: deps.db, retries: 2 });
}

/** The voicemail TwiML for an AI call (answered: plain recording callback; never answered: ?vm= after the notice is recorded). */
export async function voicemailFor(actor: SystemActor, deps: Pick<VoiceDeps, 'db' | 'comms'>, callId: string): Promise<string> {
  const r = await withTenantTx(actor, async (tx, now) => {
    const c = (await sql<{ contact_id: string }>`SELECT contact_id FROM calls WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx)).rows[0];
    if (c) await lockContact(tx, c.contact_id as ContactId);
    const row = (await sql<{ answered_at: Date | null }>`SELECT answered_at FROM calls WHERE tenant_id = app.tenant_id() AND id = ${callId} FOR UPDATE`.execute(tx)).rows[0];
    const answered = row?.answered_at != null;
    if (!answered) {
      await sql`
        UPDATE calls SET recording_decision = recording_decision || jsonb_build_object('voicemailNoticeAt', COALESCE(recording_decision ->> 'voicemailNoticeAt', ${new Date(now).toISOString()})),
               status = CASE WHEN status = 'ringing' THEN 'no_answer' ELSE status END
         WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    }
    const s = await voiceSettingsIn(tx);
    return { answered, greeting: s.voicemailGreeting ?? s.defaultGreeting };
  }, { db: deps.db, retries: 2 });
  const u = inboundUrls(deps.comms, actor.tenantId, callId);
  return voicemailTwiml({ greeting: r.greeting, notice: VOICEMAIL_NOTICE, maxLengthS: VOICEMAIL_MAX_S, doneUrl: u.voicemailDone, recordingStatusCallbackUrl: r.answered ? u.callRecording : u.voicemailRecording });
}
