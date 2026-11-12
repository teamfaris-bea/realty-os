// Small pieces shared by the Lead sources pages: a value to copy (read-only field + one-tap Copy with an announced
// "Copied", and a fallback that selects the text when the clipboard is refused), and a path section that opens and
// closes (a <details> card whose summary says the path's state in words).
import { type ReactNode, useId, useRef } from 'react';
import { Button, TextField } from '../../design/index.js';
import { useAnnounce } from '../admin/lib/hooks.js';
import { Pill } from '../admin/lib/ui.js';
import { type ChipState, chipTone } from './words.js';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyField({ label, value, hint, mono = true }: { label: string; value: string; hint?: ReactNode; mono?: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  const [status, announce] = useAnnounce(5000);
  const copy = async () => {
    if (await copyText(value)) announce('Copied');
    else {
      field.current?.select();
      announce("Couldn't copy here. It is selected: copy it from the field.");
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <TextField ref={field} label={label} value={value} readOnly spellCheck={false} className={`min-w-0 sm:flex-1 ${mono ? '[&_input]:font-mono [&_input]:text-[15px]' : ''}`} onFocus={(e) => e.currentTarget.select()} hint={hint} />
        <Button variant="secondary" onClick={() => void copy()} aria-label={`Copy the ${label.toLowerCase()}`}>
          Copy
        </Button>
      </div>
      <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] text-ok">
        {status ?? ''}
      </p>
    </div>
  );
}

/** One path of a source: a card that opens; its summary is the path's name and its state in words. */
export function PathSection({ id, title, state, open, children }: { id: string; title: string; state: ChipState; open: boolean; children: ReactNode }) {
  const hid = useId();
  return (
    <details id={id} open={open} className="group rounded-2xl border border-line bg-surface" aria-labelledby={hid}>
      <summary className="flex min-h-tap cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 [&::-webkit-details-marker]:hidden">
        <h2 id={hid} className="min-w-0 flex-1 text-[18px] font-semibold text-ink">
          {title}
        </h2>
        <Pill tone={chipTone(state)}>{state}</Pill>
        <span aria-hidden="true" className="text-ink-muted transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-4 pb-4 pt-3">{children}</div>
    </details>
  );
}

export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-6 text-[15px] text-ink">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ol>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-[15px] text-ink-muted">{children}</p>;
}
