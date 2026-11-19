import { describe, expect, it } from 'vitest';
import { suggestLeadSource } from './index.js';

// Synthetic catalog only. This helper supports review; R-LSRC-8 / E728 mapping stays Owner-only.
const sources = [{ id: 'source-a', name: 'Northgate Referrals', ownerConfirmedLabels: ['Partner export'] }] as const;

describe('P2C imported source suggestions', () => {
  it('suggests an exact source name ignoring only case and surrounding spaces, pending Owner confirmation', () => {
    expect(suggestLeadSource('northgate referrals ', sources)).toEqual({
      status: 'suggestion', leadSourceId: 'source-a', requiresOwnerConfirmation: true,
    });
  });

  it('matches an Owner-confirmed label by the same exact rule', () => {
    expect(suggestLeadSource(' PARTNER EXPORT ', sources)).toEqual({
      status: 'suggestion', leadSourceId: 'source-a', requiresOwnerConfirmation: true,
    });
  });

  it.each(['Northgate', 'Routing Desk', 'Northgate  Referrals', 'Northgate-Referrals', 'Northgate Referral', 'Partner'])('does not infer a source for %s', (label) => {
    expect(suggestLeadSource(label, sources)).toEqual({ status: 'no_match' });
  });

  it.each(['', '   ', '\t\n', null, undefined])('fails safely for an empty label %s', (label) => {
    expect(suggestLeadSource(label, [{ id: 'empty', name: ' ', ownerConfirmedLabels: [''] }])).toEqual({ status: 'no_match' });
  });

  it('returns no match for an empty catalog', () => {
    expect(suggestLeadSource('Zillow', [])).toEqual({ status: 'no_match' });
  });

  it('treats two case-variant source names as ambiguous regardless of order', () => {
    const catalog = [
      { id: 'source-a', name: 'Zillow', ownerConfirmedLabels: [] },
      { id: 'source-b', name: 'zillow', ownerConfirmedLabels: [] },
    ];
    expect(suggestLeadSource('Zillow', catalog)).toEqual({ status: 'ambiguous' });
    expect(suggestLeadSource('Zillow', [...catalog].reverse())).toEqual({ status: 'ambiguous' });
  });

  it('treats a name and a confirmed label on different sources as ambiguous', () => {
    expect(suggestLeadSource('Northgate Referrals', [
      ...sources,
      { id: 'source-b', name: 'Other synthetic source', ownerConfirmedLabels: [' northgate referrals '] },
    ])).toEqual({ status: 'ambiguous' });
  });

  it('treats confirmed labels on different sources as ambiguous', () => {
    expect(suggestLeadSource('Partner export', [
      ...sources,
      { id: 'source-b', name: 'Other synthetic source', ownerConfirmedLabels: ['PARTNER EXPORT'] },
    ])).toEqual({ status: 'ambiguous' });
  });

  it('counts distinct source IDs, not matching routes or duplicate rows, without mutating inputs', () => {
    const source = Object.freeze({ id: 'source-a', name: 'Northgate Referrals', ownerConfirmedLabels: Object.freeze(['northgate referrals', 'Northgate Referrals ']) });
    const catalog = Object.freeze([source, source]);
    expect(suggestLeadSource('Northgate Referrals', catalog)).toEqual({
      status: 'suggestion', leadSourceId: 'source-a', requiresOwnerConfirmation: true,
    });
    expect(catalog).toEqual([source, source]);
    expect(source.ownerConfirmedLabels).toEqual(['northgate referrals', 'Northgate Referrals ']);
  });
  // owner question OQ-B18-I9 (default as built): the comparison is trim() and toLowerCase() and nothing else
  it('R-LSRC-10 E752: letters outside plain English are compared by plain trim and lowercase only: an accented capital and a no-break space around a label match; a decomposed accent, full-width letters, ß against SS, a dotted capital I and a zero-width space do not, so they get no suggestion', () => {
    const catalog = [
      { id: 'cafe', name: 'Caf\u00e9 tour', ownerConfirmedLabels: [] },
      { id: 'street', name: 'Stra\u00dfe', ownerConfirmedLabels: [] },
      { id: 'open', name: 'Open house', ownerConfirmedLabels: [] },
      { id: 'izmir', name: 'izmir', ownerConfirmedLabels: [] },
    ];
    const yes = (id: string) => ({ status: 'suggestion', leadSourceId: id, requiresOwnerConfirmation: true });
    const no = { status: 'no_match' };
    expect(suggestLeadSource('CAF\u00c9 TOUR', catalog)).toEqual(yes('cafe'));
    expect(suggestLeadSource('\u00a0Open House\u00a0', catalog)).toEqual(yes('open'));
    // the same accent stored as a letter plus a combining mark (NFD) is another string: nothing normalizes it
    expect(suggestLeadSource('Cafe\u0301 tour', catalog)).toEqual(no);
    expect(suggestLeadSource('\uff2f\uff50\uff45\uff4e house', catalog)).toEqual(no);
    expect(suggestLeadSource('STRASSE', catalog)).toEqual(no);
    expect(suggestLeadSource('\u0130zmir', catalog)).toEqual(no);
    expect(suggestLeadSource('Open\u200b house', catalog)).toEqual(no);
    expect(suggestLeadSource('\u200bOpen house', catalog)).toEqual(no);
  });
});
