// D5b texting reactions (R-REACT-1, R-REACT-2, R-REACT-3, R-REACT-6; E300–E307). Synthetic fixtures only.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyInbound } from './inbound.js';
import { type ParsedReaction, REACTION_MAX_CANDIDATES, classifyWithReaction, foldReactions, parseReaction, reactionLinkKey, reactionPhrase } from './reactions.js';
import { policy } from './testing/fixtures.js';
import { CHANNELS, type Keywords } from './types.js';

const K = policy().keywords;
const K_ES: Keywords = { ...K, optOut: [...K.optOut, 'ALTO', 'PARAR', 'CANCELAR', 'BASTA', 'ARRÊT'] };
const ZWSP = '​';
const ZWNJ = '‌';
const HAIR = ' ';
const SCOTLAND = '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
const ENGLAND = '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';

type Expect = Omit<ParsedReaction, 'ownWords'> & { ownWords?: string };
const add = (reaction: ParsedReaction['reaction'], quote: string, emoji: string | null = null): Expect => ({ action: 'add', reaction, emoji, quote });
const rem = (reaction: ParsedReaction['reaction'], quote: string, emoji: string | null = null): Expect => ({ action: 'remove', reaction, emoji, quote });
const Q = 'See you at 3';

/** One synthetic fixture per form of the template table (lane brief scope 1a). */
export const TEMPLATE_FIXTURES: readonly [string, string, Expect][] = [
  // iPhone en-US add
  ['en-US love', `Loved “${Q}”`, { ...add('love', Q), ownWords: 'Loved' }],
  ['en-US like', `Liked “${Q}”`, add('like', Q)],
  ['en-US dislike', `Disliked “${Q}”`, add('dislike', Q)],
  ['en-US laugh', `Laughed at “${Q}”`, { ...add('laugh', Q), ownWords: 'Laughed at' }],
  ['en-US emphasize', `Emphasized “${Q}”`, add('emphasize', Q)],
  ['en-US question', `Questioned “${Q}”`, add('question', Q)],
  // iPhone en-US remove
  ['en-US remove heart', `Removed a heart from “${Q}”`, rem('love', Q)],
  ['en-US remove like', `Removed a like from “${Q}”`, rem('like', Q)],
  ['en-US remove dislike', `Removed a dislike from “${Q}”`, rem('dislike', Q)],
  ['en-US remove laugh', `Removed a laugh from “${Q}”`, rem('laugh', Q)],
  ['en-US remove exclamation', `Removed an exclamation from “${Q}”`, rem('emphasize', Q)],
  ['en-US remove question mark', `Removed a question mark from “${Q}”`, rem('question', Q)],
  // iPhone 18+
  ['iOS 18 emoji', `Reacted 👍 to “${Q}”`, { ...add('emoji', Q, '👍'), ownWords: 'Reacted 👍 to' }],
  ['iOS 18 emoji ‼️', `Reacted ‼️ to “${Q}”`, add('emoji', Q, '‼️')],
  ['iOS 18 emoji ℹ️', `Reacted ℹ️ to “${Q}”`, add('emoji', Q, 'ℹ️')],
  ['iOS 18 emoji tag flag', `Reacted ${SCOTLAND} to “${Q}”`, add('emoji', Q, SCOTLAND)],
  ['iOS 18 remove emoji', `Removed 👍 from “${Q}”`, rem('emoji', Q, '👍')],
  ['iOS 18 sticker', `Reacted with a sticker to “${Q}”`, add('sticker', Q)],
  ['iOS 18 remove sticker', `Removed a sticker from “${Q}”`, rem('sticker', Q)],
  // Google en
  ['Google en add v2', `${ZWSP}👍${ZWSP} to “${HAIR}${Q}${HAIR}”`, { ...add('emoji', Q, '👍'), ownWords: '👍 to' }],
  ['Google en add straight hair', `${ZWSP}❤️${ZWSP} to "${HAIR}${Q}${HAIR}"`, add('emoji', Q, '❤️')],
  ['Google en add straight bare', `😂 to "${Q}"`, add('emoji', Q, '😂')],
  ['Google en remove', `Removed ${ZWNJ}👍${ZWNJ} from “${HAIR}${Q}${HAIR}”`, rem('emoji', Q, '👍')],
  // iPhone es-419 add
  ['es-419 love', `Le encantó “${Q}”`, add('love', Q)],
  ['es-419 like', `Le gustó “${Q}”`, add('like', Q)],
  ['es-419 dislike', `No le gustó “${Q}”`, add('dislike', Q)],
  ['es-419 laugh', `Le dio risa “${Q}”`, add('laugh', Q)],
  ['es-419 emphasize', `Exclamó por “${Q}”`, add('emphasize', Q)],
  ['es-419 question', `Dudó sobre “${Q}”`, add('question', Q)],
  // iPhone es-419 remove
  ['es-419 remove love', `Dejó de encantarle “${Q}”`, rem('love', Q)],
  ['es-419 remove like', `Dejó de gustarle “${Q}”`, rem('like', Q)],
  ['es-419 remove dislike', `Dejó de no gustarle “${Q}”`, rem('dislike', Q)],
  ['es-419 remove laugh', `Dejó de darle risa “${Q}”`, rem('laugh', Q)],
  ['es-419 remove emphasize', `Dejó de exclamar por “${Q}”`, rem('emphasize', Q)],
  ['es-419 remove question', `Dejó de dudar sobre “${Q}”`, rem('question', Q)],
  // Google es
  ['Google es add', `${ZWSP}👍${ZWSP} a “${HAIR}${Q}${HAIR}”`, { ...add('emoji', Q, '👍'), ownWords: '👍 a' }],
  ['Google es-US remove', `Se quitó ${ZWNJ}👍${ZWNJ} de "${HAIR}${Q}${HAIR}"`, rem('emoji', Q, '👍')],
  ['Google es remove', `Se ha quitado 👍 de "${Q}"`, { ...rem('emoji', Q, '👍'), ownWords: 'Se ha quitado 👍 de' }],
  // tolerance: mixed case, NFD input, straight quotes on an iPhone form
  ['mixed case', `lOVED “${Q}”`, add('love', Q)],
  ['NFD template words', `Le encantó “${Q}”`, add('love', Q)],
  ['NFD quote', `Loved “Café at 3”`, add('love', 'Café at 3')],
  ['straight quotes iPhone', `Loved "${Q}"`, add('love', Q)],
  ['skin tone', `Reacted 👍🏽 to “${Q}”`, add('emoji', Q, '👍🏽')],
  ['ZWJ family', `👨‍👩‍👧 to “${Q}”`, add('emoji', Q, '👨‍👩‍👧')],
  ['flag', `🇺🇸 to “${Q}”`, add('emoji', Q, '🇺🇸')],
  ['keycap', `Reacted 1️⃣ to “${Q}”`, add('emoji', Q, '1️⃣')],
];

