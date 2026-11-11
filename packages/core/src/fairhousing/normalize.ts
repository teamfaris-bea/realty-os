// Text → word tokens for the fair-housing lexicon, with offsets into the original text.
//
// Detection runs on folded text so obfuscation cannot hide a term (the same idea as the assistant
// content guard's `foldForDetection`, re-implemented here because core/assistant imports this
// module, not the other way round):
//   - NFKC per code point (full-width and styled letters become plain ones)
//   - invisible format characters dropped ("fa\u200Bmilies" is "families")
//   - look-alike Cyrillic/Greek letters mapped to Latin ("kіds" with a Cyrillic і is "kids")
//   - apostrophes inside words dropped ("children's" is "childrens")
//   - leetspeak digits inside words that contain letters mapped ("k1ds" is "kids")
//   - three or more single-letter tokens in a row merged ("n o k i d s" is one token "nokids";
//     the matcher compares merged tokens with each pattern's letters run together)
// Offsets always point into the original string, so a match can be highlighted exactly.

export interface Token {
  /** Folded, lower-cased token text. */
  text: string;
  /** UTF-16 offsets into the original text (end exclusive). */
  start: number;
  end: number;
  /** Sentence number (increments at . ! ? ; and line breaks). */
  sentence: number;
  /** Merged from a run of single letters ("n o k i d s"). */
  merged: boolean;
}

const CONFUSABLES: Readonly<Record<string, string>> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'һ': 'h',
  'α': 'a', 'ο': 'o', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
};
const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

const INVISIBLE_RE = /^\p{Default_Ignorable_Code_Point}$/u;
const WORD_CHAR_RE = /^[\p{L}\p{N}\p{M}]$/u;
const APOSTROPHES = new Set(["'", '’', 'ʼ', '‘', '`']);
const SENTENCE_END = new Set(['.', '!', '?', ';', '\n', '\r']);

/** Fold one original character to the lower-case Latin characters detection sees. */
export function foldChar(ch: string): string {
  let out = '';
  // lower-case first, so capital look-alikes (Greek Α, Cyrillic О) map through their small forms
  for (const c of ch.normalize('NFKC').toLowerCase()) {
    if (INVISIBLE_RE.test(c)) continue;
    out += CONFUSABLES[c] ?? c;
  }
  return out;
}

function finishText(raw: string): string {
  if (/\p{L}/u.test(raw)) return raw.replace(/[0134578@$]/g, (c) => LEET[c] as string);
  return raw.replace(/[@$]/g, '');
}

/** Split text into folded word tokens with original offsets and sentence numbers. */
export function tokenize(original: string, opts: { invisibleBreaks?: boolean } = {}): Token[] {
  const raw: Token[] = [];
  let cur: { text: string; start: number; end: number } | null = null;
  let sentence = 0;
  let curSentence = 0;
  const flush = (): void => {
    if (cur !== null) {
      const text = finishText(cur.text);
      if (text !== '') raw.push({ text, start: cur.start, end: cur.end, sentence: curSentence, merged: false });
      cur = null;
    }
  };
  let i = 0;
  for (const ch of original) {
    const at = i;
    i += ch.length;
    const folded = foldChar(ch);
    if (folded === '') {
      // invisible: dropped by default; with `invisibleBreaks` it ends the word (not the sentence)
      if (opts.invisibleBreaks === true) flush();
      continue;
    }
    if (APOSTROPHES.has(ch) && cur !== null) continue; // inside a word ("children's")
    let isWord = true;
    for (const c of folded) if (!(WORD_CHAR_RE.test(c) || c === '@' || c === '$' || c === '+')) isWord = false;
    if (isWord) {
      if (cur === null) {
        cur = { text: '', start: at, end: at };
        curSentence = sentence;
      }
      cur.text += folded.replace(/\p{M}/gu, '');
      cur.end = i;
    } else {
      flush();
      // a dot between letters ("k.i.d.s", "St.Mark") does not end a sentence
      const dotInWord = ch === '.' && /[\p{L}\p{N}]/u.test(original[i] ?? '');
      if (SENTENCE_END.has(ch) && !dotInWord) sentence += 1;
    }
  }
  flush();
  return mergeSpelledOut(raw);
}

/** Merge runs of 3+ single-letter tokens in one sentence ("n o k i d s") into one token. */
function mergeSpelledOut(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let k = 0;
  while (k < tokens.length) {
    const t = tokens[k] as Token;
    if (t.text.length === 1 && /\p{L}/u.test(t.text)) {
      let j = k;
      while (j + 1 < tokens.length) {
        const n = tokens[j + 1] as Token;
        if (n.text.length === 1 && /\p{L}/u.test(n.text) && n.sentence === t.sentence) j += 1;
        else break;
      }
      if (j - k + 1 >= 3) {
        const run = tokens.slice(k, j + 1);
        out.push({ text: run.map((r) => r.text).join(''), start: t.start, end: (run[run.length - 1] as Token).end, sentence: t.sentence, merged: true });
        k = j + 1;
        continue;
      }
    }
    out.push(t);
    k += 1;
  }
  return out;
}
