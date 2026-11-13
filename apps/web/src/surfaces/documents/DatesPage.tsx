// Contract-date review (module 55 item 7): /documents/:documentId/dates, every role (the extraction is its uploader's
// and tenant-wide roles'; anyone else gets 404 and is told who can review, E676). Reads GET /documents/:id/extraction
// and the deal's canConfirm from GET /deals/:id/milestones (the server's can(milestone.confirm); without it the page
// is read-only and says who can confirm). Claims are decided one by one (ClaimRow); this page never calls an
// /assistant route (R-STAFF-2). "Read dates now" shows only while the contract has not been read (not_started).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { useAction } from '../admin/lib/hooks.js';
import { CONFIRM_WHO, type DealMilestones } from '../deals/milestones.js';
import { ClaimRow } from './ClaimRow.js';
import { PlatformLines } from './DocumentsSection.js';
import type { ClaimView, ExtractionResponse, ExtractionStatus } from './types.js';
import { DOC_MESSAGES, EXTRACTION_WORDS, KIND_WORDS, WHO_REVIEWS, docKeys } from './words.js';

/** States where the person enters the dates by hand on the deal timeline. */
const BY_HAND: readonly ExtractionStatus[] = ['photo', 'not_set_up'];

/** Claims in order, the conflicting ones of one kind together (shown side by side, E675). */
export function groupClaims(claims: readonly ClaimView[]): ClaimView[][] {
  const out: ClaimView[][] = [];
  const seen = new Set<string>();
  for (const c of [...claims].sort((a, b) => a.ordinal - b.ordinal)) {
    if (seen.has(c.id)) continue;
    const group = c.conflictsWith.length > 0 ? [c, ...claims.filter((o) => c.conflictsWith.includes(o.id) && !seen.has(o.id))] : [c];
    for (const g of group) seen.add(g.id);
    out.push(group);
  }
  return out;
}

export default function DatesPage() {
  const { documentId = '' } = useParams();
  const api = useApi();
  const qc = useQueryClient();
  const heading = useId();
  const key = docKeys.extraction(documentId);
  const q = useQuery<ExtractionResponse, ApiError>({ queryKey: key, queryFn: ({ signal }) => api.get<ExtractionResponse>(`/documents/${documentId}/extraction`, { signal }), retry: false });
  const dealId = q.data?.document.scope.kind === 'deal' ? q.data.document.scope.id : null;
  const m = useQuery<DealMilestones, ApiError>({ queryKey: ['deal', dealId, 'milestones'], queryFn: ({ signal }) => api.get<DealMilestones>(`/deals/${dealId}/milestones`, { signal }), enabled: dealId !== null, retry: false });
  const read = useAction<Record<string, never>, ExtractionResponse>('POST');
  const [readError, setReadError] = useState<string | null>(null);

  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{q.error.code === 'NOT_FOUND' ? WHO_REVIEWS : messageFor(q.error, DOC_MESSAGES)}</Notice>;
  const x = q.data;
  const d = x.document;
  const status: ExtractionStatus = d.extraction.status;
  const canConfirm = m.data?.canConfirm === true;
  const open = x.action?.status === 'proposed';
  const text = x.action?.text ?? d.extraction.text ?? EXTRACTION_WORDS[status];
  const byHand = BY_HAND.includes(status) || (x.action !== null && x.action.outcome !== null && x.action.outcome !== 'dates');
  const runRead = async () => {
    setReadError(null);
    const r = await read.run(`/documents/${documentId}/extraction/run`, {});
    if (r.ok) qc.setQueryData(key, r.data);
    else {
      setReadError(messageFor({ code: r.code, details: r.details }, DOC_MESSAGES));
      void qc.invalidateQueries({ queryKey: key });
    }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 md:mx-0">
      <Card aria-labelledby={heading} className="flex flex-col gap-2">
        <h2 id={heading} className="text-[17px] font-semibold text-ink">
          {d.displayName}
        </h2>
        <p className="text-[14px] text-ink-muted">
          {KIND_WORDS[d.kind]} · Version {d.versionNo}
        </p>
        <p className="text-[15px] text-ink">{text}</p>
        {status === 'waiting_for_scan' && d.scanText ? <p className="text-[14px] text-ink-muted">{d.scanText}</p> : null}
        {x.relativeDeadlineText ? <Notice tone="info">{x.relativeDeadlineText}</Notice> : null}
        <PlatformLines platform={x.platform} dates />
        {status === 'not_started' && x.action === null ? (
          <Button className="self-start" pending={read.pending} pendingLabel="Reading" onClick={() => void runRead()}>
            Read dates now
          </Button>
        ) : null}
        {readError ? <Notice tone="error">{readError}</Notice> : null}
        {dealId ? (
          <Link to={`/deals/${dealId}`} className="inline-flex min-h-tap items-center self-start text-[15px] font-semibold text-accent underline underline-offset-4">
            {byHand ? 'Enter the dates by hand' : 'Open the deal timeline'}
          </Link>
        ) : null}
      </Card>

      {x.claims.length > 0 && dealId && m.isSuccess && !canConfirm ? <Notice tone="info">{CONFIRM_WHO}</Notice> : null}
      {x.claims.length > 0 && dealId && m.isError ? <Notice tone="info">{CONFIRM_WHO}</Notice> : null}

      {x.claims.length > 0 ? (
        <section aria-label="Dates found" className="flex flex-col gap-3">
          {groupClaims(x.claims).map((g) =>
            g.length > 1 ? (
              <div key={g[0]!.id} role="group" aria-label={`Different dates for ${g[0]!.milestone?.label ?? 'one date'}`} className="grid gap-3 md:grid-cols-2">
                {g.map((c) => (
                  <ClaimRow key={c.id} documentId={documentId} dealId={dealId} claim={c} canConfirm={canConfirm} open={open} />
                ))}
              </div>
            ) : (
              <ClaimRow key={g[0]!.id} documentId={documentId} dealId={dealId} claim={g[0]!} canConfirm={canConfirm} open={open} />
            ),
          )}
        </section>
      ) : null}
    </div>
  );
}
