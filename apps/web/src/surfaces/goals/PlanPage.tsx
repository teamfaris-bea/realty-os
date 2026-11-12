// The weekly plan page the feed card opens (PHASE2_3_PLAN module 40; R-PLAN-1…3; E110, E111).
//
// 3–5 concrete items, deadline first, each with why it is on the list (its evidence) and a link to the person or deal.
// Never a grade. The plan header says how it was ranked, and when there are no goals that it was built from the
// pipeline only (E110). Items that no longer apply (a deal reassigned since, E111) were already dropped by the server;
// the page says how many.
// "Add to my tasks" (one tap) adds the ticked items (all ticked at first) to the member's tasks; nothing is created
// without that tap. Items that already are tasks are not copied.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, ButtonLink, Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { plural } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { Check, StatusLine } from '../admin/lib/ui.js';
import { sentenceFor } from '../owner/messages.js';
import { humanize, instantDayWords, weekWords } from './humanize.js';
import { PLAN_KEY, type PlanItemView, type PlanResponse } from './types.js';

/** The deadline as a day in the TEAM's zone (the same zone the evidence sentences use). */
export function deadlineWords(iso: string | null, zone: string): string | null {
  return iso ? `Due ${instantDayWords(iso, zone)}` : null;
}

function openLink(i: PlanItemView): { to: string; label: string } | null {
  if (i.dealId) return { to: `/deals/${i.dealId}`, label: 'Open the deal' };
  if (i.contactId) return { to: `/contacts/${i.contactId}`, label: 'Open the person' };
  if (i.evidence[0]?.sourceType === 'task') return { to: `/tasks#task-${i.evidence[0].sourceId}`, label: 'Open the task' };
  return null;
}

export default function PlanPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { week } = useParams();
  const path = week ? `/me/weekly-plans/${week}` : '/me/weekly-plans/current';
  const q = useQuery<PlanResponse, ApiError>({ queryKey: [...PLAN_KEY, week ?? 'current'], queryFn: ({ signal }) => api.get(path, { signal }) });
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [status, announce] = useAnnounce(6000);
  const accept = useAction<{ itemIndexes: number[] }, PlanResponse>('POST', { invalidate: [['feed'], ['tasks']] });
  const [error, setError] = useState<string | null>(null);
  const hid = useId();
  const items = q.data?.items ?? [];
  const accepted = q.data?.accepted ?? null;
  useEffect(() => setPicked(null), [week]);
  const chosen = picked ?? new Set(items.map((x) => x.index));

  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{sentenceFor(q.error)}</Notice>;
  const p = q.data;
  if (!p.exists)
    return (
      <EmptyState icon="checklist" title={`No plan for the ${weekWords(p.week).replace(/^Week/, 'week')} yet`}>
        Your plan is made on Monday morning from your tasks, promises, appointments and deals.
      </EmptyState>
    );

  const add = async () => {
    const r = await accept.run(`/me/weekly-plans/${p.week}/accept`, { itemIndexes: [...chosen].sort((a, b) => a - b) });
    if (r.ok) {
      setError(null);
      qc.setQueryData([...PLAN_KEY, week ?? 'current'], r.data);
      announce(`Added ${plural(chosen.size, 'item')} to your tasks.`);
    } else {
      setError(sentenceFor(r));
      if (r.code === 'PLAN_ALREADY_ACCEPTED') void q.refetch();
    }
  };

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <p className="text-[17px] font-semibold text-ink" data-testid="plan-week">
        {weekWords(p.week)}
      </p>
      <p className="text-[16px] text-ink" id={hid}>
        {p.note}
      </p>
      {p.droppedSinceBuilt ? (
        <p className="text-[15px] text-ink-muted">
          {p.droppedSinceBuilt === 1 ? '1 item no longer applies' : `${p.droppedSinceBuilt} items no longer apply`} since the plan was made and {p.droppedSinceBuilt === 1 ? 'is' : 'are'} not shown.
        </p>
      ) : null}
      <StatusLine text={status} />
      {items.length === 0 ? (
        <EmptyState icon="check" title="Nothing came up this week">
          No open promises, tasks due, appointments missing an outcome or slow deals.
        </EmptyState>
      ) : (
        <ol className="flex flex-col gap-3" aria-labelledby={hid}>
          {items.map(({ index, item, accepted: done }, n) => {
            const link = openLink(item);
            const due = deadlineWords(item.deadline, p.zone);
            return (
              <li key={index}>
                <Card as="article" className="flex flex-col gap-2">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink-muted" aria-hidden="true">
                      {n + 1}.
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <h2 className="text-[17px] font-semibold text-ink">{item.title}</h2>
                      {due ? <p className="text-[15px] font-medium text-ink">{due}</p> : null}
                      <ul className="text-[15px] text-ink-muted" aria-label="Why this is on your plan">
                        {item.evidence.map((e) => (
                          <li key={e.sourceId}>{humanize(e.reason)}</li>
                        ))}
                      </ul>
                      {link ? (
                        <Link to={link.to} aria-label={`${link.label}: ${item.title}`} className="inline-flex min-h-tap items-center font-semibold text-accent underline">
                          {link.label}
                        </Link>
                      ) : null}
                    </div>
                  </div>
                  {accepted ? (
                    done ? <p className="text-[15px] font-medium text-ok">On your tasks</p> : null
                  ) : (
                    <Check
                      label={
                        <>
                          Add<span className="sr-only"> “{item.title}”</span> to my tasks
                        </>
                      }
                      checked={chosen.has(index)}
                      onChange={(v) => {
                        const next = new Set(chosen);
                        if (v) next.add(index);
                        else next.delete(index);
                        setPicked(next);
                      }}
                    />
                  )}
                </Card>
              </li>
            );
          })}
        </ol>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {items.length > 0 && !accepted ? (
        <Button onClick={add} disabled={accept.pending || chosen.size === 0} block>
          {chosen.size === 0 ? 'Tick at least one item' : `Add ${plural(chosen.size, 'item')} to my tasks`}
        </Button>
      ) : null}
      {accepted ? (
        <ButtonLink variant="secondary" to="/tasks">
          Open my tasks
        </ButtonLink>
      ) : null}
    </div>
  );
}
