// api/duplicates (PARITY_PLAN module 66), the flagged merge edit: a merge moves the loser's tags, custom
// values, relationships, notes and stage history to the survivor inside the engine's merge transaction
// (R-PAR-45), and never loses an opt-out: a STOP on either person blocks the merged person (D1, R-PAR-12,
// R-CHAN-2 / E140). Every write in these tests goes through app_user (RLS) and the ownership engine; the
// superuser pool only reads.
import { createHash } from 'node:crypto';
import type { ConsentEventSpec } from '@realty/core/compliance';
import type { Actor, ContactId, Instant } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordConsentEvent } from '../src/consent.js';
import { withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, drainFollowups, type Harness, type Member, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let agent: Member;
let numberId: string;
let seq = 0;

const hmacHex = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');
const nextPhone = () => `+1555013${String(1000 + ++seq).slice(-4)}`;

beforeAll(async () => {
  h = await createHarness(6);
  w = await createWorld(h.app, { agents: 1, teamLead: true });
  agent = w.agents[0]!;
  numberId = uuid();
  await suFixture(h.su, `
    INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
      VALUES ($1, $2, '+15555559200', 'fake', 'PN-merge', 'local', 'team_main', true, true, now());`, [w.tenantId, numberId]);
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });

async function addPhone(contactId: string, phone: string): Promise<string> {
  const id = uuid();
  await as(agent.actor, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
    VALUES (app.tenant_id(), ${id}, ${contactId}, 'phone', ${phone}, decode(${hmacHex(phone)}, 'hex'))`.execute(tx));
  return id;
}

async function conversation(contactId: string): Promise<string> {
  const rows = await suRows<{ id: string }>(h.su, 'SELECT id FROM conversations WHERE contact_id = $1', [contactId]);
  if (rows[0]) return rows[0].id;
  const id = uuid();
  await as(agent.actor, (tx) => sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${id}, ${contactId})`.execute(tx));
  return id;
}

function stop(addr: string): Promise<unknown> {
  const spec: ConsentEventSpec = {
    id: uuid(), addressKind: 'phone', addressHmac: hmacHex(addr), addressHint: '•••', channel: 'sms', purpose: 'all',
    eventType: 'revoke', level: 'none', source: 'inbound_keyword', occurredAt: Date.now() as Instant, contactId: null, actor: { kind: 'system' },
    disclosureId: null, evidenceObjectId: null, evidenceMessageId: uuid(), evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {},
    imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
  };
  return withTenantTx(w.system('provider'), (tx) => recordConsentEvent(tx, spec), { db: h.app });
}

async function textTo(contactId: string, to: string): Promise<void> {
  const conv = await conversation(contactId);
  await as(agent.actor, (tx) => sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id,
      from_address, to_address, body, status, initiator, initiated_by_user_id, purpose, action_category, dispatched_at, occurred_at)
    VALUES (app.tenant_id(), ${uuid()}, ${conv}, ${contactId}, 'sms', 'outbound', ${numberId}, '+15555559200', ${to}, 'Hi', 'dispatching',
      'human', ${agent.id}, 'informational', 'none', now(), now())`.execute(tx));
}

async function tag(contactId: string, name: string): Promise<string> {
  return as(agent.actor, async (tx) => {
    const found = await sql<{ id: string }>`SELECT id FROM tags WHERE tenant_id = app.tenant_id() AND name_key = lower(normalize(${name}, NFKC))`.execute(tx);
    const id = found.rows[0]?.id ?? uuid();
    if (!found.rows[0]) {
      await sql`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES (app.tenant_id(), ${id}, ${name}, 'user', ${agent.id})`.execute(tx);
    }
    await sql`INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, added_by_user_id) VALUES (app.tenant_id(), ${contactId}, ${id}, 'user', ${agent.id})`.execute(tx);
    return id;
  });
}

async function field(key: string): Promise<string> {
  const id = uuid();
  await as(w.owner.actor, (tx) => sql`INSERT INTO custom_field_defs (tenant_id, id, key, label, field_type, created_by_user_id)
    VALUES (app.tenant_id(), ${id}, ${key}, ${key}, 'text', ${w.owner.id})`.execute(tx));
  return id;
}

const setValue = (contactId: string, fieldId: string, v: string) =>
  as(agent.actor, (tx) => sql`INSERT INTO contact_field_values (tenant_id, contact_id, field_id, value_text, updated_by_kind, updated_by_user_id)
    VALUES (app.tenant_id(), ${contactId}, ${fieldId}, ${v}, 'user', ${agent.id})`.execute(tx));

const relate = (a: string, b: string, kind: string) =>
  as(agent.actor, (tx) => sql`INSERT INTO contact_relationships (tenant_id, id, contact_id, related_contact_id, kind, created_by_user_id)
    VALUES (app.tenant_id(), ${uuid()}, ${a}, ${b}, ${kind}, ${agent.id})`.execute(tx));

const note = (contactId: string, body: string) =>
  as(agent.actor, (tx) => sql`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES (app.tenant_id(), ${uuid()}, ${contactId}, ${agent.id}, ${body})`.execute(tx));

const setStage = (contactId: string, stage: string) =>
  as(agent.actor, (tx) => sql`UPDATE contacts SET stage = ${stage} WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx));

