// Vocabulary of core/nurture (PHASE2_3_PLAN module 25; DATA_MODEL R-NURT-1..8, R-AVM-1..3).
//
// A trigger playbook turns FACTS into firings: a price decrease or a return to market on a listing a
// contact saved or was matched to, a closed deal's home anniversary, a monthly home value, and a
// confirmed deal date coming up. Signals (opens, clicks, page views, predictions) are not facts and
// cannot be expressed here (R-NURT-2). Each firing is one `playbook_step_runs` row with no
// enrollment and a unique `trigger_key` (R-NURT-1). Opt-outs are never checked here: the send-time
// gate and the DB guards do that (D1); nothing is dropped or deferred for compliance reasons here.
import type { EvidenceRef, TriggerKind } from '../assistant/index.js';
import type { Instant } from '../foundation/index.js';

export type { TriggerKind } from '../assistant/index.js';

export type ListingStatus = 'coming_soon' | 'active' | 'pending' | 'sold' | 'withdrawn' | 'expired';

/** Facts a trigger can fire from. There is deliberately no signal kind. */
export type Fact =
  | {
      kind: 'price_change';
      listingId: string;
      /** listing_price_history row: the firing key (one firing per contact and row). */
      historyId: string;
      source: 'team' | 'mls';
      oldPriceCents: number;
      newPriceCents: number;
      at: Instant;
      address: string;
      mlsNumber: string | null;
      /** listings.display_allowed (IDX); MLS rows that are not displayable never reach clients (E86). */
      displayAllowed: boolean;
      /** The MLS feed is within the licence pack's staleness limit (R-MLS-3); true for team rows. */
      feedFresh: boolean;
    }
  | {
      kind: 'status_change';
      listingId: string;
      historyId: string;
      source: 'team' | 'mls';
      from: ListingStatus;
      to: ListingStatus;
      at: Instant;
      address: string;
      mlsNumber: string | null;
      priceCents: number | null;
      displayAllowed: boolean;
      feedFresh: boolean;
    }
  | {
      kind: 'home_anniversary';
      dealId: string;
      contactId: string;
      /** `YYYY-MM-DD`, the closing date */
      closedOn: string;
      year: number;
      at: Instant;
      address: string;
    }
  | {
      kind: 'home_value';
      contactId: string;
      contactAddressId: string;
      /** `YYYY-MM` */
      month: string;
      valuationId: string;
      at: Instant;
      address: string;
    }
  | {
      kind: 'deal_date_upcoming';
      dealId: string;
      dealDateId: string;
      /** deal_dates.due_version: a moved date makes older firings stale (R-TXN-5, E96) */
      dueVersion: number;
      dueAt: Instant;
      label: string;
      contactIds: readonly string[];
      at: Instant;
    };

/** A trigger playbook version that may fire, as the API loaded it (approved, current). */
export interface TriggerPlaybookRef {
  playbookId: string;
  versionId: string;
  scope: 'team' | 'agent';
  /** agent playbooks: whose they are */
  ownerUserId: string | null;
  /** the trigger steps of the approved content, by trigger kind */
  steps: readonly { trigger: TriggerKind; stepKey: string; offsetSeconds: number }[];
}

/** A contact a fact may concern. The API pre-filters by relation; core re-checks it. */
export interface TriggerCandidate {
  contactId: string;
  /** current owner; an unowned contact gets no trigger message (R-NURT-7) */
  ownerUserId: string | null;
  relation: { kind: 'listing'; listingId: string; via: 'saved' | 'matched' } | { kind: 'contact' };
  playbook: TriggerPlaybookRef;
}

/** One firing = one playbook_step_runs row without an enrollment. */
export interface Firing {
  triggerKey: string;
  trigger: TriggerKind;
  contactId: string;
  playbookId: string;
  versionId: string;
  stepKey: string;
  scheduledFor: Instant;
  /** playbook_step_runs.trigger_ref (jsonb object): what to re-check at send time */
  ref: FiringRef;
  /** what the message cites; the API stores these as evidence_refs */
  evidence: EvidenceRef[];
}

