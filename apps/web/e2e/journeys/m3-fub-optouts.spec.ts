// M3 — opt-outs survive a Follow Up Boss migration, against the REAL API (journeys/stack.ts: a fresh Postgres
// database, RLS-bound app_user, fake providers, api/imports on the deterministic FAKE Follow Up Boss
// connector), on the phone (iPhone 13, 390×844) and desktop (1440×900) projects.
// Owner decision D1: a send checks only opt-outs, and an opt-out imported from FUB blocks exactly like a
// native one (R-CONSENT-3, E40: "a STOP in FUB stays a STOP here").
//
// The fake FUB account (one FUB user, mapped to the world's agent, owns everyone):
//   Olly    phone status "Opted Out" (and smsOptIn: true, which the opt-out overrides)      → no texts
//   Uma     email status "Unsubscribed" (and emailOptIn: true)                              → no email
//   Dina    tag "DNC", a valid phone and a valid email                                      → nothing at all
//   Tess    doNotText: true, a valid phone                                                  → no texts
//   Ursula  unsubscribed: true, a valid email                                               → no email
//   Carl    the control: a valid phone and email, smsOptIn/emailOptIn: true                 → reachable
// The Owner migrates through the API (the Imports UI path is J6's): create → snapshot → map the FUB user →
// contacts dry run / approve / commit / verify → ownership the same → notes, messages and recordings
// skipped. The consent stage is left PENDING for M3.1 and committed in M3.2.
//
// For each phase, as the agent in the browser and straight at the API, for every opted-out person and
// channel: the one-to-one message, a template message, a bulk send (text: batch text on, R-PAR-40; email:
// marketing-ready, R-PAR-39) and a plan (bulk Enroll and Stage → Active auto-enroll, plus a direct API
// enroll). Asserted: the reason is on screen before any tap and Send is disabled (no "anyway"); the API
// refuses (gate deny, recorded in gate_decisions); the database holds no queued/sent message to that
// person, no bulk item with a message, no live enrollment; the fake providers got nothing for the
// opted-out addresses. The control gets exactly one message per path, so the gate is selective.
import { randomUUID } from 'node:crypto';
import { type Page, expect, test } from 'playwright/test';
import { drainUntil, isPhone, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;
let batchId: string;
let tplSms: string;
let tplEmail: string;
/** the agent's approved one-step plans: a text (Stage → Active enrolls into it) and an email */
const plans: Record<Ch, string> = { sms: '', email: '' };

const OWNER = 'a.owner';
const AGENT = 'a.agent0';

type Ch = 'sms' | 'email';
interface Person {
  key: 'olly' | 'uma' | 'dina' | 'tess' | 'ursula' | 'carl';
  first: string;
  phone: string | null;
  email: string | null;
  /** the channels the FUB data opts this person out of */
  blocks: Ch[];
  id: string;
  name: string;
}
const people: Record<Person['key'], Person> = {} as never;
const optedOut = () => Object.values(people).filter((p) => p.key !== 'carl');
const smsOut = () => optedOut().filter((p) => p.blocks.includes('sms'));
const emailOut = () => optedOut().filter((p) => p.blocks.includes('email'));

// The child routes: batch text (as j3), marketing email readiness (as j9) and the FUB account.
const ROUTES = String.raw`
  /** the Owner turns batch text on through the real route: fresh re-auth + the typed attestation (R-PAR-40) */
  async '/batch-text-on'(b) {
    await freshReauth(h, client(b.as));
    const owner = client(b.as);
    const ww = world('a');
    const reg = must(await call(owner, 'POST', '/sender-registrations', { kind: 'a2p_campaign', useCase: 'marketing', sampleMessages: ['New listings near you this week. Reply STOP to opt out.'], optInDescription: 'Leads opt in on our website form.' }), 'registration');
    must(await call(owner, 'POST', '/sender-registrations/' + reg.registration.id + '/refresh'), 'refresh');
    must(await call(owner, 'PATCH', '/numbers/' + ww.mainNumberId + '/registration', { registrationId: reg.registration.id }), 'attach');
    return must(await call(owner, 'PUT', '/batch-text', { enabled: true, attestation: BATCH_TEXT_ATTESTATION }), 'batch text');
  },
  /** a verified sending domain, an email identity per member, the brokerage postal address (R-PAR-39) */
  async '/marketing-ready'(b) {
    const ww = world(b.world);
    await marketingReady(h, ww);
    // a plan's email goes out from the TEAM identity (comms chooseEmailIdentity with no user): put a team
    // identity on the verified domain (through the API) and retire commsWorld's domainless one, which can
    // never pass the marketing-email domain check (R-PAR-39)
    const dom = (await h.su.query('SELECT id, domain FROM sending_domains WHERE tenant_id = $1 AND verified_at IS NOT NULL LIMIT 1', [ww.tenantId])).rows[0];
    await suFixture(h, [{ text: "UPDATE email_identities SET status = 'disabled' WHERE tenant_id = $1 AND user_id IS NULL AND domain_id IS NULL", values: [ww.tenantId] }]);
    must(await call(ww.owner, 'POST', '/email-identities', { fromAddress: 'team@' + dom.domain, displayName: 'Team A', domainId: dom.id }), 'team identity');
    return { ok: true };
  },
  /** a FUB account under a fresh key: the five FUB opt-out shapes and a control, all assigned to FUB user 11 */
  async '/fub-load'(b) {
    const key = 'fub-m3-' + randomUUID().slice(0, 12);
    const a = { olly: randomPhone(), dinaP: randomPhone(), tess: randomPhone(), carlP: randomPhone(), uma: randomEmail(), dinaE: randomEmail(), ursula: randomEmail(), carlE: randomEmail() };
    const s = b.surname;
    // Field names and the status vocabulary follow packages/core/src/import/fub.ts (mapConsent), which marks
    // the consent indicators as assumptions: VERIFY "Opted Out" / "Unsubscribed" point statuses and the
    // doNotText / unsubscribed person flags against a real FUB export before go-live.
    fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [
        { id: 7301, created: '2023-05-01T10:00:00Z', firstName: 'Olly', lastName: s, assignedUserId: 11, smsOptIn: true, // VERIFY smsOptIn
          phones: [{ value: a.olly, type: 'mobile', status: 'Opted Out', isPrimary: 1 }] }, // VERIFY status "Opted Out"
        { id: 7302, created: '2023-05-02T10:00:00Z', firstName: 'Uma', lastName: s, assignedUserId: 11, emailOptIn: true, // VERIFY emailOptIn
          emails: [{ value: a.uma, type: 'home', status: 'Unsubscribed', isPrimary: 1 }] }, // VERIFY status "Unsubscribed"
        { id: 7303, created: '2023-05-03T10:00:00Z', firstName: 'Dina', lastName: s, assignedUserId: 11, tags: ['DNC'],
          phones: [{ value: a.dinaP, type: 'mobile', status: 'Valid', isPrimary: 1 }], emails: [{ value: a.dinaE, type: 'home', status: 'Valid', isPrimary: 1 }] },
        { id: 7304, created: '2023-05-04T10:00:00Z', firstName: 'Tess', lastName: s, assignedUserId: 11, doNotText: true, // VERIFY doNotText
          phones: [{ value: a.tess, type: 'mobile', status: 'Valid', isPrimary: 1 }] },
        { id: 7305, created: '2023-05-05T10:00:00Z', firstName: 'Ursula', lastName: s, assignedUserId: 11, unsubscribed: true, // VERIFY unsubscribed
          emails: [{ value: a.ursula, type: 'home', status: 'Valid', isPrimary: 1 }] },
        { id: 7306, created: '2023-05-06T10:00:00Z', firstName: 'Carl', lastName: s, assignedUserId: 11, smsOptIn: true, emailOptIn: true,
          phones: [{ value: a.carlP, type: 'mobile', status: 'Valid', isPrimary: 1 }], emails: [{ value: a.carlE, type: 'home', status: 'Valid', isPrimary: 1 }] },
      ],
    });
    return { key, a };
  },
`;

interface StageView { category: string; status: string; dryRunSha256: string | null; counts: { source: number; willImport: number; imported: number | null; needsReview: number; rejected: number; duplicate: number } | null }

async function must<T>(p: Promise<{ status: number; body: T }>, ok: number[] = [200, 201, 202]): Promise<T> {
  const r = await p;
  expect(ok, JSON.stringify(r.body)).toContain(r.status);
  return r.body;
}
const stageOf = async (cat: string) => (await stack.api<{ batch: { stages: StageView[] } }>(OWNER, 'GET', `/imports/${batchId}`)).body.batch.stages.find((s) => s.category === cat)!;
async function untilStage(cat: string, status: string) {
  await expect.poll(async () => {
    await stack.jobs();
    return (await stageOf(cat)).status;
  }, { timeout: 60_000 }).toBe(status);
}

/** dry run → (needs-review records decided "import") → approve that dry run → commit → verify the sample. */
async function fullStage(cat: string) {
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/dry-run`));
  await untilStage(cat, 'dry_run_ready');
  const recs = await stack.api<{ records: { id: string; dryRunOutcome: string | null }[] }>(OWNER, 'GET', `/imports/${batchId}/stages/${cat}/records?limit=200`);
  for (const r of recs.body.records.filter((x) => x.dryRunOutcome === 'needs_review')) await must(stack.api(OWNER, 'POST', `/imports/${batchId}/records/${r.id}/review`, { decision: 'import' }));
  const d = await stageOf(cat);
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/approve`, { snapshotSha256: d.dryRunSha256 }));
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/commit`));
  await untilStage(cat, 'committed');
  const v = await stack.api<{ sample: { sourceRef: string; same: boolean }[] }>(OWNER, 'GET', `/imports/${batchId}/stages/${cat}/verification`);
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/verify`, { spotChecks: v.body.sample.map((s) => ({ sourceRef: s.sourceRef, matches: s.same })) }));
  return d;
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({
    imports: "import { BATCH_TEXT_ATTESTATION } from './src/bulk/batchText.ts';\nimport { marketingReady } from './src/bulk/testing.ts';",
    routes: ROUTES,
  });
  w = await stack.world({ agents: 1 });
  await stack.fixture('/batch-text-on', { as: OWNER });
  await stack.fixture('/marketing-ready', { world: 'a' });
  // the agent's own text and email templates, and two approved plans: a text plan (Stage → Active enrolls
  // into it) and an email plan. One step each, due at enrollment: a later step waits for a minimum gap the
  // journey cannot wait out (the database clock is real)
  const t = await must(stack.api<{ template: { id: string } }>(AGENT, 'POST', '/templates', { scope: 'personal', channel: 'sms', name: 'Market update', body: 'Hi {{contact.first_name}}, prices moved in your area this month. Want the numbers?' }));
  tplSms = t.template.id;
  const e = await must(stack.api<{ template: { id: string } }>(AGENT, 'POST', '/templates', { scope: 'personal', channel: 'email', name: 'Market report', subject: 'Your market report', body: 'Hi {{contact.first_name}}, here is this month\'s market report for your area.' }));
  tplEmail = e.template.id;
  const base = { purpose: 'marketing', category: 'nurture_step', intent: 'check_in', personalization: 'none', slots: ['first_name'], stopIf: [], delay: { anchor: 'enrollment', offsetSeconds: 0 }, template: 'Hi {{first_name}}, checking in on your plans this year.' };
  const plan = async (ch: Ch, name: string, step: Record<string, unknown>) => {
    const pb = await must(stack.api<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(AGENT, 'POST', '/playbooks', { kind: 'nurture', scope: 'agent', name, steps: [{ ...base, ...step }] }));
    const v = pb.playbook.versions[0]!;
    await must(stack.api(AGENT, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 }));
    plans[ch] = pb.playbook.id;
  };
  await plan('sms', 'Text check-in', { stepKey: 'text_in', channel: 'sms', maxLength: 640 });
  await plan('email', 'Email check-in', { stepKey: 'mail_in', channel: 'email', subject: 'Checking in', maxLength: 4000 });
  await must(stack.api(AGENT, 'PUT', `/playbooks/${plans.sms}/auto-enroll-stage`, { stage: 'active' }));
});
test.afterAll(async () => {
  await stack?.stop();
});

