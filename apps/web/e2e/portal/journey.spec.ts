// module 46 (R-PORTALWEB-3…10; E125, E700, E701): the accept journey against the REAL module 45 API with fakes
// (e2e/portal/stack.ts), on the phone (390×844) and desktop (1440×900) projects, tap counts asserted:
//   the agent invites Jane in 1 tap (the fake email holds the notice, with no token); Jane asks for a link and sees
//   45's sentence verbatim; the link opens and nothing is posted until she taps Sign in (1 tap); she sees "Your home
//   purchase" with its dated milestone, no done mark, and the agent card; Documents (1 tap on a phone, 0 on desktop)
//   and Download (1 tap) save the fixture's bytes; Sign out is 1 tap and the link then says it was used; the agent's
//   "What Jane Doe sees" (1 tap) lists the same items and dates in the same order as Jane's own view (two milestones
//   and a next step; b15 audit F7); Stop sharing hides everything on her next request.
import { type Page, expect, test } from 'playwright/test';
import { shot, signIn, tap } from '../journeys/helpers.js';
import type { WorldInfo } from '../journeys/stack.js';
import { LINK_USED, isPhone, newClientContext, openLinkAndSignIn, pdfOf, requestLink } from './common.js';
import { type PortalStack, type PortalWorld, startPortalStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: PortalStack;
let w: WorldInfo;
let pw: PortalWorld;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startPortalStack();
  w = await stack.world({ agents: 1 });
  pw = await stack.portalWorld();
  await stack.setCleared(true);
});
test.afterAll(async () => {
  await stack?.setCleared(false).catch(() => undefined);
  await stack?.stop();
});

const section = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Client portal' }) });
/** b15 audit F7: each Timeline and Next steps item as shown (its title and dates), in order: R-PORTAL-16 compares them. */
async function itemsOf(page: Page): Promise<{ timeline: string[]; nextSteps: string[] }> {
  const read = (heading: string) => page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: heading, exact: true }) }).locator('li').allInnerTexts();
  return { timeline: await read('Timeline'), nextSteps: await read('Next steps') };
}

