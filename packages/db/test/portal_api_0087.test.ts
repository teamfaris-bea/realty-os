// api-portal (PHASE2_3_PLAN module 45), the DB half: portal_grants.display, live-only item uniqueness, the replaced
// items guard (seller side, retraction author), the portal_login_link gate category and portal.document_download.
// R-PORTAL-14, R-PORTAL-17, R-PORTAL-18, R-PORTAL-19, R-GATE-14 (DB half), E149, E129, E694, E695, E697.
//
// Real Postgres, every staff write as app_user under RLS (the agent, or the system actor); the superuser only flips
// platform:portal, ages rows and reads state back.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClientActor, issuePortalDocumentStream, withPortalTx } from '../src/portalTx.js';
import { withTenantTx } from '../src/tenantTx.js';
import { addDealContact, createListing, createMilestone, createShowing, insertItem, retractItem, setDealListing } from './portalApiFixture.js';
import { createParty, type Party, setPortalCleared, signIn } from './portalFixture.js';
import { createHarness, createWorld, type Harness, selfCreated, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let wb: World;
let jane: Party; // agent 0's buyer (primary contact of a buy deal)
let omar: Party; // agent 1's buyer

const sha = (s: string) => createHash('sha256').update(s).digest();
const asClient = <T>(c: ClientActor, fn: Parameters<typeof withPortalTx<T>>[1]) => withPortalTx(c, fn, { db: h.app });
const code = (e: Error) => e.message.split(':')[0]!;

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2 });
  wb = await createWorld(h.app, { agents: 1 });
  jane = await createParty(h, w, w.agents[0]!, 'Jane Buyer');
  omar = await createParty(h, w, w.agents[1]!, 'Omar Buyer');
  await setPortalCleared(h, true);
});
afterAll(async () => {
  try {
    await setPortalCleared(h, false);
  } finally {
    await h?.close();
  }
});

describe('R-PORTAL-18 portal_grants.display', () => {
  const setDisplay = (actor: Parameters<typeof withTenantTx>[0], grantId: string, display: unknown) =>
    withTenantTx(actor, async (tx) => Number((await sql`UPDATE portal_grants SET display = ${JSON.stringify(display)}::jsonb WHERE id = ${grantId}`.execute(tx)).numAffectedRows ?? 0), { db: h.app });

  it('R-PORTAL-18: the deal writer and the system write the copy; another agent reaches no row; the client reads it', async () => {
    const card = { title: 'Your home purchase', scope: 'purchase', agentName: 'Member 0', textTo: '+15555550100', emailTo: 'reply+abc@mail.example.test' };
    expect(await setDisplay(w.agents[0]!.actor, jane.grantId, card)).toBe(1);
    expect(await setDisplay(w.system('worker'), jane.grantId, { ...card, agentName: 'Member 0 (team)' })).toBe(1);
    expect(await setDisplay(w.agents[1]!.actor, jane.grantId, { title: 'Hijacked' })).toBe(0);
    const s = await signIn(h, w, jane);
    const seen = await asClient(s.client, async (tx) => (await sql<{ display: Record<string, string> }>`SELECT display FROM portal_grants`.execute(tx)).rows);
    expect(seen).toEqual([{ display: { ...card, agentName: 'Member 0 (team)' } }]);
  });

  it('R-PORTAL-18: a client never writes the copy (the guard and Layer 1)', async () => {
    const s = await signIn(h, w, jane);
    const r = await asClient(s.client, (tx) => sql`UPDATE portal_grants SET display = '{"title":"Mine"}'::jsonb WHERE id = ${jane.grantId}`.execute(tx)).then(
      (x) => Number(x.numAffectedRows ?? 0),
      (e: Error) => code(e),
    );
    expect([0, 'CLIENT_READ_ONLY']).toContain(r);
    const [row] = await suRows<{ t: string }>(h.su, `SELECT display->>'title' AS t FROM portal_grants WHERE id = $1`, [jane.grantId]);
    expect(row!.t).toBe('Your home purchase');
  });

  it('R-PORTAL-18: the CHECK refuses unknown keys, long or control-character text, a bad scope, a non-E.164 number and a bad email', async () => {
    const bad = [
      { personalCell: '+15555550199' },
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(121) },
      { title: 'Line\r\nSet-Cookie: x=1' },
      { scope: 'rental' },
      { scope: 7 },
      { agentName: 'A\u0007gent' },
      { textTo: '555-0100' },
      { emailTo: 'not an email' },
      { emailTo: `a@${'b'.repeat(320)}` },
      [],
    ];
    for (const d of bad) {
      const r = await setDisplay(w.agents[0]!.actor, jane.grantId, d).then(() => 'stored', (e: Error) => (/portal_grants_display_shape/.test(e.message) ? 'refused' : e.message));
      expect(r, JSON.stringify(d)).toBe('refused');
    }
    // 120 code points of astral characters are fine (code points, not UTF-16 units)
    expect(await setDisplay(w.agents[0]!.actor, jane.grantId, { title: '🏠'.repeat(120) })).toBe(1);
  });

  it('R-PORTAL-18: the guard still freezes the five binding columns (display is not one of them)', async () => {
    const r = await withTenantTx(w.agents[0]!.actor, (tx) => sql`UPDATE portal_grants SET deal_id = ${omar.dealId} WHERE id = ${jane.grantId}`.execute(tx), { db: h.app }).then(() => 'ok', code);
    expect(r).toBe('PORTAL_GRANT_IMMUTABLE');
  });
});

