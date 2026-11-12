// Home anniversaries, the post-closing template v2 and review requests (PHASE2_3_PLAN §5.4 #26; R-NURT-2,
// R-MKT-11, R-AST-20, F7; E101), through real Postgres and the fake providers.
import { contentSha256, validatePlaybookContent, type PlaybookKind } from '@realty/core/assistant';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { actionsOf, call, depsOf, messagesOf, ownedContact, runJobs, stepNow } from '../assistant/testing.js';
import { enrollOnDealClosed, executePlaybookStep } from '../assistant/enrollments.js';
import { BUILT_IN_TEMPLATES, templateByKey } from '../assistant/templates.js';
import { systemActor } from '../worker/systemActor.js';
import { ATTEST, type NurtureWorld, anniversaryScan, approveTemplate, closedDeal, firingsDue, nurtureWorld, reconcileAndRun, triggerRuns } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;

/**
 * Today's date in the tenant's own zone: the scan fires an anniversary on the tenant's local day (detect.ts), so a
 * closing date built from the UTC date is not "today" between UTC midnight and the zone's midnight.
 */
async function localToday(): Promise<{ y: number; m: number; d: number }> {
  const zone = (await h.su.query<{ z: string }>('SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.z;
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  return { y: y!, m: m! - 1, d: d! };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  await approveTemplate(w.agents[0]!, 'after_closing_alerts');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const at = (iso: string) => Date.parse(iso) as never;
const anniversaryMail = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.body.includes('Happy home anniversary'));

describe('R-NURT-2 home anniversaries (E101)', () => {
  it('E101 R-NURT-2: a Feb 29 closing fires on Feb 28 in a common year (tenant zone) and on Feb 29 in a leap year; never twice a year', async () => {
    const c = await ownedContact(w.agents[0]!);
    const deal = await closedDeal(h, w.tenantId, c.id, w.agents[0]!.userId!, new Date('2024-02-29T17:00:00Z'));
    expect(await anniversaryScan(h, w.tenantId, at('2027-02-27T17:00:00Z'))).toBe(0);
    expect(await anniversaryScan(h, w.tenantId, at('2027-02-28T17:00:00Z'))).toBe(1);
    expect(await anniversaryScan(h, w.tenantId, at('2027-02-28T22:00:00Z'))).toBe(0); // the hourly rerun the same day: a no-op
    expect(await anniversaryScan(h, w.tenantId, at('2027-03-01T17:00:00Z'))).toBe(0);
    expect(await anniversaryScan(h, w.tenantId, at('2028-02-28T17:00:00Z'))).toBe(0); // a leap year: not the 28th
    expect(await anniversaryScan(h, w.tenantId, at('2028-02-29T17:00:00Z'))).toBe(1);
    const keys = (await triggerRuns(h, c.id)).map((r) => r.trigger_key);
    expect(keys).toEqual([`anniversary:${deal}:2027:${c.id}`, `anniversary:${deal}:2028:${c.id}`]);
  });

  it('R-NURT-2 R-AST-20: the anniversary email goes out once, from the approved after-closing alerts, in the nurture_step category, with the deal as evidence', async () => {
    const c = await ownedContact(w.agents[0]!);
    const today = await localToday();
    const closed = new Date(Date.UTC(today.y - 2, today.m, today.d, 17));
    const deal = await closedDeal(h, w.tenantId, c.id, w.agents[0]!.userId!, closed);
    expect(await anniversaryScan(h, w.tenantId)).toBeGreaterThanOrEqual(1);
    expect(await anniversaryScan(h, w.tenantId)).toBe(0);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await anniversaryMail(c.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ status: 'sent', action_category: 'nurture_step', initiator: 'assistant' });
    expect(m[0]!.body).toContain('It has been 2 years since you got the keys to your home.');
    const a = (await actionsOf(h, c.id)).find((x) => x.kind === 'autonomous_message')!;
    expect(a.payload['evidence']).toEqual([expect.objectContaining({ trigger: 'home_anniversary', source: 'deal', sourceId: deal })]);
  });

  it('F7: one anniversary note a year: an old post-closing version (with an anniversary step) and the trigger never both send it', async () => {
    const agent = w.agents[1]!; // their own playbooks: an old v1-style post-closing plan AND the after-closing alerts
    await approveTemplate(agent, 'after_closing_alerts');
    const v1 = { stepKey: 'anniversary', channel: 'email', delay: { anchor: 'event', offsetSeconds: 365 * 86_400 }, purpose: 'marketing', category: 'nurture_step', intent: 'home_anniversary', subject: 'Happy home anniversary', template: 'Hi {{first_name}},\n\nIt has been a year since you got the keys. Happy home anniversary!', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: [] };
    const pb = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(agent, 'POST', '/playbooks', { kind: 'post_closing', scope: 'agent', name: 'Old after closing', steps: [v1] });
    const v = pb.body.playbook.versions[0]!;
    expect((await call(agent, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: ATTEST, contentSha256: v.contentSha256 })).status).toBe(200);
    // (a) the trigger sent it first: the enrollment's anniversary step is skipped visibly
    const a = await ownedContact(agent);
    const today = await localToday();
    const closedA = new Date(Date.UTC(today.y - 1, today.m, today.d, 17));
    const dealA = await closedDeal(h, w.tenantId, a.id, agent.userId!, closedA);
    await anniversaryScan(h, w.tenantId);
    await firingsDue(h, a.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await anniversaryMail(a.id)).toHaveLength(1);
    const [enr] = await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), dealA, depsOf(h));
    expect(enr).toBeDefined();
    const out = await executePlaybookStep(systemActor(w.tenantId, 'assistant'), enr!, depsOf(h));
    expect(out).toMatchObject({ kind: 'skipped', reason: 'ANNIVERSARY_ALREADY_SENT' });
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect(await anniversaryMail(a.id)).toHaveLength(1);
    // (b) the enrollment sent it first: the trigger firing is skipped visibly
    const b = await ownedContact(agent);
    const dealB = await closedDeal(h, w.tenantId, b.id, agent.userId!, closedA);
    const [enrB] = await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), dealB, depsOf(h));
    await stepNow(h, w.tenantId, enrB!);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await anniversaryMail(b.id)).toHaveLength(1);
    await anniversaryScan(h, w.tenantId);
    await firingsDue(h, b.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await anniversaryMail(b.id)).toHaveLength(1);
    expect((await triggerRuns(h, b.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: expect.objectContaining({ reason: 'ANNIVERSARY_ALREADY_SENT' }) }) });
  });
});

