// D5b texting reactions (migration *_sms_reactions.sql; R-REACT-2, R-REACT-5, R-DATA-7). Synthetic fixtures only.
// Message rows are fixtures (suFixture: guards and FKs skipped); every message_reactions write goes through app_user
// under RLS, so the guard, the policies and the grants are what is tested.
import type { Actor, SystemActor, TenantId, UserActor } from '@realty/core/foundation';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, PH, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let w2: World;
let numberId: string;
let otherNumberId: string;
let contactId: string;
let otherContactId: string;
let conv: string;
let otherConv: string;
const TEAM = '+15555559300';
const PHONE = '+15555550101';

const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app, retries: 0 });
const sys = (): SystemActor => w.system('webhook');

interface Msg {
  contact?: string;
  direction?: 'inbound' | 'outbound';
  channel?: 'sms' | 'mms' | 'email';
  phoneNumberId?: string | null;
  from?: string;
  to?: string;
  status?: string;
  imported?: boolean;
  dispatchedAgo?: string | null; // interval before now
  occurredAgo?: string; // interval before now
  body?: string;
}

async function msg(o: Msg = {}): Promise<string> {
  const id = uuid();
  const direction = o.direction ?? 'outbound';
  const contact = o.contact ?? contactId;
  const imported = o.imported ?? false;
  const status = o.status ?? (direction === 'inbound' ? 'received' : 'sent');
  const initiator = imported ? 'import' : direction === 'inbound' ? 'client' : 'system';
  const dispatched = direction === 'outbound' && o.dispatchedAgo !== null ? `now() - interval '${o.dispatchedAgo ?? '1 hour'}'` : 'NULL';
  await suFixture(
    h.su,
    `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body,
       status, initiator, purpose, gate_decision_id, imported, import_record_id, dispatched_at, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, ${dispatched}, now() - interval '${o.occurredAgo ?? (direction === 'inbound' ? '0 seconds' : '1 hour')}')`,
    [
      w.tenantId, id, contact === contactId ? conv : otherConv, contact, o.channel ?? 'sms', direction,
      o.phoneNumberId === undefined ? numberId : o.phoneNumberId,
      o.from ?? (direction === 'inbound' ? PHONE : TEAM), o.to ?? (direction === 'inbound' ? TEAM : PHONE), o.body ?? 'See you at 3',
      status, initiator, direction === 'outbound' ? 'informational' : null, direction === 'outbound' && !imported ? uuid() : null,
      imported, imported ? uuid() : null,
    ],
  );
  return id;
}

async function link(actor: Actor, reactionId: string, targetId: string, extra: { reaction?: string; emoji?: string | null; action?: string } = {}): Promise<void> {
  await as(actor, (tx) => sql`INSERT INTO message_reactions (tenant_id, id, message_id, target_message_id, action, reaction, emoji, whole_text_reading)
    VALUES (app.tenant_id(), ${uuid()}, ${reactionId}, ${targetId}, ${extra.action ?? 'add'}, ${extra.reaction ?? 'love'}, ${extra.emoji ?? null}, 'none')`.execute(tx));
}

const errOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);
const code = (m: string) => /^([A-Z_]+):/.exec(m)?.[1] ?? m;

/** The API's candidate query (apps/api/src/comms/reactions.ts), restated: the guard must admit exactly these. */
async function candidates(reactionId: string): Promise<string[]> {
  return as(sys(), async (tx) => {
    const r = (await sql<{ contact_id: string; from_address: string; phone_number_id: string; occurred_at: Date }>`
      SELECT contact_id, from_address, phone_number_id, occurred_at FROM messages WHERE tenant_id = app.tenant_id() AND id = ${reactionId}`.execute(tx)).rows[0]!;
    const rows = await sql<{ id: string }>`
      SELECT id, body FROM messages
       WHERE tenant_id = app.tenant_id() AND contact_id = ${r.contact_id} AND direction = 'outbound' AND NOT imported
         AND channel IN ('sms','mms') AND to_address = ${r.from_address} AND phone_number_id = ${r.phone_number_id}
         AND status IN ('dispatching','sent','delivered','dispatch_unknown')
         AND occurred_at >= ${r.occurred_at}::timestamptz - interval '30 days' AND dispatched_at <= ${r.occurred_at}::timestamptz
       ORDER BY occurred_at DESC, id DESC LIMIT 100`.execute(tx);
    return rows.rows.map((x) => x.id);
  });
}

