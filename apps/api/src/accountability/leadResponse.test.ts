// The lead response report over real Postgres, through the real server as each role (b19 team-queue lane; DATA_MODEL
// R-TEAMQ-6..9, E827..E832). Leads arrive through the real intake, attempts go through the real send path, the
// automatic reply comes from the real first-response job. The superuser pool only reads state back and moves clocks
// (an inquiry that arrived hours ago, staffed hours that opened half an hour ago). Invented people and sources only.
import { type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshReauth } from '../admin/testing.js';
import { approvedPlaybook, assistantWorld, grantConsent, randomPhone, runJobs } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { importedUnassigned, leadsWorld, postIntake } from '../leads/testing.js';
import { type AccWorld, call, command, contactState, intake, sendText, suFixture } from './testing.js';

let h: ApiHarness;
let w: AccWorld;
let outsider: TestClient;
let admin: TestClient;
let isa: TestClient;
let tc: TestClient;
const FR = ['assistant.first_response', 'comms.dispatch'];

interface InquiryT {
  inquiryId: string;
  contact: { id: string; name: string };
  sourceId: string;
  sourceName: string | null;
  arrivedAt: string;
  offHours: boolean;
  countedFrom: string;
  attempt: { at: string; kind: string; by: { userId: string; name: string | null } | null; role: 'owner' | 'collaborator' | 'other'; wallSeconds: number; staffedSeconds: number } | null;
  waiting: { wallSeconds: number; staffedSeconds: number } | null;
  automatedReplyAt: string | null;
  within5: boolean;
  within15: boolean;
}
interface RollupT {
  inquiries: number;
  attempted: number;
  within5: number;
  within15: number;
  waiting: number;
  automatedReplies: number;
  sample: number;
  medianStaffedSeconds: number | null;
  p90StaffedSeconds: number | null;
}
interface ReportT {
  range: { key: string; from: string; to: string; days: number; zone: string };
  staffedHours: { open: string; close: string; zone: string };
  rules: { within5Seconds: number; within15Seconds: number; medianMinSample: number; p90MinSample: number };
  totals: RollupT;
  sources: (RollupT & { sourceId: string; sourceName: string | null; notWithin5: InquiryT[]; notWithin5More: number })[];
  inquiries: InquiryT[];
  inquiriesMore: number;
  imports: { people: number };
  closedExcluded: number;
  truncated: boolean;
  generatedAt: string;
}

