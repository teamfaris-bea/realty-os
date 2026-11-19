// Screenshots of the stage flow for the owner (batch 19), against the real stack (journeys/stack.ts: the real API on
// a fresh database, fake providers, invented people). Desktop: 1440×900 at deviceScaleFactor 2. Phone: Playwright's
// "iPhone 13" device descriptor on Chromium, as the e2e phone project uses it. That is an EMULATED phone: it is not a
// real iPhone and not Safari, and the "keyboard" shot only SIMULATES an on-screen keyboard by standing a shorter
// window.visualViewport in (Chromium's emulation has no on-screen keyboard); the grey band says so in the picture.
// Run: pnpm --filter @realty/web exec tsx e2e/journeys/j10-shots.ts <outDir>
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { type Browser, type BrowserContextOptions, type Locator, type Page, chromium, devices } from 'playwright';
import { type JourneyStack, startJourneyStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/stage-flow';
mkdirSync(out, { recursive: true });

const PLAN = 'Stay in touch';
const KEYBOARD_PX = 300;

const TARGETS: { name: 'desktop' | 'phone'; options: BrowserContextOptions }[] = [
  { name: 'desktop', options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
  // the device descriptor as it is (its own viewport, scale factor, touch and user agent), on Chromium
  { name: 'phone', options: { ...devices['iPhone 13'] } },
];

async function signIn(page: Page, webUrl: string, who: { email: string; password: string }) {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor({ timeout: 30_000 });
}

async function must<T>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

interface Person {
  id: string;
  name: string;
  first: string;
  phone: string;
}

async function assignedLead(stack: JourneyStack, first: string, last: string): Promise<Person> {
  const { phone } = await stack.fixture<{ phone: string }>('/phone');
  const name = `${first} ${last}`;
  const r = await stack.fixture<{ status: number; body: { contactId: string } }>('/intake', { world: 'a', body: { fullName: name, phones: [phone] } });
  const id = r.body.contactId;
  const [offer] = await stack.sql<{ offer_id: string }>('SELECT offer_id FROM contacts WHERE id = $1', [id]);
  await must(stack.api('a.agent0', 'POST', `/leads/${id}/accept`, { commandId: randomUUID(), offerId: offer!.offer_id }), 'accept');
  return { id, name, first, phone };
}

const stack = await startJourneyStack();
let browser: Browser | undefined;
try {
  const w = await stack.world({ agents: 1, alertPhones: true });
  // the team plan: started from the same template the settings page offers, approved, started on Connected
  const pb = await must(stack.api<{ playbook: { id: string; versions: { id: string; contentSha256: string; steps: unknown[] }[] } }>('a.owner', 'POST', '/playbooks', { templateKey: 'nurture', scope: 'team' }), 'playbook');
  const v = pb.playbook.versions[0]!;
  const n = v.steps.length;
  const attestation = `I reviewed the ${n === 1 ? 'message' : `${n} messages`} in “${PLAN}” version 1. The assistant may send ${n === 1 ? 'it' : 'them'} on its own to contacts who have not opted out, signed as the assistant, and must stop when a client replies.`;
  await must(stack.api('a.owner', 'POST', `/playbook-versions/${v.id}/approve`, { attestation, contentSha256: v.contentSha256 }), 'approve');
  await must(stack.api('a.owner', 'PUT', `/playbooks/${pb.playbook.id}/auto-enroll-stage`, { stage: 'connected' }), 'auto-enroll stage');

  browser = await chromium.launch();
  for (const t of TARGETS) {
    const phone = t.name === 'phone';
    const ctx = await browser.newContext(t.options);
    const page = await ctx.newPage();
    const shot = async (file: string) => {
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${out}/${t.name}-${file}.png` });
      console.log(`${t.name}-${file}.png`);
    };
    const press = (l: Locator) => (phone ? l.tap() : l.click());
    const open = async (p: Person) => {
      await page.goto(`${stack.webUrl}/contacts/${p.id}`);
      await page.getByRole('heading', { level: 1, name: p.name }).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: /^Stage: / }).waitFor({ timeout: 30_000 });
    };
    const callButton = (p: Person) => (phone ? page.getByTestId('person-phone-bar').getByRole('button', { name: `Call ${p.name}` }) : page.getByRole('button', { name: 'Call', exact: true }));
    const callAndLog = async (p: Person, outcome: string) => {
      await press(callButton(p));
      const sheet = page.getByRole('dialog', { name: `Call ${p.name}` });
      await press(sheet.getByRole('button', { name: outcome, exact: true }));
      await page.getByRole('dialog', { name: `Stage for ${p.name}` }).getByRole('radiogroup', { name: 'Stage' }).waitFor({ timeout: 20_000 });
    };
    const panel = page.getByRole('region', { name: 'What happens next' });
    const toastGone = () => page.waitForFunction(() => (document.querySelector('[data-testid="people-toast"]')?.textContent ?? '') === '' && (document.querySelector('[data-testid="toast"]')?.textContent ?? '') === '', undefined, { timeout: 20_000 });
    /** the page scrolled so `l` starts a little below the top bar */
    const scrollTo = (l: Locator, above = 90) => l.evaluate((el, a) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - a), above);

    await signIn(page, stack.webUrl, w.agents[0]!);

    // ---- a lead worked through to a running plan ----
    const dana = await assignedLead(stack, 'Dana', phone ? 'Reyes' : 'Okafor');
    await open(dana);
    if (phone) {
      // the phone's working bar, with the stage and its two chips above it
      await scrollTo(page.getByRole('button', { name: /^Stage: / }), 420);
      await shot('6-working-bar-call-text-log-next-note');
    }
    // the stage picker: every stage with what it means, what it does not, and what picking it will do
    await press(page.getByRole('button', { name: 'Stage: New lead. Change stage' }));
    const picker = page.getByRole('dialog', { name: `Stage for ${dana.name}` });
    await picker.getByRole('button', { name: 'Connected' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] ul[aria-label="Stages"] button')].every((b) => !(b as HTMLButtonElement).disabled || /Current|Locked/.test(b.textContent ?? '')), undefined, { timeout: 20_000 });
    await shot('2-stage-picker-with-definitions');
    await press(picker.getByRole('button', { name: 'Cancel' }));

    // the stage step after a conversation: "Connected" suggested, and the team plan will start
    await callAndLog(dana, 'Talked');
    const step = page.getByRole('dialog', { name: `Stage for ${dana.name}` });
    await step.getByTestId('stage-step-effect').getByText(new RegExp(`^Will start: ${PLAN}`)).waitFor({ timeout: 20_000 });
    await toastGone();
    await shot('3-stage-step-preview-will-start-a-plan');
    if (phone) {
      // the same step scrolled to its full preview and the follow-up chips
      await step.getByRole('group', { name: 'Follow-up' }).scrollIntoViewIfNeeded();
      await shot('3b-stage-step-full-preview-and-follow-up');
    }
    await press(step.getByRole('button', { name: 'Change to Connected' }));
    await panel.getByTestId('plan-state').getByText('Running').waitFor({ timeout: 20_000 });
    await toastGone();
    await scrollTo(panel);
    await shot('1-contact-with-what-happens-next-panel');
    if (!phone) {
      // the whole person page, so the panel is seen in its place under the stage, its chips and the details
      // from the top, so the sticky sidebar is drawn where it sits
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${out}/desktop-1b-whole-contact-page-with-panel.png`, fullPage: true });
      console.log('desktop-1b-whole-contact-page-with-panel.png');
    }

    // Stop, and what the panel says after
    await press(panel.getByRole('button', { name: `Stop ${PLAN}` }));
    await panel.getByTestId('plan-state').getByText('Stopped').waitFor({ timeout: 20_000 });
    await scrollTo(panel);
    await shot('5-panel-after-stop');

    // ---- a person who texted STOP: the reason, before the save ----
    const omar = await assignedLead(stack, 'Omar', phone ? 'Haddad' : 'Lindqvist');
    await stack.fixture('/sms-in', { world: 'a', from: omar.phone, body: 'STOP' });
    await open(omar);
    await callAndLog(omar, 'Talked');
    await page.getByRole('dialog', { name: `Stage for ${omar.name}` }).getByTestId('stage-step-effect').getByText(/will not start/).waitFor({ timeout: 20_000 });
    await toastGone();
    await shot('4-stage-step-blocked-reason-texted-stop');

    if (phone) {
      // ---- the Text sheet with the on-screen keyboard SIMULATED: a visual viewport KEYBOARD_PX shorter ----
      const ivy = await assignedLead(stack, 'Ivy', 'Marchetti');
      await open(ivy);
      await page.evaluate((kb) => {
        const stub = { height: window.innerHeight - kb, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1, addEventListener() {}, removeEventListener() {} };
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: stub });
        const band = document.createElement('div');
        band.textContent = 'Simulated keyboard area (not a real keyboard: the visual viewport is made this much shorter)';
        band.setAttribute('style', `position:fixed;left:0;right:0;bottom:0;height:${kb}px;z-index:2147483647;background:#cfd3da;color:#1f2937;font:600 14px/1.3 system-ui;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 24px;pointer-events:none;border-top:2px solid #6b7280`);
        document.body.appendChild(band);
      }, KEYBOARD_PX);
      await press(page.getByTestId('person-phone-bar').getByRole('button', { name: `Text ${ivy.name}` }));
      const text = page.getByRole('dialog', { name: `Text ${ivy.name}` });
      await text.getByRole('textbox', { name: 'Text message' }).fill(`Hi ${ivy.first}, it's your agent. Is this still a good number for you?`);
      await text.getByRole('button', { name: 'Send', exact: true }).waitFor();
      await shot('7-text-sheet-above-simulated-keyboard');
    }
    await ctx.close();
  }
  console.log(`screenshots in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