// ---- probes ------------------------------------------------------------------------------------------------

const smsTo = async (phone: string) => (await stack.sends()).sms.filter((m) => m.to === phone);
const emailsTo = async (email: string) => (await stack.sends()).emails.filter((m) => m.to.toLowerCase() === email.toLowerCase());
async function controlCounts() {
  const c = people.carl;
  return { sms: (await smsTo(c.phone!)).length, email: (await emailsTo(c.email!)).length };
}

/** Nothing ever reached an opted-out address, and nothing is waiting to go to one. */
async function nothingReachedOptedOut() {
  const s = await stack.sends();
  for (const p of optedOut()) {
    for (const ch of p.blocks) {
      const addr = ch === 'sms' ? p.phone! : p.email!;
      const got = ch === 'sms' ? s.sms.filter((m) => m.to === addr) : s.emails.filter((m) => m.to.toLowerCase() === addr.toLowerCase());
      expect(got, `${p.first}: nothing reaches the opted-out ${ch} address`).toEqual([]);
    }
    const live = await stack.sql<{ channel: string; status: string }>("SELECT channel, status FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND status NOT IN ('blocked','canceled')", [p.id]);
    const onBlocked = live.filter((m) => p.blocks.includes(m.channel === 'email' ? 'email' : 'sms'));
    expect(onBlocked, `${p.first}: no queued/scheduled/sent message on an opted-out channel`).toEqual([]);
  }
}

