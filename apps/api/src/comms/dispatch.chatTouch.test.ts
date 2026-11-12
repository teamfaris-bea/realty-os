// Owner decision D8 (2026-11-12): a person's reply in the website chat counts as first contact (R-OWN-14 amended;
// DATA_MODEL E310–E312; batch 6 review finding ownership-sla/F1). Through the real server, the real ownership engine,
// the real timer jobs, the exception derivation and the scoreboard definitions, over real Postgres; fakes only (the
// in-process chat transport).
//   - The owner's reply in the open chat is the first touch, written once at dispatch TX1 like a text's: no breach,
//     no untouched_lead item, speed-to-lead answered with its response time, no auto-release, and the first-contact
//     card (Reply first, "Goes back to the pond … if not contacted") leaves the feed.
//   - Who counts is the rule of a text: a collaborator's reply counts, a Team Lead who is neither owner nor
//     collaborator may reply but it is not the touch, and the assistant's first response never counts.
//   - A reply the send refused (the chat ended, the widget is not connected, the person asked not to be contacted)
//     is never a touch, so the SLA runs on to breach and auto-release; an allowed reply whose delivery then fails
//     stays the touch, as a text's does (R-OWN-14).
//   - The scoreboard's activity and speed numbers agree for a chat reply, live and from the daily rollup.
//   - The re-inquiry rule (rule version 3, owner decision 2026-11-11) holds with chat touches.
import { randomUUID } from 'node:crypto';
import type { ContactId, Instant, TenantId } from '@realty/core/foundation';
import { applyOwnershipCommand, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scoreboardFor } from '../accountability/scoreboard.js';
import { rollScoreboard } from '../accountability/scoreboardRollup.js';
import { type AccWorld, accWorld, call, contactState, intake, itemRow, leadsWorker, ledger, recompute, setPeriodDeadlines, sleep, suFixture } from '../accountability/testing.js';
import { freshReauth } from '../admin/testing.js';
import { approvedPlaybook, runJobs as runAssistantJobs } from '../assistant/testing.js';
import { BUILT_IN_TEMPLATES as TEMPLATES } from '../assistant/templates.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { acceptLead, chatMessage, chatSource, createWidget, openChat, pollBody } from '../channels/testing.js';
import { randomPhone } from '../leads/testing.js';
import { feedOf } from '../workspace/testing.js';
import { systemActor } from '../worker/systemActor.js';

let h: ApiHarness;
let w: AccWorld;
let src: { sourceId: string; disclosureId: string };
let widget: { id: string; key: string };

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await accWorld(h);
  // the refused-reply cases leave leads uncontacted on purpose: keep the capacity cap (R-OWN-11) out of the routing
  await h.su.query('UPDATE tenant_settings SET uncontacted_capacity_cap = 50 WHERE tenant_id = $1', [w.tenantId]);
  src = await chatSource(h, w.owner, w.tenantId);
  widget = await createWidget(h, w.owner, src.sourceId);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

type Sent = { result: string; message: { id: string; status: string; statusReason: string | null } | null; decision: { reasons: string[] } | null };
const replyInChat = (c: TestClient, contactId: string, body: string) =>
  call<Sent>(c, 'POST', `/contacts/${contactId}/messages`, { channel: 'web_chat', body, idempotencyKey: `chat-${randomUUID()}` });

/** A website-chat lead (its only point is the chat identity), routed and accepted by the agent it was offered to. */
async function chatLead(name: string, o: { widgetKey?: string } = {}) {
  const c = await openChat(h, o.widgetKey ?? widget.key, src.disclosureId, { name });
  const owner = await acceptLead(h, w.agents, c.contactId);
  const st = await contactState(h, c.contactId);
  return { ...c, owner, periodSeq: Number(st.ownership_period_seq), ownedAt: st.owned_at as Date };
}

