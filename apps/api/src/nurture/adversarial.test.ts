// Adversarial tests of api/nurture (critical module: autonomy, opt-outs, tenancy, fair housing). PHASE2_3_PLAN
// §5.1/§5.4 #26: D1, R-PAR-12, R-CHAN-2 merges, R-NURT-1/5/7, R-AST-4, R-FH-2, R-TEN-*. Real Postgres as app_user.
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { actionsOf, call, depsOf, messagesOf, ownedContact, randomPhone } from '../assistant/testing.js';
import { scheduledTriggerRun, chatSource, createWidget, openChat, chatMessage } from '../channels/testing.js';
import { dispatchOutbound } from '../comms/dispatch.js';
import { inboundSms } from '../comms/testing.js';
import { command } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { executeTriggerRunInTx } from './execute.js';
import { reconcileTriggersInTx } from './reconcile.js';
import { FakeAvmP2 } from '../providers/integrations/fakes.js';
import { ATTEST, type NurtureWorld, approveTemplate, avmCallsFor, avmPass, closedDeal, firingsDue, follow, mlsRecord, nurtureWorld, pastClient, reconcileAndRun, triggerRuns, valuationsOf } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;
let other: NurtureWorld;
let smsAgent: TestClient;

/** A valid SMS trigger content (agent playbook): POST /playbooks accepts it and approval never says PLAYBOOK_INVALID. */
const SMS_ALERTS = {
  kind: 'triggers',
  digestWindowMinutes: 0,
  triggers: [{ trigger: 'price_drop', stepKey: 'price_drop_sms', channel: 'sms', offsetSeconds: 0, purpose: 'marketing', category: 'search_alert', intent: 'price_drop_alert', template: 'Hi {{first_name}}, a home you follow has a new price: {{listing_address}}, now {{listing_price}}.', slots: ['first_name', 'listing_address', 'listing_price'], maxLength: 480 }],
};

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  other = await nurtureWorld(h);
  await approveTemplate(w.agents[0]!, 'behavior_alerts');
  await approveTemplate(other.agents[0]!, 'behavior_alerts');
  smsAgent = w.agents[1]!;
  const c = await call<{ playbook: { versions: { id: string; contentSha256: string; issues: unknown[] }[] } }>(smsAgent, 'POST', '/playbooks', { kind: 'trigger', scope: 'agent', name: 'Text alerts', steps: SMS_ALERTS });
  if (c.status !== 201) throw new Error(`create: ${c.status} ${JSON.stringify(c.body)}`);
  const v = c.body.playbook.versions[0]!;
  if (v.issues.length > 0) throw new Error(JSON.stringify(v.issues));
  const a = await call(smsAgent, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: ATTEST, contentSha256: v.contentSha256 });
  if (a.status !== 200) throw new Error(`approve: ${a.status} ${JSON.stringify(a.body)}`);
}, 300_000);
afterAll(async () => {
  await h?.close();
});

let n = 9000;
const nextMls = () => (n += 1);
const outbound = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');
const gateReasons = async (messageId: string) => (await h.su.query<{ reason_codes: string[] }>('SELECT reason_codes FROM gate_decisions WHERE message_id = $1', [messageId])).rows.flatMap((r) => r.reason_codes);

/** A followed MLS home whose price just dropped for `contactId`; the firing is made due. */
async function dropFor(world: NurtureWorld, contactId: string, o: Record<string, unknown> = {}): Promise<string> {
  const k = nextMls();
  const lid = await mlsRecord(h, world, k, { ListPrice: 500000, ...o }, world.tenantId, world.mls);
  await follow(h, world.tenantId, lid, contactId);
  await mlsRecord(h, world, k, { ListPrice: 440000, ...o }, world.tenantId, world.mls);
  await firingsDue(h, contactId);
  return lid;
}

