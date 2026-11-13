// "Under AI care" (R-ISA-22, R-ISA-30; E521, E522): one row per person, chips in words for the reader, filters,
// Pause and Take over in one tap, overdue handoffs for Owner/Admin, the hold banner without the replies clause.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, ISA_IDS, adminView, isaApp, iso, row } from './testing.js';
import { chipWords, onePerContact } from './ListPage.js';

const PAT = '01900000-0000-7000-8000-00000000c002';

function list(rows = [row(), row({ assignmentId: ISA_IDS.assignment2, contactId: PAT, name: 'Pat Lee', ownerUserId: ISA_IDS.other, ownerName: 'Ben Broker', chip: { kind: 'waiting_on_agent', sentence: 'Waiting on you: pricing negotiation' } })], hold: string | null = null) {
  return new FakeFetch()
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows, holdSentence: hold } })
    .on('GET /ai-isa/assignments?scope=mine&state=live', { status: 200, body: { rows: rows.filter((r) => r.ownerUserId === IDS.me), holdSentence: hold } });
}

describe('Under AI care (/ai-care)', () => {
  it('R-ISA-22 V7: one row per person (the newest), chips from the contact\'s latest assignment', () => {
    const rows = onePerContact([row(), row({ assignmentId: ISA_IDS.assignment2 })]);
    expect(rows.map((r) => r.assignmentId)).toEqual([ISA_IDS.assignment]);
  });

  it('R-ISA-22 V5: "Waiting on you" only for the owner; anyone else reads the owner\'s name; times never in UTC', () => {
    const r = row({ chip: { kind: 'waiting_on_agent', sentence: 'Waiting on you: pricing negotiation' } });
    expect(chipWords(r, true)).toBe('Waiting on you: price or value');
    expect(chipWords(r, false)).toBe('Waiting on Ava: price or value');
    expect(chipWords(row({ chip: { kind: 'paused', sentence: 'Paused: human contact (nobody is following up)' } }), true)).toBe('Paused: nobody is following up automatically · Someone on the team texted, emailed or called them.');
    expect(chipWords(row({ chip: { kind: 'ended', sentence: 'Ended: tenant off' } }), true)).toBe('Ended: The team turned the AI assistant off.');
  });

  it('R-ISA-30: rows show the chip in words, the next follow-up, the release date, the owner and an overdue handoff, with Pause and Take over', async () => {
    const r = row({ nextTouchAt: iso(3_600_000), inactivityReleaseAt: iso(86_400_000 * 5), handoffOverdue: true });
    isaApp(list([r]), '/ai-care', 'agent');
    const card = (await screen.findByRole('link', { name: 'Jane Doe' })).closest('article')!;
    expect(within(card).getByText('Active')).toBeInTheDocument();
    expect(within(card).getByText(/^Next follow-up /)).toBeInTheDocument();
    expect(within(card).getByText(/Returns to the pond on .*AI messages don't reset this\./)).toBeInTheDocument();
    expect(within(card).getByText('Owner: you')).toBeInTheDocument();
    expect(within(card).getByText('Handoff overdue')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/lastAction|of \d+ today/);
  });

  it('R-ISA-15: a collaborating agent sees Pause only on someone else\'s row', async () => {
    isaApp(list(), '/ai-care', 'agent');
    const card = (await screen.findByRole('link', { name: 'Pat Lee' })).closest('article')!;
    expect(within(card).getByText('Waiting on Ben: price or value')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('R-ISA-15: Pause is one tap from a row', async () => {
    const fake = list().on(`POST /contacts/${IDS.jane}/ai-isa/pause`, { status: 200, body: { assignmentId: ISA_IDS.assignment, state: 'paused', epoch: 1, inFlight: [], canceled: 0, undoUntil: null, sentence: 'Paused: nobody is following up automatically.' } });
    isaApp(fake, '/ai-care', 'agent');
    const card = (await screen.findByRole('link', { name: 'Jane Doe' })).closest('article')!;
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/pause`)).toHaveLength(1));
  });

  it('V7: filters are "Mine" and "Everyone you can see" and Live, Paused, Ended, All (no Held); Overdue for Owner/Admin only', async () => {
    isaApp(list(), '/ai-care', 'agent');
    await screen.findByRole('link', { name: 'Jane Doe' });
    expect(screen.getByRole('button', { name: 'Mine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Everyone you can see' })).toBeInTheDocument();
    for (const s of ['Live', 'Paused', 'Ended', 'All']) expect(screen.getByRole('button', { name: s })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Held' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Overdue handoffs' })).toBeNull();
  });

  it('E521: an Owner\'s overdue filter shows ended rows with an overdue handoff and says when the 200-row limit cut some', async () => {
    const ended = [row({ chip: { kind: 'ended', sentence: 'Ended: taken over' }, handoffOverdue: true }), row({ assignmentId: ISA_IDS.assignment2, contactId: PAT, name: 'Pat Lee', chip: { kind: 'ended', sentence: 'Ended: dormant' } })];
    const fake = new FakeFetch()
      .on('GET /ai-isa/assignments?scope=all&state=ended', { status: 200, body: { rows: ended, holdSentence: null } })
      .on('GET /admin/ai-isa', { status: 200, body: adminView({ overdueHandoffs: 3 }) });
    isaApp(fake, '/ai-care?filter=overdue', 'owner');
    expect(await screen.findByRole('link', { name: 'Jane Doe' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pat Lee' })).toBeNull();
    expect(await screen.findByText('Showing 1 of 3')).toBeInTheDocument();
  });

  it('R-ISA-1 E517: the hold banner shows on the list without the replies clause; an empty list says so', async () => {
    isaApp(list([], 'AI assistant sending is off on this deployment.'), '/ai-care', 'agent');
    const b = await screen.findByTestId('ai-hold');
    expect(b.textContent).toContain('AI assistant sending is off on this deployment. Nothing reaches the people under AI care from this deployment.');
    expect(b.textContent).not.toMatch(/replies/);
    expect(await screen.findByText('Nobody is under AI care.')).toBeInTheDocument();
  });

  it('E522: a tenant switched off while the list is open: rows refetch on focus and read as ended', async () => {
    let off = false;
    const fake = new FakeFetch().on('GET /ai-isa/assignments?scope=all&state=any', () => ({ status: 200, body: { rows: [row({ chip: off ? { kind: 'ended', sentence: 'Ended: tenant off' } : { kind: 'active', sentence: 'Active' } })], holdSentence: null } }));
    const { qc } = isaApp(fake, '/ai-care?state=any', 'agent');
    await screen.findByText('Active');
    off = true;
    await qc.invalidateQueries({ queryKey: ['ai-isa'] });
    expect(await screen.findByText('Ended: The team turned the AI assistant off.')).toBeInTheDocument();
  });

  it('R-PERM-5: a TC is never shown the page, and nothing is fetched', async () => {
    const fake = list();
    isaApp(fake, '/', 'tc');
    await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
    expect(fake.calls.some((c) => c.path.startsWith('/ai-isa'))).toBe(false);
  });
});
