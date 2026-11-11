// Duplicates pages in jsdom. The merge itself (engine, child-row move, opt-outs) is proven by api/duplicates
// and the db merge tests against Postgres; these prove the page: the honest pre-merge text (what moves,
// every opt-out stays), the 3-tap path, the owner choice shown up front, dismiss with Undo, and no Merge
// button for someone who cannot merge.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { surface as contactSurface } from '../contact/index.js';
import { surface } from './index.js';
import { type DupPair, movesSentence, optOutSentence, sidesOf } from './lib.js';

const A = '01900000-0000-7000-8000-00000000d001';
const B = '01900000-0000-7000-8000-00000000d002';
const PAIR = '01900000-0000-7000-8000-00000000dd01';
const U1 = '01900000-0000-7000-8000-0000000000a1';
const U2 = '01900000-0000-7000-8000-0000000000a2';

function side(id: string, name: string, over: Partial<DupPair['a']> = {}): DupPair['a'] {
  return {
    id,
    displayName: name,
    stage: 'new',
    ownershipState: 'owned',
    owner: { userId: U1, displayName: 'Ava Chen' },
    ownedAt: '2026-11-01T10:00:00.000Z',
    createdAt: id === A ? '2026-11-01T10:00:00.000Z' : '2026-11-05T10:00:00.000Z',
    source: null,
    doNotContact: false,
    phones: [{ kind: 'phone', address: id === A ? '+14155550101' : '+14155550102', label: 'mobile' }],
    emails: [{ kind: 'email', address: 'dana@example.test', label: 'other' }],
    counts: { notes: id === B ? 2 : 0, tags: id === B ? 1 : 0, fieldValues: 0, relationships: 0 },
    ...over,
  };
}

function pair(over: Partial<DupPair> = {}): DupPair {
  return { id: PAIR, matchReason: 'shared_email', reasonText: 'Same email address', status: 'open', createdAt: '2026-11-05T10:00:00.000Z', suggestedSurvivorId: A, owner: { rule: 'same', userId: U1 }, canMerge: true, a: side(A, 'Dana Fox'), b: side(B, 'Dana F.'), ...over };
}

function app(fake: FakeFetch, path: string, role: 'agent' | 'team_lead' | 'tc' = 'agent') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: tableWith(surface, contactSurface) });
}

describe('duplicates lib', () => {
  it('R-PAR-45: the moves sentence names every category that moves, and the opt-out sentence never promises a lift', () => {
    const p = pair();
    const { merge } = sidesOf(p);
    expect(movesSentence(merge)).toBe('Moves to the kept record: 2 notes, 1 tag, 2 phones and emails, plus texts, calls, emails and stage history.');
    expect(optOutSentence(p)).toMatch(/Every opt-out on either record stays/);
    expect(optOutSentence(pair({ b: side(B, 'Dana F.', { doNotContact: true }) }))).toBe('Dana F. is marked "do not contact". The merged person stays do-not-contact.');
    expect(sidesOf(p, B).keep.id).toBe(B);
  });
});

describe('duplicates pages', () => {
  it('R-PAR-44 §5: Duplicates → pair → Merge is 3 taps, and Merge calls the existing ownership command with the suggested survivor', async () => {
    const fake = new FakeFetch();
    fake.on('GET /duplicates?limit=50', { status: 200, body: { duplicates: [pair()], nextCursor: null } });
    fake.on(`GET /duplicates/${PAIR}`, { status: 200, body: { duplicate: pair() } });
    fake.on(`POST /leads/${A}/merge`, { status: 200, body: { result: { ok: true } } });
    app(fake, '/duplicates');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Review Dana Fox and Dana F.' }));
    expect(await screen.findByText(/Every opt-out on either record stays/)).toBeTruthy();
    expect(screen.getByText(/Moves to the kept record: 2 notes, 1 tag/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Merge into Dana Fox' }));
    await waitFor(() => expect(fake.callsTo(`POST /leads/${A}/merge`)).toHaveLength(1));
    const body = fake.callsTo(`POST /leads/${A}/merge`)[0]!.body as { loserId: string; commandId: string; ownerChoice?: string };
    expect(body.loserId).toBe(B);
    expect(body.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.ownerChoice).toBeUndefined();
  });

  it('R-OWN-24: two owners: the owner choice is shown before the tap, preselected, and sent with the merge; "Keep … instead" swaps the survivor', async () => {
    const fake = new FakeFetch();
    const p = pair({ owner: { rule: 'choose', preselectedUserId: U1, options: [{ userId: U1, displayName: 'Ava Chen' }, { userId: U2, displayName: 'Ben Ortiz' }] } });
    fake.on(`GET /duplicates/${PAIR}`, { status: 200, body: { duplicate: p } });
    fake.on(`POST /leads/${B}/merge`, { status: 200, body: { result: { ok: true } } });
    app(fake, `/duplicates/${PAIR}`, 'team_lead');
    const user = userEvent.setup();
    expect(((await screen.findByRole('radio', { name: 'Ava Chen' })) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'Ben Ortiz' }));
    await user.click(screen.getByRole('button', { name: 'Keep Dana F. instead' }));
    await user.click(screen.getByRole('button', { name: 'Merge into Dana F.' }));
    await waitFor(() => expect(fake.callsTo(`POST /leads/${B}/merge`)).toHaveLength(1));
    expect(fake.callsTo(`POST /leads/${B}/merge`)[0]!.body).toMatchObject({ loserId: A, ownerChoice: U2 });
  });

  it('R-PAR-44: "Not the same person" dismisses without a confirm dialog, and Undo on the list restores it', async () => {
    const fake = new FakeFetch();
    fake.on(`GET /duplicates/${PAIR}`, { status: 200, body: { duplicate: pair() } });
    fake.on(`POST /duplicates/${PAIR}/dismiss`, { status: 200, body: { duplicate: pair({ status: 'dismissed' }) } });
    fake.on('GET /duplicates?limit=50', { status: 200, body: { duplicates: [], nextCursor: null } });
    fake.on(`POST /duplicates/${PAIR}/restore`, { status: 200, body: { duplicate: pair() } });
    app(fake, `/duplicates/${PAIR}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Not the same person' }));
    expect(await screen.findByText('Marked Dana Fox and Dana F. as different people.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fake.callsTo(`POST /duplicates/${PAIR}/restore`)).toHaveLength(1));
  });

  it('R-PERM-6: someone who cannot merge sees why and no Merge button; a server refusal is shown in words', async () => {
    const fake = new FakeFetch();
    fake.on(`GET /duplicates/${PAIR}`, { status: 200, body: { duplicate: pair({ canMerge: false, owner: { rule: 'choose', preselectedUserId: U1, options: [{ userId: U1, displayName: 'Ava Chen' }, { userId: U2, displayName: 'Ben Ortiz' }] } }) } });
    app(fake, `/duplicates/${PAIR}`);
    expect(await screen.findByText('These belong to different agents, so a Team Lead or Admin merges them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Merge/ })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('an engine refusal (the pair changed) is a sentence, never a code', async () => {
    const fake = new FakeFetch();
    fake.on(`GET /duplicates/${PAIR}`, { status: 200, body: { duplicate: pair() } });
    fake.on(`POST /leads/${A}/merge`, err(409, 'CONTACT_MERGED'));
    app(fake, `/duplicates/${PAIR}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Merge into Dana Fox' }));
    expect(await screen.findByText('One of these was already merged. The list is up to date now.')).toBeTruthy();
    expect(screen.queryByText('CONTACT_MERGED')).toBeNull();
  });
});
