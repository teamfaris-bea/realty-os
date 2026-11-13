# AI ISA: an opt-in AI inside sales agent for buyers and sellers. Design, revision 2 (after the attack round)

Design notes for owner decision D12 (proposed). Code references are file:line on main 4a55e22 unless another branch is named (the CMA lanes, telephony safeguards and lead intake were read from their branches).

All 72 review points were checked against the code. Every point the code confirmed is applied. Seven are applied in adapted form and two sub-points are rejected with evidence (the review notes are kept outside the repository). References to code are file:line in the scout tree unless another location is named. This document claims no legal compliance. Legal points are marked **VERIFY WITH COUNSEL**. Numbers marked VERIFY are engineering defaults, not legal advice. The edge ids stay inside the assigned range E490–E539: the new cases the reviewers raised are folded into existing ids, so no id is added past E539.

**What changed in revision 2:**
- **Concurrency.** There is now one lock order, and no transaction holds a lock across a provider call. The guard checks the pinned inbound sequence, the epoch, the message body hash and the bound recipient.
- **Opt-outs.** Any opt-out, from any writer, ends AI care in the same transaction through a stop-signal ledger, and blocks a restart.
- **Messages and consent.** Every AI message has purpose `marketing`. Consent evidence must come from the person's own disclosure (no defaulted scopes, no source fallbacks, nothing recorded before D12). Initiated SMS needs a fresh national DNC result.
- **Caps and quiet hours.** At most 3 messages per 24 hours, counting bulk sends and alerts. Quiet hours use a conservative zone union, and the guard recomputes it.
- **Turns.** A turn comes only from the person's bound address, from their own words: quoted email history and the team's own text never count. A DKIM-aligned pass is required for email.
- **Escalations.** Each class is either terminal or hold-topic. Statements of budget or financing are qualification, never an escalation. Every lexicon handles negation.
- **Replies are always answered.** A backstop makes sure a reply under AI care is answered or handed back. Handoffs have a response deadline (SLA) that escalates to team leads.
- **Booking.** Booking runs in its own job, outside the turn locks, and requires a live calendar link that matches the one the offer was read from.
- **Seller facts.**
  - Comps are sent as the complete engine set, by email only, through V1-C's `clientReadiness`.
  - They need `platform:cma`, a new `platform:ai_isa_seller_data` pack and the licence key `valuation.ai_isa_comps`, plus a subject the agent has confirmed.
  - No sold-derived market statistics are sent in v1.
- **Prompt.** The model sees no free text from third parties: no MLS remarks, notes, transcripts or prices.
- **Ownership.** Care cannot start until the lead's first touch is recorded. A re-inquiry pauses care instead of ending it. Inactivity warnings hand off.
- **Controls.** Pause, take over and end are recorded in an insert-only ledger, and the cancels they cause run in a system transaction (RLS). Take over and End have a 10-second undo. A pause expires after 72 hours.

---

## 1. Summary and non-goals

### 1.1 What the owner asked for (verbatim)
- "We should write the code to where the agent gives fully autonomous to system AI to take over nurture, searches, texts up until appointments are set or lead is ready to buy or sell." He clarified: "Like a ISA".
- "Same thing for sellers. ISA sends recently sold comps near them, new competition, etc".

### 1.2 What this design builds
It builds an **AI ISA mode**: a bounded, multi-turn SMS and email conversation that a lead's current owner switches on for that one lead. Inside its mandate it acts without a tap. Outside it, it hands back to the agent. Specifically:

1. **Converses and qualifies.** Only the person's own words, from their bound address, can become qualification (R-ISA-27, R-ISA-28).
   - Buyer: timeline, financing as stated, areas, budget, beds and baths.
   - Seller: plans, timing, ownership as stated, whether the home is listed, and readiness.
2. **Shares grounded facts.** Each fact is rendered by the server from a licensed, current record, with its own source and as-of date. The model never writes a fact, and never sees prices, remarks or addresses (§7.1).
   - Buyer: matching active listings with their asking prices. Saved searches are proposed for the agent to approve.
   - Seller: new competing listings, labelled with their status and asking price. The complete set of D9 comparable recent sales goes by email only, after `platform:cma` and the new seller-data pack are cleared and the agent has confirmed the subject home. Counts of competing homes are by status. No sold-derived statistics are sent in v1.
3. **Nurtures.** It follows up on a bounded cadence, inside recipient-local quiet hours, a 3-per-24-hours budget and attempt limits.
4. **Hands off, exactly once per assignment, and the handoff ends care.** The handoff happens when one of these is true:
   - the person agrees to one concrete offered slot read from a live calendar, and the slot is booked atomically;
   - an objective readiness rule is met;
   - a terminal escalation is raised;
   - a control ends care.

   The package carries the conversation, the qualification with verbatim client quotes, what was actually sent, the open questions and the next steps. It has a response deadline, and a breach escalates to team leads (R-ISA-30). "Hold-topic" escalations (pricing, financing, data, booking) do not end care. They create an escalation card, and the AI stays off that topic until the agent acts (§4.4).

**What the owner will see on day one, stated honestly.** Nothing sends until **all** of these are in place:
- `platform:ai_isa` has been counsel-cleared on the deployment;
- both live switches are on;
- the team policy is approved;
- the agent has opted in;
- the lead's first touch has been recorded.

After that, replies go out only within the reply window and only to the person's own inbound. Initiated texts and any text with a listing or comp need written consent naming the team, from the person's own disclosure, plus a fresh national DNC result (§5.2). Sold comps also wait on `platform:cma`, `platform:ai_isa_seller_data` and the MLS licence. The mandate is real autonomy inside fixed rails. It is not unlimited autonomy, and the D12 row says so.

### 1.3 Authorization (all default off; §3)
All of these must hold, together with the send-time checks (§5):
- the deployment switch `AI_ISA_LIVE_SENDS` (plus TELEPHONY_LIVE_REQUESTS for SMS);
- the `platform:ai_isa` pack, which ships unreviewed (the DB refuses AI ISA sends until it is cleared);
- `platform:cma` and `platform:ai_isa_seller_data` for sold-derived facts;
- the Owner's tenant switch, with re-auth and attestation (R-ISA-32);
- an approved, hash-frozen team policy (playbook kind `ai_isa`);
- the agent's own opt-in, with re-auth and attestation;
- a per-lead start by the lead's current owner, after the first touch.

### 1.4 Non-goals
- **No AI phone calls.** The AI ISA never dials. Voice answering is module 48: inbound only, the separate D-VOICE exception, not part of this design. Any call pauses AI care (§2.1).
- **No live sends.** Code, design and tests on fakes only:
  - no provider configuration, real leads, deploys, webhook changes, credentials or secrets;
  - TELEPHONY_LIVE_REQUESTS stays default false;
  - AI_ISA_LIVE_SENDS is new and also default false (§5.5);
  - the DNC provider stays the fake (providers/types.ts:218-226), so no initiated AI SMS can pass outside tests.
- **Money, offers, contracts, negotiation, pricing strategy, listing decisions, commission, lending and legal are always human.**
  - The AI ISA never sends in ALWAYS_HUMAN_CATEGORIES (packages/core/src/compliance/types.ts:103-109).
  - It never states a value, a range, a price opinion or a promise.
  - No value range is sent in v1 (§6.3).
- **No MMS from the AI ISA.** D5(a) says MMS is "never by the assistant" (docs/PHASE2_3_PLAN.md:81). An inbound MMS is never a turn (§2.1).
- **No web chat, Messenger or Instagram.** Channels are SMS and email only.
- **Not a module-28 seller update.** A party to an active team listing or an open deal is a client (R-SELL-1, R-AST-17). Care refuses to start for them and ends if they become one (R-ISA-2).
- **No ownership changes** (R-OWN-21, packages/core/src/ownership/decide.ts:400-401).
- **No touch or SLA credit.** AI ISA messages never count as touches or SLA (R-AST-15, docs/DATA_MODEL.md:533; R-OWN-14, :356).
- **No legal-compliance claims.**

---

## 2. Reconciliation with existing rules

### 2.1 "An inbound reply pauses automation and hands back" (R-AST-9)

**Today:**
- R-AST-9 is docs/DATA_MODEL.md:522-527. The code is apps/api/src/comms/inbound.ts:322-410:
  - step 6 pauses the conversation (keeping the earliest pause, comms/repos/automation.ts:12-18), the enrollments, the queued assistant messages (repos/messages.ts:305-313) and the trigger runs;
  - step 7 creates a handback when `assistantWasActive && h.userId` (:339-343);
  - step 8 adds the pinned `unanswered_inbound` card (:403) and the notification.
- The DB guard refuses an autonomous `within_playbook` send while the conversation is paused (0053_b7_review_sends_merges.sql:417-421).
- Core gate check 8 does the same (packages/core/src/compliance/gate.ts:226-227).

**What changes (R-ISA-3).** D12 adds a second bounded exception, applied only to a person with a **live** AI ISA assignment whose inbound is a **turn**.

1. **Step 6 runs unchanged for everyone.** Conversation pause, enrollment pause, queued-assistant cancel (which includes AI ISA conversation messages) and trigger-run cancel all happen as today. So no playbook, trigger or stage automation is broadened. One flagged exception: `cancelQueuedAssistant` skips the two post-handoff categories (`ai_isa_confirmation`, `ai_isa_holding_line`) when the inbound is classified as a short acknowledgement (§4.7). Any other inbound cancels them as today, and the package then says so.
2. **Which inbounds are turns.** An inbound is a turn only if **all** of these hold (R-ISA-28):
   - it is SMS or email;
   - its from-HMAC equals the assignment's bound point for that channel;
   - for email, the provider's DKIM verdict is an aligned pass for the From domain. The trust rule is reused (apps/api/src/leadEmail/trust.ts:88-98) and the verdict is stored on the message (a flagged edit);
   - it has no media and no declared text part (lane-telephony-safeguards.txt:89-100: parts are read asynchronously and "never go into an assistant prompt");
   - it is not an auto-reply.

   Anything else — a call (answered, missed, voice answering or call tracking), web chat, Gmail-synced mail (R-GMAIL-14), an MMS, an inbound from another point of the contact, a CC'd third party or an unaligned From — runs today's R-AST-9 path exactly (including the E61 new-address card, inbound.ts:406-409). AI care is then **paused** with `unverified_sender`, `call`, `chat`, `synced_mail` or `media`. For a call there is still exactly one card per event: the AI ISA's package is linked into the call's own handback card (payload `aiIsaAssignmentId`), never added as a second card.
3. **Step 7 under live AI care, for a turn.**
   - Ingestion takes the assignment `FOR SHARE` after `lock_contact`, so a control that commits during ingestion is seen (lock order §3.7).
   - If the full chain holds (§3.1), no per-reply handback is created and one `ai_isa.turn` job is enqueued.
   - If the chain is in a **hold** state (live switches off, daily cap reached), or any link fails, today's handback is written instead, with the reason from the link-failure table (§3.1).
4. **Step 8 under live AI care.**
   - No pinned card and no notification are written at ingestion. A scored `ai_isa_activity` feed row is written (a new item type, P27 key family).
   - **The answered-inbound backstop (R-ISA-29)** then applies. A turn inbound counts as answered only when one of these happens:
     - an AI ISA message after it reaches `sent` or `delivered`;
     - an AI ISA reply to it is `scheduled` by quiet hours (the panel and list show "Reply scheduled 9:00 AM their time");
     - a handoff that names it commits;
     - a human outbound goes to the person.
   - Otherwise, after 10 minutes (VERIFY), or immediately when care is paused, ended, held, or the scheduled reply is cancelled or blocked, the system writes:
     - today's pinned `unanswered_inbound` card and notification, with today's dedupe key `inbound:{contact}`;
     - an R-AST-9 handback (dedupe `handback:ai_isa:{assignment}:{inbound message id}`), with the unconsumed inbounds as client_statement claims.
   - The check runs in every transition out of live (`conversations.inbound_seq > assignment.last_inbound_seq`) and in the sweep.
5. **Classified inbounds.**
   - An opt-out (keyword or language), a wrong number, or any revoke or suppression from any writer ends care through the stop-signal ledger (R-ISA-31, §5.1).
   - A reaction is a reply (D5(b), docs/PHASE2_3_PLAN.md:81). It is never agreement to a slot (E529).
6. **Takeover (R-ISA-3, R-ISA-15).** Each of these pauses AI care at once with `human_contact`:
   - a one-to-one human message to the person being **created or scheduled** (compose and sendExisting, not only at dispatch);
   - approval of an assistant draft or a handback reply (apps/api/src/assistant/drafts.ts:183-207);
   - a human dial starting (dial.ts);
   - a Gmail-synced outbound.

   The queued AI ISA messages are then cancelled in a system transaction (messages_update RLS lets only tenant-wide actors or the initiator update, 0001_init.sql:3163-3166, and AI rows have no initiating user).

   **Bulk and marketing sends never take over.** These are sends carrying `bulk_action_id` (apps/api/src/bulk/run.ts:174, :194) or `marketing_piece_id`. They count toward the person's 24-hour automated budget instead (R-ISA-11), and bulk preflight offers "Skip people under AI care", default on.

   Compose and dial show "Sending pauses AI care for {name}. {Owner} can resume." After a human send, the owner sees a one-tap "Resume AI care" toast.

**What stays.**
- R-AST-9 is unchanged for every person without live care, and for every non-turn inbound.
- The DB guard's `within_playbook` branch is unchanged.
- Resume is human-only, and AI resume is owner-only.
- Voice stays D-VOICE.

### 2.2 The deferred autonomous-texting design
These texts deferred it:
- docs/PHASE2_3_PLAN.md:168 (§3): "Multi-turn autonomous text qualification … **Deferred indefinitely** | would break 'a reply hands back'";
- docs/ARCHITECTURE.md:572 (§18): "TCPA and accuracy risk";
- ARCHITECTURE §11 :388: "Any reply hands off to the agent";
- packages/core/src/assistant/playbook.ts:270: "no multi-turn autonomous replies";
- C1 (:533): "autonomy only inside approved, hash-frozen playbooks";
- R-AST-3 (DATA_MODEL:508): novel messages are always a tap;
- R-AST-20 (:1071): no new autonomous category.

D12 lifts the deferral only inside this mandate:

| Objection | How D12 answers it |
|---|---|
| "a reply hands back" | Hand-back is replaced only for a turn from a bound point of an opted-in person. The answered-inbound backstop means no reply is swallowed. Every non-turn inbound and every human action hands back at once. Each assignment ends in exactly one handoff. |
| TCPA risk | AI messages have purpose `marketing` and re-add consent evidence from the person's own disclosure, recipient-local quiet hours over a conservative zone set, a 3-per-24-hours budget, a fresh DNC result for initiated SMS, the pack gate and the live switches (§5). It is still a risk the owner must accept. **VERIFY WITH COUNSEL** (C-ISA-1…4). |
| Accuracy risk | The model writes conversation only. The guard refuses numbers, prices, addresses, links, valuation, market, comparative and commitment language in model text (R-ISA-7). A message that carries facts has no model text at all. Facts come from licensed, current records with their own source and date. Qualification needs a verbatim quote of the client's own text whose value is in the quote (R-ISA-27). |
| C1 "approved, hash-frozen playbooks" | The policy is an approved, hash-frozen playbook version of kind `ai_isa` (§3.2), approved through the existing machinery (apps/api/src/assistant/playbooks.ts:172-212; guards at 0001_init.sql:2752-2803). The model-composed wording inside the frozen rails is the explicit change. The disclosure and sign-off are platform constants, not team text. |
| R-AST-3 | `novel_message` stays always-human on every path. AI messages use the new categories `ai_isa_message`, `ai_isa_confirmation` and `ai_isa_holding_line`, sendable only under autonomy `ai_isa_mandate`. A DB CHECK ties the mandate to those categories (§8.1). |
| R-AST-20 | It holds for playbooks and triggers. AUTONOMOUS_ELIGIBLE (types.ts:112-119) and `compliance_policy_versions.autonomous_categories` (0001:367-368) are unchanged. The AI ISA categories are never in `policy.autonomous`, and they never use `booking_confirmation` or initiator `system`. |

### 2.3 D1 ("sending checks only opt-outs")

**D1 today:**
- docs/PHASE2_3_PLAN.md:5; ARCHITECTURE :253 and :651.
- The removed checks are listed at gate.ts:7-9 and 0013_simplify_send_gate.sql:69-84.
- The consent level is "history only" (apps/api/src/leads/intakeConsent.ts:13).

**What changes, and for whom.** Only messages with `initiator='assistant'`, `autonomy='ai_isa_mandate'` and an AI ISA category. For them, sending checks D1's opt-outs **plus** consent evidence (R-ISA-9), quiet hours (R-ISA-10), caps (R-ISA-11), the chain (R-ISA-1), the stop signals and blocks (R-ISA-31), the bound recipient and freshness checks (R-ISA-4, R-ISA-28) and the live switches (R-ISA-25). They are also stored with `purpose='marketing'`, so check 4's marketing identity (gate.ts:208-215), List-Unsubscribe (dispatch.ts:272) and marketing-scoped unsubscribes (comms/consent.ts:255-276) all apply.

**Exactly what stays.**
- Human sends, first response (R-AST-16; firstResponse.test.ts:125-137 E8 still texts a 02:00 lead at once), playbooks, nurture triggers, saved-search alerts (except AI-proposed searches while care is live, §6.2), stage automation, seller updates, marketing, bulk and agent alerts all keep D1 unchanged.
- The D1 absence tests stay true for non-ISA inputs: gate.test.ts:72-79, apps/api/src/comms/paths.test.ts:212-231, admin/policy.test.ts:21 and :186-196. A non-interference property is added: for every category outside the AI ISA set, `canContact(input)` equals `canContact({...input, aiIsa: anything})`.
- The retired R-CONSENT-13/14/15 stay retired for those paths.
- The helpers are reused for the AI ISA only: `nextWindowStart` and `resolveRecipientZones` (packages/core/src/foundation/tz.ts:220-319, "nothing in the send path uses them", DATA_MODEL:468), and the existing `dnc_checks` table (0001:1126) and `DncProvider` (providers/types.ts:218-226).
- The intake grant writing (intakeConsent.ts) and the inbound first-contact grant (inbound.ts:276-288) are **not changed**. The AI ISA reads them more strictly. The one flagged additive edit is that `storeDisclosure` records whether the scope was stated (§5.2).

