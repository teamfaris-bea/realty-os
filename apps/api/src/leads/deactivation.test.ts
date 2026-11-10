// Staged, resumable member deactivation (R-OWN-22, E12, E13, E58) through the API and the
// `leads.deactivate` job.
import { randomUUID } from 'node:crypto';
import { deactivationCommandId } from '@realty/core/ownership';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { silentLogger, memoryAlerts } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { type DeactivatePayload, deactivationHandler } from './deactivation.js';
import { type LeadsWorld, call, contactState, freshReauth, intake, jobs, ledger, leadsWorker, leadsWorld, randomPhone, registerPush } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function selfCreated(c: TestClient, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await call<{ contact: { id: string } }>(c, 'POST', '/contacts', { commandId: randomUUID(), displayName: `Lead ${i}`, phones: [randomPhone()] });
    if (r.status !== 201) throw new Error(`create ${r.status}`);
    out.push(r.body.contact.id);
  }
  return out;
}

async function offersTo(w: LeadsWorld, agent: TestClient, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let k = 0; k < 6 * n && out.length < n; k++) {
    const r = await intake(h, w);
    if ((await contactState(h, r.contactId)).offered_to_user_id === agent.userId) out.push(r.contactId);
  }
  if (out.length < n) throw new Error('could not route offers to the agent');
  return out;
}

