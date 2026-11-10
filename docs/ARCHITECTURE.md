# Realty OS: Phase 1 Architecture (authoritative)

Status: **authoritative Phase 1 design.** It merges three independent drafts (`docs/design/draft-tenancy-security.md`, `draft-lead-ownership.md`, `draft-comms-compliance.md`) with the product owner amendments A1–A7. Amendments override the original spec and the drafts. Where drafts conflicted, this design takes the option that is **safer for tenancy isolation, more deterministic for lead ownership, and stricter for consent**. Every conflict and its resolution is listed in §17.

Companion documents:
- `docs/DATA_MODEL.md`: every table, its constraints and RLS, the numbered business rules (`R-*`), and the edge-case table.
- `docs/BUILD_PLAN.md`: implementation modules in dependency order, with interfaces, tests and acceptance criteria.
- `packages/db/migrations/0001_init.sql`: the schema. It is verified on PostgreSQL 16 and proven by `packages/db/test/rls_smoke.sql`.

Legal statements are marked **VERIFY WITH COUNSEL**. Every legal parameter lives in data (a jurisdiction pack or a versioned tenant policy) and ships with the strictest reasonable default. No state's law is hard-coded.

---

## 1. Product shape (what the architecture serves)

- **One responsive web app (A1)** for phone and desktop, with one design system and one data model. The agent's daily jobs are thumb-first on a phone: Priority Feed, accept/claim, tap-to-call, tap-to-text, approve a draft or handback, log an outcome, find a contact. Admin, imports and the Team Lead queue are desktop-first but still work on a phone.
- **Simplicity and genuineness.** The product has few concepts. It shows no fake activity and no inflated numbers. Every metric shows its denominator ("12 of 14 within SLA"). The assistant always identifies itself as the agent's (or team's) assistant and never claims to be a human.
- **Follow Up Boss parity benchmarks.** Each must be at least as fast as in FUB. The tap counts below are measured on a phone in usability tests and are acceptance criteria in BUILD_PLAN.

| Job | Phase 1 path | Target |
|---|---|---|
| See what's due | open app → Priority Feed (pinned band first) | 0 taps |
| Accept a lead offer | push → feed card → **Accept** | 1 tap from feed |
| Call a lead | feed card or contact → **Call** (opt-outs checked at the tap) | 1 tap |
| Text a lead | **Text** → pre-filled assistant draft → **Send** | 2 taps |
| Log a call outcome | post-call sheet auto-opens → outcome chip | 1 tap (+ optional note) |
| Approve an assistant draft or handback | feed card → **Send** / **Edit** | 1 tap |
| Find a contact | search field (name, phone digits, email, address) | type-ahead, results < 300 ms p95 |
| Reassign (Team Lead) | exception or contact → **Reassign** → pick agent | 2 taps |

---

## 2. System overview

```
                         ┌──────────────────────────── browser (phone / desktop) ────────────────────────────┐
                         │ apps/web  React 18 + Vite + TanStack Query + Tailwind (responsive, iOS-like)      │
                         └───────────────▲──────────────────────────────────────────────▲────────────────────┘
                              httpOnly __Host-sid cookie, x-csrf-token                    │ Web Push
┌────────────────────────────────────────┴─────────────────────────────────────────────────┴───────────────────┐
│ apps/api (Fastify 5 + Zod)                                                                                   │
│   http server: auth, RBAC can(), routes ──┐                      worker entrypoint (same codebase):          │
│   webhooks (signed: telephony, email,     │                        job loop (claim_jobs SKIP LOCKED)         │
│     lead intake) ─────────────────────────┤                        sweeper (due_work every 15 s)             │
│   provider adapters (interfaces + fakes)  │                        dispatchOutbound, assistant runs,         │
│   crypto (envelope AES-256-GCM, HMAC)     │                        notifications, imports, retention         │
│                                           ▼                                                                  │
│        packages/db: Kysely + withTenantTx(actor) + applyOwnershipCommand + recordConsentEvent + jobs         │
│        packages/core: PURE domain logic (ownership, compliance gate, priority, accountability, import,       │
│                       assistant evidence/autonomy, business time). Injected clock + id generator. No I/O.    │
└────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────┘
                                         │ connects as app_user (NOSUPERUSER, NOBYPASSRLS, member of no role)
┌────────────────────────────────────────▼─────────────────────────────────────────────────────────────────────┐
│ PostgreSQL 16: FORCE RLS on every table; SECURITY DEFINER helpers owned by app_definer (NOLOGIN BYPASSRLS);  │
│ retention/erasure owned by app_retention (NOLOGIN BYPASSRLS); append-only ledgers; jobs table queue;         │
│ tsvector + pg_trgm search                                                                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   object storage (local encrypted FS in dev; S3-compatible): tenants/{tenant_id}/..., per-object DEK
   providers: telephony/SMS (Twilio-shaped, subaccount per tenant), email, AI (Anthropic), transcription,
              MLS/IDX (fake), AVM (interface only), DNC scrub (fake + admin upload), carrier lookup (fake)
```

**Processes.** The `api` process and the `worker` process are the same build with two entrypoints. Both connect as `app_user`. The `system` actor can be constructed only in `apps/api/src/worker/*`, which is enforced by a lint rule and an architecture test. Phase 1 has no other services.

**Monorepo.** The layout is `packages/core` (pure), `packages/db` (migrations, Kysely types, tenant transaction, ownership and consent persistence), `apps/api`, and `apps/web`. Core never imports db or api. db imports core types only.

---

## 3. Request lifecycle: auth → tenant context → RLS transaction → audit

```
1  TLS terminates at the edge. HSTS. Fastify assigns request_id.
2  Rate limit (auth routes: auth.rate_limit_hit with hashed keys; 5/min per IP+email, 20/h per email, 100/h per IP).
3  Session: read __Host-sid cookie → sha256 → auth.resolve_session(token_hash, now)   [pre-tenant definer]
      → {session_id, user_id, tenant_id, role, mfa_verified_at, reauthenticated_at}; nothing found ⇒ 401.
      Owner/Admin without MFA enrolled get an enrollment-only session.
4  CSRF: every non-GET carries x-csrf-token = HMAC(server_secret, session_id); Origin checked against the allowlist.
5  Actor = { kind:'user', userId, tenantId, role, sessionId } built ONLY from step 3 (never from body/path/header;
      Zod input schemas have no tenant_id field).
6  RBAC: core.can(actor, action, resource) per the capability matrix (DATA_MODEL §3). Denied, or resource invisible ⇒ 404.
      Sensitive actions also require reauthenticated_at within 15 min ⇒ REAUTH_REQUIRED.
7  withTenantTx(actor, fn):
      BEGIN (READ COMMITTED)
        set_config('app.tenant_id', tenantId, true); set_config('app.user_id', userId, true)
        set_config('app.actor_kind', 'user', true);   set_config('app.principal_type', 'staff', true)
        now := SELECT clock_timestamp()    -- the single clock passed into core for this tx
        fn(tx, now)                         -- Kysely instance only reachable inside fn
        audit rows written in THIS tx (if the audit insert fails, the action fails)
      COMMIT
8  Response: invisible rows ⇒ 404 (never 403). Errors carry stable codes (LEAD_OFFER_EXPIRED, DRAFT_STALE, ...).
```

- **RLS does the row filtering.** A forgotten `WHERE` cannot leak another tenant's data or another agent's contacts, because Layer 1 (tenant) and Layer 2 (visibility) policies live in Postgres. RLS does not protect against a compromised API process, which sets the GUCs itself. That residual risk is stated in §16.
- **Ownership commands** additionally `set_config('app.ownership_command', command_id, true)` (§5).
- **Webhook lifecycle.** Verify the provider signature (bad ⇒ 403, `app.record_webhook_event(... signature_valid=false)`, no tenant writes). Then resolve the tenant through `app.resolve_inbound_number` / `app.resolve_inbound_email_token` / `app.resolve_lead_source`; unknown ⇒ `unrouted`, platform alert. Then idempotency through `webhook_events (provider, provider_event_id)`. Then `withTenantTx({kind:'system', via:'provider'})`.
- **Worker lifecycle.** `app.claim_jobs(queues, worker, n, lease)` returns `(id, tenant_id, kind, payload)` across tenants. Each job then runs in its own `withTenantTx({kind:'system', tenantId: job.tenant_id, jobId})` and finishes with `app.finish_job`. **One job = one transaction = one tenant.**
- **Pool hygiene.** Only `SET LOCAL` / `set_config(..., true)` is used, and a lint rule bans `SET app.` without LOCAL. After a transaction ends the GUC reads `''`, which `NULLIF` turns into NULL, so a reused connection sees zero rows.

---

## 4. Tenancy and visibility

