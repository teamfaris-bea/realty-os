// The TC board (module 39): the caller's open deals (the server's RLS decides: a TC sees the deals they are on) with
// their proposed, upcoming and at-risk dates, in one request. Desktop-first table; on a phone each deal is a card.
// A proposed date is confirmed from here in one tap, by a caller the server lets confirm (canConfirm; b8 deals ui/F4). At-risk is the server's milestoneRisk over stored fields, not
// the Team Lead queue (a TC reads no queue items).
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { formatLocalDate } from '../feed/lib/format.js';
import { useMutate } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import { type BoardDeal, CONFIRM_WHO, MILESTONE_ERROR_MESSAGES, RESPONSIBLE_LABEL } from './milestones.js';

const MESSAGES = { ...AGENT_ERROR_MESSAGES, ...MILESTONE_ERROR_MESSAGES };

export default function BoardPage() {
  const api = useApi();
  const q = useQuery<{ deals: BoardDeal[]; upcomingDays: number }, ApiError>({ queryKey: ['transactions', 'board'], queryFn: ({ signal }) => api.get('/transactions/board', { signal }) });
  const confirm = useMutate<Record<string, never>>('POST', { invalidate: [['transactions', 'board'], ['deal']] });
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, MESSAGES)}</Notice>;
  const { deals, upcomingDays } = q.data;
  return (
    <div className="flex w-full flex-col gap-4">
      <p className="text-[15px] text-ink-muted">Open deals with proposed dates, dates due in the next {upcomingDays} days, and dates at risk.</p>
      {confirm.error ? <Notice tone="error">{MESSAGES[confirm.error.code] ?? confirm.error.message}</Notice> : null}
      {deals.length === 0 ? (
        <EmptyState icon="checklist" title="Nothing to act on">
          No open deal has a proposed, upcoming or at-risk date.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {deals.map((d) => (
            <li key={d.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2">
                <Link to={`/deals/${d.id}`} className="text-[16px] font-medium text-accent underline">
                  {d.name}
                </Link>
                <span className="text-[14px] text-ink-muted">
                  {[d.proposed > 0 ? `${d.proposed} proposed` : null, d.atRisk > 0 ? `${d.atRisk} at risk` : null].filter(Boolean).join(' · ') || 'On track'}
                </span>
              </div>
              {!d.canConfirm ? <p className="border-b border-line px-4 py-2 text-[14px] text-ink-muted">{CONFIRM_WHO}</p> : null}
              <table className="w-full text-left text-[15px]">
                <caption className="sr-only">Dates of {d.name}</caption>
                <thead className="hidden text-[13px] text-ink-muted md:table-header-group">
                  <tr>
                    <th scope="col" className="px-4 py-1 font-medium">Date</th>
                    <th scope="col" className="px-4 py-1 font-medium">Due</th>
                    <th scope="col" className="px-4 py-1 font-medium">Responsible</th>
                    <th scope="col" className="px-4 py-1 font-medium">Status</th>
                    <th scope="col" className="px-4 py-1 font-medium"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {d.dates.map((x) => (
                    <tr key={x.id} className="flex flex-wrap items-center gap-x-3 border-t border-line px-4 py-2 first:border-t-0 md:table-row md:px-0">
                      <th scope="row" className="font-medium text-ink md:px-4 md:py-2">
                        {x.label}
                        {x.rule ? <span className="block text-[13px] font-normal text-ink-muted">{x.rule}</span> : null}
                        {x.nonBusinessDayNote ? <span className="block text-[13px] font-normal text-warn">{x.nonBusinessDayNote}</span> : null}
                      </th>
                      <td className="text-ink md:px-4 md:py-2">{formatLocalDate(x.dueOn)}</td>
                      <td className="text-ink-muted md:px-4 md:py-2">{x.responsible ? (RESPONSIBLE_LABEL[x.responsible] ?? x.responsible) : 'Nobody named'}</td>
                      <td className={`md:px-4 md:py-2 ${x.risk ? 'font-medium text-danger' : 'text-ink-muted'}`}>{x.risk ? x.risk.text : x.status === 'proposed' ? 'Proposed' : 'Upcoming'}</td>
                      <td className="md:px-4 md:py-2">
                        {d.canConfirm && x.status === 'proposed' ? (
                          <Button disabled={confirm.pending} onClick={() => void confirm.run(`/deal-dates/${x.id}/confirm`, {})} aria-label={`Confirm ${x.label} on ${formatLocalDate(x.dueOn)}`}>
                            Confirm
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
