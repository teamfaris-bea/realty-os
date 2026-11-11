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
| Web in production: the `web` image's nginx sends exactly `webSecurityHeaders` (the header CSP, including `frame-ancestors 'none'`, and every other header above) with `always` on every response it serves: HTML, `/assets/`, the SPA fallback to `index.html`, `/healthz` and nginx's own error pages there. The lines come from one generated snippet, `deploy/security-headers.conf` (`node deploy/render-security-headers.mjs`), included in each content location because nginx drops inherited `add_header` lines in a location that sets its own (`Cache-Control`). `/api/` gets no nginx headers: the API's stricter helmet set above passes through alone, so no response carries two CSPs. The previous nginx `Referrer-Policy: no-referrer` on HTML is replaced by the policy's `strict-origin-when-cross-origin`: under `no-referrer` the Fetch standard sends `Origin: null` and no `Referer` on same-origin POSTs, which the CSRF origin check (`server.ts` `originOf`) refuses (not browser-verified here) | `deploy/nginx.conf`, `deploy/security-headers.conf`, Dockerfile `web` stage | `apps/web/src/security-headers.nginx.test.ts`: parses `nginx.conf` with its includes (resolved through the Dockerfile `COPY` lines), applies the inheritance rule, and asserts each content location's effective set equals `webSecurityHeaders` (names, values, `always`), that `/api/` adds none, that the snippet is exactly the generated text, and that the checker catches drift |
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
| Amazon SES events via SNS (`/webhooks/email/ses/events`) | SNS message signature: SignatureVersion 1 (SHA1withRSA) or 2 (SHA256withRSA) over AWS's canonical string. The certificate is fetched only from `https://sns.<region>.amazonaws.com(.cn)/….pem` (no port, no credentials, no redirects), must be within its validity period, and is cached in memory. `TopicArn` must be in `SES_SNS_TOPIC_ARNS`, because AWS signs any topic's messages. A SubscriptionConfirmation is confirmed only for a listed topic and an https SNS `SubscribeURL` | the SNS `Timestamp` is at most **1 hour** old and at most 30 s in the future. SNS keeps the original timestamp on retries for up to an hour, so 5 minutes would drop real retries | `event:ses:{SNS MessageId}` (stable across SNS retries) |
| Mailgun events (`/webhooks/email/mailgun/events`) | hex `HMAC-SHA256(MAILGUN_WEBHOOK_SIGNING_KEY, timestamp + token)`, compared in constant time | `timestamp` within ±5 minutes (`SIGNATURE_TOLERANCE_S`) | `event:mailgun:{event-data.id}`, else the signature token |
| Lead intake `/intake/:sourceToken` | same as email, with its own secret | same | no provider event id: `(source, externalId)`, else the 10-minute inquiry fingerprint. A replay lands at most 5.5 minutes after the first receipt, so it is always `duplicate_ignored` |

A bad signature is checked before input validation. It gets a 403, a tenant-less rejected row, and no tenant writes. Tests: `providers/webhooks.test.ts`, `leads/intake.replay.test.ts`, `auth/hardening.test.ts`, `auth/csrf.routes.test.ts`, `providers/email/ses.test.ts`, `providers/email/mailgun.test.ts`, `providers/sesMailgunWebhooks.test.ts`.

### 2.6 Input and files

See §2.9 (import pipeline and storage); that part of the pass is in `apps/api/src/imports` and `apps/api/src/providers/storage.ts`.

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

### 2.8 Dependencies

`pnpm audit` (2026-11-10) finds 5 moderate advisories, all in dev-only tooling: `qs` through `@stryker-mutator/core` (mutation testing) and `minimatch` through `eslint`. `pnpm audit --prod` finds none. Nothing reachable at runtime is vulnerable, so nothing was upgraded. Re-run it before each release.

### 2.9 Import pipeline and storage