const firstTouches = async (contactId: string) =>
  (await h.su.query<{ reason_code: string; actor_user_id: string | null; payload: Record<string, unknown>; occurred_at: Date }>(
    `SELECT reason_code, actor_user_id, payload, occurred_at FROM lead_ownership_events WHERE contact_id = $1 AND type = 'first_touch_recorded' ORDER BY seq`,
    [contactId],
  )).rows;

const touchCols = async (contactId: string) =>
  (await h.su.query<{ first_touch_at: Date | null; last_human_touch_at: Date | null; ownership_state: string; owner_user_id: string | null }>(
    'SELECT first_touch_at, last_human_touch_at, ownership_state, owner_user_id FROM contacts WHERE id = $1',
    [contactId],
  )).rows[0]!;

const dispatchedAt = async (messageId: string) => (await h.su.query<{ dispatched_at: Date | null }>('SELECT dispatched_at FROM messages WHERE id = $1', [messageId])).rows[0]!.dispatched_at;
const types = async (contactId: string) => (await ledger(h, contactId)).map((e) => e.type);
const explanations = (evidence: unknown) => (evidence as { explanation: string }[]).map((e) => e.explanation);
const untouched = (contactId: string, seq: number) => `untouched:${contactId}:${seq}`;

/**
 * Clock fixture: the period's first-touch deadline and auto-release fall `dueMs` / `releaseMs` after `from`, null
 * keeping one as it is (stored deadlines: the contact columns, the period's ledger event and the pending timer jobs
 * move together, as setPeriodDeadlines does from now).
 */
async function deadlinesAfter(contactId: string, from: Date, dueMs: number | null, releaseMs: number | null): Promise<void> {
  const statements: { text: string; values: unknown[] }[] = [];
  if (dueMs !== null) {
    const due = new Date(from.getTime() + dueMs);
    statements.push(
      { text: 'UPDATE contacts SET first_touch_due_at = $2 WHERE id = $1', values: [contactId, due] },
      { text: 'UPDATE lead_ownership_events e SET deadline_at = $2 FROM contacts c WHERE c.id = $1 AND e.contact_id = c.id AND e.seq = c.ownership_period_seq', values: [contactId, due] },
      {
        text: `UPDATE jobs SET run_at = $2, payload = jsonb_set(payload, '{dueAt}', to_jsonb($3::bigint))
                WHERE kind = 'ownership.first_touch_breach' AND payload->>'contactId' = $1::text AND status = 'pending'`,
        values: [contactId, due, due.getTime()],
      },
    );
  }
  if (releaseMs !== null) {
    const rel = new Date(from.getTime() + releaseMs);
    statements.push(
      { text: 'UPDATE contacts SET release_due_at = $2 WHERE id = $1', values: [contactId, rel] },
      {
        text: `UPDATE lead_ownership_events e SET payload = jsonb_set(e.payload, '{releaseDueAt}', to_jsonb($2::bigint))
                 FROM contacts c WHERE c.id = $1 AND e.contact_id = c.id AND e.seq = c.ownership_period_seq`,
        values: [contactId, rel.getTime()],
      },
      {
        text: `UPDATE jobs SET run_at = $2, payload = jsonb_set(payload, '{dueAt}', to_jsonb($3::bigint))
                WHERE kind = 'ownership.auto_release' AND payload->>'contactId' = $1::text AND status = 'pending'`,
        values: [contactId, rel, rel.getTime()],
      },
    );
  }
  await suFixture(h, statements);
}

