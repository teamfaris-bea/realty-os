import { describe, expect, it } from 'vitest';
import { channelState } from './useReachability.js';
import { isHeld, messageStatus, providerCodeSentence, reachSentence, shortDate } from './sentences.js';
import type { ChannelReach, ReachReason, Reachability } from './types.js';

const NOW = new Date('2026-11-12T18:00:00');
const NOV10 = new Date('2026-11-10T20:46:00').toISOString();
const OCT3 = new Date('2026-10-03T15:00:00').toISOString();

function reason(o: Partial<ReachReason>): ReachReason {
  return {
    code: 'CONSENT_REVOKED',
    source: 'keyword',
    purposes: ['informational', 'marketing'],
    at: NOV10,
    keyword: 'STOP',
    recordedBy: null,
    importBatchId: null,
    suppressionReason: null,
    addressHint: '•••-•••-0101',
    otherAddress: false,
    evidence: { consentEventId: null, inboundMessageId: null, callId: null, suppressionId: null },
    ...o,
  };
}

describe('reachSentence: the exact words for each opt-out source', () => {
  it.each<[string, Partial<ReachReason>, 'sms' | 'voice' | 'email', string]>([
    ['STOP texted', {}, 'sms', 'Texted STOP on Nov 10'],
    ['another keyword', { keyword: 'UNSUBSCRIBE' }, 'sms', 'Texted UNSUBSCRIBE on Nov 10'],
    // the masked number never breaks across lines (non-breaking hyphens)
    ['STOP from another phone', { otherAddress: true, addressHint: '•••-•••-4821' }, 'sms', 'Texted STOP from •••\u2011•••\u20114821 on Nov 10'],
    // R-PAR-12: a phone removed from the person whose STOP still blocks them is said to be the removed number
    ['STOP from a removed phone', { otherAddress: true, addressRemoved: true, addressHint: '•••-•••-7385' }, 'sms', 'Texted STOP from •••\u2011•••\u20117385 (removed number) on Nov 10'],
    ['email unsubscribe (marketing)', { source: 'unsubscribe', keyword: null, purposes: ['marketing'], at: OCT3 }, 'email', 'Unsubscribed from marketing email on Oct 3'],
    ['email unsubscribe (all)', { source: 'unsubscribe', keyword: null, at: OCT3 }, 'email', 'Unsubscribed from email on Oct 3'],
    ['agent-recorded do-not-call', { source: 'agent_recorded', keyword: null, at: OCT3, recordedBy: { userId: 'u', displayName: 'Avery Brooks' } }, 'voice', 'Asked not to be called (recorded by Avery Brooks on Oct 3)'],
    ['do-not-call from a call outcome', { source: 'call_outcome', keyword: null, at: OCT3, recordedBy: { userId: 'u', displayName: 'Avery Brooks' } }, 'voice', 'Asked not to be called (recorded by Avery Brooks on Oct 3)'],
    ['agent-recorded do-not-text', { source: 'agent_recorded', keyword: null, at: OCT3, recordedBy: { userId: 'u', displayName: 'Avery Brooks' } }, 'sms', 'Asked not to be texted (recorded by Avery Brooks on Oct 3)'],
    ['opt-out in words', { source: 'opt_out_language', keyword: null }, 'sms', 'Asked by text to stop getting texts on Nov 10'],
    ['carrier report', { source: 'provider_report', keyword: null }, 'sms', 'The carrier reported they opted out on Nov 10'],
    ['imported opt-out', { source: 'imported', keyword: null, at: OCT3 }, 'sms', 'Opted out of texts in your previous system on Oct 3 (imported)'],
    ['unknown source (ledger not visible)', { source: 'other', keyword: null, at: null }, 'email', 'Opted out of email'],
    ['bounce', { code: 'SUPPRESSED', source: 'suppression', suppressionReason: 'hard_bounce', at: OCT3 }, 'email', 'Email to this address bounced on Oct 3'],
    ['spam complaint', { code: 'SUPPRESSED', source: 'suppression', suppressionReason: 'spam_complaint', at: OCT3 }, 'email', 'Marked an email as spam on Oct 3'],
    ['imported do-not-contact', { code: 'SUPPRESSED', source: 'imported', suppressionReason: 'import_dnc', at: OCT3 }, 'voice', 'Marked do-not-contact in your previous system (imported Oct 3)'],
    ['unknown suppression', { code: 'SUPPRESSED', source: 'suppression', suppressionReason: 'something_new', at: null }, 'sms', 'Blocked for texts'],
    ['wrong number', { code: 'WRONG_NUMBER', source: 'contact_point' }, 'voice', 'Marked as a wrong number'],
    ['landline', { code: 'LANDLINE_NO_SMS', source: 'contact_point' }, 'sms', "This number is a landline and can't get texts"],
    ['bad email', { code: 'CONTACT_POINT_INVALID', source: 'contact_point' }, 'email', "This email address isn't working"],
  ])('%s', (_n, o, ch, text) => {
    expect(reachSentence(reason(o), ch, NOW)).toBe(text);
  });

  it('dates outside the current year carry the year', () => {
    expect(shortDate('2025-03-04T12:00:00Z', NOW)).toBe('Mar 4, 2025');
  });
});

