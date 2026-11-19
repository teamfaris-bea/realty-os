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
import { type ImportsHarness, approve, batchOf, call, commitStage, csvBase64, dryRunStage, freshReauth, fullStage, importsHarness, records, startFub, verify, writtenBulkPhone } from './testing.js';

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
  inReview: boolean;
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
  it('E728 E755 FUB, mapped at import time: the preview lists the labels and which are marked; after the import every automated path is refused for the people it COMMITTED under the label (a person it created, and a person already here once a reviewer attached her row to her); a person already here whose row was left waiting is not covered (a match is not an import), nor is a person from another label; a one-to-one text still goes', async () => {
    const existingPhone = randomPhone();
    const before = await ownedContact(agent, { phone: existingPhone, firstName: 'Ana' });
    const waitingPhone = randomPhone();
    const waiting = await ownedContact(agent, { phone: waitingPhone, firstName: 'Ivy' });
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
      people: [person(4001, 'Rae', PARTNER_LABEL, writtenBulkPhone(4001)), person(4002, 'Ana', PARTNER_LABEL, existingPhone, 'Doe'), person(4003, 'Zed', 'Open house (test)', writtenBulkPhone(4003)), person(4004, 'Ivy', PARTNER_LABEL, waitingPhone, 'Doe')],
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
      ['Open house (test)', 1, null, false],
      [PARTNER_LABEL, 3, null, false],
    ]);
    // R-LSRC-9 (owner decision 2026-11-14): an unmapped label is in review, and the row says what that means
    expect(p0.body.sourceLabels.find((l) => l.label === PARTNER_LABEL)!.sentence).toBe(`"${PARTNER_LABEL}" (3 people): not reviewed yet. Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.`);
    expect(p0.body.sourceLabels.map((l) => l.inReview)).toEqual([true, true]);

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
    // E755: an import's own row says the numbers. Nothing is imported yet, and the mapping covers a person only once
    // their row is imported or attached (a Follow Up Boss import is "this import", not a file)
    expect(row.sentence).toBe(`"${PARTNER_LABEL}": 3 people in this import. None has been imported by this import yet. The label is mapped to ${marked.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on: that covers a person once their row is imported or attached, not before.`);
    expect(p1.body.sourceLabels.find((l) => l.label === 'Open house (test)')!.sentence).toBe(`"Open house (test)" (1 person): mapped to ${open.name}.`);

    // the dry run matched Ana and Ivy, who were already here with an owner: their rows wait for a person's review. A
    // match is a preview, not an import (0103): neither is covered by the marked source yet
    const d = await dryRunStage(ih, w.owner, b.id, 'contacts');
    const waitingRows = (await records(w.owner, b.id, 'contacts')).filter((r) => r.dryRunOutcome === 'needs_review');
    expect(waitingRows.map((r) => r.matchContactId).sort()).toEqual([before.id, waiting.id].sort());
    expect([await definer(before.id), await definer(waiting.id)]).toEqual([false, false]);
    // the reviewer attaches Ana's row to her; Ivy's row is left waiting
    expect((await call(w.owner, 'POST', `/imports/${b.id}/records/${waitingRows.find((r) => r.matchContactId === before.id)!.id}/review`, { decision: 'merge', mergeIntoContactId: before.id })).status).toBe(200);
    expect((await approve(w.owner, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    expect((await commitStage(ih, w.owner, b.id, 'contacts')).status).toBe('committed');
    expect((await verify(w.owner, b.id, 'contacts')).res.status).toBe(200);
    await fullStage(ih, w.owner, b.id, 'ownership');
    const rae = await contactByName(b.id, 'Rae');
    const zed = await contactByName(b.id, 'Zed');
    // Ana and Ivy were already here: the import matched them by phone and created nobody
    expect((await h().su.query('SELECT 1 FROM contacts WHERE import_batch_id = $1 AND first_name = ANY ($2)', [b.id, ['Ana', 'Ivy']])).rows).toEqual([]);
    expect((await h().su.query<{ original_source_detail: Record<string, unknown> }>('SELECT original_source_detail FROM contacts WHERE id = $1', [rae])).rows[0]!.original_source_detail).toMatchObject({ import_source: PARTNER_LABEL, import_system: 'fub' });

    // the summary lists them too
    const rep = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.sourceLabels.find((l) => l.label === PARTNER_LABEL)).toMatchObject({ people: 3, committedPeople: 2, leadSourceId: marked.id, noAutomatedContact: true });
    // E755: ...in both numbers: Rae and Ana are covered; Ivy, already here and left waiting, is not, and the row says so
    expect(rep.body.sourceLabels.find((l) => l.label === PARTNER_LABEL)!.sentence).toBe(
      `"${PARTNER_LABEL}": 3 people in this import. 2 were imported or attached and get no automated contact, because the label is mapped to ${marked.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on. 1 was already in the CRM and is not imported by this import, so this mapping does not cover them: their row is not attached.`,
    );

    await noAutomatedContactFor(agent, rae);
    // Ana: the commit attached the partner's record to her, so she is the marked source's person from then on
    await noAutomatedContactFor(agent, before.id);
    // Ivy: her row still waits. The import committed nothing for her, so nothing is refused: a person enrols her by hand
    expect(await definer(waiting.id)).toBe(false);
    expect((await call(agent, 'POST', `/contacts/${waiting.id}/enrollments`, { playbookId: plan.id })).status).toBe(201);
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

  it('E728 E729 CSV, mapped afterwards: an imported person is in review (SOURCE_UNCLASSIFIED) until the Owner maps the label; mapped to an unmarked source they are open to a plan; moved to the marked source their running plan stops at once, the CRM-wide list says which labels are marked, and a one-to-one text still goes; unmapped, they are in review again', async () => {
    const phone = writtenBulkPhone(4011);
    const csv = `First Name,Last Name,Mobile Phone,Email,Source\nCai,Filed,${phone},cai.filed@example.com,"${FILE_LABEL}"\nDee,Filed,${writtenBulkPhone(4012)},dee.filed@example.com,Website\n`;
    const up = await call<{ batch: { id: string } }>(w.owner, 'POST', '/imports', { source: 'csv', fileName: 'partner.csv', fileBase64: csvBase64(csv) });
    expect(up.status).toBe(201);
    expect((await call(w.owner, 'POST', `/imports/${up.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = await batchOf(w.owner, up.body.batch.id);
    const preview = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/parity`);
    expect(preview.body.sourceLabels.map((l) => [l.label, l.people, l.noAutomatedContact])).toEqual([[FILE_LABEL, 1, false], ['Website', 1, false]]);
    await fullStage(ih, w.owner, b.id, 'contacts');
    const cai = await contactByName(b.id, 'Cai');
    // give Cai an owner. Before anyone maps the label Cai is in review (R-LSRC-9, owner decision 2026-11-14): no plan,
    // refused with the unclassified reason, never the marked source's
    expect((await call(w.owner, 'POST', `/leads/${cai}/reassign`, { commandId: randomUUID(), toUserId: agent.userId })).status).toBe(200);
    expect(await definer(cai)).toBe(true);
    const early = await call(agent, 'POST', `/contacts/${cai}/enrollments`, { playbookId: plan.id });
    expect([early.status, early.code]).toEqual([409, 'SOURCE_UNCLASSIFIED']);
    const list0 = await call<{ labels: LabelRow[] }>(w.owner, 'GET', '/lead-sources/import-labels');
    expect(list0.body.labels.find((l) => l.label === FILE_LABEL)).toMatchObject({ people: 1, leadSourceId: null, noAutomatedContact: false, inReview: true });
    // the Owner reviews the label: first to a source without the setting, so a plan may run for Cai
    await freshReauth(ih.h, w.owner);
    expect((await mapLabel(w.owner, FILE_LABEL, open.id)).body.label).toMatchObject({ leadSourceId: open.id, inReview: false, noAutomatedContact: false });
    expect(await definer(cai)).toBe(false);
    const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${cai}/enrollments`, { playbookId: plan.id });
    expect(e.status).toBe(201);

    // afterwards, from the CRM-wide list: the Owner moves the file's label to the marked source; the plan stops now
    await freshReauth(ih.h, w.owner);
    const m = await mapLabel(w.owner, FILE_LABEL, marked.id);
    expect(m.status).toBe(200);
    expect(m.body.stopping).toBe(1);
    await runJobs(h(), w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await enrollmentRow(h(), e.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'source_no_automated_contact' });
    const list1 = await call<{ labels: LabelRow[] }>(w.owner, 'GET', '/lead-sources/import-labels');
    expect(list1.body.labels.find((l) => l.label === FILE_LABEL)).toMatchObject({ people: 1, leadSourceId: marked.id, leadSourceName: marked.name, noAutomatedContact: true });
    const rep = await call<{ sourceLabels: LabelRow[] }>(w.owner, 'GET', `/imports/${b.id}/report`);
    expect(rep.body.sourceLabels.find((l) => l.label === FILE_LABEL)).toMatchObject({ people: 1, noAutomatedContact: true });

    await noAutomatedContactFor(agent, cai);
    const t = await sendText(agent, cai, 'Hi Cai, this is Alex from the team. Is now a good time?');
    expect([t.status, t.body.result]).toEqual([200, 'sent']);

    // unmapping is the Owner's too (asked with the password again): Cai is no longer covered by the marked source, and is
    // in review again, so still refused, now for the unclassified reason (R-LSRC-9)
    const off = await mapLabel(w.owner, FILE_LABEL, null);
    expect(off.status).toBe(200);
    expect(off.body.label).toMatchObject({ label: FILE_LABEL, leadSourceId: null, noAutomatedContact: false, inReview: true });
    expect(await definer(cai)).toBe(true);
    const late = await call(agent, 'POST', `/contacts/${cai}/enrollments`, { playbookId: plan.id });
    expect([late.status, late.code]).toEqual([409, 'SOURCE_UNCLASSIFIED']);
  }, 300_000);
});

