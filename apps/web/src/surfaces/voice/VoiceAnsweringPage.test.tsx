// AI call answering (module 55 item 8) on the staff contract: every state from the API, reasons worded by code, the
// Owner-only turn-on and widening with the attestation sent verbatim, Admin narrowing and turn-off, one request per tap
// (never retried), version conflicts, the in-memory test call, and role gating with no /voice request.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { buildPageTable, navFor, pagesFor, tapsTo } from '../../shell/pages.js';
import { surfaces } from '../../shell/registry.js';
import { homeFallback } from '../../shell/shellSurface.js';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { API_ATTESTATION, API_OWNER_ONLY_DISABLE, API_TEST_CALL_SENTENCE, IDS, NOT_ADMINS, RAW_CODE, answering, axeViolations, mountAs, pageText, reason, session, testCall } from './testing.js';
import { UNKNOWN_SCRIPT_WORDS, VERSION_CONFLICT_WORDS } from './VoiceAnsweringPage.js';
import { ADMIN_WIDEN_REASON, ANSWERING_REASON_WORDS, BOOKING_DRAFT_NOTE, DARK_WIDEN_REASON, NOT_CLEARED_BOTH_RECORDED, NO_PLAYBOOK_TO_SIMULATE, VOICE_PAGE_PATH, reasonWords } from './words.js';

const GET = 'GET /voice/answering';
const PUT = 'PUT /voice/answering/settings';
const ENABLE = 'POST /voice/answering/enable';
const DISABLE = 'POST /voice/answering/disable';
const TEST = 'POST /voice/test-call';

async function open(fake: StaffFake, role: 'owner' | 'admin' = 'owner') {
  mountAs(fake, role, VOICE_PAGE_PATH);
  await screen.findByRole('heading', { level: 1, name: 'AI call answering' });
  await screen.findByRole('heading', { level: 2, name: 'Status' });
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const noCommandId = (fake: StaffFake) => {
  for (const c of fake.calls.filter((x) => x.path.startsWith('/voice/'))) expect(JSON.stringify(c.body ?? {})).not.toMatch(/commandId/);
};

describe('R-STAFF-1 E660: the state is the API state, every reason worded by its code', () => {
  it('dark: reasons worded by code, no pack key or planning tag, no Turn on, no widening', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('dark') });
    await open(fake);
    expect(screen.getByText('AI answering is not available on this deployment yet.')).toBeInTheDocument();
    const why = screen.getByRole('list', { name: 'What keeps it off' });
    expect(within(why).getByText(ANSWERING_REASON_WORDS.VOICE_NOT_CLEARED)).toBeInTheDocument();
    expect(within(why).getByText(ANSWERING_REASON_WORDS.VOICE_VENDOR_NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.getByText('Counsel review: not recorded on this deployment.')).toBeInTheDocument();
    expect(screen.getByText('Voice vendor check: not recorded on this deployment.')).toBeInTheDocument();
    // the provider status without its planning tag
    expect(screen.getByText('No voice vendor is set up on this platform yet. AI answering stays off.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn on/ })).toBeNull();
    expect(pageText()).not.toMatch(RAW_CODE);
    expect(pageText()).not.toMatch(/platform:voice|\(N12\)/);
    // widening is off even for the Owner while dark; narrowing is still possible
    await userEvent.selectOptions(screen.getByLabelText('Answer a missed call'), '10');
    expect(screen.getByText(DARK_WIDEN_REASON)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('b14 review F7: VOICE_NOT_CLEARED never contradicts the checks: with counsel review and the vendor check both recorded it says the voice service is not cleared yet; with one recorded it names only the other', async () => {
    const both = answering('dark', { reasons: [reason('VOICE_NOT_CLEARED')], pack: { version: '2026.11.0', reviewedByCounselAt: '2026-11-02T15:00:00.000Z', vendorReady: true, cleared: false } });
    const fake = new StaffFake().on(GET, { status: 200, body: both });
    await open(fake);
    const why = screen.getByRole('list', { name: 'What keeps it off' });
    expect(why.textContent).toBe(NOT_CLEARED_BOTH_RECORDED);
    expect(why.textContent).not.toMatch(/waits for counsel review|check of a real voice vendor/);
    expect(screen.getByText('Counsel review recorded on Nov 2, 2026.')).toBeInTheDocument();
    expect(screen.getByText('Voice vendor check recorded.')).toBeInTheDocument();
  });

  it('b14 review F7: with only counsel review recorded the reason waits for the vendor check alone, and the other way round', () => {
    const r = { code: 'VOICE_NOT_CLEARED', sentence: 'x' };
    expect(reasonWords(r, { reviewedByCounselAt: '2026-11-02T15:00:00.000Z', vendorReady: false })).toBe('AI answering waits for a check of a real voice vendor.');
    expect(reasonWords(r, { reviewedByCounselAt: null, vendorReady: true })).toBe('AI answering waits for counsel review.');
    expect(reasonWords(r, { reviewedByCounselAt: null, vendorReady: false })).toBe(ANSWERING_REASON_WORDS.VOICE_NOT_CLEARED);
  });

  it('off with only the Owner choice left: counsel and vendor recorded, provider, transfers and the playbook link', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('off') });
    await open(fake);
    expect(screen.getByText('AI answering is off.')).toBeInTheDocument();
    expect(screen.getByText('Counsel review recorded on Nov 2, 2026.')).toBeInTheDocument();
    expect(screen.getByText('Voice vendor check recorded.')).toBeInTheDocument();
    expect(screen.getByText('Nobody is transferred live: no hot-lead rule is set.')).toBeInTheDocument();
    expect(screen.getByText(/The call-answering playbook is approved\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the playbook' })).toHaveAttribute('href', `/settings/playbooks/${IDS.playbook}`);
    expect(screen.getByRole('button', { name: 'Turn on AI answering' })).toBeEnabled();
    expect(pageText()).not.toMatch(RAW_CODE);
    expect(await axeViolations()).toEqual([]);
  });

  it('on: the attested date in words, no reasons, Turn off offered', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('on') });
    await open(fake);
    expect(screen.getByText('AI answering is on.')).toBeInTheDocument();
    expect(screen.getByText('Attested by the Owner on Nov 3, 2026.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'What keeps it off' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn off AI answering' })).toBeInTheDocument();
    expect(pageText()).not.toMatch(RAW_CODE);
  });

  it('off with another reason: Turn on stays disabled and says why', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('off_blocked') });
    await open(fake);
    const b = screen.getByRole('button', { name: 'Turn on AI answering' });
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription('Turn on becomes available once only your choice is left.');
    expect(screen.getByText(ANSWERING_REASON_WORDS.VOICE_PLAYBOOK_NOT_APPROVED)).toBeInTheDocument();
  });
});

