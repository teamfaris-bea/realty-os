// Evidence display for assistant output and exception items (ARCHITECTURE §11 "evidence over
// confidence"): `{claim} — {source} {locator}`, e.g.
//   Callback due Thu Nov 12, 4 PM — “call me Thursday around four” at 2:14 in the call
// Tapping the evidence opens the source at that offset. Opening routes come from the page registry
// (SurfaceModule.evidenceRoutes) through EvidenceRoutesProvider; when no surface can open a source
// type the evidence renders as plain text, never as a dead link.
//
// There are no confidence fields in these view types and nothing here renders a score (R-AST-13,
// display half; the API schema half is api's snapshot test). Needs-review output is flagged with
// "Check this" in words, not only color.
import type { Locator, SourceType } from '@realty/core/assistant';
import { type ReactElement, type ReactNode, createContext, useContext } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon.js';

/** Exception evidence adds two derived source types (core/priority ExceptionEvidenceSchema). */
export type EvidenceSourceType = SourceType | 'ownership_period' | 'message_status';

export interface EvidenceRefView {
  sourceType: EvidenceSourceType;
  sourceId: string;
  /** the contact the source belongs to, when the surface needs it to build a route */
  contactId?: string | null;
  locator?: Locator;
  /** verbatim words from the source */
  snippet?: string;
  /** a short plain explanation of why this supports the claim */
  explanation?: string;
  /** evidence_refs.verbatim_verified; false means the quote was not found in the source */
  verified?: boolean;
}

export type EvidenceRouteFn = (ref: EvidenceRefView) => string | null;
export type EvidenceRoutes = Partial<Record<EvidenceSourceType, EvidenceRouteFn>>;

const EvidenceRoutesContext = createContext<EvidenceRoutes>({});

export function EvidenceRoutesProvider({ routes, children }: { routes: EvidenceRoutes; children: ReactNode }) {
  return <EvidenceRoutesContext.Provider value={routes}>{children}</EvidenceRoutesContext.Provider>;
}

const NOUN: Record<EvidenceSourceType, string> = {
  call: 'call',
  message: 'text',
  email: 'email',
  note: 'note',
  listing: 'listing',
  import: 'imported history',
  behavior_event: 'website activity',
  deal: 'deal',
  task: 'task',
  appointment: 'appointment',
  ownership_period: 'lead history',
  message_status: 'message delivery status',
};

// ---- formatting ------------------------------------------------------------------------------
// Mirrors core/assistant `formatEvidence` word for word (Evidence.test.tsx asserts parity for every
// source type and locator kind). It is restated here because importing @realty/core/assistant at
// runtime pulls zod, luxon and the authz matrix into the phone bundle (~250 kB) for 20 lines of text.

const EDGE = /^[\s"'.,!?;:()[\]{}\-–—“”‘’]+|[\s"'.,!?;:()[\]{}\-–—“”‘’]+$/gu;

const WHERE: Record<SourceType, string> = {
  call: 'in the call',
  message: 'in the text',
  email: 'in the email',
  note: 'in a note',
  listing: 'on the listing',
  import: 'in imported history',
  behavior_event: 'in website activity',
  deal: 'on the deal',
  task: 'on a task',
  appointment: 'on the appointment',
};

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mmss = `${h > 0 ? String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** `“call me Thursday around four” at 2:14 in the call` (same output as core formatEvidence). */
export function formatEvidenceLine(ref: { sourceType: SourceType; locator: Locator; snippet: string }): string {
  const quote = `“${ref.snippet.replace(EDGE, '')}”`;
  switch (ref.locator.kind) {
    case 'transcript_offset':
      return `${quote} at ${clock(ref.locator.startMs)} ${WHERE[ref.sourceType]}`;
    case 'field':
      return `${quote} (${ref.locator.name.replace(/_/g, ' ')}) ${WHERE[ref.sourceType]}`;
    default:
      return `${quote} ${WHERE[ref.sourceType]}`;
  }
}

/** The one-line, agent-facing evidence text. */
export function evidenceText(ref: EvidenceRefView): string {
  const snippet = ref.snippet?.trim();
  if (!snippet) return ref.explanation?.trim() || `From the ${NOUN[ref.sourceType]}`;
  if (ref.sourceType === 'ownership_period' || ref.sourceType === 'message_status') return `“${snippet}” in the ${NOUN[ref.sourceType]}`;
  return formatEvidenceLine({ sourceType: ref.sourceType, locator: ref.locator ?? { kind: 'message' }, snippet });
}

/**
 * Spec correction (reported): BUILD_PLAN sketches `EvidenceLink(props: { ref })`, but `ref` is a
 * reserved prop in React 18 (it is never passed to a function component), so the prop is `evidence`.
 */
export function EvidenceLink({ evidence }: { evidence: EvidenceRefView }): ReactElement {
  const routes = useContext(EvidenceRoutesContext);
  const href = routes[evidence.sourceType]?.(evidence) ?? null;
  const text = evidenceText(evidence);
  const unverified = evidence.verified === false;
  const showExplanation = evidence.explanation?.trim() && evidence.snippet?.trim() ? evidence.explanation.trim() : null;
  const body = (
    <>
      <span className="text-ink">{text}</span>
      {unverified ? <CheckThis reason="The quote wasn't found in the source." /> : null}
    </>
  );
  return (
    <span className="inline-flex flex-col gap-0.5">
      {href ? (
        <Link to={href} className="inline-flex min-h-tap items-center gap-1.5 text-[15px] underline decoration-line underline-offset-4 hover:decoration-accent">
          {evidence.locator?.kind === 'transcript_offset' ? (
            <span className="text-accent">
              <Icon name="play" size={14} />
            </span>
          ) : null}
          {body}
        </Link>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-[15px]">{body}</span>
      )}
      {showExplanation ? <span className="text-[14px] text-ink-muted">{showExplanation}</span> : null}
    </span>
  );
}

/** The needs-review flag. Says it in words; never a number. */
export function CheckThis({ reason }: { reason?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-0.5 text-[13px] font-semibold text-warn" title={reason}>
      <Icon name="alert" size={14} />
      <span className="text-ink">Check this</span>
      {reason ? <span className="sr-only">: {reason}</span> : null}
    </span>
  );
}

export interface ClaimView {
  text: string;
  needsReview: boolean;
  evidence: EvidenceRefView[];
}

/**
 * One assistant claim with its evidence: "Callback due Thu Nov 12, 4 PM — “…” at 2:14 in the call".
 * A needs-review claim is flagged "Check this" and is shown, never silently dropped.
 */
export function ClaimLine({ claim }: { claim: ClaimView }): ReactElement {
  return (
    <div className="flex flex-col gap-1" data-needs-review={claim.needsReview || undefined}>
      <p className="flex flex-wrap items-center gap-2 text-[16px] text-ink">
        <span>{claim.text}</span>
        {claim.needsReview ? <CheckThis reason="The assistant isn't sure about this. Confirm or correct it before it's used." /> : null}
      </p>
      {claim.evidence.length > 0 ? (
        <ul className="flex flex-col gap-1 pl-3" aria-label="Evidence">
          {claim.evidence.map((e, i) => (
            <li key={`${e.sourceType}:${e.sourceId}:${i}`} className="flex gap-1.5 text-ink-muted">
              <span aria-hidden="true">—</span>
              <EvidenceLink evidence={e} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="pl-3 text-[14px] text-ink-muted">No source found for this.</p>
      )}
    </div>
  );
}
