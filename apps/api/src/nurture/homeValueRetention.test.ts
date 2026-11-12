// Retention of home values (R-DATA-6; batch 8 review db-public/F5): app.purge_home_valuations, called first by every
// avm.refresh pass. Real Postgres (app_user, RLS), the deterministic fake AVM and fake email/texting; no real call.
// The superuser pool only moves stored instants (clock fixtures: valued_at back by 12 or 14 months) and reads back.
// E553, E554.
import { randomUUID } from 'node:crypto';
import type { Actor, TenantId } from '@realty/core/foundation';
import { withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { actionsOf, call, depsOf, inboundSms } from '../assistant/testing.js';
import { FAKE_AVM_PROVIDER } from '../providers/integrations/fakes.js';
import type { AvmProvider } from '../providers/integrations/types.js';
import { systemActor } from '../worker/systemActor.js';
import { avmRefresh } from './avm.js';
import { type NurtureWorld, type PastClient, approveTemplate, avmPass, firingsDue, nurtureWorld, pastClient, reconcileAndRun, triggerRuns, withAvmCleared } from './testing.js';

let h: ApiHarness;
let a: NurtureWorld;
let b: NurtureWorld;

beforeAll(async () => {
  h = await createApiHarness();
  a = await nurtureWorld(h);
  b = await nurtureWorld(h);
  await approveTemplate(a.agents[0]!, 'after_closing_alerts');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const purge = (actor: Actor) =>
  withTenantTx(actor, async (tx) => (await sql<{ valuations_deleted: number }>`SELECT * FROM app.purge_home_valuations()`.execute(tx)).rows[0]!.valuations_deleted, { db: h.database });

/** An ok valuation of the client's home recorded `months` months ago (clock fixture: the vendor answered then). */
async function oldValuation(tenantId: string, c: PastClient, months: number): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO home_valuations (tenant_id, id, contact_id, contact_address_id, provider, value_cents, low_cents, high_cents, valued_at, status, as_of, display_allowed)
     VALUES ($1, $2, $3, $4, $5, 40000000, 38000000, 42000000, now() - make_interval(months => $6::int), 'ok', (now() - make_interval(months => $6::int))::date, true)`,
    [tenantId, id, c.id, c.addressId, FAKE_AVM_PROVIDER, months],
  );
  return id;
}

/** The one valuation the refresh recorded for the client this month, and the run that cites it. */
async function citedValuation(c: PastClient): Promise<{ valuationId: string; run: Awaited<ReturnType<typeof triggerRuns>>[number] }> {
  const [run] = await triggerRuns(h, c.id);
  if (!run) throw new Error('fixture: no home-value run');
  const ref = run.trigger_ref['ref'] as { kind: string; valuationId: string };
  expect(ref.kind).toBe('home_value');
  return { valuationId: ref.valuationId, run };
}

/** Moves a valuation's stored instant back by `months` months (clock fixture). */
async function age(valuationId: string, months: number): Promise<void> {
  await h.su.query('UPDATE home_valuations SET valued_at = valued_at - make_interval(months => $2::int) WHERE id = $1', [valuationId, months]);
}

const exists = async (id: string) => (await h.su.query('SELECT 1 FROM home_valuations WHERE id = $1', [id])).rowCount === 1;

describe('R-DATA-6: app.purge_home_valuations', () => {
  it('R-DATA-6 E553: rows older than 13 months go; a row cited by a scheduled run and one by a proposed draft stay; one cited by an executed draft goes; another tenant\'s rows stay; counts returned', async () => {
    const agent = a.agents[0]!;
    // a scheduled run: the refresh recorded this month's value and the firing waits for its send time
    const scheduled = await pastClient(h, a, agent);
    // two paused clients: the refresh turns each firing into a draft for the agent (R-NURT-5)
    const proposed = await pastClient(h, a, agent);
    const executed = await pastClient(h, a, agent);
    for (const c of [proposed, executed]) expect((await inboundSms(h, c.phone, a.mainNumber, 'Thanks for everything')).statusCode).toBe(200);
    await withAvmCleared(h, async () => {
      await avmPass(h, a.tenantId);
      for (const c of [proposed, executed]) await firingsDue(h, c.id);
      await reconcileAndRun(h, a.tenantId);
    });
    const s = await citedValuation(scheduled);
    expect(s.run.status).toBe('scheduled');
    const p = await citedValuation(proposed);
    const e = await citedValuation(executed);
    for (const x of [p, e]) expect(x.run.status).toBe('converted_to_draft');
    // the agent sends one draft: its action is executed, the run stays converted_to_draft
    const ap = await call(agent, 'POST', `/assistant/actions/${e.run.assistant_action_id}/approve`, { commandId: randomUUID() });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect((await actionsOf(h, executed.id)).find((x) => x.id === e.run.assistant_action_id)!.status).toBe('executed');
    expect((await actionsOf(h, proposed.id)).find((x) => x.id === p.run.assistant_action_id)!.status).toBe('proposed');
    expect((await triggerRuns(h, executed.id))[0]!.status).toBe('converted_to_draft');
    // all three cited rows are now 14 months old (clock fixture)
    for (const x of [s, p, e]) await age(x.valuationId, 14);
    // uncited rows: 14 months old goes, 12 months old stays
    const plain = await pastClient(h, a, agent);
    const old = await oldValuation(a.tenantId, plain, 14);
    const recent = await oldValuation(a.tenantId, plain, 12);
    // another tenant's 14-month-old row
    const other = await pastClient(h, b, b.agents[0]!);
    const otherOld = await oldValuation(b.tenantId, other, 14);

    expect(await purge(systemActor(a.tenantId, 'provider'))).toBe(2);
    expect(await exists(old)).toBe(false);
    expect(await exists(e.valuationId)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(s.valuationId)).toBe(true);
    expect(await exists(p.valuationId)).toBe(true);
    expect(await exists(otherOld)).toBe(true);
    // a second pass finds nothing more; tenant B's own pass removes B's row only
    expect(await purge(systemActor(a.tenantId, 'provider'))).toBe(0);
    expect(await purge(systemActor(b.tenantId, 'provider'))).toBe(1);
    expect(await exists(otherOld)).toBe(false);
    expect(await exists(s.valuationId)).toBe(true);
    // once the scheduled run settles (here: canceled by a reply), its row goes on the next pass
    expect((await inboundSms(h, scheduled.phone, a.mainNumber, 'Call me')).statusCode).toBe(200);
    expect((await triggerRuns(h, scheduled.id))[0]!.status).toBe('canceled_paused');
    expect(await purge(systemActor(a.tenantId, 'provider'))).toBe(1);
    expect(await exists(s.valuationId)).toBe(false);
    expect(await exists(p.valuationId)).toBe(true);
  });

  it('R-DATA-6 E554: a user actor, support, or no tenant is refused; no instant argument; avmRefresh purges with the vendor unconfigured', async () => {
    const c = await pastClient(h, a, a.agents[0]!);
    const old = await oldValuation(a.tenantId, c, 15);
    const support: Actor = { kind: 'support', userId: a.owner.userId!, tenantId: a.tenantId as TenantId, grantId: randomUUID() };
    for (const actor of [a.owner.actor(), a.agents[0]!.actor(), support]) await expect(purge(actor)).rejects.toThrow(/HOME_VALUE_PURGE_SYSTEM_ONLY/);
    await expect(withPreTenant(async (tx) => sql`SELECT * FROM app.purge_home_valuations()`.execute(tx), { db: h.database })).rejects.toThrow(/HOME_VALUE_PURGE_SYSTEM_ONLY/);
    await expect(withTenantTx(systemActor(a.tenantId, 'worker'), async (tx) => sql`SELECT * FROM app.purge_home_valuations(now())`.execute(tx), { db: h.database })).rejects.toThrow(/does not exist/);
    // app_user itself still has no DELETE on the table
    await expect(withTenantTx(systemActor(a.tenantId, 'worker'), async (tx) => sql`DELETE FROM home_valuations`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
    expect(await exists(old)).toBe(true);
    // the pass purges first, with no vendor configured, and never reaches the vendor
    let vendorCalls = 0;
    const unconfigured: AvmProvider = {
      configured: false,
      estimate: async () => {
        vendorCalls += 1;
        throw new Error('no vendor');
      },
    };
    const fakeCalls = h.providers.integrations.avm.calls.length;
    const r = await avmRefresh({ db: h.database, ids: depsOf(h).ids, avm: unconfigured }, a.tenantId);
    expect(r).toEqual({ configured: false, purged: 1, requested: 0, recorded: 0, fired: 0, failed: 0, skipped: 0 });
    expect(await exists(old)).toBe(false);
    expect(vendorCalls).toBe(0);
    expect(h.providers.integrations.avm.calls.length).toBe(fakeCalls);
  });
});
