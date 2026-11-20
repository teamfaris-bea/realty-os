// The replace-a-task rule (b19 Today fix 1: H1, M2, M3; R-TODAY-11). Stated ONCE, here; every one-pass sheet (the Log
// sheet, the stage step after a call or a text) reads it and words what it will do from its answer BEFORE the tap.
//
// When an agent logs a call or conversation from a follow-up card and sets a new follow-up, the task the card was
// about may be marked done by the same tap, but only when ALL of these hold:
//
//   1. it is the card's OWN task (the task the card or row is about), never another task of the person;
//   2. its kind is `follow_up` or `callback` (a promise, a to-do or anything else is the agent's to close);
//   3. its deadline has PASSED (a follow-up due tomorrow is still the plan: logging today does not finish it);
//   4. the new follow-up is LATER than it (a picked date at or before the old deadline replaces nothing).
//
// Otherwise the old task is left open. When it is a follow-up or callback of the card's and a new follow-up is still
// being added, the person will have two open follow-ups, and the sheet says so (`twoFollowUps`).
//
// Pure: instants are epoch milliseconds, `now` is the caller's. Nothing here closes anything; the sheet closes the old
// task LAST, after the log, the follow-up and the stage have saved.

/** The only kinds of task a new follow-up may replace. */
export const REPLACEABLE_TASK_KINDS = ['follow_up', 'callback'] as const;

export interface TaskReplacementInput {
  /** the task the sheet knows about; null: it was not opened from a card with a task */
  task: {
    /** the card or row the sheet was opened from is about this very task */
    isCardTask: boolean;
    /** tasks.kind */
    kind: string;
    /** when it stops being on time (an all-day task: the end of its local day); null: undated */
    deadline: number | null;
  } | null;
  /** when the new follow-up will be due; null: none is being added */
  newDueAt: number | null;
  now: number;
}

export type TaskReplacement =
  | { replace: true }
  | {
      replace: false;
      why: 'no_task' | 'no_new_follow_up' | 'not_the_cards_task' | 'not_a_follow_up' | 'not_due' | 'new_not_later';
      /** the old follow-up stays open beside the new one: the sheet says the person will have two */
      twoFollowUps: boolean;
    };

export function decideTaskReplacement(i: TaskReplacementInput): TaskReplacement {
  const no = (why: Exclude<TaskReplacement, { replace: true }>['why'], twoFollowUps = false): TaskReplacement => ({ replace: false, why, twoFollowUps });
  const t = i.task;
  if (t === null) return no('no_task');
  if (i.newDueAt === null) return no('no_new_follow_up');
  if (!t.isCardTask) return no('not_the_cards_task');
  if (!(REPLACEABLE_TASK_KINDS as readonly string[]).includes(t.kind)) return no('not_a_follow_up');
  if (t.deadline === null || !(i.now >= t.deadline)) return no('not_due', true);
  if (!(i.newDueAt > t.deadline)) return no('new_not_later', true);
  return { replace: true };
}
