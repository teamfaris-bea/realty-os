// module 46 (R-PORTALWEB-10; E653, E698): the deal's client portal section and "What {name} sees", in jsdom, on
// fixtures checked against module 45's contract.
import type { Role } from '@realty/core/foundation';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { contractSentence } from '../../portal/test/portalContract.js';
import type { SurfaceModule } from '../../shell/index.js';
import { FakeFetch } from '../../shell/testing/fakeApi.js';
import { app } from '../documents/fixtures.js';
import { ClientPortalSection } from './ClientPortalSection.js';
import * as F from './testing/fixtures.js';
import { surface } from './index.js';
import { PORTAL_STAFF_MESSAGES, STAFF_WORDS } from './words.js';

const JANE = { id: F.JANE, name: 'Jane Doe' };
const host: SurfaceModule = { pages: [{ path: '/t/deal', title: 'Deal', roles: 'all', component: () => <ClientPortalSection dealId={F.DEAL} primaryContact={JANE} /> }] };
const render = (fake: FakeFetch, path = '/t/deal', role: Role = 'agent') => app(fake, path, role, surface, host);
const section = async () => (await screen.findByRole('heading', { name: STAFF_WORDS.heading })).closest('section') as HTMLElement;
const STATE = `GET /deals/${F.DEAL}/portal`;
const INVITE = `POST /deals/${F.DEAL}/portal/invite`;

describe('ClientPortalSection (R-PORTALWEB-10)', () => {
  it("staff words: 45's sentences verbatim", () => {
    for (const [code, s] of Object.entries(PORTAL_STAFF_MESSAGES)) expect(s, code).toBe(contractSentence(code));
  });

  it('E698: a 404 (an ISA, support, another agent) hides the section', async () => {
    const fake = new FakeFetch().on(STATE, F.apiErr('NOT_FOUND'));
    render(fake, '/t/deal', 'isa');
    await waitFor(() => expect(fake.callsTo(STATE).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('heading', { name: STAFF_WORDS.heading })).toBeNull());
  });

  it('E653: uncleared: 45\'s sentence and that invitations are not sent; the "can\'t be shared from the app yet" line is always there', async () => {
    const fake = new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state({ portalCleared: false, portalText: 'The client portal is not turned on for this team yet, so the client sees nothing.' })));
    render(fake);
    const s = await section();
    expect(await within(s).findByText(`The client portal is not turned on for this team yet, so the client sees nothing. ${STAFF_WORDS.offTail}`)).toBeInTheDocument();
    expect(within(s).getByText(STAFF_WORDS.notShareable)).toBeInTheDocument();
    expect(within(s).getByText('Sign-in links by email use the test provider (test deployments only).')).toBeInTheDocument();
  });

  it('Invite is one tap with a fresh key; the sent notice is 45\'s; a second tap mints a new key; resend once invited', async () => {
    let invited = false;
    const fake = new FakeFetch()
      .on(STATE, () => F.ok('GET /deals/:id/portal', invited ? F.state({ accounts: [F.account()], grants: [F.grantStaff()] }) : F.state()))
      .on(INVITE, () => {
        invited = true;
        return F.ok('POST /deals/:id/portal/invite', F.inviteBody());
      });
    render(fake);
    const s = await section();
    await userEvent.click(await within(s).findByRole('button', { name: 'Invite Jane Doe' }));
    expect(await within(s).findByText('Jane was sent a note by email with how to sign in.')).toBeInTheDocument();
    const first = fake.callsTo(INVITE)[0]!.body as Record<string, unknown>;
    expect(F.requestProblems('POST /deals/:id/portal/invite', first, {})).toEqual([]);
    expect(first).toEqual({ contactId: F.JANE, idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) });
    await userEvent.click(await within(s).findByRole('button', { name: STAFF_WORDS.resend }));
    await waitFor(() => expect(fake.callsTo(INVITE)).toHaveLength(2));
    const second = fake.callsTo(INVITE)[1]!.body as Record<string, unknown>;
    expect(second.resend).toBe(true);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(within(s).getByRole('link', { name: 'What Jane Doe sees' })).toHaveAttribute('href', `/client-portal/${F.GRANT}`);
  });

  it('a blocked notice shows its decision, with no send-anyway; the uncleared notice says nothing was sent (E653)', async () => {
    const blocked = F.notice({ sent: false, text: 'The note to Jane was not sent; the reason is below. The invite stands.', decision: { outcome: 'deny', reasons: ['opted_out_email'], explanation: 'Opted out of email' } });
    const fake = new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state())).on(INVITE, F.ok('POST /deals/:id/portal/invite', F.inviteBody(blocked)));
    render(fake);
    const s = await section();
    await userEvent.click(await within(s).findByRole('button', { name: 'Invite Jane Doe' }));
    expect(await within(s).findByText(blocked.text)).toBeInTheDocument();
    expect(within(s).getByText('Opted out of email')).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /anyway/i })).toBeNull();
    const off = F.notice({ sent: false, text: "Jane can't sign in until the client portal is turned on, so nothing was sent to them.", channel: null });
    fake.on(INVITE, F.ok('POST /deals/:id/portal/invite', F.inviteBody(off)));
    await userEvent.click(await within(s).findByRole('button', { name: 'Invite Jane Doe' }));
    expect(await within(s).findByText(off.text)).toBeInTheDocument();
  });

  it("an invite refusal shows 45's sentence, never a code", async () => {
    const fake = new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state())).on(INVITE, F.apiErr('PORTAL_LOGIN_POINT_MISSING'));
    render(fake);
    const s = await section();
    await userEvent.click(await within(s).findByRole('button', { name: 'Invite Jane Doe' }));
    expect(await within(s).findByText(PORTAL_STAFF_MESSAGES.PORTAL_LOGIN_POINT_MISSING!)).toBeInTheDocument();
    expect(s.textContent).not.toMatch(/[A-Z]+_[A-Z_]+/);
  });

  it('Stop sharing opens a dialog; confirming revokes; a second revoke (409) says "Already stopped."', async () => {
    const fake = new FakeFetch()
      .on(STATE, F.ok('GET /deals/:id/portal', F.state({ accounts: [F.account()], grants: [F.grantStaff()] })))
      .on(`POST /portal-grants/${F.GRANT}/revoke`, F.apiErr('PORTAL_GRANT_REVOKED'));
    render(fake);
    const s = await section();
    await userEvent.click(await within(s).findByRole('button', { name: 'Stop sharing with Jane Doe' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Jane Doe stops seeing this at once. You can invite again.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop sharing with Jane Doe' }));
    expect(await within(s).findByText(STAFF_WORDS.revokeDone)).toBeInTheDocument();
    expect(fake.callsTo(`POST /portal-grants/${F.GRANT}/revoke`)).toHaveLength(1);
  });

  it("45's account and grant words, the sign-in-impossible line, and no preview link for a grant that is not live", async () => {
    const fake = new FakeFetch().on(
      STATE,
      F.ok('GET /deals/:id/portal', F.state({ accounts: [F.account({ signInImpossible: 'Sign-in is impossible: the sign-in email or phone was removed or marked wrong. Choose another one for this client.' })], grants: [F.grantStaff({ state: 'revoked', stateText: 'This access was revoked, so the client no longer sees it.', revokedAt: '2026-11-12T15:00:00.000Z', revokedBy: 'Ava Agent' })] })),
    );
    render(fake);
    const s = await section();
    expect(await within(s).findByText(/This access was revoked, so the client no longer sees it\./)).toBeInTheDocument();
    expect(within(s).getByText(/Sign-in is impossible/)).toBeInTheDocument();
    expect(within(s).queryByRole('link', { name: /sees/ })).toBeNull();
    expect(within(s).getByRole('button', { name: 'Invite Jane Doe' })).toBeInTheDocument();
  });

  it('a listing form reads the listing route (the follow-up mounts it)', async () => {
    const LISTING = '01900000-0000-7000-8000-00000000f001';
    const fake = new FakeFetch().on(`GET /listings/${LISTING}/portal`, F.ok('GET /listings/:id/portal', F.state()));
    app(fake, '/t/l', 'agent', surface, { pages: [{ path: '/t/l', title: 'Listing', roles: 'all', component: () => <ClientPortalSection listingId={LISTING} primaryContact={null} /> }] });
    await section();
    expect(fake.callsTo(`GET /listings/${LISTING}/portal`).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Invite/ })).toBeNull();
  });
});

