// Module 28 over real Postgres as app_user, through the real server and the send path (fakes only).
// R-SELL-1…5, R-AST-17, R-OWN-27, R-TEN-1; E87, E88, E89; R-MLS-2, R-MLS-3 (seller-update side); D1/R-PAR-12
// (an opted-out seller is shown before the tap and never sent to).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, inboundSms } from '../assistant/testing.js';
import { mlsConnection, reso, mlsDeps, pagedFeed, makeDue, REVIEWED_PACK, TEST_ATTRIBUTION } from '../mls/testing.js';
import { syncConnection } from '../mls/sync.js';
import { handlers } from '../worker/handlers/index.js';
import { SELLER_UPDATE_JOBS } from './handlers.js';
import { MLS_PACK_NOT_REVIEWED } from './assembly.js';
import { RECOMMENDATION, type SendT, type SellerListing, type UpdateT, call, cmd, draftsOf, reconcile, sellerListing, showing } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let other: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: (process.env.SU_LOG as never) ?? undefined });
  w = await assistantWorld(h, { agents: 2 });
  other = await assistantWorld(h, { agents: 1 });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const agentB = () => w.agents[1]!;

async function drafted(l: SellerListing, a: TestClient = agent()): Promise<UpdateT> {
  await reconcile(h, w.tenantId);
  const r = await call<{ update: UpdateT | null }>(a, 'GET', `/listings/${l.listingId}/seller-update`);
  expect(r.status).toBe(200);
  expect(r.body.update).not.toBeNull();
  return r.body.update!;
}

const send = (a: TestClient, id: string, body: Record<string, unknown> = {}) => call<SendT>(a, 'POST', `/seller-updates/${id}/send`, { commandId: cmd(), ...body });
const sectionOf = (u: UpdateT, kind: string) => u.sections.find((s) => s.kind === kind)!;
const outbound = async (contactId: string) => (await h.su.query("SELECT id, channel, status, status_reason, initiator, purpose, action_category, assistant_action_id, body, subject FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at", [contactId])).rows;

