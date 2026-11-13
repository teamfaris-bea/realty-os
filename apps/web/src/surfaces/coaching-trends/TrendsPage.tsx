// The coaching trends page (module 55 for module 54; R-COACH-7, R-COACH-8, R-STAFF-3, R-STAFF-6, E679). Phone first.
//
//   - Mine: the viewer's own reviewed calls per checklist item, the recent weeks against as many before;
//   - Team (Owner, Admin, Team Lead only; an agent or ISA never asks for it): the team's and each member's. Whether a
//     Team Lead may read it is the database's decision; the page shows the API's state sentence (tl_not_allowed) or,
//     when the definer refuses (COACHING_TRENDS_SCOPE), the same thing in words;
//   - 1-4 weeks (the API's ?weeks=);
//   - each item: its label, the direction in words with the server's sentence, and for each window its dates in words
//     and "met X of Y scored calls (Z calls)"; a withheld count says "Not shown: too few scored calls", never 0 (E679).
// No score, grade, rank or percentage anywhere (R-STAFF-3): calls are counted, people are not.
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { SelectField } from '../admin/lib/ui.js';
import { TRENDS_MESSAGES } from './messages.js';
import type { OwnTrendsView, TeamTrendsView, TrendCounts, TrendDirection, TrendItemView, TrendWindow } from './types.js';

export const TRENDS_KEY = ['coaching', 'trends'] as const;
const WEEKS = [1, 2, 3, 4] as const;
type Weeks = (typeof WEEKS)[number];

const DIRECTION_WORDS: Record<TrendDirection, string> = {
  improving: 'Improving',
  slipping: 'Slipping',
  steady: 'Steady',
  not_enough_data: 'Not enough reviewed calls to compare',
};

const WEEKS_WORDS: Record<Weeks, string> = {
  1: 'Last week, against the week before',
  2: 'Last 2 weeks, against the 2 before',
  3: 'Last 3 weeks, against the 3 before',
  4: 'Last 4 weeks, against the 4 before',
};

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "2026-11-02" → a Date at that calendar day (UTC midnight: the formatter reads it in UTC, so the day never shifts). */
function dayOf(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

/** A window in words: "November 2 to November 8" (the year added when it spans two). Never the stored string. */
export function windowWords(w: TrendWindow): string {
  const a = dayOf(w.from);
  const b = dayOf(w.to);
  if (!a || !b) return 'dates not known';
  const f = a.getUTCFullYear() === b.getUTCFullYear() ? DAY : DAY_YEAR;
  return `${f.format(a)} to ${f.format(b)}`;
}

const calls = (n: number) => (n === 1 ? '1 call' : `${n} calls`);

/** "met 3 of 6 scored calls (8 calls)"; withheld: "Not shown: too few scored calls (8 calls)" — never 0 (E679). */
export function countsWords(c: TrendCounts): string {
  if (c.met === null) return `Not shown: too few scored calls (${calls(c.calls)})`;
  return `met ${c.met} of ${c.scored} scored ${c.scored === 1 ? 'call' : 'calls'} (${calls(c.calls)})`;
}

function Item({ item, windows, level }: { item: TrendItemView; windows: OwnTrendsView['windows']; level: 3 | 4 }) {
  const id = useId();
  const H = level === 3 ? 'h3' : 'h4';
  return (
    <li aria-labelledby={id} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <H id={id} className="text-[17px] font-semibold text-ink">
        {item.label}
      </H>
      <p className="text-[15px] text-ink">
        <span className="font-semibold">{DIRECTION_WORDS[item.direction]}.</span> {item.sentence}
      </p>
      <dl className="grid grid-cols-1 gap-x-3 text-[15px] text-ink-muted sm:grid-cols-[auto_1fr]">
        <dt>Earlier, {windowWords(windows.before)}:</dt>
        <dd>{countsWords(item.before)}</dd>
        <dt>Recent, {windowWords(windows.after)}:</dt>
        <dd>{countsWords(item.after)}</dd>
      </dl>
    </li>
  );
}

function Items({ items, windows, label, level = 3 }: { items: TrendItemView[]; windows: OwnTrendsView['windows']; label: string; level?: 3 | 4 }) {
  if (items.length === 0) return <p className="text-[15px] text-ink-muted">No checklist items to show.</p>;
  return (
    <ul className="flex flex-col" aria-label={label}>
      {items.map((it) => (
        <Item key={it.key} item={it} windows={windows} level={level} />
      ))}
    </ul>
  );
}

function StateCard({ sentence }: { sentence: string }) {
  return (
    <Card>
      <p className="text-[15px] text-ink">{sentence}</p>
    </Card>
  );
}

function Mine({ weeks }: { weeks: Weeks }) {
  const api = useApi();
  const id = useId();
  const q = useQuery<{ trends: OwnTrendsView }, ApiError>({
    queryKey: [...TRENDS_KEY, 'mine', weeks],
    queryFn: ({ signal }) => api.get<{ trends: OwnTrendsView }>(`/coaching/trends?weeks=${weeks}`, { signal }),
  });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, TRENDS_MESSAGES) : null}</Notice>;
  const v = q.data.trends;
  if (v.state !== 'ready') return <StateCard sentence={v.sentence} />;
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-[19px] font-semibold text-ink">
        Your calls
      </h2>
      <p className="text-[15px] text-ink-muted">{v.sentence}</p>
      <Items items={v.items} windows={v.windows} label="Your checklist items" />
    </Card>
  );
}

