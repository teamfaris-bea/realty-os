// Adversarial checks of api/assistant (verifier pass): cross-contact data in autonomous messages,
// in-flight sends the agent believes were stopped, idempotency of approve and enrichment, dead cards.
// Real Postgres (per-file DB), the real server, fake providers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { withTenantTx } from '@realty/db';
import { enrichHandback } from './handbacks.js';
import { sendDueAlertsInTx } from './searches.js';
import {
  type ApprovedPlaybook,
  type AssistantWorld,
  actionsOf,
  appointment,
  approvedPlaybook,
  assistantWorld,
  call,
  decisionsFor,
  depsOf,
  inboundSms,
  listing,
  messageRow,
  messagesOf,
  ownedContact,
  runJobs,
  smsStep,
} from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let confirm: ApprovedPlaybook;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2, teamLead: true });
  confirm = await approvedPlaybook(w.owner, {
    kind: 'booking_confirmation',
    scope: 'team',
    name: 'Confirm',
    steps: [
      smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, you are set for {{appointment_time}} at {{appointment_place}}.', slots: ['first_name', 'appointment_time', 'appointment_place'] }),
    ],
  });
});
afterAll(async () => {
  await h?.close();
});

describe('enrollment anchors are bound to the enrolled contact', () => {
  it('R-TEN-3 R-PERM-5: an agent cannot anchor an enrollment to another contact\'s appointment (whose details would go into this contact\'s text)', async () => {
    const mine = await ownedContact(w.agents[0]!);
    const theirs = await ownedContact(w.agents[1]!);
    const secret = await appointment(h, w, theirs.id, w.agents[1]!.userId!, { location: '42 Private Lane' });
    const r = await call(w.agents[0]!, 'POST', `/contacts/${mine.id}/enrollments`, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: secret } });
    expect(r.status).toBe(404);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect((await messagesOf(h, mine.id)).some((m) => m.body.includes('Private Lane'))).toBe(false);
    // even the same agent's other contact's appointment is not this contact's event
    const other = await ownedContact(w.agents[0]!);
    const otherAppt = await appointment(h, w, other.id, w.agents[0]!.userId!, { location: 'Elsewhere' });
    expect((await call(w.agents[0]!, 'POST', `/contacts/${mine.id}/enrollments`, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: otherAppt } })).status).toBe(404);
  });
});

describe('autonomous messages are stopped by pausing the playbook, not by a card', () => {
  it('R-GATE-4 R-AST-9: an in-flight autonomous message is not an inbox card and cannot be "rejected" while it still goes out', async () => {
    const c = await ownedContact(w.agents[0]!);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    const e = await call<{ enrollment: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
    expect(e.status).toBe(201);
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']); // queued, not yet dispatched
    const auto = (await actionsOf(h, c.id)).find((a) => a.kind === 'autonomous_message')!;
    expect(auto.status).toBe('proposed');
    const inbox = await call<{ items: { id: string }[] }>(w.agents[0]!, 'GET', '/assistant/inbox');
    expect(inbox.body.items.map((x) => x.id)).not.toContain(auto.id);
    const rej = await call<{ error: { code: string } }>(w.agents[0]!, 'POST', `/assistant/actions/${auto.id}/reject`);
    expect(rej.status).toBe(409);
    expect(rej.body.error.code).toBe('ACTION_NOT_PENDING');
    expect((await actionsOf(h, c.id)).find((a) => a.id === auto.id)!.status).toBe('proposed');
  });
});

describe('approve is idempotent across a failure between the tap and the queue', () => {
  it('R-AST-6 R-GATE-4: a re-tap after the approval committed but the message was never queued sends it (not a silent "acknowledged")', async () => {
    const c = await ownedContact(w.agents[0]!);
    await inboundSms(h, c.phone, w.mainNumber, 'Is the house on Pine still available?');
    const d = await call<{ action: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() });
    expect(d.status).toBe(200);
    const id = d.body.action.id;
    // state after TX-U committed and the worker died before TX-S (fixture: the decision row as TX-U writes it)
    await h.su.query("UPDATE assistant_actions SET status = 'approved', decided_by_user_id = $2, decided_at = now() WHERE id = $1", [id, w.agents[0]!.userId]);
    expect((await messagesOf(h, c.id)).filter((m) => m.initiator === 'assistant')).toHaveLength(0);
    const r = await call<{ result: string; messageId: string | null }>(w.agents[0]!, 'POST', `/assistant/actions/${id}/approve`, { commandId: randomUUID() });
    expect(r.status).toBe(200);
    expect(r.body.messageId).not.toBeNull();
    expect(r.body.result).toBe('sent');
    expect((await messageRow(h, r.body.messageId!)).status).toBe('sent');
    // and a third tap is a no-op on the same message
    const again = await call<{ result: string; messageId: string | null }>(w.agents[0]!, 'POST', `/assistant/actions/${id}/approve`, { commandId: randomUUID() });
    expect(again.body).toMatchObject({ result: 'noop', messageId: r.body.messageId });
    expect((await messagesOf(h, c.id)).filter((m) => m.initiator === 'assistant')).toHaveLength(1);
  });
});