const OPT_OUT_GATE = new Set(['CONSENT_REVOKED', 'SUPPRESSED', 'PERSON_DO_NOT_CONTACT']);

/** One-to-one and template sends straight at the API: the gate denies with an opt-out reason, recorded. */
async function apiRefuses(p: Person, ch: Ch) {
  type R = { result: string; message: { id: string; status: string; statusReason: string } | null; decision: { outcome: string; reasons: string[] } | null };
  const one = await stack.api<R>(AGENT, 'POST', `/contacts/${p.id}/messages`, { channel: ch, body: 'Quick question about your home search', ...(ch === 'email' ? { subject: 'Quick question' } : {}), idempotencyKey: `m3-${randomUUID()}` });
  expect(one.status, JSON.stringify(one.body)).toBe(200);
  expect(one.body.result, `${p.first} ${ch}: ${JSON.stringify(one.body)}`).toBe('blocked');
  expect(one.body.decision?.outcome).toBe('deny');
  expect(one.body.decision!.reasons.some((r) => OPT_OUT_GATE.has(r)), JSON.stringify(one.body.decision)).toBe(true);
  expect(one.body.message?.status).toBe('blocked');
  const rendered = await stack.api<{ rendered: { body: string; subject: string | null } }>(AGENT, 'POST', `/templates/${ch === 'sms' ? tplSms : tplEmail}/render`, { contactId: p.id });
  expect(rendered.status, JSON.stringify(rendered.body)).toBe(200);
  const viaTpl = await stack.api<R>(AGENT, 'POST', `/contacts/${p.id}/messages`, { channel: ch, body: rendered.body.rendered.body, ...(ch === 'email' ? { subject: rendered.body.rendered.subject ?? 'Your market report' } : {}), idempotencyKey: `m3-${randomUUID()}` });
  expect(viaTpl.body.result, `${p.first} ${ch} template: ${JSON.stringify(viaTpl.body)}`).toBe('blocked');
  for (const m of [one.body.message!, viaTpl.body.message!]) {
    const d = await stack.sql<{ outcome: string; reason_codes: string[] }>('SELECT outcome, reason_codes FROM gate_decisions WHERE message_id = $1', [m.id]);
    expect(d).toHaveLength(1);
    expect(d[0]!.outcome).toBe('deny');
    expect(d[0]!.reason_codes.some((r) => OPT_OUT_GATE.has(r)), JSON.stringify(d)).toBe(true);
    const [row] = await stack.sql<{ status: string; status_reason: string }>('SELECT status, status_reason FROM messages WHERE id = $1', [m.id]);
    expect(row!.status).toBe('blocked');
    expect(OPT_OUT_GATE.has(row!.status_reason), row!.status_reason).toBe(true);
  }
}

