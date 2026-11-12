// Review reply drafts and one-tap replies (module 53) through the API: real Postgres, the deterministic FakeGbp and
// FakeAi; nothing leaves the process. DATA_MODEL R-GBP-1, R-GBP-4; E132, E133, E464, E465, E466, E469, E471.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { syncReviews } from './sync.js';
import { rawReview } from './testing.js';
import * as S from './schemas.js';
import { type GbpWorld, call, gbpWorld, jobCtx, makeDue, resetFake, resetPacks, setPacks, syncDeps } from './testing/world.js';

let h: ApiHarness;
let w: GbpWorld;
const fake = () => h.providers.gbp;
type Review = z.infer<typeof S.ReviewSchema>;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await gbpWorld(h);
  await setPacks(h, ['platform:gbp', 'platform:fair_housing'], true);
  await h.su.query('UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1', [w.tenantId]);
}, 180_000);
afterAll(async () => {
  await resetPacks(h).catch(() => undefined);
  await h?.close();
});
beforeEach(() => resetFake(fake()));

const sync = async () => {
  await makeDue(h, w.tenantId);
  return syncReviews(jobCtx(h, w.tenantId), syncDeps(h));
};
/** A fresh review at the location, synced; returns its stored view. */
async function aReview(o: Parameters<typeof rawReview>[1] = {}): Promise<Review> {
  const ext = `rv-${randomUUID()}`;
  fake().seed(w.location.accountId, [rawReview(ext, o)]);
  await sync();
  const list = await call<z.infer<typeof S.ReviewsResponse>>(w.owner, 'GET', `/gbp/reviews?connectionId=${w.location.connectionId}&filter=all`);
  const ids = (await h.su.query<{ id: string }>('SELECT id FROM gbp_reviews WHERE external_review_id = $1', [ext])).rows;
  return list.body.reviews.reviews.find((r) => r.id === ids[0]!.id)!;
}
const draft = (id: string, body: Record<string, unknown>, c = w.owner) => call<z.infer<typeof S.ReviewResponse>>(c, 'POST', `/gbp/reviews/${id}/draft`, body);
const reply = (id: string, actionId: string, text: string, c = w.owner) => call<z.infer<typeof S.ReplyResponse>>(c, 'POST', `/gbp/reviews/${id}/reply`, { actionId, text });
const discard = (id: string, actionId: string, c = w.owner) => call<z.infer<typeof S.ReviewResponse>>(c, 'POST', `/gbp/reviews/${id}/discard`, { actionId });
const actionRow = async (id: string) => (await h.su.query<{ status: string; owner_user_id: string | null; contact_id: string | null; explanation: string; payload: Record<string, unknown>; decided_by_role: string | null }>('SELECT status, owner_user_id, contact_id, explanation, payload, decided_by_role FROM assistant_actions WHERE id = $1', [id])).rows[0]!;
const replyDrafts = async () => Number((await h.su.query("SELECT count(*)::int AS n FROM assistant_actions WHERE tenant_id = $1 AND kind = 'review_reply_draft'", [w.tenantId])).rows[0].n);

