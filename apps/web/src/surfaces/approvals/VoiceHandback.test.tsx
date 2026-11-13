// The voice handback card (module 55 item 9) in the Approvals inbox, on the staff contract: the detector, the worded
// code-built claims (E662), "What the assistant did" from GET /calls/:id/voice with 404, in-progress and recovered
// (E666), the kept one-tap Send of a confirmation draft (R-VOICE-17), Call back, the opted-out branch (E665), every
// other kind keeping the generic card, and an ai_isa kind never listed at all (module 76's inbox filter, batch 13). No
// /voice settings route is ever requested from here.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { agentApp } from '../feed/lib/testing.js';
import type { ActionView, ClaimApiView } from '../feed/lib/types.js';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { IDS, RAW_CODE, axeViolations, callVoice } from '../voice/testing.js';
import { CALL_DETAILS_UNAVAILABLE, FROM_CALL_RECORD, NO_CALLER_WORDS, OPTED_OUT_CARD, VOICE_HANDBACK_LABEL, isVoiceHandback, voiceHandbackOf } from './VoiceHandback.js';

const CALL_VOICE = `GET /calls/${IDS.call}/voice`;
const APPROVE = `POST /assistant/actions/${IDS.handback}/approve`;

const fieldClaim = (id: string, text: string, field: string, snippet: string, sourceType: 'call' | 'appointment' = 'call', sourceId: string = IDS.call): ClaimApiView => ({
  id,
  kind: 'fact',
  text,
  needsReview: false,
  reviewStatus: 'unreviewed',
  due: null,
  // the label the API builds from the field (core formatEvidence) carries the raw stored value
  evidence: [{ sourceType, sourceId, locator: { kind: 'field', field }, snippet, verified: true, sourceAvailable: true, label: `“${snippet}” (${field.replace(/_/g, ' ')}) in the call` }],
});

/** A voice handback as GET /assistant/inbox answered it in a real run (ids synthetic). */
function voiceHandback(outcome: string, over: Partial<ActionView> = {}): ActionView {
  const sentence: Record<string, string> = { booked: 'The assistant booked a time with you.', message_taken: 'The assistant took a message for you.', opted_out: 'The caller asked not to be contacted.' };
  return {
    id: IDS.handback,
    kind: 'handback',
    category: 'internal',
    status: 'proposed',
    contactId: IDS.contact,
    contactName: 'Jane Doe',
    explanation: 'The assistant answered a missed call and took a message for you.',
    primaryAction: 'acknowledge',
    draft: null,
    claims: [
      fieldClaim('01900000-0000-7000-8000-0000000055d1', 'The assistant answered at Fri Nov 13, 2:11 PM.', 'ai_takeover_at', '2026-11-13T14:11:50.617Z'),
      fieldClaim('01900000-0000-7000-8000-0000000055d2', sentence[outcome] ?? 'The call ended.', 'voice_outcome', outcome),
      { id: '01900000-0000-7000-8000-0000000055d3', kind: 'fact', text: 'Message topic: price.', needsReview: true, reviewStatus: 'unreviewed', due: null, evidence: [] },
    ],
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
  };
}

function booked(): ActionView {
  const b = voiceHandback('booked', {
    explanation: 'The assistant answered a missed call and booked a time with you. Check the details.',
    primaryAction: 'send',
    draft: { channel: 'sms', subject: null, body: 'Hi Jane, you are all set for Fri Nov 13, 4:30 PM. Reply here if you need to change it.' },
  });
  b.claims = [...b.claims.slice(0, 2), fieldClaim('01900000-0000-7000-8000-0000000055d4', 'Booked for Fri Nov 13, 4:30 PM.', 'starts_at', '2026-11-13T16:30:00.000Z', 'appointment', IDS.appointment)];
  return b;
}

function inbox(items: ActionView[]) {
  return new StaffFake().on('GET /assistant/inbox', { status: 200, body: { items } }).on('GET /marketing/approvals', { status: 200, body: { pieces: [] } });
}

async function card(fake: StaffFake, role: 'agent' | 'owner' | 'team_lead' | 'isa' | 'tc' = 'agent') {
  agentApp(fake, '/approvals', role);
  return (await screen.findByRole('heading', { level: 2, name: 'Jane Doe' })).closest('article')!;
}

const text = () => document.body.textContent ?? '';
/** ActionCard's header line ("{label} · {time}"), the first line of the card */
const headerOf = (c: HTMLElement) => c.querySelector('p')?.textContent ?? '';
const noVoiceSettings = (fake: StaffFake) => expect(fake.calls.filter((c) => c.path.startsWith('/voice/'))).toEqual([]);