describe('parseReaction (R-REACT-1)', () => {
  it.each(TEMPLATE_FIXTURES)('R-REACT-1 every template parses: %s', (_name, body, want) => {
    const got = parseReaction(body);
    expect(got).not.toBeNull();
    const { ownWords, ...rest } = want;
    expect({ action: got!.action, reaction: got!.reaction, emoji: got!.emoji, quote: got!.quote }).toEqual(rest);
    if (ownWords !== undefined) expect(got!.ownWords).toBe(ownWords);
  });

  it('R-REACT-1 E303 E306 anchoring', () => {
    const nulls = [
      `Loved “${Q}” please stop texting me`, // E303 text after
      `ok Loved “${Q}”`, // text before
      `Reacted a to “${Q}”`, // a letter as E
      `Reacted 1 to “${Q}”`, // a bare digit
      `Reacted 👍👎 to “${Q}”`, // two emoji
      `Reacted ‍ to “${Q}”`, // a lone joiner
      `Reacted ️ to “${Q}”`, // a lone VS16
      `Reacted 🇺 to “${Q}”`, // a lone regional indicator
      `STOP to “${Q}”`,
      `Loved “${Q}"`, // mismatched
      `Loved "${Q}”`,
      `Loved “”`, // empty
      `Loved “ ”`,
      `Loved ${Q}`, // no quote
      `Adored “${Q}”`, // unknown verb
      `Emphasised “${Q}”`, // en-GB (VERIFY 13)
      `Removed an exclamation mark from “${Q}”`, // en-GB
      `Lo­ved “${Q}”`, // soft hyphen inside template words
      `Lo‮ved “${Q}”`, // bidi control
      `‮Loved “${Q}”`,
      'Loved an image', // E306 media forms
      '👍 to a photo',
      'Le gustó una imagen',
      `Removed a 👍 from “${Q}”`, // VERIFY 3
      `Reacted with a photomoji to "${Q}"`, // VERIFY 7
      'Loved',
      '',
    ];
    for (const b of nulls) expect(parseReaction(b), b).toBeNull();
  });
});

