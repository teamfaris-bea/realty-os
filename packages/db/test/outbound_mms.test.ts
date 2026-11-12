// Outbound photo and video texts (owner decision D5a; DATA_MODEL R-MMS-1..3, R-PAR-12, E291, E292, E299). Every write
// runs as app_user under RLS through withTenantTx; the superuser pool seeds the sending number, ages rows and reads back.
import { randomUUID } from 'node:crypto';
import type { Actor, Instant, SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { recordConsentEvent } from '../src/consent.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { type Harness, type Member, type World, PH, createHarness, createWorld, selfCreated, suFixture, suRows, uuid } from './world.js';

let h: Harness;
let w: World;
let w2: World;
let a: Member;
let b: Member;
let numberId: string;
let support: SupportActor;
let seq = 0;

const NUMBER = '+15555559200';
const nextPhone = () => `+1555013${String(1000 + ++seq).slice(-4)}`;
const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });

beforeAll(async () => {
  h = await createHarness(8);
  w = await createWorld(h.app, { agents: 2 });
  w2 = await createWorld(h.app, { agents: 1 });
  a = w.agents[0]!;
  b = w.agents[1]!;
  numberId = uuid();
  await suFixture(h.su, `INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
      VALUES ($1, $2, '${NUMBER}', 'fake', 'PN-mms', 'local', 'team_main', true, true, now())`, [w.tenantId, numberId]);
  const supportUserId = uuid() as UserId;
  await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`s-${uuid()}@platform.test`}, 'Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
  const grantId = uuid();
  await as(w.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
      VALUES (${w.tenantId}, ${grantId}, ${supportUserId}, ${w.owner.id}, 'ticket', now() + interval '1 hour')`.execute(tx));
  support = { kind: 'support', userId: supportUserId, tenantId: w.tenantId as TenantId, grantId };
});
afterAll(async () => {
  await h?.close();
});

/** A contact of `m` with one live phone, and its conversation. */
async function person(m: Member = a, world: World = w): Promise<{ contactId: string; conversationId: string; phone: string }> {
  const contactId = await selfCreated(h.app, world, m, `Photo ${++seq}`);
  const conversationId = uuid();
  const phone = nextPhone();
  await withTenantTx(m.actor, async (tx) => {
    await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
              VALUES (app.tenant_id(), ${uuid()}, ${contactId}, 'phone', ${phone}, decode(${Buffer.from(phone).toString('hex').padEnd(64, '0').slice(0, 64)}, 'hex'))`.execute(tx);
    await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${conversationId}, ${contactId})`.execute(tx);
  }, { db: h.app });
  return { contactId, conversationId, phone };
}
type Person = Awaited<ReturnType<typeof person>>;

/** A staged upload of `m` for the person: an encrypted-object row (the API's putObject is not needed here) + the upload. */
async function stage(m: Member, p: Person, o: { type?: string; size?: number; world?: World } = {}): Promise<{ uploadId: string; objectId: string }> {
  const objectId = uuid();
  const uploadId = uuid();
  const type = o.type ?? 'image/jpeg';
  const size = o.size ?? 1_000;
  const tenant = (o.world ?? w).tenantId;
  await withTenantTx(m.actor, async (tx) => {
    await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, created_by_user_id)
              VALUES (app.tenant_id(), ${objectId}, 'mms', ${`tenants/${tenant}/mms/${objectId}`}, ${type}, ${size}, ${Buffer.alloc(32)}, ${Buffer.from('dek')}, 1, app.user_id())`.execute(tx);
    await sql`INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, expires_at)
              VALUES (app.tenant_id(), ${uploadId}, ${p.contactId}, app.user_id(), ${objectId}, ${type}, ${size}, now())`.execute(tx);
  }, { db: h.app });
  return { uploadId, objectId };
}

interface MsgSpec {
  channel?: 'sms' | 'mms';
  status?: string;
  initiator?: 'human' | 'assistant' | 'system';
  sender?: Member | null;
  body?: string;
  extra?: Partial<Record<'bulk_action_id' | 'assistant_action_id' | 'playbook_step_run_id' | 'marketing_piece_id', string>>;
  direction?: 'outbound' | 'inbound';
  imported?: boolean;
}

