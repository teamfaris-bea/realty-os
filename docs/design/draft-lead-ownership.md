# Realty OS: Phase 1 Design Draft (Lens: Lead Ownership Determinism)

Status: draft for comparison. This is one of several independent drafts.
Scope: the whole Phase 1 data model. Lead ownership, timers, routing and ponds get the most depth.
Stack: as fixed (TypeScript, Node 22, pnpm monorepo, `packages/core` pure, Postgres 16 + Kysely + RLS, Fastify 5, React 18). Nothing here proposes a stack change.

Legal statements are marked **VERIFY WITH COUNSEL**. Wherever the law varies by jurisdiction, the design uses a configurable policy with a conservative default instead of hard-coding the law.

---

## 0. Summary of key decisions

1. **Ownership is per contact, not per inquiry.** Each contact has one `contact_ownership` row, which is the projection. It is derived from an append-only, gapless, per-contact ledger, `lead_ownership_events`. The ledger is the source of truth, and the projection can always be rebuilt by folding the events.
2. **Every ownership change goes through one code path, `applyOwnershipCommand`.** The steps are:
   1. Lock the projection row (`FOR UPDATE`).
   2. Read `now` from the database (`clock_timestamp()` after the lock).
   3. Call the pure decision function in `packages/core`.
   4. Append the events with `seq = prev + 1…`.
   5. Update the projection.
   6. Enqueue jobs, feed items and notifications.

   All six steps run in one transaction. A DB trigger rejects any projection write that lacks the command context, or that has no ledger event with the same `seq`.
3. **Pessimistic row lock plus a monotonic `seq`.** The row lock serializes contention on a single contact. `seq` provides ordering, the optimistic-version check for UI commands (`expected_seq`), and fencing for timers. `UNIQUE (tenant_id, contact_id, seq)` is a last-line linearization guard.
4. **Deadlines live in data, and jobs only wake the system up.** Offer expiry, first-touch SLA and inactivity release are stored as absolute UTC instants on the projection. Queue jobs are hints that carry a fencing token (`offer_id` / `seq`). A sweeper running every 15 s finds overdue deadlines even if jobs are lost, so correctness never depends on job delivery.
5. **Offers go to one agent at a time.** The default offer window is 5 minutes, counted in routing hours. The default is 3 offers per lead before it falls to the default pond. A "first to claim" broadcast is modelled as routing to a pond, not as a separate mechanism.
6. **Rotation is deterministic.** Round-robin uses a stored cursor. Weighted routing uses smooth weighted round-robin with stored state. Every offer records the candidates considered and why each was skipped, so routing can be explained ("transparent AI/automation") and replayed.
7. **Tenant isolation is a hard database boundary.** Every tenant-scoped table uses composite primary keys `(tenant_id, id)` and composite foreign keys that include `tenant_id`, so a row cannot reference another tenant's row even through a bug. RLS uses `FORCE`. Cross-tenant infrastructure reads (job claim, deadline sweep, webhook tenant resolution, auth) go through narrow `SECURITY DEFINER` functions owned by a `NOLOGIN BYPASSRLS` role. Those functions return identifiers only.
8. **Within a tenant, visibility is enforced in the application layer in Phase 1.** One visibility module plus a role-by-resource test matrix enforces it. Pond leads are masked (no phone, email or last name) until claimed. Restrictive RLS for agent visibility is an open question (§11).
9. **`canContact` is the single compliance gate.** It runs at compose time and again at send time in the outbound worker. Its decision snapshot is stored on every message and call. Suppressions are keyed by normalized address rather than by contact, so they survive merges, deletes and re-imports, and they can never be deleted.
10. **Phase 1 sends no automated outbound messages.** AI drafts always need a human tap to send. Instant auto-replies, drips and AI auto-send are cut to Phase 2. They are the largest TCPA exposure and are not needed to beat Follow Up Boss on daily speed.

---

## 1. Ownership model

### 1.1 Concepts

| Concept | Meaning |
|---|---|
| Contact | A person. Holds contact points (phones and emails), the timeline, deals and tasks. |
| Inquiry (`lead_inquiries`) | One inbound lead event from a source (portal, website, Zapier-style webhook, manual). One contact can have many inquiries. An inquiry may trigger routing. |
| Owner | The single user accountable for the contact. Drives visibility, the feed, SLAs and accountability metrics. |
| Collaborator (`contact_collaborators`) | Additional users with access (ISA after handoff, TC, co-agent). Collaborators are not owners and do not affect routing or SLAs. |
| Offer | A time-boxed proposal of an unowned lead to one agent. It is identified by `offer_id`, which also serves as the fencing token. |
| Pond | A named pool of unowned leads that eligible members can claim. Each tenant gets one default pond, "Team Pond", at creation. |

### 1.2 States

```
                 created / imported(no owner)
                        │
                        ▼
   reopened ──► [unassigned] ──sent_to_pond──────────────┐
                        │ offered                         │
                        ▼                                 ▼
                   [offered] ──declined/expired──► (next offer | sent_to_pond) ──► [in_pond]
                        │ offer_accepted                  ▲                        │ claimed / assigned
                        ▼                                 │ released / inactivity   ▼
   assigned/imported ─► [owned] ◄──reassigned (owned→owned)┘  _released / deactivation [owned]
                        │
                        ▼ closed (spam, merged_away, deleted)
                    [closed] ──reopened (admin)──► [unassigned]
```

| State | Invariants (enforced by a CHECK constraint) |
|---|---|
| `unassigned` | No owner, no pond, no offer. Short-lived: routing is enqueued in the same tx. |
| `offered` | No owner. `offer_id`, `offered_to_user_id` and `offer_expires_at` are set. |
| `owned` | `owner_user_id` and `owned_at` are set. No pond, no offer. |
| `in_pond` | `pond_id` is set. No owner, no offer. |
| `closed` | No owner, no offer. Never routed. Re-inquiries are handled per R-OWN-11. |

### 1.3 Event types (ledger)

`created, imported, offered, offer_accepted, offer_declined, offer_expired, offer_rescinded, claimed, assigned, reassigned, released, sent_to_pond, reinquiry, first_touch_recorded, first_touch_breached, sla_waived, inactivity_warned, inactivity_released, closed, reopened, merged_away, merged_in, command_rejected`

- Each event row carries: `from_state`, `to_state`, owner after the event, previous owner, `pond_id`, `offer_id`, `routing_rule_id`, `actor_kind` (`user | system | timer | import | provider`), `actor_user_id`, `reason_code` (machine-readable), `command_id`, `payload` and `occurred_at`.
- `command_rejected` has `to_state = from_state` and does not change the projection. It exists so that rejected accepts and claims are part of the audit trail, as the spec requires.
- Speed-to-lead metrics come from the ledger alone. Offer-to-accept is `offered.occurred_at → offer_accepted.occurred_at`. Owned-to-first-touch is `owned_at → first_touch_recorded`. Phase 2 accountability reads these.

### 1.4 Core API (packages/core, pure)

```ts
export type OwnershipCommand =
  | { kind: 'route'; inquiryId?: Id }                          // system
  | { kind: 'accept'; offerId: Id }                            // offeree
  | { kind: 'decline'; offerId: Id; reason?: DeclineReason }   // offeree
  | { kind: 'claim'; pondId: Id }                              // pond member
  | { kind: 'assign'; toUserId: Id; reason: ReasonCode }       // TL/Admin/Owner, ISA handoff
  | { kind: 'release'; reason: ReleaseReason; toPondId?: Id }  // owner
  | { kind: 'timer'; deadline: 'offer_expiry' | 'first_touch' | 'inactivity' | 'inactivity_warning'; fence: { seq: bigint; offerId?: Id } }
  | { kind: 'touch'; via: 'call' | 'sms' | 'email'; refId: Id } // emitted by comms after a successful send/dial
  | { kind: 'reinquiry'; inquiryId: Id }
  | { kind: 'close'; reason: CloseReason } | { kind: 'reopen' }
  | { kind: 'merge'; survivorId: Id; loserId: Id; ownerChoice: Id | null }
  | { kind: 'deactivate_owner'; destination: DeactivationDestination };

export interface DecisionContext {
  now: Instant;                       // DB clock_timestamp() read AFTER the row lock
  ids: IdGenerator;                   // injected; deterministic in tests
  actor: Actor;                       // user/system/timer + membership snapshot
  settings: EffectiveLeadSettings;    // defaults deep-merged with tenant overrides
  routing?: RoutingSnapshot;          // rule, members, eligibility inputs, rotation cursor (locked)
  pond?: PondSnapshot; claimStats?: ClaimStats;  // claims today, cooldowns, capacity
  calendar: BusinessCalendar;         // tenant routing hours + IANA tz
}

export type Decision =
  | { ok: true; events: OwnershipEvent[]; next: OwnershipProjection; effects: Effect[] }
  | { ok: false; code: OwnershipErrorCode; events: OwnershipEvent[] /* command_rejected + any due expiry */; next: OwnershipProjection; effects: Effect[] };

export function decide(state: OwnershipProjection | null, cmd: OwnershipCommand, ctx: DecisionContext): Decision;
export function fold(events: readonly OwnershipEvent[]): OwnershipProjection;   // decide(...).next === fold(prev ++ events)
```

`Effect` is a closed union: `enqueueTimer`, `cancelTimer`, `notify`, `upsertFeedItem`, `invalidateDrafts`, `cancelOutbound`, `routingCursorUpdate`. The db layer interprets effects inside the same transaction. Core never performs I/O.

Property tests (Vitest + fast-check) cover:
- `fold(events) == next` for random command sequences.
- No sequence of commands produces two owners or violates a state invariant.
- `seq` is gapless.
- Replaying any command with the same `command_id` is a no-op.

### 1.5 Transaction protocol (`applyOwnershipCommand`, packages/db)

```
BEGIN;                                                  -- READ COMMITTED is sufficient: the row lock serializes
SET LOCAL app.tenant_id = $tenant; SET LOCAL app.user_id = $user;
SET LOCAL app.ownership_command = $command_id;          -- unlocks the projection guard trigger
-- 0. idempotency: SELECT … FROM lead_ownership_events WHERE tenant_id=$t AND command_id=$cmd → if found, return stored outcome; COMMIT
-- 1. SELECT * FROM contact_ownership WHERE tenant_id=$t AND contact_id=$c FOR UPDATE;
--    (a second contact, for merges, is locked in ascending contact_id order)
-- 2. if cmd.expected_seq given and ≠ row.seq → still decide (state-based), but the UI is told it was stale
-- 3. route/claim only: SELECT … FROM routing_rotation_state … FOR UPDATE; memberships of candidates FOR SHARE
-- 4. now := clock_timestamp();
-- 5. decision := core.decide(row, cmd, ctx)
-- 6. INSERT INTO lead_ownership_events (… seq = row.seq+1 … row.seq+n);
-- 7. UPDATE contact_ownership SET … , seq = row.seq+n;   -- guard trigger checks the ledger row exists with that seq/to_state
--    (trigger syncs contacts.owner_user_id)
-- 8. interpret effects: INSERT INTO jobs (dedupe_key …), feed_items upsert, notifications, ai_outputs invalidation, audit_log
COMMIT;
```

- **Lock order** is global, which prevents deadlocks: `contact_ownership` (ascending contact_id) → `routing_rotation_state` → `memberships` (FOR SHARE) → `ponds` (no lock; read-only). Deactivation takes `memberships … FOR UPDATE` alone, in a separate tx, before it touches any contact.
- **Retries.** `serialization_failure` and `deadlock_detected` are retried up to 3 times with jitter, using the same `command_id`, so retries are idempotent.
- **Single time source.** `now` is the DB clock read after the lock. App-server clock skew across nodes cannot affect outcomes. Core never reads a clock.

### 1.6 Timers

| Timer | Default | Counts in | On fire |
|---|---|---|---|
| Offer window | 300 s (per rule, 30 s to 24 h) | Routing hours | `offer_expired`, then the next eligible candidate is offered, or `sent_to_pond` after `max_offers` (default 3). |
| First-touch SLA | 15 business-minutes from `owned_at` (on accept or claim, not on manual self-create or import) | Routing hours | `first_touch_breached`, then notify owner + TL. **Default action is notify, not release.** It is configurable to `release_to_next`. Fires at most once per ownership period. |
| Inactivity release | ON, 30 days without an owner touch, only for stages `new` and `attempting`, never with an open deal | Calendar days | Warning 72 h before (`inactivity_warned` + notification), then `inactivity_released` to the default pond. Any touch resets the timer. |

