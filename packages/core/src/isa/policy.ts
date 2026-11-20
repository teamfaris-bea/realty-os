// The team AI policy for people to read, edit and approve (R-ISA-33, R-ISA-34; docs/AI_ISA.md §3.2). Pure words and
// lists over `AiIsaContent`; nothing here decides what the assistant may do: `validateAiIsaContent` and
// `narrowsPrevious` (./content.ts) stay the only judges, and policy.test.ts holds this file to them.
// - AI_ISA_POLICY_FIELDS: one entry per value of the content, with the bounds the validator enforces (the same
//   constants). The web builds its edit form from this list.
// - policySections: the policy in plain words, what the assistant may and may not do, by section.
// - policyDiff: what a version adds, removes and changes against another, field by field from the comparison's own
//   verdicts (content.ts policyFieldChange); `wider` is `!narrowsPrevious`.
// - the texts an approver or a revoker accepts, versioned (Q2: served by the server, never a web constant).
// Every default and ceiling is an engineering default. VERIFY WITH COUNSEL.
import { ISA_CADENCES, ISA_PACK_CEILING } from './constants.js';
import { AI_ISA_FIELD_WIDENS, type AiIsaContent, type AiIsaContentIssue, type AiIsaFieldKey, narrowsPrevious, policyFieldChanges } from './content.js';
import { ISA_CAPABILITIES } from './types.js';

/**
 * Bump when any sentence of the approval or revoke text changes; stored inside each text. /2 (b19 review): the wider
 * approval also covers a change nothing can rank (R-ISA-38), and the revoke says what may still be sent (R-ISA-42).
 */
export const AI_ISA_POLICY_TEXT_VERSION = 'ai_isa.policy_attestation/2';

export const AI_ISA_POLICY_SECTIONS = [
  { key: 'does', title: 'What it may do' },
  { key: 'when', title: 'When it may write' },
  { key: 'howOften', title: 'How often' },
  { key: 'howLong', title: 'How long it keeps trying' },
  { key: 'booking', title: 'Appointments' },
  { key: 'words', title: 'Its words' },
] as const;
export type PolicySectionKey = (typeof AI_ISA_POLICY_SECTIONS)[number]['key'];

export interface PolicyField {
  /** the dotted path: the id a form, an issue, a diff and a comparison rule all use (content.ts AiIsaFieldKey) */
  key: AiIsaFieldKey;
  path: readonly string[];
  section: PolicySectionKey;
  /** options: any of several; choice: exactly one; toggle: yes or no; int: a whole number; time: seconds after midnight, to the minute; text */
  kind: 'options' | 'choice' | 'toggle' | 'int' | 'time' | 'text';
  label: string;
  help?: string;
  options?: readonly { value: string | number; label: string }[];
  /** values that cannot be changed (converse is required; holidays stay excluded) */
  locked?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  unit?: string;
  maxLength?: number;
}

const CAP: Record<(typeof ISA_CAPABILITIES)[number], { may: string; does: string }> = {
  converse: { may: 'talk with leads by text and email', does: 'talks with leads by text and email' },
  share_listings: { may: 'share listings that fit their search', does: 'shares listings that fit their search' },
  propose_saved_search: { may: 'suggest a saved search for the agent to approve', does: 'suggests a saved search for the agent to approve' },
  seller_competition: { may: 'share competing listings with sellers', does: 'shares competing listings with sellers' },
  seller_sold_comps: { may: 'share recent sales with sellers', does: 'shares recent sales with sellers' },
  book_appointments: { may: 'propose appointment times and book them on the agent’s calendar', does: 'proposes appointment times and books them on the agent’s calendar' },
};
const CHANNEL: Record<string, string> = { sms: 'text', email: 'email' };
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KIND: Record<string, string> = { buyer_consult: 'a buyer consultation', listing_appointment: 'a listing appointment', consult: 'a general consultation' };
const LINE: Record<string, string> = { pricing_negotiation: 'price questions', financial: 'money questions', data_unavailable: 'facts it cannot check', booking_unavailable: 'times it cannot offer' };
const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}`);
const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
const every = (c: string) => `every ${n(Number(c.replace('d', '')), 'day')}`;

/** 9:00 AM, 8:00 PM: seconds after local midnight in words. */
export function policyClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 && h < 24 ? 'PM' : 'AM'}`;
}

