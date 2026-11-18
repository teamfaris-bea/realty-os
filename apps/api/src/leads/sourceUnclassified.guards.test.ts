// R-LSRC-9 A6 (owner decision 2026-11-14; migration 0101): the database guards, on the real tables.
//
// Each of the three source guards fires on INSERT as well as on the UPDATE that activates, and raises the reason that
// applies ('SOURCE_UNCLASSIFIED: ...' or 'SOURCE_NO_AUTOMATED_CONTACT: ...'):
//   - app.messages_source_guard: an automated message INSERTED directly in a sending state (dispatching, sent, delivered,
//     dispatch_unknown) for a covered person is refused, as the move to 'dispatching' is; a person's one-to-one message,
//     the keyword replies, a client's own sign-in link and imported history are not; a later status reconciliation of a
//     message that was already on its way is never refused;
//   - app.playbook_enrollments_source_guard: a plan made active (insert or update); a pause, a stop and a paused insert pass;
//   - app.calls_source_guard: a call the assistant takes (insert or update); a person's own call and an inbound call pass.
// Imported history (initiator 'import') is in no automated class and is never judged. They are cheap and take no lock:
// they look at the row first and ask the definer only for the activating write. What
// they do with a missing tenant context is unchanged from 0098 (they return): only the migration owner writes that way
// (fixtures, the demo seed), never the application (packages/db/test/source_unclassified_0101.test.ts shows why).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedPlaybook, enrollmentRow, smsStep } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { type CommsWorld, type TestContact, call, commsWorld, freshReauth, ownedContact } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, type SourceRefusal, sourceGuardViolation } from './automatedContact.js';
import { importedPerson } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let marked: string;
let plan: { playbookId: string; versionId: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  agent = w.agents[0]!;
  await freshReauth(h, w.owner);
  marked = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referrals (test)', kind: 'referral' })).body.source.id;
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
  plan = await approvedPlaybook(w.owner, {
    kind: 'nurture',
    scope: 'team',
    name: 'Two check-ins (test)',
    steps: [
      smsStep({ key: 'first', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] }),
      smsStep({ key: 'second', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in again.', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 86_400 }),
    ],
  });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const sys = () => systemActor(w.tenantId, 'worker');
/** The guard's reason for an error, or the error itself when it is something else (so a wrong failure is visible). */
const refusal = (p: Promise<unknown>): Promise<SourceRefusal | null | string> =>
  p.then(() => null, (e: unknown) => sourceGuardViolation(e) ?? `other: ${(e as Error).message}`);

interface Direct {
  status: string;
  initiator?: 'system' | 'human' | 'assistant';
  category?: string;
}

/** One outbound text row written straight into `status` (never through compose or dispatch), as the system actor. */
function insertDirect(c: TestContact, o: Direct): Promise<unknown> {
  const sent = ['dispatching', 'sent', 'delivered', 'dispatch_unknown'].includes(o.status);
  return withTenantTx(sys(), async (tx) => {
    const conv = (await sql<{ id: string }>`SELECT id FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${c.id}::uuid`.execute(tx)).rows[0]!.id;
    await sql`
      INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, initiator,
                            initiated_by_user_id, purpose, action_category, idempotency_key, occurred_at, dispatched_at, imported)
      VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${conv}::uuid, ${c.id}::uuid, 'sms', 'outbound', ${w.mainNumberId}::uuid, ${w.mainNumber}, ${c.phone},
              'Two homes match your search.', ${o.status}, ${o.initiator ?? 'system'}, ${o.initiator === 'human' ? agent.userId! : null}::uuid, 'informational',
              ${o.category ?? 'search_alert'}, ${`direct:${randomUUID()}`}, now(), ${sent ? sql`now()` : sql`NULL`}, false)`.execute(tx);
  }, { db: h.database });
}

/** A person with a conversation (a system message queued for them, then left queued). */
async function person(): Promise<TestContact> {
  const c = await ownedContact(agent);
  const q = await withTenantTx(sys(), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: 'Hello from the team.', initiator: 'system', purpose: 'informational', category: 'search_alert', idempotencyKey: `seed:${randomUUID()}` }, now), { db: h.database });
  expect(q.ok).toBe(true);
  return c;
}