test('module 46: invite, sign in on a tap, see the purchase, download, sign out; the preview matches; revoke hides it', async ({ page, browser }, info) => {
  test.setTimeout(300_000);
  const agent = page;
  const name = pw.jane.name;

  // 1. the agent invites Jane in one tap; the notice reaches the fake email with no token
  await signIn(agent, stack, w.agents[0]!);
  await agent.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  const s = section(agent);
  await expect(s.getByText("Confirmed dates are shared automatically. Documents and other updates can't be shared from the app yet.")).toBeVisible({ timeout: 20_000 });
  const invites = { taps: 0 };
  await tap(agent, s.getByRole('button', { name: `Invite ${name}` }), invites);
  await expect(s.getByText(/was sent a note by email with how to sign in\./)).toBeVisible({ timeout: 20_000 });
  expect(invites.taps).toBe(1);
  const notice = await stack.link(pw.jane.email);
  expect(notice.notices.join('\n')).toContain(`/portal.html?team=${pw.slug}`);
  expect(notice.notices.join('\n')).not.toContain('#token=');
  await shot(agent, info, 'portal', 'invited');

  // the document is published to her grant (test only: no staff screen publishes yet) and the sync runs
  const st = await stack.api<{ grants: { id: string }[] }>('a.agent0', 'GET', `/deals/${pw.dealId}/portal`);
  const grantId = st.body.grants[0]!.id;
  await stack.publishDocument(grantId, pw.documentId);
  await stack.publishItem(grantId, 'next_step', pw.nextStepTaskId);
  await stack.jobs();

  // 2. Jane asks for a link (45's sentence verbatim) and signs in with one tap
  const jctx = await newClientContext(browser, info);
  const jane = await jctx.newPage();
  const posts: string[] = [];
  jane.on('request', (r) => {
    if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
  });
  const link = await requestLink(jane, stack, pw.slug, pw.jane.email);
  posts.length = 0;
  const taps = { taps: 0 };
  await jane.goto(link);
  await expect(jane.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible({ timeout: 20_000 });
  await jane.waitForTimeout(500);
  expect(posts).toEqual([]); // E700: nothing before the tap
  expect(jane.url()).not.toContain('token');
  await tap(jane, jane.getByRole('button', { name: 'Sign in' }), taps);
  await expect(jane.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
  expect(taps.taps).toBe(1);
  expect(posts).toEqual(['/api/portal/session']);

  // 3. dates with no tap: the milestone, its date, no done mark; the agent card
  await expect(jane.getByText('Dec 18, 2026')).toBeVisible();
  await expect(jane.getByText(/^Shared /).first()).toBeVisible();
  const card = jane.locator('section').filter({ has: jane.getByRole('heading', { name: 'Your agent' }) });
  await expect(card.getByRole('link', { name: /^Email / }).or(card.getByText('Reply to any text or email from your agent.'))).toBeVisible();
  expect(await jane.locator('main').textContent()).not.toMatch(/✓|✔|\bdone\b|completed/i);
  // Jane's items, in her order: two milestones and a next step (compared with the preview in step 6)
  const janeItems = await itemsOf(jane);
  expect(janeItems.timeline).toHaveLength(2);
  expect(janeItems.nextSteps).toHaveLength(1);
  expect([...janeItems.timeline, ...janeItems.nextSteps].map((t) => t.split('\n')[0]).sort()).toEqual(['Appraisal', 'Book the movers', 'Inspection']);
  await shot(jane, info, 'portal', 'home');

  // 4. documents: 1 tap on a phone (the tab), 0 on desktop; download: 1 tap; the bytes equal the fixture
  const docTaps = { taps: 0 };
  if (isPhone(jane)) await tap(jane, jane.getByRole('tab', { name: 'Documents' }), docTaps);
  expect(docTaps.taps).toBe(isPhone(jane) ? 1 : 0);
  await expect(jane.getByText('Purchase contract.pdf', { exact: true })).toBeVisible();
  const dl = jane.waitForEvent('download');
  await tap(jane, jane.getByRole('button', { name: 'Download Purchase contract.pdf' }), docTaps);
  const file = await dl;
  expect(file.suggestedFilename()).toBe('Purchase contract.pdf');
  const saved = await file.path();
  const { readFileSync } = await import('node:fs');
  expect(Buffer.compare(readFileSync(saved), pdfOf(pw.pdfBase64))).toBe(0);
  expect(docTaps.taps).toBe(isPhone(jane) ? 2 : 1);
  await shot(jane, info, 'portal', 'documents');

  // 5. sign out in one tap; the same link then says it was used (E701)
  const out = { taps: 0 };
  await tap(jane, jane.getByRole('button', { name: 'Sign out' }), out);
  await expect(jane.getByRole('heading', { level: 1, name: "You're signed out" })).toBeVisible();
  expect(out.taps).toBe(1);
  await openLinkAndSignIn(jane, link);
  await expect(jane.locator('main').getByText(LINK_USED)).toBeVisible({ timeout: 20_000 });
  await expect(jane.getByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeVisible();

  // 6. the agent's "What Jane sees": 1 tap, the same items in the same order (R-PORTAL-16)
  await agent.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  const pv = { taps: 0 };
  await tap(agent, section(agent).getByRole('link', { name: `What ${name} sees` }), pv);
  await expect(agent.getByText(new RegExp(`^This is what ${name} sees now\\.$`))).toBeVisible({ timeout: 20_000 });
  expect(pv.taps).toBe(1);
  await expect(agent.getByText('Inspection', { exact: true })).toBeVisible();
  await expect(agent.getByText('Dec 18, 2026')).toBeVisible();
  // R-PORTAL-16: the preview lists Jane's items and dates, the same and in the same order
  expect(await itemsOf(agent)).toEqual(janeItems);
  await expect(agent.getByText('Download Purchase contract.pdf')).toBeVisible();
  await expect(agent.getByRole('button', { name: /Download/ })).toHaveCount(0);
  await shot(agent, info, 'portal', 'preview');

  // 7. stop sharing; Jane's next request shows nothing shared (E125)
  const link2 = await requestLink(jane, stack, pw.slug, pw.jane.email);
  await openLinkAndSignIn(jane, link2);
  await expect(jane.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
  await agent.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  await tap(agent, section(agent).getByRole('button', { name: `Stop sharing with ${name}` }));
  const dialog = agent.getByRole('dialog');
  await tap(agent, dialog.getByRole('button', { name: `Stop sharing with ${name}` }));
  await expect(section(agent).getByRole('link', { name: `What ${name} sees` })).toHaveCount(0, { timeout: 20_000 });
  await jane.reload();
  await expect(jane.getByText('Nothing is shared with you right now. If you expected to see your home here, ask your agent.')).toBeVisible({ timeout: 20_000 });
  await expect(jane.getByText('Inspection', { exact: true })).toHaveCount(0);
  await shot(jane, info, 'portal', 'revoked');
  await jctx.close();
});
