// Screenshots of every Phase 3 staff page and card (module 55) against the real stack (stack.ts): phone 390×844 in
// light and dark, desktop 1440×900 in light, at deviceScaleFactor 1, dark (uncleared) states included. A stack per
// viewport, so each set starts from the same world. For the lane's review; not committed.
// Run: pnpm --filter @realty/web exec tsx e2e/phase3-staff/shots.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { type People, type StaffStack, startStaffStack } from './stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/phase3-staff';
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, schemes: ['light', 'dark'] },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, schemes: ['light'] },
} as const;

const CONTRACT_PAGES = [
  { page: 1, text: 'RESIDENTIAL PURCHASE AGREEMENT (synthetic test form)\nEffective Date: 01/05/2027\nThe Buyer and the Seller agree as follows.' },
  { page: 2, text: 'Appraisal deadline: January 20, 2027' },
  { page: 3, text: 'Closing Date: 2/12/27 or sooner by agreement.\nPossession: at closing.' },
];
let seq = 0;
const pdf = (padTo = 0) => {
  const head = `%PDF-1.4\n% synthetic screenshot file ${Date.now()}-${++seq}\n`;
  return Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, padTo - head.length - 7), 0x20), Buffer.from('\n%%EOF\n')]);
};
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from(`JFIF synthetic ${Date.now()}-${++seq}`), 0xff, 0xd9]);

