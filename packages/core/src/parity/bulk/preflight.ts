// Bulk preflight (PARITY_PLAN §4.2 and module 62; R-PAR-8, R-PAR-33..R-PAR-40, Q-PAR-9; D1).
//
// Two pure decisions, used at draft (the preview the creator confirms) and again for every item at run
// time, one transaction per item, as the creator:
//
//   bulkActionPreflight(facts)          the action as a whole: who may run this kind, the caps, the
//                                       protected-proxy audience (R-PAR-8), the batch-text switch
//                                       (R-PAR-40), the marketing identity a bulk email needs (R-PAR-39)
//   bulkPreflight(kind, person, facts)  one person: visible, live, permitted, then the kind's checks.
//                                       For a send it runs core canContact itself (the SAME checks the
//                                       send path runs: opt-outs on any of the person's phones,
//                                       unsubscribe, suppressions, person-level do-not-contact, with no
//                                       override and no bulk exemption, D1), then the bulk-only skips:
//                                       one send per address (R-PAR-38), "wrote in the last 24 h" for
//                                       bulk email (Q-PAR-9) and an empty merge field (R-PAR-24).
//
// Nothing here can include someone the gate would block: there is no option to pre-tick, and the DB
// guards decide again at send time.
import { type GateInput, type ReasonCode, canContact } from '../../compliance/index.js';
import { type Instant, type ResourceFacts, type Result, type Role, type UserActor, can, fail, ok, HOUR_MS } from '../../foundation/index.js';
import { type BulkKind, type CapErrorCode, checkBulkSize, checkDailyEmailCap, isSendKind } from './caps.js';

/** The fixed eight stages (contacts.stage CHECK; R-PAR-13). */
export const STAGES = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

/** A person is a contact with the tag limit of R-PAR-6. */
export const TAGS_PER_PERSON = 100;
/** Q-PAR-9: a bulk email skips people who wrote in within this window. */
export const RECENT_INBOUND_MS = 24 * HOUR_MS;

/**
 * Why one person is left out of (or stopped in) a bulk action. Every reason is shown to the creator by
 * count before Confirm and in the bulk_finished notice; nobody is hidden (PARITY_PLAN §5 honest UI).
 */
export const SKIP_REASONS = [
  'NOT_VISIBLE', // the creator no longer sees this person's detail (reassigned away, E183)
  'MERGED', // merged into another person
  'DELETED', // deleted
  'NOT_PERMITTED', // the creator's role may not do this to this person (can())
  'NO_ADDRESS', // no live email / phone for this send
  'SHARED_ADDRESS', // someone earlier in the action has the same address: one send per address (R-PAR-38)
  'RECIPIENT_OPTED_OUT', // STOP / unsubscribe on this address or (texts) any of the person's phones, removed ones included (R-PAR-12)
  'RECIPIENT_SUPPRESSED', // bounce, complaint or a do-not-contact request on the address
  'PERSON_DO_NOT_CONTACT', // person-level do-not-contact
  'RECENT_INBOUND', // wrote in within 24 h: answer them one to one (Q-PAR-9, bulk email)
  'MERGE_FIELD_EMPTY', // the template needs a value this person does not have (R-PAR-24)
  'ALREADY_TAGGED',
  'NOT_TAGGED',
  'TAG_LIMIT', // already has 100 tags (R-PAR-6)
  'ALREADY_IN_STAGE',
  'STAGE_NEEDS_CONTACT', // R-PAR-14: an untouched routed lead stays in new/attempting until reached
  'ALREADY_OWNER',
  'CLOSED', // assign: the person is closed; the engine assigns no closed lead (reopen it first; batch 6 review F6)
  'ALREADY_ENROLLED',
  'UNREACHABLE', // no channel the playbook could use
  'CLIENT_REPLIED', // the person replied between queue and dispatch (R-PAR-36)
  'BATCH_TEXT_DISABLED', // the Owner turned batch text off mid-run (R-PAR-40, E185)
  'CANCELED', // the action was canceled before this item ran (R-PAR-42)
  'CREATOR_INACTIVE', // the creator was suspended or removed: the run stops (R-PAR-34)
  'SEND_BLOCKED', // the send gate blocked it for another reason (a wrong number, a landline for a text, …)
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** The send gate's opt-out reasons, as the bulk skip reason the creator sees (and the DB guard's code). */
export const GATE_OPT_OUT_SKIPS: Readonly<Partial<Record<ReasonCode, SkipReason>>> = Object.freeze({
  PERSON_DO_NOT_CONTACT: 'PERSON_DO_NOT_CONTACT',
  CONSENT_REVOKED: 'RECIPIENT_OPTED_OUT',
  SUPPRESSED: 'RECIPIENT_SUPPRESSED',
});

