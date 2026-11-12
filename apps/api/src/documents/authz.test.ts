// Authorization of api/documents, role × route, checked against core can() (R-PERM-5; DATA_MODEL §8 "Legal hold,
// shorten document retention" and the publish row; R-DOC-1, R-DOC-7). A denial on something the caller cannot act on
// is 404, never 403; the only 403 is DOCUMENT_HOLD_OWNER_ADMIN to a member who sees the document. Also: the provider
// selection (R-INT-1) and support (metadata, never bytes).
import { type Action, type ResourceFacts, type SupportActor, can } from '@realty/core/foundation';
import { withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshReauth } from '../admin/testing.js';
import { hashPassword } from '../auth/password.js';
import { type ApiHarness, type TestClient, createApiHarness, testConfig } from '../auth/testHarness.js';
import { createFakeProviders, createProviders } from '../providers/index.js';
import { EXTRACTOR_NOT_SET_UP, FakeScanner, FakeTextExtractor, SCANNER_NOT_SET_UP, UnconfiguredScanner, UnconfiguredTextExtractor } from './provider.js';
import { listScope } from './read.js';
import { type DocWorld, call, docWorld, makeDeal, makeListing, runScan, upload } from './testing.js';

let h: ApiHarness;
let w: DocWorld;
let other: DocWorld;

beforeAll(async () => {
  h = await createApiHarness();
  [w, other] = await Promise.all([docWorld(h), docWorld(h)]);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

interface Case {
  name: string;
  client: () => TestClient;
  facts: ResourceFacts;
}
const allowed = (c: TestClient, action: Action, facts: ResourceFacts) => can(c.actor(), action, facts).ok;

describe('R-PERM-5 role × route against can()', () => {
  it('document.upload (deal): Owner/Admin any deal, Team Lead their team\'s, an agent own deals or deals they are on, a TC deals they are on, an ISA never', async () => {
    const d = await makeDeal(w, w.agents[0]!); // the TC and the ISA are members
    const cases: Case[] = [
      { name: 'owner', client: () => w.owner, facts: {} },
      { name: 'admin', client: () => w.admin, facts: {} },
      { name: 'team lead', client: () => w.teamLead, facts: { team: true } },
      { name: 'agent own', client: () => w.agents[0]!, facts: { own: true, team: true } },
      { name: 'agent peer', client: () => w.agents[1]!, facts: { team: true } },
      { name: 'tc member', client: () => w.tc, facts: { deal: true } },
      { name: 'isa member', client: () => w.isa, facts: { deal: true } },
    ];
    for (const c of cases) {
      const r = await upload(c.client(), `/deals/${d.dealId}/documents`);
      expect([c.name, r.status]).toEqual([c.name, allowed(c.client(), 'document.upload', c.facts) ? 201 : 404]);
    }
    expect((await upload(other.owner, `/deals/${d.dealId}/documents`)).status).toBe(404);
  });

  it('document.upload_listing and document.upload_contact: the listing agent and every Team Lead; a contact\'s owner, never the TC (no contactFacts.deal path)', async () => {
    const listing = await makeListing(w.agents[0]!);
    const d = await makeDeal(w, w.agents[0]!);
    const listingCases: Case[] = [
      { name: 'listing agent', client: () => w.agents[0]!, facts: { own: true } },
      { name: 'other agent', client: () => w.agents[1]!, facts: {} },
      { name: 'team lead', client: () => w.teamLead, facts: {} },
      { name: 'tc', client: () => w.tc, facts: {} },
      { name: 'admin', client: () => w.admin, facts: {} },
    ];
    for (const c of listingCases) {
      const r = await upload(c.client(), `/listings/${listing}/documents`, { kind: 'listing_agreement' });
      expect([c.name, r.status]).toEqual([c.name, allowed(c.client(), 'document.upload_listing', c.facts) ? 201 : 404]);
    }
    const contactCases: Case[] = [
      { name: 'contact owner', client: () => w.agents[0]!, facts: { own: true } },
      { name: 'tc on the contact\'s deal', client: () => w.tc, facts: { deal: true } },
      { name: 'isa on the deal', client: () => w.isa, facts: { deal: true } },
      { name: 'team lead', client: () => w.teamLead, facts: { team: true } },
      { name: 'peer agent', client: () => w.agents[1]!, facts: {} },
    ];
    for (const c of contactCases) {
      const r = await upload(c.client(), `/contacts/${d.contactId}/documents`, { kind: 'other' });
      expect([c.name, r.status]).toEqual([c.name, allowed(c.client(), 'document.upload_contact', c.facts) ? 201 : 404]);
    }
  });

  it('document.share and document.hold: share by the deal\'s agent, its Team Lead, Owner and Admin; hold only Owner/Admin (403 to a member who sees it)', async () => {
    const d = await makeDeal(w, w.agents[0]!);
    const r = await upload(w.agents[0]!, `/deals/${d.dealId}/documents`);
    const id = r.body.document.id;
    await runScan(h, w.tenantId, id);
    await freshReauth(h, w.owner);
    await freshReauth(h, w.admin);
    const cases: Case[] = [
      { name: 'owner', client: () => w.owner, facts: {} },
      { name: 'admin', client: () => w.admin, facts: {} },
      { name: 'team lead', client: () => w.teamLead, facts: { team: true } },
      { name: 'agent own', client: () => w.agents[0]!, facts: { own: true, team: true } },
      { name: 'tc', client: () => w.tc, facts: { deal: true } },
      { name: 'isa', client: () => w.isa, facts: { deal: true } },
    ];
    for (const c of cases) {
      const s = await call(c.client(), 'POST', `/documents/${id}/share`, { shared: true });
      expect([c.name, s.status]).toEqual([c.name, allowed(c.client(), 'document.share', c.facts) ? 200 : 404]);
      const hold = await call(c.client(), 'POST', `/documents/${id}/hold`, { hold: false, reason: 'check' });
      expect([c.name, hold.status, hold.code]).toEqual(allowed(c.client(), 'document.hold', {}) ? [c.name, 200, null] : [c.name, 403, 'DOCUMENT_HOLD_OWNER_ADMIN']);
    }
    // a peer agent outside the deal sees nothing: 404 everywhere
    for (const url of [`/documents/${id}`, `/documents/${id}/file`]) expect((await call(w.agents[1]!, 'GET', url)).status).toBe(404);
    for (const [m, url, body] of [['POST', `/documents/${id}/share`, { shared: true }], ['POST', `/documents/${id}/hold`, { hold: true, reason: 'x' }], ['PUT', `/documents/${id}/retention`, { retentionUntil: new Date().toISOString() }]] as const) {
      expect((await call(w.agents[1]!, m, url, body)).status).toBe(404);
      expect((await call(other.owner, m, url, body)).status).toBe(404);
    }
  });
});

describe('support reads metadata, never bytes (R-PERM-11, R-DOC-7)', () => {
  it('R-DOC-7: can() lets support list and read documents but never download, upload, share or hold; under a grant support lists the scope through RLS', async () => {
    const support: SupportActor = { kind: 'support', userId: '00000000-0000-7000-8000-00000000aaaa' as never, tenantId: w.tenantId as never, grantId: 'g' };
    expect(can(support, 'document.view', {}).ok).toBe(true);
    for (const a of ['document.download', 'document.upload', 'document.upload_listing', 'document.upload_contact', 'document.share', 'document.hold'] as Action[]) expect(can(support, a, { own: true, deal: true, team: true }).ok, a).toBe(false);
    const d = await makeDeal(w, w.agents[0]!);
    const r = await upload(w.agents[0]!, `/deals/${d.dealId}/documents`);
    await runScan(h, w.tenantId, r.body.document.id);
    const supportUserId = '00000000-0000-7000-8000-0000000a5a01';
    const pw = await hashPassword('support pass phrase for tests');
    await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, 'support@platform.test', 'Support', ${pw})`.execute(tx), { userId: supportUserId as never, db: h.database });
    const grantId = '00000000-0000-7000-8000-0000000a5a02';
    await withTenantTx(w.owner.actor(), (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
        VALUES (app.tenant_id(), ${grantId}, ${supportUserId}, ${w.owner.userId}, 'ticket', now() + interval '1 hour')`.execute(tx), { db: h.database });
    const sa: SupportActor = { kind: 'support', userId: supportUserId as never, tenantId: w.tenantId as never, grantId };
    const p = h.app.platform.providers;
    const list = await withTenantTx(sa, (tx) => listScope(tx, { kind: 'deal', id: d.dealId }, { actor: { kind: 'support' }, can: (a, f) => can(sa, a, f).ok, scanner: p.scanner, extractor: p.textExtractor }), { db: h.database });
    expect(list.documents.map((x) => x.id)).toContain(r.body.document.id);
    expect(list.documents[0]).toMatchObject({ canShare: false, canHold: false });
  });
});

