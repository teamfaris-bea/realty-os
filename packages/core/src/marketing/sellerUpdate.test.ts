import { describe, expect, it } from 'vitest';
import { at, type Instant } from '../foundation/index.js';
import { DEFAULT_COMPETING_RULE, parseLicensePack, type LicensePack } from '../listings/index.js';
import {
  assembleSellerUpdate,
  inviteSendSummary,
  marketingNumber,
  recommendationOk,
  NO_MLS_FEED,
  type InviteRecipient,
  type Period,
  type SellerUpdateInputs,
} from './index.js';
import { ZONE, lid, mid, mlsListing, sid, teamListing } from './testing/fixtures.js';

const PERIOD: Period = { start: at('2026-11-02T06:00:00Z'), end: at('2026-11-09T06:00:00Z'), zone: ZONE };
const NOW = at('2026-11-09T07:00:00Z');
const IN = at('2026-11-05T18:00:00Z');
const BEFORE = at('2026-10-30T18:00:00Z');

const PACK: LicensePack = parseLicensePack({
  reviewed_by_counsel_at: '2026-10-15T09:00:00Z',
  max_staleness_hours: 24,
  attribution_text: 'Listing courtesy of {brokerage}. Data from the Example MLS.',
  disclaimer_text: 'Information deemed reliable but not guaranteed.',
  audiences: {
    client: { fields: ['status', 'listPrice', 'beds', 'address', 'locality'], statuses: ['active', 'pending'] },
    public: { fields: [], statuses: [] },
  },
});

const base = (o: Partial<SellerUpdateInputs> = {}): SellerUpdateInputs => ({
  listing: teamListing(),
  now: NOW,
  showingServiceConnected: false,
  showings: [],
  feedback: [],
  pieces: [],
  inviteSends: [],
  loggedActivity: [],
  mls: { connected: false },
  ...o,
});

const recipients = (sent: number, optedOut: number, blocked = 0): InviteRecipient[] => [
  ...Array.from({ length: sent }, (_, n) => ({ messageId: mid(n), outcome: 'sent' as const })),
  ...Array.from({ length: optedOut }, (_, n) => ({ messageId: mid(1000 + n), outcome: 'opted_out' as const })),
  ...Array.from({ length: blocked }, (_, n) => ({ messageId: mid(2000 + n), outcome: 'blocked' as const })),
];

const section = (r: ReturnType<typeof assembleSellerUpdate>, kind: string) => {
  const s = r.sections.find((x) => x.kind === kind);
  if (!s) throw new Error(kind);
  return s;
};
const allText = (r: ReturnType<typeof assembleSellerUpdate>): string =>
  [...r.sections.flatMap((s) => [s.title, s.statement, ...s.lines.map((l) => l.text)]), ...r.claims.map((c) => c.text)].join('\n');

describe('assembleSellerUpdate: showings (R-SELL-2)', () => {
  it('R-SELL-2 E87: a week with zero showings says "No showings logged in Realty OS this week"', () => {
    const r = assembleSellerUpdate(base({ showings: [{ id: sid(1), startsAt: BEFORE, status: 'completed', source: 'manual', buyerAgentName: null, buyerAgentBrokerage: null }] }), PERIOD);
    const s = section(r, 'showings');
    expect(s.state).toBe('none_logged');
    expect(s.lines.map((l) => l.text)).toEqual(['No showings logged in Realty OS this week']);
    expect(s.statement).toBe('Showings are logged by hand in Realty OS; no showing service is connected.');
    const c = r.claims[s.claimOrdinals[0]!];
    expect(c).toMatchObject({ text: 'No showings logged in Realty OS this week', count: 0 });
  });

  it('R-SELL-2: logged showings are counted with evidence; canceled ones are not', () => {
    const r = assembleSellerUpdate(
      base({
        showings: [
          { id: sid(1), startsAt: IN, status: 'completed', source: 'manual', buyerAgentName: 'A', buyerAgentBrokerage: null },
          { id: sid(2), startsAt: IN, status: 'no_show', source: 'manual', buyerAgentName: null, buyerAgentBrokerage: null },
          { id: sid(3), startsAt: IN, status: 'canceled', source: 'manual', buyerAgentName: null, buyerAgentBrokerage: null },
        ],
      }),
      PERIOD,
    );
    const s = section(r, 'showings');
    const c = r.claims[s.claimOrdinals[0]!]!;
    expect(c.text).toBe('2 showings logged in Realty OS this week (1 of 2 marked no-show)');
    expect(c.count).toBe(2);
    expect(c.evidence).toEqual([
      { sourceType: 'showing', sourceId: sid(1), locator: { kind: 'field', name: 'status' }, snippet: 'completed' },
      { sourceType: 'showing', sourceId: sid(2), locator: { kind: 'field', name: 'status' }, snippet: 'no_show' },
    ]);
  });
});

