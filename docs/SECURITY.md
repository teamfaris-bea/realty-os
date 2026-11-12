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
| Web in production: the `web` image's nginx sends exactly `webSecurityHeaders` (the header CSP, including `frame-ancestors 'none'`, and every other header above) with `always` on every response it serves: HTML, `/assets/`, the SPA fallback to `index.html`, `/healthz` and nginx's own error pages there. The lines come from one generated snippet, `deploy/security-headers.conf` (`node deploy/render-security-headers.mjs`), included in each content location because nginx drops inherited `add_header` lines in a location that sets its own (`Cache-Control`). `/api/` gets no nginx headers: the API's stricter helmet set above passes through alone, so no response carries two CSPs, and the API's own CORS (credential-less on `/api/public/chat/`, module 22) is neither added to, hidden nor answered by nginx. Module 37: `/widget/chat.js`, the chat widget script brokerages' websites load cross-origin, is the one location with `Cross-Origin-Resource-Policy: cross-origin` (`widgetScriptHeaders`, `deploy/widget-security-headers.conf`); every other location stays same-origin. The previous nginx `Referrer-Policy: no-referrer` on HTML is replaced by the policy's `strict-origin-when-cross-origin`: under `no-referrer` the Fetch standard sends `Origin: null` and no `Referer` on same-origin POSTs, which the CSRF origin check (`server.ts` `originOf`) refuses (not browser-verified here) | `deploy/nginx.conf`, `deploy/security-headers.conf`, Dockerfile `web` stage | `apps/web/src/security-headers.nginx.test.ts`: parses `nginx.conf` with its includes (resolved through the Dockerfile `COPY` lines), applies the inheritance rule, and asserts each content location's effective set equals `webSecurityHeaders` (`widgetScriptHeaders` for `/widget/chat.js`, the only cross-origin CORP; names, values, `always`), that `/api/` adds, hides or answers no header or preflight, that the snippet is exactly the generated text, and that the checker catches drift |
| CORS: the `WEB_ORIGIN` allowlist, with credentials, on every route except module 22's public website-chat prefix `/api/public/chat/`, which answers any website without credentials (no cookie ever rides along). A widget's allowed websites are enforced where its key is resolved (config and start: another website is 404); an open chat's session routes (messages, poll) rely on the 256-bit session token alone, so removing a website or rotating the key stops new chats there, not open ones (disconnecting the widget ends them) | `server.ts`, `channels/webchat.ts` | `auth/csrf.test.ts`, `channels/adversarial.test.ts` |
| The client's address (every per-IP rate limit, the audit IP) is one no client can write: the `web` image's nginx believes `X-Forwarded-For` only from private-network hops (`deploy/real-ip.conf`) and sends the API the client's address as the only entry, replacing what the client sent; the API believes it only from the peers `TRUST_PROXY` lists and refuses `TRUST_PROXY=true`, which trusts every hop | `deploy/nginx.conf`, `deploy/real-ip.conf`, `config.ts` | `channels/clientIp.test.ts` (a forged prefix never opens a new E137 bucket), `config.test.ts`, `apps/web/src/security-headers.nginx.test.ts` |
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
- The Undo of an address delete takes no address fields from the client. The delete answers an opaque restore token: the deleted row, the person, the deleting user and the database time, sealed with the tenant's field key (AES-256-GCM, AAD bound to the address id). `POST /contacts/:id/addresses/:addressId/restore` is an ordinary authenticated, CSRF-checked `contact.edit` route, not a capability URL: it opens the token inside the caller's tenant transaction and restores only for that user, person and address within 10 minutes (an altered or misdirected token is 404). So an Undo cannot plant a jurisdiction (it steers call-recording announcements) or an import batch (`people/addressUndo.test.ts`).

### 2.7 Secrets, logs and errors

- **Error bodies** are `{ error: { code, requestId, details? } }`. They carry no input echo, SQL or stack (`security.headers.test.ts`, `platform.test.ts`).
- **Logs** carry ids, codes and timings only:
  - PII keys are dropped, and E.164 numbers and emails are masked
  - request logs show the route pattern, never the raw URL, so the intake token and query strings are not logged
  - the error serializer emits masked message and stack only
  - the `web` image's nginx: its access log writes no query string and `-` for each secret of every path in `apps/api/src/capabilityPaths.json` (the invite, chat session, unsubscribe and intake tokens and module 29's signed marketing image link; generated from the route table), and its error log writes no request (`error_log /dev/null` in the server, since nginx adds the raw request line and the upstream URI to every record about a request)

  Tests: `audit.test.ts` (R-TEN-7); for nginx, `apps/api/src/capabilityPaths.test.ts` and `apps/web/src/security-headers.nginx.test.ts`.
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

### 2.11 Recording counsel reviews of platform packs (owner command, R-INT-6)

`pnpm --filter @realty/db counsel-review` (in the image: `node packages/db/dist/scripts/counsel-review.js`; runbook
DEPLOY §10.1) is the only writer of `jurisdiction_packs.reviewed_by_counsel_at`. No route, tool or migration writes
it, and the packs still ship unreviewed.

- **Who may run it:** whoever holds the database owner credential (`MIGRATION_DATABASE_URL`), as a one-off command,
  never the api or worker (DEPLOY §3). The command refuses, in a dry run too, any role that cannot update
  `jurisdiction_packs` or is subject to its row-level security (neither superuser nor `BYPASSRLS`). `app_user` has
  SELECT only and is refused, and a direct `UPDATE` by it fails with `permission denied`.
- **Pinned to a version:** each key names the version counsel reviewed (`platform:<name>@<version>`) and is recorded
  only while that version is the published one. A later version ships unreviewed and turns its capability off again,
  and replaying an old command (an old pin) after a pack bump is refused, so a review is never stamped onto a version
  counsel did not see.
- **What it changes:** for each pinned key, only the published version's `reviewed_by_counsel_at` (00:00 UTC of the
  stated review date) and one note appended to `notes` (UTC time recorded, database role, version, review date, the
  reported source). It never writes `rules`, so it never sets `vendor_ready_at`: voice and Gmail stay off until their
  vendor checks pass. It refuses other keys (`US` and other jurisdiction packs, unknown or unpublished keys,
  `platform:meta`), a review date before 2026-01-01, before the pinned version's month or after today (UTC, on the
  client's and the database's clock), a pack already recorded with a different date, and a review set outside the
  command (no note of its own), which it names instead of reporting it as recorded. It is all or nothing, one
  transaction, and a dry run by default (the change is made, reported and rolled back); `--apply` with `--dry-run` is
  refused. `--revoke` withdraws a recorded review with the same safeguards: `reviewed_by_counsel_at` back to NULL and
  a withdrawal note; it is the supported correction for a mistaken `--apply`.
- **Effect:** a recorded review lifts that pack's hold on its capability on that deployment at once, and a withdrawal
  restores it at once. That is a compliance decision, so it is recorded only from the owner's report of counsel's
  review (`--reference` names the source: one line of plain text, no control, format or line-separator characters).
  It turns no capability on by itself.
- **Audit:** there is no platform-level audit table (`audit_log` is per tenant), so the trail is the pack's own
  `reviewed_by_counsel_at` and notes (readable by `app_user`) plus the printed output, which the operator keeps with
  the deploy log. A tamper-evident platform log is not built.
