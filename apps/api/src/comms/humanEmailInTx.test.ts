// createHumanEmailInTx (module 22's one flagged export for module 71's CMA share; ARCHITECTURE §9 path 1, D1, R-GATE-14):
// the compose box's immediate human email, created in the caller's transaction. Parity with composeHumanMessage's row,
// the two stated differences (the dispatch job in the same transaction; no stored decision without a sender), the
// idempotent replay, and the RLS refusals. Fakes only: the fake email provider, nothing real is sent.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { AppError } from '../errors.js';
import { createHumanEmailInTx, depsFromPlatform, dispatchOutbound } from './index.js';
import { type CommsWorld, call, commsWorld, ownedContact, pointId } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  h.providers.email.verifiedDomains.add('mail.example.test');
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.example.test' });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  await call(w.owner, 'POST', '/email-identities', { fromAddress: `agent-${randomUUID().slice(0, 6)}@mail.example.test`, displayName: 'Agent A', userId: w.agents[0]!.userId, domainId: dom.body.domain.id });
  const { suFixture } = await import('../leads/testing.js');
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const deps = () => depsFromPlatform(h.app.platform);
const create = (actor: UserActor, spec: { contactId: string; toPointId: string; subject?: string; body?: string; idempotencyKey?: string }) =>
  withTenantTx(actor, (tx, now) => createHumanEmailInTx(tx, deps(), actor, { subject: 'Home value estimate', body: 'The report body.', idempotencyKey: randomUUID(), ...spec }, now), { db: h.app.platform.db });

const COLS = `channel, contact_id, conversation_id, email_identity_id, from_address, to_address, subject, body, initiator, initiated_by_user_id, purpose,
  action_category, assistant_action_id, playbook_step_run_id, pinned_inbound_seq, scheduled_for, bulk_action_id, integration_connection_id, marketing_piece_id, direction, idempotency_key`;
