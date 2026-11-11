// Playbooks: approve rules, not every message (R-AST-3, R-AST-4, R-CONSENT-5, R-GATE-3, R-GATE-4,
// R-AUDIT-5; E31, E32). Real Postgres (per-file database), the real server, fake providers.
import { randomUUID } from 'node:crypto';
import { type PlaybookKind, validatePlaybook, validatePlaybookContent } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { dispatchOutbound } from '../comms/index.js';
import { systemActor } from '../worker/systemActor.js';
import { migrateVersionEnrollments, pauseRevokedEnrollments } from './playbooks.js';
import { BUILT_IN_TEMPLATES } from './templates.js';
import {
  type AssistantWorld,
  approvedPlaybook,
  assistantWorld,
  auditRows,
  call,
  decisionsFor,
  depsOf,
  enrollmentRow,
  messageRow,
  messagesOf,
  ownedContact,
  runJobs,
  smsStep,
  stepNow,
} from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const confirmStep = (template: string, key = 'confirm', offsetSeconds = 0, anchor: 'enrollment' | 'previous_step' = 'enrollment') =>
  smsStep({ key, category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template, slots: ['first_name'], anchor, offsetSeconds });

type PB = { playbook: { id: string; approvedVersionId: string | null; versions: { id: string; status: string; contentSha256: string; issues: { code: string }[] }[] } };

