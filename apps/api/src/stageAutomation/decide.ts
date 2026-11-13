// Stage-entry enrollment decision (PARITY_PLAN module 67; R-PAR-16, E172, R-PAR-5, D1). Pure and total:
// the reconcile reads the facts in one transaction under the contact lock and this decides.
//
// A stage entry starts at most one playbook, and only when ALL hold (R-PAR-16):
//   - a person changed the stage (an import, migration, merge copy or the system never auto-enrolls);
//   - not as a bulk action whose audience is built from a protected tag (R-PAR-8: a protected tag never defines the
//     audience of a bulk enrollment, and a bulk stage change into a plan's stage would be one; batch 5 review F1);
//   - the person still exists, is not merged, and is still in that stage (an Undo or a later change wins);
//   - the person who changed the stage still sees the person's detail by their own RLS;
//   - the chosen playbook has an APPROVED version (a draft, superseded or revoked version never runs);
//   - the person has no live (active or paused) enrollment: never a second one, never a silent replace;
//   - the person can be reached: at least one channel the playbook uses is not opted out (core canContact,
//     with the person's removed phones included, R-PAR-12).
// The playbook is chosen first (E172): the contact owner's own agent playbook for that stage wins, else the
// team's. An agent playbook never covers another agent's contacts. When the owner's own playbook exists but
// is not approved, that is the answer (skipped: plan_not_approved): the team plan does not start silently
// in its place, because the agent chose their own plan for this stage.
//
// Nothing here is a touch (R-PAR-5 / R-OWN-14) and nothing here sends: a started playbook's messages go
// through the playbook engine and comms/dispatch.ts under the approved version's rules.

export const SKIP_REASONS = [
  'not_a_person_change', // an import, migration or system stage change
  'protected_audience', // a bulk stage change of an audience built from a protected tag (R-PAR-8)
  'person_removed', // deleted or merged away
  'stage_changed_again', // the stage moved on before the plan could start (e.g. Undo)
  'not_visible', // the person who changed the stage no longer sees this person
  'plan_not_approved', // the plan has no approved version
  'already_in_a_plan', // a live enrollment exists
  'cannot_be_reached', // opted out on every channel the plan uses (or do-not-contact)
  'ai_isa_active', // R-ISA-2 (D12 proposed; b12 review B12X-4): the person is under live AI care, so no plan starts
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export function isSkipReason(s: string): s is SkipReason {
  return (SKIP_REASONS as readonly string[]).includes(s);
}

export interface StagePlaybook {
  id: string;
  name: string;
  scope: 'team' | 'agent';
  ownerUserId: string | null;
  /** the approved version, or null (draft only, superseded, revoked) */
  approvedVersionId: string | null;
}

export interface StageEntryFacts {
  /** who changed the stage, from contact_stage_events.actor_kind */
  actorKind: 'user' | 'system' | 'support' | 'none';
  /** the change was made by a bulk action whose audience is protected now (R-PAR-8; bulk/audience.ts) */
  protectedAudience: boolean;
  toStage: string;
  contact: { exists: boolean; deleted: boolean; merged: boolean; stage: string; ownerUserId: string | null };
  /** the stage-changer's own RLS shows the person's detail now */
  changerSeesDetail: boolean;
  /** active playbooks whose auto_enroll_stage is toStage (any scope, any owner) */
  candidates: readonly StagePlaybook[];
  liveEnrollment: boolean;
  /** at least one channel the chosen playbook uses is not opted out (core canContact) */
  reachable: boolean;
  /** R-ISA-2: the person (any record of them) has a live AI ISA assignment */
  aiIsaActive?: boolean;
}

export type StageDecision =
  | { kind: 'none' }
  | { kind: 'start'; playbook: StagePlaybook; versionId: string }
  | { kind: 'skip'; reason: SkipReason; playbook: StagePlaybook };

/** E172: the contact owner's own agent playbook wins, else the team's; never another agent's. Ties: lowest id. */
export function choosePlaybook(candidates: readonly StagePlaybook[], contactOwnerUserId: string | null): StagePlaybook | null {
  const byId = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const own = contactOwnerUserId === null ? undefined : byId.find((p) => p.scope === 'agent' && p.ownerUserId === contactOwnerUserId);
  return own ?? byId.find((p) => p.scope === 'team') ?? null;
}

export function decideStageEntry(f: StageEntryFacts): StageDecision {
  const playbook = choosePlaybook(f.candidates, f.contact.ownerUserId);
  if (playbook === null) return { kind: 'none' };
  const skip = (reason: SkipReason): StageDecision => ({ kind: 'skip', reason, playbook });
  if (f.actorKind !== 'user') return skip('not_a_person_change');
  if (f.protectedAudience) return skip('protected_audience');
  if (!f.contact.exists || f.contact.deleted || f.contact.merged) return skip('person_removed');
  if (f.contact.stage !== f.toStage) return skip('stage_changed_again');
  if (!f.changerSeesDetail) return skip('not_visible');
  if (playbook.approvedVersionId === null) return skip('plan_not_approved');
  if (f.aiIsaActive === true) return skip('ai_isa_active');
  if (f.liveEnrollment) return skip('already_in_a_plan');
  if (!f.reachable) return skip('cannot_be_reached');
  return { kind: 'start', playbook, versionId: playbook.approvedVersionId };
}

/** What the person who changed the stage is told (PARITY_PLAN §4.4 67): the stage-change response field. */
export type AutomationOutcome = { started: string } | { skipped: SkipReason; plan: string } | null;

export function outcomeOf(d: { outcome: 'started' | 'skipped'; reason: string | null; playbookName: string | null } | null): AutomationOutcome {
  if (d === null || d.playbookName === null) return null;
  if (d.outcome === 'started') return { started: d.playbookName };
  return d.reason !== null && isSkipReason(d.reason) ? { skipped: d.reason, plan: d.playbookName } : null;
}

// ---- opt-out reachability (D1) --------------------------------------------------------------------------

/** canContact reason codes that mean "this person may not be messaged on this channel" (opt-outs only). */
export const OPT_OUT_REASONS: ReadonlySet<string> = new Set(['CONSENT_REVOKED', 'SUPPRESSED', 'PERSON_DO_NOT_CONTACT', 'WRONG_NUMBER']);

/** One channel the playbook uses: whether the person has an address on it, and canContact's reasons there. */
export interface ChannelReach {
  hasAddress: boolean;
  reasons: readonly string[];
}

/**
 * Reachable when some channel the playbook messages on has an address that no opt-out blocks. Other
 * gate reasons (sender, hours, content) are decided at send time by dispatch and never skip the plan here.
 * A playbook with no messaging step is reachable (it sends nothing).
 */
export function reachableOn(channels: readonly ChannelReach[]): boolean {
  if (channels.length === 0) return true;
  return channels.some((c) => c.hasAddress && !c.reasons.some((r) => OPT_OUT_REASONS.has(r)));
}
