// decideToolCall, the closed set, the content-to-ledger map and the ledger projection (R-VOICE-4,
// R-VOICE-2, R-VOICE-6, R-VOICE-7, R-CONSENT-8). The equivalence with the real app.voice_tool_args_ok
// and the CHECKs is packages/db/test/voice_core_equivalence.test.ts.
import { describe, expect, it } from 'vitest';
import type { VoiceTool } from '../assistant/index.js';
import { VOICE_TOOLS } from '../assistant/index.js';
import {
  ALWAYS_AVAILABLE_TOOLS,
  CONTENT_TOOL_LEDGER_MAP,
  VOICE_LEDGER_TOOLS,
  VOICE_REASON_CODES,
  type VoiceState,
  decideToolCall,
  enabledLedgerTools,
  ledgerProjection,
  startSession,
  step,
  toolArgsValid,
} from './index.js';
import {
  CONTENT,
  HOT_CLAIMS,
  OTHER_MEMBER_ID,
  OWNER,
  OWNER_ID,
  SESSION_START,
  SLOT_A,
  SLOT_ARGS,
  SLOT_B,
  contact,
  dbArgsOkMirror,
  openSession,
  request,
  voiceFacts,
} from './testing/index.js';

const hotFacts = (o = {}) => voiceFacts({ claims: HOT_CLAIMS, ...o });
const withOptOut = (s: VoiceState, channel: 'voice' | 'all' = 'all'): VoiceState => ({
  ...s,
  optOut: { kind: channel === 'all' ? 'opt_out_language' : 'stop', scope: channel === 'all' ? 'person' : 'channel', channel, classification: { kind: 'opt_out_language', needsReview: true, scope: 'person' } },
});