const row = async (id: string) => (await h.su.query(`SELECT ${COLS}, status, gate_decision_id FROM messages WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
const jobs = async (id: string) => Number((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'comms.dispatch' AND payload ->> 'messageId' = $1", [id])).rows[0].n);
/** the unsubscribe link carries the message's own id: compared with it masked */
const masked = (b: unknown) => String(b).replace(/https?:\/\/\S+/g, '<link>');

describe('createHumanEmailInTx (module 22 flagged export; ARCHITECTURE §9 path 1)', () => {
  it('R-GATE-14 D1: the row equals composeHumanMessage\'s email row (but the key), it is queued with its comms.dispatch job in the same transaction, and only dispatch sends it', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const point = await pointId(h, c.id, 'email');
    const composed = await call<{ message: { id: string }; result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Home value estimate', body: 'The report body.', idempotencyKey: `c-${randomUUID()}` });
    expect(composed.body.result).toBe('sent');
    const before = h.providers.email.sent.length;
    const key = randomUUID();
    const r = await create(agent.actor(), { contactId: c.id, toPointId: point, idempotencyKey: key });
    expect(r).toMatchObject({ ok: true, created: true });
    const id = (r as { messageId: string }).messageId;
    const a = await row(composed.body.message.id);
    const b = await row(id);
    expect(b.idempotency_key).toBe(`h:${agent.userId}:${key}`);
    const same = (x: Record<string, unknown>) => ({ ...x, body: masked(x.body), idempotency_key: undefined, status: undefined, gate_decision_id: undefined });
    expect(same(b)).toEqual(same(a));
    expect(b).toMatchObject({ status: 'queued', initiator: 'human', initiated_by_user_id: agent.userId, action_category: 'none', gate_decision_id: null });
    // (a): its dispatch job exists (an immediate compose has none: it dispatches in the request)
    expect(await jobs(id)).toBe(1);
    expect(await jobs(composed.body.message.id)).toBe(0);
    // nothing was sent by creating it
    expect(h.providers.email.sent.length).toBe(before);
    const d = await dispatchOutbound(id, deps(), { tenantId: w.tenantId, actor: agent.actor() });
    expect(d.kind).toBe('sent');
    expect(h.providers.email.sent.length).toBe(before + 1);
  });

  it('R-CMA-9: the same key replays the same message (created false), within and across transactions', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const point = await pointId(h, c.id, 'email');
    const key = randomUUID();
    const one = await create(agent.actor(), { contactId: c.id, toPointId: point, idempotencyKey: key });
    const two = await create(agent.actor(), { contactId: c.id, toPointId: point, idempotencyKey: key });
    expect(two).toEqual({ ok: true, messageId: (one as { messageId: string }).messageId, created: false });
    // the key is the sender's: another contact under the same key is not this message
    const other = await ownedContact(agent);
    await expect(create(agent.actor(), { contactId: other.id, toPointId: await pointId(h, other.id, 'email'), idempotencyKey: key })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('R-CMA-9 (b): with no sending identity it returns SENDER_UNAVAILABLE and stores no message and no decision', async () => {
    const { leadsWorld } = await import('../leads/testing.js');
    const bare = await leadsWorld(h, { agents: 1 }); // a tenant with no email identity at all (commsWorld adds a team one)
    const agent = bare.agents[0]!;
    const c = await ownedContact(agent);
    const before = Number((await h.su.query('SELECT count(*)::int AS n FROM gate_decisions WHERE tenant_id = $1', [bare.tenantId])).rows[0].n);
    const r = await create(agent.actor(), { contactId: c.id, toPointId: await pointId(h, c.id, 'email') });
    expect(r).toEqual({ ok: false, code: 'SENDER_UNAVAILABLE' });
    expect(Number((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [c.id])).rows[0].n)).toBe(0);
    expect(Number((await h.su.query('SELECT count(*)::int AS n FROM gate_decisions WHERE tenant_id = $1', [bare.tenantId])).rows[0].n)).toBe(before);
  });

  it('R-PERM-5 R-TEN-1: RLS refuses an invisible contact (NOT_FOUND) and another tenant\'s; a point that is not the contact\'s email is CONTACT_POINT_MISSING; an empty subject is SUBJECT_REQUIRED', async () => {
    const c = await ownedContact(w.agents[0]!);
    const point = await pointId(h, c.id, 'email');
    await expect(create(w.agents[1]!.actor(), { contactId: c.id, toPointId: point })).rejects.toBeInstanceOf(AppError);
    await expect(create(w.agents[1]!.actor(), { contactId: c.id, toPointId: point })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = await commsWorld(h, { agents: 1 });
    await expect(create(other.agents[0]!.actor(), { contactId: c.id, toPointId: point })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await create(w.agents[0]!.actor(), { contactId: c.id, toPointId: await pointId(h, c.id, 'phone') })).toEqual({ ok: false, code: 'CONTACT_POINT_MISSING' });
    expect(await create(w.agents[0]!.actor(), { contactId: c.id, toPointId: randomUUID() })).toEqual({ ok: false, code: 'CONTACT_POINT_MISSING' });
    await expect(create(w.agents[0]!.actor(), { contactId: c.id, toPointId: point, subject: '  ' })).rejects.toMatchObject({ code: 'SUBJECT_REQUIRED' });
    expect(Number((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [c.id])).rows[0].n)).toBe(0);
  });

  it('R-OWN-24: a merged-away record is never a target (CONTACT_MERGED, nothing created)', async () => {
    const owner = w.owner;
    const survivor = await ownedContact(owner);
    const loser = await ownedContact(owner, { confirmDistinct: true });
    const { command } = await import('../leads/testing.js');
    expect((await command(owner, survivor.id, 'merge', { loserId: loser.id, ownerChoice: owner.userId })).status).toBe(200);
    expect(await create(owner.actor(), { contactId: loser.id, toPointId: await pointId(h, loser.id, 'email') })).toEqual({ ok: false, code: 'CONTACT_MERGED' });
  });

  it('R-AST-13: it never creates a non-human row: every message it made in this file is initiator human, by its actor', async () => {
    const r = await h.su.query("SELECT DISTINCT initiator FROM messages WHERE tenant_id = $1 AND direction = 'outbound'", [w.tenantId]);
    expect(r.rows.map((x) => x.initiator)).toEqual(['human']);
  });
});

// Batch 13: V2-A's export meets ISA-2 (audit cma-v2a F1). A one-to-one human message takes over live AI care (R-ISA-3):
// composeHumanMessage and sendExisting call takeoverInTx, and so must this export, or a CMA share email to a person
// under live care would leave the assistant talking to them. Its own tenant (isaWorld): fakes only, nothing real sent.
describe('R-ISA-3: a human CMA share email takes over live AI care (createHumanEmailInTx)', () => {
  it('R-ISA-3 R-ISA-15: the share email pauses live care human_contact, by the sharer, in the share\'s own transaction; a replay pauses nothing again', async () => {
    const { assignmentOf, isaLead, isaWorld, runIsa, startCare } = await import('../isa/testing.js');
    const iw = await isaWorld(h);
    const agent = iw.agents[0]!;
    const l = await isaLead(h, agent);
    const started = await startCare(agent, l.id);
    expect(started.status).toBe(200);
    await runIsa(h, iw.tenantId);
    const before = (await assignmentOf(h, l.id))!;
    expect(before).toMatchObject({ ended_at: null, paused_at: null });
    const key = `cma-share:${randomUUID()}`; // the share's own key shape (cma/share.ts shareKey)
    const r = await create(agent.actor(), { contactId: l.id, toPointId: await pointId(h, l.id, 'email'), idempotencyKey: key });
    expect(r).toMatchObject({ ok: true, created: true });
    const after = (await assignmentOf(h, l.id))!;
    expect(after.id).toBe(before.id);
    expect(after.paused_at).not.toBeNull();
    expect(after.pause_reason).toBe('human_contact');
    const by = await h.su.query<{ paused_by_kind: string; paused_by_user_id: string | null }>('SELECT paused_by_kind, paused_by_user_id FROM ai_isa_assignments WHERE id = $1', [after.id]);
    expect(by.rows[0]).toEqual({ paused_by_kind: 'user', paused_by_user_id: agent.userId });
    const audits = async () => Number((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'ai_isa.assignment_paused' AND entity_id = $2", [iw.tenantId, after.id])).rows[0].n);
    expect(await audits()).toBe(1);
    // the same key replays the same message and takes nothing over twice
    expect(await create(agent.actor(), { contactId: l.id, toPointId: await pointId(h, l.id, 'email'), idempotencyKey: key })).toEqual({ ok: true, messageId: (r as { messageId: string }).messageId, created: false });
    expect(await audits()).toBe(1);
  });
});
