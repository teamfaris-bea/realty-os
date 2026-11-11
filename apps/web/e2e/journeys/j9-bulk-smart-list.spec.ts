// J9 — bulk email from a smart list, against the REAL API (journeys/stack.ts: a fresh Postgres database,
// RLS-bound app_user, fake providers only), on the phone (iPhone 13, 390×844) and desktop (1440×900)
// projects. The agent opens the smart list "Hot buyers" on the People page, selects everyone, picks Email
// and a template, and confirms on the count sheet (PARITY_PLAN §5):
//   - the member who unsubscribed from email is left out BEFORE Confirm, counted under "opted out", with
//     no box to include them (D1: no override, bulk is no exception; R-PAR-36);
//   - the worker sends exactly one email per remaining person (the fake provider's record), and running the
//     worker again sends nothing more;
//   - R-PAR-37: a bulk message is never a touch: the accepted lead in the list keeps no first touch, no
//     last human touch, and her first-touch deadline is unchanged; every bulk message keeps its
//     bulk_action_id.
import { randomUUID } from 'node:crypto';
import { expect, test } from 'playwright/test';
import { drainUntil, isPhone, pollSql, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;
const AGENT = 'a.agent0';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({
    imports: "import { marketingReady } from './src/bulk/testing.ts';",
    routes: String.raw`
  /** a verified sending domain, an email identity per member, the brokerage postal address (R-PAR-39) */
  async '/marketing-ready'(b) { await marketingReady(h, world(b.world)); return { ok: true }; },`,
  });
  w = await stack.world({ agents: 1 });
  await stack.fixture('/marketing-ready', { world: 'a' });
});
test.afterAll(async () => {
  await stack?.stop();
});

async function must<T>(p: Promise<{ status: number; body: T }>, ok: number[] = [200, 201]): Promise<T> {
  const r = await p;
  expect(ok, JSON.stringify(r.body)).toContain(r.status);
  return r.body;
}