export type FiringRef =
  | { kind: 'price_drop'; listingId: string; historyId: string; source: 'team' | 'mls'; oldPriceCents: number; newPriceCents: number; address: string; mlsNumber: string | null }
  | { kind: 'back_on_market'; listingId: string; historyId: string; source: 'team' | 'mls'; from: ListingStatus; address: string; mlsNumber: string | null; priceCents: number | null }
  | { kind: 'home_anniversary'; dealId: string; closedOn: string; year: number; address: string }
  | { kind: 'home_value'; contactAddressId: string; month: string; valuationId: string; address: string }
  | { kind: 'deal_date_upcoming'; dealId: string; dealDateId: string; dueVersion: number; dueAt: Instant; label: string };

/** Several firings for one contact and playbook inside the approved digest window (R-NURT-3). */
export interface Batch {
  contactId: string;
  playbookId: string;
  versionId: string;
  /** when the one message goes: the end of the window opened by the first firing */
  sendAt: Instant;
  firings: Firing[];
}

/** The fact as it stands at send time (R-NURT-4). */
export type FactState =
  | { kind: 'listing'; status: ListingStatus; priceCents: number | null; displayAllowed: boolean; feedFresh: boolean }
  | { kind: 'deal'; status: 'open' | 'closed' | 'canceled'; contactIsParty: boolean }
  | { kind: 'deal_date'; dueVersion: number; confirmed: boolean; dueAt: Instant | null }
  | { kind: 'home_value'; addressCurrent: boolean }
  | { kind: 'gone' };

export type SkipReason =
  | 'LISTING_INACTIVE'
  | 'PRICE_NOT_LOWER'
  | 'NOT_DISPLAYABLE'
  | 'MLS_STALE'
  | 'DATE_CHANGED'
  | 'DATE_UNCONFIRMED'
  | 'DATE_PASSED'
  | 'DEAL_NOT_CLOSED'
  | 'NOT_A_PARTY'
  | 'ADDRESS_NOT_CURRENT'
  | 'FACT_GONE'
  | 'FACT_MISMATCH'
  | 'NOT_OWNED'
  | 'OWNER_CHANGED'
  | 'APPROVAL_NOT_CURRENT'
  | 'NO_ESTIMATE'
  | 'ESTIMATE_NOT_DISPLAYABLE'
  | 'ESTIMATE_STALE'
  | 'CAPABILITY_NOT_CLEARED'
  | 'PAYMENT_INSTRUCTIONS'
  | 'NOTHING_LEFT';

/** Visible reason on the skipped run (never a silent drop). */
export const SKIP_REASON_TEXT: Readonly<Record<SkipReason, string>> = {
  LISTING_INACTIVE: 'The home is no longer on the market.',
  PRICE_NOT_LOWER: 'The price is no longer lower than before.',
  NOT_DISPLAYABLE: 'The listing broker does not allow this listing to be shown to clients.',
  MLS_STALE: 'MLS data is out of date, so MLS alerts are paused.',
  DATE_CHANGED: 'The date changed after this alert was planned.',
  DATE_UNCONFIRMED: 'The date is not confirmed by a person.',
  DATE_PASSED: 'The date has already passed.',
  DEAL_NOT_CLOSED: 'The deal is not closed.',
  NOT_A_PARTY: 'This contact is no longer a party to the deal.',
  ADDRESS_NOT_CURRENT: 'This is no longer the contact’s current address.',
  FACT_GONE: 'What this alert was about no longer exists.',
  FACT_MISMATCH: 'The current facts do not match this alert.',
  NOT_OWNED: 'Nobody owns this contact right now.',
  OWNER_CHANGED: 'The contact has a new owner; this agent’s alerts stop.',
  APPROVAL_NOT_CURRENT: 'The playbook approval is no longer current.',
  NO_ESTIMATE: 'No estimate available.',
  ESTIMATE_NOT_DISPLAYABLE: 'The estimate provider does not allow showing this estimate.',
  ESTIMATE_STALE: 'The estimate is out of date.',
  CAPABILITY_NOT_CLEARED: 'This kind of message waits for counsel review.',
  PAYMENT_INSTRUCTIONS: 'The message contained payment instructions and cannot be sent.',
  NOTHING_LEFT: 'Every item in this alert was skipped.',
};
