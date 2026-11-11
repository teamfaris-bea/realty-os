# Realty OS: Deploying to production

This guide runs Realty OS for real teams: real vendor adapters, a portable container build and the operational procedures around it. It does not choose a hosting vendor. Anything that can run two containers and reach a Postgres 16 database will do.

Development, tests and the Codespaces demo keep using the deterministic fakes. Nothing in this guide changes `pnpm dev:*`, `pnpm seed` or `.devcontainer`.

Items marked **VERIFY** depend on a vendor's current console, pricing or policy, or on a lawyer. Check them against your own accounts before launch. They are not settled here.

---

## 1. What runs

| Process | Command (in the `api` image) | Scales | Notes |
|---|---|---|---|
| API | `node apps/api/dist/main.js` | horizontally | stateless; all state is in Postgres and object storage |
| Worker | `node apps/api/dist/worker/main.js` | horizontally | claims use `SKIP LOCKED`; flags `--queues`, `--concurrency`, `--no-sweeper`, `--no-maintenance` |
| Release | `node packages/db/dist/scripts/release.js` | once per deploy | migrations as the owner role; see §3 |
| Web | `web` image (nginx) | horizontally | static SPA; proxies `/api` to the API on the same origin |

Build both images from the repository root:

```sh
docker build --target api -t realty-api:<version> .
docker build --target web -t realty-web:<version> .
```

`docker-compose.prod.yml` is a complete example stack: Postgres, then release, then API and worker, then web. It takes **two** env files (§3): copy `deploy/env.production.example` to `.env.production` (the app's environment, which the api, worker and release containers read) and `deploy/env.owner.example` to `.env.owner` (the database owner's user, password and URL, which only the postgres service and the release step receive, by interpolation), and fill both in. Then `docker compose -f docker-compose.prod.yml --env-file .env.owner up -d --build`; the `--env-file .env.owner` flag is needed on **every** compose command, because the compose file itself reads the owner's credentials from it (and `WEB_PORT` from the shell). Never put an owner credential in `.env.production`: the API and the worker refuse to start in production with one in their environment (§2). A stack that still keeps one env file (before batch 5) moves `POSTGRES_OWNER_USER`, `POSTGRES_OWNER_PASSWORD`, `POSTGRES_DB` and `MIGRATION_DATABASE_URL` from `.env.production` into `.env.owner` and switches its `--env-file` to `.env.owner`; until then the new API and worker refuse to start and name the variables to move. For real teams, use a managed Postgres with backups and TLS instead of the compose database, and put a TLS-terminating load balancer in front of `web`. A fake-provider staging stack starts from `deploy/env.staging.example` instead (`docs/STAGING.md`).