const C = ISA_PACK_CEILING;
const int = (key: AiIsaFieldKey, section: PolicySectionKey, label: string, min: number, max: number, unit: string, help?: string): PolicyField => ({ key, path: key.split('.'), section, kind: 'int', label, min, max, unit, ...(help ? { help } : {}) });
const line = (cls: keyof AiIsaContent['holdingLines']): PolicyField => ({ key: `holdingLines.${cls}`, path: ['holdingLines', cls], section: 'words', kind: 'text', label: `The line it uses for ${LINE[cls]!}`, help: 'Optional. 10 to 240 characters. Left empty, the platform’s own line is used.', maxLength: 240 });

/**
 * One entry per value of `AiIsaContent` (policy.test.ts: exactly the content's leaves). The bounds are the validator's:
 * the schema's range cut to the pack ceiling. Two rules join two fields and are not bounds of one: the window's end is
 * after its start, and "slower after" is not above "stops after".
 */
export const AI_ISA_POLICY_FIELDS: readonly PolicyField[] = Object.freeze([
  { key: 'capabilities', path: ['capabilities'], section: 'does', kind: 'options', label: 'What the assistant may do', options: ISA_CAPABILITIES.map((c) => ({ value: c, label: up(CAP[c].may) })), locked: ['converse'],
    help: 'Each agent then chooses, in their own opt-in, which of these to use for their leads.' },
  { key: 'channels', path: ['channels'], section: 'does', kind: 'options', label: 'How it may write', options: [{ value: 'sms', label: 'By text' }, { value: 'email', label: 'By email' }], help: 'At least one.' },
  { key: 'window.startSec', path: ['window', 'startSec'], section: 'when', kind: 'time', label: 'Earliest time it writes, in the person’s own time', min: C.window.startSec, max: C.window.endSec - 60 },
  { key: 'window.endSec', path: ['window', 'endSec'], section: 'when', kind: 'time', label: 'Latest time it writes, in the person’s own time', min: C.window.startSec + 60, max: C.window.endSec },
  { key: 'initiatedDays', path: ['initiatedDays'], section: 'when', kind: 'options', label: 'Days it may start a follow-up', options: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: d, label: DAY[d]! })),
    help: 'A reply to the person’s own message may go on any day, inside the hours above.' },
  { key: 'noInitiatedOnHolidays', path: ['noInitiatedOnHolidays'], section: 'when', kind: 'toggle', label: 'No follow-ups on US federal holidays', locked: [true], help: 'Always on.' },
  int('caps.ai24h', 'howOften', 'AI messages per person in 24 hours', 0, C.caps.ai24h, 'messages'),
  int('caps.automated24h', 'howOften', 'Automated messages of any kind per person in 24 hours, above which the assistant waits', 0, C.caps.automated24h, 'messages'),
  int('caps.initiated24h', 'howOften', 'Follow-ups it starts per person in 24 hours', 0, C.caps.initiated24h, 'follow-ups'),
  int('caps.initiated7d', 'howOften', 'Follow-ups it starts per person in 7 days', 0, C.caps.initiated7d, 'follow-ups'),
  int('caps.minGapSeconds', 'howOften', 'Shortest gap between two AI messages', C.caps.minGapSeconds, 86_400, 'seconds'),
  { key: 'cadence', path: ['cadence'], section: 'howOften', kind: 'choice', label: 'How often it follows up when they do not answer', options: ISA_CADENCES.map((c) => ({ value: c, label: up(every(c)) })) },
  int('limits.maxMessagesPerAssignment', 'howLong', 'Most AI messages to one person', 1, C.maxMessagesPerAssignment, 'messages'),
  int('limits.maxDays', 'howLong', 'Most days of AI care for one person', 1, C.maxDays, 'days'),
  int('limits.slowAfterUnanswered', 'howLong', 'Follows up more slowly after this many unanswered follow-ups', 1, 100, 'follow-ups', 'Not above the number below.'),
  int('limits.dormantAfterUnanswered', 'howLong', 'Stops and hands back after this many unanswered follow-ups', 1, 100, 'follow-ups'),
  int('readiness.timelineDays', 'howLong', 'Hands a lead back as ready when they plan to move within', 1, C.readinessTimelineDays, 'days'),
  { key: 'booking.kinds.buyer', path: ['booking', 'kinds', 'buyer'], section: 'booking', kind: 'options', label: 'Appointments it may propose to buyers', options: [{ value: 'buyer_consult', label: up(KIND.buyer_consult!) }, { value: 'consult', label: up(KIND.consult!) }],
    help: 'Used only when "propose appointment times" is allowed above and the agent turned it on.' },
  { key: 'booking.kinds.seller', path: ['booking', 'kinds', 'seller'], section: 'booking', kind: 'options', label: 'Appointments it may propose to sellers', options: [{ value: 'listing_appointment', label: up(KIND.listing_appointment!) }, { value: 'consult', label: up(KIND.consult!) }] },
  int('booking.durationMinutes', 'booking', 'Length of an appointment', 15, C.booking.durationMinutesMax, 'minutes'),
  int('booking.minNoticeHours', 'booking', 'Shortest notice before an appointment', C.booking.minNoticeHoursFloor, 168, 'hours'),
  int('booking.horizonDays', 'booking', 'How far ahead it may propose a time', 1, C.booking.horizonDaysMax, 'days'),
  int('booking.bufferMinutes', 'booking', 'Free time kept around an appointment', C.booking.bufferMinutesFloor, 240, 'minutes'),
  line('pricing_negotiation'),
  line('financial'),
  line('data_unavailable'),
  line('booking_unavailable'),
  { key: 'tone', path: ['tone'], section: 'words', kind: 'text', label: 'A sample of the team’s tone', help: 'Optional. Up to 500 characters. The assistant’s introduction and sign-off are fixed by the platform and always say it is an AI assistant.', maxLength: 500 },
]);

