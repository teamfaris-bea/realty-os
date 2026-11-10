// api/leads adversarial verification (BUILD_PLAN module 11): defects found by trying to break the
// module through its real API against real Postgres, each pinned by a test.
//   1 R-PERM-6 / R-OWN-7: a create-contact "replay" with the command id of a different command (or of
//     a create whose contact the caller now sees only as a pond card) must not serialize the full record
//   2 R-OWN-7: an ownership command id reused on a different contact is refused, never a fake success
//   3 R-OWN-25 / E19: name-only inquiries for different people must not collide on the fingerprint
//   4 R-OWN-20: an inquiry matching a merged-away contact is redirected to the survivor (depth ≤ 5)
//   5 R-PERM-2: two Owners deactivating each other at the same moment never leave the tenant without one
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, call, command, contactState, freshReauth, intake, ledger, leadsWorld, randomPhone } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function create(c: TestClient, body: Record<string, unknown>, commandId = randomUUID()): Promise<string> {
  const r = await call<{ contact: { id: string } }>(c, 'POST', '/contacts', { commandId, ...body });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}

describe('command ids (R-OWN-7) never widen what the caller sees (R-PERM-6)', () => {
  it('R-OWN-7 R-PERM-6: POST /contacts with the command id of the caller\'s own release is refused, and a replayed create of a contact now only in the pond returns the masked card', async () => {
    const a = w.agents[0]!;
    const createId = randomUUID();
    const id = await create(a, { firstName: 'Jordan', lastName: 'Privately', phones: [randomPhone()] }, createId);
    const releaseId = randomUUID();
    const rel = await command(a, id, 'release', { commandId: releaseId, reason: 'not_a_fit' });
    expect(rel.status).toBe(200);
    expect((await contactState(h, id)).ownership_state).toBe('in_pond');
    // the releaser still sees the lead, but only as a masked pond card
    const card = await call<{ contact: { view: string; displayName: string } }>(a, 'GET', `/contacts/${id}`);
    expect([card.status, card.body.contact.view, card.body.contact.displayName]).toEqual([200, 'card', 'Jordan P.']);

    // reusing the release's command id on the create route is not a replay of a create
    const reuse = await call(a, 'POST', '/contacts', { commandId: releaseId, displayName: 'Anything' });
    expect([reuse.status, reuse.code]).toEqual([422, 'COMMAND_ID_REUSED']);
    expect(JSON.stringify(reuse.body)).not.toContain('Privately');

    // a genuine replay of the create returns the stored outcome as the caller sees the contact NOW
    const replay = await call<{ replayed: boolean; contact: { id: string; view: string; displayName: string } }>(a, 'POST', '/contacts', { commandId: createId, firstName: 'Jordan', lastName: 'Privately' });
    expect([replay.status, replay.body.replayed, replay.body.contact.id, replay.body.contact.view, replay.body.contact.displayName]).toEqual([200, true, id, 'card', 'Jordan P.']);
    expect(JSON.stringify(replay.body)).not.toContain('Privately');
  });

  it('R-OWN-7: an ownership command id reused on a different contact is refused (422 COMMAND_ID_REUSED), never answered as a successful replay that did nothing', async () => {
    const a = w.agents[1]!;
    const first = await create(a, { displayName: 'Reuse One', phones: [randomPhone()] });
    const second = await create(a, { displayName: 'Reuse Two', phones: [randomPhone()] });
    const commandId = randomUUID();
    expect((await command(a, first, 'release', { commandId, reason: 'not_a_fit' })).status).toBe(200);
    const reused = await command(a, second, 'release', { commandId, reason: 'not_a_fit' });
    expect([reused.status, reused.code]).toEqual([422, 'COMMAND_ID_REUSED']);
    expect((await contactState(h, second)).ownership_state).toBe('owned');
    // the genuine replay on the first contact still returns the stored outcome
    const replay = await command<{ result: { replayed: boolean; events: { type: string }[] } }>(a, first, 'release', { commandId, reason: 'not_a_fit' });
    expect([replay.status, replay.body.result.replayed, replay.body.result.events.map((e) => e.type)]).toEqual([200, true, ['released']]);
  });
});