const candidate = async (a: string, b: string) => {
  const [x, y] = a < b ? [a, b] : [b, a];
  await as(agent.actor, (tx) => sql`INSERT INTO contact_duplicate_candidates (tenant_id, id, contact_a_id, contact_b_id, match_reason)
    VALUES (app.tenant_id(), ${uuid()}, ${x}, ${y}, 'trigram_name')`.execute(tx));
  return [x, y] as const;
};

async function merge(actor: Actor, survivor: ContactId, loser: ContactId, commandId?: string) {
  const r = await cmd(h.app, actor, survivor, { kind: 'merge', survivorId: survivor, loserId: loser, ownerChoice: null }, commandId ? { commandId } : {});
  expect(r.outcome.ok).toBe(true);
  return r;
}

describe('R-PAR-45 a merge moves the parity child rows inside the merge transaction', () => {
  it('R-PAR-45: tags (deduped), custom values (survivor wins), relationships (self-pairs dropped, deduped), notes and stage history land on the survivor; the candidate is marked merged', async () => {
    const x = await selfCreated(h.app, w, agent, 'Jane Buyer');
    const y = await selfCreated(h.app, w, agent, 'Jane B.');
    const spouse = await selfCreated(h.app, w, agent, 'John Buyer');
    const shared = await tag(x, `Buyer ${seq}`);
    await tag(y, `buyer ${seq}`); // same name_key: one tag
    const only = await tag(y, `VIP ${++seq}`);
    const f1 = await field(`budget_${++seq}`);
    const f2 = await field(`school_${++seq}`);
    await setValue(x, f1, 'survivor value');
    await setValue(y, f1, 'loser value');
    await setValue(y, f2, 'Lincoln');
    await relate(y, x, 'family'); // self-pair after the merge: dropped
    await relate(y, spouse, 'spouse_partner');
    await relate(x, spouse, 'spouse_partner'); // duplicate after the merge: one row
    await relate(y, spouse, 'co_buyer');
    await note(y, 'Wants a yard');
    await setStage(y, 'nurture');
    await setStage(y, 'active');
    const [ca, cb] = await candidate(x, y);

    await merge(w.owner.actor, x, y);

    const tags = await suRows<{ tag_id: string }>(h.su, 'SELECT tag_id FROM contact_tags WHERE contact_id = $1 ORDER BY tag_id', [x]);
    expect(tags.map((t) => t.tag_id).sort()).toEqual([shared, only].sort());
    expect(await suRows(h.su, 'SELECT count(*)::int AS n FROM contact_tags WHERE contact_id = $1', [y])).toEqual([{ n: 0 }]);
    const vals = await suRows<{ field_id: string; value_text: string }>(h.su, 'SELECT field_id, value_text FROM contact_field_values WHERE contact_id = $1', [x]);
    expect(Object.fromEntries(vals.map((v) => [v.field_id, v.value_text]))).toEqual({ [f1]: 'survivor value', [f2]: 'Lincoln' });
    const rels = await suRows<{ contact_id: string; related_contact_id: string; kind: string }>(h.su,
      'SELECT contact_id, related_contact_id, kind FROM contact_relationships WHERE $1 IN (contact_id, related_contact_id) OR $2 IN (contact_id, related_contact_id) ORDER BY kind', [x, y]);
    expect(rels).toEqual([
      { contact_id: x, related_contact_id: spouse, kind: 'co_buyer' },
      { contact_id: x, related_contact_id: spouse, kind: 'spouse_partner' },
    ]);
    expect(await suRows(h.su, 'SELECT contact_id, body FROM notes WHERE contact_id = ANY ($1::uuid[])', [[x, y]])).toEqual([{ contact_id: x, body: 'Wants a yard' }]);
    const hist = await suRows<{ to_stage: string }>(h.su, 'SELECT to_stage FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at', [x]);
    expect(hist.map((e) => e.to_stage)).toEqual(['nurture', 'active']);
    expect(await suRows(h.su, 'SELECT status, decided_by_user_id FROM contact_duplicate_candidates WHERE contact_a_id = $1 AND contact_b_id = $2', [ca, cb]))
      .toEqual([{ status: 'merged', decided_by_user_id: w.owner.id }]);
  });

  it('R-PAR-45 R-OWN-7: a replayed merge copies nothing twice (stage history once)', async () => {
    const x = await selfCreated(h.app, w, agent, 'Replay One');
    const y = await selfCreated(h.app, w, agent, 'Replay Two');
    await setStage(y, 'connected');
    const id = uuid();
    await merge(w.owner.actor, x, y, id);
    const again = await cmd(h.app, w.owner.actor, x, { kind: 'merge', survivorId: x, loserId: y, ownerChoice: null }, { commandId: id });
    expect(again.replayed).toBe(true);
    expect(await suRows(h.su, `SELECT count(*)::int AS n FROM contact_stage_events WHERE contact_id = $1 AND to_stage = 'connected'`, [x])).toEqual([{ n: 1 }]);
  });

  it('R-PAR-45: a Team Lead merge moves the child rows in the merge transaction itself, before any follow-up', async () => {
    const x = await selfCreated(h.app, w, agent, 'TL One');
    const y = await selfCreated(h.app, w, agent, 'TL Two');
    const t = await tag(y, `Hot ${++seq}`);
    await note(y, 'TL note');
    await merge(w.tl!.actor, x, y);
    expect(await suRows(h.su, 'SELECT tag_id FROM contact_tags WHERE contact_id = $1', [x])).toEqual([{ tag_id: t }]);
    expect(await suRows(h.su, 'SELECT count(*)::int AS n FROM notes WHERE contact_id = $1', [x])).toEqual([{ n: 1 }]);
    await drainFollowups(h, w);
  });

  it('R-PAR-6 R-PAR-45: a survivor at the 100-tag limit still merges; the tags it cannot take stay on the loser (never an aborted merge)', async () => {
    const x = await selfCreated(h.app, w, agent, 'Full Tags');
    const y = await selfCreated(h.app, w, agent, 'Few Tags');
    const base = ++seq;
    for (let i = 0; i < 100; i++) await tag(x, `bulk${base}-${i}`);
    const extra = await tag(y, `extra${base}`);
    await merge(w.owner.actor, x, y);
    expect(await suRows(h.su, 'SELECT count(*)::int AS n FROM contact_tags WHERE contact_id = $1', [x])).toEqual([{ n: 100 }]);
    expect(await suRows(h.su, 'SELECT tag_id FROM contact_tags WHERE contact_id = $1', [y])).toEqual([{ tag_id: extra }]);
  }, 60_000);

  it('R-PAR-4: outside a merge a note still never changes its person, whoever asks', async () => {
    const x = await selfCreated(h.app, w, agent, 'Note One');
    const y = await selfCreated(h.app, w, agent, 'Note Two');
    await note(y, 'stays');
    await expect(as(w.owner.actor, (tx) => sql`UPDATE notes SET contact_id = ${x} WHERE tenant_id = app.tenant_id() AND contact_id = ${y}`.execute(tx)))
      .rejects.toThrow(/NOTE_IMMUTABLE/);
  });

  it('R-PAR-45: the trigger function cannot be called directly by app_user', async () => {
    await expect(as(w.owner.actor, (tx) => sql`SELECT app.contacts_merge_children()`.execute(tx))).rejects.toThrow();
  });
});

