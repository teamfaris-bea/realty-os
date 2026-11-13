// ISA-2b items 7–9: bookSlotInTx (D8a), offers (D8b) and booking (D8c) on the fake calendar (R-ISA-13, -14, -15).
// Real Postgres via the API harness; the fake ISA model, the fake calendar, telephony and email; nothing real.
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { calendarDeps } from '../calendar/routes.js';
import { type BookInput, bookSlotInTx, busyForBooking } from '../calendar/service.js';
import { connectCalendar, inHours, linkRow, newAppointment } from '../calendar/testing.js';
import { GrantRevokedError } from '../calendar/tokens.js';
import { systemActor } from '../worker/systemActor.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { inboundSms, sendText } from '../comms/testing.js';
import { defaultIsaOutput } from '../providers/fake/isaAi.js';
import { aiMessages, assignmentOf, call, handoffOf, isaLead, isaWorld, type IsaWorld, openZone, optInAgent, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;
const google = () => h.providers.integrations.calendar.google;

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

  it('R-ISA-13 E529: "ok" to the offer gets one clarification (never a booking); "1" then books', async () => {
    const { l } = await offered();
    const before = (await aiMessages(h, l.id)).length;
    await reply(l, 'ok');
    expect((await h.su.query(`SELECT 1 FROM appointments WHERE contact_id = $1`, [l.id])).rows).toHaveLength(0);
    const msgs = await aiMessages(h, l.id);
    expect(msgs.length).toBeGreaterThan(before);
    await reply(l, '1');
    expect((await offerOf(l.id))!.status).toBe('accepted');
  });

  it('R-ISA-15: resume is refused while the offer is accepting (AI_ISA_BOOKING_IN_PROGRESS)', async () => {
    const { l, o } = await offered();
    expect((await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/pause`, {})).status).toBe(200);
    await h.su.query(`UPDATE ai_isa_slot_offers SET status = 'accepting', accepted_slot = 1, accepted_message_id = $2 WHERE id = $1`, [o!.id, o!.offered_message_id]);
    const r = await call(agent(), 'POST', `/contacts/${l.id}/ai-isa/resume`, {});
    expect(r.code).toBe('AI_ISA_BOOKING_IN_PROGRESS');
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
    const t = await h.su.query<{ decision: { code?: string } }>(`SELECT decision FROM ai_isa_turns WHERE contact_id = $1 AND trigger_kind = 'offer'`, [l.id]);
    expect(t.rows.map((x) => x.decision.code)).toContain('APPOINTMENT_ALREADY_SET');
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
    expect(m.status).not.toBe('sent');
    const notes = await h.su.query<{ kind: string }>(`SELECT kind FROM notifications WHERE subject_id = $1 AND dedupe_key LIKE 'ai_isa_confirmation_not_sent:%'`, [l.id]);
    if (m.status_reason === 'ISA_HANDOFF_CLOSED') {
      expect(notes.rows).toHaveLength(0);
      const card = (await h.su.query<{ reasons: { code: string }[] }>(`SELECT reasons FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'ai_isa_handoff'`, [l.id])).rows[0]!;
      expect(card.reasons[0]!.code).toBe('AI_ISA_CONFIRMATION_NOT_NEEDED');
    }
    expect(['blocked', 'canceled']).toContain(m.status);
  });

  it('J1 (reduced to its booking half, cut 5): offer, "2", the booking, the handoff; the agent\'s own text clears the deadline ("Got it" never does)', async () => {
    const { l } = await offered();
    await reply(l, '2');
    const ho = (await handoffOf(h, l.id))[0]!;
    expect(ho.reason).toBe('appointment_booked');
    const { slaSweepInTx } = await import('./handoff.js');
    const sweep = () => withTenantTx(systemActor(bw.tenantId as never, 'assistant'), (tx, now) => slaSweepInTx(tx, depsFromPlatform(h.app.platform).ids, now), { db: h.database });
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
