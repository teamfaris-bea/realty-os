// The MLS page's sync and licence-pack sections (module 41) in jsdom on a scripted API: status, last sync,
// "MLS data as of", why MLS data does or does not reach clients; the licence-pack editor marks every value
// reviewed or not, says MLS data cannot reach clients until every value is marked (R-MLS-2), clears a value's
// mark when the value changes, saves the whole pack with re-auth; the valuation section (D9, b10 review api-ui/F2) has
// the strictest defaults, its own marks and save, and says V1 shares nothing; a disconnected connection is read-only; the
// Spark disconnect asks for re-auth without stacking two dialogs; Owner/Admin only; no axe violations.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, ID, NOT_ADMINS, err, mount, reauthOk, violations } from '../../admin/integrations/testing.js';
import { SPARK_PAGE_PATH } from '../index.js';
import { PACK_KEYS, type PackKey } from './pack.js';

const PATH = SPARK_PAGE_PATH;
const PUT = `PUT /admin/mls/connections/${ID.mls}/license-pack`;

const VALUES: Record<PackKey, unknown> = {
  max_staleness_hours: 24,
  attribution_text: 'Listing data courtesy of the Test MLS.',
  disclaimer_text: 'Information deemed reliable but not guaranteed.',
  allow_rehost_photos: false,
  require_listing_brokerage: true,
  client_fields: ['status', 'listPrice', 'beds'],
  client_statuses: ['active'],
  public_fields: [],
  public_statuses: [],
};

function pack(marked: readonly PackKey[] = [], over: Partial<Record<PackKey, unknown>> = {}) {
  const unreviewed = PACK_KEYS.length - marked.length;
  return {
    values: PACK_KEYS.map((key) => ({ key, value: key in over ? over[key] : VALUES[key], counselReviewed: marked.includes(key) })),
    reviewedByCounselAt: unreviewed === 0 ? '2026-11-02T10:00:00.000Z' : null,
    unreviewedCount: unreviewed,
    sentence: unreviewed === 0 ? 'Every value is marked as reviewed by counsel.' : `Not shown to clients: ${unreviewed} of 9 values are not marked as reviewed by counsel.`,
  };
}

function mls(o: { marked?: readonly PackKey[]; status?: string; clientDisplay?: boolean; feedStale?: boolean } = {}) {
  const marked = o.marked ?? [];
  return {
    connections: [
      {
        id: ID.mls,
        displayName: 'Test MLS feed',
        status: o.status ?? 'connected',
        statusSentence: 'Connected.',
        lastSyncedAt: '2026-11-11T08:00:00.000Z',
        nextSyncAt: '2026-11-11T08:15:00.000Z',
        mlsDataAsOf: 'MLS data as of Nov 11, 8:00 AM',
        feedStale: o.feedStale ?? false,
        clientDisplay: o.clientDisplay ?? false,
        clientDisplaySentence: o.clientDisplay ? 'MLS listings may reach clients (alerts) within the licence pack.' : 'MLS listings are not shown to clients: the licence pack is not counsel-reviewed.',
        licensePack: pack(marked),
      },
    ],
  };
}

