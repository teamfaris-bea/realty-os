// Monthly home values end to end (PHASE2_3_PLAN §5.4 #25/26, wave 2C; §1 "Post-closing home values"; P15, F7):
// avm.refresh → home_valuations → one avm:{address}:{yyyy-mm} firing → executeTriggerRun → comms/dispatch.ts.
// Real Postgres (app_user, RLS), the deterministic fake AVM (settable per-address answers) and fake email/texting.
// R-AVM-1..3, R-NURT-1/2/4/5/7/8, R-GATE-14, R-INT-1, R-INT-6, R-AST-20; E98, E99.
import { randomUUID } from 'node:crypto';
import type { PlaybookContent } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { actionsOf, call, decisionsFor, depsOf, inboundSms, messagesOf, pointId, runJobs } from '../assistant/testing.js';
import { command } from '../leads/testing.js';
import { FAKE_AVM_PROVIDER, FakeAvmP2 } from '../providers/integrations/fakes.js';
import { createUnconfiguredIntegrations } from '../providers/integrations/real.js';
import { systemActor } from '../worker/systemActor.js';
import { avmRefresh } from './avm.js';
import { executeTriggerRunInTx } from './execute.js';
import { type NurtureWorld, type PastClient, approveTemplate, avmCallsFor, avmPass, beforeThisMonth, firingsDue, nurtureWorld, pastClient, reconcileAndRun, triggerRuns, valuationsOf, withAvmCleared } from './testing.js';

type TriggersContent = Extract<PlaybookContent, { kind: 'triggers' }>;

let h: ApiHarness;
let w: NurtureWorld;
let alerts: { playbookId: string; versionId: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  // the agent approves the built-in "After-closing alerts" once
  alerts = await approveTemplate(w.agents[0]!, 'after_closing_alerts');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const avm = () => h.providers.integrations.avm;
const key = (c: PastClient) => FakeAvmP2.key({ line1: c.line1, postalCode: c.postalCode });
const homeMail = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'nurture_step');
const month = () => new Date().toISOString().slice(0, 7);
type Runs = { runs: { id: string; status: string; trigger: string; fact: { text: string; source: string; at: string } | null; skip: { reason: string; text: string } | null; assistantActionId: string | null }[] };

/** A refresh, then the firing is due and the reconcile builds and dispatches it. */
async function refreshAndRun(c: PastClient): Promise<void> {
  await avmPass(h, w.tenantId);
  await firingsDue(h, c.id);
  await reconcileAndRun(h, w.tenantId);
}

/** A prior ok estimate recorded last UTC month (clock fixture: the vendor answered then). */
async function priorEstimate(c: PastClient, valueCents: number): Promise<void> {
  await h.su.query(
    `INSERT INTO home_valuations (tenant_id, id, contact_id, contact_address_id, provider, value_cents, low_cents, high_cents, valued_at, status, as_of, display_allowed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, date_trunc('month', now()) - interval '10 days', 'ok', (date_trunc('month', now()) - interval '1 month')::date, true)`,
    [w.tenantId, randomUUID(), c.id, c.addressId, FAKE_AVM_PROVIDER, valueCents, Math.round(valueCents * 0.95), Math.round(valueCents * 1.05)],
  );
}

