// module 46 (R-PORTALWEB-5, E708): the strict allowlist parsers.
import { describe, expect, it } from 'vitest';
import * as F from '../test/fixtures.js';
import { hostile, rng } from '../test/hostile.js';
import { ParseError, parseDocuments, parseLoginAccepted, parseMe, parsePreview, parseSession, parseStreamToken, parseTimeline } from './parse.js';

const INJECTED = { notes: 'internal note', score: 97, value: 512000, cmaValue: '$500k', aiDraft: 'drafted', assignee: 'agent', tenantId: '01900000-0000-7000-8000-0000000000ff' };
const PARSERS = [parseMe, parseTimeline, parseDocuments, parseStreamToken, parseSession, parsePreview, parseLoginAccepted];

describe('view/parse.ts (R-PORTALWEB-5)', () => {
  it('E708: only contract keys survive; injected notes, scores, values, CMA, AI drafts, assignees, tenant ids and __proto__ never reach a component', () => {
    const me = parseMe({ ...F.me([{ ...F.grant(), ...INJECTED, contact: { ...F.contact, ...INJECTED } }]), ...INJECTED });
    const tl = parseTimeline({ ...F.timeline(), ...INJECTED, items: F.timeline().items.map((i) => ({ ...i, ...INJECTED })) });
    const docs = parseDocuments({ ...F.documents(), documents: F.documents().documents.map((d) => ({ ...d, ...INJECTED })) });
    const proto = parseMe(JSON.parse(`{"account":{"status":"active"},"csrfToken":"c","session":{"idleHours":1,"absoluteDays":1},"grants":[],"__proto__":{"polluted":true}}`));
    const text = JSON.stringify([me, tl, docs, proto]);
    for (const k of Object.keys(INJECTED)) expect(text, k).not.toContain(`"${k}"`);
    expect(text).not.toMatch(/internal note|512000|drafted|polluted/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(me.grants[0]!).sort()).toEqual(['contact', 'expiresOn', 'id', 'scope', 'title']);
    expect(Object.keys(me.grants[0]!.contact!).sort()).toEqual(['agentName', 'emailTo', 'textTo']);
    expect(Object.keys(tl.items[0]!).sort()).toEqual(['body', 'itemId', 'kind', 'occursOn', 'publishedAt', 'title']);
  });

  it('E708: a malformed required field, a seventh kind, a non-date, a non-UUID or a bad instant is BAD_RESPONSE (ParseError)', () => {
    const t = F.timeline();
    const bad: [string, () => unknown][] = [
      ['seventh kind', () => parseTimeline({ ...t, items: [{ ...t.items[0], kind: 'cma_value' }] })],
      ['document kind in the timeline', () => parseTimeline({ ...t, items: [{ ...t.items[0], kind: 'document' }] })],
      ['no title', () => parseTimeline({ ...t, items: [{ ...t.items[0], title: '' }] })],
      ['bad date', () => parseTimeline({ ...t, items: [{ ...t.items[0], occursOn: '2026-02-30' }] })],
      ['date with time', () => parseTimeline({ ...t, items: [{ ...t.items[0], occursOn: '2026-12-18T00:00:00Z' }] })],
      ['bad instant', () => parseTimeline({ ...t, items: [{ ...t.items[0], publishedAt: 'yesterday' }] })],
      ['non-UUID id', () => parseTimeline({ ...t, items: [{ ...t.items[0], itemId: '1 OR 1=1' }] })],
      ['items not an array', () => parseTimeline({ ...t, items: {} })],
      ['body too long', () => parseTimeline({ ...t, items: [{ ...t.items[0], body: 'x'.repeat(4001) }] })],
      ['account not active', () => parseMe({ ...F.me(), account: { status: 'disabled' } })],
      ['grant scope unknown', () => parseMe(F.me([{ ...F.grant(), scope: 'cma' }]))],
      ['stream byteSize negative', () => parseStreamToken(F.streamToken({ byteSize: -1 }))],
      ['stream byteSize over 10 MB', () => parseStreamToken(F.streamToken({ byteSize: 10_000_001 }))],
      ['stream byteSize fractional', () => parseStreamToken(F.streamToken({ byteSize: 1.5 }))],
      ['login status', () => parseLoginAccepted({ status: 'sent', message: 'x' })],
      ['preview visibleNow', () => parsePreview({ visibleNow: 'yes', why: [], grant: F.grant(), timeline: { items: [], nextSteps: [] }, documents: [] })],
      ['null', () => parseMe(null)],
      ['array', () => parseMe([])],
    ];
    for (const [what, f] of bad) expect(f, what).toThrow(ParseError);
  });

  it('E715: a malformed contact value is dropped (no link is ever built from it), and an all-empty contact is null', () => {
    const g = parseMe(F.me([F.grant({ contact: { agentName: 'Sam Agent', textTo: 'javascript:alert(1)', emailTo: 'a@b.test?cc=evil@example.test' } })])).grants[0]!;
    expect(g.contact).toEqual({ agentName: 'Sam Agent', textTo: null, emailTo: null });
    const none = parseMe(F.me([F.grant({ contact: { agentName: null, textTo: '555', emailTo: 'not-an-email' } as never })])).grants[0]!;
    expect(none.contact).toBeNull();
  });

  it('a preview parses exactly the client view of the grant (R-PORTAL-16)', () => {
    const p = parsePreview({ visibleNow: false, why: ['The client has not signed in yet.'], grant: { ...F.grant(), ...INJECTED }, timeline: { items: F.timeline().items, nextSteps: F.timeline().nextSteps }, documents: F.documents().documents });
    expect(p.why).toEqual(['The client has not signed in yet.']);
    expect(p.timeline.items.map((i) => i.title)).toEqual(['Inspection', 'Closing']);
    expect(JSON.stringify(p)).not.toContain('cmaValue');
  });

  it('E708 (property): 200 seeded hostile values make every parser either return or throw ParseError, never anything else', () => {
    const r = rng(46);
    let threw = 0;
    for (let i = 0; i < 200; i += 1) {
      const v = hostile(r);
      for (const p of PARSERS) {
        try {
          p(v);
        } catch (e) {
          expect(e, `case ${i} ${p.name}`).toBeInstanceOf(ParseError);
          threw += 1;
        }
      }
    }
    expect(threw).toBeGreaterThan(100);
  });
});
