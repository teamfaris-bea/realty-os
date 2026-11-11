# Realty OS: Phase 1 Architecture (authoritative)

Status: **authoritative Phase 1 design.** It merges three independent drafts (`docs/design/draft-tenancy-security.md`, `draft-lead-ownership.md`, `draft-comms-compliance.md`) with the product owner amendments A1–A7. Amendments override the original spec and the drafts. Where drafts conflicted, this design takes the option that is **safer for tenancy isolation, more deterministic for lead ownership, and stricter for consent**. Every conflict and its resolution is listed in §17.

**Phase 2 and 3** are designed in §21 (and `docs/PHASE2_3_PLAN.md`, `docs/DATA_MODEL.md` Part 2, migration `0018_phase2_3_schema.sql`); the merge of the two Phase 2-3 drafts and the second adversarial review (round 2) are logged at the end of §20.

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
- **Prompt-injection posture.** Every record (both directions of the conversation, transcripts, notes, deals, listings, activity, the lead profile) is delimited as untrusted data, and look-alike delimiters are neutralised. The system prompt is static per purpose. The model has no tools and sees exactly one contact. Its output is screened (`core.screenModelDraft`): the server picks the channel and the recipient, wiring details discard the draft, and human claims, unsourced links/phones/emails and hidden characters are flagged in the server's words. Drafts always need a tap, and the send-time gate still applies (SECURITY.md §4).
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
| Multi-turn autonomous qualification; AI auto-replies beyond one first message | Deferred indefinitely (PHASE2_3_PLAN §3; voice answering is the one bounded exception) | TCPA and accuracy risk; single message + handoff covers A7a |
| AI voice: answering, outbound, warm transfer | Phase 3: inbound answering only, ships dark until `platform:voice` is cleared and the Owner enables it; live transfer only to the contact's own agent; AI outbound never (R-GATE-9) | FCC artificial-voice rules; disclosure laws |
| Power dialer, voicemail drop, ringless voicemail, bulk SMS/email blasts, outbound MMS | Cut | High TCPA exposure; not needed to beat FUB daily |
| Calendar sync (Google/Microsoft), Gmail/Outlook inbox sync | Calendar: Phase 2, one-way push + live free/busy. D2: Gmail inbox sync is Phase 2 (modules 68/69, read-only, ships dark until `platform:gmail` is cleared); Outlook/Exchange mail sync not requested | OAuth scope and security review; in-app appointments only |
| Unified inbox channels beyond SMS/email/call (FB/IG DMs, Zillow feeds, web chat) | Phase 2 (channel CHECK widens). D2: FB/IG DMs out of scope; web chat and Zillow/realtor.com leads stay | data model shaped (`messages.channel`, one conversation per person) |
| Marketing generation, listing marketing, review automation | Phase 2 | — |
| Seller-update assembly, competing listings (MLS feed), monthly home-value updates (AVM) | Phase 2 (tables exist) | licensing / provider needed |
| Goals and AI weekly plans | Phase 2 (`agent_goals`, `assistant_actions.kind='weekly_plan'` reserved) | A5 says exception queue first |
| Owner dollars view (source → commission reporting) | Phase 2 (data captured now) | A7d |
| Call scoring, coaching, 90-day prediction, ad-spend reallocation, client portal | Phase 2–3 | client portal: `principal_type` reserved; RLS denies non-staff today |
| Custom fields, custom stages, custom pipelines, configurable feed weights | Feed weights: cut. Custom fields, stages, pipelines: deferred beyond Phase 3 (PHASE2_3_PLAN §3) | config sprawl; FUB custom fields → read-only `imported_fields` |
| Complex routing (geo polygons, schedules, holidays, language, boolean builders) | Cut | 4 match fields × 4 strategies only |
| Contact and deal document attachments | Phase 3 (`documents`, module 42; scan gating, hold and retention in the DB) | malware scanning, retention; `stored_objects` is ready |
| Transcript full-text search | Cut | would require a plaintext copy of encrypted data |
| Contact export (any role) | Deferred beyond Phase 3; owner question Q12 (PHASE2_3_PLAN §2.2, §3) | exfiltration vector; needs its own security review |
| Unmerge | Deferred (PHASE2_3_PLAN §3); support path meanwhile | merge payload keeps the data needed |
| Hash-chained audit seals | Deferred (PHASE2_3_PLAN §3) | `audit_log.seq` keeps gaps detectable |
| SSO/SAML, WebAuthn | Deferred (PHASE2_3_PLAN §3) | TOTP for Owner/Admin covers Phases 1-3 |
| National DNC vendor integration | Not needed for sending since D1 (the registry is not checked); fake + upload kept | revisit only if the owner reinstates the registry check |
| Brokerage hierarchy above tenants, cross-tenant reporting | Out of Phase 3 (PHASE2_3_PLAN §3) | cross-tenant reads are the largest isolation risk; needs its own design |
| STIR/SHAKEN display, branded caller ID | Deferred (PHASE2_3_PLAN §3) | needs carrier and registry programs (a partner need of its own) |

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
| G5 | E59 / R-DATA-4 | Erasure is refused for a contact on a deal, but `deals.primary_contact_id` was NOT NULL, so the Owner could never remove the person from a closed single-contact deal. | `primary_contact_id` may become NULL only by an Owner on a closed or lost deal (`deals_primary_contact_guard`); the deal stays as the transaction record. API: `GET /contacts/:id/erasure`, `POST /contacts/:id/erase`, `POST /contacts/:id/deals/:dealId/remove` (audited `deal.contact_removed`). **VERIFY WITH COUNSEL**: what a transaction record must keep (the deal name may still mention the person). |
### Phase 2-3 design merge (2026-11, round 1)
Two independent drafts (`docs/phase23/draft-a.md`, simplicity-first; `docs/phase23/draft-b.md`, risk-first) were merged into `docs/PHASE2_3_PLAN.md` (decision record §2), `docs/DATA_MODEL.md` Part 2 and `0018_phase2_3_schema.sql`. Each finding below was checked against the Phase 1 schema on PostgreSQL 16 before it changed the design. Proof: `0015` applies through the migration runner on a fresh database; `pnpm --filter @realty/db test` (20 files, 110 tests, including the new `rls_smoke_p23.test.ts` with 86 checks, the generated isolation sweep over every new table and the 0001 §22 self-check) and `pnpm --filter @realty/api test` (78 files, 607 tests) are green.
| Id | Sev | Verdict | Resolution |
| G1 | high | **Real, fixed** (both drafts) | 0014's `messages_dispatch_guard` mapped every non-email channel to `sms`/`phone`. Widening `messages.channel` alone would have made DMs fail closed (unsendable) and any future channel silently borrow SMS semantics. 0015 replaces the guard with an explicit map and `CHANNEL_UNKNOWN`; the channel CHECK, the map and core's `Channel` union change together (R-GATE-13, architecture test). |
| G2 | high | **Real, fixed** (draft B) | A person-level "do not contact me" written only as revokes on the contact's existing points would not cover a point added later. 0015 adds `contacts.do_not_contact_at` (citing a revoke), checked by both guards for every initiator; clearing is refused outside a reviewed definer, so today nobody can clear it (R-CHAN-2, smoke). |
| G3 | high | **Real, fixed** | `messages_check12` ("non-email outbound ⇒ phone number") would have forced DMs onto a phone number. Narrowed to SMS/MMS; DMs and chat need their `integration_connection_id`. |
| G4 | high | **Real, fixed** | The client principal must reach only its own grants. Staff Layer 1 is unchanged on every pre-0015 table and on all new staff tables; three portal tables admit a client read-only; `app.portal_account_id()` is NULL for staff; 0015's self-check fails the migration if any other table admits a client. Smoke: a generated sweep over every table and view returns 0 rows to a client; cross-deal, cross-tenant, revoked, expired and disabled cases all see nothing (R-PORTAL-1/2/6, E129). |
| G5 | medium | **Real, fixed** (draft B, narrowed) | Voice answering must ship dark. A CHECK alone (inbound, with a playbook id) would have accepted a draft playbook. Trigger `calls_voice_guard` requires an **approved** `voice_answering` version and the Owner-enabled, attested setting in the active policy (R-VOICE-1/9). R-GATE-9 is rewritten, not retired: AI-originated calls stay impossible. |
| G6 | medium | **Real, fixed** | Trigger firings with no enrollment were invisible to the Phase 1 step-run policy (it joins enrollments). New policy `step_runs_trigger`; a run is an enrollment step **xor** a keyed firing (`trigger_key` unique). The DB guard already refuses an autonomous send in a paused conversation, so a firing cannot outrun a reply even before module 22 cancels it at ingestion (R-NURT-1/5). |
| G7 | medium | **Real, fixed** | The Phase 1 API (`workspace/deals`) lets a TC move a date; a guard that *required* a manual `due_version` bump broke it. The trigger now bumps `due_version` itself and drops stored instants not recomputed in the same write, so drafts and firings bound to the old version go stale without API changes (R-TXN-5). |
| G8 | medium | **Real, fixed** | The Phase 1 seller-update test approves by editing the body; a CHECK on a new `recommendation` field alone would have broken it. The CHECK requires a human edit (Phase 2: a ≥ 20-character recommendation, or the Phase 1 body edit) (R-SELL-3). |
| G9 | medium | **Real, fixed** (draft B) | Money: "every shift is a tap" lived only in the API in draft A. `ad_allocation_events` is append-only with a deferred definer trigger: a planned change must cite an approved `ad_reallocation`, and a run must stay under the cap version's daily ceiling (R-ADS-2). Caps are Owner-only, append-only, attested (R-ADS-1). |
| G10 | low | **Real, fixed** | New guard triggers must let a foreign-tenant row reach RLS (the isolation sweep expects an RLS error, not a guard error). Every new guard returns early when `NEW.tenant_id` is not the context tenant. |
| G11 | low | **Rejected** | Draft B's `app.marketing_send_approved()` guard stub: open-house invites are human-initiated per-recipient messages, so the guard needs no marketing branch. Draft B's shift roster, stored busy blocks with a `btree_gist` exclusion, and seller-update/milestone-risk tables: each replaced by an existing mechanism (routing offers, a per-user booking lock, `assistant_actions`, the exception queue). |
Net schema change: +19 tables (17 tenant, 2 global), 668 policies in all, 2 guards replaced, 9 new trigger functions (1 SECURITY DEFINER). The audit field-classification snapshot was regenerated (new free-text columns are PII by default; `access_enc`/`refresh_enc` are secrets). `scripts/rule-coverage.mjs` gained `--phase=2-3` so Part 2 ids are known without counting against Phase 1.
### Phase 2-3 design review, round 2 (2026-11)
Two critics reviewed the merged design against the files: a security critic (S1–S16, each proven by probes run as `app_user` against a `createTestDb()` clone and rolled back) and a simplicity critic (F1–F20). Each finding was checked again against `0015`, DATA_MODEL Part 2 and the Phase 1 code before anything changed. `0015` was not yet committed, so it was corrected in place; no earlier migration was edited. Every applied schema fix has an adversarial case in `rls_smoke_p23.sql` that names its finding id, and `rls_smoke_p23.test.ts` fails if any of S1, S2, S4–S16, F4, F9 or F14 is missing from the passing checks (S3 is an API rule; module 22 tests it). No change weakens D1's opt-out block, assistant autonomy, tenancy or lead ownership: every guard change refuses more, never less. Round 1's G8 (the body-edit alternative for seller updates), G10 (guards skipping when no tenant context is set) and G11 (no marketing check on invites) are superseded by F12, S8 and S9.
**Proof (2026-11-11).** `0015` applies through the migration runner on a fresh database (`migrations: 15 applied, 0 already applied`). `rls_smoke_p23.sql` passes with `ON_ERROR_STOP=1` (179 checks, then `ALL PHASE 2-3 RLS SMOKE CHECKS PASSED`), and `rls_smoke.sql` passes on the same schema (92 PASS lines). `pnpm -r typecheck` and `pnpm lint` are clean. `pnpm --filter @realty/db test`: 20 files, 158 tests. `pnpm --filter @realty/api test`: 78 files, 607 tests. Its first run also reported one unhandled teardown error from `src/worker/load.test.ts` (Postgres `57P01` while that file's test database was being dropped); the re-run was clean, and three separate runs of that file passed. `rule-coverage` is unchanged for Phase 1 (127/130 rules, 64/67 edge cases). With `--phase=2-3` it reports 37/131 rules and 6/90 edge cases, plus R-NURT-6 and E100 retired; the rest belong to the feature modules.
| Id | Sev | Verdict | Resolution |
| S1 | high | **Real, fixed** | Grants and items were tied only to the client's account. Now `portal_grants_guard` accepts a grant only on a deal or listing whose party list includes the account's contact. That means the deal's primary contact or a buyer/seller/co-buyer/co-seller, or the listing's seller/co-seller, checked by the new definer `app.portal_party_ok` (`PORTAL_NOT_A_PARTY`). `portal_grants_client` re-runs the same check on every client read, so removing a co-buyer hides everything at once (E147). Grants are immutable except two changes: one revocation, made by a person as themselves and final (`PORTAL_REVOKER`, `PORTAL_GRANT_REVOKED`), and an expiry that can only move earlier. Items are immutable except one final retraction. An item's source must belong to its grant's own deal or listing: a confirmed date, a clean shared document, a showing, an approved seller update or a task (`PORTAL_SOURCE_NOT_IN_GRANT`). This also stops the tenant-wide `portal.sync` job. The login point must be a current email or phone of the account's own contact, enforced by a composite FK on the new `contact_points (tenant_id, contact_id, id)` key and by `PORTAL_LOGIN_POINT`. A disabled account stays disabled. A client principal writes nothing (`CLIENT_READ_ONLY`, raised before any other check). TC publishing was removed from the capability matrix. Smoke: probes 2a, 2b, 2d, 2f, 2g and 2h are each refused, and the co-buyer case passes. |
| S2 | high | **Real, fixed** | `integration_connections_guard` lets only the system actor write `external_account_id`, `credential_id` and `capabilities`, or move an external kind into `pending_review`/`connected`/`degraded` (`CONNECTION_PROOF_REQUIRED`, `CONNECTION_CAPABILITIES_REPORTED`). In practice that is the provider callback, after the adapter proves the token manages that account (E160). Kind and account id are immutable; a different account is a new row. A CHECK requires a live external connection to have both its account id and its credential. Webhooks route only to `connected`/`degraded` rows (`app.resolve_channel_account`, 0016). Web-chat widgets and lead inboxes have no external account, so Owner/Admin may still switch them on. **Not adopted:** a quarantine when an account moves between tenants. The callback proof already stops a tenant that does not control the account, so a quarantine would only delay a legitimate move. Smoke: the reported Owner insert, the Admin re-point and a self-reported `connected` row are all refused, and the callback path connects. |
| S3 | high | **Real, fixed differently** | A phone or email typed into chat becomes `webchat_sessions.claimed_kind/claimed_address`, an unverified claim. It is never a contact point and never attaches the session to an existing contact: the session gets a new contact, and a match only raises a duplicate suggestion for a human merge (R-INBOX-1, E138). Nothing automated goes to a claim (E154). Opt-out language in chat sets the person-level do-not-contact on the session's own contact only (R-CHAN-3, E155), so an anonymous visitor cannot silence a real client or pause their automation. Rate limits apply per widget and per IP (module 22). A lead email counts as a source lead only with a DKIM pass aligned to one of the connection's `allowed_sender_domains` (new column). Anything else is `needs_review`, with no autonomous first response (R-INBOX-9, E153). **Not adopted:** a one-time verification code, which would send a code to a number a bot typed (the SMS-pumping hazard it is meant to stop), while the never-attach rule already removes the impersonation path. Also **not adopted:** "opt-out language revokes only the `wc:` identity", which is narrower than D-OPTOUT-LANG. Scoping it to the session's own contact is safe and still honors what the person wrote. |
| S4 | high | **Real, fixed** (both options) | The new definer trigger `app.contacts_dnc_follow_merge` fires after `merged_into_contact_id` or the do-not-contact columns change. It copies the earliest `do_not_contact_at` and its ledger event to the survivor, along merge chains. Both dispatch guards also refuse when a do-not-contact contact was merged into the recipient. E140 no longer depends on a module owning `merge.ts`. Smoke: the survivor takes the do-not-contact, and an address added to it later is blocked. The shared case table has merged-duplicate cases for SMS, email, Messenger and calls. |
| S5 | high | **Real, fixed** | `documents_guard` quarantines every insert (`scan_status = 'pending'`, unshared) whatever the request says. Only the system moves a document out of `pending`, and only once, so `infected` is terminal; sharing still requires `clean` by CHECK. A legal hold is placed or lifted only by a human Owner/Admin. Retention is shortened only by a human Owner/Admin; the system may set or lengthen it. Scope, object, uploader, version and `supersedes_id` are immutable. `documents_update` checks the scope predicate in WITH CHECK. Smoke: 3a, 3b and 3c are refused. |
| S6 | high | **Real, fixed** (narrowed) | `assistant_actions_decision_guard`: an approval or rejection needs a user actor naming itself as the decider (`DECISION_ACTOR`). The decider's role at that moment goes into the new `decided_by_role`. A decision is never rewritten (`DECISION_FINAL`; revert to `proposed` and decide again). A requires-approval action becomes `executed` only after approval (`ACTION_NOT_APPROVED`). A CHECK requires an approved `ad_reallocation` to have an Owner/Admin decider, and the cap trigger requires the same. **Narrowed:** the Owner/Admin requirement applies to `ad_reallocation`, not to every `money` action. In Phase 1, `money` also marks the agent's own reply drafts that mention price or deposits, and those stay the agent's tap. **Not adopted:** `decided_at = now()`; binding the decision to the actor is the protection. Superuser sessions (migrations, fixtures) are exempt; no application path runs as a superuser. Smoke: a system self-approval in the Owner's name and an agent's approval of an ad shift are refused. |
| S7 | high | **Real, fixed** (with F14) | `app.ad_allocation_cap_check` was rewritten and now runs under a per-tenant advisory lock. A planned row must cite the cap version in force (`AD_CAP_VERSION_STALE`). It must also cite an `ad_reallocation` that an Owner/Admin approved (`AD_SHIFT_NOT_APPROVED`) and whose payload names this exact campaign and amount (`AD_SHIFT_NOT_IN_APPROVAL`). An approval moves each campaign once (unique index `ad_allocation_events_approval_once`). Applied and failed rows must match a planned row of the same run, campaign and amount (`AD_APPLY_WITHOUT_PLAN`). The tenant-wide daily total must stay within the ceiling (`AD_CAP_EXCEEDED`). That total is this run's planned budgets plus, for every other active campaign, the higher of its latest planned or applied budget and its synced budget. `ad_campaigns.daily_budget_cents` is written only by the system (`AD_BUDGET_THROUGH_LEDGER`). Smoke: 5b, 5c and 5d are refused, as are a second run on top of the first and a partial run that overflows the ceiling. |
| S8 | medium | **Real, fixed** | `tenant_settings_p23_guard` lets only the Owner switch the active policy to a voice-on version (`OWNER_ONLY_VOICE`); Admins can still turn voice off. All new guards now return early only when a tenant context exists and differs (`app.tenant_id() IS NOT NULL AND …`), so writes without a tenant context are checked too. Smoke: re-activation by an Admin and by the system is refused (E150). |
| S9 | medium | **Real, fixed** (reverses G11) | The messages guard now sends an invite only from an approved or published `open_house_invite` version (`MARKETING_PIECE_NOT_APPROVED`). `ad_campaigns_guard` lets a campaign run only an approved creative of its own listing (`AD_CREATIVE_NOT_APPROVED`). `marketing_pieces_guard` computes `content_sha256` itself, on insert and while the piece is a draft, using `app.marketing_content_sha256` over prose, template key, bound fields and the ordered asset ids. The approval CHECK requires a guard result that names that hash, the brokerage name, zero hard matches and zero pack failures, so a result computed before an edit no longer approves. The guard result and the assets are frozen with the piece. Smoke: 8a, 8b, D1 and a stale guard result are refused. |
| S10 | medium | **Real, fixed** | `asset_object_ids` was replaced by the table `marketing_piece_assets`, with composite FKs to the piece and to `stored_objects`. The object must be a live `marketing_asset` of the same tenant (`MARKETING_ASSET_INVALID`), and the assets are frozen once the piece leaves draft. The public page definer (0018) reads assets only through this table. `objects_marketing_assets` lets a reader of the piece fetch its images. Smoke: a `document`-purpose object is refused. |
| S11 | medium | **Real, fixed** | `documents_retained` (BEFORE DELETE) refuses while a document is held or retained, cascades included (`DOCUMENT_RETAINED`). The reviewed replacement of `app.purge_contact_internal`, still owned by `app_retention`, refuses erasure while a contact document is retained. It now shreds the contact's document objects along with its recordings and media. `app.retention_sweep` skips such contacts. Smoke: erasure of a contact with a held document is refused. Erasing a contact with no held document removes every contact-scoped Phase 2/3 row and shreds the document's file. |
| S12 | medium | **Real, fixed** (part 2 rejected) | `documents_select` limits listing documents to listing writers (the listing agent, Team Leads, tenant-wide roles) and to members of a sell or dual deal on that listing who can see that deal, not every member. **Rejected:** also restricting commission-bearing kinds the way `financials_all` restricts financials. TCs and the deal team need the signed contract to run the transaction, and module 42 reads it for date extraction. The commission figures themselves stay in `deal_financials` under R-PERM-10. Smoke: another agent reads neither the listing agreement nor its file, while the listing agent and the Team Lead can. |
| S13 | medium | **Real, fixed** | The RESTRICTIVE policy `likely_to_move_model_live` on `priority_feed_items` hides a `likely_to_move` card unless the contact has a prediction from an approved model in a shown band. A CHECK limits `prediction_models.features` to the allowed list. `contact_predictions_guard` requires every reason to name one of its model's features (`PREDICTION_REASON_FEATURE`). Smoke: withdrawing the model hides the card at once (E144). |
| S14 | low | **Real, fixed** (FK part not adopted) | `calls_assistant_disclosed` now covers every answered AI call, whatever its final status. `voice_tool_calls_guard` refuses a tool request before both the disclosure and the recording announcement (`VOICE_TOOL_BEFORE_DISCLOSURE`). `app.voice_tool_args_ok` restricts each tool's arguments to an allowlist of ids, codes and slot instants (named CHECK `voice_tool_calls_args_check`). `call_scores_guard` admits only a human-handled call and only that call's agent (`CALL_REVIEW_SUBJECT`). **Not adopted:** an FK from `voice_tool_calls` to the call for erasure. Under the allowlist the rows hold no PII by construction, so the table stays a ledger with no FK to mutable rows. |
| S15 | low | **Real, fixed** | The cost policies were split. A human Owner/Admin reads every row and writes manual rows as themselves; the system reads and writes only `ads_sync` rows, in USING and in WITH CHECK. `lead_source_costs_guard` makes `origin` and `entered_by_user_id` immutable (`COST_ROW_IMMUTABLE`). Smoke: the system cannot see a manual row, cannot rewrite one, and cannot change a row's origin. |
| S16 | low | **Real, fixed** | `deal_dates_confirm_guard`: a `manual` date entering `confirmed`, and any move of a confirmed date, require a user actor (`DATE_HUMAN_CONFIRMATION`). Imports use source `import` through their definer. |
| F1 | high | **Real, fixed** | One sender per fact. New matches stay Phase 1 saved-search alerts, so the Owner's `search_alert` switch keeps working. Module 24 only feeds MLS rows into `matchSavedSearches` and is the only Phase 2 editor of `assistant/searches.ts`. `new_match` was removed from the trigger kinds, and `saved_search_matches.match_reason` from 0015. Trigger playbooks handle price drops and back-on-market, keyed per `listing_price_history` row. R-MLS-3 was restated. |
| F2 | high | **Real, fixed** | No module edits `app.due_work`. Each owning module registers one per-tenant reconcile handler (Phase 1 `JobHandler.every`, one line in `worker/handlers/index.ts`) that reads its stored instants: 24 (MLS sync), 26 (trigger runs, which enqueue `trigger.step {stepRunId}` for `executeTriggerRun`), 28 (seller updates), 31 (milestones), 33 and 36 (weekly plan, daily fix), 50 and 52. The due indexes are now per tenant, `(tenant_id, instant)`. R-OWN-27 and §21.4 name every handler and cadence. The voice takeover is the dial timeout decided when the call starts. |
| F3 | high | **Real, fixed** | PHASE2_3_PLAN §5.3 names one owner per shared file: module 25 owns `core/assistant/**`, 26 owns `assistant/{playbooks,steps,templates}.ts`, and 22 owns `firstResponse.ts` and `drafts.ts`. A single discriminated `PlaybookContent` (steps \| triggers \| voice) is hashed by the existing `contentSha256` and stored in `playbook_versions.steps`, whose CHECK now accepts an array or an object. Steps have a new channel, `inbound_channel`. R-INBOX-4 makes the DM/chat first response part of the approved content. |
| F4 | high | **Real, fixed** | Module 31 is the only Phase 2 writer of deal dates, and the Phase 1 deal-screen routes call `confirmDate` too, so `due_at` and `reminder_at` are written in the same statement. 31's reconcile handler repairs any confirmed date without `due_at`, which also covers existing rows. `completed` was removed from `deal_dates.status`: completion is `completed_at` alone, a reminder requires a confirmed, uncompleted date (CHECK), and completing a date clears its reminder. The zone is `tenant_settings.default_timezone`, recorded in `basis` (R-TXN-2). Smoke case F4. |
| F5 | medium | **Real, fixed** | The new module 18a `api/feed-p23` owns the shared feed and exception code. Feature modules materialize their cards under their own key families, the Phase 1 extension point, so nobody edits the scorer. `trigger_draft`, `calendar_conflict` and `milestone_risk` were removed from the feed CHECK, and `milestone_risk` from notifications. The R-MKT-8 exclusion lives in `deriveExceptions`. |
| F6 | medium | **Real, fixed** | R-ACC-6 defines `milestone_at_risk` with two predicates over stored fields: a confirmed, uncompleted date that is overdue, or one due within 48 h with no responsible party. It is keyed `milestone:{deal_date}:{due_version}`. An unconfirmed date is never a risk, and deal-level risks are dropped (R-TXN-3). Each predicate has an edge case (E156–E158). |
| F7 | medium | **Real, fixed** | Home values and anniversaries are trigger firings. `home_value` fires monthly per covered address (`avm:{contact_address}:{yyyy-mm}`) and `home_anniversary` yearly (`anniversary:{deal}:{yyyy}`), both in the after-closing alerts playbook. Module 26 ships a new post-closing template version without the home-value and anniversary steps, so year one has a single anniversary email. No schema change. |
| F8 | medium | **Real, fixed** | R-OWNER-3 now defines the forecast: horizon, units, stage→close shares with Wilson intervals, thin stages left out and counted. Its return type carries samples and exclusions. Velocity comes from `app.stage_dwell_norms()` (`v_owner_velocity` was dropped from 0019). `planWeek`'s inputs and ranking are back (R-PLAN-1). |
| F9 | medium | **Real, fixed** (option 2) | The platform's counsel-reviewed back-test is stored on `prediction_models` (`backtest_flagged`, `backtest_transacted`, `backtest_window_days`, `backtest_dataset`). The four are all set or all null, transacted never exceeds flagged, and an approved model must carry one. Cards show the reasons plus that back-test. A new owner need, N18, covers a dataset the platform may use. Per-tenant snapshots were not added. |
| F10 | medium | **Real, fixed** (one part rejected) | Counsel and vendor gates are now platform clearance packs (R-INT-6). The `jurisdiction_packs` key allows `platform:<name>`, seven packs ship unreviewed, and `app.platform_cleared(key, vendor_ready)` checks them. The DB gates Meta DMs (`PLATFORM_NOT_CLEARED`), voice at the toggle and on every AI call (`VOICE_NOT_CLEARED`; also needs `vendor_ready_at`), publishing marketing and turning call scoring on (`COACHING_NOT_CLEARED`). Core gates home values and review requests, and module 43 gates portal sign-in. `avm`, `public_records`, `voice_agent`, `document_scanner` and `document_extractor` left `integration_connections.kind`, because they are platform configuration. `home_valuations.connection_id` and `property_records.connection_id` were dropped, and capabilities are system-only. **Rejected:** a system-only `license_pack`. The MLS licence is per brokerage, and the Owner/Admin enters its rules from their MLS agreement, each marked counsel-reviewed or not; display stays "not allowed" by default. |
| F11 | medium | **Real, fixed** | Each section of `assembleSellerUpdate` says where its data stands: "No showings logged in Realty OS this week", "Competing listings unavailable: no MLS feed connected". Page-view counts are deferred (PHASE2_3_PLAN §3) rather than defined now. Marketing activity comes only from published pieces, sent invites and rows agents log, never from exports. |
| F12 | medium | **Real, fixed** | Seller updates now have one shape. The CHECK requires every approved seller update to carry `edited_payload.recommendation` of at least 20 characters. It is `NOT VALID` for pre-0015 rows and NULL-safe. The Phase 1 approve route (`apps/api/src/assistant/drafts.ts`, `schemas.ts`) requires the recommendation (`SELLER_UPDATE_NEEDS_RECOMMENDATION`) and appends it to the body, and its test approves with one. Smoke: a body-only edit is refused. |
| F13 | medium | **Real, fixed** | `appointments.sync_version` (bumped by trigger whenever a pushed field changes) and `external_pushed_version` fence `calendar.push`. "Calendar renew" was dropped from R-OWN-27, because tokens refresh lazily inside the push. R-CAL-2, E103 and module 34 now say that an external edit is detected at the next push, and the appointment is detached then. |
| F14 | medium | **Real, fixed** | See S7: untouched active campaigns count toward the ceiling. |
| F15 | medium | **Real, deferred** | Rate moves are out of Phase 2. `market_rates` and the `rate_move` trigger kind were removed, and R-NURT-6 and E100 are **Retired**. N9 and C7 are the conditions for bringing it back, in the critic's shape: one feed card per agent per move, and a draft only on tap. |
| F16 | medium | **Real, fixed** | R-VOICE-6 and PHASE2_3_PLAN §1 now state the real behaviour. A live transfer goes only to the contact's own agent, within a hold (a pack value, default 20 s). Every other caller is booked or leaves a message, with a critical handback. "Joins by accepting" was removed. |
| F17 | low | **Real, fixed** | `packages/db/test/fixtures/opt_out_cases.json` (46 cases across SMS, MMS, email, Messenger, Instagram, web chat, calls and an unknown channel) drives a new block of `dispatch_guard.test.ts` against the real guards. Module 19's core test reads the same file. A mutation check confirmed it catches errors: flipping two expectations made exactly those two cases fail. |
| F18 | low | **Real, fixed** | N17 covers a PDF text-extractor dependency or vendor. Module 42's acceptance is scoped to PDFs with a text layer; for one without, E159 tells the TC to enter the dates by hand. OCR stays deferred. |
| F19 | low | **Real, fixed** | Closing a lead with reason `do_not_contact` records the person-level opt-out in the same transaction, through module 22's `app.record_person_opt_out` (R-CHAN-3). |
| F20 | low | **Real, fixed** | Each §18 promise now has a decision in PHASE2_3_PLAN §3. All are deferred, and contact export is owner question Q12. Branded caller ID and STIR/SHAKEN need carrier and registry programs. §18's status column was updated to match. |
**Found while writing the smoke cases** (defects in the fixes themselves, fixed before anything else ran):
- The marketing approval CHECK passed when the guard result lacked a key, because a CHECK that evaluates to NULL passes. It is now wrapped in `COALESCE(…, false)`, with a type-safe `jsonb_array_length`, and the ad-approver CHECK got the same treatment. A smoke case approves with `guard_result = '{}'` and is refused.
- `contact_predictions_guard` compared `text` to `text[]` (`= ANY ((SELECT …))`), which raised an operator error on first use. It was rewritten as `NOT EXISTS` over the reasons.
- A client principal's portal write reached a later guard error before RLS. The three portal guards now refuse a client first (`CLIENT_READ_ONLY`).
**Net schema change** (against round 1, measured from the two catalogs): +1 tenant table (`marketing_piece_assets`) and −1 global table (`market_rates`), so there are still 114 tables and 4 views. On existing tables, +10 columns (`decided_by_role`, `allowed_sender_domains`, `claimed_kind`/`claimed_address`, `sync_version`/`external_pushed_version` and the four back-test columns) and −4 (`asset_object_ids`, two `connection_id`s, `match_reason`). Policies: +10 and −1, for 677 in all. There are 19 new functions: 15 trigger functions and 4 helpers, of which 2 are SECURITY DEFINER (`app.contacts_dnc_follow_merge`, `app.portal_party_ok`). Two Phase 1 definers were replaced (`app.purge_contact_internal`, `app.retention_sweep`), along with seven new indexes and seven seeded platform packs. The audit field-classification snapshot was regenerated: the new free-text columns are PII by default.
### Owner decision D2: scope change and Gmail inbox sync (2026-11-11)
The owner narrowed and changed Phase 2-3 scope (PHASE2_3_PLAN §2.2 D2). **Out:** Facebook Messenger and Instagram DMs as channels, Meta Lead Ads intake, Meta ads. **In:** posting to Facebook Pages and Instagram business accounts through module 29's `publishPost` (export fallback; the Meta connection is for content publishing only), Zillow/Realtor.com intake, MLS, calendars, GBP, Google Ads only, and **Gmail inbox sync** (new; modules 68 `api/mail-sync` and 69 `web/mail-sync`; numbers 56–67 belong to the FUB-parity plan). **Unchanged:** web chat, D1, everything else. An interrupted design run had left a draft D2 migration and no doc changes; the draft was reviewed critically and finished, then a design pass, two independent critics and a revision were applied. 0018 was not edited: its Messenger/Instagram/Meta enum values, CHECKs, guard branches and `platform:meta` stay until one reviewed cleanup migration after the running lanes merge (PLAN §3); `platform:meta` is never cleared, so those paths stay refused. The D2 migration does not replace either dispatch guard.

**Draft review (before the critics).** Kept: the publishing-only connection kinds (0018's guard already treats any kind other than web chat and lead email as external, so only the provider callback links them), the per-user link with an exact `gmail.readonly` scope CHECK, a field-encrypted refresh token, a cross-tenant unique live mailbox, the RESTRICTIVE liveness policy (its definer later replaced, S-D2-4), the no-support policy and the DB-computed origin/backfill window. Fixed: a listing writer could mark a publication `published` with any post id (now only the system records provider outcomes); users could delete exclusions (now final); no dedupe with platform email (DB refusal on the Message-ID hash, merged contacts included); no per-thread cap (`max_messages_per_thread`, pack data); copies were fully immutable, so a contact merge would strand them (system-only re-point to the survivor with the same address HMAC); `opt_out_keyword` duplicated the consent ledger (removed; the ledger cites the copy and a CHECK keeps such events to system email revokes); several rule ids in comments were wrong.

**Simplicity/consistency critic (F-D2-1…26).** All 26 accepted, with these resolutions: F1 (critical) module 68 cannot reuse Phase 1 `ingestInbound` (it writes a `messages` row, quotes the body in the handback and enqueues the AI enrich job), so 68 adds `ingestSyncedMailInTx` in one flagged edit of `comms/inbound.ts` after 22 (pause, cancel, one handback by id, no snippet, no AI); F2 module 29 publishes to Facebook/Instagram only and module 53 adds the GBP branch of `publish.ts` (its adapter ships in 3D); F4 module 68 owns the mail read route; F7 copies of a link the user revoked are deleted by the reconcile handler within one sync interval (it also selects revoked links with copies); F8 one handback for a Reply-All that reaches both paths (shared dedupe key on the Message-ID hash); F9 only fresh mail (≤ 1 h at fetch) pauses and hands back; F13 module migrations are named by module, not number; F14 `published` piece status and external posts on new versions, retraction where the provider supports it (VERIFY) else a feed card; F15 synced mail is not searched in v1 and `search_tsv` is dropped; F17/F18 the disclosure and timeline copy say what Google shows and what is missing; F19/F20 VERIFY marks on Instagram deletion, lookup, public image URLs, and a separate Gmail OAuth client.

**Privacy/security critic (S-D2-1…8, probes as `app_user` on a scratch database, rolled back).**
| Id | Sev | Verdict | Resolution |
|---|---|---|---|
| S-D2-1 | high | **Real (proved), fixed** | A peer (collaborator or deal member they added) or a Team Lead (a contact point they added, even the agent's own mailbox address) could make the sync store and expose the agent's personal mail. Mail now syncs only for addresses the mailbox owner confirmed (`mail_sync_points`, written only by the link's user); the link stores `mailbox_address_hmac` and no copy may sit under any linked mailbox's address. |
| S-D2-2 | medium | **Real (proved), fixed** | Copies stayed readable after their point was removed. The RESTRICTIVE read policy requires a current point and a live confirmation; reconcile deletes such copies. Losing the relation (reassignment) keeps copies visible to the timeline audience (E216). |
| S-D2-3 | medium | **Real, fixed** | Opt-outs in excluded, over-cap or unrelated threads were never classified, so an agent's exclusion could swallow a client's opt-out (weaker than platform email, against D1). Every message from any current tenant email point is classified before and regardless of storage; the consent event cites a Gmail reference when no copy is kept (E229). |
| S-D2-4 | low | **Real (proved), fixed** | `app.mail_sync_live` let any member probe other users' link liveness and exclusions. The draft definer is not created; the read policy uses `app.mail_copy_live(tenant, copy)`, which takes only the copy's own row identity. The post-merge D2 review found that it still answered callers the read policies exclude (a support actor, a client principal, a peer holding a copy's id from consent evidence); the D2 review fix migration limits it to callers who can read the copy. |
| S-D2-5 | low | **Real (proved), fixed** | The synced-Gmail consent CHECK keyed on a self-declared label; it now keys on the presence of a synced-mail reference. Lifting an opt-out was already impossible. |
| S-D2-6 | low | **Real (proved), fixed** | A user's disconnect could rewrite system sync columns, and exclusion times were caller-chosen; both are now fixed by the guard. |
| S-D2-7 | low | **Rejected as a DB change** | The owner can read their own ciphertext `refresh_enc`. The system actor uses the same `app_user` role, so a column grant cannot separate them; module 68's architecture test forbids selecting it outside the token module and no route returns it. |
| S-D2-8 | medium | **Partly accepted** | Team visibility stays timeline-matching (the requirement), disclosed at connect, with counsel item C14 and owner question Q-GMAIL-5. A DB barrier against AI reads is **rejected**: the assistant and the sync are one role, and a GUC set by the caller is no barrier against the code it guards; enforcement is the architecture test (no SQL naming `mail_messages` outside `mailSync/**`, no model provider import). Plaintext bodies at rest match `messages.body`; whether the restricted-scope assessment expects field encryption is a VERIFY under N19. `search_tsv` dropped. |
**Proof (2026-11-11).** The D2 migration applies after 0018 on a fresh database (119 tables, 4 views, 716 policies); `rls_smoke_gmail.sql` passes 187 checks and every DB-enforced R-GMAIL id, R-MKT-12 and S-D2-1…6, S-D2-8 appear in passing checks. `pnpm -r typecheck` and `pnpm lint` clean; `pnpm --filter @realty/db test` 22 files, 181 tests; `pnpm --filter @realty/api test` 100 files, 797 tests (one earlier run had a flaky `auth/login.test.ts` 429 rate-limit failure that passed alone and on rerun); `pnpm rule-coverage` exit 0 (130/130 rules, 67/67 edge cases); `--phase=2-3` 51/144 rules and 25/111 edge cases linked (R-GMAIL 13/14; R-GMAIL-10 and the E201+ api cases wait for module 68).

---
### FUB parity design review (2026-11)

The FUB parity design is `docs/PARITY_PLAN.md`, `docs/FUB_PARITY.md`, DATA_MODEL Part 3 and the migration `0021_fub_parity.sql` (renumbered at merge). It merges two independent drafts: `docs/parity/draft-a.md` (simplicity-first) and `docs/parity/draft-b.md` (risk-first).

**Merge.** The lead found one live gap while merging (from draft B): both dispatch guards ignored removed phones in the "any of the contact's phones" opt-out fan-out. The migration fixes it (R-PAR-12).

**Security critic.** It found no cross-tenant path. All eight findings were applied, and each is proven by name in `rls_smoke_parity.sql`:

| # | Finding | Fix |
|---|---|---|
| S1 (high) | The wrong-number exemption trusted a status any agent can set, so two UPDATEs made a STOP stop counting for the person's other phones | Removing as `wrong_number` needs a recorded `wrong_number` revoke in the consent ledger, and such a point is never restored |
| S2 | The stage guard let an agent park an untouched lead in `lost` (also outside the inactivity release), or go new → lost → nurture | Any move outside `new`/`attempting` is refused while the SLA is unmet; giving up is the Close command |
| S3 | Bulk items' person and status stayed writable after confirm (re-send, or send to someone outside the target), and the bulk guard did not tie the recipient to the item | Items keep person, action and address; processed items are final; a bulk message needs a pending item at exactly its frozen address |
| S4 | The batch-text cap trusted a self-declared count | Confirm requires `target_count` = the frozen items |
| S5 | A sender could clear `bulk_action_id` to turn bulk sends into touches | The column never changes |
| S6 | An Owner/Admin could rewrite an agent's draft before the agent confirmed | Only the creator writes a draft's content |
| S7 | Protected tags could be applied in bulk | Refused in the DB (custom-field protection was cut, see below) |
| S8 | Bulk items were readable on cards; limit counts raced | Items are read with detail visibility; advisory lock on the per-person tag limit |

**Not applied, but noted.** Template merge fields are provenance in the DB; tying them to the body is core's job. Module 62 has a property test for it. The custom-field limit relies on READ COMMITTED (the API's default).

**Simplicity critic.** Applied:
- The `note_mentions` table was cut. Mentions are checked synchronously, as each mentioned user, at save; the text-free notification is the record. The author learns at once who was not told.
- `messages.template_id`/`template_version` were cut (bulk actions keep the version).
- Custom-field `protected_proxy`/`self_reported` were cut. Core refuses lexicon names and points to the built-in self-reported attributes.
- `smart_lists.ref_*` and `bulk_actions.definition_sha256` were cut.
- `contact_tags.bulk_action_id` was cut. The provenance kind stays: S7 needs it.
- `removed_reason` is reduced to replaced/old/wrong_number and is set by the action, never asked for.
- Logged kinds are reduced to call/text/email (meetings use appointments), and the author may correct a logged time.
- The bulk re-preview loop was dropped: the target is built at draft and confirmed as previewed.
- Added: "Next person" when working a list, the merge-duplicates UI in scope, a follow-up task from the log sheet, tap a tag to see everyone with it, and locked stages shown up front.

Kept against the critic, with reasons:
- The DB 200-recipient ceiling on batch text stays. It is a hard backstop under an unreviewed legal exposure; a lower tenant setting may follow.
- The contact_tags provenance kind stays (S7).

### FUB parity module 57 `api/people`: security notes

Module 57 adds no migration, no definer, no grant and no policy. Every route runs in the caller's own RLS transaction. These are the points where it touches the database's security surface:
- **Mentions are checked as the mentioned user.** For each mentioned active member, `memberSeesPerson` opens a separate transaction as that member (their real role comes from their membership through `app.my_role()`), sets `transaction_read_only = on`, and reads `app.contact_detail_visible`. No definer re-implements visibility for another user (R-PAR-2). The author's transaction then writes the `mention` notification. Its title is at most the person's first name and initial, its body is NULL, and it is deduped per note per user. It has no `RETURNING` and no `ON CONFLICT`, because the author's SELECT policy does not show another user's notification. A savepoint absorbs the dedupe. Only the in-app delivery row is written, since the author cannot read the mentioned user's push subscriptions under RLS. A mention never grants access: the "Share" action is the existing, audited collaborator add, under the existing `collaborators_write` RLS.
- **The person-level do-not-contact only tightens.** `POST /contacts/:id/do-not-contact` writes a staff `agent_revoke` for every live point on each of its channels through `recordConsentEvent`. It cancels queued texts and sets `contacts.do_not_contact_at` while citing the first revoke, which `contacts_person_opt_out_guard` requires. Nothing in the module can clear it.
- **Points are never edited in place.** A replace is a removal (`replaced`) plus an add, under the same address lock and `find_contacts_by_address` dedup as intake. Re-adding an address the contact once had restores that row, so the HMAC history is the same. A confirmed wrong number is refused, by core and by the `contact_points_immutable` trigger. `wrong_number` as a removal reason is asked for only when the ledger holds the wrong-number revoke (the trigger re-checks).
- **The stage guard has a mirror.** Core `stageChangeAllowed` mirrors `app.contacts_stage_guard`. A test writes every role × stage straight through RLS and compares the two.
- **Finding for module 22 (comms), not fixed here: the files are outside this lane.** `comms/repos/gate.ts` `contactPoints` excludes removed points, so core's send-time check does not see an opt-out on a removed phone (R-PAR-12). The DB opt-out guard refuses the dispatch, so nothing is ever sent (the test `R-PAR-12 E168` proves it), but `dispatch.ts` surfaces that refusal as a 500 instead of a blocked message with its reason. The people details response explains the over-block before the tap (`removedPoints[].optedOut`).
- **No address delete.** `app_user` has no DELETE grant on `contact_addresses`, so the module offers add and edit only. A grant is a security-review item for the schema owner.

#### Parity module 66 (api/duplicates) security note
Lane par-import-duplicates adds one migration (`0027_api_duplicates.sql`). Review items:
- **New SECURITY DEFINER trigger `app.contacts_merge_children()`** (owner `app_definer`, pinned `search_path`, EXECUTE revoked from PUBLIC; fires `AFTER UPDATE OF merged_into_contact_id` only when it goes from NULL to a contact). It acts only on the row the ownership engine just merged, inside that row's tenant, and only between the loser and its survivor. A caller cannot invoke it directly, so it cannot be used to copy one person's data onto another: the only way in is `applyOwnershipCommand`'s merge (locks, role rules, ledger, audit).
- **What it moves.** Points are *copied* (R-PAR-11 keeps a point's contact immutable) with their status, removal time and removal reason, so the dispatch guards' "any of the contact's phones" fan-out (R-PAR-12) sees a STOP on any of the loser's numbers, live or removed: a STOP on either person blocks the merged person (D1). It never writes consent, suppressions or `do_not_contact_*` (0018's `contacts_dnc_follow_merge` already moves the person-level opt-out); adding points can only make the guards refuse more. Tags, custom values (the survivor's value wins), relationships (self-pairs dropped, deduped) and notes move; stage history is copied (append-only). A row the survivor cannot take (100-tag cap, archived field or option) stays on the loser: a merge is never aborted by it.
- **`app.notes_edit_guard()` replaced** verbatim except one condition: a note's `contact_id` may change only when `current_user = 'app_definer'` and the old contact is merged into the new one. app_user still can never re-parent a note (tested).
- **Grants to `app_definer`** (least privilege for the trigger): INSERT on `contact_points`, `contact_tags`, `contact_field_values`, `contact_relationships`; DELETE on the last three; UPDATE on `notes` and `contact_duplicate_candidates`; SELECT on the tables it reads.
- **API.** `GET /duplicates`, `GET /duplicates/:id`, `POST /duplicates/:id/{dismiss,restore}` run under the caller's RLS (`dup_candidates`: both people's detail visible), 404 for a TC and for any pair with a hidden side (R-PERM-5/12). Dismiss and restore are audited (`duplicate.dismissed` / `duplicate.restored`). The page merges only through the existing `POST /leads/:id/merge`.

#### Parity module 65 (api/import-parity) security note
Lane par-import-duplicates adds a second migration (`0028_api_import_parity.sql`; it runs after the reader move). Review items:
- **New SECURITY DEFINER `app.import_revert_tags(batch)`** (owner `app_definer`, pinned `search_path`, EXECUTE to app_user only). The import revert runs as the system actor, which may not delete catalog tags (`tags_delete` is Owner/Admin), so this function deletes only tags that the batch's own bookkeeping lists as created by it (`import_batches.options.parityCreated.tagIds`), of `import` origin, carried by nobody, named by no smart list, for a batch of the caller's tenant that is reverting or reverted. It refuses support and any caller that is neither the system nor an Owner/Admin. A tag a human made is never deleted. Grant: DELETE on `tags` to `app_definer`.
- **`contacts.tags` is dropped** (R-PAR-10) after a last backfill into `tags` / `contact_tags` (`migrated`). Every writer and reader moved first: the ownership engine's contact insert, the import commit/fill and fingerprints, the existing-contact index, the leads contact read (flagged for module 60) and the load generator. A grep test fails if SQL in the source names the column again.
- **Writes as the import system actor only**, under the parity schema's RLS: `contact_tags.added_by_kind = 'import'` with the batch id, `tags.created_by_kind = 'import'` (a name that reads like a protected attribute is created `protected_proxy`), `custom_field_defs.origin = 'fub_import' | 'csv_import'`, `contact_field_values.updated_by_kind = 'import'` with the batch id and only where the person has no value (E41). The DB limits (1,000 tags, 100 per person, 50 live fields, typed values) stay in force; a limit hit skips that one tag or value, never the person.
- **Opt-outs (D1).** No tag changes reachability. A DNC-looking FUB tag is still a tag, and the existing consent rules (fub.ts mapConsent, applied by the contacts commit) record the real opt-out; removing the tag lifts nothing.
- **Fair housing (R-PAR-18).** A FUB field whose label or choices read like a protected attribute is never created as a custom field; naming one in a mapping is refused `CUSTOM_FIELD_PROTECTED`; its text stays in `imported_fields` (display only). The classifier is a stub over the core module 20 lexicon until module 59 lands. **VERIFY WITH COUNSEL (C-PAR-3).**
- **Revert** removes exactly the batch's tag links and untouched imported values (an edited value no longer carries the batch id), then the batch-created tags nobody uses (definer above) and archives batch-created fields that hold no value (definitions are never deleted).

### api/lists security note (lane par-lists, PARITY_PLAN modules 59-61)

What the lists lane adds to the database's security surface, for review:

1. **One SECURITY DEFINER function**, `app.smart_lists_retarget_tag(source, target)` (migration `0029_lists.sql`). R-PAR-9 says a tag merge rewrites the smart lists that reference the source tag, but personal lists are readable and writable only by their owner, so the Owner/Admin running the merge cannot reach them under their own RLS. The function, owned by `app_definer` with a pinned `search_path`:
   - refuses unless the caller is a user actor whose role is owner or admin (`TAG_MANAGE_REQUIRED`), and both ids are live tags of the caller's tenant (`TAG_MERGE_INVALID`), so it runs only inside a merge (before the source is deleted);
   - updates only `smart_lists.definition` (column grant) of the caller's tenant, replacing the source tag's id text with the target's (core lower-cases every id in a definition; a uuid's text cannot occur inside another uuid);
   - reads and returns no list content (only a count), and cannot widen a list: a tag id becomes another tag id of the same tenant, and every run is still under the viewer's own RLS.
   Tests: `apps/api/src/lists/tags.test.ts` (R-PAR-9 merge, personal lists rewritten), `adversarial.test.ts` (other roles, the import system actor and a foreign tenant's tag are refused).
2. **No table, column, index or policy change.** Tags, values and lists use P0's tables and policies as they are.
3. **List runs never bypass RLS.** The People query reads `contacts` under the caller's RLS and narrows to live, detail-visible people with the same rule as `app.contact_detail_visible()` written inline (initplan sub-selects; `lists.test.ts` proves equality with the function for every role). Every detail predicate (tags, custom values, open tasks) is a per-person probe of its own RLS-protected table. For an Agent, ISA or TC the query also states the implied "owned, collaborating or on my deal" predicate (no result change; the planner then starts from the owner index). Team lists hold no free text (R-PAR-27). SQL is built only from fixed fragments with every value a bound parameter (lint `realty/no-sql-raw`, the value-independence fuzz test in `people.sql.test.ts`).
4. **resolveSelection** (for module 63) returns only detail-visible people of the caller, refuses more than the cap (`SELECTION_TOO_LARGE`, never a silent truncation), and refuses a definition that references a protected-proxy tag as the audience of a send or enrollment (`AUDIENCE_PROTECTED_PROXY`, R-PAR-8). The database still refuses a protected tag applied in bulk (S7).
5. **Finding for the owner (performance, not security).** Under the P0 policies every `contact_tags`, `contact_field_values` (and `tasks`) row a query reads costs one `app.contact_detail_visible()` call (about 0.19 ms at 250k), and the value comparisons (numeric, arrays, EXTRACT, LIKE) are not leakproof, so they cannot become index conditions ahead of the policy. Per-person probes keep first pages within budget, but an exact count to 10,000 of a broad tag or field predicate for a tenant-wide viewer needs up to 10,000 policy calls (≈ 2 s), over R-PAR-29's 800 ms. A provably equivalent policy form, `(SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)` (a tenant-wide viewer sees every contact and every contact's detail, and child rows always reference an existing contact), would remove that cost for Owner/Admin (measured on the scratch load database only, then reverted: Owner first pages 12-36 ms instead of 84-386 ms; counts 240-1,982 ms, which would still need a value-driven count shape). Lanes do not change policies (PARITY_PLAN §3), so this is left to the owner; numbers are in `docs/PERFORMANCE.md` ("Smart lists").

### FUB parity modules 62–64 `templates` and `bulk` (lane par-templates-bulk): security notes
No migration, no new table, no `SECURITY DEFINER` function. What the lane adds to the security surface, for review:
- **Every bulk send is a normal send.** The runner calls `composeHumanMessage` (with `bulkActionId` and `purposeOverride: 'marketing'`) and then `dispatchOutbound`, as the creator, one person at a time. `canContact` and both DB dispatch guards decide each message, with no bulk exemption (D1). `messages_bulk_guard` additionally ties each message to a running action of its channel, its creator, and a pending item at exactly the frozen address (review S3).
- **Core sees at least what the DB guard sees.** For texts, bulk preflight adds the consent rows of the person's removed phones (except confirmed wrong numbers) to the gate input (R-PAR-12). comms' own `buildGateInput` reads live points only, so a one-to-one text to such a person reaches the DB guard, which raises instead of returning a clean block. That is a gap in module 22, reported, not changed here.
- **Run as the creator.** `bulk.run` rebuilds the creator with `senderActor` (an active membership, the current role) and runs every item in its own transaction under the creator's RLS. An item the creator can no longer see is skipped `NOT_VISIBLE` by the system actor, which writes only that outcome. Run bookkeeping (status, counts, `bulk_finished`, assign summaries) is written by the system actor.
- **Daily bulk-email cap (Q-PAR-7).** Confirm takes a transaction-scoped advisory lock on the tenant's budget (`pg_advisory_xact_lock(hashtextextended('bulk_email_budget:' || tenant))`) and counts today's recipients across every creator in a separate system-actor transaction. That transaction reads committed rows only, and the lock is held until the confirm commits, so two concurrent confirms cannot both pass. Tested with a race.
- **Ownership engine option.** `applyOwnershipCommand*` gains `summaryNotices?: true`. It drops only the per-person `REASSIGNED_TO_YOU` / `REASSIGNED_AWAY` notify effects; the decision, ledger, feed items and timers are unchanged. The bulk runner then sends one summary per affected user (R-PAR-35). Each assign uses the command id `derivedCommandId(action, contact)` (UUIDv5), so a retried item replays instead of assigning again.
- **Batch text (R-PAR-40).** To turn it on, `can('settings.batch_text', { loosening: true, attested })` must pass: Owner only, re-auth within 15 minutes, and the typed attestation. The attestation is the audit reason. The DB trigger refuses "on" from anyone but the Owner. The switch is re-read at confirm, before every item and on every message insert. Counsel text and attestation wording are **VERIFY WITH COUNSEL** (C-PAR-1).
- **Templates.** The merge-field set is closed (core + DB CHECK). A template is rendered in one pass from a context built for one person under the sender's RLS. Values are plain text: control, bidirectional-override and zero-width characters are stripped, and there is no CR/LF in a subject. A pond or offer card is never enough to render (detail visibility). The signature is self-only plain text, appended by the renderer, never parsed.


## 21. Phase 2-3 architecture
Authoritative for Phases 2 and 3; the build order, decisions and owner needs are in `docs/PHASE2_3_PLAN.md`, tables and rules in `docs/DATA_MODEL.md` Part 2. Everything in §1–§20 still holds. Owner decision **D2** (2026-11-11, PHASE2_3_PLAN §2.2) changed the scope: no Messenger/Instagram DMs, Meta Lead Ads or Meta ads; posting to Facebook Pages and Instagram business accounts; Gmail inbox sync added (§21.10, §21.11). 0018's Meta enum values, CHECKs and guard branches stay until the D2 cleanup migration (PHASE2_3_PLAN §3).
### 21.1 Principals and entry points
- **Staff** (Phase 1) and **client** (Phase 3 portal). A client context carries `app.tenant_id`, `app.principal_type = 'client'` and `app.portal_account_id`. Only `withPortalTx` sets them, from `portal.resolve_session`. A client reads `portal_accounts`, `portal_grants` and `portal_items` only, never writes (`CLIENT_READ_ONLY`), and sees nothing else (DATA_MODEL §7). A grant names a deal or listing the client is a party to; `app.portal_party_ok` checks this at grant time and again on every read, so removing a co-buyer hides everything at once. Grants and items never move, and revocation and retraction are final. The portal has its own cookie (`__Host-psid`), CSRF secret, rate limits, Fastify plugin and Vite bundle; lint keeps `withTenantTx` and `withPortalTx` apart.
- **Not principals:** web-chat visitors and public listing-page viewers. Visitors get a public widget key, an Origin allowlist, a server-issued session token, rate limits per widget and per IP, a honeypot and a 2,000-character limit. They reach data only through `app.webchat_poll` and `app.public_listing_page`. Whatever a visitor types is an unverified claim on the session, never a contact point and never an attachment to an existing contact.
- **Definer catalog additions.** Each is a security-review item. In 0015: `app.ad_allocation_cap_check` (deferred constraint trigger), `app.contacts_dnc_follow_merge`, `app.portal_party_ok`, and the two replaced dispatch guards. Also replaced in 0015 and still owned by `app_retention`: `app.purge_contact_internal` and `app.retention_sweep`. In module migrations: `app.resolve_channel_account`, `app.resolve_webchat_widget`, `app.webchat_session`, `app.webchat_poll`, `app.public_listing_page`, `app.record_person_opt_out`, `app.reinstate_person_contact`, `app.undo_language_opt_out`, `portal.request_login`, `portal.consume_login`, `portal.resolve_session`, `portal.end_session`, `portal.issue_document_stream`, `portal.document_object`, `portal.record_audit` (all in `0023_p3_portal_auth.sql`, §21.7) and `app.coaching_trends`. In the D2 migration: `app.mail_copy_live` (boolean, keyed on a synced copy's own row; the RESTRICTIVE read gate, §21.10) and the trigger `app.mail_sync_points_guard`. The D2 review fix migration replaces `app.resolve_channel_account` and `app.mail_copy_live` (same owner, search_path and grants; §21.8, §21.10).
- **Webhooks** follow §3: verify the signature, idempotency, then `withTenantTx({kind:'system', via:'provider'})`. The tenant comes only from a `connected` or `degraded` connection. Its external account is globally unique, like a phone number, and only the provider callback writes it, after proving control of the account (R-INT-3, R-TEN-11). A lead email is a source lead only with a DKIM pass aligned to an allowlisted sender domain. **D2: Meta webhooks are out** (no DMs, no Lead Ads; the publishing connection subscribes to none, R-MKT-12); Gmail sync polls and receives no push (§21.10).
- **Decisions are people's.** Approving or rejecting an assistant action needs a user actor naming itself, with its role recorded. Ad money needs an Owner or Admin, and a decision is final (`assistant_actions_decision_guard`). Confirmed `manual` deal dates, legal holds, shorter retention and voice-on policies are written by people too: by the user actor, by an Owner/Admin, or by the Owner, respectively (DB).
### 21.2 Channels and the one outbound path
| Channel | Consent channel | Point kind / address | Sender | Allowed when |
|---|---|---|---|---|
| sms, mms | sms | phone | `phone_numbers` | Phase 1 |
| email | email | email | `email_identities` | Phase 1 |
| messenger | messenger | `fb:{page}:{psid}` | connection `messenger_page` | **Out of scope (D2): never cleared; removed by the D2 cleanup.** Always `PLATFORM_NOT_CLEARED` (`platform:meta` is never cleared); no platform window is built. |
| instagram | instagram | `ig:{account}:{igsid}` | connection `instagram_account` | **Out of scope (D2): never cleared; removed by the D2 cleanup.** Same as messenger. |
| web_chat | web_chat | `wc:{32 hex}` | connection `web_chat_widget` | while the session is open |
- Opt-outs. A keyword applies to that channel on all of the contact's points of that kind. Opt-out language, an agent's "do not contact", or closing a lead with reason `do_not_contact` sets a person-level do-not-contact and revokes every channel on every point. Both DB guards refuse `PERSON_DO_NOT_CONTACT`, including when a do-not-contact duplicate was merged into the recipient; the merge also copies it to the survivor. From web chat, opt-out language applies to the session's own contact only. These rules only refuse more than Phase 1 did; D1 stands.
- `canContact` is `core-compliance/3.0.0` and blocks at least what the guard blocks. The shared case table `packages/db/test/fixtures/opt_out_cases.json` runs against the DB guards now; module 19 runs it against core.
- New outbound paths all go through `dispatchOutbound`, each with a blocked-send path test (R-GATE-14). They are: web-chat replies (D2: no DM replies; the 60-second first response with step channel `inbound_channel`, and approved drafts only), open-house email invites (per recipient, only from an approved invite version, which the DB enforces), seller updates, milestone updates, trigger alerts, home-value notes, review requests, portal login links and notices, and voice booking confirmations.
- Reserved provider names (lint `realty/no-provider-outbound` extended): `deliverChannelMessage` (`comms/dispatch.ts`, web chat; D2: `sendDirectMessage` is dropped), `publishPost` and `postReviewReply` (`marketing/publish.ts`; publishing, not contact communication, behind `platform:fair_housing`; D2: `publishPost` posts to a Facebook Page, an Instagram business account or a GBP location, §21.11), and `applyBudgetChange` (`ads/dispatch.ts`; money, behind the DB cap ledger). No interface has an AI outbound-call method.
### 21.3 Autonomy (approve rules, not every message)
| Output | Runs on its own inside an approved rule? | Always a tap |
|---|---|---|
| 60-s first response on web chat (D2: no DMs) | yes (`new_lead_response`, step channel `inbound_channel`) | |
| New listing in a saved search | yes (Phase 1 saved-search alerts, now with MLS rows; the one sender) | |
| Trigger alerts: price drop, back on market, home anniversary, deal date coming up | yes (trigger playbook; the digest window is approved content) | |
| Rate move | deferred (N9, C7); when it lands: one feed card per agent, a draft only on tap | |
| Milestone update to client/lender | yes (`transaction_updates`; human-confirmed dates only; contract or money wording ⇒ draft) | |
| Home value note | yes, once `platform:avm` is cleared, if fresh, displayable and within the range and jump limits; otherwise a draft | |
| Review request | yes (post-closing, once `platform:review_requests` is cleared) | |
| Seller update | never | yes, plus the agent's own recommendation (≥ 20 characters, DB) |
| Marketing piece | | yes, once per version, bound to its content hash and assets (DB); publishing waits for `platform:fair_housing` |
| Publish a post (Facebook Page, Instagram business, GBP; D2) | never | yes, always a tap by a listing writer, as themselves (`marketing_publications`, R-MKT-12); export otherwise |
| Voice answering | yes: inbound only, closed tool set, mandatory handback; needs `platform:voice` and the Owner's setting (DB) | |
| Ad budget shift | | yes (`money`; an Owner/Admin tap, single-use, exact amounts, DB ledger), pending D-ADS |
| GBP review reply, contract extraction | | yes |
| Weekly plan, daily fix, prediction card | internal (no client message) | accepting creates tasks |
| Gmail sync (D2) | no output: read-only copies into the timeline; never sent, never in a model; a live client reply at most 1 hour old at fetch pauses and hands back once (R-GMAIL-10) | |
An inbound on any channel pauses automation and hands back (§10), including trigger firings: the guard refuses an autonomous send while paused, and module 22 cancels the contact's scheduled firings at ingestion. Voice answering is the one bounded live exception (D-VOICE). The call pauses enrollments as any inbound does, the session is limited to the closed tools of an approved `voice_answering` playbook, tool requests start only after the disclosure and the recording announcement, and the call always ends in a handback.
### 21.4 Timers (R-OWN-27)
Every Phase 2/3 timer stores its instant and is fenced. The owning module wakes it with one per-tenant reconcile handler (`JobHandler.every`, one line in `worker/handlers/index.ts`); no module edits `app.due_work`.
| Timer | Stored instant / fence | Handler (module, cadence) |
|---|---|---|
| MLS and feed sync | `integration_connections.next_sync_at`, sync cursor | 24, 60 s |
| Trigger firings | `playbook_step_runs.scheduled_for`, `trigger_key` | 26, 60 s → `trigger.step {stepRunId}` → `executeTriggerRun` |
| Home values, anniversaries | `avm:{contact_address}:{yyyy-mm}`, `anniversary:{deal}:{yyyy}` | 26, daily |
| Seller updates | `listings.seller_update_next_due_at` | 28, 5 min |
| Milestone reminders | `deal_dates.reminder_at`, `due_version`; repairs a confirmed date with no `due_at` | 31, 5 min |
| Weekly plan / daily fix | per user and local Monday / local date (dedupe keys) | 33 / 36, hourly |
| Prediction refresh | per tenant and date | 50, nightly |
| Ad reconcile | per campaign and hour | 52, hourly |
| Gmail sync (D2) | `user_mail_links.next_sync_at` (plus revoked links that still have copies), Gmail `history_id` cursor (advanced only after the page commits) | 68, every `platform:gmail` `poll_interval_seconds` (120 s) → `mail.sync` |
| Portal grant expiry | `portal_grants.expires_at`, also compared with `now()` in the policy | none needed |
The calendar has no renew timer: tokens refresh lazily inside `calendar.push`, which is fenced by `appointments.sync_version`. The voice takeover is the telephony dial timeout decided when the call starts, not a timer.
### 21.5 Providers (all with deterministic fakes; real adapters refuse to start unconfigured)
Tenant connections (`integration_connections`, each with an honest status such as `needs_partner_access` or `pending_review`, shown in words): Meta for content publishing only (`facebook_page`, `instagram_business`; D2: no messaging, no Lead Ads, no ads; OAuth requests content-publishing permissions only, **VERIFY** names), lead feeds (Zillow, realtor.com) and the lead-email inbox, MLS (RESO-shaped), the showing service, ads (Google only, `ads_google`; D2) and GBP. Per-user: the calendar (Google, Microsoft) and Gmail (`user_mail_links`, read-only, §21.10; Microsoft mail is not requested). Platform configuration, not tenant rows: AVM, public records, the voice stack, the malware scanner, the document text extractor and the PDF renderer. Their availability is whatever the adapter reports, combined with the platform clearance packs (R-INT-6). No rate feed ships (rate moves are deferred). Facebook Marketplace has no general listing API that we know of, so it is an export/copy kit.
### 21.6 Residual risks (Phase 2-3)
| Risk | Mitigation |
|---|---|
| D1 plus more automated messages (trigger alerts, home values, milestone updates, web-chat replies) may meet state mini-TCPA limits such as Florida's FTSA | opt-out and person-level blocks everywhere (core + DB, merge-safe); email-first built-in templates; digest windows; counsel item C1; reinstating limits stays a policy change. **VERIFY WITH COUNSEL.** |
| A compromised API process can set a client GUC with any account id | the same class as Phase 1 Q3; the actor is built only by the portal resolver (lint + type); open question Q11 (a separate DB login for the portal) |
| ~~Platform webhooks share one app secret across tenants~~ **Obsolete (D2): no platform webhook is received** (no Meta DMs or Lead Ads; Gmail polls) | kept for history: the tenant is resolved only from a connected connection whose account the provider callback proved; payloads never choose the tenant |
| A web-chat visitor types someone else's email or phone | the claim never attaches, never receives anything automated and never silences anyone; a human merges after checking |
| Forged lead emails | DKIM-aligned allowlisted senders only; anything else is `needs_review` with no autonomous reply |
| Superuser sessions skip the decision guard | maintenance only (migrations, fixtures); no application path connects as a superuser (§16) |
| Meta policy and App Review for content publishing (D2) | publishing only (no messaging permissions, no webhooks); honest connection status; export is always the fallback; the product says "Posted" only for a provider-confirmed row (N2, **VERIFY** permissions); `platform:meta` is never cleared |
| MLS licence violations and volume | display rules on every client-facing render (default not allowed), staleness pause, per-tenant copies benchmarked at 500k rows |
| Fair-housing lexicon false negatives | every piece is human-approved and bound to its content; publishing waits for `platform:fair_housing`; prediction models ship withdrawn |
| Voice: disclosure law, all-party recording, latency, a made-up booking | inbound only; disclosure and announcement enforced by the DB before any tool request; unverified details never become appointments; voicemail fallback; ships dark until `platform:voice` (counsel + vendor latency spike) and the Owner's setting |
| Employee monitoring (call reviews) | private by default; human-handled calls only, attributed to that call's agent; TL access is an Owner setting; off until `platform:coaching`; no rankings |
| Ads: platform overspend, attribution lag | DB cap ledger (cap version in force, exact approved amounts, single-use, tenant-wide total under a lock), hourly reconcile pause, sample holds, honest copy |
| Gmail: Google's restricted-scope verification and security assessment (lead time, annual renewal) | ships dark: `platform:gmail` is cleared only with `rules.vendor_ready_at` (N19); the product works without it. **VERIFY** current requirements, lead time and renewal cadence |
| Gmail: a compromised system actor can read synced mail and decrypt refresh tokens | the same class as every other system read (Phase 1 Q3); tokens are envelope-encrypted with row-bound AAD, access tokens stay in memory, no bodies or addresses in logs, no AI use, scopes read-only by CHECK |
| Gmail: personal mail leaks through a contact who is also family or a friend | only mail with a current email point of a related contact is stored; "Remove this thread from Realty OS" hides at once and is final; the connect disclosure says so |
| Gmail: team members (TL, Owner, collaborators) read an agent's client mail | visibility is the contact timeline's, stated in the connect disclosure; employee notice and third-party correspondents are counsel item C14. **VERIFY WITH COUNSEL** |
| Gmail: Google deletes or limits API access, or revokes the token | `invalid_grant` ⇒ `PROVIDER_REVOKED`, handled as a disconnect (copies deleted); the timeline keeps platform email; honest status |
| Parallel lanes landing module migrations out of order | the runner refuses a pending file that sorts before an applied one; each module migration (M21, M22, M29, M33, M43, M54) takes the next free number at merge, so migrations apply in merge order (PHASE2_3_PLAN §4) |

### Real-provider gaps (lane migration `0019_telephony_email_gaps.sql`)

| Id | Gap | Resolution |
| T1 | A real inbound call got empty TwiML and hung up. | `comms/voice.ts`: ring the owner (else the on-duty routing target, peeked, never advanced) from the team number; announcement first when the policy announces; a press-1 whisper; unanswered ⇒ missed call + voicemail with a fixed recording notice, copied encrypted and transcribed. The plan is stored on the call (`calls.ring_user_id`, `recording_decision.planned`), so a retried fetch gets the same TwiML. `agent_user_id` is set only on accept (recording scope R-PERM-8). |
| T2 | MMS media were counted, never stored. | `comms/media.ts`: fetch by SID only, type allowlist + magic bytes, 10 × 5 MB, per-object DEK, provider copy deleted, refusals recorded (`message_media_skipped`); download with nosniff and a sandbox CSP. |
| T3 | SES and Mailgun events were not parsed. | SNS signature (v1/v2, cert host rule, topic allowlist, 1 h window) and Mailgun HMAC (±5 min) feed the same `handleEvent` as Postmark/SendGrid. |
| T4 | `webhook_events` grew forever. | `app.purge_webhook_events()` (definer, real clock, no arguments): telephony 400 d, email 35 d, lead 2 d, rejected 30 d; downstream unique keys keep deduplicating after. |

### 21.7 Portal authentication (module 43): security notes for each definer
Migration `0023_p3_portal_auth.sql` (lane number; the orchestrator renumbers it) adds schema `portal`, three definer-only tenant tables and the client transaction helper `withPortalTx` (`packages/db/src/portalTx.ts`). Every function below is `SECURITY DEFINER`, owned by `app_definer` (NOLOGIN, BYPASSRLS), with `search_path = pg_catalog, public`, `EXECUTE` revoked from PUBLIC and granted to `app_user`. The migration's own self-check fails if any `portal` function loses its owner, its pinned search path or becomes PUBLIC-executable, or if `app_user` gains any privilege on the three tables (0001 §22 scans only `app` and `auth`). **No definer takes a caller-supplied "now"**: every expiry is compared with the database clock, so a caller cannot back-date a check (the class 0016 fixed in `app.retention_sweep`). Tests: `packages/db/test/portal_auth.test.ts` and `portal_auth.adversarial.test.ts` (a fast-check property over the download chain, plus a single-fault sweep that killed both hand-made mutants of the chain helper).
| Definer | Context | Reads / writes | What an attacker controls, and why it is safe |
|---|---|---|---|
| `portal.request_login(slug, address_hash, token_hashes[])` | pre-tenant | reads tenants, portal_accounts, contact_points; writes portal_login_tokens (supersedes older), audit_log | slug and hash are matched by equality only (no pattern); unknown slug/address, suspended tenant, removed point, disabled account and a throttled account (5 links per account per hour) all return zero rows and write nothing; refuses (`PORTAL_NOT_CLEARED`) until `platform:portal` is counsel-cleared, the same for every address. Returns the tenant, account, contact and login point so the API can send the link through `dispatchOutbound` (opt-outs apply); **the API must answer the HTTP request identically whatever it returns** and should send asynchronously so timing does not reveal a match (module 45). Spouses sharing an email get one link per account (E127). |
| `portal.consume_login(token_hash, session_hash, ip, ua)` | pre-tenant | updates portal_login_tokens (used_at), portal_accounts (status/activated_at only: column grant), inserts portal_sessions, audit_log | single use under a row lock (concurrent attempts: exactly one wins); 15-minute expiry and supersession by the DB clock; the account must still be invited/active and its login point must be the point the link was sent to and still current; a used token stays used even when a later check fails. Session: idle 24 h, absolute 14 days (CHECK caps 7 d / 30 d). **VERIFY WITH COUNSEL (C10) and the owner** for the lengths. |
| `portal.resolve_session(session_hash)` | pre-tenant | reads portal_sessions, portal_accounts, tenants; updates last_seen/idle expiry | the only source of a client context. Live, unexpired, unrevoked session of an active account of an active tenant while `platform:portal` is cleared (withdrawal stops every session at the next request). Staff sessions live in `sessions`, portal sessions here: neither resolver accepts the other's token (E148, DB half). |
| `portal.end_session(session_hash, reason)` | pre-tenant | updates portal_sessions, audit_log | revokes only the session whose token the caller holds. |
| `portal.issue_document_stream(item_id, token_hash)` | client (`withPortalTx`) | reads the chain (below); inserts portal_stream_tokens | refuses unless `app.principal_type() = 'client'`; never trusts the context alone: re-checks via `portal.document_chain_internal`. A staff session that sets `app.portal_account_id` gets NULL from `app.portal_account_id()` and nothing here (E149). |
| `portal.document_object(token_hash, ip, ua)` | client | updates portal_stream_tokens (used_at), audit_log; returns the object row (DEK still wrapped under the platform KEK) | token bound to tenant and account, 60 s, single use; **the chain is re-checked at download time** (unshared, retracted, revoked, lapsed, party removed, account disabled, object shredded, tenant suspended or clearance withdrawn after the token was issued: refused). Audited as `portal.document_downloaded`. |
| `portal.record_audit(action, entity_type, entity_id, ip, ua)` | client | inserts audit_log | the portal audit definer: a client principal cannot write `audit_log` (staff-only Layer 1). Only for the calling client's own active account; action `portal.<verb>` and four entity types only. |
| `portal.audit_internal(...)`, `portal.document_chain_internal(item)` | helpers | — | invoker rights, **not executable by app_user** (only by app_definer inside the definers above). The chain: client context names an active account of an active tenant → the item is an unretracted document item of an unrevoked, unexpired grant of that account → `app.portal_party_ok` still holds → the document is that item's document, of the grant's own deal or listing, not contact-scoped, shared and clean → its stored object is a live `document` object → `platform:portal` is cleared. |
- **Audit identity.** `audit_log.actor_kind` has no `client` value and this module changes no table, so portal rows are `actor_kind = 'system'`, `actor_via = 'api'`, with `changes.principal = 'client'` and `changes.portal_account_id`. Reports that count client actions filter on `changes->>'principal'`.
- **Tables.** `portal_login_tokens`, `portal_sessions` and `portal_stream_tokens` keep the staff Layer 1 policy, the support read-only policies and statement trigger, and a single permissive policy `USING (false)`; `app_user` has no privilege on them at all. `portal_stream_tokens` is not in PHASE2_3_PLAN §4's list: R-PORTAL-7's single-use 60 s token needs state, and it is definer-only like the other two.
- **The client actor.** `ClientActor` carries a module-private brand: only `resolvePortalSession` (and `consumePortalLogin`, which resolves the new session) constructs one. Lint `realty/portal-tx-separation` bans `withPortalTx` and client-actor literals outside `packages/db/src/portalTx.ts` and `apps/api/src/portal/client/**`, and bans `withTenantTx`, `withPreTenant`, `withNoContext` and `actorGucs` inside `apps/api/src/portal/client/**` (module 45 puts its client routes there and its staff invite/grant/publish routes elsewhere, e.g. `apps/api/src/portal/staff/**`). `withPortalTx` sets exactly `app.tenant_id`, `app.principal_type = 'client'` and `app.portal_account_id` and clears `app.user_id`, `app.actor_kind` and `app.ownership_command`, transaction-locally.
- **Residual (Q11).** A compromised API process can still put any account id in the client GUCs: RLS trusts the context, as Phase 1 trusts `app.user_id`. The brand, the lint rule and the definers' re-checks narrow it; a separate DB login role for the portal remains open question Q11.
- **Not done here (later modules or ops).** Sending the link (module 45, `dispatchOutbound`), HTTP rate limits per IP and per address (module 45, `auth.rate_limit_hit`), the `__Host-psid` cookie and CSRF secret (module 45), and purging expired tokens and sessions (inert once expired; a retention step is not yet written).
### 21.8 Security notes: module 21 `api/integrations`
- **`app.resolve_channel_account(kind text, external_account_id text) → (tenant_id, connection_id)`** (module migration `*_integrations.sql`; security-review item). Pre-tenant `SECURITY DEFINER`, owned by `app_definer`, `search_path = pg_catalog, public`, `STABLE`, `EXECUTE` revoked from `PUBLIC` and granted to `app_user` only. It reads `integration_connections` joined to active `tenants` and returns two ids, nothing else (no credential, no status, no payload). It routes only `connected`/`degraded` rows (R-TEN-11): `pending_review` reserves an account but routes nothing, and every other status, a suspended tenant, an unknown account and the keyed kinds (web-chat widget, lead inbox) resolve to no row, which the caller records as unrouted (E136). The kind is part of the key, and the 0018 global live-account index means at most one row can match. Owner decision D2 removes Messenger/Instagram DMs, Meta Lead Ads and Meta ads, so `messenger_page`, `instagram_account`, `meta_lead_ads` and `ads_meta` are not routable at all (`ads_meta` since the D2 review fix migration, which replaces the resolver with 0024's body less that kind and the same owner, search_path and grants; 0024 is not edited). Module 21 never offers or connects them or `ads_meta`: the API lists them as "Not offered", refuses their connect start (`INTEGRATION_NOT_CONNECTABLE`), ends a callback for one with `STATE_INVALID` before any provider call, and the status machine never moves them toward a connection; a row made before D2 can still be disconnected. `ads_meta` stays in the kind CHECK until the D2 cleanup, and no path connects such a row. Publishing uses the 0025 kinds `facebook_page` and `instagram_business`, which are not routable either: they are never an inbound channel, so they never carry a lead source (CHECK `integration_connections_publishing_no_source`; the API refuses one first with `LEAD_SOURCE_NOT_ALLOWED`). The caller passes the account id from a signature-verified envelope; payload fields never choose the tenant. Tests: `apps/api/src/integrations/integrations.test.ts` (routing matrix, live pre-D2 `messenger_page`/`instagram_account`/`meta_lead_ads` rows that route nothing, owner/definer/search_path/ACL check) and `adversarial.test.ts`.
- **The provider callback is the only writer of routing keys** (R-INT-3). `GET /api/admin/integrations/:kind/callback` is a `public` route whose only authority is a MAC-signed OAuth state (HMAC-SHA256 under a key derived from the server session secret) naming tenant, connection, starter, kind, the requested account, a 10-minute expiry and the row's `updated_at` fence. It runs as the system actor of the tenant in the verified state, never request input. It re-checks the fence under a row lock, so a state is single-use and a race of two callbacks links once. It checks that the starter is still an active Owner/Admin. It proves control by listing the accounts the token manages, so a Page the tenant does not manage is refused and nothing is linked (E160). The global live-account index keeps an account live in one tenant (E135). The PKCE verifier is derived from the server secret and never leaves the server, so an injected authorization code fails the exchange. The token is stored only as an envelope-encrypted `provider_credentials` row. On every refusal the token is revoked at the provider (best effort) and only `last_error_code` is written. Disconnect sets the status and revokes the credential locally in the same transaction (R-INT-5). An `integrations.revoke_grant` job then decrypts the token as the system actor, revokes it at the provider (best effort) and purges the secret. The 0018 guard stays the backstop: a person writing `external_account_id`, `credential_id`, a live status or `capabilities` is refused.
- **Honesty.** In production, without an explicit staging demo flag, every adapter reports "not set up on this platform" (OAuth `configured: false`, partner feeds and MLS `needs_partner_access`). No fake runs for a real team. Requested OAuth scopes are least-privilege catalog data marked VERIFY. Meta requests publishing scopes only, and a test proves that no messaging or Lead Ads scope is ever requested, including a Meta scope under a new name that mentions messaging. Each platform pack's sentence says "cleared" only when `app.platform_cleared` clears it (R-INT-6): `platform:voice` and `platform:gmail` stay off until `rules.vendor_ready_at` is set, even after counsel review, and `platform:meta` says it is never cleared (D2) rather than awaiting review.
### 21.9 Core content modules (lane p23-core-content: modules 20, 23, 25, 27, 49)
Pure core only: no migration, no SECURITY DEFINER function and no I/O. Security-relevant choices for reviewers:
- **Fair housing (20).** One pack `fh/1` (`DEFAULT_FAIR_HOUSING_PACK`, deeply frozen) drives the copy check, the assistant/voice guard and the targeting validator. Detection folds obfuscation (NFKC, invisible characters, look-alike letters, leetspeak, spelled-out letters). A bare negation never hides a term; only an equal-opportunity frame within 3 words downgrades a hard match to soft, which still blocks autonomy. Jurisdiction data can only add terms or escalate soft to hard; pack patterns are a closed word grammar, never regular expressions. Mutation score on `check.ts` 99.6 % (`pnpm exec stryker run src/fairhousing/testing/stryker.config.mjs` in `packages/core`). **VERIFY WITH COUNSEL (C3, C5)**: the lexicon itself.
- **Content guard (25).** Any fair-housing match adds `FAIR_HOUSING` to `contentGuard` (so the step is a draft flagged "Check this"); the pack defaults to `fh/1` and cannot be switched off. `inbound_channel` steps validate only in `new_lead_response`; until module 22 lands, `buildStep` skips them visibly.
- **Prediction (49).** `PredictionFeatures` cannot express anything but the six allowlisted features; `realty/no-prediction-import` keeps `core/predict` and `core/coaching` out of ownership, priority, ads, portal, comms and lead routing (R-PRED-4).
### 21.10 Gmail inbox sync (D2)
Read-only copies of an agent's own Gmail conversations with their clients, shown in the contact timeline (module 68 `apps/api/src/mailSync/**`, module 69 web). Dark until `platform:gmail` is cleared (counsel C14 + Google verification N19) and the Owner turns `tenant_settings.mail_sync_enabled` on (R-GMAIL-1). Rules R-GMAIL-1..14, tables DATA_MODEL §6.3.

**Flow.**
1. **Connect.** The agent reads the disclosure (its hash is stored) and starts OAuth with PKCE and a `state` bound to their session; scope `https://www.googleapis.com/auth/gmail.readonly` only (**VERIFY**). Gmail uses its own OAuth client (at least never `include_granted_scopes`), so a calendar grant never rides along and the exact-scope check holds (**VERIFY** Google's granted-scope semantics).
2. **Callback** runs as the system actor: it exchanges the code, refuses any token whose granted scopes are not exactly that one (E225), reads the mailbox profile (`users/me`) and inserts `user_mail_links` with the profile's address and its HMAC under the tenant HMAC key (`mailbox_address_hmac`, immutable). The DB refuses a second live link for the user, or for the mailbox in any tenant (R-GMAIL-2).
2a. **Confirm addresses** (S-D2-1). Module 69 shows "Sync Gmail with these clients?": the current email points of the agent's related contacts, one bulk confirm (`POST /me/mail-sync-points`); later each new address is a one-tap suggestion, and "Stop syncing this address" deletes the confirmation (`DELETE /me/mail-sync-points/:pointId`). Only the link's own user inserts `mail_sync_points`, as themselves, on their own live link; the definer guard `app.mail_sync_points_guard` refuses an unrelated contact, a point not current, and an address that is any live link's mailbox in the tenant. Nothing syncs for an address the agent did not confirm, so a peer who adds a stranger's address to a contact and makes the agent a collaborator or deal member, or a TL who adds the agent's own mailbox as a contact point, captures nothing (E203).
3. **Sync.** Module 68's per-tenant reconcile handler (`mail.sync`) picks links whose `next_sync_at` is due, decrypts the refresh token, gets an access token in memory and calls `history.list` from the stored `history_id`. For each added message: skip SPAM, TRASH, DRAFT and CHAT; parse the headers; normalize and HMAC every From/To/Cc/Bcc address; for a message **from** an address that matches any current email point of the tenant, classify once with the deterministic `classifyInbound` **before and regardless of storage** (opt-outs, R-GMAIL-9, S-D2-3), recording each result as platform email does (an unsubscribe or keyword, and a wrong-number reply with source `wrong_number`, revoke email on that point; opt-out language sets the person-level do-not-contact): an excluded thread, the per-thread cap, an unrelated contact or an unconfirmed address stores nothing, and the consent event then cites `{"kind":"synced_gmail","gmail_message_ref":"<sha256 hex of link id + Gmail message id>"}` instead of the copy (E229); outside excluded threads, match the **confirmed**, current email points of contacts the mailbox owner owns, collaborates on or shares a deal with; strip quoted history and the signature (best effort); insert one `mail_messages` row per matched contact (the DB guard re-checks the link, the exclusion, the relation, the point, the confirmation, that the address is no live mailbox, the window, the per-thread cap and the platform-email dedupe). For a **live** one whose Gmail `internalDate` is within 1 hour of the fetch, call `ingestSyncedMailInTx(tx, contactId, mailMessageId, classification)`, module 68's one flagged function in `comms/inbound.ts` (after module 22): the Phase 1 lock, pause, cancel of queued assistant messages and scheduled trigger runs, and exactly one handback "replied in Gmail" citing the `mail_message` by id and time, with no body snippet and no `assistant.enrich_handback` job; no `messages` row is written and nothing is classified again (R-GMAIL-10). Phase 1 `ingestInbound` is not used: it writes a `messages` row, needs a conversation, re-classifies, quotes the body in the handback and enqueues the AI enrichment. An older live message (a resync, an outage) is stored and opt-out-classified but neither pauses nor hands back. The cursor advances only after the page's rows commit.
4. **Deletes.** A message deleted, trashed or marked spam in Gmail deletes its copies; so does an exclusion, a removed contact point, a withdrawn confirmation (S-D2-2; those copies are hidden at once by the read policy), and a platform `messages` row with the same Message-ID hash (the platform row wins, R-GMAIL-12). Losing the relation (a reassignment) deletes nothing: the new owner reads the copies with the timeline (E216).
5. **Expired history id.** A bounded resync inside the backfill window, never a full-mailbox read; what it finds pauses only under the 1-hour rule (R-GMAIL-11, R-GMAIL-10).
6. **Backfill** at connect and on "import again": at most `mail_backfill_days` (Owner, 0–90, default 30) and `backfill_max_messages`, paged with `backfill_page_token`; origin is the DB's (`internalDate` < `connected_at` ⇒ backfill); backfill never pauses automation or creates handbacks (R-GMAIL-8).

**Tokens.** Only the refresh token is stored: envelope-encrypted under the tenant field key with AAD bound to table, column and row (`crypto/envelope.ts`), decrypted only by the system actor inside a sync pass. The link's own user can read `refresh_enc` under RLS (the system actor uses the same `app_user` role, so no column grant can separate them, S-D2-7): module 68's architecture test forbids selecting it outside `mailSync/token.ts`, and no route returns it. A person's disconnect changes no system-owned sync column beyond deleting the token and page token (S-D2-6). Access tokens never leave memory. Revoking deletes the token in the same transaction (CHECK) and revokes it at Google, best effort and retried (R-GMAIL-4).

**Disconnecting** (the agent, member deactivation, the Owner's switch off, the pack uncleared, `invalid_grant`) revokes the link: token deleted at once; copies hidden at once by the RESTRICTIVE policy and deleted by the reconcile handler within one sync interval (`poll_interval_seconds`, 120 s by default; the handler also selects revoked links that still have copies, not only links whose `next_sync_at` is due); the link and its exclusions purged at `purge_after` (≤ 30 d); database backups expire per DEPLOY backup retention (DEPLOY §8: point-in-time window of at least 35 days; **VERIFY WITH COUNSEL**). Erasure deletes the contact's copies (R-DATA-7). Merge: the system re-points the merged contact's copies to the survivor and its confirmed email point with the same address HMAC (the only UPDATE the DB allows on a copy); a copy that would collide with the survivor's own copy of the same Gmail message, or whose survivor point is unconfirmed, is deleted instead (R-GMAIL-13). Default for Q-GMAIL-1: delete, not keep.

**Visibility.** The contact's timeline visibility plus the mailbox owner for their own link; never a support actor (even under a grant) and never a client principal (R-GMAIL-6). Team visibility stays the timeline audience by default (owner question Q-GMAIL-5; the connect disclosure says so; employee and third-party notice is C14). The RESTRICTIVE read policy calls `app.mail_copy_live(tenant, copy)`, a definer that takes only the copy's own identity and checks the link, the exclusion, the point (current) and its confirmation (S-D2-2, S-D2-4), and answers only a caller the read policies admit for that copy (a staff user or the system who can read it: the system, the mailbox owner or a reader of the contact's timeline), so a support actor, a client principal or a peer who holds the copy's id from consent evidence learns nothing (D2 review fixes); no function answers for a link or thread by id. The read policy tests the mailbox link before the timeline helper, so the system's sync, purge and re-point passes and the mailbox owner never pay that helper per row (PERFORMANCE §5). Nobody else sees a link, its token, its sync state, its exclusions or its confirmed addresses. Bodies are plain text at rest like `messages.body` (**VERIFY** under N19 whether field encryption is expected; if so a later migration adds `body_enc`). **Read path:** module 68's `GET /contacts/:id/mail-messages` (`mailSync/routes.ts`, paged, RLS does the visibility); module 69 merges the entries into the thread on the client. Phase 1 search does not index synced mail in v1.

**Dedupe.** Module 22 stores `messages.rfc_message_id_sha256` on platform email, inbound and outbound, as the system: inbound ingestion on inbound, dispatch TX2 on outbound (TX1 runs as the person, and the trigger `messages_rfc_guard` lets only the system set the hash, once, so no person can plant a hash to suppress a teammate's copy or clear one; **VERIFY** whether each provider keeps the Message-ID we generate or assigns its own, which TX2 then stores from the provider response); a Gmail copy with the same hash for the same contact (or one merged into it) is refused, or deleted when the platform row lands later. The database refuses a duplicate only of platform email whose row carries the hash: rows saved before module 22 writes it, rows whose Message-ID it could not learn and imported email (never hashed) are not deduplicated, so a backfill would show such a message twice. Rollout precondition (`platform:gmail` notes): `vendor_ready_at` is set only after module 22 has hashed platform email for at least 90 days (the largest `mail_backfill_days`), or after a one-time module 22 repair hashed the recoverable rows of that window (SendGrid inbound from `provider_message_ref`, SMTP outbound from the Message-ID it generates; Postmark inbound and SES/Mailgun outbound only from the provider, **VERIFY**). Both paths use the handback dedupe key `email:{contact}:{rfc_message_id_sha256}` when the hash is known, so whichever lands first hands back and the other does not (E201).

**Never.** No send, label, archive or delete in Gmail; synced mail is never a `messages` row, never dispatched, never a touch, speed-to-lead or ownership event, and never sent to an AI model or used in drafts (**VERIFY** Google Limited Use); evidence cites it by id and time (`mail_message`, never quoted, CHECK `evidence_refs_mail_not_quoted`); audits carry no content; an architecture test proves no SQL names `mail_messages` or `user_mail_links` outside `apps/api/src/mailSync/**` (plus `ingestSyncedMailInTx`) and `mailSync/**` imports no model provider (R-GMAIL-14); that test, not the database, is the barrier against AI reads (one login role; a GUC set by the caller is no barrier against the code it guards, S-D2-8).

**Why not.**
- Outlook/Exchange mail: not requested by the owner (D2); calendars stay.
- Push (Gmail `watch` + Pub/Sub): not in v1; polling every `poll_interval_seconds` is simpler and needs no public push endpoint (**VERIFY** Gmail API).
- Sending through Gmail: not built. It would need a send scope and a second send path; replies go through platform email (`dispatchOutbound`) or happen in Gmail.
- "Private but kept" (hidden from the team, kept for the agent): not adopted; an excluded thread is deleted (R-GMAIL-7).

### 21.11 Publishing (D2)
Posting to a Facebook Page, an Instagram business account or a GBP location goes only through `publishPost` (`marketing/publish.ts`: module 29 ships the Facebook Page and Instagram business branches; module 53 adds the `gbp_location` branch in one flagged edit after 29), and only for an approved piece of the matching kind, to a `connected`/`degraded` connection, once `platform:fair_housing` is cleared; otherwise the piece is exported. TX1: a listing writer taps, as themselves, and a `marketing_publications` row is inserted `publishing`. The provider call follows. TX2: the system records the outcome: `published` (with the provider's post id), `failed` (error code) or `unknown` (a timeout or ambiguous answer). `unknown` is reconciled by looking the post up, never by posting again (one live row per piece and target), and moves to `published` or `failed`; `published → retracted` only after the provider confirmed the deletion. Only the system records outcomes. If a timed-out post cannot be found without a post id (**VERIFY**), `unknown` stays unknown and the UI says "Check your Page/Instagram". The product says "Posted" only for a provider-confirmed row (R-MKT-12, E227). A piece is `published` while its public page is live or at least one publication is `published`. A new version never touches the old version's external posts (the UI says the earlier post stays on the Page); retracting one is the system's after the provider confirmed the deletion, where the API supports it, otherwise a feed card asks the agent to remove it (R-MKT-4, R-MKT-9). Instagram (**VERIFY** each): images are fetched from a publicly reachable URL, so assets are exposed by a short-lived signed URL only; whether text-only posts exist; whether published media can be deleted through the API. The Meta connection requests content-publishing permissions only and receives no webhooks (E228).
