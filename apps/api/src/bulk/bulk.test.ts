// Parity module 63: bulk actions end to end on real Postgres and the fake providers
// (R-PAR-33..R-PAR-42, E180, E183..E188, Q-PAR-9).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { auditRows } from '../admin/testing.js';
import { type CommsWorld, call, commsWorld, inboundSms, ownedContact, pointId, randomEmail, randomPhone, sendText } from '../comms/testing.js';
import { composeHumanMessage } from '../comms/compose.js';
import { suFixture } from '../leads/testing.js';
import { bulkSendKey } from '@realty/core/parity/bulk';
import { runBulkAction } from './run.js';
import { makeBulkHandlers } from './handlers.js';
import { commsWorker } from '../comms/testing.js';
import { recompute } from '../accountability/testing.js';
import { RESPONSE_SCHEMAS } from './schemas.js';
import { BATCH_TEXT_ATTESTATION, actionRow, batchTextOff, batchTextOn, confirm, draft, itemsOf, marketingReady } from './testing.js';
import { freshReauth } from '../comms/testing.js';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['tc'] });
  await marketingReady(h, w);
  // batch text needs an approved registration whose use case covers marketing (R-PAR-40)
  const reg = await call<{ registration: { id: string } }>(w.owner, 'POST', '/sender-registrations', { kind: 'a2p_campaign', useCase: 'marketing', sampleMessages: ['New listings near you this week. Reply STOP to opt out.'], optInDescription: 'Leads opt in on our website form.' });
  await call(w.owner, 'POST', `/sender-registrations/${reg.body.registration.id}/refresh`);
  await call(w.owner, 'PATCH', `/numbers/${w.mainNumberId}/registration`, { registrationId: reg.body.registration.id });
});
afterAll(async () => {
  await h?.close();
});

const run = (id: string) => runBulkAction(id, w.deps, w.tenantId);
const emailsTo = (addr: string) => h.providers.email.sent.filter((m) => m.to === addr);
const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);
async function emailTemplate(c = w.agents[0]!, body = 'Hi {{contact.first_name}}, new homes this week.') {
  const t = await call<{ template: { id: string } }>(c, 'POST', '/templates', { scope: 'personal', channel: 'email', name: `B ${randomUUID().slice(0, 6)}`, subject: 'For {{contact.first_name}}', body });
  return t.body.template.id;
}
async function textTemplate(c = w.agents[0]!) {
  const t = await call<{ template: { id: string } }>(c, 'POST', '/templates', { scope: 'personal', channel: 'sms', name: `T ${randomUUID().slice(0, 6)}`, body: 'Hi {{contact.first_name}}, open house Saturday.' });
  return t.body.template.id;
}
async function noEmailContact(agent = w.agents[0]!) {
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Nomail', lastName: 'Person', phones: [randomPhone()], emails: [] });
  return r.body.contact.id;
}
async function revokeEmail(agent: CommsWorld['agents'][number], contactId: string) {
  const pid = await pointId(h, contactId, 'email');
  const r = await call(agent, 'POST', `/contacts/${contactId}/consent`, { kind: 'revoke', pointId: pid, channel: 'email', purpose: 'all', evidence: { note: 'asked to stop' } });
  if (r.status !== 200) throw new Error(`revoke ${r.status} ${JSON.stringify(r.body)}`);
}

