// Navigation exploration (branch explore/navigation): screenshots and measurements of the CURRENT navigation and of
// directions A ("Slim rail", ?nav=a) and B ("Top bar", ?nav=b), for an AGENT and for an OWNER, on desktop
// (1440×900 at deviceScaleFactor 2) and on the phone (Playwright's "iPhone 13" descriptor on Chromium: an EMULATED
// phone, not a real iPhone and not Safari). Against the real stack (journeys/stack.ts: the real API on a fresh
// database, fake providers, invented people; nothing is sent anywhere).
//
// Per role × navigation × target: 1 the home page, 2 the People list, 3 one contact page, 4 More open (for the current
// desktop navigation, which has no More: the sidebar scrolled to its end), 5 search with results showing.
// Then the widths the brief names (320, 768, 1280 and 1440 px) for both directions, and measurements.json: what is
// visible at rest, content widths, tap-target sizes, sideways scroll, the keyboard walk, and whether every search row
// on screen was in the API's answer for that person.
// Run: pnpm --filter @realty/web exec tsx e2e/shell/nav-explore-shots.ts <outDir>
// (about three minutes; NAV_SHOTS_ONLY='^owner-phone' or '^width-320' retakes one part, a regular expression on the file name)
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page, chromium, devices } from 'playwright';
import { type JourneyStack, type Who, startJourneyStack } from '../journeys/stack.js';

const out = process.argv[2] ?? '/tmp/realty-shots/nav-explore';
mkdirSync(out, { recursive: true });

