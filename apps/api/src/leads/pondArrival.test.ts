// A pond arrival alerts the team leads (b19 team-queue lane, step 2; owner decision 4, 2026-11-19; DATA_MODEL
// R-TEAMQ-12, E938 to E942), through the real intake, the real timers, the real release command and the real
// ownership engine against Postgres as app_user. The alert is the existing `pond_new` notification at high priority,
// written in the same transaction as the move, once per arrival. Nothing here is a message to the client.
import { randomUUID } from 'node:crypto';
import type { ContactId, PondId } from '@realty/core/foundation';
import { applyOwnershipCommandInTx, derivedCommandId, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { call, command, contactState, freshReauth, intake, ledger, leadsWorker, leadsWorld, postIntake, randomPhone, setOfferExpiry } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

interface Note {
  user_id: string;
  kind: string;
  priority: string;
  title: string;
  body: string | null;
  subject_id: string;
  dedupe_key: string;
}
const pondNotes = async (tenantId: string, contactId?: string) =>
  (await h.su.query<Note>(`SELECT user_id, kind, priority, title, body, subject_id, dedupe_key FROM notifications WHERE tenant_id = $1 AND kind = 'pond_new' AND ($2::uuid IS NULL OR subject_id = $2) ORDER BY created_at, user_id`, [tenantId, contactId ?? null])).rows;
const deliveries = async (tenantId: string, contactId: string) =>
  (await h.su.query<{ channel: string; status: string }>(`SELECT d.channel, d.status FROM notification_deliveries d JOIN notifications n ON n.tenant_id = d.tenant_id AND n.id = d.notification_id WHERE n.tenant_id = $1 AND n.kind = 'pond_new' AND n.subject_id = $2 ORDER BY d.channel`, [tenantId, contactId])).rows;
/** Everything that could reach the client: stored messages and calls of the tenant, and jobs that send. */
const toClients = async (tenantId: string) =>
  (await h.su.query<{ messages: number; calls: number; sends: number }>(
    `SELECT (SELECT count(*)::int FROM messages WHERE tenant_id = $1) AS messages, (SELECT count(*)::int FROM calls WHERE tenant_id = $1) AS calls,
            (SELECT count(*)::int FROM jobs WHERE tenant_id = $1 AND kind IN ('comms.dispatch', 'playbook.step')) AS sends`,
    [tenantId],
  )).rows[0]!;
const seqOf = async (contactId: string) => Number((await contactState(h, contactId)).ownership_seq);

describe('R-TEAMQ-12 a pond arrival alerts the team leads', () => {
  it('R-TEAMQ-12 E938 E939: no rule matched: the Team Lead gets exactly one pond_new at high priority with its in-app and push delivery, committed with the move; a replayed delivery of the same inquiry alerts nobody again; nothing goes to the client', async () => {
    const w = await leadsWorld(h, { agents: 2, teamLead: true, rule: false });
    const body = { inquiryType: 'buy', fullName: 'Dana Example', phones: [randomPhone()], externalId: `ext-${randomUUID()}` };
    const first = await postIntake(h, w.token, body);
    expect(first.statusCode).toBe(201);
    const contactId = (JSON.parse(first.body) as { contactId: string }).contactId;
    expect((await contactState(h, contactId)).ownership_state).toBe('in_pond');
    expect((await ledger(h, contactId)).at(-1)).toMatchObject({ type: 'sent_to_pond', reason_code: 'NO_RULE_MATCH' });
    const seq = await seqOf(contactId);
    const notes = await pondNotes(w.tenantId, contactId);
    expect(notes).toEqual([{ user_id: w.teamLead!.userId, kind: 'pond_new', priority: 'high', title: 'New lead in the pond: no routing rule matched', body: null, subject_id: contactId, dedupe_key: `pond_new:${contactId}:${seq}` }]);
    // the system wrote it in the intake transaction: the deliveries are already there (in-app delivered, push pending); high priority sends no text
    expect(await deliveries(w.tenantId, contactId)).toEqual([{ channel: 'in_app', status: 'delivered' }, { channel: 'web_push', status: 'pending' }]);
    // the source posts the same inquiry again: nothing new
    const again = await postIntake(h, w.token, body);
    expect(again.statusCode).toBe(200);
    expect(await pondNotes(w.tenantId)).toHaveLength(1);
    // the title names nobody, and nothing was sent or queued for the client
    expect(notes[0]!.title).not.toMatch(/Dana|Example|\d{3}/);
    expect(await toClients(w.tenantId)).toEqual({ messages: 0, calls: 0, sends: 0 });
  });

  it('R-TEAMQ-12 E938: routed there by a rule: one alert, with that reason', async () => {
    const w = await leadsWorld(h, { agents: 1, teamLead: true, rule: false });
    await freshReauth(h, w.owner);
    const rule = await call(w.owner, 'POST', '/routing-rules', { name: 'Straight to the pond', strategy: 'pond', targetPondId: w.defaultPondId });
    expect(rule.status).toBe(201);
    const r = await intake(h, w);
    expect((await ledger(h, r.contactId)).at(-1)).toMatchObject({ type: 'sent_to_pond', reason_code: 'RULE_POND' });
    const notes = await pondNotes(w.tenantId, r.contactId);
    expect(notes.map((n) => [n.user_id, n.priority, n.title])).toEqual([[w.teamLead!.userId, 'high', 'New lead in the pond: a routing rule sends leads like this there']]);
  });

  it('R-TEAMQ-12 E938: every offer expired: no pond alert while it is on offer; the expiry that sends it to the pond alerts the Team Lead once, and a second delivery of that timer alerts nobody again', async () => {
    const w = await leadsWorld(h, { agents: 2, teamLead: true });
    await freshReauth(h, w.owner);
    const rules = await call<{ rules: { id: string; version: number }[] }>(w.owner, 'GET', '/routing-rules');
    const rule = rules.body.rules.find((x) => x.id === w.ruleId)!;
    expect((await call(w.owner, 'PATCH', `/routing-rules/${w.ruleId}`, { maxOffers: 1, version: rule.version })).status).toBe(200);
    const r = await intake(h, w);
    expect((await contactState(h, r.contactId)).ownership_state).toBe('offered');
    expect(await pondNotes(w.tenantId, r.contactId)).toEqual([]);
    await setOfferExpiry(h, r.contactId, -1000);
    await leadsWorker(h).drain();
    expect((await ledger(h, r.contactId)).at(-1)).toMatchObject({ type: 'sent_to_pond', reason_code: 'MAX_OFFERS_REACHED' });
    const seq = await seqOf(r.contactId);
    const notes = await pondNotes(w.tenantId, r.contactId);
    expect(notes.map((n) => [n.user_id, n.priority, n.title, n.dedupe_key])).toEqual([[w.teamLead!.userId, 'high', 'A lead went to the pond: nobody accepted the offer', `pond_new:${r.contactId}:${seq}`]]);
    // the timer job delivered a second time (the sweeper's re-issue): the stored outcome is replayed, nobody is alerted again
    await h.su.query(`UPDATE jobs SET status = 'pending', finished_at = NULL, run_at = now() WHERE tenant_id = $1 AND kind = 'ownership.offer_expiry' AND payload->>'contactId' = $2`, [w.tenantId, r.contactId]);
    await leadsWorker(h).drain();
    expect(await pondNotes(w.tenantId, r.contactId)).toHaveLength(1);
    expect(await seqOf(r.contactId)).toBe(seq);
  });

  it('R-TEAMQ-12 E938: released by its owner: the Team Lead is alerted in the release\'s own transaction (the push follows from the system), the releasing agent is not', async () => {
    const w = await leadsWorld(h, { agents: 1, teamLead: true });
    const agent = w.agents[0]!;
    const made = await call<{ contact: { id: string; ownership: { seq: number } } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Robin Example', phones: [randomPhone()] });
    expect(made.status).toBe(201);
    const id = made.body.contact.id;
    const rel = await command(agent, id, 'release', { reason: 'not_a_fit', expectedSeq: await seqOf(id) });
    expect(rel.status).toBe(200);
    expect((await contactState(h, id)).ownership_state).toBe('in_pond');
    const notes = await pondNotes(w.tenantId, id);
    expect(notes.map((n) => [n.user_id, n.priority, n.title])).toEqual([[w.teamLead!.userId, 'high', 'A lead was released to the pond']]);
    await leadsWorker(h).drain(); // the follow-up adds the Team Lead's push delivery as the system actor
    expect(await deliveries(w.tenantId, id)).toEqual([{ channel: 'in_app', status: 'delivered' }, { channel: 'web_push', status: 'pending' }]);
    expect(await pondNotes(w.tenantId, id)).toHaveLength(1);
  });

  it('R-TEAMQ-12 E940: a tenant with no Team Lead alerts its Owner and Admins', async () => {
    const w = await leadsWorld(h, { agents: 1, rule: false, others: ['admin'] });
    const r = await intake(h, w);
    const notes = await pondNotes(w.tenantId, r.contactId);
    expect(notes.map((n) => n.user_id).sort()).toEqual([w.owner.userId, (w.others[0] as TestClient).userId].sort());
    expect(new Set(notes.map((n) => n.priority))).toEqual(new Set(['high']));
  });

  it('R-TEAMQ-12 E942: an import never alerts: a person an import puts in a pond raises no notification at all', async () => {
    const w = await leadsWorld(h, { agents: 1, teamLead: true, rule: false });
    const actor = systemActor(w.tenantId, 'import');
    const contactId = h.app.platform.ids.next<'ContactId'>() as ContactId;
    await withTenantTx(
      actor,
      async (tx) => {
        const r = await applyOwnershipCommandInTx(tx, actor, contactId, { kind: 'import_assign', target: { pondId: w.defaultPondId as PondId } }, {
          commandId: derivedCommandId('test.import_contact', contactId),
          ids: h.app.platform.ids,
          newContact: { displayName: 'Imported Example', firstName: 'Imported', lastName: 'Example', originalSourceDetail: { import_system: 'csv' } },
        });
        if (!r.outcome.ok) throw new Error(`import_assign: ${r.outcome.code}`);
      },
      { db: h.database },
    );
    expect((await contactState(h, contactId)).ownership_state).toBe('in_pond');
    expect((await h.su.query('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(0);
  });

  it('R-TEAMQ-12 R-TEN-1: tenant isolation: one team\'s pond arrival writes nothing for another team', async () => {
    const a = await leadsWorld(h, { agents: 1, teamLead: true, rule: false });
    const b = await leadsWorld(h, { agents: 1, teamLead: true, rule: false });
    const r = await intake(h, a);
    expect(await pondNotes(a.tenantId, r.contactId)).toHaveLength(1);
    expect(await pondNotes(b.tenantId)).toEqual([]);
    // the other team's Team Lead cannot read it either
    const list = await call<{ notifications: { subjectId: string | null }[] }>(b.teamLead!, 'GET', '/notifications');
    expect(list.status).toBe(200);
    expect(list.body.notifications.filter((n) => n.subjectId === r.contactId)).toEqual([]);
    const mine = await call<{ notifications: { kind: string; subjectId: string | null; title: string }[] }>(a.teamLead!, 'GET', '/notifications');
    expect(mine.body.notifications.filter((n) => n.subjectId === r.contactId).map((n) => [n.kind, n.title])).toEqual([['pond_new', 'New lead in the pond: no routing rule matched']]);
  });
});

