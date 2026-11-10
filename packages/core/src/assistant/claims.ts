// Claims: turning untrusted model output into evidence-backed statements (A2; R-AST-1, R-AST-2,
// R-AST-5, R-AST-9 deterministic handback claims; E33, E34).
//
// The model's output is data, never truth. normalizeClaims keeps only what it can check:
//   - every evidence ref must point at a source of THIS contact that was in the prompt (by handle
//     or by type+id); refs to anything else are dropped, so a foreign id can never be stored;
//   - every snippet is verified verbatim (verifyQuote); a claim with no verified ref is
//     needs_review (R-AST-1 is then satisfied by the flag, never by a fake ref);
//   - dates are resolved by core from the client's quoted words, against when they were said, in
//     the contact's zone (R-AST-2); unresolvable or ambiguous dates make the claim needs_review;
//   - structured values (search criteria) are re-validated, and the value must appear in a
//     verified snippet (CRITERION_NOT_QUOTED otherwise); invalid or unquoted ⇒ needs_review;
//   - text is clipped to the stored maximum (300) and flagged when clipped.
// A needs-review claim is shown with "Check this" and is never put into outbound text, saved-search
// criteria or task due dates until the agent confirms or corrects it (R-AST-5).
import { z } from 'zod';
import { type IanaZone, type IdGenerator, type Instant, instantFromIso } from '../foundation/index.js';
import { formatDue, resolveRelativeDate } from './dates.js';
import { type QuoteMatch, type SourceIndex, type SourceText, type TranscriptSegment, containsWords, normalizeForQuote, normalizeSnippet, sourceKey, verifiedMatch, verifyQuote } from './evidence.js';
import { criterionQuoted, parseCriterion } from './search.js';
import {
  CLAIM_KINDS,
  CLAIM_TEXT_MAX,
  type CheckedEvidenceRef,
  type Claim,
  type ClaimKind,
  type ClaimStructured,
  type EvidenceRef,
  type Locator,
  type ReviewReason,
  SNIPPET_MAX,
  SOURCE_TYPES,
  type SourceType,
} from './types.js';

// ---- the model's output contract (lenient: anything malformed is dropped or flagged) -------------

const RawLocator = z.looseObject({ kind: z.string() });
const RawRef = z.looseObject({
  source: z.string().optional(),
  sourceType: z.string().optional(),
  source_type: z.string().optional(),
  sourceId: z.string().optional(),
  source_id: z.string().optional(),
  locator: RawLocator.optional(),
  snippet: z.string(),
});
const RawClaim = z.looseObject({
  kind: z.string().optional(),
  text: z.string(),
  when: z.string().optional(),
  resolved_at: z.string().optional(),
  criterion: z.looseObject({ key: z.string(), value: z.unknown() }).optional(),
  needs_review: z.boolean().optional(),
  evidence: z.array(z.unknown()).optional(),
});