const spark = { status: 200, body: { provider: 'fake', liveCalls: false, sentence: 'Live MLS calls are turned off on this deployment.', authSchemeDefault: 'Bearer', connection: null } };
const fakeWith = (body: unknown) => new FakeFetch().on('GET /admin/mls', { status: 200, body }).on('GET /admin/integrations/mls/spark', spark);
const editor = async () => (await screen.findByRole('heading', { level: 2, name: 'Licence pack' })).closest('section')!;
const MARK = /^Counsel reviewed this value \(/;
const markBox = (s: HTMLElement, i: number) => within(s).getAllByRole('checkbox', { name: MARK })[i]!;

describe('MLS page: sync and licence pack', () => {
  it('says the connection state, last and next sync, "MLS data as of" and why MLS data does not reach clients', async () => {
    mount(fakeWith(mls()), PATH);
    expect(await screen.findByRole('heading', { level: 1, name: 'MLS' })).toBeInTheDocument();
    const sync = (await screen.findByRole('heading', { level: 2, name: 'MLS sync' })).closest('section')!;
    expect(within(sync).getByText('Test MLS feed')).toBeInTheDocument();
    expect(within(sync).getByText('MLS data as of Nov 11, 8:00 AM')).toBeInTheDocument();
    expect(within(sync).getByText('Last sync').nextSibling).toHaveTextContent(/2026/);
    expect(within(sync).getByText('MLS data does not reach clients')).toBeInTheDocument();
    expect(within(sync).getByText(/the licence pack is not counsel-reviewed/)).toBeInTheDocument();
    // the Spark key sections are still on the same page, below
    expect(screen.getByRole('heading', { level: 2, name: 'This deployment' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('when the data is too old, it says MLS listings are paused for clients', async () => {
    mount(fakeWith(mls({ feedStale: true })), PATH);
    expect(await screen.findByText(/older than the licence pack allows, so MLS listings are paused for clients until a sync brings it up to date/)).toBeInTheDocument();
  });

  it('stale data is explained by its real cause: never synced, or no limit set', async () => {
    const never = mls({ feedStale: true });
    never.connections[0]!.lastSyncedAt = null as unknown as string;
    mount(fakeWith(never), PATH);
    expect(await screen.findByText('No MLS data has been received yet, so MLS listings do not reach clients.')).toBeInTheDocument();
    expect(screen.queryByText(/until a sync brings it up to date/)).toBeNull();
  });

  it('stale data with no limit in the pack says the limit is missing, not that a sync will fix it', async () => {
    const noLimit = mls({ feedStale: true });
    noLimit.connections[0]!.licensePack = pack([], { max_staleness_hours: null });
    mount(fakeWith(noLimit), PATH);
    expect(await screen.findByText(/sets no limit on how old MLS data may be/)).toBeInTheDocument();
    expect(screen.queryByText(/until a sync brings it up to date/)).toBeNull();
  });

  it('with no MLS connection, it says no MLS data is read or reaches clients', async () => {
    mount(fakeWith({ connections: [] }), PATH);
    expect(await screen.findByText(/No MLS connection yet, so no MLS data is read and none reaches clients/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Licence pack' })).toBeNull();
  });

  it('marks every value reviewed or not, and says MLS data cannot reach clients until every value is marked', async () => {
    mount(fakeWith(mls({ marked: ['attribution_text', 'disclaimer_text'] })), PATH);
    const s = await editor();
    expect(within(s).getByText('Not reviewed by counsel', { selector: 'p' })).toBeInTheDocument();
    expect(within(s).getByText(/MLS data cannot reach clients until every value is marked as reviewed by counsel\. 7 of 9 values are not marked yet\./)).toBeInTheDocument();
    expect(within(s).getAllByText('Not reviewed by counsel', { selector: 'span' })).toHaveLength(7);
    expect(within(s).getAllByText('Reviewed by counsel', { selector: 'span' })).toHaveLength(2);
    expect(within(s).getAllByRole('checkbox', { name: MARK })).toHaveLength(PACK_KEYS.length);
    // each mark names the value it marks
    expect(within(s).getByRole('checkbox', { name: 'Counsel reviewed this value (Attribution)' })).toBeChecked();
    expect(within(s).getByRole('checkbox', { name: 'Counsel reviewed this value (Disclaimer)' })).toBeChecked();
    expect(within(s).getByLabelText('Attribution')).toHaveValue('Listing data courtesy of the Test MLS.');
  });

  it('ticking boxes does not claim anything until saved; saving sends every value with its mark, after re-auth', async () => {
    const fake = fakeWith(mls())
      .on(PUT, (c, n) => {
        if (n === 1) return err(401, 'REAUTH_REQUIRED');
        const body = c.body as Record<PackKey, { counselReviewed: boolean }>;
        return { status: 200, body: { licensePack: pack(PACK_KEYS.filter((k) => body[k].counselReviewed)) } };
      })
      .on('POST /auth/reauth', reauthOk);
    mount(fake, PATH);
    const s = await editor();
    for (let i = 0; i < PACK_KEYS.length; i++) await userEvent.click(markBox(s, i));
    // still the saved state
    expect(within(s).getByText(/MLS data cannot reach clients until every value is marked/)).toBeInTheDocument();
    expect(within(s).getByText('Not saved yet. 9 of 9 values are ticked as reviewed by counsel.')).toBeInTheDocument();
    await userEvent.click(within(s).getByRole('button', { name: 'Save licence pack' }));
    const prompt = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await userEvent.type(within(prompt).getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    expect(await within(s).findByText('Licence pack saved. Every value is marked as reviewed by counsel.')).toBeInTheDocument();
    const puts = fake.callsTo(PUT);
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(puts[0]!.body);
    const body = puts[1]!.body as Record<string, { value: unknown; counselReviewed: boolean }>;
    expect(Object.keys(body).sort()).toEqual([...PACK_KEYS].sort());
    for (const k of PACK_KEYS) expect(body[k]).toEqual({ value: VALUES[k], counselReviewed: true });
    expect(within(s).getByText('Every value is marked as reviewed by counsel')).toBeInTheDocument();
  });

  it('changing a value clears its mark (counsel reviewed the old value), and a partial save says clients still see nothing', async () => {
    const fake = fakeWith(mls({ marked: PACK_KEYS })).on(PUT, (c) => {
      const body = c.body as Record<PackKey, { counselReviewed: boolean }>;
      return { status: 200, body: { licensePack: pack(PACK_KEYS.filter((k) => body[k].counselReviewed)) } };
    });
    mount(fake, PATH);
    const s = await editor();
    expect(within(s).getByText('Every value is marked as reviewed by counsel')).toBeInTheDocument();
    const attribution = within(s).getByLabelText('Attribution');
    await userEvent.type(attribution, ' Updated.');
    expect(markBox(s, 1)).not.toBeChecked();
    expect(within(s).getByText('Changed: mark it again once counsel has reviewed the new value.')).toBeInTheDocument();
    await userEvent.click(within(within(s).getByRole('group', { name: 'Listing statuses clients may see' })).getByRole('checkbox', { name: 'Sold' }));
    expect(markBox(s, 6)).not.toBeChecked();
    await userEvent.click(within(s).getByRole('button', { name: 'Save licence pack' }));
    expect(await within(s).findByText('Licence pack saved. 2 of 9 values are not marked as reviewed, so MLS data still cannot reach clients.')).toBeInTheDocument();
    const body = fake.callsTo(PUT)[0]!.body as Record<PackKey, { value: unknown; counselReviewed: boolean }>;
    expect(body.attribution_text).toEqual({ value: 'Listing data courtesy of the Test MLS. Updated.', counselReviewed: false });
    expect(body.client_statuses).toEqual({ value: ['active', 'sold'], counselReviewed: false });
    expect(body.disclaimer_text.counselReviewed).toBe(true);
    expect(within(s).getByText(/2 of 9 values are not marked yet/)).toBeInTheDocument();
  });

  it('D9: re-saving a stored pack keeps its sold fields (sold price and date, year built, lot size, subdivision) and sends no valuation section', async () => {
    const sold = ['closePrice', 'closeDate', 'yearBuilt', 'lotSize', 'subdivision'];
    const stored = mls({ marked: PACK_KEYS });
    stored.connections[0]!.licensePack = { ...pack(PACK_KEYS, { client_fields: ['status', 'listPrice', ...sold], client_statuses: ['active', 'sold'] }) };
    const fake = fakeWith(stored).on(PUT, (c) => {
      const body = c.body as Record<PackKey, { counselReviewed: boolean }>;
      return { status: 200, body: { licensePack: pack(PACK_KEYS.filter((k) => body[k].counselReviewed)) } };
    });
    mount(fake, PATH);
    const s = await editor();
    const group = within(s).getByRole('group', { name: 'What clients may see' });
    for (const label of ['Sold price', 'Sold date', 'Year built', 'Lot size', 'Subdivision']) expect(within(group).getByRole('checkbox', { name: label })).toBeChecked();
    await userEvent.type(within(s).getByLabelText('Attribution'), ' Updated.');
    await userEvent.click(within(s).getByRole('button', { name: 'Save licence pack' }));
    await within(s).findByText(/^Licence pack saved\./);
    const body = fake.callsTo(PUT)[0]!.body as Record<string, { value: unknown; counselReviewed: boolean }>;
    expect(body['client_fields']).toEqual({ value: ['status', 'listPrice', ...sold], counselReviewed: true });
    expect('valuation' in body).toBe(false);
  });

  it('a bad number of hours is caught before any request', async () => {
    const fake = fakeWith(mls());
    mount(fake, PATH);
    const s = await editor();
    const hours = within(s).getByLabelText('Longest the MLS data may be out of date');
    await userEvent.clear(hours);
    await userEvent.type(hours, '-3');
    await userEvent.click(within(s).getByRole('button', { name: 'Save licence pack' }));
    expect(await within(s).findByText(/Enter a number of hours above 0/)).toBeInTheDocument();
    // also said next to the Save button, where the person is
    expect(within(s).getByRole('alert')).toHaveTextContent(/Nothing was saved: the longest time the MLS data may be out of date needs fixing/);
    expect(fake.callsTo(PUT)).toHaveLength(0);
  });

  it('a disconnected connection shows its pack read-only', async () => {
    mount(fakeWith(mls({ status: 'disconnected' })), PATH);
    const s = await editor();
    expect(within(s).getByText(/is disconnected, so its licence pack cannot be changed/)).toBeInTheDocument();
    expect(within(s).queryByRole('button', { name: 'Save licence pack' })).toBeNull();
    for (const box of within(s).getAllByRole('checkbox')) expect(box).toBeDisabled();
  });

  it('a refused save says why in words', async () => {
    mount(fakeWith(mls()).on(PUT, err(409, 'CONNECTION_NOT_CONNECTABLE')), PATH);
    const s = await editor();
    await userEvent.click(within(s).getByRole('button', { name: 'Save licence pack' }));
    expect(await within(s).findByRole('alert')).toHaveTextContent('This MLS connection is disconnected, so its licence pack cannot be changed. Nothing was saved.');
  });

  it('Spark disconnect: the confirm dialog closes before the password prompt opens (never two dialogs)', async () => {
    const CONN = '01900000-0000-7000-8000-00000000c0a1';
    const fake = new FakeFetch()
      .on('GET /admin/mls', { status: 200, body: { connections: [] } })
      .on('GET /admin/integrations/mls/spark', { status: 200, body: { ...spark.body, provider: 'spark', connection: { id: CONN, status: 'connected', statusSentence: 'Connected.', keyLabel: 'CRM key', credentialSaved: true, lastResult: 'CONNECTED', connectedAt: null } } })
      .on(`POST /admin/integrations/connections/${CONN}/disconnect`, (_c, n) => (n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { connection: {} } }))
      .on('POST /auth/reauth', reauthOk);
    mount(fake, PATH);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect and remove the key' }));
    const prompt = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await userEvent.type(within(prompt).getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Disconnected. The saved Spark key was removed for good.')).toBeInTheDocument();
    await waitFor(() => expect(fake.callsTo(`POST /admin/integrations/connections/${CONN}/disconnect`)).toHaveLength(2));
  });

  // ---- the valuation section (D9; b10 review api-ui/F2): the Owner's product path to record valuation use ----------

  const VPUT = PUT;
  const valuationSection = async () => (await screen.findByRole('heading', { level: 2, name: 'Valuation use' })).closest('section')!;
  const VMARK = /^Counsel reviewed this valuation value \(/;
  const vmark = (s: HTMLElement, i: number) => within(s).getAllByRole('checkbox', { name: VMARK })[i]!;
  const SENT = 'Agent CMAs need an Owner or Admin to record, from your MLS agreement, that sold data may be used for valuations: Valuation use, on the MLS admin page. 5 of 5 valuation values are not marked as reviewed by counsel. Nothing built from MLS sales reaches a client in this version: client CMAs are not built yet, and they would also wait for counsel review of the in-house CMA wording (platform:cma) on the Integrations page.';
  const valuation = (o: { agent?: boolean; marked?: boolean; statements?: unknown[]; sentence?: string } = {}) => ({
    values: [
      { key: 'agent_cma', value: o.agent ?? false, counselReviewed: o.marked ?? false },
      { key: 'client_cma', value: false, counselReviewed: o.marked ?? false },
      { key: 'automated_notes', value: false, counselReviewed: o.marked ?? false },
      { key: 'avm_flag_scope', value: 'all_client_outputs', counselReviewed: o.marked ?? false },
      { key: 'statements', value: o.statements ?? [], counselReviewed: o.marked ?? false },
    ],
    reviewedByCounselAt: o.marked ? '2026-11-12T10:00:00.000Z' : null,
    unreviewedCount: o.marked ? 0 : 5,
    sentence: o.sentence ?? SENT,
  });

  it('D9 b10 api-ui/F2: the valuation section shows the strictest defaults when none is stored: no use ticked, every client output, no statement; it says this version shares nothing', async () => {
    mount(fakeWith(mls({ marked: PACK_KEYS })), PATH); // a display pack from before D9: no valuation section in the response
    const s = await valuationSection();
    for (const name of [/^Agents may prepare CMAs from MLS sold data/, /^CMAs built from MLS sold data may be shared with clients/, /^Automated home-value notes and seller-update value ranges may carry values/]) {
      expect(within(s).getByRole('checkbox', { name })).not.toBeChecked();
    }
    expect(within(s).getByLabelText('Where a seller’s “no automated valuation” choice applies')).toHaveValue('all_client_outputs');
    expect(within(s).getByText('No state statement yet.')).toBeInTheDocument();
    expect(within(s).getAllByRole('checkbox', { name: VMARK }).every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    expect(within(s).getByText('Not reviewed by counsel', { selector: 'p' })).toBeInTheDocument();
    expect(s).toHaveTextContent(/Nothing built from MLS sales reaches a client in this version/);
    // the client uses say they are not available in this version
    expect(s).toHaveTextContent(/Not available in this version: nothing built from MLS sales reaches a client, whatever this says\./);
    expect(await violations()).toEqual([]);
  });

  it('D9 b10 api-ui/F2: an Owner records agent CMAs, a state statement and the counsel marks; the PUT carries the stored display pack unchanged plus the valuation section; changing a value clears its mark', async () => {
    const fake = fakeWith({ connections: [{ ...mls({ marked: PACK_KEYS }).connections[0]!, licensePack: { ...pack(PACK_KEYS), valuation: valuation() } }] }).on(VPUT, (c) => {
      const body = c.body as { valuation: Record<string, { value: unknown; counselReviewed: boolean }> };
      const marked = Object.values(body.valuation).every((v) => v.counselReviewed);
      return { status: 200, body: { licensePack: { ...pack(PACK_KEYS), valuation: valuation({ agent: body.valuation.agent_cma!.value === true, marked, statements: body.valuation.statements!.value as unknown[], sentence: marked ? 'Agents may prepare CMAs. Every valuation value is marked as reviewed by counsel. Nothing built from MLS sales reaches a client in this version.' : SENT }) } } };
    });
    mount(fake, PATH);
    const s = await valuationSection();
    await userEvent.click(within(s).getByRole('checkbox', { name: /^Agents may prepare CMAs from MLS sold data/ }));
    await userEvent.click(within(s).getByRole('button', { name: 'Add a state statement' }));
    await userEvent.selectOptions(within(s).getByLabelText('State'), 'CA');
    await userEvent.type(within(s).getByLabelText('Statement text'), 'An estimate of value, not an appraisal (test statement).');
    await userEvent.clear(within(s).getByLabelText('Smallest type size (points)'));
    await userEvent.type(within(s).getByLabelText('Smallest type size (points)'), '12');
    for (let i = 0; i < 5; i++) await userEvent.click(vmark(s, i));
    // a change after marking clears that mark (counsel reviewed the old value)
    await userEvent.click(within(s).getByRole('checkbox', { name: /^Agents may prepare CMAs from MLS sold data/ }));
    expect(vmark(s, 0)).not.toBeChecked();
    expect(within(s).getByText('Changed: mark it again once counsel has reviewed the new value.')).toBeInTheDocument();
    await userEvent.click(within(s).getByRole('checkbox', { name: /^Agents may prepare CMAs from MLS sold data/ }));
    await userEvent.click(vmark(s, 0));
    await userEvent.click(within(s).getByRole('button', { name: 'Save valuation use' }));
    expect(await within(s).findByText('Valuation use saved. Every valuation value is marked as reviewed by counsel.')).toBeInTheDocument();
    const body = fake.callsTo(VPUT)[0]!.body as Record<string, { value: unknown; counselReviewed: boolean }> & { valuation: Record<string, { value: unknown; counselReviewed: boolean }> };
    // the display pack goes back exactly as stored, so its review stamp is kept (the server keeps it when unchanged)
    for (const k of PACK_KEYS) expect(body[k]).toEqual({ value: VALUES[k], counselReviewed: true });
    expect(body.valuation).toEqual({
      agent_cma: { value: true, counselReviewed: true },
      client_cma: { value: false, counselReviewed: true },
      automated_notes: { value: false, counselReviewed: true },
      avm_flag_scope: { value: 'all_client_outputs', counselReviewed: true },
      statements: { value: [{ region: 'CA', text: 'An estimate of value, not an appraisal (test statement).', minPointSize: 12 }], counselReviewed: true },
    });
    expect(within(s).getByText('Every valuation value is marked as reviewed by counsel', { selector: 'p' })).toBeInTheDocument();
  });

  it('D9 b10 api-ui/F2: a statement without a state, with a size outside 6–36, or a second one for the same state is caught before any request', async () => {
    const fake = fakeWith({ connections: [{ ...mls().connections[0]!, licensePack: { ...pack(), valuation: valuation() } }] });
    mount(fake, PATH);
    const s = await valuationSection();
    await userEvent.click(within(s).getByRole('button', { name: 'Add a state statement' }));
    await userEvent.type(within(s).getByLabelText('Statement text'), 'Text.');
    await userEvent.click(within(s).getByRole('button', { name: 'Save valuation use' }));
    expect(await within(s).findByRole('alert')).toHaveTextContent('Nothing was saved: every state statement needs a state (each state once), a text and a type size from 6 to 36 points.');
    await userEvent.selectOptions(within(s).getByLabelText('State'), 'CA');
    await userEvent.clear(within(s).getByLabelText('Smallest type size (points)'));
    await userEvent.type(within(s).getByLabelText('Smallest type size (points)'), '40');
    await userEvent.click(within(s).getByRole('button', { name: 'Save valuation use' }));
    expect(within(s).getByRole('alert')).toHaveTextContent(/Nothing was saved/);
    expect(fake.callsTo(VPUT)).toHaveLength(0);
  });

  it('D9 b10 api-ui/F2: a disconnected connection shows its valuation section read-only', async () => {
    mount(fakeWith({ connections: [{ ...mls({ status: 'disconnected' }).connections[0]!, licensePack: { ...pack(), valuation: valuation({ agent: true }) } }] }), PATH);
    const s = await valuationSection();
    expect(within(s).queryByRole('button', { name: 'Save valuation use' })).toBeNull();
    expect(within(s).queryByRole('button', { name: 'Add a state statement' })).toBeNull();
    for (const box of within(s).getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(within(s).getByRole('checkbox', { name: /^Agents may prepare CMAs from MLS sold data/ })).toBeChecked();
  });

  for (const role of NOT_ADMINS) {
    it(`a ${role} gets "not available" and no MLS request is made`, async () => {
      const fake = fakeWith(mls());
      mount(fake, PATH, role);
      expect(await screen.findByText("This page isn't available")).toBeInTheDocument();
      expect(fake.callsTo('GET /admin/mls')).toHaveLength(0);
    });
  }
});
