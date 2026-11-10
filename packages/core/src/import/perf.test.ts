// BUILD_PLAN module 6 acceptance: a dry run of 50k fixture rows takes < 10 s in core, and the report
// counts reconcile exactly (source = imported + needs_review + rejected + duplicate).
import { describe, expect, it } from 'vitest';
import type { ContactId } from '../foundation/index.js';
import { buildExistingIndex, commitPlan, dryRun, mapFub, normalizeCsv, parseCsv, reconciles, stageReconciles, suggestMapping } from './index.js';
import { USERS, csvBytes, emptyIndexInput, existingContact } from './testing/fixtures.js';

const N = 50_000;

/**
 * The acceptance bound is 10 s. V8 block coverage (`test:coverage`) slows every function several
 * times over, so under coverage instrumentation only, the bound is widened; plain `pnpm test` (CI's
 * acceptance run) always asserts the real 10 s.
 */
const COVERAGE = (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } }).__vitest_worker__?.config?.coverage?.enabled === true;
const BUDGET_MS = COVERAGE ? 60_000 : 10_000;

function phone(i: number): string {
  // Valid US numbers: area codes 212/415/312/646, exchange 2xx–9xx, line 0000–9999.
  const area = [212, 415, 312, 646][i % 4] as number;
  const exch = 200 + (Math.floor(i / 4) % 700);
  const line = String(Math.floor(i / 2800) % 10000).padStart(4, '0');
  return `(${area}) ${exch}-${line}`;
}

function fubPerson(i: number): unknown {
  return {
    id: 100_000 + i,
    created: '2024-01-01T00:00:00Z',
    firstName: `First${i}`,
    lastName: `Last${i % 977}`,
    stage: ['Lead', 'Nurture', 'Hot Prospect', 'Past Client'][i % 4],
    assignedUserId: i % 3 === 0 ? 11 : 12,
    tags: i % 5 === 0 ? ['Buyer', 'VIP'] : [],
    emails: [{ value: `person${i}@example.com`, type: 'home', status: 'Valid', isPrimary: 1 }],
    phones: i % 50 === 0 ? [{ value: '555-0100', type: 'mobile' }] : [{ value: phone(i), type: 'mobile', status: 'Valid', isPrimary: 1 }],
    customFavorite: `value ${i}`,
    smsOptIn: i % 7 === 0,
  };
}

describe('performance and reconciliation at 50k rows', () => {
  it('a FUB contacts dry run of 50k people against 50k existing contacts takes < 10 s and reconciles exactly', () => {
    const existing = Array.from({ length: N }, (_, i) =>
      existingContact({ contactId: `00000000-0000-7000-9000-${String(i).padStart(12, '0')}` as ContactId, displayName: `Existing ${i}`, emails: i % 10 === 0 ? [`person${i}@example.com`] : [`old${i}@example.org`] }),
    );
    const raws = Array.from({ length: N }, (_, i) => fubPerson(i));
    const t0 = Date.now();
    const idx = buildExistingIndex(emptyIndexInput({ contacts: existing }));
    const records = raws.map((r) => mapFub('contacts', r, USERS));
    const d = dryRun('contacts', records, idx);
    const plan = commitPlan(d, [], d.snapshotSha256, idx);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(d.counts.source).toBe(N);
    expect(stageReconciles(d.counts)).toBe(true);
    expect(plan.ok && reconciles(plan.expected)).toBe(true);
    // Every 10th person matches an existing contact by email and attaches; none is created twice.
    expect(d.records.filter((r) => r.action?.kind === 'attach_contact').length).toBe(N / 10);
    expect(d.counts.needs_review).toBe(N / 50); // the invalid-phone rows
  }, 120_000);

  it('a 50k-row CSV parses, normalizes and dry-runs in < 10 s and reconciles exactly', () => {
    const lines = ['First Name,Last Name,Phone,Email,Tags,Favorite'];
    for (let i = 0; i < N; i++) lines.push(`First${i},"Last, ${i % 977}",${phone(i)},p${i}@example.com,"a,b",x${i}`);
    const bytes = csvBytes(`${lines.join('\r\n')}\r\n`, { bom: true });
    const t0 = Date.now();
    const parsed = parseCsv(bytes, { maxRows: N });
    if ('error' in parsed) throw new Error(parsed.error.code);
    const rows = normalizeCsv(parsed, suggestMapping(parsed.headers), { defaultCountry: 'US' }, 'big.csv');
    const d = dryRun('contacts', rows, buildExistingIndex(emptyIndexInput()));
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(d.counts.source).toBe(N);
    expect(stageReconciles(d.counts)).toBe(true);
  }, 120_000);
});
