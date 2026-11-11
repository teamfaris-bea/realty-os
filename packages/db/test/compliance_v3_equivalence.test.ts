// Module 19 (core/compliance-v3) equivalence test, kept beside the DB guard test it mirrors (packages/core is pure:
// no file reads, even in tests).
// R-CHAN-5 / review finding F17: core-compliance/3.0.0 `canContact` blocks at least what the 0018 DB dispatch
// guards block. One shared case table drives both: packages/db/test/dispatch_guard.test.ts writes every row of
// packages/db/test/fixtures/opt_out_cases.json against the real guards; this file feeds the same rows to
// canContact. Core may deny more (it also checks the platform window and the connection), never less.
//
// To make the comparison sharp, every operational fact the DB test sets up favourably is set the same way here
// (a connected connection, an open Meta window, a ready sender), and the gate receives EVERY consent row of the
// case, whatever channel or address, so it has to pick the right ones itself.
import { readFileSync } from 'node:fs';
import { instant } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import {
  type Channel,
  ChannelUnknownError,
  OUT_OF_SCOPE_CHANNELS,
  type ConsentStateRow,
  type GateInput,
  type ReasonCode,
  type SuppressionRow,
  canContact,
  gateChannelForMessage,
  isPlatformChannel,
  PLATFORM_FLOOR,
  parseJurisdictionPack,
  resolvePolicy,
} from '@realty/core/compliance';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const NOW = instant(Date.parse('2026-11-10T15:00:00Z'));
const US = parseJurisdictionPack({
  key: 'US',
  version: '2026.11.0',
  reviewedByCounselAt: null,
  rules: {
    contact_window: { start: '08:00', end: '21:00' },
    restricted_days: [],
    recording_party_rule: 'unknown',
    inquiry_basis_days: 90,
    dnc_scrub_validity_days: 31,
    opt_out_keywords: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT'],
    resubscribe_keywords: ['START', 'UNSTOP'],
    help_keywords: ['HELP', 'INFO'],
    ai_disclosure: { assistant_must_identify: true },
    advertising: { brokerage_name_required: true },
  },
});
if (!US.ok) throw new Error('US pack fixture invalid');
const POLICY = resolvePolicy(PLATFORM_FLOOR, [US.pack], {
  id: '00000000-0000-7000-8000-0000000000aa',
  autonomousCategories: ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'nurture_step', 'search_alert'],
  optOutConfirmationSender: 'provider',
  recordingEnabled: true,
  recordingMode: 'announce_all',
  looseningAttestation: null,
});

/** A clean human informational SMS the gate allows (core's own test fixture, restated). */
function gateInput(o: Partial<GateInput> = {}): GateInput {
  return {
    now: NOW,
    recipient: { kind: 'contact', addressHmac: H1, channel: 'sms' },
    purpose: 'informational',
    initiator: 'human',
    category: 'none',
    consent: [],
    suppressions: [],
    contactPoint: { status: 'active', lineType: 'mobile' },
    automationPausedAt: null,
    sender: { kind: 'phone', registration: 'ready' },
    tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: true },
    rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false },
    policy: POLICY,
    personDoNotContact: false,
    connection: null,
    ...o,
  };
}

interface RevokeFact { channel: Channel; purpose: 'all' | 'informational' | 'marketing' }
interface OptOutCase {
  id: string;
  why: string;
  channel: string;
  expect: string;
  initiator: 'human' | 'system';
  purpose: 'informational' | 'marketing';
  actionCategory: GateInput['category'];
  recipientRevoked: RevokeFact[];
  otherPointRevoked: RevokeFact[];
  otherKindRevoked: (RevokeFact & { kind: string })[];
  suppression: { channel: SuppressionRow['channel']; reason: SuppressionRow['reason'] } | null;
  personDoNotContact: boolean;
  mergedDuplicateDoNotContact: boolean;
  keywordWithin24h: boolean;
  platformCleared: boolean | null;
}

const table = JSON.parse(readFileSync(new URL('./fixtures/opt_out_cases.json', import.meta.url), 'utf8')) as {
  defaults: Omit<OptOutCase, 'id' | 'why' | 'channel' | 'expect'>;
  cases: (Partial<OptOutCase> & Pick<OptOutCase, 'id' | 'why' | 'channel' | 'expect'>)[];
};
const cases: OptOutCase[] = table.cases.map((c) => ({ ...table.defaults, ...c }));

