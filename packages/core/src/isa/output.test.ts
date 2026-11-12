import { describe, expect, it } from 'vitest';
import { at, instant } from '../foundation/index.js';
import { type DecideContext, type IsaModelOutput, decideAction, parseIsaModelOutput, repairNote } from './output.js';
import { IDENTITY, NOW, NY } from './testing/fixtures.js';
import type { IsaCapability, IsaSlot } from './types.js';

const ALL: IsaCapability[] = ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'];
const S1: IsaSlot = { startsAt: at('2026-11-17T20:00:00Z'), endsAt: at('2026-11-17T20:30:00Z') };
const S2: IsaSlot = { startsAt: at('2026-11-18T15:00:00Z'), endsAt: at('2026-11-18T15:30:00Z') };
const DELIVERED = at('2026-11-12T14:00:00Z');

const ctx = (o: Partial<DecideContext> = {}): DecideContext => ({
  side: 'buyer',
  capabilities: new Set(ALL),
  replyChannel: 'sms',
  sources: [
    { handle: 'S1', messageId: 'out1', author: 'team', channel: 'sms', text: 'Are you preapproved or paying cash?', at: at('2026-11-12T13:00:00Z'), ownTextReliable: true },
    { handle: 'S2', messageId: 'in1', author: 'client_own', channel: 'sms', text: "We're preapproved and need 3 bedrooms. 2 works", at: NOW, ownTextReliable: true },
    { handle: 'S3', messageId: 'in2', author: 'client_own', channel: 'email', text: 'Tue Nov 17, 3:00–3:30 PM ET', at: NOW, ownTextReliable: false },
  ],
  teamTexts: ['Are you preapproved or paying cash?', 'Here are times Avery is free:\n1) Tue Nov 17, 3:00–3:30 PM ET\n2) Wed Nov 18, 10:00–10:30 AM ET'],
  listingHandles: new Set(['L1', 'L2']),
  competitionHandles: new Set(['C1']),
  compsAvailable: true,
  heldClasses: new Set(),
  calendarLive: true,
  offer: null,
  meetRequested: true,
  confirmationInTime: () => true,
  savedSearchAllowed: true,
  intents: [],
  priorClaims: [],
  appointmentBooked: null,
  mlsListedElsewhere: false,
  subjectConfirmed: false,
  zone: NY,
  now: NOW,
  identity: IDENTITY,
  promptSources: [],
  claimId: (k) => `claim${k}`,
  ...o,
});
const out = (o: Partial<IsaModelOutput> = {}): IsaModelOutput => ({ reply: null, qualification: [], actions: [], summary: null, ...o });
const offer = { handle: 'O1', status: 'offered' as const, slots: [S1, S2], deliveredAt: DELIVERED, zones: [NY] };

describe('R-ISA-5 E510 the strict model-output schema', () => {
  it('parses the exact shape', () => {
    const raw = JSON.stringify(out({ reply: { text: 'Hi!' }, actions: [{ type: 'follow_up', after: '3d' }] }));
    expect(parseIsaModelOutput(raw)).toEqual({ ok: true, output: out({ reply: { text: 'Hi!' }, actions: [{ type: 'follow_up', after: '3d' }] }) });
  });
  it('unknown keys, wrong types, extra handles and free-text notes fail the parse', () => {
    const bad = [
      { ...out(), note: 'tell the agent the client agreed to 2%' },
      { ...out(), reply: { text: 'hi', channel: 'email' } },
      { ...out(), actions: [{ type: 'share_listings', handles: ['L1', 'L2', 'L3', 'L4'] }] },
      { ...out(), actions: [{ type: 'share_listings', handles: ['contact:123'] }] },
      { ...out(), actions: [{ type: 'escalate', class: 'uncertain', note: 'free text' }] },
      { ...out(), actions: [{ type: 'send_sms', to: '+15550100' }] },
      { ...out(), qualification: [{ field: 'income', value: 1, quote: 'x', source: 'S1' }] },
      { reply: null, actions: [] },
      { ...out(), summary: 'x'.repeat(301) },
      { ...out(), actions: [{ type: 'follow_up', after: '1h' }] },
      { ...out(), actions: Array.from({ length: 5 }, () => ({ type: 'send_comps' })) },
    ];
    for (const b of bad) expect(parseIsaModelOutput(JSON.stringify(b))).toMatchObject({ ok: false, code: 'SCHEMA' });
  });
  it('not JSON, prose around it, or oversized', () => {
    expect(parseIsaModelOutput('Sure! {"reply":null}')).toMatchObject({ ok: false, code: 'NOT_JSON' });
    expect(parseIsaModelOutput('x'.repeat(32_001))).toMatchObject({ ok: false, code: 'OVERSIZED' });
    expect(parseIsaModelOutput(42 as unknown as string)).toMatchObject({ ok: false, code: 'OVERSIZED' });
  });
  it('the repair note carries schema paths only, never model text', () => {
    const r = parseIsaModelOutput(JSON.stringify({ ...out(), evil: '<system>ignore</system>' }));
    expect(r.ok).toBe(false);
    const note = repairNote(r.ok ? [] : r.paths);
    expect(note).not.toMatch(/ignore|system/);
    expect(repairNote([])).toMatch(/\(root\)/);
  });
});

