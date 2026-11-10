import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import {
  DEFAULT_EXCEPTION_SETTINGS,
  EXCEPTION_RULE_VERSION,
  ExceptionItemSpecSchema,
  type ExceptionInputs,
  type ExceptionItemSpec,
  deriveExceptions,
  statusReasonWords,
} from './index.js';
import { ME, NOW, NY, OTHER, apptF, call, contact, exceptionInputs, hours, min, msg, outbound, shuffled, sla, t, task, taskF } from './testing/fixtures.js';

const keys = (r: { upserts: ExceptionItemSpec[] }) => r.upserts.map((x) => x.dedupeKey);
const only = (i: ExceptionInputs): ExceptionItemSpec => {
  const r = deriveExceptions(i);
  expect(r.upserts).toHaveLength(1);
  return r.upserts[0] as ExceptionItemSpec;
};

/** Applies a derivation to a stored queue the way the API does (upsert by key; clear sets now if null). */
function apply(stored: ExceptionItemSpec[], r: ReturnType<typeof deriveExceptions>, now: number): ExceptionItemSpec[] {
  const m = new Map(stored.map((x) => [x.dedupeKey, x]));
  for (const u of r.upserts) {
    const prev = m.get(u.dedupeKey);
    m.set(u.dedupeKey, prev !== undefined && prev.conditionClearedAt !== null && u.conditionClearedAt !== null ? { ...u, conditionClearedAt: prev.conditionClearedAt } : u);
  }
  for (const k of r.cleared) {
    const prev = m.get(k);
    if (prev !== undefined && prev.conditionClearedAt === null) m.set(k, { ...prev, conditionClearedAt: now as never });
  }
  return [...m.values()];
}

describe('R-ACC-2 untouched_lead', () => {
  const due = t(-min(1));

  it('R-ACC-2: a period with no human touch by its deadline is an item owned by that period’s agent, detected at the deadline', () => {
    const s = only(exceptionInputs({ ownedWithSla: [sla({ firstTouchDueAt: due, ownedAt: t(-min(16)) })] }));
    expect(s).toMatchObject({
      itemType: 'untouched_lead',
      subjectType: 'contact',
      subjectId: contact(2),
      contactId: contact(2),
      ownerUserId: ME,
      detectedAt: due,
      dueAt: due,
      conditionClearedAt: null,
      ruleVersion: EXCEPTION_RULE_VERSION,
      dedupeKey: `untouched:${contact(2)}:4`,
    });
    expect(s.evidence.map((e) => e.explanation)).toEqual(['No human call, text or email by the first-contact deadline', 'Lead became theirs']);
  });

  it('R-ACC-2: not yet due, touched in time, or ended before the deadline is not an exception', () => {
    const r = deriveExceptions(
      exceptionInputs({
        ownedWithSla: [
          sla({ periodSeq: 1, firstTouchDueAt: t(min(1)) }),
          sla({ periodSeq: 3, firstTouchDueAt: due, firstTouchAt: due }),
          sla({ periodSeq: 4, firstTouchDueAt: due, periodEndedAt: t(-min(2)) }),
        ],
      }),
    );
    expect(r.upserts).toEqual([]);
    expect(r.cleared).toEqual([1, 3, 4].map((n) => `untouched:${contact(2)}:${n}`));
    // R-OWN-13 writes the breach at the due instant, so at exactly the deadline it is a miss.
    expect(keys(deriveExceptions(exceptionInputs({ ownedWithSla: [sla({ firstTouchDueAt: NOW })] })))).toEqual([`untouched:${contact(2)}:4`]);
  });

  it('R-ACC-2 R-ACC-1: a breach followed by auto-release stays an open item (derived from the ledger, not the projection)', () => {
    const s = only(exceptionInputs({ ownedWithSla: [sla({ firstTouchDueAt: t(-min(40)), periodEndedAt: t(-min(10)) })] }));
    expect(s.conditionClearedAt).toBeNull();
    expect(s.ownerUserId).toBe(ME);
    expect(s.evidence[0]?.explanation).toBe('No human call, text or email by the first-contact deadline; the lead later left this agent');
  });

  it('R-ACC-1: a late first touch is "fixed late": the item exists, cleared at the touch instant', () => {
    const s = only(exceptionInputs({ ownedWithSla: [sla({ firstTouchDueAt: t(-min(10)), firstTouchAt: t(-min(4)) })] }));
    expect(s.conditionClearedAt).toBe(t(-min(4)));
    expect(s.evidence.map((e) => e.explanation)).toEqual([
      'First human call, text or email came after the first-contact deadline',
      'Lead became theirs',
      'First human contact',
    ]);
  });

  it('R-ACC-1 E68: a re-inquiry missed again by the same agent is a new item under a new period key', () => {
    const r = deriveExceptions(
      exceptionInputs({
        ownedWithSla: [sla({ periodSeq: 4, firstTouchDueAt: t(-hours(30 * 24)) }), sla({ periodSeq: 19, ownedAt: t(-min(30)), firstTouchDueAt: t(-min(15)) })],
        // the old miss was verified long ago and is cleared in the store
        existing: [],
      }),
    );
    expect(keys(r)).toEqual([`untouched:${contact(2)}:19`, `untouched:${contact(2)}:4`]);
    const stored = apply([], deriveExceptions(exceptionInputs({ ownedWithSla: [sla({ periodSeq: 4, firstTouchDueAt: t(-hours(30 * 24)) })] })), NOW);
    const again = deriveExceptions(
      exceptionInputs({ ownedWithSla: [sla({ periodSeq: 4, firstTouchDueAt: t(-hours(30 * 24)) }), sla({ periodSeq: 19, firstTouchDueAt: t(-min(15)) })], existing: stored }),
    );
    expect(keys(again)).toEqual([`untouched:${contact(2)}:19`]);
  });

  // R-AST-15 (partial, with the ledger): SlaFacts.firstTouchAt is first_touch_recorded, which only a human touch writes.
  it('only first_touch_recorded clears the SLA, so an assistant reply leaves the lead untouched', () => {
    // SlaFacts.firstTouchAt is the ledger's first_touch_recorded, which only a human touch writes.
    const s = only(exceptionInputs({ ownedWithSla: [sla({ firstTouchDueAt: due, firstTouchAt: null })] }));
    expect(s.itemType).toBe('untouched_lead');
  });
});