/**
 * The one skip reason for a set of gate (or dispatch) reasons: an opt-out wins over everything (so the
 * count of "unsubscribed" is honest), person-level first; anything else is SEND_BLOCKED.
 */
export function skipForGateReasons(reasons: readonly string[]): SkipReason {
  for (const r of ['PERSON_DO_NOT_CONTACT', 'CONSENT_REVOKED', 'SUPPRESSED'] as const) if (reasons.includes(r)) return GATE_OPT_OUT_SKIPS[r]!;
  // the DB dispatch guards' own codes (when core was bypassed)
  if (reasons.includes('RECIPIENT_OPTED_OUT')) return 'RECIPIENT_OPTED_OUT';
  if (reasons.includes('RECIPIENT_SUPPRESSED')) return 'RECIPIENT_SUPPRESSED';
  if (reasons.includes('BATCH_TEXT_DISABLED')) return 'BATCH_TEXT_DISABLED';
  if (reasons.includes('SENDER_NOT_AUTHORIZED')) return 'NOT_VISIBLE';
  return 'SEND_BLOCKED';
}

// ---- the action as a whole ----------------------------------------------------------------------

export type BulkActionErrorCode =
  | CapErrorCode
  | 'BULK_NOT_PERMITTED'
  | 'AUDIENCE_PROTECTED_PROXY'
  | 'TAG_PROTECTED'
  | 'BATCH_TEXT_DISABLED'
  | 'EMAIL_DOMAIN_UNVERIFIED'
  | 'POSTAL_ADDRESS_MISSING'
  | 'BROKERAGE_IDENTITY_MISSING'
  | 'SMS_MARKETING_NOT_REGISTERED'
  | 'PLAYBOOK_NOT_APPROVED'
  | 'TEMPLATE_CHANNEL_MISMATCH';

export interface BulkActionFacts {
  kind: BulkKind;
  role: Role;
  /** people selected (before any skip); every cap is on this number */
  selected: number;
  /** the audience is defined by (or the chosen tag is) a protected-proxy tag (R-PAR-8) */
  audienceProtected: boolean;
  /** tag/untag: the tag applied is protected (never applied in bulk, review S7) */
  tagProtected?: boolean;
  /** text: tenant_settings.batch_text_enabled */
  batchTextEnabled?: boolean;
  /** email: the sender's email identity is on a verified domain */
  emailDomainVerified?: boolean;
  postalAddressPresent?: boolean;
  brokerageNamePresent?: boolean;
  /** text: a sender registration that is approved and whose use case covers marketing */
  smsMarketingRegistered?: boolean;
  /** enroll: the playbook has an approved current version */
  playbookApproved?: boolean;
  /** send: the template's channel matches the action's */
  templateChannelMatches?: boolean;
  /** email: recipients of bulk emails confirmed today in the tenant (any creator) */
  emailsConfirmedToday?: number;
}

const RUNS: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'team_lead', 'agent', 'isa']);
const ASSIGNS: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'team_lead']);