describe('D1 opt-outs: every trigger message goes through dispatch, and nothing reaches an opted-out person', () => {
  it('R-PAR-12 E168: a STOP from a phone the agent later removed blocks the trigger text to the live phone (RECIPIENT_OPTED_OUT); the run is skipped by the gate', async () => {
    const c = await ownedContact(smsAgent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const work = randomPhone();
    expect((await call(smsAgent, 'POST', `/contacts/${c.id}/points`, { kind: 'phone', address: work, label: 'work' })).status).toBe(201);
    const old = (await h.su.query<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2", [c.id, c.phone])).rows[0]!.id;
    expect((await call(smsAgent, 'POST', `/contacts/${c.id}/points/${old}/remove`, { reason: 'old' })).status).toBe(200);
    // the STOP paused the conversation; the agent resumes automation so only the opt-out is in the way
    await h.su.query('UPDATE conversations SET automation_paused_at = NULL, automation_pause_reason = NULL, automation_paused_by_message_id = NULL WHERE contact_id = $1', [c.id]);
    await dropFor(w, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await outbound(c.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ status: 'blocked', initiator: 'assistant', channel: 'sms' });
    expect(await gateReasons(m[0]!.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^(CONSENT_REVOKED|RECIPIENT_OPTED_OUT)$/)]));
    expect(h.providers.telephony.sms.some((s) => s.to === work)).toBe(false);
    expect((await triggerRuns(h, c.id))[0]!.status).toBe('skipped_ineligible');
  });

  it('D1: the person-level do-not-contact blocks a trigger email (PERSON_DO_NOT_CONTACT); nothing is sent', async () => {
    const c = await ownedContact(w.agents[0]!);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/do-not-contact`, {})).status).toBe(200);
    await dropFor(w, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await outbound(c.id);
    expect(m.map((x) => x.status)).toEqual(['blocked']);
    expect(await gateReasons(m[0]!.id)).toEqual(expect.arrayContaining(['PERSON_DO_NOT_CONTACT']));
    expect(h.providers.email.sent.some((s) => s.to === c.email && s.subject.includes('new price'))).toBe(false);
  });

  it('R-CHAN-2: a merged-away record never gets a trigger message, and its person\'s do-not-contact still blocks the survivor', async () => {
    const agent = w.agents[0]!;
    const email = `merge-${randomUUID().slice(0, 8)}@example.test`;
    const survivor = await ownedContact(agent, { email, consent: false });
    const loser = await ownedContact(agent, { email, consent: false, confirmDistinct: true });
    expect((await call(agent, 'POST', `/contacts/${loser.id}/do-not-contact`, {})).status).toBe(200);
    const k = nextMls();
    const lid = await mlsRecord(h, w, k, { ListPrice: 500000 });
    await follow(h, w.tenantId, lid, loser.id);
    expect((await command(agent, survivor.id, 'merge', { loserId: loser.id })).status).toBe(200);
    await follow(h, w.tenantId, lid, survivor.id);
    await mlsRecord(h, w, k, { ListPrice: 430000 });
    expect(await triggerRuns(h, loser.id)).toEqual([]); // detection never picks a merged-away record
    await firingsDue(h, survivor.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await outbound(survivor.id);
    expect(m.map((x) => x.status)).toEqual(['blocked']);
    expect(await gateReasons(m[0]!.id)).toContain('PERSON_DO_NOT_CONTACT');
    // a firing that was already scheduled on the record before the merge is skipped, visibly, never sent
    const pb = (await h.su.query<{ id: string }>("SELECT v.id FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id WHERE p.tenant_id = $1 AND p.kind = 'trigger' AND p.owner_user_id = $2 AND v.status = 'approved'", [w.tenantId, agent.userId])).rows[0]!.id;
    const runId = randomUUID();
    await h.su.query(
      `INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
       VALUES ($1,$2,NULL,$3,'price_drop','scheduled',now() - interval '1 second',$4,$5,$6::jsonb)`,
      [w.tenantId, runId, pb, loser.id, `price_drop:${randomUUID()}:${loser.id}`, JSON.stringify({ v: 1, trigger: 'price_drop', playbookId: (await h.su.query('SELECT playbook_id FROM playbook_versions WHERE id = $1', [pb])).rows[0].playbook_id, firedAt: Date.now() - 1000, ref: { kind: 'price_drop', listingId: lid, historyId: randomUUID(), source: 'mls', oldPriceCents: 50_000_000, newPriceCents: 43_000_000, address: 'x', mlsNumber: null }, evidence: [] })],
    );
    await reconcileAndRun(h, w.tenantId);
    expect((await triggerRuns(h, loser.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: expect.objectContaining({ reason: 'CONTACT_REMOVED' }) }) });
    expect(await outbound(loser.id)).toEqual([]);
  });

  it('R-NURT-5 R-INBOX-2: a web-chat message from the contact cancels their scheduled trigger runs', async () => {
    const src = await chatSource(h, w.owner, w.tenantId);
    const widget = await createWidget(h, w.owner, src.sourceId);
    const chat = await openChat(h, widget.key, src.disclosureId, { name: 'Pat Visitor', message: 'Hi, I saw a listing' });
    const pb = (await h.su.query<{ id: string }>("SELECT v.id FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id WHERE p.tenant_id = $1 AND p.kind = 'trigger' AND v.status = 'approved' LIMIT 1", [w.tenantId])).rows[0]!.id;
    const run = await scheduledTriggerRun(h, w.tenantId, chat.contactId, pb);
    expect((await chatMessage(h, chat.token, { message: 'Actually, can someone call me?', clientMessageId: randomUUID() })).statusCode).toBeLessThan(300);
    expect((await h.su.query('SELECT status FROM playbook_step_runs WHERE id = $1', [run])).rows[0].status).toBe('canceled_paused');
  });
});

describe('autonomy: only an approved version acts, and a paused conversation never gets an autonomous send', () => {
  it('R-NURT-5 R-GATE-4: the DB dispatch guard refuses a forced autonomous trigger send while the conversation is paused (AUTOMATION_PAUSED)', async () => {
    const c = await ownedContact(w.agents[0]!);
    await dropFor(w, c.id);
    // build the message but do not dispatch it yet
    await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => reconcileTriggersInTx(tx, now), { db: h.database });
    const [run] = await triggerRuns(h, c.id);
    await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
    const [m] = await outbound(c.id);
    expect(m!.status).toBe('queued');
    await h.su.query("UPDATE conversations SET automation_paused_at = now(), automation_pause_reason = 'client_reply' WHERE contact_id = $1", [c.id]);
    const forced = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${m!.id}`.execute(tx), { db: h.database }).then(() => null, (e: Error) => e.message);
    expect(forced).toMatch(/AUTOMATION_PAUSED/);
    // and the one outbound path refuses it too: blocked, never sent
    const r = await dispatchOutbound(m!.id, depsOf(h), { tenantId: w.tenantId });
    expect(r.kind).toBe('blocked');
    expect((await outbound(c.id))[0]!.status).toBe('blocked');
  });

  it('R-AST-4: a superseded version\'s unbuilt firings move to the newly approved version (built from the new content); a version without the step skips them', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const k = nextMls();
    const lid = await mlsRecord(h, w, k, { ListPrice: 500000 });
    await follow(h, w.tenantId, lid, c.id);
    await mlsRecord(h, w, k, { ListPrice: 470000 });
    const [run] = await triggerRuns(h, c.id);
    const pbId = (await h.su.query('SELECT playbook_id FROM playbook_versions WHERE id = $1', [run!.playbook_version_id])).rows[0].playbook_id;
    const view = await call<{ playbook: { versions: { steps: { triggers: Record<string, unknown>[]; digestWindowMinutes: number; kind: string } }[] } }>(agent, 'GET', `/playbooks/${pbId}`);
    const content = view.body.playbook.versions.at(-1)!.steps;
    const edited = { ...content, triggers: content.triggers.map((t) => (t['trigger'] === 'price_drop' ? { ...t, template: 'Hi {{first_name}},\n\nGood news on a home you follow: {{listing_address}} is now {{listing_price}}.' } : t)) };
    const nv = await call<{ playbook: { versions: { id: string; status: string; contentSha256: string; issues: unknown[] }[] } }>(agent, 'POST', `/playbooks/${pbId}/versions`, { steps: edited });
    expect(nv.status).toBe(200);
    const draft = nv.body.playbook.versions.find((v) => v.status === 'draft')!;
    expect(draft.issues).toEqual([]);
    expect((await call(agent, 'POST', `/playbook-versions/${draft.id}/approve`, { attestation: ATTEST, contentSha256: draft.contentSha256 })).status).toBe(200);
    // the migrate job runs as the system (assistant.playbook_migrate), then the firing goes from the new content
    const { runJobs } = await import('../assistant/testing.js');
    await runJobs(h, w.tenantId, ['assistant.playbook_migrate']);
    expect((await triggerRuns(h, c.id))[0]!.playbook_version_id).toBe(draft.id);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await outbound(c.id);
    expect(m.map((x) => x.status)).toEqual(['sent']);
    expect(m[0]!.body).toContain('Good news on a home you follow');
  });

  it('R-NURT-1: a tampered or foreign trigger_ref never builds a message (FACT_MISMATCH, visibly)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const pb = (await h.su.query<{ id: string }>("SELECT v.id FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id WHERE p.tenant_id = $1 AND p.kind = 'trigger' AND p.owner_user_id = $2 AND v.status = 'approved'", [w.tenantId, w.agents[0]!.userId])).rows[0]!.id;
    const id = randomUUID();
    await h.su.query(`INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
                      VALUES ($1,$2,NULL,$3,'price_drop','scheduled',now() - interval '1 second',$4,$5,'{"kind":"rate_move"}'::jsonb)`, [w.tenantId, id, pb, c.id, `x:${id}`]);
    await reconcileAndRun(h, w.tenantId);
    expect((await triggerRuns(h, c.id))[0]).toMatchObject({ status: 'skipped_ineligible' });
    expect(await outbound(c.id)).toEqual([]);
  });

  it('R-NURT-8: the gate never records a trigger send as a touch; the contact\'s ownership clock is untouched', async () => {
    const c = await ownedContact(w.agents[0]!);
    const before = (await h.su.query('SELECT owner_user_id, ownership_period_seq, last_human_touch_at FROM contacts WHERE id = $1', [c.id])).rows[0];
    await dropFor(w, c.id);
    await reconcileAndRun(h, w.tenantId);
    expect((await outbound(c.id)).map((m) => m.status)).toEqual(['sent']);
    expect((await h.su.query('SELECT owner_user_id, ownership_period_seq, last_human_touch_at FROM contacts WHERE id = $1', [c.id])).rows[0]).toEqual(before);
  });
});

