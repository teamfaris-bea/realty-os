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
| Web | `web` image (nginx) | horizontally | static SPA; proxies `/api` and module 29's public listing pages (`/p/`) to the API on the same origin |

Build both images from the repository root:

```sh
docker build --target api -t realty-api:<version> .
docker build --target web -t realty-web:<version> .
```

`docker-compose.prod.yml` is the single-VM **staging and rehearsal** stack (its Postgres runs in the stack without TLS): Postgres, then release, then API and worker, then web. It takes **two** env files (§3): copy `deploy/env.staging.example` to `.env.production` (the app's environment, which the api, worker and release containers read; `deploy/env.production.example` is the variable reference of a real deployment and no longer pairs with this stack, b12 review deploy-1) and `deploy/env.owner.example` to `.env.owner` (the database owner's user, password and URL, which only the postgres service and the release step receive, by interpolation), and fill both in. Then `docker compose -f docker-compose.prod.yml --env-file .env.owner up -d --build`; the `--env-file .env.owner` flag is needed on **every** compose command, because the compose file itself reads the owner's credentials from it (and `WEB_PORT` from the shell). Never put an owner credential in `.env.production`: the API and the worker refuse to start in production with one in their environment (§2). A stack that still keeps one env file (before batch 5) moves `POSTGRES_OWNER_USER`, `POSTGRES_OWNER_PASSWORD`, `POSTGRES_DB` and `MIGRATION_DATABASE_URL` from `.env.production` into `.env.owner` and switches its `--env-file` to `.env.owner`; until then the new API and worker refuse to start and name the variables to move. See `docs/STAGING.md`. Real teams run `docker-compose.app-vm.yml` on an app VM, with the database on its own host over verified TLS, and a TLS-terminating load balancer in front of `web`: §12 is that runbook.

