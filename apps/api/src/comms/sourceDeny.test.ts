// R-LSRC-9 A8: dispatch TX1's source decision cannot leave the restriction out of an automated send.
//
// There is no comms/decide.ts: the decision is comms/dispatch.ts `sourceDeny(m, refusalOf)`. The reader of the person's
// refusal is a REQUIRED argument, it is asked for every message of a judged class, and whatever it answers is the deny
// code. A person's one-to-one message is not judged, so it never reads the source (and never waits on it). TX1 is the
// only caller, and it hands the reader over (`noAutomatedContact` for the message's contact).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isAutomatedContact, sourceDeny } from './dispatch.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const one = { isaMessage: false, isaEnded: false, automated: false, automatedDraft: false };

describe('R-LSRC-9 A8: the source restriction is impossible to omit for an automated send (dispatch TX1)', () => {
  it('every judged class asks the reader and denies with exactly what it answers; a one-to-one message never asks', async () => {
    for (const refusal of ['SOURCE_NO_AUTOMATED_CONTACT', 'SOURCE_UNCLASSIFIED', null] as const) {
      const judged = [
        { ...one, automated: true }, // an assistant, system or bulk message
        { ...one, automatedDraft: true }, // an approved draft a plan step or a trigger wrote
        { ...one, isaMessage: true, isaEnded: true }, // an ended AI care assignment's pending confirmation or holding line
      ];
      for (const m of judged) {
        const reader = vi.fn(async () => refusal);
        expect(await sourceDeny(m, reader), JSON.stringify(m)).toBe(refusal);
        expect(reader).toHaveBeenCalledTimes(1);
      }
      // a live assignment's AI message is refused by its own chain (link 11), not twice here; a person's own message is not judged
      for (const m of [one, { ...one, isaMessage: true, isaEnded: false, automated: true }]) {
        const reader = vi.fn(async () => refusal);
        expect(await sourceDeny(m, reader), JSON.stringify(m)).toBeNull();
        expect(reader).not.toHaveBeenCalled();
      }
    }
  });

  it('the automated classes are the marked-source rule\'s, no wider and no narrower: a bulk send, an invite, an assistant message no person approved and any system message but the three answers the person asked for', () => {
    const m = (o: Partial<{ initiator: string; actionCategory: string; bulkActionId: string | null; marketingPieceId: string | null }>) => ({ initiator: 'human', actionCategory: 'none', bulkActionId: null, marketingPieceId: null, ...o });
    expect(isAutomatedContact(m({}), 'human')).toBe(false);
    expect(isAutomatedContact(m({ bulkActionId: 'b' }), 'human')).toBe(true);
    expect(isAutomatedContact(m({ marketingPieceId: 'p' }), 'human')).toBe(true);
    expect(isAutomatedContact(m({ initiator: 'assistant' }), 'assistant')).toBe(true);
    expect(isAutomatedContact(m({ initiator: 'assistant' }), 'human')).toBe(false); // a person-approved reply draft
    for (const c of ['opt_out_confirmation', 'help_reply', 'portal_login_link']) expect(isAutomatedContact(m({ initiator: 'system', actionCategory: c }), 'system'), c).toBe(false);
    for (const c of ['search_alert', 'nurture_step', 'speed_to_lead_reply', 'none']) expect(isAutomatedContact(m({ initiator: 'system', actionCategory: c }), 'system'), c).toBe(true);
  });

  it('TX1 is the only caller, and it passes the reader of the recipient\'s refusal', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const callers = files
      .map((f) => ({ f: f.replace(/\\/g, '/'), calls: readFileSync(`${SRC}/${f}`, 'utf8').match(/(?<!function )\bsourceDeny\([^\n]*/g) ?? [] }))
      .filter((x) => x.calls.length > 0);
    expect(callers.map((c) => c.f)).toEqual(['comms/dispatch.ts']);
    expect(callers[0]!.calls).toHaveLength(1);
    expect(callers[0]!.calls[0]).toMatch(/sourceDeny\(\{ isaMessage: isaMsg, isaEnded: isaTx1\?\.ended === true, automated: isAutomatedContact\(m, gateInitiator\), automatedDraft \}, \(\) => noAutomatedContact\(tx, m\.contactId\)\)/);
  });
});