describe('assembleSellerUpdate: feedback (R-SELL-2, E89)', () => {
  it('R-SELL-2 E89: rude feedback is shown verbatim to the agent, removable, never rule-published', () => {
    const rude = 'Overpriced dump, the agent was useless. Bob Jones hated it.';
    const r = assembleSellerUpdate(
      base({ feedback: [{ id: 'f1', showingId: sid(1), rating: 1, comments: rude, source: 'email', receivedAt: IN }], knownBuyerNames: ['Bob Jones'] }),
      PERIOD,
    );
    const s = section(r, 'feedback');
    expect(s.lines).toEqual([{ text: rude, feedback: { feedbackId: 'f1', verbatim: rude, removable: true, publish: 'person_only', namesPerson: true } }]);
    const c = r.claims[s.claimOrdinals[0]!]!;
    expect(c.evidence[0]).toEqual({ sourceType: 'showing_feedback', sourceId: 'f1', locator: { kind: 'field', name: 'comments' }, snippet: rude });
  });

  it('R-SELL-2: a rating-only item shows its denominator; zero feedback is said plainly', () => {
    const r = assembleSellerUpdate(base({ feedback: [{ id: 'f2', showingId: sid(1), rating: 4, comments: null, source: 'manual', receivedAt: IN }] }), PERIOD);
    expect(section(r, 'feedback').lines[0]?.text).toBe('Rating 4 of 5');
    expect(section(assembleSellerUpdate(base(), PERIOD), 'feedback').lines[0]?.text).toBe('No showing feedback logged in Realty OS this week');
  });
});

