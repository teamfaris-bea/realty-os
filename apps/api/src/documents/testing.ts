// Test helpers for api/documents (imported by *.test.ts only). Fakes only: the fake scanner and PDF reader of the
// harness, synthetic file bytes, reserved example values. The EICAR test signature is assembled at runtime so no file
// in the repository carries it. The application acts through the real server as app_user; the superuser pool only
// reads state back and ages rows.
import type { Instant, UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { LightMyRequestResponse } from 'fastify';
import { TEST_ORIGIN, safeJson, type ApiHarness, type TestClient } from '../auth/testHarness.js';
import { call } from '../admin/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { leadsWorld } from '../leads/testing.js';
import { ownedContact } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { eicarMarker } from './provider.js';
import { reconcileInTx, scanDocument } from './scan.js';
import type { DocumentDeps } from './types.js';

export { call };

export interface DocWorld {
  tenantId: string;
  owner: TestClient;
  agents: TestClient[];
  teamLead: TestClient;
  admin: TestClient;
  tc: TestClient;
  isa: TestClient;
}

export async function docWorld(h: ApiHarness): Promise<DocWorld> {
  const w = await leadsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'tc', 'isa'], rule: false });
  return { tenantId: w.tenantId, owner: w.owner, agents: w.agents, teamLead: w.teamLead!, admin: w.others[0]!, tc: w.others[1]!, isa: w.others[2]! };
}

