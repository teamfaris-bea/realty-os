// b18 round 3 item 1 (owner boundary B18S-5, R-LSRC-8, E728): "No automated contact for leads from this source" covers the
// people an import brings in. Follow Up Boss and CSV people carry their source only as a label (the import stores it on
// the person as original_source_detail.import_source, and on its import record); they have no lead_sources row, so the
// setting could never cover them. The Owner maps an imported label, exactly as the import stored it, to a lead source
// (PUT /lead-sources/import-labels, at import time or afterwards); app.person_from_lead_source (0099) then counts those
// people as sent by that source, and a marked source covers them like any lead it sent. The import preview and summary
// list the labels found and which are marked. A person's own one-to-one text still goes. The labels and sources here
// are made up ("a referral partner"); no partner is named. Fakes only (FakeFub, fake providers).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendFirstResponse } from '../assistant/firstResponse.js';
import { approvedPlaybook, depsOf, enrollmentRow, messagesOf, runJobs, smsStep } from '../assistant/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { draft, marketingReady } from '../bulk/testing.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { type CommsWorld, commsWorld, messageRow, ownedContact, randomPhone, sendText } from '../comms/testing.js';
import { NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT } from '../leads/automatedContact.js';
import { changeStage, decisionsOf, enrollmentsOf, setStage } from '../stageAutomation/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { type ImportsHarness, batchOf, call, csvBase64, freshReauth, fullStage, importsHarness, startFub, writtenBulkPhone } from './testing.js';

let ih: ImportsHarness;
let w: CommsWorld;
let agent: TestClient;
let admin: TestClient;
let marked: { id: string; name: string };
let open: { id: string; name: string };
let plan: { id: string; name: string };

const PARTNER_LABEL = 'Referral partner (test)';
const FILE_LABEL = 'Referral partner, from a file (test)';

interface LabelRow {
  label: string;
  people: number;
  leadSourceId: string | null;
  leadSourceName: string | null;
  noAutomatedContact: boolean;
  sentence: string;
}

