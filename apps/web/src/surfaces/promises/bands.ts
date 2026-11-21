// Open promises, earliest due first, in the bands the screen shows.
import type { TaskView } from '../feed/lib/types.js';
import { type TaskGroup, groupOf } from '../tasks/TasksPage.js';

export const BAND_TITLE: Record<TaskGroup, string> = {
  overdue: 'Overdue',
  today: 'Today',
  later: 'Upcoming',
  undated: 'No date',
};

export interface PromiseBand {
  key: TaskGroup;
  title: string;
  tasks: TaskView[];
}

/** Overdue, then today, then upcoming, then no date. Within a band, the soonest due is first. */
export function promiseBands(tasks: readonly TaskView[], now: number): PromiseBand[] {
  const groups: Record<TaskGroup, TaskView[]> = { overdue: [], today: [], later: [], undated: [] };
  const sorted = [...tasks].sort((a, b) => {
    const ad = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const bd = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    return ad - bd;
  });
  for (const t of sorted) groups[groupOf(t, now)].push(t);
  return (['overdue', 'today', 'later', 'undated'] as const)
    .filter((k) => groups[k].length > 0)
    .map((k) => ({ key: k, title: BAND_TITLE[k], tasks: groups[k] }));
}
