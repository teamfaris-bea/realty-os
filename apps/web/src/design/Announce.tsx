// Screen-reader announcements (WCAG 4.1.3 Status Messages).
// - <Announcer/> is one polite live region; `announce(text)` speaks through it without moving focus.
//   Toasts ("Accepted", "Saved") use it, so they are heard, not only seen.
// - countdownMilestone() decides when a live countdown is worth saying aloud: at a few thresholds
//   (5, 2 and 1 minutes, 30 and 10 seconds, and the end), never once a second. A countdown keeps its
//   visual tick and role="timer" (which is not live), and calls announce() when the milestone changes.
import { useEffect, useRef, useState } from 'react';

type Listener = (text: string) => void;
const listeners = new Set<Listener>();

/** Says `text` politely through the mounted <Announcer/> (a no-op when none is mounted). */
export function announce(text: string): void {
  for (const l of listeners) l(text);
}

export function Announcer() {
  const [text, setText] = useState('');
  useEffect(() => {
    const l: Listener = (t) => {
      // clear first so the same sentence twice in a row is still announced
      setText('');
      requestAnimationFrame(() => setText(t));
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}

const MILESTONES_S = [300, 120, 60, 30, 10, 0] as const;

/** The milestone a countdown with `msLeft` remaining has reached, or null before the first one. */
export function countdownMilestone(msLeft: number): number | null {
  const s = Math.ceil(msLeft / 1000);
  for (const m of [...MILESTONES_S].reverse()) if (s <= m) return m;
  return null;
}

/** Words for a milestone: "5 minutes left", "30 seconds left", "Time is up". */
export function milestoneWords(m: number): string {
  if (m <= 0) return 'Time is up';
  if (m >= 60) return `${m / 60} minute${m === 60 ? '' : 's'} left`;
  return `${m} seconds left`;
}

/**
 * Announces a live countdown politely when it crosses a milestone. `label` names what is counting
 * down ("Offer for Priya Shah"). Nothing is said for the milestone already reached when it mounts.
 */
export function useCountdownAnnouncement(label: string, msLeft: number): void {
  const last = useRef<number | null | undefined>(undefined);
  const m = countdownMilestone(msLeft);
  useEffect(() => {
    if (last.current === undefined) {
      last.current = m;
      return;
    }
    if (m !== null && m !== last.current) announce(`${label}: ${milestoneWords(m)}`);
    last.current = m;
  }, [label, m]);
}
