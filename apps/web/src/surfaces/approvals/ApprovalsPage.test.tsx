// Approvals inbox in jsdom: each card shows the assistant's explanation and every claim with its
// evidence (source + locator + snippet), needs-review claims flagged "Check this" (and reviewable),
// no confidence anywhere (R-AST-13), Send in 1 tap, the stale-draft re-review (R-AST-6), sources
// removed under retention (E49 display), and saved-search proposals whose unverified criteria stay
// unchecked until the agent checks them (R-AST-5).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { FakeFetch, findToast, IDS, agentApp, decision, draftAction, err, reachability, stopReason } from '../feed/lib/testing.js';
import type { ActionView, SavedSearchView } from '../feed/lib/types.js';

const user = () => userEvent.setup();

function inbox(items: ActionView[]) {
  return new FakeFetch().on('GET /assistant/inbox', { status: 200, body: { items } });
}

const callClaim = {
  id: IDS.claim2,
  kind: 'callback_due',
  text: 'Callback due',
  needsReview: false,
  reviewStatus: 'unreviewed',
  due: { at: '2026-11-12T00:00:00.000Z', display: 'Thu Nov 12, 4 PM', allDay: false },
  evidence: [{ sourceType: 'call', sourceId: IDS.call, locator: { kind: 'transcript_offset', startMs: 134_000, endMs: 137_000 }, snippet: 'call me Thursday around four', verified: true, sourceAvailable: true, label: '“call me Thursday around four” at 2:14 in the call' }],
};