describe('handback enrichment is idempotent', () => {
  it('R-AST-9: two concurrent enrichment runs (a reaped job re-run while the first is in flight) append the suggestions once', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const appt = await appointment(h, w, c.id, agent.userId!);
    await call(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Could we move it to 5 pm?')).statusCode).toBe(200);
    const hb = (await actionsOf(h, c.id)).find((a) => a.kind === 'handback')!;
    const before = (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_claims WHERE action_id = $1', [hb.id])).rows[0]!.n;
    const actor = systemActor(w.tenantId, 'assistant');
    await Promise.all([enrichHandback(actor, hb.id, depsOf(h)), enrichHandback(actor, hb.id, depsOf(h))]);
    const dup = await h.su.query('SELECT claim_kind, text, count(*)::int AS n FROM assistant_claims WHERE action_id = $1 GROUP BY 1, 2 HAVING count(*) > 1', [hb.id]);
    expect(dup.rows).toEqual([]);
    const after = (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_claims WHERE action_id = $1', [hb.id])).rows[0]!.n;
    expect(after).toBeGreaterThan(before);
    // a later retry adds nothing
    expect(await enrichHandback(actor, hb.id, depsOf(h))).toEqual({ kind: 'skipped', reason: 'ALREADY_ENRICHED' });
  });
});

describe('drafts are only made for someone who can send them', () => {
  it('R-AST-7: a Team Lead asking for a draft on a team member\'s contact gets a clear refusal, not a card that can never be sent', async () => {
    const c = await ownedContact(w.agents[0]!);
    await inboundSms(h, c.phone, w.mainNumber, 'Are you free this weekend?');
    const r = await call<{ error: { code: string } }>(w.teamLead!, 'POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DRAFT_OWNER_ONLY');
    expect((await actionsOf(h, c.id)).filter((a) => a.kind === 'message_draft')).toEqual([]);
    // the owner can
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() })).status).toBe(200);
  });
});

describe('pausing a saved search stops alerts already queued', () => {
  it('R-AST-10 R-GATE-3: an alert queued before the agent tapped pause is canceled and never reaches the gate; the match is alerted again only after resuming', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const hit = await listing(h, w, agent.userId!, { postalCode: '94110', priceCents: 70_000_000 });
    const searchId = randomUUID();
    await h.su.query(
      `INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'Mission','proposed','{"postalCodes":["94110"]}'::jsonb,'{}'::jsonb)`,
      [w.tenantId, searchId, c.id],
    );
    expect((await call(agent, 'POST', `/saved-searches/${searchId}/approve`, { checked: [] })).status).toBe(200);
    expect((await call(agent, 'POST', `/saved-searches/${searchId}/activate`)).status).toBe(200);
    const queued = (await messagesOf(h, c.id)).filter((m) => m.action_category === 'search_alert');
    expect(queued).toHaveLength(1);
    expect(['queued', 'scheduled']).toContain(queued[0]!.status);
    expect((await call(agent, 'POST', `/saved-searches/${searchId}/pause`)).status).toBe(200);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, queued[0]!.id);
    expect(m.status).toBe('canceled');
    expect(await decisionsFor(h, { messageId: queued[0]!.id })).toEqual([]);
    expect((await h.su.query('SELECT alerted_message_id FROM saved_search_matches WHERE search_id = $1 AND listing_id = $2', [searchId, hit])).rows).toEqual([{ alerted_message_id: null }]);
    // resuming alerts the released match again, as a new message
    expect((await call(agent, 'POST', `/saved-searches/${searchId}/activate`)).status).toBe(200);
    const again = (await messagesOf(h, c.id)).filter((x) => x.action_category === 'search_alert' && x.id !== queued[0]!.id);
    expect(again).toHaveLength(1);
    expect((await h.su.query('SELECT alerted_message_id FROM saved_search_matches WHERE search_id = $1 AND listing_id = $2', [searchId, hit])).rows).toEqual([{ alerted_message_id: again[0]!.id }]);
  });
});

