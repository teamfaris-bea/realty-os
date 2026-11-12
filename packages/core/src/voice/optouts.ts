// What the session may promise a caller who opted out before, or opts out now (E112, R-PAR-12,
// R-GATE-14, D1, D-OPTOUT-LANG).
//
// The caller called, so the call is answered whatever their opt-outs (E112). What changes is what
// the assistant offers: no phone callback when voice is opted out on ANY of the person's phones
// (removed ones that still count included, R-PAR-12), a phone of theirs is suppressed for voice, or
// the person is do-not-contact; and a confirmation only on a channel the opt-out facts allow
// (reachability plus the person-level do-not-contact). An opt-out heard in this call withdraws both.
// Core never sends: module 48 sends through dispatchOutbound, whose canContact decides again.
import { optedOut, pointBlocks } from '../compliance/index.js';
import type { HeardOptOut } from './state.js';
import type { OptOutFacts } from './types.js';

function phoneHmacs(o: OptOutFacts): Set<string> {
  return new Set([...o.reach.points.filter((p) => p.kind === 'phone').map((p) => p.addressHmac), ...(o.reach.removedPhoneHmacs ?? [])]);
}

/** Voice opted out on any of the person's phones, removed ones that still count included. */
export function voiceOptedOutAnyPhone(o: OptOutFacts): boolean {
  const hmacs = phoneHmacs(o);
  return optedOut(o.reach.consent.filter((r) => r.channel === 'voice' && hmacs.has(r.addressHmac)), 'voice', 'informational', '');
}

/** Whether the assistant may offer a phone callback (E112). */
export function phoneCallbackAllowed(o: OptOutFacts, heard: HeardOptOut | null): boolean {
  if (heard !== null || o.personDoNotContact || voiceOptedOutAnyPhone(o)) return false;
  const blocks = o.reach.points.filter((p) => p.kind === 'phone').map((p) => pointBlocks(o.reach, p, 'voice', 'informational'));
  if (blocks.some((b) => b.some((x) => x.reason === 'SUPPRESSED'))) return false;
  return blocks.some((b) => b.length === 0);
}

/** The one channel a confirmation may be promised on: a text, else an email, else none. */
export function confirmationChannel(o: OptOutFacts, heard: HeardOptOut | null): 'sms' | 'email' | null {
  if (heard !== null || o.personDoNotContact) return null;
  for (const channel of ['sms', 'email'] as const) {
    const kind = channel === 'sms' ? 'phone' : 'email';
    if (o.reach.points.some((p) => p.kind === kind && pointBlocks(o.reach, p, channel, 'informational').length === 0)) return channel;
  }
  return null;
}
