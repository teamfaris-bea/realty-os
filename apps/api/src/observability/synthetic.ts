// Synthetic production check (pnpm ops:synthetic; docs/OPERATIONS.md "Synthetic check").
//
// Signs in as a dedicated check user, loads the feed, sends one text (or email) to a test contact and
// waits until the provider accepted it, then signs out. Exits 0 when every step passed, 1 with the
// failed step and a plain reason otherwise, 2 when the check itself is misconfigured. It talks to the
// public API like a browser does (Origin header, session cookie, CSRF token) and needs nothing else.
//
//   SYNTHETIC_BASE_URL      https://app.example.com (the API origin; /api is appended)
//   SYNTHETIC_ORIGIN        the web origin the API allows (WEB_ORIGIN; default: the base URL)
//   SYNTHETIC_EMAIL / SYNTHETIC_PASSWORD   the check user (an agent; MFA optional)
//   SYNTHETIC_TOTP_SECRET   base32 TOTP secret when the check user has MFA
//   SYNTHETIC_CONTACT_ID    the test contact the check user owns (its phone is a test number)
//   SYNTHETIC_CHANNEL       sms (default) | email
//   SYNTHETIC_SEND_TIMEOUT_MS   how long the message may take to be accepted (default 60000: the SLO)
//
// The check never prints bodies, addresses, cookies or tokens; only step names, timings and codes.
import { randomUUID } from 'node:crypto';
import { totpCode, totpStep } from '../auth/totp.js';

