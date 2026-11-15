import { describe, expect, it } from 'vitest';
import { importLabelOf, labelRows, tallyLabels } from './importLabels.js';
import { ImportLabelBody } from './sourcesSchemas.js';

describe('Owner source review safety', () => {
  it('preserves the full raw label, including astral characters and suffixes beyond 120', () => {
    const raw = '😀'.repeat(119) + ' source A';
    expect(importLabelOf(raw)).toBe(raw);
    expect(ImportLabelBody.safeParse({ label: raw, leadSourceId: null }).success).toBe(true);
    expect(tallyLabels(['x'.repeat(120) + 'A', 'x'.repeat(120) + 'B']).size).toBe(2);
  });
  it('counts missing labels and fails closed for unmapped labels', () => {
    expect(tallyLabels([null, undefined, '', '   ']).get('')).toBe(4);
    expect(labelRows(new Map([['Unreviewed', 2]]), new Map())[0]).toMatchObject({
      noAutomatedContact: true, classification: 'SOURCE_UNCLASSIFIED',
    });
  });
});

it('missing source evidence asks for original-data review instead of an impossible label mapping', () => {
  const row = labelRows(new Map([['', 2]]), new Map())[0]!;
  expect(row.sentence).toMatch(/review the original import data/i);
  expect(row.sentence).not.toMatch(/confirms one exact source mapping/i);
});