describe('R-LSRC-9 A6: the message guard fires on INSERT too, and only for an automated send', () => {
  it('R-LSRC-9 E736: an automated message inserted directly in a sending state for an unclassified person is refused with SOURCE_UNCLASSIFIED, in every sending state; for a marked source\'s person with SOURCE_NO_AUTOMATED_CONTACT; a queued row is not a send and passes', async () => {
    const unreviewed = await person();
    await importedPerson(h, w.tenantId, w.owner.userId!, unreviewed.id);
    const partner = await person();
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [partner.id, marked]);
    const plain = await person();
    for (const status of ['dispatching', 'sent', 'delivered', 'dispatch_unknown']) {
      expect(await refusal(insertDirect(unreviewed, { status })), status).toBe(SOURCE_UNCLASSIFIED);
      expect(await refusal(insertDirect(partner, { status })), status).toBe(SOURCE_NO_AUTOMATED_CONTACT);
      expect(await refusal(insertDirect(plain, { status })), status).toBeNull();
    }
    expect(await refusal(insertDirect(unreviewed, { status: 'queued' }))).toBeNull();
    expect((await h.su.query("SELECT 1 FROM messages WHERE contact_id = $1 AND status IN ('dispatching','sent','delivered','dispatch_unknown')", [unreviewed.id])).rows).toEqual([]);
  });

  it('R-LSRC-9 E731 E736: the exemptions are exactly the marked source\'s, no wider: a person\'s one-to-one message, the STOP confirmation, the HELP reply and a client\'s own sign-in link pass in a sending state; any other system message does not', async () => {
    const c = await person();
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    expect(await refusal(insertDirect(c, { status: 'sent', initiator: 'human', category: 'none' }))).toBeNull();
    for (const category of ['opt_out_confirmation', 'help_reply', 'portal_login_link']) expect(await refusal(insertDirect(c, { status: 'sent', category })), category).toBeNull();
    for (const category of ['search_alert', 'nurture_step', 'speed_to_lead_reply', 'none']) expect(await refusal(insertDirect(c, { status: 'sent', category })), category).toBe(SOURCE_UNCLASSIFIED);
  });

  it('R-LSRC-9 E736: on UPDATE only the move to dispatching is judged: a message already on its way when the person became unclassified is reconciled to sent without a refusal', async () => {
    const c = await person();
    const q = await withTenantTx(sys(), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: 'One home matches.', initiator: 'system', purpose: 'informational', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h.database });
    const id = (q as { messageId: string }).messageId;
    const set = (status: string) => withTenantTx(sys(), (tx) => sql`UPDATE messages SET status = ${status}, dispatched_at = COALESCE(dispatched_at, now()) WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx), { db: h.database });
    expect(await refusal(set('dispatching'))).toBeNull(); // not covered yet: TX1's move
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    expect(await refusal(set('sent'))).toBeNull(); // TX2 and the reconciler record what the provider did
    expect(await refusal(set('delivered'))).toBeNull();
    // a second message, still queued: its move to dispatching is refused now
    const q2 = await withTenantTx(sys(), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: 'Another home.', initiator: 'system', purpose: 'informational', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h.database });
    expect(await refusal(withTenantTx(sys(), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${(q2 as { messageId: string }).messageId}::uuid`.execute(tx), { db: h.database }))).toBe(SOURCE_UNCLASSIFIED);
  });

  it('R-LSRC-9 A6: with no tenant context (the migration owner: a fixture, the demo seed) the guard returns, exactly as 0098 did; it never raises a new error for a missing context', async () => {
    const c = await person();
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    const conv = (await h.su.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [c.id])).rows[0]!.id;
    await expect(h.su.query(
      `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, initiator, purpose, action_category, occurred_at, dispatched_at)
       VALUES ($1, $2, $3, $4, 'sms', 'outbound', $5, $6, $7, 'A fixture row.', 'sent', 'system', 'informational', 'search_alert', now(), now())`,
      [w.tenantId, randomUUID(), conv, c.id, w.mainNumberId, w.mainNumber, c.phone],
    )).resolves.toBeDefined();
  });
});

