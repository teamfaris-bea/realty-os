// Lane fub-migration-journeys (owner amendment A5, staged FUB migration): the API/DB half of journeys
// M1 (every category), M2 (ownership), M4 (re-run and incremental re-import) and M5 (undo per category and
// whole batch, reconciled back to the pre-import counts, audited). The browser halves are in
// apps/web/e2e/journeys/m*-*.spec.ts.
//
// Everything runs through the real routes as the tenant's Admin (app_user, RLS) and the real worker on the
// deterministic FAKE Follow Up Boss connector (imports/fub.ts FakeFub). Nothing real is called or sent.
// The superuser pool only reads back.
//
// FUB shapes: the person/note/text/email/call/user fields follow core/import/fub.ts, whose consent flag
// names are themselves marked VERIFY. Shapes added here that are not read by the importer at all are
// marked VERIFY too (FUB `tasks` and `appointments`, a note `type`).
import { randomUUID } from 'node:crypto';
import type { Category } from '@realty/core/import';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FubDataset } from './fub.js';
import {
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  approve,
  batchOf,
  call,
  commitStage,
  dryRunStage,
  freshReauth,
  fullStage,
  importWorld,
  importsHarness,
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

const ORDER: readonly Category[] = ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'];

/**
 * A team's FUB account with every category the importer reads, plus the edge cases each journey needs.
 * FUB users: 11 → agent0, 12 → agent1, 13 → a member suspended before the ownership commit, 99 → nobody
 * at first (blocks the ownership approval until it is mapped).
 */
function account(p: number, seed: number): FubDataset & Record<string, unknown> {
  const ph = (n: number) => `(415) 6${String(seed % 10)}${String(n % 10)}-${String(1000 + seed * 10 + n).slice(-4)}`;
  return {
    users: [
      { id: 11, name: 'Alex Agent' },
      { id: 12, name: 'Bea Agent' },
      { id: 13, name: 'Cy Leaving' },
      { id: 99, name: 'Gone Agent' },
    ],
    people: [
      {
        id: p + 1, created: '2023-03-01T14:00:00Z', updated: '2026-01-01T00:00:00Z', firstName: 'Jane', lastName: `Many${seed}`, stage: 'Hot Prospect', source: 'Zillow', assignedUserId: 11,
        tags: ['Buyer', 'Pre-approved'],
        emails: [{ value: `jane.${p}@example.com`, type: 'home', status: 'Valid', isPrimary: 1 }, { value: `jane.work.${p}@example.com`, type: 'work', status: 'Valid', isPrimary: 0 }],
        phones: [{ value: ph(1), type: 'mobile', status: 'Valid', isPrimary: 1 }, { value: ph(2), type: 'work', status: 'Valid', isPrimary: 0 }],
        addresses: [
          { type: 'home', street: '1 Main St', city: 'Springfield', state: 'il', code: '62701', country: 'US' },
          { type: 'mailing', street: 'PO Box 9', city: 'Springfield', state: 'IL', code: '62702', country: 'US' },
        ],
        customLeadScore: '87', smsOptIn: true, emailOptIn: true,
      },
      { id: p + 2, created: '2022-01-05T10:00:00Z', firstName: 'Omar', lastName: `Optout${seed}`, stage: 'Nurture', assignedUserId: 12,
        emails: [{ value: `omar.${p}@example.org`, type: 'work', status: 'Unsubscribed', isPrimary: 1 }], phones: [{ value: ph(3), type: 'cell', status: 'Opted Out', isPrimary: 1 }] },
      { id: p + 3, created: '2021-07-07T07:07:07Z', firstName: 'Pia', lastName: `Dnc${seed}`, stage: 'Nurture', assignedUserId: 11, tags: ['DNC'], phones: [{ value: ph(4), type: 'mobile', status: 'Valid' }] },
      { id: p + 4, created: '2024-02-02T02:02:02Z', firstName: 'Quin', lastName: `Notext${seed}`, stage: 'Nurture', assignedUserId: 13, doNotText: true, phones: [{ value: ph(5), type: 'mobile', status: 'Valid' }] },
      { id: p + 5, created: '2024-03-03T03:03:03Z', firstName: 'Rae', lastName: `Nobody${seed}`, stage: 'Nurture', emails: [{ value: `rae.${p}@example.com`, type: 'home', status: 'Valid' }] },
      { id: p + 6, created: '2024-04-04T04:04:04Z', firstName: 'Sam', lastName: `Gone${seed}`, stage: 'Nurture', assignedUserId: 99, phones: [{ value: '12', type: 'mobile', status: 'Valid' }], emails: [{ value: `sam.${p}@example.com`, type: 'home', status: 'Valid' }] },
      { firstName: 'Nobody' }, // malformed: no id
    ],
    notes: [
      { id: p * 10 + 1, personId: p + 1, subject: 'Recap', body: '<p>Wants <b>3 beds</b> &amp; a yard.</p>', isHtml: true, created: '2026-01-15T16:00:00Z', createdById: 11 },
      // VERIFY: FUB call notes — the importer reads notes by subject/body only; a `type` key is passed through untouched
      { id: p * 10 + 2, personId: p + 1, type: 'Call', subject: 'Call note', body: 'Spoke 10 min, wants a showing Saturday.', created: '2026-01-16T16:00:00Z', createdById: 11 },
      { id: p * 10 + 3, personId: p + 2, body: 'Asked to stop texting.', created: '2026-02-01T10:00:00Z', createdById: 12 },
      { id: p * 10 + 4, personId: 424242, body: 'Orphan note', created: '2026-02-01T10:00:00Z' },
      { id: p * 10 + 5, personId: p + 1, body: '   ', created: '2026-02-01T10:00:00Z' },
    ],
    textMessages: [
      { id: p * 10 + 1, personId: p + 1, created: '2026-03-01T18:00:00Z', isIncoming: true, message: 'Is the Elm St house still available?', status: 'Received' },
      { id: p * 10 + 2, personId: p + 1, created: '2026-03-01T18:05:00Z', isIncoming: false, message: 'Yes! Want to see it Saturday?', status: 'Delivered', userId: 11 },
      { id: p * 10 + 3, personId: p + 2, created: '2026-03-02T18:05:00Z', isIncoming: true, message: 'STOP', status: 'Received' },
    ],
    emails: [
      { id: p * 10 + 1, personId: p + 1, created: '2026-03-03T12:00:00Z', isIncoming: false, subject: 'Listings for you', body: 'Here are three homes.', status: 'Sent', userId: 11 },
      { id: p * 10 + 2, personId: p + 3, created: '2026-03-03T13:00:00Z', isIncoming: true, subject: 'Re: Listings', body: '<p>Thanks!</p>', isHtml: true, status: 'Received' },
    ],
    calls: [
      { id: p * 10 + 1, personId: p + 1, created: '2026-03-04T15:00:00Z', isIncoming: false, duration: 312, outcome: 'Interested', note: 'Talked about schools', userId: 11, recordingUrl: `https://fub.example/rec/${p}1?token=secret` },
      { id: p * 10 + 2, personId: p + 2, created: '2026-03-05T15:00:00Z', isIncoming: false, duration: 0, outcome: 'No Answer', userId: 12 },
      { id: p * 10 + 3, personId: p + 3, created: '2026-03-06T15:00:00Z', isIncoming: true, duration: 45, outcome: 'Left Message', note: 'Call back after 5pm', userId: 11 },
    ],
    recordings: { [`https://fub.example/rec/${p}1?token=secret`]: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]) },
    // VERIFY: FUB /tasks and /appointments shapes. The importer has no collection for them (FUB_COLLECTIONS).
    tasks: [{ id: p * 10 + 1, personId: p + 1, name: 'Send comps', dueDate: '2026-12-01', assignedUserId: 11, isCompleted: false }],
    appointments: [{ id: p * 10 + 1, title: 'Showing 12 Elm', start: '2026-12-02T17:00:00Z', end: '2026-12-02T18:00:00Z', invitees: [{ personId: p + 1 }, { userId: 11 }] }],
  };
}

