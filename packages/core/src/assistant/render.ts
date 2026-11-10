// Rendering playbook steps into the exact text that will be sent (R-AST-11, R-GATE-12, R-AST-5).
//
// Template syntax (deliberately tiny):
//   {{slot}}                 a required slot; a missing value is SLOT_MISSING
//   {{#slot}}…{{/slot}}      an optional section, rendered only when the slot has a value
//                            (e.g. the VA-loan question, only when the source/form indicates it)
// Slot values are inserted literally in one pass (a value containing "{{x}}" is never expanded).
// A value that comes from a needs-review claim is never inserted into outbound text (R-AST-5): as
// a required slot it is SLOT_NEEDS_REVIEW, inside an optional section the section is left out.
//
// Identity (R-AST-11, A7f):
//   - every message ends with the sign-off "— the {Team} assistant" / "— {Agent}'s assistant";
//   - the first assistant message in a thread adds the brokerage legal name, and on SMS
//     "Reply STOP to opt out";
//   - every marketing message renders the brokerage legal name (R-GATE-12);
//   - marketing email adds the postal address and the unsubscribe link when the caller supplies
//     them (the gate denies marketing email without them, R-CONSENT-18).
// Wording of the sign-off and the opt-out line: VERIFY WITH COUNSEL (AI disclosure laws).
import { containsName, containsOptOutHint } from '../compliance/index.js';
import type { IanaZone, Instant } from '../foundation/index.js';
import { formatDue } from './dates.js';
import type { PlaybookStep, SlotName } from './playbook.js';
import type { IdentityFacts } from './types.js';

export const OPT_OUT_LINE = 'Reply STOP to opt out';

/** "— Sarah's assistant" for agent-scoped work, "— the Smith Team assistant" for the team. */
export function signOffFor(id: Pick<IdentityFacts, 'scope' | 'agentFirstName' | 'teamName'>): string {
  const first = id.agentFirstName?.trim() ?? '';
  if (id.scope === 'agent' && first !== '') return `— ${first}'s assistant`;
  const team = id.teamName.trim().replace(/^the\s+/i, '');
  return `— the ${team} assistant`;
}

export type SlotValue = string | { value: string; needsReview: boolean };
export type SlotValues = Partial<Record<SlotName, SlotValue>>;

export interface RenderIdentity {
  signOff: string;
  brokerageName: string;
  firstInThread: boolean;
  postalAddress?: string | null;
  unsubscribeUrl?: string | null;
}

export type RenderResult =
  | { ok: true; text: string; subject?: string; omittedSections: SlotName[] }
  | { ok: false; code: 'SLOT_MISSING' | 'SLOT_NEEDS_REVIEW'; slot: string };

const SECTION_RE = /\{\{#([a-z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const VAR_RE = /\{\{([a-z_]+)\}\}/g;
const SLOT_VALUE_MAX = 200;

function clean(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, SLOT_VALUE_MAX);
}

function valueOf(slots: SlotValues, name: string): { value: string | null; needsReview: boolean } {
  const v = (slots as Record<string, SlotValue | undefined>)[name];
  if (v === undefined) return { value: null, needsReview: false };
  if (typeof v === 'string') {
    const c = clean(v);
    return { value: c === '' ? null : c, needsReview: false };
  }
  const c = clean(v.value);
  return { value: c === '' ? null : c, needsReview: v.needsReview };
}

function fill(template: string, slots: SlotValues, omitted: SlotName[]): { ok: true; text: string } | { ok: false; code: 'SLOT_MISSING' | 'SLOT_NEEDS_REVIEW'; slot: string } {
  // Optional sections first; a section's own variables are optional too.
  let failure: { code: 'SLOT_MISSING' | 'SLOT_NEEDS_REVIEW'; slot: string } | null = null;
  const withSections = template.replace(SECTION_RE, (_m, name: string, inner: string) => {
    const v = valueOf(slots, name);
    if (v.value === null || v.needsReview) {
      omitted.push(name as SlotName);
      return '';
    }
    return inner.replace(VAR_RE, (_x, n: string) => {
      const iv = valueOf(slots, n);
      return iv.value !== null && !iv.needsReview ? iv.value : '';
    });
  });
  // String.replace scans the template once, so an inserted value is never re-scanned.
  const out = withSections.replace(VAR_RE, (_m, name: string) => {
    const v = valueOf(slots, name);
    if (failure === null) {
      if (v.value === null) failure = { code: 'SLOT_MISSING', slot: name };
      else if (v.needsReview) failure = { code: 'SLOT_NEEDS_REVIEW', slot: name };
    }
    return v.value !== null && !v.needsReview ? v.value : '';
  });
  if (failure !== null) return { ok: false, ...(failure as { code: 'SLOT_MISSING' | 'SLOT_NEEDS_REVIEW'; slot: string }) };
  return { ok: true, text: out.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim() };
}

/** Renders a step exactly as it will be sent (body + identity lines). */
export function renderStep(step: PlaybookStep, slots: SlotValues, identity: RenderIdentity): RenderResult {
  const omitted: SlotName[] = [];
  const body = fill(step.template, slots, omitted);
  if (!body.ok) return body;
  let subject: string | undefined;
  if (step.channel === 'email') {
    const s = fill(step.subject ?? '', slots, omitted);
    if (!s.ok) return s;
    subject = s.text;
  }
  const needBrokerage = (identity.firstInThread || step.purpose === 'marketing') && !containsName(body.text, identity.brokerageName);
  const lines: string[] = [body.text, identity.signOff];
  if (step.channel === 'sms') {
    const tail: string[] = [];
    if (needBrokerage) tail.push(identity.brokerageName);
    if (identity.firstInThread && !containsOptOutHint(body.text, 'sms')) tail.push(OPT_OUT_LINE);
    if (tail.length > 0) lines.push(tail.join(' · '));
    return { ok: true, text: lines.join('\n'), omittedSections: omitted };
  }
  if (needBrokerage || step.purpose === 'marketing') {
    if (needBrokerage) lines.push(identity.brokerageName);
    if (step.purpose === 'marketing' && identity.postalAddress) lines.push(identity.postalAddress.trim());
    if (step.purpose === 'marketing' && identity.unsubscribeUrl) lines.push(`Unsubscribe: ${identity.unsubscribeUrl}`);
  }
  const [first, ...rest] = lines;
  return { ok: true, text: `${first as string}\n\n${rest.join('\n')}`, subject: subject as string, omittedSections: omitted };
}

/**
 * The step as it would be sent on `channel`: itself, its email fallback (the 60-second first
 * response goes by email when SMS is not allowed, R-AST-16), or null when it cannot go that way.
 */
export function stepForChannel(step: PlaybookStep, channel: 'sms' | 'email'): PlaybookStep | null {
  if (step.channel === channel) return step;
  if (channel === 'email' && step.fallback !== undefined) {
    const { fallback, ...rest } = step;
    return { ...rest, channel: 'email', subject: fallback.subject, template: fallback.template, maxLength: fallback.maxLength };
  }
  return null;
}

// ---- slot formatting helpers --------------------------------------------------------------------

/** 45000000 → "$450,000". */
export function formatPriceCents(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `$${String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** An appointment time as the client reads it, in their zone: "Thu Nov 12, 4 PM". */
export function formatAppointment(at: Instant, zone: IanaZone): string {
  return formatDue(at, false, zone);
}