describe('R-LSRC-9 A6: the enrolment and call guards look only at the activating write', () => {
  it('R-LSRC-9 E736: a plan inserted active, or made active again, is refused with the reason that applies; a paused insert, a pause and a stop always pass (a plan can always be stopped)', async () => {
    const c = await ownedContact(agent);
    const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: plan.playbookId });
    expect(e.status).toBe(201);
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    const as = (state: string, extra = sql``) => withTenantTx(sys(), (tx) => sql`UPDATE playbook_enrollments SET state = ${state} ${extra} WHERE tenant_id = app.tenant_id() AND id = ${e.body.enrollment.id}::uuid`.execute(tx), { db: h.database });
    // a pause, by the system (an opt-out, a reply): never refused, never waits
    expect(await refusal(as('paused', sql`, pause_reason = 'opt_out', paused_at = now()`))).toBeNull();
    expect((await enrollmentRow(h, e.body.enrollment.id)).state).toBe('paused');
    // active again (a person resuming it, as themselves): refused
    expect(await refusal(withTenantTx(agent.actor(), (tx) => sql`UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, resumed_by_user_id = app.user_id()
      WHERE tenant_id = app.tenant_id() AND id = ${e.body.enrollment.id}::uuid`.execute(tx), { db: h.database }))).toBe(SOURCE_UNCLASSIFIED);
    // a stop: never refused
    expect(await refusal(as('stopped', sql`, stop_reason = 'manual', ended_at = now(), pause_reason = NULL, paused_at = NULL`))).toBeNull();
    expect((await enrollmentRow(h, e.body.enrollment.id)).state).toBe('stopped');
    // inserts: active refused, for either reason; paused passes
    const d = await ownedContact(agent);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [d.id, marked]);
    const insert = (contactId: string, state: string) => withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state, current_step, pause_reason, paused_at)
      VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${plan.playbookId}::uuid, ${plan.versionId}::uuid, ${contactId}::uuid, 'new_lead', ${state}, 0, ${state === 'paused' ? 'manual' : null}, ${state === 'paused' ? sql`now()` : sql`NULL`})`.execute(tx), { db: h.database });
    expect(await refusal(insert(c.id, 'active'))).toBe(SOURCE_UNCLASSIFIED);
    expect(await refusal(insert(d.id, 'active'))).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect(await refusal(insert(d.id, 'paused'))).toBeNull();
  });

  it('R-LSRC-9 E736: a call inserted as the assistant\'s is refused with SOURCE_UNCLASSIFIED; the same call as a person\'s passes, and so does an inbound call', async () => {
    const c = await person();
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    const insert = (handledBy: string, direction: 'inbound' | 'outbound') => withTenantTx(sys(), async (tx) => {
      const conv = (await sql<{ id: string }>`SELECT id FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${c.id}::uuid`.execute(tx)).rows[0]!.id;
      await sql`INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, status, started_at, handled_by, recording_mode, recording_decision, phone_number_id)
        VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${conv}::uuid, ${c.id}::uuid, ${direction}, ${agent.userId!}::uuid, ${c.phone}, ${direction === 'inbound' ? 'client' : 'human'}, 'ringing', now(), ${handledBy}, 'off', '{}'::jsonb, ${w.mainNumberId}::uuid)`.execute(tx);
    }, { db: h.database });
    expect(await refusal(insert('assistant', 'inbound'))).toBe(SOURCE_UNCLASSIFIED);
    expect(await refusal(insert('human', 'inbound'))).toBeNull();
    expect(await refusal(insert('human', 'outbound'))).toBeNull();
  });
});
