// The phone's working bar on the person's page (owner brief 2026-11-19: "Call, Text, Log Outcome, and Next Follow-up
// easy to reach with one thumb"): Call · Text · Log · Next · Note.
//
// - Five targets in one row, each at least 44 px high, fixed above the tab bar and the home-indicator safe area. It
//   publishes its height (PERSON_BAR_VAR) so the AI care bar stacks above it, never over it, and is marked data-sticky
//   so the page's scroll padding and the accessibility sweep account for it.
// - Call and Text read the same reachability summary as the header's Call and Text (GET /contacts/:id/reachability):
//   blocked, or with no phone on file, they are disabled and the exact reason is one line above the buttons
//   ("Text is off: Texted STOP on Nov 10"). Nothing here can call or text past an opt-out; the send and the dial are
//   checked again by the server. The header's Call and Text are the same actions, so these two are named with the
//   person ("Call Jane Doe") and assistive tech can tell them apart.
// - Next opens the follow-up dialog. Log and Note open their sheets.
// - While a text field has focus (the on-screen keyboard is up) the bar steps out of the way: it fades out and lets
//   taps through, but its buttons stay in the document, so a sheet that closes hands focus back to the button that
//   opened it, and that focus brings the bar back.
import { type RefCallback, useEffect, useId, useState } from 'react';
import { Button, useStickyBottom } from '../../design/index.js';
import { channelState, useReachability } from '../../reasons/index.js';
import { isMergedAway } from '../contact/MergedAway.js';
import type { ContactFullView } from '../feed/lib/types.js';

/** The bar's own height on <html>: a bar stacked above it on the person page (AI care) offsets by it. */
export const PERSON_BAR_VAR = '--person-bar-h';

/**
 * The bar's ref: it measures the bar and publishes its height (b13 review F3-ui). Call it in the component that
 * decides whether the bar is shown, on every render, and hand the result to <PhoneBar barRef>: the measuring hook
 * must outlive the bar's own mount (React's development StrictMode re-runs a new component's effects, which would
 * otherwise drop the height the ref had just published).
 */
export function usePhoneBarRef(): RefCallback<HTMLDivElement> {
  return useStickyBottom<HTMLDivElement>({ stackVar: PERSON_BAR_VAR });
}

const NOT_TYPED = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/** Whether the focused element takes typing (so a phone has its keyboard up). */
export function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NOT_TYPED.has(el.type);
  return el instanceof HTMLElement && (el.isContentEditable === true || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '');
}

/** True while a text field has focus anywhere on the page (a sheet's field included). */
export function useTypingFocus(): boolean {
  const [typing, setTyping] = useState(() => (typeof document === 'undefined' ? false : isTextField(document.activeElement)));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => setTyping(isTextField(document.activeElement));
    const onIn = () => {
      if (timer) clearTimeout(timer);
      read();
    };
    // focus leaving one field for the next passes through <body>: wait a tick so the bar does not flash
    const onOut = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 0);
    };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return typing;
}

export interface PhoneBarProps {
  contact: Pick<ContactFullView, 'id' | 'displayName' | 'phones' | 'merged' | 'mergedIntoContactId'>;
  /** usePhoneBarRef() of the parent */
  barRef: RefCallback<HTMLDivElement>;
  onCall(): void;
  onText(): void;
  onLog(): void;
  onNext(): void;
  onNote(): void;
}

const cell = 'w-full min-w-0 px-1 text-[16px]';

export function PhoneBar({ contact, barRef, onCall, onText, onLog, onNext, onNote }: PhoneBarProps) {
  const typing = useTypingFocus();
  const id = useId();
  const reach = useReachability(contact.id);
  const voice = channelState(reach, 'voice');
  const sms = channelState(reach, 'sms');
  const merged = isMergedAway(contact);
  const noPhone = contact.phones.length === 0;
  // one reason per button, in the words the header's captions use
  const all = merged ? 'This record was merged into another.' : noPhone ? 'No phone number on file.' : null;
  const callWhy = all ?? (voice.blocked ? `Call is off: ${voice.sentence ?? 'they asked not to be called'}` : null);
  const textWhy = all ?? (sms.blocked ? `Text is off: ${sms.sentence ?? 'they opted out of texts'}` : null);
  return (
    <div
      ref={barRef}
      data-sticky
      data-testid="person-phone-bar"
      data-typing={typing ? 'true' : undefined}
      className={`fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-20 border-t border-line bg-surface/95 px-2 py-2 backdrop-blur transition-opacity md:hidden ${typing ? 'pointer-events-none opacity-0' : ''}`}
    >
      {all ? (
        <p id={`${id}-all`} className="mx-auto max-w-2xl px-1 pb-1.5 text-[13px] leading-snug text-ink [overflow-wrap:anywhere]">
          {all}
        </p>
      ) : null}
      {!all && callWhy ? (
        <p id={`${id}-call`} className="mx-auto max-w-2xl px-1 pb-1.5 text-[13px] leading-snug text-ink [overflow-wrap:anywhere]">
          {callWhy}
        </p>
      ) : null}
      {!all && textWhy ? (
        <p id={`${id}-text`} className="mx-auto max-w-2xl px-1 pb-1.5 text-[13px] leading-snug text-ink [overflow-wrap:anywhere]">
          {textWhy}
        </p>
      ) : null}
      <div className="mx-auto grid max-w-2xl grid-cols-5 gap-1.5">
        <Button className={cell} disabled={callWhy !== null} aria-label={`Call ${contact.displayName}`} aria-describedby={callWhy ? (all ? `${id}-all` : `${id}-call`) : undefined} onClick={onCall}>
          Call
        </Button>
        <Button variant="secondary" className={cell} disabled={textWhy !== null} aria-label={`Text ${contact.displayName}`} aria-describedby={textWhy ? (all ? `${id}-all` : `${id}-text`) : undefined} onClick={onText}>
          Text
        </Button>
        <Button variant="secondary" className={cell} onClick={onLog}>
          Log
        </Button>
        <Button variant="secondary" className={cell} aria-label="Next follow-up" onClick={onNext}>
          Next
        </Button>
        <Button variant="secondary" className={cell} onClick={onNote}>
          Note
        </Button>
      </div>
    </div>
  );
}