describe('R-SELL-1 / R-OWN-27: the weekly assembly, woken by the reconcile handler at the stored instant', () => {
  it('R-SELL-1: an active team listing with a seller gets one draft per period (never autonomous), a feed card under seller_update:{listing}:{period}, trigger_ref.listing_id, and its next instant stored one cadence later', async () => {
    const l = await sellerListing(agent());
    const r1 = await reconcile(h, w.tenantId);
    expect(r1.drafted).toBeGreaterThanOrEqual(1);
    const d = await draftsOf(h, l.listingId);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: 'proposed', owner_user_id: agent().userId, contact_id: null, autonomy: 'requires_approval', action_category: 'seller_update' });
    expect(d[0]!.trigger_ref).toMatchObject({ kind: 'seller_update', listing_id: l.listingId });
    const key = d[0]!.trigger_ref['period_key'] as string;
    expect(d[0]!.dedupe_key).toBe(`seller_update:${l.listingId}:${key}`);
    expect(d[0]!.payload['body']).not.toMatch(/recommend/i); // R-SELL-3: never prefilled
    const due = (await h.su.query<{ d: Date }>('SELECT seller_update_next_due_at AS d FROM listings WHERE id = $1', [l.listingId])).rows[0]!.d;
    expect(due.getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);
    // the agent's feed: one card with the module's key, opening the listing
    const feed = await call<{ pinned: unknown[]; scored: { itemType: string; primaryAction: { kind: string; listingId?: string }; reasons: { label: string }[] }[] }>(agent(), 'GET', '/feed');
    const cards = feed.body.scored.filter((c) => c.itemType === 'seller_update' && c.primaryAction.listingId === l.listingId);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.primaryAction.kind).toBe('open_listing');
    const stored = await h.su.query('SELECT dedupe_key FROM priority_feed_items WHERE assistant_action_id = $1', [d[0]!.id]);
    expect(stored.rows.map((x) => x.dedupe_key)).toEqual([`seller_update:${l.listingId}:${key}`]);
    // a second pass in the same period writes nothing (dedupe), and nothing was sent by itself (R-AST-17)
    await reconcile(h, w.tenantId);
    expect(await draftsOf(h, l.listingId)).toHaveLength(1);
    expect(await outbound(l.sellers[0]!.id)).toHaveLength(0);
  });

  it('R-SELL-1: the next period supersedes the unsent draft; a listing without a seller is never armed; an inactive listing or cadence 0 disarms', async () => {
    const l = await sellerListing(agent());
    await reconcile(h, w.tenantId);
    const first = (await draftsOf(h, l.listingId))[0]!;
    // a week later: the stored instant is due
    await reconcile(h, w.tenantId, Date.now() + 7 * 86_400_000 + 60_000);
    const after = await draftsOf(h, l.listingId);
    expect(after.map((x) => x.status)).toEqual(['superseded', 'proposed']);
    expect(after[1]!.id).not.toBe(first.id);

    const bare = await call<{ listing: { id: string } }>(agent(), 'POST', '/listings', { status: 'active', addressLine1: '9 Bare St', city: 'Oakland', region: 'CA', postalCode: '94610' });
    await reconcile(h, w.tenantId);
    expect((await h.su.query('SELECT seller_update_next_due_at AS d FROM listings WHERE id = $1', [bare.body.listing.id])).rows[0].d).toBeNull();

    expect((await call(agent(), 'PATCH', `/listings/${l.listingId}`, { status: 'pending' })).status).toBe(200);
    await reconcile(h, w.tenantId);
    expect((await h.su.query('SELECT seller_update_next_due_at AS d FROM listings WHERE id = $1', [l.listingId])).rows[0].d).toBeNull();
    expect((await draftsOf(h, l.listingId)).map((x) => x.status)).toEqual(['superseded', 'superseded']);
  });

  it('R-OWN-27: the reconcile handler is registered once, every 5 min, per tenant', () => {
    const hs = handlers.filter((x) => x.kind === SELLER_UPDATE_JOBS.reconcile);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.every?.ms).toBe(5 * 60_000);
  });
});

describe('R-SELL-2: every figure says where it came from and as of when', () => {
  it('E87: a week with zero showings logged says "No showings logged in Realty OS this week", still sourced (the listing whose log was read) and dated', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    const s = sectionOf(u, 'showings');
    expect(s.state).toBe('none_logged');
    expect(s.lines.map((x) => x.text)).toEqual(['No showings logged in Realty OS this week']);
    expect(s.sources[0]!.evidence).toEqual([expect.objectContaining({ sourceType: 'listing', sourceId: l.listingId, label: 'Listing record: 0 logged' })]);
    expect(u.assembledThrough).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(u.period.text).toMatch(/–/);
    expect(sectionOf(u, 'competing').lines.map((x) => x.text)).toEqual(['Competing listings unavailable: no MLS feed connected']);
    expect(JSON.stringify(u)).not.toMatch(/confidence|probab|page views?|email opens?/i);
  });

  it('R-SELL-2: counts cite each showing and feedback row; feedback is verbatim; an export is never counted as marketing', async () => {
    const l = await sellerListing(agent());
    const s1 = await showing(agent(), l.listingId, { hoursAgo: 30, feedback: 'Loved the kitchen; small yard.' });
    const s2 = await showing(agent(), l.listingId, { hoursAgo: 20, status: 'no_show' });
    // an exported piece (module 29 is not built: the superuser writes the row exactly as it would)
    await h.su.query(
      `INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, status, prose, template_key, content_sha256, guard_result, exported_at)
       VALUES ($1, $2, $3, 'marketplace_export', 1, 'draft', '{}', 'marketplace.v1', repeat('0', 64), '{}', now() - interval '1 hour')`,
      [w.tenantId, randomUUID(), l.listingId],
    );
    const u = await drafted(l);
    const sh = sectionOf(u, 'showings');
    expect(sh.lines[0]!.text).toBe('2 showings logged in Realty OS this week (1 of 2 marked no-show)');
    expect(sh.sources[0]!.evidence.map((e) => e.sourceId).sort()).toEqual([s1.showingId, s2.showingId].sort());
    const fb = sectionOf(u, 'feedback');
    expect(fb.lines[0]).toMatchObject({ text: 'Loved the kitchen; small yard.', feedback: { feedbackId: s1.feedbackId, excluded: false } });
    expect(fb.sources[0]!.evidence[0]).toMatchObject({ sourceType: 'showing_feedback', sourceId: s1.feedbackId, label: 'Feedback log: Loved the kitchen; small yard.' });
    expect(sectionOf(u, 'marketing').lines.map((x) => x.text)).toEqual(['No marketing activity logged in Realty OS this week']);
  });
});

