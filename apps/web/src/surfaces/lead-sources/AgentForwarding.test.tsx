// An agent's forwarded email, guided, in jsdom: pick the agent and the portals that email them (Zillow and
// Realtor.com start ticked); "Set it up" makes "Forwarded by <name>" (kind portal), turns its lead email on with those
// portals' sender domains, adds a direct routing rule and shows where a new lead would go; when another rule wins,
// "Move this rule to the top" sends the whole new order; then the agent's own steps, in order.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ID, member } from '../admin/lib/testing.js';
import { enabledInbox } from '../lead-email/testing.js';
import { ADDR, S2, err, overview, source, sourcesApp, sourcesFake } from './testing.js';
import { gmailFrom } from './words.js';

const RULE = '01900000-0000-7000-8000-0000000r0009';
const OTHER = '01900000-0000-7000-8000-0000000r0001';
const ruleView = (id: string, name: string, position: number) => ({ id, position, name, match: {}, strategy: 'direct', directUserId: ID.ava, targetPondId: null, fallbackPondId: null, offerWindowSeconds: null, maxOffers: null, enabled: true, archived: false, version: 1, members: [] });
const offer = (ruleId: string, ruleName: string) => ({ rule: { id: ruleId, name: ruleName }, outcome: { kind: 'offer', userId: ID.ava, name: 'Ava Agent' }, considered: [{ userId: ID.ava, name: 'Ava Agent', eligible: true, reason: null }], sentence: 'If a lead came in now, it would be offered to Ava Agent.', firstResponse: 'queued' });

function forwardingFake() {
  let moved = false;
  return sourcesFake(overview([source()]))
    .on('GET /members', { status: 200, body: { members: [member(), member({ userId: ID.ben, displayName: 'Ben Agent' }), member({ userId: 'tc-1', displayName: 'Tia TC', role: 'tc' })], invites: [] } })
    .on('POST /lead-sources', (c) => ({ status: 201, body: { source: { id: S2, name: (c.body as { name: string }).name, kind: 'portal', active: true, hasToken: true, createdAt: '' }, ingestToken: 't', intakePath: '/api/intake/t' } }))
    .on(`POST /lead-sources/${S2}/lead-email`, (c) => ({ status: 200, body: { inbox: enabledInbox({ leadSourceId: S2, address: ADDR, allowedSenderDomains: (c.body as { allowedSenderDomains: string[] }).allowedSenderDomains }) } }))
    .on('POST /routing-rules', { status: 201, body: { rule: ruleView(RULE, 'Forwarded by Ava Agent', 2) } })
    .on('GET /routing-rules', { status: 200, body: { rules: [ruleView(OTHER, 'Everyone', 1), ruleView(RULE, 'Forwarded by Ava Agent', 2)] } })
    .on('PUT /routing-rules/order', () => ((moved = true), { status: 200, body: { rules: [] } }))
    .on(`POST /lead-sources/${S2}/preview`, () => ({ status: 200, body: moved ? offer(RULE, 'Forwarded by Ava Agent') : offer(OTHER, 'Everyone') }));
}