export function policyFieldValue(content: AiIsaContent, f: Pick<PolicyField, 'path'>): unknown {
  let at: unknown = content;
  for (const k of f.path) at = at === null || typeof at !== 'object' ? undefined : (at as Record<string, unknown>)[k];
  return at;
}

/** A copy of `content` with one field set (an empty text clears an optional line). */
export function setPolicyField(content: AiIsaContent, f: Pick<PolicyField, 'path'>, value: unknown): AiIsaContent {
  const clear = f.path[0] === 'holdingLines' && (value === '' || value === undefined || value === null);
  const set = (o: Record<string, unknown>, path: readonly string[]): Record<string, unknown> => {
    const [k, ...rest] = path as [string, ...string[]];
    if (rest.length > 0) return { ...o, [k]: set((o[k] ?? {}) as Record<string, unknown>, rest) };
    if (!clear) return { ...o, [k]: value };
    const { [k]: _gone, ...kept } = o;
    return kept;
  };
  return set(content as unknown as Record<string, unknown>, f.path) as unknown as AiIsaContent;
}

// ---- field-level reasons -------------------------------------------------------------------------------------------

export interface PolicyIssueWords {
  code: string;
  /** a field key of AI_ISA_POLICY_FIELDS, or null when the issue is not about one value */
  field: string | null;
  sentence: string;
}

const fieldOf = (key: string) => AI_ISA_POLICY_FIELDS.find((f) => f.key === key);
const atMost = (key: string) => `At most ${fieldOf(key)?.max}: the platform’s limit.`;
const atLeast = (key: string) => `At least ${fieldOf(key)?.min}: the platform’s limit.`;