describe('approval (R-AST-4, R-AUDIT-5)', () => {
  it('R-AST-4: the built-in templates ship as drafts that validate cleanly', async () => {
    for (const t of BUILT_IN_TEMPLATES) {
      // module 26: trigger templates hold one content object (validated by the same core validator)
      const issues = t.content ? validatePlaybookContent(t.content, { kind: t.kind as PlaybookKind }) : validatePlaybook(t.steps, { kind: t.kind as PlaybookKind });
      expect(issues, t.key).toEqual([]);
    }
    const c = await call<PB>(w.owner, 'POST', '/playbooks', { templateKey: 'new_lead_response' });
    expect(c.status).toBe(201);
    expect(c.body.playbook.versions.map((v) => v.status)).toEqual(['draft']);
    expect(c.body.playbook.approvedVersionId).toBeNull();
    expect(c.body.playbook.versions[0]!.issues).toEqual([]);
  });

  it('R-AST-4 R-AUDIT-5: approval is hash-bound, attested, by the right role (team: Owner/Admin), and audited; the version is then frozen', async () => {
    const c = await call<PB>(w.owner, 'POST', '/playbooks', { kind: 'booking_confirmation', scope: 'team', name: 'Confirm', steps: [confirmStep('Hi {{first_name}}, you are booked. Reply here to change it.')] });
    const v = c.body.playbook.versions[0]!;
    // an agent cannot approve (or even see as approvable) a team playbook: 404, never 403 (R-PERM-5)
    const agent = await call(w.agents[0]!, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve these messages.', contentSha256: v.contentSha256 });
    expect(agent.status).toBe(404);
    const wrong = await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve these messages.', contentSha256: 'a'.repeat(64) });
    expect(wrong.code).toBe('PLAYBOOK_HASH_MISMATCH');
    const ok = await call<PB>(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve these messages.', contentSha256: v.contentSha256 });
    expect(ok.status).toBe(200);
    expect(ok.body.playbook.approvedVersionId).toBe(v.id);
    const row = (await h.su.query('SELECT decision, decided_by_user_id, decided_by_role, content_sha256, attestation FROM playbook_approvals WHERE playbook_version_id = $1', [v.id])).rows;
    expect(row).toEqual([{ decision: 'approve', decided_by_user_id: w.owner.userId, decided_by_role: 'owner', content_sha256: v.contentSha256, attestation: 'I approve these messages.' }]);
    expect((await auditRows(h, w.tenantId, 'playbook.approved')).some((a) => a.entity_id === v.id && a.actor_user_id === w.owner.userId)).toBe(true);
    // frozen: the content of an approved version cannot change (DB trigger), even by a superuser path
    await expect(h.su.query(`UPDATE playbook_versions SET steps = '[]'::jsonb WHERE id = $1`, [v.id])).rejects.toThrow(/PLAYBOOK_VERSION_FROZEN/);
  });

  it('R-AST-4: an agent approves only their own agent playbook', async () => {
    const mine = await call<PB>(w.agents[0]!, 'POST', '/playbooks', { templateKey: 'nurture' });
    expect(mine.status).toBe(201);
    const v = mine.body.playbook.versions[0]!;
    expect((await call(w.agents[1]!, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve these messages.', contentSha256: v.contentSha256 })).status).toBe(404);
    expect((await call(w.agents[0]!, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve these messages.', contentSha256: v.contentSha256 })).status).toBe(200);
  });

  it('R-CONSENT-5: a marketing intent declared informational cannot be approved', async () => {
    const bad = smsStep({ category: 'nurture_step', intent: 'check_in', purpose: 'informational', template: 'Hi {{first_name}}, checking in on your search.', slots: ['first_name'] });
    const c = await call<PB>(w.agents[0]!, 'POST', '/playbooks', { kind: 'nurture', scope: 'agent', steps: [bad] });
    const v = c.body.playbook.versions[0]!;
    expect(v.issues.map((i) => i.code)).toContain('MARKETING_INTENT_DECLARED_INFORMATIONAL');
    const a = await call(w.agents[0]!, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve these messages.', contentSha256: v.contentSha256 });
    expect(a.code).toBe('PLAYBOOK_INVALID');
  });

  it('R-AST-3: a template that touches money or contracts cannot be approved (those always need a tap)', async () => {
    const step = smsStep({ category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, ready to make an offer this week?', slots: ['first_name'] });
    const c = await call<PB>(w.agents[0]!, 'POST', '/playbooks', { kind: 'nurture', scope: 'agent', steps: [step] });
    const v = c.body.playbook.versions[0]!;
    expect(v.issues.map((i) => i.code)).toContain('TEMPLATE_ALWAYS_HUMAN_TOPIC');
    expect((await call(w.agents[0]!, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve these messages.', contentSha256: v.contentSha256 })).code).toBe('PLAYBOOK_INVALID');
    // and the DB refuses an autonomous action in an always-human category outright (CHECK)
    await expect(
      h.su.query(
        `INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, playbook_version_id, status, explanation, payload)
         VALUES ($1, $2, 'autonomous_message', 'money', 'within_playbook', $3, 'proposed', 'x', '{}')`,
        [w.tenantId, randomUUID(), v.id],
      ),
    ).rejects.toThrow(/check/i);
  });
});

describe('edit, migrate, revoke (R-AST-4; E31, E32; R-GATE-3, R-GATE-4)', () => {
  it('R-AST-4 E31: an edit is a new draft; the approved version keeps running; after approval enrollments migrate at the step boundary by stepKey', async () => {
    const v1Steps = [confirmStep('Hi {{first_name}}, you are booked with us (v1).'), confirmStep('Hi {{first_name}}, see you soon (v1).', 'follow', 86_400, 'previous_step')];
    const pb = await approvedPlaybook(w.owner, { kind: 'booking_confirmation', scope: 'team', name: 'Two-step', steps: v1Steps });
    const N = 24; // reduced from the 200 of E31 for test time; the batch logic is exercised with batch = 10 below
    const contacts = [];
    for (let i = 0; i < N; i++) contacts.push(await ownedContact(w.agents[i % 2]!, { consent: i === 0 }));
    const enrollments: string[] = [];
    for (const c of contacts) {
      const r = await call<{ enrollment: { id: string } }>(w.agents[contacts.indexOf(c) % 2]!, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: pb.playbookId });
      expect(r.status).toBe(201);
      enrollments.push(r.body.enrollment.id);
    }
    await runJobs(h, w.tenantId, ['playbook.step'], 3, ['default']);
    // every contact now has step 1 of v1 queued; the first one is actually sent (it has consent)
    await dispatchOutbound((await messagesOf(h, contacts[0]!.id))[0]!.id, depsOf(h), { tenantId: w.tenantId });
    expect((await messagesOf(h, contacts[0]!.id))[0]!.status).toBe('sent');
    for (const c of contacts.slice(1)) expect((await messagesOf(h, c.id)).map((m) => m.status)).toEqual(['queued']);

    // edit: a new draft; v1 stays approved and running
    const v2Steps = [confirmStep('Hi {{first_name}}, you are booked with us (v2).'), confirmStep('Hi {{first_name}}, see you soon (v2).', 'follow', 86_400, 'previous_step')];
    const ed = await call<PB>(w.owner, 'POST', `/playbooks/${pb.playbookId}/versions`, { steps: v2Steps });
    expect(ed.body.playbook.versions.map((v) => v.status)).toEqual(['approved', 'draft']);
    expect(ed.body.playbook.approvedVersionId).toBe(pb.versionId);
    for (const e of enrollments) expect((await enrollmentRow(h, e)).playbook_version_id).toBe(pb.versionId);

    const v2 = ed.body.playbook.versions[1]!;
    expect((await call(w.owner, 'POST', `/playbook-versions/${v2.id}/approve`, { attestation: 'I approve these messages.', contentSha256: v2.contentSha256 })).status).toBe(200);
    expect((await h.su.query('SELECT status FROM playbook_versions WHERE id = $1', [pb.versionId])).rows[0]).toEqual({ status: 'superseded' });
    // the migration job, in batches (the handler re-runs while `more`)
    let rounds = 0;
    for (;;) {
      rounds += 1;
      const r = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => migrateVersionEnrollments(tx, { fromVersionId: pb.versionId, toVersionId: v2.id }, now, 10), { db: h.database });
      if (!r.more) break;
    }
    expect(rounds).toBeGreaterThanOrEqual(3);
    for (const e of enrollments) expect((await enrollmentRow(h, e)).playbook_version_id).toBe(v2.id);
    // the queued v1 messages were canceled (never sent), the sent one stays sent
    for (const c of contacts.slice(1)) expect((await messagesOf(h, c.id)).map((m) => `${m.status}:${m.status_reason}`)).toEqual(['canceled:PLAYBOOK_VERSION_REPLACED']);
    // at the step boundary the step is rebuilt from v2; the contact whose step 1 went out continues at step 2
    expect((await enrollmentRow(h, enrollments[0]!)).current_step).toBe(1);
    await stepNow(h, w.tenantId, enrollments[1]!);
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    const rebuilt = (await messagesOf(h, contacts[1]!.id)).find((m) => m.status === 'queued')!;
    expect(rebuilt.body).toContain('(v2)');
    expect(rebuilt.body).not.toContain('(v1)');
  });

  it('R-AST-4 E32 R-GATE-4: revoking pauses every enrollment on the version, cancels queued steps, and the DB guard refuses a send that bypasses dispatchOutbound', async () => {
    const pb = await approvedPlaybook(w.owner, { kind: 'booking_confirmation', scope: 'team', name: 'Revocable', steps: [confirmStep('Hi {{first_name}}, you are confirmed with us.')] });
    const a = await ownedContact(w.agents[0]!);
    const b = await ownedContact(w.agents[0]!);
    const ea = (await call<{ enrollment: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${a.id}/enrollments`, { playbookId: pb.playbookId })).body.enrollment.id;
    const eb = (await call<{ enrollment: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${b.id}/enrollments`, { playbookId: pb.playbookId })).body.enrollment.id;
    await runJobs(h, w.tenantId, ['playbook.step'], 3, ['default']);
    const ma = (await messagesOf(h, a.id))[0]!;
    const mb = (await messagesOf(h, b.id))[0]!;
    expect([ma.status, mb.status]).toEqual(['queued', 'queued']);
    const v = (await h.su.query<{ content_sha256: string }>('SELECT content_sha256 FROM playbook_versions WHERE id = $1', [pb.versionId])).rows[0]!;
    const r = await call(w.owner, 'POST', `/playbook-versions/${pb.versionId}/revoke`, { attestation: 'Stop these messages now.', contentSha256: v.content_sha256 });
    expect(r.status).toBe(200);
    expect((await auditRows(h, w.tenantId, 'playbook.revoked')).some((x) => x.entity_id === pb.versionId)).toBe(true);
    // from the revoke commit on, the dispatch guard refuses it, even written straight at the table (R-GATE-4)
    await expect(
      withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${ma.id}`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/PLAYBOOK_NOT_APPROVED/);
    // and dispatchOutbound's own send-time check blocks it (the provider is never called)
    const before = h.providers.telephony.sms.length;
    const d = await dispatchOutbound(ma.id, depsOf(h), { tenantId: w.tenantId });
    expect(d.kind).toBe('blocked');
    expect((await decisionsFor(h, { messageId: ma.id })).at(-1)!.reason_codes).toContain('PLAYBOOK_NOT_APPROVED');
    expect(h.providers.telephony.sms.length).toBe(before);
    // the revocation job pauses every enrollment on the version and cancels the queued step messages
    const p = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => pauseRevokedEnrollments(tx, pb.versionId, now), { db: h.database });
    expect(p.paused).toBe(2);
    for (const e of [ea, eb]) expect(await enrollmentRow(h, e)).toMatchObject({ state: 'paused', pause_reason: 'approval_revoked' });
    expect((await messageRow(h, mb.id)).status).toBe('canceled');
    // a re-run is a no-op (idempotent), and a revoked enrollment is not resumable here
    expect((await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => pauseRevokedEnrollments(tx, pb.versionId, now), { db: h.database })).paused).toBe(0);
    expect((await call(w.agents[0]!, 'POST', `/enrollments/${ea}/resume`)).code).toBe('ENROLLMENT_NOT_RESUMABLE');
  });
});
