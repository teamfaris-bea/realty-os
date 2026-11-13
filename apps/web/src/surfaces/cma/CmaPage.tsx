// The agent's CMA screen, /cma/:cmaId (module 72, web/cma; D9 V2-A; R-CMA-2…9, R-AVM-1; E369, E370, E373, E376, E377).
//
// Phones: one column, and for a draft the creator may share, a sticky bottom bar with the one Email button, the
// recipient, the address and the send-time check's answer beside it (R-CMA-9, D1; audit cma-v2a F7). From
// 1024 px: two columns, the range and the comparable sales on the left, the home, the purpose and the share on the
// right. What it shows, honestly:
//   - the estimated range (low to high) and its middle, "an estimate, not an appraisal", the source "MLS sales"; or,
//     with no value, the server's sentence why;
//   - every comparable sale (sold price and date, distance or "distance not known", why, labels), expanding to its
//     adjustments with their sentences, the adjusted price and its weight; Remove on a draft;
//   - the sales not used, each with why, and Use when the agent may include it;
//   - the home's facts with their sources and the editor; the near-match confirmation; the purpose, the inspection and,
//     for another purpose, the five disclosure items;
//   - the back-test sentence (this screen only; the client's report does not carry it), the listings shown for
//     context only, the "MLS data as of" and area sentences;
//   - read-only states (prepared by someone else, shared, superseded), a stale-feed banner, the shared email's status
//     in the server's words and the PDF to print or hand over. A research CMA or one of a listing is never shared.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type RefCallback, useEffect, useId, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Card, Notice, useStickyBottom } from '../../design/index.js';
import { type ApiError, useApi, usePageTitle } from '../../shell/index.js';
import { CompCard } from './CompCard.js';
import { NotUsed } from './NotUsed.js';
import { Purpose } from './Purpose.js';
import { SharePanel, ShareButton, ShareOutcome, ShareRecipient, useShare } from './SharePanel.js';
import { SubjectFacts } from './SubjectFacts.js';
import { type CmaView, type PatchBody, cmaKey, cmaMessage, day, fetchCma, money, neverShared, pdfHref, streetLine, useCall, useWide } from './lib.js';
import { LISTING_STATUS_WORDS, W } from './words.js';

export default function CmaPage() {
  const { cmaId = '' } = useParams();
  const api = useApi();
  const q = useQuery<{ cma: CmaView }, ApiError>({ queryKey: cmaKey(cmaId), queryFn: ({ signal }) => fetchCma(api, cmaId, signal) });
  const street = q.data ? streetLine(q.data.cma.subject.address) : '';
  usePageTitle(street ? W.titleFor(street) : null);
  // held by the page; the bar itself mounts one commit later (CmaScreen), after StrictMode's effect re-run, so its
  // height reaches the scroll padding (design/Sticky.tsx) even when the CMA was already in the cache
  const bar = useStickyBottom<HTMLDivElement>();
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">{W.loading}</p>;
  if (q.isError) return <LoadError error={q.error} retry={() => void q.refetch()} />;
  return <CmaScreen view={q.data.cma} bar={bar} />;
}

function LoadError({ error, retry }: { error: ApiError; retry: () => void }) {
  // the agent gate's refusals (R-CMA-6, E371) are a state of the team's MLS set-up, not a failure to retry
  if (error.code === 'CMA_NO_MLS_CONNECTION' || error.code === 'CMA_VALUATION_NOT_ALLOWED') return <Notice tone="warn">{cmaMessage(error)}</Notice>;
  return (
    <Notice tone="error" title={W.cantLoad} action={<Button variant="secondary" onClick={retry}>{W.tryAgain}</Button>}>
      {cmaMessage(error)}
    </Notice>
  );
}

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
      {children}
    </h2>
  );
}

type Origin = 'facts' | 'purpose' | 'sales';

