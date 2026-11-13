// Contract extraction pointers in the approvals inbox (PHASE2_3_PLAN module 55 item 11; R-STAFF-2, R-STAFF-5; E674).
// A contract's dates are decided only claim by claim on the document's date review, so here each open extraction (GET
// /documents/extractions: the viewer's own) is a pointer whose only action is "Review dates". A contract_extraction
// that still arrives as an assistant card is shown the same way, never with Approve or Reject, and nothing here calls
// an /assistant route. EXTRACTION_USE_DOCUMENT anywhere on the page is said in words with a link to its document.
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Card, Notice } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { formatDate } from '../admin/lib/format.js';
import type { ActionView } from '../feed/lib/types.js';

export const EXTRACTIONS_KEY = ['documents', 'extractions'] as const;

export interface OpenExtraction {
  documentId: string;
  dealId: string;
  displayName: string;
  versionNo: number;
  outcome: 'dates' | 'no_text' | 'no_dates' | 'unreadable' | null;
  unreviewedClaims: number;
  createdAt: string;
}

/** The extraction outcome in the documents API's own words (apps/api/src/documents/copy.ts). */
const OUTCOME_WORDS: Record<NonNullable<OpenExtraction['outcome']>, string> = {
  dates: 'Dates found in this contract. Confirm each one; nothing is added to the timeline until you do.',
  no_text: 'No text found in this PDF; enter the dates by hand.',
  no_dates: 'No dates found next to the labels we read. Enter the dates by hand.',
  unreadable: 'This PDF could not be read. Enter the dates by hand.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The in-app path of a document's date review, or null when the id is not one (data never builds another path). */
export const datesPath = (documentId: unknown): string | null => (typeof documentId === 'string' && UUID.test(documentId) ? `/documents/${documentId}/dates` : null);

export function useOpenExtractions() {
  const api = useApi();
  return useQuery<{ extractions: OpenExtraction[] }, ApiError>({
    queryKey: EXTRACTIONS_KEY,
    queryFn: ({ signal }) => api.get<{ extractions: OpenExtraction[] }>('/documents/extractions', { signal }),
    refetchInterval: 60_000,
  });
}

function Pointer({ title, sentence, meta, documentId }: { title: string; sentence: string; meta: string | null; documentId: unknown }) {
  const titleId = useId();
  const href = datesPath(documentId);
  return (
    <Card as="article" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Contract dates{meta ? ` · ${meta}` : ''}</p>
      <h3 id={titleId} className="break-words text-[19px] font-semibold text-ink">
        {title}
      </h3>
      <p className="text-[15px] text-ink">{sentence}</p>
      {href ? (
        <div>
          <Link to={href} className="inline-flex min-h-tap items-center text-[17px] font-semibold text-accent">
            Review dates
          </Link>
        </div>
      ) : (
        <p className="text-[15px] text-ink-muted">Open the contract from its deal to review the dates.</p>
      )}
    </Card>
  );
}

export function ExtractionPointer({ x }: { x: OpenExtraction }) {
  return <Pointer title={x.displayName} sentence={x.outcome ? OUTCOME_WORDS[x.outcome] : 'The dates are still being read.'} meta={`Version ${x.versionNo} · ${formatDate(x.createdAt)}`} documentId={x.documentId} />;
}

/** A contract_extraction delivered as an assistant card: a pointer to its document, never Approve or Reject (E674). */
export function ExtractionActionPointer({ action }: { action: ActionView }) {
  const documentId = action.claims.flatMap((c) => c.evidence).find((e) => e.sourceType === 'document')?.sourceId ?? null;
  return <Pointer title="Contract dates to review" sentence={action.explanation} meta={null} documentId={documentId} />;
}

export function ExtractionPointers({ list }: { list: readonly OpenExtraction[] }) {
  const headingId = useId();
  if (list.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        Contract dates to review
      </h2>
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {list.map((x) => (
          <li key={x.documentId} className="min-w-0">
            <ExtractionPointer x={x} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * EXTRACTION_USE_DOCUMENT (a stale client's generic reject or claim review of a contract extraction): the sentence and
 * a link to details.documentId's date review. Any other refusal shows its message.
 */
export function RefusalNotice({ error }: { error: { code: string; message: string; details: Record<string, unknown> | null } }) {
  if (error.code !== 'EXTRACTION_USE_DOCUMENT') return <Notice tone="error">{error.message}</Notice>;
  const href = datesPath(error.details?.documentId);
  return (
    <Notice tone="warn" action={href ? <Link to={href} className="inline-flex min-h-tap items-center font-semibold text-accent underline">Review dates</Link> : undefined}>
      A contract’s dates are confirmed or rejected one at a time on the document, not here.
    </Notice>
  );
}
