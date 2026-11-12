// Lead sources (Owner/Admin): one card per source, from GET /lead-sources/overview only.
//
// Each card: the name and its kind in words; one status sentence ("Last lead 2 hours ago · 14 in the last 30 days",
// "No leads yet", or "Off since <time>: leads sent to it are not received"); what waits in Needs review (held emails
// and forwarding confirmations), linking there; one chip per path with its state in words (On / Off / Not set up /
// Not available on this deployment / Needs partner access: a partner feed is never said to be connected); and ONE
// primary action: Copy the lead-email address when lead email is on (one tap), otherwise Set up (opens the source).
// "Add a source" opens a sheet (AddSource.tsx). One column on a phone, two on desktop.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ButtonLink, Card, EmptyState, Notice } from '../../design/index.js';
import { useAnnounce } from '../admin/lib/hooks.js';
import { Pill } from '../admin/lib/ui.js';
import { AddSource } from './AddSource.js';
import { useOverview } from './hooks.js';
import { sentenceFor } from './messages.js';
import type { SourceOverview } from './types.js';
import { copyText } from './ui.js';
import { PAGES, chipTone, detailPath, kindWords, pathChips, skippedSentence, statusSentence, waitingSentence } from './words.js';

export default function LeadSourcesPage() {
  const q = useOverview();
  const [adding, setAdding] = useState(false);
  const sources = q.data?.sources ?? [];
  const now = Date.now();
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <p className="min-w-0 flex-1 basis-64 text-[15px] text-ink-muted">Where new leads come from, and how each one reaches the team.</p>
        <Button onClick={() => setAdding(true)}>Add a source</Button>
      </div>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{sentenceFor(q.error)}</Notice> : null}
      {q.data && sources.length === 0 ? (
        <EmptyState icon="inbox" title="No lead sources yet">
          Add a source for each place leads come from: a portal, your website, an ad, a sign.
        </EmptyState>
      ) : null}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {sources.map((s) => (
          <li key={s.id} className="min-w-0">
            <SourceCard source={s} now={now} />
          </li>
        ))}
      </ul>
      {adding ? <AddSource deployment={q.data?.deployment ?? null} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

export function SourceCard({ source: s, now }: { source: SourceOverview; now: number }) {
  const hid = useId();
  const [status, announce] = useAnnounce(5000);
  const [showAddress, setShowAddress] = useState(false);
  const waiting = waitingSentence(s);
  const address = s.active && s.paths.email.state === 'on' ? s.paths.email.address : null;
  const copy = async () => {
    if (!address) return;
    if (await copyText(address)) announce('Copied');
    else {
      setShowAddress(true);
      announce("Couldn't copy here. The address is shown: copy it from there.");
    }
  };
  return (
    <Card as="article" aria-labelledby={hid} className="flex h-full flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={hid} className="break-words text-[18px] font-semibold text-ink">
          <Link to={detailPath(s.id)} className="inline-flex min-h-tap items-center underline-offset-2 hover:underline">
            {s.name}
          </Link>
        </h2>
        <p className="text-[14px] text-ink-muted">{kindWords(s.kind)}</p>
      </div>
      <p className={`text-[15px] ${s.active ? 'text-ink' : 'font-medium text-ink'}`}>{statusSentence(s, now)}</p>
      {skippedSentence(s) ? <p className="text-[15px] text-ink">{skippedSentence(s)}</p> : null}
      {waiting ? (
        <p className="text-[15px]">
          <Link to={PAGES.needsReview} className="inline-flex min-h-tap items-center text-accent underline">
            {waiting}
          </Link>
        </p>
      ) : null}
      <ul aria-label={`Paths of ${s.name}`} className="flex flex-wrap gap-1.5">
        {pathChips(s).map((c) => (
          <li key={c.path}>
            <Pill tone={chipTone(c.state)}>
              {c.label}: {c.state}
            </Pill>
          </li>
        ))}
      </ul>
      {showAddress && address ? <p className="break-all font-mono text-[14px] text-ink">{address}</p> : null}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {address ? (
          <Button onClick={() => void copy()} aria-label={`Copy the lead-email address of ${s.name}`}>
            Copy the lead-email address
          </Button>
        ) : (
          <ButtonLink to={detailPath(s.id)} aria-label={`Set up ${s.name}`}>
            Set up
          </ButtonLink>
        )}
        {address ? (
          <ButtonLink to={detailPath(s.id)} variant="quiet" aria-label={`Open ${s.name}`}>
            Open
          </ButtonLink>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] text-ok">
        {status ?? ''}
      </p>
    </Card>
  );
}