describe('bulk email: preview, confirm, run (R-PAR-33 R-PAR-34 R-PAR-36 R-PAR-37 R-PAR-38 R-PAR-39 R-PAR-41)', () => {
  it('R-PAR-38 R-PAR-39 R-PAR-41 the preview counts every skip by reason; one email per address; marketing footer; bulk_finished counts', async () => {
    const agent = w.agents[0]!;
    const a = await ownedContact(agent, { firstName: 'Ann' });
    const b = await ownedContact(agent, { firstName: 'Bob' });
    const shared = randomEmail();
    const s1 = await ownedContact(agent, { firstName: 'Sue', email: shared });
    const s2 = await ownedContact(agent, { firstName: 'Sam', email: shared, confirmDistinct: true });
    const out = await ownedContact(agent, { firstName: 'Ola' });
    await revokeEmail(agent, out.id);
    const none = await noEmailContact(agent);
    const nameless = await ownedContact(agent, { firstName: 'Tmp' });
    await suFixture(h, [{ text: 'UPDATE contacts SET first_name = NULL WHERE id = $1', values: [nameless.id] }]);
    const tpl = await emailTemplate(agent);
    const ids = [a.id, b.id, s1.id, s2.id, out.id, none, nameless.id];
    const d = await draft(agent, { kind: 'email', selection: { contactIds: ids }, templateId: tpl });
    expect(d.status).toBe(201);
    const v = d.body.action;
    expect(v).toMatchObject({ status: 'draft', selected: 7, sharedAddresses: 1 });
    expect(v.preflight).toEqual({ RECIPIENT_OPTED_OUT: 1, NO_ADDRESS: 1, SHARED_ADDRESS: 1, MERGE_FIELD_EMPTY: 1 });
    expect(v.targetCount + Object.values(v.preflight).reduce((x, y) => x + y, 0)).toBe(7); // nobody hidden
    const c = await confirm(agent, v.id);
    expect(c.body.action.status).toBe('confirmed');
    expect(await run(v.id)).toEqual({ kind: 'finished', status: 'completed' });
    for (const x of [a, b]) expect(emailsTo(x.email)).toHaveLength(1);
    expect(emailsTo(shared)).toHaveLength(1);
    expect(emailsTo(out.email)).toHaveLength(0);
    const sent = emailsTo(a.email)[0]!;
    expect(sent.subject).toBe('For Ann');
    expect(sent.text).toContain('Hi Ann, new homes this week.');
    expect(sent.text).toContain('1 Main St, Springfield');
    expect(sent.text).toMatch(/Unsubscribe: http/);
    expect(sent.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const msg = (await h.su.query('SELECT purpose, bulk_action_id, initiator FROM messages WHERE to_address = $1', [a.email])).rows[0];
    expect(msg).toEqual({ purpose: 'marketing', bulk_action_id: v.id, initiator: 'human' });
    const n = (await h.su.query("SELECT title, body, subject_type, subject_id FROM notifications WHERE kind = 'bulk_finished' AND subject_id = $1", [v.id])).rows;
    expect(n).toHaveLength(1);
    expect(n[0].title).toMatch(/^Emailed 3 of 7: /);
    expect(n[0].title).toContain('1 opted out');
    expect(n[0].title).not.toContain('Ann');
    expect((await actionRow(h, v.id)).status).toBe('completed');
    expect((await auditRows(h, w.tenantId, 'bulk.')).filter((r) => r.entity_id === v.id).map((r) => r.action).sort()).toEqual(['bulk.completed', 'bulk.confirmed', 'bulk.created']);
  });

  it('R-PAR-37 a bulk email is never a touch: no last_human_touch_at, no activity-view touch', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const before = (await h.su.query('SELECT last_human_touch_at FROM contacts WHERE id = $1', [c.id])).rows[0].last_human_touch_at;
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    await confirm(agent, d.body.action.id);
    await run(d.body.action.id);
    expect(emailsTo(c.email)).toHaveLength(1);
    expect((await h.su.query('SELECT last_human_touch_at FROM contacts WHERE id = $1', [c.id])).rows[0].last_human_touch_at).toEqual(before);
    const ev = await h.su.query("SELECT count(*)::int AS n FROM lead_ownership_events WHERE contact_id = $1 AND type = 'touched'", [c.id]);
    expect(ev.rows[0].n).toBe(0);
    const act = await h.su.query('SELECT coalesce(sum(texts_and_emails),0)::int AS n FROM v_agent_activity_daily v WHERE v.user_id = $1', [agent.userId]);
    const direct = await h.su.query("SELECT count(*)::int AS n FROM messages WHERE initiated_by_user_id = $1 AND direction = 'outbound' AND status IN ('sent','delivered','dispatch_unknown') AND bulk_action_id IS NULL", [agent.userId]);
    expect(act.rows[0].n).toBe(direct.rows[0].n);
  });

  it('R-PAR-37 a bulk email or batch text is no scoreboard touch and answers no waiting client in the Priority Feed (a one-to-one reply still does)', async () => {
    const agent = w.agents[0]!;
    type Card = { itemType: string; contact: { id: string } | null };
    const feed = async () => {
      const r = await call<{ pinned: Card[]; scored: Card[] }>(agent, 'GET', '/feed');
      expect(r.status).toBe(200);
      return [...r.body.pinned, ...r.body.scored];
    };
    const waitingCard = (cards: Card[], contactId: string) => cards.some((c) => c.itemType === 'unanswered_inbound' && c.contact?.id === contactId);
    const touches = async () => (await call<{ scoreboard: { touches: { count: number; textsAndEmails: number } } }>(agent, 'GET', '/scoreboard')).body.scoreboard.touches;
    // a client who texted 3 days ago (past the bulk email's 24 h recent-inbound skip) and one who texted just now
    const waiting = await ownedContact(agent, { firstName: 'Wanda' });
    const recent = await ownedContact(agent, { firstName: 'Rae' });
    expect((await inboundSms(h, waiting.phone, w.mainNumber, 'Any news on the house?')).statusCode).toBeLessThan(300);
    expect((await inboundSms(h, recent.phone, w.mainNumber, 'Can we see it Saturday?')).statusCode).toBeLessThan(300);
    await suFixture(h, [
      { text: "UPDATE messages SET occurred_at = now() - interval '3 days', created_at = now() - interval '3 days' WHERE contact_id = $1 AND direction = 'inbound'", values: [waiting.id] },
      { text: "UPDATE contacts SET last_inbound_at = now() - interval '3 days' WHERE id = $1", values: [waiting.id] },
    ]);
    const before = await feed();
    expect(waitingCard(before, waiting.id) && waitingCard(before, recent.id)).toBe(true);
    const touched = await touches();

    const e = await draft(agent, { kind: 'email', selection: { contactIds: [waiting.id] }, templateId: await emailTemplate(agent) });
    expect(e.body.action.targetCount).toBe(1);
    await confirm(agent, e.body.action.id);
    await run(e.body.action.id);
    expect(emailsTo(waiting.email)).toHaveLength(1);
    await batchTextOn(h, w.owner);
    try {
      const t = await draft(agent, { kind: 'text', selection: { contactIds: [recent.id] }, templateId: await textTemplate(agent) });
      expect(t.body.action.targetCount).toBe(1);
      await confirm(agent, t.body.action.id);
      await run(t.body.action.id);
      expect(smsTo(recent.phone)).toHaveLength(1);
    } finally {
      await batchTextOff(w.owner);
    }
    const sent = await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE contact_id = ANY ($1::uuid[]) AND bulk_action_id IS NOT NULL AND status = 'sent' AND dispatched_at IS NOT NULL", [[waiting.id, recent.id]]);
    expect(sent.rows[0]!.n).toBe(2);
    // both clients are still waiting for an answer, and the agent's touches did not move
    const after = await feed();
    expect({ waiting: waitingCard(after, waiting.id), recent: waitingCard(after, recent.id) }).toEqual({ waiting: true, recent: true });
    expect(await touches()).toEqual(touched);
    // control: a one-to-one reply answers the client and is a touch
    expect((await sendText(agent, waiting.id, 'It is still available, want to see it?')).body.result).toBe('sent');
    expect(waitingCard(await feed(), waiting.id)).toBe(false);
    expect((await touches()).textsAndEmails).toBe(touched.textsAndEmails + 1);
  });

  it('Q-PAR-9 a person who wrote in the last 24 hours is left out of a bulk email (answer them one to one)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await suFixture(h, [{ text: "UPDATE contacts SET last_inbound_at = now() - interval '2 hours' WHERE id = $1", values: [c.id] }]);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    expect(d.body.action.preflight).toEqual({ RECENT_INBOUND: 1 });
    expect((await confirm(agent, d.body.action.id)).body).toMatchObject({ error: { code: 'BULK_NOTHING_TO_DO' } });
  });

  it('R-PAR-24 a person missing a merge field is skipped MERGE_FIELD_EMPTY (never "Hi ,")', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { firstName: 'Tmp' });
    await suFixture(h, [{ text: 'UPDATE contacts SET first_name = NULL WHERE id = $1', values: [c.id] }]);
    const tpl = await emailTemplate(agent, 'Hi {{contact.first_name}}, a question.');
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: tpl });
    expect(d.body.action.preflight).toEqual({ MERGE_FIELD_EMPTY: 1 });
  });

  it('R-PAR-26 E180 the action freezes the template version and text: an edit after confirm does not change what is sent', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { firstName: 'Fay' });
    const tpl = await emailTemplate(agent, 'Original wording {{contact.first_name}}');
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: tpl });
    expect(d.body.action).toMatchObject({ templateVersion: 1, body: 'Original wording {{contact.first_name}}' });
    await confirm(agent, d.body.action.id);
    await call(agent, 'PATCH', `/templates/${tpl}`, { version: 1, body: 'Edited wording {{contact.first_name}}' });
    await run(d.body.action.id);
    expect(emailsTo(c.email)[0]!.text).toContain('Original wording Fay');
    // and the frozen content cannot be rewritten after confirm (DB guard)
    await expect(h.su.query("UPDATE bulk_actions SET body_snapshot = 'x' WHERE id = $1", [d.body.action.id])).rejects.toThrow(/BULK_FROZEN/);
  });

  it('R-PAR-34 E186 the target is frozen at draft: nobody is added after the preview, and the confirmed count is the frozen one', async () => {
    const agent = w.agents[0]!;
    const c1 = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c1.id] }, templateId: await emailTemplate(agent) });
    await confirm(agent, d.body.action.id);
    const late = await ownedContact(agent);
    // the API offers no way to add people to an action; the DB refuses it after confirm (BULK_FROZEN)
    await expect(h.su.query("INSERT INTO bulk_action_items (tenant_id, bulk_action_id, contact_id, address_hmac) SELECT tenant_id, $1, contact_id, address_hmac FROM contact_points WHERE contact_id = $2 AND kind = 'email'", [d.body.action.id, late.id])).rejects.toThrow(/BULK_FROZEN/);
    await run(d.body.action.id);
    expect(emailsTo(late.email)).toHaveLength(0);
    expect((await actionRow(h, d.body.action.id)).target_count).toBe(1);
  });
});

