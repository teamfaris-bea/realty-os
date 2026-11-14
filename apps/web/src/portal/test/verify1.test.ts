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

const repo = resolve(__dirname, '../../../../..');
const MARKER = "module 46's client-facing words (VERIFY 1";

/** The one doc line that carries the VERIFY 1 list. */
function verifyLine(doc: string): string {
  const lines = readFileSync(resolve(repo, 'docs', doc), 'utf8').split('\n').filter((l) => l.includes(MARKER));
  expect(lines, `${doc}: one line names ${MARKER}`).toHaveLength(1);
  return lines[0]!;
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
  previewVisible('{name}'),
  previewHidden('{name}', '{reason}'),
];

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