describe('R-ACC-2 overdue_promise', () => {
  const p = (o: Parameters<typeof taskF>[0] = {}) => taskF({ kind: 'promise', dueAt: t(-min(5)), createdByKind: 'assistant', ...o });

  it('R-ACC-2: an open promise past due is an item for its assignee, with the promise quote as evidence', () => {
    const s = only(
      exceptionInputs({
        promiseTasks: [
          p({
            evidence: [
              { sourceType: 'call', sourceId: call(1), locator: { kind: 'transcript_offset', startMs: 1000, endMs: 4000 }, snippet: 'I will call you Thursday' },
              { sourceType: 'call', sourceId: call(1), locator: { kind: 'transcript_offset', startMs: 5000, endMs: 6000 }, snippet: 'b' },
              { sourceType: 'call', sourceId: call(1), locator: { kind: 'transcript_offset', startMs: 7000, endMs: 8000 }, snippet: 'c' },
              { sourceType: 'call', sourceId: call(1), locator: { kind: 'transcript_offset', startMs: 9000, endMs: 9500 }, snippet: 'd' },
            ],
          }),
        ],
      }),
    );
    expect(s).toMatchObject({ itemType: 'overdue_promise', subjectType: 'task', subjectId: task(1), ownerUserId: ME, detectedAt: t(-min(5)), dedupeKey: `promise:${task(1)}` });
    expect(s.evidence).toHaveLength(4); // the task + at most 3 quotes
    expect(s.evidence[1]).toEqual({ sourceType: 'call', sourceId: call(1), explanation: 'Where it was promised', locator: { kind: 'transcript_offset', startMs: 1000, endMs: 4000 }, snippet: 'I will call you Thursday' });
  });

  it('R-ACC-2: not yet due, done on time, canceled, undated (needs review) or not a promise is no item', () => {
    const r = deriveExceptions(
      exceptionInputs({
        promiseTasks: [
          p({ taskId: task(1), dueAt: t(min(5)) }),
          p({ taskId: task(2), dueAt: NOW }),
          p({ taskId: task(3), status: 'done', completedAt: t(-min(6)) }),
          p({ taskId: task(4), status: 'canceled' }),
          p({ taskId: task(5), dueAt: null, needsReview: true }),
          p({ taskId: task(6), status: 'done', completedAt: null }),
          taskF({ taskId: task(7), kind: 'callback', dueAt: t(-hours(1)) }),
        ],
      }),
    );
    expect(r.upserts).toEqual([]);
    expect(r.cleared).toEqual([1, 2, 3, 4, 5, 6].map((n) => `promise:${task(n)}`));
  });

  it('R-ACC-1: a promise done after its deadline is "fixed late"', () => {
    const s = only(exceptionInputs({ promiseTasks: [p({ status: 'done', completedAt: t(-min(1)) })] }));
    expect(s.conditionClearedAt).toBe(t(-min(1)));
    expect(s.evidence[0]?.explanation).toBe('Promised follow-up was done after it was due');
  });

  it('R-ACC-2: an all-day promise is overdue only after the end of its local day', () => {
    const allDay = (now: number) =>
      deriveExceptions(exceptionInputs({ now: now as never, promiseTasks: [p({ dueAt: at('2026-11-10T05:00:00Z'), dueAllDay: true, dueTz: NY })] }));
    expect(allDay(NOW).upserts).toEqual([]);
    expect(allDay(at('2026-11-11T05:00:01Z')).upserts[0]?.detectedAt).toBe(at('2026-11-11T05:00:00Z'));
  });

  it('R-IMPORT-6: an imported promise task never raises an exception', () => {
    expect(deriveExceptions(exceptionInputs({ promiseTasks: [p({ createdByKind: 'import' })] }))).toEqual({ upserts: [], cleared: [] });
  });
});

