// The team work queue on the team page, in jsdom against a scripted API with the real app shell (b19 team-queue
// lane; DATA_MODEL R-TEAMQ-1..6). What is in the queue, its "why" sentences and who may read it are the server's
// (api/accountability/teamQueue.test.ts proves them against Postgres); these tests prove the display half: five
// groups with counts above the exception list, each row one line of who, why and how long with the owner or
// "No owner yet" and a link to the person, honest empty, loading and error states, and the exception list still
// working beside it. Invented people only.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, err, exceptionItem, leadAdminApp, queue } from '../admin/lib/testing.js';
import type { TeamQueueResponse } from './lib.js';
import { QUEUE_PATH as QUEUE, QUEUE_PEOPLE as P, QUEUE_WORDS as WORDS, queueRow as row, workQueue } from './testing.js';

const LIVE = 'GET /team/exceptions?state=live&limit=200';

function fake(q: TeamQueueResponse | { status: number; body?: unknown } = workQueue(), items = [exceptionItem()]) {
  return new FakeFetch().on(LIVE, { status: 200, body: queue(items) }).on(QUEUE, 'status' in q ? q : { status: 200, body: q });
}

const section = () => screen.findByRole('region', { name: 'Waiting now' });
/** the queue's region once its groups are on the page */
async function loaded(): Promise<HTMLElement> {
  const region = await section();
  await within(region).findByText(/^Checked /);
  return region;
}

