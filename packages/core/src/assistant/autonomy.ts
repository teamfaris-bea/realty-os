// Autonomy policy: when the assistant may act without a human tap (A3, A7a/b; R-AST-3, R-AST-4,
// R-AST-6, R-AST-7, R-AST-11, R-AST-17, R-GATE-4 pure part; E16, E32, E35).
//
// The assistant sends on its own ONLY when every one of these holds at send time:
//   1. the category is one a tenant can make autonomous, it is switched on for the tenant, and it
//      is never one of the always-human categories (money, contract, novel_message, seller_update);
//   2. the message comes from a playbook step of that same category;
//   3. the playbook version is `approved` and its latest approval row is an `approve` bound to the
//      version's exact content hash (a revoke row, or a hash mismatch, stops it);
//   4. the rendered text passes the content guard (no money/contract topic, no human claim,
//      sign-off present, first-message identity lines, no unknown links, within length);
//   5. the novelty check says the personalized text still matches the step's declared intent.
// Anything else becomes a draft for the agent (`requires_approval`). The send-time gate
// (canContact) runs after this, always.
import { type ActionCategory, ALWAYS_HUMAN_CATEGORIES, AUTONOMOUS_ELIGIBLE } from '../compliance/index.js';
import { type GuardIssue, contentGuard, topicCategory } from './guard.js';
import type { PlaybookStep } from './playbook.js';
import type { IdentityFacts } from './types.js';

export type DowngradeReason =
  | 'ALWAYS_HUMAN_CATEGORY'
  | 'CATEGORY_NOT_AUTONOMOUS'
  | 'CATEGORY_DISABLED'
  | 'STEP_CATEGORY_MISMATCH'
  | 'NO_PLAYBOOK_VERSION'
  | 'VERSION_NOT_APPROVED'
  | 'NO_APPROVAL'
  | 'APPROVAL_REVOKED'
  | 'APPROVAL_HASH_MISMATCH'
  | 'PAYMENT_INSTRUCTIONS'
  | 'CONTENT_GUARD'
  | 'INTENT_MISMATCH';

export interface VersionFacts {
  status: string;
  contentSha256: string;
}
export interface ApprovalFacts {
  decision: 'approve' | 'revoke';
  contentSha256: string;
}

/** The version is approved and its latest approval row approves exactly this content (R-AST-4). */
export function approvalCurrent(version: VersionFacts | null, latest: ApprovalFacts | null): boolean {
  return version !== null && version.status === 'approved' && latest !== null && latest.decision === 'approve' && latest.contentSha256 === version.contentSha256;
}

export type AuthorizeResult = { allow: true } | { allow: false; downgrade: DowngradeReason; guardIssues?: GuardIssue[]; category?: 'money' | 'contract' };

/**
 * Spec correction (reported): the content guard needs the identity (sign-off, brokerage name,
 * allowed link hosts) and whether this is the first message in the thread, so both are inputs.
 */
export function authorizeAutonomousAction(i: {
  category: ActionCategory;
  playbookVersion: VersionFacts | null;
  latestApproval: ApprovalFacts | null;
  tenantAutonomous: ReadonlySet<ActionCategory>;
  step: PlaybookStep;
  rendered: string;
  intentCheck: 'match' | 'mismatch';
  identity: IdentityFacts;
  firstInThread: boolean;
}): AuthorizeResult {
  if (ALWAYS_HUMAN_CATEGORIES.has(i.category)) return { allow: false, downgrade: 'ALWAYS_HUMAN_CATEGORY' };
  if (!AUTONOMOUS_ELIGIBLE.has(i.category)) return { allow: false, downgrade: 'CATEGORY_NOT_AUTONOMOUS' };
  if (!i.tenantAutonomous.has(i.category)) return { allow: false, downgrade: 'CATEGORY_DISABLED' };
  if (i.step.category !== i.category) return { allow: false, downgrade: 'STEP_CATEGORY_MISMATCH' };
  if (i.playbookVersion === null) return { allow: false, downgrade: 'NO_PLAYBOOK_VERSION' };
  if (i.playbookVersion.status !== 'approved') return { allow: false, downgrade: 'VERSION_NOT_APPROVED' };
  if (i.latestApproval === null) return { allow: false, downgrade: 'NO_APPROVAL' };
  if (i.latestApproval.decision === 'revoke') return { allow: false, downgrade: 'APPROVAL_REVOKED' };
  if (i.latestApproval.contentSha256 !== i.playbookVersion.contentSha256) return { allow: false, downgrade: 'APPROVAL_HASH_MISMATCH' };
  const g = contentGuard(i.rendered, i.step, i.identity, { firstInThread: i.firstInThread, requireSignOff: true });
  if (g.hardBlock) return { allow: false, downgrade: 'PAYMENT_INSTRUCTIONS', guardIssues: g.issues, category: 'money' };
  if (!g.pass) return g.category === null ? { allow: false, downgrade: 'CONTENT_GUARD', guardIssues: g.issues } : { allow: false, downgrade: 'CONTENT_GUARD', guardIssues: g.issues, category: g.category };
  if (i.intentCheck !== 'match') return { allow: false, downgrade: 'INTENT_MISMATCH' };
  return { allow: true };
}