describe('R-ACC-2 failed_send', () => {
  it('stored reason codes are shown in words, never raw: gate codes as the gate words them, retired gate codes on older rows still in words, provider codes in plain words, unknown codes dropped', () => {
    const r = deriveExceptions(
      exceptionInputs({
        outbound: [
          outbound({ messageId: msg(1), status: 'blocked', statusReason: 'CONSENT_REVOKED' }),
          outbound({ messageId: msg(2), status: 'failed', statusReason: 'PROVIDER_REJECTED' }),
          outbound({ messageId: msg(3), status: 'blocked', channel: 'email', statusReason: 'DNC_LISTED' }),
          outbound({ messageId: msg(4), status: 'blocked', statusReason: 'QUIET_HOURS_DEFERRED' }),
          outbound({ messageId: msg(5), status: 'blocked', statusReason: 'SENDER_NOT_AUTHORIZED' }),
          outbound({ messageId: msg(6), status: 'blocked', channel: 'mms', statusReason: 'CONSENT_REVOKED' }),
        ],
      }),
    );
    expect(r.upserts.map((x) => x.evidence[0]?.explanation)).toEqual([
      'Text blocked by the send-time check: Opted out of texts',
      'Text failed to send (the carrier or provider rejected it)',
      'Email blocked by the send-time check: On a Do Not Call list',
      'Text blocked by the send-time check: Outside the hours they could be contacted',
      'Text blocked by the send-time check',
      'Text blocked by the send-time check: Opted out of texts',
    ]);
    expect(statusReasonWords('FREQUENCY_CAP', 'sms')).toBe('Over the message limit');
    expect(statusReasonWords('CALL_ATTEMPT_LIMIT', 'sms')).toBe('Over the call attempt limit');
    expect(statusReasonWords('CONSENT_REVOKED', 'email')).toBe('Opted out of email');
    expect(statusReasonWords('SUPPRESSED', 'sms')).toBe('Blocked for texts (bounce, complaint or do-not-contact)');
    expect(statusReasonWords('CONSENT_CONFIRMATION_REQUIRED', 'sms')).toBe('Waited for a confirmation that never came');
    expect(statusReasonWords('mailbox full', 'email')).toBe('mailbox full');
  });

  it('R-ACC-2: blocked, failed, undelivered and bounced are items at their status instant, with the reason as evidence', () => {
    const r = deriveExceptions(
      exceptionInputs({
        outbound: [
          outbound({ messageId: msg(1), status: 'blocked', statusReason: 'Opted out of texts' }),
          outbound({ messageId: msg(2), status: 'failed' }),
          outbound({ messageId: msg(3), status: 'undelivered', statusReason: null }),
          outbound({ messageId: msg(4), status: 'bounced', channel: 'email', statusReason: 'mailbox full' }),
          outbound({ messageId: msg(5), status: 'blocked', statusReason: null, initiator: 'assistant', ownerUserId: OTHER }),
          outbound({ messageId: msg(6), status: 'failed', statusReason: null }),
          outbound({ messageId: msg(7), status: 'undelivered', statusReason: '30003' }),
          outbound({ messageId: msg(8), status: 'bounced', channel: 'email', statusReason: null }),
        ],
      }),
    );
    expect(r.upserts.map((x) => x.evidence[0]?.explanation)).toEqual([
      'Text blocked by the send-time check: Opted out of texts',
      'Text failed to send (30007)',
      'Text not delivered',
      'Email bounced (mailbox full)',
      'Text blocked by the send-time check',
      'Text failed to send',
      'Text not delivered (30003)',
      'Email bounced',
    ]);
    expect(r.upserts.every((x) => x.itemType === 'failed_send' && x.detectedAt === t(-min(5)) && x.dedupeKey.startsWith('send:'))).toBe(true);
    expect(r.upserts[4]?.ownerUserId).toBe(OTHER); // assistant sends answer to the action owner
  });

  // R-GATE-8 (partial): the 20-minute dispatching threshold matches the sweeper's dispatch_stale branch.
  it('R-ACC-2: dispatch_unknown counts after more than 10 min; dispatching after more than 20 min', () => {
    const derive = (o: Parameters<typeof outbound>[0]) => deriveExceptions(exceptionInputs({ outbound: [outbound(o)] }));
    expect(derive({ status: 'dispatch_unknown', statusAt: t(-min(10)) }).upserts).toEqual([]);
    const unknown = derive({ status: 'dispatch_unknown', statusAt: t(-min(11)) }).upserts[0];
    expect(unknown).toMatchObject({ detectedAt: t(-min(1)) });
    expect(unknown?.evidence[0]?.explanation).toBe('Text send result unknown for over 10 min');
    expect(derive({ status: 'dispatching', dispatchedAt: t(-min(20)) }).upserts).toEqual([]);
    const stuck = derive({ status: 'dispatching', dispatchedAt: t(-min(25)) }).upserts[0];
    expect(stuck).toMatchObject({ detectedAt: t(-min(5)) });
    expect(stuck?.evidence[0]?.explanation).toBe('Text stuck sending for over 20 min');
    expect(derive({ status: 'dispatching', dispatchedAt: null, statusAt: t(-min(21)) }).upserts).toHaveLength(1);
    for (const status of ['sent', 'delivered', 'queued', 'scheduled', 'canceled'] as const) {
      expect(derive({ status }).upserts).toEqual([]);
      expect(derive({ status }).cleared).toEqual([`send:${msg(100)}`]);
    }
  });

  it('R-ACC-2: settings are honoured (configurable windows)', () => {
    const r = deriveExceptions(
      exceptionInputs({ settings: { missingOutcomeHours: 1, unknownDispatchMinutes: 3, dispatchingStaleMinutes: 5 }, outbound: [outbound({ status: 'dispatch_unknown', statusAt: t(-min(4)) }), outbound({ messageId: msg(2), status: 'dispatching', dispatchedAt: t(-min(6)) })], appointments: [apptF({ endsAt: t(-min(61)) })] }),
    );
    expect(r.upserts.map((x) => x.itemType).sort()).toEqual(['failed_send', 'failed_send', 'missing_outcome']);
    expect(DEFAULT_EXCEPTION_SETTINGS).toEqual({ missingOutcomeHours: 2, unknownDispatchMinutes: 10, dispatchingStaleMinutes: 20 });
  });

  it('R-IMPORT-6: imported messages never raise failed_send', () => {
    expect(deriveExceptions(exceptionInputs({ outbound: [outbound({ imported: true, initiator: 'import' }), outbound({ messageId: msg(2), initiator: 'import' })] }))).toEqual({ upserts: [], cleared: [] });
  });
});

