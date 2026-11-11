// Bulk action pages (parity module 64):
//   /bulk            your recent bulk actions (a Team Lead also sees their team's; the Owner/Admin everyone's)
//   /bulk/:id        one action: progress with counts by reason, Cancel while it runs (R-PAR-42)
//   /bulk/new?kind=…&contacts=a,b[&tag=…|&to=…|&plan=…]   opens the bulk sheet for a selection (the People
//                    page's bulk bar opens the same sheet in place; this link is for a selection made elsewhere)
// Every number shows its denominator; every left-out person is counted under a reason.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { Button, ButtonLink, Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { BULK_ERROR_MESSAGES, BULK_KEY, type BulkActionView, type BulkKind, KIND_WORDS, reasonWords } from './api.js';
import { BulkActionSheet } from './BulkActionSheet.js';

const STATUS_WORDS: Record<BulkActionView['status'], string> = {
  draft: 'Not confirmed',
  confirmed: 'Starting',
  running: 'Running',
  completed: 'Finished',
  canceled: 'Canceled',
  failed: 'Stopped',
};

export function summary(a: BulkActionView): string {
  const w = KIND_WORDS[a.kind];
  if (a.status === 'draft') return `${w.verb} ${a.targetCount} of ${a.selected} (not confirmed)`;
  return `${w.done} ${a.counts.done} of ${a.selected}`;
}

export function BulkListPage() {
  const api = useApi();
  const q = useQuery<{ actions: BulkActionView[] }, ApiError>({ queryKey: [...BULK_KEY], queryFn: ({ signal }) => api.get<{ actions: BulkActionView[] }>('/bulk-actions', { signal }), refetchInterval: 5000 });
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 md:mx-0">
      <p className="text-[15px] text-ink-muted">Bulk actions you started (and your team's, if you lead one). Select people on the People page to start one.</p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, BULK_ERROR_MESSAGES)}</Notice> : null}
      {q.data?.actions.length === 0 ? <EmptyState icon="people" title="No bulk actions yet" /> : null}
      <ul className="flex flex-col gap-2">
        {(q.data?.actions ?? []).map((a) => (
          <li key={a.id}>
            <Card as="div" className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[17px] font-medium text-ink">{summary(a)}</span>
                <span className="text-[14px] text-ink-muted">
                  {STATUS_WORDS[a.status]} · {new Date(a.createdAt).toLocaleString()}
                  {a.mine ? '' : ' · started by a teammate'}
                </span>
              </div>
              <ButtonLink to={`/bulk/${a.id}`} variant="secondary" aria-label={`Open: ${summary(a)}`}>
                Open
              </ButtonLink>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BulkDetailPage() {
  const { bulkId = '' } = useParams();
  const api = useApi();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const q = useQuery<{ action: BulkActionView }, ApiError>({
    queryKey: [...BULK_KEY, bulkId],
    queryFn: ({ signal }) => api.get<{ action: BulkActionView }>(`/bulk-actions/${bulkId}`, { signal }),
    refetchInterval: (query) => (query.state.data && ['confirmed', 'running'].includes(query.state.data.action.status) ? 2000 : false),
  });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, BULK_ERROR_MESSAGES) : null}</Notice>;
  const a = q.data.action;
  const live = a.status === 'draft' || a.status === 'confirmed' || a.status === 'running';
  const reasons = Object.entries(a.counts.byReason).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  const cancel = async () => {
    setCanceling(true);
    setError(null);
    try {
      const r = await api.post<{ action: BulkActionView }>(`/bulk-actions/${a.id}/cancel`, {});
      qc.setQueryData([...BULK_KEY, a.id], r);
    } catch (e) {
      setError(messageFor(e as ApiError, BULK_ERROR_MESSAGES));
    } finally {
      setCanceling(false);
    }
  };
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 md:mx-0">
      <Card className="flex flex-col gap-2">
        <h2 className="text-[19px] font-semibold text-ink">{summary(a)}</h2>
        <p className="text-[15px] text-ink-muted" role="status">
          {STATUS_WORDS[a.status]}
          {a.counts.pending > 0 && live ? ` · ${a.counts.pending} still to go` : ''}
        </p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[15px] text-ink sm:grid-cols-3">
          <div><dt className="text-ink-muted">Done</dt><dd className="font-semibold">{a.counts.done} of {a.selected}</dd></div>
          <div><dt className="text-ink-muted">Left out</dt><dd className="font-semibold">{a.counts.skipped + a.counts.blocked}</dd></div>
          <div><dt className="text-ink-muted">Failed</dt><dd className="font-semibold">{a.counts.failed}</dd></div>
        </dl>
        {reasons.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-[15px] text-ink" aria-label="Why people were left out">
            {reasons.map(([code, n]) => (
              <li key={code} data-reason={code}>
                <span className="font-semibold">{n}</span> {reasonWords(code)}
              </li>
            ))}
          </ul>
        ) : null}
        {a.body ? (
          <details className="text-[15px] text-ink">
            <summary className="min-h-tap cursor-pointer py-2 font-medium text-accent">The message</summary>
            {a.subject ? <p className="font-semibold [overflow-wrap:anywhere]">{a.subject}</p> : null}
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{a.body}</p>
          </details>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {live ? (
          <Button variant="danger" className="self-start" pending={canceling} pendingLabel="Canceling" onClick={() => void cancel()}>
            Cancel the rest
          </Button>
        ) : null}
        {live ? <p className="text-[14px] text-ink-muted">Canceling stops everyone not reached yet. Messages already sent stay sent.</p> : null}
      </Card>
    </div>
  );
}

const KINDS: readonly BulkKind[] = ['tag', 'untag', 'stage', 'assign', 'enroll', 'email', 'text'];

export function BulkNewPage() {
  const [p] = useSearchParams();
  const navigate = useNavigate();
  const kind = p.get('kind') as BulkKind | null;
  const contactIds = (p.get('contacts') ?? '').split(',').filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  const [open, setOpen] = useState(true);
  if (!kind || !KINDS.includes(kind) || contactIds.length === 0) return <Notice tone="warn">Select people on the People page first.</Notice>;
  const params = { ...(p.get('tag') ? { tagId: p.get('tag')! } : {}), ...(p.get('to') ? { toUserId: p.get('to')! } : {}), ...(p.get('plan') ? { playbookId: p.get('plan')! } : {}) };
  const audience = (p.get('audienceTags') ?? '').split(',').filter(Boolean);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 md:mx-0">
      <p className="text-[15px] text-ink-muted">
        {contactIds.length} {contactIds.length === 1 ? 'person' : 'people'} selected.
      </p>
      {!open ? (
        <Button className="self-start" onClick={() => setOpen(true)}>
          {`${KIND_WORDS[kind].verb} ${contactIds.length} ${contactIds.length === 1 ? 'person' : 'people'}`}
        </Button>
      ) : null}
      {open ? <BulkActionSheet kind={kind} contactIds={contactIds} audienceTagIds={audience} params={params} onClose={() => setOpen(false)} onConfirmed={(a) => navigate(`/bulk/${a.id}`, { replace: true })} /> : null}
    </div>
  );
}
