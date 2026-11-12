// Regression tests for the independent review of module 26 (three lenses: autonomy and opt-outs, tenancy and
// concurrency, content and fair housing). Each test fails without its fix. Real Postgres as app_user, fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, depsOf, messagesOf, ownedContact } from '../assistant/testing.js';
import { dispatchOutbound } from '../comms/dispatch.js';
import { inboundSms } from '../comms/testing.js';
import { command } from '../leads/testing.js';
import { REVIEWED_PACK, mlsConnection } from '../mls/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { executeTriggerRunInTx } from './execute.js';
import { ATTEST, type NurtureWorld, approveTemplate, firingsDue, follow, mlsRecord, nurtureWorld, reconcileAndRun, triggerRuns } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

let n = 12000;
const nextMls = () => (n += 1);
const alertsOf = async (id: string) => (await messagesOf(h, id)).filter((m) => m.action_category === 'search_alert' || m.action_category === 'nurture_step');

async function approve(by: typeof w.owner, body: Record<string, unknown>): Promise<{ playbookId: string; versionId: string }> {
  const c = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string; issues: unknown[] }[] } }>(by, 'POST', '/playbooks', body);
  if (c.status !== 201) throw new Error(JSON.stringify(c.body));
  const v = c.body.playbook.versions[0]!;
  if (v.issues.length) throw new Error(JSON.stringify(v.issues));
  expect((await call(by, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: ATTEST, contentSha256: v.contentSha256 })).status).toBe(200);
  return { playbookId: c.body.playbook.id, versionId: v.id };
}

