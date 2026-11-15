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

  it.each(['Northgate', 'LeadRouter', 'Northgate  Referrals', 'Northgate-Referrals', 'Northgate Referral', 'Partner'])('does not infer a source for %s', (label) => {
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
});
