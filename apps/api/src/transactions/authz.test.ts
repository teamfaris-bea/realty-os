// Authorization of api/transactions, role × route, checked against core can() (R-PERM-5, DATA_MODEL §8 "Confirm or move
// a milestone date": ✅ | ✅ | T | O / D | — | D; milestone templates: Owner/Admin). A denial is 404, never 403. Also the
// cross-tenant isolation of every route and both handlers (R-TEN-6).
import { type Action, type ResourceFacts, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type TxnWorld, call, dateChanged, dateRow, deal, enterDate, legacyDate, localDay, putTemplates, reconcile, template, txnWorld } from './testing.js';

let h: ApiHarness;
let w: TxnWorld;
let other: TxnWorld;

beforeAll(async () => {
  h = await createApiHarness();
  [w, other] = await Promise.all([txnWorld(h), txnWorld(h)]);
  await putTemplates(w.owner, [template()]);
});
afterAll(async () => {
  await h?.close();
});

interface Case {
  name: string;
  client: () => TestClient;
  facts: ResourceFacts;
}

describe('R-PERM-5 role × route against can()', () => {
  it('milestone.confirm and deal.view routes: Owner/Admin any deal, Team Lead their team\'s, an agent own deals or deals they are on, a TC only deals they are on, an ISA never confirms', async () => {
    const d = await deal(h, w, w.agents[0]!); // the TC is a member
    const member = await deal(h, w, w.agents[0]!, { tc: false });
    expect((await call(w.owner, 'POST', `/deals/${member.dealId}/members`, { userId: w.agents[1]!.userId, role: 'co_agent' })).status).toBe(200);
    expect((await call(w.owner, 'POST', `/deals/${member.dealId}/members`, { userId: w.isa.userId, role: 'isa' })).status).toBe(200);
    const cases: (Case & { dealId: string })[] = [
      { name: 'owner', client: () => w.owner, facts: {}, dealId: d.dealId },
      { name: 'admin', client: () => w.admin, facts: {}, dealId: d.dealId },
      { name: 'team lead (team member\'s deal)', client: () => w.teamLead!, facts: { team: true }, dealId: d.dealId },
      { name: 'agent (own deal)', client: () => w.agents[0]!, facts: { own: true }, dealId: d.dealId },
      { name: 'agent (not on the deal)', client: () => w.agents[1]!, facts: {}, dealId: d.dealId },
      { name: 'agent (co-agent member)', client: () => w.agents[1]!, facts: { deal: true }, dealId: member.dealId },
      { name: 'isa (member)', client: () => w.isa, facts: { deal: true }, dealId: member.dealId },
      { name: 'tc (member)', client: () => w.tc, facts: { deal: true }, dealId: d.dealId },
      { name: 'tc (not on the deal)', client: () => w.tc, facts: {}, dealId: member.dealId },
    ];
    for (const c of cases) {
      const date = (await enterDate(w.owner, c.dealId, 'inspection', localDay(w.zone, 30))).body.date.id;
      const routes: { action: Action; method: 'GET' | 'POST' | 'PATCH'; url: string; body?: unknown }[] = [
        { action: 'deal.view', method: 'GET', url: `/deals/${c.dealId}/milestones` },
        { action: 'milestone.confirm', method: 'POST', url: `/deals/${c.dealId}/milestones/plan`, body: { acceptanceDate: localDay(w.zone), templateId: 'purchase-test', templateVersion: 1 } },
        { action: 'milestone.confirm', method: 'POST', url: `/deals/${c.dealId}/dates`, body: { kind: 'closing', dueOn: localDay(w.zone, 40) } },
        { action: 'milestone.confirm', method: 'POST', url: `/deal-dates/${date}/confirm`, body: { reminderDaysBefore: 1 } },
        { action: 'milestone.confirm', method: 'PATCH', url: `/deal-dates/${date}`, body: { label: 'Home inspection' } },
      ];
      for (const r of routes) {
        const client = c.client();
        const allowed = can(client.actor(), r.action, { tenantId: client.actor().tenantId, ...c.facts }).ok;
        const res = await call(client, r.method, r.url, r.body);
        // invisible deals are 404 by RLS before can() runs; a visible deal the role may not act on is 404 from can()
        expect([c.name, r.method, r.url.split('/').slice(0, 2).join('/') + '/…' + r.url.split('/').slice(3).join('/'), allowed ? 'allowed' : 404]).toEqual([
          c.name,
          r.method,
          r.url.split('/').slice(0, 2).join('/') + '/…' + r.url.split('/').slice(3).join('/'),
          allowed ? (res.status === 404 ? 'denied' : 'allowed') : res.status,
        ]);
      }
    }
  });

  it('milestone_template.manage: Owner/Admin only; everyone else 404', async () => {
    for (const c of [w.owner, w.admin, w.teamLead!, w.agents[0]!, w.isa, w.tc]) {
      const allowed = can(c.actor(), 'milestone_template.manage', {}).ok;
      const g = await call(c, 'GET', '/settings/milestone-templates');
      const p = await call(c, 'PUT', '/settings/milestone-templates', { templates: [template()] });
      expect([c.actor().role, g.status, p.status]).toEqual([c.actor().role, allowed ? 200 : 404, allowed ? 200 : 404]);
    }
  });

  it('the TC board lists only the open deals the caller\'s RLS returns (a TC: the deals they are on)', async () => {
    const mine = await deal(h, w, w.agents[0]!);
    const notMine = await deal(h, w, w.agents[0]!, { tc: false });
    await enterDate(w.agents[0]!, mine.dealId, 'closing', localDay(w.zone, 5));
    await enterDate(w.agents[0]!, notMine.dealId, 'closing', localDay(w.zone, 5));
    const tc = await call<{ deals: { id: string }[] }>(w.tc, 'GET', '/transactions/board');
    expect(tc.status).toBe(200);
    expect(tc.body.deals.map((x) => x.id)).toContain(mine.dealId);
    expect(tc.body.deals.map((x) => x.id)).not.toContain(notMine.dealId);
    const owner = await call<{ deals: { id: string }[] }>(w.owner, 'GET', '/transactions/board');
    expect(owner.body.deals.map((x) => x.id)).toEqual(expect.arrayContaining([mine.dealId, notMine.dealId]));
    const isa = await call<{ deals: { id: string }[] }>(w.isa, 'GET', '/transactions/board');
    expect(isa.body.deals.map((x) => x.id)).not.toContain(mine.dealId);
  });
});

