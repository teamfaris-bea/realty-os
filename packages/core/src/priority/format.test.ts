import { describe, expect, it } from 'vitest';
import { clip, formatDuration } from './format.js';

describe('wording helpers', () => {
  it('formats durations in the largest honest unit, never negative', () => {
    expect([-5_000, 59_999, 60_000, 59 * 60_000, 3_600_000, 47.9 * 3_600_000, 48 * 3_600_000].map(formatDuration)).toEqual([
      'less than a minute',
      'less than a minute',
      '1 min',
      '59 min',
      '1 h',
      '47 h',
      '2 d',
    ]);
  });

  it('clips long text on a word boundary when it can, with an ellipsis', () => {
    expect(clip('  short   text ', 20)).toBe('short text');
    expect(clip('They asked about the open house on Saturday morning', 20)).toBe('They asked about…');
    expect(clip('Supercalifragilisticexpialidocious', 10)).toBe('Supercali…');
  });
});
