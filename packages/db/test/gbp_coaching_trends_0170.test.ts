// The GBP gate and guards (M53) and the aggregate-only coaching trends definer (M54) at the database. Every
// application write is app_user under RLS (the system actor for gbp_reviews, a person's tap for publications); the
// superuser pool only records a pack's review (platform data), builds fixtures that have no application path in this
// package (calls, recordings, call scores, a connected location: suFixture), and reads back.
import type { Actor, SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, type Member, PH, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let other: World;
let X: Member;
let Y: Member;
let tc: Member;
let tl: Member;
let support: SupportActor;
let gbpConn: string;
let gbpDown: string;
let fbConn: string;

const D11 = ['platform:fair_housing', 'platform:coaching', 'platform:gmail', 'platform:voice', 'platform:avm', 'platform:review_requests', 'platform:portal'];
const review = (keys: string[], on: boolean) =>
  h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${on ? 'now()' : 'NULL'} WHERE key = ANY($1::text[]) AND status = 'published'`, [keys]);
const resetPacks = () => h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key LIKE 'platform:%'");
const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });

async function connection(tenantId: string, kind: string, status: string): Promise<string> {
  const id = uuid();
  await suFixture(h.su, `INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, connected_at, disconnected_at)
                         VALUES ($1, $2, $3, $4, 'Example Realty Team location', $5, $6, now(), ${status === 'disconnected' ? 'now()' : 'NULL'})`, [tenantId, id, kind, status, `loc-${id}`, uuid()]);
  return id;
}

beforeAll(async () => {
  h = await createHarness(5);
  w = await createWorld(h.app, { agents: 3, teamLead: true });
  other = await createWorld(h.app, { agents: 1 });
  [X, Y] = [w.agents[0]!, w.agents[1]!];
  tl = w.tl!;
  tc = { ...w.agents[2]!, role: 'tc', actor: { ...w.agents[2]!.actor, role: 'tc' } };
  await suFixture(h.su, "UPDATE memberships SET role = 'tc', accepting_leads = false WHERE tenant_id = $1 AND user_id = $2", [w.tenantId, tc.id]);
  const supportUserId = uuid() as UserId;
  await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`support-${uuid()}@platform.test`}, 'Platform Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
  const grantId = uuid();
  await as(w.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
                                      VALUES (${w.tenantId}, ${grantId}, ${supportUserId}, ${w.owner.id}, 'ticket', now() + interval '1 hour')`.execute(tx));
  support = { kind: 'support', userId: supportUserId, tenantId: w.tenantId as TenantId, grantId };
  gbpConn = await connection(w.tenantId, 'gbp_location', 'connected');
  gbpDown = await connection(w.tenantId, 'gbp_location', 'disconnected');
  fbConn = await connection(w.tenantId, 'facebook_page', 'connected');
}, 120_000);
afterAll(async () => {
  await resetPacks().catch(() => undefined);
  await h?.close();
});

// ---- M53: gbp_reviews ------------------------------------------------------------------------------------------

