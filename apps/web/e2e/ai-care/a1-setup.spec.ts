// a1-setup (R-ISA-32, R-ISA-16; E524, E516): the team starts with the switch off and counsel review pending. The
// Owner turns it on (the written confirmation, the password and TOTP) and the team page keeps the counsel line until
// counsel clears the pack; an Admin cannot raise the cap; an agent opts in (converse only, the password, the exact
// attestation); Start is refused while the first touch is pending, with Call and Text; after their first hand-typed
// text Start works in 2 taps; a narrowing save warns first (V19). Phone 390×844 and desktop 1440×900. Fakes only.
import { expect, test } from 'playwright/test';
import { shot } from '../journeys/helpers.js';
import type { JourneyStack } from '../journeys/stack.js';
import { type IsaWorldInfo, axe, confirmPassword, expectNoCode, isaLeadOf, isaWorldOf, openFromNav, press, runIsa, signInAs, startIsaStack } from './isa.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: IsaWorldInfo;
let admin: { email: string; password: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startIsaStack();
  w = await isaWorldOf(stack, { optIn: false, clear: false, switchOff: true });
  admin = await stack.fixture('/isa-admin');
});
test.afterAll(async () => {
  await stack?.stop();
});

const ON = 'I turn on the AI assistant for my team. Its consent, quiet-hours and frequency limits are engineering defaults that counsel has not reviewed, and I accept responsibility for that.';

test('R-ISA-32 Q8: the Owner turns it on with the confirmation and the password; the counsel line stays until counsel clears the pack', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, stack, w.owner);
  await page.goto(`${stack.webUrl}/settings/ai-assistant/team`);
  await expect(page.getByTestId('ai-team-holds')).toContainText('Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.');
  await press(page, page.getByRole('button', { name: 'Turn on' }));
  const d = page.getByRole('dialog', { name: 'Turn on the AI assistant' });
  await expect(d).toContainText(ON);
  await expect(d.getByRole('button', { name: 'Turn on' })).toBeDisabled();
  await d.getByLabel('I have read this and agree').check();
  expect(await axe(page)).toEqual([]);
  await press(page, d.getByRole('button', { name: 'Turn on' }));
  await confirmPassword(page, stack, w.owner, page.getByTestId('ai-team-line'));
  await expect(page.getByTestId('ai-team-line')).toHaveText('Turned on.');
  await expect(page.getByTestId('ai-team-holds')).toContainText('Waiting on counsel review');
  await stack.fixture('/isa-clear');
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'The AI assistant for the team' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Waiting on counsel review');
  await expectNoCode(page);
});

test('R-ISA-32: an Admin cannot raise the cap: "Only the account owner can turn this on."', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, stack, admin);
  await page.goto(`${stack.webUrl}/settings/ai-assistant/team`);
  const cap = page.getByLabel(/Most AI messages a day/);
  await cap.fill('500');
  await press(page, page.getByRole('button', { name: 'Save limit' }));
  await expect(page.getByTestId('ai-team-line')).toHaveText('Only the account owner can turn this on.');
  const r = await stack.sql<{ cap: number }>(`SELECT ai_isa_daily_cap AS cap FROM tenant_settings WHERE tenant_id = $1`, [w.tenantId]);
  expect(r[0]!.cap).toBe(100);
});

test('R-ISA-32 E524: an agent opts in (converse only, the exact attestation, the password); then Start is refused FIRST_TOUCH_PENDING with Call and Text; after a hand-typed text, Start takes 2 taps', async ({ page }) => {
  test.setTimeout(240_000);
  const lead = await isaLeadOf(stack, { firstTouchPending: true });
  await signInAs(page, stack, w.agents[0]!);
  const nav = { taps: 0 };
  await openFromNav(page, 'My AI assistant', nav);
  expect(nav.taps).toBeLessThanOrEqual(2);
  await expect(page.getByLabel('Talk with them by text and email (required)')).toBeChecked();
  await expect(page.getByLabel('Talk with them by text and email (required)')).toBeDisabled();
  const att = await page.getByTestId('attestation').innerText();
  const me = await stack.api<{ attestationText: string }>('i.agent0', 'GET', '/me/ai-isa');
  expect(att).toBe(me.body.attestationText);
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await shot(page, test.info(), 'ai-care', 'my-assistant');
  await page.getByLabel('I have read this and agree').check();
  expect(await axe(page)).toEqual([]);
  await press(page, page.getByRole('button', { name: 'Save' }));
  await confirmPassword(page, stack, w.agents[0]!, page.getByTestId('optin-line'));
  await expect(page.getByTestId('optin-line')).toHaveText('You are opted in.');
  const o = await stack.sql<{ capabilities: string[] }>(`SELECT capabilities FROM ai_isa_agent_optins WHERE user_id = $1 AND status = 'active'`, [w.agents[0]!.userId]);
  expect(o[0]!.capabilities).toEqual(['converse']);
  // Start is refused while the first touch is pending, with the fix in reach
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  const refusal = page.getByTestId('ai-refusal');
  await expect(refusal).toContainText("Text or call them yourself first. AI messages don't count as your first contact.");
  await expect(refusal.getByRole('button', { name: 'Text' })).toBeVisible();
  await expect(refusal.getByRole('button', { name: 'Call' })).toBeVisible();
  // the refusal's own fix: the agent texts them by hand (the R-OWN-14 first touch; AI messages never count)
  await press(page, refusal.getByRole('button', { name: 'Text' }));
  await page.getByRole('textbox', { name: 'Text message' }).fill('Hi Jane, this is me. When is a good time to talk?');
  await press(page, page.getByRole('button', { name: 'Send', exact: true }).last());
  await runIsa(stack);
  await expect.poll(async () => (await stack.sql<{ t: string | null }>(`SELECT first_touch_at AS t FROM contacts WHERE id = $1`, [lead.id]))[0]!.t, { timeout: 20_000 }).not.toBeNull();
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await page.reload();
  const taps = { taps: 0 };
  await press(page, page.getByRole('button', { name: 'Start AI care' }), taps);
  const sheet = page.getByRole('dialog', { name: 'Start AI care' });
  await expect(sheet).toContainText(/gets texts and emails from your AI assistant under your opt-in of .*You stay responsible for this lead\./);
  expect(await axe(page)).toEqual([]);
  await press(page, sheet.getByRole('button', { name: 'Start as a buyer' }), taps);
  await expect(sheet.getByRole('status')).toContainText('AI care started');
  expect(taps.taps).toBe(2);
});

test('V19 Q13: with care on, a narrowing save warns first with the count', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAs(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/settings/ai-assistant`);
  await page.getByLabel('Email', { exact: true }).uncheck();
  await page.getByLabel('I have read this and agree').check();
  await press(page, page.getByRole('button', { name: 'Save' }));
  const d = page.getByRole('dialog', { name: 'Save your opt-in' });
  await expect(d).toContainText(/Saving any change ends AI care for your 1 leads under AI care\. Each comes back to you with a handoff, and you can start them again\./);
  await press(page, d.getByRole('button', { name: 'Save and end that care' }));
  await expect(page.getByTestId('optin-line')).toHaveText('Narrowed.');
});