describe('acceptance: After-closing alerts approved once; one home-value note a month per covered address, through dispatch', () => {
  it('R-AVM-2 R-AVM-1 R-NURT-1 R-NURT-8: cleared, fresh, displayable, in range and a small change ⇒ exactly one note through dispatch, with provider, range, as-of date, "an estimate, not an appraisal" and the valuation as verified evidence', async () => {
    const agent = w.agents[0]!;
    const c = await pastClient(h, w, agent);
    await priorEstimate(c, 0); // replaced below with a sensible prior once the fake's value is known
    await h.su.query('DELETE FROM home_valuations WHERE contact_address_id = $1', [c.addressId]);
    const fresh = await avm().estimate({ line1: c.line1, city: 'Springfield', region: 'SC', postalCode: c.postalCode });
    avm().calls.pop();
    if (!fresh.available) throw new Error('fixture');
    await priorEstimate(c, Math.round(fresh.valueCents / 1.02)); // a 2 % rise: within the 10 % jump limit
    await withAvmCleared(h, async () => {
      await refreshAndRun(c);
      await refreshAndRun(c); // a second pass the same month requests and fires nothing
    });
    const vals = await valuationsOf(h, c.addressId);
    expect(vals).toHaveLength(2);
    expect(vals[1]).toMatchObject({ status: 'ok', value_cents: String(fresh.valueCents), as_of: fresh.asOf, display_allowed: true, provider: FAKE_AVM_PROVIDER, change_from_prior_bps: 200 });
    expect(avmCallsFor(h, c.line1)).toBe(1);
    const runs = await triggerRuns(h, c.id);
    expect(runs.map((r) => [r.trigger_key, r.status])).toEqual([[`avm:${c.addressId}:${month()}`, 'sent']]);
    const sent = await homeMail(c.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: 'sent', initiator: 'assistant', channel: 'email', playbook_step_run_id: runs[0]!.id });
    expect(sent[0]!.body).toContain('This is an estimate, not an appraisal.');
    expect(sent[0]!.body).toContain(`from ${FAKE_AVM_PROVIDER} as of`);
    expect(sent[0]!.body).toMatch(/Estimated value: \$[\d,]+ \(range \$[\d,]+–\$[\d,]+\)/);
    expect(sent[0]!.body).not.toMatch(/unchanged/i);
    expect(h.providers.email.sent.filter((m) => m.to === c.email)).toHaveLength(1);
    const action = (await actionsOf(h, c.id)).find((a) => a.id === runs[0]!.assistant_action_id)!;
    expect(action).toMatchObject({ kind: 'autonomous_message', autonomy: 'within_playbook', action_category: 'nurture_step', status: 'executed' });
    expect(action.payload['evidence']).toEqual([expect.objectContaining({ trigger: 'home_value', source: 'home_valuation', sourceId: vals[1]!.id })]);
    const ev = (await h.su.query('SELECT c.text, e.source_type, e.source_id, e.snippet, e.verbatim_verified FROM assistant_claims c JOIN evidence_refs e ON e.claim_id = c.id WHERE c.action_id = $1', [action.id])).rows;
    expect(ev).toEqual([expect.objectContaining({ source_type: 'home_valuation', source_id: vals[1]!.id, verbatim_verified: true })]);
    expect(ev[0]!.snippet).toContain('This is an estimate, not an appraisal.');
    expect(ev[0]!.text).toMatch(/home value estimate, /);
    // the trigger-runs view shows the same sentence as the fact, sourced from the home valuation
    const r = await call<Runs>(agent, 'GET', `/contacts/${c.id}/trigger-runs`);
    expect(r.body.runs[0]).toMatchObject({ trigger: 'home_value', status: 'sent', fact: { source: 'home_valuation' } });
    expect(r.body.runs[0]!.fact!.text).toContain('This is an estimate, not an appraisal.');
    // never a touch, never an ownership change
    expect((await h.su.query('SELECT last_human_touch_at, owner_user_id FROM contacts WHERE id = $1', [c.id])).rows[0]).toEqual({ last_human_touch_at: null, owner_user_id: agent.userId });
  });

  it('R-AVM-2 R-INT-6: with platform:avm uncleared (as it ships) the note is a draft for the agent, saying in plain words why; nothing is sent', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    await refreshAndRun(c);
    expect(await homeMail(c.id)).toEqual([]);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('converted_to_draft');
    const d = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    expect(d).toMatchObject({ kind: 'message_draft', autonomy: 'requires_approval', owner_user_id: w.agents[0]!.userId, status: 'proposed' });
    expect(d.payload['draftReasons']).toContain('AVM_NOT_CLEARED');
    expect(d.explanation).toMatch(/counsel review/);
    expect(String(d.payload['body'])).toContain('This is an estimate, not an appraisal.');
    const ev = (await h.su.query('SELECT e.source_type, e.snippet FROM assistant_claims c JOIN evidence_refs e ON e.claim_id = c.id WHERE c.action_id = $1', [d.id])).rows;
    expect(ev).toEqual([expect.objectContaining({ source_type: 'home_valuation', snippet: expect.stringContaining('not an appraisal') })]);
    const t = await call<{ triggers: { trigger: string; availability: string; note: string | null }[] }>(w.agents[0]!, 'GET', '/nurture/triggers');
    expect(t.body.triggers.find((x) => x.trigger === 'home_value')).toMatchObject({ availability: 'available', note: expect.stringMatching(/counsel review/) });
  });

  it('R-INT-6: a later unreviewed platform:avm version turns home values back into drafts', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:avm'");
    const old = (await h.su.query<{ version: string }>("SELECT version FROM jurisdiction_packs WHERE key = 'platform:avm' AND status = 'published'")).rows[0]!.version;
    try {
      await h.su.query("UPDATE jurisdiction_packs SET status = 'retired' WHERE key = 'platform:avm' AND version = $1", [old]);
      await h.su.query(`INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES ('platform:avm', '2099.1.0', 'published', '{"max_age_days": 35}', NULL, 'test: a newer, unreviewed version')`);
      await refreshAndRun(c);
      expect(await homeMail(c.id)).toEqual([]);
      const [run] = await triggerRuns(h, c.id);
      expect(run!.status).toBe('converted_to_draft');
      expect((await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!.payload['draftReasons']).toContain('AVM_NOT_CLEARED');
    } finally {
      await h.su.query("DELETE FROM jurisdiction_packs WHERE key = 'platform:avm' AND version = '2099.1.0'");
      await h.su.query("UPDATE jurisdiction_packs SET status = 'published', reviewed_by_counsel_at = NULL WHERE key = 'platform:avm' AND version = $1", [old]);
    }
  });
});

