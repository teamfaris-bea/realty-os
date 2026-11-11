// Text folding for the parity proxy lexicon (tag names, custom field labels and options).
//
// The same idea as core/fairhousing's tokenizer (which is internal to that module): NFKC, lower case,
// invisible format characters dropped, common Cyrillic/Greek look-alikes mapped to Latin, apostrophes
// inside words dropped, and runs of two or more single letters merged ("V.A." is "va", "v a" is "va"),
// so a label cannot dodge the lexicon by spelling. par-proxy/3 adds the readings of a name's case
// boundaries ("ActiveDuty", "VALoan", "PCSmove") and plain singulars ("Catholics", "Single moms"). Pure.

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

/**
 * The name with its case boundaries read as word breaks, before anything is lower-cased (par-proxy/3):
 * "ActiveDuty" → "Active Duty", "SingleMom" → "Single Mom", "Section8Buyer" → "Section8 Buyer". An
 * upper-case run followed by lower case is ambiguous (its last letter may start the next word, or not),
 * so there are two readings: "VALoan" → "VA Loan" / "VAL oan", "PCSmove" → "PC Smove" / "PCS move".
 * A name without case boundaries reads as itself both times.
 */
export function caseSplits(s: string): [string, string] {
  const n = s.normalize('NFKC').replace(INVISIBLE_RE, '');
  const words = n.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2');
  return [words.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2'), words.replace(/(\p{Lu}{2,})(\p{Ll})/gu, '$1 $2')];
}

/**
 * A folded word and its plain singulars (par-proxy/3), the word first: "catholics" → catholic,
 * "churches" → church (and "churche"), "families" → family, "moms" → mom. Only what an English plural
 * can strip; a candidate that is not a lexicon word matches nothing.
 */
export function singularForms(w: string): string[] {
  const out = [w];
  if (w.length > 4 && w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  if (w.length > 3 && w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  return out;
}