describe('R-PORTAL-14 retraction author and republish (E697)', () => {
  it('E697: a retracted source is published again as a new item; the old row stays retracted; two live copies are refused', async () => {
    const dd = await createMilestone(h, w, w.agents[0]!, jane.dealId);
    const spec = { grantId: jane.grantId, kind: 'milestone', sourceType: 'deal_date', sourceId: dd };
    const first = await insertItem(h, w, w.agents[0]!, spec);
    expect('id' in first).toBe(true);
    const dup = await insertItem(h, w, 'system', spec);
    expect(dup).toEqual({ code: expect.stringMatching(/duplicate key value violates unique constraint "portal_items_live_source"/) });
    expect(await retractItem(h, w, w.agents[0]!, (first as { id: string }).id)).toBe('ok');
    const again = await insertItem(h, w, w.agents[0]!, spec);
    expect('id' in again).toBe(true);
    const rows = await suRows<{ retracted: boolean }>(h.su, `SELECT retracted_at IS NOT NULL AS retracted FROM portal_items WHERE source_id = $1 ORDER BY published_at, retracted_at NULLS LAST`, [dd]);
    expect(rows.map((r) => r.retracted).sort()).toEqual([false, true]);
  });

  it('R-PORTAL-14: a person retracts as themselves (stamped), the system as nobody; neither forges the other; a retraction never changes', async () => {
    const make = async () => {
      const dd = await createMilestone(h, w, w.agents[0]!, jane.dealId, '2031-01-0' + Math.floor(1 + Math.random() * 8));
      const r = await insertItem(h, w, 'system', { grantId: jane.grantId, kind: 'milestone', sourceType: 'deal_date', sourceId: dd });
      return (r as { id: string }).id;
    };
    const a = await make();
    expect(await retractItem(h, w, w.agents[0]!, a, w.owner.id)).toBe('PORTAL_RETRACTOR');
    // a person who leaves the author out is stamped as themselves (module 43's callers write only retracted_at)
    expect(await retractItem(h, w, w.agents[0]!, a, null)).toBe('ok');
    expect((await suRows<{ by: string }>(h.su, 'SELECT retracted_by_user_id AS by FROM portal_items WHERE id = $1', [a]))[0]!.by).toBe(w.agents[0]!.id);
    expect(await retractItem(h, w, 'system', a)).toBe('PORTAL_ITEM_RETRACTED');
    const b = await make();
    expect(await retractItem(h, w, 'system', b, w.agents[0]!.id)).toBe('PORTAL_RETRACTOR');
    expect(await retractItem(h, w, 'system', b)).toBe('ok');
    expect((await suRows<{ by: string | null }>(h.su, 'SELECT retracted_by_user_id AS by FROM portal_items WHERE id = $1', [b]))[0]!.by).toBeNull();
    // the author alone, without the retraction, is refused
    const c = await make();
    const r = await withTenantTx(w.agents[0]!.actor, (tx) => sql`UPDATE portal_items SET retracted_by_user_id = ${w.agents[0]!.id} WHERE id = ${c}`.execute(tx), { db: h.app }).then(() => 'ok', code);
    expect(r).not.toBe('ok');
  });

  it('R-PORTAL-14: an item is inserted live (a pre-retracted insert is refused)', async () => {
    const dd = await createMilestone(h, w, w.agents[0]!, jane.dealId, '2032-02-02');
    const r = await withTenantTx(w.system('worker'), (tx) => sql`INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, source_type, source_id,
        published_by_kind, published_at, retracted_at) VALUES (${w.tenantId}, ${uuid()}, ${jane.grantId}, 'milestone', 'x', 'deal_date', ${dd}, 'system', now(), now())`.execute(tx), { db: h.app }).then(() => 'ok', code);
    expect(r).toBe('PORTAL_ITEM_RETRACTED');
  });

  it('E694: a forged insert of a proposed milestone or an unshared document is refused by the guard', async () => {
    const dd = await createMilestone(h, w, w.agents[0]!, jane.dealId, '2033-03-03');
    await withTenantTx(w.agents[0]!.actor, (tx) => sql`UPDATE deal_dates SET status = 'waived' WHERE id = ${dd}`.execute(tx), { db: h.app });
    expect(await insertItem(h, w, w.agents[0]!, { grantId: jane.grantId, kind: 'milestone', sourceType: 'deal_date', sourceId: dd })).toEqual({ code: 'PORTAL_SOURCE_NOT_IN_GRANT' });
    await withTenantTx(w.agents[0]!.actor, (tx) => sql`UPDATE documents SET shared_to_portal = false WHERE id = ${jane.documentId}`.execute(tx), { db: h.app });
    expect(await insertItem(h, w, w.agents[0]!, { grantId: jane.grantId, kind: 'document', sourceType: 'document', sourceId: jane.documentId, version: 2, documentId: jane.documentId })).toEqual({ code: 'PORTAL_SOURCE_NOT_IN_GRANT' });
    await withTenantTx(w.agents[0]!.actor, (tx) => sql`UPDATE documents SET shared_to_portal = true WHERE id = ${jane.documentId}`.execute(tx), { db: h.app });
  });
});

