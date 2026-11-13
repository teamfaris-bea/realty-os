// Module 45 staff routes (R-PORTAL-13, R-PORTAL-14, R-PORTAL-16, R-PORTAL-18, R-PORTAL-19; E690-E695, E697).
// Fakes only; platform:portal cleared in the per-test database inside try/finally.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { noticeFromNote } from './staff/invite.js';
import { portalSyncInTx } from './sync/sync.js';
import { PortalClient, call, client, deal, invite, json, milestone, portalWorld, publish, setPortalCleared, sharedDocument, signIn, slugOf, type PortalWorld } from './testing.js';

let h: ApiHarness;
let w: PortalWorld;
let slug: string;
let n = 0;
const ip = () => `192.0.2.${(++n % 200) + 20}`;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
  slug = await slugOf(h, w.tenantId);
  await setPortalCleared(h, true);
}, 240_000);
afterAll(async () => {
  try {
    await setPortalCleared(h, false);
  } finally {
    await h?.close();
  }
});

const sync = () => withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => portalSyncInTx(tx, systemActor(w.tenantId, 'worker'), { linkSecret: h.config.sessionSecret, publicBaseUrl: h.config.publicBaseUrl }, now), { db: h.database });
const agent = () => w.agents[0]!;
async function listing(line1 = `${100 + Math.floor(Math.random() * 800)} Maple Court`): Promise<string> {
  const r = await call<{ listing: { id: string } }>(agent(), 'POST', '/listings', { status: 'active', addressLine1: line1, city: 'Exampleville', region: 'CA', postalCode: '94000' });
  return r.body.listing.id;
}

