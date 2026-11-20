// The team AI ISA policy content (R-ISA-1 link 4; E524; docs/AI_ISA.md §3.2). Stored as the one `AiIsaContent` of
// an `ai_isa` playbook version (`{ kind: 'ai_isa', aiIsa }`, core/assistant content.ts), hashed with
// `contentSha256`. A strict Zod schema; every value is validated against the `platform:ai_isa` pack ceilings at
// approval AND again at send (`validateAiIsaContent`). The AI disclosure and sign-off are NOT team content: they
// are platform constants (./lines.ts). `narrowsPrevious` is computed at approval and stored as
// `playbook_versions.narrows_previous` (kind ai_isa only): narrowing-only successors keep assignments running. It is
// one rule per field (AI_ISA_FIELD_WIDENS, keyed by the content type's own leaves): a field with no rule does not
// compile and, at run time, compares as wider (R-ISA-38).
import { z } from 'zod';
import { contentGuard, type IdentityFacts, storedContent } from '../assistant/index.js';
import { DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack, guardAssistantOutput } from '../fairhousing/index.js';
import {
  CADENCE_MS,
  ISA_BOOKING_DEFAULTS,
  ISA_CADENCES,
  ISA_DEFAULT_CAPS,
  ISA_DEFAULT_INITIATED_DAYS,
  ISA_DEFAULT_LIMITS,
  ISA_DEFAULT_WINDOW,
  ISA_PACK_CEILING,
  ISA_READINESS_DEFAULTS,
} from './constants.js';
import { isaGuard } from './guard.js';
import { ISA_CAPABILITIES, ISA_RESERVED_CAPABILITIES, type IsaCapability } from './types.js';

const HOLD_LINE_CLASSES = ['pricing_negotiation', 'financial', 'data_unavailable', 'booking_unavailable'] as const;
const Line = z.string().min(10).max(240);
const Sec = z.number().int().min(0).max(86_400);

const AiIsaContentInner = z.strictObject({
  capabilities: z.array(z.string()).min(1).max(ISA_CAPABILITIES.length + ISA_RESERVED_CAPABILITIES.length),
  channels: z.array(z.enum(['sms', 'email'])).min(1).max(2),
  window: z.strictObject({ startSec: Sec, endSec: Sec }),
  initiatedDays: z.array(z.number().int().min(1).max(7)).max(7),
  noInitiatedOnHolidays: z.boolean(),
  caps: z.strictObject({
    ai24h: z.number().int().min(0).max(100),
    automated24h: z.number().int().min(0).max(100),
    initiated24h: z.number().int().min(0).max(100),
    initiated7d: z.number().int().min(0).max(100),
    minGapSeconds: z.number().int().min(0).max(86_400),
  }),
  cadence: z.enum(ISA_CADENCES),
  limits: z.strictObject({
    maxMessagesPerAssignment: z.number().int().min(1).max(1000),
    maxDays: z.number().int().min(1).max(1000),
    slowAfterUnanswered: z.number().int().min(1).max(100),
    dormantAfterUnanswered: z.number().int().min(1).max(100),
  }),
  readiness: z.strictObject({ timelineDays: z.number().int().min(1).max(365) }),
  booking: z.strictObject({
    kinds: z.strictObject({ buyer: z.array(z.enum(['buyer_consult', 'consult'])).max(2), seller: z.array(z.enum(['listing_appointment', 'consult'])).max(2) }),
    durationMinutes: z.number().int().min(15).max(240),
    minNoticeHours: z.number().int().min(0).max(168),
    horizonDays: z.number().int().min(1).max(60),
    bufferMinutes: z.number().int().min(0).max(240),
  }),
  holdingLines: z.strictObject(Object.fromEntries(HOLD_LINE_CLASSES.map((c) => [c, Line.optional()])) as Record<(typeof HOLD_LINE_CLASSES)[number], z.ZodOptional<typeof Line>>),
  tone: z.string().max(500),
});
export type AiIsaContent = z.infer<typeof AiIsaContentInner>;
export const AiIsaContentSchema: z.ZodType<AiIsaContent> = AiIsaContentInner;