describe('R-ACC-2 missing_outcome', () => {
  it('R-ACC-2: an appointment that ended more than 2 h ago with no outcome is an item for its organizer', () => {
    expect(deriveExceptions(exceptionInputs({ appointments: [apptF({ endsAt: t(-hours(2)) })] })).upserts).toEqual([]);
    const s = only(exceptionInputs({ appointments: [apptF({ endsAt: t(-hours(2) - 1), status: 'held' })] }));
    expect(s).toMatchObject({ itemType: 'missing_outcome', subjectType: 'appointment', ownerUserId: ME, detectedAt: t(-1), dueAt: t(-1), dedupeKey: `appt:${apptF().appointmentId}` });
    expect(s.evidence[0]?.explanation).toBe('Buyer consult ended; no outcome logged');
  });

  it('R-ACC-2: canceled, rescheduled, no-show or outcome logged in time is no item; logged late is "fixed late"', () => {
    const ended = t(-hours(5));
    const r = deriveExceptions(
      exceptionInputs({
        appointments: [
          apptF({ appointmentId: 'a' as never, endsAt: ended, status: 'canceled' }),
          apptF({ appointmentId: 'b' as never, endsAt: ended, status: 'rescheduled' }),
          apptF({ appointmentId: 'c' as never, endsAt: ended, status: 'no_show' }),
          apptF({ appointmentId: 'd' as never, endsAt: ended, status: 'held', outcomeLoggedAt: t(-hours(4)) }),
        ],
      }),
    );
    expect(r.upserts).toEqual([]);
    expect(r.cleared).toEqual(['appt:a', 'appt:b', 'appt:c', 'appt:d']);
    const late = only(exceptionInputs({ appointments: [apptF({ endsAt: ended, status: 'held', outcomeLoggedAt: t(-hours(1)), kind: 'listing_appointment' })] }));
    expect(late.conditionClearedAt).toBe(t(-hours(1)));
    expect(late.evidence[0]?.explanation).toBe('Listing appointment outcome logged more than 2 h after it ended');
  });

  it('R-IMPORT-6: imported appointments never raise missing_outcome', () => {
    expect(deriveExceptions(exceptionInputs({ appointments: [apptF({ endsAt: t(-hours(9)), createdByKind: 'import' })] }))).toEqual({ upserts: [], cleared: [] });
  });
});

