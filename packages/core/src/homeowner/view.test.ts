// Loads node:fs through a dynamic import with a non-literal specifier, as voice/architecture.test.ts (core is pure).
import { describe, expect, it } from 'vitest';
import { HOMEOWNER_FIELDS, REF_PATTERN, RECOGNITION_REASONS, SOURCE_PATTERN } from './types.js';
import { homeownerView, mailingDiffers, type ViewHome, type ViewInput, type ViewProfile } from './view.js';
import { TEAM_CLOSING_SOURCE } from './years.js';

interface FileUrl {
  readonly pathname: string;
}
const Url = (globalThis as unknown as { URL: new (path: string, base: string | FileUrl) => FileUrl }).URL;
interface FsLike {
  readdirSync(p: FileUrl): string[];
  readFileSync(p: FileUrl, enc: 'utf8'): string;
}
const NODE_FS = 'node:fs';
const fs = (await import(NODE_FS)) as FsLike;
const REPO = new Url('../../../../', (import.meta as unknown as { url: string }).url);
const at = (rel: string) => new Url(rel, REPO);
const SRC = 'Beaufort County GIS parcel layer';
const BEAUFORT = { line1: '10 Sample Lane', line2: null, city: 'Exampleton', region: 'SC', postalCode: '29902' };
const SHARED = { ...BEAUFORT, postalCode: '29910' };
const JASPER = { ...BEAUFORT, postalCode: '29936' };
const OTHER = { ...BEAUFORT, region: 'GA', postalCode: '31401' };

const profile = (p: Partial<ViewProfile>): ViewProfile => ({
  status: 'matched', matchDetail: null, source: SRC, checkedOn: '2026-11-10', lastFailureOn: null, lastFailureCode: null, nextCheckOn: '2026-12-10', facts: {}, ...p,
});
const input = (homes: ViewHome[], extra: Partial<ViewInput> = {}): ViewInput => ({
  today: '2026-11-12', configured: true, test: false, statusText: 'Public records: Beaufort County GIS connector; live lookups are on on this platform',
  reasons: [{ reason: 'seller_intent', since: null }], homes, mergedRecords: false, outreachClearanceOn: null, ...extra,
});
const one = (h: ViewHome, extra: Partial<ViewInput> = {}) => homeownerView(input([h], extra)).homes[0]!;

const MATCHED = profile({
  facts: {
    last_transfer_date: { value: '2015-06-01', source: SRC, asOf: null },
    last_transfer_price_cents: { value: 25_000_000, source: SRC, asOf: '2026-10-01' },
    owner_mailing_address: { value: 'PO BOX 1, EXAMPLETON SC 29902', source: SRC, asOf: null },
  },
});

