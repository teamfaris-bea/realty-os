// @vitest-environment node
// module 46, b15 audit F2: VERIFY 1 (counsel sees the client-facing words before the per-deployment platform:portal
// record) is written where the person recording clearance reads: the PHASE2_3_PLAN #### 46 Built section and DEPLOY
// §10.1 beside the D11 portal row. Each lists the words as built, verbatim, so a changed sentence fails here until the
// list (and so what counsel is shown) changes with it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_SENTENCES, COPY } from '../copy.js';
import { VIEW_WORDS, previewHidden, previewVisible, sharedOn, visibleUntil } from '../view/words.js';
import { PORTAL_STAFF_MESSAGES, STAFF_WORDS } from '../../surfaces/client-portal/words.js';
import { copyConstant, copyEntry, portalCopySource } from './portalContract.js';

const repo = resolve(__dirname, '../../../../..');
const MARKER = "module 46's client-facing words (VERIFY 1";
/** b18 item c (OQ-1114-8): the staff list, a separate line of the same counsel packet */
const STAFF_MARKER = 'the staff-side sentences about what is shared and sent (VERIFY 1 staff list';

/** The one doc line that carries the VERIFY 1 list (or its staff list). */
function verifyLine(doc: string, marker = MARKER): string {
  const lines = readFileSync(resolve(repo, 'docs', doc), 'utf8').split('\n').filter((l) => l.includes(marker));
  expect(lines, `${doc}: one line names ${marker}`).toHaveLength(1);
  return lines[0]!;
}

/** One of 45's one-argument sentence functions (`export const name = (first: string): string => `…${first}…`;`), as text. */
function copyTemplate(name: string, hole = '{first}'): string {
  const m = new RegExp(`export const ${name} = \\((\\w+): string\\): string => \`([^\`]*)\`;`).exec(portalCopySource);
  if (!m) throw new Error(`${name} is not a one-argument sentence of 45's copy.ts`);
  return m[2]!.replaceAll(`\${${m[1]!}}`, hole);
}

export const VERIFY_1_WORDS: readonly string[] = [
  COPY.signedOutTitle,
  COPY.signedOutBody,
  VIEW_WORDS.nothingShared,
  visibleUntil('{date}'),
  sharedOn('{date}'),
  COPY.unavailableTitle,
  API_SENTENCES.PORTAL_NOT_AVAILABLE,
  COPY.nothingSent,
  // b16 (L16-1): the sign-in page's answers when texting or email is off, which batch 16 (smsOff) and batch 15 F11
  // (emailOff) reworded; counsel sees them before platform:portal is recorded
  COPY.smsOff,
  COPY.emailOff,
  previewVisible('{name}'),
  previewHidden('{name}', '{reason}'),
];

/**
 * b18 item c (OQ-1114-8, owner queued recommendation 2026-11-14): the staff-side sentences that say what is shared
 * with the client and what is sent (module 45's grant lines and repeat-invite answers, module 46's section lines), a
 * SEPARATE staff list of the counsel packet: a lost deal, ended access, shared while the portal is off, the repeat
 * invites, a deleted contact, and batch 18 item b's off-state action.
 */
export const VERIFY_1_STAFF_WORDS: readonly string[] = [
  PORTAL_STAFF_MESSAGES.PORTAL_DEAL_LOST!,
  copyEntry('NOT_VISIBLE', 'LAPSED'),
  copyConstant('LIVE_PORTAL_OFF'),
  copyTemplate('inviteNotSent'),
  copyTemplate('inviteNoNotice'),
  copyTemplate('inviteNoteInFlight'),
  copyTemplate('inviteNoteNotReached'),
  copyEntry('NOT_VISIBLE', 'CONTACT_DELETED'),
  STAFF_WORDS.contactDeleted('{name}'),
  STAFF_WORDS.prepare,
  STAFF_WORDS.portalOffNothingSent,
];

describe('b18 item c (OQ-1114-8): VERIFY 1 carries the staff-side sentences as a separate staff list', () => {
  it('the staff list holds the sentences as 45 and 46 write them', () => {
    expect(VERIFY_1_STAFF_WORDS).toContain("This deal is marked lost, so its client can't be invited to the portal.");
    expect(VERIFY_1_STAFF_WORDS).toContain('This access has ended, so the client no longer sees it.');
    expect(VERIFY_1_STAFF_WORDS).toContain('Shared; the client sees it once the client portal is turned on.');
    expect(VERIFY_1_STAFF_WORDS).toContain('{first} was already invited; no second note was sent.');
    expect(VERIFY_1_STAFF_WORDS).toContain("{name}'s record is deleted, so they can't be invited until it is restored.");
  });
  for (const doc of ['PHASE2_3_PLAN.md', 'DEPLOY.md']) {
    it(`${doc}: one staff-list line holds every staff sentence verbatim, apart from the client list, for platform:portal`, () => {
      const staff = verifyLine(doc, STAFF_MARKER);
      expect(VERIFY_1_STAFF_WORDS.filter((w) => !staff.includes(`"${w}"`))).toEqual([]);
      expect(staff).toMatch(/platform:portal/);
      expect(staff).toMatch(/staff only|never shown to the client/);
      // a separate list: the client line does not carry the staff sentences, and the staff line is not the client line
      const client = verifyLine(doc);
      expect(client).not.toBe(staff);
      expect(VERIFY_1_STAFF_WORDS.filter((w) => client.includes(`"${w}"`))).toEqual([]);
    });
  }
});

describe('b15 audit F2: VERIFY 1 names module 46\'s client-facing words where clearance is recorded', () => {
  for (const doc of ['PHASE2_3_PLAN.md', 'DEPLOY.md']) {
    it(`${doc}: the list holds every word as built, verbatim, and says dates show no done mark`, () => {
      const line = verifyLine(doc);
      expect(VERIFY_1_WORDS.filter((w) => !line.includes(`"${w}"`))).toEqual([]);
      expect(line).toMatch(/no done mark/);
      expect(line).toMatch(/platform:portal/);
    });
  }
});
