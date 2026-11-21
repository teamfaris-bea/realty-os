// FUB deals and appointments import (B7 reversed 2026-11-21). Synthetic records only, FakeFub, no live account.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { systemActor } from '../worker/systemActor.js';
import {
  type ImportWorld,
  type ImportsHarness,
  call,
  fullStage,
  importWorld,
  importsHarness,
  records,
  startFub,
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
