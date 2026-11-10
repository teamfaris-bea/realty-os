// api/imports revert (R-IMPORT-10, R-CONSENT-3, E43; BUILD_PLAN module 16 "Revert with touched rows").
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  approve,
  batchOf,
  call,
  commitStage,
  csvBase64,
  csvOf,
  dryRunStage,
  fubFixture,
  fullStage,
  importWorld,
  importsHarness,
  mapAgents,
  records,
  stageOf,
  startFub,
  verify,
} from './testing.js';

let ih: ImportsHarness;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
});
afterAll(async () => {
  await ih?.close();
});

async function fubWorld(key: string, prefix: number): Promise<{ w: ImportWorld; b: BatchView }> {
  const w = await importWorld(ih);
  ih.fub.add(key, fubFixture({ prefix }));
  const b = await startFub(ih, w.admin, key);
  await mapAgents(w.admin, b.id, w, [{ sourceRef: '99', target: { kind: 'unassigned' } }, { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } }]);
  const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
  for (const r of (await records(w.admin, b.id, 'contacts')).filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
  await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
  await commitStage(ih, w.admin, b.id, 'contacts');
  expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
  return { w, b };
}

const contactByName = async (tenantId: string, name: string) =>
  (await q<{ id: string; deleted_at: Date | null; ownership_state: string; closed_reason: string | null; owner_user_id: string | null }>(
    'SELECT id, deleted_at, ownership_state, closed_reason, owner_user_id FROM contacts WHERE tenant_id = $1 AND display_name = $2',
    [tenantId, name],
  ))[0]!;

