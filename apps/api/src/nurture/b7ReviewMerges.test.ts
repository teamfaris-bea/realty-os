// b7 review findings on merges (sends/F2, ownership-data/F1): a trigger message queued before a merge is never sent,
// the dispatch guard refuses a within-playbook message whose action is no longer proposed, and listing / deal roles
// follow the merged person so their home anniversary and listing alerts keep firing. Real Postgres as app_user.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsOf, messagesOf, ownedContact } from '../assistant/testing.js';
import { dispatchOutbound } from '../comms/dispatch.js';
import { command, freshReauth } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { executeTriggerRunInTx } from './execute.js';
import { reconcileTriggersInTx } from './reconcile.js';
import { listingFollowers } from './repos.js';
import { type NurtureWorld, anniversaryScan, approveTemplate, closedDeal, firingsDue, follow, mlsRecord, nurtureWorld, reconcileAndRun, triggerRuns } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  await approveTemplate(w.agents[0]!, 'behavior_alerts');
  await approveTemplate(w.agents[0]!, 'after_closing_alerts');
}, 300_000);
afterAll(async () => {
  await h?.close();
});

let n = 47000;
const nextMls = () => (n += 1);
const at = (iso: string) => Date.parse(iso) as never;
const alerts = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');
const actionStatus = async (id: string) => (await h.su.query<{ status: string }>('SELECT status FROM assistant_actions WHERE id = $1', [id])).rows[0]!.status;
const runRow = async (id: string) => (await h.su.query<{ status: string; trigger_ref: Record<string, unknown>; message_id: string | null; assistant_action_id: string | null }>('SELECT status, trigger_ref, message_id, assistant_action_id FROM playbook_step_runs WHERE id = $1', [id])).rows[0]!;
const merge = async (survivorId: string, loserId: string) => {
  await freshReauth(h, w.owner);
  const r = await command(w.owner, survivorId, 'merge', { loserId });
  if (r.status !== 200) throw new Error(`merge: ${r.status} ${JSON.stringify(r.body)}`);
};

/**
 * The reviewer's probe: a followed home's price drops, the firing is built into a queued autonomous email, and its
 * comms.dispatch job is removed so a merge can land between queue and dispatch. Returns the run and its message.
 */
async function queuedPriceDropEmail(contactId: string): Promise<{ runId: string; messageId: string; actionId: string; listingId: string }> {
  const k = nextMls();
  const listingId = await mlsRecord(h, w, k, { ListPrice: 600000 });
  await follow(h, w.tenantId, listingId, contactId);
  await mlsRecord(h, w, k, { ListPrice: 540000 });
  await firingsDue(h, contactId);
  await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => reconcileTriggersInTx(tx, now), { db: h.database });
  const [run] = await triggerRuns(h, contactId);
  expect(run).toBeDefined();
  await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
  const [m] = await alerts(contactId);
  expect(m).toMatchObject({ status: 'queued', initiator: 'assistant', channel: 'email' });
  await h.su.query("DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'comms.dispatch' AND status = 'pending' AND payload::text LIKE '%' || $2 || '%'", [w.tenantId, m!.id]);
  const r = await runRow(run!.id);
  expect(r).toMatchObject({ status: 'scheduled', message_id: m!.id });
  expect(await actionStatus(r.assistant_action_id!)).toBe('proposed');
  return { runId: run!.id, messageId: m!.id, actionId: r.assistant_action_id!, listingId };
}