/** The action-level refusal, checked at draft and again at confirm. Missing facts fail closed. */
export function bulkActionPreflight(f: BulkActionFacts): Result<object, BulkActionErrorCode, { cap?: number; remaining?: number }> {
  // R-PAR-35: TCs run none; only Owner/Admin/TL assign (also the DB CHECKs)
  if (!RUNS.has(f.role) || (f.kind === 'assign' && !ASSIGNS.has(f.role))) return fail('BULK_NOT_PERMITTED');
  const size = checkBulkSize(f.kind, f.selected);
  if (!size.ok) return size;
  if ((f.kind === 'tag' || f.kind === 'untag') && f.tagProtected !== false) return fail('TAG_PROTECTED');
  // a protected tag never defines who gets a bulk send or an enrollment (R-PAR-8, E189; no override)
  if ((isSendKind(f.kind) || f.kind === 'enroll') && f.audienceProtected) return fail('AUDIENCE_PROTECTED_PROXY');
  if (isSendKind(f.kind) && f.templateChannelMatches !== true) return fail('TEMPLATE_CHANNEL_MISMATCH');
  if (f.kind === 'text') {
    if (f.batchTextEnabled !== true) return fail('BATCH_TEXT_DISABLED');
    if (f.brokerageNamePresent !== true) return fail('BROKERAGE_IDENTITY_MISSING');
    if (f.smsMarketingRegistered !== true) return fail('SMS_MARKETING_NOT_REGISTERED');
  }
  if (f.kind === 'email') {
    // R-PAR-39: always marketing: brokerage identity, postal address and a verified sending domain
    if (f.brokerageNamePresent !== true) return fail('BROKERAGE_IDENTITY_MISSING');
    if (f.postalAddressPresent !== true) return fail('POSTAL_ADDRESS_MISSING');
    if (f.emailDomainVerified !== true) return fail('EMAIL_DOMAIN_UNVERIFIED');
    const daily = checkDailyEmailCap(f.emailsConfirmedToday ?? Number.NaN, f.selected);
    if (!daily.ok) return daily;
  }
  if (f.kind === 'enroll' && f.playbookApproved !== true) return fail('PLAYBOOK_NOT_APPROVED');
  return ok();
}

// ---- one person ---------------------------------------------------------------------------------

/** What every kind needs to know about one person, read under the creator's RLS. */
export interface BulkPersonFacts {
  /** app.contact_detail_visible for the creator (a pond/offer card is not enough) */
  detailVisible: boolean;
  merged: boolean;
  deleted: boolean;
  /** the creator's relation to the person, for can() (own / collaborator / team) */
  access: ResourceFacts;
}

export interface SendPersonFacts {
  /** the frozen recipient's address HMAC (hex); null = the person has no live address for this channel */
  addressHmac: string | null;
  /** an earlier person in this action already has this address */
  sharedWithEarlier: boolean;
  /** the full send-time gate input for this person (purpose marketing, initiator human); null with no address */
  gate: GateInput | null;
  /** contacts.last_inbound_at (email: Q-PAR-9) */
  lastInboundAt: Instant | null;
  /** the template rendered for this person: ok, or empty merge fields (R-PAR-24) */
  rendered: { ok: true } | { ok: false; code: string };
}

export type BulkKindFacts =
  | { kind: 'tag'; alreadyTagged: boolean; tagCount: number }
  | { kind: 'untag'; tagged: boolean }
  | { kind: 'stage'; currentStage: Stage; toStage: Stage; firstTouchPending: boolean }
  | {
      kind: 'assign';
      ownerUserId: string | null;
      toUserId: string;
      target: { role: Role; inMyTeam: boolean };
      /** contacts.ownership_state: a closed person is never assigned (decideAssign refuses it); absent: not read */
      ownershipState?: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
    }
  | { kind: 'enroll'; liveEnrollment: boolean; reachable: boolean }
  | ({ kind: 'email' } & SendPersonFacts)
  | ({ kind: 'text' } & SendPersonFacts);

