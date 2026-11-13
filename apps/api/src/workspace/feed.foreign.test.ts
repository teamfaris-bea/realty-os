// Phase 2/3 feed cards over real Postgres as app_user (module 18a; PHASE2_3_PLAN §5.3/§5.4; R-PRED-5, E144,
// R-TXN-2, E158).
//
// Accept: a module adds a card by writing ONE priority_feed_items row under its key family, with no edit to
// the scorer. The owning modules (28, 29, 33, 36, 50) are not built yet, so the superuser writes the row
// exactly as such a module would (and the platform-only prediction_models / system-only contact_predictions
// rows). Everything is then read through the normal agent feed path (GET /feed as the agent, RLS-bound).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { foreignActions, isManagedKey } from './feed.js';
import { call, contactOf, type FeedCardT, feedOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;

/** One card row, written the way an owning module writes it (its own key family, ≥ 1 reason). */
async function writeCard(o: { userId: string | null; itemType: string; key: string; contactId?: string | null; subjectType: string; subjectId: string | null; reasons: { code: string; label: string }[] }): Promise<string> {
  if (o.userId === null || o.subjectId === null) throw new Error('a feed card belongs to a member and has a subject');
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, due_at, score, score_version, reasons, dedupe_key)
     VALUES ($1, $2, $3, $4, 'scored', $5, $6, $7, NULL, 40, 1, $8::jsonb, $9)`,
    [w.tenantId, id, o.userId, o.itemType, o.contactId ?? null, o.subjectType, o.subjectId, JSON.stringify(o.reasons), o.key],
  );
  return id;
}

async function listingOf(c: (typeof w.agents)[number]): Promise<string> {
  const r = await call<{ listing: { id: string } }>(c, 'POST', '/listings', { status: 'active', addressLine1: `${Math.floor(Math.random() * 900) + 100} Oak St`, city: 'Oakland', region: 'CA', postalCode: '94610', listPriceCents: 85000000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family' });
  expect(r.status).toBe(201);
  return r.body.listing.id;
}

/** A draft marketing piece of a team listing (module 29 is not built: the superuser writes the row). */
async function pieceOf(listingId: string): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, status, prose, template_key, content_sha256, guard_result)
     VALUES ($1, $2, $3, 'social_post', 1, 'draft', '{"headline":"Open Saturday"}', 'social.v1', repeat('0', 64), '{}')`,
    [w.tenantId, id, listingId],
  );
  return id;
}

let modelSeq = 0;
/** A platform-released model (prediction_models is written by the platform only) and its band for a contact. */
async function prediction(contactId: string, band: 'likely_90d' | 'watch' | 'none' = 'likely_90d'): Promise<string> {
  modelSeq += 1;
  const version = `predict/1.${modelSeq}`;
  await h.su.query(
    `INSERT INTO prediction_models (version, status, features, counsel_reviewed_at, backtest_flagged, backtest_transacted, backtest_window_days, backtest_dataset)
     VALUES ($1, 'approved', ARRAY['years_in_home','recent_saves'], now(), 120, 31, 90, 'platform back-test 2025')`,
    [version],
  );
  await h.su.query(
    `INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
     VALUES ($1, $2, $3, $4, $5::jsonb, repeat('a', 64), current_date)`,
    [w.tenantId, contactId, version, band, JSON.stringify(band === 'none' ? [] : [{ feature: 'years_in_home', points: 20, evidence: 'In the home 11 years' }])],
  );
  return version;
}

const setModel = (version: string, status: 'approved' | 'withdrawn') => h.su.query('UPDATE prediction_models SET status = $2 WHERE version = $1', [version, status]);
const cardOf = async (c: (typeof w.agents)[number], id: string): Promise<FeedCardT | undefined> => (await feedOf(c)).all.find((x) => x.id === id);

