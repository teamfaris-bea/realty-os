// The one Undo toast of the app (R-ISA-15, E496). A module store, so the toast outlives the navigation a Take over
// makes (the person page → the thread) and the thread can hold the compose box's autofocus until it closes.
// The window is 10 s minus the request's round trip, counted from the moment the answer arrived; after a reload it is
// min(10 s, undoUntil − now) (clock skew can only shorten it, never show it past 10 s from the response).
import { useSyncExternalStore } from 'react';

export const UNDO_MS = 10_000;

export interface UndoToast {
  contactId: string;
  kind: 'take_over' | 'end';
  /** local ms when the window closes */
  closesAt: number;
  /** what to focus when the toast closes (the control that opened it), unless the compose box takes focus */
  returnFocus: HTMLElement | null;
  /** the toast was opened from the control in this session (announce and move focus); false after a reload */
  fresh: boolean;
  /** set by the person page's Take over: the thread's compose box takes focus when it closes */
  composeAfter: boolean;
}

let current: UndoToast | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function windowFromResponse(sentAt: number, receivedAt: number, undoUntilIso: string | null): number {
  if (!undoUntilIso) return receivedAt;
  const rtt = Math.max(0, receivedAt - sentAt);
  return receivedAt + Math.max(0, UNDO_MS - rtt);
}

export function windowFromPanel(undoUntilIso: string, now: number): number {
  return now + Math.min(UNDO_MS, Date.parse(undoUntilIso) - now);
}

export function openUndo(t: UndoToast): void {
  current = t;
  emit();
}

export function closeUndo(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function getUndo(): UndoToast | null {
  return current;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useUndo(): UndoToast | null {
  return useSyncExternalStore(subscribe, getUndo, getUndo);
}

/** True while an Undo toast is open (the thread holds the compose box's autofocus meanwhile). */
export function useUndoOpen(): boolean {
  return useUndo() !== null;
}

// ---- one host renders the toast -----------------------------------------------------------------------------------

let hosts: symbol[] = [];
const hostListeners = new Set<() => void>();
export function registerHost(id: symbol): () => void {
  hosts = [...hosts, id];
  for (const l of hostListeners) l();
  return () => {
    hosts = hosts.filter((h) => h !== id);
    for (const l of hostListeners) l();
  };
}
export function useIsFirstHost(id: symbol): boolean {
  return useSyncExternalStore(
    (l) => {
      hostListeners.add(l);
      return () => {
        hostListeners.delete(l);
      };
    },
    () => hosts[0] === id,
    () => hosts[0] === id,
  );
}

/** Tests only. */
export function resetUndoStore(): void {
  current = null;
  hosts = [];
  emit();
}
