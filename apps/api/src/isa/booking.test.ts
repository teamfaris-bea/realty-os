// ISA-2b items 7–9: bookSlotInTx (D8a), offers (D8b) and booking (D8c) on the fake calendar (R-ISA-13, -14, -15).
// Real Postgres via the API harness; the fake ISA model, the fake calendar, telephony and email; nothing real.
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { calendarDeps } from '../calendar/routes.js';
import { type BookInput, bookSlotInTx, busyForBooking } from '../calendar/service.js';
import { connectCalendar, inHours, linkRow, newAppointment } from '../calendar/testing.js';
import { GrantRevokedError } from '../calendar/tokens.js';
import { systemActor } from '../worker/systemActor.js';
import { isaWorld, type IsaWorld } from './testing.js';

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
const input = (startH: number, o: Partial<BookInput> = {}): BookInput => ({ userId: w.agents[0]!.userId, kind: 'buyer_consult', startsAt: inHours(startH), endsAt: inHours(startH + 0.5), createdByKind: 'assistant', ...o });

describe('bookSlotInTx (D8a; R-ISA-13, R-CAL-3, E151)', () => {
  it('R-ISA-13: busyForBooking returns the live link id with the voice lane\'s shape; nothing is stored', async () => {
    const link = (await linkRow(h, w.agents[0]!.userId))!;
    google().busy = [{ start: inHours(300), end: inHours(301) }];
    const r = await sysTx((tx) => busyForBooking(calendarDeps(h.app.platform), tx, w.tenantId as never, w.agents[0]!.userId, { start: inHours(299), end: inHours(302) }));
    expect(r).toEqual({ calendar: 'connected', busy: [{ start: inHours(300), end: inHours(301) }], linkId: (link as { id: string }).id });
    google().busy = [];
  });

  it('R-ISA-13 E531: requireLiveCalendar: another link → SLOT_SOURCE_CHANGED; no link → CALENDAR_UNAVAILABLE (bookSlot would book)', async () => {
    const deps = calendarDeps(h.app.platform);
    expect(await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(310), { requireLiveCalendar: true, expectLinkId: '00000000-0000-4000-8000-000000000000' }))).toEqual({ ok: false, code: 'SLOT_SOURCE_CHANGED' });
    expect(await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(310, { userId: w.agents[1]!.userId }), { requireLiveCalendar: true }))).toEqual({ ok: false, code: 'CALENDAR_UNAVAILABLE' });
    const loose = await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(310, { userId: w.agents[1]!.userId }), { requireLiveCalendar: false }));
    expect(loose.ok).toBe(true);
  });

  it('R-ISA-13: bufferMinutes widens busy intervals as computeOffer does', async () => {
    const deps = calendarDeps(h.app.platform);
    google().busy = [{ start: inHours(320), end: inHours(321) }];
    const link = (await linkRow(h, w.agents[0]!.userId)) as { id: string };
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
      expect(await sysTx((tx) => bookSlotInTx(tx, deps, w.tenantId, input(340, { userId: c.userId }), { requireLiveCalendar: true }))).toEqual({ ok: false, code: 'CALENDAR_UNAVAILABLE' });
    } finally {
      fake.freeBusy = original;
    }
    expect(((await linkRow(h, c.userId)) as { status: string }).status).toBe('revoked');
  });
});