// ---- screens -----------------------------------------------------------------------------------------------

/**
 * The sentence the page says for each imported opt-out (reasons/sentences.ts): a FUB revocation is source
 * 'imported' ("Opted out of texts in your previous system on Nov 11 (imported)"), a DNC tag is an import_dnc
 * suppression ("Marked do-not-contact in your previous system (imported Nov 11)").
 */
const DAY = String.raw`[A-Z][a-z]{2} \d{1,2}(, \d{4})?`;
const importedReason = (p: Person, ch: Ch) =>
  p.key === 'dina'
    ? new RegExp(`^Marked do-not-contact in your previous system \\(imported ${DAY}\\)$`)
    : new RegExp(`^Opted out of ${ch === 'sms' ? 'texts' : 'email'} in your previous system on ${DAY} \\(imported\\)$`);

async function contactPage(page: Page, p: Person) {
  await page.goto(`${stack.webUrl}/contacts/${p.id}`);
  await expect(page.getByRole('heading', { level: 1, name: p.name })).toBeVisible({ timeout: 15_000 });
}

/** The person's page and the composer: the reason before any tap, Send disabled, a template does not enable it. */
async function screenRefuses(page: Page, p: Person, ch: Ch, info: Parameters<typeof shot>[1], phase: string) {
  await contactPage(page, p);
  const action = page.getByRole('button', { name: ch === 'sms' ? 'Text' : 'Email', exact: true });
  await expect(action).toBeDisabled({ timeout: 15_000 });
  await expect(action).toHaveAccessibleDescription(importedReason(p, ch));
  await expect(page.getByText(importedReason(p, ch)).first()).toBeVisible();
  if (p.key === 'dina' && ch === 'sms') await expect(page.getByRole('button', { name: 'Call', exact: true })).toBeDisabled();
  if (phase && ch === p.blocks[0]) await shot(page, info, 'm3', `${phase}-${p.key}-contact`);

  await page.goto(`${stack.webUrl}/contacts/${p.id}/thread?compose=${ch}`);
  const box = page.getByRole('textbox', { name: ch === 'sms' ? 'Text message' : 'Email message' });
  await box.fill('Still thinking about selling this year?');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled({ timeout: 15_000 });
  await expect(send).toHaveAccessibleDescription(importedReason(p, ch));
  await tap(page, page.getByRole('button', { name: 'Templates' }));
  await tap(page, page.getByRole('dialog', { name: ch === 'sms' ? 'Text templates' : 'Email templates' }).getByRole('button', { name: ch === 'sms' ? /Market update/ : /Market report/ }));
  await expect(box).toHaveValue(new RegExp(`^Hi ${p.first},`));
  await expect(send).toBeDisabled();
  await expect(page.getByRole('button', { name: /anyway/i })).toHaveCount(0);
  if (phase && ch === p.blocks[0]) await shot(page, info, 'm3', `${phase}-${p.key}-${ch}-compose`);
}

