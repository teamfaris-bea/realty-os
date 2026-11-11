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

### 2.10 Security review: contact-detail policies read through `app.contact_detail_row` (lane perf-misses, miss #4)

**What changed.** Migration `*_deal_visibility_once.sql` adds `app.contact_detail_row(p_tenant, p_contact)` and
rewrites the USING clause (not WITH CHECK) of 15 policies (five more since the scale-lane review, below) from
`app.contact_detail_visible(tenant_id, contact_id)` to
`EXISTS (SELECT 1 FROM app.contact_detail_row(tenant_id, contact_id))`: the `contact_detail` policy of the 10
contact-children tables (contact_points, contact_addresses, contact_attributes, lead_inquiries, conversations,
behavior_events, saved_searches, playbook_enrollments, home_valuations, listing_contacts), `messages_select`,
`calls_select`, `notes_select`, `appointments_all`, and the non-Team-Lead branch of `loe_select`.

**Why.** `contact_detail_visible` is a scalar SQL function with an `EXISTS` body, which Postgres never inlines, so
the contacts policy's InitPlans ran once per child row. For a TC on about 2,900 deals that meant rebuilding
`app.my_deal_contact_ids()` (about 5,800 ids, about 10 ms) for every message, call and note read.

**Why it cannot widen visibility.**
- `app.contact_detail_row` is **not** SECURITY DEFINER, has no `SET` clause, and is not LEAKPROOF. It is a plain
  invoker SQL function with the same body as `contact_detail_visible`: it returns the contact's id when a contacts
  row **visible to the caller** (the `contacts_select` policy is applied inside it) passes the detail test.
- The planner inlines it into the reading statement. That changes only *when* the parameter-free helpers run (once
  per statement instead of once per row), not what they return. The helpers are `is_tenant_wide`, `my_role`,
  `sees_all_detail`, `my_collab_contact_ids` and `my_deal_contact_ids`. If it were ever not inlined (for example,
  someone adds a `SET` clause), it would still return the same rows, only slowly. The migration's self-check fails
  if it is not inlined.
- No definer was added. No index, membership or deal data is exposed beyond what `contact_detail_visible`
  already answered.
- WITH CHECK clauses, `contacts_select`, `contact_detail_visible` itself, and every other caller are unchanged.

**Proof.** `apps/api/src/load/deal_visibility_equivalence.test.ts`, run through the real RLS stack as `app_user` with
the API's context:
- For two members of every role (owner, admin, team lead, agent, ISA, TC), plus the agent on most deals and the
  system actor, every row of the 15 tables is read through the new policies. Then, in the same rolled-back
  transaction, the policies are restored to their old text and every row is read again. The two row sets are
  compared, with 0 differences allowed.
- Variants: a contact on the TC's deal through `deal_contacts` only; one through `deals.primary_contact_id` only; a
  deal the TC left; in a pond, offered or closed and on the TC's deal; soft-deleted and on the TC's deal; moved by
  the caller's current ownership command; and a TC deal membership in another tenant.
- The TC's expected visibility per variant is asserted for messages, calls, notes and contact points.
- `EXISTS (SELECT 1 FROM app.contact_detail_row(t, c))` is compared with `contact_detail_visible` and the 0020 body
  for every contact, for every sampled actor.

