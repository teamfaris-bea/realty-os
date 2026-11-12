// Module 42 (api/documents) migration: the document integrity guard, the deal-date evidence guard and their indexes
// (DATA_MODEL Part 2 R-DOC-5, R-DOC-8, R-DOC-10, R-AST-1; E406, E407, E408, E410, E411, E131, E417). Every write runs as
// app_user under RLS through withTenantTx; the superuser pool only reads back, and disables the new trigger inside a
// rolled-back transaction to prove what the foreign key alone would accept.
import { createHash, randomBytes } from 'node:crypto';
import type { Role, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Tx } from '../src/index.js';
import { issuePortalDocumentStream, withPortalTx } from '../src/portalTx.js';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createParty, setPortalCleared, signIn } from './portalFixture.js';
import { type Harness, type Member, PH, type World, createHarness, createWorld, selfCreated, suRows, userActor, uuid } from './world.js';


let h: Harness;
let w: World;
let w2: World;
let a: Member;   // deal owner
let b: Member;   // peer agent
let tc: Member;
let isa: Member;
let dealId: string;
let dealB: string;
let listingId: string;

const as = <T>(m: Member, fn: (tx: Tx) => Promise<T>) => withTenantTx(m.actor, fn, { db: h.app });
const sha = (s: string) => createHash('sha256').update(s).digest();

async function addMember(world: World, role: Role): Promise<Member> {
  const token = `invite-${world.slug}-${role}-${uuid()}`;
  await withTenantTx(world.owner.actor, (tx) => sql`INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at)
      VALUES (${world.tenantId}, ${uuid()}, ${`${role}-${uuid()}@${world.slug}.test`}, ${role}, ${sha(token)}, ${world.owner.id}, now() + interval '1 day')`.execute(tx), { db: h.app });
  const uid = uuid() as UserId;
  await withPreTenant((tx) => sql`SELECT * FROM auth.accept_invite(${sha(token)}, ${uid}, ${`M ${role}`}, ${PH}, now())`.execute(tx), { db: h.app });
  return { id: uid, role, actor: userActor(world.tenantId as TenantId, uid, role) };
}

