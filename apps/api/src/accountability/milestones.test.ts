// R-ACC-6 milestone_at_risk and the R-MKT-8 failed_send exclusion over real Postgres (module 18a; R-TXN-2,
// R-TXN-3, E94, E152, E156–E158). The recompute runs as the system actor (what the 60-second job does) and
// loads the milestone dates itself; the queue is read through the real server as the Team Lead, under RLS.
//
// Module 31 (the only writer of the Phase 2 deal-date columns: status, due_at, responsible) is not built
// yet, so the superuser sets those stored columns the way its confirm step would; the date itself is
// entered and moved through the Phase 1 deal routes as the agent (a person's fact). Module 29 (open-house
// invites) is not built either: the superuser gives a failed message the invite shape.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { grantConsent } from '../comms/testing.js';
import { type AccWorld, accWorld, acceptedLead, call, daytimeContact, itemRow, queue, recompute, sendText } from './testing.js';

let h: ApiHarness;
let w: AccWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await accWorld(h);
});
afterAll(async () => {
  await h?.close();
});

const HOUR = 3_600_000;

/** A deal of the agent with one date typed on the deal screen (manual, confirmed), and its stored instant. */
async function dealDate(o: { kind?: string; dueInMs: number; responsible?: string | null }): Promise<{ dealId: string; dateId: string }> {
  const lead = await acceptedLead(h, w);
  const d = await call<{ deal: { id: string } }>(lead.owner, 'POST', '/deals', { primaryContactId: lead.contactId, side: 'buy' });
  expect(d.status).toBe(201);
  const dueOn = new Date(Date.now() + o.dueInMs).toISOString().slice(0, 10);
  const dd = await call<{ date: { id: string } }>(lead.owner, 'POST', `/deals/${d.body.deal.id}/dates`, { kind: o.kind ?? 'inspection', dueOn });
  expect(dd.status).toBe(201);
  await h.su.query(`UPDATE deal_dates SET due_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'), responsible = $3 WHERE id = $1`, [dd.body.date.id, o.dueInMs, o.responsible === undefined ? 'agent' : o.responsible]);
  owners.set(d.body.deal.id, lead.owner);
  return { dealId: d.body.deal.id, dateId: dd.body.date.id };
}
/** deal id → the agent who owns the deal */
const owners = new Map<string, AccWorld['agents'][number]>();
const key = (dateId: string, v = 1) => `milestone:${dateId}:${v}`;

describe('R-ACC-6 milestone_at_risk', () => {
  it('E156 / R-ACC-6 R-TXN-3: a confirmed inspection deadline that passed uncompleted is milestone_at_risk (overdue) for the deal owner, in the Team Lead queue, linked to the deal', async () => {
    const { dealId, dateId } = await dealDate({ dueInMs: -2 * HOUR });
    const r = await recompute(h, w.tenantId);
    expect(r.inputs.milestones).toBeGreaterThanOrEqual(1);
    const row = await itemRow(h, key(dateId));
    expect(row).not.toBeNull();
    expect(row!.owner_user_id).toBe(owners.get(dealId)!.userId);
    const item = (await queue(w.teamLead!, '?type=milestone_at_risk')).items.find((i) => i.dedupeKey === key(dateId))!;
    expect(item).toMatchObject({ itemType: 'milestone_at_risk', contact: null, live: true, owner: { userId: owners.get(dealId)!.userId } });
    expect(item.evidence[0]).toMatchObject({ sourceType: 'deal_date', sourceId: dateId, explanation: 'Inspection deadline has passed and is not marked done' });
    expect((row!.evidence as { predicate?: string }[]).map((e) => e.predicate).filter(Boolean)).toEqual(['overdue']);
    expect(item.evidence.find((e) => e.sourceType === 'deal')?.link).toMatchObject({ kind: 'deal', id: dealId });
    expect(item.actions.reassign).toBe(false); // no contact to move
    const counts = (await queue(w.teamLead!)).counts;
    expect(counts.byType.milestone_at_risk).toBeGreaterThanOrEqual(1);
  });

  it('E157 / R-ACC-6: a confirmed appraisal date 36 h away with no responsible party is milestone_at_risk (unassigned); with a responsible party it is not', async () => {
    const open = await dealDate({ kind: 'appraisal', dueInMs: 36 * HOUR, responsible: null });
    const covered = await dealDate({ kind: 'appraisal', dueInMs: 36 * HOUR, responsible: 'lender' });
    await recompute(h, w.tenantId);
    const row = await itemRow(h, key(open.dateId));
    expect((row!.evidence as { predicate?: string; explanation: string }[]).filter((e) => e.predicate).map((e) => [e.predicate, e.explanation])).toEqual([
      ['unassigned', 'Appraisal date is due within 48 h and nobody is named as responsible for it'],
    ]);
    expect(await itemRow(h, key(covered.dateId))).toBeNull();
    // naming someone responsible clears it (the item stays in the queue until handled, R-ACC-1)
    await h.su.query(`UPDATE deal_dates SET responsible = 'lender' WHERE id = $1`, [open.dateId]);
    await recompute(h, w.tenantId);
    expect((await itemRow(h, key(open.dateId)))!.condition_cleared_at).not.toBeNull();
  });

  it('E158 / R-TXN-2 R-TXN-3: a proposed (unconfirmed) date due tomorrow, or a waived one already past, is never a risk', async () => {
    const proposed = await dealDate({ dueInMs: 20 * HOUR, responsible: null });
    await h.su.query(`UPDATE deal_dates SET source = 'template', status = 'proposed' WHERE id = $1`, [proposed.dateId]);
    const waived = await dealDate({ dueInMs: -5 * HOUR, responsible: null });
    await h.su.query(`UPDATE deal_dates SET status = 'waived' WHERE id = $1`, [waived.dateId]);
    await recompute(h, w.tenantId);
    expect(await itemRow(h, key(proposed.dateId))).toBeNull();
    expect(await itemRow(h, key(waived.dateId))).toBeNull();
  });

  it('E156 R-ACC-1 R-TXN-3: after the agent moves the date, due_version bumps and the key changes: the old occurrence clears, the new one is judged on its own; done late is "fixed late"', async () => {
    const { dealId, dateId } = await dealDate({ dueInMs: -3 * HOUR });
    await recompute(h, w.tenantId);
    expect((await itemRow(h, key(dateId, 1)))!.condition_cleared_at).toBeNull();
    // the deal owner moves it on the deal screen (a person moves a confirmed date): the DB bumps due_version
    const mover = owners.get(dealId)!;
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await call(mover, 'PATCH', `/deal-dates/${dateId}`, { dueOn: later })).status).toBe(200);
    const moved = (await h.su.query('SELECT due_version, due_at FROM deal_dates WHERE id = $1', [dateId])).rows[0];
    expect(moved.due_version).toBe(2);
    await recompute(h, w.tenantId);
    expect((await itemRow(h, key(dateId, 1)))!.condition_cleared_at).not.toBeNull();
    expect(await itemRow(h, key(dateId, 2))).toBeNull();
    // module 31 stores the new instant; it is overdue again (clock fixture): a new occurrence, then done late
    await h.su.query(`UPDATE deal_dates SET due_at = clock_timestamp() - interval '1 hour' WHERE id = $1`, [dateId]);
    await recompute(h, w.tenantId);
    expect((await itemRow(h, key(dateId, 2)))!.condition_cleared_at).toBeNull();
    expect((await call(mover, 'PATCH', `/deal-dates/${dateId}`, { completed: true })).status).toBe(200);
    await recompute(h, w.tenantId);
    expect((await itemRow(h, key(dateId, 2)))!.condition_cleared_at).not.toBeNull();
  });

  it('R-ACC-1: a recompute with nothing changed writes nothing for milestone items (idempotent)', async () => {
    await dealDate({ dueInMs: -HOUR });
    await recompute(h, w.tenantId);
    const again = await recompute(h, w.tenantId);
    expect(again.upserted).toBe(0);
  });
});

