import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentGuard, contentSha256, renderStep, signOffFor, stepForChannel, storedContent, validatePlaybookContent } from '../assistant/index.js';
import { HOUR_MS, MINUTE_MS, instant } from '../foundation/index.js';
import {
  alertItemLine,
  anniversariesDue,
  anniversaryOn,
  avmRequest,
  avmSendable,
  changeFromPriorBps,
  detectFirings,
  digest,
  type FactState,
  type Firing,
  guardSummary,
  homeValueText,
  planBatch,
  planTriggerRun,
  recheckFact,
  SKIP_REASON_TEXT,
} from './index.js';
import { AGENT_PLAYBOOK, BEHAVIOR_ALERTS, IDENTITY, PRICE_DROP_STEP, T0, TEAM_PLAYBOOK, priceDrop, savedBy } from './testing/fixtures.js';

const listingState = (over: Partial<Extract<FactState, { kind: 'listing' }>> = {}): FactState => ({ kind: 'listing', status: 'active', priceCents: 48_000_000, displayAllowed: true, feedFresh: true, ...over });
const okGuard = { hardBlock: false, fairHousing: false, otherIssues: false };
const runBase = (f: Firing) => ({ firing: f, current: listingState(), now: T0, approvalCurrent: true, playbook: { scope: 'agent' as const, ownerUserId: 'u-sarah' }, contactOwnerUserId: 'u-sarah', paused: false, guard: okGuard });

describe('trigger detection (R-NURT-1, R-NURT-2, R-NURT-7)', () => {
  it('R-NURT-1 R-NURT-2: a price decrease on a saved home fires once per contact, keyed per price-history row', () => {
    const f = detectFirings(priceDrop(), [savedBy('c-1', 'l-1'), savedBy('c-2', 'l-1'), savedBy('c-3', 'l-other')]);
    expect(f.map((x) => x.triggerKey)).toEqual(['price_drop:h-1:c-1', 'price_drop:h-1:c-2']);
    expect(f[0]).toMatchObject({ trigger: 'price_drop', playbookId: 'pb-agent', versionId: 'pv-agent-1', stepKey: 'price_drop_email', scheduledFor: T0 });
    expect(f[0]?.evidence).toEqual([{ sourceType: 'listing', sourceId: 'l-1', locator: { kind: 'field', name: 'list_price' }, snippet: '$480,000 (was $500,000)' }]);
    expect(f[0]?.ref).toMatchObject({ kind: 'price_drop', historyId: 'h-1', oldPriceCents: 50_000_000, newPriceCents: 48_000_000 });
  });

  it('R-NURT-2: a price increase or no change fires nothing; facts only (no signal kind exists)', () => {
    expect(detectFirings(priceDrop({ newPriceCents: 51_000_000 }), [savedBy('c-1', 'l-1')])).toEqual([]);
    expect(detectFirings(priceDrop({ newPriceCents: 50_000_000 }), [savedBy('c-1', 'l-1')])).toEqual([]);
    // @ts-expect-error an email open is a signal, not a fact
    expect(detectFirings({ kind: 'email_open', contactId: 'c-1', at: T0 }, [savedBy('c-1', 'l-1')])).toEqual([]);
  });

  it('R-NURT-2: back on market fires from withdrawn, expired or pending to active only', () => {
    const sc = (from: 'withdrawn' | 'expired' | 'pending' | 'sold' | 'active', to: 'active' | 'pending' | 'coming_soon') =>
      detectFirings({ kind: 'status_change', listingId: 'l-1', historyId: 'h-9', source: 'team', from, to, at: T0, address: '12 Elm St', mlsNumber: null, priceCents: 40_000_000, displayAllowed: false, feedFresh: true }, [savedBy('c-1', 'l-1')]);
    for (const from of ['withdrawn', 'expired', 'pending'] as const) expect(sc(from, 'active').map((f) => f.triggerKey)).toEqual(['back_on_market:h-9:c-1']);
    expect(sc('sold', 'active')).toEqual([]);
    expect(sc('active', 'pending')).toEqual([]);
    expect(sc('withdrawn', 'coming_soon')).toEqual([]);
  });

  it('R-NURT-7: an unowned contact gets nothing; an agent playbook fires only for contacts its owner owns', () => {
    expect(detectFirings(priceDrop(), [savedBy('c-1', 'l-1', null)])).toEqual([]);
    expect(detectFirings(priceDrop(), [savedBy('c-1', 'l-1', 'u-other')])).toEqual([]);
    expect(detectFirings(priceDrop(), [savedBy('c-1', 'l-1', 'u-other', TEAM_PLAYBOOK)]).map((f) => f.playbookId)).toEqual(['pb-team']);
  });

  it('R-NURT-1: the contact’s own agent playbook wins over the team’s for the same fact (one firing per key)', () => {
    const f = detectFirings(priceDrop(), [savedBy('c-1', 'l-1', 'u-sarah', TEAM_PLAYBOOK), savedBy('c-1', 'l-1', 'u-sarah', AGENT_PLAYBOOK)]);
    expect(f).toHaveLength(1);
    expect(f[0]?.playbookId).toBe('pb-agent');
  });

  it('R-MLS-3 E85: MLS-sourced firings pause while the feed is stale', () => {
    expect(detectFirings(priceDrop({ feedFresh: false }), [savedBy('c-1', 'l-1')])).toEqual([]);
    expect(detectFirings(priceDrop({ source: 'team', feedFresh: false }), [savedBy('c-1', 'l-1')])).toHaveLength(1);
  });

  it('R-MLS-2 E86: an MLS listing opted out of internet display never fires to a client', () => {
    expect(detectFirings(priceDrop({ displayAllowed: false }), [savedBy('c-1', 'l-1')])).toEqual([]);
  });

  it('R-NURT-2: a step offset schedules the firing after the fact; a deal date step before the date', () => {
    const pb = { ...AGENT_PLAYBOOK, steps: [{ trigger: 'price_drop' as const, stepKey: 's', offsetSeconds: 3600 }] };
    expect(detectFirings(priceDrop(), [savedBy('c-1', 'l-1', 'u-sarah', pb)])[0]?.scheduledFor).toBe(T0 + HOUR_MS);
    const due = instant(T0 + 10 * 24 * HOUR_MS);
    const dd = detectFirings(
      { kind: 'deal_date_upcoming', dealId: 'd-1', dealDateId: 'dd-1', dueVersion: 3, dueAt: due, label: 'Closing on Fri Nov 20', contactIds: ['c-1', 'c-2'], at: T0 },
      [{ contactId: 'c-1', ownerUserId: 'u-sarah', relation: { kind: 'contact' }, playbook: { ...TEAM_PLAYBOOK, steps: [{ trigger: 'deal_date_upcoming', stepKey: 'two_days', offsetSeconds: -2 * 24 * 3600 }] } }],
    );
    expect(dd.map((f) => [f.triggerKey, f.scheduledFor])).toEqual([['deal_date:dd-1:v3:two_days:c-1', due - 2 * 24 * HOUR_MS]]);
  });
});