/** The shipped default policy (Appendix B): every capability off except converse, both channels. */
export const DEFAULT_AI_ISA_CONTENT: AiIsaContent = Object.freeze({
  capabilities: ['converse'],
  channels: ['sms', 'email'],
  window: { ...ISA_DEFAULT_WINDOW },
  initiatedDays: [...ISA_DEFAULT_INITIATED_DAYS],
  noInitiatedOnHolidays: true,
  caps: { ...ISA_DEFAULT_CAPS },
  cadence: '3d',
  limits: {
    maxMessagesPerAssignment: ISA_DEFAULT_LIMITS.maxMessagesPerAssignment,
    maxDays: ISA_DEFAULT_LIMITS.maxDays,
    slowAfterUnanswered: ISA_DEFAULT_LIMITS.slowAfterUnanswered,
    dormantAfterUnanswered: ISA_DEFAULT_LIMITS.dormantAfterUnanswered,
  },
  readiness: { timelineDays: ISA_READINESS_DEFAULTS.timelineDays },
  booking: {
    kinds: { buyer: ['buyer_consult', 'consult'], seller: ['listing_appointment', 'consult'] },
    durationMinutes: ISA_BOOKING_DEFAULTS.durationMinutes,
    minNoticeHours: ISA_BOOKING_DEFAULTS.minNoticeHours,
    horizonDays: ISA_BOOKING_DEFAULTS.horizonDays,
    bufferMinutes: ISA_BOOKING_DEFAULTS.bufferMinutes,
  },
  holdingLines: {},
  tone: '',
}) as AiIsaContent;

export type AiIsaContentIssueCode =
  | 'SCHEMA'
  | 'CONTENT_KIND_MISMATCH'
  | 'CAPABILITY_NOT_AVAILABLE'
  | 'CAPABILITY_UNKNOWN'
  | 'CONVERSE_REQUIRED'
  | 'DUPLICATE'
  | 'WINDOW_INVALID'
  | 'WINDOW_ABOVE_CEILING'
  | 'HOLIDAYS_REQUIRED'
  | 'CAP_ABOVE_CEILING'
  | 'GAP_BELOW_CEILING'
  | 'LIMIT_ABOVE_CEILING'
  | 'READINESS_ABOVE_CEILING'
  | 'BOOKING_ABOVE_CEILING'
  | 'LINE_GUARD'
  | 'TONE_GUARD';

export interface AiIsaContentIssue {
  code: AiIsaContentIssueCode;
  detail?: string;
}

function dupes(xs: readonly unknown[]): boolean {
  return new Set(xs).size !== xs.length;
}

/**
 * Every issue that blocks approval (or sending) of stored ai_isa content. Accepts the stored shape
 * (`{ kind: 'ai_isa', aiIsa }`) or the inner content. Empty = valid within the ceilings.
 */
