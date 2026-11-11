import { describe, expect, it } from 'vitest';
import { messageFor } from '../../shell/index.js';
import { PEOPLE_ERROR_MESSAGES } from './api.js';

describe('people error sentences', () => {
  it('R-PAR-12: re-adding a confirmed wrong number or wrong-person email is refused in words that fit a phone and an email alike, never a code', () => {
    const s = messageFor('WRONG_NUMBER_FINAL', PEOPLE_ERROR_MESSAGES);
    expect(s).toBe('That number or email was confirmed as reaching someone else (a wrong number), so it can’t be added back to this person.');
    expect(s).not.toMatch(/[A-Z]{2,}_/);
  });
});