describe('digest (R-NURT-3)', () => {
  it('E84 R-NURT-3: five saved homes dropping the same day become one message listing five homes', () => {
    const firings = [1, 2, 3, 4, 5].flatMap((n) => detectFirings(priceDrop({ listingId: `l-${n}`, historyId: `h-${n}`, at: instant(T0 + n * MINUTE_MS), address: `${n} Elm St` }), [savedBy('c-1', `l-${n}`)]));
    const batches = digest(firings, 60);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.firings.map((f) => f.ref.kind === 'price_drop' && f.ref.address)).toEqual(['1 Elm St', '2 Elm St', '3 Elm St', '4 Elm St', '5 Elm St']);
    expect(batches[0]?.sendAt).toBe(T0 + MINUTE_MS + 60 * MINUTE_MS);
  });

  it('R-NURT-3: the window is approved content, not a cap: nothing is dropped, later firings open a new batch', () => {
    const a = detectFirings(priceDrop({ listingId: 'l-1', historyId: 'h-1' }), [savedBy('c-1', 'l-1')]);
    const b = detectFirings(priceDrop({ listingId: 'l-2', historyId: 'h-2', at: instant(T0 + 2 * HOUR_MS) }), [savedBy('c-1', 'l-2')]);
    const batches = digest([...b, ...a], 60);
    expect(batches.map((x) => x.firings.length)).toEqual([1, 1]);
    expect(digest([...a, ...b], 0).map((x) => x.sendAt)).toEqual([T0, T0 + 2 * HOUR_MS]);
  });

  it('E83 R-NURT-3: a second change for the same home inside the window replaces the first item', () => {
    const a = detectFirings(priceDrop({ historyId: 'h-1' }), [savedBy('c-1', 'l-1')]);
    const b = detectFirings(priceDrop({ historyId: 'h-2', oldPriceCents: 48_000_000, newPriceCents: 47_000_000, at: instant(T0 + 10 * MINUTE_MS) }), [savedBy('c-1', 'l-1')]);
    const [batch] = digest([...a, ...b], 60);
    expect(batch?.firings.map((f) => f.triggerKey)).toEqual(['price_drop:h-2:c-1']);
  });

  it('R-NURT-3: batches are per contact and playbook, independent of input order (property)', () => {
    const all = [1, 2, 3, 4].flatMap((n) => detectFirings(priceDrop({ listingId: `l-${n}`, historyId: `h-${n}`, at: instant(T0 + n * 7 * MINUTE_MS) }), [savedBy(`c-${n % 2}`, `l-${n}`)]));
    fc.assert(
      fc.property(fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }), fc.integer({ min: 0, max: 120 }), (shuffled, w) => {
        const x = digest(shuffled, w);
        const y = digest(all, w);
        const total = x.reduce((n, b) => n + b.firings.length, 0);
        return JSON.stringify(x) === JSON.stringify(y) && total === all.length && x.every((b) => b.firings.every((f) => f.contactId === b.contactId));
      }),
    );
  });
});

