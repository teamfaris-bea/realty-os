// FUB deals and appointments import (B7 reversed 2026-11-21). Synthetic records only, FakeFub, no live account.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { systemActor } from '../worker/systemActor.js';
import {
  type ImportWorld,
  type ImportsHarness,
  approve,
  call,
  commitStage,
  dryRunStage,
  fullStage,
  importWorld,
  importsHarness,
  records,
  startFub,
  verify,
} from './testing.js';

const KEY = 'fub-deals-appointments';
const N = 310;

let ih: ImportsHarness;
let w: ImportWorld;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

async function mapOwner(batchId: string): Promise<void> {
  const r = await call(w.admin, 'PUT', `/imports/${batchId}/user-mappings`, {
    mappings: [{ sourceRef: '11', kind: 'user', target: { kind: 'user', userId: w.agents[0]!.userId } }],
  });
  if (r.status !== 200) throw new Error(`mapping: ${r.status} ${JSON.stringify(r.body)}`);
}

const STAGES = ['Under Contract', 'Active', 'Closed', 'Lost', 'Prospect', 'Agreement Signed'] as const;
const PIPES = ['Buyers', 'Sellers', 'Lease', 'Dual'] as const;

function dataset() {
  const deals: Record<string, unknown>[] = Array.from({ length: N }, (_, i) => {
    const stageName = STAGES[i % STAGES.length]!;
    return {
      id: 1000 + i,
      name: `Synthetic deal ${i}`,
      status: 'Active',
      price: 300_000 + i,
      stageName,
      pipelineName: PIPES[i % PIPES.length],
      enteredStageAt: '2026-06-01T15:00:00Z',
      projectedCloseDate: '2026-12-15',
      mutualAcceptanceDate: '2026-06-15',
      commissionValue: 9_000,
      agentCommission: 6_300,
      teamCommission: 2_700,
      peopleIds: [1],
      userIds: [11],
      ...(stageName === 'Closed' ? { closedAt: '2026-11-01T00:00:00Z' } : {}),
      description: 'not a column',
      customField1: 'not stored',
    };
  });
  deals.push({
    id: 9001,
    name: 'Unknown stage',
    status: 'Active',
    price: 100,
    stageName: 'Waiting On Lender',
    pipelineName: 'Buyers',
    enteredStageAt: '2026-06-01T15:00:00Z',
    projectedCloseDate: '2026-12-15',
    mutualAcceptanceDate: '2026-06-15',
    commissionValue: 0,
    agentCommission: 0,
    teamCommission: 0,
    peopleIds: [1],
    userIds: [11],
    description: '',
    customField1: '',
  });
  deals.push({
    id: 9002,
    name: 'Unknown person',
    status: 'Active',
    price: 100,
    stageName: 'Active',
    pipelineName: 'Buyers',
    enteredStageAt: '2026-06-01T15:00:00Z',
    projectedCloseDate: '2026-12-15',
    mutualAcceptanceDate: '2026-06-15',
    commissionValue: 0,
    agentCommission: 0,
    teamCommission: 0,
    peopleIds: [404],
    userIds: [11],
    description: '',
    customField1: '',
  });
  const past = (id: number, day: string) => ({
    id,
    createdById: 11,
    title: `Past ${id}`,
    start: `${day}T15:00:00Z`,
    end: `${day}T16:00:00Z`,
    type: 'Buyer Consultation',
    outcome: 'Agreement signed',
    invitees: [{ userId: 11 }, { personId: 1 }],
  });
  const future = (id: number, type: string) => ({
    id,
    createdById: 11,
    title: `Future ${id}`,
    start: '2027-03-01T15:00:00Z',
    end: '2027-03-01T16:00:00Z',
    type,
    outcome: null,
    invitees: [{ userId: 11 }, { personId: 1 }],
  });
  return {
    users: [
      { id: 11, name: 'Alex Agent' },
      { id: 12, name: 'Bea Agent' },
      { id: 99, name: 'Not on the team' },
    ],
    people: [{ id: 1, firstName: 'Ada', lastName: 'Lovelace', stage: 'Active', assignedUserId: 11, emails: [{ value: 'ada.lovelace@example.com', type: 'home' }] }],
    deals,
    appointments: [
      past(1, '2024-01-10'),
      past(2, '2024-06-10'),
      past(3, '2025-02-10'),
      future(4, 'Listing Appointment'),
      future(5, 'Consult'),
      { id: 6, createdById: 99, title: 'Unmapped organizer', start: '2027-04-01T15:00:00Z', end: '2027-04-01T16:00:00Z', type: 'Other', invitees: [{ personId: 1 }, { userId: 99 }] },
    ],
    tasks: [{ id: 1, name: 'Do not import', dueDate: '2026-12-01' }],
  };
}

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
  ih.fub.add(KEY, dataset());
});
afterAll(async () => {
  await ih?.close();
});

