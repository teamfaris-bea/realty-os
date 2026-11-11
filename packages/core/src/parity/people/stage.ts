// Stages (R-PAR-13, R-PAR-14). The fixed eight; tenant labels only rename them for display.
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

export const DEFAULT_STAGE_LABELS: Record<Stage, string> = {
  new: 'New',
  attempting: 'Attempting',
  connected: 'Connected',
  nurture: 'Nurture',
  active: 'Active',
  under_contract: 'Under contract',
  closed: 'Closed',
  lost: 'Lost',
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
