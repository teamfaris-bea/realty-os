// A message queued before a narrower approval waits ONCE, for the narrower window (R-ISA-41; E1014; review fix F4).
//
// The send transaction already refuses such a message outside the narrower window (send.ts aiIsaGateFacts: the later
// start and the earlier end of the turn's window and the content in effect; ISA_QUIET_HOURS). The deferral used the
// turn's frozen window alone, which is open, so it set the message back by a minute, again and again, until the narrower
// window opened; and it set a gap refusal back by the platform's default gap whatever the policy's gap was.
// There is no fake clock: the narrower window opens a little over a minute from the database's now(), and this test
// waits for it. Real Postgres via the API harness; the fake ISA model and the fake telephony adapter; nothing real is sent.
import { DEFAULT_AI_ISA_CONTENT } from '@realty/core/isa';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { deferralFor } from './send.js';
import { type IsaLead, type IsaWorld, aiMessages, call, freshReauth, isaLead, isaWorker, isaWorld, optInAgent, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

const D = DEFAULT_AI_ISA_CONTENT as unknown as Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dbNow = async () => (await h.su.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now.getTime();
const hhmmss = (sec: number) => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((x) => String(x).padStart(2, '0')).join(':');

async function approveNarrower(content: Record<string, unknown>) {
  await freshReauth(h, w.owner);
  const saved = await call<{ draft: { versionId: string; contentSha256: string; approvalText: string; effect: string } }>(w.owner, 'PUT', '/admin/ai-isa/policy/draft', { content });
  expect(saved.body.draft.effect).toBe('narrower');
  const d = saved.body.draft;
  const r = await call<{ effect: string; careContinues: boolean }>(w.owner, 'POST', '/admin/ai-isa/policy/approve', { versionId: d.versionId, contentSha256: d.contentSha256, attestation: d.approvalText });
  expect(r.body).toMatchObject({ effect: 'narrower', careContinues: true });
  return (await dbNow());
}

/** A lead in AI care whose reply the assistant has answered, with the answer still queued (its dispatch job held). */
async function queuedReply(text: string): Promise<{ lead: IsaLead; messageId: string }> {
  const lead = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  await inboundSms(h, lead.phone, w.mainNumber, text);
  await runIsa(h, w.tenantId, 4, { hold: ['comms.dispatch'] });
  const queued = (await aiMessages(h, lead.id)).filter((m) => m.status === 'queued');
  expect(queued).toHaveLength(1);
  return { lead, messageId: queued[0]!.id };
}
const messageOf = async (id: string) => (await h.su.query<{ status: string; status_reason: string | null; scheduled_for: Date | null; dispatched_at: Date | null }>(
  'SELECT status, status_reason, scheduled_for, dispatched_at FROM messages WHERE id = $1', [id])).rows[0]!;
const dispatchDue = (messageId: string) => h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending' AND kind = 'comms.dispatch' AND payload ->> 'messageId' = $2`, [w.tenantId, messageId]);

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-41 the deferral waits for the window and the gap in effect (E1014)', () => {
  it('a reply queued under 9:00 to 20:00 is deferred once to the opening of a narrower window approved after it, and is sent then by the fake provider, never earlier', async () => {
    const { lead, messageId } = await queuedReply('Hi, we are thinking about moving next spring');
    const turn = (await h.su.query<{ ws: string; we: string }>(`SELECT window_start::text AS ws, window_end::text AS we FROM ai_isa_turns WHERE message_id = $1`, [messageId])).rows[0]!;
    expect(turn).toEqual({ ws: '09:00:00', we: '20:00:00' });
    const queuedAt = await dbNow();

    // the narrower window opens 75 seconds from now in the person's own time (more than the deferral's one-minute floor)
    const local = (await h.su.query<{ sec: number; midnight: Date }>(`SELECT floor(extract(epoch FROM (now() AT TIME ZONE $1)::time))::int AS sec,
      (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS midnight`, [lead.zone])).rows[0]!;
    const startSec = local.sec + 75;
    const opening = local.midnight.getTime() + startSec * 1000;
    const approvedAt = await approveNarrower({ ...D, window: { startSec, endSec: 20 * 3600 } });
    expect(opening - approvedAt).toBeGreaterThan(61_000);

    let attempts = 0;
    const worker = () => isaWorker(h, { onRun: (kind, p) => { if (kind === 'comms.dispatch' && (p as { messageId: string }).messageId === messageId) attempts += 1; } });
    const smsBefore = h.providers.telephony.sms.filter((s) => s.to === lead.phone).length;

    // attempt 1: refused for quiet hours by the send transaction, and deferred to the narrower window's opening
    await dispatchDue(messageId);
    await worker().drain(10);
    expect(attempts).toBe(1);
    const deferred = await messageOf(messageId);
    expect(deferred).toMatchObject({ status: 'scheduled', status_reason: 'ISA_QUIET_HOURS', dispatched_at: null });
    expect(deferred.scheduled_for!.getTime()).toBe(opening);
    const job = (await h.su.query<{ run_at: Date }>(`SELECT run_at FROM jobs WHERE tenant_id = $1 AND status = 'pending' AND kind = 'comms.dispatch' AND payload ->> 'messageId' = $2`, [w.tenantId, messageId])).rows;
    expect(job.map((j) => j.run_at.getTime())).toEqual([opening]);

    // before the opening: a worker that is running finds nothing due; nothing is sent and nothing is deferred again
    await sleep(3_000);
    await worker().drain(10);
    expect(attempts).toBe(1);
    expect(await messageOf(messageId)).toMatchObject({ status: 'scheduled', dispatched_at: null });
    expect((await messageOf(messageId)).scheduled_for!.getTime()).toBe(opening);
    expect(h.providers.telephony.sms.filter((s) => s.to === lead.phone).length).toBe(smsBefore);

    // the window opens: the same job is due, and the message goes out through the fake provider
    while ((await dbNow()) < opening + 500) await sleep(1_000);
    await worker().drain(10);
    const sent = await messageOf(messageId);
    expect(sent.status).toBe('sent');
    expect(sent.dispatched_at!.getTime()).toBeGreaterThanOrEqual(opening);
    expect(attempts).toBe(2);
    expect(h.providers.telephony.sms.filter((s) => s.to === lead.phone).length).toBe(smsBefore + 1);
    const at = (t: number) => hhmmss(Math.floor(((t - local.midnight.getTime()) / 1000)));
    console.log(`F4: queued ${at(queuedAt)} under 09:00:00 to 20:00:00; narrower window ${hhmmss(startSec)} to 20:00:00 approved ${at(approvedAt)}; one deferral to ${at(deferred.scheduled_for!.getTime())}; sent ${at(sent.dispatched_at!.getTime())} by the fake provider; dispatch attempts: ${attempts}.`);
  }, 240_000);

  it('a gap refusal is deferred by the gap of the policy in effect, not by the platform default', async () => {
    // starting care for another lead needs the agent's opt-in on the version approved now (the narrower one of the case above)
    const current = (await call<{ approved: { versionId: string; content: Record<string, unknown> } }>(w.owner, 'GET', '/admin/ai-isa/policy')).body.approved;
    await optInAgent(h, w.agents[0]!, current.versionId);
    const { lead, messageId } = await queuedReply('Hello, is anyone there?');
    // then the policy asks for ten minutes between two AI messages (narrower: a larger gap), with the reply still queued
    await approveNarrower({ ...current.content, caps: { ...(current.content.caps as object), minGapSeconds: 600 } });
    const m = (await h.su.query<{ conversation_id: string; channel: string; assistant_action_id: string }>('SELECT conversation_id, channel, assistant_action_id FROM messages WHERE id = $1', [messageId])).rows[0]!;
    const ref = { id: messageId, contactId: lead.id, conversationId: m.conversation_id, channel: m.channel, assistantActionId: m.assistant_action_id };
    const now = await dbNow();
    const until = await withTenantTx(systemActor(w.tenantId as never, 'worker'), (tx) => deferralFor(tx, ref, ['ISA_MIN_GAP'], now as never), { db: h.database });
    expect(until).toBe(now + 600_000);
  });
});
