// Small, deterministic wording helpers for feed reasons and exception evidence. Labels never carry a
// client's name, number or address; relative times are computed from the injected `now`.
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../foundation/index.js';
import type { Channel } from '../compliance/index.js';

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

export const CHANNEL_VERB: Record<Channel, string> = { sms: 'text', voice: 'call', email: 'email' };
