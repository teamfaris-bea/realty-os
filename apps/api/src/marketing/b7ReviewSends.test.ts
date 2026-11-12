// Batch 7 review, sends findings F1 and F5 (module 29, R-MKT-8; R-OWN-14, R-OWN-24; owner decision D8). Through the
// real server over real Postgres; `h.su` reads state back and moves stored deadlines (clock fixtures) only.
//   - F1: an open-house invite is a mass send in all but name, so it is never a touch: it records no first touch (the
//     lead still breaches its SLA), the scoreboard does not count it, and it answers no waiting client in the feed.
//   - F5: a merged-away recipient is never sent to; it gets outcome 'merged', named after the record it lives in now.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { marketingReady } from '../bulk/testing.js';
import { inboundSms, ownedContact, randomEmail, sendText } from '../comms/testing.js';
import { command, contactState, intake, ledger, leadsWorker, setPeriodDeadlines } from '../leads/testing.js';
import { feedOf } from '../workspace/testing.js';
import { type MarketingWorld, approve, call, generateAll, marketingWorld, teamListing } from './testing.js';

let h: ApiHarness;
let w: MarketingWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await marketingWorld(h);
  await marketingReady(h, w);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

type Recipient = { contactId: string; outcome: string; messageId: string | null; mergedInto?: { contactId: string; name: string } | null };
type Sent = { sent: number; total: number; optedOut: number; blocked: number; noEmail: number; merged: number; text: string; recipients: Recipient[] };

async function approvedInvite(by: TestClient = w.agent): Promise<{ id: string; listingId: string }> {
  const l = await teamListing(by, {});
  const p = (await generateAll(by, l, { kinds: ['open_house_invite'] })).open_house_invite!;
  const a = await approve(by, p);
  if (a.status !== 200) throw new Error(`approve: ${JSON.stringify(a.body)}`);
  return { id: p.id, listingId: l };
}

const sendInvite = (c: TestClient, pieceId: string, ids: string[]) => call<Sent>(c, 'POST', `/marketing-pieces/${pieceId}/invite/send`, { recipientContactIds: ids });

/** An intake lead with an email, offered to an agent and accepted by them: owned, with its first-touch deadline running. */
async function routedLead(): Promise<{ contactId: string; owner: TestClient; email: string }> {
  const email = randomEmail();
  const { contactId } = await intake(h, w, { fullName: 'Robin Lead', emails: [email] });
  const st = await contactState(h, contactId);
  const owner = [...w.agents, ...(w.teamLead ? [w.teamLead] : [])].find((a) => a.userId === st.offered_to_user_id);
  if (!owner || !st.offer_id) throw new Error(`lead not offered: ${st.ownership_state}`);
  const acc = await command(owner, contactId, 'accept', { offerId: st.offer_id });
  if (acc.status !== 200) throw new Error(`accept: ${acc.status} ${JSON.stringify(acc.body)}`);
  return { contactId, owner, email };
}

const firstTouches = async (contactId: string) =>
  (await h.su.query("SELECT seq FROM lead_ownership_events WHERE contact_id = $1 AND type = 'first_touch_recorded'", [contactId])).rows;
const touchCols = async (contactId: string) =>
  (await h.su.query<{ first_touch_at: Date | null; last_human_touch_at: Date | null }>('SELECT first_touch_at, last_human_touch_at FROM contacts WHERE id = $1', [contactId])).rows[0]!;
const inviteRows = async (pieceId: string) =>
  (await h.su.query<{ id: string; contact_id: string; status: string }>('SELECT id, contact_id, status FROM messages WHERE marketing_piece_id = $1', [pieceId])).rows;

async function activity(c: TestClient): Promise<number> {
  const r = await withTenantTx(
    c.actor(),
    (tx) => sql<{ texts_and_emails: string }>`SELECT texts_and_emails FROM app.scoreboard_activity(${[c.userId]}::uuid[], now() - interval '1 day', now() + interval '1 day')`.execute(tx),
    { db: h.database },
  );
  return Number(r.rows[0]!.texts_and_emails);
}

