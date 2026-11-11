// Erasing or purging a merge survivor (R-DATA-4, R-DATA-5, R-OWN-24; migration 0037). contacts.merged_into_contact_id
// is ON DELETE SET NULL, and a merged record without its survivor fails the contacts CHECK, so before that migration the
// erasure of anyone who had a duplicate merged into them was refused (a 422 the Owner could not act on) and the
// hourly retention sweep failed as a whole once such a soft-deleted person passed purge_after. A merged record
// never resurfaced, because the whole transaction rolled back. Now the person is the contact and every record
// merged into it: erasure and purge take all of them (deepest first), the deal refusal covers all of them, and
// the sweep skips a person it may not purge instead of failing. Opt-outs stay by HMAC. The most
// privacy-protective reading of what erasure means for merged records: an owner/counsel question (VERIFY WITH
// COUNSEL). Real Postgres as app_user through the real server, fake providers.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, inboundSms, ownedContact, randomEmail, randomPhone, sendText } from '../comms/testing.js';
import { command, suFixture } from '../leads/testing.js';
import { retentionSweep } from '../worker/repos/jobs.js';
import { type AuditRow, auditRows, call, freshReauth } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let owner: TestClient;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, rule: false });
  owner = w.owner;
  agent = w.agents[0]!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const rowOf = async (id: string) => (await h.su.query('SELECT id, merged_into_contact_id, closed_reason, deleted_at FROM contacts WHERE id = $1', [id])).rows[0] ?? null;
const childCount = async (ids: string[]) => {
  const n = async (t: string) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE contact_id = ANY ($1::uuid[])`, [ids])).rows[0]!.n;
  return { points: await n('contact_points'), notes: await n('notes'), messages: await n('messages'), conversations: await n('conversations') };
};
const erase = async (id: string) => {
  await freshReauth(h, owner);
  return call<{ erased?: true; error?: { details?: { deals: { id: string; stage: string }[] } } }>(owner, 'POST', `/contacts/${id}/erase`, { reason: 'PRIVACY_REQUEST' });
};
const preview = async (id: string) => {
  await freshReauth(h, owner);
  return call<{ erasable: boolean; mergedRecords: number; deals: { id: string; link: string; closed: boolean }[] }>(owner, 'GET', `/contacts/${id}/erasure`);
};
async function merge(survivor: string, loser: string): Promise<void> {
  const r = await command(agent, survivor, 'merge', { loserId: loser });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(await rowOf(loser)).toMatchObject({ merged_into_contact_id: survivor, closed_reason: 'merged' });
}
/** Two records of one person (a shared email); the duplicate's phone texted STOP before the merge. */
async function mergedPair(): Promise<{ survivor: string; loser: string; stopped: string }> {
  const email = randomEmail();
  const survivor = (await ownedContact(agent, { email, consent: false })).id;
  const dup = await ownedContact(agent, { email, consent: false, confirmDistinct: true });
  expect((await inboundSms(h, dup.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
  expect((await call(agent, 'POST', `/contacts/${dup.id}/notes`, { body: 'met at the open house' })).status).toBe(201);
  await merge(survivor, dup.id);
  return { survivor, loser: dup.id, stopped: dup.phone };
}
/** A deal for `contact` (primary + party) reaching `stage`, written by the Owner under RLS. */
async function deal(contact: string, stage: string): Promise<string> {
  const id = randomUUID();
  await withTenantTx(owner.actor(), async (tx) => {
    await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
              VALUES (app.tenant_id(), ${id}, 'Maple St purchase', 'buy', 'active', now(), ${contact}, ${agent.userId})`.execute(tx);
    await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (app.tenant_id(), ${id}, ${contact}, 'buyer')`.execute(tx);
    await sql`UPDATE deals SET stage = ${stage}, closed_at = CASE WHEN ${stage} = 'closed' THEN now() END WHERE id = ${id}`.execute(tx);
  }, { db: h.database });
  return id;
}
const erasures = async (): Promise<AuditRow[]> => auditRows(h, w.tenantId, 'contact.erase');

describe('R-DATA-4: erasing a person erases the records merged into them', () => {
  it('R-DATA-4 R-OWN-24: erasing a merge survivor (before the fix: a 422) erases the merged record too, with every child of both; the STOP the duplicate’s phone sent still blocks that number (HMAC); one contact.erase audit row per record, ids only', async () => {
    const p = await mergedPair();
    const pre = await preview(p.survivor);
    expect(pre.body).toMatchObject({ erasable: true, deals: [], mergedRecords: 1 });
    const r = await erase(p.survivor);
    expect([r.status, r.body]).toEqual([200, { erased: true }]);
    expect(await rowOf(p.survivor)).toBeNull();
    expect(await rowOf(p.loser)).toBeNull();
    expect(await childCount([p.survivor, p.loser])).toEqual({ points: 0, notes: 0, messages: 0, conversations: 0 });
    // the audit trail names each erased record (no PII): the person, and the merged record erased with them
    const rows = (await erasures()).filter((a) => a.entity_id === p.survivor || a.entity_id === p.loser);
    expect(rows.map((a) => [a.entity_id, a.changes, a.reason, a.actor_user_id])).toEqual([
      [p.survivor, { erased: true }, 'PRIVACY_REQUEST', owner.userId],
      [p.loser, { erased: true, erased_with_contact_id: p.survivor }, 'PRIVACY_REQUEST', owner.userId],
    ]);
    // D1: the opt-out outlives the erasure; a new contact with that number is still not texted
    const again = await ownedContact(agent, { phone: p.stopped, consent: false });
    expect((await sendText(agent, again.id, 'Hello again')).body).toMatchObject({ result: 'blocked', decision: { reasons: ['CONSENT_REVOKED'] } });
  });

  it('R-DATA-4: a merge chain (A into B, B into C): erasing B, itself a merged record, erases A with it and leaves C; erasing C then erases what remains', async () => {
    const c = (await ownedContact(agent, { consent: false })).id;
    const b = (await ownedContact(agent, { consent: false })).id;
    const a = (await ownedContact(agent, { consent: false })).id;
    await merge(b, a);
    await merge(c, b);
    expect((await preview(c)).body.mergedRecords).toBe(2);
    expect((await preview(b)).body.mergedRecords).toBe(1);
    expect((await erase(b)).status).toBe(200);
    expect([await rowOf(a), await rowOf(b)]).toEqual([null, null]);
    expect(await rowOf(c)).toMatchObject({ id: c, merged_into_contact_id: null, deleted_at: null });
    expect((await erase(c)).status).toBe(200);
    expect(await rowOf(c)).toBeNull();
  });

  it('E59 R-DATA-4: a merged record on a deal blocks the person’s erasure: the preview names the deal, the erase is refused CONTACT_ON_DEAL with it and deletes nothing; the Owner takes the person (the merged record’s link) off the deal, audited with the record’s id, then the erasure succeeds and the deal stays', async () => {
    const email = randomEmail();
    const survivor = (await ownedContact(agent, { email, consent: false })).id;
    const loser = (await ownedContact(agent, { email, consent: false, confirmDistinct: true })).id;
    const d = await deal(loser, 'closed');
    await merge(survivor, loser);
    const pre = await preview(survivor);
    expect(pre.body).toMatchObject({ erasable: false, mergedRecords: 1, deals: [{ id: d, link: 'primary_and_party', closed: true }] });
    const refused = await erase(survivor);
    expect([refused.status, refused.code]).toEqual([409, 'CONTACT_ON_DEAL']);
    expect(refused.body.error?.details).toEqual({ deals: [{ id: d, stage: 'closed' }] });
    expect([await rowOf(survivor), await rowOf(loser)].map((x) => x?.id)).toEqual([survivor, loser]);
    // the database refuses it the same way when the API check is bypassed
    await expect(withTenantTx(owner.actor(), (tx) => sql`SELECT app.erase_contact(${survivor}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx), { db: h.database })).rejects.toThrow(/CONTACT_ON_DEAL/);

    await freshReauth(h, owner);
    expect((await call(owner, 'POST', `/contacts/${survivor}/deals/${d}/remove`, { reason: 'PRIVACY_REQUEST' })).status).toBe(200);
    const removed = (await auditRows(h, w.tenantId, 'deal.contact_removed')).find((a) => a.entity_id === d)!;
    expect(removed.changes).toEqual({ contact_id: { from: survivor, to: null }, merged_contact_ids: { from: [loser], to: [] }, primary_contact: { changed: true } });
    expect((await preview(survivor)).body).toMatchObject({ erasable: true, deals: [] });
    expect((await erase(survivor)).status).toBe(200);
    expect([await rowOf(survivor), await rowOf(loser)]).toEqual([null, null]);
    expect((await h.su.query('SELECT stage, primary_contact_id FROM deals WHERE id = $1', [d])).rows).toEqual([{ stage: 'closed', primary_contact_id: null }]);
  });
});