function insertMsg(tx: Parameters<Parameters<typeof withTenantTx>[1]>[0], p: Person, s: MsgSpec): Promise<string> {
  const id = uuid();
  const initiator = s.initiator ?? 'human';
  const sender = s.sender === undefined ? a : s.sender;
  const dir = s.direction ?? 'outbound';
  const status = s.status ?? (dir === 'inbound' ? 'received' : 'queued');
  const x = s.extra ?? {};
  return sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
               initiator, initiated_by_user_id, purpose, action_category, bulk_action_id, assistant_action_id, playbook_step_run_id, marketing_piece_id,
               imported, dispatched_at, occurred_at)
             VALUES (app.tenant_id(), ${id}, ${p.conversationId}, ${p.contactId}, ${s.channel ?? 'mms'}, ${dir}, ${numberId},
               ${dir === 'inbound' ? p.phone : NUMBER}, ${dir === 'inbound' ? NUMBER : p.phone}, ${s.body ?? ''}, ${status},
               ${initiator}, ${initiator === 'human' && sender ? sender.id : null}, 'informational', 'none',
               ${x.bulk_action_id ?? null}, ${x.assistant_action_id ?? null}, ${x.playbook_step_run_id ?? null}, ${x.marketing_piece_id ?? null},
               ${s.imported ?? false}, ${status === 'queued' || status === 'scheduled' || dir === 'inbound' ? null : sql`now()`}, now())`.execute(tx).then(() => id);
}

const attach = (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0], messageId: string, objectId: string, position: number, ref: string | null = null) =>
  sql`INSERT INTO message_media (tenant_id, message_id, object_id, position, provider_media_ref) VALUES (app.tenant_id(), ${messageId}, ${objectId}, ${position}, ${ref})`.execute(tx);

/** The compose path in SQL: the message, the item, then the claim (DELETE … RETURNING); no row back ⇒ throw. */
async function photoText(m: Member, p: Person, uploads: { uploadId: string; objectId: string }[], s: MsgSpec = {}): Promise<string> {
  return withTenantTx(m.actor, async (tx) => {
    const id = await insertMsg(tx, p, { sender: m, ...s });
    for (const [i, u] of uploads.entries()) {
      await attach(tx, id, u.objectId, i);
      const r = await sql`DELETE FROM public.outbound_media_uploads WHERE tenant_id = app.tenant_id() AND id = ${u.uploadId} AND contact_id = ${p.contactId} AND expires_at > now() RETURNING object_id`.execute(tx);
      if (r.rows.length !== 1) throw new Error('MEDIA_UPLOAD_GONE');
    }
    return id;
  }, { db: h.app });
}

const objectRow = async (id: string) => (await suRows<{ deleted_at: Date | null; dek_wrapped: Buffer | null }>(h.su, 'SELECT deleted_at, dek_wrapped FROM stored_objects WHERE id = $1', [id]))[0]!;

describe('R-MMS-1 (E292): an outbound mms is only an agent\'s own one-to-one text', () => {
  it('R-MMS-1: the system and the assistant cannot create an outbound mms row', async () => {
    const p = await person();
    await expect(as(w.system(), (tx) => insertMsg(tx, p, { initiator: 'system', sender: null }))).rejects.toThrow(/messages_mms_one_to_one_human/);
    // an assistant row also needs its action (messages_check7); with one, the mms CHECK refuses it
    await expect(as(w.system('assistant'), (tx) => insertMsg(tx, p, { initiator: 'assistant', sender: null, extra: { assistant_action_id: uuid() } }))).rejects.toThrow(/messages_mms_one_to_one_human/);
  });

  it('R-MMS-1: a human mms row with any automation id (bulk, assistant action, playbook step run, marketing piece) is refused', async () => {
    const p = await person();
    for (const k of ['bulk_action_id', 'assistant_action_id', 'playbook_step_run_id', 'marketing_piece_id'] as const) {
      await expect(as(w.system(), (tx) => insertMsg(tx, p, { extra: { [k]: uuid() } })), k).rejects.toThrow();
    }
    // the CHECK itself, with the triggers (and foreign keys) out of the way: assistant action and playbook step run ids
    for (const col of ['assistant_action_id', 'playbook_step_run_id']) {
      const c = await h.su.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await expect(c.query(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, action_category, ${col}, occurred_at)
          VALUES ($1, $2, $3, $4, 'mms', 'outbound', $8, '${NUMBER}', $5, '', 'queued', 'human', $6, 'informational', 'none', $7, now())`, [w.tenantId, uuid(), p.conversationId, p.contactId, p.phone, a.id, uuid(), numberId]), col).rejects.toThrow(/messages_mms_one_to_one_human/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
  });

  it('R-MMS-1: a message never moves into or out of mms (either direction refused)', async () => {
    const p = await person();
    const sms = await as(a.actor, (tx) => insertMsg(tx, p, { channel: 'sms', body: 'hi' }));
    await expect(as(a.actor, (tx) => sql`UPDATE messages SET channel = 'mms' WHERE tenant_id = app.tenant_id() AND id = ${sms}`.execute(tx))).rejects.toThrow(/MMS_CHANNEL_FIXED/);
    const mms = await photoText(a, p, [await stage(a, p)]);
    await expect(as(a.actor, (tx) => sql`UPDATE messages SET channel = 'sms' WHERE tenant_id = app.tenant_id() AND id = ${mms}`.execute(tx))).rejects.toThrow(/MMS_CHANNEL_FIXED/);
    await expect(as(w.system(), (tx) => sql`UPDATE messages SET channel = 'sms' WHERE tenant_id = app.tenant_id() AND id = ${mms}`.execute(tx))).rejects.toThrow(/MMS_CHANNEL_FIXED/);
  });

  it('R-MMS-1: inbound and imported mms rows still work (as the system)', async () => {
    const p = await person();
    await expect(as(w.system('provider'), (tx) => insertMsg(tx, p, { direction: 'inbound', initiator: 'client' as never, sender: null }))).resolves.toBeTruthy();
    // an imported outbound mms (history from the old CRM): the CHECKs allow it (foreign keys off: no import record here)
    const c = await h.su.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await expect(c.query(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, purpose, action_category, imported, import_record_id, dispatched_at, occurred_at)
        VALUES ($1, $2, $3, $4, 'mms', 'outbound', '${NUMBER}', $5, '', 'sent', 'import', 'informational', 'none', true, $6, now(), now())`, [w.tenantId, uuid(), p.conversationId, p.contactId, p.phone, uuid()])).resolves.toBeTruthy();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('R-MMS-2 (E291): only the sender attaches, to their own queued or scheduled photo text', () => {
  it('R-MMS-2: the sender\'s own attach succeeds and the claim deletes the upload in the same transaction', async () => {
    const p = await person();
    const u = await stage(a, p);
    const id = await photoText(a, p, [u], { body: 'Here it is' });
    expect(await suRows(h.su, 'SELECT position FROM message_media WHERE message_id = $1', [id])).toEqual([{ position: 0 }]);
    expect(await suRows(h.su, 'SELECT 1 FROM outbound_media_uploads WHERE id = $1', [u.uploadId])).toEqual([]);
    expect((await objectRow(u.objectId)).deleted_at).toBeNull(); // attached: kept with the message (R-MMS-7)
  });

  it('R-MMS-2: an outbound mms with no media fails at commit', async () => {
    const p = await person();
    await expect(as(a.actor, (tx) => insertMsg(tx, p, {}))).rejects.toThrow(/MMS_NO_MEDIA/);
  });

  it('R-MMS-2: an attach is refused for another user, an Owner on someone else\'s message, and the system', async () => {
    const p = await person();
    const u = await stage(a, p);
    const id = await as(a.actor, async (tx) => {
      const m = await insertMsg(tx, p, {});
      await attach(tx, m, (await stage(a, p)).objectId, 0);
      return m;
    });
    void id;
    // a fresh queued message of A, then each other actor tries to attach A's upload to it
    const open = async () => {
      const first = await stage(a, p);
      return photoText(a, p, [first]);
    };
    const m1 = await open();
    await expect(as(b.actor, (tx) => attach(tx, m1, u.objectId, 1))).rejects.toThrow();
    await expect(as(w.owner.actor, (tx) => attach(tx, m1, u.objectId, 1))).rejects.toThrow(/MMS_NOT_SENDER/);
    await expect(as(w.system(), (tx) => attach(tx, m1, u.objectId, 1))).rejects.toThrow(/MMS_NOT_SENDER/);
    await expect(as(a.actor, (tx) => attach(tx, m1, u.objectId, 1))).resolves.toBeTruthy();
  });

  it('R-MMS-2: an attach to an sms parent or a dispatching parent is refused', async () => {
    const p = await person();
    const u = await stage(a, p);
    const sms = await as(a.actor, (tx) => insertMsg(tx, p, { channel: 'sms', body: 'hi' }));
    await expect(as(w.owner.actor, (tx) => attach(tx, sms, u.objectId, 0))).rejects.toThrow(/MMS_NOT_ONE_TO_ONE/);
    const m = await photoText(a, p, [await stage(a, p)]);
    await as(a.actor, (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${m}`.execute(tx));
    await expect(as(a.actor, (tx) => attach(tx, m, u.objectId, 1))).rejects.toThrow(/MMS_NOT_ATTACHABLE/);
  });

  it('R-MMS-2: an 11th item, media plus text over 5,000,000 bytes, and a provider_media_ref are refused', async () => {
    const p = await person();
    const ten = [];
    for (let i = 0; i < 10; i++) ten.push(await stage(a, p, { size: 100 }));
    const m = await photoText(a, p, ten);
    const extra = await stage(a, p, { size: 100 });
    await expect(as(a.actor, (tx) => attach(tx, m, extra.objectId, 9))).rejects.toThrow(/MMS_TOO_MANY/);
    const big = await stage(a, p, { size: 5_000_000 });
    await expect(photoText(a, p, [big], { body: 'x' })).rejects.toThrow(/MMS_TOO_LARGE/);
    await expect(photoText(a, p, [big], { body: '' })).resolves.toBeTruthy(); // exactly 5,000,000 with no words
    const p2 = await person();
    const one = await stage(a, p2);
    const m2 = await photoText(a, p2, [await stage(a, p2)]);
    await expect(as(a.actor, (tx) => attach(tx, m2, one.objectId, 1, `ME${'0'.repeat(32)}`))).rejects.toThrow(/MMS_POSITION/);
  });

  it('R-MMS-2: another person\'s upload and an expired upload are refused (MMS_UPLOAD_GONE)', async () => {
    const p = await person();
    const other = await person();
    const theirs = await stage(a, other);
    const m = await photoText(a, p, [await stage(a, p)]);
    await expect(as(a.actor, (tx) => attach(tx, m, theirs.objectId, 1))).rejects.toThrow(/MMS_UPLOAD_GONE/);
    const old = await stage(a, p);
    await h.su.query("UPDATE outbound_media_uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [old.uploadId]);
    await expect(as(a.actor, (tx) => attach(tx, m, old.objectId, 1))).rejects.toThrow(/MMS_UPLOAD_GONE/);
  });

  it('R-MMS-2: attached outbound media never change: UPDATE and DELETE by the sender, an Owner or the system touch nothing', async () => {
    const p = await person();
    const u = await stage(a, p);
    const m = await photoText(a, p, [u]);
    for (const actor of [a.actor, w.owner.actor, w.system()] as Actor[]) {
      const upd = await as(actor, async (tx) => Number((await sql`UPDATE message_media SET position = 5 WHERE tenant_id = app.tenant_id() AND message_id = ${m}`.execute(tx)).numAffectedRows ?? 0n)).catch(() => 0);
      expect(upd).toBe(0);
      await expect(as(actor, (tx) => sql`DELETE FROM message_media WHERE tenant_id = app.tenant_id() AND message_id = ${m}`.execute(tx))).rejects.toThrow(/permission denied/);
    }
    expect(await suRows(h.su, 'SELECT position, object_id FROM message_media WHERE message_id = $1', [m])).toEqual([{ position: 0, object_id: u.objectId }]);
  });

  it('R-MMS-2: two concurrent transactions attaching one upload: exactly one commits', async () => {
    const p = await person();
    const u = await stage(a, p);
    const results = await Promise.allSettled([photoText(a, p, [u]), photoText(a, p, [u])]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await suRows(h.su, 'SELECT count(*)::int AS n FROM message_media WHERE object_id = $1', [u.objectId])).toEqual([{ n: 1 }]);
  });
});

