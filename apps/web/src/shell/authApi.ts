// Typed calls to api/platform's auth endpoints (apps/api/src/auth/*). The shapes mirror the
// server's Zod response schemas (SessionInfo, LoginResponse, MfaEnrollResponse, MfaConfirmResponse);
// apps/web may import @realty/api types only, and @realty/api is not a web dependency, so they are
// restated here and checked end to end by the Playwright auth spec against the real server.
import type { Role } from '@realty/core/foundation';
import type { ApiClient } from './api.js';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface SessionInfo {
  user: { id: string; email: string; displayName: string };
  tenant: TenantSummary | null;
  tenants: TenantSummary[];
  mfa: { enabled: boolean; verified: boolean; enrollmentRequired: boolean };
  reauthenticatedAt: string | null;
  csrfToken: string;
}

export type NextStep = 'ready' | 'mfa_verify' | 'mfa_enroll';
export interface LoginResponse {
  next: NextStep;
  session: SessionInfo;
}

export interface SignupInput {
  email: string;
  password: string;
  displayName: string;
  teamName: string;
  slug: string;
  timezone: string;
  brokerageLegalName: string;
}

/** Where a session has to go before the app is usable (route guard; pure, unit-tested). */
export type SessionGate = 'signed_out' | 'mfa_verify' | 'mfa_enroll' | 'choose_tenant' | 'ready';

export function sessionGate(s: SessionInfo | null): SessionGate {
  if (s === null) return 'signed_out';
  if (s.mfa.enabled && !s.mfa.verified) return 'mfa_verify';
  if (s.mfa.enrollmentRequired) return 'mfa_enroll';
  if (s.tenant === null) return 'choose_tenant';
  return 'ready';
}

export function authApi(c: ApiClient) {
  return {
    session: () => c.get<SessionInfo>('/auth/session'),
    login: (email: string, password: string) => c.post<LoginResponse>('/auth/login', { email, password }),
    signup: (input: SignupInput) => c.post<LoginResponse>('/auth/signup', input),
    logout: () => c.post<{ ok: true }>('/auth/logout'),
    mfaVerify: (b: { code: string } | { recoveryCode: string }) => c.post<LoginResponse>('/auth/mfa/verify', b),
    mfaEnroll: () => c.post<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll'),
    mfaEnrollConfirm: (code: string) => c.post<{ recoveryCodes: string[]; session: SessionInfo }>('/auth/mfa/enroll/confirm', { code }),
    reauth: (password: string, code?: string) => c.post<LoginResponse>('/auth/reauth', code ? { password, code } : { password }),
    tenantSwitch: (slug: string) => c.post<LoginResponse>('/auth/tenant-switch', { slug }),
    resetRequest: (email: string) => c.post<{ ok: true }>('/auth/password/reset', { email }),
    resetConfirm: (token: string, password: string) => c.post<{ ok: true }>('/auth/password/reset/confirm', { token, password }),
    acceptInvite: (token: string, b: { displayName?: string; password?: string }) =>
      c.post<LoginResponse>(`/auth/invites/${encodeURIComponent(token)}/accept`, b),
  };
}

export type AuthApi = ReturnType<typeof authApi>;

/** A same-origin, in-app path from a `next` parameter; anything else falls back to '/'. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || [...raw].some((ch) => ch.charCodeAt(0) < 32)) return '/';
  return raw;
}

const GATE_PATH: Record<Exclude<SessionGate, 'ready'>, string> = {
  signed_out: '/login',
  mfa_verify: '/login/mfa',
  mfa_enroll: '/mfa/enroll',
  choose_tenant: '/choose-team',
};

/** Where to go after any auth step: the next required step, else the requested page. */
export function pathAfterAuth(s: SessionInfo | null, next: string): string {
  const gate = sessionGate(s);
  const target = safeNext(next);
  if (gate === 'ready') return target;
  return target === '/' ? GATE_PATH[gate] : `${GATE_PATH[gate]}?next=${encodeURIComponent(target)}`;
}