describe('R-FH-2 fair housing: MLS text never slips a fair-housing match into an autonomous message', () => {
  it('R-FH-2: a listing brokerage name with fair-housing wording turns the alert into a "Check this" draft, never a send', async () => {
    const c = await ownedContact(w.agents[0]!);
    await dropFor(w, c.id, { ListOfficeName: 'Perfect for young families Realty' });
    await reconcileAndRun(h, w.tenantId);
    expect(await outbound(c.id)).toEqual([]);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('converted_to_draft');
    const d = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    expect(d).toMatchObject({ kind: 'message_draft', autonomy: 'requires_approval' });
    expect(d.payload['checkThis']).toBe(true);
    expect(d.payload['draftReasons']).toContain('FAIR_HOUSING');
    expect(d.explanation).toMatch(/Check this/);
  });

  it('R-FH-2: trigger content with fair-housing wording cannot be approved (TEMPLATE_FAIR_HOUSING); it stays a draft', async () => {
    const bad = { ...SMS_ALERTS, triggers: [{ ...SMS_ALERTS.triggers[0]!, template: 'Hi {{first_name}}, perfect for young families: {{listing_address}} now {{listing_price}}.' }] };
    const c = await call<{ playbook: { versions: { id: string; contentSha256: string; issues: { code: string }[] }[] } }>(w.agents[0]!, 'POST', '/playbooks', { kind: 'trigger', scope: 'agent', name: 'Bad alerts', steps: bad });
    expect(c.status).toBe(201);
    const v = c.body.playbook.versions[0]!;
    expect(v.issues.map((i) => i.code)).toContain('TEMPLATE_FAIR_HOUSING');
    const a = await call<{ code?: string }>(w.agents[0]!, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: ATTEST, contentSha256: v.contentSha256 });
    expect(a.status).toBe(422);
  });
});

