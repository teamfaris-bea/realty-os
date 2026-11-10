// Deals over real Postgres as app_user (BUILD_PLAN module 14: attribution copied at create, stage history,
// commission capture; A7d, R-PERM-10, R-PERM-4 E50, R-PERM-5).
import { type TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { acceptedLead, call, contactOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;
let tc: WorkspaceWorld['owner'];
let isa: WorkspaceWorld['owner'];

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: true, others: ['tc', 'isa'] });
  [tc, isa] = w.others as [typeof tc, typeof isa];
});
afterAll(async () => {
  await h?.close();
});

interface Deal {
  id: string;
  stage: string;
  rowVersion: number;
  ownerUserId: string;
  attribution: { leadSourceId: string | null; leadSourceName: string | null; campaignRef: string | null; adRef: string | null; sourceInquiryId: string | null };
  history: { fromStage: string | null; toStage: string }[];
  members: { userId: string; role: string }[];
  dates: { id: string }[];
  closedAt: string | null;
}

async function newDeal(agent: WorkspaceWorld['owner'], contactId: string, body: Record<string, unknown> = {}): Promise<Deal> {
  const r = await call<{ deal: Deal }>(agent, 'POST', '/deals', { primaryContactId: contactId, side: 'buy', ...body });
  if (r.status !== 201) throw new Error(`deal: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.deal;
}

describe('deals', () => {
  it('A7d: one call creates the deal from the contact and copies its lead source, campaign, ad and originating inquiry; attribution never changes', async () => {
    const { contactId, owner } = await acceptedLead(h, w, { campaignRef: 'spring-open-house', adRef: 'fb-ad-7' });
    const inquiry = (await h.su.query<{ id: string }>('SELECT id FROM lead_inquiries WHERE contact_id = $1', [contactId])).rows[0]!.id;
    const d = await newDeal(owner, contactId, { priceCents: 65_000_000 });
    expect(d.attribution).toEqual({ leadSourceId: w.sourceId, leadSourceName: 'Portal', campaignRef: 'spring-open-house', adRef: 'fb-ad-7', sourceInquiryId: inquiry });
    expect(d.ownerUserId).toBe(owner.userId);
    expect(d.history).toEqual([expect.objectContaining({ fromStage: null, toStage: 'prospect' })]);
    // no input can carry attribution
    expect((await call(owner, 'POST', '/deals', { primaryContactId: contactId, side: 'buy', leadSourceId: w.sourceId })).code).toBe('VALIDATION_FAILED');
    expect((await call(owner, 'PATCH', `/deals/${d.id}`, { rowVersion: d.rowVersion, campaignRef: 'other' })).code).toBe('VALIDATION_FAILED');
    // and the DB refuses a change even from a direct write by a permitted user (trigger)
    await expect(
      withTenantTx(owner.actor(), (tx) => sql`UPDATE deals SET campaign_ref = 'tampered' WHERE id = ${d.id}`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/ATTRIBUTION_IMMUTABLE/);
  });

  it('stage changes append history, stamp milestones, need a reason for `lost`, and use the row version', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a);
    let d = await newDeal(a, c.id, { side: 'sell' });
    const stage = async (body: Record<string, unknown>) => call<{ deal: Deal }>(a, 'POST', `/deals/${d.id}/stage`, body);
    expect((await stage({ rowVersion: d.rowVersion, stage: 'prospect' })).code).toBe('DEAL_STAGE_INVALID');
    expect((await stage({ rowVersion: d.rowVersion + 5, stage: 'active' })).code).toBe('VERSION_CONFLICT');
    expect((await stage({ rowVersion: d.rowVersion, stage: 'lost' })).code).toBe('DEAL_STAGE_INVALID');
    let r = await stage({ rowVersion: d.rowVersion, stage: 'under_contract' });
    expect(r.status).toBe(200);
    d = r.body.deal;
    r = await stage({ rowVersion: d.rowVersion, stage: 'closed' });
    d = r.body.deal;
    expect(d.stage).toBe('closed');
    expect(d.closedAt).not.toBeNull();
    expect(d.history.map((x) => `${x.fromStage}>${x.toStage}`)).toEqual(['null>prospect', 'prospect>under_contract', 'under_contract>closed']);
    // the post-closing playbook decision is api/assistant's: closing enqueues it
    const job = await h.su.query("SELECT payload FROM jobs WHERE kind = 'assistant.deal_closed' AND payload->>'dealId' = $1", [d.id]);
    expect(job.rows).toHaveLength(1);
    r = await stage({ rowVersion: d.rowVersion, stage: 'lost', lostReason: 'financing fell through' });
    expect(r.body.deal).toMatchObject({ stage: 'lost', closedAt: null });
  });

  it('R-PERM-10: commission is read and written only by humans: the deal owner, their Team Lead and Owner/Admin; never TC, ISA, other agents or the system', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const c = await contactOf(a);
    const d = await newDeal(a, c.id);
    expect((await call(a, 'GET', `/deals/${d.id}/financials`)).body).toEqual({ financials: null });
    const put = await call<{ financials: { grossCommissionCents: number; agentSplitBps: number; updatedByUserId: string } }>(a, 'PUT', `/deals/${d.id}/financials`, { grossCommissionCents: 1_800_000, commissionRateBps: 250, teamSplitBps: 3000, agentSplitBps: 7000 });
    expect(put.status).toBe(200);
    expect(put.body.financials).toMatchObject({ grossCommissionCents: 1_800_000, agentSplitBps: 7000, updatedByUserId: a.userId });
    // splits over 100 % are refused
    expect((await call(a, 'PUT', `/deals/${d.id}/financials`, { teamSplitBps: 6000, agentSplitBps: 7000 })).code).toBe('VALIDATION_FAILED');
    // the TL of the owner's team and the Owner can; the TC and ISA on the deal and another agent cannot (404)
    expect((await call(w.teamLead!, 'GET', `/deals/${d.id}/financials`)).status).toBe(200);
    expect((await call(w.owner, 'PUT', `/deals/${d.id}/financials`, { commissionStatus: 'confirmed' })).status).toBe(200);
    for (const m of [tc, isa]) expect((await call(a, 'POST', `/deals/${d.id}/members`, { userId: m.userId, role: m === tc ? 'tc' : 'isa' })).status).toBe(200);
    for (const who of [tc, isa]) {
      expect((await call(who, 'GET', `/deals/${d.id}`)).status).toBe(200); // they are on the deal
      expect((await call(who, 'GET', `/deals/${d.id}/financials`)).code).toBe('NOT_FOUND');
      expect((await call(who, 'PUT', `/deals/${d.id}/financials`, { grossCommissionCents: 1 })).code).toBe('NOT_FOUND');
    }
    expect((await call(b, 'GET', `/deals/${d.id}/financials`)).code).toBe('NOT_FOUND');
    // even a direct read as a TC finds no row (RLS), and the system actor can neither read nor write
    const tcRows = await withTenantTx(tc.actor(), (tx) => sql`SELECT 1 FROM deal_financials WHERE deal_id = ${d.id}`.execute(tx), { db: h.database });
    expect(tcRows.rows).toHaveLength(0);
    const sys = systemActor(w.tenantId as TenantId, 'assistant');
    const sysRows = await withTenantTx(sys, (tx) => sql`SELECT 1 FROM deal_financials WHERE deal_id = ${d.id}`.execute(tx), { db: h.database });
    expect(sysRows.rows).toHaveLength(0);
    await expect(
      withTenantTx(sys, (tx) => sql`INSERT INTO deal_financials (tenant_id, deal_id, commission_status, updated_by_user_id) VALUES (app.tenant_id(), ${d.id}, 'paid', ${a.userId})`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/row-level security|duplicate key/);
    // every human write is audited with a money diff (not PII: values kept)
    const audit = await h.su.query<{ actor_user_id: string; changes: Record<string, { from: unknown; to: unknown }> }>(
      "SELECT actor_user_id, changes FROM audit_log WHERE action = 'deal.financials_changed' AND entity_id = $1 ORDER BY seq",
      [d.id],
    );
    expect(audit.rows.map((x) => x.actor_user_id)).toEqual([a.userId, w.owner.userId]);
    expect(audit.rows[0]!.changes.gross_commission_cents).toEqual({ from: null, to: 1_800_000 });
    expect(audit.rows[1]!.changes).toEqual({ commission_status: { from: 'estimated', to: 'confirmed' } });
  });

  it('R-PERM-4 E50: a TC removed from a deal loses the deal and its contact on the next request', async () => {
    const a = w.agents[1]!;
    const c = await contactOf(a);
    const d = await newDeal(a, c.id);
    expect((await call(tc, 'GET', `/deals/${d.id}`)).code).toBe('NOT_FOUND');
    expect((await call(a, 'POST', `/deals/${d.id}/members`, { userId: tc.userId, role: 'tc' })).status).toBe(200);
    expect((await call(tc, 'GET', `/deals/${d.id}`)).status).toBe(200);
    expect((await call(tc, 'GET', `/contacts/${c.id}`)).status).toBe(200);
    expect((await call<{ deals: { id: string }[] }>(tc, 'GET', '/deals')).body.deals.map((x) => x.id)).toContain(d.id);
    expect((await call(a, 'DELETE', `/deals/${d.id}/members/${tc.userId}`)).status).toBe(200);
    expect((await call(tc, 'GET', `/deals/${d.id}`)).code).toBe('NOT_FOUND');
    expect((await call(tc, 'GET', `/contacts/${c.id}`)).code).toBe('NOT_FOUND');
    expect((await call<{ deals: { id: string }[] }>(tc, 'GET', '/deals')).body.deals.map((x) => x.id)).not.toContain(d.id);
  });

  it('a TC on the deal edits key dates only; the deal itself stays the agent’s', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a);
    const d = await newDeal(a, c.id);
    await call(a, 'POST', `/deals/${d.id}/members`, { userId: tc.userId, role: 'tc' });
    const date = await call<{ date: { id: string; completedAt: string | null } }>(tc, 'POST', `/deals/${d.id}/dates`, { kind: 'inspection', dueOn: '2026-12-01' });
    expect(date.status).toBe(201);
    const done = await call<{ date: { completedAt: string | null; dueOn: string } }>(tc, 'PATCH', `/deal-dates/${date.body.date.id}`, { completed: true, dueOn: '2026-12-02' });
    expect(done.body.date.completedAt).not.toBeNull();
    expect(done.body.date.dueOn).toBe('2026-12-02');
    expect((await call(tc, 'POST', `/deals/${d.id}/dates`, { kind: 'custom', dueOn: '2026-12-03' })).code).toBe('VALIDATION_FAILED');
    expect((await call(tc, 'PATCH', `/deals/${d.id}`, { rowVersion: d.rowVersion, name: 'Renamed' })).code).toBe('FIELDS_NOT_PERMITTED');
    expect((await call(tc, 'POST', `/deals/${d.id}/stage`, { rowVersion: d.rowVersion, stage: 'active' })).code).toBe('FIELDS_NOT_PERMITTED');
  });

  it('R-PERM-5: deals on contacts the caller cannot see are NOT_FOUND to create and to read', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const theirs = await contactOf(b);
    expect((await call(a, 'POST', '/deals', { primaryContactId: theirs.id, side: 'buy' })).code).toBe('NOT_FOUND');
    const d = await newDeal(b, theirs.id);
    expect((await call(a, 'GET', `/deals/${d.id}`)).code).toBe('NOT_FOUND');
    expect((await call(a, 'PATCH', `/deals/${d.id}`, { rowVersion: 1, name: 'x' })).code).toBe('NOT_FOUND');
    // the Team Lead of b's team sees and edits it; an ISA cannot create deals
    expect((await call(w.teamLead!, 'GET', `/deals/${d.id}`)).status).toBe(200);
    const isaContact = await contactOf(isa);
    expect((await call(isa, 'POST', '/deals', { primaryContactId: isaContact.id, side: 'buy' })).code).toBe('NOT_FOUND');
  });
});