describe('Team work queue', () => {
  it('R-TEAMQ-1: five groups with their counts sit above the exception list, and one line says how the two differ', async () => {
    leadAdminApp(
      fake(
        workQueue({
          new_lead: [row(), row({ key: `new_lead:${P.opal}`, contact: { id: P.opal, name: 'Opal Reyes' }, owner: { kind: 'pond', userId: null, name: 'Main pond', pondId: ID.item, label: 'No owner yet: in the pond Main pond' }, why: 'Arrived 2 h ago from Open house sign-in. In the pond Main pond. Nobody has called, texted or emailed yet. No automatic reply has gone out.', waitingSeconds: 7200, staffedSeconds: 7200 })],
          unanswered_reply: [row({ key: `reply:${P.rhea}`, contact: { id: P.rhea, name: 'Rhea Doe' }, owner: { kind: 'owner', userId: ID.ava, name: 'Ava Agent', pondId: null, label: 'Ava Agent' }, why: 'They texted 20 min ago; no answer from a person yet. Owned by Ava Agent.', waitingSeconds: 1200, staffedSeconds: null })],
        }),
      ),
      '/team',
    );
    const region = await loaded();
    const groups = within(region).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'New leads nobody has called, texted or emailed yet: 2',
      'Replies nobody has answered: 1',
      'Promises past due: 0',
      'Follow-ups past due: 0',
      'Appointments needing an outcome: 0',
    ]);
    expect(within(region).getByText(/This is who is waiting for a person right now, counted from when they arrived\. The list under it, Missed deadlines, is the record of deadlines already missed that someone has to resolve or verify\./)).toBeInTheDocument();
    // the exception list is still there, under it
    const missed = screen.getByRole('heading', { level: 2, name: 'Missed deadlines' });
    expect(region.compareDocumentPosition(missed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /Untouched lead · Pat Lead/ })).toBeInTheDocument();
  });

  it('R-TEAMQ-2 E820: each row is one line of who, why and how long, with the owner or "No owner yet", and the name links to the person', async () => {
    leadAdminApp(fake(workQueue({ new_lead: [row({ waitingSeconds: 8 * 3600, staffedSeconds: 2 * 3600, offHours: true }), row({ key: `new_lead:${P.ivo}`, contact: { id: P.ivo, name: 'Ivo Typed' }, owner: { kind: 'owner', userId: ID.ava, name: 'Ava Agent', pondId: null, label: 'Ava Agent' }, why: 'Arrived 5 min ago from Website form. Owned by Ava Agent. Nobody has called, texted or emailed yet. No automatic reply has gone out.', waitingSeconds: 300, staffedSeconds: 300 })] })), '/team');
    const region = await loaded();
    const first = within(region).getByRole('link', { name: 'Quinn Harbor' }).closest('li')!;
    expect(within(first).getByRole('link', { name: 'Quinn Harbor' })).toHaveAttribute('href', `/contacts/${P.quinn}`);
    expect(within(first).getByText(/^Arrived 12 min ago from Website form\. On offer to Ben Agent\. Nobody has called, texted or emailed yet\. An automatic reply went out at 2:03 PM\.$/)).toBeInTheDocument();
    expect(within(first).getByText('No owner yet: on offer to Ben Agent')).toBeInTheDocument();
    // the wait from arrival, with staffed time said apart when it differs (an off-hours arrival)
    expect(within(first).getByText('Waiting 8 h · 2 h in staffed hours')).toBeInTheDocument();
    const second = within(region).getByRole('link', { name: 'Ivo Typed' }).closest('li')!;
    expect(within(second).getByText('Ava Agent')).toBeInTheDocument();
    expect(within(second).getByText('Waiting 5 min')).toBeInTheDocument();
    expect(within(second).queryByText(/No owner yet/)).toBeNull();
  });

  it('R-TEAMQ-1: an empty group says so in its own words instead of showing a blank', async () => {
    leadAdminApp(fake(workQueue()), '/team');
    const region = await loaded();
    for (const [, empty] of Object.values(WORDS)) expect(within(region).getByText(empty)).toBeInTheDocument();
    expect(within(region).getByText('Nobody is waiting on a first call.')).toBeVisible();
    expect(within(region).queryAllByRole('listitem')).toHaveLength(0);
    // nothing to open: an empty group has no toggle
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
  });

  it('R-TEAMQ-1: groups are collapsible: the new-lead group starts open, the others closed, and a tap opens one', async () => {
    const user = userEvent.setup();
    leadAdminApp(
      fake(workQueue({ new_lead: [row()], due_promise: [row({ key: `task:${ID.task}`, contact: { id: P.rhea, name: 'Rhea Doe' }, owner: { kind: 'owner', userId: ID.ava, name: 'Ava Agent', pondId: null, label: 'Ava Agent' }, why: 'Promise “Send the comps” was due 3 h ago. Ava Agent made it.', waitingSeconds: 10_800, staffedSeconds: null })] })),
      '/team',
    );
    const region = await loaded();
    const newLeads = within(region).getByRole('group', { name: 'New leads nobody has called, texted or emailed yet: 1' });
    const promises = within(region).getByRole('group', { name: 'Promises past due: 1' });
    const toggle = (g: HTMLElement) => within(g).getByRole('button');
    expect(toggle(newLeads)).toHaveAttribute('aria-expanded', 'true');
    expect(toggle(promises)).toHaveAttribute('aria-expanded', 'false');
    expect(within(promises).queryByRole('link', { name: 'Rhea Doe' })).toBeNull();
    await user.click(toggle(promises));
    expect(toggle(promises)).toHaveAttribute('aria-expanded', 'true');
    expect(within(promises).getByRole('link', { name: 'Rhea Doe' })).toHaveAttribute('href', `/contacts/${P.rhea}`);
    expect(within(promises).getByText('Promise “Send the comps” was due 3 h ago. Ava Agent made it.')).toBeInTheDocument();
    // closing the first one keeps it closed, and hides its rows
    await user.click(toggle(newLeads));
    expect(toggle(newLeads)).toHaveAttribute('aria-expanded', 'false');
    expect(within(newLeads).queryByRole('link', { name: 'Quinn Harbor' })).toBeNull();
  });

  it('R-TEAMQ-1 E826: a capped group says how many it shows and how many more there are, and "at least" when the read was capped', async () => {
    leadAdminApp(fake(workQueue({ new_lead: [row()] }, { new_lead: { total: 32, more: 31 } })), '/team');
    const region = await loaded();
    expect(within(region).getByRole('group', { name: 'New leads nobody has called, texted or emailed yet: 32' })).toBeInTheDocument();
    expect(within(region).getByText('Showing the 1 waiting longest. 31 more are not shown.')).toBeInTheDocument();
  });

  it('R-TEAMQ-1 E826: "at least" is said when the server read reached its cap', async () => {
    leadAdminApp(fake(workQueue({ new_lead: [row()] }, { new_lead: { total: 500, more: 499, atLeast: true } })), '/team');
    const region = await loaded();
    expect(within(region).getByRole('group', { name: 'New leads nobody has called, texted or emailed yet: at least 500' })).toBeInTheDocument();
    expect(within(region).getByText('Showing the 1 waiting longest. At least 499 more are not shown.')).toBeInTheDocument();
  });

  it('says it is loading, then says when it was checked, the staffed hours and how far back it looks', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    const f = new FakeFetch().on(LIVE, { status: 200, body: queue([]) }).on(QUEUE, async () => {
      await gate;
      return { status: 200, body: workQueue() };
    });
    leadAdminApp(f, '/team');
    const region = await section();
    expect(within(region).getByText('Loading who is waiting')).toBeInTheDocument();
    expect(within(region).queryByText('Nobody is waiting on a first call.')).toBeNull();
    release!();
    expect(await within(region).findByText('Nobody is waiting on a first call.')).toBeInTheDocument();
    expect(within(region).queryByText('Loading who is waiting')).toBeNull();
    expect(within(region).getByText(/^Checked .+\. Staffed hours are 8:00 AM to 9:00 PM \(America\/New_York\)\. Looks back 14 days for new leads and replies, 90 days for promises and follow-ups, 30 days for appointments\.$/)).toBeInTheDocument();
  });

  it('when the queue cannot be read it says so in words, never an empty "nobody is waiting", and the exception list still works', async () => {
    leadAdminApp(fake(err(500, 'INTERNAL') as { status: number; body?: unknown }), '/team');
    const region = await section();
    expect(await within(region).findByRole('alert')).toHaveTextContent('We could not check who is waiting. Nothing here says that nobody is.');
    expect(within(region).queryByText('Nobody is waiting on a first call.')).toBeNull();
    expect(within(region).queryAllByRole('group')).toHaveLength(0);
    const card = (await screen.findByRole('heading', { name: /Untouched lead · Pat Lead/ })).closest('article')!;
    expect(within(card).getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'All 1' })).toBeChecked());
  });

  it('the queue with open, closed and empty groups has no axe violations (color contrast is checked in the Playwright spec)', async () => {
    leadAdminApp(
      fake(workQueue({ new_lead: [row(), row({ key: `new_lead:${P.opal}`, contact: { id: P.opal, name: 'Opal Reyes' } })], due_promise: [row({ key: `task:${ID.task}`, contact: { id: P.rhea, name: 'Rhea Doe' }, staffedSeconds: null })] }, { new_lead: { total: 9, more: 7 } })),
      '/team',
    );
    await loaded();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('R-TEAMQ-18 the backup alert on a new-lead row (b19 step 2)', () => {
  it('R-TEAMQ-18 E857: a row whose backup was alerted shows the server\'s line on its own, and the group says how many of its rows had their backup alerted', async () => {
    const alerted = row({ backupAlert: { at: new Date(Date.now() - 9 * 60_000).toISOString(), alerted: true, line: 'Backup alerted at 2:06 PM: Sam T.' } });
    const plain = row({ key: `new_lead:${P.opal}`, contact: { id: P.opal, name: 'Opal Reyes' }, backupAlert: null });
    leadAdminApp(fake(workQueue({ new_lead: [alerted, plain] }, { new_lead: { backupAlerted: 1 } })), '/team');
    const region = await loaded();
    const group = within(region).getByRole('group', { name: 'New leads nobody has called, texted or emailed yet: 2' });
    expect(within(group).getByText('Backup alerted for 1 of 2.')).toBeInTheDocument();
    const quinn = within(group).getByRole('link', { name: 'Quinn Harbor' }).closest('li')!;
    expect(within(quinn).getByText('Backup alerted at 2:06 PM: Sam T.')).toBeInTheDocument();
    const opal = within(group).getByRole('link', { name: 'Opal Reyes' }).closest('li')!;
    expect(within(opal).queryByText(/Backup alerted/)).toBeNull();
  });

  it('R-TEAMQ-25 E890 (review fix L4): alerts that went to a team lead or to the Owners and Admins are counted apart from "Backup alerted", each with the group\'s total', async () => {
    const backupRow = row({ backupAlert: { at: new Date().toISOString(), alerted: true, recipient: 'backup', line: 'Backup alerted at 2:06 PM: Sam T.' } });
    const leadRow = row({ key: `new_lead:${P.opal}`, contact: { id: P.opal, name: 'Opal Reyes' }, backupAlert: { at: new Date().toISOString(), alerted: true, recipient: 'team_lead', line: "The source's backup is unavailable: the team lead, Taylor L., was alerted at 2:06 PM." } });
    leadAdminApp(fake(workQueue({ new_lead: [backupRow, leadRow] }, { new_lead: { backupAlerted: 1, othersAlerted: 1 } })), '/team');
    const region = await loaded();
    const group = within(region).getByRole('group', { name: 'New leads nobody has called, texted or emailed yet: 2' });
    expect(within(group).getByText('Backup alerted for 1 of 2. A team lead or the Owners and Admins were alerted instead for 1 of 2.')).toBeInTheDocument();
  });

  it('R-TEAMQ-22 E882: a row whose call a person answered shows the server\'s true words, and the group says how many of its rows that is, with its total', async () => {
    const answered = row({ why: 'Arrived 6 min ago from Website form. Owned by Jordan P. A person answered their call at 2:04 PM. Nobody has called back, texted or emailed since.', answeredCallAt: new Date(Date.now() - 4 * 60_000).toISOString() });
    const plain = row({ key: `new_lead:${P.opal}`, contact: { id: P.opal, name: 'Opal Reyes' }, answeredCallAt: null });
    leadAdminApp(fake(workQueue({ new_lead: [answered, plain] }, { new_lead: { answeredCalls: 1 } })), '/team');
    const region = await loaded();
    const group = within(region).getByRole('group', { name: 'New leads nobody has called, texted or emailed yet: 2' });
    expect(within(group).getByText('A person answered the call of 1 of 2; nobody has called back, texted or emailed.')).toBeInTheDocument();
    const quinn = within(group).getByRole('link', { name: 'Quinn Harbor' }).closest('li')!;
    expect(within(quinn).getByText(/A person answered their call at 2:04 PM\. Nobody has called back, texted or emailed since\./)).toBeInTheDocument();
    expect(within(quinn).queryByText(/Nobody has called, texted or emailed yet/)).toBeNull();
  });

  it('R-TEAMQ-22: with no answered call, or a server that sends no such field, the group says nothing about answered calls', async () => {
    leadAdminApp(fake(workQueue({ new_lead: [row()] }, { new_lead: { answeredCalls: 0 } })), '/team');
    const region = await loaded();
    expect(within(region).queryByText(/A person answered the call of/)).toBeNull();
  });

  it('R-TEAMQ-18 E857: "nobody could be alerted" is shown as the server wrote it and is not counted as alerted; with no alert at all the group says nothing about backups', async () => {
    const none = row({ backupAlert: { at: new Date().toISOString(), alerted: false, line: "Nobody could be alerted at 2:06 PM: the source's backup is unavailable and whoever has this lead has no team lead." } });
    leadAdminApp(fake(workQueue({ new_lead: [none] }, { new_lead: { backupAlerted: 0 } })), '/team');
    const region = await loaded();
    expect(within(region).getByText(/^Nobody could be alerted at 2:06 PM/)).toBeInTheDocument();
    expect(within(region).queryByText(/^Backup alerted for/)).toBeNull();
  });

  it('R-TEAMQ-18 E858: a capped read says "at least"; a server that sends no backup fields shows the rows as before', async () => {
    leadAdminApp(fake(workQueue({ new_lead: [row({ backupAlert: { at: new Date().toISOString(), alerted: true, line: 'Backup alerted at 2:06 PM: Sam T.' } })] }, { new_lead: { total: 500, more: 499, atLeast: true, backupAlerted: 12 } })), '/team');
    const region = await loaded();
    expect(within(region).getByText('Backup alerted for 12 of at least 500.')).toBeInTheDocument();
  });
});