test('J9: a bulk email to a smart list leaves out the unsubscribed member with the reason, emails everyone else exactly once, and counts no touch', async ({ page }, info) => {
  test.setTimeout(180_000);
  const tag = isPhone(page) ? 'Phone' : 'Desk';
  const listName = `Hot buyers ${tag}`;

  // the list's members: an accepted portal lead (an open first-touch window), a sphere contact, and one
  // who unsubscribed from email
  const ana = await stack.fixture<{ phone: string; email: string }>('/phone');
  const intake = await stack.fixture<{ status: number; body: { contactId: string } }>('/intake', { body: { fullName: `Ana ${tag}`, phones: [ana.phone], emails: [ana.email] } });
  expect(intake.status).toBe(201);
  const anaId = intake.body.contactId;
  const [offer] = await stack.sql<{ offer_id: string }>('SELECT offer_id FROM contacts WHERE id = $1', [anaId]);
  await must(stack.api(AGENT, 'POST', `/leads/${anaId}/accept`, { commandId: randomUUID(), offerId: offer!.offer_id }));
  const [before] = await stack.sql<{ first_touch_due_at: string; last_human_touch_at: string | null }>('SELECT first_touch_due_at, last_human_touch_at FROM contacts WHERE id = $1', [anaId]);
  expect(before!.first_touch_due_at).not.toBeNull();

  const mk = async (firstName: string) => {
    const a = await stack.fixture<{ phone: string; email: string }>('/phone');
    const c = await must(stack.api<{ contact: { id: string } }>(AGENT, 'POST', '/contacts', { commandId: randomUUID(), firstName, lastName: tag, phones: [a.phone], emails: [a.email] }));
    return { id: c.contact.id, email: a.email };
  };
  const ben = await mk('Ben');
  const cy = await mk('Cy');
  const [cyPoint] = await stack.sql<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [cy.id]);
  await must(stack.api(AGENT, 'POST', `/contacts/${cy.id}/consent`, { kind: 'revoke', pointId: cyPoint!.id, channel: 'email', purpose: 'all', evidence: { note: 'asked to stop emails' } }));

  const tagRow = await must(stack.api<{ tag: { id: string } }>(AGENT, 'POST', '/tags', { name: `Buyer ${tag}` }));
  for (const id of [anaId, ben.id, cy.id]) await must(stack.api(AGENT, 'POST', `/contacts/${id}/tags`, { tagIds: [tagRow.tag.id] }));
  await must(stack.api(AGENT, 'POST', '/smart-lists', { scope: 'personal', name: listName, definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [tagRow.tag.id] }] } }));
  await must(stack.api(AGENT, 'POST', '/templates', { scope: 'personal', channel: 'email', name: `New listings ${tag}`, subject: 'New homes for {{contact.first_name}}', body: 'Hi {{contact.first_name}}, three new listings this week.' }));

  // People → list → Select all → Email → template → (count sheet) Confirm
  await signIn(page, stack, w.agents[0]!);
  const c = { taps: 0 };
  if (isPhone(page)) await tap(page, page.getByRole('navigation').getByRole('link', { name: 'People', exact: true }).first(), c);
  else await page.goto(`${stack.webUrl}/people`);
  await tap(page, page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: listName }), c);
  await expect(page.getByText(/^3 people · Showing people you can see/)).toBeVisible({ timeout: 15_000 });
  await tap(page, page.getByRole('checkbox', { name: /Select all/ }), c);
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar.getByText('3 selected')).toBeVisible();
  await tap(page, bar.getByRole('button', { name: 'Email', exact: true }), c);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: new RegExp(`New listings ${tag}`) }), c);
  const sheet = page.getByRole('dialog', { name: 'Email 2 of 3?' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  const left = sheet.getByRole('region', { name: 'Left out (1)' });
  await expect(left.locator('[data-reason="RECIPIENT_OPTED_OUT"]')).toHaveText('1 opted out');
  await expect(sheet.getByRole('checkbox')).toHaveCount(0);
  await expect(sheet.getByText("Bulk messages don't count as touches on a lead.")).toBeVisible();
  await shot(page, info, 'j9', '1-count-sheet');
  await tap(page, sheet.getByRole('button', { name: 'Email 2 people' }), c);
  expect(c.taps).toBe(isPhone(page) ? 6 : 5); // PARITY_PLAN §5 bulk email: 6 on a phone, 5 on desktop

  // the action and its frozen items
  const [action] = await pollSql<{ id: string }>(stack, "SELECT id FROM bulk_actions WHERE kind = 'email' AND created_by_user_id = $1 AND status <> 'draft' ORDER BY created_at DESC LIMIT 1", [w.agents[0]!.userId], (r) => r.length === 1);
  const actionId = action!.id;
  const emailsTo = async (addr: string) => (await stack.sends()).emails.filter((m) => m.to === addr);
  await drainUntil(stack, async () => (await emailsTo(ana.email)).length > 0 && (await emailsTo(ben.email)).length > 0 && (await stack.sql<{ status: string }>('SELECT status FROM bulk_actions WHERE id = $1', [actionId]))[0]?.status === 'completed');
  // once per remaining person, never to the unsubscribed one; a second worker pass sends nothing more
  await stack.jobs();
  expect((await emailsTo(ana.email)).map((m) => m.subject)).toEqual([`New homes for Ana`]);
  expect((await emailsTo(ben.email)).map((m) => m.subject)).toEqual([`New homes for Ben`]);
  expect(await emailsTo(cy.email)).toEqual([]);
  const items = await stack.sql<{ contact_id: string; status: string; reason_code: string | null }>('SELECT contact_id, status, reason_code FROM bulk_action_items WHERE bulk_action_id = $1', [actionId]);
  expect(items.filter((i) => i.status === 'done').map((i) => i.contact_id).sort()).toEqual([anaId, ben.id].sort());
  const cyItem = items.find((i) => i.contact_id === cy.id);
  if (cyItem) expect(cyItem).toMatchObject({ status: expect.stringMatching(/skipped|blocked/), reason_code: 'RECIPIENT_OPTED_OUT' });
  const msgs = await stack.sql<{ contact_id: string; bulk_action_id: string | null }>("SELECT contact_id, bulk_action_id FROM messages WHERE direction = 'outbound' AND contact_id = ANY ($1)", [[anaId, ben.id, cy.id]]);
  expect(msgs).toHaveLength(2);
  expect(msgs.every((m) => m.bulk_action_id === actionId)).toBe(true);

  // R-PAR-37: no touch. Ana's period has no first touch, no last human touch, and the same deadline
  const touches = await stack.sql('SELECT type FROM lead_ownership_events WHERE contact_id = $1 AND type = $2', [anaId, 'first_touch_recorded']);
  expect(touches).toEqual([]);
  const [after] = await stack.sql<{ first_touch_due_at: string; last_human_touch_at: string | null }>('SELECT first_touch_due_at, last_human_touch_at FROM contacts WHERE id = $1', [anaId]);
  expect(after).toEqual(before);

  // the result page says the same in words
  await page.goto(`${stack.webUrl}/bulk/${actionId}`);
  await expect(page.getByRole('heading', { name: 'Emailed 2 of 3' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('list', { name: 'Why people were left out' }).locator('[data-reason="RECIPIENT_OPTED_OUT"]')).toHaveText('1 opted out');
  await shot(page, info, 'j9', '2-result');
});