describe('messageStatus: what the thread says under a message that did not simply go out', () => {
  it('a blocked text names the opt-out it rested on', () => {
    expect(messageStatus({ status: 'blocked', statusReason: 'CONSENT_REVOKED', blockedBy: reason({}), channel: 'sms' }, 'Owen', NOW)).toEqual({ text: 'Not sent: texted STOP on Nov 10', tone: 'failed' });
  });
  it('a blocked message without evidence still says why, never a code', () => {
    expect(messageStatus({ status: 'blocked', statusReason: 'SENDER_NOT_AUTHORIZED', channel: 'sms' }, 'Owen')!.text).toBe('Not sent: you no longer handle this contact');
    expect(messageStatus({ status: 'blocked', statusReason: 'CONSENT_REVOKED', channel: 'email' }, 'Owen')!.text).toBe('Not sent: opted out of email');
    expect(messageStatus({ status: 'blocked', statusReason: 'SOMETHING_NEW', channel: 'sms' }, 'Owen')!.text).toBe('Not sent: blocked by a sending rule');
  });
  it('R-PAR-12: a send the dispatch guard refused reads like the gate’s own opt-out, never "a sending rule"', () => {
    // no evidence in the stored inputs (the app gate and the guard disagreed): the same words as CONSENT_REVOKED
    expect(messageStatus({ status: 'blocked', statusReason: 'RECIPIENT_OPTED_OUT', channel: 'sms' }, 'Ana')).toEqual({ text: 'Not sent: opted out of texts', tone: 'failed' });
    expect(messageStatus({ status: 'blocked', statusReason: 'RECIPIENT_OPTED_OUT', channel: 'mms' }, 'Ana')!.text).toBe('Not sent: opted out of texts');
    expect(messageStatus({ status: 'blocked', statusReason: 'RECIPIENT_OPTED_OUT', channel: 'email' }, 'Ana')!.text).toBe('Not sent: opted out of email');
    expect(messageStatus({ status: 'blocked', statusReason: 'RECIPIENT_NOT_A_CONTACT_POINT', channel: 'sms' }, 'Ana')).toEqual({ text: "Not sent: the number or address isn't on their record, so their opt-outs couldn't be checked", tone: 'failed' });
    // with evidence, the opt-out it rested on is named, as for any blocked send
    expect(messageStatus({ status: 'blocked', statusReason: 'RECIPIENT_OPTED_OUT', blockedBy: reason({}), channel: 'sms' }, 'Ana', NOW)!.text).toBe('Not sent: texted STOP on Nov 10');
  });
  it('R-CHAN-2 R-PAR-12: the guards’ person-level do-not-contact and suppression refusals read exactly like the gate’s own reasons for the same fact, never "a sending rule"', () => {
    for (const channel of ['sms', 'email', 'mms']) {
      const said = (statusReason: string) => messageStatus({ status: 'blocked', statusReason, channel }, 'Ana')!;
      // the same fact, said the same way: the guard's code and the gate's code give one sentence
      expect(said('RECIPIENT_SUPPRESSED')).toEqual(said('SUPPRESSED'));
      expect(said('RECIPIENT_OPTED_OUT')).toEqual(said('CONSENT_REVOKED'));
      expect(said('RECIPIENT_SUPPRESSED')).toEqual({ text: 'Not sent: the address is blocked (bounce, complaint or do-not-contact)', tone: 'failed' });
      // PERSON_DO_NOT_CONTACT is one code for the gate and both guards
      expect(said('PERSON_DO_NOT_CONTACT')).toEqual({ text: 'Not sent: they asked not to be contacted', tone: 'failed' });
      for (const code of ['RECIPIENT_SUPPRESSED', 'PERSON_DO_NOT_CONTACT', 'SUPPRESSED', 'RECIPIENT_OPTED_OUT', 'RECIPIENT_NOT_A_CONTACT_POINT']) expect(said(code).text).not.toMatch(/sending rule|[A-Z]{2,}_/);
    }
    // a key of Object.prototype is no code: it gets the honest generic sentence
    expect(messageStatus({ status: 'blocked', statusReason: 'constructor', channel: 'sms' }, 'Ana')!.text).toBe('Not sent: blocked by a sending rule');
  });
  it('an undelivered text says the carrier rejected it, naming a known carrier code', () => {
    expect(messageStatus({ status: 'undelivered', statusReason: 'PROVIDER_UNDELIVERED', providerErrorCode: '30008', channel: 'sms' }, 'Owen')!.text).toBe('Not delivered: the carrier rejected it');
    expect(messageStatus({ status: 'undelivered', statusReason: 'PROVIDER_UNDELIVERED', providerErrorCode: '99999', channel: 'sms' }, 'Owen')!.text).toBe('Not delivered: the carrier rejected it');
    expect(messageStatus({ status: 'failed', statusReason: 'PROVIDER_OPTED_OUT', providerErrorCode: '21610', channel: 'sms' }, 'Owen')!.text).toBe('Not delivered: they had opted out with the carrier');
    expect(messageStatus({ status: 'failed', statusReason: 'PROVIDER_REJECTED', channel: 'email' }, 'Owen')!.text).toBe('Not delivered: the email service rejected it');
    expect(messageStatus({ status: 'failed', statusReason: 'PROVIDER_REJECTED', channel: 'sms' }, 'Liam')!.text).toBe('Not delivered: the carrier rejected it');
    expect(messageStatus({ status: 'failed', statusReason: 'PROVIDER_UNAVAILABLE', channel: 'sms' }, 'Liam')!.text).toBe("Not delivered: the phone service wasn't answering");
    expect(messageStatus({ status: 'failed', statusReason: null, channel: 'email' }, 'Owen')!.text).toBe('Not delivered: the email provider rejected it');
  });
  it('E27: a message held because the client replied says so, with their first name', () => {
    expect(messageStatus({ status: 'queued', statusReason: 'CLIENT_REPLIED_SINCE_SCHEDULED', channel: 'sms' }, 'Jane')).toEqual({ text: 'Held because Jane replied', tone: 'held' });
    expect(isHeld({ status: 'queued', statusReason: 'CLIENT_REPLIED_SINCE_SCHEDULED' })).toBe(true);
    expect(isHeld({ status: 'canceled', statusReason: 'CLIENT_REPLIED_SINCE_SCHEDULED' })).toBe(false);
  });
  it('canceled, scheduled and in-flight states; a sent message says nothing', () => {
    expect(messageStatus({ status: 'canceled', statusReason: 'OPTED_OUT', channel: 'sms' }, 'Jane')!.text).toBe('Canceled: they opted out');
    expect(messageStatus({ status: 'canceled', statusReason: 'CANCELED_BY_SENDER', channel: 'sms' }, 'Jane')!.text).toBe('Canceled, not sent');
    expect(messageStatus({ status: 'scheduled', channel: 'sms' }, 'Jane')).toEqual({ text: 'Scheduled', tone: 'info' });
    expect(messageStatus({ status: 'delivered', channel: 'sms' }, 'Jane')).toBeNull();
  });
});