**Documents to amend** (each lane's docs commit):
- R-CONSENT-2/4: "except R-ISA-9".
- The CompliancePage notice (apps/web/src/surfaces/…/CompliancePage.tsx:110) gains: "…for your team's own messages, playbooks and alerts. The AI assistant (ISA) uses engineering defaults for consent evidence, quiet hours and frequency limits on its own messages. These are not legal advice and have not been reviewed by counsel."
- ARCHITECTURE §9 :253 gets a pointer to D12.
- The README:158 counsel flags.

### 2.4 Proposed owner decision row (PHASE2_3_PLAN §2.2 format)
The row is given verbatim in <d12_row> below. It "enters §2.2 when the owner confirms".

---

## 3. Authorization model

### 3.1 The chain (R-ISA-1) and the link-failure table
A turn may compose and a message may send only while every link holds. Every link is checked at start, at ingestion, in TX-A, in TX-B, in dispatch TX1 (core gate) and in the DB guard. The guard backstops every link except link 1, which config enforces.

| # | Link | Who sets it | Default | Stored in |
|---|---|---|---|---|
| 1 | `AI_ISA_LIVE_SENDS` (plus TELEPHONY_LIVE_REQUESTS for SMS) | operator config | false | config.ts (the MLS_LIVE_CALLS pattern, apps/api/src/config.ts:186-189, :276-284) |
| 2 | `app.platform_cleared('platform:ai_isa')`; for sold-derived facts also `platform:cma` and `platform:ai_isa_seller_data` | the counsel-review command (D11) | not cleared | `jurisdiction_packs` |
| 3 | `tenant_settings.ai_enabled` (R-AST-18) and `ai_isa_enabled`, plus the tenant cap | Owner on (re-auth plus attestation); Owner or Admin off | false | tenant_settings |
| 4 | An approved `ai_isa` playbook version whose latest approval matches its hash, or a superseded version whose every successor is narrowing-only (§3.2) | Owner/Admin | none | playbooks / playbook_versions / approvals |
| 5 | The agent's opt-in: active, bound to link 4's version, attestation hash recomputed | the agent, as themselves, with re-auth | none | `ai_isa_agent_optins` |
| 6 | The assignment: not ended; not paused; owner = the contact's owner; `bound_ownership_seq` = the contact's `ownership_period_seq`; contact is a root (`merged_into_contact_id IS NULL`, 0001:715); bound points live | the lead's current owner, as themselves | none | `ai_isa_assignments` |
| 7 | No stop signal for the person since start, and no person block | system triggers (§5.1) | — | `ai_isa_stop_signals`, `ai_isa_person_blocks` |
| 8 | No address shared with another person; no open deal or active team listing with the person as a party | data | — | contact_points, deals, listings |
| 9 | Consent evidence for the channel and tier (§5.2) | the lead (ledger) | — | consent_events / consent_state / messages / dnc_checks |
| 10 | "Seller home" (seller- or both-side assignments; ISA-3 H5, `isa/seller/gates.ts subjectLinkInTx`): no live team listing or mirror at the subject's key (else end `active_client`), no other live MLS listing at it (else end `listed_elsewhere`, also refused at start by H4), no undismissed live near match (else pause `possible_listing`) | data; the owner's "different home" answers | — | listings, `ai_isa_seller_watch.near_match_dismissed` |

**Link-failure table.** One table, applied identically at ingestion, in TX-A, TX-B and TX1, by the sweep and in the guard's reason classes.

| Failure | Effect | Who restores |
|---|---|---|
| Link 1 off; tenant AI ISA daily cap or telephony daily cap reached | **Hold.** No pause and no per-lead card. TX-A defers with `retryAt` before any model call. An inbound during a hold takes the R-AST-9 path, and the AI sends nothing while that handback is open. One deployment or tenant banner. The sweep ignores holds. | Automatic when the switch or cap clears (a hold is not a pause) |
| Link 2 withdrawn; link 3 `ai_enabled` false; link 4 revoked | **Pause**, system (`pack_withdrawn`, `ai_off`, `approval_revoked`), one card per owner (batched) | The owner resumes after the link is restored; after a revoke, see §3.2 |
| Link 4 superseded by a widening version | **Pause** `policy_updated`, one card per agent | One agent re-attestation continues all of them (§3.2) |
| Same-owner new ownership period (REINQUIRY_SLA, decide.ts:813-817) | **Pause** `reinquiry`, with an accurate card | Owner "Continue AI care" (a linked new assignment, §3.6) |
| A possible live listing at the seller's subject (near match) | **Pause** `possible_listing` with an escalation card | The owner confirms "different home", then resumes |
| Link 3 `ai_isa_enabled` false; link 5 revoked; link 6 owner changed, merged, owner inactive or bound point removed; link 7; link 8; a confirmed listing at the subject (team → `active_client`, other brokerage → `listed_elsewhere`) | **End** with one handoff | A new start only |

Delivery failures are handled separately:
- Undelivered twice in a row ends care with `delivery_problem` and a handoff. Deferring would loop; ending is final and visible. Only a carrier `delivered` breaks the run; a provider `sent` does not (b12 recheck R7).
- SENDER_NOT_VERIFIED is a hold (the lane's sender block).

### 3.2 The team policy (playbook kind `ai_isa`)
- **Placement.** `playbooks.kind` gains `ai_isa`, team scope only (the `playbooks_voice_team_scope` pattern, 0018_phase2_3_schema.sql:539-542). The content is one `AiIsaContent` in `playbook_versions.steps` (0018:543-545), hashed with `contentSha256` (packages/core/src/assistant/playbook.ts:175-182).
- **`AiIsaContent`** is a strict Zod schema. Every value is validated against the pack's ceilings at approval and again at send:
  - `capabilities ⊆ {converse, share_listings, propose_saved_search, seller_competition, seller_sold_comps, book_appointments}`. `converse` is required. `share_value_estimate` and `seller_market_stats` are reserved and refused (CAPABILITY_NOT_AVAILABLE).
  - `channels ⊆ {sms, email}`.
  - `window`: default 09:00–20:00, never wider than the pack ceiling of 08:00–20:00 (VERIFY). `initiatedDays` default Mon–Sat. `noInitiatedOnHolidays: true` (US federal list; VERIFY).
  - `caps`: §5.3, each at or below the pack ceiling.
  - `cadence` from the enum 1d, 3d, 7d, 14d, 30d.
  - `limits`: maxMessagesPerAssignment 40, maxDays 180, slow cadence after 3 unanswered initiated, dormant after 6.
  - `readiness` thresholds (§4.5).
  - `booking`: kinds per side, duration, minimum notice 4 h, horizon 14 days, buffer 15 minutes.
  - `holdingLines` per escalation class, and the pricing line. Each passes contentGuard (packages/core/src/assistant/guard.ts:328-354), the fair-housing check and the ISA guard at approval.
  - `tone`: a sample, run through `scrubSample` (packages/core/src/assistant/prompt.ts:139-141).
  - **Not in team content:** the AI disclosure and sign-off. These are platform constants in `platform:ai_isa` rules, must contain "AI", and are checked by `AI_IDENTITY_MISSING` (R-ISA-7).
- **Supersede.** Approving a new version supersedes the old one (playbooks.ts:185). Core computes `narrowsPrevious(old, new)` at approval and stores `playbook_versions.narrows_previous`, flagged for kind `ai_isa` only. "Narrowing" means the new version has fewer capabilities and channels, a narrower or equal window, lower or equal caps, stricter readiness, and lines that changed only in wording that passes the guards.
  - **Narrowing-only:** assignments keep their bound version id. The chain accepts it, and the turn applies the current version's content at the next turn (R-AST-4 style).
  - **Widening:** every assignment on the old version is paused `policy_updated`, with one card per agent ("Team updated the AI rules: what changed. Re-attest to continue your N leads."). The agent's re-attestation creates a new opt-in row on the new version. In that same transaction, as the owner, it ends each paused assignment `policy_updated` and starts a linked continuation (`continued_from_assignment_id`); the end's handoff closes `care_continued` once the continuation exists, as for Continue AI care (§3.6; b12 recheck R23). Each continuation gets a fresh consent snapshot, a chain check and a first-touch check. A continuation that fails a check is listed as "not continued: why".
- **Revoke.** Every assignment on the version is paused `approval_revoked` (the batching of `pauseRevokedEnrollments`, playbooks.ts:295-309). It resumes only through a new approved version, and then as continuations after re-attestation, as above. The assignment's `playbook_version_id` and `optin_id` are immutable.

### 3.3 The agent's opt-in
- `PUT /me/ai-isa/opt-in`, acting as themselves. MATRIX `ai_isa.optin`: `reauth: 'always'` on create or widen.
- **Body:**
  - versionId;
  - capabilities (a subset of the version's, each unchecked by default);
  - channels;
  - `availability` weekly windows in a required IANA `timezone` (core `ianaZone`, checked against `pg_timezone_names` in the DB);
  - booking kinds.
- **Attestation.** The server builds the canonical attestation text. It embeds the version hash and the sentence "I'm responsible for leads I put in AI care." `attestation_sha256 = sha256(text)`, recomputed by the DB guard, which also checks that the text contains the version hash.
- **`book_appointments`** requires a live `user_calendar_links` row (connected or degraded) at opt-in and at booking (GET /me/calendar, apps/api/src/calendar/service.ts:342-349).
- **Who may opt in:** owner, admin, team_lead and agent, each for their own leads only. Never TC. The human `isa` role is excluded by default (Q-ISA-8): it hands leads off (R-OWN-18) and has no `cma.prepare` (R-CMA-6).
- **Changes.** One active opt-in per user. Narrowing is a new row (`ai_isa.optin_narrowed`, no re-auth). Widening is a new row with re-auth (`ai_isa.optin_superseded`).
- **Revoke** (`POST /me/ai-isa/opt-in/revoke`, or by Owner/Admin) ends every assignment of the agent with `optin_revoked`, each with a handoff.

### 3.4 Per-lead start
- **Route:** `POST /contacts/:id/ai-isa/start {side, channels?, fromHandbackId?}`. Only the contact's current owner, as themselves (Q-ISA-9).
- **Refused, each with a sentence, when:**
  - a chain link fails (AI_ISA_OFF, AI_ISA_NOT_CLEARED, AI_ISA_POLICY_NOT_APPROVED, AI_ISA_NO_OPTIN);
  - the contact is not a root (AI_ISA_NOT_ROOT);
  - care is already live (AI_ISA_ALREADY_ACTIVE);
  - there is a person-level do-not-contact;
  - there is a person block (AI_ISA_PERSON_DECLINED, §5.1);
  - **the first touch is pending:** `contacts.first_touch_at IS NULL AND release_due_at IS NOT NULL` (0001:692-694). AI_ISA_FIRST_TOUCH_PENDING: "Text or call them yourself first. AI messages don't count as your first contact."
  - no channel has a bindable point that passes reply-tier evidence (AI_ISA_NO_CHANNEL);
  - **any** point of the contact, of any kind, live or removed (unless removed as wrong_number), is on another live contact outside `app.contact_person_ids` (AI_ISA_SHARED_ADDRESS);
  - the contact is a party to an open deal or active team listing (AI_ISA_ACTIVE_CLIENT);
  - side seller or both and a live MLS listing at the property address belongs to another brokerage (AI_ISA_LISTED_ELSEWHERE, R-ISA-26, **VERIFY WITH COUNSEL**, Code of Ethics Art. 16).
- **In one transaction, the start:**
  - binds the points: `bound_points {sms: point_id, email: point_id}` and their HMACs, immutable. They are the primary mobile and primary email that pass reply-tier evidence;
  - stops the live playbook enrollment (`stop_reason 'ai_isa_started'`, with the sentence "Starting AI care stops the 'New lead' playbook for this person.");
  - **supersedes every proposed `message_draft` and `handback` of the contact** (status invalidated, with a sentence);
  - records the consent snapshot;
  - inserts the assignment with epoch 1;
  - audits `ai_isa.assignment_started`;
  - enqueues the first turn.
- **From a handback card** ("Let the AI assistant continue"). `fromHandbackId` must:
  - be kind `handback`;
  - be on the same root contact;
  - be owned by the caller;
  - still be `proposed`;
  - have `pinned_inbound_seq` equal to the conversation's current `inbound_seq`;
  - have an inbound from a point that becomes a bound point.

  It is closed through the "nothing to send" branch: status approved, result `acknowledged` (drafts.ts:176-180). `payload.draft` is discarded and nothing is sent. If its reply draft was already queued, the start is refused AI_ISA_HANDBACK_STALE. Any other failure is 404. That inbound becomes the first turn's input.
- **The natural buyer path:** first response (R-AST-16) → reply → handback → the agent calls or texts (first touch) → "Let the AI assistant continue" (when the handback is still current) or "Start AI care" on the person.

### 3.5 Roles

| Action | Owner | Admin | Team Lead | Agent | ISA (human) | TC | Support |
|---|---|---|---|---|---|---|---|
| Tenant switch on, or raise the cap (`settings.ai_isa`: attest_when_loosening, reauth when_loosening) | ✓ | — | — | — | — | — | — |
| Tenant switch off, or lower the cap (`not_loosening`) | ✓ | ✓ | — | — | — | — | — |
| Approve or revoke the team policy | ✓ | ✓ | — | — | — | — | — |
| Opt in (re-auth) | own leads | own leads | own leads | own leads | — | — | — |
| Start care on a lead | the lead's owner only | ← | ← | ← | — | — | — |
| Confirm the seller subject | the lead's owner only | ← | ← | ← | — | — | — |
| Pause | all | all | team | own and collaborated | own | — | — |
| Resume | the lead's owner only | ← | ← | ← | — | — | — |
| Take over or end (10 s undo) | all | all | team | own (collaborator: pause only) | — | — | — |
| View "Under AI care" and the panel | all | all | team | own and collaborated | own | — | read only |

A DB guard in the style of `tenant_settings_batch_text_guard` (0021_fub_parity.sql:758-766) enforces that only the Owner turns `ai_isa_enabled` on or raises `ai_isa_daily_cap`.

### 3.6 Ownership changes, merges, deactivation, first touch and inactivity (R-ISA-16)
- **The owner changes** (offer timeout, auto-release, reassign, pond, isa_handoff):
  - The guard refuses at once (owner and seq).
  - In the ownership apply path, `invalidateDrafts` adds `ai_isa_message` to its kind list (packages/db/src/ownership/effects.ts:136-140, a flagged edit), and a stop signal `owner_change` is inserted in the same transaction.
  - The sweep and job end the assignment `owner_change` with a handoff. The new owner, or for the pond the previous owner's team leads and Owner/Admin, gets: "AI care ended because this lead moved. Here is what it did."
- **Same owner, new period** (REINQUIRY_SLA, `newPeriod:true`, packages/core/src/ownership/decide.ts:813-817): pause `reinquiry` with "{Name} inquired again. AI care is paused so you can see the new inquiry." The only exit is the owner's "Continue AI care", which ends this assignment `reinquiry_period` and starts a linked continuation bound to the new seq (bound fields stay immutable). The owner's Continue is a person's decision on the handoff that end writes: once the continuation exists it closes `care_continued` (no touch is recorded, so no deadline is met) and its deadline never alerts; a refused continuation leaves it open (b12 recheck R23).
- **Merge** (packages/db/src/ownership/merge.ts:116-119, a flagged edit):
  - `ai_isa_message` is added to the invalidated kinds, so the loser's proposed AI actions that move to the survivor are withdrawn and dispatch refuses them (ASSISTANT_ACTION_WITHDRAWN).
  - The merge transaction inserts stop signals `merged` for both records. The guard and liveness then treat both assignments as ended at commit, and the job completes the bookkeeping. The merger may lack UPDATE rights on the loser's assignment under RLS; the stop signal needs none.
  - The survivor is never enrolled automatically.
- **Deactivated member:** ends `owner_inactive`.
- **First touch:** starting care requires a recorded first touch (§3.4). AI messages never count (R-OWN-14).
- **Inactivity** (stages new and attempting, R-OWN-23, DATA_MODEL:387; 0001:391-392, :705-706):
  - The panel and list show `inactivity_release_at` with "AI messages don't reset this".
  - `offer_slots` refuses slots after `inactivity_release_at`.
  - At `inactivity_warn_at`, care ends `inactivity_warning` with a pinned handoff: "{Name} returns to the pond on {date} unless you touch them. AI care has handed back."
- **The AI ISA never changes ownership** (R-OWN-21).

### 3.7 Controls, lock order and races (R-ISA-4, R-ISA-15)

**Global lock order** for every AI ISA transaction (ingestion, TX-A, TX-B, TX-O, TX-C, every control, the sweep, the stop-signal job, dispatch TX1 and TX2's turn and assignment updates):
1. `app.lock_address` (sorted by HMAC), where the transaction touches an address;
2. `app.lock_contact` for every id in `app.contact_person_ids`, sorted (packages/db/src/locks.ts:1-8);
3. `ai_isa.turn:{tenant}:{assignment}`;
4. `ai_isa_assignments … FOR UPDATE` (ingestion: `FOR SHARE`);
5. `calendar.book:{tenant}:{user}` (apps/api/src/calendar/repos/links.ts:174-176);
6. `ai_isa.send:{tenant}:{hmac}` for every HMAC of the person, sorted (guard).

**Rule: no provider call (AI, calendar, MLS, SMS or email) while lock 2, 3 or 4 is held.** The only provider call under any lock is the booking job's live free/busy read under lock 5 alone, exactly as `bookSlot` does today (service.ts:400-410).

**Controls.**

| Control | Effect | Resumable |
|---|---|---|
| Pause (lead) | A user transaction takes lock 2, inserts an `ai_isa_controls` row (insert-only), projects `paused_*` onto the assignment and audits. Then a system transaction (under lock 2) cancels queued and scheduled messages of the assignment's AI actions, withdraws those actions and cancels timers by dedupe key. An owner card is written, pinned if an inbound is unanswered or an offer or commitment is open. It says who paused, why and what was in flight. Banner: "Paused: nobody is following up automatically". | Owner Resume (as themselves, while the chain holds). Resume increments `epoch` and withdraws any proposed action from an older epoch. After 72 h (VERIFY) the pause ends `pause_expired` with a handoff. |
| Take over (lead) | Immediate pause, then final after a 10-second Undo (a `finalize` job at +10 s, cancelled by Undo; Undo leaves it paused, not live). Final means end `taken_over` plus the handoff, which goes to the person who took over, with the owner notified. The web opens compose with the transcript. | Not after 10 s: start again |
| End (lead) | The same, with the 10-second Undo; it sits in the overflow menu | Not after 10 s |
| Agent "pause all mine" | Pauses each live assignment (`ai_isa.pause_all`) | Per lead or all |
| Agent revokes the opt-in | Ends all of the agent's assignments | No |
| Version revoked or widened | Pause (§3.2) | Re-attestation continuation |
| Tenant switch off | Ends all with `tenant_off`; one batched notice per owner | No |
| Pack withdrawn | Pause `pack_withdrawn` | The owner resumes after clearance |

- The system may only set `paused_*` and `ended_*` and its own counters, timers and state. It **never clears `paused_at`**.
- These assignment fields are immutable: `contact_id`, `owner_user_id`, `optin_id`, `playbook_version_id`, `bound_ownership_seq`, `bound_points`.

**Races:**
- **A control that commits before a message's `dispatching` UPDATE:** the guard refuses it (ISA_PAUSED, ISA_STALE_EPOCH or a chain code), and TX1 maps it to a blocked result (§5.4).
- **A message whose TX1 committed before the control:** it may still reach the provider. The control's response and the handoff say so: "1 message was already on its way at 10:02:13" (the E22 pattern, inbound.ts:362-366).
- **A control during the model call:** TX-B finds the assignment paused, or the epoch or attempt changed, and discards everything.
- **A control during a booking:** the booking job holds only lock 5, so the pause commits at once. TX-C then finds the assignment paused. The appointment exists, the confirmation is not queued, and the package says "Booked …; the confirmation was not sent because AI care was paused." The handoff stores the confirmation as not sent (`refused`), and the card is critical and asks for a hand confirmation, or says none is possible when D1 leaves no channel (E523).
- **A pause that races an inbound:** ingestion takes the assignment `FOR SHARE` after lock 2, so either it sees the pause (R-AST-9 path) or the pause's transition sees the unconsumed inbound and writes the handback (R-ISA-29).

---
- **ISA-2b.** After a take over the handoff's recipient is the person who took over (the latest `take_over` control row; `paused_by_user_id` keeps only the first pause), with the card and the deadline, while the lead is still with the assignment's owner (batch 13: a lead that moved goes to its new owner, an unowned one to the escalation, b12 review F1, F3); a different owner is notified; escalation follows the owner's chain; an End keeps the owner (`endedByUserId` in the package). The book job's tx#1 takes lock 5 FIRST, then the offer row FOR UPDATE, and nothing of locks 2–4; nothing holding 2–4 ever updates an `accepting` offer. Resume is refused while an offer is accepting (AI_ISA_BOOKING_IN_PROGRESS): resume drops the offer and the booking would then be ignored.

## 4. The conversation policy: module 74, `packages/core/src/isa` (pure, property-tested)
The shape is that of core/voice: a pure `step(state, event, facts) → {state, actions}` (packages/core/src/voice/machine.ts:355). "Core never sends, dials or books" (:32-33).

### 4.1 States
```
starting ─► awaiting_reply ◄─► engaged ─► scheduling ─► booking ─► ended(handed_off: appointment_booked)
                │      ▲          │  ▲          │           │
                ▼      │          ▼  │          ▼           ▼ booking failed → scheduling | ended(escalated)
             nurture ──┘   awaiting_agent{class, since}   (offer expired → engaged)
any non-terminal ─► paused{reason, by} ─► (owner resume, epoch+1) previous state
any non-terminal ─► ended{reason}  (terminal; writes exactly one handoff)
```
- **`ended.reason`** is one of: `appointment_booked`, `ready_buyer`, `ready_seller`, `escalated:{class}`, `opted_out`, `suppressed`, `do_not_contact`, `wrong_number`, `owner_change`, `merged`, `owner_inactive`, `tenant_off`, `optin_revoked`, `policy_updated`, `inactivity_warning`, `dormant`, `limit_reached`, `delivery_problem`, `listed_elsewhere`, `active_client`, `shared_address`, `point_removed`, `pause_expired`, `ended_by_user`, `taken_over`, `has_agent`, `not_interested`, `not_a_lead`, `reinquiry_period`.
- **`awaiting_agent`** is the hold-topic state (§4.4). Nurture continues, but core refuses any action on the held topic.
- **Events:** `start`, `inbound {seq, channel, ownText, ownTextReliable, classification, signals}`, `timer`, `listing_event`, `model_output`, `model_failed`, `send_result {messageId, status}` (every terminal message status emits one), `offer_ready`, `booking_result`, `human_control`, `human_contact`, `authorization_lost {failure}`, `stop_signal`.
- **Actions:** `await_model`, `queue_message {kind: conversation|facts|offer|confirmation|holding_line, purpose:'marketing', channel, notBefore}`, `request_offer {kind}`, `book {offerId, slot}`, `record_claims`, `propose_saved_search`, `escalate {class}`, `handoff {basis}`, `schedule_timer`, `cancel_timers`, `end {reason}`.

### 4.2 Turns and limits
- **One turn** = one trigger (a batch of inbounds, a timer or an event). It makes at most one model call, plus one repair retry on a schema failure. It queues at most one message. **One open (proposed) AI message per assignment** (a partial unique index): a turn that needs to speak while one is pending withdraws it, cancels its facts and composes from both inputs.
- **Model limits:**
  - 12 calls per person per day; calls discarded as stale count only against the tenant budget;
  - a tenant budget of 1,000 calls a day (VERIFY);
  - a flood (10 or more inbounds in 10 minutes) escalates `flood`, high priority when an inbound is unanswered.
- **Minimum gap** of 120 seconds between AI outbounds, enforced in TX1 and the guard.
- **Debounce.** TX-A returns `{retryAt: last_inbound_at + 20 s}` while `conversations.last_inbound_at > now − 20 s`, capped at 2 minutes of total deferral. This uses the worker's retryAt (apps/api/src/worker/handlers/dispatchStale.ts:28), because a dedupe-keyed enqueue cannot push `run_at` back (packages/db/src/jobs.ts:92-105).
- **Latency target:** the turn starts within 60 seconds after the debounce (an internal alert; the backstop is R-ISA-29).
- **Language:** English only. An uncovered language is terminal `language`, with the fixed English holding line (machine.ts:233-269 pattern).

### 4.3 The action allowlist (structured arguments; the model proposes, core decides)
The provider stays tool-less ("One user turn, no tools", apps/api/src/providers/anthropic.ts:5; R-AST-14). The model returns one strict JSON object (§7.4). Core's `decideAction` allows or denies each item, like voice `decideToolCall` (packages/core/src/voice/tools.ts:167-205). A denial is recorded as codes and handles only.

| Action | Arguments (closed) | Allowed only when |
|---|---|---|
| `reply` | `text` (≤ 240 SMS, ≤ 1,200 email) | it passes the §7.3 guard; not in a turn that shares facts or offers slots |
| `record_qualification` | `field ∈ {timeline, financing_status_stated, areas, budget, beds_min, baths_min, property_type, must_haves_structured, seller_timeline, seller_owns_stated, seller_listed_elsewhere_stated, seller_motivation, seller_next_move, wants_agent_contact}`, typed `value`, `quote ≤ 200`, `source: S<n>` | the source is an **inbound client own-text** source on a bound point (QUOTE_NOT_CLIENT); the quote verifies (`verifyQuote`, packages/core/src/assistant/evidence.ts:269-278); the quote is not team text (QUOTE_IS_TEAM_TEXT, R-ISA-27); `qualValueQuoted(field, value, quote)` holds (below). Otherwise the claim is needs_review and unusable. |
| `share_listings` | `handles: L<n>[] ≤ 3` | buyer side; the capability; each handle from this turn's server search through clientView. The message is facts-only. |
| `propose_saved_search` | none | the capability; no open proposal; the marketing tier passes on the alert channel (§6.2) |
| `share_competition` | `handles: C<n>[] ≤ 3` | seller side; `seller_competition`; the handles passed their gates in this bundle. Facts-only. |
| `send_comps` | none (the model never selects comps) | seller side; `seller_sold_comps`; the complete comp set passed every gate (§6.3); the email channel passes; not while `pricing_negotiation` is held for this seller |
| `offer_slots` | `kind ∈ content.booking.kinds[side]` | `book_appointments`; the calendar is live; no live offer; a verified client quote asks to meet or agrees to meet. The offer message is server-rendered. |
| `book_slot` | `offer: O<n>`, `slot: 1-3`, `quote`, `source` | §4.6 |
| `escalate` | `class`, `quoteRef?` (a verified client own-text quote; no free text) | always (it can only add) |
| `ready` | `basis ∈ {B2, B3, S2, S3}` | core recomputes it from usable claims (§4.5); not while an offer is live |
| `follow_up` | `after ∈ cadence enum` | not terminal; inside the limits |
| `end` | `reason ∈ {not_interested, has_agent, not_a_lead}`, `quoteRef` | never ends care by itself: it pauses with a "Check this" handoff card, and the owner confirms in one tap (then end, plus a `has_agent` block) |

`qualValueQuoted` (core) checks the value against the quote:
- an enum value needs a value-specific lexicon hit inside the quote (`pre-?approv`, `\bcash\b`, `lender|loan officer|mortgage`), with no negator within 4 tokens before it (the compliance NEGATOR_BEFORE pattern, packages/core/src/compliance/inbound.ts:77, exported by a flagged edit);
- a boolean needs an affirmative pattern with no negator;
- a timeline goes through `resolveRelativeDate`;
- an amount must appear in the quote (the `criterionQuoted` rule, packages/core/src/assistant/claims.ts:216-225);
- the quote must cover the whole clause.

**The model cannot:** choose a recipient, channel, purpose or time; name anything outside the handles; select which comps are shown; lift an escalation or a deterministic signal; write a free-text note to the agent; or move the state except through allowed actions.

### 4.4 The escalation taxonomy (R-ISA-6)
Deterministic signals run on each inbound's **client own text** before the model. Every lexicon runs through the shared negation window, with negated fixtures for each class. A model `escalate` can add a class, never remove one. Classes 15 and 16 fire **only on request or question frames**:
- the frames: "how much can we afford", "what('s| is) (the|a) rate", "should (I|we) offer", "what('s| is) (it|my home) worth", "would they take", "what should I list at", "can you get me a lender", "how much (down|should we put)", a sentence ending "?" that contains a topic term;
- a topic term on its own ("our budget is around 450k", "we're preapproved", "talking to a lender", "50k for a down payment", "what do you offer") is **not** an escalation. It is `record_qualification` input.

The probes against today's lexicons show why: voice SPOKEN_MONEY_RE matches "450k" (packages/core/src/voice/lexicon.ts:31-38); the pre-approval and lender patterns match "preapproved" (:66-67); guard.ts:145 matches "offer". Must-not-escalate fixtures cover every B3 and S3 field phrase.

**Precedence.** Rows 1–9 are stop classes. Row 10 (a slot choice) runs after them and before every other class.

| # | Class | Trigger | Client line (fixed; sent only if the send checks pass now) | Type, priority |
|---|---|---|---|---|
| 1 | opt_out / wrong_number | inbound.ts classification (`pauseReasonOf`, :73-77) or any stop signal | none (the R-CONSENT-7 confirmation path only) | terminal, block |
| 2 | possible_opt_out | "stop texting", "too many texts", "leave me alone", "unsubscribe" short of the keyword | none | terminal critical, block |
| 3 | safety | threat or self-harm lexicon | the fixed safety line **only if inside the window now; never deferred**. Outside the window nothing is sent, and the handoff says "no automated reply was sent (11:30 PM their time)". A critical notification goes immediately to the owner, the team leads and Owner/Admin. **VERIFY WITH COUNSEL** (C-ISA-12) | terminal critical |
| 4 | fraud_risk | wire or account change, "send the deposit to", account-number patterns (guard.ts wire and account patterns) | "Don't send money based on a text or email. Call {Agent} at a number you already know." **VERIFY WITH COUNSEL** | terminal critical |
| 5 | consent_dispute | "how did you get my number", "I never signed up" | none; no further AI sends; the consent evidence is flagged for the agent | terminal critical |
| 6 | privacy_request | delete or erase my data, "what do you have on me" | "I've passed your request to {Team}." | terminal; task for Owner/Admin |
| 7 | ai_declined | "I don't want to text a bot / an AI" | "Understood. I've asked {Agent} to take it from here." | terminal, block |
| 8 | complaint | complaint or review-threat lexicon | "I'm sorry. I've asked {Agent} to reach out to you personally." | terminal critical, block |
| 9 | human_request | "talk to a real person", "have {agent} call me", "AGENT" (negation-aware: "please don't call me" is not a request) | "I've let {Agent} know you'd like to talk." Sent only in the transaction that commits the handoff and notification. `call_now` is offered only when `phoneCallbackAllowed` holds (packages/core/src/voice/optouts.ts, E112). | terminal critical |
| — | bot_question | "is this a real person?", "are you a bot?" (HUMAN_QUESTION_RE, lexicon.ts:76+) | "You're texting with {Agent}'s AI assistant, not a person. Reply AGENT any time and I'll ask {Agent} to contact you." | not an escalation; care continues |
| 10 | (slot choice) | `matchSlotChoice` on a live offer | — book first, then evaluate rows 11+ in the same turn; one message holds the confirmation plus any holding line | — |
| 11 | fair_housing | `detectAreaQuestion` (packages/core/src/fairhousing/assistant.ts:79) or a protected-characteristic mention (check.ts:163-193) | `AREA_QUESTION_CLIENT_REPLY` (:101-102) | terminal high, with the agentNote (:112-123) |
| 12 | legal_contract | CONTRACT_TOPIC (guard.ts:160+) plus listing or buyer agreement, disclosure, inspection, title, attorney, in a request frame | the legal holding line | terminal high |
| 13 | third_party | "this is her husband", "I'm replying for my mother" | "Thanks. I've let {Agent} know." No qualification is recorded. | terminal high |
| 14 | other_agent | "my agent", "already listed with", "working with a realtor" (negation-aware: "not working with a realtor yet" is not a match) | none | pause plus a "Check this" handoff card; the owner confirms, then end `has_agent` with a block |
| 15 | pricing_negotiation | request frames: value, list price, "take less", negotiate, commission, fees, Zestimate, appraisal | the fixed pricing line (§6.3); never with comps | **hold_topic** high (seller: comps suspended until the agent acts) |
| 16 | financial | request frames: rates, affordability, down payment, lenders, earnest money | "That's a question for {Agent} or a lender. I've passed it on." | **hold_topic** high |
| 17 | sensitive_personal | health, death, divorce, foreclosure, bankruptcy, disability, immigration, military orders | holding line | terminal high |
| 18 | language | an uncovered language | English holding line | terminal normal |
| 19 | data_unavailable | the client asked for facts the gates refuse | the data-limit sentence plus "{Agent} can go over this with you." | **hold_topic** normal |
| 20 | booking_unavailable | calendar not live, SLOT_TAKEN twice, SLOT_SOURCE_CHANGED twice, or a confirmation that cannot be sent ahead of the slot's notice | "I couldn't confirm a time right now. {Agent} will reach out to set one." | **hold_topic** high |
| 21 | uncertain | a model `escalate{uncertain}`; two schema failures; two guard blocks in a row; an ambiguous slot after one clarification; a failed claim on a readiness basis | holding line | terminal normal |
| 22 | limit / flood | caps, maximum messages or days, flood | none | terminal; low, or high when an inbound is unanswered |

- **hold_topic:** the state becomes `awaiting_agent{class, since}`. An `ai_isa_escalation` card and task are written with the R-ISA-30 SLA. A later inbound on the same topic gets only the holding line, within the caps. The hold clears when the agent acts on the card: "I've handled it; the AI may continue", a human outbound, or for pricing a CMA shared through V2-A. ("A CMA shared through V2-A" means a `cma_reports` row for the contact with status `shared` whose share message went to the lead's own person and is `sent` or `delivered`; a shared CMA whose email was blocked, canceled, failed, bounced or undelivered does not count, and one whose dispatch is unresolved (`dispatching`, `dispatch_unknown`) counts only once it resolves to `sent` or `delivered`. V2-A emits no other event.)
- **Holding lines** never name a time (Q-ISA-13). Each sent line is recorded as a `commitment` on the handoff or escalation.
- **Terminal escalations** write the handoff, with the class, the trigger (deterministic or model) and the client's verbatim quote.

### 4.5 Objective readiness (R-ISA-12)
Readiness is computed by core only from **usable** claims: verified, not needs_review (claimUsable, claims.ts:245-248), with client own text on a bound point (R-ISA-27). It is recorded with the rule id, rule version and claim ids. **Readiness waits while an offer is live**, until the offer is resolved.

| Rule | Buyer | Rule | Seller |
|---|---|---|---|
| B1 | An appointment was booked (§4.6) | S1 | A listing_appointment or consult was booked |
| B2 | A verified request to tour a specific home, make an offer, or talk to the agent now | S2 | A verified request to list, get a price opinion or meet, **plus** a verified intent to sell |
| B3 | Timeline ≤ 90 days (VERIFY), **and** financing_status_stated ∈ {preapproved, cash, talking_to_lender}, **and** areas, budget and beds_min | S3 | seller_timeline ≤ 90 days, **and** seller_owns_stated, **and** not listed elsewhere (stated **and** the MLS check), **and** a confirmed subject (§6.3) |

- A readiness handoff sends one fixed line when the checks pass: "{Agent} will take it from here and be in touch."
- Stated financing is labelled "as stated by the client".
- Disqualifier quotes (has_agent, not_interested, a renter or landlord intent, under 18) pause with a "Check this" card. They never end care by themselves (§4.3 `end`).

### 4.6 The appointment boundary (R-ISA-13)

1. **Verified availability (an offer).**
   - The model's `offer_slots` makes TX-B enqueue `ai_isa.offer` (dedupe `ai_isa.offer:{assignment}:{epoch}`).
   - The job reads live free/busy in its own short system transaction, holding no ISA lock and no lock_contact. It requires `connected` or `degraded` (service.ts:318-340). Any other state means no offer, and `booking_unavailable` is raised.
   - Then TX-O (locks 2→3→4) runs core `computeOffer`. Its inputs: the agent's opt-in windows in their zone, the booking settings, the busy set read just now plus in-app appointments (scheduled or held), 08:00–20:00 in the client's zone set (VERIFY), minimum notice 4 h, horizon 14 days, buffer 15 minutes, and no slot after `inactivity_release_at`.
   - It picks up to 3 slots on different half-days.
   - The `ai_isa_slot_offers` row stores the slots, the `availability_link_id`, `read_at` and an expiry: 24 h, or the first slot's notice time if sooner. Its status is `pending_delivery`; it becomes `offered` in dispatch TX2, or `superseded` if the message is cancelled.
2. **The offer message** is server-rendered, with no model text: "Here are times {Agent} is free: 1) Tue Nov 17, 3:00–3:30 PM ET …". The zone label is always shown, and both zones are shown when they differ.
3. **Explicit agreement to one concrete slot.** `book_slot` is allowed only when **all** of these hold:
   - the offer is `offered` (it was sent);
   - the quote verifies in a client own-text inbound on a bound point **after** the offer, and is not team text (it does not occur in any outbound of the thread or in the offer rendering);
   - for email, `ownTextReliable` holds: core `clientOwnText` dropped `>` lines, "On … wrote:", "-----Original Message-----", Outlook From:/Sent: blocks and everything after them, and the signature;
   - `matchSlotChoice(quote, offer, zones)` maps it to exactly one slot (an index, a matching weekday and time, or a matching date and time), and the model's slot equals it;
   - the send plan shows the confirmation can be dispatched now, or at the next window start, ahead of the slot's minimum notice.

   These are not agreement: "yes" with several slots open, a reaction, "sometime Tuesday", a different time, or a pasted slot line. They get one clarifying question that restates the slots; a second ambiguity escalates `uncertain`.
4. **Atomic booking outside the turn locks.**
   - TX-B marks the offer `accepting` (slot, quote evidence) and enqueues `ai_isa.book` (dedupe `ai_isa.book:{offer}`).
   - The job runs `bookSlotInTx(tx, deps, input, {requireLiveCalendar: true, expectLinkId})`. This is a flagged extraction of bookSlot's body (service.ts:394-428), holding only lock 5. It:
     - takes the person's booking lock;
     - re-reads live free/busy and in-app appointments;
     - returns CALENDAR_UNAVAILABLE unless the calendar is connected or degraded (today's bookSlot proceeds on `not_connected`/`needs_reconnect` with an empty busy set and refuses only `unavailable`, service.ts:407);
     - returns SLOT_SOURCE_CHANGED when the live link id differs from the offer's, which means a new offer;
     - returns SLOT_TAKEN with `nextSlot`; the AI then makes a new offer and never books the alternative;
     - refuses MEMBER_NOT_ACTIVE;
     - (batch 13 integration, b12 recheck R3 for this path) books on the record's root survivor (`app.contact_merge_root`), read again under lock 5 just before the insert, with the record's and the root's `contacts` rows held FOR SHARE NOWAIT until the job's transaction commits. The contact locks come before lock 5 in the global order, so they are not taken here; NOWAIT never waits. A merge re-points the record's appointments (0072) in the statement that writes the record's row, so with the rows held it cannot re-point before this insert commits. A record being written right now (a merge in flight) returns CONTACT_BUSY: nothing is decided, the offer stays `accepting` and the job runs again 5 s later (its expiry still bounds the retries).

     `bookSlot` passes `{requireLiveCalendar: false}`, so its behaviour and tests are unchanged.
   - Then TX-C (locks 2→3→4) records the result. When booked and care is still live, it writes the handoff (`appointment_booked`) and queues the confirmation as the handoff's pending message. When care is no longer live, the handoff says "booked; confirmation not sent". A GrantRevoked during the booking is written by `revokeLinkAsSystem` in the job's own transaction, so a later rollback cannot lose it.
5. **No double booking.**
   - **The gap on main:** a human `createAppointment` inserts first and takes the person lock afterwards (apps/api/src/workspace/appointments.ts:87-98; apps/api/src/calendar/hooks.ts:13-17).
   - **The fix in 0080:** a `BEFORE INSERT OR UPDATE OF starts_at, ends_at, status, user_id` trigger on `appointments` takes `pg_advisory_xact_lock(hashtextextended('calendar.book:'||tenant||':'||user_id, 0))` before the row is written (the same key as links.ts:174-176; re-entrant inside the booking job).
   - For `created_by_kind='assistant'` rows the trigger raises `APPOINTMENT_OVERLAP` on any overlapping scheduled or held appointment of the organizer.
   - A human may still overlap their own calendar, with the warning "Overlaps your 3:00 PM appointment".
   - Accepted offers are unique per `offer_id`, and `ai_isa_slot_offers.appointment_id` is unique.
   - One open AI ISA appointment per person (appointments_open_contact_idx, 0035:346).
6. **Residual risk.** An external event added seconds after the read cannot be locked. The handoff states "your calendar showed this time free at 14:02:11".
7. **Confirmation** (category `ai_isa_confirmation`, purpose marketing, the post-handoff closed set):
   - "You're set with {Agent} on Tue Nov 17, 3:00–3:30 PM ET ({kind}). {Agent} will confirm the details." No location is promised.
   - The external push is the existing job (push.ts:154-213).
   - If the confirmation is refused or cancelled, the package says "confirmation not sent: confirm by hand" and the card becomes critical. ISA-2b as built (batch 13 audit ISA2B-09): except a refusal because a person reached them first (ISA_HANDOFF_CLOSED, the post-handoff closed set): the card says so (AI_ISA_CONFIRMATION_NOT_NEEDED) and nothing goes hot. A cancel by a non-acknowledgement inbound, a failure, an undelivered result or the CONFIRMATION_LATE sweep (the policy's notice, kept with the appointment) is hot. Batch 13 integration: a hand confirmation is asked for only when one is possible. When D1 leaves the person no text, call or email (a person-level do-not-contact, or every channel opted out), the card says the confirmation was not sent and cannot be confirmed by hand, and asks to keep or cancel the appointment (AI_ISA_CONFIRMATION_NOT_SENT_UNREACHABLE); the notification reads "Appointment not confirmed", and no deadline is set or pulled in. A handoff with no deadline (sla_class 'none') never gets one from a confirmation that did not go out. b13 review B13S-3: the web says it the same way. The handoff view and the panel's handoff carry `confirmationNotSent` ('by_hand', 'unreachable' or 'not_needed'; isa/handoff.ts confirmationNotSentOf, read now on the merge root), and the panel, the feed card (its pending line and the next step, shown as "Keep or cancel the appointment" when unreachable) and the thread banner read it; the frozen CONFIRMATION_NOT_SENT note says only that it was not sent. b13 review B13-MRG-3: a confirmation a step planned but could not queue is stored 'refused' with that note and the same card.
8. **Kinds:** buyer `buyer_consult`, seller `listing_appointment`, phone `consult` (CHECK at 0001:2085). `created_by_kind='assistant'`, `set_by_user_id` NULL.
- **ISA-2b (as built).** confirmationInTime's nextSendAt is the latest of the reply window, the instant the person's rolling AI and automated 24 h counts fall below the caps, and the last AI outbound plus the minimum gap. Acknowledgements ("ok", "great", "perfect", a tapback) are never agreement, even to a one-slot offer: one clarification (Q10; VERIFY WITH COUNSEL). The book job runs two transactions: tx#1 (lock 5, the offer FOR UPDATE; CARE_NOT_LIVE, CARE_PAUSED, CONFIRMATION_ON_HOLD, OFFER_EXPIRED, CONFIRMATION_TOO_LATE, APPOINTMENT_ALREADY_SET, then bookSlotInTx with the offer's link) and TX-C (locks 2→3→4). Codes core lacks reach the machine as CALENDAR_UNAVAILABLE, the honest code kept on the row and the turn. Booked while paused after the read: the handoff has no confirmation and the notes BOOKED_WHILE_PAUSED, CONFIRMATION_NOT_SENT; its confirmation status is `refused` (not sent), as for a confirmation refused at queue time. Booked after care ended: a separate critical card ("Booked {time} after AI care ended; the confirmation was not sent: confirm or cancel it yourself."). Booked but the machine did not end: a system pause (check_this) and the same card. One open appointment per person per organizer (the cross-organizer residual is stated in DATA_MODEL R-ISA-13).

### 4.7 The handoff package and its deadline (R-ISA-14, R-ISA-30)
- **Exactly one per assignment.** Every end writes one: an `assistant_actions` row of kind `ai_isa_handoff` (category and autonomy internal) with dedupe `ai_isa_handoff:{assignment}`, plus one `ai_isa_handoffs` row (unique assignment_id).
- **The package is frozen** as `ai_isa_handoffs.package jsonb` (ids, codes and verified quotes), with `package_sha256` computed over it. It is immutable except for `acknowledged_*`, `sla_*` and the confirmation status.
- **Contents:**
  - reason and basis: the rule, rule version and claim ids; or the class, its trigger and the client's quote;
  - the appointment: id, kind, times, organizer, the agreed quote and its message, the offer, the availability read time and the confirmation status;
  - `openOffer {slots, deliveredAt, expiresAt, lastClientReplyAboutIt}` when an offer was live. It is closed with the holding line "{Agent} will confirm a time with you directly" when the checks pass (ISA-2b as built, cut 2, batch 13 audit ISA2B-04: not built in the API; the offer row is superseded and the card shows it, but no closing line is sent);
  - the qualification table: field, value, quote, message id, review status;
  - the conversation: every turn with its decision codes;
  - **the facts sent**: only `ai_isa_shared_facts` rows with status `sent`;
  - commitments: the holding lines that were sent;
  - open questions;
  - next steps, as deterministic codes with one-tap actions: `confirm_appointment`, `call_now` (only when `phoneCallbackAllowed`), `prepare_cma` (seller; links V1-C's `POST /contacts/:id/cma`), `approve_saved_search`, `review_saved_search` (an AI-origin search, §6.2), `answer_pricing_question`, `reply_to_complaint`, `review_fair_housing_question`, `review_consent`, `confirm_subject`;
  - the consent basis per channel, the caps used, and the zone set and its source;
  - an optional "AI summary (check this)": a needs_review suggestion claim screened by `screenModelDraft` with every flag blocking, plus the ISA number and link guard. It is shown only on the handoff card, never in a notification, task title or push.
- **Post-handoff messages** (`ai_isa_confirmation`, `ai_isa_holding_line`) are bound to `ai_isa_handoffs.pending_message_id`. The guard allows exactly that message while there has been no human outbound or call since the handoff.
  - A short acknowledgement inbound ("thanks", "ok", "great", a reaction) does not cancel it.
  - Any other inbound, a human outbound or a call cancels it and updates the package.
  - Acknowledging the card does not cancel it. The ack sheet shows "Confirmation scheduled for 9:00 AM their time" with a Cancel button.
- **Response deadline (R-ISA-30)**, in business minutes from routing hours (VERIFY):
  - critical (booked but unconfirmed, human_request, complaint, safety, fraud_risk, consent_dispute, ready): 15 minutes;
  - high: 2 hours;
  - normal: by the end of the next business day.

  It is cleared **only** by a gate-allowed human touch as R-OWN-14 defines it, never by "Got it". "Got it" is the ack route (`POST /ai-isa/handoffs/:id/ack`); the generic Approvals approve and reject refuse a handoff card (`AI_ISA_HANDOFF_USE_ACK`) and the Approvals inbox does not list it, so no generic tap closes its card while the deadline is open (b12 recheck R11). The touch is read on the record the person lives on now (the root survivor of a merge; b12 review B12X-3). A handoff no touch can clear has no deadline (`sla_class` `none`, 0081; b12 review B12X-2, F3): when D1 leaves no human channel to the person (person-level do-not-contact, or every phone and email blocked for text, call and email), or the lead is closed. Its card and notification still go, and it is never counted overdue. **The card closes when the handoff is done (b12 recheck R13):** the system closes every open card of the handoff and executes its `ai_isa_handoff` action (audit `ai_isa.handoff_closed` with the reason) when a human touch meets the deadline (in the sweep's transaction), when someone acknowledges a handoff with no deadline ("Got it" is then all there is to do; if that close fails after the acknowledgement committed, "Got it" still succeeds and says the handoff is not closed yet, and the deadline sweep closes it, b12 recheck R20), when a person closes the lead (spam, do_not_contact, not_a_lead or deleted: a human decision, after which no touch can meet it; the deadline is not recorded as met), and when AI care starts again on the person, but only for an earlier handoff a human touched since it was written (the deadline is then recorded as met by that touch; b12 recheck R16). A restart alone never ends a handoff: an earlier handoff nobody touched keeps its card and its deadline, which still alerts (the restart is no touch and earns no deadline credit, D12). The one exception is the owner's explicit Continue AI care, or a re-attestation of a changed policy, on a paused assignment: that closes the continued-from assignment's own handoff (`care_continued`, b12 recheck R23), because the owner decided on the lead, as when a person closes it; it records no touch and no met deadline, and every other earlier handoff keeps the touch rule. So the deadline ends only on a human touch, on a person closing the lead, or on the owner's explicit Continue for that assignment's own handoff (owner question: confirm this R-ISA-30 amendment). A done handoff never alerts and is never counted overdue; it is done once the system records its close (`closed_reason`), also when its card had already been decided (b12 recheck R21). "Got it" on a handoff with a deadline leaves its card open until the touch. Erasure deletes the card with the person. On a breach, `ai_isa_handoff_overdue` goes to `teamLeadsOf(owner)` (the first-touch escalation mechanism, ownership/decide.ts:188-189, :220), then to Owner/Admin. A handoff with no owner (pond or deactivated) goes to the previous owner's team leads and Owner/Admin: first to whoever holds its card (the previous owner's Team Lead, or an Owner/Admin, as the card moved with the lead), then Owner/Admin (b12 recheck R8). A card already decided does not move with the lead, so it then goes to the Team Lead of the lead's last owner (else an Owner/Admin), never to that owner alone (b12 recheck R10). Task due times come from the deadline. The list and panel show "Waiting on {Agent}: {class} since {time}", and Admin sees a count of overdue handoffs.

---

## 5. Send-time checks for AI ISA messages only

### 5.1 D1 opt-outs first and unchanged; stop signals end care (R-ISA-31)
- **Unchanged and first:** core gate checks 5, 6 and 9 (gate.ts:217-230), and the guard's PERSON_DO_NOT_CONTACT, RECIPIENT_OPTED_OUT (own ∪ the person's SMS points, R-PAR-12) and RECIPIENT_SUPPRESSED (0053:356-390). `optOutExempt` needs `initiator='system'` (gate.ts:166-172; 0053:371-378), so it can never apply.
- **Stop signals.** AFTER triggers (invoker, no new definer) insert an `ai_isa_stop_signals` row keyed by `address_hmac` or `contact_id`, plus an un-deduped `ai_isa.stop_signal` job:
  - on `consent_events`, for event types revoke, expire and import_revert, on any channel and any purpose;
  - on `suppressions`, for any reason (0001:1099-1124);
  - on `contacts.do_not_contact_at` becoming non-null.

  This covers every writer: keyword STOP, opt-out language, a removed-phone STOP that lands on an "Unknown" contact (comms/repos/messages.ts:379-386; inbound.ts:166-181), unsubscribeMessageRecipient (comms/consent.ts:255-276), staff agent_revoke (recordStaffConsent), the provider 21610 revoke (dispatch.ts:399), app.record_person_opt_out (inbound.ts:271), the do_not_call_request outcome, the MMS text-part revoke (telephony S5), Gmail-synced opt-outs (R-GMAIL-9), and stop signals inserted by the merge and ownership paths.
- **Liveness reads the ledger.** An assignment is live only if no stop signal exists, since its start, for any HMAC of the person (every point, removed ones included unless removed_reason is wrong_number) or for any of the person's contact ids. So TX-A, ingestion and the guard treat it as ended at the commit that wrote the signal. The job, or the sweep as a backstop, then:
  - ends the assignment (`opted_out`, `suppressed`, `do_not_contact`, `wrong_number`, `owner_change` or `merged`);
  - cancels its messages as the system;
  - writes the handoff and the person block.
- **The INSERT policy on stop signals** allows any tenant actor (`WITH CHECK (tenant_id = app.tenant_id())`). There is no UPDATE or DELETE. A spurious row can only stop care.
- **A guard refusal in GUARD_DENY_REASONS** (gateInput.ts:155-168) on an AI ISA message ends care. It is never paused or re-planned.
- **The SMS-to-email fallback** applies only after ISA_CONSENT_EVIDENCE_MISSING. It never applies after an opt-out, suppression, do-not-contact, wrong-number or stop-signal refusal. For AI ISA messages, a revoke of either purpose on any of the person's email points blocks all AI email.
- **Person blocks** (`ai_isa_person_blocks`, keyed by contact_id across `contact_person_ids`) are set by the ends `opted_out`, `possible_opt_out`, `complaint`, `wrong_number`, `has_agent`, `ai_declined`, `consent_dispute` and `do_not_contact`. A start is refused AI_ISA_PERSON_DECLINED until there is a new person-initiated inbound after the block **and** an owner attestation. After a STOP it also needs START and a fresh grant at the marketing tier (§5.2). R-CONSENT-8's "Not an opt-out" never lifts an AI block. **VERIFY WITH COUNSEL.**

### 5.2 Consent evidence (R-ISA-9; strict defaults in `platform:ai_isa` rules; **VERIFY WITH COUNSEL**, C-ISA-1/2/4)
Every AI ISA message has `purpose='marketing'`. `message_kind` (reply or initiated) selects the evidence tier only. The kind is computed by core and re-derived by the guard from the database, never taken from the app.

| Tier | When | SMS needs | Email needs |
|---|---|---|---|
| **Reply** | an inbound turn on the same channel, from the bound point (`NEW.to_address`), within the reply window (24 h, VERIFY) of `now()`, and after the last AI outbound on that channel; the content holds only conversation text, holding lines, a slot offer, a booking confirmation or the bot line (no fact) | the person's own inbound as above (basis `own_inbound`, `basis_message_id`) and no revoke of either purpose on any of the person's SMS points. This basis does **not** use the inbound_first_contact grant, which is written only when no outbound came first (inbound.ts:276-288), so on J1 it never exists. Whether an own-inbound reply suffices for AI-composed messages with purpose marketing is **VERIFY WITH COUNSEL** (C-ISA-1). | the own inbound with an aligned DKIM pass, as above, and no email revoke of either purpose on any of the person's email points |
| **Initiated / any fact** | anything else: a first outreach, a follow-up, nurture, any listing, comp or competition fact, or a reply outside the window | a grant (sms, marketing or all) at `express_written` that meets **all** of these: (1) it cites a disclosure that is the inquiry's **own** disclosure (`lead_inquiries.consent_disclosure_id`, 0001:467) and never a lead source's configured fallback (`lead_sources.consent_disclosure_id`, 0001:1022; the inherit path is intake.ts:309-319), or it is a signed_document grant with an evidence object; (2) core finds a tenant name in the **disclosure body**, not in the self-reported `namesSeller` field (packages/core/src/compliance/consent.ts:317-333; apps/api/src/leads/schemas.ts:261-266); (3) `consent_disclosures.scope_stated = true`, with sms and marketing in scope (scopes default to every channel and purpose today, intakeConsent.ts:38-41; a NULL on older rows means refused); (4) it was recorded on or after the D12 effective date in pack rules, or is a signed_document (which skips only the date comparison: the pack must still set the D12 date); (5) it is not imported, not needs_review and not expired, with no later revoke, expire or import_revert of either purpose on any of the person's SMS HMACs; (6) **initiated SMS only:** a `dnc_checks` "not listed" result for the number within 31 days (VERIFY), from the DncProvider (fake in tests), until C-ISA-4 is cleared | a grant (email, marketing or all) at ≥ `inquiry` that meets (1)–(5), is not expired, and has no unsubscribe; check 4's postal address and unsubscribe hint (gate.ts:210-214) and a verified sending domain (gate.ts:204) |

- **`agent_entry`** (at most `express`, 0001 CHECK) never counts for the initiated tier (Q-ISA-4).
- **The AI ISA never writes a grant.** Intake grant writing and inbound.ts:277 are unchanged. The only flagged edit is that `storeDisclosure` records `scope_stated` (made after lead-intake merges).
- **What the turn stores:** `basis_kind`, `consent_event_id` or `basis_message_id`, and `dnc_check_id`. The guard re-derives and re-checks them (§5.4).
- **If SMS fails only on evidence and email passes,** the message goes by email when channels allow it. Otherwise nothing is sent, and the panel says why, for example: "Texts: OK for replies within 24 h of their text. Listings and follow-ups need written consent naming the team, from their own form, plus a fresh Do Not Call check. Not on file."

### 5.3 Quiet hours, zones and caps (R-ISA-10, R-ISA-11)

**Zones.**
- **Explicit** only when `contacts.timezone` is set with `contacts.timezone_source = 'explicit'` (0001:680). The zone is then that one alone.
- **Otherwise the union** of:
  - every phone's area-code zones, removed phones included (new versioned static data `packages/core/src/isa/areaCodes.ts`, every row VERIFY, multi-zone codes list each zone);
  - any `contact_points.timezone` (it has no source column, 0001:854, so it is weak evidence and added to the union);
  - the tenant zone;
  - the zones of the inquiry postal code's state and of the contact addresses' states (new `stateZones.ts`; multi-zone states list each);
  - the conservative continental set {America/New_York, America/Chicago, America/Denver, America/Phoenix, America/Los_Angeles};
  - America/Anchorage or Pacific/Honolulu when any evidence points there (907 or 808, AK or HI).
- This deliberately stops using `resolveRecipientZones`' first-tier-wins rule (tz.ts:285-319: `contactTz ?? pointTz` regardless of source, :305). Core ships `aiIsaRecipientZones`, and a test pins the difference.
- **Window.** `nextWindowStart(at, zones, start, end)` (tz.ts:268-279) gives the earliest instant inside the window in every zone. `null` means no send is possible, and care ends with a handoff `ZONE_WINDOWS_DO_NOT_OVERLAP`. Replies obey the window too. Initiated messages also obey `initiatedDays` and holidays.
- **The guard recomputes the minimum zone set** from DB facts: reference tables `ai_isa_area_code_zones` and `ai_isa_state_zones`, seeded in 0080 and kept equal to the core data by a test. It requires `turn.zones ⊇` that set.
- **TX1 checks offsets.** For each zone, TX1 compares core's UTC offset at now with Postgres's. A mismatch defers the message and alerts. Node ICU and Postgres tzdata versions are recorded on the turn.
- A zone the client states is recorded as a claim and never set automatically. The agent may set an explicit zone (person edit).

**Caps** (content values at or below the pack ceiling; defaults VERIFY, C-ISA-3):

| Scope | Default (ceiling) |
|---|---|
| Person: AI ISA messages (conversation, facts, offers, confirmations and holding lines), across all the person's addresses, rolling 24 h | ≤ 3 (3) |
| Person: **all** automated plus bulk and marketing outbound (first response, alerts, nurture, bulk), rolling 24 h, counted before an AI send | the AI sends only while the total is < 3; the AI yields, the others are unchanged |
| Person: initiated | ≤ 1 per 24 h, ≤ 3 per 7 days |
| Minimum gap between AI outbounds | 120 s |
| Open AI messages per assignment | 1 (partial unique) |
| Assignment messages | ≤ 40, then `limit_reached` and a handoff. Each text counts once, on the first of its results the worker handles (`sent`, `delivered`, `undelivered`, or `failed` after the provider accepted it or may have: a `dispatch_unknown` the reconcile never resolved, `DISPATCH_UNKNOWN_UNRESOLVED`, counts, since the limit is a safety cap and over-counting is the safe side, while a refusal at dispatch does not), so a carrier status that overtakes the `sent` job still counts it (b12 recheck R12, R15) |
| Unanswered initiated in a row | 3 → slow cadence (≥ 14 days); 6 → `dormant`, a handoff |
| Undelivered in a row | 2 → end `delivery_problem`, a handoff |
| Tenant per tenant-local day | ≤ `ai_isa_daily_cap` (default 100, CHECK 0–1,000) and the telephony cap (200); reaching either is a **hold** |

Notes on counting:
- The statuses counted are dispatching, dispatch_unknown, sent, delivered, failed and undelivered (with the IN_FLIGHT set at apps/api/src/assistant/enrollments.ts:37).
- When a cap is reached with an inbound unanswered, R-ISA-29 writes the card and the human answers.
- **ISA-2b.** The guard checks holidays too (`app.ai_isa_us_federal_holiday`, equal to core `usFederalHolidays`: 0081, b12 review B12X-6), together with the weekday rule, whenever the turn's kind OR the derived tier is initiated (0083, lane number 0192; 0081 alone checked the derived tier); the deferral reads `initiatedDays` and `noInitiatedOnHolidays` from the policy, so core, TX1, the deferral and the guard agree.

### 5.4 Where each check is enforced

| Check | Core `canContact` (gate.ts) | dispatch TX1 (fresh reads, under lock_contact, dispatch.ts:143) | DB `app.messages_dispatch_guard` (CREATE OR REPLACE from the newest body: telephony's 0132 after batch 9; 0053:324-433 on main); every read keyed by `NEW.tenant_id` (the function is a definer) |
|---|---|---|---|
| D1 opt-outs | checks 5, 6, 9 unchanged | unchanged | unchanged (:356-390) |
| Category, autonomy, binding | check 0: AI ISA categories skip `policy.autonomous` but require `initiator='assistant'` and `input.aiIsa`, else ISA_NOT_AUTHORIZED; ALWAYS_HUMAN unchanged | builds the `aiIsa` facts | an AI ISA category from a human or system sender, or under any autonomy but `ai_isa_mandate`, refuses ISA_NOT_AUTHORIZED (batch 12); the `ai_isa_mandate` branch requires: `aa.kind='ai_isa_message'`, `aa.status='proposed'` (else ASSISTANT_ACTION_WITHDRAWN); `aa.contact_id = NEW.contact_id = assignment.contact_id`; `turn.message_id = NEW.id`; `turn.channel = NEW.channel`; `NEW.purpose = 'marketing'` (ISA_PURPOSE_MISMATCH); `sha256(NEW.body) = turn.body_sha256` (ISA_BODY_CHANGED); `hmac(NEW.to_address)` = the bound point (ISA_UNBOUND_RECIPIENT); `NEW.channel IN ('sms','email')` and no media |
| Freshness | check 8: for AI ISA categories the conversation pause is replaced by `aiIsa.pinnedSeqCurrent`, `aiIsa.epochCurrent` and `aiIsa.paused`; it **still blocks** when `automation_pause_reason ∈ {opt_out, wrong_number}` | maps stale codes to cancel plus a new turn | `aa.pinned_inbound_seq = conversations.inbound_seq` (ISA_STALE_REPLY); `aa.epoch = assignment.epoch` (ISA_STALE_EPOCH) |
| Liveness | ISA_PAUSED | reads the assignment, the controls and stop signals | `ended_at IS NULL AND paused_at IS NULL`, no stop signal for the person since start, no block (ISA_PAUSED, ISA_STOPPED); or the post-handoff rule (§4.7, ISA_HANDOFF_CLOSED) |
| Chain | check 12a ISA_NOT_AUTHORIZED (the failed links) | reads every link; for the post-handoff closed set only links ≤ 3 (send.ts `aiIsaGateFacts`) | `platform_cleared('platform:ai_isa')`; tenant switches; the version approved with the latest approval hash matching, or superseded only by `narrows_previous` successors; the opt-in active; owner, seq and root on `assignment.contact_id` (`merged_into_contact_id IS NULL`). **Post-handoff exception (batch 12):** an `ai_isa_confirmation` or `ai_isa_holding_line` bound to `ai_isa_handoffs.pending_message_id` (no human outbound or call since the handoff) skips the pause, epoch and pinned-seq checks, the policy version, the opt-in and the owner, seq, root, deleted and membership links, in TX1 and the guard alike: it was approved at handoff, so a later revoke of the opt-in or the policy does not stop it (Q-ISA-27). It is still checked against D1, the binding, stop signals and person blocks, platform:ai_isa, the tenant switches, shared address and active client, unread parts, the seller packs, consent, quiet hours and caps |
| Shared address, active client | 12f ISA_SHARED_ADDRESS, ISA_ACTIVE_CLIENT | reads | no live point with this HMAC on a contact outside `contact_person_ids(NEW.contact_id)`; no open deal or active team listing with the person as a party |
| Unread MMS part | — | — | no `message_text_parts` row pending, unreadable or skipped for an inbound in this conversation after care started (ISA_UNREAD_PART) |
| Channel | 12b ISA_CHANNEL_NOT_ALLOWED | — | as above |
| Consent | 12c ISA_CONSENT_EVIDENCE_MISSING, ISA_REPLY_WINDOW_CLOSED, ISA_DNC_UNVERIFIED | `aiIsaConsentBasis` | re-derives the tier from `messages` (an inbound from `NEW.to_address`, same channel, within `pack.rules.reply_window` of `now()`, after the last AI outbound, an aligned email verdict); for initiated: the grant conditions (1)–(5) and, for SMS, the `dnc_checks` freshness |
| Quiet hours | 12d ISA_QUIET_HOURS, ISA_ZONE_UNRESOLVED, with `localWindowContains` per zone | writes the zones it resolved onto the turn **before** the dispatching UPDATE; the offset check | `turn.zones ⊇` the DB-derived minimum set; `(now() AT TIME ZONE z)::time ∈ [start, end)` for each zone; weekday (pack `initiated_days`) and US federal holiday (`app.ai_isa_us_federal_holiday`, 0081; b12 review B12X-6) for initiated |
| Caps | 12e ISA_CAP_REACHED, ISA_MIN_GAP | counts | takes the sorted `ai_isa.send` locks over every HMAC of the person, counts the statuses above across all the person's addresses (AI plus automated plus bulk), checks the gap, and runs `INSERT INTO ai_isa_daily_counts … VALUES (t, d, 1) ON CONFLICT (tenant_id, local_day) DO UPDATE SET n = ai_isa_daily_counts.n + 1 WHERE ai_isa_daily_counts.n < cap RETURNING n` |
| Seller packs | 12g | the full fact re-check (§6.4) | when an `ai_isa_shared_facts` row of a sold-derived kind names `NEW.id`: `platform_cleared('platform:cma')` and `platform_cleared('platform:ai_isa_seller_data')` |
| Live switches | — | `AI_ISA_LIVE_SENDS=false` with a non-fake adapter fails the message: "AI assistant sending is off on this deployment." TELEPHONY_LIVE_REQUESTS is enforced in the Twilio adapter (lane S1). | — |

**The guard's reason classes** (`ISA_GUARD_REASONS`, beside GUARD_DENY_REASONS, gateInput.ts:155-168). Unmapped guard codes would make the job retry up to 10 times (jobs.ts:98) and die with the message still queued.
- **Deferrable** (ISA_QUIET_HOURS, ISA_CAP_REACHED, ISA_MIN_GAP, ISA_ZONE_UNRESOLVED, and the offset mismatch): set back to `scheduled` at the next window start, or cancel and plan a new turn.
- **Replan** (ISA_STALE_REPLY, ISA_REPLY_WINDOW_CLOSED, FACT_CHANGED): cancel plus a new turn.
- **Terminal** (every other ISA code, and ASSISTANT_ACTION_WITHDRAWN): blocked, with a gate_decision.
- **The opt-out codes in GUARD_DENY_REASONS** end care.

New reason codes go into `ReasonCode` and `explain`, with sentences.
- **ISA-2b.** Quiet hours in the guard: weekday and holiday for initiated by turn kind or derived tier (0083, lane number 0192). FACT_CHANGED (replan) is raised by TX1 when a pending listing fact no longer passes every rule or its status or price changed; an as-of change alone never cancels.

**Rules version and repeated codes (sends-gates/F4).**
- ISA-1 added checks 0, 8 and 12 under `RULES_VERSION = 'core-compliance/3.1.0'` (gate.ts), which goes into `gate_decisions.core_rules_version`. Decisions for every other category are the same as under 3.0.0 (non-interference, property-tested); only the label changed. So no AI ISA decision is stored under the pre-ISA label 3.0.0.
- ISA-2's migration makes the AI ISA categories storable (`gate_decisions.action_category`, §8.1). It changes no gate rule, so it keeps 3.1.0. Any later change to checks 0, 8 or 12, or to any other decision rule, bumps the version in that same change.
- A reason code appears at most once in a decision (R-GATE-5). Check 0 and check 12a both report ISA_NOT_AUTHORIZED for a human or system send that has a failed chain link; the decision names it once.

### 5.5 Live switches (R-ISA-25)
- TELEPHONY_LIVE_REQUESTS=false fails a message with "Live texting and calling are off on this deployment." It is never an opt-out and never retried (lane S1).
- The AI ISA treats the kill switch, AI_ISA_LIVE_SENDS and the daily caps as a **hold** (§3.1): one deployment or tenant banner, no per-lead card, no pause, no self-retry of that message. Turns are deferred, and they resume when the hold clears without anyone clearing a pause.
- AI_ISA_LIVE_SENDS exists because the email adapter has no kill switch of its own. Fakes are unaffected.

---

## 6. Grounding (buyer and seller)

### 6.1 Common rules (R-ISA-7, R-ISA-17, R-ISA-18, R-ISA-21)
- **A message carries either model conversation text or facts, never both.** A facts message has a fixed server intro line, the facts and the footer. It contains no model text, so a fact-only change is re-rendered without a model call. ISA-2b as built (cut 1; batch 13 audit ISA2B-09): the re-render is not built. TX1's FACT_CHANGED cancel is kept; the replan is a new full turn with a model call, whose facts message is built afresh from the bundle of that turn.
- **The model never sees fact content.** Each bundle item it sees is a handle plus fact_kind, status label, beds, baths, property type and locality, from structured fields only. It never sees remarks or description (LISTING_COLS selects `description` and `attributes`, apps/api/src/mls/eligibility.ts:89-91; clientView passes description, packages/core/src/listings/display.ts:104), attributes, brokerage names, addresses, URLs, prices, close data or agent contacts. A gated category appears only as a code (`sold_comps_unavailable: PLATFORM_NOT_CLEARED`).
- **Render only from the DisplayListing** (`applyDisplayRules(client)`, display.ts:57-110). A fact is not sent when its `status`, or its price-kind fields, are in `omittedFields`: listPrice for an asking price; closePrice and closeDate for a sold price.
- **Every fact line carries:**
  - "Source: {MLS name} via {Team}";
  - "Listed by {brokerage}" (R-MLS-4; `requireListingBrokerage`);
  - the status label and price kind;
  - its **own** as-of: "listed as {status} in the MLS as of {row last_seen_in_feed_at, or its connection's lastSyncedAt if earlier}". This is never the freshest connection's date (`mlsAsOf` takes the newest across connections, eligibility.ts:61-65);
  - the pack's attribution and disclaimer, once per message.
- **Row freshness.** Any client-facing status claim needs the row's `last_seen_in_feed_at` within the pack's `max_staleness_hours`. A record can drop out of the replication key (d9-cma-final.txt:288), and nothing purges it.
- **Licensed data only.** A fact must come from a client-eligible connection (eligibility.ts:45-47) and pass clientView. These are **never** used: D10 public records, predictions (R-PRED-4: `apps/api/src/isa/**` and `packages/core/src/isa/**` are added to the no-prediction-import lint, eslint.config.js:147-156), or a third-party AVM.
- **SMS** carries listing and competition facts only when they fit 3 segments with attribution and disclaimer (VERIFY). Otherwise the fact goes by email if its basis passes; if not, the SMS says only "I can email you the details." Sold-derived facts **never** go by SMS (§6.3).
- **Evidence for every factual sentence.**
  - Facts are recorded in `ai_isa_shared_facts` as `pending` in TX-B, then `sent` in TX2, or `canceled` on any other terminal status. The handoff lists only sent rows.
  - Each row stores: listing, connection, price kind and value, status at build, its own as-of, display rules version, gate codes, method version, valuation date, tier, comp-set hash and line hash.
  - Qualification claims need a verbatim client own-text quote.
  - If a shared comp's close price or date changes later, the agent gets a card. Nothing is auto-corrected.
- **The full rendered body** of every message template passes contentGuard. Pending is worded "Pending (not yet sold)", because "under contract" trips CONTRACT_TOPIC (guard.ts:160; autonomy.ts:74 guards the whole rendered message).
- **ISA-2b channel plan (Q7).** A facts message goes on the inbound's channel if its initiated tier passes and, for SMS, the composed body fits 3 segments; else by email if bound and passing; else by SMS with whole listing lines dropped from the end (attribution and disclaimer kept, at least one line); else nothing (FACTS_DO_NOT_FIT). There is no "I can email you" pointer. contentGuard runs over every rendered body. A sent facts message is replaced by a placeholder in later prompts.

### 6.2 Buyer: searches and listings
- **Criteria** are built by core from usable claims into `SearchCriteria` (packages/core/src/assistant/search.ts:17-38). The AI never supplies keywords.
- **Live search:** `searchClientListingsInTx(tx, criteria, limit=12)` in apps/api/src/isa/buyer/search.ts. It returns active or coming-soon MLS rows passing `matchListing` (search.ts:326-345), clientView and row freshness, plus active team listings, deduplicated by mirror. At most 3 per message. Never re-sent: a listing already `sent` to this person in the last 90 days is skipped.
- **Rendering:** "{beds} bd · {baths} ba · {sqft} sq ft · {locality} — listed at $X (asking price) · {Active|Coming soon} · Listed by {brokerage}". A fact the row does not have is left out: an unknown size (every Spark row until the MLS confirms its living-area field, DATA_MODEL R-MLS-7) is never "0 sq ft" or a guess. The address appears only when `InternetAddressDisplayYN` allows it. No photos by SMS.
- **Saved searches.** `propose_saved_search` is refused unless the initiated tier passes on the alert channel. It calls `proposeSavedSearchInTx` (searches.ts:71-99) with `origin: 'ai_isa'`, and it becomes active only on the agent's approval (SAVED_SEARCH_APPROVAL_REQUIRES_HUMAN, 0001:2827-2840; R-AST-10). While care is live, an origin `ai_isa` search sends **no** alerts of its own: its matches become `listing_event`s that are sent under the AI checks. At the handoff it is set to `paused` with "Review this saved search before alerts start" (next step `review_saved_search`). After the owner re-approves, alerts follow D1 as today.
- **The buyer watch** (`ai_isa.buyer_watch`, daily, for buyers without an approved search) emits `listing_event`s for new matches, and for price or status changes of shared listings. A status change comes only from the row's own newer `mls_modified_at`. A shared listing that went pending is mentioned only if the client asks: "Pending (not yet sold), not available".
- **ISA-2b bundle rules (VERIFY WITH MLS).** Leases and rows not yet lease-checked (`mls_normalize_version < 2`, LEASE_UNCHECKED), off-market rows and stale rows are never shared. A team listing is shared only with a live, displayed, client-eligible MLS mirror (so "listed as Active in the MLS as of" is true); an off-MLS, office-exclusive or coming-soon team listing never is (TEAM_NOT_ON_MLS). At the handoff the AI-origin search pauses and its matches of homes the AI already sent are marked alerted with that message.

### 6.3 Seller: comps, competition and market changes (D9 reuse; no second path)

**Permission to compute.**
- A new MATRIX action `ai_isa.seller_facts` with `system: ['assistant']`, agreed with cma-api.
- `compsForSubjectInTx(tx, actor, now, {kind: 'contact_address', contactAddressId}, {contactId, onBehalfOf: {userId}})` (as built, ISA-3; `apps/api/src/cma/service.ts`) refuses unless the actor holds `ai_isa.seller_facts` (system via `assistant` only) and the owner's role holds `cma.prepare` for the contact through `canAsRole` (R-CMA-6; `cma.prepare` has no `system` grant: "Absent: never the system actor", packages/core/src/foundation/authz.ts:514, the MATRIX row at :735). This is re-checked in TX-B and TX1. An architecture test proves no other caller exists.

**The subject (R-ISA-18).**
- It is resolved exactly as V1-C does (d9-cma-final.txt:547-705): the contact's 'property' address → `addressKey` → `mlsRowsAtAddress`, with facts from the newest record (V1-C subject.ts `newest()`); closed records are sale history (E365).
- **Every seller fact capability needs an agent-confirmed subject:** the owner, as themselves, taps "Confirm this is the home they're selling" on the panel, showing the address, the record's date, type, beds and size. This sets `ai_isa_seller_watch.subject_confirmed_by_user_id`, `subject_confirmed_at`, `subject_address_key` and `subject_facts`.
- Any edit to that address clears the confirmation (trigger), and seller facts stop with SUBJECT_UNCONFIRMED.
- A newest record older than 10 years (VERIFY) means SUBJECT_RECORD_OLD: no comps.
- The comps email states: "Compared using your home's MLS record from {date}: {beds} bd, {sqft} sq ft. Tell me if that's changed." It names only the facts the record has (R-MLS-7: no size when the MLS gives none; with neither fact, no list). A correction becomes a needs_review claim for the agent, and comps stop (SUBJECT_DISPUTED) until the agent re-confirms.
- If there is no MLS record, there is no subject: no comps, and the next step is "Prepare a CMA (enter type and size)" (E373's path).

**Comparable recent sales: the complete engine set or nothing.**
- **One pipeline.** `compsForSubjectInTx` is a flagged, side-effect-free export in apps/api/src/cma/service.ts, added after V1-C merges with that lane's agreement. It runs the same `soldCandidates` (V1-A) → `dedupeMirrors` / `listingIdentity` → `prepareCma` (V1-B), without storing a `cma_reports` row (the system actor may not insert one, 0061_cma_schema.sql:339-341).
- **Gates:** V1-C's `clientReadiness` (origin/lane/cma-api:apps/api/src/cma/gates.ts:124), with a flagged `use: 'ai_isa'` parameter, is called at bundle build and again in TX1. The hand-written gate list from revision 1 is deleted. Any blocker means no comps:
  - PLATFORM_NOT_CLEARED;
  - COMPS_HIDDEN (gates.ts:146-148: a blocker in D9, and an automated path cannot remove a comp and recompute);
  - SELLER_WITHHELD and POSSIBLE_LIVE_LISTING on the **subject** (gates.ts:151-165). The comps' own AVM flag is not checked (V6, d9-cma-final.txt:1022);
  - any other code.
- **Packs and licence:** `platform:cma` **and** the new `platform:ai_isa_seller_data` (its scope is stated verbatim: "automated sold comps and nearby sales to seller leads by email, with this wording"), and the licence's `valuation.ai_isa_comps` (stored key, strict default false). V1-A's `valuationUse` currently sends any unknown use to `automatedNotes` (origin/lane/cma-mls-data:packages/core/src/listings/licence.ts:179-181). The flagged fix replaces the ternary with an exhaustive `switch` plus a `never` check. Test: `automated_notes: true` with `ai_isa_comps` absent gives PACK_DOES_NOT_ALLOW.
- **ISA ceilings** (VERIFY): every comp's tier ∈ {subdivision, within_1mi, postal_code, within_3mi}; `area.lookbackMonths === 12` (the engine widens to 24, CMA_DEFAULTS origin/lane/cma-engine:packages/core/src/valuation/types.ts:91); both the size and beds filters applied. Otherwise no comps (E536). At least `minComps` (3, types.ts:92).
- **What is sent:** exactly `result.comps`, all of them (≤ maxComps 6, types.ts:93), in engine order, in **one server-built email** rendered under V2-A's statement rules: `printable`, `statementProminence` and `emailStatementOk` in `apps/api/src/cma/statement.ts` (no substitution, otherwise CMA_STATEMENT_NOT_RENDERABLE). A plain-text email carries no type size, so a state minimum above 12 pt refuses the email (EMAIL_TYPE_SIZE); "prominence at max(12, minPointSize)" applies to a PDF only. By SMS only the pointer line: "I've emailed you the {n} recent sales I found."
- Each comp shows its close price and date, beds, size, its own tier or distance (only when address display and the `subdivision` field allow it, VERIFY C-ISA-8), "Listed by {brokerage}", and its own "why" from the engine.
- **Never sent:** adjusted prices, weights, value, range or back-test.
- **Dedupe** is on the comp-set hash (method version, ordered identities, close prices). A refresh re-sends the full set, labelled "Updated {date}", at most once per 30 days (VERIFY) and only when the hash changed.
- **Relevance and limit lines** are built only from the engine's `area.sentences` and `result.sentences` (filter-skipped and older-sales sentences, origin/lane/cma-engine:packages/core/src/valuation/text.ts:71-93) and each comp's tier. The ISA's own lines are counsel-entered pack data in `platform:ai_isa_seller_data` (engineering placeholders):
  - "These are sales records, not an appraisal or a price for your home."
  - "Condition and updates aren't in the MLS record."
  - "Prices are as recorded in the MLS and may include seller concessions."
  - "Only sales the MLS allows us to show are included." No count of hidden records is ever stated.
  - Then the state statement, the attribution and the as-of date.
- **Merely nearby sales.** They are sent only when the seller asks about a specific sale, the server matches the address key on a verified client quote, and the comp's address display is allowed. Only these engine reasons (NotUsedReason, types.ts:225-245) are rendered: size_not_similar, beds_not_similar, year_built_not_similar, other_property_type. The wording is "Nearby sale, not comparable to your home: {reason}", by email, through the same gates. Any other reason — implausible_price, lease, sale_condition, subject_*, duplicate, excluded_by_agent, not_among_closest or outside_area — means `data_unavailable` to the agent.

**New competing listings** (asking prices; clientView plus the licence's client statuses; allowed before platform:cma, E534).
- **Selection:** core `competingSet` (packages/core/src/listings/competing.ts:100-150) on the confirmed subject. The rule: postal code, `priceBandPct: null`, bedsDelta 1, same property type, a new optional `sqftBandPct: 20` (a flagged additive option, defaulting null; with an unknown subject size it matches nothing, and a candidate without a size never passes it, R-MLS-7), statuses {coming_soon, active, pending}, `onlyDisplayAllowed`, `mlsFeedStale`, and `maxCount` = the candidate count. **Uncapped**, because the sort falls back to UUID order when the subject has no list price (:139-147) and the result is sliced.
- **The seller watch** (`ai_isa.seller_watch`, daily, tenant-local) diffs against `last_snapshot`, keyed by identity:
  - It skips the run and keeps the snapshot when any connection is ineligible or stale, or when the pack or display-rules version changed. The version is stored in the snapshot.
  - Status events come only from the row's own newer `mls_modified_at` and stored status, never from absence: `new_competitor` (coming_soon or active), `competitor_pending`, `competitor_back_on_market`, `competitor_price_change`, `competitor_sold` (it leaves competition; it is a comp candidate only through the sold path), `competitor_off_market`.
  - Each run also re-checks the **subject**: `clientReadiness`, `mlsRowsAtAddress` and `liveNearMatches` (§3.1 table).
- **Rendering:**
  - "New listing near you: {facts} — listed at $X (asking price, not a sale price) · {Coming soon|Active} · Listed by {brokerage}".
  - "Now pending (not yet sold): {facts} — last asking price $X".
  - `competitor_sold` before the sold gates pass is **not** sent and never reaches the prompt.

**Market changes (R-ISA-19).**
- **No sold-derived statistics in v1.** DOM is not in DISPLAY_FIELDS (V1-A types.ts:285-303), the samples are too small, and the trend is a price-direction claim. `seller_market_stats` is reserved.
- **Only the displayable count:** an uncapped count query, same type, beds ±1, size ±20 %, same postal code, display-allowed, fresh rows, by status. **R-MLS-7 (E650):** with an unknown subject size (every Spark subject until the MLS confirms its living-area field) the size band cannot run, so the count query (ISA-3/4, not built yet) runs without it and says so: core `CountSnapshot.sizeFilterApplied` is required, `countSentence` says "similar size" only when it is true, and a count with the band is never compared with one without (the snapshot is reset, like a rule change). "{a} active and {c} coming soon, plus {p} pending, among homes like yours (same type, {b-1}–{b+1} bedrooms, similar size) that the MLS lets us show in {zip}, up from {…} on {date}."
- It is sent only when the active plus coming-soon count changes by ≥ 3 and ≥ 25 % (VERIFY), and is suppressed when the connection set, the display-rules version or the rule changed since the snapshot. At most one per 30 days.
- No forecasts, no "good time to sell", no direction words (MARKET_CLAIM).

**No value range in v1.**
- `share_value_estimate` is refused (CAPABILITY_NOT_AVAILABLE).
- A value or pricing question gets **only** the fixed pricing line: "Putting a price on your home is something {Agent} does with you personally, so I've let {Agent} know." No comps are sent in that turn, or after it until the agent acts (`prepare_cma`, a V2-A share, or "let the assistant keep sharing recent sales"). A V2-A share is a CMA of the contact with status `shared` whose share message has `dispatched_at` set (a blocked or canceled share email does not count).
- Any later value to a lead needs a separate owner decision. It would reverse D9 owner question (m) (home values for past clients only) and need platform:avm, platform:cma, platform:ai_isa_seller_data and a separate valuation use, with "This is an estimate, not an appraisal." (R-AVM-1; gates.ts:19).
- **Forbidden in all text** (the guard, §7.3): "appraisal" except inside the R-AVM-1 negation, "worth", "will sell for", "guarantee", "top dollar", "list at", and the MARKET_CLAIM and COMPARATIVE_CLAIM lexicons.
- **Always human:** pricing strategy, list-price advice, negotiation, listing agreements and commission.

### 6.4 Stale, missing and changed data

| Case | Behaviour |
|---|---|
| Feed stale, or a row unseen beyond `max_staleness_hours` in a fresh feed | That fact is never sent. If the client asked: "I don't have current market data right now. {Agent} can go over it with you." → `data_unavailable` (E535) |
| platform:cma, platform:ai_isa_seller_data or `valuation.ai_isa_comps` missing | No sold comp and no nearby sale. Competition with asking prices still allowed. The panel says why (E534). |
| Subject unconfirmed, disputed, old, not in the MLS, or type or size missing | No comps. Next step "Confirm subject" or "Prepare a CMA" (E536) |
| Fewer than 3 comps, ceilings failed, COMPS_HIDDEN, or only dissimilar sales | No comps, never padded and never partial (E536) |
| A queued fact changes (status, price kind or value, display_allowed, address display, connection eligibility; for the subject the AVM flag and near matches) | TX1 cancels it (FACT_CHANGED). The server re-renders without a model call. One rebuild per turn at most; then send without the fact, or escalate `data_unavailable`. A sync that only moves `last_synced_at` does not cancel; TX1 only requires the connection to be client-eligible (E537). ISA-2b as built (cut 1, buyer facts): the TX1 cancel is kept and the replan runs a new model turn (no server re-render); an as-of-only sync keeps the fact pending (tested). |
| A live listing at the subject: team → end `active_client`; another brokerage → end `listed_elsewhere`; a near match → pause `possible_listing`; AVM N on the subject → SELLER_WITHHELD | (E538) |

---

### 6.5 Seller part as built (lane ISA-3)
Where this differs from §6.1-§6.3 above, this section is what the code does; §6.3's design stands otherwise.
- **Row freshness (§6.1).** On-demand competition offers only rows whose `last_seen_in_feed_at` is within the pack's `max_staleness_hours` (owner question 3: strict). The incremental feed moves `last_seen_in_feed_at` only on a changed record (`mls/sync.ts`), so in practice only rows changed recently are offered; watch events are fresh by construction. **Sold comps are exempt from per-row freshness**: the feed's age (FEED_STALE) decides (owner question 4; VERIFY WITH MLS).
- **Permission (§6.3).** `cma.prepare` has no `system` grant (core authz "Absent: never the system actor"). The assistant holds the new `ai_isa.seller_facts` (system via `assistant` only), and the pipeline also needs the owner's role to hold `cma.prepare` for the contact (`canAsRole`).
- **The pipeline (scope 3).** `compsForSubjectInTx(tx, actor, now, {kind: 'contact_address', contactAddressId}, {contactId, onBehalfOf})` in `apps/api/src/cma/service.ts`: compute() minus the store, include/exclude empty, readiness `clientReadiness(use 'ai_isa')`. Its one caller is `apps/api/src/isa/seller/comps.ts`.
- **The email (scope 6).** The adapter takes facts from the client DisplayListing; the brokerage is the listing's, else the mirror's, else refused; the location is the shown address, else the allowed subdivision, else none; `why` is the engine's first line with a shown address, else "In {tier name}.". Only V1-B's own area sentences (reached, skipped, year-built filter) are rendered, each asserted to be among the engine's; never the value, tier-limit, records-left-out, weight or valuation-date sentences. Statements: one per comp feed for the subject's state, deduplicated, each printable at ≤ 12 pt under V2-A's rules (a fail-closed STUB until V2-A merges). The footer carries each feed's attribution and disclaimer; the as-of is the EARLIEST last sync of the comps' feeds; the pack's `client_lines` must equal ISA-1's `SELLER_DATA_LINES` (PACK_LINES_MISMATCH). The guard and fair housing run over the whole body; the server-text ban over ISA and engine lines only (an MLS disclaimer says "not guaranteed").
- **Competition's channel (scope 7; batch 13, ISA-3 audit F4, F5).** A competition message uses only a channel the assignment binds and the policy allows (ISA-2's `ctx.channels`), as comps do (email only). It goes by SMS only when the whole message as queued (intro, every line, every feed's footer and the longest composed form with the disclosure, sign-off and opt-out hint) fits 3 segments under both `fitsSms` and `smsSegments`; else by email; with no allowed email it is refused (FACTS_DO_NOT_FIT, or CHANNEL_NOT_ALLOWED), never sent as a long SMS. Scope 7's last fallback, the "I can email you the details." pointer by SMS, is not sent (VERIFY with the owner). The footer carries each feed's own attribution and disclaimer, each once, for every feed a line came from (R-MLS-2), as the comps footer does.
- **The E537 re-render (batch 13, ISA-3 audit F6).** When TX1 finds a seller fact changed (H3), it enqueues one `ai_isa.seller_rerender` per turn. The job rebuilds the original message's own kind from its own facts: sold comps are rebuilt whole; competition is rebuilt over the same listings as they are now ("Now pending (not yet sold)", a price change), and a listing that no longer renders is dropped, so the message goes without it. If nothing renders, or comps are refused, the result is DATA_UNAVAILABLE. The rebuilt body and its pending facts go to STUB(ISA-2) `queueFactsMessageInTx` with the original message and turn, and nothing is delivered until ISA-2 builds that function. A message marked as a re-render (`rerenderOf` on its action) that changes again is refused with DATA_UNAVAILABLE and gets no second re-render, so it never loops. VERIFY (ISA-2): DATA_UNAVAILABLE becomes a `data_unavailable` escalation once the queue function exists.
- **Deferred.** The SMS pointer ("I've emailed you the {n} recent sales") is not sent: facts are always initiated under `initiated24h` 1, the pointer is no `IsaLineId`, and beside the email it would be superseded (owner question 8). Nearby sales are not sent: ISA-1 has no action, event or source line for them, so a nearby question goes to the agent as `data_unavailable` and no `nearby_sale` row is written (owner question 11).
- **Counts (§6.3 "Market changes").** Computed for the agent only and never queued (`COUNT_SHARE_ENABLED = false`, owner question 2).
- **Link 10 "Seller home" (§3.1).** A live team listing or mirror at the subject's key ends care `active_client`; another live MLS listing ends it `listed_elsewhere` (also refused at start); an undismissed live near match pauses it `possible_listing`. "Different home" plus the owner's resume lifts the pause; comps stay blocked while that listing is live (owner question 1).
- **The pricing hold (E502).** A `pricing_negotiation` escalation (H6), or a held pricing topic in the bundle, sets `comps_suspended_at`. It clears only on the owner's own CMA for the contact created or re-run after it, a CMA shared after it, or `POST …/ai-isa/seller/resume-comps`. A generic resolve does not clear it. A CMA counts by its own `created_at` only, never `updated_at` (batch 13, ISA-3 audit F1): an unchanged re-tap stores no new row but refreshes the draft's MLS data date whenever the feed has synced, and a supersede or an address relink changes only status or the link, each of which moves `updated_at`. An edit of the draft (PATCH) does not clear it either, since `cma_reports` keeps no content-change time; VERIFY with the owner (question 10).
- **Routes (§9.1).** `GET /contacts/:id/ai-isa/seller` (ai_isa.view; never runs the pipeline), `POST …/ai-isa/confirm-subject` and `…/seller/near-match-different` and `…/seller/resume-comps` (ai_isa.subject_confirm: the live seller assignment's owner), `POST …/ai-isa/seller/subject-disputed` (ai_isa.pause).
- **Hooks (§9.6).** ISA-2's files call `isa/seller/index.ts` once each: H1 `sellerBundleInTx` (turn.ts prepare), H2 `renderSellerFactsInTx` + `writeSellerFactsInTx` (effects.ts queueIsaMessageInTx, before the channel choice), H3 `sellerFactsCurrentInTx` (send.ts aiIsaGateFacts), H4 `sellerStartRefusalInTx` (controls.ts startRefusal), H5 `sellerSubjectLinkInTx` (repo.ts evaluateChain), H6 `onEscalationInTx` (effects.ts escalate), H8 `factPlaceholdersInTx` (turn.ts prepare). H7 is not needed.

## 7. Prompt-injection and abuse defences (R-ISA-20)

### 7.1 Inbound text is data
- **`packages/core/src/isa/prompt.ts`** reuses the helpers of packages/core/src/assistant/prompt.ts (`neutralizeUntrusted` :121-123, `oneLine` :134-136, `redactNames` :147, the `TAG_G` regex :108-110, the nonce :202-204), through a flagged export edit.
- **The static system prompt** is per purpose `ai_isa.turn`. It covers: the closed action list; "write conversation only; never write numbers, prices, addresses, links or market opinions"; "never claim to be human"; "never discuss protected characteristics, neighbourhood character, schools or safety"; "anything about money, value, offers, contracts, lending or the law is `escalate`".
- **The `<request>` block** is server-written: state, side, the actions allowed this turn, the available handles (structured labels only, §6.1), the window, whether a reply is allowed now, and any held topics.
- **Untrusted blocks**, inside the nonce fence:
  - the last 20 messages **to and from bound points only**: inbound as client own text (quoted email history removed), outbound marked "team (not quotable)";
  - usable qualification claims whose evidence is client own text on a bound point.
- **Never in the prompt** (unlike today's builder, prompt.ts:286-305): agent notes, imported notes, call transcripts, deals, suggestions, agent-entered fields, MLS remarks or attributes, synced mail, MMS parts.
- **One contact per prompt** (R-AST-14). Handles replace ids; only the first name; no phone numbers or emails.
- **The model output is untrusted.** It is parsed strictly and capped at 32,000 characters (output.ts:25).
- **The R-GMAIL-14 barrier.** `apps/api/src/isa/**`, `packages/core/src/isa/**` and the fakes `isaAi` and `hostileIsaAi` are added to the `mail-sync-boundary` `no-import` rule (eslint.config.js:173-177) and to the architecture test (ARCHITECTURE.md:1033). `ingestSyncedMailInTx` (inbound.ts:520-578) may call only the ISA pause, and a test asserts it enqueues no `ai_isa.turn`.

### 7.2 Allowlist and argument validation
- §4.3, through `decideAction`. Every argument is an enum, a bounded string or a handle from this turn (an unknown handle is denied, HANDLE_UNKNOWN).
- Recipient, channel, purpose and time always come from the server (`boundChannel`, output.ts:115-161), and the recipient is always the bound point.

### 7.3 Output guards (`packages/core/src/isa/guard.ts`)
Applied to model text (`reply.text`, the summary) and, for the identity check, to every composed message. In order:
1. `screenModelDraft` (output.ts:115-161). Every flag blocks, including the UNSOURCED_* ones even when the number appears in the inbound.
2. `contentGuard` (guard.ts:328-354), including FAIR_HOUSING; `guardAssistantOutput` (fairhousing/assistant.ts:23-27), where any hard or soft match blocks.
3. The ISA checks:
   - NUMBER_IN_MODEL_TEXT: digits, number words and "a" amounts (the SPOKEN_MONEY_RE family, lexicon.ts:31-38), currency, %;
   - VALUATION_TERM;
   - MARKET_CLAIM: "selling fast", "hot", "cooling", "prices are rising or falling", "buyer's market", "seller's market", "good time to sell";
   - COMPARATIVE_CLAIM: "more than yours", "your home would", "better value", "best value";
   - COMMITMENT_TERM: "you're booked", "I'll make sure", "guarantee", "promise", "we will get";
   - LINK_IN_MODEL_TEXT;
   - AREA_DESCRIPTOR: safe, family-friendly, good schools, crime, "type of people";
   - IDENTITY: an "I'm {name}" that is not the assistant identity;
   - AI_IDENTITY_MISSING: a composed message without the platform disclosure or sign-off.
4. **On a block,** the turn sends the class's fixed line (pricing → the pricing line; fair housing → the area line; otherwise the holding line), or nothing. Two blocks in a row escalate `uncertain`.

**Server-added parts, from platform constants in `platform:ai_isa` (VERIFY WITH COUNSEL, C-ISA-5):**
- the disclosure on the first AI message in a thread: "Hi, this is {Agent first name}'s AI assistant at {Brokerage}.";
- every message's sign-off: "— {Agent first name}'s AI assistant, {Brokerage}" (this also satisfies check 4 for marketing SMS, gate.ts:208-209);
- "Reply STOP to opt out" on the first message and on initiated messages after 7 days of silence (VERIFY);
- for email: the From display name "{Agent}'s AI assistant ({Team})" (a flagged edit at dispatch.ts:266). Reply-To stays the conversation token address (dispatch.ts:268-270), because that is how the reply routes back to the contact (inbound.ts:156-158). The postal address and unsubscribe are added by check 4 and List-Unsubscribe.

### 7.4 The model-output schema
```ts
{ reply: { text: string } | null;
  qualification: { field: QualField; value: QualValue; quote: string; source: `S${number}` }[];   // ≤ 10, inbound sources only
  actions: AiIsaAction[];                                                                        // ≤ 4
  summary: string | null }                                                                       // ≤ 300, screened, handoff card only
```
- Strict: unknown keys, wrong types or extra handles fail the parse.
- One repair retry happens with a server note of the schema error (no model text is echoed). A second failure means no send and `uncertain`.
- `ai_isa_turns.decision` and `.denied` hold codes and handles only, enforced by a CHECK against a jsonb shape of keys and an enum of codes. Prompts and outputs stay in `ai_runs.output_enc` (purged after 30 days, 0001:1490-1511).

### 7.5 Rate limits and abuse
- Inbounds are debounced (§4.2).
- The per-person (12) and tenant (1,000) model budgets fail closed with `limit`, high priority when an inbound is unanswered.
- Flood escalation. One turn at a time. Inbound bodies over 1,600 characters are truncated and flagged.
- There is no reach without an explicit start by the owner, and no turn except from a bound point.
- **The hostile suite** `HostileIsaAi` extends apps/api/src/providers/fake/hostileAi.ts:25-38 with: unoffered_slot, unverified_quote, team_text_quote, quoted_email_slot, price_number, a_grand, appraisal_word, market_claim, comparative_claim, promise, human_claim, missing_disclosure, other_contact_handle, recipient_override, unsourced_phone, fh_steering, ready_without_evidence, negated_value, deescalate, free_text_note, summary_injection, oversized, schema, listing_not_in_bundle, comps_subset, comps_when_gated, sold_event_paraphrase.

---

## 8. Data model (`0080_ai_isa.sql`, lane number 0190, owned by ISA-2; `0084_ai_isa_seller.sql`, lane number 0191, owned by ISA-3, which applies after 0080)

Every new tenant table has:
- the composite `(tenant_id, id)` key and FORCE RLS;
- tenant policies and the RESTRICTIVE `support_read_only_*` policies (0018:1834-1836);
- a row in the schema-invariants tests.

Every CREATE OR REPLACE starts from the object's newest definition at merge time. No existing migration is edited, and the orchestrator renumbers.

### 8.1 Changed objects

| Object | Change |
|---|---|
| `tenant_settings` | `ai_isa_enabled boolean NOT NULL DEFAULT false`, `ai_isa_enabled_by uuid`, `ai_isa_enabled_at timestamptz`, `ai_isa_daily_cap integer NOT NULL DEFAULT 100 CHECK (BETWEEN 0 AND 1000)`. A guard in the style of 0021:758-766: only the Owner turns it on or raises the cap. |
| `jurisdiction_packs` | `('platform:ai_isa','2026.11.0','published', rules, NULL, 'AI ISA texting and email: consent tiers, quiet hours, caps, AI disclosure and sign-off constants, reply window, DNC freshness, D12 effective date (C-ISA-1…7, 11, 12). Engineering placeholder. VERIFY WITH COUNSEL.')`; `('platform:ai_isa_seller_data', …, 'Automated sold comps and nearby sales to seller leads by email, and the client wording for them (C-ISA-8, 9). Engineering placeholder. VERIFY WITH COUNSEL / MLS.')`. Both are added to PACK_GATES (apps/api/src/integrations/catalog.ts:120). |
| `playbooks.kind` CHECK, `playbook_versions` | add `ai_isa`; `CHECK (kind <> 'ai_isa' OR scope = 'team')`; `narrows_previous boolean` (set by core at approval, ai_isa only) |
| `playbook_enrollments` guard | a new live enrollment is refused while the contact has a live assignment (`AI_ISA_ACTIVE`); `stop_reason` gains `ai_isa_started` |
| `assistant_actions` | `kind` adds `ai_isa_message`, `ai_isa_handoff`. `action_category` adds `ai_isa_message`, `ai_isa_confirmation`, `ai_isa_holding_line`. `autonomy` adds `ai_isa_mandate`. New columns `ai_isa_turn_id uuid` (FK) and `epoch int`. CHECK: `(autonomy='ai_isa_mandate') = (kind='ai_isa_message' AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') AND ai_isa_turn_id IS NOT NULL AND playbook_version_id IS NOT NULL AND epoch IS NOT NULL)`; `kind <> 'ai_isa_handoff' OR (autonomy='internal' AND action_category='internal')`. The CHECKs at 0001:1634-1639 still hold. Partial unique `(tenant_id, contact_id) WHERE kind='ai_isa_message' AND status='proposed'`. |
| `messages` | `action_category` has no CHECK (0001): the dispatch guard refuses the three categories outside the mandate for every sender, `ISA_NOT_AUTHORIZED` (a human or system sender, and an assistant sender whose action is not `ai_isa_mandate`; batch 12, isa-2-2); `email_dkim_aligned boolean` (provider verdict, written at email ingestion) |
| `gate_decisions.action_category` | adds the three |
| `consent_disclosures` | `scope_stated boolean` (written by `storeDisclosure`; NULL on older rows) |
| `ai_runs.purpose` | adds `ai_isa_turn`, `ai_isa_summary` (core AiPurpose, types.ts:101-121) |
| `notifications.kind` | adds `ai_isa_handoff`, `ai_isa_handoff_hot` (never muted), `ai_isa_escalation`, `ai_isa_ended`, `ai_isa_paused`, `ai_isa_handoff_overdue` (never muted) |
| `priority_feed_items.item_type` | adds `ai_isa_handoff`, `ai_isa_activity`, `ai_isa_escalation` |
| `appointments` | the lock and overlap trigger (§4.6) |
| `consent_events`, `suppressions`, `contacts` | AFTER triggers that insert stop signals and an `ai_isa.stop_signal` job (no dedupe key, so a trigger can never abort the writer's transaction on a duplicate) |
| `app.messages_dispatch_guard()` | the `ai_isa_mandate` branch (§5.4); still SECURITY DEFINER, owned by app_definer |
| audit registry (authz.ts:174+) | `ai_isa.tenant_enabled`, `.tenant_disabled`, `.tenant_cap_changed` (old and new values), `.optin_created`, `.optin_narrowed`, `.optin_superseded`, `.optin_revoked`, `.assignment_started`, `.assignment_paused`, `.assignment_resumed`, `.assignment_taken_over`, `.assignment_ended`, `.pause_all`, `.undo`, `.subject_confirmed`, `.subject_cleared` (b13 review B13-MRG-4: written by the people address routes, as the editor, when their write clears a confirmed home in the database), `.subject_disputed`, `.comps_suspended` (b13 review B13-MRG-4: the system, on a pricing hold, a held topic or a continuation's carry), `.comps_resumed` (the owner's resume-comps, or the system after the owner's CMA or a share that reached the lead), `.near_match_dismissed`, `.slot_booked`, `.booking_refused`, `.handoff_created`, `.handoff_acknowledged`, `.handoff_closed` (the system closed a done handoff's card; the reason code only, b12 recheck R13, R22), `.system_paused`, `.system_ended`, `.block_lifted`. Each carries codes only (no content) and the job id for system events. |
| MATRIX | `settings.ai_isa`, `ai_isa.optin`, `ai_isa.assignment.*`, `ai_isa.seller_facts` (system: assistant), `ai_isa.subject_confirm` |

### 8.2 New tables

**`ai_isa_agent_optins`**
- Columns: tenant_id, id, user_id, playbook_version_id, attestation text, attestation_sha256 (= sha256(attestation), which must contain the version hash; the guard recomputes it), capabilities text[] (CHECK subset), channels text[], timezone (validated), availability jsonb, booking jsonb, status active|superseded|revoked, revoked_*, created_at.
- Partial unique (tenant_id, user_id) WHERE status='active'.
- INSERT only by the user as themselves, with an eligible role, for an approved ai_isa version. The status may move to superseded or revoked only.

**`ai_isa_assignments`**
- Columns:
  - tenant_id, id, contact_id, owner_user_id, optin_id, playbook_version_id, bound_ownership_seq;
  - bound_points jsonb (`{sms:{point_id,hmac}, email:{point_id,hmac}}`);
  - side; state; awaiting_agent jsonb; epoch;
  - started_by_user_id, started_at, from_handback_id, continued_from_assignment_id;
  - paused_at, paused_by_kind, paused_by_user_id, pause_reason;
  - ended_at, end_reason;
  - consent_snapshot;
  - counters (messages_sent, unanswered_initiated, undelivered_streak, last_inbound_seq);
  - next_follow_up_at, updated_at.
- Partial unique (tenant_id, contact_id) WHERE ended_at IS NULL.
- **INSERT guard:** started_by = app.user_id() = contacts.owner_user_id; seq matches; root; opt-in active and the owner's; version approved; no person block; first touch recorded.
- **UPDATE guard:**
  - the immutable columns never change;
  - a user may set `paused_*` (contact detail visible plus comms.send);
  - a user may set `ended_*` (the owner, the TL for their team, Owner/Admin);
  - `paused_at` may be cleared only when `actor_kind='user' AND user_id = owner_user_id`, while the chain holds, and the epoch increments;
  - the system may set state, counters, timers, `paused_*` and `ended_*`, and never clears `paused_at`;
  - `ended_*` is final.

**`ai_isa_controls`** (insert-only)
- Columns: tenant_id, id, assignment_id, kind pause|resume|take_over|end|undo|finalize, by_kind, by_user_id, reason, created_at.

**`ai_isa_stop_signals`** (insert-only)
- Columns: tenant_id, id, address_hmac bytea NULL, contact_id uuid NULL (CHECK one of them), reason, source_table, source_id, created_at. Indexed by (tenant, address_hmac) and (tenant, contact_id).

**`ai_isa_person_blocks`**
- Columns: tenant_id, id, contact_id, reason, created_at, lifted_at, lifted_by_user_id, lift_inbound_message_id, lift_attestation. Lifting requires the inbound and attestation conditions of §5.1.

**`ai_isa_turns`** (the system appends; status changes only through attempt-guarded updates)
- Columns:
  - tenant_id, id, assignment_id, seq, epoch, attempt;
  - trigger_kind, trigger_key (unique per assignment);
  - pinned_inbound_seq, state_before, state_after;
  - status: deciding | sending | sent | deferred | no_reply | stale | canceled_paused | blocked | canceled | unknown | escalated | handed_off;
  - ai_run_id, assistant_action_id, message_id;
  - channel, purpose ('marketing'), message_kind;
  - basis_kind, consent_event_id, basis_message_id, dnc_check_id;
  - zones text[] (cardinality ≥ 1, each in `pg_timezone_names`), zone_source, icu_tz_version, pg_tzdata_version;
  - window_start, window_end, not_before;
  - body_sha256;
  - decision jsonb and denied jsonb (codes and handles only, CHECK);
  - rules_version, policy_version, prompt_version;
  - created_at, updated_at.

**`ai_isa_slot_offers`**
- Columns: tenant_id, id, assignment_id, turn_id, organizer_user_id, kind, slots (≤ 3), availability_link_id, read_at, expires_at, offered_message_id, status pending_delivery|offered|accepting|accepted|expired|superseded, accepted_slot, accepted_message_id, accepted_quote_evidence_id, appointment_id.
- Partial unique (assignment_id) WHERE status IN ('pending_delivery','offered','accepting'). Unique (appointment_id).

**`ai_isa_shared_facts`**
- Columns: tenant_id, id, assignment_id, contact_id, turn_id, message_id, status pending|sent|canceled, fact_kind (listing_active, listing_coming_soon, listing_pending, competitor, sold_comp_set, nearby_sale, competition_count), listing_id, mls_connection_id, price_kind, price_cents, status_at_build, as_of, display_rules_version, gate jsonb (codes), method_version, valuation_date, tier, comp_set_hash, line_sha256, created_at.
- Partial unique (message_id, listing_id, fact_kind) WHERE status='sent'.

**`ai_isa_handoffs`**
- Columns: tenant_id, id, assignment_id (unique), reason, basis, assistant_action_id, appointment_id, package jsonb (frozen), package_sha256, pending_message_id, confirmation_status, sla_class, sla_due_at, sla_met_at, sla_escalated_at, recipient_user_id, acknowledged_*, created_at, closed_at and closed_reason (`deadline_met`, `acknowledged`, `lead_closed`, `care_restarted`, `care_continued`: why the system closed the handoff; system-only and final, 0081; b12 recheck R19, R23), sweep_failure_count (the deadline sweep's failed passes on the handoff; system-only, 0081; b12 recheck R24).

**`ai_isa_daily_counts`**
- Columns: tenant_id, local_day, n; PK (tenant_id, local_day). Written only by the guard.

**`ai_isa_area_code_zones`, `ai_isa_state_zones`** (global reference data, like `jurisdiction_packs`)
- Readable by app roles; seeded in 0080; no tenant column. A test checks equality with the core data.

**`ai_isa_seller_watch`** (`0084_ai_isa_seller`, lane number 0191, which applies after 0080)
- Columns: tenant_id, assignment_id (PK), contact_address_id, subject_address_key, subject_connection_id, subject_confirmed_by_user_id, subject_confirmed_at, subject_facts, subject_record_date, last_snapshot, snapshot_versions, last_comp_set_hash, comps_suspended_until_agent boolean, last_run_at, last_shared_at, last_count_share_at.
- The confirmation is cleared by a trigger on the contact address.
- **As built (ISA-3):** see DATA_MODEL Part 2 "`ai_isa_seller_watch`" (the columns, the invoker guard and RLS; UPDATE is the contact-detail audience narrowed by the guard, wider than §8.3 so the address trigger runs as the editor).

### 8.3 RLS per role

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| optins | self; Owner/Admin all; TL for team members | self | status only (self, Owner/Admin, system) | none |
| assignments, controls | `app.contact_detail_visible(tenant, contact)` (0039:171), or tenant-wide | owner as self (guard); controls: anyone allowed to control (guard) | per the guard; controls: none | none |
| turns, slot_offers, shared_facts, handoffs | the contact-detail audience, staff only | system only | system; handoffs: the recipient may set acknowledged_* | none |
| seller_watch (as built, 0084) | tenant-wide, the contact-detail audience, or the root survivor's (0081's rule), staff only | the system, or the assignment's owner as themselves (never a user route other than the owner's: ISA-3 audit F2) | the system, tenant-wide, the contact-detail audience or the root survivor's, narrowed by the invoker guard: only the live owner confirms, dismisses a near match or resumes comps; the system never confirms; any other user only clears the subject or marks it disputed; a user repoints the address only by confirming, and the cleared reason changes only with a clear (ISA-3 audit F11); the address trigger runs as the editor | none (cascade with the assignment) |
| stop_signals | contact-detail audience; tenant-wide | any tenant actor (`tenant_id = app.tenant_id()`) | none | none |
| person_blocks | contact-detail audience | system | system; the owner lifts (guard) | none |
| daily_counts | Owner/Admin | guard | guard | none |

Support is read-only everywhere. Retention follows the messages and contact erasure: everything cascades from contacts or assignments.

**Erasure and the retention purge (batch 12, isa-2-1).** `app.purge_contact_internal` (0041) deletes the person's contacts rows and the children cascade: the assignments, then their controls, turns, shared facts, slot offers and handoffs, and the person blocks. The insert-only and frozen guards let exactly that cascade through and nothing else:
- a control row is deleted only by the foreign-key cascade of its deleted assignment (fired from the cascade, the parent row already gone); a direct DELETE still refuses `AI_ISA_LEDGER_APPEND_ONLY`;
- a turn's or a fact's bound `message_id` becomes NULL only by its ON DELETE SET NULL (the message row already gone, every other column unchanged); any other change still refuses `AI_ISA_TURN_PLAN_FROZEN` or `AI_ISA_FACT_FROZEN`;
- `ai_isa_handoffs.assistant_action_id` is ON DELETE CASCADE: only erasure deletes an assistant action.

Nobody else can delete an assignment or an action (no DELETE grant); the only other message delete is the import revert's (0009/0010), of imported messages, which no turn or fact binds. **`ai_isa_stop_signals` rows survive erasure** as opt-out evidence, as `consent_events` do: the table has no foreign key, and a row keeps only the keyed `address_hmac` or the erased contact's id (a uuid that no longer resolves), never an address or words. The rls_smoke_ai_isa erasure tests erase a person with an ended assignment, controls, a sent turn and fact, a handoff and a queued confirmation, and have the retention sweep purge such a person together with another due person in the same run. VERIFY WITH COUNSEL whether the contact-keyed stop signals of an erased person should be deleted instead.

### 8.4 Definers
- **No new SECURITY DEFINER function.** The only changed definer is `app.messages_dispatch_guard` (already a definer, 0053:323). It must read the AI ISA tables, packs, consent, dnc_checks and message_text_parts whatever the caller.
- **The new triggers run as invoker:**
  - stop signals: the INSERT policy allows any tenant actor, and the job enqueue uses the existing app_user INSERT on jobs;
  - the assignment guards;
  - the appointments lock: the advisory lock needs no table access, and the overlap read is of the same tenant's appointments;
  - zone validation (a catalog view).

---

## 9. API and worker (module 75, `apps/api/src/isa/**`)

### 9.1 Routes
All routes are under MATRIX rows. No response carries confidence or score fields (R-AST-13).
- **Tenant:** `GET /admin/ai-isa`; `PUT /admin/ai-isa {enabled, dailyCap}` (`settings.ai_isa`).
- **Agent:** `GET /me/ai-isa`; `PUT /me/ai-isa/opt-in` (re-auth); `POST /me/ai-isa/opt-in/revoke`; `POST /me/ai-isa/pause-all`; `POST /me/ai-isa/re-attest` (continuations, §3.2).
- **Team policy:** the playbook routes with `kind: 'ai_isa'`.
- **Leads:**
  - `GET /ai-isa/assignments?scope=mine|team|all&state=`;
  - `GET /contacts/:id/ai-isa` (the panel: chain status per link with its hold, pause or end effect; capabilities in effect; consent basis per channel; zone set and source; next allowed send; caps used; last decision and why; facts sent; open offer; held topics; handoff deadline and `closedReason`, null while the handoff is open, b12 recheck R19; inactivity release date);
  - `GET /contacts/:id/ai-isa/turns`;
  - `POST /contacts/:id/ai-isa/{start|pause|resume|take-over|end|undo|continue|confirm-subject|lift-block}`;
  - `POST /ai-isa/handoffs/:id/ack` (its result carries `closedReason` too); `POST /ai-isa/escalations/:id/resolve`.
- **Seller (as built, ISA-3; `apps/api/src/isa/seller/routes.ts`):** `GET /contacts/:id/ai-isa/seller` (`ai_isa.view`; read as the viewer, never runs the comps pipeline); `POST /contacts/:id/ai-isa/confirm-subject {contactAddressId, recordListingId, factsSha256}`, `POST …/ai-isa/seller/near-match-different {listingIds}` and `POST …/ai-isa/seller/resume-comps` (`ai_isa.subject_confirm`: the live seller assignment's owner, as themselves; audited); `POST …/ai-isa/seller/subject-disputed` (`ai_isa.pause`: anyone who may pause, owner question 9; it never inserts the watch row, so a Team Lead or Admin is not refused by its INSERT policy, ISA-3 audit F2).
- **Errors** (in errors.ts, with sentences): AI_ISA_OFF, AI_ISA_NOT_CLEARED, AI_ISA_POLICY_NOT_APPROVED, AI_ISA_NO_OPTIN, AI_ISA_NOT_OWNER (404 when invisible, R-PERM-5), AI_ISA_ALREADY_ACTIVE, AI_ISA_NO_CHANNEL, AI_ISA_SHARED_ADDRESS, AI_ISA_ACTIVE_CLIENT, AI_ISA_LISTED_ELSEWHERE, AI_ISA_NOT_ROOT, AI_ISA_CALENDAR_REQUIRED, AI_ISA_FIRST_TOUCH_PENDING, AI_ISA_PERSON_DECLINED, AI_ISA_HANDBACK_STALE, AI_ISA_UNDO_EXPIRED, SUBJECT_UNCONFIRMED, CAPABILITY_NOT_AVAILABLE.

### 9.2 Turn processing
The system actor runs it (`via 'assistant'`, apps/api/src/worker/systemActor.ts:1-34).

- **TX-A** (locks 2 → 3 → 4):
  1. Debounce: return `retryAt` (§4.2).
  2. The link-failure table (§3.1). A hold returns `retryAt` before any model call; a pause or end applies it and stops.
  3. Collect the events: inbounds with seq > `last_inbound_seq` that are turns, timers, listing events and stop signals.
  4. The deterministic `step()` (§4.4); a stop class may finish without the model.
  5. Build the bundles from the DB only (buyer search, seller facts through ISA-3, structured labels).
  6. Insert the turn (or, on replay, reuse the row for `trigger_key` with `attempt + 1`) as `deciding`, with `pinned_inbound_seq` and `epoch`.
- **The provider call**, with no lock held (the TX-A/TX-B pattern of apps/api/src/assistant/runs.ts:1-22). One call through the unchanged `AiProvider.complete` (providers/types.ts:148-166). With `ai_enabled=false` there is no call (R-AST-18): a hold of `ai_off` becomes a pause.
- **TX-B** (locks 2 → 3 → 4):
  1. `UPDATE ai_isa_turns SET status='deciding' WHERE id AND status='deciding' AND attempt=:attempt`. Zero rows means discard everything.
  2. If `conversations.inbound_seq > pinned`, the turn is `stale`: re-enqueue with retryAt (E493).
  3. Re-check the chain, the pause and the epoch.
  4. Parse, screen and verify (`normalizeClaims`, claims.ts:185; R-ISA-27).
  5. `decideAction` and the final `step()`.
  6. Write `ai_runs` (encrypted), claims and evidence.
  7. If a message results:
     - withdraw any proposed AI action of the assignment;
     - insert the `assistant_actions` row (kind `ai_isa_message`, `ai_isa_mandate`, `proposed`, `pinned_inbound_seq`, `bound_ownership_seq`, `epoch`, dedupe `ai_isa_msg:{turn}`);
     - compute the send plan (§5);
     - freeze `body_sha256`;
     - queue through `queueOutboundInTx` to the bound point, `scheduled` at `not_before` or `queued`;
     - write the shared facts as `pending`.
  8. For `offer_slots`: enqueue `ai_isa.offer`. For `book_slot`: mark the offer `accepting` and enqueue `ai_isa.book`.
  9. Update the assignment, timers and turn. Commit.
- **Dispatch.** The existing `dispatchOutbound` (TX1, provider, TX2; dispatch.ts:1-32) plus §5.4. TX2 marks the action `executed`, the turn `sent`, the facts `sent` and the offer `offered`. Every other terminal status (blocked, canceled, failed, undelivered, dispatch_unknown from worker/handlers/dispatchStale.ts) emits `send_result` and moves the turn, facts and offer accordingly. Guard reason classes §5.4.
- **Lease recovery: one path, the job lease** (worker/loop.ts:49, :163-172). TX-B is attempt-guarded. The sweep re-enqueues a `deciding` turn only when no pending or running job holds its dedupe key and at least 8 minutes have passed.
- **Other jobs:**
  - `ai_isa.offer`, `ai_isa.book`, `ai_isa.follow_up`;
  - `ai_isa.buyer_watch`, `ai_isa.seller_watch`;
  - `ai_isa.stop_signal`;
  - `ai_isa.finalize` (undo window);
  - `ai_isa.backstop` (R-ISA-29, every minute);
  - `ai_isa.sla` (R-ISA-30);
  - `ai_isa.sweep` (every 5 minutes): stop signals, link failures, offer expiry, stuck turns, pause expiry, inactivity warnings, shared address and active client;
  - `ai_isa.ownership_changed`;
  - `ai_isa.handoff_enrich`.
- **ISA-2b.** `ai_isa.offer` and `ai_isa.book` are standalone jobs (isa/booking/offer.ts, book.ts). A send_result is emitted for every terminal status: blocked, sent, dispatch_unknown and failed in dispatch; canceled from an inbound cancel, the supersede and the care cancel; delivered, undelivered and failed from status callbacks; dispatch_unknown from the stale reaper; the reconciled status from reconcileOutbound (isa/sendResult.ts).

### 9.3 Idempotency

| Thing | Key |
|---|---|
| Turn job | `ai_isa.turn:{assignment}:{epoch}:{seq}`, plus unique (assignment, trigger_key), plus `attempt` |
| Message | `ai_isa_msg:{turn}` (unique, 0001:1643), plus one proposed AI action per contact |
| Offer and booking | `ai_isa.offer:{assignment}:{epoch}`, `ai_isa.book:{offer}`, accepted once, unique appointment_id, the overlap trigger |
| Handoff | unique assignment_id, plus action dedupe `ai_isa_handoff:{assignment}` |
| Backstop card | today's `inbound:{contact}`, plus `handback:ai_isa:{assignment}:{inbound}` |
| Shared fact | unique sent (message, listing, kind); comp-set hash per assignment |
| Start | partial unique live assignment per contact |
| Daily count | the guarded upsert |
| Stop signal job | no dedupe key; the handler is idempotent on the signal id |

### 9.4 The AI provider
- The interface and the real adapter are unchanged (providers/types.ts:148-166; anthropic.ts, "Prompts and outputs are never logged here" :13).
- `FakeIsaAi` (apps/api/src/providers/fake/isaAi.ts) is script-driven, parses handles like `parseFakeSources` (fake/ai.ts:24-53), and always includes one wrong quote (the FAKE_BAD_QUOTE pattern, :21).
- `HostileIsaAi` is the §7.5 suite.
- Production still refuses the fake AI (config.ts:425). No new model or key.

### 9.5 Audit trail
- `audit()` runs in each control's transaction (apps/api/src/audit.ts:314-328), for every human control and every system pause, end, hold start and hold end.
- The ledgers that hold the trail: `ai_isa_turns`, `ai_isa_controls`, `ai_runs`, `assistant_actions`, claims and evidence, `gate_decisions`, `ai_isa_shared_facts` (sent only), `ai_isa_slot_offers`, `ai_isa_handoffs` (frozen package), `ai_isa_stop_signals`, the messages.

### 9.6 Flagged edits outside the owned paths (each small, made after its owner merges)

| File (module) | Edit |
|---|---|
| comms/inbound.ts (22) | the step 7 and 8 branch (`ingestForAiIsaInTx`, assignment FOR SHARE); the turn eligibility of R-ISA-28; the pause calls for call, chat, MMS and synced mail; `ingestSyncedMailInTx` (pause only) |
| comms/repos/messages.ts (22) | `cancelQueuedAssistant` skips post-handoff categories on an acknowledgement-only inbound |
| inbound email adapter path (22) | store `email_dkim_aligned` from the provider verdict (trust.ts logic) |
| comms/dispatch.ts, comms/gateInput.ts (22) | `aiIsa` facts, ISA_GUARD_REASONS, the zone write before dispatching, offsets, fact freshness, AI_ISA_LIVE_SENDS, the From display name, send_result emission, takeover hooks |
| comms/compose.ts (22), comms/dial.ts (22) | takeover on create, schedule and dial; the compose and dial warning data |
| assistant/drafts.ts (25) | takeover on approval; the no-reply branch for `fromHandbackId` |
| core/compliance/{gate.ts,types.ts,explain,inbound.ts} (19) | check 0, check 8 and check 12; codes; export NEGATOR_BEFORE |
| core/assistant/{content.ts,prompt.ts,types.ts} (25) | the `ai_isa` content member, helper exports, AiPurpose |
| core/listings/competing.ts (24) | optional `sqftBandPct` |
| assistant/searches.ts (24) | `origin: 'ai_isa'`, alert suppression while care is live, pause at handoff, export the alert renderer |
| assistant/enrollments.ts, nurture/decide.ts and execute.ts (26) | stop on start; `AI_ISA_ACTIVE`; a trigger firing becomes a listing_event |
| assistant/playbooks.ts (25) | `narrows_previous` at approval (ai_isa) |
| stageAutomation/decide.ts (67) | skip `AI_ISA_ACTIVE` |
| calendar/service.ts (34) | `bookSlotInTx` with options; bookSlot unchanged |
| db ownership/merge.ts, ownership/effects.ts | `ai_isa_message` in the invalidation lists; stop signals in the same transaction |
| leads/intakeConsent.ts (lead-intake) | `scope_stated` in `storeDisclosure` |
| bulk/run.ts and preflight (bulk module) | "N recipients under AI care", with "Skip people under AI care" default on |
| cma/service.ts, cma/gates.ts (71, V1-C) | `compsForSubjectInTx` with `onBehalfOf`; the `clientReadiness` `use` parameter (ISA-3) |
| core/listings/licence.ts (V1-A) | exhaustive switch; `valuation.ai_isa_comps` (ISA-3) |
| integrations/catalog.ts (21) | PACK_GATES entries |
| config.ts | `AI_ISA_LIVE_SENDS` (default false; logged at start-up) |
| registries | routes, errors, worker handlers, authz MATRIX and audit actions, eslint R-PRED-4 and mail-sync-boundary lists |

**As built (ISA-3, the seller part; batch 13).** One call each into `apps/api/src/isa/seller/index.ts` from ISA-2's files, plus the flagged registry and module edits:

| File (module) | Edit |
|---|---|
| isa/turn.ts (75) | H1 `sellerBundleInTx` (handles, unavailable codes, the three flags) beside ISA-2b's buyer bundle; H8 `factPlaceholdersInTx` (a sent facts message is its fixed placeholder) |
| isa/effects.ts (75) | H2 `renderSellerFactsInTx` in `queueIsaMessageInTx`, given ISA-2's `ctx.channels` and composed body (audit F5); `writeSellerFactsInTx`; H6 `onEscalationInTx` on the escalate path |
| isa/send.ts, comms/dispatch.ts (75, 22) | H3 `sellerFactsCurrentInTx` in `aiIsaGateFacts`, run as dispatch's own actor (audit F11) |
| isa/controls.ts, isa/repo.ts (75) | H4 `sellerStartRefusalInTx` in `startRefusal`; H5 `sellerSubjectLinkInTx` as link 10 (§3.1) |
| cma/service.ts, cma/gates.ts, cma/subject.ts, cma/deps.ts (71, V1-C) | `compsForSubjectInTx`; `clientReadiness` `use: 'ai_isa'`; `export` on `newest`; the `connectionClientEligible` re-export (FEED_STALE for a stale feed, audit F8) |
| core/listings licence.ts, types.ts, competing.ts (23, V1-A) | `ValuationUse` `'ai_isa_comps'`, `aiIsaComps`, the exhaustive switch; `sqftBandPct` |
| mls/admin.ts, mls/routes.ts (24) | `ai_isa_comps` in the valuation pack keys, values and strict bodies |
| core/valuation/index.ts (70, V1-B) | exports `tierName` and the three area-sentence builders |
| core/foundation/authz.ts | `canAsRole`; MATRIX `ai_isa.seller_facts` (system via `assistant` only) and `ai_isa.subject_confirm`; the five seller audit actions |
| errors.ts, routes.ts, worker/handlers/index.ts | SUBJECT_* codes; `sellerRoutes`; the three seller jobs |
| integrations/catalog.ts (21) | PACK_GATES `platform:ai_isa_seller_data`: batch 12's "The assistant's recent-sales emails" is kept, not the brief's "AI assistant recent sales for seller leads", because the copy lint names the assistant "the assistant", never "AI" (b12 review ui-1); its line says the emails are not built in this version |

---

## 10. Web (module 76, `apps/web/src/surfaces/aiCare/**`)

1. **"Under AI care" list** (`/ai-care`, phone and desktop).
   - Each row shows:
     - person and side;
     - the state chip (Active, Waiting for reply, Reply scheduled 9:00 AM their time, Scheduling, Waiting on {Agent}: {topic} since {time}, Paused: why (nobody is following up), Held: why, Ended: why);
     - the last AI action and when;
     - the next touch, in local time and zone;
     - the caps used ("2 of 3 today");
     - the inactivity release date ("AI messages don't reset this");
     - the owner.
   - Filters: Mine, Team, All. Row actions: Pause (one tap) and Take over (one tap, 10 s Undo).
   - Admin sees overdue handoffs.
2. **Per-lead panel and thread banner.**
   - "AI assistant is handling this conversation".
   - **What it may do,** in plain words after intersecting the policy, the opt-in, the packs and the gates. For example: "Can share recent sales: no — not built in this version." (it would also wait for counsel review of platform:cma and the seller-data pack; b12 review ui-2)
   - The consent basis per channel; the quiet hours and their zone source; the last decision and why; the facts sent; the open offer; held topics and their deadline.
   - **Seller:** "Confirm this is the home they're selling" (owner, one tap, with the MLS record and its date).
   - Buttons: **Pause** (one tap); **Take over** (one tap, an immediate pause, then a 10 s Undo toast that says what was in flight); **End AI care** in the overflow menu, with the same Undo. **Resume** is shown only to the owner.
   - Phones: a sticky bar with Pause and Take over.
3. **Handoff card** (a flagged edit to surfaces/feed; `review_ai_isa_handoff` routed like `review_handback`, ActionButton.tsx:10, :51, :247-248).
   - It shows the reason and basis, the appointment and the confirmation status, the open offer, the qualification with quotes, the facts sent, commitments, next-step buttons and the deadline.
   - "Got it" acknowledges but does not clear the deadline. The ack sheet shows a scheduled confirmation with Cancel.
   - It is pinned. Critical for the classes in §4.7.
   - An escalation card for hold topics has "I've handled it; the AI may continue".
4. **Compose and dial** (flagged edits to surfaces/compose and the dialer): "Sending pauses AI care for {name}; {Owner} can resume." After the send, the owner gets a "Resume AI care" toast.
5. **Bulk preflight:** "N recipients are under AI care", with "Skip people under AI care" checked by default.
6. **Honest labels.**
   - Each AI message in the thread is chipped "Sent by {Agent}'s AI assistant · why" (surfaces/thread).
   - The client-facing disclosure and sign-off are platform constants (§7.3). The bot-question line is truthful.
   - **VERIFY WITH COUNSEL** (C-ISA-5).
7. **Settings.**
   - "My AI assistant": the opt-in form with capabilities unchecked, availability, time zone, the calendar check, the attestation and re-auth.
   - Admin "AI assistant (ISA)": the switch ("Waiting on counsel review" while `platform:ai_isa` is uncleared), the cap (raising it is Owner-only, with re-auth), the policy editor and the "what changed" diff on supersede.
   - The CompliancePage notice per §2.3.
8. **Accessibility.** Targets of 44 px or more, `aria-live` state changes, nothing conveyed by colour alone, and the Undo toast reachable by keyboard and screen reader for its 10 seconds.

### 10.1 As built (ISA-4)

**Pages** (apps/web/src/surfaces/aiCare/**; D12 stays PROPOSED):
- "Under AI care" (`/ai-care`; Owner, Admin, Team Lead, Agent, ISA; More and the sidebar, "AI care"): one row per person (the newest assignment: the API's chips are the contact's latest), the chip in words for the reader, the next follow-up in the viewer's zone, the release date, the owner, "Handoff overdue"; Pause and Take over in one tap, End behind More, Resume on paused rows for their owner. Filters "Mine" and "Everyone you can see"; Live, Paused, Ended, All; "Overdue handoffs" for Owner/Admin with "Showing k of n" when the API's 200-row limit cuts rows.
- "My AI assistant" (`/settings/ai-assistant`; Owner, Admin, Team Lead, Agent): the opt-in form (every capability unchecked but the required converse; unbuilt ones disabled; booking needs a calendar), the server's attestation verbatim with a tick, the password on REAUTH_REQUIRED; re-attest; "Pause all my leads"; "Turn off for all my leads".
- "AI assistant (ISA)" (`/settings/ai-assistant/team`; Owner and Admin): one line for each condition that holds sending back; the switch (the Owner turns it on with a confirmation and the password; an Admin turns it off only); the daily cap (raising it is the Owner's, with its own confirmation); the overdue link; the team policy read-only in words, each value marked VERIFY WITH COUNSEL, with the fields changed since the previous version.
- The person page: a strip under the channel actions (and a sticky phone bar while care is live) and the panel section (contact/sections.ts, order 1); Start in 2 taps; refusals with one fix; the Lift sheet for liftable blocks (their message since the block, a typed confirmation of at least 20 characters).
- The thread: the banner (state, controls, hold) hosting the Undo toast; AI labels from the turns route; the pending post-handoff message and what stops it.
- The feed: AiCareFeedCard for `ai_isa_*` items (activity, escalation, the handoff card with the full package), and the strip "AI care is on" on other cards of a live contact.
- Compose, dial and approvals: the warning before Send/Call, the owner's "Resume AI care" toast after a send, the inbox filter, "Let the AI assistant continue" on the viewer's handback.
- Bulk: "People under AI care, live or paused, are skipped." CompliancePage: the AI ISA notice from `GET /admin/ai-isa`. Playbooks: kind `ai_isa` is never listed there (batch 12 review ui-3, kept at the batch 13 merge); its detail page shows batch 12's "not a playbook" notice and the pointer to the team page.

**The read route** (Q1 taken by default): `GET /ai-isa/handoffs/:id` in apps/api/src/isaWeb/routes.ts (module `ai-isa-web`), `ai_isa.view` with the facts of the record the handoff's merge chain ends at (b13 review F2, as the ack route), the handoff's RLS (0080's `isa_select`, with 0081's root-survivor branch); read-only, no audit. Instants as ISO; the conversation as seq/status/messageId; any confidence, score, probability or tenant key dropped at any depth; `canAcknowledge` mirrors 0081's `isa_update` (the recipient, Owner/Admin, or the current owner of the merge root; b13 review F3) and the ack route's own `can('ai_isa.handoff')` on the merge root's facts (V8, F14); `pendingMessage.kind` from the message category. `isaWeb/webContract.json` is generated from the route schemas (drift test `isaWeb/webContract.test.ts`).

**Copy rules** (proposed web clauses, sent to ISA-2b for DATA_MODEL):
- **R-ISA-22 web:** say only what the API states; "Not available yet" for unbuilt features; no "you/your" to a reader the sentence is not about (the owner is named instead); times in the viewer's zone with its short name, "their time" only for an explicit zone; one hold source, the shared live query, read by every surface; no raw code (aiCare/words.ts; an unknown code is "Another check").
- **R-ISA-15 web:** Pause and Take over in one tap and End in two wherever a lead under care is shown; a focusable, announced Undo that says it keeps care paused; Resume for the owner only.
- **R-ISA-7 web:** AI messages are labelled from the turns route's message ids, with the verb their own status supports ("Sent by", "Scheduled by … for", "Queued by", "Written by" when it did not go) and "{Owner first}'s AI assistant" only for turns of the latest assignment whose owner is the contact's owner; the assistant is never shown as a person; anything outside the 100 turns keeps "Sent automatically".
- R-ISA-23: no sentence lets the AI near price, value, money, lending, contracts or legal questions; "I've handled it; the AI may continue" continues the conversation, never the topic.

**The shared hold query:** `['ai-isa','list',{scope:'all',state:'live'}]` (30 s stale, refetched on focus and after every control; never for a TC). Its `holdSentence` wins over a panel chain link (V3: link 1 is 'ok' on fakes while AI_ISA_LIVE_SENDS is false); a panel link with effect `hold` adds "Their replies come to you as usual." (to the owner; others read "go to {Owner first}").

**Deviations, each with its V or Q:**
- No Cancel for a scheduled confirmation on the ack sheet (Q3; there is no route): the sheet says what stops it (the send check of 0080, as replaced by 0081 and 0083). §10.3 above described a Cancel.
- No bulk checkbox: bulk always skips people under AI care with a fixed notice (Q4). §10.5 above described a checked box.
- No policy editor, approval or revoke in the app (Q5): a read-only view, the changed fields (no pause claim, V11) and "Editing and approving the team policy is not built yet."
- Labels come from the turns route, not the timeline (V12: the timeline has no initiator).
- The inbox drops `ai_isa_message` and `ai_isa_handoff` for every consumer (V1).
- "Mine / Everyone you can see" instead of Mine, Team, All (V7: the API's team scope returns the same rows as all); no Held filter (V7).
- No per-lead re-auth on Start (Q12): the sheet names the opt-in it relies on, and the side tap is the explicit act (2 taps).
- The opt-in form warns before any save while care is on (V19, Q13): any save ends live care today.
- Q2: the Owner's on and cap confirmations are web constants (TeamAssistantPage.tsx `ON_ATTESTATION`, `capAttestation`), sent verbatim as the attestation, until the server serves them.
- Q6 (b13 review B13S-2): what is built is ONE server list, `ISA_BUILT_CAPABILITIES` (apps/api/src/isa/sentences.ts): every capability turn.ts can grant (converse, share_listings, propose_saved_search, seller_competition, book_appointments, and seller_sold_comps, built but dark behind platform:cma, platform:ai_isa_seller_data and the licence's ai_isa_comps). The panel row carries `allowed` (the policy and the opt-in, as the turn grants it) and `built`; GET /me/ai-isa carries `builtCapabilities`; the web keeps no copy (aiCare/built.ts no longer has `BUILT`). The seller section says once that competing listings go with their asking prices and recent sales wait for the counsel reviews. `EMAIL_SENDER_CHECKS` is true since ISA-2b wired DKIM verdicts (cb7932c), so the opt-in form no longer says email replies always come back.
- Q8: switching on is allowed before counsel clears `platform:ai_isa`, with the counsel line on the team page and Start refused NOT_CLEARED.
- Q9: ending a "they have an agent" check records no block (there is no route); the card says so.
- Q10, V9: cards module 75 never closes say their done or resolved state honestly and stay.
- Q11: Take over, End and Undo for Owner, Admin, Team Lead and the owning agent; collaborators and the human ISA role get Pause only (authz.ts:685-688).
- The handoff card omits the sections the package does not carry (V13: open questions, consent basis, caps, zones, summary, the trigger quote); deadlines say "by {time}" (V15, Q-ISA-20 VERIFY); a pending message's own status is read, not `confirmation_status` (V17).
- The paused strip says when a forgotten pause ends (72 h, handlers.ts:38); re-attest results name the continued leads and say each "not continued" code in words; continued assignments end as `reinquiry_period`, worded neutrally (V20).
- The panel never shows the API's fixed "12:00–20:00 Eastern" zone sentence, its rolling-24 h "today" (said as "in the last 24 hours") or its UTC times (V6).

**Batch 13 audit fixes (isa-4, after the merge):**
- ISA-2b's booking cards (`AI_ISA_BOOKED_AFTER_END`, `AI_ISA_BOOKED_NOT_HANDED_BACK`) say what was booked and when (the time read from the card's own sentence, with its zone label), that the confirmation was not sent, where to confirm or cancel it (Tasks) and, from the panel, the state care is in now; never "AI care is paused" after an end. Any other unknown escalation code is "Another check." with no claim (F1).
- Every AI feed card and the live strip carry the hold banner (the shared query's sentence; an escalation card adds the replies clause when a panel link holds); under a hold the activity card reads "Nothing the AI assistant writes reaches {first} from this deployment" instead of "takes this turn" (F2).
- The handoff's recipient is read as ISA-2b routes it (Q1): the reader, the assignment's owner, the lead's new owner (named from the contact), "the person who took over" or "someone else on the team"; a null recipient keeps "the team leads and Owner/Admin". "Got it" absent reads "Only {holder} or Owner/Admin can mark this seen." A taker is never named: the API carries no display name for them (F4).
- `approve_saved_search` routes like `review_saved_search`; only `prepare_cma` and `confirm_subject` say "not available yet"; any other unknown step is "Another check" (F5).
- The handoff card renders ISA-2b's package fields: the appointment's kind, time (and their time when explicit), organizer and their words; the saved search's status at the end with its review link; who got the handoff; who ended care; the pond date at the end. The API's second-person `calendarSentence` and its UTC instant never show (F6).
- An Admin sees no "Turn on" on the team page (off only), and a cap raise refused for an Admin reads "Only the account owner can raise the limit." (F13).
- The Undo toast carries its owner (the list says "until you resume it" to the owner); a restored toast says the seconds it had; the panel's offered times add their time when explicit; `canAcknowledge` follows the ack route's own `can()` (F14).
- The panel reports an earlier handoff a restart left open (`earlierHandoff`), shown as "An earlier handoff is still open" with its deadline (b12 recheck R16 follow-up). An `ai_isa_handoff` card's generic tap opens the thread with no draft, and the compose box never takes a handoff as a draft (b12 recheck R11 follow-up). "Got it" is on the handoff card (POST `/ai-isa/handoffs/:id/ack`), and its sheet and the card say `closedReason` (merged at batch 13).
- SellerFacts shows the panel's `seller_sold_comps` sentence verbatim after "Seller facts: not available yet. …" (E534, brief item 13).

**VERIFY list (V1–V20), each with its status after batch 13:**

| V | What | Status |
|---|---|---|
| V1 | The inbox shows AI ISA actions | Deviation: `useInbox` drops `ai_isa_message` and `ai_isa_handoff` for every consumer; the compose box never takes a handoff as a draft (batch 13). Request to ISA-2b: exclude and refuse them in the API. VERIFY |
| V2 | Strict bodies refuse useCommand's commandId | Resolved by reading; `useIsaAction` sends no command id (api.contract.test). |
| V3 | Two sources for live sending | Deviation: the shared query's `holdSentence` wins; a panel link hold adds the replies clause. Request to ISA-2b: one source on the panel. VERIFY |
| V4 | Start refusal order (opt-in before ownership) | Deviation: apart from the team-wide refusals (off, not cleared, no approved policy), a non-owner reads "Only {Owner first} can start AI care for this lead." whatever the code. |
| V5 | Second-person API sentences reach other viewers | Deviation: the web rewrites links 5 and 6, chips and capability lines per reader (words.ts). Request to ISA-2b: reader-neutral sentences. VERIFY |
| V6 | Panel sentences that mislead (converse only, fixed consent text, fixed zone window, rolling 24 h, UTC, block restart) | Deviation: none of them is shown as sent; the web words each from the fields. |
| V7 | List gaps (team = all, no Held, empty lastAction and caps, latest assignment's chip) | Deviation: "Mine / Everyone you can see", no Held filter, one row per person; empty fields omitted. |
| V8 | A non-recipient team lead's ack matches no row | Resolved: `canAcknowledge` (and since batch 13 the ack route's own `can()`). |
| V9 | AI feed cards are never closed by module 75 | Partly resolved by batch 12 (R13: the system closes a done handoff's card); the card says Done or why it is closed and stays until then (Q10). |
| V10 | No deadline on escalations and held topics | Deviation: no deadline is shown for either; held topics say "Since {time}". VERIFY |
| V11 | `narrows_previous` is never written | Deviation: the policy diff makes no pause claim. |
| V12 | The timeline has no initiator | Deviation: AI labels come from the turns route (LIMIT 100); older messages keep "Sent automatically". |
| V13 | Package gaps (open questions, consent basis, caps, zones, summary, trigger quote) | Deviation: those sections are omitted; ISA-2b's added keys render since batch 13 (F6). |
| V14 | The stack's jobs and the isaWorld swap | Resolved by reading; the specs use `runIsa`. |
| V15 | Deadlines are wall-clock | Deviation: "by {time}", never business minutes (Q-ISA-20). VERIFY |
| V16 | Non-admins never see the cap hold (sentToday under counts_select) | Request to ISA-2b, not a web change: link 3 is 'ok' for non-admins, so their banner omits the cap; Owner/Admin see it on the team page. VERIFY |
| V17 | `confirmation_status` never advances | Deviation: the card reads the pending message's own status. ISA-2b now writes `scheduled` when the message waits. |
| V18 | Some blocks never lift, yet the API promises a restart | Deviation: each block reason has its own words; the non-liftable ones say AI care can't restart and get no Lift. |
| V19 | Any opt-in save ends live care | Deviation: the opt-in form warns before a save while care is on (Q13). VERIFY in a1. |
| V20 | Re-attest ends each continued assignment as `reinquiry_period` | Worded neutrally; batch 13's isa-2b fix derives Continue's end reason from the pause. Request to ISA-2b: its own reason for re-attest. VERIFY |

---

## 11. Coordination with the lanes in flight

| Lane | Interaction | Rule |
|---|---|---|
| telephony-safeguards (S1–S5; 0130–0132; E380–E389) | Its 0132 redefines the guard. Its daily cap and kill switch apply to AI SMS (a hold). `message_text_parts` (S5) is read by the guard (ISA_UNREAD_PART), and an MMS is never a turn. | ISA-2's 0080 (lane number 0190) starts from 0065's body (lane number 0132). Never weaken S1–S5. Tests run with the switch off. |
| lead-intake (0110; E313–E354) | It edits inbound.ts, intake.ts and intakeConsent.ts. Its grants and disclosures are read by R-ISA-9. Call tracking is a call (pause). | ISA-2 edits inbound.ts after intake merges. The one intake edit is `scope_stated`, agreed with that lane's owner after merge. The AI ISA never writes grants. |
| CMA V1-A, V1-B, V1-C (0068; E360–E377) | Seller reuse: `soldCandidates`, `mlsRowsAtAddress`, `liveNearMatches`, `clientReadiness`, `clientSoldView`, `prepareCma`, `competingSet`, V2-A's statement rules | ISA-3 starts after all three merge. Its flagged edits (`compsForSubjectInTx` with `onBehalfOf`, the `clientReadiness` `use`, the licence switch and `valuation.ai_isa_comps`, MATRIX `ai_isa.seller_facts`) are agreed with those lanes. An architecture test enforces that no ISA file reads `listings.close_price_cents` except through `compsForSubjectInTx`. |
| Voice API (48; E420–E439; 0150, now 0078) | Both book through `bookSlot`/`bookSlotInTx`. A call pauses AI care and links its package to the call's card. | Whichever lands first adds the appointments lock trigger, and the other rebases. Voice keeps D-VOICE. |
| Next-wave 42 (documents; E400–E419; 0140, now 0069), 52 (ads; E440–E459; 0160, now 0070), 53/54 (GBP and coaching trends; E460–E474; 0170, now 0079), deploy readiness (E475–E489; no migration) | none | — |

- **No running lane is cancelled or interrupted.**
  - ISA-1 may start when this design is approved, from staging. Its compliance edits are additive and covered by the non-interference property.
  - ISA-2 starts **after batch 9** (telephony-safeguards plus lead-intake) lands.
  - ISA-3 starts after CMA V1-A, V1-B and V1-C land, and after ISA-2.
  - ISA-4 starts after ISA-2 deliverable 1 is pushed.
- **File ownership:**
  - ISA-1: `packages/core/src/isa/**`;
  - ISA-2: `apps/api/src/isa/**` except `seller/**`, `packages/db/migrations/0080_ai_isa.sql` (lane number 0190), `packages/db/test/rls_smoke_ai_isa.*`, `apps/api/src/providers/fake/{isaAi,hostileIsaAi}.ts`;
  - ISA-3: `apps/api/src/isa/seller/**`, `packages/db/migrations/0084_ai_isa_seller.sql` (lane number 0191; it applies after 0080);
  - ISA-4: `apps/web/src/surfaces/aiCare/**`;
  - everything else is a §9.6 flagged edit.
- **Merge order:** ISA-1 → ISA-2 → ISA-4 (buyer UI) → ISA-3, then ISA-4's seller pieces, which render "not available" until then.

---

## 12. Lane split, rules and edge ids

The lane briefs are in <lane_briefs>.

### Rules
- **R-ISA-1 Authorization chain.** All §3.1 links, default off; checked at start, ingestion, TX-A, TX-B, TX1 and the guard. One link-failure table (hold, pause or end) applied identically everywhere. [DB + core + api]
- **R-ISA-2 Exclusivity.** One live assignment per contact, and none on a shared address (any point, any kind, removed included unless wrong_number) or for an active client, checked continuously. A start stops the enrollment and supersedes drafts and handbacks. While care is live: no enrollment, triggers become events, stage automation skips. [DB + api]
- **R-ISA-3 The reply rule under care.** Step 6 unchanged. Only a bound-point, DKIM-aligned, media-free SMS or email from the client is a turn. Every other inbound runs R-AST-9 and pauses care. Takeover on a one-to-one human create or schedule, on draft or handback approval, or on a dial. Bulk and marketing sends never take over. Fail closed per R-ISA-1. [api + DB]
- **R-ISA-4 Concurrency.** The global lock order. No provider call under locks 2–4. One turn at a time. Debounce through retryAt. TX-B guarded by attempt. The guard checks the pinned seq, the epoch and the body hash. The single job-lease recovery path. [api + DB]
- **R-ISA-5 Model output.** A closed, strict action set. The model proposes and core decides. No free-text notes. The summary is screened and handoff-only. Decisions stored as codes and handles only. [core + api]
- **R-ISA-6 Escalations.** The §4.4 taxonomy, with terminal versus hold_topic and the precedence. Deterministic and negation-aware. Statements are qualification; requests escalate. Fixed lines; the safety line is never deferred. [core]
- **R-ISA-7 Content.** Model text is conversation only (the §7.3 guard, including market and comparative claims). A facts message has no model text. The disclosure and sign-off are platform constants containing "AI". Never claims to be human. **VERIFY WITH COUNSEL.** [core]
- **R-ISA-8 Send checks.** D1 first and unchanged. Purpose is always marketing. Plus R-ISA-9/10/11/25/28/31 in core, dispatch and the guard; the guard re-derives the kind, tier and zones. The reason classes. Non-interference for other categories. [core + api + DB]
- **R-ISA-9 Consent evidence.** The reply tier from the client's own bound inbound in the window. The initiated and facts tier from the person's own disclosure: named tenant in the body, scope stated, after D12, not imported, not revoked, plus a fresh DNC result for SMS. **VERIFY WITH COUNSEL.** [core + DB]
- **R-ISA-10 Quiet hours.** Explicit only when a person set it; otherwise the conservative union; the window intersection; replies included; initiated days and holidays; no overlap hands off; the guard recomputes the minimum set; the offset agreement check. **VERIFY WITH COUNSEL.** [core + DB]
- **R-ISA-11 Caps.** 3 per 24 h across AI messages, with AI yielding to the person's total automated and bulk count. Initiated limits. A 120 s gap. One open message. Address-keyed sorted locks. The counted statuses. The daily upsert. Slow, dormant and delivery_problem. **VERIFY WITH COUNSEL.** [DB + core]
- **R-ISA-12 Readiness.** B1–B3 and S1–S3 from usable client own-text claims, with `qualValueQuoted`. It waits for a live offer. Recorded with rule, version and claim ids. A disqualifier pauses for a check. [core]
- **R-ISA-13 Appointment boundary.** A live calendar read; one explicitly agreed, offered slot from client own text; a confirmation that can be sent ahead of notice; booking in its own job with `requireLiveCalendar` and `expectLinkId`; the lock trigger and assistant overlap refusal; never an auto-booked alternative; a templated confirmation in the post-handoff set. [core + api + DB]
- **R-ISA-14 Handoff.** Exactly one per assignment; it ends care; a frozen package; facts sent only; open offers closed; one card per event; the post-handoff closed set. [api + DB]
- **R-ISA-15 Controls.** Pause, resume, take over and end, at lead, agent, version, tenant and pack level. Controls ledger. Cancels in a system transaction. Epoch on resume. 10 s undo. Pause cards. 72 h expiry. The system never clears a pause. Immutable bindings. [DB + api]
- **R-ISA-16 Ownership.** Start needs the first touch. Owner change, merge or deactivation ends care in the same transaction (stop signal). A same-owner reinquiry pauses. Inactivity warning hands off. The AI never changes ownership. [DB + api]
- **R-ISA-17 Buyer grounding.** clientView and row freshness; the asking price labelled; ≤ 3 per message; never repeated; no keywords; saved searches proposed only, with AI-origin alerts suppressed while care is live and re-approved after the handoff. [api + core]
- **R-ISA-18 Seller grounding.** D9 selection and V1-C `clientReadiness` only. `cma.prepare` on behalf of the owner. An agent-confirmed subject. The complete comp set or nothing, by email only. platform:cma plus platform:ai_isa_seller_data plus `valuation.ai_isa_comps`. Ceilings. Labels (sold vs asking, closed vs pending vs active, comparable vs nearby, with the reason whitelist). No hidden counts. No value in v1. Pricing goes to the human. **VERIFY WITH COUNSEL / MLS.** [api + core]
- **R-ISA-19 Market changes.** Only uncapped, displayable counts by status, with thresholds and version checks. No sold-derived statistics in v1. No forecasts. [core + api]
- **R-ISA-20 Prompt isolation.** One contact; nonce fences; handles with structured labels only; client own text; no notes, transcripts, remarks, prices or synced mail; tool-less; the mail-sync barrier; the hostile suite. [core + api]
- **R-ISA-21 Audit and evidence.** Every turn with its versions; every control and system action audited; facts recorded at send; the frozen package. [api + DB]
- **R-ISA-22 Visibility.** The list and panel show what it may do, why, its last decision, held topics, deadlines and inactivity dates. No confidence fields. [api + web]
- **R-ISA-23 Always-human topics.** Money, offers, contracts, negotiation, commission, legal and lending are never AI content. The DB CHECK ties the mandate to the AI ISA categories. [DB + core]
- **R-ISA-24 Channels.** SMS and email only. No calls, MMS or chat. Never touches, SLA or scoreboard. [core + DB]
- **R-ISA-25 Live safeguards.** AI_ISA_LIVE_SENDS and TELEPHONY_LIVE_REQUESTS default false. The switches and caps hold. No self-retry. [api]
- **R-ISA-26 Represented elsewhere.** A listing by another brokerage at the subject, or a confirmed other agent, ends care. A near match pauses. **VERIFY WITH COUNSEL.** [api]
- **R-ISA-27 Client own text.** Quotes for qualification, readiness, booking and end come only from client own text on a bound point. Quoted email history is stripped. QUOTE_IS_TEAM_TEXT. [core]
- **R-ISA-28 Bound points.** Points are bound at start and immutable. A turn only from a bound point (with an aligned DKIM pass for email). Outbound only to a bound point. A removed bound point ends care. [api + DB]
- **R-ISA-29 Answered-inbound backstop.** An inbound under care is answered, scheduled for reply, handed off or answered by a human; otherwise the card is written at 10 minutes, or at once on any transition out of live. [api]
- **R-ISA-30 Handoff deadline.** Per-class deadlines in business time, cleared only by a human touch; a person closing the lead also ends it (no touch can follow), and so does the owner's explicit Continue AI care or policy re-attestation for the continued-from assignment's own handoff (`care_continued`, b12 recheck R23; owner question). Nothing else does: not "Got it", not a restart of AI care (b12 recheck R16). Escalation to TLs, then Owner/Admin. Ownerless routing. [api + core]
- **R-ISA-31 Stop signals and blocks.** Any opt-out, suppression or do-not-contact from any writer ends care in the same transaction. No email fallback after one. A person block, with strict lift conditions. "Not an opt-out" never lifts it. **VERIFY WITH COUNSEL.** [DB + api]
- **R-ISA-32 Loosening controls.** Owner-only switch-on and cap raise (re-auth plus attestation, DB guard); opt-in re-auth; recomputed attestation hashes. [DB + api]

### Edge cases (E490–E539)

| Id | Case | Expected | Rules |
|---|---|---|---|
| E490 | A person under live care replies from the bound phone | Step 6 as today. No handback card. One turn. An `ai_isa_activity` row. Answered by an AI reply that reaches sent. | R-ISA-3, -29 |
| E491 | A link fails at ingestion: (a) the kill switch or daily cap, (b) the pack withdrawn or the version revoked, (c) the opt-in revoked | (a) Hold: R-AST-9 handback, no pause, banner; the AI waits while the handback is open. (b) Pause plus an owner card. (c) End plus a handoff. The same outcome at ingestion, TX-A, TX-B, TX1 and the sweep. | R-ISA-1, -15 |
| E492 | Two texts 5 s apart; a stuck lease while the original job is alive | One turn after `last_inbound_at + 20 s`, reading both. The replayed attempt's TX-B updates zero rows and discards everything. | R-ISA-4 |
| E493 | An inbound during the model call, or ingestion pausing after its cancel while TX-B commits (barrier) | TX-B is stale, or the guard raises ISA_STALE_REPLY. Nothing is sent. A new turn covers both. | R-ISA-4 |
| E494 | An inbound after an AI message is queued, or at the moment TX1 commits | Cancelled CLIENT_REPLIED (or the guard's pinned seq), then a new turn. If TX1 already committed, it goes, and the next turn and the handoff say so. | R-ISA-3, -4 |
| E495 | An email reply quotes the offer ("Tue Nov 17, 3:00–3:30 PM ET"), or quotes the AI's "preapproved or cash?" | No booking (QUOTE_IS_TEAM_TEXT, or not ownTextReliable). No claim. One restatement of the slots. | R-ISA-27, -13 |
| E496 | The agent composes or schedules a text, approves a draft or handback reply, or dials; a TL taps Take over then Undo; a bulk newsletter goes to the person | Paused `human_contact` at create time, with the cancels in a system transaction. Undo within 10 s leaves it paused. Bulk is not a takeover: it counts toward the cap, and preflight skips people under care by default. | R-ISA-3, -15, -11 |
| E497 | The person calls (answered, missed, voice or call tracking), chats, sends synced mail, or sends an MMS or a text part | Pause (`call`, `chat`, `synced_mail`, `media`). The R-AST-9 path. One card per event (the call card links the package). Nothing reaches the prompt. | R-ISA-3, -14 |
| E498 | STOP, opt-out language, provider 21610, a STOP in an MMS text part, or a STOP from a removed phone that lands on an "Unknown" contact | A stop signal in the same transaction. The guard and liveness treat care as ended. The job ends `opted_out`, writes the block and handoff. No email fallback. | R-ISA-31 |
| E499 | A List-Unsubscribe, a staff revoke, a do_not_call_request outcome, any suppression (spam_complaint, internal_dnc, admin_block, provider_opt_out, import_dnc), a Gmail-synced opt-out, or a do-not-contact | A stop signal per writer; care ends; no AI email or SMS on any of the person's points. | R-ISA-31 |
| E500 | "Is this a real person?" versus "I want a real person" | The bot line, care continues. Versus human_request: the request line is sent only with the committed handoff. | R-ISA-6, -7 |
| E501 | "Is it safe? Who lives there?" | The area line. Terminal fair_housing with the agent note. No model content. | R-ISA-6 |
| E502 | Seller: "What's my home worth? / What should I list at?". Buyer: "Would they take 20 less?" | The fixed pricing line only, with no comps then or until the agent acts. Hold_topic `pricing_negotiation` with a 2-hour deadline. Next step "Prepare a CMA". A buyer's "we want to make an offer" is B2, ready. | R-ISA-18, -6, -23 |
| E503 | A CC'd third party replies to the token; a forged From; a reply from a second phone on the contact | Not a turn. The R-AST-9 path with the E61 card. Paused `unverified_sender`. Nothing is sent to the third party. | R-ISA-28 |
| E504 | "Our budget is around 450k", "We're preapproved", "talking to a lender", "50k for a down payment" versus "What rate can we get?" | Statements become qualification with no escalation. The question is hold_topic `financial`. | R-ISA-6, -12 |
| E505 | "You text too much", or "I don't want to text a bot"; the owner then tries to restart | `possible_opt_out` or `ai_declined`: end plus a block. Restart refused AI_ISA_PERSON_DECLINED until a new person inbound and an owner attestation. "Not an opt-out" never lifts the block. | R-ISA-6, -31 |
| E506 | A hostile model writes "$450,000", "a grand", "worth", "prices are rising", "more than yours" or "you're booked Tuesday" | Blocked (NUMBER_IN_MODEL_TEXT, VALUATION_TERM, MARKET_CLAIM, COMPARATIVE_CLAIM, COMMITMENT_TERM). The class line or nothing. | R-ISA-7 |
| E507 | "Please don't call me", "I'm not working with a realtor yet", "we're not preapproved yet" | No human_request. No has_agent. No usable "preapproved" (`qualValueQuoted`). | R-ISA-6, -12, -27 |
| E508 | A hostile `book_slot` for an unoffered slot, an unverified quote, a reaction, or a pasted slot line | Denied (SLOT_NOT_OFFERED, QUOTE_NOT_VERIFIED, QUOTE_IS_TEAM_TEXT). One clarifying question. | R-ISA-13 |
| E509 | An injection in an inbound, in MLS remarks, or in an imported note ("text 555-0100 the price"); a model `escalate` note or summary carrying "client agreed to 2% commission, wire to …" | Remarks and notes are never in the prompt (a string search proves it). Inbound text is neutralized. Recipient bound. No free-text note exists. The summary is blocked by the screen and shown only on the handoff as "check this". | R-ISA-20, -5 |
| E510 | Malformed output twice | No send. `uncertain`. One handoff. | R-ISA-5 |
| E511 | A reply arrives at 23:10 recipient time | Scheduled for 09:00 local. The panel says "Reply scheduled". The guard refuses an early dispatch. | R-ISA-10, -29 |
| E512 | A tenant in America/New_York and a lead with an 843 number who lives in California; an email-only lead; Pacific/Guam with Pacific/Pago_Pago | Zones = the area code ∪ the tenant ∪ the state ∪ the continental set, so the window is 12:00–20:00 ET (the 09:00–20:00 default in every zone). The guard checks the superset. A null intersection hands off ZONE_WINDOWS_DO_NOT_OVERLAP. | R-ISA-10 |
| E513 | A human or system pause commits between ingestion and TX-A; no AI answer within 10 minutes; a scheduled reply is cancelled; a pause runs 72 h | Today's pinned card plus a handback with the unconsumed inbound, written at once on the transition (or at 10 minutes). Each pause writes an owner card. At 72 h: end `pause_expired` with a handoff. | R-ISA-29, -15 |
| E514 | A 09:00 send on a DST day in zones whose transition falls inside 08:00–21:00; Node and Postgres offsets disagree | Core and Postgres agree (a property test). A mismatch defers the message and alerts. | R-ISA-10 |
| E515 | A 4th AI message in 24 h; a bulk email already sent today; two sends racing at the cap; a timer, a buyer watch and a seller watch all queue for 09:00 | ISA_CAP_REACHED is deferred. The AI yields to bulk. Exactly one send passes under the sorted address locks. Only one open message (a newer turn supersedes). The 120 s gap holds. | R-ISA-11 |
| E516 | Start on a lead whose first touch is pending; a new or attempting lead reaches `inactivity_warn_at`; a same-owner reinquiry period | AI_ISA_FIRST_TOUCH_PENDING. A pinned handoff at the warning. A pause `reinquiry`, then owner Continue starts a linked assignment on the new seq. | R-ISA-16 |
| E517 | The kill switch is off on the real adapter; the tenant AI cap and the telephony cap are reached | The lane's failure sentence, no request made, no retry. A hold (no pause, no per-lead card), a banner, and automatic continuation when it clears. | R-ISA-25, -11 |
| E518 | 3, then 6, unanswered initiated messages; 2 undelivered in a row | Slow cadence, then `dormant` with a low-priority handoff. `delivery_problem` ends care with a handoff. "In a row": each `failed` or `undelivered` counts, and only a carrier `delivered` resets the run; the provider's `sent` (accepted) proves nothing and leaves it (b12 recheck R7). | R-ISA-11 |
| E519 | An initiated SMS where the only grant is: an inquiry-level grant; imported; recorded before D12; a defaulted scope; the source's fallback disclosure; a disclosure whose namesSeller names the team but whose body does not; or no fresh DNC result | Refused (ISA_CONSENT_EVIDENCE_MISSING or ISA_DNC_UNVERIFIED). Email only if its own basis passes. Otherwise nothing, and the panel says why. | R-ISA-9 |
| E520 | J1: first response, then the lead replies (no inbound_first_contact grant exists) | Reply-tier SMS from their own bound inbound within 24 h. Listing shares and follow-ups are refused without the initiated tier. | R-ISA-9 |
| E521 | A critical handoff is not touched within 15 business minutes; a handoff for a lead returned to the pond | `ai_isa_handoff_overdue` to the team leads, then Owner/Admin. "Got it" does not clear it, and neither does AI care starting again on the person. Ownerless: to the previous owner's TLs and Owner/Admin. The deadline ends only on a human touch, when a person closes the lead (b12 recheck R16), or, for the continued-from assignment's own handoff, on the owner's explicit Continue or re-attestation (b12 recheck R23). | R-ISA-30 |
| E522 | The tenant switch goes off with 30 turns in flight | No dispatch after the commit (guard). All ended. Cancels done as the system. One notice per owner. | R-ISA-15 |
| E523 | A pause or opt-in revoke during a booking | The pause commits at once (the job holds only lock 5). Booked. TX-C finds it paused: no confirmation; the package says so; the card is critical. The confirmation is stored as not sent (`refused`), so the card and the panel ask for a hand confirmation, or say none is possible when D1 leaves no channel (never "No confirmation was planned"). | R-ISA-15, -13 |
| E524 | The policy version is revoked; superseded by a narrowing version; superseded by a widening version | Revoked: pause. Narrowing: migrate at the next turn. Widening: pause `policy_updated`, one card per agent, and one re-attestation continues all as linked assignments. | R-ISA-1, -15 |
| E525 | The lead is reassigned, auto-released or sent to the pond | The guard refuses (owner or seq). Drafts are invalidated in the ownership transaction. End `owner_change` with a card to the new owner, or to the TLs and Owner/Admin. | R-ISA-16 |
| E526 | A merge while care is live, with an AI message queued on the loser | Invalidated in the merge transaction (`ai_isa_message` is in the list), plus a stop signal. The queued message is never sent. Ended `merged` on both. | R-ISA-16 |
| E527 | Spouses share a phone at start; a duplicate sharing an email is created later; a deal opens during care | Start refused AI_ISA_SHARED_ADDRESS. Later sharing or a deal: the guard refuses (ISA_SHARED_ADDRESS or ISA_ACTIVE_CLIENT) and the sweep ends care with a handoff. | R-ISA-2 |
| E528 | The client answers "2" to three slots | `accepting`, the book job, booked, then TX-C: the handoff `appointment_booked` and the confirmation with the exact local time and zone. | R-ISA-13 |
| E529 | "Tuesday works" with two Tuesday slots; a 👍 to the offer; "2 works. Also what's our house worth?" | The first two: one clarification, no booking. The third: booked first, then hold_topic pricing, with one message holding the confirmation and the pricing line. | R-ISA-13, -6 |
| E530 | A safety message at 23:30; "how did you get my number?"; "delete my data"; "this is her husband"; "wire the deposit to this new account" | Safety: no automated line, an immediate critical notification, and the handoff says so. consent_dispute, privacy_request, third_party and fraud_risk are terminal, each with its line and task. | R-ISA-6 |
| E531 | The slot is taken; the link is revoked between the offer and "2"; reconnected to a different calendar; GrantRevoked during the booking read; the calendar not connected at the offer | A new offer (SLOT_TAKEN or SLOT_SOURCE_CHANGED). CALENDAR_UNAVAILABLE leads to hold_topic `booking_unavailable`. Never booked on in-app data alone. The revoke is persisted. | R-ISA-13 |
| E532 | An in-app appointment races an AI booking (both orders) | The lock trigger serializes them. An assistant overlap is refused by the DB. A human overlap is allowed by choice, with a warning. | R-ISA-13 |
| E533 | After a booking at 21:00, the client texts "thanks!" at 21:31, then "actually can we do Wednesday?"; the agent taps Got it | "thanks!" keeps the 09:00 confirmation. The Wednesday text cancels it, updates the package and makes the card critical. The ack does not cancel it. | R-ISA-14 |
| E534 | platform:cma or platform:ai_isa_seller_data uncleared (the default); the licence has `automated_notes: true` but no `ai_isa_comps` | No sold comps or nearby sales (PACK_DOES_NOT_ALLOW). Competition with asking prices still allowed. The panel says why. | R-ISA-18 |
| E535 | The feed is stale; a row unseen for 3 days in a fresh feed; a fact labelled with another connection's date | No fact from the stale source. The unseen row is never sent. Each fact uses its own as-of. | R-ISA-18, -17 |
| E536 | The subject is unconfirmed, disputed, older than 10 years or not in the MLS; fewer than 3 comps; city tier or 24-month lookback; COMPS_HIDDEN; the model tries to share 2 of 6; a question about a nearby sale whose reason is not_among_closest, implausible_price or sale_condition | No comps (never padded, never partial, no hidden count). Complete set or nothing. Off-whitelist reasons go to `data_unavailable`. "Prepare a CMA" or "Confirm subject". | R-ISA-18 |
| E537 | A competitor goes active to pending, or changes price, between build and send; a sync moves only `last_synced_at`; a rank change (a competitor's place in the set moves) | FACT_CHANGED: a server re-render without a model call, "Pending (not yet sold)", at most one rebuild. A sync alone does not cancel. No event from absence. | R-ISA-18, -19 |
| E538 | A live listing at the subject: by the team; by another brokerage; a near match; AVM display N; the owner loses `cma.prepare` scope | End `active_client`; end `listed_elsewhere`; pause `possible_listing`; SELLER_WITHHELD (no sold facts); loss of scope means no seller facts (ai_isa.seller_facts). | R-ISA-18, -26 |
| E539 | A forged contactId; another contact's handle; another tenant's listing; a `fromHandbackId` from another contact or a stale one | 404, or dropped; nothing read; AI_ISA_HANDBACK_STALE. | R-ISA-20, -2 |

---

## 13. Test plan (fakes only; real Postgres through createTestDb)

### 13.1 Core (ISA-1)
- **Unit tests:** every transition, signal and precedence row; every negated fixture; the must-escalate and must-not-escalate fixtures (every B3 and S3 phrase); every readiness rule; `qualValueQuoted`; `clientOwnText` (Gmail, Outlook and Apple quoting, signatures); `matchSlotChoice`; every consent-tier row; `aiIsaRecipientZones` tiers versus `resolveRecipientZones`; every guard code; renderers (sold vs asking, pending wording, omitted fields, brokerage line); `marketDeltas` counts; `narrowsPrevious`.
- **Property tests** (fast-check 4.10.2):
  - exactly one handoff per assignment for any event sequence;
  - no queue_message after a terminal or paused state;
  - escalations are monotone;
  - `book` only after delivery plus a verified, unique client own-text match;
  - permutation invariance of an inbound batch;
  - non-interference of checks 0, 8 and 12 with every non-ISA category;
  - the `nextWindowStart` result lies inside every zone's window (2026–2030, including DST);
  - numerals, number words and "a" amounts never pass the guard;
  - a quote with a negator never yields a usable positive value;
  - every B3 field can be satisfied by a conversation with no escalation;
  - the comps message contains exactly `result.comps`, or nothing.
- **Mutation:** Stryker ≥ 85 % on core/isa.

### 13.2 DB (ISA-2/3)
- RLS smoke per role and table. Support writes refused.
- Every guard code reachable: start by a non-owner; resume by a non-owner or by the system; a wrong seq; a merged root; the pack uncleared; version revoked; opt-in revoked; pinned seq stale; epoch stale; body changed; unbound recipient; purpose not marketing; reply window closed; consent expired, revoked or imported; scope not stated; source fallback disclosure; DNC missing; a zone outside the window; the zone superset missing; an unread part; stop signal; shared address; active client; cap race (two transactions, exactly one passes); the first daily upsert; the minimum gap.
- Stop-signal triggers for each writer.
- Appointments: the lock trigger in both orders (closing appointments.ts:87-98); the assistant overlap refused; a human overlap allowed.
- `localWindowContains` versus Postgres `AT TIME ZONE` over 10,000 random instants and zones.

### 13.3 API adversarial (ISA-2/3)
- **Injection:** the full HostileIsaAi suite. Nothing unsafe is sent, and the recipient is unchanged. Remarks and notes never appear in a prompt.
- **Binding:** E503 (CC, spoof, second phone) and E495 (quoted email).
- **Tenancy:** cross-tenant on every route and job; 404 for another agent's contact.
- **Opt-out:** each E498 and E499 writer ends care; a forged queued row is refused; no email fallback.
- **Revocation and lock races, with barriers:**
  - ingestion paused after its cancel while TX-B commits;
  - a pause between TX-B and dispatch, during the model call, and during the book job;
  - an agent pause that crashes before the system transaction, then an owner resume: the old message is refused (epoch);
  - the switch turned off against 50 dispatches.
- **Scheduling:** a double "2" gives one booking; E531, E532, E533; offer expiry; a confirmation that cannot be sent ahead of notice is refused before booking.
- **Handoff completeness:** every terminal path's package has its fields; facts sent only; one card per event; the deadline and escalation (E521).
- **Backstop:** each E513 path gives exactly one pinned card.
- **Quiet hours:** E511–E514 with a fake clock.
- **Caps:** E515–E518, including bulk counting.
- **Kill switch:** E517, with an injected fetch that fails if it is called; AI_ISA_LIVE_SENDS with a stub non-fake email adapter.
- **Ownership:** E516, E525, E526.
- **Seller:**
  - E534–E538;
  - label snapshots;
  - the appraisal, worth, promise and market guards;
  - leases and future sales never shared;
  - a mirrored sale counted once;
  - another tenant's sale never read;
  - the architecture tests (no second comps path; `compsForSubjectInTx` has one caller; no ISA import of mailSync or prediction);
  - `cma.prepare` scope loss;
  - the subject confirmation cleared by an address edit;
  - the count query uncapped;
  - the watch skips on a version change.
- **D1 regressions:** paths.test.ts:212-231, firstResponse.test.ts:125-137 and gate.test.ts:72-79 pass unchanged.

### 13.4 End-to-end journeys (fake MLS, calendar, telephony, email, AI and DNC; Playwright on phone and desktop)
- **J1 buyer:** intake → first response → reply → handback → the agent calls (first touch) → "Let the AI assistant continue" → qualification → (the test records an express_written grant from the inquiry's own disclosure plus a fake "not listed" DNC result) → 3 listings with asking-price labels → saved-search proposal, which the agent approves (no alerts while care is live) → offer → "2" → booked → the handoff card → the deadline cleared by the agent's call. API as built (ISA-2b, cut 5; batch 13 audit ISA2B-09): only the booking half (offer → "2" → booked → the handoff → the agent's own text clears the deadline, booking.test.ts "J1"); the qualification and saved-search halves are pending as one journey, though each step has its own API test (buyer.test.ts: listings with asking-price labels, the proposal, approval, no alert while care is live, the handoff pause, re-activation).
- **J2 seller:** start → competition share → sold comps withheld (packs uncleared) with the honest sentence → the test clears platform:cma and platform:ai_isa_seller_data, records `ai_isa_comps` and confirms the subject → the complete comp set by email plus the SMS pointer → "what's it worth?" → the pricing line only, a hold, and "Prepare a CMA" → the agent's CMA (V1-C).
- **J3 takeover:** the agent texts by hand → paused, with a pause card → the owner resumes → a collaborator cannot resume. Take over with Undo.
- **J4 STOP mid-conversation**, and a STOP from a removed phone.
- **J5 quiet hours:** an inbound at 22:30 recipient time → the reply at 09:00 on the fake clock, with "Reply scheduled" shown.
- **J6 kill switch and AI_ISA_LIVE_SENDS:** the hold banner, then resumed with no clicks.
- **J7 tenant off:** all ended, cancels, notices.
- **Web specs (ISA-4, apps/web/e2e/ai-care, phone and desktop, taps counted, axe on each screen):** a1-setup (R-ISA-32: the switch, the Admin's cap refusal, the opt-in, the first-touch refusal and a 2-tap Start; V19); a2-controls (J3 web part: Pause in 1 tap from the list, the team lead without Resume, the owner's Resume, Take over with Undo, the finalize job and the handoff card, End in 2 taps with Undo, the hand-typed text's warning and Resume toast); a3-stop (J4 without the removed phone: covered by ISA-2's API tests); a4-quiet (J5 web part: the planned time in the viewer's zone with their time); a5-hold (J6); a6-tenant-off (J7 web part); a7-handoff (J1 partial: start from the person page, the AI label, AGENT, the handoff card, Got it, the owner's text and the sweep; the handback path is covered by component tests, the world has no first-response playbook). J2 (seller) is not built (ISA-3).

### 13.5 Runs
Before each lane's final push:
- `pnpm -r typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 test`;
- the Playwright folders touched;
- `node scripts/rule-coverage.mjs --phase=2-3`, with R-ISA-1…32 and E490–E539 named in the test titles.

---

## 14. Owner questions and VERIFY WITH COUNSEL items
The owner questions, with recommended defaults, are in <owner_questions>.

| Id | Item (**VERIFY WITH COUNSEL**) |
|---|---|
| C-ISA-1 | Whether AI-composed texts are "automated" messages under the TCPA and the state mini-TCPAs (Florida's FTSA, Oklahoma, Maryland; the existing C1 flag, PHASE2_3_PLAN:693). Whether a reply within the window of the person's own text is adequate for messages treated as marketing, or needs express consent. The consent standard for initiated messages. |
| C-ISA-2 | Whether a lead-provider or form disclosure covers AI-composed texts and adequately names the team. Whether "the disclosure body names the tenant" plus "scope stated" is a sufficient engineering test (intakeConsent.ts; consent.ts:317-333). |
| C-ISA-3 | Quiet hours, permitted days, holidays and frequency limits per state (for example 3 per 24 h on the same subject; 08:00–20:00). Whether replies are exempt. Whether the conservative zone union is adequate. |
| C-ISA-4 | National and state DNC obligations for AI initiated messages under express written consent, and the scrub freshness (31 days). |
| C-ISA-5 | AI-disclosure statutes (bot disclosure, state AI acts): the disclosure text, sign-off, From name and truthful answers. Whether a separate lead opt-in to AI conversations is required. |
| C-ISA-6 | Fair housing and HUD guidance on AI in housing communications: the escalation lexicon, structured-only criteria, the comps inputs (R-CMA-2), the area-question line (C3/C5). |
| C-ISA-7 | Real-estate licence law: which conversations an unlicensed AI may hold (scheduling and qualification versus pricing, terms and negotiation), and brokerage identity in messages. |
| C-ISA-8 | MLS licence and rules (**VERIFY WITH MLS**): sold data in automated client email (`valuation.ai_isa_comps`), the InternetAutomatedValuationDisplayYN scope, aggregate counts, attribution in SMS, distance and subdivision on comps with withheld addresses, and whether the replication key drops pending and sold records. |
| C-ISA-9 | The client wording for comps (the data-limit, relevance and concession lines) in `platform:ai_isa_seller_data`. The "estimate, not an appraisal" wording and the state statements for any later value. |
| C-ISA-10 | Code of Ethics Art. 16 and state rules on contacting a seller listed with another brokerage, or a buyer under agreement (R-ISA-26). |
| C-ISA-11 | The privacy notice, the model vendor DPA and retention for AI processing of client messages (anthropic.ts:3); CAN-SPAM for AI marketing email; the privacy_request handling. |
| C-ISA-12 | Crisis and safety wording; whether sending nothing outside the window plus immediate staff notification is the right default; the fraud-warning line. |

---

## Appendix A. Proposed decision row D12 (enters PHASE2_3_PLAN §2 when the owner confirms)

| D12 | 2026-11-12 (proposed; enters §2.2 when the owner confirms) | **AI inside sales agent (AI ISA) for buyers and sellers** (owner: "fully autonomous … until appointments are set or lead is ready to buy or sell", "Like a ISA"; "Same thing for sellers. ISA sends recently sold comps near them, new competition, etc"). **In:** for one lead at a time, switched on by that lead's current owner, a bounded multi-turn SMS and email conversation. It qualifies the person from their own words, shares grounded listings and, for sellers, new competing listings and counts by status. After counsel and MLS clearance it shares the complete set of D9 comparable recent sales by email. It nurtures inside caps, books one concrete slot the person explicitly agreed to from a live calendar, and hands off exactly once, with a response deadline that escalates to team leads. It acts without a tap only inside an approved, hash-frozen team policy. It is not unlimited autonomy. **Authorization, all default off:** the `AI_ISA_LIVE_SENDS` and TELEPHONY_LIVE_REQUESTS switches; `platform:ai_isa` (ships unreviewed; the DB refuses AI ISA sends until it is cleared); for sold-derived facts also `platform:cma`, the new `platform:ai_isa_seller_data` and the MLS licence's `ai_isa_comps` use; the Owner's tenant switch (re-auth and attestation; only the Owner turns it on or raises the cap); an approved team `ai_isa` policy version (Owner/Admin); the agent's own opt-in with re-auth and attestation; a per-lead start by the current owner after the lead's first human touch. Anyone who sees the lead may pause. Only the owner resumes. Take over or end in one tap, with a 10-second undo. A pause expires after 72 hours. **Reply rule:** unchanged for every other automation. Under live AI care, only the person's own SMS or DKIM-aligned email from the address bound at start is the AI's input (step 6 still pauses everything else). Every other inbound (calls, chat, synced mail, MMS, other addresses), and every one-to-one human message, approved draft or dial, hands back at once. A backstop guarantees that every reply is answered or handed back. Bulk sends never take over. **D1:** unchanged for every other path. AI ISA messages are treated as marketing and additionally need: consent evidence (replies, the person's own text within the reply window; initiated messages and any fact, written consent naming the team from the person's own disclosure with a stated scope, recorded after D12, plus a fresh national DNC result for texts); recipient-local quiet hours over a conservative zone set; at most 3 messages per 24 hours counting the person's other automated and bulk messages; attempt limits; and the live switches. These are engineering defaults in pack data, VERIFY WITH COUNSEL. Any opt-out, suppression or do-not-contact from any source ends AI care at once and blocks a restart. **Always human:** money, offers, contracts, negotiation, pricing strategy, listing decisions, commission, legal, lending, and any value opinion or range (none in v1; a later value needs a separate decision reversing D9 question (m)). Seller sold facts come only through D9's comps selection and V1-C's readiness gates, on behalf of an owner who holds cma.prepare, for a subject home the agent confirmed: the complete comp set or nothing, by email, labelled sold versus asking and closed versus pending versus active, never "appraisal" or a promised price, and no sold-derived market statistics in v1. Fair-housing topics, complaints, safety, fraud, consent disputes, requests for a person and anything out of scope escalate. **Never:** calls, MMS, web chat, ownership changes, touches or SLA credit, or a claim to be human (the disclosure and sign-off are platform text saying "AI assistant"). | PHASE2_3_PLAN §3 row "Multi-turn autonomous text qualification" (deferred → D12 for opted-in leads); ARCHITECTURE §11 :388 sentence, §18 :572 row, §21.3 :912 (adds a second bounded exception), C1 :533 (adds the model-worded mandate inside a frozen policy); DATA_MODEL R-AST-9 (scope), R-CONSENT-2/4 (the AI ISA reads the level and the disclosure), R-AST-20 (note); packages/core/src/assistant/playbook.ts:270 comment |

## Appendix B. Owner questions and the defaults that ship

| Id | Question | Recommended default (shipped) |
|---|---|---|
| Q-ISA-1 | Channels? | SMS and email only. No web chat, MMS or calls. |
| Q-ISA-2 | Quiet window and days? | 09:00–20:00 in every possible recipient zone (pack ceiling 08:00–20:00), replies included. Initiated Mon–Sat, none on US federal holidays. VERIFY WITH COUNSEL (C-ISA-3). |
| Q-ISA-3 | Caps? | 3 AI messages per 24 h; the AI also yields when the person has had 3 automated or bulk messages; initiated 1 per 24 h and 3 per 7 days; 40 per assignment; 3 unanswered → slow, 6 → dormant; tenant 100 a day. VERIFY WITH COUNSEL (C-ISA-3). |
| Q-ISA-4 | Consent evidence? | Replies: the person's own text, within 24 h. Initiated messages and any fact: written consent naming the team from the person's own disclosure, scope stated, recorded after D12. Agent-entered consent never counts for initiated messages. VERIFY WITH COUNSEL (C-ISA-1/2). |
| Q-ISA-5 | Booking autonomy? | On only when the agent enables it, with a live calendar, explicit agreement to one offered slot, and a confirmation that can be sent in time. |
| Q-ISA-6 | Value ranges to leads ever? | Never in v1. Later only by a separate decision that reverses D9 question (m) and needs platform:avm, platform:cma, platform:ai_isa_seller_data and a separate valuation use. |
| Q-ISA-7 | Sold comps to seller leads? | Only after platform:cma and platform:ai_isa_seller_data are cleared and the licence records `ai_isa_comps`, and only for a subject the agent confirmed. The complete set, by email only. VERIFY WITH COUNSEL / MLS (C-ISA-8/9). |
| Q-ISA-8 | May the human ISA role opt in? | No. |
| Q-ISA-9 | Who may start care on a lead? | The lead's current owner only, after the first touch. |
| Q-ISA-10 | Does an inbound call end care? | It pauses care. The package is linked to the call's card. |
| Q-ISA-11 | Disclosure wording and frequency? | Platform text: the first message per thread, every sign-off "AI assistant, {Brokerage}", the email From name, and truthful on request. Not editable by teams. VERIFY WITH COUNSEL (C-ISA-5). |
| Q-ISA-12 | Readiness thresholds? | 90 days; the §4.5 field sets. |
| Q-ISA-13 | What the client is told on escalation? | "I've passed this to {Agent}." No time promise. The owner's task is due by the handoff deadline. |
| Q-ISA-14 | Auto-enroll new leads by source? | Not built. Explicit per lead. |
| Q-ISA-15 | AI messages as a first touch or for SLA? | No (R-AST-15). Care cannot start before the human first touch. An inactivity warning hands off. |
| Q-ISA-16 | National DNC scrub for AI initiated texts? | Required: a "not listed" result within 31 days, or nothing is initiated by SMS, until counsel clears C-ISA-4. VERIFY WITH COUNSEL. |
| Q-ISA-17 | A lead-side "reply YES to chat with our AI" opt-in? | Not built by default. Disclosure plus a human on request. A pack flag can require it if counsel says so. VERIFY WITH COUNSEL (C-ISA-5). |
| Q-ISA-18 | May collaborators pause? | Yes. Only the owner resumes. Every pause notifies the owner and expires after 72 h. |
| Q-ISA-19 | Languages? | English only. Others escalate. |
| Q-ISA-20 | Handoff response deadlines? | Critical 15 business minutes, high 2 business hours, normal the next business day. Breaches go to team leads, then Owner/Admin. VERIFY. |
| Q-ISA-21 | Should a photo or MMS reply hand back? | Yes: an MMS is never an AI turn. The agent sees it at once. |
| Q-ISA-22 | Zone strictness when the lead's zone isn't explicitly set? | A conservative union including the continental US zones (effectively 12:00–20:00 Eastern). VERIFY WITH COUNSEL (C-ISA-3). |
| Q-ISA-23 | Bulk sends to people under AI care? | Preflight skips them by default. If they are sent, they count toward the 3-per-day budget and never pause AI care. |
| Q-ISA-24 | Comps refresh cadence? | At most once per 30 days, only when the set changed, the full set each time. |
| Q-ISA-25 | Pricing questions from sellers? | The fixed pricing line only, then no comps until the agent acts (prepare a CMA, share one, or allow the AI to continue). |
| Q-ISA-26 | Safety messages outside quiet hours? | No automated reply. An immediate critical notification to the owner, team leads and Owner/Admin. VERIFY WITH COUNSEL (C-ISA-12). |
| Q-ISA-27 | Should a post-handoff confirmation or holding line still go if the agent's opt-in or the team policy is revoked after the handoff? (batch 12 review, isa-2-3) | Yes, as built: it was approved at handoff, and it still meets D1, stop signals, person blocks, consent, quiet hours and caps. If the owner says no, TX1 and the guard add the opt-in and membership checks for the post-handoff set together. |
| Q-ISA-28 | (ISA-2b Q1) Who gets the handoff after a take over? | Built: the person who took over gets the card and the deadline; the owner is notified (`ai_isa_ended`). After an End, the owner. |
| Q-ISA-29 | (ISA-2b Q2) Which hours may the AI offer? | Built: the agent's opt-in availability clipped to routing hours in the agent's zone; with no windows, routing hours Mon–Fri; always 08:00–20:00 in every client zone. VERIFY (engineering defaults). |
| Q-ISA-30 | (ISA-2b Q3) Offer times to a person with a future appointment? | Built: no; the booking_unavailable line to them, and the agent sees "They already have an appointment on {date}" (the date in the team's zone; batch 13). |
| Q-ISA-31 | (ISA-2b Q4) Which channel do AI-proposed alerts use? | Built: email when bound, else SMS. VERIFY. |
| Q-ISA-32 | (ISA-2b Q5) Is reactivating a paused AI-origin search re-approval? | Built: a paused search with unchanged criteria is re-activated without a new approval (POST /saved-searches/:id/activate); editing criteria follows module 24's rules, unchanged by ISA-2b. The homes the AI already sent are never alerted (tested). |
| Q-ISA-33 | (ISA-2b Q6) How many homes per turn? | Built: 6 offered to the model, at most 3 per message, none repeated within 90 days. VERIFY WITH MLS. |
| Q-ISA-34 | (ISA-2b Q7) A listing text too long for 3 SMS segments? | Built: email if bound and passing, else drop whole listings from the end until it fits (attribution kept), else nothing. Never "I can email you". |
| Q-ISA-35 | (ISA-2b Q8) Care ended during a booking: keep the appointment? | Built: yes, with no confirmation and a critical "confirm or cancel it yourself" card. |
| Q-ISA-36 | (ISA-2b Q9) Does the inactivity warning end paused care too? | Built: yes, with the pinned handoff ("returns to the pond on {date} unless you touch them"). |
| Q-ISA-37 | (ISA-2b Q10) Does a bare "ok", "great" or "perfect" to a single offered time book it? | Built: no; one clarification. "Yes", "that works" or the number books. A tapback is the same as "ok". VERIFY WITH COUNSEL. |
| Q-ISA-38 | (batch 13, b12 recheck R25) Which one zone vocabulary do the turn and the send check share? | Built default: fail closed. The turn stores ICU-canonical names while the send check reads stored spellings (the tenant default zone, contact_points.timezone, pre-fix contact zones, 0080's area-code and state tables), so a person whose zone is spelled two ways (an Indianapolis area code: ICU America/Indianapolis, the table America/Indiana/Indianapolis) is never sent an AI message: ISA_ZONE_UNRESOLVED, "Their time zones could not all be resolved, so the AI assistant waited." Options: the database's tzdata spellings on the turn, or an alias table kept equal to core by a test, with a backfill of stored aliases. |
| Q-ISA-39 | (batch 13, b12 recheck R23) Should the owner's Continue AI care (or a re-attestation) still send the ended assignment's "AI care handed back" notification? | Built default: yes, kept (an honest record that the old assignment ended); its pinned card closes at once as care_continued. Suppressing it, or wording it as a continuation, is the owner's call. |
| Q-ISA-40 | (batch 13, b12 recheck R24) The deadline sweep's P2 fires once, on the 3rd failed pass in total of a handoff (the count is never reset). Is 3 right, should a successful pass reset it, and should the alert repeat while the row keeps failing? | Built default: 3, never reset, raised once; a count that cannot be written raises one P2 an hour per tenant. |
| Q-ISA-41 | (batch 13, b12 recheck R23) An assignment paused approval_revoked and continued by re-attestation ends policy_updated. Should it have its own end reason? | Built default: policy_updated (approval_revoked is a pause reason only); a new reason needs a core ISA_END_REASONS value and the end_reason CHECK. |
