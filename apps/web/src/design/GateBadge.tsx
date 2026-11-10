// GateBadge: says inline, next to Call / Text / Send, when a send or call will not go out and why
// ("Won't send: Opted out of texts").
//
// core-compliance/2.0.0 (owner decision): the send-time check only allows or blocks. It blocks for an
// opt-out (STOP, unsubscribe, "do not contact me"), an active suppression, and a few operational or
// identity rules (no sender, wrong number, brokerage name missing, ...). Nothing waits for quiet hours
// and nothing asks the agent to confirm, so the badge has two states: blocked, or nothing to say.
//
// The sentence is the server's `explanation` (core/compliance `explain()`), rendered as is: the web
// never re-derives a decision or shows a raw reason code (CONVENTIONS §7). A block is conveyed by icon
// shape and words as well as color (WCAG 1.4.1).
import type { ReactElement } from 'react';
import { Icon } from './Icon.js';

export type GateOutcome = 'allow' | 'deny';

/** What the web needs from a gate decision (api/comms serializes it). No scores, no codes shown. */
export interface GateDecisionView {
  outcome: GateOutcome;
  /** Human sentence(s) from the server, joined with " · ". */
  explanation: string;
}

export interface GateBadgeProps {
  decision: GateDecisionView;
  /**
   * The words before the reason on a block: "Won't send" (a preview, the default), "Won't call", or
   * "Not sent" (a send that was just blocked).
   */
  lead?: string;
  /** render nothing for an allow (the usual case: an allowed send needs no badge) */
  quietWhenAllowed?: boolean;
}

export function GateBadge({ decision, lead = "Won't send", quietWhenAllowed = false }: GateBadgeProps): ReactElement | null {
  const text = decision.explanation.trim();
  if (decision.outcome === 'allow') {
    if (quietWhenAllowed) return null;
    return (
      <span data-gate-outcome="allow" className="inline-flex max-w-full items-start gap-1.5 rounded-lg bg-ok-soft px-2 py-1 text-[14px] font-medium leading-snug text-ok">
        <span className="mt-px shrink-0">
          <Icon name="check" size={16} />
        </span>
        <span className="min-w-0 text-ink">OK to send</span>
      </span>
    );
  }
  return (
    <span data-gate-outcome="deny" className="inline-flex max-w-full items-start gap-1.5 rounded-lg bg-danger-soft px-2 py-1 text-[14px] font-medium leading-snug text-danger">
      <span className="mt-px shrink-0">
        <Icon name="block" size={16} />
      </span>
      <span className="min-w-0">
        <span className="font-semibold text-ink">{lead}: </span>
        <span className="text-ink">{text || 'blocked by a send rule'}</span>
      </span>
    </span>
  );
}
