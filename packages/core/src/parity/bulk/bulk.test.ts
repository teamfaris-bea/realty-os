// Module 62 (bulk half): caps, derived ids, preflight, outcomes and the bulk_finished sentence.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canContact } from '../../compliance/index.js';
import { HOUR_MS, instant } from '../../foundation/index.js';
import {
  BULK_CAPS,
  BULK_KINDS,
  type BulkKindFacts,
  type BulkPersonFacts,
  DAILY_BULK_EMAIL_CAP,
  SKIP_REASONS,
  bulkActionPreflight,
  bulkPreflight,
  bulkSendKey,
  checkBulkSize,
  checkDailyEmailCap,
  derivedCommandId,
  finishedSentence,
  itemOutcomeForDispatch,
  itemOutcomeForMessageStatus,
  skipForGateReasons,
  tally,
  uuidV5,
} from './index.js';
import { H1, H2, NOW, bulkGate, revoked, user } from './testing.js';

const OWN: BulkPersonFacts = { detailVisible: true, merged: false, deleted: false, access: { own: true } };
const agent = user('agent');
const run = { actor: agent, now: NOW };
const send = (kind: 'email' | 'text', o: Partial<Extract<BulkKindFacts, { kind: 'email' }>> = {}): BulkKindFacts =>
  ({ kind, addressHmac: H1, sharedWithEarlier: false, gate: bulkGate(kind === 'email' ? 'email' : 'sms'), lastInboundAt: null, rendered: { ok: true }, ...o }) as BulkKindFacts;

describe('Q-PAR-7 caps (R-PAR-33 the confirmed count is the frozen target, R-PAR-40 text ≤ 200)', () => {
  it('R-PAR-40 caps per kind apply to the people selected; batch text is at most 200', () => {
    expect(BULK_CAPS).toEqual({ tag: 10000, untag: 10000, stage: 2000, assign: 2000, enroll: 2000, email: 2000, text: 200 });
    for (const k of BULK_KINDS) {
      expect(checkBulkSize(k, BULK_CAPS[k])).toEqual({ ok: true });
      expect(checkBulkSize(k, BULK_CAPS[k] + 1)).toEqual({ ok: false, code: 'BULK_TOO_LARGE', cap: BULK_CAPS[k] });
      expect(checkBulkSize(k, 0)).toEqual({ ok: false, code: 'BULK_EMPTY' });
      expect(checkBulkSize(k, 1.5)).toEqual({ ok: false, code: 'BULK_EMPTY' });
    }
  });

  it('Q-PAR-7 the tenant daily bulk-email cap counts every creator, and fails closed on bad input', () => {
    expect(DAILY_BULK_EMAIL_CAP).toBe(2000);
    expect(checkDailyEmailCap(1500, 500)).toEqual({ ok: true });
    expect(checkDailyEmailCap(1500, 501)).toEqual({ ok: false, code: 'BULK_DAILY_EMAIL_CAP', cap: 2000, remaining: 500 });
    expect(checkDailyEmailCap(2500, 1)).toMatchObject({ ok: false, remaining: 0 });
    expect(checkDailyEmailCap(Number.NaN, 1)).toMatchObject({ ok: false });
    expect(checkDailyEmailCap(-1, 1)).toMatchObject({ ok: false });
  });
});

describe('R-PAR-35 R-PAR-38 derived ids are deterministic per person and per address', () => {
  const A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const C1 = '0190a1b2-c3d4-7e5f-8a9b-000000000001';
  const C2 = '0190a1b2-c3d4-7e5f-8a9b-000000000002';
  it('R-PAR-35 derivedCommandId is a v5 UUID, stable across retries and case, distinct per person and action', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2'); // RFC 9562 test vector
    const id = derivedCommandId(A, C1);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedCommandId(A.toUpperCase(), C1.toUpperCase())).toBe(id);
    expect(derivedCommandId(A, C2)).not.toBe(id);
    expect(derivedCommandId(C1, A)).not.toBe(id);
    expect(() => derivedCommandId('not-a-uuid', C1)).toThrow(TypeError);
  });

  it('R-PAR-38 bulkSendKey: one key per address per action (two spouses sharing an address share the key)', () => {
    const k = bulkSendKey(A, H1);
    expect(k).toBe(bulkSendKey(A, H1.toUpperCase()));
    expect(k).not.toBe(bulkSendKey(A, H2));
    expect(k.length).toBeLessThanOrEqual(100);
    expect(() => bulkSendKey(A, 'abc')).toThrow(TypeError);
  });

  it('R-PAR-35 property: distinct (action, person) pairs never collide', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), fc.uuid(), (a, c1, c2) => {
        fc.pre(c1.toLowerCase() !== c2.toLowerCase());
        expect(derivedCommandId(a, c1)).not.toBe(derivedCommandId(a, c2));
      }),
    );
  });
});