describe('E88 / R-SELL-3 / R-AST-17: the recommendation is required and is the agent’s own', () => {
  it('E88: Send without a recommendation (or a short one) is SELLER_UPDATE_NEEDS_RECOMMENDATION; the DB refuses an approval without one; with one it goes out through dispatch', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    expect(u.recommendation).toBe('');
    expect((await send(agent(), u.id)).code).toBe('SELLER_UPDATE_NEEDS_RECOMMENDATION');
    expect((await send(agent(), u.id, { recommendation: 'Hold.' })).code).toBe('SELLER_UPDATE_NEEDS_RECOMMENDATION');
    expect(await outbound(l.sellers[0]!.id)).toHaveLength(0);
    // the 0018 CHECK, whatever the API does
    await expect(h.su.query("UPDATE assistant_actions SET status = 'approved', decided_by_user_id = $2, decided_at = now(), edited_payload = '{\"recommendation\":\"short\"}' WHERE id = $1", [u.id, agent().userId])).rejects.toThrow(/recommendation|check/i);

    const ok = await send(agent(), u.id, { recommendation: RECOMMENDATION, recipientIds: [l.sellers[0]!.id] });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBe('sent');
    const m = await outbound(l.sellers[0]!.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ channel: 'email', status: 'sent', initiator: 'assistant', purpose: 'informational', action_category: 'seller_update' });
    // the message's approved action is the per-recipient send of this update, decided by the agent
    const child = (await h.su.query('SELECT status, decided_by_user_id, trigger_ref, action_category FROM assistant_actions WHERE id = $1', [m[0]!.assistant_action_id])).rows[0];
    expect(['approved', 'executed']).toContain(child.status);
    expect(child).toMatchObject({ decided_by_user_id: agent().userId, action_category: 'seller_update', trigger_ref: { actionId: u.id, listing_id: l.listingId } });
    expect(m[0]!.body).toContain(RECOMMENDATION);
    expect(m[0]!.body).toContain('No showings logged in Realty OS this week');
    expect(h.providers.email.sent.at(-1)?.text ?? JSON.stringify(h.providers.email.sent.at(-1))).toContain(RECOMMENDATION);
    const row = (await draftsOf(h, l.listingId))[0]!;
    expect(row.status).toBe('approved');
    expect(row.edited_payload).toMatchObject({ recommendation: RECOMMENDATION });
    // the tap again: idempotent, the same message
    const again = await send(agent(), u.id, { recommendation: RECOMMENDATION });
    expect(again.body.messageId).toBe(ok.body.messageId);
    expect(await outbound(l.sellers[0]!.id)).toHaveLength(1);
  });

  it('R-AST-17: the generic approve route takes the same branch (recommendation, watermark, listing agent)', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    expect((await call(agent(), 'POST', `/assistant/actions/${u.id}/approve`, { commandId: cmd() })).code).toBe('SELLER_UPDATE_NEEDS_RECOMMENDATION');
    await showing(agent(), l.listingId, { hoursAgo: 2 });
    expect((await call(agent(), 'POST', `/assistant/actions/${u.id}/approve`, { commandId: cmd(), editedPayload: { recommendation: RECOMMENDATION } })).code).toBe('SELLER_UPDATE_STALE');
    const ra = await call(agent(), 'POST', `/seller-updates/${u.id}/reassemble`);
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    const ok = await call<{ result: string }>(agent(), 'POST', `/assistant/actions/${u.id}/approve`, { commandId: cmd(), editedPayload: { recommendation: RECOMMENDATION } });
    expect(ok.body.result).toBe('sent');
  });

  it('R-SELL-3: PATCH saves the agent’s recommendation on the unsent draft; Send uses it', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    const p = await call<{ update: UpdateT }>(agent(), 'PATCH', `/seller-updates/${u.id}`, { recommendation: RECOMMENDATION });
    expect(p.body.update.recommendation).toBe(RECOMMENDATION);
    expect(p.body.update.preview.body).toContain(RECOMMENDATION);
    expect((await send(agent(), u.id)).body.result).toBe('sent');
  });
});

