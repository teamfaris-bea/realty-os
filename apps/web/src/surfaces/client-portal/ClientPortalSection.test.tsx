// module 46 (R-PORTALWEB-10; E693, E718): the deal's client portal section and "What {name} sees", in jsdom, on
// fixtures checked against module 45's contract.
import type { Role } from '@realty/core/foundation';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { contractSentence, copyEntry } from '../../portal/test/portalContract.js';
import type { SurfaceModule } from '../../shell/index.js';
import { FakeFetch } from '../../shell/testing/fakeApi.js';
import { ME, OTHER, app } from '../documents/fixtures.js';
import { ClientPortalSection } from './ClientPortalSection.js';
import * as F from './testing/fixtures.js';
import { surface } from './index.js';
import { PORTAL_STAFF_MESSAGES, STAFF_WORDS, mayManagePortal } from './words.js';

const JANE = { id: F.JANE, name: 'Jane Doe' };
// the deal as DealsPages passes it: its owner and its members (DocumentsSection's facts). ME is the signed-in user.
const dealHost = (ownerUserId: string | null, memberUserIds: readonly string[] = [], dealLost = false): SurfaceModule => ({
  pages: [{ path: '/t/deal', title: 'Deal', roles: 'all', component: () => <ClientPortalSection dealId={F.DEAL} primaryContact={JANE} ownerUserId={ownerUserId} memberUserIds={memberUserIds} dealLost={dealLost} /> }],
});
const host = dealHost(ME);
const render = (fake: FakeFetch, path = '/t/deal', role: Role = 'agent', h: SurfaceModule = host) => app(fake, path, role, surface, h);
const section = async () => (await screen.findByRole('heading', { name: STAFF_WORDS.heading })).closest('section') as HTMLElement;
const STATE = `GET /deals/${F.DEAL}/portal`;
const INVITE = `POST /deals/${F.DEAL}/portal/invite`;

