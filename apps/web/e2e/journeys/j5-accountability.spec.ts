// J5 — response accountability, against the REAL API (journeys/stack.ts: a fresh Postgres database, RLS-bound
// app_user, fake providers only), on the phone (iPhone 13, 390×844) and desktop (1440×900) projects (the Team
// Lead queue is desktop-first; it is run on both):
//   1. a routed lead is accepted by its agent, who then only (a) logs an outside call on the person's page
//      (R-PAR-30: a note with source logged_activity, never a messages/calls row) and (b) sends the person a
//      bulk email (a real bulk action through the real runner; the email reaches the fake provider). Neither
//      is a touch (R-PAR-32, R-PAR-37): no first_touch_recorded, no last_human_touch_at, 0 touches in
//      v_agent_activity_daily, and the bulk message keeps its bulk_action_id;
//   2. the first-touch deadline passes (stored-deadline clock fixture) and the real timer job writes
//      first_touch_breached; the exception scan (enqueued exactly as maintenance does, run on the real
//      worker) raises the untouched-lead item for that period;
//   3. the Team Lead sees the "Untouched lead" card on the Needs attention queue, with the logged call shown as
//      context, reassigns it to the other agent (2 taps) — the ownership engine moves the lead (ledger
//      reassigned EXCEPTION_REASSIGN, an exception event citing that command) — and then verifies it: the
//      live counts go from 1 to 0 and the item moves to Handled.
import { randomUUID } from 'node:crypto';
import { expect, test } from 'playwright/test';
import { isPhone, pollSends, pollSql, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({
    imports: `import { marketingReady } from './src/bulk/testing.ts';\nimport { enqueueTenantScan } from './src/accountability/testing.ts';`,
    routes: `
  /** a verified sending domain, an identity per member, the brokerage postal address (bulk email needs them, R-PAR-39) */
  async '/marketing-ready'(b) { await marketingReady(h, world(b.world)); return { ok: true }; },
  /** the periodic exception scan, enqueued exactly as the maintenance pass does (dedupe periodic:exception.recompute) */
  async '/exception-scan'(b) { return { enqueued: await enqueueTenantScan(h, world(b.world).tenantId) }; },
`,
  });
  w = await stack.world({ agents: 2, teamLead: true });
  await stack.fixture('/marketing-ready', {});
});
test.afterAll(async () => {
  await stack?.stop();
});

const clientOf = (userId: string) => `a.agent${w.agents.findIndex((a) => a.userId === userId)}`;

