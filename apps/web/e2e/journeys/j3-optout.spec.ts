// J3 — opt-outs, against the REAL API (journeys/stack.ts: a fresh Postgres database, RLS-bound app_user,
// fake providers only), on the phone (iPhone 13, 390×844) and desktop (1440×900) projects.
// Owner decision D1: a send checks only opt-outs, with no override; template, bulk and playbook sends are
// no exception. Each case is checked on screen (the reason is said before the tap; Send is disabled; no
// "anyway" exists), in the database (messages.status/status_reason, gate_decisions, bulk items,
// enrollments) and in the fake provider's record of sends (nothing reached the opted-out person):
//   1. the client texts STOP through the signed inbound webhook; afterwards a one-to-one text, a template
//      text, a bulk text (batch text turned on by the Owner, R-PAR-40) and a playbook step are all blocked
//      with a clear reason;
//   2. R-PAR-12: the agent removes that phone and adds a new one on the person's page (phone: the edit
//      sheet's Remove + Add phone; desktop: the inline field, which replaces it): the STOP still blocks
//      every path, and the page says why ("…a number you removed (…) opted out…");
//   3. R-PAR-12's one exception: a number proven a wrong number by its own "wrong number" reply, then
//      removed as a confirmed wrong number on the person's page (the edit sheet offers "Remove as a wrong
//      number" only on that number, and says why it is not offered on the others), does not block the
//      person's other phone (that text is sent, exactly once).
import { randomUUID } from 'node:crypto';
import { type Page, expect, test } from 'playwright/test';
import { drainUntil, isPhone, last4, pollSql, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;
let tpl: string;
let planId: string;

const AGENT = 'a.agent0';
const today = () => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date());

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({
    imports: "import { BATCH_TEXT_ATTESTATION } from './src/bulk/batchText.ts';",
    routes: String.raw`
  /** the Owner turns batch text on through the real route: fresh re-auth + the typed attestation (R-PAR-40) */
  async '/batch-text-on'(b) {
    await freshReauth(h, client(b.as));
    const owner = client(b.as);
    const ww = world('a');
    // batch text needs an approved registration whose use case covers marketing on the team number (R-PAR-40)
    const reg = must(await call(owner, 'POST', '/sender-registrations', { kind: 'a2p_campaign', useCase: 'marketing', sampleMessages: ['New listings near you this week. Reply STOP to opt out.'], optInDescription: 'Leads opt in on our website form.' }), 'registration');
    must(await call(owner, 'POST', '/sender-registrations/' + reg.registration.id + '/refresh'), 'refresh');
    must(await call(owner, 'PATCH', '/numbers/' + ww.mainNumberId + '/registration', { registrationId: reg.registration.id }), 'attach');
    return must(await call(owner, 'PUT', '/batch-text', { enabled: true, attestation: BATCH_TEXT_ATTESTATION }), 'batch text');
  },`,
  });
  w = await stack.world({ agents: 1 });
  await stack.fixture('/batch-text-on', { as: 'a.owner' });
  // the agent's own text template and own approved plan (Stage → Active enrolls), all through the API
  const t = await stack.api<{ template: { id: string } }>(AGENT, 'POST', '/templates', { scope: 'personal', channel: 'sms', name: 'Showing follow-up', body: 'Hi {{contact.first_name}}, how was the showing today?' });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  tpl = t.body.template.id;
  const step = { stepKey: 'check_in', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 3600 }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', template: 'Hi {{first_name}}, checking in on your home search.', personalization: 'none', slots: ['first_name'], maxLength: 640, stopIf: [] };
  const pb = await stack.api<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(AGENT, 'POST', '/playbooks', { kind: 'nurture', scope: 'agent', name: 'Buyer plan', steps: [step] });
  expect(pb.status, JSON.stringify(pb.body)).toBe(201);
  planId = pb.body.playbook.id;
  const v = pb.body.playbook.versions[0]!;
  expect((await stack.api(AGENT, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 })).status).toBe(200);
  expect((await stack.api(AGENT, 'PUT', `/playbooks/${planId}/auto-enroll-stage`, { stage: 'active' })).status).toBe(200);
});
test.afterAll(async () => {
  await stack?.stop();
});

