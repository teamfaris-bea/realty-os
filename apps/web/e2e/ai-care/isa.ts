// Shared fixtures of the AI care specs (module 76), on journeys/stack.ts: the real API on a fresh Postgres database,
// the RLS-bound app_user, fake providers only (FakeIsaAi, fake telephony and email). Nothing real is sent.
// Harness rules (V14):
//   - ISA jobs drain only through '/isa-run' (runIsa: the ISA handlers bound to this harness, isa/testing.ts:92-107),
//     never through the stack's /jobs while ISA jobs are pending (its registry leaves isaHandlers on commsRuntime());
//   - the deadline sweep runs from '/isa-sla' (slaSweepInTx as the system; runIsa skips ai_isa.sla).
// The superuser pool only clears the counsel pack, moves stored instants and reads back, as isa/testing.ts does.
import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect } from 'playwright/test';
import { isPhone, signIn } from '../journeys/helpers.js';
import { type JourneyStack, startJourneyStack } from '../journeys/stack.js';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const IMPORTS = String.raw`
import { isaWorld, isaLead, runIsa, closedZone, openZone } from './src/isa/testing.ts';
import { slaSweepInTx } from './src/isa/handoff.ts';
import { withTenantTx } from '@realty/db';
import { systemActor } from './src/worker/systemActor.ts';
`;

const ROUTES = String.raw`
  /** { optIn=true, clear=true } an AI ISA tenant on fakes (isa/testing.ts isaWorld); clients i.owner, i.agent0, i.agent1, i.lead */
  async '/isa-world'(b) {
    const w = await isaWorld(h, { optIn: b.optIn ?? true, clear: b.clear ?? true });
    worlds.set('i', w);
    clients.set('i.owner', w.owner);
    w.agents.forEach((a, i) => clients.set('i.agent' + i, a));
    if (w.teamLead) clients.set('i.lead', w.teamLead);
    if (b.switchOff) must(await call(w.owner, 'PUT', '/admin/ai-isa', { enabled: false, dailyCap: 100 }), 'switch off');
    return { tenantId: w.tenantId, versionId: w.versionId, owner: who(w.owner), agents: w.agents.map(who), lead: w.teamLead ? who(w.teamLead) : null, mainNumber: w.mainNumber };
  },
  /** { as='i.agent0', zone?, closed?, firstTouchPending? } an owned lead with an explicit zone */
  async '/isa-lead'(b) {
    const zone = b.closed ? closedZone() : (b.zone ?? openZone());
    const l = await isaLead(h, client(b.as ?? 'i.agent0'), { zone });
    if (b.firstTouchPending) await h.su.query("SET session_replication_role = replica; UPDATE contacts SET first_touch_at = NULL, release_due_at = now() + interval '1 hour' WHERE id = '" + l.id + "'; SET session_replication_role = origin");
    const n = await h.su.query('SELECT display_name FROM contacts WHERE id = $1', [l.id]);
    return { id: l.id, phone: l.phone, email: l.email, name: n.rows[0].display_name, zone };
  },
  /** { rounds=4 } drains the AI ISA jobs on the bound handlers */
  async '/isa-run'(b) { await runIsa(h, world('i').tenantId, b.rounds ?? 4); return { ok: true }; },
  /** the deadline sweep, as the system */
  async '/isa-sla'() {
    const sa = systemActor(world('i').tenantId, 'timer');
    const r = await withTenantTx(sa, (tx, now) => slaSweepInTx(tx, h.app.platform.ids, now), { db: h.database });
    return r;
  },
  /** clears the counsel pack (the counsel-review command's effect) */
  async '/isa-clear'() { await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ai_isa'"); return { ok: true }; },
  /** { contactId } the Undo window of a take over or end has passed (a stored instant moved; no fake clock) */
  async '/isa-window-past'(b) { await h.su.query("UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1 AND finalize_at IS NOT NULL", [b.contactId]); return { ok: true }; },
  /** { from, body } an inbound text to the ISA world's number */
  async '/isa-sms-in'(b) { const r = await inboundSms(h, b.from, world('i').mainNumber, b.body); return { status: r.statusCode }; },
  /** { as } a fresh re-auth for API setup steps */
  async '/isa-reauth'(b) { await freshReauth(h, client(b.as)); return { ok: true }; },
`;

export async function startIsaStack(): Promise<JourneyStack> {
  return startJourneyStack({ imports: IMPORTS, routes: ROUTES });
}

export interface IsaWorldInfo {
  tenantId: string;
  versionId: string;
  owner: { email: string; password: string; userId: string };
  agents: { email: string; password: string; userId: string }[];
  lead: { email: string; password: string; userId: string } | null;
  mainNumber: string;
}
export interface IsaLeadInfo {
  id: string;
  phone: string;
  email: string;
  name: string;
  zone: string;
}

export const isaWorldOf = (s: JourneyStack, o: { optIn?: boolean; clear?: boolean; switchOff?: boolean } = {}) => s.fixture<IsaWorldInfo>('/isa-world', o);
export const isaLeadOf = (s: JourneyStack, o: { as?: string; closed?: boolean; firstTouchPending?: boolean } = {}) => s.fixture<IsaLeadInfo>('/isa-lead', o);
export const runIsa = (s: JourneyStack, rounds = 4) => s.fixture('/isa-run', { rounds });

/** Every axe violation on the page (WCAG 2.2 AA tags). */
export async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Opens a page from the nav as a person would: the sidebar (1 click) or More then the entry (2 taps). */
export async function openFromNav(page: Page, label: string, counter: { taps: number }) {
  if (isPhone(page)) {
    await page.getByRole('link', { name: 'More' }).first().tap();
    counter.taps += 1;
    await page.getByRole('link', { name: label, exact: true }).first().tap();
  } else {
    await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).first().click();
  }
  counter.taps += 1;
}

export async function press(page: Page, l: Locator, counter?: { taps: number }) {
  if (isPhone(page)) await l.tap();
  else await l.click();
  if (counter) counter.taps += 1;
}

/** The strip on the person page (the phone bar duplicates its buttons: the strip's own are first). */
export const strip = (page: Page) => page.getByTestId('ai-strip');

export async function expectNoCode(page: Page) {
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/\b(?:AI_ISA|ISA)_[A-Z_]+\b/);
  expect(text).not.toMatch(/confidence|\bscore\b/i);
}

/** Signs in as someone else in the same page: the previous session cookie goes first. */
export async function signInAs(page: Page, stack: JourneyStack, who: { email: string; password: string }) {
  await page.context().clearCookies();
  await signIn(page, stack, who);
}

/**
 * Answers the shell's password prompt (R-PERM-13) when it opens: the password and, for MFA, the TOTP code. A sign-in
 * within the last 15 minutes is itself a fresh re-auth, so the prompt may not open: `until` is what shows either way.
 */
export async function confirmPassword(page: Page, stack: JourneyStack, who: { email: string; password: string }, until: Locator) {
  const pw = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(pw.or(until).first()).toBeVisible({ timeout: 15_000 });
  if (!(await pw.isVisible())) return;
  await pw.getByLabel('Password').fill(who.password);
  const code = pw.getByLabel('Authenticator code');
  if (await code.isVisible().catch(() => false)) {
    const c = (await stack.fixture<{ code: string | null }>('/totp', { email: who.email })).code;
    if (c) await code.fill(c);
  }
  await pw.getByRole('button', { name: 'Confirm' }).click();
  await expect(pw).toBeHidden();
}