describe('R-PORTAL-19 seller-side binding through the deal listing (E695)', () => {
  let listingId: string;
  let showingId: string;
  let attendedShowing: string;
  beforeAll(async () => {
    listingId = await createListing(h, w, w.agents[0]!);
    await setDealListing(h, w.agents[0]!, jane.dealId, listingId);
    showingId = await createShowing(h, w, w.agents[0]!, listingId);
    attendedShowing = await createShowing(h, w, w.agents[0]!, await createListing(h, w, w.agents[0]!, '9 Oak Road'), jane.contactId);
  });

  it('E695: a buyer-side client (or one who is only the primary contact) is refused PORTAL_NOT_SELLER_SIDE', async () => {
    expect(await insertItem(h, w, w.agents[0]!, { grantId: jane.grantId, kind: 'showing', sourceType: 'showing', sourceId: showingId })).toEqual({ code: 'PORTAL_NOT_SELLER_SIDE' });
    await addDealContact(h, w, w.agents[0]!, jane.dealId, jane.contactId, 'buyer');
    expect(await insertItem(h, w, w.agents[0]!, { grantId: jane.grantId, kind: 'showing', sourceType: 'showing', sourceId: showingId })).toEqual({ code: 'PORTAL_NOT_SELLER_SIDE' });
  });

  it('R-PORTAL-19: a showing the client attended is allowed whatever the side', async () => {
    const r = await insertItem(h, w, w.agents[0]!, { grantId: jane.grantId, kind: 'showing', sourceType: 'showing', sourceId: attendedShowing });
    expect('id' in r).toBe(true);
  });

  it('R-PORTAL-19: a seller or co-seller of the deal is reached through the deal listing', async () => {
    const seller = await selfCreated(h.app, w, w.agents[0]!, 'Sid Seller');
    await withTenantTx(w.agents[0]!.actor, (tx) => sql`DELETE FROM deal_contacts WHERE deal_id = ${jane.dealId} AND contact_id = ${jane.contactId}`.execute(tx), { db: h.app });
    await addDealContact(h, w, w.agents[0]!, jane.dealId, jane.contactId, 'co_seller');
    const r = await insertItem(h, w, w.agents[0]!, { grantId: jane.grantId, kind: 'showing', sourceType: 'showing', sourceId: showingId });
    expect('id' in r).toBe(true);
    expect(seller).toBeTruthy();
  });

  it('R-PORTAL-19: a showing of an unrelated listing stays PORTAL_SOURCE_NOT_IN_GRANT', async () => {
    const other = await createShowing(h, w, w.agents[0]!, await createListing(h, w, w.agents[0]!, '1 Far Lane'));
    expect(await insertItem(h, w, w.agents[0]!, { grantId: jane.grantId, kind: 'showing', sourceType: 'showing', sourceId: other })).toEqual({ code: 'PORTAL_SOURCE_NOT_IN_GRANT' });
  });
});

