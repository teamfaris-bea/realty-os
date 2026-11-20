// The lead response report on the scoreboard page (b19 team-queue lane; DATA_MODEL R-TEAMQ-7..9).
//
// Response time FROM ARRIVAL, by lead source (GET /team/lead-response, read-only; Owner, Admin, Team Lead): how many
// inquiries got a human attempt, how many within 5 and 15 staffed minutes, the median and 90th percentile (only
// from a minimum sample, always with the sample), and how many still wait. The inquiries not within 5 minutes are
// listed under their source with who tried, how and in what role. An automatic reply is shown apart and is never
// an attempt. This component only displays: every number and every denominator is the server's (R-ACC-4).
// Phone first: one card per source in one column; no table.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { formatDate } from '../admin/lib/format.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import type { RangeKey } from '../admin/lib/types.js';
import { Section } from '../admin/lib/ui.js';
import { FROM_ARRIVAL_LINE, type LeadResponseReport, type ResponseInquiry, type ResponseRollup, type ResponseRules, responseFootnotes, responseInquiryLine, responseLines } from './lib.js';

export function LeadResponse({ range }: { range: RangeKey }) {
  const api = useApi();
  const q = useQuery<LeadResponseReport, ApiError>({
    queryKey: ['team', 'lead-response', range],
    queryFn: ({ signal }) => api.get<LeadResponseReport>(`/team/lead-response?range=${range}`, { signal }),
  });
  const r = q.data;
  return (
    <Section title="Lead response, from arrival" description={r ? `${formatDate(r.range.from)} – ${formatDate(r.range.to)} · inquiries that arrived in this period` : undefined}>
      <p className="text-[14px] leading-snug text-ink-muted">{FROM_ARRIVAL_LINE}</p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading the response report</p> : null}
      {q.isError ? <Notice tone="error">We could not read the response report. {messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {r ? (
        <>
          {r.truncated ? <Notice tone="warn">This period holds more inquiries than one report reads. The numbers cover the newest {r.totals.inquiries} only.</Notice> : null}
          {r.totals.inquiries === 0 ? (
            <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-[15px] text-ink">No inquiries arrived in this period.</p>
          ) : (
            <>
              <Card as="div">
                <h3 className="text-[17px] font-semibold text-ink">All sources</h3>
                <RollupLines rollup={r.totals} rules={r.rules} />
              </Card>
              <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {r.sources.map((s) => {
                  const name = s.sourceName ?? 'A source with no name';
                  const notWithin = s.notWithin5.length + s.notWithin5More;
                  return (
                    <li key={s.sourceId}>
                      <Card as="div" className="flex flex-col gap-2">
                        <h3 className="text-[17px] font-semibold text-ink">{name}</h3>
                        <RollupLines rollup={s} rules={r.rules} />
                        {s.notWithin5.length > 0 ? (
                          <>
                            <p className="text-[14px] font-medium text-ink">
                              {notWithin} not within {Math.round(r.rules.within5Seconds / 60)} minutes.{s.notWithin5More > 0 ? ` ${s.notWithin5More} more ${s.notWithin5More === 1 ? 'is' : 'are'} not listed.` : ''}
                            </p>
                            <ul aria-label={`Not within ${Math.round(r.rules.within5Seconds / 60)} minutes, ${name}`} className="flex flex-col divide-y divide-line border-l-2 border-line pl-3">
                              {s.notWithin5.map((i) => (
                                <InquiryRow key={i.inquiryId} inquiry={i} />
                              ))}
                            </ul>
                          </>
                        ) : null}
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <ul className="flex flex-col gap-1">
            {responseFootnotes(r).map((line) => (
              <li key={line} className="text-[14px] leading-snug text-ink-muted">
                {line}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

function RollupLines({ rollup, rules }: { rollup: ResponseRollup; rules: ResponseRules }) {
  return (
    <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      {responseLines(rollup, rules).map((l) => (
        <div key={l.label}>
          <dt className="text-[14px] text-ink-muted">{l.label}</dt>
          <dd className="text-[16px] tabular-nums text-ink">{l.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function InquiryRow({ inquiry: i }: { inquiry: ResponseInquiry }) {
  return (
    <li className="flex flex-col py-1">
      <Link to={`/contacts/${i.contact.id}`} className="inline-flex min-h-tap min-w-tap items-center self-start text-[15px] font-semibold text-accent underline">
        {i.contact.name || 'Unnamed person'}
      </Link>
      <p className="text-[14px] leading-snug text-ink">{responseInquiryLine(i)}</p>
    </li>
  );
}
