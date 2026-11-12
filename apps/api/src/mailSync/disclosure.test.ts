// The connect disclosure the web shows is one the API accepts (module 69 ↔ 68; PHASE2_3_PLAN §5.4 #69: "a change of
// text changes the hash"), and its honest promises are in it word for word.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCEPTED_DISCLOSURE_SHA256, CURRENT_DISCLOSURE_SHA256 } from './disclosure.js';

const web = JSON.parse(readFileSync(new URL('../../../web/src/surfaces/settings/mail/disclosure.json', import.meta.url), 'utf8')) as { paragraphs: string[] };

describe('the Gmail connect disclosure (R-GMAIL-3, R-GMAIL-6, Q-GMAIL-5)', () => {
  it('R-GMAIL-6: the web text hashes to the current accepted disclosure; it says read-only, who can read, what Google shows, no AI', () => {
    const hash = createHash('sha256').update(web.paragraphs.join('\n\n')).digest('hex');
    expect(hash).toBe(CURRENT_DISCLOSURE_SHA256);
    expect(ACCEPTED_DISCLOSURE_SHA256).toContain(hash);
    const text = web.paragraphs.join(' ');
    expect(text).toContain('Read-only: Realty OS never sends, labels or deletes in your Gmail.');
    expect(text).toMatch(/Team Leads, Admins and the Owner/);
    expect(text).toContain('Google will show that Realty OS can read your email.');
    expect(text).toMatch(/Personal mail is never copied/);
    expect(text).toMatch(/Nothing is sent to an AI model/);
  });
});