function Team({ weeks }: { weeks: Weeks }) {
  const api = useApi();
  const id = useId();
  const q = useQuery<{ trends: TeamTrendsView }, ApiError>({
    queryKey: [...TRENDS_KEY, 'team', weeks],
    queryFn: ({ signal }) => api.get<{ trends: TeamTrendsView }>(`/coaching/trends/team?weeks=${weeks}`, { signal }),
  });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  // COACHING_TRENDS_SCOPE: the definer refused; said like the state sentence, never as an error code
  if (q.isError && q.error.code === 'COACHING_TRENDS_SCOPE') return <StateCard sentence={TRENDS_MESSAGES.COACHING_TRENDS_SCOPE!} />;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, TRENDS_MESSAGES) : null}</Notice>;
  const v = q.data.trends;
  if (v.state !== 'ready') return <StateCard sentence={v.sentence} />;
  return (
    <div className="flex flex-col gap-4">
      <Card aria-labelledby={id} className="flex flex-col gap-3">
        <h2 id={id} className="text-[19px] font-semibold text-ink">
          The team
        </h2>
        <p className="text-[15px] text-ink-muted">{v.sentence}</p>
        {v.members.length > 0 ? <Items items={v.team} windows={v.windows} label="The team’s checklist items" /> : null}
      </Card>
      {v.members.length > 0 ? (
        <section aria-labelledby={`${id}-m`} className="flex flex-col gap-3">
          <h2 id={`${id}-m`} className="text-[19px] font-semibold text-ink">
            Each person
          </h2>
          <ul className="flex flex-col gap-3" aria-label="Trends by person">
            {v.members.map((m) => (
              <li key={m.userId} aria-labelledby={`${id}-${m.userId}`}>
                <Card as="div" className="flex flex-col gap-2">
                  <h3 id={`${id}-${m.userId}`} className="break-words text-[17px] font-semibold text-ink">
                    {m.name}
                  </h3>
                  <Items items={m.items} windows={v.windows} label={`${m.name}’s checklist items`} level={4} />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default function TrendsPage() {
  const { session } = useSession();
  const role = session?.tenant?.role;
  // R-STAFF-6: only these roles hold coaching.team_view; an agent or ISA never sees the tab or asks for the team
  const leads = role === 'owner' || role === 'admin' || role === 'team_lead';
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [weeks, setWeeks] = useState<Weeks>(1);
  const shown = leads ? tab : 'mine';
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 md:mx-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {leads ? (
          <div role="group" aria-label="Whose trends" className="flex gap-2">
            {(['mine', 'team'] as const).map((t) => (
              <Button key={t} variant={shown === t ? 'primary' : 'secondary'} aria-pressed={shown === t} onClick={() => setTab(t)}>
                {t === 'mine' ? 'Mine' : 'Team'}
              </Button>
            ))}
          </div>
        ) : null}
        <SelectField label="Compare" className="sm:min-w-72" value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value) as Weeks)}>
          {WEEKS.map((w) => (
            <option key={w} value={w}>
              {WEEKS_WORDS[w]}
            </option>
          ))}
        </SelectField>
      </div>
      {shown === 'team' ? <Team weeks={weeks} /> : <Mine weeks={weeks} />}
    </div>
  );
}
