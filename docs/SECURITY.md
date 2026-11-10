# Realty OS: Security (Phase 1)

What we defend, against whom, what is covered (and by which test), and what remains. Tenant isolation (FORCE RLS), lead ownership and opt-outs were reviewed adversarially earlier (ARCHITECTURE §20). This file covers the application-security pass over the web and API layers (lane `security-hardening`). Update it whenever a control changes.

---

## 1. Threat model

**Assets.** Contact PII (names, phones, emails, message bodies, notes), call recordings and transcripts, opt-out state, provider credentials (telephony subaccounts, FUB API keys), tenant keys and the KEK, user credentials (password hashes, TOTP secrets, recovery codes), and sessions.

**Actors.**

| Actor | Can | Goal |
|---|---|---|
| Anonymous internet attacker | Reach every public route, every webhook URL, the web app | Account takeover, enumeration, forged inbound/leads, SSRF, DoS |
| Malicious web page visited by a signed-in user | Make the browser send cookie-bearing requests; frame our pages | CSRF, clickjacking, data theft through XSS |
| Contact / lead (untrusted content) | Send SMS, email, lead-form fields; appear in FUB exports | Stored XSS, CSV formula injection, prompt injection into the assistant |
| Agent or other member of the same tenant | A valid session with their role | Read or change what their role does not allow (RLS + `can()`, covered earlier) |
| Tenant Admin / Owner | Upload CSV/FUB data, configure sources and integrations | SSRF via integration URLs, path traversal via uploads, cross-tenant access |
| Someone who captures a signed webhook | Replay it | Duplicate leads or inbound messages |
| Someone with a database dump or log access | Read rows and logs | Session tokens, reset tokens, secrets, PII in logs |

**Out of scope here:** a compromised API process or host (ARCHITECTURE §16), the vendor side of Twilio/SMTP/S3, and physical access to a phone.

---

## 2. Controls and their tests

### 2.1 Browser policy and headers

| Control | Where | Test |
|---|---|---|
| API: helmet with a deny-all CSP (`default-src 'none'; frame-ancestors 'none'`), HSTS, nosniff, `Referrer-Policy: no-referrer`, CORP same-origin, no `x-powered-by` | `apps/api/src/server.ts` | `apps/api/src/security.headers.test.ts`, `auth/csrf.test.ts` |
| API: every response `Cache-Control: no-store` unless the route sets its own | `server.ts` onSend | `security.headers.test.ts` |
| Web: strict CSP, defined once, with no `'unsafe-inline'` and no `'unsafe-eval'`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, plus nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP and X-Frame-Options | `apps/web/security-headers.ts`, sent by `vite preview` and injected as `<meta>` into the built `index.html` | `apps/web/e2e/security/csp.spec.ts`: builds and serves the app; zero CSP violations on the login page and on 24 signed-in pages; a control case proves an injected inline script is blocked and detected |
| CORS: only the `WEB_ORIGIN` allowlist, with credentials | `server.ts` | `auth/csrf.test.ts` |
| Session cookie `__Host-sid`: httpOnly, Secure, SameSite=Lax, Path=/; 32 random bytes; only sha256 stored | `auth/sessions.ts` | `auth/login.test.ts` |

### 2.2 CSRF

Two layers on every unsafe method: (1) the `Origin` (or `Referer`) must be in the allowlist, including on public routes (login CSRF); (2) a session-bearing request must carry `x-csrf-token = HMAC(server secret, session id)`.

Exempt: provider webhooks (signature instead), and **capability URLs**. A capability URL is a `public` route with a `:token` parameter whose only authority is a MAC-signed token in the URL. It reads no cookie. It declares `config.capabilityUrl: true`, and the server refuses to start if any other kind of route declares it. Today only `POST /api/email/unsubscribe/:token` declares it: the mailbox provider sends the RFC 8058 one-click POST without an Origin header. That POST used to be refused with 403, so one-click unsubscribe never worked (an opt-out path, D1). This is now fixed.

**Test:** `apps/api/src/auth/csrf.routes.test.ts` enumerates the live route table, so new routes are covered automatically. For every unsafe route it checks:

- session, self and Action routes: no token, a foreign Origin or no Origin is 403 `CSRF_INVALID`
- public routes: a foreign Origin or no Origin is 403
- webhook routes: an unsigned delivery is 403 `WEBHOOK_SIGNATURE_INVALID`
- the `capabilityUrl` flag is refused on every other kind of route

