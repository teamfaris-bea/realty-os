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

`docker-compose.prod.yml` is a complete example stack: Postgres, then release, then API and worker, then web. Copy `deploy/env.production.example` to `.env.production` and fill it in. For real teams, use a managed Postgres with backups and TLS instead of the compose database, and put a TLS-terminating load balancer in front of `web`.

**Same origin.** The session cookie is first-party (`__Host-sid`, Secure, SameSite). Serve the web app and `/api` from one origin, which the `web` image does. Set `PUBLIC_BASE_URL` and `WEB_ORIGIN` to that origin (for example `https://app.example.com`) and set `TRUST_PROXY=true` behind the load balancer.

## 2. Health, shutdown and logs

| Endpoint | Meaning | Use it for |
|---|---|---|
| `GET /api/health` | the process answers (no database) | liveness / restart |
| `GET /api/ready` | the database answers **as an RLS-bound role** and the process is not draining | readiness / load-balancer target health |
| worker `GET :$WORKER_HEALTH_PORT/health` | the worker loops run; 503 once stopping | container health check (optional) |

The bodies say only `ok`, `ready`, `draining` or `unavailable`. They carry no versions, ids or errors, and the endpoints are exempt from the rate limit.

**Graceful stop.** On SIGTERM or SIGINT:

- **API:**
  1. `/api/ready` turns 503 at once.
  2. The server keeps serving for `SHUTDOWN_DRAIN_MS` (default 5 s), long enough for the load balancer to notice.
  3. It stops accepting connections and lets in-flight requests finish.
  4. It closes the pool and exits 0.
- **Worker:** stops claiming new jobs, lets in-flight jobs finish (each job is one transaction, so an interrupted one is retried by lease expiry), then exits 0.
- **Hard deadline:** `SHUTDOWN_TIMEOUT_MS` (default 30 s) for either process. A stop that takes longer exits 1.

Give the orchestrator a stop grace period of at least `SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS`. The compose file uses 40 s.

**Start-up refusals.** The API refuses to start, and prints one JSON line naming the problem, when:

- the configuration is incomplete (§4);
- `DATABASE_URL` logs in as a superuser or a `BYPASSRLS` role.

**Logs** are JSON lines on stdout and stderr, for any collector. They follow the ARCHITECTURE §15 rules:

- ids, codes and timings only;
- PII keys dropped, and phone numbers and emails masked in strings;
- requests logged by route pattern, never by raw URL;
- no bodies, prompts, transcripts or credentials;
- vendor error messages are never surfaced, only their codes.

The nginx access log omits query strings, because reset, invite and unsubscribe tokens travel there.

## 3. Database and the release step

Two **different** roles:

- **Owner** (`MIGRATION_DATABASE_URL`): creates roles, owns objects and runs migrations. The application never uses it.
- **App** (`DATABASE_URL`, normally `app_user`): `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`, member of no role. Every API and worker connection uses it.

Every deploy runs the release step once, **before** the new API and worker start:

1. It creates or aligns the app role (its password comes from `DATABASE_URL`).
2. It applies pending migrations. Each runs in one transaction and is checksummed. An edited, renamed or missing applied migration aborts the release.
3. It proves the app role is RLS-bound: not superuser, no BYPASSRLS, and zero tenants visible without context.

It exits non-zero on any failure. Do not start the new version then.

**Managed Postgres (VERIFY).** Migration `0001` creates the `NOLOGIN BYPASSRLS` owner roles `app_definer` and `app_retention`, and `SECURITY DEFINER` functions owned by them. Some managed services do not give the owner full superuser. Before choosing a provider, check that its admin role can create roles with `BYPASSRLS` and transfer function ownership.

