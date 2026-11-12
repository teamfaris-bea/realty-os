// The paths that are set up elsewhere: partner feeds (which need the partner's access: never said to be connected),
// a chat on your website, and leads typed in or imported.
import { Link } from 'react-router-dom';
import type { SourceOverview } from '../types.js';
import { Muted } from '../ui.js';
import { PAGES, hasLiveChat } from '../words.js';

const FEED_WORDS: Record<string, string> = { zillow_feed: 'Zillow partner feed', realtor_feed: 'Realtor.com partner feed' };

export const PARTNER_SENTENCE = 'A Zillow or Realtor.com partner feed needs partner access from them first. Meanwhile, use lead email: the portal can send its new-lead emails to this source’s address.';
/** b9 ui/F5: a live widget on a source with no consent text (the Website chat page shows it as Not working). */
export const CHAT_NO_CONSENT = "Its chat window never opens: this source has no consent text, which the chat shows before the first message. Add it under This source.";

export function PartnerPath({ source }: { source: SourceOverview }) {
  return (
    <>
      {source.paths.partnerFeeds.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[15px] text-ink">
          {source.paths.partnerFeeds.map((f, i) => (
            <li key={`${f.kind}-${i}`}>{FEED_WORDS[f.kind] ?? 'Partner feed'}: needs partner access</li>
          ))}
        </ul>
      ) : null}
      <p className="text-[15px] text-ink">{PARTNER_SENTENCE}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
        <a href="#email" className="inline-flex min-h-tap items-center text-accent underline">
          Use lead email
        </a>
        <Link to={PAGES.integrations} className="inline-flex min-h-tap items-center text-accent underline">
          Integrations
        </Link>
      </p>
    </>
  );
}

export function ChatPath({ source }: { source: SourceOverview }) {
  const n = source.paths.webChats.length;
  return (
    <>
      <Muted>{n === 0 ? 'No website chat sends its conversations to this source.' : n === 1 ? 'One website chat sends its conversations to this source.' : `${n} website chats send their conversations to this source.`}</Muted>
      {source.active && !source.hasConsentText && hasLiveChat(source) ? <p className="text-[15px] text-ink">{CHAT_NO_CONSENT}</p> : null}
      <p className="text-[15px]">
        <Link to={PAGES.webChat} className="inline-flex min-h-tap items-center text-accent underline">
          Set up website chat
        </Link>
      </p>
    </>
  );
}

export function TypedPath() {
  return (
    <>
      <Muted>Leads you type in or import are added on these pages.</Muted>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
        <Link to={PAGES.addPerson} className="inline-flex min-h-tap items-center text-accent underline">
          Add a person
        </Link>
        <Link to={PAGES.imports} className="inline-flex min-h-tap items-center text-accent underline">
          Import
        </Link>
      </p>
    </>
  );
}