interface ObjOpts { type?: string; size?: number; purpose?: string; world?: World }
async function obj(m: Member, o: ObjOpts = {}): Promise<string> {
  const id = uuid();
  const t = (o.world ?? w).tenantId;
  await withTenantTx(m.actor, (tx) => sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
      VALUES (app.tenant_id(), ${id}, ${o.purpose ?? 'document'}, ${`tenants/${t}/doc/${id}`}, ${o.type ?? 'application/pdf'}, ${o.size ?? 1234}, ${randomBytes(32)}, 1, '\\x01'::bytea, app.user_id())`.execute(tx), { db: h.app });
  return id;
}

interface DocOpts { deal?: string; listing?: string; contact?: string; supersedes?: string; kind?: string; versionNo?: number; uploader?: string }
function insertDoc(tx: Tx, m: Member, objectId: string, o: DocOpts = {}): Promise<string> {
  const id = uuid();
  const scope = o.listing ? { deal: null, listing: o.listing, contact: null } : o.contact ? { deal: null, listing: null, contact: o.contact } : { deal: o.deal ?? dealId, listing: null, contact: null };
  return sql`INSERT INTO documents (tenant_id, id, deal_id, listing_id, contact_id, object_id, kind, display_name, uploaded_by_user_id, supersedes_id, version_no)
      VALUES (app.tenant_id(), ${id}, ${scope.deal}, ${scope.listing}, ${scope.contact}, ${objectId}, ${o.kind ?? 'purchase_contract'}, 'Doc.pdf',
              ${o.uploader ?? m.id}, ${o.supersedes ?? null}, ${o.versionNo ?? 1})`.execute(tx).then(() => id);
}
const doc = (m: Member, objectId: string, o: DocOpts = {}) => as(m, (tx) => insertDoc(tx, m, objectId, o));
async function clean(id: string, world: World = w): Promise<void> {
  await withTenantTx(world.system('worker'), (tx) => sql`UPDATE documents SET scan_status = 'clean' WHERE id = ${id}`.execute(tx), { db: h.app });
}
async function errOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return 'NO ERROR';
}

beforeAll(async () => {
  h = await createHarness(8);
  w = await createWorld(h.app, { agents: 2, teamLead: true });
  w2 = await createWorld(h.app, { agents: 1 });
  a = w.agents[0]!;
  b = w.agents[1]!;
  tc = await addMember(w, 'tc');
  isa = await addMember(w, 'isa');
  const c = await selfCreated(h.app, w, a, 'Dana Deal');
  const cb = await selfCreated(h.app, w, b, 'Bo Deal');
  dealId = uuid();
  dealB = uuid();
  listingId = uuid();
  await as(a, async (tx) => {
    await sql`INSERT INTO listings (tenant_id, id, listing_agent_user_id, status, address_line1, city, region, postal_code)
              VALUES (app.tenant_id(), ${listingId}, app.user_id(), 'active', '1 Test St', 'Town', 'SC', '29401')`.execute(tx);
    await sql`INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
              VALUES (app.tenant_id(), ${dealId}, 'Dana purchase', 'buy', now(), ${c}, app.user_id(), app.user_id())`.execute(tx);
    await sql`INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES (app.tenant_id(), ${dealId}, ${tc.id}, 'tc'), (app.tenant_id(), ${dealId}, ${isa.id}, 'isa')`.execute(tx);
  });
  await as(b, (tx) => sql`INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
              VALUES (app.tenant_id(), ${dealB}, 'Bo purchase', 'buy', now(), ${cb}, app.user_id(), app.user_id())`.execute(tx));
});
afterAll(async () => {
  await h?.close();
});

describe('documents_integrity_guard (0140)', () => {
  it('E408 R-DOC-5: without the guard the foreign key alone accepts another person\'s object (referential checks bypass RLS)', async () => {
    const foreign = await obj(b);
    const c = await h.su.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE documents DISABLE TRIGGER documents_integrity_guard');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', 'user', true), set_config('app.principal_type', 'staff', true)`, [w.tenantId, a.id]);
      await c.query(`INSERT INTO documents (tenant_id, id, deal_id, object_id, kind, display_name, uploaded_by_user_id) VALUES ($1, $2, $3, $4, 'other', 'x.pdf', $5)`, [w.tenantId, uuid(), dealId, foreign, a.id]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('E408 R-DOC-5: another person\'s, another tenant\'s, an already-used, a wrong-purpose, a wrong-type, an empty, an oversized or a shredded object is refused', async () => {
    const mine = await obj(a);
    await doc(a, mine);
    const cases: Array<[string, Promise<string>]> = [
      ['peer object', obj(b)],
      ['other tenant', obj(w2.agents[0]!, { world: w2 })],
      ['mms purpose', obj(a, { purpose: 'mms', type: 'image/jpeg' })],
      ['svg', obj(a, { type: 'image/svg+xml' })],
      ['empty', obj(a, { size: 0 })],
      ['oversized', obj(a, { size: 10_000_001 })],
    ];
    for (const [label, p] of cases) {
      const id = await p;
      expect(await errOf(doc(a, id)), label).toMatch(/DOCUMENT_OBJECT_INVALID/);
    }
    expect(await errOf(doc(a, mine)), 'reused').toMatch(/DOCUMENT_OBJECT_INVALID/);
    const shredded = await obj(a);
    await withTenantTx(w.system('worker'), (tx) => sql`UPDATE stored_objects SET dek_wrapped = NULL, deleted_at = now() WHERE id = ${shredded}`.execute(tx), { db: h.app });
    expect(await errOf(doc(a, shredded)), 'shredded').toMatch(/DOCUMENT_OBJECT_INVALID/);
    // the upper bound is inclusive and every allowed type passes
    for (const type of ['application/pdf', 'image/jpeg', 'image/png']) expect(await errOf(doc(a, await obj(a, { type, size: 10_000_000 })))).toBe('NO ERROR');
  });

  it('R-DOC-5: the uploader is the acting person, never the system or someone named by an Owner', async () => {
    const o = await obj(w.owner);
    expect(await errOf(as(w.owner, (tx) => insertDoc(tx, w.owner, o, { uploader: a.id })))).toMatch(/DOCUMENT_UPLOADER_SELF|DOCUMENT_OBJECT_INVALID/);
    const sysObj = await obj(a);
    expect(await errOf(withTenantTx(w.system('worker'), (tx) => insertDoc(tx, a, sysObj), { db: h.app }))).toMatch(/DOCUMENT_UPLOADER_SELF/);
  });

  it('R-DOC-5: version_no and kind are set by the database: a new version is prev + 1 and keeps the kind', async () => {
    const v1 = await doc(a, await obj(a), { versionNo: 7, kind: 'addendum' });
    const v2 = await doc(a, await obj(a), { supersedes: v1, kind: 'other', versionNo: 1 });
    const rows = await suRows<{ id: string; version_no: number; kind: string }>(h.su, 'SELECT id, version_no, kind FROM documents WHERE id = ANY($1)', [[v1, v2]]);
    expect(rows.find((r) => r.id === v1)).toMatchObject({ version_no: 1, kind: 'addendum' });
    expect(rows.find((r) => r.id === v2)).toMatchObject({ version_no: 2, kind: 'addendum' });
  });

  it('E407 R-DOC-5: a version across scopes, or of a document the caller cannot read, is DOCUMENT_VERSION_INVALID', async () => {
    const v1 = await doc(a, await obj(a));
    await clean(v1);
    expect(await errOf(doc(b, await obj(b), { deal: dealB, supersedes: v1 }))).toMatch(/DOCUMENT_VERSION_INVALID/);
    expect(await errOf(doc(a, await obj(a), { listing: listingId, supersedes: v1 }))).toMatch(/DOCUMENT_VERSION_INVALID/);
    // b cannot read a's deal: superseding it is refused before anything else
    expect(await errOf(doc(b, await obj(b), { supersedes: v1 }))).toMatch(/DOCUMENT_VERSION_INVALID|row-level security/);
    // a peer cannot read a pending document of another uploader on a deal they see
    const pending = await doc(a, await obj(a));
    expect(await errOf(doc(tc, await obj(tc), { supersedes: pending }))).toMatch(/DOCUMENT_VERSION_INVALID/);
  });

  it('E406 R-DOC-5: two new versions of one document on two connections: one commits, the other hits the linear-chain index', async () => {
    const v1 = await doc(a, await obj(a));
    const [o1, o2] = [await obj(a), await obj(a)];
    const results = await Promise.allSettled([doc(a, o1, { supersedes: v1 }), doc(a, o2, { supersedes: v1 })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason.message)).toMatch(/documents_supersedes_uq/);
  });

  it('E411 R-DOC-8: the TC and the ISA on the deal cannot share; the deal owner and the Owner can; nobody shares a contact document', async () => {
    const d = await doc(a, await obj(a));
    await clean(d);
    for (const m of [tc, isa]) {
      expect(await errOf(as(m, (tx) => sql`UPDATE documents SET shared_to_portal = true WHERE id = ${d}`.execute(tx))), m.role).toMatch(/DOCUMENT_SHARE_NOT_ALLOWED/);
    }
    await as(a, (tx) => sql`UPDATE documents SET shared_to_portal = true WHERE id = ${d}`.execute(tx));
    await as(w.owner, (tx) => sql`UPDATE documents SET shared_to_portal = false WHERE id = ${d}`.execute(tx));
    expect(await errOf(withTenantTx(w.system('worker'), (tx) => sql`UPDATE documents SET shared_to_portal = true WHERE id = ${d}`.execute(tx), { db: h.app }))).toMatch(/DOCUMENT_SHARE_NOT_ALLOWED/);
    // the team lead may share a listing document (listing_writable), the TC never reaches it
    const l = await doc(a, await obj(a), { listing: listingId, kind: 'listing_agreement' });
    await clean(l);
    await as(w.tl!, (tx) => sql`UPDATE documents SET shared_to_portal = true WHERE id = ${l}`.execute(tx));
    const contact = await selfCreated(h.app, w, a, 'Cy Contact');
    const cd = await doc(a, await obj(a), { contact, kind: 'other' });
    await clean(cd);
    expect(await errOf(as(a, (tx) => sql`UPDATE documents SET shared_to_portal = true WHERE id = ${cd}`.execute(tx)))).toMatch(/DOCUMENT_SHARE_NOT_ALLOWED|check constraint/);
    // kind and display_name stay editable (the guard fires only on shared_to_portal)
    await as(a, (tx) => sql`UPDATE documents SET display_name = 'Renamed.pdf' WHERE id = ${d}`.execute(tx));
  });

  it('E410 R-DOC-8: unsharing stops portal downloads at once (portal.issue_document_stream returns nothing)', async () => {
    await setPortalCleared(h, true);
    try {
      const p = await createParty(h, w, a, 'Pia Portal');
      const s = await signIn(h, w, p);
      expect(await withPortalTx(s.client, (tx) => issuePortalDocumentStream(tx, p.itemId), { db: h.app })).not.toBeNull();
      await as(a, (tx) => sql`UPDATE documents SET shared_to_portal = false WHERE id = ${p.documentId}`.execute(tx));
      expect(await withPortalTx(s.client, (tx) => issuePortalDocumentStream(tx, p.itemId), { db: h.app })).toBeNull();
    } finally {
      await setPortalCleared(h, false);
    }
  });
});