describe('R-STAFF-4: turning on is the Owner confirming the API attestation verbatim, one tap, one request', () => {
  it('Turn on → I confirm and turn on (2 taps) sends exactly {attestation}, through re-auth, without a commandId', async () => {
    const fake = new StaffFake()
      .on(GET, { status: 200, body: answering('off') })
      .on(ENABLE, (_c, n) => (n === 1 ? staffError('REAUTH_REQUIRED') : { status: 200, body: answering('on') }))
      .on('POST /auth/reauth', { status: 200, body: { session: { ...session('owner'), reauthenticatedAt: new Date().toISOString() } } });
    await open(fake);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on AI answering' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn on AI answering' });
    expect(within(dialog).getByText(API_ATTESTATION)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'I confirm and turn on' }));
    // the shell's password prompt, then the same request again
    const reauth = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await userEvent.type(within(reauth).getByLabelText('Password'), 'correct horse');
    await userEvent.click(within(reauth).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('AI answering is on.');
    expect(fake.callsTo(ENABLE).map((c) => c.body)).toEqual([{ attestation: API_ATTESTATION }, { attestation: API_ATTESTATION }]);
    noCommandId(fake);
  });

  it('E661: an Admin is never offered Turn on', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('off') });
    await open(fake, 'admin');
    expect(screen.queryByRole('button', { name: /Turn on/ })).toBeNull();
    expect(screen.getByText('Only the Owner can turn AI answering on.')).toBeInTheDocument();
  });

  it('E661: an Admin turning off an Owner-attested version sees the server sentence verbatim (OWNER_REQUIRED)', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('on') }).on(DISABLE, staffError('OWNER_REQUIRED', { sentence: API_OWNER_ONLY_DISABLE }));
    await open(fake, 'admin');
    await userEvent.click(screen.getByRole('button', { name: 'Turn off AI answering' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText(API_OWNER_ONLY_DISABLE)).toBeInTheDocument();
    expect(fake.callsTo(DISABLE)).toHaveLength(1);
    expect(fake.callsTo(DISABLE)[0]!.body).toEqual({});
  });

  it('Turn off → Turn off (2 taps): one POST with an empty body, then the fresh state', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('on') }).on(DISABLE, { status: 200, body: answering('off') });
    await open(fake);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off AI answering' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Turn off AI answering?' })).getByRole('button', { name: 'Turn off' }));
    await screen.findByText('AI answering is off.');
    expect(fake.callsTo(DISABLE).map((c) => c.body)).toEqual([{}]);
    noCommandId(fake);
  });

  it('a refused turn-on is said in words by its code', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('off') }).on(ENABLE, staffError('VOICE_RECORDING_OFF'));
    await open(fake);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on AI answering' }));
    await userEvent.click(screen.getByRole('button', { name: 'I confirm and turn on' }));
    expect(await screen.findByText(ANSWERING_REASON_WORDS.VOICE_RECORDING_OFF)).toBeInTheDocument();
    expect(pageText()).not.toMatch(RAW_CODE);
  });

  it('enable, disable and settings each send exactly one request after a 502 (never retried)', async () => {
    const fake = new StaffFake()
      .on(GET, { status: 200, body: answering('off') })
      .on(ENABLE, { status: 502 })
      .on(PUT, { status: 502 });
    await open(fake);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on AI answering' }));
    await userEvent.click(screen.getByRole('button', { name: 'I confirm and turn on' }));
    await screen.findByRole('alert');
    await userEvent.selectOptions(screen.getByLabelText('Answer a missed call'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.callsTo(PUT)).toHaveLength(1));
    await settle();
    expect(fake.callsTo(ENABLE)).toHaveLength(1);
    expect(fake.callsTo(PUT)).toHaveLength(1);

    const off = new StaffFake().on(GET, { status: 200, body: answering('on') }).on(DISABLE, { status: 502 });
    document.body.innerHTML = '';
    await open(off);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off AI answering' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn off' }));
    await screen.findByRole('alert');
    await settle();
    expect(off.callsTo(DISABLE)).toHaveLength(1);
  });
});

