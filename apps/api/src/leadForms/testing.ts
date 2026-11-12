// Test helpers for Google Ads lead forms (imported by *.test.ts only). Payloads are SYNTHETIC, built from the documented
// fields (leadForms/google.ts); no real Google account, campaign, customer id or key. Values are fictional (example.com).
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { call, freshReauth } from '../admin/testing.js';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';

export const WEBHOOK_URL = '/api/webhooks/google-ads/lead-form';

export interface Column {
  column_id: string;
  string_value?: unknown;
  column_name?: string;
}

export interface GooglePayloadOptions {
  key?: unknown;
  leadId?: unknown;
  isTest?: boolean;
  columns?: Column[];
  campaignId?: unknown;
  adgroupId?: unknown;
  creativeId?: unknown;
  formId?: unknown;
  gclId?: unknown;
  submitTime?: string;
  leadSource?: string;
  extra?: Record<string, unknown>;
}

let seq = 0;
/** A fictional, unique lead id in Google's shape (a long opaque token). */
export function fakeLeadId(): string {
  seq += 1;
  return `TeStLead-${Date.now().toString(36)}-${seq}-${randomUUID().replace(/-/g, '')}`;
}

/** Google-shaped lead form payload. Omitted key ⇒ no google_key field. */
export function googlePayload(o: GooglePayloadOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    lead_id: o.leadId === undefined ? fakeLeadId() : o.leadId,
    api_version: '1.0',
    form_id: o.formId === undefined ? 40000000001 : o.formId,
    campaign_id: o.campaignId === undefined ? 10000000001 : o.campaignId,
    adgroup_id: o.adgroupId === undefined ? 20000000001 : o.adgroupId,
    creative_id: o.creativeId === undefined ? 30000000001 : o.creativeId,
    gcl_id: o.gclId === undefined ? 'TeSt-gclid-0001' : o.gclId,
    is_test: o.isTest ?? false,
    user_column_data: o.columns ?? [
      { column_name: 'Full Name', string_value: 'Riley Example', column_id: 'FULL_NAME' },
      { column_name: 'User Email', string_value: `riley.${randomUUID().slice(0, 8)}@example.com`, column_id: 'EMAIL' },
    ],
    ...(o.submitTime !== undefined ? { lead_submit_time: o.submitTime } : {}),
    ...(o.leadSource !== undefined ? { lead_source: o.leadSource } : {}),
    ...o.extra,
  };
  if (o.key !== undefined) body.google_key = o.key;
  return body;
}

/** POST the payload as Google would (JSON, no auth header, no Origin). */
export async function postGoogleLead(h: ApiHarness, body: unknown, o: { ip?: string; raw?: string } = {}): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: { 'content-type': 'application/json', 'user-agent': 'Google-Ads-Lead-Test' },
    payload: o.raw ?? JSON.stringify(body),
    remoteAddress: o.ip ?? '198.51.100.20',
  });
}

export interface KeyIssued {
  key: string;
  webhookUrl: string;
  createdAt: string;
}

/** Turns a source's Google lead form on through the API (fresh re-auth first). */
export async function enableGoogleForm(h: ApiHarness, owner: TestClient, sourceId: string, body: { inquiryType?: string; citesSourceDisclosure?: boolean } = {}): Promise<KeyIssued> {
  await freshReauth(h, owner);
  const r = await call<KeyIssued>(owner, 'POST', `/lead-sources/${sourceId}/google-lead-form`, { inquiryType: 'buy', ...body });
  if (r.status !== 200) throw new Error(`enable google form: ${r.status} ${r.code}`);
  return r.body;
}

export const col = (column_id: string, string_value: unknown): Column => ({ column_id, string_value });