/** The agent-facing sentence for a downgrade (the draft card's explanation, ≤ 300 chars). */
export function downgradeExplanation(d: DowngradeReason, category?: 'money' | 'contract'): string {
  switch (d) {
    case 'ALWAYS_HUMAN_CATEGORY':
      return 'Money, contracts and new kinds of messages always need your tap.';
    case 'CATEGORY_NOT_AUTONOMOUS':
    case 'CATEGORY_DISABLED':
      return 'The team has not turned on automatic sending for this kind of message, so it waits for you.';
    case 'STEP_CATEGORY_MISMATCH':
    case 'NO_PLAYBOOK_VERSION':
      return 'This is not part of an approved playbook, so it waits for you.';
    case 'VERSION_NOT_APPROVED':
    case 'NO_APPROVAL':
      return 'The playbook is not approved, so this waits for you.';
    case 'APPROVAL_REVOKED':
      return 'The playbook approval was revoked, so this waits for you.';
    case 'APPROVAL_HASH_MISMATCH':
      return 'The playbook changed after it was approved, so this waits for you.';
    case 'PAYMENT_INSTRUCTIONS':
      return "For safety, wiring details can't be sent by text or email from here.";
    case 'CONTENT_GUARD':
      if (category === 'money') return 'It mentions money (price, offers, commission or deposits), so it needs your tap.';
      if (category === 'contract') return 'It mentions a contract or agreement, so it needs your tap.';
      return 'The wording needs a quick check before it goes out.';
    case 'INTENT_MISMATCH':
      return 'The personalized wording drifted from what the playbook approved, so it waits for you.';
  }
}

// ---- assistant_actions classification -----------------------------------------------------------

export type ActionKind =
  | 'message_draft'
  | 'autonomous_message'
  | 'call_summary'
  | 'handback'
  | 'promise_extraction'
  | 'saved_search_proposal'
  | 'next_step'
  | 'lead_summary'
  | 'seller_update_draft'
  | 'weekly_plan';

export type StoredCategory = Exclude<ActionCategory, 'none' | 'opt_out_confirmation' | 'help_reply' | 'agent_alert'> | 'internal';

/**
 * The (kind, action_category, autonomy) triple for an assistant_actions row, always consistent
 * with the table's CHECKs: internal kinds are `internal`; seller updates always require approval
 * (R-AST-17); within_playbook only for an authorized autonomous message on a playbook version.
 */
export function classifyAction(i: { kind: ActionKind; category: StoredCategory; authorized: boolean; playbookVersionId: string | null }): {
  kind: ActionKind;
  category: StoredCategory;
  autonomy: 'requires_approval' | 'within_playbook' | 'internal';
} {
  const internalKinds: ActionKind[] = ['call_summary', 'promise_extraction', 'saved_search_proposal', 'next_step', 'lead_summary', 'weekly_plan'];
  if (internalKinds.includes(i.kind)) return { kind: i.kind, category: 'internal', autonomy: 'internal' };
  if (i.kind === 'seller_update_draft' || i.category === 'seller_update') return { kind: 'seller_update_draft', category: 'seller_update', autonomy: 'requires_approval' };
  const neverAuto = i.category === 'internal' || ALWAYS_HUMAN_CATEGORIES.has(i.category);
  if (i.kind === 'autonomous_message' && i.authorized && i.playbookVersionId !== null && !neverAuto) {
    return { kind: 'autonomous_message', category: i.category, autonomy: 'within_playbook' };
  }
  const kind: ActionKind = i.kind === 'autonomous_message' ? 'message_draft' : i.kind;
  return { kind, category: i.category === 'internal' ? 'novel_message' : i.category, autonomy: 'requires_approval' };
}

/**
 * The category of a reply drafted outside a playbook (handbacks, "draft a reply"): money or
 * contract when either the client's message or the draft touches it (E35), else novel_message.
 * Either way a human taps send.
 */
export function draftCategory(i: { inboundText?: string | null; draftText?: string | null }): 'money' | 'contract' | 'novel_message' {
  const a = i.inboundText ? topicCategory(i.inboundText) : null;
  const b = i.draftText ? topicCategory(i.draftText) : null;
  if (a === 'money' || b === 'money') return 'money';
  if (a === 'contract' || b === 'contract') return 'contract';
  return 'novel_message';
}

// ---- approving a draft ----------------------------------------------------------------------------

export type DraftCheck = { ok: true } | { ok: false; code: 'DRAFT_STALE' | 'DRAFT_INVALIDATED' };

/**
 * Before a draft or handback reply is approved:
 *  - R-AST-7: it is invalidated when the contact's owner or ownership period differs from the one
 *    it was drafted for (in-period events such as the first touch do not change the period);
 *  - R-AST-6: it is stale when the client wrote again after it was drafted ("Jane replied since
 *    this was drafted") and needs re-review.
 * Invalidation wins (an invalidated draft cannot be re-reviewed into validity).
 */
export function checkDraftCurrent(i: {
  draft: { ownerUserId: string | null; boundOwnershipSeq: number | bigint | null; pinnedInboundSeq: number | bigint | null };
  contact: { ownerUserId: string | null; ownershipPeriodSeq: number | bigint | null };
  conversation: { inboundSeq: number | bigint } | null;
}): DraftCheck {
  const same = (a: number | bigint | null, b: number | bigint | null): boolean => (a === null || b === null ? a === b : BigInt(a) === BigInt(b));
  if (i.draft.ownerUserId !== i.contact.ownerUserId || !same(i.draft.boundOwnershipSeq, i.contact.ownershipPeriodSeq)) return { ok: false, code: 'DRAFT_INVALIDATED' };
  if (i.conversation !== null) {
    const pinned = i.draft.pinnedInboundSeq === null ? -1n : BigInt(i.draft.pinnedInboundSeq);
    if (pinned < BigInt(i.conversation.inboundSeq)) return { ok: false, code: 'DRAFT_STALE' };
  }
  return { ok: true };
}