describe('R-PORTAL-13 invite (E690-E693)', () => {
  it('E690: a contact who is not a party is 409 PORTAL_NOT_A_PARTY', async () => {
    const buyer = await client(agent());
    const d = await deal(agent(), buyer.id);
    const stranger = await client(agent(), { firstName: 'Stan' });
    const r = await invite(agent(), d, stranger.id);
    expect(r.status).toBe(409);
    expect(r.code).toBe('PORTAL_NOT_A_PARTY');
    expect((await call(agent(), 'POST', `/deals/${d}/contacts`, { contactId: stranger.id, role: 'other' })).status).toBe(200);
    expect((await invite(agent(), d, stranger.id)).code).toBe('PORTAL_NOT_A_PARTY');
    expect((await call(agent(), 'POST', `/deals/${d}/contacts`, { contactId: stranger.id, role: 'co_buyer' })).status).toBe(200);
  });

  it('E691: no active email or phone is 409 PORTAL_LOGIN_POINT_MISSING; a login point later removed makes the staff view say sign-in is impossible', async () => {
    const c = await client(agent(), { firstName: 'Nopo' });
    const d = await deal(agent(), c.id);
    await h.su.query(`UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old' WHERE contact_id = $1`, [c.id]);
    const r = await invite(agent(), d, c.id);
    expect(r.code).toBe('PORTAL_LOGIN_POINT_MISSING');
    const c2 = await client(agent(), { firstName: 'Lena' });
    const d2 = await deal(agent(), c2.id);
    const inv = await invite(agent(), d2, c2.id);
    expect(inv.status).toBe(200);
    expect(inv.body.account.loginPoint!.kind).toBe('email');
    await h.su.query(`UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old' WHERE id = $1`, [inv.body.account.loginPoint!.id]);
    const view = await call<{ accounts: { signInImpossible: string | null; loginPoint: { hint: string; usable: boolean } }[] }>(agent(), 'GET', `/deals/${d2}/portal`);
    expect(view.body.accounts[0]!.signInImpossible).toMatch(/Sign-in is impossible/);
    expect(view.body.accounts[0]!.loginPoint.usable).toBe(false);
    expect(view.body.accounts[0]!.loginPoint.hint).toMatch(/^.•••@/);
  });

  it('E692: inviting twice or with two taps at once gives the same account and grant and one notice; resend sends another', async () => {
    const c = await client(agent(), { firstName: 'Twin' });
    const d = await deal(agent(), c.id);
    const before = h.providers.email.sent.filter((m) => m.to === c.email).length;
    const [a, b] = await Promise.all([invite(agent(), d, c.id), invite(agent(), d, c.id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.account.id).toBe(b.body.account.id);
    expect(a.body.grant.id).toBe(b.body.grant.id);
    const again = await invite(agent(), d, c.id);
    expect(again.body.grant.id).toBe(a.body.grant.id);
    expect(again.body.notice).toMatchObject({ sent: false, text: 'Twin was already invited; no second note was sent.' });
    expect(h.providers.email.sent.filter((m) => m.to === c.email).length - before).toBe(1);
    const resend = await invite(agent(), d, c.id, { resend: true });
    expect(resend.body.notice.sent).toBe(true);
    expect(h.providers.email.sent.filter((m) => m.to === c.email).length - before).toBe(2);
    const counts = await h.su.query<{ a: string; g: string }>(`SELECT (SELECT count(*) FROM portal_accounts WHERE contact_id = $1) AS a, (SELECT count(*) FROM portal_grants g JOIN portal_accounts x ON x.id = g.portal_account_id WHERE x.contact_id = $1) AS g`, [c.id]);
    expect(counts.rows[0]).toEqual({ a: '1', g: '1' });
  });

  it('E692 (b14 F7 regression): two taps at once: the first tap sends the note, the other answers from that note\'s status and never says it was not sent', async () => {
    const IN_FLIGHT = (first: string) => `A note to ${first} is still being sent. Check the conversation before you resend.`;
    const ALREADY = (first: string) => `${first} was already invited; no second note was sent.`;
    for (const first of ['Tapa', 'Tapb', 'Tapc']) {
      const c = await client(agent(), { firstName: first });
      const d = await deal(agent(), c.id);
      const [a, b] = await Promise.all([invite(agent(), d, c.id), invite(agent(), d, c.id)]);
      const [creator, other] = a.body.created.grant ? [a, b] : [b, a];
      expect(creator.body.notice).toEqual({ sent: true, text: `${first} was sent a note by email with how to sign in.`, channel: 'email', decision: null });
      // the other tap found the grant: whether it saw the first note before or after it went, it says it is on its way
      // or was already sent, never "was not sent; the reason is below" with no reason
      expect(other.body.created).toEqual({ account: false, grant: false });
      expect(other.body.notice.sent).toBe(false);
      expect(other.body.notice.decision).toBeNull();
      expect([IN_FLIGHT(first), ALREADY(first)]).toContain(other.body.notice.text);
      expect(h.providers.email.sent.filter((m) => m.to === c.email).length).toBe(1);
    }
  });

  it('E692 (b14 F7 regression): a note this request did not send itself is answered from its status, for every status', () => {
    const decision = { outcome: 'block', reasons: ['CONSENT_REVOKED'], explanation: 'x' };
    const text = (status: string, d: typeof decision | null = null) => noticeFromNote('Ivy', 'email', status, d);
    for (const s of ['sent', 'delivered']) expect(text(s)).toEqual({ sent: false, text: 'Ivy was already invited; no second note was sent.', channel: null, decision: null });
    for (const s of ['queued', 'scheduled', 'dispatching', 'dispatch_unknown']) {
      expect(text(s, decision)).toEqual({ sent: false, text: 'A note to Ivy is still being sent. Check the conversation before you resend.', channel: null, decision: null });
    }
    expect(text('blocked', decision)).toEqual({ sent: false, text: 'The note to Ivy was not sent; the reason is below. The invite stands.', channel: 'email', decision });
    // never "the reason is below" with no reason
    for (const s of ['blocked', 'failed', 'undelivered', 'bounced', 'canceled']) {
      expect(text(s)).toEqual({ sent: false, text: 'No note has reached Ivy yet. Tap Resend to try again.', channel: null, decision: null });
    }
  });

  it('E692 E693 (b14 F7): invited while the portal was off (no note), then again once it is on: the note goes now, and only a later invite says one was already sent', async () => {
    const c = await client(agent(), { firstName: 'Dawn' });
    const d = await deal(agent(), c.id);
    const notes = () => h.providers.email.sent.filter((m) => m.to === c.email).length;
    await setPortalCleared(h, false);
    let first;
    try {
      first = await invite(agent(), d, c.id);
    } finally {
      await setPortalCleared(h, true);
    }
    expect(first.body.notice).toMatchObject({ sent: false, text: "Dawn can't sign in until the client portal is turned on, so nothing was sent to them." });
    expect(notes()).toBe(0);
    // cleared now: the same account and grant, and no note was ever sent, so this invite sends it (never "no second note")
    const second = await invite(agent(), d, c.id);
    expect(second.body.created).toEqual({ account: false, grant: false });
    expect(second.body.notice.text).not.toMatch(/already invited|second note/);
    expect(second.body.notice).toMatchObject({ sent: true, channel: 'email' });
    expect(notes()).toBe(1);
    // a note was sent: now, and only now, a repeat invite says so and sends nothing
    const third = await invite(agent(), d, c.id);
    expect(third.body.notice).toMatchObject({ sent: false, text: 'Dawn was already invited; no second note was sent.' });
    expect(notes()).toBe(1);
  });

  it('E692 (b14 to-do, priorNotices anchored by the contact): a sent message to someone else that carries the grant\'s invite key never counts as this person\'s note', async () => {
    const c = await client(agent(), { firstName: 'Kit' });
    const d = await deal(agent(), c.id);
    const notes = () => h.providers.email.sent.filter((m) => m.to === c.email).length;
    await setPortalCleared(h, false);
    let first;
    try {
      first = await invite(agent(), d, c.id);
    } finally {
      await setPortalCleared(h, true);
    }
    expect(notes()).toBe(0);
    // another agent's own email to their own contact, under a key that matches the grant's invite pattern
    const other = await client(w.agents[1]!, { firstName: 'Ola' });
    await deal(w.agents[1]!, other.id);
    const m = await call<{ message: { status: string } }>(w.agents[1]!, 'POST', `/contacts/${other.id}/messages`, { channel: 'email', subject: 'Hello', body: 'Hello there.', idempotencyKey: `portal_invite:${first.body.grant.id}` });
    expect(m.status).toBe(200);
    expect(m.body.message.status).toBe('sent');
    // Kit never got a note, so this invite sends it (never "already invited")
    const again = await invite(agent(), d, c.id);
    expect(again.body.notice.text).not.toMatch(/already invited/);
    expect(again.body.notice).toMatchObject({ sent: true, channel: 'email' });
    expect(notes()).toBe(1);
  });

  it('E692 (b14 F7): when the first note was blocked, a repeat invite never claims a note was sent; it says none reached them and offers Resend', async () => {
    const c = await client(agent(), { firstName: 'Bree' });
    const d = await deal(agent(), c.id);
    const point = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'`, [c.id])).rows[0]!.id;
    expect((await call(agent(), 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: point, channel: 'email', purpose: 'all', evidence: { note: 'asked by email' } })).status).toBe(200);
    const first = await invite(agent(), d, c.id);
    expect(first.body.notice.sent).toBe(false);
    expect(first.body.notice.decision?.reasons).toContain('CONSENT_REVOKED');
    const again = await invite(agent(), d, c.id);
    expect(again.body.notice.sent).toBe(false);
    expect(again.body.notice.text).not.toMatch(/already invited; no second note/);
    expect(again.body.notice.text).toBe('No note has reached Bree yet. Tap Resend to try again.');
  });

  it('R-PORTAL-13: the notice is the inviter\'s own message (a human touch), carries no token, and its decision is returned when blocked', async () => {
    const c = await client(agent(), { firstName: 'Hope' });
    const d = await deal(agent(), c.id);
    const inv = await invite(agent(), d, c.id);
    const m = await h.su.query<{ initiator: string; initiated_by_user_id: string; body: string; purpose: string }>(`SELECT initiator, initiated_by_user_id, body, purpose FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`, [c.id]);
    expect(m.rows[0]).toMatchObject({ initiator: 'human', initiated_by_user_id: agent().userId, purpose: 'informational' });
    expect(m.rows[0]!.body).not.toMatch(/token/i);
    expect(m.rows[0]!.body).toMatch(/invited you to follow your purchase online/);
    // a person-level do-not-contact blocks the next notice; the invite (a resend) still answers 200 with the decision
    expect((await call(agent(), 'POST', `/contacts/${c.id}/do-not-contact`, { reason: 'asked_in_writing' })).status).toBe(200);
    const again = await invite(agent(), d, c.id, { resend: true });
    expect(again.status).toBe(200);
    expect(again.body.notice.sent).toBe(false);
    expect(again.body.notice.decision?.reasons).toContain('PERSON_DO_NOT_CONTACT');
    expect(inv.body.grant.state).toBe('live');
  });

  it('R-PORTAL-13: a listing seller\'s notice is marketing (no open deal, no recent reply) and a marketing opt-out blocks it', async () => {
    const l = await listing('42 Harbor View');
    const seller = await client(agent(), { firstName: 'Sela' });
    expect((await call(agent(), 'POST', `/listings/${l}/contacts`, { contactId: seller.id, role: 'seller' })).status).toBe(200);
    const phonePoint = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [seller.id])).rows[0]!.id;
    const inv = await invite(agent(), l, seller.id, { loginPointId: phonePoint }, 'listings');
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(inv.body.grant.view).toMatchObject({ scope: 'listing', title: '42 Harbor View' });
    const m = await h.su.query<{ purpose: string; status: string }>(`SELECT purpose, status FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`, [seller.id]);
    expect(m.rows[0]!.purpose).toBe('marketing');
    const other = await client(agent(), { firstName: 'Opal' });
    await call(agent(), 'POST', `/listings/${l}/contacts`, { contactId: other.id, role: 'co_seller' });
    const op = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [other.id])).rows[0]!.id;
    expect((await call(agent(), 'POST', `/contacts/${other.id}/consent`, { kind: 'revoke', pointId: op, channel: 'sms', purpose: 'marketing', evidence: { note: 'no promos' } })).status).toBe(200);
    const blocked = await invite(agent(), l, other.id, { loginPointId: op }, 'listings');
    expect(blocked.status).toBe(200);
    expect(blocked.body.notice.sent).toBe(false);
    expect(blocked.body.notice.decision?.reasons).toContain('CONSENT_REVOKED');
  });
});