describe('D1 R-PAR-12 a merge keeps every opt-out', () => {
  it('R-PAR-12 D1: the loser\'s phone texted STOP: after the merge, texting the survivor\'s own phone is refused RECIPIENT_OPTED_OUT', async () => {
    const x = await selfCreated(h.app, w, agent, 'Stop Survivor');
    const y = await selfCreated(h.app, w, agent, 'Stop Loser');
    const px = nextPhone();
    const py = nextPhone();
    await addPhone(x, px);
    await addPhone(y, py);
    await stop(py);
    await textTo(x, px); // before the merge: a different person, allowed
    await merge(w.owner.actor, x, y);
    await expect(textTo(x, px)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(textTo(x, py)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it('R-PAR-12 D1: a STOP on a phone the loser had REMOVED still blocks the merged person (removed points are copied as removed)', async () => {
    const x = await selfCreated(h.app, w, agent, 'Removed Survivor');
    const y = await selfCreated(h.app, w, agent, 'Removed Loser');
    const px = nextPhone();
    const py = nextPhone();
    await addPhone(x, px);
    const pid = await addPhone(y, py);
    await stop(py);
    await as(agent.actor, (tx) => sql`UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old' WHERE tenant_id = app.tenant_id() AND id = ${pid}`.execute(tx));
    await merge(w.tl!.actor, x, y);
    expect(await suRows(h.su, `SELECT status, removed_reason FROM contact_points WHERE contact_id = $1 AND address = $2`, [x, py])).toEqual([{ status: 'removed', removed_reason: 'old' }]);
    await expect(textTo(x, px)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it('R-PAR-12 D1: a STOP on the survivor blocks the loser\'s numbers once they are the merged person\'s', async () => {
    const x = await selfCreated(h.app, w, agent, 'Stop On Survivor');
    const y = await selfCreated(h.app, w, agent, 'Clean Loser');
    const px = nextPhone();
    const py = nextPhone();
    await addPhone(x, px);
    await addPhone(y, py);
    await stop(px);
    await merge(w.owner.actor, x, y);
    await expect(textTo(x, py)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it('R-CHAN-2 E140 D1: a person-level do-not-contact on the loser follows the merge: every send to the survivor is refused', async () => {
    const x = await selfCreated(h.app, w, agent, 'DNC Survivor');
    const y = await selfCreated(h.app, w, agent, 'DNC Loser');
    const px = nextPhone();
    await addPhone(x, px);
    await as(w.owner.actor, async (tx) => {
      const ev = uuid();
      await sql`INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
                  source, occurred_at, actor_kind, actor_user_id, contact_id)
                VALUES (app.tenant_id(), ${ev}, 'email', decode(${hmacHex(`old-${ev}@optout.test`)}, 'hex'), '•••', 'email', 'all', 'revoke',
                  'none', 'agent_revoke', now(), 'user', ${w.owner.id}, ${y})`.execute(tx);
      await sql`UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = ${ev} WHERE tenant_id = app.tenant_id() AND id = ${y}`.execute(tx);
    });
    await merge(w.owner.actor, x, y);
    expect((await suRows<{ dnc: boolean }>(h.su, 'SELECT do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE id = $1', [x]))[0]!.dnc).toBe(true);
    await expect(textTo(x, px)).rejects.toThrow(/PERSON_DO_NOT_CONTACT/);
  });
});