describe('E89: rude or identifying feedback', () => {
  it('E89: shown verbatim with a flag when it names a buyer, removable per item, and a removed item never reaches the seller', async () => {
    const l = await sellerListing(agent());
    const buyer = (await call<{ contact: { id: string } }>(agent(), 'POST', '/contacts', { commandId: cmd(), firstName: 'Morgan', lastName: 'Quill', phones: [], emails: [`mq-${randomUUID().slice(0, 6)}@example.test`] })).body.contact.id;
    const rude = await showing(agent(), l.listingId, { hoursAgo: 10, feedback: 'Morgan Quill said the place is a dump.', buyerContactId: buyer });
    const kind = await showing(agent(), l.listingId, { hoursAgo: 8, feedback: 'Bright and quiet.' });
    const u = await drafted(l);
    const lines = sectionOf(u, 'feedback').lines;
    expect(lines.find((x) => x.feedback?.feedbackId === rude.feedbackId)).toMatchObject({ text: 'Morgan Quill said the place is a dump.', feedback: { namesPerson: true } });
    expect(lines.find((x) => x.feedback?.feedbackId === kind.feedbackId)?.feedback?.namesPerson).toBe(false);
    expect(await outbound(l.sellers[0]!.id)).toHaveLength(0); // never auto-sent
    const p = await call<{ update: UpdateT }>(agent(), 'PATCH', `/seller-updates/${u.id}`, { excludedFeedbackIds: [rude.feedbackId] });
    expect(p.body.update.excludedFeedbackIds).toEqual([rude.feedbackId]);
    expect(p.body.update.preview.body).not.toContain('dump');
    expect((await call(agent(), 'PATCH', `/seller-updates/${u.id}`, { excludedFeedbackIds: [randomUUID()] })).code).toBe('VALIDATION_FAILED');
    expect((await send(agent(), u.id, { recommendation: RECOMMENDATION })).body.result).toBe('sent');
    const m = await outbound(l.sellers[0]!.id);
    expect(m[0]!.body).toContain('Bright and quiet.');
    expect(m[0]!.body).not.toContain('dump');
    expect(m[0]!.body).not.toContain('Morgan');
  });
});