describe('R-STAFF-9: the voice handback detector', () => {
  it('a handback with a call claim at the field voice_outcome is one; its snippet is the outcome and its sourceId the call', () => {
    expect(voiceHandbackOf(voiceHandback('opted_out'))).toEqual({ callId: IDS.call, outcome: 'opted_out' });
    expect(isVoiceHandback(booked())).toBe(true);
  });

  it('anything else is not: another kind (an ai_isa one too), another field, another source, or no claims', () => {
    const v = voiceHandback('booked');
    expect(isVoiceHandback({ ...v, kind: 'ai_isa_handoff' })).toBe(false);
    expect(isVoiceHandback({ ...v, kind: 'call_summary' })).toBe(false);
    expect(isVoiceHandback({ ...v, claims: [fieldClaim('01900000-0000-7000-8000-0000000055e1', 'x', 'transfer_outcome', 'connected')] })).toBe(false);
    expect(isVoiceHandback({ ...v, claims: [fieldClaim('01900000-0000-7000-8000-0000000055e1', 'x', 'voice_outcome', 'booked', 'appointment')] })).toBe(false);
    expect(isVoiceHandback({ ...v, claims: [] })).toBe(false);
  });
});

describe('R-STAFF-9 E662: the card shows the stored call fields in words, never the stored value', () => {
  it('message taken: the label, each field claim with "From the call record", the needs-review claim, Reply, Mark handled and Call back', async () => {
    const fake = inbox([voiceHandback('message_taken')]);
    const c = await card(fake);
    // brief item 9: the card's header is the label, said once; never "Replied to the assistant" (the feed label is module 18a's)
    expect(headerOf(c)).toMatch(new RegExp(`^${VOICE_HANDBACK_LABEL} · `));
    expect(c.textContent!.split(VOICE_HANDBACK_LABEL)).toHaveLength(2);
    expect(c.textContent).not.toContain('Replied to the assistant');
    expect(within(c).getByText('The assistant answered at Fri Nov 13, 2:11 PM.')).toBeInTheDocument();
    expect(within(c).getByText('The assistant took a message for you.')).toBeInTheDocument();
    expect(within(c).getAllByText(FROM_CALL_RECORD)).toHaveLength(2);
    expect(within(c).getByText('Message topic: price.')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Looks right' })).toBeInTheDocument();
    // never the stored value or the API's evidence label
    expect(text()).not.toMatch(/message_taken|ai takeover at|voice outcome/);
    expect(text()).not.toMatch(RAW_CODE);
    expect(within(c).getByRole('link', { name: 'Reply' })).toHaveAttribute('href', `/contacts/${IDS.contact}/thread?compose=sms`);
    expect(within(c).getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: 'Call back' })).toHaveAttribute('href', `/contacts/${IDS.contact}`);
    expect(within(c).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    noVoiceSettings(fake);
  });

  it('R-VOICE-17 E664: a booked call keeps the one-tap Send of the confirmation draft (and Edit); the appointment claim is worded too', async () => {
    const fake = inbox([booked()]).on(APPROVE, { status: 200, body: { actionId: IDS.handback, status: 'approved', result: 'sent', messageId: '01900000-0000-7000-8000-0000000055f1', decision: null } });
    const c = await card(fake);
    expect(within(c).getByText('Booked for Fri Nov 13, 4:30 PM.')).toBeInTheDocument();
    expect(within(c).getAllByText(FROM_CALL_RECORD)).toHaveLength(3);
    expect(within(c).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(c).queryByRole('link', { name: 'Reply' })).toBeNull();
    expect(text()).not.toMatch(RAW_CODE);
    await userEvent.click(within(c).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.callsTo(APPROVE)).toHaveLength(1));
    noVoiceSettings(fake);
  });

  it('Mark handled is the existing approve, one tap', async () => {
    const fake = inbox([voiceHandback('message_taken')]).on(APPROVE, { status: 200, body: { actionId: IDS.handback, status: 'approved', result: 'acknowledged', messageId: null, decision: null } });
    const c = await card(fake);
    await userEvent.click(within(c).getByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(fake.callsTo(APPROVE)).toHaveLength(1));
  });
});

