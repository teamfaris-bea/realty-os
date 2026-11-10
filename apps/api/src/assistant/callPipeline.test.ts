// The call pipeline and saved searches (R-AST-1, R-AST-2, R-AST-5, R-AST-10, R-AST-18, R-ACC-2; E33,
// E34): transcript → evidence-backed claims → promise tasks → saved-search proposal → human approval →
// matches against the team's own listings → alerts through the send-time gate.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { summarizeCall } from './callPipeline.js';
import { type AssistantWorld, actionsOf, assistantWorld, call, decisionsFor, depsOf, listing, messagesOf, ownedContact, runJobs, setAiEnabled, transcribedCall } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

// Thu Nov 5 2026, 12:25 AM in New York = Wed Nov 4, 9:25 PM in Los Angeles; the client speaks 5 min in.
const STARTED = new Date('2026-11-05T05:25:00Z');
const SEGMENTS = [
  { startMs: 0, endMs: 290_000, speaker: 'agent', text: 'Thanks for calling back, what are you looking for?' },
  { startMs: 300_000, endMs: 310_000, speaker: 'client', text: 'Call me tomorrow, I am free all day.' },
  { startMs: 310_000, endMs: 330_000, speaker: 'client', text: 'We want something near 94110 under 900k.' },
];

const summaryOutput = {
  explanation: 'They want a callback and gave their search area.',
  claims: [
    { kind: 'commitment', text: 'Call them back tomorrow', when: 'tomorrow', needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 300_000, end_ms: 310_000 }, snippet: 'Call me tomorrow' }] },
    { kind: 'commitment', text: 'Send them the comps by Friday', when: 'Friday', needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 0, end_ms: 290_000 }, snippet: 'I will send you the comps by Friday' }] },
  ],
};
const searchOutput = {
  explanation: 'Search criteria from the call.',
  claims: [
    { kind: 'preference', text: 'Near 94110', criterion: { key: 'postal_codes', value: ['94110'] }, needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 310_000, end_ms: 330_000 }, snippet: 'near 94110' }] },
    { kind: 'preference', text: 'Under $900k', criterion: { key: 'price_max', value: 900_000 }, needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 310_000, end_ms: 330_000 }, snippet: 'under 900k' }] },
    { kind: 'preference', text: 'At least 4 bedrooms', criterion: { key: 'beds_min', value: 4 }, needs_review: false, evidence: [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 310_000, end_ms: 330_000 }, snippet: 'four bedrooms at least' }] },
  ],
};

async function pacificContact(agentIdx: number) {
  const c = await ownedContact(w.agents[agentIdx]!, { firstName: 'Lena' });
  await h.su.query("UPDATE contacts SET timezone = 'America/Los_Angeles', timezone_source = 'explicit' WHERE id = $1", [c.id]);
  return c;
}

type Card = { id: string; kind: string; claims: { id: string; kind: string; text: string; needsReview: boolean; due: { display: string; at: string; allDay: boolean } | null; evidence: { snippet: string | null; verified: boolean; label: string }[] }[] };