/** The control's one-to-one text from the composer reaches the fake provider exactly once. */
async function controlTextSent(page: Page) {
  const c = people.carl;
  const before = (await smsTo(c.phone!)).length;
  await contactPage(page, c);
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Email', exact: true })).toBeEnabled();
  await page.goto(`${stack.webUrl}/contacts/${c.id}/thread?compose=sms`);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Hi Carl, welcome over from our old system!');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await tap(page, send);
  await expect.poll(async () => (await smsTo(c.phone!)).length, { timeout: 20_000 }).toBe(before + 1);
}

/** A bulk text / email from the sheet: the opted-out people are counted under a reason before Confirm; only Carl gets it. */
async function bulkSend(page: Page, kind: 'text' | 'email', out: Person[], info: Parameters<typeof shot>[1], phase: string) {
  const c = people.carl;
  const before = await controlCounts();
  const ids = [...out.map((p) => p.id), c.id];
  await page.goto(`${stack.webUrl}/bulk/new?kind=${kind}&contacts=${ids.join(',')}`);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: kind === 'text' ? /Market update/ : /Market report/ }));
  const sheet = page.getByRole('dialog', { name: `${kind === 'text' ? 'Text' : 'Email'} 1 of ${ids.length}?` });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  const left = sheet.getByRole('region', { name: `Left out (${out.length})` });
  await expect(left).toBeVisible();
  // every left-out person is counted under an opt-out reason (opted out / asked not to be contacted / blocked)
  const reasons = await left.locator('[data-reason]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-reason'), e.textContent ?? ''] as const));
  expect(reasons.every(([r]) => ['RECIPIENT_OPTED_OUT', 'RECIPIENT_SUPPRESSED', 'PERSON_DO_NOT_CONTACT'].includes(r ?? '')), JSON.stringify(reasons)).toBe(true);
  expect(reasons.reduce((n, [, t]) => n + Number(/^\d+/.exec(t)?.[0] ?? 0), 0)).toBe(out.length);
  await expect(sheet.getByRole('checkbox')).toHaveCount(0);
  await shot(page, info, 'm3', `${phase}-bulk-${kind}-sheet`);
  await tap(page, sheet.getByRole('button', { name: `${kind === 'text' ? 'Text' : 'Email'} 1 person` }));
  await expect(page).toHaveURL(/\/bulk\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const bulkId = new URL(page.url()).pathname.split('/').at(-1)!;
  await drainUntil(stack, async () => (await stack.sql<{ status: string }>('SELECT status FROM bulk_actions WHERE id = $1', [bulkId]))[0]?.status === 'completed', { timeout: 30_000 });
  const ch = kind === 'text' ? 'sms' : 'email';
  await drainUntil(stack, async () => (await controlCounts())[ch] > before[ch], { timeout: 30_000 });
  expect((await controlCounts())[ch], `Carl gets exactly one bulk ${kind}`).toBe(before[ch] + 1);
  const items = await stack.sql<{ contact_id: string; status: string; message_id: string | null }>('SELECT contact_id, status, message_id FROM bulk_action_items WHERE bulk_action_id = $1', [bulkId]);
  for (const p of out) for (const i of items.filter((x) => x.contact_id === p.id)) expect(i, `${p.first}'s bulk item`).toMatchObject({ status: expect.stringMatching(/skipped|blocked/), message_id: null });
  // the API's own view of the action says the same: one target, the others left out by an opt-out reason
  const view = (await stack.api<{ action: { targetCount: number; selected: number; preflight: Record<string, number> } }>(AGENT, 'GET', `/bulk-actions/${bulkId}`)).body.action;
  expect(view).toMatchObject({ targetCount: 1, selected: ids.length });
  const optOutSkips = ['RECIPIENT_OPTED_OUT', 'RECIPIENT_SUPPRESSED', 'PERSON_DO_NOT_CONTACT'].reduce((n, k) => n + (view.preflight[k] ?? 0), 0);
  expect(optOutSkips, JSON.stringify(view.preflight)).toBe(out.length);
}

