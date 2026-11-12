// Texting reactions in the thread (owner decision D5b; R-REACT-3, R-REACT-6; E300, E301, E305).
// A reaction text a phone sent (`Loved “…”`) that the server linked to the team's text shows as one line naming the
// reaction and the text, never as the person's own words; the raw text is one tap away. The reacted-to bubble gets a
// small chip with the reaction in force. When the whole text would have read as an opt-out or a wrong number, the line
// says it was not, and offers the person-level do-not-contact (module 57's POST /contacts/:id/do-not-contact, the
// R-CHAN-3 path) in two taps to those who may edit the person (R-PAR-7, R-PAR-32, E193). An unlinked reaction-shaped
// text has no `reaction` and stays an ordinary bubble.
import { reactionPhrase } from '@realty/core/compliance';
import { useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { firstName, formatDateTime } from '../feed/lib/format.js';
import type { TimelineItem, TimelineReaction } from '../feed/lib/types.js';
import { useDetails } from '../people-edit/api.js';
import { usePersonAction, useToast } from '../people-edit/hooks.js';

const GLYPH: Record<Exclude<TimelineReaction['reaction'], 'emoji' | 'sticker'>, string> = {
  love: '❤️',
  like: '\u{1F44D}',
  dislike: '\u{1F44E}',
  laugh: '\u{1F602}',
  emphasize: '‼️',
  question: '❓',
};

/** The glyph for a reaction: the tapback's emoji, the word "Sticker", or the emoji as received. */
export function reactionGlyph(r: { reaction: TimelineReaction['reaction']; emoji: string | null }): string {
  if (r.reaction === 'sticker') return 'Sticker';
  if (r.reaction === 'emoji') return r.emoji ?? '';
  return GLYPH[r.reaction];
}

/** One line in place of a bubble: "Sam loved “See you at 3”", the SMS tag, the time and, when narrowed, the note. */
export function ReactionLine({ item, contact, loaded }: { item: TimelineItem & { reaction: TimelineReaction }; contact?: { id: string; name: string }; loaded?: ReadonlySet<string> }) {
  const r = item.reaction;
  const first = firstName(contact?.name);
  const linked = loaded?.has(r.targetMessageId) === true;
  return (
    <li id={item.id} data-reaction={r.action} className="flex max-w-[85%] flex-col gap-0.5 self-start items-start">
      <p className="px-1 text-[15px] text-ink [overflow-wrap:anywhere]">
        {first} {reactionPhrase(r)}{' '}
        {linked ? (
          <a href={`#${r.targetMessageId}`} className="text-accent underline">
            “{r.quote}”
          </a>
        ) : (
          <>“{r.quote}”</>
        )}
      </p>
      <p className="flex flex-wrap items-center gap-x-1 px-1 text-[12px] text-ink-muted">
        <span data-channel-tag="sms" className="rounded-md border border-line px-1.5 py-px text-[12px] font-medium leading-4 text-ink">
          SMS
        </span>
        <span>{formatDateTime(item.occurredAt)}</span>
      </p>
      {r.narrowed ? (
        <>
          <p className="px-1 text-[13px] font-medium text-ink">Not read as an opt-out or a wrong number: the words in quotes come from a text sent to {first}.</p>
          {contact ? <DoNotContactOffer contactId={contact.id} first={first} /> : null}
        </>
      ) : null}
      <details className="px-1 text-[14px] text-ink-muted">
        <summary className="inline-flex min-h-tap cursor-pointer items-center">Show what they sent</summary>
        <p className="whitespace-pre-wrap break-words pb-2 text-ink">{r.raw}</p>
      </details>
    </li>
  );
}

/** The quiet offer under a narrowed reaction: one tap opens the confirm, one tap records it (R-PAR-32). */
function DoNotContactOffer({ contactId, first }: { contactId: string; first: string }) {
  const details = useDetails(contactId);
  const [asking, setAsking] = useState(false);
  const dnc = usePersonAction<{ alreadySet: boolean }>(contactId);
  const toast = useToast();
  // Already recorded (by any path, a merge included): nothing to offer, and the line says so instead (b8 texting ui/F9).
  if (details.data?.details.doNotContact === true) return <p className="px-1 text-[13px] text-ink-muted">{first} is already marked do not contact.</p>;
  if (details.data?.details.canEdit !== true) return null;
  const record = async () => {
    const r = await dnc.run('POST', `/contacts/${contactId}/do-not-contact`, { reason: 'asked_in_writing' });
    if (!r.ok) return;
    // never "Recorded" when nothing changed: the API answers alreadySet when someone recorded it first
    toast({ text: r.data.alreadySet ? `Already recorded: ${first} is marked do not contact. Nothing changed.` : `Recorded: do not contact ${first}` });
    setAsking(false);
  };
  return (
    <>
      <button type="button" className="inline-flex min-h-tap items-center px-1 text-[14px] font-medium text-accent" onClick={() => setAsking(true)}>
        They asked not to be contacted…
      </button>
      {asking ? (
        <Dialog
          title={`Did ${first} ask not to be contacted?`}
          description="A reaction alone doesn’t stop anything from being sent."
          onClose={() => setAsking(false)}
          footer={
            <div className="flex flex-col gap-2">
              <Button block onClick={() => void record()} pending={dnc.pending}>
                Yes, record do not contact
              </Button>
              <Button block variant="secondary" onClick={() => setAsking(false)}>
                No
              </Button>
            </div>
          }
        >
          <p className="text-[15px] text-ink">Recording it stops every text, email and call to {first} from anyone on the team. Only {first} can undo it.</p>
          {dnc.error ? <Notice tone="error">{dnc.error}</Notice> : null}
        </Dialog>
      ) : null}
    </>
  );
}

/** The small pill under the reacted-to bubble: the glyph (hidden from screen readers) and a spoken name. */
export function ReactedWithChip({ reactedWith, contactName }: { reactedWith: NonNullable<TimelineItem['reactedWith']>; contactName?: string }) {
  const first = firstName(contactName);
  return (
    <span data-reacted-with={reactedWith.reaction} className="-mt-2 inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 text-[13px] leading-5 text-ink">
      <span aria-hidden="true">{reactionGlyph(reactedWith)}</span>
      <span className="sr-only">
        {first} {reactionPhrase({ action: 'add', reaction: reactedWith.reaction, emoji: reactedWith.emoji })} this text
      </span>
    </span>
  );
}
