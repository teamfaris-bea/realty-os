// R-MMS-9: the SMS segment counter under the compose box: the text as it will be sent (the preview's rendering,
// brokerage line included) or the typed words, the sender's part size, the characters that force the larger
// encoding named in words, a text over 1,600 characters refused, and "Use plain quotes".
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, decision, fullContact, timelineItem } from '../feed/lib/testing.js';
import { characterName, counterView, nameList, plainQuotes } from './SegmentCounter.js';

const user = () => userEvent.setup();
const view = (typed: string, o: { final?: string | null; sender?: 'local' | 'toll_free' } = {}) => counterView({ typed, final: o.final ?? null, sender: o.sender ?? 'local', media: null });

/** Jane's thread; the preview renders the text as `render` says (the brokerage line on a marketing text) from `sender`. */
function threadFake(render: (body: string) => string = (b) => b, sender: 'local' | 'toll_free' | null = 'local') {
  return new FakeFetch()
    .on(`GET /contacts/${IDS.jane}`, { status: 200, body: { contact: fullContact() } })
    .on(`GET /contacts/${IDS.jane}/timeline?limit=100`, { status: 200, body: { items: [timelineItem()], nextCursor: null } })
    .on(`POST /contacts/${IDS.jane}/messages/preview`, (c) => ({ status: 200, body: { decision: decision({ id: null, phase: 'preview' }), body: render((c.body as { body: string }).body), textSender: sender } }));
}

async function openText(fake: FakeFetch) {
  agentApp(fake, `/contacts/${IDS.jane}/thread?compose=sms`);
  return screen.findByRole('textbox', { name: 'Text message' });
}

const set = (box: HTMLElement, text: string) => fireEvent.change(box, { target: { value: text } });
const special = () => screen.getByTestId('segment-special');
const summary = () => screen.getByTestId('segment-summary');

