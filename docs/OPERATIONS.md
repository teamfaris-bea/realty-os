# Realty OS: Operations

How a team running Realty OS in production sees that it is healthy, is told when it is not, and fixes
stuck work without a developer. Deployment itself is in `docs/DEPLOY.md`; the design of what is
measured is in ARCHITECTURE §6 (jobs and timers), §9 (the one outbound path) and §15 (logs, metrics,
alerts). Lane: ops-observability.

Everything here follows the logging rules: **ids, codes and timings only**. Metrics never carry ids,
tenant names or PII; error reports carry scrubbed messages and the request id; the System page never
shows message bodies or addresses.

---

## 1. Service-level objectives

Measured over a rolling 28 days unless stated. "Good" events over "valid" events; every number has its
denominator on the dashboards (`realty_*` metrics, §2).

| SLO | Target | Good / valid | Metric |
|---|---|---|---|
| **New-lead first response** | 95 % of new inquiries get a first outbound message that **left** (sent or delivered) within 60 s | inquiries answered ≤ 60 s / inquiries answered + not answered (an inquiry whose reply was refused by an opt-out is excluded: D1 says no reply is the right outcome) | `realty_first_response_inquiries_window{result}`, `realty_first_response_seconds{quantile}` |
| **Dispatch latency** | 99 % of `comms.dispatch` jobs start within 2 s of being due; p95 job run time < 5 s | realtime pickup lag < 2 s | `realty_queue_lag_seconds{queue="realtime"}`, `realty_job_duration_seconds{kind="comms.dispatch"}` |
| **Dispatch outcome** | 99.5 % of allowed sends are accepted by the provider (blocks are not failures) | `result="sent"` / `sent + failed` | `realty_dispatch_results_window{channel,result,reason}` |
| **Timer accuracy** (the timers that decide lead ownership) | 99 % of offer expiries, first-touch breaches and auto-releases fire ≤ 60 s after they are due; none later than 5 min | late ≤ 60 s / fired | `realty_timer_fired_window`, `realty_timer_late_window`, `realty_timer_lateness_seconds{kind,quantile}` |
| **Inbound webhook processing** | 99.9 % of provider webhooks answered 2xx; p95 < 1 s (ingestion runs in the request: verify, store idempotently, pause automation, hand back) | 2xx / all on `route=~"/api/webhooks/.*"` | `realty_http_requests_total`, `realty_http_request_duration_seconds` |
| **API availability** | 99.9 % of requests not 5xx | non-5xx / all | `realty_http_requests_total{status_class}` |

Notes that keep these honest:

- The first-response window counts an inquiry only once it is at least 60 s old, so a fresh inquiry is
  never a miss before it had its minute. Inquiries from sources where the assistant's speed-to-lead reply
  is turned off still count: if the team turned it off, a person is expected to answer within the minute.
  If that is not the team's promise, set the SLO on `within_60s / (within_60s + over_60s)` instead and
  say so on the dashboard.
- Timer lateness is computed from the ownership ledger (`app.ops_fired_timers`, migration 0019), not
  from job rows: the deadline is the one the ledger recorded (`offered.deadline_at`, the period's
  first-touch due, `payload.releaseDueAt`). A timer that has not fired yet is not in the window; the
  sweeper lateness alert (§3) covers "nothing fires at all".
- Inactivity warnings and releases are not in the timer SLO (their deadlines live on the contact row,
  not in the ledger). The sweeper covers them like every other stored deadline.

---

## 2. Metrics

Both processes serve Prometheus text format on **their own port**, never on the public API port:

| Variable | Meaning |
|---|---|
| `METRICS_PORT` | serve `GET /metrics` here (empty: no listener) |
| `METRICS_HOST` | bind address, default `127.0.0.1`; anything else requires a token |
| `METRICS_TOKEN` | shared secret (≥ 24 characters, required in production); scrapers send `Authorization: Bearer <token>` |
| `RELEASE` | release tag (`realty_build_info{release}` and error reports), e.g. the image's git sha |