describe('send-time recheck (R-NURT-4) and the run plan (R-NURT-5, R-NURT-7, R-NURT-8)', () => {
  const [f] = detectFirings(priceDrop(), [savedBy('c-1', 'l-1')]) as [Firing];

  it('E82 R-NURT-4: a listing withdrawn while its alert is scheduled is skipped with a visible reason', () => {
    expect(recheckFact(f, listingState({ status: 'withdrawn' }))).toEqual({ ok: false, reason: 'LISTING_INACTIVE' });
    expect(planTriggerRun({ ...runBase(f), current: listingState({ status: 'withdrawn' }) })).toEqual({ action: 'skip', reason: 'LISTING_INACTIVE', text: SKIP_REASON_TEXT.LISTING_INACTIVE, countsAsTouch: false });
  });

  it('E83 R-NURT-4: the price rose again inside the window: still a net drop ⇒ sent with the current price; no net drop ⇒ skipped', () => {
    expect(recheckFact(f, listingState({ priceCents: 49_000_000 }))).toEqual({ ok: true });
    expect(alertItemLine(f, listingState({ priceCents: 49_000_000 }))).toBe('12 Elm St (MLS #7300001): now $490,000, down from $500,000');
    expect(recheckFact(f, listingState({ priceCents: 50_000_000 }))).toEqual({ ok: false, reason: 'PRICE_NOT_LOWER' });
    expect(recheckFact(f, listingState({ priceCents: null }))).toEqual({ ok: false, reason: 'PRICE_NOT_LOWER' });
  });

  it('R-NURT-4 R-MLS-3 R-MLS-2: a stale feed or a display opt-out at send time skips an MLS alert', () => {
    expect(recheckFact(f, listingState({ feedFresh: false }))).toEqual({ ok: false, reason: 'MLS_STALE' });
    expect(recheckFact(f, listingState({ displayAllowed: false }))).toEqual({ ok: false, reason: 'NOT_DISPLAYABLE' });
    expect(recheckFact(f, { kind: 'gone' })).toEqual({ ok: false, reason: 'FACT_GONE' });
    expect(recheckFact(f, { kind: 'home_value', addressCurrent: true })).toEqual({ ok: false, reason: 'FACT_MISMATCH' });
  });

  it('R-NURT-4: a deal date that moved (due_version bump, E96) or was unconfirmed or passed makes the firing stale', () => {
    const due = instant(T0 + 48 * HOUR_MS);
    const [d] = detectFirings(
      { kind: 'deal_date_upcoming', dealId: 'd-1', dealDateId: 'dd-1', dueVersion: 2, dueAt: due, label: 'Inspection deadline', contactIds: ['c-1'], at: T0 },
      [{ contactId: 'c-1', ownerUserId: 'u-sarah', relation: { kind: 'contact' }, playbook: { ...TEAM_PLAYBOOK, steps: [{ trigger: 'deal_date_upcoming', stepKey: 's', offsetSeconds: -86400 }] } }],
    ) as [Firing];
    expect(recheckFact(d, { kind: 'deal_date', dueVersion: 2, confirmed: true, dueAt: due }, T0)).toEqual({ ok: true });
    expect(recheckFact(d, { kind: 'deal_date', dueVersion: 3, confirmed: true, dueAt: due }, T0)).toEqual({ ok: false, reason: 'DATE_CHANGED' });
    expect(recheckFact(d, { kind: 'deal_date', dueVersion: 2, confirmed: true, dueAt: instant(due + 1) }, T0)).toEqual({ ok: false, reason: 'DATE_CHANGED' });
    expect(recheckFact(d, { kind: 'deal_date', dueVersion: 2, confirmed: false, dueAt: due }, T0)).toEqual({ ok: false, reason: 'DATE_UNCONFIRMED' });
    expect(recheckFact(d, { kind: 'deal_date', dueVersion: 2, confirmed: true, dueAt: due }, due)).toEqual({ ok: false, reason: 'DATE_PASSED' });
    expect(recheckFact(d, listingState())).toEqual({ ok: false, reason: 'FACT_MISMATCH' });
  });

  it('R-NURT-5: a paused conversation turns the firing into a draft, never a send', () => {
    expect(planTriggerRun({ ...runBase(f), paused: true })).toEqual({ action: 'draft', reasons: ['PAUSED'], checkThis: false, countsAsTouch: false });
  });

  it('R-NURT-7: the owner is re-checked at send time; an agent playbook stops when the contact moves', () => {
    expect(planTriggerRun({ ...runBase(f), contactOwnerUserId: null })).toMatchObject({ action: 'skip', reason: 'NOT_OWNED' });
    expect(planTriggerRun({ ...runBase(f), contactOwnerUserId: 'u-other' })).toMatchObject({ action: 'skip', reason: 'OWNER_CHANGED' });
    expect(planTriggerRun({ ...runBase(f), contactOwnerUserId: 'u-other', playbook: { scope: 'team', ownerUserId: null } })).toMatchObject({ action: 'send' });
  });

  it('R-NURT-1: a revoked or superseded approval skips the run', () => {
    expect(planTriggerRun({ ...runBase(f), approvalCurrent: false })).toMatchObject({ action: 'skip', reason: 'APPROVAL_NOT_CURRENT' });
  });

  it('R-NURT-8: no run plan counts as a touch or carries an ownership change', () => {
    const plans = [planTriggerRun(runBase(f)), planTriggerRun({ ...runBase(f), paused: true }), planTriggerRun({ ...runBase(f), approvalCurrent: false })];
    for (const p of plans) {
      expect(p.countsAsTouch).toBe(false);
      expect(Object.keys(p).some((k) => /owner|touch_?event|claim|release/i.test(k))).toBe(false);
    }
  });

  it('R-FH-2: a fair-housing match in the rendered alert downgrades it to a draft flagged "Check this"', () => {
    const g = contentGuard('Hi Jane, 12 Elm St is perfect for young families. — Sarah’s assistant', { channel: 'email', purpose: 'marketing', maxLength: 2000 }, IDENTITY);
    expect(g.issues.some((i) => i.code === 'FAIR_HOUSING')).toBe(true);
    expect(g.checkThis).toBe(true);
    expect(planTriggerRun({ ...runBase(f), guard: guardSummary(g) })).toMatchObject({ action: 'draft', checkThis: true, reasons: expect.arrayContaining(['FAIR_HOUSING']) });
  });

  it('R-GATE-7: payment instructions are never sendable, even as a draft', () => {
    expect(planTriggerRun({ ...runBase(f), guard: { ...okGuard, hardBlock: true } })).toMatchObject({ action: 'skip', reason: 'PAYMENT_INSTRUCTIONS' });
  });

  it('R-NURT-3 R-NURT-4: a batch keeps the items that still hold, and is skipped visibly when none does', () => {
    const [g] = detectFirings(priceDrop({ listingId: 'l-2', historyId: 'h-2' }), [savedBy('c-1', 'l-2')]) as [Firing];
    const ok = planBatch([
      { firing: f, plan: planTriggerRun(runBase(f)) },
      { firing: g, plan: planTriggerRun({ ...runBase(g), current: listingState({ status: 'sold' }) }) },
    ]);
    expect(ok).toMatchObject({ action: 'send', keep: [f], skipped: [{ firing: g, reason: 'LISTING_INACTIVE' }] });
    const none = planBatch([{ firing: g, plan: planTriggerRun({ ...runBase(g), current: listingState({ status: 'sold' }) }) }]);
    expect(none).toMatchObject({ action: 'skip', reason: 'NOTHING_LEFT', text: 'Every item in this alert was skipped.' });
    const draft = planBatch([{ firing: f, plan: planTriggerRun({ ...runBase(f), paused: true }) }]);
    expect(draft).toMatchObject({ action: 'draft', reasons: ['PAUSED'] });
  });
});

