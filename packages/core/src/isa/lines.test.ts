// Batch 16 (R-GATE-12, R-CONSENT-18, R-ISA-8; docs/AI_ISA.md §7.3): every AI ISA message is stored as marketing, so
// every AI ISA email must carry what gate check 4 looks for: the brokerage name (the sign-off), the brokerage's postal
// address and an unsubscribe line. composeMessage adds the same unsubscribe line nurture adds (EMAIL_UNSUBSCRIBE_LINE,
// now in core/compliance so both the assistant and the AI ISA import it) and the postal address, to emails only; texts
// are unchanged. Check 4 is run here through the real gate (canContact) on the composed body.
import { describe, expect, it } from 'vitest';
import { EMAIL_UNSUBSCRIBE_LINE, canContact, containsOptOutHint, renderedFacts } from '../compliance/index.js';
import { H1, aiIsaInput } from '../compliance/testing/fixtures.js';
import { ISA_OPT_OUT_HINT, composeMessage, disclosureLine, signOffLine } from './lines.js';
import { WHO } from './testing/fixtures.js';

const POSTAL = '1 Sample St, Springfield, ST 00000';
const CHECK_4 = new Set(['BROKERAGE_IDENTITY_MISSING', 'POSTAL_ADDRESS_MISSING', 'UNSUBSCRIBE_MISSING', 'RENDERED_CONTENT_MISSING']);

/** Gate check 4's reasons for an AI ISA email with this body (every other check's reasons left out). */
function check4(body: string, o: { postalAddressPresent?: boolean } = {}): string[] {
  const d = canContact(
    aiIsaInput(
      {
        recipient: { kind: 'contact', addressHmac: H1, channel: 'email' },
        sender: { kind: 'email', registration: 'ready', domainVerified: true },
        tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: o.postalAddressPresent ?? true },
        rendered: renderedFacts(body, { channel: 'email', brokerageLegalName: WHO.brokerageName }),
      },
      { boundRecipientHmac: H1, allowedChannels: ['sms', 'email'] },
    ),
  );
  return d.reasons.filter((r) => CHECK_4.has(r));
}

// a plain reply, and the shape of a comps email (paragraphs, a statement, a source line, an MLS disclaimer)
const PLAIN = 'Thanks for writing. What part of town are you hoping to be in?';
const COMPS = [
  'Here are recent sales of homes like yours.',
  "Compared using your home's MLS record from Nov 13, 2026: 3 bd, 1,500 sq ft.",
  '1. Sold for $500,000 on Oct 1, 2026 (sale price) · 3 bd · Listed by Other Brokerage (test) · In the same subdivision.',
  'Only sales the MLS allows us to show are included.',
  'This is not an appraisal (test statement).',
  'Source: Test MLS feed via Maple Team, as of Nov 13, 2026.',
  'Listing information is deemed reliable but not guaranteed (test disclaimer).',
].join('\n\n');

describe('R-GATE-12 R-CONSENT-18 R-ISA-8 (batch 16): an AI ISA email carries the unsubscribe line and the postal address', () => {
  it('the unsubscribe line is the one nurture adds, word for word, and check 4 reads it as an unsubscribe', () => {
    expect(EMAIL_UNSUBSCRIBE_LINE).toBe('To unsubscribe from these emails, use the unsubscribe option your email app shows for this message.');
    expect(containsOptOutHint(EMAIL_UNSUBSCRIBE_LINE, 'email')).toBe(true);
    // the text hint alone is not an email unsubscribe (why every AI ISA email was refused before batch 16)
    expect(containsOptOutHint(ISA_OPT_OUT_HINT, 'email')).toBe(false);
  });

  for (const [name, core] of [['a plain reply', PLAIN], ['a comps email', COMPS]] as const) {
    it(`${name}: passes check 4 with the line, and check 4 refuses it (UNSUBSCRIBE_MISSING) without the line`, () => {
      for (const firstInThread of [true, false]) {
        for (const optOutHint of [true, false]) {
          const body = composeMessage({ body: core, who: WHO, firstInThread, optOutHint, channel: 'email', postalAddress: POSTAL });
          const at = [firstInThread, optOutHint];
          expect([at, body.split('\n\n').filter((x) => x === EMAIL_UNSUBSCRIBE_LINE).length]).toEqual([at, 1]);
          expect([at, body.split('\n\n').filter((x) => x === POSTAL).length]).toEqual([at, 1]);
          // the footer closes the email: the sign-off (brokerage name), the text hint when asked, the address, the line
          expect(body.endsWith(`${signOffLine(WHO)}${optOutHint ? `\n\n${ISA_OPT_OUT_HINT}` : ''}\n\n${POSTAL}\n\n${EMAIL_UNSUBSCRIBE_LINE}`)).toBe(true);
          expect(body.startsWith(firstInThread ? `${disclosureLine(WHO)}\n\n${core}` : core)).toBe(true);
          expect([at, check4(body)]).toEqual([at, []]);
          expect([at, check4(body.replace(`\n\n${EMAIL_UNSUBSCRIBE_LINE}`, ''))]).toEqual([at, ['UNSUBSCRIBE_MISSING']]);
        }
      }
    });
  }

  it('the postal address is the tenant\'s, trimmed; with none recorded the line is still added and check 4 refuses the email for the address (POSTAL_ADDRESS_MISSING)', () => {
    const padded = composeMessage({ body: PLAIN, who: WHO, firstInThread: false, optOutHint: false, channel: 'email', postalAddress: `  ${POSTAL}\n` });
    expect(padded).toBe(`${PLAIN}\n\n${signOffLine(WHO)}\n\n${POSTAL}\n\n${EMAIL_UNSUBSCRIBE_LINE}`);
    for (const none of [null, '', '   ']) {
      const body = composeMessage({ body: PLAIN, who: WHO, firstInThread: false, optOutHint: false, channel: 'email', postalAddress: none });
      expect(body).toBe(`${PLAIN}\n\n${signOffLine(WHO)}\n\n${EMAIL_UNSUBSCRIBE_LINE}`);
      expect(check4(body, { postalAddressPresent: false })).toEqual(['POSTAL_ADDRESS_MISSING']);
    }
  });

  it('texts are unchanged: no postal address and no unsubscribe line on an SMS', () => {
    for (const postalAddress of [POSTAL, null]) {
      expect(composeMessage({ body: 'What area are you looking in?', who: WHO, firstInThread: true, optOutHint: true, channel: 'sms', postalAddress })).toBe(
        "Hi, this is Avery's AI assistant at Example Realty LLC.\nWhat area are you looking in?\n— Avery's AI assistant, Example Realty LLC\nReply STOP to opt out.",
      );
      expect(composeMessage({ body: 'Thanks!', who: WHO, firstInThread: false, optOutHint: false, channel: 'sms', postalAddress })).toBe("Thanks!\n— Avery's AI assistant, Example Realty LLC");
    }
  });
});