describe('assembleSellerUpdate: marketing activity (R-SELL-2, R-MKT-8, R-MKT-10)', () => {
  it('R-SELL-2: zero activity is said plainly', () => {
    const s = section(assembleSellerUpdate(base(), PERIOD), 'marketing');
    expect(s.state).toBe('none_logged');
    expect(s.lines[0]?.text).toBe('No marketing activity logged in Realty OS this week');
  });

  it('R-SELL-2 R-MKT-6: exports are never counted as activity', () => {
    const r = assembleSellerUpdate(
      base({
        pieces: [
          { pieceId: 'p1', kind: 'marketplace_export', status: 'exported', publishedAt: null, exportedAt: IN },
          { pieceId: 'p2', kind: 'flyer', status: 'exported', publishedAt: null, exportedAt: IN },
        ],
      }),
      PERIOD,
    );
    const s = section(r, 'marketing');
    expect(s.state).toBe('none_logged');
    expect(r.claims.find((c) => c.section === 'marketing')?.count).toBe(0);
    expect(s.statement).toMatch(/Exports are not counted/);
  });

  it('R-SELL-2: activity only from published pieces, sent invites and agent-logged activity', () => {
    const r = assembleSellerUpdate(
      base({
        pieces: [
          { pieceId: 'p1', kind: 'website_page', status: 'published', publishedAt: IN, exportedAt: null },
          { pieceId: 'p2', kind: 'social_post', status: 'exported', publishedAt: BEFORE, exportedAt: IN },
        ],
        inviteSends: [{ pieceId: 'p3', sentAt: IN, recipients: recipients(41, 4) }],
        loggedActivity: [{ id: 'a1', kind: 'open_house', channel: null, occurredAt: IN }],
      }),
      PERIOD,
    );
    const texts = r.claims.filter((c) => c.section === 'marketing').map((c) => c.text);
    expect(texts).toEqual(['1 marketing piece published this week', 'Open-house invite: Sent 41 of 45; 4 opted out', '1 marketing activity logged by your team this week']);
    const invite = r.claims.find((c) => c.text.startsWith('Open-house invite'))!;
    expect(invite.count).toBe(41);
    expect(invite.evidence).toHaveLength(45);
    expect(invite.evidence[0]).toEqual({ sourceType: 'message', sourceId: mid(0), locator: { kind: 'field', name: 'status' }, snippet: 'sent' });
    expect(section(r, 'marketing').state).toBe('has_data');
  });

  it('E94 R-MKT-8: an invitee who unsubscribed is blocked and counted: "Sent 41 of 45; 4 opted out"', () => {
    expect(inviteSendSummary(recipients(41, 4)).text).toBe('Sent 41 of 45; 4 opted out');
    expect(inviteSendSummary(recipients(41, 4))).toMatchObject({ sent: 41, total: 45, optedOut: 4, blocked: 0 });
  });

  it('E152 R-MKT-8: 900 invited, 40 unsubscribed ⇒ "Sent 860 of 900; 40 opted out"', () => {
    expect(inviteSendSummary(recipients(860, 40)).text).toBe('Sent 860 of 900; 40 opted out');
    expect(inviteSendSummary(recipients(10, 0, 2)).text).toBe('Sent 10 of 12; 2 not sent for other reasons');
  });

  it('R-MKT-10: marketing numbers only from first-party facts; logged metrics are never read', () => {
    const activity = { id: 'a1', kind: 'social_post', channel: null, occurredAt: IN, metrics: { page_views: 3127, estimated_reach: 9000, impressions: 4421 } } as never;
    const r = assembleSellerUpdate(base({ loggedActivity: [activity] }), PERIOD);
    const t = allText(r);
    for (const n of ['3127', '3,127', '9000', '9,000', '4421', '4,421']) expect(t).not.toContain(n);
  });

  it('R-MKT-10: provider numbers are labelled; page views, opens and estimates are refused', () => {
    expect(marketingNumber('leads', 3, { kind: 'form_submissions' })).toEqual({ ok: true, text: '3 leads (form submissions in Realty OS)' });
    expect(marketingNumber('link_clicks', 12, { kind: 'provider', provider: 'Meta' })).toEqual({ ok: true, text: '12 link clicks (reported by Meta)' });
    for (const m of ['page_views', 'email_opens', 'estimated_reach', 'views']) {
      expect(marketingNumber(m, 5, { kind: 'provider', provider: 'X' })).toEqual({ ok: false, code: 'MARKETING_METRIC_NOT_SHOWN' });
    }
  });
});

describe('assembleSellerUpdate: competing listings (R-SELL-2, R-MLS-2, R-MLS-3)', () => {
  const comp = mlsListing({ id: lid(901), addressLine1: '14 Oak St', listPriceCents: 44_000_000 });
  const mls = (lastSyncedAt: Instant | null) => ({ connected: true as const, lastSyncedAt, pack: PACK, candidates: [comp], rule: DEFAULT_COMPETING_RULE });

  it('R-SELL-2: "Competing listings unavailable: no MLS feed connected"', () => {
    const s = section(assembleSellerUpdate(base(), PERIOD), 'competing');
    expect(s).toMatchObject({ state: 'unavailable', statement: NO_MLS_FEED, claimOrdinals: [] });
    expect(NO_MLS_FEED).toBe('Competing listings unavailable: no MLS feed connected');
  });

  it('R-SELL-2 R-MLS-2: competing MLS listings are shown with attribution and disclaimer', () => {
    const r = assembleSellerUpdate(base({ mls: mls(at('2026-11-09T05:00:00Z')) }), PERIOD);
    const s = section(r, 'competing');
    expect(s.state).toBe('has_data');
    expect(s.statement).toBe('From the MLS feed, with each listing\'s attribution. MLS data as of Nov 8, 2026, 11:00 PM CST.');
    expect(s.lines.map((l) => l.text)).toEqual([
      '1 competing listing from the MLS feed',
      '14 Oak St · $440,000 · 3 bd · active · Listed by Other Brokerage LLC. Listing courtesy of Other Brokerage LLC. Data from the Example MLS.',
      'Information deemed reliable but not guaranteed.',
    ]);
    expect(r.claims[s.claimOrdinals[0]!]).toMatchObject({ count: 1, evidence: [{ sourceType: 'listing', sourceId: lid(901) }] });
  });

  it('R-MLS-2 E86: a listing whose broker opted out of internet display is not shown to the seller', () => {
    const r = assembleSellerUpdate(base({ mls: { ...mls(at('2026-11-09T05:00:00Z')), candidates: [mlsListing({ id: lid(902), displayAllowed: false })] } }), PERIOD);
    const t = allText(r);
    expect(t).not.toContain('Other Brokerage');
  });

  it('E85 R-MLS-3: a stale feed says "MLS data as of …" and pauses competing listings', () => {
    const r = assembleSellerUpdate(base({ mls: mls(at('2026-11-06T05:00:00Z')) }), PERIOD);
    const s = section(r, 'competing');
    expect(s.state).toBe('stale');
    expect(s.statement).toBe('MLS data as of Nov 5, 2026, 11:00 PM CST. Competing listings are paused until the MLS feed catches up.');
    expect(allText(r)).not.toContain('14 Oak St');
  });
});

