// The documents section (module 55 item 6), mounted on the deal and listing pages and in the contact sections. It
// lists each chain's newest version as the API returns it (GET /{deals|listings|contacts}/:id/documents) with the
// server's own sentences: the virus check, the portal and the contract dates; and the platform's scanner and PDF
// reader status (R-STAFF-1: never a state of our own). Names render as React text only (R-STAFF-5). An invisible
// scope (404) hides the section.
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { useMe } from './hooks.js';
import type { ListEntry, ListResponse, PlatformView, ScopeKind } from './types.js';
import { UploadControls } from './UploadControls.js';
import { DOC_MESSAGES, KIND_WORDS, SCAN_WORDS, dateWords, docKeys, mayUpload, uploaderWords } from './words.js';

/** The platform lines that are true now: no scanner (E673), a test scanner, no or a test PDF reader. */
export function PlatformLines({ platform, dates }: { platform: PlatformView; dates: boolean }) {
  const lines = [!platform.scanner.configured || platform.scanner.test ? platform.scanner.statusText : null, dates && (!platform.extractor.configured || platform.extractor.test) ? platform.extractor.statusText : null].filter(
    (x): x is string => x !== null,
  );
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-[14px] text-ink-muted" aria-label="Platform status">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

export function DocumentRow({ d, me }: { d: ListEntry; me: string | null }) {
  const review = d.extraction.status === 'proposed' && d.extraction.claimCount > 0;
  return (
    <li className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0">
      {/* b14 review F6: a file name is often one long word (Residential_Purchase_Agreement.pdf); it wraps anywhere, as the
          shell's h1 does, so the row never scrolls sideways at 390 px */}
      <Link to={`/documents/${d.id}`} className="inline-flex min-h-tap min-w-0 max-w-full items-center text-[16px] font-medium text-accent underline decoration-line underline-offset-4 [overflow-wrap:anywhere]">
        {d.displayName}
      </Link>
      <p className="text-[14px] text-ink-muted">{[KIND_WORDS[d.kind], `Version ${d.versionNo}`, uploaderWords(d.uploadedByUserId, me), dateWords(d.uploadedAt)].filter(Boolean).join(' · ')}</p>
      <p className="text-[15px] text-ink">
        {SCAN_WORDS[d.scan]}
        {d.scanText ? <span className="block text-[14px] text-ink-muted">{d.scanText}</span> : null}
      </p>
      {d.portal.text ? <p className="text-[14px] text-ink-muted">{d.portal.text}</p> : null}
      {d.extraction.text && d.extraction.status !== 'not_applicable' ? <p className="text-[14px] text-ink-muted">{d.extraction.text}</p> : null}
      {review ? (
        <Link to={`/documents/${d.id}/dates`} className="inline-flex min-h-tap items-center self-start text-[15px] font-semibold text-accent underline underline-offset-4">
          Review {d.extraction.claimCount} {d.extraction.claimCount === 1 ? 'date' : 'dates'}
        </Link>
      ) : null}
      {d.newerVersion ? (
        <p className="text-[14px] text-ink-muted">
          <Link to={`/documents/${d.newerVersion.id}`} className="text-accent underline underline-offset-4">
            Version {d.newerVersion.versionNo}
          </Link>{' '}
          is newer. {SCAN_WORDS[d.newerVersion.scan]}.
        </p>
      ) : null}
    </li>
  );
}

export function DocumentsSection({ kind, id, ownerUserId = null, memberUserIds = [] }: { kind: ScopeKind; id: string; ownerUserId?: string | null; memberUserIds?: readonly string[] }) {
  const api = useApi();
  const me = useMe();
  const heading = useId();
  const key = docKeys.list(kind, id);
  const q = useQuery<ListResponse, ApiError>({ queryKey: key, queryFn: ({ signal }) => api.get<ListResponse>(`/${kind}s/${id}/documents`, { signal }), retry: false });
  if (q.isError && q.error.code === 'NOT_FOUND') return null;
  const canUpload = mayUpload(kind, me.role, { own: me.userId !== null && ownerUserId === me.userId, member: me.userId !== null && memberUserIds.includes(me.userId) });
  return (
    <Card aria-labelledby={heading} className="flex flex-col gap-2">
      <h2 id={heading} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        Documents
      </h2>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, DOC_MESSAGES)}</Notice> : null}
      {q.data ? (
        <>
          <PlatformLines platform={q.data.platform} dates={kind === 'deal'} />
          {q.data.documents.length === 0 ? (
            <p className="text-[15px] text-ink-muted">No documents yet.</p>
          ) : (
            <ul aria-label="Documents">
              {q.data.documents.map((d) => (
                <DocumentRow key={d.id} d={d} me={me.userId} />
              ))}
            </ul>
          )}
        </>
      ) : null}
      {canUpload ? <UploadControls path={`/${kind}s/${id}/documents`} mode={kind === 'deal' ? 'deal' : 'kinds'} invalidate={[key]} /> : null}
    </Card>
  );
}

/** The contact page's entry (contact/sections.ts). */
export function ContactDocumentsSection({ contact }: { contact: ContactFullView }) {
  return <DocumentsSection kind="contact" id={contact.id} ownerUserId={contact.ownership.ownerUserId} />;
}
