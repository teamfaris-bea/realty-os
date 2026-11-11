// Property and example tests of module 68's pure helpers (PHASE2_3_PLAN §5.4 #68: property or mutation tests on
// the matching and stripping functions; R-GMAIL-5, R-GMAIL-12, E204, E205, E206, E207).
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rfcMessageIdSha256 as module22Hash } from '../channels/rfcMessageId.js';
import { gmailMessageRef, isSkipped, matchMailParticipants, parseAddressList, rfcMessageIdSha256, stripQuoted, type RelatedEmailPoint } from './match.js';

const hmacOf = (a: string) => createHash('sha256').update(`k:${a}`).digest('hex');
const point = (contactId: string, address: string, pointId = `p-${address}`): RelatedEmailPoint => ({ contactId, pointId, hmac: hmacOf(address) });

const local = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
const domain = fc.stringMatching(/^[a-z]{2,8}\.(com|net|org|test)$/);
const address = fc.tuple(local, domain).map(([l, d]) => `${l}@${d}`);

describe('parseAddressList (RFC 5322 address lists)', () => {
  it('R-GMAIL-5: display names, quoted commas, angle addresses, comments and groups', () => {
    expect(parseAddressList('"Doe, Jane" <Jane@Example.com>, bob@y.test (Bob), <c@z.org>')).toEqual(['jane@example.com', 'bob@y.test', 'c@z.org']);
    expect(parseAddressList('Friends: a@x.com, b@y.com;, d@w.net')).toEqual(['a@x.com', 'b@y.com', 'd@w.net']);
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('not an address, also bad@, @nope.com')).toEqual([]);
    expect(parseAddressList('Jane\r\n <jane@example.com>')).toEqual(['jane@example.com']);
    expect(parseAddressList(null)).toEqual([]);
  });

  it('R-GMAIL-5 property: every generated address list round-trips, lower-cased and deduplicated, whatever the display names', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(address, fc.option(fc.stringMatching(/^[A-Za-z ,.]{1,20}$/), { nil: null })), { maxLength: 8 }), (list) => {
        const header = list.map(([a, n]) => (n === null ? a : `"${n}" <${a.toUpperCase()}>`)).join(', ');
        const want = [...new Set(list.map(([a]) => a))];
        expect(parseAddressList(header)).toEqual(want);
      }),
    );
  });

  it('property: never throws and only ever returns normalized addresses that occur in the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        for (const a of parseAddressList(s)) {
          expect(a).toBe(a.toLowerCase());
          expect(s.toLowerCase()).toContain(a);
        }
      }),
    );
  });
});

describe('matchMailParticipants (R-GMAIL-5)', () => {
  const me = 'agent@gmail.test';
  it('E204: a client Cc’d on a thread with a lender who is not a contact: stored for the client as cc, the lender only counted', () => {
    const m = matchMailParticipants({ from: [me], to: ['lender@bank.test'], cc: ['client@x.test'], bcc: [] }, [point('c1', 'client@x.test')], hmacOf, hmacOf(me));
    expect(m).toEqual([{ contactId: 'c1', pointId: 'p-client@x.test', hmac: hmacOf('client@x.test'), role: 'cc', sender: 'mailbox', otherRecipientCount: 1 }]);
    expect(JSON.stringify(m)).not.toContain('lender');
  });

  it('E205: the agent Bcc’s a client: role bcc, the other recipients only as a count', () => {
    const m = matchMailParticipants({ from: [me], to: ['a@o.test', 'b@o.test'], cc: [], bcc: ['client@x.test'] }, [point('c1', 'client@x.test')], hmacOf, hmacOf(me));
    expect(m).toMatchObject([{ role: 'bcc', sender: 'mailbox', otherRecipientCount: 2 }]);
  });

  it('E206: the agent forwards a client’s email to a personal friend: no contact address on the forward ⇒ nothing matches', () => {
    expect(matchMailParticipants({ from: [me], to: ['friend@home.test'], cc: [], bcc: [] }, [point('c1', 'client@x.test')], hmacOf, hmacOf(me))).toEqual([]);
  });

  it('a client writes: sender contact, role from; one row per contact even with two of its addresses on the message', () => {
    const m = matchMailParticipants({ from: ['client@x.test'], to: [me, 'client2@x.test'], cc: [], bcc: [] }, [point('c1', 'client@x.test'), point('c1', 'client2@x.test')], hmacOf, hmacOf(me));
    expect(m).toEqual([expect.objectContaining({ contactId: 'c1', role: 'from', sender: 'contact', pointId: 'p-client@x.test', otherRecipientCount: 0 })]);
  });

  it('R-GMAIL-5 property: only confirmed points match; one match per contact; the count never includes the contact itself or the mailbox; no address leaves the function', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(address, { minLength: 1, maxLength: 10 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
        fc.array(fc.tuple(fc.nat(), fc.constantFrom('to', 'cc', 'bcc')), { maxLength: 8 }),
        (addrs, confirmedIdx, recips) => {
          const from = addrs[0]!;
          const mailbox = addrs[addrs.length - 1]!;
          const to: string[] = [];
          const cc: string[] = [];
          const bcc: string[] = [];
          for (const [i, r] of recips) ({ to, cc, bcc })[r as 'to' | 'cc' | 'bcc'].push(addrs[i % addrs.length]!);
          const pts = [...new Set(confirmedIdx.map((i) => addrs[i % addrs.length]!))].filter((a) => a !== mailbox).map((a, i) => point(`c${i % 2}`, a));
          const out = matchMailParticipants({ from: [from], to, cc, bcc }, pts, hmacOf, hmacOf(mailbox));
          const onMsg = new Set([from, ...to, ...cc, ...bcc]);
          expect(new Set(out.map((o) => o.contactId)).size).toBe(out.length);
          for (const o of out) {
            const p = pts.find((x) => x.pointId === o.pointId)!;
            expect(p.contactId).toBe(o.contactId);
            expect(onMsg.has(p.pointId.slice(2))).toBe(true);
            const own = new Set(pts.filter((x) => x.contactId === o.contactId).map((x) => x.pointId.slice(2)));
            const others = new Set([...to, ...cc, ...bcc].filter((a) => !own.has(a) && a !== mailbox));
            expect(o.otherRecipientCount).toBe(others.size);
            expect((o.role === 'from') === (o.sender === 'contact')).toBe(true);
            for (const a of addrs) expect(JSON.stringify({ ...o, pointId: '' })).not.toContain(a);
          }
          // every contact with a confirmed address on the message matched
          const want = new Set(pts.filter((p) => onMsg.has(p.pointId.slice(2))).map((p) => p.contactId));
          expect(new Set(out.map((o) => o.contactId))).toEqual(want);
        },
      ),
    );
  });

  it('mutation guard: an unconfirmed address never matches, even when it is on the message as From', () => {
    expect(matchMailParticipants({ from: ['stranger@x.test'], to: [me], cc: [], bcc: [] }, [], hmacOf, hmacOf(me))).toEqual([]);
  });
});