describe('Phase 2/3 cards: the key-family extension point', () => {
  it('a module adds a card by writing one row under its key family; each of the five types comes back with its label source (reasons) and a one-tap action, and the scorer leaves it alone', async () => {
    const a = agent();
    const listingId = await listingOf(a);
    const pieceId = await pieceOf(listingId);
    const seller = await contactOf(a, { firstName: 'Sam' });
    const lena = await contactOf(a, { firstName: 'Lena' });
    const version = await prediction(lena.id);
    const ids = {
      seller_update: await writeCard({ userId: a.userId, itemType: 'seller_update', key: `seller_update:${listingId}:2026-11-09`, contactId: seller.id, subjectType: 'listing', subjectId: listingId, reasons: [{ code: 'SELLER_UPDATE_READY', label: 'This week’s update for 12 Oak St is ready to review' }] }),
      marketing_review: await writeCard({ userId: a.userId, itemType: 'marketing_review', key: `marketing:${pieceId}`, subjectType: 'marketing_piece', subjectId: pieceId, reasons: [{ code: 'MARKETING_DRAFT', label: 'A social post draft is ready for your review' }] }),
      weekly_plan: await writeCard({ userId: a.userId, itemType: 'weekly_plan', key: `weekly_plan:${a.userId}:2026-W46`, subjectType: 'user', subjectId: a.userId, reasons: [{ code: 'PLAN_ITEM', label: 'Call back the 3 leads from last weekend' }, { code: 'PLAN_ITEM', label: 'Log outcomes for 2 consults' }] }),
      coaching_fix: await writeCard({ userId: a.userId, itemType: 'coaching_fix', key: `coaching_fix:${a.userId}:2026-11-11`, subjectType: 'user', subjectId: a.userId, reasons: [{ code: 'COACHING_FIX', label: 'Ask about their timeline before the price' }] }),
      likely_to_move: await writeCard({ userId: a.userId, itemType: 'likely_to_move', key: `likely:${lena.id}:${version}`, contactId: lena.id, subjectType: 'contact', subjectId: lena.id, reasons: [{ code: 'LIKELY_YEARS_IN_HOME', label: 'In the home 11 years' }] }),
    };
    for (const key of [`seller_update:${listingId}:2026-11-09`, `marketing:${pieceId}`, `weekly_plan:${a.userId}:2026-W46`, `coaching_fix:${a.userId}:2026-11-11`, `likely:${lena.id}:${version}`]) expect(isManagedKey(key)).toBe(false);

    for (let refresh = 0; refresh < 2; refresh += 1) {
      const f = await feedOf(a); // every GET /feed re-runs the scorer: the rows stay open and unchanged
      const by = (id: string) => f.all.find((c) => c.id === id)!;
      expect(by(ids.seller_update)).toMatchObject({ itemType: 'seller_update', primaryAction: { kind: 'open_listing', label: 'Open listing', listingId }, contact: { id: seller.id } });
      expect(by(ids.marketing_review)).toMatchObject({ itemType: 'marketing_review', primaryAction: { kind: 'open_listing', listingId }, contact: null });
      expect(by(ids.weekly_plan)).toMatchObject({ itemType: 'weekly_plan', primaryAction: { kind: 'open_plan', label: 'See the plan', week: '2026-W46' }, alternatives: [] });
      expect(by(ids.weekly_plan).reasons.map((r) => r.label)).toEqual(['Call back the 3 leads from last weekend', 'Log outcomes for 2 consults']);
      expect(by(ids.coaching_fix)).toMatchObject({ itemType: 'coaching_fix', primaryAction: { kind: 'open_coaching_fix', label: 'See the tip' } }); // module 40: the card links to the daily fix page
      expect(by(ids.likely_to_move)).toMatchObject({ itemType: 'likely_to_move', primaryAction: { kind: 'open_contact', label: 'Open contact', contactId: lena.id }, alternatives: [] });
      expect(JSON.stringify(f)).not.toMatch(/confidence|probability|"score"|"points"/i);
    }
    const states = await h.su.query('SELECT state FROM priority_feed_items WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
    expect(states.rows.map((r) => r.state)).toEqual(Object.values(ids).map(() => 'open'));

    // the agent's own Done closes one for good; another agent never sees them (own rows only)
    expect((await call(a, 'POST', `/feed/${ids.coaching_fix}/done`)).status).toBe(200);
    expect(await cardOf(a, ids.coaching_fix)).toBeUndefined();
    const other = w.agents[1]!;
    expect((await feedOf(other)).all.some((c) => Object.values(ids).includes(c.id))).toBe(false);
  });

  it('foreignActions: a marketing card whose piece the caller cannot see opens its details, a key of the wrong family keeps the Phase 1 fallback', () => {
    const piece = randomUUID();
    expect(foreignActions({ item_type: 'marketing_review', dedupe_key: `marketing:${piece}`, contact_id: null, subject_type: 'marketing_piece', subject_id: piece, assistant_action_id: null, piece_listing_id: null }).primaryAction).toEqual({ kind: 'show_details', label: 'See details' });
    const c = randomUUID();
    expect(foreignActions({ item_type: 'likely_to_move', dedupe_key: `likely:${c}`, contact_id: c, subject_type: 'contact', subject_id: c, assistant_action_id: null }).primaryAction).toEqual({ kind: 'open_contact', label: 'Open', contactId: c });
  });

  it('batch 13 isa-4 (b12 recheck R11 follow-up): an AI handoff card is no draft: its tap opens the thread with no draft=, never edit_draft "Review"', () => {
    const c = randomUUID();
    const action = randomUUID();
    const a = foreignActions({ item_type: 'ai_isa_handoff', dedupe_key: `ai_isa_handoff:${randomUUID()}`, contact_id: c, subject_type: 'ai_isa_handoff', subject_id: randomUUID(), assistant_action_id: action });
    expect(a.primaryAction).toEqual({ kind: 'text', label: 'Open thread', contactId: c });
    expect(JSON.stringify(a)).not.toContain(action);
    expect(a.alternatives).toEqual([{ kind: 'open_contact', label: 'Open', contactId: c }]);
    // any other card with an assistant action keeps the Phase 1 Review
    expect(foreignActions({ item_type: 'assistant_draft', dedupe_key: `x:${c}`, contact_id: c, subject_type: 'contact', subject_id: c, assistant_action_id: action }).primaryAction).toEqual({ kind: 'edit_draft', label: 'Review', actionId: action });
  });
});

describe('R-PRED-5 likely_to_move (card read path)', () => {
  it('E144 / R-PRED-5: a likely_to_move card disappears from the feed the moment its model is withdrawn, and comes back only when it is approved again', async () => {
    const a = agent();
    const c = await contactOf(a, { firstName: 'Ravi' });
    const version = await prediction(c.id);
    const id = await writeCard({ userId: a.userId, itemType: 'likely_to_move', key: `likely:${c.id}:${version}`, contactId: c.id, subjectType: 'contact', subjectId: c.id, reasons: [{ code: 'LIKELY_YEARS_IN_HOME', label: 'In the home 11 years' }] });
    expect(await cardOf(a, id)).toBeDefined();
    await setModel(version, 'withdrawn');
    expect(await cardOf(a, id)).toBeUndefined();
    // the row is untouched (hidden, not closed): visibility is the policy's, not a write
    expect((await h.su.query('SELECT state FROM priority_feed_items WHERE id = $1', [id])).rows[0].state).toBe('open');
    await setModel(version, 'approved');
    expect(await cardOf(a, id)).toBeDefined();
  });

  it('R-PRED-5: a card made with a withdrawn model stays hidden even while ANOTHER approved model flags the same contact; a "none" band shows no card', async () => {
    const a = agent();
    const c = await contactOf(a, { firstName: 'Mina' });
    const old = await prediction(c.id);
    const current = await prediction(c.id);
    const oldCard = await writeCard({ userId: a.userId, itemType: 'likely_to_move', key: `likely:${c.id}:${old}`, contactId: c.id, subjectType: 'contact', subjectId: c.id, reasons: [{ code: 'LIKELY_YEARS_IN_HOME', label: 'In the home 11 years' }] });
    await setModel(old, 'withdrawn');
    const f = await feedOf(a);
    expect(f.all.some((x) => x.id === oldCard)).toBe(false);
    // the newer model's own card is shown
    const newCard = await writeCard({ userId: a.userId, itemType: 'likely_to_move', key: `likely:${c.id}:${current}`, contactId: c.id, subjectType: 'contact', subjectId: c.id, reasons: [{ code: 'LIKELY_YEARS_IN_HOME', label: 'In the home 11 years' }] });
    expect(await cardOf(a, newCard)).toBeDefined();
    // a contact whose only prediction is "none" never shows a card
    const z = await contactOf(a, { firstName: 'Zoe' });
    const none = await prediction(z.id, 'none');
    const zCard = await writeCard({ userId: a.userId, itemType: 'likely_to_move', key: `likely:${z.id}:${none}`, contactId: z.id, subjectType: 'contact', subjectId: z.id, reasons: [{ code: 'LIKELY', label: 'x' }] });
    expect(await cardOf(a, zCard)).toBeUndefined();
  });
});

describe('R-TXN-2 deal-date cards', () => {
  it('E158 / R-TXN-2: a proposed (unconfirmed) date due tomorrow gets no reminder card; a confirmed one does', async () => {
    const a = agent();
    const c = await contactOf(a, { firstName: 'Ana' });
    const d = await call<{ deal: { id: string } }>(a, 'POST', '/deals', { primaryContactId: c.id, side: 'buy' });
    expect(d.status).toBe(201);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const dd = await call<{ date: { id: string } }>(a, 'POST', `/deals/${d.body.deal.id}/dates`, { kind: 'inspection', dueOn: tomorrow });
    expect(dd.status).toBe(201);
    const dateId = dd.body.date.id;
    // a date the agent typed is a person's confirmed fact: it is reminded
    expect((await feedOf(a)).all.some((x) => x.itemType === 'deal_date' && x.subjectId === dateId)).toBe(true);
    // module 31 (template proposals) is not built: the superuser turns it into what a template proposal is
    await h.su.query(`UPDATE deal_dates SET source = 'template', status = 'proposed' WHERE id = $1`, [dateId]);
    expect((await feedOf(a)).all.some((x) => x.itemType === 'deal_date' && x.subjectId === dateId)).toBe(false);
  });
});
