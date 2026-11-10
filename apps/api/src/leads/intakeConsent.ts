// Consent history captured at intake (R-CONSENT-4, E38; history only since owner decision D1).
//
// A lead source may post the exact consent language the person saw (or the source has one configured).
// In the intake transaction, as the system actor:
//   1 the text is stored once per tenant in consent_disclosures (body_sha256 = sha256(body), DB CHECK;
//     UNIQUE (tenant_id, body_sha256), so a repeated text reuses its row)
//   2 core levelForDisclosure decides the level: `express_written` only when the text names this tenant
//     (brokerage legal name or team name), otherwise `inquiry` expiring after the policy's inquiry window
//     (jurisdiction packs; platform floor 90 d; VERIFY WITH COUNSEL)
//   3 one grant per supplied address and channel in the disclosure's scope goes through db
//     recordConsentEvent (event + consent_state projection in this transaction, R-CONSENT-6)
//
// Since D1 no send reads the level: this never changes who can be messaged. It also never lifts an
// opt-out: a key that is `revoked` for a purpose gets no event for that purpose (the fold would treat a
// system-written lead_provider grant with a disclosure as the person's own action, R-CONSENT-10, and a
// provider re-post is not clearly that), so the disclosure is kept on the inquiry and the opt-out stands.
import { type Channel, type ConsentEventSpec, type EventPurpose, PLATFORM_FLOOR, levelForDisclosure, sha256Hex } from '@realty/core/compliance';
import type { IdGenerator, Instant } from '@realty/core/foundation';
import { type Tx, recordConsentEvent } from '@realty/db';
import type { z } from 'zod';
import { hint } from '../comms/dispatch.js';
import { PolicyUnavailableError, resolvedPolicy } from '../comms/gateInput.js';
import * as g from '../comms/repos/gate.js';
import { LEDGER_SYSTEM } from '../comms/types.js';
import * as repo from './repos/intake.js';
import type { ConsentDisclosureInput } from './schemas.js';

export type DisclosureInput = z.output<typeof ConsentDisclosureInput>;

const ALL_CHANNELS = ['sms', 'voice', 'email'] as const;
const ALL_PURPOSES = ['marketing', 'informational'] as const;

/** A website lead source is the tenant's own form; every other source kind is a lead provider. */
export function disclosureSourceKind(leadSourceKind: string): 'own_form' | 'lead_provider' {
  return leadSourceKind === 'website' ? 'own_form' : 'lead_provider';
}

/** Stores (or reuses) the disclosure text verbatim. */
export async function storeDisclosure(tx: Tx, ids: IdGenerator, d: DisclosureInput, sourceKind: 'own_form' | 'lead_provider'): Promise<repo.DisclosureRow> {
  const channels = ALL_CHANNELS.filter((c) => (d.channels ?? ALL_CHANNELS).includes(c));
  const purposes = ALL_PURPOSES.filter((p) => (d.purposes ?? ALL_PURPOSES).includes(p));
  return repo.upsertDisclosure(tx, {
    id: ids.next<'ConsentDisclosureId'>(),
    channelScope: channels,
    purposeScope: purposes,
    body: d.text,
    bodySha256: sha256Hex(d.text),
    namesSeller: d.namesSeller,
    sourceKind,
  });
}

/** The tenant's names and the inquiry window of its active policy (packs); the floor if a pack is invalid. */
async function tenantTerms(tx: Tx): Promise<{ names: (string | null)[]; inquiryBasisDays: number; window: 'policy' | 'platform_floor' }> {
  try {
    const { policy, tenant } = await resolvedPolicy(tx);
    return { names: [tenant.brokerageLegalName, tenant.teamName], inquiryBasisDays: policy.inquiryBasisDays, window: 'policy' };
  } catch (e) {
    // an invalid pack must not drop the lead; the level is history only (D1)
    if (!(e instanceof PolicyUnavailableError)) throw e;
    const tenant = await g.tenantFacts(tx);
    return { names: [tenant.brokerageLegalName, tenant.teamName], inquiryBasisDays: PLATFORM_FLOOR.maxInquiryBasisDays, window: 'platform_floor' };
  }
}

export interface InquiryConsentInput {
  ids: IdGenerator;
  disclosure: repo.DisclosureRow;
  occurredAt: Instant;
  contactId: string;
  inquiryId: string;
  leadSourceId: string;
  phones: readonly { e164: string; hmac: string }[];
  emails: readonly { email: string; hmac: string }[];
}

/** Records the inquiry's consent grants (one per address × channel in scope). Returns how many were written. */
export async function recordInquiryConsent(tx: Tx, i: InquiryConsentInput): Promise<number> {
  const d = i.disclosure;
  const terms = await tenantTerms(tx);
  const { level, expiresAt } = levelForDisclosure({ namesSeller: d.names_seller, tenantNames: terms.names, occurredAt: i.occurredAt, inquiryBasisDays: terms.inquiryBasisDays });
  const source = d.source_kind === 'own_form' ? 'web_form' : 'lead_provider';
  const scope = new Set<string>(d.channel_scope);
  const targets: { kind: 'phone' | 'email'; address: string; hmac: string; channel: Channel }[] = [];
  for (const p of i.phones) for (const channel of ['sms', 'voice'] as const) if (scope.has(channel)) targets.push({ kind: 'phone', address: p.e164, hmac: p.hmac, channel });
  if (scope.has('email')) for (const e of i.emails) targets.push({ kind: 'email', address: e.email, hmac: e.hmac, channel: 'email' });

  let written = 0;
  for (const t of targets) {
    // never lift an opt-out (see the header): skip every purpose this key is revoked for
    const revoked = new Set((await g.consentRows(tx, t.channel, [t.hmac])).filter((r) => r.status === 'revoked').map((r) => r.purpose));
    const purposes = d.purpose_scope.filter((p) => !revoked.has(p));
    if (purposes.length === 0) continue;
    const purpose: EventPurpose = purposes.length === ALL_PURPOSES.length ? 'all' : (purposes[0] as EventPurpose);
    const spec: ConsentEventSpec = {
      id: i.ids.next<'ConsentEventId'>(),
      addressKind: t.kind,
      addressHmac: t.hmac,
      addressHint: hint(t.address),
      channel: t.channel,
      purpose,
      eventType: 'grant',
      level,
      source,
      occurredAt: i.occurredAt,
      contactId: i.contactId,
      actor: LEDGER_SYSTEM,
      disclosureId: d.id,
      evidenceObjectId: null,
      evidenceMessageId: null,
      evidenceCallId: null,
      evidenceCallOffsetMs: null,
      evidence: {
        lead_inquiry_id: i.inquiryId,
        lead_source_id: i.leadSourceId,
        names_tenant: level === 'express_written',
        ...(level === 'inquiry' ? { inquiry_basis_days: terms.inquiryBasisDays, inquiry_window_source: terms.window } : {}),
      },
      imported: false,
      importRecordId: null,
      originalProvenance: null,
      revertsEventId: null,
      expiresAt,
      needsReview: false,
    };
    await recordConsentEvent(tx, spec);
    written++;
  }
  return written;
}
