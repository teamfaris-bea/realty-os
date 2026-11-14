// The AI ISA comps email under V2-A's real statement rules (batch 16; R-ISA-18, R-CMA-9 "Statements"; E536, E604,
// E605). cmaSeam.ts connects cma/statement.ts (the batch 15 seam refused every statement, so no recent-sales email could
// be built). The pure part pins the seam to V2-A's own share-email refusal (cma/report.ts refusalFor(…, 'email')); the
// rest runs on real Postgres through the API harness with fakes only, packs cleared only in this test's database, in
// try/finally. Nothing real is sent: AI_ISA_LIVE_SENDS, TELEPHONY_LIVE_REQUESTS and MLS_LIVE_CALLS stay false, and the
// dark tests prove that with the packs uncleared, or with AI_ISA_LIVE_SENDS false on a real adapter, nothing goes out.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { ESTIMATE_SENTENCE } from '../../cma/gates.js';
import { type ReportInput, buildReport, refusalFor } from '../../cma/report.js';
import { TEST_STATEMENT, localSales } from '../../cma/testing.js';
import { suFixture } from '../../leads/testing.js';
import { TEST_ATTRIBUTION, TEST_DISCLAIMER } from '../../mls/testing.js';
import type { FakeEmail } from '../../providers/fake/email.js';
import { aiIsaLiveOff } from '../../comms/runtime.js';
import { call, grantInitiated, initiatedDayNow, openZone, runIsa } from '../testing.js';
import { EMAIL_MAX_STATEMENT_POINT_SIZE, type LicenceStatement, type StatementRendering, emailStatementRendering } from './cmaSeam.js';
import { buildCompsInTx } from './comps.js';
import { sellerFactsCurrentInTx } from './index.js';
import { type SellerLead, type SellerWorld, asSystem, confirm, nowInstant, queueFactsAs, secondFeed, sellerLead, sellerWorld, withSellerPacksCleared } from './testing.js';

// ---- pure: the seam against V2-A's share email ---------------------------------------------------------------------

const report = (i: { statements: readonly LicenceStatement[]; attributions: readonly string[]; disclaimers: readonly string[] }): ReportInput => ({
  subjectAddress: '100 Sample Avenue, Oakland',
  lowCents: 50_000_000,
  highCents: 56_000_000,
  estimateSentence: ESTIMATE_SENTENCE,
  agentName: 'Alex Agent',
  brokerageName: 'Test Brokerage LLC',
  statements: i.statements,
  attributions: i.attributions,
  disclaimers: i.disclaimers,
  asOfSentence: 'MLS data as of Nov 12, 2026, 9:00 AM.',
  comps: [],
  purpose: 'listing_price',
  inspection: 'none',
  inspectedOn: null,
  disclosure: { intendedUsers: null, agentInterest: null, conflicts: null, valueDefinition: null, limitingConditions: null },
  notes: null,
});

/** V2-A's verdict for an email (share.ts: refusalFor(report, 'email') throws CMA_STATEMENT_NOT_RENDERABLE), in the seam's shape. */
function v2a(i: Parameters<typeof emailStatementRendering>[0]): StatementRendering {
  const r = buildReport(report(i));
  const refusal = refusalFor(r, 'email');
  if (refusal !== null) {
    return refusal.reason === 'EMAIL_TYPE_SIZE'
      ? { ok: false, code: 'EMAIL_TYPE_SIZE', part: refusal.part }
      : { ok: false, code: 'CMA_STATEMENT_NOT_RENDERABLE', part: refusal.part, codePoints: refusal.codePoints! };
  }
  const of = (role: string) => r.blocks.filter((b) => b.role === role);
  return {
    ok: true,
    statements: of('statement').map((b, k) => ({ text: b.text, minPointSize: r.statementMins[k]!, prominence: b.prominence, pointSize: ({ display: 28, heading: 18, body: 12 } as Record<string, number>)[b.prominence]! })),
    attributions: of('attribution').map((b) => b.text),
    disclaimers: of('disclaimer').map((b) => b.text),
  };
}

const st = (text: string, minPointSize = 10): LicenceStatement => ({ text, minPointSize });
const ok = { attributions: [TEST_ATTRIBUTION], disclaimers: [TEST_DISCLAIMER] };