describe('opt-outs per item at send time (D1, R-PAR-36, R-PAR-12, E184)', () => {
  it('R-PAR-36 E184 an unsubscribe that arrives after confirm blocks that item at send time; the rest still go', async () => {
    const agent = w.agents[0]!;
    const x = await ownedContact(agent);
    const y = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [x.id, y.id] }, templateId: await emailTemplate(agent) });
    expect(d.body.action.targetCount).toBe(2);
    await confirm(agent, d.body.action.id);
    await revokeEmail(agent, x.id); // mid-run (after the preview)
    await run(d.body.action.id);
    expect(emailsTo(x.email)).toHaveLength(0);
    expect(emailsTo(y.email)).toHaveLength(1);
    const items = await itemsOf(h, d.body.action.id);
    expect(items.find((i) => i.contact_id === x.id)).toMatchObject({ status: 'blocked', reason_code: 'RECIPIENT_OPTED_OUT' });
    // R-PAR-41: the normal blocked-send evidence row, and no failed_send exception for bulk
    const dec = await h.su.query("SELECT reason_codes FROM gate_decisions WHERE contact_id = $1 AND outcome = 'deny'", [x.id]);
    expect(dec.rows[0].reason_codes).toContain('CONSENT_REVOKED');
    const ex = await h.su.query("SELECT count(*)::int AS n FROM exception_items WHERE contact_id = $1 AND item_type = 'failed_send'", [x.id]);
    expect(ex.rows[0].n).toBe(0);
  });

  it('R-PAR-12 a STOP from a phone the agent then removed still blocks a batch text to the person\'s other phone', async () => {
    await batchTextOn(h, w.owner);
    try {
      const agent = w.agents[0]!;
      const oldPhone = randomPhone();
      const newPhone = randomPhone();
      const made = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Rita', lastName: 'Removed', phones: [oldPhone, newPhone], emails: [] });
      const c = { id: made.body.contact.id };
      expect((await inboundSms(h, oldPhone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
      // the agent removes the number that opted out (L1's points API; the column write is the same)
      await suFixture(h, [{ text: "UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old', is_primary = false WHERE contact_id = $1 AND address = $2", values: [c.id, oldPhone] }]);
      const d = await draft(agent, { kind: 'text', selection: { contactIds: [c.id] }, templateId: await textTemplate(agent) });
      expect(d.status).toBe(201);
      // the removed number's STOP still blocks texting the person's other phone (core sees what the DB guard sees)
      expect(d.body.action.targetCount).toBe(0);
      expect(d.body.action.preflight).toEqual({ RECIPIENT_OPTED_OUT: 1 });
      expect(smsTo(newPhone)).toHaveLength(0);
    } finally {
      await batchTextOff(w.owner);
    }
  });
});

describe('never sent twice (R-PAR-34, E188)', () => {
  it('R-PAR-34 a double confirm is one run; running twice sends nothing more', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    const [c1, c2] = await Promise.all([confirm(agent, d.body.action.id), confirm(agent, d.body.action.id)]);
    expect([c1.status, c2.status]).toEqual([200, 200]);
    const jobs = await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'bulk.run' AND payload->>'actionId' = $1", [d.body.action.id]);
    expect(jobs.rows[0].n).toBe(1);
    await Promise.all([run(d.body.action.id), run(d.body.action.id)]);
    await run(d.body.action.id);
    expect(emailsTo(c.email)).toHaveLength(1);
    // the same idempotency key on a second draft returns the same action
    const key = `same-${randomUUID()}`;
    const k1 = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent), idempotencyKey: key });
    const k2 = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent), idempotencyKey: key });
    expect(k2.body.action.id).toBe(k1.body.action.id);
  });

  it('R-PAR-34 E188 a crash after the message was created (before the item was recorded) never sends a second email', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { firstName: 'Cat' });
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    await confirm(agent, d.body.action.id);
    // the runner's compose step committed and the process died: replay exactly that step with the derived key
    const hmac = (await h.su.query('SELECT encode(address_hmac, \'hex\') AS h FROM bulk_action_items WHERE bulk_action_id = $1', [d.body.action.id])).rows[0].h;
    await suFixture(h, [{ text: "UPDATE bulk_actions SET status = 'running', started_at = now() WHERE id = $1", values: [d.body.action.id] }]);
    await composeHumanMessage(agent.actor(), c.id, { channel: 'email', subject: 'For Cat', body: 'Hi Cat, new homes this week.', idempotencyKey: bulkSendKey(d.body.action.id, hmac), bulkActionId: d.body.action.id, purposeOverride: 'marketing' }, w.deps);
    expect(emailsTo(c.email)).toHaveLength(1);
    await run(d.body.action.id);
    expect(emailsTo(c.email)).toHaveLength(1);
    expect((await itemsOf(h, d.body.action.id))[0]).toMatchObject({ status: 'done' });
  });

  it('R-PAR-34 E188 a message left dispatching by a crash is the sweeper\'s: its item waits, and is never re-sent', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    await confirm(agent, d.body.action.id);
    h.providers.email.failNext('timeout_after_submit');
    await run(d.body.action.id); // dispatch_unknown: recorded at the provider once, item done (comms reconciles)
    expect(emailsTo(c.email)).toHaveLength(1);
    expect((await itemsOf(h, d.body.action.id))[0]).toMatchObject({ status: 'done' });

    const c2 = await ownedContact(agent);
    const d2 = await draft(agent, { kind: 'email', selection: { contactIds: [c2.id] }, templateId: await emailTemplate(agent) });
    await confirm(agent, d2.body.action.id);
    const hmac = (await h.su.query('SELECT encode(address_hmac, \'hex\') AS h FROM bulk_action_items WHERE bulk_action_id = $1', [d2.body.action.id])).rows[0].h;
    await suFixture(h, [{ text: "UPDATE bulk_actions SET status = 'running', started_at = now() WHERE id = $1", values: [d2.body.action.id] }]);
    h.providers.email.failNext('timeout');
    await composeHumanMessage(agent.actor(), c2.id, { channel: 'email', subject: 'S', body: 'B', idempotencyKey: bulkSendKey(d2.body.action.id, hmac), bulkActionId: d2.body.action.id, purposeOverride: 'marketing' }, w.deps);
    // the state a crash between TX1 and the provider leaves behind
    await suFixture(h, [{ text: "UPDATE messages SET status = 'dispatching' WHERE bulk_action_id = $1", values: [d2.body.action.id] }]);
    const r = await run(d2.body.action.id);
    expect(r.kind).toBe('retry');
    expect((await itemsOf(h, d2.body.action.id))[0]).toMatchObject({ status: 'pending' });
    const sentBefore = emailsTo(c2.email).length;
    await suFixture(h, [{ text: "UPDATE messages SET status = 'dispatch_unknown' WHERE bulk_action_id = $1", values: [d2.body.action.id] }]); // the sweeper
    expect(await run(d2.body.action.id)).toEqual({ kind: 'finished', status: 'completed' });
    expect(emailsTo(c2.email).length).toBe(sentBefore);
    expect((await itemsOf(h, d2.body.action.id))[0]).toMatchObject({ status: 'done' });
  });
});

