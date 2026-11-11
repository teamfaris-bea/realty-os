// Fixtures for core/nurture tests and for module 26's fakes: a built-in "Behavior alerts"-shaped
// trigger content, candidates and facts. Not for production paths.
import type { IdentityFacts, PlaybookContent, TriggerStep } from '../../assistant/index.js';
import { type Instant, instant } from '../../foundation/index.js';
import type { Fact, TriggerCandidate, TriggerPlaybookRef } from '../types.js';

export const T0: Instant = instant(Date.UTC(2026, 10, 10, 15, 0, 0));

export const IDENTITY: IdentityFacts = {
  brokerageLegalName: 'Acme Realty LLC',
  teamName: 'Smith Team',
  agentFirstName: 'Sarah',
  scope: 'agent',
  allowedLinkHosts: ['smithteam.com'],
  brokeragePostalAddress: '1 Main St, Boston, MA 02108',
};

export const PRICE_DROP_STEP: TriggerStep = {
  trigger: 'price_drop',
  stepKey: 'price_drop_email',
  channel: 'email',
  offsetSeconds: 0,
  purpose: 'marketing',
  category: 'search_alert',
  intent: 'price_drop_alert',
  template: 'Hi {{first_name}}, a home you saved has a new price.\n{{listing_address}}: {{listing_price}}',
  subject: 'A home you saved has a new price',
  slots: ['first_name', 'listing_address', 'listing_price'],
  maxLength: 2000,
};

export const BACK_ON_MARKET_STEP: TriggerStep = {
  ...PRICE_DROP_STEP,
  trigger: 'back_on_market',
  stepKey: 'back_on_market_email',
  intent: 'back_on_market_alert',
  template: 'Hi {{first_name}}, a home you saved is back on the market: {{listing_address}}',
  subject: 'A home you saved is back on the market',
  slots: ['first_name', 'listing_address'],
};

export const BEHAVIOR_ALERTS: Extract<PlaybookContent, { kind: 'triggers' }> = { kind: 'triggers', triggers: [PRICE_DROP_STEP, BACK_ON_MARKET_STEP], digestWindowMinutes: 60 };

export const AGENT_PLAYBOOK: TriggerPlaybookRef = {
  playbookId: 'pb-agent',
  versionId: 'pv-agent-1',
  scope: 'agent',
  ownerUserId: 'u-sarah',
  steps: [
    { trigger: 'price_drop', stepKey: 'price_drop_email', offsetSeconds: 0 },
    { trigger: 'back_on_market', stepKey: 'back_on_market_email', offsetSeconds: 0 },
  ],
};

export const TEAM_PLAYBOOK: TriggerPlaybookRef = { ...AGENT_PLAYBOOK, playbookId: 'pb-team', versionId: 'pv-team-1', scope: 'team', ownerUserId: null };

export function priceDrop(over: Partial<Extract<Fact, { kind: 'price_change' }>> = {}): Extract<Fact, { kind: 'price_change' }> {
  return { kind: 'price_change', listingId: 'l-1', historyId: 'h-1', source: 'mls', oldPriceCents: 50_000_000, newPriceCents: 48_000_000, at: T0, address: '12 Elm St', mlsNumber: '7300001', displayAllowed: true, feedFresh: true, ...over };
}

export function savedBy(contactId: string, listingId: string, ownerUserId: string | null = 'u-sarah', playbook: TriggerPlaybookRef = AGENT_PLAYBOOK): TriggerCandidate {
  return { contactId, ownerUserId, relation: { kind: 'listing', listingId, via: 'saved' }, playbook };
}
