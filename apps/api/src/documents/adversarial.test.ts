// Adversarial tests of api/documents (module 42, critical): tenancy, scope, version chains, claim and date
// cross-wiring, forged multipart bodies, document objects reused elsewhere, and a client cookie on staff routes
// (R-TEN-6, R-PERM-5, R-DOC-1, R-DOC-5, R-DOC-10, R-TEN-14). Fakes only; every write goes through app_user.
import { randomBytes, randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { clearFairHousing, generateAll, teamListing } from '../marketing/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { extractDocument } from './extract.js';
import { type DocWorld, call, docDeps, docWorld, makeDeal, makeListing, multipart, pdfBytes, rawPost, runScan, upload } from './testing.js';

let h: ApiHarness;
let w: DocWorld;
let x: DocWorld;
let A: { dealId: string; contactId: string; documentId: string; claimId: string };

const PAGES = [{ page: 1, text: 'Closing Date: 03/15/2027\nFinancing: 03/01/2027' }];
async function cleanContract(world: DocWorld, by = world.agents[0]!, dealId?: string): Promise<{ dealId: string; contactId: string; documentId: string; claimId: string }> {
  const d = dealId ? { dealId, contactId: '' } : await makeDeal(world, by);
  const bytes = pdfBytes();
  h.providers.textExtractor.register(bytes, PAGES);
  const r = await upload(by, `/deals/${d.dealId}/documents`, { bytes });
  await runScan(h, world.tenantId, r.body.document.id);
  const sys = systemActor(world.tenantId, 'worker');
  await extractDocument(docDeps(h), sys, (fn) => withTenantTx(sys, fn, { db: h.database }), r.body.document.id);
  const v = await call<{ claims: { id: string }[] }>(by, 'GET', `/documents/${r.body.document.id}/extraction`);
  return { ...d, documentId: r.body.document.id, claimId: v.body.claims[0]!.id };
}

beforeAll(async () => {
  h = await createApiHarness();
  [w, x] = await Promise.all([docWorld(h), docWorld(h)]);
  A = await cleanContract(w);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('adversarial: tenancy and scope', () => {
  it('R-TEN-6 R-PERM-5: another tenant\'s Owner gets 404 on every document route with this tenant\'s ids', async () => {
    const o = x.owner;
    const id = A.documentId;
    for (const [m, url, body] of [
      ['GET', `/documents/${id}`, undefined],
      ['GET', `/documents/${id}/file`, undefined],
      ['GET', `/documents/${id}/extraction`, undefined],
      ['GET', `/deals/${A.dealId}/documents`, undefined],
      ['POST', `/documents/${id}/share`, { shared: true }],
      ['POST', `/documents/${id}/hold`, { hold: true, reason: 'x' }],
      ['PUT', `/documents/${id}/retention`, { retentionUntil: new Date(Date.now() + 6 * 365 * 86_400_000).toISOString() }],
      ['POST', `/documents/${id}/extraction/run`, {}],
      ['POST', `/documents/${id}/extraction/claims/${A.claimId}/confirm`, { commandId: randomUUID(), target: { kind: 'new' } }],
      ['POST', `/documents/${id}/extraction/claims/${A.claimId}/reject`, { commandId: randomUUID() }],
    ] as const) {
      expect((await call(o, m, url, body)).status, `${m} ${url}`).toBe(404);
    }
    expect((await upload(o, `/documents/${id}/versions`)).status).toBe(404);
    expect((await upload(o, `/deals/${A.dealId}/documents`)).status).toBe(404);
    expect((await upload(o, `/contacts/${A.contactId}/documents`, { kind: 'other' })).status).toBe(404);
  });

  it('R-DOC-1: a peer agent cannot read, version or upload to another agent\'s deal or listing documents', async () => {
    const peer = w.agents[1]!;
    const otherDeal = await makeDeal(w, peer, { members: false });
    expect((await call(w.tc, 'GET', `/deals/${otherDeal.dealId}/documents`)).status).toBe(404);
    const listing = await makeListing(w.agents[0]!);
    const l = await upload(w.agents[0]!, `/listings/${listing}/documents`, { kind: 'listing_agreement' });
    await runScan(h, w.tenantId, l.body.document.id);
    expect((await call(peer, 'GET', `/documents/${l.body.document.id}/file`)).status).toBe(404);
    expect((await upload(peer, `/documents/${l.body.document.id}/versions`)).status).toBe(404);
    expect((await upload(peer, `/listings/${listing}/documents`, { kind: 'other' })).status).toBe(404);
    // the ISA sees the deal's document but may not add a version (document.upload: no ISA)
    expect((await call(w.isa, 'GET', `/documents/${A.documentId}`)).status).toBe(200);
    expect((await upload(w.isa, `/documents/${A.documentId}/versions`)).status).toBe(404);
  });

  it('R-DOC-5: a version always stays in its document\'s own scope (the route takes no scope), and the DB refuses one across scopes', async () => {
    const v = await upload(w.agents[0]!, `/documents/${A.documentId}/versions`, { extra: [{ name: 'dealId', value: randomUUID() }] });
    expect(v.status).toBe(422); // an unknown field
    const v2 = await upload(w.agents[0]!, `/documents/${A.documentId}/versions`, { kind: 'disclosure' });
    expect(v2.status).toBe(422); // a version inherits its kind
    const other = await makeDeal(w, w.agents[0]!);
    const objectId = randomUUID();
    const raw = withTenantTx(w.agents[0]!.actor(), async (tx) => {
      await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, key_version, dek_wrapped, created_by_user_id)
                VALUES (app.tenant_id(), ${objectId}, 'document', ${`tenants/${w.tenantId}/document/${objectId}`}, 'application/pdf', 10, ${randomBytes(32)}, 1, '\\x01'::bytea, app.user_id())`.execute(tx);
      await sql`INSERT INTO documents (tenant_id, id, deal_id, object_id, kind, display_name, uploaded_by_user_id, supersedes_id)
                VALUES (app.tenant_id(), ${randomUUID()}, ${other.dealId}, ${objectId}, 'purchase_contract', 'x.pdf', app.user_id(), ${A.documentId})`.execute(tx);
    }, { db: h.database });
    await expect(raw).rejects.toThrow(/DOCUMENT_VERSION_INVALID/);
  });
});

describe('adversarial: claims and dates', () => {
  it('R-DOC-10: a claim of another document used in this document\'s path is 404; a claim pointed at another deal\'s date is 404; neither writes a date', async () => {
    const B = await cleanContract(w);
    expect((await call(w.agents[0]!, 'POST', `/documents/${A.documentId}/extraction/claims/${B.claimId}/confirm`, { commandId: randomUUID(), target: { kind: 'new' } })).status).toBe(404);
    expect((await call(w.agents[0]!, 'POST', `/documents/${A.documentId}/extraction/claims/${B.claimId}/reject`, { commandId: randomUUID() })).status).toBe(404);
    const foreignDate = await call<{ date: { id: string } }>(w.agents[0]!, 'POST', `/deals/${B.dealId}/dates`, { kind: 'closing', dueOn: '2027-03-20' });
    expect((await call(w.agents[0]!, 'POST', `/documents/${A.documentId}/extraction/claims/${A.claimId}/confirm`, { commandId: randomUUID(), target: { kind: 'existing', dateId: foreignDate.body.date.id } })).status).toBe(404);
    expect((await h.su.query('SELECT 1 FROM deal_dates WHERE deal_id = $1', [A.dealId])).rows).toEqual([]);
    expect((await h.su.query('SELECT due_on::text AS d, source FROM deal_dates WHERE id = $1', [foreignDate.body.date.id])).rows[0]).toEqual({ d: '2027-03-20', source: 'manual' });
    // raw SQL: another deal's claim on this deal's date is refused by the DB
    const raw = withTenantTx(w.agents[0]!.actor(), (tx) => sql`UPDATE deal_dates SET source = 'document', evidence_claim_id = ${A.claimId} WHERE id = ${foreignDate.body.date.id}`.execute(tx), { db: h.database });
    await expect(raw).rejects.toThrow(/DEAL_DATE_EVIDENCE_INVALID/);
  });

  it('R-AST-21: the system never confirms a claim or writes a document date (DATE_HUMAN_CONFIRMATION / the decision guard)', async () => {
    const sys = systemActor(w.tenantId, 'worker');
    const raw = withTenantTx(sys, (tx) => sql`INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, source, status, confirmed_by_user_id, confirmed_at, evidence_claim_id)
        VALUES (app.tenant_id(), ${randomUUID()}, ${A.dealId}, 'closing', '2027-03-15', 'document', 'confirmed', ${w.agents[0]!.userId}, now(), ${A.claimId})`.execute(tx), { db: h.database });
    await expect(raw).rejects.toThrow(/DATE_HUMAN_CONFIRMATION/);
  });
});

describe('adversarial: forged bodies and reused objects', () => {
  it('R-DOC-6: two files, unknown fields, an oversized name field, a file posing as text, and a body that is not multipart are refused; nothing is stored', async () => {
    const before = (await h.su.query("SELECT count(*)::int AS n FROM stored_objects WHERE tenant_id = $1 AND purpose = 'document'", [w.tenantId])).rows[0].n;
    const f = { bytes: pdfBytes(), type: 'application/pdf', filename: 'a.pdf' };
    for (const parts of [
      [{ name: 'file', value: f }, { name: 'file2', value: f }, { name: 'kind', value: 'other' }],
      [{ name: 'file', value: f }, { name: 'kind', value: 'other' }, { name: '__proto__', value: 'x' }],
      [{ name: 'file', value: f }, { name: 'kind', value: 'other' }, { name: 'displayName', value: 'é'.repeat(600) }],
      [{ name: 'file', value: f }, { name: 'kind', value: { bytes: new TextEncoder().encode('other'), type: 'text/plain', filename: 'k.txt' } }],
    ]) {
      const m = await multipart(parts);
      expect((await rawPost(w.agents[0]!, `/deals/${A.dealId}/documents`, m.body, m.contentType)).statusCode).toBe(422);
    }
    expect((await rawPost(w.agents[0]!, `/deals/${A.dealId}/documents`, Buffer.from(pdfBytes()), 'application/pdf')).statusCode).toBe(415);
    expect((await h.su.query("SELECT count(*)::int AS n FROM stored_objects WHERE tenant_id = $1 AND purpose = 'document'", [w.tenantId])).rows[0].n).toBe(before);
  });

  it('R-DOC-5: a document object is never a marketing asset (MARKETING_ASSET_INVALID) nor an MMS upload (MMS_UPLOAD_OBJECT)', async () => {
    const objectId = (await h.su.query('SELECT object_id FROM documents WHERE id = $1', [A.documentId])).rows[0].object_id;
    const agent = w.agents[0]!;
    await clearFairHousing(h);
    try {
      const listing = await teamListing(agent, {});
      const pieces = await generateAll(agent, listing);
      const piece = Object.values(pieces)[0]!;
      const asAsset = withTenantTx(agent.actor(), (tx) => sql`INSERT INTO marketing_piece_assets (tenant_id, piece_id, position, object_id) VALUES (app.tenant_id(), ${piece.id}, 9, ${objectId})`.execute(tx), { db: h.database });
      await expect(asAsset).rejects.toThrow(/MARKETING_ASSET_INVALID/);
    } finally {
      await clearFairHousing(h, false);
    }
    const asMms = withTenantTx(agent.actor(), (tx) => sql`INSERT INTO outbound_media_uploads (tenant_id, id, contact_id, uploaded_by_user_id, object_id, content_type, byte_size, expires_at)
        VALUES (app.tenant_id(), ${randomUUID()}, ${A.contactId}, app.user_id(), ${objectId}, 'application/pdf', 10, now())`.execute(tx), { db: h.database });
    await expect(asMms).rejects.toThrow(/MMS_UPLOAD_OBJECT/);
  });

  it('R-TEN-14: a client (portal) cookie on staff document routes is 401', async () => {
    const token = randomBytes(32).toString('base64url');
    for (const cookie of [`__Host-psid=${token}`, `__Host-sid=${token}`]) {
      const r = await h.app.inject({ method: 'GET', url: `/api/documents/${A.documentId}/file`, headers: { cookie } });
      expect(r.statusCode, cookie.split('=')[0]).toBe(401);
      const m = await multipart([{ name: 'file', value: { bytes: pdfBytes(), type: 'application/pdf', filename: 'a.pdf' } }, { name: 'kind', value: 'other' }]);
      const u = await h.app.inject({ method: 'POST', url: `/api/deals/${A.dealId}/documents`, headers: { cookie, origin: 'http://localhost:5173', 'content-type': m.contentType }, payload: m.body });
      expect(u.statusCode).toBe(401);
    }
  });
});
