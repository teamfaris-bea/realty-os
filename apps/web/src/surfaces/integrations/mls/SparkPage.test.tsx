// The MLS page's Spark sections (the Spark prep's Connect MLS page) in jsdom on a scripted API: the deployment and connection in words
// (including "Live MLS calls are turned off on this deployment"), every validate result in words,
// save / replace / disconnect, re-auth, honest error sentences, Owner/Admin only, no axe violations,
// and above all: the access token goes out in exactly one request body and is kept nowhere else
// (DOM, storage, query or mutation cache, URL, console), even if a response were to echo it.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, App, buildRoutes, createQueryClient } from '../../../shell/index.js';
import { FakeFetch, err, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { surface as adminSurface } from '../../admin/index.js';
import { surface, SPARK_PAGE_PATH } from '../index.js';
import { INTEGRATION_ERROR_MESSAGES } from './messages.js';
import type { SparkConnection, SparkOverview, ValidateResult } from './types.js';
import { VALIDATE_RESULTS } from './types.js';
import { LIVE_CALLS_OFF, TOKEN_HINT, resultWords } from './words.js';

const CANARY = 'CANARY-spark-token-DO-NOT-USE-0000';
const CONN_ID = '01900000-0000-7000-8000-00000000c0a1';
const BASE = '/admin/integrations/mls/spark';

type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';

const connection = (over: Partial<SparkConnection> = {}): SparkConnection => ({
  id: CONN_ID,
  status: 'connected',
  statusSentence: 'Connected to Spark. Listings update from the MLS.',
  keyLabel: 'CRM key',
  credentialSaved: true,
  lastResult: 'CONNECTED',
  connectedAt: '2026-11-10T15:00:00.000Z',
  ...over,
});

const overview = (over: Partial<SparkOverview> = {}): SparkOverview => ({
  provider: 'spark',
  liveCalls: false,
  sentence: 'Live MLS calls are turned off on this deployment. Saved keys are kept, but nothing is sent to Spark.',
  authSchemeDefault: 'Bearer',
  connection: null,
  ...over,
});

function mount(fake: FakeFetch, role: Role = 'owner', path = SPARK_PAGE_PATH) {
  const s = sessionFixture({ reauthenticatedAt: new Date().toISOString() });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  // module 41 put the MLS sync and licence-pack sections above the Spark sections (MlsStatus.test.tsx covers them)
  fake.on('GET /admin/mls', { status: 200, body: { connections: [] } });
  const table = tableWith(adminSurface, surface);
  const api = new ApiClient({ fetch: fake.fetch });
  const router = createMemoryRouter(buildRoutes(table), { initialEntries: [path] });
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false, staleTime: Infinity } });
  render(
    <StrictMode>
      <App api={api} table={table} router={router} queryClient={qc} />
    </StrictMode>,
  );
  return { router, qc };
}

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const tokenInput = () => screen.getByLabelText('Access token') as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('Connect MLS (Spark) page', () => {
  it('says what the deployment does, the connection, key label and last check, in words', async () => {
    mount(new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview({ connection: connection({ lastResult: 'INVALID_CREDENTIALS' }) }) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'MLS' })).toBeInTheDocument();
    const dep = await screen.findByRole('region', { name: 'This deployment' });
    expect(within(dep).getByText('Spark API')).toBeInTheDocument();
    expect(dep.textContent).toContain(LIVE_CALLS_OFF);
    const conn = screen.getByRole('region', { name: 'Connection' });
    expect(within(conn).getByText('Connected to Spark. Listings update from the MLS.')).toBeInTheDocument();
    expect(within(conn).getByText('CRM key')).toBeInTheDocument();
    expect(within(conn).getByText(resultWords('invalid_credentials').text)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('INVALID_CREDENTIALS');
    expect(screen.getByRole('heading', { level: 2, name: 'Replace the Spark key' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('says live calls are off even if the server sentence ever left it out; says nothing of it when they are on', async () => {
    mount(new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview({ sentence: 'Nothing is sent to Spark.' }) }));
    expect(await screen.findByText(`${LIVE_CALLS_OFF}. Nothing is sent to Spark.`)).toBeVisible();
  });

  it('with live calls on, the sentence is the server one', async () => {
    mount(new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview({ liveCalls: true, sentence: 'Live MLS calls are on. Listings are read from Spark.' }) }));
    expect(await screen.findByText('Live MLS calls are on. Listings are read from Spark.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(LIVE_CALLS_OFF);
  });

  it('the key form: password input, no autocomplete or spellcheck, no name, Bearer by default, the hint and VERIFY note', async () => {
    mount(new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview() }));
    await screen.findByRole('heading', { level: 2, name: 'Save a Spark key' });
    const t = tokenInput();
    expect(t).toHaveAttribute('type', 'password');
    expect(t).toHaveAttribute('autocomplete', 'off');
    expect(t).toHaveAttribute('spellcheck', 'false');
    expect(t).not.toHaveAttribute('name');
    expect(t).toHaveAccessibleDescription(TOKEN_HINT);
    const scheme = screen.getByLabelText('Auth scheme') as HTMLSelectElement;
    expect(scheme.value).toBe('Bearer');
    expect(within(scheme).getAllByRole('option').map((o) => o.textContent)).toEqual(['Bearer (default)', 'OAuth']);
    expect(scheme).toHaveAccessibleDescription(/VERIFY with Spark/);
    expect(await violations()).toEqual([]);
  });

  it('the canary token goes out once in the PUT body and is kept nowhere else, even if the response echoes it', async () => {
    const logged: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const orig = console[m];
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '));
        void orig;
      });
    }
    const fake: FakeFetch = new FakeFetch()
      .on(`GET ${BASE}`, () => ({ status: 200, body: overview({ connection: fake.callsTo(`PUT ${BASE}/credential`).length > 0 ? connection({ status: 'not_configured', statusSentence: 'A key is saved. Validate it to connect.', lastResult: null, connectedAt: null, keyLabel: 'CRM key' }) : null }) }))
      // a hostile/buggy echo: the page must never keep any of it
      .on(`PUT ${BASE}/credential`, { status: 200, body: { accessToken: CANARY, token: CANARY, connection: { ...connection({ status: 'not_configured', lastResult: null, connectedAt: null }), accessToken: CANARY, token: CANARY } } });
    const { router, qc } = mount(fake);
    await screen.findByRole('heading', { level: 2, name: 'Save a Spark key' });

    await userEvent.type(tokenInput(), CANARY);
    await userEvent.type(screen.getByLabelText('Key label'), 'CRM key');
    await userEvent.selectOptions(screen.getByLabelText('Auth scheme'), 'OAuth');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));
    expect(await screen.findByText(/Key saved\./)).toBeInTheDocument();

    const puts = fake.callsTo(`PUT ${BASE}/credential`);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ accessToken: CANARY, keyLabel: 'CRM key', authScheme: 'OAuth' });
    expect(puts[0]!.headers['x-csrf-token']).toBe('csrf-1');
    const everyBody = JSON.stringify(fake.calls.map((c) => c.body));
    expect(everyBody.split(CANARY).length - 1).toBe(1);
    expect(fake.calls.some((c) => c.path.includes(CANARY))).toBe(false);

    await waitFor(() => expect(tokenInput().value).toBe(''));
    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(document.documentElement.outerHTML).not.toContain(CANARY);
    const storage = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join('\n');
    expect(storage(localStorage)).not.toContain(CANARY);
    expect(storage(sessionStorage)).not.toContain(CANARY);
    expect(JSON.stringify(qc.getQueryCache().getAll().map((x) => [x.queryKey, x.state.data]))).not.toContain(CANARY);
    expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => m.state))).not.toContain(CANARY);
    expect(window.location.href).not.toContain(CANARY);
    expect(JSON.stringify(router.state.location)).not.toContain(CANARY);
    expect(JSON.stringify(window.history.state)).not.toContain(CANARY);
    expect(logged.join('\n')).not.toContain(CANARY);
  });

  it('clears the token on failure too, with the honest sentence for a deployment not on Spark', async () => {
    const fake = new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview() }).on(`PUT ${BASE}/credential`, err(409, 'MLS_PROVIDER_NOT_SPARK'));
    const { qc } = mount(fake);
    await screen.findByRole('heading', { level: 2, name: 'Save a Spark key' });
    await userEvent.type(tokenInput(), CANARY);
    await userEvent.type(screen.getByLabelText('Key label'), 'CRM key');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));
    expect(await screen.findByText(INTEGRATION_ERROR_MESSAGES.MLS_PROVIDER_NOT_SPARK!)).toBeInTheDocument();
    expect(tokenInput().value).toBe('');
    expect(document.body.innerHTML).not.toContain(CANARY);
    expect(JSON.stringify(qc.getQueryCache().getAll().map((x) => x.state))).not.toContain(CANARY);
  });

  it('a token that cannot be right is not sent and says why; a short one stays only in the field', async () => {
    const fake = new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview() });
    mount(fake);
    await screen.findByRole('heading', { level: 2, name: 'Save a Spark key' });
    await userEvent.type(tokenInput(), 'too short');
    await userEvent.type(screen.getByLabelText('Key label'), 'CRM key');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));
    expect(await screen.findByText(/16 to 4,096 characters, with no spaces/)).toBeInTheDocument();
    expect(fake.callsTo(`PUT ${BASE}/credential`)).toHaveLength(0);
  });

  it('REAUTH_REQUIRED asks for the password, then the same save is sent once more; the field is already empty', async () => {
    const fake = new FakeFetch()
      .on(`GET ${BASE}`, { status: 200, body: overview() })
      .on(`PUT ${BASE}/credential`, (_c, n) => (n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { connection: connection({ status: 'not_configured', lastResult: null }) } }))
      .on('POST /auth/reauth', { status: 200, body: { session: sessionFixture({ tenant: { ...sessionFixture().tenant!, role: 'owner' }, reauthenticatedAt: new Date().toISOString() }) } });
    mount(fake);
    await screen.findByRole('heading', { level: 2, name: 'Save a Spark key' });
    await userEvent.type(tokenInput(), CANARY);
    await userEvent.type(screen.getByLabelText('Key label'), 'CRM key');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(tokenInput().value).toBe('');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Key saved\./)).toBeInTheDocument();
    const puts = fake.callsTo(`PUT ${BASE}/credential`);
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(puts[0]!.body);
    expect(document.body.innerHTML).not.toContain(CANARY);
  });

  for (const result of VALIDATE_RESULTS) {
    it(`Validate → ${result}: said in words`, async () => {
      const fake = new FakeFetch()
        .on(`GET ${BASE}`, { status: 200, body: overview({ connection: connection({ lastResult: null }) }) })
        .on(`POST ${BASE}/validate`, { status: 200, body: { result, connection: connection({ lastResult: result.toUpperCase() }) } });
      mount(fake);
      await userEvent.click(await screen.findByRole('button', { name: 'Validate' }));
      const conn = screen.getByRole('region', { name: 'Connection' });
      // the fresh result and the stored last check both read as words
      await waitFor(() => expect(within(conn).getAllByText(resultWords(result as ValidateResult).text).length).toBeGreaterThan(0));
      expect(fake.callsTo(`POST ${BASE}/validate`)).toHaveLength(1);
      expect(document.body.textContent).not.toContain(result);
      expect(document.body.textContent).not.toContain(result.toUpperCase());
    });
  }

  it('each validate result has its own sentence; live_calls_disabled says live calls are off', () => {
    const texts = VALIDATE_RESULTS.map((r) => resultWords(r).text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(resultWords('live_calls_disabled').text).toContain('live MLS calls are turned off on this deployment');
  });

  it('Validate with no key saved gets the honest MLS_CREDENTIAL_MISSING sentence', async () => {
    const fake = new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview({ connection: connection({ credentialSaved: false, keyLabel: null, lastResult: null }) }) }).on(`POST ${BASE}/validate`, err(409, 'MLS_CREDENTIAL_MISSING'));
    mount(fake);
    await userEvent.click(await screen.findByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(INTEGRATION_ERROR_MESSAGES.MLS_CREDENTIAL_MISSING!)).toBeInTheDocument();
  });

  it('Disconnect asks first, then posts to the connection and refetches', async () => {
    const fake: FakeFetch = new FakeFetch()
      .on(`GET ${BASE}`, () => ({ status: 200, body: overview({ connection: fake.callsTo(`POST /admin/integrations/connections/${CONN_ID}/disconnect`).length > 0 ? null : connection() }) }))
      .on(`POST /admin/integrations/connections/${CONN_ID}/disconnect`, { status: 200, body: { connection: { id: CONN_ID, status: 'disconnected' } } });
    mount(fake);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect the MLS?' });
    expect(fake.callsTo(`POST /admin/integrations/connections/${CONN_ID}/disconnect`)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect and remove the key' }));
    expect(await screen.findByText(/Disconnected\. The saved Spark key was removed for good\./)).toBeInTheDocument();
    expect(fake.callsTo(`POST /admin/integrations/connections/${CONN_ID}/disconnect`)).toHaveLength(1);
    expect(await screen.findByText('No MLS connection is set up yet.')).toBeInTheDocument();
  });

  it('on the built-in test provider there is no key form, and the page says why', async () => {
    mount(new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview({ provider: 'fake' }) }));
    expect(await screen.findByText('Built-in test listings (no MLS connected)')).toBeInTheDocument();
    expect(screen.getByText(/uses built-in test listings instead of Spark/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Access token')).toBeNull();
  });

  it('the Admin sees it in the sidebar under Admin', async () => {
    mount(new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview() }), 'admin');
    expect(await screen.findByRole('heading', { level: 1, name: 'MLS' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'MLS' })).toHaveAttribute('href', SPARK_PAGE_PATH);
  });

  for (const role of ['team_lead', 'agent', 'isa', 'tc'] as const) {
    it(`a ${role} has no nav entry and gets "not available", and no MLS request is made`, async () => {
      const fake = new FakeFetch().on(`GET ${BASE}`, { status: 200, body: overview() });
      mount(fake, role);
      expect(await screen.findByText("This page isn't available")).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'MLS' })).toBeNull();
      expect(screen.queryByLabelText('Access token')).toBeNull();
      expect(fake.callsTo(`GET ${BASE}`)).toHaveLength(0);
    });
  }
});