describe('R-AVM-2 every refusal is a draft or a visible skip (E98, E99)', () => {
  it('E98: a fake estimate 30 % below last month ⇒ a draft for the agent; change_from_prior_bps is -3000; nothing is sent', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    await priorEstimate(c, 50_000_000);
    avm().answers.set(key(c), { kind: 'estimate', estimate: { valueCents: 35_000_000, lowCents: 33_600_000, highCents: 36_400_000 } });
    await withAvmCleared(h, () => refreshAndRun(c));
    const vals = await valuationsOf(h, c.addressId);
    expect(vals.at(-1)).toMatchObject({ status: 'ok', value_cents: '35000000', change_from_prior_bps: -3000 });
    expect(await homeMail(c.id)).toEqual([]);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('converted_to_draft');
    const d = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    expect(d).toMatchObject({ kind: 'message_draft', owner_user_id: w.agents[0]!.userId });
    expect(d.payload['draftReasons']).toEqual(['AVM_JUMP_TOO_LARGE']);
    expect(d.explanation).toMatch(/moved a lot since last month/);
  });

  it('E99: no value ⇒ a status unavailable row, the run skipped "No estimate available." on GET /contacts/:id/trigger-runs; nothing says "unchanged"', async () => {
    const c = await pastClient(h, w, w.agents[0]!, { postalCode: '29410' }); // the fake has no estimate for a postal code ending in 0
    await priorEstimate(c, 40_000_000);
    await withAvmCleared(h, () => refreshAndRun(c));
    const vals = await valuationsOf(h, c.addressId);
    expect(vals.at(-1)).toMatchObject({ status: 'unavailable', value_cents: null, low_cents: null, high_cents: null, as_of: null, display_allowed: false, change_from_prior_bps: null });
    expect(await homeMail(c.id)).toEqual([]);
    const r = await call<Runs>(w.agents[0]!, 'GET', `/contacts/${c.id}/trigger-runs`);
    expect(r.body.runs).toHaveLength(1);
    expect(r.body.runs[0]).toMatchObject({ trigger: 'home_value', status: 'skipped_ineligible', skip: { reason: 'NO_ESTIMATE', text: 'No estimate available.' }, fact: { source: 'home_valuation' } });
    expect(JSON.stringify(r.body)).not.toMatch(/unchanged/i);
    // and a second pass the same month neither asks again nor fires again (an unavailable answer counts)
    await avmPass(h, w.tenantId);
    expect(avmCallsFor(h, c.line1)).toBe(1);
    expect(await triggerRuns(h, c.id)).toHaveLength(1);
  });

  it('R-AVM-2: a range over avm_max_range_bps ⇒ a draft; older than platform:avm max_age_days (35) or not displayable ⇒ a visible skip', async () => {
    const wide = await pastClient(h, w, w.agents[0]!);
    avm().answers.set(key(wide), { kind: 'estimate', estimate: { valueCents: 40_000_000, lowCents: 34_000_000, highCents: 46_000_000 } }); // 3000 bps > 2500
    const old = await pastClient(h, w, w.agents[0]!);
    const d = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10); // 40 days: stale under the pack's 35, fresh under core's 45
    avm().answers.set(key(old), { kind: 'estimate', estimate: { asOf: d } });
    const hidden = await pastClient(h, w, w.agents[0]!);
    avm().answers.set(key(hidden), { kind: 'estimate', estimate: { displayAllowed: false } });
    await withAvmCleared(h, async () => {
      await avmPass(h, w.tenantId);
      for (const c of [wide, old, hidden]) await firingsDue(h, c.id);
      await reconcileAndRun(h, w.tenantId);
    });
    const [wr] = await triggerRuns(h, wide.id);
    expect(wr!.status).toBe('converted_to_draft');
    expect((await actionsOf(h, wide.id)).find((a) => a.id === wr!.assistant_action_id)!.payload['draftReasons']).toEqual(['AVM_RANGE_TOO_WIDE']);
    expect((await triggerRuns(h, old.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: { reason: 'ESTIMATE_STALE', text: 'The estimate is out of date.' } }) });
    expect((await triggerRuns(h, hidden.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: expect.objectContaining({ reason: 'ESTIMATE_NOT_DISPLAYABLE' }) }) });
    expect((await valuationsOf(h, hidden.addressId))[0]!.display_allowed).toBe(false);
    for (const c of [wide, old, hidden]) expect(await homeMail(c.id)).toEqual([]);
    // the tenant's limit is data: a looser limit lets the same width through (read, never written by an API route)
    expect((await h.su.query('SELECT avm_max_range_bps FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0].avm_max_range_bps).toBe(2500);
  });
});

