// One marketing piece version (module 38): what it says, the server's honest status words, why it can't
// be approved yet (in words: "Check this", never a score), and what can be done with it.
//
// - Approve is ONE tap and sends the contentSha256 of exactly the version shown. It is offered only when
//   the server says guard.approvable; otherwise the reasons are shown and there is no Approve button.
// - Copy / Download export the approved version first, so its label becomes "Exported: post it yourself".
// - Publish to <account> appears only for the server's `publish` options; `export` options show the
//   server's sentence. "Posted" appears only where the server's posted flag is true (lib.ts).
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button, Card, CheckThis, Notice, announce } from '../../design/index.js';
import { EXPORTED_POST_IT_YOURSELF, errorText, kindLabel, publicationWords, statusWords, useApprovePiece, useExportPiece, usePieceCommand } from './lib.js';
import { OpenHouseTime } from './OpenHouseTime.js';
import type { ExportView, PieceView, PublicationView } from './types.js';

const PROMINENCE: Record<string, string> = {
  display: 'text-[19px] font-semibold text-ink',
  heading: 'text-[16px] font-semibold text-ink',
  body: 'text-[15px] text-ink',
  small: 'text-[13px] text-ink-muted',
  footnote: 'text-[13px] text-ink-muted',
};

export function PiecePreview({ piece, label }: { piece: PieceView; label: string }) {
  if (!piece.preview) return <p className="text-[15px] text-ink-muted">There is no preview for this version: see what to fix below.</p>;
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3.5 py-3">
      {piece.preview.blocks.map((b, i) => (
        <p key={`${b.role}:${i}`} className={`whitespace-pre-wrap break-words ${PROMINENCE[b.prominence] ?? PROMINENCE.body}`}>
          {b.text}
        </p>
      ))}
    </div>
  );
}