/** What the prompt asks the model to return (see prompt.ts OUTPUT_CONTRACT). */
export const ModelOutputSchema = z.looseObject({
  claims: z.array(z.unknown()).optional(),
  explanation: z.string().optional(),
  draft: z.looseObject({ channel: z.string().optional(), subject: z.string().optional(), body: z.string() }).optional(),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export const MAX_CLAIMS = 40;
const MAX_REFS_PER_CLAIM = 8;

function clip(s: string, max: number): { text: string; clipped: boolean } {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return { text: t, clipped: false };
  const cut = t.slice(0, max - 1);
  const atWord = cut.replace(/\s+\S*$/, '');
  return { text: `${atWord.length >= max / 2 ? atWord : cut}…`, clipped: true };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseLocator(raw: Record<string, unknown> | undefined, source: SourceText): Locator | null {
  if (raw === undefined) return source.kind === 'text' ? { kind: 'message' } : null;
  switch (raw.kind) {
    case 'message':
      return { kind: 'message' };
    case 'transcript_offset': {
      const s = num(raw.startMs ?? raw.start_ms);
      const e = num(raw.endMs ?? raw.end_ms);
      return s === null || e === null ? null : { kind: 'transcript_offset', startMs: Math.round(s), endMs: Math.round(e) };
    }
    case 'char_range': {
      const s = num(raw.start);
      const e = num(raw.end);
      return s === null || e === null ? null : { kind: 'char_range', start: Math.round(s), end: Math.round(e) };
    }
    case 'field':
      return typeof raw.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw.name) ? { kind: 'field', name: raw.name } : null;
    default:
      return null;
  }
}

function resolveSource(r: z.infer<typeof RawRef>, sources: SourceIndex): SourceText | null {
  if (r.source !== undefined) {
    const s = sources.byHandle.get(r.source.trim());
    if (s) return s;
  }
  const type = r.sourceType ?? r.source_type;
  const id = r.sourceId ?? r.source_id;
  if (type !== undefined && id !== undefined && (SOURCE_TYPES as readonly string[]).includes(type)) {
    return sources.byKey.get(sourceKey(type as SourceType, id)) ?? null;
  }
  return null;
}

/**
 * A verified transcript ref is stored with the span of the segments its quote is actually in, so
 * the evidence link opens where the words were said (a model may cite the whole call). The
 * narrowed locator still verifies: it contains the match.
 */
function tightLocator(source: SourceText, ref: EvidenceRef): Locator {
  if (source.kind !== 'transcript' || ref.locator.kind !== 'transcript_offset') return ref.locator;
  // verified ⇒ an in-range match exists, with segment indexes into the start-sorted segments
  const m = verifiedMatch(source, ref) as QuoteMatch;
  const segs = [...source.segments].sort((a, b) => a.startMs - b.startMs);
  return { kind: 'transcript_offset', startMs: (segs[m.segFirst as number] as TranscriptSegment).startMs, endMs: (segs[m.segLast as number] as TranscriptSegment).endMs };
}

/** The evidence refs of one raw claim, resolved and verified; unresolvable refs are dropped. */
function checkRefs(rawRefs: readonly unknown[], sources: SourceIndex): { refs: CheckedEvidenceRef[]; sourcesOf: SourceText[] } {
  const refs: CheckedEvidenceRef[] = [];
  const sourcesOf: SourceText[] = [];
  for (const rr of rawRefs.slice(0, MAX_REFS_PER_CLAIM)) {
    const p = RawRef.safeParse(rr);
    if (!p.success) continue;
    const source = resolveSource(p.data, sources);
    if (source === null) continue;
    const locator = parseLocator(p.data.locator as Record<string, unknown> | undefined, source);
    if (locator === null) continue;
    const snippet = clip(p.data.snippet, SNIPPET_MAX).text.replace(/…$/, '');
    if (snippet === '') continue;
    const ref = { sourceType: source.sourceType, sourceId: source.sourceId, locator, snippet };
    const v = verifyQuote(source, ref);
    refs.push({ ...ref, ...v, locator: v.verified ? tightLocator(source, ref) : locator });
    sourcesOf.push(source);
  }
  return { refs, sourcesOf };
}

const DATE_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>(['date_time', 'commitment']);

/**
 * R-AST-2 / E34: resolves the claim's date phrase. The phrase must be the client's own words
 * (inside a verified snippet); it is resolved against when those words were said.
 */
function resolveDue(phrase: string, refs: readonly CheckedEvidenceRef[], sourcesOf: readonly SourceText[], zone: IanaZone, modelIso: string | undefined):
  | { due: NonNullable<ClaimStructured['due']> }
  | { reason: ReviewReason } {
  const needle = normalizeSnippet(phrase);
  let saidAt: Instant | null = null;
  for (let k = 0; k < refs.length && saidAt === null; k++) {
    const r = refs[k] as CheckedEvidenceRef;
    if (!r.verified || !containsWords(normalizeForQuote(r.snippet).text, needle)) continue;
    // r.verified ⇒ the quote has an in-range match
    saidAt = (verifiedMatch(sourcesOf[k] as SourceText, r) as QuoteMatch).at;
  }
  if (saidAt === null) return { reason: 'DATE_PHRASE_NOT_QUOTED' };
  const res = resolveRelativeDate(phrase, saidAt, zone);
  if (!res.ok) return { reason: res.reason === 'AMBIGUOUS' ? 'DATE_AMBIGUOUS' : 'DATE_UNRESOLVED' };
  if (modelIso !== undefined) {
    const t = instantFromIso(modelIso);
    if (t === null || (res.allDay ? formatDue(t, true, zone) !== formatDue(res.at, true, zone) : Math.abs(t - res.at) > 60_000)) {
      return { reason: 'DATE_MISMATCH' };
    }
  }
  return { due: { at: res.at, allDay: res.allDay, zone, phrase: phrase.trim(), saidAt, display: formatDue(res.at, res.allDay, zone) } };
}

/**
 * Normalizes raw model output into claims for one action. Never throws on bad model output:
 * anything that cannot be checked is dropped or flagged needs_review.
 *
 * Spec correction (reported): `ctx.ids` mints the claim ids (core stays pure; ids are injected).
 */
export function normalizeClaims(raw: unknown, sources: SourceIndex, ctx: { contactZone: IanaZone; ids: IdGenerator }): Claim[] {
  const out = ModelOutputSchema.safeParse(raw);
  if (!out.success || out.data.claims === undefined) return [];
  const claims: Claim[] = [];
  for (const rc of out.data.claims.slice(0, MAX_CLAIMS)) {
    const p = RawClaim.safeParse(rc);
    if (!p.success) continue;
    const c = p.data;
    const t = clip(c.text, CLAIM_TEXT_MAX);
    if (t.text === '') continue;
    const reasons: ReviewReason[] = [];
    let kind: ClaimKind = 'fact';
    if (c.kind !== undefined && (CLAIM_KINDS as readonly string[]).includes(c.kind)) kind = c.kind as ClaimKind;
    else reasons.push('UNKNOWN_KIND');
    if (t.clipped) reasons.push('TEXT_TRUNCATED');
    if (c.needs_review === true) reasons.push('MODEL_FLAGGED');
    const { refs, sourcesOf } = checkRefs(c.evidence ?? [], sources);
    if (refs.length === 0) reasons.push('NO_EVIDENCE');
    else if (!refs.some((r) => r.verified)) reasons.push('QUOTE_NOT_VERIFIED');

    const structured: ClaimStructured = {};
    if (c.when !== undefined && c.when.trim() !== '') {
      const d = resolveDue(c.when, refs, sourcesOf, ctx.contactZone, c.resolved_at);
      if ('due' in d) structured.due = d.due;
      else {
        structured.due = null;
        reasons.push(d.reason);
      }
    } else if (kind === 'date_time') {
      structured.due = null;
      reasons.push('DATE_UNRESOLVED');
    }
    if (c.criterion !== undefined) {
      const crit = parseCriterion(c.criterion.key, c.criterion.value);
      if (crit.ok) {
        structured.criterion = { key: crit.key, value: crit.value };
        // The value itself must be in the client's quoted words, like a date phrase (E33): a model
        // that cites "$450,000" for a $900,000 budget gets a needs-review, unchecked criterion.
        const quoted = refs.filter((r) => r.verified).map((r) => normalizeForQuote(r.snippet).text);
        if (!criterionQuoted(crit.key, crit.value, quoted)) reasons.push('CRITERION_NOT_QUOTED');
      } else reasons.push('STRUCTURED_INVALID');
    }
    const claim: Claim = {
      id: ctx.ids.next<'AssistantClaimId'>(),
      ordinal: claims.length,
      kind,
      text: t.text,
      evidence: refs,
      needsReview: reasons.length > 0,
      reviewReasons: [...new Set(reasons)],
    };
    if (Object.keys(structured).length > 0 || DATE_KINDS.has(kind)) claim.structured = structured;
    claims.push(claim);
  }
  return claims;
}

// ---- review state ---------------------------------------------------------------------------------

/** R-AST-5: a claim may feed outbound text, criteria or due dates only once it is trustworthy. */
export function claimUsable(c: { needsReview: boolean; reviewStatus?: 'unreviewed' | 'confirmed' | 'corrected' | 'rejected' }): boolean {
  if (c.reviewStatus === 'rejected') return false;
  return !c.needsReview || c.reviewStatus === 'confirmed' || c.reviewStatus === 'corrected';
}

/**
 * The task fields of a promise extracted from a claim (R-AST-5; tasks CHECK): an unpinned or
 * needs-review date gives no due_at, and the task itself is needs_review.
 */
export function taskDueFromClaim(c: Pick<Claim, 'needsReview' | 'structured'> & { reviewStatus?: 'unreviewed' | 'confirmed' | 'corrected' | 'rejected' }): {
  dueAt: Instant | null;
  dueAllDay: boolean;
  dueTz: string | null;
  needsReview: boolean;
} {
  const due = c.structured?.due ?? null;
  if (!claimUsable(c) || due === null) return { dueAt: null, dueAllDay: false, dueTz: null, needsReview: !claimUsable(c) || due === null };
  return { dueAt: due.at, dueAllDay: due.allDay, dueTz: due.zone, needsReview: false };
}

// ---- deterministic handback claims (R-AST-9) ------------------------------------------------------

function leadSnippet(text: string): string {
  return clip(text, SNIPPET_MAX).text.replace(/…$/, '');
}

function refFor(source: SourceText, snippet: string, locator: Locator): CheckedEvidenceRef {
  const ref = { sourceType: source.sourceType, sourceId: source.sourceId, locator, snippet };
  const v = verifyQuote(source, ref);
  return { ...ref, ...v };
}

function finish(ids: IdGenerator, ordinal: number, kind: ClaimKind, text: string, evidence: CheckedEvidenceRef[]): Claim {
  const verified = evidence.some((e) => e.verified);
  const t = clip(text, CLAIM_TEXT_MAX);
  const reasons: ReviewReason[] = [];
  if (evidence.length === 0) reasons.push('NO_EVIDENCE');
  else if (!verified) reasons.push('QUOTE_NOT_VERIFIED');
  return { id: ids.next<'AssistantClaimId'>(), ordinal, kind, text: t.text, evidence, needsReview: reasons.length > 0, reviewReasons: reasons };
}

/**
 * The claims a handback carries when it is created in the inbound transaction: what the client
 * said (verbatim) and what was sent before (the last outbound ids). Optional: an auto-reply label
 * with its header as evidence (E28), and "sent at the same moment" when a dispatch committed
 * just before the reply (E22). Deterministic: no model involved.
 */
export function handbackClaims(i: {
  ids: IdGenerator;
  clientFirstName: string;
  /** The inbound message (text) or call (fields, e.g. { status: 'missed' }). */
  inbound: SourceText;
  /** The last outbound messages (most recent first), as text sources. */
  lastOutbound: readonly SourceText[];
  autoReply?: { source: SourceText; field: string } | null;
  sentConcurrently?: boolean;
}): Claim[] {
  const name = i.clientFirstName.trim() === '' ? 'The client' : i.clientFirstName.trim();
  const claims: Claim[] = [];
  if (i.inbound.kind === 'text') {
    const said = clip(i.inbound.text, CLAIM_TEXT_MAX - name.length - 12).text;
    claims.push(finish(i.ids, claims.length, 'client_statement', `${name} wrote: “${said}”`, [refFor(i.inbound, leadSnippet(i.inbound.text), { kind: 'message' })]));
  } else if (i.inbound.kind === 'fields') {
    const status = i.inbound.fields.status;
    const label = typeof status === 'string' && status !== '' ? ` (${status.replace(/_/g, ' ')})` : '';
    const ev = typeof status === 'string' && status !== '' ? [refFor(i.inbound, status, { kind: 'field', name: 'status' })] : [];
    claims.push(finish(i.ids, claims.length, 'client_statement', `${name} called${label}`, ev));
  } else {
    const all = i.inbound.segments.map((s) => s.text).join(' ');
    const first = i.inbound.segments[0];
    const last = i.inbound.segments[i.inbound.segments.length - 1];
    const ev = first && last ? [refFor(i.inbound, leadSnippet(all), { kind: 'transcript_offset', startMs: first.startMs, endMs: last.endMs })] : [];
    claims.push(finish(i.ids, claims.length, 'client_statement', `${name} said: “${clip(all, CLAIM_TEXT_MAX - name.length - 11).text}”`, ev));
  }
  const outbound = i.lastOutbound.filter((s): s is Extract<SourceText, { kind: 'text' }> => s.kind === 'text').slice(0, 3);
  if (outbound.length > 0) {
    const latest = outbound[0] as Extract<SourceText, { kind: 'text' }>;
    const lead = i.sentConcurrently ? `Sent at the same moment ${name} replied` : 'Last sent by the assistant';
    claims.push(
      finish(
        i.ids,
        claims.length,
        'sent_summary',
        `${lead}: “${clip(latest.text, CLAIM_TEXT_MAX - lead.length - 6).text}”`,
        outbound.map((s) => refFor(s, leadSnippet(s.text), { kind: 'message' })),
      ),
    );
  }
  if (i.autoReply) {
    const v = i.autoReply.source.kind === 'fields' ? i.autoReply.source.fields[i.autoReply.field] : undefined;
    const ev = typeof v === 'string' && v !== '' ? [refFor(i.autoReply.source, v, { kind: 'field', name: i.autoReply.field })] : [];
    claims.push(finish(i.ids, claims.length, 'fact', 'This looks like an automatic reply (for example out of office). Automation is paused; you can resume it with one tap.', ev));
  }
  return claims;
}