export function validateAiIsaContent(raw: unknown, opts: { identity?: IdentityFacts; fairHousing?: FairHousingPack } = {}): AiIsaContentIssue[] {
  const stored = storedContent(raw);
  let inner: unknown = raw;
  if (stored !== null) {
    if (stored.kind !== 'ai_isa') return [{ code: 'CONTENT_KIND_MISMATCH', detail: stored.kind }];
    inner = stored.aiIsa;
  }
  const r = AiIsaContentInner.safeParse(inner);
  if (!r.success) return r.error.issues.map((e) => ({ code: 'SCHEMA' as const, detail: e.path.join('.') || e.code }));
  const c = r.data;
  const out: AiIsaContentIssue[] = [];
  const ceil = ISA_PACK_CEILING;
  for (const cap of c.capabilities) {
    if ((ISA_RESERVED_CAPABILITIES as readonly string[]).includes(cap)) out.push({ code: 'CAPABILITY_NOT_AVAILABLE', detail: cap });
    else if (!(ISA_CAPABILITIES as readonly string[]).includes(cap)) out.push({ code: 'CAPABILITY_UNKNOWN', detail: cap.slice(0, 40) });
  }
  if (!c.capabilities.includes('converse')) out.push({ code: 'CONVERSE_REQUIRED' });
  if (dupes(c.capabilities) || dupes(c.channels) || dupes(c.initiatedDays) || dupes(c.booking.kinds.buyer) || dupes(c.booking.kinds.seller)) out.push({ code: 'DUPLICATE' });
  if (c.window.startSec >= c.window.endSec) out.push({ code: 'WINDOW_INVALID' });
  else if (c.window.startSec < ceil.window.startSec || c.window.endSec > ceil.window.endSec) out.push({ code: 'WINDOW_ABOVE_CEILING' });
  if (!c.noInitiatedOnHolidays) out.push({ code: 'HOLIDAYS_REQUIRED' });
  for (const k of ['ai24h', 'automated24h', 'initiated24h', 'initiated7d'] as const) if (c.caps[k] > ceil.caps[k]) out.push({ code: 'CAP_ABOVE_CEILING', detail: k });
  if (c.caps.minGapSeconds < ceil.caps.minGapSeconds) out.push({ code: 'GAP_BELOW_CEILING' });
  if (c.limits.maxMessagesPerAssignment > ceil.maxMessagesPerAssignment) out.push({ code: 'LIMIT_ABOVE_CEILING', detail: 'maxMessagesPerAssignment' });
  if (c.limits.maxDays > ceil.maxDays) out.push({ code: 'LIMIT_ABOVE_CEILING', detail: 'maxDays' });
  if (c.limits.slowAfterUnanswered > c.limits.dormantAfterUnanswered) out.push({ code: 'LIMIT_ABOVE_CEILING', detail: 'slowAfterUnanswered' });
  if (c.readiness.timelineDays > ceil.readinessTimelineDays) out.push({ code: 'READINESS_ABOVE_CEILING' });
  const b = ceil.booking;
  if (c.booking.minNoticeHours < b.minNoticeHoursFloor) out.push({ code: 'BOOKING_ABOVE_CEILING', detail: 'minNoticeHours' });
  if (c.booking.horizonDays > b.horizonDaysMax) out.push({ code: 'BOOKING_ABOVE_CEILING', detail: 'horizonDays' });
  if (c.booking.bufferMinutes < b.bufferMinutesFloor) out.push({ code: 'BOOKING_ABOVE_CEILING', detail: 'bufferMinutes' });
  if (c.booking.durationMinutes > b.durationMinutesMax) out.push({ code: 'BOOKING_ABOVE_CEILING', detail: 'durationMinutes' });
  // holding lines: contentGuard, fair housing and the ISA guard, like model text (§3.2)
  const identity = opts.identity;
  for (const [cls, line] of Object.entries(c.holdingLines)) {
    if (line === undefined) continue;
    const isa = identity !== undefined ? isaGuard(line, { channel: 'sms', identity, sources: [], ...(opts.fairHousing ? { fairHousing: opts.fairHousing } : {}) }) : null;
    const fh = guardAssistantOutput(line, opts.fairHousing ?? DEFAULT_FAIR_HOUSING_PACK);
    const cg = identity !== undefined ? contentGuard(line, { channel: 'sms', purpose: 'informational', maxLength: 240 }, identity, { firstInThread: false, requireSignOff: false }) : null;
    if ((isa !== null && !isa.pass) || fh.hard.length + fh.soft.length > 0 || (cg !== null && !cg.pass)) out.push({ code: 'LINE_GUARD', detail: cls });
  }
  if (c.tone.trim() !== '') {
    const fh = guardAssistantOutput(c.tone, opts.fairHousing ?? DEFAULT_FAIR_HOUSING_PACK);
    if (fh.hard.length + fh.soft.length > 0) out.push({ code: 'TONE_GUARD' });
  }
  return out;
}

/** Parses valid content (null when any issue blocks it): what the machine reads at each turn. */
export function parseAiIsaContent(raw: unknown, opts: { identity?: IdentityFacts; fairHousing?: FairHousingPack } = {}): AiIsaContent | null {
  if (validateAiIsaContent(raw, opts).length > 0) return null;
  const stored = storedContent(raw);
  return AiIsaContentInner.parse(stored !== null && stored.kind === 'ai_isa' ? stored.aiIsa : raw);
}

