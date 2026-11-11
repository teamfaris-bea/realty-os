// Small, deterministic wording helpers for feed reasons and exception evidence. Labels never carry a
// client's name, number or address; relative times are computed from the injected `now`.
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../foundation/index.js';
import type { PhoneEmailChannel as Channel } from '../compliance/index.js'; // Phase 1 channels
import type { ForeignFeedItemType } from './types.js';

/** "less than a minute", "12 min", "5 h" (under 48 h), "3 d". Negative values count as 0. */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  const m = Math.floor(v / MINUTE_MS);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(v / HOUR_MS);
  if (h < 48) return `${h} h`;
  return `${Math.floor(v / DAY_MS)} d`;
}

export function ago(now: number, t: number): string {
  return `${formatDuration(now - t)} ago`;
}

export function inFuture(now: number, t: number): string {
  return `in ${formatDuration(t - now)}`;
}

/** Trims to `max` characters on a word boundary where possible, with an ellipsis. */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * How scoreFeed words relative times and free text in reason labels (lane perf-misses). `textLabels(now)`
 * is the plain wording; `templateLabels` writes a token per relative time instead, so a stored card can be
 * re-worded for the instant it is read (renderFeedLabel). Free text (sources, notes, evidence, gate
 * explanations) goes through `text`, which in template mode escapes the token marker, so no client or
 * assistant text can forge a token.
 */
export interface LabelFormat {
  /** "12 min ago" for an instant in the past */
  ago(t: number): string;
  /** "in 12 min" for an instant in the future */
  in(t: number): string;
  /** "12 min": the time since `t` */
  since(t: number): string;
  /** clip(s, max) */
  text(s: string, max: number): string;
}

export function textLabels(now: number): LabelFormat {
  return { ago: (t) => ago(now, t), in: (t) => inFuture(now, t), since: (t) => formatDuration(now - t), text: clip };
}

/** U+F8F0 (private use): starts a token ("\uF8F0a<ms>;" ago, "i" in, "s" since); doubled, it is a literal. */
const MARK = '\uF8F0';

export const templateLabels: LabelFormat = {
  ago: (t) => `${MARK}a${Math.trunc(t)};`,
  in: (t) => `${MARK}i${Math.trunc(t)};`,
  since: (t) => `${MARK}s${Math.trunc(t)};`,
  text: (s, max) => clip(s, max).split(MARK).join(MARK + MARK),
};

/** Renders a templateLabels label for the instant `now`: the exact words textLabels(now) would give. */
export function renderFeedLabel(label: string, now: number): string {
  if (!label.includes(MARK)) return label;
  let out = '';
  let i = 0;
  while (i < label.length) {
    const k = label.indexOf(MARK, i);
    if (k < 0) {
      out += label.slice(i);
      break;
    }
    out += label.slice(i, k);
    const kind = label[k + 1];
    if (kind === MARK) {
      out += MARK;
      i = k + 2;
      continue;
    }
    const end = label.indexOf(';', k + 2);
    const t = end < 0 ? NaN : Number(label.slice(k + 2, end));
    if (end < 0 || !Number.isFinite(t) || (kind !== 'a' && kind !== 'i' && kind !== 's')) {
      // not a token this module wrote: keep the text as it is
      out += label.slice(k, k + 1);
      i = k + 1;
      continue;
    }
    out += kind === 'a' ? ago(now, t) : kind === 'i' ? inFuture(now, t) : formatDuration(now - t);
    i = end + 1;
  }
  return out;
}

export const CHANNEL_VERB: Record<Channel, string> = { sms: 'text', voice: 'call', email: 'email' };

/**
 * The card heading of each Phase 2/3 card type (module 18a). Plain words for what the owning module
 * put on the card; never a number, a band or a model's name (R-AST-13: no confidence anywhere).
 */
export const FOREIGN_CARD_LABEL: Readonly<Record<ForeignFeedItemType, string>> = {
  seller_update: 'Seller update to review',
  marketing_review: 'Marketing to review',
  weekly_plan: 'Your plan this week',
  coaching_fix: "Today's coaching tip",
  likely_to_move: 'May be thinking of moving',
};
