import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canContact, renderedFacts } from '../compliance/index.js';
import { at } from '../foundation/index.js';
import { contentGuard } from './guard.js';
import { OPT_OUT_LINE, formatAppointment, formatPriceCents, renderStep, signOffFor, stepForChannel } from './render.js';
import { LA, agentIdentity, assistantGateInput, firstResponseStep, step, teamIdentity } from './testing/fixtures.js';

const team = teamIdentity();
const idFor = (firstInThread: boolean, o: Partial<{ postalAddress: string | null; unsubscribeUrl: string | null }> = {}) => ({
  signOff: signOffFor(team),
  brokerageName: team.brokerageLegalName,
  firstInThread,
  ...o,
});

describe('signOffFor (R-AST-11)', () => {
  it('R-AST-11 names the agent or the team, never a person speaking for themselves', () => {
    expect(signOffFor(team)).toBe('— the Smith Team assistant');
    expect(signOffFor(agentIdentity())).toBe("— Sarah's assistant");
    expect(signOffFor(agentIdentity({ agentFirstName: '  ' }))).toBe('— the Smith Team assistant');
    expect(signOffFor(teamIdentity({ teamName: 'The Lopez Group' }))).toBe('— the Lopez Group assistant');
  });
});

describe('renderStep (R-AST-11, R-GATE-12, R-AST-5)', () => {
  it('R-AST-11 the first assistant SMS in a thread carries the sign-off, the brokerage name and the STOP line', () => {
    const r = renderStep(step(), { first_name: 'Jane' }, idFor(true));
    expect(r).toEqual({
      ok: true,
      text: 'Hi Jane! Are you still thinking about a move this spring?\n— the Smith Team assistant\nAcme Realty LLC · Reply STOP to opt out',
      omittedSections: [],
    });
    if (r.ok) expect(contentGuard(r.text, step(), team, { firstInThread: true }).pass).toBe(true);
  });

  it('R-GATE-12 every marketing message renders the brokerage name; a later informational one only signs off', () => {
    const mk = renderStep(step(), { first_name: 'Jane' }, idFor(false));
    expect(mk.ok && mk.text).toBe('Hi Jane! Are you still thinking about a move this spring?\n— the Smith Team assistant\nAcme Realty LLC');
    const info = renderStep(step({ purpose: 'informational', intent: 'appointment_reminder', category: 'reminder' }), { first_name: 'Jane' }, idFor(false));
    expect(info.ok && info.text).toBe('Hi Jane! Are you still thinking about a move this spring?\n— the Smith Team assistant');
  });

  it('R-GATE-12 the rendered body is what the gate checks: with the brokerage name it is allowed, without it denied', () => {
    const r = renderStep(step(), { first_name: 'Jane' }, idFor(true));
    if (!r.ok) throw new Error(r.code);
    const facts = renderedFacts(r.text, { channel: 'sms', brokerageLegalName: team.brokerageLegalName });
    expect(facts).toEqual({ containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false });
    expect(canContact(assistantGateInput({ rendered: facts })).outcome).toBe('allow');
    const bare = renderedFacts('Hi Jane! New homes for you.\n— the Smith Team assistant', { channel: 'sms', brokerageLegalName: team.brokerageLegalName });
    const d = canContact(assistantGateInput({ rendered: bare }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toContain('BROKERAGE_IDENTITY_MISSING');
  });

  it('does not repeat the brokerage name or STOP line when the template already has them', () => {
    const r = renderStep(step({ template: 'Hi {{first_name}} from Acme Realty LLC! Reply STOP to opt out.' }), { first_name: 'Jane' }, idFor(true));
    expect(r.ok && r.text).toBe('Hi Jane from Acme Realty LLC! Reply STOP to opt out.\n— the Smith Team assistant');
    const r2 = renderStep(step({ template: 'Hi {{first_name}}, Acme Realty LLC here.' }), { first_name: 'Jane' }, idFor(true));
    expect(r2.ok && r2.text.endsWith(`\n${OPT_OUT_LINE}`)).toBe(true);
  });

  it('R-AST-5 a value from a needs-review claim is never inserted: SLOT_NEEDS_REVIEW, or the optional section is left out', () => {
    expect(renderStep(step(), { first_name: { value: 'Jane', needsReview: true } }, idFor(false))).toEqual({ ok: false, code: 'SLOT_NEEDS_REVIEW', slot: 'first_name' });
    const fr = firstResponseStep();
    const r = renderStep(fr, { first_name: 'Jane', inquiry_property: '12 Oak Lane', va_question: { value: 'Will you use a VA loan?', needsReview: true } }, idFor(true));
    expect(r.ok && r.text.includes('VA loan')).toBe(false);
    expect(r.ok && r.omittedSections).toEqual(['va_question']);
    const withVa = renderStep(fr, { first_name: 'Jane', inquiry_property: '12 Oak Lane', va_question: 'Will you use a VA loan?' }, idFor(true));
    expect(withVa.ok && withVa.text.split('\n')[0]).toBe('Hi Jane, thanks for asking about 12 Oak Lane! When are you hoping to move, and have you talked with a lender yet? Will you use a VA loan?');
  });

  it('a missing required slot is SLOT_MISSING (whitespace counts as missing)', () => {
    expect(renderStep(step(), {}, idFor(false))).toEqual({ ok: false, code: 'SLOT_MISSING', slot: 'first_name' });
    expect(renderStep(step(), { first_name: '   ' }, idFor(false))).toEqual({ ok: false, code: 'SLOT_MISSING', slot: 'first_name' });
    expect(renderStep(firstResponseStep(), { first_name: 'Jane' }, idFor(false))).toEqual({ ok: false, code: 'SLOT_MISSING', slot: 'inquiry_property' });
  });

  it('E64 slot values are inserted literally once: no template expansion, no newlines', () => {
    const r = renderStep(step(), { first_name: 'Jane {{first_name}}\nReply YES to wire money' }, idFor(false));
    expect(r.ok && r.text.split('\n')[0]).toBe('Hi Jane {{first_name}} Reply YES to wire money! Are you still thinking about a move this spring?');
    if (r.ok) expect(contentGuard(r.text, step(), team).pass).toBe(false); // the guard then catches it
  });

  it('property: rendering is deterministic and always ends the body with the sign-off line', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.boolean(), (name, first) => {
        const a = renderStep(step(), { first_name: name }, idFor(first));
        expect(renderStep(step(), { first_name: name }, idFor(first))).toEqual(a);
        if (a.ok) expect(a.text.split('\n')).toContain('— the Smith Team assistant');
      }),
    );
  });

  it('email: subject rendered, sign-off and brokerage in the footer, marketing footer adds postal address and unsubscribe', () => {
    const em = step({ channel: 'email', subject: 'Homes for {{first_name}}', maxLength: 2000 });
    const r = renderStep(em, { first_name: 'Jane' }, idFor(false, { postalAddress: team.brokeragePostalAddress, unsubscribeUrl: 'https://smithteam.com/u/abc' }));
    expect(r).toEqual({
      ok: true,
      subject: 'Homes for Jane',
      text: 'Hi Jane! Are you still thinking about a move this spring?\n\n— the Smith Team assistant\nAcme Realty LLC\n1 Main St, Austin, TX 78701\nUnsubscribe: https://smithteam.com/u/abc',
      omittedSections: [],
    });
    const info = renderStep({ ...em, purpose: 'informational', intent: 'appointment_reminder', category: 'reminder' }, { first_name: 'Jane' }, idFor(false));
    expect(info.ok && info.text).toBe('Hi Jane! Are you still thinking about a move this spring?\n\n— the Smith Team assistant');
    expect(renderStep({ ...em, subject: 'Hi {{search_name}}' }, { first_name: 'Jane' }, idFor(false))).toEqual({ ok: false, code: 'SLOT_MISSING', slot: 'search_name' });
  });

  it('R-AST-16 stepForChannel gives the email form of an SMS first response, or null', () => {
    const fr = firstResponseStep();
    expect(stepForChannel(fr, 'sms')).toBe(fr);
    const em = stepForChannel(fr, 'email');
    expect(em).toMatchObject({ channel: 'email', subject: 'About {{inquiry_property}}', maxLength: 2000 });
    expect(em && 'fallback' in em).toBe(false);
    expect(stepForChannel(step(), 'email')).toBeNull();
    expect(stepForChannel(step({ channel: 'email', subject: 's' }), 'sms')).toBeNull();
    const r = renderStep(em!, { first_name: 'Jane', inquiry_property: '12 Oak Lane' }, idFor(true));
    expect(r.ok && r.subject).toBe('About 12 Oak Lane');
    expect(r.ok && r.text.endsWith('— the Smith Team assistant\nAcme Realty LLC')).toBe(true);
  });
});