describe('FUB deals and appointments import', () => {
  let batchId = '';

  it('imports 310 deals with no errors, holds unknown stage and unknown person for review, and keeps tasks out', async () => {
    const b = await startFub(ih, w.admin, KEY);
    batchId = b.id;
    const noted = b as typeof b & { notImported: { tasks: number | null; lines: string[] } | null };
    expect(noted.notImported).toMatchObject({ tasks: 1 });
    expect(JSON.stringify(noted.notImported)).not.toMatch(/appointment/i);
    await mapOwner(b.id);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) await fullStage(ih, w.admin, b.id, cat);
    const dry = await fullStage(ih, w.admin, b.id, 'deals');
    expect(dry.counts).toMatchObject({ source: N + 2, imported: N, needsReview: 2, rejected: 0, duplicate: 0 });
    const held = await records(w.admin, b.id, 'deals', 'needs_review');
    expect(held.map((r) => r.sourceRef).sort()).toEqual(['fub:deals/9001', 'fub:deals/9002']);
    expect(held.find((r) => r.sourceRef === 'fub:deals/9001')!.issues.map((i) => i.code)).toContain('STAGE_UNMAPPED');
    expect(held.find((r) => r.sourceRef === 'fub:deals/9002')!.issues.map((i) => i.code)).toContain('PARENT_NOT_FOUND');
    const rows = await q<{ n: number; history: number; money: number }>('SELECT (SELECT count(*)::int FROM deals WHERE tenant_id = $1) AS n, (SELECT count(*)::int FROM deal_stage_history WHERE tenant_id = $1) AS history, (SELECT count(*)::int FROM deal_financials WHERE tenant_id = $1) AS money', [w.tenantId]);
    expect(rows[0]).toEqual({ n: N, history: N, money: N });
    const sample = await q<{ price_cents: string; stage: string; side: string }>('SELECT price_cents::text, stage, side FROM deals WHERE tenant_id = $1 AND name = $2', [w.tenantId, 'Synthetic deal 0']);
    expect(sample[0]).toEqual({ price_cents: String(300_000 * 100), stage: 'under_contract', side: 'buy' });
    expect(await q('SELECT 1 FROM tasks WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
  });

  it('a historical agreement imported today is not an agreement signed today; a person moving a deal into that stage is', async () => {
    const opening = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM deal_stage_history h
        JOIN deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
       WHERE h.tenant_id = $1 AND h.to_stage = 'agreement_signed' AND h.actor_kind = 'system' AND h.from_stage IS NULL`,
      [w.tenantId],
    );
    expect(opening[0]!.n).toBeGreaterThan(0);
    const signed = async () =>
      withTenantTx(w.agents[0]!.actor(), async (tx) =>
        Number((await sql<{ n: string }>`SELECT agreements_signed::text AS n FROM app.scoreboard_activity(${[w.agents[0]!.userId]}::uuid[], now() - interval '2 days', now() + interval '1 hour')`.execute(tx)).rows[0]!.n),
      );
    expect(await signed()).toBe(0);
    const defs = await q<{ proname: string; ok: boolean }>(
      `SELECT proname, position('actor_kind = ''system'' AND h.from_stage IS NULL' IN prosrc) > 0 AS ok
         FROM pg_proc WHERE proname IN ('scoreboard_activity', 'scoreboard_rollup_roll') ORDER BY proname`,
    );
    expect(defs).toEqual([
      { proname: 'scoreboard_activity', ok: true },
      { proname: 'scoreboard_rollup_roll', ok: true },
    ]);
    const active = await q<{ id: string; row_version: number }>(
      `SELECT id, row_version FROM deals WHERE tenant_id = $1 AND stage = 'active' AND owner_user_id = $2 LIMIT 1`,
      [w.tenantId, w.agents[0]!.userId],
    );
    expect((await call(w.agents[0]!, 'POST', `/deals/${active[0]!.id}/stage`, { rowVersion: active[0]!.row_version, stage: 'agreement_signed' })).status).toBe(200);
    expect(await signed()).toBe(1);
  });

  it('links appointments to the contact and agent, keeps reminders off, and does not notify', async () => {
    const s = await fullStage(ih, w.admin, batchId, 'appointments');
    expect(s.counts).toMatchObject({ source: 6, imported: 6, rejected: 0, needsReview: 0 });
    const rows = await q<{ status: string; reminders_enabled: boolean; kind: string }>('SELECT status, reminders_enabled, kind FROM appointments WHERE tenant_id = $1', [w.tenantId]);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.reminders_enabled === false)).toBe(true);
    expect(rows.filter((r) => r.status === 'held')).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'scheduled')).toHaveLength(3);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['buyer_consult', 'listing_appointment', 'consult', 'other']));
    const linked = await q<{ n: number }>("SELECT count(*)::int AS n FROM appointments a JOIN contacts c ON c.id = a.contact_id WHERE a.tenant_id = $1 AND c.display_name = 'Ada Lovelace'", [w.tenantId]);
    expect(linked[0]!.n).toBe(6);
    expect(await q('SELECT 1 FROM notifications WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
    expect(await q('SELECT 1 FROM playbook_enrollments WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
  });

  it('commission is visible to an Owner and hidden from an agent who is not on the deal, and from the system', async () => {
    const as = async (actor: ReturnType<ImportWorld['agents'][number]['actor']> | ReturnType<typeof systemActor>) =>
      withTenantTx(actor, async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM deal_financials`.execute(tx)).rows[0]!.n, { db: ih.h.database });
    expect(await as(w.admin.actor())).toBe(N);
    expect(await as(w.agents[0]!.actor())).toBe(N);
    expect(await as(w.agents[1]!.actor())).toBe(0);
    expect(await as(systemActor(w.tenantId, 'import'))).toBe(0);
  });

  it('a second import of the same snapshot does not duplicate deals or appointments', async () => {
    const b = await startFub(ih, w.admin, KEY);
    await mapOwner(b.id);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) await fullStage(ih, w.admin, b.id, cat);
    const deals = await fullStage(ih, w.admin, b.id, 'deals');
    expect(deals.counts).toMatchObject({ imported: 0, duplicate: N, needsReview: 2, rejected: 0 });
    const appts = await fullStage(ih, w.admin, b.id, 'appointments');
    expect(appts.counts).toMatchObject({ imported: 0, duplicate: 6, rejected: 0 });
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(N);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(6);
  });

  it('refuses Import on an unmapped deal instead of accepting a decision the approval cannot commit', async () => {
    const key = 'fub-unmapped-review';
    ih.fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [{ id: 81, firstName: 'Nia', lastName: 'Stage', stage: 'Active', assignedUserId: 11, emails: [{ value: 'nia.stage@example.com', type: 'home' }] }],
      deals: [
        { id: 81, name: 'Known stage', stageName: 'Active', pipelineName: 'Buyers', price: 10, peopleIds: [81], userIds: [11] },
        { id: 82, name: 'Unknown stage', stageName: 'Waiting On Lender', pipelineName: 'Buyers', price: 10, peopleIds: [81], userIds: [11] },
      ],
    });
    const b = await startFub(ih, w.admin, key);
    await mapOwner(b.id);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) await fullStage(ih, w.admin, b.id, cat);
    const dry = await dryRunStage(ih, w.admin, b.id, 'deals');
    const held = (await records(w.admin, b.id, 'deals', 'needs_review')).find((r) => r.sourceRef === 'fub:deals/82');
    expect(held?.planned).toBeNull();
    const refused = await call(w.admin, 'POST', `/imports/${b.id}/records/${held!.id}/review`, { decision: 'import' });
    expect([refused.status, refused.code]).toEqual([422, 'IMPORT_REVIEW_INVALID']);
    expect((await records(w.admin, b.id, 'deals', 'needs_review')).find((r) => r.sourceRef === 'fub:deals/82')?.outcome).toBe('needs_review');
    expect((await approve(w.admin, b.id, 'deals', dry.dryRunSha256 as string)).status).toBe(200);
    expect((await commitStage(ih, w.admin, b.id, 'deals')).status).toBe('committed');
    expect((await verify(w.admin, b.id, 'deals')).res.status).toBe(200);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND name = 'Unknown stage'", [w.tenantId]))[0]!.n).toBe(0);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND name = 'Known stage'", [w.tenantId]))[0]!.n).toBe(1);
  });

  it('keeps an imported deal that later gained a confirmed date, a commission edit, a member, an appointment, or a portal grant', async () => {
    const key = 'fub-later-work';
    ih.fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: ['Date', 'Money', 'Member', 'Showing', 'Portal', 'Clean'].map((name, i) => ({
        id: 90 + i,
        firstName: name,
        lastName: 'Work',
        stage: 'Active',
        assignedUserId: 11,
        emails: [{ value: `${name.toLowerCase()}.work@example.com`, type: 'home' }],
      })),
      deals: ['Date', 'Money', 'Member', 'Showing', 'Portal', 'Clean'].map((name, i) => ({
        id: 300 + i,
        name,
        stageName: 'Active',
        pipelineName: 'Buyers',
        price: 20,
        commissionValue: 10,
        agentCommission: 7,
        teamCommission: 3,
        mutualAcceptanceDate: '2026-08-01',
        peopleIds: [90 + i],
        userIds: [11],
      })),
    });
    const b = await startFub(ih, w.admin, key);
    await mapOwner(b.id);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent', 'deals'] as const) await fullStage(ih, w.admin, b.id, cat);
    const rows = await q<{ id: string; name: string; contact_id: string }>(
      `SELECT d.id, d.name, d.primary_contact_id AS contact_id FROM deals d WHERE d.tenant_id = $1 AND d.name = ANY ($2)`,
      [w.tenantId, ['Date', 'Money', 'Member', 'Showing', 'Portal', 'Clean']],
    );
    const byName = new Map(rows.map((r) => [r.name, r]));
    const owner = w.agents[0]!;
    await withTenantTx(w.admin.actor(), async (tx) => {
      await sql`UPDATE deal_dates SET status = 'confirmed', confirmed_by_user_id = ${w.admin.userId}, confirmed_at = now()
                WHERE tenant_id = app.tenant_id() AND deal_id = ${byName.get('Date')!.id}`.execute(tx);
    });
    await withTenantTx(owner.actor(), async (tx) => {
      await sql`UPDATE deal_financials SET gross_commission_cents = 1, updated_at = now(), updated_by_user_id = ${owner.userId}
                WHERE tenant_id = app.tenant_id() AND deal_id = ${byName.get('Money')!.id}`.execute(tx);
    });
    await withTenantTx(w.admin.actor(), async (tx) => {
      await sql`INSERT INTO deal_members (tenant_id, deal_id, user_id, role)
                VALUES (app.tenant_id(), ${byName.get('Member')!.id}, ${w.agents[1]!.userId}, 'tc')`.execute(tx);
      await sql`INSERT INTO appointments (tenant_id, id, contact_id, deal_id, user_id, kind, starts_at, ends_at, status, created_by_kind)
                VALUES (app.tenant_id(), ${randomUUID()}, ${byName.get('Showing')!.contact_id}, ${byName.get('Showing')!.id}, ${owner.userId},
                        'consult', now() + interval '3 days', now() + interval '3 days' + interval '1 hour', 'scheduled', 'user')`.execute(tx);
      const point = await sql<{ id: string }>`SELECT id FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${byName.get('Portal')!.contact_id} AND removed_at IS NULL LIMIT 1`.execute(tx);
      const account = randomUUID();
      await sql`INSERT INTO portal_accounts (tenant_id, id, contact_id, login_point_id, status, invited_by_user_id)
                VALUES (app.tenant_id(), ${account}, ${byName.get('Portal')!.contact_id}, ${point.rows[0]!.id}, 'invited', ${w.admin.userId})`.execute(tx);
      await sql`INSERT INTO portal_grants (tenant_id, id, portal_account_id, deal_id, granted_by_user_id, granted_at, display)
                VALUES (app.tenant_id(), ${randomUUID()}, ${account}, ${byName.get('Portal')!.id}, ${w.admin.userId}, now(), '{}'::jsonb)`.execute(tx);
    });
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'deals' })).status).toBe(202);
    await ih.drain();
    const left = await q<{ name: string }>(
      `SELECT name FROM deals WHERE tenant_id = $1 AND name = ANY ($2) ORDER BY name`,
      [w.tenantId, ['Date', 'Money', 'Member', 'Showing', 'Portal', 'Clean']],
    );
    expect(left.map((r) => r.name)).toEqual(['Date', 'Member', 'Money', 'Portal', 'Showing']);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1 AND deal_id = $2', [w.tenantId, byName.get('Showing')!.id]))[0]!.n).toBe(1);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM portal_grants WHERE tenant_id = $1 AND deal_id = $2', [w.tenantId, byName.get('Portal')!.id]))[0]!.n).toBe(1);
    await expect(q('DELETE FROM deal_stage_history WHERE tenant_id = $1 AND deal_id = $2', [w.tenantId, byName.get('Date')!.id])).rejects.toThrow(/APPEND_ONLY/);
  });

  it('keeps a deal that gained a party the import did not write, and drops only the parties an untouched deal imported', async () => {
    const key = 'fub-added-party';
    ih.fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [
        { id: 501, firstName: 'Pat', lastName: 'Primary', stage: 'Active', assignedUserId: 11, emails: [{ value: 'pat.primary@example.com', type: 'home' }] },
        { id: 502, firstName: 'Sol', lastName: 'Only', stage: 'Active', assignedUserId: 11, emails: [{ value: 'sol.only@example.com', type: 'home' }] },
        { id: 503, firstName: 'Ada', lastName: 'Added', stage: 'Active', assignedUserId: 11, emails: [{ value: 'ada.added@example.com', type: 'home' }] },
      ],
      deals: [
        { id: 501, name: 'Party', stageName: 'Active', pipelineName: 'Buyers', price: 20, peopleIds: [501], userIds: [11] },
        { id: 502, name: 'Solo', stageName: 'Active', pipelineName: 'Buyers', price: 20, peopleIds: [502], userIds: [11] },
      ],
    });
    const b = await startFub(ih, w.admin, key);
    await mapOwner(b.id);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent', 'deals'] as const) await fullStage(ih, w.admin, b.id, cat);
    const deals = await q<{ id: string; name: string }>(
      `SELECT id, name FROM deals WHERE tenant_id = $1 AND name = ANY ($2)`,
      [w.tenantId, ['Party', 'Solo']],
    );
    const party = deals.find((d) => d.name === 'Party')!;
    const solo = deals.find((d) => d.name === 'Solo')!;
    const added = await q<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND display_name = 'Ada Added'`, [w.tenantId]);
    await withTenantTx(w.admin.actor(), async (tx) => {
      await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role)
                VALUES (app.tenant_id(), ${party.id}, ${added[0]!.id}, 'co_buyer')`.execute(tx);
    });
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'deals' })).status).toBe(202);
    await ih.drain();
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND id = $2', [w.tenantId, party.id]))[0]!.n).toBe(1);
    const parties = await q<{ name: string }>(
      `SELECT c.display_name AS name FROM deal_contacts dc JOIN contacts c ON c.tenant_id = dc.tenant_id AND c.id = dc.contact_id
        WHERE dc.tenant_id = $1 AND dc.deal_id = $2 ORDER BY c.display_name`,
      [w.tenantId, party.id],
    );
    expect(parties.map((r) => r.name)).toEqual(['Ada Added', 'Pat Primary']);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND id = $2', [w.tenantId, solo.id]))[0]!.n).toBe(0);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM deal_contacts WHERE tenant_id = $1 AND deal_id = $2', [w.tenantId, solo.id]))[0]!.n).toBe(0);
  });


  it('revert removes an untouched imported appointment and deal, and a later import can write them again', async () => {
    const key = 'fub-revert-one';
    ih.fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [{ id: 77, firstName: 'Bea', lastName: 'Revert', stage: 'Active', assignedUserId: 11, emails: [{ value: 'bea.revert@example.com', type: 'home' }] }],
      deals: [{ id: 77, name: 'Revert me', stageName: 'Active', pipelineName: 'Buyers', price: 10, peopleIds: [77], userIds: [11] }],
      appointments: [{ id: 77, createdById: 11, title: 'Revert me', start: '2027-01-01T15:00:00Z', end: '2027-01-01T16:00:00Z', type: 'Consult', invitees: [{ userId: 11 }, { personId: 77 }] }],
    });
    const b = await startFub(ih, w.admin, key);
    await mapOwner(b.id);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent', 'deals', 'appointments'] as const) await fullStage(ih, w.admin, b.id, cat);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM deals d JOIN contacts c ON c.tenant_id = d.tenant_id AND c.id = d.primary_contact_id WHERE d.tenant_id = $1 AND c.display_name = 'Bea Revert'", [w.tenantId]))[0]!.n).toBe(1);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'appointments' })).status).toBe(202);
    await ih.drain();
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'deals' })).status).toBe(202);
    await ih.drain();
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM deals d JOIN contacts c ON c.tenant_id = d.tenant_id AND c.id = d.primary_contact_id WHERE d.tenant_id = $1 AND c.display_name = 'Bea Revert'", [w.tenantId]))[0]!.n).toBe(0);
    const again = await startFub(ih, w.admin, key);
    await mapOwner(again.id);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent', 'deals', 'appointments'] as const) await fullStage(ih, w.admin, again.id, cat);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM deals d JOIN contacts c ON c.tenant_id = d.tenant_id AND c.id = d.primary_contact_id WHERE d.tenant_id = $1 AND c.display_name = 'Bea Revert'", [w.tenantId]))[0]!.n).toBe(1);
  });
});
