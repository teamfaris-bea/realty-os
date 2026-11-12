// The client report, pure (R-CMA-9 rule 4 and 5; R-CMA-4, R-AVM-1, R-MLS-2; E604, E605, E614, E615, E617, E619). The
// share and PDF tests (share.test.ts, pdf.test.ts) run the same builder on real rows.
import type { DisplayListing } from '@realty/core/listings';
import { describe, expect, it } from 'vitest';
import { ESTIMATE_SENTENCE } from './gates.js';
import { CHECK_WORDING, REPORT_MAX_EMAIL_CHARS, type ReportInput, buildReport, dayText, emailText, longestParts, pdfFields, refusalFor, reportSha256 } from './report.js';

const rendering = (o: Partial<DisplayListing> = {}): DisplayListing => ({
  audience: 'client',
  id: null,
  source: 'mls',
  sourceLabel: 'MLS',
  isTeamListing: false,
  listingBrokerageName: 'Other Brokerage (test)',
  attribution: 'Listing data courtesy of the Test MLS (fixture).',
  disclaimer: 'Test disclaimer (fixture).',
  addressHidden: false,
  omittedFields: [],
  status: 'sold',
  beds: 3,
  bathsX10: 25,
  sqft: 1500,
  address: { line1: '201 Sample Ave', line2: null },
  locality: { city: 'Oakland', region: 'CA', postalCode: '94110' },
  closePriceCents: 52_500_000,
  closeDate: '2026-08-03',
  // fields that must never reach the report even when the rendering carries them
  listPriceCents: 49_900_000,
  description: 'Remarks text that must not appear',
  photos: [{ url: 'https://photos.example.test/1.jpg', position: 0 } as never],
  ...o,
});

const input = (o: Partial<ReportInput> = {}): ReportInput => ({
  subjectAddress: '100 Sample Avenue, Oakland',
  lowCents: 50_000_000,
  highCents: 56_000_000,
  estimateSentence: ESTIMATE_SENTENCE,
  agentName: 'Alex Agent',
  brokerageName: 'Test Brokerage LLC',
  statements: [{ text: 'Test valuation statement (fixture text, not legal wording).', minPointSize: 10 }],
  attributions: ['Listing data courtesy of the Test MLS (fixture).'],
  disclaimers: ['Test disclaimer (fixture).'],
  asOfSentence: 'MLS data as of Nov 12, 2026, 9:00 AM.',
  comps: [
    { rendering: rendering(), distanceM: 640, tier: 'within_1mi', adjustedPriceCents: 53_100_000, adjustments: [{ feature: 'size', amountCents: 600_000 }, { feature: 'time', amountCents: -12_345 }] },
    { rendering: rendering({ addressHidden: true, address: undefined, closePriceCents: 51_000_000 }), distanceM: null, tier: 'postal_code', adjustedPriceCents: 51_000_000, adjustments: [] },
  ],
  purpose: 'listing_price',
  inspection: 'none',
  inspectedOn: null,
  disclosure: { intendedUsers: null, agentInterest: null, conflicts: null, valueDefinition: null, limitingConditions: null },
  notes: null,
  ...o,
});