/** Enroll the opted-out people and Carl in a plan from the bulk sheet: the opted-out are left out ("can't be reached"); Carl is enrolled and gets the plan's one message exactly once. */
async function bulkEnroll(page: Page, ch: Ch, out: Person[], info: Parameters<typeof shot>[1], phase: string) {
  const c = people.carl;
  const ids = [...out.map((p) => p.id), c.id];
  await page.goto(`${stack.webUrl}/bulk/new?kind=enroll&contacts=${ids.join(',')}&plan=${plans[ch]}`);
  const sheet = page.getByRole('dialog', { name: `Enroll 1 of ${ids.length}?` });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('region', { name: `Left out (${out.length})` }).locator('[data-reason="UNREACHABLE"]')).toHaveText(`${out.length} can't be reached by text or email`);
  await shot(page, info, 'm3', `${phase}-bulk-enroll-${ch}-sheet`);
  const before = await controlCounts();
  await tap(page, sheet.getByRole('button', { name: 'Enroll 1 person' }));
  await expect(page).toHaveURL(/\/bulk\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const bulkId = new URL(page.url()).pathname.split('/').at(-1)!;
  await drainUntil(stack, async () => (await stack.sql<{ status: string }>('SELECT status FROM bulk_actions WHERE id = $1', [bulkId]))[0]?.status === 'completed', { timeout: 30_000 });
  for (const p of out) expect(await stack.sql("SELECT 1 FROM playbook_enrollments WHERE contact_id = $1 AND state IN ('active','paused')", [p.id]), `${p.first} is not in a plan`).toEqual([]);
  const [enr] = await stack.sql<{ id: string }>("SELECT id FROM playbook_enrollments WHERE contact_id = $1 AND playbook_id = $2 AND state IN ('active','completed')", [c.id, plans[ch]]);
  expect(enr, 'Carl is enrolled').toBeTruthy();
  await drainUntil(stack, async () => (await controlCounts())[ch] > before[ch], { kinds: ['playbook.step', 'comms.dispatch'], timeout: 30_000 }).catch(async (err) => {
    const dbg = { msgs: await stack.sql("SELECT channel, status, status_reason, playbook_step_run_id FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at", [c.id]), runs: await stack.sql('SELECT * FROM playbook_step_runs WHERE enrollment_id = $1', [enr!.id]), enr: await stack.sql('SELECT state, current_step, next_step_due_at, pause_reason FROM playbook_enrollments WHERE id = $1', [enr!.id]), sends: await stack.sends() };
    throw new Error(`${String(err)}\n${JSON.stringify(dbg, null, 1)}`);
  });
  expect(await controlCounts(), `Carl gets the ${ch} plan's message exactly once`).toEqual({ ...before, [ch]: before[ch] + 1 });
  // end Carl's plan (if it has not ended on its own) so he can be enrolled again
  const [st] = await stack.sql<{ state: string }>('SELECT state FROM playbook_enrollments WHERE id = $1', [enr!.id]);
  if (st!.state === 'active' || st!.state === 'paused') await must(stack.api(AGENT, 'POST', `/enrollments/${enr!.id}/stop`));
}

