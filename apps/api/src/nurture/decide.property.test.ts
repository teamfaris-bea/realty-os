// Property and mutation-style tests of api/nurture's decision functions (critical module 26: autonomy).
// R-NURT-1, R-NURT-3, R-NURT-5, R-NURT-7, R-NURT-8, R-FH-2; E83, E84. Pure: no database.
import type { DowngradeReason } from '@realty/core/assistant';
import { type Instant, instant } from '@realty/core/foundation';
import { type DraftReason, type Firing, detectFirings, planBatch, planTriggerRun } from '@realty/core/nurture';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { apiSkip, decideBatch, digestTemplate, firingOfRow, literal, storedRefOf } from './decide.js';
import { digestKeepAll } from './detect.js';

const DOWNGRADE_REASONS_FOR_TEST: DowngradeReason[] = ['ALWAYS_HUMAN_CATEGORY', 'CATEGORY_NOT_AUTONOMOUS', 'CATEGORY_DISABLED', 'STEP_CATEGORY_MISMATCH', 'NO_PLAYBOOK_VERSION', 'VERSION_NOT_APPROVED', 'NO_APPROVAL', 'APPROVAL_REVOKED', 'APPROVAL_HASH_MISMATCH', 'PAYMENT_INSTRUCTIONS', 'CONTENT_GUARD', 'INTENT_MISMATCH'];
const DRAFT_REASONS: DraftReason[] = ['PAUSED', 'CONTENT_GUARD', 'FAIR_HOUSING', 'AVM_NOT_CLEARED', 'AVM_RANGE_TOO_WIDE', 'AVM_JUMP_TOO_LARGE'];

const verdictArb = fc.oneof(fc.constant({ allow: true as const }), fc.constantFrom(...DOWNGRADE_REASONS_FOR_TEST).map((d) => ({ allow: false as const, downgrade: d as DowngradeReason })));
const inputArb = fc.record({
  paused: fc.boolean(),
  itemsDraft: fc.record({ draft: fc.boolean(), reasons: fc.subarray(DRAFT_REASONS), checkThis: fc.boolean() }),
  verdict: verdictArb,
  guard: fc.record({ hardBlock: fc.boolean(), fairHousing: fc.boolean() }),
  ownerUserId: fc.constantFrom<string | null>('u1', null),
});

describe('decideBatch (property): a send needs every condition; anything else is a draft, never a silent drop', () => {
  it('R-NURT-5 R-FH-2: send ⇔ not paused, no item draft, an allowed verdict, no fair-housing match, an owner, no wiring details', () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const d = decideBatch(i);
        const all = !i.paused && !i.itemsDraft.draft && i.itemsDraft.reasons.length === 0 && i.verdict.allow && !i.guard.fairHousing && i.ownerUserId !== null && !i.guard.hardBlock;
        expect(d.action === 'send').toBe(all);
        expect(d.countsAsTouch).toBe(false); // R-NURT-8
      }),
      { numRuns: 2000 },
    );
  });

  it('R-GATE-7: wiring details are never sendable, not even as a draft; an unowned contact gets nothing', () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const d = decideBatch(i);
        if (i.guard.hardBlock || (!i.verdict.allow && i.verdict.downgrade === 'PAYMENT_INSTRUCTIONS')) expect(d).toEqual({ action: 'skip', reason: 'PAYMENT_INSTRUCTIONS', countsAsTouch: false });
        else if (i.ownerUserId === null) expect(d).toEqual({ action: 'skip', reason: 'NOT_OWNED', countsAsTouch: false });
        else expect(d.action).not.toBe('skip');
      }),
      { numRuns: 2000 },
    );
  });

  it('R-NURT-5 R-FH-2: a paused conversation always says PAUSED; a fair-housing match always says Check this', () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const d = decideBatch(i);
        if (d.action !== 'draft') return;
        if (i.paused) expect(d.reasons[0]).toBe('PAUSED');
        if (i.guard.fairHousing) {
          expect(d.reasons).toContain('FAIR_HOUSING');
          expect(d.checkThis).toBe(true);
        }
        if (!i.verdict.allow) expect(d.downgrade).toBe(i.verdict.downgrade);
      }),
      { numRuns: 2000 },
    );
  });

  it('mutation guards: each single condition flipped from an all-clear send turns it into a non-send', () => {
    const ok = { paused: false, itemsDraft: { draft: false, reasons: [] as DraftReason[], checkThis: false }, verdict: { allow: true as const }, guard: { hardBlock: false, fairHousing: false }, ownerUserId: 'u1' as string | null };
    expect(decideBatch(ok).action).toBe('send');
    expect(decideBatch({ ...ok, paused: true }).action).toBe('draft');
    expect(decideBatch({ ...ok, itemsDraft: { ...ok.itemsDraft, draft: true } }).action).toBe('draft');
    expect(decideBatch({ ...ok, itemsDraft: { ...ok.itemsDraft, reasons: ['AVM_NOT_CLEARED'] } }).action).toBe('draft');
    expect(decideBatch({ ...ok, verdict: { allow: false, downgrade: 'CATEGORY_DISABLED' } }).action).toBe('draft');
    expect(decideBatch({ ...ok, verdict: { allow: false, downgrade: 'APPROVAL_REVOKED' } }).action).toBe('draft');
    expect(decideBatch({ ...ok, guard: { hardBlock: false, fairHousing: true } }).action).toBe('draft');
    expect(decideBatch({ ...ok, guard: { hardBlock: true, fairHousing: false } }).action).toBe('skip');
    expect(decideBatch({ ...ok, ownerUserId: null }).action).toBe('skip');
  });
});

