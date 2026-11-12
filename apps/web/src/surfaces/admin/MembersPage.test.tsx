// Members, invites and teams in jsdom against a scripted API. The permission rules themselves
// (R-PERM-2 Owner-role changes, the last-Owner guard, R-PERM-13 re-auth) are enforced and proven by
// api/admin and its DB triggers; these tests prove the page offers only what the viewer may do, sends
// the same request again after the password prompt, and words every refusal.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, err, leadAdminApp, member } from './lib/testing.js';
import { assignableRoles, canManage } from './MembersPage.js';

const owner = member({ userId: ID.owner, displayName: 'Olive Owner', email: 'olive@example.test', role: 'owner', mfaEnabled: true });
const ava = member();
const session = (role: string) => ({ user: { id: ID.me, email: 'me@example.test', displayName: 'Me' }, tenant: { id: '01900000-0000-7000-8000-000000000001', name: 'Harbor Home Team', slug: 'harbor', role }, tenants: [], mfa: { enabled: false, verified: false, enrollmentRequired: false }, reauthenticatedAt: new Date().toISOString(), csrfToken: 'csrf-2' });

function membersFake(members = [owner, ava], invites: unknown[] = []) {
  return new FakeFetch().on('GET /members', { status: 200, body: { members, invites } }).on('GET /teams', { status: 200, body: { teams: [{ id: 'team-1', name: 'Harbor', isDefault: true, members: [{ userId: ava.userId, isLead: false }] }] } });
}

