// Buttons. Every control is at least 44 × 44 px (the `min-h-tap` token) so thumbs hit it on a
// phone. `pending` is an honest busy state: the button is disabled and says it is working; it
// never pretends progress that is not happening.
import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { Icon, type IconName } from './Icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

const BASE =
  'inline-flex min-h-tap min-w-tap select-none items-center justify-center gap-2 rounded-xl px-4 text-[17px] font-semibold leading-tight ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink active:brightness-95',
  secondary: 'border border-line bg-surface text-ink active:bg-surface-2',
  quiet: 'bg-transparent text-accent active:bg-accent-soft',
  danger: 'bg-danger text-surface active:brightness-95',
};

export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: IconName;
  pending?: boolean;
  /** what the button says while pending (default: the normal label) */
  pendingLabel?: string;
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', icon, pending = false, pendingLabel, block = false, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, `${block ? 'w-full' : ''} ${className}`)}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <Spinner /> : icon ? <Icon name={icon} size={20} /> : null}
      <span>{pending && pendingLabel ? pendingLabel : children}</span>
    </button>
  );
});

export function ButtonLink({ variant = 'primary', icon, className = '', children, ...rest }: LinkProps & { variant?: ButtonVariant; icon?: IconName }) {
  return (
    <Link className={buttonClass(variant, className)} {...rest}>
      {icon ? <Icon name={icon} size={20} /> : null}
      <span>{children}</span>
    </Link>
  );
}

/** A plain spinner for real in-flight work (aria-hidden: the control or region says "busy"). */
export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="animate-spin">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