describe('Approvals inbox', () => {
  it('R-INBOX-4 (review ui-compose/F3): each draft is captioned by the channel it goes out on, a web-chat reply as a chat reply, never as an email', async () => {
    const chat = draftAction({ id: IDS.draft, draft: { channel: 'web_chat', subject: null, body: 'Happy to help with Elm!' } });
    const text = draftAction({ id: '01900000-0000-7000-8000-0000000d0f02', draft: { channel: 'sms', subject: null, body: 'Saturday works.' } });
    const mail = draftAction({ id: '01900000-0000-7000-8000-0000000d0f03', draft: { channel: 'email', subject: 'The house', body: 'Attached.' } });
    agentApp(inbox([chat, text, mail]), '/approvals');
    expect(await screen.findByText('Chat reply the assistant drafted')).toBeInTheDocument();
    expect(screen.getByText('Text the assistant drafted')).toBeInTheDocument();
    expect(screen.getAllByText('Email the assistant drafted')).toHaveLength(1);
  });

  it('R-INBOX-4 (review ui-compose/F3): Send on a web-chat draft is judged by the chat, never by the texts: a STOP on their phone leaves it enabled; a chat that ended disables it, with the reason', async () => {
    const chat = draftAction({ draft: { channel: 'web_chat', subject: null, body: 'Happy to help with Elm!' } });
    for (const [state, disabled] of [['open', false], ['ended', true]] as const) {
      const fake = inbox([chat]).on(`GET /reachability?contactIds=${IDS.jane}`, { status: 200, body: { reachability: [reachability(IDS.jane, { sms: [stopReason()] }, state)] } });
      const { view } = agentApp(fake, '/approvals');
      const send = await screen.findByRole('button', { name: 'Send' });
      await waitFor(() => expect(fake.callsTo(`GET /reachability?contactIds=${IDS.jane}`).length).toBeGreaterThan(0));
      if (disabled) {
        await waitFor(() => expect(send).toBeDisabled());
        expect(send).toHaveAccessibleDescription('The chat has ended: they left the page');
      } else {
        await new Promise((r) => setTimeout(r, 50));
        expect(send).toBeEnabled();
      }
      expect(document.body.textContent).not.toContain('Texted STOP');
      view.unmount();
    }
  });

  it('a card shows the explanation and each claim with its evidence; tapping the evidence opens the source', async () => {
    const fake = inbox([draftAction({ claims: [callClaim] })]);
    const { router } = agentApp(fake, '/approvals');
    expect(await screen.findByText('She asked whether Saturday works for a showing.')).toBeInTheDocument();
    expect(screen.getByText('Callback due (Thu Nov 12, 4 PM)')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /“call me Thursday around four” at 2:14 in the call/ });
    await user().click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/contacts/${IDS.jane}/thread`));
    expect(router.state.location.hash).toBe(`#${IDS.call}`);
  });

  it('R-AST-13: no confidence, score or percentage is rendered for assistant output, whatever the payload carries', async () => {
    const a = { ...draftAction({ claims: [{ ...callClaim, confidence: 0.83 } as never] }), confidence: 0.91, confidenceBand: 'high', score: 77 } as unknown as ActionView;
    agentApp(inbox([a]), '/approvals');
    await screen.findByText('She asked whether Saturday works for a showing.');
    const text = document.body.textContent ?? '';
    for (const banned of ['0.91', '91%', '0.83', '83%', 'high confidence', 'confidence', 'Confidence', '77']) expect(text).not.toContain(banned);
    expect(text).not.toMatch(/\d+\s?%/);
  });

  it('a needs-review claim is shown flagged "Check this" (never dropped) and can be confirmed in place', async () => {
    const shaky = { ...callClaim, id: IDS.claim, needsReview: true, evidence: [{ ...callClaim.evidence[0]!, verified: false, label: 'Not found in the source: “call me friday”' , snippet: 'call me friday' }] };
    const fake = inbox([draftAction({ claims: [shaky] })]).on(`POST /assistant/claims/${IDS.claim}/review`, { status: 200, body: { claimId: IDS.claim, reviewStatus: 'confirmed' } });
    agentApp(fake, '/approvals');
    const card = (await screen.findByText('Callback due (Thu Nov 12, 4 PM)')).closest('article')!;
    expect(within(card).getAllByText('Check this').length).toBeGreaterThanOrEqual(1);
    await user().click(within(card).getByRole('button', { name: 'Looks right' }));
    expect(await within(card).findByText('Confirmed.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /assistant/claims/${IDS.claim}/review`)[0]!.body).toEqual({ status: 'confirmed' });
  });

  it('evidence whose source was removed under the retention policy says so; the claim stays', async () => {
    const gone = { ...callClaim, evidence: [{ ...callClaim.evidence[0]!, snippet: null, sourceAvailable: false, label: 'Source removed under retention policy' }] };
    agentApp(inbox([draftAction({ claims: [gone] })]), '/approvals');
    expect(await screen.findByText('Source removed under retention policy')).toBeInTheDocument();
    expect(screen.getByText('Callback due (Thu Nov 12, 4 PM)')).toBeInTheDocument();
  });

  it('approving a draft is 1 tap (Send)', async () => {
    const fake = inbox([draftAction()]).on(`POST /assistant/actions/${IDS.draft}/approve`, { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } });
    agentApp(fake, '/approvals');
    await user().click(await screen.findByRole('button', { name: 'Send' }));
    expect(await findToast('Sent to Jane Doe.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toHaveLength(1);
  });

  it('R-AST-6: a stale draft says the client replied, links to the new message, and "Send anyway" carries the seen inbound seq', async () => {
    const fake = inbox([draftAction()]).on(`POST /assistant/actions/${IDS.draft}/approve`, (c) =>
      (c.body as { reviewedInboundSeq?: number }).reviewedInboundSeq === 12 ? { status: 200, body: { actionId: IDS.draft, status: 'approved', result: 'sent', messageId: IDS.message, decision: decision({}) } } : err(409, 'DRAFT_STALE', { inboundSeq: 12, pinnedInboundSeq: 11 }),
    );
    agentApp(fake, '/approvals');
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Jane replied since this was drafted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read it' })).toHaveAttribute('href', `/contacts/${IDS.jane}/thread?compose=draft&draft=${IDS.draft}`);
    await u.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(await findToast('Sent to Jane Doe.')).toBeInTheDocument();
    expect((fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)[1]!.body as { reviewedInboundSeq: number }).reviewedInboundSeq).toBe(12);
  });

  it('a handback without a reply draft offers Reply and Mark handled', async () => {
    const hb = draftAction({ id: IDS.handback, kind: 'handback', primaryAction: 'acknowledge', draft: null, explanation: 'Jane replied to the assistant: follow-ups are paused.' });
    const fake = inbox([hb]).on(`POST /assistant/actions/${IDS.handback}/approve`, { status: 200, body: { actionId: IDS.handback, status: 'approved', result: 'acknowledged', messageId: null, decision: null } });
    const { router } = agentApp(fake, '/approvals');
    await user().click(await screen.findByRole('button', { name: 'Mark handled' }));
    expect(await findToast('Marked as handled.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/contacts/${IDS.jane}/thread`));
  });

  it('R-AST-5: a saved-search proposal lists verified criteria checked and unverified ones unchecked; approving sends only what the agent checked', async () => {
    const search: SavedSearchView = {
      id: IDS.search,
      contactId: IDS.jane,
      name: 'Jane: 3 bd in 94110',
      status: 'proposed',
      criteria: { postalCodes: ['94110'], bedsMin: 3 },
      criterionEvidence: { postalCodes: IDS.claim2, priceMaxCents: IDS.claim },
      unchecked: ['priceMaxCents'],
      prefill: { priceMaxCents: 90_000_000 },
      alertChannel: 'email',
      alertFrequency: 'daily',
      matches: [],
    };
    const proposal = draftAction({ id: IDS.proposal, kind: 'saved_search_proposal', primaryAction: 'acknowledge', draft: null, explanation: 'From your call: a buyer search.', claims: [{ ...callClaim, text: 'Wants 94110' }] });
    const fake = inbox([proposal])
      .on(`GET /contacts/${IDS.jane}/saved-searches`, { status: 200, body: { searches: [search] } })
      .on(`POST /saved-searches/${IDS.search}/approve`, { status: 200, body: { search: { ...search, status: 'approved' } } });
    agentApp(fake, '/approvals');
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Review search' }));
    const box = await screen.findByTestId('saved-search');
    const zip = within(box).getByRole('checkbox', { name: /ZIP codes: 94110/ });
    const price = within(box).getByRole('checkbox', { name: /Highest price: \$900,000/ });
    expect(zip).toBeChecked();
    expect(price).not.toBeChecked();
    expect(price.closest('[data-needs-review]')).not.toBeNull();
    await u.click(within(box).getByRole('button', { name: 'Approve search' }));
    await waitFor(() => expect(fake.callsTo(`POST /saved-searches/${IDS.search}/approve`)).toHaveLength(1));
    expect(fake.callsTo(`POST /saved-searches/${IDS.search}/approve`)[0]!.body).toEqual({ checked: [] });
  });

  it('R-AST-5: checking an unverified criterion is what adds it', async () => {
    const search: SavedSearchView = { id: IDS.search, contactId: IDS.jane, name: 'S', status: 'proposed', criteria: { bedsMin: 3 }, criterionEvidence: {}, unchecked: ['priceMaxCents'], prefill: { priceMaxCents: 90_000_000 }, alertChannel: 'email', alertFrequency: 'daily', matches: [] };
    const proposal = draftAction({ id: IDS.proposal, kind: 'saved_search_proposal', primaryAction: 'acknowledge', draft: null, claims: [] });
    const fake = inbox([proposal])
      .on(`GET /contacts/${IDS.jane}/saved-searches`, { status: 200, body: { searches: [search] } })
      .on(`POST /saved-searches/${IDS.search}/approve`, { status: 200, body: { search: { ...search, status: 'approved' } } });
    agentApp(fake, '/approvals');
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Review search' }));
    const box = await screen.findByTestId('saved-search');
    await u.click(within(box).getByRole('checkbox', { name: /Highest price/ }));
    await u.click(within(box).getByRole('checkbox', { name: /Bedrooms: 3\+/ }));
    await u.click(within(box).getByRole('button', { name: 'Approve search' }));
    await waitFor(() => expect(fake.callsTo(`POST /saved-searches/${IDS.search}/approve`)).toHaveLength(1));
    expect(fake.callsTo(`POST /saved-searches/${IDS.search}/approve`)[0]!.body).toEqual({ checked: ['priceMaxCents'], removed: ['bedsMin'] });
  });

  it('an empty inbox says so plainly', async () => {
    agentApp(inbox([]), '/approvals');
    expect(await screen.findByText('Nothing to approve')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    agentApp(inbox([draftAction({ claims: [callClaim] })]), '/approvals');
    await screen.findByRole('button', { name: 'Send' });
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('Approvals inbox: opt-outs said before the tap (lane optout-visibility)', () => {
  it('R-CONSENT-10: a drafted text to someone who texted STOP cannot be sent: Send is disabled with the exact reason, nothing is approved', async () => {
    const fake = inbox([draftAction()]).on(`GET /reachability?contactIds=${IDS.jane}`, { status: 200, body: { reachability: [reachability(IDS.jane, { sms: [stopReason()] })] } });
    agentApp(fake, '/approvals');
    expect(await screen.findByText('Texted STOP on Nov 10')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription('Texted STOP on Nov 10');
    expect(fake.callsTo(`POST /assistant/actions/${IDS.draft}/approve`)).toEqual([]);
  });
});