const sent = (...bodies: string[]) => bodies.map((body, i) => ({ id: `m${i}`, body }));

describe('classifyWithReaction link rule (R-REACT-2, E307)', () => {
  it('R-REACT-2 E307 link rule', () => {
    // the newest (first) of several equal bodies links
    expect(classifyWithReaction(`Loved “${Q}”`, K, 'sms', sent('other', Q, Q)).reaction?.targetMessageId).toBe('m1');
    // case, spacing, apostrophe style and double quotes are ignored
    expect(classifyWithReaction(`Loved “see  YOU at 3”`, K, 'sms', sent(Q)).reaction?.targetMessageId).toBe('m0');
    expect(classifyWithReaction('Loved “Don’t forget”', K, 'sms', sent("Don't forget")).reaction).not.toBeNull();
    // a cut quote never links, with or without an ellipsis
    expect(classifyWithReaction('Loved “See you at”', K, 'sms', sent(Q)).reaction).toBeNull();
    expect(classifyWithReaction('Loved “See you at…”', K, 'sms', sent(Q)).reaction).toBeNull();
    expect(classifyWithReaction('Loved “See you at...”', K, 'sms', sent(Q)).reaction).toBeNull();
    // nested quotes link
    const nested = 'The seller said “yes” today';
    expect(classifyWithReaction(`Loved “${nested}”`, K, 'sms', sent(nested)).reaction?.targetMessageId).toBe('m0');
    expect(classifyWithReaction(`Loved "${nested.replace(/[“”]/g, '"')}"`, K, 'sms', sent(nested)).reaction).not.toBeNull();
    // two quotes do not link to either text
    expect(classifyWithReaction('Loved “A” and “B”', K, 'sms', sent('A', 'B')).reaction).toBeNull();
    // only SMS carries reactions
    for (const ch of CHANNELS.filter((c) => c !== 'sms')) expect(classifyWithReaction(`Loved “${Q}”`, K, ch, sent(Q)).reaction).toBeNull();
    // no candidates, no link; beyond the candidate cap, no link
    expect(classifyWithReaction(`Loved “${Q}”`, K, 'sms', []).reaction).toBeNull();
    const many = [...Array.from({ length: REACTION_MAX_CANDIDATES }, (_, i) => `x${i}`), Q];
    expect(classifyWithReaction(`Loved “${Q}”`, K, 'sms', sent(...many)).reaction).toBeNull();
  });
});

