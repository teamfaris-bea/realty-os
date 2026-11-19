// b19 Today fix 5 (M8; R-TODAY-16), over real Postgres as app_user: a card about a person the viewer CANNOT open (a pond
// member holding a task on a lead that went back to the pond) is not a follow-up card. It carries no Last line, no
// Next line and no reason sentences for the follow-up lines, offers no Call, Text, Email or Log the server would
// refuse, and names the lead as the pond card does (first name and last initial).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { createApiHarness } from '../auth/testHarness.js';
import { acceptedLead, call, command, contactState, feedOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: true });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

type Card = Record<string, unknown> & { itemType: string; contact: { id: string; name: string } | null; primaryAction: { kind: string }; alternatives: { kind: string }[] };

describe('M8 (R-TODAY-16): a card about a person the viewer cannot open', () => {
  it('a pond member holding a task on a pond lead: the masked name, no follow-up lines, no contacting action; the lead’s history is not said, and logging on them is refused as before', async () => {
    const { contactId, owner } = await acceptedLead(h, w, { fullName: 'Sol Marchetti' });
    const other = w.agents.find((a) => a.userId !== owner.userId) as TestClient;
    // the owner talks with the lead (a conversation the pond member must never be told about) and releases them
    expect((await call(owner, 'POST', `/contacts/${contactId}/activities`, { kind: 'call', direction: 'outbound', at: new Date(Date.now() - 60_000).toISOString(), outcome: 'connected', body: 'Wants a condo downtown.', noteId: randomUUID() })).status).toBe(201);
    // the other agent holds an overdue task on the lead (a Team Lead assigned it while the lead was owned)
    await h.su.query(`INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, 'todo', 'Chase the paperwork', clock_timestamp() - interval '1 minute', 'user', $3)`, [w.tenantId, randomUUID(), other.userId, contactId]);
    expect((await command(owner, contactId, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    expect((await contactState(h, contactId)).ownership_state).toBe('in_pond');

    const f = await feedOf(other);
    const cards = (f.all as unknown as Card[]).filter((c) => c.contact?.id === contactId);
    expect(cards.map((c) => c.itemType).sort()).toEqual(['pond_new', 'task_due']);
    const pond = cards.find((c) => c.itemType === 'pond_new')!;
    const task = cards.find((c) => c.itemType === 'task_due')!;
    expect(pond.contact!.name).toBe('Sol M.');
    // the same person is named the same way on both cards
    expect(task.contact!.name).toBe('Sol M.');
    expect(JSON.stringify(task)).not.toContain('Marchetti');
    // not a follow-up card: none of the lines, so the screen draws no Last, no Next and no Log
    expect(task).toMatchObject({ why: null, stage: null, lastTouch: null, lastConversation: null, quiet: null, lastAutomatic: null, importedHistoryAt: null, nextPromise: null });
    expect(JSON.stringify(task)).not.toContain('condo');
    // nothing the server would refuse is offered
    const kinds = [task.primaryAction.kind, ...task.alternatives.map((x) => x.kind)];
    for (const refused of ['call', 'text', 'email', 'reply_chat', 'send_draft']) expect(kinds).not.toContain(refused);
    // the task is still theirs to do, and the card still says what it is about
    expect(task).toMatchObject({ task: { title: 'Chase the paperwork' } });
    // (what the server refuses, as before: logging on a lead that is not theirs)
    expect((await call(other, 'POST', `/contacts/${contactId}/activities`, { kind: 'call', direction: 'outbound', at: new Date().toISOString(), outcome: 'connected', noteId: randomUUID() })).status).toBe(404);
  });

  it('the owner’s own card for a person they CAN open keeps the full name and the lines', async () => {
    const { contactId, owner } = await acceptedLead(h, w, { fullName: 'Vera Okonkwo' });
    await h.su.query(`INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, 'todo', 'Send the comps', clock_timestamp() - interval '1 minute', 'user', $3)`, [w.tenantId, randomUUID(), owner.userId, contactId]);
    const card = ((await feedOf(owner)).all as unknown as Card[]).find((c) => c.contact?.id === contactId && c.itemType === 'task_due')!;
    expect(card.contact!.name).toBe('Vera Okonkwo');
    expect(card.why).not.toBeNull();
    expect(card.stage).not.toBeNull();
    expect(card.nextPromise).toMatchObject({ text: 'Send the comps' });
  });
});
