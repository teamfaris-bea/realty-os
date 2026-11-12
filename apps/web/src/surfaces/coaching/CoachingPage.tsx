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
import { useEffect, useId, useRef, useState } from 'react';
import { Button, Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { QuotePlayer } from './QuotePlayer.js';
import type { FixView, TeamView, TodayView } from './types.js';

export const TODAY_KEY = ['coaching', 'today'] as const;
export const TEAM_KEY = ['coaching', 'team'] as const;

const OFF_TEXT = {
  not_cleared: { title: 'Call reviews are not on yet', body: 'They stay off until counsel has reviewed them for your team. Nothing about your calls is reviewed in the meantime.' },
  // neutral (batch 7 review ui/F8): an Admin may have turned them off (E283), and the Owner reads this page too
  scoring_off: { title: 'Call reviews are off', body: 'Call reviews are off for your team, so there is no tip today. Only the Owner can turn them on.' },
} as const;

function FixBody({ fix, headingId, level = 2, who }: { fix: FixView; headingId: string; level?: 2 | 3; /** a team member's name: their tip, said about them */ who?: string }) {
  const H = level === 2 ? 'h2' : 'h3';
  const Sub = level === 2 ? 'h3' : 'h4';
  return (
    <>
      <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">{who ? 'Most missed lately' : 'Try this on your next call'}</p>
      <H id={headingId} className="break-words text-[21px] font-semibold leading-snug text-ink">
        {fix.tip}
      </H>
      <p className="text-[15px] text-ink">{fix.why}</p>
      {fix.quotes.length > 0 ? (
        <>
          <Sub className="pt-1 text-[15px] font-semibold text-ink">{fix.quotes.length === 1 ? 'A moment from the calls' : 'Two moments from the calls'}</Sub>
          <ul className="flex flex-col gap-2" aria-label={who ? `Moments from ${who}’s calls` : 'Moments from the calls'}>
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
  // after "Not now" the card is replaced: focus moves to what replaced it, not to <body>
  const after = useRef<HTMLDivElement | null>(null);
  const [focusAfter, setFocusAfter] = useState(false);
  useEffect(() => {
    if (focusAfter && after.current) {
      after.current.focus();
      setFocusAfter(false);
    }
  }, [focusAfter]);
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
      <div ref={after} tabIndex={-1} className="outline-none">
        <Card>
          <EmptyState icon="info" title={v.noFix?.text ?? 'No tip today'}>
            {v.noFix?.reason === 'not_enough_calls' ? <p className="text-[15px] text-ink-muted">A tip comes once at least 3 of your recorded calls have been reviewed.</p> : null}
          </EmptyState>
        </Card>
      </div>
    );
  }
  const notNow = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await api.post<{ coaching: TodayView }>('/coaching/today/dismiss');
      qc.setQueryData([...TODAY_KEY], r);
      setFocusAfter(true);
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
                  <li key={m.userId} aria-labelledby={`${id}-${m.userId}`}>
                    <Card as="div" className="flex flex-col gap-2">
                      <p id={`${id}-${m.userId}`} className="text-[17px] font-semibold text-ink">
                        {m.name}
                      </p>
                      {m.fix ? <FixBody fix={m.fix} headingId={`${id}-${m.userId}-tip`} level={3} who={m.name} /> : <p className="text-[15px] text-ink-muted">{m.noFix?.text ?? 'No tip yet'}</p>}
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
