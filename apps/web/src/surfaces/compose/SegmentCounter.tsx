// R-MMS-9: how many text messages this text goes as, under the compose box (Text only, hidden while the box is empty).
//
// It counts the text exactly as it will be sent: the preview's rendering (preview.final, with the brokerage line a
// marketing text gets) when that preview is of the current words, otherwise the typed words. Parts split at 153/67 on
// a local number and 152/66 on a toll-free one (preview.textSender; 'local' until the preview says).
//
// When a character a text message can't carry in its plain alphabet (an emoji, a curly quote) makes it go as more
// messages, or makes each one hold 70 characters instead of 160, it names that character, in words where it doesn't
// show ("a no-break space"). No cost is claimed. A text over 1,600 characters is refused and Send says why. With
// photos or videos it is a picture message: one message, no parts.
//
// "Use plain quotes" turns the agent's own ‘ ’ “ ” into ' and " when that makes the whole text plain; it never edits
// what the send adds.
import { type SmsSender, SMS_TEXT_MAX_UNITS, smsSegments } from '@realty/core/texting';
import { useRef } from 'react';
import { Button } from '../../design/index.js';
import { formatSize } from './prepareMedia.js';

const QUOTES = new Set(['‘', '’', '“', '”']);

const NAMES: Record<string, string> = {
  '’': 'the curly apostrophe ’',
  '‘': 'the curly quote ‘',
  '“': 'the curly quote “',
  '”': 'the curly quote ”',
  ' ': 'a no-break space',
  '\t': 'a tab',
  ' ': 'a narrow no-break space',
  ' ': 'a figure space',
  '​': 'a zero-width space',
  '‌': 'a zero-width non-joiner',
  '‍': 'a zero-width joiner',
  '⁠': 'a word joiner',
  '﻿': 'a zero-width no-break space',
  '­': 'a soft hyphen',
  ' ': 'a line separator',
  ' ': 'a paragraph separator',
  '\u000b': 'a vertical tab',
};

/** A character named in words (typographic quotes, and characters that don't show), or shown as itself. */
export function characterName(g: string): string {
  if (NAMES[g]) return NAMES[g]!;
  if (/^\p{Zs}$/u.test(g)) return 'an unusual space';
  if (/^[\p{Cc}\p{Cf}]+$/u.test(g)) return 'an invisible character';
  return g;
}

/** "😊", "😊 and the curly quote “", "a, b and c", "a, b, c and 2 more". */
export function nameList(chars: readonly string[]): string {
  const names = chars.slice(0, 3).map(characterName);
  const more = chars.length - names.length;
  if (more > 0) return `${names.join(', ')} and ${more} more`;
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The agent's ‘ ’ “ ” as plain ' and ". */
export function plainQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

const count = new Intl.NumberFormat('en-US');

export interface CounterInput {
  /** the words in the box */
  typed: string;
  /** the preview's rendering of exactly these words, or null when there is none for them */
  final: string | null;
  sender: SmsSender;
  /** the attached photos and videos, or null when there are none */
  media: { count: number; totalBytes: number } | null;
}

export interface CounterView {
  summary: string;
  /** the special-character sentence (the only live part) */
  special: string | null;
  /** over 1,600 characters: Send is disabled and says this */
  tooLong: string | null;
  /** "Use plain quotes" would make the whole text plain */
  plainQuotes: boolean;
}

/** What the counter says for this text; null while the box is empty. */
export function counterView({ typed, final, sender, media }: CounterInput): CounterView | null {
  const words = typed.trim();
  const withMedia = media !== null && media.count > 0;
  if (words === '' && !withMedia) return null;
  const text = final ?? words;
  const tooLong = text.length > SMS_TEXT_MAX_UNITS ? `Too long for a text: ${count.format(text.length)} of ${count.format(SMS_TEXT_MAX_UNITS)} characters. Shorten it or send an email.` : null;
  if (withMedia) return { summary: `Picture message · ${media.count} of 10 · ${formatSize(media.totalBytes)} of 5 MB`, special: null, tooLong, plainQuotes: false };
  const s = smsSegments(text, { sender });
  const summary = s.parts === 1 ? `1 text message · ${s.units}/${s.perPart}` : `${s.parts} text messages · ${count.format(s.units)} characters (sent in parts of ${s.perPart})`;
  let special: string | null = null;
  let plain = false;
  if (s.encoding === 'ucs2' && tooLong === null) {
    const typedSpecial = new Set(smsSegments(words, { sender }).special);
    const addedOnly = final !== null && s.special.every((g) => !typedSpecial.has(g));
    const names = nameList(s.special);
    const costsParts = s.parts > s.gsmParts;
    // the plain alphabet's capacity at the same number of parts
    const gsmPer = s.parts <= 1 ? 160 : sender === 'toll_free' ? 152 : 153;
    if (addedOnly) {
      const verb = s.special.length > 1 ? 'make' : 'makes';
      special = costsParts
        ? `The ${names} in the brokerage line added to marketing texts ${verb} this go as ${s.parts} text messages instead of ${s.gsmParts}.`
        : `The ${names} in the brokerage line added to marketing texts ${verb} each text message hold ${s.perPart} characters instead of ${gsmPer}.`;
    } else {
      special = costsParts ? `Because of ${names}, this goes as ${s.parts} text messages instead of ${s.gsmParts}.` : `Because of ${names}, each text message holds ${s.perPart} characters instead of ${gsmPer}.`;
    }
    // every special character is a curly quote the agent typed, and plain quotes make the text as sent plain
    if (s.special.every((g) => QUOTES.has(g) && typedSpecial.has(g))) {
      const fixedWords = plainQuotes(words);
      const fixed = final === null ? fixedWords : final.includes(words) ? final.replace(words, () => fixedWords) : null;
      plain = fixed !== null && smsSegments(fixed, { sender }).encoding === 'gsm7';
    }
  }
  return { summary, special, tooLong, plainQuotes: plain };
}

/** The counter for the box, remembering the last sender the preview named while a new preview loads. */
export function useCounterView(input: Omit<CounterInput, 'sender'> & { sender: SmsSender | null | undefined }): CounterView | null {
  const last = useRef<SmsSender>('local');
  if (input.sender) last.current = input.sender;
  return counterView({ ...input, sender: input.sender ?? last.current });
}

export interface SegmentCounterProps {
  /** the textarea's aria-describedby points here */
  id: string;
  view: CounterView | null;
  onPlainQuotes(): void;
}

/** Mounted while Text is chosen (so its live sentence is announced); shows nothing while the box is empty. */
export function SegmentCounter({ id, view, onPlainQuotes }: SegmentCounterProps) {
  return (
    <div data-testid="segment-counter" className="flex flex-col gap-1">
      <div id={id} className="flex flex-col text-[13px] leading-snug text-ink-muted">
        {view ? <p data-testid="segment-summary">{view.summary}</p> : null}
        <p aria-live="polite" data-testid="segment-special">
          {view?.special ?? ''}
        </p>
        {view?.tooLong ? (
          <p id={`${id}-too-long`} data-reason="too-long" className="font-medium text-danger">
            {view.tooLong}
          </p>
        ) : null}
      </div>
      {view?.plainQuotes ? (
        <Button variant="secondary" className="self-start" onClick={onPlainQuotes}>
          Use plain quotes
        </Button>
      ) : null}
    </div>
  );
}