describe('R-MMS-9 segment counter', () => {
  it('R-MMS-9: a plain text is one message of 160; a long one says its parts of 153; nothing is said about special characters', () => {
    expect(view('See you at 11')).toEqual({ summary: '1 text message · 13/160', special: null, tooLong: null, plainQuotes: false });
    expect(view('x'.repeat(412))).toMatchObject({ summary: '3 text messages · 412 characters (sent in parts of 153)', special: null });
    // the extension table costs two: 159 letters and a € are 161 septets, two parts
    expect(view(`${'x'.repeat(159)}€`)!.summary).toBe('2 text messages · 161 characters (sent in parts of 153)');
    expect(view('   ')).toBeNull();
  });

  it('R-MMS-9: "See you at 3 😊" makes no cost claim (it is still one message) and says each message holds 70 instead of 160; 100 characters with one emoji are 2 messages instead of 1', () => {
    const one = view('See you at 3 😊')!;
    expect(one.summary).toBe('1 text message · 15/70');
    expect(one.special).toBe('Because of 😊, each text message holds 70 characters instead of 160.');
    expect(one.special).not.toMatch(/text messages instead of/);
    const hundred = `${'a'.repeat(98)}😊`;
    expect(hundred.length).toBe(100);
    expect(view(hundred)).toMatchObject({ summary: '2 text messages · 100 characters (sent in parts of 67)', special: 'Because of 😊, this goes as 2 text messages instead of 1.' });
  });

  it('R-MMS-9: characters are named in words where they are typographic or do not show, at most 3 and then "and N more"', () => {
    expect(characterName('’')).toBe('the curly apostrophe ’');
    expect(characterName('“')).toBe('the curly quote “');
    expect(characterName(' ')).toBe('a no-break space');
    expect(characterName('\t')).toBe('a tab');
    expect(characterName('😊')).toBe('😊');
    expect(nameList(['😊', '“'])).toBe('😊 and the curly quote “');
    expect(nameList(['😊', '“', '—', '…', ' '])).toBe('😊, the curly quote “, — and 2 more');
    expect(view('Lunch at noon?')!.special).toBe('Because of a no-break space, each text message holds 70 characters instead of 160.');
    const long = `${'x'.repeat(130)}😊 “ok”`;
    expect(view(long)!.special).toBe('Because of 😊, the curly quote “ and the curly quote ”, this goes as 3 text messages instead of 1.');
  });

  it('R-MMS-9: toll-free numbers split at 152: 305 characters are 3 messages there and 2 from a local number (preview.textSender)', async () => {
    expect(view('x'.repeat(305))!.summary).toBe('2 text messages · 305 characters (sent in parts of 153)');
    expect(view('x'.repeat(305), { sender: 'toll_free' })!.summary).toBe('3 text messages · 305 characters (sent in parts of 152)');
    const box = await openText(threadFake((b) => b, 'toll_free'));
    set(box, 'x'.repeat(305));
    await waitFor(() => expect(summary()).toHaveTextContent('3 text messages · 305 characters (sent in parts of 152)'));
  });

  it('R-MMS-9: the counter counts the text as it will be sent: the em dash of the brokerage line added to marketing texts is named as the send\'s, never as the agent\'s', async () => {
    const line = '\n— Harbor Realty LLC';
    expect(view('Open house Saturday!', { final: `Open house Saturday!${line}` })!.special).toBe('The — in the brokerage line added to marketing texts makes each text message hold 70 characters instead of 160.');
    const typed = 'y'.repeat(150);
    expect(view(typed, { final: `${typed}${line}` })).toMatchObject({ summary: '3 text messages · 170 characters (sent in parts of 67)', special: 'The — in the brokerage line added to marketing texts makes this go as 3 text messages instead of 2.', plainQuotes: false });
    // in the box: from the preview of exactly these words
    const box = await openText(threadFake((b) => `${b}${line}`));
    set(box, typed);
    await waitFor(() => expect(special()).toHaveTextContent('The — in the brokerage line added to marketing texts makes this go as 3 text messages instead of 2.'));
    expect(special()).toHaveAttribute('aria-live', 'polite');
    expect(summary().closest('[aria-live]')).toBeNull();
    expect(box).toHaveAccessibleDescription(/^3 text messages · 170 characters \(sent in parts of 67\)/);
  });

  it('R-MMS-9: over 1,600 characters is too long for a text: Send is disabled and its description is that sentence', async () => {
    expect(view('z'.repeat(1642))!.tooLong).toBe('Too long for a text: 1,642 of 1,600 characters. Shorten it or send an email.');
    const box = await openText(threadFake());
    set(box, 'z'.repeat(1642));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(await screen.findByText('Too long for a text: 1,642 of 1,600 characters. Shorten it or send an email.')).toBeInTheDocument();
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription('Too long for a text: 1,642 of 1,600 characters. Shorten it or send an email.');
    set(box, 'z'.repeat(1600));
    await waitFor(() => expect(send).toBeEnabled());
  });

  it('R-MMS-9: "I’ll call you" names the curly apostrophe; Use plain quotes makes it plain (GSM-7) and returns focus to the box; it never edits what the send adds', async () => {
    expect(plainQuotes('‘a’ “b”')).toBe(`'a' "b"`);
    expect(view('I’ll call you')).toMatchObject({ special: 'Because of the curly apostrophe ’, each text message holds 70 characters instead of 160.', plainQuotes: true });
    // a curly quote the send adds is not the agent's to change: no button
    expect(view('Call me', { final: 'Call me\n— Harbor’s Realty' })!.plainQuotes).toBe(false);
    // and no button while another special character would keep it UCS-2
    expect(view('I’ll call 😊')!.plainQuotes).toBe(false);
    const box = await openText(threadFake());
    await user().type(box, 'I’ll call you');
    expect(await screen.findByText('Because of the curly apostrophe ’, each text message holds 70 characters instead of 160.')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Use plain quotes' });
    await user().click(btn);
    expect(box).toHaveValue("I'll call you");
    await waitFor(() => expect(box).toHaveFocus());
    await waitFor(() => expect(summary()).toHaveTextContent('1 text message · 13/160'));
    expect(special()).toHaveTextContent('');
    expect(screen.queryByRole('button', { name: 'Use plain quotes' })).toBeNull();
  });

  it('R-MMS-9: the counter is for Text only and hidden while the box is empty', async () => {
    const box = await openText(threadFake());
    expect(screen.queryByTestId('segment-summary')).toBeNull();
    expect(box).not.toHaveAttribute('aria-describedby');
    set(box, 'Hi');
    expect(await screen.findByText('1 text message · 2/160')).toBeInTheDocument();
    await user().click(screen.getByRole('radio', { name: 'Email' }));
    expect(screen.queryByTestId('segment-counter')).toBeNull();
  });
});
