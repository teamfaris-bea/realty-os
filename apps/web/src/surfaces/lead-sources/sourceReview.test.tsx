// R-LSRC-10 W1, W2 (owner decision 2026-11-14; E748 to E751): the source review on the Lead sources page, the same list
// an import shows as its step. Loading, empty and error with a retry; a mapping applied only by an explicit button,
// changed and removed there (removal asks first and says what it stops); a failed action stays on its row with Try
// again; the password prompt when the server asks; the label limit in a plain sentence; no control for an Admin; and
// the review's own words. The rows carry the API's sentences (testing.tsx reviewSentence). Labels are made up.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { formatStamp } from '../admin/lib/format.js';
import { OWNER_MAPS_LABELS, changedWords } from './ImportLabels.js';
import { sentenceFor } from './messages.js';
import { IN_REVIEW_MEANS, REMOVE_WARNING, afterImportLine, beforeImportLine, choiceWords, mappingKey, provenanceWords, reviewCounts, rowKey, stateWords, stoppedWords } from './reviewWords.js';
import { type FakeFetch, err, labelRow, overview, source, sourcesApp, sourcesFake } from './testing.js';

const MARKED = { id: '01900000-0000-7000-8000-00000000528a', name: 'Northgate Referrals', noAiCare: true };
const OPEN = { id: '01900000-0000-7000-8000-00000000528b', name: 'Open houses' };
const IMPORT = '01900000-0000-7000-8000-0000000b0031';
const SOURCES = overview([source({ id: MARKED.id, name: MARKED.name, noAiCare: true, noAiCareSentence: 'on' }), source({ id: OPEN.id, name: OPEN.name })]);
const REAUTH_OK = { status: 200, body: { session: { user: { id: 'u', email: 'o@example.test', displayName: 'O' }, tenant: { id: 't', name: 'T', slug: 't', role: 'owner' }, tenants: [], mfa: { enabled: false, verified: false, enrollmentRequired: false }, reauthenticatedAt: new Date().toISOString(), csrfToken: 'c2' } } };

const flyer = labelRow('Sunday flyer', { people: 4, committedPeople: 4, id: 'r1', firstSeen: { importId: IMPORT, kind: 'csv', at: '2026-11-05T14:30:00.000Z' } });
const desk = labelRow('Northgate referral desk', { people: 2, committedPeople: 2, id: 'r2', mappedTo: MARKED, firstSeen: { importId: IMPORT, kind: 'fub_export', at: '2026-11-05T14:30:00.000Z' }, changedBy: { userId: 'u1', name: 'Olive Owner' }, changedAt: '2026-11-06T09:00:00.000Z' });
const blank = labelRow('', { unlabeledImportId: IMPORT, people: 3, committedPeople: 3, where: 'one file import' });

const section = async () => within(await screen.findByRole('region', { name: 'Review sources' }));
const row = (s: ReturnType<typeof within>, name: string) => within(s.getByRole('group', { name }));
const writes = (f: FakeFetch) => f.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/lead-sources/import-labels'));

function review(labels: () => unknown[], canChange = true, sources = SOURCES) {
  return sourcesFake(sources).on('GET /lead-sources/import-labels', () => ({ status: 200, body: { labels: labels(), canChange } }));
}