async function openGuide(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByRole('button', { name: 'Add a source' }));
  const add = within(screen.getByRole('dialog', { name: 'Add a source' }));
  await u.click(add.getByRole('radio', { name: /An agent's forwarded email/ }));
  await u.click(add.getByRole('button', { name: 'Continue' }));
  return within(await screen.findByRole('dialog', { name: "An agent's forwarded email" }));
}

describe("An agent's forwarded email", () => {
  it('makes "Forwarded by <name>" with lead email for the portals picked, a direct rule, the preview, and moves the rule to the top when another wins', async () => {
    const fake = forwardingFake();
    sourcesApp(fake, '/admin/lead-sources', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const g = await openGuide(u);
    const agent = g.getByLabelText('Agent');
    await waitFor(() => expect(within(agent).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick someone', 'Ava Agent', 'Ben Agent']));
    expect(g.getByLabelText('Zillow')).toBeChecked();
    expect(g.getByLabelText('Realtor.com')).toBeChecked();
    expect(g.getByLabelText('Redfin')).not.toBeChecked();
    expect(g.getByRole('button', { name: 'Set it up' })).toBeDisabled();
    await u.selectOptions(agent, ID.ava);
    await u.click(g.getByLabelText('Homes.com'));
    await u.click(g.getByRole('button', { name: 'Set it up' }));

    expect(await g.findByText('If a lead came in now, it would be offered to Ava Agent.')).toBeInTheDocument();
    expect(fake.callsTo('POST /lead-sources')[0]!.body).toEqual({ name: 'Forwarded by Ava Agent', kind: 'portal' });
    expect(fake.callsTo(`POST /lead-sources/${S2}/lead-email`)[0]!.body).toEqual({ allowedSenderDomains: ['zillow.com', 'realtor.com', 'homes.com', 'homesnap.com'] });
    expect(fake.callsTo('POST /routing-rules')[0]!.body).toEqual({ name: 'Forwarded by Ava Agent', strategy: 'direct', directUserId: ID.ava, match: { sources: [S2] } });
    expect(g.getByLabelText('Lead-email address')).toHaveValue(ADDR);

    // another rule decides first: say so and offer to move this one to the top
    expect(g.getByText('The rule "Everyone" comes first, so it decides these leads.')).toBeInTheDocument();
    await u.click(g.getByRole('button', { name: 'Move this rule to the top' }));
    await waitFor(() => expect(fake.callsTo('PUT /routing-rules/order')).toHaveLength(1));
    expect(fake.callsTo('PUT /routing-rules/order')[0]!.body).toEqual({ ruleIds: [RULE, OTHER] });
    expect(await g.findByText('The new rule decides these leads.')).toBeInTheDocument();
    expect(g.queryByRole('button', { name: 'Move this rule to the top' })).toBeNull();
  });

  it("the agent's steps come in order: the portal's own notification or CC field first, then Gmail (code in Needs review; a From filter of the picked domains), Outlook's Redirect to, and one at a time", async () => {
    sourcesApp(forwardingFake(), '/admin/lead-sources', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const g = await openGuide(u);
    await waitFor(() => expect(within(g.getByLabelText('Agent')).getAllByRole('option')).toHaveLength(3));
    await u.selectOptions(g.getByLabelText('Agent'), ID.ava);
    await u.click(g.getByLabelText('Opcity'));
    await u.click(g.getByRole('button', { name: 'Set it up' }));
    const steps = within(await g.findByRole('list', { name: "The agent's steps" }));
    const items = steps.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/^a\. Best: send it from the portal/);
    expect(items[0]).toContain("Best: put this address in each portal's lead-notification or CC field");
    expect(items[0]).toContain('Zillow: put this address in the lead-notification or CC field.');
    expect(items[0]).toContain("Opcity: set Opcity's main email to this address.");
    expect(items[1]).toMatch(/^b\. Gmail/);
    expect(items[1]).toContain(`Settings → Forwarding → Add a forwarding address: ${ADDR}.`);
    expect(items[1]).toContain('Gmail emails a code to this address; your Owner, Admin or Team Lead sees it in Needs review, so ask them for it.');
    expect(items[1]).toContain(`Then make a filter From: zillow.com OR realtor.com OR opcity.com → Forward it to ${ADDR}.`);
    expect(items[2]).toMatch(/^c\. Outlook or Microsoft 365/);
    expect(items[2]).toContain('"Redirect to"');
    expect(items[2]).toContain('not "Forward to" (Forward makes the email look like it came from you)');
    expect(items[2]).toContain('Your mail admin may block it.');
    expect(items[3]).toBe('d. One at a timeForwarding one at a time works, but each one waits for review.');
    expect(gmailFrom(['a.com'])).toBe('a.com');
  });

  it('a failed step is a sentence; trying again goes on from there and never makes the source twice', async () => {
    let n = 0;
    const fake = forwardingFake().on('POST /routing-rules', () => (++n === 1 ? err(422, 'MEMBER_NOT_ELIGIBLE') : { status: 201, body: { rule: ruleView(RULE, 'Forwarded by Ava Agent', 1) } }));
    fake.on(`POST /lead-sources/${S2}/preview`, { status: 200, body: offer(RULE, 'Forwarded by Ava Agent') });
    sourcesApp(fake, '/admin/lead-sources', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const g = await openGuide(u);
    await waitFor(() => expect(within(g.getByLabelText('Agent')).getAllByRole('option')).toHaveLength(3));
    await u.selectOptions(g.getByLabelText('Agent'), ID.ava);
    await u.click(g.getByRole('button', { name: 'Set it up' }));
    expect(await g.findByText("One of the people picked can't receive leads (not active, or a role that never takes leads).")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/MEMBER_NOT_ELIGIBLE/);
    await u.click(g.getByRole('button', { name: 'Set it up' }));
    expect(await g.findByText('The new rule decides these leads.')).toBeInTheDocument();
    expect(fake.callsTo('POST /lead-sources')).toHaveLength(1);
    expect(fake.callsTo(`POST /lead-sources/${S2}/lead-email`)).toHaveLength(1);
    expect(fake.callsTo('POST /routing-rules')).toHaveLength(2);
  });

  it('on a deployment without inbound email it says so and sets nothing up', async () => {
    const fake = forwardingFake().on('GET /lead-sources/overview', { status: 200, body: overview([source()], { inboundEmail: false }) });
    sourcesApp(fake, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    const g = await openGuide(u);
    await waitFor(() => expect(within(g.getByLabelText('Agent')).getAllByRole('option')).toHaveLength(3));
    await u.selectOptions(g.getByLabelText('Agent'), ID.ava);
    expect(g.getByText(/Lead email isn't set up on this server yet/)).toBeInTheDocument();
    expect(g.getByRole('button', { name: 'Set it up' })).toBeDisabled();
  });
});
