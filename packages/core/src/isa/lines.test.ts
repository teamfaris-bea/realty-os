// The AI ISA's server-added parts of an email (docs/AI_ISA.md §7.3; R-ISA-7, R-GATE-12, R-CONSENT-18). Every AI ISA
// message is marketing, so gate check 4 reads every AI email for the brokerage name and an unsubscribe mechanism. These
// tests give the gate the REAL composed text (renderedFacts, as comms/gateInput.ts does), never a fixture's flags.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canContact, renderedFacts } from '../compliance/index.js';
import { aiIsaInput, H1 } from '../compliance/testing/fixtures.js';
import { aiIdentityMissing } from './guard.js';
import { composeMessage, EMAIL_FOOTER_SEPARATOR, fillLine, ISA_LINE_IDS, ISA_OPT_OUT_HINT, type IsaEmailFooter, withoutEmailFooter } from './lines.js';
import { WHO } from './testing/fixtures.js';

const URL_ = 'https://app.example.test/api/email/unsubscribe/AAAA.BBBB';
const FOOTER: IsaEmailFooter = { postalAddress: '1 Main St, Springfield, IL 62701', unsubscribeUrl: URL_ };

const emailGate = (text: string, o: { postal?: boolean } = {}) =>
  canContact(aiIsaInput({
    recipient: { kind: 'contact', addressHmac: H1, channel: 'email' },
    sender: { kind: 'email', registration: 'ready', domainVerified: true },
    tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: o.postal ?? true },
    rendered: renderedFacts(text, { channel: 'email', brokerageLegalName: WHO.brokerageName }),
  }));

describe('R-CONSENT-18 R-GATE-12: every AI email carries the footer gate check 4 reads', () => {
  it('the email form ends with the brokerage name, its postal address and the message\'s own unsubscribe link', () => {
    const first = composeMessage({ body: 'What area are you looking in?', who: WHO, firstInThread: true, channel: 'email', footer: FOOTER });
    expect(first).toBe([
      "Hi, this is Avery's AI assistant at Example Realty LLC.",
      '',
      'What area are you looking in?',
      '',
      "— Avery's AI assistant, Example Realty LLC",
      '',
      '--',
      'Example Realty LLC',
      '1 Main St, Springfield, IL 62701',
      `Unsubscribe: ${URL_}`,
    ].join('\n'));
    expect(aiIdentityMissing(first, WHO, true)).toBe(false);
  });

  it('the composed email passes check 4 as it is; the same email without the footer is refused UNSUBSCRIBE_MISSING', () => {
    const text = composeMessage({ body: 'Thanks!', who: WHO, firstInThread: false, channel: 'email', footer: FOOTER });
    expect(emailGate(text).reasons).toEqual([]);
    expect(emailGate(withoutEmailFooter(text)).reasons).toEqual(['UNSUBSCRIBE_MISSING']);
  });

  it('any body, first or later, and every fixed line: the email has the unsubscribe hint and the brokerage name; check 4 allows it', () => {
    const bodies = fc.oneof(fc.string({ minLength: 1, maxLength: 400 }).filter((s) => s.trim() !== ''), fc.constantFrom(...ISA_LINE_IDS).map((id) => fillLine(id, WHO)));
    fc.assert(fc.property(bodies, fc.boolean(), (body, firstInThread) => {
      const text = composeMessage({ body, who: WHO, firstInThread, channel: 'email', footer: FOOTER });
      const facts = renderedFacts(text, { channel: 'email', brokerageLegalName: WHO.brokerageName });
      expect(facts.containsOptOutHint).toBe(true);
      expect(facts.containsBrokerageName).toBe(true);
      expect(text.endsWith(`Unsubscribe: ${URL_}`)).toBe(true);
      expect(emailGate(text).reasons).not.toContain('UNSUBSCRIBE_MISSING');
    }), { numRuns: 200 });
  });

  it('no postal address set: the line is left out (never invented); the gate then refuses POSTAL_ADDRESS_MISSING, not the unsubscribe', () => {
    const text = composeMessage({ body: 'Thanks!', who: WHO, firstInThread: false, channel: 'email', footer: { postalAddress: '  ', unsubscribeUrl: URL_ } });
    expect(text).toBe(`Thanks!\n\n— Avery's AI assistant, Example Realty LLC${EMAIL_FOOTER_SEPARATOR}Example Realty LLC\nUnsubscribe: ${URL_}`);
    expect(emailGate(text, { postal: false }).reasons).toEqual(['POSTAL_ADDRESS_MISSING']);
  });

  it('honest copy: "Reply STOP" is a text hint only; an email never promises it (a quoted email reply of STOP is not recognized)', () => {
    const email = composeMessage({ body: 'Hi', who: WHO, firstInThread: true, channel: 'email', footer: FOOTER });
    expect(email).not.toContain(ISA_OPT_OUT_HINT);
    expect(composeMessage({ body: 'Hi', who: WHO, firstInThread: true, optOutHint: true, channel: 'sms' }).endsWith(`\n${ISA_OPT_OUT_HINT}`)).toBe(true);
    expect(composeMessage({ body: 'Hi', who: WHO, firstInThread: false, optOutHint: false, channel: 'sms' })).not.toMatch(/unsubscribe|STOP/i);
  });
});

describe('R-ISA-20: the model sees an outbound email without its footer', () => {
  it('withoutEmailFooter drops the footer and its link; a text, or an email without a footer, is unchanged', () => {
    const text = composeMessage({ body: 'A line\n\n--\nthat the agent wrote', who: WHO, firstInThread: false, channel: 'email', footer: FOOTER });
    const seen = withoutEmailFooter(text);
    expect(seen).toBe("A line\n\n--\nthat the agent wrote\n\n— Avery's AI assistant, Example Realty LLC");
    expect(seen).not.toContain(URL_);
    expect(withoutEmailFooter('Thanks!\n— Avery')).toBe('Thanks!\n— Avery');
  });
});