describe('R-STAFF-4 E661: answer-after and when, sent with the version', () => {
  it('an Admin narrows (later, fewer hours): one PUT with the version and no attestation', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('on', { settings: { answerAfterSeconds: 20, answerWhen: 'missed_and_after_hours', version: 4 } }) });
    fake.on(PUT, { status: 200, body: answering('on', { settings: { answerAfterSeconds: 30, answerWhen: 'after_hours_only', version: 5 } }) });
    await open(fake, 'admin');
    expect(screen.getByRole('option', { name: 'After 20 seconds of ringing' })).toHaveProperty('selected', true);
    await userEvent.selectOptions(screen.getByLabelText('Answer a missed call'), '30');
    await userEvent.selectOptions(screen.getByLabelText('Which calls'), 'after_hours_only');
    expect(screen.queryByText(ADMIN_WIDEN_REASON)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.callsTo(PUT)).toHaveLength(1));
    expect(fake.callsTo(PUT)[0]!.body).toEqual({ answerAfterSeconds: 30, answerWhen: 'after_hours_only', version: 4 });
    noCommandId(fake);
  });

  it('an Admin cannot widen: Save is off with the Owner-only reason', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('on') });
    await open(fake, 'admin');
    await userEvent.selectOptions(screen.getByLabelText('Answer a missed call'), '10');
    expect(screen.getByText(ADMIN_WIDEN_REASON)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAccessibleDescription(ADMIN_WIDEN_REASON);
    await userEvent.selectOptions(screen.getByLabelText('Answer a missed call'), '20');
    await userEvent.selectOptions(screen.getByLabelText('Which calls'), 'missed_and_after_hours');
    expect(screen.getByText(ADMIN_WIDEN_REASON)).toBeInTheDocument();
    expect(fake.callsTo(PUT)).toHaveLength(0);
  });

  it('the Owner widens by confirming the attestation, sent verbatim', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('on') }).on(PUT, { status: 200, body: answering('on', { settings: { answerAfterSeconds: 15, answerWhen: 'after_hours_only', version: 5 } }) });
    await open(fake);
    await userEvent.selectOptions(screen.getByLabelText('Answer a missed call'), '15');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: API_ATTESTATION }));
    await userEvent.click(save);
    await waitFor(() => expect(fake.callsTo(PUT)).toHaveLength(1));
    expect(fake.callsTo(PUT)[0]!.body).toEqual({ answerAfterSeconds: 15, answerWhen: 'after_hours_only', version: 4, attestation: API_ATTESTATION });
  });

  it('VERSION_CONFLICT refetches and says so; the form shows the fresh settings', async () => {
    const fake: StaffFake = new StaffFake()
      .on(GET, () => ({ status: 200, body: fake.callsTo(PUT).length === 0 ? answering('on') : answering('on', { settings: { answerAfterSeconds: 40, answerWhen: 'after_hours_only', version: 5 } }) }))
      .on(PUT, staffError('VERSION_CONFLICT'));
    await open(fake);
    await userEvent.selectOptions(screen.getByLabelText('Answer a missed call'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(VERSION_CONFLICT_WORDS)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'After 40 seconds of ringing' })).toHaveProperty('selected', true));
    expect(fake.callsTo(GET).length).toBeGreaterThanOrEqual(2);
    expect(fake.callsTo(PUT)).toHaveLength(1);
  });
});