describe('homeownerView (R-HOME-4, R-HOME-5, R-HOME-7)', () => {
  it('R-HOME-1 R-HOME-7: a contact that is not recognised gives { recognized: false, homes: [] }', () => {
    const v = homeownerView(input([{ address: BEAUFORT, kind: 'home', profile: MATCHED }], { reasons: [] }));
    expect(v.recognized).toBe(false);
    expect(v.homes).toEqual([]);
  });

  it('R-HOME-4 R-HOME-5: a matched home shows every kept value with its source and as-of date (or the check date), and why each other value is missing', () => {
    const h = one({ address: BEAUFORT, kind: 'home', profile: MATCHED });
    expect(h.outcome).toBe('matched');
    expect(h.check).toEqual({ state: 'checked', checkedOn: '2026-11-10', nextCheckOn: '2026-12-10' });
    expect(h.rows.find((r) => r.key === 'last_transfer_price_cents')).toEqual({ key: 'last_transfer_price_cents', state: 'value', value: 25_000_000, source: SRC, asOf: '2026-10-01', readOn: null });
    expect(h.rows.find((r) => r.key === 'last_transfer_date')).toMatchObject({ state: 'value', asOf: null, readOn: '2026-11-10' });
    const missing = h.rows.find((r) => r.key === 'assessed_value_cents')!;
    expect(missing).toMatchObject({ state: 'not_available', why: 'not_in_record' });
    expect(missing.state !== 'value' && missing.state !== 'pending_d9' && missing.link?.url).toMatch(/^https:\/\//);
    expect(h.yearsOwned).toEqual({ years: 11, since: '2015-06-01', basis: 'county_transfer', source: SRC, asOf: null });
    expect(h.mailingDiffers).toBe(true);
    expect(h.loansLink?.label).toMatch(/Register of Deeds/);
    expect(h.rows.filter((r) => r.state === 'pending_d9').map((r) => r.key)).toEqual(['mls_sale_history', 'in_house_value']);
  });

  it('R-HOME-3 E562 E564 E565: not matched (each detail) and ambiguous keep nothing', () => {
    for (const matchDetail of ['owner_name_mismatch', 'address_mismatch', 'missing_data'] as const) {
      const h = one({ address: BEAUFORT, kind: 'home', profile: profile({ status: 'not_matched', matchDetail }) });
      expect(h.outcome).toBe('not_matched');
      expect(h.matchDetail).toBe(matchDetail);
      expect(h.rows.filter((r) => r.state === 'value')).toEqual([]);
      expect(h.mailingDiffers).toBeNull();
      expect(h.yearsOwned).toBeNull();
    }
    const a = one({ address: BEAUFORT, kind: 'home', profile: profile({ status: 'ambiguous' }) });
    expect(a.outcome).toBe('ambiguous');
    expect(a.rows.every((r) => r.state !== 'value')).toBe(true);
  });

  // b11 reconciliation homeowner-3: the Gisfile step is off by default, so the county transfer date is rarely there
  it('R-HOME-4 E582: with no county transfer date, years owned counts from the team closing the viewer sees, and names it', () => {
    const noTransfer = profile({ facts: { owner_mailing_address: { value: 'PO BOX 1, EXAMPLETON SC 29902', source: SRC, asOf: null } } });
    const team = { years: 5, since: '2021-03-15', basis: 'team_closing', source: TEAM_CLOSING_SOURCE, asOf: null };
    expect(one({ address: BEAUFORT, kind: 'home', profile: noTransfer, teamClosingOn: '2021-03-15' }).yearsOwned).toEqual(team);
    // the county's transfer date wins when the record has one
    expect(one({ address: BEAUFORT, kind: 'home', profile: MATCHED, teamClosingOn: '2021-03-15' }).yearsOwned).toMatchObject({ since: '2015-06-01', basis: 'county_transfer' });
    // not checked yet, no record, Jasper (links only) and outside the table: the closing still counts
    for (const h of [{ address: BEAUFORT, profile: null }, { address: BEAUFORT, profile: profile({ status: 'not_available' }) }, { address: JASPER, profile: null }, { address: OTHER, profile: null }]) {
      expect(one({ ...h, kind: 'home', teamClosingOn: '2021-03-15' }).yearsOwned).toEqual(team);
    }
    // a county record that names someone else as owner contradicts it: nothing is counted
    expect(one({ address: BEAUFORT, kind: 'home', profile: profile({ status: 'not_matched', matchDetail: 'owner_name_mismatch' }), teamClosingOn: '2021-03-15' }).yearsOwned).toBeNull();
    // no closing the viewer can see: nothing is counted
    expect(one({ address: BEAUFORT, kind: 'home', profile: noTransfer, teamClosingOn: null }).yearsOwned).toBeNull();
    expect(one({ address: BEAUFORT, kind: 'home', profile: noTransfer }).yearsOwned).toBeNull();
  });

  it('R-HOME-5 E565: not available says the county record has none and where to look', () => {
    const h = one({ address: BEAUFORT, kind: 'home', profile: profile({ status: 'not_available' }) });
    expect(h.outcome).toBe('not_available');
    expect(h.rows[0]).toMatchObject({ state: 'not_available', why: 'not_in_record' });
  });

  it('R-HOME-6 E572: a failure after a read shows both dates and keeps the values; a failure before any read says nothing was read', () => {
    const later = one({ address: BEAUFORT, kind: 'home', profile: { ...MATCHED, lastFailureOn: '2026-11-11', lastFailureCode: 'timeout' } });
    expect(later.check).toEqual({ state: 'failed', failedOn: '2026-11-11', lastReadOn: '2026-11-10' });
    expect(later.rows.filter((r) => r.state === 'value')).toHaveLength(3);
    const never = one({ address: BEAUFORT, kind: 'home', profile: profile({ status: 'failed', checkedOn: null, lastFailureOn: '2026-11-11', lastFailureCode: 'unavailable' }) });
    expect(never.check).toEqual({ state: 'failed', failedOn: '2026-11-11', lastReadOn: null });
    expect(never.outcome).toBe('failed');
  });

  it('R-HOME-6 R-HOME-10 E573 E574: an unprofiled home says it is checked overnight, or shows the platform status text when not configured', () => {
    expect(one({ address: BEAUFORT, kind: 'home', profile: null }).check).toEqual({ state: 'not_checked' });
    const off = one({ address: BEAUFORT, kind: 'home', profile: null }, { configured: false, statusText: 'Public records are not set up on this platform' });
    expect(off.check).toEqual({ state: 'not_configured', text: 'Public records are not set up on this platform' });
    expect(off.providerNote).toBe('Public records are not set up on this platform');
  });

  // b11 api-ui/F5: the dev and staging-demo fake is configured, and its answers read as county findings ("Checked …",
  // "The county has no record for this address.") with no word that no county was asked.
  it('R-HOME-4 R-HOME-5: a test public-records source says so on every home (no county was asked); a real source adds no note', () => {
    const TEST = 'This deployment uses test public records: no county was asked, and these answers are test data.';
    const homes: ViewHome[] = [
      { address: BEAUFORT, kind: 'home', profile: MATCHED },
      { address: { ...BEAUFORT, line1: '11 Sample Lane' }, kind: 'home', profile: profile({ status: 'not_available' }) },
      { address: { ...BEAUFORT, line1: '12 Sample Lane' }, kind: 'home', profile: null },
      { address: JASPER, kind: 'home', profile: null },
      { address: OTHER, kind: 'home', profile: null },
    ];
    const fake = homeownerView(input(homes, { test: true, statusText: TEST }));
    expect(fake.homes.map((h) => h.providerNote)).toEqual(homes.map(() => TEST));
    expect(fake.homes[2]!.check).toEqual({ state: 'not_checked' });
    expect(homeownerView(input(homes)).homes.map((h) => h.providerNote)).toEqual(homes.map(() => null));
  });

  it('R-HOME-5 E575 E576: a Jasper home is links only; a shared ZIP with no Beaufort record also offers the Jasper lookup', () => {
    const j = one({ address: JASPER, kind: 'home', profile: null });
    expect(j.outcome).toBe('links_only');
    expect(j.county).toEqual({ key: 'sc-jasper', name: 'Jasper County', mode: 'links' });
    expect(j.lookupLinks.map((l) => l.label)).toEqual(['Jasper County Assessor on qPublic']);
    const s = one({ address: SHARED, kind: 'home', profile: profile({ status: 'not_available' }) });
    expect(s.county?.mode).toBe('shared');
    expect(s.lookupLinks.map((l) => l.label)).toEqual(['Jasper County Assessor on qPublic']);
    expect(one({ address: SHARED, kind: 'home', profile: MATCHED }).lookupLinks).toEqual([]);
  });

  // b11 reconciliation homeowner-11 (verify_items 6): the Jasper links went to the county homepage, Beaufort's to
  // pages other than the brief's, and no millage link existed where tax values are shown
  it('R-HOME-5: the county pages are the brief\'s (each VERIFY); Beaufort homes add the millage page; no link carries the address', () => {
    const b = one({ address: BEAUFORT, kind: 'home', profile: MATCHED });
    expect(b.rows.find((r) => r.key === 'assessed_value_cents')).toMatchObject({ link: { url: 'https://sc-beaufort.publicaccessnow.com/' } });
    expect(b.loansLink).toEqual({ label: 'Beaufort County Register of Deeds', url: 'https://www.beaufortcountysc.gov/register-of-deeds/index.html' });
    expect(b.taxRatesLink).toEqual({ label: 'Beaufort County millage rates', url: 'https://beaufortcountysc.gov/auditor/millage-info.html' });
    expect(one({ address: BEAUFORT, kind: 'home', profile: null }).taxRatesLink).toEqual(b.taxRatesLink);
    const j = one({ address: JASPER, kind: 'home', profile: null });
    expect(j.lookupLinks).toEqual([{ label: 'Jasper County Assessor on qPublic', url: 'https://qpublic.net/sc/jasper/' }]);
    expect(j.loansLink).toEqual({ label: 'Jasper County Register of Deeds', url: 'https://www.jaspercountysc.gov/services/register-of-deeds/' });
    expect(j.taxRatesLink).toBeNull();
    expect(one({ address: OTHER, kind: 'home', profile: null }).taxRatesLink).toBeNull();
    const all = JSON.stringify([b, j, one({ address: SHARED, kind: 'home', profile: profile({ status: 'not_available' }) })].map((h) => [h.rows, h.lookupLinks, h.loansLink, h.taxRatesLink]));
    for (const url of all.match(/https?:\/\/[^"]+/g)!) {
      expect(url).toMatch(/^https:\/\//);
      expect(url.toLowerCase()).not.toMatch(/sample|exampleton|299\d\d/);
    }
  });

  it('R-HOME-5 E577: an address outside the table has no county and no links', () => {
    const o = one({ address: OTHER, kind: 'home', profile: null });
    expect(o.outcome).toBe('outside_area');
    expect(o.county).toBeNull();
    expect(o.lookupLinks).toEqual([]);
  });

  it('R-HOME-1 R-HOME-9 E569: whether records were merged into this one passes through (b11 ownership-data/F6)', () => {
    expect(homeownerView(input([], { mergedRecords: true })).mergedRecords).toBe(true);
    expect(homeownerView(input([])).mergedRecords).toBe(false);
    expect(homeownerView(input([], { reasons: [], mergedRecords: true }))).toMatchObject({ recognized: false, mergedRecords: true });
  });

  it('R-HOME-8: the outreach line is never built and carries the recorded clearance date or null', () => {
    expect(homeownerView(input([])).outreach).toEqual({ built: false, clearanceOn: null });
    expect(homeownerView(input([], { outreachClearanceOn: '2026-11-12' })).outreach).toEqual({ built: false, clearanceOn: '2026-11-12' });
  });

  it('R-HOME-4: no score, confidence, percentage, estimate, balance, equity or owner-name key exists in any state (snapshot)', () => {
    const v = homeownerView(input([
      { address: BEAUFORT, kind: 'home', profile: MATCHED },
      { address: SHARED, kind: 'property', profile: profile({ status: 'not_matched', matchDetail: 'owner_name_mismatch' }) },
      { address: JASPER, kind: 'home', profile: null },
    ], { reasons: [{ reason: 'past_buyer', since: '2024-05-01' }] }));
    const keys = new Set<string>();
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') for (const [k, val] of Object.entries(x)) { keys.add(k); walk(val); }
    };
    walk(v);
    for (const k of keys) expect(k).not.toMatch(/score|confidence|percent|probab|estimat|balance|equity|owner_?name|ownerNames/i);
    expect(v).toMatchSnapshot();
  });

  it('mailingDiffers: "tax mail goes elsewhere" is true, false, or null when the address cannot be parsed', () => {
    expect(mailingDiffers('10 SAMPLE LN, EXAMPLETON SC 29902', BEAUFORT)).toBe(false);
    expect(mailingDiffers('10 Sample Lane, Exampleton, South Carolina 29902', BEAUFORT)).toBe(false);
    expect(mailingDiffers('PO BOX 1, EXAMPLETON SC 29902', BEAUFORT)).toBe(true);
    expect(mailingDiffers('99 OTHER RD, ELSEWHERE NY 10001', BEAUFORT)).toBe(true);
    expect(mailingDiffers('SEE ATTACHED', BEAUFORT)).toBeNull();
  });
});

describe('parity with the migration and module 50', () => {
  const migration = (() => {
    const f = fs.readdirSync(at('packages/db/migrations/')).find((n: string) => fs.readFileSync(at(`packages/db/migrations/${n}`), 'utf8').includes('CREATE TABLE homeowner_profiles'));
    if (!f) throw new Error('the homeowner migration is missing');
    return fs.readFileSync(at(`packages/db/migrations/${f}`), 'utf8');
  })();

  it('R-HOME-4: the source and parcel_ref patterns equal the migration\'s CHECKs and predict/provider.ts SOURCE_RE and REF_RE', () => {
    expect(migration).toContain(`source              text CHECK (source ~ '${SOURCE_PATTERN}')`);
    expect(migration).toContain(`source       text NOT NULL CHECK (source ~ '${SOURCE_PATTERN}')`);
    expect(migration).toContain(`parcel_ref          text CHECK (parcel_ref ~ '${REF_PATTERN}')`);
    const provider = fs.readFileSync(at('apps/api/src/predict/provider.ts'), 'utf8');
    expect(provider).toContain(`const REF_RE = /${REF_PATTERN}/;`);
    expect(provider).toContain(`const SOURCE_RE = /${SOURCE_PATTERN}/;`);
  });

  it('R-HOME-4 R-HOME-1: the field list and the recognition reasons equal the migration\'s CHECK lists', () => {
    const fields = /field\s+text NOT NULL CHECK \(field IN \(([^)]*)\)\)/.exec(migration)![1]!;
    expect(fields.replace(/\s+/g, '').split(',').map((s) => s.replace(/'/g, ''))).toEqual([...HOMEOWNER_FIELDS]);
    const reasons = /recognized_by <@ ARRAY\[([^\]]*)\]/.exec(migration)![1]!;
    expect(reasons.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...RECOGNITION_REASONS]);
  });
});
