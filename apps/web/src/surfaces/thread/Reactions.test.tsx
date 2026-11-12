// D5b texting reactions in the thread (R-REACT-3, R-REACT-6; E300, E301, E305). Synthetic fixtures only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../shell/api.js';
import { SESSION_KEY, ShellProvider } from '../../shell/context.js';
import { FakeFetch, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { ToastProvider } from '../people-edit/hooks.js';
import type { TimelineItem, TimelineReaction } from '../feed/lib/types.js';
import { ReactedWithChip, ReactionLine, reactionGlyph } from './Reactions.js';
import { MessageRow } from './ThreadPage.js';

const C = '01900000-0000-7000-8000-0000000000c1';
const RX = '01900000-0000-7000-8000-0000000000d1';
const TARGET = '01900000-0000-7000-8000-0000000000d2';
const contact = { id: C, name: 'Sam Rivera' };

function item(r: Partial<TimelineReaction> = {}): TimelineItem & { reaction: TimelineReaction } {
  return {
    id: RX,
    type: 'message',
    occurredAt: '2026-11-12T15:00:00Z',
    actor: null,
    detail: 'sms:inbound',
    preview: 'Loved “See you at 3”',
    note: null,
    provenance: 'native',
    reaction: { action: 'add', reaction: 'love', emoji: null, targetMessageId: TARGET, quote: 'See you at 3', raw: 'Loved “See you at 3”', narrowed: false, ...r },
  };
}

function mount(fake: FakeFetch, children: ReactNode) {
  const api = new ApiClient({ fetch: fake.fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(SESSION_KEY, sessionFixture());
  return render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={api} table={tableWith({ pages: [] })}>
        <ToastProvider>
          <ol>{children}</ol>
        </ToastProvider>
      </ShellProvider>
    </QueryClientProvider>,
  );
}

const details = (canEdit: boolean, doNotContact = false) => ({ status: 200, body: { details: { contactId: C, canEdit, doNotContact, stageLabels: {} } } });

const PHRASES: [Partial<TimelineReaction>, string][] = [
  [{ reaction: 'love' }, 'Sam loved “See you at 3”'],
  [{ reaction: 'like' }, 'Sam liked “See you at 3”'],
  [{ reaction: 'dislike' }, 'Sam disliked “See you at 3”'],
  [{ reaction: 'laugh' }, 'Sam laughed at “See you at 3”'],
  [{ reaction: 'emphasize' }, 'Sam emphasized “See you at 3”'],
  [{ reaction: 'question' }, 'Sam questioned “See you at 3”'],
  [{ reaction: 'sticker' }, 'Sam reacted with a sticker to “See you at 3”'],
  [{ reaction: 'emoji', emoji: '👍' }, 'Sam reacted 👍 to “See you at 3”'],
  [{ action: 'remove', reaction: 'love' }, 'Sam removed a heart from “See you at 3”'],
  [{ action: 'remove', reaction: 'like' }, 'Sam removed a like from “See you at 3”'],
  [{ action: 'remove', reaction: 'dislike' }, 'Sam removed a dislike from “See you at 3”'],
  [{ action: 'remove', reaction: 'laugh' }, 'Sam removed a laugh from “See you at 3”'],
  [{ action: 'remove', reaction: 'emphasize' }, 'Sam removed an exclamation from “See you at 3”'],
  [{ action: 'remove', reaction: 'question' }, 'Sam removed a question mark from “See you at 3”'],
  [{ action: 'remove', reaction: 'sticker' }, 'Sam removed a sticker from “See you at 3”'],
  [{ action: 'remove', reaction: 'emoji', emoji: '👍' }, 'Sam removed 👍 from “See you at 3”'],
];

describe('ReactionLine (R-REACT-6)', () => {
  it.each(PHRASES)('R-REACT-6 E305 every phrase, add and remove: %o', (r, text) => {
    mount(new FakeFetch().on(`GET /contacts/${C}/details`, details(false)), <ReactionLine item={item(r)} contact={contact} />);
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === text)).toBeTruthy();
    expect(document.getElementById(RX)).not.toBeNull();
    expect(screen.getByText('SMS').getAttribute('data-channel-tag')).toBe('sms');
  });

  it('R-REACT-6: "They" when the name is unknown', () => {
    mount(new FakeFetch(), <ReactionLine item={item()} />);
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'They loved “See you at 3”')).toBeTruthy();
  });

  it('R-REACT-6: the whole raw text is one tap away (a 1,000-character reaction)', async () => {
    const long = `Loved “${'a'.repeat(990)}”`;
    mount(new FakeFetch().on(`GET /contacts/${C}/details`, details(false)), <ReactionLine item={item({ raw: long, quote: `${'a'.repeat(120)}…` })} contact={contact} />);
    const summary = screen.getByText('Show what they sent');
    expect(summary.className).toContain('min-h-tap');
    await userEvent.click(summary);
    expect(screen.getByText(long)).toBeTruthy();
    expect(screen.getByText(long).textContent).toHaveLength(long.length);
  });

  it('R-REACT-3 E301: the narrowed note says the quoted words were not read as an opt-out', () => {
    mount(new FakeFetch().on(`GET /contacts/${C}/details`, details(false)), <ReactionLine item={item({ narrowed: true })} contact={contact} />);
    expect(screen.getByText('Not read as an opt-out or a wrong number: the words in quotes come from a text sent to Sam.')).toBeTruthy();
  });

  it('R-REACT-3 R-PAR-32 E193: the do-not-contact offer shows only with canEdit and records it on the R-CHAN-3 route in two taps', async () => {
    const no = new FakeFetch().on(`GET /contacts/${C}/details`, details(false));
    const v = mount(no, <ReactionLine item={item({ narrowed: true })} contact={contact} />);
    await screen.findByText(/Not read as an opt-out/);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'They asked not to be contacted…' })).toBeNull();
    v.unmount();
    // not narrowed: no offer even for an editor
    const plain = new FakeFetch().on(`GET /contacts/${C}/details`, details(true));
    const v2 = mount(plain, <ReactionLine item={item()} contact={contact} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'They asked not to be contacted…' })).toBeNull();
    v2.unmount();

    const fake = new FakeFetch().on(`GET /contacts/${C}/details`, details(true)).on(`POST /contacts/${C}/do-not-contact`, { status: 200, body: { doNotContact: true, alreadySet: false, revokedPoints: 1 } });
    mount(fake, <ReactionLine item={item({ narrowed: true })} contact={contact} />);
    await userEvent.click(await screen.findByRole('button', { name: 'They asked not to be contacted…' })); // tap 1
    const dialog = await screen.findByRole('dialog', { name: 'Did Sam ask not to be contacted?' });
    expect(fake.callsTo(`POST /contacts/${C}/do-not-contact`)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, record do not contact' })); // tap 2
    expect(fake.callsTo(`POST /contacts/${C}/do-not-contact`).map((c) => c.body)).toEqual([{ reason: 'asked_in_writing' }]);
  });

  it('R-REACT-3 R-PAR-32 (b8 texting ui/F9): with do-not-contact already recorded there is no offer, only a line saying so', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${C}/details`, details(true, true));
    mount(fake, <ReactionLine item={item({ narrowed: true })} contact={contact} />);
    expect(await screen.findByText('Sam already asked not to be contacted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'They asked not to be contacted…' })).toBeNull();
  });

  it('R-REACT-3 R-PAR-32 (b8 texting ui/F9): when someone recorded it first (alreadySet), the toast never says "Recorded"', async () => {
    const fake = new FakeFetch().on(`GET /contacts/${C}/details`, details(true)).on(`POST /contacts/${C}/do-not-contact`, { status: 200, body: { doNotContact: true, alreadySet: true, revokedPoints: 0 } });
    mount(fake, <ReactionLine item={item({ narrowed: true })} contact={contact} />);
    await userEvent.click(await screen.findByRole('button', { name: 'They asked not to be contacted…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Did Sam ask not to be contacted?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, record do not contact' }));
    expect((await screen.findAllByText('Already recorded: Sam asked not to be contacted. Nothing changed.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Recorded: do not contact/)).toBeNull();
  });

  it('R-REACT-6: the quote links to the reacted-to text only when it is loaded', () => {
    const v = mount(new FakeFetch().on(`GET /contacts/${C}/details`, details(false)), <ReactionLine item={item()} contact={contact} loaded={new Set([TARGET])} />);
    expect(screen.getByRole('link', { name: '“See you at 3”' }).getAttribute('href')).toBe(`#${TARGET}`);
    v.unmount();
    mount(new FakeFetch().on(`GET /contacts/${C}/details`, details(false)), <ReactionLine item={item()} contact={contact} loaded={new Set()} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('R-REACT-6: MessageRow renders a linked reaction as the line and an unlinked reaction-shaped text as a bubble', () => {
    const v = mount(new FakeFetch().on(`GET /contacts/${C}/details`, details(false)), <MessageRow item={item()} contact={contact} />);
    expect(document.querySelector('[data-reaction="add"]')).not.toBeNull();
    v.unmount();
    const plain: TimelineItem = { ...item(), reaction: null };
    mount(new FakeFetch().on(`GET /contacts/${C}/attachments`, { status: 200, body: { messages: [], voicemails: [] } }), <MessageRow item={plain} contact={contact} />);
    expect(document.querySelector('[data-reaction]')).toBeNull();
    expect(screen.getByText('Loved “See you at 3”')).toBeTruthy();
  });
});

