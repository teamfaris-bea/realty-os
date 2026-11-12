// Property tests of the pass's decision functions (module 50; critical-module rule). The DB-backed tests show the
// pass applies these decisions; here fast-check explores them. R-PRED-1/3/4/6 and R-OWN-27 are cited in comments:
// the full rules are proved by the integration tests together with these.
import { DAY_MS, type Instant, instant } from '@realty/core/foundation';
import { type ApprovedModel, FEATURE_NAMES, type FeatureName, type Reason, normalizeAddress, parseFeatures, requireApproved, scoreWithModel } from '@realty/core/predict';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type AddressCandidate, type CardContact, addressDue, assembleFeatures, budgetLeft, desiredCard, isNightHour, selectLookups } from './decide.js';
import { PREDICT_SETTINGS } from './settings.js';
import { PROPERTY_MODEL, TEST_BACKTEST, definitionOf } from './testing.js';

const NOW = instant(Date.parse('2026-11-12T03:00:00Z'));
const approved = (spec = PROPERTY_MODEL): ApprovedModel => {
  const d = definitionOf(spec);
  const r = requireApproved({ ...d, features: [...d.features], status: 'approved', counselReviewedAt: '2026-10-01T00:00:00Z', backtest: { ...TEST_BACKTEST } });
  if (!r.ok) throw new Error('fixture');
  return r.model;
};
const MODEL = approved();

const arbAddress = fc.record({
  line1: fc.oneof(fc.constant(''), fc.constantFrom('1 Synthetic Way', '22 Example Ave', '305 Test Blvd')),
  line2: fc.option(fc.constantFrom('Unit 2', '#4', ''), { nil: null }),
  city: fc.constantFrom('Exampleton', 'Otherton', ''),
  region: fc.constantFrom('CA', 'NY'),
  postalCode: fc.constantFrom('90001', '1000', '10001-1234'),
});
const arbCandidate: fc.Arbitrary<AddressCandidate> = fc.record({
  addressId: fc.uuid(),
  contactId: fc.uuid(),
  kind: fc.constantFrom('home', 'mailing', 'property', 'interest'),
  contactLive: fc.boolean(),
  contactOwned: fc.boolean(),
  doNotContact: fc.boolean(),
  address: arbAddress,
  updatedAt: fc.integer({ min: NOW - 400 * DAY_MS, max: NOW }).map((t) => t as Instant),
  fetchedAt: fc.option(fc.integer({ min: NOW - 400 * DAY_MS, max: NOW }).map((t) => t as Instant), { nil: null }),
});

describe('selectLookups (R-PRED-2, R-OWN-27 budget)', () => {
  it('never exceeds the budget and never looks up an address that is not due, not a home, not normalizable, of a contact that is not live, owned and listable, or without a purpose', () => {
    fc.assert(
      fc.property(fc.array(arbCandidate, { maxLength: 40 }), fc.integer({ min: 0, max: 50 }), fc.integer({ min: 1, max: 200 }), fc.boolean(), (cands, budget, refreshAgeDays, purpose) => {
        const out = selectLookups(cands, { now: NOW, refreshAgeDays, budgetLeft: budget, purpose });
        expect(out.length).toBeLessThanOrEqual(budget);
        if (!purpose) expect(out).toEqual([]);
        for (const c of out) {
          expect(c.kind).toBe('home');
          expect(c.contactLive && c.contactOwned && !c.doNotContact).toBe(true);
          expect(normalizeAddress(c.address)).not.toBeNull();
          expect(addressDue(c, NOW, refreshAgeDays)).toBe(true);
        }
        // it takes every eligible one up to the budget, in order
        const eligible = cands.filter((c) => c.kind === 'home' && c.contactLive && c.contactOwned && !c.doNotContact && normalizeAddress(c.address) !== null && addressDue(c, NOW, refreshAgeDays));
        expect(out).toEqual(purpose ? eligible.slice(0, budget) : []);
      }),
    );
  });

  it('the budget left is the daily budget less the rows fetched today and this pass\'s lookups, never negative', () => {
    fc.assert(fc.property(fc.nat(500), fc.nat(500), fc.nat(500), (b, today, made) => {
      const left = budgetLeft(b, today, made);
      expect(left).toBe(Math.max(0, b - today - made));
      expect(today + made + left).toBeGreaterThanOrEqual(Math.min(b, today + made));
    }));
  });

  it('the night window is exactly [start, end)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 23 }), (hour) => {
      expect(isNightHour(hour, PREDICT_SETTINGS)).toBe(hour >= PREDICT_SETTINGS.nightStartHour && hour < PREDICT_SETTINGS.nightEndHour);
    }));
  });
});