describe('tenancy (R-TEN-*): every handler and route stays inside its tenant', () => {
  it('R-TEN-3: another tenant\'s system actor cannot execute, wake or read a firing; its MLS sync of the same number fires nothing here', async () => {
    const c = await ownedContact(w.agents[0]!);
    await dropFor(w, c.id);
    const [run] = await triggerRuns(h, c.id);
    const r = await withTenantTx(systemActor(other.tenantId as TenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), other.tenantId, run!.id, now), { db: h.database });
    expect(r).toEqual({ kind: 'noop', reason: 'MISSING' });
    const woke = await withTenantTx(systemActor(other.tenantId as TenantId, 'assistant'), (tx, now) => reconcileTriggersInTx(tx, now), { db: h.database });
    expect(woke.woken).toBe(0);
    expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'trigger.step' AND payload->>'stepRunId' = $2", [other.tenantId, run!.id])).rows[0].n).toBe(0);
    expect((await triggerRuns(h, c.id))[0]!.status).toBe('scheduled');
    // the other tenant's agent and Owner: 404 on this tenant's contact (never 403)
    for (const u of [other.agents[0]!, other.owner]) expect((await call(u, 'GET', `/contacts/${c.id}/trigger-runs`)).status).toBe(404);
    // the other tenant's feed carries the same MLS number: nothing fires for this tenant's contact
    const before = (await triggerRuns(h, c.id)).length;
    await mlsRecord(h, other, n, { ListPrice: 100000 }, other.tenantId, other.mls);
    expect((await triggerRuns(h, c.id)).length).toBe(before);
    await reconcileAndRun(h, w.tenantId);
    expect((await outbound(c.id)).map((m) => m.status)).toEqual(['sent']);
  });

  it('R-PERM-5: inside the tenant, an agent who cannot see the contact gets 404 for its trigger runs; the owner and the Owner see them', async () => {
    const c = await ownedContact(w.agents[0]!);
    await dropFor(w, c.id);
    expect((await call(w.agents[0]!, 'GET', `/contacts/${c.id}/trigger-runs`)).status).toBe(200);
    expect((await call(w.owner, 'GET', `/contacts/${c.id}/trigger-runs`)).status).toBe(200);
    expect((await call(w.agents[1]!, 'GET', `/contacts/${c.id}/trigger-runs`)).status).toBe(404);
    // a person cannot write trigger runs at all (system-written, RLS WITH CHECK is_tenant_wide for the Owner only as data;
    // an agent's insert is refused)
    const pb = (await h.su.query<{ id: string }>("SELECT v.id FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id WHERE p.tenant_id = $1 AND p.kind = 'trigger' AND v.status = 'approved' LIMIT 1", [w.tenantId])).rows[0]!.id;
    const refused = await withTenantTx(w.agents[0]!.actor(), (tx) => sql`INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
        VALUES (app.tenant_id(), ${randomUUID()}, NULL, ${pb}, 'price_drop', 'scheduled', now(), ${c.id}, ${`forged:${randomUUID()}`}, '{}'::jsonb)`.execute(tx), { db: h.database }).then(() => null, (e: Error) => e.message);
    expect(refused).toMatch(/row-level security|policy/);
  });

  it('GET /nurture/triggers says honestly which kinds can fire now (home values fire from avm.refresh, wave 2C)', async () => {
    const r = await call<{ triggers: { trigger: string; availability: string }[]; templates: { key: string }[] }>(w.agents[0]!, 'GET', '/nurture/triggers');
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.body.triggers.map((t) => [t.trigger, t.availability]))).toEqual({ price_drop: 'available', back_on_market: 'available', home_anniversary: 'available', home_value: 'available', deal_date_upcoming: 'available' });
    expect(r.body.templates.map((t) => t.key).sort()).toEqual(['after_closing_alerts', 'behavior_alerts', 'transaction_updates']);
  });
});

