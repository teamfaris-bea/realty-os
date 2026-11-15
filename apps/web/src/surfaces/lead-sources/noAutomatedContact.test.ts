// b18 review B18S-5 (owner product boundary, 2026-11-14): every path "No automated contact for leads from this source"
// blocks says so in plain words, never a code: the stage entry's toast, a bulk action's skip count, and a thread's
// "Not sent" line for an automated or bulk message dispatch refused (SOURCE_NO_AUTOMATED_CONTACT).
import { describe, expect, it } from 'vitest';
import { messageStatus } from '../../reasons/sentences.js';
import { reasonWords } from '../bulk/api.js';
import { AGENT_ERROR_MESSAGES, automatedDraftRefusalWords } from '../feed/lib/messages.js';
import { automationText } from '../people-edit/StagePill.js';
import { NO_AUTOMATED_CONTACT_LABEL } from './Manage.js';
import { withdrawnDraftsWords } from './words.js';

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

  it('E727 (b18 round 3 item 3): the Owner\'s answer counts the drafts a plan or an alert wrote that were withdrawn, one or many, and says nothing when there were none', () => {
    expect(withdrawnDraftsWords(1)).toBe(' 1 draft a plan or an alert wrote for them was withdrawn.');
    expect(withdrawnDraftsWords(3)).toBe(' 3 drafts a plan or an alert wrote for them were withdrawn.');
    expect(withdrawnDraftsWords(0)).toBe('');
    expect(withdrawnDraftsWords(undefined)).toBe('');
  });

  it('E727 (b18 round 3 item 3): a refused approval of a draft a plan or an alert wrote reads the server\'s sentence, or the table\'s own when it sent none; never the generic "try again", and never for another refusal', () => {
    const server = `This draft was written by a plan or an alert, and "${NO_AUTOMATED_CONTACT_LABEL}" is on for this person's lead source (an Owner setting), so it was withdrawn and nothing was sent. Call, text or email them one to one.`;
    expect(automatedDraftRefusalWords('SOURCE_NO_AUTOMATED_CONTACT', { reason: 'source_no_automated_contact', sentence: server })).toBe(server);
    const own = automatedDraftRefusalWords('SOURCE_NO_AUTOMATED_CONTACT', null);
    expect(own).toBe(AGENT_ERROR_MESSAGES['SOURCE_NO_AUTOMATED_CONTACT']);
    expect(own).toContain(`"${NO_AUTOMATED_CONTACT_LABEL}"`);
    expect(own).toContain('Nothing was sent.');
    expect(own).not.toMatch(/try again/i);
    expect(automatedDraftRefusalWords('DRAFT_INVALIDATED', { sentence: server })).toBeNull();
  });
});