describe('R-AVM-3 who is asked, at most once a month per address', () => {
  it('R-AVM-3 R-NURT-2: at most one recorded answer and one firing per address and UTC month over repeated passes; a second vendor call only after a vendor error', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    avm().answers.set(key(c), { kind: 'error' });
    expect((await avmPass(h, w.tenantId)).failed).toBeGreaterThanOrEqual(1);
    expect(await valuationsOf(h, c.addressId)).toEqual([]); // a vendor error writes no row (no status 'error') and fires nothing
    expect(await triggerRuns(h, c.id)).toEqual([]);
    avm().answers.delete(key(c));
    for (let i = 0; i < 3; i++) await avmPass(h, w.tenantId);
    expect(avmCallsFor(h, c.line1)).toBe(2); // the error, then the one answer
    expect((await valuationsOf(h, c.addressId)).map((v) => v.status)).toEqual(['ok']);
    expect((await triggerRuns(h, c.id)).map((r) => r.trigger_key)).toEqual([`avm:${c.addressId}:${month()}`]);
  });

  it('R-AVM-3: two workers running the pass at once still record one answer and fire once per address and month', async () => {
    const cs = [await pastClient(h, w, w.agents[0]!), await pastClient(h, w, w.agents[0]!), await pastClient(h, w, w.agents[0]!)];
    await Promise.all([avmPass(h, w.tenantId), avmPass(h, w.tenantId), avmPass(h, w.tenantId)]);
    for (const c of cs) {
      expect((await valuationsOf(h, c.addressId)).length, c.line1).toBe(1);
      expect(await triggerRuns(h, c.id)).toHaveLength(1);
    }
  });

  it('R-AVM-3: two workers draining the queue run the tenant\'s one avm.refresh job once: one vendor call, one answer and one firing per address', async () => {
    const { enqueueJob } = await import('@realty/db');
    const { createWorker } = await import('../worker/loop.js');
    const { HandlerRegistry } = await import('../worker/registry.js');
    const { silentLogger } = await import('../worker/observability.js');
    const { makeNurtureHandlers } = await import('./handlers.js');
    const { depsFromPlatform } = await import('../comms/runtime.js');
    const cs = [await pastClient(h, w, w.agents[0]!), await pastClient(h, w, w.agents[0]!)];
    // the periodic job is one live row per tenant (dedupe periodic:{kind}); a second enqueue is a no-op
    for (let i = 0; i < 2; i++) await withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => enqueueJob(tx, { queue: 'default', kind: 'avm.refresh', payload: {}, dedupeKey: 'periodic:avm.refresh' }), { db: h.database });
    const deps = depsFromPlatform(h.app.platform);
    const registry = new HandlerRegistry().registerAll(makeNurtureHandlers(() => deps));
    const worker = (n: number) => createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 1, worker: `avm-${n}-${randomUUID().slice(0, 6)}`, idleMs: 10, log: silentLogger });
    await Promise.all([worker(1).drain(10), worker(2).drain(10)]);
    for (const c of cs) {
      expect(avmCallsFor(h, c.line1)).toBe(1);
      expect(await valuationsOf(h, c.addressId)).toHaveLength(1);
      expect(await triggerRuns(h, c.id)).toHaveLength(1);
    }
  });

  it('R-AVM-3: no call for an opted-out, suppressed or person-level do-not-contact client, an unowned one, one no approved playbook covers, a non-client, or a deleted or incomplete address', async () => {
    const a0 = w.agents[0]!;
    const optedOut = await pastClient(h, w, a0);
    expect((await call(a0, 'POST', `/contacts/${optedOut.id}/consent`, { kind: 'revoke', pointId: await pointId(h, optedOut.id, 'email'), channel: 'email', purpose: 'all', evidence: {} })).status).toBe(200);
    const suppressed = await pastClient(h, w, a0);
    const hmac = (await h.su.query<{ h: Buffer }>("SELECT address_hmac AS h FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [suppressed.id])).rows[0]!.h;
    await h.su.query("INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, source_ref) VALUES ($1, $2, 'email', $3, 'x', 'email', 'internal_dnc', '{}'::jsonb)", [w.tenantId, randomUUID(), hmac]);
    const dnc = await pastClient(h, w, a0);
    expect((await call(a0, 'POST', `/contacts/${dnc.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    const unowned = await pastClient(h, w, a0);
    expect((await command(a0, unowned.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    const uncovered = await pastClient(h, w, w.agents[1]!); // agent 1 approved no After-closing alerts
    const notClient = await pastClient(h, w, a0, { closedAt: new Date(Date.now() + 365 * 86_400_000) });
    await h.su.query("UPDATE deals SET stage = 'under_contract', closed_at = NULL WHERE id = $1", [notClient.dealId]);
    const thisMonth = await pastClient(h, w, a0, { closedAt: new Date() }); // closed this month: from next month on
    const deleted = await pastClient(h, w, a0);
    expect((await call(a0, 'DELETE', `/contacts/${deleted.id}/addresses/${deleted.addressId}`)).status).toBe(200);
    const incomplete = await pastClient(h, w, a0, { city: null });
    const property = await pastClient(h, w, a0, { kind: 'property' }); // owner question (b): kind 'home' only
    await avmPass(h, w.tenantId);
    for (const c of [optedOut, suppressed, dnc, unowned, uncovered, notClient, thisMonth, deleted, incomplete, property]) {
      expect(avmCallsFor(h, c.line1), c.line1).toBe(0);
      expect(await triggerRuns(h, c.id)).toEqual([]);
    }
    const rows = (await h.su.query('SELECT count(*)::int AS n FROM home_valuations WHERE contact_id = ANY ($1)', [[optedOut, suppressed, dnc, unowned, uncovered, notClient, thisMonth, deleted, incomplete, property].map((c) => c.id)])).rows[0].n;
    expect(rows).toBe(0);
  });

  it('R-NURT-5: a paused client still gets the valuation, as a draft for the agent', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Thanks for everything')).statusCode).toBe(200);
    await withAvmCleared(h, () => refreshAndRun(c));
    expect(await valuationsOf(h, c.addressId)).toHaveLength(1);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('converted_to_draft');
    const d = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    expect(d.payload['draftReasons']).toContain('PAUSED');
    expect(await homeMail(c.id)).toEqual([]);
  });

  it('R-NURT-5: a reply cancels the scheduled home-value run; nothing is sent', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    await withAvmCleared(h, async () => {
      await avmPass(h, w.tenantId);
      expect((await triggerRuns(h, c.id)).map((r) => r.status)).toEqual(['scheduled']);
      expect((await inboundSms(h, c.phone, w.mainNumber, 'Call me')).statusCode).toBe(200);
      expect((await triggerRuns(h, c.id)).map((r) => r.status)).toEqual(['canceled_paused']);
      await firingsDue(h, c.id);
      await reconcileAndRun(h, w.tenantId);
    });
    expect(await homeMail(c.id)).toEqual([]);
  });

  it('R-INT-1: with no AVM vendor configured (production\'s unconfigured bag) nothing is requested or written, and GET /nurture/triggers says "not set up on this platform yet"', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    const u = createUnconfiguredIntegrations();
    const r = await avmRefresh({ db: h.database, ids: depsOf(h).ids, avm: u.avm }, w.tenantId);
    expect(r).toMatchObject({ configured: false, requested: 0, recorded: 0 });
    expect(await valuationsOf(h, c.addressId)).toEqual([]);
    expect(await triggerRuns(h, c.id)).toEqual([]);
    const real = h.app.platform.providers.integrations;
    const saved = real.avm;
    real.avm = u.avm;
    try {
      const t = await call<{ triggers: { trigger: string; availability: string; note: string | null }[] }>(w.agents[0]!, 'GET', '/nurture/triggers');
      expect(t.body.triggers.find((x) => x.trigger === 'home_value')).toEqual({ trigger: 'home_value', availability: 'not_available_yet', label: 'Monthly home value estimate', note: 'Home values are not set up on this platform yet.' });
    } finally {
      real.avm = saved;
    }
    // clean up: this client is due for the next test's passes
    await avmPass(h, w.tenantId);
  });
});

describe('send-time rechecks of a home-value run (R-NURT-4, R-NURT-7, R-GATE-14)', () => {
  /** Records the valuation and its firing; returns the run. */
  async function fired(c: PastClient) {
    await avmPass(h, w.tenantId);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('scheduled');
    await firingsDue(h, c.id);
    return run!;
  }

  it('R-NURT-4: an address deleted or edited before sending ⇒ ADDRESS_NOT_CURRENT, never sent', async () => {
    const del = await pastClient(h, w, w.agents[0]!);
    const edit = await pastClient(h, w, w.agents[0]!);
    await withAvmCleared(h, async () => {
      await fired(del);
      await fired(edit);
      expect((await call(w.agents[0]!, 'DELETE', `/contacts/${del.id}/addresses/${del.addressId}`)).status).toBe(200);
      expect((await call(w.agents[0]!, 'PATCH', `/contacts/${edit.id}/addresses/${edit.addressId}`, { kind: 'home', line1: '1 Elsewhere Rd', city: 'Springfield', region: 'SC', postalCode: '29401' })).status).toBe(200);
      await reconcileAndRun(h, w.tenantId);
    });
    for (const c of [del, edit]) {
      expect(await homeMail(c.id)).toEqual([]);
      expect((await triggerRuns(h, c.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: { reason: 'ADDRESS_NOT_CURRENT', text: 'This is no longer the contact’s current address.' } }) });
    }
  });

  it('R-NURT-7: an owner change before sending ⇒ OWNER_CHANGED (the agent\'s playbook stops for that client)', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    await withAvmCleared(h, async () => {
      await fired(c);
      expect((await command(w.owner, c.id, 'reassign', { toUserId: w.agents[1]!.userId })).status).toBe(200);
      await reconcileAndRun(h, w.tenantId);
    });
    expect(await homeMail(c.id)).toEqual([]);
    expect((await triggerRuns(h, c.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: expect.objectContaining({ reason: 'OWNER_CHANGED' }) }) });
  });

  it('R-GATE-14 D1: an unsubscribe after the note was queued ⇒ a gate_decisions row and no provider call', async () => {
    const c = await pastClient(h, w, w.agents[0]!);
    await withAvmCleared(h, async () => {
      const run = await fired(c);
      await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run.id, now), { db: h.database });
      const [m] = await homeMail(c.id);
      expect(m!.status).toBe('queued');
      expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: await pointId(h, c.id, 'email'), channel: 'email', purpose: 'all', evidence: {} })).status).toBe(200);
      await runJobs(h, w.tenantId, ['comms.dispatch']);
      const [after] = await homeMail(c.id);
      expect(after!.status).toBe('blocked');
      expect((await decisionsFor(h, { messageId: m!.id }))[0]!.reason_codes).toContain('CONSENT_REVOKED');
    });
    expect(h.providers.email.sent.filter((x) => x.to === c.email)).toEqual([]);
  });
});

describe('F7 one sender; R-AST-20 the reworded template', () => {
  it('F7: with platform:avm cleared, the v1 post-closing enrollment\'s home_value step still skips; After closing v2 has no home-value step', async () => {
    const { approvedPlaybook } = await import('../assistant/testing.js');
    const { enrollOnDealClosed } = await import('../assistant/enrollments.js');
    const { stepNow } = await import('../assistant/testing.js');
    const { templateByKey } = await import('../assistant/templates.js');
    expect(templateByKey('post_closing')!.steps.map((s) => s.intent)).not.toContain('home_value_update');
    const agent = w.agents[0]!;
    const v1 = await approvedPlaybook(agent, {
      kind: 'post_closing',
      scope: 'agent',
      name: 'After closing (v1, with a home value step)',
      steps: [{ stepKey: 'home_value', channel: 'email', delay: { anchor: 'event', offsetSeconds: 60 }, purpose: 'marketing', category: 'nurture_step', intent: 'home_value_update', subject: 'Your home', template: 'Hi {{first_name}}, your monthly update is ready.', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: [] }],
    });
    expect(v1.versionId).toBeTruthy();
    const c = await pastClient(h, w, agent, { closedAt: new Date(Date.now() - 3_600_000) });
    await withAvmCleared(h, async () => {
      const ens = await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), c.dealId, depsOf(h));
      const mine = (await h.su.query<{ id: string }>('SELECT id FROM playbook_enrollments WHERE id = ANY ($1) AND playbook_version_id = $2', [ens, v1.versionId])).rows;
      expect(mine).toHaveLength(1);
      for (let i = 0; i < 2; i++) {
        await stepNow(h, w.tenantId, mine[0]!.id);
        await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
      }
      const step = (await h.su.query("SELECT status FROM playbook_step_runs WHERE enrollment_id = $1 AND step_key = 'home_value'", [mine[0]!.id])).rows;
      expect(step).toEqual([{ status: 'skipped_ineligible' }]);
    });
    expect((await messagesOf(h, c.id)).filter((m) => m.body.includes('monthly update is ready'))).toEqual([]);
  });

  it('R-AST-20: the reworded After-closing alerts validate (never PLAYBOOK_INVALID); the composed note passes the content guard and authorizeAutonomousAction (its prices are not read as payment or money wording)', async () => {
    const { validatePlaybookContent, contentGuard, triggerStepAsPlaybookStep } = await import('@realty/core/assistant');
    const { templateByKey } = await import('../assistant/templates.js');
    const { identityFacts } = await import('../assistant/repos/context.js');
    const t = templateByKey('after_closing_alerts')!;
    expect(t.templateVersion).toBe(2);
    expect(validatePlaybookContent(t.content!, { kind: 'trigger' })).toEqual([]);
    const hv = (t.content as TriggersContent).triggers.find((x) => x.trigger === 'home_value')!;
    expect(hv.template).not.toMatch(/unchanged/i);
    // the approved version (beforeAll) carries the reworded template exactly
    const stored = (await h.su.query<{ steps: { triggers: { trigger: string; template: string }[] } }>('SELECT steps FROM playbook_versions WHERE id = $1', [alerts.versionId])).rows[0]!.steps;
    expect(stored.triggers.find((x) => x.trigger === 'home_value')!.template).toBe(hv.template);
    const c = await pastClient(h, w, w.agents[0]!);
    await withAvmCleared(h, () => refreshAndRun(c));
    const [run] = await triggerRuns(h, c.id);
    const action = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    // an autonomous_message exists only when authorizeAutonomousAction allowed the exact text and the guard found nothing
    expect(action).toMatchObject({ kind: 'autonomous_message', status: 'executed' });
    const body = String(action.payload['body']);
    expect(body).toContain('This is an estimate, not an appraisal.');
    const identity = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => identityFacts(tx, { scope: 'agent', agentUserId: w.agents[0]!.userId! }), { db: h.database });
    const g = contentGuard(body, triggerStepAsPlaybookStep(hv), identity, { firstInThread: false, requireSignOff: true });
    expect(g.hardBlock).toBe(false);
    expect(g.issues).toEqual([]);
    void beforeThisMonth;
  });
});

describe('R-AVM-3 the selection (property over real Postgres)', () => {
  it('R-AVM-3: in any order of vendor outcomes and over any number of passes (sometimes two at once), an address gets at most one answer and one firing a UTC month; the vendor is asked again only after a failure', async () => {
    const fc = (await import('fast-check')).default;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ outcome: fc.constantFrom('error' as const, 'unavailable' as const, 'ok' as const), twice: fc.boolean() }), { minLength: 1, maxLength: 4 }), async (passes) => {
        const c = await pastClient(h, w, w.agents[0]!);
        let answered = false;
        let expectedCalls = 0;
        for (const p of passes) {
          avm().answers.set(key(c), p.outcome === 'ok' ? { kind: 'estimate', estimate: {} } : { kind: p.outcome });
          const before = avmCallsFor(h, c.line1);
          if (p.twice) await Promise.all([avmPass(h, w.tenantId), avmPass(h, w.tenantId)]);
          else await avmPass(h, w.tenantId);
          const made = avmCallsFor(h, c.line1) - before;
          if (answered) expect(made).toBe(0);
          else expect(made).toBeGreaterThanOrEqual(1);
          expectedCalls += made;
          if (p.outcome !== 'error') answered = true;
        }
        const vals = (await valuationsOf(h, c.addressId)).filter((v) => v.status === 'ok' || v.status === 'unavailable');
        expect(vals.length).toBe(answered ? 1 : 0);
        expect((await valuationsOf(h, c.addressId)).some((v) => v.status === 'error')).toBe(false);
        expect((await triggerRuns(h, c.id)).length).toBe(answered ? 1 : 0);
        expect(avmCallsFor(h, c.line1)).toBe(expectedCalls);
      }),
      { numRuns: 10 },
    );
  });
});
