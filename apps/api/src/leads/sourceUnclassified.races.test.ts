// R-LSRC-9 A7 (owner decision 2026-11-14; migration 0101): races, without a lock.
//
// There is no tenant-wide or advisory lock anywhere in this design: the guards read the row and (for an activating
// write only) the definer, the Owner's mapping locks only the lead_sources rows it changes (FOR NO KEY UPDATE) and the
// draft rows it withdraws, and the import commit locks only the people it writes (its own contact locks, as before).
//
// (a) An inbound STOP, an inbound call, a pause and a stop all succeed, at once, while an Owner mapping transaction is
//     open and while an import commit transaction is open, for the very people the mapping touches. The one honest
//     exception, unchanged by this work: a person the open import chunk is itself attaching a record to is held by that
//     chunk's contact lock, so their STOP is recorded when the chunk commits (it waits; it never fails).
// (b) An enrolment or a dispatch that starts just before a mapping removal commits read the mapping as it was. What can
//     still be sent: exactly the one message whose dispatch TX1 committed before the removal did. The next step and
//     every later send are refused: the step runner asks before anything else and stops the plan, and dispatch TX1 and
//     the message guard refuse every later automated message.
// (c) The Owner's mapping never waits on the saved-search alert sender (E756, E758). The sender holds a refused
//     person's searches (saved_searches.alerts_held_until) in a transaction that stays open for its whole run; the
//     mapping clears the holds of its label's people while it holds its lead_sources rows. It clears only the holds it
//     can take at once (FOR UPDATE SKIP LOCKED), so with the sender's transaction open after a re-hold the mapping
//     answers at once, and an inbound STOP or call on a tracking number of the target source (which reads that lead
//     source FOR SHARE) is recorded at once too. The skipped search stays held: an alert up to an hour late.
// Made-up labels and sources; fakes only.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendDueAlertsInTx } from '../assistant/searches.js';
import { type ApprovedPlaybook, actionsOf, appointment, approvedPlaybook, depsOf, enrollmentRow, messagesOf, runJobs, smsStep } from '../assistant/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { type CommsWorld, type TestContact, commsWorld, inboundSms, messageRow, ownedContact, randomPhone, sid, telephonyWebhook } from '../comms/testing.js';
import type { CommitChunkPoint } from '../imports/types.js';
import { type ImportsHarness, approve as approveStage, batchOf, call, commitStage, csvBase64, dryRunStage, freshReauth, importsHarness, records } from '../imports/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { SOURCE_UNCLASSIFIED, noAutomatedContact } from './automatedContact.js';
import { setImportSource } from './sources.js';
import { importedPerson } from './testing.js';

let ih: ImportsHarness;
let w: CommsWorld;
let agent: TestClient;
let plain: { id: string; name: string };
let twoStep: ApprovedPlaybook;
let draftFirst: ApprovedPlaybook;

const MONEY_PLACE = 'our office to go over your offer';
const h = () => ih.h;

