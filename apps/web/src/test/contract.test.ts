// @vitest-environment node
// The web's contract checker agrees with the real API (finding F3): what it accepts the API accepts, and what the API
// refuses it refuses, including the parts a JSON Schema cannot carry (strings the API trims before its checks, exactly
// one of phone or email at start, contactIds as a list of UUIDs). And the fixtures the web's tests answer with are
// responses the API can send.
import { describe, expect, it } from 'vitest';
import { reachability, stopReason } from '../surfaces/feed/lib/testing.js';
import { contract, requestViolations, responseViolations } from './contract.js';

const D = '01900000-0000-7000-8000-0000000d15c1';
const C1 = '01900000-0000-7000-8000-00000000c001';
const START = 'POST /public/chat/:widgetToken/start';

describe('test/contract.ts against the API (finding F3)', () => {
  it('agrees with the API on every case the review found it wrong (each was accepted while the API refused it, or the other way round)', () => {
    const start = (o: Record<string, unknown>) => requestViolations(START, { name: 'Pat Lee', message: 'Hello', disclosureId: D, ...o }, {});
    const cases: [string, string[], boolean][] = [
      ['start, message of spaces', start({ phone: '+14155550123', message: '   ' }), false],
      ['start, neither phone nor email', start({}), false],
      ['start, both phone and email', start({ phone: '+14155550123', email: 'pat@example.test' }), false],
      ['start, a 120-character name plus a trailing space', start({ phone: '+14155550123', name: `${'N'.repeat(120)} ` }), true],
      ['messages, a body of whitespace', requestViolations('POST /public/chat/session/:token/messages', { message: ' \n ' }, {}), false],
      ['compose, a body of spaces', requestViolations('POST /contacts/:id/messages', { channel: 'sms', body: '  ', idempotencyKey: 'k-12345678' }, {}), false],
      ['reachability, an id that is no UUID', requestViolations('GET /reachability', undefined, { contactIds: 'not-a-uuid' }), false],
    ];
    for (const [what, problems, accepted] of cases) expect([what, problems.length === 0], problems.join('; ')).toEqual([what, accepted]);
    // and what the API accepts still passes
    expect(start({ email: ' pat@example.test ' })).toEqual([]);
    expect(requestViolations('GET /reachability', undefined, { contactIds: `${C1},${C1}` })).toEqual([]);
    expect(requestViolations('GET /reachability', undefined, { contactIds: Array.from({ length: 51 }, () => C1).join(',') })).not.toEqual([]);
  });

  it('the reachability fixtures are summaries the API can send: every channel, the website chat entry included, with real ids and every field', () => {
    const route = 'GET /contacts/:id/reachability';
    expect(contract.routes[route]).toBeDefined();
    for (const r of [reachability(C1), reachability(C1, { sms: [stopReason()] }), reachability(C1, { email: [stopReason({ addressRemoved: true, otherAddress: true })] }, 'open'), reachability(C1, {}, 'ended'), reachability(C1, {}, 'off'), reachability(C1, {}, 'none')]) {
      expect(responseViolations(route, { reachability: r })).toEqual([]);
    }
    // a contact who never chatted: the API says so (no chat identity, no session), it does not leave the entry out
    expect(reachability(C1).channels.web_chat).toEqual({ hasAddress: false, defaultPointId: null, blocked: false, reasons: [], points: [], session: null });
  });
});