const QUOTE_POOL = [Q, 'Wrong number?', 'No more texts about Oak St, I promise. Talk soon!', 'Do not text after 9', 'Reply STOP to opt out', 'STOP', 'please stop texting me', 'Remove me from the list', 'Help', 'START', 'Stop by at 5?'];
const PREFIXES = ['Loved ', 'Liked ', 'Questioned ', 'Removed a heart from ', 'Reacted 👍 to ', '👍 to ', `${ZWSP}👍${ZWSP} to `, 'Se ha quitado 👍 de ', 'Le encantó ', 'Dejó de gustarle ', 'Reacted with a sticker to ', 'STOP ', '', 'please stop '];
const SUFFIXES = ['', ' STOP', ' please stop texting me', ' wrong number', ' ok'];
const bodyArb = fc
  .tuple(
    fc.constantFrom(...PREFIXES),
    fc.constantFrom('“', '"', ''),
    fc.constantFrom('', HAIR, ' '),
    fc.constantFrom(...QUOTE_POOL),
    fc.constantFrom('”', '"', ''),
    fc.constantFrom(...SUFFIXES),
    fc.constantFrom('', ZWSP, ZWNJ, '⁠', '﻿', '🛑', '‼️'),
  )
  .map(([p, o, h, q, c, s, z]) => `${z}${p}${o}${h}${q}${h}${c}${s}`);
const sentArb = fc.array(fc.constantFrom(...QUOTE_POOL, 'unrelated'), { maxLength: 6 }).map((b) => sent(...b));