/** Stage → Active (the text plan's auto-enroll stage) never enrolls an opted-out person; a direct enroll never sends. */
async function planRefuses() {
  for (const p of optedOut()) {
    const [cur] = await stack.sql<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [p.id]);
    if (cur!.stage === 'active') await must(stack.api(AGENT, 'POST', `/contacts/${p.id}/stage`, { stage: 'nurture' }));
    const st = await stack.api<{ automation: unknown }>(AGENT, 'POST', `/contacts/${p.id}/stage`, { stage: 'active' });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(st.body.automation, `${p.first}: the plan is skipped because no channel can reach them`).toEqual({ skipped: 'cannot_be_reached', plan: 'Text check-in' });
    await stack.jobs({ tenantId: w.tenantId });
    expect(await stack.sql("SELECT state FROM playbook_enrollments WHERE contact_id = $1 AND state IN ('active','paused')", [p.id]), `${p.first}: Stage → Active does not enroll (${JSON.stringify(st.body.automation)})`).toEqual([]);
  }
  // A direct enroll at the API (no screen offers it for one person). Unlike Stage → Active and bulk Enroll it
  // is accepted (201) for a person no channel can reach; D1 is still met at send time: the plan's text is
  // refused by the gate with the opt-out reason and the step is skipped, so nothing is queued or sent.
  const p = people.olly;
  const en = await stack.api<{ enrollment: { id: string } }>(AGENT, 'POST', `/contacts/${p.id}/enrollments`, { playbookId: plans.sms });
  expect(en.status, JSON.stringify(en.body)).toBe(201);
  const enrId = en.body.enrollment.id;
  const runsOf = () => stack.sql<{ status: string; message_id: string | null }>('SELECT status, message_id FROM playbook_step_runs WHERE enrollment_id = $1', [enrId]);
  await drainUntil(stack, async () => (await runsOf()).some((r) => r.status !== 'scheduled'), { kinds: ['playbook.step', 'comms.dispatch'], timeout: 20_000 });
  const runs = await runsOf();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe('skipped_ineligible');
  const [m] = await stack.sql<{ status: string; status_reason: string }>('SELECT status, status_reason FROM messages WHERE id = $1', [runs[0]!.message_id]);
  expect(m).toEqual({ status: 'blocked', status_reason: 'CONSENT_REVOKED' });
  const [e] = await stack.sql<{ state: string }>('SELECT state FROM playbook_enrollments WHERE id = $1', [enrId]);
  if (e!.state === 'active' || e!.state === 'paused') await must(stack.api(AGENT, 'POST', `/enrollments/${enrId}/stop`));
}

async function everyPathBlocked(page: Page, info: Parameters<typeof shot>[1], phase: string) {
  await signIn(page, stack, w.agents[0]!);
  for (const p of optedOut()) for (const ch of p.blocks) await screenRefuses(page, p, ch, info, phase);
  // the selective half: Carl's text goes out, exactly once
  await controlTextSent(page);
  for (const p of optedOut()) for (const ch of p.blocks) await apiRefuses(p, ch);
  await bulkSend(page, 'text', smsOut(), info, phase);
  await bulkSend(page, 'email', emailOut(), info, phase);
  await bulkEnroll(page, 'sms', smsOut(), info, phase);
  await bulkEnroll(page, 'email', emailOut(), info, phase);
  await planRefuses();
  await stack.jobs({ tenantId: w.tenantId });
  await nothingReachedOptedOut();
}

// ---- the journey -------------------------------------------------------------------------------------------

