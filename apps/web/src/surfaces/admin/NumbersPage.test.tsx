// Phone numbers and email in jsdom: registration status in words, release needs a second tap and is
// re-auth protected (the shell prompt), domains show their DNS records and check results.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, leadAdminApp, member } from './lib/testing.js';
import type { PhoneNumber } from './lib/types.js';
import { registrationWords } from './NumbersPage.js';

const num = (over: Partial<PhoneNumber> = {}): PhoneNumber => ({ id: 'n1', e164: '+14155550100', purpose: 'team_main', numberType: 'local', assignedUserId: null, registrationId: 'reg-1', registrationStatus: 'submitted', smsCapable: true, voiceCapable: true, releasedAt: null, leadSourceId: null, ...over });

const SOURCES = [
  { id: 'src-1', name: 'Yard signs', kind: 'sign_call', active: true, hasToken: true, createdAt: '' },
  { id: 'src-2', name: 'Old ads', kind: 'ads', active: false, hasToken: true, createdAt: '' },
];

function numbersFake(numbers: PhoneNumber[] = [num()]) {
  return new FakeFetch()
    .on('GET /numbers', { status: 200, body: { numbers } })
    .on('GET /members', { status: 200, body: { members: [member()], invites: [] } })
    .on('GET /lead-sources', { status: 200, body: { sources: SOURCES } });
}

