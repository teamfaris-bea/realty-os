// "Log a call or conversation" from any screen (R-TODAY-9). ONE small entry point: a button in every page's header,
// beside the global "+", registered through the shell's header-action slot (feed/index.ts). The "+" itself stays a
// one-tap link to Add person. Everything behind the button (the person picker and the Log sheet) is loaded when it is
// first opened, so the header costs every page almost nothing, and a change of navigation only moves this one button.
//
//   the entry → a person → an outcome → the one button = 4 taps (typing a name is not a tap)
//
// The sheet is the person page's own Log sheet (notes/LogSheet.tsx) with its stage step: nothing is forked. What is
// saved is the agent's own report of something that happened outside the app, with a client id (a double tap or a
// retry is one record); it is never a call the system placed.
//
// A Transaction Coordinator may not log an activity (core authz `activity.log`), so the entry is not shown to one.
// The server still decides for each person: a refusal is said in the sheet, in its own words.
import { Suspense, lazy, useState } from 'react';
import { useSession } from '../../shell/index.js';

const QuickLogSheet = lazy(() => import('./QuickLogSheet.js'));

export const QUICK_LOG_LABEL = 'Log a call or conversation';

export function QuickLogEntry() {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  if (!session?.tenant || session.tenant.role === 'tc') return null;
  return (
    // (the toast that says the result is the page's own: the feed surface registers it around the whole frame)
    <>
      <button
        type="button"
        aria-label={QUICK_LOG_LABEL}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center whitespace-nowrap rounded-xl px-2 text-[15px] font-semibold text-accent"
      >
        Log<span className="hidden md:inline">&nbsp;a call</span>
      </button>
      {open ? (
        <Suspense fallback={null}>
          <QuickLogSheet title={QUICK_LOG_LABEL} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