- **Hierarchy.** `users` is global; one login can belong to several tenants, with one active tenant per session. `memberships` holds (tenant × user × one role). A tenant is a team or brokerage account and is the isolation and billing unit. Teams exist inside tenants, and the Phase 1 UI assumes one default team.
- **Keys.** Every tenant table has `PRIMARY KEY (tenant_id, …)`. Every reference to a tenant row is a composite FK `(tenant_id, x_id)`, and references to users inside a tenant point at `memberships (tenant_id, user_id)`. A cross-tenant reference therefore cannot be represented, even by a superuser (smoke-tested). Ledgers (`lead_ownership_events`, `consent_events`, `audit_log`) have no FK to mutable entities, so their history survives purges and holds no PII.
- **Layer 1.** Every table with a `tenant_id` column gets one `RESTRICTIVE` policy, `tenant_id = app.tenant_id() AND app.principal_type() = 'staff'`. It is generated by a DO loop that discovers tables by column, so a new table cannot be forgotten, and the migration's self-check fails if a table lacks it. `principal_type = 'staff'` is what keeps future client-portal principals (Phase 3) out of every table until explicit per-table client policies are added.
- **Layer 2.** `PERMISSIVE` policies express who sees and writes which rows inside a tenant: the contact visibility rule, the pond/offer card rule, the recording scope, deal participation, commission restriction, and self-only tables. They are listed in DATA_MODEL §2.
- **Definer helpers.** `app.my_role`, `is_tenant_wide`, `my_team_member_ids`, `my_pond_ids`, `my_deal_contact_ids`, `my_collab_contact_ids`, `recording_scope` and `contact_exists` are `SECURITY DEFINER`, owned by `app_definer` (NOLOGIN BYPASSRLS), and pin `search_path`. This is required because FORCE RLS binds table owners too, and it avoids policy recursion. Each helper filters `tenant_id = app.tenant_id()` explicitly.
- **Pre-tenant and cross-tenant entry points (complete list).**
  - `auth.login_lookup`, `auth.record_login_result`, `auth.rate_limit_hit`, `auth.resolve_session`, `auth.user_tenants`, `auth.mfa_secret`
  - `auth.issue_password_reset`, `auth.consume_password_reset`, `auth.accept_invite`
  - `app.resolve_inbound_number`, `app.resolve_inbound_email_token`, `app.resolve_lead_source`
  - `app.record_webhook_event`, `app.finish_webhook_event`
  - `app.claim_jobs`, `app.finish_job`, `app.reap_stuck_jobs`, `app.due_work`
  - `app.provision_tenant`, `app.retention_sweep`

  Each returns the minimum columns. Adding a definer function requires security review (CODEOWNERS on migrations). The migration self-check asserts that every definer is owned by `app_definer` or `app_retention` and pins `search_path`.
- **The ownership-command visibility branch.** PG16 checks the *new* row of an `UPDATE … WHERE` against the SELECT policy (verified while building this design). An agent who declines an offer, or hands off a lead, would otherwise fail on their own command. Fix: the contacts SELECT policy includes `ownership_actor_user_id = app.user_id() AND ownership_command_id = app.ownership_command()`. Both columns are guarded and must match a ledger row written by that same actor in that same command, so the actor keeps sight of the row only until the command's transaction ends. This is smoke-tested.

---

## 5. Lead ownership engine (deterministic, fully audited)

- **States** (`contacts.ownership_state`): `unassigned`, `offered`, `owned`, `in_pond`, `closed`. A shape CHECK fixes which of owner, offer and pond are set. Phase 1 adds no other states.
- **Source of truth.** The source of truth is `lead_ownership_events`: append-only, **gapless per contact** (enforced by trigger), with PK `(tenant_id, contact_id, seq)`. The projection lives on `contacts`. `contacts.ownership_seq` is always the **ledger head** (the seq of the last ledger event; DB guard `OWNERSHIP_SEQ_HEAD`), so `projection.ownership_seq + 1` is always the next seq, and `fold(events)` must equal the projection over **all** ledger events. Every command that appends events also updates the projection, including events that change no state column (`inactivity_warned`, `reinquiry`). **Rejected commands are not ledger events.** They go to the append-only `ownership_command_rejections` log, keyed by `command_id`; the loser of a race usually cannot see the contact any more, and that table needs no contact visibility. A nightly drift check samples contacts and raises a P1 alert on any mismatch, with no auto-fix.
- **Ownership period.** `contacts.ownership_period_seq` is the seq of the event that started the current ownership period (accept, claim, assign, reassign, self-create, import). It is NULL unless the state is `owned` (DB CHECK). It fences the SLA and inactivity timers, binds assistant drafts (`bound_ownership_seq`, R-AST-7), and keys `untouched_lead` exceptions. Events inside a period (touch, breach, warning) advance `ownership_seq` but not the period.
- **Single code path.** `applyOwnershipCommand` (packages/db) runs every step in one transaction:

```
BEGIN; withTenantTx context; set_config('app.ownership_command', command_id, true)
  0 idempotency: ledger events or a rejection with this command_id exist ⇒ return the stored outcome
  1 app.lock_contact($c); SELECT … FROM contacts WHERE tenant_id=$t AND id=$c FOR UPDATE
       (merges: both contacts, ascending id; global lock order in §10)
  2 SYSTEM ACTOR ONLY (route, timers, deactivation): routing_rotation_state FOR UPDATE;
       candidate memberships FOR SHARE (sorted)
  3 now := clock_timestamp()   -- read AFTER the lock
  4 decision := core.ownership.decide(projection, command, ctx{now, ids, actor, settings, routing, claimStats, calendar})
  5 accepted: INSERT lead_ownership_events (seq = projection.ownership_seq+1 …)   -- trigger: gapless + command_id = GUC
    rejected: INSERT ownership_command_rejections (code, observed_seq); no ledger row, no projection change
  6 UPDATE contacts SET … , ownership_seq = last, ownership_period_seq, ownership_command_id, ownership_actor_user_id
       WHERE … AND ownership_seq = $expected       -- trigger: matching ledger row at the ledger head
  7 effects in the same tx, limited to rows the actor's own RLS may write: jobs (dedupe keys), notifications +
    deliveries, the actor's own membership counters, audit_log mirror of human commands.
    Everything that touches OTHER users' rows (feed items, re-homing open handbacks, invalidating the
    previous owner's drafts, pausing agent enrollments, collaborator rows) and any routing go to ONE job,
    ownership.followup (realtime, dedupe followup:{command_id}), which applies them as the system actor
    under the same locks. For a system actor the same effects run inline.
COMMIT   (serialization_failure / deadlock ⇒ retry ≤ 3 with the same command_id)
```

- **Routing never runs under a user actor.** An agent's RLS cannot see or lock other candidates' routing inputs: their memberships `FOR SHARE`, their push subscriptions, their `app.claim_stats`, and `routing_rotation_state` (smoke-tested). A user-actor router would therefore decide on an empty or partial candidate set, falsely send the lead to the pond (`NO_ELIGIBLE_AGENT`), or silently fail to persist the round-robin cursor. So:
  - A **decline** commits only `offer_declined` → `unassigned` with `route_due_at = now`, and enqueues `ownership.followup`. The follow-up routes as the system actor. The sweeper re-issues routing for any `route_due_at` older than 15 s.
  - A **late accept** (`now ≥ offer_expires_at`) is rejected with `LEAD_OFFER_EXPIRED` and writes only the rejection. The `ownership.offer_expiry` job, which is already due, or the sweeper, applies `offer_expired` and the next offer as the system actor.
  - Claims need only the claimer's own inputs, so they stay inline. A TL/ISA reassignment reads the target membership (not locked); a target that turns inactive concurrently is moved again by the resumable deactivation job (R-OWN-22).

- **Concurrency.** The contact locks serialize contention on one contact, and the losing claimer gets `LEAD_ALREADY_CLAIMED`. Rejected commands are written to `ownership_command_rejections`, so failed accepts and claims are audited too, without touching the gapless ledger.
- **Timers.** Offer expiry, first-touch breach, auto-release and inactivity warning/release are all **stored** as absolute UTC instants on `contacts` (`offer_expires_at`, `first_touch_due_at`, `release_due_at`, `inactivity_warn_at`, `inactivity_release_at`), computed by core with the settings in force when the deadline is set. Nothing is derived from live settings at sweep time. Jobs only wake the system and carry fences: `offer_id` for offers; `(ownership_period_seq, deadline instant)` for breach, auto-release and inactivity. The breach event advances `ownership_seq` but not the period, so the auto-release job enqueued at ownership start still fires. A stale or duplicate timer is a no-op, and an early wake reschedules. The sweeper `app.due_work(now)` runs every 15 s across tenants and issues timer commands for anything overdue. Correctness therefore never depends on job delivery. **Configuration changes never move existing deadlines.** Lowering or raising `inactivity_release_days` affects only deadlines set afterwards. Setting it to NULL (disable) is honoured at fire time, which only ever lets the agent keep the lead.
- **Touch time.** A touch (R-OWN-14) is a gate-allowed human outbound by the owner or a collaborator. Its instant is the commit of the dispatch transaction that allowed it: TX1 for SMS/email (§9), or the dial-time decision for calls. `first_touch_recorded`, `last_human_touch_at` and the new inactivity deadlines are written **in that same transaction** through the in-transaction ownership command. TX1 takes the same contact locks as `auto_release` and `first_touch_breached`, so exactly one order wins. If the touch commits first, there is no release. If the release commits first, the lead is no longer the sender's, the send is `blocked` (E15), and the client never receives a text from an agent who has just lost the lead. A later provider failure does not undo the touch; it raises a `failed_send` exception instead.
- **Business time.** `core.time.addBusinessDuration` uses tenant routing hours (default 08:00–21:00, tenant IANA tz) with explicit DST gap and overlap rules. Test vectors cover six US zones on the 2026 and 2027 transitions. Offers are delivered immediately even at night; the window starts counting at the next opening.
- **Defaults.**
  - Offers: 300 s window; 3 offers then the default pond.
  - First touch: SLA of 15 business-minutes from `max(owned_at, next contactable instant)`. A breach notifies the owner and Team Lead and raises an `untouched_lead` exception. Auto-release fires at 30 minutes if the lead is still untouched (tenant setting; NULL disables it).
  - Inactivity: release after 30 days for stages new/attempting, never with an open deal, with a 72 h warning.
  - Claims: 5 per day, 72 h cooldown after losing a lead, capacity cap of 5 uncontacted leads.
  - Routing: auto-pause after 3 consecutive missed offers.
- **The assistant never counts as a touch.** The 60-second first response does not satisfy the human speed-to-lead SLA or the untouched-lead rule.

---

## 6. Job queue and timer design