describe('ReactedWithChip (R-REACT-6)', () => {
  it('R-REACT-6: the glyph is aria-hidden and the name is sr-only text, no aria-label', () => {
    mount(new FakeFetch(), <li><ReactedWithChip reactedWith={{ reaction: 'love', emoji: null, at: '2026-11-12T15:00:00Z' }} contactName="Sam Rivera" /></li>);
    const chip = document.querySelector('[data-reacted-with="love"]')!;
    expect(chip.getAttribute('aria-label')).toBeNull();
    const glyph = chip.querySelector('[aria-hidden="true"]')!;
    expect(glyph.textContent).toBe('❤️');
    const sr = chip.querySelector('.sr-only')!;
    expect(sr.textContent).toBe('Sam loved this text');
  });

  it('R-REACT-6: every glyph', () => {
    expect(reactionGlyph({ reaction: 'love', emoji: null })).toBe('❤️');
    expect(reactionGlyph({ reaction: 'like', emoji: null })).toBe('\u{1F44D}');
    expect(reactionGlyph({ reaction: 'dislike', emoji: null })).toBe('\u{1F44E}');
    expect(reactionGlyph({ reaction: 'laugh', emoji: null })).toBe('\u{1F602}');
    expect(reactionGlyph({ reaction: 'emphasize', emoji: null })).toBe('‼️');
    expect(reactionGlyph({ reaction: 'question', emoji: null })).toBe('❓');
    expect(reactionGlyph({ reaction: 'sticker', emoji: null })).toBe('Sticker');
    expect(reactionGlyph({ reaction: 'emoji', emoji: '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}' })).toBe('🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}');
  });
});