**Extension (scale-lane merge review).** The FUB parity detail tables had the same per-row shape, and main's People
page and contact page read them for the TC (about 13 ms per tag row at the 250k TC shape: 2.6-3.3 s for 200 tag rows,
against the 3 s list statement timeout). Migration `*_scale_review_fixes.sql` rewrites the USING clause of five more
SELECT policies the same way: `contact_tags_select`, `contact_field_values_select`, `contact_stage_events_select`,
`contact_relationships_select` (both people) and `bulk_action_items_select` (after its `bulk_actions` EXISTS). Every
WITH CHECK, UPDATE and DELETE policy of those tables keeps `contact_detail_visible`. The same test proves them: the
five tables are in the old/new comparison (tags, values, stage events, relationships pairing visible and hidden people,
and items of an agent's, a team lead's and the Owner's bulk actions, on every variant and in a second tenant), the TC's
per-variant visibility is asserted for tags, values and stage events, and a per-statement check counts function calls:
the TC's read of 600+ tag rows makes 0 `contact_detail_visible` calls (618 under the old policy) and builds its
deal-contact set at most 4 times. `mail_messages_select` (D2) has the same shape but no read route; the pending D2 review
migration reorders it and pins its text, so it is left to that migration.

**Rule for future edits.** Keep `contact_detail_row` and `contact_detail_visible` identical in meaning. Any change
to one must be made to both and must extend the equivalence test.

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

---

## 5. Spark MLS (read-only)

A read-only connector to FBS's Spark RESO Web API (lane `spark-prep`; adapter in `apps/api/src/providers/integrations/spark.ts`, service and routes in `apps/api/src/mls/spark/`, routes under `/api/admin/integrations/mls/spark`). The operator procedure is `docs/DEPLOY.md` §11. Feed sync into `listings` rows is module 24 (api/mls) and is not built; what any audience may see is still decided by the `core/listings` display rules (placeholder licence pack, `reviewed=false`).

### 5.1 Threat model

**Asset.** One server-to-server Spark access token per team. It does not expire, so a leaked token stays useful until it is deactivated at FBS.

| Threat | How it could happen | Goal |
|---|---|---|
| Token exposure | logs, error bodies or reports, audit rows, metrics labels, API responses, the browser after submission, a URL, an environment file, a database dump | read MLS data as the team, exhaust its rate limit, breach the licence |
| SSRF | an attacker-influenced base URL, a redirect, or an `@odata.nextLink` that points somewhere else | make the server send the token to, or fetch from, a host we did not choose |
| Write attempts | a code path, a bug or a crafted next link that issues a non-GET request or reaches another resource | change MLS data, or touch resources the licence does not cover |
| Cross-tenant access | a member of team A reading or using team B's credential or connection | use another team's licence and data |
| Privilege misuse inside the tenant | an Agent, Team Lead or support user reaching the form or the probe | replace, read or exercise the key |
| Reusing the website's key | someone pasting the team website's token into the CRM | one key shared by two systems: no independent revocation, audit or rate limit |

### 5.2 Controls

| Control | Where |
|---|---|
| **Encryption.** The token is stored only in `provider_credentials` (provider `mls`) of the tenant, under AES-256-GCM envelope encryption with the tenant field key, which the KEK wraps. The AAD binds the ciphertext to (`provider_credentials`, `secret_enc`, row id), so it cannot be replayed into another row. The chosen auth scheme is inside the encrypted payload; only a nonsecret label is in `external_account_ref`. | `apps/api/src/mls/spark/`, `crypto/` |
| **KEK in the secret store.** `KEK_BASE64` lives in the production deployment's secret store, never in the repository or an image. No environment variable holds the Spark token. | DEPLOY §9, §11.1 |
| **Who can write it.** Owner/Admin only (`integration.manage`), with re-auth (401 `REAUTH_REQUIRED`), the CSRF token, a database rate limit (429 `RATE_LIMITED`) and an audit row. Agents, Team Leads and support get 404 `NOT_FOUND`, never 403. The request body is strict: unknown fields are refused. | `/api/admin/integrations/mls/spark/credential` |
| **Redaction.** The token never appears in logs, error bodies, audit rows, metrics, error reports or any API response. Responses carry `credentialSaved` and the label only. | the routes, logger and error serializer (§2.7) |
| **The browser never receives it** after submission. | the GET view and the PUT response |
| **GET only.** The adapter refuses every other method. | `apps/api/src/providers/integrations/spark.ts` |
| **Path allowlist.** `/Reso/OData/$metadata`, `/Reso/OData/Property`, `/Reso/OData/Media` only. | same |
| **Host allowlist.** https only, hosts from `SPARK_ALLOWED_HOSTS` (lowercase public DNS names), default port only. `SPARK_API_BASE_URL` comes from server config, never tenant input, and start-up refuses a bad one in every environment. | `config.ts`, the adapter |
| **No redirects.** A redirect is refused, never followed, so the token never goes to a host that was not checked. | the adapter |
| **Paging re-check.** Every `@odata.nextLink` is checked against the same host and path allowlist before it is fetched. | the adapter |
| **Size and time caps.** Per-request timeout, response size cap; 429/5xx backoff with jitter inside a retry budget, `Retry-After` honoured up to a cap. | the adapter |
| **Kill switch.** `MLS_LIVE_CALLS=false` (the default everywhere) means no network call at all, even with a stored key. The probe then returns `live_calls_disabled` without a request. | config, the adapter |
| **Purge on disconnect or replace.** Disconnect revokes and purges in one transaction (`purged`, `secret_enc` NULL). A new key purges the old one in the same transaction and resets the connection to `not_configured`. | the routes |
| **Tenant isolation.** `provider_credentials` and `integration_connections` are FORCE RLS tables; every read and write runs in the caller's tenant. The connection's `credential_id` is written by the system actor only (R-INT-3). | migrations, `@realty/db` |
| **Support excluded at the database.** A restrictive RLS policy on `provider_credentials` (lane spark-prep migration) refuses every row to a support session, even one holding an active read-only grant; Owner/Admin and the system actor are unchanged, and definer paths (BYPASSRLS: retention sweep, account resolvers) are unaffected. | `packages/db/migrations/` (spark-prep), `packages/db/test/spark_prep_credentials.test.ts` |
| **Own key.** The CRM uses its own Spark key, never the website's. This is a recommendation (independent revocation, audit, rate limits), not a verified licensing requirement. | DEPLOY §11 |

Tests (mock Spark transport only; a network tripwire fails any real outbound call): `apps/api/src/providers/integrations/spark.test.ts` (GET-only, path/host allowlists, redirects, nextLink re-check, paging, cursor resume, backoff and budget, status mapping, size/time caps, kill switch), `apps/api/src/mls/spark/spark.api.test.ts` (roles, re-auth, CSRF, rate limit, cross-tenant RLS, every validation mapping, purge on replace and disconnect, and a canary token searched for in logs, error reports, audit rows, metrics, API responses, every database table and every snapshot file), `apps/api/src/mls/spark/config.test.ts`, `apps/api/src/integrations/keyStatus.test.ts`, `apps/api/src/integrations/architecture.test.ts`, and the web page's tests under `apps/web/src/surfaces/integrations/`.

### 5.3 What remains

| Item | Why it is open | Suggested action |
|---|---|---|
| **VERIFY** the `Authorization` scheme | Spark's docs show both `Bearer` and `OAuth` | Confirm with Spark support; set `SPARK_AUTH_SCHEME` |
| **VERIFY** the replication endpoint | Whether a full background sync must use Spark's separate replication endpoint is unverified | Confirm with Spark support before module 24; change base URL and host list if so |
| **VERIFY** field availability | Which fields this MLS exposes to this key's role is unknown | Check against `$metadata` with Spark support before module 24 maps fields |
| **VERIFY** rate limits | Not known for this key | Confirm with Spark support; tune the retry budget |
| **VERIFY** licence coverage | Owner-confirmed only; not independently re-verified with the MLS | Owner gets written confirmation from the MLS before any live call |
| **VERIFY** key deactivation at FBS | How a leaked or retired key is deactivated at FBS is not documented here | Owner confirms the process with FBS; disconnecting in the app only purges our copy |
| DNS rebinding on the allowed host | A public name that resolves to a private address is not re-checked at connect time (as for FUB, §3) | Worker and API egress policy that denies private ranges |
| Feed sync not built | Module 24 (api/mls) | Review its writes into `listings` and the display rules when it lands |

---

## 6. Performance lane: security review items (lane `perf-misses`)

Every change of this lane that touches who-sees-what, a definer, or a policy is listed here with its proof. None
marks anything LEAKPROOF, none adds `USING (true)`, and none gives a role BYPASSRLS. The fixes from the lane's merge
review (migration `scale_review_fixes`, one migration) are folded into the subsections below and summarized in §6.6.

### 6.1 Incremental Priority Feed (migration `feed_incremental`)

**What changed.** GET /feed reads stored cards instead of recomputing the book (docs/PERFORMANCE.md §7.1).

- **No existing policy changes.** `priority_feed_items` keeps `feed_select` (own cards, contact visible) and
  `feed_insert` / `feed_update`. The new columns `sort_at` and `card` hold the card's order instant, its reason
  template and its one-tap actions: what the API already returned for the card, never more.
- **No definer.** The marking triggers are `SECURITY INVOKER`. The migration's self-check fails if a `app.feed_*`
  function is a definer.
- **Marks go to `public.feed_dirty`, schema-qualified** (merge review). The first version wrote `INSERT INTO feed_dirty`.
  A definer's pinned `search_path = pg_catalog, public` does not list `pg_temp`, and Postgres then searches the
  session's temporary schema *first* for relation names. So a session that could run SQL as `app_user` could create
  `TEMP TABLE feed_dirty` with a trigger, call a definer that writes a marked table (signup's `app.provision_tenant`,
  invite acceptance, a merge, an import revert, an erasure), and have its own trigger code run as `app_definer` or
  `app_retention` (both BYPASSRLS). Every feed function now names `public.feed_dirty`; the review migration's self-check
  and `packages/db/test/schema_invariants.test.ts` fail if any SQL or PL/pgSQL function in `app`, `auth`, `portal` or
  `public` names a public table without its schema, and the same test shows a shadow table captures no mark, neither
  from the session's own writes nor inside `app.provision_tenant`.
- **The materializer acts as the member.** Both GET /feed and the background `feed.materialize` job read the inputs
  in a transaction whose GUCs are the member's own (`withTenantTx` with a user actor, as the worker already does
  for a human sender in `comms/runtime.ts senderActor`). The job never reads feed inputs with the system's
  tenant-wide view, so a member's stored cards can never hold more than that member could see.