const arbInputs = fc.record({
  contactId: fc.uuid(),
  record: fc.option(
    fc.record({
      id: fc.uuid(),
      ownerNameMatch: fc.boolean(),
      lastSaleDate: fc.option(fc.integer({ min: 1950, max: 2030 }).map((y) => `${y}-06-01`), { nil: null }),
      lastSalePriceCents: fc.option(fc.integer({ min: 0, max: 5e9 }), { nil: null }),
      assessedValueCents: fc.option(fc.integer({ min: 0, max: 5e9 }), { nil: null }),
      recentPermit: fc.option(fc.boolean(), { nil: null }),
    }),
    { nil: null },
  ),
  recentSaves: fc.option(fc.integer({ min: -5, max: 20_000 }), { nil: null }),
  lastClosedDeal: fc.option(fc.record({ dealId: fc.uuid(), closedAt: fc.integer({ min: NOW - 60 * 365 * DAY_MS, max: NOW + 10 * DAY_MS }).map((t) => t as Instant) }), { nil: null }),
});
const arbFeatureSet = fc.subarray([...FEATURE_NAMES] as FeatureName[], { minLength: 1 });

describe('assembleFeatures (R-PRED-1, E120)', () => {
  it('features stay within the six, within the model\'s own features, never include a stated timeline, and always pass parseFeatures', () => {
    fc.assert(
      fc.property(arbInputs, arbFeatureSet, (i, feats) => {
        const a = assembleFeatures(i, NOW, feats, { recentSavesWindowDays: 90 });
        expect(parseFeatures(a.features).ok).toBe(true);
        expect(a.features.statedTimelineDays).toBeUndefined();
        const KEY: Record<string, FeatureName> = { yearsInHome: 'years_in_home', equityBand: 'equity_band', recentSaves: 'recent_saves', statedTimelineDays: 'stated_timeline_days', pastClientYears: 'past_client_years', recentPermit: 'recent_permit' };
        for (const k of Object.keys(a.features)) expect(feats).toContain(KEY[k]);
        for (const k of Object.keys(a.evidence)) expect(feats).toContain(k);
        // an unmatched record never yields a property feature (R-PRED-2)
        if (i.record === null || !i.record.ownerNameMatch) expect([a.features.yearsInHome, a.features.equityBand, a.features.recentPermit]).toEqual([undefined, undefined, undefined]);
      }),
    );
  });
});

const arbContact: fc.Arbitrary<CardContact> = fc.record({
  contactId: fc.uuid(),
  live: fc.boolean(),
  ownershipState: fc.constantFrom('owned', 'pond', 'offered', 'closed', 'routing'),
  ownerUserId: fc.option(fc.uuid(), { nil: null }),
  doNotContact: fc.boolean(),
  closedReason: fc.option(fc.constantFrom('do_not_contact', 'merged', 'not_interested'), { nil: null }),
});

describe('desiredCard (R-PRED-3, R-PRED-4, R-PRED-6)', () => {
  it('a card exists exactly when the model can score, the band is likely or watch with a reason, and the contact is live, owned and listable; it goes to the current owner only and carries no points', () => {
    fc.assert(
      fc.property(arbInputs, arbContact, (i, c) => {
        const a = assembleFeatures(i, NOW, MODEL.features, { recentSavesWindowDays: 90 });
        const s = scoreWithModel(a.features, MODEL, a.evidence);
        expect(s.ok).toBe(true);
        if (!s.ok) return;
        const card = desiredCard(s.result, MODEL, c);
        const expected = (s.result.band === 'likely_90d' || s.result.band === 'watch') && s.result.reasons.length > 0 && c.live && c.ownershipState === 'owned' && c.ownerUserId !== null && !c.doNotContact && c.closedReason !== 'do_not_contact';
        expect(card !== null).toBe(expected);
        if (card) {
          expect(card.userId).toBe(c.ownerUserId);
          expect(card.dedupeKey).toBe(`likely:${c.contactId}:${MODEL.version}`);
          expect([15, 30]).toContain(card.score);
          expect(card.reasons.at(-1)!.label).toBe('Of 120 people flagged in the back-test, 31 transacted within 90 days');
          expect(card.reasons).toHaveLength(s.result.reasons.length + 2);
          expect(JSON.stringify(card)).not.toMatch(/points|probab|confiden|percent/i);
        }
      }),
    );
  });

  it('a model that cannot score makes no card: a draft or withdrawn status never reaches desiredCard as approved', () => {
    const r: Reason[] = [{ feature: 'recent_saves', points: 30, evidence: { sourceType: 'features_input', field: 'recentSaves' }, text: 'Saved 3 listings recently' }];
    const c: CardContact = { contactId: '00000000-0000-7000-8000-000000000001', live: true, ownershipState: 'owned', ownerUserId: '00000000-0000-7000-8000-000000000002', doNotContact: false, closedReason: null };
    expect(desiredCard({ band: 'watch', reasons: r }, { ...MODEL, status: 'withdrawn' } as never, c)).toBeNull();
    expect(desiredCard({ band: 'watch', reasons: r }, { ...MODEL, backtest: null } as never, c)).toBeNull();
  });
});

describe('idempotence (R-OWN-27)', () => {
  it('the same inputs on the same date give the same band, reasons and inputs hash (so a re-run writes nothing)', () => {
    fc.assert(
      fc.property(arbInputs, (i) => {
        const once = () => {
          const a = assembleFeatures(i, NOW, MODEL.features, { recentSavesWindowDays: 90 });
          return scoreWithModel(a.features, MODEL, a.evidence);
        };
        expect(once()).toEqual(once());
      }),
    );
  });
});
