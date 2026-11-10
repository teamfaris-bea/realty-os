// BUILD_PLAN module 5 acceptance: a 200-item feed scores in < 5 ms; exception derivation over 10k
// contacts runs in < 200 ms in core. Timed as the median of several runs after a warm-up, so one GC
// pause on a loaded CI box does not fail the build.
import { describe, expect, it } from 'vitest';
import { deriveExceptions, scoreFeed } from './index.js';
import { apptF, busyFeed, contact, exceptionInputs, hours, min, msg, outbound, sla, t, task, taskF } from './testing/fixtures.js';

// core has no ambient DOM/Node types (tsconfig "types": []); the timer exists in every runtime.
declare const performance: { now(): number };

function medianMs(fn: () => unknown, runs: number): number {
  for (let k = 0; k < 3; k++) fn();
  const times: number[] = [];
  for (let k = 0; k < runs; k++) {
    const s = performance.now();
    fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)] as number;
}

describe('performance (acceptance)', () => {
  it('a 200-item feed scores in < 5 ms', () => {
    const input = busyFeed(190);
    const items = scoreFeed(input);
    expect(items.length).toBeGreaterThanOrEqual(150);
    const ms = medianMs(() => scoreFeed(input), 21);
    expect(ms).toBeLessThan(5);
  });

  it('exception derivation over 10k contacts runs in < 200 ms (and with the stored queue too)', () => {
    const n = 10_000;
    const i = exceptionInputs({
      ownedWithSla: Array.from({ length: n }, (_, k) => sla({ contactId: contact(k), periodSeq: k, firstTouchDueAt: t(-min(k % 60) + min(30)), firstTouchAt: k % 3 === 0 ? t(-min(1)) : null })),
      promiseTasks: Array.from({ length: n }, (_, k) => taskF({ taskId: task(k), contactId: contact(k), kind: 'promise', dueAt: t(hours((k % 48) - 24)) })),
      outbound: Array.from({ length: n }, (_, k) => outbound({ messageId: msg(k), contactId: contact(k), status: k % 10 === 0 ? 'failed' : 'delivered' })),
      appointments: Array.from({ length: n / 2 }, (_, k) => apptF({ appointmentId: `f1000000-0000-7000-8000-${k.toString(16).padStart(12, '0')}` as never, contactId: contact(k), endsAt: t(-hours(k % 6)) })),
    });
    const first = deriveExceptions(i);
    expect(first.upserts.length).toBeGreaterThan(5_000);
    expect(medianMs(() => deriveExceptions(i), 5)).toBeLessThan(200);
    const existing = first.upserts;
    expect(deriveExceptions({ ...i, existing }).upserts).toEqual([]);
    expect(medianMs(() => deriveExceptions({ ...i, existing }), 5)).toBeLessThan(200);
  });
});
