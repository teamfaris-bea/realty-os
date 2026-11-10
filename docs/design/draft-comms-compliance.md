# Draft: Comms-Compliance-Led Phase 1 Design

Status: independent design draft (lens: communications compliance). Covers the full Phase 1 data model, with the deepest treatment of consent, opt-out, DNC, quiet hours, frequency caps, recording consent, numbers and sender registration, the `canContact()` gate, assistant evidence, playbook autonomy, and imports.

How to read this:

- **MUST / MUST NOT** are rules. Each one has an ID (`R-XXX-n`) so tests can cite it.
- **VERIFY WITH COUNSEL** marks a legal assumption. Wherever one appears, the behavior is driven by configuration (a jurisdiction pack or tenant policy) and not hard-coded, and the shipped default is the conservative choice.
- **Default:** gives the shipped value for every configurable item.
- Appendix A is DDL for the critical tables. It was run against PostgreSQL 16.15 in a throwaway database, together with a test script that checked: RLS isolation (unset tenant sees 0 rows, the client principal sees 0 rows, cross-tenant writes are rejected), composite cross-tenant FKs, the append-only triggers, consent CHECKs, the "no send without a gate decision" CHECK, the deferred "claim needs evidence" trigger, playbook version freezing, one live enrollment per contact, the import stage dry-run CHECK, and the restrictive recording-visibility policy.

---

## 0. The ten decisions that shape everything

1. **Consent and opt-out attach to the address, not the contact.** Keys are `(tenant, address_kind, address, channel, purpose)`. A STOP from `+15555550100` blocks that number for every contact who shares it, survives merges, re-imports and deletion, and blocks a contact created later with the same number. The TCPA analysis is about the called number's subscriber and user, so this matches the law better than per-contact flags do (VERIFY WITH COUNSEL).
2. **Consent is an append-only ledger with a recomputable projection.** `consent_events` is immutable (triggers reject UPDATE, DELETE and TRUNCATE). `consent_state` is a cache that `core.projectConsent(events)` can rebuild. Nothing "edits" consent: a correction is a new event.
3. **"Consent" (what the person said) is kept separate from "suppression" (what the world or the system says).** Opt-outs are consent revocations. Hard bounces, spam complaints, landline-no-SMS, internal DNC and admin blocks are `suppressions`. The national/state DNC status lives in `dnc_checks`. `canContact()` reads all three.
4. **There is exactly one outbound path.** `dispatchOutbound()` in `apps/api` is the only module allowed to import a provider `send`/`dial` function. A lint rule plus an architecture test enforce this. It calls the pure `core.canContact()` at **send time**, persists the decision in `gate_decisions` (append-only), and the `messages`/`calls` CHECK constraints refuse a sent row without a `gate_decision_id`.
5. **Policy has three layers, and each lower layer can only tighten.** The platform floor (code, `packages/core`) comes first, then jurisdiction packs (versioned data, platform-maintained), then tenant policy (versioned per tenant). A tenant can make quiet hours narrower or caps lower. It cannot widen anything below the floor or the pack. Every gate decision records the policy version and the core rules version it was evaluated under.
6. **Per-contact serialization uses a transaction-scoped advisory lock.** Inbound ingestion, opt-out processing, dispatch claim, playbook step execution and enrollment changes all take `pg_advisory_xact_lock(hashtextextended(tenant_id || ':' || contact_id, 0))`. This makes "pause on reply" atomic with respect to dispatch (A3), and it makes frequency-cap counting race-free.
7. **The assistant asserts nothing without verbatim, verified evidence.** Every claim either has at least one `evidence_ref` whose quoted snippet `core.verifyQuote()` found in the source text, or it is `needs_review = true`. A deferred constraint trigger enforces this at COMMIT. Numeric confidence never reaches the agent UI (A2).
8. **Autonomy is an allow-list of categories inside approved, frozen playbook versions.** The categories `money`, `contract`, `novel_message` and `seller_update` can never be autonomous. A DB CHECK enforces this as well as the server. Wire or bank instructions are hard-denied in every path, including human sends.
9. **Phase 1 assistant conversations are single-turn.** The 60-second first response is one message (SMS and/or email) with one or two qualifying questions. Any reply pauses automation and hands off to the agent. Multi-turn autonomous qualification goes to Phase 2.
10. **Imports never manufacture consent.** Imported grants are capped at `imported_unverified` (enforced by a DB CHECK). Imported revocations and DNC flags are honored immediately and at full strength. Imported messages and calls are history only: they never pause playbooks, start timers or create exceptions.

---

## 1. Policy layering and defaults

```
platform floor (packages/core constants, semver'd)    -- cannot be changed by data
  └─ jurisdiction packs (jurisdiction_packs, global, versioned, platform-maintained)
       └─ tenant compliance policy (compliance_policy_versions, per tenant, immutable versions)
            └─ per-send context (recipient tz, consent, counts, ...)
```

Effective rule = the most restrictive value across: the floor, every applicable pack (recipient jurisdiction, agent jurisdiction, tenant operating jurisdictions), and the tenant policy. `core.resolvePolicy()` is pure and gets tested exhaustively.

A **jurisdiction pack** (`jurisdiction_packs`, global table, no tenant_id, read-only to `app_user`) holds: the quiet-hours floor, restricted days and holidays, the call-recording party rule (`one_party` | `all_party` | `unknown`), the inquiry-basis window, DNC scrub validity, the state DNC registry key, AI-disclosure requirements, and advertising rules (brokerage-name placement, team-name rules). Every pack has `reviewed_by_counsel_at`. While it is NULL, admin screens show the honest banner "These rules have not been reviewed by counsel yet." Seed packs ship with conservative placeholder values. **No state's law is encoded as fact in code.** For example, a South Carolina pack would carry team-name/advertising rules only as counsel-reviewed data (VERIFY WITH COUNSEL).

| Setting | Default | Who can change | Notes |
|---|---|---|---|
| Quiet hours floor (calls + SMS) | 08:00–21:00 recipient local | Platform/pack only | Commonly cited federal solicitation window; some states are stricter or restrict days/holidays (VERIFY WITH COUNSEL) |
| Tenant automated window (SMS/voice) | 09:00–20:00 recipient local, every day | Admin (narrow only) | Applies to assistant/system sends |
| Human send outside floor | Informational reply to a contact who wrote in within the last 30 min: `needs_confirmation`. Anything else: `deny` | Admin may change to always-deny | Human sends inside the floor but outside the tenant window are allowed |
| Email quiet hours | Not applied | Admin may enable | Email is not a call/text (VERIFY WITH COUNSEL) |
| Automated SMS cap | 1 per 24h, 3 per rolling 7 days, per address | Admin (lower only) | Exempt: opt-out confirmation, HELP reply, booking confirmation, appointment reminder |
| Automated email cap | 1 per 24h, 3 per rolling 7 days, per address | Admin (lower only) | Same exemptions |
| Automated touches across channels | 2 per 24h per contact | Admin (lower only) | |
| Human sends | Not capped (counted for the scoreboard) | n/a | |
| Opt-out scope | STOP on any tenant number revokes SMS (all purposes) for that address from **all** tenant numbers, and from all phone addresses of the same contact | Not configurable | Stricter than carrier scope |
| Recording | On for all calls, announcement to all parties on every call | Owner may switch to `one_party_where_permitted` with a recorded attestation | Unknown jurisdiction is treated as all-party |
| Recording retention | 24 months; transcripts follow their recording | Owner (6–84 months) | Legal hold overrides (VERIFY WITH COUNSEL on license-law retention) |
| Consent ledger, gate decisions, audit | Kept ≥ 5 years after the contact's last activity, including after contact erasure (address hashed) | Not configurable below floor | TCPA limitation period assumption (VERIFY WITH COUNSEL) |
| DNC scrub validity | 31 days | Pack | (VERIFY WITH COUNSEL) |
| Inquiry basis window | 90 days from the inquiry | Pack | (VERIFY WITH COUNSEL) |
| Assistant identity sign-off | "— {Agent first name}'s assistant" (agent playbooks) / "— the {Team name} assistant" (team playbooks). The first assistant message in a thread adds the brokerage name and "Reply STOP to opt out" | Admin may edit wording; cannot remove identity | Genuineness (A1); AI disclosure laws vary (VERIFY WITH COUNSEL) |
| Brokerage name on marketing | Required; render pipeline appends it if absent | Not removable | A7f |
| Autonomous categories | speed_to_lead_reply, reminder, booking_confirmation, nurture_step on; document_chase off | Admin (turn off only; turning one on requires a playbook approval) | The always-human list is fixed |
| Imported consent for autonomous marketing | Not sufficient | Open question (§13) | |
| Push notification content | "New lead: Jane D." (first name + last initial), no message bodies | Admin may set to "no names" | Lock-screen leakage |

---

## 2. Compliance data model (deep)

### 2.1 Contact points

`contact_points(id, tenant_id, contact_id, kind phone|email, address, label, line_type, status, is_primary, timezone, import_batch_id, removed_at)`