describe('R-PAR-33 R-PAR-35 R-PAR-39 R-PAR-40 R-PAR-8 action-level preflight', () => {
  const email = { kind: 'email' as const, role: 'agent' as const, selected: 10, audienceProtected: false, templateChannelMatches: true, brokerageNamePresent: true, postalAddressPresent: true, emailDomainVerified: true, emailsConfirmedToday: 0 };
  it('R-PAR-35 TCs run no bulk action; only Owner/Admin/TL assign', () => {
    expect(bulkActionPreflight({ kind: 'tag', role: 'tc', selected: 1, audienceProtected: false, tagProtected: false })).toEqual({ ok: false, code: 'BULK_NOT_PERMITTED' });
    for (const role of ['agent', 'isa', 'tc'] as const) expect(bulkActionPreflight({ kind: 'assign', role, selected: 1, audienceProtected: false })).toEqual({ ok: false, code: 'BULK_NOT_PERMITTED' });
    for (const role of ['owner', 'admin', 'team_lead'] as const) expect(bulkActionPreflight({ kind: 'assign', role, selected: 1, audienceProtected: false })).toEqual({ ok: true });
  });

  it('R-PAR-8 E189 a protected-proxy audience never receives a bulk send or enrollment; a protected tag is never applied in bulk', () => {
    expect(bulkActionPreflight({ ...email, audienceProtected: true })).toEqual({ ok: false, code: 'AUDIENCE_PROTECTED_PROXY' });
    expect(bulkActionPreflight({ kind: 'text', role: 'agent', selected: 1, audienceProtected: true, templateChannelMatches: true, batchTextEnabled: true, brokerageNamePresent: true, smsMarketingRegistered: true })).toEqual({ ok: false, code: 'AUDIENCE_PROTECTED_PROXY' });
    expect(bulkActionPreflight({ kind: 'enroll', role: 'agent', selected: 1, audienceProtected: true, playbookApproved: true })).toEqual({ ok: false, code: 'AUDIENCE_PROTECTED_PROXY' });
    expect(bulkActionPreflight({ kind: 'tag', role: 'owner', selected: 1, audienceProtected: false, tagProtected: true })).toEqual({ ok: false, code: 'TAG_PROTECTED' });
    expect(bulkActionPreflight({ kind: 'tag', role: 'owner', selected: 1, audienceProtected: false })).toEqual({ ok: false, code: 'TAG_PROTECTED' }); // unknown fails closed
    // tag/stage on a protected audience is viewing-adjacent one-to-one work, not a send: allowed
    expect(bulkActionPreflight({ kind: 'stage', role: 'agent', selected: 1, audienceProtected: true })).toEqual({ ok: true });
  });

  it('R-PAR-39 a bulk email needs the brokerage name, postal address and a verified sending domain', () => {
    expect(bulkActionPreflight(email)).toEqual({ ok: true });
    expect(bulkActionPreflight({ ...email, postalAddressPresent: false })).toEqual({ ok: false, code: 'POSTAL_ADDRESS_MISSING' });
    expect(bulkActionPreflight({ ...email, emailDomainVerified: false })).toEqual({ ok: false, code: 'EMAIL_DOMAIN_UNVERIFIED' });
    expect(bulkActionPreflight({ ...email, brokerageNamePresent: false })).toEqual({ ok: false, code: 'BROKERAGE_IDENTITY_MISSING' });
    expect(bulkActionPreflight({ ...email, emailsConfirmedToday: 1995 })).toMatchObject({ ok: false, code: 'BULK_DAILY_EMAIL_CAP' });
    expect(bulkActionPreflight({ ...email, emailsConfirmedToday: undefined as never })).toMatchObject({ ok: false, code: 'BULK_DAILY_EMAIL_CAP' });
    expect(bulkActionPreflight({ ...email, templateChannelMatches: false })).toEqual({ ok: false, code: 'TEMPLATE_CHANNEL_MISMATCH' });
  });

  it('R-PAR-40 batch text is refused while the switch is off, without an approved marketing registration, and above 200', () => {
    const text = { kind: 'text' as const, role: 'agent' as const, selected: 200, audienceProtected: false, templateChannelMatches: true, batchTextEnabled: true, brokerageNamePresent: true, smsMarketingRegistered: true };
    expect(bulkActionPreflight(text)).toEqual({ ok: true });
    expect(bulkActionPreflight({ ...text, batchTextEnabled: false })).toEqual({ ok: false, code: 'BATCH_TEXT_DISABLED' });
    expect(bulkActionPreflight({ ...text, batchTextEnabled: undefined })).toEqual({ ok: false, code: 'BATCH_TEXT_DISABLED' });
    expect(bulkActionPreflight({ ...text, smsMarketingRegistered: false })).toEqual({ ok: false, code: 'SMS_MARKETING_NOT_REGISTERED' });
    expect(bulkActionPreflight({ ...text, selected: 201 })).toEqual({ ok: false, code: 'BULK_TOO_LARGE', cap: 200 });
  });

  it('R-PAR-35 enroll needs an approved playbook version', () => {
    expect(bulkActionPreflight({ kind: 'enroll', role: 'agent', selected: 3, audienceProtected: false, playbookApproved: false })).toEqual({ ok: false, code: 'PLAYBOOK_NOT_APPROVED' });
    expect(bulkActionPreflight({ kind: 'enroll', role: 'agent', selected: 3, audienceProtected: false, playbookApproved: true })).toEqual({ ok: true });
  });
});

