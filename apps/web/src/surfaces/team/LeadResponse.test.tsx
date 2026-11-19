// The lead response report on the scoreboard page, in jsdom against a scripted API with the real app shell (b19
// team-queue lane; DATA_MODEL R-TEAMQ-7..9). The numbers and who may read them are the server's
// (api/accountability/leadResponse.test.ts proves them against Postgres); these tests prove the display half: the
// section says "from arrival" and how it differs from speed to lead, every count shows its denominator, the
// inquiries not within 5 minutes are listed under their source with who tried and in what role, an automatic reply
// is shown apart and never as an attempt, and no percentile is shown on a small sample. Invented people only.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { ID, FakeFetch, board, err, leadAdminApp } from '../admin/lib/testing.js';
import { type LeadResponseReport, type ResponseInquiry, type ResponseRollup, responseFootnotes, responseLines } from './lib.js';

const range = (key: string, days = 7) => ({ key, from: '2026-11-03T08:00:00.000Z', to: '2026-11-10T08:00:00.000Z', days, zone: 'America/Los_Angeles' });
const momentum = { rule: { factor: 1.5, minSample: 5, windowDays: 180 }, norms: [], agents: [], generatedAt: new Date().toISOString() };
const SRC = { web: '01900000-0000-7000-8000-00000000a001', sign: '01900000-0000-7000-8000-00000000a002' };
const P = { wren: '01900000-0000-7000-8000-0000000000d1', sol: '01900000-0000-7000-8000-0000000000d2', nia: '01900000-0000-7000-8000-0000000000d3' };

const rollup = (o: Partial<ResponseRollup> = {}): ResponseRollup => ({ inquiries: 9, attempted: 7, within5: 5, within15: 6, waiting: 2, automatedReplies: 6, sample: 7, medianStaffedSeconds: 240, p90StaffedSeconds: null, ...o });
const inquiry = (o: Partial<ResponseInquiry> = {}): ResponseInquiry => ({
  inquiryId: '01900000-0000-7000-8000-0000000000e1',
  contact: { id: P.wren, name: 'Wren Waiting' },
  sourceId: SRC.web,
  sourceName: 'Website form',
  arrivedAt: '2026-11-09T18:00:00.000Z',
  offHours: false,
  countedFrom: '2026-11-09T18:00:00.000Z',
  attempt: null,
  waiting: { wallSeconds: 7200, staffedSeconds: 7200 },
  automatedReplyAt: '2026-11-09T18:01:00.000Z',
  within5: false,
  within15: false,
  ...o,
});
const slow = inquiry({
  inquiryId: '01900000-0000-7000-8000-0000000000e2',
  contact: { id: P.sol, name: 'Sol Slow' },
  attempt: { at: '2026-11-09T18:22:00.000Z', kind: 'call', by: { userId: ID.ben, name: 'Ben Agent' }, role: 'other', wallSeconds: 1320, staffedSeconds: 1320 },
  waiting: null,
  automatedReplyAt: null,
});

function report(o: Partial<LeadResponseReport> = {}): LeadResponseReport {
  return {
    range: range('7d') as LeadResponseReport['range'],
    staffedHours: { open: '08:00', close: '21:00', zone: 'America/Los_Angeles' },
    rules: { within5Seconds: 300, within15Seconds: 900, medianMinSample: 5, p90MinSample: 10 },
    totals: rollup({ inquiries: 12, attempted: 10, within5: 8, within15: 9, waiting: 2, automatedReplies: 7, sample: 10, medianStaffedSeconds: 200, p90StaffedSeconds: 1320 }),
    sources: [
      { sourceId: SRC.web, sourceName: 'Website form', ...rollup(), notWithin5: [inquiry(), slow], notWithin5More: 2 },
      { sourceId: SRC.sign, sourceName: 'Open house sign-in', ...rollup({ inquiries: 3, attempted: 3, within5: 3, within15: 3, waiting: 0, automatedReplies: 1, sample: 3, medianStaffedSeconds: null }), notWithin5: [], notWithin5More: 0 },
    ],
    inquiries: [],
    inquiriesMore: 0,
    imports: { people: 38 },
    closedExcluded: 1,
    truncated: false,
    generatedAt: new Date().toISOString(),
    ...o,
  };
}