describe('R-LSRC-10 W2: the source review on the Lead sources page', () => {
  it('R-LSRC-10 E751: says it is loading, then that nothing was imported yet; it is shown even when the team has no lead source', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = sourcesFake(overview([])).on('GET /lead-sources/import-labels', async () => {
      await gate;
      return { status: 200, body: { labels: [], canChange: true } };
    });
    sourcesApp(f, '/admin/lead-sources', 'owner');
    const s = await section();
    expect(s.getByRole('heading', { level: 2, name: 'Review sources' })).toBeInTheDocument();
    expect(s.getByText('Loading the source review')).toBeInTheDocument();
    release();
    expect(await s.findByText('No imported source labels yet. When an import brings people in, their source labels are listed here for an Owner to review.')).toBeInTheDocument();
    expect(s.queryByText('Loading the source review')).toBeNull();
    expect(document.getElementById('review-sources')).not.toBeNull();
  });

  it('R-LSRC-10 E751: a failed load says so and offers Try again, which loads the list', async () => {
    let failing = true;
    const f = sourcesFake(SOURCES).on('GET /lead-sources/import-labels', () => (failing ? err(500, 'INTERNAL_ERROR') : { status: 200, body: { labels: [flyer], canChange: true } }));
    sourcesApp(f, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    const s = await section();
    expect(await s.findByText(/^The source review could not be loaded\./)).toBeInTheDocument();
    failing = false;
    await u.click(s.getByRole('button', { name: 'Try again' }));
    expect(await s.findByText(flyer.sentence)).toBeInTheDocument();
    expect(s.queryByRole('alert')).toBeNull();
  });

  it('R-LSRC-10 E748: with labels in review it says what that means for the people; every row says where it came from and who changed it; no raw code or state key is shown', async () => {
    sourcesApp(review(() => [flyer, desk, blank]), '/admin/lead-sources', 'owner');
    const s = await section();
    for (const r of [flyer, desk, blank]) expect(await s.findByText(r.sentence)).toBeInTheDocument();
    expect(s.getByText(IN_REVIEW_MEANS)).toBeInTheDocument();
    expect(row(s, 'Source label "Sunday flyer"').getByText(`First imported ${formatStamp('2026-11-05T14:30:00.000Z')} from a CSV file.`)).toBeInTheDocument();
    expect(row(s, 'Source label "Northgate referral desk"').getByText(`First imported ${formatStamp('2026-11-05T14:30:00.000Z')} from a Follow Up Boss export file. Mapping last changed by Olive Owner, ${formatStamp('2026-11-06T09:00:00.000Z')}.`)).toBeInTheDocument();
    expect(row(s, 'People imported with no source label').getByText('In review')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Review sources' }).textContent).not.toMatch(/SOURCE_|in_review|fub_export|csv\b/);
  });

  it('R-LSRC-10 E749: a mapping is applied by its button, never by the dropdown; it can be changed; removing it asks first, says what it stops, and can be backed out of', async () => {
    let labels = [flyer, desk];
    const f = review(() => labels);
    f.on('PUT /lead-sources/import-labels', (c) => {
      const body = c.body as { label: string; leadSourceId: string | null };
      const next = body.leadSourceId === null ? labelRow(body.label, { people: 2, committedPeople: 2, id: 'r2' }) : labelRow(body.label, { people: 2, committedPeople: 2, id: 'r2', mappedTo: body.leadSourceId === OPEN.id ? OPEN : MARKED });
      labels = labels.map((r) => (r.label === body.label ? next : r));
      return { status: 200, body: { label: next, pausing: body.leadSourceId === null ? 1 : 0, stopping: body.leadSourceId === null ? 1 : 0, withdrawn: body.leadSourceId === null ? 2 : 0 } };
    });
    sourcesApp(f, '/admin/lead-sources', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const s = await section();
    await s.findByText(desk.sentence);
    const r = () => row(s, 'Source label "Northgate referral desk"');
    const pick = await r().findByLabelText('Lead source for "Northgate referral desk"');
    // a mapped row shows its source in the dropdown; nothing offers to map it to itself
    expect(pick).toHaveValue(MARKED.id);
    expect(r().queryByRole('button', { name: /^(Map|Change) to/ })).toBeNull();
    // change: choose, then press
    await u.selectOptions(pick, OPEN.id);
    expect(writes(f)).toHaveLength(0);
    await u.click(r().getByRole('button', { name: 'Change to Open houses' }));
    await waitFor(() => expect(writes(f)).toHaveLength(1));
    expect(writes(f)[0]!.body).toEqual({ label: 'Northgate referral desk', leadSourceId: OPEN.id });
    await waitFor(() => expect(r().getByText('"Northgate referral desk" (2 people): mapped to Open houses.')).toBeInTheDocument());
    expect(r().getByText('Mapped')).toBeInTheDocument();
    // remove: asks first, and says what going back in review stops
    await u.click(r().getByRole('button', { name: 'Remove mapping' }));
    const ask = within(r().getByRole('group', { name: 'Remove the mapping to Open houses' }));
    expect(ask.getByText(REMOVE_WARNING)).toBeInTheDocument();
    expect(writes(f)).toHaveLength(1);
    await u.click(ask.getByRole('button', { name: 'Keep it' }));
    expect(r().queryByRole('group', { name: 'Remove the mapping to Open houses' })).toBeNull();
    expect(writes(f)).toHaveLength(1);
    await u.click(r().getByRole('button', { name: 'Remove mapping' }));
    await u.click(within(r().getByRole('group', { name: 'Remove the mapping to Open houses' })).getByRole('button', { name: 'Yes, remove it' }));
    await waitFor(() => expect(writes(f)).toHaveLength(2));
    expect(writes(f)[1]!.body).toEqual({ label: 'Northgate referral desk', leadSourceId: null });
    // the answer is the row's own sentence and what was stopped for these people: never "its leads" (no source is named)
    const said = await s.findByText(/not reviewed yet\..* AI care running for 1 of these people will pause\. 1 plan running for these people will stop\. 2 drafts a plan or an alert wrote for them were withdrawn\.$/);
    expect(said.textContent).not.toMatch(/its leads/);
    await waitFor(() => expect(r().getByText('In review')).toBeInTheDocument());
    expect(r().queryByRole('button', { name: 'Remove mapping' })).toBeNull();
  });

  it('R-LSRC-10 E751: a failed action stays on its row with what happened and Try again, which sends the same request', async () => {
    let labels = [flyer];
    let down = true;
    const after = labelRow('Sunday flyer', { people: 4, committedPeople: 4, id: 'r1', mappedTo: OPEN });
    const f = review(() => labels);
    f.on('PUT /lead-sources/import-labels', () => {
      if (down) return 'network-error';
      labels = [after];
      return { status: 200, body: { label: after, pausing: 0, stopping: 0, withdrawn: 0 } };
    });
    sourcesApp(f, '/admin/lead-sources', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const s = await section();
    await s.findByText(flyer.sentence);
    const r = () => row(s, 'Source label "Sunday flyer"');
    await u.selectOptions(await r().findByLabelText('Lead source for "Sunday flyer"'), OPEN.id);
    await u.click(r().getByRole('button', { name: 'Map to Open houses' }));
    expect(await r().findByText("Can't reach the server. Check your connection, then try again. Nothing was changed.")).toBeInTheDocument();
    // nothing claims it was mapped
    expect(r().getByText('In review')).toBeInTheDocument();
    down = false;
    await u.click(r().getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(r().getByText(after.sentence)).toBeInTheDocument());
    expect(writes(f).map((c) => c.body)).toEqual([{ label: 'Sunday flyer', leadSourceId: OPEN.id }, { label: 'Sunday flyer', leadSourceId: OPEN.id }]);
    expect(r().queryByRole('alert')).toBeNull();
  });

  it('R-LSRC-10 R-PERM-13 E751: when the server asks for the password, the prompt opens and the same change is sent again; closing the prompt changes nothing and says so', async () => {
    let labels = [labelRow(' open houses', { people: 3, committedPeople: 3, suggest: OPEN })];
    let authed = false;
    const done = labelRow(' open houses', { people: 3, committedPeople: 3, mappedTo: OPEN });
    const f = review(() => labels);
    f.on('POST /lead-sources/import-labels/confirm', () => {
      if (!authed) return err(401, 'REAUTH_REQUIRED');
      labels = [done];
      return { status: 200, body: { label: done, pausing: 0, stopping: 0, withdrawn: 0 } };
    });
    f.on('POST /auth/reauth', () => {
      authed = true;
      return REAUTH_OK;
    });
    sourcesApp(f, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    const s = await section();
    await s.findByRole('group', { name: 'Source label " open houses"' });
    const r = () => row(s, 'Source label " open houses"');
    await u.click(await r().findByRole('button', { name: 'Confirm Open houses' }));
    let dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await r().findByText('For your security, enter your password again to do this. Nothing was changed.')).toBeInTheDocument();
    await u.click(r().getByRole('button', { name: 'Try again' }));
    dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dialog).getByLabelText('Password'), 'pw');
    await u.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(r().getByText(done.sentence)).toBeInTheDocument());
    expect(f.callsTo('POST /lead-sources/import-labels/confirm').map((c) => c.body)).toEqual([
      { label: ' open houses', leadSourceId: OPEN.id },
      { label: ' open houses', leadSourceId: OPEN.id },
      { label: ' open houses', leadSourceId: OPEN.id },
    ]);
  });

  it('R-LSRC-10 E751 E742: a lead source that already holds 200 labels is said in a plain sentence, with the way out', async () => {
    const f = review(() => [flyer]);
    f.on('PUT /lead-sources/import-labels', err(422, 'VALIDATION_FAILED', { issues: [{ path: '/leadSourceId', code: 'lead_source_label_limit' }], limit: 200 }));
    sourcesApp(f, '/admin/lead-sources', 'owner', { reauthenticatedAt: new Date().toISOString() });
    const u = userEvent.setup();
    const s = await section();
    await s.findByText(flyer.sentence);
    const r = row(s, 'Source label "Sunday flyer"');
    await u.selectOptions(await r.findByLabelText('Lead source for "Sunday flyer"'), OPEN.id);
    await u.click(r.getByRole('button', { name: 'Map to Open houses' }));
    expect(await r.findByText('This lead source already holds 200 imported labels, the most one lead source can hold. Choose another lead source for this one. Nothing was changed.')).toBeInTheDocument();
    expect(sentenceFor({ code: 'VALIDATION_FAILED', details: { issues: [{ path: '/name', code: 'too_small' }] } })).not.toMatch(/200/);
  });

  it('R-LSRC-10 E751: an Admin reads the review and is told who maps; there is no dropdown and no button the server would refuse', async () => {
    const f = review(() => [flyer, desk, blank], false);
    sourcesApp(f, '/admin/lead-sources', 'admin');
    const s = await section();
    for (const r of [flyer, desk, blank]) expect(await s.findByText(r.sentence)).toBeInTheDocument();
    expect(s.getByText(OWNER_MAPS_LABELS)).toBeInTheDocument();
    expect(s.queryByRole('combobox')).toBeNull();
    expect(s.queryByRole('button')).toBeNull();
  });

  it('R-LSRC-10 E751: an Owner with no lead source yet is told to add one; nothing offers a choice that cannot be made', async () => {
    sourcesApp(review(() => [flyer], true, overview([])), '/admin/lead-sources', 'owner');
    const s = await section();
    expect(await s.findByText(/There is no lead source to choose yet\./)).toBeInTheDocument();
    expect(s.queryByRole('combobox')).toBeNull();
    expect(s.queryByRole('button', { name: /^Map to/ })).toBeNull();
  });

  it('R-LSRC-10 E749: the review has no axe violations, with a suggestion, a choice in progress and the removal question open; every control is reached by keyboard and named', async () => {
    const f = review(() => [labelRow(' open houses', { people: 3, committedPeople: 3, suggest: OPEN }), flyer, desk, blank]);
    sourcesApp(f, '/admin/lead-sources', 'owner');
    const u = userEvent.setup();
    const s = await section();
    await s.findByText(flyer.sentence);
    await u.selectOptions(await row(s, 'Source label "Sunday flyer"').findByLabelText('Lead source for "Sunday flyer"'), OPEN.id);
    await u.click(row(s, 'Source label "Northgate referral desk"').getByRole('button', { name: 'Remove mapping' }));
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    // keyboard: the controls of a row are plain buttons and a labelled select, in reading order
    const flyerRow = row(s, 'Source label "Sunday flyer"');
    const select = flyerRow.getByLabelText('Lead source for "Sunday flyer"');
    select.focus();
    await u.tab();
    expect(flyerRow.getByRole('button', { name: 'Map to Open houses' })).toHaveFocus();
    await u.tab();
    expect(flyerRow.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(select).toHaveAccessibleDescription('Choosing changes nothing until you press the button under it.');
  });
});

describe("R-LSRC-10: the review's own words", () => {
  it('the state chip says Mapped only of a mapped label; a suggestion and an ambiguous label are still in review', () => {
    expect(stateWords({ state: 'mapped', noAutomatedContact: false })).toEqual({ text: 'Mapped', tone: 'ok' });
    expect(stateWords({ state: 'mapped', noAutomatedContact: true }).text).toBe('Mapped · no automated contact');
    for (const state of ['suggested', 'ambiguous', 'in_review'] as const) {
      expect(stateWords({ state, noAutomatedContact: false }).text).toMatch(/^In review/);
      expect(stateWords({ state, noAutomatedContact: false }).text).not.toMatch(/Mapped/i);
    }
  });

  it('counts: what is still in review before the import (its people) and after it (the people it brought in)', () => {
    const rows = [labelRow('A', { people: 5, committedPeople: 2 }), labelRow('B', { people: 1, committedPeople: 1, suggest: OPEN }), labelRow('C', { people: 7, committedPeople: 7, mappedTo: OPEN }), labelRow('', { unlabeledImportId: IMPORT, people: 2, committedPeople: 0 })];
    expect(reviewCounts(rows)).toEqual({ labels: 2, blank: true, people: 8, committed: 3, mappedRows: 1 });
    expect(beforeImportLine(rows)).toBe('Still in review: 2 labels and the people with no source label (8 people). You can run the import with these left in review.');
    expect(afterImportLine(rows)).toBe('Still in review after this import: 2 labels and the people with no source label (3 people imported).');
    expect(beforeImportLine([labelRow('A', { people: 1 })])).toBe('Still in review: 1 label (1 person). You can run the import with these left in review.');
    expect(beforeImportLine([labelRow('', { unlabeledImportId: IMPORT, people: 3 })])).toBe('Still in review: the people with no source label (3 people). You can run the import with these left in review.');
    expect(afterImportLine([labelRow('A', { people: 1, committedPeople: 1, state: 'ambiguous' })])).toBe('Still in review after this import: 1 label (1 person imported).');
    expect(beforeImportLine([])).toBe('Every source in this import is mapped to a lead source.');
  });

  it('what a change stopped is worded by what the row is now: a marked source\'s own leads, or "these people" when no source is involved', () => {
    const counts = { pausing: 2, stopping: 1, withdrawn: 1 };
    expect(stoppedWords(counts)).toBe(' AI care running for 2 of these people will pause. 1 plan running for these people will stop. 1 draft a plan or an alert wrote for them was withdrawn.');
    expect(stoppedWords({ pausing: 0, stopping: 3 })).toBe(' 3 plans running for these people will stop.');
    expect(stoppedWords({})).toBe('');
    const back = labelRow('A', { people: 2, committedPeople: 2 });
    expect(changedWords({ label: back, ...counts })).toBe(`${back.sentence}${stoppedWords(counts)}`);
    const marked = labelRow('A', { people: 2, committedPeople: 2, mappedTo: MARKED });
    expect(changedWords({ label: marked, ...counts })).toMatch(/of its leads will pause\. 1 plan running for its leads will stop\./);
    // an unmarked mapping can still leave someone stopped (another of their sources is in review): never "its leads"
    expect(changedWords({ label: labelRow('A', { mappedTo: OPEN }), ...counts })).not.toMatch(/its leads/);
  });

  it('a choice says what applying it will do, and neither sentence promises that anything restarts', () => {
    expect(choiceWords({ name: 'Open houses' })).toBe('The people imported with this will count as leads of Open houses. If none of their other imported sources is still in review or marked, automated contact is allowed for them again. A plan that already stopped stays stopped.');
    expect(choiceWords({ name: 'Northgate Referrals', noAiCare: true })).toMatch(/nothing automatic will go to the people imported with this, and plans running for them stop\.$/);
    expect(REMOVE_WARNING).toMatch(/go back in review: nothing automatic goes to them.*None of that starts again on its own/);
  });

  it('provenance and keys: a label seen only in a preview says so; the no-label group is keyed and mapped by its import, a label by itself exactly', () => {
    expect(provenanceWords({ firstSeen: null, changedBy: null, changedAt: null })).toBe('Not imported yet: seen in a preview only.');
    expect(provenanceWords({ firstSeen: { importId: IMPORT, kind: 'fub_api', at: '2026-11-05T14:30:00.000Z' }, changedBy: null, changedAt: null })).toBe(`First imported ${formatStamp('2026-11-05T14:30:00.000Z')} from Follow Up Boss.`);
    expect(mappingKey({ label: '', unlabeledImportId: IMPORT })).toEqual({ unlabeledImportId: IMPORT });
    expect(mappingKey({ label: ' Open House ', unlabeledImportId: null })).toEqual({ label: ' Open House ' });
    expect(rowKey({ label: 'a', unlabeledImportId: null })).not.toBe(rowKey({ label: 'A', unlabeledImportId: null }));
    expect(rowKey({ label: '', unlabeledImportId: IMPORT })).toBe(`import:${IMPORT}`);
  });
});
