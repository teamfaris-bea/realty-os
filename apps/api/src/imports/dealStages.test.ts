// The deal-stage screen's API (Owner/Admin). Synthetic Follow Up Boss records only.
// Saving the map writes a held deal once, leaves an ignored stage out, and a second save
// does not add another deal. An agent cannot see it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenantTx } from '@realty/db';
import { type ImportWorld, type ImportsHarness, approve, call, commitStage, dryRunStage, fullStage, importWorld, importsHarness, records, startFub } from './testing.js';

const KEY = 'fub-deal-stage-map';

let ih: ImportsHarness;
let w: ImportWorld;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
  ih.fub.add(KEY, {
    users: [{ id: 11, name: 'Alex Agent' }],
    people: [{ id: 1, firstName: 'Ada', lastName: 'Lovelace', stage: 'Active', assignedUserId: 11, emails: [{ value: 'ada.stage.map@example.com', type: 'home' }] }],
    deals: [
      { id: 1, name: 'Known stage', status: 'Active', price: 10, stageName: 'Active', pipelineName: 'Buyers', peopleIds: [1], userIds: [11] },
      { id: 2, name: 'Waiting deal', status: 'Active', price: 20, stageName: 'Waiting On Lender', pipelineName: 'Buyers', peopleIds: [1], userIds: [11] },
      { id: 3, name: 'Parked deal', status: 'Active', price: 30, stageName: 'Parked', pipelineName: 'Buyers', peopleIds: [1], userIds: [11] },
      { id: 4, name: 'Waiting, no person', status: 'Active', price: 40, stageName: 'Waiting On Lender', pipelineName: 'Buyers', peopleIds: [404], userIds: [11] },
    ],
  });
  ih.fub.add('fub-deal-stage-remap', {
    users: [{ id: 11, name: 'Alex Agent' }],
    people: [{ id: 1, firstName: 'Ada', lastName: 'Lovelace', stage: 'Active', assignedUserId: 11, emails: [{ value: 'ada.remap@example.com', type: 'home' }] }],
    deals: [{ id: 8, name: 'Paperwork', status: 'Active', price: 50, stageName: 'Waiting On Lender', pipelineName: 'Buyers', peopleIds: [1], userIds: [11] }],
  });
});
afterAll(async () => {
  await ih?.close();
});

async function imported(): Promise<string> {
  const b = await startFub(ih, w.owner, KEY);
  const map = await call(w.owner, 'PUT', `/imports/${b.id}/user-mappings`, {
    mappings: [{ sourceRef: '11', kind: 'user', target: { kind: 'user', userId: w.agents[0]!.userId } }],
  });
  if (map.status !== 200) throw new Error(`mapping: ${map.status}`);
  for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent', 'deals'] as const) await fullStage(ih, w.owner, b.id, cat);
  return b.id;
}

