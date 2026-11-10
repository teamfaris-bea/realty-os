import { describe, expect, it } from 'vitest';
import { instant } from '../foundation/index.js';
import {
  PAYMENT_BLOCK_SENTENCE,
  classifyHumanPurpose,
  containsName,
  containsOptOutHint,
  detectPaymentInstructions,
  nameTokens,
  renderedFacts,
} from './content.js';
import { canContact } from './gate.js';
import { NOW, days, gateInput, assistantInput, grantRow } from './testing/fixtures.js';

describe('detectPaymentInstructions (R-GATE-7)', () => {
  it.each([
    'Please wire the earnest money to the title company today',
    'wire to: First Bank',
    'Wire funds into the escrow account',
    'Here are the wire instructions for closing',
    'wiring details attached',
    'Routing number 021000021, account 12345678',
    'ABA # 021000021',
    'Account number: 1234-5678-9012',
    'acct # 99887766',
    'IBAN: DE89 3704 0044 0532 0130 00',
    'Send to GB82WEST12345698765432 by Friday',
    'SWIFT code DEUTDEFF',
    'swift: CHASUS33',
    'BIC code: COBADEFFXXX',
    'Use SWIFT CHASUS33XXX for the transfer',
    'Bank transfer to 021000021 please',
  ])('R-GATE-7 flags %j', (t) => {
    expect(detectPaymentInstructions(t)).toBe(true);
  });

  it.each([
    'Call me at 555-201-4433',
    'MLS# 123456789 just hit the market',
    'The house is wired for ethernet and has fiber wiring to the garage',
    'A swift closing is our goal!',
    'Your appointment is at 10am, zip 02139',
    'The account was updated in the portal',
    'Open house Saturday 1-3 pm',
    'Lot 021000021 in the subdivision', // a valid ABA checksum without any bank/wire context
    'DE00 1234 5678 9012 3456 78', // IBAN-shaped but fails the mod-97 check
    'The bank branch code 123456789 is on the form', // 9 digits in bank context, ABA checksum fails
  ])('R-GATE-7 does not flag %j', (t) => {
    expect(detectPaymentInstructions(t)).toBe(false);
  });

  it('R-GATE-7 the gate denies payment instructions for every initiator, with the safety sentence', () => {
    const rendered = renderedFacts('Wire the deposit to account 12345678', { channel: 'sms', brokerageLegalName: 'Acme Realty' });
    expect(rendered.paymentInstructions).toBe(true);
    for (const input of [gateInput({ rendered }), assistantInput({ rendered, consent: [grantRow({ level: 'express_written' })] })]) {
      const d = canContact(input);
      expect(d.outcome).toBe('deny');
      expect(d.reasons).toContain('PAYMENT_INSTRUCTIONS');
      expect(d.explanation).toContain(PAYMENT_BLOCK_SENTENCE.replace(/\.$/, ''));
    }
  });
});

describe('brokerage name and opt-out hints (R-GATE-12, R-CONSENT-18)', () => {
  it('name matching ignores case, punctuation and spacing but needs the whole name', () => {
    expect(nameTokens('Acme Realty, LLC')).toEqual(['acme', 'realty', 'llc']);
    expect(containsName('Listing by ACME REALTY LLC. Reply STOP to opt out.', 'Acme Realty, LLC')).toBe(true);
    expect(containsName('Listing by Acme', 'Acme Realty, LLC')).toBe(false);
    expect(containsName('Acme Realtyville', 'Acme Realty')).toBe(false);
    expect(containsName('anything', '  ')).toBe(false);
  });

  it('R-GATE-12 renderedFacts reports the brokerage name exactly as rendered', () => {
    expect(renderedFacts('New listing! — Acme Realty', { channel: 'sms', brokerageLegalName: 'Acme Realty' }).containsBrokerageName).toBe(true);
    expect(renderedFacts('New listing!', { channel: 'sms', brokerageLegalName: 'Acme Realty' }).containsBrokerageName).toBe(false);
    expect(renderedFacts('New listing! Acme Realty', { channel: 'sms', brokerageLegalName: null }).containsBrokerageName).toBe(false);
  });

  it('opt-out hints: SMS "Reply STOP", email "unsubscribe"; voice has none', () => {
    expect(containsOptOutHint('Reply STOP to opt out', 'sms')).toBe(true);
    expect(containsOptOutHint('Text "STOP" to end', 'sms')).toBe(true);
    expect(containsOptOutHint('stop to unsubscribe', 'sms')).toBe(true);
    expect(containsOptOutHint('Stop by Saturday', 'sms')).toBe(false);
    expect(containsOptOutHint('Unsubscribe: https://x.example/u', 'email')).toBe(true);
    expect(containsOptOutHint('See you soon', 'email')).toBe(false);
    expect(containsOptOutHint('Reply STOP', 'voice')).toBe(false);
  });
});

describe('classifyHumanPurpose (R-CONSENT-5 purpose classification)', () => {
  it('R-CONSENT-5 informational if the contact wrote in during the last 30 days or a deal/appointment context; else marketing', () => {
    expect(classifyHumanPurpose({ lastInboundAt: null, dealOrAppointmentContext: true, now: NOW })).toBe('informational');
    expect(classifyHumanPurpose({ lastInboundAt: instant(NOW - days(30)), dealOrAppointmentContext: false, now: NOW })).toBe('informational');
    expect(classifyHumanPurpose({ lastInboundAt: instant(NOW - days(30) - 1), dealOrAppointmentContext: false, now: NOW })).toBe('marketing');
    expect(classifyHumanPurpose({ lastInboundAt: null, dealOrAppointmentContext: false, now: NOW })).toBe('marketing');
    expect(classifyHumanPurpose({ lastInboundAt: instant(NOW + 1), dealOrAppointmentContext: false, now: NOW })).toBe('marketing');
  });
});