describe('b7 sends/F2: a merge withdraws a queued autonomous trigger message', () => {
  it('R-NURT-1 R-GATE-4 R-OWN-24 b7 sends/F2: a trigger message queued before a merge is not sent', async () => {
    const agent = w.agents[0]!;
    const survivor = await ownedContact(agent);
    const loser = await ownedContact(agent, { confirmDistinct: true });
    const q = await queuedPriceDropEmail(loser.id);
    const sentBefore = h.providers.email.sent.length;

    await merge(survivor.id, loser.id); // the Owner merges the duplicate while the email waits for dispatch

    const r = await dispatchOutbound(q.messageId, depsOf(h), { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    if (r.kind !== 'blocked') throw new Error('not blocked');
    expect(r.decision.reasons).toContain('ASSISTANT_ACTION_WITHDRAWN');
    const msg = (await h.su.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [q.messageId])).rows[0]!;
    expect(msg.status).toBe('blocked');
    expect(h.providers.email.sent.slice(sentBefore).some((s) => JSON.stringify(s.to).includes(loser.email))).toBe(false);
    expect(h.providers.email.sent.some((s) => s.idempotencyKey.includes(q.messageId))).toBe(false);
    const run = await runRow(q.runId);
    expect(run.status).toBe('skipped_ineligible');
    expect(run.trigger_ref['skip']).toMatchObject({ reason: 'CONTACT_REMOVED' });
    expect(await actionStatus(q.actionId)).toBe('invalidated');
    // a later reconcile pass sends nothing either
    await reconcileAndRun(h, w.tenantId);
    expect(h.providers.email.sent.slice(sentBefore).some((s) => JSON.stringify(s.to).includes(loser.email))).toBe(false);
    expect((await runRow(q.runId)).status).toBe('skipped_ineligible');
    expect(await actionStatus(q.actionId)).toBe('invalidated');
  });

  it('R-GATE-4 b7 sends/F2: the dispatch guard refuses a within_playbook message whose action is not proposed', async () => {
    const c = await ownedContact(w.agents[0]!);
    const q = await queuedPriceDropEmail(c.id);
    await h.su.query("UPDATE assistant_actions SET status = 'invalidated' WHERE id = $1", [q.actionId]);
    const forced = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${q.messageId}`.execute(tx), { db: h.database }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(forced).toMatch(/^ASSISTANT_ACTION_WITHDRAWN/);
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [q.messageId])).rows[0].status).toBe('queued');
    // the one outbound path refuses it first, with the same code
    const r = await dispatchOutbound(q.messageId, depsOf(h), { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    if (r.kind === 'blocked') expect(r.decision.reasons).toContain('ASSISTANT_ACTION_WITHDRAWN');
    expect(h.providers.email.sent.some((s) => s.idempotencyKey.includes(q.messageId))).toBe(false);
  });
});

describe('b7 ownership-data/F1: deal and listing roles follow a merge', () => {
  it('R-OWN-24 R-NURT-2 b7 ownership-data/F1: a home anniversary fires for the survivor after the deal\'s person is merged', async () => {
    const agent = w.agents[0]!;
    const survivor = await ownedContact(agent);
    const loser = await ownedContact(agent, { confirmDistinct: true });
    const control = await ownedContact(agent, { confirmDistinct: true });
    const closedAt = new Date('2023-05-20T17:00:00Z');
    const deal = await closedDeal(h, w.tenantId, loser.id, agent.userId!, closedAt);
    await h.su.query("INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES ($1,$2,$3,'buyer')", [w.tenantId, deal, loser.id]);
    const controlDeal = await closedDeal(h, w.tenantId, control.id, agent.userId!, closedAt);

    await merge(survivor.id, loser.id);

    expect((await h.su.query('SELECT primary_contact_id FROM deals WHERE id = $1', [deal])).rows[0].primary_contact_id).toBe(survivor.id);
    expect((await h.su.query('SELECT contact_id, role FROM deal_contacts WHERE deal_id = $1 ORDER BY contact_id', [deal])).rows).toEqual([{ contact_id: survivor.id, role: 'buyer' }]);

    expect(await anniversaryScan(h, w.tenantId, at('2027-05-20T17:00:00Z'))).toBe(2);
    expect((await triggerRuns(h, survivor.id)).map((r) => r.trigger_key)).toEqual([`anniversary:${deal}:2027:${survivor.id}`]);
    expect((await triggerRuns(h, control.id)).map((r) => r.trigger_key)).toEqual([`anniversary:${controlDeal}:2027:${control.id}`]);
    expect(await triggerRuns(h, loser.id)).toEqual([]);
  });

  it('R-OWN-24 R-NURT-2 b7 ownership-data/F1: an interested follower keeps listing alerts after a merge', async () => {
    const agent = w.agents[0]!;
    const survivor = await ownedContact(agent);
    const loser = await ownedContact(agent, { confirmDistinct: true });
    const k = nextMls();
    const followed = await mlsRecord(h, w, k, { ListPrice: 700000 });
    await follow(h, w.tenantId, followed, loser.id);
    // a second home: the survivor is interested, the loser is its seller; the stronger role is kept
    const sold = await mlsRecord(h, w, nextMls(), { ListPrice: 800000 });
    await follow(h, w.tenantId, sold, survivor.id);
    await h.su.query("INSERT INTO listing_contacts (tenant_id, listing_id, contact_id, role) VALUES ($1,$2,$3,'seller')", [w.tenantId, sold, loser.id]);

    await merge(survivor.id, loser.id);

    const roles = async (listingId: string) => (await h.su.query('SELECT contact_id, role FROM listing_contacts WHERE listing_id = $1 ORDER BY contact_id', [listingId])).rows;
    expect(await roles(followed)).toEqual([{ contact_id: survivor.id, role: 'interested' }]);
    expect(await roles(sold)).toEqual([{ contact_id: survivor.id, role: 'seller' }]);
    const followers = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => listingFollowers(tx, followed), { db: h.database });
    expect(followers.map((f) => f.contactId)).toEqual([survivor.id]);

    await mlsRecord(h, w, k, { ListPrice: 650000 });
    expect((await triggerRuns(h, survivor.id)).map((r) => r.step_key)).toEqual(['price_drop']);
    expect(await triggerRuns(h, loser.id)).toEqual([]);
    await firingsDue(h, survivor.id);
    await reconcileAndRun(h, w.tenantId);
    expect((await alerts(survivor.id)).map((m) => m.status)).toEqual(['sent']);
  });
});