describe('call pipeline (R-AST-1, R-AST-2, R-AST-5, R-ACC-2)', () => {
  it('R-AST-2 E34 R-ACC-2 R-AST-5 E33: "call me tomorrow" said after midnight ET by a Pacific client resolves to HER tomorrow; the promise task gets that date; a fabricated quote is needs_review and gets no due date', async () => {
    const agent = w.agents[0]!;
    const c = await pacificContact(0);
    const callId = await transcribedCall(h, w, c.id, agent.userId!, SEGMENTS, { startedAt: STARTED });
    h.providers.ai.scripted.push({ text: JSON.stringify(summaryOutput) }, { text: JSON.stringify({ claims: [] }) });
    const r = await summarizeCall(systemActor(w.tenantId, 'assistant'), callId, depsOf(h));
    expect(r).toMatchObject({ kind: 'done', promises: 2, searchId: null });
    const summary = (await actionsOf(h, c.id)).find((a) => a.kind === 'call_summary')!;
    const card = (await call<{ action: Card }>(agent, 'GET', `/assistant/actions/${summary.id}`)).body.action;
    const tomorrow = card.claims.find((x) => x.text === 'Call them back tomorrow')!;
    expect(tomorrow.needsReview).toBe(false);
    expect(tomorrow.due).toMatchObject({ display: 'Thu Nov 5', allDay: true });
    // evidence: the quote and where it was said ("at 5:00 in the call"), decrypted for the agent on the call
    expect(tomorrow.evidence[0]).toMatchObject({ verified: true, snippet: 'Call me tomorrow' });
    expect(tomorrow.evidence[0]!.label).toMatch(/“Call me tomorrow” at 5:00 in the call/);
    // the transcript snippet is encrypted at rest (ARCHITECTURE §8)
    const ev = (await h.su.query('SELECT snippet, snippet_enc IS NOT NULL AS enc FROM evidence_refs e JOIN assistant_claims c ON c.id = e.claim_id WHERE c.action_id = $1', [summary.id])).rows;
    expect(ev.every((x: { snippet: string | null; enc: boolean }) => x.snippet === null && x.enc)).toBe(true);
    const fabricated = card.claims.find((x) => x.text.startsWith('Send them the comps'))!;
    expect(fabricated.needsReview).toBe(true);
    expect(fabricated.evidence[0]!.verified).toBe(false);
    const tasks = (await h.su.query<{ title: string; due_at: Date | null; due_all_day: boolean; needs_review: boolean; source_claim_id: string; assignee_user_id: string }>("SELECT title, due_at, due_all_day, needs_review, source_claim_id, assignee_user_id FROM tasks WHERE contact_id = $1 AND kind = 'promise' ORDER BY title", [c.id])).rows;
    expect(tasks).toHaveLength(2);
    const t1 = tasks.find((t) => t.source_claim_id === tomorrow.id)!;
    expect(t1).toMatchObject({ due_all_day: true, needs_review: false, assignee_user_id: agent.userId });
    expect(t1.due_at!.toISOString()).toBe('2026-11-05T08:00:00.000Z'); // start of Thu Nov 5 in Los Angeles (PST)
    const t2 = tasks.find((t) => t.source_claim_id === fabricated.id)!;
    expect(t2).toMatchObject({ due_at: null, needs_review: true });
    // the DB refuses an open, needs-review promise WITH a due date (R-AST-5)
    await expect(h.su.query("UPDATE tasks SET due_at = now() WHERE source_claim_id = $1", [fabricated.id])).rejects.toThrow(/check/i);
    // once the agent corrects the date, the task gets it (and loses needs_review)
    const fix = await call(agent, 'POST', `/assistant/claims/${fabricated.id}/review`, { status: 'corrected', corrected: { dueAt: '2026-11-06T17:00:00.000Z' } });
    expect(fix.status).toBe(200);
    const t2b = (await h.su.query('SELECT due_at, needs_review FROM tasks WHERE source_claim_id = $1', [fabricated.id])).rows[0];
    expect(t2b).toEqual({ due_at: new Date('2026-11-06T17:00:00.000Z'), needs_review: false });
    // another agent cannot see the call summary at all
    expect((await call(w.agents[1]!, 'GET', `/assistant/actions/${summary.id}`)).status).toBe(404);
    // idempotent: a second run (job retry / scan) adds nothing
    const again = await summarizeCall(systemActor(w.tenantId, 'assistant'), callId, depsOf(h));
    expect(again).toMatchObject({ kind: 'done', summaryActionId: null, promises: 0 });
    expect((await actionsOf(h, c.id)).filter((a) => a.kind === 'call_summary')).toHaveLength(1);
  });

  it('R-AST-18: with AI off the pipeline makes no provider call and produces nothing', async () => {
    const c = await pacificContact(0);
    const callId = await transcribedCall(h, w, c.id, w.agents[0]!.userId!, SEGMENTS);
    await setAiEnabled(h, w.tenantId, false);
    try {
      const before = h.providers.ai.calls.length;
      expect(await summarizeCall(systemActor(w.tenantId, 'assistant'), callId, depsOf(h))).toEqual({ kind: 'skipped', reason: 'AI_DISABLED' });
      expect(h.providers.ai.calls.length).toBe(before);
      expect(await actionsOf(h, c.id)).toEqual([]);
    } finally {
      await setAiEnabled(h, w.tenantId, true);
    }
  });
});

