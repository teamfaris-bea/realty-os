// The team work queue on the team page (b19 team-queue lane; DATA_MODEL R-TEAMQ-1..6).
//
// "Did anybody call?" Five groups the server builds (GET /team/queue, read-only): new leads nobody has tried yet,
// replies nobody has answered, promises past due, follow-ups past due, appointments needing an outcome. Each row
// is who, why and how long, with the owner or "No owner yet", and the name opens the person. This component only
// displays: the "why" sentence, the owner words and the counts are the server's, and nothing here acts on a lead.
//
// - Phone first: one column; each group is a full-width toggle (44 px) with its count; the new-lead group starts
//   open, the others closed, and a person's choice is kept while the list refreshes.
// - Honest states: while loading it says so; when the read fails it says it could not check (never "nobody is
//   waiting"); an empty group says so in its own words.
// - It refreshes every 30 s with the exception list beside it and says when it was last checked.
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import { type TeamQueueGroup, type TeamQueueGroupKey, type TeamQueueResponse, queueCount, queueFootnote, queueMoreLine, queueWait } from './lib.js';

export const WORK_QUEUE_KEY = ['team', 'queue'] as const;
const REFRESH_MS = 30_000;

/** One line under the heading: how this queue differs from the exception list under it. */
export const QUEUE_VERSUS_MISSES =
  'This is who is waiting for a person right now, counted from when they arrived. The list under it, Missed deadlines, is the record of deadlines already missed that someone has to resolve or verify.';

export function WorkQueue() {
  const api = useApi();
  const headingId = useId();
  const q = useQuery<TeamQueueResponse, ApiError>({
    queryKey: [...WORK_QUEUE_KEY],
    queryFn: ({ signal }) => api.get<TeamQueueResponse>('/team/queue', { signal }),
    refetchInterval: REFRESH_MS,
  });
  // a person's open/closed choice per group; until they choose, the new-lead group is open and the rest closed
  const [chosen, setChosen] = useState<Partial<Record<TeamQueueGroupKey, boolean>>>({});
  const isOpen = (key: TeamQueueGroupKey) => chosen[key] ?? key === 'new_lead';

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-[19px] font-semibold text-ink">
          Waiting now
        </h2>
        <p className="text-[14px] leading-snug text-ink-muted">{QUEUE_VERSUS_MISSES}</p>
      </div>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading who is waiting</p> : null}
      {q.isError ? (
        <Notice tone="error">
          We could not check who is waiting. Nothing here says that nobody is. {messageFor(q.error, ADMIN_MESSAGES)}
        </Notice>
      ) : null}
      {q.data ? (
        <>
          <div className="flex flex-col gap-2">
            {q.data.groups.map((g) => (
              <QueueGroup key={g.key} group={g} open={isOpen(g.key)} onToggle={() => setChosen((c) => ({ ...c, [g.key]: !isOpen(g.key) }))} />
            ))}
          </div>
          <p className="text-[13px] leading-snug text-ink-muted">{queueFootnote(q.data)}</p>
        </>
      ) : null}
    </section>
  );
}

function QueueGroup({ group: g, open, onToggle }: { group: TeamQueueGroup; open: boolean; onToggle(): void }) {
  const listId = useId();
  const count = queueCount(g);
  const more = queueMoreLine(g);
  if (g.total === 0) {
    // nothing to open: the label, a zero, and the group's own honest sentence
    return (
      <div role="group" aria-label={`${g.label}: ${count}`} className="rounded-2xl border border-line bg-surface px-4 py-3">
        <p className="flex items-center gap-2 text-[16px] font-semibold text-ink">
          <span className="min-w-0 flex-1">{g.label}</span>
          <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[13px] font-semibold text-ink">0</span>
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-[14px] text-ink-muted">
          <span className="text-ok">
            <Icon name="check" size={16} />
          </span>
          {g.empty}
        </p>
      </div>
    );
  }
  return (
    <div role="group" aria-label={`${g.label}: ${count}`} className="rounded-2xl border border-line bg-surface">
      <h3 className="m-0">
        <button type="button" aria-expanded={open} aria-controls={listId} onClick={onToggle} className="flex min-h-tap w-full items-center gap-2 rounded-2xl px-4 py-2 text-left text-[16px] font-semibold text-ink">
          <span className="min-w-0 flex-1">{g.label}</span>
          <span className="rounded-md bg-warn-soft px-2 py-0.5 text-[13px] font-semibold text-ink">{count}</span>
          <span className="text-[13px] font-medium text-ink-muted">{open ? 'Hide' : 'Show'}</span>
        </button>
      </h3>
      {open ? (
        <div id={listId} className="border-t border-line px-4 pb-3">
          <ul className="flex flex-col divide-y divide-line">
            {g.rows.map((r) => (
              <li key={r.key} className="flex flex-col gap-0.5 py-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <Link to={`/contacts/${r.contact.id}`} className="inline-flex min-h-tap min-w-tap items-center text-[16px] font-semibold text-accent underline">
                    {r.contact.name || 'Unnamed person'}
                  </Link>
                  <span className="text-[14px] text-ink-muted">{queueWait(g.key, r)}</span>
                </div>
                <p className="text-[14px] leading-snug text-ink">{r.why}</p>
                <p className={`text-[14px] font-medium ${r.owner.kind === 'owner' ? 'text-ink-muted' : 'text-ink'}`}>{r.owner.label}</p>
              </li>
            ))}
          </ul>
          {more ? <p className="pt-2 text-[14px] text-ink-muted">{more}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