describe('R-DATA-5: the retention sweep purges a soft-deleted person with their merged records, and never fails on them', () => {
  /** The person soft-deleted (the Owner's delete command), purge_after moved into the past (clock fixture). */
  async function softDeletedAndDue(id: string): Promise<void> {
    const del = await command(owner, id, 'delete');
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    await suFixture(h, [{ text: "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", values: [id] }]);
  }

  it('R-DATA-5 R-DATA-3: a soft-deleted survivor past purge_after is purged with its merged record (before the fix the whole sweep failed on it, every hour, for every tenant); a person whose merged record is on a deal is skipped, and the sweep still purges the rest', async () => {
    const p = await mergedPair();
    await softDeletedAndDue(p.survivor);
    // a second person whose merged record is on a deal: the sweep may not purge it, so it skips it
    const email = randomEmail();
    const held = (await ownedContact(agent, { email, consent: false })).id;
    const heldDup = (await ownedContact(agent, { email, consent: false, confirmDistinct: true })).id;
    await deal(heldDup, 'closed');
    await merge(held, heldDup);
    await softDeletedAndDue(held);
    // and a plain soft-deleted contact, purged as before
    const plain = (await ownedContact(agent, { phone: randomPhone(), consent: false })).id;
    await softDeletedAndDue(plain);

    const r = await retentionSweep(h.database, Date.now() as never);
    expect(r.contacts_purged).toBeGreaterThanOrEqual(2);
    expect([await rowOf(p.survivor), await rowOf(p.loser), await rowOf(plain)]).toEqual([null, null, null]);
    expect(await childCount([p.survivor, p.loser, plain])).toEqual({ points: 0, notes: 0, messages: 0, conversations: 0 });
    expect((await rowOf(held))?.id).toBe(held);
    expect(await rowOf(heldDup)).toMatchObject({ merged_into_contact_id: held });
    // the next run finds nothing it may purge and does not fail either
    await expect(retentionSweep(h.database, Date.now() as never)).resolves.toMatchObject({ contacts_purged: 0 });
  });
});
