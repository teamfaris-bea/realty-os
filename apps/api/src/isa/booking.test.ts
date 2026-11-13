// ISA-2b items 7–9: bookSlotInTx (D8a), offers (D8b) and booking (D8c) on the fake calendar (R-ISA-13, -14, -15).
// Real Postgres via the API harness; the fake ISA model, the fake calendar, telephony and email; nothing real.
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { calendarDeps } from '../calendar/routes.js';
import { type BookInput, bookSlotInTx, busyForBooking } from '../calendar/service.js';
import { connectCalendar, inHours, linkRow, newAppointment } from '../calendar/testing.js';
import { GrantRevokedError } from '../calendar/tokens.js';
import { systemActor } from '../worker/systemActor.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { inboundSms, sendText } from '../comms/testing.js';
import { defaultIsaOutput } from '../providers/fake/isaAi.js';
import { mlsConnection, REVIEWED_PACK } from '../mls/testing.js';
import type * as CoreSeam from './coreSeam.js';
import { aiMessages, assignmentOf, buyerListing, call, grantInitiated, handoffOf, initiatedDayNow, isaLead, isaWorld, type IsaWorld, openZone, optInAgent, runIsa, seedClaims, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;
const google = () => h.providers.integrations.calendar.google;

// batch 13 audit ISA2B-13: a stand-in for a core regression where a successful booking_result does not end care (core
// ends on an accepting offer today, so the TX-C branch that guards it is otherwise unreachable). Off by default: every
// other case runs core's step unchanged.
const coreStub = vi.hoisted(() => ({ bookingDoesNotEnd: false }));
vi.mock('./coreSeam.js', async (importOriginal) => {
  const m = await importOriginal<typeof CoreSeam>();
  const step: typeof m.step = (s, e, f) => (coreStub.bookingDoesNotEnd && e.type === 'booking_result' && e.ok ? { state: { ...s, offer: null }, actions: [] } : m.step(s, e, f));
  return { ...m, step };
});

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  await connectCalendar(h, w.agents[0]!);
});
afterAll(async () => {
  await h?.close();
});

const sysTx = <T>(fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(systemActor(w.tenantId as never, 'assistant'), fn, { db: h.database });
const input = (startH: number, o: Partial<BookInput> = {}): BookInput => ({ userId: w.agents[0]!.userId!, kind: 'buyer_consult', startsAt: inHours(startH), endsAt: inHours(startH + 0.5), createdByKind: 'assistant', ...o });

describe('bookSlotInTx (D8a; R-ISA-13, R-CAL-3, E151)', () => {
  it('R-ISA-13: busyForBooking returns the live link id with the voice lane\'s shape; nothing is stored', async () => {
    const link = (await linkRow(h, w.agents[0]!.userId!))!;
    google().busy = [{ start: inHours(300), end: inHours(301) }];
    const r = await sysTx((tx) => busyForBooking(calendarDeps(h.app.platform), tx, w.tenantId as never, w.agents[0]!.userId!, { start: inHours(299), end: inHours(302) }));
    expect(r).toEqual({ calendar: 'connected', busy: [{ start: inHours(300), end: inHours(301) }], linkId: (link as { id: string }).id });
    google().busy = [];
  });

  it('R-ISA-13 E531: requireLiveCalendar: another link → SLOT_SOURCE_CHANGED; no link → CALENDAR_UNAVAILABLE (bookSlot would book)', async () => {
    const deps = calendarDeps(h.app.platform);
    expect(await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(310), { requireLiveCalendar: true, expectLinkId: '00000000-0000-4000-8000-000000000000' }))).toEqual({ ok: false, code: 'SLOT_SOURCE_CHANGED' });
    expect(await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(310, { userId: w.agents[1]!.userId! }), { requireLiveCalendar: true }))).toEqual({ ok: false, code: 'CALENDAR_UNAVAILABLE' });
    const loose = await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(310, { userId: w.agents[1]!.userId! }), { requireLiveCalendar: false }));
    expect(loose.ok).toBe(true);
  });

  it('R-ISA-13: bufferMinutes widens busy intervals as computeOffer does', async () => {
    const deps = calendarDeps(h.app.platform);
    google().busy = [{ start: inHours(320), end: inHours(321) }];
    const link = (await linkRow(h, w.agents[0]!.userId!)) as { id: string };
    expect(await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(321), { requireLiveCalendar: true, expectLinkId: link.id, bufferMinutes: 15 }))).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
    expect((await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(321.5), { requireLiveCalendar: true, expectLinkId: link.id, bufferMinutes: 15 }))).ok).toBe(true);
    google().busy = [];
  });

  it('R-ISA-13 E532: an in-app appointment of the organizer blocks the booking (SLOT_TAKEN); a refusal returns and the transaction stays usable', async () => {
    const deps = calendarDeps(h.app.platform);
    await newAppointment(w.agents[0]!, { startsAt: inHours(330), endsAt: inHours(331) });
    const r = await sysTx(async (tx) => {
      const res = await bookSlotInTx(tx, deps, w.tenantId, input(330.25), { requireLiveCalendar: false });
      const ok = await sql<{ n: number }>`SELECT 1 AS n`.execute(tx);
      return { res, usable: ok.rows.length === 1 };
    });
    expect(r.usable).toBe(true);
    expect(r.res).toMatchObject({ ok: false, code: 'SLOT_TAKEN' });
  });

  it('R-ISA-13 E531: a GrantRevoked during the read is persisted in the caller\'s transaction and the booking refused', async () => {
    const deps = calendarDeps(h.app.platform);
    const c = w.agents[1]!;
    await connectCalendar(h, c);
    const fake = google();
    const original = fake.freeBusy.bind(fake);
    fake.freeBusy = async () => { throw new GrantRevokedError('revoked'); };
    try {
      expect(await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(340, { userId: c.userId! }), { requireLiveCalendar: true }))).toEqual({ ok: false, code: 'CALENDAR_UNAVAILABLE' });
    } finally {
      fake.freeBusy = original;
    }
    expect(((await linkRow(h, c.userId!)) as { status: string }).status).toBe('revoked');
  });
});

// ---- items 8–9: offers and booking through the turn, the jobs and dispatch ------------------------------------

