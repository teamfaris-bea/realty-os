// Module 45 role × route matrix (DATA_MODEL §8 "Client portal", split into portal.view and portal.manage; R-PERM-5,
// E690). The routes answer exactly what core can() says; every denial is 404.
import { type Action, type SupportActor, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { call, client, deal, invite, portalWorld, setPortalCleared, type PortalWorld } from '../testing.js';

let h: ApiHarness;
let w: PortalWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
}, 240_000);
afterAll(async () => {
  await setPortalCleared(h, false).catch(() => undefined);
  await h?.close();
});

describe('R-PERM-5 E690 portal.view and portal.manage', () => {
  it('E690: invite on a deal: Owner, Admin, the team lead of the deal owner and the owning agent may; another agent, the ISA, the TC and support may not (404)', async () => {
    const agent = w.agents[0]!;
    const results: Record<string, number> = {};
    for (const [name, who] of [['owner', w.owner], ['admin', w.admin], ['team_lead', w.teamLead!], ['agent', agent], ['other agent', w.agents[1]!], ['isa', w.isa], ['tc', w.tc]] as const) {
      const c = await client(agent);
      const d = await deal(agent, c.id);
      // the TC and the ISA are members of the deal (the strongest case for them)
      await call(w.owner, 'POST', `/deals/${d}/members`, { userId: w.tc.userId, role: 'tc' });
      await call(w.owner, 'POST', `/deals/${d}/members`, { userId: w.isa.userId, role: 'isa' });
      results[name] = (await invite(who, d, c.id)).status;
    }
    expect(results).toEqual({ owner: 200, admin: 200, team_lead: 200, agent: 200, 'other agent': 404, isa: 404, tc: 404 });
    const support: SupportActor = { kind: 'support', userId: '00000000-0000-7000-8000-00000000aaaa' as never, tenantId: w.tenantId as never, grantId: 'g' };
    for (const a of ['portal.view', 'portal.manage'] as Action[]) expect(can(support, a, { own: true, deal: true, team: true }).ok, a).toBe(false);
    for (const via of ['worker', 'timer', 'assistant', 'provider', 'import'] as const) {
      expect(can({ kind: 'system', tenantId: w.tenantId as never, via }, 'portal.manage', { own: true }).ok).toBe(false);
    }
  });

  it('R-PERM-5: the deal portal view: Owner, Admin, the team lead, the owning agent and the deal TC may; another agent and the ISA may not', async () => {
    const agent = w.agents[0]!;
    const c = await client(agent);
    const d = await deal(agent, c.id);
    await call(w.owner, 'POST', `/deals/${d}/members`, { userId: w.tc.userId, role: 'tc' });
    await call(w.owner, 'POST', `/deals/${d}/members`, { userId: w.isa.userId, role: 'isa' });
    const inv = await invite(agent, d, c.id);
    const out: Record<string, [number, number, number]> = {};
    for (const [name, who] of [['owner', w.owner], ['admin', w.admin], ['team_lead', w.teamLead!], ['agent', agent], ['tc', w.tc], ['other agent', w.agents[1]!], ['isa', w.isa]] as const) {
      out[name] = [
        (await call(who, 'GET', `/deals/${d}/portal`)).status,
        (await call(who, 'GET', `/portal-grants/${inv.body.grant.id}/preview`)).status,
        (await call(who, 'POST', `/portal-grants/${inv.body.grant.id}/revoke`)).status === 404 ? 404 : 0,
      ];
    }
    expect(out).toEqual({
      owner: [200, 200, 0], admin: [200, 200, 0], team_lead: [200, 200, 0], agent: [200, 200, 0],
      tc: [200, 200, 404], 'other agent': [404, 404, 404], isa: [404, 404, 404],
    });
  });

  it('R-PERM-5: the matrix in core is exactly DATA_MODEL §8 (view ✅ | ✅ | T | own, deal | — | deal; manage ✅ | ✅ | T | own | — | —)', () => {
    const user = (role: 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc') => ({ kind: 'user' as const, userId: 'u' as never, tenantId: 't' as never, role, sessionId: 's' });
    const cell = (role: Parameters<typeof user>[0], a: Action) =>
      (['own', 'team', 'deal'] as const).filter((k) => can(user(role), a, { [k]: true }).ok).join('+') + (can(user(role), a, {}).ok ? '+all' : '');
    expect(Object.fromEntries((['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as const).map((r) => [r, [cell(r, 'portal.view'), cell(r, 'portal.manage')]]))).toEqual({
      owner: ['own+team+deal+all', 'own+team+deal+all'],
      admin: ['own+team+deal+all', 'own+team+deal+all'],
      team_lead: ['own+team', 'own+team'],
      agent: ['own+deal', 'own'],
      isa: ['', ''],
      tc: ['deal', ''],
    });
  });
});
