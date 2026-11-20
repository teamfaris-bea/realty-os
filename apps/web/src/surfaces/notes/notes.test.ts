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
  it('R-PAR-30 R-TODAY-4 a logged activity always reads "Logged by" and "not verified", in the words Today uses: whose phone, what came of it, and "you" for the viewer’s own', () => {
    const note = { loggedActivity: { kind: 'call', direction: 'outbound', at: '2026-11-11T00:00:00Z', outcome: 'no_answer', verified: false as const }, author: { userId: SAM, displayName: 'Sam Lee' } };
    expect(loggedLine(note)).toBe('Logged by Sam Lee: called from their phone, no answer · not verified');
    expect(loggedLine(note, SAM)).toBe('Logged by you: called from your phone, no answer · not verified');
    expect(loggedLine({ ...note, loggedActivity: { ...note.loggedActivity, outcome: 'left_voicemail' } }, SAM)).toBe('Logged by you: called from your phone, left a voicemail · not verified');
    expect(loggedLine({ ...note, loggedActivity: { ...note.loggedActivity, kind: 'text', direction: 'inbound', outcome: null } })).toBe('Logged by Sam Lee: they texted their phone · not verified');
    // whatever is logged, the line starts "Logged by" and ends "not verified": it can never read as a call the system placed
    for (const kind of ['call', 'text', 'email']) for (const direction of ['outbound', 'inbound']) for (const outcome of [null, 'connected', 'other']) expect(loggedLine({ ...note, loggedActivity: { ...note.loggedActivity, kind, direction, outcome } })).toMatch(/^Logged by Sam Lee: .+ · not verified$/);
    expect(loggedLine({ loggedActivity: null, author: null })).toBeNull();
  });
  it('the contact page section registry holds the people sections', () => {
    expect(contactSections.map((s) => s.id)).toContain('people');
  });
});