describe('R-GATE-14 the portal_login_link category (DB half)', () => {
  it('R-GATE-14: a blocked portal_login_link decision is stored', async () => {
    const r = await withTenantTx(w.system('worker'), async (tx) => {
      const pv = await sql<{ id: string }>`SELECT id FROM compliance_policy_versions ORDER BY version_no DESC LIMIT 1`.execute(tx);
      await sql`INSERT INTO gate_decisions (tenant_id, id, address_hmac, channel, purpose, initiator, action_category, phase, outcome, reason_codes,
          explanation, policy_version_id, core_rules_version, inputs, inputs_sha256, evaluated_at)
        VALUES (${w.tenantId}, ${uuid()}, ${sha('a')}, 'email', 'informational', 'system', 'portal_login_link', 'send', 'deny', '{CONSENT_REVOKED}',
          'Blocked', ${pv.rows[0]!.id}, 'core-compliance/3.2.0', '{}'::jsonb, ${'0'.repeat(64)}, now())`.execute(tx);
      return 'ok';
    }, { db: h.app }).catch(code);
    expect(r).toBe('ok');
  });
});

describe('R-PORTAL-17 portal.document_download', () => {
  const download = (c: ClientActor, token: string) =>
    asClient(c, async (tx) => (await sql<{ document_id: string; object_key_wrapped: Buffer; object_key_version: number; key_version: number }>`
      SELECT * FROM portal.document_download(${sha(token)}, '203.0.113.9'::inet, 'vitest')`.execute(tx)).rows);

  it('R-PORTAL-17: returns the object and its own wrapped object key version, once, audited', async () => {
    const s = await signIn(h, w, omar);
    const t = await asClient(s.client, (tx) => issuePortalDocumentStream(tx, omar.itemId));
    expect(t).not.toBeNull();
    const rows = await download(s.client, t!.token);
    expect(rows).toHaveLength(1);
    const [key] = await suRows<{ wrapped_key: Buffer }>(h.su, `SELECT wrapped_key FROM tenant_keys WHERE tenant_id = $1 AND purpose = 'object' AND key_version = 1`, [w.tenantId]);
    expect(rows[0]!.object_key_version).toBe(1);
    expect(rows[0]!.key_version).toBe(1);
    expect(Buffer.compare(rows[0]!.object_key_wrapped, key!.wrapped_key)).toBe(0);
    expect(await download(s.client, t!.token)).toEqual([]); // single use
    const audits = await suRows<{ n: string }>(h.su, `SELECT count(*) AS n FROM audit_log WHERE action = 'portal.document_downloaded' AND entity_id = $1`, [omar.documentId]);
    expect(Number(audits[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('E149: a staff session that sets the account GUC gets no row (and the token stays usable by its client)', async () => {
    const s = await signIn(h, w, omar);
    const t = await asClient(s.client, (tx) => issuePortalDocumentStream(tx, omar.itemId));
    for (const m of [w.agents[1]!, w.owner]) {
      const r = await withTenantTx(m.actor, async (tx) => {
        await sql`SELECT set_config('app.portal_account_id', ${omar.accountId}, true)`.execute(tx);
        return (await sql`SELECT * FROM portal.document_download(${sha(t!.token)})`.execute(tx)).rows.length;
      }, { db: h.app });
      expect(r).toBe(0);
    }
    expect(await download(s.client, t!.token)).toHaveLength(1);
  });

  it('R-PORTAL-17: another account cannot redeem the token', async () => {
    const so = await signIn(h, w, omar);
    const sj = await signIn(h, w, jane);
    const t = await asClient(so.client, (tx) => issuePortalDocumentStream(tx, omar.itemId));
    expect(await download(sj.client, t!.token)).toEqual([]);
  });

  it('R-PORTAL-17: no row once the object key version is destroyed (crypto-shred), a retired key still serves', async () => {
    const bea = await createParty(h, wb, wb.agents[0]!, 'Bea Buyer');
    const s = await signIn(h, wb, bea);
    await h.su.query(`UPDATE tenant_keys SET retired_at = now() WHERE tenant_id = $1 AND purpose = 'object' AND key_version = 1`, [wb.tenantId]);
    const t1 = await asClient(s.client, (tx) => issuePortalDocumentStream(tx, bea.itemId));
    expect(await download(s.client, t1!.token)).toHaveLength(1);
    await h.su.query(`UPDATE tenant_keys SET wrapped_key = NULL, destroyed_at = now() WHERE tenant_id = $1 AND purpose = 'object' AND key_version = 1`, [wb.tenantId]);
    const t2 = await asClient(s.client, (tx) => issuePortalDocumentStream(tx, bea.itemId));
    expect(await download(s.client, t2!.token)).toEqual([]);
  });

  it('R-PORTAL-17: a single-fault sweep over the chain: each fault alone refuses the download', async () => {
    type Fault = { name: string; apply: (p: Party) => Promise<void>; undo: (p: Party) => Promise<void> };
    const su = (q: string, v: unknown[]) => h.su.query(q, v).then(() => undefined);
    const stranger = await selfCreated(h.app, w, omar.agent, 'Stan Stranger');
    const primary = (p: Party, c: string) => withTenantTx(p.agent.actor, (tx) => sql`UPDATE deals SET primary_contact_id = ${c} WHERE id = ${p.dealId}`.execute(tx), { db: h.app }).then(() => undefined);
    const share = (p: Party, on: boolean) => withTenantTx(p.agent.actor, (tx) => sql`UPDATE documents SET shared_to_portal = ${on} WHERE id = ${p.documentId}`.execute(tx), { db: h.app }).then(() => undefined);
    const faults: Fault[] = [
      { name: 'item retracted', apply: (p) => su(`ALTER TABLE portal_items DISABLE TRIGGER portal_items_guard; UPDATE portal_items SET retracted_at = now() WHERE id = '${p.itemId}'; ALTER TABLE portal_items ENABLE TRIGGER portal_items_guard`, []), undo: (p) => su(`ALTER TABLE portal_items DISABLE TRIGGER portal_items_guard; UPDATE portal_items SET retracted_at = NULL WHERE id = '${p.itemId}'; ALTER TABLE portal_items ENABLE TRIGGER portal_items_guard`, []) },
      { name: 'grant lapsed', apply: (p) => su(`ALTER TABLE portal_grants DISABLE TRIGGER portal_grants_guard; UPDATE portal_grants SET granted_at = granted_at - interval '1 day', expires_at = granted_at - interval '1 day' + interval '1 second' WHERE id = '${p.grantId}'; ALTER TABLE portal_grants ENABLE TRIGGER portal_grants_guard`, []), undo: (p) => su(`ALTER TABLE portal_grants DISABLE TRIGGER portal_grants_guard; UPDATE portal_grants SET granted_at = granted_at + interval '1 day', expires_at = NULL WHERE id = '${p.grantId}'; ALTER TABLE portal_grants ENABLE TRIGGER portal_grants_guard`, []) },
      { name: 'document unshared', apply: (p) => share(p, false), undo: (p) => share(p, true) },
      { name: 'object deleted', apply: (p) => su('UPDATE stored_objects SET deleted_at = now() WHERE id = $1', [p.objectId]), undo: (p) => su('UPDATE stored_objects SET deleted_at = NULL WHERE id = $1', [p.objectId]) },
      { name: 'party removed', apply: (p) => primary(p, stranger), undo: (p) => primary(p, p.contactId) },
      { name: 'pack withdrawn', apply: () => setPortalCleared(h, false), undo: () => setPortalCleared(h, true) },
    ];
    const s = await signIn(h, w, omar);
    for (const f of faults) {
      const t = await asClient(s.client, (tx) => issuePortalDocumentStream(tx, omar.itemId));
      expect(t, f.name).not.toBeNull();
      await f.apply(omar);
      try {
        expect(await download(s.client, t!.token), f.name).toEqual([]);
      } finally {
        await f.undo(omar);
      }
    }
    const ok = await asClient(s.client, (tx) => issuePortalDocumentStream(tx, omar.itemId));
    expect(await download(s.client, ok!.token)).toHaveLength(1);
  });

  it('R-PORTAL-17: portal.document_download is owned by app_definer, pinned, and not executable by PUBLIC', async () => {
    const [r] = await suRows<{ owner: string; pinned: boolean; pub: boolean; app: boolean }>(h.su, `
      SELECT pg_get_userbyid(p.proowner) AS owner, EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS pinned,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app
        FROM pg_proc p WHERE p.oid = 'portal.document_download(bytea, inet, text)'::regprocedure`);
    expect(r).toEqual({ owner: 'app_definer', pinned: true, pub: false, app: true });
  });
});

describe('E129 the client still reads only the three portal tables', () => {
  it('E129: retracted rows and their author stay invisible to the client; staff tables read 0 rows', async () => {
    const s = await signIn(h, w, jane);
    const r = await asClient(s.client, async (tx) => ({
      retracted: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM portal_items WHERE retracted_at IS NOT NULL`.execute(tx)).rows[0]!.n),
      contacts: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM contacts`.execute(tx)).rows[0]!.n),
      deals: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM deals`.execute(tx)).rows[0]!.n),
      keys: await sql`SELECT count(*) FROM tenant_keys`.execute(tx).then(() => 'read', () => 'refused'),
    }));
    expect(r.retracted).toBe(0);
    expect(r.contacts).toBe(0);
    expect(r.deals).toBe(0);
    expect(['refused', 'read']).toContain(r.keys);
    if (r.keys === 'read') {
      const n = await asClient(s.client, async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM tenant_keys`.execute(tx)).rows[0]!.n));
      expect(n).toBe(0);
    }
  });
});

describe('R-PORTAL-17 redeemPortalDocumentDownload (the @realty/db wrapper)', () => {
  it('R-PORTAL-17: returns the object with its wrapped key version once, null afterwards and for a malformed token', async () => {
    const { redeemPortalDocumentDownload } = await import('../src/portalTx.js');
    const s = await signIn(h, w, omar);
    const t = await asClient(s.client, (tx) => issuePortalDocumentStream(tx, omar.itemId));
    const first = await asClient(s.client, (tx) => redeemPortalDocumentDownload(tx, t!.token, { ip: '203.0.113.9', userAgent: 'vitest' }));
    expect(first).toMatchObject({ documentId: omar.documentId, objectId: omar.objectId, keyVersion: 1, objectKeyVersion: 1 });
    expect(Buffer.isBuffer(first!.objectKeyWrapped)).toBe(true);
    expect(await asClient(s.client, (tx) => redeemPortalDocumentDownload(tx, t!.token))).toBeNull();
    expect(await asClient(s.client, (tx) => redeemPortalDocumentDownload(tx, 'short'))).toBeNull();
  });
});