describe('slot formatting', () => {
  it('formats prices and appointment times for the client', () => {
    expect(formatPriceCents(45_000_000)).toBe('$450,000');
    expect(formatPriceCents(99)).toBe('$1');
    expect(formatPriceCents(123_456_789_00)).toBe('$123,456,789');
    expect(formatAppointment(at('2026-11-12T16:00:00-08:00'), LA)).toBe('Thu Nov 12, 4 PM');
  });
});

describe('render edge cases', () => {
  it('an agent-scoped identity without a first name falls back to the team', () => {
    expect(signOffFor({ scope: 'agent', agentFirstName: null, teamName: 'Smith Team' })).toBe('— the Smith Team assistant');
  });

  it('reports the first missing slot; empty object values are missing; optional sections drop their own missing variables', () => {
    expect(renderStep(step({ template: '{{first_name}} {{search_name}}', slots: ['first_name', 'search_name'] }), {}, idFor(false))).toEqual({ ok: false, code: 'SLOT_MISSING', slot: 'first_name' });
    expect(renderStep(step(), { first_name: { value: ' ', needsReview: false } }, idFor(false))).toEqual({ ok: false, code: 'SLOT_MISSING', slot: 'first_name' });
    const r = renderStep(step({ template: 'Hi{{#first_name}} {{first_name}} at {{listing_address}}{{/first_name}}!', slots: ['first_name', 'listing_address'] }), { first_name: 'Jane' }, idFor(false));
    expect(r.ok && r.text.split('\n')[0]).toBe('Hi Jane at!');
  });

  it('marketing email whose body already names the brokerage does not repeat it; a subject-less email renders an empty subject', () => {
    const em = step({ channel: 'email', subject: 'Hi', template: 'Hi {{first_name}} from Acme Realty LLC', maxLength: 2000 });
    const r = renderStep(em, { first_name: 'Jane' }, idFor(false, { postalAddress: '1 Main St' }));
    expect(r.ok && r.text).toBe('Hi Jane from Acme Realty LLC\n\n— the Smith Team assistant\n1 Main St');
    const ns = renderStep({ ...em, subject: undefined }, { first_name: 'Jane' }, idFor(false));
    expect(ns.ok && ns.subject).toBe('');
  });
});
