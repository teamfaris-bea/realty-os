// Small layout and form pieces shared by the lead-admin surfaces. They follow the design system:
// visible labels (never placeholder-only), 17 px inputs so iOS does not zoom, 44 px tap targets, and
// state said in words as well as color.
import { type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';
import { Notice } from '../../../design/index.js';

const INPUT = 'min-h-tap w-full rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink';

/** A titled block of a page (h2 + optional one-line description + actions on the right). */
export function Section({ title, description, actions, children, id }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section aria-labelledby={hid} className="flex flex-col gap-3" id={id}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={hid} className="text-[20px] font-semibold text-ink">
            {title}
          </h2>
          {description ? <p className="text-[15px] text-ink-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function SelectField({ label, hint, children, className = '', ...rest }: { label: string; hint?: ReactNode; children: ReactNode; className?: string } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[15px] font-medium text-ink">
        {label}
      </label>
      <select id={id} className={INPUT} aria-describedby={hint ? `${id}-hint` : undefined} {...rest}>
        {children}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="text-[14px] text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextArea({ label, hint, className = '', ...rest }: { label: string; hint?: ReactNode; className?: string } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[15px] font-medium text-ink">
        {label}
      </label>
      <textarea id={id} className="min-h-[88px] w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink" aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      {hint ? (
        <p id={`${id}-hint`} className="text-[14px] text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A checkbox row: the whole row (box and label) is one 44 px target; an optional explanation sits under it. */
export function Check({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className={`flex min-h-tap items-center gap-3 text-[16px] text-ink ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <input id={id} type="checkbox" className="h-[22px] w-[22px] shrink-0 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
        <span>{label}</span>
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="pl-[34px] text-[14px] text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A segmented control (a radio group that looks like iOS segments). */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex max-w-full overflow-x-auto rounded-xl bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-tap shrink-0 rounded-lg px-3 text-[15px] font-medium ${value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "Saved." etc. Announced politely; renders nothing when empty. */
export function StatusLine({ text }: { text: string | null }) {
  return (
    <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] text-ok">
      {text ?? ''}
    </p>
  );
}

export function ErrorLine({ message }: { message: string | null | undefined }) {
  return message ? <Notice tone="error">{message}</Notice> : null;
}

/**
 * The honest legal banner (Phase 1 exit criterion 6, ARCHITECTURE §19): legal defaults are strict,
 * but say plainly when no lawyer has reviewed them. VERIFY WITH COUNSEL.
 */
export function CounselBanner({ reviewed, children }: { reviewed: boolean; children?: ReactNode }) {
  if (reviewed) return <Notice tone="ok" title="Reviewed by counsel">{children}</Notice>;
  return (
    <Notice tone="warn" title="Not reviewed by counsel">
      These settings ship with strict defaults, but no lawyer has reviewed them for the states you work in. Have your counsel review them before you rely on them.
      {children ? <div className="mt-1">{children}</div> : null}
    </Notice>
  );
}

/** A label: value line used in read-only summaries. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="text-[15px] text-ink-muted sm:w-56 sm:shrink-0">{label}</dt>
      <dd className="text-[16px] text-ink">{children}</dd>
    </div>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode }) {
  const cls = {
    neutral: 'bg-surface-2 text-ink',
    ok: 'bg-ok-soft text-ink',
    warn: 'bg-warn-soft text-ink',
    danger: 'bg-danger-soft text-ink',
    accent: 'bg-accent-soft text-ink',
  }[tone];
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[13px] font-semibold ${cls}`}>{children}</span>;
}

export function Loading() {
  return <p className="text-[15px] text-ink-muted">Loading</p>;
}