describe('R-OWN-22 staged deactivation', () => {
  it('R-OWN-22 E12 E58: preview, then stage 1 (deactivating, sessions + devices revoked) in one transaction; the job rescinds and re-routes offers, moves owned contacts one transaction each (open-deal contacts to the Team Lead, never a pond), and finally marks the member removed', async () => {
    const w = await leadsWorld(h, { agents: 2, teamLead: true });
    const [a, b] = w.agents as [TestClient, TestClient];
    const owned = await selfCreated(a, 40);
    const offers = await offersTo(w, a, 2);
    // one owned contact has an open deal (E58)
    const dealContact = owned[0]!;
    await withTenantTx(w.owner.actor(), async (tx) => {
      const { sql } = await import('kysely');
      await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
                VALUES (app.tenant_id(), ${randomUUID()}::uuid, 'Lead 0 purchase', 'buy', 'active', now(), ${dealContact}::uuid, ${a.userId}::uuid)`.execute(tx);
    }, { db: h.database });
    await freshReauth(h, w.owner);
    const preview = await call<{ deactivation: Record<string, unknown> }>(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'preview', destination: 'default_pond' });
    expect(preview.status).toBe(200);
    expect(preview.body.deactivation).toMatchObject({ mode: 'preview', status: 'active', owned: 40, offered: 2, ownedWithOpenDeal: 1, teamLead: { userId: w.teamLead!.userId }, deactivationId: null });
    expect((await contactState(h, owned[1]!)).owner_user_id).toBe(a.userId); // preview changes nothing

    const run = await call<{ deactivation: { status: string; deactivationId: string } }>(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(run.status).toBe(202);
    expect(run.body.deactivation.status).toBe('deactivating');
    const m = (await h.su.query('SELECT status, accepting_leads FROM memberships WHERE user_id = $1 AND tenant_id = $2', [a.userId, w.tenantId])).rows[0];
    expect(m).toEqual({ status: 'deactivating', accepting_leads: false });
    expect((await h.su.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1 AND revoked_at IS NULL', [a.userId])).rows[0].n).toBe(0);
    expect((await call(a, 'GET', '/contacts/' + owned[1])).status).toBe(401); // sessions revoked
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'member.deactivation_started' AND entity_id = $1", [a.userId])).rows[0].n).toBe(1);

    await leadsWorker(h).drain();

    for (const id of owned.slice(1)) {
      const st = await contactState(h, id);
      expect([id, st.ownership_state, st.pond_id]).toEqual([id, 'in_pond', w.defaultPondId]);
    }
    const deal = await contactState(h, dealContact);
    expect([deal.ownership_state, deal.owner_user_id]).toEqual(['owned', w.teamLead!.userId]);
    for (const id of offers) {
      const st = await contactState(h, id);
      expect(st.offered_to_user_id).not.toBe(a.userId);
      expect(st.ownership_state === 'offered' ? st.offered_to_user_id : st.ownership_state).toBe(st.ownership_state === 'offered' ? b.userId : 'in_pond');
      expect((await ledger(h, id)).some((e) => e.type === 'offer_rescinded' && e.reason_code === 'OWNER_DEACTIVATED')).toBe(true);
    }
    // one deactivate_owner command per contact, with command_id = hash(deactivation_id, contact_id)
    const cmd = (await h.su.query<{ command_id: string }>("SELECT command_id FROM lead_ownership_events WHERE contact_id = $1 AND reason_code = 'OWNER_DEACTIVATED' LIMIT 1", [owned[5]])).rows[0]!.command_id;
    expect(cmd).toBe(deactivationCommandId(run.body.deactivation.deactivationId, owned[5] as never));
    const done = (await h.su.query('SELECT status, removed_at IS NOT NULL AS removed FROM memberships WHERE user_id = $1 AND tenant_id = $2', [a.userId, w.tenantId])).rows[0];
    expect(done).toEqual({ status: 'removed', removed: true });
    expect((await h.su.query("SELECT actor_kind FROM audit_log WHERE action = 'member.removed' AND entity_id = $1", [a.userId])).rows).toEqual([{ actor_kind: 'system' }]);
    // nothing is left with the removed member
    expect((await h.su.query('SELECT count(*)::int AS n FROM contacts WHERE owner_user_id = $1 OR offered_to_user_id = $1', [a.userId])).rows[0].n).toBe(0);
  });

  it('R-OWN-22: the job is resumable and idempotent: a crash part-way and a re-run move each contact exactly once', async () => {
    const w = await leadsWorld(h, { agents: 2, teamLead: true });
    const a = w.agents[0]!;
    const owned = await selfCreated(a, 12);
    await freshReauth(h, w.owner);
    const run = await call<{ deactivation: { deactivationId: string } }>(w.owner, 'POST', `/members/${a.userId}/deactivate`, { mode: 'run', destination: 'team_lead' });
    expect(run.status).toBe(202);
    const job = (await jobs(h, w.tenantId, 'leads.deactivate'))[0]!;
    const handler = deactivationHandler();
    const actor = systemActor(w.tenantId, 'worker');
    let calls = 0;
    const ctx = (crashAt: number | null) => ({
      actor,
      now: Date.now() as never,
      providers: h.providers,
      job: { id: 1n, kind: handler.kind, queue: handler.queue, attempts: 1 },
      log: silentLogger,
      alerts: memoryAlerts(),
      withTx: <T>(fn: (tx: never, now: never) => Promise<T>) => {
        calls += 1;
        if (crashAt !== null && calls === crashAt) throw new Error('worker killed');
        return withTenantTx(actor, fn as never, { db: h.database }) as Promise<T>;
      },
    });
    await expect(handler.run(ctx(6), job.payload as DeactivatePayload)).rejects.toThrow('worker killed');
    const movedEarly = (await h.su.query("SELECT count(*)::int AS n FROM contacts WHERE id = ANY ($1::uuid[]) AND owner_user_id = $2", [owned, w.teamLead!.userId])).rows[0].n;
    expect(movedEarly).toBeGreaterThan(0);
    expect(movedEarly).toBeLessThan(12);
    calls = 0;
    await handler.run(ctx(null), job.payload as DeactivatePayload);
    await handler.run(ctx(null), job.payload as DeactivatePayload); // a duplicate delivery
    for (const id of owned) {
      const ev = (await ledger(h, id)).filter((e) => e.reason_code === 'OWNER_DEACTIVATED');
      expect(ev).toHaveLength(1);
      expect((await contactState(h, id)).owner_user_id).toBe(w.teamLead!.userId);
    }
    expect((await h.su.query('SELECT status FROM memberships WHERE user_id = $1 AND tenant_id = $2', [a.userId, w.tenantId])).rows[0].status).toBe('removed');
  });

  it('R-OWN-22 E13: routing that picks an agent while their deactivation commits serializes on the membership row: the agent never ends up holding the lead', async () => {
    const w = await leadsWorld(h, { agents: 1, teamLead: true });
    for (let i = 0; i < 4; i++) {
      const agent = await h.invite(w.owner, 'agent');
      await registerPush(agent);
      await freshReauth(h, w.owner);
      const put = await call(w.owner, 'PUT', `/routing-rules/${w.ruleId}/members`, [{ userId: agent.userId, weight: 1 }]);
      expect(put.status).toBe(200);
      const [lead, dep] = await Promise.all([intake(h, w), call(w.owner, 'POST', `/members/${agent.userId}/deactivate`, { mode: 'run', destination: 'default_pond' })]);
      expect(dep.status).toBe(202);
      await leadsWorker(h).drain();
      const st = await contactState(h, lead.contactId);
      expect([st.owner_user_id, st.offered_to_user_id].includes(agent.userId)).toBe(false);
      expect(['in_pond', 'offered']).toContain(st.ownership_state);
      expect((await h.su.query('SELECT status FROM memberships WHERE user_id = $1 AND tenant_id = $2', [agent.userId, w.tenantId])).rows[0].status).toBe('removed');
    }
  });

  it('R-OWN-22 R-PERM-13: deactivation is Owner/Admin with fresh re-auth; an Admin cannot deactivate an Owner; nobody deactivates themselves', async () => {
    const w = await leadsWorld(h, { agents: 1, others: ['admin'] });
    const admin = (w as LeadsWorld & { others: TestClient[] }).others[0]!;
    const target = w.agents[0]!;
    expect((await call(target, 'POST', `/members/${w.owner.userId}/deactivate`, { mode: 'preview' })).status).toBe(404);
    await freshReauth(h, admin);
    const onOwner = await call(admin, 'POST', `/members/${w.owner.userId}/deactivate`, { mode: 'preview' });
    expect([onOwner.status, onOwner.code]).toEqual([403, 'OWNER_REQUIRED']);
    await freshReauth(h, w.owner);
    const self = await call(w.owner, 'POST', `/members/${w.owner.userId}/deactivate`, { mode: 'run' });
    expect([self.status, self.code]).toEqual([409, 'DEACTIVATION_NOT_ALLOWED']);
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1", [w.owner.userId]);
    const stale = await call(w.owner, 'POST', `/members/${target.userId}/deactivate`, { mode: 'run' });
    expect([stale.status, stale.code]).toEqual([401, 'REAUTH_REQUIRED']);
  });
});
