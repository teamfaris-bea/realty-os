// Copy snapshot of the Gmail connect disclosure (module 69). A change of any word changes the hash the
// connect request carries, which the API checks (apps/api/src/mailSync/disclosure.ts): update both, with
// counsel (C14), and this test.
import { describe, expect, it } from 'vitest';
import { DISCLOSURE_PARAGRAPHS, DISCLOSURE_TITLE, disclosureSha256, disclosureText } from './disclosure.js';

describe('Gmail connect disclosure', () => {
  it('copy snapshot: the title and paragraphs, word for word', () => {
    expect({ title: DISCLOSURE_TITLE, paragraphs: DISCLOSURE_PARAGRAPHS }).toEqual({
      title: 'Connect your Gmail (read-only)',
      paragraphs: [
        'Read-only: Realty OS never sends, labels or deletes in your Gmail.',
        'What is copied: only mail between you and the clients you confirm on the next screen. Personal mail is never copied.',
        "Who can read it: anyone who may see that client's timeline in Realty OS, including Team Leads, Admins and the Owner.",
        'What Google will show: Google will show that Realty OS can read your email. Realty OS checks the sender and recipients of each new message and copies only mail with your clients.',
        'Nothing is sent to an AI model. Synced mail is never used to write messages.',
        "You stay in control: remove any thread from Realty OS, stop syncing an address, or disconnect at any time. Disconnecting removes your copies from Realty OS within a few minutes; backup copies expire on their own schedule.",
      ],
    });
  });

  it('the hash covers the paragraphs joined by two newlines', () => {
    expect(disclosureText()).toBe(DISCLOSURE_PARAGRAPHS.join('\n\n'));
  });

  it('the Web Crypto SHA-256 of the shown text is the hash the API accepts', async () => {
    expect(await disclosureSha256()).toBe('1d9347110274a0e0b89f80662c6580d8aa7f231795374431f059312c77f3c268');
  });

  it('one changed character changes the hash', async () => {
    const changed = DISCLOSURE_PARAGRAPHS.map((p, i) => (i === 0 ? p.replace('never', 'nevr') : p));
    expect(await disclosureSha256(changed)).not.toBe(await disclosureSha256());
  });
});
