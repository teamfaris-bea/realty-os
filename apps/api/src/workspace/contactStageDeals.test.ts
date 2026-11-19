// A contact's stage never rewrites a deal (R-STG-7, E772). A person's stage says how far the relationship has come;
// a deal has its own stage, its own dates and its own history, and one person can have several. Moving the person
// through every stage key changes no deal row and writes no deal history. Through the real server; fakes only.
import { STAGES } from '@realty/core/parity/people';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, contactOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;
let a: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 1 });
  a = w.agents[0]!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

type Deal = { deal: { id: string; rowVersion: number; stage: string } };

describe('a contact\'s stage never rewrites a deal (R-STG-7)', () => {
  it('R-STG-7 E772 a person with two deals in different deal stages: the person goes through every stage key, and both deals, their history and their dates are unchanged', async () => {
    const c = await contactOf(a);
    const mk = async (name: string, side: string, stage: string) => {
      const d = await call<Deal>(a, 'POST', '/deals', { primaryContactId: c.id, side, name });
      if (d.status !== 201) throw new Error(`deal: ${d.status} ${JSON.stringify(d.body)}`);
      const s = await call<Deal>(a, 'POST', `/deals/${d.body.deal.id}/stage`, { rowVersion: d.body.deal.rowVersion, stage });
      if (s.status !== 200) throw new Error(`deal stage: ${s.status} ${JSON.stringify(s.body)}`);
      return d.body.deal.id;
    };
    const buying = await mk('Elm St purchase', 'buy', 'under_contract');
    const selling = await mk('Oak Ave sale', 'sell', 'agreement_signed');
    const snapshot = async () => ({
      deals: (await h.su.query('SELECT to_jsonb(d) AS row FROM deals d WHERE d.id = ANY($1::uuid[]) ORDER BY d.id', [[buying, selling]])).rows.map((r) => r.row),
      history: (await h.su.query('SELECT deal_id, from_stage, to_stage FROM deal_stage_history WHERE deal_id = ANY($1::uuid[]) ORDER BY deal_id, changed_at, to_stage', [[buying, selling]])).rows,
      dates: (await h.su.query('SELECT count(*)::int AS n FROM deal_dates WHERE deal_id = ANY($1::uuid[])', [[buying, selling]])).rows[0].n,
      contacts: (await h.su.query('SELECT deal_id, contact_id, role FROM deal_contacts WHERE deal_id = ANY($1::uuid[]) ORDER BY deal_id, contact_id', [[buying, selling]])).rows,
    });
    const before = await snapshot();
    expect(before.deals.map((d: { stage: string }) => d.stage).sort()).toEqual(['agreement_signed', 'under_contract']);

    // every key, in order and back again: including "closed", "lost" and "under_contract", which are deal words too
    const path = [...STAGES.filter((s) => s !== 'new'), 'new', 'closed', 'active', 'lost', 'under_contract', 'new'];
    for (const stage of path) {
      const r = await call<{ stage: { stage: string } }>(a, 'POST', `/contacts/${c.id}/stage`, { stage });
      expect(r.status, stage).toBe(200);
      expect(r.body.stage.stage, stage).toBe(stage);
      expect(await snapshot(), `after the person became ${stage}`).toEqual(before);
    }
    // the person's own history has every move, so the changes did happen
    const moves = (await h.su.query<{ t: string }>('SELECT to_stage AS t FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at, id', [c.id])).rows.map((x) => x.t);
    expect(moves).toEqual(path);
    // and the deals read the same through the API
    expect((await call<Deal>(a, 'GET', `/deals/${buying}`)).body.deal.stage).toBe('under_contract');
    expect((await call<Deal>(a, 'GET', `/deals/${selling}`)).body.deal.stage).toBe('agreement_signed');
  });

  it('R-STG-7 the other way round holds too: moving a deal does not move the person\'s stage', async () => {
    const c = await contactOf(a);
    const d = await call<Deal>(a, 'POST', '/deals', { primaryContactId: c.id, side: 'buy', name: 'Pine Rd purchase' });
    expect((await call(a, 'POST', `/contacts/${c.id}/stage`, { stage: 'connected' })).status).toBe(200);
    let rv = d.body.deal.rowVersion;
    for (const stage of ['agreement_signed', 'active', 'under_contract']) {
      const s = await call<Deal>(a, 'POST', `/deals/${d.body.deal.id}/stage`, { rowVersion: rv, stage });
      expect(s.status, stage).toBe(200);
      rv = s.body.deal.rowVersion;
      expect((await h.su.query<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [c.id])).rows[0]!.stage, stage).toBe('connected');
    }
    expect((await h.su.query('SELECT count(*)::int AS n FROM contact_stage_events WHERE contact_id = $1', [c.id])).rows[0].n).toBe(1);
  });
});
