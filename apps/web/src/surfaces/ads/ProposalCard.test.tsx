// The shared ad-shift card (module 55 items 10 and 11) on the Google Ads page: one tap per decision through useAction,
// never a command id or an automatic retry (R-STAFF-4), outcomes in words (E669), refusals in words with the fresh
// state and no retry control (E668), the payload read defensively, and the total against the ceiling (R-STAFF-3).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { parseHold, parseProposal } from './proposal.js';
import { ADS_IDS, RAW, adsApp, adsFake, hold, overview, proposal, proposalPayload, run, staffError } from './testing.js';

const user = () => userEvent.setup();
const settle = () => new Promise((r) => setTimeout(r, 30));
const APPROVE = `POST /ads/proposals/${ADS_IDS.proposal}/approve`;
const REJECT = `POST /ads/proposals/${ADS_IDS.proposal}/reject`;
const card = () => screen.findByRole('article', { name: 'Budget proposal' });

describe('ProposalCard', () => {
  it('R-STAFF-3: each row’s sentence and from → to, and the daily total against the ceiling', async () => {
    adsApp(adsFake());
    const c = await card();
    expect(within(c).getByText(proposal().explanation)).toBeInTheDocument();
    expect(within(c).getByText('$50.00 → $60.00 a day')).toBeInTheDocument();
    expect(within(c).getByText(/^Raise from \$50\.00 to \$60\.00 a day/)).toBeInTheDocument();
    expect(within(c).getByText('$40.00 → $30.00 a day')).toBeInTheDocument();
    expect(within(c).getByTestId('proposal-total')).toHaveTextContent('Daily budgets total $90.00 (now $90.00) against your $120.00 daily ceiling.');
    expect(c.textContent).not.toMatch(RAW);
  });

  it('R-STAFF-2 R-STAFF-4: Approve is one tap and one request to /ads/proposals/:id/approve with no body fields and no command id; the result is said row by row and Approve goes away', async () => {
    const fake = adsFake().on(APPROVE, { status: 200, body: run('applied') });
    adsApp(fake);
    const c = await card();
    await user().click(within(c).getByRole('button', { name: 'Approve' }));
    expect(await within(c).findByText('Approved.')).toBeInTheDocument();
    expect(within(c).getByText(/: \$50\.00 → \$60\.00 a day\. Changed on Google Ads\./)).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Reject' })).toBeNull();
    const calls = fake.callsTo(APPROVE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({});
    expect(fake.calls.some((x) => x.path.startsWith('/assistant'))).toBe(false);
  });

  it('E669 R-STAFF-4: rows still pending say "Waiting for Google Ads to confirm; checked hourly" and nothing is sent again; a failed row is said in words', async () => {
    const r = run('pending');
    r.rows[1] = { ...r.rows[1]!, outcome: 'failed', outcomeCode: 'SHARED_BUDGET' };
    const fake = adsFake().on(APPROVE, { status: 200, body: r });
    adsApp(fake);
    const c = await card();
    await user().click(within(c).getByRole('button', { name: 'Approve' }));
    expect(await within(c).findByText('Approved. Waiting for Google Ads to confirm; checked hourly.')).toBeInTheDocument();
    expect(within(c).getByText(/Waiting for Google Ads to confirm; checked hourly\.$/, { selector: 'li' })).toBeInTheDocument();
    expect(within(c).getByText(/Not changed: the campaign uses a shared budget\./)).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /Approve|Try again|Retry/ })).toBeNull();
    await settle();
    expect(fake.callsTo(APPROVE)).toHaveLength(1);
    expect(c.textContent).not.toMatch(RAW);
  });

  it('R-STAFF-4: a 502 on Approve sends exactly one request, says the outcome is unknown and offers no retry', async () => {
    const fake = adsFake().on(APPROVE, { status: 502 });
    adsApp(fake);
    const c = await card();
    await user().click(within(c).getByRole('button', { name: 'Approve' }));
    expect(await within(c).findByText(/could not tell whether your tap reached the server/)).toBeInTheDocument();
    await settle();
    expect(fake.callsTo(APPROVE)).toHaveLength(1);
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('R-STAFF-4: Reject is one tap and one request; a 502 on Reject is never re-sent', async () => {
    const fake = adsFake().on(REJECT, { status: 200, body: { actionId: ADS_IDS.proposal, status: 'rejected' } });
    adsApp(fake);
    const c = await card();
    await user().click(within(c).getByRole('button', { name: 'Reject' }));
    expect(await within(c).findByText('Rejected. No budget changes.')).toBeInTheDocument();
    expect(fake.callsTo(REJECT)).toHaveLength(1);
    expect(fake.callsTo(REJECT)[0]!.body).toEqual({});
    expect(fake.callsTo(APPROVE)).toHaveLength(0);

    document.body.innerHTML = '';
    const fake2 = adsFake().on(REJECT, { status: 502 });
    adsApp(fake2);
    await user().click(within(await card()).getByRole('button', { name: 'Reject' }));
    await screen.findByText(/could not tell whether your tap reached the server/);
    await settle();
    expect(fake2.callsTo(REJECT)).toHaveLength(1);
  });

  const refusals: [string, Record<string, unknown> | undefined, string][] = [
    ['ADS_PROPOSAL_STALE', { reason: 'CAP_VERSION_CHANGED' }, 'This proposal was replaced because the cap changed since it was made. Nothing was changed.'],
    ['ADS_PROPOSAL_STALE', { reason: 'PLATFORM_CHANGED' }, 'This proposal was replaced because a budget was changed in Google Ads meanwhile. Nothing was changed.'],
    ['ACTION_NOT_PENDING', { status: 'superseded' }, 'A newer proposal replaced this one. The page now shows the current one.'],
    ['ACTION_NOT_PENDING', { status: 'approved' }, 'Someone already approved this proposal.'],
    ['AD_CAP_VERSION_STALE', undefined, 'The cap changed after this proposal was made, so it was not approved. Nothing was changed.'],
    ['AD_CAP_EXCEEDED', undefined, 'This change would take the daily budgets above your daily ceiling, so it was not approved. Nothing was changed.'],
  ];
  for (const [code, details, words] of refusals) {
    it(`E668 R-STAFF-4: ${code}${details ? ` ${JSON.stringify(details)}` : ''} is said in words, the card refetches and no retry control is offered`, async () => {
      const fake = adsFake().on(APPROVE, staffError(code, details));
      adsApp(fake);
      const c = await card();
      await waitFor(() => expect(fake.callsTo('GET /ads').length).toBeGreaterThan(0));
      const before = fake.callsTo('GET /ads').length;
      await user().click(within(c).getByRole('button', { name: 'Approve' }));
      expect(await within(c).findByText(words)).toBeInTheDocument();
      await waitFor(() => expect(fake.callsTo('GET /ads').length).toBeGreaterThan(before));
      expect(within(c).queryByRole('button')).toBeNull();
      expect(fake.callsTo(APPROVE)).toHaveLength(1);
      expect(screen.getByRole('main').textContent).not.toMatch(RAW);
    });
  }

  const odd: [string, unknown][] = [
    ['no payload version', { ...proposalPayload(), v: 2 }],
    ['a hold shape', hold().payload],
    ['no totals', { ...proposalPayload(), totals: undefined }],
    ['a change that is not one of the rows', { ...proposalPayload(), changes: [{ campaign_id: ADS_IDS.north, to_daily_cents: 9_999 }] }],
    ['amounts as strings', { ...proposalPayload(), rows: proposalPayload().rows.map((r) => ({ ...r, toDailyCents: String(r.toDailyCents) })) }],
    ['a negative amount', { ...proposalPayload(), totals: { currentDailyCents: -1, proposedDailyCents: 0, ceilingDailyCents: 0 } }],
    ['no changes', { ...proposalPayload(), changes: [] }],
    ['rows not a list', { ...proposalPayload(), rows: { a: 1 } }],
  ];
  for (const [what, payload] of odd) {
    it(`R-STAFF-4: a payload with ${what} shows only the explanation, with no Approve`, async () => {
      adsApp(adsFake(overview({ pendingProposal: proposal({ payload: payload as Record<string, unknown> }) })));
      const c = await card();
      expect(within(c).getByText(proposal().explanation)).toBeInTheDocument();
      expect(within(c).queryByRole('button', { name: 'Approve' })).toBeNull();
      expect(within(c).queryByRole('list')).toBeNull();
    });
  }

  it('parseProposal and parseHold never throw on anything', () => {
    for (const x of [null, undefined, 1, 'x', [], {}, { v: 1 }, { v: 1, rows: [null], changes: [null] }, { v: 1, hold: 'X', counts: { windowDays: 'a' } }]) {
      expect(() => parseProposal(x)).not.toThrow();
      expect(parseProposal(x)).toBeNull();
      expect(() => parseHold(x)).not.toThrow();
    }
    expect(parseProposal(proposalPayload())?.rows).toHaveLength(2);
    expect(parseHold(hold().payload)?.campaigns).toHaveLength(2);
  });
});
