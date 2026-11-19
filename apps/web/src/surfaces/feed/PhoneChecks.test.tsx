// R-TODAY-10 (web, jsdom): what a phone needs of the new controls, as far as jsdom can say it. jsdom lays nothing
// out, so sizes are asserted by the design tokens a control carries (`min-h-tap` / `min-w-tap` = 44 px); the measured
// sizes, the bottom bar and the keyboard are checked in Chromium's iPhone 13 EMULATION by e2e/journeys/j11 (not on a
// real iPhone). The keyboard case of the header entry's sheet is in QuickLog.test.tsx.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { detailsFixture } from '../people-edit/testing.js';
import { FakeFetch, IDS, agentApp, card, feed, reachability } from './lib/testing.js';
import type { FollowUpTodayCard } from './lib/types.js';

const LONG = 'Trying to reach them now'; // 24 characters: a team's own label
const NO_CUT = /truncate|line-clamp|text-ellipsis|whitespace-nowrap|overflow-hidden/;

function row(): FollowUpTodayCard {
  return {
    ...card({
      id: IDS.jane,
      itemType: 'warm_follow_up',
      contact: { id: IDS.jane, name: 'Dana Reyes' },
      reasons: [{ code: 'WARM_NO_CONTACT', label: `${LONG}: no conversation for 9 days` }],
      primaryAction: { kind: 'call', label: 'Call', contactId: IDS.jane },
      alternatives: [{ kind: 'text', label: 'Text', contactId: IDS.jane }, { kind: 'email', label: 'Email', contactId: IDS.jane }, { kind: 'open_contact', label: 'Open', contactId: IDS.jane }],
      why: [`${LONG}: no conversation for 9 days`],
      stage: { key: 'attempting', label: LONG },
    }),
    taskIds: [],
  };
}

function open() {
  const fake = new FakeFetch()
    .on('GET /feed', { status: 200, body: { ...feed(), followUpToday: { people: [row()], total: 1, totalIsMinimum: false } } })
    .on('GET /reachability', { status: 200, body: { contacts: [reachability(IDS.jane)] } })
    .on(`GET /contacts/${IDS.jane}/details`, { status: 200, body: { details: detailsFixture(IDS.jane, 'attempting', {}, { attempting: LONG }) } });
  agentApp(fake);
  return userEvent.setup();
}

const tap44 = (el: Element) => {
  expect(el.className, `"${el.textContent}" is a 44 px target`).toMatch(/\bmin-h-tap\b/);
};

describe('R-TODAY-10: the new controls on a phone', () => {
  it('every control of a "Follow up today" row is a 44 px target: Call, Log, Text, Email, the name, Why this', async () => {
    open();
    const r = within(await screen.findByRole('region', { name: 'Follow up today' })).getByRole('article', { name: 'Dana Reyes' });
    for (const name of ['Call', 'Log for Dana Reyes', 'Text', 'Email', 'Why this']) tap44(within(r).getByRole('button', { name }));
    tap44(within(r).getByRole('link', { name: 'Dana Reyes' }));
    // Log sits directly after the primary action, so both are in the first row under a thumb
    const buttons = within(r).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(buttons.slice(0, 2)).toEqual(['Call', 'Log for Dana Reyes']);
  });

  it('E856: a 24-character stage label is shown whole on the row, in its reason and in the Log sheet’s stage step: nothing truncates', async () => {
    const u = open();
    const r = within(await screen.findByRole('region', { name: 'Follow up today' })).getByRole('article', { name: 'Dana Reyes' });
    const stage = within(r).getByTestId('card-stage');
    expect(stage).toHaveTextContent(LONG);
    for (let el: Element | null = stage; el && el !== r; el = el.parentElement) expect(el.className).not.toMatch(NO_CUT);
    const reason = within(r).getByText(`${LONG}: no conversation for 9 days`);
    for (let el: Element | null = reason; el && el !== r; el = el.parentElement) expect(el.className).not.toMatch(NO_CUT);
    await u.click(within(r).getByRole('button', { name: 'Log for Dana Reyes' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    await u.click(within(sheet).getByRole('button', { name: 'No answer' }));
    const keep = await within(sheet).findByRole('radio', { name: `Keep ${LONG}` });
    const label = within(keep.closest('label') ?? sheet).getByText(`Keep ${LONG}`);
    expect(label.className).not.toMatch(NO_CUT);
    // (b19 Today fix 1: the follow-up the button adds is named under it, in the pinned footer, not in the button)
    expect(within(sheet).getByTestId('log-save')).toHaveTextContent(`Save and keep ${LONG}`);
    expect(within(within(sheet).getByTestId('dialog-footer')).getByTestId('tap-effects')).toHaveTextContent(/^Adds: Follow up with Dana, tomorrow 9:00 AM\.$/);
  });

  it('the Log sheet’s quick times and its one button are 44 px targets, and the button is in the sheet’s pinned footer (above the keyboard and the safe area)', async () => {
    const u = open();
    const r = within(await screen.findByRole('region', { name: 'Follow up today' })).getByRole('article', { name: 'Dana Reyes' });
    await u.click(within(r).getByRole('button', { name: 'Log for Dana Reyes' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
    for (const b of within(within(sheet).getByRole('group', { name: 'When, quickly' })).getAllByRole('button')) tap44(b);
    const save = within(sheet).getByTestId('log-save');
    tap44(save);
    expect(sheet.lastElementChild).toContainElement(save);
    // the sheet itself keeps the home indicator's safe area under its footer
    expect(sheet.className).toMatch(/\bpb-safe\b/);
  });

  it('the page’s content ends above the tab bar and the home indicator, the header entry is inside the safe area, and the toast sits above the bars', async () => {
    open();
    const group = await screen.findByRole('region', { name: 'Follow up today' });
    const main = screen.getByRole('main');
    expect(main).toContainElement(group);
    expect(main.className).toContain('pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+16px)]');
    const entry = screen.getByRole('button', { name: 'Log a call or conversation' });
    expect(entry.closest('header')!.className).toMatch(/\bpt-safe\b/);
    tap44(entry);
    expect(screen.getByTestId('toast-stack').className).toContain('env(safe-area-inset-bottom)');
  });
});