const dbNow = async () => (await h.su.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t;

describe('R-OWN-14 owner decision D8: a reply in the website chat is first contact', () => {
  it("R-OWN-14 R-ACC-1 R-ACC-2 E310: the owner's reply in the open chat is the first touch, written once at dispatch TX1: no breach, no untouched_lead item, speed-to-lead answered with its response time, no auto-release; the first-contact card leaves the feed", async () => {
    const lead = await chatLead('Cleo Chat');
    const agent = lead.owner;
    // before the reply: the pinned first-contact card leads with Reply in the chat and says when the lead goes back to the pond
    const card = (await feedOf(agent)).pinned.find((c) => c.itemType === 'first_touch_due' && c.contact?.id === lead.contactId);
    expect(card?.primaryAction.kind).toBe('reply_chat');
    expect(card?.reasons.map((r) => r.code)).toContain('RELEASE_SOON');

    const r = await replyInChat(agent, lead.contactId, 'Hi Cleo, yes, it is still available. When would you like to see it?');
    expect([r.status, r.body.result], JSON.stringify(r.body)).toEqual([200, 'sent']);
    const messageId = r.body.message!.id;
    const at = (await dispatchedAt(messageId))!;
    // one first_touch_recorded, by the agent, at the TX1 instant (the message's dispatched_at), the same instant on the contact
    expect((await firstTouches(lead.contactId)).map((e) => [e.reason_code, e.actor_user_id, e.payload.via, e.payload.refId, e.payload.afterBreach, e.occurred_at.getTime()])).toEqual([
      ['FIRST_TOUCH_CHAT', agent.userId, 'chat', messageId, false, at.getTime()],
    ]);
    expect(await touchCols(lead.contactId)).toEqual({ first_touch_at: at, last_human_touch_at: at, ownership_state: 'owned', owner_user_id: agent.userId });
    // nothing on the feed threatens the pond any more: the first-contact card is gone
    const after = await feedOf(agent);
    expect(after.all.filter((c) => c.contact?.id === lead.contactId && (c.itemType === 'first_touch_due' || c.reasons.some((x) => x.code === 'RELEASE_SOON')))).toEqual([]);

    // a second reply is no second first touch; it is the latest human touch
    const r2 = await replyInChat(agent, lead.contactId, 'Saturday at 10 works for me too.');
    expect(r2.body.result).toBe('sent');
    expect(await firstTouches(lead.contactId)).toHaveLength(1);
    expect((await touchCols(lead.contactId)).last_human_touch_at).toEqual(await dispatchedAt(r2.body.message!.id));

    // the first-touch deadline and then the auto-release pass just after the reply (clock fixture); the real timer jobs run
    await deadlinesAfter(lead.contactId, at, 1, 2);
    await sleep(20);
    await leadsWorker(h).drain();
    expect(await h.su.query("SELECT kind, status FROM jobs WHERE payload->>'contactId' = $1 AND kind IN ('ownership.first_touch_breach', 'ownership.auto_release') AND status NOT IN ('cancelled', 'succeeded')", [lead.contactId]).then((x) => x.rows)).toEqual([]);
    // and a timer that still fires for the period (a late job, the sweeper) changes nothing: the period has its first touch
    const st = await contactState(h, lead.contactId);
    for (const [deadline, due] of [['first_touch_breach', st.first_touch_due_at], ['auto_release', st.release_due_at]] as const) {
      const fired = await applyOwnershipCommand(systemActor(w.tenantId as TenantId, 'timer'), lead.contactId as ContactId, { kind: 'timer', deadline, fence: { periodSeq: lead.periodSeq, dueAt: due!.getTime() as Instant } }, { commandId: randomUUID(), db: h.database });
      expect(fired.outcome, deadline).toMatchObject({ ok: true, events: [] });
    }
    const kinds = await types(lead.contactId);
    expect(kinds).not.toContain('first_touch_breached');
    expect(kinds).not.toContain('auto_released');
    expect(await touchCols(lead.contactId)).toMatchObject({ ownership_state: 'owned', owner_user_id: agent.userId });
    // no untouched_lead item for the period (R-ACC-1/2: derived from the ledger)
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(await itemRow(h, untouched(lead.contactId, lead.periodSeq))).toBeNull();
    // speed-to-lead: the period is answered in time, with its response time
    const periods = (await h.su.query<{ first_touch_at: Date | null; response_seconds: string | null; within_sla: boolean }>(
      'SELECT first_touch_at, response_seconds, within_sla FROM v_speed_to_lead WHERE contact_id = $1 ORDER BY owned_seq',
      [lead.contactId],
    )).rows;
    expect(periods.map((p) => [p.first_touch_at, p.within_sla])).toEqual([[at, true]]);
    expect(Math.abs(Number(periods[0]!.response_seconds) - (at.getTime() - lead.ownedAt.getTime()) / 1000)).toBeLessThanOrEqual(1);
  });

  it('R-OWN-14 E312: a chat reply the send refused is never a touch (the chat ended, the widget is not connected, the person asked not to be contacted), so the SLA runs on to breach and auto-release; only a reply the send allowed is a touch', async () => {
    // the visitor has been gone 30 minutes: the chat ended (E77)
    const ended = await chatLead('Ed Ended');
    await h.su.query("UPDATE webchat_sessions SET last_seen_at = now() - interval '31 minutes', started_at = now() - interval '40 minutes' WHERE id = $1", [ended.sessionId]);
    // the widget was disconnected (R-INBOX-7)
    const w2 = await createWidget(h, w.owner, src.sourceId);
    const off = await chatLead('Dee Disconnected', { widgetKey: w2.key });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/admin/integrations/connections/${w2.id}/disconnect`)).status).toBe(200);
    // the visitor asked not to be contacted, in the chat (E155: the person-level do-not-contact)
    const dnc = await chatLead('Nia Nope');
    expect((await chatMessage(h, dnc.token, { message: 'Please stop contacting me', clientMessageId: randomUUID() })).statusCode).toBe(200);
    // and a chat still open, for the reply the send allows
    const open = await chatLead('Oli Open');

    for (const [lead, code] of [[ended, 'CHANNEL_NOT_CONNECTED'], [off, 'CHANNEL_NOT_CONNECTED'], [dnc, 'PERSON_DO_NOT_CONTACT']] as const) {
      const r = await replyInChat(lead.owner, lead.contactId, 'Hi, are you still there?');
      expect([lead.contactId, r.status, r.body.result, r.body.message?.status], JSON.stringify(r.body)).toEqual([lead.contactId, 200, 'blocked', 'blocked']);
      expect(r.body.decision!.reasons).toContain(code);
      // the blocked-send evidence, and nothing delivered
      expect((await h.su.query('SELECT outcome FROM gate_decisions WHERE message_id = $1', [r.body.message!.id])).rows).toEqual([{ outcome: 'deny' }]);
      expect(h.providers.webChat.delivered.some((d) => d.messageId === r.body.message!.id)).toBe(false);
      expect(await firstTouches(lead.contactId)).toEqual([]);
      expect(await touchCols(lead.contactId)).toMatchObject({ first_touch_at: null, last_human_touch_at: null });
    }
    const ok = await replyInChat(open.owner, open.contactId, 'Hi Oli, thanks for writing in.');
    expect(ok.body.result).toBe('sent');
    expect((await firstTouches(open.contactId)).map((e) => [e.reason_code, e.payload.refId])).toEqual([['FIRST_TOUCH_CHAT', ok.body.message!.id]]);

    // the refused replies stopped nothing: at its deadline the real timer breaches each lead, and at the release it goes
    // back to the pond, as any untouched lead (two passes, so the breach is not raced by the release)
    for (const lead of [ended, off, dnc]) await setPeriodDeadlines(h, lead.contactId, -2_000, 86_400_000);
    await leadsWorker(h).drain();
    const now = await dbNow();
    for (const lead of [ended, off, dnc]) await deadlinesAfter(lead.contactId, now, null, -1_000);
    await leadsWorker(h).drain();
    for (const lead of [ended, off, dnc]) {
      expect((await ledger(h, lead.contactId)).slice(-2).map((e) => [e.type, e.reason_code])).toEqual([['first_touch_breached', 'FIRST_TOUCH_BREACHED'], ['auto_released', 'FIRST_TOUCH_MISSED']]);
      await recompute(h, w.tenantId, { contactId: lead.contactId });
      const item = await itemRow(h, untouched(lead.contactId, lead.periodSeq));
      expect([item?.owner_user_id, item?.condition_cleared_at]).toEqual([lead.owner.userId, null]);
      expect(explanations(item!.evidence)[0]).toBe('No human call, text, email or chat reply by the first-contact deadline; the lead later left this agent');
    }
  });

  it('R-OWN-14 E312: an allowed chat reply whose delivery then fails stays the first touch (its instant is TX1, as for a text) and raises failed_send', async () => {
    const lead = await chatLead('Fay Fail');
    h.providers.webChat.failNext('unavailable');
    const r = await replyInChat(lead.owner, lead.contactId, 'Hi Fay, here are the times that work.');
    expect([r.body.result, r.body.message?.status], JSON.stringify(r.body)).toEqual(['failed', 'failed']);
    const at = (await dispatchedAt(r.body.message!.id))!;
    expect(at).not.toBeNull();
    expect((await firstTouches(lead.contactId)).map((e) => [e.reason_code, e.payload.refId, e.occurred_at.getTime()])).toEqual([['FIRST_TOUCH_CHAT', r.body.message!.id, at.getTime()]]);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect((await h.su.query('SELECT item_type FROM exception_items WHERE dedupe_key = $1', [`send:${r.body.message!.id}`])).rows).toEqual([{ item_type: 'failed_send' }]);
  });

  it("R-OWN-14 E311: a collaborator's chat reply is a touch the way their text would be; a Team Lead who is neither owner nor collaborator may reply in the chat, but that is not the first touch", async () => {
    const lead = await chatLead('Cora Collab');
    const collaborator = w.agents.find((a) => a.userId !== lead.owner.userId)!;
    expect((await call(lead.owner, 'POST', `/contacts/${lead.contactId}/collaborators`, { userId: collaborator.userId, role: 'co_agent' })).status).toBe(200);
    // the Team Lead of the owner's team answers first: sent, not a touch (they neither own the lead nor collaborate on it)
    const tl = await replyInChat(w.teamLead!, lead.contactId, 'Hi Cora, I lead the team here; your agent will be right with you.');
    expect([tl.status, tl.body.result], JSON.stringify(tl.body)).toEqual([200, 'sent']);
    expect(await firstTouches(lead.contactId)).toEqual([]);
    expect(await touchCols(lead.contactId)).toMatchObject({ first_touch_at: null, last_human_touch_at: null });
    // the collaborator's reply is the first touch, by them
    const co = await replyInChat(collaborator, lead.contactId, 'Hi Cora, I work with your agent on this one.');
    expect([co.status, co.body.result], JSON.stringify(co.body)).toEqual([200, 'sent']);
    const at = (await dispatchedAt(co.body.message!.id))!;
    expect((await firstTouches(lead.contactId)).map((e) => [e.reason_code, e.actor_user_id, e.payload.refId, e.occurred_at.getTime()])).toEqual([['FIRST_TOUCH_CHAT', collaborator.userId, co.body.message!.id, at.getTime()]]);
  });

  it("R-ACC-2 R-OWN-20 E68 E310: rule version 3 holds with chat touches: a chat reply after a re-inquiry that started a new period is that period's first touch, never the earlier miss's late fix", async () => {
    const lead = await chatLead('Rory Return');
    const agent = lead.owner;
    await setPeriodDeadlines(h, lead.contactId, -60_000, 86_400_000); // missed, still the agent's
    // the agent added the phone the visitor gave; the lead goes quiet for more than 7 days (clock fixture), then inquires again
    const phone = randomPhone();
    expect((await call(agent, 'POST', `/contacts/${lead.contactId}/points`, { kind: 'phone', address: phone, label: 'mobile' })).status).toBe(201);
    await suFixture(h, [{ text: `UPDATE contacts SET owned_at = now() - interval '8 days', last_human_touch_at = now() - interval '8 days' WHERE id = $1`, values: [lead.contactId] }]);
    const again = await intake(h, w, { phones: [phone], fullName: 'Rory Return', inquiryType: 'sell' });
    expect([again.contactId, again.outcome]).toEqual([lead.contactId, 'reinquiry']);
    expect((await ledger(h, lead.contactId)).at(-1)).toMatchObject({ type: 'reinquiry', reason_code: 'REINQUIRY_SLA' });
    const newerSeq = Number((await contactState(h, lead.contactId)).ownership_period_seq);
    expect(newerSeq).toBeGreaterThan(lead.periodSeq);

    // the agent answers in the still-open chat: the newer period's first touch, in time
    const r = await replyInChat(agent, lead.contactId, 'Hi Rory, good to hear from you again.');
    expect(r.body.result).toBe('sent');
    const at = (await dispatchedAt(r.body.message!.id))!;
    const periods = (await h.su.query<{ seq: number; first_touch_at: Date | null; within_sla: boolean }>(
      'SELECT owned_seq::int AS seq, first_touch_at, within_sla FROM v_speed_to_lead WHERE contact_id = $1 ORDER BY owned_seq',
      [lead.contactId],
    )).rows;
    expect(periods).toEqual([
      { seq: lead.periodSeq, first_touch_at: null, within_sla: false },
      { seq: newerSeq, first_touch_at: at, within_sla: true },
    ]);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const earlier = await itemRow(h, untouched(lead.contactId, lead.periodSeq));
    expect(earlier?.condition_cleared_at).toBeNull();
    expect(explanations(earlier!.evidence)).toEqual(['No human call, text, email or chat reply by the first-contact deadline', 'Lead became theirs']);
    expect(await itemRow(h, untouched(lead.contactId, newerSeq))).toBeNull();
  });

  it("R-ACC-4 E310: the scoreboard's activity and speed numbers agree for a chat reply, live and from the daily rollup", async () => {
    interface Board {
      speedToLead: { medianSeconds: number | null; withinSla: number; total: number; responded: number; pending: number };
      touches: { count: number; calls: number; textsAndEmails: number; days: number };
    }
    const lead = await chatLead('Sam Score');
    const agent = lead.owner;
    const board = async () => (await call<{ scoreboard: Board }>(agent, 'GET', '/scoreboard?range=7d')).body.scoreboard;
    const before = await board();
    const r = await replyInChat(agent, lead.contactId, 'Hi Sam, thanks for writing in.');
    expect(r.body.result).toBe('sent');
    const after = await board();
    // the reply is one more touch, and the same reply answers the period: in time, no longer pending
    expect([after.touches.count - before.touches.count, after.touches.textsAndEmails - before.touches.textsAndEmails]).toEqual([1, 1]);
    expect([
      after.speedToLead.total - before.speedToLead.total,
      after.speedToLead.responded - before.speedToLead.responded,
      after.speedToLead.withinSla - before.speedToLead.withinSla,
      before.speedToLead.pending - after.speedToLead.pending,
    ]).toEqual([1, 1, 1, 1]);

    // the same numbers through the daily rollup: the lead's day moved two days back (clock fixture) and rolled
    await suFixture(h, [
      { text: `UPDATE lead_ownership_events SET occurred_at = occurred_at - interval '2 days', deadline_at = deadline_at - interval '2 days' WHERE contact_id = $1`, values: [lead.contactId] },
      { text: `UPDATE messages SET dispatched_at = dispatched_at - interval '2 days', occurred_at = occurred_at - interval '2 days', created_at = created_at - interval '2 days' WHERE contact_id = $1`, values: [lead.contactId] },
    ]);
    const sys = systemActor(w.tenantId as TenantId, 'worker');
    await withTenantTx(sys, (tx) => rollScoreboard(tx), { db: h.database });
    // the horizon is tested in scoreboard_rollup.test.ts: every closed day is safe here
    await h.su.query(
      `INSERT INTO scoreboard_rollup_state (tenant_id, zone, safe_until) SELECT tenant_id, default_timezone, clock_timestamp() FROM tenant_settings WHERE tenant_id = $1
       ON CONFLICT (tenant_id) DO UPDATE SET zone = EXCLUDED.zone, safe_until = EXCLUDED.safe_until, pending_at = NULL, pending_xid = NULL`,
      [w.tenantId],
    );
    for (let i = 0; i < 10; i++) if ((await withTenantTx(sys, (tx) => rollScoreboard(tx), { db: h.database })).pendingDays === 0) break;
    const day = (await h.su.query<{ day: string }>(
      `SELECT app.scoreboard_day_of(e.occurred_at, s.default_timezone)::text AS day FROM lead_ownership_events e JOIN tenant_settings s ON s.tenant_id = e.tenant_id
        WHERE e.contact_id = $1 AND e.seq = $2`,
      [lead.contactId, lead.periodSeq],
    )).rows[0]!.day;
    expect((await h.su.query('SELECT calls, texts_and_emails FROM scoreboard_activity_daily WHERE tenant_id = $1 AND user_id = $2 AND day = $3::date', [w.tenantId, agent.userId, day])).rows).toEqual([{ calls: 0, texts_and_emails: 1 }]);
    expect((await h.su.query('SELECT first_touch_at IS NOT NULL AND first_touch_at <= first_touch_due_at AS answered_in_time FROM scoreboard_speed_daily WHERE tenant_id = $1 AND user_id = $2 AND day = $3::date', [w.tenantId, agent.userId, day])).rows).toEqual([{ answered_in_time: true }]);
    const [viaRollup, live] = await withTenantTx(agent.actor(), async (tx, now) => [await scoreboardFor(tx, agent.userId!, '7d', now, 'rollup'), await scoreboardFor(tx, agent.userId!, '7d', now, 'live')], { db: h.database });
    expect(viaRollup).toEqual(live);
    expect(viaRollup.scoreboard).toMatchObject({ touches: after.touches, speedToLead: after.speedToLead });
  });

  it("R-OWN-14 R-AST-15 E311: the assistant's first response in the chat is never the first touch, even sent once the lead is owned; the agent's own chat reply after it is", async () => {
    // last in this file: an approved first response answers every new chat lead of the tenant from here on
    await freshReauth(h, w.owner);
    const firstReply = TEMPLATES.find((t) => t.key === 'new_lead_response')!.steps[0] as Record<string, unknown>;
    await approvedPlaybook(w.owner, { kind: 'new_lead_response', scope: 'team', name: 'Instant reply (chat)', steps: [{ ...firstReply, channel: 'inbound_channel' }] });
    const lead = await chatLead('Abe Assist');
    await runAssistantJobs(h, w.tenantId, ['assistant.first_response', 'comms.dispatch']);
    const p = await pollBody(h, lead.token);
    expect(p.messages.map((m) => m.from)).toEqual(['assistant']);
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND initiator = 'assistant' AND channel = 'web_chat' AND dispatched_at >= $2", [lead.contactId, lead.ownedAt])).rows[0].n).toBe(1);
    expect(await firstTouches(lead.contactId)).toEqual([]);
    expect(await touchCols(lead.contactId)).toMatchObject({ first_touch_at: null, last_human_touch_at: null });
    // the agent answers in the chat: that is the first touch
    const r = await replyInChat(lead.owner, lead.contactId, 'Hi Abe, this is your agent. Happy to help.');
    expect(r.body.result).toBe('sent');
    const at = (await dispatchedAt(r.body.message!.id))!;
    expect((await firstTouches(lead.contactId)).map((e) => [e.reason_code, e.actor_user_id, e.payload.refId, e.occurred_at.getTime()])).toEqual([['FIRST_TOUCH_CHAT', lead.owner.userId, r.body.message!.id, at.getTime()]]);
  });
});