describe('the closed tool set and the content map (known gap (a))', () => {
  it('R-VOICE-4 the closed set is the voice_tool_calls tool CHECK', () => {
    expect([...VOICE_LEDGER_TOOLS]).toEqual(['check_availability', 'book_appointment', 'warm_transfer', 'take_message', 'record_opt_out', 'end_call']);
  });

  it('every content tool is mapped; share_listing_facts maps to no ledger tool; record_opt_out and end_call are always available', () => {
    expect(Object.keys(CONTENT_TOOL_LEDGER_MAP).sort()).toEqual([...VOICE_TOOLS].sort());
    expect(CONTENT_TOOL_LEDGER_MAP.book_appointment).toEqual(['check_availability', 'book_appointment']);
    expect(CONTENT_TOOL_LEDGER_MAP.take_message).toEqual(['take_message']);
    expect(CONTENT_TOOL_LEDGER_MAP.transfer_to_owner).toEqual(['warm_transfer']);
    expect(CONTENT_TOOL_LEDGER_MAP.share_listing_facts).toEqual([]);
    expect([...enabledLedgerTools({ tools: ['share_listing_facts'] })].sort()).toEqual([...ALWAYS_AVAILABLE_TOOLS].sort());
  });

  it('R-VOICE-4 a tool the approved content does not enable is denied', () => {
    const only = (tools: VoiceTool[]) => voiceFacts({ content: { ...CONTENT, tools } });
    const s = openSession();
    expect(decideToolCall(s, request('book_appointment', SLOT_ARGS(SLOT_A)), only(['take_message']))).toMatchObject({ decision: 'deny', reason: 'VOICE_TOOL_NOT_ENABLED' });
    expect(decideToolCall(s, request('check_availability'), only(['take_message']))).toMatchObject({ decision: 'deny', reason: 'VOICE_TOOL_NOT_ENABLED' });
    expect(decideToolCall(s, request('warm_transfer', { target_user_id: OWNER_ID }), hotFacts({ content: { ...CONTENT, tools: ['book_appointment'] } }))).toMatchObject({ decision: 'deny', reason: 'VOICE_TOOL_NOT_ENABLED' });
    expect(decideToolCall(s, request('take_message'), only(['book_appointment']))).toMatchObject({ decision: 'deny', reason: 'VOICE_TOOL_NOT_ENABLED' });
    // always available, whatever the content enables
    expect(decideToolCall(s, request('end_call'), only(['share_listing_facts']))).toMatchObject({ decision: 'allow', reason: 'ALLOW_END_CALL' });
  });

  it('every reason code matches the ledger CHECK ^[A-Z][A-Z0-9_]*$', () => {
    for (const r of VOICE_REASON_CODES) expect(r).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

describe('R-VOICE-2 no tool before both the disclosure and the recording announcement', () => {
  it('R-VOICE-2 E116 every tool is denied with the DB guard\'s code until both have played', () => {
    const f = hotFacts();
    let s = startSession(f, SESSION_START).state;
    const all = VOICE_LEDGER_TOOLS.map((t) => request(t, t === 'warm_transfer' ? { target_user_id: OWNER_ID } : t === 'book_appointment' ? SLOT_ARGS(SLOT_A) : {}, 1000));
    for (const r of all) expect(decideToolCall(s, r, f)).toMatchObject({ decision: 'deny', reason: 'VOICE_TOOL_BEFORE_DISCLOSURE' });
    s = step(s, { type: 'disclosure_played', at: (SESSION_START + 4000) as never }, f).state;
    for (const r of all) expect(decideToolCall(s, r, f).reason).toBe('VOICE_TOOL_BEFORE_DISCLOSURE');
    s = step(s, { type: 'announcement_played', at: (SESSION_START + 7000) as never }, f).state;
    // a request stamped before the announcement played is still refused (the DB compares occurred_at)
    expect(decideToolCall(s, request('end_call', {}, 6999), f).reason).toBe('VOICE_TOOL_BEFORE_DISCLOSURE');
    expect(decideToolCall(s, request('end_call', {}, 7000), f).decision).toBe('allow');
  });

  it('a request after the session ended is denied', () => {
    const f = voiceFacts();
    const s = step(openSession(f), { type: 'hangup', at: (SESSION_START + 9000) as never }, f).state;
    expect(decideToolCall(s, request('end_call'), f)).toMatchObject({ decision: 'deny', reason: 'VOICE_SESSION_ENDED' });
  });
});

describe('R-VOICE-4 arguments: identical to or stricter than app.voice_tool_args_ok', () => {
  const s = openSession();
  const f = hotFacts();
  it.each([
    ['an unknown tool', 'dial_number', { number: '+15550100199' }, 'VOICE_TOOL_UNKNOWN'],
    ['a non-string tool name', 42, {}, 'VOICE_TOOL_UNKNOWN'],
    ['an extra key', 'take_message', { topic: 'PRICE', note: 'call me at 5' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['free text as a topic', 'take_message', { topic: 'call me back at 555 0100' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['a code outside the topic set', 'take_message', { topic: 'CASEY_SMITH_5550100' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['a non-string value', 'take_message', { topic: 7 }, 'VOICE_TOOL_ARGS_INVALID'],
    ['an array as args', 'end_call', [], 'VOICE_TOOL_ARGS_INVALID'],
    ['null as args', 'end_call', null, 'VOICE_TOOL_ARGS_INVALID'],
    ['a string as args', 'end_call', 'goodbye', 'VOICE_TOOL_ARGS_INVALID'],
    ['an object without a plain prototype', 'end_call', Object.create(null) as object, 'VOICE_TOOL_ARGS_INVALID'],
    ['a phone number as the transfer target', 'warm_transfer', { target_user_id: '+15550100199' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['an upper-case uuid as the transfer target', 'warm_transfer', { target_user_id: OWNER_ID.toUpperCase() }, 'VOICE_TOOL_ARGS_INVALID'],
    ['no transfer target', 'warm_transfer', {}, 'VOICE_TOOL_ARGS_INVALID'],
    ['a booking without a slot', 'book_appointment', {}, 'VOICE_TOOL_ARGS_INVALID'],
    ['a booking with a local time and no offset', 'book_appointment', { slot_start: '2026-11-14T10:00:00', slot_end: '2026-11-14T10:30:00' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['a booking on an impossible date', 'book_appointment', { slot_start: '2026-02-30T10:00:00Z', slot_end: '2026-02-30T10:30:00Z' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['a booking that ends before it starts', 'book_appointment', { slot_start: '2026-11-14T15:30:00Z', slot_end: '2026-11-14T15:00:00Z' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['a booking kind outside appointments.kind', 'book_appointment', { ...SLOT_ARGS(SLOT_A), kind: 'showing' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['spoken words as a time', 'check_availability', { from: 'tomorrow at three' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['an availability window that ends before it starts', 'check_availability', { from: '2026-11-15T00:00:00Z', to: '2026-11-14T00:00:00Z' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['an opt-out channel outside the set', 'record_opt_out', { channel: 'email' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['free text as an end reason', 'end_call', { reason_code: 'caller was rude' }, 'VOICE_TOOL_ARGS_INVALID'],
    ['a code outside the end reasons', 'end_call', { reason_code: 'ANY_CODE' }, 'VOICE_TOOL_ARGS_INVALID'],
  ] as const)('R-VOICE-4 denies %s', (_n, tool, args, reason) => {
    const d = decideToolCall(s, { tool: tool as string, args, at: (SESSION_START + 10_000) as never }, f);
    expect(d).toMatchObject({ decision: 'deny', reason });
    // whatever the request, its ledger projection (when there is one) is a row the DB accepts
    if (d.ledger !== null) expect(dbArgsOkMirror(d.ledger.tool, d.ledger.args)).toBe(true);
  });

  it('toolArgsValid accepts the allowlisted shapes', () => {
    expect(toolArgsValid('check_availability', {})).toBe(true);
    expect(toolArgsValid('check_availability', { from: '2026-11-14T00:00:00Z' })).toBe(true);
    expect(toolArgsValid('check_availability', { from: '2026-11-14T00:00:00Z', to: '2026-11-15T00:00:00+01:00' })).toBe(true);
    expect(toolArgsValid('book_appointment', { slot_start: '2026-11-14T15:00Z', slot_end: '2026-11-14T15:30:00.123456Z', kind: 'listing_appointment' })).toBe(true);
    expect(toolArgsValid('take_message', { topic: 'LENDING' })).toBe(true);
    expect(toolArgsValid('record_opt_out', { channel: 'all' })).toBe(true);
    expect(toolArgsValid('end_call', { reason_code: 'GOODBYE' })).toBe(true);
  });

  it('the ledger projection keeps only allowlisted, valid keys, canonical instants, and never a foreign id', () => {
    const noOpt = { optOut: null };
    const fx = voiceFacts();
    expect(ledgerProjection(request('dial_number'), noOpt, fx)).toBeNull();
    expect(ledgerProjection(request('book_appointment', { slot_start: 'soon' }), noOpt, fx)).toBeNull();
    expect(ledgerProjection(request('book_appointment', { slot_start: '2026-11-14T10:00:00-05:00', slot_end: '2026-11-14T10:30:00-05:00', kind: 'tour', x: 1 }), noOpt, fx)).toEqual({
      tool: 'book_appointment',
      args: { slot_start: '2026-11-14T15:00:00.000Z', slot_end: '2026-11-14T15:30:00.000Z' },
    });
    expect(ledgerProjection(request('warm_transfer', { target_user_id: OTHER_MEMBER_ID }), noOpt, fx)).toEqual({ tool: 'warm_transfer', args: {} });
    expect(ledgerProjection(request('warm_transfer', { target_user_id: OWNER_ID }), noOpt, fx)).toEqual({ tool: 'warm_transfer', args: { target_user_id: OWNER_ID } });
    expect(ledgerProjection(request('warm_transfer', { target_user_id: OWNER_ID }), noOpt, voiceFacts({ contact: contact({ owner: null }) }))).toEqual({ tool: 'warm_transfer', args: {} });
    expect(ledgerProjection(request('record_opt_out', { channel: 'sms' }), noOpt, fx)).toEqual({ tool: 'record_opt_out', args: {} });
    expect(ledgerProjection(request('take_message', 'not an object'), noOpt, fx)).toEqual({ tool: 'take_message', args: {} });
    expect(ledgerProjection(request('check_availability', { from: '2026-11-14T00:00:00Z' }), noOpt, fx)).toEqual({ tool: 'check_availability', args: { from: '2026-11-14T00:00:00.000Z' } });
    expect(ledgerProjection(request('end_call', { reason_code: 'BOOKED' }), noOpt, fx)).toEqual({ tool: 'end_call', args: { reason_code: 'BOOKED' } });
  });
});

describe('per-tool conditions', () => {
  const s = openSession();

  it('check_availability: only for a contact whose owner is an active member', () => {
    expect(decideToolCall(s, request('check_availability'), voiceFacts())).toMatchObject({ decision: 'allow', reason: 'ALLOW_AVAILABILITY' });
    expect(decideToolCall(s, request('check_availability'), voiceFacts({ contact: contact({ owner: null }) })).reason).toBe('CONTACT_NOT_OWNED');
    expect(decideToolCall(s, request('check_availability'), voiceFacts({ contact: contact({ owner: { ...OWNER, status: 'suspended' } }) })).reason).toBe('CONTACT_NOT_OWNED');
  });

  it('R-VOICE-7 book_appointment: only a slot the facts offered from the owner\'s free/busy, only for an owned contact, once', () => {
    const f = voiceFacts();
    expect(decideToolCall(s, request('book_appointment', SLOT_ARGS(SLOT_B, 'consult')), f)).toMatchObject({ decision: 'allow', reason: 'ALLOW_OFFERED_SLOT' });
    // the same instant written with another offset is the same slot
    expect(decideToolCall(s, request('book_appointment', { slot_start: '2026-11-14T10:00:00-05:00', slot_end: '2026-11-14T10:30:00-05:00' }), f).decision).toBe('allow');
    // a slot with the right start and a different end was never offered
    expect(decideToolCall(s, request('book_appointment', { slot_start: '2026-11-14T15:00:00Z', slot_end: '2026-11-14T16:00:00Z' }), f).reason).toBe('SLOT_NOT_OFFERED');
    expect(decideToolCall(s, request('book_appointment', SLOT_ARGS(SLOT_A)), voiceFacts({ offeredSlots: [] })).reason).toBe('SLOT_NOT_OFFERED');
    expect(decideToolCall({ ...s, failedSlots: [SLOT_A] }, request('book_appointment', SLOT_ARGS(SLOT_A)), f).reason).toBe('SLOT_NOT_OFFERED');
    expect(decideToolCall(s, request('book_appointment', SLOT_ARGS(SLOT_A)), voiceFacts({ contact: contact({ owner: null }) })).reason).toBe('CONTACT_NOT_OWNED');
    expect(decideToolCall({ ...s, booking: { slot: SLOT_A, kind: 'consult', status: 'pending' } }, request('book_appointment', SLOT_ARGS(SLOT_B)), f).reason).toBe('BOOKING_PENDING');
    expect(decideToolCall({ ...s, booking: { slot: SLOT_A, kind: 'consult', status: 'booked' } }, request('book_appointment', SLOT_ARGS(SLOT_B)), f).reason).toBe('ALREADY_BOOKED');
  });

  it('R-VOICE-6 warm_transfer: only to the facts\' owner, only for a hot caller, only when transferTarget names the owner, once', () => {
    const owner = request('warm_transfer', { target_user_id: OWNER_ID });
    expect(decideToolCall(s, owner, hotFacts())).toMatchObject({ decision: 'allow', reason: 'ALLOW_OWNER_TRANSFER' });
    expect(decideToolCall(s, request('warm_transfer', { target_user_id: OTHER_MEMBER_ID }), hotFacts()).reason).toBe('TRANSFER_NOT_OWNER');
    expect(decideToolCall(s, owner, hotFacts({ contact: contact({ owner: null }) })).reason).toBe('TRANSFER_NOT_OWNER');
    expect(decideToolCall(s, owner, hotFacts({ contact: contact({ owner: { ...OWNER, acceptingLeads: false } }) })).reason).toBe('TRANSFER_UNAVAILABLE');
    expect(decideToolCall(s, { ...owner, at: (SESSION_START + 9 * 3600_000) as never }, hotFacts()).reason).toBe('TRANSFER_UNAVAILABLE');
    expect(decideToolCall(s, owner, voiceFacts()).reason).toBe('CALLER_NOT_HOT');
    expect(decideToolCall(s, owner, hotFacts({ hotRule: null })).reason).toBe('CALLER_NOT_HOT');
    expect(decideToolCall({ ...s, transfer: { userId: OWNER_ID, holdEndsAt: SESSION_START, outcome: 'no_answer' } }, owner, hotFacts()).reason).toBe('TRANSFER_ALREADY_TRIED');
    // in-call claims count too
    expect(decideToolCall({ ...s, claims: [...HOT_CLAIMS] }, owner, voiceFacts())).toMatchObject({ decision: 'allow' });
  });

  it('R-CONSENT-8 record_opt_out: only when classifyInbound heard an opt-out in the caller\'s own words; the channel is core\'s, never the model\'s', () => {
    expect(decideToolCall(s, request('record_opt_out', { channel: 'all' }), voiceFacts())).toMatchObject({ decision: 'deny', reason: 'OPT_OUT_NOT_HEARD', ledger: { tool: 'record_opt_out', args: {} } });
    expect(decideToolCall(withOptOut(s, 'voice'), request('record_opt_out', { channel: 'all' }), voiceFacts())).toMatchObject({ decision: 'allow', ledger: { args: { channel: 'voice' } } });
    expect(decideToolCall(withOptOut(s, 'all'), request('record_opt_out'), voiceFacts())).toMatchObject({ decision: 'allow', ledger: { args: { channel: 'all' } } });
  });

  it('after an opt-out is heard, only record_opt_out and end_call are allowed', () => {
    const o = withOptOut(s);
    for (const r of [request('check_availability'), request('book_appointment', SLOT_ARGS(SLOT_A)), request('warm_transfer', { target_user_id: OWNER_ID }), request('take_message')]) {
      expect(decideToolCall(o, r, hotFacts()).reason).toBe('VOICE_OPTED_OUT');
    }
    expect(decideToolCall(o, request('end_call'), hotFacts()).decision).toBe('allow');
  });

  it('while a transfer is pending every tool waits', () => {
    const t: VoiceState = { ...s, phase: 'transferring', transfer: { userId: OWNER_ID, holdEndsAt: SESSION_START, outcome: null } };
    for (const tool of VOICE_LEDGER_TOOLS) expect(decideToolCall(t, request(tool, tool === 'warm_transfer' ? { target_user_id: OWNER_ID } : tool === 'book_appointment' ? SLOT_ARGS(SLOT_A) : {}), hotFacts()).reason).toBe('VOICE_TRANSFER_PENDING');
  });

  it('take_message and end_call are allowed with or without their optional code', () => {
    expect(decideToolCall(s, request('take_message'), voiceFacts())).toMatchObject({ decision: 'allow', reason: 'ALLOW_MESSAGE' });
    expect(decideToolCall(s, request('take_message', { topic: 'SHOWING' }), voiceFacts()).decision).toBe('allow');
    expect(decideToolCall(s, request('end_call', { reason_code: 'GOODBYE' }), voiceFacts())).toMatchObject({ decision: 'allow', reason: 'ALLOW_END_CALL' });
  });
});
