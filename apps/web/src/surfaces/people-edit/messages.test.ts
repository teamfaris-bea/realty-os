import { describe, expect, it } from 'vitest';
import { messageFor } from '../../shell/index.js';
import { reasonWords } from '../bulk/api.js';
import { PEOPLE_ERROR_MESSAGES } from './api.js';

describe('people error sentences', () => {
  it('R-PAR-12: re-adding a confirmed wrong number or wrong-person email is refused in words that fit a phone and an email alike, never a code', () => {
    const s = messageFor('WRONG_NUMBER_FINAL', PEOPLE_ERROR_MESSAGES);
    expect(s).toBe('That number or email was confirmed as reaching someone else (a wrong number), so it can’t be added back to this person.');
    expect(s).not.toMatch(/[A-Z]{2,}_/);
  });
});

describe('the stage lock in words (R-PAR-14, owner decision D8)', () => {
  it('E310: what reaches a lead names every first contact, a reply in their website chat included, in the person page and in a bulk skip', () => {
    expect(messageFor('STAGE_NEEDS_CONTACT', PEOPLE_ERROR_MESSAGES)).toBe('Reach them first (a call, text, email or reply in their website chat), or close the lead.');
    expect(reasonWords('STAGE_NEEDS_CONTACT')).toBe("haven't been reached yet (by a call, text, email or reply in their website chat)");
  });
});
