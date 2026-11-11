// api/imports: the golden Follow Up Boss migration end to end, every stage (BUILD_PLAN module 16
// tests: "A golden FUB fixture migration end to end, including consent edge cases (E39–E44)";
// "Imported history never triggers pauses, exceptions, SLAs or caps").
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FUB_KEY,
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  approve,
  batchOf,
  call,
  commitStage,
  dryRunStage,
  fubFixture,
  fullStage,
  importWorld,
  importsHarness,
  mapAgents,
  records,
  verify,
} from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
let b: BatchView & { notImported?: unknown };
/** the fake's call count once the snapshot job finished: nothing may read FUB after it */
let callsAfterSnapshot = 0;
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await ih.h.su.query(sql, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
  ih.fub.add(FUB_KEY, fubFixture());
});
afterAll(async () => {
  await ih?.close();
});

describe('golden FUB migration', () => {
  it('R-IMPORT-1: the connection test reads counts only, imports nothing and promises nothing', async () => {
    const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: FUB_KEY });
    expect(r.status).toBe(201);
    b = r.body.batch;
    expect(b.status).toBe('connection_test');
    expect(b.sourceCounts).toMatchObject({ contacts: 7, ownership: 7, notes: 3, messages: 3, call_recordings: 2, consent: 7 });
    expect(b.connectionTest).toContain('7 contacts found in Follow Up Boss.');
    expect(b.connectionTest.at(-1)).toBe('Nothing is imported yet. Each step shows you exactly what would change before anything is written.');
    // counts only: one one-record page per collection, no list or recording reads; tasks and appointments are
    // counted the same way and never read (owner decision B7, E233)
    expect(ih.fub.calls.every((c) => c.op === 'count')).toBe(true);
    expect(ih.fub.calls.map((c) => c.collection)).toEqual(['people', 'notes', 'textMessages', 'emails', 'calls', 'users', 'tasks', 'appointments']);
    expect(b.notImported).toEqual({ tasks: 0, appointments: 0, countedAt: 'connection_test', lines: ["Follow Up Boss has no tasks or appointments. Realty OS doesn't bring tasks or appointments over."] });
    expect(await q('SELECT 1 FROM contacts WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
    expect(await q('SELECT 1 FROM import_records r JOIN import_stages s ON s.tenant_id = r.tenant_id AND s.id = r.stage_id WHERE s.batch_id = $1', [b.id])).toHaveLength(0);
    // R-DATA-1: the key is stored encrypted, never in plaintext
    const cred = await q<{ secret_enc: Buffer }>('SELECT secret_enc FROM provider_credentials WHERE tenant_id = $1 AND provider = $2', [w.tenantId, 'fub']);
    expect(cred).toHaveLength(1);
    expect(cred[0]!.secret_enc.toString('latin1')).not.toContain(FUB_KEY);
  });

  it('R-IMPORT-1 R-IMPORT-4: the snapshot is read once, stored encrypted with its sha256; later steps never read live FUB', async () => {
    const s = await call(w.admin, 'POST', `/imports/${b.id}/snapshot`);
    expect(s.status).toBe(202);
    await ih.drain();
    b = await batchOf(w.admin, b.id);
    expect(b.status).toBe('dry_run');
    expect(b.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    const obj = await q<{ purpose: string; sha: string }>("SELECT purpose, encode(sha256, 'hex') AS sha FROM stored_objects WHERE tenant_id = $1 AND purpose = 'import_file'", [w.tenantId]);
    expect(obj.map((o) => o.sha)).toContain(b.snapshotSha256);
    // the stored blob is ciphertext
    const blobs = [...ih.h.providers.storage.objects.values()];
    expect(blobs.length).toBeGreaterThan(0);
    for (const x of blobs) expect(Buffer.from(x.bytes).toString('latin1')).not.toContain('Jane');
    expect(ih.fub.calls.filter((c) => c.op === 'recording')).toHaveLength(1);
    callsAfterSnapshot = ih.fub.calls.length;
  });

  it('R-IMPORT-8: the ownership stage cannot be approved until every FUB agent is mapped', async () => {
    const own = await dryRunStage(ih, w.admin, b.id, 'ownership');
    expect(own.blockers.map((x) => x.code)).toEqual(['USER_MAPPING_INCOMPLETE']);
    const a = await approve(w.admin, b.id, 'ownership', own.dryRunSha256 as string);
    expect([a.status, a.code]).toEqual([409, 'IMPORT_STAGE_BLOCKED']);
    const m = await call<{ complete: boolean; unmapped: number }>(w.admin, 'GET', `/imports/${b.id}/user-mappings`);
    expect(m.body).toMatchObject({ complete: false });
    // a TC (or anyone who cannot own leads) is not a valid target (R-PERM-15)
    const bad = await call(w.admin, 'PUT', `/imports/${b.id}/user-mappings`, { mappings: [{ sourceRef: '11', target: { kind: 'user', userId: '00000000-0000-7000-8000-000000000000' } }] });
    expect([bad.status, bad.code]).toEqual([422, 'IMPORT_MAPPING_INVALID']);
    await mapAgents(w.admin, b.id, w, [
      { sourceRef: '99', target: { kind: 'unassigned' } },
      { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } },
    ]);
    const done = await call<{ complete: boolean }>(w.admin, 'GET', `/imports/${b.id}/user-mappings`);
    expect(done.body.complete).toBe(true);
    // the changed mapping invalidated the ownership dry run
    expect((await batchOf(w.admin, b.id)).stages.find((s) => s.category === 'ownership')!.status).toBe('pending');
  });

  it('contacts: per-record review list with reasons; E45 invalid phone; review decides; counts reconcile exactly', async () => {
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect(d.counts).toEqual({ source: 7, willImport: 4, needsReview: 1, rejected: 2, duplicate: 0, imported: null });
    const recs = await records(w.admin, b.id, 'contacts');
    const jane = recs.find((r) => r.sourceRef === 'fub:people/1001')!;
    expect(jane.dryRunOutcome).toBe('needs_review');
    expect(jane.issues.map((i) => i.code)).toContain('PHONE_INVALID');
    expect(jane.issues.find((i) => i.code === 'PHONE_INVALID')!.sentence).toMatch(/area code/);
    expect(recs.find((r) => r.sourceRef === 'fub:people/1006')!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['PHONE_INVALID', 'NO_IDENTITY']));
    // custom fields go to imported_fields (display-only), tags kept
    expect(jane.record).toMatchObject({ displayName: 'Jane Doe', tags: ['Buyer', 'Pre-approved'] });
    const rv = await call(w.admin, 'POST', `/imports/${b.id}/records/${jane.id}/review`, { decision: 'import' });
    expect(rv.status).toBe(200);
    const a = await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    expect(a.status).toBe(200);
    expect(a.body.expected).toEqual({ source: 7, imported: 5, needs_review: 0, rejected: 2, duplicate: 0 });
    const s = await commitStage(ih, w.admin, b.id, 'contacts');
    expect(s.counts).toMatchObject({ source: 7, imported: 5, needsReview: 0, rejected: 2, duplicate: 0 });
    const v = await verify(w.admin, b.id, 'contacts');
    expect(v.view.matches).toBe(true);
    expect(v.view.sample).toHaveLength(5);
    expect(v.view.sample.every((x) => x.same)).toBe(true);
    expect(v.res.status).toBe(200);
    const c = await q<{ imported_fields: Record<string, string>; ownership_state: string; import_batch_id: string; route_due_at: Date | null }>(
      "SELECT imported_fields, ownership_state, import_batch_id, route_due_at FROM contacts WHERE tenant_id = $1 AND display_name = 'Jane Doe'",
      [w.tenantId],
    );
    expect(c[0]).toMatchObject({ ownership_state: 'unassigned', import_batch_id: b.id, route_due_at: null });
    expect(Object.keys(c[0]!.imported_fields).length).toBeGreaterThan(0);
  });

  it('R-IMPORT-8 R-OWN-13: imported assignment writes `imported` events (actor import): no offer, no SLA, no notification', async () => {
    await fullStage(ih, w.admin, b.id, 'ownership');
    const jane = (await q<{ id: string; ownership_state: string; owner_user_id: string; first_touch_due_at: Date | null; release_due_at: Date | null; offer_id: string | null }>(
      "SELECT id, ownership_state, owner_user_id, first_touch_due_at, release_due_at, offer_id FROM contacts WHERE tenant_id = $1 AND display_name = 'Jane Doe'",
      [w.tenantId],
    ))[0]!;
    expect(jane).toMatchObject({ ownership_state: 'owned', owner_user_id: w.agents[0]!.userId, first_touch_due_at: null, release_due_at: null, offer_id: null });
    const ledger = await q<{ type: string; actor_kind: string; to_state: string }>('SELECT type, actor_kind, to_state FROM lead_ownership_events WHERE tenant_id = $1 AND contact_id = $2 ORDER BY seq', [w.tenantId, jane.id]);
    expect(ledger).toEqual([
      { type: 'imported', actor_kind: 'import', to_state: 'unassigned' },
      { type: 'imported', actor_kind: 'import', to_state: 'owned' },
    ]);
    expect(await q('SELECT 1 FROM notifications WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
    expect(await q("SELECT 1 FROM jobs WHERE tenant_id = $1 AND kind IN ('ownership.first_touch_breach','ownership.auto_release','ownership.offer_expiry')", [w.tenantId])).toHaveLength(0);
    const carla = (await q<{ ownership_state: string; pond_id: string }>("SELECT ownership_state, pond_id FROM contacts WHERE tenant_id = $1 AND display_name = 'Carla Dnc'", [w.tenantId]))[0]!;
    expect(carla).toEqual({ ownership_state: 'in_pond', pond_id: w.defaultPondId });
  });

  it('notes, messages and calls: imported = true with original timestamps; recordings labelled and not transcribed (R-IMPORT-12)', async () => {
    await fullStage(ih, w.admin, b.id, 'notes');
    await fullStage(ih, w.admin, b.id, 'messages');
    await fullStage(ih, w.admin, b.id, 'call_recordings');
    const notes = await q<{ body: string; imported: boolean; created_at: Date; source: string }>('SELECT body, imported, created_at, source FROM notes WHERE tenant_id = $1 ORDER BY created_at', [w.tenantId]);
    expect(notes.find((n) => n.body.includes('Wants 3 beds & a yard.'))).toMatchObject({ imported: true, source: 'import', created_at: new Date('2026-01-15T16:00:00Z') });
    expect((await records(w.admin, b.id, 'notes')).find((r) => r.sourceRef.endsWith('/10003'))!.issues.map((i) => i.code)).toContain('PARENT_NOT_FOUND');
    const msgs = await q<{ direction: string; status: string; initiator: string; occurred_at: Date; imported: boolean }>('SELECT direction, status, initiator, occurred_at, imported FROM messages WHERE tenant_id = $1 ORDER BY occurred_at', [w.tenantId]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ direction: 'inbound', status: 'received', initiator: 'import', imported: true, occurred_at: new Date('2026-03-01T18:00:00Z') });
    const rec = await q<{ consent_basis: string; status: string; source: string; object_id: string | null }>('SELECT consent_basis, status, source, object_id FROM recordings WHERE tenant_id = $1', [w.tenantId]);
    expect(rec).toEqual([{ consent_basis: 'unknown_imported', status: 'stored', source: 'import_fub', object_id: expect.any(String) }]);
    const call1 = await q<{ recording_decision: { label: string }; imported: boolean }>('SELECT recording_decision, imported FROM calls WHERE tenant_id = $1 AND duration_s = 312', [w.tenantId]);
    expect(call1[0]).toMatchObject({ imported: true, recording_decision: { label: 'recording notice unknown' } });
    expect(await q("SELECT 1 FROM jobs WHERE tenant_id = $1 AND kind = 'comms.transcribe'", [w.tenantId])).toHaveLength(0);
  });

  it('R-IMPORT-6: imported history never pauses, hands back, raises exceptions, starts SLAs or counts as a touch', async () => {
    expect(await q('SELECT 1 FROM conversations WHERE tenant_id = $1 AND automation_paused_at IS NOT NULL', [w.tenantId])).toHaveLength(0);
    expect(await q("SELECT 1 FROM assistant_actions WHERE tenant_id = $1 AND kind = 'handback'", [w.tenantId])).toHaveLength(0);
    expect(await q('SELECT 1 FROM exception_items WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
    expect(await q('SELECT 1 FROM contacts WHERE tenant_id = $1 AND (first_touch_at IS NOT NULL OR last_human_touch_at IS NOT NULL OR last_inbound_at IS NOT NULL OR first_touch_due_at IS NOT NULL)', [w.tenantId])).toHaveLength(0);
    expect(await q("SELECT 1 FROM lead_ownership_events WHERE tenant_id = $1 AND type IN ('first_touch_recorded','first_touch_breached','offered')", [w.tenantId])).toHaveLength(0);
    // scoreboards and caps read human / assistant rows only: imported history is invisible to them
    expect(await q('SELECT * FROM v_agent_activity_daily WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
    expect(await q('SELECT * FROM v_speed_to_lead WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
  });

  it('R-CONSENT-3 E40: grants stay imported_unverified; unsubscribes and opt-outs are revocations at commit; DNC is a suppression', async () => {
    // outbound-2: the contacts commit already applied the opt-outs (revocations + DNC), never a grant
    const before = await q<{ event_type: string }>('SELECT DISTINCT event_type FROM consent_events WHERE tenant_id = $1', [w.tenantId]);
    expect(before).toEqual([{ event_type: 'revoke' }]);
    const d = await dryRunStage(ih, w.admin, b.id, 'consent');
    const recs = await records(w.admin, b.id, 'consent');
    // Bob's only consent data is opt-outs (his grants are overridden): nothing left for this stage
    expect(recs.find((r) => r.sourceRef === 'fub:people/1002')!.dryRunOutcome).toBe('duplicate');
    expect(recs.find((r) => r.sourceRef === 'fub:people/1001')!.planned).toBe('record');
    expect(d.counts!.source).toBe(7);
    expect((await approve(w.admin, b.id, 'consent', d.dryRunSha256 as string)).status).toBe(200);
    await commitStage(ih, w.admin, b.id, 'consent');
    const ev = await q<{ event_type: string; consent_level: string; channel: string; imported: boolean; source: string; original_provenance: unknown }>(
      'SELECT event_type, consent_level, channel, imported, source, original_provenance FROM consent_events WHERE tenant_id = $1',
      [w.tenantId],
    );
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) {
      expect(e.imported).toBe(true);
      expect(e.source).toBe('import_fub');
      expect(e.original_provenance).not.toBeNull();
      if (e.event_type === 'grant') expect(e.consent_level).toBe('imported_unverified');
      else expect([e.event_type, e.consent_level]).toEqual(['revoke', 'none']);
    }
    // Bob: smsOptIn but the phone is opted out → only the revoke; email unsubscribed → revoke
    const bob = await q<{ channel: string; status: string }>(
      "SELECT cs.channel, cs.status FROM consent_state cs JOIN contact_points p ON p.tenant_id = cs.tenant_id AND p.address_hmac = cs.address_hmac JOIN contacts c ON c.id = p.contact_id WHERE c.tenant_id = $1 AND c.display_name = 'Bob Unsub' ORDER BY cs.channel, cs.purpose",
      [w.tenantId],
    );
    expect(bob.length).toBeGreaterThan(0);
    for (const s of bob) expect(s.status).toBe('revoked');
    const jane = await q<{ channel: string; status: string; consent_level: string }>(
      "SELECT DISTINCT cs.channel, cs.status, cs.consent_level FROM consent_state cs JOIN contact_points p ON p.tenant_id = cs.tenant_id AND p.address_hmac = cs.address_hmac JOIN contacts c ON c.id = p.contact_id WHERE c.tenant_id = $1 AND c.display_name = 'Jane Doe' AND cs.channel = 'sms'",
      [w.tenantId],
    );
    expect(jane).toEqual([{ channel: 'sms', status: 'granted', consent_level: 'imported_unverified' }]);
    const sup = await q<{ reason: string; channel: string; imported: boolean }>('SELECT reason, channel, imported FROM suppressions WHERE tenant_id = $1', [w.tenantId]);
    expect(sup).toEqual([{ reason: 'import_dnc', channel: 'all', imported: true }]);
    const v = await verify(w.admin, b.id, 'consent');
    expect(v.res.status).toBe(200);
  });

  it('the report reconciles every category exactly and never claims more than the counts show', async () => {
    const r = await call<{ categories: { category: string; source: number; imported: number; needsReview: number; rejected: number; duplicate: number; reconciles: boolean; lines: string[]; phase: string }[] }>(w.admin, 'GET', `/imports/${b.id}/report`);
    expect(r.status).toBe(200);
    expect(r.body.categories.map((c) => c.category)).toEqual(['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent']);
    for (const c of r.body.categories) {
      expect(c.reconciles).toBe(true);
      expect(c.source).toBe(c.imported + c.needsReview + c.rejected + c.duplicate);
      expect(c.phase).toBe('committed');
      // every number in the copy is one of the row's counts
      const nums = c.lines.flatMap((l) => [...l.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, ''))));
      const allowed = new Set([c.source, c.imported, c.needsReview, c.rejected, c.duplicate, 1]);
      for (const n of nums) if (c.category !== 'consent') expect(allowed.has(n)).toBe(true);
    }
    const consent = r.body.categories.find((c) => c.category === 'consent')!;
    expect(consent.lines.join(' ')).toMatch(/had texting permission in Follow Up Boss\. We kept that as history; the assistant won't text them automatically until they confirm\./);
    expect(consent.lines.join(' ')).toMatch(/stay[s]? opted out/);
    expect(r.body.categories.find((c) => c.category === 'call_recordings')!.lines.join(' ')).toMatch(/recording notice unknown/);
    expect((await batchOf(w.admin, b.id)).status).toBe('committed');
  });

  it('R-IMPORT-1: after the snapshot, no step read live FUB again', () => {
    // the snapshot job itself: one page per collection, the recording, and a count page each for tasks and appointments (E233)
    expect(ih.fub.calls.slice(8, callsAfterSnapshot).filter((c) => c.op === 'count').map((c) => c.collection)).toEqual(['tasks', 'appointments']);
    expect(ih.fub.calls.slice(callsAfterSnapshot)).toEqual([]);
    const lists = ih.fub.calls.filter((c) => c.op === 'list').length;
    expect(lists).toBe(6); // one page per collection, all during the snapshot job
  });
});