describe('R-SELL-4: the assembled_through watermark', () => {
  it('stale data ⇒ SELLER_UPDATE_STALE (nothing approved or sent); the view says stale; one tap re-assembles and the watermark moves', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    expect(u.stale).toBe(false);
    await showing(agent(), l.listingId, { hoursAgo: 3, feedback: 'Second look booked.' });
    const v = await call<{ update: UpdateT }>(agent(), 'GET', `/seller-updates/${u.id}`);
    expect(v.body.update.stale).toBe(true);
    const r = await send(agent(), u.id, { recommendation: RECOMMENDATION });
    expect(r.status).toBe(409);
    expect(r.code).toBe('SELLER_UPDATE_STALE');
    expect((await draftsOf(h, l.listingId))[0]!.status).toBe('proposed');
    expect(await outbound(l.sellers[0]!.id)).toHaveLength(0);
    const re = await call<{ update: UpdateT }>(agent(), 'POST', `/seller-updates/${u.id}/reassemble`);
    expect(re.body.update.stale).toBe(false);
    expect(Date.parse(re.body.update.assembledThrough)).toBeGreaterThan(Date.parse(u.assembledThrough));
    expect(sectionOf(re.body.update, 'showings').lines[0]!.text).toBe('1 showing logged in Realty OS this week');
    expect((await send(agent(), u.id, { recommendation: RECOMMENDATION })).body.result).toBe('sent');
  });
});