describe('R-PORTAL-14 publish, retract, revoke (E694, E695, E697)', () => {
  it('R-PORTAL-14: every publishable kind a person may publish reaches the client (milestone, document, showing, feedback, seller update, next step)', async () => {
    const l = await listing();
    const seller = await client(agent(), { firstName: 'Mo' });
    const d = await deal(agent(), seller.id, { side: 'sell', listingId: l });
    const inv = await invite(agent(), d, seller.id);
    const g = inv.body.grant.id;
    const date = await milestone(agent(), d, '2031-07-01');
    const doc = await sharedDocument(h, w, agent(), d);
    const sh = await call<{ showing: { id: string } }>(agent(), 'POST', `/listings/${l}/showings`, { startsAt: '2030-01-05T15:00:00Z' });
    await call(agent(), 'POST', `/showings/${sh.body.showing.id}/feedback`, { rating: 4, comments: 'Loved the kitchen.' });
    const fb = (await h.su.query<{ id: string }>('SELECT id FROM showing_feedback WHERE showing_id = $1', [sh.body.showing.id])).rows[0]!.id;
    const task = await call<{ task: { id: string } }>(agent(), 'POST', '/tasks', { title: 'Sign the disclosures', dealId: d, dueAt: '2031-06-20T17:00:00Z' });
    const su = randomUUID();
    await h.su.query(`INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, owner_user_id, decided_by_user_id, decided_at, explanation, payload, edited_payload, trigger_ref)
      VALUES ($1, $2, 'seller_update_draft', 'seller_update', 'requires_approval', 'approved', $3, $3, now(), 'Weekly update', $4, $4, $5)`,
      [w.tenantId, su, agent().userId, JSON.stringify({ body: 'Three showings this week.', recommendation: 'Hold the price two more weeks.' }), JSON.stringify({ listing_id: l })]);
    const out: Record<string, string> = {};
    for (const [kind, id] of [['milestone', date], ['document', doc.id], ['showing', sh.body.showing.id], ['feedback', fb], ['seller_update', su], ['next_step', task.body.task.id]] as const) {
      out[kind] = (await publish(agent(), kind, id, [g])).body.results[0]!.result;
    }
    expect(out).toEqual({ milestone: 'published', document: 'published', showing: 'published', feedback: 'published', seller_update: 'published', next_step: 'published' });
    const pc = await signIn(h, slug, seller.email, new PortalClient(h, ip()));
    const tl = json<{ items: { kind: string; body: string | null }[]; nextSteps: { title: string }[] }>(await pc.get(`/api/portal/timeline?grantId=${g}`));
    expect(tl.items.map((i) => i.kind).sort()).toEqual(['feedback', 'milestone', 'seller_update', 'showing']);
    expect(tl.items.find((i) => i.kind === 'feedback')!.body).toBe('Loved the kitchen.');
    expect(tl.nextSteps.map((s) => s.title)).toEqual(['Sign the disclosures']);
  });

  it('E694: core refuses an unshared, pending or contact-scoped document and a proposed milestone before the DB; a forged insert is refused by the guard', async () => {
    const c = await client(agent());
    const d = await deal(agent(), c.id);
    const g = (await invite(agent(), d, c.id)).body.grant.id;
    const doc = await sharedDocument(h, w, agent(), d);
    await call(agent(), 'POST', `/documents/${doc.id}/share`, { shared: false });
    const date = await milestone(agent(), d, '2031-02-02');
    await h.su.query(`UPDATE deal_dates SET status = 'proposed', source = 'template' WHERE id = $1`, [date]);
    const r1 = await publish(agent(), 'document', doc.id, [g]);
    const r2 = await publish(agent(), 'milestone', date, [g]);
    expect([r1.body.results[0]!.result, r2.body.results[0]!.result]).toEqual(['PORTAL_SOURCE_NOT_IN_GRANT', 'PORTAL_SOURCE_NOT_IN_GRANT']);
    expect(r1.body.results[0]!.text).toMatch(/cannot be shared/);
    expect((await publish(agent(), 'milestone', doc.id, [g])).body.results[0]!.result).toBe('PORTAL_SOURCE_NOT_IN_GRANT');
    const forged = await withTenantTx(agent().actor(), (tx) => sql`INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, document_id, source_type, source_id, published_by_kind, published_by_user_id, published_at)
        VALUES (app.tenant_id(), gen_random_uuid(), ${g}, 'document', 'x', ${doc.id}, 'document', ${doc.id}, 'user', ${agent().userId}, now())`.execute(tx), { db: h.database }).then(() => 'ok', (e: Error) => e.message.split(':')[0]);
    expect(forged).toBe('PORTAL_SOURCE_NOT_IN_GRANT');
  });

  it('E695: through the deal\'s listing a buyer-side client is refused PORTAL_NOT_SELLER_SIDE by core, and a forged insert by the guard', async () => {
    const l = await listing();
    const buyer = await client(agent(), { firstName: 'Bix' });
    const d = await deal(agent(), buyer.id, { side: 'buy', listingId: l });
    const g = (await invite(agent(), d, buyer.id)).body.grant.id;
    const sh = await call<{ showing: { id: string } }>(agent(), 'POST', `/listings/${l}/showings`, { startsAt: '2030-01-06T15:00:00Z' });
    const r = await publish(agent(), 'showing', sh.body.showing.id, [g]);
    expect(r.body.results[0]).toMatchObject({ result: 'PORTAL_NOT_SELLER_SIDE', text: expect.stringMatching(/Add them as a seller/) });
    const forged = await withTenantTx(agent().actor(), (tx) => sql`INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id, published_by_kind, published_by_user_id, published_at)
        VALUES (app.tenant_id(), gen_random_uuid(), ${g}, 'showing', 'x', 'showing', ${sh.body.showing.id}, 'user', ${agent().userId}, now())`.execute(tx), { db: h.database }).then(() => 'ok', (e: Error) => e.message.split(':')[0]);
    expect(forged).toBe('PORTAL_NOT_SELLER_SIDE');
  });

  it('R-PORTAL-14: a batch publishes into each grant on its own: one refusal never undoes another grant\'s item', async () => {
    const a = await client(agent(), { firstName: 'Ann' });
    const b = await client(agent(), { firstName: 'Ben' });
    const d = await deal(agent(), a.id);
    await call(agent(), 'POST', `/deals/${d}/contacts`, { contactId: b.id, role: 'co_buyer' });
    const ga = (await invite(agent(), d, a.id)).body.grant.id;
    const gb = (await invite(agent(), d, b.id)).body.grant.id;
    await call(agent(), 'POST', `/portal-grants/${gb}/revoke`);
    const doc = await sharedDocument(h, w, agent(), d);
    const r = await publish(agent(), 'document', doc.id, [ga, gb]);
    expect(r.body.results.map((x) => [x.grantId, x.result])).toEqual([[ga, 'published'], [gb, 'PORTAL_GRANT_INACTIVE']]);
    expect((await publish(agent(), 'document', doc.id, [ga])).body.results[0]!.result).toBe('already_published');
  });

  it('E697: a person retracts by mistake and publishes again; the old row stays retracted with its author; a second retract and a second revoke are 409', async () => {
    const c = await client(agent());
    const d = await deal(agent(), c.id);
    const g = (await invite(agent(), d, c.id)).body.grant.id;
    const doc = await sharedDocument(h, w, agent(), d);
    const first = (await publish(agent(), 'document', doc.id, [g])).body.results[0]!.itemId!;
    expect((await call(agent(), 'POST', `/portal-items/${first}/retract`)).status).toBe(200);
    expect((await call(agent(), 'POST', `/portal-items/${first}/retract`)).code).toBe('PORTAL_ITEM_RETRACTED');
    const again = (await publish(agent(), 'document', doc.id, [g])).body.results[0]!;
    expect(again.result).toBe('published');
    expect(again.itemId).not.toBe(first);
    const rows = await h.su.query<{ id: string; retracted_by_user_id: string | null }>('SELECT id, retracted_by_user_id FROM portal_items WHERE grant_id = $1 ORDER BY published_at', [g]);
    expect(rows.rows).toEqual([{ id: first, retracted_by_user_id: agent().userId }, { id: again.itemId, retracted_by_user_id: null }]);
    const view = await call<{ items: { id: string; retractedBy: string | null }[] }>(agent(), 'GET', `/deals/${d}/portal`);
    expect(view.body.items.find((i) => i.id === first)!.retractedBy).toMatch(/^Member/);
    expect((await call(agent(), 'POST', `/portal-grants/${g}/revoke`)).status).toBe(200);
    expect((await call(agent(), 'POST', `/portal-grants/${g}/revoke`)).code).toBe('PORTAL_GRANT_REVOKED');
  });

  it('R-PORTAL-18: the title can be edited; disable is final; a login point change answers how to end open sessions', async () => {
    const c = await client(agent(), { firstName: 'Tia' });
    const d = await deal(agent(), c.id);
    const inv = await invite(agent(), d, c.id);
    expect((await call(agent(), 'PATCH', `/portal-grants/${inv.body.grant.id}/display`, { title: 'Our new home' })).status).toBe(200);
    expect((await call(agent(), 'PATCH', `/portal-grants/${inv.body.grant.id}/display`, { title: 'Bad\u0007title' })).status).toBe(422);
    const pv = await call<{ grant: { title: string } }>(agent(), 'GET', `/portal-grants/${inv.body.grant.id}/preview`);
    expect(pv.body.grant.title).toBe('Our new home');
    const phone = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    const lp = await call<{ text: string }>(agent(), 'POST', `/portal-accounts/${inv.body.account.id}/login-point`, { pointId: phone });
    expect(lp.body.text).toMatch(/To end their open sessions now, disable the account and invite them again/);
    expect((await call(agent(), 'POST', `/portal-accounts/${inv.body.account.id}/disable`, { reason: 'WRONG_PERSON' })).status).toBe(200);
    expect((await call(agent(), 'POST', `/portal-accounts/${inv.body.account.id}/disable`, { reason: 'WRONG_PERSON' })).code).toBe('PORTAL_ACCOUNT_DISABLED');
    const audit = await h.su.query<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_id = ANY($2::uuid[]) AND action LIKE 'portal.%' ORDER BY occurred_at`, [w.tenantId, [inv.body.account.id, inv.body.grant.id]]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['portal.invited', 'portal.granted', 'portal.display_updated', 'portal.login_point_changed', 'portal.account_disabled']));
  });

  it('Q-PORTAL-14 (b14 audit owner question, conservative default): an account used by two agents\' deals is repointed or disabled only by someone who manages every live grant of it (Owner/Admin), never by either agent alone', async () => {
    const c = await client(agent(), { firstName: 'Ola' });
    const mine = await deal(agent(), c.id);
    const inv = await invite(agent(), mine, c.id);
    expect(inv.status).toBe(200);
    // the same client on a deal another agent owns, with its own grant on the same account
    const other = await call<{ deal: { id: string } }>(w.owner, 'POST', '/deals', { primaryContactId: c.id, side: 'sell', ownerUserId: w.agents[1]!.userId });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const inv2 = await invite(w.owner, other.body.deal.id, c.id);
    expect(inv2.status, JSON.stringify(inv2.body)).toBe(200);
    expect(inv2.body.account.id).toBe(inv.body.account.id);
    expect(inv2.body.grant.id).not.toBe(inv.body.grant.id);
    const acct = inv.body.account.id;
    const phone = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'`, [c.id])).rows[0]!.id;
    for (const who of [agent(), w.agents[1]!]) {
      expect((await call(who, 'POST', `/portal-accounts/${acct}/login-point`, { pointId: phone })).status).toBe(404);
      expect((await call(who, 'POST', `/portal-accounts/${acct}/disable`, { reason: 'WRONG_PERSON' })).status).toBe(404);
    }
    expect((await h.su.query<{ login_point_id: string; status: string }>('SELECT login_point_id, status FROM portal_accounts WHERE id = $1', [acct])).rows[0]!.status).not.toBe('disabled');
    expect((await call(w.owner, 'POST', `/portal-accounts/${acct}/login-point`, { pointId: phone })).status).toBe(200);
    // once the other agent's grant is revoked, the account is the first agent's alone again
    expect((await call(w.owner, 'POST', `/portal-grants/${inv2.body.grant.id}/revoke`)).status).toBe(200);
    expect((await call(agent(), 'POST', `/portal-accounts/${acct}/disable`, { reason: 'CLIENT_ASKED' })).status).toBe(200);
  });

  it('R-PORTAL-16: the item preview says what publishable() says and writes nothing', async () => {
    const c = await client(agent());
    const d = await deal(agent(), c.id);
    const g = (await invite(agent(), d, c.id)).body.grant.id;
    const date = await milestone(agent(), d, '2031-09-09', 'closing');
    const before = await h.su.query('SELECT count(*) FROM portal_items');
    const p = await call<{ publishable: boolean; item: { title: string; occursOn: string } }>(agent(), 'POST', '/portal-items/preview', { grantId: g, kind: 'milestone', sourceId: date });
    expect(p.body).toMatchObject({ publishable: true, item: { title: 'Closing', occursOn: '2031-09-09' } });
    const q = await call<{ publishable: boolean; code: string }>(agent(), 'POST', '/portal-items/preview', { grantId: g, kind: 'document', sourceId: date });
    expect(q.body).toMatchObject({ publishable: false, code: 'PORTAL_SOURCE_NOT_IN_GRANT' });
    expect((await h.su.query('SELECT count(*) FROM portal_items')).rows).toEqual(before.rows);
  });
});

