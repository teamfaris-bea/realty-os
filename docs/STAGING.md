# Realty OS: a single-VM staging environment (fake providers)

This recipe stands up one staging environment on one Linux VM with Docker, using the deterministic fakes for
every vendor: nothing is texted, called, emailed, pushed, fetched from an MLS or imported from Follow Up Boss.
Every command below was run in the deploy rehearsal of 2026-11-11 (docs/DEPLOY.md, `lane/deploy-rehearsal`),
with the times it took there.

It is host-agnostic: any VM or bare-metal machine that runs Docker Engine with the compose plugin will do.
Three things are the **owner's choice** and are left open here: the host, the secret manager, and the domain.
Where the recipe needs them, it says `<staging-host>` and "your secret manager".

Staging is not production. Production differs in three ways that this recipe deliberately does not cover:
real vendors (DEPLOY §5–§7), a managed or separate Postgres on its own host with at least 4 dedicated cores
(owner decision of 2026-11-11, DEPLOY §3), and a TLS-terminating load balancer you operate.

---

## 1. What you need

| Item | Notes |
|---|---|
| A Linux VM | 4 vCPU, 8 GB RAM and 20 GB disk were plenty for the rehearsal (images: api 442 MB, web 78 MB). Staging may run Postgres on the same VM; its timings then say nothing about production. |
| Docker Engine and the compose plugin | `docker compose version` must work. Rehearsed with Docker 29.9. |
| `git`, `openssl`, `curl` | on the VM |
| A DNS name for `<staging-host>` | owner's choice; point it at the VM (or at your TLS proxy) |
| TLS on `https://<staging-host>` | **required**, not optional: the session cookie is `__Host-sid` with `Secure`, so a browser over plain http cannot sign in. Terminate TLS in front of the `web` container (port 8080 inside, `WEB_PORT` on the VM) with whatever proxy you choose, and add HSTS there. |
| Your secret manager | owner's choice. It holds the filled env file (§3), above all `KEK_BASE64`. |

## 2. Get the code and build the images

```sh
git clone <repository-url> realty-os && cd realty-os
git checkout <release-commit>
docker build --target api -t realty-api:latest .
docker build --target web -t realty-web:latest .
```

The first build took 71 s for `api` and a few seconds for `web` on a cache that already held the base images;
a rebuild after a code change took 31–51 s. Behind a TLS-intercepting proxy, add
`--secret id=ca,src=/path/to/ca.pem` (and, if the build container needs the proxy, `--network=host
--build-arg HTTPS_PROXY=$HTTPS_PROXY`).

## 3. The environment file

The template is `deploy/env.staging.example`: production mode, every vendor fake, `ALLOW_FAKE_PROVIDERS=true`,
`MLS_LIVE_CALLS=false`, local encrypted storage on a volume, metrics with a token. It holds no secret and no real
host. The database owner's credentials are a second file, from `deploy/env.owner.example`: only the postgres
service and the release step receive them (DEPLOY §3), never the API or the worker, which refuse to start with
one in their environment. Fill both once:

```sh
umask 077
sh deploy/fill-staging-env.sh <staging-host> postgres > .env.production
sh deploy/fill-staging-env.sh <staging-host> postgres owner > .env.owner
git check-ignore .env.production .env.owner   # must print both: never commit them
```

`fill-staging-env.sh` generates every key and secret with `openssl` (two different 32-byte keys, a different
secret per webhook, the app role's and the owner's database passwords and the metrics token) and fills the
placeholders; the two files share no secret. `postgres` is the database host inside the compose network. Then:

1. Store both files in your secret manager now. `KEK_BASE64` cannot be regenerated: anything encrypted under
   it is unreadable without it (DEPLOY §8). Staging gets its **own** keys, never production's.
2. Keep the files only where compose reads them (`.env.production` and `.env.owner` next to
   `docker-compose.prod.yml`, mode 600), or render them from the secret manager at deploy time.

What the template sets, and why each line matters (all rehearsed):