describe('stripQuoted (R-GMAIL-5, E207)', () => {
  it('E207: drops quoted history, the reply header and the signature', () => {
    const body = 'Sounds good, Thursday works.\n\nJane\n-- \nJane Doe | 555-0100\n\nOn Tue, Nov 10, 2026 at 9:00 AM Agent <a@b.test> wrote:\n> Can we meet?\n';
    expect(stripQuoted(body)).toEqual({ text: 'Sounds good, Thursday works.\n\nJane', truncated: false });
    expect(stripQuoted('Hi\n-----Original Message-----\nFrom: x\nold').text).toBe('Hi');
    expect(stripQuoted('Top\n> quoted\nbottom').text).toBe('Top\nbottom');
  });

  it('R-GMAIL-5: at most 20,000 characters, flagged; never splits a surrogate pair', () => {
    const r = stripQuoted('a'.repeat(19_999) + '😀' + 'b'.repeat(10));
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    expect(r.text.endsWith('a')).toBe(true);
  });

  it('property: never adds text (every kept line is an input line, in order), never longer than max, no quoted line survives, idempotent', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string({ maxLength: 40 }), fc.constant('> quoted'), fc.constant('-- '), fc.constant('On Mon, Jan 1 Bob wrote:')), { maxLength: 30 }), fc.integer({ min: 1, max: 400 }), (lines, max) => {
        const input = lines.join('\n');
        const out = stripQuoted(input, max);
        expect(out.text.length).toBeLessThanOrEqual(max);
        const inLines = input.replace(/\r\n?/g, '\n').split('\n');
        let j = 0;
        const outLines = out.text === '' ? [] : out.text.split('\n');
        for (const [k, l] of outLines.entries()) {
          if (out.truncated && k === outLines.length - 1) break; // the cut line is a prefix
          while (j < inLines.length && inLines[j] !== l) j++;
          expect(j).toBeLessThan(inLines.length);
          j++;
          expect(/^\s*>/.test(l)).toBe(false);
        }
        if (!out.truncated) expect(stripQuoted(out.text, max).text).toBe(out.text);
      }),
    );
  });
});

describe('rfcMessageIdSha256 and citations (R-GMAIL-12, S-D2-3)', () => {
  it('R-GMAIL-12: exactly module 22’s normalization (the same function), so a Reply-All hashes alike on both paths', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const a = rfcMessageIdSha256(s);
        const b = module22Hash(s);
        expect(a === null ? null : a.toString('hex')).toBe(b === null ? null : b.toString('hex'));
      }),
    );
    expect(rfcMessageIdSha256(' <Abc@Host.Example> ')!.toString('hex')).toBe(createHash('sha256').update('<Abc@Host.Example>').digest('hex'));
  });

  it('S-D2-3: gmailMessageRef is 64 hex, stable, and different per link', () => {
    expect(gmailMessageRef('l1', 'm1')).toMatch(/^[0-9a-f]{64}$/);
    expect(gmailMessageRef('l1', 'm1')).toBe(gmailMessageRef('l1', 'm1'));
    expect(gmailMessageRef('l1', 'm1')).not.toBe(gmailMessageRef('l2', 'm1'));
  });

  it('R-GMAIL-5: SPAM, TRASH, DRAFT and CHAT are never stored', () => {
    for (const l of ['SPAM', 'TRASH', 'DRAFT', 'CHAT']) expect(isSkipped(['INBOX', l])).toBe(true);
    expect(isSkipped(['INBOX', 'IMPORTANT', 'SENT'])).toBe(false);
  });
});