describe('anniversaries (R-NURT-2, E101)', () => {
  it('E101 R-NURT-2: a Feb 29 closing fires Feb 28 in common years and Feb 29 in leap years', () => {
    expect(anniversaryOn('2024-02-29', 2025)).toBe('2025-02-28');
    expect(anniversaryOn('2024-02-29', 2028)).toBe('2028-02-29');
    expect(anniversaryOn('2024-02-29', 2100)).toBe('2100-02-28');
    expect(anniversaryOn('2024-02-29', 2000)).toBe('2000-02-29');
    expect(anniversaryOn('2023-07-04', 2026)).toBe('2026-07-04');
    expect(() => anniversaryOn('July 4', 2026)).toThrow();
  });

  it('R-NURT-2: one anniversary per contact per year, keyed anniversary:{deal}:{yyyy}:{contact}; never in the closing year', () => {
    const deals = [
      { dealId: 'd-1', status: 'closed' as const, closedOn: '2024-02-29', contactIds: ['c-2', 'c-1', 'c-1'], address: '3 Oak St' },
      { dealId: 'd-2', status: 'open' as const, closedOn: '2024-02-28', contactIds: ['c-3'], address: 'x' },
      { dealId: 'd-3', status: 'closed' as const, closedOn: '2026-02-28', contactIds: ['c-4'], address: 'x' },
      { dealId: 'd-4', status: 'closed' as const, closedOn: null, contactIds: ['c-5'], address: 'x' },
    ];
    const facts = anniversariesDue(deals, '2026-02-28', T0);
    expect(facts.map((x) => [x.dealId, x.contactId, x.year])).toEqual([['d-1', 'c-1', 2026], ['d-1', 'c-2', 2026]]);
    const firings = facts.flatMap((fact) => detectFirings(fact, [{ contactId: fact.contactId, ownerUserId: 'u-sarah', relation: { kind: 'contact' }, playbook: { ...TEAM_PLAYBOOK, steps: [{ trigger: 'home_anniversary', stepKey: 'anniv', offsetSeconds: 0 }] } }]));
    expect(firings.map((x) => x.triggerKey)).toEqual(['anniversary:d-1:2026:c-1', 'anniversary:d-1:2026:c-2']);
    expect(anniversariesDue(deals, '2026-03-01', T0)).toEqual([]);
    expect(() => anniversariesDue(deals, 'today', T0)).toThrow();
  });

  it('R-NURT-4: an anniversary rechecks the deal and the party at send time', () => {
    const [fact] = anniversariesDue([{ dealId: 'd-1', status: 'closed', closedOn: '2020-05-01', contactIds: ['c-1'], address: '3 Oak St' }], '2026-05-01', T0);
    const [fi] = detectFirings(fact as never, [{ contactId: 'c-1', ownerUserId: 'u', relation: { kind: 'contact' }, playbook: { ...TEAM_PLAYBOOK, steps: [{ trigger: 'home_anniversary', stepKey: 'a', offsetSeconds: 0 }] } }]) as [Firing];
    expect(recheckFact(fi, { kind: 'deal', status: 'closed', contactIsParty: true })).toEqual({ ok: true });
    expect(recheckFact(fi, { kind: 'deal', status: 'canceled', contactIsParty: true })).toEqual({ ok: false, reason: 'DEAL_NOT_CLOSED' });
    expect(recheckFact(fi, { kind: 'deal', status: 'closed', contactIsParty: false })).toEqual({ ok: false, reason: 'NOT_A_PARTY' });
    expect(recheckFact(fi, listingState())).toEqual({ ok: false, reason: 'FACT_MISMATCH' });
    expect(alertItemLine(fi, { kind: 'deal', status: 'closed', contactIsParty: true })).toBe('3 Oak St: 6 years since closing');
  });
});