async function report(c: TestClient, range = '7d'): Promise<ReportT> {
  const r = await call<ReportT>(c, 'GET', `/team/lead-response?range=${range}`);
  if (r.status !== 200) throw new Error(`lead response: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const inquiriesOf = (r: ReportT, contactId: string) => r.inquiries.filter((i) => i.contact.id === contactId).sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));

/** A made-up lead source of its own, so a test's numbers are only its own inquiries. */
async function source(name: string): Promise<{ id: string; token: string }> {
  await freshReauth(h, w.owner);
  const src = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name, kind: 'website' });
  if (src.status !== 201) throw new Error(`lead source: ${src.status} ${JSON.stringify(src.body)}`);
  return { id: src.body.source.id, token: src.body.ingestToken };
}

/** A lead from `src`, accepted by the agent it was offered to. */
async function acceptedFrom(src: { token: string }, body: Record<string, unknown> = {}): Promise<{ contactId: string; owner: TestClient; phone: string }> {
  const phone = randomPhone();
  const r = await postIntake(h, src.token, { inquiryType: 'buy', fullName: 'Lena Arrival', phones: [phone], ...body });
  if (r.statusCode !== 201) throw new Error(`intake: ${r.statusCode} ${r.body}`);
  const contactId = (r.json() as { contactId: string }).contactId;
  const st = await contactState(h, contactId);
  const owner = w.agents.find((a) => a.userId === st.offered_to_user_id);
  if (!owner || !st.offer_id) throw new Error(`lead not offered: ${st.ownership_state}`);
  const acc = await command(owner, contactId, 'accept', { offerId: st.offer_id });
  if (acc.status !== 200) throw new Error(`accept: ${acc.status} ${JSON.stringify(acc.body)}`);
  return { contactId, owner, phone };
}

/** A human text from `by` to the lead (consent first, as a person would have it). */
async function humanText(by: TestClient, contactId: string): Promise<void> {
  await grantConsent(by, contactId, 'sms');
  const r = await sendText(by, contactId, 'Hi, thanks for reaching out. When is a good time to talk?');
  if (r.body.result !== 'sent') throw new Error(`text not sent: ${JSON.stringify(r.body)}`);
}

/** clock fixture: the person's inquiries arrived (were claimed, and reached the team: R-TEAMQ-19) `minutes` ago */
const arrivedAgo = (contactId: string, minutes: number) =>
  h.su.query(`UPDATE lead_inquiries SET received_at = now() - ($2::int * interval '1 minute'), created_at = now() - ($2::int * interval '1 minute') WHERE contact_id = $1`, [contactId, minutes]);

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  const base = await assistantWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'] });
  [admin, isa, tc] = base.others as [TestClient, TestClient, TestClient];
  outsider = await h.invite(base.owner, 'agent');
  w = { ...base, outsider };
  await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
  const s = await call<{ settings: { version: number } }>(w.owner, 'GET', '/settings');
  const cap = await call(w.owner, 'PATCH', '/settings', { version: s.body.settings.version, uncontactedCapacityCap: 50 });
  if (cap.status !== 200) throw new Error(`settings: ${cap.status} ${JSON.stringify(cap.body)}`);
  // staffed all day, so a test's staffed seconds equal its wall-clock seconds unless it sets the hours itself
  await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [w.tenantId] }]);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-TEAMQ-7 one inquiry, from arrival to the first human attempt', () => {
  it('R-TEAMQ-7 E827: an automated reply is never counted: the inquiry is still waiting, and the reply is shown apart with its time', async () => {
    const src = await source('Elm Street yard sign (test)');
    const lead = await acceptedFrom(src);
    await runJobs(h, w.tenantId, FR);
    expect((await h.su.query<{ initiator: string; status: string }>(`SELECT initiator, status FROM messages WHERE contact_id = $1 AND direction = 'outbound'`, [lead.contactId])).rows).toEqual([{ initiator: 'assistant', status: 'sent' }]);
    const r = await report(w.owner);
    const [inq] = inquiriesOf(r, lead.contactId);
    expect(inq).toMatchObject({ contact: { name: 'Lena Arrival' }, sourceName: 'Elm Street yard sign (test)', attempt: null, within5: false, within15: false });
    expect(inq!.automatedReplyAt).not.toBeNull();
    expect(inq!.waiting!.wallSeconds).toBeGreaterThanOrEqual(0);
    expect(r.sources.find((s) => s.sourceId === src.id)).toMatchObject({ inquiries: 1, attempted: 0, within5: 0, within15: 0, waiting: 1, automatedReplies: 1, sample: 0, medianStaffedSeconds: null, p90StaffedSeconds: null });
  });

  it('R-TEAMQ-7 E828: an attempt by someone who is not the owner is credited to that person, not to the owner; the owner’s own later text does not replace it', async () => {
    const src = await source('Birch Lane open house (test)');
    const lead = await acceptedFrom(src);
    await arrivedAgo(lead.contactId, 2);
    await humanText(w.owner, lead.contactId); // the tenant Owner, who does not own this lead
    await humanText(lead.owner, lead.contactId);
    const [inq] = inquiriesOf(await report(w.teamLead!), lead.contactId);
    expect(inq!.attempt).toMatchObject({ kind: 'text', by: { userId: w.owner.userId }, role: 'other' });
    expect(inq!.attempt!.by!.userId).not.toBe(lead.owner.userId);
    expect(inq!.attempt!.wallSeconds).toBeGreaterThanOrEqual(120);
    expect(inq!.attempt!.wallSeconds).toBeLessThan(240);
    expect(inq).toMatchObject({ within5: true, within15: true, waiting: null });

    // the owner's own attempt is credited to the owner; a collaborator's to the collaborator
    const mine = await acceptedFrom(src, { fullName: 'Owen Ownercall' });
    await humanText(mine.owner, mine.contactId);
    const helper = w.agents.find((a) => a.userId !== mine.owner.userId)!;
    const shared = await acceptedFrom(src, { fullName: 'Cora Shared' });
    const sharedOwner = shared.owner;
    const other = w.agents.find((a) => a.userId !== sharedOwner.userId)!;
    expect((await call(sharedOwner, 'POST', `/contacts/${shared.contactId}/collaborators`, { userId: other.userId, role: 'co_agent' })).status).toBe(200);
    await humanText(other, shared.contactId);
    const r = await report(w.owner);
    expect(inquiriesOf(r, mine.contactId)[0]!.attempt).toMatchObject({ by: { userId: mine.owner.userId }, role: 'owner' });
    expect(inquiriesOf(r, shared.contactId)[0]!.attempt).toMatchObject({ by: { userId: other.userId }, role: 'collaborator' });
    expect(helper).toBeDefined();
  });

  it('R-TEAMQ-7 E829: an off-hours lead is counted from opening and marked as such', async () => {
    const src = await source('Cedar Court night form (test)');
    const lead = await acceptedFrom(src);
    try {
      // staffed hours opened 30 minutes ago (tenant-local) and close in two hours; the inquiry arrived 3 hours ago
      await suFixture(h, [{
        text: `UPDATE tenant_settings SET routing_hours_start = date_trunc('minute', (now() AT TIME ZONE default_timezone))::time - interval '30 minutes',
                                          routing_hours_end = date_trunc('minute', (now() AT TIME ZONE default_timezone))::time + interval '2 hours' WHERE tenant_id = $1`,
        values: [w.tenantId],
      }]);
      await arrivedAgo(lead.contactId, 180);
      await humanText(lead.owner, lead.contactId);
      const r = await report(w.owner);
      const [inq] = inquiriesOf(r, lead.contactId);
      expect(inq!.offHours).toBe(true);
      expect(new Date(inq!.countedFrom).getTime()).toBeGreaterThan(new Date(inq!.arrivedAt).getTime() + 2 * 3600_000);
      expect(inq!.attempt!.wallSeconds).toBeGreaterThanOrEqual(3 * 3600);
      // about half an hour of staffed time (the opening is on a minute boundary), never the three hours
      expect(inq!.attempt!.staffedSeconds).toBeGreaterThanOrEqual(29 * 60);
      expect(inq!.attempt!.staffedSeconds).toBeLessThan(33 * 60);
      expect(inq).toMatchObject({ within5: false, within15: false });
      expect(r.staffedHours.open).toMatch(/^\d\d:\d\d$/);
    } finally {
      await suFixture(h, [{ text: `UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '24:00' WHERE tenant_id = $1`, values: [w.tenantId] }]);
    }
  });

  it('R-TEAMQ-7 E830: two inquiries from one person are two arrivals, each with its own first attempt after it', async () => {
    const first = await source('Dune Road portal (test)');
    const second = await source('Dune Road second form (test)');
    const lead = await acceptedFrom(first, { fullName: 'Tavi Twice' });
    await arrivedAgo(lead.contactId, 60);
    await humanText(lead.owner, lead.contactId);
    // the same person asks again through another source: attached to the same person, a second arrival
    const again = await postIntake(h, second.token, { inquiryType: 'sell', fullName: 'Tavi Twice', phones: [lead.phone] });
    expect((again.json() as { contactId: string }).contactId).toBe(lead.contactId);
    let r = await report(w.owner);
    let [a, b] = inquiriesOf(r, lead.contactId);
    expect([a!.sourceId, b!.sourceId]).toEqual([first.id, second.id]);
    expect(a!.attempt).not.toBeNull();
    expect(a!.attempt!.wallSeconds).toBeGreaterThanOrEqual(3600);
    // the earlier text does not answer the later arrival
    expect(b).toMatchObject({ attempt: null, within5: false });
    expect(b!.waiting).not.toBeNull();
    const firstAttemptAt = a!.attempt!.at;

    await humanText(lead.owner, lead.contactId);
    r = await report(w.owner);
    [a, b] = inquiriesOf(r, lead.contactId);
    expect(a!.attempt!.at).toBe(firstAttemptAt);
    expect(b!.attempt).not.toBeNull();
    expect(new Date(b!.attempt!.at).getTime()).toBeGreaterThanOrEqual(new Date(b!.arrivedAt).getTime());
    expect(b!.attempt!.at).not.toBe(firstAttemptAt);
    expect(b).toMatchObject({ within5: true });
    expect(r.sources.find((s) => s.sourceId === first.id)).toMatchObject({ inquiries: 1, attempted: 1, within5: 0, within15: 0 });
    expect(r.sources.find((s) => s.sourceId === second.id)).toMatchObject({ inquiries: 1, attempted: 1, within5: 1, within15: 1 });
  });
});

describe('R-TEAMQ-8 the roll-up by source', () => {
  it('R-TEAMQ-8 E831: every count has its denominator, the ones not within 5 minutes are listed under their source, and no percentile is shown on two attempts', async () => {
    const src = await source('Fern Hollow listing page (test)');
    const fast = await acceptedFrom(src, { fullName: 'Fay Fast' });
    await humanText(fast.owner, fast.contactId);
    const slow = await acceptedFrom(src, { fullName: 'Sol Slow' });
    await arrivedAgo(slow.contactId, 20);
    await humanText(slow.owner, slow.contactId);
    const waiting = await acceptedFrom(src, { fullName: 'Wren Waiting' });
    await arrivedAgo(waiting.contactId, 45);
    const r = await report(w.owner);
    const s = r.sources.find((x) => x.sourceId === src.id)!;
    expect(s).toMatchObject({ sourceName: 'Fern Hollow listing page (test)', inquiries: 3, attempted: 2, within5: 1, within15: 1, waiting: 1, sample: 2, medianStaffedSeconds: null, p90StaffedSeconds: null, notWithin5More: 0 });
    // still waiting first, then the slow one; the fast one is not listed
    expect(s.notWithin5.map((i) => i.contact.name)).toEqual(['Wren Waiting', 'Sol Slow']);
    expect(s.notWithin5[0]!.waiting!.wallSeconds).toBeGreaterThanOrEqual(45 * 60);
    expect(s.notWithin5[1]!.attempt!.staffedSeconds).toBeGreaterThanOrEqual(20 * 60);
    expect(r.rules).toEqual({ within5Seconds: 300, within15Seconds: 900, medianMinSample: 5, p90MinSample: 10 });
    expect(r.totals.attempted + r.totals.waiting).toBe(r.totals.inquiries);
    expect(r.totals.inquiries).toBe(r.sources.reduce((n, x) => n + x.inquiries, 0));
  });

  it('R-TEAMQ-8 E832 R-IMPORT-6: an imported person is absent from the measure and counted apart; a deliberately ignored duplicate delivery is not an arrival', async () => {
    const before = await report(w.owner);
    const imported = await importedUnassigned(h, w.tenantId, { firstName: 'Ilse', lastName: 'Imported', phones: [randomPhone()] });
    const src = await source('Glen Park portal (test)');
    const body = { inquiryType: 'buy', fullName: 'Dana Double', phones: [randomPhone()] };
    expect((await postIntake(h, src.token, body)).statusCode).toBe(201);
    expect(((await postIntake(h, src.token, body)).json() as { outcome: string }).outcome).toBe('duplicate_ignored');
    const r = await report(w.owner);
    expect(r.inquiries.map((i) => i.contact.id)).not.toContain(imported);
    expect(r.imports.people).toBe(before.imports.people + 1);
    expect(r.sources.find((s) => s.sourceId === src.id)).toMatchObject({ inquiries: 1 });
    expect(r.totals.inquiries).toBe(before.totals.inquiries + 1);
  });
});

describe('R-TEAMQ-6 who may read it, and whose inquiries', () => {
  it('R-TEAMQ-6 R-PERM-1 R-PERM-5: each role’s HTTP outcome equals core.can(); the query is strict (no tenant id, a known range only)', async () => {
    const users: Record<Role, TestClient> = { owner: w.owner, admin, team_lead: w.teamLead!, agent: w.agents[0]!, isa, tc };
    const got: string[] = [];
    for (const role of Object.keys(users) as Role[]) {
      const want = can(users[role].actor(), 'team_queue.view', { team: true }).ok;
      const res = await call(users[role], 'GET', '/team/lead-response');
      expect({ role, ok: res.status === 200 }).toEqual({ role, ok: want });
      if (!want) expect([res.status, res.code]).toEqual([404, 'NOT_FOUND']);
      got.push(`${role} ${res.status}`);
    }
    expect(got).toEqual(['owner 200', 'admin 200', 'team_lead 200', 'agent 404', 'isa 404', 'tc 404']);
    expect((await h.client().request('GET', '/api/team/lead-response')).statusCode).toBe(401);
    expect((await call(w.owner, 'GET', `/team/lead-response?tenantId=${w.tenantId}`)).status).toBe(422);
    expect((await call(w.owner, 'GET', '/team/lead-response?range=1y')).status).toBe(422);
    expect((await report(w.owner, 'today')).range).toMatchObject({ key: 'today', days: 1 });
  });

  it('R-TEAMQ-6: a Team Lead’s report holds their team’s inquiries; an inquiry whose lead an agent outside their team owns is the Owner’s and Admin’s to see', async () => {
    const src = await source('Hazel Way portal (test)');
    const mine = await acceptedFrom(src, { fullName: 'Mina Mine' });
    const theirs = await acceptedFrom(src, { fullName: 'Thea Theirs' });
    expect((await command(w.owner, theirs.contactId, 'reassign', { toUserId: outsider.userId })).status).toBe(200);
    for (const boss of [w.owner, admin]) {
      const r = await report(boss);
      expect(r.sources.find((s) => s.sourceId === src.id)).toMatchObject({ inquiries: 2 });
      expect(r.inquiries.map((i) => i.contact.id)).toEqual(expect.arrayContaining([mine.contactId, theirs.contactId]));
    }
    const tl = await report(w.teamLead!);
    expect(tl.sources.find((s) => s.sourceId === src.id)).toMatchObject({ inquiries: 1 });
    expect(tl.inquiries.map((i) => i.contact.id)).toContain(mine.contactId);
    expect(tl.inquiries.map((i) => i.contact.id)).not.toContain(theirs.contactId);
    expect(JSON.stringify(tl)).not.toContain('Thea Theirs');
  });

  it('R-TEAMQ-6 (review fix L1): the team scope itself, where row-level security alone would show the inquiry: a Team Lead who is a COLLABORATOR on an outside agent\'s lead does not get its inquiry in their report; a pond lead\'s inquiry is theirs', async () => {
    const src = await source('Ivy Lane portal (test)');
    const shared = await acceptedFrom(src, { fullName: 'Sia Shared' });
    expect((await command(w.owner, shared.contactId, 'reassign', { toUserId: outsider.userId })).status).toBe(200);
    expect((await call(outsider, 'POST', `/contacts/${shared.contactId}/collaborators`, { userId: w.teamLead!.userId, role: 'co_agent' })).status).toBe(200);
    // the Team Lead can open the person (a collaborator), so only the team scope keeps the inquiry out of their report
    expect((await call(w.teamLead!, 'GET', `/contacts/${shared.contactId}`)).status).toBe(200);
    const pond = await acceptedFrom(src, { fullName: 'Pia Pond' });
    expect((await command(pond.owner, pond.contactId, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    expect((await contactState(h, pond.contactId)).ownership_state).toBe('in_pond');

    expect((await report(w.owner)).sources.find((s) => s.sourceId === src.id)).toMatchObject({ inquiries: 2 });
    const tl = await report(w.teamLead!);
    expect(tl.inquiries.map((i) => i.contact.id)).not.toContain(shared.contactId);
    expect(tl.inquiries.map((i) => i.contact.id)).toContain(pond.contactId);
    expect(tl.sources.find((s) => s.sourceId === src.id)).toMatchObject({ inquiries: 1 });
    expect(JSON.stringify(tl)).not.toContain('Sia Shared');
  });

  it('R-TEAMQ-6 R-TEN-3: another tenant’s inquiries never appear, and reading the report writes nothing', async () => {
    const other = await leadsWorld(h, { agents: 1 });
    const theirs = (await intake(h, other)).contactId;
    const counts = async () =>
      (await h.su.query(
        `SELECT (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM notifications) AS notifications, (SELECT count(*)::int FROM messages) AS messages,
                (SELECT count(*)::int FROM lead_ownership_events) AS ledger, (SELECT count(*)::int FROM audit_log) AS audit`,
      )).rows[0];
    const before = await counts();
    const ours = await report(w.owner);
    const otherReport = await report(other.owner);
    expect(await counts()).toEqual(before);
    expect(ours.inquiries.map((i) => i.contact.id)).not.toContain(theirs);
    expect(otherReport.inquiries.map((i) => i.contact.id)).toEqual([theirs]);
    expect(otherReport.totals).toMatchObject({ inquiries: 1, attempted: 0, waiting: 1 });
  });
});
