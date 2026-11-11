// J7 — tenant isolation, against the REAL API (journeys/stack.ts: two tenants in one fresh Postgres
// database behind FORCE RLS, the RLS-bound app_user, fake providers), on the phone (iPhone 13, 390×844)
// and desktop (1440×900) projects. Team B holds an owned client (with a task, a deal and a sent text), a
// lead OFFERED to one of its agents and a lead in its pond, all named "Zelda …" like team A's own client.
// Signed in as team A's agent:
//   - no B person shows anywhere in the UI: Home feed, Search type-ahead (by name and by B's phone digits),
//     People, Pond; B's contact URL and thread URL say "This isn't available" and never show the name;
//   - with A's own browser session, every API probe for B's ids (contact, details, timeline, notes, points,
//     reachability, task, deal, pond cards, and the claim / accept / send commands) answers 404, never
//     403, and no response body carries B's name or phone;
//   - the database confirms none of those probes changed anything of B's (ownership, messages, sends).
import { type Page, expect, test } from 'playwright/test';
import { browserApi, feedCard, isPhone, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let a: WorldInfo;
let b: WorldInfo;
const B: { owned: string; offered: string; offerId: string; pond: string; pondId: string; task: string; deal: string; message: string; phone: string } = {} as never;
let aOwn: string;
const B_NAMES = ['Zelda Bravo', 'Zelda Offered', 'Zelda Pondside'];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack();
  a = await stack.world({ name: 'a', agents: 1 });
  b = await stack.world({ name: 'b', agents: 1 });
  const must = <T>(r: { status: number; body: T }, what: string) => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  // team A: its agent's own client "Zelda Alpha", and an A lead offered to that agent
  aOwn = must(await stack.api<{ contact: { id: string } }>('a.agent0', 'POST', '/contacts', { commandId: crypto.randomUUID(), firstName: 'Zelda', lastName: 'Alpha', phones: [(await stack.fixture<{ phone: string }>('/phone')).phone] }), 'A contact').contact.id;
  await stack.fixture('/intake', { world: 'a', body: { fullName: 'Arlo Alpha' } });
  // team B: an owned client with a task, a deal and a sent text
  B.phone = (await stack.fixture<{ phone: string }>('/phone')).phone;
  B.owned = must(await stack.api<{ contact: { id: string } }>('b.agent0', 'POST', '/contacts', { commandId: crypto.randomUUID(), firstName: 'Zelda', lastName: 'Bravo', phones: [B.phone] }), 'B contact').contact.id;
  B.task = must(await stack.api<{ task: { id: string } }>('b.agent0', 'POST', '/tasks', { title: 'Call Zelda Bravo about the offer', contactId: B.owned, dueAt: new Date(Date.now() + 3_600_000).toISOString() }), 'B task').task.id;
  B.deal = must(await stack.api<{ deal: { id: string } }>('b.agent0', 'POST', '/deals', { primaryContactId: B.owned, side: 'buy', priceCents: 85000000, expectedCloseDate: '2026-12-18' }), 'B deal').deal.id;
  B.message = must(await stack.api<{ message: { id: string } }>('b.agent0', 'POST', `/contacts/${B.owned}/messages`, { channel: 'sms', body: 'Hi Zelda, the inspection is Tuesday.', idempotencyKey: `k-${crypto.randomUUID()}` }), 'B text').message.id;
  // team B: a lead offered to B's agent, and a lead accepted then released to B's pond
  B.offered = (await stack.fixture<{ body: { contactId: string } }>('/intake', { world: 'b', body: { fullName: 'Zelda Offered' } })).body.contactId;
  B.offerId = (await stack.sql<{ offer_id: string }>('SELECT offer_id FROM contacts WHERE id = $1', [B.offered]))[0]!.offer_id;
  B.pond = (await stack.fixture<{ body: { contactId: string } }>('/intake', { world: 'b', body: { fullName: 'Zelda Pondside' } })).body.contactId;
  const pOffer = (await stack.sql<{ offer_id: string }>('SELECT offer_id FROM contacts WHERE id = $1', [B.pond]))[0]!.offer_id;
  must(await stack.api('b.agent0', 'POST', `/leads/${B.pond}/accept`, { commandId: crypto.randomUUID(), offerId: pOffer }), 'B accept');
  must(await stack.api('b.agent0', 'POST', `/leads/${B.pond}/release`, { commandId: crypto.randomUUID(), reason: 'not_a_fit', toPondId: b.defaultPondId }), 'B release');
  B.pondId = b.defaultPondId;
  const states = await stack.sql<{ id: string; ownership_state: string }>('SELECT id, ownership_state FROM contacts WHERE id = ANY($1)', [[B.offered, B.pond]]);
  expect(Object.fromEntries(states.map((s) => [s.id, s.ownership_state]))).toEqual({ [B.offered]: 'offered', [B.pond]: 'in_pond' });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** No team-B name or phone anywhere in the page's text. */
async function noB(page: Page, where: string, o: { echoed?: string } = {}) {
  // the page may echo what was typed ("No results for …"): that is the query, not B's data
  const text = ((await page.locator('body').textContent()) ?? '').split(o.echoed ?? '\u0000').join('');
  for (const n of [...B_NAMES, 'Bravo', 'Pondside']) expect(text, `${where} shows ${n}`).not.toContain(n);
  expect(text.replace(/\D/g, ''), `${where} shows B's phone`).not.toContain(B.phone.slice(-7));
}

test("J7: team A's agent never sees team B's people in the feed, Search, People, Pond or by URL", async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page, stack, a.agents[0]!);

  // Home feed: A's own offer is there, nothing of B's
  await expect(feedCard(page, 'Arlo Alpha')).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await noB(page, 'Home');
  await shot(page, info, 'j7', '1-home');

  // Search type-ahead: "Zelda" finds only A's Zelda; B's phone digits find nothing
  await page.goto(`${stack.webUrl}/search`);
  const q = page.getByRole('searchbox');
  await q.fill('Zelda');
  await expect(page.getByRole('link', { name: /Zelda Alpha/ })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await noB(page, 'Search "Zelda"');
  await shot(page, info, 'j7', '2-search');
  await q.fill(B.phone.slice(-7));
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('link', { name: /Zelda/ })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('list').filter({ has: page.getByRole('link', { name: /Zelda/ }) })).toHaveCount(0);
  await noB(page, "Search B's phone", { echoed: B.phone.slice(-7) });

  // People: A's people only
  await page.goto(`${stack.webUrl}/people`);
  await expect(page.getByText('Zelda Alpha').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await noB(page, 'People');
  await shot(page, info, 'j7', '3-people');

  // Pond: A's pond does not hold B's released lead
  await page.goto(`${stack.webUrl}/pond`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pond' })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await noB(page, 'Pond');

  // direct URLs for B's people: "This isn't available", no name
  for (const id of [B.owned, B.offered, B.pond]) {
    for (const path of [`/contacts/${id}`, `/contacts/${id}/thread`]) {
      await page.goto(`${stack.webUrl}${path}`);
      await expect(page.getByText("This isn't available. It may have moved, or you may not have access to it.").first()).toBeVisible({ timeout: 15_000 });
      await noB(page, path);
    }
  }
  await shot(page, info, 'j7', '4-direct-url');
  if (isPhone(page)) {
    // the phone's Search tab reaches the same type-ahead
    await tap(page, page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'Search' }));
    await expect(page.getByRole('searchbox')).toBeVisible();
  }
});

