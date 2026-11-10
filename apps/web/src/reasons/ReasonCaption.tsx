// The caption under a disabled Text / Email / Call / Send action, and the muted note for an opt-out
// that does not block this particular send. Words and an icon shape carry the meaning, not color alone
// (WCAG 1.4.1). Give the button aria-describedby={id} so the reason is read with it.
import type { ReactElement } from 'react';
import { Icon } from '../design/index.js';
import type { ChannelState } from './useReachability.js';

export function ReasonCaption({ id, state, className = '' }: { id?: string; state: ChannelState; className?: string }): ReactElement | null {
  if (state.blocked && state.sentence) {
    return (
      <p id={id} data-reason="blocked" className={`flex items-start gap-1 text-[13px] font-medium leading-snug text-danger ${className}`}>
        <span className="mt-px shrink-0">
          <Icon name="block" size={14} />
        </span>
        <span className="min-w-0 text-ink">{state.sentence}</span>
      </p>
    );
  }
  if (state.note) {
    return (
      <p id={id} data-reason="note" className={`text-[13px] leading-snug text-ink-muted ${className}`}>
        {state.note}
      </p>
    );
  }
  return null;
}