describe('deal_dates_evidence_guard (0140)', () => {
  async function extraction(dealFor: string, claims: Array<{ needsReview: boolean; kind?: string }>): Promise<string[]> {
    const actionId = uuid();
    const ids = claims.map(() => uuid());
    await withTenantTx(w.system('worker'), async (tx) => {
      await sql`INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, trigger_ref)
                VALUES (app.tenant_id(), ${actionId}, 'contract_extraction', 'contract', 'requires_approval', 'proposed', ${a.id}, 'Dates found.', '{}'::jsonb,
                        ${JSON.stringify({ documentId: uuid(), dealId: dealFor })}::jsonb)`.execute(tx);
      for (const [i, c] of claims.entries()) {
        await sql`INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, structured, needs_review)
                  VALUES (app.tenant_id(), ${ids[i]}, ${actionId}, ${i}, ${c.kind ?? 'date_time'}, 'Closing: 2027-01-15', '{}'::jsonb, ${c.needsReview})`.execute(tx);
        if (!c.needsReview) {
          await sql`INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
                    VALUES (app.tenant_id(), ${uuid()}, ${ids[i]}, 'document', ${uuid()}, '{"kind":"char_range","page":1,"start":0,"end":5}'::jsonb, 'Closi', true)`.execute(tx);
        }
      }
    }, { db: h.app });
    return ids;
  }
  const insertDate = (m: Member, deal: string, claimId: string | null, source = 'document') => as(m, (tx) => sql`
      INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, source, status, confirmed_by_user_id, confirmed_at, evidence_claim_id)
      VALUES (app.tenant_id(), ${uuid()}, ${deal}, 'closing', '2027-01-15', ${source}, 'confirmed', app.user_id(), now(), ${claimId})`.execute(tx));

  it('E131 E417 R-DOC-10 R-AST-1: a needs_review claim never becomes a date, even by raw SQL', async () => {
    const [nr] = await extraction(dealId, [{ needsReview: true }]);
    expect(await errOf(insertDate(a, dealId, nr!))).toMatch(/DEAL_DATE_EVIDENCE_INVALID/);
  });

  it('R-DOC-10: another deal\'s claim, another kind of claim, or a non-document source is refused; the verified claim of the deal is accepted once', async () => {
    const [other] = await extraction(dealB, [{ needsReview: false }]);
    expect(await errOf(insertDate(a, dealId, other!))).toMatch(/DEAL_DATE_EVIDENCE_INVALID/);
    const [fact] = await extraction(dealId, [{ needsReview: false, kind: 'fact' }]);
    expect(await errOf(insertDate(a, dealId, fact!))).toMatch(/DEAL_DATE_EVIDENCE_INVALID/);
    const [ok] = await extraction(dealId, [{ needsReview: false }]);
    expect(await errOf(insertDate(a, dealId, ok!, 'manual'))).toMatch(/DEAL_DATE_EVIDENCE_INVALID/);
    expect(await errOf(insertDate(a, dealId, ok!))).toBe('NO ERROR');
    // E414 backstop: one date per claim
    expect(await errOf(insertDate(a, dealId, ok!))).toMatch(/deal_dates_evidence_claim_uq/);
    // a claim the caller cannot read (the TC sees the deal, not the uploader's extraction) is refused like a missing one
    const [hidden] = await extraction(dealId, [{ needsReview: false }]);
    expect(await errOf(insertDate(tc, dealId, hidden!))).toMatch(/DEAL_DATE_EVIDENCE_INVALID/);
  });

  it('R-DOC-10: a NULL claim (a manual date, or ON DELETE SET NULL) passes untouched', async () => {
    expect(await errOf(insertDate(a, dealId, null, 'manual'))).toBe('NO ERROR');
  });
});