- **A card is written only while its contact is visible to the member.** Tasks, appointments and assistant actions
  can name a contact the member cannot see; such a card is skipped (it would be hidden by `feed_select` anyway).
  The Phase 1 refresh tried to write it and failed, which broke that member's GET /feed (found by the
  equivalence test below).
- **New tables.** Both have FORCE RLS, the tenant `RESTRICTIVE` policy, the support-read-only policies and the
  `support_read_only` statement trigger.
  - `feed_dirty` (marks: tenant, user, group key, instant). Any member's or the system's write may INSERT a mark
    for any member of the same tenant, because one person's write can change another person's feed. Only the
    mark's own user and the system can SELECT or DELETE marks. A forged mark only causes an extra re-score of
    the member's own data under the member's own RLS.
  - `feed_groups` (per member and group: the next change instant and the count of open visible cards). The
    member's own (`user_id = app.user_id()`); the system may read it to find due work.
  - Neither holds PII: user ids, group keys (contact, task, appointment or deal-date ids the member already saw),
    instants and counts.
- **Trigger lookups run under the writer's RLS.** The contact-owner lookup in a marking trigger is invoker, so it
  cannot learn anything the writer may not see. A mark it cannot derive is repaired by the hourly reconcile.
- **Who is marked** (merge review). Besides the owner and offeree, a write that changes who can see a contact marks
  everyone else who holds a card on it, because tasks (by assignee), appointments (by user) and assistant actions (by
  owner) name a contact whatever its owner, and a card is written and counted only while its contact is visible to the
  member: an ownership or visibility change of a contact (owner, offeree, state, pond, deletion, merge) marks the
  assignees of its open tasks, the users of its open appointments and the owners of its proposed assistant actions; a
  person added to or removed from a deal, or a deal's new primary person, marks the deal's owner and members; a member
  joining or leaving a team marks the team's leads for a whole-book recompute. A deleted contact point (an import revert)
  marks its contact's owner. Only a `tenant_settings.default_timezone` change marks every member `'!full'` (the feed
  reads no other setting; stage labels, batch text and Gmail sync used to force every member's whole-book recompute).
  The marks only add re-scoring work under the member's own RLS; none reveals anything.
