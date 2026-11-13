// The share panel (module 72; R-CMA-9, R-CMA-7, D1, R-FH-1; E376, E600-E614) in jsdom on a scripted API: Email is off
// with every reason in words, on only when the preview says the CMA can be shared, and one tap is one request carrying
// the preview's hashes; a report that changed since the preview (CMA_STALE) is fetched again and says so.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CMA_ID, CONTACT, CO_SELLER, FakeFetch, ME, NOT_CLEARED, POINT, POINT2, RSHA, SHA, cmaApp, err, preview, view } from './testing.js';
import type { SharePreview } from './lib.js';

const user = () => userEvent.setup();
const PREVIEW = `GET /cma/${CMA_ID}/share-preview`;
const SHARE = `POST /cma/${CMA_ID}/share`;

function app(p: SharePreview | ((n: number) => SharePreview), extra: (f: FakeFetch) => FakeFetch = (f) => f) {
  const f = extra(
    new FakeFetch().on(`GET /cma/${CMA_ID}`, { status: 200, body: { cma: view() } }).on(PREVIEW, (_c, n) => ({ status: 200, body: { preview: typeof p === 'function' ? p(n) : p } })),
  );
  cmaApp(f);
  return f;
}

const panel = async () => (await screen.findByRole('heading', { name: 'Share with the client' })).closest('section')!;