// ---- wider or narrower: one rule per field (R-ISA-38; E1011; docs/AI_ISA.md §3.2) -------------------------------------

/** Every leaf of a content type as a dotted path; an array is one leaf, an optional value counts as present. */
type LeafKey<T, P extends string = ''> = T extends readonly unknown[]
  ? P
  : T extends object
    ? { [K in keyof T & string]-?: LeafKey<NonNullable<T[K]>, P extends '' ? K : `${P}.${K}`> }[keyof T & string]
    : P;

/** One key per value of `AiIsaContent`: the id a form field, a validator issue, a diff line and a comparison rule share. */
export type AiIsaFieldKey = LeafKey<AiIsaContent>;

/**
 * What makes a change of one field WIDER (the assistant may do more, so care pauses until each agent re-confirms):
 * - adding: a choice that was not there before; - higher / lower: a larger / smaller number; - off: turning the rule off;
 * - faster: a shorter interval; - any: every change, in either direction, because nothing here can rank it.
 */
export type PolicyWidening = 'adding' | 'higher' | 'lower' | 'off' | 'faster' | 'any';

/**
 * The comparison rule of every field. The type is a map over `AiIsaFieldKey`, so a value added to the schema with no
 * rule here does not compile; at run time a key with no rule is WIDER (policyFieldChange), never ignored.
 * `any` (fail closed):
 * - readiness.timelineDays: fewer days hands FEWER people back and keeps writing to the rest, more days hands back
 *   sooner; which of the two is "more" is the Owner's to rule (Q-ISA-46), so both re-confirm;
 * - booking.durationMinutes: a longer or shorter appointment is a different thing booked on an agent's calendar;
 * - holdingLines.* and tone: words, with nothing to rank them by.
 * VERIFY WITH COUNSEL (engineering defaults).
 */
export const AI_ISA_FIELD_WIDENS: { readonly [K in AiIsaFieldKey]: PolicyWidening } = Object.freeze({
  capabilities: 'adding',
  channels: 'adding',
  'window.startSec': 'lower',
  'window.endSec': 'higher',
  initiatedDays: 'adding',
  noInitiatedOnHolidays: 'off',
  'caps.ai24h': 'higher',
  'caps.automated24h': 'higher',
  'caps.initiated24h': 'higher',
  'caps.initiated7d': 'higher',
  'caps.minGapSeconds': 'lower',
  cadence: 'faster',
  'limits.maxMessagesPerAssignment': 'higher',
  'limits.maxDays': 'higher',
  'limits.slowAfterUnanswered': 'higher',
  'limits.dormantAfterUnanswered': 'higher',
  'readiness.timelineDays': 'any',
  'booking.kinds.buyer': 'adding',
  'booking.kinds.seller': 'adding',
  'booking.minNoticeHours': 'lower',
  'booking.horizonDays': 'higher',
  'booking.bufferMinutes': 'lower',
  'booking.durationMinutes': 'any',
  'holdingLines.pricing_negotiation': 'any',
  'holdingLines.financial': 'any',
  'holdingLines.data_unavailable': 'any',
  'holdingLines.booking_unavailable': 'any',
  tone: 'any',
} as const);

/** The field keys in the order a diff reads them. */
export const AI_ISA_FIELD_KEYS: readonly AiIsaFieldKey[] = Object.freeze(Object.keys(AI_ISA_FIELD_WIDENS) as AiIsaFieldKey[]);

export type PolicyFieldChange = 'same' | 'narrower' | 'wider';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isList = (v: unknown): v is readonly (string | number)[] => Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number');
const ranked = (a: unknown, b: unknown, widerWhenHigher: boolean): PolicyFieldChange => (!isNum(a) || !isNum(b) ? 'wider' : a === b ? 'same' : b > a === widerWhenHigher ? 'wider' : 'narrower');