describe('classification (R-REACT-3)', () => {
  it('R-REACT-3 property: unlinked ⇒ classification deep-equals classifyInbound(body, K, ch) for every channel in CHANNELS', () => {
    fc.assert(
      fc.property(bodyArb, sentArb, fc.constantFrom(...CHANNELS), fc.constantFrom(K, K_ES), (body, s, ch, k) => {
        const r = classifyWithReaction(body, k, ch, s);
        expect(r.wholeText).toEqual(classifyInbound(body, k, ch));
        if (r.reaction === null) expect(r.classification).toEqual(classifyInbound(body, k, ch));
      }),
      { numRuns: 1000 },
    );
  });

  it('R-REACT-3 property: linked ⇒ key(target body) equals key(quote), and classification = classifyInbound(ownWords)', () => {
    fc.assert(
      fc.property(bodyArb, sentArb, fc.constantFrom(K, K_ES), (body, s, k) => {
        const r = classifyWithReaction(body, k, 'sms', s);
        if (r.reaction === null) return;
        const target = s.find((m) => m.id === r.reaction!.targetMessageId)!;
        expect(reactionLinkKey(target.body)).toBe(reactionLinkKey(r.reaction.quote));
        // the newest equal candidate
        expect(s.findIndex((m) => reactionLinkKey(m.body) === reactionLinkKey(r.reaction!.quote))).toBe(s.indexOf(target));
        expect(r.classification).toEqual(classifyInbound(r.reaction.ownWords, k, 'sms'));
      }),
      { numRuns: 1000 },
    );
  });

  it('R-REACT-3 own words are inert', () => {
    const corpus = ['👍', '❤️', '❤', '1️⃣', '#️⃣', '🇺🇸', SCOTLAND, ENGLAND, '👨‍👩‍👧', '👍🏽', '\u{1F6D1}', '‼️', '™️', 'ℹ️'];
    for (const [, body] of TEMPLATE_FIXTURES) {
      const p = parseReaction(body)!;
      for (const k of [K, K_ES]) expect(classifyInbound(p.ownWords, k, 'sms').kind, p.ownWords).toBe('none');
    }
    for (const e of corpus) {
      for (const body of [`Reacted ${e} to “${Q}”`, `Removed ${e} from “${Q}”`, `${e} to “${Q}”`, `${e} a “${Q}”`, `Se quitó ${e} de “${Q}”`, `Se ha quitado ${e} de “${Q}”`]) {
        const p = parseReaction(body);
        expect(p, body).not.toBeNull();
        for (const k of [K, K_ES]) expect(classifyInbound(p!.ownWords, k, 'sms').kind, body).toBe('none');
      }
    }
  });

  const E301 = [
    'Liked “Let me know if you don’t want any more texts about this one”',
    'Loved “No more texts about Oak St, I promise. Talk soon!”',
    'Questioned “Wrong number?”',
    'Removed a heart from “Do not text after 9”',
  ];
  it('R-REACT-3 E301', () => {
    for (const body of E301) {
      const quote = parseReaction(body)!.quote;
      const whole = classifyInbound(body, K, 'sms');
      expect(whole.kind, body).not.toBe('none');
      const linked = classifyWithReaction(body, K, 'sms', sent(quote));
      expect(linked.reaction).not.toBeNull();
      expect(linked.classification.kind).toBe('none');
      expect(linked.wholeText).toEqual(whole);
      const unlinked = classifyWithReaction(body, K, 'sms', sent('something else'));
      expect(unlinked.reaction).toBeNull();
      expect(unlinked.classification).toEqual(whole);
    }
    // the three 'none' examples stay none either way
    for (const body of ['Liked “Reply STOP to opt out”', `Loved “${Q}”`, 'Emphasized “Stop by at 5?”']) {
      const quote = parseReaction(body)!.quote;
      expect(classifyWithReaction(body, K, 'sms', sent(quote)).classification.kind, body).toBe('none');
      expect(classifyWithReaction(body, K, 'sms', []).classification.kind, body).toBe('none');
    }
  });

  it('determinism', () => {
    fc.assert(
      fc.property(bodyArb, sentArb, fc.constantFrom(...CHANNELS), (body, s, ch) => {
        expect(classifyWithReaction(body, K, ch, s)).toEqual(classifyWithReaction(body, K, ch, s));
        expect(parseReaction(body)).toEqual(parseReaction(body));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('foldReactions (R-REACT-6, E305)', () => {
  const ev = (action: 'add' | 'remove', reaction: ParsedReaction['reaction'], emoji: string | null = null) => ({ action, reaction, emoji });
  it('R-REACT-6 E305 fold', () => {
    expect(foldReactions([])).toBeNull();
    expect(foldReactions([ev('add', 'love')])).toEqual(ev('add', 'love'));
    expect(foldReactions([ev('add', 'love'), ev('remove', 'love')])).toBeNull();
    // a changed reaction: the later add wins, with or without a removal between
    expect(foldReactions([ev('add', 'love'), ev('add', 'like')])).toEqual(ev('add', 'like'));
    expect(foldReactions([ev('add', 'love'), ev('remove', 'love'), ev('add', 'like')])).toEqual(ev('add', 'like'));
    // a non-matching removal clears nothing
    expect(foldReactions([ev('add', 'like'), ev('remove', 'love')])).toEqual(ev('add', 'like'));
    // removing ❤️ clears ❤ (only U+FE0F is ignored)
    expect(foldReactions([ev('add', 'emoji', '❤'), ev('remove', 'emoji', '❤️')])).toBeNull();
    // removing the Scotland flag leaves England's
    expect(foldReactions([ev('add', 'emoji', ENGLAND), ev('remove', 'emoji', SCOTLAND)])).toEqual(ev('add', 'emoji', ENGLAND));
    expect(foldReactions([ev('add', 'emoji', '👍🏽'), ev('remove', 'emoji', '👍')])).toEqual(ev('add', 'emoji', '👍🏽'));
  });

  it('reactionPhrase', () => {
    expect(reactionPhrase(ev('add', 'love'))).toBe('loved');
    expect(reactionPhrase(ev('add', 'laugh'))).toBe('laughed at');
    expect(reactionPhrase(ev('add', 'sticker'))).toBe('reacted with a sticker to');
    expect(reactionPhrase(ev('add', 'emoji', '👍'))).toBe('reacted 👍 to');
    expect(reactionPhrase(ev('remove', 'love'))).toBe('removed a heart from');
    expect(reactionPhrase(ev('remove', 'emphasize'))).toBe('removed an exclamation from');
    expect(reactionPhrase(ev('remove', 'question'))).toBe('removed a question mark from');
    expect(reactionPhrase(ev('remove', 'sticker'))).toBe('removed a sticker from');
    expect(reactionPhrase(ev('remove', 'emoji', '👍'))).toBe('removed 👍 from');
  });
});