- `address` is canonical: E.164 for phone (CHECK `^\+[1-9][0-9]{6,14}$`), lower-case for email. Normalization happens in `core.normalizePhone(raw, defaultCountry='US')` / `core.normalizeEmail`. The DB never sees raw input.
- The same address may belong to several contacts (a shared landline, a couple's email). That is why there is a non-unique index on `(tenant_id, kind, address)` and a unique index on `(tenant_id, contact_id, kind, address)`.
- `line_type` comes from a carrier lookup adapter (fake in dev). It defaults to `unknown`, and `unknown` is treated as SMS-capable. Provider error "not SMS-capable" creates a `landline_no_sms` suppression.
- `status = wrong_number` is set when a reply matches the wrong-number rule (R-OPT-6). It voids that address's consent (revoke event) and blocks all channels for that address on that contact.
- Phase 2/3 shaping: reassigned-number checks (FCC Reassigned Numbers Database, VERIFY WITH COUNSEL) become a `dnc_checks`-like `reassignment_checks` table keyed on the same address. Portal client principals can map to a contact via a verified contact point.

### 2.2 Consent ledger and projection

`consent_events` (append-only) columns: address key, `channel` (sms|voice|email), `purpose` (marketing|informational|all), `event_type` (grant|revoke|resubscribe|expire|import_revert), `consent_level`, `source`, `occurred_at` (when the person acted) vs `recorded_at`, and evidence (`disclosure_id`, `evidence_document_id`, `evidence_message_id`, `evidence_call_id` + `evidence_call_offset_ms`, `evidence jsonb` holding form URL, IP, user agent, keyword text). Also: `imported`, `import_record_id`, `original_provenance`, `expires_at`, `needs_review`.

**Consent levels** (ordered): `none < imported_unverified < inquiry < express < express_written`.

| Level | Meaning | How it is created |
|---|---|---|
| `express_written` | Signed or electronically agreed disclosure that names the seller (brokerage/team) and covers the channel and purpose (VERIFY WITH COUNSEL on the exact elements) | Web form with captured `consent_disclosures` row (exact text + sha256), e-sign, or an uploaded signed document. A DB CHECK requires `disclosure_id` or `evidence_document_id`. |
| `express` | The person gave their number/email for this purpose, or texted us first | Inbound first contact by SMS (scoped to informational SMS), verbal on a call (must cite `evidence_call_id`), or agent entry with a note |
| `inquiry` | Inquiry/relationship basis with an expiry | Lead form without SMS consent language, lead provider without consent attestation. `expires_at` = occurred_at + pack window |
| `imported_unverified` | Came from another system; provenance kept verbatim | Imports only. A DB CHECK forbids imports at any higher level |
| `none` | Used on revoke/expire rows | |

**Lead-provider consent** (Zillow, realtor.com, ad forms): the provider's attested consent language is stored as a `consent_disclosures` row with `names_seller` set to the entity it actually names. If the text does not name this tenant or brokerage, the grant is recorded at `inquiry`, not `express_written`. Rules on lead-generator and one-to-one consent have been in flux (VERIFY WITH COUNSEL). The evidence is stored regardless, so the level can be re-derived later without losing anything.

**Projection.** `consent_state(tenant_id, address_kind, address, channel, purpose ∈ {marketing, informational})` is written in the same transaction as the event, by `recordConsentEvent(tx, event)`. That function takes the advisory lock for the address, inserts the event, loads all events for the key, runs `core.projectConsent()`, and upserts the state with `ledger_event_count`. A nightly job recomputes a sample and alarms on any mismatch. Projection semantics, all in core and all tested:

- A `purpose='all'` event applies to both purposes.
- The latest `revoke` beats any earlier grant. A grant after a revoke counts only if it is an explicit new grant with its own evidence, or a `resubscribe` (R-OPT-5).
- An `inquiry` grant past `expires_at` projects to `none` (status `none`, level `none`). The projection is time-dependent, so `canContact()` also re-checks `expires_at` against `now`.
- Imported events are included at their capped level.
- `import_revert` voids the effect of grant events from that import record. Imported revocations are **not** voided by a revert (R-IMP-9).

### 2.3 Opt-out handling

Inbound SMS processing (inside the ingestion transaction, §4):

1. Normalize the body: trim, strip surrounding punctuation and emoji, uppercase.
2. **Keyword match** (exact single-token match against the configured list): `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT` revoke. `START, UNSTOP, YES` resubscribe. `HELP, INFO` get the help reply. The list lives in the platform floor and packs can add to it (VERIFY WITH COUNSEL and against current CTIA/carrier guidance).
3. **Opt-out language rule** (deterministic regex set in core, no LLM): for example "stop (texting|messaging|contacting|calling)", "remove me", "do not (text|call|contact)", "unsubscribe me", "take me off". A match applies a full revocation **immediately** (fail closed) with `source = inbound_language` and `needs_review = true`. The agent can mark "not an opt-out" (audited, reason required). That appends a `grant` with `source=agent_entry` restoring the prior level, and only when the prior basis still exists. The FCC's revocation-by-reasonable-means rules support honoring natural-language revocations (VERIFY WITH COUNSEL).
4. The LLM may *additionally* flag "possible opt-out" on messages the rules missed. That only creates a review item. It never revokes and never reinstates.
5. **Wrong number**: "wrong number", "you have the wrong person" and similar mark the contact point `wrong_number`, revoke all channels for the address, and stop automation.

Effects of a revocation (same transaction):

- Insert a `consent_events` revoke for `channel=sms, purpose=all` on the address. Per the opt-out-scope default, also revoke the contact's other phone addresses (`evidence.derived_from` = the original event).
- Cancel every `scheduled`/`queued` outbound SMS to those addresses (`status=canceled, status_reason=OPTED_OUT`).
- Pause the contact's live enrollment (`pause_reason=opt_out`). The inbound message itself already triggers pause-on-reply.
- Create one owner notification: "Jane opted out of texts. We won't text her again unless she texts START."
- **Confirmation**: exactly one confirmation SMS, category `opt_out_confirmation`. It bypasses consent but still requires a registered sender. It is sent within 5 minutes and never contains marketing (VERIFY WITH COUNSEL on content and timing). If the provider's managed opt-out already sends a confirmation (`tenant_policy.opt_out_confirmation_sender = 'provider'`, the default when the provider supports it), we send nothing, so the person never gets two.

**Provider/carrier-level opt-outs.** Providers maintain their own opt-out lists per sender or messaging service. When a send fails with the provider's "recipient opted out" error, we record a `revoke` with `source=provider_report` (we may have missed a STOP sent to another number). We never retry. Each tenant gets its **own** messaging service or sender pool at the provider, so a STOP sent to one tenant can never suppress, or reveal, anything in another tenant.

**Email unsubscribes.** One-click `List-Unsubscribe` + `List-Unsubscribe-Post` headers (RFC 8058) and a footer link record `revoke(channel=email, purpose=marketing)` immediately. A spam complaint (feedback loop) creates a `spam_complaint` suppression on email/all. Informational email (appointment confirmations) continues after a marketing unsubscribe, but not after a complaint.

### 2.4 Suppressions and DNC

`suppressions`: `reason ∈ {hard_bounce, spam_complaint, undeliverable, landline_no_sms, internal_dnc, admin_block, wrong_number, provider_opt_out_mirror}` with `channel ∈ {sms, voice, email, all}`, and a partial unique index on active rows. It keys on `address_hash = HMAC-SHA256(tenant pepper, address)` as well as `address`, so that **after a contact erasure request `address` is nulled and the hash still blocks future sends** (R-PRIV-2). Lifting requires `lift_reason`. Only Admin/Owner can lift `internal_dnc`/`admin_block`. Nobody can lift `spam_complaint`; the person must take a fresh opt-in action.

**Internal (company-specific) DNC**: a call outcome of `do_not_call_request` or the agent action "Do not call" creates `internal_dnc` for voice. A request not to be called is treated as a voice revocation too (VERIFY WITH COUNSEL on honoring windows; our default is immediate).

**Registry DNC**: `dnc_checks(phone, registry, listed, checked_at, valid_until, provider)`, append-only. Phase 1 ships the `DncProvider` interface with a deterministic fake, plus Admin upload of scrub results (CSV from the team's existing scrub vendor). The latest valid check per registry is what counts. A missing or expired check means status `unknown`.

DNC in `canContact()` applies only to `purpose=marketing` on voice and SMS (VERIFY WITH COUNSEL on which texts are "telephone solicitations"):
- `listed` and no `express_written` for that channel and purpose: **deny** `DNC_LISTED`.
- `unknown` and no `express_written` and no unexpired `inquiry`/`express`: assistant **deny** `DNC_STATUS_UNKNOWN`; human `needs_confirmation`. Admin can switch the human case to deny.

Litigator/high-risk lists: Phase 2 adapter only.

### 2.5 Recipient timezone and quiet hours

`core.resolveRecipientTimezones(contactPoint, contact, tenant)` returns a **set** of candidate IANA zones plus a source:

1. `contact_points.timezone` (explicit, set by the agent or confirmed by the client) gives one zone, source `explicit`.
2. `contacts.timezone`, or the timezone of the contact's address (state/ZIP lookup table), gives one zone, source `address`.
3. The NANP area code mapping (a static platform table) gives one or more zones (some area codes span zones), source `area_code`. This is weak for mobile numbers because of number portability.
4. `tenant_settings.default_timezone`, source `tenant_default`.

Quiet hours are evaluated against the **intersection** of allowed windows across all candidates. When the source is weaker than `address`, the tenant default zone is **added** to the candidate set, which keeps the result conservative. The gate decision's `inputs` record the zones, their source, and the computed local times.

DST: windows are computed in local wall-clock time using IANA rules (Temporal polyfill or an equivalent library inside core; the clock is injected). A window boundary that falls in a skipped hour moves to the next valid instant. An ambiguous (repeated) hour uses the later instant. Both cases have explicit tests.

Outcomes: an automated send outside the window gets `defer` with `defer_until` = next window opening in the most restrictive zone + deterministic jitter (0–20 min derived from `hash(message_id)`, so 9:00 AM isn't a thundering herd). A human send follows the table in §1. Pack-defined restricted days and holidays defer automated sends to the next allowed day.

### 2.6 Frequency caps

These are counted at send time, under the per-contact advisory lock, from `messages`. Counted rows: outbound, `initiator ∈ (assistant, system)`, `status ∈ (dispatching, sent, delivered, dispatch_unknown)`, and a non-exempt category. The count is keyed **per address** and per contact (the cross-channel cap), which avoids double-counting when one person has two contact records. Exceeding a cap gives `defer` to the moment the oldest counted send leaves the window, and never `deny`. The caps prevent pile-ups without silently dropping a playbook. A step deferred more than 3 times (default) becomes `skipped_ineligible` with a reason the agent can see in the timeline.

### 2.7 Call recording consent

`core.decideRecording({agentJurisdiction, clientJurisdictions[], packs, tenantPolicy, direction})` returns `{mode, announce: boolean, basis, packVersions}`, and the result is stored in `calls.recording_decision`.

- Default tenant policy `announce_always`: mode `announced_all_parties` on every call. Inbound calls play the announcement before bridging ("This call may be recorded…"). For outbound tap-to-call, the provider plays it to the client on answer before connecting the agent leg, and the agent hears a short tone or the same line.
- Optional `one_party_where_permitted` (Owner attestation recorded in the policy version): the announcement is skipped only when the agent jurisdiction **and** every candidate client jurisdiction resolve to a pack rule of `one_party`. If anything is `all_party` or `unknown`, we announce. Which states require all-party consent, and how interstate calls resolve, are VERIFY WITH COUNSEL items. That is why the default never depends on them.
- Transfers and conferences: a new leg joining (`parent_call_id`) re-runs the decision and re-announces when required.
- Voicemail: the inbound greeting includes the recording notice, and voicemail audio is a `recording` with `consent_basis=announced_all_parties`.
- The agent can stop recording mid-call (one tap). The provider stops, and the partial recording is kept, labelled as partial. "Delete this recording" is Admin-only and audited. It shreds the DEK and the transcript (and the transcript-sourced evidence snippets, §5.4).
- DB CHECK: an answered, completed, non-imported call with mode `announced_all_parties` must have `recording_announced_at`. A provider callback that lacks the announcement event means the recording is quarantined (`status` stays stored but it is hidden) and an Admin alert is raised.
- Agents' own consent to being recorded is captured once as a `user_acknowledgements` row at onboarding.
- `calls.initiator` and `handled_by` deliberately exclude assistant/AI voice in Phase 1. Adding them needs a migration and the R-VOICE rules (§9). Voice AI is Phase 3, and the FCC treats AI-generated voices as "artificial" under the TCPA (VERIFY WITH COUNSEL).

### 2.8 Phone numbers, 10DLC, sender selection

- `a2p_campaigns` (brand/campaign registration refs, use case, sample messages, opt-in description, status `draft|submitted|approved|rejected|suspended`) and `phone_numbers` (`purpose ∈ team_main|agent_direct|pond|tracking`, `number_type local|toll_free`, `a2p_campaign_id`, `toll_free_verification`, `inbound_route`). A number belongs to exactly one tenant at a time. The global `inbound_routes` table (no PII) maps an inbound To-address to a tenant for webhook routing, before any tenant context exists.
- **R-NUM-1**: a local number sends SMS only if its campaign is `approved`. A toll-free number sends only if `verified`. Otherwise `deny SENDER_NOT_REGISTERED`. Registration timelines and use-case rules are carrier/provider-specific (VERIFY with provider). Onboarding shows "Texting turns on when registration is approved" honestly, and calls and email work in the meantime.
- **Sender selection** (`core.chooseSender`): the conversation's `sticky_phone_number_id` if it is still live and registered. Otherwise the owner's `agent_direct` number. Otherwise the tenant `team_main` number. New-lead first responses always use `team_main` (the owner isn't known yet). There is **no automatic fallback** to a different campaign's number when the chosen sender is blocked. That would look like evasion, so the send is `blocked` and surfaces as a failed send.
- Agent departure: `agent_direct` numbers stay with the tenant (`assigned_user_id` is reassigned or the number is re-purposed to `pond`). Inbound continues to route to the contact owner.
- Outbound caller ID always uses a tenant-owned number (never spoofed agent cells). STIR/SHAKEN attestation is the provider's responsibility. We store the provider-reported attestation on `calls` when available (Phase 2 column).

### 2.9 Email infrastructure

- `sending_domains(tenant_id, domain, spf_status, dkim_status, dmarc_status, dmarc_policy, last_checked_at, verified_at)` and `email_identities(tenant_id, user_id NULL, from_address, display_name, domain_id, status)`.
- Until a tenant domain passes SPF and DKIM and has a DMARC record, email is sent from the platform's shared, authenticated domain with the tenant display name, and **marketing email is denied** (`EMAIL_DOMAIN_UNVERIFIED`). Bulk-sender requirements at major mailbox providers (authentication, one-click unsubscribe, complaint-rate thresholds) make this a deliverability necessity too (VERIFY current thresholds).
- Marketing email MUST render: brokerage legal name, brokerage postal address (`tenant_settings.brokerage_postal_address`; marketing is denied with `POSTAL_ADDRESS_MISSING` if null), an unsubscribe link, and List-Unsubscribe headers (CAN-SPAM-style requirements, VERIFY WITH COUNSEL).
- Inbound: `Reply-To: r+{token}@in.{platform-domain}`. The token maps through `inbound_routes(address_kind='email_token')` to tenant and conversation. A reply from an address not on file attaches to the conversation and creates a `needs_review` suggestion "Add jane.work@... to Jane?". It is never auto-added.
- `email_events` (delivered, bounce, complaint, open, click). **Opens are written to `behavior_events` with `reliability='signal'` (CHECK) and shown as "may have opened"**, never as fact (Apple MPP).

---

## 3. The gate: `canContact()` and `dispatchOutbound()`

### 3.1 Signature (packages/core, pure)

```ts
export type Channel = 'sms' | 'voice' | 'email';
export type Purpose = 'marketing' | 'informational';
export type Initiator = 'human' | 'assistant' | 'system';
export type Outcome = 'allow' | 'deny' | 'defer' | 'needs_confirmation';

export interface GateInput {
  now: Instant;                                  // DB transaction_timestamp(), injected
  recipient: { kind: 'contact' | 'user'; contactId?: Id; address: Address; channel: Channel };
  purpose: Purpose;
  initiator: Initiator;
  category: ActionCategory;                      // speed_to_lead_reply | nurture_step | ... | none
  consent: ConsentStateRow[];                    // for this address (+ derived contact addresses)
  suppressions: SuppressionRow[];
  dnc: DncCheckRow[];                            // latest per registry
  contactPoint: { status; lineType } | null;
  automation: { pausedAt: Instant | null; reason?: PauseReason };
  sender: { kind: 'phone' | 'email'; registration: 'ready' | 'pending' | 'blocked'; domainVerified?: boolean } | null;
  recentAutomatedSends: { channel: Channel; at: Instant; exempt: boolean }[];
  recentInboundAt: Instant | null;
  recipientZones: { zones: IanaZone[]; source: TzSource };
  tenant: { brokerageNamePresent: boolean; postalAddressPresent: boolean };
  renderedBody?: { containsBrokerageName: boolean; containsOptOutHint: boolean; flaggedTerms: string[] };
  policy: ResolvedPolicy;                        // floor ∧ packs ∧ tenant, with versions
}

export interface GateDecision {
  outcome: Outcome;
  reasons: ReasonCode[];                         // ALL failing checks, not just the first
  deferUntil?: Instant;
  explanation: string;                           // human sentence for the UI
  rulesVersion: string;                          // core package version
  inputsDigest: string;                          // sha256(canonical JSON of GateInput)
}
export function canContact(input: GateInput): GateDecision;
```

Outcome precedence: any `deny` reason gives `deny`. Otherwise any `needs_confirmation` gives that. Otherwise any `defer` gives `defer` (latest `deferUntil`). Otherwise `allow`. Every reason that applies is returned, so the UI can say everything at once ("Opted out of texts · Outside 9–8 her time").

### 3.2 Checks and reason codes

| # | Check | Reason code | Outcome (assistant/system) | Outcome (human) |
|---|---|---|---|---|
| 1 | Tenant suspended | `TENANT_SUSPENDED` | deny | deny |
| 2 | Contact point invalid / wrong number | `ADDRESS_INVALID`, `WRONG_NUMBER` | deny | deny |
| 3 | SMS to known landline | `CHANNEL_UNSUPPORTED` | deny | deny |
| 4 | SMS sender not registered | `SENDER_NOT_REGISTERED` | deny | deny |
| 5 | Marketing email without verified domain or postal address | `EMAIL_DOMAIN_UNVERIFIED`, `POSTAL_ADDRESS_MISSING` | deny | deny |
| 6 | Marketing without brokerage name rendered | `BROKERAGE_IDENTITY_MISSING` | deny | deny |
| 7 | Consent revoked for channel+purpose | `OPTED_OUT` | deny | deny (no override) |
| 8 | Active suppression | `SUPPRESSED_<REASON>` | deny | deny |
| 9 | Wire/bank/payment instructions in body | `PAYMENT_INSTRUCTIONS_BLOCKED` | deny | deny |
| 10 | No consent basis | `NO_CONSENT_BASIS` | deny | informational SMS: allow if `recentInboundAt` within 30 days, else needs_confirmation; marketing SMS: needs_confirmation; voice/email: allow |
| 11 | Level below required (table below) | `CONSENT_LEVEL_INSUFFICIENT` | deny | needs_confirmation |
| 12 | Only imported basis | `CONSENT_IMPORTED_UNVERIFIED` | deny | needs_confirmation (marketing SMS only) |
| 13 | DNC (marketing voice/SMS) | `DNC_LISTED` / `DNC_STATUS_UNKNOWN` | deny / deny | deny / needs_confirmation |
| 14 | Automation paused for contact | `AUTOMATION_PAUSED` | deny (step → canceled_paused) | n/a (humans may always reply) |
| 15 | Outside window | `QUIET_HOURS` | defer | per §1 |
| 16 | Restricted day/holiday | `RESTRICTED_DAY` | defer | needs_confirmation |
| 17 | Frequency cap | `FREQUENCY_CAP_24H` / `_7D` / `_CROSS_CHANNEL` | defer | n/a |
| 18 | Weak tz evidence | `RECIPIENT_TZ_UNCERTAIN` (informational, always added when source ≤ area_code) | — | — |

Minimum consent level by channel and purpose (platform floor; packs can raise it; VERIFY WITH COUNSEL for every cell):

| Channel / purpose | Assistant or system (automated) | Human one-to-one |
|---|---|---|
| SMS informational | `express` (texted us first, or gave the number for this purpose), not imported | none required unless revoked (row 10 applies) |
| SMS marketing | `express_written` | `inquiry` (unexpired) or above; otherwise needs_confirmation |
| Voice informational | not available in Phase 1 | none unless revoked/internal DNC |
| Voice marketing | not available in Phase 1 | DNC rules (row 13); `inquiry`/`express`/`express_written` satisfy it |
| Email informational | none unless revoked/suppressed | same |
| Email marketing | none (opt-out model) + verified domain + postal address + unsubscribe | same |

**Purpose classification** (agents never pick a purpose from a menu):
- Playbook steps and assistant templates declare their purpose. The playbook validator rejects a step whose declared purpose is `informational` when its intent is in the marketing set (new listings, market updates, referral asks, review requests, home value).
- A human free-form message is `informational` if the contact wrote in during the last 30 days, or if it is sent from a deal or appointment context (TC/transactional). Otherwise it is `marketing`. This is the conservative default (VERIFY WITH COUNSEL).

**Human confirmation**: `needs_confirmation` shows one sheet with the explanation and "Send anyway". Confirming creates a second gate decision (`phase='confirm'`, `confirmed_by_user_id`), which is audited, and dispatch proceeds. Rows 7, 8, 9, 2–6 can never be confirmed past.

### 3.3 Dispatch protocol (the only outbound path)

```
dispatchOutbound(messageId):                  // job handler; also called inline for human sends
  TX1 (SET LOCAL app.tenant_id/user_id/role/principal_type):
    pg_advisory_xact_lock(contactKey)
    SELECT message FOR UPDATE; if status not in (queued, scheduled) -> return (idempotent)
    re-read: conversation pause, enrollment state + playbook approval (if assistant),
             consent_state, suppressions, dnc, counts, sender registration
    autonomy = core.authorizeAutonomousAction(...)   // assistant only (§5.5)
    decision = core.canContact(input)
    INSERT gate_decisions(phase='send', ...)
    allow  -> UPDATE message SET status='dispatching', gate_decision_id, dispatched_at
    defer  -> UPDATE message SET scheduled_for = deferUntil; re-enqueue job
    deny   -> UPDATE message SET status='blocked', status_reason = reasons; exception derivation picks it up
    needs_confirmation (human) -> return to UI; (assistant never gets this outcome)
  COMMIT
  if dispatching: provider.send(idempotencyKey = message.id)   // outside any transaction
  TX2: record provider ref + status 'sent', or 'failed' + error; or 'dispatch_unknown' on timeout
```

- **No network call inside a transaction.** The residual window between the TX1 commit and the provider accepting the message is milliseconds. If an inbound reply lands in it, ingestion sees a `dispatching` message for that contact and the handback says so honestly: "This message went out at the same moment Jane replied." That way nothing is hidden.
- **Unknown dispatch state** (crash or timeout after submit, with no provider ref): status `dispatch_unknown`. It is **never auto-retried**. A reconciliation job queries the provider by to/from/time window. If it finds the message, the status goes to `sent`. If not, after 10 minutes the status goes to `failed` and the item surfaces as a failed send with a "Retry" action for a human. We prefer a missed message to a duplicate one.
- **Provider status callbacks** go to `message_status_events` (unique on provider event ref, so duplicates are no-ops). The message status moves only *forward* in the lattice `dispatching < sent < delivered`, with terminal `failed|undelivered|bounced`. A late `sent` after `delivered` is recorded but doesn't regress the status.
- **Voice**: tap-to-call creates a `calls` row in TX1 with a gate decision, then the provider bridge (call the agent's device or WebRTC first, then the client, with tenant caller ID). Same pattern.
- Notifications to *users* by SMS (agent alerts) also go through `canContact` with `recipient.kind='user'`. Agents can text STOP too, and that is honored.

---

## 4. Inbound ingestion: atomic pause and handback (A3)

```
webhook (signature verified; else 401 + security log) ->
  tenant = inbound_routes[To]   (unknown -> unrouted_webhooks, alert)
  TX (tenant context, actor = provider):
    INSERT provider event idempotency row (unique provider_event_ref) -> on conflict: return 200
    match contact(s) by (kind, address): 0 -> create contact "Unknown +1 555…" (lead intake rule);
                                          1 -> it; >1 -> conversation affinity (last outbound to that address) else needs_review
    for each affected contact (all contacts sharing the address): pg_advisory_xact_lock(contactKey)  [locks taken in sorted id order]
    INSERT messages(direction='inbound', status='received', initiator='client')
    conversation.inbound_seq += 1, last_inbound_at = now
    opt-out / resubscribe / help / wrong-number processing (§2.3)
    if not imported:
      UPDATE playbook_enrollments SET state='paused', pause_reason='client_reply', paused_by_message_id
        WHERE contact_id = ANY(affected) AND state='active'
      UPDATE playbook_step_runs SET status='canceled_paused' WHERE ... status IN ('scheduled','deferred')
      UPDATE messages SET status='canceled', status_reason='AUTOMATION_PAUSED'
        WHERE contact_id = ANY(affected) AND initiator='assistant' AND status IN ('scheduled','queued')
      conversation.automation_paused_at = now, reason='client_reply'
      INSERT assistant_actions(kind='handback', owner = contact owner or pond/team lead, status='proposed')
        placeholder with deterministic claims: "what was sent" (evidence: last N outbound message ids),
        "what the client said" (evidence: this message, verbatim)
      INSERT priority_feed_items(handback), notification (critical if the contact is a hot lead)
      enqueue job 'assistant.enrich_handback' (LLM suggested next step, added later as a claim with evidence or needs_review)
  COMMIT
```

- The handback is useful **without** the LLM. The deterministic parts are written in the same transaction. The LLM enrichment arrives seconds later and is optional. If it fails, the handback still shows what was sent and what the client said.
- **Pause scope**: prospecting and nurture enrollments plus queued assistant messages. Human-scheduled messages ("send at 9am") are **not** canceled. They get re-checked at send time and flagged "Jane replied since you scheduled this" (stale-draft rule, R-AST-4), and they require a re-tap.
- **Auto-replies** (email `Auto-Submitted`/OOO headers, carrier auto-responses) still pause, which is the safe choice. The handback is labelled "Looks like an automatic reply" with the header as evidence, and the agent can "Resume playbook" with one tap.
- **Inbound call from the contact** (answered or missed) pauses the same way. A missed call also creates a callback feed item.
- **Resume** is always a human action ("Resume playbook" on the handback, audited). Phase 1 has no auto-resume.

---

## 5. Assistant: actions, claims, evidence, autonomy

### 5.1 Tables

- `assistant_actions`: every assistant output (draft, autonomous message, call summary, handback, promise extraction, saved-search proposal, next step, lead summary, seller-update draft). Holds `kind`, `action_category`, `autonomy` (`requires_approval | within_playbook | internal`), `playbook_version_id`, `status` (`proposed|approved|rejected|executed|blocked|expired|superseded`), `owner_user_id`, `explanation` (the one-line "why", shown verbatim), `payload`, `edited_payload`, `pinned_inbound_seq`, `ai_run_id`, `trigger_ref`. A DB CHECK forbids `within_playbook` for `money|contract|novel_message|seller_update`.
- `assistant_claims`: atomic statements shown to the agent ("Callback due Thursday at 4 PM", "Max price $450k", "Pre-approved with a lender"). Each has `claim_kind`, `structured` value, `needs_review`, and `review_status` (`unreviewed|confirmed|corrected|rejected`).
- `evidence_refs`: `source_type ∈ {call, message, email, note, listing, import, behavior_event, deal, task, appointment}`, `source_id`, `locator` (`{"kind":"transcript_offset","start_ms":134000,"end_ms":139500}` | `{"kind":"message"}` | `{"kind":"char_range","start":..,"end":..}` | `{"kind":"field","name":"list_price"}`), snippet (encrypted when the source is a transcript), `verbatim_verified`, `source_available`.
- `ai_runs`: model, prompt template key and version, `input_refs` (ids only), `output_enc` (purged after 30 days), `internal_signals` (may include model confidence; **never** serialized to agent-facing API responses; the response Zod schemas omit it), tokens, latency, status.

### 5.2 Evidence rules

- `core.verifyQuote(sourceText, snippet)` normalizes whitespace, case and smart quotes and requires the snippet to appear in the source. For transcripts it also requires the match to fall inside `[start_ms, end_ms]` (± one segment). A failed check sets `verbatim_verified=false` and forces `needs_review=true` on the claim. This stops the most common hallucination: an invented quote.
- Relative dates ("tomorrow", "Thursday") are resolved against the **source's** timestamp in the **contact's** zone (stored in `structured`). The explanation shows both the quote and the resolved date: "Callback due Thu Nov 12, 4 PM — 'call me Thursday around four' at 2:14 in the call."
- Display format, everywhere: `{claim} — {source label} {locator label}`. Tapping it opens the call at that offset or the message.
- `needs_review` claims are shown with a "Check this" marker. They are never inserted into an outbound message, saved search or task due date until the agent confirms or corrects them.

### 5.3 Call pipeline

Provider recording-ready webhook, then a job: download, encrypt (per-object DEK, AES-256-GCM, AAD = `tenant_id|recordings|id`), store, delete the provider copy (`provider_copy_deleted_at`). Then transcription (adapter, fake in dev) into `transcripts.segments_enc`. Then the LLM: summary + claims (commitments become promise tasks; preferences become saved-search proposals), with evidence. The summary is an `assistant_action(kind=call_summary)`. Its rendered text is stored plaintext in `notes` (searchable) only after the agent taps "Save to timeline". The **transcripts themselves are not full-text indexed** in Phase 1, because they are field-encrypted (see §12).

### 5.4 Retention and evidence

When a recording is shredded (retention or delete), its transcript is shredded, every `evidence_ref` pointing at it gets `snippet_enc = NULL, source_available = false`, and the claim shows "Source removed under retention policy." The claim text itself stays, because the agent confirmed it into a task or note.

### 5.5 Autonomy policy (A7b)

`core.authorizeAutonomousAction({category, playbookVersion, approvals, tenantAutonomy, renderedContent, step})` returns `allow` or `downgrade_to_draft(reason)`. All of these must hold:

- R-AUTO-1: the category is in the autonomous set (`speed_to_lead_reply, reminder, booking_confirmation, document_chase, nurture_step, search_alert`) **and** enabled in tenant policy.
- R-AUTO-2: the category is not in the always-human set (`money, contract, novel_message, seller_update`). This is enforced again by a DB CHECK.
- R-AUTO-3: the message comes from a step of a playbook version whose latest approval row is `approve` with a `content_sha256` equal to the version's hash. A revoke row, a mismatched hash or a non-`approved` status means downgrade.
- R-AUTO-4 (content guard, deterministic, in core): the rendered text must pass the step's constraints: max length; links only to tenant-allow-listed domains and listing URLs; required identity sign-off; brokerage name for marketing; STOP hint on the first assistant SMS in the thread. It must also contain no money or contract terms (lexicon: price negotiation, offer, counter, commission, earnest money, contract, addendum, wire, routing/account number, rate lock and similar). Any hit downgrades to a draft. A wire/bank-detail pattern is a hard deny in `canContact` for every initiator (R-GATE-6).
- R-AUTO-5 (novelty): when the step allows AI personalization, the LLM output is constrained to fill the step's declared intent. A classifier pass compares the output's intent with the step intent. A mismatch, or a slot outside the step's declared slots, means `novel_message`, which goes to draft for approval.
- Every downgrade is an `assistant_action(status='proposed', autonomy='requires_approval')` with the reason visible ("Needs your OK: mentions price").

---

## 6. Playbooks (A3, A4, A7a)

### 6.1 Model

- `playbooks(kind, scope team|agent, owner_user_id, template_key, status)`.
- `playbook_versions(version_no, steps jsonb, tone, content_sha256, status draft|approved|superseded|revoked)`. After leaving `draft`, `steps`/`tone`/hash are frozen by a trigger. At most one `approved` version per playbook (partial unique index).
- `playbook_approvals` (append-only): `decision approve|revoke`, approver, role, `content_sha256`, `attestation` (the exact sentence tapped, e.g. "I approve these 6 messages to be sent in my name by my assistant, to contacts who have agreed to receive them").
- `playbook_enrollments`: `state active|paused|completed|stopped`, `pause_reason`, `current_step`, `next_step_due_at`. **At most one live (active or paused) enrollment per contact** (partial unique index). This prevents double-dripping by construction.
- `playbook_step_runs`: unique `(enrollment_id, step_key)`, so a step can never run twice. Holds `status`, `deferrals`, `last_gate_decision_id`, `message_id`, `assistant_action_id`.

A step (Zod schema in core):

```ts
{ stepKey: 'n3', channel: 'sms'|'email', delay: { afterPrevious: 'P14D' } | { afterEnrollment: 'PT0S' },
  purpose: 'marketing'|'informational', category: 'nurture_step'|...,
  intent: 'check_in'|'new_listing_in_area'|'price_drop_saved_home'|'home_anniversary'|'review_request'|'referral_ask'|...,
  template: 'Hi {{firstName}}, ...', personalization: 'none'|'slots'|'rewrite_in_tone',
  slots: ['firstName','savedListingAddress','priceChange'], maxLength: 320,
  stopIf: ['deal_opened','appointment_scheduled'] }
```

### 6.2 Approval and versioning rules

- R-PB-1: only `approved` versions run. A version with no approval row is inert.
- R-PB-2: editing produces a new `draft` version. Approving it inserts an approval row, flips the old version to `superseded` and the new one to `approved` (one transaction), and migrates live enrollments **at their next step boundary** by `stepKey`. Steps removed in the new version are skipped. Until the new version is approved, the old approved version keeps running unchanged.
- R-PB-3: who can approve: `scope=agent` needs the owning agent. `scope=team` needs Owner/Admin. The ownership draft decides whether Team Lead can also approve team playbooks; this draft's default is Owner/Admin.
- R-PB-4: revoking an approval pauses all enrollments on that version immediately (`approval_revoked`) and cancels queued step messages. This happens in one transaction under per-contact locks, in batches of 500 contacts per transaction to bound lock time.
- R-PB-5: ownership change. For enrollments in an `agent`-scoped playbook of the old owner: `paused(owner_change)`, plus a feed item for the new owner: "Continue Jane's nurture with your playbook?" (one tap enrolls in the new owner's approved playbook of the same kind, if any). Team-scoped enrollments continue.
- R-PB-6: one live enrollment per contact (DB unique). Enrolling into a second playbook stops the first with `stop_reason='replaced'`, after confirmation.
- R-PB-7: eligibility is checked at **enrollment** (a preview gate decision, `phase='preview'`, not persisted unless it blocks) **and again at every send**. Enrollment never implies sendability.

### 6.3 Built-in templates (shipped inactive; a human approves once during setup)

| Template | Scope | Category | Phase 1 behavior |
|---|---|---|---|
| `new_lead_response` | team | speed_to_lead_reply (informational) | 1 SMS (if SMS basis ≥ express) and/or 1 email, within 60s of lead creation. Asks one or two qualifying questions (timeline; financing, with VA-loan question only when the lead source or form indicates it). Signs as the team assistant. Then idle until reply or handoff |
| `nurture` (long-term) | agent | nurture_step (marketing) | 6–12 steps over months, behavior-aware slots (price drop on saved home, new match in saved search) |
| `post_closing` | agent | nurture_step / review_request / referral_ask (marketing) | Enrolled at deal `closed` (enrollment `enrolled_by='deal_closed'`). Monthly home-value step is defined with `requires: 'avm_provider'` and is skipped until Phase 2 |
| `booking_confirmation`, `reminder` | team | booking_confirmation / reminder (informational) | Confirmation at booking, reminder 24h before (cap-exempt; consent and quiet hours still apply) |

**60-second flow**:
- At T0 the lead is created. In the same transaction: a lead offer with timer, attribution, a `new_lead_response` enrollment, and a high-priority job.
- At T+1–5s the job builds the message, runs `authorizeAutonomousAction` and `canContact`, and either dispatches, defers (quiet hours: "Your first text to Jane goes out at 9:00 AM her time"), or falls back to email only.
- If neither channel is allowed, nothing is sent and the lead's feed card says "No automatic reply: no texting consent on file."
- The agent's speed-to-lead timer is independent and **not satisfied by the assistant's message** (R-OWN-7).
- The p95 latency target is under 60s from intake. It is monitored, and a breach becomes an internal alert, not an agent-facing exception.

VA/PCS answers are stored as `contact_attributes` with `sensitivity='protected_proxy'`, self-reported, with evidence. They are excluded by type from priority scoring and any future prediction input (R-FH-1).

---

## 7. Imports (A6)

### 7.1 Model

- `import_batches(source csv|fub_api|fub_export, status, source_snapshot_sha256, source_snapshot_at, credential_id, credential_purge_after)`.
- `import_stages(batch_id, category contacts|ownership|notes|messages|call_recordings|consent, seq, status, count_source, count_will_import, count_imported, count_needs_review, count_rejected, count_duplicate, dry_run_completed_at, approved_by/at, committed_at, verified_by/at, verification jsonb)`. A CHECK means a stage cannot be committing or committed without a completed dry run and an approval.
- `import_records(stage_id, source_ref, raw_enc, normalized, outcome, issues[], match_contact_id, target_table, target_id, review_decision)`. Unique `(stage_id, source_ref)`, so a re-run is idempotent.
- `import_user_mappings(batch_id, source_user_ref, source_user_label, target_user_id | target_pond_id | 'unassigned')`. This must be complete before the ownership stage dry run.
- Every imported domain row carries `import_batch_id` (and `imported=true` + `import_record_id` on messages, calls, consent events), which makes reversal a precise query.

### 7.2 FUB migration flow

1. **Connection and export test** (`status=connection_test`): validate the API key (stored in `provider_credentials`, encrypted, `purge_after` = 30 days after the last stage is verified). Pull **counts only** per category and show them. No promises are shown before this step. The UI copy is "Here's what we found in your Follow Up Boss account".
2. **Snapshot**: fetch all categories into `import_records` (raw encrypted) with `source_snapshot_sha256`. Every later step works on the snapshot, never on live FUB. Recording audio is fetched in the call_recordings stage dry run (FUB recording URLs may be time-limited; VERIFY with FUB API docs).
3. **Per-stage dry run in dependency order**: contacts → ownership → notes → messages → call_recordings → consent. Each dry run runs `core` normalization, validation and dedup and sets per-record outcomes. The report shows `source | will import | needs review | rejected | duplicate`, with a per-record review list (filter, inspect, decide import/merge/reject).
4. **Approve and commit per stage**: commit applies **exactly the reviewed records** (the dry-run outcomes, after review decisions), in chunks of 1,000 per transaction with resumable progress. Changes in FUB after the snapshot require a new delta snapshot and dry run. The commit never silently picks up new data.
5. **Verify per stage**: a post-commit recount (source vs imported vs needs-review vs rejected, plus spot checks: 20 random records shown side by side). Admin taps "Verified". Later stages can be dry-run before earlier ones are verified, but cannot be committed until they are.
6. **Reverse** (per batch, or per stage in reverse dependency order): rows untouched since import are deleted (or, for append-only tables, compensated). Rows touched since import (edited, messaged, assigned) are listed for a manual decision and never auto-deleted. Consent events are compensated with `import_revert` events; imported **revocations stay in force** (R-IMP-9).

Category specifics:
- **Contacts**: dedup against existing contacts with `core.matchContacts` (exact normalized phone/email, then name + fuzzy trigram as `needs_review`, never auto-merged on name alone). FUB stage, tags and source go to `contacts.original_source_id` / `lead_sources` (attribution kept as imported, labelled).
- **Ownership**: assignment through the ownership engine's `importAssignment` command (audited `lead_ownership_events` with `actor=import`). It does not run speed-to-lead timers, does not create offers, and does not count toward the scoreboard.
- **Notes, messages**: `imported=true`, original timestamps in `occurred_at`. They never pause, hand back, count toward caps or SLAs, or create exceptions (CHECKs plus the ingestion code path differ: imports call `insertHistoricalMessage`, never `ingestInbound`).
- **Call recordings**: copied into our encrypted storage, `consent_basis='unknown_imported'`, shown with the label "Imported from Follow Up Boss — recording notice unknown". Transcription of imported recordings is **off by default** (cost and consent ambiguity). The agent can transcribe a single recording on request.
- **Consent**: FUB opt-out, unsubscribe and DNC flags become `revoke` events (or `internal_dnc` suppressions) with `original_provenance` = the verbatim FUB fields and the date when known. Any positive consent indicator becomes `grant` at `imported_unverified` (DB CHECK). The import report says plainly: "312 contacts had texting permission in Follow Up Boss. We kept that as history, but the assistant won't text them automatically until they confirm."

### 7.3 CSV

The same stage machinery with a single `contacts` stage (plus an optional `consent` stage from mapped columns). There is a column-mapping preview with sample rows, phone default country from the tenant, and invalid values rejected with a reason. A CSV consent column can produce only `imported_unverified` grants or revocations, with provenance `{"file":"leads.csv","row":42,"column":"sms_ok","value":"yes"}`. Max 50k rows per file in Phase 1.

---

## 8. Complete Phase 1 data model

Conventions: UUIDv7 ids from the injected generator; `tenant_id uuid NOT NULL` on every tenant-scoped table; composite `UNIQUE (tenant_id, id)` on parents and composite FKs `(tenant_id, x_id)` on children (cross-tenant references are impossible even with an app bug; tested); `text + CHECK` instead of ENUM types (cheaper migrations); money in integer cents, rates in basis points; `timestamptz` only; append-only tables marked **[AO]** use `app.make_append_only()`; every tenant table calls `app.apply_tenant_rls()`.

Legend: **P1** = built and written in Phase 1. **Shape** = which later features the table is shaped for, without building them.

### 8.1 Platform, tenancy, auth

| Table | Key columns / constraints | RLS | Shape (later) |
|---|---|---|---|
| `tenants` | id, slug unique, status | `id = current_tenant` | Brokerage org above tenants (multi-team) Phase 3 via `organizations` + `tenants.organization_id` |
| `tenant_settings` | brokerage_legal_name NOT NULL non-blank, team_name, brokerage_postal_address, default_timezone NOT NULL, operating_jurisdictions[], active_policy_version_id, branding jsonb | tenant | Jurisdiction-pack advertising rules (A7f) |
| `compliance_policy_versions` [AO] | version_no unique per tenant, policy jsonb (quiet hours, caps, autonomy switches, recording mode, opt-out confirmation sender), jurisdiction_pack_versions | tenant | Policy diffs and audits for counsel |
| `jurisdiction_packs` (global) | key ('US','US-SC'), version, rules jsonb, status draft/published, reviewed_by_counsel_at, notes | SELECT-only to app_user | Grows per state |
| `users` (global) | id, email unique lower, password_hash (argon2id), display_name, mfa (Phase 2) | via app (self only) | SSO Phase 3 |
| `tenant_memberships` | PK (tenant_id, user_id), role CHECK six roles, status, home_jurisdiction, mobile_e164, on_duty_schedule jsonb | tenant | Coaching relationships (team_lead_id) Phase 2 |
| `sessions` | token_sha256 PK, user_id, tenant_id, created_at, expires_at (default 30 days sliding, 12h idle on shared devices), last_seen_at, ip, user_agent, revoked_at | not RLS (looked up pre-tenant by hash); app_user SELECT/INSERT/UPDATE only on own-token lookup path | Device management |
| `auth_attempts` | key (ip / email hash), window_start, count | platform | — |
| `user_acknowledgements` | tenant_id, user_id, doc_key ('recording_notice','tos'), doc_version, accepted_at | tenant | — |
| `provider_credentials` | tenant_id, provider, secret_enc (AES-GCM envelope), created_by, purge_after | tenant; secret never returned by API | Channel accounts (FB/IG) Phase 2 |
| `audit_log` [AO] | bigint identity, tenant_id, actor_type user/assistant/system/provider/import, actor_user_id, action, subject_type/id, request_id, ip, details (refs only, never bodies) | tenant (SELECT for owner/admin only via app) | Hash-chain anchoring Phase 2 |

### 8.2 Contacts, attribution, behavior

| Table | Key columns / constraints | Shape |
|---|---|---|
| `contacts` | display_name, first/last, owner_user_id (composite FK to membership), timezone, original_source_id (first touch, immutable after insert via trigger), original_campaign_ref, original_ad_ref, merged_into_contact_id, import_batch_id, deleted_at, erased_at, `search_tsv` generated, trigram on name | Client portal principal link (`client_principals.contact_id`) Phase 3 |
| `contact_points` | §2.1 | Reassigned-number checks |
| `contact_collaborators` | (contact, user) role isa/transaction_coordinator/co_agent | Visibility for ISA/TC |
| `contact_addresses` | type home/mailing/property, normalized address, state, postal_code (drives tz + jurisdiction) | Public-records enrichment Phase 3 |
| `contact_attributes` | key, value jsonb, sensitivity normal/protected_proxy, self_reported bool, evidence claim id | Fair-housing-safe prediction inputs (protected_proxy excluded by type) |
| `lead_sources` | tenant catalog: name, kind (portal/website/referral/sphere/open_house/ads/other), active | Source to commission reporting Phase 2 |
| `behavior_events` [AO] | contact_id, event_type (listing_saved, listing_viewed, website_visit, email_opened, email_clicked, search_alert_opened), reliability fact/signal (CHECK: email_opened ⇒ signal), listing_id, source, occurred_at, dedupe_key unique, payload | Behavior-triggered playbook steps richer in Phase 2; 90-day prediction Phase 3 (BRIN index on occurred_at; monthly partitions when > 50M rows) |
| `notes` | contact_id/deal_id, author, body, pinned, imported, import_record_id, search_tsv | — |

### 8.3 Leads, ownership, ponds (summary; the ownership draft owns detail)

| Table | Key columns / constraints | Shape |
|---|---|---|
| `leads` | contact_id, source_id, campaign_ref, ad_ref, source_detail jsonb (utm), intake_channel, state (new/offered/accepted/in_pond/released/converted/closed), owner_user_id, pond_id, accepted_at, first_human_touch_at, version int (optimistic concurrency) | Ad-spend attribution Phase 3 |
| `lead_intake_events` [AO] | raw payload (encrypted), source, received_at, consent_disclosure_id, idempotency key unique | Zillow/realtor.com feeds, website chat (channel abstraction) Phase 2 |
| `lead_offers` | lead_id, offered_to_user_id, offered_at, expires_at, status pending/accepted/declined/expired/revoked, decided_at; partial unique one pending offer per lead | Round-robin weighting |
| `lead_ownership_events` [AO] | lead_id, contact_id, event (offered/accepted/declined/expired/released_to_pond/claimed/reassigned/import_assigned), from_user, to_user, pond_id, actor, reason, rule_id | Coaching on response time |
| `ponds`, `pond_members` | name, claim rules (who may claim), auto-release minutes | — |
| `routing_rules` | priority, match jsonb (source, zip, price band), target (user/rotation/pond), offer_timeout_minutes (default 5), active | Expanded admin Phase 2 |

### 8.4 Communication

| Table | Notes |
|---|---|
| `conversations` | One per contact (unique), sticky sender, `inbound_seq`, automation pause fields |
| `messages` | §3; channel CHECK `sms|mms|email` (MMS inbound only in P1; media in `message_media` with encrypted storage). **Shape**: unified inbox channels (fb_dm, ig_dm, web_chat, portal) by widening the CHECK and adding `channel_account_id` in Phase 2. The conversation stays per person |
| `message_media` | message_id, storage_key, dek_wrapped, mime, size, sha256 (inbound MMS photos may contain IDs; encrypted) |
| `message_status_events` [AO] | provider callbacks |
| `calls` | §2.7; `initiator` excludes AI voice; `parent_call_id` for transfers. **Shape**: voice AI (`handled_by='voice_ai'`, warm-transfer legs) Phase 3 |
| `recordings`, `transcripts` | Encrypted, restrictive visibility policy, retention fields. **Shape**: call scoring Phase 2–3 reads transcripts through the same restrictive policy |
| `voicemails` | Not a table: a `calls` row with status `voicemail` + recording |
| `phone_numbers`, `a2p_campaigns`, `inbound_routes` (global) | §2.8 |
| `sending_domains`, `email_identities`, `email_events` | §2.9 |
| `provider_webhook_events` | Idempotency + raw payload (encrypted) per tenant; `unrouted_webhooks` (platform, no tenant) for unknown To addresses |

### 8.5 Compliance

`consent_disclosures` [AO], `consent_events` [AO], `consent_state`, `suppressions`, `dnc_checks` [AO], `gate_decisions` [AO], plus `compliance_policy_versions` [AO] and `jurisdiction_packs`. These are covered in §2–3 and Appendix A.

### 8.6 Assistant and playbooks

`assistant_actions`, `assistant_claims`, `evidence_refs`, `ai_runs`, `playbooks`, `playbook_versions`, `playbook_approvals` [AO], `playbook_enrollments`, `playbook_step_runs`. **Shape**: AI weekly plans (Phase 2) are `assistant_actions(kind='weekly_plan')` with claims; call scoring is `kind='call_score'`; ad-budget changes are category `money` (always a tap).

### 8.7 Listings, buyer searches, sellers

| Table | Key columns | Shape |
|---|---|---|
| `listings` | source team/mls (P1: team only), mls_ref, address fields, state, postal_code, status, list_price_cents, beds, baths_x10, sqft, property_type, listing_agent_user_id, list_date, attributes jsonb, search_tsv | MLS/IDX feed adapter (licensing VERIFY), marketing generation Phase 2 |
| `listing_price_history` [AO] | listing_id, price_cents, changed_at | Price-drop triggers for saved homes |
| `saved_searches` | contact_id, status proposed/approved/active/paused/archived, criteria jsonb (core schema: price min/max, beds, baths, areas, property types, must-haves), criterion_evidence jsonb (criterion → claim_id), proposed_by_action_id, approved_by/at, alert_channel email/sms, alert_frequency instant/daily/weekly (default daily) | MLS matching |
| `saved_search_matches` | search_id, listing_id unique pair, matched_at, alerted_message_id | — |

Buyer-search rules: R-SRCH-1, a search becomes `active` only by agent approval (the criteria are frozen into the row; later edits by the agent are audited). R-SRCH-2, criteria derived from `needs_review` claims are pre-filled but unchecked, and can't be activated until confirmed. R-SRCH-3, alerts are `purpose=marketing, category=search_alert`, sent through `canContact`. SMS alerts require `express_written`; email alerts follow the email marketing rules. Matching in P1 runs against `listings` only.

**Specified but not migrated in Phase 1** (no Phase 1 writer, so a migration now would be dead schema): `showings(listing_id, starts_at, buyer_agent_name, status)`, `showing_feedback(showing_id, rating, comments, source, received_at)`, `marketing_activity(listing_id, kind, channel, occurred_at, metrics jsonb)`, `deal_milestones`, `channel_accounts`, `client_principals`, `client_access_grants`, `avm_valuations`. Their names and FKs are reserved here so Phase 2 slots in cleanly. If product wants agents to log showings in Phase 1, `showings` + `showing_feedback` are cheap to promote (open question).

### 8.8 Deals

| Table | Key columns | Shape |
|---|---|---|
| `deals` | primary_contact_id, side buy/sell, stage (lead, agreement_signed, active, under_contract, closed, lost), stage_entered_at, owner_user_id, listing_id, price_cents, under_contract_at, expected_close_date, closed_at, **attribution copied at creation and immutable** (lead_id, source_id, campaign_ref, ad_ref), **commission**: gross_commission_cents, commission_rate_bps, team_split_bps, agent_split_bps, referral_fee_cents, commission_status estimated/confirmed | Owner dollars view Phase 2; milestones + risk flags Phase 2 |
| `deal_participants` | deal_id, contact_id or external name, role buyer/seller/co_buyer/lender/title/other_agent | Client portal grants Phase 3 |
| `deal_stage_history` [AO] | deal_id, from_stage, to_stage, changed_by, changed_at | Dwell / momentum metrics (A5) |

R-DEAL-1: commission fields are writable only by human users with role ∈ {owner, admin, team_lead} or the deal owner. The assistant can never write them (category `money`). They are readable by those roles only; ISA and TC API serializers omit them.

### 8.9 Tasks, appointments, accountability, feed, scoreboard

| Table | Key columns | Notes |
|---|---|---|
| `tasks` | contact_id, deal_id, assignee_user_id, kind todo/callback/promise/follow_up, title, due_at, due_tz, status open/done/canceled, completed_at, created_by_kind user/assistant, source_action_id, needs_review | Promise tasks come from claims with evidence. If the date can't be pinned, `due_at NULL` + `needs_review` |
| `appointments` | contact_id, user_id, kind consult/buyer_consult/listing_appointment/showing, starts_at, ends_at, status scheduled/held/no_show/canceled, outcome, outcome_logged_at | Missing-outcome exceptions; calendar sync Phase 2 |
| `priority_feed_items` | user_id, item_type, subject ref, contact_id, score int, score_reasons jsonb (shown on tap: "New lead · 3 min left · Zillow"), due_at, state open/done/snoozed/dismissed, dedupe_key unique per user | Cache rebuilt deterministically by `core.scoreFeed` (sensitive attributes excluded by type) |
| `exception_items` | item_type untouched_lead/overdue_promise/failed_send/missing_outcome, subject ref, owner_user_id, detected_at, evidence jsonb (ids), condition_cleared_at, dedupe_key unique | **Derived cache**, recomputable by `core.deriveExceptions` |
| `exception_resolutions` [AO] | dedupe_key, action resolved/reassigned/verified, note (required for resolved), actor, at | Human inputs live here, so recompute never loses them; verification requires role team_lead+ |
| scoreboard | SQL views over `leads`, `lead_ownership_events`, `messages`, `calls`, `appointments`, `deals` | Shows denominators ("12 of 14 within 5 min"); no derived numbers without them |
| `pipeline_momentum` | view: per agent, per stage, median dwell vs team median over 90 days | A5 "losing momentum" |

Untouched-lead definition (R-ACC-1): assigned (accepted or directly assigned) at T, with no **human** outbound touch (outbound SMS/email with status sent|delivered, or an outbound call attempt with any terminal status) by T + SLA (default 15 minutes). If T falls outside the contact's automated window, the clock starts at the next window opening. Assistant messages never count.

### 8.10 Notifications

`notifications(user_id, kind, priority critical/normal/low, title, body_minimal, subject ref, created_at, read_at)`, `notification_deliveries(notification_id, channel in_app/web_push/sms/email, status, attempts, last_error, sent_at)`, `notification_preferences(user_id, kind, channels[], quiet_hours)`, `push_subscriptions(user_id, endpoint, keys_enc, created_at, revoked_at)`. Defaults: new-lead offers and handbacks of hot leads are `critical` (push + SMS-to-agent during the agent's on-duty schedule, via `canContact` recipient=user). Everything else is in-app + push. Delivery is idempotent per (notification, channel), with retries and backoff via jobs.

### 8.11 Search and documents

- Search: `search_tsv` generated columns + GIN on contacts, notes, messages, listings; trigram on contact names and on `contact_points.address` (digits). One API runs parallel queries and merges results, always filtered by the visibility scope (§10). Transcripts are excluded (encrypted).
- `documents(owner refs, kind consent_form/agreement/disclosure/other, storage_key, dek_wrapped, filename, mime, size, sha256, uploaded_by, deleted_at)`. A document referenced by `consent_events.evidence_document_id` cannot be deleted (FK + app check).

### 8.12 Infrastructure

- `jobs(id bigint identity, tenant_id NULL for platform jobs, queue, kind, payload jsonb (ids only, never PII or bodies, R-PRIV-3), run_at, priority, status queued/running/succeeded/failed/dead, attempts, max_attempts, locked_at, locked_by, last_error, dedupe_key)`. Partial unique `(dedupe_key) WHERE status IN ('queued','running')`. Claiming uses `FOR UPDATE SKIP LOCKED` through a dedicated `app_worker` role whose policy allows cross-tenant SELECT/UPDATE on `jobs` only. The handler then runs in a fresh transaction with `SET LOCAL app.tenant_id = job.tenant_id` under the same RLS as API requests. Queues: `realtime` (lead response, dispatch, timers; target < 2s pickup), `default`, `bulk` (imports, recompute).
- Domain writes and their job enqueue happen in the same transaction (transactional outbox by construction).

---

## 9. Rules (testable)

Format: ID, then the statement (and the test hook).

**Tenancy and permissions**
- R-TEN-1: with `app.tenant_id` unset, every tenant-scoped table returns 0 rows and rejects writes. *(tested)*
- R-TEN-2: a row in tenant A cannot reference a row in tenant B (composite FK). *(tested)*
- R-TEN-3: `app.principal_type <> 'staff'` sees no staff tables. Client principals (Phase 3) get explicit additional policies per client-visible table, scoped by `client_access_grants`. *(tested for 'client')*
- R-TEN-4: global tables (`users`, `jurisdiction_packs`, `inbound_routes`, `sessions`) contain no tenant PII beyond what their purpose needs. `inbound_routes` holds only address → tenant_id.
- R-PERM-1: Agents see contacts they own or collaborate on, plus contacts in ponds they belong to (claimable view: name, source, age; **no message bodies, recordings or transcripts until claimed**). TeamLead/Admin/Owner see all. ISA sees assigned and pond leads. TC sees contacts on deals they're assigned to.
- R-PERM-2: recordings and transcripts are additionally protected by a RESTRICTIVE RLS policy `app.can_view_contact(contact_id)`. *(tested: owner agent 1, other agent 0, team lead 1)*
- R-PERM-3: every recording play or download, and every transcript view, writes `audit_log(action='recording.accessed')`.
- R-PERM-4: only Owner can change recording mode, retention, brokerage identity, or jurisdiction operating list. Only Owner/Admin can manage numbers, domains, imports, team playbooks, and lift internal DNC/admin blocks.
- R-PERM-5: `app.role` is set server-side from `tenant_memberships`, never from request input. A deactivated membership's sessions are revoked in the same transaction.

**Consent**
- R-CON-1: consent events are never updated or deleted. *(tested)*
- R-CON-2: an imported grant is always `imported_unverified`. *(tested)*
- R-CON-3: `express_written` requires a disclosure row or a signed document. *(tested)*
- R-CON-4: `verbal_on_call` consent must cite a call (and should cite an offset). *(tested)*
- R-CON-5: `consent_state` equals `core.projectConsent(consent_events)` for every key; the nightly verifier reports drift.
- R-CON-6: an expired `inquiry` basis projects to `none` at evaluation time even if the cached state is stale.
- R-CON-7: an agent can record a revocation for any contact they can see. Recording a grant requires evidence appropriate to its level; `agent_entry` grants max out at `express`.

**Opt-out**
- R-OPT-1: an inbound exact keyword in the revoke list creates a revoke event, cancels queued SMS and pauses automation **in the same transaction as the inbound message insert**.
- R-OPT-2: after R-OPT-1 commits, any dispatch to that address gets `deny OPTED_OUT` (the dispatch re-reads state under the same advisory lock).
- R-OPT-3: a STOP to any tenant number blocks SMS from all tenant numbers to that address, and to the contact's other phone addresses.
- R-OPT-4: at most one opt-out confirmation per revoke event, and none if the provider sends it.
- R-OPT-5: `START`/`UNSTOP` restores the consent state that existed before the most recent keyword revoke (the ledger treats that revoke as suspended). It does not restore revocations from other sources (language, provider, wrong number, email complaint) (VERIFY WITH COUNSEL).
- R-OPT-6: a wrong-number reply marks the contact point `wrong_number`, revokes all channels for the address, and stops the contact's enrollment.
- R-OPT-7: a provider "opted out" send error creates a `provider_report` revoke, and the message is never retried.
- R-OPT-8: an opted-out address can be reinstated only by the person's own action (START, a new form submission with disclosure, a signed document). No staff role can lift an opt-out.

**Gate and dispatch**
- R-GATE-1: an outbound message or call row cannot reach `dispatching`/`sent`/`delivered`/`failed` etc. without a `gate_decision_id` (DB CHECK). *(tested)*
- R-GATE-2: only `dispatchOutbound` imports provider send/dial (lint + test).
- R-GATE-3: assistant/system sends evaluate `canContact` at send time. A schedule-time evaluation never authorizes a send.
- R-GATE-4: `canContact` is pure and deterministic: same input gives the same decision and `inputsDigest`. A property test checks that deny reasons are monotonic (adding a revoke never turns deny into allow).
- R-GATE-5: denial reasons in rows 2–9 of §3.2 cannot be overridden by confirmation.
- R-GATE-6: messages matching the payment-instruction pattern (routing/account numbers, "wire to", IBAN/SWIFT) are denied for every initiator, with the message "For safety, wiring details can't be sent by text or email from here."
- R-GATE-7: a provider timeout after submit leads to `dispatch_unknown`, which is never auto-retried.

**Quiet hours, caps**
- R-QH-1: automated SMS/voice outside the effective window is deferred to the next opening in the most restrictive candidate zone.
- R-QH-2: when the tz source is `area_code` or `tenant_default`, the candidate set includes the tenant zone and all zones of the area code.
- R-QH-3: tenant windows can only be narrower than pack and floor windows; the policy validator rejects wider ones.
- R-FREQ-1: caps are evaluated under the per-contact lock. Two concurrent dispatches for the same contact cannot both pass a cap of 1.
- R-FREQ-2: exceeding a cap defers and never drops. After 3 deferrals the step is `skipped_ineligible` with a visible reason.

**Recording**
- R-REC-1: by default every recorded call announces to all parties before recording begins (DB CHECK on `recording_announced_at`). *(tested)*
- R-REC-2: under `one_party_where_permitted`, any `all_party` or `unknown` jurisdiction among candidates still means announce.
- R-REC-3: adding a call leg re-evaluates and re-announces.
- R-REC-4: a recording past `retain_until` and not on legal hold is shredded within 24h, along with its transcript and transcript evidence snippets.

**Numbers and email**
- R-NUM-1: SMS from an unregistered or unverified sender is denied.
- R-NUM-2: no automatic cross-campaign fallback.
- R-NUM-3: each tenant has isolated provider messaging services/sub-accounts.
- R-EML-1: marketing email is denied until the tenant domain passes SPF+DKIM and has DMARC.
- R-EML-2: every marketing email has one-click unsubscribe and the brokerage name.
- R-EML-3: marketing email is denied without a brokerage postal address.

**Assistant and evidence**
- R-EVID-1: a claim not flagged `needs_review` has ≥ 1 `verbatim_verified` evidence ref (deferred trigger). *(tested)*
- R-EVID-2: a snippet that fails `verifyQuote` sets `needs_review`.
- R-EVID-3: `needs_review` claims are never auto-inserted into outbound content, saved-search criteria, or task due dates.
- R-EVID-4: agent-facing API schemas contain no confidence fields (snapshot test of OpenAPI/Zod output).
- R-AST-1: every autonomous message includes the identity sign-off. The first one in a thread also includes the brokerage name and STOP hint.
- R-AST-2: the assistant never claims to be human. A content guard rejects first-person human claims ("I'm Sarah", "this is Sarah") in assistant-authored text unless followed by the assistant identity ("Sarah's assistant").
- R-AST-3: the AI prompt builder receives data for exactly one contact (plus their own deals and listings) and the tenant's brokerage identity. A test asserts that no other contact ids appear in prompt inputs.
- R-AST-4: approving a draft whose `pinned_inbound_seq` < the conversation's current `inbound_seq` returns `DRAFT_STALE` ("Jane replied since this was drafted") and requires re-review.
- R-AUTO-1..5: §5.5. R-AUTO-2 is DB-enforced. *(tested)*

**Playbooks**
- R-PB-1..7: §6.2. R-PB-2 (freeze) and R-PB-6 (one live enrollment) are DB-enforced. *(tested)*
- R-PAUSE-1: any non-imported inbound message or call from any address of a contact pauses that contact's active enrollments and cancels queued assistant messages in the ingestion transaction. If the address is shared, all contacts sharing it are paused.
- R-PAUSE-2: dispatch of an assistant message re-checks pause state under the advisory lock immediately before marking `dispatching`.
- R-PAUSE-3: only a human resumes a paused enrollment; resume is audited.
- R-PAUSE-4: every pause on client reply creates exactly one handback (dedupe key `handback:{enrollment_id}:{message_id}`).

**Ownership (interfaces with the ownership draft)**
- R-OWN-1: accepting an offer is `UPDATE lead_offers SET status='accepted' WHERE id=$1 AND status='pending' AND expires_at > $now`. Zero rows plus `expires_at <= now` means `LEAD_OFFER_EXPIRED`, recorded as a `lead_ownership_events` row.
- R-OWN-2: the expiry job is idempotent: `UPDATE … SET status='expired' WHERE status='pending' AND expires_at <= $now`.
- R-OWN-3: `$now` is the DB transaction timestamp passed into core, never the app server clock.
- R-OWN-4: two concurrent claims of a pond lead: exactly one succeeds (conditional update on `leads.version`). The loser gets `LEAD_ALREADY_CLAIMED`.
- R-OWN-5: every ownership change writes `lead_ownership_events` and `audit_log` in the same transaction.
- R-OWN-6: an ownership change triggers R-PB-5 and re-evaluates the sticky sender.
- R-OWN-7: assistant messages never satisfy the speed-to-lead timer or the untouched-lead SLA.

**Imports**
- R-IMP-1: no stage commits without a completed dry run and approval (DB CHECK). *(tested)*
- R-IMP-2: commit applies the reviewed snapshot only.
- R-IMP-3: imported messages and calls never pause, hand back, count toward caps or SLAs, or raise exceptions.
- R-IMP-4: imported consent grants are `imported_unverified`; imported revocations take effect at commit.
- R-IMP-5: name-only matches are never auto-merged.
- R-IMP-6: the ownership stage requires a complete user mapping.
- R-IMP-7: reversal deletes or compensates only untouched rows and lists touched rows.
- R-IMP-8: the FUB credential is purged at `purge_after`.
- R-IMP-9: `import_revert` voids imported grants, never imported revocations.

**Privacy and fair housing**
- R-PRIV-1: highly sensitive columns (recording DEKs, transcripts, provider credentials, import raw payloads, push keys) are field-encrypted with AAD bound to tenant, table and row id. Ciphertext copied to another row or tenant fails to decrypt.
- R-PRIV-2: contact erasure nulls PII but keeps consent and suppression records keyed by `address_hash`.
- R-PRIV-3: job payloads and audit `details` contain ids, never bodies or PII.
- R-PRIV-4: push payloads carry first name + last initial at most (tenant can choose none).
- R-FH-1: `protected_proxy` attributes are excluded from feed scoring and from any future prediction input. The scoring function's input type has no field for them (compile-time).
- R-VOICE-1: Phase 1 has no AI-originated or AI-handled calls (DB CHECK on `calls.initiator`/`handled_by`). Phase 3 must add identity disclosure, artificial-voice consent rules, and transfer recording before relaxing it (VERIFY WITH COUNSEL).

---

## 10. RLS and visibility approach

- **Layer 1, tenant isolation (RLS, hard)**: `app.apply_tenant_rls()` on every tenant table. `ENABLE` + `FORCE`, policy `tenant_id = app.current_tenant_id() AND app.principal_type() = 'staff'` for both USING and WITH CHECK. Helper functions return NULL when the setting is unset, so the default is zero rows.
- **Layer 2, intra-tenant visibility (app scope + targeted RLS)**: a single repository helper `visibleContacts(ctx)` builds the role-based predicate (R-PERM-1). All contact-scoped queries go through it (a lint rule bans raw `selectFrom('contacts')` outside the repository). For the most sensitive tables (recordings, transcripts) a RESTRICTIVE policy duplicates the check in the DB. Extending RESTRICTIVE policies to `messages` is an option if performance allows (open question). The owner/collaborator lookups are indexed.
- **Session variables** set per request: `SET LOCAL app.tenant_id, app.user_id, app.role, app.principal_type`. The API sets them from the session row only.
- **Client principals (Phase 3)**: `app.principal_type='client'`, `app.client_id`. Client-visible tables (deals, deal_participants, listings, documents marked shared, showings, showing_feedback) get an additional PERMISSIVE policy `principal_type='client' AND EXISTS (client_access_grants …)`. All other tables stay invisible because their only policy requires `staff`.
- **Global tables** have no tenant data or are SELECT-only for `app_user`. Writes come from the migration and provisioning role.
- **Object storage**: keys are prefixed `tenants/{tenant_id}/…`. Every object is encrypted with its own DEK and AAD includes the tenant id, so a mis-keyed fetch fails to decrypt instead of leaking.

---

## 11. Edge cases

| # | Case | Handling |
|---|---|---|
| 1 | STOP arrives while a playbook message is being dispatched | Both paths take the per-contact advisory lock. If ingestion wins, dispatch sees the revoke and denies. If dispatch committed `dispatching` first, the message goes out (ms window), ingestion records it, and the handback says "sent at the same moment" |
| 2 | STOP sent to number A, assistant about to send from number B | Tenant-wide address revocation (R-OPT-3) means deny |
| 3 | Spouses share a landline/phone, one texts STOP | Address-keyed revoke blocks SMS to both contacts. The UI on the other contact explains "This number opted out on Nov 3" |
| 4 | "Stop by at 5?" / "Don't stop sending listings!" | Not exact keywords. The language regex requires stop+contact verbs and negation handling. If a pattern matches wrongly, the agent can mark "not an opt-out" (audited); it is only restorable if the prior basis exists |
| 5 | "stop." / "Stop 🙏" / "STOP STOP" | Normalization strips punctuation and emoji and collapses repeats, so these are exact matches |
| 6 | Client replies while a nurture message is queued | Ingestion cancels queued assistant messages and pauses (R-PAUSE-1) |
| 7 | Client replies to a human-scheduled message | Not canceled. Send-time stale check requires a re-tap |
| 8 | Out-of-office email reply | Pauses (safe) and the handback is labelled auto-reply with header evidence. One-tap resume |
| 9 | Recipient tz unknown / area code spans two zones / client traveling | Intersection of windows over candidates + tenant zone. The agent can set an explicit tz on the contact point |
| 10 | DST spring-forward at a window boundary | Boundary moves to the next valid instant; tested |
| 11 | Queue backlog pushes a 7:55 PM send past 8 PM | Send-time check defers to the next morning |
| 12 | 9:00 AM burst of deferred sends | Deterministic jitter 0–20 min per message |
| 13 | Two playbook steps race for the same contact | Impossible to double-enroll (unique). Dispatch is serialized by the lock, and the cap check sees the first |
| 14 | Provider callbacks arrive out of order or twice | `message_status_events` unique on event ref; status lattice moves forward only |
| 15 | Provider timeout after submit | `dispatch_unknown`, reconciliation, never auto-retry |
| 16 | Lead form with no SMS consent language | No automated SMS. Email first response if email exists. Agent call/text allowed per human rules (`inquiry` basis) |
| 17 | Lead provider consent names another company | Recorded at `inquiry`, with the full disclosure stored |
| 18 | Lead arrives at 2 AM | Email reply immediately (email has no quiet hours by default). SMS deferred to the window opening. Agent timer per the ownership draft's on-duty rules |
| 19 | Same lead submits twice in 5 minutes | Intake idempotency + contact dedup. `new_lead_response` has a one-per-contact-per-24h dedupe key |
| 20 | Imported FUB contact marked unsubscribed | Imported revoke event is honored immediately at stage commit |
| 21 | Imported contact matches an existing contact with `express_written` | Merge keeps the existing ledger. Imported events are added as history and the projection keeps the stronger valid basis |
| 22 | Contacts merged | Consent is address-keyed (unaffected). Conversations are merged into the survivor (messages re-pointed). The loser's enrollment is stopped and the survivor's kept |
| 23 | Contact erased (privacy request) | PII nulled. Suppressions and consent kept with address hash. Recordings and transcripts shredded unless on legal hold |
| 24 | Agent leaves the team | Membership deactivated, sessions revoked. Contacts reassigned through the ownership engine. Agent-scoped enrollments paused `owner_change`. Their direct number re-purposed. Approvals remain historical facts |
| 25 | Playbook edited while 200 contacts enrolled | Old approved version keeps running. The new version runs only after approval, migrating at step boundaries |
| 26 | Approval revoked | Pause all enrollments + cancel queued messages in batches under per-contact locks |
| 27 | 10DLC campaign suspended | Sends `blocked SENDER_NOT_REGISTERED`, shown as failed sends in the TL queue, Admin alert, no fallback |
| 28 | Third party joins a recorded call | Re-announce |
| 29 | Recording deleted while a claim cites it | Evidence shows "source removed"; the claim stays |
| 30 | AI quotes something not in the transcript | `verifyQuote` fails, so `needs_review` |
| 31 | AI resolves "tomorrow" across midnight in a different tz | Resolved against the source timestamp in the contact zone, with both shown |
| 32 | Agent approves a draft at 11 PM | Gate defers (assistant-sent within the playbook) or `needs_confirmation`/deny (human). UI: "Sends 9:00 AM her time" |
| 33 | Agent tries to text an opted-out contact | Hard deny with explanation; no override |
| 34 | Contact texts START after STOP | Resubscribe restores the pre-STOP state only |
| 35 | Same phone is a contact in two tenants | Tenants are fully isolated. STOP in one has no effect in the other (separate senders, separate ledgers) |
| 36 | Email reply from an unknown address | Attached via reply token; suggested new contact point needs review |
| 37 | Inbound from an unknown number | New contact "Unknown +1 555…" as a lead (routing rules). `express` informational SMS basis for replying to them |
| 38 | Inbound to a released number | `inbound_routes` has no live row, so the message goes to `unrouted_webhooks` and raises a platform alert. It is never delivered to a former tenant |
| 39 | Brokerage name missing | Impossible (NOT NULL at onboarding). Rendered-body check still denies marketing without it |
| 40 | Assistant asked (by the client) about price or offer | The reply is the agent's job: the handback + draft, which is category `money`, so always a tap |
| 41 | Agent's own phone texts STOP to notification SMS | `recipient.kind='user'` ledger. Agent notifications fall back to push/email; the admin is told |
| 42 | Clock skew between app servers | All time comparisons use the DB transaction timestamp passed into core |
| 43 | Imported recording with unknown notice | Labelled. Transcription off by default |
| 44 | CSV phone "555-0100" without area code | Rejected with `PHONE_INVALID` and listed for review |
| 45 | FUB data changes between dry run and commit | Commit uses the snapshot. The delta requires a new snapshot and dry run |
| 46 | Import reversal after agents messaged imported contacts | Those contacts are listed as touched and not deleted. Their imported consent grants are compensated; their revocations stay |

---

## 12. Risks: bloat, leakage, compliance

### Compliance exposure
1. **Automated SMS to leads with weak consent** (lead-gen forms, imports). This is the main TCPA class-action vector. Mitigation: `express` minimum for automated informational and `express_written` for automated marketing, import cap at `imported_unverified`, disclosure text stored verbatim. Exact thresholds are VERIFY WITH COUNSEL, but the conservative defaults are in place.
2. **Quiet hours with unknown recipient location**. Mitigation: intersection-of-candidates rule. Residual risk: mobile numbers for people who moved.
3. **Recording consent across states**. Mitigation: announce-always default. The risk only reappears if an Owner opts into `one_party_where_permitted`, which is gated behind attestation and counsel-reviewed packs.
4. **AI identity/genuineness**. Mitigation: mandatory identity sign-off, human-claim guard, no AI voice in Phase 1. "Voice-matched" drafts must match *tone*, never claim to be the agent.
5. **Imported recordings and transcripts with unknown consent**. Mitigation: labelled, not transcribed by default. Consider not importing recordings at all unless the team asks (open question).
6. **DNC without a scrub vendor**. Mitigation: human calls with unknown status need confirmation and assistant marketing is denied. Residual risk: confirmation fatigue for agents. Recommend getting a scrub vendor decision before launch.
7. **Wire fraud**. Mitigation: payment-instruction hard deny on every outbound path.
8. **Fair housing**. Mitigation: `protected_proxy` attributes kept out of scoring by type. VA/PCS are self-reported only.
9. **Jurisdiction packs not counsel-reviewed at launch**. The UI says so honestly, and the defaults are conservative.

### Data leakage
1. Cross-tenant: composite FKs + FORCE RLS + per-tenant provider messaging services + tenant-prefixed, AAD-bound object storage + id-only job payloads. Residual: `inbound_routes` and `sessions` are global by necessity (no PII beyond address and token hash).
2. Intra-tenant: pond previews hide bodies and recordings. Restrictive RLS on recordings and transcripts. Commission fields hidden from ISA/TC.
3. AI provider: one-contact prompts, ids-only logging, encrypted outputs purged after 30 days. Data-retention terms with the AI vendor are VERIFY (contract).
4. Lock screens: minimal push bodies.
5. Search: transcripts not indexed. Any search index of sensitive text would be a plaintext copy of encrypted data, which is why it is excluded.

### Bloat (cut or defer from Phase 1)
- **Cut**: multi-turn autonomous qualification (single message + handoff instead); outbound MMS; voicemail drop, ringless voicemail, power dialer; per-contact preferred-hours UI; litigator-list integration; hash-chained audit; transcript full-text search; tenant-defined custom autonomy categories; contact tags beyond a simple text[] (if needed at all).
- **Defer DDL** (no Phase 1 writer): showings, showing_feedback, marketing_activity, deal_milestones, channel_accounts, client principals, AVM. Specified in §8.7 so Phase 2 slots in cleanly.
- **Keep small**: scoreboard and momentum as SQL views (no materialization until slow); exception queue as a derived cache plus append-only resolutions; jurisdiction packs as data, with no rule-builder UI (platform-maintained JSON, reviewed by counsel).
- **Watch**: `gate_decisions` volume (one row per send attempt plus deferrals). Fine for Phase 1. Partition monthly when it passes about 50M rows; retention per §1.

---

## 13. Open questions

1. Is `imported_unverified` SMS consent ever sufficient for assistant-sent nurture to migrated FUB contacts (perhaps with an Owner attestation)? If not, do we offer a one-time re-permission message, and is that message itself permitted (VERIFY WITH COUNSEL)? This decides how useful migrations are on day one.
2. National DNC scrub vendor for Phase 1: integrate one, or rely on Admin uploads of scrub results?
3. Does the 60-second response go out during quiet hours for an inquiry submitted seconds earlier (many argue a reply to a fresh request isn't a solicitation)? Default is to defer the SMS (VERIFY WITH COUNSEL).
4. Can Team Leads approve team-scoped playbooks, or only Owner/Admin?
5. Should human free-form texts be classified marketing vs informational by the 30-day-inbound heuristic, or should agents get a one-tap "this is about their transaction" toggle in deal context?
6. Recording retention default (24 months) vs state license-law record retention for transaction-related calls (VERIFY WITH COUNSEL).
7. Should imported FUB call recordings be imported at all by default?
8. Should RESTRICTIVE intra-tenant RLS extend to `messages` and `notes`, or stay app-enforced (performance vs defense in depth)?
9. Should the provider's managed opt-out handling (confirmation, carrier-side list) be the default, given we must mirror it in our ledger anyway?
10. Should handbacks that stay unhandled past an SLA become an A5 exception type, or stay in the Priority Feed with rising urgency (current design)?
11. Should `showings`/`showing_feedback` be promoted into Phase 1 so agents can log them for the future seller update?
12. Is the tenant always a single team in Phase 1, with multi-team brokerages in Phase 3?
13. Do we need STIR/SHAKEN attestation visibility or branded caller ID in Phase 1 (answer rates)?

---

## Appendix A — Critical DDL (verified on PostgreSQL 16.15)

Applied with `psql -v ON_ERROR_STOP=1` to a throwaway database as the owner role. Tests ran as a NOSUPERUSER NOBYPASSRLS role equivalent to `app_user`; both the database and the role were dropped afterwards. In the real repo this splits into `packages/db/migrations/0001_app_helpers.sql`, `0002_tenancy.sql`, `0003_contacts.sql`, `0004_compliance.sql`, `0005_numbers.sql`, `0006_comms.sql`, `0007_playbooks.sql`, `0008_assistant.sql`, `0009_imports.sql`, `0010_audit.sql`. Tables in §8 that are not shown here follow the same conventions.

```sql
-- =====================================================================
-- Comms-compliance critical DDL (draft). Verified on PostgreSQL 16.
-- Conventions: uuid ids generated by the app (UUIDv7, injected id gen),
-- text + CHECK instead of ENUM types, timestamptz everywhere,
-- composite (tenant_id, x_id) FKs so a row can never point across tenants.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS app;

-- ---------- session context helpers (fail closed: unset => NULL => no rows)
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- 'staff' | 'client' (client principals: Phase 3 portal). NULL when unset.
CREATE FUNCTION app.principal_type() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.principal_type', true), '') $$;

-- ---------- generic append-only guard
CREATE FUNCTION app.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN
  RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$;

-- ---------- one call per tenant-scoped table, used by every migration
CREATE FUNCTION app.apply_tenant_rls(t regclass) RETURNS void
  LANGUAGE plpgsql AS
$$ BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format($p$CREATE POLICY staff_tenant_isolation ON %s
      USING (tenant_id = app.current_tenant_id() AND app.principal_type() = 'staff')
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.principal_type() = 'staff')$p$, t);
END $$;

CREATE FUNCTION app.make_append_only(t regclass) RETURNS void
  LANGUAGE plpgsql AS
$$ BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s
                  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()',
                 'append_only_row', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s
                  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()',
                 'append_only_truncate', t);
END $$;

-- =====================================================================
-- Tenancy skeleton (only what the comms tables reference)
-- =====================================================================
CREATE TABLE tenants (
  id                   uuid PRIMARY KEY,
  slug                 text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','closing')),
  created_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app.current_tenant_id() AND app.principal_type() = 'staff');

CREATE TABLE tenant_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id),
  brokerage_legal_name   text NOT NULL CHECK (length(btrim(brokerage_legal_name)) > 0),
  team_name              text,
  brokerage_postal_address text,          -- required before marketing email (R-EML-3)
  default_timezone       text NOT NULL,    -- IANA, e.g. 'America/New_York'
  operating_jurisdictions text[] NOT NULL DEFAULT '{}',  -- e.g. {US-SC,US-NC}
  active_policy_version_id uuid,           -- compliance_policy_versions.id
  version                int  NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
SELECT app.apply_tenant_rls('tenant_settings');

-- Versioned, immutable snapshot of the tenant's compliance policy
-- (quiet hours, caps, autonomy switches, recording mode). Gate decisions
-- reference the version they were evaluated under.
CREATE TABLE compliance_policy_versions (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  version_no         int  NOT NULL,
  policy             jsonb NOT NULL,        -- validated by packages/core Zod schema
  jurisdiction_pack_versions jsonb NOT NULL, -- {"US-SC":"2026.10.1", ...}
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version_no),
  UNIQUE (tenant_id, id)
);
SELECT app.apply_tenant_rls('compliance_policy_versions');
SELECT app.make_append_only('compliance_policy_versions');

CREATE TABLE users (                        -- global identity (login)
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  role          text NOT NULL CHECK (role IN
                  ('owner','admin','team_lead','agent','isa','transaction_coordinator')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  home_jurisdiction text,                    -- agent's state, for recording rules
  mobile_e164   text,                        -- agent's own phone for bridging/notifications
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
SELECT app.apply_tenant_rls('tenant_memberships');

CREATE TABLE contacts (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  display_name     text NOT NULL,
  owner_user_id    uuid,
  timezone         text,                     -- explicit IANA tz if known
  original_source_id uuid,                   -- first-touch attribution (immutable)
  merged_into_contact_id uuid,
  import_batch_id  uuid,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  search_tsv       tsvector GENERATED ALWAYS AS
                     (to_tsvector('simple', coalesce(display_name, ''))) STORED,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_memberships(tenant_id, user_id)
);
SELECT app.apply_tenant_rls('contacts');
CREATE INDEX contacts_name_trgm ON contacts USING gin (display_name gin_trgm_ops);
CREATE INDEX contacts_tsv ON contacts USING gin (search_tsv);
CREATE INDEX contacts_owner ON contacts (tenant_id, owner_user_id) WHERE deleted_at IS NULL;

-- ISA / TC / co-agent access to a contact they do not own
CREATE TABLE contact_collaborators (
  tenant_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('isa','transaction_coordinator','co_agent')),
  added_by_user_id uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, user_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id)
);
SELECT app.apply_tenant_rls('contact_collaborators');

-- Intra-tenant visibility used by RESTRICTIVE policies on the most sensitive
-- tables (recordings, transcripts). app.role is set server-side from the
-- membership row, never from client input.
CREATE FUNCTION app.can_view_contact(cid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.role', true), '') IN ('owner','admin','team_lead')
       OR EXISTS (SELECT 1 FROM contacts c
                   WHERE c.id = cid AND c.owner_user_id = app.current_user_id())
       OR EXISTS (SELECT 1 FROM contact_collaborators k
                   WHERE k.contact_id = cid AND k.user_id = app.current_user_id()) $$;

-- =====================================================================
-- Contact points: consent and opt-out attach to the ADDRESS, not the person
-- =====================================================================
CREATE TABLE contact_points (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  contact_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('phone','email')),
  address         text NOT NULL,             -- E.164 for phone, lower-case for email
  label           text NOT NULL DEFAULT 'other'
                  CHECK (label IN ('mobile','home','work','other')),
  line_type       text NOT NULL DEFAULT 'unknown'
                  CHECK (line_type IN ('mobile','landline','voip','toll_free','unknown')),
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','invalid','wrong_number','bouncing')),
  is_primary      boolean NOT NULL DEFAULT false,
  timezone        text,                       -- explicit, overrides inference
  import_batch_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  CHECK (kind <> 'phone' OR address ~ '^\+[1-9][0-9]{6,14}$'),
  CHECK (kind <> 'email' OR (address = lower(address) AND position('@' in address) > 1)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contact_id, kind, address),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id)
);
SELECT app.apply_tenant_rls('contact_points');
-- inbound matching: the same address may belong to several contacts (shared landline)
CREATE INDEX contact_points_address ON contact_points (tenant_id, kind, address)
  WHERE removed_at IS NULL;

-- Exact disclosure text a person saw when consenting (hash-addressed, immutable)
CREATE TABLE consent_disclosures (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  channel_scope text[] NOT NULL,             -- {'sms','voice'}
  purpose_scope text[] NOT NULL,             -- {'marketing','informational'}
  body          text NOT NULL,
  body_sha256   text NOT NULL,
  names_seller  text NOT NULL,               -- entity named in the text (brokerage/team)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, body_sha256),
  UNIQUE (tenant_id, id)
);
SELECT app.apply_tenant_rls('consent_disclosures');
SELECT app.make_append_only('consent_disclosures');

-- Append-only consent ledger. Projection lives in consent_state.
CREATE TABLE consent_events (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  address_kind       text NOT NULL CHECK (address_kind IN ('phone','email')),
  address            text NOT NULL,
  channel            text NOT NULL CHECK (channel IN ('sms','voice','email')),
  purpose            text NOT NULL CHECK (purpose IN ('marketing','informational','all')),
  event_type         text NOT NULL CHECK (event_type IN
                       ('grant','revoke','resubscribe','expire','import_revert')),
  consent_level      text NOT NULL CHECK (consent_level IN
                       ('none','imported_unverified','inquiry','express','express_written')),
  source             text NOT NULL CHECK (source IN
                       ('web_form','lead_provider','inbound_keyword','inbound_language',
                        'verbal_on_call','agent_entry','signed_document','provider_report',
                        'import_fub','import_csv','system_expiry')),
  occurred_at        timestamptz NOT NULL,  -- when the person acted (may precede recorded_at)
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  contact_id         uuid,                  -- context only; the key is the address
  recorded_by_user_id uuid,
  disclosure_id      uuid,
  evidence_document_id uuid,
  evidence_message_id  uuid,
  evidence_call_id     uuid,
  evidence_call_offset_ms int,
  evidence           jsonb NOT NULL DEFAULT '{}',  -- form url, ip, user agent, keyword text
  imported           boolean NOT NULL DEFAULT false,
  import_record_id   uuid,
  original_provenance jsonb,                -- verbatim source fields for imported rows
  expires_at         timestamptz,           -- e.g. inquiry basis window (jurisdiction pack)
  needs_review       boolean NOT NULL DEFAULT false, -- e.g. language-detected opt-out
  CHECK (address_kind <> 'phone' OR channel IN ('sms','voice')),
  CHECK (address_kind <> 'email' OR channel = 'email'),
  -- R-CON-2: imports never create a grant stronger than imported_unverified
  CHECK (NOT imported OR event_type <> 'grant' OR consent_level = 'imported_unverified'),
  CHECK (NOT imported OR import_record_id IS NOT NULL),
  -- R-CON-3: express written consent needs the disclosure text or a signed document
  CHECK (consent_level <> 'express_written'
         OR disclosure_id IS NOT NULL OR evidence_document_id IS NOT NULL),
  -- R-CON-4: verbal consent must point into a call
  CHECK (source <> 'verbal_on_call' OR evidence_call_id IS NOT NULL),
  -- revocations carry no level
  CHECK (event_type NOT IN ('revoke','expire') OR consent_level = 'none'),
  FOREIGN KEY (tenant_id, disclosure_id) REFERENCES consent_disclosures(tenant_id, id)
);
SELECT app.apply_tenant_rls('consent_events');
SELECT app.make_append_only('consent_events');
CREATE INDEX consent_events_key ON consent_events
  (tenant_id, address_kind, address, channel, occurred_at);

-- Projection, recomputable from consent_events by core.projectConsent()
CREATE TABLE consent_state (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  address_kind     text NOT NULL,
  address          text NOT NULL,
  channel          text NOT NULL,
  purpose          text NOT NULL CHECK (purpose IN ('marketing','informational')),
  status           text NOT NULL CHECK (status IN ('granted','revoked','none')),
  consent_level    text NOT NULL,
  basis_event_id   uuid,                     -- the grant/revoke that decided status
  expires_at       timestamptz,
  ledger_event_count int NOT NULL,           -- staleness check vs ledger
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, address_kind, address, channel, purpose)
);
SELECT app.apply_tenant_rls('consent_state');

-- Non-consent blocks: deliverability, DNC, admin. "What the world says."
CREATE TABLE suppressions (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  address_kind    text NOT NULL CHECK (address_kind IN ('phone','email')),
  address         text,                      -- NULL once contact erased (hash kept)
  address_hash    text NOT NULL,             -- HMAC-SHA256(tenant pepper, address)
  channel         text NOT NULL CHECK (channel IN ('sms','voice','email','all')),
  reason          text NOT NULL CHECK (reason IN
                    ('hard_bounce','spam_complaint','undeliverable','landline_no_sms',
                     'internal_dnc','admin_block','wrong_number','provider_opt_out_mirror')),
  source_ref      jsonb NOT NULL DEFAULT '{}',
  created_by_user_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  lifted_at       timestamptz,
  lifted_by_user_id uuid,
  lift_reason     text,
  CHECK ((lifted_at IS NULL) = (lift_reason IS NULL))
);
SELECT app.apply_tenant_rls('suppressions');
CREATE UNIQUE INDEX suppressions_active ON suppressions
  (tenant_id, address_kind, address_hash, channel, reason) WHERE lifted_at IS NULL;

CREATE TABLE dnc_checks (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  phone         text NOT NULL,
  registry      text NOT NULL,               -- 'us_national' | 'us_state:XX' (pack-defined)
  listed        boolean NOT NULL,
  checked_at    timestamptz NOT NULL,
  valid_until   timestamptz NOT NULL,        -- checked_at + pack.scrubValidityDays
  provider      text NOT NULL,               -- 'fake' | 'manual_upload' | vendor
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT app.apply_tenant_rls('dnc_checks');
SELECT app.make_append_only('dnc_checks');
CREATE INDEX dnc_checks_latest ON dnc_checks (tenant_id, phone, registry, checked_at DESC);

-- =====================================================================
-- Numbers and sender registration
-- =====================================================================
CREATE TABLE a2p_campaigns (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  provider         text NOT NULL,
  provider_brand_ref    text,
  provider_campaign_ref text,
  use_case         text NOT NULL,            -- as registered with the provider
  sample_messages  jsonb NOT NULL DEFAULT '[]',
  opt_in_description text NOT NULL,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','approved','rejected','suspended')),
  status_detail    text,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
SELECT app.apply_tenant_rls('a2p_campaigns');

CREATE TABLE phone_numbers (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  e164             text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  provider         text NOT NULL,
  provider_ref     text NOT NULL,
  number_type      text NOT NULL CHECK (number_type IN ('local','toll_free')),
  purpose          text NOT NULL CHECK (purpose IN ('team_main','agent_direct','pond','tracking')),
  assigned_user_id uuid,
  sms_capable      boolean NOT NULL,
  voice_capable    boolean NOT NULL,
  a2p_campaign_id  uuid,                     -- local numbers: 10DLC campaign
  toll_free_verification text NOT NULL DEFAULT 'not_applicable'
                   CHECK (toll_free_verification IN
                     ('not_applicable','pending','verified','rejected')),
  inbound_route    text NOT NULL DEFAULT 'contact_owner'
                   CHECK (inbound_route IN ('contact_owner','assigned_user','team_ring','pond')),
  released_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (purpose <> 'agent_direct' OR assigned_user_id IS NOT NULL),
  CHECK (number_type = 'toll_free' OR toll_free_verification = 'not_applicable'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, a2p_campaign_id) REFERENCES a2p_campaigns(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES tenant_memberships(tenant_id, user_id)
);
SELECT app.apply_tenant_rls('phone_numbers');
CREATE UNIQUE INDEX phone_numbers_live ON phone_numbers (tenant_id, e164) WHERE released_at IS NULL;

-- GLOBAL routing table (no PII): which tenant owns an inbound "To" address.
-- Not tenant-scoped; app_user may SELECT only. Written by platform provisioning.
CREATE TABLE inbound_routes (
  address_kind  text NOT NULL CHECK (address_kind IN ('phone','email_token')),
  address       text NOT NULL,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  active_from   timestamptz NOT NULL DEFAULT now(),
  active_until  timestamptz
);
CREATE UNIQUE INDEX inbound_routes_live ON inbound_routes (address_kind, address)
  WHERE active_until IS NULL;

-- =====================================================================
-- Conversations, messages, calls, recordings, transcripts
-- =====================================================================
CREATE TABLE conversations (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  contact_id         uuid NOT NULL,
  sticky_phone_number_id uuid,               -- sender affinity for SMS/voice
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  inbound_seq        bigint NOT NULL DEFAULT 0, -- bumps on every inbound; drafts pin it
  automation_paused_at timestamptz,
  automation_pause_reason text CHECK (automation_pause_reason IN
                       ('client_reply','opt_out','owner_change','manual','approval_revoked')),
  automation_paused_by_message_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contact_id),            -- one thread per person
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, sticky_phone_number_id) REFERENCES phone_numbers(tenant_id, id)
);
SELECT app.apply_tenant_rls('conversations');

CREATE TABLE gate_decisions (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  contact_id       uuid,
  recipient_kind   text NOT NULL DEFAULT 'contact' CHECK (recipient_kind IN ('contact','user')),
  address          text NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('sms','voice','email')),
  purpose          text NOT NULL CHECK (purpose IN ('marketing','informational')),
  initiator        text NOT NULL CHECK (initiator IN ('human','assistant','system')),
  action_category  text NOT NULL,
  phase            text NOT NULL CHECK (phase IN ('preview','send','confirm')),
  outcome          text NOT NULL CHECK (outcome IN ('allow','deny','defer','needs_confirmation')),
  reason_codes     text[] NOT NULL DEFAULT '{}',
  defer_until      timestamptz,
  confirmed_by_user_id uuid,                 -- phase='confirm' only
  policy_version_id uuid NOT NULL,
  core_rules_version text NOT NULL,          -- packages/core semver of canContact
  inputs           jsonb NOT NULL,           -- facts used (ids, tz, local time, counts)
  inputs_sha256    text NOT NULL,
  evaluated_at     timestamptz NOT NULL,
  CHECK (outcome <> 'defer' OR defer_until IS NOT NULL),
  CHECK (outcome = 'allow' OR cardinality(reason_codes) > 0),
  CHECK (phase <> 'confirm' OR confirmed_by_user_id IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_version_id) REFERENCES compliance_policy_versions(tenant_id, id)
);
SELECT app.apply_tenant_rls('gate_decisions');
SELECT app.make_append_only('gate_decisions');
CREATE INDEX gate_decisions_contact ON gate_decisions (tenant_id, contact_id, evaluated_at DESC);

CREATE TABLE messages (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  conversation_id    uuid NOT NULL,
  contact_id         uuid NOT NULL,
  channel            text NOT NULL CHECK (channel IN ('sms','mms','email')),  -- widen by migration
  direction          text NOT NULL CHECK (direction IN ('inbound','outbound')),
  phone_number_id    uuid,                   -- our side for sms/mms
  email_identity_id  uuid,                   -- our side for email
  from_address       text NOT NULL,
  to_address         text NOT NULL,
  subject            text,
  body               text NOT NULL,
  status             text NOT NULL CHECK (status IN
                       ('received','draft','pending_approval','scheduled','queued','dispatching',
                        'sent','delivered','failed','undelivered','bounced','blocked',
                        'canceled','dispatch_unknown')),
  status_reason      text,
  initiator          text NOT NULL CHECK (initiator IN ('human','assistant','system','client','import')),
  initiated_by_user_id uuid,
  purpose            text CHECK (purpose IN ('marketing','informational')),
  action_category    text,
  assistant_action_id uuid,
  playbook_step_run_id uuid,
  gate_decision_id   uuid,
  pinned_inbound_seq bigint,                 -- conversation.inbound_seq when drafted/approved
  scheduled_for      timestamptz,
  dispatched_at      timestamptz,
  provider           text,
  provider_message_ref text,
  provider_error_code text,
  is_auto_reply      boolean NOT NULL DEFAULT false,  -- OOO / carrier auto-response (inbound)
  opt_out_keyword    text,                   -- inbound matched keyword, if any
  imported           boolean NOT NULL DEFAULT false,
  import_record_id   uuid,
  occurred_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  search_tsv         tsvector GENERATED ALWAYS AS
                       (to_tsvector('simple', coalesce(subject,'') || ' ' || body)) STORED,
  CHECK (direction = 'outbound' OR initiator IN ('client','import')),
  CHECK (direction = 'inbound' OR initiator <> 'client'),
  CHECK (direction = 'outbound' OR status = 'received'),
  -- R-GATE-1: nothing leaves without a send-time gate decision
  CHECK (direction = 'inbound' OR imported
         OR status IN ('draft','pending_approval','scheduled','queued','canceled')
         OR gate_decision_id IS NOT NULL),
  CHECK (direction = 'inbound' OR imported OR purpose IS NOT NULL),
  CHECK (NOT imported OR import_record_id IS NOT NULL),
  CHECK (initiator <> 'assistant' OR assistant_action_id IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, gate_decision_id) REFERENCES gate_decisions(tenant_id, id)
);
SELECT app.apply_tenant_rls('messages');
CREATE UNIQUE INDEX messages_provider_ref ON messages (tenant_id, provider, provider_message_ref)
  WHERE provider_message_ref IS NOT NULL;
CREATE INDEX messages_thread ON messages (tenant_id, conversation_id, occurred_at DESC);
CREATE INDEX messages_due ON messages (tenant_id, scheduled_for)
  WHERE status IN ('scheduled','queued');
CREATE INDEX messages_failed ON messages (tenant_id, occurred_at DESC)
  WHERE status IN ('failed','undelivered','bounced','blocked','dispatch_unknown');
CREATE INDEX messages_caps ON messages (tenant_id, to_address, channel, dispatched_at)
  WHERE direction = 'outbound' AND initiator IN ('assistant','system');
CREATE INDEX messages_tsv ON messages USING gin (search_tsv);

CREATE TABLE message_status_events (       -- raw provider callbacks, out-of-order safe
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  message_id    uuid NOT NULL,
  provider_status text NOT NULL,
  mapped_status text NOT NULL,
  error_code    text,
  provider_event_ref text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_event_ref),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
);
SELECT app.apply_tenant_rls('message_status_events');
SELECT app.make_append_only('message_status_events');

CREATE TABLE calls (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  conversation_id    uuid NOT NULL,
  contact_id         uuid NOT NULL,
  direction          text NOT NULL CHECK (direction IN ('inbound','outbound')),
  phone_number_id    uuid,
  agent_user_id      uuid,
  client_address     text NOT NULL,
  initiator          text NOT NULL CHECK (initiator IN ('human','client','import')),
                     -- 'assistant_voice' deliberately absent until Phase 3 (R-VOICE-1)
  handled_by         text NOT NULL DEFAULT 'human' CHECK (handled_by IN ('human','voicemail')),
  status             text NOT NULL CHECK (status IN
                       ('initiated','ringing','in_progress','completed','no_answer',
                        'busy','failed','canceled','voicemail')),
  started_at         timestamptz NOT NULL,
  answered_at        timestamptz,
  ended_at           timestamptz,
  duration_s         int,
  recording_mode     text NOT NULL CHECK (recording_mode IN
                       ('off','announced_all_parties','one_party_no_announcement')),
  recording_announced_at timestamptz,
  recording_decision jsonb NOT NULL,         -- jurisdictions considered + rule version
  gate_decision_id   uuid,                   -- outbound only
  parent_call_id     uuid,                   -- transfer / conference legs
  outcome            text CHECK (outcome IN
                       ('connected','left_voicemail','no_answer','wrong_number',
                        'bad_number','do_not_call_request','callback_requested')),
  outcome_logged_by_user_id uuid,
  outcome_logged_at  timestamptz,
  provider_call_ref  text,
  imported           boolean NOT NULL DEFAULT false,
  import_record_id   uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (direction = 'inbound' OR imported OR gate_decision_id IS NOT NULL),
  CHECK (recording_mode <> 'announced_all_parties' OR imported OR status <> 'completed'
         OR answered_at IS NULL OR recording_announced_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, gate_decision_id) REFERENCES gate_decisions(tenant_id, id)
);
SELECT app.apply_tenant_rls('calls');
CREATE UNIQUE INDEX calls_provider_ref ON calls (tenant_id, provider_call_ref)
  WHERE provider_call_ref IS NOT NULL;
CREATE INDEX calls_contact ON calls (tenant_id, contact_id, started_at DESC);

CREATE TABLE recordings (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  call_id         uuid NOT NULL,
  contact_id      uuid NOT NULL,             -- denormalized for the restrictive policy
  storage_key     text NOT NULL,             -- tenants/{tenant_id}/recordings/{id}
  dek_wrapped     bytea NOT NULL,            -- AES-256-GCM DEK wrapped by tenant KEK
  sha256          text NOT NULL,
  duration_s      int NOT NULL,
  source          text NOT NULL CHECK (source IN ('provider','import_fub')),
  consent_basis   text NOT NULL CHECK (consent_basis IN
                    ('announced_all_parties','one_party_policy','unknown_imported')),
  status          text NOT NULL DEFAULT 'stored'
                  CHECK (status IN ('stored','shredded')),
  retain_until    timestamptz NOT NULL,
  legal_hold      boolean NOT NULL DEFAULT false,
  provider_copy_deleted_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  shredded_at     timestamptz,
  CHECK ((status = 'shredded') = (shredded_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES calls(tenant_id, id)
);
SELECT app.apply_tenant_rls('recordings');
CREATE POLICY recordings_visibility ON recordings AS RESTRICTIVE
  USING (app.can_view_contact(contact_id));

CREATE TABLE transcripts (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  recording_id    uuid NOT NULL,
  contact_id      uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','ready','failed','shredded')),
  language        text,
  segments_enc    bytea,                     -- AES-GCM; JSON [{start_ms,end_ms,speaker,text}]
  provider        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR segments_enc IS NOT NULL),
  UNIQUE (tenant_id, recording_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, recording_id) REFERENCES recordings(tenant_id, id)
);
SELECT app.apply_tenant_rls('transcripts');
CREATE POLICY transcripts_visibility ON transcripts AS RESTRICTIVE
  USING (app.can_view_contact(contact_id));

-- =====================================================================
-- Playbooks (A3): versioned approval, send-time recheck, pause on reply
-- =====================================================================
CREATE TABLE playbooks (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN
                    ('new_lead_response','nurture','post_closing','booking_confirmation',
                     'reminder','document_chase')),
  scope           text NOT NULL CHECK (scope IN ('team','agent')),
  owner_user_id   uuid,                      -- scope='agent'
  name            text NOT NULL,
  template_key    text,                      -- built-in template it derives from
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'agent') = (owner_user_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_memberships(tenant_id, user_id)
);
SELECT app.apply_tenant_rls('playbooks');

CREATE TABLE playbook_versions (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  playbook_id     uuid NOT NULL,
  version_no      int NOT NULL,
  steps           jsonb NOT NULL,            -- core PlaybookStep[] (Zod-validated)
  tone            jsonb NOT NULL DEFAULT '{}',
  content_sha256  text NOT NULL,             -- hash of canonical(steps, tone)
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','approved','superseded','revoked')),
  created_by_user_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, playbook_id, version_no),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, playbook_id) REFERENCES playbooks(tenant_id, id)
);
SELECT app.apply_tenant_rls('playbook_versions');
CREATE UNIQUE INDEX playbook_one_approved ON playbook_versions (tenant_id, playbook_id)
  WHERE status = 'approved';

-- content of a non-draft version is frozen (R-PB-2)
CREATE FUNCTION app.playbook_version_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.steps IS DISTINCT FROM OLD.steps
       OR NEW.tone IS DISTINCT FROM OLD.tone
       OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256) THEN
    RAISE EXCEPTION 'playbook version % is frozen; create a new version', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('superseded','revoked') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'playbook version % is terminal', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER playbook_version_freeze BEFORE UPDATE ON playbook_versions
  FOR EACH ROW EXECUTE FUNCTION app.playbook_version_freeze();

CREATE TABLE playbook_approvals (           -- append-only; revocation is its own row
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  playbook_version_id uuid NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('approve','revoke')),
  decided_by_user_id uuid NOT NULL,
  decided_by_role  text NOT NULL,
  content_sha256   text NOT NULL,            -- must equal version's hash at approval time
  attestation      text NOT NULL,            -- the sentence the approver tapped
  decided_at       timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, playbook_version_id) REFERENCES playbook_versions(tenant_id, id)
);
SELECT app.apply_tenant_rls('playbook_approvals');
SELECT app.make_append_only('playbook_approvals');

CREATE TABLE playbook_enrollments (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  playbook_id      uuid NOT NULL,
  playbook_version_id uuid NOT NULL,
  contact_id       uuid NOT NULL,
  enrolled_by      text NOT NULL CHECK (enrolled_by IN ('user','new_lead','deal_closed')),
  enrolled_by_user_id uuid,
  state            text NOT NULL CHECK (state IN
                     ('active','paused','completed','stopped')),
  pause_reason     text CHECK (pause_reason IN
                     ('client_reply','opt_out','owner_change','manual','approval_revoked',
                      'ineligible')),
  stop_reason      text,
  current_step     int NOT NULL DEFAULT 0,
  next_step_due_at timestamptz,
  paused_at        timestamptz,
  paused_by_message_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  CHECK ((state = 'paused') = (pause_reason IS NOT NULL)),
  CHECK (state NOT IN ('completed','stopped') OR ended_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, playbook_version_id) REFERENCES playbook_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, id)
);
SELECT app.apply_tenant_rls('playbook_enrollments');
-- R-PB-6: at most one live enrollment per contact (no double-dripping)
CREATE UNIQUE INDEX enrollment_one_live ON playbook_enrollments (tenant_id, contact_id)
  WHERE state IN ('active','paused');
CREATE INDEX enrollment_due ON playbook_enrollments (next_step_due_at) WHERE state = 'active';

CREATE TABLE playbook_step_runs (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  enrollment_id    uuid NOT NULL,
  playbook_version_id uuid NOT NULL,
  step_key         text NOT NULL,
  status           text NOT NULL CHECK (status IN
                     ('scheduled','sent','deferred','converted_to_draft','skipped_ineligible',
                      'canceled_paused','failed')),
  scheduled_for    timestamptz NOT NULL,
  deferrals        int NOT NULL DEFAULT 0,
  last_gate_decision_id uuid,
  message_id       uuid,
  assistant_action_id uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, enrollment_id, step_key),
  FOREIGN KEY (tenant_id, enrollment_id) REFERENCES playbook_enrollments(tenant_id, id)
);
SELECT app.apply_tenant_rls('playbook_step_runs');

-- =====================================================================
-- Assistant outputs with evidence (A2)
-- =====================================================================
CREATE TABLE assistant_actions (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  contact_id       uuid,
  kind             text NOT NULL CHECK (kind IN
                     ('message_draft','autonomous_message','call_summary','handback',
                      'promise_extraction','saved_search_proposal','next_step',
                      'lead_summary','seller_update_draft')),
  action_category  text NOT NULL CHECK (action_category IN
                     ('speed_to_lead_reply','reminder','booking_confirmation','document_chase',
                      'nurture_step','search_alert','money','contract','novel_message',
                      'seller_update','internal')),
  autonomy         text NOT NULL CHECK (autonomy IN ('requires_approval','within_playbook','internal')),
  playbook_version_id uuid,
  status           text NOT NULL CHECK (status IN
                     ('proposed','approved','rejected','executed','blocked','expired','superseded')),
  owner_user_id    uuid,                     -- who must act on it
  explanation      text NOT NULL,            -- short "why", shown verbatim
  payload          jsonb NOT NULL,           -- draft body, criteria, etc.
  edited_payload   jsonb,
  pinned_inbound_seq bigint,
  decided_by_user_id uuid,
  decided_at       timestamptz,
  ai_run_id        uuid,
  trigger_ref      jsonb NOT NULL DEFAULT '{}',  -- {type:'message', id:...}
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- R-AUTO-2: these categories can never be autonomous
  CHECK (NOT (autonomy = 'within_playbook'
              AND action_category IN ('money','contract','novel_message','seller_update'))),
  CHECK (autonomy <> 'within_playbook' OR playbook_version_id IS NOT NULL),
  UNIQUE (tenant_id, id)
);
SELECT app.apply_tenant_rls('assistant_actions');
CREATE INDEX assistant_actions_inbox ON assistant_actions (tenant_id, owner_user_id, created_at DESC)
  WHERE status = 'proposed';

CREATE TABLE assistant_claims (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  action_id        uuid NOT NULL,
  ordinal          int NOT NULL,
  claim_kind       text NOT NULL CHECK (claim_kind IN
                     ('commitment','preference','date_time','fact','qualification',
                      'client_statement','sent_summary','suggestion')),
  text             text NOT NULL,            -- "Callback due Thursday at 4 PM"
  structured       jsonb,                    -- {"criterion":"max_price","value":450000}
  needs_review     boolean NOT NULL,
  review_status    text NOT NULL DEFAULT 'unreviewed'
                   CHECK (review_status IN ('unreviewed','confirmed','corrected','rejected')),
  reviewed_by_user_id uuid,
  reviewed_at      timestamptz,
  UNIQUE (tenant_id, action_id, ordinal),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, action_id) REFERENCES assistant_actions(tenant_id, id)
);
SELECT app.apply_tenant_rls('assistant_claims');

CREATE TABLE evidence_refs (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  claim_id         uuid NOT NULL,
  source_type      text NOT NULL CHECK (source_type IN
                     ('call','message','email','note','listing','import','behavior_event',
                      'deal','task','appointment')),
  source_id        uuid NOT NULL,
  locator          jsonb NOT NULL,           -- {"kind":"transcript_offset","start_ms":134000,"end_ms":139500}
  snippet_enc      bytea,                    -- encrypted when source is a call transcript
  snippet          text,                     -- plaintext when source is plaintext (sms, note)
  verbatim_verified boolean NOT NULL,        -- core.verifyQuote() matched source text
  source_available boolean NOT NULL DEFAULT true,  -- false after retention shred
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (snippet IS NULL OR snippet_enc IS NULL),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES assistant_claims(tenant_id, id)
);
SELECT app.apply_tenant_rls('evidence_refs');
CREATE INDEX evidence_by_source ON evidence_refs (tenant_id, source_type, source_id);

-- R-EVID-1: a claim not flagged needs_review must have >=1 verified evidence ref
-- (checked at COMMIT so claim + refs can be inserted in any order)
CREATE FUNCTION app.check_claim_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  SELECT id, needs_review INTO c FROM assistant_claims WHERE id = NEW.id;
  IF c.id IS NOT NULL AND NOT c.needs_review AND NOT EXISTS (
       SELECT 1 FROM evidence_refs e WHERE e.claim_id = c.id AND e.verbatim_verified) THEN
    RAISE EXCEPTION 'claim % asserted without verified evidence (set needs_review)', c.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER claim_evidence_required
  AFTER INSERT OR UPDATE ON assistant_claims DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_claim_evidence();

-- =====================================================================
-- Imports (A6): batches -> per-category stages -> per-record outcomes
-- =====================================================================
CREATE TABLE import_batches (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  source           text NOT NULL CHECK (source IN ('csv','fub_api','fub_export')),
  status           text NOT NULL CHECK (status IN
                     ('connection_test','snapshotting','dry_run_ready','committing',
                      'committed','partially_committed','reverting','reverted','abandoned')),
  source_snapshot_sha256 text,
  source_snapshot_at timestamptz,
  credential_id    uuid,                     -- encrypted provider credential (FUB API key)
  credential_purge_after timestamptz,
  created_by_user_id uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
SELECT app.apply_tenant_rls('import_batches');

CREATE TABLE import_stages (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  batch_id         uuid NOT NULL,
  category         text NOT NULL CHECK (category IN
                     ('contacts','ownership','notes','messages','call_recordings','consent')),
  seq              int NOT NULL,             -- dependency order
  status           text NOT NULL CHECK (status IN
                     ('pending','dry_run_running','dry_run_ready','approved','committing',
                      'committed','verified','reverting','reverted','failed')),
  count_source       int,
  count_will_import  int,                    -- dry-run prediction
  count_imported     int,
  count_needs_review int,
  count_rejected     int,
  count_duplicate    int,
  dry_run_completed_at timestamptz,
  approved_by_user_id uuid,
  approved_at      timestamptz,
  committed_at     timestamptz,
  verified_by_user_id uuid,
  verified_at      timestamptz,
  verification     jsonb,                    -- post-commit recount: source vs db
  UNIQUE (tenant_id, batch_id, category),
  UNIQUE (tenant_id, id),
  CHECK (status NOT IN ('committing','committed','verified')
         OR (approved_at IS NOT NULL AND dry_run_completed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES import_batches(tenant_id, id)
);
SELECT app.apply_tenant_rls('import_stages');

CREATE TABLE import_records (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  stage_id         uuid NOT NULL,
  source_ref       text NOT NULL,            -- FUB id or "file.csv#row=42"
  raw_enc          bytea NOT NULL,           -- original record, encrypted, purged after N days
  normalized       jsonb,
  outcome          text NOT NULL CHECK (outcome IN
                     ('will_import','imported','needs_review','rejected','duplicate',
                      'merged','reverted','skipped')),
  issues           jsonb NOT NULL DEFAULT '[]',   -- [{code,field,message}]
  match_contact_id uuid,
  target_table     text,
  target_id        uuid,
  reviewed_by_user_id uuid,
  review_decision  text CHECK (review_decision IN ('import','merge','reject')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, stage_id, source_ref),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES import_stages(tenant_id, id)
);
SELECT app.apply_tenant_rls('import_records');
CREATE INDEX import_records_review ON import_records (tenant_id, stage_id)
  WHERE outcome IN ('needs_review','rejected');

-- =====================================================================
-- Audit log: append-only
-- =====================================================================
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL CHECK (actor_type IN ('user','assistant','system','provider','import')),
  actor_user_id uuid,
  action        text NOT NULL,              -- 'consent.revoked', 'recording.played', ...
  subject_type  text NOT NULL,
  subject_id    uuid,
  request_id    text,
  ip            inet,
  details       jsonb NOT NULL DEFAULT '{}' -- references only, never message bodies
);
SELECT app.apply_tenant_rls('audit_log');
SELECT app.make_append_only('audit_log');
CREATE INDEX audit_subject ON audit_log (tenant_id, subject_type, subject_id, occurred_at DESC);
```

### A.1 Verification script results (summary)

| Test | Expected | Result |
|---|---|---|
| SELECT contacts with app.tenant_id unset | 0 rows | 0 |
| SELECT contacts as tenant A | 1 row | 1 |
| SELECT contacts with principal_type=client | 0 rows | 0 |
| contact_point in A referencing contact in B | FK violation | FK violation |
| INSERT contact for tenant B while A set | RLS violation | RLS violation |
| phone not E.164 | CHECK violation | CHECK violation |
| imported grant at express_written | CHECK violation | CHECK violation |
| express_written without disclosure/document | CHECK violation | CHECK violation |
| UPDATE / DELETE consent_events | append-only error | rejected |
| outbound sms status=sent without gate decision | CHECK violation | CHECK violation |
| gate decision outcome=deny with no reasons | CHECK violation | CHECK violation |
| autonomous action in category money | CHECK violation | CHECK violation |
| claim needs_review=false without evidence (COMMIT) | deferred trigger error | rejected at COMMIT |
| claim + verified evidence inserted after claim | commit OK | OK |
| UPDATE steps of approved playbook version | frozen error | rejected |
| second approved version of same playbook | unique violation | unique violation |
| second live enrollment for same contact | unique violation | unique violation |
| import stage committing without dry run | CHECK violation | CHECK violation |
| UPDATE / TRUNCATE audit_log | rejected | rejected |
| answered announced call without announcement timestamp | CHECK violation | CHECK violation |
| recording visible to owning agent / other agent / team lead | 1 / 0 / 1 | 1 / 0 / 1 |