describe('Share panel', () => {
  it('D9 R-CMA-7: as shipped (platform:cma not reviewed) Email is off, and the sentence and every blocker are said in words', async () => {
    app(preview(NOT_CLEARED));
    const p = within(await panel());
    expect(await p.findByText('This CMA can’t be shown to a client yet:')).toBeInTheDocument();
    expect(p.getByText(NOT_CLEARED.blockers[0]!.sentence)).toBeInTheDocument();
    expect(p.getByText('Jane Doe')).toBeInTheDocument();
    const email = screen.getByRole('button', { name: 'Email to Jane' });
    expect(email).toBeDisabled();
    // the phone's sticky bar repeats why it is off, and the button is described by it
    expect(email).toHaveAccessibleDescription('This CMA can’t be shown to a client yet: The reason is listed under “Share with the client”.');
  });

  it('R-CMA-9 R-FH-1 E604 E606 E614: disclosure items missing, a hard fair-housing match, soft "Check this" lines, a character that will not print and a report too long are each said; the send-time check in words', async () => {
    app(
      preview({
        canShare: false,
        sentence: 'Fill in the disclosure items before sharing.',
        disclosureMissing: ['intendedUsers', 'inspectedOn'],
        fairHousing: { hard: [{ termId: 'fh-1', label: 'a phrase about who belongs', where: 'notes' }], soft: [{ termId: 'fh-2', label: 'a word to check', where: 'conflicts' }] },
        warnings: [
          { code: 'WONT_PRINT', role: 'statement', codePoints: ['U+2603'] },
          { code: 'CHECK_WORDING', role: 'notes' },
        ],
        tooLong: { parts: [{ role: 'notes', chars: 4200 }] },
        decision: { id: null, outcome: 'deny', reasons: ['CONSENT_REVOKED'], explanation: 'Jane replied STOP to email.', phase: 'preview' },
      }),
    );
    const p = within(await panel());
    expect(await p.findByText('Fill in the disclosure items before sharing.')).toBeInTheDocument();
    expect(p.getByText('Fill in before sharing')).toBeInTheDocument();
    expect(p.getByText('Who the report is for')).toBeInTheDocument();
    expect(p.getByText('the inspection date')).toBeInTheDocument();
    expect(p.getByText('Edit the notes: this can’t be sent.')).toBeInTheDocument();
    expect(p.getByText('a phrase about who belongs (in your notes)')).toBeInTheDocument();
    expect(p.getByText('Check this: a word to check (in Conflicts).')).toBeInTheDocument();
    expect(p.getByText('Check this wording: your notes.')).toBeInTheDocument();
    expect(p.getByText("Won't print as written: the MLS statement (U+2603). Edit that text so every character prints.")).toBeInTheDocument();
    expect(p.getByText('your notes: 4,200 characters')).toBeInTheDocument();
    expect(p.getByText('Jane replied STOP to email.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email to Jane' })).toBeDisabled();
  });

  it('R-CMA-9 E600: on canShare the button is on; one tap (a double tap included) is one POST with the preview\'s recipient, address and hashes; then "Sent" and the CMA as shared', async () => {
    const shared = view({ status: 'shared', canEdit: false, sharedAt: '2026-11-12T11:00:00.000Z', pdfAvailable: true, share: { sharedByUserId: 'me', message: { id: 'm1', status: 'sent', statusReason: null, sentence: 'Sent.' } } });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    const f = app(preview(), (x) =>
      x.on(SHARE, async () => {
        await gate;
        return { status: 200, body: { cma: shared, message: { id: 'm1', status: 'sent', result: 'sent' } } };
      }),
    );
    const p = within(await panel());
    expect(await p.findByText('The send-time check allows this email now.')).toBeInTheDocument();
    expect(p.getByText('Your home’s estimated value range', { exact: false })).toBeInTheDocument();
    const email = await screen.findByRole('button', { name: 'Email to Jane' });
    expect(email).toBeEnabled();
    await user().dblClick(email);
    expect(await screen.findByRole('button', { name: 'Sending' })).toHaveAttribute('aria-busy', 'true');
    release();
    expect(await screen.findByRole('heading', { name: 'The email' })).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(f.callsTo(SHARE)).toHaveLength(1);
    expect(f.callsTo(SHARE)[0]!.body).toEqual({ recipientContactId: CONTACT, toPointId: POINT, contentSha256: SHA, reportSha256: RSHA });
    expect(screen.getByText('Shared on Nov 12, 2026.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download the PDF (to print or hand over)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Email/ })).toBeNull();
  });

  it('R-ISA-3 R-ISA-15 (b13 review F6-ui): under live AI care the screen says before the tap that emailing the CMA pauses AI care, beside the button too; after the share the owner gets the Resume AI care toast and the live list is asked again', async () => {
    const shared = view({ status: 'shared', canEdit: false, sharedAt: '2026-11-12T11:00:00.000Z', pdfAvailable: true, share: { sharedByUserId: 'me', message: { id: 'm1', status: 'sent', statusReason: null, sentence: 'Sent.' } } });
    const live = { rows: [{ assignmentId: '01900000-0000-7000-8000-0000000a5501', contactId: CONTACT, name: 'Jane Doe', side: 'seller', chip: { kind: 'active', sentence: 'Active' }, lastAction: null, nextTouchAt: null, capsSentence: '', inactivityReleaseAt: null, ownerUserId: ME, ownerName: 'Ava Agent', handoffOverdue: false }], holdSentence: null };
    const pausedPanel = { contactId: CONTACT, assignment: { id: '01900000-0000-7000-8000-0000000a5501', side: 'seller', state: 'paused', chip: { kind: 'paused', sentence: 'Paused' }, epoch: 1, startedAt: '2026-11-10T10:00:00.000Z', pausedAt: '2026-11-12T11:00:00.000Z', pauseReason: 'human_contact', pausedSentence: 'Paused', endedAt: null, endReason: null, undoUntil: null, ownerUserId: ME } };
    const f = app(preview(), (x) =>
      x
        .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: live })
        .on(`GET /contacts/${CONTACT}/ai-isa`, { status: 200, body: pausedPanel })
        .on(SHARE, { status: 200, body: { cma: shared, message: { id: 'm1', status: 'sent', result: 'sent' } } }),
    );
    const p = within(await panel());
    expect(await p.findByText('Emailing this CMA pauses AI care for Jane.')).toBeInTheDocument();
    // the phone's sticky bar says it beside the button as well
    expect(screen.getAllByText(/Emailing this CMA pauses AI care for Jane/).length).toBeGreaterThanOrEqual(2);
    const before = f.callsTo('GET /ai-isa/assignments?scope=all&state=live').length;
    await user().click(await screen.findByRole('button', { name: 'Email to Jane' }));
    expect(await screen.findByTestId('ai-resume-toast')).toHaveTextContent('AI care for Jane is paused because you messaged them.');
    expect(screen.getByRole('button', { name: 'Resume AI care' })).toBeInTheDocument();
    await waitFor(() => expect(f.callsTo('GET /ai-isa/assignments?scope=all&state=live').length).toBeGreaterThan(before));
  });

  it('E601 E602: CMA_STALE fetches the preview again and says the report changed; DATA_OLD says to prepare it again', async () => {
    const f = app(preview(), (x) => x.on(SHARE, (_c, n) => (n === 1 ? err(409, 'CMA_STALE', { reason: 'REPORT_CHANGED' }) : err(409, 'CMA_STALE', { reason: 'DATA_OLD' }))));
    const email = await screen.findByRole('button', { name: 'Email to Jane' });
    await waitFor(() => expect(email).toBeEnabled());
    const before = f.callsTo(PREVIEW).length;
    await user().click(email);
    expect(await screen.findByText('The report changed since you looked; check it again.')).toBeInTheDocument();
    await waitFor(() => expect(f.callsTo(PREVIEW).length).toBeGreaterThan(before));
    const again = f.callsTo(PREVIEW).length;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Email to Jane' })).toBeEnabled());
    await user().click(screen.getByRole('button', { name: 'Email to Jane' }));
    expect(await screen.findByText('Prepare it again to use the latest sales.')).toBeInTheDocument();
    await waitFor(() => expect(f.callsTo(PREVIEW).length).toBeGreaterThan(again));
    expect(f.callsTo(SHARE)).toHaveLength(2);
    expect(screen.queryByText(/Nothing was sent/)).toBeNull();
  });

  it('D1: another refusal is said in words and the preview is asked again', async () => {
    const f = app(preview(), (x) => x.on(SHARE, err(409, 'CMA_RECIPIENT_BLOCKED', { reasons: ['CONSENT_REVOKED'] })));
    const email = await screen.findByRole('button', { name: 'Email to Jane' });
    await waitFor(() => expect(email).toBeEnabled());
    const before = f.callsTo(PREVIEW).length;
    await user().click(email);
    expect(await screen.findByText('The send-time check would block this email now, so nothing was sent.')).toBeInTheDocument();
    await waitFor(() => expect(f.callsTo(PREVIEW).length).toBeGreaterThan(before));
  });

  it('owner question b: a chooser only when there is a choice; choosing another recipient or address previews it', async () => {
    const two = preview({
      recipients: [
        { contactId: CONTACT, name: 'Jane Doe', firstName: 'Jane', relationship: 'self', emails: [{ id: POINT, address: 'jane@example.test', status: 'active' }, { id: POINT2, address: 'jane.work@example.test', status: 'active' }] },
        { contactId: CO_SELLER, name: 'Lee Doe', firstName: 'Lee', relationship: 'co_seller', emails: [{ id: '01900000-0000-7000-8000-0000000p0009', address: 'lee@example.test', status: 'active' }] },
      ],
    });
    const lee = preview({ ...two, recipientContactId: CO_SELLER, toPointId: '01900000-0000-7000-8000-0000000p0009' });
    const f = app(two, (x) =>
      x.on(`${PREVIEW}?recipientContactId=${CO_SELLER}`, { status: 200, body: { preview: lee } }).on(`${PREVIEW}?recipientContactId=${CONTACT}&toPointId=${POINT2}`, { status: 200, body: { preview: { ...two, toPointId: POINT2 } } }),
    );
    const p = within(await panel());
    await user().click(await p.findByRole('radio', { name: 'jane.work@example.test' }));
    await waitFor(() => expect(f.callsTo(`${PREVIEW}?recipientContactId=${CONTACT}&toPointId=${POINT2}`)).toHaveLength(1));
    await user().click(p.getByRole('radio', { name: 'Lee Doe' }));
    expect(await screen.findByRole('button', { name: 'Email to Lee' })).toBeEnabled();
  });

  // Audit cma-v2a F7: R-CMA-9 and D1 say the tap is made "on a screen already showing the report, the recipient's D1
  // decision and every blocker". The report was behind a closed <details> and the final body (signature, footer) never
  // shown; on phones the sticky bar showed the button with neither the address nor the send-time check's answer.
  it('R-CMA-9 D1: the email exactly as it will be sent (the final body, signature included) is shown open, never behind a tap; the phone\'s sticky bar names the recipient, the address and the send-time check next to the button', async () => {
    app(preview());
    const p = within(await panel());
    await p.findByText('The send-time check allows this email now.');
    expect(p.getByText('The report as it will be emailed')).toBeVisible();
    expect(p.getByText('Subject: Your home’s estimated value range')).toBeVisible();
    const body = p.getByText(/Ava Agent/);
    expect(body).toBeVisible();
    expect(body.textContent).toBe(preview().body);
    const bar = within(document.querySelector<HTMLElement>('[data-sticky]')!);
    expect(bar.getByText('Jane Doe')).toBeVisible();
    expect(bar.getByText('jane@example.test', { exact: false })).toBeVisible();
    expect(bar.getByText('The send-time check allows this email now.')).toBeVisible();
    expect(bar.getByRole('button', { name: 'Email to Jane' })).toBeEnabled();
  });

  it('D1: a send-time deny is said in the phone\'s sticky bar beside the recipient and the address, once', async () => {
    app(preview({ canShare: false, sentence: 'The send-time check would block this email now. Jane replied STOP to email.', decision: { id: null, outcome: 'deny', reasons: ['CONSENT_REVOKED'], explanation: 'Jane replied STOP to email.', phase: 'preview' } }));
    await within(await panel()).findByText('Jane replied STOP to email.');
    const bar = within(document.querySelector<HTMLElement>('[data-sticky]')!);
    expect(bar.getByText('Jane Doe')).toBeVisible();
    expect(bar.getAllByText(/Jane replied STOP to email\./)).toHaveLength(1);
    expect(bar.getByRole('button', { name: 'Email to Jane' })).toBeDisabled();
  });

  it('one recipient with one address shows no chooser', async () => {
    app(preview());
    const p = within(await panel());
    await p.findByText('The send-time check allows this email now.');
    expect(p.queryByRole('radio')).toBeNull();
    expect(p.getByText('· jane@example.test', { exact: false })).toBeInTheDocument();
  });
});
