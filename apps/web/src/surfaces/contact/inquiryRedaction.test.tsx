// b18 review B18S-2 (R-PORTAL-20): the person page's latest inquiry says when a quoted sign-in link token is not shown:
// stored redacted at intake ('stored', 0097) or an older inquiry hidden on this screen only ('display'). Synthetic text.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INQUIRY_REDACTION_NOTE } from '../thread/redaction.js';
import { FakeFetch, IDS, agentApp, fullContact, reachability } from '../feed/lib/testing.js';
import type { ContactFullView } from '../feed/lib/types.js';

type Inquiry = ContactFullView['inquiries'][number];
const inquiry = (message: string, redaction: Inquiry['redaction']): Inquiry => ({
  id: '01900000-0000-7000-8000-0000000000a7',
  receivedAt: '2026-11-14T15:00:00Z',
  inquiryType: 'buy',
  source: 'Website chat',
  postalCode: null,
  priceMinCents: null,
  priceMaxCents: null,
  campaignRef: null,
  adRef: null,
  propertyText: null,
  message,
  outcome: 'new_contact',
  redaction,
});

function open(i: Inquiry) {
  const contact = fullContact({ inquiries: [i] });
  const fake = new FakeFetch()
    .on(`GET /contacts/${contact.id}`, { status: 200, body: { contact } })
    .on(`GET /contacts/${contact.id}/timeline?limit=100`, { status: 200, body: { items: [], nextCursor: null } })
    .on('GET /assistant/inbox', { status: 200, body: { items: [] } })
    .on(`GET /tasks?contactId=${contact.id}&scope=visible&status=open`, { status: 200, body: { tasks: [] } })
    .on(`GET /deals?contactId=${contact.id}`, { status: 200, body: { deals: [] } })
    .on(`GET /contacts/${contact.id}/saved-searches`, { status: 200, body: { searches: [] } })
    .on(`GET /contacts/${contact.id}/reachability`, { status: 200, body: { reachability: reachability(IDS.jane) } });
  agentApp(fake, `/contacts/${contact.id}`);
}

describe('R-PORTAL-20 the person page labels an inquiry whose sign-in link token is not shown (b18 review B18S-2)', () => {
  it('R-PORTAL-20 (b18 review B18S-2): an inquiry stored redacted says it is not the exact original', async () => {
    open(inquiry('this sign-in link did not work https://app.realty-os.invalid/portal.html#token=[sign-in token removed]', 'stored'));
    expect(await screen.findByText(INQUIRY_REDACTION_NOTE.stored)).toBeInTheDocument();
    expect(INQUIRY_REDACTION_NOTE.stored).toMatch(/removed before the inquiry was saved, so this is not the exact original/);
    expect(screen.queryByText(INQUIRY_REDACTION_NOTE.display)).toBeNull();
  });

  it('R-PORTAL-20 (b18 review B18S-2): an older inquiry hidden on screen only says it is hidden here, never that it was not kept', async () => {
    open(inquiry('Earlier: https://app.realty-os.invalid/portal.html#token=[sign-in token hidden]', 'display'));
    expect(await screen.findByText(INQUIRY_REDACTION_NOTE.display)).toBeInTheDocument();
    expect(screen.queryByText(INQUIRY_REDACTION_NOTE.stored)).toBeNull();
  });

  it('R-PORTAL-20 (b18 review B18S-2): an inquiry with no redaction carries no label', async () => {
    open(inquiry('Is the house on Elm still available?', null));
    expect(await screen.findByText(/Is the house on Elm still available\?/)).toBeInTheDocument();
    expect(screen.queryByText(INQUIRY_REDACTION_NOTE.stored)).toBeNull();
    expect(screen.queryByText(INQUIRY_REDACTION_NOTE.display)).toBeNull();
  });
});
