// Adversarial verification of core/compliance: each test pins a defect found by trying to break the
// module (wrong input from a caller, a crafted message body, a pack layout), so it stays fixed.
import { describe, expect, it } from 'vitest';
import { instant, sequentialIds } from '../foundation/index.js';
import { type ConsentEventSpec, VOIDS_REVOKE_EVIDENCE_KEY, planNotAnOptOut, projectConsent, toConsentEvent, validateConsentEventSpec } from './consent.js';
import { detectPaymentInstructions } from './content.js';
import { canContact } from './gate.js';
import { classifyInbound, planInboundEffects } from './inbound.js';
import { parseJurisdictionPack } from './policy.js';
import { decideRecording } from './recording.js';
import { consentKey } from './types.js';
import { H1, H2, H3, NOW, assistantInput, ev, gateInput, grantRow, policy, spec } from './testing/fixtures.js';

const K = policy().keywords;
const revokedRow = () => grantRow({ status: 'revoked', level: 'none' });

describe('consent-exempt categories cannot be used to bypass an opt-out', () => {
  it('R-CONSENT-10: a human send labelled opt_out_confirmation to an opted-out number is still denied', () => {
    const d = canContact(gateInput({ category: 'opt_out_confirmation', consent: [revokedRow()] }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toContain('CONSENT_REVOKED');
  });

  it('R-CONSENT-10: a human send labelled help_reply to an opted-out number is still denied', () => {
    const d = canContact(gateInput({ category: 'help_reply', consent: [revokedRow()] }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toContain('CONSENT_REVOKED');
  });

  it('R-CONSENT-10: a system MARKETING send labelled opt_out_confirmation is denied (exemption is informational only)', () => {
    const d = canContact(gateInput({ initiator: 'system', category: 'opt_out_confirmation', purpose: 'marketing', consent: [grantRow({ purpose: 'marketing', status: 'revoked', level: 'none' })] }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toContain('CONSENT_REVOKED');
  });

  it('a system opt-out confirmation over email or voice is not consent-exempt (keywords are SMS)', () => {
    const email = canContact(gateInput({
      initiator: 'system', category: 'opt_out_confirmation',
      recipient: { kind: 'contact', addressHmac: H1, channel: 'email' },
      sender: { kind: 'email', registration: 'ready', domainVerified: true },
      consent: [grantRow({ channel: 'email', status: 'revoked', level: 'none' })],
    }));
    expect(email.outcome).toBe('deny');
    expect(email.reasons).toContain('CONSENT_REVOKED');
  });

  it('the genuine case still works: a system informational SMS opt-out confirmation to a just-revoked number is allowed', () => {
    const input = gateInput({ initiator: 'system', category: 'opt_out_confirmation', consent: [revokedRow()], automationPausedAt: NOW });
    const d = canContact({ ...input, keywordSenders: [input.recipient.addressHmac] });
    expect(d.outcome).toBe('allow');
  });
});

describe('system initiator respects the tenant autonomous categories', () => {
  it('a system-initiated document_chase is denied when the tenant has not enabled it', () => {
    const d = canContact(gateInput({ initiator: 'system', category: 'document_chase' }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toContain('CATEGORY_NOT_AUTONOMOUS');
  });
  it('a system-initiated reminder is denied when the tenant turned reminders off', () => {
    const p = policy({ autonomousCategories: ['speed_to_lead_reply'] });
    const d = canContact(gateInput({ initiator: 'system', category: 'reminder', policy: p }));
    expect(d.reasons).toContain('CATEGORY_NOT_AUTONOMOUS');
  });
  it('a human may send any category by hand; the autonomous switch does not apply to people', () => {
    expect(canContact(gateInput({ category: 'document_chase' })).outcome).toBe('allow');
  });
  it('a system-initiated reminder is allowed when enabled', () => {
    expect(canContact(gateInput({ initiator: 'system', category: 'reminder' })).outcome).toBe('allow');
  });
});

describe('consent fold: a revoke can never be hidden by evidence keys', () => {
  it('R-CONSENT-2: a revoke whose evidence carries voids_revoke_event_id is still a revoke', () => {
    const g = ev({ eventType: 'grant', occurredAt: NOW });
    const r = ev({ eventType: 'revoke', source: 'agent_revoke', actorKind: 'user', occurredAt: instant(NOW + 1), evidence: { voids_revoke_event_id: 'x' } });
    const row = projectConsent([g, r], instant(NOW + 10)).get(consentKey('sms', 'informational', H1));
    expect(row?.status).toBe('revoked');
  });
  it('R-CONSENT-8: a "not an opt-out" marker that is not an agent_entry grant does not void the revoke', () => {
    const g = ev({ eventType: 'grant', occurredAt: NOW });
    const lang = ev({ eventType: 'revoke', source: 'inbound_language', occurredAt: instant(NOW + 1) });
    // Only the exact marker planNotAnOptOut writes (agent_entry grant by a user) voids a revoke; a
    // web_form grant or an imported grant that carries the key does not.
    const fake = ev({ eventType: 'grant', source: 'web_form', actorKind: 'user', occurredAt: instant(NOW + 2), evidence: { voids_revoke_event_id: lang.id } });
    const imp = ev({ eventType: 'grant', source: 'agent_entry', imported: true, actorKind: 'user', occurredAt: instant(NOW + 3), evidence: { voids_revoke_event_id: lang.id } });
    const row = projectConsent([g, lang, fake, imp], instant(NOW + 10)).get(consentKey('sms', 'informational', H1));
    expect(row?.status).toBe('revoked');
  });
});

describe('opt-out language: every occurrence is checked, not only the first', () => {
  it('R-CONSENT-8: a negated first phrase does not hide a later opt-out phrase', () => {
    const c = classifyInbound("Don't stop sending listings, but stop texting me at night", K);
    expect(c.kind).toBe('opt_out_language');
  });
  it('R-CONSENT-8 E24: the negated phrase alone is still not an opt-out', () => {
    expect(classifyInbound("Don't stop sending listings!", K).kind).toBe('none');
    expect(classifyInbound('Stop by at 5?', K).kind).toBe('none');
  });
});

describe('opt-out language: an opt-out keyword with only courtesy words is caught for review', () => {
  for (const body of ['Please stop', 'stop please', 'STOP IT', 'plz stop', 'Unsubscribe please', 'stop now', 'Please STOP!!', 'stop. thanks', 'Quit it please', 'opt out please']) {
    it(`R-CONSENT-8: "${body}" is opt-out language`, () => {
      const c = classifyInbound(body, K);
      expect(c.kind).toBe('opt_out_language');
      expect(c.needsReview).toBe(true);
    });
  }
  for (const body of ['Stop by at 5?', 'please stop by', 'stop at the bank first', 'Can we end at 6?', 'cancel the showing please']) {
    it(`E24: "${body}" is not an opt-out`, () => {
      expect(classifyInbound(body, K).kind).toBe('none');
    });
  }
  it('R-CONSENT-8: "I don\'t want any more texts" is opt-out language', () => {
    expect(classifyInbound("I don't want any more texts", K).kind).toBe('opt_out_language');
  });
});

describe('opt-out language naming another channel reaches that channel on the other addresses', () => {
  const ids = sequentialIds();
  const run = (body: string, channel: 'sms' | 'email', address: { kind: 'phone' | 'email'; hmac: string; hint: string }) =>
    planInboundEffects({
      classification: classifyInbound(body, K),
      channel,
      address,
      otherPhones: [{ kind: 'phone', hmac: H2, hint: '4821' }],
      otherEmails: [{ kind: 'email', hmac: H3, hint: 'j…@x.com' }],
      occurredAt: NOW,
      contactId: 'c-1',
      messageId: 'm-1',
      policy: { optOutConfirmationSender: 'provider' },
      ids,
    });
  const keys = (fx: ReturnType<typeof run>) => fx.consentEvents.map((e) => `${e.channel}:${e.addressHmac}`).sort();

  it('R-CONSENT-8: "do not email me" sent by text revokes email on the contact\'s email address', () => {
    const fx = run('do not email me', 'sms', { kind: 'phone', hmac: H1, hint: '1111' });
    expect(keys(fx)).toContain(`email:${H3}`);
    expect(keys(fx)).toContain(`sms:${H1}`);
  });
  it('R-CONSENT-8: "stop calling me" sent by email revokes voice on the contact\'s phones', () => {
    const fx = run('stop calling me', 'email', { kind: 'email', hmac: H3, hint: 'j…@x.com' });
    expect(keys(fx)).toContain(`voice:${H2}`);
    expect(keys(fx)).toContain(`email:${H3}`);
  });
  it('R-CONSENT-8: "do not call me" by text revokes voice on the sending phone and the other phones', () => {
    const fx = run('do not call me', 'sms', { kind: 'phone', hmac: H1, hint: '1111' });
    expect(keys(fx)).toEqual(expect.arrayContaining([`voice:${H1}`, `voice:${H2}`, `sms:${H1}`, `sms:${H2}`]));
  });
});

describe('payment instructions: common spellings are caught (R-GATE-7)', () => {
  for (const text of [
    'Account No. 12345678',
    'Acct. 000123456789',
    'ABA 021000021',
    'Routing: 021000021',
    'RTN 021000021 at JPMorgan Chase',
    'routing 021000021 / acct ending 4567',
    'Routing number 021000021',
  ]) {
    it(`R-GATE-7: "${text}"`, () => {
      expect(detectPaymentInstructions(text)).toBe(true);
    });
  }
  it('R-GATE-7: ordinary listing text is not flagged', () => {
    expect(detectPaymentInstructions('Open house Sat 1-3 PM at 123 Main St, 3 bd / 2 ba, $450,000')).toBe(false);
  });
});

describe('recording: a state without its own party rule never inherits a one-party country rule', () => {
  const pack = (key: string, rules: Record<string, unknown>) => {
    const r = parseJurisdictionPack({ key, version: '1', reviewedByCounselAt: null, rules });
    if (!r.ok) throw new Error(r.issues.join(';'));
    return r.pack;
  };
  it('R-CONSENT-16: US=one_party, US-TX=one_party, client in US-CA (no pack) ⇒ announce', () => {
    const d = decideRecording({
      agentJurisdiction: 'US-TX',
      clientJurisdictions: ['US-CA'],
      packs: [pack('US', { recording_party_rule: 'one_party' }), pack('US-TX', { recording_party_rule: 'one_party' })],
      mode: 'one_party_where_permitted',
      direction: 'outbound',
    });
    expect(d.announce).toBe(true);
  });
  it('R-CONSENT-16: a state pack without a party rule does not inherit the country rule', () => {
    const d = decideRecording({
      agentJurisdiction: 'US-TX',
      clientJurisdictions: ['US-FL'],
      packs: [pack('US', { recording_party_rule: 'one_party' }), pack('US-TX', { recording_party_rule: 'one_party' }), pack('US-FL', { inquiry_basis_days: 30 })],
      mode: 'one_party_where_permitted',
      direction: 'outbound',
    });
    expect(d.announce).toBe(true);
  });
  it('R-CONSENT-16: both states one_party ⇒ no announcement (attested mode)', () => {
    const d = decideRecording({
      agentJurisdiction: 'US-TX',
      clientJurisdictions: ['US-NY'],
      packs: [pack('US-TX', { recording_party_rule: 'one_party' }), pack('US-NY', { recording_party_rule: 'one_party' })],
      mode: 'one_party_where_permitted',
      direction: 'outbound',
    });
    expect(d.announce).toBe(false);
  });
});

describe('assistant sanity', () => {
  it('assistant opt_out_confirmation is not autonomous', () => {
    expect(canContact(assistantInput({ category: 'opt_out_confirmation', consent: [revokedRow()] })).outcome).toBe('deny');
  });
});

describe('START and "not an opt-out" actually re-enable texting for a contact with two phones', () => {
  const phone1 = { kind: 'phone' as const, hmac: H1, hint: '1111' };
  const phone2 = { kind: 'phone' as const, hmac: H2, hint: '2222' };
  const inbound = (body: string, occurredAt: number, messageId: string, ids: ReturnType<typeof sequentialIds>) =>
    planInboundEffects({
      classification: classifyInbound(body, K),
      channel: 'sms',
      address: phone1,
      // the API's fact for START: phone2's keyword revoke came from phone1's own STOP (outbound-4)
      otherPhones: [{ ...phone2, keywordRevokedBySender: body === 'START' }],
      occurredAt: instant(occurredAt),
      contactId: 'c-1',
      messageId,
      policy: { optOutConfirmationSender: 'provider' },
      ids,
    }).consentEvents;
  const sendTo1 = (events: ConsentEventSpec[]) => {
    const rows = [...projectConsent(events.map(toConsentEvent), instant(NOW + 10_000)).values()];
    return canContact(gateInput({ now: instant(NOW + 10_000), consent: rows.filter((r) => r.channel === 'sms') }));
  };
  const basis = (hmac: string) => spec({ id: `basis-${hmac.slice(0, 2)}`, addressHmac: hmac, level: 'express', source: 'inbound_first_contact', purpose: 'informational', occurredAt: instant(NOW - 1000) });

  it('R-CONSENT-7 R-CONSENT-10: STOP then START from the same phone allows texting that phone again', () => {
    const ids = sequentialIds();
    const stop = inbound('STOP', NOW, 'm-stop', ids);
    expect(sendTo1([basis(H1), ...stop]).reasons).toContain('CONSENT_REVOKED');
    const start = inbound('START', NOW + 1000, 'm-start', ids);
    const d = sendTo1([basis(H1), ...stop, ...start]);
    expect(d.reasons).not.toContain('CONSENT_REVOKED');
    expect(d.outcome).toBe('allow');
  });

  it('R-CONSENT-10: START never undoes an opt-out-language revoke on the other phone', () => {
    const ids = sequentialIds();
    const lang = planInboundEffects({
      classification: classifyInbound('stop texting me', K), channel: 'sms', address: phone2, otherPhones: [], occurredAt: instant(NOW - 500),
      contactId: 'c-1', messageId: 'm-lang', policy: { optOutConfirmationSender: 'provider' }, ids,
    }).consentEvents;
    const stop = inbound('STOP', NOW, 'm-stop', ids);
    const start = inbound('START', NOW + 1000, 'm-start', ids);
    expect(sendTo1([basis(H1), ...lang, ...stop, ...start]).reasons).toContain('CONSENT_REVOKED');
  });

  it('R-CONSENT-8: "not an opt-out" on the reviewed revoke voids every revoke the same message wrote', () => {
    const ids = sequentialIds();
    const lang = inbound("pls stop texting me about the old listing, the new one is fine", NOW, 'm-lang', ids);
    expect(lang.map((e) => e.addressHmac)).toEqual([H1, H2]);
    const all = [basis(H1), ...lang];
    expect(sendTo1(all).reasons).toContain('CONSENT_REVOKED');
    const r = planNotAnOptOut({ events: all, revokeEventId: lang[0]!.id, userId: 'u-1', now: instant(NOW + 5000), ids });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events.map((e) => e.evidence[VOIDS_REVOKE_EVIDENCE_KEY])).toEqual(lang.map((e) => e.id));
    for (const e of r.events) expect(validateConsentEventSpec(e)).toEqual([]);
    expect(sendTo1([...all, ...r.events]).outcome).toBe('allow');
  });
});

describe('no staff-written event can override an opt-out (R-CONSENT-10)', () => {
  const base = () => [ev({ eventType: 'grant', level: 'express', occurredAt: instant(NOW - 3000) }), ev({ eventType: 'revoke', source: 'inbound_keyword', occurredAt: instant(NOW - 2000) })];
  const status = (events: ReturnType<typeof ev>[]) => projectConsent(events, NOW).get(consentKey('sms', 'informational', H1))?.status;

  it('R-CONSENT-10: a resubscribe written by a user (staff) does not undo a STOP', () => {
    expect(status([...base(), ev({ eventType: 'resubscribe', source: 'inbound_keyword', actorKind: 'user', occurredAt: instant(NOW - 1000) })])).toBe('revoked');
  });
  it('R-CONSENT-10: a "web_form" grant with a disclosure written by a user (staff) does not reinstate', () => {
    expect(status([...base(), ev({ eventType: 'grant', source: 'web_form', disclosureId: 'd-1', actorKind: 'user', occurredAt: instant(NOW - 1000) })])).toBe('revoked');
    expect(status([...base(), ev({ eventType: 'grant', source: 'lead_provider', level: 'express', disclosureId: 'd-1', actorKind: 'user', occurredAt: instant(NOW - 1000) })])).toBe('revoked');
  });
  it('R-CONSENT-10: the person\'s own START (system-ingested) and a system-ingested form still reinstate', () => {
    expect(status([...base(), ev({ eventType: 'resubscribe', source: 'inbound_keyword', occurredAt: instant(NOW - 1000) })])).toBe('granted');
    expect(status([...base(), ev({ eventType: 'grant', source: 'web_form', disclosureId: 'd-1', occurredAt: instant(NOW - 1000) })])).toBe('granted');
  });
});

describe('invisible characters do not hide a keyword (R-CONSENT-7)', () => {
  for (const body of ['S​TOP', 'ST­OP', 'STOP️', 'S̲T̲O̲P̲', '​stop​']) {
    it(`R-CONSENT-7 E25: ${JSON.stringify(body)} is STOP`, () => {
      expect(classifyInbound(body, K)).toMatchObject({ kind: 'stop', matched: 'STOP' });
    });
  }
  it('R-CONSENT-8: zero-width characters inside opt-out language do not hide it', () => {
    expect(classifyInbound('stop​ texting me', K).kind).toBe('opt_out_language');
  });
});
