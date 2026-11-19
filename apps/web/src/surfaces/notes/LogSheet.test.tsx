// The Log sheet with the stage step in place (b19 fix pass M6; E775): Log → outcome → ONE button is 3 taps to a saved
// log AND a confirmed stage. Choosing an outcome reveals the stage step in the same sheet; the one primary button
// saves the log (with its client id) and then the stage; when the stage change fails after the log saved, the sheet
// says exactly what was saved and what was not, the button stays enabled, and a retry makes no second note.
// jsdom against a scripted API (the taps inside the sheet are counted here; the bar's Log tap is the third, counted
// in contact/StageFlow.test.tsx and, against the real API, in e2e/journeys/j10 and e2e/people/people.spec.ts).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../shell/index.js';
import { ShellProvider } from '../../shell/context.js';
import { FakeFetch, type Reply, err, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import type { Details } from '../people-edit/api.js';
import { ToastProvider } from '../people-edit/hooks.js';
import type { StagePreview, StageResponse } from '../people-edit/stageFlow.js';
import { detailsFixture, fakeTaskStore, guideFixture, stageFixture } from '../people-edit/testing.js';
import { LogSheet, whenPresets } from './LogSheet.js';

const C = '01900000-0000-7000-8000-0000000c0001';
const EV = '01900000-0000-7000-8000-0000000e0002';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const preview = (over: Partial<StagePreview> = {}): StagePreview => ({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged', ...over });

/** POST /contacts/:id/activities as the API answers it: one note per noteId, a repeat is `replayed` and writes nothing. */
function fakeLog(fake: FakeFetch, o: { lose?: (n: number) => boolean; fail?: (n: number) => Reply | null; suggestDoNotContact?: boolean } = {}) {
  const notes = new Map<string, unknown>();
  fake.on(`POST /contacts/${C}/activities`, (call, n) => {
    const refused = o.fail?.(n);
    if (refused) return refused;
    const b = call.body as { noteId: string; remindInDays?: number };
    const replayed = notes.has(b.noteId);
    if (!replayed) notes.set(b.noteId, call.body);
    if (o.lose?.(n)) return 'network-error';
    // the reminder is the FIRST save's: a replay answers that task (or none), whatever the retried body asks (E790)
    const first = notes.get(b.noteId) as { remindInDays?: number };
    return { status: replayed ? 200 : 201, body: { note: { id: b.noteId }, taskId: first.remindInDays ? '01900000-0000-7000-8000-00000000d001' : null, suggestDoNotContact: o.suggestDoNotContact ?? false, suggestedStage: null, replayed } };
  });
  return notes;
}

function mount(o: { details?: Details; stage?: (n: number) => Reply | null; log?: Parameters<typeof fakeLog>[1]; previews?: Record<string, StagePreview> } = {}) {
  const details = o.details ?? detailsFixture(C, 'new');
  const fake = new FakeFetch().on('GET /auth/session', { status: 200, body: sessionFixture() }).on(`GET /contacts/${C}/details`, { status: 200, body: { details } });
  for (const s of guideFixture()) fake.on(`GET /contacts/${C}/stage/preview?to=${s.key}`, { status: 200, body: o.previews?.[s.key] ?? preview({ sameStage: s.key === details.stage.stage }) });
  fake.on(`POST /contacts/${C}/stage`, (call, n) => {
    const scripted = o.stage?.(n);
    if (scripted) return scripted;
    const to = (call.body as { stage: string }).stage;
    return { status: 200, body: { stage: stageFixture(to), previousStage: details.stage.stage, rowVersion: 2, eventId: EV, automation: null, stillRunning: null } satisfies StageResponse };
  });
  fake.on(`POST /contacts/${C}/do-not-contact`, { status: 200, body: { doNotContact: true, alreadySet: false, revokedPoints: 1 } });
  const notes = fakeLog(fake, o.log);
  const tasks = fakeTaskStore(fake);
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={qc}>
      <ShellProvider api={new ApiClient({ fetch: fake.fetch })} table={tableWith()}>
        <MemoryRouter>
          <ToastProvider>
            <LogSheet contactId={C} contactName="Dana Reyes" onClose={onClose} />
          </ToastProvider>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
  );
  // every tap is counted: a click that is not through this counter does not exist in these tests
  const u = userEvent.setup();
  const n = { taps: 0 };
  const tap = async (el: HTMLElement) => {
    await u.click(el);
    n.taps += 1;
  };
  return { fake, notes, tasks, onClose, u, n, tap };
}

const sheet = () => screen.findByRole('dialog', { name: 'Log for Dana Reyes' });
const logPosts = (fake: FakeFetch) => fake.callsTo(`POST /contacts/${C}/activities`);
const stagePosts = (fake: FakeFetch) => fake.callsTo(`POST /contacts/${C}/stage`);
const toast = () => screen.getByTestId('people-toast');
const primary = (s: HTMLElement) => within(s).getByTestId('log-save');

describe('M6 (E775): Log → outcome → one button saves the log and confirms the stage', () => {
  it('choosing an outcome reveals the stage step in place (same sheet, the suggestion from core\'s table, preselected); ONE button saves the log and the stage: 2 taps in the sheet, 3 with the bar\'s Log', async () => {
    const { fake, notes, onClose, n, tap } = mount();
    const s = await sheet();
    // before an outcome: the log's own fields and a plain Save; no stage is asked about
    expect(primary(s)).toHaveTextContent(/^Save$/);
    expect(within(s).queryByRole('radiogroup', { name: 'Stage' })).toBeNull();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    // the same dialog, now with the stage step: nothing was saved by choosing
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const group = await within(s).findByRole('radiogroup', { name: 'Stage' });
    const suggested = within(group).getByRole('radio', { name: 'Trying to reach Suggested' });
    expect(suggested).toBeChecked();
    expect(suggested).toHaveAccessibleDescription(/We tried to reach them but have not had a two-way conversation yet\..*You left a voicemail\. That is a try, not a conversation yet\./);
    expect(within(group).getByRole('radio', { name: 'Keep New lead' })).toBeInTheDocument();
    expect(within(s).getByTestId('log-summary')).toHaveTextContent('To log: Call · I called from my phone · Left voicemail');
    expect(logPosts(fake)).toHaveLength(0);
    expect(stagePosts(fake)).toHaveLength(0);
    await waitFor(() => expect(within(s).getByTestId('stage-step-effect')).toHaveTextContent('No plan starts on this stage.'));
    expect(primary(s)).toHaveTextContent(/^Save and change to Trying to reach$/);
    expect(primary(s)).toHaveAccessibleDescription('No plan starts on this stage.');
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(n.taps, 'outcome, then the one button').toBe(2);
    // the log first, then the stage; each once
    expect(logPosts(fake).map((c) => c.body)).toEqual([expect.objectContaining({ kind: 'call', direction: 'outbound', outcome: 'left_voicemail', noteId: expect.stringMatching(UUID) })]);
    expect(stagePosts(fake).map((c) => c.body)).toEqual([{ stage: 'attempting' }]);
    expect(fake.calls.findIndex((c) => c.path.endsWith('/activities'))).toBeLessThan(fake.calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/stage')));
    expect(notes.size).toBe(1);
    // said once, in the one toast after the sheet closed
    expect(await within(toast()).findByText('Call logged (left voicemail). Stage: Trying to reach')).toBeInTheDocument();
    expect(screen.getAllByTestId('people-toast')).toHaveLength(1);
  });

  it('"Keep <current>": the button is "Save and keep New lead"; the log is saved and no stage request is sent', async () => {
    const { fake, onClose, tap } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'No answer' }));
    await tap(await within(s).findByRole('radio', { name: 'Keep New lead' }));
    expect(primary(s)).toHaveTextContent(/^Save and keep New lead$/);
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(logPosts(fake)).toHaveLength(1);
    expect(stagePosts(fake)).toHaveLength(0);
    expect(await within(toast()).findByText('Call logged (no answer)')).toBeInTheDocument();
  });

  it('a conversation offers "Long-term follow-up" beside "Connected", and the plan that will start is said once, above the follow-up', async () => {
    const { tap } = mount({ details: detailsFixture(C, 'attempting'), previews: { connected: preview({ starts: { plan: 'Stay in touch', firstStep: null } }) } });
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Talked' }));
    const group = await within(s).findByRole('radiogroup', { name: 'Stage' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(within(group).getByRole('radio', { name: 'Long-term follow-up' })).toBeInTheDocument();
    await waitFor(() => expect(within(s).getByTestId('stage-step-effect')).toHaveTextContent('Will start: Stay in touch. No message is due from it yet.'));
    expect(within(s).getAllByText(/Will start: Stay in touch/)).toHaveLength(1);
    expect(primary(s)).toHaveTextContent(/^Save and change to Connected$/);
  });

  it('the log saved and the stage change then failed: the sheet says exactly what was saved and what was not, the button stays enabled, and the retry makes no second note', async () => {
    const { fake, notes, onClose, tap } = mount({ stage: (n) => (n === 1 ? err(422, 'STAGE_NEEDS_CONTACT') : null) });
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    const alert = await within(s).findByRole('alert');
    expect(alert).toHaveTextContent('Call logged (left voicemail). The stage did not change: Reach them first (a call, text, email or reply in their website chat), or close the lead.');
    expect(onClose).not.toHaveBeenCalled();
    // what was logged is now a fact, in place of the fields; no toast claims anything
    expect(within(s).getByRole('status')).toHaveTextContent('Call logged (left voicemail)');
    expect(within(s).queryByRole('group', { name: 'Outcome' })).toBeNull();
    expect(within(s).queryByLabelText('Note (optional)')).toBeNull();
    expect(toast().textContent).toBe('');
    // the button is named for what is left to do, and is still enabled
    expect(primary(s)).toHaveTextContent(/^Change to Trying to reach$/);
    expect(primary(s)).toBeEnabled();
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(logPosts(fake)).toHaveLength(1);
    expect(notes.size).toBe(1);
    expect(stagePosts(fake)).toHaveLength(2);
    expect(await within(toast()).findByText('Call logged (left voicemail). Stage: Trying to reach')).toBeInTheDocument();
  });

  it('a lost answer to the stage change is not called a refusal: "We could not confirm the stage change", and the same button asks again', async () => {
    const { fake, onClose, tap } = mount({ stage: (n) => (n === 1 ? 'network-error' : null) });
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    expect(await within(s).findByRole('alert')).toHaveTextContent("Call logged (left voicemail). We could not confirm the stage change: Can't reach the server. Check your connection, then try again.");
    expect(within(s).queryByText(/The stage did not change/)).toBeNull();
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(logPosts(fake)).toHaveLength(1);
  });

  it('the log itself fails: nothing is claimed, the fields stay, and the retry sends the same noteId (one note)', async () => {
    const { fake, notes, onClose, tap } = mount({ log: { lose: (n) => n === 1 } });
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'No answer' }));
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    expect(await within(s).findByRole('alert')).toHaveTextContent("Can't reach the server. Check your connection, then try again.");
    expect(within(s).queryByRole('status')).toBeNull();
    expect(stagePosts(fake)).toHaveLength(0);
    expect(primary(s)).toHaveTextContent(/^Save and change to Trying to reach$/);
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const ids = logPosts(fake).map((c) => (c.body as { noteId: string }).noteId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(notes.size).toBe(1);
    expect(stagePosts(fake)).toHaveLength(1);
    // the replay is said as what it is
    expect(await within(toast()).findByText('Call logged (no answer). Your first tap had already saved it, as first written. Stage: Trying to reach')).toBeInTheDocument();
  });

  it('a double tap on the one button: one note, one stage change', async () => {
    const { fake, notes, onClose, u } = mount();
    const s = await sheet();
    await u.click(within(s).getByRole('button', { name: 'Left voicemail' }));
    await waitFor(() => expect(primary(s)).toBeEnabled());
    // two taps in the same frame (neither waits for the other), then a third after everything was saved
    primary(s).click();
    primary(s).click();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    primary(s).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(logPosts(fake)).toHaveLength(1);
    expect(notes.size).toBe(1);
    expect(stagePosts(fake)).toHaveLength(1);
  });

  it('a follow-up chip: the log, then the task, then the stage; the toast says the stored task\'s date', async () => {
    const { fake, tasks, onClose, tap } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    await tap(await within(s).findByRole('button', { name: 'Tomorrow' }));
    expect(primary(s)).toHaveTextContent(/^Save and change to Trying to reach \+ follow-up$/);
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fake.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/contacts/${C}/activities`, '/tasks', `/contacts/${C}/stage`]);
    expect(tasks.open()).toHaveLength(1);
    expect(toast().textContent).toMatch(/^Call logged \(left voicemail\)\. Stage: Trying to reach\. Follow-up saved for .+9:00 AM/);
  });

  it('L12 (E790): one follow-up per log. With "Remind me" set, the stage step offers no second follow-up (it says the reminder is saved with the log) and no task request is sent beside the log', async () => {
    const { fake, tasks, onClose, tap, u } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    await within(s).findByRole('group', { name: 'Follow-up' });
    await u.selectOptions(within(s).getByLabelText('Remind me'), '2');
    expect(within(s).queryByRole('group', { name: 'Follow-up' })).toBeNull();
    expect(within(s).getByTestId('follow-up-line')).toHaveTextContent('Follow-up: the reminder in 2 days, saved with this log.');
    expect(primary(s)).toHaveTextContent(/^Save and change to Trying to reach$/);
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(logPosts(fake)[0]!.body).toMatchObject({ remindInDays: 2 });
    expect(fake.callsTo('POST /tasks')).toHaveLength(0);
    expect(tasks.open()).toHaveLength(0);
    expect(await within(toast()).findByText('Call logged, reminder in 2 days (left voicemail). Stage: Trying to reach')).toBeInTheDocument();
  });

  it('L12 (E790): with a follow-up chosen in the stage step, "Remind me" is off and says why; the log is sent without a reminder and ONE task is made', async () => {
    const { fake, tasks, onClose, tap } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    await tap(await within(s).findByRole('button', { name: '3 days' }));
    const remind = within(s).getByLabelText('Remind me');
    expect(remind).toBeDisabled();
    expect(remind).toHaveAccessibleDescription('A follow-up is already set above: one task per log.');
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(logPosts(fake)[0]!.body).not.toHaveProperty('remindInDays');
    expect(fake.callsTo('POST /tasks')).toHaveLength(1);
    expect(tasks.open()).toHaveLength(1);
  });

  it('L12 (E790): a replayed log that had a reminder still says so (the server answers the first save\'s task), without inventing how many days', async () => {
    // the first save stored the note and its reminder; its answer was lost; meanwhile the select was changed
    const { onClose, tap, u } = mount({ log: { lose: (n) => n === 1 } });
    const s = await sheet();
    await u.selectOptions(within(s).getByLabelText('Remind me'), '2');
    await tap(primary(s));
    expect(await within(s).findByRole('alert')).toHaveTextContent("Can't reach the server.");
    await u.selectOptions(within(s).getByLabelText('Remind me'), '14');
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const said = toast().textContent ?? '';
    expect(said).toBe('Call logged, with the reminder set the first time. Your first tap had already saved it, as first written');
    expect(said).not.toMatch(/14 days|2 days/);
  });

  it('a call with no outcome suggests nothing: no stage step, the button is "Save", and the sheet closes with the one toast', async () => {
    const { fake, onClose, tap } = mount();
    const s = await sheet();
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(logPosts(fake)).toHaveLength(1);
    expect(logPosts(fake)[0]!.body).not.toHaveProperty('outcome');
    expect(stagePosts(fake)).toHaveLength(0);
    expect(fake.calls.filter((c) => c.path.includes('/stage/preview'))).toHaveLength(0);
    expect(await within(toast()).findByText('Call logged')).toBeInTheDocument();
  });

  it('"Edit" brings the choices back with the outcome still chosen; choosing again folds them', async () => {
    const { tap } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    await within(s).findByRole('radiogroup', { name: 'Stage' });
    expect(within(s).queryByRole('group', { name: 'Outcome' })).toBeNull();
    await tap(within(s).getByRole('button', { name: 'Edit what happened' }));
    expect(within(within(s).getByRole('group', { name: 'Outcome' })).getByRole('button', { name: 'Left voicemail' })).toHaveAttribute('aria-pressed', 'true');
    await tap(within(s).getByRole('button', { name: 'Talked' }));
    expect(within(s).getByTestId('log-summary')).toHaveTextContent('To log: Call · I called from my phone · Talked');
    expect(await within(s).findByRole('radio', { name: 'Connected Suggested' })).toBeChecked();
  });

  it('R-TODAY-9: "when" is now by default, and earlier today is one tap ("An hour ago"); the save carries that time, and the exact time stays editable', async () => {
    const { fake, tap } = mount();
    const s = await sheet();
    const quick = within(s).getByRole('group', { name: 'When, quickly' });
    expect(within(quick).getByRole('button', { name: 'Just now' })).toHaveAttribute('aria-pressed', 'true');
    const before = new Date((within(s).getByLabelText('When') as HTMLInputElement).value).getTime();
    const hour = within(quick).queryByRole('button', { name: 'An hour ago' });
    // (in the first hour after midnight an hour ago was yesterday, and the chip is not offered: nothing to assert then)
    if (hour) {
      await tap(hour);
      expect(hour).toHaveAttribute('aria-pressed', 'true');
      const after = new Date((within(s).getByLabelText('When') as HTMLInputElement).value).getTime();
      // an hour back (59 minutes when the minute turned between the sheet opening and the tap)
      expect([3_600_000, 3_540_000]).toContain(before - after);
      await tap(within(s).getByRole('button', { name: 'No answer' }));
      const save = primary(s);
      await waitFor(() => expect(save).toBeEnabled());
      await tap(save);
      await waitFor(() => expect(logPosts(fake)).toHaveLength(1));
      expect(Date.parse((logPosts(fake)[0]!.body as { at: string }).at)).toBe(after);
    }
  });

  it('R-TODAY-9 E852: left at "Just now", the log carries the instant of the save, to the second (not the minute the sheet opened)', async () => {
    const { fake, tap } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'No answer' }));
    const save = primary(s);
    await waitFor(() => expect(save).toBeEnabled());
    const before = Date.now();
    await tap(save);
    await waitFor(() => expect(logPosts(fake)).toHaveLength(1));
    const at = Date.parse((logPosts(fake)[0]!.body as { at: string }).at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('R-TODAY-9: the quick times are all today and never ahead: now; an hour ago unless that was yesterday; this morning once it is past 10', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m, 0, 0);
    const keys = (d: Date) => whenPresets(d).map((p) => p.key);
    expect(keys(at(14, 30))).toEqual(['now', 'hour', 'morning']);
    expect(keys(at(9, 30))).toEqual(['now', 'hour']);
    expect(keys(at(10, 0))).toEqual(['now', 'hour']);
    expect(keys(at(10, 1))).toEqual(['now', 'hour', 'morning']);
    expect(keys(at(0, 20))).toEqual(['now']);
    for (const p of whenPresets(at(14, 30))) {
      expect(p.at.getTime()).toBeLessThanOrEqual(at(14, 30).getTime());
      expect(p.at.getDate()).toBe(19);
    }
    expect(whenPresets(at(14, 30)).find((p) => p.key === 'morning')!.at.getHours()).toBe(9);
  });

  it('a text or an email is its own outcome: the stage step shows at once, and an incoming one is their reply', async () => {
    const { tap } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Text' }));
    expect(await within(s).findByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked();
    // (R-TODAY-9: the direction says what it was: "I texted from my phone" / "Dana texted me")
    expect(within(s).getByRole('button', { name: 'I texted from my phone', pressed: true })).toBeInTheDocument();
    await tap(within(s).getByRole('button', { name: 'Dana texted me' }));
    expect(await within(s).findByRole('radio', { name: 'Connected Suggested' })).toBeChecked();
    expect(primary(s)).toHaveTextContent(/^Save and change to Connected$/);
  });

  it('someone who may not edit the person: no stage control, the button is "Save", and the sheet says the stage stays', async () => {
    const { fake, onClose, tap } = mount({ details: detailsFixture(C, 'new', { canEdit: false }) });
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Left voicemail' }));
    expect(await within(s).findByText('The stage stays New lead. Only someone who can edit this person changes it.')).toBeInTheDocument();
    expect(within(s).queryByRole('radiogroup')).toBeNull();
    expect(primary(s)).toHaveTextContent(/^Save$/);
    await tap(primary(s));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(stagePosts(fake)).toHaveLength(0);
  });

  it('the server says the note reads like "do not contact": the stage is NOT changed by that tap; "No" comes back to the saved log with the stage still to confirm', async () => {
    const { fake, onClose, tap, u } = mount({ log: { suggestDoNotContact: true } });
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'Talked' }));
    await u.type(within(s).getByLabelText('Note (optional)'), 'She said stop calling');
    await waitFor(() => expect(primary(s)).toBeEnabled());
    await tap(primary(s));
    const ask = await screen.findByRole('dialog', { name: 'Did Dana ask not to be contacted?' });
    expect(ask).toHaveAccessibleDescription('Your note was saved, and the stage was not changed. A note alone doesn’t stop anything from being sent.');
    expect(stagePosts(fake)).toHaveLength(0);
    await tap(within(ask).getByRole('button', { name: 'No' }));
    const back = await sheet();
    expect(within(back).getByRole('status')).toHaveTextContent('Call logged (talked)');
    expect(onClose).not.toHaveBeenCalled();
    expect(primary(back)).toHaveTextContent(/^Change to Connected$/);
    await tap(primary(back));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(logPosts(fake)).toHaveLength(1);
    expect(stagePosts(fake).map((c) => c.body)).toEqual([{ stage: 'connected' }]);
  });

  it('"They asked not to be contacted…" before anything is saved does not say a note was saved; "No" returns to the form', async () => {
    const { fake, tap } = mount();
    const s = await sheet();
    await tap(within(s).getByRole('button', { name: 'They asked not to be contacted…' }));
    const ask = await screen.findByRole('dialog', { name: 'Did Dana ask not to be contacted?' });
    expect(ask).toHaveAccessibleDescription('A note alone doesn’t stop anything from being sent.');
    await tap(within(ask).getByRole('button', { name: 'No' }));
    expect(await sheet()).toBeInTheDocument();
    expect(logPosts(fake)).toHaveLength(0);
  });
});