- **Read-path plan pin.** GET sets `enable_sort = off` transaction-locally around its two ordered reads. This is a
  planner choice only and does not change what RLS admits.

**Equivalence proof.**
- `apps/api/src/load/feed_incremental.test.ts`: random event sequences on a generated tenant, with every trigger and
  guard on. The events are client messages, missed calls, replies, tasks, appointments, drafts, handbacks, claims,
  contract dates, opt-outs, the member's own taps and time jumps (also exactly to a stored change instant and
  1 ms before it). After every event, for three agents, the TC and a team lead, the incremental feed equals a
  full recompute: same view, and no stored card or change instant differs.
- The same file, deterministically (merge review), through the API's own functions as the acting member: a Team
  Lead's task on a lead reassigned into and out of their team and merged away, a TC's task on a person added to and
  removed from the TC's deal and on a deal's old and new primary person, a team member leaving and rejoining the team,
  an imported phone removed by `app.import_revert_delete`, and settings writes (stage labels: no mark; the zone: every
  member `'!full'`). Each step asserts the mark and the incremental-equals-full comparison; each fails without the fix.
- `packages/core/src/priority/incremental.test.ts`: property tests of the three facts the design relies on (groups
  are independent; templated wording renders to the plain wording; between change instants only wording moves).
- The Phase 1 feed tests (`workspace/feed.test.ts`, `feed.foreign.test.ts`, R-PERM-4 reassignment included) pass
  unchanged.

