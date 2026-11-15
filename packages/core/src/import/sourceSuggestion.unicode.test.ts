import { describe, expect, it } from 'vitest';
import { suggestLeadSource } from './index.js';

// Synthetic labels. Characterization is not an Owner decision about Unicode equivalence.
const cases = [
  ['Turkish ASCII I/i', 'I', 'i', true],
  ['Turkish dotted capital/lowercase i', '\u0130', 'i', false],
  ['Turkish dotless lowercase/ASCII capital', '\u0131', 'I', false],
  ['Turkish dotted/dotless', '\u0130', '\u0131', false],
  ['Turkish dotted capital unchanged', '\u0130', '\u0130', true],
  ['Turkish dotted capital/lowercase plus combining dot', '\u0130', 'i\u0307', true],
  ['Kelvin sign/ASCII k', '\u212a', 'k', true],
  ['German sharp s case', '\u1e9e', '\u00df', true],
  ['German sharp s/SS', '\u00df', 'SS', false],
  ['Greek sigma case', '\u03a3', '\u03c3', true],
  ['Greek final sigma/capital', '\u03c2', '\u03a3', false],
  ['Greek final sigma in word', '\u039f\u03a3', '\u03bf\u03c2', true],
  ['Greek nonfinal sigma in word', '\u039f\u03a3', '\u03bf\u03c3', false],
  ['NBSP at edges', '\u00a0Synthetic Source\u00a0', 'Synthetic Source', true],
  ['NBSP inside versus ASCII space', 'Synthetic\u00a0Source', 'Synthetic Source', false],
  ['NBSP inside identical', 'Synthetic\u00a0Source', 'Synthetic\u00a0Source', true],
  ['zero-width space at edges', '\u200bSynthetic Source\u200b', 'Synthetic Source', false],
  ['zero-width space inside', 'Synthetic\u200bSource', 'SyntheticSource', false],
  ['zero-width space identical', 'Synthetic\u200bSource', 'Synthetic\u200bSource', true],
  ['zero-width joiner at edges', '\u200dSynthetic Source\u200d', 'Synthetic Source', false],
  ['zero-width joiner inside', 'Synthetic\u200dSource', 'SyntheticSource', false],
  ['zero-width joiner identical', 'Synthetic\u200dSource', 'Synthetic\u200dSource', true],
  ['NFC versus NFD accent', 'Caf\u00e9', 'Cafe\u0301', false],
  ['NFC accented case', 'CAF\u00c9', 'caf\u00e9', true],
  ['NFD accented case', 'CAFE\u0301', 'cafe\u0301', true],
] as const;

describe('P2C Unicode exact-match boundaries', () => {
  it.each(cases)('%s (both directions and both trusted routes)', (_name, label, candidate, matches) => {
    for (const [imported, stored] of [[label, candidate], [candidate, label]]) {
      for (const source of [
        { id: 'source-a', name: stored!, ownerConfirmedLabels: [] },
        { id: 'source-a', name: 'Unrelated synthetic source', ownerConfirmedLabels: [stored!] },
      ]) {
        expect(suggestLeadSource(imported, [source])).toEqual(matches
          ? { status: 'suggestion', leadSourceId: 'source-a', requiresOwnerConfirmation: true }
          : { status: 'no_match' });
      }
    }
  });

  it.each(cases.filter((row) => row[3]))('%s: two distinct sources matching through any trusted routes remain ambiguous', (_name, label, candidate) => {
    for (const firstByName of [true, false]) {
      for (const secondByName of [true, false]) {
        const sources = [
          { id: 'source-a', name: firstByName ? candidate : 'Synthetic A', ownerConfirmedLabels: firstByName ? [] : [candidate] },
          { id: 'source-b', name: secondByName ? candidate : 'Synthetic B', ownerConfirmedLabels: secondByName ? [] : [candidate] },
        ];
        expect(suggestLeadSource(label, sources)).toEqual({ status: 'ambiguous' });
        expect(suggestLeadSource(label, [...sources].reverse())).toEqual({ status: 'ambiguous' });
      }
    }
  });

  it('characterizes dotted-I lowercase expansion as ambiguous across two source IDs for Owner review', () => {
    expect(suggestLeadSource('\u0130', [
      { id: 'source-a', name: '\u0130', ownerConfirmedLabels: [] },
      { id: 'source-b', name: 'Synthetic', ownerConfirmedLabels: ['i\u0307'] },
    ])).toEqual({ status: 'ambiguous' });
  });

  it.each([
    ['sigma versus final sigma', '\u03c3', '\u03a3', '\u03c2', 'source-a'],
    ['sharp s versus SS', 'STRASSE', 'Stra\u00dfe', 'STRASSE', 'source-b'],
    ['NFC versus NFD', 'Caf\u00e9', 'Caf\u00e9', 'Cafe\u0301', 'source-a'],
  ])('characterizes %s as distinct under current lowercase equality, not broader human equivalence', (_name, label, first, second, selected) => {
    expect(suggestLeadSource(label, [
      { id: 'source-a', name: first!, ownerConfirmedLabels: [] },
      { id: 'source-b', name: 'Unrelated synthetic source', ownerConfirmedLabels: [second!] },
    ])).toEqual({ status: 'suggestion', leadSourceId: selected, requiresOwnerConfirmation: true });
  });

  it.each(['\u00a0', '\u200b', '\u200d'])('does not suggest for an invisible-only label %s against a visible source', (label) => {
    expect(suggestLeadSource(label, [{ id: 'source-a', name: 'Synthetic', ownerConfirmedLabels: [] }])).toEqual({ status: 'no_match' });
  });
});