| Item | Design |
|---|---|
| Table | `jobs` (bigint identity, `tenant_id` NULL only for `maintenance`), `queue ∈ {realtime, default, bulk, maintenance}`, `priority`, `run_at`, `status`, `attempts/max_attempts`, lease (`locked_by`, `locked_until`), `dedupe_key` (partial unique per tenant while pending/running), scrubbed `last_error`. |
| Enqueue | `INSERT` in the same transaction as the domain write (transactional outbox by construction). `app_user` has INSERT only and cannot read the queue. Payloads hold ids and fences only (Zod schema); PII is never stored there. |
| Claim | `app.claim_jobs(queues[], worker, n ≤ 100, lease ≤ 15 min)` uses `FOR UPDATE SKIP LOCKED`, ordered by `(priority, run_at, id)`. |
| Finish | `app.finish_job(id, worker, ok, error, retry_at)`. Backoff is jittered exponential (core). A job that exhausts its attempts goes `dead` and raises a platform alert. |
| Crash | `app.reap_stuck_jobs()` returns expired leases to `pending`. Handlers are idempotent (fences, unique keys, status lattices). A re-run dispatch job never re-sends: it only claims `scheduled`/`queued` messages. A message a crashed worker left in `dispatching` is recovered by the sweeper's `dispatch_stale` branch, never by the reaper. |
| Cancel | `app.cancel_jobs(dedupe_keys[])` works in the current tenant only. |
| Sweeper | Every 15 s, `app.due_work(now, limit)` finds: offer expiry, first-touch breach, auto-release, inactivity (stored instants), pending routing (`route_due_at`), scheduled messages, stuck `dispatching` messages, `dispatch_unknown` reconciliation, playbook steps, and notification retries. |
| Queues and SLOs | `realtime` (offers, timers, dispatch, 60 s first response, critical notifications): pickup p95 < 2 s. `default`: assistant enrichment, matching. `bulk`: imports, recomputes. `maintenance`: drift check, retention, `stored_objects` blob deletes. |

**Timer catalog** (job kinds; every one re-reads the state under lock and checks its fence):

| Kind | Scheduled when | Fence | Effect when due |
|---|---|---|---|
| `ownership.offer_expiry` | `offered` event | `offer_id` | `offer_expired`, then next offer or `sent_to_pond` |
| `ownership.first_touch_breach` | owned with SLA | `ownership_period_seq` + `first_touch_due_at` | `first_touch_breached`, notify owner + TL, derive `untouched_lead` |
| `ownership.auto_release` | owned with SLA and release enabled | `ownership_period_seq` + `release_due_at` | `auto_released` to pond (reason `FIRST_TOUCH_MISSED`) |
| `ownership.inactivity` | owned (stored `inactivity_warn_at` / `inactivity_release_at`) | `ownership_period_seq` + stored instant | warn (clears `inactivity_warn_at`), then `inactivity_released` |
| `ownership.followup` | any user-actor command with cross-user effects, every decline | `command_id` (+ `route_due_at` for routing) | apply cross-user effects as system; route an `unassigned` lead with `route_due_at` |
| `comms.dispatch` | message queued or scheduled | message status | `dispatchOutbound` (§9) |
| `comms.dispatch_stale` | sweeper only: `dispatching` with `dispatched_at` older than 20 min (max lease 15 min + margin) | message status | `dispatch_unknown`, then provider reconciliation (R-GATE-8) |
| `playbook.step` | enrollment `next_step_due_at` | enrollment state + step key | build step, then authorize and gate at send time |
| `assistant.*` | inbound, call ready, lead created | ids | run AI; results are assistant_actions |
| `notify.deliver` | notification created | delivery status | channel send with retry |
| `exceptions.recompute` | on relevant writes + every 60 s per active tenant (time-only conditions: promise due, appointment end + 2 h, unknown dispatch + 10 min) | dedupe key | `core.deriveExceptions` upsert |

---

## 7. Provider adapters

All providers sit behind interfaces in `apps/api/src/providers/*`. Each has a deterministic fake for dev and test; `*_PROVIDER=fake` is the default in `.env.example`.

| Interface | Phase 1 implementation | Notes |
|---|---|---|
| `TelephonyProvider` (SMS send, call bridge, recordings, number purchase/release, A2P status) | Twilio-shaped, **one subaccount per tenant** (separate numbers, logs and opt-out lists) | Webhooks are signature-verified. Status callbacks are idempotent through `message_status_events (provider_event_ref)`. |
| `EmailProvider` (send, inbound parse, events) | SMTP / provider API | Sending requires a domain with verified SPF+DKIM+DMARC, or the platform's shared authenticated domain for one-to-one mail. Reply-To uses `r+{token}@in.{platform}` routing tokens. |
| `AiProvider` (complete with a structured schema) | `@anthropic-ai/sdk` | The fake returns deterministic drafts and claims, including deliberately bad quotes so evidence verification is exercised. There is a per-tenant `ai_enabled` switch. A DPA and retention terms with the vendor are required (**VERIFY WITH COUNSEL / contract**). |
| `TranscriptionProvider` | provider or fake | Transcripts are encrypted on arrival and never logged. |
| `ObjectStorage` | local encrypted FS (dev), S3-compatible (prod) | Keys are `tenants/{tenant_id}/…` (DB CHECK). There is a per-object DEK, and the AAD includes the tenant. Browsers never get raw object URLs; playback is streamed through the API (60 s single-use token) and audited. |
| `MlsFeed` | fake only | A real feed needs MLS/IDX licensing (**VERIFY**). Phase 1 matches saved searches against the team's own `listings`. |
| `AvmProvider` | interface only | Monthly home-value updates are Phase 2. |
| `DncProvider` | fake + Admin CSV upload of scrub results | The DNC vendor decision is an open question; it is recommended before launch if teams cold-call. |
| `CarrierLookup` | fake | `line_type`; unknown is treated as SMS-capable. |

Adapters never receive tenant context implicitly. Every call takes explicit ids and decrypted credentials from `provider_credentials`, which is decrypted only in the system actor.

---

## 8. Encryption boundaries

| Data | Protection | Why |
|---|---|---|
| DB volume, WAL, backups | provider disk encryption + TLS (`sslmode=verify-full`) | baseline |
| Call recordings, inbound MMS, import files, consent evidence documents | object storage SSE **plus** a per-object DEK (AES-256-GCM) wrapped by the tenant `object` key, registered in `stored_objects` | the highest-risk assets |
| Transcripts (`transcripts.segments_enc`), transcript-sourced evidence snippets (`evidence_refs.snippet_enc`) | field-level AES-256-GCM, tenant `field` key | sensitive; low query need, so they are excluded from search |
| Provider credentials (telephony subaccount, FUB API key), import raw rows, webhook payloads, lead raw payloads, AI outputs, push endpoints/keys | field-level, tenant `field` key (webhooks: platform key) | secrets and bulk PII; most are purged on schedule |
| MFA TOTP secrets | field-level, **platform** key (users are global) | secret |
| Addresses inside consent, suppression, DNC and gate tables | **HMAC-SHA256 only** (tenant `hmac` key, never rotated) plus a masked hint | opt-outs outlive contact deletion without keeping plaintext |
| Names, phones, emails, message bodies, notes, assistant summaries | **plaintext** under RLS + disk encryption | needed for search, dedup and routing (an accepted, flagged trade-off) |

- **Ciphertext format.** `0x01 | key_version u32 | nonce 12 | ciphertext | tag 16`. The AAD is `tenant_id | table | column | row_id`, so ciphertext copied to another row or tenant fails to decrypt.
- **Key hierarchy.** The master KEK (KMS in prod; a 32-byte `KEK_BASE64` in dev) wraps `tenant_keys` (`field`, `object`, `hmac`), and the object key wraps per-object DEKs. Rotation adds `field_v{n+1}`; re-encrypting old rows is optional. The HMAC key never rotates (DB CHECK).
- **Crypto-shred.** Tenant deletion destroys the tenant keys. Recording shred nulls the DEK (`stored_objects.dek_wrapped`), after which the blob is deleted. Plaintext rows can persist in backups for the 35-day PITR window after an erasure (**VERIFY WITH COUNSEL**).
- **Boundary.** Envelope operations live in `apps/api/src/crypto`. Core never sees keys or ciphertext.

---

## 9. The send-time check: `canContact()` and the one outbound path

**Owner decision (2026-11, core-compliance/2.0.0; Design Review Log entry D1 in §20).** Every lead is treated as having consented through the third-party source it came from, and the owner chose "Remove the check entirely" for the send-time consent/compliance decision. What remains is a narrow **opt-out block**: nobody who texted STOP (or another opt-out keyword), clicked unsubscribe, or whom an agent recorded as "do not contact me" is ever messaged or called, and nobody can override that. The consent-basis requirement, the national Do Not Call registry check, the contact window / quiet hours, jitter, the timezone-evidence notice, frequency caps, the `defer` outcome and the `needs_confirmation` / "send anyway" flow are gone. Reinstating any of them is a policy and rules change, not a rebuild (see §19 VERIFY WITH COUNSEL).

`core.compliance.canContact(input): GateDecision` is pure and deterministic. The same input gives the same decision and the same `inputsDigest`, and adding a revoke or a suppression never turns a deny into an allow (property-tested).