### 6.2 Contact-detail policies (migration `deal_visibility_once`)

The full review is §2.10. In short:
- Twenty child-table `USING` clauses read through `app.contact_detail_row`, a new SECURITY INVOKER set-returning
  helper with the same body as `contact_detail_visible`: the fifteen of `deal_visibility_once` and, since the merge
  review, the SELECT policies of `contact_tags`, `contact_field_values`, `contact_stage_events`,
  `contact_relationships` and `bulk_action_items`. The planner inlines it, so the TC's deal-contact set is built once
  per statement instead of once per row.
- No definer, no SET clause, no LEAKPROOF. Every `WITH CHECK`, and every UPDATE and DELETE policy, is unchanged.
- Proof: `apps/api/src/load/deal_visibility_equivalence.test.ts`. Old and new policies are compared row by row for
  every role (two members each) and the system actor over all 20 tables, plus TC deal variants. Zero differences. A
  function-call count shows the TC's tag, value, stage-event and relationship reads make no per-row
  `contact_detail_visible` call.

### 6.3 Scoreboard daily rollup (migration `scoreboard_rollup`)

**Visibility is unchanged.** The team scoreboard was never computed under the viewer's row visibility: it reads
the 0012 SECURITY DEFINER aggregates. Those count a member's own activity whatever happened to the contacts
later. The only viewer-dependent part is which members' numbers a viewer may see (`app.scoreboard_allowed_users`).
A rollup per (tenant, member, local day) is therefore exact for every viewer:
- The read path takes rollup rows only for the members the live call in the same statement admits.
- The rollup tables' RLS repeats the same member rule.
- The tables hold timings and counts only, no contact ids.

**New and changed definers** (all owned by `app_definer`, `search_path` pinned):
- **Bulk sends are never touches (R-PAR-37; merge review).** `app.scoreboard_activity` (the live counts, unchanged
  since 0012) and `app.scoreboard_rollup_roll` counted every human outbound send, bulk ones included; only the unused
  `v_agent_activity_daily` view excluded them. Both now skip `bulk_action_id IS NOT NULL`, and
  `app.scoreboard_mark_messages` marks no day for a bulk send. They were replaced with `CREATE OR REPLACE` (same
  signature) and re-asserted: owner `app_definer`, `search_path = pg_catalog, public`, EXECUTE revoked from PUBLIC,
  granted to `app_user` for the two callable ones. Every rolled day that had counted a bulk send was marked dirty by
  the migration, so it is read live (now exact) until the job re-rolls it. The count's partial index was narrowed to
  match, so it stays an index-only scan.
- `app.scoreboard_mark` and six mark trigger functions only insert dates into `scoreboard_rollup_dirty`, and
  return nothing.
- `app.scoreboard_rollup_roll` and `app.scoreboard_rollup_sample` refuse any caller but the tenant's system actor,
  and return only a summary of counts.
- `app.scoreboard_speed` got a new body that returns the same rows (one ledger probe instead of two). It is proved
  equal to the 0012 body row for row for every role and the system actor.

**New tables.**
- `scoreboard_activity_daily`, `scoreboard_speed_daily`, `scoreboard_rollup_days`, `scoreboard_rollup_dirty` and
  `scoreboard_rollup_state`.
- All have FORCE RLS, the tenant policy, the support-read-only policies and the statement trigger.
- `app_user` can only SELECT them.

