// The document page (module 55 item 6): /documents/:documentId, every role (what a role reads is RLS's; an invisible
// document is 404). The versions, a same-origin `download` link only for a file that passed the virus check (no new
// tab, no preview: R-STAFF-5), a new-version upload, Share only when the API says canShare for a clean deal or listing
// document (the result is the API's sentence; R-STAFF-10), and legal hold and retention only when canHold. No delete
// or rename exists. Share, hold and retention are one request per tap through useAction (never retried).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, usePageTitle } from '../../shell/index.js';
import { type ActionResult, useAction } from '../admin/lib/hooks.js';
import { PlatformLines } from './DocumentsSection.js';
import { useMe } from './hooks.js';
import type { DetailResponse, DocumentView, ScopeKind, ShareResponse } from './types.js';
import { UploadControls } from './UploadControls.js';
import { DOC_MESSAGES, KIND_WORDS, SCAN_WORDS, dateWords, docKeys, downloadHref, mayAddVersion, uploaderWords } from './words.js';

const SCOPE_WORDS: Record<ScopeKind, { path: string; label: string }> = {
  deal: { path: 'deals', label: 'Open the deal' },
  listing: { path: 'listings', label: 'Open the listing' },
  contact: { path: 'contacts', label: 'Open the contact' },
};

function failureText(r: Extract<ActionResult<unknown>, { ok: false }>): string {
  const base = messageFor({ code: r.code, details: r.details }, DOC_MESSAGES);
  if (r.code === 'DOCUMENT_RETENTION_OUT_OF_RANGE' && typeof r.details?.from === 'string' && typeof r.details?.to === 'string') {
    return `${base} Choose a date from ${dateWords(r.details.from)} to ${dateWords(r.details.to)}.`;
  }
  return base;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h2>
      {children}
    </Card>
  );
}

/** R-STAFF-5: a same-origin attachment link, only for a clean file. */
export function DownloadLink({ d }: { d: DocumentView }) {
  const href = d.scan === 'clean' ? downloadHref(d.id) : null;
  if (!href) return null;
  return (
    <a href={href} download className="inline-flex min-h-tap items-center self-start text-[15px] font-semibold text-accent underline underline-offset-4">
      Download version {d.versionNo}
    </a>
  );
}

function Share({ d }: { d: DocumentView }) {
  const qc = useQueryClient();
  const share = useAction<{ shared: boolean }, ShareResponse>('POST');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    setText(null);
    const r = await share.run(`/documents/${d.id}/share`, { shared: !d.portal.shared });
    if (!r.ok) {
      setError(failureText(r));
      return;
    }
    const { text: said, ...detail } = r.data;
    qc.setQueryData(docKeys.detail(d.id), detail);
    void qc.invalidateQueries({ queryKey: ['documents', d.scope.kind, d.scope.id] });
    setText(said);
  };
  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" className="self-start" pending={share.pending} onClick={() => void run()}>
        {d.portal.shared ? 'Stop marking for the client portal' : 'Mark for the client portal'}
      </Button>
      {/* the API's answer, unless it is the sentence the section already shows (a Mark answers with the new portal.text) */}
      {text && text !== d.portal.text ? <Notice tone="info">{text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

function Hold({ d }: { d: DocumentView }) {
  const qc = useQueryClient();
  const hold = useAction<{ hold: boolean; reason: string }, DetailResponse>('POST');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const trimmed = reason.trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (trimmed.length < 1 || trimmed.length > 200) return;
    setError(null);
    const r = await hold.run(`/documents/${d.id}/hold`, { hold: !d.legalHold, reason: trimmed });
    if (!r.ok) {
      setError(failureText(r));
      return;
    }
    qc.setQueryData(docKeys.detail(d.id), r.data);
    setReason('');
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <p className="text-[15px] text-ink">{d.legalHold ? 'On legal hold.' : 'Not on legal hold.'}</p>
      <label htmlFor={id} className="flex flex-col gap-1 text-[15px] font-medium text-ink">
        Reason (up to 200 characters)
        <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
      </label>
      <Button type="submit" variant="secondary" className="self-start" pending={hold.pending} disabled={trimmed.length === 0}>
        {d.legalHold ? 'Lift legal hold' : 'Place legal hold'}
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </form>
  );
}

function Retention({ d }: { d: DocumentView }) {
  const qc = useQueryClient();
  const put = useAction<{ retentionUntil: string }, DetailResponse>('PUT');
  const [day, setDay] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const hint = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    setError(null);
    const r = await put.run(`/documents/${d.id}/retention`, { retentionUntil: new Date(`${day}T12:00:00Z`).toISOString() });
    if (!r.ok) {
      setError(failureText(r));
      return;
    }
    qc.setQueryData(docKeys.detail(d.id), r.data);
    setDay('');
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <p className="text-[15px] text-ink">{d.retentionUntil ? `Kept until ${dateWords(d.retentionUntil)}.` : 'No retention date yet. One is set when the deal closes.'}</p>
      <label htmlFor={id} className="flex flex-col gap-1 text-[15px] font-medium text-ink">
        Keep until
        <input id={id} type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-describedby={hint} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
      </label>
      <p id={hint} className="text-[14px] text-ink-muted">
        3 to 10 years after the close, or after the upload when there is no close.
      </p>
      <Button type="submit" variant="secondary" className="self-start" pending={put.pending} disabled={day === ''}>
        Save retention
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </form>
  );
}