describe('R-INT-1: the scanner and the PDF reader are platform configuration with an honest not-configured state', () => {
  it('R-INT-1 E402: the fakes are the default; production without ALLOW_FAKE_PROVIDERS gets both Unconfigured stand-ins, never the fake that passes every file', () => {
    const clock = { clock: { now: () => Date.now() } as never };
    expect(createFakeProviders().scanner).toBeInstanceOf(FakeScanner);
    expect(createProviders(testConfig(), clock).scanner).toBeInstanceOf(FakeScanner);
    const prod = createProviders({ ...testConfig(), env: 'production', allowFakeProviders: false }, clock);
    expect(prod.scanner).toBeInstanceOf(UnconfiguredScanner);
    expect(prod.textExtractor).toBeInstanceOf(UnconfiguredTextExtractor);
    expect([prod.scanner.configured, prod.scanner.test, prod.scanner.statusText]).toEqual([false, false, SCANNER_NOT_SET_UP]);
    expect([prod.textExtractor.configured, prod.textExtractor.statusText]).toEqual([false, EXTRACTOR_NOT_SET_UP]);
    // staging is production with fakes allowed (STAGING.md): the test scanner, which says so
    const staging = createProviders({ ...testConfig(), env: 'production', allowFakeProviders: true }, clock);
    expect(staging.scanner).toBeInstanceOf(FakeScanner);
    expect(staging.textExtractor).toBeInstanceOf(FakeTextExtractor);
    expect(staging.scanner.test).toBe(true);
  });
});