describe('assembleSellerUpdate: honesty (R-SELL-2, R-SELL-3, R-AST-13)', () => {
  const full = base({
    showings: [{ id: sid(1), startsAt: IN, status: 'completed', source: 'manual', buyerAgentName: null, buyerAgentBrokerage: null }],
    feedback: [{ id: 'f1', showingId: sid(1), rating: 3, comments: 'Nice kitchen.', source: 'manual', receivedAt: IN }],
    pieces: [{ pieceId: 'p1', kind: 'website_page', status: 'published', publishedAt: IN, exportedAt: null }],
    inviteSends: [{ pieceId: 'p3', sentAt: IN, recipients: recipients(3, 1) }],
  });

  it('R-SELL-2: no page-view counts and no email opens anywhere', () => {
    const t = allText(assembleSellerUpdate(full, PERIOD));
    expect(t).not.toMatch(/page ?views?|\bviews?\b|\bopens?\b(?![- ]house)|opened|impressions|\breach/i);
  });

  it('R-SELL-2 R-AST-13: every count is a claim with evidence and no confidence field', () => {
    const r = assembleSellerUpdate(full, PERIOD);
    expect(r.claims.length).toBeGreaterThan(0);
    for (const c of r.claims) {
      expect(Object.keys(c).sort()).toEqual(['count', 'evidence', 'kind', 'ordinal', 'section', 'text']);
      expect(JSON.stringify(c)).not.toMatch(/confidence|score|probab/i);
      if (c.count !== null && c.count > 0) {
        expect(c.evidence.length).toBeGreaterThanOrEqual(c.count);
        for (const e of c.evidence) {
          expect(e.sourceId).not.toBe('');
          expect(e.locator.kind).toBe('field');
        }
      }
      expect(c.text.length).toBeLessThanOrEqual(300);
    }
    expect(r.claims.map((c) => c.ordinal)).toEqual(r.claims.map((_, n) => n));
  });

  it('R-SELL-2: each section states where its data stands', () => {
    for (const s of assembleSellerUpdate(full, PERIOD).sections) expect(s.statement.length).toBeGreaterThan(10);
  });

  it('R-SELL-3: the assembly never prefills a recommendation', () => {
    const r = assembleSellerUpdate(full, PERIOD);
    expect(Object.keys(r).sort()).toEqual(['claims', 'sections']);
    expect(JSON.stringify(r)).not.toMatch(/recommend|we suggest|you should|consider (?:a|lowering)/i);
  });

  it('R-SELL-3 E88: recommendationOk requires at least 20 characters once trimmed', () => {
    expect(recommendationOk('Hold the price for one more week.')).toBe(true);
    expect(recommendationOk('   short   ')).toBe(false);
    expect(recommendationOk(`${' '.repeat(30)}x`)).toBe(false);
    expect(recommendationOk('a'.repeat(19))).toBe(false);
    expect(recommendationOk('a'.repeat(20))).toBe(true);
    expect(recommendationOk('😀'.repeat(10))).toBe(false); // 10 characters for Postgres, 20 UTF-16 units
    expect(recommendationOk(null)).toBe(false);
  });

  it('R-SELL-2: a custom period label is used in every sentence', () => {
    const r = assembleSellerUpdate(base(), { ...PERIOD, label: 'since your last update' });
    expect(section(r, 'showings').lines[0]?.text).toBe('No showings logged in Realty OS since your last update');
  });
});