// ---- firings: stored shape, digest, API-level skips -------------------------------------------------------

const T0 = Date.UTC(2026, 10, 10, 15) as Instant;
const firingArb: fc.Arbitrary<Firing> = fc
  .record({ contact: fc.constantFrom('c1', 'c2'), playbook: fc.constantFrom('p1', 'p2'), listing: fc.constantFrom('l1', 'l2', 'l3', 'l4'), at: fc.integer({ min: 0, max: 6 * 3600 }), hist: fc.uuid() })
  .map((x) => ({
    triggerKey: `price_drop:${x.hist}:${x.contact}`,
    trigger: 'price_drop' as const,
    contactId: x.contact,
    playbookId: x.playbook,
    versionId: `${x.playbook}-v1`,
    stepKey: 'price_drop',
    scheduledFor: instant(T0 + x.at * 1000),
    ref: { kind: 'price_drop' as const, listingId: x.listing, historyId: x.hist, source: 'mls' as const, oldPriceCents: 50_000_000, newPriceCents: 48_000_000, address: '1 A St', mlsNumber: null },
    evidence: [],
  }));

describe('digest and stored firings (property)', () => {
  it('E84 R-NURT-3: digestKeepAll places every firing in exactly one batch of its own contact and playbook; nothing is dropped', () => {
    fc.assert(
      fc.property(fc.uniqueArray(firingArb, { selector: (f) => f.triggerKey, maxLength: 12 }), fc.integer({ min: 0, max: 240 }), (fs, win) => {
        const batches = digestKeepAll(fs, win);
        const ids = batches.flatMap((b) => b.ids);
        expect(ids.sort()).toEqual(fs.map((f) => f.triggerKey).sort());
        for (const b of batches) {
          const members = fs.filter((f) => b.ids.includes(f.triggerKey));
          expect(new Set(members.map((m) => `${m.contactId}:${m.playbookId}`)).size).toBe(1);
          // a batch never sends before any of its firings is due
          for (const m of members) expect(b.sendAt).toBeGreaterThanOrEqual(m.scheduledFor);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('R-NURT-1: a stored firing round-trips exactly; anything we did not write fails closed (null)', () => {
    fc.assert(
      fc.property(firingArb, (f) => {
        const row = { id: 'r', contactId: f.contactId, versionId: f.versionId, stepKey: f.stepKey, triggerKey: f.triggerKey, scheduledFor: T0, triggerRef: JSON.parse(JSON.stringify(storedRefOf(f))) };
        expect(firingOfRow(row)).toEqual(f);
        expect(firingOfRow({ ...row, triggerRef: { ...row.triggerRef, v: 2 } })).toBeNull();
        expect(firingOfRow({ ...row, triggerRef: { ...row.triggerRef, trigger: 'rate_move' } })).toBeNull();
        expect(firingOfRow({ ...row, triggerRef: { ...row.triggerRef, trigger: 'back_on_market' } })).toBeNull(); // kind mismatch
        expect(firingOfRow({ ...row, triggerRef: [] })).toBeNull();
      }),
    );
  });

  it('R-NURT-2: apiSkip: a merged-away record, a removed step, a kind not available yet, an unfollowed home or an anniversary already sent never build a message', () => {
    const f = fc.sample(firingArb, 1)[0]!;
    const content = { kind: 'triggers' as const, digestWindowMinutes: 0, triggers: [{ trigger: 'price_drop' as const, stepKey: 'price_drop', channel: 'email' as const, offsetSeconds: 0, purpose: 'marketing' as const, category: 'search_alert' as const, intent: 'price_drop_alert' as const, template: 'x', subject: 'y', slots: [], maxLength: 100 }] };
    const base = { contactLive: true, content, firing: f, stillFollowed: true, anniversaryAlreadySent: false };
    expect(apiSkip(base)).toBeNull();
    expect(apiSkip({ ...base, contactLive: false })).toBe('CONTACT_REMOVED');
    expect(apiSkip({ ...base, content: null })).toBe('STEP_REMOVED');
    expect(apiSkip({ ...base, content: { ...content, triggers: [{ ...content.triggers[0]!, stepKey: 'other' }] } })).toBe('STEP_REMOVED');
    expect(apiSkip({ ...base, stillFollowed: false })).toBe('NO_LONGER_FOLLOWED');
    expect(apiSkip({ ...base, firing: { ...f, trigger: 'home_value', ref: { kind: 'home_value', contactAddressId: 'a', month: '2026-11', valuationId: 'v', address: 'x' } }, content: { ...content, triggers: [{ ...content.triggers[0]!, trigger: 'home_value' }] } })).toBeNull(); // wave 2C: home values fire
  });

  it('R-NURT-7 R-NURT-4 (core, as wired here): an agent playbook never fires for a contact another agent owns, and planBatch drops only the items whose fact no longer holds', () => {
    fc.assert(
      fc.property(fc.constantFrom('u1', 'u2', null), fc.constantFrom('u1', 'u2'), (owner, pbOwner) => {
        const fact = { kind: 'price_change' as const, listingId: 'l1', historyId: 'h', source: 'mls' as const, oldPriceCents: 2, newPriceCents: 1, at: T0, address: 'a', mlsNumber: null, displayAllowed: true, feedFresh: true };
        const pb = { playbookId: 'p', versionId: 'v', scope: 'agent' as const, ownerUserId: pbOwner, steps: [{ trigger: 'price_drop' as const, stepKey: 'price_drop', offsetSeconds: 0 }] };
        const fired = detectFirings(fact, [{ contactId: 'c', ownerUserId: owner, relation: { kind: 'listing', listingId: 'l1', via: 'saved' }, playbook: pb }]);
        expect(fired.length === 1).toBe(owner !== null && owner === pbOwner);
        for (const fr of fired) {
          const plan = planTriggerRun({ firing: fr, current: { kind: 'listing', status: 'withdrawn', priceCents: 1, displayAllowed: true, feedFresh: true }, now: T0, approvalCurrent: true, playbook: { scope: 'agent', ownerUserId: pbOwner }, contactOwnerUserId: owner, paused: false, guard: { hardBlock: false, fairHousing: false, otherIssues: false } });
          expect(planBatch([{ firing: fr, plan }]).action).toBe('skip');
        }
      }),
    );
  });

  it('digest wording: item lines are literals (MLS text can never inject a template marker or a new line)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 40 }), { minLength: 2, maxLength: 5 }), (lines) => {
        const t = digestTemplate(lines);
        expect(t.replace('{{first_name}}', '')).not.toMatch(/\{\{|\}\}/);
        expect(t.split('\n')).toHaveLength(lines.length + 2);
        for (const l of lines) expect(literal(l)).not.toMatch(/[\r\n\t]|\{\{|\}\}/);
      }),
    );
  });
});