test('M3.0 the FUB account migrates through the API: contacts and ownership committed, the opt-outs in force from the contacts commit', async ({ page }) => {
  test.setTimeout(240_000);
  const surname = isPhone(page) ? 'Phonefub' : 'Deskfub';
  const { key, a } = await stack.fixture<{ key: string; a: Record<string, string> }>('/fub-load', { surname });
  const def = (k: Person['key'], first: string, phone: string | null, email: string | null, blocks: Ch[]) => {
    people[k] = { key: k, first, phone, email, blocks, id: '', name: `${first} ${surname}` };
  };
  def('olly', 'Olly', a.olly!, null, ['sms']);
  def('uma', 'Uma', null, a.uma!, ['email']);
  def('dina', 'Dina', a.dinaP!, a.dinaE!, ['sms', 'email']);
  def('tess', 'Tess', a.tess!, null, ['sms']);
  def('ursula', 'Ursula', null, a.ursula!, ['email']);
  def('carl', 'Carl', a.carlP!, a.carlE!, []);

  await stack.fixture('/reauth', { as: OWNER });
  const cr = await must(stack.api<{ batch: { id: string } }>(OWNER, 'POST', '/imports', { source: 'fub_api', apiKey: key }));
  batchId = cr.batch.id;
  await must(stack.api(OWNER, 'POST', `/imports/${batchId}/snapshot`));
  await expect.poll(async () => {
    await stack.jobs();
    return (await stack.sql('SELECT 1 FROM import_batches WHERE id = $1 AND source_snapshot_sha256 IS NOT NULL', [batchId])).length;
  }, { timeout: 60_000 }).toBe(1);
  await must(stack.api(OWNER, 'PUT', `/imports/${batchId}/user-mappings`, { mappings: [{ sourceRef: '11', target: { kind: 'user', userId: w.agents[0]!.userId } }] }));

  // contacts: every person imported, nothing rejected
  const d = await fullStage('contacts');
  expect(d.counts).toMatchObject({ source: 6, rejected: 0 });
  const rows = await stack.sql<{ id: string; first_name: string; display_name: string }>('SELECT id, first_name, display_name FROM contacts WHERE import_batch_id = $1 AND deleted_at IS NULL', [batchId]);
  expect(rows.map((r) => r.first_name).sort()).toEqual(['Carl', 'Dina', 'Olly', 'Tess', 'Uma', 'Ursula']);
  for (const p of Object.values(people)) {
    const r = rows.find((x) => x.first_name === p.first)!;
    p.id = r.id;
    p.name = r.display_name;
  }
  // the opt-outs are in force from the contacts commit (outbound-2), before ownership and consent; the
  // Owner (who sees everyone) is refused, and the DNC tag stayed a tag
  expect((await stageOf('consent')).status).toBe('pending');
  expect((await stageOf('ownership')).status).toBe('pending');
  for (const p of optedOut()) {
    const r = await stack.api<{ result: string; decision: { outcome: string } | null }>(OWNER, 'POST', `/contacts/${p.id}/messages`, { channel: p.blocks[0], body: 'Hello from the new system', ...(p.blocks[0] === 'email' ? { subject: 'Hello' } : {}), idempotencyKey: `m3-${randomUUID()}` });
    expect([r.status, r.body.result, r.body.decision?.outcome], `${p.first}: ${JSON.stringify(r.body)}`).toEqual([200, 'blocked', 'deny']);
  }
  const dinaTags = await stack.sql<{ name: string }>('SELECT t.name FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id WHERE ct.contact_id = $1', [people.dina.id]);
  expect(dinaTags.map((t) => t.name)).toContain('DNC');
  expect(await stack.sql("SELECT reason, channel FROM suppressions WHERE tenant_id = $1 AND reason = 'import_dnc' AND lifted_at IS NULL", [w.tenantId])).toEqual([{ reason: 'import_dnc', channel: 'all' }, { reason: 'import_dnc', channel: 'all' }]);
  // the contacts stage wrote no grant (grants are the consent stage's)
  expect(await stack.sql("SELECT 1 FROM consent_events WHERE tenant_id = $1 AND event_type = 'grant'", [w.tenantId])).toEqual([]);

  // ownership: everyone is the agent's
  await fullStage('ownership');
  const owners = await stack.sql<{ owner_user_id: string; ownership_state: string }>('SELECT owner_user_id, ownership_state FROM contacts WHERE import_batch_id = $1', [batchId]);
  expect(owners.every((o) => o.owner_user_id === w.agents[0]!.userId && o.ownership_state === 'owned'), JSON.stringify(owners)).toBe(true);
  for (const cat of ['notes', 'messages', 'call_recordings']) await must(stack.api(OWNER, 'POST', `/imports/${batchId}/stages/${cat}/skip`));
  expect((await stageOf('consent')).status).toBe('pending');
});

test('M3.1 consent stage NOT yet committed: every send path to every FUB opt-out is refused on screen, at the API and in the database; Carl is reachable', async ({ page }, info) => {
  test.setTimeout(420_000);
  expect((await stageOf('consent')).status).toBe('pending');
  await everyPathBlocked(page, info, 'a');
});

test('M3.2 after the consent stage commits (with its imported grants): every path is still refused; Carl is still reachable', async ({ page }, info) => {
  test.setTimeout(420_000);
  await fullStage('consent');
  expect((await stack.sql<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId]))[0]!.status).toBe('committed');
  // the consent stage wrote Carl's imported grants and no grant on an opted-out channel
  const grants = await stack.sql<{ contact_id: string; channel: string }>("SELECT contact_id, channel FROM consent_events WHERE tenant_id = $1 AND event_type = 'grant'", [w.tenantId]);
  expect(grants.some((g) => g.contact_id === people.carl.id)).toBe(true);
  for (const p of optedOut()) {
    const states = await stack.sql<{ channel: string; status: string }>(
      'SELECT DISTINCT cs.channel, cs.status FROM consent_state cs JOIN contact_points pt ON pt.tenant_id = cs.tenant_id AND pt.address_hmac = cs.address_hmac WHERE pt.contact_id = $1',
      [p.id],
    );
    for (const ch of p.blocks.filter(() => p.key !== 'dina')) {
      const s = states.filter((x) => x.channel === ch);
      expect(s.length, `${p.first} ${ch}: ${JSON.stringify(states)}`).toBeGreaterThan(0);
      expect(s.every((x) => x.status === 'revoked'), `${p.first} ${ch}: ${JSON.stringify(states)}`).toBe(true);
    }
  }
  await everyPathBlocked(page, info, 'b');
});