describe('channelState', () => {
  const ch = (o: Partial<ChannelReach> = {}): ChannelReach => ({ hasAddress: true, defaultPointId: 'p', blocked: false, reasons: [], points: [{ pointId: 'p', addressHint: '•••-•••-0101', blocked: false, reasons: [] }], ...o });
  const r = (o: Partial<Reachability['channels']>): Reachability => ({ contactId: 'c', purposeNow: 'informational', channels: { sms: ch(), voice: ch(), email: ch(), ...o } });
  it('Owen: STOP blocks texts with the sentence; email and calls stay open', () => {
    const stop = reason({});
    const s = r({ sms: ch({ blocked: true, reasons: [stop], points: [{ pointId: 'p', addressHint: 'x', blocked: true, reasons: [stop] }] }) });
    expect(channelState(s, 'sms')).toMatchObject({ blocked: true, sentence: 'Texted STOP on Nov 10' });
    expect(channelState(s, 'email')).toEqual({ blocked: false, sentence: null, note: null });
    expect(channelState(s, 'voice')).toEqual({ blocked: false, sentence: null, note: null });
  });
  it('a marketing-only unsubscribe on a reply is a note, not a block', () => {
    const u = reason({ source: 'unsubscribe', purposes: ['marketing'], keyword: null });
    const s = r({ email: ch({ points: [{ pointId: 'p', addressHint: 'x', blocked: false, reasons: [u] }] }) });
    expect(channelState(s, 'email').blocked).toBe(false);
    expect(channelState(s, 'email').note).toMatch(/^Unsubscribed from marketing email/);
  });
  it('unknown (loading or failed) disables nothing', () => {
    expect(channelState(null, 'sms').blocked).toBe(false);
  });
});

