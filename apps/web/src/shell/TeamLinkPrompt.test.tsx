// E56: a deep link tagged with another of the user's teams (`?team=<slug>`, from a push notification)
// offers an honest switch; the active team or a team the user is not on shows nothing.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from './testing/fakeApi.js';
import type { SurfaceModule } from './types.js';

const Contact = () => <p>contact page body</p>;
const table = tableWith({ pages: [{ path: '/contacts/:id', title: 'Contact', roles: 'all', component: Contact }] } satisfies SurfaceModule);

const bay = { id: '01900000-0000-7000-8000-00000000000a', name: 'Bay Team', slug: 'bay', role: 'agent' as const };
const harbor = { id: '01900000-0000-7000-8000-00000000000b', name: 'Harbor Team', slug: 'harbor', role: 'team_lead' as const };
const inBay = sessionFixture({ tenant: bay, tenants: [bay, harbor] });
const inHarbor = sessionFixture({ tenant: harbor, tenants: [bay, harbor], csrfToken: 'csrf-2' });

describe('E56 deep links from another team', () => {
  it("E56 R-TEN-3: a link tagged with another of the user's teams names it and switches only when asked, staying on the same page", async () => {
    const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: inBay }).on('POST /auth/tenant-switch', { status: 200, body: { next: 'ready', session: inHarbor } });
    const { router } = renderApp({ fake, path: '/contacts/0190-c1?team=harbor', table });
    const prompt = (await screen.findByText('This notification is from Harbor Team.')).closest('[role="status"]');
    expect(prompt).not.toBeNull();
    expect(prompt!.textContent).toContain("You're signed in to Bay Team.");
    // nothing is switched until the person chooses
    expect(fake.callsTo('POST /auth/tenant-switch')).toHaveLength(0);
    const btn = screen.getByRole('button', { name: 'Switch to Harbor Team' });
    expect(btn.className).toMatch(/min-h-tap/); // 44 px tap target
    await userEvent.click(btn);
    await waitFor(() => expect(fake.callsTo('POST /auth/tenant-switch')).toHaveLength(1));
    expect(fake.callsTo('POST /auth/tenant-switch')[0]?.body).toEqual({ slug: 'harbor' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.location.pathname).toBe('/contacts/0190-c1');
    expect(screen.queryByText('This notification is from Harbor Team.')).not.toBeInTheDocument();
    expect(await screen.findByText('contact page body')).toBeInTheDocument();
    // the session in the app is now Harbor's (the sidebar names the active team)
    expect(screen.getAllByText('Harbor Team').length).toBeGreaterThan(0);
  });

  it('E56 R-TEN-3: a link tagged with the active team, or with a team the user is not on, shows nothing', async () => {
    for (const team of ['bay', 'BAY', 'stranger-team']) {
      const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: inBay });
      const { view } = renderApp({ fake, path: `/contacts/0190-c1?team=${team}`, table });
      expect(await screen.findByText('contact page body')).toBeInTheDocument();
      expect(screen.queryByText(/This notification is from/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Switch to/ })).not.toBeInTheDocument();
      expect(fake.callsTo('POST /auth/tenant-switch')).toHaveLength(0);
      view.unmount();
    }
  });

  it('E56: "Stay" keeps the current team and drops the tag; a failed switch says so in a sentence and keeps the session', async () => {
    const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: inBay }).on('POST /auth/tenant-switch', err(404, 'NOT_FOUND'));
    const { router } = renderApp({ fake, path: '/contacts/0190-c1?team=harbor&tab=notes', table });
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to Harbor Team' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NOT_FOUND/);
    expect(router.state.location.search).toBe('?team=harbor&tab=notes');
    await userEvent.click(screen.getByRole('button', { name: 'Stay in Bay Team' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=notes'));
    expect(screen.queryByText('This notification is from Harbor Team.')).not.toBeInTheDocument();
    expect(fake.callsTo('POST /auth/tenant-switch')).toHaveLength(1);
  });
});
