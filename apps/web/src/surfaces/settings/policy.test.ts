// The web's mirror of api/admin policyLoosening: it only decides when to show the attestation before
// saving (the server decides what is accepted). Cases follow the rules in api/admin policy.ts.
import { PLATFORM_FLOOR } from '@realty/core/compliance';
import { describe, expect, it } from 'vitest';
import { POLICY_DEFAULTS as DEFAULTS } from '../admin/lib/testing.js';
import { FIELD_LABEL, OPT_OUT_KEYWORDS, draftDelta, looserFields, valueText } from './policy.js';

describe('looserFields', () => {
  it('nothing changed is not looser; stricter changes are not looser', () => {
    expect(looserFields(DEFAULTS, DEFAULTS)).toEqual([]);
    const stricter = { ...DEFAULTS, autonomousCategories: ['reminder' as const], recordingEnabled: false };
    expect(looserFields(DEFAULTS, stricter)).toEqual([]);
  });

  it('an added category, recording turned on or one-party mode are looser', () => {
    const base = { ...DEFAULTS, autonomousCategories: ['reminder' as const], recordingEnabled: false };
    expect(looserFields(base, { ...base, autonomousCategories: ['reminder', 'document_chase'] })).toEqual(['autonomousCategories']);
    expect(looserFields(base, { ...base, recordingEnabled: true })).toEqual(['recordingEnabled']);
    expect(looserFields(base, { ...base, recordingMode: 'one_party_where_permitted' })).toEqual(['recordingMode']);
  });

  it('one-party recording always needs the attestation, even when the active version already allows it', () => {
    const attested = { ...DEFAULTS, recordingMode: 'one_party_where_permitted' as const };
    expect(looserFields(attested, attested)).toEqual(['recordingMode']);
  });

  it('the opt-out confirmation sender is operational and counts neither way', () => {
    expect(looserFields(DEFAULTS, { ...DEFAULTS, optOutConfirmationSender: 'platform' })).toEqual([]);
  });
});

describe('draftDelta / valueText', () => {
  it('sends only what differs from the active version (category order does not matter)', () => {
    expect(draftDelta(DEFAULTS, { ...DEFAULTS, autonomousCategories: [...DEFAULTS.autonomousCategories].reverse() })).toEqual({});
    expect(draftDelta(DEFAULTS, { ...DEFAULTS, recordingEnabled: false })).toEqual({ recordingEnabled: false });
  });

  it('says values in words', () => {
    expect(valueText('recordingMode', DEFAULTS)).toBe('Every call is announced before recording');
    expect(valueText('autonomousCategories', { ...DEFAULTS, autonomousCategories: [] })).toBe('Nothing');
    expect(valueText('optOutConfirmationSender', DEFAULTS)).toBe('The phone carrier service');
  });

  it('labels exactly the policy fields that still exist: no contact hours, quiet hours or caps', () => {
    expect(Object.keys(FIELD_LABEL).sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(Object.values(FIELD_LABEL).join(' ')).not.toMatch(/contact hours|quiet|per day|per week|cap/i);
  });
});

describe('OPT_OUT_KEYWORDS', () => {
  it('matches the platform opt-out keywords in core/compliance word for word', () => {
    expect([...OPT_OUT_KEYWORDS]).toEqual([...PLATFORM_FLOOR.keywords.optOut]);
  });
});
