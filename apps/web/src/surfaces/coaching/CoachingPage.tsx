// The daily fix page (module 40; R-COACH-2..6, R-INT-6, E106). Phone first: the feed's "Today's coaching
// tip" card opens it in one tap, and each quote plays in one more.
//
//   - one thing to work on today: the tip, why ("Asked about financing: missed in 3 of the last 4 calls")
//     and up to two tap-to-play moments from the person's own calls;
//   - "Not now" sets it aside: no new tip today, and the same item is not suggested for 7 days;
//   - honest states: counsel has not reviewed call reviews yet, the Owner has not turned them on, "Not enough
//     calls yet" (E106), nothing missed;
//   - for an Owner, Admin or Team Lead, the team's tips under "Your team" (a Team Lead sees them only while
//     the Owner allows it; otherwise the page says so).
// No score, grade, percentage, rank or leaderboard anywhere (R-COACH-6): calls are counted, people are not.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { QuotePlayer } from './QuotePlayer.js';
import type { FixView, TeamView, TodayView } from './types.js';

export const TODAY_KEY = ['coaching', 'today'] as const;
export const TEAM_KEY = ['coaching', 'team'] as const;

const OFF_TEXT = {
  not_cleared: { title: 'Call reviews are not on yet', body: 'They stay off until counsel has reviewed them for your team. Nothing about your calls is reviewed in the meantime.' },
  scoring_off: { title: 'Call reviews are off', body: 'Your Owner has not turned on call reviews, so there is no tip today.' },
} as const;

function FixBody({ fix, headingId }: { fix: FixView; headingId: string }) {
  return (
    <>
      <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Try this on your next call</p>
      <h2 id={headingId} className="break-words text-[21px] font-semibold leading-snug text-ink">
        {fix.tip}
      </h2>
      <p className="text-[15px] text-ink">{fix.why}</p>
      {fix.quotes.length > 0 ? (
        <>
          <h3 className="pt-1 text-[15px] font-semibold text-ink">{fix.quotes.length === 1 ? 'A moment from your calls' : 'Two moments from your calls'}</h3>
          <ul className="flex flex-col gap-2" aria-label="Moments from the calls">
            {fix.quotes.map((q, i) => (
              <QuotePlayer key={`${q.callId}:${q.startMs}`} quote={q} index={i} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function Today() {
  const api = useApi();
  const qc = useQueryClient();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery<{ coaching: TodayView }, ApiError>({ queryKey: [...TODAY_KEY], queryFn: ({ signal }) => api.get<{ coaching: TodayView }>('/coaching/today', { signal }) });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error) : null}</Notice>;
  const v = q.data.coaching;
  if (v.state !== 'ready') {
    const t = OFF_TEXT[v.state];
    return (
      <Card aria-labelledby={`${id}-off`} className="flex flex-col gap-2">
        <h2 id={`${id}-off`} className="text-[19px] font-semibold text-ink">
          {t.title}
        </h2>
        <p className="text-[15px] text-ink">{t.body}</p>
      </Card>
    );
  }
  if (!v.fix) {
    return (
      <Card>
        <EmptyState icon="info" title={v.noFix?.text ?? 'No tip today'}>
          {v.noFix?.reason === 'not_enough_calls' ? <p className="text-[15px] text-ink-muted">A tip comes once at least 3 of your recorded calls have been reviewed.</p> : null}
        </EmptyState>
      </Card>
    );
  }
  const notNow = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await api.post<{ coaching: TodayView }>('/coaching/today/dismiss');
      qc.setQueryData([...TODAY_KEY], r);
      void qc.invalidateQueries({ queryKey: ['feed'] });
    } catch (e) {
      setError(messageFor(e as ApiError));
    } finally {
      setPending(false);
    }
  };
  return (
    <Card as="article" aria-labelledby={`${id}-tip`} className="flex flex-col gap-3">
      <FixBody fix={v.fix} headingId={`${id}-tip`} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button variant="quiet" pending={pending} pendingLabel="Setting aside" onClick={() => void notNow()}>
          Not now
        </Button>
        <p className="text-[14px] text-ink-muted">You won’t see this tip again for a week.</p>
      </div>
    </Card>
  );
}

function Team() {
  const api = useApi();
  const id = useId();
  const q = useQuery<{ team: TeamView }, ApiError>({ queryKey: [...TEAM_KEY], queryFn: ({ signal }) => api.get<{ team: TeamView }>('/coaching/team', { signal }) });
  return (
    <section aria-labelledby={`${id}-team`} className="flex flex-col gap-3">
      <h2 id={`${id}-team`} className="text-[19px] font-semibold text-ink">
        Your team
      </h2>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error)}</Notice> : null}
      {q.data ? (
        <>
          <p className="text-[15px] text-ink-muted">{q.data.team.sentence}</p>
          {q.data.team.visible && q.data.team.state === 'ready' ? (
            q.data.team.members.length === 0 ? (
              <p className="text-[15px] text-ink">No one on your team yet.</p>
            ) : (
              <ul className="flex flex-col gap-3" aria-label="Tips by person">
                {q.data.team.members.map((m) => (
                  <li key={m.userId}>
                    <Card aria-labelledby={`${id}-${m.userId}`} className="flex flex-col gap-2">
                      <p id={`${id}-${m.userId}`} className="text-[17px] font-semibold text-ink">
                        {m.name}
                      </p>
                      {m.fix ? <FixBody fix={m.fix} headingId={`${id}-${m.userId}-tip`} /> : <p className="text-[15px] text-ink-muted">{m.noFix?.text ?? 'No tip yet'}</p>}
                    </Card>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default function CoachingPage() {
  const { session } = useSession();
  const role = session?.tenant?.role;
  const leads = role === 'owner' || role === 'admin' || role === 'team_lead';
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 md:mx-0">
      <Today />
      {leads ? <Team /> : null}
    </div>
  );
}
