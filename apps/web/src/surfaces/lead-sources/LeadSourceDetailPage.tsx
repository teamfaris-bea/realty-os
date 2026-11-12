// One lead source (Owner/Admin): each path as a card that opens (its state in words on the card), with its steps,
// values to copy, state and actions; "Where would a new lead go?"; rename, consent text, turn off / on. One column on
// a phone; on desktop the paths sit on the left and the preview and settings on the right. ?setup=<path> (where
// "Add a source" sends you) puts that path first and opens it.
import { useEffect, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Notice } from '../../design/index.js';
import { usePageTitle } from '../../shell/index.js';
import { useOverview } from './hooks.js';
import { Manage } from './Manage.js';
import { sentenceFor } from './messages.js';
import { EmailPath } from './paths/EmailPath.js';
import { GooglePath } from './paths/GooglePath.js';
import { ChatPath, PartnerPath, TypedPath } from './paths/OtherPaths.js';
import { PhonePath } from './paths/PhonePath.js';
import { WebhookPath } from './paths/WebhookPath.js';
import { Preview } from './Preview.js';
import type { SourceOverview } from './types.js';
import { PathSection } from './ui.js';
import { type ChipState, PAGES, type PathKey, kindWords, pathChips, skippedSentence, statusSentence, waitingSentence } from './words.js';

const ORDER: PathKey[] = ['email', 'google', 'phone', 'webhook', 'partner', 'chat', 'typed'];
const TITLES: Record<PathKey, string> = {
  email: 'Lead email',
  google: 'Google Ads lead form',
  phone: 'Tracking phone numbers',
  webhook: 'Webhook (for developers)',
  partner: 'Zillow or Realtor.com partner feed',
  chat: 'Website chat',
  typed: 'Typed in or imported',
  forward: "An agent's forwarded email",
};

function stateOf(s: SourceOverview, path: PathKey): ChipState | null {
  if (path === 'typed') return null;
  const chip = pathChips(s).find((c) => c.path === path);
  if (chip) return chip.state;
  if (path === 'partner') return 'Needs partner access';
  return 'Not set up';
}

export default function LeadSourceDetailPage() {
  const { sourceId } = useParams();
  const [params] = useSearchParams();
  const setup = params.get('setup') as PathKey | null;
  const q = useOverview();
  const s = q.data?.sources.find((x) => x.id === sourceId) ?? null;
  usePageTitle(s?.name ?? null);
  const names = useMemo(() => new Map((q.data?.sources ?? []).map((x) => [x.id, x.name])), [q.data]);
  const order = setup && ORDER.includes(setup) ? [setup, ...ORDER.filter((p) => p !== setup)] : ORDER;
  useEffect(() => {
    if (!s || !setup) return;
    const el = document.getElementById(setup);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
    // once, when the source has loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.id, setup]);

  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{sentenceFor(q.error)}</Notice>;
  if (!s) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="warn">This lead source doesn't exist, or you can't see it.</Notice>
        <p className="text-[15px]">
          <Link to="/admin/lead-sources" className="inline-flex min-h-tap items-center text-accent underline">
            All lead sources
          </Link>
        </p>
      </div>
    );
  }
  const waiting = waitingSentence(s);
  const body = (p: PathKey) => {
    switch (p) {
      case 'email':
        return <EmailPath source={s} />;
      case 'google':
        return <GooglePath source={s} />;
      case 'phone':
        return <PhonePath source={s} sourceName={(id) => names.get(id) ?? 'another source'} />;
      case 'webhook':
        return <WebhookPath source={s} />;
      case 'partner':
        return <PartnerPath source={s} />;
      case 'chat':
        return <ChatPath source={s} />;
      default:
        return <TypedPath />;
    }
  };
  return (
    <div className="flex w-full flex-col gap-4">
      <p className="hidden text-[15px] md:block">
        <Link to="/admin/lead-sources" className="inline-flex min-h-tap items-center text-accent underline">
          All lead sources
        </Link>
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-[15px] text-ink-muted">{kindWords(s.kind)}</p>
        <p className="text-[16px] text-ink">{statusSentence(s, Date.now())}</p>
        {skippedSentence(s) ? <p className="text-[15px] text-ink">{skippedSentence(s)}</p> : null}
        {waiting ? (
          <p className="text-[15px]">
            <Link to={PAGES.needsReview} className="inline-flex min-h-tap items-center text-accent underline">
              {waiting}
            </Link>
          </p>
        ) : null}
      </div>
      {!s.active ? <Notice tone="warn">This source is off: what is sent to it is not received. Turn it on under This source.</Notice> : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          {order.map((p) => {
            const state = stateOf(s, p);
            return (
              <PathSection key={p} id={p} title={TITLES[p]} state={state} open={p === setup || state === 'On'}>
                {body(p)}
              </PathSection>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Preview sourceId={s.id} />
          <Manage source={s} />
        </div>
      </div>
    </div>
  );
}
