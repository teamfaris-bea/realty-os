// b18 review B18S-5 (owner product boundary, 2026-11-14): every path "No automated contact for leads from this source"
// blocks says so in plain words, never a code: the stage entry's toast, a bulk action's skip count, and a thread's
// "Not sent" line for an automated or bulk message dispatch refused (SOURCE_NO_AUTOMATED_CONTACT).
import { describe, expect, it } from 'vitest';
import { messageStatus } from '../../reasons/sentences.js';
import { reasonWords } from '../bulk/api.js';
import { automationText } from '../people-edit/StagePill.js';
import { NO_AUTOMATED_CONTACT_LABEL } from './Manage.js';

describe('R-LSRC-8 B18S-5: the blocked paths say "No automated contact for leads from this source"', () => {
  it('B18S-5 E727: a stage entry that did not start a plan says why', () => {
    expect(automationText({ skipped: 'source_no_automated_contact', plan: 'Check-in' })).toBe(`Check-in didn't start: their lead source is marked "${NO_AUTOMATED_CONTACT_LABEL}"`);
  });

  it('B18S-5 E727: a bulk action counts the people it left out in words', () => {
    expect(reasonWords('SOURCE_NO_AUTOMATED_CONTACT')).toBe(`came from a lead source marked "${NO_AUTOMATED_CONTACT_LABEL}" (call, text or email them one to one)`);
  });

  it('B18S-5 E727: an automated or bulk message dispatch refused reads "Not sent" with the reason, on every channel', () => {
    for (const channel of ['sms', 'email'] as const) {
      expect(messageStatus({ status: 'blocked', statusReason: 'SOURCE_NO_AUTOMATED_CONTACT', channel }, 'Ana')).toEqual({
        text: `Not sent: their lead source is marked "${NO_AUTOMATED_CONTACT_LABEL}" (an Owner setting); call, text or email them one to one`,
        tone: 'failed',
      });
    }
  });
});