- **Storage volume.** With `STORAGE_PROVIDER=local`, set `STORAGE_DIR=/var/lib/realty/storage`: the compose file mounts the named volume `storage` there on the API and the worker, and the `api` image creates that directory owned by `node`. Any other path is not writable in the image, and `/api/ready` then reports `degraded` with `storage: failed`.
- **Re-resolving the API.** nginx resolves `API_UPSTREAM` through `NGINX_RESOLVER` (default `127.0.0.11`, Docker's DNS) at most every 10 s, so a recreated `api` container is found again. If you run the `web` image outside Docker networking, set `NGINX_RESOLVER` to a resolver that knows the API's name.
- **No source maps** are shipped in the `web` image (the build stage still has them).

**Same origin.** The session cookie is first-party (`__Host-sid`, Secure, SameSite). Serve the web app and `/api` from one origin, which the `web` image does. Set `PUBLIC_BASE_URL` and `WEB_ORIGIN` to that origin (for example `https://app.example.com`) and set `TRUST_PROXY=true` behind the load balancer.

## 2. Health, shutdown and logs

| Endpoint | Meaning | Use it for |
|---|---|---|
| `GET /api/health` | the process answers (no database) | liveness / restart |
| `GET /api/ready` | the database answers **as an RLS-bound role** and the process is not draining (503 otherwise); storage writable and provider configuration loadable (200 `degraded` otherwise, see `docs/OPERATIONS.md` §4.2) | readiness / load-balancer target health |
| worker `GET :$WORKER_HEALTH_PORT/health` | the worker loops run; 503 once stopping | container health check (optional) |

The bodies say only `ok`, `ready`, `degraded`, `draining` or `unavailable`, plus `checks` (`database`, `storage`, `providers`: `ok` or `failed`) on readiness. They carry no versions, ids or errors, and the endpoints are exempt from the rate limit. Metrics (`METRICS_PORT`, its own port and a bearer token), error reporting, alerts, runbooks and the synthetic check are in `docs/OPERATIONS.md`.

**Graceful stop.** On SIGTERM or SIGINT:

- **API:**
  1. `/api/ready` turns 503 at once.
  2. The server keeps serving for `SHUTDOWN_DRAIN_MS` (default 5 s), long enough for the load balancer to notice.
  3. It stops accepting connections and lets in-flight requests finish.
  4. It closes the pool and exits 0.
- **Worker:** stops claiming new jobs, lets in-flight jobs finish (each job is one transaction, so an interrupted one is retried by lease expiry), then exits 0.
- **Hard deadline:** `SHUTDOWN_TIMEOUT_MS` (default 30 s) for either process. A stop that takes longer exits 1.

Give the orchestrator a stop grace period of at least `SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS`. The compose file uses 40 s.

**Start-up refusals.** The API **and the worker** refuse to start, exit 1, and print one JSON line on stderr (`{"level":"fatal","msg":"api failed to start" | "worker failed to start","type":…,"detail":…}`) naming the problem by key, never by value, when:

- the configuration is incomplete or unsafe (§4). Rehearsed refusals: `KEK_BASE64` missing, not base64 or not 32 bytes; `KEK_REF` missing; fake providers without `ALLOW_FAKE_PROVIDERS=true`; a non-https `PUBLIC_BASE_URL` or `WEB_ORIGIN` entry; `SESSION_COOKIE_SECURE=false`; the KEK equal to the session secret; with `MLS_PROVIDER=spark`, a Spark base URL that is http, has a path, a port or credentials, or a host missing from `SPARK_ALLOWED_HOSTS`, and a wildcard or internal name in that list; an unknown `MLS_PROVIDER` or `MLS_LIVE_CALLS` value;
- `DATABASE_URL` logs in as a superuser or a `BYPASSRLS` role;
- with `NODE_ENV=production`, a database owner credential is in the process environment at all: `MIGRATION_DATABASE_URL`, `POSTGRES_OWNER_PASSWORD` or `POSTGRES_PASSWORD` (checked first, before anything else is read; the line names the variables, never their values). The batch 5 review found the compose file giving the internet-facing api and worker the owner's superuser URL and password; an environment leak or code execution there would have been a superuser login (every guard, the append-only and audit tables, `COPY … TO PROGRAM` on the database host).

A `KEK_BASE64` or `SESSION_SECRET_BASE64` problem is reported on its own, before the rest of the list: fix it and start again to see the other problems.

**Logs** are JSON lines on stdout and stderr, for any collector. They follow the ARCHITECTURE §15 rules:

- ids, codes and timings only;
- PII keys dropped, and phone numbers and emails masked in strings;
- requests logged by route pattern, never by raw URL;
- no bodies, prompts, transcripts or credentials;
- vendor error messages are never surfaced, only their codes.

The nginx access log omits query strings, because reset, invite and unsubscribe tokens travel there.

**Security headers.** The `web` image's nginx sends the web app's security headers (`webSecurityHeaders` in `apps/web/security-headers.ts`: the strict CSP with `frame-ancestors 'none'`, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP, X-Frame-Options) on every page, asset and SPA-fallback response, from the generated snippet `deploy/security-headers.conf`. `/api/` responses carry only the API's own headers. After changing the policy, run `node deploy/render-security-headers.mjs` and commit the snippet; `pnpm --filter @realty/web test` fails while it is stale or while any nginx location drifts from the policy (SECURITY §2.1). Add HSTS at the TLS-terminating edge.

## 3. Database and the release step

Two **different** roles:

- **Owner** (`MIGRATION_DATABASE_URL`): creates roles, owns objects and runs migrations. The application never uses it, and the API and the worker never **hold** it: it reaches the release step only (with the compose stack, from `.env.owner`, which the postgres and release services alone receive), and one-off owner commands take it explicitly (§9, STAGING §5-§6). Under `NODE_ENV=production` the API and the worker refuse to start when it, `POSTGRES_OWNER_PASSWORD` or `POSTGRES_PASSWORD` is in their environment (§2).
- **App** (`DATABASE_URL`): it **must** log in as `app_user`, because the migrations grant to that role by name. The release step refuses any other name before it changes anything. `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`, member of no role. Every API and worker connection uses it. Roles are cluster-wide: two environments that share one Postgres cluster share one `app_user` and its password.

**Database host (owner decision, 2026-11-11).** Accept and claim taps miss their 300 ms p95 budget on 4 shared cores (docs/PERFORMANCE.md: accept 637 ms, 44 simultaneous claims 382 ms). So production runs Postgres on its **own** host (or managed instance) with at least 4 dedicated cores, never on the same machine as the API and worker. A staging VM may share one host (docs/STAGING.md); its timings then say nothing about production.

Every deploy runs the release step once, **before** the new API and worker start:

1. It creates or aligns the app role (its password comes from `DATABASE_URL`).
2. It applies pending migrations. Each runs in one transaction and is checksummed. An edited, renamed or missing applied migration aborts the release.
3. It proves the app role is RLS-bound: not superuser, no BYPASSRLS, and zero tenants visible without context.

It exits non-zero on any failure. Do not start the new version then. It prints `migrations: <n> applied, <m> already applied` and finally `release ok: app connects as app_user, RLS-bound`. Run again with nothing pending, it prints `0 applied` and `release ok`.

The runner refuses, and the release step exits 1 on, each of these (rehearsed, exact messages):

- an edited applied file: `applied migration <name> was edited (checksum mismatch)…`;
- a missing or renamed applied file: `applied migration <name> is missing from <dir>` / `…was renamed to <name>`;
- a pending file numbered below the last applied one: `pending migration <name> sorts before already-applied <n>; renumber it to the next free number`;
- a duplicate number or a badly named file.

A migration that fails leaves nothing behind: the file and its bookkeeping row are one transaction. (Numbers need not be contiguous: there is no `0015`.)

**Rollback.** Migrations are forward-only: there are no down migrations, and nobody edits `realty_migrations.schema_migrations` by hand.

1. **Take a restore point before every release step** (a PITR mark or a snapshot, §8).
2. **Bad deploy, no migration applied** (its release log says `0 applied`): redeploy the previous image, without its release step.
3. **Bad deploy that applied migrations:** the previous image may run against the newer schema only if every migration it does not know is additive, and only after it passes `/api/ready`, a sign-in and a smoke check against that schema. Rehearsed once (`a0fa34b` against the `0036` schema: ready, sign-in, MFA, search, contact and feed all worked), which proves that pair only. Function replacements (for example `0035`) mean the old code runs the new function bodies.
4. **Otherwise** (a migration changed or destroyed data, or the previous image misbehaves): restore the restore point into a **new** instance (§8), point the previous image at it, and accept that writes after that point are lost.
5. **To fix a bad migration**, add the next-numbered migration. Never edit an applied one.

**Managed Postgres (VERIFY).** Migration `0001` creates the `NOLOGIN BYPASSRLS` owner roles `app_definer` and `app_retention`, and `SECURITY DEFINER` functions owned by them. Some managed services do not give the owner full superuser. Before choosing a provider, check that its admin role can create roles with `BYPASSRLS` and transfer function ownership.

**Migration for real providers.** `0017_production_readiness.sql` adds one `SECURITY DEFINER` read, `app.resolve_telephony_account`, which maps a Twilio subaccount SID to its tenant for webhook signature checks. It returns the tenant id only, for active credentials of active tenants. It is a security-review item.

## 4. Environment variable reference

With `NODE_ENV=production` the configuration fails fast:

- it reports **every** missing or invalid setting at once, by name and never by value;
- it refuses fake providers, plain-http URLs, plaintext SMTP and dev-derived webhook secrets;
- `ALLOW_FAKE_PROVIDERS=true` lifts the "no fakes" rule for a staging demo only.

Choosing a real vendor without its credentials fails in every environment. The full list with comments is in `.env.example`.

**Core**

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `DATABASE_URL` | yes | app role (RLS-bound) |
| `MIGRATION_DATABASE_URL` | release step only (`.env.owner` with the compose stack) | owner role; never in the api or worker environment (refused in production, §2) |
| `PUBLIC_BASE_URL` | yes, https | the public origin. Webhook signatures are computed over it, and it builds links and the reply domain `in.<host>`. |
| `WEB_ORIGIN` | yes, https | CSRF/CORS allowlist (comma-separated) |
| `TRUST_PROXY` | behind a proxy | trust `X-Forwarded-*` from the load balancer |
| `SESSION_COOKIE_SECURE` | default true in prod | must be true |
| `KEK_BASE64` / `KEK_REF` | yes (both; production refuses a missing `KEK_REF`) | 32-byte master key-encryption key and its name, stamped on every key it wraps (§9) |
| `SESSION_SECRET_BASE64` | yes | 32-byte server secret (CSRF, signed links, routing refs) |
| `LEAD_WEBHOOK_SECRET` | yes | signs the lead intake webhook |
| `ALLOW_FAKE_PROVIDERS` | no | `true` lets production run the fakes: a staging demo only (docs/STAGING.md), never for real teams |
| `STORAGE_DIR` | with `STORAGE_PROVIDER=local` | an absolute path on a persistent, backed-up volume (`/var/lib/realty/storage` in the images, §1) |
| `API_HOST` / `API_PORT` | no | the image defaults to `0.0.0.0:3001` |
| `LOG_LEVEL` | no | `info` |
| `DB_POOL_MAX` | no | connections in each API process's pool (default 10). Keep the sum over all API instances at about 2–3 per database vCPU, plus the workers' `--concurrency + 4` each, under `max_connections`. More connections than the database has cores only moves the queue into Postgres (docs/PERFORMANCE.md, accept/claim pool study). |

> **Owner decision (2026-11-11), production sizing:** if accept and claim cannot meet their 300 ms p95 budget with the database and the API sharing 4 cores (docs/PERFORMANCE.md), production runs the database on its own host with at least 4 cores, separate from the API instances, keeping `DB_POOL_MAX=10` per API instance.

| `SHUTDOWN_DRAIN_MS` / `SHUTDOWN_TIMEOUT_MS` | no | 5000 / 30000 |
| `WORKER_HEALTH_PORT` | no | worker liveness port |

**AI and push**

| Variable | Required | Meaning |
|---|---|---|
| `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL` | yes | real assistant. A tenant can still switch AI off (`ai_enabled`). |
| `PUSH_PROVIDER=webpush`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | yes | lead offers and alerts to agents' devices |

**Telephony** (`TELEPHONY_PROVIDER=twilio`)

| Variable | Required | Meaning |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | yes | the platform's **master** account. Each tenant gets its own subaccount automatically when it buys its first number. |
| `TWILIO_PLATFORM_SENDER` | yes in prod | the master-account sender of account-security codes (alert-phone verification): E.164 or a Messaging Service SID `MG…` |
| `TWILIO_NUMBER_COUNTRY` | no | `US` |
| `TELEPHONY_WEBHOOK_SECRET` | in production with the fake (staging) | only signs the fake's callbacks. With Twilio, each subaccount's own auth token verifies its webhooks. |

**Email** (`EMAIL_PROVIDER=smtp`)

| Variable | Required | Meaning |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | yes | `starttls` (587, default) or `tls` (465). `none` is refused in production. |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | yes in prod | relay credentials |
| `SMTP_VENDOR` | no | `generic`, `postmark`, `sendgrid`, `ses` or `mailgun`. It adds the vendor's metadata header so bounce and complaint events echo our signed reference. |
| `SMTP_POSTMARK_MESSAGE_STREAM`, `SMTP_SES_CONFIGURATION_SET` | no | vendor routing |
| `EMAIL_DKIM_SELECTORS`, `EMAIL_SPF_INCLUDE` | no | used by the sending-domain check (§6) |
| `ACCOUNT_EMAIL_FROM`, `ACCOUNT_EMAIL_FROM_NAME` | yes | sender of password-reset and invite emails |
| `EMAIL_INBOUND_FORMATS` | no | any of `postmark`, `sendgrid`, `ses`, `mailgun` (comma-separated). Empty means only the generic signed format. `ses` and `mailgun` add event routes only (§6). |
| `LEAD_EMAIL_INBOUND_DOMAIN` | no | the domain lead emails are received for (addresses `leads+<key>@<domain>`; §6.1). Empty in production: lead email cannot be turned on. Dev/test default `leads.realty-os.invalid` (reserved, never delivered). |
| `LEAD_EMAIL_AUTHSERV_ID` | no | Postmark only: the provider's own Authentication-Results authserv-id (**VERIFY**). Empty: no Postmark DKIM verdict is believed, so every Postmark lead email waits in Needs review. |
| `SES_SNS_TOPIC_ARNS` | with `ses` | the SNS topic ARNs whose notifications are accepted (comma-separated) |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | with `mailgun` | Mailgun's webhook signing key (HMAC-SHA256 over timestamp + token) |
| `EMAIL_WEBHOOK_BASIC_USER`, `EMAIL_WEBHOOK_BASIC_PASSWORD` | with `postmark` or `sendgrid` | HTTP Basic credentials in the vendor webhook URLs (password ≥ 16 characters) |
| `SENDGRID_EVENT_PUBLIC_KEY` | with `sendgrid` | Event Webhook verification key |
| `EMAIL_WEBHOOK_SECRET` | when no vendor format (also with the fake, in production) | the generic `X-Realty-Signature` format |

**Storage** (`STORAGE_PROVIDER=s3`, or `local` with an absolute `STORAGE_DIR` on a persistent, backed-up volume)

| Variable | Required | Meaning |
|---|---|---|
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | bucket and credentials (`S3_SESSION_TOKEN` for temporary credentials) |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | R2 / MinIO | for example `https://<account>.r2.cloudflarestorage.com` with path style on |
| `S3_PREFIX` | no | key prefix inside the bucket |
| `S3_SSE`, `S3_KMS_KEY_ID` | no | `none` (default), `AES256` or `aws:kms`. Objects are already envelope-encrypted by the app (per-object DEK), so SSE is defence in depth. |

**Follow Up Boss import** (`FUB_PROVIDER=real` for API-key imports; **VERIFY** the adapter against a live account first)

| Variable | Required | Meaning |
|---|---|---|
| `FUB_BASE_URL` | no | default `https://api.followupboss.com/v1`. Must be https on the default port, with no credentials, query or fragment, and its host must be in `FUB_ALLOWED_HOSTS`. |
| `FUB_ALLOWED_HOSTS` | no | comma-separated lowercase host names (no scheme, port, path or wildcard); default `api.followupboss.com`. The API and worker refuse to start when either FUB setting is invalid, naming the key (SECURITY §2.9). |
| `FUB_SYSTEM_NAME`, `FUB_SYSTEM_KEY` | if FUB requires them | registered-system headers (`X-System` / `X-System-Key`); both or neither |
| `FUB_TASKS_PATH`, `FUB_APPOINTMENTS_PATH` | no | the endpoints FUB tasks and appointments are **counted** at (one-record count pages; they are never read or imported, owner decision B7); default `tasks` and `appointments` (**VERIFY** against a live account). One plain path segment each (letters, digits, `-`, `_`), below `FUB_BASE_URL`; anything else is refused at start-up. |

**Spark MLS (read-only)** (`MLS_PROVIDER=spark`; full procedure in §11). None of these holds the access token: the token is entered in the app and stored encrypted (§11).

| Variable | Required | Meaning |
|---|---|---|
| `MLS_PROVIDER` | no | `fake` (default) or `spark` |
| `SPARK_API_BASE_URL` | no | default `https://sparkapi.com`. Must be https on the default port, with no credentials, path, query or fragment, and its host must be in `SPARK_ALLOWED_HOSTS`. |
| `SPARK_ALLOWED_HOSTS` | no | comma-separated lowercase public host names (no scheme, port, path or wildcard); default `sparkapi.com` |
| `SPARK_AUTH_SCHEME` | no | `Bearer` (default) or `OAuth`: the default scheme in the `Authorization` header (**VERIFY**, §11) |
| `MLS_LIVE_CALLS` | no | `false` (default in every environment) or `true`. The kill switch: while `false`, the Spark adapter makes no network call at all. |

## 5. Telephony: Twilio

**Accounts.** You hold one master account. The app creates a subaccount per tenant (its auth token is stored field-encrypted under the tenant key), which keeps each team's numbers, logs and opt-out lists separate. Numbers bought through the app get their webhooks configured automatically: SMS `…/api/webhooks/telephony/sms`, voice and status `…/api/webhooks/telephony/voice`.

**Webhook signatures.** Twilio signs every request with `X-Twilio-Signature`: HMAC-SHA1 over the full URL plus the sorted form parameters, keyed by the auth token of the account that owns the resource. The guard reads `AccountSid`, finds the tenant through `app.resolve_telephony_account`, decrypts that subaccount's token as the system actor and verifies the request. It does all of this before any tenant row is written. It also handles the master account.

- **Cross-tenant check:** a number that belongs to another tenant than the signing subaccount is treated as unrouted.
- **Replay protection:** Twilio signs no timestamp, so this rests on idempotency. Every delivery is recorded once per event id, and a replayed request is a no-op.
- **URL must match:** `PUBLIC_BASE_URL` must be exactly the scheme and host Twilio calls, or signatures will not match.

The scheme is tested against Twilio's published example.

**Click-to-call.**

1. The app rings the **agent's** verified phone first.
2. When the agent answers, Twilio dials the client from the team number.
3. When the client answers, Twilio fetches a signed answer URL. That URL plays the recording announcement and records that it played.
4. A recording is requested only when no announcement is owed, or when the answer URL is there to make it.
5. A recording of a call whose announcement did not play is refused and deleted at Twilio (E47).
6. Stored recordings are copied into encrypted storage, then deleted at Twilio.

**VERIFY on a live test call:**

- that the recording begins after the announcement in your account's configuration;
- the announcement wording per state (counsel).

**A2P 10DLC registration** (US long codes). **VERIFY** the current Twilio console flow, fees and vetting times before launch:

1. **Master account:** upgrade it, then create your primary Customer Profile in Trust Hub (ISV model: you send on behalf of each team).
2. **Per team (tenant):** in that team's subaccount, create a secondary Customer Profile and register the team's Brand. A Standard brand needs an EIN; Sole Proprietor brands have tight limits.
3. **Campaign:**
   1. Create a Messaging Service in the subaccount.
   2. Register an A2P Campaign on it. Give the use case (for example customer care / mixed), 2–5 sample messages, the opt-in description (how leads consented through the source) and opt-out/help language.
   3. Add the team's numbers to the Messaging Service.
4. **Tell the app:** create the sender registration with `providerCampaignRef` = `MG…/QE…` (Messaging Service SID / campaign SID), using `POST /api/sender-registrations`. The web form does not have this field yet. Then attach it to the numbers. **Refresh** pulls the status: `VERIFIED` → approved, `FAILED` → rejected, `SUSPENDED` → suspended (every send from those numbers is blocked, E46).
5. **Toll-free:** submit a Toll-Free Verification instead and use its `HH…` SID as the reference.

Unregistered or unapproved senders are blocked by the send gate (R-CONSENT-17).

**Inbound calls.** A number bought through the app sends its calls to `…/api/webhooks/telephony/voice` (`comms/voice.ts`):

1. The call rings the contact's owner on their verified phone, with the **team number as caller ID**. For an unknown caller, an unowned contact or an owner without a verified phone, it rings the team's on-duty target: the next member of the first enabled catch-all routing rule who is active, accepting leads and has a verified phone. The rotation cursor is only read, never advanced.
2. When the recording policy announces, the caller hears the announcement first, and the agent hears it in the whisper. The agent must **press 1** to take the call, so the agent's own phone voicemail never takes a client call.
3. Nobody accepts within the ring timeout (Owner/Admin: **Phone and email → Incoming calls**, 5–60 s, default 20)? The call is a missed call (feed item and notification for whoever handles the contact). The caller hears the team's greeting, a fixed recording notice and a beep. The voicemail is copied into encrypted storage, deleted at Twilio, transcribed, and shown in the conversation (play and transcript are audited).
4. A blocked caller ID hears a short reason and the call ends: there is no number to attach a contact to.

**VERIFY on a live call:** that an agent's carrier voicemail answering the agent leg is never reported as an accept, that a Dial recording's callback carries the parent call SID, and the voicemail notice wording per state (**VERIFY WITH COUNSEL**).

**MMS.** Inbound media are fetched by SID with the subaccount credentials (the media URL in the webhook is never fetched). Kept: at most 10 items of at most 5 MB, of allowed types (JPEG, PNG, GIF, WebP, HEIC/HEIF, MP4, 3GPP, QuickTime, AMR, MP3, M4A, PDF, vCard) whose bytes match the type. Each item is encrypted with its own DEK and deleted at Twilio. Anything else is not stored; the conversation says which attachment was not saved, and why.

**Opt-outs.** Twilio's own STOP handling stays on. A send to a recipient who texted STOP fails at Twilio with error 21610, which the app records as a provider opt-out (R-CONSENT-12), on top of its own keyword handling (D1).

## 6. Email: SMTP, DNS and inbound

**Sending.** Any SMTP relay works, over STARTTLS (587) or implicit TLS (465), with AUTH PLAIN or LOGIN.

- **Headers:** every message carries a deterministic `Message-ID` and our signed `X-Realty-Ref`. Marketing mail also carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
- **Header injection:** CR/LF in any header, address or name is refused before connecting.
- **Lost submits:** a lost response after `DATA` is treated as outcome unknown. The message is never re-sent blindly, and it fails after the reconcile window unless a delivery or bounce event arrives first.

**One-click unsubscribe works end to end:**

1. Mailbox providers POST `List-Unsubscribe=One-Click` to `/api/email/unsubscribe/<token>` without an Origin or cookie. That route is exempt from the Origin allowlist: the token is a MAC-signed capability that can only stop email.
2. The address's marketing email is revoked at once, and the next marketing send is denied.
3. Have your provider **DKIM-sign** the `List-Unsubscribe` and `List-Unsubscribe-Post` headers (most do by default; **VERIFY**).

**DNS for each sending domain** (the platform's and each team's verified domain). Your vendor gives the exact values; the patterns are:

| Record | Name | Value (example) | Why |
|---|---|---|---|
| SPF (TXT) | the envelope / Return-Path domain | `v=spf1 include:<vendor include> ~all` (only one SPF record per name) | the relay may send for you |
| DKIM (TXT or CNAME) | `<selector>._domainkey.<domain>` | from the vendor (2048-bit) | signs the message, including the List-Unsubscribe headers |
| DMARC (TXT) | `_dmarc.<domain>` | start `v=DMARC1; p=none; rua=mailto:dmarc@<domain>`, then move to `p=quarantine` and later `p=reject` once reports are clean | alignment; Gmail and Yahoo bulk-sender rules require it |
| Return-Path (CNAME) | for example `pm-bounces.<domain>` (Postmark) or the SES MAIL FROM domain | from the vendor | SPF alignment |

The app's sending-domain check (`POST /api/sending-domains/:id/verify`) looks up SPF at the domain, DKIM at the selectors in `EMAIL_DKIM_SELECTORS`, and DMARC. Marketing email needs a verified domain and the brokerage postal address. Advertising rules and CAN-SPAM wording are **VERIFY WITH COUNSEL**.

**Inbound replies.**

- **Reply-To:** outbound mail sets Reply-To to `r+<token>@in.<host of PUBLIC_BASE_URL>`.
- **MX record:** point an MX for `in.<host>` at your vendor's inbound service.
- **Basic auth in every vendor URL:** put the credentials in the URL, for example `https://<user>:<password>@app.example.com/api/webhooks/email/postmark/inbound`.

| Vendor | Inbound | Events (bounce, complaint, unsubscribe, delivery, open, click) |
|---|---|---|
| Postmark | Inbound stream: inbound domain `in.<host>` (MX `inbound.postmarkapp.com`, **VERIFY**). Webhook `…/api/webhooks/email/postmark/inbound` | message-stream webhooks for Delivery, Bounce, Spam Complaint, Subscription Change, Open, Click, all to `…/api/webhooks/email/postmark/events` (Basic auth). Set `SMTP_VENDOR=postmark`. |
| SendGrid | Inbound Parse: host `in.<host>`, MX `mx.sendgrid.net`. URL `…/api/webhooks/email/sendgrid/inbound` (Basic auth). Leave "POST the raw, full MIME message" **off**. | Event Webhook `…/api/webhooks/email/sendgrid/events` with **Signed Event Webhook** on; copy its public key into `SENDGRID_EVENT_PUBLIC_KEY`. The ECDSA signature and timestamp are checked within ±5 minutes. Set `SMTP_VENDOR=sendgrid`. |
| Amazon SES | not parsed: use the generic format through a bridge (or another vendor's inbound) | SNS topic subscription `…/api/webhooks/email/ses/events` (SNS signature, no Basic auth). Set `SMTP_VENDOR=ses`, `SMTP_SES_CONFIGURATION_SET`, add `ses` to `EMAIL_INBOUND_FORMATS` and list the topic in `SES_SNS_TOPIC_ARNS`. Setup below. |
| Mailgun | not parsed: use the generic format through a bridge | Webhooks `…/api/webhooks/email/mailgun/events` (HMAC signature, no Basic auth). Set `SMTP_VENDOR=mailgun`, add `mailgun` to `EMAIL_INBOUND_FORMATS`, and copy the webhook signing key into `MAILGUN_WEBHOOK_SIGNING_KEY`. Setup below. |
| others | the generic signed JSON format (`/api/webhooks/email/inbound`, `X-Realty-Signature`) through a small bridge | `/api/webhooks/email/events`, same format |

Event effects:

- A hard bounce is a `hard_bounce` suppression, and the address is marked bouncing.
- A complaint is a `spam_complaint` suppression, which can never be lifted.
- A provider unsubscribe is the person's opt-out: a marketing-email revoke.
- Soft bounces and unknown events change nothing.
- Opens and clicks are behaviour **signals**, never facts.

**Amazon SES events (through Amazon SNS).** The vendor console steps are **VERIFY** against your AWS account.

1. **SNS topic.** In SNS, create a Standard topic in the SES region, for example `realty-ses-events`. Put its ARN in `SES_SNS_TOPIC_ARNS` (comma-separated if you have several) and add `ses` to `EMAIL_INBOUND_FORMATS`. Deploy this first: the endpoint only accepts topics on that list.
2. **Configuration set.** In SES, create the configuration set named in `SMTP_SES_CONFIGURATION_SET`. Add an event destination of type SNS that points at the topic, with the event types Bounces, Complaints, Deliveries, Rejects, Rendering failures, and optionally Opens, Clicks and Subscriptions. Every send carries `X-SES-CONFIGURATION-SET`, and our ref goes in the `realty_ref` message tag.
3. **Original headers.** If a ref can contain characters that SES tags do not allow, it travels only in `X-Realty-Ref`. Turn on "include original headers" for the destination (**VERIFY** where the console shows it) so that SES events still carry the ref.
4. **HTTPS subscription.** On the topic, create a subscription with protocol HTTPS and endpoint `https://app.example.com/api/webhooks/email/ses/events`. Leave raw message delivery **off**: the app needs the SNS envelope to check the signature. SNS posts a SubscriptionConfirmation; the app checks its signature and topic, then confirms it by GET to the `SubscribeURL`, but only when that URL is https on `sns.<region>.amazonaws.com`. The subscription should then show as Confirmed. If it does not, check the API log for `SNS_SUBSCRIPTION_CONFIRMED`, then use "Request confirmation" in the console.
5. **Security.** Each message must carry a valid SNS signature (SignatureVersion 1 or 2). The signing certificate is fetched only from `https://sns.<region>.amazonaws.com(.cn)/….pem` and cached in memory. The `TopicArn` must be listed, because AWS signs the messages of anyone's topic. The SNS `Timestamp` may be at most **1 hour** old: SNS keeps the original timestamp when it retries, and retries can run for up to an hour. A replay inside that hour is a duplicate of the same SNS `MessageId`, so nothing happens twice. The API needs outbound HTTPS to `sns.<region>.amazonaws.com`.
6. **Mapping.** A Permanent bounce is a hard bounce. Transient and Undetermined bounces are ignored. A complaint is a complaint. A Subscription event is an unsubscribe only when SES reports an opt-out (unsubscribe from all, or a topic set to OptOut). Reject and Rendering Failure mark the message failed. Send, DeliveryDelay and anything unknown are ignored.

**Mailgun events.** The vendor console steps are **VERIFY** against your Mailgun account.

1. Under Sending → Webhooks for the sending domain, copy the **HTTP webhook signing key** into `MAILGUN_WEBHOOK_SIGNING_KEY`, add `mailgun` to `EMAIL_INBOUND_FORMATS`, and deploy.
2. Add `https://app.example.com/api/webhooks/email/mailgun/events` for Permanent Failure, Temporary Failure, Spam Complaints, Unsubscribes and Delivered, and optionally Opens and Clicks. These are JSON webhooks; the legacy form-encoded webhooks are not supported.
3. Each delivery is checked as hex HMAC-SHA256(signing key, `timestamp + token`), in constant time, with the timestamp within ±5 minutes. Our ref travels in `X-Mailgun-Variables` and comes back as `user-variables.realty_ref`.
4. **Mapping.** A failure with severity permanent is a hard bounce, including Mailgun's own suppress-bounce, suppress-unsubscribe and suppress-complaint failures. A temporary failure is ignored. `complained`, `unsubscribed`, `delivered`, `opened` and `clicked` map one to one. `rejected` marks the message failed. Anything else is ignored.

In production, `SMTP_VENDOR=ses` or `mailgun` without its event format is refused at startup, unless `EMAIL_WEBHOOK_SECRET` is set for a bridge to the generic format. Bounces, complaints and unsubscribes must reach the app.

### 6.1 Lead email intake (OWNER ACTIONS; nothing is configured by the app or this repository)

Portal lead notifications (Zillow, Realtor.com, a website form) can be forwarded to a lead source's inbound address `leads+<key>@<LEAD_EMAIL_INBOUND_DOMAIN>`. Until the steps below are done, lead email exists only with the fake provider in dev/test.

1. **Choose a dedicated inbound subdomain** you control, e.g. `leads.<your-domain>`, used for nothing else. Set `LEAD_EMAIL_INBOUND_DOMAIN` to it.
2. **DNS (owner):** add the MX record(s) your email provider gives for inbound parsing on that subdomain. Do not point the root domain's MX at it.
3. **Provider inbound parse (owner, VERIFY each console step):**
   - Postmark: an inbound stream for the subdomain, webhook `https://app.example.com/api/webhooks/lead-email/postmark/inbound` with the Basic credentials of `EMAIL_WEBHOOK_BASIC_USER`/`EMAIL_WEBHOOK_BASIC_PASSWORD` in the URL; add `postmark` to `EMAIL_INBOUND_FORMATS`; set `LEAD_EMAIL_AUTHSERV_ID` to the authserv-id Postmark writes in its own `Authentication-Results` header (**VERIFY** that Postmark adds DKIM results to inbound JSON at all; if not, every Postmark lead email is held for review).
   - SendGrid Inbound Parse (default mode, not raw): host = the subdomain, URL `https://app.example.com/api/webhooks/lead-email/sendgrid/inbound` with Basic credentials; add `sendgrid` to `EMAIL_INBOUND_FORMATS`. The DKIM verdict is SendGrid's `dkim` field (**VERIFY** its format, e.g. `{@zillow.com : pass}`).
   - Any other provider (SES, Mailgun inbound): a bridge that posts the generic signed format (`POST /api/webhooks/lead-email/inbound`, X-Realty-Signature with `EMAIL_WEBHOOK_SECRET`) carrying the provider's own DKIM verdict. Never derive the verdict from the message's headers.
4. **Sender domains to confirm (owner, per portal):** which domain DKIM-signs each portal's lead notifications. The seed suggestions `zillow.com` and `realtor.com` are **VERIFY**: if a portal signs with its email vendor's domain, its emails are unaligned and wait in Needs review (safe, but slower) until you confirm and allowlist the right domain.
5. **In the app:** an Owner/Admin turns on lead email per lead source (Routing → lead sources), copies the address into the portal's lead-forwarding setting, and checks the allowed sender domains. Send one test lead from each portal and confirm it either becomes a lead or appears in Needs review with a reason.
6. **Body limits:** the proxy in front of the API must allow at least 5 MB on `/api/webhooks/lead-email/sendgrid/inbound` (1 MB elsewhere); larger deliveries are refused with 413.

## 7. Object storage

`STORAGE_PROVIDER=s3` works with AWS S3, Cloudflare R2 and MinIO. Requests are signed with AWS Signature V4 (tested against AWS's published vectors). The bucket only ever holds ciphertext: each object has its own DEK, wrapped by the tenant `object` key, and keys are `tenants/<tenant>/…`.

- **Private bucket:** block all public access; browsers never get object URLs (playback streams through the API with a 60-second single-use token).
- **Least privilege:** grant the credentials only `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket`, on this bucket (and prefix).
- **Versioning and retention:** turn on versioning, with a lifecycle rule that expires non-current versions. Retention deletes (for example of recordings after 730 days) must not linger forever as old versions. Size the window to your backup policy (**VERIFY WITH COUNSEL** for retention periods).
- **Region and encryption:** use a bucket in the same region as the database. Optional SSE (`S3_SSE`); R2 encrypts at rest by itself.

## 8. Backups and the restore drill

**What to back up:**

- **Postgres:** point-in-time recovery with at least a 35-day window (ARCHITECTURE §8), encrypted, in another region or account.
- **The object bucket:** versioning plus replication, or a nightly copy.
- **The KEK and secrets:** in your secret manager, separately from the data. A backup without the KEK cannot be decrypted, and the KEK without the backup is useless. Losing the KEK loses every tenant's encrypted data.

Erased contacts can persist in backups for the PITR window (**VERIFY WITH COUNSEL**).

**Without managed PITR** (the compose database, or as an extra logical copy), take a dump as the owner role and copy the object store:

```sh
pg_dump -Fc -f realty-<date>.dump "$MIGRATION_DATABASE_URL"          # schema, data, grants; NOT the roles
tar -C /var/lib/realty -czf storage-<date>.tgz storage              # STORAGE_PROVIDER=local (with s3: copy the bucket)
```

Encrypt both and store them away from the host. Roles are cluster-wide, so a dump does not carry `app_user`, `app_definer` or `app_retention`: restoring one into a new instance needs `deploy/restore-roles.sql` first (step 1 below). Without it, `pg_restore` fails every ownership and grant statement (385 in the rehearsal) and the `SECURITY DEFINER` functions are left owned by the superuser that restored them. A physical or PITR restore carries the roles already.

**Restore drill.** Run it at least quarterly and before launch, and write down the times.

1. Restore the latest Postgres backup to a **new** instance (never over production), at a chosen point in time. From a dump: create the owner role and an empty database, then

   ```sh
   psql "$RESTORE_OWNER_URL" -v ON_ERROR_STOP=1 -f deploy/restore-roles.sql
   pg_restore --exit-on-error -d "$RESTORE_OWNER_URL" realty-<date>.dump
   ```

   It must finish with no error. Check that the `SECURITY DEFINER` functions are owned by `app_definer` or `app_retention`: `SELECT r.rolname, count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.prosecdef GROUP BY 1` (no other owner).
2. Run the release step against it with the same image version. It must report `0 applied` (or apply only the migrations newer than the backup), then `release ok`. It also sets `app_user`'s password from the drill's `DATABASE_URL`.
3. Start one API and one worker with the production KEK and secrets, pointing at the restored database and a **read-only** copy of the bucket (or of the storage volume). Use a separate `PUBLIC_BASE_URL` and `WEB_ORIGIN`, and **fake** telephony and email (`ALLOW_FAKE_PROVIDERS=true`), so nothing reaches real clients. With a read-only copy, `/api/ready` reports `degraded` (`storage: failed`), because its check writes a probe object; that is expected here.
4. Check `/api/ready` answers 200. Log in as a known test user with MFA (this proves the KEK decrypts platform data). Open a contact and a conversation. Open a stored object to prove object decryption: a recording, an MMS item, or an import file (the import's **Take snapshot** makes the worker decrypt it; the batch then shows its source counts). For the audit log there is no screen: as the owner role, `SELECT count(*) FROM audit_log`, and check that the worker's first `audit_log seq check` line reports `"missing":0`.
5. Compare row counts of key tables against production at that point in time.
6. Record how long it took (RTO) and how old the data was (RPO), then destroy the drill environment.

**Rehearsed (2026-11-11, one VM, seeded demo tenant, 1.7 MB dump, fake providers):** dump 0.4 s, new instance 3.1 s, roles 0.05 s, `pg_restore` 3.0 s with 0 errors, storage copy 0.01 s, release step 0.14 s (`0 applied`), API start to ready 1.3 s, MFA sign-in, contact, import-file decryption (snapshot job `succeeded`), row counts equal, audit sequence 164 rows with 0 missing. These are machine times for a tiny database; a real RTO is dominated by the restore of real data and by people.

## 9. Key rotation

**Tenant keys** (`field`, `object`) rotate per tenant with `rotateTenantKey` (ARCHITECTURE §8). New writes use the new version, old ciphertext stays readable, and re-encryption is optional. The tenant HMAC key never rotates (R-DATA-2).

**Master KEK rotation:**

1. Generate a new 32-byte key and give it a **new** `KEK_REF` (for example `prod-kek:v2`). Store it in the secret manager next to the current one.
2. Stop the API and worker, or schedule a short maintenance window. Platform-encrypted data changes key in one transaction.
3. Run the rotation in the `api` image, with the owner role:

   ```sh
   docker run --rm --env-file .env.production --env-file .env.owner \
     -e PREVIOUS_KEK_BASE64="$OLD" -e PREVIOUS_KEK_REF=prod-kek:v1 \
     -e KEK_BASE64="$NEW" -e KEK_REF=prod-kek:v2 \
     realty-api:<version> node apps/api/dist/crypto/rotateKekMain.js
   ```

   With the compose stack, add `--network realty_default` so the container can reach the `postgres` host named in `MIGRATION_DATABASE_URL`. The owner URL comes from `.env.owner` (`--env-file` twice: this one-off container, never the api or worker, gets it). Without Docker, the same command is `node apps/api/dist/crypto/rotateKekMain.js` with those five variables set. `-e` overrides the env file's `KEK_BASE64` and `KEK_REF`, so the env file can still hold the old values while the command runs.

   It re-wraps every tenant key and re-encrypts the data under platform keys (users' MFA secrets and stored webhook payloads) in one transaction, then prints counts (`kek rotation ok: 3 tenant keys re-wrapped, 1 MFA secrets and 4 webhook payloads re-encrypted, 0 already under the new KEK`). The tenant data itself is untouched, because it sits under the tenant keys, which do not change. It is idempotent: rows already under the new KEK are skipped, so an interrupted run can simply be repeated. A wrong "previous" key aborts without changing anything.
4. Put the new `KEK_BASE64` and `KEK_REF` in the secret store and the env file, then start the API and worker. Check `/api/ready`, an MFA login and opening a stored object (a recording, or an import file's snapshot). **`/api/ready` does not detect a wrong KEK:** an API started with the old KEK after the rotation answers `ready`, while every MFA verification fails with 500 (`DecryptError` in the log). The MFA login is the check that matters.
5. Keep the old KEK until the oldest backup that needs it has expired (PITR window plus backup retention), then destroy it.

**Rehearsed (2026-11-11, seeded demo tenant):** a random "previous" key aborted with `a tenant key opens with neither KEK (tenant key field v1); nothing was changed` and left `tenant_keys` and the MFA ciphertexts byte-identical. A run killed with SIGKILL while it waited inside its transaction changed nothing either. The real run, through the documented `docker run` command, took 0.4 s including container start (3 tenant keys, 1 MFA secret, 4 webhook payloads). A re-run reported `8 already under the new KEK` and changed nothing. With the new KEK: ready, MFA sign-in, a contact and an import file's decryption by the worker all passed.

A KMS-backed KEK (wrap and unwrap as KMS calls) is a drop-in for the same interface (`crypto/kek.ts`) but is not built yet. It needs a cloud account.

## 10. Launch checklist

- [ ] Release step green. `/api/ready` 200 behind the load balancer. TLS on the public origin.
- [ ] `DATABASE_URL` is the app role. The owner credentials are only in the release job's environment (with the compose stack: in `.env.owner`, never `.env.production`; `docker compose -f docker-compose.prod.yml --env-file .env.owner exec -T api printenv MIGRATION_DATABASE_URL` prints nothing and exits 1).
- [ ] Twilio: master account upgraded; the first team's brand and campaign approved; a live test text, reply, STOP and HELP; a click-to-call with the announcement and the recording kept; a call to a one-party state if you use that mode (**VERIFY WITH COUNSEL**).
- [ ] Email: SPF, DKIM and DMARC aligned for the platform and team domains; a test marketing email unsubscribed with the mail client's own button; a reply lands in the thread; a hard bounce to a test address shows as a suppression.
- [ ] Storage: private bucket; a recording plays back.
- [ ] Backups configured, and one restore drill done and timed.
- [ ] Logs collected; metrics scraped; the alerts of `docs/OPERATIONS.md` §3 routed to a pager; `pnpm ops:synthetic` scheduled every 5 minutes with a dedicated check user (OPERATIONS §6).
- [ ] Counsel items in ARCHITECTURE §19 reviewed for the launch states.
- [ ] Phase 2, Gmail inbox sync (owner decision D2): ships dark. `platform:gmail` stays uncleared (no `reviewed_by_counsel_at`, no `rules.vendor_ready_at`) until counsel item C14 and Google's verification of the restricted `gmail.readonly` scope plus its security assessment (N19, **VERIFY** current requirements and renewal) have passed; the Google OAuth client requests that scope only. Until then no tenant can turn sync on (DB). Rollout precondition (pack notes, R-GMAIL-12): set `vendor_ready_at` only after module 22 has written `messages.rfc_message_id_sha256` on platform email for at least 90 days (the largest backfill window), or after its one-time repair; the database refuses a Gmail duplicate only of platform email that carries the hash.
- [ ] MLS: `MLS_LIVE_CALLS=false` unless every step of §11 "Before any live call" is done and signed off.

## 11. Spark MLS (read-only)

A read-only connector to FBS's Spark RESO Web API (`https://sparkapi.com/Reso/OData`), which shares Spark API keys. It uses a **server-to-server** key: its access token does not expire and is sent in the `Authorization` header. Per-agent login through OpenID Connect is **not** used.

What exists in this lane: the configuration, the read-only adapter (`apps/api/src/providers/integrations/spark.ts`), the connect/validate service and routes (`apps/api/src/mls/spark/`), the Owner/Admin credential form and the validation probe (`/api/admin/integrations/mls/spark`). Syncing the feed into `listings` rows is module 24 (api/mls) and is **not built yet**. Records normalize into the existing RESO listing types, and the `core/listings` display rules (placeholder licence pack, `reviewed=false`) still decide what any audience may see. A connected feed does not make anything public by itself.

**Licensing.** The owner has confirmed that the team's existing IDX licence permits this CRM. That confirmation is the owner's and has **not** been independently re-verified with the MLS; getting it in writing is step 1 below. The CRM must use its **own** Spark key. The team website's token must never be reused, copied into the app or requested from anyone. A separate key is our recommendation (independent revocation, a separate audit trail, separate rate limits); it is not a verified licensing requirement.

### 11.1 Configuration

| Variable | Default | Rule |
|---|---|---|
| `MLS_PROVIDER` | `fake` | `fake` or `spark` |
| `SPARK_API_BASE_URL` | `https://sparkapi.com` | https, default port, no credentials, path, query or fragment; the host must be on `SPARK_ALLOWED_HOSTS` |
| `SPARK_ALLOWED_HOSTS` | `sparkapi.com` | comma-separated lowercase public DNS names |
| `SPARK_AUTH_SCHEME` | `Bearer` | `Bearer` or `OAuth`. Spark's docs show both as the `Authorization` scheme (**VERIFY**). It is the form's default; the scheme chosen when a key is submitted is stored with the key. |
| `MLS_LIVE_CALLS` | `false` | `true` or `false`, in every environment |

**Validation at start-up.** With `MLS_PROVIDER=spark`, the API and worker refuse to start, in every environment including production, when the base URL or the host list breaks a rule above. The error names the key, never its value. An unknown `MLS_PROVIDER`, `SPARK_AUTH_SCHEME` or `MLS_LIVE_CALLS` value is refused the same way.

**No environment variable holds the token.** Do not add one, and do not put a token in `.env`, `.env.production`, the secret store, a ticket or a chat.

**Replication endpoint (verified 2026-11-11).** The CRM's key is a replication key: the standard host refuses it with a 403 that names the replication endpoint (`replication_endpoint_required` in the app). Set `SPARK_API_BASE_URL=https://replication.sparkapi.com` and `SPARK_ALLOWED_HOSTS=replication.sparkapi.com`. No code change is needed; every `@odata.nextLink` must stay on an allowed host.

### 11.2 Where the credential lives

- **Destination:** `provider_credentials` (provider `mls`) in the team's tenant, under AES-256-GCM envelope encryption: the tenant field key, wrapped by the KEK. `KEK_BASE64` lives in the production deployment's secret store (§9). The AAD binds the ciphertext to (`provider_credentials`, `secret_enc`, row id), so it cannot be moved to another row. The chosen auth scheme is inside the encrypted payload. The nonsecret key label (a name you choose; never the token) is in `external_account_ref`.
- **Written only** through the Owner/Admin form (`PUT /api/admin/integrations/mls/spark/credential`): re-auth required, CSRF token, database rate limit, audited. Agents, Team Leads and support get 404.
- **Never** returned by any API, logged, put in a URL, or sent back to the browser after submission. It is redacted from errors, audit, metrics and error reports.
- **Connection:** an `integration_connections` row of kind `mls_feed`, with `external_account_id = spark:<connection id>`. Its `credential_id` is written by the system actor only (R-INT-3).
- **Replacing a key** purges the old credential in the same transaction, and the connection returns to `not_configured` until it is validated again.
- **Disconnecting** (`POST /api/admin/integrations/connections/:id/disconnect`, re-auth) revokes **and** purges the credential in one transaction: status `purged`, `secret_enc` NULL.

### 11.3 Validation

`POST /api/admin/integrations/mls/spark/validate` (Owner/Admin, re-auth) sends **exactly one** request:

```
GET /Reso/OData/Property?$top=1&$select=ListingKey,ModificationTimestamp
```

| Result | Meaning | Next step |
|---|---|---|
| `connected` | the key works and can read Property | none; leave it until module 24 needs it |
| `invalid_credentials` | Spark answered 401 | check the key and the auth scheme (re-enter the key with the other scheme only if Spark support confirms it) |
| `replication_endpoint_required` | Spark answered 403 naming its replication endpoint (a replication key on the standard host) | set the replication address (§11.1) and redeploy; the Owner sees "This key only works on Spark's replication endpoint. Set the replication address in the deployment settings." |
| `not_licensed_or_role_insufficient` | Spark answered any other 403 | the key lacks the role or the licence for this data; go back to the owner and FBS |
| `rate_limited` | Spark answered 429 | wait, then validate once more |
| `busy` | Spark answered 503 ("took too long"); seen once in the live check, the next identical request succeeded | wait a minute and validate again ("Spark was busy. Try again in a minute."); the connection's status does not move |
| `unreachable` | 5xx, network error, timeout, 404, a refused redirect or an unreadable body | check egress to the allowed host and `SPARK_API_BASE_URL`; try later |
| `live_calls_disabled` | `MLS_LIVE_CALLS=false`; **no request was made and the key was not decrypted** | expected until step 7 below |

Only the result code is written to the connection row (`last_error_code`) and `audit_log` (`integration.validated`), never a response body. On a live connection a 401 moves it to `revoked`; 403, 429 and `unreachable` move it to `degraded`; `busy` records the code only; a later `connected` restores it. The probe is never retried.

With no saved key it returns 409 `MLS_CREDENTIAL_MISSING`. With `MLS_PROVIDER=fake`, saving a key is refused with 409 `MLS_PROVIDER_NOT_SPARK`. While live calls are off, the integration page starts with the sentence "Live MLS calls are turned off on this deployment".

### 11.4 Adapter limits

- `GET` only; any other method is refused inside the adapter.
- Paths: `/Reso/OData/$metadata` and `/Reso/OData/Property` only (there is no Media entity set: photos come from `$expand=Media` on Property). https only, hosts from `SPARK_ALLOWED_HOSTS` only, default port only.
- No response header is read but `Content-Length` and `Retry-After`; the `X-Api-Key` header Spark echoes is never logged, stored, audited or returned.
- Field-level `<Field>@Core.Permissions` annotations that do not grant Read remove the field; unknown fields and annotation keys are ignored. The size is read from `BuildingAreaTotal` (there is no `LivingArea`).
- Redirects are refused, never followed. Each request has a timeout and a response size cap.
- Paging follows `@odata.nextLink`, and each next link is re-checked against the same host and path allowlist.
- Incremental changes use a `ModificationTimestamp` cursor, with ties broken by `ListingKey`.
- 429 and 5xx are retried with exponential backoff and jitter, within a retry budget. `Retry-After` is honoured up to a cap.
- Status mapping: 401 → `invalid_credentials`, 403 naming the replication endpoint → `replication_endpoint_required`, other 403 → `not_licensed_or_role_insufficient`, 404 → `not_found`, 429 → `rate_limited`, 503 → `busy`, other 5xx, network error or timeout → `unreachable`.
- A sync run reads at most 500 records in at most 20 pages of 100 (**VERIFY** the largest `$top` with `$expand`).

### 11.5 Before any live call

Roles: **owner** is the team's business owner; **operator** runs the deployment; **Owner/Admin** is a user with that role in the app.

1. **Owner:** confirm in writing with the MLS that the licence covers this CRM's use of the data. File it outside this repository.
2. **Owner:** obtain the CRM's **own** Spark key from FBS, a server-to-server key with the role the licence allows. Never the website's key.
3. **Operator:** confirm `KEK_BASE64` (and `KEK_REF`) is in the production secret store and backed up separately from the data (§8, §9).
4. **Operator:** set `MLS_PROVIDER=spark`, leave `MLS_LIVE_CALLS=false`, and deploy. Confirm the API and worker started (no config refusal) and the integration page says live calls are off.
5. **Owner/Admin:** enter the key and a label in the app's form, after re-auth. The key goes from the key holder straight into the form, and nowhere else. Pressing Validate now must return `live_calls_disabled`.
6. **Owner:** give explicit written approval to turn live calls on.
7. **Operator:** set `MLS_LIVE_CALLS=true` and redeploy.
8. **Owner/Admin:** press **Validate**. It sends one request.
9. **Owner/Admin and operator:** check the result (§11.3). Only `connected` passes.
10. **On any failure, or any doubt:** the operator sets `MLS_LIVE_CALLS=false` and redeploys before anyone investigates.
11. **To stop for good or rotate:** an Owner/Admin disconnects the connection (revokes and purges the stored key) or enters a new key (purges the old one). The owner asks FBS to deactivate a key that is no longer used (**VERIFY** the process with FBS). Then the operator sets `MLS_LIVE_CALLS=false`, and `MLS_PROVIDER=fake` if the feed is retired.
12. **VERIFY with Spark support** (owner or operator) before live sync is turned on:
    - the `Authorization` scheme for this key: `Bearer` or `OAuth`;
    - ~~whether a full background sync must use the replication endpoint~~ (answered: yes, §11.1);
    - which `Core.Permissions` value withholds a field, and which fields the licence lets clients see;
    - the largest `$top` with `$expand=Media`, and whether `$select` inside `$expand` is honoured;
    - which field is the finished living area (`BuildingAreaTotal` is mapped);
    - the rate limits for this key.

### 11.6 Feed sync and the licence pack (module 24)

- **Sync.** The worker's `mls.sync` job (every 60 s per tenant) runs each live `mls_feed` connection whose `next_sync_at` is due: one claim, one read outside any transaction, one fenced write (the sync cursor must be unchanged). Records are upserted by MLS number; an older modification never overwrites a newer one (`MLS_STALE_UPDATE`). A full batch runs again at once; otherwise the next run is 15 minutes later (**VERIFY WITH MLS** the refresh cadence). A failed read degrades the connection with its code (a rejected key revokes it) and retries one interval later. With `MLS_LIVE_CALLS=false` the run records `LIVE_CALLS_DISABLED` and nothing leaves the process.
- **Licence pack.** `PUT /api/admin/mls/connections/:id/license-pack` (Owner/Admin, re-auth) stores every value with the person's statement whether counsel reviewed it. Until **every** value is marked reviewed, and the pack has an attribution and a disclaimer, no MLS listing reaches a client (saved-search alerts). `GET /api/admin/mls` says, per connection, whether MLS data may reach clients and why not. Every value is **VERIFY WITH COUNSEL / MLS**.
- **Staleness.** When the last successful sync is older than the pack's `max_staleness_hours` (a pack without one is always stale), MLS alerts pause, queued MLS alerts are canceled by the `mls.compliance_sweep` job (every 5 min), the connection is marked degraded (`MLS_FEED_STALE`), competing sets drop MLS rows, and the admin view says "MLS data as of …".
- **Stop.** Setting `MLS_LIVE_CALLS=false` stops every read; disconnecting stops the sync and purges the key (§11.2).
