// Module 29 end to end through the real server as app_user (PHASE2_3_PLAN §5.4 #29; DATA_MODEL R-MKT-1..10, R-GATE-12,
// R-FH-1; E90, E92, E93). Fakes only: nothing leaves the process.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type MarketingWorld, PNG_1X1, approve, call, clearFairHousing, generateAll, getPiece, marketingWorld, publicPage, teamListing, uploadImage } from './testing.js';

let h: ApiHarness;
let w: MarketingWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await marketingWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-MKT-1 one listing produces every piece kind, each approved with one tap', () => {
  it('R-MKT-1 R-MKT-3 R-GATE-12: generate makes a draft of each Phase 2 kind with the brokerage name rendered, no numerals in the copy, and one approve call each', async () => {
    const pieces = await generateAll(w.agent, w.listingId);
    expect(Object.keys(pieces).sort()).toEqual(['flyer', 'marketplace_export', 'open_house_invite', 'social_post', 'website_page']);
    for (const p of Object.values(pieces)) {
      expect(p.status).toBe('draft');
      expect(p.preview?.text).toContain('Harbor Realty LLC');
      expect(JSON.stringify(p.prose)).not.toMatch(/\d/);
      expect(p.guard.reasons, p.kind).toEqual([]);
      expect(p.guard.approvable).toBe(true);
      const a = await approve(w.agent, p);
      expect(a.status, `${p.kind}: ${JSON.stringify(a.body)}`).toBe(200);
      expect(a.body.piece.status).toBe('approved');
    }
    // generate again: new drafts, the approved versions stay
    const again = await generateAll(w.agent, w.listingId, { kinds: ['flyer'] });
    expect(again.flyer!.versionNo).toBe(2);
  });

  it('R-MKT-1: approval is bound to the content the person saw: a stale hash is MARKETING_STALE and nothing is approved', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['social_post'] })).social_post!;
    const patched = await call<{ piece: { contentSha256: string } }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: { caption: 'A bright home near the water. Message us for a showing.', hashtags: [] } });
    expect(patched.status).toBe(200);
    expect(patched.body.piece.contentSha256).not.toBe(p.contentSha256);
    const r = await approve(w.agent, p);
    expect([r.status, r.code]).toEqual([409, 'MARKETING_STALE']);
    expect((await getPiece(w.agent, p.id)).status).toBe('draft');
  });
});

describe('R-FH-1 E93 fair-housing wording blocks approval', () => {
  it('E93 R-FH-1: "perfect for young families" is a hard match: approval is refused with the reason shown; "family room" is not flagged', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['website_page'] })).website_page!;
    const bad = await call<{ piece: { contentSha256: string; guard: { approvable: boolean; reasons: string[] } } }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: { headline: 'Perfect for young families', body: 'A bright home with a family room.', highlights: [] } });
    expect(bad.body.piece.guard.approvable).toBe(false);
    expect(bad.body.piece.guard.reasons.join(' ')).toMatch(/young families/i);
    const r = await approve(w.agent, { id: p.id, contentSha256: bad.body.piece.contentSha256 });
    expect([r.status, r.code]).toEqual([422, 'MARKETING_GUARD_FAILED']);
    const ok = await call<{ piece: { contentSha256: string; guard: { approvable: boolean; reasons: string[] } } }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: { headline: 'Room to grow', body: 'A bright home with a family room.', highlights: [] } });
    expect(ok.body.piece.guard).toMatchObject({ approvable: true, reasons: [] });
    expect((await approve(w.agent, { id: p.id, contentSha256: ok.body.piece.contentSha256 })).status).toBe(200);
  });
});

describe('R-MKT-3 E90 bound facts render live', () => {
  it('E90 R-MKT-3: a price change after the page was approved and published shows on the page at once; no re-approval; prose unchanged', async () => {
    await clearFairHousing(h);
    try {
      const l = await teamListing(w.agent, { price: 50_000_000 });
      const p = (await generateAll(w.agent, l, { kinds: ['website_page'] })).website_page!;
      expect((await approve(w.agent, p)).status).toBe(200);
      const pub = await call<{ piece: { status: string; publicPath: string } }>(w.agent, 'POST', `/marketing-pieces/${p.id}/publish`, {});
      expect(pub.status).toBe(200);
      expect(pub.body.piece.status).toBe('published');
      const page1 = await publicPage(h, pub.body.piece.publicPath);
      expect(page1.statusCode).toBe(200);
      expect(page1.body).toContain('$500,000');
      expect((await call(w.agent, 'PATCH', `/listings/${l}`, { listPriceCents: 47_500_000 })).status).toBe(200);
      const page2 = await publicPage(h, pub.body.piece.publicPath);
      expect(page2.body).toContain('$475,000');
      expect(page2.body).not.toContain('$500,000');
      const after = await getPiece(w.agent, p.id);
      expect(after.status).toBe('published');
      expect(after.prose).toEqual(p.prose);
    } finally {
      await clearFairHousing(h, false);
    }
  });
});

describe('assets', () => {
  it('R-MKT-2: an uploaded image joins a draft (the hash moves); an approved version keeps its images and a change is a new version', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['flyer'] })).flyer!;
    const up = await uploadImage(w.agent, l, PNG_1X1);
    expect(up.status).toBe(201);
    const withImg = await call<{ piece: { contentSha256: string; assets: unknown[] } }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { assetObjectIds: [up.objectId] });
    expect(withImg.status).toBe(200);
    expect(withImg.body.piece.assets).toHaveLength(1);
    expect(withImg.body.piece.contentSha256).not.toBe(p.contentSha256);
    expect((await approve(w.agent, { id: p.id, contentSha256: withImg.body.piece.contentSha256 })).status).toBe(200);
    const next = await call<{ piece: { id: string; versionNo: number; status: string }; newVersion: boolean }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { assetObjectIds: [] });
    expect(next.body).toMatchObject({ newVersion: true, piece: { versionNo: 2, status: 'draft' } });
    expect((await getPiece(w.agent, p.id)).assets).toHaveLength(1);
    const pdf = await w.agent.request('GET', `/api/marketing-pieces/${p.id}/flyer.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const notImage = await uploadImage(w.agent, l, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png');
    expect([notImage.status, notImage.code]).toEqual([422, 'MARKETING_ASSET_INVALID']);
  });
});
