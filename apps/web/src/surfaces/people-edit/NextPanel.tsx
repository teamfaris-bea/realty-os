// "What happens next" on the person's page (R-STG-4): three things an agent used to find in three places, kept apart
// and always shown, so nobody has to ask what a stage change did.
//
//   Your next task        the earliest open task with its due time; Add follow-up and Add appointment live here
//   Automated playbook    GET /contacts/:id/playbook-status: the plan and its state (Running, Paused, Stopped,
//                         Finished, or "None running"), its next real step or why it is not moving, a delivery that
//                         could not be confirmed in its own line (never as sent), and where it came from (the last
//                         stage change's stored decision; "Checking…" while that is still being decided, asked again
//                         every 15 s only then). Pause, Stop and Resume appear only when the server's can* flag says
//                         the route would act for this viewer; each calls the existing route, and a refusal shows the
//                         server's reason. Nothing is said to have happened until the status says so. When the
//                         status cannot be read (again), the row says so and shows nothing of an earlier read (E785).
//   AI follow-up          one line from the AI care panel's own data, linking to the AI care section when it is there
//
// PersonChips: buyer or seller, and whether the person can be texted, are their own chips beside the stage. A stage
// says how far the relationship has come and never implies either (R-STG-1).
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Notice } from '../../design/index.js';
import { channelState, useReachability } from '../../reasons/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { AI_CARE_SECTION_ID, useAiFollowUp } from '../aiCare/Person.js';
import { formatDateTime, intentLabel } from '../feed/lib/format.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ContactFullView, TaskView } from '../feed/lib/types.js';
import { useStageGuide } from '../people/stageGuide.js';
import { usePersonAction } from './hooks.js';
import { CHECKING, NONE_RUNNING, type PlaybookStatus, nextStepText, originLine, planStateWord, usePlaybookStatus } from './stageFlow.js';

function Row({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <h3 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h3>
      {children}
    </div>
  );
}

/** The id of the page's Tasks section (contact/ContactPage.tsx), where a task is opened and completed. */
export const TASKS_SECTION_ID = 'tasks';

/** The earliest open task: by due time, tasks with no date last. */
export function nextTaskOf(tasks: readonly TaskView[]): TaskView | null {
  const due = (t: TaskView) => (t.dueAt ? Date.parse(t.dueAt) : Number.POSITIVE_INFINITY);
  return [...tasks].sort((a, b) => due(a) - due(b))[0] ?? null;
}

