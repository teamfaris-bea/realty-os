// The follow-up of a stage step (R-STG-6; b19 fix pass M1, E773, E774): None, Tomorrow, 3 days, 1 week or a picked
// date. It is an ordinary task, made with an id created once, so a second tap or a retry answers the same task.
//
// What the screen says about the task is what the task routes ANSWERED, never what the chips show:
//   - before anything is saved the line is a plan ("Will add a task for you …") and the chips are free;
//   - once POST /tasks answered, the line is "Follow-up saved for <the answered task's date>" and the chips are
//     LOCKED: the server never rewrites a stored task when the same id is posted again, so a chip moved after the
//     save would only change the words;
//   - "Change" unlocks them, and each choice then really changes the stored task at once through its own route
//     (PATCH /tasks/:id with the new date, or status canceled for None). After a removal the next follow-up is a NEW
//     task with a new id;
//   - a retry after a LOST answer (the first POST was stored, nobody saw it) can meet a stored task with another date
//     than the one now chosen: the replay says so (`replayed`, and the stored date), and the sheet then changes the
//     task to the chosen date for real, or, when that is refused, shows the date that is stored and stops.
import { useCallback, useId, useRef, useState } from 'react';
import { Button, Notice, announce } from '../../design/index.js';
import { formatDateTime } from '../feed/lib/format.js';
import type { TaskView } from '../feed/lib/types.js';
import { Chip, selectClass, usePersonAction } from './hooks.js';

const FOLLOW_UPS = [
  { key: 'none', label: 'None', days: 0 },
  { key: 'tomorrow', label: 'Tomorrow', days: 1 },
  { key: '3d', label: '3 days', days: 3 },
  { key: '1w', label: '1 week', days: 7 },
  { key: 'pick', label: 'Pick a date', days: 0 },
] as const;
type FollowUpKey = (typeof FOLLOW_UPS)[number]['key'];