/** One validator issue as the field it is about and a sentence a person can act on. No code is ever shown. */
export function policyIssueWords(issue: AiIsaContentIssue, content?: unknown): PolicyIssueWords {
  const d = issue.detail ?? '';
  const w = (field: string | null, sentence: string): PolicyIssueWords => ({ code: issue.code, field, sentence });
  const c = (content ?? null) as Partial<AiIsaContent> | null;
  switch (issue.code) {
    case 'CAPABILITY_NOT_AVAILABLE': return w('capabilities', 'Value estimates and market statistics are not available to the assistant.');
    case 'CAPABILITY_UNKNOWN': return w('capabilities', 'One of the choices is not something the assistant can do.');
    case 'CONVERSE_REQUIRED': return w('capabilities', 'Talking with leads is always part of the policy.');
    case 'DUPLICATE': return w(null, 'A choice is listed twice.');
    case 'WINDOW_INVALID': return w('window.endSec', 'The latest time must be after the earliest time.');
    case 'WINDOW_ABOVE_CEILING':
      return (c?.window?.startSec ?? C.window.startSec) < C.window.startSec ? w('window.startSec', `No earlier than ${policyClock(C.window.startSec)}: the platform’s limit.`) : w('window.endSec', `No later than ${policyClock(C.window.endSec)}: the platform’s limit.`);
    case 'HOLIDAYS_REQUIRED': return w('noInitiatedOnHolidays', 'Follow-ups on US federal holidays cannot be turned on.');
    case 'CAP_ABOVE_CEILING': return w(`caps.${d}`, atMost(`caps.${d}`));
    case 'GAP_BELOW_CEILING': return w('caps.minGapSeconds', atLeast('caps.minGapSeconds'));
    case 'LIMIT_ABOVE_CEILING': return d === 'slowAfterUnanswered' ? w('limits.slowAfterUnanswered', 'Not above the number of unanswered follow-ups after which it stops.') : w(`limits.${d}`, atMost(`limits.${d}`));
    case 'READINESS_ABOVE_CEILING': return w('readiness.timelineDays', atMost('readiness.timelineDays'));
    case 'BOOKING_ABOVE_CEILING': return d === 'minNoticeHours' || d === 'bufferMinutes' ? w(`booking.${d}`, atLeast(`booking.${d}`)) : w(`booking.${d}`, atMost(`booking.${d}`));
    case 'LINE_GUARD': return w(`holdingLines.${d}`, 'This line cannot be used: it reads as a person, promises something, or touches a protected topic. Reword it.');
    case 'TONE_GUARD': return w('tone', 'This sample cannot be used: it touches a protected topic. Reword it.');
    case 'CONTENT_KIND_MISMATCH': return w(null, 'This is not an AI assistant policy.');
    case 'SCHEMA': {
      const f = [...AI_ISA_POLICY_FIELDS].sort((a, b) => b.key.length - a.key.length).find((x) => d === x.key || d.startsWith(`${x.key}.`));
      if (!f) return w(null, 'The policy has a value the assistant does not know, or one is missing.');
      if (f.kind === 'int') return w(f.key, `Enter a whole number from ${f.min} to ${f.max}.`);
      if (f.kind === 'time') return w(f.key, `Enter a time from ${policyClock(f.min!)} to ${policyClock(f.max!)}.`);
      if (f.kind === 'text') return w(f.key, f.path[0] === 'holdingLines' ? 'Use 10 to 240 characters, or leave it empty.' : `Use at most ${f.maxLength} characters.`);
      if (f.key === 'channels' || f.key === 'capabilities') return w(f.key, 'Choose at least one.');
      return w(f.key, 'This value is not one of the choices.');
    }
  }
}

// ---- the policy in words -------------------------------------------------------------------------------------------

export interface PolicySectionWords {
  key: PolicySectionKey;
  title: string;
  may: string[];
  mayNot: string[];
}

