// api/people end to end (PARITY_PLAN module 57) through the real server as app_user. The superuser pool
// only reads state back and makes fixtures that have no application path in this module.
import { randomUUID } from 'node:crypto';
import { type Role, toIso } from '@realty/core/foundation';
import { STAGES, lockedStages, mentionToken, stageChangeAllowed } from '@realty/core/parity/people';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, call, command, contactState, intake, leadsWorld, randomPhone } from '../leads/testing.js';

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };
let agent: TestClient;
let agent2: TestClient;
let tl: TestClient;
let admin: TestClient;
let isa: TestClient;
let tc: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'] });
  const s = (await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings')).body.settings;
  await call(w.owner, 'PATCH', '/settings', { version: s.version, autoPauseAfterMisses: 10, uncontactedCapacityCap: 50 });
  [agent, agent2] = w.agents as [TestClient, TestClient];
  tl = w.teamLead!;
  [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function own(c: TestClient, o: Record<string, unknown> = {}): Promise<string> {
  const r = await call<{ contact: { id: string } }>(c, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Jane', lastName: 'Doe', phones: [randomPhone()], ...o });
  if (r.status !== 201) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}

/** A routed lead the offeree accepted: owned, first-touch SLA running, untouched. */
async function routedUntouched(): Promise<{ id: string; owner: TestClient }> {
  const r = await intake(h, w);
  const st = await contactState(h, r.contactId);
  if (st.ownership_state !== 'offered') throw new Error(`not offered: ${st.ownership_state}`);
  const owner = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
  const acc = await command(owner, r.contactId, 'accept', { offerId: st.offer_id, expectedSeq: Number(st.ownership_seq) });
  if (acc.status !== 200) throw new Error(`accept ${acc.status} ${JSON.stringify(acc.body)}`);
  return { id: r.contactId, owner };
}

async function details(c: TestClient, id: string) {
  return call<{ details: { rowVersion: number; stage: { stage: string; locked: string[]; lockedReason: string | null; label: string }; addresses: { id: string; city: string | null }[]; collaborators: { userId: string; role: string }[]; relationships: { id: string; other: { id: string } }[]; removedPoints: { id: string; tail: string; reason: string | null; stillBlocks: boolean }[]; canEdit: boolean; doNotContact: boolean } }>(c, 'GET', `/contacts/${id}/details`);
}

describe('PATCH /contacts/:id (R-PAR-43)', () => {
  it('R-PAR-43 edits names (display name follows), type, intent and timezone with row_version, audited by field name only', async () => {
    const id = await own(agent);
    const rv = (await details(agent, id)).body.details.rowVersion;
    const r = await call<{ contact: { displayName: string; rowVersion: number; timezone: string }; changed: string[] }>(agent, 'PATCH', `/contacts/${id}`, { rowVersion: rv, firstName: 'Janet', intent: 'seller', contactType: 'sphere', timezone: 'America/Denver' });
    expect(r.status).toBe(200);
    expect(r.body.contact).toMatchObject({ displayName: 'Janet Doe', rowVersion: rv + 1, timezone: 'America/Denver' });
    expect(r.body.changed.sort()).toEqual(['contactType', 'firstName', 'intent', 'timezone']);
    const a = (await h.su.query<{ changes: Record<string, unknown> }>("SELECT changes FROM audit_log WHERE action = 'contact.update' AND entity_id = $1", [id])).rows;
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.changes)).not.toContain('Janet');
    expect((await contactState(h, id) as unknown as { timezone_source: string }).timezone_source).toBe('explicit');
  });

  it('R-PAR-43 refuses ownership, attribution and do-not-contact keys, and a stale row version', async () => {
    const id = await own(agent);
    const rv = (await details(agent, id)).body.details.rowVersion;
    for (const k of ['ownerUserId', 'originalLeadSourceId', 'doNotContactAt', 'importedFields', 'mergedIntoContactId']) {
      const r = await call(agent, 'PATCH', `/contacts/${id}`, { rowVersion: rv, [k]: null });
      expect(r.status, k).toBe(422);
      expect(r.code, k).toBe('FIELD_NOT_EDITABLE');
    }
    expect((await call(agent, 'PATCH', `/contacts/${id}`, { rowVersion: rv, tenant_id: w.tenantId, firstName: 'X' })).status).toBe(422);
    expect((await call(agent, 'PATCH', `/contacts/${id}`, { rowVersion: rv + 5, firstName: 'X' })).code).toBe('STALE_CONTACT');
  });

  it('R-PAR-43 concurrency: two tabs PATCH with the same row_version: exactly one wins, the other is STALE_CONTACT', async () => {
    const id = await own(agent);
    const rv = (await details(agent, id)).body.details.rowVersion;
    const [a, b] = await Promise.all([call(agent, 'PATCH', `/contacts/${id}`, { rowVersion: rv, firstName: 'Tab A' }), call(agent, 'PATCH', `/contacts/${id}`, { rowVersion: rv, firstName: 'Tab B' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.code, b.code]).toContain('STALE_CONTACT');
  });

  it('R-PAR-43 the pond summary is the owner’s or a Team Lead’s', async () => {
    const id = await own(agent);
    const rv = (await details(agent, id)).body.details.rowVersion;
    expect((await call(agent, 'PATCH', `/contacts/${id}`, { rowVersion: rv, pondSummary: 'Condo buyer, downtown' })).status).toBe(200);
    expect((await call(tl, 'PATCH', `/contacts/${id}`, { rowVersion: rv + 1, pondSummary: 'Condo buyer' })).status).toBe(200);
  });
});

describe('POST /contacts (create extensions, R-PAR-44)', () => {
  it('R-PAR-44 create may set stage, source (at birth), labels and an address in the same transaction', async () => {
    const id = await own(agent, { stage: 'nurture', leadSourceId: w.sourceId, emailLabel: 'work', emails: [`jane-${randomUUID().slice(0, 6)}@example.test`], address: { kind: 'home', line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701' } });
    const d = (await details(agent, id)).body.details;
    expect(d.stage.stage).toBe('nurture');
    expect(d.addresses).toEqual([expect.objectContaining({ city: 'Austin' })]);
    const row = (await h.su.query('SELECT original_lead_source_id FROM contacts WHERE id = $1', [id])).rows[0];
    expect(row.original_lead_source_id).toBe(w.sourceId);
    expect((await h.su.query("SELECT label FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [id])).rows[0].label).toBe('work');
  });
  it('R-PAR-44 an exact match on create is still DUPLICATE_CONTACT (dedup as intake)', async () => {
    const phone = randomPhone();
    await own(agent, { phones: [phone] });
    const r = await call(agent2, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Other', phones: [phone] });
    expect(r.code).toBe('DUPLICATE_CONTACT');
  });
});

describe('stages (R-PAR-13, R-PAR-14, R-PAR-15)', () => {
  it('R-PAR-14 E171 an agent cannot park an untouched routed lead; the stages are locked up front; a TL may move it', async () => {
    const { id, owner } = await routedUntouched();
    const d = (await details(owner, id)).body.details;
    expect(d.stage.locked).toEqual(['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost']);
    expect(d.stage.lockedReason).toBe('STAGE_NEEDS_CONTACT');
    const r = await call(owner, 'POST', `/contacts/${id}/stage`, { stage: 'lost' });
    expect(r.status).toBe(409);
    expect(r.code).toBe('STAGE_NEEDS_CONTACT');
    expect((await call(owner, 'POST', `/contacts/${id}/stage`, { stage: 'attempting' })).status).toBe(200);
    expect((await call(tl, 'POST', `/contacts/${id}/stage`, { stage: 'nurture' })).status).toBe(200);
  });

  it('R-PAR-14 the core decision agrees with the DB guard for every role and stage (core bypassed, written straight through RLS)', async () => {
    const roles: Record<Role, TestClient> = { owner: w.owner, admin, team_lead: tl, agent, isa, tc };
    for (const role of ['agent', 'team_lead', 'admin', 'owner'] as Role[]) {
      for (const to of STAGES.filter((s) => s !== 'new')) {
        const { id, owner } = await routedUntouched();
        const c = role === 'agent' ? owner : roles[role];
        const core = stageChangeAllowed({ stage: 'new', ownershipState: 'owned', firstTouchDueAt: 1 as never, firstTouchAt: null }, { kind: 'user', role }, to).ok;
        let db = true;
        try {
          await withTenantTx(c.actor(), (tx) => sql`UPDATE contacts SET stage = ${to} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx), { db: h.database });
        } catch (e) {
          if (!String((e as Error).message).startsWith('STAGE_NEEDS_CONTACT')) throw e;
          db = false;
        }
        expect(db, `${role} → ${to}`).toBe(core);
      }
    }
  }, 240_000);

  it('R-PAR-15 every change appends one history row attributed to the actor, shown in the timeline; Undo is the previous stage', async () => {
    const id = await own(agent);
    const r = await call<{ previousStage: string; stage: { stage: string } }>(agent, 'POST', `/contacts/${id}/stage`, { stage: 'active' });
    expect(r.body).toMatchObject({ previousStage: 'new', stage: { stage: 'active' } });
    await call(agent, 'POST', `/contacts/${id}/stage`, { stage: r.body.previousStage });
    const ev = (await h.su.query('SELECT from_stage, to_stage, actor_kind, actor_user_id FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at', [id])).rows;
    expect(ev).toEqual([
      { from_stage: 'new', to_stage: 'active', actor_kind: 'user', actor_user_id: agent.userId },
      { from_stage: 'active', to_stage: 'new', actor_kind: 'user', actor_user_id: agent.userId },
    ]);
    const t = await call<{ items: { type: string; detail: string }[] }>(agent, 'GET', `/contacts/${id}/timeline`);
    expect(t.body.items.filter((i) => i.type === 'stage').map((i) => i.detail)).toEqual(['active>new', 'new>active']);
  });

  it('R-PAR-13 Owner/Admin set labels (1-24 characters); everyone reads them; an agent cannot set them', async () => {
    const r = await call<{ stages: { key: string; label: string }[] }>(w.owner, 'PUT', '/stage-labels', { labels: { nurture: 'Long term' } });
    expect(r.status).toBe(200);
    expect(r.body.stages.find((s) => s.key === 'nurture')!.label).toBe('Long term');
    expect((await call(agent, 'GET', '/stage-labels')).body).toMatchObject({ labels: { nurture: 'Long term' } });
    expect((await call(agent, 'PUT', '/stage-labels', { labels: { nurture: 'X' } })).status).toBe(404);
    expect((await call(admin, 'PUT', '/stage-labels', { labels: { parked: 'X' } })).code).toBe('STAGE_LABEL_INVALID');
    await call(w.owner, 'PUT', '/stage-labels', { labels: {} });
  });
});

describe('points (R-PAR-11, R-PAR-12, R-PAR-44)', () => {
  it('R-PAR-11 E170 replace = remove (replaced) + add; the old row and its HMAC stay; the new one is primary', async () => {
    const old = randomPhone();
    const id = await own(agent, { phones: [old] });
    const pts = await call<{ points: { id: string; address: string; isPrimary: boolean }[] }>(agent, 'GET', `/contacts/${id}/points`);
    const p0 = pts.body.points[0]!;
    const fresh = randomPhone();
    const r = await call<{ point: { address: string; isPrimary: boolean }; removedPointId: string }>(agent, 'POST', `/contacts/${id}/points/${p0.id}/replace`, { address: fresh });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ point: { address: fresh, isPrimary: true }, removedPointId: p0.id });
    const rows = (await h.su.query("SELECT address, removed_reason, status FROM contact_points WHERE contact_id = $1 ORDER BY created_at", [id])).rows;
    expect(rows).toEqual([{ address: old, removed_reason: 'replaced', status: 'removed' }, { address: fresh, removed_reason: null, status: 'active' }]);
    const d = (await details(agent, id)).body.details;
    expect(d.removedPoints).toEqual([expect.objectContaining({ id: p0.id, tail: `•••${old.slice(-4)}`, reason: 'replaced', stillBlocks: true })]);
    // an address is never updated in place, whatever the client tries
    await expect(withTenantTx(agent.actor(), (tx) => sql`UPDATE contact_points SET address = ${randomPhone()} WHERE id = ${p0.id}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/CONTACT_POINT_IMMUTABLE/);
  });

  it('R-PAR-12 E169 removing as a wrong number needs the ledger record; old/replaced removals keep blocking', async () => {
    const id = await own(agent);
    const p0 = (await call<{ points: { id: string }[] }>(agent, 'GET', `/contacts/${id}/points`)).body.points[0]!;
    const r = await call(agent, 'POST', `/contacts/${id}/points/${p0.id}/remove`, { reason: 'wrong_number' });
    expect(r.code).toBe('WRONG_NUMBER_NOT_RECORDED');
    const ok = await call<{ points: unknown[]; removed: { reason: string; stillBlocks: boolean }[] }>(agent, 'POST', `/contacts/${id}/points/${p0.id}/remove`, { reason: 'old' });
    expect(ok.status).toBe(200);
    expect(ok.body.removed).toEqual([expect.objectContaining({ reason: 'old', stillBlocks: true })]);
  });

  it('R-PAR-44 adding a number another contact has is a warning plus a duplicate candidate, never a refusal; an invisible match shows only its owner name', async () => {
    const shared = randomPhone();
    const mine = await own(agent);
    const theirs = await own(agent2, { phones: [shared] });
    const r = await call<{ duplicates: { contactId: string | null; ownerDisplayName: string | null }[] }>(agent, 'POST', `/contacts/${mine}/points`, { kind: 'phone', address: shared, label: 'work' });
    expect(r.status).toBe(201);
    expect(r.body.duplicates).toEqual([{ contactId: null, ownerDisplayName: expect.any(String) }]);
    const cand = (await h.su.query('SELECT match_reason FROM contact_duplicate_candidates WHERE (contact_a_id = $1 AND contact_b_id = $2) OR (contact_a_id = $2 AND contact_b_id = $1)', [mine, theirs])).rows;
    expect(cand).toEqual([{ match_reason: 'shared_phone' }]);
    expect((await call(agent, 'POST', `/contacts/${mine}/points`, { kind: 'phone', address: shared })).code).toBe('POINT_EXISTS');
  });

  it('R-PAR-44 concurrency: two people add the same new number to two contacts at once: the address lock serializes them, exactly one sees the other', async () => {
    const shared = randomPhone();
    const a = await own(agent);
    const b = await own(agent);
    const [x, y] = await Promise.all([
      call<{ duplicates: unknown[] }>(agent, 'POST', `/contacts/${a}/points`, { kind: 'phone', address: shared }),
      call<{ duplicates: unknown[] }>(agent, 'POST', `/contacts/${b}/points`, { kind: 'phone', address: shared }),
    ]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect([x.body.duplicates.length, y.body.duplicates.length].sort()).toEqual([0, 1]);
  });

  it('primary and label changes; removing the primary promotes the next live number', async () => {
    const id = await own(agent, { phones: [randomPhone(), randomPhone()] });
    const pts = (await call<{ points: { id: string; isPrimary: boolean }[] }>(agent, 'GET', `/contacts/${id}/points`)).body.points;
    const second = pts.find((p) => !p.isPrimary)!;
    const lab = await call<{ points: { id: string; label: string }[] }>(agent, 'PATCH', `/contacts/${id}/points/${second.id}`, { label: 'home' });
    expect(lab.body.points.find((p) => p.id === second.id)!.label).toBe('home');
    const pr = await call<{ points: { id: string; isPrimary: boolean }[] }>(agent, 'POST', `/contacts/${id}/points/${second.id}/primary`);
    expect(pr.body.points.find((p) => p.isPrimary)!.id).toBe(second.id);
    const rm = await call<{ points: { id: string; isPrimary: boolean }[] }>(agent, 'POST', `/contacts/${id}/points/${second.id}/remove`, { reason: 'old' });
    expect(rm.body.points).toEqual([expect.objectContaining({ isPrimary: true })]);
  });
});

describe('notes and mentions (R-PAR-1 … R-PAR-4)', () => {
  it('R-PAR-2 R-PAR-3 a mention notifies only members whose own RLS shows the person; the notification has no note text', async () => {
    const id = await own(agent, { firstName: 'Priya', lastName: 'Shah' });
    const body = `Call back Tuesday ${mentionToken(tl.userId!, 'Tess')} ${mentionToken(agent2.userId!, 'Avi')} secret-word`;
    const r = await call<{ note: { id: string; mentions: { userId: string }[] }; mentions: { userId: string; status: string }[] }>(agent, 'POST', `/contacts/${id}/notes`, { body });
    expect(r.status).toBe(201);
    const by = Object.fromEntries(r.body.mentions.map((m) => [m.userId, m.status]));
    expect(by).toEqual({ [tl.userId!]: 'notified', [agent2.userId!]: 'no_access' });
    const n = (await h.su.query("SELECT user_id, kind, title, body, dedupe_key, subject_id FROM notifications WHERE kind = 'mention' AND subject_id = $1", [id])).rows;
    expect(n).toEqual([{ user_id: tl.userId, kind: 'mention', title: 'You were mentioned in a note on Priya S.', body: null, dedupe_key: `mention:${r.body.note.id}`, subject_id: id }]);
    expect(JSON.stringify(n)).not.toContain('secret-word');
    // a mention never grants access
    expect((await call(agent2, 'GET', `/contacts/${id}/notes`)).status).toBe(404);
  });

  it('R-PAR-3 E164 an edit that adds a second mention notifies only the new person', async () => {
    const id = await own(agent);
    const n = await call<{ note: { id: string } }>(agent, 'POST', `/contacts/${id}/notes`, { body: `ping ${mentionToken(tl.userId!, 'T')}` });
    const e = await call<{ mentions: { userId: string; status: string }[] }>(agent, 'PATCH', `/notes/${n.body.note.id}`, { body: `ping ${mentionToken(tl.userId!, 'T')} and ${mentionToken(w.owner.userId!, 'O')}` });
    expect(e.status).toBe(200);
    expect(Object.fromEntries(e.body.mentions.map((m) => [m.userId, m.status]))).toEqual({ [tl.userId!]: 'already_notified', [w.owner.userId!]: 'notified' });
    const count = (await h.su.query("SELECT user_id FROM notifications WHERE kind = 'mention' AND subject_id = $1 ORDER BY user_id", [id])).rows.map((x) => x.user_id);
    expect(count.sort()).toEqual([tl.userId, w.owner.userId].sort());
  });

  it('R-PAR-2 E162 an ISA whose collaborator window expired is not told; Share (collaborator add, audited) then lets them see', async () => {
    const id = await own(agent);
    expect((await call(agent, 'POST', `/contacts/${id}/collaborators`, { userId: isa.userId })).status).toBe(200);
    await h.su.query("UPDATE contact_collaborators SET expires_at = now() - interval '1 minute' WHERE contact_id = $1 AND user_id = $2", [id, isa.userId]);
    const r = await call<{ mentions: { status: string }[] }>(agent, 'POST', `/contacts/${id}/notes`, { body: `fyi ${mentionToken(isa.userId!, 'Ivy')}` });
    expect(r.body.mentions).toEqual([expect.objectContaining({ status: 'no_access' })]);
    const cand = await call<{ members: { userId: string; canSee: boolean }[] }>(agent, 'GET', `/contacts/${id}/mention-candidates`);
    expect(cand.body.members.find((m) => m.userId === isa.userId)!.canSee).toBe(false);
    expect(cand.body.members.find((m) => m.userId === tl.userId)!.canSee).toBe(true);
    expect((await call(agent, 'POST', `/contacts/${id}/collaborators`, { userId: isa.userId })).status).toBe(200);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'collaborator.added' AND entity_id = $1", [id])).rows[0].n).toBe(2);
    const r2 = await call<{ mentions: { status: string }[] }>(agent, 'POST', `/contacts/${id}/notes`, { body: `now ${mentionToken(isa.userId!, 'Ivy')}` });
    expect(r2.body.mentions).toEqual([expect.objectContaining({ status: 'notified' })]);
  });

  it('R-PAR-2 E163 a notified TL who loses the lead opens a 404; the notification carried no text', async () => {
    const id = await own(agent);
    await call(agent, 'POST', `/contacts/${id}/notes`, { body: `look ${mentionToken(tl.userId!, 'T')}` });
    expect((await call(tl, 'GET', `/contacts/${id}`)).status).toBe(200);
    // the lead leaves the TL's sight: reassigned to someone outside the TL's team
    await h.su.query('DELETE FROM team_members WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, agent.userId]);
    expect((await call(tl, 'GET', `/contacts/${id}`)).status).toBe(404);
    const n = (await h.su.query("SELECT body FROM notifications WHERE kind = 'mention' AND subject_id = $1 AND user_id = $2", [id, tl.userId])).rows;
    expect(n).toEqual([{ body: null }]);
    await h.su.query('INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES ($1, $2, $3, false)', [w.tenantId, w.teamId, agent.userId]);
  });

  it('R-PAR-3 at most 10 people per note; self-mentions are ignored', async () => {
    const id = await own(agent);
    const self = await call<{ mentions: unknown[] }>(agent, 'POST', `/contacts/${id}/notes`, { body: `me ${mentionToken(agent.userId!, 'me')}` });
    expect(self.body.mentions).toEqual([]);
    const ids = Array.from({ length: 11 }, () => randomUUID());
    // unknown ids are dropped (not members), so this is fine; the limit counts members only
    expect((await call(agent, 'POST', `/contacts/${id}/notes`, { body: ids.map((x) => mentionToken(x, 'x')).join(' ') })).status).toBe(201);
  });

  it('R-PAR-1 a note is readable by exactly whoever sees the person: the TL (team) yes, another agent no', async () => {
    const id = await own(agent);
    await call(agent, 'POST', `/contacts/${id}/notes`, { body: 'visible to the team' });
    const t = await call<{ notes: { body: string }[]; audience: string }>(tl, 'GET', `/contacts/${id}/notes`);
    expect(t.body.notes.map((n) => n.body)).toEqual(['visible to the team']);
    expect(t.body.audience).toBe('everyone_who_sees_this_person');
    expect((await call(agent2, 'GET', `/contacts/${id}/notes`)).status).toBe(404);
  });

  it('R-PAR-4 only the author edits; author or Owner/Admin pin; Owner deletes any note (audited); author deletes own', async () => {
    const id = await own(agent);
    const n = (await call<{ note: { id: string } }>(agent, 'POST', `/contacts/${id}/notes`, { body: 'first' })).body.note.id;
    expect((await call(tl, 'PATCH', `/notes/${n}`, { body: 'rewritten' })).code).toBe('NOTE_AUTHOR_ONLY');
    const e = await call<{ note: { body: string; editedAt: string | null } }>(agent, 'PATCH', `/notes/${n}`, { body: 'fixed typo' });
    expect(e.body.note).toMatchObject({ body: 'fixed typo', editedAt: expect.any(String) });
    expect((await call(tl, 'POST', `/notes/${n}/pin`, { pinned: true })).code).toBe('NOTE_AUTHOR_ONLY');
    expect((await call<{ note: { pinned: boolean } }>(admin, 'POST', `/notes/${n}/pin`, { pinned: true })).body.note.pinned).toBe(true);
    const list = await call<{ notes: { id: string; pinned: boolean }[] }>(agent, 'GET', `/contacts/${id}/notes`);
    expect(list.body.notes[0]).toMatchObject({ id: n, pinned: true });
    expect((await call(tl, 'DELETE', `/notes/${n}`)).status).toBe(404);
    expect((await call(w.owner, 'DELETE', `/notes/${n}`)).status).toBe(200);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'note.delete' AND entity_id = $1", [n])).rows[0].n).toBe(1);
    const own2 = (await call<{ note: { id: string } }>(agent, 'POST', `/contacts/${id}/notes`, { body: 'mine' })).body.note.id;
    expect((await call(agent, 'DELETE', `/notes/${own2}`)).status).toBe(200);
  });

  it('R-PAR-4 imported notes are never edited or deleted by their author', async () => {
    const id = await own(agent);
    const nid = randomUUID();
    await h.su.query("INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source, imported) VALUES ($1, $2, $3, NULL, 'from FUB', 'import', true)", [w.tenantId, nid, id]);
    expect((await call(agent, 'PATCH', `/notes/${nid}`, { body: 'x' })).code).toBe('NOTE_READ_ONLY');
    expect((await call(agent, 'DELETE', `/notes/${nid}`)).status).toBe(404);
  });

  it('idempotent retry: the same client note id returns the note, never a second one', async () => {
    const id = await own(agent);
    const noteId = randomUUID();
    const a = await call(agent, 'POST', `/contacts/${id}/notes`, { body: 'once', noteId });
    const b = await call<{ replayed: boolean }>(agent, 'POST', `/contacts/${id}/notes`, { body: 'once', noteId });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.replayed).toBe(true);
    expect((await h.su.query('SELECT count(*)::int AS n FROM notes WHERE contact_id = $1', [id])).rows[0].n).toBe(1);
  });
});

describe('logged activity (R-PAR-5, R-PAR-30, R-PAR-31, R-PAR-32)', () => {
  it('R-PAR-30 logs a call with outcome and a "remind me" task; shown at the time it happened, not verified', async () => {
    const id = await own(agent);
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    const r = await call<{ note: { source: string; loggedActivity: { kind: string; at: string; outcome: string; verified: boolean } }; taskId: string }>(agent, 'POST', `/contacts/${id}/activities`, { kind: 'call', outcome: 'left_voicemail', at, remindInDays: 2 });
    expect(r.status).toBe(201);
    expect(r.body.note).toMatchObject({ source: 'logged_activity', loggedActivity: { kind: 'call', outcome: 'left_voicemail', verified: false } });
    expect(Date.parse(r.body.note.loggedActivity.at)).toBe(Date.parse(at));
    const task = (await h.su.query('SELECT assignee_user_id, kind, contact_id, due_at FROM tasks WHERE id = $1', [r.body.taskId])).rows[0];
    expect(task).toMatchObject({ assignee_user_id: agent.userId, kind: 'follow_up', contact_id: id });
    const t = await call<{ items: { type: string; detail: string; occurredAt: string }[] }>(agent, 'GET', `/contacts/${id}/timeline`);
    const item = t.body.items.find((i) => i.type === 'note')!;
    expect(item.detail).toBe('logged_activity:call');
    expect(Date.parse(item.occurredAt)).toBe(Date.parse(at));
    expect((await h.su.query('SELECT count(*)::int AS n FROM calls WHERE contact_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('R-PAR-5 R-PAR-32 a logged call is never a touch: no first touch, no last-touch time, no activity count, the stage stays locked (Q-PAR-2)', async () => {
    const { id, owner } = await routedUntouched();
    const before = (await h.su.query('SELECT coalesce(sum(touches), 0)::int AS t FROM v_agent_activity_daily WHERE user_id = $1', [owner.userId])).rows[0].t;
    expect((await call(owner, 'POST', `/contacts/${id}/activities`, { kind: 'call', outcome: 'connected', at: new Date().toISOString() })).status).toBe(201);
    expect((await call(owner, 'POST', `/contacts/${id}/notes`, { body: 'talked to them' })).status).toBe(201);
    const c = (await h.su.query('SELECT first_touch_at, last_human_touch_at, release_due_at FROM contacts WHERE id = $1', [id])).rows[0];
    expect(c.first_touch_at).toBeNull();
    expect(c.last_human_touch_at).toBeNull();
    expect(c.release_due_at).not.toBeNull();
    const after = (await h.su.query('SELECT coalesce(sum(touches), 0)::int AS t FROM v_agent_activity_daily WHERE user_id = $1', [owner.userId])).rows[0].t;
    expect(after).toBe(before);
    expect((await call(owner, 'POST', `/contacts/${id}/stage`, { stage: 'connected' })).code).toBe('STAGE_NEEDS_CONTACT');
    expect(lockedStages({ stage: 'new', ownershipState: 'owned', firstTouchDueAt: 1 as never, firstTouchAt: null }, { kind: 'user', role: 'agent' })).toContain('connected');
  });

  it('R-PAR-31 E192 a logged call dated tomorrow is refused; a year and a day back too; only the author corrects the time', async () => {
    const id = await own(agent);
    expect((await call(agent, 'POST', `/contacts/${id}/activities`, { kind: 'call', at: new Date(Date.now() + 86_400_000).toISOString() })).code).toBe('ACTIVITY_IN_FUTURE');
    expect((await call(agent, 'POST', `/contacts/${id}/activities`, { kind: 'text', at: new Date(Date.now() - 367 * 86_400_000).toISOString() })).code).toBe('ACTIVITY_TOO_OLD');
    expect((await call(agent, 'POST', `/contacts/${id}/activities`, { kind: 'email', outcome: 'connected', at: new Date().toISOString() })).code).toBe('OUTCOME_CALLS_ONLY');
    const n = await call<{ note: { id: string } }>(agent, 'POST', `/contacts/${id}/activities`, { kind: 'call', at: new Date().toISOString() });
    const earlier = new Date(Date.now() - 3600_000).toISOString();
    const fix = await call<{ note: { loggedActivity: { at: string; outcome: string } } }>(agent, 'PATCH', `/notes/${n.body.note.id}`, { activityAt: earlier, activityOutcome: 'no_answer' });
    expect(fix.status).toBe(200);
    expect(fix.body.note.loggedActivity.outcome).toBe('no_answer');
    expect((await call(agent, 'PATCH', `/notes/${n.body.note.id}`, { activityAt: new Date(Date.now() + 86_400_000).toISOString() })).code).toBe('ACTIVITY_IN_FUTURE');
    expect((await call(tl, 'PATCH', `/notes/${n.body.note.id}`, { activityOutcome: 'connected' })).code).toBe('NOTE_AUTHOR_ONLY');
  });

  it('R-PAR-32 E193 "they said stop" in free text blocks nothing and prompts; the one-tap do-not-contact then blocks every channel', async () => {
    const id = await own(agent, { emails: [`p-${randomUUID().slice(0, 6)}@example.test`] });
    const r = await call<{ suggestDoNotContact: boolean }>(agent, 'POST', `/contacts/${id}/activities`, { kind: 'call', outcome: 'connected', at: new Date().toISOString(), body: 'She said stop calling her' });
    expect(r.body.suggestDoNotContact).toBe(true);
    expect((await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [id])).rows[0].do_not_contact_at).toBeNull();
    const d = await call<{ doNotContact: boolean; alreadySet: boolean; revokedPoints: number }>(agent, 'POST', `/contacts/${id}/do-not-contact`, { reason: 'asked_on_call' });
    expect(d.body).toEqual({ doNotContact: true, alreadySet: false, revokedPoints: 2 });
    const c = (await h.su.query('SELECT do_not_contact_at, do_not_contact_event_id FROM contacts WHERE id = $1', [id])).rows[0];
    expect(c.do_not_contact_at).not.toBeNull();
    const ev = (await h.su.query("SELECT channel FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke' AND source = 'agent_revoke' ORDER BY channel", [id])).rows.map((x) => x.channel);
    expect(ev).toEqual(['email', 'sms', 'voice']);
    const reach = await call<{ channels: { channel: string; reachable: boolean }[] } & Record<string, unknown>>(agent, 'GET', `/contacts/${id}/reachability`);
    expect(JSON.stringify(reach.body)).toMatch(/CONSENT_REVOKED/);
    expect(JSON.stringify(reach.body)).toMatch(/agent_recorded/);
    // a second tap changes nothing and nothing here can lift it
    expect((await call<{ alreadySet: boolean }>(agent, 'POST', `/contacts/${id}/do-not-contact`, {})).body.alreadySet).toBe(true);
    expect((await call(agent, 'PATCH', `/contacts/${id}`, { rowVersion: 99, doNotContactAt: null })).code).toBe('FIELD_NOT_EDITABLE');
  });
});

describe('relationships (R-PAR-21, R-PAR-22)', () => {
  it('R-PAR-21 a relationship exists for a viewer only when they see both people; nobody links a person they cannot see', async () => {
    const a = await own(agent, { firstName: 'Alice' });
    const b = await own(agent, { firstName: 'Bob' });
    const r = await call<{ relationship: { id: string; other: { id: string } } }>(agent, 'POST', `/contacts/${a}/relationships`, { relatedContactId: b, kind: 'spouse_partner' });
    expect(r.status).toBe(201);
    expect((await call<{ relationships: unknown[] }>(agent, 'GET', `/contacts/${b}/relationships`)).body.relationships).toHaveLength(1);
    expect((await call(agent, 'POST', `/contacts/${a}/relationships`, { relatedContactId: b, kind: 'spouse_partner' })).code).toBe('RELATIONSHIP_EXISTS');
    const theirs = await own(agent2);
    expect((await call(agent, 'POST', `/contacts/${a}/relationships`, { relatedContactId: theirs, kind: 'family' })).status).toBe(404);
    expect((await call(agent, 'POST', `/contacts/${a}/relationships`, { relatedContactId: a, kind: 'family' })).status).toBe(422);
    expect((await call(agent, 'POST', `/contacts/${a}/relationships`, { relatedContactId: b, kind: 'other' })).status).toBe(422);
    expect((await call(agent, 'DELETE', `/contacts/${a}/relationships/${r.body.relationship.id}`)).status).toBe(200);
  });

  it('R-PAR-21 R-PAR-22 E177 the Owner links Alice (agent A) to her husband (agent B): A sees no row and no count, and still cannot open him', async () => {
    const alice = await own(agent, { firstName: 'Alice' });
    const husband = await own(agent2, { firstName: 'Hal' });
    expect((await call(w.owner, 'POST', `/contacts/${alice}/relationships`, { relatedContactId: husband, kind: 'spouse_partner' })).status).toBe(201);
    expect((await call<{ relationships: unknown[] }>(agent, 'GET', `/contacts/${alice}/relationships`)).body).toEqual({ relationships: [] });
    expect((await details(agent, alice)).body.details.relationships).toEqual([]);
    expect((await call(agent, 'GET', `/contacts/${husband}`)).status).toBe(404);
    expect((await call<{ relationships: unknown[] }>(w.owner, 'GET', `/contacts/${alice}/relationships`)).body.relationships).toHaveLength(1);
  });

  it('R-PAR-21 E178 erasing one spouse cascades their relationship rows; the other spouse is untouched', async () => {
    const a = await own(agent);
    const b = await own(agent);
    await call(agent, 'POST', `/contacts/${a}/relationships`, { relatedContactId: b, kind: 'household' });
    await call(agent, 'POST', `/contacts/${a}/stage`, { stage: 'active' });
    await h.su.query('DELETE FROM contacts WHERE id = $1', [b]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM contact_relationships WHERE contact_id = $1 OR related_contact_id = $1', [a])).rows[0].n).toBe(0);
    expect((await h.su.query('SELECT count(*)::int AS n FROM contact_stage_events WHERE contact_id = $1', [a])).rows[0].n).toBe(1);
  });
});

describe('addresses and collaborators', () => {
  it('addresses: add and edit (audited as contact.update); only people who see the detail', async () => {
    const id = await own(agent);
    const a = await call<{ address: { id: string } }>(agent, 'POST', `/contacts/${id}/addresses`, { kind: 'property', line1: '9 Elm', city: 'Reno', region: 'NV', postalCode: '89501' });
    expect(a.status).toBe(201);
    const e = await call<{ address: { city: string } }>(agent, 'PATCH', `/contacts/${id}/addresses/${a.body.address.id}`, { kind: 'property', line1: '9 Elm', city: 'Sparks', region: 'NV', postalCode: '89431' });
    expect(e.body.address.city).toBe('Sparks');
    expect((await call(agent2, 'POST', `/contacts/${id}/addresses`, { kind: 'home', city: 'X' })).status).toBe(404);
  });

  it('collaborators: the contact owner adds an ISA (who then sees detail) and removes them; an ISA cannot manage; the owner is never a collaborator', async () => {
    const id = await own(agent);
    expect((await call(isa, 'GET', `/contacts/${id}/details`)).status).toBe(404);
    const add = await call<{ collaborators: { userId: string; role: string }[] }>(agent, 'POST', `/contacts/${id}/collaborators`, { userId: isa.userId });
    expect(add.body.collaborators).toEqual([expect.objectContaining({ userId: isa.userId, role: 'isa' })]);
    expect((await call(isa, 'GET', `/contacts/${id}/details`)).status).toBe(200);
    expect((await call(isa, 'POST', `/contacts/${id}/collaborators`, { userId: tc.userId })).status).toBe(404);
    expect((await call(agent, 'POST', `/contacts/${id}/collaborators`, { userId: agent.userId })).code).toBe('COLLABORATOR_NOT_ELIGIBLE');
    expect((await call(agent, 'DELETE', `/contacts/${id}/collaborators/${isa.userId}`)).status).toBe(200);
    expect((await call(isa, 'GET', `/contacts/${id}/details`)).status).toBe(404);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('collaborator.added','collaborator.removed') AND entity_id = $1", [id])).rows[0].n).toBe(2);
  });
});

describe('details', () => {
  it('shows the edit facts, removed points (tail only), and toIso round-trips', async () => {
    const id = await own(agent);
    const d = (await details(agent, id)).body.details;
    expect(d).toMatchObject({ canEdit: true, doNotContact: false, stage: { stage: 'new', locked: [], label: 'New' } });
    expect(toIso(0 as never)).toBe('1970-01-01T00:00:00.000Z');
    expect((await details(tc, id)).status).toBe(404);
  });
});