describe('built-in templates (R-AST-4, R-AST-20, F7, R-INBOX-4)', () => {
  it('R-AST-4 R-NURT-1: every built-in template validates cleanly with its own content kind, and ships as a draft a person approves once', async () => {
    for (const t of BUILT_IN_TEMPLATES) expect(validatePlaybookContent(t.content ?? t.steps, { kind: t.kind as PlaybookKind }), t.key).toEqual([]);
    for (const key of ['behavior_alerts', 'after_closing_alerts', 'transaction_updates', 'post_closing', 'new_lead_response_where_they_wrote']) {
      const t = templateByKey(key)!;
      const by = t.scope === 'team' ? w.owner : w.agents[0]!;
      const c = await call<{ playbook: { kind: string; approvedVersionId: string | null; versions: { status: string; contentSha256: string; steps: unknown; issues: unknown[] }[] } }>(by, 'POST', '/playbooks', { templateKey: key });
      expect(c.status, key).toBe(201);
      expect(c.body.playbook.approvedVersionId, key).toBeNull();
      expect(c.body.playbook.versions.map((v) => [v.status, v.issues]), key).toEqual([['draft', []]]);
      expect(c.body.playbook.versions[0]!.contentSha256).toBe(contentSha256((t.content ?? t.steps) as never, {}));
    }
  });

  it('F7: After closing v2 has no home-value or anniversary step; it has a review request with no sentiment condition and no incentive', () => {
    const t = templateByKey('post_closing')!;
    expect(t.templateVersion).toBe(2);
    expect(t.steps.map((s) => s.intent)).toEqual(['check_in', 'review_request']);
    const review = t.steps.find((s) => s.intent === 'review_request')!;
    expect(Object.keys(review).sort()).toEqual(['category', 'channel', 'delay', 'intent', 'maxLength', 'personalization', 'purpose', 'requires', 'slots', 'stepKey', 'stopIf', 'subject', 'template']);
    expect(review.stopIf).toEqual([]);
    expect(review.requires).toEqual(['review_requests']);
    // a template with an incentive or a sentiment filter can never be approved (core validator, R-MKT-11)
    expect(validatePlaybookContent([{ ...review, template: 'Leave us a 5-star review and get a $50 gift card!' }], { kind: 'post_closing' }).map((i) => i.code)).toContain('REVIEW_REQUEST_INCENTIVE');
    expect(validatePlaybookContent([{ ...review, onlyIf: 'happy' }], { kind: 'post_closing' }).map((i) => i.code)).toContain('SCHEMA');
    // the after-closing alerts carry the anniversary and the (not yet available) home value; Behavior alerts are facts only
    expect(templateByKey('after_closing_alerts')!.content!.triggers.map((x) => x.trigger)).toEqual(['home_anniversary', 'home_value']);
    expect(templateByKey('behavior_alerts')!.content!.triggers.map((x) => x.trigger)).toEqual(['price_drop', 'back_on_market']);
    expect(templateByKey('new_lead_response_where_they_wrote')!.steps[0]!.channel).toBe('inbound_channel');
  });

  it('R-MKT-11: review requests go to every client the post-closing playbook covers, never filtered, and only once platform:review_requests is cleared', async () => {
    const agent = w.agents[0]!;
    await approveTemplate(agent, 'post_closing');
    const closedAt = new Date(Date.now() - 40 * 86_400_000);
    const clients = [await ownedContact(agent), await ownedContact(agent)];
    // one of them left negative feedback on a showing; it changes nothing (no sentiment input exists at all)
    const enrollments: string[] = [];
    for (const c of clients) {
      const d = await closedDeal(h, w.tenantId, c.id, agent.userId!, closedAt);
      enrollments.push(...(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), d, depsOf(h))));
    }
    const reviews = async (id: string) => (await messagesOf(h, id)).filter((m) => m.body.includes('write a short review'));
    // the pack ships unreviewed: the step is skipped visibly
    for (const e of enrollments) {
      for (let i = 0; i < 3; i++) {
        await stepNow(h, w.tenantId, e);
        await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
      }
    }
    for (const c of clients) expect(await reviews(c.id)).toEqual([]);
    const skipped = (await h.su.query("SELECT count(*)::int AS n FROM playbook_step_runs WHERE enrollment_id = ANY ($1) AND step_key = 'review_request' AND status = 'skipped_ineligible'", [enrollments])).rows[0].n;
    expect(skipped).toBe(2);
    // once counsel cleared the pack, a new enrollment sends it to every client alike
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:review_requests'");
    try {
      const more = [await ownedContact(agent), await ownedContact(agent)];
      for (const c of more) {
        const d = await closedDeal(h, w.tenantId, c.id, agent.userId!, closedAt);
        const [e] = await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), d, depsOf(h));
        for (let i = 0; i < 3; i++) {
          await stepNow(h, w.tenantId, e!);
          await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
        }
      }
      for (const c of more) expect((await reviews(c.id)).map((m) => m.status)).toEqual(['sent']);
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:review_requests'");
    }
  });
});