/** The policy in plain words: what the assistant may and may not do, by section. */
export function policySections(c: AiIsaContent): PolicySectionWords[] {
  const has = (cap: string) => c.capabilities.includes(cap);
  const offDays = [1, 2, 3, 4, 5, 6, 7].filter((d) => !c.initiatedDays.includes(d)).map((d) => DAY[d]!);
  const noStart = [...(offDays.length > 0 ? [`on ${list(offDays).replace(/ and /, ' or ')}`] : []), ...(c.noInitiatedOnHolidays ? ['on a US federal holiday'] : [])];
  const book = has('book_appointments');
  const kinds = (xs: readonly string[]) => list(xs.map((k) => KIND[k] ?? 'an appointment')).replace(/ and /, ' or ');
  const lines = Object.entries(c.holdingLines).filter(([, v]) => v !== undefined);
  const out: Record<PolicySectionKey, { may: string[]; mayNot: string[] }> = {
    does: {
      may: [...ISA_CAPABILITIES.filter(has).map((k) => `${up(CAP[k].may)}.`), `Write by ${list(c.channels.map((x) => CHANNEL[x]!))}.`],
      mayNot: [...ISA_CAPABILITIES.filter((k) => !has(k)).map((k) => `${up(CAP[k].may)}.`), ...(['sms', 'email'] as const).filter((x) => !c.channels.includes(x)).map((x) => `Write by ${CHANNEL[x]}.`),
        'Give value estimates or market statistics (not available to the assistant).'],
    },
    when: {
      may: [`Write between ${policyClock(c.window.startSec)} and ${policyClock(c.window.endSec)} in the person’s own time.`,
        c.initiatedDays.length > 0 ? `Start a follow-up on ${list([...c.initiatedDays].sort((a, b) => a - b).map((d) => DAY[d]!))}.` : 'Reply to the person’s own message; it starts no follow-up of its own.'],
      mayNot: [`Write before ${policyClock(c.window.startSec)} or after ${policyClock(c.window.endSec)}, replies included.`, ...(noStart.length > 0 ? [`Start a follow-up ${noStart.join(' or ')}.`] : [])],
    },
    howOften: {
      may: [`Send up to ${n(c.caps.ai24h, 'AI message')} to one person in 24 hours.`, `Start up to ${n(c.caps.initiated24h, 'follow-up')} in 24 hours and ${c.caps.initiated7d} in 7 days.`, `Follow up ${every(c.cadence)} when they do not answer.`],
      mayNot: [`Write again within ${n(c.caps.minGapSeconds, 'second')} of its last message.`, `Write while the person has had ${n(c.caps.automated24h, 'automated message')} of any kind in 24 hours.`],
    },
    howLong: {
      may: [`Keep one person in AI care for up to ${n(c.limits.maxDays, 'day')} and ${n(c.limits.maxMessagesPerAssignment, 'message')}.`, `Hand a lead back as ready when they plan to move within ${n(c.readiness.timelineDays, 'day')}.`],
      mayNot: [`Keep its pace after ${n(c.limits.slowAfterUnanswered, 'unanswered follow-up')}: it slows down.`, `Go on after ${n(c.limits.dormantAfterUnanswered, 'unanswered follow-up')}: it stops and hands back.`],
    },
    booking: book
      ? {
          may: [...(c.booking.kinds.buyer.length > 0 ? [`Propose ${kinds(c.booking.kinds.buyer)} to a buyer.`] : []), ...(c.booking.kinds.seller.length > 0 ? [`Propose ${kinds(c.booking.kinds.seller)} to a seller.`] : []),
            `Propose times of ${n(c.booking.durationMinutes, 'minute')}, up to ${n(c.booking.horizonDays, 'day')} ahead.`],
          mayNot: [`Propose a time less than ${n(c.booking.minNoticeHours, 'hour')} away.`, `Book within ${n(c.booking.bufferMinutes, 'minute')} of something else on the agent’s calendar.`, 'Book for an agent who did not turn booking on or whose calendar is not connected.'],
        }
      : { may: [], mayNot: ['Propose or book appointments.'] },
    words: {
      may: [...(lines.length > 0 ? [`Use the team’s own line for ${list(lines.map(([k]) => LINE[k] ?? 'another topic'))}.`] : []), ...(c.tone.trim() !== '' ? ['Follow the team’s tone sample.'] : [])],
      mayNot: ['Change its introduction or sign-off: the platform fixes them, and they always say it is an AI assistant.'],
    },
  };
  return AI_ISA_POLICY_SECTIONS.map((s) => ({ key: s.key, title: s.title, ...out[s.key] }));
}

// ---- the diff ------------------------------------------------------------------------------------------------------

export interface PolicyDiff {
  /** each change that lets the assistant do more */
  adds: string[];
  /** each change that lets it do less */
  removes: string[];
  /**
   * each change nothing here can rank as more or less (the ready-within days, the length of an appointment, the team's
   * own words, a field this code does not know): every one of them makes the version wider, so agents re-confirm
   */
  changes: string[];
  /** `!narrowsPrevious(prev, next)`: approving `next` over `prev` pauses AI care until each agent re-confirms */
  wider: boolean;
}

/** One sentence for a changed value (`next` against `prev`), or the two sentences of a list of choices. */
type DiffWords = ((prev: never, next: never) => string) | { add(x: never): string; remove(x: never): string };

