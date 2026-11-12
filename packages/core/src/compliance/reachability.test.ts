// Reachability must agree exactly with canContact (lane optout-visibility item 1). The property test
// generates contacts (points, website-chat identities among them, consent rows, suppressions, the
// person-level do-not-contact) and, for every point × channel × purpose, builds the GateInput the way
// api/comms does for a clean human send (gateInput.ts: this address plus the contact's other phones for
// texts and calls, and every chat identity of the person for a chat reply; suppressions of this address;
// the point's status and line type; the person-level do-not-contact; a connected widget for a chat reply)
// and compares canContact's reasons with the reachability prediction (review optouts/F1, F4 of batch 6:
// the person-level do-not-contact and the person's other chat identities are part of it).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canContact, type GateInput } from './gate.js';
import { REACHABILITY_REASONS, type ReachPoint, type ReachSuppression, type ReachabilityInput, pointBlocks, reachability } from './reachability.js';
import { gateInput, revokedRow } from './testing/fixtures.js';
import type { Channel, ConsentStateRow, LineType, PointStatus, Purpose } from './types.js';

const HMACS = ['a', 'b', 'c', 'd'].map((c) => c.repeat(64));
const STATUSES: PointStatus[] = ['active', 'active', 'active', 'invalid', 'wrong_number', 'bouncing'];
const LINES: LineType[] = ['mobile', 'mobile', 'landline', 'voip', 'unknown'];

const pointArb = fc.record({
  kind: fc.constantFrom<'phone' | 'email' | 'web_chat'>('phone', 'email', 'web_chat'),
  addressHmac: fc.constantFrom(...HMACS),
  status: fc.constantFrom(...STATUSES),
  lineType: fc.constantFrom(...LINES),
});

/** The address namespaces of the generated contact: a phone, an email and a chat identity never share an HMAC. */
const ns = (kind: 'phone' | 'email' | 'web_chat', h: string) => (kind === 'email' ? `e${h.slice(1)}` : kind === 'web_chat' ? `f${h.slice(1)}` : h);

const consentArb = fc.record({
  channel: fc.constantFrom<Channel>('sms', 'voice', 'email', 'web_chat'),
  purpose: fc.constantFrom<Purpose>('marketing', 'informational'),
  addressHmac: fc.constantFrom(...HMACS),
  status: fc.constantFrom<ConsentStateRow['status']>('revoked', 'revoked', 'granted', 'none'),
});

const suppressionArb = fc.record({
  channel: fc.constantFrom<ReachSuppression['channel']>('sms', 'voice', 'email', 'all'),
  reason: fc.constantFrom<ReachSuppression['reason']>('hard_bounce', 'spam_complaint', 'internal_dnc', 'import_dnc', 'provider_opt_out', 'landline_no_sms'),
  addressHmac: fc.constantFrom(...HMACS),
  lifted: fc.boolean(),
});

const contactArb = fc
  .record({
    points: fc.array(pointArb, { minLength: 1, maxLength: 4 }),
    // R-PAR-12: removed phones whose opt-out still counts (an address is on a contact once, live or removed)
    removed: fc.subarray(HMACS, { maxLength: 2 }),
    // review optouts/F4: the person's other chat identities (another record of the person, or removed)
    otherChat: fc.subarray(HMACS, { maxLength: 2 }),
    consent: fc.array(consentArb, { maxLength: 8 }),
    suppressions: fc.array(suppressionArb, { maxLength: 4 }),
    // R-CHAN-2 (review optouts/F1): the person-level do-not-contact of any record of the person
    personDoNotContact: fc.boolean(),
  })
  .map(({ points, removed, otherChat, consent, suppressions, personDoNotContact }): ReachabilityInput => {
    // one consent_state row per key, as in the table (PRIMARY KEY channel, purpose, address)
    const rows = new Map<string, ConsentStateRow>();
    for (const c of consent) {
      const row: ConsentStateRow = c.status === 'granted' ? { ...revokedRow(), ...c, level: 'express', basisEventId: 'g' } : { ...revokedRow(), ...c, basisEventId: c.status === 'revoked' ? `r-${c.channel}-${c.purpose}-${c.addressHmac[0]}` : null };
      rows.set(`${c.channel}:${c.purpose}:${c.addressHmac}`, row);
    }
    // a phone, an email and a chat identity never share an HMAC in practice; keep the kinds apart so the generated
    // contact is one the database can hold (one point per address)
    const live = [...new Map(points.map((p) => [ns(p.kind, p.addressHmac), p])).values()].map((p, i): ReachPoint => ({ id: `p${i}`, ...p, addressHmac: ns(p.kind, p.addressHmac) }));
    return {
      points: live,
      removedPhoneHmacs: removed.filter((h) => !live.some((p) => p.addressHmac === h)),
      otherChatHmacs: otherChat.map((h) => ns('web_chat', h)).filter((h) => !live.some((p) => p.addressHmac === h)),
      consent: [...rows.values()].map((r) => ({ ...r, addressHmac: ns(r.channel === 'email' ? 'email' : r.channel === 'web_chat' ? 'web_chat' : 'phone', r.addressHmac) })),
      suppressions: suppressions.map((s, i) => ({ id: `s${i}`, channel: s.channel, reason: s.reason, liftedAt: s.lifted ? (1 as never) : null, addressHmac: s.addressHmac })),
      personDoNotContact,
    };
  });

