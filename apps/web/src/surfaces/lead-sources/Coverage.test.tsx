// Source coverage on the Lead sources screen, in jsdom (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-10,
// R-TEAMQ-11): the list card and the source page say the covered state in words (the server's sentence, never a
// colour alone, never a code), list each warning as a sentence, and let the Owner or Admin name the owner and the
// backup, mark high intent and turn coverage on, with the switch unavailable until both people are named. Names are
// made up.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { ID, member } from '../admin/lib/testing.js';
import { COVERAGE_INTRO, coverageErrorSentence, memberOptions } from './Coverage.js';
import { S1, coverage, err, overview, source, sourcesApp, sourcesFake } from './testing.js';
import type { SourceCoverage } from './types.js';

const page = `/admin/lead-sources/${S1}`;
const jordan = member({ userId: ID.ava, displayName: 'Jordan P.', role: 'agent' });
const sam = member({ userId: ID.ben, displayName: 'Sam T.', role: 'isa' });
const tc = member({ userId: '01900000-0000-7000-8000-0000000000a7', displayName: 'Terry C.', role: 'tc' });
const gone = member({ userId: '01900000-0000-7000-8000-0000000000a8', displayName: 'Gale S.', role: 'agent', status: 'suspended' });
const members = { members: [sam, jordan, tc, gone], invites: [] };

const NOT_COVERED = coverage();
const COVERED: SourceCoverage = coverage({
  owner: { userId: ID.ava, name: 'Jordan P.', status: 'active' },
  backup: { userId: ID.ben, name: 'Sam T.', status: 'active' },
  highIntent: true,
  covered: true,
  setting: true,
  sentence: 'Covered: Jordan P. owns this source and Sam T. is the backup.',
  warnings: [{ code: 'SHARED_FALLBACK_POND', sentence: 'Its fallback pond, "Main pond", is also the fallback pond of Yard signs.' }],
  changedAt: '2026-11-19T15:00:00.000Z',
});

const card = async () => within((await screen.findByRole('heading', { level: 2, name: 'Coverage' })).closest('section')!);
const fakeWith = (c: SourceCoverage | undefined) => sourcesFake(overview([source({ name: 'Website form', kind: 'website', ...(c ? { coverage: c } : {}) })])).on('GET /members', { status: 200, body: members });