const isCap = (x: string): x is keyof typeof CAP => Object.hasOwn(CAP, x);
/** `up` when the number rose, `down` when it fell; each gets the new value and the old one in words */
const num = (up: (v: string, was: string) => string, down: (v: string, was: string) => string, say: (v: number) => string = String) => (a: number, b: number) => (b > a ? up : down)(say(b), say(a));
const count = (what: string) => num((v, was) => `up to ${v} ${what} (was ${was})`, (v, was) => `at most ${v} ${what} (was ${was})`);
const reworded = (cls: keyof typeof LINE) => () => `has a different line for ${LINE[cls]}`;

/**
 * The words of every field's change. A map over `AiIsaFieldKey`, like the comparison rules: a field with no words does
 * not compile. Which list a sentence lands in is NOT decided here: policyDiff takes it from the comparison's verdict.
 */
const DIFF_WORDS: { readonly [K in AiIsaFieldKey]: DiffWords } = {
  capabilities: { add: (x: string) => (isCap(x) ? `may ${CAP[x].may}` : 'may do one more thing'), remove: (x: string) => (isCap(x) ? `no longer ${CAP[x].does}` : 'no longer does one thing') },
  channels: { add: (x: string) => `may write by ${CHANNEL[x] ?? 'another channel'}`, remove: (x: string) => `no longer writes by ${CHANNEL[x] ?? 'one channel'}` },
  'window.startSec': num((v, was) => `writes no earlier than ${v} (was ${was})`, (v, was) => `may write from ${v} (was ${was})`, policyClock),
  'window.endSec': num((v, was) => `may write until ${v} (was ${was})`, (v, was) => `writes no later than ${v} (was ${was})`, policyClock),
  initiatedDays: { add: (x: number) => `may start follow-ups on ${DAY[x] ?? 'one more day'}`, remove: (x: number) => `no longer starts follow-ups on ${DAY[x] ?? 'one day'}` },
  noInitiatedOnHolidays: (_a: boolean, b: boolean) => (b ? 'no longer starts follow-ups on US federal holidays' : 'may start follow-ups on US federal holidays'),
  'caps.ai24h': count('AI messages per person in 24 hours'),
  'caps.automated24h': count('automated messages of any kind per person in 24 hours before it waits'),
  'caps.initiated24h': count('follow-ups it starts per person in 24 hours'),
  'caps.initiated7d': count('follow-ups it starts per person in 7 days'),
  'caps.minGapSeconds': num((v, was) => `waits at least ${v} seconds between messages (was ${was})`, (v, was) => `may write again after ${v} seconds (was ${was})`),
  cadence: (a: string, b: string) => `follows up ${every(b)} (was ${every(a)})`,
  'limits.maxMessagesPerAssignment': count('AI messages to one person'),
  'limits.maxDays': count('days of AI care for one person'),
  'limits.slowAfterUnanswered': num((v, was) => `keeps its pace for ${v} unanswered follow-ups (was ${was})`, (v, was) => `slows down after ${v} unanswered follow-ups (was ${was})`),
  'limits.dormantAfterUnanswered': num((v, was) => `goes on for ${v} unanswered follow-ups (was ${was})`, (v, was) => `stops after ${v} unanswered follow-ups (was ${was})`),
  // either direction, one sentence: fewer days keeps more people in AI care, more days hands back sooner (Q-ISA-46)
  'readiness.timelineDays': (a: number, b: number) => `treats a move within ${b} days as ready (was ${a})`,
  'booking.kinds.buyer': { add: (x: string) => `may propose ${KIND[x] ?? 'another appointment'} to buyers`, remove: (x: string) => `no longer proposes ${KIND[x] ?? 'one appointment'} to buyers` },
  'booking.kinds.seller': { add: (x: string) => `may propose ${KIND[x] ?? 'another appointment'} to sellers`, remove: (x: string) => `no longer proposes ${KIND[x] ?? 'one appointment'} to sellers` },
  'booking.minNoticeHours': num((v, was) => `proposes times at least ${v} hours away (was ${was})`, (v, was) => `may propose times ${v} hours away (was ${was})`),
  'booking.horizonDays': num((v, was) => `may propose times up to ${v} days ahead (was ${was})`, (v, was) => `proposes times at most ${v} days ahead (was ${was})`),
  'booking.bufferMinutes': num((v, was) => `keeps ${v} minutes free around an appointment (was ${was})`, (v, was) => `may book ${v} minutes from something else (was ${was})`),
  'booking.durationMinutes': (a: number, b: number) => `appointments of ${b} minutes (was ${a})`,
  'holdingLines.pricing_negotiation': reworded('pricing_negotiation'),
  'holdingLines.financial': reworded('financial'),
  'holdingLines.data_unavailable': reworded('data_unavailable'),
  'holdingLines.booking_unavailable': reworded('booking_unavailable'),
  tone: () => 'has a different tone sample',
};