/**
 * api/comms gateInput.ts, restated independently for a clean human one-to-one send: for texts and calls,
 * every phone the dispatch guards fan out over (live, and removed but not as a confirmed wrong number); for a
 * chat reply, every chat identity of the person (repos/gate.ts chatFanoutHmacs, the 0043 guard's `others`),
 * through a connected widget; the person-level do-not-contact as repos/gate.ts personDoNotContact reads it.
 */
function apiGateInput(c: ReachabilityInput, point: ReachPoint, channel: Channel, purpose: Purpose): GateInput {
  const hmacs = new Set([point.addressHmac]);
  if (channel === 'sms' || channel === 'voice') for (const h of [...c.points.filter((p) => p.kind === 'phone').map((p) => p.addressHmac), ...(c.removedPhoneHmacs ?? [])]) hmacs.add(h);
  if (channel === 'web_chat') for (const h of [...c.points.filter((p) => p.kind === 'web_chat').map((p) => p.addressHmac), ...(c.otherChatHmacs ?? [])]) hmacs.add(h);
  return gateInput({
    recipient: { kind: 'contact', addressHmac: point.addressHmac, channel },
    purpose,
    initiator: 'human',
    category: 'none',
    consent: c.consent.filter((r) => r.channel === channel && hmacs.has(r.addressHmac)),
    suppressions: c.suppressions.filter((s) => s.addressHmac === point.addressHmac).map((s) => ({ channel: s.channel, reason: s.reason, liftedAt: s.liftedAt })),
    contactPoint: { status: point.status, lineType: point.lineType },
    sender: channel === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : channel === 'web_chat' ? null : { kind: 'phone', registration: 'ready' },
    ...(channel === 'voice' ? { rendered: undefined } : {}),
    personDoNotContact: c.personDoNotContact ?? false,
    connection: channel === 'web_chat' ? { status: 'connected' } : null,
  });
}

const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();

