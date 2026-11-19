// The stage flow's API shapes, queries and words (R-STG-2 to R-STG-6). Shapes are restated field for field from
// apps/api (people/schemas.ts StagePreviewResponse, StageResponse and SuggestedStage; stageAutomation/status.ts
// PlaybookStatus): apps/web does not import @realty/api.
//
// What the screen may say is decided here, in one place, so no surface words it differently:
//   - a plan is "Will start" only before the change and only when the server's preview says so; after the change the
//     words come from the decision the server stored ("Started …", "… did not start: …"), never from the preview;
//   - a stage change never stops a plan, and an undo never starts or stops one: both are said plainly;
//   - a control (Stop, Pause, Resume) is offered only when the server's own can* flag says its route would act.
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../shell/index.js';
import { formatTime } from '../feed/lib/format.js';
import { playbookStatusKey, stagePreviewKey } from './api.js';

export { playbookStatusKey, stagePreviewKey };

// ---- shapes ---------------------------------------------------------------------------------------------------------

/** GET /contacts/:id/stage/preview?to=<stage> */
export interface StagePreview {
  allowed: boolean;
  lockedReason: 'STAGE_NEEDS_CONTACT' | null;
  sameStage: boolean;
  starts: { plan: string; firstStep: { channel: string; dueAt: string } | null } | null;
  wontStart: { plan: string; reason: string; sentence: string; alreadyIn: { enrollmentId: string; plan: string } | null } | null;
  keepsRunning: { enrollmentId: string; plan: string; state: 'active' | 'paused'; canStop: boolean } | null;
  stops: never[];
  aiCare: 'unchanged';
  tasks: 'unchanged';
}

/** What a stage entry started, or why it did not (null: no plan names that stage). */
export type StageAutomation = { started: string } | { skipped: string; plan: string } | null | undefined;

/** POST /contacts/:id/stage */
export interface StageResponse {
  stage: { stage: string; label: string };
  previousStage: string;
  rowVersion: number;
  /** the stage event this change wrote (the Undo names it) */
  eventId?: string | null;
  automation?: StageAutomation;
  /** E784: `automation` in the server's words, the sentence the panel shows for this change (null: nothing to say) */
  automationSentence?: string | null;
  /** only on an undo: the plan the person is still in */
  stillRunning?: { enrollmentId: string; plan: string; /** E782: a paused plan is not called running */ state?: 'active' | 'paused'; canStop: boolean } | null;
}

/** What POST /contacts/:id/activities and POST /calls/:id/outcome answer beside the saved outcome. */
export interface SuggestedStage {
  stage: string;
  why: string;
  /** the stage route would refuse it now: shown locked, never selectable */
  locked: boolean;
  alsoOffer: { stage: string; locked: boolean }[];
}

/** GET /contacts/:id/playbook-status */
export interface PlaybookStatus {
  plan: {
    enrollmentId: string;
    name: string;
    state: 'active' | 'paused' | 'completed' | 'stopped';
    startedBy: { how: string; userId: string | null; displayName: string | null };
    startedAt: string;
    next: { kind: 'message'; channel: string; dueAt: string } | null;
    blocked: { code: string; sentence: string } | null;
    deliveryUnconfirmed: { channel: string; at: string; checking: boolean; sentence: string } | null;
    canPause: boolean;
    canResume: boolean;
    canStop: boolean;
  } | null;
  lastStageChange: {
    eventId: string;
    to: string;
    at: string;
    pending: boolean;
    decision: { outcome: 'started' | 'skipped'; plan: string; reason: string | null; sentence: string } | null;
  } | null;
}

// ---- queries --------------------------------------------------------------------------------------------------------


/** What entering `to` would do, asked before the change. Never cached past the next edit of the person. */
export function useStagePreview(contactId: string, to: string | null) {
  const api = useApi();
  return useQuery<StagePreview, ApiError>({
    queryKey: [...stagePreviewKey(contactId), to],
    queryFn: ({ signal }) => api.get<StagePreview>(`/contacts/${contactId}/stage/preview?to=${encodeURIComponent(to ?? '')}`, { signal }),
    enabled: to !== null,
    staleTime: 0,
    retry: false,
  });
}

/** Asked again every 15 s only while the last stage change is still being decided (R-STG-4); otherwise never polled. */
export function statusPollMs(s: PlaybookStatus | undefined): number | false {
  return s?.lastStageChange?.pending ? 15_000 : false;
}

/** The person's automated plan, what it does next and what the last stage change did. */
export function usePlaybookStatus(contactId: string) {
  const api = useApi();
  return useQuery<PlaybookStatus, ApiError>({
    queryKey: playbookStatusKey(contactId),
    queryFn: ({ signal }) => api.get<PlaybookStatus>(`/contacts/${contactId}/playbook-status`, { signal }),
    refetchInterval: (q) => statusPollMs(q.state.data),
    staleTime: 0,
    retry: false,
  });
}

