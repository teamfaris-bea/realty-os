// R-LSRC-9 A3 (owner decision 2026-11-14): everywhere the web explains "nothing automatic goes to this person" it
// chooses its words by the reason. An imported person whose source is not reviewed yet (SOURCE_UNCLASSIFIED,
// source_unclassified, AI_ISA_SOURCE_UNCLASSIFIED) has its own words in every table that words the marked source's
// refusal: the imported source has not been reviewed yet, and an Owner reviews it under Lead sources. None of them tells
// the team that the Owner turned a setting on, or that a lead source is marked.
import { describe, expect, it } from 'vitest';
import { messageStatus } from '../../reasons/sentences.js';
import { ISA_ERROR_MESSAGES, chainLinkWords, pauseWords } from '../aiCare/words.js';
import { reasonWords } from '../bulk/api.js';
import { AGENT_ERROR_MESSAGES, automatedDraftRefusalWords } from '../feed/lib/messages.js';
import { automationText } from '../people-edit/StagePill.js';

const UNREVIEWED = /imported source (has not been|is not) reviewed yet/;
const SETTING = /No automated contact for leads from this source|turned this on|Owner setting|is marked|\bmarked\b/;
const VIEWER = { isOwner: true, ownerFirst: 'Sam' } as Parameters<typeof chainLinkWords>[1];

describe('R-LSRC-9 A3: an unclassified imported person has its own words on the web', () => {
  it('R-LSRC-9 E729: every table that words the marked source\'s refusal words the unreviewed import on its own, never as the setting', () => {
    const words: Record<string, string | undefined> = {
      'a blocked message (reasons/sentences.ts)': messageStatus({ status: 'blocked', statusReason: 'SOURCE_UNCLASSIFIED', channel: 'sms' }, 'Ana')?.text,
      'an agent error (feed/lib/messages.ts)': AGENT_ERROR_MESSAGES['SOURCE_UNCLASSIFIED'],
      'a bulk reason (bulk/api.ts)': reasonWords('SOURCE_UNCLASSIFIED'),
      'a stage plan that did not start (StagePill.tsx)': automationText({ skipped: 'source_unclassified', plan: 'Buyer plan' }),
      'an AI care pause (aiCare/words.ts)': pauseWords('source_unclassified'),
      'an AI care refusal (aiCare/words.ts)': ISA_ERROR_MESSAGES['AI_ISA_SOURCE_UNCLASSIFIED'],
      'the AI care chain row (aiCare/words.ts)': chainLinkWords({ link: 11, effect: 'pause', code: 'AI_ISA_SOURCE_UNCLASSIFIED' }, VIEWER),
    };
    for (const [where, text] of Object.entries(words)) {
      expect(text, where).toMatch(UNREVIEWED);
      expect(text, where).not.toMatch(SETTING);
    }
    for (const where of ['a blocked message (reasons/sentences.ts)', 'an agent error (feed/lib/messages.ts)', 'an AI care refusal (aiCare/words.ts)']) expect(words[where], where).toMatch(/Owner reviews it under Lead sources/i);
    expect(words['a blocked message (reasons/sentences.ts)']).toMatch(/^Not sent: /);
    expect(words['a stage plan that did not start (StagePill.tsx)']).toMatch(/^Buyer plan didn't start: /);
    // the marked source keeps its own words, and the chain row of either reason is never "Another check"
    expect(messageStatus({ status: 'blocked', statusReason: 'SOURCE_NO_AUTOMATED_CONTACT', channel: 'sms' }, 'Ana')?.text).toMatch(/is marked "No automated contact for leads from this source"/);
    expect(pauseWords('source_no_ai_care')).toMatch(/is marked "No automated contact for leads from this source"/);
    expect(chainLinkWords({ link: 11, effect: 'pause', code: 'AI_ISA_SOURCE_NO_AI_CARE' }, VIEWER)).toMatch(/No automated contact for leads from this source/);
  });

  it('R-LSRC-9 E729: a refused approval of a draft a plan or an alert wrote is recognised for either code (the surfaces take Send away for both), with the server\'s sentence; any other refusal is not', () => {
    const sentence = 'This draft was written by a plan or an alert, and this person came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources), so it was withdrawn and nothing was sent. Call, text or email them one to one.';
    expect(automatedDraftRefusalWords('SOURCE_UNCLASSIFIED', { reason: 'source_unclassified', sentence })).toBe(sentence);
    expect(automatedDraftRefusalWords('SOURCE_UNCLASSIFIED', {})).toBe(AGENT_ERROR_MESSAGES['SOURCE_UNCLASSIFIED']);
    expect(automatedDraftRefusalWords('SOURCE_NO_AUTOMATED_CONTACT', {})).toBe(AGENT_ERROR_MESSAGES['SOURCE_NO_AUTOMATED_CONTACT']);
    expect(automatedDraftRefusalWords('DRAFT_STALE', { sentence })).toBeNull();
    expect(automatedDraftRefusalWords(undefined, null)).toBeNull();
  });
});