describe('PreviewPage: What {name} sees (R-PORTALWEB-10, R-PORTAL-16)', () => {
  const PREVIEW = `GET /portal-grants/${F.GRANT}/preview`;

  it('R-PORTAL-16: the client\'s own components, in preview mode: the banner, the items and dates, inert controls', async () => {
    const fake = new FakeFetch().on(PREVIEW, F.ok('GET /portal-grants/:id/preview', F.preview()));
    render(fake, `/client-portal/${F.GRANT}`);
    expect(await screen.findByText('This is what the client sees now.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Your home purchase' })).toBeInTheDocument();
    expect(screen.getByText('Inspection')).toBeInTheDocument();
    expect(screen.getByText('Dec 18, 2026')).toBeInTheDocument();
    expect(screen.getByText('Download Purchase contract.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Text|Email/ })).toBeNull();
  });

  it("E698: not visible now: 45's reasons in the banner", async () => {
    const fake = new FakeFetch().on(PREVIEW, F.ok('GET /portal-grants/:id/preview', F.preview({ visibleNow: false, why: ['The client portal is not turned on for this team yet, so the client sees nothing.', 'The client has not signed in yet.'] })));
    render(fake, `/client-portal/${F.GRANT}`);
    expect(await screen.findByText("The client can't see this now: the client portal is not turned on for this team yet, so the client sees nothing.")).toBeInTheDocument();
    expect(screen.getByText("The client can't see this now: the client has not signed in yet.")).toBeInTheDocument();
  });

  it('E698: a 404 (an ISA, another agent) is not-found; a malformed id asks nothing', async () => {
    const fake = new FakeFetch().on(PREVIEW, F.apiErr('NOT_FOUND'));
    render(fake, `/client-portal/${F.GRANT}`, 'tc');
    expect(await screen.findByText(STAFF_WORDS.notFound)).toBeInTheDocument();
    const none = new FakeFetch();
    render(none, '/client-portal/not-a-uuid');
    expect((await screen.findAllByText(STAFF_WORDS.notFound)).length).toBeGreaterThan(0);
    expect(none.calls.filter((c) => c.path.includes('preview'))).toEqual([]);
  });

  it('an answer carrying a CMA value or notes renders none of it (the client parser)', async () => {
    const body = F.preview();
    const fake = new FakeFetch().on(PREVIEW, { status: 200, body: { ...body, grant: { ...body.grant, cmaValue: '$512,000', notes: 'internal' } } });
    render(fake, `/client-portal/${F.GRANT}`);
    await screen.findByText('Inspection');
    expect(document.body.textContent).not.toMatch(/512,000|internal/);
  });
});