**Proof.** `apps/api/src/accountability/scoreboard_rollup.test.ts`: rollup + live equals live for every role, range
and board. This holds after reassignments, soft deletes, pond releases, team moves and suspensions done through the
ownership engine, after backdated and late writes, and across DST days in five zones. Since the merge review its
fixture also holds the parity rows (imported calls, texts and appointments, a running bulk email with sends on six past
days, logged-activity notes, a merge with its follow-up), and a test counts the definitions independently per rolled
day: an equivalence of two paths that both counted bulk sends would still hold, the explicit count does not. The
parity smoke (`packages/db/test/rls_smoke_parity.sql`) checks the live definer, the dirty-day mark and the rolled day
for a bulk send, and `apps/api/src/bulk/bulk.test.ts` checks the scoreboard and the feed through the real server.

### 6.4 Exception recompute (no policy change)

`exception_items` upserts are batched: one statement per 1,000 items, same values, order and conflict rule. No
policy, definer or read changed. Proof: `apps/api/src/accountability/recompute_equivalence.test.ts` compares the old
per-row path with the new one, state for state, ids included.

### 6.5 Search token tables (migration `search_visibility`)

**What.** `message_search_tokens` and `note_search_tokens` hold one row per lexeme of a message's or note's own
`search_tsv`, with that row's tenant, id and instant. Everything in them is already readable by anyone who can see
the parent row.

**Visibility.**
- Each table's SELECT policy is `EXISTS` over its parent table, evaluated under the caller's own RLS. A token row is
  visible exactly when its message or note is, and any later change to the parents' policies applies automatically.
- They have the tenant policy, the support-read-only policies and the statement trigger. `app_user` has SELECT only.
- An orphan row would be invisible.

**Writers.**
- Rows are written only by six SECURITY DEFINER trigger functions (owner `app_definer`, `search_path` pinned,
  EXECUTE revoked from PUBLIC).
- They copy columns of the row the caller's own statement inserted, updated or deleted, which has already passed
  the parent's RLS and guards. They return nothing.

**No LEAKPROOF marking.** Searches probe with `starts_with`, `text_ge` and `text_lt`, which stock Postgres already
marks leakproof. The migration fails if that ever changes. The original `search_tsv @@ tsquery` is re-checked on
the parent row. The 300 ms branch timeout is unchanged.

**Proof.** `apps/api/src/load/search_equivalence.test.ts` covers:
- every role and the system actor, with about 100 terms, over every ownership state, deal and collaborated
  contacts, soft deletes, edited and removed bodies, imported rows and another tenant: the same rows in the same
  order as the old query;
- token visibility equal to parent visibility;
- the token tables equal to the parents' lexemes after bulk writes;
- `app_user` cannot write the token tables;
- (merge review) erasure (`app.erase_contact`, the FK cascade), the retention sweep's purge, a merge (notes re-pointed)
  and an import revert (`app.import_revert_delete`) leave zero token rows for the removed messages and notes and no
  orphan token row anywhere, checked as the superuser (an orphan is invisible under RLS). A mutation that makes the
  delete triggers no-ops fails all four.

**Residual.** Which access path a search takes (key probe or newest-first walk) varies its latency with how many
token rows match. This is the same class of timing signal as before, and it is not exposed in responses.

### 6.6 Merge review fixes (migration `scale_review_fixes`)

The review of this lane against main's FUB parity code confirmed ten findings, and a review of those fixes confirmed one
more (the second lint row). One migration and three code changes fix them. Each change only narrows access, removes a
wrong count, or adds a missing mark, and each is proved by a test that fails without it.

