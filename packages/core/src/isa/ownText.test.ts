import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import { clientOwnText, isTeamText, negatedBefore, qualValueQuoted, timelineDays } from './ownText.js';
import { NOW, NY } from './testing/fixtures.js';

const ctx = (ownText: string) => ({ ownText, saidAt: NOW, zone: NY });

describe('R-ISA-27 clientOwnText: quoted history and signatures are never client own text', () => {
  it('SMS is its own text as written', () => {
    expect(clientOwnText('  2 works  ', 'sms')).toEqual({ text: '2 works', reliable: true, stripped: [], truncated: false });
  });
  it('E495 Gmail: "On … wrote:" and everything after it is dropped', () => {
    const body = 'Sounds good, we are preapproved.\n\nOn Tue, Nov 17, 2026 at 3:00 PM Avery Assistant <ai@example.test> wrote:\n> Are you preapproved or cash?\n> 1) Tue Nov 17, 3:00–3:30 PM ET';
    const o = clientOwnText(body, 'email');
    expect(o.text).toBe('Sounds good, we are preapproved.');
    expect(o.reliable).toBe(true);
    expect(o.stripped).toContain('reply_header');
  });
  it('E495 a wrapped Gmail header over two lines is dropped too', () => {
    const o = clientOwnText('2\n\nOn Tue, Nov 17, 2026 at 3:00 PM Avery Assistant\n<ai@example.test> wrote:\n> Here are times', 'email');
    expect(o.text).toBe('2');
  });
  it('Apple Mail "On Nov 17, 2026, at 3:00 PM, X wrote:"', () => {
    expect(clientOwnText('Yes please\n\nOn Nov 17, 2026, at 3:00 PM, Maple Team <t@example.test> wrote:\n\nHere are times', 'email').text).toBe('Yes please');
  });
  it('Outlook: "-----Original Message-----", the underscore rule and From:/Sent: blocks', () => {
    expect(clientOwnText('Option 2\n-----Original Message-----\nFrom: Team\nSent: Monday\n1) Tue', 'email').text).toBe('Option 2');
    expect(clientOwnText('Option 2\n________________________________\nFrom: Team\nSent: Monday', 'email').text).toBe('Option 2');
    expect(clientOwnText('Option 2\n\nFrom: Maple Team <t@example.test>\nSent: Tuesday, November 17, 2026 3:00 PM\nTo: me\nSubject: times', 'email').text).toBe('Option 2');
  });
  it('forwarded messages are cut', () => {
    expect(clientOwnText('see below\n---------- Forwarded message ---------\nFrom: x', 'email').text).toBe('see below');
    expect(clientOwnText('fyi\nBegin forwarded message:\n\nFrom: x', 'email').text).toBe('fyi');
  });
  it('signatures: "-- " and "Sent from my iPhone" are dropped', () => {
    expect(clientOwnText('We want 3 beds\n-- \nJordan Sample\n555 Elm', 'email').text).toBe('We want 3 beds');
    expect(clientOwnText('We want 3 beds\n\nSent from my iPhone', 'email').text).toBe('We want 3 beds');
    expect(clientOwnText('ok\nGet Outlook for iOS', 'email').text).toBe('ok');
  });
  it('">" lines are dropped; an inline (interleaved) reply is unreliable', () => {
    const top = clientOwnText('Two works\n> 1) Tue\n> 2) Wed', 'email');
    expect(top.text).toBe('Two works');
    expect(top.reliable).toBe(true);
    const inline = clientOwnText('> Which time works?\nTwo\n> Are you preapproved?\nyes', 'email');
    expect(inline.reliable).toBe(false);
  });
  it('a surviving header line makes the split unreliable', () => {
    expect(clientOwnText('ok then\nSubject: hello', 'email').reliable).toBe(false);
  });
  it('bodies over 1,600 characters are truncated and flagged', () => {
    const o = clientOwnText('a'.repeat(2000), 'sms');
    expect(o.text.length).toBe(1600);
    expect(o.truncated).toBe(true);
  });
});

