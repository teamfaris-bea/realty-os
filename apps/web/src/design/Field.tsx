// Form fields: a visible label (never placeholder-only), hint and error text wired with
// aria-describedby, and 17 px text so iOS Safari does not zoom the page on focus.
import { type InputHTMLAttributes, type ReactNode, forwardRef, useId } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({ label, hint, error, className = '', ...rest }, ref) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[15px] font-medium text-ink">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          'min-h-tap w-full rounded-xl border bg-surface px-3.5 text-[17px] text-ink placeholder:text-ink-muted ' +
          (error ? 'border-danger' : 'border-line')
        }
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="text-[14px] text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="text-[14px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});