describe('R-MMS-3 (E299): staged uploads', () => {
  it('R-MMS-3: RLS isolates uploads across users and tenants; support cannot write; an app_user UPDATE is refused', async () => {
    const p = await person();
    const u = await stage(a, p);
    const seen = (actor: Actor) => as(actor, async (tx) => (await sql<{ id: string }>`SELECT id FROM outbound_media_uploads WHERE id = ${u.uploadId}`.execute(tx)).rows.length);
    expect(await seen(a.actor)).toBe(1);
    expect(await seen(w.system())).toBe(1);
    expect(await seen(b.actor)).toBe(0);
    expect(await seen(w.owner.actor)).toBe(0);
    expect(await seen(w2.owner.actor)).toBe(0);
    expect(await seen(w2.system())).toBe(0);
    expect(await seen(support)).toBe(0);
    await expect(as(support, (tx) => sql`DELETE FROM outbound_media_uploads`.execute(tx))).rejects.toThrow();
    await expect(as(a.actor, (tx) => sql`UPDATE outbound_media_uploads SET expires_at = now() + interval '9 days' WHERE id = ${u.uploadId}`.execute(tx))).rejects.toThrow(/permission denied/);
    await expect(as(a.actor, (tx) => sql`SELECT 1 FROM outbound_media_uploads WHERE id = ${u.uploadId} FOR UPDATE`.execute(tx))).rejects.toThrow(/permission denied/);
    // B cannot stage for A, and nobody stages a row in another tenant (RLS, not an MMS_ error)
    await expect(as(b.actor, (tx) => sql`INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, expires_at)
        VALUES (app.tenant_id(), ${uuid()}, ${p.contactId}, ${a.id}, ${uuid()}, 'image/jpeg', 10, now())`.execute(tx))).rejects.toThrow(/row-level security|MMS_UPLOAD_OBJECT/);
    await expect(as(w2.owner.actor, (tx) => sql`INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, expires_at)
        VALUES (${w.tenantId}, ${uuid()}, ${p.contactId}, ${w2.owner.id}, ${uuid()}, 'image/jpeg', 10, now())`.execute(tx))).rejects.toThrow(/row-level security/);
  });

  it('R-MMS-3: the stamp trigger overrides a client-chosen created_at or expires_at, and binds the row to the uploader\'s object', async () => {
    const p = await person();
    const objectId = uuid();
    const id = uuid();
    await as(a.actor, async (tx) => {
      await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, created_by_user_id)
                VALUES (app.tenant_id(), ${objectId}, 'mms', ${`tenants/${w.tenantId}/mms/${objectId}`}, 'image/png', 50, ${Buffer.alloc(32)}, ${Buffer.from('dek')}, 1, app.user_id())`.execute(tx);
      await sql`INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, created_at, expires_at)
                VALUES (app.tenant_id(), ${id}, ${p.contactId}, app.user_id(), ${objectId}, 'image/png', 50, now() - interval '9 days', now() + interval '9 days')`.execute(tx);
    });
    const [r] = await suRows<{ ok: boolean }>(h.su, "SELECT created_at > now() - interval '1 minute' AND expires_at = created_at + interval '24 hours' AS ok FROM outbound_media_uploads WHERE id = $1", [id]);
    expect(r!.ok).toBe(true);
    // a size or type that is not the object's, or someone else's object, is refused
    await expect(as(a.actor, (tx) => sql`INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, expires_at)
        VALUES (app.tenant_id(), ${uuid()}, ${p.contactId}, app.user_id(), ${uuid()}, 'image/png', 50, now())`.execute(tx))).rejects.toThrow(/MMS_UPLOAD_OBJECT/);
  });

  it('R-MMS-3: the table CHECK refuses a video over 500,000 bytes and a type outside the five', async () => {
    const p = await person();
    await expect(stage(a, p, { type: 'video/mp4', size: 500_001 })).rejects.toThrow(/byte_size|check/);
    await expect(stage(a, p, { type: 'image/svg+xml', size: 10 })).rejects.toThrow(/content_type|check/);
    await expect(stage(a, p, { type: 'video/quicktime', size: 500_000 })).resolves.toBeTruthy();
  });

  it('R-MMS-3: deleting an unattached upload shreds its object; deleting one whose object is attached does not', async () => {
    const p = await person();
    const u = await stage(a, p);
    await as(a.actor, (tx) => sql`DELETE FROM outbound_media_uploads WHERE id = ${u.uploadId}`.execute(tx));
    const o = await objectRow(u.objectId);
    expect(o.deleted_at).not.toBeNull();
    expect(o.dek_wrapped).toBeNull();
    // an upload whose object is attached (a row a superuser left behind) is removed without shredding the message's media
    const v = await stage(a, p);
    const m = await as(a.actor, async (tx) => {
      const id = await insertMsg(tx, p, {});
      await attach(tx, id, v.objectId, 0);
      return id;
    });
    void m;
    await as(a.actor, (tx) => sql`DELETE FROM outbound_media_uploads WHERE id = ${v.uploadId}`.execute(tx));
    expect((await objectRow(v.objectId)).deleted_at).toBeNull();
  });

  it('R-MMS-3: a row a superuser points at a recording\'s object or at another user\'s object shreds nothing when deleted', async () => {
    const p = await person();
    // B's own object (no upload row of its own)
    const mine = { objectId: uuid() };
    await as(b.actor, (tx) => sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, created_by_user_id)
        VALUES (app.tenant_id(), ${mine.objectId}, 'mms', ${`tenants/${w.tenantId}/mms/${mine.objectId}`}, 'image/jpeg', 1000, ${Buffer.alloc(32)}, ${Buffer.from('dek')}, 1, app.user_id())`.execute(tx));
    // another user's object: B's object under an upload row claiming A uploaded it
    const forged = uuid();
    const c = await h.su.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query("INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,'image/jpeg',1000,now(),now() + interval '1 day')", [w.tenantId, forged, p.contactId, a.id, mine.objectId]);
      // a recording's object (purpose 'recording')
      const rec = uuid();
      await c.query("INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, created_by_user_id) VALUES ($1,$2,'recording',$3,'audio/wav',10,$4,'\\x01',1,$5)", [w.tenantId, rec, `tenants/${w.tenantId}/rec/${rec}`, Buffer.alloc(32), a.id]);
      const forged2 = uuid();
      await c.query("INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,'image/jpeg',10,now(),now() + interval '1 day')", [w.tenantId, forged2, p.contactId, a.id, rec]);
      await c.query('RESET session_replication_role');
      await as(a.actor, (tx) => sql`DELETE FROM outbound_media_uploads WHERE id IN (${forged}, ${forged2})`.execute(tx));
      expect((await objectRow(mine.objectId)).deleted_at).toBeNull();
      expect((await objectRow(rec)).deleted_at).toBeNull();
    } finally {
      c.release();
    }
  });

  it('R-MMS-3 (E299): app.erase_contact shreds both staged and attached media', async () => {
    const p = await person();
    const staged = await stage(a, p);
    const sent = await stage(a, p);
    await photoText(a, p, [sent]);
    await as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${p.contactId}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx));
    for (const id of [staged.objectId, sent.objectId]) {
      const o = await objectRow(id);
      expect(o.deleted_at, id).not.toBeNull();
      expect(o.dek_wrapped).toBeNull();
    }
    expect(await suRows(h.su, 'SELECT 1 FROM outbound_media_uploads WHERE id = $1', [staged.uploadId])).toEqual([]);
  });
});