async function person(firstName: string, lastName: string, phones: string[]) {
  const { email } = await stack.fixture<{ email: string }>('/phone');
  const r = await stack.api<{ contact: { id: string; displayName: string } }>(AGENT, 'POST', '/contacts', { commandId: randomUUID(), firstName, lastName, phones, emails: [email], intent: 'buyer' });
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return { id: r.body.contact.id, name: r.body.contact.displayName };
}
const newPhone = async () => (await stack.fixture<{ phone: string }>('/phone')).phone;
const smsTo = async (phone: string) => (await stack.sends()).sms.filter((m) => m.to === phone);

/** One-to-one and template texts tried through the API as the agent: both blocked by the gate with the reason, recorded. */
async function apiAttemptsBlocked(contactId: string) {
  const one = await stack.api<{ result: string; message: { id: string; status: string; statusReason: string } | null; decision: { outcome: string; reasons: string[] } | null }>(AGENT, 'POST', `/contacts/${contactId}/messages`, { channel: 'sms', body: 'Still interested in the condo?', idempotencyKey: `k-${randomUUID()}` });
  expect(one.status).toBe(200);
  expect(one.body).toMatchObject({ result: 'blocked', message: { status: 'blocked', statusReason: 'CONSENT_REVOKED' }, decision: { outcome: 'deny', reasons: ['CONSENT_REVOKED'] } });
  const rendered = await stack.api<{ rendered: { body: string } }>(AGENT, 'POST', `/templates/${tpl}/render`, { contactId });
  expect(rendered.status).toBe(200);
  const viaTpl = await stack.api<{ result: string; message: { id: string; status: string; statusReason: string } | null }>(AGENT, 'POST', `/contacts/${contactId}/messages`, { channel: 'sms', body: rendered.body.rendered.body, idempotencyKey: `k-${randomUUID()}` });
  expect(viaTpl.body).toMatchObject({ result: 'blocked', message: { status: 'blocked', statusReason: 'CONSENT_REVOKED' } });
  for (const id of [one.body.message!.id, viaTpl.body.message!.id]) {
    const d = await stack.sql<{ outcome: string; reason_codes: string[] }>('SELECT outcome, reason_codes FROM gate_decisions WHERE message_id = $1', [id]);
    expect(d).toEqual([{ outcome: 'deny', reason_codes: ['CONSENT_REVOKED'] }]);
  }
}

/** A bulk text of the template to the opted-out person and a clean one: the opted-out person is left out by reason, the other is texted once. */
async function bulkTextLeavesOut(optedOut: string, clean: { id: string; phone: string }) {
  const d = await stack.api<{ action: { id: string; targetCount: number; selected: number; preflight: Record<string, number> } }>(AGENT, 'POST', '/bulk-actions', { kind: 'text', selection: { contactIds: [optedOut, clean.id] }, templateId: tpl, idempotencyKey: `bulk-${randomUUID()}` });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  expect(d.body.action).toMatchObject({ selected: 2, targetCount: 1 });
  const id = d.body.action.id;
  expect((await stack.api(AGENT, 'POST', `/bulk-actions/${id}/confirm`)).status).toBe(200);
  await drainUntil(stack, async () => (await stack.sql<{ status: string }>('SELECT status FROM bulk_actions WHERE id = $1', [id]))[0]?.status === 'completed');
  const items = await stack.sql<{ contact_id: string; status: string; reason_code: string | null; message_id: string | null }>('SELECT contact_id, status, reason_code, message_id FROM bulk_action_items WHERE bulk_action_id = $1', [id]);
  const out = items.find((i) => i.contact_id === optedOut);
  // left out at the freeze (no item), or an item skipped/blocked with the opt-out reason and no message
  if (out) expect(out).toMatchObject({ status: expect.stringMatching(/skipped|blocked/), message_id: null });
  expect(d.body.action.preflight).toMatchObject({ RECIPIENT_OPTED_OUT: 1 });
  await drainUntil(stack, async () => (await smsTo(clean.phone)).length > 0);
  expect(await smsTo(clean.phone)).toHaveLength(1);
  return d.body.action.preflight;
}