- **Storage volume.** With `STORAGE_PROVIDER=local`, set `STORAGE_DIR=/var/lib/realty/storage`: the compose file mounts the named volume `storage` there on the API and the worker, and the `api` image creates that directory owned by `node`. Any other path is not writable in the image, and `/api/ready` then reports `degraded` with `storage: failed`.
- **Re-resolving the API.** nginx resolves `API_UPSTREAM` through `NGINX_RESOLVER` (default `127.0.0.11`, Docker's DNS) at most every 10 s, so a recreated `api` container is found again. If you run the `web` image outside Docker networking, set `NGINX_RESOLVER` to a resolver that knows the API's name.
- **No source maps** are shipped in the `web` image (the build stage still has them).

**Same origin.** The session cookie is first-party (`__Host-sid`, Secure, SameSite). Serve the web app, `/api` and the public listing pages under `/p/` (documents the API serves outside `/api`; R-MKT-7) from one origin, which the `web` image does: `deploy/nginx.conf` proxies `/p/` exactly like `/api/` (the same upstream, and `X-Forwarded-For` set to the client so the page's per-IP limits count real visitors) and adds no headers there, since the page sends its own CSP. A front proxy that routes by path must send `/p/` to the `web` container too, or a published page opens the app shell instead. Set `PUBLIC_BASE_URL` and `WEB_ORIGIN` to that origin (for example `https://app.example.com`) and set `TRUST_PROXY` to the proxies that connect to the API (with the compose stack, the `web` container: `TRUST_PROXY=uniquelocal`).

**The client's address.** Every per-IP limit (the website chat's E137 limits, the global limiter, signup, reset and invite) and the audit IP count the address the API takes from `X-Forwarded-For`, so it must be one no client can write. The `web` image's nginx believes `X-Forwarded-For` only from the load balancer (`deploy/real-ip.conf`: `set_real_ip_from` the private, loopback and link-local ranges, `real_ip_recursive on`), takes the right-most address no trusted hop added, and sends the API that address as the **only** `X-Forwarded-For` entry: a header the client wrote is replaced, never appended to. A client that reaches nginx directly is its own address. The API believes `X-Forwarded-For` only from the peers `TRUST_PROXY` lists (addresses, CIDRs, `loopback`, `linklocal`, `uniquelocal`); it refuses `TRUST_PROXY=true`, which would trust every hop and let one host choose a fresh IP for every request (finding chat-xff-ratelimit-bypass: 12 of 12 chat starts from one machine passed a 5-a-minute limit). If your TLS edge connects from **public** addresses (a CDN in front of the `web` container), mount your own `/etc/nginx/snippets/real-ip.conf` listing the edge's published ranges, never `0.0.0.0/0`. Do not publish the API's port: only `web` should reach it.

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

- the configuration is incomplete or unsafe (§4). Rehearsed refusals: `KEK_BASE64` missing, not base64 or not 32 bytes; `KEK_REF` missing; fake providers without `ALLOW_FAKE_PROVIDERS=true`; a non-https `PUBLIC_BASE_URL` or `WEB_ORIGIN` entry; `SESSION_COOKIE_SECURE=false`; the KEK equal to the session secret; with `MLS_PROVIDER=spark`, a Spark base URL that is http, has a path, a port or credentials, or a host missing from `SPARK_ALLOWED_HOSTS`, and a wildcard or internal name in that list; an unknown `MLS_PROVIDER` or `MLS_LIVE_CALLS` value; an unknown `PUBLIC_RECORDS_PROVIDER` or `PUBLIC_RECORDS_LIVE_CALLS` value, a wildcard or internal name in `PUBLIC_RECORDS_ALLOWED_HOSTS`, and with `PUBLIC_RECORDS_PROVIDER=county` a county service host missing from that list;
- `DATABASE_URL` logs in as a superuser or a `BYPASSRLS` role (`DATABASE_URL must be the RLS-bound app role (not superuser, no BYPASSRLS)`, checked first);
- R-DEPLOY-1, checked next, in this order, each naming the check: the login is not `app_user` (`current_user` or `session_user`, E480); `app_user` has CREATEROLE, CREATEDB or REPLICATION, is a member of a role, owns a relation, function or schema, or holds CREATE on a schema (E481); a public table lacks ENABLE and FORCE row-level security (named, E482); a tenant is visible without context; with `DATABASE_SSL_MODE=verify-full`, the session is not encrypted, or the connection fails: `database TLS failed (DATABASE_SSL_MODE=verify-full): <code>` (a TLS or socket error code, or `SERVER_NO_SSL`; never the host, E486);
- with `NODE_ENV=production`, a `PG*` variable is set (`PGPASSWORD`, `PGSSLMODE`, `PGHOST`, …: pg reads them in place of the URL's own settings; named with the owner variables in one line, E483), a database URL carries a query string or fragment (E484), or the TLS settings are refused (E485, §4);
- with `NODE_ENV=production`, a database owner credential is in the process environment at all: `MIGRATION_DATABASE_URL`, `POSTGRES_OWNER_PASSWORD` or `POSTGRES_PASSWORD` (checked first, before anything else is read; the line names the variables, never their values). The batch 5 review found the compose file giving the internet-facing api and worker the owner's superuser URL and password; an environment leak or code execution there would have been a superuser login (every guard, the append-only and audit tables, `COPY … TO PROGRAM` on the database host).

A `KEK_BASE64` or `SESSION_SECRET_BASE64` problem is reported on its own, before the rest of the list: fix it and start again to see the other problems.

**Logs** are JSON lines on stdout and stderr, for any collector. They follow the ARCHITECTURE §15 rules:

- ids, codes and timings only;
- PII keys dropped, and phone numbers and emails masked in strings;
- requests logged by route pattern, never by raw URL;
- no bodies, prompts, transcripts or credentials;
- vendor error messages are never surfaced, only their codes.

The nginx access log carries no capability (a secret in a URL that is the request's only authority): no query string, and `-` for every secret path segment. Those are the invite token (`/api/auth/invites/<token>/accept`, valid until the invite is accepted), the chat session token (`/api/public/chat/session/<token>/…`, polled every few seconds while a chat is open), the one-click unsubscribe ref (`/api/email/unsubscribe/<ref>`) a lead source's intake token (`/api/intake/<token>`) and module 29's signed marketing image link (`/api/public/marketing-assets/<token>`, handed to Meta, valid up to `MARKETING_IMAGE_URL_TTL_MINUTES`) (the `$log_uri` map in `deploy/nginx.conf`). The only routes outside `/api` are the listing pages; their parameters are public slugs, so they are logged as they are, and `capabilityPaths.test.ts` pins that list (`DOCUMENT_ROUTES`). The API generates that list from its route table into `apps/api/src/capabilityPaths.json`: every path parameter named `…token`, and every parameter of a route without a session, unless `capabilityPaths.ts` names it public on that route (the widget key on `GET /api/public/chat/:widgetToken` and `POST …/:widgetToken/start`, the integration kind on the OAuth callback `/api/admin/integrations/:kind/callback`); the same name on any other route is still a secret. `apps/api/src/capabilityPaths.test.ts` fails while the JSON is stale, and `apps/web/src/security-headers.nginx.test.ts` fails while the map misses a path in it, so a new capability route cannot ship with its secret logged. Its client address is the real one (above).

The nginx error log carries no request at all: the server sends every record about a request to `/dev/null` (`error_log` in `deploy/nginx.conf`), because nginx adds the raw request line, query string included, and the upstream URI to each one, so an API restart on a deploy would put every open chat's session token there. The error log (stderr) still holds nginx's own start-up, reload and shutdown messages. It no longer holds nginx's capacity alarms either (`accept4() failed (24: Too many open files)`, `worker_connections are not enough`): nginx writes them to the same server-level `error_log`, and they leave no access-log line, because no request was ever read. So watch the `web` container from outside: the load balancer's connection errors and 5xx, and the container's health and restarts. A request that failed in nginx shows in the access log only, by its status and time: 502 when the API refused or dropped the connection or its name did not resolve, 504 when it did not answer within 60 s, 500 when nginx had no file or connection left to open one to the API. When the API answered, its own logs say why. For a 502 because the API was down, restarting or not resolvable, the API logged nothing about that request: check `docker compose -f docker-compose.prod.yml --env-file .env.owner ps`, the api container's logs and `/api/ready`.

**Security headers.** The `web` image's nginx sends the web app's security headers (`webSecurityHeaders` in `apps/web/security-headers.ts`: the strict CSP with `frame-ancestors 'none'`, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP, X-Frame-Options) on every page, asset and SPA-fallback response, from the generated snippet `deploy/security-headers.conf`. The one exception is the website chat widget's script, `/widget/chat.js` (built into the image by `vite.widget.config.ts`), which brokerages' own websites load with a plain `<script src>`: it gets the same headers with `Cross-Origin-Resource-Policy: cross-origin` (`widgetScriptHeaders`, snippet `deploy/widget-security-headers.conf`), a 5-minute cache, and a 404 rather than the SPA fallback when missing. `/api/` responses carry only the API's own headers, CORS included: nginx adds, hides and answers no `Access-Control-*` header or preflight, so the API's own CORS for `/api/public/chat/` reaches the browser unchanged. That CORS answers any website without credentials (no cookie ever rides along); a widget's allowed websites are enforced where its key is resolved (`GET /api/public/chat/:widgetToken`, the widget key, and `…/:widgetToken/start` answer 404 elsewhere), while an open chat's session routes (`…/session/:token/messages` and `…/poll`) rely on the session token alone. So removing a website from a widget, or rotating its key, stops new chats there but not chats already open, which end when the visitor has been gone 30 minutes; disconnecting the widget ends them all at once. After changing the policy, run `node deploy/render-security-headers.mjs` and commit the snippets; `pnpm --filter @realty/web test` fails while it is stale or while any nginx location drifts from the policy (SECURITY §2.1). Add HSTS at the TLS-terminating edge.

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

**The owner role (R-DEPLOY-2, R-DEPLOY-4).** The owner must bypass row-level security: superuser, or `BYPASSRLS`. An owner subject to RLS is refused by the runner, the release step and `db:preflight` before anything is written (E475): the backfills in `0032`, `0034`, `0035` and `0045` would otherwise update **zero** rows under FORCE RLS without an error, and `0001` cannot create the `BYPASSRLS` roles. A managed Postgres usually gives a non-superuser admin role instead of a superuser (**VERIFY** per provider). The release step supports one that has `CREATEROLE` and `BYPASSRLS` (no `CREATEDB` or `REPLICATION` needed) and `CREATE` on the database (owning it is simplest):

1. it refuses a missing `CREATEROLE`, a missing `CREATE` on the database, or a cluster role that already exists without the owner's `ADMIN OPTION` (E477, naming `GRANT <role> TO <owner> WITH ADMIN OPTION` for an administrator; **VERIFY** whether your provider lets its admin role receive that);
2. it runs the FORCE-RLS update probe (rolled back) and requires 1 updated row (E476);
3. it runs `0001`'s role block (the owner creates the roles it lacks, and holds `ADMIN` on them), grants itself `app_definer` and `app_retention` `WITH INHERIT TRUE, SET TRUE` (ALTER … OWNER TO needs SET; the EXECUTE grants on their functions need INHERIT), and aligns `app_user`, changing only the attributes PostgreSQL 16 lets it change (E478 names any other);
4. it opens the **schema CREATE window**: a default privilege and direct grants give the definer roles `CREATE` on the owner's schemas (function ownership moves need it), prints `schema CREATE window opened for app_definer, app_retention`, runs the migrations, and in `finally` revokes both and prints `schema CREATE window closed`. A run killed in between leaves the window to the next run, which closes it first (`schema CREATE window left open by an earlier run: closed`);
5. post-checks on every release (E479): every `SECURITY DEFINER` function outside `pg_catalog` and `information_schema` that is not an extension member is owned by `app_definer` or `app_retention`; neither holds `CREATE` on any schema or a default privilege; both are `NOLOGIN NOSUPERUSER BYPASSRLS` (0001's own check runs only once). Then the R-DEPLOY-1 app checks over `DATABASE_URL` (§2), which replace the old single query.

It prints one secret-free line per step, then `release ok: app connects as app_user, RLS-bound`; a second run prints `0 applied` and `release ok`. A superuser owner (dev, the test template, the staging compose stack) skips steps 3 and 4 and prints exactly what it printed before: **the superuser path is unchanged**, and the new checks pass silently on it. Rehearsed on the local test cluster only (a CREATEROLE BYPASSRLS owner without CREATEDB applied every migration, then `0 applied`); the catalog matches a superuser-migrated database apart from ACL entry order. Check a candidate provider first with `pnpm db:preflight -- --trial` on a throwaway database (§12, G1). 0001's comment that "creating a BYPASSRLS role needs superuser" (0001_init.sql:31-32) predates these PostgreSQL 16 facts; it stays, because 0001 is an applied migration and is never edited.

**Preflight (read-only).** `pnpm db:preflight` (in the image: `node packages/db/dist/scripts/preflight.js`) commits nothing:

- `--owner` (`MIGRATION_DATABASE_URL`): the owner bypasses RLS (E475), a non-superuser owner's CREATEROLE, CREATE on the database and ADMIN on each existing cluster role (E477), the FORCE-RLS probe (E476), and whether a schema CREATE window is open (reported, never closed: the release step closes it);
- `--app` (`DATABASE_URL`, with the app's TLS settings): the R-DEPLOY-1 checks of §2 (`not checked` before the first release);
- `--trial`: §12, G1. The default is `--owner --app`.

One line per check (`ok`, `failed: <reason>` or `not checked: <why>`, e.g. `tls: not checked: DATABASE_SSL_MODE=disable (staging only)`), then `preflight ok` or `preflight failed: <n> checks`; exit 0 or 1. It prints no URL, host or password (SQLSTATE and TLS codes only).

The new refusals, exact messages: `the migration role <name> is subject to row-level security (not superuser, no BYPASSRLS): migration backfills would update zero rows under FORCE RLS, and 0001 cannot create the BYPASSRLS roles; nothing was applied`; `the migration role <name> lacks CREATEROLE …` / `… lacks CREATE on the database …` / `… lacks ADMIN OPTION on the existing role <role> …`; `the migration role <name> does not bypass row-level security on its own tables (the FORCE-RLS update probe updated 0 rows, not 1) …`; `app_user has CREATEDB and the owner role cannot remove it (PG16 lets only a role with CREATEDB change it): ask an administrator to run ALTER ROLE app_user NOCREATEDB`; `post-checks failed: …`; `the app role check failed: …`. A connection or TLS failure prints `release failed: database connection failed: <code>`, never the host.

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
| `DATABASE_SSL_MODE` | default `verify-full` in prod | `verify-full` (verified TLS, checked against the URL's host) or `disable`. Nothing else: `require`, `prefer` and `verify-ca` mean verify-full in pg anyway and `no-verify` turns verification off. `disable` is refused in production unless `ALLOW_FAKE_PROVIDERS=true` (staging, whose database is on the same VM). Applies to every client, the owner's included (R-DEPLOY-5) |
| `DATABASE_SSL_CA_FILE` | no | absolute path to the database CA (PEM); without it Node's default trust store is used. The CA is public data: mode 0644, readable by the image's `node` user. The app VM mounts `/etc/realty/db-ca.pem` at `/run/realty/db-ca.pem` read-only |

Database URLs carry **no query string or fragment** in production (E484: `?user=`, `?host=` or `?sslmode=` would override the login, the host or the TLS mode), and no `PG*` variable may be set (E483).
| `PUBLIC_BASE_URL` | yes, https | the public origin. Webhook signatures are computed over it, and it builds links and the reply domain `in.<host>`. |
| `WEB_ORIGIN` | yes, https | CSRF/CORS allowlist (comma-separated) |
| `TRUST_PROXY` | behind a proxy | the proxies whose `X-Forwarded-For` is believed: comma-separated addresses, CIDRs, `loopback`, `linklocal` or `uniquelocal` (compose stack: `uniquelocal`, the `web` container). Empty or `false`: none. `true` is refused (it trusts every hop: a client could pick its own IP) |
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
| `TELEPHONY_LIVE_REQUESTS` | no | `false` (default in every environment, production included) or `true`. The telephony kill switch (§5.1): while `false`, the Twilio adapter refuses every outbound request before making it. **It stays `false` until the written pilot approval.** |

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

**County public records (homeowner profile, owner decision D10)** (`PUBLIC_RECORDS_PROVIDER=county`; procedure below in "Before any live county call"). No credential exists; the county service URLs are code constants.

| Variable | Required | Meaning |
|---|---|---|
| `PUBLIC_RECORDS_PROVIDER` | no | `fake` (default; production without `ALLOW_FAKE_PROVIDERS` then looks nothing up) or `county` (the Beaufort County GIS connector) |
| `PUBLIC_RECORDS_LIVE_CALLS` | no | `false` (default in every environment) or `true`. The kill switch: while `false`, the county connector builds no request at all and the panel says live lookups are off. |
| `PUBLIC_RECORDS_ALLOWED_HOSTS` | no | comma-separated lowercase public host names; default `gis.beaufortcountysc.gov` (**VERIFY**). The app's SSRF list for the county service host, not a network allow-list. |

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

**AI answering of missed calls (module 48) stays off.** It needs, all at once: `platform:voice` counsel-reviewed (counsel-review) AND `rules.vendor_ready_at` (no writer exists: a real vendor must first pass the latency check, N12), a configured voice vendor (production uses the unconfigured stand-in: "No voice vendor is set up on this platform yet"), an approved "AI answering for missed calls" playbook, the Owner's attested switch (`POST /api/voice/answering/enable`; the settings screen is module 55, not built yet), recording on, and `TELEPHONY_LIVE_REQUESTS=true` on real telephony. The deterministic fake never answers a call on `TELEPHONY_PROVIDER=twilio`. Until then every call follows the flow above unchanged. A completed AI call without a handback after 10 minutes raises a P1 (`WORKER_ERROR`, reason `VOICE_HANDBACK_MISSING`).

**MMS.** Inbound media are fetched by SID with the subaccount credentials (the media URL in the webhook is never fetched). Kept: at most 10 items of at most 5 MB, of allowed types (JPEG, PNG, GIF, WebP, HEIC/HEIF, MP4, 3GPP, QuickTime, AMR, MP3, M4A, PDF, vCard) whose bytes match the type. Each item is encrypted with its own DEK and deleted at Twilio. Anything else is not stored; the conversation says which attachment was not saved, and why.

**Outbound (D5).**
- A photo text sends `MediaUrl`s on `PUBLIC_BASE_URL` (`/api/mms/media?token=…`), which Twilio must reach over https. The links expire 10 h 20 min after dispatch.
- Twilio keeps a copy of sent media. The app deletes it 24 h after dispatch. For a submit whose outcome stayed unknown, it deletes every photo text sent from that number around that time, and raises a P2 alert if it finds none.
- On each subaccount, turn on HTTP Basic Auth for media (VERIFY where this is set), and decide on MMS Converter. With it on, recipients whose carrier has no MMS get a public p.twil.io link. With it off, those sends fail with 21612, said plainly (VERIFY).
- The token is signed with `SESSION_SECRET_BASE64`. Rotating that secret breaks media links that are still in flight.
- The media token rides in the query string. Inside this repository nothing logs it: the API logs the route pattern only (`/api/mms/media`), nginx's access log writes `$log_uri` (built from `$uri`, so never a query string; `security-headers.nginx.test.ts` refuses `$args`, `$request`, `$request_uri` and `$query_string` in the format), and nginx's error log writes no request at all (`error_log /dev/null`, above). The one deploy item is outside the repository: the TLS terminator or load balancer in front of nginx must not log query strings for `/api/mms/media` (VERIFY on the deploy host). Twilio's own request and error logs also see the link, for its 10 h 20 min life.

**Opt-outs.** Twilio's own STOP handling stays on. A send to a recipient who texted STOP fails at Twilio with error 21610, which the app records as a provider opt-out (R-CONSENT-12), on top of its own keyword handling (D1).

### 5.1 Telephony kill switch and daily cap (R-TWL-1, R-TWL-2)

**The switch stays off until the written pilot approval.** `TELEPHONY_LIVE_REQUESTS` defaults to `false` in every environment, production included; only the exact value `true` turns it on, and any other value refuses start-up (the error names the key, never the value). The API's `starting api` log line (`config.telephonyLiveRequests`) and the worker's `starting worker` line (`telephonyLiveRequests`) show the value on every start, on staging and production alike.

While it is `false`, the Twilio adapter (`providers/twilio/http.ts`, the one place every Twilio REST request passes) refuses each request **before it is made**, with the typed provider error `TELEPHONY_LIVE_OFF`: sends, calls, number purchase and release, message lookups (reconciliation), registration reads, media and recording fetches and deletes, subaccount creation, alert-phone verification codes and line-type lookups. No credential is put on the wire. What people see:

| Path | Result while the switch is off |
|---|---|
| a text (any sender) | the message is `failed`, reason `TELEPHONY_LIVE_OFF`; the agent sees "Live texting and calling are off on this deployment." Never an opt-out, never retried, never reconciled. |
| click-to-call | `{ result: 'failed', reason: 'TELEPHONY_LIVE_OFF' }`, the same sentence; nothing is dialed |
| buy a number, release a number, "Check registration status" | `409 TELEPHONY_LIVE_OFF`, the same sentence; nothing changes |
| an agent alert text | the delivery ends `suppressed` `TELEPHONY_LIVE_OFF` (not retried); push and email alerts are unaffected |
| an inbound MMS attachment or text part | not fetched: recorded as not saved (`FETCH_FAILED`), with the usual honest note in the conversation |
| inbound webhooks | keep working: they only receive what someone points at them |

**Daily cap.** `tenant_settings.telephony_daily_cap` (default **200**, CHECK 1–100000) limits the outbound texts and calls a team hands the real telephony adapter per team-local day. It is enforced inside the send-time transaction, before the provider call, by claiming one unit of `telephony_daily_usage`; over the cap the send is blocked with the gate reason `DAILY_SEND_CAP_REACHED`, "Today's sending limit for this team is reached." The platform's own STOP confirmation and HELP reply are exempt. The cap counts only while `TELEPHONY_PROVIDER=twilio` (the deterministic fake is not counted). To change a team's cap, an operator updates the column (no screen yet).

**Where the pilot credentials will live.** When the pilot is approved, the team's Twilio credentials live only in the encrypted `provider_credentials` store (field-encrypted under the tenant key, like every subaccount token). This release adds no way to enter them, and no change to any number, Messaging Service or webhook configuration at Twilio.

### 5.2 Telephony webhook endpoints: the stable public contract (R-TWL-3)

These paths are a **public contract**: provider configuration points at them and they never move. `{base}` is `PUBLIC_BASE_URL` exactly as Twilio calls it (scheme and host, no trailing slash). Every one is `POST`, form-encoded (`application/x-www-form-urlencoded`), and:

- **verifies `X-Twilio-Signature`** before anything else (HMAC-SHA1 over `{base}` + the path and query + the sorted form parameters, keyed by the auth token of the account named by `AccountSid`; with the fake, by `TELEPHONY_WEBHOOK_SECRET`). The URL is built from `PUBLIC_BASE_URL`, **never the Host header**. A bad or missing signature is `403 WEBHOOK_SIGNATURE_INVALID`, a tenant-less rejected row and no tenant write;
- **is idempotent** on the provider id named below: a retried or replayed delivery is recorded once (`webhook_events`, then the downstream unique keys) and changes nothing the second time; TwiML endpoints answer the same TwiML from stored state.

`webhooks.contract.test.ts` fails if a path below disappears from the route table, stops verifying its signature, or stops being idempotent.

| Path | Parameters (form; query) | Answers | Idempotent on |
|---|---|---|---|
| `{base}/api/webhooks/telephony/sms` | `MessageSid`, `From`, `To` required; `Body`, `NumMedia`, `MediaUrl{n}`, `MediaContentType{n}`, `OptOutType` | empty TwiML `<Response></Response>` (`text/xml`) | `MessageSid` |
| `{base}/api/webhooks/telephony/status` | `MessageSid` required; `MessageStatus`, `ErrorCode`, `From` (optional: R-TWL-4); query `m` = our message id | `200 {"ok":true}` (also for an unknown status or an unrouted callback) | `MessageSid` + `MessageStatus` |
| `{base}/api/webhooks/telephony/voice` | `CallSid`, `From`, `To` required; `CallStatus`, `Direction`, `ParentCallSid`, `CallDuration`, `Timestamp`, `AnnouncementStatus` | TwiML: for a new inbound call the ring/voicemail plan (with an AI takeover planned, module 48, the Dial timeout is `voice_answer_after_seconds`; nobody ringable ⇒ the assistant's stream at once), for an AI call the same stream again (its `in_progress` status is ignored), otherwise empty TwiML | `CallSid` + `CallStatus` (+ announcement); the stored plan answers a retried fetch |
| `{base}/api/webhooks/telephony/voice/screen` | query `c` (our signed call ref); form as Twilio sends it | TwiML: the agent's whisper ("press 1"), or hang up; for an AI call's transfer leg, the owner's fixed whisper (module 48) | the call's stored state (same answer every time) |
| `{base}/api/webhooks/telephony/voice/accept` | query `c`; `Digits` | TwiML: bridge on `1`, else hang up; for an AI call's transfer leg, bridge on `1` within the hold, else "This call has ended." and the caller stays with the assistant (`calls.transfer_outcome` written once) | the call's stored state (accepted once) |
| `{base}/api/webhooks/telephony/voice/dial-result` | query `c`; `DialCallStatus` | TwiML: voicemail when unanswered, else hang up; with an AI takeover planned, the assistant's stream instead of voicemail (a refusal by the DB guard is the voicemail, unchanged), and a retried dial result replays that stream | the call's stored state |
| `{base}/api/webhooks/telephony/voice/voicemail-done` | query `c` | TwiML: the closing sentence, hang up | stateless |
| `{base}/api/webhooks/telephony/recording` | `CallSid`, `RecordingSid` required; `RecordingDuration`, `From`; query `vm` (signed voicemail ref) | `200 {"ok":true}` | `RecordingSid` |
| `{base}/api/webhooks/telephony/answer` | query `c` (signed); `CallSid`, `ParentCallSid` | TwiML: the recording announcement when owed, else empty TwiML | `ParentCallSid` (else `CallSid`) |

**The app never re-points a number.** Numbers bought through the app get these URLs once, at purchase (the only code that writes `SmsUrl`, `VoiceUrl` or a number's `StatusCallback`; R-TWL-5, architecture test). Nothing updates an existing number at Twilio, and the team's existing numbers stay routed exactly as they are.

### 5.3 Opt-outs and sender errors from Twilio (R-TWL-7 to R-TWL-11)

D1 is unchanged: sending checks only opt-outs. Each item below plugs into the same opt-out model and the single send path. **Twilio's Advanced Opt-Out stays off** (owner default); Twilio's own STOP handling stays on.

| Signal | What the app does |
|---|---|
| `OptOutType=STOP` on an inbound text whose Body we do not read as a STOP, opt-out language or wrong number | treated as STOP (`OPTOUTTYPE_STOP`): every phone of the contact revoked, queued texts cancelled, owner told; **no** platform confirmation (Twilio sent its own). `START`, `HELP` and a Body of `YES` change nothing; YES never lifts an opt-out. |
| `21610` on a text to a contact | provider opt-out (R-CONSENT-12), as before |
| `21610` on an agent alert text | the agent's alert texts are revoked as if they had texted STOP; the delivery is `suppressed` `PROVIDER_OPTED_OUT`; audited; Admins told. The agent's own START from that phone restores alerts. |
| `30032` (toll-free not verified) or `30034` (unregistered A2P 10DLC sender), on the submit or a status callback | the text fails `SENDER_NOT_VERIFIED` ("Not delivered: the team's number isn't verified for texting. The Owner has been told."), never an opt-out, never retried or reconciled. In the same transaction the number's registration is marked not ready (`status_detail` names the code), so texts from it are blocked by the sender check while **calls keep working**; one Owner/Admin notice per number per day. Only **Check registration status** restores it (a Twilio read, blocked while the kill switch is off). |
| STOP / HELP to a **toll-free** number | the platform sends no confirmation or HELP reply of its own (the carrier answers). Local numbers follow the team policy. |
| text in an MMS `text/plain` part | read by SID (≤ 16 KiB, strict UTF-8) by job `comms.mms_text`; a STOP, opt-out language or wrong number in it has the same effects as in the Body (it never lifts one); a STOP found only in a part is confirmed by the platform once per message. An unreadable part is recorded as not saved and the conversation's handler is told to check it before texting. |

**VERIFY in the pilot test step** (with the written approval, on a test number, before any real lead): the codes 30032 and 30034 and the status a failed toll-free / 10DLC send reports; that Twilio sends `OptOutType` on the inbound webhook for STOP/START/HELP; that a toll-free number's carrier answers STOP and HELP itself (so the platform's silence is right); how Twilio delivers a text part of an MMS (MediaContentType `text/plain`) and whether its own keyword handling reads it.



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
5. **In the app:** an Owner/Admin turns on lead email per lead source (Routing → lead sources), copies the address into the portal's lead-forwarding setting, and checks the allowed sender domains. Send one test lead from each portal and confirm it becomes a lead automatically: only that confirms the portal's sender domain (the page calls the suggested ones unconfirmed until then). One that waits in Needs review did arrive, and its reason says what is wrong (step 4).
6. **Body limits:** the proxy in front of the API must allow at least 5 MB on `/api/webhooks/lead-email/sendgrid/inbound` (1 MB elsewhere); larger deliveries are refused with 413.

### 6.2 Google Ads lead forms (module 22; OWNER ACTIONS; nothing is configured by the app or this repository)

1. **Gate:** do not point any Google form at a deployment until the team's housing-advertiser eligibility for lead form assets is confirmed (PHASE2_3_PLAN N22; **VERIFY** support.google.com/adspolicy/answer/9472930).
2. The deployment needs a public https `PUBLIC_BASE_URL`; otherwise the Lead sources page says the form is not available here.
3. On the Lead sources page, the Owner turns on the source's Google lead form, picks what its leads are about, and copies the webhook URL (`https://app.example.com/api/webhooks/google-ads/lead-form`, one fixed URL) and the key into the lead form asset's webhook integration in Google Ads (**VERIFY** the menu names).
4. **Pilot step G5:** press Google's "Send test data" there. The page then says "Test lead received <time> (no one was added)". If it does not, Google's test may be sending a placeholder key (**VERIFY**): submit a real lead on the team's own form instead and check "Last lead" on the page. A test lead creates no contact.
5. Bodies the API's JSON parser refuses (a NUL character, malformed JSON, a non-JSON content type) are answered 4XX before the key can be read: the key travels inside the body, so such a delivery cannot be authenticated, and it is refused like any unsigned request. Google keeps its leads downloadable in Google Ads for 30 days; whether it retries a 4XX (it should not) or a 5XX (it should), how often and for how long, is **VERIFY** (PHASE2_3_PLAN #22 addendum).

## 7. Object storage

`STORAGE_PROVIDER=s3` works with AWS S3, Cloudflare R2 and MinIO. Requests are signed with AWS Signature V4 (tested against AWS's published vectors). The bucket only ever holds ciphertext: each object has its own DEK, wrapped by the tenant `object` key, and keys are `tenants/<tenant>/…`.

- **Private bucket:** block all public access; browsers never get object URLs (playback streams through the API with a 60-second single-use token).
- **Least privilege:** grant the credentials only `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket`, on this bucket (and prefix).
- **Versioning and retention:** turn on versioning, with a lifecycle rule that expires non-current versions. Retention deletes (for example of recordings after 730 days) must not linger forever as old versions. Size the window to your backup policy (**VERIFY WITH COUNSEL** for retention periods).
- **Region and encryption:** use a bucket in the same region as the database. Optional SSE (`S3_SSE`); R2 encrypts at rest by itself.
- **Documents (module 42):** deal, listing and contact documents are stored here too (purpose `document`, at most 10,000,000 bytes each; the proxy's 11m body limit covers them). Production has no virus scanner yet (N11): every upload stays locked and says so until one is configured; there is no environment variable for it.

## 8. Backups and the restore drill

**What to back up:**

- **Postgres:** point-in-time recovery with at least a 35-day window (ARCHITECTURE §8), encrypted, in another region or account. On the app-VM deployment this is §12's H4 step.
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

   It must finish with no error. Check that the `SECURITY DEFINER` functions are owned by `app_definer` or `app_retention`: `SELECT r.rolname, count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') GROUP BY 1` (no other owner; extension members, which a managed provider may install, are left out). The release step of step 2 runs the same check (E479).
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

   On the app VM (§12), with `/run/realty/owner.env` rendered for this window only, pass the key **names**, so no value lands in argv; the values are exported from the secret manager in the operator's shell:

   ```sh
   REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml --profile release run --rm \
     -e PREVIOUS_KEK_BASE64 -e PREVIOUS_KEK_REF=prod-kek:v1 -e KEK_BASE64 -e KEK_REF=prod-kek:v2 \
     release node apps/api/dist/crypto/rotateKekMain.js
   ```

   Then remove `owner.env`. With the compose stack, add `--network realty_default` so the container can reach the `postgres` host named in `MIGRATION_DATABASE_URL`. The owner URL comes from `.env.owner` (`--env-file` twice: this one-off container, never the api or worker, gets it). Without Docker, the same command is `node apps/api/dist/crypto/rotateKekMain.js` with those five variables set. `-e` overrides the env file's `KEK_BASE64` and `KEK_REF`, so the env file can still hold the old values while the command runs.

   It re-wraps every tenant key and re-encrypts the data under platform keys (users' MFA secrets and stored webhook payloads) in one transaction, then prints counts (`kek rotation ok: 3 tenant keys re-wrapped, 1 MFA secrets and 4 webhook payloads re-encrypted, 0 already under the new KEK`). The tenant data itself is untouched, because it sits under the tenant keys, which do not change. It is idempotent: rows already under the new KEK are skipped, so an interrupted run can simply be repeated. A wrong "previous" key aborts without changing anything.
4. Put the new `KEK_BASE64` and `KEK_REF` in the secret store and the env file, then start the API and worker. Check `/api/ready`, an MFA login and opening a stored object (a recording, or an import file's snapshot). **`/api/ready` does not detect a wrong KEK:** an API started with the old KEK after the rotation answers `ready`, while every MFA verification fails with 500 (`DecryptError` in the log). The MFA login is the check that matters.
5. Keep the old KEK until the oldest backup that needs it has expired (PITR window plus backup retention), then destroy it.

**Rehearsed (2026-11-11, seeded demo tenant):** a random "previous" key aborted with `a tenant key opens with neither KEK (tenant key field v1); nothing was changed` and left `tenant_keys` and the MFA ciphertexts byte-identical. A run killed with SIGKILL while it waited inside its transaction changed nothing either. The real run, through the documented `docker run` command, took 0.4 s including container start (3 tenant keys, 1 MFA secret, 4 webhook payloads). A re-run reported `8 already under the new KEK` and changed nothing. With the new KEK: ready, MFA sign-in, a contact and an import file's decryption by the worker all passed.

A KMS-backed KEK is **not** a drop-in, and it is not built: `Kek.platformKey` is synchronous and derives the platform keys (MFA secrets, stored webhook payloads) from the raw key bytes (`apps/api/src/crypto/kek.ts`), so a KMS adapter that wraps and unwraps tenant keys remotely still needs a separately protected platform root. §12 (H5) is the runbook step; it needs a cloud account and a design change first.

## 10. Launch checklist

- [ ] Release step green. `/api/ready` 200 behind the load balancer. TLS on the public origin.
- [ ] `db:preflight` green (`--owner --app`, §3). The database connection is `DATABASE_SSL_MODE=verify-full` (the start-up line shows `databaseTls.mode`). On the app VM, `/run/realty/owner.env` was removed after the release step (§12).
- [ ] Every live switch is off: `TELEPHONY_LIVE_REQUESTS=false`, `MLS_LIVE_CALLS=false`, `ALLOW_FAKE_PROVIDERS=false`, `AI_ISA_LIVE_SENDS=false` (D12 proposed) and `PUBLIC_RECORDS_LIVE_CALLS=false` (D10) (and any later lane's enable switch), each until its own owner decision.
- [ ] `DATABASE_URL` is the app role. The owner credentials are only in the release job's environment (with the compose stack: in `.env.owner`, never `.env.production`; `docker compose -f docker-compose.prod.yml --env-file .env.owner exec -T api printenv MIGRATION_DATABASE_URL` prints nothing and exits 1).
- [ ] Twilio: master account upgraded; the first team's brand and campaign approved; a live test text, reply, STOP and HELP; a click-to-call with the announcement and the recording kept; a call to a one-party state if you use that mode (**VERIFY WITH COUNSEL**).
- [ ] Email: SPF, DKIM and DMARC aligned for the platform and team domains; a test marketing email unsubscribed with the mail client's own button; a reply lands in the thread; a hard bounce to a test address shows as a suppression.
- [ ] Storage: private bucket; a recording plays back.
- [ ] Backups configured, and one restore drill done and timed.
- [ ] Logs collected; metrics scraped; the alerts of `docs/OPERATIONS.md` §3 routed to a pager; `pnpm ops:synthetic` scheduled every 5 minutes with a dedicated check user (OPERATIONS §6).
- [ ] Counsel items in ARCHITECTURE §19 reviewed for the launch states. Counsel reviews of platform clearance packs are recorded on the deployment with the owner command of §10.1 (dry run first, then `--apply`), each pinned to the version counsel reviewed, and withdrawn with its `--revoke`; never by hand.
- [ ] Phase 2, Gmail inbox sync (owner decision D2): ships dark. `platform:gmail` stays uncleared until it has both `reviewed_by_counsel_at` (counsel item C14, recorded with §10.1; owner decision D11 reports it cleared) and `rules.vendor_ready_at` (which §10.1 never sets), that is until Google's verification of the restricted `gmail.readonly` scope plus its security assessment (N19, **VERIFY** current requirements and renewal) have passed; the Google OAuth client requests that scope only. Until then no tenant can turn sync on (DB). Rollout precondition (pack notes, R-GMAIL-12): set `vendor_ready_at` only after module 22 has written `messages.rfc_message_id_sha256` on platform email for at least 90 days (the largest backfill window), or after its one-time repair; the database refuses a Gmail duplicate only of platform email that carries the hash.
- [ ] MLS: `MLS_LIVE_CALLS=false` unless every step of §11 "Before any live call" is done and signed off.
- [ ] CMA (owner decision D9): `platform:cma` stays unreviewed unless the owner attests counsel cleared the in-house CMA wording (record it with §10.1); V1 shares nothing with clients either way. Each MLS connection's valuation section is the Owner's or Admin's entry on the MLS admin page (Valuation use), from the MLS agreement, which the MLS should confirm in writing (**VERIFY WITH MLS**, V1).
- [ ] Telephony: `TELEPHONY_LIVE_REQUESTS=false` until the written pilot approval (§5.1). The start-up log of the API and the worker shows its value.
- [ ] County public records (owner decision D10): `PUBLIC_RECORDS_LIVE_CALLS=false` unless every step of "Before any live county call" below is done and signed off.

  **Before any live county call** (each step signed off by the owner; nothing here is done in this build; the numbers in brackets are the D10 brief's verify_items and owner questions):
  1. Confirm with Beaufort County the services root, each layer and field in `apps/api/src/providers/publicRecords/fields.ts` (**VERIFY** every one), how empty values are written, the usage terms, the rate limit and whether automated lookups are allowed at all. In particular [verify 1] `EnerGov/MapServer/1` and its `GisFile_PIN`, `Owner1`, `Owner2` and `MailingAdd` fields: the only local source is OpenAddresses `sources/us/sc/beaufort.json`, and its Nov 5, 2026 bulk edit does not prove the fields survived the county's Oct 12 assessor switch; confirm `maxRecordCount`, query support, rate limits, edit-date metadata and the mailing-address format.
  2. [verify 2] Whether `Addresses/MapServer/0` or the parcel layer carries a site address with city and ZIP (OpenAddresses maps none on the address layer); a site address on the parcel layer would remove the spatial step.
  3. [verify 3] Whether `SwrAddLookUp/MapServer/1` is public, and its sale date, price, `LEGRES` and tax-district fields. The sale step (`useGisfileTable`) stays off until then [owner question 8].
  4. [verify 4] Condos and units: whether units have their own parcels and address points (`UNITNUM`), and how often the county's site address differs from the USPS address.
  5. [verify 5, 6] Confirm the ZIP-to-county table in `packages/core/src/homeowner/counties.ts` against the Census ZCTA-to-county file (which ZIPs are Beaufort, Jasper and shared), and each county link there (**VERIFY**; the Jasper qPublic page is listed by the brief as `http://` and the panel opens https links only).
  6. [verify 7] South Carolina terms: assessed value (4% or 6% of market value) against the county's market value, the panel's labels (`apps/web/src/surfaces/homeowner/copy.ts`), and whether the homestead exemption is on any bulk layer (expected: no).
  7. [verify 8] The rate: the connector keeps its requests at least 1 s apart **per process** (at most 3 per lookup), so the rate multiplies with the number of worker processes. Confirm a polite rate with the county for the worker count you run.
  8. [verify 14] Owner-name formats on the real layer (middle initials, "LAST FIRST & FIRST2", ETAL, JR) against `normalizeOwnerName`'s exact token sets (`packages/core/src/predict/property.ts`): measure the `not_matched` rate on a sample of recognised contacts. Any tolerance is a reviewed module-49 change.
  9. Counsel (**VERIFY WITH COUNSEL**; outreach stays unbuilt whatever `platform:public_records_outreach` says):
     - the retention ceiling (12 months, R-DATA-6, R-HOME-9) and whether to keep owner mailing addresses at all [verify 11];
     - that an internal profile from these records is permitted, under SC Code 30-2-50: internal display on existing contacts, absentee prospecting, vendor data, texts, LLC and out-of-state owners, and whether D11's clearance covered these [verify 9];
     - Beaufort County's GIS distribution policy ("no passing data on to others") inside a multi-tenant CRM [verify 10]; ask the county's Mapping and Applications Department too. Live calls stay off until counsel answers this [owner question 7];
     - showing D9's in-house value to agents on this panel (`valuationEligible`, C6) before the D9 slots are wired [verify 12].
  10. Owner action [verify 13]: email the Jasper County GIS office whether `Parcels/FeatureServer/0` (TaxPIN) holds owner names. Until a reviewed change says otherwise, Jasper stays links only.
  11. Scope [owner question 6]: per-address lookups for recognised contacts only. Never a county download, bulk copy or mirror.
  12. Run the connector against a county test address with `PUBLIC_RECORDS_PROVIDER=county` and `PUBLIC_RECORDS_LIVE_CALLS=false` first: the panel must say live lookups are off and no request may leave (the worker logs `homeowner.refresh pass` with `lookups: 0`).
  13. Only then set `PUBLIC_RECORDS_LIVE_CALLS=true` on that deployment and redeploy; watch the P2 `PUBLIC_RECORDS_SOURCE_FAILING` alert (runbook: `docs/OPERATIONS.md` §4.15). On any failure or doubt set it back to `false` and redeploy before anyone investigates.
- [ ] Owner decision D8 (a person's reply in the website chat is first contact), on a database that already ran batch 6's website chat: before the D8 release, as the owner (§3), list the untouched-lead items a recompute can still reach whose lead someone answered in the chat by the deadline. Before D8 such a reply was no touch, and the new evidence words ("No human call, text, email or chat reply from the agent or a collaborator …") would be untrue for an agent's reply (DATA_MODEL R-ACC-2, D8). Resolve each row the agent or a collaborator answered with a note saying so (R-ACC-3). A database that never served the chat has nothing to check.

  ```sql
  SELECT x.tenant_id, x.dedupe_key, x.owner_user_id FROM exception_items x
   WHERE x.item_type = 'untouched_lead' AND (x.condition_cleared_at IS NULL OR x.due_at > now() - interval '30 days')
     AND EXISTS (SELECT 1 FROM messages m
                  WHERE m.tenant_id = x.tenant_id AND m.contact_id = x.contact_id AND m.channel = 'web_chat'
                    AND m.direction = 'outbound' AND m.initiator = 'human' AND m.dispatched_at <= x.due_at);
  ```

### 10.1 Recording counsel reviews (platform clearance packs, R-INT-6)

Each capability that waits on counsel is gated on its **platform clearance pack**, the published `jurisdiction_packs` row with key `platform:<name>`: `app.platform_cleared` (0018) is true only when that version has `reviewed_by_counsel_at` and, for voice, Gmail and Google Ads, also `rules.vendor_ready_at`. Packs ship unreviewed and the migrations keep it that way; a later pack version ships unreviewed too and turns its capability off again until its own review is recorded. No route, tool or migration writes `reviewed_by_counsel_at`: this owner command is the one writer.

```sh
# a checkout with .env (MIGRATION_DATABASE_URL, the owner role), e.g. a dev or staging host
pnpm --filter @realty/db counsel-review -- --keys platform:<name>@<version>[,platform:<name>@<version>...] \
  --reviewed-on YYYY-MM-DD --reference "<who reported the review and where it is recorded>"        # dry run
# the compose stack: the release service already receives the owner URL from .env.owner
docker compose -f docker-compose.prod.yml --env-file .env.owner run --rm --no-deps release \
  node packages/db/dist/scripts/counsel-review.js --keys ...@... --reviewed-on ... --reference "..."  # dry run
# any other host: the api image, with MIGRATION_DATABASE_URL set for this one-off container only (as in §9)
# the app VM (§12): render owner.env first, run it through the release profile, then remove owner.env
REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml --profile release run --rm release \
  node packages/db/dist/scripts/counsel-review.js --keys ...@... --reviewed-on ... --reference "..."  # dry run
# withdrawing a recorded review (a key counsel did not clear, a wrong date, a review set by hand):
pnpm --filter @realty/db counsel-review -- --revoke --keys platform:<name>@<version> --reference "<why, reported by whom>"   # dry run
```

- **Pinned to the version counsel reviewed.** Every key names its version, `platform:<name>@<version>` (all packs ship at `2026.11.0`), and is recorded only while that version is the **published** one. After a pack bump the old pin is refused (`… is not the published version …: the version counsel reviewed is no longer the published one; <new> needs its own counsel review`), so a command kept in a runbook can never clear a version counsel did not see. A bare key, a key named with two versions, or a pin of a draft or of a version that does not exist is refused too.
- **Dry run by default.** It makes the change inside one transaction to print the outcome, then rolls back. Add `--apply` to commit (`--dry-run` may be given explicitly; giving both is refused). Read the dry run first.
- **Per key** it prints the version, `before:` and `after:` (`reviewed by counsel on <date>` or `not reviewed by counsel`; `cleared`, `not cleared`, or `not cleared: still waits for the vendor check`), then a summary: `dry run: <n> would be recorded…`, `applied: <n> recorded, <m> already recorded` or `nothing to change` (with `--revoke`: `withdrawn` and `not reviewed by counsel`). Exit 0 on success, 1 on any refusal or failure.
- **What it writes,** for each pinned published version only (drafts and retired versions are untouched): `reviewed_by_counsel_at` = 00:00 UTC of `--reviewed-on`, and one note appended to `notes`: `Counsel review recorded <UTC time> by database role <role>: version <version> reviewed on <date>; source: <reference>.` (voice, Gmail and Google Ads add that the vendor check is separate and was not recorded). It never writes `rules`, so it never sets or changes `vendor_ready_at`: Gmail still waits for Google's verification of the restricted scope and its security assessment (and the R-GMAIL-12 rollout precondition, §10), voice for a real vendor's latency check (N12), Google Ads for a real adapter's check against the team's account (module 52, R-ADS-7, N14). Those are separate steps.
- **Idempotent, and only for its own record.** A pack already recorded with the same date is reported `unchanged` and gets no second note, but only when its review is this command's own: 00:00 UTC, with this command's note for that version and date as the last review note. A review set any other way (by hand, a test, a restored backup) is refused and named (`… but no note from this command recording that review: it was set outside this command …`), never reported as recorded: it needs the owner's attention; if counsel did review that version, withdraw it with `--revoke` and record it again.
- **Withdrawing (`--revoke`).** The same safeguards (owner role, pinned published version, dry run by default, all or nothing). It sets `reviewed_by_counsel_at` back to NULL, so the capability is held back again from the next statement on, and appends `Counsel review withdrawn <UTC time> by database role <role>: version <version>, recorded as reviewed on <date>; source: <reference>.` A pack that is not reviewed is reported `unchanged` (nothing to withdraw). It takes no `--reviewed-on`, never writes `rules`, and may also withdraw `platform:meta`. This is the supported correction for a key included by mistake or a wrong date: withdraw, then record the right date.
- **All or nothing.** It refuses, changes nothing and exits 1 on: a key that is not `platform:<name>` (jurisdiction packs such as `US` are not recorded here) or not pinned as above; an unknown key, or one with no published version; `platform:meta` when recording (owner decision D2: never cleared); a pack already recorded with a **different** date (it never rewrites a recorded review: `--revoke` first) or recorded outside this command (above); a missing `--keys`, `--reviewed-on` or `--reference`; a malformed date, one before 2026-01-01 (before any platform pack), one before the month a pinned `YYYY.MM.N` version is named for, or one after today, UTC, on the client's clock and on the database's; a reference that is not one line of plain text (no control, format such as bidi overrides or zero-width characters, or line-separator characters; at most 300 characters) or that contains the command's own note text; `--apply` together with `--dry-run`, or a flag given twice; an unknown option; and a database role that is not the owner (below). Review dates are UTC calendar dates.
- **Owner role only.** It connects with `MIGRATION_DATABASE_URL`. `app_user` has SELECT on `jurisdiction_packs` and nothing else, and the table forces row-level security with a read policy only, so the command refuses (in a dry run too) any role that cannot update the table or is neither superuser nor `BYPASSRLS`. Never give the owner URL to the api or worker for this (§3).
- **Audit trail.** There is no platform-level audit table (`audit_log` is per tenant), so the record is the pack itself: `reviewed_by_counsel_at` and the appended notes, which the platform reads (`app_user` has SELECT; the Integrations page says per pack `cleared by counsel on <date>` or that it still waits for the vendor check), plus the command's printed output. **Keep the `--apply` output with the deploy log.**
- **Effect.** Once applied, that deployment stops holding the capability back on that pack from the next statement on (the gates read the pack each time; no restart). It turns nothing on by itself: each capability still needs its own switch, connection or vendor. The pilot is a separate approval: on a deployment real teams use, run `--apply` only once the pilot is approved.

**Owner decision D11 (2026-11-12).** The owner reported that counsel cleared nine items. Seven have a pack, all at version `2026.11.0`, and are recorded with one command (dry run, read it, then the same command with `--apply`). The pins keep this command from clearing any later version of these packs:

```sh
# the app VM (§12, real teams): render /run/realty/owner.env for this window, run it through the release profile, then remove owner.env
REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml --profile release run --rm release \
  node packages/db/dist/scripts/counsel-review.js \
  --keys platform:fair_housing@2026.11.0,platform:coaching@2026.11.0,platform:gmail@2026.11.0,platform:voice@2026.11.0,platform:avm@2026.11.0,platform:review_requests@2026.11.0,platform:portal@2026.11.0 \
  --reviewed-on 2026-11-12 --reference "counsel review reported by the owner, 2026-11-12 (owner decision D11)"
# the single-VM staging and rehearsal stack only (docker-compose.prod.yml, .env.owner)
docker compose -f docker-compose.prod.yml --env-file .env.owner run --rm --no-deps release \
  node packages/db/dist/scripts/counsel-review.js \
  --keys platform:fair_housing@2026.11.0,platform:coaching@2026.11.0,platform:gmail@2026.11.0,platform:voice@2026.11.0,platform:avm@2026.11.0,platform:review_requests@2026.11.0,platform:portal@2026.11.0 \
  --reviewed-on 2026-11-12 --reference "counsel review reported by the owner, 2026-11-12 (owner decision D11)"
```

| D11 item | Pack | After `--apply` |
|---|---|---|
| Publishing marketing (the fair-housing wording check) | `platform:fair_housing` | cleared |
| Reviewing calls for coaching | `platform:coaching` | cleared |
| Gmail sync | `platform:gmail` | not cleared: still waits for Google's verification (`vendor_ready_at`) |
| AI voice answering | `platform:voice` | not cleared: still waits for a real vendor's latency check (`vendor_ready_at`) |
| Home-value notes to past clients | `platform:avm` | cleared |
| Review requests | `platform:review_requests` | cleared |
| The client portal | `platform:portal` | cleared (module 45: sign-in by email also needs `EMAIL_PROVIDER=smtp`, by text `TELEPHONY_PROVIDER=twilio` and `TELEPHONY_LIVE_REQUESTS=true`; otherwise that channel answers 503 `PORTAL_NOT_AVAILABLE {channel}`, and a fake provider never carries a link outside tests. No new environment variable. The web image's nginx redacts `/api/portal/files/<token>` and `/api/portal/documents/<item id>` in its access log) |
| The likely-to-move models (C4) | none | not recorded here: each `prediction_models` version still needs `counsel_reviewed_at` and the platform back-test at its own approval |
| Using public-record personal information for outreach (South Carolina privacy law) | `platform:public_records_outreach` | not recorded by the seven-key command: recorded only by its own command below (owner question 1). It gates nothing in this build (no outreach path exists); the homeowner panel shows whether it is recorded |

The D10 outreach clearance is recorded on its own command, never in the seven-key D11 command, and only after the owner confirms that counsel's review covered the brief's verify_items 9 (SC Code 30-2-50: internal display on existing contacts, absentee prospecting, vendor data, texts, LLC and out-of-state owners) and 10 (Beaufort County's GIS distribution policy inside a multi-tenant CRM) (owner question 1; batch 11 reconciliation homeowner-8). The owner's D11 attestation (PHASE2_3_PLAN D11) names this item; if counsel's review covered both questions, its date and reference are the ones to record, otherwise wait for the review that does. Fill in the placeholders from that review (dry run first, then `--apply`):

```sh
# the app VM (§12, real teams): render /run/realty/owner.env for this window, run it through the release profile, then remove owner.env
REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml --profile release run --rm release \
  node packages/db/dist/scripts/counsel-review.js \
  --keys platform:public_records_outreach@2026.11.0 \
  --reviewed-on <review date, YYYY-MM-DD> --reference "<counsel reference: the review that covered verify_items 9 and 10>"
# the single-VM staging and rehearsal stack only (docker-compose.prod.yml, .env.owner)
docker compose -f docker-compose.prod.yml --env-file .env.owner run --rm --no-deps release \
  node packages/db/dist/scripts/counsel-review.js \
  --keys platform:public_records_outreach@2026.11.0 \
  --reviewed-on <review date, YYYY-MM-DD> --reference "<counsel reference: the review that covered verify_items 9 and 10>"
```

Recording it builds nothing: the pack gates no outreach path, and the homeowner panel then says "counsel clearance recorded on <date>" for that deployment.

`platform:ads` (Google Ads budget changes and pauses, module 52) is **not** part of D11. It stays dark on every deployment until counsel review is recorded for it (the counsel-review command, per deployment) **and** a separate platform step sets `rules.vendor_ready_at` once a real Google Ads adapter has passed its check against the team's account at the deployment's API access level (**VERIFY**, N14). Until both are set, spend is still read and shown, nothing changes money, and at the monthly cap the reconcile only alerts every Owner and Admin to pause the campaigns in Google Ads (no automatic pause while dark). The D11 command is unchanged and never names `platform:ads`. What counsel must cover before clearing it is the ads item of PHASE2_3_PLAN C3 (**VERIFY WITH COUNSEL**: Google Ads housing rules and radius limits, the disparate-impact risk of shifting budget by cost per agreement, the cap attestation and overspend copy, auto-pausing at the cap with unmanaged campaigns included, ranking by `gads:` attribution, and what clearing must cover before `vendor_ready_at`).

`platform:gbp` (Google Business Profile, module 53) is **not** covered by D11: never add it to the command above. Record it only after its own counsel review (PHASE2_3_PLAN §7 C15), pinned to the version counsel reviewed, with the same dry run and `--apply`.

Rehearsed against throwaway test databases only (the pinned D11 command through the package script: dry run, `--apply`, a re-run that reported `nothing to change: 7 already recorded`, and after a fair-housing pack bump the same command refused); neither the app-VM form nor the compose form above has been run against a stack.

**D9: `platform:cma` and the licence pack's valuation section (batch 10).** Owner decision D9 adds a CMA built in-house from the team's own MLS sold data (an estimate, never an appraisal; never a third-party AVM). Two separate records hold it back, and neither is turned on by this release:

- **`platform:cma@2026.11.0`** ships unreviewed (`0061_cma_schema.sql`). It is not a D11 pack, so the D11 command above never includes it. Record it with this same command, and only on the owner's attestation that counsel cleared the in-house CMA wording (C6 extended: client CMA wording, the "not an appraisal" placement, the state statements V4, USPAP SoP 11-1 V5/V7). Dry run first:

  ```sh
  # the app VM (§12, real teams): render /run/realty/owner.env for this window, run it through the release profile, then remove owner.env
  REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml --profile release run --rm release \
    node packages/db/dist/scripts/counsel-review.js --keys platform:cma@2026.11.0 \
    --reviewed-on YYYY-MM-DD --reference "<the owner's attestation of counsel's clearance of the in-house CMA wording, and where it is recorded>"
  # the single-VM staging and rehearsal stack only (docker-compose.prod.yml, .env.owner)
  docker compose -f docker-compose.prod.yml --env-file .env.owner run --rm --no-deps release \
    node packages/db/dist/scripts/counsel-review.js --keys platform:cma@2026.11.0 \
    --reviewed-on YYYY-MM-DD --reference "<the owner's attestation of counsel's clearance of the in-house CMA wording, and where it is recorded>"
  ```

  **Effect in V1: none for clients.** Client CMAs and seller-update value ranges are not built (V2), so nothing built from MLS sales reaches a client either way. Once recorded, a CMA's readiness view stops listing PLATFORM_NOT_CLEARED and the Integrations page says "counsel reviewed the pack on <date>", still beside "not built in this version". A later pack version ships unreviewed and needs its own record.
- **The valuation section** of each MLS connection's licence pack is **not** recorded by this command. An Owner or Admin enters it on the MLS admin page, under "Valuation use" (re-auth), from the MLS agreement: `agent_cma`, `client_cma`, `automated_notes`, the AVM flag scope and the per-state statements, each with its own counsel mark; the section's stamp (`valuation.reviewed_by_counsel_at`) is set only when every valuation value is marked, and saving it never changes the display pack's stamp. Agent CMAs need only `agent_cma` (the Owner's statement from the agreement; **VERIFY WITH MLS**, V1); a pack without the section refuses every agent CMA in words (E371). Strictest defaults: nothing allowed, the seller's "no automated valuation" choice holds for every client output, no statement.
- **`MLS_LIVE_CALLS` stays `false`** for this release, in every environment. With it false a Spark deployment reads nothing from the MLS (no request is made and the key is not decrypted), so no sold history is stored, `GET /admin/mls` says "Live MLS calls are turned off on this deployment, so no sold history is read from the MLS.", and an agent CMA has no sold sales to compare (it is refused in words, or finds none). Turning it on is §11's separate, signed-off procedure, not part of D9.

Nothing here is a compliance claim: every value above is **VERIFY WITH COUNSEL** / **VERIFY WITH MLS** until counsel and the MLS answer in writing. Not rehearsed against a compose stack.

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

### AI ISA live sends (`AI_ISA_LIVE_SENDS`; D12 PROPOSED, R-ISA-25)

`AI_ISA_LIVE_SENDS` defaults to `false` in every environment, production included; only the exact string `true` turns it on, and the API and worker log it at start-up. While it is `false`, an AI ISA message on a non-fake SMS or email adapter is refused in dispatch TX1 before the provider call ("AI assistant sending is off on this deployment"), and the AI ISA treats it as a hold (no pause, no per-lead card, it continues when the switch clears). TELEPHONY_LIVE_REQUESTS still applies to every text. It stays false until a written pilot approval. The packs `platform:ai_isa` and `platform:ai_isa_seller_data` ship unreviewed; the counsel-review command (§10.1) records a review only once counsel has reviewed them. They are not covered by D11 (D12 is PROPOSED): never add them to the D11 command. `platform:ai_isa_seller_data` gates the assistant's recent-sales emails, which are not built in this version (ISA-3), so its line on the Integrations page says so whether or not a review is recorded (b12 review ui-2). Nothing in this lane configures a provider, a model key or a webhook.

## 12. Pilot hosting, option A (app VM + Postgres 16 on its own host)

The shape for the first real teams. Two machines on one private network: the **app VM** runs `docker-compose.app-vm.yml` (api, worker, web, the one-off `release` profile, and the optional `edge` profile); the **database host** runs Postgres 16 with at least 4 dedicated cores (§3 "Database host"). Every database connection is verified TLS. Nothing in this repository provisions, configures or contacts a provider; every vendor fact below is **VERIFY**.

**Owner defaults until decided** (the owner questions of the pilot-deploy brief):

- **Database:** our own Postgres 16 VM beside the app VM (a real superuser owner: the release path that has always run). A managed service only if `preflight --trial` passes on a throwaway instance at G1 (its admin role is then the non-superuser owner of §3). Running our own means carrying PITR (H4).
- **TLS edge:** the repository's `edge` profile with operator-issued certificates (HSTS, no logging). A provider load balancer only if it can send HSTS and keep paths and query strings out of its logs (**VERIFY**).
- **HSTS:** `max-age=31536000`, no `includeSubDomains` and no `preload` until the domain is chosen (preload is hard to undo).
- **Staging:** keeps its compose database without TLS, only with `ALLOW_FAKE_PROVIDERS=true` (`DATABASE_SSL_MODE=disable`). Real teams always use verify-full.
- **Secret values:** a value with `$`, a quote, a space, `#`, a backslash or a newline is refused (E487); rotate it to a value in the safe charset, because compose and `docker run` quote differently.
- **Owner commands:** the release step, counsel-review and KEK rotation run on the app VM through the `release` profile, with the owner secret rendered only for that window and removed afterwards. A separate admin host can come later.
- **Hosting, secrets, region:** option A; the provider's secret manager, rendered into root-only files at deploy time, with the owner secret in its own scope; one US region near the team, database and bucket together (**VERIFY WITH COUNSEL**: region and DPA).

Live switches stay **off** throughout: `TELEPHONY_LIVE_REQUESTS=false`, `MLS_LIVE_CALLS=false`, `ALLOW_FAKE_PROVIDERS=false`, `AI_ISA_LIVE_SENDS=false` and `PUBLIC_RECORDS_LIVE_CALLS=false` (`deploy/app-vm/app.settings.example` and `deploy/env.production.example`; `apps/api/src/deploy.appvm.test.ts` and `deploy.env.test.ts` assert them). Each stays off until its own owner decision.

### 12.1 Gates

- **G1, the trial:** the owner approves a throwaway database; `preflight --trial` runs on it; the database is deleted.
- **G2, the first provisioning,** with no real team data: provision, render, release, up, and the checks of 12.3, including a timed restore drill.
- **G3, the first real team's data** (an owner gate): G2's checks are green, a restore drill has been timed, and the counsel items the pilot needs are recorded with counsel-review on that deployment (§10.1). Every live switch stays off until its own owner decision.

### 12.2 G1: preflight --trial on a throwaway database

From any checkout, with only that database's owner URL set (no query string), and the provider's CA to check TLS too:

```sh
MIGRATION_DATABASE_URL='postgres://<admin-role>:<password>@<db-host>:5432/<scratch-db>' \
DATABASE_SSL_MODE=verify-full DATABASE_SSL_CA_FILE=/path/to/db-ca.pem \
  pnpm db:preflight -- --trial
```

In one rolled-back transaction it creates `realty_probe_<random>` `NOLOGIN BYPASSRLS`, grants it to the owner `WITH INHERIT, SET`, creates schema `realty_probe_<random>` with `CREATE` for it, creates a `SECURITY DEFINER` function and moves its owner to the role, runs the FORCE-RLS update probe on a TEMP table and `CREATE EXTENSION IF NOT EXISTS` for `pgcrypto`, `pg_trgm` and `citext`; it also reports `CREATE` on the database and `server_version_num >= 160000`. It commits nothing (its test compares `pg_roles`, `pg_namespace` and `pg_default_acl` before and after). Any `failed` line rules the candidate out as configured, or names the grant to ask for. Then delete the database.

### 12.3 G2: provision, render, release, up, check

1. **Database host.** Postgres 16 on a private address only, from `deploy/db-host/postgresql.realty.conf.example` (`listen_addresses` = the private address, `ssl = on`, `ssl_min_protocol_version = 'TLSv1.2'`, `password_encryption = scram-sha-256`) and `deploy/db-host/pg_hba.conf.example` (`hostssl … scram-sha-256` from the app VM's address only; no `host` and no `trust` line). The server certificate names the database's private DNS name and chains to our own CA. Create the owner role and an empty database `realty` it owns. (A managed instance instead: its admin role and its CA bundle, once G1 passed.)
2. **Secrets** (an owner action): the owner creates them in the provider's secret manager. The app role's URL (`postgres://app_user:<password>@<db-host>:5432/realty`, no query string), the owner's URL, `KEK_BASE64`, `SESSION_SECRET_BASE64`, each webhook secret (all different), and the vendor keys of `deploy/app-vm/app.secrets.refs.example`. Values use only `A-Z a-z 0-9 + / = : . _ @ % , ~ -` (E487): `openssl rand -base64 32` for keys, `openssl rand -hex 32` for secrets, percent-encoding inside a URL.
3. **App VM files** (root-owned, never in the repository): `/etc/realty/db-ca.pem` (public, 0644); `/etc/realty/app.settings` from `deploy/app-vm/app.settings.example`; `/etc/realty/app.secrets.refs` and `/etc/realty/owner.secrets.refs` from the two `*.refs.example` files (one `NAME=<reference>` per line, `[A-Za-z0-9/_.:@-]+`); and `install -d -m 700 /run/realty`.
4. **Render.** `SECRET_FETCH_CMD` is a command the operator supplies that prints one secret's value for the reference given as its single argument (the secret manager's CLI; **VERIFY** its flags, per-secret access and audit log; its stderr is discarded):

   ```sh
   export SECRET_FETCH_CMD='<your-secret-cli> <read-one-secret-by-reference>'
   sh deploy/render-secrets.sh /etc/realty/app.settings /etc/realty/app.secrets.refs /run/realty/app.env
   sh deploy/render-secrets.sh - /etc/realty/owner.secrets.refs /run/realty/owner.env
   ```

   Each file is 0600, written through a temp file in the same directory; refusals name the variable and the reference, never a value (R-DEPLOY-7).
5. **Release:** `REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml --profile release run --rm release`. It must end `release ok: app connects as app_user, RLS-bound`. Keep the output with the deploy log.
6. **Remove the owner file:** `rm /run/realty/owner.env`. Only the release profile reads it (R-DEPLOY-6); api and worker refuse to start with an owner credential.
7. **Up:** `REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml up -d`, with `--profile edge` for the TLS edge (certificates at `/etc/realty/tls/fullchain.pem` and `privkey.pem`; `deploy/edge/edge.conf` with the real host in place of `app.example.com`; 444 for every other name, HSTS, `X-Forwarded-For` replaced, no logs). Without the edge, `web` listens on `127.0.0.1:8080` (`WEB_BIND_ADDRESS`, `WEB_PORT`).
8. **Checks:** release ok; `preflight --app` green (`REALTY_VERSION=<version> docker compose -f docker-compose.app-vm.yml run --rm --no-deps api node packages/db/dist/scripts/preflight.js --app`: the api service, so the app env only); `/api/ready` 200 through the public origin; the start-up lines show `databaseTls.mode: verify-full` and `telephonyLiveRequests: false`; `exec -T api printenv MIGRATION_DATABASE_URL` prints nothing and exits 1; the synthetic check (`pnpm ops:synthetic`, OPERATIONS §6); log redaction (no capability path secret, query string or PII in the web access log or the API logs); a restore drill (§8), timed.

**Every deploy:** a restore point, then render (step 4), release, remove `owner.env`, `up -d` with the new `REALTY_VERSION`. Rollback follows §3. `/run` is a tmpfs: after a reboot the containers restart from their stored configuration, but any `up` needs a render first.

**Counsel reviews are an owner action per deployment, never a deploy step** (§10.1): render `owner.env`, run the dry run through the release profile, read it, run the same command with `--apply`, remove `owner.env`. The D11 keys and pins are unchanged.

### 12.4 H4: backups and PITR (runbook steps; no tooling is configured here)

- [ ] PITR of at least **35 days**, with encrypted backups in another region or account (**VERIFY WITH COUNSEL**: the region). A self-run database: WAL archiving and base backups with a tool the operator chooses (`archive_mode`, `archive_command` or `archive_library`, `wal_level`; **VERIFY** in the tool's documentation, with its retention window and the restore time on real data).
- [ ] A restore rehearsal before G3, then quarterly (§8), timed.
- [ ] An offline copy of the KEK, kept apart from the backups, with named custodians (**VERIFY WITH COUNSEL**: who holds it). A backup without the KEK cannot be decrypted.
- [ ] The object bucket: versioning plus replication or a nightly copy (§7).
- [ ] Erased contacts persist in PITR backups for the 35-day window (**VERIFY WITH COUNSEL**; ARCHITECTURE §8).

### 12.5 H5: option C only, for later code lanes (no code here)

- [ ] A KMS-backed `Kek`: wrap and unwrap become KMS calls, and `platformKey`, which is synchronous and derives platform keys from raw key bytes (`apps/api/src/crypto/kek.ts`), needs a KMS-wrapped platform root unwrapped at start (§9).
- [ ] Storage role credentials instead of the S3 static keys (`providers/s3/s3.ts`). Until then scope the static keys to the bucket (§7) and rotate them on a schedule.

### 12.6 VERIFY register for this hosting option

Engineering (the lane's tests re-run what they can; the rest run on the G1 trial database). Nothing here has been read on a vendor page:

- the non-superuser path on the chosen provider, by `preflight --trial` at G1: the admin role's attributes; whether `ALTER DEFAULT PRIVILEGES … ON SCHEMAS` is allowed; whether console-created roles give the owner ADMIN; CREATE on the database; that `pgcrypto`, `pg_trgm` and `citext` can be created (unverified search results suggest some managed services withhold CREATEROLE or BYPASSRLS);
- whether the provider needs connection parameters in the URL (routing or SNI): E484 refuses them, so such a provider needs a code change first;
- the TEMP-table probe and the trial probe on the provider's PG16 build (verified on vanilla 16.15 only);
- `docker run --env-file` not stripping quotes (the reason for the charset rule); compose on the VM's version (verified on v5.6.1, `config` only);
- verify-full with the provider's CA bundle: its format, the database host name in the SAN, and whether Node's default store suffices; for a self-run database VM, our own CA and a certificate naming its private DNS name;
- the secret manager's CLI for `SECRET_FETCH_CMD`: per-secret access and an audit log;
- the PITR tooling, its retention window, and the restore time on real data;
- certificate renewal for the edge (ACME or provider-issued) without logging request URLs;
- whether the provider load balancer's logs record capability paths or query strings;
- worker egress denying private ranges on the VM firewall (SECURITY §3, the DNS-rebinding row).

**VERIFY WITH COUNSEL:** the region and DPA for the database, the bucket and the backups; erased contacts persisting in PITR backups for 35 days; who holds the offline KEK copy.

**Owner and vendor actions** (this repository does none of them): choose the provider and approve a G1 trial database; create the secrets (G2); choose the domain and the TLS edge; keep the hosting cloud project separate from the Google Ads account's project; decide when G3 is reached.

Out of scope here: provisioning, IaC for options B and C, DNS or MX records, a malware scanner (N11), log shipping, load-balancer configuration, `*_FILE` secret variables, `/api/ready` changes. `docker-compose.prod.yml` keeps its in-stack Postgres for staging and rehearsals (docs/STAGING.md).