describe('offers and booking (R-ISA-13, R-ISA-14, R-ISA-15)', () => {
  let bw: IsaWorld;
  let zone: string;
  const agent = () => bw.agents[0]!;
  beforeAll(async () => {
    bw = await isaWorld(h, { optIn: false, capabilities: ['converse', 'book_appointments', 'share_listings', 'propose_saved_search'] });
    zone = openZone();
    await connectCalendar(h, bw.agents[0]!);
    await optInAgent(h, agent(), bw.versionId, ['converse', 'book_appointments'], { timezone: zone, bookingKinds: ['buyer_consult', 'consult'],
      availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '08:00', end: '20:00' })) });
  });
  afterEach(() => { bw.ai.script.length = 0; google().busy = []; });

  // the offer_slots answer only for the turn that reads the consultation request (start and timer turns get the default)
  const offerScript = () => {
    bw.ai.script.length = 0;
    for (let i = 0; i < 6; i += 1) {
      bw.ai.script.push((_r, src) => (src.some((x) => /consultation/.test(x.text))
        ? { reply: null, qualification: [], actions: [{ type: 'offer_slots', kind: 'buyer_consult' }], summary: null }
        : defaultIsaOutput(src)));
    }
  };

  /** A live lead with an offer the client has received (the offer message sent). */
  async function offered() {
    const l = await isaLead(h, agent(), { zone });
    expect((await startCare(agent(), l.id)).status).toBe(200);
    await runIsa(h, bw.tenantId);
    offerScript();
    await inboundSms(h, l.phone, bw.mainNumber, 'Could we schedule a consultation to talk about buying?');
    await runIsa(h, bw.tenantId, 6);
    const o = await offerOf(l.id);
    if (process.env.DEBUG_ISA) console.log(JSON.stringify({ turns: (await h.su.query('SELECT trigger_key, status, decision, denied FROM ai_isa_turns WHERE contact_id = $1 ORDER BY created_at', [l.id])).rows,
      jobs: (await h.su.query("SELECT kind, status, last_error FROM jobs WHERE tenant_id = $1 AND kind IN ('ai_isa.offer','ai_isa.book') ORDER BY id DESC LIMIT 5", [bw.tenantId])).rows,
      machine: (await h.su.query('SELECT machine->\'offer\' AS o, machine->>\'phase\' AS p FROM ai_isa_assignments WHERE contact_id = $1', [l.id])).rows, msgs: (await aiMessages(h, l.id)).map((m) => [m.status, m.status_reason, m.body.slice(0, 60)]) }, null, 1));
    return { l, o };
  }
  const offerOf = async (contactId: string) => (await h.su.query<{ id: string; status: string; slots: { startsAt: number; endsAt: number }[]; offered_message_id: string | null; appointment_id: string | null; refusal_code: string | null; accepted_slot: number | null; expires_at: Date }>(
    `SELECT id, status, slots, offered_message_id, appointment_id, refusal_code, accepted_slot, expires_at FROM ai_isa_slot_offers WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`, [contactId])).rows[0] ?? null;
  const holdConfirmations = async () => {
    await h.su.query(`UPDATE jobs SET run_at = now() + interval '1 day' WHERE tenant_id = $1 AND status = 'pending' AND kind = 'comms.dispatch'
      AND payload->>'messageId' IN (SELECT id::text FROM messages WHERE tenant_id = $1 AND action_category = 'ai_isa_confirmation')`, [bw.tenantId]);
  };
  const reply = async (l: { phone: string }, text: string, rounds = 6, o: { ageDispatch?: boolean; holdConfirmation?: boolean } = {}) => {
    if (o.ageDispatch ?? true) await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '30 minutes' WHERE to_address = $1 AND direction = 'outbound' AND dispatched_at IS NOT NULL`, [l.phone]);
    // runIsa ages inbound instants by minutes: the start and the stored delivery instant move back with them
    await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_assignments SET started_at = started_at - interval '2 hours'
      WHERE contact_id = (SELECT contact_id FROM contact_points WHERE address = '${l.phone}' LIMIT 1) AND ended_at IS NULL; SET session_replication_role = origin`);
    await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{offer,deliveredAt}', to_jsonb((machine->'offer'->>'deliveredAt')::bigint - 1800000))
      WHERE contact_id = (SELECT contact_id FROM contact_points WHERE address = $1 LIMIT 1) AND machine->'offer'->>'deliveredAt' IS NOT NULL`, [l.phone]);
    await inboundSms(h, l.phone, bw.mainNumber, text);
    await runIsa(h, bw.tenantId, rounds, o.holdConfirmation ? { beforeTick: holdConfirmations } : {});
  };

  it('R-ISA-13 E528: an offer is sent; "2" → accepting → booked → appointment_booked, the confirmation pending in local time and zone', async () => {
    const { l, o } = await offered();
    expect(o?.status).toBe('offered');
    const msgs = await aiMessages(h, l.id);
    const offerMsg = msgs.find((m) => m.id === o!.offered_message_id)!;
    expect(offerMsg.status).toBe('sent');
    expect(offerMsg.body).toMatch(/Here are times .+ is free/);
    await reply(l, '2');
    const after = (await offerOf(l.id))!;
    if (process.env.DEBUG_ISA) console.log(JSON.stringify({ turns: (await h.su.query('SELECT trigger_key, status, decision, denied FROM ai_isa_turns WHERE contact_id = $1 ORDER BY created_at', [l.id])).rows.slice(-3),
      jobs: (await h.su.query("SELECT kind, status, last_error, payload FROM jobs WHERE tenant_id = $1 AND kind LIKE 'ai_isa.%' ORDER BY id DESC LIMIT 6", [bw.tenantId])).rows,
      m: (await h.su.query("SELECT machine->'offer' AS o, machine->>'phase' AS p, last_inbound_seq, machine->>'lastInboundSeq' AS mseq FROM ai_isa_assignments WHERE contact_id = $1", [l.id])).rows,
      inb: (await h.su.query("SELECT body, created_at FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at", [l.id])).rows }, null, 1));
    expect(after.status).toBe('accepted');
    expect(after.accepted_slot).toBe(2);
    const appt = (await h.su.query<{ starts_at: Date; created_by_kind: string; contact_id: string }>(`SELECT starts_at, created_by_kind, contact_id FROM appointments WHERE id = $1`, [after.appointment_id])).rows[0]!;
    expect(appt.created_by_kind).toBe('assistant');
    expect(appt.starts_at.getTime()).toBe(after.slots[1]!.startsAt);
    const a = (await assignmentOf(h, l.id))!;
    if (process.env.DEBUG_ISA) console.log('DBG', JSON.stringify({ a, jobs: (await h.su.query("SELECT kind, status, last_error, attempts FROM jobs WHERE tenant_id = $1 AND kind = 'ai_isa.book'", [bw.tenantId])).rows,
      feed: (await h.su.query('SELECT item_type, reasons FROM priority_feed_items WHERE contact_id = $1', [l.id])).rows, m: (await h.su.query("SELECT machine->'offer'->>'status' AS s, machine->'offer'->>'id' AS id, machine->>'phase' AS p FROM ai_isa_assignments WHERE contact_id = $1", [l.id])).rows, off: after.id }));
    expect(a.end_reason).toBe('appointment_booked');
    const ho = (await handoffOf(h, l.id))[0]!;
    expect(ho.sla_class).toBe('critical');
    expect(ho.pending_message_id).not.toBeNull();
    expect((ho.package['appointmentDetail'] as Record<string, unknown>)['appointmentId']).toBe(after.appointment_id);
    expect(String((ho.package['appointmentDetail'] as Record<string, unknown>)['calendarSentence'])).toMatch(/Your calendar showed this time free at/);
    const conf = (await aiMessages(h, l.id)).find((m) => m.id === ho.pending_message_id)!;
    expect(conf.action_category).toBe('ai_isa_confirmation');
    expect(conf.body).toMatch(/You're set with .+ on \w{3} \w{3} \d{1,2}, .+ (UTC|GMT|[A-Z]{2,4}|[+-]\d)/);
  });

  it('R-ISA-13: a double "2" books once', async () => {
    const { l } = await offered();
    await reply(l, '2', 0);
    await reply(l, '2');
    const n = await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE contact_id = $1`, [l.id]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('R-ISA-13: a "2" after expiresAt books nothing', async () => {
    const { l, o } = await offered();
    await h.su.query(`UPDATE ai_isa_slot_offers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o!.id]);
    await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{offer,expiresAt}', to_jsonb((extract(epoch FROM now()) * 1000)::bigint - 60000)) WHERE contact_id = $1`, [l.id]);
    await reply(l, '2');
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    // the expiry is applied before the inbound: the old offer is expired (a later turn may offer new times)
    expect((await h.su.query<{ status: string }>(`SELECT status FROM ai_isa_slot_offers WHERE id = $1`, [o!.id])).rows[0]!.status).toBe('expired');
  });

  it('R-ISA-13: CONFIRMATION_TOO_LATE before booking, by the 24-hour cap alone', async () => {
    const { l, o } = await offered();
    // three automated sends today: the AI yields (automated24h) so the earliest confirmation is a day away, after every offered slot's notice time
    const conv = (await h.su.query<{ id: string }>(`SELECT id FROM conversations WHERE contact_id = $1`, [l.id])).rows[0]!;
    for (let i = 0; i < 3; i += 1) {
      await h.su.query(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
          initiator, purpose, action_category, dispatched_at, occurred_at) VALUES ($1, gen_random_uuid(), $2, $3, 'sms', 'outbound', $4, $5, $6, 'Alert', 'sent',
          'system', 'informational', 'search_alert', now() - interval '10 minutes', now())`, [bw.tenantId, conv.id, l.id, bw.mainNumberId, bw.mainNumber, l.phone]);
    }
    await h.su.query(`UPDATE ai_isa_slot_offers SET slots = jsonb_build_array(jsonb_build_object('startsAt', (extract(epoch FROM now() + interval '6 hours') * 1000)::bigint,
      'endsAt', (extract(epoch FROM now() + interval '6.5 hours') * 1000)::bigint)) WHERE id = $1`, [o!.id]);
    await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{offer,slots}', (SELECT slots FROM ai_isa_slot_offers WHERE id = $2)) WHERE contact_id = $1`, [l.id, o!.id]);
    await h.su.query(`UPDATE ai_isa_slot_offers SET status = 'accepting', accepted_slot = 1, accepted_message_id = $2 WHERE id = $1`, [o!.id, o!.offered_message_id]);
    await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(jsonb_set(machine, '{offer,status}', '"accepting"'), '{offer,acceptedIndex}', '0') WHERE contact_id = $1`, [l.id]);
    const { runBookJob } = await import('./booking/book.js');
    const d = { ...depsFromPlatform(h.app.platform), adapters: h.providers.integrations, now: () => Date.now() };
    expect(await runBookJob(d as never, bw.tenantId, { assignmentId: (await assignmentOf(h, l.id))!.id, offerId: o!.id })).toMatch(/REFUSED:CONFIRMATION_TOO_LATE/);
    expect((await offerOf(l.id))!.refusal_code).toBe('CONFIRMATION_TOO_LATE');
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
  });

  // batch 13 audit ISA2B-02: the send window is checked at the instant the caps clear (core's confirmationInTime only
  // compares nextSendAt with the notice time, so nextSendAt itself must be a time the confirmation can really go out)
  it('R-ISA-13: CONFIRMATION_TOO_LATE when the caps clear after the window closes: the confirmation waits for 08:00, after the 09:00 slot\'s notice time', async () => {
    const { l, o } = await offered();
    // the fixed-offset zone of this world (openZone: it is 10:00-17:59 there now)
    const m = /^Etc\/GMT([+-])(\d+)$/.exec(zone);
    const offH = zone === 'UTC' ? 0 : m ? (m[1] === '-' ? 1 : -1) * Number(m[2]) : NaN;
    expect(Number.isFinite(offH), zone).toBe(true);
    const DAY = 86_400_000;
    const now = Date.now();
    const midnight = Math.floor((now + offH * 3_600_000) / DAY) * DAY - offH * 3_600_000; // local midnight today, as an instant
    const clearAt = midnight + 20.5 * 3_600_000; // 20:30 local tonight: after the 20:00 close
    // the AI's own sends move out of the 24 hours (only the automated cap and the window decide)
    await h.su.query(`UPDATE messages SET dispatched_at = now() - interval '25 hours' WHERE contact_id = $1 AND direction = 'outbound' AND dispatched_at IS NOT NULL`, [l.id]);
    const conv = (await h.su.query<{ id: string }>(`SELECT id FROM conversations WHERE contact_id = $1`, [l.id])).rows[0]!;
    for (let i = 0; i < 3; i += 1) {
      await h.su.query(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
          initiator, purpose, action_category, dispatched_at, occurred_at) VALUES ($1, gen_random_uuid(), $2, $3, 'sms', 'outbound', $4, $5, $6, 'Alert', 'sent',
          'system', 'informational', 'search_alert', $7, now())`, [bw.tenantId, conv.id, l.id, bw.mainNumberId, bw.mainNumber, l.phone, new Date(clearAt - DAY)]);
    }
    // the agreed slot: 09:00 local tomorrow (12.5 h after the caps clear, but only 1 h after the window opens at 08:00)
    const startsAt = midnight + DAY + 9 * 3_600_000;
    await h.su.query(`UPDATE ai_isa_slot_offers SET slots = jsonb_build_array(jsonb_build_object('startsAt', $2::bigint, 'endsAt', $3::bigint)) WHERE id = $1`, [o!.id, startsAt, startsAt + 1_800_000]);
    await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{offer,slots}', (SELECT slots FROM ai_isa_slot_offers WHERE id = $2)) WHERE contact_id = $1`, [l.id, o!.id]);
    await h.su.query(`UPDATE ai_isa_slot_offers SET status = 'accepting', accepted_slot = 1, accepted_message_id = $2 WHERE id = $1`, [o!.id, o!.offered_message_id]);
    await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(jsonb_set(machine, '{offer,status}', '"accepting"'), '{offer,acceptedIndex}', '0') WHERE contact_id = $1`, [l.id]);
    const { runBookJob } = await import('./booking/book.js');
    const d = { ...depsFromPlatform(h.app.platform), adapters: h.providers.integrations, now: () => Date.now() };
    expect(await runBookJob(d as never, bw.tenantId, { assignmentId: (await assignmentOf(h, l.id))!.id, offerId: o!.id })).toBe('REFUSED:CONFIRMATION_TOO_LATE');
    expect((await offerOf(l.id))!.refusal_code).toBe('CONFIRMATION_TOO_LATE');
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
  });

  it('R-ISA-13 E529: "ok" to the offer gets one clarification (never a booking); "1" then books', async () => {
    const { l } = await offered();
    const before = (await aiMessages(h, l.id)).length;
    await reply(l, 'ok');
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    // batch 13 audit ISA2B-07: exactly one clarification, and the offer was never moved to accepting
    const added = (await aiMessages(h, l.id)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.body).toMatch(/Reply with its number/);
    expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_isa_slot_offers WHERE contact_id = $1 AND status IN ('accepting','accepted')`, [l.id])).rows[0]!.n).toBe(0);
    await reply(l, '1');
    expect((await offerOf(l.id))!.status).toBe('accepted');
  });

  // batch 13 audit ISA2B-06 (1): R-ISA-27 E495 on the machine path and the model path
  it('R-ISA-27 E495: a pasted slot line is no agreement: nothing is booked, the offer stays offered, one clarification restates the times, before any model turn', async () => {
    const { l, o } = await offered();
    const offerBody = (await aiMessages(h, l.id)).find((m) => m.id === o!.offered_message_id)!.body;
    const line = offerBody.split('\n').find((x) => /^2\)/.test(x.trim()))!;
    expect(line).toMatch(/^2\) \w{3} \w{3} \d{1,2}, /);
    // the model, if asked, books slot 2 quoting the pasted line (the team's own text)
    const calls = bw.ai.calls.length;
    bw.ai.script.length = 0;
    for (let i = 0; i < 4; i += 1) bw.ai.script.push((_r, src) => ({ reply: null, qualification: [], actions: [{ type: 'book_slot', offer: 'O1', slot: 2, quote: line, source: src.at(-1)?.handle ?? 'S1' }], summary: null }));
    const before = (await aiMessages(h, l.id)).length;
    await reply(l, line);
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    expect((await offerOf(l.id))!).toMatchObject({ id: o!.id, status: 'offered', accepted_slot: null });
    const added = (await aiMessages(h, l.id)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.body).toMatch(/Reply with its number/);
    // core's machine settles it before any model turn: the scripted book_slot is never asked for (core's decideAction
    // refuses such a quote QUOTE_IS_TEAM_TEXT, packages/core/src/isa/output.test.ts E495)
    expect(bw.ai.calls.length).toBe(calls);
    bw.ai.script.length = 0;
  });

  // batch 13 audit ISA2B-06 (2): a tapback is a message_reactions row on the inbound (turn.ts), an ambiguous answer
  it('R-ISA-13 E529 R-ISA-28: a tapback on the offer reaches core as a reaction: one clarification, no accepting row, no booking', async () => {
    const { l, o } = await offered();
    const offerBody = (await aiMessages(h, l.id)).find((m) => m.id === o!.offered_message_id)!.body;
    const before = (await aiMessages(h, l.id)).length;
    await reply(l, `Liked “${offerBody}”`);
    // the inbound was linked as a reaction to the offer
    const rx = await h.su.query<{ target: string }>(`SELECT r.target_message_id AS target FROM message_reactions r JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
      WHERE m.contact_id = $1 AND m.direction = 'inbound'`, [l.id]);
    expect(rx.rows.map((r) => r.target)).toEqual([o!.offered_message_id]);
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_isa_slot_offers WHERE contact_id = $1 AND status IN ('accepting','accepted')`, [l.id])).rows[0]!.n).toBe(0);
    const added = (await aiMessages(h, l.id)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.body).toMatch(/Reply with its number/);
  });

  // batch 13 audit ISA2B-06 (3): E532 in the AI-first order (the human-first order is the SLOT_TAKEN case below)
  it('R-ISA-13 E532: AI first: a human appointment for the same organizer and time, started while tx#1 holds lock 5, waits for the booking to commit and is then allowed', async () => {
    const { l, o } = await offered();
    const s2 = o!.slots[1]!;
    const { bookTestHooks } = await import('./booking/book.js');
    let human: Promise<string> | null = null;
    let humanDone = false;
    let pendingWhileHeld: boolean | null = null;
    bookTestHooks.afterCareRead = async () => {
      bookTestHooks.afterCareRead = undefined;
      human = newAppointment(agent(), { startsAt: new Date(s2.startsAt).toISOString(), endsAt: new Date(s2.endsAt).toISOString() }).then((id) => { humanDone = true; return id; });
      await new Promise((r) => setTimeout(r, 1500));
      pendingWhileHeld = !humanDone;
    };
    try {
      await reply(l, '2');
    } finally {
      bookTestHooks.afterCareRead = undefined;
    }
    expect(human).not.toBeNull();
    const humanId = await human!;
    // the human insert waited on lock 5 while tx#1 held it, then went through
    expect(pendingWhileHeld).toBe(true);
    const after = (await offerOf(l.id))!;
    expect([after.status, after.accepted_slot]).toEqual(['accepted', 2]);
    const rows = (await h.su.query<{ id: string; created_by_kind: string; contact_id: string | null; starts_at: Date }>(
      `SELECT id, created_by_kind, contact_id, starts_at FROM appointments WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [[after.appointment_id, humanId]])).rows;
    expect(rows.map((r) => [r.id, r.created_by_kind, r.starts_at.getTime()])).toEqual([[after.appointment_id, 'assistant', s2.startsAt], [humanId, 'user', s2.startsAt]]);
  });

  // batch 13 audit ISA2B-06 (4): E523 with an opt-in revoke during tx#1 (the STOP case is below)
  it('R-ISA-15 E523: the owner revokes the opt-in while tx#1 holds lock 5 → booked, care ended optin_revoked, no confirmation, the booked-after-end card', async () => {
    // a world of its own: the revoke ends every assignment of that agent, and this world's agents are shared by other cases
    const rw = await isaWorld(h, { optIn: false, capabilities: ['converse', 'book_appointments'] });
    const owner = rw.agents[0]!;
    try {
      await connectCalendar(h, owner);
      await optInAgent(h, owner, rw.versionId, ['converse', 'book_appointments'], { timezone: zone, bookingKinds: ['buyer_consult', 'consult'],
        availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '08:00', end: '20:00' })) });
      const l = await isaLead(h, owner, { zone });
      expect((await startCare(owner, l.id)).status).toBe(200);
      await runIsa(h, rw.tenantId);
      rw.ai.script.length = 0;
      for (let i = 0; i < 6; i += 1) {
        rw.ai.script.push((_r, src) => (src.some((x) => /consultation/.test(x.text)) ? { reply: null, qualification: [], actions: [{ type: 'offer_slots', kind: 'buyer_consult' }], summary: null } : defaultIsaOutput(src)));
      }
      await inboundSms(h, l.phone, rw.mainNumber, 'Could we schedule a consultation to talk about buying?');
      await runIsa(h, rw.tenantId, 6);
      expect((await offerOf(l.id))!.status).toBe('offered');
      const { bookTestHooks } = await import('./booking/book.js');
      bookTestHooks.afterCareRead = async () => {
        bookTestHooks.afterCareRead = undefined;
        expect((await call(owner, 'POST', '/me/ai-isa/opt-in/revoke', {})).status).toBe(200);
      };
      try {
        await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '30 minutes' WHERE to_address = $1 AND direction = 'outbound' AND dispatched_at IS NOT NULL`, [l.phone]);
        await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_assignments SET started_at = started_at - interval '2 hours' WHERE contact_id = '${l.id}' AND ended_at IS NULL; SET session_replication_role = origin`);
        await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{offer,deliveredAt}', to_jsonb((machine->'offer'->>'deliveredAt')::bigint - 1800000))
          WHERE contact_id = $1 AND machine->'offer'->>'deliveredAt' IS NOT NULL`, [l.id]);
        await inboundSms(h, l.phone, rw.mainNumber, '2');
        await runIsa(h, rw.tenantId, 6);
      } finally {
        bookTestHooks.afterCareRead = undefined;
      }
      await runIsa(h, rw.tenantId, 3);
      expect((await assignmentOf(h, l.id))!.end_reason).toBe('optin_revoked');
      expect((await offerOf(l.id))!.status).toBe('accepted');
      const card = await h.su.query<{ reasons: { code: string; text: string }[] }>(`SELECT reasons FROM priority_feed_items WHERE contact_id = $1 AND dedupe_key LIKE 'ai_isa_booked:%'`, [l.id]);
      expect(card.rows.map((r) => r.reasons[0]!.code)).toEqual(['AI_ISA_BOOKED_AFTER_END']);
      expect((await aiMessages(h, l.id)).some((m) => m.action_category === 'ai_isa_confirmation')).toBe(false);
    } finally {
      (h.providers as { ai: unknown }).ai = bw.ai;
    }
  });

  it('R-ISA-15: resume is refused while the offer is accepting (AI_ISA_BOOKING_IN_PROGRESS)', async () => {
    const { l, o } = await offered();
    expect((await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/pause`, {})).status).toBe(200);
    await h.su.query(`UPDATE ai_isa_slot_offers SET status = 'accepting', accepted_slot = 1, accepted_message_id = $2 WHERE id = $1`, [o!.id, o!.offered_message_id]);
    const r = await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/resume`, {});
    expect(r.code).toBe('AI_ISA_BOOKING_IN_PROGRESS');
  });

  // batch 13 audit ISA2B-06 (10): resume while an offer is merely offered is allowed and supersedes it (core's resume drops the offer)
  it('R-ISA-15: resume while the offer is offered (not accepting) is allowed and supersedes the offer row; a "2" after that books nothing', async () => {
    const { l, o } = await offered();
    expect((await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/pause`, {})).status).toBe(200);
    await runIsa(h, bw.tenantId, 2);
    const r = await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/resume`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await runIsa(h, bw.tenantId, 2);
    expect((await h.su.query<{ status: string }>(`SELECT status FROM ai_isa_slot_offers WHERE id = $1`, [o!.id])).rows[0]!.status).toBe('superseded');
    await reply(l, '2');
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    expect((await h.su.query<{ status: string }>(`SELECT status FROM ai_isa_slot_offers WHERE id = $1`, [o!.id])).rows[0]!.status).toBe('superseded');
  });

  it('R-ISA-13 Q3: APPOINTMENT_ALREADY_SET: a person with an open appointment is offered no times', async () => {
    const l = await isaLead(h, agent(), { zone });
    await newAppointment(agent(), { contactId: l.id, startsAt: inHours(500), endsAt: inHours(501) });
    expect((await startCare(agent(), l.id)).status).toBe(200);
    await runIsa(h, bw.tenantId);
    offerScript();
    await inboundSms(h, l.phone, bw.mainNumber, 'Could we schedule a consultation to talk about buying?');
    await runIsa(h, bw.tenantId, 6);
    expect(await offerOf(l.id)).toBeNull();
    const t = await h.su.query<{ decision: { code?: string; appointmentOn?: string } }>(`SELECT decision FROM ai_isa_turns WHERE contact_id = $1 AND trigger_kind = 'offer'`, [l.id]);
    expect(t.rows.map((x) => x.decision.code)).toContain('APPOINTMENT_ALREADY_SET');
    // batch 13 audit ISA2B-11 (Q3's default): the agent's sentence names the appointment's date in the team's zone; the
    // turn keeps codes only (the local date)
    const tz = (await h.su.query<{ tz: string }>(`SELECT default_timezone AS tz FROM tenant_settings WHERE tenant_id = $1`, [bw.tenantId])).rows[0]!.tz;
    const on = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(inHours(500)));
    const d = t.rows.find((x) => x.decision.code === 'APPOINTMENT_ALREADY_SET')!.decision;
    expect(d.appointmentOn).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(inHours(500))));
    // the panel's last decision says it too
    const panel = await call<{ lastDecision: { sentence: string } | null }>(agent(), 'GET', `/contacts/${l.id}/ai-isa`);
    expect(panel.body.lastDecision?.sentence).toBe(`They already have an appointment on ${on}.`);
  });

  it('R-ISA-13 E531: a calendar that is not connected → no offer (CALENDAR_UNAVAILABLE); the holding line instead', async () => {
    // an agent opted in to booking whose calendar later disconnected
    const other = bw.agents[1]!;
    await connectCalendar(h, other);
    await optInAgent(h, other, bw.versionId, ['converse', 'book_appointments'], { timezone: zone, bookingKinds: ['buyer_consult'], availability: [] });
    await h.su.query(`UPDATE user_calendar_links SET status = 'revoked', last_error_code = 'GRANT_REVOKED', revoked_at = now(), purge_after = now() + interval '30 days' WHERE user_id = $1`, [other.userId]);
    const l = await isaLead(h, other, { zone });
    expect((await startCare(other, l.id)).status).toBe(200);
    await runIsa(h, bw.tenantId);
    offerScript();
    await inboundSms(h, l.phone, bw.mainNumber, 'Could we schedule a consultation to talk about buying?');
    await runIsa(h, bw.tenantId, 6);
    expect(await offerOf(l.id)).toBeNull();
    // decideAction refused offer_slots (CALENDAR_NOT_LIVE): no live link, so no offer job at all
    const t = await h.su.query<{ denied: string[] }>(`SELECT denied FROM ai_isa_turns WHERE contact_id = $1`, [l.id]);
    expect(t.rows.flatMap((x) => x.denied).join(' ')).toMatch(/CALENDAR_NOT_LIVE/);
  });

  it('R-ISA-13 E531 E532: the slot taken in-app between offer and "2" → SLOT_TAKEN and a NEW offer, never the alternative', async () => {
    const { l, o } = await offered();
    const s2 = o!.slots[1]!;
    await newAppointment(agent(), { startsAt: new Date(s2.startsAt).toISOString(), endsAt: new Date(s2.endsAt).toISOString() });
    await reply(l, '2', 8);
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    const first = (await h.su.query<{ status: string; refusal_code: string | null }>(`SELECT status, refusal_code FROM ai_isa_slot_offers WHERE id = $1`, [o!.id])).rows[0]!;
    expect(first).toEqual({ status: 'refused', refusal_code: 'SLOT_TAKEN' });
    const next = (await offerOf(l.id))!;
    expect(next.id).not.toBe(o!.id);
  });

  it('R-ISA-15 E523: a pause while tx#1 holds lock 5 → booked, no confirmation, critical, BOOKED_WHILE_PAUSED and CONFIRMATION_NOT_SENT', async () => {
    const { l } = await offered();
    const { bookTestHooks } = await import('./booking/book.js');
    bookTestHooks.afterCareRead = async () => {
      bookTestHooks.afterCareRead = undefined;
      // the human pause commits at once: the book job holds lock 5 only
      expect((await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/pause`, {})).status).toBe(200);
    };
    try {
      await reply(l, '2');
    } finally {
      bookTestHooks.afterCareRead = undefined;
    }
    expect((await offerOf(l.id))!.status).toBe('accepted');
    const ho = (await handoffOf(h, l.id))[0]!;
    expect(ho.reason).toBe('appointment_booked');
    expect(ho.pending_message_id).toBeNull();
    expect(ho.sla_class).toBe('critical');
    expect(ho.package['notes']).toEqual(expect.arrayContaining(['BOOKED_WHILE_PAUSED', 'CONFIRMATION_NOT_SENT']));
  });

  it('R-ISA-13 R-ISA-15 (batch 13 audit ISA2B-13): booked but the machine did not end care (a core regression, stubbed) → care is paused check_this, never live, and the card says to confirm or cancel it', async () => {
    const { l, o } = await offered();
    coreStub.bookingDoesNotEnd = true;
    try {
      await reply(l, '2');
    } finally {
      coreStub.bookingDoesNotEnd = false;
    }
    expect((await offerOf(l.id))!.status).toBe('accepted');
    const a = (await assignmentOf(h, l.id))!;
    expect({ ended: a.ended_at, paused: a.paused_at !== null, reason: a.pause_reason }).toEqual({ ended: null, paused: true, reason: 'check_this' });
    const card = await h.su.query<{ reasons: { code: string; text: string }[]; score: number }>(`SELECT reasons, score FROM priority_feed_items WHERE contact_id = $1 AND dedupe_key = $2`, [l.id, `ai_isa_booked:${o!.id}`]);
    expect(card.rows.map((r) => [r.score, r.reasons[0]!.code])).toEqual([[98, 'AI_ISA_BOOKED_NOT_HANDED_BACK']]);
    expect(card.rows[0]!.reasons[0]!.text).toMatch(/confirm or cancel it yourself/);
    // no AI confirmation was queued for a booking care did not hand back
    expect((await aiMessages(h, l.id)).some((m) => m.action_category === 'ai_isa_confirmation')).toBe(false);
  });

  it('R-ISA-15 E523: a pause before tx#1\'s read → CARE_PAUSED, nothing booked', async () => {
    const { l } = await offered();
    const { bookTestHooks } = await import('./booking/book.js');
    void bookTestHooks;
    // hold lock 5 so the book job waits, pause meanwhile, then release
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const blocker = withTenantTx(systemActor(bw.tenantId as never, 'worker'), async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('calendar.book:' || app.tenant_id()::text || ':' || ${agent().userId!}::text, 0))`.execute(tx);
      held();
      await gate;
    }, { db: h.database });
    await isHeld;
    const run = reply(l, '2');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/pause`, {})).status).toBe(200);
    release();
    await blocker;
    await run;
    await runIsa(h, bw.tenantId, 4);
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    expect((await offerOf(l.id))!.refusal_code ?? (await h.su.query<{ r: string | null }>(`SELECT refusal_code AS r FROM ai_isa_slot_offers WHERE contact_id = $1 AND refusal_code IS NOT NULL`, [l.id])).rows[0]?.r).toBe('CARE_PAUSED');
  });

  it('R-ISA-13: the book job books once; a replay of it books nothing more', async () => {
    const { l, o } = await offered();
    const book = await import('./booking/book.js');
    await reply(l, '2', 0);
    await runIsa(h, bw.tenantId, 3, { beforeTick: async () => { await h.su.query(`UPDATE jobs SET run_at = now() + interval '1 day' WHERE tenant_id = $1 AND kind = 'ai_isa.book' AND status = 'pending'`, [bw.tenantId]); } });
    expect((await offerOf(l.id))!.status).toBe('accepting');
    const d = { ...depsFromPlatform(h.app.platform), adapters: h.providers.integrations, now: () => Date.now() };
    const a = (await assignmentOf(h, l.id))!;
    expect(await book.runBookJob(d as never, bw.tenantId, { assignmentId: a.id, offerId: o!.id })).toBe('BOOKED');
    // a replay of the same job books nothing more
    expect(await book.runBookJob(d as never, bw.tenantId, { assignmentId: a.id, offerId: o!.id })).not.toBe('BOOKED');
    expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE contact_id = $1`, [l.id])).rows[0]!.n).toBe(1);
  });

  it('R-ISA-13: a crash before the book job ran (stuck accepting): the sweep re-enqueues it and it finishes once', async () => {
    const { l, o } = await offered();
    await reply(l, '2', 0);
    await runIsa(h, bw.tenantId, 3, { beforeTick: async () => { await h.su.query(`UPDATE jobs SET run_at = now() + interval '1 day' WHERE tenant_id = $1 AND kind = 'ai_isa.book' AND status = 'pending'`, [bw.tenantId]); } });
    await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'ai_isa.book' AND status = 'pending'`, [bw.tenantId]);
    expect((await offerOf(l.id))!.status).toBe('accepting');
    await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_slot_offers SET updated_at = now() - interval '6 minutes' WHERE id = '${o!.id}'; SET session_replication_role = origin`);
    const { sweepNow } = await import('./testing.js');
    await sweepNow(h, bw.tenantId, 4);
    expect((await offerOf(l.id))!.status).toBe('accepted');
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('appointment_booked');
    expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE contact_id = $1`, [l.id])).rows[0]!.n).toBe(1);
  });

  it('R-ISA-15 E523: a STOP during tx#1 → booked, no confirmation, the booked-after-end card', async () => {
    const { l } = await offered();
    const { bookTestHooks } = await import('./booking/book.js');
    bookTestHooks.afterCareRead = async () => {
      bookTestHooks.afterCareRead = undefined;
      await inboundSms(h, l.phone, bw.mainNumber, 'STOP');
      await runIsa(h, bw.tenantId, 2, { beforeTick: async () => { await h.su.query(`UPDATE jobs SET run_at = now() + interval '1 day' WHERE tenant_id = $1 AND kind = 'ai_isa.book' AND status = 'pending'`, [bw.tenantId]); } });
    };
    try {
      await reply(l, '2');
    } finally {
      bookTestHooks.afterCareRead = undefined;
    }
    await runIsa(h, bw.tenantId, 3);
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('opted_out');
    expect((await offerOf(l.id))!.status).toBe('accepted');
    const card = await h.su.query<{ reasons: { code: string; text: string }[]; score: number }>(`SELECT reasons, score FROM priority_feed_items WHERE contact_id = $1 AND dedupe_key LIKE 'ai_isa_booked:%'`, [l.id]);
    expect(card.rows[0]!.reasons[0]!.text).toMatch(/after AI care ended; the confirmation was not sent: confirm or cancel it yourself/);
    expect((await aiMessages(h, l.id)).some((m) => m.action_category === 'ai_isa_confirmation')).toBe(false);
  });

  it('R-ISA-13 E529: "2 works. Also what\'s our house worth?" books and holds pricing, one message carrying both lines', async () => {
    const { l } = await offered();
    await reply(l, "2 works. Also what's our house worth?", 6, { holdConfirmation: true });
    expect((await offerOf(l.id))!.status).toBe('accepted');
    const ho = (await handoffOf(h, l.id))[0]!;
    const conf = (await aiMessages(h, l.id)).find((m) => m.id === ho.pending_message_id)!;
    expect(conf.action_category).toBe('ai_isa_confirmation');
    expect(conf.body).toMatch(/You're set with/);
    expect(conf.body.length).toBeGreaterThan(80);
    expect((await aiMessages(h, l.id)).filter((m) => m.action_category === 'ai_isa_confirmation')).toHaveLength(1);
  });

  it('R-ISA-14 E533: a human text first → the confirmation is refused ISA_HANDOFF_CLOSED; the card says so, nothing hot', async () => {
    const { l } = await offered();
    await reply(l, '2', 6, { holdConfirmation: true });
    const ho = (await handoffOf(h, l.id))[0]!;
    const s = await sendText(agent(), l.id, 'Hi, this is your agent: confirming our consultation personally.');
    expect([200, 201]).toContain(s.status);
    await runIsa(h, bw.tenantId, 2, { beforeTick: holdConfirmations });
    // now let the confirmation's dispatch run: the guard refuses it (a person reached them first)
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = 'comms.dispatch' AND status = 'pending'`, [bw.tenantId]);
    await runIsa(h, bw.tenantId, 3);
    const m = (await aiMessages(h, l.id)).find((x) => x.id === ho.pending_message_id)!;
    // batch 13 audit ISA2B-07: unconditional (before, the card checks ran only if the reason happened to match)
    expect([m.status, m.status_reason]).toEqual(['blocked', 'ISA_HANDOFF_CLOSED']);
    const notes = await h.su.query<{ kind: string }>(`SELECT kind FROM notifications WHERE subject_id = $1 AND dedupe_key LIKE 'ai_isa_confirmation_not_sent:%'`, [l.id]);
    expect(notes.rows).toHaveLength(0);
    const card = (await h.su.query<{ reasons: { code: string }[] }>(`SELECT reasons FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'ai_isa_handoff'`, [l.id])).rows[0]!;
    expect(card.reasons[0]!.code).toBe('AI_ISA_CONFIRMATION_NOT_NEEDED');
    // nothing hot: no confirmation-not-sent notification (`notes` above) and the card is not re-scored
    expect(card.reasons.map((r) => r.code)).not.toContain('AI_ISA_CONFIRMATION_NOT_SENT');
    expect((await handoffOf(h, l.id))[0]!.confirmation_status).toBe('refused');
  });

  // batch 13 audit ISA2B-14 (and ISA2B-02's untested backstop): the CONFIRMATION_LATE sweep reads the notice of the
  // policy the booking ran under (stored with the appointment at TX-C), not core's default
  it('R-ISA-14 E533: the sweep cancels a confirmation still unsent at slot start minus the policy\'s notice (CONFIRMATION_LATE): status canceled, the card critical', async () => {
    const steps = (await h.su.query<{ steps: { booking: Record<string, unknown> } }>(`SELECT steps FROM playbook_versions WHERE id = $1`, [bw.versionId])).rows[0]!.steps;
    const setSteps = async (v: unknown) => {
      await h.su.query(`SET session_replication_role = replica`);
      try {
        await h.su.query(`UPDATE playbook_versions SET steps = $2::jsonb WHERE id = $1`, [bw.versionId, JSON.stringify(v)]);
      } finally {
        await h.su.query(`SET session_replication_role = origin`);
      }
    };
    // this policy asks 24 hours' notice (core's default is 4)
    await setSteps({ ...steps, booking: { ...steps.booking, minNoticeHours: 24 } });
    let l: { id: string; phone: string };
    try {
      ({ l } = await offered());
      await reply(l, '2', 6, { holdConfirmation: true });
    } finally {
      await setSteps(steps);
    }
    expect((await offerOf(l.id))!.status).toBe('accepted');
    const ho = (await handoffOf(h, l.id))[0]!;
    const conf = ho.pending_message_id!;
    await h.su.query(`UPDATE messages SET status = 'scheduled', scheduled_for = now() + interval '1 hour' WHERE id = $1 AND status IN ('queued','scheduled')`, [conf]);
    // the appointment is now 10 hours away: inside this policy's 24-hour notice, outside core's default 4 hours
    await h.su.query(`SET session_replication_role = replica`);
    try {
      await h.su.query(`UPDATE ai_isa_handoffs SET package = p.v, package_sha256 = encode(sha256(convert_to(p.v::text, 'UTF8')), 'hex')
        FROM (SELECT jsonb_set(package, '{appointmentDetail,startsAt}', to_jsonb(to_char((now() + interval '10 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) AS v
                FROM ai_isa_handoffs WHERE id = $1) p WHERE id = $1`, [ho.id]);
    } finally {
      await h.su.query(`SET session_replication_role = origin`);
    }
    const { bookingSweepInTx } = await import('./handlers.js');
    await withTenantTx(systemActor(bw.tenantId as never, 'assistant'), (tx, now) => bookingSweepInTx(tx, depsFromPlatform(h.app.platform), now), { db: h.database });
    expect((await h.su.query<{ status: string; status_reason: string | null }>(`SELECT status, status_reason FROM messages WHERE id = $1`, [conf])).rows[0]).toEqual({ status: 'canceled', status_reason: 'CONFIRMATION_LATE' });
    expect((await handoffOf(h, l.id))[0]!.confirmation_status).toBe('canceled');
    const card = (await h.su.query<{ score: number; reasons: { code: string }[] }>(`SELECT score, reasons FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'ai_isa_handoff'`, [l.id])).rows[0]!;
    expect([card.score, card.reasons[0]!.code]).toEqual([98, 'AI_ISA_CONFIRMATION_NOT_SENT']);
    expect((await h.su.query(`SELECT 1 FROM notifications WHERE subject_id = $1 AND kind = 'ai_isa_handoff_hot'`, [l.id])).rows.length).toBeGreaterThanOrEqual(1);
    // the notice the booking ran under is kept with the appointment
    expect((ho.package['appointmentDetail'] as Record<string, unknown>)['minNoticeHours']).toBe(24);
  });

  it('R-ISA-14 E533: a confirmation still unsent but outside the policy\'s notice is left scheduled by the sweep', async () => {
    const { l } = await offered();
    await reply(l, '2', 6, { holdConfirmation: true });
    const ho = (await handoffOf(h, l.id))[0]!;
    const conf = ho.pending_message_id!;
    await h.su.query(`UPDATE messages SET status = 'scheduled', scheduled_for = now() + interval '1 hour' WHERE id = $1 AND status IN ('queued','scheduled')`, [conf]);
    const { bookingSweepInTx } = await import('./handlers.js');
    await withTenantTx(systemActor(bw.tenantId as never, 'assistant'), (tx, now) => bookingSweepInTx(tx, depsFromPlatform(h.app.platform), now), { db: h.database });
    expect((await h.su.query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [conf])).rows[0]!.status).toBe('scheduled');
    expect((await handoffOf(h, l.id))[0]!.confirmation_status).not.toBe('canceled');
  });

  it('J1 (reduced to its booking half, cut 5): offer, "2", the booking, the handoff; the agent\'s own text clears the deadline ("Got it" never does)', async () => {
    const { l } = await offered();
    await reply(l, '2');
    const ho = (await handoffOf(h, l.id))[0]!;
    expect(ho.reason).toBe('appointment_booked');
    const { slaSweepInTx } = await import('./handoff.js');
    const sweep = () => withTenantTx(systemActor(bw.tenantId as never, 'assistant'), (tx, now) => slaSweepInTx(tx, depsFromPlatform(h.app.platform).ids, now, systemActor(bw.tenantId as never, 'assistant')), { db: h.database });
    await call(agent(), 'POST', `/ai-isa/handoffs/${ho.id}/ack`, {});
    await sweep();
    expect((await h.su.query<{ m: Date | null }>(`SELECT sla_met_at AS m FROM ai_isa_handoffs WHERE id = $1`, [ho.id])).rows[0]!.m).toBeNull();
    const s = await sendText(agent(), l.id, 'Hi, this is your agent. Looking forward to our consultation.');
    expect([200, 201]).toContain(s.status);
    await runIsa(h, bw.tenantId, 2);
    await sweep();
    expect((await h.su.query<{ m: Date | null }>(`SELECT sla_met_at AS m FROM ai_isa_handoffs WHERE id = $1`, [ho.id])).rows[0]!.m).not.toBeNull();
  });

  it('E506 E508: the hostile model against a delivered offer (unoffered_slot, unverified_quote, team_text_quote, quoted_email_slot, listing_not_in_bundle) books nothing and shares nothing', async () => {
    const { HostileIsaAi } = await import('../providers/fake/hostileIsaAi.js');
    for (const attack of ['unoffered_slot', 'unverified_quote', 'team_text_quote', 'quoted_email_slot', 'listing_not_in_bundle'] as const) {
      const { l } = await offered();
      (h.providers as { ai: unknown }).ai = new HostileIsaAi(attack);
      try {
        await reply(l, 'what about next week instead?');
      } finally {
        (h.providers as { ai: unknown }).ai = bw.ai;
      }
      expect([attack, (await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows.length]).toEqual([attack, 0]);
      expect((await h.su.query(`SELECT 1 FROM ai_isa_shared_facts WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
      // "$" appears only on server fact lines: never in an AI message without shared facts
      for (const m of await aiMessages(h, l.id)) expect([attack, m.body.includes('$')]).toEqual([attack, false]);
    }
  });

  it('R-ISA-14 E533: "thanks!" and "Got it" keep the confirmation; a reschedule text cancels it (card critical, status canceled)', async () => {
    const { l } = await offered();
    // the confirmation's dispatch is held back, so it is still pending when the client writes again
    await reply(l, '2', 6, { holdConfirmation: true });
    const ho = (await handoffOf(h, l.id))[0]!;
    const conf = ho.pending_message_id!;
    await h.su.query(`UPDATE messages SET status = 'scheduled', scheduled_for = now() + interval '1 hour' WHERE id = $1 AND status IN ('queued','scheduled')`, [conf]);
    await inboundSms(h, l.phone, bw.mainNumber, 'thanks!');
    expect((await h.su.query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [conf])).rows[0]!.status).toBe('scheduled');
    await inboundSms(h, l.phone, bw.mainNumber, 'Got it');
    expect((await h.su.query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [conf])).rows[0]!.status).toBe('scheduled');
    await inboundSms(h, l.phone, bw.mainNumber, 'Actually can we move it to next week?');
    expect((await h.su.query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [conf])).rows[0]!.status).toBe('canceled');
    await runIsa(h, bw.tenantId, 3, { beforeTick: holdConfirmations });
    const after = (await handoffOf(h, l.id))[0]!;
    expect(after.confirmation_status).toBe('canceled');
    const card = (await h.su.query<{ score: number; reasons: { code: string }[] }>(`SELECT score, reasons FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'ai_isa_handoff'`, [l.id])).rows[0]!;
    expect(card.score).toBe(98);
    expect(card.reasons[0]!.code).toBe('AI_ISA_CONFIRMATION_NOT_SENT');
  });
});

