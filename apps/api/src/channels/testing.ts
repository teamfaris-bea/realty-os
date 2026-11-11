// Test helpers for module 22's channels (imported by *.test.ts only). Public chat calls go through the real server
// exactly as a website's widget would (no cookie; an Origin header; the visitor's IP); staff calls as app_user.
import { createHash, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { freshReauth } from '../admin/testing.js';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call } from '../comms/testing.js';
import { command } from '../leads/testing.js';

export const SITE = 'https://www.team-site.test';
export const CHAT_DISCLOSURE = 'You are chatting with our team. An automated assistant may answer first and says so; a person on the team follows up.';

/** A lead source "Website chat" whose consent disclosure is the chat disclosure (what the widget shows first). */
export async function chatSource(h: ApiHarness, owner: TestClient, tenantId: string, name = 'Website chat'): Promise<{ sourceId: string; disclosureId: string }> {
  await freshReauth(h, owner);
  const src = await call<{ source: { id: string } }>(owner, 'POST', '/lead-sources', { name, kind: 'website' });
  if (src.status !== 201) throw new Error(`lead source: ${src.status}`);
  const disclosureId = randomUUID();
  const body = `${CHAT_DISCLOSURE} (${randomUUID().slice(0, 6)})`;
  await h.su.query(
    "INSERT INTO consent_disclosures (tenant_id, id, channel_scope, purpose_scope, body, body_sha256, names_seller, source_kind) VALUES ($1,$2,ARRAY['sms'],ARRAY['informational'],$3,$4,'The team','own_form')",
    [tenantId, disclosureId, body, createHash('sha256').update(body).digest('hex')],
  );
  await h.su.query('UPDATE lead_sources SET consent_disclosure_id = $2 WHERE id = $1', [src.body.source.id, disclosureId]);
  return { sourceId: src.body.source.id, disclosureId };
}

export interface WidgetBody {
  widget: { id: string; status: string; allowedOrigins: string[]; sentence: string };
  widgetKey: string;
}

export async function createWidget(h: ApiHarness, owner: TestClient, sourceId: string, allowedOrigins: string[] = [SITE]): Promise<{ id: string; key: string }> {
  await freshReauth(h, owner);
  const r = await call<WidgetBody>(owner, 'POST', '/admin/web-chat/widgets', { displayName: 'Website chat', leadSourceId: sourceId, allowedOrigins });
  if (r.status !== 200) throw new Error(`widget: ${r.status} ${r.code}`);
  return { id: r.body.widget.id, key: r.body.widgetKey };
}

let ipSeq = 10;
/** a fresh visitor IP (each test gets its own rate-limit bucket unless it asks for one) */
export function visitorIp(): string {
  ipSeq += 1;
  return `198.51.100.${ipSeq % 250}`;
}

export interface ChatOpts {
  origin?: string | null;
  ip?: string;
}

function headers(o: ChatOpts, json = true): Record<string, string> {
  const out: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
  if (o.origin !== null) out.origin = o.origin ?? SITE;
  return out;
}

export function chatConfig(h: ApiHarness, key: string, o: ChatOpts = {}): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: 'GET', url: `/api/public/chat/${key}`, headers: headers(o, false), remoteAddress: o.ip ?? visitorIp() });
}

export function startChat(h: ApiHarness, key: string, body: Record<string, unknown> | string, o: ChatOpts = {}): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: 'POST', url: `/api/public/chat/${key}/start`, headers: headers(o), payload: typeof body === 'string' ? body : JSON.stringify(body), remoteAddress: o.ip ?? visitorIp() });
}

export function chatMessage(h: ApiHarness, token: string, body: Record<string, unknown> | string, o: ChatOpts = {}): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: 'POST', url: `/api/public/chat/session/${token}/messages`, headers: headers(o), payload: typeof body === 'string' ? body : JSON.stringify(body), remoteAddress: o.ip ?? visitorIp() });
}

export function chatPoll(h: ApiHarness, token: string, after?: string, o: ChatOpts = {}): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: 'GET', url: `/api/public/chat/session/${token}/poll${after !== undefined ? `?after=${encodeURIComponent(after)}` : ''}`, headers: headers(o, false), remoteAddress: o.ip ?? visitorIp() });
}

export const codeOf = (r: LightMyRequestResponse): string | null => {
  try {
    return (JSON.parse(r.body) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    return null;
  }
};

/** Starts a chat and returns the session token and its new contact. */
export async function openChat(h: ApiHarness, key: string, disclosureId: string, o: { name?: string; phone?: string; email?: string; message?: string } & ChatOpts = {}): Promise<{ token: string; contactId: string; sessionId: string }> {
  const claim = o.email !== undefined ? { email: o.email } : { phone: o.phone ?? '+14155550123' };
  const r = await startChat(h, key, { name: o.name ?? 'Visitor Vee', ...claim, message: o.message ?? 'Hi, is the house on Elm still available?', disclosureId }, o);
  if (r.statusCode !== 200) throw new Error(`start chat: ${r.statusCode} ${r.body}`);
  const token = (JSON.parse(r.body) as { sessionToken: string }).sessionToken;
  const s = (await h.su.query<{ id: string; contact_id: string }>('SELECT id, contact_id FROM webchat_sessions WHERE token_hash = $1', [createHash('sha256').update(`webchat-session\n${token}`, 'utf8').digest()])).rows[0]!;
  return { token, contactId: s.contact_id, sessionId: s.id };
}

export async function pollBody(h: ApiHarness, token: string, after?: string): Promise<{ messages: { id: string; body: string; from: string; sentAt: string }[]; cursor: string | null; open: boolean }> {
  const r = await chatPoll(h, token, after);
  if (r.statusCode !== 200) throw new Error(`poll: ${r.statusCode} ${r.body}`);
  return JSON.parse(r.body);
}

/** A scheduled trigger firing (module 26's shape) for the contact. */
export async function scheduledTriggerRun(h: ApiHarness, tenantId: string, contactId: string, versionId: string): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    "INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref) VALUES ($1,$2,NULL,$3,'price_drop','scheduled',now() + interval '1 hour',$4,$5,$6)",
    [tenantId, id, versionId, contactId, `test:${id}`, JSON.stringify({ kind: 'price_drop', listing_id: randomUUID() })],
  );
  return id;
}

export async function pointsOf(h: ApiHarness, contactId: string): Promise<{ kind: string; address: string }[]> {
  return (await h.su.query<{ kind: string; address: string }>('SELECT kind, address FROM contact_points WHERE contact_id = $1 ORDER BY kind, address', [contactId])).rows;
}

/** The agent the routing offered the lead to accepts it (the ownership engine); returns that agent. */
export async function acceptLead(h: ApiHarness, agents: TestClient[], contactId: string): Promise<TestClient> {
  const st = (await h.su.query<{ offered_to_user_id: string | null; offer_id: string | null; owner_user_id: string | null }>('SELECT offered_to_user_id, offer_id, owner_user_id FROM contacts WHERE id = $1', [contactId])).rows[0]!;
  if (st.owner_user_id) return agents.find((a) => a.userId === st.owner_user_id)!;
  const agent = agents.find((a) => a.userId === st.offered_to_user_id);
  if (!agent || !st.offer_id) throw new Error('no open offer');
  const r = await command(agent, contactId, 'accept', { offerId: st.offer_id });
  if (r.status !== 200) throw new Error(`accept: ${r.status}`);
  return agent;
}