function NextTask({ contactId, onAddTask, onAddAppointment }: { contactId: string; onAddTask: () => void; onAddAppointment: () => void }) {
  const api = useApi();
  // the same request and cache entry as the page's Tasks section
  const q = useQuery<{ tasks: TaskView[] }, ApiError>({
    queryKey: ['tasks', 'contact', contactId],
    queryFn: ({ signal }) => api.get<{ tasks: TaskView[] }>(`/tasks?contactId=${contactId}&scope=visible&status=open`, { signal }),
  });
  const tasks = q.data?.tasks ?? [];
  const next = nextTaskOf(tasks);
  return (
    <Row title="Your next task">
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {q.data && !next ? <p className="text-[15px] text-ink">No open task.</p> : null}
      {next ? (
        <p className="text-[16px] text-ink [overflow-wrap:anywhere]">
          <span className="font-medium">{next.title}</span>
          <span className="text-ink-muted">
            {' '}
            · {next.dueAt ? `due ${formatDateTime(next.dueAt)}` : next.needsReview ? 'needs a date' : 'no date'}
            {tasks.length > 1 ? ` · ${tasks.length - 1} more open` : ''}
          </span>{' '}
          {/* the task is opened and completed from the page's Tasks section: one link per task on the page */}
          <Link to={`#${TASKS_SECTION_ID}`} className="inline-flex min-h-tap items-center font-medium text-accent underline">
            See open tasks
          </Link>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon="checklist" onClick={onAddTask}>
          Add follow-up
        </Button>
        <Button variant="secondary" icon="calendar" onClick={onAddAppointment}>
          Add appointment
        </Button>
      </div>
    </Row>
  );
}

type Plan = NonNullable<PlaybookStatus['plan']>;

/**
 * The resume route's refusals that read differently here than on the playbook's own page (the app-wide sentences for
 * these two codes are about approving a playbook).
 */
const RESUME_REFUSED: Record<string, string> = {
  PLAYBOOK_OWNER_MISMATCH: 'This plan belonged to the previous owner, so it can’t resume for the new one.',
  PLAYBOOK_NOT_APPROVED: 'This plan has no approved version now, so it can’t resume until one is approved.',
};

/** Pause, Resume and Stop, each only when the server says its route would act for this viewer. */
function PlanControls({ contactId, plan }: { contactId: string; plan: Plan }) {
  const act = usePersonAction(contactId);
  const [refused, setRefused] = useState<string | null>(null);
  const go = async (what: 'pause' | 'resume' | 'stop') => {
    setRefused(null);
    const r = await act.run('POST', `/enrollments/${plan.enrollmentId}/${what}`);
    // the server's reason, in words; nothing is said to have happened
    if (!r.ok) setRefused(RESUME_REFUSED[r.code] ?? r.message);
  };
  if (!plan.canPause && !plan.canResume && !plan.canStop && !refused) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {plan.canPause ? (
          <Button variant="secondary" disabled={act.pending} aria-label={`Pause ${plan.name}`} onClick={() => void go('pause')}>
            Pause
          </Button>
        ) : null}
        {plan.canResume ? (
          <Button variant="secondary" disabled={act.pending} aria-label={`Resume ${plan.name}`} onClick={() => void go('resume')}>
            Resume
          </Button>
        ) : null}
        {plan.canStop ? (
          <Button variant="secondary" disabled={act.pending} aria-label={`Stop ${plan.name}`} onClick={() => void go('stop')}>
            Stop
          </Button>
        ) : null}
      </div>
      {refused ? <Notice tone="error">{refused}</Notice> : null}
    </>
  );
}

const STATE_TONE: Record<Plan['state'], string> = { active: 'bg-ok-soft', paused: 'bg-warn-soft', stopped: 'bg-surface-2', completed: 'bg-surface-2' };

function Playbook({ contactId }: { contactId: string }) {
  const q = usePlaybookStatus(contactId);
  const { labelOf } = useStageGuide();
  const me = useSession().session?.user.id ?? null;
  // E785: a read that failed is not shown beside what an earlier read said. The plan may have been paused or stopped
  // since; "Running" and its buttons would then be a claim nobody can back. The row says it could not check, shows
  // nothing that may be out of date, and offers to ask again.
  const s = q.isError ? undefined : q.data;
  const plan = s?.plan ?? null;
  const origin = s ? originLine(s, labelOf, me) : null;
  const next = plan ? nextStepText(plan) : null;
  return (
    <Row title="Automated playbook">
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? (
        <>
          <Notice tone="error">We couldn’t check this plan just now, so nothing is shown that may be out of date. {messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>
          <Button variant="secondary" className="self-start" pending={q.isFetching} onClick={() => void q.refetch()}>
            Try again
          </Button>
        </>
      ) : null}
      {s && !plan && origin !== CHECKING ? <p className="text-[16px] font-medium text-ink">{NONE_RUNNING}</p> : null}
      {plan ? (
        <>
          <p className="flex flex-wrap items-center gap-2 text-[16px] text-ink">
            <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{plan.name}</span>
            <span data-testid="plan-state" className={`rounded-full px-2.5 py-0.5 text-[14px] font-medium text-ink ${STATE_TONE[plan.state]}`}>
              {planStateWord(plan.state)}
            </span>
          </p>
          {next ? <p className="text-[15px] text-ink">{next}</p> : null}
          {plan.blocked ? <p className="text-[15px] text-ink [overflow-wrap:anywhere]">{plan.blocked.sentence}</p> : null}
          {plan.deliveryUnconfirmed ? (
            <p data-testid="delivery-unconfirmed" className="rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-ink [overflow-wrap:anywhere]">
              {plan.deliveryUnconfirmed.sentence}
            </p>
          ) : null}
        </>
      ) : null}
      {origin ? <p className="text-[14px] text-ink-muted [overflow-wrap:anywhere]">{origin}</p> : null}
      {plan ? <PlanControls contactId={contactId} plan={plan} /> : null}
    </Row>
  );
}

function AiFollowUp({ contactId }: { contactId: string }) {
  const ai = useAiFollowUp(contactId);
  return (
    <Row title="AI follow-up">
      <p className="text-[15px] text-ink [overflow-wrap:anywhere]">{ai.line}</p>
      {ai.linked ? (
        <Link to={`#${AI_CARE_SECTION_ID}`} className="inline-flex min-h-tap items-center self-start text-[15px] font-medium text-accent underline">
          Open AI care
        </Link>
      ) : null}
    </Row>
  );
}

/** The panel's id on the page: the stage toast's "See what happens next" scrolls to it (M5). */
export const NEXT_PANEL_ID = 'next';

/** Brings the panel into view, when the page has one. False: there is no panel here (the feed, the tasks page). */
export function showNextPanel(): boolean {
  const el = typeof document === 'undefined' ? null : document.getElementById(NEXT_PANEL_ID);
  if (!el) return false;
  el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  return true;
}
export const hasNextPanel = (): boolean => typeof document !== 'undefined' && document.getElementById(NEXT_PANEL_ID) !== null;

export function NextPanel({ contact, onAddTask, onAddAppointment }: { contact: ContactFullView; onAddTask: () => void; onAddAppointment: () => void }) {
  const hid = useId();
  return (
    <section aria-labelledby={hid} id={NEXT_PANEL_ID} className="flex scroll-mt-20 flex-col gap-2">
      <h2 id={hid} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        What happens next
      </h2>
      <Card as="div" className="flex flex-col gap-3">
        <NextTask contactId={contact.id} onAddTask={onAddTask} onAddAppointment={onAddAppointment} />
        <Playbook contactId={contact.id} />
        <AiFollowUp contactId={contact.id} />
      </Card>
    </section>
  );
}

const chip = 'rounded-full border border-line bg-surface px-3 py-1 text-[14px] font-medium text-ink [overflow-wrap:anywhere]';

/** Buyer or seller, and texting permission: separate facts beside the stage, never folded into it. */
export function PersonChips({ contact }: { contact: Pick<ContactFullView, 'id' | 'displayName' | 'intent' | 'phones'> }) {
  const reach = useReachability(contact.id);
  const sms = channelState(reach, 'sms');
  const texting = contact.phones.length === 0 ? 'No phone to text' : reach === null ? null : sms.blocked ? `No texting: ${sms.sentence ?? 'they opted out'}` : 'Texting OK';
  return (
    <ul aria-label={`About ${contact.displayName}`} className="flex min-w-0 flex-wrap items-center gap-2">
      <li className={chip}>{intentLabel(contact.intent) ?? 'Buyer or seller: not set'}</li>
      {texting ? <li className={`${chip} ${sms.blocked ? 'border-transparent bg-warn-soft' : ''}`}>{texting}</li> : null}
    </ul>
  );
}