**Migrations that ship in this lane.** `0016_production_readiness.sql` adds one `SECURITY DEFINER` read, `app.resolve_telephony_account`, which maps a Twilio subaccount SID to its tenant for webhook signature checks. It returns the tenant id only, for active credentials of active tenants. It is a security-review item.

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
| `MIGRATION_DATABASE_URL` | release step | owner role |
| `PUBLIC_BASE_URL` | yes, https | the public origin. Webhook signatures are computed over it, and it builds links and the reply domain `in.<host>`. |
| `WEB_ORIGIN` | yes, https | CSRF/CORS allowlist (comma-separated) |
| `TRUST_PROXY` | behind a proxy | trust `X-Forwarded-*` from the load balancer |
| `SESSION_COOKIE_SECURE` | default true in prod | must be true |
| `KEK_BASE64` / `KEK_REF` | yes | 32-byte master key-encryption key and its name (§9) |
| `SESSION_SECRET_BASE64` | yes | 32-byte server secret (CSRF, signed links, routing refs) |
| `LEAD_WEBHOOK_SECRET` | yes | signs the lead intake webhook |
| `API_HOST` / `API_PORT` | no | the image defaults to `0.0.0.0:3001` |
| `LOG_LEVEL` | no | `info` |
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
| `TELEPHONY_WEBHOOK_SECRET` | no | only signs the fake's callbacks. With Twilio, each subaccount's own auth token verifies its webhooks. |

**Email** (`EMAIL_PROVIDER=smtp`)

| Variable | Required | Meaning |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | yes | `starttls` (587, default) or `tls` (465). `none` is refused in production. |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | yes in prod | relay credentials |
| `SMTP_VENDOR` | no | `generic`, `postmark`, `sendgrid`, `ses` or `mailgun`. It adds the vendor's metadata header so bounce and complaint events echo our signed reference. |
| `SMTP_POSTMARK_MESSAGE_STREAM`, `SMTP_SES_CONFIGURATION_SET` | no | vendor routing |
| `EMAIL_DKIM_SELECTORS`, `EMAIL_SPF_INCLUDE` | no | used by the sending-domain check (§6) |
| `ACCOUNT_EMAIL_FROM`, `ACCOUNT_EMAIL_FROM_NAME` | yes | sender of password-reset and invite emails |
| `EMAIL_INBOUND_FORMATS` | no | `postmark` and/or `sendgrid`. Empty means only the generic signed format. |
| `EMAIL_WEBHOOK_BASIC_USER`, `EMAIL_WEBHOOK_BASIC_PASSWORD` | with a vendor format | HTTP Basic credentials in the vendor webhook URLs (password ≥ 16 characters) |
| `SENDGRID_EVENT_PUBLIC_KEY` | with `sendgrid` | Event Webhook verification key |
| `EMAIL_WEBHOOK_SECRET` | when no vendor format | the generic `X-Realty-Signature` format |

**Storage** (`STORAGE_PROVIDER=s3`, or `local` with an absolute `STORAGE_DIR` on a persistent, backed-up volume)

| Variable | Required | Meaning |
|---|---|---|
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | bucket and credentials (`S3_SESSION_TOKEN` for temporary credentials) |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | R2 / MinIO | for example `https://<account>.r2.cloudflarestorage.com` with path style on |
| `S3_PREFIX` | no | key prefix inside the bucket |
| `S3_SSE`, `S3_KMS_KEY_ID` | no | `none` (default), `AES256` or `aws:kms`. Objects are already envelope-encrypted by the app (per-object DEK), so SSE is defence in depth. |

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
| others | the generic signed JSON format (`/api/webhooks/email/inbound`, `X-Realty-Signature`) through a small bridge | `/api/webhooks/email/events`, same format |

Event effects:

- A hard bounce is a `hard_bounce` suppression, and the address is marked bouncing.
- A complaint is a `spam_complaint` suppression, which can never be lifted.
- A provider unsubscribe is the person's opt-out: a marketing-email revoke.
- Soft bounces and unknown events change nothing.
- Opens and clicks are behaviour **signals**, never facts.