describe('R-TEN-6 cross-tenant isolation of every route and handler', () => {
  it('R-TEN-6: another tenant\'s deal and date ids are 404 on every route, and its templates are never read', async () => {
    await putTemplates(other.owner, [template({ id: 'theirs' })]);
    const theirs = await deal(h, other, other.agents[0]!);
    const date = (await enterDate(other.agents[0]!, theirs.dealId, 'closing', localDay(other.zone, 9))).body.date.id;
    for (const c of [w.owner, w.admin, w.tc, w.agents[0]!]) {
      expect((await call(c, 'GET', `/deals/${theirs.dealId}/milestones`)).status).toBe(404);
      expect((await call(c, 'POST', `/deals/${theirs.dealId}/milestones/plan`, { acceptanceDate: localDay(w.zone), templateId: 'theirs', templateVersion: 1 })).status).toBe(404);
      expect((await call(c, 'POST', `/deals/${theirs.dealId}/dates`, { kind: 'closing', dueOn: localDay(w.zone, 3) })).status).toBe(404);
      expect((await call(c, 'POST', `/deal-dates/${date}/confirm`, {})).status).toBe(404);
      expect((await call(c, 'PATCH', `/deal-dates/${date}`, { completed: true })).status).toBe(404);
      const b = await call<{ deals: { id: string }[] }>(c, 'GET', '/transactions/board');
      expect(b.body.deals.map((x) => x.id)).not.toContain(theirs.dealId);
    }
    const g = await call<{ parsed: { id: string }[] }>(w.owner, 'GET', '/settings/milestone-templates');
    expect(g.body.parsed.map((t) => t.id)).not.toContain('theirs');
    expect(await dateRow(h, date)).toMatchObject({ completed_at: null, due_version: 1 });
  });

  it('R-TEN-6: milestones.reconcile and milestones.date_changed in one tenant never touch another tenant\'s dates', async () => {
    const theirs = await deal(h, other, other.agents[0]!);
    const legacy = await legacyDate(h, other.tenantId, theirs.dealId, 'inspection', localDay(other.zone, 10));
    await reconcile(h, w.tenantId);
    expect((await dateRow(h, legacy)).due_at).toBeNull();
    expect(await dateChanged(h, w.tenantId, legacy)).toEqual({ skipped: 0, canceled: 0 });
    await reconcile(h, other.tenantId);
    expect((await dateRow(h, legacy)).due_at).not.toBeNull();
  });
});