describe('R-SELL-5 / D1: each seller through dispatchOutbound; an opted-out seller is shown before the tap', () => {
  it('a seller who texted STOP (with no email) is shown as not reachable before the tap and is never sent to; the co-seller gets the update', async () => {
    const l = await sellerListing(agent(), { sellers: 0 });
    const phone = `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const stopper = (await call<{ contact: { id: string } }>(agent(), 'POST', '/contacts', { commandId: cmd(), firstName: 'Stop', lastName: 'Per', phones: [phone], emails: [] })).body.contact.id;
    await call(agent(), 'POST', `/listings/${l.listingId}/contacts`, { contactId: stopper, role: 'seller' });
    const co = (await call<{ contact: { id: string } }>(agent(), 'POST', '/contacts', { commandId: cmd(), firstName: 'Co', lastName: 'Seller', phones: [], emails: [`co-${randomUUID().slice(0, 6)}@example.test`] })).body.contact.id;
    await call(agent(), 'POST', `/listings/${l.listingId}/contacts`, { contactId: co, role: 'co_seller' });
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const u = await drafted(l);
    const st = u.recipients.find((r) => r.contactId === stopper)!;
    expect(st).toMatchObject({ sendable: false, channel: 'sms' });
    expect(st.whyNot).toMatch(/texted STOP/);
    expect(u.recipients.find((r) => r.contactId === co)).toMatchObject({ sendable: true, channel: 'email', whyNot: null });
    // the agent saw only the co-seller as reachable: Send names exactly that
    expect((await send(agent(), u.id, { recommendation: RECOMMENDATION, recipientIds: [co, stopper] })).code).toBe('SELLER_UPDATE_RECIPIENTS_CHANGED');
    const ok = await send(agent(), u.id, { recommendation: RECOMMENDATION, recipientIds: [co] });
    expect(ok.body.recipients).toEqual([expect.objectContaining({ contactId: co, result: 'sent' })]);
    expect(await outbound(stopper)).toHaveLength(0);
  });

  it('an opt-out that arrives after the agent looked is SELLER_UPDATE_RECIPIENTS_CHANGED (never discovered after the tap); no reachable seller is SELLER_UPDATE_NO_RECIPIENT', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    const seller = l.sellers[0]!.id;
    expect(u.recipients[0]).toMatchObject({ contactId: seller, sendable: true });
    expect((await call(agent(), 'POST', `/contacts/${seller}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    expect((await send(agent(), u.id, { recommendation: RECOMMENDATION, recipientIds: [seller] })).code).toBe('SELLER_UPDATE_RECIPIENTS_CHANGED');
    const v = (await call<{ update: UpdateT }>(agent(), 'GET', `/seller-updates/${u.id}`)).body.update;
    expect(v.recipients[0]).toMatchObject({ sendable: false });
    expect(v.recipients[0]!.whyNot).toMatch(/not to be contacted/);
    expect((await send(agent(), u.id, { recommendation: RECOMMENDATION, recipientIds: [] })).code).toBe('SELLER_UPDATE_NO_RECIPIENT');
    expect(await outbound(seller)).toHaveLength(0);
  });

  it('R-PAR-12: a STOP from a phone since removed (not as a wrong number) still blocks the seller before the tap', async () => {
    const l = await sellerListing(agent(), { sellers: 0 });
    const p1 = `+1415556${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const p2 = `+1415557${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const c = (await call<{ contact: { id: string } }>(agent(), 'POST', '/contacts', { commandId: cmd(), firstName: 'Two', lastName: 'Phones', phones: [p1, p2], emails: [] })).body.contact.id;
    await call(agent(), 'POST', `/listings/${l.listingId}/contacts`, { contactId: c, role: 'seller' });
    await inboundSms(h, p1, w.mainNumber, 'STOP');
    await h.su.query("UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old', is_primary = false WHERE contact_id = $1 AND address = $2", [c, p1]);
    const u = await drafted(l);
    expect(u.recipients[0]).toMatchObject({ contactId: c, sendable: false, channel: 'sms' });
    expect(u.recipients[0]!.whyNot).toMatch(/^Not sent: their phone/);
    expect((await send(agent(), u.id, { recommendation: RECOMMENDATION })).code).toBe('SELLER_UPDATE_NO_RECIPIENT');
    expect(await outbound(c)).toHaveLength(0);
  });

  it('a seller another agent owns is shown as not reachable by you before the tap (only a contact’s owner sends an approved draft); one you cannot see is never a recipient', async () => {
    // the Owner is the listing agent here: they see every contact, but agent B owns this seller
    const l = await sellerListing(w.owner, { sellers: 0 });
    const theirs = (await call<{ contact: { id: string } }>(agentB(), 'POST', '/contacts', { commandId: cmd(), firstName: 'Their', lastName: 'Lead', phones: [], emails: [`tl-${randomUUID().slice(0, 6)}@example.test`] })).body.contact.id;
    expect((await call(w.owner, 'POST', `/listings/${l.listingId}/contacts`, { contactId: theirs, role: 'seller' })).status).toBe(200);
    const u = await drafted(l, w.owner);
    expect(u.recipients[0]).toMatchObject({ contactId: theirs, sendable: false, visible: true });
    expect(u.recipients[0]!.whyNot).toMatch(/another agent/);
    expect((await send(w.owner, u.id, { recommendation: RECOMMENDATION })).code).toBe('SELLER_UPDATE_NO_RECIPIENT');
    expect(await outbound(theirs)).toHaveLength(0);
  });
});

describe('MLS figures only when the MLS data is eligible (R-MLS-2, R-MLS-3)', () => {
  let conn: string;
  beforeAll(async () => {
    conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await makeDue(h, conn);
    await syncConnection(mlsDeps(h, { [conn]: pagedFeed([[reso(7101, { PostalCode: '94699', ListPrice: 850000, BedroomsTotal: 3 }), reso(7102, { PostalCode: '94699', ListPrice: 860000, BedroomsTotal: 3, InternetEntireListingDisplayYN: false })]]) }), w.tenantId as never, conn);
  }, 60_000);
  afterAll(async () => {
    await h.su.query("UPDATE integration_connections SET status = 'disconnected' WHERE id = $1", [conn]).catch(() => undefined);
  });

  it('a fresh feed with a reviewed licence pack: competing MLS listings with attribution, display-opt-out rows left out', async () => {
    const l = await sellerListing(agent(), { postalCode: '94699', priceCents: 85_500_000 });
    const c = sectionOf(await drafted(l), 'competing');
    expect(c.state).toBe('has_data');
    expect(c.lines[0]!.text).toBe('1 competing listing from the MLS feed');
    expect(c.lines.some((x) => x.text.includes(TEST_ATTRIBUTION))).toBe(true);
    expect(c.statement).toMatch(/MLS data as of /);
  });

  it('E85: a stale feed pauses the MLS part and says as of when; an unreviewed licence pack shows nothing from the MLS and says why', async () => {
    const l = await sellerListing(agent(), { postalCode: '94699', priceCents: 85_500_000 });
    await h.su.query("UPDATE integration_connections SET last_synced_at = now() - interval '3 days' WHERE id = $1", [conn]);
    try {
      const c = sectionOf(await drafted(l), 'competing');
      expect(c.state).toBe('stale');
      expect(c.statement).toMatch(/^MLS data as of .*paused/);
      expect(c.sources).toEqual([]);
    } finally {
      await h.su.query('UPDATE integration_connections SET last_synced_at = now() WHERE id = $1', [conn]);
    }
    const l2 = await sellerListing(agent(), { postalCode: '94699', priceCents: 85_500_000 });
    await h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [conn, JSON.stringify({ ...REVIEWED_PACK, reviewed_by_counsel_at: null })]);
    try {
      const c = sectionOf(await drafted(l2), 'competing');
      expect(c).toMatchObject({ state: 'unavailable', statement: MLS_PACK_NOT_REVIEWED });
      expect(c.lines.map((x) => x.text)).toEqual([MLS_PACK_NOT_REVIEWED]);
    } finally {
      await h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [conn, JSON.stringify(REVIEWED_PACK)]);
    }
  });
});