describe('R-PORTAL-16 the staff preview is the client view', () => {
  it('R-PORTAL-16 property: over random publish and retract states the preview equals what the client sees (fast-check)', async () => {
    const c = await client(agent(), { firstName: 'Pia' });
    const d = await deal(agent(), c.id);
    const g = (await invite(agent(), d, c.id)).body.grant.id;
    const pc = await signIn(h, slug, c.email, new PortalClient(h, ip()));
    const dates: string[] = [];
    for (let i = 1; i <= 4; i++) dates.push(await milestone(agent(), d, `2031-1${i % 3}-1${i}`));
    const docs = [await sharedDocument(h, w, agent(), d, 'A.pdf'), await sharedDocument(h, w, agent(), d, 'B.pdf')];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom('publish', 'retract'), fc.integer({ min: 0, max: 5 })), { minLength: 1, maxLength: 6 }), async (ops) => {
        for (const [op, k] of ops) {
          const [kind, id] = k < 4 ? ['milestone', dates[k]!] : ['document', docs[k - 4]!.id];
          if (op === 'publish') await publish(agent(), kind, id, [g]);
          else {
            const live = await h.su.query<{ id: string }>('SELECT id FROM portal_items WHERE grant_id = $1 AND source_id = $2 AND retracted_at IS NULL', [g, id]);
            if (live.rows[0]) await call(agent(), 'POST', `/portal-items/${live.rows[0].id}/retract`);
          }
        }
        const pv = (await call<{ visibleNow: boolean; grant: unknown; timeline: unknown; documents: unknown }>(agent(), 'GET', `/portal-grants/${g}/preview`)).body;
        expect(pv.visibleNow).toBe(true);
        const me = json<{ grants: unknown[] }>(await pc.get('/api/portal/me'));
        const tl = json<{ items: unknown; nextSteps: unknown }>(await pc.get(`/api/portal/timeline?grantId=${g}`));
        const dc = json<{ documents: unknown }>(await pc.get(`/api/portal/documents?grantId=${g}`));
        expect(me.grants).toEqual([pv.grant]);
        expect({ items: tl.items, nextSteps: tl.nextSteps }).toEqual(pv.timeline);
        expect(dc.documents).toEqual(pv.documents);
      }),
      { numRuns: 8 },
    );
    await sync();
  });
});
