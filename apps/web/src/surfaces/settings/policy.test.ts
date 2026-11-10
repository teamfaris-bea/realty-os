// The web's mirror of api/admin policyLoosening: it only decides when to show the attestation before
// saving (the server decides what is accepted). Cases follow the rules in api/admin policy.ts.
import { describe, expect, it } from 'vitest';
import { POLICY_DEFAULTS as DEFAULTS } from '../admin/lib/testing.js';
import { draftDelta, looserFields, valueText } from './policy.js';

describe('looserFields', () => {
  it('nothing changed is not looser; stricter changes are not looser', () => {
    expect(looserFields(DEFAULTS, DEFAULTS, DEFAULTS)).toEqual([]);
    const stricter = { ...DEFAULTS, contactWindowStart: '10:00', contactWindowEnd: '19:00', autoSmsPer7d: 1, emailQuietHours: true, autonomousCategories: ['reminder' as const], recordingEnabled: false };
    expect(looserFields(DEFAULTS, stricter, DEFAULTS)).toEqual([]);
  });

  it('a wider window, a higher cap, quiet hours off, an added category, recording on or one-party mode are looser', () => {
    const base = { ...DEFAULTS, contactWindowStart: '10:00', contactWindowEnd: '19:00', autoSmsPer7d: 1, emailQuietHours: true, autonomousCategories: ['reminder' as const], recordingEnabled: false, maxDeferrals: 1 };
    expect(looserFields(base, { ...base, contactWindowStart: '09:30' }, DEFAULTS)).toEqual(['contactWindowStart']);
    expect(looserFields(base, { ...base, contactWindowEnd: '19:30' }, DEFAULTS)).toEqual(['contactWindowEnd']);
    expect(looserFields(base, { ...base, autoSmsPer7d: 2, maxDeferrals: 2 }, DEFAULTS)).toEqual(['autoSmsPer7d', 'maxDeferrals']);
    expect(looserFields(base, { ...base, emailQuietHours: false }, DEFAULTS)).toEqual(['emailQuietHours']);
    expect(looserFields(base, { ...base, autonomousCategories: ['reminder', 'document_chase'] }, DEFAULTS)).toEqual(['autonomousCategories']);
    expect(looserFields(base, { ...base, recordingEnabled: true }, DEFAULTS)).toEqual(['recordingEnabled']);
    expect(looserFields(base, { ...base, recordingMode: 'one_party_where_permitted' }, DEFAULTS)).toEqual(['recordingMode']);
  });

  it('beyond the shipped defaults always needs the attestation, even when the active version already allows it', () => {
    const attested = { ...DEFAULTS, contactWindowStart: '08:00', contactWindowEnd: '21:00', recordingMode: 'one_party_where_permitted' as const };
    expect(looserFields(attested, attested, DEFAULTS)).toEqual(['contactWindowEnd', 'contactWindowStart', 'recordingMode']);
  });

  it('the opt-out confirmation sender is operational and counts neither way', () => {
    expect(looserFields(DEFAULTS, { ...DEFAULTS, optOutConfirmationSender: 'platform' }, DEFAULTS)).toEqual([]);
  });
});

describe('draftDelta / valueText', () => {
  it('sends only what differs from the active version (category order does not matter)', () => {
    expect(draftDelta(DEFAULTS, { ...DEFAULTS, autonomousCategories: [...DEFAULTS.autonomousCategories].reverse() })).toEqual({});
    expect(draftDelta(DEFAULTS, { ...DEFAULTS, autoSmsPer7d: 2, emailQuietHours: true })).toEqual({ autoSmsPer7d: 2, emailQuietHours: true });
  });

  it('says values in words', () => {
    expect(valueText('contactWindowStart', DEFAULTS)).toBe("09:00 in the contact's local time");
    expect(valueText('recordingMode', DEFAULTS)).toBe('Every call is announced before recording');
    expect(valueText('autonomousCategories', { ...DEFAULTS, autonomousCategories: [] })).toBe('Nothing');
  });
});