**Routing hours** default to 08:00–21:00 in the tenant timezone, 7 days a week. Outside those hours an offer is still delivered immediately and can be accepted at any time, but its window starts counting when routing hours next open. A lead arriving at 23:10 therefore offers at 23:10 and expires at 08:05.

**What counts as a touch:** an outbound call attempt that reached the provider (dialed), or an outbound SMS or email accepted by the provider, by the owner or by an ISA collaborator, after `owned_at`. AI drafts do not count until they are sent.

**Business-time arithmetic** (`addBusinessDuration(start, seconds, calendar)` in core):
- It uses a pure IANA tz implementation. Temporal polyfill or Luxon would both work; this is a library choice inside core, not a stack change.
- Windows are local wall-clock times. Elapsed time is real seconds inside the windows.
- **Spring-forward:** a window boundary that falls in the skipped hour moves to the first valid instant after the gap.
- **Fall-back:** an ambiguous local time resolves to the earlier offset (Temporal `compatible`). During the repeated hour, elapsed real seconds still count once each.
- Test vectors are required for America/New_York, America/Chicago, America/Denver, America/Phoenix (no DST), America/Los_Angeles and Pacific/Honolulu, on both 2026 and 2027 transition dates.
- Deadlines are computed once at schedule time and stored as absolute UTC. **Changing tenant hours or timezone never moves an existing deadline** (R-TMR-1).

**Delivery guarantees:**
- Scheduling a timer inserts a `jobs` row with `dedupe_key = 'offer_expiry:'||offer_id` (or `first_touch:'||contact||':'||seq` etc.) and `run_at = deadline`.
- The `ownership_due()` sweeper runs every 15 s and lists overdue deadlines across tenants (identifiers only). It issues `timer` commands for any deadline without a running job. Maximum lateness is the sweep interval plus processing time.
- A timer command whose fence (`offer_id` / `seq`) no longer matches is a no-op. The job completes and no event is written.
- If a timer command finds `now < deadline` (an early wake), it reschedules itself.

### 1.7 Routing