describe('E660 E664: the test call is an in-memory simulation', () => {
  it('Run (1 tap) sends the default booking script; shows the sentence, the lines by source, the ledger and the outcome in words, and the draft note', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('dark') }).on(TEST, { status: 200, body: testCall() });
    await open(fake);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    const result = await screen.findByTestId('test-call-result');
    expect(fake.callsTo(TEST).map((c) => c.body)).toEqual([{ script: 'booking' }]);
    expect(within(result).getByText(API_TEST_CALL_SENTENCE)).toBeInTheDocument();
    expect(within(result).getByText('What callers hear first (preview)')).toBeInTheDocument();
    expect(within(result).getByText('The recording announcement (preview)')).toBeInTheDocument();
    expect(within(result).getByText('Book a time: allowed, because the time was one of the times offered.')).toBeInTheDocument();
    expect(within(result).getByText(/^Check free times: refused, because the caller had not yet heard/)).toBeInTheDocument();
    expect(within(result).getByText('A request outside the tools the assistant may use: refused, because it is not a tool the assistant may use.')).toBeInTheDocument();
    expect(within(result).getByText('The assistant booked a time.')).toBeInTheDocument();
    expect(within(result).getByText('The assistant ended the call.')).toBeInTheDocument();
    expect(within(result).getByText(BOOKING_DRAFT_NOTE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('announcer')).toHaveTextContent(API_TEST_CALL_SENTENCE));
    expect(pageText()).not.toMatch(RAW_CODE);
    noCommandId(fake);
  });

  it('a chosen script is sent by name; a message outcome lists topics in words and has no draft note', async () => {
    const fake = new StaffFake()
      .on(GET, { status: 200, body: answering('on') })
      .on(TEST, { status: 200, body: testCall({ ledger: [{ seq: 1, tool: 'take_message', decision: 'allow', reasonCode: 'ALLOW_MESSAGE' }], handback: { outcome: 'message_taken', endReason: 'CALLER_HUNG_UP', critical: true, messageTopics: ['PRICE'], noPhoneCallback: true, confirmationChannel: null } }) });
    await open(fake);
    await userEvent.selectOptions(screen.getByLabelText('Caller script'), 'priceQuestion');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    const result = await screen.findByTestId('test-call-result');
    expect(fake.callsTo(TEST)[0]!.body).toEqual({ script: 'priceQuestion' });
    expect(within(result).getByText('Message about price.')).toBeInTheDocument();
    expect(within(result).getByText('The caller would not be called back by phone.')).toBeInTheDocument();
    expect(within(result).queryByText(BOOKING_DRAFT_NOTE)).toBeNull();
    expect(pageText()).not.toMatch(RAW_CODE);
  });

  it('E660: a 404 says there is nothing to simulate; UNKNOWN_SCRIPT arrives as VALIDATION_FAILED and is worded', async () => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('dark', { playbook: null }) }).on(TEST, (_c, n) => (n === 1 ? staffError('NOT_FOUND') : staffError('VALIDATION_FAILED', { reason: 'UNKNOWN_SCRIPT' })));
    await open(fake);
    expect(screen.getByText('No call-answering playbook yet.')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Test call' });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await within(section).findByText(NO_PLAYBOOK_TO_SIMULATE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await within(section).findByText(UNKNOWN_SCRIPT_WORDS)).toBeInTheDocument();
    expect(fake.callsTo(TEST)).toHaveLength(2);
    expect(pageText()).not.toMatch(RAW_CODE);
  });
});

describe('R-STAFF-6 E671: only the Owner and Admin open the page', () => {
  it('tap budget: More → AI call answering is 2 taps on a phone and 1 click on desktop, for the Owner and Admin only', () => {
    const table = buildPageTable(surfaces, homeFallback);
    for (const role of ['owner', 'admin'] as const) {
      const nav = navFor(pagesFor(table, role));
      expect(tapsTo(nav, VOICE_PAGE_PATH, 'phone')).toBe(2);
      expect(tapsTo(nav, VOICE_PAGE_PATH, 'desktop')).toBe(1);
      expect(nav.more.map((i) => i.label)).toContain('AI call answering');
    }
    for (const role of NOT_ADMINS) expect(pagesFor(table, role).some((p) => p.path === VOICE_PAGE_PATH)).toBe(false);
  });

  it.each(NOT_ADMINS)('%s by URL: "Not available" and zero /voice requests', async (role) => {
    const fake = new StaffFake().on(GET, { status: 200, body: answering('on') });
    mountAs(fake, role, VOICE_PAGE_PATH);
    expect(await screen.findByRole('heading', { level: 1, name: 'Not available' })).toBeInTheDocument();
    await settle();
    expect(fake.calls.filter((c) => c.path.startsWith('/voice'))).toEqual([]);
  });
});