describe('R-MKT-8 failed_send exclusion', () => {
  it('E94 E152 / R-MKT-8: an open-house invite recipient blocked at send time raises no failed_send; a normal failed text still does', async () => {
    const lead = await acceptedLead(h, w);
    await daytimeContact(h, lead.contactId);
    await grantConsent(lead.owner, lead.contactId, 'sms');
    h.providers.telephony.failNext('rejected');
    const normal = (await sendText(lead.owner, lead.contactId, 'Hi, following up on the house')).body.message!.id;
    h.providers.telephony.failNext('rejected');
    const invite = (await sendText(lead.owner, lead.contactId, 'You are invited to the open house')).body.message!.id;

    // module 29 is not built: give the second row the invite shape (email, marketing, linked to its piece) and
    // the status the dispatch guard gives an opted-out recipient
    const listing = await call<{ listing: { id: string } }>(lead.owner, 'POST', '/listings', { status: 'active', addressLine1: '12 Oak St', city: 'Oakland', region: 'CA', postalCode: '94610', listPriceCents: 85000000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family' });
    expect(listing.status).toBe(201);
    const pieceId = randomUUID();
    await h.su.query(
      `INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, status, prose, template_key, content_sha256, guard_result)
       VALUES ($1, $2, $3, 'open_house_invite', 1, 'draft', '{"headline":"Open house Saturday"}', 'invite.v1', repeat('0', 64), '{}')`,
      [w.tenantId, pieceId, listing.body.listing.id],
    );
    const identityId = randomUUID();
    await h.su.query(`INSERT INTO email_identities (tenant_id, id, from_address, display_name) VALUES ($1, $2, $3, 'The team')`, [w.tenantId, identityId, `team-${identityId.slice(0, 8)}@example.test`]);
    await h.su.query(
      `UPDATE messages SET channel = 'email', purpose = 'marketing', marketing_piece_id = $2, email_identity_id = $3, phone_number_id = NULL,
              to_address = 'invitee@example.test', status_reason = 'RECIPIENT_OPTED_OUT' WHERE id = $1`,
      [invite, pieceId, identityId],
    );
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    await recompute(h, w.tenantId);
    expect(await itemRow(h, `send:${normal}`)).not.toBeNull();
    expect(await itemRow(h, `send:${invite}`)).toBeNull();
    const failed = (await queue(w.teamLead!, '?type=failed_send')).items.map((i) => i.dedupeKey);
    expect(failed).toContain(`send:${normal}`);
    expect(failed).not.toContain(`send:${invite}`);
  });
});