type Mode = 'current' | 'a' | 'b';
const MODES: Mode[] = ['current', 'a', 'b'];
const MODE_NAME: Record<Mode, string> = { current: 'current', a: 'A-slim-rail', b: 'B-top-bar' };
const TARGETS: { name: 'desktop' | 'phone'; options: BrowserContextOptions }[] = [
  { name: 'desktop', options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
  { name: 'phone', options: { ...devices['iPhone 13'] } },
];
const QUERY = 'mar';

// invented people (no real person, .test addresses, the stack's fictional phone numbers)
const PEOPLE: [string, string][] = [
  ['Mara', 'Ellison'],
  ['Marcus', 'Oyelaran'],
  ['Priya', 'Raghunathan-Whitfield'],
  ['Anneliese', 'Vandersloot-Okonkwo'],
  ['Marisol', 'Quintero'],
  ['Martin', 'Halvorsen'],
  ['Maren', 'Castellano'],
  ['Mario', 'Bettencourt'],
  ['Dana', 'Okafor'],
  ['Tess', 'Bergstrom'],
  ['Noor', 'Abernathy'],
  ['Omar', 'Lindqvist'],
  ['Ivy', 'Marchetti'],
];
/** iterate on part of the set: NAV_SHOTS_ONLY='agent-desktop' (a regular expression on the file tag) */
const ONLY = process.env.NAV_SHOTS_ONLY ? new RegExp(process.env.NAV_SHOTS_ONLY) : null;

/** tsx (esbuild) wraps named functions inside page.evaluate callbacks in __name(); the page needs it to exist */
const ESBUILD_NAME_SHIM = 'globalThis.__name = (f) => f;';

const report: Record<string, unknown> = {};
const problems: string[] = [];
const note = (key: string, value: unknown) => {
  report[key] = value;
};
const fail = (what: string) => {
  problems.push(what);
  console.log(`PROBLEM ${what}`);
};

async function must<T>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function signIn(page: Page, stack: JourneyStack, who: Who) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = page.getByLabel('Code');
  const home = page.getByRole('heading', { level: 1, name: 'Home' });
  await code.or(home).first().waitFor({ timeout: 30_000 });
  if (await code.isVisible()) {
    const totp = (await stack.fixture<{ code: string | null }>('/totp', { email: who.email })).code;
    if (!totp) throw new Error(`no TOTP secret for ${who.email}`);
    await code.fill(totp);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await home.waitFor({ timeout: 30_000 });
}

/** What the page shows that a reviewer would call broken, read from the DOM (the pictures are still looked at). */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const outp: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) outp.push(`scrolls sideways: ${doc.scrollWidth}px in ${doc.clientWidth}px`);
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const label = (e: Element) => (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText ?? e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    // every navigation control (rail, bars, tab bar, panels): 44 × 44 at least, inside the viewport, its label not cut
    const chrome = [...document.querySelectorAll<HTMLElement>('body > div > header, aside, nav[aria-label="Main tabs"], nav[aria-label="Main"], main > header')].filter(visible);
    for (const c of chrome) {
      for (const e of c.querySelectorAll<HTMLElement>('a[href], button, input')) {
        if (!visible(e) || e.closest('[hidden], .sr-only')) continue;
        const r = e.getBoundingClientRect();
        if (Math.round(r.width) < 44 || Math.round(r.height) < 44) outp.push(`small target "${label(e)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
        if (r.left < -0.5 || r.right > doc.clientWidth + 0.5) outp.push(`"${label(e)}" is partly off screen (${Math.round(r.left)}..${Math.round(r.right)} of ${doc.clientWidth})`);
        if (e.scrollWidth > e.clientWidth + 1 && e.tagName !== 'INPUT') outp.push(`"${label(e)}" is cut off (${e.scrollWidth}px in ${e.clientWidth}px)`);
      }
    }
    return [...new Set(outp)];
  });
}

const stack = await startJourneyStack();
let browser: Browser | undefined;
try {
  const w = await stack.world({ agents: 2, teamLead: true });
  const agent = w.agents[0]!;
  const mine: { id: string; name: string }[] = [];
  const theirs: { id: string; name: string }[] = [];
  const unassigned: { id: string; name: string }[] = [];
  for (const [first, last] of PEOPLE) {
    const { phone } = await stack.fixture<{ phone: string }>('/phone');
    const name = `${first} ${last}`;
    const r = await stack.fixture<{ status: number; body: { contactId: string } }>('/intake', {
      world: 'a',
      body: { fullName: name, phones: [phone], emails: [`${first}.${last}@example.test`.toLowerCase()] },
    });
    const id = r.body.contactId;
    const [c] = await stack.sql<{ offer_id: string; offered_to_user_id: string }>('SELECT offer_id, offered_to_user_id FROM contacts WHERE id = $1', [id]);
    // routing offers each lead to one member of the rule (an agent, or the Team Lead): that member accepts it
    const i = w.agents.findIndex((a) => a.userId === c!.offered_to_user_id);
    const as = i >= 0 ? `a.agent${i}` : w.lead?.userId === c!.offered_to_user_id ? 'a.lead' : null;
    if (!as) {
      // not offered to anyone (the rule's members are at their limit): it stays where routing put it, e.g. the pond
      unassigned.push({ id, name });
      continue;
    }
    await must(stack.api(as, 'POST', `/leads/${id}/accept`, { commandId: randomUUID(), offerId: c!.offer_id }), `accept ${name}`);
    (i === 0 ? mine : theirs).push({ id, name });
  }
  note('seed', { agent0Owns: mine.map((p) => p.name), othersOwn: theirs.map((p) => p.name), notOffered: unassigned.map((p) => p.name) });
  const person = mine.find((p) => p.name.startsWith('Mar')) ?? mine[0]!;
  /** the agent's own person with the longest name: for the narrow-width shots */
  const longName = [...mine].sort((x, y) => y.name.length - x.name.length)[0]!;
  // deals, a listing and tasks of the agent's own, so Home, Deals and the search groups have something true to show
  await must(stack.api('a.agent0', 'POST', '/deals', { primaryContactId: person.id, name: `${person.name}: Marlow Court purchase`, side: 'buy', priceCents: 61_500_000, expectedCloseDate: '2026-12-18' }), 'deal 1');
  await must(stack.api('a.agent0', 'POST', '/deals', { primaryContactId: mine[1]!.id, name: `${mine[1]!.name}: Alder Street sale`, side: 'sell', priceCents: 48_900_000, expectedCloseDate: '2027-01-22' }), 'deal 2');
  await must(stack.api('a.agent0', 'POST', '/listings', { status: 'active', addressLine1: '214 Marigold Lane', city: 'Fairhaven', region: 'CA', postalCode: '94610', listPriceCents: 72_500_000, beds: 3, bathsX10: 20, sqft: 1620, propertyType: 'single_family' }), 'listing');
  await must(stack.api('a.agent0', 'POST', '/tasks', { title: `Call ${person.name} about the inspection`, contactId: person.id, dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }), 'task 1');
  await must(stack.api('a.agent0', 'POST', '/tasks', { title: `Send ${mine[1]!.name} the comparable sales`, contactId: mine[1]!.id, dueAt: new Date(Date.now() + 26 * 3_600_000).toISOString() }), 'task 2');

  browser = await chromium.launch();
  const ROLES: { role: 'agent' | 'owner'; who: Who }[] = [
    { role: 'agent', who: agent },
    { role: 'owner', who: w.owner },
  ];

  // one sign-in per person (sign-in is rate limited, as it should be): every context below starts from its session
  const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();
  for (const { role, who } of ROLES) {
    const ctx = await browser.newContext();
    await signIn(await ctx.newPage(), stack, who);
    sessions.set(role, await ctx.storageState());
    await ctx.close();
  }

  for (const { role } of ROLES) {
    for (const t of TARGETS) {
      const phone = t.name === 'phone';
      for (const mode of MODES) {
        const tag = `${role}-${t.name}-${MODE_NAME[mode]}`;
        if (ONLY && !ONLY.test(tag)) continue;
        const ctx = await browser.newContext({ ...t.options, storageState: sessions.get(role)! });
        await ctx.addInitScript(ESBUILD_NAME_SHIM);
        const page = await ctx.newPage();
        const press = (l: Locator) => (phone ? l.tap() : l.click());
        const shot = async (file: string) => {
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await page.waitForTimeout(350);
          const p = await layoutProblems(page);
          if (mode !== 'current') for (const x of p) fail(`${tag}-${file}: ${x}`);
          else if (p.length) note(`currentNavFindings.${tag}-${file}`, p);
          await page.screenshot({ path: `${out}/${tag}-${file}.png` });
          console.log(`${tag}-${file}.png`);
        };
        const open = async (path: string, h1: string) => {
          await page.goto(`${stack.webUrl}${path}`);
          await page.getByRole('heading', { level: 1, name: h1 }).waitFor({ timeout: 30_000 });
        };
        try {
          await open(`/?nav=${mode}`, 'Home');

          // 1 home, with what is visible at rest counted
          const rest = await page.evaluate(() => {
            const vis = (e: Element) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
            };
            const inNav = [...document.querySelectorAll('nav[aria-label="Main"] a[href], nav[aria-label="Main tabs"] a[href], nav[aria-label="Main"] button, nav[aria-label="Main tabs"] button')].filter((e) => !e.closest('[hidden]'));
            const all = inNav.filter((e) => getComputedStyle(e).display !== 'none' && (e as HTMLElement).offsetParent !== null);
            return { inNavigation: all.length, onScreenWithoutScrolling: all.filter(vis).length, labels: all.filter(vis).map((e) => (e.textContent ?? '').trim()) };
          });
          note(`atRest.${tag}`, rest);
          await shot('1-home');

          // 2 people
          await open('/people', 'People');
          await shot('2-people-list');

          // 3 one contact
          await open(`/contacts/${person.id}`, person.name);
          await page.getByRole('button', { name: /^Stage: / }).waitFor({ timeout: 30_000 });
          await shot('3-contact-page');

          // 4 More
          await open('/', 'Home');
          if (mode === 'current' && !phone) {
            await page.getByRole('navigation', { name: 'Main' }).evaluate((n) => n.scrollTo(0, n.scrollHeight));
            await shot('4-sidebar-scrolled-to-its-end-there-is-no-more-menu');
          } else if (mode === 'a' && phone) {
            await press(page.getByRole('navigation', { name: 'Main tabs' }).getByRole('button', { name: 'More' }));
            await page.getByRole('dialog', { name: 'More' }).waitFor();
            await shot('4-more-sheet-open');
            await press(page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Close' }));
          } else if (phone) {
            await press(page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }));
            await page.getByRole('heading', { level: 1, name: 'More' }).waitFor();
            await shot('4-more-page');
          } else {
            const more = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' });
            await press(more);
            await page.getByRole('heading', { level: 2, name: 'Work' }).waitFor();
            await shot('4-more-panel-open');
            await page.keyboard.press('Escape');
          }

          // 5 search with results; every row on screen must be in the API's answer for this person
          const api = await page.evaluate(async (q) => (await fetch(`/api/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })).json(), QUERY);
          const apiNames: string[] = (api.contacts as { name: string }[]).map((c) => c.name);
          if (mode === 'current') {
            await open('/search', 'Search');
            await page.getByRole('searchbox').fill(QUERY);
            await page.getByRole('heading', { level: 2, name: 'Contacts' }).waitFor({ timeout: 20_000 });
            await shot('5-search-page-with-results');
          } else {
            await open('/', 'Home');
            const field = page.getByRole('combobox', { name: 'Search people, deals and listings' }).and(page.locator(':visible'));
            if (phone) await field.tap();
            else {
              await page.keyboard.press('/');
              if (!(await field.evaluate((e) => e === document.activeElement))) fail(`${tag}: "/" did not focus the search field`);
            }
            await page.keyboard.type(QUERY, { delay: 30 });
            const list = page.getByRole('listbox', { name: 'Search results' });
            await list.getByRole('option').first().waitFor({ timeout: 20_000 });
            // the answer for the words in the field is in (the polite status says how many rows, or that nothing matched)
            await page.waitForFunction(() => /\d+ results?|No matches/.test(document.querySelector('[role="listbox"]')?.parentElement?.querySelector('[role="status"]')?.textContent ?? ''), undefined, { timeout: 20_000 });
            const shown = await page.evaluate(() => [...document.querySelectorAll('[role="listbox"] [role="group"][aria-label="People"] [role="option"]')].map((e) => (e.querySelector('span > span')?.textContent ?? '').trim()));
            if (shown.length === 0 && apiNames.length > 0) fail(`${tag}: the API returned people for "${QUERY}" and none is shown`);
            const invented = shown.filter((n) => !apiNames.includes(n));
            if (invented.length) fail(`${tag}: search shows people the API did not return: ${invented.join(', ')}`);
            note(`search.${tag}`, { apiReturnedPeople: apiNames, shownPeople: shown, apiDeals: api.deals.length, apiListings: api.listings.length, apiMessages: api.messages.length, apiNotes: api.notes.length });
            await shot('5-search-field-with-results');
          }
          if (role === 'agent') {
            const leaked = apiNames.filter((n) => theirs.some((p) => p.name === n));
            note(`scope.${tag}`, { query: QUERY, agentSees: apiNames, otherAgentsPeopleMatching: theirs.filter((p) => p.name.toLowerCase().includes(QUERY)).map((p) => p.name), returnedInFullToThisAgent: leaked });
          }

          // the keyboard walk, once per direction (desktop, agent)
          if (!phone && mode !== 'current' && role === 'agent') {
            const kb: Record<string, unknown> = {};
            const field = page.getByRole('combobox', { name: 'Search people, deals and listings' }).and(page.locator(':visible'));
            await page.keyboard.press('ArrowDown');
            const second = await page.locator('[role="option"][aria-selected="true"]').innerText();
            await page.keyboard.press('Enter');
            await page.waitForURL(/\/contacts\//, { timeout: 15_000 });
            kb.arrowDownEnterOpened = `${second.split('\n')[0]} → ${new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/, ':id')}`;
            await page.getByRole('button', { name: /^Stage: / }).waitFor({ timeout: 30_000 });
            await page.keyboard.press('Control+k');
            kb.ctrlKFocuses = await field.evaluate((e) => e === document.activeElement);
            await page.keyboard.type(QUERY, { delay: 30 });
            await page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first().waitFor({ timeout: 20_000 });
            await page.waitForFunction(() => document.querySelector('[role="option"]')?.getAttribute('aria-selected') === 'true');
            await page.keyboard.press('ArrowUp');
            kb.arrowUpWrapsTo = (await page.locator('[role="option"][aria-selected="true"]').innerText()).split('\n')[0];
            await page.keyboard.press('Enter');
            await page.waitForURL(/\/search\?q=mar/, { timeout: 15_000 });
            await page.getByRole('heading', { level: 2, name: 'Contacts' }).waitFor({ timeout: 20_000 });
            kb.seeAllOpened = new URL(page.url()).pathname + new URL(page.url()).search;
            // on the Search page the page's own field has focus, so "/" belongs to it; Ctrl+K still reaches the top field
            await page.keyboard.press('Control+k');
            await page.keyboard.type('dana', { delay: 30 });
            await page.keyboard.press('Escape');
            kb.escapeKeepsTextClosesList = (await field.inputValue()) === 'dana' && (await field.getAttribute('aria-expanded')) === 'false';
            await page.keyboard.press('Escape');
            kb.secondEscapeClears = (await field.inputValue()) === '';
            // More: Enter opens, Tab walks into the panel, Escape returns to the button; aria-current on the page's link
            await open('/templates', 'Templates');
            const more = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' });
            await more.focus();
            await page.keyboard.press('Enter');
            kb.moreExpanded = await more.getAttribute('aria-expanded');
            await page.keyboard.press('Tab');
            kb.tabGoesIntoPanel = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim());
            kb.currentPageInPanel = await page.locator('[aria-current="page"]').and(page.locator(':visible')).allInnerTexts();
            await page.keyboard.press('Escape');
            kb.escapeReturnsFocusToMore = await more.evaluate((e) => e === document.activeElement);
            await open('/people', 'People');
            kb.ariaCurrentOnPeople = await page.locator('[aria-current="page"]').and(page.locator(':visible')).allInnerTexts();
            kb.landmarks = await page.evaluate(() =>
              [...document.querySelectorAll('header, nav, main, aside, [role="search"]')]
                .filter((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed' || getComputedStyle(e).position === 'sticky')
                .filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0)
                .map((e) => `${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : ''}${e.getAttribute('aria-label') ? ` "${e.getAttribute('aria-label')}"` : ''}`),
            );
            note(`keyboard.${tag}`, kb);
            for (const [k, v] of Object.entries(kb)) if (v === false) fail(`${tag}: keyboard walk: ${k} is false`);
          }

          // content width (desktop, agent): the page column and the People list, at 1440 and at 1280
          if (!phone && role === 'agent') {
            for (const width of [1440, 1280]) {
              await page.setViewportSize({ width, height: 900 });
              await open('/people', 'People');
              await page.waitForLoadState('networkidle').catch(() => undefined);
              note(
                `contentWidth.${MODE_NAME[mode]}.${width}`,
                await page.evaluate(() => {
                  const main = document.querySelector('main')!;
                  const column = main.querySelector(':scope > div')!;
                  const widest = [...column.querySelectorAll<HTMLElement>('table, ul, [role="table"]')].reduce((m, e) => Math.max(m, Math.round(e.getBoundingClientRect().width)), 0);
                  return { roomForContent: Math.round(main.getBoundingClientRect().width), pageColumnUses: Math.round(column.getBoundingClientRect().width), widestListOrTable: widest };
                }),
              );
            }
          }
        } catch (e) {
          fail(`${tag}: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
          await page.screenshot({ path: `${out}/FAILED-${tag}.png` }).catch(() => undefined);
        }
        await ctx.close();
      }
    }
  }

  // ---- the other widths: 320 (a small phone), 768 (where the desktop layout begins), 1280 ----
  const WIDTHS: { name: string; options: BrowserContextOptions }[] = [
    { name: '320', options: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: '768', options: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2 } },
    { name: '1280', options: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } },
  ];
  for (const { role } of ROLES) {
    for (const wd of WIDTHS) {
      for (const mode of ['a', 'b'] as const) {
        const tag = `width-${wd.name}-${role}-${MODE_NAME[mode]}`;
        if (ONLY && !ONLY.test(tag)) continue;
        const ctx = await browser.newContext({ ...wd.options, storageState: sessions.get(role)! });
        await ctx.addInitScript(ESBUILD_NAME_SHIM);
        const page = await ctx.newPage();
        const narrow = wd.name === '320';
        try {
          await page.goto(`${stack.webUrl}/contacts/${longName.id}?nav=${mode}`);
          await page.getByRole('heading', { level: 1, name: longName.name }).waitFor({ timeout: 30_000 });
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await page.waitForTimeout(350);
          for (const x of await layoutProblems(page)) fail(`${tag}-long-name: ${x}`);
          await page.screenshot({ path: `${out}/${tag}-1-contact-with-a-long-name.png` });
          console.log(`${tag}-1-contact-with-a-long-name.png`);
          if (narrow) {
            await page.getByRole('combobox', { name: 'Search people, deals and listings' }).and(page.locator(':visible')).tap();
            await page.keyboard.type(QUERY, { delay: 30 });
            await page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first().waitFor({ timeout: 20_000 });
          } else {
            await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
            await page.getByRole('heading', { level: 2, name: 'Work' }).waitFor();
          }
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await page.waitForTimeout(350);
          for (const x of await layoutProblems(page)) fail(`${tag}-open: ${x}`);
          await page.screenshot({ path: `${out}/${tag}-2-${narrow ? 'search-open' : 'more-open'}.png` });
          console.log(`${tag}-2-${narrow ? 'search-open' : 'more-open'}.png`);
        } catch (e) {
          fail(`${tag}: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`);
          await page.screenshot({ path: `${out}/FAILED-${tag}.png` }).catch(() => undefined);
        }
        await ctx.close();
      }
    }
  }

  note('problems', problems);
  // a partial run (NAV_SHOTS_ONLY) writes its own file, so it never replaces the whole run's measurements
  const file = ONLY ? `measurements-${ONLY.source.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.json` : 'measurements.json';
  writeFileSync(`${out}/${file}`, JSON.stringify(report, null, 2));
  console.log(`${problems.length} problem(s); screenshots and ${file} in ${out}`);
} finally {
  await browser?.close();
  await stack.stop();
}