describe('reachability agrees exactly with canContact', () => {
  it('R-CHAN-2 property: for every point × channel × purpose (web chat and the person-level do-not-contact included), the predicted reasons are exactly the reasons canContact gives, and nothing else blocks a clean human send', () => {
    fc.assert(
      fc.property(contactArb, (c) => {
        for (const ch of reachability(c)) {
          for (const pr of ch.points) {
            const point = c.points.find((p) => p.id === pr.pointId)!;
            for (const purpose of ['marketing', 'informational'] as const) {
              const d = canContact(apiGateInput(c, point, ch.channel, purpose));
              const predicted = sorted(pr.blocks[purpose].map((b) => b.reason));
              expect(predicted).toEqual(sorted(d.reasons.filter((r) => (REACHABILITY_REASONS as readonly string[]).includes(r))));
              // with a clean sender, tenant and text, every block canContact gives is one reachability names
              expect(sorted(d.reasons)).toEqual(predicted);
              expect(d.outcome === 'deny').toBe(predicted.length > 0);
            }
          }
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('property: every cited revoked row blocks on its own, and the cited rows are all the rows that do', () => {
    fc.assert(
      fc.property(contactArb, (c) => {
        for (const ch of reachability(c)) {
          for (const pr of ch.points) {
            const point = c.points.find((p) => p.id === pr.pointId)!;
            for (const purpose of ['marketing', 'informational'] as const) {
              const cited = pr.blocks[purpose].find((b) => b.reason === 'CONSENT_REVOKED')?.revokedRows ?? [];
              const all = apiGateInput(c, point, ch.channel, purpose).consent;
              for (const r of all) {
                const alone = canContact(apiGateInput({ ...c, consent: [r] }, point, ch.channel, purpose)).reasons.includes('CONSENT_REVOKED');
                expect(cited.includes(r)).toBe(alone);
              }
              const sup = pr.blocks[purpose].find((b) => b.reason === 'SUPPRESSED')?.suppressions ?? [];
              for (const s of sup) expect(s.liftedAt === null && s.addressHmac === point.addressHmac).toBe(true);
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('reachability examples', () => {
  const phone: ReachPoint = { id: 'm', kind: 'phone', addressHmac: HMACS[0]!, status: 'active', lineType: 'mobile' };
  const other: ReachPoint = { id: 'w', kind: 'phone', addressHmac: HMACS[1]!, status: 'active', lineType: 'mobile' };
  const mail: ReachPoint = { id: 'e', kind: 'email', addressHmac: 'e'.repeat(64), status: 'active', lineType: 'unknown' };
  const stop = (h: string, purpose: Purpose): ConsentStateRow => revokedRow({ channel: 'sms', purpose, addressHmac: h, basisEventId: `stop-${purpose}` });
  const base: ReachabilityInput = { points: [phone, other, mail], consent: [stop(phone.addressHmac, 'marketing'), stop(phone.addressHmac, 'informational')], suppressions: [] };

  it('R-CONSENT-7: a STOP on one phone blocks texting every phone of the contact, and blocks neither email nor calls', () => {
    expect(pointBlocks(base, phone, 'sms', 'informational').map((b) => b.reason)).toEqual(['CONSENT_REVOKED']);
    expect(pointBlocks(base, other, 'sms', 'marketing').map((b) => b.reason)).toEqual(['CONSENT_REVOKED']);
    expect(pointBlocks(base, mail, 'email', 'marketing')).toEqual([]);
    expect(pointBlocks(base, phone, 'voice', 'informational')).toEqual([]);
  });
  it('the cited evidence is the revoked row of the send purpose', () => {
    expect(pointBlocks(base, other, 'sms', 'marketing')[0]!.revokedRows.map((r) => r.basisEventId)).toEqual(['stop-marketing']);
  });
  it('a do-not-call recorded on any phone (either purpose) blocks calling every phone', () => {
    const c = { ...base, consent: [revokedRow({ channel: 'voice', purpose: 'marketing', addressHmac: other.addressHmac, basisEventId: 'dnc' })] };
    expect(pointBlocks(c, phone, 'voice', 'informational').map((b) => b.reason)).toEqual(['CONSENT_REVOKED']);
    expect(pointBlocks(c, phone, 'sms', 'informational')).toEqual([]);
  });
  it('R-PAR-12 R-CONSENT-7: a STOP or a do-not-call on a removed phone that still counts blocks texts and calls to every live phone, and the removed phone is never listed', () => {
    const gone = HMACS[2]!;
    const c: ReachabilityInput = { points: [phone, mail], removedPhoneHmacs: [gone], consent: [stop(gone, 'informational'), revokedRow({ channel: 'voice', purpose: 'informational', addressHmac: gone, basisEventId: 'dnc' })], suppressions: [] };
    expect(pointBlocks(c, phone, 'sms', 'informational').map((b) => b.reason)).toEqual(['CONSENT_REVOKED']);
    expect(pointBlocks(c, phone, 'sms', 'informational')[0]!.revokedRows.map((r) => r.addressHmac)).toEqual([gone]);
    expect(pointBlocks(c, phone, 'sms', 'marketing')).toEqual([]);
    expect(pointBlocks(c, phone, 'voice', 'marketing').map((b) => b.reason)).toEqual(['CONSENT_REVOKED']);
    expect(pointBlocks(c, mail, 'email', 'informational')).toEqual([]);
    // a phone removed as a confirmed wrong number is not among them: its opt-out blocks nobody else
    expect(pointBlocks({ ...c, removedPhoneHmacs: [] }, phone, 'sms', 'informational')).toEqual([]);
    expect(reachability(c).find((x) => x.channel === 'sms')!.points.map((p) => p.pointId)).toEqual([phone.id]);
  });
  it('a marketing email unsubscribe blocks marketing email only', () => {
    const c = { ...base, consent: [revokedRow({ channel: 'email', purpose: 'marketing', addressHmac: mail.addressHmac })] };
    expect(pointBlocks(c, mail, 'email', 'marketing').map((b) => b.reason)).toEqual(['CONSENT_REVOKED']);
    expect(pointBlocks(c, mail, 'email', 'informational')).toEqual([]);
  });
  it('a lifted suppression does not block; an `all` suppression blocks every channel of that address only', () => {
    const c: ReachabilityInput = { ...base, consent: [], suppressions: [{ id: 's1', channel: 'all', reason: 'internal_dnc', liftedAt: null, addressHmac: other.addressHmac }, { id: 's2', channel: 'sms', reason: 'provider_opt_out', liftedAt: 5 as never, addressHmac: phone.addressHmac }] };
    expect(pointBlocks(c, other, 'voice', 'informational').map((b) => b.reason)).toEqual(['SUPPRESSED']);
    expect(pointBlocks(c, phone, 'sms', 'informational')).toEqual([]);
  });
  it('point facts: wrong number, invalid, landline (texts only)', () => {
    expect(pointBlocks(base, { ...other, status: 'wrong_number' }, 'voice', 'informational').map((b) => b.reason)).toEqual(['WRONG_NUMBER']);
    expect(pointBlocks({ ...base, consent: [] }, { ...other, lineType: 'landline' }, 'sms', 'informational').map((b) => b.reason)).toEqual(['LANDLINE_NO_SMS']);
    expect(pointBlocks(base, { ...mail, status: 'bouncing' }, 'email', 'informational').map((b) => b.reason)).toEqual(['CONTACT_POINT_INVALID']);
  });
  it('refuses a point of the wrong kind for the channel', () => {
    expect(() => pointBlocks(base, mail, 'sms', 'informational')).toThrow();
  });
  it('R-CHAN-2 (review optouts/F1, ui-compose/F1): the person-level do-not-contact blocks every channel on every point, the website chat included, also when no point carries a revoke of its own (a merge survivor\'s own points, a point added later)', () => {
    const chat: ReachPoint = { id: 'c', kind: 'web_chat', addressHmac: 'f'.repeat(64), status: 'active', lineType: 'unknown' };
    const c: ReachabilityInput = { points: [phone, mail, chat], consent: [], suppressions: [], personDoNotContact: true };
    for (const [p, ch] of [[phone, 'sms'], [phone, 'voice'], [mail, 'email'], [chat, 'web_chat']] as const) {
      for (const purpose of ['informational', 'marketing'] as const) expect(pointBlocks(c, p, ch, purpose)).toEqual([{ reason: 'PERSON_DO_NOT_CONTACT', revokedRows: [], suppressions: [] }]);
    }
    // with an opt-out too, both are said (in canContact's order: the opt-out, then the person)
    expect(pointBlocks({ ...c, consent: base.consent }, phone, 'sms', 'informational').map((b) => b.reason)).toEqual(['CONSENT_REVOKED', 'PERSON_DO_NOT_CONTACT']);
    expect(pointBlocks({ ...c, personDoNotContact: false }, chat, 'web_chat', 'informational')).toEqual([]);
    expect(REACHABILITY_REASONS).toContain('PERSON_DO_NOT_CONTACT');
  });
  it('review optouts/F4: a chat opt-out on another chat identity of the person (another record of it, or a removed identity) blocks a reply on this one, as canContact and the dispatch guard read it', () => {
    const chat: ReachPoint = { id: 'c', kind: 'web_chat', addressHmac: 'f'.repeat(64), status: 'active', lineType: 'unknown' };
    const elsewhere = '9'.repeat(64);
    const optedOut = revokedRow({ channel: 'web_chat', purpose: 'informational', addressHmac: elsewhere, basisEventId: 'wrong-person' });
    const c: ReachabilityInput = { points: [chat], otherChatHmacs: [elsewhere], consent: [optedOut], suppressions: [] };
    expect(pointBlocks(c, chat, 'web_chat', 'informational').map((b) => b.reason)).toEqual(['CONSENT_REVOKED']);
    expect(pointBlocks(c, chat, 'web_chat', 'informational')[0]!.revokedRows).toEqual([optedOut]);
    // the other identity is never listed, and outside the person it blocks nobody
    expect(reachability(c).find((x) => x.channel === 'web_chat')!.points.map((p) => p.pointId)).toEqual(['c']);
    expect(pointBlocks({ ...c, otherChatHmacs: [] }, chat, 'web_chat', 'informational')).toEqual([]);
  });
});