describe('R-CMA-9 rule 4: the report carries exactly its parts', () => {
  it('E614 E617 R-CMA-4 R-AVM-1: range and estimate sentence, provider, statement, comps (client fields only), as-of, inspection, attribution and disclaimer, in order', () => {
    const r = buildReport(input());
    expect(r.blocks.map((b) => b.role)).toEqual(['title', 'range', 'estimate', 'provider', 'statement', 'comp', 'comp', 'as_of', 'inspection', 'attribution', 'disclaimer']);
    expect(r.blocks[1]!.text).toBe('Estimated value range: $500,000 to $560,000');
    expect(r.blocks[2]!.text).toBe('This is an estimate, not an appraisal.');
    expect(r.blocks[3]!.text).toBe('Prepared by Alex Agent, Test Brokerage LLC, from MLS sales');
    expect(r.blocks[5]!.text).toBe(
      ['Sold: 201 Sample Ave, Oakland', 'Sold for $525,000 on Aug 3, 2026', '3 beds, 2.5 baths, 1,500 sq ft', '0.4 mi; within 1 mile; listed by Other Brokerage (test)', 'Adjusted price: $531,000', '  Size: +$6,000', '  Market change: -$123'].join('\n'),
    );
    // E617: a comp whose street is hidden for clients shows its locality only
    expect(r.blocks[6]!.text.split('\n').slice(0, 1)).toEqual(['Sold: Oakland, CA 94110']);
    expect(r.blocks[6]!.text).toContain('distance not known; same ZIP code');
    expect(r.subject).toBe('Home value estimate for 100 Sample Avenue, Oakland');
    const text = emailText(r.blocks);
    for (const never of ['$499,000', 'Remarks text', 'photos.example', 'weight', 'Weight', 'back-test', 'missed the price', 'rate', 'Not used', 'For context', '$530,000']) expect([never, text.includes(never)]).toEqual([never, false]);
    expect(text).not.toMatch(/confiden|probab|accura|score|likel/i);
  });

  it('E606 R-CMA-9: SoP items only for purpose other; an inspection line with its date; notes last before attribution', () => {
    const d = { intendedUsers: 'The seller', agentInterest: 'Listing agent', conflicts: 'None', valueDefinition: 'Market value', limitingConditions: 'No interior access' };
    const r = buildReport(input({ purpose: 'other', disclosure: d, inspection: 'exterior', inspectedOn: '2026-11-02', notes: 'Fresh paint.' }));
    expect(r.blocks.map((b) => b.role).slice(7)).toEqual(['as_of', 'inspection', 'sop', 'sop', 'sop', 'sop', 'sop', 'notes', 'attribution', 'disclaimer']);
    expect(r.blocks.find((b) => b.role === 'inspection')!.text).toBe('Exterior inspection on Nov 2, 2026.');
    expect(r.blocks.filter((b) => b.role === 'sop').map((b) => b.text)[0]).toBe('Intended users: The seller');
    // a purpose change keeps the stored items; they are rendered only for 'other'
    expect(buildReport(input({ purpose: 'listing_price', disclosure: d })).blocks.some((b) => b.role === 'sop')).toBe(false);
    expect(buildReport(input({ inspection: 'interior_and_exterior', inspectedOn: '2026-01-09' })).blocks.find((b) => b.role === 'inspection')!.text).toBe('Interior and exterior inspection on Jan 9, 2026.');
  });

  it('E615: statements, attributions and disclaimers of every connection, once per text (the strictest minimum kept)', () => {
    const r = buildReport(
      input({
        statements: [
          { text: 'Statement A (fixture).', minPointSize: 10 },
          { text: 'Statement B (fixture).', minPointSize: 12 },
          { text: 'Statement A (fixture).', minPointSize: 12 },
        ],
        attributions: ['Attr A.', 'Attr B.', 'Attr A.'],
        disclaimers: ['Disc A.', 'Disc A.'],
      }),
    );
    expect(r.blocks.filter((b) => b.role === 'statement').map((b) => b.text)).toEqual(['Statement A (fixture).', 'Statement B (fixture).']);
    expect(r.statementMins).toEqual([12, 12]);
    expect(r.blocks.filter((b) => b.role === 'attribution').map((b) => b.text)).toEqual(['Attr A.', 'Attr B.']);
    expect(r.blocks.filter((b) => b.role === 'disclaimer').map((b) => b.text)).toEqual(['Disc A.']);
  });
});