export interface SyntheticOptions {
  baseUrl: string;
  origin?: string;
  email: string;
  password: string;
  totpSecret?: string | null;
  contactId: string;
  channel?: 'sms' | 'email';
  sendTimeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SyntheticStep {
  step: 'ready' | 'login' | 'mfa' | 'feed' | 'send' | 'accepted' | 'logout';
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface SyntheticResult {
  ok: boolean;
  steps: SyntheticStep[];
  /** the first failure in words */
  reason: string | null;
}

class StepFailed extends Error {}

export async function runSynthetic(o: SyntheticOptions): Promise<SyntheticResult> {
  const f = o.fetch ?? fetch;
  const api = `${o.baseUrl.replace(/\/+$/, '')}/api`;
  const origin = o.origin ?? new URL(o.baseUrl).origin;
  const steps: SyntheticStep[] = [];
  let cookie: string | null = null;
  let csrf: string | null = null;

  async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'realty-synthetic/1' };
    if (method !== 'GET') {
      headers.origin = origin;
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await f(`${api}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    const set = r.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const m = /^((?:__Host-)?sid)=([^;]*)/.exec(c);
      if (m) cookie = m[2] ? `${m[1]}=${m[2]}` : null;
    }
    let json: Record<string, unknown> | null;
    try {
      json = (await r.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    const s = (json?.session as { csrfToken?: string } | undefined)?.csrfToken;
    if (s) csrf = s;
    return { status: r.status, json };
  }

  const code = (j: Record<string, unknown> | null) => ((j?.error as { code?: string } | undefined)?.code ?? 'no error code');
  const clock = o.now ?? (() => performance.now());

  async function step<T>(name: SyntheticStep['step'], fn: () => Promise<T>): Promise<T> {
    const t = clock();
    try {
      const v = await fn();
      steps.push({ step: name, ok: true, ms: Math.round(clock() - t) });
      return v;
    } catch (e) {
      const detail = e instanceof StepFailed ? e.message : `could not reach the API (${(e as Error).name})`;
      steps.push({ step: name, ok: false, ms: Math.round(clock() - t), detail });
      throw new StepFailed(`${name}: ${detail}`);
    }
  }

  try {
    await step('ready', async () => {
      const r = await req('GET', '/ready');
      const status = (r.json?.status as string | undefined) ?? 'unknown';
      if (r.status !== 200 || status !== 'ready') {
        const failed = Object.entries((r.json?.checks as Record<string, string> | undefined) ?? {}).filter(([, v]) => v !== 'ok').map(([k]) => k);
        throw new StepFailed(`the API is ${status} (HTTP ${r.status})${failed.length ? `; failed checks: ${failed.join(', ')}` : ''}`);
      }
    });
    const next = await step('login', async () => {
      const r = await req('POST', '/auth/login', { email: o.email, password: o.password });
      if (r.status !== 200) throw new StepFailed(`sign-in refused (HTTP ${r.status}, ${code(r.json)})`);
      return r.json?.next as string;
    });
    if (next === 'mfa_enroll') {
      steps.push({ step: 'mfa', ok: false, ms: 0, detail: 'the check user must enroll MFA first (or use a role without required MFA)' });
      throw new StepFailed('mfa: the check user must enroll MFA first');
    }
    if (next === 'mfa_verify') {
      await step('mfa', async () => {
        if (!o.totpSecret) throw new StepFailed('the check user has MFA; set SYNTHETIC_TOTP_SECRET');
        const r = await req('POST', '/auth/mfa/verify', { code: totpCode(o.totpSecret, totpStep(Date.now())) });
        if (r.status !== 200) throw new StepFailed(`second factor refused (HTTP ${r.status}, ${code(r.json)})`);
      });
    }
    await step('feed', async () => {
      const r = await req('GET', '/feed');
      if (r.status !== 200) throw new StepFailed(`the feed did not load (HTTP ${r.status}, ${code(r.json)})`);
    });
    const messageId = await step('send', async () => {
      const channel = o.channel ?? 'sms';
      const body = { channel, body: `Realty OS synthetic check ${new Date().toISOString().slice(0, 16)}Z. No reply needed.`, idempotencyKey: `synthetic-${randomUUID()}`, ...(channel === 'email' ? { subject: 'Realty OS synthetic check' } : {}) };
      const r = await req('POST', `/contacts/${encodeURIComponent(o.contactId)}/messages`, body);
      if (r.status !== 200) throw new StepFailed(`the send was refused (HTTP ${r.status}, ${code(r.json)})`);
      const result = r.json?.result as string | undefined;
      const msg = r.json?.message as { id?: string } | null;
      if (result === 'blocked' || !msg?.id) {
        const reasons = ((r.json?.decision as { reasons?: string[] } | null)?.reasons ?? []).join(', ');
        throw new StepFailed(`the send was blocked (${reasons || result || 'no message'}); check the test contact is not opted out`);
      }
      return msg.id;
    });
    await step('accepted', async () => {
      const deadline = clock() + (o.sendTimeoutMs ?? 60_000);
      for (;;) {
        const r = await req('GET', `/contacts/${encodeURIComponent(o.contactId)}/timeline?limit=20`);
        if (r.status !== 200) throw new StepFailed(`the conversation did not load (HTTP ${r.status}, ${code(r.json)})`);
        const item = ((r.json?.items as { id: string; status: string | null; providerErrorCode?: string | null }[] | undefined) ?? []).find((i) => i.id === messageId);
        const last = item?.status ?? 'not listed';
        if (last === 'sent' || last === 'delivered') return;
        if (['failed', 'undelivered', 'bounced', 'blocked', 'canceled'].includes(last)) throw new StepFailed(`the message ended ${last}${item?.providerErrorCode ? ` (provider code ${item.providerErrorCode})` : ''}`);
        if (clock() >= deadline) throw new StepFailed(`the message was still ${last} after ${(o.sendTimeoutMs ?? 60_000) / 1000} s (is the worker running?)`);
        await new Promise((res) => setTimeout(res, o.pollMs ?? 2_000));
      }
    });
    return { ok: true, steps, reason: null };
  } catch (e) {
    return { ok: false, steps, reason: e instanceof StepFailed ? e.message : `unexpected: ${(e as Error).name}` };
  } finally {
    if (cookie) {
      const t = clock();
      try {
        const r = await req('POST', '/auth/logout', {});
        steps.push({ step: 'logout', ok: r.status === 200, ms: Math.round(clock() - t) });
      } catch {
        steps.push({ step: 'logout', ok: false, ms: Math.round(clock() - t) });
      }
    }
  }
}

/** The options from the environment, or the list of missing variables. */
export function syntheticOptionsFromEnv(env: NodeJS.ProcessEnv): { ok: true; options: SyntheticOptions } | { ok: false; missing: string[] } {
  const need = ['SYNTHETIC_BASE_URL', 'SYNTHETIC_EMAIL', 'SYNTHETIC_PASSWORD', 'SYNTHETIC_CONTACT_ID'];
  const missing = need.filter((k) => !(env[k] ?? '').trim());
  const channel = (env.SYNTHETIC_CHANNEL ?? 'sms').trim();
  if (channel !== 'sms' && channel !== 'email') missing.push('SYNTHETIC_CHANNEL (sms or email)');
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    options: {
      baseUrl: env.SYNTHETIC_BASE_URL!.trim(),
      ...(env.SYNTHETIC_ORIGIN ? { origin: env.SYNTHETIC_ORIGIN.trim() } : {}),
      email: env.SYNTHETIC_EMAIL!.trim(),
      password: env.SYNTHETIC_PASSWORD!,
      totpSecret: env.SYNTHETIC_TOTP_SECRET?.trim() || null,
      contactId: env.SYNTHETIC_CONTACT_ID!.trim(),
      channel: channel === 'email' ? 'email' : 'sms',
      ...(env.SYNTHETIC_SEND_TIMEOUT_MS ? { sendTimeoutMs: Number(env.SYNTHETIC_SEND_TIMEOUT_MS) } : {}),
    },
  };
}
