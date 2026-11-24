import { describe, expect, it } from 'vitest';
import type { TaskView } from '../feed/lib/types.js';
import { promiseBands } from './bands.js';

function task(id: string, dueAt: string | null): TaskView {
  return {
    id,
    kind: 'promise',
    title: id,
    notes: null,
    dueAt,
    dueAllDay: false,
    dueTz: null,
    status: 'open',
    completedAt: null,
    assigneeUserId: 'me',
    contact: { id: 'c', name: 'Sam Lee' },
    dealId: null,
    listingId: null,
    createdByKind: 'user',
    needsReview: false,
    source: null,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
}

describe('promise bands', () => {
  const now = new Date(2026, 10, 21, 9, 0).getTime();

  it('puts overdue first, then today, then upcoming, soonest due first inside a band', () => {
    const bands = promiseBands(
      [
        task('later', new Date(2026, 10, 23, 9).toISOString()),
        task('soon', new Date(2026, 10, 21, 8).toISOString()),
        task('later-today', new Date(2026, 10, 21, 18).toISOString()),
        task('older', new Date(2026, 10, 20, 9).toISOString()),
        task('none', null),
      ],
      now,
    );
    expect(bands.map((b) => [b.title, b.tasks.map((t) => t.id)])).toEqual([
      ['Overdue', ['older', 'soon']],
      ['Today', ['later-today']],
      ['Upcoming', ['later']],
      ['No date', ['none']],
    ]);
  });
});