beforeAll(async () => {
  ih = await importsHarness();
  w = await commsWorld(ih.h, { agents: 2, others: ['admin'] });
  agent = w.agents[0]!;
  admin = w.others[0]!;
  await marketingReady(ih.h, w);
  await freshReauth(ih.h, w.owner);
  await freshReauth(ih.h, admin);
  const m = await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referrals (test)', kind: 'referral' });
  marked = m.body.source;
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked.id}/ai-care`, { noAiCare: true })).status).toBe(200);
  const o = await call<{ source: { id: string; name: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Open houses (test)', kind: 'open_house' });
  open = o.body.source;
  // a team plan the Owner approves; a stage entry into 'active' starts it too
  const c = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(w.owner, 'POST', '/playbooks', {
    kind: 'nurture',
    scope: 'team',
    name: 'Imported check-in (test)',
    steps: [smsStep({ key: 'check_in', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] })],
  });
  expect(c.status).toBe(201);
  const v = c.body.playbook.versions[0]!;
  expect((await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 })).status).toBe(200);
  expect((await setStage(w.owner, c.body.playbook.id, 'active')).status).toBe(200);
  plan = { id: c.body.playbook.id, name: 'Imported check-in (test)' };
  await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
}, 300_000);
afterAll(async () => {
  await ih?.close();
});

const h = () => ih.h;
const automated = async (contactId: string) => (await messagesOf(h(), contactId)).filter((m) => m.initiator !== 'human');
const mapLabel = (c: TestClient, label: string, leadSourceId: string | null) =>
  call<{ label: LabelRow; pausing: number; stopping: number }>(c, 'PUT', '/lead-sources/import-labels', { label, leadSourceId });
const definer = (contactId: string) =>
  withTenantTx(systemActor(w.tenantId, 'assistant'), async (tx) => (await sql<{ no: boolean }>`SELECT app.person_no_ai_care_source(app.tenant_id(), ${contactId}::uuid) AS no`.execute(tx)).rows[0]!.no, { db: h().database });
const contactByName = async (batchId: string, first: string) =>
  (await h().su.query<{ id: string }>('SELECT id FROM contacts WHERE import_batch_id = $1 AND first_name = $2', [batchId, first])).rows[0]!.id;

/**
 * Every automated path the setting blocks, for one imported person `by` can act on: the shared definer, the instant
 * reply, a plan by hand (and the database), a stage entry, a bulk enroll and an automated message already queued.
 */
async function noAutomatedContactFor(by: TestClient, contactId: string): Promise<void> {
  expect(await definer(contactId)).toBe(true);
  expect(await sendFirstResponse(systemActor(w.tenantId, 'assistant'), contactId, depsOf(h()))).toMatchObject({ kind: 'not_sent', reason: SOURCE_NO_AUTOMATED_CONTACT });
  const e = await call(by, 'POST', `/contacts/${contactId}/enrollments`, { playbookId: plan.id });
  expect([e.status, e.code]).toEqual([409, SOURCE_NO_AUTOMATED_CONTACT]);
  await expect(withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state, current_step)
      SELECT app.tenant_id(), ${randomUUID()}::uuid, p.id, v.id, ${contactId}::uuid, 'new_lead', 'active', 0 FROM playbooks p JOIN playbook_versions v ON v.playbook_id = p.id AND v.tenant_id = p.tenant_id
       WHERE p.tenant_id = app.tenant_id() AND p.id = ${plan.id}::uuid AND v.status = 'approved'`.execute(tx), { db: h().database })).rejects.toThrow(/SOURCE_NO_AUTOMATED_CONTACT/);
  const s = await changeStage(by, contactId, 'active');
  expect(s.status).toBe(200);
  expect(s.body.automation).toEqual({ skipped: 'source_no_automated_contact', plan: plan.name });
  expect((await decisionsOf(h(), contactId)).map((d) => d.reason)).toContain('source_no_automated_contact');
  expect((await enrollmentsOf(h(), contactId)).filter((x) => x.state === 'active')).toEqual([]);
  const b = await draft(by, { kind: 'enroll', selection: { contactIds: [contactId] }, playbookId: plan.id });
  expect(b.status).toBe(201);
  expect(b.body.action.preflight).toEqual({ [SOURCE_NO_AUTOMATED_CONTACT]: 1 });
  expect(b.body.action.targetCount).toBe(0);
  const sys = systemActor(w.tenantId, 'worker');
  const q = await withTenantTx(sys, (tx, now) => queueOutboundInTx(tx, w.deps, { contactId, channel: 'email', subject: 'Homes for you', body: 'Two homes match your search.', initiator: 'system', purpose: 'marketing', category: 'search_alert', idempotencyKey: `t:${randomUUID()}` }, now), { db: h().database });
  expect(q.ok).toBe(true);
  await runJobs(h(), w.tenantId, ['comms.dispatch']);
  const alert = await messageRow(h(), (q as { messageId: string }).messageId);
  expect([alert.status, alert.status_reason]).toEqual(['blocked', SOURCE_NO_AUTOMATED_CONTACT]);
  expect((await automated(contactId)).filter((m) => m.status === 'sent' || m.status === 'delivered')).toEqual([]);
}