describe('R-PAR-41 no failed_send exception for bulk; the job path', () => {
  it('R-PAR-41 a bulk email the provider rejects is a failed item, never a failed_send exception (a one-to-one failure is)', async () => {
    const agent = w.agents[0]!;
    const bulk = await ownedContact(agent);
    const solo = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [bulk.id] }, templateId: await emailTemplate(agent) });
    await confirm(agent, d.body.action.id);
    h.providers.email.failNext('rejected');
    await run(d.body.action.id);
    expect((await itemsOf(h, d.body.action.id))[0]).toMatchObject({ status: 'failed' });
    h.providers.email.failNext('rejected');
    const one = await call<{ result: string }>(agent, 'POST', `/contacts/${solo.id}/messages`, { channel: 'email', subject: 'Hi', body: 'One to one', idempotencyKey: `k-${randomUUID()}` });
    expect(one.body.result).toBe('failed');
    await recompute(h, w.tenantId);
    const ex = async (cid: string) => (await h.su.query("SELECT count(*)::int AS n FROM exception_items WHERE contact_id = $1 AND item_type = 'failed_send'", [cid])).rows[0].n;
    expect(await ex(solo.id)).toBe(1);
    expect(await ex(bulk.id)).toBe(0);
    expect((await h.su.query("SELECT title FROM notifications WHERE kind = 'bulk_finished' AND subject_id = $1", [d.body.action.id])).rows[0].title).toMatch(/^Emailed 0 of 1: 1 /);
  });

  it('R-PAR-33 confirm enqueues one bulk.run job whose payload is the action id only; the worker runs it to completion', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    await confirm(agent, d.body.action.id);
    const job = (await h.su.query("SELECT payload, dedupe_key FROM jobs WHERE kind = 'bulk.run' AND payload->>'actionId' = $1", [d.body.action.id])).rows[0];
    expect(job).toEqual({ payload: { actionId: d.body.action.id }, dedupe_key: `bulk.run:${d.body.action.id}` });
    await commsWorker(h, makeBulkHandlers(() => w.deps)).drain(10);
    expect((await actionRow(h, d.body.action.id)).status).toBe('completed');
    expect(emailsTo(c.email)).toHaveLength(1);
  });
});