/** 9:00 in the morning, local time, `days` from today. */
export function morningIn(days: number, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The task as a task route answered it: the only source of what the screen says was saved. */
export type StoredFollowUp = Pick<TaskView, 'id' | 'title' | 'dueAt' | 'status'>;

/** "Follow-up saved for Fri, Nov 20, 9:00 AM", from the stored task. */
export function followUpSavedText(t: StoredFollowUp): string {
  return t.dueAt ? `Follow-up saved for ${formatDateTime(t.dueAt)}` : 'Follow-up saved';
}

const sameInstant = (a: string | null, b: string) => a !== null && Date.parse(a) === Date.parse(b);

export type FollowUpSave = { ok: true; task: StoredFollowUp | null } | { ok: false };

export function useFollowUp(contactId: string, firstName: string) {
  const [key, setKey] = useState<FollowUpKey>('none');
  const [picked, setPicked] = useState(() => localInput(morningIn(1)));
  // the task as the server last answered it (null: none saved, or the saved one was removed)
  const [stored, setStored] = useState<StoredFollowUp | null>(null);
  const [changing, setChanging] = useState(false);
  const [removed, setRemoved] = useState(false);
  // R-STG-6: one id per task this sheet makes; a new one only after the server confirmed the old task was removed
  const taskId = useRef<string>(globalThis.crypto.randomUUID());
  const post = usePersonAction<{ task: TaskView; replayed: boolean }>(contactId);
  const patch = usePersonAction<{ task: TaskView }>(contactId);
  const title = `Follow up with ${firstName}`;

  const dueOf = (k: FollowUpKey): Date | null => (k === 'none' ? null : k === 'pick' ? new Date(picked) : morningIn(FOLLOW_UPS.find((f) => f.key === k)!.days));
  const due = stored ? null : dueOf(key);
  const dueOk = due === null || Number.isFinite(due.getTime());
  const pickedOk = Number.isFinite(new Date(picked).getTime());

  /** Really changes the stored task (its own route); the words follow from the answer. */
  const change = useCallback(
    async (to: Date | null): Promise<boolean> => {
      if (!stored) return false;
      const r = await patch.run('PATCH', `/tasks/${stored.id}`, to === null ? { status: 'canceled' } : { dueAt: to.toISOString() });
      if (!r.ok) return false;
      if (r.data.task.status === 'open') {
        setStored(r.data.task);
        setRemoved(false);
        announce(`${followUpSavedText(r.data.task)}.`);
      } else {
        announce('Follow-up removed.');
        // removed for real: whatever is chosen next is another task
        setStored(null);
        setRemoved(true);
        setKey('none');
        taskId.current = globalThis.crypto.randomUUID();
      }
      setChanging(false);
      return true;
    },
    [patch, stored],
  );

  /**
   * Called by the sheet's primary button, before the stage change. Saves the chosen follow-up once; answers the task
   * the server stored (null: none chosen). Not ok: nothing may be claimed and the sheet stays open.
   */
  const save = useCallback(async (): Promise<FollowUpSave> => {
    if (stored) return { ok: true, task: stored };
    if (!due) return { ok: true, task: null };
    const want = due.toISOString();
    const r = await post.run('POST', '/tasks', { id: taskId.current, title, kind: 'follow_up', contactId, dueAt: want });
    if (!r.ok) return { ok: false };
    let task: TaskView = r.data.task;
    if (r.data.replayed && !sameInstant(task.dueAt, want)) {
      // an earlier request of this sheet stored another date and its answer was lost: change the task for real
      const p = await patch.run('PATCH', `/tasks/${task.id}`, { dueAt: want });
      if (!p.ok) {
        setStored(task);
        setRemoved(false);
        return { ok: false };
      }
      task = p.data.task;
    }
    setStored(task);
    setRemoved(false);
    return { ok: true, task };
  }, [contactId, due, patch, post, stored, title]);

  const pick = (k: FollowUpKey) => {
    if (!stored) {
      setRemoved(false);
      setKey(k);
      return;
    }
    // a saved task: the choice is applied to it at once (a picked date waits for its own button)
    setKey(k);
    if (k !== 'pick') void change(dueOf(k));
  };

  return {
    key,
    pick,
    picked,
    setPicked,
    pickedOk,
    stored,
    changing,
    setChanging,
    removed,
    title,
    /** the date a not-yet-saved choice asks for (null: none, or a task is already saved) */
    due,
    dueOk,
    /** the primary button will also make the task */
    willAdd: stored === null && due !== null,
    applyPicked: () => (pickedOk ? change(new Date(picked)) : Promise.resolve(false)),
    save,
    working: post.pending || patch.pending,
    error: post.error ?? patch.error,
  };
}

export type FollowUpState = ReturnType<typeof useFollowUp>;

export function FollowUpChips({ f, disabled = false }: { f: FollowUpState; disabled?: boolean }) {
  const ids = { label: useId(), pick: useId() };
  const locked = f.stored !== null && !f.changing;
  const off = disabled || f.working || locked;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3">
        <p id={ids.label} className="text-[15px] font-medium text-ink">
          Follow-up
        </p>
        {locked ? (
          <Button variant="quiet" className="px-2" aria-label="Change follow-up" disabled={disabled || f.working} onClick={() => f.setChanging(true)}>
            Change
          </Button>
        ) : null}
      </div>
      <div role="group" aria-labelledby={ids.label} className="flex flex-wrap gap-1.5">
        {FOLLOW_UPS.map((c) => (
          <Chip key={c.key} compact selected={!f.stored && f.key === c.key} disabled={off} onClick={() => f.pick(c.key)}>
            {c.label}
          </Chip>
        ))}
      </div>
      {f.key === 'pick' && !locked ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.pick} className="text-[15px] font-medium text-ink">
            Follow up on
          </label>
          <input id={ids.pick} type="datetime-local" value={f.picked} onChange={(e) => f.setPicked(e.target.value)} className={selectClass} aria-invalid={!f.pickedOk || undefined} />
          {f.stored ? (
            <Button variant="secondary" className="self-start" pending={f.working} disabled={!f.pickedOk || disabled} onClick={() => void f.applyPicked()}>
              Save this date
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="text-[14px] leading-snug text-ink-muted [overflow-wrap:anywhere]" data-testid="follow-up-line">
        {f.stored
          ? `${followUpSavedText(f.stored)}.${f.changing ? ' Pick another time to change it, or None to remove it.' : ''}`
          : f.due && f.dueOk
            ? `Will add a task for you: “${f.title}”, due ${formatDateTime(f.due.toISOString())}.`
            : f.key === 'pick'
              ? 'Pick a date and time.'
              : `${f.removed ? 'Follow-up removed. ' : ''}No follow-up task.`}
      </p>
      {f.error ? <Notice tone="error">{f.error}</Notice> : null}
    </div>
  );
}