function fake(r: LeadResponseReport | { status: number; body?: unknown } = report(), key = '7d') {
  return new FakeFetch()
    .on(`GET /team/scoreboard?range=${key}`, { status: 200, body: { range: range(key), members: [board()] } })
    .on('GET /team/momentum', { status: 200, body: momentum })
    .on(`GET /team/lead-response?range=${key}`, 'status' in r ? r : { status: 200, body: r });
}

const section = () => screen.findByRole('region', { name: 'Lead response, from arrival' });

describe('Lead response report', () => {
  it('R-TEAMQ-9: the section is labelled "from arrival" and says in one line how it differs from speed to lead, which starts when an agent accepts', async () => {
    leadAdminApp(fake(), '/team/scoreboard', 'team_lead');
    const region = await section();
    expect(within(region).getByText('From arrival: the clock starts when a lead arrives and stops at the first call, text, email or chat reply a person makes, whoever makes it. Speed to lead above starts only when an agent accepts the lead.')).toBeInTheDocument();
    // the existing scoreboard is still there, above it
    const table = await screen.findByRole('table');
    expect(table.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(table).getByRole('row', { name: /Ava Agent/ }).textContent).toContain('12 of 14 within the first-touch window');
  });

  it('R-TEAMQ-8 R-ACC-4: every count shows its denominator, by source and in total', async () => {
    leadAdminApp(fake(), '/team/scoreboard', 'team_lead');
    const region = await section();
    const web = (await within(region).findByRole('heading', { level: 3, name: 'Website form' })).closest('li')!;
    for (const text of ['9 inquiries', '7 of 9', '5 of 9', '6 of 9', '2 of 9', '4 min (of 7 attempts)', 'Not shown: 7 of the 10 attempts it needs', '6 of 9, shown apart and never counted as an attempt']) {
      expect(within(web).getByText(text)).toBeInTheDocument();
    }
    expect(within(web).getByText('Within 5 minutes').nextElementSibling).toHaveTextContent('5 of 9');
    const all = within(region).getByRole('heading', { level: 3, name: 'All sources' }).closest('div')!;
    expect(within(all).getByText('8 of 12')).toBeInTheDocument();
    expect(within(all).getByText('22 min (of 10 attempts)')).toBeInTheDocument();
  });

  it('R-TEAMQ-8 E831: a percentile is not shown on a small sample; the sample size is', async () => {
    leadAdminApp(fake(), '/team/scoreboard', 'owner');
    const region = await section();
    const sign = (await within(region).findByRole('heading', { level: 3, name: 'Open house sign-in' })).closest('li')!;
    expect(within(sign).getByText('Not shown: 3 of the 5 attempts it needs')).toBeInTheDocument();
    expect(within(sign).getByText('Not shown: 3 of the 10 attempts it needs')).toBeInTheDocument();
    expect(within(sign).queryByText(/min \(of 3 attempts\)/)).toBeNull();
  });

  it('R-TEAMQ-7 E827 E828: the inquiries not within 5 minutes are listed under their source: still waiting with the automatic reply apart, or who tried, how, in what role and after how long', async () => {
    leadAdminApp(fake(), '/team/scoreboard', 'team_lead');
    const region = await section();
    const web = (await within(region).findByRole('heading', { level: 3, name: 'Website form' })).closest('li')!;
    const list = within(web).getByRole('list', { name: 'Not within 5 minutes, Website form' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'Wren Waiting' })).toHaveAttribute('href', `/contacts/${P.wren}`);
    expect(rows[0]!).toHaveTextContent(/Still waiting after 2 h\. No person has tried yet\. An automatic reply went out .*; it is not counted\./);
    expect(within(rows[1]!).getByRole('link', { name: 'Sol Slow' })).toHaveAttribute('href', `/contacts/${P.sol}`);
    expect(rows[1]!).toHaveTextContent('First tried after 22 min: a call by Ben Agent, who was not the owner. No automatic reply went out.');
    expect(within(web).getByText('4 not within 5 minutes. 2 more are not listed.')).toBeInTheDocument();
  });

  it('R-TEAMQ-27 E893 (review fix L6): a first attempt whose text failed is still shown as the attempt, and says "Tried, but the text failed"; the source counts failed attempts of its attempts', async () => {
    const failed = inquiry({ contact: { id: P.nia, name: 'Nia Night' }, inquiryId: '01900000-0000-7000-8000-0000000000eb', attempt: { at: '2026-11-09T18:09:00.000Z', kind: 'text', by: { userId: ID.ben, name: 'Ben Agent' }, role: 'owner', failed: true, wallSeconds: 540, staffedSeconds: 540 }, waiting: null, automatedReplyAt: null });
    const r = report();
    r.sources[0] = { ...r.sources[0]!, failedAttempts: 1, notWithin5: [failed], notWithin5More: 0 };
    leadAdminApp(fake(r), '/team/scoreboard', 'team_lead');
    const region = await section();
    const web = (await within(region).findByRole('heading', { level: 3, name: 'Website form' })).closest('li')!;
    const rowEl = within(within(web).getByRole('list', { name: 'Not within 5 minutes, Website form' })).getAllByRole('listitem')[0]!;
    expect(rowEl).toHaveTextContent(/First tried after 9 min: a text by Ben Agent, the lead’s owner\. Tried, but the text failed: it did not reach them\./);
    expect(within(web).getByText('Tried, but the text or email failed')).toBeInTheDocument();
    expect(within(web).getByText(`1 of the ${r.sources[0]!.attempted} with an attempt`)).toBeInTheDocument();
  });

  it('R-TEAMQ-22 E883: an inquiry whose own call a person answered is its own state: never "no person has tried", never an attempt; the source counts it apart with its denominator', async () => {
    const answered = inquiry({ contact: { id: P.nia, name: 'Nia Night' }, inquiryId: '01900000-0000-7000-8000-0000000000e8', state: 'answered_call', waiting: null, automatedReplyAt: null, answeredCall: { at: '2026-11-09T18:02:00.000Z', by: { userId: ID.ben, name: 'Ben Agent' }, wallSeconds: 120, staffedSeconds: 120 } });
    const r = report();
    r.sources[0] = { ...r.sources[0]!, answeredCalls: 1, waiting: 1, notWithin5: [answered], notWithin5More: 0 };
    leadAdminApp(fake(r), '/team/scoreboard', 'team_lead');
    const region = await section();
    const web = (await within(region).findByRole('heading', { level: 3, name: 'Website form' })).closest('li')!;
    const rowEl = within(within(web).getByRole('list', { name: 'Not within 5 minutes, Website form' })).getAllByRole('listitem')[0]!;
    expect(rowEl).toHaveTextContent(/^Nia Night.*A person, Ben Agent, answered their call .*\. Nobody has called back, texted or emailed since\. It is not counted as an attempt\. No automatic reply went out\./);
    expect(rowEl).not.toHaveTextContent(/No person has tried yet|First tried after/);
    expect(within(web).getByText('A person answered their call')).toBeInTheDocument();
    expect(within(web).getByText(`1 of ${r.sources[0]!.inquiries}, not counted as an attempt: nobody has called back, texted or emailed`)).toBeInTheDocument();
  });

  it('R-TEAMQ-7 E829: an off-hours arrival says it is counted from opening, with the wall-clock time beside it', async () => {
    const offHours = inquiry({ contact: { id: P.nia, name: 'Nia Night' }, offHours: true, countedFrom: '2026-11-09T16:00:00.000Z', arrivedAt: '2026-11-09T10:00:00.000Z', attempt: { at: '2026-11-09T16:20:00.000Z', kind: 'text', by: { userId: ID.ava, name: 'Ava Agent' }, role: 'owner', wallSeconds: 22_800, staffedSeconds: 1200 }, waiting: null, automatedReplyAt: null });
    leadAdminApp(fake(report({ sources: [{ sourceId: SRC.web, sourceName: 'Website form', ...rollup(), notWithin5: [offHours], notWithin5More: 0 }] })), '/team/scoreboard', 'team_lead');
    const region = await section();
    const row = (await within(region).findByRole('link', { name: 'Nia Night' })).closest('li')!;
    expect(row).toHaveTextContent('First tried after 20 min: a text by Ava Agent, the lead’s owner. It arrived outside staffed hours, so it is counted from opening (6 h 20 min on the clock). No automatic reply went out.');
  });

  it('R-TEAMQ-18: an attempt by the alerted backup is said as the backup\'s, apart from the owner\'s and from anyone else\'s', async () => {
    const byBackup = inquiry({ contact: { id: P.nia, name: 'Nia Night' }, attempt: { at: '2026-11-09T16:06:00.000Z', kind: 'call', by: { userId: ID.ben, name: 'Ben Agent' }, role: 'backup', wallSeconds: 360, staffedSeconds: 360 }, waiting: null, automatedReplyAt: null });
    leadAdminApp(fake(report({ sources: [{ sourceId: SRC.web, sourceName: 'Website form', ...rollup(), notWithin5: [byBackup], notWithin5More: 0 }] })), '/team/scoreboard', 'team_lead');
    const region = await section();
    const row = (await within(region).findByRole('link', { name: 'Nia Night' })).closest('li')!;
    expect(row).toHaveTextContent('First tried after 6 min: a call by Ben Agent, the backup, after the backup alert. No automatic reply went out.');
  });

  it('R-TEAMQ-18 E858: each source says how many inquiries had their backup alerted, of its inquiries, and how many of those the backup tried first; a source with no alert says so without a second count', async () => {
    const withAlerts = report({
      totals: rollup({ inquiries: 12, backupAlerted: 3, byBackup: 2 }),
      sources: [
        { sourceId: SRC.web, sourceName: 'Website form', ...rollup({ backupAlerted: 3, byBackup: 2 }), notWithin5: [], notWithin5More: 0 },
        { sourceId: SRC.sign, sourceName: 'Open house sign-in', ...rollup({ inquiries: 3, backupAlerted: 0, byBackup: 0 }), notWithin5: [], notWithin5More: 0 },
      ],
    });
    leadAdminApp(fake(withAlerts), '/team/scoreboard', 'owner');
    const region = await section();
    const web = (await within(region).findByRole('heading', { level: 3, name: 'Website form' })).closest('li')!;
    expect(within(web).getByText('Backup alerted').nextElementSibling).toHaveTextContent('3 of 9');
    expect(within(web).getByText('First attempt by the backup').nextElementSibling).toHaveTextContent('2 of the 3 alerted');
    const sign = within(region).getByRole('heading', { level: 3, name: 'Open house sign-in' }).closest('li')!;
    expect(within(sign).getByText('Backup alerted').nextElementSibling).toHaveTextContent('0 of 3');
    expect(within(sign).queryByText('First attempt by the backup')).toBeNull();
  });

  it('R-TEAMQ-25 E890 (review fix L4): an alert that went to a team lead is its own line with its own denominator, and that team lead\'s attempt is said as the team lead\'s: never "backup alerted", never "the backup"', async () => {
    const byLead = inquiry({ contact: { id: P.nia, name: 'Nia Night' }, inquiryId: '01900000-0000-7000-8000-0000000000ea', attempt: { at: '2026-11-09T18:09:00.000Z', kind: 'text', by: { userId: ID.ava, name: 'Ava Agent' }, role: 'team_lead', wallSeconds: 540, staffedSeconds: 540 }, waiting: null, automatedReplyAt: null, backupAlert: { at: '2026-11-09T18:03:00.000Z', to: { userId: ID.ava, name: 'Ava Agent' }, recipient: 'team_lead' } });
    const r = report();
    r.sources[0] = { ...r.sources[0]!, backupAlerted: 0, byBackup: 0, teamLeadAlerted: 1, byTeamLead: 1, adminsAlerted: 3, notWithin5: [byLead], notWithin5More: 0 };
    leadAdminApp(fake(r), '/team/scoreboard', 'team_lead');
    const region = await section();
    const web = (await within(region).findByRole('heading', { level: 3, name: 'Website form' })).closest('li')!;
    const n = r.sources[0]!.inquiries;
    expect(within(web).getByText('Team lead alerted instead of the backup')).toBeInTheDocument();
    expect(within(web).getByText('First attempt by that team lead')).toBeInTheDocument();
    expect(within(web).getByText('1 of the 1 alerted')).toBeInTheDocument();
    expect(within(web).getByText('Owners and Admins alerted (no team lead to tell)')).toBeInTheDocument();
    expect(within(web).getByText('Owners and Admins alerted (no team lead to tell)').closest('div, li, dl, p')!.parentElement).toHaveTextContent(`3 of ${n}`);
    expect(within(web).queryByText('First attempt by the backup')).toBeNull();
    const rowEl = within(within(web).getByRole('list', { name: 'Not within 5 minutes, Website form' })).getAllByRole('listitem')[0]!;
    expect(rowEl).toHaveTextContent(/First tried after 9 min: a text by Ava Agent, the team lead, after the alert went to them in the backup’s place\./);
    expect(rowEl).not.toHaveTextContent(/the backup, after the backup alert/);
  });

  it('R-TEAMQ-18 E857: an inquiry whose backup was alerted says who was alerted and how long after it arrived, the fallback in its own words', async () => {
    const alerted = inquiry({ backupAlert: { at: '2026-11-09T18:03:00.000Z', to: { userId: ID.ben, name: 'Ben Agent' }, recipient: 'backup' } });
    const fallback = inquiry({ inquiryId: '01900000-0000-7000-8000-0000000000e9', contact: { id: P.nia, name: 'Nia Night' }, backupAlert: { at: '2026-11-09T18:04:00.000Z', to: { userId: ID.ava, name: 'Ava Agent' }, recipient: 'team_lead' } });
    leadAdminApp(fake(report({ sources: [{ sourceId: SRC.web, sourceName: 'Website form', ...rollup(), notWithin5: [alerted, fallback], notWithin5More: 0 }] })), '/team/scoreboard', 'team_lead');
    const region = await section();
    const wren = (await within(region).findByRole('link', { name: 'Wren Waiting' })).closest('li')!;
    expect(wren).toHaveTextContent('The backup, Ben Agent, was alerted 3 min after it arrived.');
    const nia = within(region).getByRole('link', { name: 'Nia Night' }).closest('li')!;
    expect(nia).toHaveTextContent("The source's backup was unavailable, so the team lead, Ava Agent, was alerted 4 min after it arrived.");
  });

  it('R-TEAMQ-8 E832: imports and closed people are said apart, never in the measure; the staffed hours and the minimum samples are stated', async () => {
    leadAdminApp(fake(), '/team/scoreboard', 'admin');
    const region = await section();
    expect(await within(region).findByText('38 people came in by import in this period. They are not inquiries and are not measured here.')).toBeInTheDocument();
    expect(within(region).getByText('1 inquiry from a person since closed (spam, not a lead, do not contact or merged) is left out.')).toBeInTheDocument();
    expect(within(region).getByText('Minutes are staffed time: 8:00 AM to 9:00 PM (America/Los_Angeles). A lead that arrives outside those hours is counted from opening. A median is shown from 5 attempts and a 90th percentile from 10.')).toBeInTheDocument();
    expect(within(region).queryByText(/newest/)).toBeNull();
  });

  it('R-TEAMQ-28 E897: inquiries of people since deleted are said as left out, with their number; with none, no such line', async () => {
    leadAdminApp(fake(report({ deletedExcluded: 2 })), '/team/scoreboard', 'team_lead');
    const region = await section();
    expect(await within(region).findByText('2 inquiries from people since deleted are left out.')).toBeInTheDocument();
    expect(responseFootnotes({ ...report({ deletedExcluded: 1 }) })).toContain('1 inquiry from a person since deleted is left out.');
    expect(responseFootnotes(report()).join(' ')).not.toMatch(/since deleted/);
  });

  it('a capped read says the numbers cover only the newest inquiries', async () => {
    leadAdminApp(fake(report({ truncated: true })), '/team/scoreboard', 'owner');
    expect(await within(await section()).findByText('This period holds more inquiries than one report reads. The numbers cover the newest 12 only.')).toBeInTheDocument();
  });

  it('no inquiries in the period says so instead of showing zeros; the period switch asks for the new range', async () => {
    const empty = report({ totals: rollup({ inquiries: 0, attempted: 0, within5: 0, within15: 0, waiting: 0, automatedReplies: 0, sample: 0, medianStaffedSeconds: null }), sources: [], imports: { people: 0 }, closedExcluded: 0 });
    const f = fake(empty)
      .on('GET /team/scoreboard?range=30d', { status: 200, body: { range: range('30d', 30), members: [board()] } })
      .on('GET /team/lead-response?range=30d', { status: 200, body: report({ range: range('30d', 30) as LeadResponseReport['range'] }) });
    leadAdminApp(f, '/team/scoreboard', 'team_lead');
    const region = await section();
    expect(await within(region).findByText('No inquiries arrived in this period.')).toBeInTheDocument();
    expect(within(region).queryByText(/0 of 0/)).toBeNull();
    expect(within(region).getByText('No one came in by import in this period.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('radio', { name: '30 days' }));
    expect(await within(region).findByRole('heading', { level: 3, name: 'Website form' })).toBeInTheDocument();
    expect(f.callsTo('GET /team/lead-response?range=30d')).toHaveLength(1);
  });

  it('says it is loading, and when the report cannot be read it says so; the scoreboard beside it still shows', async () => {
    leadAdminApp(fake(err(500, 'INTERNAL') as { status: number; body?: unknown }), '/team/scoreboard', 'team_lead');
    const region = await section();
    expect(await within(region).findByRole('alert')).toHaveTextContent('We could not read the response report.');
    expect(within(region).queryByText('No inquiries arrived in this period.')).toBeNull();
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('R-TEAMQ-6: an agent never asks for the report and sees no such section', async () => {
    const f = new FakeFetch().on('GET /scoreboard?range=7d', { status: 200, body: { range: range('7d'), scoreboard: board({ userId: ID.me, name: 'Ava Agent' }) } }).on('GET /team/momentum', { status: 200, body: momentum });
    leadAdminApp(f, '/team/scoreboard', 'agent');
    expect(await screen.findByRole('heading', { name: 'Your numbers' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lead response, from arrival' })).toBeNull();
    expect(f.calls.filter((c) => c.path.startsWith('/team/lead-response'))).toHaveLength(0);
  });

  it('the report has no axe violations', async () => {
    leadAdminApp(fake(), '/team/scoreboard', 'team_lead');
    await within(await section()).findByRole('heading', { level: 3, name: 'Website form' });
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('responseLines', () => {
  it('R-TEAMQ-8 R-ACC-4: every count is "x of y" for any values; a percentile appears only with its sample, from the minimum on', () => {
    const rules = { within5Seconds: 300, within15Seconds: 900, medianMinSample: 5, p90MinSample: 10 };
    for (const n of [0, 1, 4, 5, 9, 10, 250]) {
      const lines = responseLines(rollup({ inquiries: n + 2, attempted: n, within5: Math.floor(n / 2), within15: n, waiting: 2, automatedReplies: 1, sample: n, medianStaffedSeconds: n >= 5 ? 240 : null, p90StaffedSeconds: n >= 10 ? 1320 : null }), rules);
      const of = (label: string) => lines.find((l) => l.label === label)!.text;
      expect(of('With a human attempt')).toBe(`${n} of ${n + 2}`);
      expect(of('Within 5 minutes')).toBe(`${Math.floor(n / 2)} of ${n + 2}`);
      expect(of('Within 15 minutes')).toBe(`${n} of ${n + 2}`);
      expect(of('Still waiting')).toBe(`2 of ${n + 2}`);
      expect(of('Median to the first attempt')).toBe(n >= 5 ? `4 min (of ${n} attempts)` : `Not shown: ${n} of the 5 attempts it needs`);
      expect(of('90th percentile')).toBe(n >= 10 ? `22 min (of ${n} attempts)` : `Not shown: ${n} of the 10 attempts it needs`);
      expect(of('Automatic replies')).toBe(`1 of ${n + 2}, shown apart and never counted as an attempt`);
    }
  });
});