**Rules** (`routing_rules`) are evaluated by `position`, and the first match wins. Match fields in Phase 1, all optional (an absent field matches anything):
- `sources` (lead_source ids)
- `lead_types`
- `zips` (exact 5-digit list)
- `price_min` / `price_max` (against the inquiry's price, or the midpoint of its price range)

If no rule matches, the lead goes to the default pond and the TL is notified. Geo polygons, per-agent schedules and language matching are Phase 2.

**Strategies:**

| Strategy | Behaviour |
|---|---|
| `round_robin` (default for the auto-created rule) | Candidates are the rule members ordered by `user_id` (a stable order). The cursor is the last offered user. The next candidate is the first eligible member after the cursor, circularly. Skipped (ineligible) members keep their place, so they are offered first once they become eligible again. |
| `weighted` | Smooth weighted round-robin. For each eligible member `c`: `current[c] += weight[c]`. Pick the member with the highest `current` (ties go to the lowest `user_id`), then `current[pick] -= Σweights(eligible)`. State lives in `routing_rotation_state.cursor`. This is deterministic and gives exact proportions over a cycle. |
| `direct` | Offer to `direct_user_id`. It still follows the offer protocol. If that user is ineligible or the offer expires, the lead goes to the fallback pond. |
| `pond` | `sent_to_pond` to `target_pond_id` immediately and notify pond members ("first to claim"). |

**Eligibility.** A candidate must pass every check below, in this order, and the first failed check is recorded as the skip reason:
1. membership `status = 'active'`
2. role ∈ {agent, team_lead, isa}
3. `accepting_leads = true`
4. has at least one working critical-notification channel (push device or verified SMS)
5. not already offered this lead in the current offer sequence
6. not in release cooldown for this lead (default 72 h)
7. open uncontacted leads (`owned`, `first_touch_at IS NULL`) below the capacity cap (default 5)

**Auto-pause.** After 3 consecutive missed or declined offers (default), the system sets `accepting_leads = false` and notifies the agent and TL. This keeps the rotation from cycling through absent agents.

**Explainability.** The `offered` event payload records `{rule_id, rule_version, strategy, cursor_before, cursor_after, candidates:[{user_id, eligible, skip_reason}]}`. The admin UI shows "Why did Sam get this lead?" straight from that payload.

**Rule edits.** An offer sequence keeps the `rule_id` chosen at first routing. Each subsequent offer reads that rule's current member list, because eligibility depends on time anyway. Rule versions are recorded on each event.

### 1.8 Ponds and claims

- **Masking.** `mask_contact_info` is on by default. Before claim, pond members see first name, last initial, source, lead type, zip or city, price range, inquiry age, the last activity type and an AI one-line summary. Phone, email, full name, address and timeline content are hidden. Masking happens server-side in the serializer, and contact points are never sent.
- **Claim requirements.** The claimer must:
  - hold a role in `eligible_roles` (default agent, team_lead, isa)
  - have an active membership
  - be under `claims_per_day` (default 5, counted per tenant-local day)
  - not be in cooldown (the user who released or lost this lead cannot reclaim it for 72 h)
  - be under the capacity cap
  - stay under the claim rate limit (10 claim attempts per minute per user)
- **Concurrency.** The first transaction to take the row lock wins. Every other claimer gets `LEAD_ALREADY_CLAIMED` (recorded), and the UI shows "Claimed by {first name} just now". This race was verified against Postgres 16 (§13).
- **New-pond-lead notifications** are push only, sent during routing hours, and batched to at most 1 per 10 minutes per user. They are low priority, except that `pond` strategy routes notify immediately.
- **Re-engagement.** A re-inquiry from a contact sitting in a pond is re-routed through the rules by default (pond setting `reinquiry: 'reroute' | 'stay'`). The `reinquiry` event payload includes how long the lead sat in the pond.

### 1.9 Derivability and drift

- `fold(events)` must equal the projection. A nightly job (`maintenance` queue) re-folds every contact with events in the last 25 hours, plus a 1% random sample of all contacts. Any mismatch raises a P1 alert and writes an `audit_log` entry. It does **not** auto-correct, because a silent fix would hide bugs.
- Rebuilding the projection for a contact is an Admin-only maintenance command. It is audited and uses the same guard path.

---

## 2. Priority Feed scoring

The feed is a list of `feed_items` maintained by domain-event effects in the same transaction as the event. Scores are computed at read time in core, using `now`, so time-dependent urgency is always current. Score weights are fixed in Phase 1 (`score_version = 1`), not configurable. Each item shows its top two reasons ("Why this is here").

**Pinned band.** These are always first, sorted by deadline ascending:
1. An active offer to me, shown with a countdown. One tap accepts.
2. My first-touch SLA, running or breached. One tap calls; a secondary action texts, with an AI draft.
3. An inbound message or missed call from my contact that has had no reply for under 24 h.

**Scored band.** Score runs 0–100 and is clamped. Each point source emits a reason string.

| Group | Input | Points |
|---|---|---|
| Urgency (≤ 60) | Overdue task (by hours overdue, log-scaled) | 10–30 |
| | Task or appointment due today | 15 |
| | Deal key date in ≤ 3 days (closing, contingency) | 20–35 |
| | Inbound unanswered 24–72 h | 20 |
| | Engaged lead with no touch in 7+ days | 15 |
| | Inactivity release warning active | 25 |
| Value (≤ 25) | Lead type seller or buyer_seller | 10 |
| | Price vs tenant 90-day median inquiry price (log ratio) | 0–10 |
| | Stage appointment, active_client or under_contract | 10 |
| | Open deal value present | 5 |
| Engagement (≤ 15) | Inbound in last 24 h | 10 |
| | Reply ratio over last 5 outbound | 0–5 |
| Penalties | Snoozed and returned | −5 |
| | Primary action blocked by `canContact` with no alternative channel | −20, reason "Can't contact: {reason}" |
| | Contact owned by someone else (TL view only) | n/a, filtered |

**Ordering and limits.** Ties break by deadline ascending, then score descending, then `created_at`, then `id`, which gives a fully deterministic order. Each user has at most 200 open items, and reads return the top 50. Items dedupe on `(tenant_id, user_id, kind, subject_id)`.

**Compliance in the feed.** The one-tap action is computed through `canContact`. When SMS is blocked, the item offers call or email instead, and the blocked reason is visible. An item is never hidden only because contact is blocked, because agents need to know why.

**Phase shaping.** `base_inputs jsonb` and `score_version` let Phase 2 (website activity, AI weekly plans) and Phase 3 (coaching) add inputs without migrating the schema.

---

## 3. Consent and compliance gate (`canContact`)

```ts
canContact(input: {
  channel: 'sms' | 'voice' | 'email';
  purpose: 'conversational' | 'automated' | 'marketing';   // Phase 1 UI only produces 'conversational'
  point: ContactPointSnapshot; suppressions: Suppression[]; consents: ConsentRecord[];
  sender: { userId; isOwnerOrCollaborator: boolean; role };
  recipientTzCandidates: string[];        // contact.timezone, area-code tz, address tz, tenant tz
  recentOutbound: { last24h: number; last7d: number; automatedLast24h: number };
  lastInboundAt?: Instant; registration: { smsA2pReady: boolean; emailDomainVerified: boolean };
  policy: EffectiveCompliancePolicy; now: Instant;
}): { decision: 'allow' | 'warn_confirm' | 'block'; reasons: { code: string; message: string }[]; nextAllowedAt?: Instant }
```

Checks run in a fixed order, and the first `block` wins. All reasons are still collected for display.

1. **Suppression:** any active suppression for `(kind, normalized, channel | 'all')` leads to `block` (`SUPPRESSED_<reason>`).
2. **Sender authorization:** the sender must be the owner, a collaborator, or TL/Admin/Owner. Otherwise `block` (`NOT_AUTHORIZED_FOR_CONTACT`).
3. **Channel readiness:** for SMS, the sending number's A2P registration must be ready. For email, the domain must be verified (SPF/DKIM aligned). Otherwise `block`. (US A2P 10DLC registration requirements — **VERIFY WITH COUNSEL** / carrier documentation.)
4. **Consent:**
   - SMS conversational: requires a `granted` consent record (purpose conversational or higher) whose latest status is not revoked, **or** an inbound SMS from that number with no later opt-out. Replying to someone who texted you is treated as permitted (**VERIFY WITH COUNSEL**).
   - Voice manual (human-dialed, no prerecorded or artificial voice): allowed unless suppressed. Phase 1 has no national or state DNC registry scrub. Calls are therefore limited by default to contacts with an inquiry or prior relationship (`has_inquiry_or_relationship`). Cold numbers are blocked until a DNC scrub exists (**VERIFY WITH COUNSEL**: DNC and established-business-relationship rules).
   - Automated or marketing on any channel requires a `granted` record of that purpose with evidence (**VERIFY WITH COUNSEL**: the express written consent standard). No Phase 1 surface uses these purposes.
   - Email one-to-one is allowed unless unsubscribed or bounced. Marketing email (Phase 2) requires an unsubscribe link and a physical address (CAN-SPAM — **VERIFY WITH COUNSEL**).
5. **Quiet hours:** the default is 08:00–20:00 in the recipient's local time, evaluated against **every** candidate timezone. If any candidate tz is outside the window, the result is `block` with `nextAllowedAt`.
   - The default is deliberately narrower than the commonly cited 8 am–9 pm federal window, because some states are stricter (**VERIFY WITH COUNSEL**).
   - Admins can narrow the window freely. Widening it beyond 08:00–21:00 needs Owner role plus an acknowledgment, which is audited.
   - Exception: if the contact sent an inbound message or call in the last 30 minutes, a manual reply returns `warn_confirm` instead of `block` (**VERIFY WITH COUNSEL**; the policy can disable this).
6. **Frequency caps (defaults):**
   - manual SMS: more than 3 per contact per 24 h returns `warn_confirm`
   - automated SMS (Phase 2): 1 per 24 h and 3 per 7 days, hard block
   - outbound call attempts: 3 per contact per 24 h, hard block, with the Owner able to configure it lower or higher (some states limit call attempts — **VERIFY WITH COUNSEL**)

**Where it runs:**
- **Compose time:** the UI disables or labels actions.
- **Send time:** the outbound worker re-evaluates `canContact` immediately before the provider call, inside a tx that reads current suppressions.
- **Dial time:** the voice bridge checks before placing the call.

The decision snapshot is stored in `messages.gate_decision` and `calls.gate_decision` as compliance evidence.

**Opt-out (STOP) processing** (R-CON-4..7):
- The provider webhook is verified by signature and deduped through `webhook_inbox`.
- Inside **one transaction**, the system:
  1. persists the inbound message
  2. runs the core keyword classifier (default list: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT, "OPT OUT", case and punctuation insensitive, also detected as a standalone token inside longer messages — conservative, because revocation by "any reasonable means" applies; **VERIFY WITH COUNSEL**)
  3. inserts a tenant-wide `suppressions` row for `sms`
  4. appends a `consent_records` row with `revoked`
  5. cancels pending outbound jobs to that normalized number
  6. writes the timeline event and `audit_log`
- One confirmation reply is permitted (**VERIFY WITH COUNSEL**).
- Provider-level opt-out (carrier or provider STOP handling) remains enabled as a second layer. A provider "unsubscribed recipient" send error also creates a suppression.
- **Verbal opt-out** is one tap during or after a call ("Asked not to be contacted"). It suppresses `all` channels by default, records `verbal_request`, and links the `call_id` as evidence.
- **Re-opt-in** happens only via the START or UNSTOP keyword, or an Admin recording written re-consent with evidence. Either path creates a consent record and lifts the suppression via `lifted_by_consent_id`. Suppressions are never deleted (enforced by trigger).

**Call recording:**
- `recording_mode` defaults to `announce_all`: every recorded call, inbound and outbound, plays a disclosure before recording starts. This treats every call as all-party consent, so the design does not depend on a correct state list (**VERIFY WITH COUNSEL**: one-party vs all-party consent states, and interstate calls).
- `by_jurisdiction` is available, with an Owner-maintained jurisdiction table, but is not the default.
- Recording is enabled at onboarding only after the Owner confirms the disclosure text.
- Storage is encrypted with a per-object DEK. Playback streams through the API and is audited as `recording.played`. Raw bucket URLs are never exposed.
- Default retention is 24 months, configurable (**VERIFY WITH COUNSEL**).

---

## 4. Permissions (Phase 1 matrix)

Legend: Y = allowed. T = within the user's own team. O = own or collaborating contacts only. M = masked (pond view). — = not allowed.

| Action | Owner | Admin | Team Lead | Agent | ISA | TC |
|---|---|---|---|---|---|---|
| View contact full | Y | Y | T | O | O | O (via deal) |
| View pond lead | Y | Y | Y | M | M | — |
| Claim from pond | — (may assign) | — (may assign) | Y | Y | Y | — |
| Accept/decline offer | if offered | if offered | Y | Y | Y | — |
| Assign / reassign | Y | Y | T | — | own leads → agent (handoff) | — |
| Release own lead | Y | Y | Y | Y | Y | — |
| Close / reopen ownership | Y | Y | T | — | — | — |
| Merge contacts | Y | Y | T | both owned by self | — | — |
| Send SMS/email, call | Y | Y | T | O | O | O (deal contacts, conversational) |
| Play recording | Y | Y | T | O | O | — |
| Edit routing rules, ponds | Y | Y | — | — | — | — |
| Compliance policy (quiet hours, caps, recording) | Y | narrow only | — | — | — | — |
| Lift suppression (with evidence) | Y | Y | — | — | — | — |
| Run import / approve preview | Y | Y | — | — | — | — |
| Export contacts | Y | Y (audited) | — | — | — | — |
| Manage members, roles | Y | Y (not Owner) | — | — | — | — |
| Deactivate member | Y | Y | — | — | — | — |
| Deals: edit | Y | Y | T | own deals | — | assigned deals |
| Listings: edit | Y | Y | T | own listings | — | — |

---

## 5. Phase 1 data model

Conventions:
- `uuid` ids (UUIDv7, generated by the injected id generator in core).
- Every tenant table has `tenant_id uuid NOT NULL`, `PRIMARY KEY (tenant_id, id)`, and composite foreign keys `(tenant_id, x_id)`.
- `timestamptz` everywhere, stored in UTC.
- `created_at` and `updated_at` exist where meaningful.
- Mutable aggregates carry `version int` for optimistic concurrency, and UI writes send `expected_version`.

**RLS template** (every tenant table): `ENABLE` + `FORCE ROW LEVEL SECURITY`, plus policy `tenant_isolation USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())`, where `app_tenant_id()` = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. With no tenant set, queries return zero rows (verified).

**Append-only tables** (`audit_log`, `lead_ownership_events`, `consent_records`):
- triggers reject UPDATE, DELETE and TRUNCATE
- `app_user` is also granted only `SELECT, INSERT` on them (defense in depth)

**Global or infrastructure tables:**
- `users`: has a policy for self or co-members of the current tenant.
- `sessions`, `auth_tokens`, `auth_attempts`, `webhook_inbox`: RLS enabled with **no policy** for `app_user`, so they are only reachable via `SECURITY DEFINER` functions.
- `jobs`: tenant policy for enqueue. Claiming goes through the definer `jobs_claim()`.

**Definer functions** are owned by `app_definer` (NOLOGIN, BYPASSRLS; needed because FORCE RLS applies to table owners too). They pin `search_path` and return the minimum columns.

### 5.1 Tenancy, identity, platform

| Table | Key columns | Constraints / indexes | Phase 2/3 shaping |
|---|---|---|---|
| `tenants` | id, name, slug citext UQ, timezone (default America/New_York), status | RLS: `id = app_tenant_id()` | Brokerage parent (`parent_tenant_id`) can be added later. Branding lives in settings. |
| `tenant_settings` | tenant_id PK, overrides jsonb, version, updated_by, updated_at | Zod-validated. Effective settings = core defaults deep-merged with overrides. Changes are audited with a diff. | All Phase 2 admin settings are new keys, with no migrations. |
| `teams` | id, name, lead_user_id | One default team created per tenant | Multi-team TL scoping, team goals (Phase 2 accountability). |
| `users` | id, email citext UQ, password_hash (argon2id), display_name, mfa_secret_enc bytea NULL, created_at | Global. Policy: self or co-member. | MFA/TOTP (Phase 2; column reserved), SSO. |
| `memberships` | (tenant_id,user_id) PK, role member_role, team_id, status invited/active/deactivating/deactivated, accepting_leads bool default true, timezone, phone_for_alerts_e164, version | idx (tenant_id, status, role) | Per-agent working hours (Phase 2), license states. |
| `sessions` | id, token_hash bytea UQ (SHA-256), user_id, tenant_id, created_at, last_seen_at, idle_expires_at (default 12 h), absolute_expires_at (default 30 d), revoked_at, ip, user_agent | Definer-only. idx (user_id) WHERE revoked_at IS NULL | Device management UI. |
| `auth_tokens` | id, token_hash UQ, purpose invite/reset/verify_email, user_id, tenant_id, expires_at (default 1 h reset, 7 d invite), used_at | Definer-only. Single use. | — |
| `auth_attempts` | key (ip or email hash), window_start, count | Definer-only. Default: 5 failed logins per 15 min per account, 50 per IP. | — |
| `audit_log` | id identity, tenant_id, occurred_at, actor_user_id, actor_kind, action, subject_type, subject_id, request_id, ip, detail jsonb | Append-only. idx (tenant_id, subject_type, subject_id, occurred_at desc), (tenant_id, action, occurred_at desc). Partition by month once volume justifies it. | Admin audit viewer (Phase 2), SIEM export. |
| `idempotency_keys` | (tenant_id,user_id,key) PK, route, request_hash, status_code, response jsonb, created_at | TTL 24 h (maintenance job). Mismatched request_hash with the same key returns 422. | — |
| `jobs` | id identity, tenant_id, queue, kind, dedupe_key, payload jsonb (**IDs only, no PII**; Zod-enforced), run_at, status, attempts, max_attempts, locked_by, locked_until, last_error | UQ (queue, dedupe_key) WHERE pending/running. idx (queue, run_at) WHERE pending. Lease reaper for stuck jobs. | All Phase 2 automations (drips, weekly plans) are new job kinds. |
| `webhook_inbox` | id, provider, provider_event_id, tenant_id (resolved), received_at, signature_valid, payload_enc bytea, processed_at, error | UQ (provider, provider_event_id). Definer insert and tenant resolution by called number. | Additional providers. |
| `encryption_keys` | id, tenant_id, purpose (recordings/transcripts/credentials/files), wrapped_dek bytea, kek_ref, created_at, retired_at | Rotation creates a new row. Old DEKs stay for decryption. | Customer-managed KEKs (enterprise). |

### 5.2 Contacts, ownership, routing

| Table | Key columns | Constraints / indexes | Phase 2/3 shaping |
|---|---|---|---|
| `contacts` | id, first_name, last_name, display_name, lead_type, stage (fixed list), owner_user_id (denormalized, trigger-synced), timezone, tags text[], imported_fields jsonb (read-only display), merged_into_id, last_touch_at, last_inbound_at, version, search tsvector (generated), deleted_at | idx owner (partial, live), GIN search, GIN trgm display_name, GIN tags | Custom stages (Phase 2 admin), lead score history, nurture enrollment. |
| `contact_points` | id, contact_id, kind phone/email, value, normalized (E.164 / lower-trim), label, is_primary, line_type, status | idx (tenant_id, kind, normalized) WHERE active (the dedup key), GIN trgm normalized (search) | Line-type lookup, phone validation (Phase 2). |
| `contact_addresses` | id, contact_id, kind (home/mailing/interest), line1, city, state, zip, geo point NULL | idx (tenant_id, zip) | Geo-polygon routing, property matching (Phase 3). |
| `contact_collaborators` | (tenant_id, contact_id, user_id) PK, role isa/tc/co_agent, added_by, added_at, removed_at | idx (tenant_id, user_id) WHERE removed_at IS NULL | Shared-lead splits. |
| `contact_ownership` | contact_id PK, state, owner_user_id, pond_id, offer_id, offered_to_user_id, offer_expires_at, offer_round, routing_rule_id, owned_at, first_touch_due_at, first_touch_at, inactivity_release_at, seq, updated_at | CHECK own_state_shape. Guard trigger. Partial deadline indexes. | Accountability metrics read the ledger, not this table. |
| `lead_ownership_events` | (tenant_id, contact_id, seq) PK, event_id UQ, type, from_state, to_state, owner_user_id, prev_owner_user_id, pond_id, offer_id, routing_rule_id, actor_kind, actor_user_id, reason_code, note, command_id, payload, occurred_at | Append-only. idx command_id, (owner, time), (type, time) | Speed-to-lead compliance and coaching (Phase 2/3) come directly from this table. |
| `lead_sources` | id, name, kind (portal/website/webhook/manual/import), inbound_token_hash, consent_attestation (what consent language the source collects + version), sms_consent_trusted bool default false, active | UQ (tenant_id, name) | Source ROI (Phase 3). |
| `lead_inquiries` | id, contact_id, lead_source_id, external_id, received_at, inquiry_type, message, listing_id NULL, property_address jsonb, zip, price_min, price_max, consent_snapshot jsonb, raw_payload_enc bytea, fingerprint, outcome (new_contact/attached/reinquiry/duplicate_ignored) | UQ (tenant_id, lead_source_id, external_id). idx (tenant_id, fingerprint, received_at) for the 10-minute duplicate window. | Source-provided behaviour data (Phase 2 nurture). |
| `ponds` | id, name, is_default, eligible_roles, mask_contact_info default true, claims_per_day default 5, claim_cooldown_hours default 72, reinquiry default 'reroute', archived_at | One default per tenant (partial UQ) | Pond-specific SLAs, scheduled pond drops. |
| `routing_rules` | id, position, name, match jsonb, strategy, direct_user_id, target_pond_id, fallback_pond_id, offer_window_seconds default 300, max_offers default 3, enabled, version | UQ (tenant_id, position) DEFERRABLE | Time-of-day, language, geo polygons (Phase 2). |
| `routing_rule_members` | (rule_id, user_id) PK, weight 1–100 default 1 | FK to memberships | Per-member caps. |
| `routing_rotation_state` | rule_id PK, cursor jsonb, version | Locked FOR UPDATE during routing | — |

### 5.3 Consent and compliance

| Table | Key columns | Constraints / indexes | Phase 2/3 shaping |
|---|---|---|---|
| `consent_records` | id, contact_point_id, channel, purpose, status granted/revoked, method, evidence jsonb (disclosure text hash + version, form URL, IP, UA, call_id/message_id), captured_at, recorded_by, source_ref | Append-only. idx current-consent lookup. | Express-written-consent capture forms for drips (Phase 2). |
| `suppressions` | id, kind, normalized, channel sms/voice/email/all, reason, source_ref, created_at, created_by, lifted_at, lifted_by_consent_id | Partial UQ active per (kind, normalized, channel). Guard trigger: no delete; lift once, with a consent link. | National/state DNC scrub results as `reason='dnc_registry'` (Phase 1.5/2). |

Compliance policy (quiet hours, caps, recording mode, jurisdiction overrides, keyword list) lives in `tenant_settings.overrides.compliance`, with core defaults. Changes are audited, and widening changes require the Owner role.

### 5.4 Communications

| Table | Key columns | Constraints / indexes | Phase 2/3 shaping |
|---|---|---|---|
| `provider_accounts` | id, provider, kind telephony/email/ai, credentials_enc bytea (AES-256-GCM envelope), external_account_id (Twilio subaccount per tenant), status | UQ (tenant_id, provider, kind) | — |
| `phone_numbers` | id, e164 (globally UNIQUE: a number belongs to one tenant), provider_sid, assigned_user_id NULL (team line), purpose agent/team, capabilities, a2p_status, status, released_at | Global UQ e164 WHERE status='active'. Definer `resolve_tenant_by_number`. | Tracking numbers per source (Phase 3), port-in. |
| `email_domains` | id, domain, spf_ok, dkim_ok, dmarc_policy, verified_at, from_addresses jsonb | UQ (tenant_id, domain) | Bulk/marketing streams on separate subdomain (Phase 2). |
| `messages` | id, contact_id, contact_point_id, channel sms/email, direction, from_addr, to_addr, subject, body, status (draft/queued/sent/delivered/failed/received/blocked/cancelled), provider_message_id, sender_user_id, phone_number_id, ai_output_id, gate_decision jsonb, queued_at, sent_at, error_code | UQ (tenant_id, provider_message_id). idx (tenant_id, contact_id, created_at desc), (tenant_id, contact_point_id, direction, sent_at) for frequency caps | Threads, MMS, templates (Phase 2). |
| `calls` | id, contact_id, user_id (who dialed or answered), phone_number_id, direction, from_e164, to_e164, provider_call_sid UQ, status, started_at, answered_at, ended_at, duration_s, disposition, recording_disclosure_played bool, gate_decision jsonb | idx (tenant_id, contact_id, started_at desc), (tenant_id, to_e164, started_at) for attempt caps | Power dialer, voicemail drop (with legal review), call queues. |
| `call_recordings` | id, call_id, file_id, duration_s, consent_basis ('announced'/'jurisdiction_rule'), retention_until, deleted_at | Retention job hard-deletes the object and keeps the row as a tombstone. | Coaching clips (Phase 3). |
| `transcripts` | id, call_id, recording_id, text_enc bytea, dek_id, language, provider, status | Not full-text indexed in Phase 1 | Encrypted-search alternative (Phase 3). |
| `ai_outputs` | id, kind (call_summary, next_step, draft_sms, draft_email, contact_insight), contact_id, call_id NULL, created_for_user_id, model, prompt_version, input_refs jsonb (ids only), content text, reasoning text, confidence numeric(3,2), confidence_band low/med/high, ownership_seq, status (proposed/approved/edited/sent/discarded/invalidated), edited_content, decided_at | idx (tenant_id, contact_id, created_at desc), (tenant_id, created_for_user_id, status) | Weekly plans, review requests, listing marketing (new `kind`s). Draft edit-distance analytics feed voice matching. |
| `notes` | id, contact_id, deal_id NULL, author_user_id, body, pinned, search tsvector | idx contact | Rich text, mentions. |

### 5.5 Timeline, feed, tasks, notifications

| Table | Key columns | Constraints / indexes | Phase 2/3 shaping |
|---|---|---|---|
| `timeline_events` | id, contact_id, occurred_at, kind (message/call/note/ownership/task/deal/inquiry/consent/ai), ref_table, ref_id, actor_user_id, summary, provenance (native/imported_fub/imported_csv), visibility (all/admin) | idx (tenant_id, contact_id, occurred_at desc, id desc). A projection, rebuildable from sources. | Website activity, email opens, listing views. |
| `feed_items` | id, user_id, kind, subject_type, subject_id, contact_id, due_at, base_inputs jsonb, score_version, state open/done/snoozed/dismissed, snoozed_until, created_at, resolved_at | UQ (tenant_id, user_id, kind, subject_id) WHERE state IN ('open','snoozed'). idx (tenant_id, user_id, state, due_at) | AI weekly plan items, coaching nudges. |
| `tasks` | id, contact_id NULL, deal_id NULL, listing_id NULL, assignee_user_id, created_by, title, kind (todo/call/text/email/appointment/showing), due_at, all_day, status, completed_at, source manual/ai/system, external_calendar_ref NULL, version | idx (tenant_id, assignee_user_id, status, due_at) | Calendar sync (Phase 2) uses `external_calendar_ref`, plus recurring tasks. |
| `notifications` | id, user_id, category (lead_offer, sla, inbound, pond, task, system), priority critical/high/normal, title, body (PII-minimized), subject ref, dedupe_key, created_at, read_at, deliveries jsonb [{channel, status, at, error}] | UQ (tenant_id, user_id, dedupe_key). idx (tenant_id, user_id, read_at NULLS FIRST, created_at desc) | Digest emails (Phase 2). |
| `notification_preferences` | (tenant_id, user_id, category) PK, channels text[], quiet_start, quiet_end | Critical categories (`lead_offer`, `sla`) must keep at least one channel (CHECK in app + core rule). Personal quiet hours never suppress `lead_offer`. | — |
| `push_devices` | id, user_id, kind webpush/apns/fcm, endpoint, keys_enc, last_seen_at, revoked_at | Revoked on deactivation | Native app. |

### 5.6 Deals and listings (basic)

| Table | Key columns | Constraints / indexes | Phase 2/3 shaping |
|---|---|---|---|
| `deal_stages` | id, pipeline buyer/seller, name, position, is_terminal, outcome won/lost NULL | Seeded defaults: Buyer: Pre-approval → Showing → Offer → Under Contract → Closed/Lost. Seller: Appointment → Listed → Under Contract → Closed/Withdrawn. | Custom pipelines (Phase 2 admin). |
| `deals` | id, name, pipeline, stage_id, owner_user_id, listing_id NULL, price, expected_close_on date, status open/won/lost, closed_at, lost_reason, version | idx (tenant_id, owner_user_id, status), (tenant_id, stage_id) | Commission and splits (Phase 2), forecasting (Phase 3). |
| `deal_contacts` | (deal_id, contact_id) PK, role buyer/seller/other | idx contact | — |
| `deal_members` | (deal_id, user_id) PK, role tc/co_agent | gives TC access | — |
| `deal_dates` | id, deal_id, kind (acceptance, inspection, appraisal, financing, closing, custom), label, due_on date, due_at NULL, completed_at | idx (tenant_id, due_on) WHERE completed_at IS NULL | Full contingency workflow (Phase 2). Feeds the priority feed in Phase 1. |
| `listings` | id, address_line1, city, state, zip, mls_number, status (coming_soon/active/pending/sold/withdrawn), list_price, beds, baths numeric(3,1), sqft, property_type, listing_agent_user_id, seller_contact_id NULL, description, search tsvector | UQ (tenant_id, mls_number) WHERE NOT NULL. GIN search, idx zip | Photos and marketing generation (Phase 2), MLS feed (Phase 3). |

### 5.7 Imports, files, search

| Table | Key columns | Constraints / indexes | Phase 2/3 shaping |
|---|---|---|---|
| `imports` | id, kind csv/fub, status (uploaded→parsing→preview_ready→approved→running→completed / failed / cancelled), file_id, column_mapping jsonb, user_mapping jsonb (external agent → user or pond), options jsonb, stats jsonb, created_by, approved_by, approved_at, fub_credential_enc (deleted on completion) | Approval requires Admin/Owner and a preview generated from the same mapping version | Scheduled sync (not planned; migration is one-time). |
| `import_rows` | (tenant_id, import_id, row_no) PK, raw jsonb (encrypted at file level; rows purged 30 d after completion), normalized jsonb, errors jsonb, warnings jsonb, match_contact_id, match_reason, decision create/attach/skip/error, applied_entity_id, applied_at | idx (import_id, decision) | — |
| `external_refs` | (tenant_id, system, entity_type, external_id) PK, entity_id | Makes re-runs idempotent and links FUB history | Future integrations. |
| `files` | id, kind (recording, import, attachment), storage_key, bytes, sha256, content_type, dek_id + wrapped per-object key, created_by, subject ref, deleted_at | idx subject | Documents on contacts and deals (Phase 2/3). |

**Search** has no separate search table in Phase 1. Global search is a `UNION ALL` of per-entity queries:
- contacts: tsvector plus trigram on name, trigram on `contact_points.normalized` for phone and email fragments
- listings: tsvector plus MLS number
- deals: name

Every branch is wrapped in the visibility predicate, with each branch capped at 10 rows and a 300 ms statement timeout. Phone search normalizes digits first, matching the last 7–10 digits.

---

## 6. Explicit rules (testable)

Each rule maps to at least one Vitest test (core) or one integration test (db/api against a real Postgres).

### Ownership (R-OWN)
- **R-OWN-1** Every non-merged contact has exactly one `contact_ownership` row, created in the same transaction as the contact, with a `created`, `assigned` or `imported` event at `seq = 1`.
- **R-OWN-2** `contact_ownership` can only be written while `app.ownership_command` is set, and only if a ledger event exists with the same `(contact_id, seq, to_state)`. Any other write fails with `insufficient_privilege` or `integrity_constraint_violation`. Rows are never deleted. `seq` strictly increases.
- **R-OWN-3** Accept is accepted only if state=`offered` ∧ `offer_id` matches ∧ `offered_to_user_id` = actor ∧ `now < offer_expires_at` ∧ the actor's membership is `active`. Otherwise:
  - `now ≥ offer_expires_at`, or an `offer_expired` event already exists for the offer → **`LEAD_OFFER_EXPIRED`**. If the expiry has not yet been applied, the same transaction first applies `offer_expired` (and the next offer or pond), then records `command_rejected`.
  - a different `offer_id` is current or the lead has moved on → `LEAD_OFFER_SUPERSEDED`
  - offered to someone else → `LEAD_OFFER_NOT_YOURS`
  - membership not active → `MEMBERSHIP_INACTIVE`

  Every rejection appends `command_rejected` with the code in `reason_code`.
- **R-OWN-4** Exactly one owner exists at any time. `owner_user_id IS NOT NULL ⇔ state = 'owned'` (CHECK).
- **R-OWN-5** Claim succeeds only if state=`in_pond` ∧ the actor's role ∈ `pond.eligible_roles` ∧ membership active ∧ claims today (tenant-local day) < `claims_per_day` ∧ the actor is not in cooldown for this contact ∧ the actor is under the capacity cap. Losing a race gives `LEAD_ALREADY_CLAIMED`. Other failures give `POND_NOT_ELIGIBLE`, `CLAIM_LIMIT_REACHED`, `CLAIM_COOLDOWN` or `CAPACITY_REACHED`. All failures are recorded.
- **R-OWN-6** A successful claim or accept sets `owned_at = now`, `first_touch_due_at = addBusinessDuration(now, first_touch_sla)` and `inactivity_release_at` (if the stage qualifies). It cancels any pending offer timer through its fence.
- **R-OWN-7** Release by the owner requires a `ReleaseReason` (not_a_fit, wrong_area, duplicate, unresponsive, other+note). The lead goes to the default pond (or `toPondId` if the releaser may use it). The releaser enters a cooldown of `claim_cooldown_hours` for that contact.
- **R-OWN-8** Assign/reassign is allowed for Owner/Admin (any user), TL (users in the TL's team, for contacts owned within the team or unowned), and ISA (only contacts they own, only to agent or TL roles, with a required handoff note; the ISA becomes a collaborator automatically). Reassigning an `offered` lead appends `offer_rescinded` and then `assigned`. The previous owner and the new owner are both notified.
- **R-OWN-9** A contact created manually by an Agent, ISA or TL is owned by its creator (`assigned`, `reason_code = SELF_CREATED`), and no first-touch SLA starts.
- **R-OWN-10** A re-inquiry (new inquiry matched to an existing contact) never changes ownership of an `owned` contact. It appends `reinquiry`, notifies the owner at `high` priority, creates a pinned feed item, and starts a **re-inquiry first-touch SLA** (default ON, same duration) only if the previous touch was over 7 days ago. For `in_pond`, it follows the pond's `reinquiry` setting (default re-route). For `offered`, it attaches only. For `unassigned`, it attaches only, because routing is already pending.
- **R-OWN-11** A `closed` contact is never routed. A re-inquiry on a contact closed as `SPAM` stays closed and creates an Admin notification. A re-inquiry on a contact closed as `MERGED` is redirected to `merged_into_id` (followed transitively, with a depth limit of 5).
- **R-OWN-12** Commands are idempotent by `command_id`. Replaying a command returns the original outcome and writes nothing. A second accept from the current owner with a new `command_id` returns `ok` with no events (`ALREADY_OWNER`).
- **R-OWN-13** Ownership never changes as a side effect of AI output, message receipt (except R-OWN-10 routing rules), or an import re-run for contacts already linked via `external_refs`.
- **R-OWN-14** Deactivating a member, or changing their role to TC:
  1. tx 1 sets membership `deactivating` and revokes all sessions and push devices, so new offers and claims to that user become impossible (they fail eligibility)
  2. a job rescinds each pending offer (`offer_rescinded`, `OFFEREE_DEACTIVATED`) and re-routes it
  3. each owned contact moves in its own transaction to the destination chosen in the admin preview (default: the user's Team Lead, with `reassigned` reason `OWNER_DEACTIVATED`; alternatives are the default pond, or re-routing through the rules). Contacts with open deals always go to a user, never a pond.
  4. the membership becomes `deactivated` when no owned, offered or collaborator rows remain

  The process is resumable and idempotent per contact (`command_id = hash(deactivation_id, contact_id)`).
- **R-OWN-15** The order of events within a contact is total (`seq`). Across contacts no order is promised, and readers must not rely on one.

### Timers (R-TMR)
- **R-TMR-1** Deadlines are computed once, by core, at transition time, and stored as UTC instants. Later configuration changes never alter existing deadlines.
- **R-TMR-2** Business-duration arithmetic follows the tenant's routing hours in its IANA tz, with the DST rules of §1.6. Given the same inputs, it returns the same instant (pure).
- **R-TMR-3** A timer command is a no-op (no event) if its fence does not match the projection (`offer_id` for offers, `seq` at scheduling for SLA and inactivity).
- **R-TMR-4** A timer command evaluated with `now < deadline` reschedules itself and writes no event.
- **R-TMR-5** The sweeper guarantees every overdue deadline is processed within 15 s plus queue latency, even if its job row is missing.
- **R-TMR-6** `first_touch_breached` is appended at most once per ownership period. A touch after a breach still appends `first_touch_recorded`, so metrics show the actual response time.
- **R-TMR-7** If `canContact` is `block` for every channel at `owned_at` (for example, fully suppressed), `sla_waived` with `NOT_CONTACTABLE` replaces the first-touch timer.
- **R-TMR-8** `inactivity_release_at` resets on every owner or collaborator touch. It is cleared when the stage leaves {new, attempting} or a deal opens. `inactivity_warned` is emitted once, 72 h before the deadline.

### Routing (R-RTE)
- **R-RTE-1** Rules are evaluated in ascending `position`, and only enabled rules are considered. The first match decides. With no match, the lead goes to the default pond (`NO_RULE_MATCH`) and the TLs are notified.
- **R-RTE-2** The eligibility predicate is exactly the ordered list in §1.7. The first failing check is recorded as `skip_reason`.
- **R-RTE-3** Round-robin and weighted selection are pure functions of (ordered members, eligibility, cursor). The new cursor is persisted in the same transaction as the `offered` event.
- **R-RTE-4** After `max_offers` offers in one sequence (each expired or declined), the lead goes `sent_to_pond` to the rule's fallback pond, or the default pond if none is set.
- **R-RTE-5** With no eligible candidate, the lead goes immediately `sent_to_pond` (`NO_ELIGIBLE_AGENT`) and the TLs are notified at `critical` priority.
- **R-RTE-6** Three consecutive offer misses or declines by one user set `accepting_leads = false` (`AUTO_PAUSED`). This is audited and the user and TL are notified. Only the user or a TL can turn it back on.
- **R-RTE-7** Routing never offers to a user who cannot be notified (no active push device and no verified alert phone).

### Consent and compliance (R-CON)
- **R-CON-1** No outbound SMS, call or email is handed to a provider unless `canContact` returns `allow` (or `warn_confirm` plus an explicit user confirmation recorded in `gate_decision`). The check runs at send or dial time, not only at compose time.
- **R-CON-2** Every outbound message and call stores the `gate_decision` snapshot that permitted it.
- **R-CON-3** Suppressions are keyed by `(kind, normalized address, channel)`, apply tenant-wide across all numbers and users, and override every consent record.
- **R-CON-4** An inbound opt-out keyword creates the suppression in the same transaction that persists the inbound message, and cancels every pending outbound job to that address in that transaction.
- **R-CON-5** Suppressions cannot be deleted. They are lifted only by a START/UNSTOP keyword or by Admin re-consent with evidence. Either way a consent record is created and linked through `lifted_by_consent_id`.
- **R-CON-6** Imports may create suppressions (FUB opt-out / DNC flags, CSV `do_not_text`/`do_not_call` columns) and may never lift them.
- **R-CON-7** A provider error that indicates an unsubscribed or blocked recipient creates a suppression (`carrier_block`).
- **R-CON-8** Quiet hours are evaluated against every candidate recipient timezone. The most restrictive one wins.
- **R-CON-9** Recording starts only after the disclosure has played (`recording_disclosure_played = true`) when `recording_mode = announce_all`. A call where disclosure playback failed is not recorded.
- **R-CON-10** Phase 1 has no code path that sends with `purpose` ∈ {automated, marketing}. A test asserts that the outbound worker rejects those purposes while `features.automated_outbound = false`.
- **R-CON-11** Imported consent is stored with `method = 'import'`. It permits only conversational purpose, and only if the import source attests to it. It never satisfies automated or marketing (**VERIFY WITH COUNSEL**).

### Permissions and tenancy (R-PERM, R-TEN)
- **R-TEN-1** Every request runs inside `withTenantTx(ctx, fn)`, which does `SET LOCAL app.tenant_id`, `app.user_id` and `app.role`. The Kysely instance is only reachable inside `fn` (enforced by types and a lint rule banning direct pool imports outside packages/db).
- **R-TEN-2** With `app.tenant_id` unset, every tenant table returns zero rows and rejects inserts.
- **R-TEN-3** Cross-tenant reads happen only in the definer functions listed in §5 intro. They return identifiers, never content.
- **R-TEN-4** Job payloads, logs and error reports contain IDs, never names, phone numbers, emails or message bodies (Zod schema for payloads; log redaction for known PII keys plus E.164 and email regexes).
- **R-PERM-1** Authorization is decided server-side by `can(actor, action, resource)` in core, following the matrix in §4. There is a test for every matrix cell.
- **R-PERM-2** Pond views return only the masked fields while `mask_contact_info = true`. A contact point is never serialized for an unclaimed pond lead.
- **R-PERM-3** After reassignment, the previous owner loses access immediately, except for a **call-scoped grant**: during a live call they placed or answered, and until 30 minutes after it ends, they may view that contact's header and write the disposition and note for that `call_id` only.
- **R-PERM-4** Export is limited to Owner and Admin. It runs as a job and is audited with a row count. The download link is single-use and expires in 15 minutes.

### Dedup and merge (R-DED)
- **R-DED-1** Inbound inquiries and manual creates take `pg_advisory_xact_lock(hashtextextended(tenant_id || ':' || kind || ':' || normalized, 0))` for each normalized identifier, in sorted order, before matching. Two simultaneous inquiries for the same new person therefore produce one contact.
- **R-DED-2** Auto-attach happens only on an exact normalized email or E.164 phone match among active contact points of non-merged, non-deleted contacts. Fuzzy matches (name + zip, trigram name ≥ 0.8) produce **merge suggestions** only.
- **R-DED-3** If one inquiry matches different contacts by phone and by email, it attaches to the contact with the earliest `created_at`, and a merge suggestion is created for the TL.
- **R-DED-4** An inquiry with the same `(lead_source_id, external_id)` is ignored (`duplicate_ignored`). Without an external id, the same fingerprint (source + normalized identifiers + inquiry type) within 10 minutes is ignored.
- **R-DED-5** Merge locks both ownership rows in ascending `contact_id` order. Surviving ownership:
  - if only one contact is owned, its owner survives
  - if both are owned by the same user, that user survives
  - if both are owned by different users, it needs explicit TL/Admin choice (default preselect: the owner with the earliest `owned_at`), and the losing owner is notified
  - if neither is owned, the survivor's state is kept

  The loser gets `merged_away` → `closed`. The survivor gets `merged_in` (payload includes the loser id and the moved row ids, retained for a Phase 2 unmerge).
- **R-DED-6** Suppressions and consent travel with addresses and contact points, so a merge never loses an opt-out.

### AI (R-AI)
- **R-AI-1** Phase 1 AI output never sends, assigns, releases, changes stage, or alters consent. It produces `ai_outputs` rows only.
- **R-AI-2** Every draft shows `reasoning`, `confidence_band` and the inputs used (as links). Low confidence (< 0.5) drafts are shown collapsed with "Needs your edit".
- **R-AI-3** A draft is bound to `ownership_seq`. If the ownership seq changes before approval, the draft becomes `invalidated`.
- **R-AI-4** Voice matching uses only the requesting user's own sent messages (most recent 20). Other users' messages are never used.
- **R-AI-5** Inbound message content is untrusted input. It is delimited in prompts, and the model has no tools in Phase 1.
- **R-AI-6** The AI provider receives only the fields needed for the task. Transcripts are decrypted in memory for summarization and never logged.

### Import (R-IMP)
- **R-IMP-1** No import writes domain tables before an Admin or Owner approves a preview. The preview shows counts of create, attach and skip, every error row, agent mapping, ownership outcome per contact, and the suppressions that will be added.
- **R-IMP-2** Imports are applied in batches of 500 rows per transaction, each resumable. A row error never aborts the batch. That row is marked `error`.
- **R-IMP-3** Imported contacts get `imported` ownership events, with the owner taken from `user_mapping` or the chosen pond. They start no offers or SLA timers and create no notifications. Feed items are created only for open tasks due within 7 days.
- **R-IMP-4** FUB history (notes, calls, texts, emails) becomes `timeline_events` with `provenance = 'imported_fub'` and `external_refs`. It never counts as a touch for SLA or metrics.
- **R-IMP-5** Re-running the same import is idempotent through `external_refs`.
- **R-IMP-6** The FUB API key is stored encrypted on the import row and deleted (set to NULL) when the import completes or fails.

### Audit (R-AUD)
- **R-AUD-1** `audit_log` records the following, each with actor, ip and request_id:
  - login success and failure, session revocation
  - role and membership changes, deactivation
  - settings changes (as a diff)
  - routing rule and pond changes
  - suppression lift, consent recorded by staff
  - recording playback and download, transcript view
  - export, import approval
  - merge, ownership rebuild
  - impersonation by support (Phase 2; flagged)

---

## 7. Edge cases

| # | Scenario | Handling |
|---|---|---|
| 1 | Two agents claim the same pond lead at the same instant | Row lock serializes them. The first commit wins (`claimed`). The second sees `owned` and gets `LEAD_ALREADY_CLAIMED`, recorded as `command_rejected`. Verified against PG16 with two sessions (§13). |
| 2 | Accept arrives after the offer timer fired | The projection now has a new `offer_id` or a pond, so the result is `LEAD_OFFER_EXPIRED` (an `offer_expired` exists for that offer_id). Recorded. The UI says "This lead moved on" and shows where (if visible). |
| 3 | Accept arrives after `offer_expires_at` but before the timer job ran | The accept transaction applies the expiry itself (`offer_expired` + next offer), then records the rejection. The timer job later no-ops on its fence. |
| 4 | Accept and timer contend for the lock at the expiry instant | Both read `now` after the lock. Accept wins iff its `now < expires_at`. There is no grace period, and the server-sent `expires_at` drives the UI countdown. |
| 5 | Timer job delivered twice, or worker crashes after commit | Fencing plus no-op (R-TMR-3). The job dedupe key prevents duplicate pending jobs. |
| 6 | Timer job lost (queue truncated, bug) | The sweeper finds the overdue deadline from the projection (R-TMR-5). |
| 7 | Worker clock skew | Irrelevant, because `now` comes from the DB. Early wake reschedules (R-TMR-4). |
| 8 | Lead arrives outside routing hours | Offered immediately. The window counts from the next opening. The agent can accept at night. |
| 9 | DST transition during an offer window | Real elapsed seconds count inside local windows. Gaps and overlaps follow §1.6, with test vectors. |
| 10 | Tenant changes timezone or hours while offers are open | Existing deadlines are unchanged (R-TMR-1). New offers use the new calendar. |
| 11 | Offeree deactivated mid-offer | `offer_rescinded` (`OFFEREE_DEACTIVATED`), then the next candidate. A late accept from that user gets `MEMBERSHIP_INACTIVE` (their session is also revoked). |
| 12 | Agent deactivated while holding 800 leads | R-OWN-14: an admin preview with destination counts, then a per-contact resumable job. Each contact's ownership is consistent at every moment, and the UI shows progress. |
| 13 | Routing tx chooses an agent while deactivation commits | Routing holds `FOR SHARE` on the candidate membership, and deactivation needs `FOR UPDATE`, so they serialize. Whichever is second sees the other's result. |
| 14 | Reassignment during an active call | The provider call continues. The `calls` row stays attributed to the dialer. R-PERM-3 gives a call-scoped grant for the disposition. The new owner gets "Sam is on a call with this contact now". |
| 15 | Old owner had a scheduled or queued SMS when reassigned | The send-time gate fails `NOT_AUTHORIZED_FOR_CONTACT`. The message is marked `cancelled` and the new owner is notified with its content as a suggested draft. |
| 16 | Pending AI draft for the old owner | `invalidated` (R-AI-3). |
| 17 | Contact texts the old owner's number after reassignment | The message is stored on the contact. The notification and feed item go to the current owner. The old owner gets a content-free notice ("A former contact replied; routed to {owner}"). |
| 18 | Duplicate inbound lead for a contact owned by someone | R-OWN-10: attach, owner notified, no reroute, and a conditional re-inquiry SLA. |
| 19 | Duplicate inbound lead while the contact is `offered` | Attach only. The current offer stands, and the inquiry is shown in the offer card. |
| 20 | Same lead posted twice by a portal (with or without external id) | R-DED-4 ignores it as `duplicate_ignored` (stored for audit). |
| 21 | Two different new inquiries for the same unknown person at the same moment | The advisory lock on normalized identifiers (R-DED-1) yields one contact and one routing. |
| 22 | Spouses share one phone and submit separately with different emails | The phone match attaches the second inquiry to the first contact. The inquiry keeps its own name and email, and the contact header shows "2 people on this record?" with a one-tap split (Phase 2; Phase 1 creates a TL merge-review suggestion). |
| 23 | Merge two contacts owned by different agents | R-DED-5: TL choice is required, the losing owner is notified, and the ledger has events on both contacts. |
| 24 | Agent releases a lead and immediately reclaims it to reset the SLA | Cooldown (72 h) blocks the claim with `CLAIM_COOLDOWN`. |
| 25 | Agent cherry-picks the pond | Daily claim cap (5) plus capacity cap (5 uncontacted). The TL sees the claim history from the ledger. |
| 26 | Nobody is available (everyone paused, or 2 am with all devices offline) | `sent_to_pond` with `NO_ELIGIBLE_AGENT`, plus critical TL notification. |
| 27 | Agent ignores offers repeatedly | Auto-pause after 3 (R-RTE-6). |
| 28 | Mobile client retries accept after a network timeout | Same `command_id` replays the original outcome (R-OWN-12). |
| 29 | Accept with stale UI (`expected_seq` behind) | Still decided on the current state. The response includes the fresh projection so the UI re-renders. |
| 30 | STOP arrives while an outbound SMS is mid-dequeue | The send-time gate re-reads suppressions. The residual window is between the gate check and the provider accept (milliseconds). The provider-level opt-out is the second layer, and a provider "unsubscribed" error leads to a suppression. |
| 31 | STOP sent to number A, then agent texts from number B | Suppression is tenant-wide by address (R-CON-3), so it is blocked. |
| 32 | Opted-out person re-imported via CSV | Suppression is keyed by address, so it is still blocked. The import preview shows "N rows are opted out". |
| 33 | Contact timezone unknown, area code in another state | Most-restrictive-candidate rule (R-CON-8). |
| 34 | Recording disclosure fails to play (media error) | Not recorded (R-CON-9). The call proceeds, and `calls.recording_disclosure_played = false` is visible. |
| 35 | Lead closed as spam submits again | It stays closed and an Admin is notified (R-OWN-11). |
| 36 | Projection or ledger drift found nightly | P1 alert and audit entry, with no auto-fix (§1.9). |
| 37 | Routing rule edited mid-sequence | The sequence keeps its `rule_id`. The rule's current members apply to later offers, and the version is recorded. |
| 38 | Rule member removed from the tenant while being the RR cursor | The cursor refers to a user_id no longer in the list, so selection starts after the cursor's position in the sorted order (pure, defined). |
| 39 | ISA hands off to an agent who is paused | Handoff is an explicit assign, so it is allowed: pause only affects rotation. The agent is notified. |
| 40 | Contact with an open deal hits inactivity timer | Never applies (R-TMR-8). Deactivation never ponds deal contacts (R-OWN-14). |

---

## 8. Risks: bloat, data leakage, compliance

### Data leakage
- **L1: Intra-tenant visibility is in the app layer.** A missed predicate exposes other agents' contacts. Mitigations:
  - one `visibility` module, so the same predicate is used everywhere
  - a test suite that walks every API route against every role (generated from the route table)
  - search branches wrapped centrally

  Restrictive RLS on `contacts` is discussed under open questions (§11).
- **L2: Agents leaving with the database.** Mitigations: export limited to Owner/Admin; per-user daily view rate monitoring (contacts opened per hour, alert on >200, logged as `audit`); no bulk copy UI for agents; search results capped.
- **L3: Pond leads expose PII to the whole team.** Masked by default (R-PERM-2).
- **L4: Notifications on lock screens and agent SMS alerts carry PII.** The default content is "New buyer lead · 78704 · $650k". Names and numbers are never in push or SMS bodies.
- **L5: Job payloads, logs, Sentry-style error reports, AI prompts.** Mitigations: IDs only (R-TEN-4), redaction, prompt minimization (R-AI-6), and transcripts never logged.
- **L6: Recording URLs.** Playback is API-streamed, short-lived and audited. Bucket objects are private and encrypted per object.
- **L7: FUB API key retention.** Deleted after import (R-IMP-6).
- **L8: A shared provider account across tenants would mix numbers, logs and opt-outs.** Use a provider subaccount per tenant.
- **L9: Former-owner inbound notifications.** Content-free (edge case 17).

### Compliance (all **VERIFY WITH COUNSEL**)
- **C1: No national/state DNC registry scrub in Phase 1.** The design restricts calling to inquiry or relationship contacts. Recommendation: integrate a DNC scrub provider in Phase 1.5 **before** enabling calling of imported cold lists.
- **C2: Automated texting (auto-replies, drips) carries high exposure.** Cut from Phase 1 (R-CON-10).
- **C3: Lead-source consent provenance.** Portal and third-party lead consent rules have been in flux. `lead_sources.sms_consent_trusted` defaults to `false`, so source consent counts only when an Admin attests to the source's disclosure text.
- **C4: Imported consent** is not trusted for automated or marketing use (R-CON-11).
- **C5: Recording consent** defaults to announcing on every call (§3).
- **C6: Quiet hours** default to 08:00–20:00 local, using the most restrictive candidate timezone.
- **C7: Revocation by "any reasonable means".** The keyword classifier is conservative, and verbal opt-out is one tap. Revocation processing is immediate, not batched.
- **C8: Recording and transcript retention, and data-subject deletion requests** (state privacy laws). Retention is configurable. A "delete contact" flow (Phase 1, Admin only) hard-deletes PII and recordings, keeps tombstones, keeps suppressions (address only), and keeps the ownership ledger with PII-free payloads.
- **C9: A2P 10DLC / carrier registration.** SMS is blocked until registration is ready (gate step 3). Onboarding guides registration.
- **C10: Email sender authentication.** One-to-one email is sent only from verified domains, and DMARC alignment is checked.

### Bloat
- **B1:** Routing rules stay limited to 4 match fields and 4 strategies. No boolean expression builder.
- **B2:** Feed weights are not configurable (`score_version` only).
- **B3:** Stages are a fixed list in Phase 1, with custom stages and pipelines in Phase 2.
- **B4:** Custom fields are not editable in Phase 1. `imported_fields` jsonb is display-only so FUB data isn't lost.
- **B5:** One default pond plus at most 5 ponds per tenant in Phase 1, enforced in the app.
- **B6:** Ownership states stay at 5. Resist adding states like `paused`, `nurture_owned` or `shared`. Use stage, collaborators and settings instead.

### Recommended cuts from Phase 1
1. Any automated outbound: instant SMS auto-responder, drips, AI auto-send, review requests. Moves to Phase 2 with an express-consent capture flow.
2. Geo polygons, per-agent schedules, holiday calendars, language routing.
3. Contact and deal document attachments (`files` exists for recordings and imports only). The spec's Phase 1 list does not require attachments.
4. Transcript full-text search.
5. Unmerge (the data needed is captured in the `merged_in` payload).
6. Calendar sync. `tasks.kind = 'appointment'` covers Phase 1 scheduling, and `external_calendar_ref` is reserved.
7. Bulk email, email templates and tracking pixels.
8. Power dialer and voicemail drop. Voicemail drop needs separate legal review.
9. Agent-level export.
10. Lead-to-deal automation. Agents create deals by hand in one tap from the contact.

---

## 9. Defaults at a glance

| Setting | Default |
|---|---|
| Tenant timezone | America/New_York (set at onboarding) |
| Routing hours | 08:00–21:00 tenant tz, 7 days |
| Offer window | 300 s (business time) |
| Max offers before pond | 3 |
| First-touch SLA | 15 business-minutes; action = notify owner + TL |
| Re-inquiry SLA | ON if last touch > 7 days |
| Inactivity release | ON, 30 days, stages new/attempting only, 72 h warning |
| Auto-pause after misses | 3 consecutive |
| Capacity cap (uncontacted owned leads) | 5 |
| Default pond | "Team Pond", masked, 5 claims/day, 72 h cooldown, re-inquiry re-routes |
| Pond notifications | push, routing hours, ≤ 1 per 10 min |
| Quiet hours (contacting) | 08:00–20:00 recipient local, most restrictive tz |
| Manual SMS cap | warn after 3 per 24 h |
| Call attempt cap | 3 per 24 h per contact |
| Automated outbound | disabled (feature flag off; cannot be enabled in Phase 1) |
| Recording mode | announce on all calls; requires Owner confirmation at onboarding |
| Recording retention | 24 months |
| Session lifetime | 12 h idle / 30 d absolute |
| Login rate limit | 5 failures / 15 min / account; 50 / IP |
| Import row retention | 30 days after completion |
| Duplicate inquiry window | 10 minutes |

---

## 10. Phase 2/3 readiness (what this model already supports without migration)

- **Accountability and speed-to-lead compliance (P2), coaching (P3):** computed from `lead_ownership_events` plus `calls`/`messages`. No new capture is needed.
- **AI weekly plans, review requests, listing marketing (P2):** new `ai_outputs.kind` values and job kinds. Feed `base_inputs` absorb new signals.
- **Nurture and drips (P2):** `consent_records.purpose = 'automated'|'marketing'` already exists. Frequency caps for automated sends already exist in `canContact`. `jobs` handles scheduling.
- **Fuller deal tracking (P2):** `deal_dates` already models key dates and contingencies, and `deal_members` models TC assignment.
- **Calendar (P2):** `tasks.external_calendar_ref`.
- **Documents (P3):** `files` with subject refs and per-object encryption.
- **Expanded admin (P2):** `tenant_settings.overrides` keys, and `teams` for multi-team TL scoping.
- **Expanded property / Google Business (P3):** `contact_addresses.geo`, `listings` extensions, new provider_accounts kinds.

---

## 11. Open questions

1. **Restrictive RLS for agent visibility in Phase 1?** A `RESTRICTIVE` policy on `contacts` (owner = `app.user_id` OR role in (owner, admin) OR TL-team OR collaborator OR in_pond) would give defense in depth against L1. The cost is EXISTS subqueries on every contact read, and child tables would still rely on app checks. My recommendation is to add it for `contacts` and `contact_points` only, if a benchmark at 250k contacts/tenant stays under 5 ms p95 overhead.
2. **Should first-touch SLA breach auto-release by default?** Many teams want "call in 5 minutes or lose it". This draft defaults to notify, to avoid punishing agents for a missed push. Product and team-lead input needed.
3. **Per-contact vs per-inquiry ownership.** A person who is both selling (listing agent A) and buying (buyer agent B) has one owner in this model. The deal-level `owner_user_id` covers the split. Is that acceptable for Phase 1?
4. **Default visibility for agents:** own contacts only (this draft), or read-only team visibility? Teams differ; the default here is the safer one.
5. **Who owns client data when an agent leaves the team?** This draft assumes the team (tenant). Contract and policy question for the business.
6. **Opt-out scope:** tenant-wide (this draft) or per sending number? Tenant-wide is safer but means one agent's contact opting out blocks the whole team. **VERIFY WITH COUNSEL.**
7. **Quiet-hours exception for replying to a contact who just messaged.** Keep it (default `warn_confirm`) or remove it? **VERIFY WITH COUNSEL.**
8. **DNC scrub vendor timing.** Phase 1.5 is proposed. Is cold calling of imported lists a launch requirement for target customers?
9. **Brokerage hierarchy above team tenants.** Not modelled in Phase 1 beyond a possible `parent_tenant_id`. Cross-tenant reporting would need a separate design.
10. **TC access to contact communications:** conversational messaging with deal contacts is allowed here. Confirm that teams want TCs texting clients from the platform.

---

## 12. Appendix A: critical DDL (verified on PostgreSQL 16)

The DDL below was applied to an isolated schema in `realty_scratch` and exercised as a non-superuser, non-BYPASSRLS role, then dropped (see §13). In the real migrations it splits into `0001_foundations.sql`, `0002_contacts.sql`, `0003_routing.sql`, `0004_ownership.sql`, `0005_consent.sql` and `0006_jobs.sql`. Two details apply in the real migrations:
- The definer functions are owned by `app_definer` (NOLOGIN BYPASSRLS), because `FORCE ROW LEVEL SECURITY` also applies to table owners.
- `app_user` gets `SELECT, INSERT` only on the append-only tables.

```sql
-- ===== 0001 foundations =====
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;

CREATE TABLE tenants (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  slug          citext NOT NULL UNIQUE,
  timezone      text NOT NULL DEFAULT 'America/New_York',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_tenant_id());

CREATE TABLE users (                      -- global identity; one person may belong to several tenants
  id            uuid PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  password_hash text,                     -- argon2id; NULL until invite accepted
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE TYPE member_role AS ENUM ('owner','admin','team_lead','agent','isa','tc');
CREATE TABLE memberships (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role            member_role NOT NULL,
  team_id         uuid,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','deactivating','deactivated')),
  accepting_leads boolean NOT NULL DEFAULT true,
  timezone        text,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- users visible only to self or co-members of the current tenant
CREATE POLICY users_visible ON users USING (
  id = app_user_id() OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id()));

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user','system','timer','import','provider','support')),
  action        text NOT NULL,          -- e.g. 'recording.played','contact.exported','role.changed'
  subject_type  text NOT NULL,
  subject_id    uuid,
  request_id    uuid,
  ip            inet,
  detail        jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_log_subject ON audit_log (tenant_id, subject_type, subject_id, occurred_at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- ===== contacts =====
CREATE TABLE contacts (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL,
  first_name      text,
  last_name       text,
  display_name    text NOT NULL,
  lead_type       text NOT NULL DEFAULT 'buyer' CHECK (lead_type IN ('buyer','seller','buyer_seller','renter','investor','other')),
  stage           text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','attempting','engaged','nurture','appointment','active_client','under_contract','closed','past_client','dead')),
  owner_user_id   uuid,                  -- DENORMALIZED from contact_ownership; written only by the sync trigger
  timezone        text,                  -- best-known recipient tz (for quiet hours)
  tags            text[] NOT NULL DEFAULT '{}',
  merged_into_id  uuid,
  last_touch_at   timestamptz,           -- last agent-initiated outbound attempt
  last_inbound_at timestamptz,
  version         integer NOT NULL DEFAULT 1,
  search          tsvector GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(display_name,'') || ' ' || coalesce(first_name,'') || ' ' || coalesce(last_name,''))) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES contacts(tenant_id, id)
);
CREATE INDEX contacts_owner ON contacts (tenant_id, owner_user_id) WHERE deleted_at IS NULL AND merged_into_id IS NULL;
CREATE INDEX contacts_search ON contacts USING gin (search);
CREATE INDEX contacts_name_trgm ON contacts USING gin (display_name gin_trgm_ops);
CREATE INDEX contacts_tags ON contacts USING gin (tags);
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY; ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE contact_points (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL,
  contact_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('phone','email')),
  value         text NOT NULL,           -- phone: E.164; email: original casing
  normalized    text NOT NULL,           -- phone: E.164; email: lower(trim)
  label         text,                    -- mobile/home/work
  is_primary    boolean NOT NULL DEFAULT false,
  line_type     text,                    -- mobile/landline/voip/unknown (lookup, Phase 2)
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','removed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id)
);
-- dedup: exact normalized match within a tenant is the auto-attach key
CREATE INDEX contact_points_match ON contact_points (tenant_id, kind, normalized) WHERE status = 'active';
CREATE INDEX contact_points_contact ON contact_points (tenant_id, contact_id);
CREATE INDEX contact_points_trgm ON contact_points USING gin (normalized gin_trgm_ops);
ALTER TABLE contact_points ENABLE ROW LEVEL SECURITY; ALTER TABLE contact_points FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_points USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- ===== ponds & routing =====
CREATE TABLE ponds (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL,
  name                 text NOT NULL,
  is_default           boolean NOT NULL DEFAULT false,
  eligible_roles       member_role[] NOT NULL DEFAULT '{agent,team_lead,isa}',
  mask_contact_info    boolean NOT NULL DEFAULT true,
  claims_per_day       integer NOT NULL DEFAULT 5 CHECK (claims_per_day >= 0),
  claim_cooldown_hours integer NOT NULL DEFAULT 72,   -- releasing agent cannot reclaim same lead for N h
  reinquiry            text NOT NULL DEFAULT 'reroute' CHECK (reinquiry IN ('reroute','stay')),
  archived_at          timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX ponds_one_default ON ponds (tenant_id) WHERE is_default AND archived_at IS NULL;
ALTER TABLE ponds ENABLE ROW LEVEL SECURITY; ALTER TABLE ponds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ponds USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE routing_rules (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  position       integer NOT NULL,       -- evaluation order, first match wins
  name           text NOT NULL,
  match          jsonb NOT NULL DEFAULT '{}',  -- {sources:[], lead_types:[], zips:[], price_min, price_max}; zod-validated in core
  strategy       text NOT NULL CHECK (strategy IN ('round_robin','weighted','direct','pond')),
  direct_user_id uuid,
  target_pond_id uuid,
  fallback_pond_id uuid,                 -- NULL = tenant default pond
  offer_window_seconds integer NOT NULL DEFAULT 300 CHECK (offer_window_seconds BETWEEN 30 AND 86400),
  max_offers     integer NOT NULL DEFAULT 3 CHECK (max_offers BETWEEN 1 AND 20),
  enabled        boolean NOT NULL DEFAULT true,
  version        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, position) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((strategy = 'direct') = (direct_user_id IS NOT NULL)),
  CHECK ((strategy = 'pond')   = (target_pond_id IS NOT NULL))
);
CREATE TABLE routing_rule_members (
  tenant_id  uuid NOT NULL,
  rule_id    uuid NOT NULL,
  user_id    uuid NOT NULL,
  weight     integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
  PRIMARY KEY (tenant_id, rule_id, user_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES routing_rules(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)
);
CREATE TABLE routing_rotation_state (     -- locked FOR UPDATE while choosing the next agent
  tenant_id   uuid NOT NULL,
  rule_id     uuid NOT NULL,
  cursor      jsonb NOT NULL DEFAULT '{}',  -- RR: {last_user_id}; weighted (smooth WRR): {current:{user_id:int}}
  version     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, rule_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES routing_rules(tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY; ALTER TABLE routing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_rules USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE routing_rule_members ENABLE ROW LEVEL SECURITY; ALTER TABLE routing_rule_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_rule_members USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE routing_rotation_state ENABLE ROW LEVEL SECURITY; ALTER TABLE routing_rotation_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_rotation_state USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- ===== ownership: projection + ledger =====
CREATE TYPE ownership_state AS ENUM ('unassigned','offered','owned','in_pond','closed');

CREATE TABLE contact_ownership (
  tenant_id             uuid NOT NULL,
  contact_id            uuid NOT NULL,
  state                 ownership_state NOT NULL,
  owner_user_id         uuid,
  pond_id               uuid,
  offer_id              uuid,            -- fencing token for the current offer
  offered_to_user_id    uuid,
  offer_expires_at      timestamptz,
  offer_round           smallint NOT NULL DEFAULT 0,
  routing_rule_id       uuid,
  owned_at              timestamptz,
  first_touch_due_at    timestamptz,
  first_touch_at        timestamptz,
  inactivity_release_at timestamptz,
  seq                   bigint NOT NULL, -- = last ledger seq applied; doubles as optimistic version
  updated_at            timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, contact_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, pond_id) REFERENCES ponds(tenant_id, id),
  CONSTRAINT own_state_shape CHECK (
    (state = 'unassigned' AND owner_user_id IS NULL AND pond_id IS NULL AND offer_id IS NULL) OR
    (state = 'offered'    AND owner_user_id IS NULL AND pond_id IS NULL AND offer_id IS NOT NULL
                          AND offered_to_user_id IS NOT NULL AND offer_expires_at IS NOT NULL) OR
    (state = 'owned'      AND owner_user_id IS NOT NULL AND pond_id IS NULL AND offer_id IS NULL AND owned_at IS NOT NULL) OR
    (state = 'in_pond'    AND owner_user_id IS NULL AND pond_id IS NOT NULL AND offer_id IS NULL) OR
    (state = 'closed'     AND owner_user_id IS NULL AND offer_id IS NULL))
);
-- sweeper indexes: deadlines live in data; jobs only wake us up
CREATE INDEX own_offer_deadline ON contact_ownership (offer_expires_at) WHERE state = 'offered';
CREATE INDEX own_first_touch_deadline ON contact_ownership (first_touch_due_at) WHERE state = 'owned' AND first_touch_at IS NULL;
CREATE INDEX own_inactivity_deadline ON contact_ownership (inactivity_release_at) WHERE state = 'owned';
CREATE INDEX own_by_owner ON contact_ownership (tenant_id, owner_user_id) WHERE state = 'owned';
CREATE INDEX own_by_offeree ON contact_ownership (tenant_id, offered_to_user_id) WHERE state = 'offered';
CREATE INDEX own_by_pond ON contact_ownership (tenant_id, pond_id) WHERE state = 'in_pond';
ALTER TABLE contact_ownership ENABLE ROW LEVEL SECURITY; ALTER TABLE contact_ownership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_ownership USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE lead_ownership_events (
  tenant_id          uuid NOT NULL,
  contact_id         uuid NOT NULL,
  seq                bigint NOT NULL,    -- 1..n per contact, gapless; PK = linearization guard
  event_id           uuid NOT NULL,
  type               text NOT NULL CHECK (type IN (
                       'created','imported','offered','offer_accepted','offer_declined','offer_expired',
                       'offer_rescinded','claimed','assigned','reassigned','released','sent_to_pond',
                       'reinquiry','first_touch_recorded','first_touch_breached','sla_waived',
                       'inactivity_warned','inactivity_released','closed','reopened','merged_away',
                       'merged_in','command_rejected')),   -- command_rejected: to_state = from_state, no projection change
  from_state         ownership_state,
  to_state           ownership_state NOT NULL,
  owner_user_id      uuid,               -- owner AFTER the event
  prev_owner_user_id uuid,
  pond_id            uuid,
  offer_id           uuid,
  routing_rule_id    uuid,
  actor_kind         text NOT NULL CHECK (actor_kind IN ('user','system','timer','import','provider')),
  actor_user_id      uuid,
  reason_code        text NOT NULL,      -- machine-readable, e.g. OFFER_WINDOW_ELAPSED, OWNER_DEACTIVATED
  note               text,
  command_id         uuid NOT NULL,      -- idempotency: one command => one event set
  payload            jsonb NOT NULL DEFAULT '{}',   -- e.g. routing candidates + skip reasons; never PII
  occurred_at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, contact_id, seq),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id)
);
CREATE INDEX loe_command ON lead_ownership_events (tenant_id, command_id);
CREATE INDEX loe_owner_time ON lead_ownership_events (tenant_id, owner_user_id, occurred_at DESC);
CREATE INDEX loe_actor_type_time ON lead_ownership_events (tenant_id, actor_user_id, type, occurred_at DESC);  -- claim caps, cooldowns
CREATE INDEX loe_type_time ON lead_ownership_events (tenant_id, type, occurred_at DESC);
CREATE TRIGGER loe_append_only BEFORE UPDATE OR DELETE ON lead_ownership_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER loe_no_truncate BEFORE TRUNCATE ON lead_ownership_events FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
ALTER TABLE lead_ownership_events ENABLE ROW LEVEL SECURITY; ALTER TABLE lead_ownership_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_ownership_events USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Only the ownership command path may write the projection: it sets app.ownership_command = <command_id> via SET LOCAL.
CREATE OR REPLACE FUNCTION contact_ownership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.ownership_command', true), '') IS NULL THEN
    RAISE EXCEPTION 'contact_ownership may only be written by applyOwnershipCommand' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contact_ownership rows are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.seq <= OLD.seq THEN RAISE EXCEPTION 'ownership seq must increase' USING ERRCODE = 'serialization_failure'; END IF;
  -- the ledger must already hold the event that produced this seq (events are inserted before the projection write)
  IF NOT EXISTS (SELECT 1 FROM lead_ownership_events e WHERE e.tenant_id = NEW.tenant_id AND e.contact_id = NEW.contact_id
                 AND e.seq = NEW.seq AND e.to_state = NEW.state) THEN
    RAISE EXCEPTION 'projection seq % has no matching ledger event', NEW.seq USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_ownership_guard BEFORE INSERT OR UPDATE OR DELETE ON contact_ownership
  FOR EACH ROW EXECUTE FUNCTION contact_ownership_guard();
-- keep the denormalized contacts.owner_user_id in lockstep (same tx)
CREATE OR REPLACE FUNCTION contact_ownership_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contacts SET owner_user_id = NEW.owner_user_id
   WHERE tenant_id = NEW.tenant_id AND id = NEW.contact_id AND owner_user_id IS DISTINCT FROM NEW.owner_user_id;
  RETURN NULL;
END $$;
CREATE TRIGGER contact_ownership_sync AFTER INSERT OR UPDATE OF owner_user_id ON contact_ownership
  FOR EACH ROW EXECUTE FUNCTION contact_ownership_sync();

-- ===== consent & suppression =====
CREATE TABLE consent_records (           -- append-only; current consent = latest row per (contact_point, channel, purpose)
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  contact_point_id uuid NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('sms','voice','email')),
  purpose          text NOT NULL CHECK (purpose IN ('conversational','marketing','automated')),
  status           text NOT NULL CHECK (status IN ('granted','revoked')),
  method           text NOT NULL CHECK (method IN ('web_form','lead_source','verbal_recorded','written','inbound_keyword','agent_attested','import','api')),
  evidence         jsonb NOT NULL DEFAULT '{}',  -- disclosure text hash + version, form url, ip, user agent, call_id, message_id
  captured_at      timestamptz NOT NULL,
  recorded_by      uuid,
  source_ref       text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_point_id) REFERENCES contact_points(tenant_id, id)
);
CREATE INDEX consent_current ON consent_records (tenant_id, contact_point_id, channel, purpose, captured_at DESC, id DESC);
CREATE TRIGGER consent_append_only BEFORE UPDATE OR DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY; ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_records USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

CREATE TABLE suppressions (              -- keyed by normalized address, NOT contact: survives merges, deletes, re-imports
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('phone','email')),
  normalized    text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('sms','voice','email','all')),
  reason        text NOT NULL CHECK (reason IN ('stop_keyword','verbal_request','email_unsubscribe','hard_bounce','spam_complaint',
                                                'admin','dnc_internal','dnc_registry','carrier_block','import')),
  source_ref    text,
  created_at    timestamptz NOT NULL,
  created_by    uuid,
  lifted_at     timestamptz,             -- only via re-consent (START keyword / admin with evidence)
  lifted_by_consent_id uuid,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX suppressions_active ON suppressions (tenant_id, kind, normalized, channel) WHERE lifted_at IS NULL;
ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY; ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON suppressions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- suppressions may only be lifted (once, with a consent record), never deleted or otherwise edited
CREATE OR REPLACE FUNCTION suppressions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'suppressions cannot be deleted' USING ERRCODE='insufficient_privilege'; END IF;
  IF OLD.lifted_at IS NOT NULL OR NEW.lifted_at IS NULL OR NEW.lifted_by_consent_id IS NULL
     OR (NEW.kind, NEW.normalized, NEW.channel, NEW.reason, NEW.created_at) IS DISTINCT FROM (OLD.kind, OLD.normalized, OLD.channel, OLD.reason, OLD.created_at)
  THEN RAISE EXCEPTION 'suppressions may only be lifted once, with a consent record' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER suppressions_guard BEFORE UPDATE OR DELETE ON suppressions FOR EACH ROW EXECUTE FUNCTION suppressions_guard();

-- ===== jobs (Postgres queue) =====
CREATE TABLE jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid,                     -- NULL only for global maintenance jobs
  queue        text NOT NULL,            -- 'timers','outbound','notifications','ai','imports','maintenance'
  kind         text NOT NULL,
  dedupe_key   text,
  payload      jsonb NOT NULL,           -- IDs only; zod-enforced
  run_at       timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX jobs_ready ON jobs (queue, run_at) WHERE status = 'pending';
CREATE INDEX jobs_stuck ON jobs (locked_until) WHERE status = 'running';
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
-- request transactions may only enqueue/see jobs of their own tenant
CREATE POLICY tenant_isolation ON jobs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- workers claim cross-tenant through a narrow SECURITY DEFINER function, then open a tenant-scoped tx per job
CREATE OR REPLACE FUNCTION jobs_claim(p_queue text, p_worker text, p_limit int, p_lease interval)
RETURNS TABLE (id bigint, tenant_id uuid, kind text, payload jsonb, attempts int)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE jobs j SET status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_until = now() + p_lease
  WHERE j.id IN (SELECT q.id FROM jobs q WHERE q.queue = p_queue AND q.status = 'pending' AND q.run_at <= now()
                 ORDER BY q.run_at, q.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING j.id, j.tenant_id, j.kind, j.payload, j.attempts
$$;

-- deadline sweeper: returns only identifiers, never row content
CREATE OR REPLACE FUNCTION ownership_due(p_limit int)
RETURNS TABLE (tenant_id uuid, contact_id uuid, deadline_kind text, deadline timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  (SELECT o.tenant_id, o.contact_id, 'offer_expiry', o.offer_expires_at FROM contact_ownership o
     WHERE o.state = 'offered' AND o.offer_expires_at <= now() ORDER BY o.offer_expires_at LIMIT p_limit)
  UNION ALL
  (SELECT o.tenant_id, o.contact_id, 'first_touch', o.first_touch_due_at FROM contact_ownership o
     WHERE o.state = 'owned' AND o.first_touch_at IS NULL AND o.first_touch_due_at <= now() ORDER BY o.first_touch_due_at LIMIT p_limit)
  UNION ALL
  (SELECT o.tenant_id, o.contact_id, 'inactivity', o.inactivity_release_at FROM contact_ownership o
     WHERE o.state = 'owned' AND o.inactivity_release_at <= now() ORDER BY o.inactivity_release_at LIMIT p_limit)
$$;
```

Grants sketch (migration `0007_grants.sql`):

```sql
CREATE ROLE app_definer NOLOGIN BYPASSRLS;           -- owns SECURITY DEFINER functions only
ALTER FUNCTION jobs_claim(text,text,int,interval) OWNER TO app_definer;
ALTER FUNCTION ownership_due(int) OWNER TO app_definer;
GRANT SELECT, UPDATE ON jobs, contact_ownership TO app_definer;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, lead_ownership_events, consent_records FROM app_user;
REVOKE DELETE ON contact_ownership, suppressions FROM app_user;
REVOKE ALL ON sessions, auth_tokens, auth_attempts, webhook_inbox FROM app_user;  -- definer-only
GRANT EXECUTE ON FUNCTION jobs_claim(text,text,int,interval), ownership_due(int) TO app_user;
```

## 13. Appendix B: what was verified

These checks were run against PostgreSQL 16.15 at localhost, database `realty_scratch`, in a throwaway schema with a temporary LOGIN NOSUPERUSER NOBYPASSRLS role. Both the schema and the role were dropped afterwards.

| Check | Result |
|---|---|
| Tenant B sees only its own contacts and none of tenant A's ledger | pass |
| No `app.tenant_id` set → 0 rows | pass |
| Insert with another tenant's `tenant_id` | rejected by RLS WITH CHECK |
| `users` visible only to co-members | pass |
| UPDATE/DELETE on `lead_ownership_events` | rejected by trigger |
| Duplicate `(contact_id, seq)` | rejected by PK |
| `owned` without owner | rejected by `own_state_shape` |
| Duplicate pending job `dedupe_key` | rejected |
| `jobs_claim` definer returns cross-tenant due jobs | pass (as superuser-owned; production owner must be BYPASSRLS) |
| Suppression delete or plain edit | rejected; lift without consent link rejected |
| Projection write without `app.ownership_command` | rejected |
| Projection write with no matching ledger event | rejected |
| Projection `seq` not increasing | rejected; DELETE rejected |
| Owner sync trigger updates `contacts.owner_user_id` | pass |
| `in_pond` with owner still set (matching ledger event present) | rejected by `own_state_shape` |
| **Concurrent pond claim (2 sessions, A holds lock 1 s; each inserts the guarded ledger event, then updates the projection)** | A: `claimed seq=2`. B blocked, then saw `owned seq=2`, and its conditional update affected 0 rows, giving `LEAD_ALREADY_CLAIMED`. Ledger has exactly one `claimed`. |