beforeAll(async () => {
  ih = await importsHarness();
  w = await commsWorld(ih.h, { agents: 1 });
  agent = w.agents[0]!;
  await freshReauth(h(), w.owner);
  plain = (await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Northgate Referrals (test)', kind: 'referral' })).body.source;
  const text = (key: string, o: Record<string, unknown> = {}) => smsStep({ key, category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'], ...o });
  twoStep = await approvedPlaybook(w.owner, { kind: 'nurture', scope: 'team', name: 'Two check-ins (test)', steps: [text('first'), text('second', { anchor: 'previous_step', offsetSeconds: 86_400 })] });
  // a first step that becomes a draft for the owner (its place mentions an offer, E35), then a second a day later
  draftFirst = await approvedPlaybook(w.owner, {
    kind: 'reminder',
    scope: 'team',
    name: 'Confirm, then remind (test)',
    steps: [
      smsStep({ key: 'place', category: 'reminder', intent: 'appointment_reminder', purpose: 'informational', template: 'Hi {{first_name}}, a reminder: we meet at {{appointment_place}}. Reply here to change it.', slots: ['first_name', 'appointment_place'] }),
      smsStep({ key: 'later', category: 'reminder', intent: 'appointment_reminder', purpose: 'informational', template: 'Hi {{first_name}}, a quick reminder from us about tomorrow.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
}, 300_000);
afterAll(async () => {
  await ih?.close();
});

const owner = () => w.owner.actor() as UserActor;
const sys = () => systemActor(w.tenantId, 'worker');
const refusalOf = (contactId: string) => withTenantTx(sys(), (tx) => noAutomatedContact(tx, contactId), { db: h().database });
const automated = async (contactId: string) => (await messagesOf(h(), contactId)).filter((m) => m.initiator !== 'human');
const mapLabel = async (label: string, leadSourceId: string | null) => {
  await freshReauth(h(), w.owner);
  return call<{ stopping: number }>(w.owner, 'PUT', '/lead-sources/import-labels', { label, leadSourceId });
};
const enroll = (contactId: string, playbookId = twoStep.playbookId, anchor?: unknown) => call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${contactId}/enrollments`, { playbookId, ...(anchor ? { anchor } : {}) });

/** A gate a transaction waits at: `entered` resolves when it got there, `release()` lets it commit. */
function gate() {
  let release!: () => void;
  let inside!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (inside = r));
  return { open, entered, inside, release };
}

/** Whether `p` finished while the other transaction was still open (within `ms`), and what it answered. */
async function prompt<T>(p: Promise<T>, ms = 8000): Promise<{ done: boolean; value?: T }> {
  return Promise.race([p.then((value) => ({ done: true, value })), new Promise<{ done: boolean }>((r) => setTimeout(() => r({ done: false }), ms))]);
}

/** An Owner mapping transaction for `label`, held open after all of its work, until `release()`. */
function openUnmap(label: string) {
  const g = gate();
  const result = withTenantTx(owner(), async (tx, now) => {
    const r = await setImportSource(tx, owner(), { label }, null, now);
    g.inside();
    await g.open;
    return r;
  }, { db: h().database });
  return { ...g, result };
}

/** A person of `label` (mapped to an unmarked source, so classified) in the two-step plan, its first text queued and sent. */
async function planned(label: string, playbook: ApprovedPlaybook = twoStep): Promise<{ c: TestContact; enrollmentId: string }> {
  const c = await ownedContact(agent);
  await importedPerson(h(), w.tenantId, w.owner.userId!, c.id, { label });
  const anchor = playbook === draftFirst ? { kind: 'appointment', id: await appointment(h(), w, c.id, agent.userId!, { location: MONEY_PLACE }) } : undefined;
  const e = await enroll(c.id, playbook.playbookId, anchor);
  expect(e.status).toBe(201);
  return { c, enrollmentId: e.body.enrollment.id };
}

describe('R-LSRC-9 A7 (a): nothing a person or a client does waits on, or fails because of, an Owner mapping or an import', () => {
  it('R-LSRC-9 E737: while an Owner\'s mapping removal is open (uncommitted) for their own label, an inbound STOP, an inbound call, a pause and a stop each succeed at once; the STOP is recorded and its plan paused, though that person\'s draft was just withdrawn in the open transaction', async () => {
    const label = `Race label ${randomUUID().slice(0, 6)} (test)`;
    expect((await mapLabel(label, plain.id)).status).toBe(200);
    const stopper = await planned(label, draftFirst); // has a pending plan-step draft the mapping will withdraw
    const caller = await planned(label);
    const paused = await planned(label);
    const stopped = await planned(label);
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    const draft = (await actionsOf(h(), stopper.c.id)).find((x) => x.kind === 'message_draft')!;
    expect(draft.status).toBe('proposed');
    for (const p of [stopper, caller, paused, stopped]) expect((await enrollmentRow(h(), p.enrollmentId)).state).toBe('active');

    const m = openUnmap(label);
    await m.entered;
    try {
      // the mapping's own work is done and uncommitted; these four run against it
      const stop = await prompt(inboundSms(h(), stopper.c.phone, w.mainNumber, 'STOP'));
      const ring = await prompt(telephonyWebhook(h(), '/webhooks/telephony/voice', { CallSid: sid('CA'), From: caller.c.phone, To: w.mainNumber, CallStatus: 'no-answer', Direction: 'inbound' }));
      const pause = await prompt(call(agent, 'POST', `/enrollments/${paused.enrollmentId}/pause`));
      const end = await prompt(call(agent, 'POST', `/enrollments/${stopped.enrollmentId}/stop`));
      expect([stop.done, stop.value?.statusCode]).toEqual([true, 200]);
      expect([ring.done, ring.value?.statusCode]).toEqual([true, 200]);
      expect([pause.done, pause.value?.status]).toEqual([true, 200]);
      expect([end.done, end.value?.status]).toEqual([true, 200]);
      // recorded, with the mapping still open
      expect((await h().su.query("SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [stopper.c.id])).rows[0].n).toBeGreaterThanOrEqual(1);
      expect(await enrollmentRow(h(), stopper.enrollmentId)).toMatchObject({ state: 'paused', pause_reason: 'opt_out' });
      expect((await h().su.query("SELECT status, direction FROM calls WHERE contact_id = $1", [caller.c.id])).rows).toEqual([{ status: 'no_answer', direction: 'inbound' }]);
      expect((await enrollmentRow(h(), caller.enrollmentId)).state).toBe('paused');
      expect((await enrollmentRow(h(), paused.enrollmentId)).state).toBe('paused');
      expect((await enrollmentRow(h(), stopped.enrollmentId)).state).toBe('stopped');
    } finally {
      m.release();
    }
    const r = await m.result;
    // the mapping saw four active plans when it ran, and withdrew the draft
    expect([r.stopping, r.withdrawn]).toEqual([4, 1]);
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    // the opt-out's pause and the person's stop stand; nobody was resumed or re-stopped wrongly
    expect((await enrollmentRow(h(), stopper.enrollmentId)).state).toBe('paused');
    expect(await enrollmentRow(h(), stopped.enrollmentId)).toMatchObject({ state: 'stopped' });
    for (const p of [stopper, caller, paused, stopped]) expect(await refusalOf(p.c.id)).toBe(SOURCE_UNCLASSIFIED);
  }, 300_000);

  it('R-LSRC-9 E737: while an import commit chunk is open, an inbound STOP, an inbound call, a pause and a stop succeed at once for everyone the chunk is not writing; a person the chunk is itself attaching a record to is held by the import\'s own contact lock (as before), so their STOP is recorded when the chunk commits: it waits, it never fails', async () => {
    const label = `Known label ${randomUUID().slice(0, 6)} (test)`;
    expect((await mapLabel(label, plain.id)).status).toBe(200);
    const stopper = await planned(label);
    const caller = await planned(label);
    const paused = await planned(label);
    const stopped = await planned(label);
    const inChunk = await planned(label); // the import below attaches an unreviewed record to this person
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    const csv = `First Name,Last Name,Mobile Phone,Email,Source\nJane,Doe,${inChunk.c.phone},${inChunk.c.email},"New label ${randomUUID().slice(0, 6)} (test)"\n`;
    const up = await call<{ batch: { id: string } }>(w.owner, 'POST', '/imports', { source: 'csv', fileName: 'race.csv', fileBase64: csvBase64(csv) });
    expect((await call(w.owner, 'POST', `/imports/${up.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = await batchOf(w.owner, up.body.batch.id);
    const dry = await dryRunStage(ih, w.owner, b.id, 'contacts');
    for (const r of await records(w.owner, b.id, 'contacts')) {
      if (r.outcome === 'needs_review') expect((await call(w.owner, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'merge', mergeIntoContactId: r.matchContactId })).status).toBe(200);
    }
    const sha = ((await batchOf(w.owner, b.id)).stages.find((s) => s.category === 'contacts')!.dryRunSha256 ?? dry.dryRunSha256) as string;
    expect((await approveStage(w.owner, b.id, 'contacts', sha)).status).toBe(200);

    const g = gate();
    ih.workerDeps.inCommitChunk = async (p: CommitChunkPoint) => {
      if (p.category !== 'contacts' || p.phase !== 'applied') return;
      g.inside();
      await g.open;
    };
    const committing = commitStage(ih, w.owner, b.id, 'contacts');
    await g.entered;
    const late: { stop?: Promise<{ statusCode: number }> } = {};
    try {
      const stop = await prompt(inboundSms(h(), stopper.c.phone, w.mainNumber, 'STOP'));
      const ring = await prompt(telephonyWebhook(h(), '/webhooks/telephony/voice', { CallSid: sid('CA'), From: caller.c.phone, To: w.mainNumber, CallStatus: 'no-answer', Direction: 'inbound' }));
      const pause = await prompt(call(agent, 'POST', `/enrollments/${paused.enrollmentId}/pause`));
      const end = await prompt(call(agent, 'POST', `/enrollments/${stopped.enrollmentId}/stop`));
      expect([stop.done, stop.value?.statusCode]).toEqual([true, 200]);
      expect([ring.done, ring.value?.statusCode]).toEqual([true, 200]);
      expect([pause.done, pause.value?.status]).toEqual([true, 200]);
      expect([end.done, end.value?.status]).toEqual([true, 200]);
      expect(await enrollmentRow(h(), stopper.enrollmentId)).toMatchObject({ state: 'paused', pause_reason: 'opt_out' });
      expect((await enrollmentRow(h(), stopped.enrollmentId)).state).toBe('stopped');
      // the person the chunk is writing: their STOP waits for the chunk's own contact lock (not for a tenant lock)
      late.stop = inboundSms(h(), inChunk.c.phone, w.mainNumber, 'STOP');
      expect((await prompt(late.stop, 1500)).done).toBe(false);
    } finally {
      delete ih.workerDeps.inCommitChunk;
      g.release();
    }
    expect((await committing).status).toBe('committed');
    expect((await late.stop!).statusCode).toBe(200);
    expect((await h().su.query("SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [inChunk.c.id])).rows[0].n).toBeGreaterThanOrEqual(1);
    expect(await refusalOf(inChunk.c.id)).toBe(SOURCE_UNCLASSIFIED);
  }, 300_000);
});

describe('R-LSRC-9 A7 (b): what starts just before a mapping removal commits', () => {
  it('R-LSRC-9 E737: a hand enrolment that commits while the removal is still open is accepted (it read the mapping as it was), and the mapping\'s stop does not see it; the plan\'s first step is refused all the same: the step runner stops it source_unclassified and nothing is sent', async () => {
    const label = `Late label ${randomUUID().slice(0, 6)} (test)`;
    expect((await mapLabel(label, plain.id)).status).toBe(200);
    const c = await ownedContact(agent);
    await importedPerson(h(), w.tenantId, w.owner.userId!, c.id, { label });
    const m = openUnmap(label);
    await m.entered;
    const made: { id?: string } = {};
    try {
      const e = await enroll(c.id);
      expect(e.status).toBe(201); // the removal has not committed: the person still reads as classified
      made.id = e.body.enrollment.id;
    } finally {
      m.release();
    }
    const enrollmentId = made.id!;
    expect((await m.result).stopping).toBe(0); // the mapping's statement ran before the plan existed
    expect(await refusalOf(c.id)).toBe(SOURCE_UNCLASSIFIED);
    expect((await enrollmentRow(h(), enrollmentId)).state).toBe('active');
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), enrollmentId)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    expect(await automated(c.id)).toEqual([]);
    expect(h().providers.telephony.sms.filter((x) => x.to === c.phone)).toEqual([]);
  }, 300_000);

  it('R-LSRC-9 E737: a dispatch whose TX1 commits while the removal is still open sends that ONE message (it read the mapping as it was); after the removal commits the plan\'s next step is refused (the plan stops) and every later automated message is blocked SOURCE_UNCLASSIFIED', async () => {
    const label = `In flight label ${randomUUID().slice(0, 6)} (test)`;
    expect((await mapLabel(label, plain.id)).status).toBe(200);
    const p = await planned(label);
    await runJobs(h(), w.tenantId, ['playbook.step'], 3, ['default']); // the first step queued its text; dispatch has not run
    const [queued] = await automated(p.c.id);
    expect(queued?.status).toBe('queued');
    const m = openUnmap(label);
    await m.entered;
    try {
      // dispatch runs while the removal is open: TX1 reads the committed mapping and lets the text go
      await runJobs(h(), w.tenantId, ['comms.dispatch']);
      expect((await messageRow(h(), queued!.id)).status).toBe('sent');
    } finally {
      m.release();
    }
    expect((await m.result).stopping).toBe(1);
    expect(await refusalOf(p.c.id)).toBe(SOURCE_UNCLASSIFIED);
    // what was sent: exactly that one message
    expect(h().providers.telephony.sms.filter((x) => x.to === p.c.phone)).toHaveLength(1);
    // the next step: the step the removal asked for stops the plan, a day before its second text was due
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), p.enrollmentId)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    // every later send: blocked at dispatch
    const q = await withTenantTx(sys(), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: p.c.id, channel: 'sms', body: 'Two homes match your search.', initiator: 'system', purpose: 'marketing', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h().database });
    await runJobs(h(), w.tenantId, ['comms.dispatch']);
    expect((await messageRow(h(), (q as { messageId: string }).messageId))).toMatchObject({ status: 'blocked', status_reason: SOURCE_UNCLASSIFIED });
    expect(h().providers.telephony.sms.filter((x) => x.to === p.c.phone)).toHaveLength(1);
    expect((await automated(p.c.id)).filter((x) => x.status === 'sent')).toHaveLength(1);
  }, 300_000);
});

describe('R-LSRC-10 M7 (c): the Owner\'s mapping never waits on the saved-search alert sender', () => {
  it('R-LSRC-10 E756 E758: with the alert sender\'s transaction open after it re-held a refused person\'s search, the Owner\'s mapping of that label answers at once, and an inbound STOP and an inbound call on a tracking number of the target source are answered and recorded at once; the search the sender holds is skipped, not waited for, and nothing is alerted meanwhile', async () => {
    const target = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: `Harbor Referrals ${randomUUID().slice(0, 6)} (test)`, kind: 'referral' })).body.source.id;
    const n = await call<{ number: { e164: string; leadSourceId: string | null } }>(w.owner, 'POST', '/numbers', { purpose: 'tracking', areaCode: '415', leadSourceId: target });
    expect([n.status, n.body.number.leadSourceId]).toEqual([201, target]);
    const tracking = n.body.number.e164;
    // a person an import committed under a label nobody has reviewed, with a saved search and a home waiting for it
    const label = `Held label ${randomUUID().slice(0, 6)} (test)`;
    const c = await ownedContact(agent);
    await importedPerson(h(), w.tenantId, w.owner.userId!, c.id, { label });
    expect(await refusalOf(c.id)).toBe(SOURCE_UNCLASSIFIED);
    const searchId = randomUUID();
    await h().su.query(
      `INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, approved_by_user_id, approved_at, activated_at, alert_channel, alert_frequency)
       VALUES ($1, $2, $3, 'Search (test)', 'active', '{}'::jsonb, $4, now(), now(), 'sms', 'instant')`,
      [w.tenantId, searchId, c.id, agent.userId],
    );
    const listing = (await h().su.query<{ id: string }>(
      `INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id)
       VALUES ($1, gen_random_uuid(), 'team', 'active', '1 Race St', 'Springfield', 'SC', '29401', $2) RETURNING id`,
      [w.tenantId, agent.userId],
    )).rows[0]!.id;
    await h().su.query('INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES ($1, $2, $3, now())', [w.tenantId, searchId, listing]);
    const heldUntil = async () => (await h().su.query<{ alerts_held_until: Date | null }>('SELECT alerts_held_until FROM saved_searches WHERE id = $1', [searchId])).rows[0]!.alerts_held_until;
    const assistant = () => systemActor(w.tenantId, 'assistant');
    // the sender's first run refuses the person and holds the search; an hour later the hold has run out
    expect(await withTenantTx(assistant(), (tx, now) => sendDueAlertsInTx(tx, depsOf(h()), w.tenantId, now, {}), { db: h().database })).toBe(0);
    expect(await heldUntil()).not.toBeNull();
    await h().su.query("UPDATE saved_searches SET alerts_held_until = '2000-01-01T00:00:00Z' WHERE id = $1", [searchId]);
    // someone else, a client of the team, who will text STOP to the target source's tracking number
    const stopper = await ownedContact(agent);

    // the sender's next run, held open: it asked again, re-held the search (uncommitted) and is still working
    const g = gate();
    const sender = withTenantTx(assistant(), async (tx, now) => {
      const sent = await sendDueAlertsInTx(tx, depsOf(h()), w.tenantId, now, {});
      g.inside();
      await g.open;
      return sent;
    }, { db: h().database });
    await g.entered;
    const pending: Promise<unknown>[] = [];
    try {
      // the Owner maps the label to the target source: answered at once, the sender's transaction still open
      await freshReauth(h(), w.owner);
      const mapP = call<{ label: { leadSourceId: string | null } }>(w.owner, 'PUT', '/lead-sources/import-labels', { label, leadSourceId: target });
      const stopP = inboundSms(h(), stopper.phone, tracking, 'STOP');
      const newStopP = inboundSms(h(), randomPhone(), tracking, 'STOP');
      const ringP = telephonyWebhook(h(), '/webhooks/telephony/voice', { CallSid: sid('CA'), From: randomPhone(), To: tracking, CallStatus: 'ringing', Direction: 'inbound' });
      pending.push(mapP, stopP, newStopP, ringP);
      const map = await prompt(mapP, 4000);
      expect([map.done, map.value?.status, map.value?.body.label.leadSourceId]).toEqual([true, 200, target]);
      // ...and an inbound STOP and an inbound call on that source's tracking number, which read the lead source FOR SHARE
      const stop = await prompt(stopP, 4000);
      const newStop = await prompt(newStopP, 4000);
      const ring = await prompt(ringP, 4000);
      expect([stop.done, stop.value?.statusCode]).toEqual([true, 200]);
      expect([newStop.done, newStop.value?.statusCode]).toEqual([true, 200]);
      expect([ring.done, ring.value?.statusCode]).toEqual([true, 200]);
      // recorded, with the sender still open
      expect((await h().su.query("SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [stopper.id])).rows[0].n).toBeGreaterThanOrEqual(1);
      // the mapping is committed: the person is classified now
      expect(await refusalOf(c.id)).toBeNull();
    } finally {
      g.release();
      await Promise.allSettled(pending);
    }
    expect(await sender).toBe(0);
    // the search the sender was holding was skipped, not waited for: it stays held (never longer than the hour), and
    // nothing automated went to its person meanwhile
    const held = await heldUntil();
    expect(held).not.toBeNull();
    expect(held!.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(await automated(c.id)).toEqual([]);
    // once the hold has run out the sender asks again, and the released person gets the home that waited
    await h().su.query("UPDATE saved_searches SET alerts_held_until = '2000-01-01T00:00:00Z' WHERE id = $1", [searchId]);
    expect(await withTenantTx(assistant(), (tx, now) => sendDueAlertsInTx(tx, depsOf(h()), w.tenantId, now, {}), { db: h().database })).toBe(1);
    expect((await automated(c.id)).map((m) => m.action_category)).toEqual(['search_alert']);
  }, 300_000);
});
