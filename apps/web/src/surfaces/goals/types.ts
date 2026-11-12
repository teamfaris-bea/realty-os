// Response shapes of api/insights' goals and weekly plan (apps/api/src/insights/schemas.ts). No score or grade field.
export const GOALS_KEY = ['goals'] as const;
export const PLAN_KEY = ['weekly-plan'] as const;

export type Metric = 'appointments_set' | 'appointments_held' | 'agreements_signed' | 'closings' | 'touches';
export type PeriodKind = 'week' | 'month' | 'quarter' | 'year';
export type PaceStatus = 'ahead' | 'on_track' | 'behind' | 'done';

export interface GoalView {
  id: string;
  userId: string;
  periodKind: PeriodKind;
  periodStart: string;
  periodEndExclusive: string;
  metric: Metric;
  target: number;
  pace: { actual: number; expectedByNow: number; behindBy: number; remaining: number; daysLeft: number; status: PaceStatus; words: string; method: string };
}

export interface GoalsResponse {
  zone: string;
  members: { userId: string; name: string; role: string; canManage: boolean }[];
  goals: GoalView[];
}

export interface PlanItemView {
  kind: 'keep_promise' | 'do_task' | 'log_outcome' | 'move_deal';
  title: string;
  contactId: string | null;
  dealId: string | null;
  deadline: string | null;
  metric: Metric | null;
  gap: number;
  evidence: { sourceType: 'task' | 'appointment' | 'deal'; sourceId: string; reason: string }[];
}

export interface PlanResponse {
  week: string;
  /** the team zone the week, deadlines and reasons are in */
  zone: string;
  exists: boolean;
  basis?: 'goals_and_pipeline' | 'pipeline_only';
  note?: string;
  builtAt?: string;
  items?: { index: number; accepted: boolean; item: PlanItemView }[];
  droppedSinceBuilt?: number;
  accepted?: { at: string; taskIds: string[] } | null;
}

export const METRIC_LABEL: Record<Metric, string> = {
  appointments_set: 'Appointments set',
  appointments_held: 'Appointments held',
  agreements_signed: 'Agreements signed',
  closings: 'Closings',
  touches: 'Touches (calls, texts, emails)',
};

export const PERIOD_LABEL: Record<PeriodKind, string> = { week: 'This week', month: 'This month', quarter: 'This quarter', year: 'This year' };

/** Pace in words, never a grade: what the numbers say about the even pace. */
export const STATUS_LABEL: Record<PaceStatus, string> = { ahead: 'Ahead of pace', on_track: 'On pace', behind: 'Behind pace', done: 'Goal reached' };