describe('R-PAR-34 R-PAR-35 per-person preflight', () => {
  it('R-PAR-34 E183 a person the creator no longer sees, merged or deleted is skipped with that reason', () => {
    expect(bulkPreflight('tag', { ...OWN, detailVisible: false }, { kind: 'tag', alreadyTagged: false, tagCount: 0 }, run)).toEqual({ ok: false, reason: 'NOT_VISIBLE' });
    expect(bulkPreflight('tag', { ...OWN, merged: true }, { kind: 'tag', alreadyTagged: false, tagCount: 0 }, run)).toEqual({ ok: false, reason: 'MERGED' });
    expect(bulkPreflight('tag', { ...OWN, deleted: true }, { kind: 'tag', alreadyTagged: false, tagCount: 0 }, run)).toEqual({ ok: false, reason: 'DELETED' });
  });

  it('R-PAR-35 the creator\'s role decides per person: an agent on a teammate\'s lead is NOT_PERMITTED; a TL on the team is fine', () => {
    const teammate: BulkPersonFacts = { ...OWN, access: { team: true } };
    expect(bulkPreflight('stage', teammate, { kind: 'stage', currentStage: 'new', toStage: 'nurture', firstTouchPending: false }, run)).toEqual({ ok: false, reason: 'NOT_PERMITTED' });
    expect(bulkPreflight('stage', teammate, { kind: 'stage', currentStage: 'new', toStage: 'nurture', firstTouchPending: false }, { ...run, actor: user('team_lead') })).toEqual({ ok: true });
    expect(bulkPreflight('tag', OWN, { kind: 'tag', alreadyTagged: false, tagCount: 0 }, { ...run, actor: user('tc') })).toEqual({ ok: false, reason: 'NOT_PERMITTED' });
  });

  it('R-PAR-35 tag/untag/stage: idempotent skips, the tag limit and R-PAR-14 per item', () => {
    expect(bulkPreflight('tag', OWN, { kind: 'tag', alreadyTagged: true, tagCount: 3 }, run)).toEqual({ ok: false, reason: 'ALREADY_TAGGED' });
    expect(bulkPreflight('tag', OWN, { kind: 'tag', alreadyTagged: false, tagCount: 100 }, run)).toEqual({ ok: false, reason: 'TAG_LIMIT' });
    expect(bulkPreflight('untag', OWN, { kind: 'untag', tagged: false }, run)).toEqual({ ok: false, reason: 'NOT_TAGGED' });
    expect(bulkPreflight('stage', OWN, { kind: 'stage', currentStage: 'active', toStage: 'active', firstTouchPending: false }, run)).toEqual({ ok: false, reason: 'ALREADY_IN_STAGE' });
    for (const to of ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const) {
      expect(bulkPreflight('stage', OWN, { kind: 'stage', currentStage: 'new', toStage: to, firstTouchPending: true }, run), to).toEqual({ ok: false, reason: 'STAGE_NEEDS_CONTACT' });
      expect(bulkPreflight('stage', OWN, { kind: 'stage', currentStage: 'new', toStage: to, firstTouchPending: true }, { ...run, actor: user('owner') })).toEqual({ ok: true });
    }
    expect(bulkPreflight('stage', OWN, { kind: 'stage', currentStage: 'new', toStage: 'attempting', firstTouchPending: true }, run)).toEqual({ ok: true });
  });

  it('R-PAR-35 assign: the TL only within their team, never to a TC; enroll skips ALREADY_ENROLLED and unreachable people', () => {
    const tl = { ...run, actor: user('team_lead') };
    const teamPerson: BulkPersonFacts = { ...OWN, access: { team: true } };
    expect(bulkPreflight('assign', teamPerson, { kind: 'assign', ownerUserId: 'a', toUserId: 'b', target: { role: 'agent', inMyTeam: true } }, tl)).toEqual({ ok: true });
    expect(bulkPreflight('assign', teamPerson, { kind: 'assign', ownerUserId: 'a', toUserId: 'b', target: { role: 'agent', inMyTeam: false } }, tl)).toEqual({ ok: false, reason: 'NOT_PERMITTED' });
    expect(bulkPreflight('assign', teamPerson, { kind: 'assign', ownerUserId: 'a', toUserId: 'b', target: { role: 'tc', inMyTeam: true } }, tl)).toEqual({ ok: false, reason: 'NOT_PERMITTED' });
    expect(bulkPreflight('assign', teamPerson, { kind: 'assign', ownerUserId: 'b', toUserId: 'b', target: { role: 'agent', inMyTeam: true } }, tl)).toEqual({ ok: false, reason: 'ALREADY_OWNER' });
    expect(bulkPreflight('assign', OWN, { kind: 'assign', ownerUserId: 'a', toUserId: 'b', target: { role: 'agent', inMyTeam: true } }, run)).toEqual({ ok: false, reason: 'NOT_PERMITTED' });
    expect(bulkPreflight('enroll', OWN, { kind: 'enroll', liveEnrollment: true, reachable: true }, run)).toEqual({ ok: false, reason: 'ALREADY_ENROLLED' });
    expect(bulkPreflight('enroll', OWN, { kind: 'enroll', liveEnrollment: false, reachable: false }, run)).toEqual({ ok: false, reason: 'UNREACHABLE' });
  });

  it('R-PAR-38 one send per address: a person without an address or sharing one is skipped', () => {
    expect(bulkPreflight('email', OWN, send('email', { addressHmac: null, gate: null }), run)).toEqual({ ok: false, reason: 'NO_ADDRESS' });
    expect(bulkPreflight('email', OWN, send('email', { sharedWithEarlier: true }), run)).toEqual({ ok: false, reason: 'SHARED_ADDRESS' });
  });

  it('R-PAR-36 E184 opt-outs skip with their own reason (no override): STOP on another phone, unsubscribe, suppression, do-not-contact', () => {
    expect(bulkPreflight('text', OWN, send('text', { gate: bulkGate('sms', { consent: [revoked('sms', H2)] }) }), run)).toMatchObject({ ok: false, reason: 'RECIPIENT_OPTED_OUT', gateReasons: ['CONSENT_REVOKED'] });
    expect(bulkPreflight('email', OWN, send('email', { gate: bulkGate('email', { consent: [revoked('email', H1)] }) }), run)).toMatchObject({ ok: false, reason: 'RECIPIENT_OPTED_OUT' });
    expect(bulkPreflight('email', OWN, send('email', { gate: bulkGate('email', { suppressions: [{ channel: 'email', reason: 'hard_bounce', liftedAt: null }] }) }), run)).toMatchObject({ ok: false, reason: 'RECIPIENT_SUPPRESSED' });
    expect(bulkPreflight('email', OWN, send('email', { gate: bulkGate('email', { personDoNotContact: true, consent: [revoked('email', H1)] }) }), run)).toMatchObject({ ok: false, reason: 'PERSON_DO_NOT_CONTACT' });
    // any other gate reason: SEND_BLOCKED, with the gate's own reasons kept
    expect(bulkPreflight('text', OWN, send('text', { gate: bulkGate('sms', { contactPoint: { status: 'active', lineType: 'landline' } }) }), run)).toMatchObject({ ok: false, reason: 'SEND_BLOCKED', gateReasons: ['LANDLINE_NO_SMS'] });
  });

  it('Q-PAR-9 a bulk email skips people who wrote in the last 24 h; a batch text does not use that rule', () => {
    const recent = instant(NOW - 23 * HOUR_MS);
    expect(bulkPreflight('email', OWN, send('email', { lastInboundAt: recent }), run)).toEqual({ ok: false, reason: 'RECENT_INBOUND' });
    expect(bulkPreflight('email', OWN, send('email', { lastInboundAt: instant(NOW - 24 * HOUR_MS) }), run)).toEqual({ ok: true });
    expect(bulkPreflight('email', OWN, send('email', { lastInboundAt: instant(NOW + HOUR_MS) }), run)).toEqual({ ok: false, reason: 'RECENT_INBOUND' });
    expect(bulkPreflight('text', OWN, send('text', { lastInboundAt: recent }), run)).toEqual({ ok: true });
  });

  it('R-PAR-24 a person missing a merge field is skipped (MERGE_FIELD_EMPTY), never sent "Hi ,"', () => {
    expect(bulkPreflight('email', OWN, send('email', { rendered: { ok: false, code: 'MERGE_FIELD_EMPTY' } }), run)).toEqual({ ok: false, reason: 'MERGE_FIELD_EMPTY' });
  });

  it('R-PAR-36 the gate input must be this bulk send (human marketing, the frozen address, the channel): anything else is a programming error', () => {
    expect(() => bulkPreflight('email', OWN, send('email', { gate: bulkGate('email', { purpose: 'informational' }) }), run)).toThrow(TypeError);
    expect(() => bulkPreflight('email', OWN, send('email', { gate: bulkGate('email', { recipient: { kind: 'contact', addressHmac: H2, channel: 'email' } }) }), run)).toThrow(TypeError);
    expect(() => bulkPreflight('text', OWN, send('text', { gate: bulkGate('email') }), run)).toThrow(TypeError);
    expect(() => bulkPreflight('email', OWN, { kind: 'tag', alreadyTagged: false, tagCount: 0 }, run)).toThrow(TypeError);
  });

  it('R-PAR-36 property: bulkPreflight never allows a send canContact denies (monotonic: only adds skips)', () => {
    const consent = fc.subarray([revoked('sms', H1), revoked('sms', H2), revoked('email', H1), revoked('email', H2), revoked('voice', H1), revoked('sms', H2, 'informational')]);
    fc.assert(
      fc.property(fc.constantFrom('email' as const, 'text' as const), consent, fc.boolean(), fc.boolean(), fc.boolean(), (kind, rows, dnc, supp, recent) => {
        const gate = bulkGate(kind === 'email' ? 'email' : 'sms', {
          consent: rows,
          personDoNotContact: dnc,
          suppressions: supp ? [{ channel: 'all', reason: 'spam_complaint', liftedAt: null }] : [],
        });
        const r = bulkPreflight(kind, OWN, send(kind, { gate, lastInboundAt: recent ? instant(NOW - HOUR_MS) : null }), run);
        if (canContact(gate).outcome === 'deny') expect(r.ok).toBe(false);
        if (r.ok) expect(canContact(gate).outcome).toBe('allow');
      }),
    );
  });
});