describe('provider codes from the real adapters (Twilio, SMTP, SES, Mailgun)', () => {
  it.each<[string, string, string]>([
    ['sms', '30034', "Not delivered: the sending number isn't registered for texting yet"],
    ['sms', '21614', "Not delivered: the number isn't a mobile number"],
    ['sms', 'TWILIO_AUTH', "Not delivered: the phone service didn't accept our credentials"],
    ['email', 'SMTP_552', 'Not delivered: their mailbox is full or the email was too large'],
    ['email', 'SMTP_CONNECTION', "Not delivered: the email service couldn't be reached"],
    ['email', 'mailgun:rejected:unverified', 'Not delivered: the email service refused to send it'],
    ['email', 'ses:RenderingFailure', "Not delivered: the email couldn't be put together"],
  ])('%s %s', (channel, code, text) => {
    expect(messageStatus({ status: 'failed', statusReason: 'PROVIDER_REJECTED', providerErrorCode: code, channel }, 'Jane')?.text).toBe(text);
  });

  it('names SES bounce subtypes and Mailgun failure reasons on a bounced email; unknown codes keep the generic sentence', () => {
    const bounced = (code: string | null) => messageStatus({ status: 'bounced', providerErrorCode: code, channel: 'email' }, 'Jane')?.text;
    expect(bounced('ses:Bounce:Permanent/NoEmail')).toBe("Not delivered: the address doesn't exist");
    expect(bounced('ses:Bounce:Permanent/SomethingNew')).toBe('Not delivered: the email bounced');
    expect(bounced('mailgun:failed:permanent/suppress-bounce/605')).toBe('Not delivered: the address bounced before, so Mailgun did not try again');
    expect(bounced('mailgun:failed:permanent/bounce/550')).toBe('Not delivered: the email bounced');
    expect(bounced(null)).toBe('Not delivered: the email bounced');
    expect(providerCodeSentence('ses:Complaint:abuse')).toBe('they marked it as spam');
    expect(providerCodeSentence('99999')).toBeNull();
    expect(messageStatus({ status: 'failed', providerErrorCode: '99999', channel: 'sms' }, 'Jane')?.text).toBe('Not delivered: the carrier rejected it');
  });
});