describe('review fixes', () => {
  it('autonomy: one message carries one step shape; items of a step with another channel or category go as their own message (never under the head step\'s checks)', async () => {
    const agent = w.agents[1]!;
    const sms = { trigger: 'back_on_market', stepKey: 'bom_sms', channel: 'sms', offsetSeconds: 0, purpose: 'marketing', category: 'nurture_step', intent: 'back_on_market_alert', template: 'Hi {{first_name}}, a home you follow is back: {{listing_address}}.', slots: ['first_name', 'listing_address'], maxLength: 480 };
    const email = { trigger: 'price_drop', stepKey: 'pd_email', channel: 'email', offsetSeconds: 0, purpose: 'marketing', category: 'search_alert', intent: 'price_drop_alert', subject: 'New price', template: 'Hi {{first_name}},\n\nNew price: {{listing_address}}, now {{listing_price}}.', slots: ['first_name', 'listing_address', 'listing_price'], maxLength: 2000 };
    await approve(agent, { kind: 'trigger', scope: 'agent', name: 'Mixed', steps: { kind: 'triggers', digestWindowMinutes: 120, triggers: [email, sms] } });
    const c = await ownedContact(agent);
    const a = nextMls();
    const b = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, a, { ListPrice: 500000 }), c.id);
    await follow(h, w.tenantId, await mlsRecord(h, w, b, { StandardStatus: 'Withdrawn' }), c.id);
    await mlsRecord(h, w, a, { ListPrice: 450000 });
    await mlsRecord(h, w, b, { StandardStatus: 'Active' });
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId, 3);
    const m = await alertsOf(c.id);
    expect(m.map((x) => [x.channel, x.action_category, x.status]).sort()).toEqual([['email', 'search_alert', 'sent'], ['sms', 'nurture_step', 'sent']]);
  });

  it('autonomy R-NURT-7: dispatch refuses a queued team-playbook trigger message once the contact has no owner (ASSISTANT_ACTION_STALE)', async () => {
    await approve(w.owner, { templateKey: 'behavior_alerts', scope: 'team', name: 'Team alerts' });
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    await mlsRecord(h, w, k, { ListPrice: 440000 });
    await firingsDue(h, c.id);
    const [run] = await triggerRuns(h, c.id);
    await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
    const [msg] = await alertsOf(c.id);
    expect(msg!.status).toBe('queued');
    expect((await command(agent, c.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    const r = await dispatchOutbound(msg!.id, depsOf(h), { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    const d = (await h.su.query<{ reason_codes: string[] }>('SELECT reason_codes FROM gate_decisions WHERE message_id = $1', [msg!.id])).rows[0]!;
    expect(d.reason_codes).toContain('ASSISTANT_ACTION_STALE');
  });

  it('concurrency: the MLS sync writes no firing (and takes no contact lock) itself; it enqueues one system job per changed listing', async () => {
    const c = await ownedContact(w.agents[0]!);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    const { syncConnection } = await import('../mls/sync.js');
    const { makeDue, mlsDeps, pagedFeed, reso } = await import('../mls/testing.js');
    await makeDue(h, w.mls);
    await syncConnection(mlsDeps(h, { [w.mls]: pagedFeed([[reso(k, { ListPrice: 430000, ModificationTimestamp: '2027-01-01T00:00:00Z' })]]) }), w.tenantId as never, w.mls);
    expect(await triggerRuns(h, c.id)).toEqual([]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'nurture.listing_changed' AND status = 'pending'", [w.tenantId])).rows[0].n).toBeGreaterThan(0);
  });

  it('R-AST-4: a firing due before the migrate job ran is built from the newly approved version, not dropped', async () => {
    const agent = w.agents[0]!;
    const p = await approveTemplate(agent, 'behavior_alerts');
    const c = await ownedContact(agent);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    await mlsRecord(h, w, k, { ListPrice: 445000 });
    const view = await call<{ playbook: { versions: { steps: { triggers: Record<string, unknown>[] } }[] } }>(agent, 'GET', `/playbooks/${p.playbookId}`);
    const content = view.body.playbook.versions[0]!.steps as unknown as Record<string, unknown> & { triggers: Record<string, unknown>[] };
    const edited = { ...content, triggers: content.triggers.map((t) => (t['trigger'] === 'price_drop' ? { ...t, template: 'Hi {{first_name}},\n\nFresh price on a home you follow: {{listing_address}}, now {{listing_price}}.' } : t)) };
    const nv = await call<{ playbook: { versions: { id: string; status: string; contentSha256: string }[] } }>(agent, 'POST', `/playbooks/${p.playbookId}/versions`, { steps: edited });
    const d = nv.body.playbook.versions.find((v) => v.status === 'draft')!;
    expect((await call(agent, 'POST', `/playbook-versions/${d.id}/approve`, { attestation: ATTEST, contentSha256: d.contentSha256 })).status).toBe(200);
    await h.su.query("DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'assistant.playbook_migrate' AND status = 'pending'", [w.tenantId]); // the job has not run yet
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await alertsOf(c.id);
    expect(m.map((x) => x.status)).toEqual(['sent']);
    expect(m[0]!.body).toContain('Fresh price on a home you follow');
    expect((await triggerRuns(h, c.id))[0]!.playbook_version_id).toBe(d.id);
  });

  it('concurrency: a run whose message was resolved later (dispatch_unknown ⇒ sent) settles to sent, and a later reply never marks it canceled', async () => {
    const c = await ownedContact(w.agents[0]!);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    await mlsRecord(h, w, k, { ListPrice: 441000 });
    await firingsDue(h, c.id);
    const [run] = await triggerRuns(h, c.id);
    await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
    const [msg] = await alertsOf(c.id);
    // the provider timed out: the message is dispatch_unknown and the run is still scheduled
    await h.su.query("UPDATE messages SET status = 'dispatch_unknown', dispatched_at = now() WHERE id = $1", [msg!.id]);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Thanks!')).statusCode).toBe(200);
    expect((await triggerRuns(h, c.id))[0]!.status).toBe('scheduled'); // not canceled: it may have gone out
    await h.su.query("UPDATE messages SET status = 'sent' WHERE id = $1", [msg!.id]); // comms.reconcile found it
    await reconcileAndRun(h, w.tenantId, 1);
    expect((await triggerRuns(h, c.id))[0]!.status).toBe('sent');
  });

  it('R-MLS-2: a back-on-market alert never shows a price the licence pack withholds from clients; MLS numbers stay out of client lines', async () => {
    const pack = { ...REVIEWED_PACK, audiences: { ...REVIEWED_PACK.audiences, client: { ...REVIEWED_PACK.audiences.client, fields: REVIEWED_PACK.audiences.client.fields.filter((f) => f !== 'listPrice') } } };
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { pack, lastSyncedAt: new Date() });
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const ids = [nextMls(), nextMls()];
    for (const k of ids) await follow(h, w.tenantId, await mlsRecord(h, w, k, { StandardStatus: 'Withdrawn', ListPrice: 777000 }, w.tenantId, conn), c.id);
    for (const k of ids) await mlsRecord(h, w, k, { StandardStatus: 'Active', ListPrice: 777000 }, w.tenantId, conn);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await alertsOf(c.id);
    expect(m.map((x) => x.status)).toEqual(['sent']);
    expect(m[0]!.body).toContain('2 updates on homes you follow');
    expect(m[0]!.body).not.toContain('777,000');
    expect(m[0]!.body).not.toMatch(/MLS #/);
    void randomUUID;
  });
});