export interface BulkRunContext {
  /** the creator, rebuilt from the action row while their membership is active */
  actor: UserActor;
  now: Instant;
}

export type PreflightResult = { ok: true } | { ok: false; reason: SkipReason; gateReasons?: string[] };

function permitted(kind: BulkKind, person: BulkPersonFacts, k: BulkKindFacts, actor: UserActor): boolean {
  switch (kind) {
    case 'assign': {
      const t = k.kind === 'assign' ? k.target : undefined;
      return can(actor, 'bulk.assign', { ...person.access, ...(t ? { target: t } : {}) }).ok;
    }
    case 'text':
      return can(actor, 'bulk.text', person.access).ok;
    default:
      return can(actor, 'bulk.run', person.access).ok;
  }
}

const skip = (reason: SkipReason, gateReasons?: string[]): PreflightResult => (gateReasons ? { ok: false, reason, gateReasons } : { ok: false, reason });

/**
 * One person in a bulk action. `kind` must match `facts.kind` (a programming error otherwise).
 * The order is the order the creator reads the counts in: first who is out of reach, then opt-outs,
 * then the kind's own reasons.
 */
export function bulkPreflight(kind: BulkKind, person: BulkPersonFacts, facts: BulkKindFacts, run: BulkRunContext): PreflightResult {
  if (facts.kind !== kind) throw new TypeError(`bulkPreflight: facts for ${facts.kind}, action is ${kind}`);
  if (!person.detailVisible) return skip('NOT_VISIBLE');
  if (person.merged) return skip('MERGED');
  if (person.deleted) return skip('DELETED');
  if (!permitted(kind, person, facts, run.actor)) return skip('NOT_PERMITTED');
  switch (facts.kind) {
    case 'tag':
      if (facts.alreadyTagged) return skip('ALREADY_TAGGED');
      if (facts.tagCount >= TAGS_PER_PERSON) return skip('TAG_LIMIT');
      return { ok: true };
    case 'untag':
      return facts.tagged ? { ok: true } : skip('NOT_TAGGED');
    case 'stage':
      if (facts.currentStage === facts.toStage) return skip('ALREADY_IN_STAGE');
      // R-PAR-14 per item (mirrors contacts_stage_guard; module 56's stageChangeAllowed is the same rule)
      if ((run.actor.role === 'agent' || run.actor.role === 'isa') && facts.firstTouchPending && facts.toStage !== 'new' && facts.toStage !== 'attempting') {
        return skip('STAGE_NEEDS_CONTACT');
      }
      return { ok: true };
    case 'assign':
      if (facts.ownershipState === 'closed') return skip('CLOSED');
      return facts.ownerUserId === facts.toUserId ? skip('ALREADY_OWNER') : { ok: true };
    case 'enroll':
      if (facts.liveEnrollment) return skip('ALREADY_ENROLLED');
      return facts.reachable ? { ok: true } : skip('UNREACHABLE');
    case 'email':
    case 'text': {
      if (facts.addressHmac === null || facts.gate === null) return skip('NO_ADDRESS');
      if (facts.sharedWithEarlier) return skip('SHARED_ADDRESS');
      const g = facts.gate;
      // the gate input of a bulk send is a human marketing message on the action's channel, to this address
      if (g.purpose !== 'marketing' || g.initiator !== 'human' || g.recipient.addressHmac !== facts.addressHmac || g.recipient.channel !== (facts.kind === 'email' ? 'email' : 'sms')) {
        throw new TypeError('bulkPreflight: the gate input is not this bulk send');
      }
      const d = canContact(g);
      if (d.outcome === 'deny') return skip(skipForGateReasons(d.reasons), [...d.reasons]);
      if (facts.kind === 'email' && facts.lastInboundAt !== null && run.now - facts.lastInboundAt < RECENT_INBOUND_MS) {
        return skip('RECENT_INBOUND');
      }
      if (!facts.rendered.ok) return skip('MERGE_FIELD_EMPTY');
      return { ok: true };
    }
  }
}