describe('home values (R-AVM-1, R-AVM-2, R-AVM-3)', () => {
  const s = { maxRangeBps: 2500, maxJumpBps: 1000, maxAgeDays: 45, today: '2026-11-10' };
  const est = (over: Partial<Parameters<typeof avmSendable>[0]> = {}) => ({ status: 'ok' as const, valueCents: 50_000_000, lowCents: 47_000_000, highCents: 53_000_000, asOf: '2026-11-01', displayAllowed: true, provider: 'FakeAVM', ...over });

  it('R-AVM-2: fresh, displayable, in range and within the jump limit ⇒ sendable once platform:avm is cleared', () => {
    expect(avmSendable(est(), est({ valueCents: 49_000_000 }), s, true)).toEqual({ ok: true });
    expect(avmSendable(est(), est(), s, false)).toEqual({ ok: false, reason: 'NOT_CLEARED' });
  });

  it('E98 R-AVM-2: a value 30 % below last month ⇒ a draft for the agent', () => {
    const d = avmSendable(est({ valueCents: 35_000_000, lowCents: 33_000_000, highCents: 37_000_000 }), est(), s, true);
    expect(d).toEqual({ ok: false, reason: 'JUMP_TOO_LARGE' });
    expect(changeFromPriorBps(est({ valueCents: 35_000_000 }), est())).toBe(-3000);
    const [fi] = detectFirings({ kind: 'home_value', contactId: 'c-1', contactAddressId: 'a-1', month: '2026-11', valuationId: 'v-1', at: T0, address: '3 Oak St' }, [
      { contactId: 'c-1', ownerUserId: 'u-sarah', relation: { kind: 'contact' }, playbook: { ...TEAM_PLAYBOOK, steps: [{ trigger: 'home_value', stepKey: 'hv', offsetSeconds: 0 }] } },
    ]) as [Firing];
    expect(fi.triggerKey).toBe('avm:a-1:2026-11');
    expect(planTriggerRun({ ...runBase(fi), current: { kind: 'home_value', addressCurrent: true }, playbook: { scope: 'team', ownerUserId: null }, avm: d })).toMatchObject({ action: 'draft', reasons: ['AVM_JUMP_TOO_LARGE'] });
  });

  it('E99 R-AVM-2: no value (a condo the vendor cannot price) ⇒ skipped "No estimate available", never "unchanged"', () => {
    const d = avmSendable(est({ status: 'unavailable', valueCents: null, lowCents: null, highCents: null }), est(), s, true);
    expect(d).toEqual({ ok: false, reason: 'UNAVAILABLE' });
    expect(homeValueText(est({ status: 'unavailable', valueCents: null }))).toBeNull();
    const [fi] = detectFirings({ kind: 'home_value', contactId: 'c-1', contactAddressId: 'a-1', month: '2026-11', valuationId: 'v-1', at: T0, address: '3 Oak St' }, [
      { contactId: 'c-1', ownerUserId: 'u', relation: { kind: 'contact' }, playbook: { ...TEAM_PLAYBOOK, steps: [{ trigger: 'home_value', stepKey: 'hv', offsetSeconds: 0 }] } },
    ]) as [Firing];
    const plan = planTriggerRun({ ...runBase(fi), current: { kind: 'home_value', addressCurrent: true }, playbook: { scope: 'team', ownerUserId: null }, avm: d });
    expect(plan).toEqual({ action: 'skip', reason: 'NO_ESTIMATE', text: 'No estimate available.', countsAsTouch: false });
    expect(planTriggerRun({ ...runBase(fi), current: { kind: 'home_value', addressCurrent: true }, playbook: { scope: 'team', ownerUserId: null } })).toMatchObject({ reason: 'NO_ESTIMATE' });
    expect(JSON.stringify(plan)).not.toMatch(/unchanged/i);
    expect(planTriggerRun({ ...runBase(fi), current: { kind: 'home_value', addressCurrent: false }, playbook: { scope: 'team', ownerUserId: null }, avm: { ok: true } })).toMatchObject({ reason: 'ADDRESS_NOT_CURRENT' });
  });

  it('R-AVM-2: not displayable, stale, too wide a range', () => {
    expect(avmSendable(est({ displayAllowed: false }), null, s, true)).toEqual({ ok: false, reason: 'NOT_DISPLAYABLE' });
    expect(avmSendable(est({ asOf: '2026-09-01' }), null, s, true)).toEqual({ ok: false, reason: 'STALE' });
    expect(avmSendable(est({ asOf: null }), null, s, true)).toEqual({ ok: false, reason: 'STALE' });
    expect(avmSendable(est({ lowCents: 40_000_000, highCents: 60_000_000 }), null, s, true)).toEqual({ ok: false, reason: 'RANGE_TOO_WIDE' });
    expect(avmSendable(est({ lowCents: null }), null, s, true)).toEqual({ ok: false, reason: 'RANGE_TOO_WIDE' });
    expect(avmSendable(est(), est({ status: 'unavailable', valueCents: null }), s, true)).toEqual({ ok: true });
    const base = { ...runBase(detectFirings({ kind: 'home_value', contactId: 'c', contactAddressId: 'a', month: '2026-11', valuationId: 'v', at: T0, address: 'x' }, [{ contactId: 'c', ownerUserId: 'u', relation: { kind: 'contact' }, playbook: { ...TEAM_PLAYBOOK, steps: [{ trigger: 'home_value', stepKey: 'hv', offsetSeconds: 0 }] } }])[0] as Firing), current: { kind: 'home_value' as const, addressCurrent: true }, playbook: { scope: 'team' as const, ownerUserId: null } };
    expect(planTriggerRun({ ...base, avm: { ok: false, reason: 'NOT_DISPLAYABLE' } })).toMatchObject({ action: 'skip', reason: 'ESTIMATE_NOT_DISPLAYABLE' });
    expect(planTriggerRun({ ...base, avm: { ok: false, reason: 'STALE' } })).toMatchObject({ action: 'skip', reason: 'ESTIMATE_STALE' });
    expect(planTriggerRun({ ...base, avm: { ok: false, reason: 'NOT_CLEARED' } })).toMatchObject({ action: 'draft', reasons: ['AVM_NOT_CLEARED'] });
    expect(planTriggerRun({ ...base, avm: { ok: false, reason: 'RANGE_TOO_WIDE' } })).toMatchObject({ action: 'draft', reasons: ['AVM_RANGE_TOO_WIDE'] });
    expect(planTriggerRun({ ...base, avm: { ok: true } })).toMatchObject({ action: 'send' });
  });

  it('R-AVM-1: every display shows the provider, the range, the as-of date and "an estimate, not an appraisal"', () => {
    expect(homeValueText(est())).toBe('Estimated value: $500,000 (range $470,000–$530,000), from FakeAVM as of Nov 1, 2026. This is an estimate, not an appraisal.');
    expect(homeValueText(est({ lowCents: null }))).toBe('Estimated value: $500,000, from FakeAVM as of Nov 1, 2026. This is an estimate, not an appraisal.');
  });

  it('R-AVM-3: a valuation is requested only for a reachable contact at a current address, once per address and month', () => {
    const base = { contactAddressId: 'a-1', month: '2026-11', addressCurrent: true, previewAllows: true, alreadyRequestedThisMonth: false };
    expect(avmRequest(base)).toEqual({ request: true, triggerKey: 'avm:a-1:2026-11' });
    expect(avmRequest({ ...base, addressCurrent: false })).toEqual({ request: false, reason: 'ADDRESS_NOT_CURRENT' });
    expect(avmRequest({ ...base, previewAllows: false })).toEqual({ request: false, reason: 'CANNOT_RECEIVE' });
    expect(avmRequest({ ...base, alreadyRequestedThisMonth: true })).toEqual({ request: false, reason: 'ALREADY_REQUESTED' });
  });
});