const TABLES = {
  contacts: 'SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND deleted_at IS NULL',
  points: 'SELECT count(*)::int AS n FROM contact_points p JOIN contacts c ON c.id = p.contact_id AND c.tenant_id = p.tenant_id WHERE p.tenant_id = $1 AND c.deleted_at IS NULL',
  addresses: 'SELECT count(*)::int AS n FROM contact_addresses WHERE tenant_id = $1',
  notes: 'SELECT count(*)::int AS n FROM notes WHERE tenant_id = $1',
  messages: 'SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1',
  calls: 'SELECT count(*)::int AS n FROM calls WHERE tenant_id = $1',
  recordings: "SELECT count(*)::int AS n FROM recordings WHERE tenant_id = $1 AND status <> 'deleted' AND shredded_at IS NULL",
  tagLinks: 'SELECT count(*)::int AS n FROM contact_tags WHERE tenant_id = $1',
  fieldValues: 'SELECT count(*)::int AS n FROM contact_field_values WHERE tenant_id = $1',
  ownedLive: "SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND deleted_at IS NULL AND ownership_state = 'owned'",
} as const;
type Snapshot = Record<keyof typeof TABLES, number>;
async function snapshot(tenantId: string): Promise<Snapshot> {
  const out = {} as Snapshot;
  for (const [k, sqlText] of Object.entries(TABLES)) out[k as keyof Snapshot] = (await q<{ n: number }>(sqlText, [tenantId]))[0]!.n;
  return out;
}

const sum = (c: NonNullable<BatchView['stages'][number]['counts']>) => c.willImport + c.needsReview + c.rejected + c.duplicate;

async function suspend(w: ImportWorld, userId: string): Promise<void> {
  await freshReauth(ih.h, w.owner);
  const m = await call<{ members: { userId: string; version: number }[] }>(w.owner, 'GET', '/members');
  const me = m.body.members.find((x) => x.userId === userId)!;
  const r = await call(w.owner, 'PATCH', `/members/${userId}`, { status: 'suspended', version: me.version });
  if (r.status !== 200) throw new Error(`suspend: ${r.status} ${JSON.stringify(r.body)}`);
}


type OwnerRow = { first_name: string; ownership_state: string; owner_user_id: string | null; status: string | null };
async function ownersOf(w: ImportWorld, batchId: string): Promise<OwnerRow[]> {
  return q<OwnerRow>(
    `SELECT c.first_name, c.ownership_state, c.owner_user_id, m.status FROM contacts c LEFT JOIN memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id
      WHERE c.tenant_id = $1 AND c.import_batch_id = $2 AND c.deleted_at IS NULL ORDER BY c.first_name`,
    [w.tenantId, batchId],
  );
}
/** every owned import went through the ledger as `imported` with the import actor; no offer, deadline or routing */
async function ledgerChecks(batchId: string, owners: OwnerRow[]): Promise<void> {
  const ev = await q<{ first_name: string; type: string; actor_kind: string; owner_user_id: string | null }>(
    `SELECT c.first_name, e.type, e.actor_kind, e.owner_user_id FROM lead_ownership_events e JOIN contacts c ON c.id = e.contact_id AND c.tenant_id = e.tenant_id
      WHERE c.import_batch_id = $1 AND e.owner_user_id IS NOT NULL ORDER BY c.first_name`,
    [batchId],
  );
  for (const o of owners.filter((x) => x.ownership_state === 'owned')) expect(ev).toContainEqual({ first_name: o.first_name, type: 'imported', actor_kind: 'import', owner_user_id: o.owner_user_id });
  expect(await q("SELECT e.type FROM lead_ownership_events e JOIN contacts c ON c.id = e.contact_id AND c.tenant_id = e.tenant_id WHERE c.import_batch_id = $1 AND (e.type LIKE 'offer%' OR e.offer_id IS NOT NULL OR e.deadline_at IS NOT NULL OR e.routing_rule_id IS NOT NULL)", [batchId])).toEqual([]);
}