describe('R-PAR-41 R-PAR-36 E188 item outcomes and the bulk_finished counts', () => {
  it('E188 a dispatch result maps to a final item status; a dispatching message on replay stays pending for the sweeper', () => {
    expect(itemOutcomeForDispatch({ kind: 'sent' })).toEqual({ status: 'done', reasonCode: null });
    expect(itemOutcomeForDispatch({ kind: 'dispatch_unknown' })).toEqual({ status: 'done', reasonCode: null });
    expect(itemOutcomeForDispatch({ kind: 'blocked', reasons: ['SENDER_NOT_AUTHORIZED'] })).toEqual({ status: 'blocked', reasonCode: 'NOT_VISIBLE' });
    expect(itemOutcomeForDispatch({ kind: 'blocked', reasons: ['SUPPRESSED', 'CONSENT_REVOKED'] })).toEqual({ status: 'blocked', reasonCode: 'RECIPIENT_OPTED_OUT' });
    expect(itemOutcomeForDispatch({ kind: 'failed', reason: 'PROVIDER_REJECTED' })).toEqual({ status: 'failed', reasonCode: 'PROVIDER_REJECTED' });
    expect(itemOutcomeForDispatch({ kind: 'failed', reason: 'weird reason' })).toEqual({ status: 'failed', reasonCode: 'SEND_FAILED' });
    expect(itemOutcomeForDispatch({ kind: 'needs_retap' })).toEqual({ status: 'canceled', reasonCode: 'CLIENT_REPLIED', cancelMessage: true });
    expect(itemOutcomeForDispatch({ kind: 'noop', status: 'dispatching' })).toEqual({ status: 'pending', reasonCode: null });
    expect(itemOutcomeForDispatch({ kind: 'noop', status: 'sent' })).toEqual({ status: 'done', reasonCode: null });
    for (const s of ['queued', 'scheduled', 'missing']) expect(itemOutcomeForMessageStatus(s).status).toBe('pending');
    expect(itemOutcomeForMessageStatus('awaiting_tap')).toMatchObject({ status: 'canceled', reasonCode: 'CLIENT_REPLIED' });
    expect(itemOutcomeForMessageStatus('blocked')).toMatchObject({ status: 'blocked' });
    expect(itemOutcomeForMessageStatus('canceled')).toMatchObject({ status: 'canceled' });
    expect(itemOutcomeForMessageStatus('failed')).toMatchObject({ status: 'failed' });
  });

  it('R-PAR-36 the DB guard\'s own codes map to the same skip reasons (core bypassed)', () => {
    expect(skipForGateReasons(['RECIPIENT_OPTED_OUT'])).toBe('RECIPIENT_OPTED_OUT');
    expect(skipForGateReasons(['RECIPIENT_SUPPRESSED'])).toBe('RECIPIENT_SUPPRESSED');
    expect(skipForGateReasons(['PERSON_DO_NOT_CONTACT'])).toBe('PERSON_DO_NOT_CONTACT');
    expect(skipForGateReasons(['BATCH_TEXT_DISABLED'])).toBe('BATCH_TEXT_DISABLED');
    expect(skipForGateReasons(['WRONG_NUMBER'])).toBe('SEND_BLOCKED');
  });

  it('R-PAR-41 counts by reason with the denominator: "Emailed 398 of 412: 9 opted out, 5 no address"', () => {
    const items = [
      ...Array.from({ length: 398 }, () => ({ status: 'done' as const, reasonCode: null })),
      ...Array.from({ length: 4 }, () => ({ status: 'blocked' as const, reasonCode: 'RECIPIENT_OPTED_OUT' })),
    ];
    const c = tally(412, { RECIPIENT_OPTED_OUT: 5, NO_ADDRESS: 5, BOGUS: 0 }, items);
    expect(c).toMatchObject({ selected: 412, done: 398, skipped: 10, blocked: 4, byReason: { RECIPIENT_OPTED_OUT: 9, NO_ADDRESS: 5 } });
    expect(finishedSentence('email', c)).toBe('Emailed 398 of 412: 9 opted out, 5 no address');
    expect(finishedSentence('text', tally(3, {}, [{ status: 'done', reasonCode: null }]), 'canceled')).toBe('Canceled. Texted 1 of 3');
    const many = tally(20, { A_ONE: 1, B_TWO: 2, C_THREE: 3, D_FOUR: 4, E_FIVE: 5, F_SIX: 1, G_SEVEN: 1 }, []);
    expect(finishedSentence('tag', many)).toBe('Tagged 0 of 20: 5 e five, 4 d four, 3 c three, 2 b two, 1 a one, and 2 more');
  });

  it('R-PAR-41 every skip reason has a plain phrase (no code ever reaches the creator raw)', () => {
    for (const r of SKIP_REASONS) expect(finishedSentence('email', tally(1, { [r]: 1 }, []))).not.toContain(r);
  });
});