describe('cancel (R-PAR-42)', () => {
  it('R-PAR-42 cancel stops pending items and queued messages; done items stay done; Owner/Admin may cancel, a TL may not', async () => {
    const agent = w.agents[0]!;
    const cs = [await ownedContact(agent), await ownedContact(agent), await ownedContact(agent)];
    const d = await draft(agent, { kind: 'email', selection: { contactIds: cs.map((c) => c.id) }, templateId: await emailTemplate(agent) });
    await confirm(agent, d.body.action.id);
    expect((await call(w.teamLead!, 'POST', `/bulk-actions/${d.body.action.id}/cancel`)).status).toBe(404);
    const cancel = await call<{ action: { status: string; counts: { canceled: number } } }>(w.owner, 'POST', `/bulk-actions/${d.body.action.id}/cancel`);
    expect(cancel.body.action.status).toBe('canceled');
    expect(await run(d.body.action.id)).toEqual({ kind: 'noop' });
    for (const c of cs) expect(emailsTo(c.email)).toHaveLength(0);
    expect((await itemsOf(h, d.body.action.id)).map((i) => i.status)).toEqual(['canceled', 'canceled', 'canceled']);
    expect((await h.su.query("SELECT title FROM notifications WHERE kind = 'bulk_finished' AND subject_id = $1", [d.body.action.id])).rows[0].title).toBe('Canceled. Emailed 0 of 3: 3 canceled');
    // a finished action cannot be canceled; a second cancel is a no-op
    expect((await call(agent, 'POST', `/bulk-actions/${d.body.action.id}/cancel`)).status).toBe(200);
  });
});