`comms/unsubscribe.oneclick.test.ts` covers the one-click flow end to end.

### 2.3 XSS (untrusted content)

| Content | How it renders | Verdict |
|---|---|---|
| SMS and email bodies, including inbound email | React text in `ThreadPage`; the API stores inbound email as plain `text` only; no HTML part is stored or rendered | safe |
| Evidence snippets, assistant drafts and claims | React text (`design/Evidence.tsx`) | safe |
| Notes, imported FUB/CSV fields, listing fields, search snippets | React text | safe |
| Error and toast text | code → fixed sentence (`errorMessages.ts`) | safe |
| URLs built from data | `design/safeUrl.ts` allows only http, https, mailto and tel (or an explicit list) and rejects obfuscated schemes and credentials; the MFA `otpauth:` link goes through it | fixed (a `javascript:` URI rendered as an href before) |
| Raw HTML | the codebase has no `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `eval` or `target=_blank` | safe |

**Rule for new code:** every href or src built from data goes through `safeUrl`, and a new `target="_blank"` needs `rel="noopener noreferrer"`. Tests: `apps/web/src/design/safeUrl.test.ts`, `apps/web/src/shell/auth/SignIn.security.test.tsx`.

### 2.4 Authentication

| Control | Test |
|---|---|
| argon2id (m=64 MiB, t=3, p=1); the same work for unknown emails (dummy hash); uniform `LOGIN_FAILED` | `auth/login.test.ts`, `auth/hardening.test.ts` |
| Lockout after 10 failures; DB-backed rate limits keyed by HMAC: login 5/min per IP+email, 20/h per email, 100/h per IP; MFA 5 per 5 minutes per user; reset 10/h per IP and 3/h per email; reset confirm 20/h per IP; signup 10/h per IP; invite 20/h per IP; re-auth 5 per 5 minutes; recovery-code regeneration 5/h | `auth/login.test.ts`, `auth/mfa.test.ts` |
| Reset and invite tokens: 32 random bytes, only sha256 stored, single-use, 30 minutes (reset) and at most 7 days (invite); the reset link carries the token in the URL fragment; consuming a reset revokes every session | `auth/login.test.ts`, `auth/account.test.ts` |
| Password reset does not enumerate: always 202, mail sent fire-and-forget, limits counted for unknown emails too | `auth/login.test.ts` |
| A new session (with the old one revoked in the same transaction) on login, MFA verification and enrollment, re-auth, tenant switch and invite acceptance; rotation cannot outlive a concurrent revoke-all | `auth/login.test.ts`, `auth/hardening.test.ts` |
| A role or status change applies on the next request (the role is read from the membership) | `auth/login.test.ts` |
| MFA: TOTP with a replay guard; Owner/Admin enrollment-only sessions; changing an authenticator needs a fresh password re-auth | `auth/mfa.test.ts`, `auth/hardening.test.ts` |
| **MFA recovery codes:** 10 codes, stored as sha256 only, single-use; `POST /auth/mfa/recovery-codes` replaces all of them (needs verified MFA and a re-auth within 15 minutes; audited `mfa.recovery_codes_regenerated`); the session reports `mfa.recoveryCodesRemaining` | `auth/sessions.security.test.ts` |
| **Log out of all sessions:** `POST /auth/logout-all` revokes every live session of the user on every device and in every tenant. It needs a fully verified session, so a stolen password alone cannot sign the user out everywhere. Audited `session.revoked_all`; auth event `session_revoked` | `auth/sessions.security.test.ts` |

### 2.5 Webhooks

| Provider | Signature | Replay | Idempotency |
|---|---|---|---|
| Telephony (Twilio-shaped) | HMAC-SHA1 over the full URL plus sorted form parameters | Twilio signs no timestamp, so replay is possible at any time | `webhook_events (provider, provider_event_id)`: `sms:{MessageSid}`, `status:{sid}:{status}`, `voice:{sid}:{status}:…`, `recording:{RecordingSid}` |
| Email (inbound and events) | `X-Realty-Signature: t=…,v1=HMAC-SHA256(secret, t.rawBody)` | `t` at most 5 minutes old and **at most 30 s in the future** (new) | `inbound:{eventId}`, `event:{eventId}` |
| Lead intake `/intake/:sourceToken` | same as email, with its own secret | same | no provider event id: `(source, externalId)`, else the 10-minute inquiry fingerprint. A replay lands at most 5.5 minutes after the first receipt, so it is always `duplicate_ignored` |

A bad signature is checked before input validation. It gets a 403, a tenant-less rejected row, and no tenant writes. Tests: `providers/webhooks.test.ts`, `leads/intake.replay.test.ts`, `auth/hardening.test.ts`, `auth/csrf.routes.test.ts`.

### 2.6 Input and files

See §2.8 (import pipeline and storage); that part of the pass is in `apps/api/src/imports` and `apps/api/src/providers/storage.ts`.

- Global body limit is 1 MiB (413 `PAYLOAD_TOO_LARGE`).
- The JSON parser drops `__proto__`, `constructor` and `prototype` keys.
- A wrong media type gets 415.
- Push endpoints accept only public push-service hosts (SSRF; `auth/hardening.test.ts`).

### 2.7 Secrets, logs and errors

- **Error bodies** are `{ error: { code, requestId, details? } }`. They carry no input echo, SQL or stack (`security.headers.test.ts`, `platform.test.ts`).
- **Logs** carry ids, codes and timings only:
  - PII keys are dropped, and E.164 numbers and emails are masked
  - request logs show the route pattern, never the raw URL, so the intake token and query strings are not logged
  - the error serializer emits masked message and stack only

  Tests: `audit.test.ts` (R-TEN-7).
- **Config:**
  - `redactConfig` carries no secrets
  - production refuses `KEK_BASE64 == SESSION_SECRET_BASE64` and webhook secrets shared between providers
  - config errors name the key, never its value

  Tests: `security.headers.test.ts`, `platform.test.ts`.
- **KEK.** The local KEK is 32 bytes from `KEK_BASE64`. It wraps the tenant keys with an AAD that binds tenant, purpose and version, and derives the platform keys (MFA, webhook payloads) through HKDF with a separate label for each purpose. It is never logged or returned. Production must replace it with a KMS-backed `Kek` (the interface is in `crypto/kek.ts`; see §3).

### 2.8 Import pipeline and storage

The import-pipeline part of this pass (upload limits, decompression, CSV formula injection, FUB base-URL SSRF, storage-key traversal) is recorded here when it lands; see the lane report.

---

## 3. What remains (needs the owner, an account, or counsel)

| Item | Why it is open | Suggested action |
|---|---|---|
| Signup reveals whether an email is registered (`SIGNUP_UNAVAILABLE`) | Fixing it needs an email-verification signup ("check your inbox"), which changes the product flow. Signup is limited to 10/h per IP | Owner decision: add verified signup before public launch |
| Telephony webhooks have no timestamp (a Twilio property) | A captured, Twilio-signed request can be replayed after `webhook_events` rows are purged. TLS makes capture unlikely | Keep `webhook_events` for at least the provider retry horizon; consider deduplicating inbound messages by `MessageSid` on `messages` as well |
| The KMS-backed KEK is not built | It needs a cloud account | Production-readiness: a KMS adapter for `Kek`; refuse `KEK_REF=local-kek:*` in production once it exists |
| https is not enforced by config | Local "production" runs (Codespaces demo) use http | Deployment must terminate TLS and set `WEB_ORIGIN` and `PUBLIC_BASE_URL` to https; the edge must send HSTS |
| The deployable web server must send the CSP headers | No server serves the built web app yet. The `<meta>` CSP cannot carry `frame-ancestors` | The production-readiness server sends `webSecurityHeaders` from `apps/web/security-headers.ts` on every response |
| `'unsafe-eval'` absence is asserted on the header string, not in a browser | Playwright's `evaluate` is exempt from CSP | none needed |
| The dev server (Vite) runs without CSP | React refresh and CSS injection are inline in dev | none: the build and preview are covered |
| Recovery codes are unsalted sha256 of 50 random bits | Fine against online guessing (rate limited, single-use); a stolen DB would allow offline cracking of codes | Optionally HMAC them with a server key |
| The lead intake source token is in the URL path | Edge or proxy access logs could record it | Strip paths under `/api/intake/` from edge logs, or move the token to a header in a future intake API version |
| Prompt injection from contact content into the assistant | Mitigated by design: approvals, a fixed autonomy scope, evidence verification and the content guard (ARCHITECTURE §11), not by this pass | Phase 2 review |
| CSP coverage of signed-in pages was exercised in error and empty states | E2E data seeding with the API was not in scope | Extend `csp.spec.ts` with a seeded API run |