/** Why a draft can't be approved, and soft fair-housing matches, in words. */
export function GuardNotes({ piece }: { piece: PieceView }) {
  if (piece.status !== 'draft') return null;
  const { guard } = piece;
  return (
    <>
      {!guard.approvable ? (
        <Notice tone="warn" title="Fix this before it can be approved">
          <ul className="list-disc pl-5">
            {(guard.reasons.length > 0 ? guard.reasons : ['This version does not pass the checks yet.']).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {guard.checkThis || guard.soft.length > 0 ? (
        <div className="flex flex-col gap-1 text-[15px] text-ink">
          <p>
            <CheckThis /> <span>Some words may read as a fair-housing concern. Read them again before you approve.</span>
          </p>
          {guard.soft.length > 0 ? (
            <ul className="list-disc pl-5 text-ink-muted" aria-label="Words to check">
              {guard.soft.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function PublicationList({ publications }: { publications: PublicationView[] }) {
  if (publications.length === 0) return null;
  return (
    <ul aria-label="Where it went" className="flex flex-col gap-1 text-[15px] text-ink">
      {publications.map((p) => (
        <li key={p.id} data-posted={p.posted ? 'true' : 'false'} className="rounded-lg border border-line px-3 py-2">
          {publicationWords(p)}
          <span className="text-ink-muted"> · {p.targetName}</span>
        </li>
      ))}
    </ul>
  );
}

function download(href: string, name?: string) {
  const a = document.createElement('a');
  a.href = href;
  if (name) a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const FILE_NAME: Record<string, string> = {
  website_page: 'listing-page.txt',
  social_post: 'social-post.txt',
  open_house_invite: 'open-house-invite.txt',
  marketplace_export: 'marketplace-listing.txt',
  flyer: 'flyer.txt',
};

export function PieceCard({ piece, publishingCleared, headingLevel = 2, extra }: { piece: PieceView; publishingCleared: boolean; headingLevel?: 2 | 3; extra?: ReactNode }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const titleId = useId();
  const approve = useApprovePiece();
  const exporter = useExportPiece();
  const command = usePieceCommand<
    Record<string, unknown>,
    {
      piece: PieceView;
      publication?: PublicationView | null;
      retracted?: number;
      removeYourself?: number;
    }
  >();
  const [exported, setExported] = useState<ExportView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // a new version or status from the server replaces what this card said about the old one
  useEffect(() => {
    setFailure(null);
  }, [piece.id, piece.status]);

  // what the card says is also spoken through the page's one persistent live region (a status element that is
  // inserted already filled is often not read aloud)
  const [said, setSaidState] = useState<string | null>(null);
  const setSaid = (t: string | null) => {
    setSaidState(t);
    if (t) announce(t);
  };
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fail = (r: Parameters<typeof errorText>[0]) => setFailure(errorText(r));

  const doApprove = async () => {
    setSaid(null);
    const r = await approve.approve(piece);
    if (r.ok) {
      setSaid('Approved.');
      // the Approve button is gone now: keep the keyboard on this card, not the top of the page
      requestAnimationFrame(() => headingRef.current?.focus());
    }
    else fail(r);
  };

  const doExport = async (): Promise<ExportView | null> => {
    const r = await exporter.run(`/marketing-pieces/${piece.id}/export`);
    if (!r.ok) {
      fail(r);
      return null;
    }
    setExported(r.data.export);
    return r.data.export;
  };

  const doCopy = async () => {
    setSaid(null);
    const ex = await doExport();
    if (!ex) return;
    try {
      await navigator.clipboard.writeText(ex.text);
      setSaid(`Copied. ${ex.label}`);
    } catch {
      setSaid(`${ex.label}. Copy the words below.`);
    }
  };

  const doDownload = async () => {
    setSaid(null);
    const ex = await doExport();
    if (!ex) return;
    if (ex.flyerUrl) download(ex.flyerUrl);
    else download(URL.createObjectURL(new Blob([ex.text], { type: 'text/plain;charset=utf-8' })), FILE_NAME[piece.kind]);
    setSaid(ex.label);
  };

  const doPublish = async (connectionId?: string) => {
    setSaid(null);
    const r = await command.run(`/marketing-pieces/${piece.id}/publish`, connectionId ? { connectionId } : {});
    if (!r.ok) return fail(r);
    // the publication's own words, as the server recorded the provider's answer
    if (r.data.publication) setSaid(publicationWords(r.data.publication));
    else setSaid(statusWords(r.data.piece));
  };

  const doRetract = async (publicationId?: string) => {
    setSaid(null);
    const r = await command.run(`/marketing-pieces/${piece.id}/retract`, publicationId ? { publicationId } : {});
    if (!r.ok) return fail(r);
    if (piece.kind === 'website_page') setSaid('The page is down.');
    else if ((r.data.removeYourself ?? 0) > 0) setSaid("We couldn't take it down from there: remove it on that account yourself.");
    else setSaid('Taken down.');
  };

  const draft = piece.status === 'draft';
  const live = piece.status === 'approved' || piece.status === 'published' || piece.status === 'exported';
  const social = piece.kind === 'social_post';
  const publishable = social && live ? piece.publishOptions.filter((o) => o.kind === 'publish') : [];
  // "Approve this version first" is the Approve button's job; the other export reasons are said in the server's words
  const exportOnly = social && live ? piece.publishOptions.filter((o): o is Extract<typeof o, { kind: 'export' }> => o.kind === 'export' && o.reason !== 'NOT_APPROVED' && !(o.reason === 'ALREADY_LIVE' && piece.publications.some((p) => p.posted && p.connectionId === o.connectionId))) : [];
  const livePosts = piece.publications.filter((p) => p.status === 'published');
  const busy = approve.pending || exporter.pending || command.pending;

  return (
    <Card as="article" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Version {piece.versionNo}</p>
        <H id={titleId} ref={headingRef} tabIndex={-1} className="text-[19px] font-semibold text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {kindLabel(piece.kind)}
        </H>
        <p className="text-[15px] text-ink" data-testid="status-label">
          {statusWords(piece)}
        </p>
      </div>
      {extra}
      <PiecePreview piece={piece} label={`${kindLabel(piece.kind)}, version ${piece.versionNo}`} />
      <GuardNotes piece={piece} />
      {piece.kind === 'open_house_invite' && piece.status === 'draft' ? <OpenHouseTime piece={piece} /> : null}
      {piece.earlierPostNotice ? <Notice tone="info">{piece.earlierPostNotice}</Notice> : null}
      <PublicationList publications={piece.publications} />
      {piece.kind === 'website_page' && piece.status === 'published' && piece.publicPath ? (
        <p className="text-[15px] text-ink">
          The page is live at{' '}
          <a href={piece.publicPath} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-accent underline">
            {piece.publicPath}
          </a>
        </p>
      ) : null}
      {exportOnly.length > 0 ? (
        <ul aria-label="Not published here" className="flex flex-col gap-1 text-[15px] text-ink-muted">
          {exportOnly.map((o, i) => (
            <li key={`${o.connectionId ?? 'none'}:${i}`}>{o.sentence}</li>
          ))}
        </ul>
      ) : null}
      {live && !social && piece.kind !== 'website_page' && piece.exportable ? (
        <p className="text-[15px] text-ink-muted">We don't post this for you: copy or download it, then post it yourself.</p>
      ) : null}
      {/* seen here, heard through announce(): aria-hidden so a screen reader does not meet it twice */}
      {said ? (
        <div aria-hidden="true">
          <Notice tone="ok">{said}</Notice>
        </div>
      ) : null}
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      {exported && (exported.images.length > 0 || exported.flags.length > 0) ? (
        <div className="flex flex-col gap-1 text-[15px] text-ink">
          {exported.images.length > 0 ? (
            <ul aria-label="Photos" className="flex flex-wrap gap-2">
              {exported.images.map((im) => (
                <li key={im.position}>
                  <a href={im.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-tap min-w-tap items-center font-medium text-accent underline">
                    Photo {im.position}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {exported && exported.label.startsWith(EXPORTED_POST_IT_YOURSELF) ? (
        <details className="text-[15px] text-ink">
          <summary className="flex min-h-tap cursor-pointer items-center font-medium text-accent">Show the words</summary>
          <p className="whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-3.5 py-2.5">{exported.text}</p>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {draft && piece.guard.approvable ? (
          <Button icon="check" pending={approve.pending} pendingLabel="Approving" onClick={() => void doApprove()}>
            Approve
          </Button>
        ) : null}
        {publishable.map((o) =>
          o.kind === 'publish' ? (
            <Button key={o.connectionId} pending={command.pending} disabled={busy && !command.pending} onClick={() => void doPublish(o.connectionId)}>
              Publish to {o.displayName}
            </Button>
          ) : null,
        )}
        {piece.kind === 'website_page' && (piece.status === 'approved' || piece.status === 'exported') && publishingCleared ? (
          <Button pending={command.pending} disabled={busy && !command.pending} onClick={() => void doPublish()}>
            Put the page live
          </Button>
        ) : null}
        {piece.exportable ? (
          <>
            <Button variant="secondary" pending={exporter.pending} disabled={busy && !exporter.pending} onClick={() => void doCopy()}>
              Copy
            </Button>
            <Button variant="secondary" pending={exporter.pending} disabled={busy && !exporter.pending} onClick={() => void doDownload()}>
              {piece.kind === 'flyer' ? 'Download flyer' : 'Download'}
            </Button>
          </>
        ) : null}
        {piece.kind === 'website_page' && piece.status === 'published' ? (
          <Button variant="quiet" pending={command.pending} disabled={busy && !command.pending} onClick={() => void doRetract()}>
            Take the page down
          </Button>
        ) : null}
        {social
          ? livePosts.map((p) => (
              <Button key={p.id} variant="quiet" pending={command.pending} disabled={busy && !command.pending} onClick={() => void doRetract(p.id)}>
                Take down from {p.targetName}
              </Button>
            ))
          : null}
      </div>
    </Card>
  );
}
