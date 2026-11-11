// Test helpers for api/integrations (imported by *.test.ts only). The provider side is driven through
// the deterministic fake (FakeOAuth.issueCode), the application side through the real server as app_user.
import { randomUUID } from 'node:crypto';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import type { FakeGrantAccount } from '../providers/integrations/fakes.js';
import { call, freshReauth } from '../admin/testing.js';

export async function leadSource(h: ApiHarness, tenantId: string, name = `Social ${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await h.su.query("INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES ($1, $2, $3, 'social_dm')", [tenantId, id, name]);
  return id;
}

export interface StartedFlow {
  status: number;
  code: string | null;
  connectionId: string;
  state: string;
  challenge: string;
  authorizeUrl: string;
}

export async function startFlow(c: TestClient, kind: string, body: Record<string, unknown>, o: { reauth?: ApiHarness } = {}): Promise<StartedFlow> {
  if (o.reauth) await freshReauth(o.reauth, c);
  const r = await call<{ connectionId: string; authorizeUrl: string }>(c, 'POST', `/admin/integrations/${kind}/connect`, body);
  if (r.status !== 201) return { status: r.status, code: r.code, connectionId: '', state: '', challenge: '', authorizeUrl: '' };
  const u = new URL(r.body.authorizeUrl);
  return { status: r.status, code: null, connectionId: r.body.connectionId, state: u.searchParams.get('state')!, challenge: u.searchParams.get('code_challenge')!, authorizeUrl: r.body.authorizeUrl };
}

export async function callback(h: ApiHarness, kind: string, q: Record<string, string>): Promise<{ status: number; result: string | null; connection: string | null; location: string }> {
  const qs = new URLSearchParams(q).toString();
  const r = await h.app.inject({ method: 'GET', url: `/api/admin/integrations/${kind}/callback?${qs}` });
  const loc = String(r.headers.location ?? '');
  const u = loc ? new URL(loc) : null;
  return { status: r.statusCode, result: u?.searchParams.get('result') ?? null, connection: u?.searchParams.get('connection') ?? null, location: loc };
}

/** The whole happy path: start, the person approves at the (fake) provider, the provider redirects back. */
export async function connectFlow(h: ApiHarness, c: TestClient, kind: string, body: Record<string, unknown>, accounts: FakeGrantAccount[]) {
  const f = await startFlow(c, kind, body, { reauth: h });
  if (f.status !== 201) throw new Error(`connect start failed: ${f.status} ${f.code}`);
  const provider = kind === 'gbp_location' || kind === 'ads_google' ? h.providers.integrations.oauth.google : h.providers.integrations.oauth.meta;
  const code = provider.issueCode({ codeChallenge: f.challenge, accounts });
  const cb = await callback(h, kind, { state: f.state, code });
  return { ...f, cb, providerCode: code };
}

export async function connectionRow(h: ApiHarness, id: string) {
  return (
    await h.su.query<{ status: string; external_account_id: string | null; credential_id: string | null; capabilities: Record<string, boolean>; last_error_code: string | null; tenant_id: string }>(
      'SELECT tenant_id, status, external_account_id, credential_id, capabilities, last_error_code FROM integration_connections WHERE id = $1',
      [id],
    )
  ).rows[0];
}