const sys = () => w.system('provider');
const insertReview = (o: { id?: string; conn?: string; status?: string; action?: string | null; rating?: number | null; body?: string | null; reviewer?: string | null } = {}) => {
  const id = o.id ?? uuid();
  return as(sys(), async (tx) => {
    await sql`INSERT INTO gbp_reviews (tenant_id, id, connection_id, external_review_id, rating, body, reviewer_display, reviewed_at, reply_status, reply_action_id)
              VALUES (app.tenant_id(), ${id}, ${o.conn ?? gbpConn}, ${`rev-${id}`}, ${o.rating === undefined ? 4 : o.rating}, ${o.body === undefined ? 'Helpful and quick.' : o.body},
                      ${o.reviewer === undefined ? 'Reviewer A' : o.reviewer}, now(), ${o.status ?? 'none'}, ${o.action ?? null})`.execute(tx);
    return id;
  });
};
const setReview = (id: string, set: ReturnType<typeof sql>) => as(sys(), (tx) => sql`UPDATE gbp_reviews SET ${set} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx));
const reviewRow = async (id: string) => (await suRows<{ reply_status: string; reply_action_id: string | null; rating: number | null }>(h.su, 'SELECT reply_status, reply_action_id, rating FROM gbp_reviews WHERE id = $1', [id]))[0]!;

async function draftFor(reviewId: string, kind = 'review_reply_draft'): Promise<string> {
  const id = uuid();
  const category = kind === 'review_reply_draft' ? 'novel_message' : kind === 'ad_reallocation' ? 'money' : 'internal';
  const autonomy = kind === 'review_reply_draft' || kind === 'ad_reallocation' ? 'requires_approval' : 'internal';
  await as(sys(), (tx) => sql`INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, explanation, payload)
                              VALUES (app.tenant_id(), ${id}, ${kind}, ${category}, ${autonomy}, 'proposed', 'A reply to a Google review, waiting for a tap.',
                                      ${JSON.stringify({ review_id: reviewId, text: 'Thank you for the kind words.' })}::jsonb)`.execute(tx));
  return id;
}
const approve = (actionId: string) =>
  as(w.owner.actor, (tx) => sql`UPDATE assistant_actions SET status = 'approved', decided_by_user_id = app.user_id(), decided_at = now() WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx));
const execute = (actionId: string) => as(sys(), (tx) => sql`UPDATE assistant_actions SET status = 'executed' WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx));

describe('M53 platform:gbp gate on reviews and publications (R-GBP-3)', () => {
  it('R-GBP-3: platform:gbp ships published and unreviewed, with counsel-only notes', async () => {
    const [p] = await suRows<{ status: string; reviewed_by_counsel_at: Date | null; rules: object; notes: string }>(h.su, "SELECT status, reviewed_by_counsel_at, rules, notes FROM jurisdiction_packs WHERE key = 'platform:gbp'");
    expect(p).toMatchObject({ status: 'published', reviewed_by_counsel_at: null, rules: {} });
    expect(p!.notes).toMatch(/Not covered by owner attestation D11\. VERIFY WITH COUNSEL \(C15\)\./);
  });

  it('E460 R-GBP-3: with every pack unreviewed, and with D11\'s seven packs recorded, no review row can exist (GBP_NOT_CLEARED)', async () => {
    await resetPacks();
    await expect(insertReview()).rejects.toThrow(/GBP_NOT_CLEARED/);
    await review(D11, true);
    try {
      await expect(insertReview()).rejects.toThrow(/GBP_NOT_CLEARED/);
      expect((await suRows(h.su, 'SELECT 1 FROM gbp_reviews WHERE tenant_id = $1', [w.tenantId])).length).toBe(0);
    } finally {
      await resetPacks();
    }
  });

  it('E460 R-GBP-3 R-MKT-12: the database refuses a gbp_location publication until platform:gbp is reviewed, even with D11\'s packs recorded; the 0054 guard still refuses first', async () => {
    const listing = uuid();
    const gbpPiece = uuid();
    const socialPiece = uuid();
    await suFixture(h.su, `INSERT INTO listings (tenant_id, id, status, address_line1, city, region, postal_code, listing_agent_user_id) VALUES ($1, $2, 'active', '1 Example St', 'Exampleton', 'NY', '10001', $3)`, [w.tenantId, listing, X.id]);
    for (const [id, kind] of [[gbpPiece, 'gbp_post'], [socialPiece, 'social_post']] as const) {
      await suFixture(h.su, `INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, status, prose, template_key, content_sha256, guard_result, approved_at, approved_by_user_id)
                             VALUES ($1, $2, $3, $4, 1, 'approved', '{}', 'starter', $5, $6::jsonb, now(), $7)`,
        [w.tenantId, id, listing, kind, 'a'.repeat(64), JSON.stringify({ content_sha256: 'a'.repeat(64), brokerage_name_present: true, hard_count: 0, pack_rule_failures: [] }), X.id]);
    }
    const publish = (piece: string, conn: string) =>
      as(w.owner.actor, (tx) => sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id) VALUES (app.tenant_id(), ${uuid()}, ${piece}, ${conn}, app.user_id())`.execute(tx));
    await resetPacks();
    // the guard's own refusals come first: fair housing, then the pairing
    await expect(publish(gbpPiece, gbpConn)).rejects.toThrow(/PLATFORM_NOT_CLEARED: publishing waits for counsel review of the platform:fair_housing pack/);
    await review(D11, true);
    try {
      await expect(publish(socialPiece, gbpConn)).rejects.toThrow(/PUBLISH_TARGET_INVALID/);
      await expect(publish(gbpPiece, gbpConn)).rejects.toThrow(/^PLATFORM_NOT_CLEARED: publishing to a Google Business Profile location waits for counsel review of the platform:gbp pack/);
      // a Meta target never waits on platform:gbp
      await publish(socialPiece, fbConn);
      await review(['platform:gbp'], true);
      await publish(gbpPiece, gbpConn);
      expect((await suRows(h.su, "SELECT count(*)::int AS n FROM marketing_publications WHERE tenant_id = $1 AND status = 'publishing'", [w.tenantId]))[0]).toEqual({ n: 2 });
      // fair housing uncleared again: refused by the 0054 guard although platform:gbp is reviewed (both refuse independently)
      await review(['platform:fair_housing'], false);
      await suFixture(h.su, "UPDATE marketing_publications SET status = 'failed', error_code = 'X' WHERE tenant_id = $1", [w.tenantId]);
      await expect(publish(gbpPiece, gbpConn)).rejects.toThrow(/platform:fair_housing/);
    } finally {
      await resetPacks();
    }
  });
});

