// Test helpers for the parity module 63 integration tests (imported by *.test.ts only). Everything the
// application does goes through the real server as app_user; the superuser pool only reads back and sets
// fixtures with no application path in this lane (the brokerage postal address).
import { randomUUID } from 'node:crypto';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { type CommsWorld, call, freshReauth } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';

/** A verified sending domain, an email identity per agent on it, and the brokerage postal address (R-PAR-39). */
export async function marketingReady(h: ApiHarness, w: CommsWorld): Promise<void> {
  const domain = `mail-${randomUUID().slice(0, 6)}.bulk.test`;
  h.providers.email.verifiedDomains.add(domain);
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  const people = [...w.agents, ...(w.teamLead ? [w.teamLead] : []), w.owner, ...w.others];
  for (const a of people) {
    const r = await call(w.owner, 'POST', '/email-identities', { fromAddress: `a-${randomUUID().slice(0, 6)}@${domain}`, displayName: 'Agent', userId: a.userId, domainId: dom.body.domain.id });
    if (r.status !== 201) throw new Error(`identity: ${r.status} ${JSON.stringify(r.body)}`);
  }
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
}

import { BATCH_TEXT_ATTESTATION } from './batchText.js';

export { BATCH_TEXT_ATTESTATION };

/** The Owner turns batch text on through the real route (re-auth + typed attestation). */
export async function batchTextOn(h: ApiHarness, owner: TestClient): Promise<void> {
  await freshReauth(h, owner);
  const r = await call(owner, 'PUT', '/batch-text', { enabled: true, attestation: BATCH_TEXT_ATTESTATION });
  if (r.status !== 200) throw new Error(`batch text on: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function batchTextOff(owner: TestClient): Promise<void> {
  const r = await call(owner, 'PUT', '/batch-text', { enabled: false });
  if (r.status !== 200) throw new Error(`batch text off: ${r.status} ${JSON.stringify(r.body)}`);
}

export interface ActionView {
  id: string;
  kind: string;
  status: string;
  selected: number;
  targetCount: number;
  counts: { done: number; skipped: number; blocked: number; failed: number; canceled: number; pending: number; byReason: Record<string, number> };
  preflight: Record<string, number>;
  sharedAddresses: number;
  failureCode: string | null;
}

export async function draft(c: TestClient, body: Record<string, unknown>) {
  return call<{ action: ActionView }>(c, 'POST', '/bulk-actions', { idempotencyKey: `bulk-${randomUUID()}`, ...body });
}

export async function confirm(c: TestClient, id: string) {
  return call<{ action: ActionView }>(c, 'POST', `/bulk-actions/${id}/confirm`);
}

export async function itemsOf(h: ApiHarness, actionId: string): Promise<{ contact_id: string; status: string; reason_code: string | null; message_id: string | null }[]> {
  return (await h.su.query('SELECT contact_id, status, reason_code, message_id FROM bulk_action_items WHERE bulk_action_id = $1 ORDER BY contact_id', [actionId])).rows;
}

export async function actionRow(h: ApiHarness, id: string): Promise<{ status: string; counts: Record<string, unknown>; target_count: number | null; failure_code: string | null; started_at: Date | null; finished_at: Date | null }> {
  return (await h.su.query('SELECT * FROM bulk_actions WHERE id = $1', [id])).rows[0];
}