describe('R-IMPORT-10: revert', () => {
  it('R-IMPORT-10 E43 R-CONSENT-3: touched contacts are listed, not deleted; untouched rows go; imported grants are voided; revocations and DNC stay', async () => {
    const { w, b } = await fubWorld('key-e43-00001', 4300);
    for (const c of ['ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) await fullStage(ih, w.admin, b.id, c);
    const jane = await contactByName(w.tenantId, 'Jane Doe');
    // Jane is reassigned after the import (a human action on an imported contact)
    const seq = (await q<{ ownership_seq: string }>('SELECT ownership_seq FROM contacts WHERE id = $1', [jane.id]))[0]!.ownership_seq;
    const re = await call(w.owner, 'POST', `/leads/${jane.id}/reassign`, { commandId: randomUUID(), toUserId: w.agents[1]!.userId, expectedSeq: Number(seq) });
    expect(re.status).toBe(200);
    const janeSms = await q<{ status: string }>("SELECT cs.status FROM consent_state cs JOIN contact_points p ON p.address_hmac = cs.address_hmac AND p.tenant_id = cs.tenant_id WHERE p.contact_id = $1 AND cs.channel = 'sms'", [jane.id]);
    expect(janeSms.every((x) => x.status === 'granted')).toBe(true);

    const r = await call(w.admin, 'POST', `/imports/${b.id}/revert`, {});
    expect(r.status).toBe(202);
    await ih.drain();
    const nb = await batchOf(w.admin, b.id);
    expect(nb.status).toBe('reverted');
    for (const s of nb.stages) expect(s.status).toBe('reverted');

    // Jane: touched → kept, with her imported history; listed for a human decision
    const janeAfter = await contactByName(w.tenantId, 'Jane Doe');
    expect(janeAfter.deleted_at).toBeNull();
    expect(janeAfter.owner_user_id).toBe(w.agents[1]!.userId);
    expect((await q('SELECT 1 FROM messages WHERE contact_id = $1', [jane.id])).length).toBe(3);
    const contactsReport = stageOf(nb, 'contacts').revert as { needsDecision: number; manual: { sourceRef: string; reason: string }[] };
    expect(contactsReport.manual).toEqual([expect.objectContaining({ sourceRef: 'fub:people/4301', reason: 'TOUCHED' })]);
    expect((await records(w.admin, b.id, 'contacts')).find((x) => x.sourceRef === 'fub:people/4301')!.outcome).toBe('imported');

    // untouched: soft-deleted through the ownership engine, their history deleted
    for (const name of ['Bob Unsub', 'Carla Dnc', 'Dan Nostage', 'Erin Unmapped']) {
      const c = await contactByName(w.tenantId, name);
      expect([name, c.ownership_state, c.closed_reason, c.deleted_at !== null]).toEqual([name, 'closed', 'deleted', true]);
    }
    const bob = await contactByName(w.tenantId, 'Bob Unsub');
    expect(await q('SELECT 1 FROM notes WHERE contact_id = $1', [bob.id])).toHaveLength(0);
    expect(await q('SELECT 1 FROM calls WHERE contact_id = $1', [bob.id])).toHaveLength(0);
    expect((await q<{ type: string; actor_kind: string }>('SELECT type, actor_kind FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq DESC LIMIT 1', [bob.id]))[0]).toEqual({ type: 'closed', actor_kind: 'system' });

    // consent: Jane's imported grants voided (import_revert); Bob's revocations stay; Carla's DNC stays
    const voids = await q<{ event_type: string; reverts_event_id: string }>("SELECT event_type, reverts_event_id FROM consent_events WHERE tenant_id = $1 AND event_type = 'import_revert'", [w.tenantId]);
    const grants = await q<{ id: string }>("SELECT id FROM consent_events WHERE tenant_id = $1 AND event_type = 'grant' AND imported", [w.tenantId]);
    expect(voids.map((v) => v.reverts_event_id).sort()).toEqual(grants.map((g) => g.id).sort());
    const janeSmsAfter = await q<{ status: string }>("SELECT cs.status FROM consent_state cs JOIN contact_points p ON p.address_hmac = cs.address_hmac AND p.tenant_id = cs.tenant_id WHERE p.contact_id = $1 AND cs.channel = 'sms'", [jane.id]);
    expect(janeSmsAfter.length).toBeGreaterThan(0);
    for (const s of janeSmsAfter) expect(s.status).toBe('none');
    const bobState = await q<{ status: string }>("SELECT DISTINCT cs.status FROM consent_state cs JOIN consent_events e ON e.address_hmac = cs.address_hmac AND e.tenant_id = cs.tenant_id WHERE e.tenant_id = $1 AND e.event_type = 'revoke'", [w.tenantId]);
    expect(bobState).toEqual([{ status: 'revoked' }]);
    expect(await q("SELECT 1 FROM suppressions WHERE tenant_id = $1 AND reason = 'import_dnc' AND lifted_at IS NULL", [w.tenantId])).toHaveLength(1);
    const consentReport = stageOf(nb, 'consent').revert as { keptReasons: Record<string, number>; compensated: number };
    expect(consentReport.compensated).toBe(grants.length);
    // outbound-2: the opt-outs were applied (and are kept) by the contacts stage
    const contactsKept = (stageOf(nb, 'contacts').revert as { keptReasons: Record<string, number> }).keptReasons;
    expect(contactsKept.REVOCATION_KEPT).toBeGreaterThan(0);
    expect(contactsKept.DNC_KEPT).toBe(1);

    // the report says what happened, plainly
    const rep = await call<{ categories: { category: string; phase: string; lines: string[] }[] }>(w.admin, 'GET', `/imports/${b.id}/report`);
    const c = rep.body.categories.find((x) => x.category === 'contacts')!;
    expect(c.phase).toBe('reverted');
    expect(c.lines[0]).toMatch(/^Reverted\. .* 1 record was changed since the import and left for your decision\.$/);
    expect(c.lines.join(' ')).toMatch(/opt-outs and do-not-contact flags stay in place/);
    expect(rep.body.categories.find((x) => x.category === 'consent')!.lines.join(' ')).toMatch(/imported permissions were withdrawn/);
  });

  it('R-IMPORT-10: stages are reverted in reverse order; ownership history stays in the ledger', async () => {
    const { w, b } = await fubWorld('key-rev-order1', 4400);
    await fullStage(ih, w.admin, b.id, 'ownership');
    const early = await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'contacts' });
    expect([early.status, early.code]).toEqual([409, 'IMPORT_REVERT_ORDER']);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'ownership' })).status).toBe(202);
    await ih.drain();
    let nb = await batchOf(w.admin, b.id);
    expect(stageOf(nb, 'ownership').status).toBe('reverted');
    expect(stageOf(nb, 'contacts').status).toBe('verified');
    expect(nb.status).toBe('partially_committed');
    const jane = await contactByName(w.tenantId, 'Jane Doe');
    // the ledger keeps the import's assignment as history and adds the compensating event
    expect(await q<{ seq: string; to_state: string; reason_code: string }>("SELECT seq, to_state, reason_code FROM lead_ownership_events WHERE contact_id = $1 AND type = 'imported' ORDER BY seq", [jane.id])).toEqual([
      { seq: '1', to_state: 'unassigned', reason_code: 'IMPORTED' },
      { seq: '2', to_state: 'owned', reason_code: 'IMPORTED' },
      { seq: '3', to_state: 'unassigned', reason_code: 'IMPORT_REVERTED' },
    ]);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'contacts' })).status).toBe(202);
    await ih.drain();
    nb = await batchOf(w.admin, b.id);
    expect(nb.status).toBe('reverted');
    expect((await contactByName(w.tenantId, 'Jane Doe')).deleted_at).not.toBeNull();
  });

  it('R-IMPORT-10 ownership-1: reverting only the ownership stage undoes untouched assignments; a lead worked on since keeps its owner', async () => {
    const { w, b } = await fubWorld('key-rev-own01', 4600);
    await fullStage(ih, w.admin, b.id, 'ownership');
    const jane = await contactByName(w.tenantId, 'Jane Doe');
    const bob = await contactByName(w.tenantId, 'Bob Unsub');
    const carla = await contactByName(w.tenantId, 'Carla Dnc');
    expect([jane.ownership_state, jane.owner_user_id, bob.ownership_state, carla.ownership_state]).toEqual(['owned', w.agents[0]!.userId, 'owned', 'in_pond']);
    // Bob's owner works the lead after the import: that assignment is a human's to undo
    const seq = (await q<{ ownership_seq: string }>('SELECT ownership_seq FROM contacts WHERE id = $1', [bob.id]))[0]!.ownership_seq;
    expect((await call(w.owner, 'POST', `/leads/${bob.id}/reassign`, { commandId: randomUUID(), toUserId: w.agents[0]!.userId, expectedSeq: Number(seq) })).status).toBe(200);

    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'ownership' })).status).toBe(202);
    await ih.drain();
    const nb = await batchOf(w.admin, b.id);
    expect(stageOf(nb, 'ownership').status).toBe('reverted');
    const after = async (id: string) => (await q<{ ownership_state: string; owner_user_id: string | null; pond_id: string | null; route_due_at: Date | null }>('SELECT ownership_state, owner_user_id, pond_id, route_due_at FROM contacts WHERE id = $1', [id]))[0]!;
    expect(await after(jane.id)).toEqual({ ownership_state: 'unassigned', owner_user_id: null, pond_id: null, route_due_at: null });
    expect(await after(carla.id)).toEqual({ ownership_state: 'unassigned', owner_user_id: null, pond_id: null, route_due_at: null });
    expect(await after(bob.id)).toMatchObject({ ownership_state: 'owned', owner_user_id: w.agents[0]!.userId });
    // the compensation is an import event: no offer, no SLA, no notice, and it is not a "touch"
    const last = (await q<{ type: string; actor_kind: string; reason_code: string; deadline_at: Date | null }>('SELECT type, actor_kind, reason_code, deadline_at FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq DESC LIMIT 1', [jane.id]))[0];
    expect(last).toEqual({ type: 'imported', actor_kind: 'import', reason_code: 'IMPORT_REVERTED', deadline_at: null });
    expect(await q("SELECT 1 FROM lead_ownership_events WHERE contact_id = $1 AND type = 'offered'", [jane.id])).toHaveLength(0);
    const rep = stageOf(nb, 'ownership').revert as { compensated: number; needsDecision: number; manual: { sourceRef: string; reason: string }[] };
    expect(rep.needsDecision).toBe(1);
    expect(rep.manual).toEqual([expect.objectContaining({ sourceRef: 'fub:people/4602', reason: 'TOUCHED' })]);
    expect(rep.compensated).toBeGreaterThanOrEqual(2);
    const lines = (await call<{ categories: { category: string; lines: string[] }[] }>(w.admin, 'GET', `/imports/${b.id}/report`)).body.categories.find((x) => x.category === 'ownership')!.lines.join(' ');
    expect(lines).toMatch(/assignments were undone; those leads are unassigned again\./);
    expect(lines).toMatch(/keep their current owner/);
    // the contacts stage can still be reverted afterwards: the compensated contacts are untouched
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'contacts' })).status).toBe(202);
    await ih.drain();
    expect((await contactByName(w.tenantId, 'Jane Doe')).deleted_at).not.toBeNull();
  });

  it('R-IMPORT-10 E41: a revert never removes a contact that existed before the import; only what the import added', async () => {
    const w = await importWorld(ih);
    const own = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Pat0', lastName: 'Lead0', emails: ['pat0@example.com'] });
    expect([200, 201]).toContain(own.status);
    const cr = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'leads.csv', fileBase64: csvBase64(csvOf(3)) });
    await call(w.admin, 'POST', `/imports/${cr.body.batch.id}/snapshot`);
    await ih.drain();
    const bid = cr.body.batch.id;
    const d = await dryRunStage(ih, w.admin, bid, 'contacts');
    const recs = await records(w.admin, bid, 'contacts');
    const pat0 = recs.find((r) => r.matchContactId === own.body.contact.id)!;
    expect(pat0.dryRunOutcome).toBe('needs_review'); // E41: an agent's contact changes only after a human looks
    await call(w.admin, 'POST', `/imports/${bid}/records/${pat0.id}/review`, { decision: 'import' });
    await approve(w.admin, bid, 'contacts', d.dryRunSha256 as string);
    await commitStage(ih, w.admin, bid, 'contacts');
    expect((await verify(w.admin, bid, 'contacts')).res.status).toBe(200);
    const phones = await q<{ id: string; import_batch_id: string | null }>("SELECT id, import_batch_id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [own.body.contact.id]);
    expect(phones).toEqual([{ id: expect.any(String), import_batch_id: bid }]);
    expect((await call(w.admin, 'POST', `/imports/${bid}/revert`, {})).status).toBe(202);
    await ih.drain();
    const c = (await q<{ deleted_at: Date | null; owner_user_id: string }>('SELECT deleted_at, owner_user_id FROM contacts WHERE id = $1', [own.body.contact.id]))[0]!;
    expect(c).toEqual({ deleted_at: null, owner_user_id: w.agents[0]!.userId });
    expect(await q("SELECT 1 FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [own.body.contact.id])).toHaveLength(0);
    const rep = stageOf(await batchOf(w.admin, bid), 'contacts').revert as { manual: { reason: string }[] };
    expect(rep.manual).toEqual([expect.objectContaining({ reason: 'PRE_EXISTING_CONTACT' })]);
  });

  it('R-IMPORT-10: the revert definer deletes only rows the reverting stage wrote, only for Owner/Admin/system', async () => {
    const { w, b } = await fubWorld('key-rev-def01', 4500);
    await fullStage(ih, w.admin, b.id, 'ownership');
    await fullStage(ih, w.admin, b.id, 'notes');
    const notesStage = stageOf(await batchOf(w.admin, b.id), 'notes');
    const jane = await contactByName(w.tenantId, 'Jane Doe');
    // a note an agent wrote (fixture: no notes route in this build)
    const own = randomUUID();
    await q("INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source) VALUES ($1, $2, $3, $4, 'my note', 'manual')", [w.tenantId, own, jane.id, w.agents[0]!.userId]);
    const imported = (await q<{ id: string }>('SELECT id FROM notes WHERE contact_id = $1 AND imported', [jane.id]))[0]!.id;
    const run = (actor: Parameters<typeof withTenantTx>[0]) =>
      withTenantTx(actor, async (tx) => (await sql<{ id: string }>`SELECT x::text AS id FROM app.import_revert_delete(${notesStage.id}::uuid, 'notes', ${[own, imported]}::uuid[]) x`.execute(tx)).rows, { db: ih.h.database });
    await expect(run(w.admin.actor())).rejects.toThrow(/IMPORT_STAGE_NOT_REVERTING/);
    await expect(run(w.agents[0]!.actor())).rejects.toThrow(/IMPORT_REVERT_FORBIDDEN/);
    await q("UPDATE import_stages SET status = 'reverting' WHERE id = $1", [notesStage.id]);
    expect(await run(w.admin.actor())).toEqual([{ id: imported }]);
    expect(await q('SELECT 1 FROM notes WHERE id = $1', [own])).toHaveLength(1);
    await expect(
      withTenantTx(w.admin.actor(), (tx) => sql`SELECT * FROM app.import_revert_delete(${notesStage.id}::uuid, 'contacts', ${[jane.id]}::uuid[])`.execute(tx), { db: ih.h.database }),
    ).rejects.toThrow(/IMPORT_REVERT_TABLE/);
  });
});