| Setting | Why |
|---|---|
| `NODE_ENV=production` + `ALLOW_FAKE_PROVIDERS=true` | production checks stay on (https origins, Secure cookie, KEK_REF, distinct secrets) while the fakes are allowed explicitly. Without the flag the API and the worker refuse to start. |
| `TELEPHONY_WEBHOOK_SECRET`, `EMAIL_WEBHOOK_SECRET` | required in production with the fake telephony and with no vendor email format; missing, both processes refuse to start |
| `KEK_REF=staging-kek:v1` | required in production; it is stamped on every wrapped key (rotation, §6) |
| `STORAGE_DIR=/var/lib/realty/storage` | the path the compose file mounts the `storage` volume at, writable by the image's `node` user. Any other path: `/api/ready` says `degraded`, `storage: failed`. |
| `DATABASE_URL` user `app_user` | mandatory: the migrations grant to that role, and the release step refuses any other name |
| `METRICS_HOST=0.0.0.0`, `METRICS_PORT`, `METRICS_TOKEN` | metrics on their own port inside each container, bearer token required |
| `FUB_PROVIDER=fake`, `MLS_PROVIDER=fake`, `MLS_LIVE_CALLS=false` | no import or MLS traffic leaves the VM |

## 4. Start it

Every compose command needs `--env-file .env.owner` (the compose file reads the owner's credentials from it, for
the postgres service and the release step only; `WEB_PORT` comes from the shell):

```sh
export WEB_PORT=8080        # the VM port your TLS proxy forwards to
DC="docker compose -f docker-compose.prod.yml --env-file .env.owner"
$DC up -d --no-build
$DC logs release | grep -E 'migrations:|release ok'
curl -s http://127.0.0.1:$WEB_PORT/api/ready
```

Order: Postgres healthy → release (migrations as the owner, aligns `app_user`) → API and worker → web. In the
rehearsal it was ready 15–16 s after `up`. Expect:

```
release-1  | migrations: 35 applied, 0 already applied
release-1  | release ok: app connects as app_user, RLS-bound
{"status":"ready","checks":{"database":"ok","storage":"ok","providers":"ok"}}
```

Check the web server once (rehearsed):

```sh
$DC exec -T web nginx -t
curl -sI http://127.0.0.1:$WEB_PORT/ | grep -iE 'content-security-policy|x-frame-options|cache-control'
```

The page, assets and SPA fallback carry the strict CSP with `frame-ancestors 'none'`, nosniff, Referrer-Policy,
Permissions-Policy, COOP, CORP and `X-Frame-Options: DENY`; `/api/` responses carry only the API's own headers.
No `.map` file is served.

**Redeploy** (a new commit): rebuild both images (§2), then `$DC up -d --no-build`. The release step runs again
first (`0 applied` when nothing is new). nginx re-resolves the API's address, so recreating `api` alone is fine.

**Stop:** `$DC stop api worker` drains: `/api/ready` turns 503, the API keeps serving 5 s, then exits 0 (5.4 s in
the rehearsal); the worker finishes in-flight jobs and exits 0.

## 5. Demo data and the check user (optional)

The demo tenant of the README, with its published password, is allowed here only because the env file sets
`ALLOW_FAKE_PROVIDERS=true`: the seed refuses a production deployment without that flag. It writes the Owner's
TOTP secret to `/app/.demo/credentials.json`, which is read-only in the image, so mount a directory for it
(the seed refuses before writing anything if it cannot):

```sh
DEMO=$HOME/realty-demo-credentials      # outside the checkout: it will hold the Owner's TOTP secret
mkdir -p "$DEMO" && sudo chown 1000:1000 "$DEMO" && sudo chmod 700 "$DEMO"
$DC run --rm --no-deps --env-from-file .env.owner -v "$DEMO:/app/.demo" api node apps/api/dist/seed/main.js
```

The seed writes through the owner role where no application path exists yet, so this one-off container gets
`.env.owner` explicitly (`--env-from-file`, Compose 2.27 or later); the long-running api and worker never do.

11–14 s. It creates 40 contacts, 7 users and the rest of the README's tour, except its lead-email example: the
env file sets no `LEAD_EMAIL_INBOUND_DOMAIN`, so the seed skips that step (it logs one line saying so). The
tour's Needs review is then empty, and a lead source's Email intake says lead email isn't set up on this server
instead of offering *Turn on lead email*. Its passwords are public: never seed an environment that real
people's data will ever reach. To start over: `$DC down -v` (this deletes the database and the storage volume),
then §4 again.

**Synthetic check** (OPERATIONS §6), from the image and inside the compose network. With the demo data, the
agent Avery and her contact Noah Bennett can stand in for the dedicated check user:

