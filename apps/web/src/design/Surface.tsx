// Layout primitives: Card, Notice (inline banner), PageHeader, EmptyState and Ratio.
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export function Card({ children, className = '', as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' | 'li'; 'aria-labelledby'?: string }) {
  return (
    <As className={`rounded-2xl border border-line bg-surface p-4 ${className}`} {...rest}>
      {children}
    </As>
  );
}

export type NoticeTone = 'info' | 'warn' | 'error' | 'ok';

const NOTICE: Record<NoticeTone, { cls: string; icon: IconName }> = {
  info: { cls: 'bg-accent-soft text-ink', icon: 'info' },
  warn: { cls: 'bg-warn-soft text-ink', icon: 'alert' },
  error: { cls: 'bg-danger-soft text-ink', icon: 'alert' },
  ok: { cls: 'bg-ok-soft text-ink', icon: 'check' },
};

/**
 * An inline message. Errors use role="alert" (announced at once); other tones are a polite status.
 */
export function Notice({ tone = 'info', title, children, action }: { tone?: NoticeTone; title?: string; children?: ReactNode; action?: ReactNode }) {
  const n = NOTICE[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-xl px-3.5 py-3 text-[15px] ${n.cls}`}>
      <span className={tone === 'error' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-accent'}>
        <Icon name={n.icon} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="leading-snug">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({ icon = 'info', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="text-ink-muted">
        <Icon name={icon} size={32} />
      </span>
      <p className="text-[17px] font-semibold text-ink">{title}</p>
      {children ? <div className="max-w-sm text-[15px] text-ink-muted">{children}</div> : null}
    </div>
  );
}

/**
 * A number with its denominator ("12 of 14 within SLA"). Every metric the product displays shows
 * what it is out of (R-ACC-4 display half; the numbers themselves come from DB views). There is no
 * way to render a bare count or a percentage with this component.
 */
export function Ratio({ value, of, label, className = '' }: { value: number; of: number; label: string; className?: string }) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const safeOf = Number.isFinite(of) ? Math.max(0, Math.trunc(of)) : 0;
  return (
    <span className={className}>
      <span className="font-semibold tabular-nums">{safeValue}</span> of <span className="tabular-nums">{safeOf}</span> {label}
    </span>
  );
}