Scrape config:

```yaml
scrape_configs:
  - job_name: realty
    scheme: http                      # private network only; the token is still required
    authorization: { credentials_file: /etc/prometheus/realty-metrics-token }
    static_configs:
      - targets: ['api-1:9464', 'api-2:9464', 'worker-1:9465']
```

Every other path on the metrics port is 404. The registry refuses label names outside a fixed list
(`method route status_class code kind queue outcome state channel status result reason quantile bucket
release work_kind item process check severity`), exports any label value that looks like a UUID, an email
address, a long number or free text as `OTHER`, and caps each family at 500 series. Routes are templates
(`/api/contacts/:id`); unmatched paths are one `unmatched` series.

**API** (`process="api"`):

| Metric | Type | Labels |
|---|---|---|
| `realty_http_requests_total` | counter | method, route, status_class |
| `realty_http_request_duration_seconds` | histogram | method, route |
| `realty_http_errors_total` | counter | route, status_class, code (the error code the body carried) |
| `realty_db_pool_connections` / `realty_db_pool_max` | gauge | state (total, idle, in_use, waiting), process |
| `realty_build_info`, `realty_process_uptime_seconds`, `realty_process_resident_memory_bytes`, `realty_process_heap_used_bytes` | gauge | release / process |

**Worker** (`process="worker"`): the pool and process gauges, plus

| Metric | Type | Labels |
|---|---|---|
| `realty_jobs_total` | counter | kind, outcome (succeeded, rescheduled, retry, dead, no_handler, finish_failed, lease_lost) |
| `realty_job_duration_seconds` | histogram | kind |
| `realty_jobs_dead_total` | counter | kind, queue (each alerted dead job) |
| `realty_jobs_reaped_total` | counter | (expired leases put back by the reaper) |
| `realty_sweeper_pass_duration_seconds`, `realty_sweeper_lateness_seconds` | histogram | |
| `realty_sweeper_due`, `realty_sweeper_enqueued_total`, `realty_sweeper_failed_total`, `realty_sweeper_unhandled_total` | | work_kind |
| `realty_alerts_total` | counter | code, severity |
| `realty_audit_seq_missing`, `realty_retention_last_items` | gauge | item |

**Operational view** (worker, read from the database at most every 15 s through the platform-wide
definer aggregates of migration 0019; aggregates only):

| Metric | Labels | Window |
|---|---|---|
| `realty_queue_jobs` | queue, kind, state (ready, scheduled, running, retrying) | now |
| `realty_queue_lag_seconds` | queue (age of the oldest due job still waiting) | now |
| `realty_queue_oldest_ready_seconds` | queue, kind | now |
| `realty_queue_dead_jobs_24h` | queue, kind | 24 h |
| `realty_messages_stuck`, `realty_messages_stuck_oldest_seconds` | channel, status (dispatching, dispatch_unknown, scheduled/queued overdue > 1 min) | now |
| `realty_dispatch_results_window` | channel, result (sent, failed, blocked, in_flight), reason (provider error code or block reason code) | 15 min (`realty_dispatch_window_seconds`) |
| `realty_timer_fired_window`, `realty_timer_late_window`, `realty_timer_lateness_seconds` | kind (offer_expired, first_touch_breached, auto_released), quantile (0.5, 0.95, 1 = max) | 1 h (`realty_timer_window_seconds`) |
| `realty_first_response_inquiries_window` | result (within_60s, over_60s, blocked, none) | 1 h |
| `realty_first_response_seconds` | quantile (0.5, 0.95) over answered inquiries | 1 h |
| `realty_tenants` | bucket (0, 1-10, 11-100, 101-1000, 1000+) | now |
| `realty_ops_collect_ok`, `realty_ops_collect_age_seconds`, `realty_ops_collect_failures_total` | | the reader's own health |