describe('R-STAFF-9 E665: a caller who opted out', () => {
  it('gets no Reply and no Call back; the card says they asked not to be contacted', async () => {
    const fake = inbox([voiceHandback('opted_out')]);
    const c = await card(fake);
    expect(within(c).getByText(OPTED_OUT_CARD)).toBeInTheDocument();
    expect(within(c).queryByRole('link', { name: 'Reply' })).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(within(c).queryByRole('link', { name: 'Call back' })).toBeNull();
    expect(within(c).getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
    expect(text()).not.toMatch(/opted_out/);
    expect(text()).not.toMatch(RAW_CODE);
  });
});

describe('R-STAFF-9 E666: what the assistant did, from the call record only', () => {
  it('ended: the sentences, the takeover time, the end, the ledger and unlogged rows in words, no arguments, no caller words', async () => {
    const fake = inbox([voiceHandback('booked')]).on(CALL_VOICE, { status: 200, body: callVoice({ transferOutcome: 'no_answer' }) });
    const c = await card(fake);
    expect(fake.callsTo(CALL_VOICE)).toHaveLength(0); // read only when asked
    await userEvent.click(within(c).getByRole('button', { name: 'What the assistant did' }));
    expect(await within(c).findByText('The assistant answered this call and handed it back.')).toBeInTheDocument();
    expect(within(c).getByText(/^The assistant took the call at /)).toBeInTheDocument();
    expect(within(c).getByText('The assistant ended the call.')).toBeInTheDocument();
    expect(within(c).getByText('The transfer was not picked up in time.')).toBeInTheDocument();
    const ledger = within(c).getByRole('list', { name: 'What the assistant asked to do' });
    expect(within(ledger).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Check free times: allowed, because checking free times is allowed.',
      'Book a time: allowed, because the time was one of the times offered.',
      'End the call: allowed, because ending the call is allowed.',
    ]);
    expect(within(c).getByRole('list', { name: 'Requests not logged' })).toHaveTextContent(/A request was refused and not logged, because the caller had not yet heard/);
    expect(within(c).getByText(NO_CALLER_WORDS)).toBeInTheDocument();
    expect(text()).not.toMatch(/buyer_consult|BOOKED|slot_start/);
    expect(text()).not.toMatch(RAW_CODE);
    // one read per open (StrictMode may mount the query twice in development); nothing before the tap
    expect(fake.callsTo(CALL_VOICE).length).toBeGreaterThanOrEqual(1);
    expect(fake.calls.filter((x) => x.path.startsWith('/calls/') && x.path !== `/calls/${IDS.call}/voice`)).toEqual([]);
    noVoiceSettings(fake);
  });

  it('a 404 (not the recipient, RLS) says the details are not available, nothing inferred', async () => {
    const fake = inbox([voiceHandback('message_taken')]).on(CALL_VOICE, staffError('NOT_FOUND'));
    const c = await card(fake);
    await userEvent.click(within(c).getByRole('button', { name: 'What the assistant did' }));
    expect(await within(c).findByText(CALL_DETAILS_UNAVAILABLE)).toBeInTheDocument();
    expect(within(c).queryByText(NO_CALLER_WORDS)).toBeNull();
  });

  it.each([
    ['in_progress', 'The assistant is on this call now.'],
    ['recovered', 'The assistant lost this call; the handback was written afterwards.'],
  ] as const)('%s: the server sentence only', async (state, sentence) => {
    const fake = inbox([voiceHandback('message_taken')]).on(CALL_VOICE, { status: 200, body: callVoice({ state, sentence, ledger: [], unlogged: [] }) });
    const c = await card(fake);
    await userEvent.click(within(c).getByRole('button', { name: 'What the assistant did' }));
    expect(await within(c).findByText(sentence)).toBeInTheDocument();
    expect(within(c).queryByRole('list', { name: 'What the assistant asked to do' })).toBeNull();
  });
});

describe('R-STAFF-6: other cards and roles', () => {
  it('a handback that is not a voice one keeps the generic card (its own header, Reply as a button, no label, no Call back)', async () => {
    const plain = voiceHandback('message_taken', { claims: [] });
    const fake = inbox([plain]);
    const c = await card(fake);
    expect(headerOf(c)).toMatch(/^Replied to the assistant · /);
    expect(c.textContent).not.toContain(VOICE_HANDBACK_LABEL);
    expect(within(c).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(within(c).queryByRole('link', { name: 'Call back' })).toBeNull();
  });

  // Batch 14 merge: module 76 (ISA-4, batch 13) drops ai_isa_message and ai_isa_handoff from every inbox consumer
  // (useInbox's withoutAiActions), so an ai_isa kind with a call claim never reaches a card, voice or generic. The
  // detector half (isVoiceHandback is false for an ai_isa kind) is the 'anything else is not' test above.
  it('an ai_isa kind with a call claim is never listed, so it never gets the voice card', async () => {
    const ai = voiceHandback('message_taken', { id: '01900000-0000-7000-8000-0000000055f1', kind: 'ai_isa_handoff', contactName: 'Sam Sample' });
    const fake = inbox([ai, voiceHandback('message_taken')]);
    const c = await card(fake);
    expect(headerOf(c)).toMatch(/^The assistant answered a call · /);
    expect(screen.queryByRole('heading', { level: 2, name: 'Sam Sample' })).toBeNull();
    expect(screen.getAllByText(VOICE_HANDBACK_LABEL, { exact: false })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
  });

  it.each(['team_lead', 'isa', 'tc', 'owner'] as const)('%s: the card requests no /voice settings route', async (role) => {
    const fake = inbox([voiceHandback('message_taken')]).on(CALL_VOICE, { status: 200, body: callVoice() });
    const c = await card(fake, role);
    await userEvent.click(within(c).getByRole('button', { name: 'What the assistant did' }));
    await within(c).findByText(NO_CALLER_WORDS);
    noVoiceSettings(fake);
  });
});
