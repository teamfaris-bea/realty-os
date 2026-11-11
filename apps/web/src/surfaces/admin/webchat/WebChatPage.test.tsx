// The Website chat page (module 41) in jsdom on a scripted API: create a widget for a lead source (re-auth), the
// key and the embed code shown ONCE (and never again: not after "Done", not after a reload, not in the query cache
// or storage), rotate (new key once; the old one stops), allowed websites checked before any request, disconnect
// through the integrations route, a lead source without a disclosure said honestly, Owner/Admin only, no axe
// violations.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFetch, ID, NOT_ADMINS, err, mount, reauthOk, violations } from '../integrations/testing.js';
import { WEBCHAT_PATH, embedSnippet, parseWebsites } from './words.js';

const KEY = 'wk_0123456789abcdef0123456789abcdef01234567';
const KEY2 = 'wk_fedcba9876543210fedcba9876543210fedcba98';
const DISCLOSURE = 'By starting a chat you agree that Harbor Home Team may text or email you about your inquiry.';

const widget = (over: Record<string, unknown> = {}) => ({
  id: ID.widget,
  displayName: 'Website chat',
  status: 'connected',
  leadSourceId: ID.source,
  allowedOrigins: ['https://www.harbor.example'],
  connectedAt: '2026-11-10T10:00:00.000Z',
  sentence: 'Live on https://www.harbor.example. New chats become leads.',
  ...over,
});
const sources = { status: 200, body: { sources: [{ id: ID.source, name: 'Website', kind: 'website', active: true, hasToken: true, createdAt: '2026-11-01T00:00:00.000Z' }, { id: ID.source2, name: 'Old site', kind: 'website', active: false, hasToken: true, createdAt: '2026-10-01T00:00:00.000Z' }] } };
const embed = (disclosure: boolean) => ({ status: 200, body: { brokerage: 'Harbor Realty LLC', disclosure: disclosure ? { id: ID.disclosure, text: DISCLOSURE } : null } });

function api(o: { widgets?: unknown[]; disclosure?: boolean } = {}) {
  let list = o.widgets ?? [];
  const fake = new FakeFetch()
    .on('GET /admin/web-chat/widgets', () => ({ status: 200, body: { widgets: list } }))
    .on('GET /lead-sources', sources)
    .on(`GET /admin/web-chat/widgets/${ID.widget}/embed`, embed(o.disclosure ?? true))
    .on('POST /auth/reauth', reauthOk)
    .on('POST /admin/web-chat/widgets', (_c, n) => {
      if (n === 1) return err(401, 'REAUTH_REQUIRED');
      list = [widget()];
      return { status: 200, body: { widget: widget(), widgetKey: KEY } };
    })
    .on(`POST /admin/web-chat/widgets/${ID.widget}/rotate`, { status: 200, body: { widget: widget(), widgetKey: KEY2 } })
    .on(`PUT /admin/web-chat/widgets/${ID.widget}/origins`, (c) => {
      list = [widget({ allowedOrigins: (c.body as { allowedOrigins: string[] }).allowedOrigins })];
      return { status: 200, body: { widget: list[0] } };
    })
    .on(`POST /admin/integrations/connections/${ID.widget}/disconnect`, () => {
      list = [widget({ status: 'disconnected', sentence: 'Not connected: the chat window says it is unavailable and nothing is sent through it.' })];
      return { status: 200, body: { connection: {} } };
    });
  return fake;
}