/** A deal of `agent` on a new contact they own; the TC and the ISA are members unless told otherwise. */
export async function makeDeal(w: DocWorld, agent: TestClient, o: { side?: 'buy' | 'sell' | 'dual'; members?: boolean; listingId?: string } = {}): Promise<{ dealId: string; contactId: string }> {
  const c = await ownedContact(agent, { consent: false });
  const d = await call<{ deal: { id: string } }>(agent, 'POST', '/deals', { primaryContactId: c.id, side: o.side ?? 'buy', ...(o.listingId ? { listingId: o.listingId } : {}) });
  if (d.status !== 201) throw new Error(`deal: ${d.status} ${JSON.stringify(d.body)}`);
  if (o.members !== false) {
    for (const [m, role] of [[w.tc, 'tc'], [w.isa, 'isa']] as const) {
      const r = await call(w.owner, 'POST', `/deals/${d.body.deal.id}/members`, { userId: m.userId, role });
      if (r.status !== 200) throw new Error(`member: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  return { dealId: d.body.deal.id, contactId: c.id };
}

export async function makeListing(agent: TestClient): Promise<string> {
  const r = await call<{ listing: { id: string } }>(agent, 'POST', '/listings', { status: 'active', addressLine1: `${Math.floor(Math.random() * 900) + 100} Test Ave`, city: 'Exampleville', region: 'CA', postalCode: '94000' });
  if (r.status !== 201) throw new Error(`listing: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.listing.id;
}

// ---- synthetic files -----------------------------------------------------------------------------------------

let fileSeq = 0;
const unique = () => `${Date.now()}-${++fileSeq}`;
export function pdfBytes(extra = ''): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% synthetic test file ${unique()}\n${extra}\n%%EOF\n`);
}
export function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new TextEncoder().encode(`JFIF ${unique()}`), 0xff, 0xd9]);
}
export function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`IHDR ${unique()}`)]);
}
/** The EICAR test file (not a virus: the industry's standard scanner test string), assembled at runtime. */
export function eicarBytes(): Uint8Array {
  const head = ['X5O!P%@AP[4', 'PZX54(P^)7CC)7}$'].join('\\');
  return new TextEncoder().encode(`%PDF-1.4\n${head}${eicarMarker()}!$H+H*\n`);
}

export interface Part {
  name: string;
  value: string | { bytes: Uint8Array; type: string; filename: string };
}

/** A multipart body built by the platform's own FormData encoder. */
export async function multipart(parts: readonly Part[]): Promise<{ body: Buffer; contentType: string }> {
  const fd = new FormData();
  for (const p of parts) {
    if (typeof p.value === 'string') fd.append(p.name, p.value);
    else fd.append(p.name, new Blob([p.value.bytes], { type: p.value.type }), p.value.filename);
  }
  const req = new Request('http://multipart.invalid/', { method: 'POST', body: fd });
  return { body: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get('content-type')! };
}

export async function rawPost(c: TestClient, url: string, body: Buffer, contentType: string, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const h: Record<string, string> = { 'user-agent': 'vitest', origin: TEST_ORIGIN, 'content-type': contentType, ...headers };
  if (c.csrf) h['x-csrf-token'] = c.csrf;
  if (c.cookie) h.cookie = `__Host-sid=${c.cookie}`;
  return c.h.app.inject({ method: 'POST', url: `/api${url}`, headers: h, payload: body, remoteAddress: c.ip });
}

export interface UploadOpts {
  bytes?: Uint8Array;
  type?: string;
  filename?: string;
  kind?: string | null;
  displayName?: string;
  extra?: Part[];
}

export interface DocBody {
  document: { id: string; versionNo: number; scan: string; scanText: string | null; displayName: string; kind: string; portal: { shared: boolean; portalCleared: boolean; text: string | null }; extraction: { status: string; outcome: string | null; text: string | null; claimCount: number }; canShare: boolean; canHold: boolean; legalHold: boolean; retentionUntil: string | null; blockedReason: string | null };
  versions: { id: string; versionNo: number }[];
  previousVersionShared?: boolean;
  previousVersionSharedText?: string | null;
  text?: string | null;
  error?: { code: string };
}

/** Uploads through the real route. `url` is e.g. `/deals/:id/documents` or `/documents/:id/versions`. */
export async function upload(c: TestClient, url: string, o: UploadOpts = {}): Promise<{ status: number; body: DocBody; code: string | null }> {
  const parts: Part[] = [{ name: 'file', value: { bytes: o.bytes ?? pdfBytes(), type: o.type ?? 'application/pdf', filename: o.filename ?? 'Purchase contract.pdf' } }];
  const kind = o.kind === undefined ? (url.includes('/versions') ? null : 'purchase_contract') : o.kind;
  if (kind !== null) parts.push({ name: 'kind', value: kind });
  if (o.displayName !== undefined) parts.push({ name: 'displayName', value: o.displayName });
  parts.push(...(o.extra ?? []));
  const m = await multipart(parts);
  const r = await rawPost(c, url, m.body, m.contentType);
  const body = safeJson(r.body) as DocBody;
  return { status: r.statusCode, body, code: (body as { error?: { code?: string } })?.error?.code ?? null };
}

// ---- the worker side ----------------------------------------------------------------------------------------

export function docDeps(h: ApiHarness): DocumentDeps {
  const d = depsFromPlatform(h.app.platform);
  return { db: d.db, envelope: d.envelope, ids: d.ids, linkSecret: d.linkSecret, providers: h.app.platform.providers };
}

/** Runs documents.scan for one document as the system (what the worker does with the job). */
export async function runScan(h: ApiHarness, tenantId: string, documentId: string, deps: DocumentDeps = docDeps(h)) {
  const sys = systemActor(tenantId, 'worker');
  return scanDocument(deps, sys, (fn) => withTenantTx(sys, fn, { db: deps.db }), documentId);
}

export async function runReconcile(h: ApiHarness, tenantId: string, deps: Pick<DocumentDeps, 'providers' | 'db'> = docDeps(h)) {
  const sys = systemActor(tenantId, 'worker');
  return withTenantTx(sys, (tx, now: Instant) => reconcileInTx(tx, deps, now), { db: deps.db });
}

export async function jobsOf(h: ApiHarness, tenantId: string, kind: string): Promise<{ payload: Record<string, unknown>; status: string; dedupe_key: string | null }[]> {
  const r = await h.su.query<{ payload: Record<string, unknown>; status: string; dedupe_key: string | null }>('SELECT payload, status, dedupe_key FROM jobs WHERE tenant_id = $1 AND kind = $2 ORDER BY id', [tenantId, kind]);
  return r.rows;
}

export function actorOfClient(c: TestClient): UserActor {
  return c.actor();
}
