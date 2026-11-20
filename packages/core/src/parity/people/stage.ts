// Stages (R-PAR-13, R-PAR-14, R-STG-1). The fixed eight; tenant labels only rename them for display, and the stage
// guide says what each one means.
//
// stageChangeAllowed mirrors the DB guard app.contacts_stage_guard (migration "fub_parity"): an Agent
// or ISA cannot move a routed lead whose first-touch SLA is unmet (owned, first_touch_due_at set,
// first_touch_at null) to any stage outside new/attempting, `lost` included. The UI uses
// lockedStages to show those stages locked BEFORE the tap ("Reach them first: Call · Text · Close").
// A logged outside activity never unlocks it (Q-PAR-2): only a real first touch sets first_touch_at.
import type { Role } from '../../foundation/authz.js';
import type { Instant } from '../../foundation/time.js';

export const STAGES = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
export type Stage = (typeof STAGES)[number];

/** Stages where the inactivity release (R-OWN-23) still applies: always open. */
export const OPEN_STAGES: readonly Stage[] = ['new', 'attempting'];

/** What a stage means, in the words the stage picker shows (R-STG-1). One line each. */
export interface StageGuideEntry {
  /** the default display label (a tenant's own label wins: stageLabel) */
  label: string;
  /** what is true of a person in this stage */
  definition: string;
  /** what the stage does NOT mean (the mistake agents make with it) */
  notThis: string;
}

/**
 * R-STG-1: the stage guide. The eight keys are the model (R-PAR-13) and never change here; the guide only describes
 * them. A stage says how far the relationship has come: buyer or seller, urgency and permission to text are separate
 * facts and no stage implies them. A label is display only: no trigger, enrollment or permission reads it.
 */
export const STAGE_GUIDE: Record<Stage, StageGuideEntry> = {
  new: {
    label: 'New lead',
    definition: 'They just came in and nobody has tried to reach them yet.',
    notThis: 'Does not mean anyone has called, texted or emailed them.',
  },
  attempting: {
    label: 'Trying to reach',
    definition: 'We tried to reach them but have not had a two-way conversation yet.',
    notThis: 'A voicemail or an unanswered text is not a conversation.',
  },
  connected: {
    label: 'Connected',
    definition: 'We have talked, but we are not actively working together yet.',
    notThis: 'Does not mean they are a client or have agreed to anything.',
  },
  nurture: {
    label: 'Long-term follow-up',
    definition: 'We have talked and they are months away, so we keep in touch.',
    notThis: 'Does not mean they went quiet or said no.',
  },
  active: {
    label: 'Active client',
    definition: 'We are working together now.',
    notThis: 'A reply or one good call does not make someone an active client.',
  },
  under_contract: {
    label: 'Under contract',
    definition: 'An offer was accepted and the sale has not closed yet.',
    notThis: 'Does not mean the sale has closed.',
  },
  closed: {
    label: 'Closed sale',
    definition: 'Their sale closed.',
    notThis: 'Does not mean we stop keeping in touch.',
  },
  lost: {
    label: 'Not moving forward',
    definition: 'We are not working together, as far as we know today.',
    notThis: 'Does not mean do not contact. Record that separately if they asked.',
  },
};

export const DEFAULT_STAGE_LABELS: Record<Stage, string> = {
  new: STAGE_GUIDE.new.label,
  attempting: STAGE_GUIDE.attempting.label,
  connected: STAGE_GUIDE.connected.label,
  nurture: STAGE_GUIDE.nurture.label,
  active: STAGE_GUIDE.active.label,
  under_contract: STAGE_GUIDE.under_contract.label,
  closed: STAGE_GUIDE.closed.label,
  lost: STAGE_GUIDE.lost.label,
};

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

export interface StageFacts {
  stage: Stage;
  ownershipState: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
  firstTouchDueAt: Instant | null;
  firstTouchAt: Instant | null;
}

export type StageActor = { kind: 'user'; role: Role } | { kind: 'system' } | { kind: 'support' };

export type StageDecision = { ok: true } | { ok: false; code: 'STAGE_NEEDS_CONTACT' };

/** Whether the lead is routed and still untouched (the SLA period is running). */
export function untouchedRouted(c: StageFacts): boolean {
  return c.ownershipState === 'owned' && c.firstTouchDueAt !== null && c.firstTouchAt === null;
}

/** R-PAR-14. A no-op change (same stage) is always allowed (the DB trigger does not fire). */
export function stageChangeAllowed(c: StageFacts, actor: StageActor, to: Stage): StageDecision {
  if (to === c.stage) return { ok: true };
  if (OPEN_STAGES.includes(to)) return { ok: true };
  if (actor.kind !== 'user' || (actor.role !== 'agent' && actor.role !== 'isa')) return { ok: true };
  return untouchedRouted(c) ? { ok: false, code: 'STAGE_NEEDS_CONTACT' } : { ok: true };
}

/** The stages the stage picker shows locked for this actor (empty when nothing is locked). */
export function lockedStages(c: StageFacts, actor: StageActor): Stage[] {
  return STAGES.filter((s) => !stageChangeAllowed(c, actor, s).ok);
}

export type StageLabels = Partial<Record<Stage, string>>;

/** Tenant labels (tenant_settings.stage_labels): keys among the eight, 1-24 characters, no control characters. */
export function validateStageLabels(input: unknown): { ok: true; labels: StageLabels } | { ok: false; code: 'STAGE_LABEL_INVALID' } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'STAGE_LABEL_INVALID' };
  const out: StageLabels = {};
  for (const [k, v] of Object.entries(input)) {
    if (!isStage(k) || typeof v !== 'string') return { ok: false, code: 'STAGE_LABEL_INVALID' };
    const t = v.trim();
    // no control characters or bidi overrides either (a label shows on everyone's screen; security review)
    // eslint-disable-next-line no-control-regex
    if (t.length < 1 || t.length > 24 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(t)) return { ok: false, code: 'STAGE_LABEL_INVALID' };
    out[k] = t;
  }
  return { ok: true, labels: out };
}

/** The display label of a stage: the tenant's, else the default. */
export function stageLabel(stage: Stage, labels: StageLabels = {}): string {
  return labels[stage] ?? DEFAULT_STAGE_LABELS[stage];
}

/** The eight stages in order with the label shown (the tenant's, else the default) and the guide's two lines (R-STG-1). */
export function stageGuide(labels: StageLabels = {}): { key: Stage; label: string; definition: string; notThis: string }[] {
  return STAGES.map((key) => ({ key, label: stageLabel(key, labels), definition: STAGE_GUIDE[key].definition, notThis: STAGE_GUIDE[key].notThis }));
}
