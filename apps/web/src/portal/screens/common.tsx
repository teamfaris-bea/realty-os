// module 46: the portal's page frame and its focus rule (focus moves to each screen's h1; WCAG 2.4.3).
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';

export function useFocusHeading<T extends HTMLElement = HTMLHeadingElement>(key: unknown = null): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, [key]);
  return ref;
}

export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main id="main" className={`mx-auto flex w-full flex-col gap-4 px-4 pb-10 pt-6 ${wide ? 'max-w-5xl' : 'max-w-[640px]'}`}>
      {children}
    </main>
  );
}

export function H1({ children, headingRef }: { children: ReactNode; headingRef: RefObject<HTMLHeadingElement> }) {
  return (
    <h1 ref={headingRef} tabIndex={-1} className="text-[26px] font-bold leading-tight text-ink outline-none md:text-[30px]">
      {children}
    </h1>
  );
}

export const primaryButton =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded-xl bg-accent px-5 text-[17px] font-semibold text-accent-ink disabled:opacity-60';
export const secondaryButton =
  'inline-flex min-h-tap min-w-tap items-center justify-center rounded-xl border border-line bg-surface px-4 text-[16px] font-semibold text-accent disabled:opacity-60';
