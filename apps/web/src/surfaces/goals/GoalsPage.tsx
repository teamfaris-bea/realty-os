// Goals (PHASE2_3_PLAN module 40; R-PLAN-2). Everyone sees their own goals with pace; a Team Lead also sees and
// sets their team's, the Owner and Admin everyone's. Pace is said in words from the server ("3 of 10 closings; 4.5
// expected by now; 7 to go in 12 days") with how it was counted; never a grade or a score.
// Setting a goal: pick the member (when there is a choice), the period (this week / month / quarter / year, starting
// where the period starts in the team's time zone), what to count and the target, then "Set goal" (one tap).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button, Card, EmptyState, Notice, TextField } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { Pill, Section, SelectField, StatusLine } from '../admin/lib/ui.js';
import { sentenceFor } from '../owner/messages.js';
import { GOALS_KEY, type GoalView, type GoalsResponse, METRIC_LABEL, type Metric, PERIOD_LABEL, type PeriodKind, STATUS_LABEL } from './types.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** Today's date in `zone` as YYYY-MM-DD. */
export function todayIn(zone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** The first day of the current period of `kind` containing `today` (a Monday for weeks). */
export function periodStartOf(kind: PeriodKind, today: string): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  if (kind === 'week') {
    const t = new Date(Date.UTC(y, m - 1, d));
    const wd = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
    t.setUTCDate(t.getUTCDate() - (wd - 1));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  if (kind === 'month') return `${y}-${pad(m)}-01`;
  if (kind === 'quarter') return `${y}-${pad(m - ((m - 1) % 3))}-01`;
  return `${y}-01-01`;
}

const TONE = { ahead: 'ok', on_track: 'accent', behind: 'warn', done: 'ok' } as const;

export default function GoalsPage() {
  const api = useApi();
  const [member, setMember] = useState<string | null>(null);
  const q = useQuery<GoalsResponse, ApiError>({ queryKey: [...GOALS_KEY], queryFn: ({ signal }) => api.get('/goals', { signal }) });
  const [status, announce] = useAnnounce(6000);
  const members = q.data?.members ?? [];
  const selected = member ?? members[0]?.userId ?? null;
  const who = members.find((m) => m.userId === selected);
  const goals = (q.data?.goals ?? []).filter((g) => g.userId === selected);
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      {members.length > 1 ? (
        <SelectField label="Member" value={selected ?? ''} onChange={(e) => setMember(e.target.value)}>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <StatusLine text={status} />
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{sentenceFor(q.error)}</Notice> : null}
      {q.data ? (
        <Section title={who && members.length > 1 ? `Goals for ${who.name}` : 'Your goals'} description={goals[0]?.pace.method}>
          {goals.length === 0 ? (
            <EmptyState icon="checklist" title="No goals yet">
              {who?.canManage ? 'Set one below. Your weekly plan then puts first what moves you toward it.' : 'Your Team Lead or the Owner sets goals. Until then your weekly plan is built from your pipeline only.'}
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Goals">
              {goals.map((g) => (
                <li key={g.id}>
                  <GoalCard goal={g} canManage={who?.canManage ?? false} onDone={announce} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
      {q.data && who?.canManage ? <NewGoal userId={who.userId} zone={q.data.zone} onDone={announce} /> : null}
    </div>
  );
}

function GoalCard({ goal, canManage, onDone }: { goal: GoalView; canManage: boolean; onDone(t: string): void }) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(String(goal.target));
  const patch = useAction<{ target: number }>('PATCH', { invalidate: [[...GOALS_KEY]] });
  const del = useAction('DELETE', { invalidate: [[...GOALS_KEY]] });
  const [error, setError] = useState<string | null>(null);
  const label = `${METRIC_LABEL[goal.metric]}, ${goal.periodKind} starting ${goal.periodStart}`;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(target);
    if (!Number.isInteger(n) || n < 1) return setError('Enter a whole number of 1 or more.');
    const r = await patch.run(`/goals/${goal.id}`, { target: n });
    if (r.ok) {
      setEditing(false);
      setError(null);
      onDone('Goal changed.');
    } else setError(sentenceFor(r));
  };
  return (
    <Card as="article" className="flex flex-col gap-2" aria-label={label}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[17px] font-semibold text-ink">{METRIC_LABEL[goal.metric]}</h3>
        <Pill tone={TONE[goal.pace.status]}>{STATUS_LABEL[goal.pace.status]}</Pill>
      </div>
      <p className="text-[15px] text-ink-muted">
        {goal.periodKind === 'week' ? 'Week' : goal.periodKind === 'month' ? 'Month' : goal.periodKind === 'quarter' ? 'Quarter' : 'Year'} starting {goal.periodStart}
      </p>
      <p className="text-[16px] text-ink">{goal.pace.words}</p>
      {canManage && !editing ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Change target
          </Button>
          <Button
            variant="quiet"
            onClick={async () => {
              const r = await del.run(`/goals/${goal.id}`);
              if (r.ok) onDone('Goal removed.');
              else setError(sentenceFor(r));
            }}
          >
            Remove
          </Button>
        </div>
      ) : null}
      {editing ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={save}>
          <TextField label="Target" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} />
          <Button type="submit" disabled={patch.pending}>
            Save
          </Button>
          <Button variant="quiet" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Card>
  );
}

function NewGoal({ userId, zone, onDone }: { userId: string; zone: string; onDone(t: string): void }) {
  const [kind, setKind] = useState<PeriodKind>('month');
  const [metric, setMetric] = useState<Metric>('closings');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction<{ userId: string; periodKind: PeriodKind; periodStart: string; metric: Metric; target: number }>('POST', { invalidate: [[...GOALS_KEY]] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(target);
    if (!Number.isInteger(n) || n < 1) return setError('Enter a whole number of 1 or more.');
    const r = await create.run('/goals', { userId, periodKind: kind, periodStart: periodStartOf(kind, todayIn(zone)), metric, target: n });
    if (r.ok) {
      setTarget('');
      setError(null);
      onDone('Goal set.');
    } else setError(sentenceFor(r));
  };
  return (
    <Section title="Set a goal">
      <form className="grid gap-3 md:grid-cols-3" onSubmit={submit}>
        <SelectField label="Period" value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)}>
          {(Object.keys(PERIOD_LABEL) as PeriodKind[]).map((k) => (
            <option key={k} value={k}>
              {PERIOD_LABEL[k]}
            </option>
          ))}
        </SelectField>
        <SelectField label="What to count" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
            <option key={m} value={m}>
              {METRIC_LABEL[m]}
            </option>
          ))}
        </SelectField>
        <TextField label="Target" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} />
        <div className="md:col-span-3">
          <Button type="submit" disabled={create.pending}>
            Set goal
          </Button>
        </div>
        {error ? (
          <div className="md:col-span-3">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}
      </form>
    </Section>
  );
}