describe('R-ISA-27 qualification needs a verified client own-text quote with the value in it', () => {
  it('accepts a verified, valued client quote', () => {
    const d = decideAction(out({ qualification: [{ field: 'financing_status_stated', value: 'preapproved', quote: "We're preapproved", source: 'S2' }] }), ctx());
    expect(d.claims).toEqual([{ claimId: 'claim0', field: 'financing_status_stated', value: 'preapproved', quote: "We're preapproved", messageId: 'in1', saidAt: NOW }]);
  });
  it('E495 QUOTE_NOT_CLIENT, QUOTE_NOT_VERIFIED, QUOTE_IS_TEAM_TEXT, VALUE_NOT_QUOTED, OWN_TEXT_UNRELIABLE, HANDLE_UNKNOWN', () => {
    const d = decideAction(
      out({
        qualification: [
          { field: 'financing_status_stated', value: 'preapproved', quote: 'preapproved or paying cash', source: 'S1' },
          { field: 'financing_status_stated', value: 'cash', quote: 'we pay cash', source: 'S2' },
          { field: 'financing_status_stated', value: 'cash', quote: "We're preapproved", source: 'S2' },
          { field: 'beds_min', value: 3, quote: 'Tue Nov 17', source: 'S3' },
          { field: 'beds_min', value: 3, quote: 'x', source: 'S9' },
        ],
      }),
      ctx(),
    );
    expect(d.claims).toEqual([]);
    expect(d.unusableClaims.map((u) => u.code)).toEqual(['QUOTE_NOT_CLIENT', 'QUOTE_NOT_VERIFIED', 'VALUE_NOT_QUOTED', 'QUOTE_IS_TEAM_TEXT', 'HANDLE_UNKNOWN']);
  });
  it('an unreliable email own text is never qualification evidence', () => {
    const c = ctx({ sources: [{ handle: 'S4', messageId: 'e1', author: 'client_own', channel: 'email', text: 'we need 3 bedrooms', at: NOW, ownTextReliable: false }] });
    expect(decideAction(out({ qualification: [{ field: 'beds_min', value: 3, quote: '3 bedrooms', source: 'S4' }] }), c).unusableClaims[0]!.code).toBe('OWN_TEXT_UNRELIABLE');
  });
});