async function confirmPassword() {
  const prompt = await screen.findByRole('dialog', { name: "Confirm it's you" });
  await userEvent.type(within(prompt).getByLabelText('Password'), 'correct horse battery');
  await userEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('Website chat page', () => {
  it('creates a widget (re-auth), and shows the key and embed code once, with the brokerage and disclosure', async () => {
    const fake = api();
    const { qc } = mount(fake, WEBCHAT_PATH);
    expect(await screen.findByRole('heading', { level: 1, name: 'Website chat' })).toBeInTheDocument();
    expect(await screen.findByText('No chat widgets yet.')).toBeInTheDocument();
    // only active lead sources are offered
    const select = screen.getByLabelText('Lead source');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Website']);
    await userEvent.type(screen.getByLabelText('Allowed websites'), 'https://www.harbor.example/');
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    await confirmPassword();
    const panel = (await screen.findByRole('heading', { level: 2, name: 'Website chat is added' })).closest('section')!;
    expect(within(panel).getByText('Shown only this once')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Widget key')).toHaveValue(KEY);
    const code = (await within(panel).findByLabelText('Embed code')) as HTMLTextAreaElement;
    expect(code.value).toContain(`data-widget-key="${KEY}"`);
    expect(code.value).toContain('data-brokerage="Harbor Realty LLC"');
    expect(code.value).toContain(`data-disclosure-id="${ID.disclosure}"`);
    expect(code.value).toContain(`data-disclosure="${DISCLOSURE}"`);
    expect(code.value).toContain('/widget/chat.js');
    const posts = fake.callsTo('POST /admin/web-chat/widgets');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ displayName: 'Website chat', leadSourceId: ID.source, allowedOrigins: ['https://www.harbor.example'] });
    // the key is in no cache and no storage
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(KEY);
    expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => m.state.data))).not.toContain(KEY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(KEY);
    expect(await violations()).toEqual([]);
  });

  it('the key is never shown again: not after "Done", and not on the widget list', async () => {
    mount(api(), WEBCHAT_PATH);
    await screen.findByText('No chat widgets yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    await confirmPassword();
    await screen.findByLabelText('Widget key');
    expect(document.body.innerHTML).toContain(KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Done, hide the key' }));
    await waitFor(() => expect(screen.queryByLabelText('Widget key')).toBeNull());
    expect(document.body.innerHTML).not.toContain(KEY);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    expect(within(card).getByText(/Shown once, when the widget was added or its key last changed\. To get it again, make a new key\./)).toBeInTheDocument();
  });

  it('a live widget whose lead source has no consent disclosure is shown as not working, not "Live"', async () => {
    mount(api({ widgets: [widget()], disclosure: false }), WEBCHAT_PATH);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    expect(await within(card).findByText('Not working')).toBeInTheDocument();
    expect(within(card).getByText(/The chat window never opens: this widget's lead source has no consent disclosure/)).toBeInTheDocument();
    expect(within(card).queryByText('Live')).toBeNull();
    expect(within(card).queryByText(/New chats become leads/)).toBeNull();
  });

  it('while the lead sources load or fail, a widget does not claim its source is unknown', async () => {
    mount(api({ widgets: [widget()] }).on('GET /lead-sources', err(500, 'INTERNAL_ERROR')), WEBCHAT_PATH);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    expect(await within(card).findByText("Couldn't load the lead sources")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Unknown lead source');
  });

  it('the one-time panel takes focus when it appears, so it is not missed', async () => {
    mount(api(), WEBCHAT_PATH);
    await screen.findByText('No chat widgets yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    await confirmPassword();
    const h = await screen.findByRole('heading', { level: 2, name: 'Website chat is added' });
    await waitFor(() => expect(document.activeElement).toBe(h));
  });

  it('a reload of the page never brings the key back', async () => {
    mount(api({ widgets: [widget()] }), WEBCHAT_PATH);
    await screen.findByRole('heading', { level: 3, name: 'Website chat' });
    expect(screen.queryByLabelText('Widget key')).toBeNull();
    expect(screen.queryByLabelText('Embed code')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/wk_[0-9a-f]{40}/);
  });

  it('rotating asks first, then shows the new key once and says the old embed stopped', async () => {
    const fake = api({ widgets: [widget()] });
    mount(fake, WEBCHAT_PATH);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    await userEvent.click(within(card).getByRole('button', { name: 'Make a new key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Get a new key for Website chat?' });
    expect(dialog).toHaveTextContent(/stops working on every website that has the old embed code/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make a new key' }));
    const panel = (await screen.findByRole('heading', { level: 2, name: 'New key for Website chat' })).closest('section')!;
    expect(within(panel).getByLabelText('Widget key')).toHaveValue(KEY2);
    expect(within(panel).getByText(/The old embed code has stopped working\./)).toBeInTheDocument();
    expect(fake.callsTo(`POST /admin/web-chat/widgets/${ID.widget}/rotate`)).toHaveLength(1);
  });

  it('a lead source with no consent disclosure: the key is shown, no broken embed code, and the page says the chat window will not appear', async () => {
    mount(api({ disclosure: false }), WEBCHAT_PATH);
    await screen.findByText('No chat widgets yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Add widget' }));
    await confirmPassword();
    expect(await screen.findByText("The chat window won't appear yet")).toBeInTheDocument();
    expect(screen.queryByLabelText('Embed code')).toBeNull();
    expect(screen.getByLabelText('Widget key')).toHaveValue(KEY);
  });

  it('allowed websites: a page path is refused before any request; a valid list is saved', async () => {
    const fake = api({ widgets: [widget()] });
    mount(fake, WEBCHAT_PATH);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    await userEvent.click(within(card).getByRole('button', { name: 'Change websites' }));
    const box = within(card).getByLabelText('Allowed websites');
    await userEvent.clear(box);
    await userEvent.type(box, 'https://www.harbor.example/contact');
    await userEvent.click(within(card).getByRole('button', { name: 'Save websites' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(/without a page path/);
    expect(fake.callsTo(`PUT /admin/web-chat/widgets/${ID.widget}/origins`)).toHaveLength(0);
    await userEvent.clear(box);
    await userEvent.type(box, 'https://www.harbor.example{enter}https://Listings.Harbor.example');
    await userEvent.click(within(card).getByRole('button', { name: 'Save websites' }));
    expect(await screen.findByText('Websites saved for Website chat.')).toBeInTheDocument();
    expect(fake.callsTo(`PUT /admin/web-chat/widgets/${ID.widget}/origins`)[0]!.body).toEqual({ allowedOrigins: ['https://www.harbor.example', 'https://listings.harbor.example'] });
    expect(await within(card).findByText('https://www.harbor.example, https://listings.harbor.example')).toBeInTheDocument();
  });

  it('disconnect goes through the integrations route and the widget then says it is not connected, with no actions', async () => {
    const fake = api({ widgets: [widget()] });
    mount(fake, WEBCHAT_PATH);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    await userEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Disconnect Website chat?' })).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/Website chat is disconnected\. The chat window on your website now says chat is unavailable\./)).toBeInTheDocument();
    expect(fake.callsTo(`POST /admin/integrations/connections/${ID.widget}/disconnect`)).toHaveLength(1);
    const after = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    await waitFor(() => expect(within(after).getByText('Disconnected')).toBeInTheDocument());
    expect(within(after).queryByRole('button')).toBeNull();
  });

  it('with no active lead source it says a widget needs one, and does not send the person to a page that cannot add one', async () => {
    mount(api().on('GET /lead-sources', { status: 200, body: { sources: [] } }), WEBCHAT_PATH);
    expect(await screen.findByText(/A widget needs an active lead source, and there is none yet\. Lead sources can't be added in the app yet/)).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByRole('link', { name: /Lead routing/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull();
  });

  it('a refused change is said in words', async () => {
    mount(api({ widgets: [widget()] }).on(`POST /admin/web-chat/widgets/${ID.widget}/rotate`, err(409, 'CHANNEL_NOT_CONNECTED')), WEBCHAT_PATH);
    const card = (await screen.findByRole('heading', { level: 3, name: 'Website chat' })).closest('li')!;
    await userEvent.click(within(card).getByRole('button', { name: 'Make a new key' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Make a new key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This widget is disconnected, so its key and websites can't be changed.");
  });

  for (const role of ['owner', 'admin'] as const) {
    it(`the ${role} finds it in the Admin sidebar`, async () => {
      mount(api(), WEBCHAT_PATH, role);
      expect(within(await screen.findByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Website chat' })).toHaveAttribute('href', WEBCHAT_PATH);
    });
  }

  for (const role of NOT_ADMINS) {
    it(`a ${role} has no nav entry and gets "not available", and no request is made`, async () => {
      const fake = api();
      mount(fake, WEBCHAT_PATH, role);
      expect(await screen.findByText("This page isn't available")).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Website chat' })).toBeNull();
      expect(fake.callsTo('GET /admin/web-chat/widgets')).toHaveLength(0);
    });
  }
});

describe('website chat words', () => {
  it('parseWebsites keeps only addresses, lowercases and de-duplicates them, and refuses paths, queries and other schemes', () => {
    expect(parseWebsites('')).toEqual({ ok: true, origins: [] });
    expect(parseWebsites('https://A.example/\nhttps://a.example\nhttp://b.example:8080')).toEqual({ ok: true, origins: ['https://a.example', 'http://b.example:8080'] });
    for (const bad of ['javascript:alert(1)', 'https://a.example/x', 'https://a.example/?q=1', 'ftp://a.example', 'a.example', 'https://u:p@a.example']) expect(parseWebsites(bad).ok).toBe(false);
    expect(parseWebsites(Array.from({ length: 11 }, (_, i) => `https://s${i}.example`).join('\n'))).toEqual({ ok: false, message: 'List at most 10 websites.' });
  });

  it('embedSnippet escapes every attribute value', () => {
    const s = embedSnippet('https://app.example', 'wk_x', { brokerage: 'A "B" <C> & D', disclosure: { id: 'd', text: '"><script>alert(1)</script>' } });
    expect(s).not.toContain('<script>alert');
    expect(s).toContain('data-brokerage="A &quot;B&quot; &lt;C&gt; &amp; D"');
    expect(s.match(/<script /g)).toHaveLength(1);
  });
});