describe('a step in flight when a new version is approved is not lost', () => {
  it('R-AST-4 E31: a step message of the old version that dispatch refused (version just superseded) is rebuilt from the new version at the boundary, sent once', async () => {
    const pb = await approvedPlaybook(w.owner, {
      kind: 'booking_confirmation',
      scope: 'team',
      name: 'Confirm v',
      steps: [smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, version one: {{appointment_time}}.', slots: ['first_name', 'appointment_time'] })],
    });
    const c = await ownedContact(w.agents[0]!);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: pb.playbookId, anchor: { kind: 'appointment', id: appt } })).status).toBe(201);
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    expect((await messagesOf(h, c.id)).map((m) => m.status)).toEqual(['queued']);
    const v2 = await call<{ playbook: { versions: { id: string; status: string; contentSha256: string }[] } }>(w.owner, 'POST', `/playbooks/${pb.playbookId}/versions`, {
      steps: [smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, version two: {{appointment_time}}.', slots: ['first_name', 'appointment_time'] })],
    });
    const draft = v2.body.playbook.versions.find((v) => v.status === 'draft')!;
    expect((await call(w.owner, 'POST', `/playbook-versions/${draft.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: draft.contentSha256 })).status).toBe(200);
    // dispatch wins the race against the migration job: the v1 message is refused at send time
    await runJobs(h, w.tenantId, ['comms.dispatch'], 1, ['realtime']);
    expect((await messagesOf(h, c.id)).map((m) => `${m.status}:${m.status_reason}`)).toEqual(['blocked:PLAYBOOK_NOT_APPROVED']);
    await runJobs(h, w.tenantId, ['assistant.playbook_migrate', 'playbook.step', 'comms.dispatch'], 4);
    const sent = (await messagesOf(h, c.id)).filter((m) => m.status === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('version two');
  });
});

describe('tenant isolation of every assistant route', () => {
  it('R-PERM-5 R-TEN-1: another tenant\'s staff (even its Owner) sees 404 for this tenant\'s cards, claims, playbooks, versions, enrollments and searches, and cannot run them on its own contacts', async () => {
    const other = await assistantWorld(h, { agents: 1 });
    const c = await ownedContact(w.agents[0]!);
    await inboundSms(h, c.phone, w.mainNumber, 'Can we see the Pine St house Saturday?');
    const d = await call<{ action: { id: string; claims: { id: string }[] } }>(w.agents[0]!, 'POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() });
    expect(d.status).toBe(200);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    const e = await call<{ enrollment: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
    const searchId = randomUUID();
    await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'S','proposed','{"postalCodes":["94110"]}'::jsonb,'{}'::jsonb)`, [w.tenantId, searchId, c.id]);
    const theirs = await ownedContact(other.agents[0]!);
    const att = { attestation: 'I reviewed these messages and approve them.', contentSha256: confirm.sha };
    for (const who of [other.owner, other.agents[0]!]) {
      const probes: [string, string, unknown?][] = [
        ['GET', `/assistant/actions/${d.body.action.id}`],
        ['POST', `/assistant/actions/${d.body.action.id}/approve`, { commandId: randomUUID() }],
        ['POST', `/assistant/actions/${d.body.action.id}/reject`],
        ['GET', `/playbooks/${confirm.playbookId}`],
        ['POST', `/playbooks/${confirm.playbookId}/versions`, { steps: [smsStep({ category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi' })] }],
        ['POST', `/playbook-versions/${confirm.versionId}/revoke`, att],
        ['POST', `/enrollments/${e.body.enrollment.id}/pause`],
        ['POST', `/enrollments/${e.body.enrollment.id}/stop`],
        ['POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() }],
        ['GET', `/saved-searches/${searchId}/preview`],
        ['POST', `/saved-searches/${searchId}/approve`, { checked: [] }],
        // its own contact, this tenant's playbook / appointment
        ['POST', `/contacts/${theirs.id}/enrollments`, { playbookId: confirm.playbookId }],
      ];
      for (const claim of d.body.action.claims) probes.push(['POST', `/assistant/claims/${claim.id}/review`, { status: 'confirmed' }]);
      for (const [method, path, body] of probes) expect((await call(who, method as 'GET', path, body as never)).status, `${method} ${path}`).toBe(404);
    }
    const mine = await approvedPlaybook(other.owner, { kind: 'booking_confirmation', scope: 'team', name: 'Theirs', steps: [smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, {{appointment_place}}.', slots: ['first_name', 'appointment_place'] })] });
    expect((await call(other.agents[0]!, 'POST', `/contacts/${theirs.id}/enrollments`, { playbookId: mine.playbookId, anchor: { kind: 'appointment', id: appt } })).status).toBe(404);
    // nothing changed on this tenant's side
    expect((await h.su.query('SELECT status FROM assistant_actions WHERE id = $1', [d.body.action.id])).rows[0].status).toBe('proposed');
    expect((await h.su.query('SELECT status FROM playbook_versions WHERE id = $1', [confirm.versionId])).rows[0].status).toBe('approved');
    expect((await h.su.query('SELECT state FROM playbook_enrollments WHERE id = $1', [e.body.enrollment.id])).rows[0].state).toBe('active');
  });
});

describe('role and ownership boundaries', () => {
  it('R-PERM-5 R-AST-4: another agent cannot steer, approve or review this agent\'s assistant work; agents cannot create, edit, approve or revoke team playbooks', async () => {
    const c = await ownedContact(w.agents[0]!);
    await inboundSms(h, c.phone, w.mainNumber, 'Is Sunday at 2 ok?');
    const d = await call<{ action: { id: string; claims: { id: string }[] } }>(w.agents[0]!, 'POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() });
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    const e = await call<{ enrollment: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
    expect(e.status).toBe(201);
    const peer = w.agents[1]!;
    const att = { attestation: 'I reviewed these messages and approve them.', contentSha256: confirm.sha };
    const probes: [string, string, unknown?][] = [
      ['GET', `/assistant/actions/${d.body.action.id}`],
      ['POST', `/assistant/actions/${d.body.action.id}/approve`, { commandId: randomUUID() }],
      ['POST', `/assistant/actions/${d.body.action.id}/reject`],
      ['POST', `/enrollments/${e.body.enrollment.id}/pause`],
      ['POST', `/enrollments/${e.body.enrollment.id}/stop`],
      ['POST', `/contacts/${c.id}/enrollments`, { playbookId: confirm.playbookId, confirmReplace: true }],
      ['POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() }],
      ['POST', `/playbooks/${confirm.playbookId}/versions`, { steps: [smsStep({ category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi' })] }],
      ['POST', `/playbook-versions/${confirm.versionId}/revoke`, att],
    ];
    for (const claim of d.body.action.claims) probes.push(['POST', `/assistant/claims/${claim.id}/review`, { status: 'rejected' }]);
    for (const [method, path, body] of probes) expect((await call(peer, method as 'GET', path, body as never)).status, `${method} ${path}`).toBe(404);
    // creating a team playbook is Owner/Admin only (an agent gets 404, the generic denial)
    expect((await call(peer, 'POST', '/playbooks', { kind: 'nurture', scope: 'team', name: 'Mine', steps: [smsStep({ category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi' })] })).status).toBe(404);
    // the Team Lead may pause a team member's enrollment (send rights on the team), but never approve the agent's own draft
    expect((await call(w.teamLead!, 'POST', `/assistant/actions/${d.body.action.id}/approve`, { commandId: randomUUID() })).status).toBe(404);
    expect((await call(w.teamLead!, 'POST', `/enrollments/${e.body.enrollment.id}/pause`)).status).toBe(200);
    expect((await h.su.query('SELECT status FROM assistant_actions WHERE id = $1', [d.body.action.id])).rows[0].status).toBe('proposed');
  });
});

describe('a corrected date is shown in the client\'s time zone', () => {
  it('R-AST-2: the agent corrects a date to 4 PM Pacific for a Pacific client; the card shows "Thu Nov 12, 4 PM", not a UTC timestamp of the next day', async () => {
    const c = await ownedContact(w.agents[0]!);
    await h.su.query("UPDATE contacts SET timezone = 'America/Los_Angeles', timezone_source = 'explicit' WHERE id = $1", [c.id]);
    await inboundSms(h, c.phone, w.mainNumber, 'We want a 3 bedroom, call me Thursday afternoon.');
    const d = await call<{ action: { id: string; claims: { id: string }[] } }>(w.agents[0]!, 'POST', `/contacts/${c.id}/drafts`, { commandId: randomUUID() });
    const [first, second] = d.body.action.claims;
    expect(first && second).toBeTruthy();
    expect((await call(w.agents[0]!, 'POST', `/assistant/claims/${first!.id}/review`, { status: 'corrected', corrected: { dueAt: '2026-11-12T16:00:00-08:00' } })).status).toBe(200);
    expect((await call(w.agents[0]!, 'POST', `/assistant/claims/${second!.id}/review`, { status: 'corrected', corrected: { dueAt: '2026-11-12T00:00:00-08:00', allDay: true } })).status).toBe(200);
    const card = (await call<{ action: { claims: { id: string; due: { display: string; allDay: boolean } | null }[] } }>(w.agents[0]!, 'GET', `/assistant/actions/${d.body.action.id}`)).body.action;
    expect(card.claims.find((x) => x.id === first!.id)!.due).toMatchObject({ display: 'Thu Nov 12, 4 PM', allDay: false });
    expect(card.claims.find((x) => x.id === second!.id)!.due).toMatchObject({ display: 'Thu Nov 12', allDay: true });
  });
});

describe('alert digests that are not due do not starve the ones that are', () => {
  it('R-AST-10: a batch full of daily searches already alerted today still lets an instant search with a new match alert', async () => {
    const agent = w.agents[0]!;
    const waiting = await ownedContact(agent); // created first: its id sorts first in the batch
    const instant = await ownedContact(agent);
    const l = await listing(h, w, agent.userId!, { postalCode: '94110' });
    const mk = async (contactId: string, freq: string, lastAlerted: string | null) => {
      const id = randomUUID();
      await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'S','proposed','{"postalCodes":["94110"]}'::jsonb,'{}'::jsonb)`, [w.tenantId, id, contactId]);
      expect((await call(agent, 'POST', `/saved-searches/${id}/approve`, { checked: [], alertFrequency: freq })).status).toBe(200);
      await h.su.query(`UPDATE saved_searches SET status = 'active', activated_at = now(), last_alerted_at = $2 WHERE id = $1`, [id, lastAlerted]);
      await h.su.query('INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES ($1,$2,$3, now())', [w.tenantId, id, l]);
      return id;
    };
    await mk(waiting.id, 'daily', new Date(Date.now() - 3_600_000).toISOString());
    const due = await mk(instant.id, 'instant', null);
    const n = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => sendDueAlertsInTx(tx, depsOf(h), w.tenantId, now, { limit: 1 }), { db: h.database });
    expect(n).toBe(1);
    expect((await h.su.query('SELECT alerted_message_id IS NOT NULL AS x FROM saved_search_matches WHERE search_id = $1', [due])).rows).toEqual([{ x: true }]);
    expect((await messagesOf(h, waiting.id)).filter((m) => m.action_category === 'search_alert')).toEqual([]);
  });
});