describe('M53 app.gbp_reviews_guard (R-GBP-4, R-GBP-5)', () => {
  beforeAll(async () => {
    await review(['platform:gbp'], true);
  });
  afterAll(async () => {
    await resetPacks();
  });

  it('R-GBP-3: a review is stored only by the system, only for a connected GBP location of the tenant, born needing a reply or replied at Google, with no draft', async () => {
    await expect(insertReview({ conn: gbpDown })).rejects.toThrow(/CHANNEL_NOT_CONNECTED/);
    await expect(insertReview({ conn: fbConn })).rejects.toThrow(/CHANNEL_NOT_CONNECTED/);
    await expect(insertReview({ status: 'drafted', action: await draftFor(uuid()) })).rejects.toThrow(/GBP_REPLY_STATE/);
    await expect(insertReview({ status: 'none', action: await draftFor(uuid()) })).rejects.toThrow(/GBP_REPLY_STATE/);
    expect(await reviewRow(await insertReview({ status: 'replied' }))).toMatchObject({ reply_status: 'replied', reply_action_id: null });
    // a person never writes reviews (members read, the system writes)
    await expect(as(w.owner.actor, (tx) => sql`INSERT INTO gbp_reviews (tenant_id, id, connection_id, external_review_id, rating, reviewed_at) VALUES (app.tenant_id(), ${uuid()}, ${gbpConn}, 'x', 5, now())`.execute(tx))).rejects.toThrow(/row-level security/);
    // another tenant's system cannot store a review for this tenant's location
    await expect(as(other.system('provider'), (tx) => sql`INSERT INTO gbp_reviews (tenant_id, id, connection_id, external_review_id, rating, reviewed_at) VALUES (app.tenant_id(), ${uuid()}, ${gbpConn}, 'x', 5, now())`.execute(tx))).rejects.toThrow(/CHANNEL_NOT_CONNECTED|foreign key/);
  });

  it('R-GBP-5: a review keeps its location, Google id and creation time; its rating, text, reviewer and time follow Google', async () => {
    const id = await insertReview();
    await expect(setReview(id, sql`connection_id = ${gbpDown}`)).rejects.toThrow(/GBP_REVIEW_IMMUTABLE/);
    await expect(setReview(id, sql`external_review_id = 'another'`)).rejects.toThrow(/GBP_REVIEW_IMMUTABLE/);
    await expect(setReview(id, sql`created_at = now() - interval '1 day'`)).rejects.toThrow(/GBP_REVIEW_IMMUTABLE/);
    await setReview(id, sql`rating = 2, body = 'Edited at Google.', reviewer_display = 'Reviewer B', reviewed_at = now()`);
    expect((await reviewRow(id)).rating).toBe(2);
  });

  it('E467 R-GBP-5: a review removed at Google keeps no rating, text or reviewer; a removed review takes no new draft', async () => {
    const id = await insertReview();
    await expect(setReview(id, sql`rating = NULL`)).rejects.toThrow(/GBP_REVIEW_IMMUTABLE/);
    await expect(setReview(id, sql`rating = NULL, body = NULL`)).rejects.toThrow(/GBP_REVIEW_IMMUTABLE/);
    await setReview(id, sql`rating = NULL, body = NULL, reviewer_display = NULL`);
    const a = await draftFor(id);
    await expect(setReview(id, sql`reply_status = 'drafted', reply_action_id = ${a}`)).rejects.toThrow(/GBP_REPLY_STATE: a review removed at Google takes no reply/);
  });

  it('R-GBP-4: drafted names a proposed or approved review_reply_draft of this very review, only while platform:gbp is reviewed', async () => {
    const id = await insertReview();
    await expect(setReview(id, sql`reply_status = 'drafted'`)).rejects.toThrow(/GBP_REPLY_STATE/);
    await expect(setReview(id, sql`reply_status = 'drafted', reply_action_id = ${await draftFor(uuid())}`)).rejects.toThrow(/GBP_REPLY_STATE: the draft must be a review reply draft of this review/);
    // an owner-less action of another kind (an ad shift, lane 52) naming this review is still not a reply draft
    await expect(setReview(id, sql`reply_status = 'drafted', reply_action_id = ${await draftFor(id, 'ad_reallocation')}`)).rejects.toThrow(/GBP_REPLY_STATE/);
    const rejected = await draftFor(id);
    await as(w.owner.actor, (tx) => sql`UPDATE assistant_actions SET status = 'rejected', decided_by_user_id = app.user_id(), decided_at = now() WHERE id = ${rejected}`.execute(tx));
    await expect(setReview(id, sql`reply_status = 'drafted', reply_action_id = ${rejected}`)).rejects.toThrow(/GBP_REPLY_STATE: a drafted review names a draft that is waiting or being posted/);
    const a1 = await draftFor(id);
    await review(['platform:gbp'], false);
    await expect(setReview(id, sql`reply_status = 'drafted', reply_action_id = ${a1}`)).rejects.toThrow(/GBP_NOT_CLEARED/);
    await review(['platform:gbp'], true);
    await setReview(id, sql`reply_status = 'drafted', reply_action_id = ${a1}`);
    // drafted → drafted: a new draft supersedes the old one
    const a2 = await draftFor(id);
    await setReview(id, sql`reply_action_id = ${a2}`);
    await expect(setReview(id, sql`reply_action_id = NULL`)).rejects.toThrow(/GBP_REPLY_STATE: a drafted review names its draft/);
    // drafted → replied only once the action executed (Google confirmed)
    await approve(a2);
    await expect(setReview(id, sql`reply_status = 'replied'`)).rejects.toThrow(/GBP_REPLY_STATE: a reply counts as posted only after Google confirmed it/);
    await execute(a2);
    await setReview(id, sql`reply_status = 'replied'`);
    expect(await reviewRow(id)).toMatchObject({ reply_status: 'replied', reply_action_id: a2 });
    // replied → drafted is not a move; replied → none (the reply was deleted at Google)
    await expect(setReview(id, sql`reply_status = 'drafted', reply_action_id = ${await draftFor(id)}`)).rejects.toThrow(/GBP_REPLY_STATE: replied cannot become drafted/);
    await expect(setReview(id, sql`reply_status = 'none'`)).rejects.toThrow(/GBP_REPLY_STATE: a review that needs a reply names no draft/);
    await setReview(id, sql`reply_status = 'none', reply_action_id = NULL`);
    // none → replied (outside Realty OS); drafted → none
    await setReview(id, sql`reply_status = 'replied'`);
    const id2 = await insertReview();
    await setReview(id2, sql`reply_status = 'drafted', reply_action_id = ${await draftFor(id2)}`);
    await setReview(id2, sql`reply_status = 'none', reply_action_id = NULL`);
    expect(await reviewRow(id2)).toMatchObject({ reply_status: 'none', reply_action_id: null });
  });

  it('R-GBP-4: when a drafted review\'s action is deleted, the FK\'s SET NULL is let through and the review needs a reply again', async () => {
    const id = await insertReview();
    const a = await draftFor(id);
    await setReview(id, sql`reply_status = 'drafted', reply_action_id = ${a}`);
    // nothing deletes assistant actions today (no DELETE grant to app_user): the superuser stands in
    await h.su.query('DELETE FROM assistant_actions WHERE id = $1', [a]);
    expect(await reviewRow(id)).toMatchObject({ reply_status: 'none', reply_action_id: null });
  });
});

