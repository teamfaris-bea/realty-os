// Parity module 62 acceptance, kept in module 63's tree because core is pure (no file reads, even in tests):
// bulkPreflight agrees with canContact on the shared opt-out case table (packages/db/test/fixtures/
// opt_out_cases.json, the table the DB dispatch guards are tested with). A bulk send is a human MARKETING
// text or email, so every case is evaluated as one; D1 stands: opt-outs block with no override.
import { readFileSync } from 'node:fs';
import { type Channel, type ConsentStateRow, type GateInput, PLATFORM_FLOOR, type SuppressionRow, canContact, parseJurisdictionPack, resolvePolicy } from '@realty/core/compliance';
import { type TenantId, type UserId, instant } from '@realty/core/foundation';
import { GATE_OPT_OUT_SKIPS, bulkPreflight } from '@realty/core/parity/bulk';
import { describe, expect, it } from 'vitest';

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
const POLICY = resolvePolicy(PLATFORM_FLOOR, [US.pack], { id: '00000000-0000-7000-8000-0000000000aa', autonomousCategories: [], optOutConfirmationSender: 'provider', recordingEnabled: true, recordingMode: 'announce_all', looseningAttestation: null });

interface RevokeFact { channel: Channel; purpose: 'all' | 'informational' | 'marketing' }
interface OptOutCase {
  id: string;
  why: string;
  channel: string;
  expect: string;
  purpose: 'informational' | 'marketing';
  initiator: string;
  recipientRevoked: RevokeFact[];
  otherPointRevoked: RevokeFact[];
  otherKindRevoked: RevokeFact[];
  suppression: { channel: SuppressionRow['channel']; reason: SuppressionRow['reason'] } | null;
  personDoNotContact: boolean;
  mergedDuplicateDoNotContact: boolean;
}
const table = JSON.parse(readFileSync(new URL('../../../../packages/db/test/fixtures/opt_out_cases.json', import.meta.url), 'utf8')) as { defaults: Omit<OptOutCase, 'id' | 'why' | 'channel' | 'expect'>; cases: (Partial<OptOutCase> & Pick<OptOutCase, 'id' | 'why' | 'channel' | 'expect'>)[] };
const cases: OptOutCase[] = table.cases.map((c) => ({ ...table.defaults, ...c }));
/** The channels a bulk action sends on: texts (sms; MMS is a text) and email. */
const bulkCases = cases.filter((c) => c.channel === 'sms' || c.channel === 'mms' || c.channel === 'email');

const rows = (addressHmac: string, r: RevokeFact): ConsentStateRow[] =>
  (r.purpose === 'all' ? (['informational', 'marketing'] as const) : [r.purpose]).map((purpose) => ({ channel: r.channel, purpose, addressHmac, status: 'revoked', level: 'none', basisEventId: 'e', expiresAt: null, ledgerEventCount: 1 }));

function gate(c: OptOutCase): GateInput {
  const ch: Channel = c.channel === 'email' ? 'email' : 'sms';
  return {
    now: NOW,
    recipient: { kind: 'contact', addressHmac: H1, channel: ch },
    purpose: 'marketing',
    initiator: 'human',
    category: 'none',
    consent: [...c.recipientRevoked.flatMap((r) => rows(H1, r)), ...c.otherPointRevoked.flatMap((r) => rows(H2, r)), ...c.otherKindRevoked.flatMap((r) => rows(H3, r))],
    suppressions: c.suppression ? [{ ...c.suppression, liftedAt: null }] : [],
    contactPoint: { status: 'active', lineType: 'mobile' },
    automationPausedAt: null,
    sender: ch === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : { kind: 'phone', registration: 'ready' },
    tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: true },
    rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false },
    policy: POLICY,
    personDoNotContact: c.personDoNotContact || c.mergedDuplicateDoNotContact,
    connection: null,
  };
}

/** Whether the case's blocking fact applies to a marketing send too (a purpose-specific informational revoke does not). */
function blocksMarketing(c: OptOutCase): boolean {
  if (c.purpose === 'marketing' || c.personDoNotContact || c.mergedDuplicateDoNotContact || c.suppression) return true;
  return [...c.recipientRevoked, ...c.otherPointRevoked].some((r) => r.purpose !== 'informational');
}

const actor = { kind: 'user' as const, userId: 'u' as UserId, tenantId: 't' as TenantId, role: 'agent' as const, sessionId: 's' };
const person = { detailVisible: true, merged: false, deleted: false, access: { own: true } };
const DB_TO_SKIP: Record<string, string> = { RECIPIENT_OPTED_OUT: 'RECIPIENT_OPTED_OUT', RECIPIENT_SUPPRESSED: 'RECIPIENT_SUPPRESSED', PERSON_DO_NOT_CONTACT: 'PERSON_DO_NOT_CONTACT' };

describe('R-PAR-36 bulkPreflight agrees with canContact on the shared opt-out case table (D1: no bulk exemption)', () => {
  it('reads the shared table and has text and email cases', () => {
    expect(bulkCases.length).toBeGreaterThanOrEqual(15);
    expect(GATE_OPT_OUT_SKIPS).toEqual({ PERSON_DO_NOT_CONTACT: 'PERSON_DO_NOT_CONTACT', CONSENT_REVOKED: 'RECIPIENT_OPTED_OUT', SUPPRESSED: 'RECIPIENT_SUPPRESSED' });
  });
  for (const c of bulkCases) {
    it(`R-PAR-36 ${c.id}: ${c.why} ⇒ DB ${c.expect}`, () => {
      const g = gate(c);
      const kind = c.channel === 'email' ? ('email' as const) : ('text' as const);
      const r = bulkPreflight(kind, person, { kind, addressHmac: H1, sharedWithEarlier: false, gate: g, lastInboundAt: null, rendered: { ok: true } }, { actor, now: NOW });
      const d = canContact(g);
      // the same verdict as the send gate, always
      expect(r.ok, c.id).toBe(d.outcome === 'allow');
      // and every case the DB guard blocks (for a marketing send) is skipped with the guard's own reason
      if (c.expect !== 'allow' && c.expect !== 'CHANNEL_UNKNOWN' && blocksMarketing(c)) {
        expect(r, c.id).toMatchObject({ ok: false, reason: DB_TO_SKIP[c.expect] ?? expect.any(String) });
        if (DB_TO_SKIP[c.expect]) expect(r).toMatchObject({ reason: DB_TO_SKIP[c.expect] });
      }
    });
  }
});
