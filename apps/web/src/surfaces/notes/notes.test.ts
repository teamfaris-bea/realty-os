import { mentionTokens, parseMentions } from '@realty/core/parity/people';
import { describe, expect, it } from 'vitest';
import { contactSections } from '../contact/sections.js';
import { loggedLine } from './NotesSection.js';
import { mentionQuery, withTokens } from './NoteComposer.js';

const SAM = '00000000-0000-4000-8000-000000000002';

describe('web/notes (module 58)', () => {
  it('R-PAR-2 the box shows "@Name"; only picked members become tokens at save, labels never trusted', () => {
    const body = withTokens('call @Sam Lee about @Nobody', [{ userId: SAM, name: 'Sam Lee' }]);
    expect(mentionTokens(body).map((t) => t.userId)).toEqual([SAM]);
    expect(body).toContain('@Nobody');
    expect(parseMentions(body, { members: [SAM], self: 'x' })).toEqual({ ok: true, userIds: [SAM] });
  });
  it('the picker opens on "@" + a word at the caret only', () => {
    expect(mentionQuery('hi @sa', 6)).toEqual({ start: 3, query: 'sa' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    expect(mentionQuery('done', 4)).toBeNull();
  });
  it('R-PAR-30 a logged activity always reads "Logged by" and "not verified"', () => {
    expect(loggedLine({ loggedActivity: { kind: 'call', direction: 'outbound', at: '2026-11-11T00:00:00Z', outcome: 'no_answer', verified: false }, author: { userId: SAM, displayName: 'Sam Lee' } })).toBe('Outbound call · No answer · Logged by Sam Lee · not verified');
    expect(loggedLine({ loggedActivity: null, author: null })).toBeNull();
  });
  it('the contact page section registry holds the people sections', () => {
    expect(contactSections.map((s) => s.id)).toContain('people');
  });
});
