// SMS segment counting (R-MMS-9): which encoding a text needs, how many parts it takes, and which
// characters forced UCS-2. Pure; built from 3GPP TS 23.038 (GSM 7-bit default alphabet + extension table)
// and the usual concatenated-SMS capacities (UDH takes 6 octets: 153 septets / 67 UTF-16 units per part).
//
// Design choices
// - U+001B (ESC) is the escape code of the GSM table, not a user character: a text containing it is UCS-2.
// - Graphemes come from Intl.Segmenter; its single CR LF grapheme is split into CR and LF (two septets).
// - Whole graphemes are packed greedily; a grapheme never straddles two parts. Only a grapheme longer than a
//   part (a long combining sequence) is split, between code points, never inside a surrogate pair.

export type SmsEncoding = 'gsm7' | 'ucs2';
export type SmsSender = 'local' | 'toll_free';

export interface SmsSegments {
  encoding: SmsEncoding;
  /** number of SMS parts (0 for empty text) */
  parts: number;
  /** septets (gsm7) or UTF-16 code units (ucs2) */
  units: number;
  /** capacity per part actually used: 160/70 single part, else 153/67 (local) or 152/66 (toll-free) */
  perPart: number;
  /** distinct graphemes that forced UCS-2, in order of first appearance (empty for gsm7) */
  special: string[];
  /** parts the text would take if every `special` grapheme were one GSM-7 septet */
  gsmParts: number;
  /** text.length (UTF-16 units) above SMS_TEXT_MAX_UNITS */
  tooLong: boolean;
}

export interface SmsOptions {
  sender?: SmsSender;
}

/** Longest text (UTF-16 units) we accept for one outbound SMS/MMS body. */
export const SMS_TEXT_MAX_UNITS = 1600;

const SINGLE = { gsm7: 160, ucs2: 70 } as const;
const MULTI: Record<SmsSender, { gsm7: number; ucs2: number }> = {
  local: { gsm7: 153, ucs2: 67 },
  toll_free: { gsm7: 152, ucs2: 66 },
};

// 3GPP TS 23.038 §6.2.1 default alphabet, positions 0x00-0x7F (0x1B ESC excluded, see above).
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' + // 0x00-0x1A
  'ÆæßÉ' + // 0x1C-0x1F
  ' !"#¤%&\'()*+,-./0123456789:;<=>?' + // 0x20-0x3F
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' + // 0x40-0x5F
  '¿abcdefghijklmnopqrstuvwxyzäöñüà'; // 0x60-0x7F
// §6.2.1.1 extension table (ESC + code): form feed ^ { } \ [ ~ ] | €
const GSM_EXTENSION = '\f^{}\\[~]|€';

const BASIC = new Set(GSM_BASIC);
const EXTENSION = new Set(GSM_EXTENSION);

/** Septets a single character costs in GSM-7: 1 (basic table), 2 (extension table) or 0 (not GSM-7). */
export function gsm7Cost(ch: string): 0 | 1 | 2 {
  if (ch.length !== 1) return 0;
  if (BASIC.has(ch)) return 1;
  if (EXTENSION.has(ch)) return 2;
  return 0;
}

export function isGsm7Char(ch: string): boolean {
  return gsm7Cost(ch) !== 0;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The graphemes of a text as SMS counts them (CR LF split into CR and LF). */
export function smsGraphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (segment === '\r\n') out.push('\r', '\n');
    else out.push(segment);
  }
  return out;
}

export interface GraphemeClass {
  grapheme: string;
  /** septets in GSM-7, or 0 when this grapheme forces UCS-2 */
  gsm: 0 | 1 | 2;
  /** UTF-16 code units (its cost in UCS-2) */
  ucs2: number;
}

/** Per-grapheme classification (for a live counter that highlights the characters forcing UCS-2). */
export function classifyGraphemes(text: string): GraphemeClass[] {
  return smsGraphemes(text).map((g) => ({ grapheme: g, gsm: gsm7Cost(g), ucs2: g.length }));
}

interface Plan {
  encoding: SmsEncoding;
  units: number;
  perPart: number;
  /** each part as a list of pieces (whole graphemes, or code points of an over-long grapheme) */
  parts: string[][];
  special: string[];
  gsmParts: number;
}

/** Greedy packing of atoms (with costs) into parts of `cap`; an atom costlier than `cap` is split into code points. */
function pack(atoms: readonly string[], costs: readonly number[], cap: number, codePointCost: (cp: string) => number): string[][] {
  const parts: string[][] = [];
  let cur: string[] = [];
  let fill = 0;
  const put = (piece: string, cost: number): void => {
    if (fill + cost > cap && cur.length > 0) {
      parts.push(cur);
      cur = [];
      fill = 0;
    }
    cur.push(piece);
    fill += cost;
  };
  atoms.forEach((a, i) => {
    const cost = costs[i]!;
    if (cost <= cap) put(a, cost);
    else for (const cp of a) put(cp, codePointCost(cp));
  });
  if (cur.length > 0) parts.push(cur);
  return parts;
}

function countParts(units: number, costs: readonly number[], atoms: readonly string[], single: number, multi: number, cpCost: (cp: string) => number): { parts: string[][]; perPart: number } {
  if (units === 0) return { parts: [], perPart: single };
  if (units <= single) return { parts: [atoms.slice()], perPart: single };
  return { parts: pack(atoms, costs, multi, cpCost), perPart: multi };
}

function plan(text: string, opts?: SmsOptions): Plan {
  const multi = MULTI[opts?.sender ?? 'local'];
  const gs = smsGraphemes(text);
  const gsm = gs.map(gsm7Cost);
  const special: string[] = [];
  const seen = new Set<string>();
  gs.forEach((g, i) => {
    if (gsm[i] === 0 && !seen.has(g)) {
      seen.add(g);
      special.push(g);
    }
  });
  // a GSM-7 grapheme is always one character, so it is never over-long; code-point cost is only used for UCS-2
  const gsmCosts = gsm.map((c) => (c === 0 ? 1 : c));
  const gsmUnits = gsmCosts.reduce((a, b) => a + b, 0);
  const gsmPlan = countParts(gsmUnits, gsmCosts, gs, SINGLE.gsm7, multi.gsm7, () => 1);
  if (special.length === 0) {
    return { encoding: 'gsm7', units: gsmUnits, perPart: gsmPlan.perPart, parts: gsmPlan.parts, special, gsmParts: gsmPlan.parts.length };
  }
  const ucsCosts = gs.map((g) => g.length);
  const ucsUnits = text.length;
  const ucsPlan = countParts(ucsUnits, ucsCosts, gs, SINGLE.ucs2, multi.ucs2, (cp) => cp.length);
  return { encoding: 'ucs2', units: ucsUnits, perPart: ucsPlan.perPart, parts: ucsPlan.parts, special, gsmParts: gsmPlan.parts.length };
}

/** Encoding, part count and the characters that forced UCS-2 for one SMS text. */
export function smsSegments(text: string, opts?: SmsOptions): SmsSegments {
  const p = plan(text, opts);
  return {
    encoding: p.encoding,
    parts: p.parts.length,
    units: p.units,
    perPart: p.perPart,
    special: p.special,
    gsmParts: p.gsmParts,
    tooLong: text.length > SMS_TEXT_MAX_UNITS,
  };
}

/** The text of each part, as smsSegments packs it (parts.join('') === text). */
export function splitParts(text: string, opts?: SmsOptions): string[] {
  return plan(text, opts).parts.map((p) => p.join(''));
}
