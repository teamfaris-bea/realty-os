// Text folding for the parity proxy lexicon (tag names, custom field labels and options).
//
// The same idea as core/fairhousing's tokenizer (which is internal to that module): NFKC, lower case,
// invisible format characters dropped, common Cyrillic/Greek look-alikes mapped to Latin, apostrophes
// inside words dropped, and runs of two or more single letters merged ("V.A." is "va", "v a" is "va"),
// so a label cannot dodge the lexicon by spelling. Pure.

const CONFUSABLES: Readonly<Record<string, string>> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's',
  'α': 'a', 'ο': 'o', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
};
const INVISIBLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
const APOSTROPHES_RE = /(?<=\p{L})['’ʼ‘`](?=\p{L})/gu;

/** Lower-case, NFKC, invisible characters dropped, look-alikes mapped. */
export function foldText(s: string): string {
  let out = '';
  for (const c of s.normalize('NFKC').toLowerCase().replace(INVISIBLE_RE, '')) out += CONFUSABLES[c] ?? c;
  return out.replace(APOSTROPHES_RE, '');
}

/** Folded word tokens; consecutive single letters are merged ("v.a. buyer" → ["va", "buyer"]). */
export function foldWords(s: string): string[] {
  const raw = foldText(s)
    .split(/[^\p{L}\p{N}+]+/u)
    .filter((w) => w !== '');
  const out: string[] = [];
  let run = '';
  for (const w of raw) {
    if ([...w].length === 1 && /\p{L}/u.test(w)) {
      run += w;
      continue;
    }
    if (run !== '') out.push(run);
    run = '';
    out.push(w);
  }
  if (run !== '') out.push(run);
  return out;
}
