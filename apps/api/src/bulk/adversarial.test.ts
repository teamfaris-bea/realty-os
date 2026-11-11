// Parity module 63 adversarial tests: the DB guards with core bypassed (D1, R-PAR-36, S3, S5, S6), tenancy,
// pond cards, protected audiences (R-PAR-8), the daily cap race (Q-PAR-7), template injection in bulk.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact, pointId } from '../comms/testing.js';
import { intake, suFixture } from '../leads/testing.js';
import { runBulkAction } from './run.js';
import { confirm, draft, itemsOf, marketingReady } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let other: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['admin'] });
  await marketingReady(h, w);
  other = await commsWorld(h, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

const run = (id: string) => runBulkAction(id, w.deps, w.tenantId);
async function emailTemplate(c: TestClient, body = 'Hi {{contact.first_name}}, new homes this week.') {
  return (await call<{ template: { id: string } }>(c, 'POST', '/templates', { scope: 'personal', channel: 'email', name: `A ${randomUUID().slice(0, 6)}`, subject: 'Hello {{contact.first_name}}', body })).body.template.id;
}

/** A running email action of `agent` for `contactId`, as the runner would leave it before its first send. */
async function runningAction(agent: TestClient, contactId: string): Promise<string> {
  const d = await draft(agent, { kind: 'email', selection: { contactIds: [contactId] }, templateId: await emailTemplate(agent) });
  expect(d.body.action.targetCount).toBe(1);
  await confirm(agent, d.body.action.id);
  await suFixture(h, [{ text: "UPDATE bulk_actions SET status = 'running', started_at = now() WHERE id = $1", values: [d.body.action.id] }]);
  return d.body.action.id;
}

/** As `by` (app_user, RLS): a bulk message straight into the table, then the dispatch transition: no core at all. */
async function rawBulkSend(by: TestClient, actionId: string, contactId: string, toAddress: string): Promise<void> {
  await withTenantTx(by.actor(), async (tx) => {
    const conv = await sql<{ id: string }>`SELECT id FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
    let convId = conv.rows[0]?.id;
    if (!convId) {
      convId = randomUUID();
      await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${convId}, ${contactId})`.execute(tx);
    }
    const ident = await sql<{ id: string; from_address: string }>`SELECT id, from_address FROM email_identities WHERE tenant_id = app.tenant_id() AND status = 'active' LIMIT 1`.execute(tx);
    const id = randomUUID();
    await sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, email_identity_id, from_address, to_address, subject, body,
                status, initiator, initiated_by_user_id, purpose, action_category, occurred_at, bulk_action_id)
              VALUES (app.tenant_id(), ${id}, ${convId}, ${contactId}, 'email', 'outbound', ${ident.rows[0]!.id}, ${ident.rows[0]!.from_address}, ${toAddress}, 'S',
                'Body\n\n--\nHarbor Realty LLC\n1 Main St, Springfield\nUnsubscribe: x', 'queued', 'human', app.user_id(), 'marketing', 'none', now(), ${actionId})`.execute(tx);
    await sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  }, { db: h.database });
}

describe('D1 R-PAR-36 the DB guards hold with core bypassed', () => {
  it('R-PAR-36 a bulk email to an address that unsubscribed is refused by the DB dispatch guard even when no core check runs', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const id = await runningAction(agent, c.id);
    const pid = await pointId(h, c.id, 'email');
    await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'email', purpose: 'all', evidence: { note: 'unsubscribe by phone' } });
    await expect(rawBulkSend(agent, id, c.id, c.email)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    expect(h.providers.email.sent.filter((m) => m.to === c.email)).toHaveLength(0);
  });

  it('R-PAR-36 S3 a bulk message must be for a pending item at its frozen address, sent by the creator (BULK_MESSAGE_INVALID)', async () => {
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const c = await ownedContact(a0);
    const outsider = await ownedContact(a0);
    const id = await runningAction(a0, c.id);
    // a person who is not in the frozen target
    await expect(rawBulkSend(a0, id, outsider.id, outsider.email)).rejects.toThrow(/BULK_MESSAGE_INVALID/);
    // another address of the person than the frozen one
    await expect(rawBulkSend(a0, id, c.id, `x-${randomUUID().slice(0, 5)}@example.test`)).rejects.toThrow(/BULK_MESSAGE_INVALID|violates/);
    // anyone but the creator (an Owner included)
    await expect(rawBulkSend(w.owner, id, c.id, c.email)).rejects.toThrow(/BULK_MESSAGE_INVALID/);
    void a1;
    // once the item is processed, no further message can claim it (no re-send)
    await run(id);
    expect((await itemsOf(h, id))[0]!.status).toBe('done');
    await expect(rawBulkSend(a0, id, c.id, c.email)).rejects.toThrow(/BULK_MESSAGE_INVALID/);
  });

  it('R-PAR-37 S5 a message never loses its bulk action (it would become a touch)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const id = await runningAction(agent, c.id);
    await run(id);
    await expect(withTenantTx(agent.actor(), (tx) => sql`UPDATE messages SET bulk_action_id = NULL WHERE tenant_id = app.tenant_id() AND bulk_action_id = ${id}`.execute(tx), { db: h.database })).rejects.toThrow(/BULK_MESSAGE_IMMUTABLE/);
  });

  it('R-PAR-33 S6 an Owner or Admin cannot rewrite an agent\'s draft content, and nobody can widen a frozen target', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    for (const who of [w.owner, w.others[0]!]) {
      await expect(withTenantTx(who.actor(), (tx) => sql`UPDATE bulk_actions SET body_snapshot = 'Wire the deposit today' WHERE tenant_id = app.tenant_id() AND id = ${d.body.action.id}`.execute(tx), { db: h.database })).rejects.toThrow(/BULK_CREATOR_ONLY/);
    }
    await confirm(agent, d.body.action.id);
    await expect(withTenantTx(agent.actor(), (tx) => sql`UPDATE bulk_actions SET target_count = 5 WHERE tenant_id = app.tenant_id() AND id = ${d.body.action.id}`.execute(tx), { db: h.database })).rejects.toThrow(/BULK_FROZEN/);
  });
});

describe('tenancy and visibility (R-TEN, R-PAR-34)', () => {
  it('another tenant\'s people are never resolved, and another tenant cannot read or cancel an action', async () => {
    const agent = w.agents[0]!;
    const mine = await ownedContact(agent);
    const theirs = await ownedContact(other.agents[0]!);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [mine.id, theirs.id] }, templateId: await emailTemplate(agent) });
    expect(d.body.action).toMatchObject({ selected: 2, targetCount: 1, preflight: { NOT_VISIBLE: 1 } });
    expect((await call(other.owner, 'GET', `/bulk-actions/${d.body.action.id}`)).status).toBe(404);
    expect((await call(other.owner, 'POST', `/bulk-actions/${d.body.action.id}/cancel`)).status).toBe(404);
    expect((await call(other.owner, 'POST', `/bulk-actions/${d.body.action.id}/confirm`)).status).toBe(404);
    expect((await h.su.query('SELECT count(*)::int AS n FROM bulk_action_items WHERE contact_id = $1', [theirs.id])).rows[0].n).toBe(0);
  });

  it('R-PAR-34 a pond card or another agent\'s lead is never a bulk target (detail visibility, not card visibility)', async () => {
    const agent = w.agents[0]!;
    const pond = await intake(h, { ...w, ruleId: null } as never, {}).catch(() => null);
    const ids = [(await ownedContact(w.agents[1]!)).id, ...(pond ? [pond.contactId] : [])];
    const d = await draft(agent, { kind: 'email', selection: { contactIds: ids }, templateId: await emailTemplate(agent) });
    expect(d.body.action.targetCount).toBe(0);
    expect(d.body.action.preflight['NOT_VISIBLE']).toBe(ids.length);
  });

  it('R-PAR-33 a Team Lead reads their agent\'s action (counts only for people they see) but cannot confirm it', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const d = await draft(agent, { kind: 'email', selection: { contactIds: [c.id] }, templateId: await emailTemplate(agent) });
    const tl = await call<{ action: { mine: boolean; targetCount: number } }>(w.teamLead!, 'GET', `/bulk-actions/${d.body.action.id}`);
    expect(tl.status).toBe(200);
    expect(tl.body.action).toMatchObject({ mine: false, targetCount: 1 });
    expect((await confirm(w.teamLead!, d.body.action.id)).status).toBe(404);
    expect((await call(w.agents[1]!, 'GET', `/bulk-actions/${d.body.action.id}`)).status).toBe(404);
  });
});

describe('R-PAR-8 protected audiences', () => {
  it('R-PAR-8 E189 an audience built from a protected tag never gets a bulk email (AUDIENCE_PROTECTED_PROXY), whoever sends it', async () => {
    const tagId = randomUUID();
    await withTenantTx(w.owner.actor(), (tx) => sql`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id, protected_proxy)
      VALUES (app.tenant_id(), ${tagId}, ${`VA buyer ${tagId.slice(0, 4)}`}, 'user', app.user_id(), true)`.execute(tx), { db: h.database });
    const c = await ownedContact(w.owner);
    const r = await draft(w.owner, { kind: 'email', selection: { contactIds: [c.id] }, audienceTagIds: [tagId], templateId: await emailTemplate(w.owner) });
    expect(r.body).toMatchObject({ error: { code: 'AUDIENCE_PROTECTED_PROXY' } });
  });
});

describe('Q-PAR-7 the daily bulk-email cap is the team\'s, across creators, and holds under a race', () => {
  it('Q-PAR-7 two agents confirming at once cannot both pass the 2,000 daily recipients', async () => {
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    // earlier today other creators confirmed all but 2 of the day's recipients (a fixture: 2,000 people is slow)
    const used = (await h.su.query("SELECT COALESCE(sum(target_count), 0)::int AS n FROM bulk_actions WHERE tenant_id = $1 AND kind = 'email' AND confirmed_at IS NOT NULL", [w.tenantId])).rows[0].n as number;
    const fake = randomUUID();
    await suFixture(h, [{ text: "INSERT INTO bulk_actions (tenant_id, id, kind, status, created_by_user_id, created_by_role, source, idempotency_key, target_count, confirmed_at, finished_at, body_snapshot, subject_snapshot) VALUES ($1, $2, 'email', 'completed', $3, 'owner', 'selection', $4, $5, now(), now(), 'x', 'x')", values: [w.tenantId, fake, w.owner.userId, `fixture-${fake}`, 2000 - used - 2] }]);
    try {
      const d0 = await draft(a0, { kind: 'email', selection: { contactIds: [(await ownedContact(a0)).id, (await ownedContact(a0)).id] }, templateId: await emailTemplate(a0) });
      const d1 = await draft(a1, { kind: 'email', selection: { contactIds: [(await ownedContact(a1)).id, (await ownedContact(a1)).id] }, templateId: await emailTemplate(a1) });
      const [r0, r1] = await Promise.all([confirm(a0, d0.body.action.id), confirm(a1, d1.body.action.id)]);
      const codes = [r0, r1].map((r) => (r.status === 200 ? 'ok' : (r.body as unknown as { error: { code: string } }).error.code)).sort();
      expect(codes).toEqual(['BULK_DAILY_EMAIL_CAP', 'ok']);
      const refused = r0.status === 200 ? r1 : r0;
      expect((refused.body as unknown as { error: { details: { remaining: number } } }).error.details.remaining).toBe(0);
    } finally {
      await suFixture(h, [{ text: "DELETE FROM bulk_actions WHERE id = $1 OR (tenant_id = $2 AND kind = 'email' AND status = 'confirmed')", values: [fake, w.tenantId] }]);
    }
  });
});

describe('R-PAR-24 template injection through bulk', () => {
  it('R-PAR-24 E179 a person whose name is a merge token gets it printed literally; nobody gets anyone else\'s data', async () => {
    const agent = w.agents[0]!;
    const evil = await ownedContact(agent, { firstName: '{{agent.email}}' });
    const plain = await ownedContact(agent, { firstName: 'Pat' });
    const id = (await draft(agent, { kind: 'email', selection: { contactIds: [evil.id, plain.id] }, templateId: await emailTemplate(agent) })).body.action.id;
    await confirm(agent, id);
    await run(id);
    const e = h.providers.email.sent.find((m) => m.to === evil.email)!;
    expect(e.text).toContain('Hi {{agent.email}}, new homes this week.');
    expect(e.subject).toBe('Hello {{agent.email}}');
    const p = h.providers.email.sent.find((m) => m.to === plain.email)!;
    expect(p.text).toContain('Hi Pat,');
    expect(p.text).not.toContain('{{agent.email}}');
  });
});