async function signIn(page: Page, stack: StaffStack, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = (await stack.fixture<{ code: string | null }>('/totp', { email })).code;
  if (code) {
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.getByRole('heading', { level: 1, name: 'Home' }).waitFor({ timeout: 20_000 });
}

async function settle(page: Page) {
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
}

async function upload(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string | null> {
  const chooser = page.waitForEvent('filechooser');
  const res = file.buffer.length > 10_000_000 ? null : page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/deals\/[^/]+\/documents$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: 'Upload a contract' }).click();
  await (await chooser).setFiles(file);
  if (!res) return null;
  return ((await (await res).json()) as { document: { id: string } }).document.id;
}

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  const stack = await startStaffStack();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const { schemes, ...opts } = vp;
    const ctx = await browser.newContext({ ...opts });
    const page = await ctx.newPage();
    const shoot = async (file: string, o: { fullPage?: boolean } = {}) => {
      await settle(page);
      for (const scheme of schemes) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${out}/${name}-${scheme}-${file}.png`, fullPage: o.fullPage ?? true });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    };
    const go = async (path: string) => {
      await page.goto(`${stack.webUrl}${path}`);
      await settle(page);
    };

    // ---- AI call answering: dark, the test call, cleared off and on, the Admin's blocked widening, the handback card
    const v = await stack.fixture<People & { admin: string; tc: string }>('/voice');
    await signIn(page, stack, v.owner, v.password);
    await go('/admin/ai-answering');
    await shoot('voice-dark');
    await page.getByRole('button', { name: 'Run' }).click();
    await page.getByTestId('test-call-result').waitFor();
    await shoot('voice-test-call');
    await stack.fixture('/packs', { voice: true });
    await go('/admin/ai-answering');
    await shoot('voice-off');
    await page.getByRole('button', { name: 'Turn on AI answering' }).click();
    await page.getByRole('dialog').waitFor();
    await shoot('voice-turn-on-dialog', { fullPage: false });
    await page.getByRole('button', { name: 'I confirm and turn on' }).click();
    await page.locator('main').getByText('AI answering is on.', { exact: true }).waitFor();
    await shoot('voice-on');
    await page.getByRole('button', { name: 'Turn off AI answering' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off', exact: true }).click();
    await page.locator('main').getByText('AI answering is off.', { exact: true }).waitFor();
    await signIn(page, stack, v.admin, v.password);
    await go('/admin/ai-answering');
    await page.getByLabel('Answer a missed call').selectOption('10');
    await shoot('voice-admin-widen-blocked');
    await stack.fixture('/reset');
    await stack.fixture('/voice/call', { script: 'booking' });
    await signIn(page, stack, v.agent, v.password);
    await go('/approvals');
    const handback = page.getByRole('article').filter({ has: page.getByText(/^The assistant answered a call · /) });
    await handback.getByRole('button', { name: 'What the assistant did' }).click();
    await handback.getByText(/Nothing the caller said is shown here/).waitFor();
    await shoot('voice-handback-card');
    await signIn(page, stack, v.tc, v.password);
    await go('/admin/ai-answering');
    await shoot('voice-tc-not-available');

    // ---- Google Ads: dark page, cleared page with the proposal, the Approvals card, after Approve
    const a = await stack.fixture<People & { admin: string }>('/ads');
    await signIn(page, stack, a.owner, a.password);
    await go('/ads');
    await shoot('ads-dark');
    await stack.fixture('/packs', { ads: true });
    await go('/ads');
    await shoot('ads-cleared');
    await go('/approvals');
    const region = page.getByRole('region', { name: 'Google Ads budget to approve' });
    await region.waitFor();
    await shoot('approvals-ad-shift');
    await region.getByRole('button', { name: 'Approve' }).click();
    await region.getByText(/^Approved\./).first().waitFor();
    await shoot('approvals-ad-shift-approved');
    await go('/ads');
    await shoot('ads-after-approve');
    await stack.fixture('/reset');

    // ---- Documents: the deal's section, an upload, the extraction pointer, the date review, a photo, too big, share
    const d = await stack.fixture<People & { tc: string; dealId: string }>('/docs');
    await signIn(page, stack, d.tc, d.password);
    await go(`/deals/${d.dealId}`);
    await shoot('deal-documents-empty');
    const bytes = pdf();
    await stack.fixture('/docs/pages', { base64: bytes.toString('base64'), pages: CONTRACT_PAGES });
    const contractId = await upload(page, { name: 'Purchase contract (synthetic).pdf', mimeType: 'application/pdf', buffer: bytes });
    await page.getByText(/^Added Purchase contract/).waitFor();
    await shoot('deal-documents-uploaded');
    await stack.fixture('/docs/scan', { documentId: contractId });
    await go(`/deals/${d.dealId}`);
    await shoot('deal-documents-scanned');
    await go('/approvals');
    await shoot('approvals-extraction-pointer');
    await go(`/documents/${contractId}/dates`);
    await shoot('document-dates');
    const first = page.getByRole('region', { name: 'Dates found' }).getByRole('article').filter({ hasText: 'Closing Date' }).first();
    await first.getByRole('button', { name: 'Confirm' }).click();
    await first.getByText('Confirmed: on the deal timeline.').waitFor();
    await shoot('document-dates-confirmed');
    await go(`/deals/${d.dealId}`);
    const photoId = await upload(page, { name: 'Contract photo (synthetic).jpg', mimeType: 'image/jpeg', buffer: jpeg() });
    await stack.fixture('/docs/scan', { documentId: photoId });
    await go(`/documents/${photoId}/dates`);
    await shoot('document-dates-photo');
    await go(`/deals/${d.dealId}`);
    await upload(page, { name: 'Too big (synthetic).pdf', mimeType: 'application/pdf', buffer: pdf(10_000_001) });
    await page.getByText('This file is larger than 10 MB (10,000,000 bytes). Choose a smaller file.').waitFor();
    await shoot('deal-documents-too-big');
    await signIn(page, stack, d.agent, d.password);
    await go(`/documents/${contractId}`);
    await shoot('document-page');
    await page.getByRole('button', { name: 'Mark for the client portal' }).click();
    await page.locator('main').getByText('Marked for the client portal. Clients see nothing until the portal is turned on, and then only once it is published to their portal.').first().waitFor();
    await shoot('document-page-marked');

    // ---- Google Business Profile: dark, cleared with a draft, the Approvals card
    const g = await stack.fixture<People>('/gbp');
    await signIn(page, stack, g.owner, g.password);
    await go('/gbp');
    await shoot('gbp-dark');
    await stack.fixture('/packs', { keys: ['platform:gbp', 'platform:fair_housing'], reviewed: true });
    await go('/gbp');
    await shoot('gbp-cleared');
    await page.getByRole('button', { name: 'Draft with the assistant' }).click();
    await page.getByLabel(/Reply drafted by the assistant/).waitFor();
    await shoot('gbp-draft');
    await go('/approvals');
    await page.getByRole('region', { name: 'Review replies to approve' }).waitFor();
    await shoot('approvals-review-reply');
    await stack.fixture('/reset');

    // ---- Likely to move (ready, then no model) and Coaching trends
    const l = await stack.fixture<People>('/likely');
    await signIn(page, stack, l.agent, l.password);
    await go('/likely');
    await shoot('likely-ready');
    await go('/coaching/trends');
    await shoot('trends-scoring-off');
    await stack.fixture('/reset');
    await go('/likely');
    await shoot('likely-no-model');

    await ctx.close();
  } finally {
    await browser?.close();
    await stack.stop();
  }
}
console.log(`screenshots in ${out}`);
