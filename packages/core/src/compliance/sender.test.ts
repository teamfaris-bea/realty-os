import { describe, expect, it } from 'vitest';
import type { PhoneNumberId } from '../foundation/index.js';
import { canContact } from './gate.js';
import { type NumberFacts, chooseSender, emailSenderFacts, phoneSenderFacts, registrationOf } from './sender.js';
import { assistantInput, gateInput, grantRow } from './testing/fixtures.js';

const num = (id: string, o: Partial<NumberFacts> = {}): NumberFacts => ({
  id: id as PhoneNumberId,
  numberType: 'local',
  smsCapable: true,
  voiceCapable: true,
  released: false,
  registrationStatus: 'approved',
  ...o,
});

describe('chooseSender (R-CONSENT-17)', () => {
  const sticky = num('sticky');
  const owner = num('owner');
  const team = num('team');

  it('prefers the sticky number, then the owner direct number, then the team main number', () => {
    expect(chooseSender({ stickyNumber: sticky, ownerDirect: owner, teamMain: team, firstResponse: false })).toBe(sticky);
    expect(chooseSender({ ownerDirect: owner, teamMain: team, firstResponse: false })).toBe(owner);
    expect(chooseSender({ teamMain: team, firstResponse: false })).toBe(team);
    expect(chooseSender({ firstResponse: false })).toBeNull();
  });

  it('the 60-second first response goes from the team number, not an agent number', () => {
    expect(chooseSender({ ownerDirect: owner, teamMain: team, firstResponse: true })).toBe(team);
    expect(chooseSender({ stickyNumber: sticky, ownerDirect: owner, teamMain: team, firstResponse: true })).toBe(sticky);
    expect(chooseSender({ ownerDirect: owner, firstResponse: true })).toBeNull();
  });

  it('R-CONSENT-17 E46 no automatic fallback: an unregistered or suspended chosen number is returned so the gate blocks it', () => {
    const suspended = num('sticky', { registrationStatus: 'suspended' });
    const chosen = chooseSender({ stickyNumber: suspended, ownerDirect: owner, teamMain: team, firstResponse: false });
    expect(chosen).toBe(suspended);
    const d = canContact(gateInput({ sender: phoneSenderFacts(chosen) }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toContain('SENDER_NOT_REGISTERED');
    const a = canContact(assistantInput({ sender: phoneSenderFacts(chosen), consent: [grantRow({ level: 'express_written' })] }));
    expect(a.outcome).toBe('deny');
    expect(a.reasons).toContain('SENDER_NOT_REGISTERED');
  });

  it('skips only numbers that cannot serve the thread (released, not SMS-capable)', () => {
    expect(chooseSender({ stickyNumber: num('s', { released: true }), ownerDirect: owner, firstResponse: false })).toBe(owner);
    expect(chooseSender({ stickyNumber: num('s', { smsCapable: false }), teamMain: team, firstResponse: false })).toBe(team);
  });

  it('R-CONSENT-17 only approved (10DLC) / verified (toll-free) registrations are ready', () => {
    expect(registrationOf('approved')).toBe('ready');
    expect(registrationOf('draft')).toBe('pending');
    expect(registrationOf('submitted')).toBe('pending');
    for (const s of ['rejected', 'suspended', 'none'] as const) expect(registrationOf(s)).toBe('blocked');
    expect(phoneSenderFacts(num('tf', { numberType: 'toll_free', registrationStatus: 'approved' }))).toEqual({ kind: 'phone', registration: 'ready' });
    expect(phoneSenderFacts(num('r', { released: true }))).toEqual({ kind: 'phone', registration: 'blocked' });
    expect(phoneSenderFacts(null)).toBeNull();
    for (const registration of ['pending', 'blocked'] as const) {
      expect(canContact(gateInput({ sender: { kind: 'phone', registration } })).reasons).toContain('SENDER_NOT_REGISTERED');
    }
  });
});

describe('emailSenderFacts (R-CONSENT-18)', () => {
  it('R-CONSENT-18 one-to-one email may use the shared domain; marketing needs the verified own domain', () => {
    const shared = emailSenderFacts({ status: 'active', domain: null });
    expect(shared).toEqual({ kind: 'email', registration: 'ready', domainVerified: false });
    const email = { recipient: { kind: 'contact' as const, addressHmac: grantRow().addressHmac, channel: 'email' as const } };
    expect(canContact(gateInput({ ...email, sender: shared, consent: [] })).outcome).toBe('allow');
    const mkt = canContact(gateInput({ ...email, sender: shared, consent: [], purpose: 'marketing' }));
    expect(mkt.outcome).toBe('deny');
    expect(mkt.reasons).toContain('EMAIL_DOMAIN_UNVERIFIED');
    const own = emailSenderFacts({ status: 'active', domain: { verifiedAt: new Date(0) } });
    expect(own?.domainVerified).toBe(true);
    expect(canContact(gateInput({ ...email, sender: own, consent: [], purpose: 'marketing' })).outcome).toBe('allow');
    expect(emailSenderFacts({ status: 'active', domain: { verifiedAt: null } })?.domainVerified).toBe(false);
    expect(emailSenderFacts({ status: 'disabled', domain: null })?.registration).toBe('blocked');
    expect(emailSenderFacts(null)).toBeNull();
  });
});