Amazon SES and Mailgun can send through SMTP here, but their event webhooks (SNS, Mailgun signatures) are not parsed yet. Bridge them to the generic format or use Postmark or SendGrid for events.

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

**Restore drill.** Run it at least quarterly and before launch, and write down the times.

1. Restore the latest Postgres backup to a **new** instance (never over production), at a chosen point in time.
2. Run the release step against it with the same image version. It must report `0 applied` (or apply only the migrations newer than the backup), then `release ok`.
3. Start one API and one worker with the production KEK and secrets, pointing at the restored database and a **read-only** copy of the bucket. Use a separate `PUBLIC_BASE_URL`, and **fake** telephony and email (`ALLOW_FAKE_PROVIDERS=true`), so nothing reaches real clients.
4. Check `/api/ready` is 200. Log in as a known test user with MFA (this proves the KEK decrypts platform data). Open a contact, a conversation, a recording (proves object decryption) and the audit log.
5. Compare row counts of key tables against production at that point in time.
6. Record how long it took (RTO) and how old the data was (RPO), then destroy the drill environment.

## 9. Key rotation

**Tenant keys** (`field`, `object`) rotate per tenant with `rotateTenantKey` (ARCHITECTURE §8). New writes use the new version, old ciphertext stays readable, and re-encryption is optional. The tenant HMAC key never rotates (R-DATA-2).

**Master KEK rotation:**

1. Generate a new 32-byte key and give it a **new** `KEK_REF` (for example `prod-kek:v2`). Store it in the secret manager next to the current one.
2. Stop the API and worker, or schedule a short maintenance window. Platform-encrypted data changes key in one transaction.
3. Run the rotation in the `api` image, with the owner role:

   ```sh
   docker run --rm --env-file .env.production \
     -e PREVIOUS_KEK_BASE64="$OLD" -e PREVIOUS_KEK_REF=prod-kek:v1 \
     -e KEK_BASE64="$NEW" -e KEK_REF=prod-kek:v2 \
     realty-api:<version> node apps/api/dist/crypto/rotateKekMain.js
   ```

   It re-wraps every tenant key and re-encrypts the data under platform keys (users' MFA secrets and stored webhook payloads) in one transaction, then prints counts. The tenant data itself is untouched, because it sits under the tenant keys, which do not change. It is idempotent: rows already under the new KEK are skipped, so an interrupted run can simply be repeated. A wrong "previous" key aborts without changing anything.
4. Start the API and worker with the new `KEK_BASE64` and `KEK_REF`. Check `/api/ready`, an MFA login and opening a recording.
5. Keep the old KEK until the oldest backup that needs it has expired (PITR window plus backup retention), then destroy it.

A KMS-backed KEK (wrap and unwrap as KMS calls) is a drop-in for the same interface (`crypto/kek.ts`) but is not built yet. It needs a cloud account.

## 10. Launch checklist

- [ ] Release step green. `/api/ready` 200 behind the load balancer. TLS on the public origin.
- [ ] `DATABASE_URL` is the app role. The owner credentials are only in the release job's environment.
- [ ] Twilio: master account upgraded; the first team's brand and campaign approved; a live test text, reply, STOP and HELP; a click-to-call with the announcement and the recording kept; a call to a one-party state if you use that mode (**VERIFY WITH COUNSEL**).
- [ ] Email: SPF, DKIM and DMARC aligned for the platform and team domains; a test marketing email unsubscribed with the mail client's own button; a reply lands in the thread; a hard bounce to a test address shows as a suppression.
- [ ] Storage: private bucket; a recording plays back.
- [ ] Backups configured, and one restore drill done and timed.
- [ ] Logs collected; alerts on dead realtime jobs, sweeper lateness, unrouted inbound and webhook signature failures (ARCHITECTURE §15).
- [ ] Counsel items in ARCHITECTURE §19 reviewed for the launch states.
