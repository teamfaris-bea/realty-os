import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import { intentSignals, readiness, readinessEndReason, type ReadinessInput } from './readiness.js';
import { NOW, NY } from './testing/fixtures.js';
import type { UsableQualClaim } from './types.js';

const claim = (field: UsableQualClaim['field'], value: UsableQualClaim['value'], k = 0): UsableQualClaim => ({ claimId: `c-${field}-${k}`, field, value, quote: String(value), messageId: `m${k}`, saidAt: NOW });
const B3 = [claim('timeline', 'in the next 2 months'), claim('financing_status_stated', 'preapproved'), claim('areas', ['Springfield']), claim('budget', 450000), claim('beds_min', 3)];
const S3 = [claim('seller_timeline', 'within 60 days'), claim('seller_owns_stated', true), claim('seller_listed_elsewhere_stated', false)];
const base = (o: Partial<ReadinessInput> = {}): ReadinessInput => ({ side: 'buyer', now: NOW, zone: NY, claims: [], intents: [], offerLive: false, appointmentBooked: null, mlsListedElsewhere: false, subjectConfirmed: false, ...o });

describe('R-ISA-12 buyer readiness', () => {
  it('B1 an appointment was booked', () => {
    const r = readiness(base({ appointmentBooked: { appointmentId: 'a1', kind: 'buyer_consult' } }));
    expect(r).toMatchObject({ ready: true, rule: 'B1' });
    expect(readinessEndReason('B1')).toBe('appointment_booked');
  });
  it('B2 E502 "we want to make an offer" is ready (a statement, not a pricing hold)', () => {
    const intents = intentSignals('we want to make an offer on the one on Elm', 'm9');
    expect(intents.map((i) => i.kind)).toContain('make_offer');
    const r = readiness(base({ intents }));
    expect(r).toMatchObject({ ready: true, rule: 'B2', messageIds: ['m9'] });
    expect(readinessEndReason('B2')).toBe('ready_buyer');
  });
  it('B2 a tour request; a verified wants_agent_contact', () => {
    expect(readiness(base({ intents: intentSignals('can we see it this weekend', 'm1') }))).toMatchObject({ rule: 'B2' });
    expect(readiness(base({ claims: [claim('wants_agent_contact', true)] }))).toMatchObject({ rule: 'B2', claimIds: ['c-wants_agent_contact-0'] });
    expect(readiness(base({ claims: [claim('wants_agent_contact', false)] })).ready).toBe(false);
  });
  it('B3 every field: timeline ≤ 90 days, financing, areas, budget, beds', () => {
    const r = readiness(base({ claims: B3 }));
    expect(r).toMatchObject({ ready: true, rule: 'B3', ruleVersion: 'isa-readiness/1' });
    expect(r.ready && r.claimIds.length).toBe(5);
  });
  it('B3 fails with what is missing: a long timeline, unready financing, a missing field', () => {
    const long = readiness(base({ claims: [claim('timeline', 'in 6 months'), ...B3.slice(1)] }));
    expect(long).toEqual({ ready: false, waitingForOffer: false, missing: ['buyer:timeline'] });
    const fin = readiness(base({ claims: [B3[0]!, claim('financing_status_stated', 'not_started'), ...B3.slice(2)] }));
    expect(fin.ready === false && fin.missing).toEqual(['buyer:financing_status_stated']);
    const noBeds = readiness(base({ claims: B3.slice(0, 4) }));
    expect(noBeds.ready === false && noBeds.missing).toEqual(['buyer:beds_min']);
    expect(readiness(base({ claims: B3, timelineDaysMax: 30 })).ready).toBe(false);
  });
  it('the latest claim of a field wins', () => {
    const later = { ...claim('financing_status_stated', 'not_started', 1), saidAt: at('2026-11-12T16:00:00Z') };
    expect(readiness(base({ claims: [...B3, later] })).ready).toBe(false);
  });
  it('readiness waits while an offer is live', () => {
    expect(readiness(base({ claims: B3, offerLive: true }))).toEqual({ ready: false, waitingForOffer: true, missing: ['offer_live'] });
  });
  it('property: every B3 field can be satisfied, and removing any one breaks B3', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (drop) => {
        expect(readiness(base({ claims: B3 })).ready).toBe(true);
        expect(readiness(base({ claims: B3.filter((_, k) => k !== drop) })).ready).toBe(false);
      }),
    );
  });
});

describe('R-ISA-12 seller readiness', () => {
  it('S1 a listing appointment or consult', () => {
    expect(readiness(base({ side: 'seller', appointmentBooked: { appointmentId: 'a', kind: 'listing_appointment' } }))).toMatchObject({ rule: 'S1' });
    expect(readiness(base({ side: 'seller', appointmentBooked: { appointmentId: 'a', kind: 'buyer_consult' } })).ready).toBe(false);
  });
  it('S2 a request to list or meet PLUS an intent to sell', () => {
    const both = [...intentSignals('we want to list', 'm1'), ...intentSignals('we are selling', 'm2')];
    expect(readiness(base({ side: 'seller', intents: both }))).toMatchObject({ rule: 'S2' });
    expect(readiness(base({ side: 'seller', intents: intentSignals('can we set up a meeting', 'm1') })).ready).toBe(false);
    expect(readiness(base({ side: 'seller', intents: intentSignals("we're not ready to list", 'm1') })).ready).toBe(false);
    expect(readinessEndReason('S2')).toBe('ready_seller');
  });
  it('S3 needs the MLS check and a confirmed subject too', () => {
    expect(readiness(base({ side: 'seller', claims: S3, subjectConfirmed: true }))).toMatchObject({ rule: 'S3' });
    const listed = readiness(base({ side: 'seller', claims: S3, subjectConfirmed: true, mlsListedElsewhere: true }));
    expect(listed.ready === false && listed.missing).toEqual(['seller:mls_not_listed']);
    const unconfirmed = readiness(base({ side: 'seller', claims: S3 }));
    expect(unconfirmed.ready === false && unconfirmed.missing).toEqual(['seller:subject_confirmed']);
    const claimsListed = readiness(base({ side: 'seller', claims: [S3[0]!, S3[1]!, claim('seller_listed_elsewhere_stated', true)], subjectConfirmed: true }));
    expect(claimsListed.ready).toBe(false);
  });
  it('side both reads both sets', () => {
    expect(readiness(base({ side: 'both', claims: S3, subjectConfirmed: true }))).toMatchObject({ rule: 'S3' });
    const r = readiness(base({ side: 'both' }));
    expect(r.ready === false && r.missing.some((m) => m.startsWith('buyer:')) && r.missing.some((m) => m.startsWith('seller:'))).toBe(true);
  });
});