| finding | fix | proof |
|---|---|---|
| Unqualified `feed_dirty` in the feed marks: a temp table could capture them, inside definers as `app_definer` / `app_retention` | every `app.feed_mark_*` writes `public.feed_dirty`; still SECURITY INVOKER | `packages/db/test/schema_invariants.test.ts` (static scan of every function body; a shadow table captures nothing) |
| Bulk sends counted as scoreboard touches, live and in the rollup (R-PAR-37) | §6.3: both definers and the day mark skip `bulk_action_id`; rolled days that counted one marked dirty | `rls_smoke_parity.sql`, `scoreboard_rollup.test.ts`, `bulk/bulk.test.ts` |
| A bulk email or batch text answered a waiting client in the feed (R-PAR-37) | the feed's touches read skips `bulk_action_id` (`workspace/repos/feedInputs.ts`) | `bulk/bulk.test.ts` |
| Parity detail policies paid `contact_detail_visible` per row (TC People page about 2.5 s) | §2.10: five SELECT policies through `app.contact_detail_row`; USING only | `load/deal_visibility_equivalence.test.ts` |
| Ownership, deal and team changes did not mark a Team Lead's or TC's own card | §6.1 "Who is marked" | `load/feed_incremental.test.ts` |
| Every settings write forced every member's whole-book recompute | only a zone change marks `'!full'` | `load/feed_incremental.test.ts` |
| A deleted contact point (import revert) marked nothing | `contact_points` DELETE trigger | `load/feed_incremental.test.ts` |
| Portal client lint did not ban `withPreTenantThenTenant` (R-TEN-14) | banned in client mode, with `applyOwnershipCommand` / `applyOwnershipCommandThen` | `packages/eslint-plugin/test/rules.test.js`, `config.test.js` |
| Re-review: the client lint still let client code call `runOwnershipFollowup` (`withTenantTx` as the system actor) and the queue's `claimJobs` / `finishJob` / `reapJobs` / `dueWork` (`withNoContext`), or take any other `@realty/db` value (R-TEN-14) | those and the pool (`getDatabase`, `createDatabase`) banned by name; from `@realty/db` client code takes only `portalTx.ts`'s value exports (an allowlist, so a helper added later is refused until listed); namespace imports, `export *`, `import()` and `require()` of it refused | `packages/eslint-plugin/test/rules.test.js`; `config.test.js` lints every value `@realty/db` exports in client code (only the `portalTx.ts` ones pass) and in the worker (only `withPortalTx` is refused) |
| No test of token cleanup on erase, purge, merge, revert | §6.5 | `load/search_equivalence.test.ts` |
| The rollup proof had no parity rows; its imported-rows check matched nothing | §6.3 | `scoreboard_rollup.test.ts` |

**Left as found.** `mail_messages_select` (D2) has the same per-row shape as the five parity policies; it has no read
route yet, and the pending D2 review migration both reorders it and pins its text in its smoke test, so it is not
rewritten here.

## 7. Parity security review (lane `parity-security-review`)

An adversarial review of FUB parity modules 56-67 (people edit and points, notes and mentions, stages, tags, custom
fields, relationships, smart lists, templates, bulk actions and batch text, import parity, duplicates and merge, stage
automation) and their migrations (0021, 0027-0029, 0035, 0036). Six reviewers worked one area each, against the code
and a live database through the real HTTP routes with sessions of each role; an independent skeptic then tried to
refute every finding. Only reproduced findings are listed. No migration was needed. Each fix only narrows access or
turns a 500 into a stable 4xx, and each is proved by a `secreview.*` test that failed before the fix.

### 7.1 Confirmed and fixed