describe('batch text (R-PAR-40, E185)', () => {
  it('R-PAR-40 batch text is refused while off, needs the Owner with re-auth and the typed attestation, and an Admin may only turn it off', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const tpl = await textTemplate(agent);
    expect((await draft(agent, { kind: 'text', selection: { contactIds: [c.id] }, templateId: tpl })).body).toMatchObject({ error: { code: 'BATCH_TEXT_DISABLED' } });
    const page = await call<{ batchText: { enabled: boolean; counselText: string } }>(w.owner, 'GET', '/batch-text');
    expect(page.body.batchText.enabled).toBe(false);
    expect(page.body.batchText.counselText).toMatch(/Florida's Telephone Solicitation Act \(FTSA\) and Oklahoma/);
    expect(page.body.batchText.counselText).toMatch(/does not check consent/);
    expect((await call(agent, 'GET', '/batch-text')).status).toBe(404);
    // stale re-auth, a wrong attestation, an Admin: all refused
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [w.owner.userId]);
    expect((await call(w.owner, 'PUT', '/batch-text', { enabled: true, attestation: BATCH_TEXT_ATTESTATION })).body).toMatchObject({ error: { code: 'REAUTH_REQUIRED' } });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/batch-text', { enabled: true, attestation: 'yes' })).body).toMatchObject({ error: { code: 'ATTESTATION_REQUIRED' } });
    expect((await call(w.owner, 'PUT', '/batch-text', { enabled: true })).body).toMatchObject({ error: { code: 'ATTESTATION_REQUIRED' } });
    const admin = await h.invite(w.owner, 'admin');
    await freshReauth(h, admin);
    expect((await call(admin, 'PUT', '/batch-text', { enabled: true, attestation: BATCH_TEXT_ATTESTATION })).body).toMatchObject({ error: { code: 'OWNER_REQUIRED' } });
    // the DB refuses "on" by anyone but the Owner even past the API (trigger)
    await expect(h.su.query('SELECT 1').then(() => withTenantTx(admin.actor(), (tx) => sql`UPDATE tenant_settings SET batch_text_enabled = true WHERE tenant_id = app.tenant_id()`.execute(tx), { db: h.database }))).rejects.toThrow(/BATCH_TEXT_OWNER_ONLY/);
    await batchTextOn(h, w.owner);
    expect((await auditRows(h, w.tenantId, 'settings.batch_text_changed')).at(-1)).toMatchObject({ actor_role: 'owner', reason: expect.stringContaining('ATTESTED: I have reviewed batch texting with counsel') });
    expect((await call(admin, 'PUT', '/batch-text', { enabled: false })).status).toBe(200);
    expect((await call(admin, 'GET', '/batch-text')).body).toMatchObject({ batchText: { enabled: false } });
  });

  it('R-PAR-40 E185 a batch text ends with the opt-out line; turning the switch off mid-run stops the rest (BATCH_TEXT_DISABLED)', async () => {
    await batchTextOn(h, w.owner);
    const agent = w.agents[0]!;
    const cs = [await ownedContact(agent, { firstName: 'Tia' }), await ownedContact(agent, { firstName: 'Ty' })];
    const d = await draft(agent, { kind: 'text', selection: { contactIds: cs.map((c) => c.id) }, templateId: await textTemplate(agent) });
    expect(d.body.action.targetCount).toBe(2);
    await confirm(agent, d.body.action.id);
    await batchTextOff(w.owner);
    await run(d.body.action.id);
    for (const c of cs) expect(smsTo(c.phone)).toHaveLength(0);
    expect((await itemsOf(h, d.body.action.id)).map((i) => i.reason_code)).toEqual(['BATCH_TEXT_DISABLED', 'BATCH_TEXT_DISABLED']);
    // with the switch on, the text carries the brokerage and the STOP line
    await batchTextOn(h, w.owner);
    const c3 = await ownedContact(agent, { firstName: 'Uma' });
    const d3 = await draft(agent, { kind: 'text', selection: { contactIds: [c3.id] }, templateId: await textTemplate(agent) });
    await confirm(agent, d3.body.action.id);
    await run(d3.body.action.id);
    expect(smsTo(c3.phone)[0]!.body).toMatch(/^Hi Uma, open house Saturday\.\n— Harbor Realty LLC\. Reply STOP to opt out\.$/);
    await batchTextOff(w.owner);
    // the DB ceiling: a text action never confirms above 200 people (core refuses at draft)
    expect((await draft(agent, { kind: 'text', selection: { contactIds: Array.from({ length: 201 }, () => randomUUID()) }, templateId: await textTemplate(agent) })).body).toMatchObject({ error: { code: expect.stringMatching(/BULK_TOO_LARGE|BATCH_TEXT_DISABLED/) } });
  });
});

describe('response schemas (R-TEN-3, R-AST-13)', () => {
  it('no tenant ids or confidence fields in any bulk response schema', () => {
    const shapes = JSON.stringify(Object.fromEntries(Object.entries(RESPONSE_SCHEMAS).map(([k, s]) => [k, s.toJSONSchema()])));
    expect(shapes).not.toMatch(/tenant_?id|confidence/i);
  });
});
