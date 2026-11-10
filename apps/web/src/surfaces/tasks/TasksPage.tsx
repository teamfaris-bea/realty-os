// Tasks (BUILD_PLAN module 17): the agent's open tasks and the appointments waiting for an outcome.
//
// - Appointments that ended without an outcome come first, with the outcome chips one tap away.
// - Tasks are grouped Overdue / Today / Later / No date, with Done in one tap.
// - Promise tasks the assistant found in a call show where the promise was made (evidence: the
//   quote and its place in the call). One whose date the assistant could not pin says "Check this"
//   and has no due date until the agent sets one (R-AST-5: a needs-review claim never becomes a due
//   date on its own).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Card, CheckThis, EmptyState, EvidenceLink, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { AgentSheetsProvider, appointmentLabel, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { evidenceView, formatDateTime } from '../feed/lib/format.js';
import { useMutate, useNow } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { AppointmentView, TaskView } from '../feed/lib/types.js';

export type TaskGroup = 'overdue' | 'today' | 'later' | 'undated';

/** Which group a task belongs to at `now` in the viewer's day (pure; unit-tested). */
export function groupOf(t: Pick<TaskView, 'dueAt'>, now: number): TaskGroup {
  if (!t.dueAt) return 'undated';
  const due = Date.parse(t.dueAt);
  if (due < now) return 'overdue';
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return due <= end.getTime() ? 'today' : 'later';
}

const GROUP_TITLE: Record<TaskGroup, string> = { overdue: 'Overdue', today: 'Today', later: 'Later', undated: 'No date' };

export default function TasksPage() {
  return (
    <AgentSheetsProvider>
      <Tasks />
    </AgentSheetsProvider>
  );
}

function Tasks() {
  const api = useApi();
  const now = useNow(60_000);
  const { hash } = useLocation();
  const tasks = useQuery<{ tasks: TaskView[] }, ApiError>({
    queryKey: ['tasks', 'mine'],
    queryFn: ({ signal }) => api.get<{ tasks: TaskView[] }>('/tasks?status=open&limit=200', { signal }),
  });
  const appts = useQuery<{ appointments: AppointmentView[] }, ApiError>({
    queryKey: ['appointments', 'awaiting'],
    queryFn: ({ signal }) => api.get<{ appointments: AppointmentView[] }>('/appointments?awaitingOutcome=true', { signal }),
  });
  useEffect(() => {
    if (hash && tasks.data) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'center' });
  }, [hash, tasks.data]);

  const groups: Record<TaskGroup, TaskView[]> = { overdue: [], today: [], later: [], undated: [] };
  for (const t of tasks.data?.tasks ?? []) groups[groupOf(t, now)].push(t);
  const awaiting = appts.data?.appointments ?? [];

  return (
    <div className="mx-auto flex w-full max-w-2xl md:mx-0 flex-col gap-6">
      <NewTask />
      {awaiting.length > 0 ? (
        <Group title="How did it go?">
          {awaiting.map((a) => (
            <li key={a.id}>
              <AwaitingOutcome appt={a} />
            </li>
          ))}
        </Group>
      ) : null}
      {tasks.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {tasks.isError ? <Notice tone="error">{messageFor(tasks.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {tasks.data && tasks.data.tasks.length === 0 && awaiting.length === 0 ? <EmptyState icon="checklist" title="No open tasks" /> : null}
      {(['overdue', 'today', 'later', 'undated'] as const).map((g) =>
        groups[g].length > 0 ? (
          <Group key={g} title={GROUP_TITLE[g]}>
            {groups[g].map((t) => (
              <li key={t.id} id={`task-${t.id}`} className="scroll-mt-24">
                <TaskRow task={t} overdue={g === 'overdue'} />
              </li>
            ))}
          </Group>
        ) : null,
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h2>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

function AwaitingOutcome({ appt }: { appt: AppointmentView }) {
  const { logAppointment } = useAgentSheets();
  const label = appointmentLabel(appt);
  return (
    <Card className="flex items-center gap-3">
      <p className="min-w-0 flex-1 text-[16px] text-ink">{label}</p>
      <Button onClick={() => logAppointment(appt.id, label)}>Log outcome</Button>
    </Card>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TaskRow({ task, overdue }: { task: TaskView; overdue: boolean }) {
  const { announce } = useAgentSheets();
  const m = useMutate<Record<string, unknown>, { task: TaskView }>('PATCH', { invalidate: [['tasks'], ['feed']] });
  const [dating, setDating] = useState(false);
  const [when, setWhen] = useState(toLocalInput(task.dueAt));
  const done = async () => {
    const r = await m.run(`/tasks/${task.id}`, { status: 'done' });
    if (r.ok) announce(`Done: ${task.title}`);
  };
  const setDate = async (e: FormEvent) => {
    e.preventDefault();
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return;
    const r = await m.run(`/tasks/${task.id}`, { dueAt: at.toISOString() });
    if (r.ok) setDating(false);
  };
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-medium text-ink">{task.title}</p>
          <p className={`text-[14px] ${overdue ? 'text-danger' : 'text-ink-muted'}`}>
            {task.dueAt ? `${overdue ? 'Was due' : 'Due'} ${formatDateTime(task.dueAt)}` : 'No date'}
            {task.contact ? (
              <>
                {' · '}
                <Link to={`/contacts/${task.contact.id}`} className="text-accent hover:underline">
                  {task.contact.name}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <Button variant="secondary" icon="check" pending={m.pending} onClick={() => void done()}>
          Done
        </Button>
      </div>
      {task.needsReview ? (
        <p className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
          <CheckThis reason="The assistant wasn't sure when this is due." /> The assistant wasn't sure when. Set the date yourself.
        </p>
      ) : null}
      {task.source && (task.source.claimText || task.source.evidence.length > 0) ? (
        <div className="flex flex-col gap-1 border-l-2 border-line pl-3 text-[14px] text-ink-muted">
          {task.source.claimText ? <p>Found by the assistant: {task.source.claimText}</p> : null}
          {task.source.evidence.map((e, i) => (
            <EvidenceLink key={`${e.sourceId}:${i}`} evidence={evidenceView(e, task.contact?.id ?? null)} />
          ))}
        </div>
      ) : null}
      {dating ? (
        <form onSubmit={(e) => void setDate(e)} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            Due
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
          </label>
          <Button type="submit" pending={m.pending} disabled={!when}>
            Save
          </Button>
        </form>
      ) : task.needsReview || !task.dueAt ? (
        <Button variant="quiet" className="self-start" onClick={() => setDating(true)}>
          Set a date
        </Button>
      ) : null}
      {m.error ? <Notice tone="error">{m.error.message}</Notice> : null}
    </Card>
  );
}

function NewTask() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const id = useId();
  const m = useMutate<Record<string, unknown>, { task: TaskView }>('POST', { invalidate: [['tasks'], ['feed']] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const at = when ? new Date(when) : null;
    const r = await m.run('/tasks', { title: t, ...(at && !Number.isNaN(at.getTime()) ? { dueAt: at.toISOString() } : {}) });
    if (r.ok) {
      setTitle('');
      setWhen('');
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
        New task
      </Button>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 md:flex-row md:items-end" aria-label="Add a task">
      <label htmlFor={`${id}-t`} className="flex flex-1 flex-col gap-1 text-[15px] font-medium text-ink">
        New task
        <input id={`${id}-t`} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
      </label>
      <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
        Due (optional)
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
      </label>
      <Button type="submit" pending={m.pending} disabled={title.trim().length === 0}>
        Add
      </Button>
      {m.error ? <Notice tone="error">{m.error.message}</Notice> : null}
    </form>
  );
}