describe('R-ISA-27 QUOTE_IS_TEAM_TEXT', () => {
  const team = ['Are you preapproved or paying cash?', 'Here are times Avery is free:\n1) Tue Nov 17, 3:00–3:30 PM ET\n2) Wed Nov 18, 10:00–10:30 AM ET'];
  it('E495 a pasted slot line or the AI\'s own question is team text', () => {
    expect(isTeamText('Tue Nov 17, 3:00–3:30 PM ET', team)).toBe(true);
    expect(isTeamText('preapproved or paying cash', team)).toBe(true);
    expect(isTeamText('ARE YOU   PREAPPROVED or paying cash', team)).toBe(true);
  });
  it('short answers ("2", "yes") are never team text', () => {
    expect(isTeamText('2', team)).toBe(false);
    expect(isTeamText('yes', team)).toBe(false);
  });
  it('the client\'s own words are not team text', () => {
    expect(isTeamText('we are preapproved with our bank', team)).toBe(false);
  });
});

describe('R-ISA-12 R-ISA-27 qualValueQuoted', () => {
  it('E504 statements of financing verify their enum value', () => {
    expect(qualValueQuoted('financing_status_stated', 'preapproved', "We're preapproved", ctx("We're preapproved"))).toBe(true);
    expect(qualValueQuoted('financing_status_stated', 'cash', 'paying all cash', ctx('we are paying all cash'))).toBe(true);
    expect(qualValueQuoted('financing_status_stated', 'talking_to_lender', 'talking to a lender', ctx('talking to a lender'))).toBe(true);
    expect(qualValueQuoted('financing_status_stated', 'cash', "We're preapproved", ctx("We're preapproved"))).toBe(false);
  });
  it('E507 a negated value is never usable: "we\'re not preapproved yet"', () => {
    expect(qualValueQuoted('financing_status_stated', 'preapproved', 'preapproved yet', ctx("we're not preapproved yet"))).toBe(false);
    expect(qualValueQuoted('financing_status_stated', 'preapproved', "we're not preapproved yet", ctx("we're not preapproved yet"))).toBe(false);
    expect(qualValueQuoted('financing_status_stated', 'not_started', 'not preapproved yet', ctx("we're not preapproved yet"))).toBe(true);
  });
  it('the negation is read in the own text, so cutting "not" off the quote does not help', () => {
    expect(qualValueQuoted('financing_status_stated', 'preapproved', 'preapproved', ctx('we are not preapproved'))).toBe(false);
    expect(qualValueQuoted('budget', 450000, '450k', ctx('we do not have 450k'))).toBe(false);
  });
  it('a quote that is not in the own text fails', () => {
    expect(qualValueQuoted('financing_status_stated', 'preapproved', 'we are preapproved', ctx('we are thinking about it'))).toBe(false);
  });
  it('amounts, beds, baths, areas and types must be in the quote', () => {
    expect(qualValueQuoted('budget', 450000, 'budget is around 450k', ctx('Our budget is around 450k'))).toBe(true);
    expect(qualValueQuoted('budget', 900000, 'budget is around 450k', ctx('Our budget is around 450k'))).toBe(false);
    expect(qualValueQuoted('beds_min', 3, '3 bedrooms', ctx('we need 3 bedrooms and 2 baths'))).toBe(true);
    expect(qualValueQuoted('baths_min', 2, '2 baths', ctx('we need 3 bedrooms and 2 baths'))).toBe(true);
    expect(qualValueQuoted('beds_min', 4, '3 bedrooms', ctx('we need 3 bedrooms'))).toBe(false);
    expect(qualValueQuoted('areas', ['Springfield', '62701'], 'Springfield or 62701', ctx('looking in Springfield or 62701'))).toBe(true);
    expect(qualValueQuoted('areas', ['Shelbyville'], 'Springfield or 62701', ctx('looking in Springfield or 62701'))).toBe(false);
    expect(qualValueQuoted('property_type', 'townhouse', 'a townhouse', ctx('a townhouse would be great'))).toBe(true);
    expect(qualValueQuoted('property_type', 'condo', 'a townhouse', ctx('a townhouse would be great'))).toBe(false);
  });
  it('booleans need the affirmative pattern; false needs it negated', () => {
    expect(qualValueQuoted('seller_owns_stated', true, 'we own the house outright', ctx('we own the house outright'))).toBe(true);
    expect(qualValueQuoted('seller_owns_stated', true, "we don't own", ctx("we don't own it, we rent"))).toBe(false);
    expect(qualValueQuoted('seller_listed_elsewhere_stated', false, "it's not listed with anyone", ctx("it's not listed with anyone"))).toBe(true);
    expect(qualValueQuoted('seller_listed_elsewhere_stated', true, "it's not listed with anyone", ctx("it's not listed with anyone"))).toBe(false);
    expect(qualValueQuoted('wants_agent_contact', true, 'call me', ctx('call me tomorrow'))).toBe(true);
    expect(qualValueQuoted('wants_agent_contact', true, 'call me', ctx("please don't call me"))).toBe(false);
    expect(qualValueQuoted('wants_agent_contact', 'yes', 'call me', ctx('call me'))).toBe(false);
  });
  it('timelines go through resolveRelativeDate and the timeline grammar', () => {
    expect(qualValueQuoted('timeline', 'in the next 2 months', 'move in the next 2 months', ctx('we want to move in the next 2 months'))).toBe(true);
    expect(qualValueQuoted('seller_timeline', 'by March', 'selling by March', ctx('thinking of selling by March'))).toBe(true);
    expect(qualValueQuoted('timeline', 'someday', 'someday', ctx('someday'))).toBe(false);
    expect(qualValueQuoted('timeline', 'next month', 'not next month', ctx('not next month'))).toBe(false);
  });
  it('wrong value types and invalid inputs fail closed', () => {
    expect(qualValueQuoted('budget', 'lots', '450k', ctx('450k'))).toBe(false);
    expect(qualValueQuoted('financing_status_stated', 'gift', 'gift', ctx('gift'))).toBe(false);
    expect(qualValueQuoted('areas', [], 'x', ctx('x'))).toBe(false);
    expect(qualValueQuoted('budget', 1, '', ctx('1'))).toBe(false);
    expect(qualValueQuoted('budget', 1, 'x'.repeat(201), ctx('x'.repeat(201)))).toBe(false);
    expect(qualValueQuoted('must_haves_structured', ['garage'], 'a garage', ctx('we need a garage'))).toBe(true);
    expect(qualValueQuoted('must_haves_structured', ['pool'], 'a garage', ctx('we need a garage'))).toBe(false);
    expect(qualValueQuoted('seller_motivation', 'relocating for work', 'relocating for work', ctx('we are relocating for work'))).toBe(true);
    expect(qualValueQuoted('seller_next_move', 'renting', 'renting', ctx('not renting'))).toBe(false);
  });
  it('property: a quote whose value-bearing hit has a negator right before it never yields a usable positive value', () => {
    const negators = ['not', "don't", 'never', 'no', "aren't", "haven't", 'without'];
    fc.assert(
      fc.property(fc.constantFrom(...negators), fc.constantFrom('preapproved', 'pre-approved', 'cash', 'a lender'), fc.constantFrom('we are', 'i', 'we', ''), (neg, term, lead) => {
        const own = `${lead} ${neg} ${term}`.trim();
        const value = term === 'cash' ? 'cash' : term === 'a lender' ? 'talking_to_lender' : 'preapproved';
        expect(qualValueQuoted('financing_status_stated', value, own, ctx(own))).toBe(false);
        expect(qualValueQuoted('financing_status_stated', value, term, ctx(own))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe('timelineDays', () => {
  const said = at('2026-11-12T15:00:00Z');
  it('bounds what it can and refuses what it cannot', () => {
    expect(timelineDays('asap', said, NY)).toBe(0);
    expect(timelineDays('in 3 weeks', said, NY)).toBe(21);
    expect(timelineDays('within 60 days', said, NY)).toBe(60);
    expect(timelineDays('in two months', said, NY)).toBe(62);
    expect(timelineDays('this month', said, NY)).toBe(19);
    expect(timelineDays('next month', said, NY)).toBe(50);
    expect(timelineDays('by March', said, NY)).toBe(140);
    expect(timelineDays('in December', said, NY)).toBe(50);
    expect(timelineDays('tomorrow', said, NY)).toBe(1);
    expect(timelineDays('next spring', said, NY)).toBeNull();
    expect(timelineDays('', said, NY)).toBeNull();
    expect(timelineDays('a few months', said, NY)).toBeNull();
  });
  it('negatedBefore reads the clause only', () => {
    expect(negatedBefore("we're not ")).toBe(true);
    expect(negatedBefore('not now. but we are ')).toBe(false);
    expect(negatedBefore("we haven't yet ")).toBe(true);
  });
});