function CmaScreen({ view, bar }: { view: CmaView; bar: RefCallback<HTMLDivElement> }) {
  const qc = useQueryClient();
  const wide = useWide();
  const s = useShare(view);
  const patch = useCall<PatchBody, { cma: CmaView }>('PATCH');
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const sentenceId = useId();
  const ids = { comps: useId(), context: useId(), data: useId(), backtest: useId(), near: useId(), range: useId() };

  const save = async (from: Origin, b: PatchBody, id: string | null = null): Promise<boolean> => {
    setOrigin(from);
    setBusyId(id);
    const r = await patch.run(`/cma/${view.id}`, b);
    setBusyId(null);
    if (r.ok) {
      qc.setQueryData(cmaKey(view.id), { cma: r.data.cma });
      return true;
    }
    // shared or replaced meanwhile (E377): show it as it is now
    if (r.error.code === 'CMA_NOT_DRAFT' || r.error.code === 'NOT_FOUND') void qc.invalidateQueries({ queryKey: cmaKey(view.id), exact: true });
    return false;
  };
  const errorFor = (from: Origin) => (origin === from && patch.error ? patch.error.message : null);
  const sub = view.subject;
  const without = (xs: string[], id: string) => xs.filter((x) => x !== id);
  const remove = (id: string) => void save('sales', { exclude: [...without(sub.exclude, id), id], include: without(sub.include, id) }, id);
  const use = (id: string) => void save('sales', { include: [...without(sub.include, id), id], exclude: without(sub.exclude, id) }, id);
  const different = (id: string) => void save('sales', { nearMatchDismissed: [...without(sub.nearMatchDismissed, id), id] }, id);

  const feedStale = view.clientShare.blockers.find((b) => b.code === 'FEED_STALE') ?? null;
  const r = view.result;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const shareBar = mounted && s.applies && !wide;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 md:mx-0 lg:max-w-none">
      {/* status: read-only, the share, the stale feed */}
      {view.status === 'superseded' ? <Notice tone="info">{W.superseded}</Notice> : null}
      {view.status === 'draft' && !view.mine ? <Notice tone="info">{W.preparedBySomeoneElse}</Notice> : null}
      {view.status === 'draft' && view.mine && !view.canEdit ? <Notice tone="info">{W.cantChange}</Notice> : null}
      {!s.applies && s.notice ? <Notice tone={s.notice.tone}>{s.notice.text}</Notice> : null}
      {view.status === 'shared' ? <SharedCard view={view} /> : null}
      {feedStale ? (
        <Notice tone="warn" title={W.feedStaleHeading}>
          {feedStale.sentence} {view.mlsDataAsOfSentence}
        </Notice>
      ) : null}
      {patch.error && origin === 'sales' ? <Notice tone="error">{patch.error.message}</Notice> : null}

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col gap-1" aria-labelledby={ids.range}>
            {r.available && r.lowCents !== null && r.highCents !== null ? (
              <>
                <h2 id={ids.range} className="text-[15px] font-medium text-ink-muted">
                  {W.rangeHeading}
                </h2>
                <p className="text-[26px] font-bold leading-tight text-ink tabular-nums md:text-[30px]">{W.rangeLine(money(r.lowCents), money(r.highCents))}</p>
                {r.valueCents !== null ? <p className="text-[15px] text-ink tabular-nums">{W.valueLine(money(r.valueCents))}</p> : null}
                <p className="text-[15px] text-ink">{W.estimate}</p>
              </>
            ) : (
              <>
                <h2 id={ids.range} className="text-[17px] font-semibold text-ink">
                  {W.noValueHeading}
                </h2>
                <p className="text-[15px] text-ink">{r.sentence}</p>
              </>
            )}
            <p className="text-[14px] text-ink-muted">
              {W.source} · {W.valuedOn(day(view.valuationDate))}
            </p>
            {r.sentences.filter((x) => x !== r.sentence && !view.area.sentences.includes(x)).map((x) => (
              <p key={x} className="text-[14px] text-ink-muted">
                {x}
              </p>
            ))}
          </Card>

          <section aria-labelledby={ids.comps} className="flex flex-col gap-2">
            <Heading id={ids.comps}>{W.compsHeading}</Heading>
            {view.comps.length === 0 ? <p className="text-[15px] text-ink-muted">{W.noComps}</p> : <p className="text-[14px] text-ink-muted">{W.compsCount(view.comps.length, view.comps.length + Math.max(view.notUsedTotal, view.notUsed.length))}</p>}
            <ul className="flex flex-col gap-3">
              {view.comps.map((c) => (
                <li key={c.listingId}>
                  <CompCard comp={c} canEdit={view.canEdit} busy={busyId === c.listingId} onRemove={() => remove(c.listingId)} />
                </li>
              ))}
            </ul>
          </section>

          <NotUsed items={view.notUsed} total={view.notUsedTotal} canEdit={view.canEdit} busyId={busyId} onUse={use} />

          {view.context.length > 0 || view.contextSentence ? (
            <section aria-labelledby={ids.context} className="flex flex-col gap-2">
              <Heading id={ids.context}>{W.contextHeading}</Heading>
              <p className="text-[14px] text-ink-muted">{view.contextSentence}</p>
              {view.context.length > 0 ? (
                <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
                  {view.context.map((c) => (
                    <li key={c.listingId} className="px-4 py-3 text-[15px]">
                      <p className="font-medium text-ink [overflow-wrap:anywhere]">{c.address}</p>
                      <p className="text-[14px] text-ink-muted">{[LISTING_STATUS_WORDS[c.status] ?? c.status, c.listPriceCents !== null ? W.listPrice(money(c.listPriceCents)) : null, ...c.why].filter(Boolean).join(' · ')}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section aria-labelledby={ids.data} className="flex flex-col gap-1">
            <Heading id={ids.data}>{W.dataHeading}</Heading>
            <p className="text-[15px] text-ink">{view.mlsDataAsOfSentence}</p>
            {view.area.sentences.map((x) => (
              <p key={x} className="text-[14px] text-ink-muted">
                {x}
              </p>
            ))}
          </section>

          {view.backtest.sentence ? (
            <section aria-labelledby={ids.backtest} className="flex flex-col gap-1">
              <Heading id={ids.backtest}>{W.backtestHeading}</Heading>
              <p className="text-[15px] text-ink">{view.backtest.sentence}</p>
            </section>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SubjectFacts view={view} busy={patch.pending && origin === 'facts'} error={errorFor('facts')} onSave={(b) => save('facts', { subjectFacts: b })} />

          {view.nearMatches.length > 0 ? (
            <Card className="flex flex-col gap-2" aria-labelledby={ids.near}>
              <h2 id={ids.near} className="text-[17px] font-semibold text-ink">
                {W.nearHeading}
              </h2>
              <p className="text-[15px] text-ink-muted">{W.nearIntro}</p>
              <ul className="flex flex-col gap-2">
                {view.nearMatches.map((m) => (
                  <li key={m.listingId} className="flex flex-col gap-1">
                    <p className="text-[15px] text-ink [overflow-wrap:anywhere]">
                      <span className="font-medium">{m.address}</span> · {LISTING_STATUS_WORDS[m.status] ?? m.status}
                    </p>
                    {m.dismissed ? (
                      <p className="text-[14px] text-ink-muted">{W.nearDismissed}</p>
                    ) : view.canEdit ? (
                      <Button variant="secondary" className="self-start" aria-label={W.nearDifferentLabel(m.address)} pending={busyId === m.listingId} onClick={() => different(m.listingId)}>
                        {W.nearDifferent}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Purpose view={view} busy={patch.pending && origin === 'purpose'} error={errorFor('purpose')} onSave={(b) => save('purpose', b)} />

          {s.applies ? <SharePanel s={s} withButton={wide} sentenceId={sentenceId} /> : view.status === 'draft' && neverShared(view) ? <Notice tone="info">{W.noShareHere}</Notice> : null}
        </div>
      </div>

      {shareBar ? (
        <div ref={bar} data-sticky className="sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-10 -mx-4 flex flex-col gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:bottom-0 [@media(max-height:559.98px)]:static">
          <ShareOutcome s={s} />
          <ShareRecipient s={s} />
          {s.preview?.sentence ? (
            <p id={`${sentenceId}-bar`} className="text-[14px] text-ink">
              {s.preview.sentence}
              {s.preview.blockers.length > 0 ? ` ${W.reasonsBelow(s.preview.blockers.length)}` : null}
            </p>
          ) : null}
          <ShareButton s={s} {...(s.preview?.sentence ? { describedBy: `${sentenceId}-bar` } : {})} />
        </div>
      ) : null}
    </div>
  );
}

function SharedCard({ view }: { view: CmaView }) {
  const hid = useId();
  const m = view.share?.message ?? null;
  return (
    <Card className="flex flex-col gap-2" aria-labelledby={hid}>
      <h2 id={hid} className="text-[17px] font-semibold text-ink">
        {W.shareStatusHeading}
      </h2>
      {view.sharedAt ? <p className="text-[15px] text-ink">{W.sharedOn(day(view.sharedAt))}</p> : null}
      {m ? <p className="text-[15px] font-medium text-ink">{m.sentence}</p> : null}
      {view.pdfAvailable ? (
        <a href={pdfHref(view.id)} download className="inline-flex min-h-tap items-center self-start text-[15px] font-medium text-accent underline">
          {W.pdfLink}
        </a>
      ) : null}
    </Card>
  );
}