// ---- words ----------------------------------------------------------------------------------------------------------

export const NEVER_STOPS = 'Changing the stage does not stop a running plan.';
export const AI_UNCHANGED = 'AI follow-up: unchanged';
export const TASKS_UNCHANGED = 'Your tasks: unchanged';
export const NO_PLAN_FOR_STAGE = 'No plan starts on this stage.';
/** Said of a stage the stage rule refuses for this viewer now (STAGE_NEEDS_CONTACT), in place of any plan words. */
export const LOCKED_FOR_NOW = 'Locked for now: reach them first.';

const CHANNEL_WORD: Record<string, string> = { sms: 'text', mms: 'text', text: 'text', email: 'email', web_chat: 'chat message', voice: 'call' };
/** "text", "email": the plain word for a step's channel. */
export function channelWord(channel: string): string {
  return CHANNEL_WORD[channel] ?? 'message';
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When a step is due, in the viewer's zone and short enough for a phone: "now", "today 9:00 AM", "tomorrow 9:00 AM",
 * "Thu 9:00 AM" within a week, otherwise "Thu, Nov 26, 9:00 AM". A time already past reads "now": the runner takes
 * it on its next pass.
 */
export function whenWords(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (d.getTime() <= now + 60_000) return 'now';
  const days = Math.round((dayStart(d) - dayStart(new Date(now))) / 86_400_000);
  const time = formatTime(iso);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d)} ${time}`;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

/** "Will start: Buyer plan, first step text tomorrow 9:00 AM". Said only of a preview whose `starts` is set. */
export function willStartText(s: NonNullable<StagePreview['starts']>, now: number = Date.now()): string {
  return s.firstStep ? `Will start: ${s.plan}, first step ${channelWord(s.firstStep.channel)} ${whenWords(s.firstStep.dueAt, now)}` : `Will start: ${s.plan}. No message is due from it yet.`;
}

/** The one line a stage's row carries before it is picked: what entering it would do to the automated plan. */
export function effectLine(p: StagePreview, now: number = Date.now()): string {
  // L7 (E781): a change the stage rule refuses enters nothing, so nothing is said about a plan
  if (!p.allowed) return LOCKED_FOR_NOW;
  if (p.sameStage) return 'They are in this stage now. Nothing starts.';
  if (p.starts) return willStartText(p.starts, now);
  if (p.wontStart) return p.wontStart.sentence;
  return NO_PLAN_FOR_STAGE;
}

/** "Keeps running: Buyer plan" (a paused plan stays paused: a stage change does not resume it either). */
export function keepsRunningText(k: NonNullable<StagePreview['keepsRunning']>): string {
  return k.state === 'paused' ? `Stays paused: ${k.plan}` : `Keeps running: ${k.plan}`;
}

/** The primary button, named for its effect: "Change to Connected", or "Keep Trying to reach" when nothing changes. */
export function effectLabel(to: string, current: string, labelOf: (key: string) => string): string {
  return to === current ? `Keep ${labelOf(current)}` : `Change to ${labelOf(to)}`;
}

/** "Call logged. Stage: Connected. Started Buyer plan": the parts of one toast, each said once, with no doubled full stop. */
export function joinWords(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.trim().replace(/\.$/, ''))
    .join('. ');
}

// Parity module 67 (flagged edit): what the stage entry started, or why it did not, in plain words.
//
// b19 fix pass L5 (E784): the words are the SERVER's (StageResponse.automationSentence, the sentence the panel shows
// for the same change). The web keeps no table of skip words. `automationText` is only the fallback for an answer with
// no sentence: started, or did not start, and no reason. Two entries remain, and only because batch 18's tests
// (surfaces/lead-sources, which this batch may not edit) read their words from this function; the API never leaves
// them to be used, since it always sends its sentence.
const SOURCE_WORDS: Record<string, string> = {
  // b18 review B18S-5 (owner boundary 2026-11-14): a plan is automated contact
  source_no_automated_contact: 'their lead source is marked "No automated contact for leads from this source"',
  // R-LSRC-9 (owner decision 2026-11-14): an imported person whose source is not reviewed yet
  source_unclassified: 'they came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources)',
};

/** The fallback words for an answer that carries no sentence; '' when no plan is set for that stage. */
export function automationText(a: StageAutomation): string {
  if (!a) return '';
  if ('started' in a) return `${a.started} started`;
  const source = SOURCE_WORDS[a.skipped];
  return source ? `${a.plan} didn't start: ${source}` : `${a.plan} did not start`;
}

/** The sentence after "Stage: Active client." on the toast: the server's own; '' when no plan is set for that stage. */
export function automationWords(r: Pick<StageResponse, 'automation' | 'automationSentence'>): string {
  if (!r.automation) return '';
  return typeof r.automationSentence === 'string' && r.automationSentence.trim() !== '' ? r.automationSentence : automationText(r.automation);
}

