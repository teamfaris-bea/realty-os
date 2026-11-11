// Test helpers for the api/workspace integration tests (imported by *.test.ts only).
//
// Everything the application does goes through the real server (or this module's public functions) as
// app_user (RLS-bound). The superuser pool only reads state back, moves clocks (an appointment that ended
// hours ago, an overdue task), and inserts rows that have no application path in Phase 1.
import { randomUUID } from 'node:crypto';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call, freshReauth, registerPush, res } from '../admin/testing.js';
import { ownedContact, randomEmail } from '../comms/testing.js';
import { type LeadsWorld, type WorldOptions, command, contactState, intake, leadsWorld, randomPhone } from '../leads/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import type { DeliveryDeps } from './notifications.js';

export { call, command, contactState, freshReauth, intake, ownedContact, randomEmail, randomPhone, registerPush, res };

export type WorkspaceWorld = LeadsWorld & { others: TestClient[] };

export async function workspaceWorld(h: ApiHarness, o: WorldOptions = {}): Promise<WorkspaceWorld> {
  return leadsWorld(h, { agents: 2, teamLead: true, ...o });
}

/** An intake lead offered to an agent and accepted by them: owned, with a first-touch SLA period. */
export async function acceptedLead(h: ApiHarness, w: WorkspaceWorld, body: Record<string, unknown> = {}): Promise<{ contactId: string; owner: TestClient }> {
  const { contactId } = await intake(h, w, body);
  const c = await contactState(h, contactId);
  const owner = [...w.agents, ...(w.teamLead ? [w.teamLead] : [])].find((a) => a.userId === c.offered_to_user_id);
  if (!owner || !c.offer_id) throw new Error(`lead not offered: ${c.ownership_state}`);
  const r = await command(owner, contactId, 'accept', { offerId: c.offer_id });
  if (r.status !== 200) throw new Error(`accept: ${r.status} ${JSON.stringify(r.body)}`);
  return { contactId, owner };
}

/** A contact the agent creates (owned by them, no SLA), without consent rows. */
export async function contactOf(agent: TestClient, o: { firstName?: string; phone?: string; email?: string } = {}): Promise<{ id: string; phone: string; email: string }> {
  return ownedContact(agent, { consent: false, ...o });
}

export interface FeedCardT {
  id: string;
  itemType: string;
  band: string;
  contact: { id: string; name: string } | null;
  reasons: { code: string; label: string }[];
  primaryAction: { kind: string; label: string; [k: string]: unknown };
  alternatives: { kind: string; [k: string]: unknown }[];
  subjectId: string;
  /** a task or promise card: the task's own title */
  task?: { id: string; title: string } | null;
}

export async function feedOf(c: TestClient): Promise<{ pinned: FeedCardT[]; scored: FeedCardT[]; total: number; all: FeedCardT[] }> {
  const r = await call<{ pinned: FeedCardT[]; scored: FeedCardT[]; total: number }>(c, 'GET', '/feed');
  if (r.status !== 200) throw new Error(`feed: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body, all: [...r.body.pinned, ...r.body.scored] };
}

/** Superuser clock fixture: a task row already due (or overdue by `overdueMs`). */
export async function taskDueNow(h: ApiHarness, taskId: string, overdueMs = 60_000): Promise<void> {
  await h.su.query(`UPDATE tasks SET due_at = clock_timestamp() - ($2::int * interval '1 millisecond') WHERE id = $1`, [taskId, overdueMs]);
}

/** Superuser clock fixture: an appointment that started and ended in the past. */
export async function appointmentEnded(h: ApiHarness, id: string, endedMsAgo: number): Promise<void> {
  await h.su.query(
    `UPDATE appointments SET starts_at = clock_timestamp() - (($2::int + 3600000) * interval '1 millisecond'), ends_at = clock_timestamp() - ($2::int * interval '1 millisecond') WHERE id = $1`,
    [id, endedMsAgo],
  );
}

export function deliveryDeps(h: ApiHarness, extra: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return { ...depsFromPlatform(h.app.platform), ...extra };
}

export const uuid = () => randomUUID();
