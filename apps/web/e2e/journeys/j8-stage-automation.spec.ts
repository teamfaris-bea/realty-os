// J8 — stage automation end to end, against the REAL API (journeys/stack.ts: a fresh Postgres database, RLS-bound
// app_user, fake providers only), on the phone (iPhone 13) and desktop (1440 px) projects:
//   the agent's own "Buyer plan" (an agent playbook, created and approved through the API as the agent, set to
//   start when a person's stage becomes Active) → on the person's page the agent taps the stage pill → Active
//   (2 taps) → the toast says "Started Buyer plan" → the decision row and a live enrollment (enrolled by the
//   stage change) exist → the plan's first step runs on the real worker and its text reaches the fake provider
//   once, as an assistant message (never a human touch).
//   A person who texted STOP (through the signed inbound webhook): the same 2 taps change the stage, the toast
//   says why the plan did not start ("they can't be messaged"), the decision is `skipped / cannot_be_reached`,
//   no enrollment exists, and nothing reaches the provider for them, even after the worker runs.
// The existing stage-automation/stage.spec.ts covers the toast wording and Undo on the agent stack; this journey
// adds the database, the worker and the provider.
import { randomUUID } from 'node:crypto';
import { type Page, expect, test } from 'playwright/test';
import { shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;
let agent: WorldInfo['agents'][number];
let playbookId: string;

const STEP = { stepKey: 'check_in', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', template: 'Hi {{first_name}}, checking in on your home search.', personalization: 'none', slots: ['first_name'], maxLength: 640, stopIf: [] };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack();
  w = await stack.world({ agents: 1 });
  agent = w.agents[0]!;
  const c = await stack.api<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>('a.agent0', 'POST', '/playbooks', { kind: 'nurture', scope: 'agent', name: 'Buyer plan', steps: [STEP] });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  playbookId = c.body.playbook.id;
  const v = c.body.playbook.versions[0]!;
  const a = await stack.api('a.agent0', 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  const st = await stack.api('a.agent0', 'PUT', `/playbooks/${playbookId}/auto-enroll-stage`, { stage: 'active' });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
});
test.afterAll(async () => {
  await stack?.stop();
});

async function person(first: string, last: string): Promise<{ id: string; phone: string; name: string }> {
  const { phone, email } = await stack.fixture<{ phone: string; email: string }>('/phone');
  const r = await stack.api<{ contact: { id: string; displayName: string } }>('a.agent0', 'POST', '/contacts', { commandId: randomUUID(), firstName: first, lastName: last, phones: [phone], emails: [email], intent: 'buyer' });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return { id: r.body.contact.id, phone, name: r.body.contact.displayName };
}

async function toActive(page: Page, p: { id: string; name: string }) {
  await page.goto(`${stack.webUrl}/contacts/${p.id}`);
  await expect(page.getByRole('heading', { level: 1, name: p.name })).toBeVisible({ timeout: 15_000 });
  const n = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Stage: New. Change stage' }), n);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: /^Active/ }), n);
  expect(n.taps).toBe(2);
}

const decisions = (contactId: string) => stack.sql<{ outcome: string; reason: string | null; playbook_id: string; enrollment_id: string | null; to_stage: string }>('SELECT outcome, reason, playbook_id, enrollment_id, to_stage FROM stage_automation_decisions WHERE contact_id = $1', [contactId]);
const enrollments = (contactId: string) => stack.sql<{ id: string; state: string; enrolled_by: string; playbook_id: string }>('SELECT id, state, enrolled_by, playbook_id FROM playbook_enrollments WHERE contact_id = $1', [contactId]);

test('J8: Stage → Active starts the Buyer plan; the toast says so; the enrollment runs its first step through the fake provider once', async ({ page }, info) => {
  test.setTimeout(120_000);
  const amy = await person('Amy', info.project.name === 'phone' ? 'Phone' : 'Desk');
  await signIn(page, stack, agent);
  await toActive(page, amy);
  const toast = page.getByTestId('people-toast');
  await expect(toast.getByText('Stage: Active. Started Buyer plan')).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'j8', '1-plan-started');

  const [d] = await decisions(amy.id);
  expect(d).toMatchObject({ outcome: 'started', reason: null, playbook_id: playbookId, to_stage: 'active' });
  const en = await enrollments(amy.id);
  expect(en).toHaveLength(1);
  expect(en[0]).toMatchObject({ id: d!.enrollment_id, state: 'active', enrolled_by: 'stage_change', playbook_id: playbookId });

  // the plan's first step (due at enrollment) runs on the real worker: one text, through the fake provider
  await expect
    .poll(async () => {
      await stack.fixture('/pjobs');
      return (await stack.sends()).sms.filter((m) => m.to === amy.phone).length;
    }, { timeout: 30_000 })
    .toBe(1);
  const sms = (await stack.sends()).sms.filter((m) => m.to === amy.phone);
  expect(sms[0]!.body).toContain('checking in on your home search');
  expect(sms[0]!.from).toBe(w.mainNumber);
  const msgs = await stack.sql<{ status: string; initiator: string; playbook_step_run_id: string | null }>("SELECT status, initiator, playbook_step_run_id FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [amy.id]);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ status: 'sent', initiator: 'assistant' });
  expect(msgs[0]!.playbook_step_run_id).not.toBeNull();
  // an assistant step is never a human touch (R-OWN-14)
  expect(await stack.sql("SELECT 1 FROM lead_ownership_events WHERE contact_id = $1 AND type = 'first_touch_recorded'", [amy.id])).toHaveLength(0);
  // running the worker again sends nothing more
  await stack.fixture('/pjobs');
  expect((await stack.sends()).sms.filter((m) => m.to === amy.phone)).toHaveLength(1);
});

test('J8: a person who texted STOP: the stage changes, the toast says why the plan did not start, no enrollment, nothing sent', async ({ page }, info) => {
  test.setTimeout(120_000);
  const bo = await person('Bo', info.project.name === 'phone' ? 'Phone' : 'Desk');
  expect((await stack.fixture<{ status: number }>('/sms-in', { from: bo.phone, body: 'STOP' })).status).toBeLessThan(300);
  await signIn(page, stack, agent);
  await toActive(page, bo);
  const toast = page.getByTestId('people-toast');
  await expect(toast.getByText("Stage: Active. Buyer plan didn't start: they can't be messaged")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Stage: Active. Change stage' })).toBeVisible();
  await shot(page, info, 'j8', '2-plan-skipped-optout');

  expect(await decisions(bo.id)).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'cannot_be_reached', playbook_id: playbookId, enrollment_id: null })]);
  expect(await enrollments(bo.id)).toHaveLength(0);
  const [stage] = await stack.sql<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [bo.id]);
  expect(stage!.stage).toBe('active');
  await stack.fixture('/pjobs');
  const sends = await stack.sends();
  // nothing but (at most) the STOP confirmation the system may send to the number that texted STOP
  expect(sends.sms.filter((m) => m.to === bo.phone && !/unsubscribed|opted out|no more/i.test(m.body))).toHaveLength(0);
  expect(await stack.sql("SELECT 1 FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND playbook_step_run_id IS NOT NULL", [bo.id])).toHaveLength(0);
});
