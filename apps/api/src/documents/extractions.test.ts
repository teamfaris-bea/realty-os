// GET /documents/extractions (module 55's read for the Approvals pointer card; R-STAFF-2, E674) on real Postgres with
// the fake scanner and PDF reader. Synthetic contracts only. A read: nothing is decided on it (R-DOC-8).
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { extractDocument } from './extract.js';
import { OpenExtractionsResponse } from './schemas.js';
import { type DocWorld, call, docDeps, docWorld, makeDeal, pdfBytes, runScan, upload } from './testing.js';

let h: ApiHarness;
let w: DocWorld;

const PAGES = [{ page: 1, text: 'RESIDENTIAL PURCHASE AGREEMENT (synthetic test form)\nClosing Date: 2/12/27 or sooner by agreement.' }];

beforeAll(async () => {
  h = await createApiHarness();
  w = await docWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const sys = () => systemActor(w.tenantId, 'worker');
async function contract(by: DocWorld['tc'], dealId: string): Promise<string> {
  const bytes = pdfBytes();
  h.providers.textExtractor.register(bytes, PAGES);
  const r = await upload(by, `/deals/${dealId}/documents`, { bytes });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await runScan(h, w.tenantId, r.body.document.id);
  const deps = docDeps(h);
  await extractDocument(deps, sys(), (fn) => withTenantTx(sys(), fn, { db: deps.db }), r.body.document.id);
  return r.body.document.id;
}
type List = { extractions: { documentId: string; dealId: string; displayName: string; versionNo: number; outcome: string | null; unreviewedClaims: number; createdAt: string }[] };
const list = async (c: DocWorld['tc']) => {
  const r = await call<List>(c, 'GET', '/documents/extractions');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(OpenExtractionsResponse.safeParse(r.body).success).toBe(true);
  return r.body.extractions;
};

describe('GET /documents/extractions (module 55; R-STAFF-2)', () => {
  it('E674 R-STAFF-2: a TC uploader sees their own open extraction as a pointer; the agent of the deal, the Owner and another TC see none of it', async () => {
    const { dealId } = await makeDeal(w, w.agents[0]!);
    const docId = await contract(w.tc, dealId);
    const mine = await list(w.tc);
    const row = mine.find((x) => x.documentId === docId);
    expect(row).toMatchObject({ documentId: docId, dealId, versionNo: 1, outcome: 'dates' });
    expect(row!.unreviewedClaims).toBeGreaterThan(0);
    // the action is the uploader's: nobody else lists it, the Owner included (tenant-wide reads go to the document)
    for (const c of [w.agents[0]!, w.owner, w.admin, w.isa]) expect((await list(c)).some((x) => x.documentId === docId)).toBe(false);
  });

  it('R-STAFF-2: the static segment is not shadowed by /documents/:id (no 422 from its uuid param, no 404)', async () => {
    const r = await call(w.agents[1]!, 'GET', '/documents/extractions');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ extractions: [] });
    // and /documents/:id still answers for a real id
    const { dealId } = await makeDeal(w, w.agents[1]!, { members: false });
    const id = await contract(w.agents[1]!, dealId);
    expect((await call(w.agents[1]!, 'GET', `/documents/${id}`)).status).toBe(200);
    expect((await list(w.agents[1]!)).map((x) => x.documentId)).toContain(id);
  });

  it('R-STAFF-2: a document the caller can no longer see is skipped (removed from the deal), and the inbox still excludes extractions', async () => {
    const { dealId } = await makeDeal(w, w.agents[0]!);
    const docId = await contract(w.tc, dealId);
    expect((await list(w.tc)).some((x) => x.documentId === docId)).toBe(true);
    const inbox = await call<{ actions?: { kind: string }[] }>(w.tc, 'GET', '/assistant/inbox');
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).not.toContain('contract_extraction');
    const del = await call(w.owner, 'DELETE', `/deals/${dealId}/members/${w.tc.userId}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await list(w.tc)).some((x) => x.documentId === docId)).toBe(false);
  });

  it('R-STAFF-2: the route writes nothing: the actions, their claims, the documents and the audit log are the same, row versions included', async () => {
    const { dealId } = await makeDeal(w, w.agents[0]!);
    const docId = await contract(w.tc, dealId);
    // xmin changes on any UPDATE of a row, even one that writes the same values
    const snapshot = async () =>
      (
        await h.su.query<{ t: string; rows: unknown }>(
          `SELECT 'assistant_actions' AS t, coalesce(jsonb_agg(jsonb_build_object('xmin', a.xmin::text, 'row', to_jsonb(a)) ORDER BY a.id), '[]') AS rows FROM assistant_actions a WHERE a.tenant_id = $1
           UNION ALL SELECT 'assistant_claims', coalesce(jsonb_agg(jsonb_build_object('xmin', c.xmin::text, 'row', to_jsonb(c)) ORDER BY c.id), '[]') FROM assistant_claims c WHERE c.tenant_id = $1
           UNION ALL SELECT 'documents', coalesce(jsonb_agg(jsonb_build_object('xmin', d.xmin::text, 'row', to_jsonb(d)) ORDER BY d.id), '[]') FROM documents d WHERE d.tenant_id = $1
           UNION ALL SELECT 'audit_log', to_jsonb(count(*)) FROM audit_log WHERE tenant_id = $1`,
          [w.tenantId],
        )
      ).rows;
    const before = await snapshot();
    expect((await list(w.tc)).some((x) => x.documentId === docId)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('R-STAFF-2: decided extractions leave the list', async () => {
    const { dealId } = await makeDeal(w, w.agents[0]!);
    const docId = await contract(w.tc, dealId);
    expect((await list(w.tc)).some((x) => x.documentId === docId)).toBe(true);
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE tenant_id = $1 AND dedupe_key = $2`, [w.tenantId, `contract_extraction:${docId}`]);
    expect((await list(w.tc)).some((x) => x.documentId === docId)).toBe(false);
  });
});