const WIDENING: { readonly [K in PolicyWidening]: (prev: unknown, next: unknown) => PolicyFieldChange } = {
  adding: (a, b) => (!isList(a) || !isList(b) ? 'wider' : !b.every((x) => a.includes(x)) ? 'wider' : a.every((x) => b.includes(x)) ? 'same' : 'narrower'),
  higher: (a, b) => ranked(a, b, true),
  lower: (a, b) => ranked(a, b, false),
  off: (a, b) => (typeof a !== 'boolean' || typeof b !== 'boolean' ? 'wider' : a === b ? 'same' : b ? 'narrower' : 'wider'),
  faster: (a, b) => {
    const [x, y] = [CADENCE_MS[a as keyof typeof CADENCE_MS], CADENCE_MS[b as keyof typeof CADENCE_MS]];
    return typeof a !== 'string' || typeof b !== 'string' || !Object.hasOwn(CADENCE_MS, a) || !Object.hasOwn(CADENCE_MS, b) ? 'wider' : ranked(y, x, true);
  },
  // an absent optional value and undefined are the same; anything else that differs is wider
  any: (a, b) => ((a === undefined || typeof a === 'string' || isNum(a)) && a === b ? 'same' : 'wider'),
};

/**
 * How one field changed from `prev` to `next`. A key with no rule (a field this code does not know) is WIDER whatever
 * its values, and so is a value of the wrong type: the comparison never calls a change it cannot read "narrower".
 */
export function policyFieldChange(key: string, prev: unknown, next: unknown): PolicyFieldChange {
  if (!Object.hasOwn(AI_ISA_FIELD_WIDENS, key)) return 'wider';
  return WIDENING[AI_ISA_FIELD_WIDENS[key as AiIsaFieldKey]](prev, next);
}

/** Every leaf path a stored value actually holds (an array is one leaf; an undefined value is absent). */
function leafKeys(o: unknown, at: string[] = []): string[] {
  if (o === undefined) return [];
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [at.join('.')];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, [...at, k]));
}

function valueAt(o: unknown, key: string): unknown {
  let at: unknown = o;
  for (const k of key.split('.')) at = at === null || typeof at !== 'object' || Array.isArray(at) ? undefined : Object.hasOwn(at, k) ? (at as Record<string, unknown>)[k] : undefined;
  return at;
}

/**
 * Every field that differs between two contents, in diff order: the known fields by their rule, then any leaf either
 * side holds that the table does not know (`known: false`, always wider).
 */
export function policyFieldChanges(prev: unknown, next: unknown): { key: string; change: 'narrower' | 'wider'; known: boolean }[] {
  const out: { key: string; change: 'narrower' | 'wider'; known: boolean }[] = [];
  for (const key of AI_ISA_FIELD_KEYS) {
    const change = policyFieldChange(key, valueAt(prev, key), valueAt(next, key));
    if (change !== 'same') out.push({ key, change, known: true });
  }
  const unknown = [...new Set([...leafKeys(prev), ...leafKeys(next)])].filter((k) => !Object.hasOwn(AI_ISA_FIELD_WIDENS, k)).sort();
  for (const key of unknown) out.push({ key, change: 'wider', known: false });
  return out;
}

/**
 * §3.2: whether `next` only narrows `prev`: no field changed in its widening direction (AI_ISA_FIELD_WIDENS: fewer or
 * equal capabilities, channels, days and booking kinds; a later start and an earlier end; holidays kept; lower or equal
 * caps, limits and horizon; an equal or larger gap, notice and buffer; a slower or equal cadence), and no field changed
 * that the table ranks `any` or does not know. Both should be valid content; anything else compares as wider.
 */
export function narrowsPrevious(prev: AiIsaContent, next: AiIsaContent): boolean {
  if (prev === null || typeof prev !== 'object' || next === null || typeof next !== 'object') return false;
  return policyFieldChanges(prev, next).every((c) => c.change !== 'wider');
}

/** The capabilities in effect: the policy's ∩ the agent's opt-in, minus anything reserved. */
export function capabilitiesInEffect(content: AiIsaContent, optIn: readonly string[]): Set<IsaCapability> {
  return new Set(content.capabilities.filter((c): c is IsaCapability => (ISA_CAPABILITIES as readonly string[]).includes(c) && optIn.includes(c)));
}