test("J7: API probes with team A's session for team B's ids answer 404 (not 403), leak nothing, and change nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, stack, a.agents[0]!);
  const api = await browserApi(page, stack);
  const sendsBefore = (await stack.sends()).sms.filter((m) => m.to === B.phone).length;
  const cmd = () => crypto.randomUUID();
  const probes: [string, () => Promise<{ status(): number; text(): Promise<string> }>][] = [
    [`GET /contacts/${B.owned}`, () => api.get(`/contacts/${B.owned}`)],
    [`GET /contacts/${B.offered}`, () => api.get(`/contacts/${B.offered}`)],
    [`GET /contacts/${B.pond}`, () => api.get(`/contacts/${B.pond}`)],
    [`GET /contacts/:id/details`, () => api.get(`/contacts/${B.owned}/details`)],
    [`GET /contacts/:id/timeline`, () => api.get(`/contacts/${B.owned}/timeline`)],
    [`GET /contacts/:id/notes`, () => api.get(`/contacts/${B.owned}/notes`)],
    [`GET /contacts/:id/points`, () => api.get(`/contacts/${B.owned}/points`)],
    [`GET /contacts/:id/reachability`, () => api.get(`/contacts/${B.owned}/reachability`)],
    [`GET /tasks/${B.task}`, () => api.get(`/tasks/${B.task}`)],
    [`GET /deals/${B.deal}`, () => api.get(`/deals/${B.deal}`)],
    [`GET /ponds/${B.pondId}/cards`, () => api.get(`/ponds/${B.pondId}/cards`)],
    [`PATCH /tasks/${B.task}`, () => api.patch(`/tasks/${B.task}`, { status: 'done' })],
    [`POST /messages/${B.message}/cancel`, () => api.post(`/messages/${B.message}/cancel`)],
    [`POST /contacts/:id/messages`, () => api.post(`/contacts/${B.owned}/messages`, { channel: 'sms', body: 'probe', idempotencyKey: `k-${cmd()}` })],
    [`POST /contacts/:id/notes`, () => api.post(`/contacts/${B.owned}/notes`, { body: 'probe' })],
    [`POST /leads/:pond/claim`, () => api.post(`/leads/${B.pond}/claim`, { commandId: cmd(), pondId: B.pondId })],
    [`POST /leads/:offered/accept`, () => api.post(`/leads/${B.offered}/accept`, { commandId: cmd(), offerId: B.offerId })],
  ];
  const wrong: string[] = [];
  for (const [label, run] of probes) {
    const r = await run();
    const body = await r.text();
    if (r.status() !== 404) wrong.push(`${label} → ${r.status()} ${body.slice(0, 200)}`);
    for (const leak of [...B_NAMES, B.phone, B.phone.slice(-7)]) if (body.includes(leak)) wrong.push(`${label} leaks ${leak}`);
  }
  expect(wrong).toEqual([]);
  // nothing of B's changed: ownership, the task, messages, sends
  const [st] = await stack.sql<{ offered: string; pond: string; task: string; msgs: number }>(
    `SELECT (SELECT ownership_state FROM contacts WHERE id = $1) AS offered, (SELECT ownership_state FROM contacts WHERE id = $2) AS pond,
            (SELECT status FROM tasks WHERE id = $3) AS task, (SELECT count(*)::int FROM messages WHERE contact_id = $4) AS msgs`,
    [B.offered, B.pond, B.task, B.owned],
  );
  expect(st).toEqual({ offered: 'offered', pond: 'in_pond', task: 'open', msgs: 1 });
  expect((await stack.sends()).sms.filter((m) => m.to === B.phone).length).toBe(sendsBefore);
  // and A's own client still answers 200 on the same session (the probes are not just failing everything)
  expect((await api.get(`/contacts/${aOwn}`)).status()).toBe(200);
});
