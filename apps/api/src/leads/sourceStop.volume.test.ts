// R-LSRC-8, R-LSRC-10 M4 (bounded work, review round 5): making a marked source's people safe starts from the SOURCE's
// people, never from the team's rows.
//
// One team has 8,000 people of other lead sources in a running plan and 3,000 pending drafts a plan step wrote for
// them. The Owner (1) maps a 10-person label to a source marked "No automated contact for leads from this source", and
// (2) turns the setting on for a source that sent 12 people four different ways (their own lead source, an inquiry, an
// imported label, an import's no-label group; one of them merged into another record since). Each request asks only its
// own people's plans to stop and withdraws only their drafts, inside a stated time (2 s; each takes well under a tenth
// of that on an idle machine).
//
// Before this change both ran app.person_from_lead_source once for EVERY active plan, every live AI care and every
// pending plan or alert draft of the team (leads/sources.ts stopAutomatedContactNow): about half a millisecond each, so
// seconds at this size and the 30 s statement timeout at roughly 60,000 active plans, after which the Owner could no
// longer map a label to the marked source or turn the setting on. Two proofs, as in sourceUnclassified.volume.test.ts:
// the database's own counters (each of those definer calls probes lead_inquiries once: the two requests together make
// fewer than 500 index scans of it, where the old path made more than 22,000) and the stated time.
// Made-up labels and sources; fakes only.
import { randomUUID } from 'node:crypto';
import type { ContactId } from '@realty/core/foundation';
import { applyOwnershipCommand } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook, enrollmentRow, runJobs, smsStep } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, freshReauth, ownedContact } from '../comms/testing.js';
import { SOURCE_NO_AUTOMATED_CONTACT } from './automatedContact.js';
import { importedPerson, suFixture } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let plain: string;
let marked: string;
let late: string;
let planId: string;
let versionId: string;
const SMALL = 'Small partner label (stop volume test)';
const LATE = 'Late partner label (stop volume test)';
const OTHERS_IN_A_PLAN = 8000;
const OTHERS_WITH_A_DRAFT = 3000;
const BUDGET_MS = 2000;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await commsWorld(h, { agents: 1 });
  agent = w.agents[0]!;
  await freshReauth(h, w.owner);
  const src = async (name: string) => (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name, kind: 'referral' })).body.source.id;
  plain = await src('Open houses (stop volume test)');
  marked = await src('Partner referrals (stop volume test)');
  late = await src('Partner, marked later (stop volume test)');
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
  const plan = await approvedPlaybook(w.owner, {
    kind: 'nurture',
    scope: 'team',
    name: 'Two check-ins (stop volume test)',
    steps: [
      smsStep({ key: 'first', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] }),
      smsStep({ key: 'second', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in again.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
  planId = plan.playbookId;
  versionId = plan.versionId;

  // the team's other people: 8,000 in a running plan, 3,000 of them with a pending draft a plan step wrote. Written in
  // bulk as the migration owner (fixtures only): copies of one real person
  const seed = await ownedContact(agent, { consent: false });
  const cols = (await h.su.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contacts' AND is_generated = 'NEVER' ORDER BY ordinal_position",
  )).rows.map((r) => `"${r.column_name}"`);
  const sel = cols.map((c) => (c === '"id"' ? 'gen_random_uuid()' : `x.${c}`));
  await suFixture(h, [
    { text: `INSERT INTO contacts (${cols.join(', ')}) SELECT ${sel.join(', ')} FROM contacts x, generate_series(1, $2) g WHERE x.id = $1`, values: [seed.id, OTHERS_IN_A_PLAN] },
    {
      text: `INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, enrolled_by_user_id, state)
             SELECT c.tenant_id, gen_random_uuid(), $2, $3, c.id, 'user', $4, 'active' FROM contacts c WHERE c.tenant_id = $1 AND c.id <> $5`,
      values: [w.tenantId, planId, versionId, agent.userId, seed.id],
    },
    {
      text: `INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, trigger_ref)
             SELECT c.tenant_id, gen_random_uuid(), c.id, 'message_draft', 'novel_message', 'requires_approval', 'proposed', $2, 'A plan step wrote this', '{}', '{"kind":"playbook_step"}'
               FROM contacts c WHERE c.tenant_id = $1 AND c.id <> $4 ORDER BY c.id LIMIT $3`,
      values: [w.tenantId, agent.userId, OTHERS_WITH_A_DRAFT, seed.id],
    },
  ]);
  await h.su.query('ANALYZE contacts; ANALYZE playbook_enrollments; ANALYZE assistant_actions');
}, 600_000);
afterAll(async () => {
  await h?.close();
});

type Answer = { stopping: number; pausing: number; withdrawn: number };
const enroll = async (contactId: string): Promise<string> => {
  const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${contactId}/enrollments`, { playbookId: planId });
  expect(e.status).toBe(201);
  return e.body.enrollment.id;
};
const draftFor = async (contactId: string): Promise<string> => {
  const id = randomUUID();
  await suFixture(h, [{
    text: `INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, trigger_ref)
           VALUES ($1, $2, $3, 'message_draft', 'novel_message', 'requires_approval', 'proposed', $4, 'A plan step wrote this', '{}', '{"kind":"playbook_step"}')`,
    values: [w.tenantId, id, contactId, agent.userId],
  }]);
  return id;
};
const draftStatus = async (id: string) => (await h.su.query<{ status: string; reason: string | null }>("SELECT status, payload #>> '{withdrawn,reason}' AS reason FROM assistant_actions WHERE id = $1", [id])).rows[0]!;
/**
 * Index scans of lead_inquiries so far, from the database's own counters: app.person_from_lead_source and
 * app.person_source_refusal each probe it once per call, so this counts those calls. A backend reports its counters
 * when it has been idle for up to ten seconds, so this waits first.
 */
async function inquiryProbes(): Promise<number> {
  await new Promise((r) => setTimeout(r, 11_000));
  const r = await h.su.query<{ n: string }>("SELECT COALESCE(idx_scan, 0)::text AS n FROM pg_stat_user_tables WHERE relname = 'lead_inquiries'");
  return Number(r.rows[0]!.n);
}
const othersStillRunning = async () =>
  (await h.su.query<{ plans: number; drafts: number }>(
    `SELECT (SELECT count(*)::int FROM playbook_enrollments WHERE tenant_id = $1 AND state = 'active' AND enrolled_by = 'user' AND enrolled_by_user_id = $2 AND created_at < $3) AS plans,
            (SELECT count(*)::int FROM assistant_actions WHERE tenant_id = $1 AND status = 'proposed' AND explanation = 'A plan step wrote this' AND contact_id <> ALL ($4::uuid[])) AS drafts`,
    [w.tenantId, agent.userId, bulkBefore, mine],
  )).rows[0]!;
let bulkBefore: Date;
const mine: string[] = [];

describe('R-LSRC-10 E757 M4: stopping a marked source\'s automation is bounded by that source\'s people (8,000 other people in a running plan, 3,000 other pending drafts)', () => {
  it('mapping a 10-person label to a marked source asks its 3 running plans to stop and withdraws its draft, inside the stated time, without asking about anybody else\'s plan or draft; turning the setting on for a source that sent 12 people four ways does the same for them', async () => {
    bulkBefore = (await h.su.query<{ t: Date }>('SELECT now() AS t')).rows[0]!.t;
    // the small label: 10 people of one import, reviewed (so plans may run); 3 in a running plan, 1 with a pending draft
    const small: string[] = [];
    let batchId: string | undefined;
    for (let i = 0; i < 10; i++) {
      const c = await ownedContact(agent);
      small.push(c.id);
      batchId = (await importedPerson(h, w.tenantId, w.owner.userId!, c.id, { label: SMALL, ...(batchId ? { batchId } : {}) })).batchId;
    }
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/lead-sources/import-labels', { label: SMALL, leadSourceId: plain })).status).toBe(200);
    const smallPlans = [await enroll(small[0]!), await enroll(small[1]!), await enroll(small[2]!)];
    const smallDraft = await draftFor(small[3]!);
    // the source marked later: 12 people, four ways
    const own = [await ownedContact(agent), await ownedContact(agent), await ownedContact(agent), await ownedContact(agent), await ownedContact(agent)].map((c) => c.id);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = ANY ($1::uuid[])', [own, late]);
    const asked = (await ownedContact(agent)).id;
    await h.su.query(
      `INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, inquiry_type, fingerprint, received_at, outcome)
       VALUES ($1, $2, $3, $4, 'buy', decode(repeat('ab', 32), 'hex'), now(), 'attached')`,
      [w.tenantId, randomUUID(), asked, late],
    );
    const labelled = [await ownedContact(agent), await ownedContact(agent), await ownedContact(agent)].map((c) => c.id);
    let lateBatch: string | undefined;
    for (const id of labelled) lateBatch = (await importedPerson(h, w.tenantId, w.owner.userId!, id, { label: LATE, ...(lateBatch ? { batchId: lateBatch } : {}) })).batchId;
    const unlabelled = [await ownedContact(agent), await ownedContact(agent)].map((c) => c.id);
    for (const id of unlabelled) await importedPerson(h, w.tenantId, w.owner.userId!, id, { label: null, batchId: lateBatch! });
    // one of the source's own leads was merged into another record since: the person lives on in the survivor
    const survivor = (await ownedContact(agent)).id;
    const merged = await applyOwnershipCommand(w.owner.actor(), survivor as ContactId, { kind: 'merge', survivorId: survivor as ContactId, loserId: own[4] as ContactId, ownerChoice: null }, { commandId: randomUUID(), db: h.database });
    expect(merged.outcome.ok, JSON.stringify(merged.outcome)).toBe(true);
    await freshReauth(h, w.owner);
    for (const body of [{ label: LATE, leadSourceId: late }, { unlabeledImportId: lateBatch!, leadSourceId: late }]) {
      await freshReauth(h, w.owner);
      expect((await call(w.owner, 'PUT', '/lead-sources/import-labels', body)).status).toBe(200);
    }
    const latePlans = [await enroll(own[0]!), await enroll(asked), await enroll(labelled[0]!), await enroll(unlabelled[0]!), await enroll(survivor)];
    const lateDraft = await draftFor(own[1]!);
    mine.push(...small, ...own, asked, ...labelled, ...unlabelled, survivor);
    const before = await othersStillRunning();
    expect(before).toEqual({ plans: OTHERS_IN_A_PLAN, drafts: OTHERS_WITH_A_DRAFT });

    const probes0 = await inquiryProbes();
    // (1) the Owner moves the small label to the marked source
    await freshReauth(h, w.owner);
    let t0 = Date.now();
    const mapped = await call<Answer>(w.owner, 'PUT', '/lead-sources/import-labels', { label: SMALL, leadSourceId: marked });
    const mapMs = Date.now() - t0;
    expect([mapped.status, mapped.body.stopping, mapped.body.pausing, mapped.body.withdrawn]).toEqual([200, 3, 0, 1]);
    expect(await draftStatus(smallDraft)).toEqual({ status: 'invalidated', reason: SOURCE_NO_AUTOMATED_CONTACT });
    // (2) the Owner turns the setting on for the other source
    await freshReauth(h, w.owner);
    t0 = Date.now();
    const on = await call<Answer>(w.owner, 'PUT', `/lead-sources/${late}/ai-care`, { noAiCare: true });
    const onMs = Date.now() - t0;
    expect([on.status, on.body.stopping, on.body.pausing, on.body.withdrawn]).toEqual([200, 5, 0, 1]);
    expect(await draftStatus(lateDraft)).toEqual({ status: 'invalidated', reason: SOURCE_NO_AUTOMATED_CONTACT });
    const probes = (await inquiryProbes()) - probes0;

    console.info('R-LSRC-10 stop at volume', { 'map a 10-person label to a marked source (ms)': mapMs, 'turn the setting on for a 12-person source (ms)': onMs, 'index scans of lead_inquiries by the two requests': probes });
    expect(mapMs, 'map to a marked source').toBeLessThan(BUDGET_MS);
    expect(onMs, 'turn the setting on').toBeLessThan(BUDGET_MS);
    // the definer was asked about the two sources' own people only: never once per plan or draft of the team
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThan(500);

    // their plans stop, for the marked source's reason; nobody else's plan or draft was touched
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    for (const id of [...smallPlans, ...latePlans]) expect(await enrollmentRow(h, id)).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
    expect(await othersStillRunning()).toEqual(before);
  }, 600_000);
});