describe('deal stage map', () => {
  let batchId = '';

  it('lists every stage with its deals, and an agent cannot read or save it', async () => {
    batchId = await imported();
    const g = await call<{ stages: { label: string; deals: number; suggested: string | null; choice: string | null }[]; unmappedDeals: number }>(w.owner, 'GET', `/imports/${batchId}/deal-stages`);
    expect(g.status).toBe(200);
    expect(g.body.unmappedDeals).toBe(3);
    expect(g.body.stages.find((s) => s.label === 'Active')).toMatchObject({ deals: 1, suggested: 'active' });
    expect(g.body.stages.find((s) => s.label === 'Waiting On Lender')).toMatchObject({ deals: 2, suggested: null, choice: null });
    expect(g.body.stages.find((s) => s.label === 'Parked')).toMatchObject({ deals: 1, suggested: null });
    expect((await call(w.agents[0]!, 'GET', `/imports/${batchId}/deal-stages`)).status).toBe(404);
    expect((await call(w.agents[0]!, 'PUT', `/imports/${batchId}/deal-stages`, { dealStageMap: { Parked: 'lost' } })).status).toBe(404);
    expect((await call(w.owner, 'PUT', `/imports/${batchId}/deal-stages`, { dealStageMap: { Parked: 'not-a-stage' } })).status).toBe(422);
  });

  it('saving imports a held deal once, leaves an ignored stage out, and keeps a deal with no person in review', async () => {
    const before = (await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [w.tenantId]))[0]!.n;
    const put = await call<{ importedNow: number; ignoredNow: number; unmappedDeals: number; approvalCleared: boolean }>(w.owner, 'PUT', `/imports/${batchId}/deal-stages`, {
      dealStageMap: { 'Waiting On Lender': 'active', Parked: 'ignore' },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ importedNow: 1, ignoredNow: 1, unmappedDeals: 0, approvalCleared: false });
    const deals = await q<{ name: string; stage: string }>('SELECT name, stage FROM deals WHERE tenant_id = $1 ORDER BY name', [w.tenantId]);
    expect(deals.map((d) => d.name)).toEqual(['Known stage', 'Waiting deal']);
    expect(deals.find((d) => d.name === 'Waiting deal')!.stage).toBe('active');
    expect(deals).toHaveLength(before + 1);
    const held = await records(w.owner, batchId, 'deals', 'needs_review');
    expect(held.map((r) => r.sourceRef)).toEqual(['fub:deals/4']);
    expect(held[0]!.issues.map((i) => i.code)).toContain('PARENT_NOT_FOUND');
    expect(held[0]!.issues.map((i) => i.code)).not.toContain('STAGE_UNMAPPED');
    const ignored = await records(w.owner, batchId, 'deals', 'rejected');
    expect(ignored.find((r) => r.sourceRef === 'fub:deals/3')!.issues.map((i) => i.code)).toContain('STAGE_IGNORED');
    const refs = await q<{ n: number }>("SELECT count(*)::int AS n FROM external_refs WHERE tenant_id = $1 AND entity_type = 'deal' AND external_id = '2'", [w.tenantId]);
    expect(refs[0]!.n).toBe(1);
    const history = await q<{ actor_kind: string; from_stage: string | null; changed_by_user_id: string | null }>(
      `SELECT h.actor_kind, h.from_stage, h.changed_by_user_id FROM deal_stage_history h
         JOIN deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
        WHERE d.tenant_id = $1 AND d.name = 'Waiting deal'`,
      [w.tenantId],
    );
    expect(history).toEqual([{ actor_kind: 'system', from_stage: null, changed_by_user_id: null }]);
    const verified = await call<{ matches: boolean }>(w.owner, 'GET', `/imports/${batchId}/stages/deals/verification`);
    expect(verified.status).toBe(200);
    expect(verified.body.matches).toBe(true);

    const again = await call<{ importedNow: number; ignoredNow: number }>(w.owner, 'PUT', `/imports/${batchId}/deal-stages`, {
      dealStageMap: { 'Waiting On Lender': 'active', Parked: 'ignore' },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ importedNow: 0, ignoredNow: 0 });
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(before + 1);
    // The person shows up later. The held deal is still in the resolver, and this save writes it once.
    await ih.h.su.query(
      `INSERT INTO external_refs (tenant_id, system, entity_type, external_id, entity_id, import_batch_id)
       SELECT $1, 'fub', 'contact', '404', c.id, $2::uuid FROM contacts c
        WHERE c.tenant_id = $1 AND c.display_name = 'Ada Lovelace'`,
      [w.tenantId, batchId],
    );
    const linked = await call<{ importedNow: number }>(w.owner, 'PUT', `/imports/${batchId}/deal-stages`, {
      dealStageMap: { 'Waiting On Lender': 'active', Parked: 'ignore' },
    });
    expect(linked.status).toBe(200);
    expect(linked.body.importedNow).toBe(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND name = $2', [w.tenantId, 'Waiting, no person']))[0]!.n).toBe(1);
    const linkedAgain = await call<{ importedNow: number }>(w.owner, 'PUT', `/imports/${batchId}/deal-stages`, {
      dealStageMap: { 'Waiting On Lender': 'active', Parked: 'ignore' },
    });
    expect(linkedAgain.body.importedNow).toBe(0);

    const bring = await call<{ importedNow: number }>(w.owner, 'PUT', `/imports/${batchId}/deal-stages`, {
      dealStageMap: { 'Waiting On Lender': 'active', Parked: 'active' },
    });
    expect(bring.status).toBe(200);
    expect(bring.body.importedNow).toBe(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND name = $2', [w.tenantId, 'Parked deal']))[0]!.n).toBe(1);
    const repeat = await call<{ importedNow: number }>(w.owner, 'PUT', `/imports/${batchId}/deal-stages`, {
      dealStageMap: { 'Waiting On Lender': 'active', Parked: 'active' },
    });
    expect(repeat.body.importedNow).toBe(0);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND name = $2', [w.tenantId, 'Parked deal']))[0]!.n).toBe(1);

    const audit = await q<{ action: string; reason: string; actor: string }>(
      "SELECT action, reason, actor_role AS actor FROM audit_log WHERE tenant_id = $1 AND reason = 'DEAL_STAGE_MAP' ORDER BY seq",
      [w.tenantId],
    );
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(audit.every((r) => r.action === 'settings.changed' && r.actor === 'owner')).toBe(true);
    const changes = await q<{ changes: { deal_stage_map?: { to?: string } } }>(
      "SELECT changes FROM audit_log WHERE tenant_id = $1 AND reason = 'DEAL_STAGE_MAP' ORDER BY seq LIMIT 1",
      [w.tenantId],
    );
    expect(changes[0]!.changes.deal_stage_map?.to).toContain('Waiting On Lender');
    expect(changes[0]!.changes.deal_stage_map?.to).toContain('ignore');
    const still = await call<{ matches: boolean }>(w.owner, 'GET', `/imports/${batchId}/stages/deals/verification`);
    expect(still.body.matches).toBe(true);
  });

  it('a later choice replaces a plan that has not been imported, and agreement signed is not a user scoreboard event', async () => {
    const b = await startFub(ih, w.owner, 'fub-deal-stage-remap');
    const map = await call(w.owner, 'PUT', `/imports/${b.id}/user-mappings`, {
      mappings: [{ sourceRef: '11', kind: 'user', target: { kind: 'user', userId: w.agents[0]!.userId } }],
    });
    expect(map.status).toBe(200);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) await fullStage(ih, w.owner, b.id, cat);
    const dry = await dryRunStage(ih, w.owner, b.id, 'deals');
    const unmapped = await records(w.owner, b.id, 'deals', 'needs_review');
    expect(unmapped).toHaveLength(1);
    const refused = await call(w.owner, 'POST', `/imports/${b.id}/records/${unmapped[0]!.id}/review`, { decision: 'import' });
    expect(refused.status).toBe(422);
    expect(refused.code).toBe('IMPORT_REVIEW_INVALID');
    const first = await call<{ plannedNow: number; importedNow: number }>(w.owner, 'PUT', `/imports/${b.id}/deal-stages`, { dealStageMap: { 'Waiting On Lender': 'active' } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ plannedNow: 1, importedNow: 0 });
    const approved = await approve(w.owner, b.id, 'deals', dry.dryRunSha256 as string);
    expect(approved.status).toBe(200);
    const second = await call<{ plannedNow: number; approvalCleared: boolean; importedNow: number }>(w.owner, 'PUT', `/imports/${b.id}/deal-stages`, { dealStageMap: { 'Waiting On Lender': 'agreement_signed' } });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ plannedNow: 1, approvalCleared: true, importedNow: 0 });
    const planned = await records(w.owner, b.id, 'deals', 'will_import');
    expect(planned).toHaveLength(1);
    // Re-approve the updated plan. No new dry run: the save replaced the stored stage, and the old plan must not win.
    const batch = await call<{ batch: { stages: { category: string; status: string; dryRunSha256: string | null }[] } }>(w.owner, 'GET', `/imports/${b.id}`);
    const deals = batch.body.batch.stages.find((s) => s.category === 'deals');
    expect(deals?.status).toBe('dry_run_ready');
    const ok = await approve(w.owner, b.id, 'deals', deals!.dryRunSha256 as string);
    expect(ok.status).toBe(200);
    const committed = await commitStage(ih, w.owner, b.id, 'deals');
    expect(committed.status).toBe('committed');
    const row = await q<{ stage: string }>('SELECT stage FROM deals WHERE tenant_id = $1 AND name = $2', [w.tenantId, 'Paperwork']);
    expect(row[0]!.stage).toBe('agreement_signed');
    const history = await q<{ actor_kind: string; from_stage: string | null; changed_by_user_id: string | null; to_stage: string }>(
      `SELECT h.actor_kind, h.from_stage, h.changed_by_user_id, h.to_stage FROM deal_stage_history h
         JOIN deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
        WHERE d.tenant_id = $1 AND d.name = 'Paperwork'`,
      [w.tenantId],
    );
    expect(history).toEqual([{ actor_kind: 'system', from_stage: null, changed_by_user_id: null, to_stage: 'agreement_signed' }]);
    const signed = await withTenantTx(
      w.agents[0]!.actor(),
      async (tx) => Number((await sql<{ n: string }>`SELECT agreements_signed::text AS n FROM app.scoreboard_activity(${[w.agents[0]!.userId]}::uuid[], now() - interval '2 days', now() + interval '1 hour')`.execute(tx)).rows[0]!.n),
      { db: ih.h.database },
    );
    expect(signed).toBe(0);
  });
});