describe('R-PAR-12: removed phones in app.messages_dispatch_guard for a photo text', () => {
  const removedStopCase = async (reason: 'wrong_number' | 'old') => {
    const p = await person();
    const old = nextPhone();
    await as(a.actor, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, status, removed_at, removed_reason)
        VALUES (app.tenant_id(), ${uuid()}, ${p.contactId}, 'phone', ${old}, decode(${Buffer.from(old).toString('hex').padEnd(64, '0').slice(0, 64)}, 'hex'), 'removed', now(), ${reason})`.execute(tx));
    await as(w.system('provider'), (tx) => recordConsentEvent(tx, {
      id: uuid(), addressKind: 'phone', addressHmac: Buffer.from(old).toString('hex').padEnd(64, '0').slice(0, 64), addressHint: '•••', channel: 'sms', purpose: 'all',
      eventType: 'revoke', level: 'none', source: 'inbound_keyword', occurredAt: Date.now() as Instant, contactId: p.contactId, actor: { kind: 'system' },
      disclosureId: null, evidenceObjectId: null, evidenceMessageId: uuid(), evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {},
      imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
    }));
    const m = await photoText(a, p, [await stage(a, p)]);
    return as(a.actor, (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${m}`.execute(tx));
  };
  it('R-PAR-12: an SMS STOP on a phone removed for any reason but wrong_number blocks an mms to the person\'s live phone', async () => {
    await expect(removedStopCase('old')).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });
  it('R-PAR-12: a STOP on a phone removed as a confirmed wrong number does not block it', async () => {
    await expect(removedStopCase('wrong_number')).resolves.toBeTruthy();
  });
});
