// GateBadge: shows a compliance gate decision inline, next to Call / Text / Send
// ("Opted out of texts · Outside 9 AM–8 PM their time").
//
// The sentence is the server's `explanation` (core/compliance `explain()`), rendered as is: the web
// never re-derives a decision or shows a raw reason code (CONVENTIONS §7). Outcome is conveyed by
// icon shape and screen-reader text as well as color (WCAG 1.4.1).
import type { ReactElement } from 'react';
import { Icon, type IconName } from './Icon.js';

export type GateOutcome = 'allow' | 'deny' | 'defer' | 'needs_confirmation';

/** What the web needs from a GateDecision (api/comms serializes it). No scores, no codes shown. */
export interface GateDecisionView {
  outcome: GateOutcome;
  /** Human sentence(s) from the server, joined with " · ". */
  explanation: string;
}

const STYLE: Record<GateOutcome, { cls: string; icon: IconName; sr: string }> = {
  allow: { cls: 'bg-ok-soft text-ok', icon: 'check', sr: 'OK to send.' },
  deny: { cls: 'bg-danger-soft text-danger', icon: 'block', sr: "Can't send." },
  defer: { cls: 'bg-warn-soft text-warn', icon: 'clock', sr: 'Will wait.' },
  needs_confirmation: { cls: 'bg-warn-soft text-warn', icon: 'question', sr: 'Needs your confirmation.' },
};

const PLAIN_ALLOW = 'OK to send';

export function GateBadge(props: { decision: GateDecisionView; /** render nothing for a plain allow */ quietWhenAllowed?: boolean }): ReactElement | null {
  const { outcome } = props.decision;
  const text = props.decision.explanation.trim() || (outcome === 'allow' ? PLAIN_ALLOW : '');
  if (outcome === 'allow' && props.quietWhenAllowed && text === PLAIN_ALLOW) return null;
  const s = STYLE[outcome];
  return (
    <span data-gate-outcome={outcome} className={`inline-flex max-w-full items-start gap-1.5 rounded-lg px-2 py-1 text-[14px] font-medium leading-snug ${s.cls}`}>
      <span className="mt-px shrink-0">
        <Icon name={s.icon} size={16} />
      </span>
      <span className="min-w-0">
        <span className="sr-only">{s.sr} </span>
        <span className="text-ink">{text}</span>
      </span>
    </span>
  );
}