describe('R-LSRC-8 E728: imported people are covered once the Owner maps their imported source label to a marked source (b18 round 3 item 1)', () => {
  it('E728 FUB, mapped at import time: the preview lists the labels and which are marked; after the import every automated path is refused for those people (a person already here whom the import matched too), a person from another label is not covered, and a one-to-one text still goes', async () => {
    const existingPhone = randomPhone();
    const before = await ownedContact(agent, { phone: existingPhone, firstName: 'Ana' });
    const person = (id: number, firstName: string, source: string, phone: string, lastName = 'Imported') => ({
      id,
      created: '2025-01-01T10:00:00Z',
      firstName,
      lastName,
      stage: 'Lead',
      source,
      assignedUserId: 11,
      phones: [{ value: phone, type: 'mobile', status: 'Valid', isPrimary: 1 }],
      emails: [{ value: `${firstName.toLowerCase()}.${id}@example.com`, type: 'home', status: 'Valid', isPrimary: 1 }],
      smsOptIn: true,
      emailOptIn: true,
    });
    const key = `fub-nac-${randomUUID().slice(0, 8)}`;
    ih.fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [person(4001, 'Rae', PARTNER_LABEL, writtenBulkPhone(4001)), person(4002, 'Ana', PARTNER_LABEL, existingPhone, 'Doe'), person(4003, 'Zed', 'Open house (test)', writtenBulkPhone(4003))],
      notes: [],
      textMessages: [],
      emails: [],
      calls: [],
    });
    const b = await startFub(ih, w.owner, key);
    expect((await call(w.owner, 'PUT', `/imports/${b.id}/user-mappings`, { mappings: [{ sourceRef: '11', target: { kind: 'user', userId: agent.userId } }] })).status).toBe(200);

    // the preview: the labels found, none mapped yet
    const p0 = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/parity`);
    expect(p0.status).toBe(200);
    expect(p0.body.sourceLabels.map((l) => [l.label, l.people, l.leadSourceId, l.noAutomatedContact])).toEqual([
      ['Open house (test)', 1, null, true],
      [PARTNER_LABEL, 2, null, true],
    ]);
    expect(p0.body.sourceLabels.find((l) => l.label === PARTNER_LABEL)!.sentence).toBe(`"${PARTNER_LABEL}" (2 people): SOURCE_UNCLASSIFIED. Automated contact is blocked until the Owner confirms one exact source mapping.`);

    // only the Owner maps a label (the Admin who runs the import gets 404, and the database refuses them too)
    const byAdmin = await mapLabel(admin, PARTNER_LABEL, marked.id);
    expect(byAdmin.status).toBe(404);
    await expect(withTenantTx(admin.actor(), (tx) => sql`UPDATE lead_sources SET import_labels = ARRAY[${PARTNER_LABEL}]::text[] WHERE tenant_id = app.tenant_id() AND id = ${marked.id}::uuid`.execute(tx), { db: h().database })).rejects.toThrow(/LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY/);
    const mapped = await mapLabel(w.owner, PARTNER_LABEL, marked.id);
    expect(mapped.status).toBe(200);
    expect(mapped.body.label).toMatchObject({ label: PARTNER_LABEL, leadSourceId: marked.id, leadSourceName: marked.name, noAutomatedContact: true });
    expect((await mapLabel(w.owner, 'Open house (test)', open.id)).status).toBe(200);
    const p1 = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/parity`);
    const row = p1.body.sourceLabels.find((l) => l.label === PARTNER_LABEL)!;
    expect([row.leadSourceId, row.noAutomatedContact]).toEqual([marked.id, true]);
    expect(row.sentence).toBe(`"${PARTNER_LABEL}" (2 people): mapped to ${marked.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches them.`);
    expect(p1.body.sourceLabels.find((l) => l.label === 'Open house (test)')!.sentence).toBe(`"Open house (test)" (1 person): mapped to ${open.name}.`);

    await fullStage(ih, w.owner, b.id, 'contacts');
    await fullStage(ih, w.owner, b.id, 'ownership');
    const rae = await contactByName(b.id, 'Rae');
    const zed = await contactByName(b.id, 'Zed');
    // Ana was already here: the import matched her by phone and created nobody
    expect((await h().su.query('SELECT 1 FROM contacts WHERE import_batch_id = $1 AND first_name = $2', [b.id, 'Ana'])).rows).toEqual([]);
    expect((await h().su.query<{ original_source_detail: Record<string, unknown> }>('SELECT original_source_detail FROM contacts WHERE id = $1', [rae])).rows[0]!.original_source_detail).toMatchObject({ import_source: PARTNER_LABEL, import_system: 'fub' });

    // the summary lists them too
    const rep = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.sourceLabels.find((l) => l.label === PARTNER_LABEL)).toMatchObject({ people: 2, leadSourceId: marked.id, noAutomatedContact: true });

    await noAutomatedContactFor(agent, rae);
    await noAutomatedContactFor(agent, before.id);
    // a person whose label is mapped to a source without the setting is not covered: a plan starts on the stage entry
    expect(await definer(zed)).toBe(false);
    expect((await changeStage(agent, zed, 'active')).body.automation).toEqual({ started: plan.name });
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    for (const id of [rae, before.id]) expect((await automated(id)).filter((m) => m.status !== 'blocked')).toEqual([]);

    // a person's one-to-one text still goes
    const t = await sendText(agent, rae, 'Hi Rae, this is Alex from the team. Do you have a minute today?');
    expect([t.status, t.body.result]).toEqual([200, 'sent']);
    expect(ih.h.providers.telephony.sms.filter((x) => x.body.includes('Do you have a minute today?'))).toHaveLength(1);
  }, 300_000);

  it('E728 CSV, mapped afterwards: an unmapped imported person is blocked; unmapping stops a previously allowed plan immediately, the CRM-wide list says which labels are marked, and a one-to-one text still goes', async () => {
    const phone = writtenBulkPhone(4011);
    const csv = `First Name,Last Name,Mobile Phone,Email,Source\nCai,Filed,${phone},cai.filed@example.com,"${FILE_LABEL}"\nDee,Filed,${writtenBulkPhone(4012)},dee.filed@example.com,Website\n`;
    const up = await call<{ batch: { id: string } }>(w.owner, 'POST', '/imports', { source: 'csv', fileName: 'partner.csv', fileBase64: csvBase64(csv) });
    expect(up.status).toBe(201);
    expect((await call(w.owner, 'POST', `/imports/${up.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = await batchOf(w.owner, up.body.batch.id);
    const preview = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/parity`);
    expect(preview.body.sourceLabels.map((l) => [l.label, l.people, l.noAutomatedContact])).toEqual([[FILE_LABEL, 1, true], ['Website', 1, true]]);
    await fullStage(ih, w.owner, b.id, 'contacts');
    const cai = await contactByName(b.id, 'Cai');
    // An Owner must classify the source before a plan may start.
    expect((await call(w.owner, 'POST', `/leads/${cai}/reassign`, { commandId: randomUUID(), toUserId: agent.userId })).status).toBe(200);
    expect(await definer(cai)).toBe(true);
    const blocked = await call(agent, 'POST', `/contacts/${cai}/enrollments`, { playbookId: plan.id });
    expect([blocked.status, blocked.code]).toEqual([409, 'SOURCE_UNCLASSIFIED']);
    expect(await sendFirstResponse(systemActor(w.tenantId, 'assistant'), cai, depsOf(h()))).toMatchObject({ kind: 'not_sent', reason: 'SOURCE_UNCLASSIFIED' });
    expect((await mapLabel(w.owner, FILE_LABEL, open.id)).status).toBe(200);
    expect(await definer(cai)).toBe(false);
    const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${cai}/enrollments`, { playbookId: plan.id });
    expect(e.status).toBe(201);

    // afterwards, from the CRM-wide list: the Owner maps the file's label to the marked source; the plan stops now
    const list0 = await call<{ labels: LabelRow[] }>(w.owner, 'GET', '/lead-sources/import-labels');
    expect(list0.body.labels.find((l) => l.label === FILE_LABEL)).toMatchObject({ people: 1, leadSourceId: open.id, noAutomatedContact: false });
    await freshReauth(ih.h, w.owner);
    const removed = await mapLabel(w.owner, FILE_LABEL, null);
    expect(removed.status).toBe(200);
    expect(await enrollmentRow(h(), e.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    const m = await mapLabel(w.owner, FILE_LABEL, marked.id);
    expect(m.status).toBe(200);
    expect(m.body.stopping).toBe(0);
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), e.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_unclassified' });
    const list1 = await call<{ labels: LabelRow[] }>(w.owner, 'GET', '/lead-sources/import-labels');
    expect(list1.body.labels.find((l) => l.label === FILE_LABEL)).toMatchObject({ people: 1, leadSourceId: marked.id, leadSourceName: marked.name, noAutomatedContact: true });
    const rep = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.sourceLabels.find((l) => l.label === FILE_LABEL)).toMatchObject({ people: 1, noAutomatedContact: true });

    await noAutomatedContactFor(agent, cai);
    const t = await sendText(agent, cai, 'Hi Cai, this is Alex from the team. Is now a good time?');
    expect([t.status, t.body.result]).toEqual([200, 'sent']);

    // Unmapping never erases the proven restricted source association.
    const off = await mapLabel(w.owner, FILE_LABEL, null);
    expect(off.status).toBe(200);
    expect(off.body.label).toMatchObject({ label: FILE_LABEL, leadSourceId: null, noAutomatedContact: true });
    expect(await definer(cai)).toBe(true);
  }, 300_000);
});


it('groups whitespace-only evidence into one missing-source review row, including legacy blank mappings', async () => {
  for (const label of ['', ' ', '\u00a0\ufeff']) {
    const contact = await ownedContact(agent, { consent:false });
    await withTenantTx(systemActor(w.tenantId,'worker'), tx => sql`UPDATE contacts SET original_source_detail =
      ${JSON.stringify({import_system:'csv',import_source:label})}::jsonb WHERE id = ${contact.id}`.execute(tx), {db:h().database});
  }
  await withTenantTx(w.owner.actor(), tx => sql`UPDATE lead_sources SET import_labels = import_labels || ARRAY[' ',${'\u00a0\ufeff'}] WHERE id = ${open.id}`.execute(tx), {db:h().database});
  const result = await call<{labels:LabelRow[]}>(w.owner,'GET','/lead-sources/import-labels');
  expect(result.status).toBe(200);
  expect(result.body.labels.filter(row => !row.label.trim())).toEqual([
    expect.objectContaining({label:'',people:3,leadSourceId:null,noAutomatedContact:true,sentence:expect.stringMatching(/review the original import data/i)}),
  ]);
});
