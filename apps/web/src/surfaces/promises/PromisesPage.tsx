// Promises: open promise tasks, overdue first, one tap to mark done. A Team Lead (and Owner or
// Admin) sees every promise their role can see and can narrow to one agent. Reschedule sets the
// due time. Log a call writes the outside-activity note the timeline already shows.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, Notice } from '../../design/index.js';
import { ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { AgentSheetsProvider, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { formatDateTime } from '../feed/lib/format.js';
import { useMutate, useNow } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { TaskView } from '../feed/lib/types.js';
import { useFilterOptions } from '../people/api.js';
import { promiseBands } from './bands.js';

const WIDE = new Set(['owner', 'admin', 'team_lead']);

export default function PromisesPage() {
  return (
    <AgentSheetsProvider>
      <Promises />
    </AgentSheetsProvider>
  );
}

function Promises() {
  const api = useApi();
  const { session } = useSession();
  const now = useNow(60_000);
  const wide = WIDE.has(session?.tenant?.role ?? '');
  const [agent, setAgent] = useState('');
  const options = useFilterOptions(wide);
  const q = new URLSearchParams({ status: 'open', kind: 'promise', limit: '200', scope: wide ? 'visible' : 'mine' });
  if (agent) q.set('assigneeUserId', agent);
  const tasks = useQuery<{ tasks: TaskView[] }, ApiError>({
    queryKey: ['tasks', 'promises', wide ? 'visible' : 'mine', agent],
    queryFn: ({ signal }) => api.get<{ tasks: TaskView[] }>(`/tasks?${q.toString()}`, { signal }),
  });
  const bands = promiseBands(tasks.data?.tasks ?? [], now);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 md:mx-0">
      <p className="text-[15px] text-ink-muted">{wide ? 'Open promises you can see, soonest first.' : 'Promises you still owe, soonest first.'}</p>
      {wide ? (
        <label className="flex max-w-xs flex-col gap-1 text-[15px] font-medium text-ink">
          Agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink">
            <option value="">Everyone I can see</option>
            {(options.data?.members ?? [])
              .filter((m) => m.active)
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {tasks.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {tasks.isError ? <Notice tone="error">{messageFor(tasks.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {tasks.data && tasks.data.tasks.length === 0 ? <EmptyState icon="check" title="No open promises" /> : null}
      {bands.map((b) => (
        <Band key={b.key} title={b.title} overdue={b.key === 'overdue'}>
          {b.tasks.map((t) => (
            <li key={t.id}>
              <PromiseRow task={t} overdue={b.key === 'overdue'} />
            </li>
          ))}
        </Band>
      ))}
    </div>
  );
}

function Band({ title, overdue, children }: { title: string; overdue: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className={`text-[13px] font-semibold uppercase tracking-wide ${overdue ? 'text-danger' : 'text-ink-muted'}`}>
        {title}
      </h2>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PromiseRow({ task, overdue }: { task: TaskView; overdue: boolean }) {
  const { announce } = useAgentSheets();
  const api = useApi();
  const qc = useQueryClient();
  const done = useMutate<Record<string, unknown>, { task: TaskView }>('PATCH', { invalidate: [['tasks'], ['feed'], ...(task.contact ? [['timeline', task.contact.id] as const] : [])] });
  const shift = useMutate<Record<string, unknown>, { task: TaskView }>('PATCH', { invalidate: [['tasks'], ['feed']] });
  const [when, setWhen] = useState(toLocalInput(task.dueAt));
  const [dating, setDating] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  const markDone = async () => {
    const r = await done.run(`/tasks/${task.id}`, { status: 'done' });
    if (r.ok) announce(`Done: ${task.title}`);
  };
  const saveDate = async (e: FormEvent) => {
    e.preventDefault();
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return;
    const r = await shift.run(`/tasks/${task.id}`, { dueAt: at.toISOString() });
    if (r.ok) {
      setDating(false);
      announce(`Rescheduled: ${task.title}`);
    }
  };
  const logTouch = async () => {
    if (!task.contact) return;
    setLogging(true);
    setLogError(null);
    try {
      await api.post(`/contacts/${task.contact.id}/activities`, { kind: 'call', direction: 'outbound', outcome: 'connected', at: new Date().toISOString(), body: `About: ${task.title}` });
      await qc.invalidateQueries({ queryKey: ['timeline', task.contact.id] });
      announce(`Logged a call with ${task.contact.name}`);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setLogError(err ? messageFor(err, AGENT_ERROR_MESSAGES) : 'That call was not logged. Try again.');
    } finally {
      setLogging(false);
    }
  };

  return (
    <Card className={`flex flex-col gap-2 ${overdue ? 'ring-2 ring-danger' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-medium text-ink">{task.title}</p>
          <p className={`text-[14px] ${overdue ? 'font-medium text-danger' : 'text-ink-muted'}`}>
            {task.dueAt ? `${overdue ? 'Overdue' : 'Due'} ${formatDateTime(task.dueAt)}` : 'No date'}
            {task.contact ? (
              <>
                {' · '}
                <Link to={`/contacts/${task.contact.id}`} className="text-accent underline">
                  {task.contact.name}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <Button icon="check" pending={done.pending} onClick={() => void markDone()}>
          Done
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setDating((v) => !v)}>
          Reschedule
        </Button>
        {task.contact ? (
          <Button variant="secondary" pending={logging} onClick={() => void logTouch()}>
            Log a call
          </Button>
        ) : null}
      </div>
      {dating ? (
        <form onSubmit={(e) => void saveDate(e)} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            Due
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
          </label>
          <Button type="submit" pending={shift.pending} disabled={!when}>
            Save
          </Button>
        </form>
      ) : null}
      {done.error ? <Notice tone="error">{done.error.message}</Notice> : null}
      {shift.error ? <Notice tone="error">{shift.error.message}</Notice> : null}
      {logError ? <Notice tone="error">{logError}</Notice> : null}
    </Card>
  );
}