// ---- M54: app.coaching_trends ------------------------------------------------------------------------------------

const ZONE = 'America/New_York';
type St = 'met' | 'missed' | 'needs_review' | 'not_applicable';

/** an instant on the Tuesday of the local week `weeksAgo` weeks before this one (1 = last week) */
async function inWeek(weeksAgo: number, hour = 10): Promise<string> {
  const r = await suRows<{ t: Date }>(h.su, `SELECT ((date_trunc('week', now() AT TIME ZONE $1) - make_interval(weeks => $2) + interval '1 day' + make_interval(hours => $3)) AT TIME ZONE $1) AS t`, [ZONE, weeksAgo, hour]);
  return r[0]!.t.toISOString();
}

/** One scored call: the call, its recording and its call_scores row (fixtures: no application path in this package). */
async function scored(tenantId: string, agent: string, at: string, items: Record<string, St>, o: { version?: string; shredded?: boolean } = {}): Promise<string> {
  const call = uuid();
  const contact = uuid();
  const list = Object.entries(items).map(([key, status]) => ({ key, status, claim_id: null }));
  const met = list.filter((i) => i.status === 'met').length;
  const n = list.filter((i) => i.status === 'met' || i.status === 'missed').length;
  await suFixture(h.su, `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, status, started_at, recording_mode, recording_decision)
                         VALUES ($1, $2, $3, $4, 'outbound', $5, '+15550100', 'human', 'completed', $6, 'announced_all_parties', '{}')`, [tenantId, call, uuid(), contact, agent, at]);
  await suFixture(h.su, `INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, object_id, source, consent_basis, status, retain_until, shredded_at)
                         VALUES ($1, $2, $3, $4, $5, $6, 'provider', 'announced_all_parties', $7, now() + interval '1 year', ${o.shredded ? 'now()' : 'NULL'})`, [tenantId, uuid(), call, contact, agent, o.shredded ? null : uuid(), o.shredded ? 'shredded' : 'stored']);
  await suFixture(h.su, `INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count)
                         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`, [tenantId, call, o.version ?? 'rubric/1', agent, contact, JSON.stringify(list), met, n]);
  return call;
}