Run one worker with the operational collector per deployment if you scrape several workers: every
worker exports the same database-wide gauges, so aggregate them with `max`, never `sum`.

---

## 3. Alerts

Page = wakes someone (P1). Ticket = next business day (P2). Thresholds are starting points: tune them
after two weeks of real traffic and write the change down here.

| Alert | Severity | Condition (PromQL) | Runbook |
|---|---|---|---|
| `ApiDown` | page | `up{job="realty",process="api"} == 0` for 2 m on all API targets, or the external `/api/ready` probe fails for 2 m | §4.1 |
| `ApiDegraded` | ticket (page if > 30 m) | the external probe sees `/api/ready` → `{"status":"degraded"}` for 5 m | §4.2 |
| `Api5xxBudgetBurn` | page | `sum(rate(realty_http_requests_total{status_class="5xx"}[5m])) / sum(rate(realty_http_requests_total[5m])) > 0.02` for 10 m | §4.3 |
| `RealtimeQueueLag` | page | `max(realty_queue_lag_seconds{queue="realtime"}) > 30` for 5 m | §4.4 |
| `DeadRealtimeJobs` | page | `increase(realty_jobs_dead_total{queue="realtime"}[15m]) > 0` | §4.5 |
| `DeadJobs` | ticket | `max(realty_queue_dead_jobs_24h) by (kind) > 0` | §4.5 |
| `SweeperLate` | page | `realty_alerts_total{code="SWEEPER_LATE"}` increased, or `histogram_quantile(0.99, rate(realty_sweeper_lateness_seconds_bucket[10m])) > 60` | §4.6 |
| `OwnershipTimersLate` | page | `max(realty_timer_lateness_seconds{quantile="1"}) > 300` or `sum(realty_timer_late_window) / clamp_min(sum(realty_timer_fired_window), 1) > 0.01` for 15 m | §4.6 |
| `FirstResponseSlow` | page | `max(realty_first_response_seconds{quantile="0.95"}) > 60` for 15 m, or `max(realty_first_response_inquiries_window{result="none"}) > 3` for 15 m | §4.7 |
| `MessagesStuck` | page | `max(realty_messages_stuck_oldest_seconds{status="dispatch_unknown"}) > 900` or `max(realty_messages_stuck_oldest_seconds{status="dispatching"}) > 1800` | §4.8 |
| `ProviderFailures` | page | with `d = max by (channel, result, reason) (realty_dispatch_results_window)`: `sum by (channel) (d{result="failed"}) / clamp_min(sum by (channel) (d{result=~"sent|failed"}), 20) > 0.05` for 15 m (the floor of 20 keeps one failure on a quiet team from paging) | §4.9 |
| `WebhooksFailing` | page | `sum(rate(realty_http_requests_total{route=~"/api/webhooks/.*",status_class=~"4xx|5xx"}[10m])) / sum(rate(realty_http_requests_total{route=~"/api/webhooks/.*"}[10m])) > 0.05` for 10 m | §4.10 |
| `OwnershipOrConsentDrift` | page | `increase(realty_alerts_total{code=~"OWNERSHIP_DRIFT|CONSENT_DRIFT"}[1h]) > 0` | §4.11 |
| `DbPoolSaturated` | ticket (page if 15 m) | `max(realty_db_pool_connections{state="waiting"}) > 0` for 5 m | §4.12 |
| `OpsCollectorBlind` | ticket | `max(realty_ops_collect_ok) == 0` for 10 m, or `max(realty_ops_collect_age_seconds) > 300` | §4.13 |
| `SyntheticCheckFailing` | page | two consecutive failures of `pnpm ops:synthetic` (§6) | §4.14 |

Also page on: a SECURITY DEFINER function added without review (CI, ARCHITECTURE §15) and the
`alert: true` log lines of the worker (the log pipeline pages on them; they are the same alerts as
`realty_alerts_total`).

---

## 4. Runbooks