describe('R-CMA-9 rule 5: refusals and warnings', () => {
  it('E604 E605: a substituted statement, attribution or disclaimer is refused for both; 14 pt is heading in the PDF and refused for email; 30 pt has no prominence', () => {
    expect(refusalFor(buildReport(input()), 'email')).toBeNull();
    expect(refusalFor(buildReport(input()), 'pdf')).toBeNull();
    expect(refusalFor(buildReport(input({ statements: [{ text: 'Statement™', minPointSize: 10 }] })), 'email')).toEqual({ part: 'statement', reason: 'SUBSTITUTED', codePoints: ['U+2122'] });
    expect(refusalFor(buildReport(input({ attributions: ['Courtesy of • the MLS'] })), 'pdf')).toEqual({ part: 'attribution', reason: 'SUBSTITUTED', codePoints: ['U+2022'] });
    expect(refusalFor(buildReport(input({ disclaimers: ['Disclaimer…'] })), 'email')).toEqual({ part: 'disclaimer', reason: 'SUBSTITUTED', codePoints: ['U+2026'] });
    for (const min of [12.5, 14]) {
      const r = buildReport(input({ statements: [{ text: 'Statement (fixture).', minPointSize: min }] }));
      expect(Object.keys(pdfFields(r.blocks)).filter((k) => k.includes(':statement:'))).toEqual(['004:statement:heading']);
      expect(refusalFor(r, 'email')).toEqual({ part: 'statement', reason: 'EMAIL_TYPE_SIZE' });
      expect(refusalFor(r, 'pdf')).toBeNull();
    }
    const at12 = buildReport(input({ statements: [{ text: 'Statement (fixture).', minPointSize: 12 }] }));
    expect(Object.keys(pdfFields(at12.blocks)).filter((k) => k.includes(':statement:'))).toEqual(['004:statement:body']);
    const big = buildReport(input({ statements: [{ text: 'Statement (fixture).', minPointSize: 30 }] }));
    expect(refusalFor(big, 'pdf')).toEqual({ part: 'statement', reason: 'NO_PROMINENCE' });
    expect(refusalFor(big, 'email')).toEqual({ part: 'statement', reason: 'EMAIL_TYPE_SIZE' });
    // attributions and disclaimers are set at body, never small or footnote
    for (const b of buildReport(input()).blocks.filter((x) => x.role === 'attribution' || x.role === 'disclaimer')) expect(b.prominence).toBe('body');
  });

  it('E619: a comp address or notes outside WinAnsi only warn ("won\'t print"); the email keeps them as written', () => {
    const r = buildReport(input({ notes: 'Near Đông Park', comps: [{ rendering: rendering({ address: { line1: '12 Đường Ave', line2: null } }), distanceM: 100, tier: 'subdivision', adjustedPriceCents: 1, adjustments: [] }] }));
    expect(refusalFor(r, 'email')).toBeNull();
    expect(r.warnings).toEqual([
      { code: 'WONT_PRINT', role: 'comp', codePoints: ['U+0110', 'U+01B0', 'U+1EDD'] },
      { code: 'WONT_PRINT', role: 'notes', codePoints: ['U+0110'] }, // ô (U+00F4) is Latin-1 and prints
    ]);
    expect(emailText(r.blocks)).toContain('12 Đường Ave');
  });

  it('E608 owner question j: appraisal or promise wording in the notes or SoP items is a "Check this", never a block', () => {
    expect(CHECK_WORDING.test('appraised at')).toBe(true);
    const r = buildReport(input({ notes: 'We guarantee this price.', purpose: 'other', disclosure: { intendedUsers: 'Appraisal use', agentInterest: null, conflicts: null, valueDefinition: null, limitingConditions: null } }));
    expect(r.warnings).toEqual([
      { code: 'CHECK_WORDING', role: 'notes' },
      { code: 'CHECK_WORDING', role: 'sop' },
    ]);
    expect(refusalFor(r, 'email')).toBeNull();
  });

  it('E614: the email text length and the parts it names', () => {
    const long = 'x'.repeat(9000);
    const r = buildReport(input({ disclaimers: [long, long + 'y'] }));
    expect(emailText(r.blocks).length).toBeGreaterThan(REPORT_MAX_EMAIL_CHARS);
    expect(longestParts(r.blocks)[0]).toEqual({ role: 'disclaimer', chars: 18001 });
  });

  it('R-CMA-9: pdfFields keys are NNN:role:prominence, padded so the renderer\'s string sort keeps the block order; the hash covers subject and blocks', () => {
    const many = buildReport(input({ comps: Array.from({ length: 12 }, () => input().comps[0]!) }));
    const keys = Object.keys(pdfFields(many.blocks));
    expect([...keys].sort()).toEqual(keys);
    expect(keys[0]).toBe('000:title:heading');
    expect(keys).toContain('010:comp:body');
    const a = buildReport(input());
    expect(reportSha256(a)).toBe(reportSha256(buildReport(input())));
    expect(reportSha256(a)).not.toBe(reportSha256(buildReport(input({ attributions: ['Changed attribution.'] }))));
    expect(reportSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(dayText('2026-12-31')).toBe('Dec 31, 2026');
  });

  it('R-CMA-9: the subject line has no CR or LF and is at most 300 characters', () => {
    const r = buildReport(input({ subjectAddress: `1 Sample\r\nAve ${'z'.repeat(400)}` }));
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.subject.length).toBe(300);
  });
});