/** The DB guard's error code → the core reason that must appear. */
const CORE_REASON: Record<string, ReasonCode> = {
  RECIPIENT_OPTED_OUT: 'CONSENT_REVOKED',
  RECIPIENT_SUPPRESSED: 'SUPPRESSED',
  PERSON_DO_NOT_CONTACT: 'PERSON_DO_NOT_CONTACT',
};

/**
 * Owner scope change D2: Messenger/Instagram DMs are out of scope. Their rows stay in the shared table (they prove
 * the DB guard fails closed); core has no such channel and refuses them outright, so no equivalence is claimed.
 */
const outOfScope = (c: OptOutCase): boolean => OUT_OF_SCOPE_CHANNELS.includes(c.channel);

function rows(addressHmac: string, r: RevokeFact): ConsentStateRow[] {
  return (r.purpose === 'all' ? (['informational', 'marketing'] as const) : [r.purpose]).map((purpose) => ({
    channel: r.channel,
    purpose,
    addressHmac,
    status: 'revoked',
    level: 'none',
    basisEventId: 'e-revoke',
    expiresAt: null,
    ledgerEventCount: 1,
  }));
}

/** The gate input for one case, as the dispatch path would build it (channel mapped like the guard's map). */
function caseInput(c: OptOutCase): GateInput {
  const ch: Channel = c.channel === 'voice' ? 'voice' : gateChannelForMessage(c.channel);
  const consent = [
    ...c.recipientRevoked.flatMap((r) => rows(H1, r)),
    ...c.otherPointRevoked.flatMap((r) => rows(H2, r)),
    ...c.otherKindRevoked.flatMap((r) => rows(H3, r)),
  ];
  return gateInput({
    recipient: { kind: 'contact', addressHmac: H1, channel: ch },
    initiator: c.initiator,
    purpose: c.purpose,
    category: c.actionCategory,
    consent,
    suppressions: c.suppression ? [{ ...c.suppression, liftedAt: null }] : [],
    ...(c.keywordWithin24h ? { keywordSenders: [H1] } : {}),
    sender: ch === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : isPlatformChannel(ch) ? null : { kind: 'phone', registration: 'ready' },
    ...(ch === 'voice' ? { rendered: undefined } : {}),
    personDoNotContact: c.personDoNotContact || c.mergedDuplicateDoNotContact,
    connection: { status: 'connected' },
  });
}

describe('R-CHAN-5 F17 equivalence: canContact denies every in-scope case the DB guard denies (shared opt_out_cases.json; D2)', () => {
  it('reads the same table the DB guard test runs (every channel of the guard map, a call and an unknown channel)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(46);
    expect(new Set(cases.map((c) => c.channel))).toEqual(new Set(['sms', 'mms', 'email', 'messenger', 'instagram', 'web_chat', 'voice', 'fax']));
    for (const c of cases) if (c.expect !== 'allow' && c.expect !== 'CHANNEL_UNKNOWN' && !outOfScope(c)) expect(CORE_REASON[c.expect], c.id).toBeDefined();
  });

  for (const c of cases) {
    it(`${c.id}: ${c.why} ⇒ DB ${c.expect}`, () => {
      if (c.expect === 'CHANNEL_UNKNOWN' || outOfScope(c)) {
        // refused, never mapped (an unknown channel, or a DM channel out of scope under D2): the message channel map
        // throws, and so does the gate itself
        expect(() => gateChannelForMessage(c.channel)).toThrow(ChannelUnknownError);
        expect(() => canContact(gateInput({ recipient: { kind: 'contact', addressHmac: H1, channel: c.channel as Channel } }))).toThrow(ChannelUnknownError);
        return;
      }
      const d = canContact(caseInput(c));
      if (c.expect === 'allow') {
        // with every operational fact favourable, core does not invent a block the guard does not have
        expect(d, c.id).toMatchObject({ outcome: 'allow', reasons: [] });
      } else {
        expect(d.outcome, c.id).toBe('deny');
        expect(d.reasons, c.id).toContain(CORE_REASON[c.expect]);
      }
    });
  }

  it('core denies more, never less: with the chat widget disconnected, every web-chat case is denied', () => {
    for (const c of cases.filter((x) => x.channel === 'web_chat')) expect(canContact({ ...caseInput(c), connection: null }).outcome, c.id).toBe('deny');
  });
});