describe('drafts, only on a tap (R-GBP-1)', () => {
  it('E133 R-GBP-1: a one-star review is synced but nothing is drafted until a person asks; review requests were never gated by sentiment', async () => {
    const before = await replyDrafts();
    const r = await aReview({ stars: 'ONE', comment: 'Never called me back.' });
    expect(r).toMatchObject({ state: 'needs_reply', stateLabel: 'Needs a reply', draft: null, rating: 1 });
    expect(await replyDrafts()).toBe(before);
    const d = await draft(r.id, { mode: 'assistant' });
    expect(d.status).toBe(200);
    expect(d.body.review).toMatchObject({ state: 'draft_waiting', stateLabel: 'Draft waiting', draft: { byAssistant: true, guard: [] } });
  });

  it('E132 R-GBP-1: a review naming the client and the price gets a draft that names neither; the model saw only the rating, the text and the team name; the run is recorded by id', async () => {
    const r = await aReview({ stars: 'FIVE', reviewer: 'Reviewer Quill', comment: 'Quill here: they sold our home for $612,000 after the inspection!' });
    const calls = h.providers.ai.calls.length;
    const d = await draft(r.id, { mode: 'assistant' });
    const text = d.body.review.draft!.text;
    expect(text).not.toMatch(/Quill|\$|612|inspection/i);
    const req = h.providers.ai.calls.at(-1)!;
    expect(h.providers.ai.calls.length).toBe(calls + 1);
    expect(req.user).toContain('<review stars="5">');
    expect(req.user).not.toMatch(/Reviewer Quill|Reviewer/);
    const action = await actionRow(d.body.review.draft!.actionId);
    expect(action).toMatchObject({ status: 'proposed', owner_user_id: null, contact_id: null, explanation: 'A reply to a Google review, waiting for an Owner or Admin to post it.' });
    expect(action.explanation).not.toMatch(/Quill/);
    const run = (await h.su.query("SELECT purpose, input_refs, output_enc FROM ai_runs WHERE tenant_id = $1 AND purpose = 'review_reply' ORDER BY created_at DESC LIMIT 1", [w.tenantId])).rows[0];
    expect(run).toEqual({ purpose: 'review_reply', input_refs: { reviewIds: [r.id] }, output_enc: null });
  });

  it('E132 R-GBP-1: a model draft that names the reviewer or a price creates nothing (ASSISTANT_UNAVAILABLE); a typed draft is kept with its guard codes', async () => {
    const r = await aReview({ reviewer: 'Reviewer Quill' });
    const before = await replyDrafts();
    h.providers.ai.scripted.push({ text: JSON.stringify({ reply: 'Thanks Quill, glad we got you $500,000!' }) });
    expect(await draft(r.id, { mode: 'assistant' })).toMatchObject({ status: 409, code: 'ASSISTANT_UNAVAILABLE' });
    h.providers.ai.scripted.push({ text: 'not json at all' });
    expect(await draft(r.id, { mode: 'assistant' })).toMatchObject({ status: 409, code: 'ASSISTANT_UNAVAILABLE' });
    expect(await replyDrafts()).toBe(before);
    const typed = await draft(r.id, { mode: 'manual', text: 'Thanks Quill! Enjoy 42 Harbor View Rd.' });
    expect(typed.body.review.draft).toMatchObject({ byAssistant: false, guard: ['REVIEWER_NAME', 'ADDRESS'] });
    // with the team's AI off, the assistant does not draft
    await h.su.query('UPDATE tenant_settings SET ai_enabled = false WHERE tenant_id = $1', [w.tenantId]);
    try {
      expect(await draft(r.id, { mode: 'assistant' })).toMatchObject({ status: 409, code: 'ASSISTANT_UNAVAILABLE' });
    } finally {
      await h.su.query('UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1', [w.tenantId]);
    }
  });

  it('R-GBP-1: a new draft supersedes the waiting one', async () => {
    const r = await aReview();
    const a = (await draft(r.id, { mode: 'manual', text: 'Thank you!' })).body.review.draft!.actionId;
    const b = (await draft(r.id, { mode: 'manual', text: 'Thank you so much!' })).body.review.draft!.actionId;
    expect(a).not.toBe(b);
    expect((await actionRow(a)).status).toBe('superseded');
    expect(await reply(r.id, a, 'Thank you!')).toMatchObject({ status: 404 });
  });
});