describe('who may send: only the listing’s own agent', () => {
  it('another agent of the team cannot read, edit, reassemble or send it (404); after the listing changes agent the old draft is invalidated', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    for (const [m, p] of [['GET', ''], ['PATCH', ''], ['POST', '/reassemble'], ['POST', '/send']] as const) {
      const r = await call(agentB(), m, `/seller-updates/${u.id}${p}`, m === 'GET' ? undefined : m === 'PATCH' ? { recommendation: RECOMMENDATION } : { commandId: cmd(), recommendation: RECOMMENDATION });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await call(agentB(), 'POST', `/assistant/actions/${u.id}/approve`, { commandId: cmd(), editedPayload: { recommendation: RECOMMENDATION } })).status).toBe(404);
    // the Team Lead reassigns the listing to agent B: agent A's draft no longer sends
    await h.su.query('UPDATE listings SET listing_agent_user_id = $2 WHERE id = $1', [l.listingId, agentB().userId]);
    expect((await send(agent(), u.id, { recommendation: RECOMMENDATION })).code).toBe('DRAFT_INVALIDATED');
    expect((await draftsOf(h, l.listingId))[0]!.status).toBe('invalidated');
    expect(await outbound(l.sellers[0]!.id)).toHaveLength(0);
  });
});

describe('R-TEN-1: cross-tenant isolation of every route and the handler', () => {
  it('another tenant’s agent gets 404 on every route; their reconcile pass never touches this tenant', async () => {
    const l = await sellerListing(agent());
    const u = await drafted(l);
    const x = other.agents[0]!;
    expect((await call(x, 'GET', `/listings/${l.listingId}/seller-update`)).status).toBe(404);
    for (const [m, p] of [['GET', ''], ['PATCH', ''], ['POST', '/reassemble'], ['POST', '/send']] as const) {
      const r = await call(x, m, `/seller-updates/${u.id}${p}`, m === 'GET' ? undefined : m === 'PATCH' ? { recommendation: RECOMMENDATION } : { commandId: cmd(), recommendation: RECOMMENDATION });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    const before = await h.su.query('SELECT seller_update_next_due_at AS d FROM listings WHERE id = $1', [l.listingId]);
    await h.su.query("UPDATE listings SET seller_update_next_due_at = now() - interval '1 minute' WHERE id = $1", [l.listingId]);
    const r = await reconcile(h, other.tenantId);
    expect(r.drafted).toBe(0);
    expect(await draftsOf(h, l.listingId)).toHaveLength(1);
    await h.su.query('UPDATE listings SET seller_update_next_due_at = $2 WHERE id = $1', [l.listingId, before.rows[0].d]);
    expect((await draftsOf(h, l.listingId))[0]!.status).toBe('proposed');
  });
});