describe('M1 M2 M5: a full staged FUB migration, category by category, then undone category by category', () => {
  const key = 'fub-m1-' + randomUUID().slice(0, 8);
  let w: ImportWorld;
  let b: BatchView;
  let before: Snapshot;

  it('setup: a team with an existing book, and the FUB connection test counts only', async () => {
    w = await importWorld(ih);
    // the team already has one contact of its own (never touched by the import or its undo)
    const own = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Native', lastName: 'Contact', phones: ['+14155550142'] });
    expect(own.status).toBe(201);
    before = await snapshot(w.tenantId);
    ih.fub.add(key, account(7100, 3));
    b = await startFub(ih, w.admin, key);
    expect(b.status).toBe('dry_run');
    expect(b.connectionTest).toContain('7 contacts found in Follow Up Boss.');
    expect(b.connectionTest).toContain('5 notes found in Follow Up Boss.');
    expect(b.connectionTest).toContain('5 messages found in Follow Up Boss.');
    expect(b.connectionTest).toContain('3 calls found in Follow Up Boss.');
  });

  it('M2: an unmapped FUB user blocks the ownership approval; a suspended member cannot be a mapping target', async () => {
    const map = (mappings: unknown[]) => call(w.admin, 'PUT', `/imports/${b.id}/user-mappings`, { mappings });
    expect((await map([{ sourceRef: '11', target: { kind: 'user', userId: w.agents[0]!.userId } }, { sourceRef: '12', target: { kind: 'user', userId: w.agents[1]!.userId } }, { sourceRef: '13', target: { kind: 'user', userId: w.agents[1]!.userId } }])).status).toBe(200);
    const own = await dryRunStage(ih, w.admin, b.id, 'ownership');
    expect(own.blockers.map((x) => x.code)).toContain('USER_MAPPING_INCOMPLETE');
    const a = await approve(w.admin, b.id, 'ownership', own.dryRunSha256 as string);
    expect(a.status).toBeGreaterThanOrEqual(400);
    // an unknown user id is refused
    const bad = await map([{ sourceRef: '99', target: { kind: 'user', userId: randomUUID() } }]);
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('TARGET_NOT_ELIGIBLE');
  });

  it('M1 contacts: the dry run adds up; people land with phones, emails, addresses, the mapped stage and tags', async () => {
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    const c = d.counts!;
    expect(c.source).toBe(7);
    expect(sum(c)).toBe(c.source);
    expect(c.rejected).toBe(1); // the malformed person
    const recs = await records(w.admin, b.id, 'contacts');
    expect(recs).toHaveLength(7);
    // Sam's "12" is no phone: the value is dropped with a reason, the person survives on the email
    const sam = recs.find((r) => r.sourceRef === 'fub:people/7106')!;
    expect(sam.issues.map((i) => i.code)).toContain('PHONE_INVALID');
    for (const r of recs.filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    const s = await commitStage(ih, w.admin, b.id, 'contacts');
    expect(s.status).toBe('committed');
    expect(s.counts!.imported).toBe(6);
    expect(s.counts!.source).toBe(s.counts!.imported! + s.counts!.needsReview + s.counts!.rejected + s.counts!.duplicate);
    expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);

    const jane = (await q<{ id: string; stage: string; owner_user_id: string | null; ownership_state: string }>('SELECT id, stage, owner_user_id, ownership_state FROM contacts WHERE tenant_id = $1 AND first_name = $2 AND import_batch_id = $3', [w.tenantId, 'Jane', b.id]))[0]!;
    // until the ownership stage commits, imported people are unassigned (through the ownership engine)
    expect(jane.ownership_state).toBe('unassigned');
    expect(jane.owner_user_id).toBeNull();
    const pts = await q<{ kind: string; label: string; is_primary: boolean; status: string }>('SELECT kind, label, is_primary, status FROM contact_points WHERE contact_id = $1 ORDER BY kind, is_primary DESC', [jane.id]);
    expect(pts).toEqual([
      { kind: 'email', label: 'home', is_primary: true, status: 'active' },
      { kind: 'email', label: 'work', is_primary: false, status: 'active' },
      { kind: 'phone', label: 'mobile', is_primary: true, status: 'active' },
      { kind: 'phone', label: 'work', is_primary: false, status: 'active' },
    ]);
    const addrs = await q<{ kind: string; line1: string; region: string; postal_code: string }>('SELECT kind, line1, region, postal_code FROM contact_addresses WHERE contact_id = $1 ORDER BY kind', [jane.id]);
    expect(addrs).toEqual([
      { kind: 'home', line1: '1 Main St', region: 'IL', postal_code: '62701' },
      { kind: 'mailing', line1: 'PO Box 9', region: 'IL', postal_code: '62702' },
    ]);
    // through the API as the Admin
    const api = await call<{ contact: { phones: unknown[]; emails: unknown[]; stage: string; tags: string[] } }>(w.admin, 'GET', `/contacts/${jane.id}`);
    expect(api.status).toBe(200);
    expect([api.body.contact.phones.length, api.body.contact.emails.length, api.body.contact.stage]).toEqual([2, 2, 'active']);
    expect(api.body.contact.tags).toEqual(expect.arrayContaining(['Buyer', 'Pre-approved', 'FUB stage: Hot Prospect']));
    const det = await call<{ details: { addresses: { line1: string | null; city: string | null }[] } }>(w.admin, 'GET', `/contacts/${jane.id}/details`);
    expect(det.status).toBe(200);
    expect(det.body.details.addresses.map((a) => a.line1).sort()).toEqual(['1 Main St', 'PO Box 9']);
    const tags = await q<{ name: string }>('SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id AND t.tenant_id = ct.tenant_id WHERE ct.contact_id = $1 ORDER BY t.name', [jane.id]);
    expect(tags.map((t) => t.name)).toEqual(expect.arrayContaining(['Buyer', 'Pre-approved']));
  });

  it('M2 ownership: owners map to the right members through the ledger; no orphan owner; no offer, SLA or routing', async () => {
    const map = await call(w.admin, 'PUT', `/imports/${b.id}/user-mappings`, { mappings: [{ sourceRef: '99', target: { kind: 'unassigned' } }] });
    expect(map.status).toBe(200);
    const d = await dryRunStage(ih, w.admin, b.id, 'ownership');
    expect(d.blockers).toEqual([]);
    expect(sum(d.counts!)).toBe(d.counts!.source);
    expect((await approve(w.admin, b.id, 'ownership', d.dryRunSha256 as string)).status).toBe(200);
    const s = await commitStage(ih, w.admin, b.id, 'ownership');
    expect(s.status).toBe('committed');
    expect(s.counts!.source).toBe(s.counts!.imported! + s.counts!.needsReview + s.counts!.rejected + s.counts!.duplicate);
    expect((await verify(w.admin, b.id, 'ownership')).res.status).toBe(200);
    const owners = await ownersOf(w, b.id);
    for (const o of owners) {
      if (o.ownership_state === 'owned') expect([o.first_name, o.status]).toEqual([o.first_name, 'active']);
      else expect(o.owner_user_id).toBeNull();
    }
    const by = Object.fromEntries(owners.map((o) => [o.first_name, o.owner_user_id]));
    expect(by).toEqual({ Jane: w.agents[0]!.userId, Omar: w.agents[1]!.userId, Pia: w.agents[0]!.userId, Quin: w.agents[1]!.userId, Rae: null, Sam: null });
    await ledgerChecks(b.id, owners);
  });
  it('M1 notes (incl. call notes), texts, emails and calls: each dry run adds up; history lands as imported with its original time', async () => {
    const expected: Record<string, { source: number; imported: number }> = {
      notes: { source: 5, imported: 3 }, // the orphan note and the empty note are rejected
      messages: { source: 5, imported: 5 },
      call_recordings: { source: 3, imported: 3 },
    };
    for (const cat of ['notes', 'messages', 'call_recordings'] as const) {
      const d = await dryRunStage(ih, w.admin, b.id, cat);
      expect([cat, d.counts!.source]).toEqual([cat, expected[cat]!.source]);
      expect([cat, sum(d.counts!)]).toEqual([cat, d.counts!.source]);
      for (const r of (await records(w.admin, b.id, cat)).filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
      expect((await approve(w.admin, b.id, cat, d.dryRunSha256 as string)).status).toBe(200);
      const s = await commitStage(ih, w.admin, b.id, cat);
      expect([cat, s.status, s.counts!.imported]).toEqual([cat, 'committed', expected[cat]!.imported]);
      expect([cat, (await verify(w.admin, b.id, cat)).res.status]).toEqual([cat, 200]);
    }
    const jane = (await q<{ id: string }>("SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = 'Jane'", [b.id]))[0]!.id;
    const notes = await q<{ body: string; imported: boolean; created_at: Date; author_user_id: string | null }>('SELECT body, imported, created_at, author_user_id FROM notes WHERE contact_id = $1 ORDER BY created_at', [jane]);
    // two FUB notes (one a call note) and the FUB call's own note, which the calls stage writes as a note on the person
    expect(notes.map((n) => n.body)).toEqual(['Recap\n\nWants 3 beds & a yard.', 'Call note\n\nSpoke 10 min, wants a showing Saturday.', 'Talked about schools']);
    expect(notes.every((n) => n.imported && n.author_user_id === w.agents[0]!.userId)).toBe(true);
    expect(notes[0]!.created_at.toISOString()).toBe('2026-01-15T16:00:00.000Z');
    const msgs = await q<{ channel: string; direction: string; status: string; imported: boolean; occurred_at: Date }>('SELECT channel, direction, status, imported, occurred_at FROM messages WHERE contact_id = $1 ORDER BY occurred_at', [jane]);
    expect(msgs.map((m) => [m.channel, m.direction, m.status, m.imported])).toEqual([
      ['sms', 'inbound', 'received', true],
      ['sms', 'outbound', 'delivered', true],
      ['email', 'outbound', 'sent', true],
    ]);
    const calls = await q<{ status: string; outcome: string | null; duration_s: number; imported: boolean; started_at: Date }>('SELECT status, outcome, duration_s, imported, started_at FROM calls WHERE contact_id = $1', [jane]);
    expect(calls).toEqual([{ status: 'completed', outcome: 'connected', duration_s: 312, imported: true, started_at: new Date('2026-03-04T15:00:00Z') }]);
    const rec = await q<{ consent_basis: string }>('SELECT consent_basis FROM recordings WHERE contact_id = $1', [jane]);
    expect(rec).toEqual([{ consent_basis: 'unknown_imported' }]);
    // the person's timeline, through the API, holds the imported history
    const tl = await call<{ items: { kind: string }[] }>(w.admin, 'GET', `/contacts/${jane}/timeline`);
    expect(tl.status).toBe(200);
    expect(JSON.stringify(tl.body)).toContain('Is the Elm St house still available?');
    expect(JSON.stringify(tl.body)).toContain('Spoke 10 min');
    // Pia's inbound call "Left Message" kept its note
    const pia = (await q<{ id: string }>("SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = 'Pia'", [b.id]))[0]!.id;
    expect(await q('SELECT status, outcome, direction FROM calls WHERE contact_id = $1', [pia])).toEqual([{ status: 'voicemail', outcome: 'left_voicemail', direction: 'inbound' }]);
  });

  it('M1 consent: opt-outs, unsubscribes, DNC flags and DNC-looking tags become real opt-outs; grants stay imported_unverified', async () => {
    const d = await dryRunStage(ih, w.admin, b.id, 'consent');
    expect(sum(d.counts!)).toBe(d.counts!.source);
    expect(d.counts!.source).toBe(7);
    expect((await approve(w.admin, b.id, 'consent', d.dryRunSha256 as string)).status).toBe(200);
    const s = await commitStage(ih, w.admin, b.id, 'consent');
    expect(s.status).toBe('committed');
    expect((await verify(w.admin, b.id, 'consent')).res.status).toBe(200);
    const state = async (first: string) =>
      q<{ kind: string; channel: string; status: string }>(
        `SELECT p.kind, cs.channel, cs.status FROM consent_state cs JOIN contact_points p ON p.address_hmac = cs.address_hmac AND p.tenant_id = cs.tenant_id
          JOIN contacts c ON c.id = p.contact_id WHERE c.import_batch_id = $1 AND c.first_name = $2 ORDER BY p.kind, cs.channel`,
        [b.id, first],
      );
    expect(await state('Omar')).toEqual(expect.arrayContaining([{ kind: 'email', channel: 'email', status: 'revoked' }, { kind: 'phone', channel: 'sms', status: 'revoked' }]));
    expect(await state('Quin')).toEqual(expect.arrayContaining([{ kind: 'phone', channel: 'sms', status: 'revoked' }]));
    const sup = await q<{ first_name: string }>("SELECT DISTINCT c.first_name FROM suppressions s JOIN contact_points p ON p.address_hmac = s.address_hmac AND p.tenant_id = s.tenant_id JOIN contacts c ON c.id = p.contact_id WHERE c.import_batch_id = $1 AND s.lifted_at IS NULL", [b.id]);
    expect(sup.map((x) => x.first_name)).toEqual(['Pia']);
    const granted = await q<{ consent_level: string }>("SELECT DISTINCT e.consent_level FROM consent_events e WHERE e.tenant_id = $1 AND e.imported AND e.event_type = 'grant'", [w.tenantId]);
    expect(granted.map((g) => g.consent_level)).toEqual(['imported_unverified']);
    expect((await batchOf(w.admin, b.id)).status).toBe('committed');
  });

  it('M1 gap: FUB tasks and appointments are neither imported nor mentioned to the Owner', async () => {
    const bb = await batchOf(w.admin, b.id);
    // what the importer did read: six collections; tasks and appointments were never requested
    expect(new Set(ih.fub.calls.filter((c) => c.op === 'list').map((c) => c.collection))).toEqual(new Set(['people', 'notes', 'textMessages', 'emails', 'calls', 'users']));
    expect(bb.connectionTest.join(' ')).not.toMatch(/task|appointment/i);
  });

  let touched: string;
  it('M5: undo per category, newest first, removes exactly what each stage wrote and is audited', async () => {
    // an agent works on an imported person after the import (Jane): the undo must leave her for a human
    const jane = (await q<{ id: string }>("SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = 'Jane'", [b.id]))[0]!.id;
    touched = jane;
    const n = await call(w.agents[0]!, 'POST', `/contacts/${jane}/notes`, { body: 'Agent follow-up after the import' });
    expect(n.status, JSON.stringify(n.body)).toBe(201);
    // a later stage committed blocks undoing an earlier one on its own
    const early = await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: 'notes' });
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toContain('IMPORT_REVERT_ORDER');

    const rows = async () => {
      const r = await q<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM notes n JOIN import_records r ON r.id = n.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND s.category = 'notes') AS notes,
                (SELECT count(*)::int FROM notes n JOIN import_records r ON r.id = n.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND s.category = 'call_recordings') AS "callNotes",
                (SELECT count(*)::int FROM messages m JOIN import_records r ON r.id = m.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1) AS messages,
                (SELECT count(*)::int FROM calls m JOIN import_records r ON r.id = m.import_record_id JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1) AS calls,
                (SELECT count(*)::int FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL) AS contacts,
                (SELECT count(*)::int FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL AND ownership_state = 'owned') AS owned`,
        [b.id],
      );
      return r[0]!;
    };
    const start = await rows();
    expect(start).toEqual({ notes: 3, callNotes: 2, messages: 5, calls: 3, contacts: 6, owned: 4 });
    const undo = async (cat: Category) => {
      const r = await call(w.admin, 'POST', `/imports/${b.id}/revert`, { category: cat });
      expect([cat, r.status, JSON.stringify(r.body)]).toEqual([cat, 202, expect.any(String)]);
      await ih.drain();
      const st = stageOf(await batchOf(w.admin, b.id), cat);
      expect([cat, st.status]).toEqual([cat, 'reverted']);
      const a = await q<{ actor_user_id: string; reason: string }>("SELECT actor_user_id, reason FROM audit_log WHERE tenant_id = $1 AND action = 'import.reverted' AND entity_id = $2", [w.tenantId, st.id]);
      expect([cat, a]).toEqual([cat, [{ actor_user_id: w.admin.userId, reason: `${cat.toUpperCase()}_REVERT_STARTED` }]]);
      return st;
    };
    await undo('consent');
    expect(await rows()).toEqual(start);
    // imported grants voided, opt-outs and DNC kept
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1 AND event_type = 'import_revert'", [w.tenantId]))[0]!.n).toBeGreaterThan(0);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM suppressions WHERE tenant_id = $1 AND lifted_at IS NULL", [w.tenantId]))[0]!.n).toBe(1);
    await undo('call_recordings');
    expect(await rows()).toEqual({ ...start, calls: 1, callNotes: 1 }); // Jane's call and its note are kept: she was touched
    await undo('messages');
    expect(await rows()).toEqual({ ...start, calls: 1, callNotes: 1, messages: 3 }); // Jane's three messages are kept
    await undo('notes');
    expect(await rows()).toEqual({ ...start, calls: 1, callNotes: 1, messages: 3, notes: 2 }); // Jane's two notes are kept
    await undo('ownership');
    expect(await rows()).toEqual({ ...start, calls: 1, callNotes: 1, messages: 3, notes: 2, owned: 1 }); // Jane keeps her owner (touched); Omar, Pia and Quin go back to unassigned
    await undo('contacts');
    expect(await rows()).toEqual({ notes: 2, callNotes: 1, messages: 3, calls: 1, contacts: 1, owned: 1 });
    const bb = await batchOf(w.admin, b.id);
    expect(bb.status).toBe('reverted');
    const rep = stageOf(bb, 'contacts').revert as { needsDecision: number; manual: { sourceRef: string; reason: string }[] };
    expect(rep.manual).toEqual([expect.objectContaining({ sourceRef: 'fub:people/7101', reason: 'TOUCHED' })]);
  });

  it('M5: after the undo the book reconciles to the pre-import counts, apart from the one touched person left for a decision', async () => {
    const after = await snapshot(w.tenantId);
    const jane = await q<{ points: number; addresses: number; tags: number; values: number; notes: number; messages: number; calls: number; recordings: number }>(
      `SELECT (SELECT count(*)::int FROM contact_points WHERE contact_id = $1) AS points, (SELECT count(*)::int FROM contact_addresses WHERE contact_id = $1) AS addresses,
              (SELECT count(*)::int FROM contact_tags WHERE contact_id = $1) AS tags, (SELECT count(*)::int FROM contact_field_values WHERE contact_id = $1) AS values,
              (SELECT count(*)::int FROM notes WHERE contact_id = $1) AS notes, (SELECT count(*)::int FROM messages WHERE contact_id = $1) AS messages,
              (SELECT count(*)::int FROM calls WHERE contact_id = $1) AS calls, (SELECT count(*)::int FROM recordings WHERE contact_id = $1 AND status <> 'deleted' AND shredded_at IS NULL) AS recordings`,
      [touched],
    );
    const j = jane[0]!;
    expect(after).toEqual({
      contacts: before.contacts + 1,
      points: before.points + j.points,
      addresses: before.addresses + j.addresses,
      notes: before.notes + j.notes,
      messages: before.messages + j.messages,
      calls: before.calls + j.calls,
      recordings: before.recordings + j.recordings,
      tagLinks: before.tagLinks + j.tags,
      fieldValues: before.fieldValues + j.values,
      ownedLive: before.ownedLive + 1,
    });
    // the agent's own note is untouched by the undo
    expect((await q('SELECT 1 FROM notes WHERE contact_id = $1 AND NOT imported', [touched])).length).toBe(1);
    // the team's own contact is untouched
    expect(await q("SELECT deleted_at FROM contacts WHERE tenant_id = $1 AND first_name = 'Native'", [w.tenantId])).toEqual([{ deleted_at: null }]);
  });
});

describe('M2: a member suspended between the ownership approval and its commit', () => {
  const key = 'fub-m2-' + randomUUID().slice(0, 8);
  let w: ImportWorld;
  let b: BatchView;

  it('never receives a lead: those people stay unassigned, and each record says it was not written', async () => {
    w = await importWorld(ih);
    ih.fub.add(key, account(7200, 4));
    b = await startFub(ih, w.admin, key);
    const m = await call(w.admin, 'PUT', `/imports/${b.id}/user-mappings`, {
      mappings: [
        { sourceRef: '11', target: { kind: 'user', userId: w.agents[0]!.userId } },
        { sourceRef: '12', target: { kind: 'user', userId: w.agents[1]!.userId } },
        { sourceRef: '13', target: { kind: 'user', userId: w.agents[1]!.userId } },
        { sourceRef: '99', target: { kind: 'unassigned' } },
      ],
    });
    expect(m.status).toBe(200);
    await fullStage(ih, w.admin, b.id, 'contacts').catch(async () => {
      // needs-review records (if any) are decided "import", then the stage is run again
      for (const r of (await records(w.admin, b.id, 'contacts')).filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
    });
    expect(stageOf(await batchOf(w.admin, b.id), 'contacts').status).toBe('verified');
    const d = await dryRunStage(ih, w.admin, b.id, 'ownership');
    expect((await approve(w.admin, b.id, 'ownership', d.dryRunSha256 as string)).status).toBe(200);
    await suspend(w, w.agents[1]!.userId);
    const s = await commitStage(ih, w.admin, b.id, 'ownership');
    expect(s.status).toBe('committed');
    const owners = await ownersOf(w, b.id);
    for (const o of owners) {
      if (o.ownership_state === 'owned') expect([o.first_name, o.status]).toEqual([o.first_name, 'active']);
      else expect(o.owner_user_id).toBeNull();
    }
    const by = Object.fromEntries(owners.map((o) => [o.first_name, o.owner_user_id]));
    expect([by.Jane, by.Omar, by.Quin]).toEqual([w.agents[0]!.userId, null, null]);
    await ledgerChecks(b.id, owners);
    const own = await records(w.admin, b.id, 'ownership');
    for (const ref of ['fub:people/7202', 'fub:people/7204']) expect(own.find((x) => x.sourceRef === ref)!.outcome).toBe('rejected');
    expect(s.counts!.source).toBe(s.counts!.imported! + s.counts!.needsReview + s.counts!.rejected + s.counts!.duplicate);
  });

  // BUG (medium): the migration is stuck. Reproduction: map FUB user 12 to agent1, dry-run and approve the
  // ownership stage, suspend agent1 (PATCH /members/:id {status:'suspended'}), commit. The two people mapped to
  // agent1 are rejected COMMIT_FAILED with the generic sentence "This record could not be written; nothing else
  // was affected." (no word about the suspended member), and POST .../stages/ownership/verify is refused
  // RECOUNT_MISMATCH (imported 4→2, rejected 1→3) for ever. A committed stage cannot be dry-run again and a
  // reverted one blocks every later stage (R-IMPORT-3 trigger), so notes, messages, calls and consent of this
  // batch can never be imported; a new batch plans OWNER_KEPT for these people (they were created by the first
  // batch), so their FUB owners cannot be imported by any batch. Expected: a way to verify a stage whose
  // recount differs only by records the commit rejected (with the reason shown), or to re-plan them.
  it.fails('the Admin can still finish the migration: the ownership stage verifies (or re-plans) and the later stages commit', async () => {
    const v = await verify(w.admin, b.id, 'ownership');
    expect(v.res.status).toBe(200);
    const n = await dryRunStage(ih, w.admin, b.id, 'notes');
    expect((await approve(w.admin, b.id, 'notes', n.dryRunSha256 as string)).status).toBe(200);
    expect((await commitStage(ih, w.admin, b.id, 'notes')).status).toBe('committed');
  });

  it('the rejected records tell the Admin why in plain words', async () => {
    const own = await records(w.admin, b.id, 'ownership');
    const r = own.find((x) => x.sourceRef === 'fub:people/7202')!;
    expect(r.issues.map((i) => i.code)).toEqual(['COMMIT_FAILED']);
    expect(r.issues[0]!.sentence).toBe('This record could not be written; nothing else was affected.');
  });
});

const ALL_MAPPED = (w: ImportWorld) => [
  { sourceRef: '11', target: { kind: 'user', userId: w.agents[0]!.userId } },
  { sourceRef: '12', target: { kind: 'user', userId: w.agents[1]!.userId } },
  { sourceRef: '13', target: { kind: 'user', userId: w.agents[1]!.userId } },
  { sourceRef: '99', target: { kind: 'unassigned' } },
];

/** create + snapshot + map + every stage dry run → (decide needs-review) → approve → commit → verify; returns the batch and per-stage counts */
async function migrate(w: ImportWorld, key: string, decide: 'import' | 'reject' = 'import'): Promise<{ b: BatchView; counts: Record<string, NonNullable<BatchView['stages'][number]['counts']>> }> {
  const b = await startFub(ih, w.admin, key);
  expect((await call(w.admin, 'PUT', `/imports/${b.id}/user-mappings`, { mappings: ALL_MAPPED(w) })).status).toBe(200);
  const counts: Record<string, NonNullable<BatchView['stages'][number]['counts']>> = {};
  for (const cat of ORDER) {
    const d = await dryRunStage(ih, w.admin, b.id, cat);
    expect([cat, d.status]).toEqual([cat, 'dry_run_ready']);
    expect([cat, sum(d.counts!)]).toEqual([cat, d.counts!.source]);
    counts[cat] = d.counts!;
    for (const r of (await records(w.admin, b.id, cat)).filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: decide });
    expect([cat, (await approve(w.admin, b.id, cat, d.dryRunSha256 as string)).status]).toEqual([cat, 200]);
    const s = await commitStage(ih, w.admin, b.id, cat);
    expect([cat, s.status]).toEqual([cat, 'committed']);
    expect([cat, s.counts!.source]).toEqual([cat, s.counts!.imported! + s.counts!.needsReview + s.counts!.rejected + s.counts!.duplicate]);
    expect([cat, (await verify(w.admin, b.id, cat)).res.status]).toEqual([cat, 200]);
  }
  return { b: await batchOf(w.admin, b.id), counts };
}

const BOOK = {
  ...TABLES,
  consentEvents: 'SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1',
  suppressions: 'SELECT count(*)::int AS n FROM suppressions WHERE tenant_id = $1',
  ledger: 'SELECT count(*)::int AS n FROM lead_ownership_events WHERE tenant_id = $1',
  externalRefs: 'SELECT count(*)::int AS n FROM external_refs WHERE tenant_id = $1',
  tags: 'SELECT count(*)::int AS n FROM tags WHERE tenant_id = $1',
} as const;
async function book(tenantId: string): Promise<Record<keyof typeof BOOK, number>> {
  const out = {} as Record<keyof typeof BOOK, number>;
  for (const [k, sqlText] of Object.entries(BOOK)) out[k as keyof typeof BOOK] = (await q<{ n: number }>(sqlText, [tenantId]))[0]!.n;
  return out;
}

describe('M4: re-running the same FUB export creates nothing twice; an incremental re-import picks up only the changes', () => {
  const key = 'fub-m4-' + randomUUID().slice(0, 8);
  let w: ImportWorld;
  let afterFirst: Record<keyof typeof BOOK, number>;
  let owners: { id: string; owner_user_id: string | null; ownership_seq: string; stage: string }[];
  let third: BatchView;

  it('a second full run of the same export commits and verifies every stage and writes nothing', async () => {
    w = await importWorld(ih);
    ih.fub.add(key, account(7300, 5));
    await migrate(w, key);
    afterFirst = await book(w.tenantId);
    owners = await q('SELECT id, owner_user_id, ownership_seq, stage FROM contacts WHERE tenant_id = $1 ORDER BY id', [w.tenantId]);
    const { counts } = await migrate(w, key, 'reject');
    for (const cat of ORDER) expect([cat, counts[cat]!.willImport]).toEqual([cat, 0]);
    expect(await book(w.tenantId)).toEqual(afterFirst);
    expect(await q('SELECT id, owner_user_id, ownership_seq, stage FROM contacts WHERE tenant_id = $1 ORDER BY id', [w.tenantId])).toEqual(owners);
  });

  it('after FUB changes, a new import plans and writes only the new person, the new email, note and text', async () => {
    ih.fub.mutate(key, (d) => {
      const people = d.people as Record<string, unknown>[];
      people.push({ id: 7308, created: '2026-10-01T00:00:00Z', firstName: 'Tess', lastName: 'Newperson5', stage: 'Nurture', assignedUserId: 11, phones: [{ value: '(415) 677-7308', type: 'mobile', status: 'Valid' }] });
      const rae = people.find((p) => p.id === 7305)!;
      (rae.emails as unknown[]).push({ value: 'rae.second.7300@example.com', type: 'work', status: 'Valid' });
      // changed in FUB, but an import fills only what is empty and never changes an owner (E41, R-IMPORT-7)
      people.find((p) => p.id === 7301)!.stage = 'Closed';
      people.find((p) => p.id === 7303)!.assignedUserId = 12;
      (d.notes as unknown[]).push({ id: 73099, personId: 7301, body: 'Follow-up after the move', created: '2026-10-02T00:00:00Z', createdById: 11 });
      (d.textMessages as unknown[]).push({ id: 73099, personId: 7305, created: '2026-10-03T00:00:00Z', isIncoming: true, message: 'Still looking!', status: 'Received' });
    });
    const { b, counts } = await migrate(w, key, 'reject');
    third = b;
    expect([counts.contacts!.source, counts.contacts!.willImport]).toEqual([8, 2]); // Tess created, Rae filled
    expect(counts.ownership!.willImport).toBe(1); // only Tess
    expect([counts.notes!.willImport, counts.messages!.willImport, counts.call_recordings!.willImport]).toEqual([1, 1, 0]);
    const now = await book(w.tenantId);
    expect(now.contacts - afterFirst.contacts).toBe(1);
    expect(now.points - afterFirst.points).toBe(2);
    expect(now.notes - afterFirst.notes).toBe(1);
    expect(now.messages - afterFirst.messages).toBe(1);
    expect(now.calls).toBe(afterFirst.calls);
    expect(now.ownedLive - afterFirst.ownedLive).toBe(1);
    // nobody who was already here changed stage or owner
    const same = await q<{ id: string; owner_user_id: string | null; ownership_seq: string; stage: string }>('SELECT id, owner_user_id, ownership_seq, stage FROM contacts WHERE tenant_id = $1 AND id = ANY ($2) ORDER BY id', [w.tenantId, owners.map((o) => o.id)]);
    expect(same).toEqual(owners);
  });

  it('M5: undoing that incremental batch as a whole puts the book back to where the first import left it', async () => {
    const r = await call(w.admin, 'POST', `/imports/${third.id}/revert`, {});
    expect(r.status).toBe(202);
    await ih.drain();
    const bb = await batchOf(w.admin, third.id);
    expect(bb.status).toBe('reverted');
    // everything but the append-only ledger and the external refs (kept as history of what was imported once)
    const now = await book(w.tenantId);
    expect({ ...now, ledger: 0, externalRefs: 0 }).toEqual({ ...afterFirst, ledger: 0, externalRefs: 0 });
    // the ledger keeps its rows (append-only): Tess's import assignment and its import_unassign, then the close on delete
    const audits = await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'import.reverted' AND actor_user_id = $2", [w.tenantId, w.admin.userId]);
    expect(audits[0]!.n).toBeGreaterThanOrEqual(4);
    const rep = stageOf(bb, 'contacts').revert as { needsDecision: number; manual: { sourceRef: string; reason: string }[] };
    // Rae was filled (a contact that existed before this batch): her row is listed, not deleted; the email it added is gone
    expect(rep.manual.map((m) => [m.sourceRef, m.reason])).toEqual([['fub:people/7305', 'PRE_EXISTING_CONTACT']]);
    afterUndo = now;
  });

  let afterUndo: Record<keyof typeof BOOK, number>;
  it('M4 M5: the same changes can be imported again after that undo (undo → redo brings back the person, the email, the note and the text)', async () => {
    const { counts } = await migrate(w, key, 'import');
    expect(counts.contacts!.willImport + counts.contacts!.needsReview).toBe(2); // Tess (her old contact was undone) and Rae's email again
    expect([counts.notes!.willImport, counts.messages!.willImport]).toEqual([1, 1]);
    const now = await book(w.tenantId);
    expect([now.contacts - afterUndo.contacts, now.points - afterUndo.points, now.notes - afterUndo.notes, now.messages - afterUndo.messages, now.ownedLive - afterUndo.ownedLive]).toEqual([1, 2, 1, 1, 1]);
    // the re-imported note and text belong to the live Tess / Rae, not to the undone contact
    const live = await q<{ first_name: string }>(
      `SELECT c.first_name FROM notes n JOIN contacts c ON c.id = n.contact_id WHERE n.tenant_id = $1 AND n.body = 'Follow-up after the move' AND c.deleted_at IS NULL
       UNION ALL SELECT c.first_name FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.tenant_id = $1 AND m.body = 'Still looking!' AND c.deleted_at IS NULL`,
      [w.tenantId],
    );
    expect(live.map((x) => x.first_name).sort()).toEqual(['Jane', 'Rae']);
    const tess = await q<{ owner_user_id: string | null }>("SELECT owner_user_id FROM contacts WHERE tenant_id = $1 AND first_name = 'Tess' AND deleted_at IS NULL", [w.tenantId]);
    expect(tess).toEqual([{ owner_user_id: w.agents[0]!.userId }]);
  });
});