describe('R-ACC-1 recompute', () => {
  const world = (now = NOW): ExceptionInputs =>
    exceptionInputs({
      now,
      ownedWithSla: [sla({ firstTouchDueAt: t(-min(1)) }), sla({ contactId: contact(20), periodSeq: 2, firstTouchDueAt: t(min(30)) })],
      promiseTasks: [taskF({ kind: 'promise', dueAt: t(-min(3)) })],
      outbound: [outbound(), outbound({ messageId: msg(2), status: 'dispatch_unknown', statusAt: t(-min(4)) })],
      appointments: [apptF({ endsAt: t(-hours(3)) }), apptF({ appointmentId: 'z' as never, endsAt: t(-min(100)) })],
    });

  it('R-ACC-1: idempotent: running it again on its own stored output gives no new upserts and no clears', () => {
    const first = deriveExceptions(world());
    expect(first.upserts).toHaveLength(4);
    const stored = apply([], first, NOW);
    expect(deriveExceptions({ ...world(), existing: stored })).toEqual({ upserts: [], cleared: [] });
    // and once more, a minute later, nothing new appears or moves
    expect(deriveExceptions({ ...world(t(min(1))), existing: stored })).toEqual({ upserts: [], cleared: [] });
  });

  it('R-ACC-1: time-only conditions appear on the next recompute with no write, and detectedAt never moves', () => {
    const later = t(min(31));
    const stored = apply([], deriveExceptions(world()), NOW);
    const r = deriveExceptions({ ...world(later), existing: stored });
    expect(keys(r).sort()).toEqual([`appt:z`, `send:${msg(2)}`, `untouched:${contact(20)}:2`].sort());
    expect(r.upserts.find((x) => x.itemType === 'untouched_lead')?.detectedAt).toBe(t(min(30)));
    expect(deriveExceptions(world(later)).upserts.find((x) => x.dedupeKey === `untouched:${contact(2)}:4`)?.detectedAt).toBe(t(-min(1)));
  });

  it('R-ACC-1: clears when the condition stops holding, including a subject that disappeared', () => {
    const stored = apply([], deriveExceptions(world()), NOW);
    const fixed: ExceptionInputs = {
      ...world(),
      promiseTasks: [taskF({ kind: 'promise', dueAt: t(-min(3)), status: 'canceled' })],
      outbound: [], // the failed message's row is gone from this scope
      existing: stored,
    };
    const r = deriveExceptions(fixed);
    expect(r.upserts).toEqual([]);
    expect(r.cleared).toEqual([`promise:${task(1)}`, `send:${msg(100)}`]);
    const after = apply(stored, r, NOW);
    expect(deriveExceptions({ ...fixed, existing: after })).toEqual({ upserts: [], cleared: [] });
  });

  it('R-ACC-1: a stored open item fixed late is upserted with the fix instant; a stored cleared item that holds again reopens', () => {
    const stored = apply([], deriveExceptions(world()), NOW);
    const touched = deriveExceptions({ ...world(), ownedWithSla: [sla({ firstTouchDueAt: t(-min(1)), firstTouchAt: NOW })], existing: stored });
    expect(touched.upserts.map((x) => [x.dedupeKey, x.conditionClearedAt])).toEqual([[`untouched:${contact(2)}:4`, NOW]]);
    expect(touched.cleared).toEqual([]);
    const storedCleared = stored.map((x) => (x.itemType === 'overdue_promise' ? { ...x, conditionClearedAt: t(-min(1)) } : x));
    const reopened = deriveExceptions({ ...world(), existing: storedCleared });
    expect(reopened.upserts.map((x) => [x.dedupeKey, x.conditionClearedAt])).toEqual([[`promise:${task(1)}`, null]]);
    // cleared in the store and fixed late in the derivation: unchanged (the stored instant is kept)
    const bothCleared = apply(stored, touched, NOW);
    expect(deriveExceptions({ ...world(), ownedWithSla: [sla({ firstTouchDueAt: t(-min(1)), firstTouchAt: NOW })], existing: bothCleared })).toEqual({ upserts: [], cleared: [] });
  });

  it('R-ACC-1: quotes with every locator kind compare equal after a round trip, and a changed quote is an upsert', () => {
    const quotes = (snippet: string) =>
      exceptionInputs({
        promiseTasks: [
          taskF({
            kind: 'promise',
            dueAt: t(-min(3)),
            evidence: [
              { sourceType: 'call', sourceId: call(1), locator: { kind: 'transcript_offset', startMs: 1, endMs: 2 }, snippet },
              { sourceType: 'note', sourceId: 'n1', locator: { kind: 'char_range', start: 3, end: 9 }, snippet: 'b' },
              { sourceType: 'message', sourceId: msg(1), locator: { kind: 'message' }, snippet: 'c' },
            ],
          }),
          taskF({ taskId: task(2), kind: 'promise', dueAt: t(-min(3)), evidence: [{ sourceType: 'deal', sourceId: 'd1', locator: { kind: 'field', name: 'closing_date' }, snippet: 'd' }] }),
        ],
      });
    const stored = apply([], deriveExceptions(quotes('a')), NOW).map((x) => JSON.parse(JSON.stringify(x)) as ExceptionItemSpec);
    expect(deriveExceptions({ ...quotes('a'), existing: stored })).toEqual({ upserts: [], cleared: [] });
    expect(keys(deriveExceptions({ ...quotes('changed'), existing: stored }))).toEqual([`promise:${task(1)}`]);
  });

  it('R-ACC-1: stored rows round-tripped through jsonb (reordered keys) compare equal', () => {
    const stored = apply([], deriveExceptions(world()), NOW).map((x) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(x).reverse()))) as ExceptionItemSpec);
    expect(deriveExceptions({ ...world(), existing: stored })).toEqual({ upserts: [], cleared: [] });
  });

  it('R-ACC-1: deterministic: input order never changes the result (property)', () => {
    const base = world();
    const expected = deriveExceptions(base);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 }), (seed) => {
        const r = deriveExceptions({
          ...base,
          ownedWithSla: shuffled(base.ownedWithSla, seed),
          promiseTasks: shuffled([...base.promiseTasks, ...base.promiseTasks], seed + 1),
          outbound: shuffled(base.outbound, seed + 2),
          appointments: shuffled(base.appointments, seed + 3),
        });
        expect(r).toEqual(expected);
      }),
      { numRuns: 50 },
    );
  });

  it('R-ACC-2: every item carries ≥ 1 evidence entry and an owner, and validates against the stored schema', () => {
    for (const x of deriveExceptions(world(t(hours(1)))).upserts) {
      expect(ExceptionItemSpecSchema.parse(x)).toEqual(x);
      expect(x.evidence.length).toBeGreaterThanOrEqual(1);
      expect(x.ownerUserId).not.toBeNull();
    }
  });

  it('duplicate rows for one subject yield one item regardless of order', () => {
    const a = outbound({ statusReason: 'a' });
    const b = outbound({ statusReason: 'b' });
    expect(deriveExceptions(exceptionInputs({ outbound: [a, b] }))).toEqual(deriveExceptions(exceptionInputs({ outbound: [b, a] })));
    expect(deriveExceptions(exceptionInputs({ outbound: [a, b] })).upserts).toHaveLength(1);
  });

  it('undefined optional settings fall back to the defaults', () => {
    const r = deriveExceptions(exceptionInputs({ settings: { missingOutcomeHours: 2, unknownDispatchMinutes: 10, dispatchingStaleMinutes: undefined }, outbound: [outbound({ status: 'dispatching', dispatchedAt: t(-min(21)) })] }));
    expect(r.upserts).toHaveLength(1);
  });
});
