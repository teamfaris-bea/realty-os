// Wider or narrower through the policy routes (R-ISA-38; E1011; review fixes F2, F5 and F8). A change the platform
// cannot rank (the ready-within days in either direction, the team's own words) is wider: the page says so before the
// tap, the approval pauses care, and narrows_previous is false. Real Postgres via the API harness; fakes only.
import { DEFAULT_AI_ISA_CONTENT, aiIsaPolicyApprovalText } from '@realty/core/isa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { FakeIsaAi } from '../providers/fake/isaAi.js';
import type { AiProvider } from '../providers/types.js';
import { type IsaWorld, assignmentOf, call, freshReauth, isaLead, isaWorld, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

interface Draft { versionId: string; versionNo: number; contentSha256: string; effect: string | null; effectSentence: string; approvalText: string | null;
  diff: { adds: string[]; removes: string[]; changes: string[]; wider: boolean } | null }
interface View { state: string; draft: Draft | null }
const D = DEFAULT_AI_ISA_CONTENT as unknown as Record<string, unknown>;

async function saveDraft(content: Record<string, unknown>) {
  await freshReauth(h, w.owner);
  return call<View>(w.owner, 'PUT', '/admin/ai-isa/policy/draft', { content });
}
async function approve(d: Draft) {
  await freshReauth(h, w.owner);
  return call<{ effect: string; careContinues: boolean; pausedCare: number; sentence: string }>(w.owner, 'POST', '/admin/ai-isa/policy/approve', { versionId: d.versionId, contentSha256: d.contentSha256, attestation: d.approvalText });
}
const narrows = async (versionId: string) => (await h.su.query<{ n: boolean | null }>(`SELECT narrows_previous AS n FROM playbook_versions WHERE id = $1`, [versionId])).rows[0]!.n;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  (h.providers as { ai: AiProvider }).ai = new FakeIsaAi();
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-38 a change nothing can rank is wider (E1011)', () => {
  it('F2: 90 to 30 ready-within days is shown as a change that agents must re-confirm, and approving it pauses care', async () => {
    const lead = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, lead.id))!.paused_at).toBeNull();

    const saved = await saveDraft({ ...D, readiness: { timelineDays: 30 } });
    const d = saved.body.draft!;
    expect(d).toMatchObject({ versionNo: 2, effect: 'wider', diff: { adds: [], removes: [], changes: ['treats a move within 30 days as ready (was 90)'], wider: true } });
    expect(d.effectSentence).toBe('This version changes a rule each agent must agree to again: it treats a move within 30 days as ready (was 90). Approving it pauses AI care for every lead until each agent re-confirms.');
    expect(d.approvalText).toBe(aiIsaPolicyApprovalText({ versionNo: 2, contentSha256: d.contentSha256, effect: 'wider' }));
    expect(d.approvalText).toContain('or changes a rule each agent must agree to again');
    const r = await approve(d);
    expect(r.body).toMatchObject({ effect: 'wider', careContinues: false, pausedCare: 1 });
    expect(await narrows(d.versionId)).toBe(false);
    await runIsa(h, w.tenantId);
    expect(await assignmentOf(h, lead.id)).toMatchObject({ pause_reason: 'policy_updated', ended_at: null });
    const me = await call<{ needsReattest: boolean; policyChange: { state: string; sentence: string; diff: { adds: string[]; changes: string[] } } }>(w.agents[0]!, 'GET', '/me/ai-isa');
    expect(me.body).toMatchObject({ needsReattest: true, policyChange: { state: 'widened', diff: { adds: [], changes: ['treats a move within 30 days as ready (was 90)'] } } });
    // the agent is not told it "lets the assistant do more" when nothing was added
    expect(me.body.policyChange.sentence).toBe('The team changed the AI rules since you confirmed them, and the change needs your agreement. AI care for your leads is paused until you confirm the new version.');
  });

  it('F2: back from 30 to 90 is wider too, with the same words the other way round', async () => {
    const saved = await saveDraft(D);
    expect(saved.body.draft).toMatchObject({ versionNo: 3, effect: 'wider', diff: { adds: [], removes: [], changes: ['treats a move within 90 days as ready (was 30)'], wider: true } });
  });

  it('F5: a new tone sample or holding line alone is wider; with something added the banner says both', async () => {
    const words = await saveDraft({ ...D, readiness: { timelineDays: 30 }, tone: 'Warm and brief.', holdingLines: { financial: 'I will ask your agent to go over that with you.' } });
    expect(words.body.draft).toMatchObject({ effect: 'wider', diff: { adds: [], removes: [], changes: ['has a different line for money questions', 'has a different tone sample'], wider: true } });
    expect(words.body.draft!.effectSentence).toBe('This version changes rules each agent must agree to again: it has a different line for money questions; and has a different tone sample. Approving it pauses AI care for every lead until each agent re-confirms.');
    const both = await saveDraft({ ...D, readiness: { timelineDays: 30 }, capabilities: ['converse', 'share_listings'], tone: 'Warm and brief.' });
    expect(both.body.draft!.effectSentence).toBe('This version lets the assistant do more than the approved one: it may now share listings that fit their search. It also changes a rule each agent must agree to again: it has a different tone sample. Approving it pauses AI care for every lead until each agent re-confirms.');
  });

  it('a narrower version is still narrower: fewer messages a day, nothing else touched', async () => {
    const saved = await saveDraft({ ...D, readiness: { timelineDays: 30 }, caps: { ...(D.caps as object), ai24h: 2 } });
    const d = saved.body.draft!;
    expect(d).toMatchObject({ effect: 'narrower', diff: { adds: [], removes: ['at most 2 AI messages per person in 24 hours (was 3)'], changes: [], wider: false } });
    expect((await approve(d)).body).toMatchObject({ effect: 'narrower', careContinues: true, pausedCare: 0 });
    expect(await narrows(d.versionId)).toBe(true);
  });
});
