// Lead routing page in jsdom: rules (create, reorder in one request), ponds, and lead timers
// (R-OWN-15 display: the page says new values apply to new deadlines only; only changed fields are sent,
// with the settings version).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, leadAdminApp, member, settings } from './lib/testing.js';
import type { Pond, RoutingRule } from './lib/types.js';
import { fromInput, toInput } from './RoutingPage.js';

const pond: Pond = { id: 'pond-1', name: 'Team pond', isDefault: true, openToAll: true, eligibleRoles: ['agent', 'team_lead'], claimsPerDay: 5, claimCooldownHours: 72, reinquiry: 'reroute', archived: false, memberUserIds: [], waitingLeads: 3 };
const rr = (id: string, name: string, position: number): RoutingRule => ({ id, position, name, match: {}, strategy: 'round_robin', directUserId: null, targetPondId: null, fallbackPondId: null, offerWindowSeconds: null, maxOffers: null, enabled: true, archived: false, version: 1, members: [{ userId: ID.ava, weight: 1 }] });


function routingFake(rules: RoutingRule[] = [rr('r1', 'Zillow buyers', 1), rr('r2', 'Sellers', 2), rr('r3', 'Everything else', 3)]) {
  return new FakeFetch()
    .on('GET /routing-rules', { status: 200, body: { rules } })
    .on('GET /ponds', { status: 200, body: { ponds: [pond] } })
    .on('GET /members', { status: 200, body: { members: [member(), member({ userId: ID.ben, displayName: 'Ben Agent' }), member({ userId: 'tc-1', displayName: 'Tia TC', role: 'tc' })], invites: [] } })
    .on('GET /lead-sources', { status: 200, body: { sources: [{ id: 'src-1', name: 'Zillow', kind: 'portal', active: true, hasToken: true, createdAt: '' }] } })
    .on('GET /settings', { status: 200, body: { settings } });
}