describe('R-CMA-9 R-ISA-18 (batch 16): the seam is V2-A\'s share-email statement rules, exactly', () => {
  it('E604 E605 R-CMA-9: the seam gives V2-A\'s verdict on each case: printable, the strictest minimum per text, at most 12 pt by email, the prominence, then the attribution and disclaimer', () => {
    const cases: Parameters<typeof emailStatementRendering>[0][] = [
      { statements: [st(TEST_STATEMENT)], ...ok },
      { statements: [st(TEST_STATEMENT, 12)], ...ok },
      { statements: [st(TEST_STATEMENT, 6)], ...ok },
      ...[12.5, 14, 18, 30, 36, Number.NaN].map((m) => ({ statements: [st(TEST_STATEMENT, m)], ...ok })),
      // E604 (a): refused, naming the code points; (b) folded in the PDF, unchanged (NFC, LF) in the email
      ...['Valuation™ statement.', 'A • B.', 'Wait…', 'Area m²', 'Home 🏠', 'Tab\there', 'Lone\rCR', 'Đ'].map((t) => ({ statements: [st(t)], ...ok })),
      { statements: [st('The “estimate” – it’s not an appraisal — see below.\r\nNext line.')], ...ok },
      { statements: [st('Café statement.')], ...ok },
      // one statement per text, with the strictest minimum of those that share it (two feeds of one state)
      { statements: [st(TEST_STATEMENT, 10), st(TEST_STATEMENT, 12)], ...ok },
      { statements: [st(TEST_STATEMENT, 10), st(`  ${TEST_STATEMENT}  `, 14)], ...ok },
      { statements: [st(TEST_STATEMENT), st('Second feed statement (test).', 11)], ...ok },
      { statements: [st(TEST_STATEMENT), st('Second ™ statement.')], ...ok },
      // the order of the refusals: a substituted statement, then the email size, then an attribution, then a disclaimer
      { statements: [st('Valuation™ statement.', 14)], ...ok },
      { statements: [st(TEST_STATEMENT, 14)], attributions: ['Attribution • (test).'], disclaimers: [TEST_DISCLAIMER] },
      { statements: [st(TEST_STATEMENT)], attributions: ['Attribution • (test).'], disclaimers: [TEST_DISCLAIMER] },
      { statements: [st(TEST_STATEMENT)], attributions: [TEST_ATTRIBUTION], disclaimers: ['Disclaimer… (test).'] },
      { statements: [st(TEST_STATEMENT)], attributions: ['Attribution • (test).'], disclaimers: ['Disclaimer… (test).'] },
      { statements: [st(TEST_STATEMENT)], attributions: [TEST_ATTRIBUTION, TEST_ATTRIBUTION, ' '], disclaimers: [TEST_DISCLAIMER, `${TEST_DISCLAIMER}\r\n`] },
      { statements: [], attributions: [], disclaimers: [] },
    ];
    for (const c of cases) expect([c, emailStatementRendering(c)]).toEqual([c, v2a(c)]);
    // the rules' own constants: a plain-text email carries 12 pt at most, and an emailable statement is set at body
    expect(EMAIL_MAX_STATEMENT_POINT_SIZE).toBe(12);
    expect(emailStatementRendering({ statements: [st(TEST_STATEMENT, 12)], ...ok })).toMatchObject({ ok: true, statements: [{ prominence: 'body', pointSize: 12 }] });
    expect(emailStatementRendering({ statements: [st(TEST_STATEMENT, 12.5)], ...ok })).toEqual({ ok: false, code: 'EMAIL_TYPE_SIZE', part: 'statement' });
    expect(emailStatementRendering({ statements: [st('Valuation™ statement.')], ...ok })).toEqual({ ok: false, code: 'CMA_STATEMENT_NOT_RENDERABLE', part: 'statement', codePoints: ['U+2122'] });
  });

  it('R-CMA-9 (property): for any statements, minimums, attributions and disclaimers the seam and V2-A\'s share email agree', () => {
    const piece = fc.constantFrom('Not an appraisal', ' ', '.', 'é', 'é', '“', '”', '’', '–', '—', ' ', '\r\n', '\n', '™', '•', '…', '²', '🏠', '\t', '\r', 'Đ', 'ﬁ');
    const text = fc.array(piece, { minLength: 0, maxLength: 6 }).map((xs) => xs.join(''));
    const min = fc.constantFrom(6, 8, 10, 11.5, 12, 12.01, 12.5, 14, 18, 18.5, 28, 30, 36, Number.NaN);
    const input = fc.record({
      statements: fc.array(fc.record({ text, minPointSize: min }), { maxLength: 4 }),
      attributions: fc.array(text, { maxLength: 3 }),
      disclaimers: fc.array(text, { maxLength: 3 }),
    });
    fc.assert(fc.property(input, (i) => {
      expect(emailStatementRendering(i)).toEqual(v2a(i));
    }), { numRuns: 2000, seed: 16 });
  });
});