```sh
$DC run --rm --no-deps \
  -e SYNTHETIC_BASE_URL=http://web:8080 -e SYNTHETIC_ORIGIN=https://<staging-host> \
  -e SYNTHETIC_EMAIL=<check-user-email> -e SYNTHETIC_PASSWORD=<check-user-password> \
  -e SYNTHETIC_CONTACT_ID=<test-contact-id> \
  api node apps/api/dist/observability/syntheticMain.js
```

Exit 0 and a final `{"check":"synthetic","ok":true,…}` (581–770 ms in the rehearsal, also with an Owner and
`SYNTHETIC_TOTP_SECRET`). For a real schedule, create the dedicated check user of OPERATIONS §6 and keep its
password in your secret manager.

**Metrics** (OPERATIONS §2): the ports are not published. A scraper on the compose network reaches
`api:9464` and `worker:9464` with `Authorization: Bearer $METRICS_TOKEN`; to look by hand:

```sh
$DC exec -T api node -e "fetch('http://127.0.0.1:9464/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}}).then(r=>console.log(r.status))"
```

Save one body from each process and run `node scripts/ops-alert-metrics.mjs api.txt worker.txt` to check the
alert rules against them.

## 6. Backups, restore drill and key rotation on this VM

**Backup** (DEPLOY §8; 0.46 s and 0.38 s on the demo data):

```sh
$DC exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > realty-$(date +%F).dump
docker run --rm -v realty_storage:/var/lib/realty/storage realty-api:latest \
  tar -czf - -C /var/lib/realty storage > storage-$(date +%F).tgz
```

Encrypt both and keep them off the VM, separately from the env file.

**Restore drill:** into a **new** Postgres instance, `deploy/restore-roles.sql` first, then `pg_restore
--exit-on-error`, then the release step (`0 applied`), then the app with a separate origin; the full procedure,
its checks and the rehearsed times are DEPLOY §8.

**KEK rotation** (DEPLOY §9): stop the API and worker, rotate over the compose network, then put the new key in
the env file and the secret manager and start them again:

```sh
$DC stop api worker
docker run --rm --network realty_default --env-file .env.production --env-file .env.owner \
  -e PREVIOUS_KEK_BASE64="$OLD" -e PREVIOUS_KEK_REF=staging-kek:v1 \
  -e KEK_BASE64="$NEW" -e KEK_REF=staging-kek:v2 \
  realty-api:latest node apps/api/dist/crypto/rotateKekMain.js
# then set KEK_BASE64=$NEW and KEK_REF=staging-kek:v2 in .env.production and the secret manager
$DC up -d --no-build api worker
```

`$OLD` is the current `KEK_BASE64`, `$NEW` the output of `openssl rand -base64 32`; set them in the shell from
the secret manager, never in a file in the repository. Then sign in once **with MFA**: `/api/ready` stays
`ready` even with a wrong KEK, so the MFA sign-in is the real check.

## 7. Before you call it done

- [ ] `/api/ready` 200 `ready` through `https://<staging-host>`, and a browser sign-in works (TLS in place).
- [ ] `.env.production` and `.env.owner` are in the secret manager and not in git (`git status` clean).
- [ ] `$DC exec -T api printenv MIGRATION_DATABASE_URL` prints nothing and exits 1 (the same for `worker`): the
      owner's credentials are only in the postgres and release containers.
- [ ] The release log says `release ok`.
- [ ] The synthetic check exits 0.
- [ ] One backup taken and one restore drill done (DEPLOY §8), with the times written down.
- [ ] `MLS_LIVE_CALLS=false`, `ALLOW_FAKE_PROVIDERS=true` and every `*_PROVIDER` fake: staging never talks to a vendor.

## 8. Known limits of this recipe

- The tooling scripts run with `pnpm` (`pnpm load:smoke`, `pnpm ops:synthetic` from a checkout) also read the
  checkout's development `.env` for any variable you did not set. Pointed at staging, set every variable they
  need (including `TEST_ADMIN_DATABASE_URL` for `load:smoke`), or use the image's `dist` entrypoints as above.
- `/api/ready` reports `degraded`, not 503, when storage fails, so a load balancer keeps routing to it
  (OPERATIONS §4.2 alerts on it instead).
- A fake-provider staging proves the deploy path, config, data and keys; it proves nothing about Twilio, the
  SMTP relay, S3, Spark or Follow Up Boss (DEPLOY §5–§7, §11).