async function contactPage(page: Page, id: string, name: string) {
  await page.goto(`${stack.webUrl}/contacts/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 15_000 });
}

test('J3.1 after STOP, a one-to-one text, a template text, a bulk text and a playbook step are all blocked with the reason; nothing reaches the provider', async ({ page }, info) => {
  test.setTimeout(180_000);
  const tag = isPhone(page) ? 'Phone' : 'Desk';
  const p1 = await newPhone();
  const owen = await person('Owen', `Stop${tag}`, [p1]);
  const anaPhone = await newPhone();
  const ana = await person('Ana', `Clean${tag}`, [anaPhone]);
  // Owen is in the agent's plan BEFORE he opts out (Stage → Active enrolls him)
  const st = await stack.api<{ automation: { kind: string } | null }>(AGENT, 'POST', `/contacts/${owen.id}/stage`, { stage: 'active' });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const [enr] = await stack.sql<{ id: string; state: string }>('SELECT id, state FROM playbook_enrollments WHERE contact_id = $1 AND playbook_id = $2', [owen.id, planId]);
  expect(enr?.state).toBe('active');

  // the client texts STOP through the signed inbound webhook
  expect((await stack.fixture<{ status: number }>('/sms-in', { from: p1, body: 'STOP' })).status).toBeLessThan(300);
  const afterStop = (await smsTo(p1)).length; // the provider sends the STOP confirmation itself (default): normally 0

  // on screen: the reason before any tap, Text disabled, and no "anyway" anywhere
  await signIn(page, stack, w.agents[0]!);
  await contactPage(page, owen.id, owen.name);
  const sentence = `Texted STOP on ${today()}`;
  await expect(page.getByText(sentence, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await shot(page, info, 'j3', '1-stopped-contact');
  await page.goto(`${stack.webUrl}/contacts/${owen.id}/thread?compose=sms`);
  const box = page.getByRole('textbox', { name: 'Text message' });
  await box.fill('Still interested in the condo?');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await expect(send).toHaveAccessibleDescription(sentence);
  // the template text: Templates → template fills the box; Send stays disabled
  await tap(page, page.getByRole('button', { name: 'Templates' }));
  await tap(page, page.getByRole('dialog', { name: 'Text templates' }).getByRole('button', { name: /Showing follow-up/ }));
  await expect(box).toHaveValue('Hi Owen, how was the showing today?');
  await expect(send).toBeDisabled();
  await expect(page.getByRole('button', { name: /anyway/i })).toHaveCount(0);
  await shot(page, info, 'j3', '2-template-blocked');

  // the same sends made straight at the API (a stale screen, a retry): refused by the gate, recorded
  await apiAttemptsBlocked(owen.id);
  await page.reload();
  await expect(page.getByText(`Not sent: texted STOP on ${today()}`).first()).toBeVisible({ timeout: 15_000 });

  // the bulk text: the sheet counts Owen under "opted out" before Confirm; only Ana is texted
  await page.goto(`${stack.webUrl}/bulk/new?kind=text&contacts=${owen.id},${ana.id}`);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: /Showing follow-up/ }));
  const sheet = page.getByRole('dialog', { name: 'Text 1 of 2?' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('region', { name: 'Left out (1)' }).locator('[data-reason="RECIPIENT_OPTED_OUT"]')).toHaveText('1 opted out');
  await expect(sheet.getByRole('checkbox')).toHaveCount(0);
  await shot(page, info, 'j3', '3-bulk-text-sheet');
  await tap(page, sheet.getByRole('button', { name: 'Text 1 person' }));
  await expect(page).toHaveURL(/\/bulk\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const bulkId = new URL(page.url()).pathname.split('/').at(-1)!;
  await drainUntil(stack, async () => (await stack.sql<{ status: string }>('SELECT status FROM bulk_actions WHERE id = $1', [bulkId]))[0]?.status === 'completed');
  // each bulk message is its own messages row dispatched by the worker (R-PAR-36): run it until Ana's text is out
  await drainUntil(stack, async () => (await smsTo(anaPhone)).length > 0);
  expect(await smsTo(anaPhone)).toHaveLength(1);
  const owenItem = await stack.sql<{ status: string; message_id: string | null }>('SELECT status, message_id FROM bulk_action_items WHERE bulk_action_id = $1 AND contact_id = $2', [bulkId, owen.id]);
  for (const i of owenItem) expect(i.message_id).toBeNull();

  // the playbook step: Owen's STOP paused his enrollment with the opt-out reason; running the step's
  // job sends nothing, and resuming it does not get past the opt-out either
  const paused = await pollSql<{ state: string; pause_reason: string | null }>(stack, 'SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [enr!.id], (r) => r[0]?.state !== 'active');
  expect(paused[0]).toMatchObject({ state: 'paused', pause_reason: 'opt_out' });
  const resumed = await stack.api(AGENT, 'POST', `/enrollments/${enr!.id}/resume`);
  await stack.jobs({ kinds: ['playbook.step', 'comms.dispatch'], tenantId: w.tenantId });
  const [after] = await stack.sql<{ state: string; pause_reason: string | null }>('SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [enr!.id]);
  const stepMsgs = await stack.sql<{ status: string; status_reason: string | null }>("SELECT status, status_reason FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND status NOT IN ('blocked','canceled')", [owen.id]);
  expect(stepMsgs, `resume answered ${resumed.status} ${JSON.stringify(resumed.body)}; enrollment ${JSON.stringify(after)}`).toEqual([]);

  // nothing reached Owen's number after his STOP, by any path
  expect(await smsTo(p1)).toHaveLength(afterStop);
});

test('J3.2 R-PAR-12: the agent removes the STOP phone and adds a new one; the STOP still blocks every path and the page says why', async ({ page }, info) => {
  test.setTimeout(180_000);
  const tag = isPhone(page) ? 'Phone' : 'Desk';
  const p1 = await newPhone();
  const p2 = await newPhone();
  const rae = await person('Rae', `Moved${tag}`, [p1]);
  const benPhone = await newPhone();
  const ben = await person('Ben', `Clean${tag}`, [benPhone]);
  expect((await stack.fixture<{ status: number }>('/sms-in', { from: p1, body: 'STOP' })).status).toBeLessThan(300);

  await signIn(page, stack, w.agents[0]!);
  await contactPage(page, rae.id, rae.name);
  const details = page.getByRole('region', { name: 'Details' });
  const fmt = (e164: string) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  if (isPhone(page)) {
    // phone: Details ✎ → Remove the old number → Add phone → Save
    await tap(page, details.getByRole('button', { name: `Edit details of ${rae.name}` }));
    const sheet = page.getByRole('dialog', { name: `Edit ${rae.name}` });
    const phoneRow = sheet.locator('div').filter({ has: page.getByRole('textbox', { name: /^Phone/ }) }).filter({ has: page.getByRole('button', { name: 'Remove' }) }).last();
    await tap(page, phoneRow.getByRole('button', { name: 'Remove' }));
    await expect(sheet.getByRole('textbox', { name: /^Phone/ })).toHaveCount(0);
    await tap(page, sheet.getByRole('button', { name: 'Add phone' }));
    await sheet.getByRole('textbox', { name: /^Phone/ }).fill(fmt(p2));
    await tap(page, sheet.getByRole('button', { name: 'Save' }));
    await expect(sheet).toHaveCount(0);
  } else {
    // desktop: the number is an inline field; typing the new one and Enter replaces it (remove + add)
    // the number's inline field (its label is its kind label, "mobile"; the email's is "other")
    const field = details.getByRole('textbox', { name: 'mobile', exact: true });
    await expect(field).toHaveValue(fmt(p1), { timeout: 15_000 });
    await field.fill(fmt(p2));
    await field.press('Enter');
    await expect(page.getByTestId('people-toast').getByText('Number replaced')).toBeVisible({ timeout: 15_000 });
  }
  const pts = await pollSql<{ address: string; status: string; removed_reason: string | null }>(stack, 'SELECT address, status, removed_reason FROM contact_points WHERE contact_id = $1 AND kind = $2 ORDER BY created_at', [rae.id, 'phone'], (r) => r.length === 2 && r.some((x) => x.address === p2));
  expect(pts.find((x) => x.address === p1)).toMatchObject({ status: 'removed', removed_reason: expect.stringMatching(/^(old|replaced)$/) });
  expect(pts.find((x) => x.address === p2)?.status).not.toBe('removed');

  // the page says why texting is still blocked, and Text is disabled
  await page.reload();
  await expect(page.getByText(`Texting Rae is blocked because a number you removed (${'•••'}${last4(p1)}) opted out. Rae can text START from it to opt back in.`, { exact: false }).or(page.getByText(/Texting Rae is blocked because a number you removed \(.*\) opted out\./))).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await shot(page, info, 'j3', '4-removed-phone-still-blocked');
  const caption = await page.getByRole('button', { name: 'Text', exact: true }).evaluate((el) => el.getAttribute('aria-describedby') ? document.getElementById(el.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent ?? '' : '');
  expect(caption).toMatch(/Texted STOP/);
  // the caption names the removed number's STOP as the removed number's, and the masked number never breaks
  // across lines (non-breaking hyphens): "Texted STOP from •••‑•••‑7385 (removed number) on Nov 11"
  expect(caption).toContain(`Texted STOP from •••\u2011•••\u2011${last4(p1)} (removed number)`);

  // every path is still blocked: one-to-one, template, bulk text, and the plan (Stage → Active does not enroll)
  await apiAttemptsBlocked(rae.id);
  await bulkTextLeavesOut(rae.id, { id: ben.id, phone: benPhone });
  const st = await stack.api<{ automation: { kind: string; reason?: string } | null }>(AGENT, 'POST', `/contacts/${rae.id}/stage`, { stage: 'active' });
  expect(st.status).toBe(200);
  const enrolled = await stack.sql<{ state: string }>("SELECT state FROM playbook_enrollments WHERE contact_id = $1 AND state = 'active'", [rae.id]);
  expect(enrolled, JSON.stringify(st.body.automation)).toEqual([]);
  await stack.jobs({ tenantId: w.tenantId });
  expect(await smsTo(p2)).toEqual([]);
  expect(await smsTo(p1)).toEqual([]);
});

test('J3.3 R-PAR-12 exception: a number proven a wrong number and removed as one does not block the person\'s other phone', async ({ page }, info) => {
  test.setTimeout(180_000);
  const tag = isPhone(page) ? 'Phone' : 'Desk';
  const wrong = await newPhone();
  const real = await newPhone();
  const wes = await person('Wes', `Wrong${tag}`, [wrong]);
  // the stranger at the wrong number texts STOP, then says it is a wrong number (the ledger's proof)
  expect((await stack.fixture<{ status: number }>('/sms-in', { from: wrong, body: 'STOP' })).status).toBeLessThan(300);
  expect((await stack.fixture<{ status: number }>('/sms-in', { from: wrong, body: 'Wrong number, sorry' })).status).toBeLessThan(300);
  const [pt] = await stack.sql<{ id: string; status: string }>('SELECT id, status FROM contact_points WHERE contact_id = $1 AND address = $2', [wes.id, wrong]);
  expect(pt!.status).toBe('wrong_number');
  // the agent gets Wes's real number and adds it: while the wrong number is on file its STOP blocks him
  expect((await stack.api(AGENT, 'POST', `/contacts/${wes.id}/points`, { kind: 'phone', address: real, label: 'mobile' })).status).toBe(201);
  const before = await stack.api<{ reachability: { channels: { sms: { blocked: boolean } } } }>(AGENT, 'GET', `/contacts/${wes.id}/reachability`);
  expect(before.body.reachability.channels.sms.blocked).toBe(true);

  // on screen: the agent removes it as a confirmed wrong number. The edit sheet offers that only on the number
  // the ledger holds the wrong-number report for (module 57's remove route accepts nothing else) and says why it
  // is not offered on Wes's real number.
  await signIn(page, stack, w.agents[0]!);
  await contactPage(page, wes.id, wes.name);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  const details = page.getByRole('region', { name: 'Details' });
  await tap(page, details.getByRole('button', { name: `Edit details of ${wes.name}` }));
  const sheet = page.getByRole('dialog', { name: `Edit ${wes.name}` });
  const rowOf = (e164: string) => sheet.getByRole('group', { name: `Phone (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`, exact: true });
  await expect(sheet.getByRole('button', { name: 'Remove as a wrong number' })).toHaveCount(1);
  await expect(rowOf(real).getByRole('button', { name: 'Remove as a wrong number' })).toHaveCount(0);
  await expect(rowOf(real).getByText('nobody has reported this number as a wrong number yet', { exact: false })).toBeVisible();
  await shot(page, info, 'j3', '5a-remove-as-wrong-number-offered');
  await tap(page, rowOf(wrong).getByRole('button', { name: 'Remove as a wrong number' }));
  await expect(page.getByTestId('people-toast').getByText('Number removed as a wrong number')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('people-toast').getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await tap(page, sheet.getByRole('button', { name: 'Cancel' }));
  await expect(sheet).toHaveCount(0);
  const [gone] = await pollSql<{ status: string; removed_reason: string | null }>(stack, 'SELECT status, removed_reason FROM contact_points WHERE id = $1', [pt!.id], (r) => r[0]?.removed_reason === 'wrong_number');
  expect(gone).toMatchObject({ status: 'removed', removed_reason: 'wrong_number' });
  const after = await stack.api<{ reachability: { channels: { sms: { blocked: boolean } } } }>(AGENT, 'GET', `/contacts/${wes.id}/reachability`);
  expect(after.body.reachability.channels.sms.blocked).toBe(false);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: wes.name })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  await expect(page.getByText(/a number you removed/)).toHaveCount(0);
  await page.goto(`${stack.webUrl}/contacts/${wes.id}/thread?compose=sms`);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Hi Wes, is this the right number for you now?');
  const sendBtn = page.getByRole('button', { name: 'Send', exact: true });
  await expect(sendBtn).toBeEnabled({ timeout: 15_000 });
  await tap(page, sendBtn);
  await shot(page, info, 'j3', '5-wrong-number-other-phone-sent');
  await expect.poll(async () => (await smsTo(real)).length, { timeout: 15_000 }).toBe(1);
  const sent = await stack.sql<{ status: string }>("SELECT status FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [wes.id]);
  expect(sent).toHaveLength(1);
  expect(await smsTo(wrong)).toEqual([]);
  // nothing was lifted on the wrong number itself: its own opt-outs stay
  const st = await stack.sql<{ status: string }>("SELECT s.status FROM consent_state s JOIN contact_points p ON p.tenant_id = s.tenant_id AND p.address_hmac = s.address_hmac WHERE p.id = $1 AND s.channel = 'sms'", [pt!.id]);
  expect(st.length).toBeGreaterThan(0);
  expect(st.every((x) => x.status === 'revoked')).toBe(true);
});

// BUG (medium, over-block; reported in the lane report, not fixed: lifting an opt-out is an owner/counsel
// call). Reproduction: a person has two phones on file, W (in fact a stranger's) and R (theirs). The stranger
// texts STOP from W: the R-CONSENT-7 fan-out also writes a keyword revoke on R. The stranger then replies
// "Wrong number" (W's status becomes wrong_number, the ledger holds the wrong_number revoke), and the agent
// removes W as a confirmed wrong number. Expected (R-PAR-12's exception, DATA_MODEL: "a point removed as a
// confirmed wrong number ... does not block the person"): texting R is allowed. Actual: R keeps the copy of
// the stranger's STOP, GET /contacts/:id/reachability says sms blocked (CONSENT_REVOKED, keyword, on R itself,
// otherAddress false), the preview denies, and the composer says "Texted STOP on <date>" as if the person had
// opted out. Nobody but the person (texting START from R) can clear it. J3.3 passes only because R is added
// AFTER the stranger's STOP (the order comms/optOutFanout.test.ts E169 uses).
test.fixme('J3.4 BUG: a wrong number\'s STOP copied onto the person\'s other phone keeps blocking it after the wrong number is removed as one', async ({ page }) => {
  const tag = isPhone(page) ? 'Phone' : 'Desk';
  const wrong = await newPhone();
  const real = await newPhone();
  const vi = await person('Vi', `Both${tag}`, [wrong, real]);
  expect((await stack.fixture<{ status: number }>('/sms-in', { from: wrong, body: 'STOP' })).status).toBeLessThan(300);
  expect((await stack.fixture<{ status: number }>('/sms-in', { from: wrong, body: 'Wrong number, sorry' })).status).toBeLessThan(300);
  const [pt] = await stack.sql<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [vi.id, wrong]);
  expect((await stack.api(AGENT, 'POST', `/contacts/${vi.id}/points/${pt!.id}/remove`, { reason: 'wrong_number' })).status).toBe(200);
  const r = await stack.api<{ reachability: { channels: { sms: { blocked: boolean } } } }>(AGENT, 'GET', `/contacts/${vi.id}/reachability`);
  expect(r.body.reachability.channels.sms.blocked).toBe(false);
  const sent = await stack.api<{ result: string }>(AGENT, 'POST', `/contacts/${vi.id}/messages`, { channel: 'sms', body: 'Hi Vi', idempotencyKey: `k-${randomUUID()}` });
  expect(sent.body.result).toBe('sent');
  expect(await smsTo(real)).toHaveLength(1);
});