// ---- the comps email on real rows ----------------------------------------------------------------------------------

let h: ApiHarness;
let w: SellerWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
});
afterAll(async () => {
  await h?.close();
});

const build = (l: SellerLead) => asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant()));
const setStatement = (o: { text?: string; min?: number }) =>
  h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,statements,CA}', $2::jsonb) WHERE id = $1`, [w.mls, JSON.stringify({ text: o.text ?? TEST_STATEMENT, min_point_size: o.min ?? 10 })]);
const setPackText = (key: 'attribution_text' | 'disclaimer_text', t: string) => h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, $2::text[], to_jsonb($3::text)) WHERE id = $1`, [w.mls, [key], t]);
/** Runs `fn` with the feed's statement (and optionally its attribution) changed, restoring the fixture pack after. */
async function withPack<T>(o: { text?: string; min?: number; attribution?: string }, fn: () => Promise<T>): Promise<T> {
  await setStatement(o);
  if (o.attribution !== undefined) await setPackText('attribution_text', o.attribution);
  try {
    return await fn();
  } finally {
    await setStatement({});
    await setPackText('attribution_text', TEST_ATTRIBUTION);
  }
}
const assistantMessages = async (contactId: string) =>
  (await h.su.query<{ id: string; status: string; status_reason: string | null; channel: string; body: string }>(`SELECT id, status, status_reason, channel, body FROM messages WHERE contact_id = $1 AND initiator = 'assistant' ORDER BY created_at`, [contactId])).rows;
const soldFacts = async (contactId: string) => (await h.su.query<{ status: string; message_id: string | null }>(`SELECT status, message_id FROM ai_isa_shared_facts WHERE contact_id = $1 AND fact_kind = 'sold_comp_set'`, [contactId])).rows;
const lastCheck = async (l: SellerLead) => (await h.su.query<{ c: { codes: string[] } | null }>(`SELECT last_comps_check AS c FROM ai_isa_seller_watch WHERE assignment_id = $1`, [l.assignmentId])).rows[0]!.c;

async function confirmedLead(): Promise<SellerLead> {
  const l = await sellerLead(h, w);
  expect((await confirm(w, l)).status).toBe(200);
  return l;
}

describe('E536 R-ISA-18 (batch 16): with the packs and the licence recorded, a comps email is built with the licence\'s statement', () => {
  it('E536 R-ISA-18 R-CMA-9: the email carries the feed\'s statement for the subject\'s state once, after the seller-data lines, with the attribution and disclaimer; H2 queues it by email', async () => {
    const l = await confirmedLead();
    const r = await withSellerPacksCleared(h, () => build(l));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const body = (r as Extract<typeof r, { ok: true }>).body;
    const lines = body.split('\n\n');
    expect(lines.filter((x) => x === TEST_STATEMENT)).toHaveLength(1);
    const at = lines.indexOf(TEST_STATEMENT);
    expect(lines[at - 1]).toBe('Only sales the MLS allows us to show are included.');
    expect(lines[at + 1]).toMatch(/^Source: Test MLS feed via .+, as of /);
    expect(lines.slice(at + 2)).toEqual([TEST_ATTRIBUTION, TEST_DISCLAIMER]);
    expect((await lastCheck(l))!.codes).toEqual([]);
    // the H2 path (ISA-2's queue, TX-B) builds the same email with no test double
    const id = await withSellerPacksCleared(h, () => queueFactsAs(h, w, l, ['comps']));
    expect(id).not.toBeNull();
    const m = (await assistantMessages(l.id)).find((x) => x.id === id)!;
    expect(m.channel).toBe('email');
    expect(m.body).toContain(`\n\n${TEST_STATEMENT}\n\n`);
    expect((await soldFacts(l.id)).length).toBeGreaterThanOrEqual(3);
  });

  it('E604 (b) R-CMA-9: curly quotes, dashes, NBSP, CRLF and a decomposed accent are allowed and go out as V2-A sends them (NFC, LF); a 12 pt minimum is carried', async () => {
    const l = await confirmedLead();
    const raw = 'The “estimate” – it’s not an appraisal — Café\r\nsee below (test statement).';
    const r = await withPack({ text: raw, min: 12 }, () => withSellerPacksCleared(h, () => build(l)));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const body = (r as { body: string }).body;
    expect(body).toContain('\n\nThe “estimate” – it’s not an appraisal — Café\nsee below (test statement).\n\n');
    expect(body).not.toContain('\r');
  });
});

describe('E604 E605 R-ISA-18 (batch 16): statements V2-A refuses are still refused, with its code', () => {
  it('E604 (a): a statement the PDF would substitute (™, •, …, an emoji, a tab) is CMA_STATEMENT_NOT_RENDERABLE, and H2 queues nothing', async () => {
    const l = await confirmedLead();
    for (const text of ['Valuation statement™ (test).', 'Valuation • statement (test).', 'Valuation statement… (test).', 'Valuation statement 🏠 (test).', 'Valuation\tstatement (test).']) {
      expect([text, await withPack({ text }, () => withSellerPacksCleared(h, () => build(l)))]).toEqual([text, { ok: false, codes: ['CMA_STATEMENT_NOT_RENDERABLE'] }]);
      expect((await lastCheck(l))!.codes).toEqual(['CMA_STATEMENT_NOT_RENDERABLE']);
    }
    expect(await withPack({ text: 'Valuation statement™ (test).' }, () => withSellerPacksCleared(h, () => queueFactsAs(h, w, l, ['comps'])))).toBeNull();
    expect(await assistantMessages(l.id)).toEqual([]);
    expect(await soldFacts(l.id)).toEqual([]);
  });

  it('E605: a state minimum above 12 pt (12.5, 14, 30) is EMAIL_TYPE_SIZE, even for a printable statement; exactly 12 is carried', async () => {
    const l = await confirmedLead();
    for (const min of [12.5, 14, 30]) {
      expect([min, await withPack({ min }, () => withSellerPacksCleared(h, () => build(l)))]).toEqual([min, { ok: false, codes: ['EMAIL_TYPE_SIZE'] }]);
    }
    expect(await withPack({ min: 14 }, () => withSellerPacksCleared(h, () => queueFactsAs(h, w, l, ['comps'])))).toBeNull();
    expect(await assistantMessages(l.id)).toEqual([]);
    expect((await withPack({ min: 12 }, () => withSellerPacksCleared(h, () => build(l)))).ok).toBe(true);
    // a statement that would be substituted is refused for that before its size (refusalFor's order)
    expect(await withPack({ text: 'Valuation statement™ (test).', min: 14 }, () => withSellerPacksCleared(h, () => build(l)))).toEqual({ ok: false, codes: ['CMA_STATEMENT_NOT_RENDERABLE'] });
  });

  it('R-CMA-9 (as V2-A\'s share email): an attribution the PDF would substitute is CMA_STATEMENT_NOT_RENDERABLE', async () => {
    const l = await confirmedLead();
    expect(await withPack({ attribution: 'Listing information • the regional MLS (test attribution).' }, () => withSellerPacksCleared(h, () => build(l)))).toEqual({ ok: false, codes: ['CMA_STATEMENT_NOT_RENDERABLE'] });
  });
});

describe('B16S-2 R-ISA-18 E537 (batch 16): dispatch TX1 (H3) re-checks the queued valuation statement against the licence\'s current one', () => {
  const rerenders = async (messageId: string) => Number((await h.su.query<{ n: string }>(`SELECT count(*) AS n FROM jobs WHERE kind = 'ai_isa.seller_rerender' AND payload ->> 'messageId' = $1`, [messageId])).rows[0]!.n);

  it('B16S-2: a comps email queued with the feed\'s statement is refused at H3 with VALUATION_STATEMENT_CHANGED once the licence\'s statement for the state is replaced by another printable text of 12 pt or less, as a changed price is, with one re-render; the statement as queued passes', async () => {
    const l = await confirmedLead();
    const id = await withSellerPacksCleared(h, () => queueFactsAs(h, w, l, ['comps']));
    expect(id).not.toBeNull();
    const h3 = () => withSellerPacksCleared(h, () => asSystem(h, w, l, (tx, _a, actor) => sellerFactsCurrentInTx(tx, actor, id!, nowInstant())));
    expect(await h3()).toEqual({ codes: [], licenceOk: true });
    for (const o of [{ text: 'A replacement valuation statement (test).', min: 12 }, { text: `${TEST_STATEMENT} Updated.`, min: 10 }]) {
      // the replacement is one the rules accept, so only the comparison with the queued email can catch it
      const fresh = await withPack(o, () => withSellerPacksCleared(h, () => build(l)));
      expect([o, fresh.ok]).toEqual([o, true]);
      expect([o, await withPack(o, () => h3())]).toEqual([o, { codes: ['VALUATION_STATEMENT_CHANGED'], licenceOk: true }]);
    }
    expect(await rerenders(id!)).toBe(1); // E537: one model-free re-render per turn, never a loop
    // the licence's statement back as queued: nothing changed under the message
    expect(await h3()).toEqual({ codes: [], licenceOk: true });
    expect((await h.su.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [id])).rows[0]!.body).toContain(`\n\n${TEST_STATEMENT}\n\nSource: `);
  });
});

describe('B16S-3 R-MLS-2 R-CMA-7 R-CMA-9 (batch 16): the comps email carries the parts of every feed readiness judged, as V2-A\'s report does', () => {
  const SUBJECT_ATTRIBUTION = 'Listing information from the second regional MLS (test attribution).';
  const SUBJECT_DISCLAIMER = 'Second MLS: information deemed reliable but not guaranteed (test disclaimer).';
  const SUBJECT_STATEMENT = 'Second feed valuation statement (fixture text, not legal wording).';

  it('B16S-3: with the subject\'s record on a second feed and every comp on the first, the email carries both feeds\' statements, attributions and disclaimers once each and names both feeds; H3 then refuses it when the second feed\'s attribution or statement changes', async () => {
    // a world of its own: the second feed would otherwise join the footer of every email in this file
    const w2 = await sellerWorld(h);
    const mls2 = await secondFeed(h, w2, { attribution: SUBJECT_ATTRIBUTION, disclaimer: SUBJECT_DISCLAIMER });
    await h.su.query(`UPDATE integration_connections SET display_name = 'Second MLS feed (test)', license_pack = jsonb_set(license_pack, '{valuation,statements,CA}', $2::jsonb) WHERE id = $1`,
      [mls2, JSON.stringify({ text: SUBJECT_STATEMENT, min_point_size: 10 })]);
    // the home's own MLS record (the subject line's beds, size and record date) is on feed 2; the comparable sales on feed 1
    const l = await sellerLead(h, { ...w2, mls: mls2 }, { comps: 0 });
    await localSales({ h, tenantId: w2.tenantId, mls: w2.mls }, 8);
    expect((await confirm(w2, l)).status).toBe(200);
    expect((await h.su.query<{ c: string }>('SELECT mls_connection_id AS c FROM listings WHERE id = $1', [l.recordId])).rows[0]!.c).toBe(mls2);

    const r = await withSellerPacksCleared(h, () => asSystem(h, w2, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant())));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const built = r as Extract<typeof r, { ok: true }>;
    expect([...new Set(built.pendingFacts.map((f) => f.connectionId))]).toEqual([w2.mls]);
    const blocks = built.body.split('\n\n');
    expect(blocks[1]).toMatch(/^Compared using your home's MLS record from /);
    for (const t of [TEST_STATEMENT, SUBJECT_STATEMENT, TEST_ATTRIBUTION, TEST_DISCLAIMER, SUBJECT_ATTRIBUTION, SUBJECT_DISCLAIMER]) expect([t, blocks.filter((x) => x === t).length]).toEqual([t, 1]);
    // the statements sit after the seller-data lines and before the source line; the feed texts after it
    const source = blocks.findIndex((x) => x.startsWith('Source: '));
    expect(blocks.slice(source - 2, source).sort()).toEqual([SUBJECT_STATEMENT, TEST_STATEMENT].sort());
    expect(blocks.slice(source + 1).sort()).toEqual([SUBJECT_ATTRIBUTION, SUBJECT_DISCLAIMER, TEST_ATTRIBUTION, TEST_DISCLAIMER].sort());
    expect(blocks[source]).toContain('Test MLS feed');
    expect(blocks[source]).toContain('Second MLS feed (test)');

    // queued, then the subject feed's own texts change while it waits (no comp is on that feed): H3 refuses it
    const id = await withSellerPacksCleared(h, () => queueFactsAs(h, w2, l, ['comps']));
    expect(id).not.toBeNull();
    const h3 = () => withSellerPacksCleared(h, () => asSystem(h, w2, l, (tx, _a, actor) => sellerFactsCurrentInTx(tx, actor, id!, nowInstant())));
    expect(await h3()).toEqual({ codes: [], licenceOk: true });
    const setPack = (key: string, value: string) => h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, $2::text[], to_jsonb($3::text)) WHERE id = $1`, [mls2, [key], value]);
    try {
      await setPack('attribution_text', 'Listing information from the second regional MLS, reworded (test attribution).');
      expect(await h3()).toEqual({ codes: ['FACT_CHANGED'], licenceOk: true });
    } finally {
      await setPack('attribution_text', SUBJECT_ATTRIBUTION);
    }
    expect(await h3()).toEqual({ codes: [], licenceOk: true });
    try {
      await h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,statements,CA}', $2::jsonb) WHERE id = $1`, [mls2, JSON.stringify({ text: 'Second feed valuation statement, replaced (test).', min_point_size: 10 })]);
      expect(await h3()).toEqual({ codes: ['VALUATION_STATEMENT_CHANGED'], licenceOk: true });
    } finally {
      await h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{valuation,statements,CA}', $2::jsonb) WHERE id = $1`, [mls2, JSON.stringify({ text: SUBJECT_STATEMENT, min_point_size: 10 })]);
    }
  });
});