describe('PlaybookContent (R-AST-20, R-INBOX-4, R-MKT-11)', () => {
  it('R-AST-20: PLAYBOOK_INVALID never fires for valid trigger or voice content', () => {
    expect(validatePlaybookContent(BEHAVIOR_ALERTS, { kind: 'trigger', identity: IDENTITY })).toEqual([]);
    const voice = { kind: 'voice', voice: { disclosure: 'Hi, this is the Smith Team’s automated assistant. This call is recorded.', recordingAnnouncement: 'This call is recorded.', tools: ['take_message', 'book_appointment'], maxCallSeconds: 300, transferHoldSeconds: 20 } };
    expect(validatePlaybookContent(voice, { kind: 'voice_answering', identity: IDENTITY })).toEqual([]);
    expect(validatePlaybookContent([], { kind: 'nurture' })).toEqual([{ index: -1, code: 'NO_STEPS' }]);
  });

  it('R-AST-20: trigger steps use only existing autonomous categories and their trigger’s intents', () => {
    const bad = { ...BEHAVIOR_ALERTS, triggers: [{ ...PRICE_DROP_STEP, category: 'money' }] };
    expect(validatePlaybookContent(bad, { kind: 'trigger' }).map((i) => i.code)).toContain('SCHEMA');
    const wrongIntent = { ...BEHAVIOR_ALERTS, triggers: [{ ...PRICE_DROP_STEP, intent: 'home_anniversary' }] };
    expect(validatePlaybookContent(wrongIntent, { kind: 'trigger' }).map((i) => i.code)).toContain('TRIGGER_INTENT_MISMATCH');
    const dup = { ...BEHAVIOR_ALERTS, triggers: [PRICE_DROP_STEP, { ...PRICE_DROP_STEP, stepKey: 'x2' }] };
    expect(validatePlaybookContent(dup, { kind: 'trigger' }).map((i) => i.code)).toContain('DUPLICATE_TRIGGER');
    const informational = { ...BEHAVIOR_ALERTS, triggers: [{ ...PRICE_DROP_STEP, purpose: 'informational' }] };
    expect(validatePlaybookContent(informational, { kind: 'trigger' }).map((i) => i.code)).toContain('MARKETING_INTENT_DECLARED_INFORMATIONAL');
    expect(validatePlaybookContent(BEHAVIOR_ALERTS, { kind: 'nurture' })).toEqual([{ index: -1, code: 'CONTENT_KIND_MISMATCH', detail: 'nurture/triggers' }]);
    expect(validatePlaybookContent({ kind: 'triggers', triggers: [], digestWindowMinutes: 60 }, { kind: 'trigger' })).toEqual([{ index: -1, code: 'SCHEMA', detail: 'content' }]);
    expect(validatePlaybookContent({ kind: 'triggers', triggers: [PRICE_DROP_STEP], digestWindowMinutes: 5000 }, { kind: 'trigger' })[0]?.code).toBe('SCHEMA');
  });

  it('R-NURT-3: the digest window is part of the hashed, approved content', () => {
    expect(contentSha256(BEHAVIOR_ALERTS, {})).not.toBe(contentSha256({ ...BEHAVIOR_ALERTS, digestWindowMinutes: 120 }, {}));
    expect(storedContent(BEHAVIOR_ALERTS)).toMatchObject({ kind: 'triggers', digestWindowMinutes: 60 });
    expect(storedContent([PRICE_DROP_STEP])).toMatchObject({ kind: 'steps' });
    expect(storedContent({ kind: 'rate_move' })).toBeNull();
  });

  it('R-FH-2: a trigger template with fair-housing wording cannot be approved', () => {
    const fh = { ...BEHAVIOR_ALERTS, triggers: [{ ...PRICE_DROP_STEP, template: 'Hi {{first_name}}, perfect for young families: {{listing_address}}' }] };
    expect(validatePlaybookContent(fh, { kind: 'trigger' })).toContainEqual(expect.objectContaining({ code: 'TEMPLATE_FAIR_HOUSING', detail: 'fh.familial.ideal_occupant' }));
  });

  it('R-INBOX-4: the inbound_channel step channel is allowed only in the 60-second first response', () => {
    const step = { stepKey: 'reply', channel: 'inbound_channel', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'speed_to_lead_reply', intent: 'first_response_qualify', template: 'Thanks for reaching out! Are you looking to buy or sell?', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };
    expect(validatePlaybookContent([step], { kind: 'new_lead_response' })).toEqual([]);
    expect(validatePlaybookContent([{ ...step, category: 'nurture_step', intent: 'check_in', purpose: 'marketing' }], { kind: 'nurture' }).map((i) => i.code)).toContain('INBOUND_CHANNEL_NOT_ALLOWED');
    expect(validatePlaybookContent([{ ...step, subject: 'x' }], { kind: 'new_lead_response' }).map((i) => i.code)).toContain('SMS_SUBJECT_NOT_ALLOWED');
    expect(stepForChannel(step as never, 'web_chat')).toBe(step);
    // owner decision D2: Messenger and Instagram DMs are not channels at all
    // @ts-expect-error messenger is not an inbound channel
    expect(stepForChannel(step as never, 'messenger')).toBeNull();
    expect(stepForChannel(step as never, 'sms')).toBeNull();
  });

  it('R-MKT-11: a review request carries no sentiment condition and no incentive, and needs the cleared pack', () => {
    const step = { stepKey: 'review', channel: 'email', delay: { anchor: 'enrollment', offsetSeconds: 86400 * 14 }, purpose: 'marketing', category: 'nurture_step', intent: 'review_request', template: 'Hi {{first_name}}, would you share how it went? {{listing_url}}', subject: 'How did we do?', personalization: 'none', slots: ['first_name', 'listing_url'], maxLength: 2000, stopIf: [] };
    expect(validatePlaybookContent([step], { kind: 'post_closing' })).toEqual([]);
    for (const t of ['We will send a $25 gift card for a review!', 'Enter to win a prize: leave us a review', 'Leave a 5-star review if you were happy', 'Only happy clients only please'.replace('Only ', '')])
      expect(validatePlaybookContent([{ ...step, template: t }], { kind: 'post_closing' }).map((i) => i.code)).toContain('REVIEW_REQUEST_INCENTIVE');
    expect(validatePlaybookContent([{ ...step, onlyIfSentiment: 'positive' }], { kind: 'post_closing' }).map((i) => i.code)).toContain('SCHEMA');
  });

  it('acceptance: an approved "Behavior alerts" content + a fake MLS price drop produce one digested, gated message with evidence', () => {
    expect(validatePlaybookContent(BEHAVIOR_ALERTS, { kind: 'trigger', identity: IDENTITY })).toEqual([]);
    const firings = detectFirings(priceDrop(), [savedBy('c-1', 'l-1')]);
    const [batch] = digest(firings, BEHAVIOR_ALERTS.kind === 'triggers' ? BEHAVIOR_ALERTS.digestWindowMinutes : 0);
    expect(batch?.firings).toHaveLength(1);
    const step = { ...PRICE_DROP_STEP, delay: { anchor: 'event' as const, offsetSeconds: 0 }, personalization: 'none' as const, stopIf: [] };
    const rendered = renderStep(step, { first_name: 'Jane', listing_address: '12 Elm St', listing_price: '$480,000' }, { signOff: signOffFor(IDENTITY), brokerageName: IDENTITY.brokerageLegalName, firstInThread: false, postalAddress: IDENTITY.brokeragePostalAddress, unsubscribeUrl: null });
    expect(rendered.ok).toBe(true);
    const g = contentGuard(rendered.ok ? rendered.text : '', step, IDENTITY);
    const plan = planTriggerRun({ ...runBase(batch?.firings[0] as Firing), guard: guardSummary(g) });
    expect(g.issues).toEqual([]);
    expect(plan).toEqual({ action: 'send', countsAsTouch: false });
    expect(batch?.firings[0]?.evidence[0]?.snippet).toBe('$480,000 (was $500,000)');
  });
});