// ---- the panel's words (R-STG-4) --------------------------------------------------------------------------------------

export const NONE_RUNNING = 'None running';
export const CHECKING = 'Checking…';

const STATE_WORD: Record<NonNullable<PlaybookStatus['plan']>['state'], string> = { active: 'Running', paused: 'Paused', stopped: 'Stopped', completed: 'Finished' };
export function planStateWord(state: NonNullable<PlaybookStatus['plan']>['state']): string {
  return STATE_WORD[state];
}

/** "Next: text, Thu 9:00 AM" for a running plan with a step due; a running plan with none says so; otherwise null. */
export function nextStepText(plan: NonNullable<PlaybookStatus['plan']>, now: number = Date.now()): string | null {
  if (plan.state !== 'active') return null;
  return plan.next ? `Next: ${channelWord(plan.next.channel)}, ${whenWords(plan.next.dueAt, now)}` : 'No message is due from it right now.';
}

/**
 * Where the row's plan came from, or what the last stage change did about a plan. "Checking…" while the change is
 * still being decided (never "started", never "nothing happened"); the server's own sentence when a plan did not
 * start; "Started when you moved them to Active client" only when the stored decision says started. Null: nothing
 * to say (the last change named no plan and no plan is shown).
 */
export function originLine(s: PlaybookStatus, labelOf: (key: string) => string, viewerUserId: string | null | undefined): string | null {
  const c = s.lastStageChange;
  if (c?.pending) return CHECKING;
  if (c?.decision?.outcome === 'skipped') return c.decision.sentence;
  const p = s.plan;
  if (!p) return null;
  const who = p.startedBy.userId !== null && p.startedBy.userId === viewerUserId ? 'you' : p.startedBy.displayName;
  switch (p.startedBy.how) {
    case 'stage_change':
      // the stage it started on is the last change's only when that change's decision started this plan
      return c?.decision?.outcome === 'started' && c.decision.plan === p.name ? `Started when ${who ?? 'someone'} moved them to ${labelOf(c.to)}` : `Started by a stage change${who ? ` ${who === 'you' ? 'you' : who} made` : ''}`;
    case 'user':
      return `Started by ${who ?? 'someone on the team'}`;
    case 'new_lead':
      return 'Started when they came in as a new lead';
    case 'deal_closed':
      return 'Started when their deal closed';
    case 'bulk':
      return `Started in a bulk action${who ? ` by ${who}` : ''}`;
    default:
      return null;
  }
}

// ---- stop (E786) --------------------------------------------------------------------------------------------------------

/** POST /enrollments/:id/stop (and pause, resume): the plan as it is now, and whether THIS request changed it. */
export interface EnrollmentChange {
  enrollment: { state: string };
  /** false: nothing was written (the plan had already ended); absent on an answer from before the field existed */
  changed?: boolean;
}

/**
 * What a Stop did, from the stop route's own answer. "Stopped <plan>." only when this request stopped it; a plan that
 * had already ended (a teammate stopped it a moment ago, or it finished) is said as that, and nothing is claimed.
 */
export function stoppedWords(plan: string, r: EnrollmentChange): string {
  if (r.changed !== false) return `Stopped ${plan}.`;
  return r.enrollment.state === 'completed' ? `${plan} had already finished. Nothing was changed.` : `${plan} had already been stopped. Nothing was changed.`;
}

// ---- undo (R-STG-5) ---------------------------------------------------------------------------------------------------

/**
 * Said when the server refuses an undo (STAGE_UNDO_INVALID): nothing was changed. The server refuses when the change
 * is no longer the person's latest, and (E779) when it is someone else's change, is itself an undo, or is more than
 * 15 minutes old. From the toast (8 seconds, on the changer's own screen) only the first can be the reason.
 */
export const UNDO_REFUSED = 'Not undone: the stage has changed again since, so there is nothing to take back.';

/**
 * What an undo did, from the stage route's own answer. An undo only moves the stage back: a plan the change started
 * keeps running, or stays paused if it was paused since (said plainly, with how to end it), and a plan of the stage
 * undone into does not start. Nothing here
 * says or implies that anything the plan already did was taken back.
 */
export function undoneText(r: Pick<StageResponse, 'stage' | 'automation' | 'automationSentence' | 'stillRunning'>, labelOf: (key: string) => string): string {
  const back = `Stage back to ${labelOf(r.stage.stage)}.`;
  // E782: a paused plan stays paused (an undo resumes nothing either), and is never called running
  if (r.stillRunning) return r.stillRunning.state === 'paused' ? `${back} ${r.stillRunning.plan} is still paused; undo does not resume or stop it.` : `${back} ${r.stillRunning.plan} is still running; undo does not stop it.`;
  const plan = automationWords(r);
  return plan ? `${back} ${plan}` : back;
}