describe('ClientPortalSection (R-PORTALWEB-10)', () => {
  it("staff words: 45's sentences verbatim", () => {
    for (const [code, s] of Object.entries(PORTAL_STAFF_MESSAGES)) expect(s, code).toBe(contractSentence(code));
  });

  it('E718: a 404 (an ISA, support, another agent) hides the section', async () => {
    const fake = new FakeFetch().on(STATE, F.apiErr('NOT_FOUND'));
    render(fake, '/t/deal', 'isa');
    await waitFor(() => expect(fake.callsTo(STATE).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('heading', { name: STAFF_WORDS.heading })).toBeNull());
  });

  it('E693: uncleared: 45\'s sentence and that invitations are not sent; the "can\'t be shared from the app yet" line is always there', async () => {
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

  it('a blocked notice shows its decision, with no send-anyway; the uncleared notice says nothing was sent (E693)', async () => {
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

  // b15 review L1: 45 refuses an invite on a lost deal (PORTAL_DEAL_LOST: portal.sync ends its grant at once), so the
  // section offers no Invite or Resend there and says why in 45's words; Stop sharing stays (the grant may still be live
  // until the next sync)
  it('E690 (b15 review L1): a lost deal: no Invite (nobody invited) and no Resend (a live grant before the sync), 45\'s sentence instead; Stop sharing kept', async () => {
    const lostHost = dealHost(ME, [], true);
    const none = new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state()));
    render(none, '/t/deal', 'agent', lostHost);
    let s = await section();
    expect(await within(s).findByText(PORTAL_STAFF_MESSAGES.PORTAL_DEAL_LOST!)).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /^(Invite|Send the invite again)/ })).toBeNull();
    cleanup();
    const live = new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state({ accounts: [F.account()], grants: [F.grantStaff()] })));
    render(live, '/t/deal', 'agent', lostHost);
    s = await section();
    expect(await within(s).findByText(PORTAL_STAFF_MESSAGES.PORTAL_DEAL_LOST!)).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: /^(Invite|Send the invite again)/ })).toBeNull();
    expect(within(s).getByRole('button', { name: 'Stop sharing with Jane Doe' })).toBeInTheDocument();
    expect(live.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it("E690 (b15 review L1): an invite 45 refuses because the deal was lost meanwhile (a stale page) shows 45's sentence", async () => {
    const fake = new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state())).on(INVITE, F.apiErr('PORTAL_DEAL_LOST'));
    render(fake);
    const s = await section();
    await userEvent.click(await within(s).findByRole('button', { name: 'Invite Jane Doe' }));
    expect(await within(s).findByText(PORTAL_STAFF_MESSAGES.PORTAL_DEAL_LOST!)).toBeInTheDocument();
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

  // b15 audit F1: portal.manage (core authz) is Owner, Admin, a Team Lead (T) and the agent who owns the deal; portal.view
  // adds a TC on the deal and a member agent. 45 refuses manage to those two (404), so they get no Invite, Resend or Stop
  // sharing, and the section says who can, read-only.
  describe('E718 (b15 audit F1): Invite, Resend and Stop sharing only for a viewer with portal.manage', () => {
    const live = () => new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state({ accounts: [F.account()], grants: [F.grantStaff()] })));
    const none = () => new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state()));
    const controls = (s: HTMLElement) => within(s).queryAllByRole('button', { name: /^(Invite|Send the invite again|Stop sharing)/ });

    it('a TC on the deal (a member) sees the grant and "What Jane Doe sees", read-only: no Invite, Resend or Stop sharing', async () => {
      const fake = live();
      render(fake, '/t/deal', 'tc', dealHost(OTHER, [ME]));
      const s = await section();
      expect(await within(s).findByRole('link', { name: 'What Jane Doe sees' })).toBeInTheDocument();
      expect(controls(s)).toEqual([]);
      expect(within(s).getByText(STAFF_WORDS.readOnly('deal'))).toBeInTheDocument();
      expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    it('a member agent who does not own the deal: no Invite (nobody invited yet), read-only words', async () => {
      const fake = none();
      render(fake, '/t/deal', 'agent', dealHost(OTHER, [ME]));
      const s = await section();
      expect(await within(s).findByText(STAFF_WORDS.noOne)).toBeInTheDocument();
      expect(controls(s)).toEqual([]);
      expect(within(s).getByText(STAFF_WORDS.readOnly('deal'))).toBeInTheDocument();
    });

    it('a member agent who does not own the deal: no Resend or Stop sharing on a live grant', async () => {
      const fake = live();
      render(fake, '/t/deal', 'agent', dealHost(OTHER, [ME]));
      const s = await section();
      expect(await within(s).findByRole('link', { name: 'What Jane Doe sees' })).toBeInTheDocument();
      expect(controls(s)).toEqual([]);
    });

    it('the agent who owns the deal gets Resend and Stop sharing, and no read-only line', async () => {
      const fake = live();
      render(fake, '/t/deal', 'agent', dealHost(ME));
      const s = await section();
      expect(await within(s).findByRole('button', { name: STAFF_WORDS.resend })).toBeInTheDocument();
      expect(within(s).getByRole('button', { name: 'Stop sharing with Jane Doe' })).toBeInTheDocument();
      expect(within(s).queryByText(STAFF_WORDS.readOnly('deal'))).toBeNull();
    });

    it('an Owner, an Admin and a Team Lead who can open the section get Invite, without owning the deal', async () => {
      for (const role of ['owner', 'admin', 'team_lead'] as const) {
        const fake = none();
        const v = render(fake, '/t/deal', role, dealHost(OTHER));
        const s = await section();
        expect(await within(s).findByRole('button', { name: 'Invite Jane Doe' }), role).toBeInTheDocument();
        v.view.unmount();
      }
    });

    it('mayManagePortal mirrors portal.manage', () => {
      const f = (own: boolean, member: boolean) => ({ own, member });
      expect((['owner', 'admin', 'team_lead'] as const).map((r) => mayManagePortal(r, f(false, false)))).toEqual([true, true, true]);
      expect([mayManagePortal('agent', f(true, false)), mayManagePortal('agent', f(false, true)), mayManagePortal('agent', f(false, false))]).toEqual([true, false, false]);
      expect([mayManagePortal('tc', f(false, true)), mayManagePortal('tc', f(true, true)), mayManagePortal('isa', f(true, true)), mayManagePortal(null, f(true, true))]).toEqual([false, false, false, false]);
    });
  });

  it("b15 (b14 low f): a soft-deleted client: 45's words that the record is deleted, no preview link, and no Invite (45 refuses it until the record is restored)", async () => {
    const deleted = "This person's record is deleted, so the client sees nothing until it is restored.";
    expect(deleted).toBe(copyEntry('NOT_VISIBLE', 'CONTACT_DELETED'));
    const fake = new FakeFetch().on(STATE, F.ok('GET /deals/:id/portal', F.state({ accounts: [F.account({ status: 'active', statusText: 'Signed in on 2026-11-11.' })], grants: [F.grantStaff({ state: 'contact_deleted', stateText: deleted })] })));
    render(fake, '/t/deal', 'owner');
    const s = await section();
    expect(await within(s).findByText(/This person's record is deleted, so the client sees nothing until it is restored\./)).toBeInTheDocument();
    expect(within(s).queryByRole('link', { name: /sees/ })).toBeNull();
    expect(within(s).queryAllByRole('button', { name: /^(Invite|Send the invite again|Stop sharing)/ })).toEqual([]);
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

  it("E718: not visible now: 45's reasons in the banner", async () => {
    const fake = new FakeFetch().on(PREVIEW, F.ok('GET /portal-grants/:id/preview', F.preview({ visibleNow: false, why: ['The client portal is not turned on for this team yet, so the client sees nothing.', 'The client has not signed in yet.'] })));
    render(fake, `/client-portal/${F.GRANT}`);
    expect(await screen.findByText("The client can't see this now: the client portal is not turned on for this team yet, so the client sees nothing.")).toBeInTheDocument();
    expect(screen.getByText("The client can't see this now: the client has not signed in yet.")).toBeInTheDocument();
  });

  it('E718: a 404 (an ISA, another agent) is not-found; a malformed id asks nothing', async () => {
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
