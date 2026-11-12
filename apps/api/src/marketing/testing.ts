// Test helpers for module 29 (imported by *.test.ts only). Everything goes through the real server as app_user;
// the provider side is the deterministic fake (FakeSocialPublisher, FakeOAuth). `h.su` is used only for fixtures that
// have no application path (counsel clearing a platform pack, brokerage settings) and for read-back.
import { randomUUID } from 'node:crypto';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call, freshReauth } from '../admin/testing.js';
import { type CommsWorld, commsWorld } from '../comms/testing.js';
import { connectFlow } from '../integrations/testing.js';

export { call };

export interface MarketingWorld extends CommsWorld {
  agent: TestClient;
  listingId: string;
  tenantSlug: string;
}

/** A team with brokerage settings complete (licence number, office address), and one team listing of agents[0]. */
export async function marketingWorld(h: ApiHarness, o: { brokerage?: string; team?: string } = {}): Promise<MarketingWorld> {
  const w = await commsWorld(h, { agents: 2 });
  // the Owner sets the brokerage identity through the settings API (re-auth; R-GATE-12)
  await freshReauth(h, w.owner);
  const cur = await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings');
  const id = await call(w.owner, 'PATCH', '/settings/identity', {
    version: cur.body.settings.version,
    brokerageLegalName: o.brokerage ?? 'Harbor Realty LLC',
    teamName: o.team ?? 'The Harbor Team',
    brokerageLicenseNumber: 'BRK-0042',
    brokeragePostalAddress: '1 Harbor Way, Charleston, SC 29401',
  });
  if (id.status !== 200) throw new Error(`identity: ${id.status} ${JSON.stringify(id.body)}`);
  const agent = w.agents[0]!;
  const listingId = await teamListing(agent, {});
  const slug = (await h.su.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1', [w.tenantId])).rows[0]!.slug;
  return { ...w, agent, listingId, tenantSlug: slug };
}

export async function teamListing(agent: TestClient, o: { city?: string; price?: number; status?: string }): Promise<string> {
  const r = await call<{ listing: { id: string } }>(agent, 'POST', '/listings', {
    addressLine1: `${100 + Math.floor(Math.random() * 800)} Harbor View Rd`,
    city: o.city ?? 'Charleston',
    region: 'SC',
    postalCode: '29401',
    listPriceCents: o.price ?? 45_000_000,
    beds: 3,
    bathsX10: 25,
    sqft: 1850,
    propertyType: 'single_family',
    ...(o.status ? { status: o.status } : {}),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`listing: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.listing.id;
}

/** Counsel cleared platform:fair_housing (a fixture: there is no application path, R-INT-6). */
export async function clearFairHousing(h: ApiHarness, cleared = true): Promise<void> {
  await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = $1 WHERE key = 'platform:fair_housing' AND status = 'published'", [cleared ? new Date() : null]);
}

export interface PieceBody {
  id: string;
  listingId: string;
  kind: string;
  versionNo: number;
  status: string;
  statusLabel: string;
  prose: Record<string, unknown>;
  contentSha256: string;
  preview: { text: string; blocks: { role: string; origin: string; prominence: string; text: string }[] } | null;
  guard: { approvable: boolean; reasons: string[]; checkThis: boolean; soft: string[] };
  publications: { id: string; connectionId: string; targetKind: string; status: string; posted: boolean; label: string }[];
  publishOptions: ({ kind: 'publish'; connectionId: string; target: string } | { kind: 'export'; connectionId: string | null; reason: string; sentence: string })[];
  earlierPostNotice: string | null;
  publicPath: string | null;
  assets: { position: number; objectId: string; url: string }[];
  exportable: boolean;
  invitable: boolean;
}

export async function generateAll(c: TestClient, listingId: string, body: Record<string, unknown> = {}): Promise<Record<string, PieceBody>> {
  const r = await call<{ pieces: PieceBody[] }>(c, 'POST', `/listings/${listingId}/marketing/generate`, {
    openHouse: { startsAt: '2027-03-06T18:00:00Z', endsAt: '2027-03-06T20:00:00Z' },
    ...body,
  });
  if (r.status !== 200) throw new Error(`generate: ${r.status} ${JSON.stringify(r.body)}`);
  return Object.fromEntries(r.body.pieces.map((p) => [p.kind, p]));
}

export async function getPiece(c: TestClient, id: string): Promise<PieceBody> {
  const r = await call<{ piece: PieceBody }>(c, 'GET', `/marketing-pieces/${id}`);
  if (r.status !== 200) throw new Error(`piece: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.piece;
}

export async function approve(c: TestClient, p: { id: string; contentSha256: string }) {
  return call<{ piece: PieceBody }>(c, 'POST', `/marketing-pieces/${p.id}/approve`, { contentSha256: p.contentSha256 });
}

/** Connects a fake Facebook Page or Instagram business account through the real OAuth flow (the system links it). */
export async function connectAccount(h: ApiHarness, owner: TestClient, kind: 'facebook_page' | 'instagram_business', name = kind === 'facebook_page' ? 'Harbor Page' : 'Harbor Insta'): Promise<{ connectionId: string; accountId: string }> {
  const accountId = `${kind === 'facebook_page' ? 'page' : 'ig'}-${randomUUID().slice(0, 8)}`;
  const f = await connectFlow(h, owner, kind, { externalAccountId: accountId, displayName: name }, [{ id: accountId, name }]);
  if (f.cb.result !== 'CONNECTED') throw new Error(`connect ${kind}: ${f.cb.result}`);
  return { connectionId: f.connectionId, accountId };
}

/** A tiny valid PNG (1x1). */
export const PNG_1X1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2b1d6a90000000049454e44ae426082', 'hex');

export async function uploadImage(c: TestClient, listingId: string, bytes: Buffer = PNG_1X1, type = 'image/png'): Promise<{ status: number; objectId: string | null; code: string | null }> {
  const headers: Record<string, string> = { 'user-agent': 'vitest', 'content-type': type, origin: c.h.config.webOrigins[0]! };
  if (c.csrf) headers['x-csrf-token'] = c.csrf;
  if (c.cookie) headers.cookie = `__Host-sid=${c.cookie}`;
  const r = await c.h.app.inject({ method: 'POST', url: `/api/listings/${listingId}/marketing/assets`, headers, payload: bytes, remoteAddress: c.ip });
  const body = r.body ? (JSON.parse(r.body) as { objectId?: string; error?: { code?: string } }) : {};
  return { status: r.statusCode, objectId: body.objectId ?? null, code: body.error?.code ?? null };
}

export async function publicPage(h: ApiHarness, path: string, ip = '203.0.113.7') {
  return h.app.inject({ method: 'GET', url: path, remoteAddress: ip });
}