const UNKNOWN_CHANGE = 'changes a setting this version of the app cannot compare';

/**
 * What `next` changes against `prev` (the approved version), in words. Each field's verdict is the comparison's own
 * (content.ts policyFieldChanges), so the lists cannot disagree with `wider`: a field ranked wider is under `adds`, or
 * under `changes` when its rule is "any change" or the field is not known; one ranked narrower is under `removes`
 * (policy.test.ts holds the sentences to that). With no `prev` there is nothing to compare: a first version pauses nothing.
 */
export function policyDiff(prev: AiIsaContent | null, next: AiIsaContent): PolicyDiff {
  const d: PolicyDiff = { adds: [], removes: [], changes: [], wider: false };
  if (prev === null) return d;
  const lists = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
  for (const c of policyFieldChanges(prev, next)) {
    if (!c.known) {
      if (!d.changes.includes(UNKNOWN_CHANGE)) d.changes.push(UNKNOWN_CHANGE);
      continue;
    }
    const key = c.key as AiIsaFieldKey;
    const words = DIFF_WORDS[key];
    const [a, b] = [policyFieldValue(prev, { path: key.split('.') }), policyFieldValue(next, { path: key.split('.') })];
    if (typeof words !== 'function') {
      if (!Array.isArray(a) || !Array.isArray(b)) d.changes.push(UNKNOWN_CHANGE);
      for (const x of lists(b)) if (!lists(a).includes(x)) d.adds.push(words.add(x as never));
      for (const x of lists(a)) if (!lists(b).includes(x)) d.removes.push(words.remove(x as never));
    } else (c.change === 'narrower' ? d.removes : AI_ISA_FIELD_WIDENS[key] === 'any' ? d.changes : d.adds).push(words(a as never, b as never));
  }
  d.wider = !narrowsPrevious(prev, next);
  return d;
}

// ---- what the approver accepts -------------------------------------------------------------------------------------

/** first: nothing was approved before. after_revoke: the last approved version was revoked, so care stays paused. */
export type PolicyApprovalEffect = 'first' | 'wider' | 'narrower' | 'after_revoke';

/**
 * The exact text an Owner accepts to approve a version (stored in `playbook_approvals.attestation`; the server
 * rebuilds it and refuses any other). It names the version and its content hash, and says what approving does.
 */
export function aiIsaPolicyApprovalText(i: { versionNo: number; contentSha256: string; effect: PolicyApprovalEffect }): string {
  const effect = i.effect === 'wider' ? ' It lets the assistant do more than the approved version, or changes a rule each agent must agree to again, so AI care pauses for every lead until each agent re-confirms.'
    : i.effect === 'narrower' ? ' It lets the assistant do no more than the approved version, so AI care continues under it at once.'
    : i.effect === 'after_revoke' ? ' The last approved version was revoked, so AI care stays paused for every lead until each agent re-confirms.' : '';
  return `I approve version ${i.versionNo} of the team's AI assistant policy (content ${i.contentSha256}).${effect} Its consent, quiet-hours and frequency limits are engineering defaults that counsel has not reviewed, and I accept responsibility for that. [${AI_ISA_POLICY_TEXT_VERSION}]`;
}

/** The exact text an Owner or Admin accepts to revoke the approved version. */
export function aiIsaPolicyRevokeText(i: { versionNo: number; contentSha256: string }): string {
  return `I revoke version ${i.versionNo} of the team's AI assistant policy (content ${i.contentSha256}). AI care pauses for every lead at once, and nothing more is sent by the assistant until a new version is approved and each agent re-confirms. [${AI_ISA_POLICY_TEXT_VERSION}]`;
}