describe('b7 sends/F1: an open-house invite is never a touch', () => {
  it('R-OWN-14 R-MKT-8 D8 b7 sends/F1: an approved invite to an owned lead whose first-touch deadline is running records no first touch; the lead still breaches', async () => {
    const lead = await routedLead();
    const st0 = await contactState(h, lead.contactId);
    expect(st0.ownership_state).toBe('owned');
    expect(st0.first_touch_due_at).not.toBeNull();
    const before = await touchCols(lead.contactId);
    expect(before.first_touch_at).toBeNull();

    const inv = await approvedInvite(lead.owner);
    const r = await sendInvite(lead.owner, inv.id, [lead.contactId]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: 1, total: 1 });
    const rows = await inviteRows(inv.id);
    expect(rows.map((m) => [m.contact_id, m.status === 'sent' || m.status === 'delivered'])).toEqual([[lead.contactId, true]]);

    // no touch: neither contact column moved, and no first_touch_recorded ledger event (nor one referring to the invite)
    const after = await touchCols(lead.contactId);
    expect(after).toEqual(before);
    expect(after.last_human_touch_at).toBeNull();
    expect(await firstTouches(lead.contactId)).toEqual([]);
    expect((await ledger(h, lead.contactId)).some((e) => JSON.stringify(e.payload).includes(rows[0]!.id))).toBe(false);

    // the SLA runs on: at the deadline the breach timer writes first_touch_breached
    await setPeriodDeadlines(h, lead.contactId, -1000, 10 * 60_000);
    await leadsWorker(h).drain();
    const st1 = await contactState(h, lead.contactId);
    expect([st1.ownership_state, st1.owner_user_id]).toEqual(['owned', lead.owner.userId]);
    expect((await ledger(h, lead.contactId)).at(-1)).toMatchObject({ type: 'first_touch_breached', actor_kind: 'timer' });
    expect((await h.su.query('SELECT first_touch_breached_at IS NOT NULL AS b FROM contacts WHERE id = $1', [lead.contactId])).rows[0].b).toBe(true);
  });

  it('R-OWN-14 R-MKT-8 R-ACC-4 b7 sends/F1: app.scoreboard_activity does not count an invite; a one-to-one email does', async () => {
    const agent = w.agent;
    const c = await ownedContact(agent, { consent: false });
    const n0 = await activity(agent);
    const inv = await approvedInvite(agent);
    const r = await sendInvite(agent, inv.id, [c.id]);
    expect([r.status, r.body.sent]).toEqual([200, 1]);
    expect(await activity(agent)).toBe(n0);
    // the agent's own scoreboard route agrees
    const touches = async () => (await call<{ scoreboard: { touches: { textsAndEmails: number } } }>(agent, 'GET', '/scoreboard?range=7d')).body.scoreboard.touches.textsAndEmails;
    const t0 = await touches();
    // control: a normal human email to the same contact is counted
    const e = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Following up', body: 'Hi, just checking in about your search.', idempotencyKey: `k-${randomUUID()}` });
    expect(e.body.result).toBe('sent');
    expect(await activity(agent)).toBe(n0 + 1);
    expect(await touches()).toBe(t0 + 1);
  });

  it('R-OWN-14 R-MKT-8 b7 sends/F1: an invite does not clear a waiting-client (unanswered_inbound) card; a one-to-one reply does', async () => {
    const agent = w.agent;
    const c = await ownedContact(agent, { firstName: 'Wren' });
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Is the house still available?')).statusCode).toBeLessThan(300);
    const waiting = async () => (await feedOf(agent)).all.some((x) => x.itemType === 'unanswered_inbound' && x.contact?.id === c.id);
    expect(await waiting()).toBe(true);
    const inv = await approvedInvite(agent);
    const r = await sendInvite(agent, inv.id, [c.id]);
    expect([r.status, r.body.sent]).toEqual([200, 1]);
    expect(await waiting()).toBe(true);
    // control: a one-to-one text answers the client
    expect((await sendText(agent, c.id, 'Yes, it is. Want to see it this weekend?')).body.result).toBe('sent');
    expect(await waiting()).toBe(false);
  });
});

describe('b7 sends/F5: merged-away recipients', () => {
  it('R-OWN-24 R-MKT-8 b7 sends/F5: a merged-away recipient gets outcome merged, named after the survivor; counted in merged and total; nothing is sent to it', async () => {
    const agent = w.agent;
    const survivor = await ownedContact(agent, { consent: false, firstName: 'Avery' });
    const loser = await ownedContact(agent, { consent: false, firstName: 'Blake' });
    const plain = await ownedContact(agent, { consent: false, firstName: 'Casey' });
    // the owning agent merges the duplicate into the survivor through the ownership engine (R-OWN-24)
    const m = await command(agent, survivor.id, 'merge', { loserId: loser.id });
    expect([m.status, JSON.stringify(m.body)]).toEqual([200, expect.any(String)]);
    expect((await h.su.query('SELECT closed_reason, merged_into_contact_id FROM contacts WHERE id = $1', [loser.id])).rows[0]).toEqual({ closed_reason: 'merged', merged_into_contact_id: survivor.id });
    const survivorName = (await h.su.query<{ display_name: string }>('SELECT display_name FROM contacts WHERE id = $1', [survivor.id])).rows[0]!.display_name;

    const inv = await approvedInvite(agent);
    const outboxBefore = h.providers.email.sent.filter((x) => x.to === loser.email).length;
    // the Owner sends (tenant-wide sight): an agent's RLS no longer shows a closed, unowned merged-away record at all
    const r = await sendInvite(w.owner, inv.id, [plain.id, loser.id]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: 1, total: 2, merged: 1, optedOut: 0, blocked: 0, text: 'Sent 1 of 2; 1 merged into another record (invite the record they were merged into)' });
    const rec = r.body.recipients.find((x) => x.contactId === loser.id)!;
    expect(rec).toMatchObject({ outcome: 'merged', messageId: null, mergedInto: { contactId: survivor.id, name: survivorName } });
    expect(r.body.recipients.find((x) => x.contactId === plain.id)!.outcome).toBe('sent');
    // by contact id: no invite row at all for the merged-away record; the plain recipient's was sent
    const rows = await inviteRows(inv.id);
    expect(rows.filter((x) => x.contact_id === loser.id)).toEqual([]);
    expect(rows.filter((x) => x.contact_id === plain.id && (x.status === 'sent' || x.status === 'delivered'))).toHaveLength(1);
    // the survivor was not in the list, so nothing went to the merged-away address either
    expect(h.providers.email.sent.filter((x) => x.to === loser.email).length).toBe(outboxBefore);
  });
});