- **Tests:** `packages/db/test/counsel_review.test.ts` (R-INT-6: version pins and a pack bump, published version only,
  idempotent only for its own record, refusals, dry run, `--revoke`, never `vendor_ready_at`, owner role only, the
  database clock, the note as the audit trail).

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
| The lead intake source token is in the URL path (so are the invite token, the website chat's session token, the unsubscribe ref and the signed marketing image link) | The `web` image's nginx writes each of them as `-` in its access log (`$log_uri`, `deploy/nginx.conf`, every path of `apps/api/src/capabilityPaths.json`) and no request to its error log; a load balancer or CDN in front keeps its own access and error logs | Strip paths under `/api/auth/invites/`, `/api/intake/`, `/api/public/chat/session/`, `/api/email/unsubscribe/` and `/api/public/marketing-assets/`, and query strings, from the edge's logs too; or move the invite token into the request body (as reset confirm does) and the intake token to a header in a future intake API version |
| Prompt injection from contact content into the assistant | Covered by §4 (lane `prompt-injection`): the model is assumed fully compromised and every server-side rule is tested against a hostile fake. What remains is listed in §4.5 | none beyond §4.5 |
| DNS rebinding on FUB recording URLs and the FUB base URL | A public name that resolves to a private IP is not re-checked at connect time | Worker egress policy (deny private ranges) at deployment |
| Imported FUB fields (`imported_fields`: source URL, `custom*`) are attacker-controlled | Today they render as text only | Any future link from them, or from contact emails and phones (`mailto:`/`tel:`), goes through `safeUrl` |
| nginx error pages produced outside a content location carry no web headers | A 502/504 for an unreachable API (in `/api/`, which adds none so the API's own CSP stays the only one) and a 400 for a request refused before location matching are nginx's static HTML with no script | none needed; revisit if custom error pages are added |
| Gmail inbox sync (Phase 2, owner decision D2; design only, DATA_MODEL §6.3, ARCHITECTURE §21.10) stores agents' refresh tokens and copies of client mail | The restricted scope `gmail.readonly` needs Google's OAuth verification and a third-party security assessment, renewed periodically (**VERIFY** current requirements); team visibility of an agent's client mail needs counsel (C14) | Keep `platform:gmail` uncleared until N19 and C14 pass (C14's review is recorded with the owner command of §2.11, which never sets the vendor check `vendor_ready_at`); refresh tokens envelope-encrypted with row-bound AAD, access tokens in memory only, no bodies or addresses in logs, never sent to a model, never readable by a support actor (RESTRICTIVE policy) |
| A media link is a bearer URL for up to 10 h 20 min | The provider fetches without our session; anyone who sees the request can fetch until expiry, or until the message leaves sending/sent | If Twilio signs media fetches, also require X-Twilio-Signature; shorten the window once the fetch timing is known (VERIFY) |
| The provider's stored copies are public URLs unless "Enforce HTTP Basic Auth" is on; MMS Converter sends recipients without MMS a public p.twil.io link | Provider account settings | Turn on Basic Auth for media on each subaccount; the owner decides MMS Converter (VERIFY) |
| Rotating the link secret breaks media links in flight | Stateless tokens (SESSION_SECRET_BASE64) | Rotate outside sending hours; the affected texts fail with the provider's media error |
| A media token (in the query string of `/api/mms/media`) can reach the TLS terminator's or load balancer's logs, and Twilio's own request and error logs, for the link's 10 h 20 min life | Logs outside this repository. Inside it nothing logs the token: the API logs the route pattern only, nginx's access log is built from `$uri` (no query string, asserted by `security-headers.nginx.test.ts`) and nginx's error log writes no request (`error_log /dev/null`) | No query strings logged for `/api/mms/media` at the terminator (deploy owner, DEPLOY §5; VERIFY) |
| CSP coverage of signed-in pages was exercised in error and empty states | E2E data seeding with the API was not in scope | Extend `csp.spec.ts` with a seeded API run |

---

## 4. Prompt injection (lane `prompt-injection`)

**Assumption.** The model can be fully manipulated by anything it reads. So everything it outputs is attacker-controlled, and every rule that matters is enforced by the server, outside the model. The tests prove this with `HostileAi` (`apps/api/src/providers/fake/hostileAi.ts`), a fake provider that plays a compromised model. It sits next to the deterministic `FakeAi`, which is unchanged.

### 4.1 Where untrusted content enters a prompt

Every prompt is built by `core.assistant.buildPrompt` (`packages/core/src/assistant/prompt.ts`, `assistant-prompts/2.1.0`). Its input is ONE contact's bundle, read by `apps/api/src/assistant/repos/context.ts`.

| Untrusted content | Who controls it | Reaches the model through |
|---|---|---|
| Inbound SMS and email bodies | the client, or anyone who knows their number or address | `CONVERSATION` (drafts, handbacks, summaries) |
| Reaction texts (D5b: Loved “…”, 👍 to “…”) | the client's phone | `CONVERSATION` as `client (sms reaction to the team's text [Sn])` with only the reaction as untrusted data. The quoted words of the inbound body are never printed as anyone's words, and the reaction's evidence source holds only its own words, so a model cannot cite the team's words as the client's (R-REACT-7) |
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

A read-only connector to FBS's Spark RESO Web API (lane `spark-prep`; adapter in `apps/api/src/providers/integrations/spark.ts`, service and routes in `apps/api/src/mls/spark/`, routes under `/api/admin/integrations/mls/spark`). The operator procedure is `docs/DEPLOY.md` §11. Feed sync into `listings` rows is module 24 (api/mls: `apps/api/src/mls/{sync,eligibility,sweep,competing,admin}.ts`); what any audience may see is decided by the `core/listings` display rules and the connection's licence pack, which shows nothing to clients until every value is marked counsel-reviewed.

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
| **Path allowlist.** `/Reso/OData/$metadata` and `/Reso/OData/Property` only. The feed has no Media entity set; photos come from `$expand=Media` on Property. | same |
| **Response headers are never read** but `Content-Length` and `Retry-After`. Spark echoes the key's identifier in an `X-Api-Key` response header; it is never logged, stored, audited or returned. The API logger also censors `authorization` and `x-api-key` request/response headers (pino `redact`), on top of serializers that emit no headers. | the adapter, `apps/api/src/server.ts` |
| **Field-level permissions.** A record's `<Field>@Core.Permissions` annotation that does not grant Read removes the field before anything reads it (never displayed or sent); every annotation key and every field `$metadata` does not declare is ignored. | `sanitizeRecord` in the adapter |
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
| ~~**VERIFY** the replication endpoint~~ | Answered by the live check (finding 1): this key works only on the replication host | Set the replication host in `SPARK_API_BASE_URL` / `SPARK_ALLOWED_HOSTS` (DEPLOY §11.1) |
| **VERIFY** field availability | Partly answered (findings 4-6): the mapped standard fields are present except `LivingArea`; which fields each role may read is per-field (`Core.Permissions`) | Confirm with Spark support and the MLS which fields the licence lets clients see |
| **VERIFY** rate limits | Not known for this key | Confirm with Spark support; tune the retry budget |
| **VERIFY** licence coverage | Owner-confirmed only; not independently re-verified with the MLS | Owner gets written confirmation from the MLS before any live call |
| **VERIFY** key deactivation at FBS | How a leaked or retired key is deactivated at FBS is not documented here | Owner confirms the process with FBS; disconnecting in the app only purges our copy |
| DNS rebinding on the allowed host | A public name that resolves to a private address is not re-checked at connect time (as for FUB, §3) | Worker and API egress policy that denies private ranges |
| **VERIFY** `Core.Permissions` values | Which annotation value withholds a field; anything but an explicit Read withholds it here (strictest) | Confirm with Spark support and the MLS |
| **VERIFY** `$expand=Media` paging | Whether `$select` inside `$expand` is honoured (off by default) and the largest `$top` with `$expand` (default 100, at most 20 pages per run) | Confirm with Spark support; tune `pageSize` / `expandSelect` |
| **VERIFY** the living-area field | No `LivingArea` in this feed; the size is read from `BuildingAreaTotal`; which field is the finished living area is unconfirmed | Confirm with the MLS; change `SPARK_FIELD_MAPPING` |
| **VERIFY** the sync interval | 15 minutes per connection (`SYNC_INTERVAL_MS`); the licence may require a refresh cadence | Confirm with the MLS; the pack's `max_staleness_hours` pauses client output when exceeded |
| Feed sync review | Module 24 writes `listings` (source `mls`) as the system actor only (R-MLS-1, existing RLS) | Reviewed in this lane: no new definer, policy or grant; migration `*_mls_listing_indexes.sql` adds indexes only |

**Live findings (read-only check, 2026-11-11).** With the CRM's own key, the orchestrator made five GET requests (the `$metadata` document twice, the one-record probe three times). What they showed, and how the code answers each point (the mock transport in `spark.testing.ts` reproduces every one; tests in `spark.test.ts`, `mls/spark/spark.api.test.ts` and `mls/sync.spark.test.ts`):
1. The key is a **replication key**: the standard host answers 403 naming the replication host, the replication host serves it. The base URL is set to the replication host through `SPARK_API_BASE_URL` / `SPARK_ALLOWED_HOSTS` (DEPLOY §11.1); that 403 maps to its own result, `replication_endpoint_required`, with a plain-words Owner sentence; every nextLink must stay on an allowed host.
2. The service has five entity sets (Property, Member, Office, OpenHouse, Lookup) and **no Media set**: photos are requested with `$expand=Media` on the Property page request, so no extra request per listing.
3. Media carries the standard RESO media fields; `Order` is `Edm.Int64` (number or string accepted).
4. Property declares about a thousand fields, a returned record carried hundreds more that `$metadata` does not declare, plus `<Field>@Core.Permissions` annotations: unknown keys are ignored, annotation keys never fail the parse, a withheld field is removed.
5. There is **no `LivingArea`**; `BuildingAreaTotal` is populated and mapped; `AboveGradeFinishedArea` was present but empty (**VERIFY** the finished living area).
6. `StandardStatus` is a string whose values come from the Lookup resource; the internet-display Y/N fields and `PhotosCount` are present; list-agent contact fields were empty.
7. A transient **503** ("took too long") came back once and the same request then succeeded: it is `BUSY`, retried by the sync inside its budget, and the single validation probe reports `busy` ("Spark was busy. Try again in a minute."), not a bad key, without moving the connection's status.
8. Every response carries an **`X-Api-Key`** header echoing the key's identifier (see the control above; a canary in the mock is searched for in logs, error reports, audit rows, every table and API responses).
9. The one-record probe returns no `@odata.nextLink` and no `@odata.count`, and that is a success.

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
  equal to the 0012 body row for row for every role and the system actor. Since the re-inquiry change below, the
  reference is the 0012 body plus the re-inquiry rule.
- **Re-inquiry periods (owner decision 2026-11-11, DATA_MODEL R-ACC-2 / E68; migration
  `0045_api_accountability_reinquiry_periods.sql`).** A re-inquiry that starts a new ownership period
  (`payload.newPeriod`) is a speed-to-lead period of its own and ends the earlier period's first-touch window.
  `app.scoreboard_speed`, `app.scoreboard_rollup_roll` (speed rows only) and `app.scoreboard_mark_ledger` were
  replaced with `CREATE OR REPLACE` (same signatures) and re-asserted: owner `app_definer`,
  `search_path = pg_catalog, public`, EXECUTE revoked from PUBLIC, granted to `app_user` for the two callable ones.
  They return the same columns as before (timings and counts only, no contact id), and the member rule is unchanged.
  `v_speed_to_lead` keeps `security_invoker`. Every rolled day whose speed rows change (a re-inquiry period's day, and
  the day of the period before it) was marked dirty by the migration. Proof:
  `apps/api/src/accountability/scoreboard_reinquiry.test.ts`, which migrates a database rolled under the old
  definitions.
- **One leaves-the-owner rule (batch 6 review F5; migration `0047_api_accountability_period_end_withdrawn.sql`).** A
  period's first-touch window also ends at any ledger event that takes the lead out of `owned` or gives it to someone
  else (an owner-changing `merged_in`, a deactivation re-route from owned to offered), as the untouched-lead card
  already read it. `app.scoreboard_speed` and `app.scoreboard_rollup_roll` (speed rows only) were replaced with
  `CREATE OR REPLACE` (same signatures) and re-asserted: owner `app_definer`, `search_path = pg_catalog, public`,
  EXECUTE revoked from PUBLIC, granted to `app_user`. They return the same columns, and the member rule is unchanged.
  `v_speed_to_lead` keeps `security_invoker`. `app.scoreboard_mark_ledger` is unchanged (an appended window end changes
  no earlier row). Every rolled day whose speed rows may change was marked dirty by the migration. The migration also
  adds `exception_items.withdrawn_at` (untouched_lead only, CHECK) under the table's existing policies and grants; it
  is written only by the system recompute (`exceptions_update`). Proof: `scoreboard_period_end.test.ts` (migrates a
  database rolled under the old definitions) and the rollup equivalence of `scoreboard_rollup.test.ts`.

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

### 6.7 Pond leads in the feed (migration `pond_leads_feed`, lead-journey fixes)

**What changed.** A pond lead reaches the members allowed to claim it on Home and on the Pond page (docs/ARCHITECTURE.md
§14 "Pond leads"). Before, the feed was built with no pond leads at all, so nobody saw one outside the Pond page.

- **One new definer, `app.my_pond_leads(since, ids)`** (owner `app_definer`, `search_path = pg_catalog, public`,
  STABLE, EXECUTE revoked from PUBLIC and granted to `app_user`; every table schema-qualified, so the
  `schema_invariants` scan covers it). A pond card's viewer may not read the lead's ownership ledger (R-PERM-6: the
  history stays hidden), so the function reads exactly the facts the card needs and nothing else. It returns rows only
  for the CALLER's own claimable ponds (`app.my_pond_ids()`: an active membership whose role is one of the pond's
  eligible roles, a pond open to all or naming them, not archived, `claims_per_day > 0`); an Owner/Admin, a TC, the
  system actor or a support actor gets nothing. Per lead it returns: when it entered its pond, that event's ledger seq
  (the card's per-occurrence key; never serialized), whether an import put it there, and when the caller's OWN claim
  cooldown on it ends (the caller's own release or loss; the claim route already answers `CLAIM_COOLDOWN` for it).
  Never a name, an address or another member's id. With both arguments NULL it returns nothing (no whole-pond scan).
  The migration's self-check asserts the owner, the pinned path, STABLE, the grants, that `app.feed_*` stay
  invokers and name `public.feed_dirty`, and that the pond marks exist.
- **Who sees a card is never wider than who may claim.** Per-lead rules (eligibility, claims allowed, cooldown) are
  applied when the card is stored; per-member totals (claims today, the capacity cap) when the feed is read, so a
  member over a limit sees no claim card. The claim itself is unchanged: the ownership engine re-checks every rule
  under the contact lock, so exactly one claimer wins (R-OWN-16), and a stored card can never make a claim succeed.
  Names are masked on the card as on every pond card (`maskLastName`, R-PERM-6). `feed_select` (own cards, contact
  visible) still hides a card the moment the contact leaves the member's view.
- **Marks** (still SECURITY INVOKER, schema-qualified): a lead entering, leaving or moving between ponds marks the
  members eligible for the old and the new pond; a `ponds` settings change and a `pond_members` insert or delete mark
  the affected members `'!full'`. A mark only causes a re-score of the marked member's own data under that member's
  own RLS.
- **No policy changes.** GET /me/ponds (auth `self`) lists the caller's own claimable ponds with the reason a claim
  would be refused now (claims today, capacity), from the caller's own counters.

**Proof.** `apps/api/src/workspace/pond.feed.test.ts` (a released lead reaches every member who may claim it, as a
masked card; never the releaser in cooldown, a TC, the Owner or an Admin; a members-only pond reaches only its
members; the first claim wins and the other cards go at once; a member over the day's claim limit or the capacity cap
gets no card until under it, and GET /me/ponds says why; the definer answers only the caller: a TC, the Owner, the
system and another tenant get nothing);
`apps/api/src/load/feed_incremental.test.ts` (incremental equals full with pond entries, exits, claims, releases and
cooldowns in the random sequences, plus a deterministic pond-marks test that fails without the exit marks).

**Wrong-number removal (R-PAR-12).** The person's edit sheet offers "Remove as a wrong number" only on a point whose
consent ledger holds a `wrong_number` revoke (the remove route's own test, `GET /contacts/:id/points`
`wrongNumberReported`); everywhere else it says why it is not offered. What such a removal does to the person's other
phones is unchanged (journey J3.4 stays open: lifting a copied opt-out is an owner/counsel decision).

### 6.8 Performance lane 2: security review items (lane `perf-misses-2`, migration `helper_plan_cache`)

Every change of this lane that touches who-sees-what, a helper, a policy or the send gate is listed here with its
proof. None marks anything LEAKPROOF, none adds `USING (true)` or BYPASSRLS, none adds or widens a definer or a grant,
and nothing is cached across tenants or users except query **plans** (which hold no data; below).

#### 6.8.1 RLS helpers keep their plans (LANGUAGE sql → plpgsql, same query)

**What.** Twelve helpers: the definers `app.my_role`, `is_tenant_wide`, `is_member`, `sees_all_detail`,
`my_team_member_ids`, `my_pond_ids`, `my_deal_contact_ids`, `my_collab_contact_ids`, `contact_exists`, and the
invokers `app.contact_visible`, `contact_detail_visible`, `deal_visible`, `contact_owned_by_my_team`. Each body is
the previous SQL body word for word, as `RETURN (<body>)`. None of them was inlined before (definers with a `SET`
clause; the invokers' bodies hold an `EXISTS` sublink), so nothing loses inlining; `app.contact_detail_row` (the
inlined twin) stays `LANGUAGE sql`.

**Why it is the same function.**
- Same signature, return type, volatility (`STABLE`: the caller's snapshot), `SECURITY DEFINER` / invoker exactly as
  before, the same pinned `search_path` on the definers, no `SET` on the invokers. `CREATE OR REPLACE` keeps the
  owner (`app_definer` for the definers), the ACL (no `PUBLIC` EXECUTE on the definers) and the comments; the
  migration's self-check fails otherwise.
- Every body returns exactly one row (an `EXISTS`, an aggregate or a boolean expression), except `my_role`, which
  reads at most one (`memberships` primary key `(tenant_id, user_id)`). A scalar sub-query of zero rows is NULL,
  as a SQL function of no row is.
- **Plan caching holds no data and no context.** Every GUC is read by a function call *inside* the query at
  execution time (`app.tenant_id()`, `app.user_id()`, `app.actor_kind()`, `app.principal_type()`), and the
  arguments are plpgsql parameters, so one cached plan is valid for every tenant, user and actor. Postgres
  re-plans a cached plan when the role, `row_security` or a referenced object changes, so an invoker's plan is
  never reused with another role's policies. This is the same mechanism every existing plpgsql guard of the
  schema already uses.

**Proof.** `apps/api/src/load/helper_plan_equivalence.test.ts` writes the previous bodies out as temporary SQL
functions (definers as definers, invokers as invokers, nested calls to the previous twins) and compares every helper
with its twin under every request context (each role, two members where the tenant has two; the system actor;
support without a grant and with a live grant; a client principal; an agent inside its own ownership command), on
every contact of the tenant (every ownership state, collaborated, on deals, pond and offered people on the TC's deal,
soft-deleted, moved by the command) plus another tenant's, and `deal_visible` on every deal. All contexts run
interleaved on **one connection** for six rounds, past the plan cache's switch to generic plans. Zero differences.
Dropping the deal branch from the new `contact_detail_visible` makes it fail (6 contacts, as the TC).

#### 6.8.2 Tag and custom-value SELECT policies: tenant-wide callers first

**What.** `contact_tags_select` and `contact_field_values_select` (SELECT only):
`(SELECT app.is_tenant_wide()) OR EXISTS (SELECT 1 FROM app.contact_detail_row(t.tenant_id, t.contact_id))`.

**Why the rows are the same.** For a tenant-wide caller (the system actor, an Owner or Admin, support with a live
grant; staff principal with a tenant set) the old `EXISTS` is true for every row the tenant policy admits: the
row's `(tenant_id, contact_id)` references `contacts (tenant_id, id)` (FOREIGN KEY, `ON DELETE CASCADE`, not
deferrable), that contact passes `contacts_select` through its `(SELECT app.is_tenant_wide())` branch (no
`deleted_at` condition) and the tenant policy, and `contact_detail_row`'s detail test passes through
`sees_all_detail()`, which includes `is_tenant_wide()`. For any other caller the first operand is false and the
policy is the old one. WITH CHECK, INSERT, UPDATE and DELETE policies are unchanged (self-check).

**Proof.** `apps/api/src/load/deal_visibility_equivalence.test.ts` (old USING = 0021's per-row
`contact_detail_visible`, row by row) now also runs as support without and with a live grant and as a client
principal. Zero differences. Writing the shortcut with `sees_all_detail()` instead (which also admits Team Leads)
makes it fail: a Team Lead would see 292 more tag rows.

#### 6.8.3 Query shapes (no policy change)

| change | why the rows are the same | proof |
|---|---|---|
| Exception queue rows read contact detail through `EXISTS (… app.contact_detail_row …)` | the helper's documented equivalence with `contact_detail_visible` (§2.10) | `deal_visibility_equivalence.test.ts` compares the two for every actor and contact |
| Smart-list counts of non-book viewers add `c.id IN (<the required tag / value rows>)`, several of them as one `INTERSECT` | the WHERE already requires a visible row of each set, read under the same RLS: the clause is implied | `apps/api/src/lists/value_driven.test.ts`: driven = plain WHERE id for id, 21 definitions, every context of §6.8.1 |
| Owner/Admin "next task" page as one statement in two ordered parts (dated open tasks grouped by person, then the undated people), each read only to the page size | the key is `min(due_at)` of the same visible open tasks; it is NULL exactly for the undated people, who sort last. One statement, so one snapshot (the self-review found that a first two-statement version could show a person twice, or drop one, when a task changed between the statements) | same file: page after page through the cursor, across the dated/undated boundary, with undated tasks in the fixture; removing `due_at IS NOT NULL` is caught; a test pins the page to one statement |
| Owner/Admin name-filter page from the first 2,000 people of the sort index when that holds a full page | the prefix is the start of the list order; otherwise the single scan runs. `enable_sort` is pinned off for that one bounded statement only (a planner choice); after an error nothing is reset in the aborted transaction, so a timeout still answers `LIST_TOO_SLOW` (the self-review found the reset hid it behind a 500) | same file, with the production prefix and a 100-row prefix; returning a short prefix is caught; the timeout test fails with the reset in a `finally` |

#### 6.8.4 Ownership engine round trips (no policy change)

- The tenant facts, people, open-deal fact and DB clock are read in one statement (`loadCommandFacts`), after the
  contact lock; the clock is read again only when the context took further locks (routing, memberships), so the
  decision clock is still read after every lock (R-OWN-6).
- The stored-outcome check (R-OWN-7) runs once, under the contact lock. The removed read before the lock was the
  same check without the lock: a replay now waits for the lock and returns the same stored outcome. Merges keep both.
- `commandRecord` reads the events and the caller's rejection in one statement (the same two sub-queries).
- Proof: `packages/db/test/ownership.*` (replay, concurrency, merge) and `apps/api/src/leads/*` pass unchanged, and
  the bench's ownership checks stay green at 250k (one winner per contested lead, 200/200 offers accepted by their
  offerees).

#### 6.8.5 Feed channel hint = the send gate's opt-out fan-out (R-PAR-12)

`workspace/repos/feedInputs.ts gateSummaries` read opt-outs only from live points, so a person whose removed phone
texted STOP could show texting as available on the card while the composer and the gate refused it. It now reads
the gate's fan-out (`kind = 'phone' AND (removed_at IS NULL OR removed_reason IS DISTINCT FROM 'wrong_number')`):
a revoke on any of those phones blocks texting (`sms`) or calling (`voice`) every phone of the person, as
`canContact` does. The hint only became stricter; the send gate, `canContact` and the dispatch guards are
untouched (D1 unchanged). Proof: `apps/api/src/workspace/feedHint.test.ts` (a removed phone's STOP and "do not
call" block the card; a confirmed wrong number does not); its two R-PAR-12 cases fail without the change.

#### 6.8.6 Adversarial self-review

An independent review (a separate agent given only the diff, the docs and a database) looked for any row a context
can see or write after the change that it could not before, and any send the gate now allows that it refused before.
It compared every helper body and catalog attribute with the previous definition, exercised the plan cache across
role, tenant, actor kind, support grant, client principal, ownership command and `search_path` changes on one
session, checked the tenant-wide policy shortcut against the foreign key and every policy branch, and read the
smart-list shapes, the ownership engine and the feed hint. It found **no visibility, write or send regression**. It
reproduced two correctness bugs in the smart-list page shapes, both fixed above (§6.8.3) with tests that fail without
the fix. It did not run concurrent claims or accepts against a live database; those rest on the unchanged contact
lock, `FOR UPDATE` and seq check, the db ownership tests and the bench's 250k ownership checks.

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
| Owner/Admin could add notes, points, relationships and edits to a merged-away loser (stranded rows, R-PAR-45) | low | api/people writes require a live contact (`liveDetailFacts`): edits, stage, points, addresses, relationships, notes and logged activity are 404 on a merged-away record; reads unchanged. **One exception, by design:** `POST /contacts/:id/do-not-contact` still accepts a merged-away record from whoever still sees its detail and holds `contact.edit` on it: the Owner, Admins and the loser's collaborators (a merge moves neither collaborators nor deals, so they keep sight of the loser and not, unless they had it, of the survivor). The TC and other members of the loser's deals see it but have no `contact.edit`; its former owner and their Team Lead no longer see it; all of them get 404 (batch 5 review F3). Recording an opt-out only tightens and strands nothing: the definer trigger `app.contacts_dnc_follow_merge` (0018) copies the do-not-contact and its ledger event onto the survivor's own row, along merge chains (R-CHAN-2, E140), and the revokes are keyed by the HMACs the merge copied onto the survivor. A collaborator's request therefore reaches a survivor they cannot see; that is the same effect as recording it on the loser before the merge, which the trigger carries anyway, and it reveals nothing about the survivor. Refusing it (as the first version of this fix did) left the people who still see a merged duplicate unable to record that duplicate's request. | `people/secreview.live.test.ts` (the refused writes for Owner and Admin, the do-not-contact blocking the survivor on every channel and purpose in canContact and the dispatch guards, a collaborator's 200 carried to a survivor they cannot see, and the 404s of the TC on the loser's deal, the former owner and their Team Lead), `comms/guardEquivalence.test.ts` (E140) |
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

### 7.4 Batch 5 review fixes (migration `0041_batch5_review_fixes`)

A review of batch 5 (lead-handling follow-ups 0037, pond leads in the feed 0038, the helper plan cache 0039, lead-email
intake 0040, the parity security-review fixes and the deploy rehearsal) confirmed five findings, each reproduced by
an independent probe through the real routes. One migration and the code changes below fix them. Each change only
locks, refuses, purges or marks more; no opt-out check, guard, policy or grant is weakened, and each is proved by a
test that failed before the fix.

| finding | severity | fix | proof |
|---|---|---|---|
| **F1-ERASE-DNC-TOCTOU.** The erasure's do-not-contact check was check-then-act: a phone a still-open transaction added to a do-not-contact person (a lead-email intake or accept, `POST /contacts/:id/points`) was invisible to the route's carry and to `app.purge_contact_internal`'s `PERSON_DO_NOT_CONTACT_UNCARRIED` check; the DELETE waited for the writer, then cascade-deleted the phone with no revoke, and the number was texted afterwards, also by the lead-email first response (D1) | medium | the purge locks every record of the person `FOR UPDATE`, sorted, before it checks anything (re-reading the merge tree until stable): `FOR UPDATE` conflicts with the `FOR KEY SHARE` every child row's foreign key holds, so the writer is waited for and its point is seen (the check refuses), and a later writer fails its foreign key. The erase route first takes, in the global lock order, the address lock of every point of the person (an intake that matched the person holds one), then the same row locks (`repos/erasure.ts lockPerson`), so its carry sees the point and records the revoke | `admin/erasure.race.test.ts` (the receive webhook, the Needs review accept and the points route, each held open by an outside table lock after writing the phone: the erasure waits, the phone carries the revoke, and neither an agent's text nor the first response reaches it); `packages/db/test/batch5_review_fixes.test.ts` (the purge and the sweep against an uncommitted point insert: refused / skipped) |
| **F2-ERASE-HELD-LEAD-EMAIL.** A held ("Needs review") lead email is never linked to a contact, so a privacy erasure left the person's name, phone, email and message decrypted in Needs review, and accepting it re-created the erased person; held content never expired either (R-DATA-4, R-DATA-3) | medium | held rows keep `point_hmacs` (the tenant-HMACs of their parsed addresses, keyed as intake keys points; never an address); the purge ends every held email naming an address of the person (live or removed, a confirmed wrong number excepted) as `erased` (content, parse, keys, sender and DKIM domains gone; the row stays only as the replay tombstone of its message key) and drops the sender/DKIM domains of lead emails linked to the person; `app.retention_sweep` expires held content 30 days after receipt by the database clock (`LEAST(p_now, now())`: a far-future `p_now` expires nothing young). The guard lets only `current_user = 'app_retention'` make these transitions; erased/expired rows are `NOT_FOUND` to the review routes | `leadEmail/erasure.test.ts` (keys only, never an address; the erased person's held email is gone for the Owner and the Team Lead, accept/discard `NOT_FOUND`, nobody re-created, a replay after the webhook-id purge still a duplicate, a stranger's held email untouched; expiry through the worker's pass); `packages/db/test/batch5_review_fixes.test.ts` (the guard refuses the system actor, a merged duplicate's and a removed address's held mail is purged, expiry) |
| **F4-ERASE-POND-PHANTOM-COUNT.** The contacts feed marks fired on INSERT and UPDATE only: an erased or purged pond lead's cards cascaded away, but every claim-eligible member's stored count (`feed_groups.n_open`, GET /feed's total) kept it until the hourly reconcile (cosmetic: "0 of 1 items shown") | low | an AFTER DELETE statement trigger on `contacts` (`app.feed_mark_contacts_deleted`, SECURITY INVOKER, writes `public.feed_dirty` only, probes `feed_groups` by its primary key through `memberships`) marks every member holding a feed group of a deleted record | `workspace/pond.feed.test.ts` (every eligible member's total equals what is shown right after the erase); `load/feed_incremental.test.ts` (incremental equals full after an erase; fails without the trigger); `packages/db/test/batch5_review_fixes.test.ts` |
| **F1 (bulk stage).** A bulk Change stage into a stage whose plan starts on entry enrolled a protected-tag audience (a "VA buyer" list) into a marketing plan, around the `AUDIENCE_PROTECTED_PROXY` refusal bulk enroll gets; an agent could do it alone on their own plan (R-PAR-8, R-PAR-16) | medium | the bulk runner names its action in `app.bulk_action_id` for each stage change; the replaced history definer stores it in `contact_stage_events.bulk_action_id` only for a running stage action of the tenant created by the user making the change; a stage draft records the tags its audience was built from (as sends do); the stage automation skips such an event (`protected_audience`, a new closed-set reason) when, read as the creator now, the recorded tags or the saved list's plan are protected, or the audience is unknown. The stage change itself still happens (one-to-one work), and an unprotected bulk stage still starts the plan (owner decision 2026-11-11) | `bulk/secreview.stageplan.test.ts` (saved list, tag chip and picked-from-list selections; a tag protected after the run; the unprotected control); `packages/db/test/batch5_review_fixes.test.ts` (only a valid id is recorded); `stageAutomation/decide.property.test.ts` |
| **F2 (deploy).** `docker-compose.prod.yml` gave the internet-facing api and worker the shared env file holding the Postgres superuser's URL and password (`MIGRATION_DATABASE_URL`, `POSTGRES_OWNER_PASSWORD`); nothing refused it (`assertRlsBoundLogin` checks only `DATABASE_URL`). A leak or code execution there would have been a superuser login: every database guard, the append-only and audit tables, `COPY … TO PROGRAM` | medium | two env files: `.env.production` (api, worker, release) holds no owner credential; `.env.owner` (`deploy/env.owner.example`, `fill-staging-env.sh … owner`) reaches only the postgres service and the release step, by interpolation from `--env-file .env.owner`; one-off owner commands take it explicitly (DEPLOY §9, STAGING §5-§6). Under `NODE_ENV=production` the API and the worker refuse to start, first thing, with `MIGRATION_DATABASE_URL`, `POSTGRES_OWNER_PASSWORD` or `POSTGRES_PASSWORD` in their environment (`dbRole.ts assertNoOwnerCredentials`) | `deploy.env.test.ts` (the templates; the compose file; `docker compose config` rendered from the filled templates: no owner credential in api, worker or web); `dbRole.test.ts` (unit, and both entrypoints spawned: exit 1, the variable named, never its value) |

**Security review items (CONVENTIONS §4).**
- `app.purge_contact_internal` and `app.retention_sweep` (SECURITY DEFINER, owner `app_retention`, pinned
  `search_path`, grants unchanged): 0037's statements verbatim plus the marked 0041 lines. New: the row locks (only
  the person's own records, by tenant), two UPDATEs of `lead_email_messages` by tenant (the person's held mail, their
  linked rows' domains), and one expiry UPDATE in the sweep. The self-check asserts owner, `prosecdef`, the pinned path
  and that the lock precedes the do-not-contact check.
- `app.contacts_stage_history` (SECURITY DEFINER trigger, owner `app_definer`, pinned path): 0021's insert plus one
  validated column. The GUC is caller-settable, so it is trusted only to ADD a restriction: a value that is not this
  user's running stage action of this tenant records NULL, which is what every stage change recorded before.
- `app.lead_email_messages_guard` (invoker trigger): refuses everything it refused; only `current_user =
  'app_retention'` (inside the two definers above) may end a held email as `erased`/`expired` or drop its sender/DKIM
  domains; `point_hmacs` may only be cleared, and a CHECK keeps keys on held rows only.
- `app.feed_mark_contacts_deleted` (invoker, EXECUTE revoked from PUBLIC; 0038's self-check scope: an invoker that
  names `public.feed_dirty`). Inside the purge it runs as `app_retention`, which already had INSERT on `feed_dirty`
  and SELECT on `feed_groups` and `memberships`.
- No table, policy or grant is added or widened; `lead_email_messages`, `contact_stage_events` and
  `stage_automation_decisions` keep FORCE RLS, their policies and the `support_read_only` statement trigger (the
  self-check asserts it).

**Residual and left for the owner.**
- A point committed while the erase route waited for its address locks has an address the route did not lock; the
  carry takes that lock after the row locks (out of the global order). A conflicting transaction in that window is a
  deadlock Postgres resolves by aborting one side, which is retried (`adminTx` retries twice, intake three times).
- A held email whose parse found no phone or email has no key: erasure cannot find it, only its 30-day retention
  purges it. A held email naming only a person's confirmed wrong number is kept (that number reaches someone else).
  Held rows received before 0041 carry no keys: only the expiry covers them.
  The 30-day period is **VERIFY WITH COUNSEL** (owner decision).
- Decided (`accepted`/`discarded`) rows keep their sender and DKIM domains unless linked to the erased person (an
  accepted row is; a discarded one is not linked to anyone).
- The erasure preview does not count the held emails that will go with the person; the web bulk sheet does not warn
  before a bulk stage of a protected list into a plan's stage (the server skips the plan and records why).
- An existing stack with one env file must move the four owner variables into `.env.owner` before upgrading
  (DEPLOY §1): the new API and worker refuse to start until it does, and name the variables.

## 8. Batch 5 interaction review: merged-away records (migration `merged_person_opt_outs`)

The review of the batch 5 fixes probed merges against owner rule D1 with the real server, Postgres and the fake
providers. Each fix only refuses more, and each is proved by a test that failed before it.

| finding | severity | fix | proof |
|---|---|---|---|
| A survivor's opt-outs recorded before a merge did not block sends addressed to the merged-away record: the survivor's person-level do-not-contact, or a STOP from a phone only the survivor had, reached neither canContact nor the dispatch guards for that record (they checked the recipient, the records merged INTO it and the recipient's own phones). The Owner, an Admin or a collaborator of the loser could text or call the person, and a direct enrollment's plan texts and an automatic saved-search alert went out (F1, pre-existing) | high | Both guards (`app.messages_dispatch_guard`, `app.calls_dispatch_guard`) and core canContact's inputs (`comms/repos/gate.ts`) judge a recipient by its whole person, `app.contact_person_ids`: the root survivor reached through `merged_into_contact_id` and every record merged into it, along chains. And nothing new is addressed to a merged-away record: a text, email, compose preview and call are 409 `CONTACT_MERGED` before anything is created (`details.mergedInto` only for a caller who sees the survivor; the contact view's `mergedIntoContactId` likewise names the end of the merge chain only to a caller who may open it, beside `merged: true`, batch 6 review R2), no assistant or system message is queued to one, its saved searches send no alert | `comms/guardEquivalence.test.ts` (the merged-away record and the survivor's copies of its addresses get the same verdict in both layers, directly and along a chain), `packages/db/test/fixtures/opt_out_cases.json` (the `merged-into` rows, run against the guards, canContact and bulk preflight), `comms/merged.recipient.test.ts` (every send path; a message that raced onto the record is blocked at dispatch) |
| A direct enrollment of a merged-away record was accepted (201): a second live plan for one person, stranded on the loser; the step runner kept it running and a closed deal of the loser enrolled it with no human involved (F2) | medium | `enrollContact` refuses it (409 `CONTACT_MERGED`, `details.reason = person_removed`, the stage entry's skip reason), the runner stops one live anyway (`stop_reason = merged`), the post-closing path skips it | `assistant/enroll.reach.test.ts` |

Security review items of the migration (CONVENTIONS §4):
- **New function `app.contact_person_ids(uuid, uuid) RETURNS uuid[]`**: plain SQL, not a definer, `STABLE`, pinned
  `search_path`, explicit tenant filter, schema-qualified tables, writes nothing; `CYCLE` clauses end both walks even
  on corrupt data. EXECUTE is revoked from PUBLIC and granted to `app_user`, for which it runs under the caller's RLS
  and returns only records the caller can select, and to `app_definer`, as which the guards run it (they already read
  every contact and point of the tenant). A caller who does not see every record of the person (a collaborator of the
  loser does not see the survivor) gets a smaller set from canContact, but never reaches the gate for a merged-away
  record (the API refuses it), and the guard, which sees every record, still refuses: the refusal is mapped to a
  blocked send (`gateInput.ts` `GUARD_DENY_REASONS`).
- **`app.messages_dispatch_guard()` and `app.calls_dispatch_guard()` replaced** (SECURITY DEFINER, owner
  `app_definer`, pinned `search_path`, bindings unchanged), verbatim from 0021 except the lines marked F1: the
  do-not-contact check and the phone fan-out read the recipient's whole person. A larger set of records only refuses
  more sends. For a record nobody merged anything into or away the person is the record itself, and for a survivor
  nothing changes (the merge copied the losers' points and carried their do-not-contact onto it).
- **Not changed, for the owner:** a merge still moves no saved search, deal or appointment. A merged-away record's
  saved search now stays `active` but never alerts; moving it to the survivor, or pausing it at the merge, is a product
  decision. The contact page's reachability summary for a merged-away record (seen only by tenant-wide roles and the
  loser's collaborators) still describes that record's own points, though every send from it is refused.

## 9. Batch 6 interaction review: web chat and opt-out honesty (migration `webchat_sessions_follow_merge`, lane number 0046)

Fixes of the batch 6 review (group "chat"; ARCHITECTURE §21.13). Each change only refuses, blocks or says more; no
opt-out check, guard, policy or grant is weakened (D1), and each is proved by a test that failed before the fix. One
earlier change of this group did offer more than the send allows (a chat handback's one-tap Send judged by the chat
instead of its text draft); the review of these fixes found it and it is corrected below (chat-R2).

- **New SECURITY DEFINER trigger `app.webchat_sessions_follow_merge()`** (owner `app_definer`, `search_path =
  pg_catalog, public`, EXECUTE revoked from PUBLIC; column grant `UPDATE (contact_id, contact_point_id)` on
  `webchat_sessions` to `app_definer`). It fires only on the ownership engine's merge (`merged_into_contact_id` from
  NULL to a contact), within that row's tenant, after 0027's point copy, and re-points only the merged-away record's
  chat sessions to the survivor's copy of the same chat identity. It writes no opt-out state; a person still cannot
  write a session (0018 `webchat_system`), and a staff user reads one only with the survivor's detail (0018
  `webchat_staff_read`), as they read the messages the merge moved. The migration's self-check and
  `packages/db/test/webchat_follow_merge.test.ts` assert the shape, the trigger order and the backfill.
- **canContact's web-chat fan-out reads the whole person** (`comms/repos/gate.ts chatFanoutHmacs`), the set the 0043
  guard reads, so a chat reply to a merged-away record is refused by the gate first, with its evidence
  (`comms/guardEquivalence.test.ts`, R-INBOX-3 case).
- **The person-level do-not-contact is said before every tap** (reachability summary, feed hint, compose, Details),
  web chat included; the points routes refuse the chat identity (404 `NOT_FOUND`) so it cannot be removed from under
  its chat. Read paths only; everything stays under the caller's RLS.
- **A handback's one-tap Send is judged by its draft's own channel** (review chat-R2): the assistant binds a
  handback's suggested reply to a text or email (sms even with no number), so the feed offers Send only when that
  channel is open (`HandbackFacts.replyDraftChannel`, read from `payload.draft.channel` as the approval reads it), and
  offers Reply in the chat beside it; the web disables a Send of a text or email to a lead with no number or address,
  with the reason. A chat the gate summary blocks is said on the card with its source (review chat-R3). Read paths
  only: the send-time gate and the guards are unchanged.
- **The summary's batched chat fan-out reads each person once** (review chat-R1, `comms/repos/reachability.ts
  chatFanoutSql`): a function scan per contact, then that person's points by `contact_id`, the same rows as the
  gate's per-contact read; `comms/chatFanout.perf.test.ts` asserts the plan shape and a time bound with 3,000 chat
  identities, so the honest-UI summary cannot time out into "unknown" (which disables nothing).

## 10. Batch 7 interaction review: merges, sends and listings (migration `b7_review_sends_merges`, lane number 0053)

Fixes of the batch 7 review (group "merges, sends and listings"; ARCHITECTURE §21.16). Each change only refuses, blocks,
counts less or says more; no opt-out check (D1, R-PAR-12), policy or tenant boundary is weakened, and the ownership
engine still makes every ownership change.
- **sends/F1.** An open-house invite is never a touch (D8, R-OWN-14): dispatch TX1 records no first touch for a
  `marketing_piece_id` row, so an invite cannot stop a first-contact breach or auto-release; the scoreboard definers,
  the rollup mark and the waiting-client check skip it, like a bulk send (R-PAR-37).
- **sends/F2.** An autonomous message is sent only while its action is `proposed` (TX1 and `messages_dispatch_guard`):
  an action a merge or an ownership change invalidated can no longer be sent because two unrelated period numbers
  happen to match. A merge also skips the loser's scheduled trigger firings.
- **ownership-data/F1.** Listing roles, deal roles and a deal's primary person follow a merge (new definer
  `app.contacts_merge_roles`, reviewed in ARCHITECTURE §21.16); no access widens: the same policies decide who reads them.
- **ownership-data/F2.** A listing whose agent left is held and reported to Owners/Admins; `PATCH /listings/:id/agent`
  (Owner/Admin, audited) hands it on. Member deactivation still does not move listings (left for a later change).
- **ownership-data/F5.** The weekly plan never suggests work on a person who asked not to be contacted through any of
  their records.
## 11. Photo and video texts (owner decision D5, lane `outbound-mms`, migration 0055)
Threat model:
- An agent's upload is untrusted bytes: a polyglot, HTML or SVG disguised as a photo, an oversized body, hidden location.
- The provider must fetch the media without our session.
- No other user or tenant may attach or fetch someone's media.
- Automation must never send media.
| Control | Where | Test |
|---|---|---|
| Upload: authenticated before the body is read; identity Content-Encoding only; body cap = the strict base64 of 5,000,000 bytes + 4 KiB (413); the declared type is checked against the magic bytes (checkMedia) and the outbound allowlist (JPEG, PNG, GIF, MP4/QuickTime brands); at most 20 live uploads and 60 uploads per hour per user; no file name kept | comms/outboundMedia.ts, @realty/core/texting | outboundMedia.upload.test.ts |
| Metadata removed before storage, with no decoder running on the server: metadata segments, chunks and extensions dropped wherever they appear, along with any bytes after the end marker; video metadata boxes blanked in place; a file that cannot be walked, or that still carries metadata or a location, is refused | stripMediaMetadata | texting tests |
| Per-object DEK (purpose `mms`); staged uploads visible only to their uploader and the system, and never updatable; shredded on removal, expiry (24 h) and erasure by `app.outbound_media_upload_shred` (definer, app_retention), which touches only the deleted row's own unattached `mms` object of its uploader | 0055 | outbound_mms.test.ts |
| Only the sender attaches, while the message is queued or scheduled, their own uploads for the same person, ≤ 10 items, ≤ 5 MB with the text; each upload attached once (claimed by DELETE … RETURNING); an outbound `mms` exists only as a one-to-one human text | 0055 CHECK + `app.message_media_outbound_guard`; compose.ts | outbound_mms.test.ts |
| Provider fetch, GET /api/mms/media?token= (a safe method, so not a `capabilityUrl` route): MAC (link secret, purpose `mms-media`) over tenant, message, position and expiry (dispatch + 36,000 s + 20 min); served only for an outbound mms in dispatching, dispatch_unknown or sent; byte-exact, nosniff, attachment, no-store, sandbox CSP; one 404 for every refusal (same status, code and headers; the body differs only in its request id); no Zod query schema (no 422); the global per-IP limiter is off (the provider's shared addresses), and 12 fetches per item per hour, counted after the MAC, is the budget; the token rides in the query string, which the API never logs (route pattern only), nginx's access log never writes (`$log_uri` from `$uri`) and nginx's error log never sees (`error_log /dev/null`); the residual is the TLS terminator and Twilio's own logs (§3), and is in no job, audit row or response | comms/outboundMedia.ts | outboundMedia.fetch.test.ts |
| Provider copies deleted 24 h after dispatch; for a submit whose outcome stayed unknown, by sending number and time, with a P2 alert when none is found | comms.mms_provider_cleanup | outboundMedia.cleanup.test.ts |
## 12. Texting reactions (lane sms-reactions, D5b, migration 0056)
- Recognition: an anchored parse of the whole body, with no text allowed before or after. The quote must equal a stored non-imported outbound text sent from the same number to the same phone on a record of the same person (`app.contact_person_ids`: the root survivor and every record merged into it, so the team's text still counts while a Team Lead's merge has not yet moved it; migration `b8_review_texting`) within 30 days, and the DB guard `app.message_reactions_guard` re-checks the same bounds. Anything else is classified exactly as before, so an opt-out the person writes always counts (R-REACT-1…3, R-REACT-5).
- Assistant: a linked reaction reaches a prompt only as `client (sms reaction to the team's text [Sn])`, with its own words as untrusted data. Its evidence source holds only those words, and draft categories ignore the quote, so a model cannot cite the team's words as the client's (R-REACT-7).
- Review trail: each narrowed reading is audited `consent.reaction_quote_not_read` (reason: the reading it replaced), and each refused link is audited `consent.reaction_link_refused`. The notification and the thread say so, and the thread offers the person-level do-not-contact. All of this is kept for counsel review (VERIFY WITH COUNSEL).

## 13. Batch 8 interaction review: deal recipients, home values and merges (migration `b8_review_deals`, lane number 0059)

Trust decisions that changed (details in ARCHITECTURE §21.25):
- **The other side of a deal is not the team's client.** Milestone updates and home-value notes go only to the client roles of the side `deals.side` says the team represents (lease: none). Checked when planned and again, live, when the message is built. An approved playbook step cannot widen this.
- **Home values only for a home the client bought through the team**, never a house they sold through the team, re-checked under the contact lock and at send time; at most one a month per person and house across a merge.
- **`home_valuations` is written only by the system** (RESTRICTIVE insert and update policies). Members who see the contact still read it; a valuation row drives automatic client notes under the source's name, so a person can no longer change a value, a provider or `display_allowed`.
- **A merge keeps the stronger deal role** (definer `app.contacts_merge_roles`, replaced from 0053 with every earlier rule kept) and a planned milestone update follows the person once; nothing already sent to a merged record is sent again. D1 opt-outs are unchanged: every re-planned update still goes through `comms/dispatch.ts`, which judges the whole person.
- **Gap:** no retention purge for `home_valuations` yet (R-DATA-6).