// ---- home values (wave 2C): forged firings, vendor strings, the vendor call outside every lock, tenancy ----------

describe('home values (wave 2C): a home-value firing is only ever what it says (R-NURT-1, R-AVM-1..3, R-TEN-*)', () => {
  const avm = () => h.providers.integrations.avm;
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  let tcWorld: NurtureWorld;
  beforeAll(async () => {
    await approveTemplate(w.agents[0]!, 'after_closing_alerts');
    await approveTemplate(other.agents[0]!, 'after_closing_alerts');
    tcWorld = await nurtureWorld(h, { others: ['tc'] });
  }, 240_000);

  const homeOutbound = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'nurture_step');

  /** A stored home_value trigger_ref (what detection writes), pointing wherever the attacker likes. */
  const forgedRef = (playbookId: string, ref: { contactAddressId: string; month: string; valuationId: string; address: string }) =>
    JSON.stringify({ v: 1, trigger: 'home_value', playbookId, firedAt: Date.now() - 60_000, ref: { kind: 'home_value', ...ref }, evidence: [] });

  async function afterClosingVersion(world: NurtureWorld, agent: TestClient): Promise<{ playbookId: string; versionId: string }> {
    const r = await h.su.query<{ pid: string; vid: string }>("SELECT p.id AS pid, v.id AS vid FROM playbooks p JOIN playbook_versions v ON v.playbook_id = p.id WHERE p.tenant_id = $1 AND p.owner_user_id = $2 AND p.name = 'After-closing alerts' AND v.status = 'approved'", [world.tenantId, agent.userId]);
    return { playbookId: r.rows[0]!.pid, versionId: r.rows[0]!.vid };
  }

  it('R-NURT-1 R-NURT-2: an agent\'s, a Team Lead\'s and a TC\'s insert of a trigger run is refused; an Owner/Admin row passes RLS by design (step_runs_trigger WITH CHECK is_tenant_wide), and executeTriggerRun re-checks a forged home_value run like any other (FACT_MISMATCH)', async () => {
    const a = await pastClient(h, w, w.agents[0]!);
    const b = await pastClient(h, w, w.agents[0]!);
    const pb = await afterClosingVersion(w, w.agents[0]!);
    // A's valuation, recorded without a firing (fixture); B's own valuation; another tenant's valuation
    const aVal = randomUUID();
    await h.su.query("INSERT INTO home_valuations (tenant_id, id, contact_id, contact_address_id, provider, value_cents, low_cents, high_cents, valued_at, status, as_of, display_allowed) VALUES ($1,$2,$3,$4,'p',40000000,38000000,42000000,now(),'ok',now()::date,true)", [w.tenantId, aVal, a.id, a.addressId]);
    const b2 = await call<{ address: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${b.id}/addresses`, { kind: 'home', line1: '9 Second Home Rd', city: 'Springfield', region: 'SC', postalCode: '29401' });
    const bVal = randomUUID();
    await h.su.query("INSERT INTO home_valuations (tenant_id, id, contact_id, contact_address_id, provider, value_cents, low_cents, high_cents, valued_at, status, as_of, display_allowed) VALUES ($1,$2,$3,$4,'p',40000000,38000000,42000000,now(),'ok',now()::date,true)", [w.tenantId, bVal, b.id, b.addressId]);
    const theirs = await pastClient(h, other, other.agents[0]!);
    const xVal = randomUUID();
    await h.su.query("INSERT INTO home_valuations (tenant_id, id, contact_id, contact_address_id, provider, value_cents, low_cents, high_cents, valued_at, status, as_of, display_allowed) VALUES ($1,$2,$3,$4,'p',40000000,38000000,42000000,now(),'ok',now()::date,true)", [other.tenantId, xVal, theirs.id, theirs.addressId]);
    const m = thisMonth();
    const insertAs = (actor: Parameters<typeof withTenantTx>[0], id: string, key: string, ref: string) =>
      withTenantTx(actor, (tx) => sql`INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
          VALUES (app.tenant_id(), ${id}, NULL, ${pb.versionId}, 'home_value', 'scheduled', now() - interval '1 minute', ${b.id}, ${key}, ${ref}::jsonb)`.execute(tx), { db: h.database }).then(() => null, (e: Error) => e.message);
    // people other than the Owner/Admin cannot write a trigger run at all
    for (const who of [w.agents[0]!, w.teamLead!]) expect(await insertAs(who.actor(), randomUUID(), `forged:${randomUUID()}`, forgedRef(pb.playbookId, { contactAddressId: b.addressId, month: m, valuationId: bVal, address: 'x' }))).toMatch(/row-level security|policy/);
    const tc = tcWorld.others.find((o) => o.role === 'tc')!;
    const tcPb = (await h.su.query<{ id: string }>("SELECT v.id FROM playbook_versions v WHERE v.tenant_id = $1 LIMIT 1", [tcWorld.tenantId])).rows[0];
    const tcContact = await ownedContact(tcWorld.agents[0]!);
    const tcRefused = await withTenantTx(tc.actor(), (tx) => sql`INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
        VALUES (app.tenant_id(), ${randomUUID()}, NULL, ${tcPb?.id ?? randomUUID()}, 'home_value', 'scheduled', now(), ${tcContact.id}, ${`forged:${randomUUID()}`}, '{}'::jsonb)`.execute(tx), { db: h.database }).then(() => null, (e: Error) => e.message);
    expect(tcRefused).toMatch(/row-level security|policy|foreign key/);
    // the Owner's forged rows pass RLS (residual, ARCHITECTURE §21.13); each one is re-checked and never sends
    const forged = [
      { why: 'another contact\'s valuation', key: `avm:${a.addressId}:${m}`, ref: { contactAddressId: a.addressId, month: m, valuationId: aVal, address: 'x' } },
      { why: 'another address\'s key and ref', key: `avm:${b2.body.address.id}:${m}`, ref: { contactAddressId: b2.body.address.id, month: m, valuationId: bVal, address: 'x' } },
      { why: 'another tenant\'s valuation', key: `avm:${b.addressId}:${m}`, ref: { contactAddressId: b.addressId, month: m, valuationId: xVal, address: 'x' } },
      { why: 'a key that is not the ref\'s', key: `avm:${b.addressId}:1999-01`, ref: { contactAddressId: b.addressId, month: m, valuationId: bVal, address: 'x' } },
    ];
    for (const f of forged) {
      const id = randomUUID();
      expect(await insertAs(w.owner.actor(), id, f.key, forgedRef(pb.playbookId, f.ref)), f.why).toBeNull();
      const out = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, id, now), { db: h.database });
      expect(out, f.why).toMatchObject({ kind: 'skipped', reasons: ['FACT_MISMATCH'] });
    }
    expect(await homeOutbound(b.id)).toEqual([]);
  });

  it('R-AVM-1 R-INT-1: vendor strings with template markers, line breaks or bidi controls never reach the template; an unavailable or broken answer never yields a value', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    const k = FakeAvmP2.key({ line1: c.line1, postalCode: c.postalCode });
    const fresh = new Date().toISOString().slice(0, 8) + '01';
    avm().answers.set(k, { kind: 'raw', answer: { available: true, valueCents: 41_000_000, lowCents: 38_000_000, highCents: 44_000_000, asOf: fresh, method: 'comps {{x}}\n', comparables: [{ address: '1 {{x}} Ct\n', soldOn: fresh, priceCents: 1, listingId: null }, { address: 'bad' }], provider: 'Evil {{first_name}}\nValues‮⁦ Inc', displayAllowed: true } });
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:avm'");
    try {
      await avmPass(h, w.tenantId);
      await firingsDue(h, c.id);
      await reconcileAndRun(h, w.tenantId);
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:avm'");
    }
    const v = (await valuationsOf(h, c.addressId))[0]!;
    expect(v.provider).toBe('Evil first_name Values Inc');
    const [msg] = await homeOutbound(c.id);
    expect(msg!.body).toContain('from Evil first_name Values Inc as of');
    expect(msg!.body).not.toMatch(/\{\{|\}\}|[‪-‮⁦-⁩]/);
    // answers that cannot be stored: no row, no firing; an unavailable answer that carries a number stores no value
    const bad = [await pastClient(h, w, w.agents[0]!), await pastClient(h, w, w.agents[0]!), await pastClient(h, w, w.agents[0]!)];
    avm().answers.set(FakeAvmP2.key({ line1: bad[0]!.line1, postalCode: bad[0]!.postalCode }), { kind: 'raw', answer: { available: true, valueCents: -5, lowCents: 1, highCents: 2, asOf: fresh, method: 'm', provider: 'P' } });
    avm().answers.set(FakeAvmP2.key({ line1: bad[1]!.line1, postalCode: bad[1]!.postalCode }), { kind: 'raw', answer: { available: true, valueCents: 10, lowCents: 20, highCents: 5, asOf: '2026-02-31', method: 'm', provider: 'P' } });
    avm().answers.set(FakeAvmP2.key({ line1: bad[2]!.line1, postalCode: bad[2]!.postalCode }), { kind: 'raw', answer: { available: false, valueCents: 40_000_000, provider: 'P' } });
    await avmPass(h, w.tenantId);
    expect(await valuationsOf(h, bad[0]!.addressId)).toEqual([]);
    expect(await valuationsOf(h, bad[1]!.addressId)).toEqual([]);
    expect(await triggerRuns(h, bad[0]!.id)).toEqual([]);
    expect((await valuationsOf(h, bad[2]!.addressId)).map((x) => [x.status, x.value_cents, x.low_cents, x.high_cents])).toEqual([['unavailable', null, null, null]]);
    // the database refuses what the parser would never produce (R-AVM-1)
    const ins = (status: string, value: number | null, low: number | null, high: number | null, addr: string, cid: string) =>
      h.su.query("INSERT INTO home_valuations (tenant_id, id, contact_id, contact_address_id, provider, value_cents, low_cents, high_cents, valued_at, status) VALUES ($1,$2,$3,$4,'p',$5,$6,$7,now(),$8)", [w.tenantId, randomUUID(), cid, addr, value, low, high, status]).then(() => null, (e: Error) => e.message);
    expect(await ins('unavailable', 100, null, null, bad[0]!.addressId, bad[0]!.id)).toMatch(/home_valuations_value_when_ok/);
    expect(await ins('ok', 100, 90, 80, bad[0]!.addressId, bad[0]!.id)).toMatch(/home_valuations_range/);
    expect(await ins('ok', 100, 90, 110, bad[0]!.addressId, bad[0]!.id)).toBeNull();
    expect(await ins('ok', 120, 90, 130, bad[0]!.addressId, bad[0]!.id)).toMatch(/home_valuations_one_per_month/);
    expect(await ins('unavailable', null, null, null, bad[0]!.addressId, bad[0]!.id)).toBeNull(); // an unavailable row the same month is accepted by the DB
  });

  it('R-AVM-3: no vendor call happens inside a transaction, so no contact lock is ever held while the vendor answers', async () => {
    const cs = [await pastClient(h, w, w.agents[0]!), await pastClient(h, w, w.agents[0]!)];
    const seen: { advisory: number; openTx: number }[] = [];
    avm().onEstimate = async () => {
      const r = await h.su.query<{ advisory: number; open_tx: number }>(
        `SELECT (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND a.datname = current_database()) AS advisory,
                (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%') AS open_tx`);
      seen.push({ advisory: r.rows[0]!.advisory, openTx: r.rows[0]!.open_tx });
    };
    try {
      await avmPass(h, w.tenantId);
    } finally {
      avm().onEstimate = null;
    }
    expect(seen.length).toBeGreaterThanOrEqual(cs.length);
    expect(seen.every((s) => s.advisory === 0 && s.openTx === 0)).toBe(true);
  });

  it('R-TEN-3: avm.refresh in one tenant reads and writes nothing of another; another tenant\'s home-value run is 404 on trigger-runs; trigger.step across tenants is a no-op', async () => {
    const theirs = await pastClient(h, other, other.agents[0]!);
    const mine = await pastClient(h, w, w.agents[0]!);
    await avmPass(h, w.tenantId);
    expect(avmCallsFor(h, theirs.line1)).toBe(0);
    expect(await valuationsOf(h, theirs.addressId)).toEqual([]);
    expect(await triggerRuns(h, theirs.id)).toEqual([]);
    expect(await valuationsOf(h, mine.addressId)).toHaveLength(1);
    await avmPass(h, other.tenantId);
    const [run] = await triggerRuns(h, theirs.id);
    expect(run).toBeDefined();
    expect((await call(w.owner, 'GET', `/contacts/${theirs.id}/trigger-runs`)).status).toBe(404);
    expect((await call(w.agents[0]!, 'GET', `/contacts/${theirs.id}/trigger-runs`)).status).toBe(404);
    const out = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
    expect(out).toEqual({ kind: 'noop', reason: 'MISSING' });
    expect((await triggerRuns(h, theirs.id))[0]!.status).toBe('scheduled');
  });

  it('sourceLabel: a stored deal_date_upcoming run\'s claim and trigger-runs fact say "deal date", never "closed deal"', async () => {
    const { recordFactInTx } = await import('./detect.js');
    await approveTemplate(w.owner, 'transaction_updates');
    const c = await ownedContact(w.agents[0]!);
    const deal = await closedDeal(h, w.tenantId, c.id, w.agents[0]!.userId!, new Date());
    await h.su.query("UPDATE deals SET stage = 'under_contract', closed_at = NULL WHERE id = $1", [deal]);
    const dd = randomUUID();
    const dueAt = new Date(Date.now() + 5 * 86_400_000);
    // a person confirms the date as themselves (the DB requires it)
    await withTenantTx(w.owner.actor(), (tx) => sql`INSERT INTO deal_dates (tenant_id, id, deal_id, kind, label, due_on, status, confirmed_by_user_id, confirmed_at, due_at)
        VALUES (app.tenant_id(), ${dd}, ${deal}, 'inspection', 'Inspection', ${dueAt.toISOString()}::date, 'confirmed', ${w.owner.userId}, now(), ${dueAt.toISOString()}::timestamptz)`.execute(tx), { db: h.database });
    await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => recordFactInTx(tx, depsOf(h), { kind: 'deal_date_upcoming', dealId: deal, dealDateId: dd, dueVersion: 1, dueAt: dueAt.getTime() as never, label: 'Inspection', contactIds: [c.id], at: now }, [{ contactId: c.id, ownerUserId: w.agents[0]!.userId!, relation: { kind: 'contact' } }]), { db: h.database });
    const [run] = await triggerRuns(h, c.id);
    expect(run).toBeDefined();
    const r = await call<{ runs: { trigger: string; fact: { source: string; text: string } | null }[] }>(w.agents[0]!, 'GET', `/contacts/${c.id}/trigger-runs`);
    expect(r.body.runs[0]).toMatchObject({ trigger: 'deal_date_upcoming', fact: { source: 'deal_date' } });
    await firingsDue(h, c.id);
    await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
    const claims = (await h.su.query<{ text: string }>('SELECT c.text FROM assistant_claims c JOIN assistant_actions a ON a.id = c.action_id WHERE a.contact_id = $1', [c.id])).rows;
    expect(claims.length).toBeGreaterThanOrEqual(1);
    for (const x of claims) {
      expect(x.text).toMatch(/\(deal date, /);
      expect(x.text).not.toMatch(/closed deal/);
    }
  });
});