describe('D9 D12 R-ISA-18 R-ISA-25 (batch 16): the recent-sales emails stay dark', () => {
  it('E534: with the packs uncleared (both, or either one alone) no comps email is built or queued, and no sold fact is written, with the statement rules connected', async () => {
    const l = await confirmedLead();
    expect(await build(l)).toEqual({ ok: false, codes: ['PLATFORM_NOT_CLEARED'] });
    expect(await queueFactsAs(h, w, l, ['comps'])).toBeNull();
    for (const keys of [['platform:cma'], ['platform:ai_isa_seller_data'], ['platform:avm', 'platform:ai_isa_seller_data']]) {
      expect([keys, await withSellerPacksCleared(h, () => build(l), keys)]).toEqual([keys, { ok: false, codes: ['PLATFORM_NOT_CLEARED'] }]);
      expect(await withSellerPacksCleared(h, () => queueFactsAs(h, w, l, ['comps']), keys)).toBeNull();
    }
    expect(await assistantMessages(l.id)).toEqual([]);
    expect(await soldFacts(l.id)).toEqual([]);
    // the packs ship unreviewed: nothing in this database recorded a review outside withSellerPacksCleared
    const packs = (await h.su.query<{ key: string; reviewed: Date | null }>(`SELECT key, reviewed_by_counsel_at AS reviewed FROM jurisdiction_packs WHERE key IN ('platform:cma', 'platform:ai_isa_seller_data') AND status = 'published' ORDER BY key`)).rows;
    expect(packs).toEqual([{ key: 'platform:ai_isa_seller_data', reviewed: null }, { key: 'platform:cma', reviewed: null }]);
  });

  it('R-ISA-25 E517 R-ISA-18: a comps email queued with the packs cleared never reaches the provider: not with the packs uncleared at send (ISA_SELLER_DATA_NOT_CLEARED in dispatch TX1), and not with AI_ISA_LIVE_SENDS false on a real email adapter, where it passes every other check and the live-sends hold alone refuses it (AI_ISA_LIVE_OFF; B16S-4)', () =>
    initiatedDayNow(h, w.tenantId, openZone(), async () => {
      const cfg = h.app.platform.config as { providers: { telephony: string; email: string }; aiIsaLiveSends: boolean };
      expect(cfg.aiIsaLiveSends).toBe(false);
      // a verified sending domain (the fake's verification, through the route) under the team identity the assistant
      // sends from, and the brokerage's postal address: a marketing email needs both (R-PAR-39, R-GATE-12), so neither
      // is what holds the email below
      const fake = h.providers.email as unknown as FakeEmail;
      fake.verifiedDomains.add('mail.seller-statement.test');
      const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.seller-statement.test' });
      expect((await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`)).status).toBe(200);
      await h.su.query(`UPDATE email_identities SET domain_id = $2, from_address = 'team@mail.seller-statement.test' WHERE tenant_id = $1 AND user_id IS NULL`, [w.tenantId, dom.body.domain.id]);
      await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Sample St, Oakland, CA 94110' WHERE tenant_id = $1", values: [w.tenantId] }]);
      const providerCalls = (messageId: string) => fake.sent.filter((x) => x.idempotencyKey === messageId);
      /** A live seller under care with its consent, and a comps email queued for it with the packs cleared. */
      const queued = async (): Promise<string> => {
        const l = await sellerLead(h, w);
        await grantInitiated(h, w.tenantId, l);
        expect((await confirm(w, l)).status).toBe(200);
        await runIsa(h, w.tenantId);
        // the start turn's messages two days back (the guard spaces AI messages and caps initiated ones per day)
        await h.su.query(`UPDATE messages SET created_at = created_at - interval '2 days', dispatched_at = dispatched_at - interval '2 days' WHERE contact_id = $1 AND initiator = 'assistant'`, [l.id]);
        const id = await withSellerPacksCleared(h, () => queueFactsAs(h, w, l, ['comps']));
        expect(id).not.toBeNull();
        expect((await h.su.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [id])).rows[0]!.body).toContain(`\n\n${TEST_STATEMENT}\n\n`);
        return id!;
      };
      const outcome = async (id: string) => ({
        status: (await h.su.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [id])).rows[0]!.status,
        reasons: (await h.su.query<{ r: string[] }>(`SELECT reason_codes AS r FROM gate_decisions WHERE message_id = $1 AND outcome = 'deny'`, [id])).rows.flatMap((x) => x.r),
      });

      // the packs uncleared at send: dispatch TX1 re-checks the seller facts against the packs (R-ISA-18, H3)
      const a = await queued();
      await runIsa(h, w.tenantId, 2);
      const oa = await outcome(a);
      expect(oa.status).toBe('blocked');
      expect(oa.reasons).toContain('ISA_SELLER_DATA_NOT_CLEARED');
      expect(providerCalls(a)).toEqual([]);

      // AI_ISA_LIVE_SENDS false with a non-fake email adapter (R-ISA-25), the packs cleared at send: no provider call.
      // The live-sends hold is the last check of an otherwise allowed AI message (dispatch.ts). Until batch 16 check 4
      // refused every AI email first (UNSUBSCRIBE_MISSING), so this case could not tell whether the hold worked (B16S-4);
      // now the email carries the unsubscribe line and the postal address, passes every other check, and is held by
      // AI_ISA_LIVE_OFF alone (the same email on the fake adapter goes out: unsubscribe.test.ts).
      const b = await queued();
      const saved = cfg.providers.email;
      cfg.providers.email = 'smtp';
      try {
        expect(aiIsaLiveOff(cfg).email).toBe(true);
        await withSellerPacksCleared(h, () => runIsa(h, w.tenantId, 2));
      } finally {
        cfg.providers.email = saved;
      }
      const ob = await outcome(b);
      expect(ob.reasons).toEqual(['AI_ISA_LIVE_OFF']);
      expect(ob.status).toBe('blocked');
      expect(providerCalls(b)).toEqual([]);
      expect(fake.sent.filter((x) => String(x.text).includes(TEST_STATEMENT))).toEqual([]);
    }));
});