export default function DocumentPage() {
  const { documentId = '' } = useParams();
  const api = useApi();
  const me = useMe();
  const navigate = useNavigate();
  const q = useQuery<DetailResponse, ApiError>({ queryKey: docKeys.detail(documentId), queryFn: ({ signal }) => api.get<DetailResponse>(`/documents/${documentId}`, { signal }), retry: false });
  usePageTitle(q.data?.document.displayName ?? null);
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, DOC_MESSAGES)}</Notice>;
  const { document: d, versions, platform } = q.data;
  const newest = [...versions].sort((a, b) => b.versionNo - a.versionNo)[0] ?? d;
  const scope = SCOPE_WORDS[d.scope.kind];
  const review = d.extraction.status === 'proposed' && d.extraction.claimCount > 0;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 md:mx-0">
      <Section title="Document">
        <p className="text-[14px] text-ink-muted">{[KIND_WORDS[d.kind], `Version ${d.versionNo}`, uploaderWords(d.uploadedByUserId, me.userId), dateWords(d.uploadedAt)].filter(Boolean).join(' · ')}</p>
        <p className="text-[15px] text-ink">
          {SCAN_WORDS[d.scan]}
          {d.scanText ? <span className="block text-[14px] text-ink-muted">{d.scanText}</span> : null}
        </p>
        <PlatformLines platform={platform} dates={d.scope.kind === 'deal'} />
        <DownloadLink d={d} />
        {d.extraction.text && d.extraction.status !== 'not_applicable' ? <p className="text-[14px] text-ink-muted">{d.extraction.text}</p> : null}
        {review ? (
          <Link to={`/documents/${d.id}/dates`} className="inline-flex min-h-tap items-center self-start text-[15px] font-semibold text-accent underline underline-offset-4">
            Review {d.extraction.claimCount} {d.extraction.claimCount === 1 ? 'date' : 'dates'}
          </Link>
        ) : null}
        <Link to={`/${scope.path}/${d.scope.id}`} className="inline-flex min-h-tap items-center self-start text-[15px] text-accent underline underline-offset-4">
          {scope.label}
        </Link>
      </Section>

      <Section title="Versions">
        <ul aria-label="Versions" className="flex flex-col">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-col gap-1 border-t border-line py-2 first:border-t-0" aria-current={v.id === d.id ? 'true' : undefined}>
              {v.id === d.id ? (
                <span className="text-[15px] font-medium text-ink">Version {v.versionNo} (this one)</span>
              ) : (
                <Link to={`/documents/${v.id}`} className="inline-flex min-h-tap items-center self-start text-[15px] text-accent underline underline-offset-4">
                  Version {v.versionNo}
                </Link>
              )}
              <span className="text-[14px] text-ink-muted">{[uploaderWords(v.uploadedByUserId, me.userId), dateWords(v.uploadedAt), SCAN_WORDS[v.scan]].filter(Boolean).join(' · ')}</span>
              {v.id !== d.id ? <DownloadLink d={v} /> : null}
            </li>
          ))}
        </ul>
        {mayAddVersion(d.scope.kind, me.role) ? <UploadControls path={`/documents/${newest.id}/versions`} mode="version" invalidate={[docKeys.detail(d.id), ['documents', d.scope.kind, d.scope.id]]} onUploaded={(r) => navigate(`/documents/${r.document.id}`)} /> : null}
      </Section>

      {d.scope.kind !== 'contact' ? (
        <Section title="Client portal">
          {/* b15 (b14 low e): the API's sentence starts "Marked for the client portal.", so the page's own line shows only
              when the API gives none (never three times with the Share notice) */}
          {d.portal.text ? <p className="text-[15px] text-ink">{d.portal.text}</p> : <p className="text-[15px] text-ink">{d.portal.shared ? 'Marked for the client portal.' : 'Not marked for the client portal.'}</p>}
          {d.canShare && d.scan === 'clean' ? <Share d={d} /> : null}
        </Section>
      ) : null}

      {d.canHold ? (
        <Section title="Legal hold and retention">
          <Hold d={d} />
          <Retention d={d} />
        </Section>
      ) : null}
    </div>
  );
}