| Control | Where | Test |
|---|---|---|
| Unauthenticated requests to session routes get 401 in `preParsing`, after the Origin check and rate limit but **before any body is read**, so no upload is buffered for an anonymous client | `server.ts` | `auth/csrf.routes.test.ts` |
| `POST /imports` body cap matches the 25 MiB file cap (strict base64 + 128 KiB envelope; was 50 MiB). An oversized declared `Content-Length` is 413 before the body is read; a lying one is refused | `imports/routes.ts` | `imports/upload.security.test.ts` |
| `fileBase64` must be strict, padded base64 (Node's lenient decoder would silently store different bytes) | `imports/schemas.ts` | same |
| Rows (50k), columns (500), cell length (32,768) | core `parseCsv` | same (R-IMPORT-13) |
| File extension must fit the source (.csv/.tsv/.txt or .json) | `imports/csv.ts`, `batches.ts` | same |
| No decompression anywhere. Compressed files (gzip, zip/xlsx, bzip2, xz, zstd, 7z, rar, OLE2) are refused 415 by magic bytes, and any `Content-Encoding` other than identity is 415 | `imports/csv.ts`, `routes.ts` | same |
| CSV formula injection: no export exists today. `imports/csvExport.ts` (OWASP: prefix `= + - @ tab CR` with `'`, always quote) is the writer for any future one. Core's `csvSafeCell` is not strict and must not be used for exports | `imports/csvExport.ts` | `imports/csvExport.test.ts` |
| FUB SSRF: `FUB_BASE_URL` comes from server config only (never tenant input). `config.ts` (`fub`) reads `FUB_PROVIDER`, `FUB_BASE_URL`, `FUB_ALLOWED_HOSTS` and `FUB_SYSTEM_*`; nothing in `imports/` reads `process.env`, and the API routes and worker handlers get the value from the loaded `Config`. `FUB_ALLOWED_HOSTS` (default `api.followupboss.com`) must list lowercase public host names only (no scheme, port, path, wildcard, IP literal or internal name). The base URL must be https on the default port, with no credentials, query or fragment, and its host must be on the list; `loadConfig` refuses otherwise at startup, naming the key and never the value, and the adapter re-checks when it is built. Redirects are not followed; API pages are capped at 32 MiB; recording URLs must be public hosts on default ports | `config.ts`, `imports/fub.ts`, `imports/handlers.ts` | `config.test.ts`, `imports/fub.test.ts` |
| Storage keys: `tenants/{uuid}/…` only, at most 1024 characters, with no traversal, absolute paths, backslashes, NUL or encoded traversal. A bad key throws everywhere (it never reads as "absent"). The local FS adapter refuses paths that escape its root through symlinks | `providers/storage.ts` | `providers/storage.test.ts` |

---

## 3. What remains (needs the owner, an account, or counsel)

| Item | Why it is open | Suggested action |
|---|---|---|
| Signup reveals whether an email is registered (`SIGNUP_UNAVAILABLE`) | Fixing it needs an email-verification signup ("check your inbox"), which changes the product flow. Signup is limited to 10/h per IP | Owner decision: add verified signup before public launch |
| Telephony webhooks have no timestamp (a Twilio property) | A captured, Twilio-signed request can be replayed at any time. It is deduplicated by `webhook_events (provider, provider_event_id)`, and then by the downstream unique keys: `messages (tenant_id, provider, provider_message_ref)`, `message_status_events (provider_event_ref)`, calls and recordings by provider ref, and forward-only call status. The maintenance step `webhook_purge` (`app.purge_webhook_events`, migration 0018) deletes ids after their window: telephony 400 days, email 35 days, lead 2 days, rejected deliveries 30 days. It uses the database clock and takes no arguments, so the app role cannot shorten a window (`worker/webhookPurge.test.ts`). TLS makes capture unlikely | A replay older than 400 days still hits the downstream unique keys; review the windows if a new webhook kind has none |
| The KMS-backed KEK is not built | It needs a cloud account | Production-readiness: a KMS adapter for `Kek`; refuse `KEK_REF=local-kek:*` in production once it exists |
| https is not enforced by config | Local "production" runs (Codespaces demo) use http | Deployment must terminate TLS and set `WEB_ORIGIN` and `PUBLIC_BASE_URL` to https; the edge must send HSTS |
| `'unsafe-eval'` absence is asserted on the header string, not in a browser | Playwright's `evaluate` is exempt from CSP | none needed |
| The dev server (Vite) runs without CSP | React refresh and CSS injection are inline in dev | none: the build and preview are covered |
| Recovery codes are unsalted sha256 of 50 random bits | Fine against online guessing (rate limited, single-use); a stolen DB would allow offline cracking of codes | Optionally HMAC them with a server key |
| The lead intake source token is in the URL path | Edge or proxy access logs could record it | Strip paths under `/api/intake/` from edge logs, or move the token to a header in a future intake API version |
| Prompt injection from contact content into the assistant | Covered by §4 (lane `prompt-injection`): the model is assumed fully compromised and every server-side rule is tested against a hostile fake. What remains is listed in §4.5 | none beyond §4.5 |
| DNS rebinding on FUB recording URLs and the FUB base URL | A public name that resolves to a private IP is not re-checked at connect time | Worker egress policy (deny private ranges) at deployment |
| Imported FUB fields (`imported_fields`: source URL, `custom*`) are attacker-controlled | Today they render as text only | Any future link from them, or from contact emails and phones (`mailto:`/`tel:`), goes through `safeUrl` |
| nginx error pages produced outside a content location carry no web headers | A 502/504 for an unreachable API (in `/api/`, which adds none so the API's own CSP stays the only one) and a 400 for a request refused before location matching are nginx's static HTML with no script | none needed; revisit if custom error pages are added |
| Gmail inbox sync (Phase 2, owner decision D2; design only, DATA_MODEL §6.3, ARCHITECTURE §21.10) stores agents' refresh tokens and copies of client mail | The restricted scope `gmail.readonly` needs Google's OAuth verification and a third-party security assessment, renewed periodically (**VERIFY** current requirements); team visibility of an agent's client mail needs counsel (C14) | Keep `platform:gmail` uncleared until N19 and C14 pass; refresh tokens envelope-encrypted with row-bound AAD, access tokens in memory only, no bodies or addresses in logs, never sent to a model, never readable by a support actor (RESTRICTIVE policy) |
| CSP coverage of signed-in pages was exercised in error and empty states | E2E data seeding with the API was not in scope | Extend `csp.spec.ts` with a seeded API run |

---

## 4. Prompt injection (lane `prompt-injection`)

**Assumption.** The model can be fully manipulated by anything it reads. So everything it outputs is attacker-controlled, and every rule that matters is enforced by the server, outside the model. The tests prove this with `HostileAi` (`apps/api/src/providers/fake/hostileAi.ts`), a fake provider that plays a compromised model. It sits next to the deterministic `FakeAi`, which is unchanged.

### 4.1 Where untrusted content enters a prompt

Every prompt is built by `core.assistant.buildPrompt` (`packages/core/src/assistant/prompt.ts`, `assistant-prompts/2.0.0`). Its input is ONE contact's bundle, read by `apps/api/src/assistant/repos/context.ts`.

| Untrusted content | Who controls it | Reaches the model through |
|---|---|---|
| Inbound SMS and email bodies | the client, or anyone who knows their number or address | `CONVERSATION` (drafts, handbacks, summaries) |
| Outbound message bodies (imported ones, or ones that quote the client) | the client, by quoting; import files | `CONVERSATION` |
| Call transcripts | anyone on the call | `CALL` (call pipeline: summary, promise tasks, search proposal) |
| Notes, including imported FUB notes | third-party systems, import files | `AGENT NOTES` |
| Lead-source payloads: name, attributes, inquiry type/source/message | lead providers, web forms | `CLIENT PROFILE`, `INQUIRY` (first response task, summaries) |
| Listing data | MLS/feed, team entry | `LISTINGS` |
| Deal stage and side | team entry, imports | `DEALS` |
| Behavior-event types | tracking pixels, lead providers | `WEBSITE / EMAIL ACTIVITY` |
| The agent's own recent sent messages (tone samples) | the agent; they can quote other clients | the tone section |

Paths that call the model (`runModel` in `apps/api/src/assistant/runs.ts`):

- reply drafts (`POST /contacts/:id/drafts`)
- handback enrichment (a suggestion, and a reply draft)
- the call pipeline (call summary, promise tasks, saved-search proposal)

The first response and playbook steps **never call the model**. They render approved templates, and the slots are filled from database fields, never from model output.

### 4.2 Prompt construction

- **Every record is data.** Each record is wrapped in `<untrusted_{nonce}>` … `</untrusted_{nonce}>`, both directions of the conversation included. The nonce is per prompt. The system prompt says that such blocks are data and never instructions, even when the text claims to come from the agent, the team or the system.
- **Delimiter look-alikes are neutralised** inside the content (`neutralizeUntrusted`). Format characters are removed first, so a tag split by a zero-width character is still caught. Then every look-alike of a tag we use becomes `[tag removed]`: `untrusted`, `request`, `system`, `assistant`, `user`, `human`, `instructions`. That covers full-width brackets, HTML and numeric entities, `<` and `%3C`. Carriage returns and Unicode line separators become `\n`, and other control characters are dropped. One-line fields (names, attributes, event types) are also flattened and length-bounded.
- **The system prompt is static per purpose** (`systemPromptFor`). It carries no tenant, contact, nonce or identity, so it caches (`providers/anthropic.ts` marks it `cache_control: ephemeral`), and nothing an attacker wrote can be in it. The per-request facts are in a server-written `<request>` block at the top of the user turn: whose assistant it is, the sign-off, and the untrusted tag name.
- **One contact only.** Items of any other contact are dropped and counted. Prompts carry no database ids. Tone samples have numbers, emails and links scrubbed, and the recipient's own name is replaced by `[name]` (`redactNames`). The model has no tools.

### 4.3 What the output could cause, and what stops it

| Abuse by a compromised model | Server-side check | Test |
|---|---|---|
| Send something without a human | Model output only ever becomes a `message_draft` with `requires_approval` (DB CHECK: `novel_message`, `money` and `contract` are never `within_playbook`). Autonomous messages are approved templates, re-checked at send time by `authorizeAutonomousAction` | `assistant/injection.test.ts` "autonomy rules hold" |
| Claim the draft is autonomous, approved or in a playbook category | Output fields other than `claims`, `explanation` and `draft.{subject,body}` are ignored | same (`escalate`) |
| Wiring, routing, account or IBAN details | `screenModelDraft` blocks the draft. No card, nothing to tap; the route returns `ASSISTANT_OUTPUT_BLOCKED`; a handback says the reply was discarded; audited `assistant.output_blocked` (codes only). The send-time gate also blocks the same text from a human (`PAYMENT_INSTRUCTIONS`, R-GATE-7) | lane example tests, core `injection.test.ts` |
| Pretend to be human or sign as the agent | `HUMAN_CLAIM` flag. The card says "Check this before sending: … signs or speaks as a person" | `human_claim`, `prose` |
| Links, phone numbers or emails that are in no source | `UNSOURCED_LINK` / `UNSOURCED_PHONE` / `UNSOURCED_EMAIL` flags. Links are compared by host after userinfo is stripped; phones by national number | `unsourced_contact`, `exfiltrate` |
| Talk the agent past the flags ("URGENT, the broker approved this") | When a draft is flagged or blocked, the card text is the server's sentence, never the model's explanation. Model explanations are cleaned to one line of at most 300 characters | flagged-draft tests |
| Pick another recipient or channel | The output carries no recipient. A draft belongs to the contact the prompt was built for, and the channel is the one the client last wrote on (`replyChannelOf`). The model's `channel` is ignored and recorded as `CHANNEL_OVERRIDE` | `redirect`, the email test |
| A new kind of client message | Every draft is `novel_message`, `money` or `contract`: always a tap | `escalate` |
| Invented evidence, unknown sources, raw ids, out-of-range offsets, unquoted dates | `normalizeClaims` and `verifyQuote` mark these needs_review, and the deferred DB trigger refuses asserted claims without verified evidence. Promise tasks from them have no due date (R-AST-5) | `invented_evidence` |
| Saved-search criteria nobody said, or keys that are not criteria | Criteria must appear in verified evidence. Unverified ones are at most prefilled and unchecked; unknown keys are dropped | `search_injection` |
| Reveal other contacts' data | The prompt contains only this contact's data, so there is nothing to reveal. Invented numbers and emails are flagged | "prompts carry exactly one contact" |
| Break the output schema (tool calls, wrong types) | `ModelOutputSchema` and `RawClaim`: anything else means no claims and no draft. `ai_runs.internal_signals.error = OUTPUT_NOT_CONTRACT` | `schema` |
| Oversized output | Raw output over `MODEL_OUTPUT_MAX_CHARS` (32,000) means the run failed and nothing is stored or parsed; audited. A draft body over `DRAFT_BODY_MAX` (SMS 1,600, email 8,000) or a subject over 200 is refused, never truncated | `oversized_output`, `oversized_draft` |
| Run against a contact the agent may not draft for | The route refuses before any model call | "cannot be pointed at another agent's contact" |

### 4.4 Audit and logs

- `assistant.output_blocked` and `assistant.output_flagged` are recorded on the `ai_run`. Their reason is `purpose:CODE,CODE`, so no text, numbers or addresses are stored.
- `ai_runs.internal_signals.draftScreen` holds the codes and is never serialized to agents (R-AST-13).
- A flagged draft stores its codes in `payload.screen`. Its feed reason is `CHECK_THIS`.

### 4.5 What remains

- **Detection is pattern-based.** A model can still write a persuasive but harmless-looking draft, for example a wrong showing time. That is exactly why drafts always need the agent's tap and why claims show their evidence.
- **The web shows the server sentence, not the codes.** The web shows `ASSISTANT_OUTPUT_BLOCKED` with its generic error sentence until a surface lane adds copy. `payload.screen` is not yet exposed in the card schema, which was kept unchanged during the parallel lanes.
- **Caching may not apply.** The static system prompt can be shorter than a model's minimum cacheable prefix. In that case it is simply not cached.
- **Prefilled search criteria are attacker text.** Unchecked criteria are shown as text and never used until the agent ticks them.