test('J5: a lead whose agent only logged an outside call and sent a bulk email misses its first touch; the Team Lead reassigns it from the queue and the counts update', async ({ page }, info) => {
  test.setTimeout(240_000);
  const tag = info.project.name === 'phone' ? 'Phone' : 'Desk';
  const name = `Nadia ${tag}`;
  const { phone, email } = await stack.fixture<{ phone: string; email: string }>('/phone');

  // 1. routed and accepted (API: J1 proves the accept tap)
  const intake = await stack.fixture<{ status: number; body: { contactId: string } }>('/intake', { body: { fullName: name, phones: [phone], emails: [email], postalCode: '94610' } });
  expect(intake.status).toBe(201);
  const id = intake.body.contactId;
  const [offer] = await stack.sql<{ offered_to_user_id: string; offer_id: string }>('SELECT offered_to_user_id, offer_id FROM contacts WHERE id = $1', [id]);
  const owner = w.agents.find((a) => a.userId === offer!.offered_to_user_id)!;
  const other = w.agents.find((a) => a.userId !== owner.userId)!;
  expect((await stack.api(clientOf(owner.userId), 'POST', `/leads/${id}/accept`, { commandId: randomUUID(), offerId: offer!.offer_id })).status).toBe(200);
  const [period] = await stack.sql<{ ownership_period_seq: string }>('SELECT ownership_period_seq FROM contacts WHERE id = $1', [id]);

  // 1a. the agent logs an outside call on the person's page: Log (Call preselected) → Talked → Save
  await signIn(page, stack, owner);
  await page.goto(`${stack.webUrl}/contacts/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 15_000 });
  const taps = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Log', exact: true }), taps);
  const sheet = page.getByRole('dialog', { name: `Log for ${name}` });
  await expect(sheet.getByText(/doesn’t count as reaching Nadia/)).toBeVisible();
  await tap(page, sheet.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: 'Talked' }), taps);
  await sheet.getByLabel('Note (optional)').fill('Called from my cell, she is touring Saturday');
  await shot(page, info, 'j5', '1-log-call');
  await tap(page, sheet.getByRole('button', { name: 'Save', exact: true }), taps);
  await expect(page.getByTestId('people-toast').getByText(/^Call logged/)).toBeVisible({ timeout: 15_000 });
  expect(taps.taps, 'PARITY_PLAN §5: log an outside call = 3').toBe(3);
  await pollSql(stack, "SELECT 1 FROM notes WHERE contact_id = $1 AND source = 'logged_activity'", [id], (r) => r.length === 1);
  expect(await stack.sql('SELECT 1 FROM calls WHERE contact_id = $1', [id])).toHaveLength(0);

  // 1b. a bulk email to the person (the real bulk action: draft → confirm → the runner on the worker)
  const tpl = await stack.api<{ template: { id: string } }>(clientOf(owner.userId), 'POST', '/templates', { scope: 'personal', channel: 'email', name: `News ${tag}`, subject: 'New homes for {{contact.first_name}}', body: 'Hi {{contact.first_name}}, three new listings this week.' });
  expect(tpl.status).toBe(201);
  const draft = await stack.api<{ action: { id: string; targetCount: number } }>(clientOf(owner.userId), 'POST', '/bulk-actions', { kind: 'email', selection: { contactIds: [id] }, templateId: tpl.body.template.id, idempotencyKey: `j5-${randomUUID()}` });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  expect(draft.body.action.targetCount).toBe(1);
  const conf = await stack.api(clientOf(owner.userId), 'POST', `/bulk-actions/${draft.body.action.id}/confirm`);
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  await expect.poll(async () => {
    await stack.jobs({ tenantId: w.tenantId });
    return (await stack.sends()).emails.filter((m) => m.to === email).length;
  }, { timeout: 30_000 }).toBe(1);
  const bulkMsgs = await stack.sql<{ bulk_action_id: string | null; status: string }>("SELECT bulk_action_id, status FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [id]);
  expect(bulkMsgs).toEqual([{ bulk_action_id: draft.body.action.id, status: expect.stringMatching(/^(sent|delivered|dispatch_unknown)$/) }]);

  // neither counts as a touch (R-PAR-32, R-PAR-37)
  const touchState = async () => ({
    recorded: (await stack.sql("SELECT 1 FROM lead_ownership_events WHERE contact_id = $1 AND type = 'first_touch_recorded'", [id])).length,
    last: (await stack.sql<{ t: string | null }>('SELECT last_human_touch_at AS t FROM contacts WHERE id = $1', [id]))[0]!.t,
    touches: Number((await stack.sql<{ n: string }>('SELECT coalesce(sum(touches), 0) AS n FROM v_agent_activity_daily WHERE user_id = $1', [owner.userId]))[0]!.n),
  });
  expect(await touchState()).toEqual({ recorded: 0, last: null, touches: 0 });
  // nothing was texted or called
  const sends = await stack.sends();
  expect(sends.sms.filter((m) => m.to === phone)).toHaveLength(0);
  expect(sends.calls.filter((c) => c.to === phone)).toHaveLength(0);

  // 2. the first-touch deadline passes: the real timer writes the breach, the scan raises the item
  await stack.fixture('/clock/period', { contactId: id, dueMs: -60_000, releaseMs: 86_400_000 });
  await expect.poll(async () => {
    await stack.jobs({ kinds: ['ownership.first_touch_breach'], tenantId: w.tenantId });
    return (await stack.sql("SELECT 1 FROM lead_ownership_events WHERE contact_id = $1 AND type = 'first_touch_breached'", [id])).length;
  }, { timeout: 20_000 }).toBe(1);
  const key = `untouched:${id}:${period!.ownership_period_seq}`;
  await expect.poll(async () => {
    await stack.fixture('/exception-scan', { world: 'a' });
    await stack.jobs({ kinds: ['exception.recompute'], tenantId: w.tenantId });
    return (await stack.sql('SELECT owner_user_id FROM exception_items WHERE dedupe_key = $1', [key])).length;
  }, { timeout: 30_000 }).toBe(1);
  expect(await touchState()).toEqual({ recorded: 0, last: null, touches: 0 });

  // 3. the Team Lead's queue
  await page.context().clearCookies();
  await signIn(page, stack, w.lead!);
  await page.goto(`${stack.webUrl}/team`);
  const typeGroup = page.getByRole('group', { name: 'Type' }).or(page.getByRole('radiogroup', { name: 'Type' }));
  await expect(typeGroup.getByText('All 1', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(typeGroup.getByText('Untouched leads 1', { exact: true })).toBeVisible();
  const card = page.locator('article').filter({ has: page.getByRole('heading', { level: 2, name: `Untouched lead · ${name}` }) });
  await expect(card).toBeVisible();
  await expect(card.getByRole('list', { name: 'Evidence' })).toContainText('No human call, text or email by the first-contact deadline');
  // R-PAR-32 also wants the logged call on this card as context: not built, see the fixme below
  await shot(page, info, 'j5', '2-queue');

  const reassignTaps = { taps: 0 };
  await tap(page, card.getByRole('button', { name: 'Reassign' }), reassignTaps);
  const picker = card.getByRole('group', { name: 'Reassign to' });
  await expect(picker).toBeVisible();
  await shot(page, info, 'j5', '3-reassign-picker');
  await tap(page, picker.getByRole('button', { name: 'Member agent', exact: true }), reassignTaps);
  await expect(page.getByText(`Reassigned ${name} to Member agent`)).toBeVisible({ timeout: 15_000 });
  expect(reassignTaps.taps).toBe(2);
  const [after] = await stack.sql<{ owner_user_id: string; ownership_state: string }>('SELECT owner_user_id, ownership_state FROM contacts WHERE id = $1', [id]);
  expect(after).toEqual({ owner_user_id: other.userId, ownership_state: 'owned' });
  const led = (await stack.sql<{ type: string; reason_code: string; actor_user_id: string; command_id: string }>('SELECT type, reason_code, actor_user_id, command_id FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq DESC LIMIT 1', [id]))[0]!;
  expect(led).toMatchObject({ type: 'reassigned', reason_code: 'EXCEPTION_REASSIGN', actor_user_id: w.lead!.userId });
  const events = await stack.sql<{ action: string; ownership_command_id: string }>('SELECT action, ownership_command_id FROM exception_events WHERE exception_dedupe_key = $1', [key]);
  expect(events).toEqual([{ action: 'reassigned', ownership_command_id: led.command_id }]);
  // the missed period stays with the agent who missed it; the item stays live until verified
  await expect(card.getByText(/^Reassigned by /)).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'j5', '4-reassigned');

  await tap(page, card.getByRole('button', { name: 'Verify' }));
  await expect(page.getByText(`Verified: Untouched lead for ${name}`)).toBeVisible({ timeout: 15_000 });
  await expect(typeGroup.getByText('All 0', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(typeGroup.getByText('Untouched leads 0', { exact: true })).toBeVisible();
  expect((await stack.sql<{ action: string }>('SELECT action FROM exception_events WHERE exception_dedupe_key = $1 ORDER BY occurred_at', [key])).map((e) => e.action)).toEqual(['reassigned', 'verified']);
  await shot(page, info, 'j5', '5-verified');
  // the bulk email and the logged call still count as nothing for the missing agent
  expect((await touchState()).touches).toBe(0);
  // the new owner was told (a notification for the reassigned lead)
  await pollSql(stack, 'SELECT 1 FROM notifications WHERE user_id = $1 AND subject_id = $2', [other.userId, id], (r) => r.length >= 1);
  if (isPhone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // the bulk email never reached the provider twice
  await pollSends(stack, (s) => s.emails.filter((m) => m.to === email).length, (n) => n === 1);
});

// BUG (Medium, open): R-PAR-32 says "The Team Lead's exception card shows logged activities in the period as
// context". Nothing reads them: apps/api/src/accountability/** and core's exception derivation never look at
// notes with source = 'logged_activity', so the untouched-lead card's evidence is only "No human call, text or
// email by the first-contact deadline" and "Lead became theirs". The TL cannot see that the agent says they
// called from their own phone. Repro: the journey above (the agent logs a Talked call before the deadline;
// GET /api/team/exceptions as the Team Lead has no evidence row for the note). Needs the evidence model
// (core + accountability view + TeamPage), so it is not a small fix. Remove the fixme when built.
test.fixme('J5 R-PAR-32: the untouched-lead card shows the agent\'s logged outside call as context', async ({ page }) => {
  await signIn(page, stack, w.lead!);
  await page.goto(`${stack.webUrl}/team`);
  const card = page.locator('article').filter({ has: page.getByRole('heading', { level: 2, name: /^Untouched lead · Nadia / }) }).first();
  await expect(card.getByRole('list', { name: 'Evidence' })).toContainText(/Logged by /);
});