describe('Members', () => {
  it('only an Owner may hand out the Owner role; an Admin never gets controls on an Owner', () => {
    expect(assignableRoles('owner')).toContain('owner');
    expect(assignableRoles('admin')).not.toContain('owner');
    expect(canManage('admin', owner)).toBe(false);
    expect(canManage('admin', ava)).toBe(true);
    expect(canManage('owner', owner)).toBe(true);
    expect(canManage('team_lead', ava)).toBe(false);
  });

  it('an Admin sees the Owner listed without controls, and cannot pick Owner when inviting', async () => {
    leadAdminApp(membersFake(), '/admin/members', 'admin');
    const ownerRow = (await screen.findByText('Olive Owner')).closest('section')!;
    expect(within(ownerRow).queryByLabelText('Role for Olive Owner')).toBeNull();
    expect(within(ownerRow).getByText('Two-step on')).toBeInTheDocument();
    const role = screen.getByLabelText('Role') as HTMLSelectElement;
    expect([...role.options].map((o) => o.value)).not.toContain('owner');
    expect(screen.getByLabelText('Role for Ava Agent')).toBeInTheDocument();
  });

  it('an invite that needs the password again asks for it once, then sends the same invite', async () => {
    let n = 0;
    const fake = membersFake()
      .on('POST /invites', () => (++n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 201, body: { invite: { id: 'inv-1', email: 'new@example.test', role: 'agent', invitedByUserId: ID.me, createdAt: '', expiresAt: '2026-11-17T00:00:00.000Z' }, emailSent: true } }))
      .on('POST /auth/reauth', { status: 200, body: { session: session('owner') } });
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Email'), 'new@example.test');
    await u.click(screen.getByRole('button', { name: 'Send invite' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'correct horse');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Invite sent to new@example.test')).toBeInTheDocument();
    const calls = fake.callsTo('POST /invites');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({ email: 'new@example.test', role: 'agent' });
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(fake.callsTo('POST /auth/reauth')[0]!.body).toEqual({ password: 'correct horse' });
  });

  it("says honestly when the invite exists but its email didn't go out", async () => {
    const fake = membersFake().on('POST /invites', { status: 201, body: { invite: { id: 'inv-1', email: 'new@example.test', role: 'agent', invitedByUserId: ID.me, createdAt: '', expiresAt: '' }, emailSent: false } });
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Email'), 'new@example.test');
    await u.click(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText("The invite was created, but the email didn't go out. Revoke it below and send it again.")).toBeInTheDocument();
  });

  it('a role change sends the row version; the last-Owner refusal is a sentence, never a code', async () => {
    const fake = membersFake().on(`PATCH /members/${ID.owner}`, err(409, 'LAST_OWNER'));
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByLabelText('Role for Olive Owner'), 'admin');
    await u.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByText('A team always needs one active Owner. Make someone else Owner first.')).toBeInTheDocument();
    expect(fake.callsTo(`PATCH /members/${ID.owner}`)[0]!.body).toEqual({ role: 'admin', version: 3 });
    expect(document.body.textContent).not.toContain('LAST_OWNER');
  });

  it('removing someone who holds leads previews what they hold, then moves the leads to the chosen place (staged deactivation)', async () => {
    const dz = { userId: ava.userId, status: 'preview', destination: 'team_lead', owned: 4, offered: 1, ownedWithOpenDeal: 1, openListings: 0, openDeals: 0, teamLead: { userId: ID.me, displayName: 'Sam Lead' }, fallbackUserId: ID.owner, deactivationId: null };
    const fake = membersFake().on(`POST /members/${ava.userId}/deactivate`, (c) => ({ status: 200, body: { deactivation: { ...dz, mode: (c.body as { mode: string }).mode, destination: (c.body as { destination: string }).destination } } }));
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    const row = (await screen.findByText('Ava Agent')).closest('section')!;
    await u.click(within(row).getByRole('button', { name: 'Remove' }));
    await u.click(within(row).getByRole('button', { name: 'Check their leads and listings' }));
    expect(await within(row).findByText('Ava Agent holds 4 leads (1 with an open deal) and 1 open offer.')).toBeInTheDocument();
    await u.selectOptions(within(row).getByLabelText('Move their leads to'), 'default_pond');
    await u.click(within(row).getByRole('button', { name: 'Remove Ava Agent' }));
    expect(await screen.findByText('Ava Agent is being removed; their leads are moving now')).toBeInTheDocument();
    const calls = fake.callsTo(`POST /members/${ava.userId}/deactivate`).map((c) => c.body);
    expect(calls).toEqual([
      { mode: 'preview', destination: 'team_lead' },
      { mode: 'run', destination: 'default_pond' },
    ]);
    expect(fake.callsTo(`PATCH /members/${ava.userId}`)).toHaveLength(0);
  });

  it('removing someone with no leads is a plain status change with the row version', async () => {
    const fake = membersFake()
      .on(`POST /members/${ava.userId}/deactivate`, { status: 200, body: { deactivation: { userId: ava.userId, mode: 'preview', status: 'preview', destination: 'team_lead', owned: 0, offered: 0, ownedWithOpenDeal: 0, openListings: 0, openDeals: 0, teamLead: null, fallbackUserId: ID.owner, deactivationId: null } } })
      .on(`PATCH /members/${ava.userId}`, { status: 200, body: { member: { ...ava, status: 'removed' } } });
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    const row = (await screen.findByText('Ava Agent')).closest('section')!;
    await u.click(within(row).getByRole('button', { name: 'Remove' }));
    await u.click(within(row).getByRole('button', { name: 'Check their leads and listings' }));
    await u.click(await within(row).findByRole('button', { name: 'Remove Ava Agent' }));
    await waitFor(() => expect(fake.callsTo(`PATCH /members/${ava.userId}`)).toHaveLength(1));
    expect(fake.callsTo(`PATCH /members/${ava.userId}`)[0]!.body).toEqual({ status: 'removed', version: 3 });
  });

  it('R-OWN-22 E540: the preview names the listings and their destination, the open deals that stay, and the open-deal leads going to the Team Lead', async () => {
    const dz = { userId: ava.userId, mode: 'preview', status: 'active', destination: 'team_lead', owned: 2, offered: 0, ownedWithOpenDeal: 1, openListings: 3, openDeals: 2, teamLead: { userId: ID.me, displayName: 'Sam Lead' }, fallbackUserId: ID.owner, deactivationId: null };
    const fake = membersFake().on(`POST /members/${ava.userId}/deactivate`, { status: 200, body: { deactivation: dz } });
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    const row = (await screen.findByText('Ava Agent')).closest('section')!;
    await u.click(within(row).getByRole('button', { name: 'Remove' }));
    await u.click(within(row).getByRole('button', { name: 'Check their leads and listings' }));
    expect(await within(row).findByText("They're the listing agent on 3 open listings; those go to Sam Lead.")).toBeInTheDocument();
    expect(within(row).getByText('This changes who handles the listing in Realty OS, not the listing agreement.')).toBeInTheDocument();
    expect(within(row).getByText("Their 2 open deals keep Ava Agent as the deal owner (a deal's owner can't be changed in Realty OS yet). Owners and Admins can still open them.")).toBeInTheDocument();
    expect(within(row).getByText('Leads with an open deal never go to a pond; they go to Sam Lead.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('the Owner');
  });

  it('R-OWN-22 E541: with no Team Lead the listings and open-deal leads go to "you" (the viewer runs it)', async () => {
    const dz = { userId: ava.userId, mode: 'preview', status: 'active', destination: 'team_lead', owned: 1, offered: 0, ownedWithOpenDeal: 1, openListings: 1, openDeals: 1, teamLead: null, fallbackUserId: ID.owner, deactivationId: null };
    const fake = membersFake().on(`POST /members/${ava.userId}/deactivate`, { status: 200, body: { deactivation: dz } });
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    const row = (await screen.findByText('Ava Agent')).closest('section')!;
    await u.click(within(row).getByRole('button', { name: 'Remove' }));
    await u.click(within(row).getByRole('button', { name: 'Check their leads and listings' }));
    expect(await within(row).findByText("They're the listing agent on 1 open listing; those go to you.")).toBeInTheDocument();
    expect(within(row).getByText('Leads with an open deal never go to a pond; they go to you.')).toBeInTheDocument();
    expect(within(row).getByText("Their 1 open deal keeps Ava Agent as the deal owner (a deal's owner can't be changed in Realty OS yet). Owners and Admins can still open them.")).toBeInTheDocument();
  });

  it('R-OWN-22 E542: someone with only listings is removed through the staged run (never a plain PATCH), and the done text names the listings', async () => {
    const dz = { userId: ava.userId, status: 'active', destination: 'team_lead', owned: 0, offered: 0, ownedWithOpenDeal: 0, openListings: 2, openDeals: 0, teamLead: null, fallbackUserId: ID.owner, deactivationId: null };
    const fake = membersFake().on(`POST /members/${ava.userId}/deactivate`, (c) => ({ status: 200, body: { deactivation: { ...dz, mode: (c.body as { mode: string }).mode } } }));
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    const row = (await screen.findByText('Ava Agent')).closest('section')!;
    await u.click(within(row).getByRole('button', { name: 'Remove' }));
    await u.click(within(row).getByRole('button', { name: 'Check their leads and listings' }));
    expect(await within(row).findByText('Ava Agent holds no leads or offers.')).toBeInTheDocument();
    await u.click(within(row).getByRole('button', { name: 'Remove Ava Agent' }));
    expect(await screen.findByText('Ava Agent is being removed; their leads and listings are moving now')).toBeInTheDocument();
    expect(fake.callsTo(`POST /members/${ava.userId}/deactivate`).map((c) => (c.body as { mode: string }).mode)).toEqual(['preview', 'run']);
    expect(fake.callsTo(`PATCH /members/${ava.userId}`)).toHaveLength(0);
  });

  it('R-OWN-22 E542 R-PERM-15 E543: the leads and listings refusals say why and what to do, never a code', async () => {
    for (const [code, text] of [
      ['MEMBER_HAS_LEADS', 'They still hold leads or offers. To remove them, use Remove: it moves them first. To make them a TC, reassign their leads first.'],
      ['MEMBER_HAS_LISTINGS', "They're still the listing agent on open listings. To remove them, use Remove: it moves the listings first. To make them a TC, first open each of those listings and change its listing agent."],
    ] as const) {
      const fake = membersFake().on(`PATCH /members/${ava.userId}`, err(409, code));
      leadAdminApp(fake, '/admin/members', 'owner');
      const u = userEvent.setup();
      await u.selectOptions(await screen.findByLabelText('Role for Ava Agent'), 'tc');
      await u.click(within((screen.getByText('Ava Agent')).closest('section')!).getByRole('button', { name: 'Save role' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(code);
      cleanup();
    }
  });

  it('team members: only a leading role can be marked lead; saving sends the whole member list', async () => {
    const tl = member({ userId: ID.me, displayName: 'Sam Lead', role: 'team_lead' });
    const fake = membersFake([owner, ava, tl]).on('PUT /teams/team-1/members', { status: 200, body: { team: { id: 'team-1', name: 'Harbor', isDefault: true, members: [] } } });
    leadAdminApp(fake, '/admin/members', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Edit members' }));
    await u.click(screen.getByLabelText('Sam Lead · Team Lead'));
    const leadBoxes = screen.getAllByLabelText('Leads this team');
    expect(leadBoxes).toHaveLength(1);
    await u.click(leadBoxes[0]!);
    await u.click(screen.getByRole('button', { name: 'Save members' }));
    await waitFor(() => expect(fake.callsTo('PUT /teams/team-1/members')).toHaveLength(1));
    expect(fake.callsTo('PUT /teams/team-1/members')[0]!.body).toEqual({
      members: [
        { userId: ava.userId, isLead: false },
        { userId: ID.me, isLead: true },
      ],
    });
  });
});