describe('Phone and email', () => {
  it('never says a number can text before the carrier approved its registration', () => {
    expect(registrationWords('approved').text).toBe('Texting approved');
    for (const s of ['submitted', 'draft', 'rejected', 'suspended', null]) expect(registrationWords(s).text).not.toBe('Texting approved');
  });

  it('lists numbers with their registration status; checking a pending one asks the carrier again', async () => {
    const fake = numbersFake().on('POST /sender-registrations/reg-1/refresh', { status: 200, body: { registration: { id: 'reg-1', kind: 'a2p_campaign', status: 'approved', useCase: 'x', statusChangedAt: '' } } });
    leadAdminApp(fake, '/admin/numbers', 'admin');
    expect(await screen.findByText('(415) 555-0100')).toBeInTheDocument();
    expect(screen.getByText('Texting registration waiting for the carrier')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check registration status' }));
    await waitFor(() => expect(fake.callsTo('POST /sender-registrations/reg-1/refresh')).toHaveLength(1));
    await waitFor(() => expect(fake.callsTo('GET /numbers').length).toBeGreaterThanOrEqual(2));
  });

  it('b9 comms sends/F1 R-TWL-9: a number the carrier paused says so (never "Texting approved"), names what still works, and offers "Check registration status"', async () => {
    const fake = numbersFake([num({ registrationStatus: 'approved', textingPausedDetail: 'SENDER_NOT_VERIFIED: provider error 30034 on a local number ending 0100' })]);
    leadAdminApp(fake, '/admin/numbers', 'admin');
    expect(await screen.findByText('(415) 555-0100')).toBeInTheDocument();
    expect(screen.queryByText('Texting approved')).not.toBeInTheDocument();
    expect(screen.getByText('Texting paused for this number')).toBeInTheDocument();
    expect(screen.getByText(/Calls still work, and other numbers are not affected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check registration status' })).toBeInTheDocument();
  });

  it('b9 comms sends/F1: a paused number whose registration is suspended says the registration is suspended (not "other numbers are not affected")', async () => {
    leadAdminApp(numbersFake([num({ registrationStatus: 'suspended', textingPausedDetail: 'SENDER_NOT_VERIFIED: provider error 30034 on a local number ending 0100' })]), '/admin/numbers', 'admin');
    expect(await screen.findByText('(415) 555-0100')).toBeInTheDocument();
    expect(screen.queryByText('Texting paused for this number')).not.toBeInTheDocument();
    expect(screen.queryByText(/other numbers are not affected/)).not.toBeInTheDocument();
  });

  it('with no numbers it says nobody can call or text clients yet', async () => {
    leadAdminApp(numbersFake([]), '/admin/numbers', 'owner');
    expect(await screen.findByText('There are no numbers yet, so nobody can call or text clients from the app.')).toBeInTheDocument();
  });

  it('releasing a number takes a second, explicit tap', async () => {
    const fake = numbersFake([num({ registrationStatus: 'approved' })]).on('POST /numbers/n1/release', { status: 200, body: { number: num({ releasedAt: new Date().toISOString() }) } });
    leadAdminApp(fake, '/admin/numbers', 'owner');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Release number' }));
    expect(fake.callsTo('POST /numbers/n1/release')).toHaveLength(0);
    expect(screen.getByText(/Released numbers can't be recovered/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Release (415) 555-0100 for good' }));
    expect(await screen.findByText('(415) 555-0100 released')).toBeInTheDocument();
  });

  it('getting a number sends the purpose and area code', async () => {
    const fake = numbersFake([]).on('POST /numbers', { status: 201, body: { number: num({ e164: '+15105550111' }) } });
    leadAdminApp(fake, '/admin/numbers', 'owner');
    const u = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Get a number' });
    await u.type(within(form).getByLabelText('Area code (optional)'), '510');
    await u.click(within(form).getByRole('button', { name: 'Get number' }));
    expect(await screen.findByText('(510) 555-0111 added')).toBeInTheDocument();
    expect(fake.callsTo('POST /numbers')[0]!.body).toEqual({ purpose: 'team_main', areaCode: '510' });
  });

  it('a new sending domain shows the DNS records to add and its SPF / DKIM / DMARC results in words', async () => {
    const d = { id: 'd1', domain: 'mail.harbor.test', spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', verifiedAt: null, records: [{ type: 'TXT', name: 'mail.harbor.test', value: 'v=spf1 include:send.example ~all' }] };
    const fake = numbersFake().on('POST /sending-domains', { status: 201, body: { domain: d } }).on('POST /sending-domains/d1/verify', { status: 200, body: { domain: { ...d, spf: 'pass', dkim: 'fail', dmarc: 'pass' } } });
    leadAdminApp(fake, '/admin/numbers', 'owner');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Domain'), 'mail.harbor.test');
    await u.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(await screen.findByText('v=spf1 include:send.example ~all')).toBeInTheDocument();
    expect(screen.getByText('SPF not checked yet')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Check DNS now' }));
    expect(await screen.findByText('DKIM failing')).toBeInTheDocument();
    expect(screen.getByText('mail.harbor.test is not verified yet')).toBeInTheDocument();
  });

  it('a live tracking number has a Lead source select (live sources only, plus the one it credits now); changing it is one PATCH', async () => {
    const fake = numbersFake([num({ id: 't1', purpose: 'tracking', e164: '+14155550177', leadSourceId: 'src-2' }), num({ id: 'm1', purpose: 'team_main' })]).on('PATCH /numbers/t1/lead-source', { status: 200, body: { number: num({ id: 't1', purpose: 'tracking', leadSourceId: 'src-1' }) } });
    leadAdminApp(fake, '/admin/numbers', 'owner');
    const u = userEvent.setup();
    await screen.findByText('(415) 555-0177');
    const selects = await screen.findAllByLabelText('Lead source');
    // only the tracking number has one (the acquire form's shows only with purpose tracking)
    expect(selects).toHaveLength(1);
    expect(within(selects[0]!).getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'Yard signs', 'Old ads (off)']);
    expect(selects[0]).toHaveValue('src-2');
    await u.selectOptions(selects[0]!, 'src-1');
    await waitFor(() => expect(fake.callsTo('PATCH /numbers/t1/lead-source')).toHaveLength(1));
    expect(fake.callsTo('PATCH /numbers/t1/lead-source')[0]!.body).toEqual({ leadSourceId: 'src-1' });
    expect(await screen.findByText('(415) 555-0177 now credits Yard signs')).toBeInTheDocument();
  });

  it('getting a tracking number can tie it to a live source; the server’s notice is said as is', async () => {
    const fake = numbersFake([]).on('POST /numbers', { status: 201, body: { number: num({ e164: '+15105550111', purpose: 'tracking' }), notice: 'Bought, but not tied to Yard signs: that source was turned off.' } });
    leadAdminApp(fake, '/admin/numbers', 'owner');
    const u = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Get a number' });
    expect(within(form).queryByLabelText('Lead source')).toBeNull();
    await u.selectOptions(within(form).getByLabelText('New number for'), 'tracking');
    const pick = within(form).getByLabelText('Lead source');
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['None for now', 'Yard signs']);
    await u.selectOptions(pick, 'src-1');
    await u.click(within(form).getByRole('button', { name: 'Get number' }));
    expect(await screen.findByText('Bought, but not tied to Yard signs: that source was turned off.')).toBeInTheDocument();
    expect(fake.callsTo('POST /numbers')[0]!.body).toEqual({ purpose: 'tracking', leadSourceId: 'src-1' });
  });
});