**Inputs** (assembled by `apps/api` inside the dispatch transaction under the per-contact advisory lock):
- `now`, recipient (contact or user), address HMAC, channel, purpose (`marketing` | `informational`), initiator (`human` | `assistant` | `system`), action category
- consent rows (`consent_state` for this address, plus the contact's other phones for SMS). Only `revoked` rows matter: the consent level is kept as history and no send reads it
- suppressions, contact point status and line type, automation pause, sender and its registration
- tenant identity flags (brokerage name, postal address), rendered-content facts (brokerage name present, unsubscribe/STOP hint, payment-instruction pattern)
- the resolved policy: platform floor ∧ jurisdiction packs ∧ tenant policy version (autonomous categories, opt-out keywords, recording)

**Outcome.** `allow | deny`, with **all** reasons collected, a human sentence explaining them ("Opted out of texts"), the core rules version and the inputs digest. Any reason ⇒ deny. No reason can be confirmed past, and nothing is deferred.

**Checks** (every one is a deny, for every initiator, with no override):

| # | Check | Assistant/system | Human |
|---|---|---|---|
| 0 | Autonomy: always-human categories (money, contracts, a new kind of client message, seller updates); only the policy-approved autonomous categories; no automated voice; agent alerts only to users | deny | n/a |
| 1 | Tenant suspended | deny | deny |
| 2 | Contact point invalid / wrong number / SMS to landline | deny | deny |
| 3 | Sender missing or not registered (10DLC / toll-free), or email domain unverified for marketing | deny | deny |
| 4 | Marketing without the brokerage name rendered (A7f), or marketing email without postal address / unsubscribe link (CAN-SPAM applies regardless of consent) | deny | deny |
| 5 | **Opt-out**: consent revoked for the channel (+ purpose for SMS/email; either purpose for calls). An SMS revoke on any of the contact's phones blocks texting all of them | deny | **deny (no override)** |
| 6 | Active suppression (bounce, complaint, landline, internal / imported do-not-contact, admin block, wrong number, provider opt-out) | deny | deny |
| 7 | Payment / wire instructions in the body | deny | deny |
| 8 | Automation paused for this contact (the client replied) | deny | n/a (humans can always reply) |

The one exemption: the system's own informational SMS reply to a STOP/HELP keyword (`opt_out_confirmation`, `help_reply`) may reach the number that just opted out. It is still checked for everything else, suppressions included.

**Removed (retired rules, kept in DATA_MODEL with their ids).** Consent basis per channel × purpose × initiator (old check 8, R-CONSENT-5 table), DNC registry (old check 9, R-CONSENT-15), contact window and its deferral, jitter and human reply window (old check 11, R-CONSENT-13), frequency caps for automated sends, manual SMS and call attempts (old check 12, R-CONSENT-14), weak-timezone notice (old check 13), the 10-minute decision staleness rule (old R-GATE-3 half), and confirmations (old R-GATE-6 meaning). Call-recording consent (two-party rules, R-CONSENT-16) is a different law and is unchanged.

**Every outbound path that must call it.** Each path goes through `dispatchOutbound` / `dialOutbound`. These are the only modules allowed to import a provider send or dial function, enforced by a lint rule and an architecture test.

1. Human one-to-one SMS/email from contact, feed or thread (a compose-time preview that is never stored, plus the send-time decision).
2. Human scheduled messages ("send at 9 am"): checked again at send time, and they require a re-tap if the client replied since.
3. Tap-to-call: a dial-time decision before the provider bridges the client leg.
4. Approved assistant drafts and handback replies: the human is the sender; the assistant action must be `approved`.
5. Playbook steps (nurture, post-closing, reminders, booking confirmations, document chase when enabled): `authorizeAutonomousAction` then the check at **send time**.
6. The 60-second new-lead first response (team playbook `new_lead_response`): a text to a reachable mobile number unless it opted out or is suppressed, otherwise email.
7. Saved-search alerts (`search_alert`, purpose marketing).
8. Opt-out confirmation and HELP replies (the exemption above; still sender-registration checked).
9. Agent alert SMS (`recipient_kind='user'`; agents can text STOP too).
10. Import-originated rows are history only. They never call a provider and are exempt by `imported = true`.

Account emails to users (password reset, invite) are not contact communications and are out of scope for the contact opt-out rules. They are still rate-limited and audited.

**What is stored.** An allowed send stores no decision. A blocked send writes one append-only `gate_decisions` row (`outcome = 'deny'`, `phase = 'send'`, CHECK from 0013, `NOT VALID` so older rows keep their old values) with the reasons, the explanation, the policy version, the core rules version, plaintext-free inputs and their digest, and the message or call links to it (`messages.gate_decision_id`, `calls.gate_decision_id`, `notification_deliveries.gate_decision_id`, `playbook_step_runs.last_gate_decision_id`; all nullable). That row is the evidence for the Team Lead "failed send" exception and for "why wasn't this sent" in the UI. Previews ("Won't send: Opted out of texts" in compose, on the contact page and on approval cards) are never stored.

**Database enforcement** (migration 0013; smoke-tested and covered by `packages/db/test/dispatch_guard.test.ts`).
- The per-send `gate_decision_id` CHECKs on `messages`, `calls` and `notification_deliveries` are gone.
- `messages_dispatch_guard` (SECURITY DEFINER, owned by `app_definer`, pinned `search_path`) keeps the assistant-autonomy checks verbatim: an assistant message needs an approved action, or an approved playbook version **and** an un-paused conversation (`ASSISTANT_ACTION_MISSING`, `PLAYBOOK_NOT_APPROVED`, `AUTOMATION_PAUSED`, `ASSISTANT_ACTION_NOT_APPROVED`, `ASSISTANT_ACTION_NOT_SENDABLE`). It adds a database-level **opt-out block** for every initiator: a message cannot reach `dispatching` (or later) when its recipient address has a revoked `consent_state` row for the channel and purpose (SMS: also any of the contact's other phones) or an active suppression for the channel or `all`. The recipient is linked through `messages.to_address` = `contact_points.address`; the guard takes the HMAC of every contact point in the tenant with that address, so a stray or forged point cannot hide the real one, and a send to an address that is not one of the contact's points is refused (`RECIPIENT_NOT_A_CONTACT_POINT`). It blocks at least what core blocks for opt-outs, never less. The STOP/HELP reply exemption applies only to the number that texted the keyword, within 24 hours of that keyword message (0014; core checks the same through `GateInput.keywordSenders`), and the reply is addressed to that number, never the contact's primary phone. `calls_dispatch_guard` (0014) refuses a call when any of the contact's phones has a revoked voice row: an agent-recorded "do not call me" covers the person, and the call outcome also revokes voice on every phone of the contact.
- `calls_dispatch_guard` does the same for voice: a voice revoke of either purpose (an agent-recorded "do not call me") or an active voice/`all` suppression on `calls.client_address`.
- Not covered by a database guard: agent-alert SMS (`notification_deliveries`). Its recipient is `memberships.alert_phone_e164`, which has no stored HMAC, so the opt-out relies on the single sending path (`dispatchAgentAlertSms` runs `canContact` with `recipient = user`).

**Dispatch protocol** (no network call inside a transaction; a missed message is preferred over a duplicate):

```
TX1  app.lock_contact(contact); SELECT message FOR UPDATE (status scheduled|queued, else return)
     re-read pause, the client's replies since a human scheduled it, enrollment + playbook approval
     (agent playbook ⇒ its owner is still the contact owner), sender still authorized for this contact,
     opt-outs, suppressions, registration
     core.authorizeAutonomousAction (assistant only) → core.canContact (allow | deny)
     allow ⇒ status 'dispatching', dispatched_at = now (DB CHECK) (the guard re-checks opt-out + autonomy);
             nothing is written to gate_decisions;
             human sender ⇒ touch in the same tx (first_touch_recorded if first, last_human_touch_at, inactivity deadlines)
     deny  ⇒ INSERT gate_decisions (outcome deny, phase send) + 'blocked' with the reason (+ failed_send)
COMMIT
provider.send(idempotencyKey = message.id)
TX2  'sent' + provider ref | 'failed' + error | timeout ⇒ 'dispatch_unknown' (never auto-retried; reconcile ≤ 10 min,
     then 'failed' with a human Retry action)
CRASH between TX1 and TX2: the message stays 'dispatching'. The sweeper's dispatch_stale branch moves it to
     'dispatch_unknown' once dispatched_at is older than the maximum lease + margin (20 min), and reconciliation
     proceeds as for a timeout. It is never re-sent blindly. failed_send also counts 'dispatching' older than 20 min.
```

There is no deferral branch and no job or `due_work` branch that exists only to resume deferred sends; a scheduled message (a human "send at", a playbook step) is sent by the sweeper's message-dispatch branch at `scheduled_for` and checked at that moment.

**Policy layering.** The platform floor (core constants) comes first, then jurisdiction packs (global, versioned, `reviewed_by_counsel_at`; the UI says plainly when a pack is unreviewed), then the tenant `compliance_policy_versions` (append-only). The tenant policy now holds only the autonomous categories, who confirms an opt-out, and call recording. A tenant can only narrow the autonomous categories, packs can add opt-out keywords, and one-party recording needs an Owner attestation (DB CHECK plus an owner-only trigger). Pack keys `contact_window`, `restricted_days` and `dnc_scrub_validity_days` are ignored (reported as ignored keys), not failed.

---

## 10. Inbound ingestion: atomic pause and handback (A3)

Inbound SMS, email reply and inbound/missed calls all run in **one transaction**:
1. `provider event` idempotency.
2. Match contacts by `(kind, address)`. Zero matches creates an `Unknown +1…` contact through intake routing. Several matches use conversation affinity; otherwise the row is marked needs_review.
3. Lock every affected contact with `app.lock_contact` (sorted), in the global order below.
4. Insert the inbound message and bump `conversations.inbound_seq`.
5. STOP / START / HELP / wrong-number / opt-out-language processing (consent events, cancelling queued SMS).
6. **Pause:** set `conversations.automation_paused_at`, pause live enrollments of every contact on that address, mark scheduled step runs `canceled_paused`, cancel queued assistant messages.
7. Insert **one handback** (`assistant_actions kind='handback'`, dedupe `handback:{enrollment}:{message}`) for the owner, or for the TL when the lead is unowned. Its deterministic claims ("what was sent" cites the last outbound message ids; "what the client said" cites this message verbatim) are written in the same transaction.
8. Feed item and notification (critical when the lead is hot).
9. Enqueue `assistant.enrich_handback`. Its LLM-suggested next step arrives later as an evidence-backed claim, or needs_review. It is optional; the handback is useful without it.

**Global lock order.** Every writer takes `app.lock_contact`, so the ownership engine, inbound ingestion, dispatch, the ownership follow-up and enrollment changes all exclude each other on one contact. The advisory lock is used rather than a row lock because a TC or a system webhook may lack UPDATE visibility of the row. The order is:
1. `app.lock_address` (sorted by HMAC)
2. `app.lock_contact` (sorted by contact id)
3. `contacts … FOR UPDATE` (ownership commands only, sorted)
4. `routing_rotation_state`, then candidate `memberships` (sorted), system actor only

Ownership commands previously locked only the row while ingestion and dispatch locked only the advisory key, so neither excluded the other. A reassignment could then commit between ingestion reading the owner and inserting the handback. The handback went to an owner who had just lost visibility, and the new owner never heard that the client replied.

**Ownership change and open handbacks.** The `ownership.followup` of any owner change re-homes open handbacks (`assistant_actions kind='handback' status='proposed'`) and their feed items to the new owner, or to the TL when the lead is no longer owned. It invalidates the previous owner's drafts. Combined with the lock order, a handback can never be stranded with an owner who cannot see it.

**In-flight sends.** A dispatch that loses the race to the advisory lock sees the pause and denies. One that committed `dispatching` first goes out (a millisecond window), and the handback says so honestly ("sent at the same moment Jane replied"). The DB guard re-checks the pause flag in the dispatch transaction.

**Scope.** Human-scheduled messages are not cancelled; they require a re-tap. Auto-replies (OOO headers) still pause, but are labelled as such and offer one-tap resume. Resume is always a human action (DB guard) and is audited. Imported history never pauses anything.

---

## 11. Assistant lifecycle (A2, A3, A4, A7a/b)

```
trigger (lead created, inbound, call ready, playbook step, agent asks)
  → job: build ONE-contact context (plus their deals/listings, tenant identity, the requesting agent's own sent
         messages for tone) → AiProvider → ai_runs (output encrypted, purged after 30 d; internal_signals never exposed)
  → core.assistant.normalize: claims[] with evidence_refs[]; core.verifyQuote(source, snippet) per ref
         (transcript refs must fall inside [start_ms, end_ms]); failure ⇒ needs_review
  → assistant_actions(status='proposed') + claims + evidence    (deferred DB trigger: asserted claim ⇒ verified evidence)
  → classify: autonomy = within_playbook (approved version + autonomous category + content guard + novelty check)
               | requires_approval | internal
  → within_playbook ⇒ message queued ⇒ dispatchOutbound (send-time gate)          [no human tap]
    requires_approval ⇒ feed card ⇒ agent Send / Edit / Dismiss ⇒ approve (DRAFT_STALE if the client replied since;
                       invalidated if ownership changed) ⇒ dispatchOutbound with initiator='assistant' + approval
```

- **Evidence over confidence.** UI display is `{claim} — {source} {locator}` ("Callback due Thu Nov 12, 4 PM — 'call me Thursday around four' at 2:14 in the call"). Tapping it opens the source at that offset. Confidence never appears in agent-facing schemas (a snapshot test on the Zod/OpenAPI output). Needs-review claims are shown with "Check this" and are never inserted into outbound text, search criteria or task due dates.
- **Autonomy policy ("approve rules, not every message").**
  - The autonomous categories are `speed_to_lead_reply`, `reminder`, `booking_confirmation`, `nurture_step` and `search_alert`, on by default. `document_chase` is off by default.
  - `money`, `contract`, `novel_message` and `seller_update` **always** need a tap (DB CHECK). The content guard downgrades any draft that mentions price negotiation, offers, commission, earnest money, contracts, wires, or account numbers. Payment instructions are hard-denied for every initiator.
  - Ad-budget changes (Phase 3) fall in the `money` category.
- **Playbooks.** A version is frozen once it leaves draft. Approvals are append-only and hash-bound, with the attestation the approver tapped. Editing means a new draft, and the old approved version keeps running until the new one is approved; enrollments then migrate at step boundaries. Agent playbooks are approved by their agent; team playbooks by Owner/Admin (DB trigger). There is one live enrollment per contact (DB unique). Revoking an approval pauses every enrollment on that version.
- **Built-in templates.** They ship inactive and are approved once during setup: `new_lead_response` (team), `nurture` (agent), `post_closing` (agent, enrolled at deal close; the home-value step is defined but skipped until the AVM exists), `booking_confirmation`, `reminder`.
- **60-second first response.** At T0, lead intake creates the contact, the offer and timer, attribution, and a `new_lead_response` enrollment. Within seconds a realtime job sends **one** message (SMS to a reachable mobile number unless it opted out or is suppressed, else email; since D1 no consent basis is required). It asks one or two qualifying questions: timeline, financing, and the VA-loan question only when the source or form indicates it. It is signed "— the {Team} assistant", and the first message in a thread also carries the brokerage name and "Reply STOP to opt out". There are no quiet hours since D1: the reply goes out at once, at any hour (VERIFY WITH COUNSEL, §19). Any reply hands off to the agent. Multi-turn autonomous qualification is Phase 2. The p95 target is under 60 s, monitored as an internal alert.
- **Saved buyer searches (A4).** After a call, the assistant proposes `saved_searches(status='proposed')`. Each criterion maps to a claim with call evidence, and criteria from needs-review claims are prefilled but unchecked. The agent edits and approves from the contact record, which the DB requires to be a human approval. Matches preview real listings from the team's own `listings`. Alerts go out as `search_alert` through the gate, with SMS only on `express_written`.
- **Seller updates (A4).** Showings, feedback and marketing activity are captured in Phase 1 tables. Assembly is Phase 2, as `seller_update_draft`, and is never autonomous.
- **Genuineness.** Every autonomous message carries the identity sign-off. A content guard rejects first-person human claims ("this is Sarah") unless followed by the assistant identity. AI voice does not exist in Phase 1 (DB CHECK on `calls.initiator`/`handled_by`). The FCC treats AI voices as artificial under the TCPA (**VERIFY WITH COUNSEL**).
- **Prompt-injection posture.** Inbound content is delimited as untrusted. The model has no tools and sees exactly one contact. Outputs pass the same content guard and gate as any other message.
- **Fair housing.** `contact_attributes.sensitivity='protected_proxy'` (VA, PCS, military status, source of income …). These are self-reported only (DB CHECK) and excluded by type from feed scoring and any future prediction input (**VERIFY WITH COUNSEL** on the protected-class list per jurisdiction).

---

## 12. Notifications: delivery guarantees

- **Model.** `notifications` (per user, `dedupe_key` unique, PII-minimized title/body: first name + last initial at most, or nothing per tenant setting) and `notification_deliveries` (one row per channel and target, unique). Delivery rows are created in the same transaction as the cause, so a committed cause always has its delivery rows (outbox).
- **Guarantees.**
  - Delivery is **at least once per (notification, channel, target)**, with the provider idempotency key = delivery id.
  - Retries use jittered exponential backoff (1 m, 2 m, 5 m, 15 m, 1 h); after that the delivery goes `dead` with a platform alert.
  - In-app delivery is the durable record: the feed and the notification list are always correct even if every push fails.
- **Critical kinds** (`lead_offer`, `first_touch_due`, `handback_hot`):
  - They cannot be muted (DB CHECK) and always keep web push or SMS.
  - Personal quiet hours never suppress them while the agent is accepting leads.
  - SMS-to-agent passes `canContact(recipient=user)`.
  - Routing never offers a lead to a user with no working critical channel (eligibility check).
- **Lock screens.** Push and agent-SMS bodies never contain phone numbers, emails or message bodies.
- **Ordering.** No cross-notification ordering is promised. Each item carries `created_at`, and the client sorts by it.

---

## 13. FUB migration and CSV import (A6)

```
connection/export test (counts only — no promises before this) → snapshot (encrypted raw records, sha256)
→ per-stage DRY RUN in dependency order: contacts → ownership → notes → messages → call_recordings → consent
   each: source | will import | needs review | rejected | duplicate, plus a per-record review list
→ approve stage (DB CHECK: dry run + approval) → commit EXACTLY the reviewed snapshot records (1,000/tx, resumable)
→ verify stage (recount source vs DB, 20 side-by-side spot checks, Admin taps Verified)
→ next stage may commit only after earlier stages are verified or skipped (DB trigger)
→ report: imported vs needs-review per category; reverse per batch/stage (untouched rows deleted or compensated;
  touched rows listed for a human decision)
```

- **Opt-outs and consent history.** Opt-out, do-not-contact and unsubscribe flags become revocations or suppressions at full strength at commit, so a STOP in Follow Up Boss carries over and blocks sending here exactly like a STOP received here (critical). Positive FUB indicators become `grant` at `imported_unverified` (DB CHECK), with the verbatim provenance, as history only: since D1 no send reads a consent level. A revert voids imported grants and **never** imported revocations. Skipping this stage means the old system's opt-outs do not carry over, and the import page says so.
- **Ownership.** The user mapping must be complete. Imported assignment uses `imported` ledger events: no offers, no SLAs, no scoreboard effect.
- **History.** Notes, messages and calls are `imported = true` with original timestamps. They never pause, hand back, count toward SLAs, or create exceptions.
- **Recordings.** Recordings are copied into encrypted storage and labelled "recording notice unknown". They are not transcribed by default.
- **FUB key.** The FUB API key is encrypted and purged at most 30 days after the last stage is verified.
- **CSV.** CSV uses the same machinery with a contacts stage and an optional consent stage, up to 50k rows.

---

## 14. Search, accountability, scoreboard

- **Search.** One API runs per-entity queries in parallel under the caller's RLS:
  - contacts: `search_tsv` (simple config) plus trigram on `display_name`
  - `contact_points.address`: trigram; phone digits normalize to the last 7–10 digits
  - `notes.search_tsv`, `messages.search_tsv`
  - `listings.search_tsv` plus address trigram

  Each branch returns at most 10 rows under a 300 ms statement timeout. Transcripts are not searchable (encrypted). Pond-card contacts appear by name only; their points and messages are hidden by RLS. No search index lives outside Postgres.
- **Team Lead live exception queue (A5).** `core.accountability.deriveExceptions(snapshot, now)` is pure and deterministic. It upserts `exception_items` by `dedupe_key` and sets `condition_cleared_at` when the condition goes away. Keys are **per occurrence**, so an earlier resolution can never cover a new miss. The types and their keys are:
  - `untouched_lead` (`untouched:{contact}:{ownership_period_seq}`): an ownership period that started an SLA and had no human touch by its `first_touch_due_at`. It is derived from the **ledger** (`v_speed_to_lead`), not the current projection, so auto-release does not erase the miss. The item's owner is the agent who missed.
  - `overdue_promise` (`promise:{task}`): a promise task, extracted with evidence, past due and open.
  - `failed_send` (`send:{message}`): blocked, failed, undelivered, bounced, unknown for more than 10 min, or stuck dispatching for more than 20 min.
  - `missing_outcome` (`appt:{appointment}`): a consult or appointment that ended more than 2 h ago with no outcome logged.

  **Queue semantics.** An item is in the live queue while its latest human event is none or `reopened`, **whether or not its condition has cleared**. A cleared but unhandled item shows "fixed late" and still needs Resolve or Verify. It leaves the queue on `resolved` or `verified`.

  Human actions go to append-only `exception_events`:
  - resolve (a note is required)
  - reassign (through the ownership engine; the command id is recorded, and a DB trigger requires a real `reassigned`/`assigned` ledger event by the same actor, on this item's contact, after detection)
  - verify (Team Lead, Admin or Owner only, enforced by a DB CHECK and policy)
  - reopen

  Recomputation never loses human actions.
- **Scoreboard (A7e) and momentum.** These are SQL views (`v_speed_to_lead`, `v_agent_activity_daily`, `v_pipeline_momentum`) with `security_invoker` so the caller's RLS applies, and every number shows its denominator. Speed-to-lead comes from the ownership ledger. Touches count human outbound only. Momentum compares current stage dwell with the tenant median (aggregate-only definer `app.stage_dwell_norms`) and flags `> 1.5×` when the sample is at least 5. Goals and weekly plans are Phase 2 (the `agent_goals` table exists).

---

## 15. Observability and logging

- Logs carry ids, codes and timings only. A redaction layer drops known PII keys and masks E.164 numbers and emails in strings. Transcripts, message bodies and prompts are never logged.
- Metrics:
  - offer-to-accept and first-touch latencies (from the ledger)
  - job pickup lag per queue
  - dead jobs
  - `dispatch_unknown` and stuck `dispatching` counts
  - drift-check mismatches
  - blocked-send rates by reason (gate_decisions)
  - 60-second first-response p95
  - webhook signature failures
- Alerts (all P1): drift mismatch, dead realtime jobs, sweeper lateness over 60 s, unrouted inbound, a SECURITY DEFINER function added without review (CI).

---

## 16. Residual risks (accepted, with mitigations)

| Risk | Mitigation |
|---|---|
| A compromised API process can set any GUC (including `actor_kind='system'`, which is tenant-wide inside one tenant) | Actor is a type-level construction; `system` is only constructible in the worker entrypoint (lint + test). Open question Q3: a separate worker login role. |
| TCPA / state mini-TCPA exposure from relying on third-party consent (owner decision D1) | **Accepted by the owner.** No send checks a consent level, the DNC registry, quiet hours or frequency caps. Mitigations: opt-outs block every send with no override (DB guard as well as core); brokerage identity, unsubscribe and STOP hints on marketing; consent events (opt-ins as history) are still recorded with their evidence, so a basis can be shown later; reinstating the removed checks is a rules + policy change, not a rebuild. **VERIFY WITH COUNSEL** (§19). |
| No DNC registry check | Since D1 the registry is not consulted for any send. `dnc_checks` and the DNC provider interface are kept but unused. Agent-recorded "do not call me" and imported do-not-contact flags still block. **VERIFY WITH COUNSEL.** |
| Agent self-certified consent (`agent_entry`, max `express`) | Recorded as history only since D1; it no longer changes who can be messaged. |
| Plaintext PII in backups for 35 days after erasure | Only encrypted fields are crypto-shredded. **VERIFY WITH COUNSEL.** |
| Message bodies and summaries in plaintext | Needed for search; protected by RLS + disk encryption. |
| RLS performance with large visibility arrays (a TC on 1,000 deals) | InitPlan-wrapped helpers, indexed predicates; benchmark at 250k–500k contacts per tenant before launch. |
| Lock-screen leakage | Minimal push bodies (first name + initial, or none). |
| Jurisdiction packs shipping unreviewed | UI states it honestly; conservative placeholders. |
| Superuser in production | No superuser in app paths; vaulted break-glass credentials; pgaudit. |

---

## 17. Draft reconciliation (conflicts and resolutions)

| # | Topic | Tenancy draft | Ownership draft | Comms draft | **Resolution** (and why) |
|---|---|---|---|---|---|
| C1 | AI sending | AI never sends (cut auto-replies) | No automated outbound in Phase 1 | Playbook autonomy + 60-second first response | **Comms + A3/A7a/b (amendments win).** Autonomy only inside approved, hash-frozen playbooks; send-time gate; atomic pause; always-human categories DB-enforced. |
| C2 | Confidence | `confidence numeric` on drafts | reasoning + confidence band shown | confidence only in `ai_runs.internal_signals` | **Comms + A2.** Evidence refs with verified quotes; no confidence in agent-facing schemas. |
| C3 | Intra-tenant visibility | RLS Layer 2 in Postgres | app-layer visibility module | app layer + RESTRICTIVE on recordings | **Tenancy (safer).** All visibility in RLS, plus the recording-scope RESTRICTIVE policy from comms. |
| C4 | Ownership storage | columns on contacts, `ownership_version` +1, deferred ledger check | separate projection, gapless `seq` ledger, command GUC | `leads` + `lead_offers` tables | **Ownership semantics on the tenancy location.** Projection columns on `contacts` (RLS-friendly), with the ownership draft's gapless per-contact ledger, `app.ownership_command` guard and fences. Rejections go to a separate append-only log (Design Review F3). Offers live in the projection + ledger (no `lead_offers` table). |
| C5 | Ownership states | `archived` | `closed` (+ reopen) | `released`, `converted` states | **Ownership draft's 5 states** (`closed` with reason). Fewer concepts; deterministic. |
| C6 | Concurrency | optimistic version predicate | pessimistic `FOR UPDATE` + seq | optimistic `version` | **Both:** `FOR UPDATE` lock **and** an `ownership_seq` predicate (belt and braces); DB clock read after the lock. |
| C7 | First-touch breach | auto-release at 30 min | notify only (configurable) | n/a | **Notify + exception at 15 min, auto-release at 30 min (configurable, NULL disables).** The spec requires auto-release; the exception queue covers coaching. |
| C8 | After-hours leads | hold offer until 07:00 | offer now, window counts in routing hours | n/a | **Ownership (deterministic, faster for the agent):** offer immediately; window in business time 08:00–21:00. |
| C9 | Claim cap / cooldown | 10/day | 5/day + 72 h cooldown + capacity 5 | n/a | **Stricter: 5/day, 72 h cooldown, capacity 5.** |
| C10 | Consent key | HMAC(address), basis levels | per contact_point consent_records | plaintext address + purpose + levels | **Comms model keyed like tenancy:** `(channel, purpose, address_hmac)`, levels `none < imported_unverified < inquiry < express < express_written`, no plaintext address in any consent/suppression/DNC/gate table. |
| C11 | Opt-out override | Owner/Admin override with re-auth + evidence | Admin re-consent with evidence | no staff can lift an opt-out | **Comms (strictest):** reinstated only by the person's own action (START restores only keyword revokes; new disclosed form; signed document recorded with evidence). |
| C12 | Opt-out scope | tenant-wide | tenant-wide | tenant-wide + all of the contact's phones | **Comms (strictest).** |
| C13 | Quiet hours | 09–20 contact-local; manual blocked except a 12 h reply window | 08–20; manual warn within 30 min | floor 08–21; automated 09–20; human inside floor allowed | **Strictest combination:** 09:00–20:00 for **all** SMS/voice; human outside ⇒ deny except an informational reply within 30 min ⇒ needs_confirmation; Owner may widen to the 08–21 floor only with attestation. **Superseded by D1 (§20): removed from the send-time check.** |
| C14 | Frequency caps | email 1/day 4/week | manual SMS warn > 3; calls 3/24 h | SMS + email 1/24 h 3/7 d; cross-channel 2/24 h | **Strictest:** comms caps + manual SMS confirmation > 3/24 h + 3 call attempts/24 h. Tenants may only lower (DB CHECKs). **Superseded by D1 (§20): removed from the send-time check.** |
| C15 | DNC | no scrub; per-call confirmation | block cold numbers (no inquiry/relationship) | `dnc_checks` + human confirmation | **Ownership's block + comms' `dnc_checks` table:** deny when listed without express_written, or unknown with no unexpired basis. **Superseded by D1 (§20): removed from the send-time check.** |
| C16 | Imported consent | `attested` basis possible | conversational only if attested | capped at `imported_unverified` | **Comms (strictest, A6).** |
| C17 | Session idle | 7 d | 12 h | 30 d sliding / 12 h shared | **7 d idle / 30 d absolute,** rotation on login/privilege change, re-auth 15 min for sensitive actions, TOTP for Owner/Admin. Mobile-first agents (A1) would re-login daily at 12 h; the other controls carry the risk. |
| C18 | MFA | required Owner/Admin in Phase 1 | Phase 2 | Phase 2 | **Tenancy (safer):** required; settings CHECK keeps owner+admin in the list. |
| C19 | Commission fields | cut (separate table later) | Phase 2 | on `deals` | **A7d wins (capture now)** in a separate `deal_financials` table (separate RLS: human Owner/Admin/deal owner/TL only; assistant cannot read or write). |
| C20 | Deal stages | configurable `pipeline_stages` | seeded `deal_stages` | fixed CHECK + history | **Fixed list + `deal_stage_history`** (fewer concepts; momentum metrics). Custom pipelines are Phase 2. |
| C21 | Showings / marketing activity | n/a | n/a | specified, not migrated | **A4 wins:** migrated now (`showings`, `showing_feedback`, `marketing_activity`, `home_valuations`, `agent_goals`) as data model; only showings logging has a Phase 1 UI. |
| C22 | Messages model | single `interactions` | `messages` + `calls` + `timeline_events` | `conversations` + `messages` + `calls` + gate decisions | **Comms**, with timeline as a `security_invoker` view (no extra projection table to drift). |
| C23 | Gate evidence | `compliance_decision` jsonb on the row | `gate_decision` jsonb | `gate_decisions` append-only table + CHECK | **Comms + a stricter DB guard:** the decision must be `allow`, the same channel, and ≤ 10 min old at dispatch (send-time, not schedule-time). |
| C24 | Contact points | `contact_phones` + `contact_emails` | `contact_points` | `contact_points` | **`contact_points`** with `address_hmac` (tenancy) to join consent keys. |
| C25 | Jobs table | uuid; dedupe per tenant | bigint; dedupe per queue | bigint; app_worker role | **bigint identity, per-tenant dedupe, INSERT-only for app_user, definer claim.** No extra DB login role (fixed stack); the separate worker role is open question Q3. |
| C26 | Session GUCs | tenant, user, actor_kind | tenant, user, role, ownership_command | tenant, user, role, principal_type | **tenant_id, user_id, actor_kind, principal_type, ownership_command.** `app.role` is NOT trusted from a GUC; role is always looked up from memberships by the definer `app.my_role()`. Each extension only narrows (fail closed). |
| C27 | Consent projection integrity | updated in same tx | n/a | nightly drift check | **Both + a DB guard:** `consent_state.ledger_event_count` must equal the ledger count for the key at write time. |
| C28 | Recording retention | 730 d | 24 months | 24 months | **730 days** (same), range 30–3650; legal hold. **VERIFY WITH COUNSEL** vs license-law retention. |
| C29 | Phone number uniqueness | global unique live + 90-day quarantine | global unique | unique per tenant + global `inbound_routes` | **Tenancy (safer):** global unique live e164 + 90-day cross-tenant quarantine trigger; no separate routes table. |
| C30 | Team playbook approvers | n/a | open | Owner/Admin | **Owner/Admin** (stricter); TL approval is an open question. |
| C31 | Support access | time-boxed grants, read-only | Phase 2 | n/a | **Tenancy (keep):** cheap now, and prevents unaudited psql access. |
| C32 | Export | Owner-only, re-auth | Owner/Admin | n/a | **Cut from Phase 1** (largest exfiltration vector; not in Phase 1 scope). |

---

## 18. Explicitly OUT of Phase 1 (cuts and deferrals)

| Item | Status | Why |
|---|---|---|
| Multi-turn autonomous qualification; AI auto-replies beyond one first message | Phase 2 | TCPA and accuracy risk; single message + handoff covers A7a |
| AI voice: answering, outbound, warm transfer | Phase 3 (DB CHECK forbids now) | FCC artificial-voice rules; disclosure laws |
| Power dialer, voicemail drop, ringless voicemail, bulk SMS/email blasts, outbound MMS | Cut | High TCPA exposure; not needed to beat FUB daily |
| Calendar sync (Google/Microsoft), Gmail/Outlook inbox sync | Phase 2 | OAuth scope and security review; in-app appointments only |
| Unified inbox channels beyond SMS/email/call (FB/IG DMs, Zillow feeds, web chat) | Phase 2 (channel CHECK widens) | data model shaped (`messages.channel`, one conversation per person) |
| Marketing generation, listing marketing, review automation | Phase 2 | — |
| Seller-update assembly, competing listings (MLS feed), monthly home-value updates (AVM) | Phase 2 (tables exist) | licensing / provider needed |
| Goals and AI weekly plans | Phase 2 (`agent_goals`, `assistant_actions.kind='weekly_plan'` reserved) | A5 says exception queue first |
| Owner dollars view (source → commission reporting) | Phase 2 (data captured now) | A7d |
| Call scoring, coaching, 90-day prediction, ad-spend reallocation, client portal | Phase 2–3 | client portal: `principal_type` reserved; RLS denies non-staff today |
| Custom fields, custom stages, custom pipelines, configurable feed weights | Cut / Phase 2 | config sprawl; FUB custom fields → read-only `imported_fields` |
| Complex routing (geo polygons, schedules, holidays, language, boolean builders) | Cut | 4 match fields × 4 strategies only |
| Contact and deal document attachments | Phase 2/3 | malware scanning, retention; `stored_objects` is ready |
| Transcript full-text search | Cut | would require a plaintext copy of encrypted data |
| Contact export (any role) | Phase 2 (Owner-only, re-auth) | exfiltration vector |
| Unmerge | Phase 2 | merge payload keeps the data needed |
| Hash-chained audit seals | Phase 2 | `audit_log.seq` keeps gaps detectable |
| SSO/SAML, WebAuthn | Phase 2 | TOTP for Owner/Admin covers Phase 1 |
| National DNC vendor integration | Not needed for sending since D1 (the registry is not checked); fake + upload kept | revisit only if the owner reinstates the registry check |
| Brokerage hierarchy above tenants, cross-tenant reporting | Phase 3 | — |
| STIR/SHAKEN display, branded caller ID | Phase 2 | — |

---

## 19. Open questions and the VERIFY WITH COUNSEL register

**Counsel (every item ships with the default shown in DATA_MODEL; since D1 several are owner decisions, not strict defaults):**
- **Relying on third-party consent, and running without quiet hours and frequency caps (owner decision D1).** Every lead is treated as consented through its source, and no send checks a consent level, the DNC registry, the time of day or how often a person was contacted. Even with valid consent, some state "mini-TCPA" laws may still limit this: for example, Florida's Telephone Solicitation Act (FTSA, amended in 2021 and 2023) limits telephonic sales calls, which may include texts, to certain hours of the day and to a few per person per 24 hours, and Oklahoma and Maryland have passed similar laws. We have not verified how these apply to this product. Whether these apply to a given team's messages (which texts are "telephone solicitations", what counts as consent, interstate reach) needs counsel. Reinstating time-of-day or per-24 h limits is a policy and rules change (a new core rules version plus policy fields), not a rebuild.
- SMS consent basis for (a) manual one-to-one texts to web leads, (b) the 60-second assistant response, (c) nurture; one-to-one and lead-generator consent rules. (Since D1: not checked at send time; the ledger keeps the history.)
- Quiet hours per state; restricted days and holidays. (Since D1: not applied; see the first item.)
- Opt-out keyword list, natural-language revocation, confirmation content and timing; HELP response.
- Recording disclosure wording, all-party states, interstate calls; Team Lead access to team recordings (employee-monitoring rules).
- Retention: recordings (730 d), consent evidence and gate decisions (≥ 5 years after last activity), audit (7 years), backups after erasure.
- DNC: which texts are "telephone solicitations"; scrub validity (31 d); inquiry basis window (90 d); established-business-relationship use. (Since D1: the registry is not checked for any send.)
- AI identity disclosure (assistant sign-off wording) by state.
- Fair housing: protected classes and proxies per jurisdiction (military status, source of income).
- Jurisdiction advertising packs (e.g. South Carolina team-name rules) and brokerage name placement.
- Privacy erasure applicability and exemptions (transaction records).

**Product and engineering:**
- **Q1.** ~~Is `imported_unverified` ever enough for assistant nurture to migrated FUB contacts?~~ Answered by D1: consent level no longer gates sending; only imported opt-outs block.
- **Q2.** Can Team Leads approve team playbooks? (Owner/Admin by default.)
- **Q3.** Should workers use a separate DB login role so that only it can act as `system`?
- **Q4.** Is a 30-minute auto-release too aggressive for small teams?
- **Q5.** Should the previous owner get first right of refusal when a pond lead re-inquires? (Default: no; re-route.)
- **Q6.** Should handbacks that stay unhandled past an SLA become an A5 exception type? (Default: rising feed urgency.)
- **Q7.** Should we use the provider's managed opt-out confirmation (default) or our own?
- **Q8.** Which email and inbound-parse provider?
- **Q9.** Data residency and KMS requirements?
- **Q10.** Who owns client data when an agent leaves? (Assumed: the tenant.)

---

## 20. Design Review Log (adversarial review of Phase 1, round 1)

Each finding was re-checked against the design text and the schema before any change. `0001_init.sql` has not shipped, so it was corrected in place. After every change, `realty_verify` was dropped and recreated, the migration was applied with `ON_ERROR_STOP=1`, and `rls_smoke.sql` was run, also with `ON_ERROR_STOP=1`. Both pass; the smoke suite is now 89 checks.

| Id | Sev | Verdict | Resolution |
|---|---|---|---|
| F1 | high | **Real, fixed** | Under a user actor, RLS hides other candidates' memberships (`FOR SHARE`), push subscriptions, `claim_stats` and the rotation cursor. Routing now runs **only as the system actor**. A decline commits `offer_declined` → `unassigned` with a new guarded `route_due_at`, and the new `ownership.followup` job routes. A late accept is a rejection only; the already-due expiry timer re-routes. The sweeper has a `route` branch as backstop. §5, R-OWN-8/10, E2/E5. Smoke: agent sees 0 of another agent's claim stats and locks 1 of 3 memberships; system sees and locks all; decline then system re-offer; sweeper finds a lost route. The alternative, a SECURITY DEFINER routing snapshot, was rejected because it adds definer surface for no gain. |
| F2 | high | **Real, fixed** | Added `due_work` branch `dispatch_stale`: `dispatching` with `dispatched_at` older than 20 min (max lease 15 + margin) → `dispatch_unknown` → reconcile, never a blind resend. Added CHECK that `dispatching`/`dispatch_unknown`/`sent`/`delivered` ⇒ `dispatched_at`. `failed_send` now counts dispatching > 20 min. Corrected the `reap_stuck_jobs` comment. §6, §9, R-GATE-8, E7; kill-the-worker tests in BUILD_PLAN module 9. Smoke: CHECK, plus `due_work` surfaces a 30-minute-old dispatch. |
| F3 | high | **Real, fixed** (narrower than reported) | Only `command_rejected` was truly broken. Non-state events (`inactivity_warned`, `reinquiry`) could already advance `ownership_seq`, because the new `ownership_command_id` counts as a guarded change. Rejections moved out of the gapless ledger into the new append-only `ownership_command_rejections` table. It is insertable as self or system only inside the named command, and needs no contact visibility, because the loser of a race cannot see the contact. That also fixes a second bug: the E1 loser could not insert a ledger row at all under RLS. `contacts.ownership_seq` is now defined as the ledger head and enforced by guard `OWNERSHIP_SEQ_HEAD`, and fold compares all events. The two-counter alternative was rejected as more concepts for the same guarantee. Smoke: loser logs a rejection; forging another user's or another command's rejection fails; the log is append-only; projection behind head is rejected; the next command after a rejection succeeds at `seq + 1`. |
| F4 | medium | **Real, fixed** | One global lock order (§10): address locks → `app.lock_contact` → contacts `FOR UPDATE` (ownership commands) → rotation/memberships (system). `applyOwnershipCommand` now takes `app.lock_contact` first, so ownership commands, inbound ingestion and dispatch exclude each other. This also removes a latent row-lock/advisory-lock deadlock between inbound and ownership commands. Owner-change follow-up re-homes open handbacks and feed items to the new owner and invalidates the previous owner's drafts as the system actor; a TL cannot write another agent's assistant actions or feed items. E65. A pure SQL smoke test cannot express a two-session race; it is a module 7 integration test. Rejected: contacts `FOR SHARE` in inbound/dispatch, because a TC or system webhook may lack UPDATE visibility; the advisory lock suffices once every writer takes it. |
| F5 | medium | **Real, fixed** | Touch instant = commit of the gate-allowed human dispatch (TX1) or the dial-time decision. It is written in that transaction through `applyOwnershipCommandInTx`, under the same contact locks as `auto_release`/breach. Exactly one wins; a send that loses is blocked, so no client text from an agent who just lost the lead. R-OWN-14, §5, §9, E66. Rejected: reversing the touch on provider failure, which adds reversal events; `failed_send` already surfaces it. |
| F6 | medium | **Real, fixed** | Stored `inactivity_warn_at` / `inactivity_release_at` on contacts, computed by core with the settings in force at ownership start and each human touch, and cleared outside `owned` (CHECK). `due_work` reads only stored instants, so the session-timezone `make_interval` math is gone. Disabling (NULL) is honoured at fire time, which only ever favours the agent. R-OWN-15/23, E67. Smoke: lowering `inactivity_release_days` makes nothing overdue; the stored instant fires. |
| F7 | medium | **Real, fixed** | New definer trigger `exception_events_guard`. A `reassigned` event must cite a `reassigned`/`assigned` ledger event of the item's contact, by the same user actor, at or after `detected_at`. A rejected command cannot be cited, since rejections are not in the ledger. New CHECK: reassigned ⇒ role TL/Admin/Owner. Smoke: the reported agent forgery now fails; an Owner citing a made-up command fails; a real reassignment is accepted. Optional binding of resolve/verify to a detection was rejected as redundant with F11's per-occurrence keys. |
| F8 | medium | **Real, fixed** | R-OWN-22 step 4 now ends in `removed` (with `removed_at`) after a final re-check under the contact locks. No schema change. Smoke: `deactivating` → `removed` succeeds. |
| F9 | medium | **Real, fixed** | New BUILD_PLAN module 10 `api/admin` (invites, member role/status with re-auth and audit, routing rules/members, ponds, teams, settings, brokerage identity, policy versions with attestation). Modules renumbered (17 total). Its acceptance test: a tenant set up through the API only gets its next inquiry offered to an invited agent. |
| F10 | low | **Real, fixed** | Tap-count criteria moved to module 17 (web). Delivery latency moved to module 14. Push-subscription and alert-phone registration moved to module 8, so routing eligibility is testable in module 11 without seeded rows. `exceptions.recompute` now runs every 60 s per active tenant, which meets the 60 s criterion for time-only conditions. The proposed extra `due_work` branches were rejected as bloat. |
| F11 | low | **Real, fixed** | Per-occurrence dedupe keys (`untouched:{contact}:{ownership_period_seq}`, `promise:{task}`, `send:{message}`, `appt:{appointment}`). `untouched_lead` is derived from the ledger per ownership period, so auto-release no longer erases the miss. Cleared-but-unhandled items stay in the queue ("fixed late") until resolved or verified. §14, R-ACC-1/2, E68. |
| F12 | low | **Plausible, fixed in design** | R-OWN-24 now covers communication and automation. Messages and calls are re-pointed to the survivor's conversation. The pause wins: the earliest pause is kept. The loser's enrollment is stopped `merged`. Handbacks and drafts move to the surviving owner. All of this happens in the merge transaction under both contact locks. E69; module 7 merge test. No schema change. |
| F13 | low | **Real, fixed** | New guarded `contacts.ownership_period_seq` (owned ⇔ not null, ≤ `ownership_seq`). Breach, auto-release and inactivity are fenced on (period seq, stored deadline), so in-period events no longer stale the auto-release job. The same column binds drafts (R-AST-7), so a first touch no longer invalidates pending drafts. E70. |

Net schema change: +1 table (`ownership_command_rejections`), +4 `contacts` columns (`ownership_period_seq`, `route_due_at`, `inactivity_warn_at`, `inactivity_release_at`), +1 trigger (`exception_events_guard`), +2 `due_work` branches (`route`, `dispatch_stale`), and 4 CHECKs. The `command_rejected` ledger type was removed. Totals: 94 tables, 4 views, 541 policies.

### Owner decisions after round 1

| Id | Date | Decision | What changed | What was deliberately kept |
|---|---|---|---|---|
| D1 | 2026-11 | Every lead consented through third-party sources; for the send-time consent/compliance decision the owner chose **"Remove the check entirely"**, keeping only a narrow opt-out block. | core-compliance/2.0.0 (`RULES_VERSION` bumped): `canContact` returns only allow or deny. Removed: consent basis (old check 8), DNC registry (9), contact window / quiet hours, jitter and the human reply window (11), frequency caps for automated, manual SMS and calls (12), weak-timezone notice (13), the `defer` outcome and everything that only resumed deferred sends (`playbook_step_runs.deferrals` and its `deferred` status, `messages_caps_idx`), `needs_confirmation` and the "send anyway" / "call anyway" flow, the per-send `gate_decision_id` CHECKs and the 10-minute staleness rule. Migration 0013 (never editing earlier ones) drops those CHECKs and the 12 policy columns, makes `gate_decisions` a log of blocked sends only, and replaces `messages_dispatch_guard` / `calls_dispatch_guard` with versions that add a DB-level opt-out block. Web: no consent prompts or pickers, no quiet-hours/cap settings, no defer or confirm badges; the opt-out state is said wherever a send or call button appears ("Won't text: Opted out of texts"), and the import consent stage is "Opt-outs and consent history". DATA_MODEL marks R-CONSENT-13/14/15, the R-CONSENT-5 table and E29/E30/E36 **Retired**; R-GATE-1/3/5/6/10/11 are rewritten. | Opt-outs (STOP and other keywords, revoking the contact's other phones for SMS; email unsubscribe; agent-recorded do-not-contact; active suppressions), with no override for any role, in core **and** in the DB guards. Assistant autonomy (A3/A7): only approved autonomous categories inside an approved playbook; money, contracts and a new kind of client message always need a human tap; no automated voice; an inbound reply atomically pauses and hands back; the autonomy half of `messages_dispatch_guard` is verbatim. Operational sanity (tenant suspended, invalid/wrong number, landline SMS, missing/unregistered sender), brokerage name on marketing (A7f) and postal address + unsubscribe on marketing email, the payment/wire block, call-recording consent (R-CONSENT-16, a different law), and the FUB consent import (opt-outs still carry over; opt-ins become history). `dispatch_stale` recovery of stuck dispatches is unchanged. **VERIFY WITH COUNSEL** (§19, first item). Known limits: agent-alert SMS has no DB guard (no stored HMAC for `alert_phone_e164`; the single send path checks it); the DB exempts a STOP/HELP reply only within 24 h of the keyword. |

### Rule-coverage fixes (lane migration `0016_rule_coverage.sql`)

Found while proving the last uncovered rules end to end; each is tested as `app_user` in `packages/db/test/rule_coverage_0016.test.ts`.

| Id | Rule | Gap found | Resolution |
|---|---|---|---|
| G1 | R-PERM-11 | The 72 h CHECK measured from a caller-supplied `created_at` (a grant "created" in the future lasted longer), and an Owner could UPDATE `created_at`/`expires_at` forward. | `support_access_grants_guard`: `created_at` is the DB clock, `granted_by` is the calling Owner, revocation is the only change. |
| G2 | R-PERM-11 | The support read-only policies cover RLS paths only; a SECURITY DEFINER function accepting `is_tenant_wide()` (e.g. `app.revoke_member_sessions`) let a support actor write. | A statement-level `support_read_only` trigger on every public table refuses INSERT/UPDATE/DELETE/TRUNCATE under a support context, whichever role runs it. Tables added after 0016 need the same trigger (the test checks every table). |
| G3 | R-AUDIT-6 | `loe_select` used `sees_all_detail()`, so every Team Lead read the whole tenant's ownership ledger. | The Team Lead branch reads events involving a member of a team they lead, contacts such a member owns now, and their own collaborator/deal contacts. |
| G4 | R-AUDIT-9 | `app.retention_sweep(p_now)` accepts any `p_now`, and audit rows could be inserted back-dated, so young rows could be swept. | `audit_log_retention_floor` keeps any row younger than `app.audit_retention()` (7 years, **VERIFY WITH COUNSEL**) by the real clock; non-superusers cannot insert a back-dated audit row. |
| G5 | E59 / R-DATA-4 | Erasure is refused for a contact on a deal, but `deals.primary_contact_id` was NOT NULL, so the Owner could never remove the person from a closed single-contact deal. | `primary_contact_id` may become NULL only by an Owner on a closed or lost deal (`deals_primary_contact_guard`); the deal stays as the transaction record. API: `GET /contacts/:id/erasure`, `POST /contacts/:id/erase`, `POST /deals/:dealId/contacts/:contactId/remove` (audited `deal.contact_removed`). **VERIFY WITH COUNSEL**: what a transaction record must keep (the deal name may still mention the person). |