Each entry: **what it means → how to check → how to fix → when to escalate**. "System page" is
Admin → System in the app (Owner and Admin): it shows the team's own failed jobs, stuck messages, late
timers and provider health, and can retry or cancel a job (audited).

### 4.1 ApiDown
- **Means:** no API instance answers. Agents cannot sign in or see their feed; inbound webhooks fail and providers will retry them (Twilio and the email vendors retry for hours).
- **Check:** `/api/health` on each instance; container status; the API's start-up line (`api failed to start` names the configuration problem, never a value); the database.
- **Fix:** a bad deploy → roll back to the previous image. A configuration refusal → fix the named variable. Database down → §4.2's database branch.
- **Escalate:** after 15 minutes down, to the on-call engineer and the team Owner (agents should use their phones directly meanwhile).

### 4.2 ApiDegraded
- **Means:** `/api/ready` answers 200 `degraded`: the database is fine but `storage` or `providers` failed. Reads work; uploads, recordings or sends may fail. `unavailable` (503) means the database check failed and the balancer takes the instance out.
- **Check:** the `checks` object names the failed dependency. Storage: bucket credentials, bucket policy, region, disk (local storage). Providers: the provider configuration no longer loads (a removed or rotated secret).
- **Fix:** restore the credential (§7) or the bucket access; the next probe (storage is re-checked every 30 s) clears it.
- **Escalate:** if storage stays failed over 30 minutes (recordings and attachments are being lost to the client's eyes, not to data), or the database is unavailable at all.

### 4.3 Api5xxBudgetBurn
- **Means:** more than 2 % of requests fail with a server error.
- **Check:** `realty_http_errors_total` by route and code; the error reporter (each event has the request id the user saw in "Something went wrong (ref …)"); logs filtered by that request id.
- **Fix:** a single route → roll back the change that touched it. `INTERNAL_ERROR` spread everywhere → the database (pool, §4.12) or a dependency.
- **Escalate:** immediately if a write path (sending, claiming, accepting) is affected.

### 4.4 RealtimeQueueLag
- **Means:** due realtime jobs (offers, timers, dispatch, critical notifications) wait more than 30 s for a worker.
- **Check:** `realty_queue_jobs{queue="realtime",state="ready"}` by kind; are workers up (`up{process="worker"}`)? `realty_job_duration_seconds` for a slow kind; `realty_db_pool_connections{process="worker",state="waiting"}`.
- **Fix:** start or scale workers (`--queues realtime` dedicated workers if bulk work crowds them out); a kind that hangs → its provider (§4.9).
- **Escalate:** after 10 minutes: offers and first-touch timers decide who owns a lead.

### 4.5 DeadRealtimeJobs / DeadJobs
- **Means:** a job exhausted its attempts or failed permanently.
- **Check:** System page → Jobs that need attention: each dead job says in words why (worker stopped, database busy, a safety rule refused, no handler in this build, payload rejected) and whether a retry is likely to help. The worker log line `platform alert` with `code: JOB_DEAD` has the job id and kind.
- **Fix:** fix the cause first (provider, database), then **Retry** on the System page. Retrying is safe: handlers re-check their fences, dispatch only claims messages that are still scheduled or queued (it never sends twice), and an ownership timer acts only if the lead is still in the state it was for. "No handler" or "payload rejected" will not fix themselves: escalate.
- **Escalate:** any dead `comms.dispatch`, `ownership.*` or `notify.deliver` you cannot explain; any `PAYLOAD_INVALID` or `NO_HANDLER`.

### 4.6 SweeperLate / OwnershipTimersLate
- **Means:** stored deadlines are not being acted on in time. Lead offers stay with an agent past their expiry; breached first touches and auto-releases happen late. Correctness does not depend on job delivery (every overdue deadline is picked up by the next sweep), so lateness means the sweeper or the realtime workers are behind.
- **Check:** is a worker with the sweeper running (`--no-sweeper` is off on at least one worker)? `realty_sweeper_pass_duration_seconds`; `realty_sweeper_failed_total` by work kind; §4.4. The System page lists the team's timers that fired more than 60 s late in the last 24 h (from the ledger).
- **Fix:** start a worker with the sweeper; scale realtime workers; database slowness → §4.12.
- **Escalate:** any timer over 5 minutes late. Tell the team leads: late offers may have reached the wrong agent's feed for longer than the routing rule said.

### 4.7 FirstResponseSlow
- **Means:** new leads are not getting their first message within a minute.
- **Check:** `realty_first_response_inquiries_window` by result; `none` growing → the speed-to-lead reply is not being sent (assistant off? playbook not approved? provider failing?); `over_60s` → queue lag (§4.4) or provider latency (§4.9). `blocked` is not a problem: those leads opted out.
- **Fix:** the matching runbook for the cause; for `none`, the team Owner checks the speed-to-lead setting and that the team's phone number and 10DLC registration are approved (System page → Provider health).
- **Escalate:** to the team Owner when the cause is a setting; to engineering when it is the queue or a provider.

### 4.8 MessagesStuck
- **Means:** outbound messages sit in `dispatching` (the sender stopped part-way) or `dispatch_unknown` (we do not know whether the provider took it) longer than the recovery path allows.
- **Check:** System page → Messages stuck while sending: each shows its channel, age and where it is in recovery (sending, waiting for recovery, asking the provider, unresolved). Nothing there shows a body or an address. `realty_messages_stuck` by channel and status.
- **Fix:** nothing to do by hand while the state is "asking the provider": a `dispatch_unknown` message is looked up at the provider for up to 10 minutes, then marked failed with a human Retry (a **new** message). Never re-send it blindly. A message stuck in `dispatching` past 20 minutes is moved to `dispatch_unknown` by the sweeper: if it is not, the sweeper is down (§4.6).
- **Escalate:** more than a handful at once (a provider outage or a worker crash loop).

### 4.9 ProviderFailures
- **Means:** more than 5 % of allowed sends on a channel fail at the provider.
- **Check:** `realty_dispatch_results_window{result="failed"}` by reason (the provider's error code, e.g. Twilio `30007` carrier filtering, `21610` unsubscribed recipient); the provider's status page; System page → Provider health (sent and failed in the last hour, 10DLC registration status).
- **Fix:** an account or registration problem (suspended campaign, expired credentials) → fix at the provider, rotate the credential if needed (§7). Carrier filtering → review the message templates with the team. A provider outage → wait; messages fail honestly and the agent sees a Retry.
- **Escalate:** to the provider's support with the error codes (never message content); to counsel if a carrier flags compliance (**VERIFY WITH COUNSEL**).

### 4.10 WebhooksFailing
- **Means:** provider callbacks (inbound texts and email, delivery status, opt-outs) are refused or failing. Opt-outs arrive this way: treat it as urgent.
- **Check:** `realty_http_errors_total{route=~"/api/webhooks/.*"}` by code: signature failures point at a rotated or wrong webhook secret or `PUBLIC_BASE_URL` (the signed URL must match); 5xx point at the database.
- **Fix:** correct the secret or base URL (§7); providers retry, and ingestion is idempotent, so retried callbacks are applied once.
- **Escalate:** immediately if signature failures start without a deploy or a rotation (possible forgery attempts) or if callbacks fail for over 30 minutes.

### 4.11 OwnershipOrConsentDrift
- **Means:** the drift check found a contact whose projection does not match its append-only ledger (ownership, R-OWN-4) or consent state (R-CONSENT-6). This should never happen.
- **Check:** the alert names the tenant and contact ids; the audit log has `ownership.drift_detected`.
- **Fix:** do not edit the projection by hand. Engineering re-folds the ledger (the ledger is the truth) after finding the cause.
- **Escalate:** always, to engineering, the same day. Consent drift is a compliance incident: involve counsel if a block may not have applied (**VERIFY WITH COUNSEL**).

### 4.12 DbPoolSaturated
- **Means:** requests or jobs wait for a database connection.
- **Check:** `realty_db_pool_connections` by state and process; database CPU, locks, slow queries (`pg_stat_activity`); `realty_job_duration_seconds` for a kind that holds connections long.
- **Fix:** scale the database or reduce worker `--concurrency`; kill a runaway query; raise the pool only together with the database's `max_connections`.
- **Escalate:** if it persists 15 minutes or the API turns 5xx.

### 4.13 OpsCollectorBlind
- **Means:** the worker cannot read the operational view, so queue, timer and dispatch gauges are stale (the exposition still answers; `realty_ops_collect_ok` says so honestly).
- **Check:** the worker's database connection; whether migration 0019 is applied (`app.ops_queue_stats` exists).
- **Fix:** restore database access; run the release step.
- **Escalate:** after an hour: several page-level alerts depend on these gauges.

### 4.14 SyntheticCheckFailing
- **Means:** the end-to-end check (sign in, feed, one message accepted) fails. The output names the step and a plain reason.
- **Check / fix by step:** `ready` → §4.1/§4.2. `login`/`mfa` → the check user's password or TOTP secret changed, or sign-in is broken (§4.3). `feed` → §4.3. `send … blocked` → someone opted the test contact out (record it, then use a fresh test number; never lift an opt-out to make the check pass). `accepted … still queued` → workers or the provider (§4.4, §4.9).
- **Escalate:** when the cause is not the check's own configuration.

---

## 5. Error reporting

`ERROR_REPORTING_DSN` (Sentry-compatible: `https://<public key>@<host>/<project>`) turns on the real
reporter; without it, an in-memory fake keeps the events (dev, test). `RELEASE` and
`DEPLOY_ENVIRONMENT` tag every event.

What is sent: the error type; the message with quoted values removed and emails, phone numbers and ids
masked (Postgres errors keep only their SQLSTATE and constraint/table/column names); stack frames
(function, app-relative file, line); tags `request_id` (the same id the error body shows the user),
`route` (template), `method`, `status`, `code`, `job_kind`, `process`. Never request bodies, headers,
cookies, query strings, user or tenant ids, payloads or message text. At most 60 events per minute per
process leave; the rest are dropped and counted. Captured: unexpected API errors (500s), worker platform
alerts (dead jobs, drift, sweeper lateness, maintenance failures) and uncaught process errors.

Vendor note: choose a vendor and region your DPA covers (**VERIFY WITH COUNSEL / contract**), turn off
the vendor's own IP and user collection, and set its retention to the shortest that works for you.

---

## 6. Synthetic check

`pnpm ops:synthetic` (in the image: `node apps/api/dist/observability/syntheticMain.js`) runs from
outside the deployment every 5 minutes. It talks to the public API like a browser and prints one JSON
line per step: `ready` (must be `ready`, not `degraded`), `login` (and `mfa` if the user has it),
`feed`, `send` (one text to the test contact), `accepted` (the message reached `sent` or `delivered`
within `SYNTHETIC_SEND_TIMEOUT_MS`, default 60 s), `logout`. Exit 0 = healthy, 1 = a step failed (the
last line has the reason), 2 = the check is misconfigured.

| Variable | Meaning |
|---|---|
| `SYNTHETIC_BASE_URL` | the public origin, e.g. `https://app.example.com` |
| `SYNTHETIC_ORIGIN` | the web origin the API allows (`WEB_ORIGIN`), default the base URL |
| `SYNTHETIC_EMAIL`, `SYNTHETIC_PASSWORD` | the dedicated check user |
| `SYNTHETIC_TOTP_SECRET` | its TOTP secret, if it has MFA |
| `SYNTHETIC_CONTACT_ID` | the test contact the check user owns |
| `SYNTHETIC_CHANNEL` | `sms` (default) or `email` |

Setting up the check user (once per environment, by the Owner):

1. Members → invite `synthetic-check@<your domain>` as an **Agent** named "Synthetic check" with lead routing off for them, so no real lead is ever offered to it. Store its password in the secret manager.
2. Sign in as it and create one contact, "Synthetic test", whose phone is a number the team controls (a provider test number or an internal phone that discards texts). Never use a real client.
3. Put the contact id and credentials in the check's secrets. Each run sends one text, so expect about 290 messages a day to that number; use a provider test number if that costs real money.
4. The check's messages appear in that contact's conversation and in the team's metrics like any other send. That is intended: it proves the real path, including the send-time opt-out check (D1). If the test number ever opts out, the check fails with `send: the send was blocked`; do not lift the opt-out, replace the number.

---

## 7. Backups, restore drill and key rotation

- **Backups and the restore drill:** `docs/DEPLOY.md` §8. Run the drill quarterly; add to step 4 "run `pnpm ops:synthetic` against the drill environment with fake providers" so the drill proves sign-in, the feed and the send path, not just the database.
- **Master KEK and tenant keys:** `docs/DEPLOY.md` §9.
- **Other secrets** (each in the secret manager; rotate on staff change, suspected exposure, or yearly):

| Secret | How to rotate | Check afterwards |
|---|---|---|
| `SESSION_SECRET_BASE64` | new 32 random bytes; deploy. Every CSRF token and rate-limit key derived from it changes: users re-load the page (sessions themselves stay valid) | sign in, send a message |
| `*_WEBHOOK_SECRET` (`TELEPHONY_`, `EMAIL_`, `LEAD_`) | set the new value at the provider/lead source and in the environment in the same change window; callbacks signed with the old one fail with signature errors until both match (providers retry) | `realty_http_errors_total{route=~"/api/webhooks/.*"}` back to 0 |
| `TWILIO_AUTH_TOKEN` | Twilio's secondary-token flow: create the secondary, deploy it, promote it, then delete the old one | System page → Provider health: sends succeed |
| `SMTP_PASSWORD` / vendor keys | create the new key at the vendor, deploy, then revoke the old | a test send; bounce webhook still accepted |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | new key pair, deploy, revoke the old | `/api/ready` `storage: ok`; a recording plays |
| `ANTHROPIC_API_KEY`, `VAPID_*` | new key at the vendor, deploy, revoke the old (rotating VAPID keys re-prompts every device for push: avoid unless exposed) | an assistant draft; a test push |
| `METRICS_TOKEN` | add the new token to the scraper first (Prometheus reloads the credentials file), then deploy | `up{job="realty"} == 1` |
| `ERROR_REPORTING_DSN` | new DSN key at the vendor, deploy, revoke the old | a test event (temporarily) |
| check user password / TOTP | Account → change password / re-enroll MFA as that user; update the check's secrets | next synthetic run passes |

`/api/ready` reports `providers: failed` (degraded) when the configuration on disk no longer loads, so a
half-finished rotation shows up within one balancer poll.

---

## 8. The System page (what the team can fix without a developer)

Admin → System (Owner and Admin; desktop-first, works on a phone). Read-only for everything except two
audited job commands:

- **Retry** a dead job (back in the queue, attempts reset) or a job waiting after a failure (runs now).
  Refused with a plain sentence when a newer job for the same work is already queued.
- **Cancel** a job that is waiting after failures. Cancelling a lead timer only stops that wake-up: the
  deadline itself is stored on the lead, and the sweeper wakes it again if it is still due.

Every command writes `job.retried` / `job.cancelled` to the audit log with the job id and kind. The
page shows messages stuck while sending with their recovery state and a link to the conversation (which
the role may already open), timers that fired late in the last 24 hours, and provider health (sent and
failed in the last hour per channel, sender registrations, integration connections). It never shows
message bodies, addresses or payloads.