describe('Lead routing', () => {
  it('lists rules in order with a plain description; with no rules it says leads are not routed', async () => {
    leadAdminApp(routingFake(), '/admin/routing', 'admin');
    expect(await screen.findByText('Zillow buyers')).toBeInTheDocument();
    expect(screen.getAllByText('Round robin among Ava Agent')).toHaveLength(3);
    expect(screen.getByLabelText('Position 1')).toBeInTheDocument();
  });

  it('moving a rule sends the whole new order in one request', async () => {
    const fake = routingFake().on('PUT /routing-rules/order', { status: 200, body: { rules: [] } });
    leadAdminApp(fake, '/admin/routing', 'admin');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Move up: Everything else' }));
    await waitFor(() => expect(fake.callsTo('PUT /routing-rules/order')).toHaveLength(1));
    expect(fake.callsTo('PUT /routing-rules/order')[0]!.body).toEqual({ ruleIds: ['r1', 'r3', 'r2'] });
    expect(screen.getByRole('button', { name: 'Move up: Zillow buyers' })).toBeDisabled();
  });

  it('creates a round-robin rule for Zillow buyers in two ZIPs; TCs are never offered as candidates', async () => {
    const fake = routingFake([]).on('POST /routing-rules', (c) => ({ status: 201, body: { rule: { ...rr('r9', (c.body as { name: string }).name, 1) } } }));
    leadAdminApp(fake, '/admin/routing', 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText(/There are no rules yet, so new leads are not offered to anyone/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'New rule' }));
    const form = screen.getByRole('form', { name: 'New routing rule' });
    await u.type(within(form).getByLabelText('Rule name'), 'Zillow buyers');
    await u.click(within(form).getByLabelText('Buyers'));
    await u.click(within(form).getByLabelText('From Zillow'));
    await u.type(within(form).getByLabelText('ZIP codes'), '94110, 94112');
    await u.type(within(form).getByLabelText('Highest price ($)'), '900,000');
    expect(within(form).queryByLabelText(/Tia TC/)).toBeNull();
    await u.click(within(form).getByLabelText('Ava Agent · Agent'));
    await u.click(within(form).getByLabelText('Ben Agent · Agent'));
    await u.click(within(form).getByRole('button', { name: 'Create rule' }));
    expect(await screen.findByText('Rule Zillow buyers created')).toBeInTheDocument();
    expect(fake.callsTo('POST /routing-rules')[0]!.body).toEqual({
      name: 'Zillow buyers',
      match: { lead_types: ['buy'], sources: ['src-1'], zips: ['94110', '94112'], price_max: 90_000_000 },
      strategy: 'round_robin',
      directUserId: null,
      targetPondId: null,
      fallbackPondId: null,
      offerWindowSeconds: null,
      maxOffers: null,
      enabled: true,
      members: [
        { userId: ID.ava, weight: 1 },
        { userId: ID.ben, weight: 1 },
      ],
    });
  });

  it('does not send a rule that is missing what it needs, and says what is missing', async () => {
    const fake = routingFake([]);
    leadAdminApp(fake, '/admin/routing', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'New rule' }));
    await u.click(screen.getByRole('button', { name: 'Create rule' }));
    expect(await screen.findByText('Give the rule a name.')).toBeInTheDocument();
    expect(fake.callsTo('POST /routing-rules')).toHaveLength(0);
  });

  it('shows ponds with their waiting count and limits', async () => {
    leadAdminApp(routingFake(), '/admin/routing', 'admin');
    expect(await screen.findByText(/3 leads waiting · Open to Agents, Team Leads · 5 claims a day each · 72 h/)).toBeInTheDocument();
  });

  it('R-OWN-15 display: lead timers say they apply to new deadlines only, and saving sends only what changed with the settings version', async () => {
    const fake = routingFake().on('PATCH /settings', { status: 200, body: { settings: { ...settings, version: 8 } } });
    leadAdminApp(fake, '/admin/routing', 'admin');
    const u = userEvent.setup();
    expect(await screen.findByText('Changes apply to new offers and new deadlines. Deadlines already running keep the times they started with.')).toBeInTheDocument();
    const sla = await screen.findByLabelText('First contact due within (minutes)');
    expect(sla).toHaveValue('5');
    expect(screen.getByRole('button', { name: 'Save lead timers' })).toBeDisabled();
    await u.clear(sla);
    await u.type(sla, '10');
    const release = screen.getByLabelText('Release an untouched lead after (minutes)');
    await u.clear(release);
    await u.click(screen.getByRole('button', { name: 'Save lead timers' }));
    expect(await screen.findByText('Lead timers saved')).toBeInTheDocument();
    expect(fake.callsTo('PATCH /settings')[0]!.body).toEqual({ firstTouchSlaSeconds: 600, firstTouchReleaseSeconds: null, version: 7 });
  });

  it('E310 (owner decision D8): the first-contact timer says what counts: a call, text, email or chat reply a person sends, never the assistant’s instant reply', async () => {
    leadAdminApp(routingFake(), '/admin/routing', 'admin');
    const sla = await screen.findByLabelText('First contact due within (minutes)');
    expect(sla).toHaveAccessibleDescription(/^Counts calls, texts, emails and chat replies a person sends\. The assistant’s instant reply does not count\. /);
  });

  it('timer inputs convert minutes to seconds and keep counts and days as they are', () => {
    expect(toInput('minutes', 300)).toBe('5');
    expect(toInput('days', 30)).toBe('30');
    expect(toInput('minutes', null)).toBe('');
    expect(fromInput('minutes', '12')).toBe(720);
    expect(fromInput('count', '3')).toBe(3);
    expect(fromInput('days', '')).toBeNull();
    expect(fromInput('days', '1.5')).toBeNull();
  });

  it('lead sources live on their own page: one line links there, and no email intake is shown here', async () => {
    leadAdminApp(routingFake(), '/admin/routing', 'owner');
    expect(await screen.findByRole('link', { name: 'Lead sources' })).toHaveAttribute('href', '/admin/lead-sources');
    expect(screen.queryByRole('region', { name: /Email intake/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Lead sources' })).toBeNull();
  });
});