describe('saved searches (R-AST-5, R-AST-10)', () => {
  it('R-AST-10 R-AST-5: criteria proposed from the call; needs-review ones prefilled but unchecked; approval by the agent; matches from team listings; alerts gated at send time', async () => {
    const agent = w.agents[0]!;
    const c = await pacificContact(0);
    const callId = await transcribedCall(h, w, c.id, agent.userId!, SEGMENTS);
    const hit = await listing(h, w, agent.userId!, { postalCode: '94110', priceCents: 85_000_000, beds: 3 });
    await listing(h, w, agent.userId!, { postalCode: '94110', priceCents: 120_000_000 }); // over budget
    await listing(h, w, agent.userId!, { postalCode: '94607', priceCents: 70_000_000 }); // other area
    h.providers.ai.scripted.push({ text: JSON.stringify({ claims: [] }) }, { text: JSON.stringify(searchOutput) });
    const r = await summarizeCall(systemActor(w.tenantId, 'assistant'), callId, depsOf(h));
    expect(r.kind).toBe('done');
    const searchId = (r as { searchId: string }).searchId;
    expect(searchId).toBeTruthy();
    const stored = (await h.su.query('SELECT status, criteria, criterion_evidence FROM saved_searches WHERE id = $1', [searchId])).rows[0];
    expect(stored.status).toBe('proposed');
    expect(stored.criteria).toEqual({ postalCodes: ['94110'], priceMaxCents: 90_000_000 }); // the needs-review bedrooms criterion is NOT stored
    expect(Object.keys(stored.criterion_evidence).sort()).toEqual(['bedsMin', 'postalCodes', 'priceMaxCents']);
    const pv = await call<{ search: { unchecked: string[]; prefill: Record<string, unknown>; matches: { id: string }[] } }>(agent, 'GET', `/saved-searches/${searchId}/preview`);
    expect(pv.body.search.unchecked).toEqual(['bedsMin']);
    expect(pv.body.search.prefill).toEqual({ bedsMin: 4 });
    expect(pv.body.search.matches.map((m) => m.id)).toEqual([hit]);

    // only a human acting as themselves approves (DB trigger), and criteria change only with re-approval
    await expect(
      withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`UPDATE saved_searches SET status = 'approved', approved_by_user_id = ${agent.userId}, approved_at = now() WHERE id = ${searchId}`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/SAVED_SEARCH_APPROVAL_REQUIRES_HUMAN/);
    expect((await call(w.agents[1]!, 'POST', `/saved-searches/${searchId}/approve`, { checked: [] })).status).toBe(404);
    const ap = await call<{ search: { status: string; criteria: Record<string, unknown> } }>(agent, 'POST', `/saved-searches/${searchId}/approve`, { checked: [], name: 'Mission homes' });
    expect(ap.body.search).toMatchObject({ status: 'approved', criteria: { postalCodes: ['94110'], priceMaxCents: 90_000_000 } });
    await expect(h.su.query(`UPDATE saved_searches SET criteria = '{"postalCodes":["94607"]}'::jsonb WHERE id = $1`, [searchId])).rejects.toThrow(/SAVED_SEARCH_REAPPROVAL_REQUIRED/);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'saved_search.approved' AND entity_id = $1", [searchId])).rows[0].n).toBe(1);

    // activation: the current match is recorded and alerted, as a marketing search_alert through the gate
    const mails = h.providers.email.sent.length;
    const act = await call<{ search: { status: string } }>(agent, 'POST', `/saved-searches/${searchId}/activate`);
    expect(act.body.search.status).toBe('active');
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const alerts = (await messagesOf(h, c.id)).filter((m) => m.action_category === 'search_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.initiator).toBe('system');
    expect(alerts[0]!.body).toContain('Mission homes');
    const ds = await decisionsFor(h, { messageId: alerts[0]!.id });
    expect(ds).toHaveLength(1);
    expect(ds[0]!.action_category).toBe('search_alert');
    // this tenant's email identity has no verified sending domain, so a marketing email is denied
    expect(ds[0]!.outcome).toBe('deny');
    expect(ds[0]!.reason_codes).toContain('EMAIL_DOMAIN_UNVERIFIED');
    expect(h.providers.email.sent.length).toBe(mails);
    // the match is not re-alerted
    expect((await h.su.query('SELECT alerted_message_id FROM saved_search_matches WHERE search_id = $1', [searchId])).rows).toEqual([{ alerted_message_id: alerts[0]!.id }]);
    const p = await call<{ search: { status: string } }>(agent, 'POST', `/saved-searches/${searchId}/pause`);
    expect(p.body.search.status).toBe('paused');
    void randomUUID;
  });
});