beforeAll(async () => {
  h = await createHarness(6);
  w = await createWorld(h.app, { agents: 2, teamLead: true });
  w2 = await createWorld(h.app, { agents: 1 });
  numberId = uuid();
  otherNumberId = uuid();
  await suFixture(h.su, `
    INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
      VALUES ($1, $2, '${TEAM}', 'fake', 'PN-react-1', 'local', 'team_main', true, true, now());
    INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
      VALUES ($1, $3, '+15555559301', 'fake', 'PN-react-2', 'local', 'team_main', true, true, now());`, [w.tenantId, numberId, otherNumberId]);
  contactId = await selfCreated(h.app, w, w.agents[0]!, 'Sam Reactor');
  otherContactId = await selfCreated(h.app, w, w.agents[1]!, 'Pat Other');
  conv = uuid();
  otherConv = uuid();
  await suFixture(h.su, `INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1, $2, $3); INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1, $4, $5);`, [w.tenantId, conv, contactId, otherConv, otherContactId]);
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('message_reactions (D5b)', () => {
  it('R-REACT-5 only the system inserts; no role updates or deletes; support refused', async () => {
    const target = await msg();
    const r1 = await msg({ direction: 'inbound' });
    // every person is refused, whatever the role (the guard; the INSERT policy too)
    for (const m of [w.owner, w.tl!, w.agents[0]!]) expect(code(await errOf(link(m.actor, r1, target)))).toMatch(/REACTION_SYSTEM_ONLY|row-level security/);
    // support: the statement trigger refuses first
    const supportUserId = uuid();
    await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`s-${uuid()}@platform.test`}, 'Support', ${PH})`.execute(tx), { userId: supportUserId as never, db: h.app });
    const grantId = uuid();
    await as(w.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
      VALUES (${w.tenantId}, ${grantId}, ${supportUserId}, ${w.owner.id}, 'ticket', now() + interval '1 hour')`.execute(tx));
    const support: Actor = { kind: 'support', userId: supportUserId as never, tenantId: w.tenantId as TenantId, grantId };
    expect(await errOf(link(support, r1, target))).not.toBe('ok');
    // the system links
    await link(sys(), r1, target);
    expect(await suRows(h.su, 'SELECT action, reaction FROM message_reactions WHERE message_id = $1', [r1])).toEqual([{ action: 'add', reaction: 'love' }]);
    // one row per reaction text
    expect(await errOf(link(sys(), r1, target))).toMatch(/duplicate key|unique/);
    // nobody updates or deletes (no grant), the system included
    for (const a of [sys(), w.owner.actor as Actor]) {
      expect(await errOf(as(a, (tx) => sql`UPDATE message_reactions SET reaction = 'like' WHERE message_id = ${r1}`.execute(tx)))).toMatch(/permission denied/);
      expect(await errOf(as(a, (tx) => sql`DELETE FROM message_reactions WHERE message_id = ${r1}`.execute(tx)))).toMatch(/permission denied/);
    }
    // emoji CHECKs
    const r2 = await msg({ direction: 'inbound' });
    expect(await errOf(link(sys(), r2, target, { reaction: 'emoji', emoji: null }))).toMatch(/check constraint/);
    expect(await errOf(link(sys(), r2, target, { reaction: 'love', emoji: '👍' }))).toMatch(/check constraint/);
    expect(await errOf(link(sys(), r2, target, { reaction: 'emoji', emoji: '👍'.repeat(17) }))).toMatch(/check constraint/);
    await link(sys(), r2, target, { reaction: 'emoji', emoji: '👍🏽' });
  });

  it('R-REACT-5 the guard refuses', async () => {
    const target = await msg();
    const cases: [string, () => Promise<[string, string]>][] = [
      ['reaction is outbound', async () => [await msg(), target]],
      ['reaction is MMS', async () => [await msg({ direction: 'inbound', channel: 'mms' }), target]],
      ['reaction is email', async () => [await msg({ direction: 'inbound', channel: 'email', phoneNumberId: null }), target]],
      ['reaction is imported', async () => [await msg({ direction: 'inbound', imported: true }), target]],
      ['target is inbound', async () => [await msg({ direction: 'inbound' }), await msg({ direction: 'inbound' })]],
      ['target is email', async () => [await msg({ direction: 'inbound' }), await msg({ channel: 'email', imported: true })]],
      ['target is imported', async () => [await msg({ direction: 'inbound' }), await msg({ imported: true })]],
      ['another contact', async () => [await msg({ direction: 'inbound' }), await msg({ contact: otherContactId })]],
      ['another phone', async () => [await msg({ direction: 'inbound' }), await msg({ to: '+15555550199' })]],
      ['another team number', async () => [await msg({ direction: 'inbound' }), await msg({ phoneNumberId: otherNumberId })]],
      ['target failed', async () => [await msg({ direction: 'inbound' }), await msg({ status: 'failed' })]],
      ['target blocked', async () => [await msg({ direction: 'inbound' }), await msg({ status: 'blocked', dispatchedAgo: null })]],
      ['target queued', async () => [await msg({ direction: 'inbound' }), await msg({ status: 'queued', dispatchedAgo: null })]],
      ['dispatched after', async () => [await msg({ direction: 'inbound', occurredAgo: '2 hours' }), await msg({ dispatchedAgo: '1 hour', occurredAgo: '3 hours' })]],
      ['31 days before', async () => [await msg({ direction: 'inbound' }), await msg({ occurredAgo: '31 days', dispatchedAgo: '31 days' })]],
      ['missing target', async () => [await msg({ direction: 'inbound' }), randomUUID()]],
    ];
    for (const [name, make] of cases) {
      const [r, t] = await make();
      const m = await errOf(link(sys(), r, t));
      expect(code(m), name).toMatch(name === 'missing target' ? /REACTION_TARGET_INVALID|foreign key/ : /REACTION_TARGET_INVALID/);
    }
    // a NULL actor kind is refused (raw app_user transaction with only the tenant set)
    const r = await msg({ direction: 'inbound' });
    const c = await errOf(
      h.app.kysely.transaction().execute(async (tx) => {
        await sql`SELECT set_config('app.tenant_id', ${w.tenantId}, true), set_config('app.principal_type', 'staff', true)`.execute(tx);
        await sql`INSERT INTO message_reactions (tenant_id, id, message_id, target_message_id, action, reaction, whole_text_reading)
          VALUES (${w.tenantId}, ${uuid()}, ${r}, ${target}, 'add', 'love', 'none')`.execute(tx);
      }),
    );
    expect(c).toMatch(/REACTION_SYSTEM_ONLY|row-level security/);
    // and inside the bounds it is admitted
    await link(sys(), r, target);
  });

  it('R-REACT-2 the guard and the candidates query admit exactly the same targets', async () => {
    const bounds: [string, Msg][] = [
      ['in bounds', {}],
      ['dispatching', { status: 'dispatching' }],
      ['delivered', { status: 'delivered' }],
      ['dispatch_unknown', { status: 'dispatch_unknown' }],
      ['mms target', { channel: 'mms' }],
      ['29 days', { occurredAgo: '29 days', dispatchedAgo: '29 days' }],
      ['31 days', { occurredAgo: '31 days', dispatchedAgo: '31 days' }],
      ['dispatched after the reaction', { dispatchedAgo: '-1 minute', occurredAgo: '1 hour' }],
      ['never dispatched', { status: 'queued', dispatchedAgo: null }],
      ['another phone number', { phoneNumberId: otherNumberId }],
      ['another sender', { to: '+15555550188' }],
      ['failed', { status: 'failed' }],
      ['undelivered', { status: 'undelivered' }],
      ['canceled', { status: 'canceled', dispatchedAgo: null }],
      ['imported', { imported: true }],
      ['another contact', { contact: otherContactId }],
    ];
    for (const [name, o] of bounds) {
      const t = await msg(o);
      const r = await msg({ direction: 'inbound' });
      const inQuery = (await candidates(r)).includes(t);
      const admitted = (await errOf(link(sys(), r, t))) === 'ok';
      expect(admitted, name).toBe(inQuery);
    }
  });

  it('R-REACT-5 RLS through the message, cross-tenant invisible, cascade with either message, erasure leaves none (R-DATA-7)', async () => {
    const target = await msg();
    const r = await msg({ direction: 'inbound' });
    await link(sys(), r, target);
    const visible = (a: Actor) => as(a, async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM message_reactions WHERE message_id = ${r}`.execute(tx)).rows[0]!.n);
    const seesMessage = (a: Actor) => as(a, async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM messages WHERE id = ${r}`.execute(tx)).rows[0]!.n);
    for (const m of [w.owner, w.tl!, w.agents[0]!, w.agents[1]!]) expect(await visible(m.actor), m.role).toBe(await seesMessage(m.actor));
    expect(await visible(w.agents[0]!.actor)).toBe(1);
    // another tenant sees nothing, even naming the row
    expect(await visible(w2.owner.actor as UserActor)).toBe(0);
    expect(await as(w2.system('webhook'), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM message_reactions`.execute(tx)).rows[0]!.n)).toBe(0);
    // cascade with the reaction message, then with the target
    await h.su.query('DELETE FROM messages WHERE id = $1', [r]);
    expect(await suRows(h.su, 'SELECT 1 FROM message_reactions WHERE message_id = $1', [r])).toHaveLength(0);
    const r2 = await msg({ direction: 'inbound' });
    await link(sys(), r2, target);
    await h.su.query('DELETE FROM messages WHERE id = $1', [target]);
    expect(await suRows(h.su, 'SELECT 1 FROM message_reactions WHERE message_id = $1', [r2])).toHaveLength(0);
    // erasure of the person (app.erase_contact) leaves no reaction row
    const t3 = await msg();
    const r3 = await msg({ direction: 'inbound' });
    await link(sys(), r3, t3);
    await as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${contactId}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx));
    expect(await suRows(h.su, 'SELECT 1 FROM message_reactions WHERE tenant_id = $1 AND (message_id = $2 OR target_message_id = $3)', [w.tenantId, r3, t3])).toHaveLength(0);
  });
});