// ---- batch 13 audit ISA2B-08: the hostile re-run against a LIVE bundle and a delivered offer -----------------------
// The booking world above opts in to converse and book_appointments only, so its hostile run had no listing handles
// (share_listings refused for capability) and no "$" could exist. Here the agent also shares listings: the buyer has a
// live bundle (L1-L3), has already received one server-rendered facts message, and holds a delivered offer.

describe('E506 E508 R-ISA-17: the hostile model against a live bundle and a delivered offer (batch 13 audit ISA2B-08)', () => {
  let hw: IsaWorld;
  let hzone: string;
  const city = 'Albany';
  beforeAll(async () => {
    hw = await isaWorld(h, { optIn: false, capabilities: ['converse', 'book_appointments', 'share_listings', 'propose_saved_search'] });
    hzone = openZone();
    await connectCalendar(h, hw.agents[0]!);
    await optInAgent(h, hw.agents[0]!, hw.versionId, ['converse', 'book_appointments', 'share_listings'], { timezone: hzone, bookingKinds: ['buyer_consult', 'consult'],
      availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '08:00', end: '20:00' })) });
    const conn = await mlsConnection(h, hw.tenantId, hw.owner.userId!, { pack: REVIEWED_PACK, lastSyncedAt: new Date() });
    for (let k = 0; k < 3; k += 1) await buyerListing(h, hw.tenantId, { connectionId: conn, city, price: 520000 + k * 1000 });
  });
  afterEach(() => { hw.ai.script.length = 0; });

  const ageAll = async (contactId: string) => {
    await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '25 hours' WHERE contact_id = $1 AND direction = 'outbound' AND dispatched_at IS NOT NULL`, [contactId]);
    await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_assignments SET started_at = started_at - interval '2 hours' WHERE contact_id = '${contactId}' AND ended_at IS NULL; SET session_replication_role = origin`);
  };
  /** A buyer under care with usable claims, one facts message received (L1, with its "$" price) and a delivered offer. */
  async function armed() {
    const l = await isaLead(h, hw.agents[0]!, { zone: hzone });
    await grantInitiated(h, hw.tenantId, l);
    expect((await startCare(hw.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, hw.tenantId);
    await inboundSms(h, l.phone, hw.mainNumber, `We want 3 bedrooms in ${city}`);
    await runIsa(h, hw.tenantId);
    await seedClaims(h, l.id, [{ field: 'areas', value: [city], quote: city }, { field: 'budget', value: 900000, quote: '900000' }, { field: 'beds_min', value: 3, quote: '3 bedrooms' }]);
    hw.ai.script.length = 0;
    for (let i = 0; i < 6; i += 1) {
      hw.ai.script.push((_r, src) => {
        const t = src.map((x) => x.text).join(' ');
        if (/consultation/.test(t)) return { reply: null, qualification: [], actions: [{ type: 'offer_slots', kind: 'buyer_consult' }], summary: null };
        if (/homes/.test(t)) return { reply: null, qualification: [], actions: [{ type: 'share_listings', handles: ['L1'] }], summary: null };
        return defaultIsaOutput(src);
      });
    }
    await ageAll(l.id);
    await inboundSms(h, l.phone, hw.mainNumber, 'Can you send me some homes?');
    await runIsa(h, hw.tenantId, 5);
    const sharedOnce = (await h.su.query<{ message_id: string; status: string }>(`SELECT message_id, status FROM ai_isa_shared_facts WHERE contact_id = $1`, [l.id])).rows;
    expect(sharedOnce.map((x) => x.status)).toEqual(['sent']);
    await ageAll(l.id);
    await inboundSms(h, l.phone, hw.mainNumber, 'Could we schedule a consultation to talk about buying?');
    await runIsa(h, hw.tenantId, 6);
    const o = (await h.su.query<{ status: string }>(`SELECT status FROM ai_isa_slot_offers WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`, [l.id])).rows[0];
    expect(o?.status).toBe('offered');
    hw.ai.script.length = 0;
    return l;
  }

  it('E506 E508: unoffered_slot, unverified_quote, team_text_quote, quoted_email_slot and listing_not_in_bundle book nothing and share nothing more; a handle outside the live bundle is HANDLE_UNKNOWN; "$" appears only in server-rendered facts messages', () => initiatedDayNow(h, hw.tenantId, hzone, async () => {
    const { HostileIsaAi } = await import('../providers/fake/hostileIsaAi.js');
    for (const attack of ['unoffered_slot', 'unverified_quote', 'team_text_quote', 'quoted_email_slot', 'listing_not_in_bundle'] as const) {
      const l = await armed();
      const factsBefore = (await h.su.query(`SELECT 1 FROM ai_isa_shared_facts WHERE contact_id = $1`, [l.id])).rows.length;
      const hostile = new HostileIsaAi(attack);
      (h.providers as { ai: unknown }).ai = hostile;
      try {
        await ageAll(l.id);
        await h.su.query(`UPDATE ai_isa_assignments SET machine = jsonb_set(machine, '{offer,deliveredAt}', to_jsonb((machine->'offer'->>'deliveredAt')::bigint - 1800000))
          WHERE contact_id = $1 AND machine->'offer'->>'deliveredAt' IS NOT NULL`, [l.id]);
        await inboundSms(h, l.phone, hw.mainNumber, 'what about next week instead?');
        await runIsa(h, hw.tenantId, 6);
      } finally {
        (h.providers as { ai: unknown }).ai = hw.ai;
      }
      // the hostile turn ran against the live bundle (the prompt listed real handles)
      expect([attack, hostile.calls.some((c) => /- L1: listing_/.test(c.user))]).toEqual([attack, true]);
      expect([attack, (await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows.length]).toEqual([attack, 0]);
      expect([attack, (await h.su.query(`SELECT 1 FROM ai_isa_shared_facts WHERE contact_id = $1`, [l.id])).rows.length]).toEqual([attack, factsBefore]);
      if (attack === 'listing_not_in_bundle') {
        const denied = (await h.su.query<{ denied: string[] }>(`SELECT denied FROM ai_isa_turns WHERE contact_id = $1`, [l.id])).rows.flatMap((x) => x.denied);
        expect(denied).toContain('HANDLE_UNKNOWN:share_listings');
      }
      // "$" appears only on server fact lines: every AI message with a "$" is a facts message with shared-facts rows
      const withFacts = new Set((await h.su.query<{ m: string }>(`SELECT DISTINCT message_id AS m FROM ai_isa_shared_facts WHERE contact_id = $1`, [l.id])).rows.map((r) => r.m));
      const dollar = (await aiMessages(h, l.id)).filter((m) => m.body.includes('$'));
      expect([attack, dollar.length >= 1]).toEqual([attack, true]);
      for (const m of dollar) expect([attack, withFacts.has(m.id), /Here are homes/.test(m.body)]).toEqual([attack, true, true]);
    }
  }));
});