describe('intake dedup (R-OWN-25, R-OWN-20)', () => {
  it('R-OWN-25 E19: two different people posted by name only (no phone or email) from one source within 10 min are two contacts; the same name re-posted is duplicate_ignored', async () => {
    const one = await intake(h, w, { fullName: 'Morgan Alpha', phones: [], postalCode: '02134' });
    const two = await intake(h, w, { fullName: 'Riley Beta', phones: [], postalCode: '02134' });
    expect([one.outcome, two.outcome]).toEqual(['new_contact', 'new_contact']);
    expect(two.contactId).not.toBe(one.contactId);
    const again = await intake(h, w, { fullName: 'Morgan  alpha', phones: [], postalCode: '02134' });
    expect([again.outcome, again.contactId]).toEqual(['duplicate_ignored', one.contactId]);
  });

  it('R-OWN-20 R-OWN-25: an inquiry whose phone belongs to a merged-away contact is redirected to the survivor (following the merge chain), never creating and routing a new contact', async () => {
    const [a0, a1] = w.agents as [TestClient, TestClient];
    const p = { x: randomPhone(), y: randomPhone(), z: randomPhone() };
    const x = await create(a0, { displayName: 'Chain Survivor', phones: [p.x] });
    const y = await create(a1, { displayName: 'Chain Loser', phones: [p.y] });
    const z = await create(a0, { displayName: 'Chain Top', phones: [p.z] });
    // y → x, then x → z: y's phone must reach z (two hops)
    expect((await command(w.owner, x, 'merge', { loserId: y, ownerChoice: a0.userId })).status).toBe(200);
    expect((await command(w.owner, z, 'merge', { loserId: x })).status).toBe(200);
    const before = (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
    const r = await intake(h, w, { fullName: 'Chain Loser', phones: [p.y] });
    expect([r.status, r.contactId, r.outcome]).toEqual([200, z, 'reinquiry']);
    expect((await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n).toBe(before);
    const st = await contactState(h, z);
    expect([st.ownership_state, st.owner_user_id]).toEqual(['owned', a0.userId]); // R-OWN-20: an owned lead never changes owner
    expect((await ledger(h, z)).at(-1)!.type).toBe('reinquiry');
    expect((await h.su.query('SELECT contact_id FROM lead_inquiries WHERE contact_id = ANY($1::uuid[])', [[x, y, z]])).rows).toEqual([{ contact_id: z }]);
  });
});

describe('deactivation keeps an Owner (R-PERM-2)', () => {
  it('R-PERM-2 R-OWN-22: two Owners deactivating each other at the same moment: exactly one succeeds and the tenant keeps an active Owner', async () => {
    const second = await h.invite(w.owner, 'owner');
    await freshReauth(h, w.owner);
    await freshReauth(h, second);
    // hold both Owner memberships so the two requests reach their row locks together
    const blocker = await h.su.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT 1 FROM memberships WHERE tenant_id = $1 AND role = 'owner' FOR UPDATE", [w.tenantId]);
      const both = Promise.all([
        call(w.owner, 'POST', `/members/${second.userId}/deactivate`, { mode: 'run', destination: 'default_pond' }),
        call(second, 'POST', `/members/${w.owner.userId}/deactivate`, { mode: 'run', destination: 'default_pond' }),
      ]);
      await new Promise((r) => setTimeout(r, 750));
      await blocker.query('COMMIT');
      const [r1, r2] = await both;
      expect([r1.status, r2.status].filter((s) => s === 202)).toHaveLength(1);
    } finally {
      blocker.release();
    }
    const active = (await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'", [w.tenantId])).rows[0]!.n;
    expect(active).toBe(1);
  });
});