interface TrendRow { agent_user_id: string | null; window_kind: string; window_start: string; window_end: string; item_key: string; scored: number; met: number | null; calls: number }
const trends = (actor: Actor, ids: readonly string[], weeks = 1, version = 'rubric/1') =>
  as(actor, async (tx) => (await sql<TrendRow>`SELECT agent_user_id, window_kind, to_char(window_start, 'YYYY-MM-DD') AS window_start, to_char(window_end, 'YYYY-MM-DD') AS window_end, item_key, scored, met, calls
                                                FROM app.coaching_trends(${[...ids]}::uuid[], ${weeks}, ${version}) ORDER BY agent_user_id NULLS LAST, window_kind, item_key`.execute(tx)).rows);
const cell = (rows: TrendRow[], who: string | null, kind: string, key: string) => rows.find((r) => r.agent_user_id === who && r.window_kind === kind && r.item_key === key);
const setScoring = (on: boolean, tlSees = false) =>
  as(w.owner.actor, (tx) => sql`UPDATE tenant_settings SET call_scoring_enabled = ${on}, tl_sees_call_scores = ${tlSees} WHERE tenant_id = app.tenant_id()`.execute(tx));

describe('M54 app.coaching_trends: aggregate-only weekly trends (R-COACH-7, R-COACH-8)', () => {
  beforeAll(async () => {
    await review(['platform:coaching'], true);
    await setScoring(true);
    // last week: X 6 scored (4 met, 2 missed) on asked_timeline; Y 3 (all met)
    for (const s of ['met', 'met', 'met', 'met', 'missed', 'missed'] as St[]) await scored(w.tenantId, X.id, await inWeek(1), { asked_timeline: s, recapped_call: 'needs_review' });
    for (let i = 0; i < 3; i++) await scored(w.tenantId, Y.id, await inWeek(1), { asked_timeline: 'met' });
    // two weeks ago: X 2 (a 1-4 cell)
    for (let i = 0; i < 2; i++) await scored(w.tenantId, X.id, await inWeek(2), { asked_timeline: 'met' });
    // never counted: another rubric version, a shredded recording, this week (unfinished), another tenant's row naming X
    await scored(w.tenantId, X.id, await inWeek(1), { asked_timeline: 'missed' }, { version: 'rubric/2' });
    await scored(w.tenantId, X.id, await inWeek(1), { asked_timeline: 'missed' }, { shredded: true });
    await scored(w.tenantId, X.id, await inWeek(0, 0), { asked_timeline: 'missed' });
    await suFixture(h.su, 'SELECT 1'); // keep the fixture pool warm
    for (let i = 0; i < 5; i++) await scored(other.tenantId, X.id, await inWeek(1), { asked_timeline: 'missed' });
  });
  afterAll(async () => {
    await setScoring(false).catch(() => undefined);
    await resetPacks();
  });

  it('R-COACH-7 R-COACH-8: counts only per member, window and item: scored = met + missed, met, distinct reviewed calls; only this version, live recordings, this tenant, whole past weeks', async () => {
    const rows = await trends(X.actor, [X.id]);
    expect(cell(rows, X.id, 'after', 'asked_timeline')).toMatchObject({ scored: 6, met: 4, calls: 6 });
    // needs_review leaves the n (R-COACH-2): the item has calls but nothing scored
    expect(cell(rows, X.id, 'after', 'recapped_call')).toMatchObject({ scored: 0, met: null, calls: 6 });
    expect(cell(rows, X.id, 'before', 'asked_timeline')).toMatchObject({ scored: 2, met: null, calls: 2 });
    expect(rows.every((r) => r.agent_user_id === X.id)).toBe(true); // one id: no group row
    // the two windows are whole local weeks, Monday to Sunday, the later one ending before this week
    const after = cell(rows, X.id, 'after', 'asked_timeline')!;
    const before = cell(rows, X.id, 'before', 'asked_timeline')!;
    expect(new Date(`${after.window_start}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${after.window_end}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(Date.parse(`${after.window_start}T00:00:00Z`) - Date.parse(`${before.window_start}T00:00:00Z`)).toBe(7 * 86_400_000);
    // the columns are counts only
    expect(Object.keys(rows[0]!).sort()).toEqual(['agent_user_id', 'calls', 'item_key', 'met', 'scored', 'window_end', 'window_kind', 'window_start']);
  });

  it('E473 R-COACH-8: met is withheld below 5 scored, and in anyone else\'s trend for any cell of 1-4; the caller\'s own trend needs only 5', async () => {
    // self: Y has 3 → withheld
    expect(cell(await trends(Y.actor, [Y.id]), Y.id, 'after', 'asked_timeline')).toMatchObject({ scored: 3, met: null });
    // the Owner: X's last week is one cell of 6 → shown
    const o1 = await trends(w.owner.actor, [X.id, Y.id]);
    expect(cell(o1, X.id, 'after', 'asked_timeline')).toMatchObject({ scored: 6, met: 4 });
    expect(cell(o1, Y.id, 'after', 'asked_timeline')).toMatchObject({ scored: 3, met: null });
    // the group (9 scored) contains Y's cell of 3 → withheld, so {X,Y} minus {X} reveals nothing about Y
    expect(cell(o1, null, 'after', 'asked_timeline')).toMatchObject({ scored: 9, met: null, calls: 9 });
    expect(cell(await trends(w.owner.actor, [X.id]), X.id, 'after', 'asked_timeline')!.met).toBe(4);
    // weeks = 2: X's after window holds the cell of 2 (two weeks ago) → withheld for the Owner, so weeks 2 minus
    // weeks 1 reveals nothing about that week; X still reads their own (8 scored)
    expect(cell(await trends(w.owner.actor, [X.id], 2), X.id, 'after', 'asked_timeline')).toMatchObject({ scored: 8, met: null });
    expect(cell(await trends(X.actor, [X.id], 2), X.id, 'after', 'asked_timeline')).toMatchObject({ scored: 8, met: 6 });
  });

  it('E472 R-COACH-8: a Team Lead reads their team\'s trends only while the Owner\'s switch is on, never a member outside their team', async () => {
    await setScoring(true, false);
    expect(await trends(tl.actor, [tl.id])).toEqual([]); // their own: allowed (no data)
    await expect(trends(tl.actor, [X.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(tl.actor, [tl.id, X.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await setScoring(true, true);
    try {
      expect(cell(await trends(tl.actor, [X.id, Y.id]), null, 'after', 'asked_timeline')).toMatchObject({ scored: 9, met: null });
      // a member who leaves the Team Lead's team leaves their reach
      await suFixture(h.su, 'DELETE FROM team_members WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, Y.id]);
      try {
        await expect(trends(tl.actor, [X.id, Y.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
        await expect(trends(tl.actor, [Y.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
      } finally {
        await suFixture(h.su, 'INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES ($1, $2, $3, false)', [w.tenantId, w.teamId, Y.id]);
      }
    } finally {
      await setScoring(true, false);
    }
  });

  it('R-COACH-8: an agent reads only their own; support, the system and a TC are refused; the ids, weeks and version are checked; the whole call is refused', async () => {
    await expect(trends(X.actor, [Y.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(X.actor, [X.id, Y.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(support, [X.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(w.system('worker'), [X.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(tc.actor, [tc.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    for (const weeks of [0, 5, -1]) await expect(trends(X.actor, [X.id], weeks)).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(X.actor, [X.id], 1, 'v1')).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(w.owner.actor, [])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(w.owner.actor, [X.id, X.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    await expect(trends(w.owner.actor, [X.id, other.owner.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/); // another tenant's member
    await expect(trends(w.owner.actor, Array.from({ length: 201 }, () => uuid()))).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    // another tenant's Owner asking for this tenant's member is refused (not a member there)
    await expect(trends(other.owner.actor, [X.id])).rejects.toThrow(/COACHING_TRENDS_SCOPE/);
    // EXECUTE: app_user only (never PUBLIC)
    const [g] = await suRows<{ pub: boolean; app: boolean }>(h.su, "SELECT has_function_privilege('public', 'app.coaching_trends(uuid[],integer,text)', 'EXECUTE') AS pub, has_function_privilege('app_user', 'app.coaching_trends(uuid[],integer,text)', 'EXECUTE') AS app");
    expect(g).toEqual({ pub: false, app: true });
  });

  it('R-COACH-7 R-INT-6: zero rows while platform:coaching is uncleared or call scoring is off', async () => {
    await review(['platform:coaching'], false);
    expect(await trends(w.owner.actor, [X.id])).toEqual([]);
    expect(await trends(X.actor, [X.id])).toEqual([]);
    await review(['platform:coaching'], true);
    await setScoring(false);
    expect(await trends(w.owner.actor, [X.id])).toEqual([]);
    await setScoring(true);
    expect((await trends(w.owner.actor, [X.id])).length).toBeGreaterThan(0);
  });

  it('E474 R-COACH-7: windows are whole local weeks from Monday 00:00, across a DST change and a year boundary', async () => {
    const bounds = (now: string, zone: string, weeks: number) =>
      suRows<{ window_kind: string; starts_at: Date; ends_at: Date; first_day: string; last_day: string }>(h.su,
        `SELECT window_kind, starts_at, ends_at, to_char(first_day, 'YYYY-MM-DD') AS first_day, to_char(last_day, 'YYYY-MM-DD') AS last_day FROM app.coaching_trend_bounds($1::timestamptz, $2, $3) ORDER BY window_kind DESC`, [now, zone, weeks]);
    // Wednesday 2026-11-04 12:00 New York: after = Oct 26 - Nov 1, which holds the fall-back change (Nov 1, 02:00)
    const [b1, a1] = await bounds('2026-11-04T17:00:00Z', 'America/New_York', 1);
    expect(a1).toMatchObject({ window_kind: 'after', first_day: '2026-10-26', last_day: '2026-11-01' });
    expect(a1!.starts_at.toISOString()).toBe('2026-10-26T04:00:00.000Z'); // midnight EDT
    expect(a1!.ends_at.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // midnight EST: the week is 169 hours long
    expect(b1).toMatchObject({ window_kind: 'before', first_day: '2026-10-19', last_day: '2026-10-25' });
    expect(b1!.ends_at.toISOString()).toBe(a1!.starts_at.toISOString());
    // Monday 2027-01-04 00:30 local: this week starts now; after = Dec 28 - Jan 3 (crosses the year), before = Dec 21 - 27
    const [b2, a2] = await bounds('2027-01-04T05:30:00Z', 'America/New_York', 1);
    expect(a2).toMatchObject({ first_day: '2026-12-28', last_day: '2027-01-03' });
    expect(b2).toMatchObject({ first_day: '2026-12-21', last_day: '2026-12-27' });
    // a week of 2027-W53 style edge: Sunday 2027-01-03 23:30 local still belongs to the week of Dec 28
    const [, a3] = await bounds('2027-01-04T04:30:00Z', 'America/New_York', 2);
    expect(a3).toMatchObject({ first_day: '2026-12-14', last_day: '2026-12-27' });
    // spring forward (2027-03-14 02:00 New York): the week of Mar 8 is 167 hours long
    const [, a4] = await bounds('2027-03-17T12:00:00Z', 'America/New_York', 1);
    expect(a4!.ends_at.getTime() - a4!.starts_at.getTime()).toBe(167 * 3_600_000);
    // another zone: the boundary is that zone's midnight
    const [, a5] = await bounds('2026-11-04T17:00:00Z', 'Pacific/Auckland', 1);
    expect(a5!.starts_at.toISOString()).toBe('2026-10-25T11:00:00.000Z');
  });
});
