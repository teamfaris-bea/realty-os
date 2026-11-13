// The report PDF against real Postgres (R-CMA-9, R-CMA-7, R-MLS-3; E605, E616; VERIFY 3), through the route with the
// fake renderer, and the pdf-lib renderer (dependency N16, pending approval) run on the same fields. Fakes only.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { PdfLibRenderer } from '../providers/integrations/pdf.js';
import { buildReport, pdfFields } from './report.js';
import { type ShareWorld, call, cmaPack, emailSeller, feedLastSyncedAt, localSales, oneTap, shareFrom, sharePreview, shareWorld, withPlatformCmaCleared } from './testing.js';

let h: ApiHarness;
let w: ShareWorld;
let other: ShareWorld;

beforeAll(async () => {
  h = await createApiHarness();
  [w, other] = await Promise.all([shareWorld(h), shareWorld(h)]);
  await Promise.all([localSales(w, 8), localSales(other, 6)]);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const pdf = (client: TestClient, id: string) => client.request('GET', `/api/cma/${id}/report.pdf`);

async function sharedCma(ww: ShareWorld = w) {
  const s = await emailSeller(ww, ww.agents[0]!);
  const tap = await oneTap(ww.agents[0]!, s.c);
  const r = await shareFrom(ww.agents[0]!, (await sharePreview(ww.agents[0]!, tap.body.cma.id)).body.preview);
  expect(r.status).toBe(200);
  return { ...s, id: tap.body.cma.id };
}

describe('E616 R-CMA-9: the report PDF', () => {
  it('E616 (c): two downloads give the same bytes and sha256, each audited with the cma id and the hash only; attachment, nosniff and no-store; no address in the filename', async () => {
    await withPlatformCmaCleared(h, async () => {
      const c = await sharedCma();
      const a = await pdf(agent(), c.id);
      const b = await pdf(agent(), c.id);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(a.headers['content-type']).toBe('application/pdf');
      expect(a.headers['content-disposition']).toBe('attachment; filename="cma.pdf"');
      expect(a.headers['x-content-type-options']).toBe('nosniff');
      expect(a.headers['cache-control']).toBe('no-store');
      expect(a.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(Buffer.compare(a.rawPayload, b.rawPayload)).toBe(0);
      const sha = createHash('sha256').update(a.rawPayload).digest('hex');
      const audits = (await h.su.query("SELECT changes, actor_user_id FROM audit_log WHERE action = 'cma.report_downloaded' AND entity_id = $1 ORDER BY occurred_at", [c.id])).rows;
      expect(audits).toHaveLength(2);
      for (const x of audits) {
        expect(x.changes).toEqual({ cma_id: { from: null, to: c.id }, pdf_sha256: { from: null, to: sha } });
        expect(x.actor_user_id).toBe(agent().userId);
      }
    });
  });

  it('E616 (a): a draft or a superseded CMA has no PDF (404)', async () => {
    const s = await emailSeller(w, agent());
    const tap = await oneTap(agent(), s.c);
    expect((await pdf(agent(), tap.body.cma.id)).statusCode).toBe(404);
    expect((await call(agent(), 'POST', '/cma', { purpose: 'listing_price', contactId: s.c, subject: { kind: 'contact_address', contactAddressId: (await h.su.query('SELECT contact_address_id FROM cma_reports WHERE id = $1', [tap.body.cma.id])).rows[0].contact_address_id } })).status).toBe(201);
    expect((await h.su.query('SELECT status FROM cma_reports WHERE id = $1', [tap.body.cma.id])).rows[0].status).toBe('superseded');
    expect((await pdf(agent(), tap.body.cma.id)).statusCode).toBe(404);
  });

  it('E616 (b) R-CMA-7 R-MLS-3: a shared CMA while the feed is stale now is CMA_NOT_SHAREABLE (FEED_STALE), and so is one whose platform pack is not cleared', async () => {
    const c = await withPlatformCmaCleared(h, () => sharedCma());
    expect(JSON.parse((await pdf(agent(), c.id)).body)).toMatchObject({ error: { code: 'CMA_NOT_SHAREABLE', details: { blockers: ['PLATFORM_NOT_CLEARED'] } } });
    await withPlatformCmaCleared(h, async () => {
      await feedLastSyncedAt(w, new Date(Date.now() - 3 * 86_400_000));
      try {
        const r = await pdf(agent(), c.id);
        // a stale feed's rows do not reach clients either, so its comps are hidden too
        expect([r.statusCode, JSON.parse(r.body).error]).toEqual([409, expect.objectContaining({ code: 'CMA_NOT_SHAREABLE', details: { blockers: ['FEED_STALE', 'COMPS_HIDDEN'] } })]);
      } finally {
        await feedLastSyncedAt(w, new Date());
      }
      expect((await pdf(agent(), c.id)).statusCode).toBe(200);
    });
  });

  it('E605 E616: a state minimum above 28 pt has no PDF prominence (CMA_STATEMENT_NOT_RENDERABLE NO_PROMINENCE)', async () => {
    const c = await withPlatformCmaCleared(h, () => sharedCma());
    await h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [w.mls, JSON.stringify(cmaPack({ valuation: { statements: { CA: { text: 'Statement (fixture).', min_point_size: 30 } } } }))]);
    try {
      await withPlatformCmaCleared(h, async () => {
        const r = await pdf(agent(), c.id);
        expect([r.statusCode, JSON.parse(r.body).error.details]).toEqual([409, { part: 'statement', reason: 'NO_PROMINENCE' }]);
      });
    } finally {
      await h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [w.mls, JSON.stringify(cmaPack())]);
    }
  });

  it('E611 owner question f: role × route against can(): anyone who may view the shared CMA downloads it; another agent, ISA and TC get 404; another tenant\'s id is 404', async () => {
    await withPlatformCmaCleared(h, async () => {
      const c = await sharedCma();
      const roles: { name: string; role: Role; client: TestClient; facts: Record<string, boolean> }[] = [
        { name: 'owner', role: 'owner', client: w.owner, facts: {} },
        { name: 'admin', role: 'admin', client: w.admin, facts: {} },
        { name: 'team lead', role: 'team_lead', client: w.teamLead, facts: { team: true } },
        { name: 'agent (creator)', role: 'agent', client: agent(), facts: { own: true } },
        { name: 'agent (not theirs)', role: 'agent', client: w.agents[1]!, facts: {} },
        { name: 'isa', role: 'isa', client: w.isa, facts: {} },
        { name: 'tc', role: 'tc', client: w.tc, facts: {} },
      ];
      for (const r of roles) {
        const allowed = can(r.client.actor(), 'cma.share', { tenantId: r.client.actor().tenantId, ...r.facts }).ok;
        expect([r.name, (await pdf(r.client, c.id)).statusCode]).toEqual([r.name, allowed ? 200 : 404]);
      }
      const theirs = await sharedCma(other);
      expect((await pdf(w.owner, theirs.id)).statusCode).toBe(404);
    });
  });
});

describe('VERIFY 3: pdf-lib (N16) on the report fields', () => {
  const input = (min: number) => ({
    subjectAddress: '100 Sample Avenue, Oakland',
    lowCents: 50_000_000,
    highCents: 56_000_000,
    estimateSentence: 'This is an estimate, not an appraisal.',
    agentName: 'Alex Agent',
    brokerageName: 'Sample Brokerage (test)',
    statements: [{ text: 'Statement at its size (fixture).', minPointSize: min }],
    attributions: ['Attribution (fixture).'],
    disclaimers: ['Disclaimer (fixture).'],
    asOfSentence: 'MLS data as of Nov 12, 2026, 9:00 AM.',
    comps: [],
    purpose: 'listing_price' as const,
    inspection: 'none' as const,
    inspectedOn: null,
    disclosure: { intendedUsers: null, agentInterest: null, conflicts: null, valueDefinition: null, limitingConditions: null },
    notes: '“Curly” – folded in print.',
  });

  it('E616 R-CMA-9: the same fields render the same bytes twice (fixed dates, no object streams)', async () => {
    const r = new PdfLibRenderer();
    const fields = pdfFields(buildReport(input(10)).blocks);
    const [a, b] = [await r.renderPdf({ templateKey: 'cma/1', fields, imageCount: 0 }), await r.renderPdf({ templateKey: 'cma/1', fields, imageCount: 0 })];
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(a.sha256).toBe(b.sha256);
  });

  it('E605 VERIFY 3: a 14 pt state minimum is set at 18 pt (heading) in the PDF; asserted on the fields, and on the bytes when the content stream is readable', async () => {
    const fields = pdfFields(buildReport(input(14)).blocks);
    const key = Object.keys(fields).find((k) => k.includes(':statement:'))!;
    expect(key).toBe('004:statement:heading');
    const raw = Buffer.from((await new PdfLibRenderer().renderPdf({ templateKey: 'cma/1', fields, imageCount: 0 })).bytes);
    // VERIFY 3: pdf-lib 1.17.1 compresses content streams (FlateDecode); inflate each to read the drawing operators
    const text = raw.toString('latin1');
    const streams: string[] = [];
    for (const m of text.matchAll(/stream\r?\n/g)) {
      const from = m.index! + m[0].length;
      const to = text.indexOf('endstream', from);
      try {
        streams.push(inflateSync(raw.subarray(from, to)).toString('latin1'));
      } catch {
        streams.push(text.slice(from, to));
      }
    }
    const content = streams.join('\n');
    // the standard fonts' text is written as hex strings of the WinAnsi bytes
    const hex = Buffer.from('Statement at its size (fixture).', 'latin1').toString('hex').toUpperCase();
    const at = content.toUpperCase().indexOf(hex);
    expect(at).toBeGreaterThan(0);
    expect(content.slice(Math.max(0, at - 120), at)).toMatch(/ 18 Tf/);
    // and the curly quotes and dash of the notes were folded (rule 5), never turned into '?'
    expect(content.toUpperCase()).toContain(Buffer.from('"Curly" - folded in print.', 'latin1').toString('hex').toUpperCase());
  });
});