| finding | severity | fix | proof |
|---|---|---|---|
| An import opt-out tag with an invisible, control or full-width character ("D​NC", "ＤＮＣ") landed in the catalog as "DNC" but recorded no opt-out, so the person stayed textable (R-PAR-46, R-CONSENT-3) | medium | `core/import/fub.ts` tests each tag as written and as the catalog folds it (`optOutTagForms`); the dry-run count agrees | `imports/secreview.optouttag.test.ts` |
| A tag protected after a bulk draft (or merged into a protected one) still let Confirm send to that audience (R-PAR-8, E189) | medium | the draft records every tag its audience was built from; confirm re-reads their protection and the saved list's plan for email, text and enroll | `bulk/secreview.protectedlate.test.ts` |
| A batch text left `queued` by a crash was sent on replay after the Owner turned batch text off (R-PAR-40, E185) | medium | the runner re-reads the switch before the replay path and cancels the queued message (item `skipped BATCH_TEXT_DISABLED`) | `bulk/secreview.switchreplay.test.ts` |
| Renaming a tag to a fair-housing proxy name ("VA buyer") left it unprotected and bulk-appliable (R-PAR-8) | medium | `PATCH /tags/:id` classifies the new name (tighten-only, audited `tag.protect`) | `people/secreview.tagrename.test.ts` |
| A bulk untag removed a tag that became protected after confirm (core refuses it at draft) | low | the runner re-reads `protected_proxy` before the removal (`TAG_PROTECTED`) | `bulk/secreview.protectedlate.test.ts` |
| The stage-change response named another agent's private playbook to a collaborator who cannot read it (R-PERM-12) | low | the plan name is shown only if the changer's own RLS shows the playbook, else "the owner's plan" | `stageAutomation/secreview.planname.test.ts` |
| Owner/Admin could add notes, points, relationships and edits to a merged-away loser (stranded rows, R-PAR-45) | low | api/people writes require a live contact (`liveDetailFacts`); reads unchanged | `people/secreview.live.test.ts` |
| Impossible ISO dates in a list definition (a team list saved by a TL) made every run a 500 | low | core `IsoDate` requires a real calendar date (year ≥ 1000) | `lists/secreview.inputs.test.ts` |
| Forged list cursors (keys `Date.parse` accepts but Postgres does not, NUL in a name key) and forged notes cursors were 500s | low | strict timestamp/uuid shapes in both decoders (`LIST_CURSOR_INVALID`, `VALIDATION_FAILED`) | `lists/secreview.inputs.test.ts`, `people/secreview.nul.test.ts` |
| A definition under core's 8 KB `JSON.stringify` limit failed the jsonb `octet_length` CHECK (500) | low | core measures the jsonb text; the CHECK maps to `LIST_DEFINITION_TOO_LARGE` | `lists/secreview.size.test.ts` |
| U+0000 in any JSON body reached Postgres (500) | low | the JSON body parser refuses NUL (422) | `people/secreview.nul.test.ts` |
| Control and bidi-override characters accepted in contact names, relationship labels and stage labels, and carried into mention titles | low | refused in those schemas; `mentionTitle` strips them from any stored name | `people/secreview.bidi.test.ts` |
| Merge values made only of invisible characters rendered "Hi ," (R-PAR-24); U+061C survived; template subjects accepted C1 controls, U+2028/9 and bidi overrides | low | more invisible characters stripped in `cleanValue`; stricter subject check | `core/parity/templates/secreview.unicode.test.ts` |

### 7.2 Checked with no finding

Cross-tenant ids through every parity route, list definition, bulk selection, template, mention, import mapping and
duplicate pair (404 or match nothing); the list compiler (no `sql.raw`/`sql.ref` with input, sort enum, bound cursor
values, `EXISTS` detail predicates, counts under the viewer's RLS); personal lists and templates of other users;
mention visibility (checked as the mentioned user) and text-free titles; note edit/delete rules; removed and
wrong-number points (R-PAR-12); bulk double confirm/run, caps, creator-only drafts, role change, suspended creator,
reassigned people, TC and team limits, one send per address, bulk messages never touches; FUB payload prototype keys,
assignment to other tenants' or inactive users, revert scope; duplicate pairs and merge visibility, opt-outs carried
by the merge; stage automation (approved versions only, owner's own plan only, imports never enroll, one live
enrollment, annual reminders); a role sweep over 29 mutating parity routes for TL, other agents, ISA and TC
(`secreview.roles.test.ts`: no 500, every 2xx matches `can()`); support has no HTTP actor and is refused by the
restrictive policies. Import revert and a person-level do-not-contact (candidate from the orchestrator): not
reproduced; the do-not-contact's own consent event makes the contact touched, so revert keeps the person, their
points and the flag, and an imported DNC stays as an address-keyed `import_dnc` suppression
(`imports/secreview.revertdnc.test.ts` guards it).

### 7.3 Left for the owner

- **Bulk draft snapshots show a personal template's text tenant-wide.** `bulk_actions` (DATA_MODEL) is readable by the
  creator, tenant-wide roles and the creator's TL, and holds the frozen subject/body, so an agent's personal template
  wording is visible to Owner/Admin/TL once a draft exists, though R-PAR-23 keeps the template itself private. This
  is the documented design; whether drafts should hide the snapshot from others is a product decision.
- **A template edited or archived after a bulk draft is still sent as frozen.** The code freezes at draft (E180,
  E186); R-PAR-26 says "at confirm". A warning at confirm when a newer version exists would close the gap.
- **Defence in depth not added:** `dispatchOutbound` and `messages_bulk_guard` (UPDATE) do not themselves re-read the
  batch-text switch; the runner does. A bulk audience built from an unsaved definition whose tag is later merged into
  a protected one is caught only through the recorded tag ids of the draft, not the rewritten definition.
- **Not reachable through the API:** an Admin or the creator could write `bulk_actions.counts` directly in the DB
  (`counts.selected` feeds the confirm-time email budget); freezing it after the draft would need a migration.