describe('R-TEAMQ-10 coverage on the lead sources list', () => {
  it('R-TEAMQ-10: each card says the covered state in the server\'s words and marks a high-intent source; nothing is a code', async () => {
    const covered = source({ id: S1, name: 'Website form', kind: 'website', coverage: COVERED });
    const bare = source({ id: '01900000-0000-7000-8000-00000000510b', name: 'Yard signs', kind: 'sign_call', coverage: NOT_COVERED });
    sourcesApp(sourcesFake(overview([covered, bare])), '/admin/lead-sources', 'admin');
    const a = within((await screen.findByRole('heading', { level: 2, name: 'Website form' })).closest('article')!);
    expect(a.getByText('Covered: Jordan P. owns this source and Sam T. is the backup.')).toBeInTheDocument();
    expect(a.getByText('High intent')).toBeInTheDocument();
    const b = within(screen.getByRole('heading', { level: 2, name: 'Yard signs' }).closest('article')!);
    expect(b.getByText('Not covered: no owner and no backup are named.')).toBeInTheDocument();
    expect(b.queryByText('High intent')).toBeNull();
    expect(document.body.textContent).not.toMatch(/NO_OWNER|NO_BACKUP|SHARED_FALLBACK_POND|undefined|null/);
  });

  it('R-TEAMQ-10: a source from a server that sends no coverage shows no coverage line and no card (nothing is invented)', async () => {
    sourcesApp(fakeWith(undefined), page, 'owner');
    expect(await screen.findByRole('heading', { level: 2, name: 'This source' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Coverage' })).toBeNull();
  });
});

describe('R-TEAMQ-10 R-TEAMQ-11 the Coverage card of one source', () => {
  it('R-TEAMQ-10 E833: says "Not covered" with the reason and every warning as a sentence; the switch cannot be turned on until an owner and a backup are picked', async () => {
    const fake = fakeWith(NOT_COVERED);
    sourcesApp(fake, page, 'owner');
    const c = await card();
    expect(c.getByText(COVERAGE_INTRO)).toBeInTheDocument();
    // R-TEAMQ-24 (review fix L3): the intro states no release time of its own
    expect(COVERAGE_INTRO).not.toMatch(/\d+ minutes/);
    expect(c.getByText('Not covered: no owner and no backup are named.')).toBeInTheDocument();
    const warnings = within(c.getByRole('list', { name: 'What to check' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(warnings).toEqual(['No owner is named for this source.', 'No backup is named for this source.']);
    const covered = c.getByRole('checkbox', { name: 'Covered' });
    expect(covered).toBeDisabled();
    expect(c.getByText('Name an owner and a backup first.')).toBeInTheDocument();
    // people who can take leads, by name, with their role in words; a TC and a suspended member are not offered
    await waitFor(() => expect(within(c.getByLabelText('Owner')).getAllByRole('option').length).toBeGreaterThan(1));
    expect(within(c.getByLabelText('Owner')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Nobody', 'Jordan P. (Agent)', 'Sam T. (ISA)']);
    expect(c.getByRole('button', { name: 'Save coverage' })).toBeDisabled();
  });

  it('R-TEAMQ-10: picking an owner and a backup, marking high intent and turning Covered on sends the whole coverage in one PUT, then says it was saved and shows the server\'s new sentence', async () => {
    let current = NOT_COVERED;
    const fake = sourcesFake(overview([source({ name: 'Website form', kind: 'website', coverage: current })]))
      .on('GET /members', { status: 200, body: members })
      .on('GET /lead-sources/overview', () => ({ status: 200, body: overview([source({ name: 'Website form', kind: 'website', coverage: current })]) }))
      .on(`PUT /lead-sources/${S1}/coverage`, () => {
        current = { ...COVERED, warnings: [] };
        return { status: 200, body: { coverage: current } };
      });
    sourcesApp(fake, page, 'admin');
    const u = userEvent.setup();
    const c = await card();
    await waitFor(() => expect(within(c.getByLabelText('Owner')).getAllByRole('option').length).toBeGreaterThan(1));
    await u.selectOptions(c.getByLabelText('Owner'), ID.ava);
    expect(c.getByRole('checkbox', { name: 'Covered' })).toBeDisabled();
    await u.selectOptions(c.getByLabelText('Backup'), ID.ben);
    await u.click(c.getByRole('checkbox', { name: 'High intent' }));
    const covered = c.getByRole('checkbox', { name: 'Covered' });
    expect(covered).toBeEnabled();
    await u.click(covered);
    await u.click(c.getByRole('button', { name: 'Save coverage' }));
    await waitFor(() => expect(fake.callsTo(`PUT /lead-sources/${S1}/coverage`)).toHaveLength(1));
    expect(fake.callsTo(`PUT /lead-sources/${S1}/coverage`)[0]!.body).toEqual({ ownerUserId: ID.ava, backupUserId: ID.ben, highIntent: true, covered: true });
    const after = await card();
    expect(await after.findByText('Covered: Jordan P. owns this source and Sam T. is the backup.')).toBeInTheDocument();
    expect(after.getAllByRole('status').some((s) => s.textContent === 'Coverage saved')).toBe(true);
    expect(after.queryByRole('list', { name: 'What to check' })).toBeNull();
  });

  it('R-TEAMQ-10: taking a person away turns Covered off in what is sent (covered needs both people)', async () => {
    const fake = fakeWith(COVERED).on(`PUT /lead-sources/${S1}/coverage`, { status: 200, body: { coverage: NOT_COVERED } });
    sourcesApp(fake, page, 'owner');
    const u = userEvent.setup();
    const c = await card();
    await waitFor(() => expect(c.getByLabelText('Backup')).toHaveValue(ID.ben));
    expect(c.getByRole('checkbox', { name: 'Covered' })).toBeChecked();
    await u.selectOptions(c.getByLabelText('Backup'), '');
    expect(c.getByRole('checkbox', { name: 'Covered' })).not.toBeChecked();
    expect(c.getByRole('checkbox', { name: 'Covered' })).toBeDisabled();
    await u.click(c.getByRole('button', { name: 'Save coverage' }));
    await waitFor(() => expect(fake.callsTo(`PUT /lead-sources/${S1}/coverage`)).toHaveLength(1));
    expect(fake.callsTo(`PUT /lead-sources/${S1}/coverage`)[0]!.body).toEqual({ ownerUserId: ID.ava, backupUserId: null, highIntent: true, covered: false });
  });

  it('R-TEAMQ-11 E834: a suspended backup stays named and selected, labelled as suspended; the card says "Not covered" and why, and that nobody was put in their place', async () => {
    const flagged = coverage({
      owner: { userId: ID.ava, name: 'Jordan P.', status: 'active' },
      backup: { userId: gone.userId, name: 'Gale S.', status: 'suspended' },
      setting: true,
      covered: false,
      sentence: 'Not covered: the backup, Gale S., is suspended.',
      warnings: [{ code: 'BACKUP_UNAVAILABLE', sentence: 'The backup, Gale S., is suspended. Nobody was put in their place: until another backup is named, the backup alert goes to the team lead of whoever has the lead.' }],
    });
    sourcesApp(fakeWith(flagged), page, 'owner');
    const c = await card();
    expect(c.getByText('Not covered: the backup, Gale S., is suspended.')).toBeInTheDocument();
    expect(c.getByText(/Nobody was put in their place/)).toBeInTheDocument();
    await waitFor(() => expect(c.getByLabelText('Backup')).toHaveValue(gone.userId));
    expect(within(c.getByLabelText('Backup')).getByRole('option', { name: 'Gale S. (suspended)' })).toBeInTheDocument();
    // not offered as a NEW owner
    expect(within(c.getByLabelText('Owner')).queryByRole('option', { name: /Gale S\./ })).toBeNull();
    // the stored switch is still on, and says so beside the state
    expect(c.getByRole('checkbox', { name: 'Covered' })).toBeChecked();
  });

  it('R-TEAMQ-24 E888 E889 (review fix L3): "What happens now" shows the server\'s own lines: who the backup alert goes to and the team\'s own time before a lead returns to the pond; a server that sends none shows no such list', async () => {
    const effects = [
      'The backup alert still fires: a new lead nobody has called, texted or emailed after 3 minutes of staffed time alerts the backup, Sam T.',
      'A lead with no first contact goes back to the pond after 45 minutes again, as on any source that is not covered.',
    ];
    const ownerOut = coverage({
      owner: { userId: gone.userId, name: 'Gale S.', status: 'suspended' },
      backup: { userId: ID.ava, name: 'Sam T.', status: 'active' },
      setting: true,
      covered: false,
      sentence: 'Not covered: the owner, Gale S., is suspended.',
      warnings: [{ code: 'OWNER_UNAVAILABLE', sentence: 'The owner, Gale S., is suspended. Nobody was put in their place: name another owner.' }],
      effects,
    });
    sourcesApp(fakeWith(ownerOut), page, 'owner');
    const c = await card();
    expect(within(c.getByRole('list', { name: 'What happens now' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(effects);
    // the page states no time of its own: 45 minutes is the server's, and "30 minutes" appears nowhere
    expect(c.queryByText(/30 minutes/)).toBeNull();
  });

  it('R-TEAMQ-24: no "What happens now" list without the server\'s lines', async () => {
    sourcesApp(fakeWith(NOT_COVERED), page, 'owner');
    const c = await card();
    expect(c.queryByRole('list', { name: 'What happens now' })).toBeNull();
  });

  it('R-TEAMQ-10: a refused save says why in words, never a code', async () => {
    const fake = fakeWith(NOT_COVERED).on(`PUT /lead-sources/${S1}/coverage`, err(422, 'VALIDATION_FAILED', { issues: [{ path: '/backupUserId', code: 'member_not_active' }] }));
    sourcesApp(fake, page, 'owner');
    const u = userEvent.setup();
    const c = await card();
    await waitFor(() => expect(within(c.getByLabelText('Owner')).getAllByRole('option').length).toBeGreaterThan(1));
    await u.selectOptions(c.getByLabelText('Owner'), ID.ava);
    await u.click(c.getByRole('button', { name: 'Save coverage' }));
    expect(await c.findByText('That member is suspended or no longer on the team. Pick someone who is active.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/VALIDATION_FAILED|member_not_active/);
    expect(coverageErrorSentence({ code: 'VALIDATION_FAILED', details: { issues: [{ code: 'coverage_needs_owner_and_backup' }] } })).toBe('Name an owner and a backup before turning coverage on.');
    expect(coverageErrorSentence({ code: 'VALIDATION_FAILED', details: { issues: [{ code: 'member_cannot_take_leads' }] } })).toBe('A transaction coordinator cannot be the owner or the backup of a lead source.');
    expect(coverageErrorSentence({ code: 'NOT_FOUND', details: null })).not.toMatch(/NOT_FOUND/);
  });

  it('memberOptions: active members who can take leads, by name, plus the person already named whatever their status', () => {
    expect(memberOptions(members.members, null).map((o) => o.label)).toEqual(['Jordan P. (Agent)', 'Sam T. (ISA)']);
    expect(memberOptions(members.members, { userId: gone.userId, name: 'Gale S.', status: 'suspended' }).map((o) => o.label)).toEqual(['Gale S. (suspended)', 'Jordan P. (Agent)', 'Sam T. (ISA)']);
    // a named member the list no longer returns is still shown, from the coverage itself
    expect(memberOptions([], { userId: 'x', name: null, status: 'removed' }).map((o) => o.label)).toEqual(['A member with no name (no longer on the team)']);
  });

  it('axe: the Coverage card has no accessibility violations (every control labelled, the list named)', async () => {
    sourcesApp(fakeWith(COVERED), page, 'owner');
    const c = await card();
    await waitFor(() => expect(c.getByLabelText('Backup')).toHaveValue(ID.ben));
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
