// Scoreboard and momentum (BUILD_PLAN module 17; R-ACC-4, R-ACC-5, ARCHITECTURE §14).
//
// R-ACC-4 (display half): every number on this page shows what it is out of: "12 of 14 within the
// first-touch window", "34 in 7 days", "3 of 5 held", and a median says how many first touches it is
// the median of. The numbers come from the DB views; nothing here estimates or rounds them up.
// Agents and ISAs see their own line; Team Leads see their team; Owners and Admins see everyone.
// Momentum (R-ACC-5) shows open deals by stage and flags those slower than the team median only when
// the team has enough history to compare; otherwise it says so.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { STAGE_LABEL } from '../feed/lib/format.js';
import type { DealStage } from '../feed/lib/types.js';
import { formatDate, formatDays, plural } from '../admin/lib/format.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import type { MomentumResponse, RangeKey, RangeView, Scoreboard } from '../admin/lib/types.js';
import { Pill, Section, Segmented } from '../admin/lib/ui.js';
import { normLine, scoreboardLines } from './lib.js';

const RANGES: readonly { value: RangeKey; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const TEAM_ROLES = new Set(['owner', 'admin', 'team_lead']);

export default function ScoreboardPage() {
  const { session } = useSession();
  const [range, setRange] = useState<RangeKey>('7d');
  const team = TEAM_ROLES.has(session?.tenant?.role ?? '');
  return (
    <div className="flex w-full flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Segmented<RangeKey> label="Period" value={range} onChange={setRange} options={RANGES} />
      </div>
      {team ? <TeamBoard range={range} /> : <OwnBoard range={range} />}
      <Momentum />
    </div>
  );
}

function rangeText(r: RangeView): string {
  return `${formatDate(r.from)} – ${formatDate(r.to)} · times in ${r.zone.replace(/_/g, ' ')}`;
}

function TeamBoard({ range }: { range: RangeKey }) {
  const api = useApi();
  const q = useQuery<{ range: RangeView; members: Scoreboard[] }, ApiError>({
    queryKey: ['team', 'scoreboard', range],
    queryFn: ({ signal }) => api.get(`/team/scoreboard?range=${range}`, { signal }),
  });
  return (
    <Section title="Scoreboard" description={q.data ? rangeText(q.data.range) : undefined}>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data && q.data.members.length === 0 ? <EmptyState icon="team" title="No one on your team yet" /> : null}
      {q.data && q.data.members.length > 0 ? (
        <>
          {/* phone: one card per person */}
          <ul className="flex flex-col gap-3 lg:hidden">
            {q.data.members.map((m) => (
              <li key={m.userId}>
                <BoardCard board={m} />
              </li>
            ))}
          </ul>
          {/* desktop: one row per person */}
          <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface lg:block">
            <table className="w-full text-left text-[15px]">
              <thead className="text-[13px] uppercase tracking-wide text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Member
                  </th>
                  {scoreboardLines(q.data.members[0]!).map((l) => (
                    <th key={l.label} scope="col" className="px-4 py-3 font-semibold">
                      {l.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.members.map((m) => (
                  <tr key={m.userId} className="border-t border-line align-top">
                    <th scope="row" className="px-4 py-3 font-semibold text-ink">
                      {m.name ?? 'Unnamed member'}
                    </th>
                    {scoreboardLines(m).map((l) => (
                      <td key={l.label} className="px-4 py-3 text-ink">
                        <span className="tabular-nums">{l.text}</span>
                        {l.detail ? <span className="block text-[13px] text-ink-muted">{l.detail}</span> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <p className="text-[14px] text-ink-muted">Touches count calls, texts and emails people sent themselves. Messages the assistant sent never count here.</p>
    </Section>
  );
}

function OwnBoard({ range }: { range: RangeKey }) {
  const api = useApi();
  const q = useQuery<{ range: RangeView; scoreboard: Scoreboard }, ApiError>({
    queryKey: ['team', 'scoreboard', 'me', range],
    queryFn: ({ signal }) => api.get(`/scoreboard?range=${range}`, { signal }),
  });
  return (
    <Section title="Your numbers" description={q.data ? rangeText(q.data.range) : undefined}>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data ? <BoardCard board={q.data.scoreboard} /> : null}
      <p className="text-[14px] text-ink-muted">Touches count calls, texts and emails you sent yourself. Messages the assistant sent never count here.</p>
    </Section>
  );
}

function BoardCard({ board }: { board: Scoreboard }) {
  return (
    <Card>
      <h3 className="text-[17px] font-semibold text-ink">{board.name ?? 'Unnamed member'}</h3>
      <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {scoreboardLines(board).map((l) => (
          <div key={l.label}>
            <dt className="text-[14px] text-ink-muted">{l.label}</dt>
            <dd className="text-[16px] tabular-nums text-ink">{l.text}</dd>
            {l.detail ? <dd className="text-[13px] text-ink-muted">{l.detail}</dd> : null}
          </div>
        ))}
      </dl>
    </Card>
  );
}

function stageLabel(s: string): string {
  return STAGE_LABEL[s as DealStage] ?? s.replace(/_/g, ' ');
}

function Momentum() {
  const api = useApi();
  const q = useQuery<MomentumResponse, ApiError>({ queryKey: ['team', 'momentum'], queryFn: ({ signal }) => api.get('/team/momentum', { signal }) });
  const rule = q.data?.rule;
  return (
    <Section
      title="Deal momentum"
      description={rule ? `A deal is flagged when it has stayed in its stage more than ${rule.factor}× the team median, once the team has at least ${rule.minSample} deals through that stage in the last ${rule.windowDays} days.` : undefined}
    >
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data && q.data.agents.length === 0 ? <EmptyState icon="deal" title="No open deals" /> : null}
      <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {q.data?.agents.map((a) => (
          <li key={a.userId}>
            <Card className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="flex-1 text-[17px] font-semibold text-ink">{a.name ?? 'Unnamed member'}</h3>
                <p className="text-[15px] tabular-nums text-ink">
                  {a.slowDeals} of {plural(a.openDeals, 'open deal')} slower than usual
                </p>
              </div>
              {a.stages.map((s) => (
                <div key={s.stage} className="flex flex-col gap-1">
                  <p className="text-[15px] font-medium text-ink">
                    {stageLabel(s.stage)} <span className="font-normal text-ink-muted">· {normLine(s.norm, rule?.minSample ?? 5)}</span>
                  </p>
                  <ul className="flex flex-col gap-1 pl-3">
                    {s.deals.map((d) => (
                      <li key={d.dealId} className="flex flex-wrap items-center gap-2 text-[15px]">
                        <Link to={`/deals/${d.dealId}`} className="inline-flex min-h-tap items-center text-accent underline">
                          {d.name}
                        </Link>
                        <span className="tabular-nums text-ink-muted">{formatDays(d.dwellDays)} in this stage</span>
                        {d.slow ? <Pill tone="warn">Slower than usual</Pill> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}
