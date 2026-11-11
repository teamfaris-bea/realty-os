// Module 37 adversarial tests (critical module): try to make the inbox send where it must not, or speak for
// the server where it must not.
//   opt-outs (D1, R-PAR-12)  a blocked channel cannot be reached by any tap: not by its disabled option, not by
//                            Enter, not by an assistant draft written for it, not by an ended chat falling back
//   autonomy                 nothing is ever sent without the agent's own Send tap (a draft or a web chat is never
//                            sent on load, and an ended chat is never retried on another channel by itself)
//   tenancy                  the box writes only to the contact it was opened for
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, decision, draftAction, err, fullContact, iso, reachability, stopReason, timelineItem } from '../feed/lib/testing.js';

const user = () => userEvent.setup();
const removedStop = stopReason({ otherAddress: true, addressHint: '•••-•••-0199', addressRemoved: true });

function fake(items = [timelineItem({ detail: 'web_chat:inbound', preview: 'still there?', occurredAt: iso(-60_000) }), timelineItem({ id: '01900000-0000-7000-8000-0000000e5598', detail: 'sms:inbound', occurredAt: iso(-3_600_000) })]) {
  return new FakeFetch()
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items, nextCursor: null } })
    .on(`POST /contacts/${IDS.jane}/messages/preview`, { status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: '' } });
}

/** Every request that could send anything. */
const sends = (f: FakeFetch) => f.calls.filter((c) => c.method === 'POST' && (/\/messages$/.test(c.path) || /\/approve$/.test(c.path)));

describe('module 37 adversarial', () => {
  it('R-PAR-12 D1: a STOP from a removed phone: clicking the disabled Text option, pressing Enter and tapping Send never send a text', async () => {
    const f = fake().on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [removedStop] }) } }).on(`POST /contacts/${IDS.jane}/messages`, err(409, 'CHANNEL_NOT_CONNECTED'));
    agentApp(f, `/contacts/${IDS.jane}/thread?compose=sms`);
    const text = await screen.findByRole('radio', { name: 'Text' });
    await waitFor(() => expect(text).toBeDisabled());
    // force the click on the disabled option (fireEvent ignores pointer-events): the box stays off Text
    fireEvent.click(text);
    expect(text).not.toBeChecked();
    // the box is on web chat (where Jane wrote last); the chat has ended: the fallback is email, never text
    const box = screen.getByRole('textbox', { name: 'Web chat message' });
    await user().type(box, 'Hello{Enter}');
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not sent: the chat has ended/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Email' })).toBeChecked();
    expect(screen.getByText(/Send now sends it by email\./)).toBeInTheDocument();
    expect(sends(f).every((c) => (c.body as { channel?: string }).channel !== 'sms')).toBe(true);
    // autonomy: the ended chat was not retried by email on the agent's behalf
    expect(sends(f).map((c) => (c.body as { channel?: string }).channel)).toEqual(['web_chat']);
  });

  it('D1: an assistant draft written for text, opened while texting is blocked, is never approved as a text: the box moves it to email and says why', async () => {
    const f = fake([timelineItem({ detail: 'sms:inbound', occurredAt: iso(-60_000) })])
      .on(`GET /contacts/${IDS.jane}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane, { sms: [stopReason()] }) } })
      .on(`GET /assistant/actions/${IDS.draft}`, { status: 200, body: { action: draftAction() } })
      .on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } });
    agentApp(f, `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    const box = await screen.findByRole('textbox', { name: 'Email message' });
    await waitFor(() => expect(box).toHaveValue('Hi Jane, Saturday at 11 works. Want me to book it?'));
    expect(screen.getByRole('radio', { name: 'Text' })).toBeDisabled();
    expect(screen.getByTestId('channel-why')).toHaveTextContent('Writing by email: texting is blocked.');
    // autonomy: loading a draft sends nothing
    expect(sends(f)).toEqual([]);
    await user().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sends(f)).toHaveLength(1));
    expect(sends(f)[0]!.body).toMatchObject({ editedPayload: { channel: 'email', body: 'Hi Jane, Saturday at 11 works. Want me to book it?' } });
  });

  it('autonomy: a thread with a live web chat sends nothing until the agent taps Send, and an empty box never sends', async () => {
    const f = fake().on(`POST /contacts/${IDS.jane}/messages`, { status: 201, body: { message: null, decision: decision({}), result: 'sent' } });
    agentApp(f, `/contacts/${IDS.jane}/thread?compose=draft`);
    const chat = await screen.findByRole('radio', { name: 'Web chat' });
    await waitFor(() => expect(chat).toBeChecked());
    await new Promise((r) => setTimeout(r, 50));
    expect(sends(f)).toEqual([]);
    await user().type(screen.getByRole('textbox', { name: 'Web chat message' }), '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(sends(f)).toEqual([]);
  });

  it('tenancy: the web-chat reply goes to the contact the thread is for, by its id in the route, and carries no other contact or address', async () => {
    const f = fake().on(`POST /contacts/${IDS.jane}/messages`, { status: 201, body: { message: null, decision: decision({}), result: 'sent' } });
    agentApp(f, `/contacts/${IDS.jane}/thread`);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Web chat' })).toBeChecked());
    await user().type(screen.getByRole('textbox', { name: 'Web chat message' }), 'Hi');
    await user().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sends(f)).toHaveLength(1));
    expect(sends(f)[0]!.path).toBe(`/contacts/${IDS.jane}/messages`);
    expect(Object.keys(sends(f)[0]!.body as object).sort()).toEqual(['body', 'channel', 'idempotencyKey']);
  });
});
