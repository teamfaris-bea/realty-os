// Test helpers for the lead-email slice (imported by *.test.ts only). The provider side is the generic signed format
// (what the fake email provider posts); the application side is the real server as app_user.
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call, freshReauth } from '../admin/testing.js';
import { signedHeader } from '../providers/webhooks.js';

export interface InboxBody {
  inbox: { leadSourceId: string; enabled: boolean; connectionId: string | null; address: string | null; allowedSenderDomains: string[]; status: string | null };
}

export async function enableInbox(h: ApiHarness, owner: TestClient, sourceId: string, domains: string[] = ['zillow.com', 'realtor.com', 'portal.test']): Promise<InboxBody['inbox']> {
  await freshReauth(h, owner);
  const r = await call<InboxBody>(owner, 'POST', `/lead-sources/${sourceId}/lead-email`, { allowedSenderDomains: domains });
  if (r.status !== 200) throw new Error(`enable inbox: ${r.status} ${r.code}`);
  return r.body.inbox;
}

export interface GenericEmail {
  messageId?: string;
  from?: string;
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  dkim?: { domain: string; result: string }[];
}

/** POST /api/webhooks/lead-email/inbound, signed like the fake provider (X-Realty-Signature over the raw body). */
export async function postLeadEmail(h: ApiHarness, e: GenericEmail | string, o: { sign?: boolean; secret?: string; at?: number } = {}): Promise<LightMyRequestResponse> {
  const raw = typeof e === 'string' ? e : JSON.stringify({ messageId: `<${randomUUID()}@mail.test>`, from: 'Zillow <leads@zillow.com>', subject: 'New lead', dkim: [{ domain: 'zillow.com', result: 'pass' }], ...e });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.sign !== false) headers['x-realty-signature'] = signedHeader(o.secret ?? h.config.webhookSecrets.email, o.at ?? Math.floor(Date.now() / 1000), raw);
  return h.app.inject({ method: 'POST', url: '/api/webhooks/lead-email/inbound', headers, payload: raw });
}

export function outcomeOf(r: LightMyRequestResponse): string {
  if (r.statusCode !== 200) return `HTTP ${r.statusCode}`;
  return (JSON.parse(r.body) as { outcome: string }).outcome;
}

/** A labelled lead body (the generic format): every value is synthetic. */
export function labelledBody(o: { name?: string; email?: string; phone?: string; message?: string; property?: string } = {}): string {
  const lines = ['You have a new lead.', ''];
  if (o.name !== undefined) lines.push(`Name: ${o.name}`);
  if (o.email !== undefined) lines.push(`Email: ${o.email}`);
  if (o.phone !== undefined) lines.push(`Phone: ${o.phone}`);
  if (o.property !== undefined) lines.push(`Property: ${o.property}`);
  if (o.message !== undefined) lines.push(`Message: ${o.message}`);
  lines.push('', 'Sent by the portal. Do not reply to leads@zillow.com.');
  return lines.join('\n');
}

let emailSeq = 0;
export function leadAddress(): string {
  emailSeq += 1;
  return `lead.${Date.now().toString(36)}.${emailSeq}@example.test`;
}

export async function messageRows(h: ApiHarness, tenantId: string): Promise<{ id: string; status: string; hold_code: string | null; contact_id: string | null; parser_kind: string | null; sender_domain: string | null; content_enc: Buffer | null }[]> {
  return (await h.su.query('SELECT id, status, hold_code, contact_id, parser_kind, sender_domain, content_enc FROM lead_email_messages WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId])).rows;
}

export async function contactsWith(h: ApiHarness, tenantId: string, address: string): Promise<string[]> {
  return (await h.su.query<{ contact_id: string }>('SELECT DISTINCT contact_id FROM contact_points WHERE tenant_id = $1 AND lower(address) = lower($2)', [tenantId, address])).rows.map((r) => r.contact_id);
}

export async function contactCount(h: ApiHarness, tenantId: string): Promise<number> {
  return (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenantId])).rows[0]!.n;
}
