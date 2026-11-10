// Team Lead exception queue in jsdom, against a scripted API with the real app shell.
// The queue's contents and per-item action flags are the server's (R-ACC-1 derivation and R-ACC-3
// verify/reassign roles are proven by api/accountability against Postgres); these tests prove the
// display half: a cleared-but-unhandled item stays visible as "Fixed late", each item shows owner,
// age and evidence (with "Check this" and no score), resolve requires a note, verify is offered only
// when the server allows it, and reassign is two taps with a command id per tap.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, err, exceptionItem, leadAdminApp, member, queue } from '../admin/lib/testing.js';

const LIVE = 'GET /team/exceptions?state=live&limit=200';
const keyPath = (key: string, verb: string) => `POST /team/exceptions/${encodeURIComponent(key)}/${verb}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function teamFake(items = [exceptionItem()]) {
  return new FakeFetch()
    .on(LIVE, { status: 200, body: queue(items) })
    .on('GET /team/scoreboard?range=today', { status: 200, body: { range: { key: 'today', from: '', to: '', days: 1, zone: 'UTC' }, members: [{ userId: ID.ava, name: 'Ava Agent' }, { userId: ID.ben, name: 'Ben Agent' }, { userId: ID.me, name: 'Sam Lead' }] } });
}

describe('Team exception queue', () => {
  it('shows each live item with its type, lead, owner, age and evidence, and when it was last updated', async () => {
    leadAdminApp(teamFake(), '/team');
    const card = (await screen.findByRole('heading', { name: /Untouched lead · Pat Lead/ })).closest('article')!;
    expect(within(card).getByText(/Ava Agent · open 3 h/)).toBeInTheDocument();
    const evidence = within(card).getByRole('list', { name: 'Evidence' });
    expect(within(evidence).getByRole('link', { name: /First human contact was due ·/ })).toHaveAttribute('href', `/contacts/${ID.pat}`);
    expect(within(evidence).getByText(/Lead became theirs ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All 1' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Untouched leads 1' })).toBeInTheDocument();
  });

  it('a live item whose condition already cleared stays in the queue as "Fixed late" and still offers Resolve and Verify', async () => {
    leadAdminApp(teamFake([exceptionItem({ conditionClearedAt: new Date().toISOString() })]), '/team');
    const card = (await screen.findByRole('heading', { name: /Untouched lead/ })).closest('article')!;
    expect(within(card).getByText('Fixed late')).toBeInTheDocument();
    expect(within(card).getByText(/stays here until someone resolves or verifies it/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Verify' })).toBeInTheDocument();
  });

  it('evidence quoting a call links to it at its place, flags needs-review with "Check this", and evidence the server could not link is plain text; no score is shown', async () => {
    const promise = exceptionItem({
      dedupeKey: `promise:${ID.task}`,
      itemType: 'overdue_promise',
      evidence: [
        { sourceType: 'task', sourceId: ID.task, explanation: 'Promised follow-up is past due and still open', at: null, locator: null, snippet: null, needsReview: false, link: { kind: 'task', id: ID.task, contactId: ID.pat, offsetMs: null } },
        { sourceType: 'call', sourceId: ID.call, explanation: 'Where it was promised', at: null, locator: { kind: 'transcript_offset', startMs: 134_000, endMs: 138_000 }, snippet: "I'll send you the comps Thursday", needsReview: true, link: { kind: 'call', id: ID.call, contactId: ID.pat, offsetMs: 134_000 } },
        { sourceType: 'message', sourceId: ID.message, explanation: 'Mentioned again', at: null, locator: null, snippet: 'comps please', needsReview: false, link: null },
      ],
    });
    leadAdminApp(teamFake([promise]), '/team');
    const card = (await screen.findByRole('heading', { name: /Overdue promise/ })).closest('article')!;
    const ev = within(card).getByRole('list', { name: 'Evidence' });
    expect(within(ev).getByRole('link', { name: /“I'll send you the comps Thursday” at 2:14 in the call/ })).toHaveAttribute('href', `/contacts/${ID.pat}/thread#${ID.call}`);
    expect(within(ev).getByRole('link', { name: /Promised follow-up is past due/ })).toHaveAttribute('href', `/tasks#task-${ID.task}`);
    expect(within(ev).getByText('“comps please” in the text').closest('a')).toBeNull();
    expect(within(ev).getByText('Check this')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/confidence|%|score/i);
  });

  it('resolve needs a note: the button stays disabled until one is typed, then sends it with a command id', async () => {
    const it0 = exceptionItem();
    const fake = teamFake([it0]).on(keyPath(it0.dedupeKey, 'resolve'), { status: 200, body: { item: { ...it0, live: false }, events: [] } });
    leadAdminApp(fake, '/team');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Resolve' }));
    const submit = screen.getByRole('button', { name: 'Resolve' });
    expect(submit).toBeDisabled();
    await u.type(screen.getByLabelText('What was done?'), 'Called Pat, booked a showing');
    await u.click(submit);
    expect(await screen.findByText('Resolved: Untouched lead for Pat Lead')).toBeInTheDocument();
    const body = fake.callsTo(keyPath(it0.dedupeKey, 'resolve'))[0]!.body as { note: string; commandId: string };
    expect(body.note).toBe('Called Pat, booked a showing');
    expect(body.commandId).toMatch(UUID);
    await waitFor(() => expect(fake.callsTo(LIVE).length).toBeGreaterThanOrEqual(2));
  });

  it('Verify is not offered when the server says the viewer may not verify (an agent looking at their own item)', async () => {
    leadAdminApp(teamFake([exceptionItem({ actions: { resolve: true, reassign: false, verify: false, reopen: false } })]), '/team');
    const card = (await screen.findByRole('heading', { name: /Untouched lead/ })).closest('article')!;
    expect(within(card).queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Reassign' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it('ARCHITECTURE §1 benchmark: a Team Lead reassigns from the exception in 2 taps (Reassign → agent), one command id per tap, never to the current owner', async () => {
    const it0 = exceptionItem();
    const fake = teamFake([it0]).on(keyPath(it0.dedupeKey, 'reassign'), { status: 200, body: { item: { ...it0, live: false }, events: [] } });
    leadAdminApp(fake, '/team');
    const u = userEvent.setup();
    let taps = 0;
    await u.click(await screen.findByRole('button', { name: 'Reassign' }));
    taps += 1;
    const group = await screen.findByRole('group', { name: 'Reassign to' });
    expect(within(group).queryByRole('button', { name: 'Ava Agent' })).toBeNull();
    await u.click(await within(group).findByRole('button', { name: 'Ben Agent' }));
    taps += 1;
    expect(await screen.findByText('Reassigned Pat Lead to Ben Agent')).toBeInTheDocument();
    expect(taps).toBe(2);
    const calls = fake.callsTo(keyPath(it0.dedupeKey, 'reassign'));
    expect(calls).toHaveLength(1);
    // ownership-2: the ledger head the queue showed goes with the tap (the server refuses it once the lead moved)
    expect(calls[0]!.body).toEqual({ toUserId: ID.ben, commandId: expect.stringMatching(UUID), expectedSeq: it0.contactOwnershipSeq });
  });

  it('an Owner picks the new owner from active members who take leads', async () => {
    const it0 = exceptionItem();
    const fake = new FakeFetch()
      .on(LIVE, { status: 200, body: queue([it0]) })
      .on('GET /members', { status: 200, body: { members: [member(), member({ userId: ID.ben, displayName: 'Ben Agent' }), member({ userId: ID.owner, displayName: 'Olive Owner', role: 'owner' }), member({ userId: '01900000-0000-7000-8000-0000000000a3', displayName: 'Tia TC', role: 'tc', acceptingLeads: false })], invites: [] } });
    leadAdminApp(fake, '/team', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Reassign' }));
    const group = await screen.findByRole('group', { name: 'Reassign to' });
    expect(await within(group).findByRole('button', { name: 'Ben Agent' })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: 'Olive Owner' })).toBeNull();
    expect(within(group).queryByRole('button', { name: 'Tia TC' })).toBeNull();
  });

  it('when someone else handled the item first, the page says so in words, refetches, and keeps the sentence after the item leaves the queue', async () => {
    const it0 = exceptionItem();
    let handledElsewhere = false;
    const fake = teamFake([it0])
      .on(LIVE, () => ({ status: 200, body: queue(handledElsewhere ? [] : [it0]) }))
      .on(keyPath(it0.dedupeKey, 'verify'), () => {
        handledElsewhere = true;
        return err(409, 'EXCEPTION_STATE_CONFLICT', { latestAction: 'verified' });
      });
    leadAdminApp(fake, '/team');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Someone handled this just now. The list below is up to date.')).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo(LIVE).length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Someone handled this just now.');
  });

  it('the Handled view lists resolved items with who resolved them, and Reopen is one tap', async () => {
    const it0 = exceptionItem({ live: false, latestEvent: { action: 'resolved', note: 'Called her', actor: { userId: ID.me, name: 'Sam Lead' }, at: new Date().toISOString() }, actions: { resolve: false, reassign: false, verify: true, reopen: true } });
    const fake = teamFake([]).on('GET /team/exceptions?state=handled&limit=200', { status: 200, body: queue([it0], 0) }).on(keyPath(it0.dedupeKey, 'reopen'), { status: 200, body: { item: { ...it0, live: true }, events: [] } });
    leadAdminApp(fake, '/team');
    const u = userEvent.setup();
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
    await u.click(screen.getByRole('radio', { name: 'Handled' }));
    const card = (await screen.findByRole('heading', { name: /Untouched lead/ })).closest('article')!;
    expect(within(card).getByText(/Resolved by Sam Lead · .*: “Called her”/)).toBeInTheDocument();
    await u.click(within(card).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('Reopened: Untouched lead for Pat Lead')).toBeInTheDocument();
    expect(fake.callsTo(keyPath(it0.dedupeKey, 'reopen'))[0]!.body).toEqual({ commandId: expect.stringMatching(UUID) });
  });

  it('says how many it shows when the server returned fewer items than are live', async () => {
    leadAdminApp(new FakeFetch().on(LIVE, { status: 200, body: queue([exceptionItem()], 240) }), '/team');
    expect(await screen.findByText('Showing the oldest 1 of 240.')).toBeInTheDocument();
  });
});