describe('the one tap (R-GBP-1, R-GBP-4)', () => {
  it('R-GBP-1 R-GBP-4: an Owner posts a reply with one tap through postReviewReply; "Replied" only after Google confirmed it', async () => {
    const r = await aReview();
    const d = (await draft(r.id, { mode: 'assistant' })).body.review.draft!;
    const res = await reply(r.id, d.actionId, d.text);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'replied', sentence: 'Replied on Google', review: { state: 'replied', stateLabel: 'Replied', draft: null } });
    expect(fake().replies.map((x) => x.text)).toEqual([d.text]);
    expect(await actionRow(d.actionId)).toMatchObject({ status: 'executed', decided_by_role: 'owner' });
    // an Admin may post too
    const r2 = await aReview();
    const d2 = (await draft(r2.id, { mode: 'manual', text: 'Thank you for the kind words.' }, w.admin)).body.review.draft!;
    expect((await reply(r2.id, d2.actionId, d2.text, w.admin)).body.outcome).toBe('replied');
  });

  it('E469 R-GBP-1: a final text naming the reviewer, a price, an address, a date, contact details or deal terms, or with a hard fair-housing term, is refused with each code and span; nothing is posted', async () => {
    const r = await aReview({ reviewer: 'Reviewer Quill' });
    const d = (await draft(r.id, { mode: 'manual', text: 'Thank you!' })).body.review.draft!;
    for (const [text, code] of [['Thanks Quill!', 'REVIEWER_NAME'], ['Glad it sold for $1.2 million.', 'MONEY'], ['Enjoy 7 Oak Street.', 'ADDRESS'], ['See you June 4.', 'DATE'], ['Call 555 010 0199.', 'CONTACT'], ['Great closing!', 'DEAL'], ['Perfect for young families!', 'FAIR_HOUSING']] as const) {
      const res = await reply(r.id, d.actionId, text);
      expect([res.status, res.code], text).toEqual([422, 'REPLY_PRIVACY']);
      const details = (res.body as unknown as { error: { details: { codes: string[]; spans: { code: string; start: number; end: number }[] } } }).error.details;
      expect(details.codes).toContain(code);
      const span = details.spans.find((s) => s.code === code)!;
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.end).toBeLessThanOrEqual(text.length);
      expect(JSON.stringify(details)).not.toContain(text); // spans point into the text; the text is never echoed
    }
    expect(fake().replies).toEqual([]);
    expect((await actionRow(d.actionId)).status).toBe('proposed');
  });

  it('E464 R-GBP-4: two taps at once make one provider call; the second answers REPLY_IN_PROGRESS', async () => {
    const r = await aReview();
    const d = (await draft(r.id, { mode: 'manual', text: 'Thank you for the review.' })).body.review.draft!;
    let second: Awaited<ReturnType<typeof reply>> | null = null;
    fake().beforeReply = async () => {
      fake().beforeReply = null;
      second = await reply(r.id, d.actionId, d.text);
    };
    const first = await reply(r.id, d.actionId, d.text);
    expect(first.body.outcome).toBe('replied');
    expect([second!.status, second!.code]).toEqual([409, 'REPLY_IN_PROGRESS']);
    expect(fake().replies).toHaveLength(1);
    // and both at once from two connections
    const r2 = await aReview();
    const d2 = (await draft(r2.id, { mode: 'manual', text: 'Thank you again.' })).body.review.draft!;
    const both = await Promise.all([reply(r2.id, d2.actionId, d2.text), reply(r2.id, d2.actionId, d2.text, w.admin)]);
    expect(both.map((b) => b.status).sort()).toEqual([200, 409]);
    expect(fake().replies.filter((x) => x.text === d2.text)).toHaveLength(1);
  });

  it('R-GBP-4: a reply Google refuses goes back to a draft, in words; it can be edited and tried again', async () => {
    const r = await aReview();
    const d = (await draft(r.id, { mode: 'manual', text: 'Thank you.' })).body.review.draft!;
    fake().nextReply = 'rejected';
    const res = await reply(r.id, d.actionId, d.text);
    expect(res.body).toMatchObject({ outcome: 'failed', sentence: 'Google did not take the reply (REPLY_REJECTED). Edit it or try again.', review: { state: 'draft_waiting' } });
    expect((await actionRow(d.actionId)).status).toBe('proposed');
    expect((await reply(r.id, d.actionId, 'Thank you for the review!')).body.outcome).toBe('replied');
  });

  it('E465 R-GBP-4: a lost answer is "Checking with Google", never posted twice; the sync settles it: posted when Google shows the text, otherwise back to a draft', async () => {
    const r = await aReview();
    const d = (await draft(r.id, { mode: 'manual', text: 'Thank you for the review.' })).body.review.draft!;
    fake().nextReply = 'timeout';
    const res = await reply(r.id, d.actionId, d.text);
    expect(res.body).toMatchObject({ outcome: 'unknown', sentence: "We didn't hear back from Google. We are checking; we won't post it twice.", review: { state: 'posting', stateLabel: 'Posting…' } });
    expect(await reply(r.id, d.actionId, d.text)).toMatchObject({ status: 409, code: 'REPLY_IN_PROGRESS' });
    expect(await draft(r.id, { mode: 'manual', text: 'Another.' })).toMatchObject({ status: 409, code: 'REPLY_IN_PROGRESS' });
    expect(await discard(r.id, d.actionId)).toMatchObject({ status: 409, code: 'REPLY_IN_PROGRESS' });
    expect(fake().replies).toHaveLength(1);
    // not yet 5 minutes: the sync leaves it alone
    await sync();
    expect((await actionRow(d.actionId)).status).toBe('approved');
    await h.su.query("UPDATE assistant_actions SET decided_at = now() - interval '6 minutes' WHERE id = $1", [d.actionId]);
    const list = await call<z.infer<typeof S.ReviewsResponse>>(w.owner, 'GET', '/gbp/reviews?filter=all');
    expect(list.body.reviews.reviews.find((x) => x.id === r.id)).toMatchObject({ state: 'checking', stateLabel: 'Checking with Google' });
    await sync();
    expect((await actionRow(d.actionId)).status).toBe('executed');
    expect((await h.su.query('SELECT reply_status, reply_action_id FROM gbp_reviews WHERE id = $1', [r.id])).rows[0]).toEqual({ reply_status: 'replied', reply_action_id: d.actionId });
    // a lost answer that never reached Google goes back to a draft waiting for a tap
    const r2 = await aReview();
    const d2 = (await draft(r2.id, { mode: 'manual', text: 'Thanks a lot.' })).body.review.draft!;
    fake().nextReply = 'timeout';
    fake().replyAppliesOnTimeout = false;
    await reply(r2.id, d2.actionId, d2.text);
    await h.su.query("UPDATE assistant_actions SET decided_at = now() - interval '6 minutes' WHERE id = $1", [d2.actionId]);
    await sync();
    expect((await actionRow(d2.actionId)).status).toBe('proposed');
    expect(fake().replies.filter((x) => x.text === d2.text)).toHaveLength(1);
  });

  it('E466 R-GBP-4: a review edited at Google after the draft is refused (REPLY_STALE); nothing is posted', async () => {
    const r = await aReview({ comment: 'Good.' });
    const d = (await draft(r.id, { mode: 'manual', text: 'Thank you.' })).body.review.draft!;
    const ext = (await h.su.query<{ e: string }>('SELECT external_review_id AS e FROM gbp_reviews WHERE id = $1', [r.id])).rows[0]!.e;
    fake().edit(w.location.accountId, ext, { comment: 'Actually it was bad.', starRating: 'TWO', updateTime: '2026-11-10T10:00:00Z' });
    await sync();
    expect(await reply(r.id, d.actionId, d.text)).toMatchObject({ status: 409, code: 'REPLY_STALE' });
    expect(fake().replies).toEqual([]);
  });

  it('R-GBP-1: discarding a waiting draft brings the review back to "Needs a reply"', async () => {
    const r = await aReview();
    const d = (await draft(r.id, { mode: 'manual', text: 'Thank you.' })).body.review.draft!;
    const res = await discard(r.id, d.actionId);
    expect(res.body.review).toMatchObject({ state: 'needs_reply', draft: null });
    expect(await actionRow(d.actionId)).toMatchObject({ status: 'rejected', decided_by_role: 'owner' });
  });

  it('E471 R-GBP-1: the generic assistant action routes never show, approve or reject a review reply draft', async () => {
    const r = await aReview();
    const d = (await draft(r.id, { mode: 'manual', text: 'Thank you.' })).body.review.draft!;
    expect((await call(w.owner, 'GET', `/assistant/actions/${d.actionId}`)).status).toBe(404);
    expect((await call(w.owner, 'POST', `/assistant/actions/${d.actionId}/approve`, { commandId: randomUUID() })).status).toBe(404);
    expect((await call(w.owner, 'POST', `/assistant/actions/${d.actionId}/reject`)).status).toBe(404);
    expect((await actionRow(d.actionId)).status).toBe('proposed');
    expect(fake().replies).toEqual([]);
  });

  it('R-GBP-1: every review response is snapshotted: no tenant id, no confidence, no contact', () => {
    for (const [name, schema] of Object.entries({ ReviewsResponse: S.ReviewsResponse, ReviewResponse: S.ReviewResponse, ReplyResponse: S.ReplyResponse, StatusResponse: S.StatusResponse })) {
      const j = z.toJSONSchema(schema);
      expect(JSON.stringify(j), name).not.toMatch(/tenant|confidence|contactId|contact_id|contactPoint/i);
      expect(j).toMatchSnapshot(name);
    }
  });
});