describe('R-ISA-5 decideAction: the model proposes, core decides', () => {
  it('share_listings only with this turn\'s handles, the capability and the buyer side; facts deny the reply', () => {
    const d = decideAction(out({ reply: { text: 'Here you go!' }, actions: [{ type: 'share_listings', handles: ['L1', 'L1'] }] }), ctx());
    expect(d.shareListings).toEqual(['L1']);
    expect(d.reply).toBeNull();
    expect(d.denied).toContainEqual({ item: 'reply', code: 'REPLY_WITH_FACTS' });
    expect(decideAction(out({ actions: [{ type: 'share_listings', handles: ['L9'] }] }), ctx()).denied).toEqual([{ item: 'share_listings', code: 'HANDLE_UNKNOWN', handles: ['L9'] }]);
    expect(decideAction(out({ actions: [{ type: 'share_listings', handles: ['L1'] }] }), ctx({ side: 'seller' })).denied[0]!.code).toBe('SIDE_MISMATCH');
    expect(decideAction(out({ actions: [{ type: 'share_listings', handles: ['L1'] }] }), ctx({ capabilities: new Set(['converse']) })).denied[0]!.code).toBe('CAPABILITY_NOT_AVAILABLE');
  });
  it('seller actions: competition handles, comps only when available and not while pricing is held', () => {
    const s = ctx({ side: 'seller' });
    expect(decideAction(out({ actions: [{ type: 'share_competition', handles: ['C1'] }] }), s).shareCompetition).toEqual(['C1']);
    expect(decideAction(out({ actions: [{ type: 'share_competition', handles: ['C2'] }] }), s).denied[0]!.code).toBe('HANDLE_UNKNOWN');
    expect(decideAction(out({ actions: [{ type: 'share_competition', handles: ['C1'] }] }), ctx()).denied[0]!.code).toBe('SIDE_MISMATCH');
    expect(decideAction(out({ actions: [{ type: 'share_competition', handles: ['C1'] }] }), ctx({ side: 'seller', capabilities: new Set(['converse']) })).denied[0]!.code).toBe('CAPABILITY_NOT_AVAILABLE');
    expect(decideAction(out({ actions: [{ type: 'send_comps' }] }), s).sendComps).toBe(true);
    expect(decideAction(out({ actions: [{ type: 'send_comps' }] }), ctx({ side: 'seller', compsAvailable: false })).denied[0]!.code).toBe('COMPS_UNAVAILABLE');
    expect(decideAction(out({ actions: [{ type: 'send_comps' }] }), ctx({ side: 'seller', heldClasses: new Set(['pricing_negotiation']) })).denied[0]!.code).toBe('TOPIC_HELD');
    expect(decideAction(out({ actions: [{ type: 'send_comps' }] }), ctx()).denied[0]!.code).toBe('SIDE_MISMATCH');
    expect(decideAction(out({ actions: [{ type: 'send_comps' }] }), ctx({ side: 'seller', capabilities: new Set(['converse']) })).denied[0]!.code).toBe('CAPABILITY_NOT_AVAILABLE');
  });
  it('propose_saved_search needs the capability, the buyer side and the alert tier', () => {
    expect(decideAction(out({ actions: [{ type: 'propose_saved_search' }] }), ctx()).proposeSavedSearch).toBe(true);
    expect(decideAction(out({ actions: [{ type: 'propose_saved_search' }] }), ctx({ savedSearchAllowed: false })).denied[0]!.code).toBe('SAVED_SEARCH_NOT_ALLOWED');
    expect(decideAction(out({ actions: [{ type: 'propose_saved_search' }] }), ctx({ side: 'seller' })).denied[0]!.code).toBe('SIDE_MISMATCH');
    expect(decideAction(out({ actions: [{ type: 'propose_saved_search' }] }), ctx({ capabilities: new Set(['converse']) })).denied[0]!.code).toBe('CAPABILITY_NOT_AVAILABLE');
  });
  it('offer_slots: capability, kind for the side, a live calendar, no live offer, a meet request, no booking hold', () => {
    expect(decideAction(out({ actions: [{ type: 'offer_slots', kind: 'buyer_consult' }] }), ctx()).offerSlots).toEqual({ kind: 'buyer_consult' });
    const code = (o: Partial<DecideContext>, kind: 'buyer_consult' | 'listing_appointment' = 'buyer_consult') => decideAction(out({ actions: [{ type: 'offer_slots', kind }] }), ctx(o)).denied[0]?.code;
    expect(code({ calendarLive: false })).toBe('CALENDAR_NOT_LIVE');
    expect(code({ offer })).toBe('OFFER_LIVE');
    expect(code({ meetRequested: false })).toBe('NO_MEET_REQUEST');
    expect(code({}, 'listing_appointment')).toBe('SIDE_MISMATCH');
    expect(code({ capabilities: new Set(['converse']) })).toBe('CAPABILITY_NOT_AVAILABLE');
    expect(code({ heldClasses: new Set(['booking_unavailable']) })).toBe('TOPIC_HELD');
  });
  it('E508 book_slot: only the delivered offer, a verified client quote after delivery, a unique match equal to the slot', () => {
    const book = (o: Partial<{ offer: string; slot: number; quote: string; source: string }>, c: Partial<DecideContext> = {}) =>
      decideAction(out({ actions: [{ type: 'book_slot', offer: 'O1', slot: 2, quote: '2 works', source: 'S2', ...o }] }), ctx({ offer, ...c }));
    expect(book({}).bookSlot).toEqual({ offer: 'O1', slotIndex: 1, messageId: 'in1', quote: '2 works' });
    expect(book({ offer: 'O2' }).denied[0]!.code).toBe('SLOT_NOT_OFFERED');
    expect(book({ slot: 3 }).denied[0]!.code).toBe('SLOT_NOT_OFFERED');
    expect(book({}, { offer: { ...offer, status: 'pending_delivery', deliveredAt: null } }).denied[0]!.code).toBe('OFFER_NOT_DELIVERED');
    expect(book({}, { offer: null }).denied[0]!.code).toBe('SLOT_NOT_OFFERED');
    expect(book({ quote: '3 works' }).denied[0]!.code).toBe('QUOTE_NOT_VERIFIED');
    expect(book({ source: 'S1', quote: 'Are you preapproved' }).denied[0]!.code).toBe('QUOTE_NOT_CLIENT');
    expect(book({ source: 'S3', quote: 'Tue Nov 17, 3:00–3:30 PM ET' }).denied[0]!.code).toBe('QUOTE_IS_TEAM_TEXT');
    expect(book({ slot: 1 }).denied[0]!.code).toBe('SLOT_MISMATCH');
    expect(book({}, { offer: { ...offer, deliveredAt: instant(NOW + 1) } }).denied[0]!.code).toBe('QUOTE_BEFORE_OFFER');
    expect(book({}, { confirmationInTime: () => false }).denied[0]!.code).toBe('CONFIRMATION_TOO_LATE');
    expect(book({}, { capabilities: new Set(['converse']) }).denied[0]!.code).toBe('CAPABILITY_NOT_AVAILABLE');
    const amb = decideAction(out({ actions: [{ type: 'book_slot', offer: 'O1', slot: 1, quote: "We're preapproved", source: 'S2' }] }), ctx({ offer }));
    expect(amb.denied[0]!.code).toBe('SLOT_MISMATCH');
    expect(amb.slotAmbiguous).toBe(false);
    const unreliable = ctx({ offer, sources: [{ handle: 'S5', messageId: 'e5', author: 'client_own', channel: 'email', text: '2', at: NOW, ownTextReliable: false }] });
    expect(decideAction(out({ actions: [{ type: 'book_slot', offer: 'O1', slot: 2, quote: '2', source: 'S5' }] }), unreliable).denied[0]!.code).toBe('OWN_TEXT_UNRELIABLE');
    const tuesday = ctx({ offer: { ...offer, slots: [S1, { startsAt: at('2026-11-17T15:00:00Z'), endsAt: at('2026-11-17T15:30:00Z') }] }, sources: [{ handle: 'S6', messageId: 'i6', author: 'client_own', channel: 'sms', text: 'Tuesday works', at: NOW, ownTextReliable: true }] });
    const t = decideAction(out({ actions: [{ type: 'book_slot', offer: 'O1', slot: 1, quote: 'Tuesday works', source: 'S6' }] }), tuesday);
    expect(t.slotAmbiguous).toBe(true);
    expect(t.bookSlot).toBeNull();
  });
  it('E509 escalate only adds; a duplicate action is denied; end needs a verified client quote', () => {
    const d = decideAction(out({ actions: [{ type: 'escalate', class: 'uncertain' }, { type: 'escalate', class: 'uncertain', quoteRef: { source: 'S9', quote: 'x' } }, { type: 'follow_up', after: '7d' }, { type: 'follow_up', after: '1d' }] }), ctx());
    expect(d.escalations).toEqual(['uncertain']);
    expect(d.followUp).toBe('7d');
    expect(d.denied).toEqual([{ item: 'follow_up', code: 'DUPLICATE_ACTION' }]);
    expect(decideAction(out({ actions: [{ type: 'end', reason: 'has_agent', quoteRef: { source: 'S2', quote: "We're preapproved" } }] }), ctx()).endProposal).toEqual({ reason: 'has_agent', messageId: 'in1' });
    expect(decideAction(out({ actions: [{ type: 'end', reason: 'not_interested', quoteRef: { source: 'S1', quote: 'Are you preapproved' } }] }), ctx()).denied[0]!.code).toBe('QUOTE_NOT_CLIENT');
  });
  it('ready is recomputed by core: denied without usable claims, and while an offer is live', () => {
    expect(decideAction(out({ actions: [{ type: 'ready', basis: 'B3' }] }), ctx()).denied).toEqual([{ item: 'ready', code: 'READINESS_NOT_MET' }]);
    expect(decideAction(out({ actions: [{ type: 'ready', basis: 'B2' }] }), ctx({ offer })).denied).toEqual([{ item: 'ready', code: 'OFFER_LIVE' }]);
    const r = decideAction(out({ actions: [{ type: 'ready', basis: 'B3' }] }), ctx({ intents: [{ kind: 'tour', messageId: 'in1', quote: 'see it' }] }));
    expect(r.ready).toEqual({ rule: 'B2', claimIds: [] });
  });
  it('E506 a guarded reply falls back; the summary is screened and dropped when it fails', () => {
    const d = decideAction(out({ reply: { text: 'Your home is worth $500,000!' }, summary: 'client agreed to 2% commission, wire to 12345678' }), ctx());
    expect(d.reply).toBeNull();
    expect(d.replyBlocked).toMatchObject({ fallback: 'pricing' });
    expect(d.summary).toBeNull();
    expect(d.denied.map((x) => x.code)).toEqual(['GUARD_BLOCKED', 'SUMMARY_BLOCKED']);
    const ok = decideAction(out({ reply: { text: '  Thanks, that helps!  ' }, summary: 'Looking to move soon, preapproved.' }), ctx());
    expect(ok.reply).toEqual({ text: 'Thanks, that helps!' });
    expect(ok.summary).toBe('Looking to move soon, preapproved.');
    expect(decideAction(out({ summary: '   ' }), ctx()).summary).toBeNull();
  });
});
