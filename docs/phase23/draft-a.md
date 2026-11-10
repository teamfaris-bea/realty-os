# Phase 2 and Phase 3 design: draft A (simplicity-first)

Status: **draft for review**, one of several independent drafts. Nothing here is authoritative until it is merged into ARCHITECTURE / DATA_MODEL / BUILD_PLAN. Scope comes from `docs/VISION.md` (capability → phase table) and the Phase 2/3 scope list given to this design pass.

**The lens.** Every capability below answers four questions before it gets a table or a screen:
1. What job does it take off an agent's (or TC's, TL's, Owner's) plate, and on which device?
2. Which Phase 1 machine already does most of it? (playbooks + approvals, `assistant_actions` + claims + `evidence_refs`, `dispatchOutbound` / `dialOutbound` + the opt-out guards, the exception queue, `behavior_events`, the ownership engine, `jobs` + the sweeper, `priority_feed_items`, `stored_objects`, the scoreboard definers.)
3. What is the smallest delta (columns before tables, an enum value before a column, a view before a projection)?
4. What must a human still tap?

Legal statements are marked **VERIFY WITH COUNSEL** and live in data (jurisdiction packs or versioned tenant settings). Where we are not sure an outside API exists or permits something, the text says so. Owner decision **D1** stays in force: sending checks opt-outs (STOP and other keywords, unsubscribe, agent-recorded do-not-contact, suppressions), never consent level, the DNC registry, quiet hours or caps; every new channel plugs into the same single dispatch path and the same opt-out model, in core **and** in the DB guards. Nothing in this draft weakens the opt-out block or the autonomy rules (money, contracts, a new kind of client message and seller updates always need a tap; an inbound reply pauses automation and hands back).

---

## 0. The whole design on one page

**New concepts: 4.** Everything else is a new enum value, a column, a view, a job kind, a playbook kind or an `assistant_actions` kind.

| New concept | Why it cannot be an existing one |
|---|---|
| **Channel connection** (`channel_connections`) | A Facebook Page, Instagram account, website chat widget or lead-email inbox is a sender identity that is not a phone number or an email identity. Same role as `phone_numbers` / `email_identities`, same global-uniqueness rule for webhook routing. |
| **Marketing piece** (`marketing_pieces`) | A website page, flyer or social post is not a message to a person, so it cannot ride on `messages`; it needs its own approval (hash-bound, like a playbook version) and a public snapshot. |
| **Trigger playbook** (`playbooks.kind = 'trigger'`) | Behavior triggers (price drop, new match, anniversary, rate move, contract date coming up) are one-off steps that must not consume the contact's single live enrollment. A trigger firing is a `playbook_step_runs` row without an enrollment; everything else (approval, hash freeze, send-time gate, pause, failed-send exception) is Phase 1 unchanged. |
| **Client principal** (Phase 3: `client_accounts`, `client_grants`, `portal_entries`) | The portal user is not a staff member. Layer 1 already reserves `principal_type`; clients get their own tables and never touch a staff table. |

**Phase 1 reuse map** (what each capability rides on):

| Capability | Rides on |
|---|---|
| Unified inbox (DMs, chat, portal leads) | `conversations` (one per person), `messages.channel`, `contact_points`, consent/suppression keys, `messages_dispatch_guard`, lead intake + routing, handbacks |
| Seller updates (incl. the "seller report") | `showings`, `showing_feedback`, `marketing_activity`, MLS `listings`, `assistant_actions kind='seller_update_draft'` (DB already forces approval) |
| Marketing built in | `listings`, `assistant_actions` + claims (listing-field evidence), `stored_objects`, brokerage identity + jurisdiction packs, `dispatchOutbound` for invites |
| Transaction milestones | `deal_dates`, `deal_contacts`, exception queue (one new type), trigger playbooks for client/lender updates |
| MLS/IDX feed | `listings.source='mls'`, `listing_price_history` trigger, `saved_search_matches`, `MlsFeed` interface |
| Home value updates | `home_valuations`, `AvmProvider`, intent `home_value_update` (already `requires: ['avm']`) |
| Behavior triggers | trigger playbooks, `behavior_events`, `listing_price_history`, `saved_search_matches`, `deals.closed_at`, `deal_dates` |
| Owner view | `deals` attribution (immutable), `deal_financials`, `deal_stage_history`, views; one cost table |
| Goals + weekly plans | `agent_goals`, `assistant_actions kind='weekly_plan'` (reserved), scoreboard definers (0012), tasks |
| Calendar sync | `appointments` + three columns, a self-only credential table |
| Review requests | `post_closing` playbook, one new intent |
| Call scoring + daily fix | transcripts, claims/evidence verification, recording-scope RLS, feed |
| Voice AI (P3) | `calls`, recording rules, transcripts, `call_summary`, handbacks, playbooks (kind `voice_answering`), `dialOutbound` for the transfer leg |
| Prediction (P3) | `contact_attributes.sensitivity` exclusion (R-AST-12), feed, evidence |
| Ads (P3) | `lead_inquiries.campaign_ref/ad_ref`, deal attribution, the cost table, `assistant_actions` (money ⇒ approval) |
| Client portal (P3) | `principal_type` Layer 1, deal/listing visibility rules for who may grant |
| Documents, GBP, coaching trends (P3) | `stored_objects`, claims with page evidence, `deal_dates` proposals, `marketing_pieces`, `call_scores` view |

**Schema plan.** One design-first migration per phase, written before the feature modules start (as `0001` was for Phase 1): `0015_phase2_schema.sql` and `0016_phase3_schema.sql`. Feature modules then add only indexes or definer functions in their own later-numbered files. Phase 2 adds **6 tables** (5 tenant + 1 global); Phase 3 adds **9 tenant tables**. `core-compliance` moves to **2.2.0** (channels) in Phase 2 and stays there in Phase 3 (voice adds no send-time check; it adds DB CHECKs).

**Sequencing (phone-first value first).** 2A inbox + MLS feed + triggers → 2B seller updates + milestones + calendar → 2C marketing + home values + reviews → 2D goals/weekly plans + call coaching + owner view. Phase 3: 3A voice answering → 3B client portal + documents → 3C prediction + coaching trends → 3D ads + GBP. Section 7 explains why.

---

## 1. Inventory: what Phase 1 already shaped, and what is missing

### 1.1 Already in the schema (0001–0014) for later phases

| Table / column | Shaped for | State today | Phase 2/3 use |
|---|---|---|---|
| `listings.source IN ('team','mls')`, `mls_number`, `UQ(source, mls_number)` | MLS competing listings | `mls` rows writable by system only; nothing writes them | MLS/IDX sync (P2) |
| `listing_price_history` [AO] (trigger) | price-drop nurture | written on every team price change | price-drop trigger (P2) for MLS rows too |
| `saved_searches`, `saved_search_matches` | buyer searches | matched against team listings only | MLS matching + `new_match` trigger (P2) |
| `showings`, `showing_feedback` | seller updates | Phase 1 logging UI | assembly (P2), portal (P3) |
| `marketing_activity` | seller updates | data model only | written when a marketing piece is published/exported; read by seller updates |
| `home_valuations` | AVM | data model only | monthly values (P2) |
| `agent_goals` | goals | data model only | goals (P2) |
| `behavior_events` [AO] (`reliability fact/signal`) | behavior nurture | captured | trigger input (facts only) |
| `deal_dates` (`acceptance/inspection/appraisal/financing/closing/possession/custom`) | milestones | feed input | milestones (P2) |
| `deal_stage_history` [AO], `v_pipeline_momentum` | velocity | TL momentum | owner velocity + forecast (P2) |
| `deals.lead_source_id/campaign_ref/ad_ref/source_inquiry_id` (immutable), `deal_financials` | owner $ view | captured | owner view (P2), ads (P3) |
| `lead_inquiries.campaign_ref/ad_ref/source_detail` | ad attribution | captured | ads (P3) |
| `assistant_actions.kind` incl. `seller_update_draft`, `weekly_plan` (reserved) | P2 | CHECK: seller update ⇒ `seller_update` + `requires_approval` | seller updates, weekly plans |
| `conversations` UQ per contact, `messages.channel` ("widen by migration") | unified inbox | `sms/mms/email` | DMs, web chat (P2) |
| `calls.initiator` / `handled_by` CHECKs (no AI) | voice AI | forbids AI | relaxed for inbound only (P3) |
| `app.principal_type()` + Layer 1 `= 'staff'` on every table | client portal | non-staff sees nothing | client principal (P3) |
| `contact_attributes.sensitivity = 'protected_proxy'` (+ self-reported CHECK) | fair housing | excluded by type from feed scoring | prediction exclusion (P3) |
| `stored_objects` (tenant-prefixed keys, per-object DEK) | documents | recordings, MMS, imports, consent evidence | marketing assets (P2), documents (P3) |
| `provider_credentials.provider` incl. MLS, AVM | adapters | fake only | real adapters (P2) |
| `jurisdiction_packs.rules` (AI disclosure, advertising/team-name rules) | packs | US placeholder, unreviewed | marketing identity, voice disclosure, IDX display, fair-housing lexicon |
| `playbook_enrollments.anchor_kind/anchor_id` (0008) | event-anchored steps | deal/appointment/task | unchanged |
| Intents `home_anniversary`, `home_value_update`, `referral_ask` | post-closing | defined | used by triggers / AVM |
| `MlsFeed`, `AvmProvider` interfaces | adapters | fake / "not available" | real adapters |

### 1.2 Missing (this draft adds)

**Phase 2 tables (6):** `channel_connections`, `marketing_pieces`, `lead_source_costs`, `user_integrations`, `call_scores`, `market_rates` (global, platform-maintained).

**Phase 2 column/enum deltas (no new concept):**
- `messages.channel` + `messenger`, `instagram`, `web_chat`; `messages.channel_connection_id`; the two sender CHECKs rewritten per channel.
- `contact_points.kind` + `messenger`, `instagram`, `web_chat` (address formats below).
- `consent_events.address_kind/channel`, `consent_state.channel`, `suppressions.address_kind/channel` + the three new channels; compatibility CHECK extended.
- `messages_dispatch_guard` replaced (table-driven channel → consent channel / point kind; unknown channel ⇒ raise).
- `lead_sources.kind` + `social_dm`, `web_chat` (`portal` already exists for Zillow/realtor.com).
- `playbooks.kind` + `trigger`; `playbook_step_runs.enrollment_id` nullable + `contact_id`, `trigger_key`, `trigger_ref`.
- `deal_dates` + `source`, `confirmed_by_user_id`, `confirmed_at`, `responsible`; `deal_contacts.role` + `lender`, `title`, `attorney`.
- `appointments` + `external_provider`, `external_event_ref`, `external_etag`, `external_detached_at`.
- `listings` + `idx_display` (jsonb), `last_seen_in_feed_at`, `idx_allowed`; `saved_search_matches` + `match_reason`.
- `provider_credentials` + `sync_cursor`, `last_synced_at`, `last_sync_error`.
- `exception_items.item_type` + `milestone_at_risk`; `priority_feed_items.item_type` + `seller_update`, `marketing_review`, `weekly_plan`, `coaching_fix`, `trigger_draft`; `notifications.kind` + `seller_update_ready`, `milestone_risk`, `weekly_plan`.
- `assistant_actions.kind` + `marketing_draft`, `call_review`; `ai_runs.purpose` + `seller_update`, `marketing_draft`, `call_review`, `weekly_plan`.
- `evidence_refs.source_type` + `showing`, `showing_feedback`, `marketing_activity`, `home_valuation`, `deal_date`, `metric`, `market_rate`.
- `stored_objects.purpose` + `marketing_asset`.
- `tenant_settings` + `seller_update_cadence_days` (7), `trigger_coalesce_hours` (24), `review_link_url`, `brand_logo_object_id`, `brand_color`, `avm_max_range_bps` (2500), `coaching_rubric_disabled` (text[]), `calendar_title_detail` (`first_name_initial/none`).

**Phase 3 tables (9):** `client_accounts`, `client_sessions`, `client_grants`, `portal_entries`, `documents`, `property_records`, `contact_predictions`, `ad_campaigns`, `ad_budget_versions` [AO].

**Phase 3 deltas:** `calls.handled_by` + `assistant`, `calls.ai_disclosed_at`, `calls.voice_playbook_version_id`, `calls.transferred_to_user_id`, `calls.transfer_outcome`; `playbooks.kind` + `voice_answering`; `assistant_actions.kind` + `ad_reallocation`, `review_reply_draft`, `contract_extraction`; `marketing_pieces.kind` + `gbp_post`; `channel_connections.kind` + `gbp`, `meta_ads`, `google_ads`; `tasks.client_visible`; `stored_objects.purpose` + `document`; a client-aware Layer 1 policy on the portal tables only.

---

## 2. Cross-cutting decisions

### 2.1 The channel model (one dispatch path, one opt-out model)

| Channel (`messages.channel`) | Consent channel | Point kind / address format | Sender identity | Outbound allowed when |
|---|---|---|---|---|
| `sms`, `mms` | `sms` | `phone` E.164 | `phone_numbers` | Phase 1 rules |
| `email` | `email` | `email` | `email_identities` | Phase 1 rules |
| `messenger` | `messenger` | `messenger`: `fb:{page_id}:{psid}` | `channel_connections kind='messenger'` | inside the platform messaging window after the person's last inbound on that channel (R-INBOX-6) |
| `instagram` | `instagram` | `instagram`: `ig:{account_id}:{igsid}` | `channel_connections kind='instagram'` | same |
| `web_chat` | `web_chat` | `web_chat`: `wc:{32 hex session}` | `channel_connections kind='web_chat'` | while the chat session is live (R-INBOX-8) |

- **Page-scoped ids.** Meta's Messenger PSIDs and Instagram-scoped ids are per Page/account, so the address carries the account id; two Pages give two points for one person. HMACs are computed over the full address string, exactly like phones and emails.
- **Opt-out per channel, person-level for "do not contact".** A keyword STOP on a DM channel revokes that channel on every point of that kind on the contact (mirrors "an SMS STOP revokes all the contact's phones"). Opt-out *language* or an agent-recorded "do not contact me" on any channel revokes **every channel on every point of the contact** (VISION: "anyone who asks not to be contacted is not messaged or called again"). This only refuses more sends than Phase 1, so it never weakens D1.
- **The guard.** 0015 replaces `messages_dispatch_guard` with a table-driven mapping (`CASE channel WHEN 'email' THEN … WHEN 'messenger' THEN …`), and an unknown channel raises `CHANNEL_UNKNOWN`. Important finding: if `messages.channel` were widened without replacing the guard, a DM would map to `sms`, fail the `RECIPIENT_NOT_A_CONTACT_POINT` lookup and be refused. That is fail-closed, but it makes DMs unsendable, so the guard and the CHECK must change in the same migration (E80).
- **Provider methods.** New reserved outbound names `sendDm` (Meta) and `sendChatMessage` (web chat) join `sendSms` / `sendEmail` / `dialCall` in the `realty/no-provider-outbound` lint rule. They may be called only from `apps/api/src/comms/dispatch.ts`. The lint plugin is scaffold-owned, so this is a flagged additive edit.
- **What the assistant may do on DMs:** only the 60-second first response (on the channel the lead wrote in, inside the window) and human-approved drafts. Playbook steps keep `channel: 'sms' | 'email'`, so nurture, alerts and triggers can never go out by DM (Meta's own rules also restrict promotional messages; **VERIFY** current Meta platform policy).

### 2.2 Trigger playbooks (behavior-aware nurture without a second enrollment)

```
fact appears (listing_price_history row, saved_search_matches row, deal anniversary, market_rates row, confirmed deal_date)
  → job triggers.detect (dedupe on the fact) → for each contact whose OWNER has an approved trigger playbook step for this kind:
       playbook_step_runs(enrollment_id NULL, contact_id, trigger_key UQ, status 'scheduled', scheduled_for = coalesce window end)
  → sweeper (existing playbook-step branch) → executePlaybookStep (existing) → re-check the fact (R-NURT-4)
       → authorizeAutonomousAction + canContact at send time (existing) → dispatchOutbound
       paused conversation ⇒ converted_to_draft (existing status) ⇒ feed card 'trigger_draft'
```

- `trigger_key = trig:{playbook_version}:{step_key}:{contact}:{subject_id}:{subject_version}` (unique) gives "at most once per fact".
- Coalescing (default 24 h): several firings for one contact inside the window become **one** message listing each item with its evidence. It is a product setting, explicitly **not** a compliance cap: nothing is dropped or deferred for compliance reasons, and setting it to NULL sends each firing on its own.
- Why not a second enrollment: `playbook_enrollments` allows one live enrollment per contact (DB unique), and a nurture sequence should not be stopped by a price drop.

### 2.3 Approval objects stay the Phase 1 ones

| Thing a human approves | Object | Bound by |
|---|---|---|
| A rule the assistant runs inside (nurture, triggers, transaction updates, voice answering) | `playbook_versions` + `playbook_approvals` [AO] | `content_sha256`, approver role trigger |
| One assistant output (draft, seller update, rate-move draft, review reply, ad reallocation, weekly plan) | `assistant_actions` (status `approved`, `decided_by`) | stale checks (`pinned_inbound_seq`, `bound_ownership_seq`) |
| One marketing piece version | `marketing_pieces` (`approved_by`, `content_sha256`) | prose hash; fact fields bound live (R-MKT-2) |
| The ad budget cap (P3) | `ad_budget_versions` [AO] | Owner + re-auth + attestation |

No new approval mechanism is added.

### 2.4 New public (unauthenticated) entry points

Phase 1 had none apart from signed webhooks. Phase 2 adds two, Phase 3 one. Each is a `SECURITY DEFINER` function owned by `app_definer` with pinned `search_path` and minimal columns (security-review items):

| Function | Phase | Returns | Abuse controls |
|---|---|---|---|
| `app.resolve_public_page(slug)` | 2 | the published snapshot of a `website_page` piece plus its bound live fact fields; nothing else | CDN cache, rate limit, 410 for retracted |
| `app.resolve_channel_connection(kind, external_account_id)` / `app.resolve_chat_widget(key_hash)` | 2 | tenant id + connection id | signed Meta webhooks; widget: per-key + per-IP rate limits, proof-of-work or CAPTCHA adapter, origin allowlist |
| `auth.resolve_client_session(token_hash)` | 3 | client account id, tenant id | same session rules as staff, separate cookie |

### 2.5 The client principal (Phase 3), the safe way

- **Staff tables never change their Layer 1.** Every table that exists today keeps `principal_type = 'staff'`. The client portal reads **only** three new tables (`client_grants`, `portal_entries`, and `documents` through entries), whose Layer 1 is `tenant_id = app.tenant_id() AND principal_type IN ('staff','client')`, plus Layer 2 `principal_type = 'client' ⇒ grant_id = ANY(app.my_client_grant_ids())`.
- **Projection, not live joins.** A system job publishes `portal_entries` from source rows (confirmed deal dates, shared documents, showings, shared feedback, sent seller updates, client-visible tasks). The client can therefore never reach `deals`, `contacts`, `messages` or `deal_financials`, even through a bug in a staff policy. The cost is drift; the `portal.sync` job runs on relevant writes plus a nightly full re-publish per grant.
- A generated test sets `principal_type='client'` and asserts 0 rows from **every** pre-0016 table (E129).

### 2.6 Honest about outside services

| Service | What we know | Phase 2/3 stance |
|---|---|---|
| Facebook Messenger / Instagram messaging (Meta Graph API) | Exists for business Pages/accounts; needs a Meta app with permissions granted through app review; a messaging window applies (commonly 24 h, with a human-agent tag for longer replies). **VERIFY** current Meta policy and terms. | Adapter + deterministic fake; real use waits for app review. |
| Facebook Marketplace | **No general API for posting real-estate listings that we know of.** | Export/copy flow only (copy text, download photos). The UI says so. |
| Instagram / Facebook Page posting | Content publishing APIs exist for business accounts, with app review. **VERIFY.** | Export by default; API publish behind a connection when approved. |
| Meta Lead Ads | Webhook-based lead retrieval exists, needs app review. **VERIFY.** | Intake adapter + fake. |
| Zillow / realtor.com lead delivery | Both deliver leads to CRMs through partner programs that need approval; we have **not** confirmed access, field shapes or terms. Lead notification emails are the reliable fallback. | Email-parse intake first (fake + recorded fixtures); partner connectors when access exists. |
| MLS / IDX | RESO Web API is the common standard; access needs an MLS data license and IDX/VOW rules that differ per MLS. **VERIFY WITH COUNSEL / MLS.** | `MlsFeed` adapter shaped on RESO fields + fake; per-MLS display pack as data. |
| AVM / public records | Vendors exist (commercial, licensed); we have not chosen one. | Adapters + fakes; vendor and license terms open. |
| Google / Microsoft calendars | Google Calendar API and Microsoft Graph exist; calendar scopes need OAuth app verification. | One-way push + free/busy read. |
| Mortgage rates | Public weekly survey rates exist (e.g. Freddie Mac PMMS); **VERIFY** redistribution terms. | Platform-level `market_rates` fed by an adapter + fake; Admin can also enter rates. |
| Voice AI (real-time speech) | Telephony media streaming plus a speech model is feasible; vendor not chosen. | `VoiceAgentProvider` adapter + scripted fake. |
| Google Business Profile | APIs exist but access must be requested and approved. **VERIFY.** | Adapter + fake; export fallback for posts. |
| Ads (Meta Marketing API, Google Ads API) | Exist; need ad accounts, developer access, and housing special ad category rules. **VERIFY.** | Adapters + fakes. |

---

## 3. Phase 2 capabilities

Each subsection: **Jobs** (role, device) · **Data** · **RLS** · **Core** · **API** · **Worker** · **UI** · **Autonomy** · **Opt-outs** · **Adapter** · **Rules** (numbered; edge cases are in §6).

### 3.1 Unified inbox beyond SMS/email/call

**Jobs.** Agent (phone first): every DM, chat and portal lead lands in the same thread and the same feed card as a text, with one compose box that picks the right channel. ISA: same. Admin (desktop): connect a Facebook Page, an Instagram account, a chat widget, a lead-email inbox.

**Data.**
```
channel_connections (tenant_id, id) PK
  kind            text CHECK IN ('messenger','instagram','web_chat','lead_email')   -- P3 adds 'gbp','meta_ads','google_ads'
  external_account_id text NOT NULL        -- Page id / IG account id / sha256 hex of widget key / inbox token hash
  display_name    text NOT NULL
  credential_id   uuid → provider_credentials (NULL for web_chat)
  lead_source_id  uuid NOT NULL → lead_sources   -- attribution for contacts it creates
  status          text CHECK IN ('pending','active','error','disconnected')
  allowed_origins text[]                    -- web_chat only
  connected_by_user_id → memberships, connected_at, disconnected_at
  UNIQUE (kind, external_account_id) WHERE status <> 'disconnected'   -- global (cross-tenant), like phone_numbers
```
- Deltas listed in §1.2 (channel enums, point kinds, guard, sender CHECKs: `channel IN ('messenger','instagram','web_chat') AND direction='outbound' AND NOT imported ⇒ channel_connection_id IS NOT NULL`).
- Point address CHECKs: `messenger` `^fb:[0-9]+:[0-9]+$`, `instagram` `^ig:[0-9]+:[0-9]+$`, `web_chat` `^wc:[0-9a-f]{32}$`.
- Zillow/realtor.com/Meta Lead Ads add **no** table: they are `lead_sources (kind 'portal'/'ads')` feeding `lead_inquiries`.

**RLS.** `channel_connections`: read members, write Owner/Admin, system. Points and messages on new channels inherit the Phase 1 contact-detail rule. Consent/suppression rows on new channels follow Phase 1 policies. Client principal: none.

**Core** (`core/compliance` 2.2.0). `ChannelSpec` registry (`consentChannel`, `pointKind`, `windowRule`), `canContact` checks: opt-out per mapped consent channel, `CHANNEL_WINDOW_CLOSED`, `CHANNEL_SESSION_ENDED`, `SENDER_MISSING` for a disconnected connection. `classifyInbound` reused per channel (pack keywords). New pure `optOutFanout(contactPoints, trigger: 'keyword'|'language'|'agent_dnc', channel)` returns the consent events to write. `normalizeDmAddress`.

**API** (`apps/api/src/channels/**`):
- `POST /webhooks/meta` (signature-verified; resolve connection; idempotent; `ingestInbound` with channel), `POST /webhooks/lead-email/:token` (parsed by `core/import`-style source templates → `ingestInquiry`).
- Public chat: `POST /public/chat/:widgetKey/start` `{name, phone|email, message, disclosureId}` → intake (contact, inquiry, routing, 60-second reply **in the chat**), returns a chat session token; `POST /public/chat/session/:token/messages`; `GET /public/chat/session/:token/stream` (SSE, only that session's thread).
- Admin: `GET/POST/DELETE /channel-connections` (Meta OAuth connect flow; widget key issue/rotate, shown once).
- `dispatch.ts` gains `sendDm` / `sendChatMessage` branches (edit owned by this module, coordinated with comms).

**Worker.** `channels.sync_status` (token health, every hour), `channels.chat_expire` (idle 30 min ⇒ session ended). Inbound reuses `ingestInbound` (pause + handback unchanged).

**UI.** Phone: thread shows a small channel chip per message ("Messenger", "Chat"); compose defaults to the channel of the last inbound and says why another is offered ("Messenger window closed 2 h ago. Text instead?"). Pond/offer cards show the source ("Zillow", "Instagram"). Desktop admin: Connections page with honest status ("Waiting for Meta approval", "Last message received 3 min ago"). Widget: a small embeddable script (`apps/web/src/widget/**`, its own tiny bundle) that shows the brokerage name, the disclosure and "You're chatting with {Team}; the first reply may come from the team's assistant."

**Autonomy.** 60-second first response may go out on the DM/chat channel it arrived on (category `speed_to_lead_reply`, same `new_lead_response` playbook, same one-message rule). Everything else on DMs is human or approved draft.

**Opt-outs.** As §2.1. STOP confirmation on DM channels is the system's one `opt_out_confirmation` reply to that address within 24 h (same exemption shape as SMS in 0014).

**Adapters + fakes.** `MetaMessagingProvider` (`sendDm`, `verifyWebhook`, `fetchProfileName`), `WebChatHub` (in-process SSE fan-out; `sendChatMessage`), `LeadEmailParser` (pure templates in core + fixture emails per source).

**Rules.**
- **R-INBOX-1** Every message on any channel belongs to the contact's single conversation (existing UQ); the timeline and feed show the channel. [DB + api]
- **R-INBOX-2** Outbound on `messenger`, `instagram` and `web_chat` goes only through `dispatchOutbound`; `sendDm` / `sendChatMessage` are reserved names callable only from `dispatch.ts`. [lint + architecture test]
- **R-INBOX-3** Consent, suppression and gate rows for the new channels are keyed `(channel, purpose, address_hmac)` like Phase 1. `messages_dispatch_guard` maps each message channel to its consent channel and point kind; an unmapped channel raises `CHANNEL_UNKNOWN`; a DM to a revoked or suppressed address is refused for every initiator. [DB, smoke + dispatch_guard test]
- **R-INBOX-4** A keyword STOP on a DM or chat channel revokes that channel (all purposes) on every point of that kind on the contact, cancels queued messages on it and pauses enrollments; at most one confirmation goes to the sending address within 24 h. **VERIFY WITH COUNSEL** (keyword list per channel). [core + db]
- **R-INBOX-5** Opt-out language on any channel, or an agent-recorded "do not contact", revokes every channel (sms, voice, email, messenger, instagram, web_chat) on every point of the contact, with `needs_review` for language. "Not an opt-out" restores only revocations written by that language event. This tightens R-CONSENT-8 and never loosens it. [core + db]
- **R-INBOX-6** Messenger/Instagram outbound is allowed only within the channel window after the person's last inbound on that channel (`ChannelSpec.windowRule`, default 24 h, platform-configurable; **VERIFY** Meta policy incl. any human-agent extension). Outside it, `canContact` denies `CHANNEL_WINDOW_CLOSED` for every initiator and the UI offers the contact's other channels. This is a platform rule, not consent; D1 is unchanged. [core]
- **R-INBOX-7** The assistant uses DM/chat channels only for the 60-second first response and approved drafts; `PlaybookStep.channel` stays `sms | email`. [core schema]
- **R-INBOX-8** A web chat starts only after the visitor gives a name plus a phone or email and sees the disclosure; it then goes through lead intake. Outbound to `web_chat` is allowed only while the session is live (idle ≤ 30 min, else `CHANNEL_SESSION_ENDED`). A chat session token reads only its own thread. [api + core]
- **R-INBOX-9** Portal and ad leads (Zillow, realtor.com, Meta Lead Ads) enter only through lead intake (`lead_inquiries`, routing, attribution, dedup). A parsed lead email with no extractable phone or email creates an Admin review card and routes nothing. [api]
- **R-INBOX-10** An unknown DM sender becomes a contact through intake routing with the connection's lead source. Identities are never merged by profile name; the agent gets a suggestion and merges with R-OWN-24. [core + api]
- **R-INBOX-11** `(kind, external_account_id)` is globally unique among non-disconnected connections; inbound for a disconnected connection is `unrouted`; outbound through it is denied `SENDER_MISSING`. [DB]

### 3.2 MLS/IDX feed (buyer-search matching and competing listings)

**Jobs.** Agent (phone): saved-search alerts and "new in Jane's search" cards now include the whole MLS, not just team listings. Seller-side agent: competing listings appear in the weekly seller update without searching the MLS by hand. Admin: connect the MLS feed and confirm the display rules.

**Data.** `listings` + `idx_allowed boolean` (feed's IDX flag; false ⇒ never shown to clients), `idx_display jsonb` (listing office/agent attribution the pack requires), `last_seen_in_feed_at`; `saved_search_matches` + `match_reason` (`new_listing/price_drop/back_on_market`); `provider_credentials` + `sync_cursor`, `last_synced_at`, `last_sync_error`. Display rules live in `jurisdiction_packs`-style data keyed by MLS (`mls:{code}` in a new `rules.idx` block of the tenant's pack list; **VERIFY WITH COUNSEL / MLS**). No new table. Per-tenant copies of MLS rows are kept because IDX licenses are per brokerage (risk: volume, §8).

**RLS.** Unchanged: `listings` readable by members; `mls` rows writable by system only. Client principal: none (the portal never shows raw MLS rows).

**Core** (`core/listings`, new subpath): `normalizeMlsListing(raw: ResoLike): ListingFacts | Issue[]`; `idxDisplayCheck(listing, pack, surface: 'alert'|'seller_update'|'preview'): {ok, omit[], attribution, disclaimer}`; `selectCompeting(subject, candidates, rules): {listings, why: CriterionMatch[]}` (same area code/postal, ±beds, ±15 % price, active/pending, ranked by distance in features, explainable); `matchReason(prev, next)`; `staleFeed(lastSyncedAt, now)`.

**API.** Admin `PUT /mls-connection` (credential, MLS code, area filter), `GET /mls-connection/status`. `GET /listings/:id/competing`. Existing saved-search preview now includes MLS matches.

**Worker.** `mls.sync` (bulk queue, every 15 min per tenant: `MlsFeed.changes(cursor)` → upsert by `(source, mls_number)` as system → price trigger writes history → enqueue `assistant.match_saved_searches` (existing) → `triggers.detect`); `mls.prune` (daily: rows not seen for 30 d and closed are deleted unless referenced by a match, seller update or evidence).

**UI.** Admin: feed status with last sync time and error, "Display rules not reviewed" banner until the pack has `reviewed_by_counsel_at`. Agent: listing cards carry the attribution line the pack requires.

**Autonomy / opt-outs.** Alerts remain `search_alert` steps through the gate (Phase 1).

**Adapter + fake.** `MlsFeed` gains `fetch(mlsNumber)` and `photos(mlsNumber)`; fake emits deterministic changes including price drops, withdrawals and a no-IDX listing.

**Rules.**
- **R-MLS-1** MLS rows are written only by the system from the tenant's MLS credential, idempotent by `(source, mls_number)`; price changes append `listing_price_history` through the existing trigger. [DB + api]
- **R-MLS-2** A feed record whose `mls_number` matches a team listing only links the number; the team row stays authoritative and a status mismatch is shown to the listing agent. [api]
- **R-MLS-3** Every client-facing rendering of an MLS listing passes `idxDisplayCheck` for its surface, carries the required attribution and disclaimer, and omits disallowed fields; `idx_allowed = false` listings are never shown to clients. **VERIFY WITH COUNSEL / MLS.** [core]
- **R-MLS-4** MLS listings never appear in marketing pieces and are never presented as the team's own. [core + DB CHECK on `marketing_pieces` → team listing]
- **R-MLS-5** Feed freshness is honest: data older than 24 h shows "MLS data as of {time}"; `new_match` and `price_drop` triggers do not fire on listings not seen in the feed for 48 h. [core]

### 3.3 Behavior-aware nurture triggers

**Jobs.** Agent: approve one trigger playbook once ("price drop on a saved home", "new listing in their search", "home anniversary", "rates moved"); after that the assistant sends the routine ones and puts the rest on the feed as one-tap drafts. Phone first.

**Data.** `playbooks.kind` + `trigger`; `playbook_step_runs`: `enrollment_id` nullable, + `contact_id`, `trigger_key text UNIQUE per tenant`, `trigger_ref jsonb` (subject ids + fact version), CHECK `(enrollment_id IS NOT NULL) <> (trigger_key IS NOT NULL)`. `market_rates` (global): `(series, observed_on) PK, rate_bps, source, fetched_at`; SELECT for all, writes by maintenance only. New intents: `price_drop_alert`, `new_match_alert` (both `search_alert`, marketing), `rate_update` (marketing, category `money` ⇒ never autonomous), `milestone_update` (informational, `reminder`, §3.5), `review_request` (§3.8).

**RLS.** Step runs via the contact's detail visibility (as today, extended to `contact_id` for trigger runs); system writes.

**Core** (`core/assistant` extension): `TriggerStepSchema = PlaybookStep minus delay plus trigger: {kind, minDropBps?, years?, offsetDays?, direction?}`; `validatePlaybook` accepts kind `trigger`; `detectFirings(fact, candidates): Firing[]` (pure; signals never fire alone); `coalesce(firings, windowHours): Batch[]`; `recheckFact(firing, current)`.

**API.** Existing playbook routes accept `kind: 'trigger'`. `GET /playbooks/templates` gains a built-in "Behavior alerts" trigger template (ships inactive, approved once).

**Worker.** `triggers.detect` (default queue; fed by `mls.sync`, team price changes, `saved_search_matches` inserts, a daily anniversary scan, `market_rates` inserts, deal-date confirmations). Sending is the existing sweeper playbook-step branch.

**UI.** Feed card "Price dropped on 2 homes Jane saved" (sent, with evidence) or "Draft ready: rates moved" (tap Send/Edit). Playbook editor shows triggers as plain sentences.

**Autonomy.** Within the approved trigger playbook: `price_drop_alert`, `new_match_alert`, `home_anniversary` (nurture_step). Always a tap: `rate_update` (money). Paused conversation ⇒ draft.

**Opt-outs.** Send-time `canContact` as for any step; the guard enforces it again.

**Rules.**
- **R-NURT-1** A trigger playbook (kind `trigger`) follows R-AST-4 (approval, hash freeze, revoke). A firing is a `playbook_step_runs` row with no enrollment and a unique `trigger_key`, so each fact fires a step at most once per contact. [DB + core]
- **R-NURT-2** Triggers fire only from facts: a price decrease ≥ `minDropBps` on a listing the contact saved (`listing_saved`, fact) or matched in an active saved search; a new match; back on market; the anniversary of a closed deal the contact was buyer/seller on (Feb 29 ⇒ Feb 28); a `market_rates` move ≥ threshold; a confirmed deal date coming up. Opens and other signals never fire a trigger alone. [core]
- **R-NURT-3** Firings for one contact within `trigger_coalesce_hours` (default 24; NULL = off) are combined into one message with each item's evidence. Coalescing never drops or defers a firing for compliance reasons; it is not a frequency cap (D1). `milestone_update` is never coalesced. [core]
- **R-NURT-4** At send time the step re-checks its fact (listing still active and still at or below the alerted price, date unchanged); a stale fact makes the run `skipped_ineligible` with a visible reason. [core + api]
- **R-NURT-5** If the conversation is paused (client replied) the firing becomes `converted_to_draft` for the owner; it never sends. [DB guard + api]
- **R-NURT-6** `rate_update` is category `money`: always a draft for approval; templates may not state APR, payment amounts or loan terms (content guard). **VERIFY WITH COUNSEL** (TILA/Reg Z advertising trigger terms, state rules). [DB CHECK + core]
- **R-NURT-7** Trigger sends never count as touches and never change ownership. [core + views]
- **R-NURT-8** Trigger steps fire only for owned contacts, and an agent-scoped trigger playbook fires only for contacts its owner currently owns (re-checked at send time, as for agent playbooks today). [api + DB]

### 3.4 Active seller updates (this is also marketing's "seller report")

**Jobs.** Listing agent, phone first: every week (tenant cadence) a ready-to-send update for each active listing: showings, feedback, marketing done, competing listings, and an empty "Your recommendation" box. The agent types or dictates two sentences and taps Send. Today this is an hour per listing per week.

**Data.** None new. `assistant_actions kind='seller_update_draft'` (DB already forces `seller_update` + `requires_approval`), payload `{periodStart, periodEnd, sections[], recommendation?}`; dedupe `seller_update:{listing}:{periodStart}`. Evidence source types `showing`, `showing_feedback`, `marketing_activity`, `listing` (competing, with IDX attribution).

**RLS.** As `assistant_actions` (owner = listing agent; TL sees team). Client principal: only the sent result, via `portal_entries` in P3.

**Core** (`core/marketing`): `assembleSellerUpdate(i: {listing, period, showings, feedback, activity, competing, pageViews}): {sections, claims}` (deterministic counts; every number is a claim with evidence; zero activity is stated plainly); `renderSellerUpdate(draft, recommendation, identity, channel: 'email'|'sms_short')`.

**API.** `GET /listings/:id/seller-updates`, approve via existing `POST /assistant/actions/:id/approve` with `editedPayload.recommendation` (required) and per-item `exclude[]`.

**Worker.** `seller_updates.assemble` (daily scan; drafts listings whose period ended; the AI only writes the short summary sentence, from claims).

**UI.** Phone approval card: summary at top, sections collapsible, each feedback item with a remove control, recommendation box (dictation-friendly), Send. "No showings this week" is said as is.

**Autonomy.** Never autonomous (existing DB CHECK). The assistant never prefills the recommendation.

**Opt-outs.** Sent to the listing's seller contacts through `dispatchOutbound`, purpose informational (email default; short SMS with a link in P3). Opted-out sellers: blocked with the human sentence; the agent can copy the text.

**Rules.**
- **R-SELL-1** One seller-update draft per active team listing with a seller contact per cadence period (dedupe key); never autonomous. [DB + api]
- **R-SELL-2** Every count and statement in an update is a claim with evidence (showing, feedback, marketing activity, our own page views, competing MLS listings with IDX attribution). An unverifiable item is omitted or `needs_review`; no activity is shown as none, never padded. [core + DB deferred trigger]
- **R-SELL-3** Approving requires a non-empty recommendation written by the human (the assistant may not prefill it); `RECOMMENDATION_REQUIRED` otherwise. [api + core]
- **R-SELL-4** Seller updates are informational messages through `dispatchOutbound`; opt-outs apply with no override. [api]
- **R-SELL-5** Each feedback item is shown verbatim to the agent and can be removed before sending; buyer-agent names are omitted from the client version by default (setting). [core + api]

### 3.5 Transaction milestones

**Jobs.** TC and agent (phone and desktop): enter the acceptance date once and get the whole milestone list proposed; confirm each date with a tap; get a risk flag before a deadline slips; clients and lenders get plain reminders automatically. TL: at-risk deals appear in the existing queue.

**Data.** `deal_dates` + `source` (`manual/template/document`), `confirmed_by_user_id`, `confirmed_at`, `responsible` (`buyer/seller/lender/title/agent/tc/other`); CHECK `source = 'manual' ⇒ confirmed` (a human typed it). `deal_contacts.role` + `lender`, `title`, `attorney`. Milestone plan templates in tenant settings (`milestone_templates jsonb`, Zod in core: per side and jurisdiction, offsets in calendar or business days). `exception_items.item_type` + `milestone_at_risk` (key `milestone:{deal_date}:{due_on}`). Client/lender updates are a built-in team **trigger** playbook `transaction_updates` (trigger `deal_date_upcoming`).

**RLS.** Existing deal visibility (TC edits dates). Exceptions: owner = deal owner; TL sees team.

**Core** (`core/transactions`): `planMilestones(acceptance, template, calendar): ProposedDate[]`; `deriveMilestoneRisks(deal, dates, contacts, tasks, now): RiskSpec[]` (overdue and incomplete; due ≤ 48 h with nobody responsible; appraisal after financing deadline; financed deal with no lender contact; closing before an incomplete contingency; any unconfirmed date ≤ 7 days out); extends `deriveExceptions` input.

**API.** `POST /deals/:id/milestones/plan` (proposes), `POST /deal-dates/:id/confirm`, existing date CRUD.

**Worker.** `exceptions.recompute` (existing) includes milestone risks; `triggers.detect` on confirm and change.

**UI.** Deal page timeline (phone: vertical list with "Confirm" chips on proposed dates; desktop: table). Feed card for the owner/TC on risk.

**Autonomy.** `milestone_update` is informational `reminder` inside the approved `transaction_updates` playbook (team playbook ⇒ Owner/Admin approve; Q2 open). The content guard still downgrades anything mentioning contract terms, money or wires to a draft.

**Opt-outs.** Per recipient through the gate (lender blocked ⇒ `failed_send` exception to the deal owner/TC).

**Rules.**
- **R-TXN-1** Milestones are `deal_dates`. Template-proposed or document-extracted dates are unconfirmed until a deal owner, TC on the deal, TL or Admin confirms them. Templates are tenant data per side and jurisdiction; no state's contract defaults are hard-coded (**VERIFY WITH COUNSEL**). [DB CHECK + core]
- **R-TXN-2** Only confirmed dates drive client/lender updates; an unconfirmed date inside 7 days is itself a risk. [core]
- **R-TXN-3** Risks come only from `deriveMilestoneRisks` (pure, deterministic, evidence-bearing) and surface as `milestone_at_risk` exceptions with per-occurrence keys, plus a feed card; queue semantics are R-ACC-1/3. [core + job]
- **R-TXN-4** Client/lender updates are `deal_date_upcoming` trigger steps in an approved playbook, informational, sent only to deal contacts whose role the step names. [core + api]
- **R-TXN-5** Changing a confirmed date cancels pending firings keyed to the old date and creates new ones (`trigger_key` includes `due_on`); the recipient gets one update for the new date. [core + api]

### 3.6 Post-closing monthly home value updates (AVM)

**Jobs.** Agent: past clients get a monthly "your home's estimated value" note without the agent doing anything after approving the post-closing playbook once.

**Data.** `home_valuations` (exists) + dedupe index `(tenant_id, contact_address_id, date_trunc('month', valued_at))`. `tenant_settings.avm_max_range_bps`. Evidence source `home_valuation`.

**Core.** `avmSendable(estimate, prior, settings): {ok} | {ok:false; reason:'UNAVAILABLE'|'RANGE_TOO_WIDE'|'JUMP_TOO_LARGE'}`; renderer always prints provider, range and "an estimate, not an appraisal".

**Worker.** `avm.refresh` (monthly per address with a live `home_value_update` step; result feeds the existing step).

**Autonomy.** Existing intent `home_value_update` (nurture, marketing) runs autonomously inside the approved post-closing playbook when `avmSendable`; otherwise the run becomes a draft or is skipped with the reason shown.

**Rules.**
- **R-AVM-1** At most one estimate per address per month; every display shows the provider, the range, the as-of date and "estimate, not an appraisal". **VERIFY WITH COUNSEL** (state rules on valuations by non-appraisers). [DB + core]
- **R-AVM-2** A home-value step sends only when the estimate is available, its range width ≤ `avm_max_range_bps` and its change from the prior estimate ≤ the jump threshold; otherwise it becomes a draft (`converted_to_draft`) or `skipped_ineligible` with the reason. [core]
- **R-AVM-3** The `avm` capability is available only while an AVM credential is active (existing `requires`). [core + api]

### 3.7 Marketing built in

**Jobs.** Listing agent, phone first for approvals and desktop for edits: enter a listing once and get a website page, social post copy and images, an open-house invite, a flyer and a Marketplace-ready export. Approve each piece once. Brokerage name on all of it.

**Data.**
```
marketing_pieces (tenant_id, id) PK
  listing_id        → listings (team listings only: trigger checks source = 'team')
  kind              CHECK IN ('website_page','social_post','open_house_invite','flyer','marketplace_export')   -- P3: 'gbp_post'
  version_no        int, UNIQUE (tenant_id, listing_id, kind, version_no)
  status            CHECK IN ('draft','approved','published','exported','retracted','superseded')
  prose             jsonb NOT NULL       -- headline, body, captions (Zod per kind); the only approved text
  bound_fields      text[] NOT NULL      -- price, status, beds, baths, sqft, address, open_house_at, photos
  content_sha256    bytea NOT NULL       -- over prose + template key + bound_fields list
  template_key      text NOT NULL
  identity_check    jsonb NOT NULL       -- brokerage name present, pack rule results
  fair_housing      jsonb NOT NULL       -- lexicon hits and how each was handled
  assistant_action_id → assistant_actions  (kind 'marketing_draft': claims citing listing fields)
  asset_object_ids  uuid[]               -- rendered flyer PDF, social images (stored_objects purpose 'marketing_asset')
  public_slug       text                 -- website_page only; globally unique
  open_house        jsonb                -- open_house_invite: starts/ends, audience rule
  approved_by_user_id, approved_at, published_at, exported_at, retracted_at, created_by_user_id
  CHECK status ∈ (approved, published, exported) ⇒ approved_by AND (identity_check->>'brokerage_name_rendered')::boolean
  trigger: born draft; prose/hash frozen after draft (like playbook_versions); approval by a human as themselves
```
- `marketing_activity` gets a row when a piece is published or exported (seller updates read it).
- Our own page views are counted per piece (aggregate counter in `marketing_activity.metrics`, a fact for our page only).

**RLS.** Read: members (like listings). Write/approve: `listing_writable` (listing agent, TL, Admin). Public: only through `app.resolve_public_page`. Client principal: none.

**Core** (`core/marketing`): `PieceSchemas` per kind; `draftClaims(listing)` (each fact a claim with a `field` locator); `renderPiece(piece, listingFacts, identity, packs)` (deterministic, live facts); `identityCheck(rendered, identity, packs)` (brokerage legal name present; pack placement rules as data, e.g. relative prominence of team name; **VERIFY WITH COUNSEL**); `fairHousingAdGuard(prose, pack): {blocked[], caution[]}` (pack lexicon; **VERIFY WITH COUNSEL**, HUD advertising guidance); `exportBundle(piece)` (text + image list for copy/download); `publicSnapshot(piece, facts)`.

**API** (`apps/api/src/marketing/**`): `POST /listings/:id/marketing/generate` (drafts all kinds), `GET /listings/:id/marketing`, `PATCH /marketing-pieces/:id` (draft only), `POST /marketing-pieces/:id/{approve,publish,export,retract}`, `POST /marketing-pieces/:id/invite/send` `{recipientContactIds}` (open house), public `GET /p/:slug` (+ `/p/:slug/assets/:n`).

**Worker.** `marketing.render` (flyer PDF and images via `DocumentRenderer` adapter), `marketing.facts_changed` (listing update ⇒ re-render assets; status sold/withdrawn ⇒ retract invites and mark the page), `marketing.invite_send` (one message per recipient through `dispatchOutbound`).

**UI.** Listing page → "Marketing" tab: one card per piece with a preview, Approve (1 tap), Copy text, Download images/PDF, "Open page". Phone: approval cards in the existing Approvals inbox (`marketing_review`). Honest labels: "Exported. Post it on Facebook yourself; we can't see whether it went up."

**Autonomy.** The agent approves each piece version once. Fact changes (price, status, open-house time) re-render without re-approval because they come from the team's own listing record; prose changes need a new version and a tap. Open-house invites are sent only when the agent taps Send for the chosen audience.

**Opt-outs.** Invites are marketing emails through the gate (brokerage name, postal address, unsubscribe). SMS invites are cut (bulk SMS was cut in Phase 1; this keeps it cut). Public pages and exports reach no individual.

**Rules.**
- **R-MKT-1** A piece version is born a draft, frozen once it leaves draft, and approved by a human acting as themselves; approval binds `content_sha256`. [DB trigger]
- **R-MKT-2** Bound fact fields (price, status, beds, baths, sqft, address, open-house time, chosen photos) always render live from the team listing and never need re-approval; any prose change is a new version. [core + api]
- **R-MKT-3** No piece is approved, published or exported unless the brokerage legal name is rendered and every jurisdiction-pack advertising rule passes (data; **VERIFY WITH COUNSEL**). [DB CHECK + core]
- **R-MKT-4** The fair-housing ad guard runs on every prose change: a blocked term prevents approval until edited; a caution term shows a warning the approver must acknowledge. The lexicon is pack data (**VERIFY WITH COUNSEL**). [core + api]
- **R-MKT-5** Only team listings (`source = 'team'`) get pieces. [DB trigger]
- **R-MKT-6** `exported` means "handed to the agent"; the product never says a post went live on a platform it cannot verify. Marketplace is export-only. [web copy lint + api]
- **R-MKT-7** A public page is served only through `app.resolve_public_page(slug)` and returns only the approved prose, the bound facts and the identity block; it holds no contact data; a retracted page, or one whose listing was withdrawn, returns 410. [DB definer + api]
- **R-MKT-8** An open-house invite goes by email to recipients the agent picks (suggested: contacts with an active saved search matching the listing); each recipient is a separate gated message; the result shows "Sent 41 of 45; 4 opted out". [api]
- **R-MKT-9** When a listing goes sold, withdrawn or expired, unsent invites are canceled, the page shows the status, and exported pieces are listed "may be out of date". [api]
- **R-MKT-10** Review requests (§3.8) follow the same identity rule.

### 3.8 Review requests automation

**Jobs.** Agent: every closed client is asked for a review at the right time without the agent remembering.

**Data/Core.** New intent `review_request` (marketing, `nurture_step`, slot `review_link` from `tenant_settings.review_link_url`) added to the built-in `post_closing` template. Content guard: no incentive language.

**Rules.**
- **R-MKT-11** Review requests go to every client the post-closing playbook covers; they are never filtered by sentiment, feedback or outcome ("review gating"), and templates offer no incentive. **VERIFY WITH COUNSEL** (FTC rules on consumer reviews, platform policies). [core]

### 3.9 Owner view

**Jobs.** Owner (desktop first, readable on a phone): which sources make money, what each closing costs, how fast deals move, what the next 90 days probably look like.

**Data.**
```
lead_source_costs (tenant_id, id) PK
  lead_source_id → lead_sources, month date CHECK (extract(day from month) = 1), amount_cents bigint ≥ 0,
  origin CHECK IN ('manual','ads_sync'), note, entered_by_user_id, updated_at
  UNIQUE (tenant_id, lead_source_id, month, origin)
```
Views (security_invoker): `v_owner_source_dollars`, `v_owner_velocity`. Forecast is computed in core from rows the Owner can see.

**RLS.** `lead_source_costs`: Owner/Admin read/write, system writes `ads_sync`. Views inherit `deal_financials` RLS (human Owner/Admin/owner/TL). Owner view routes are Owner/Admin only.

**Core** (`core/insights`): `sourceDollars(deals, financials, costs, period)`, `costPerClosing`, `velocity(stageHistory)`, `forecast(openDeals, historicalTransitions, minSample=10): {low, high, method} | {insufficient: true}`.

**API.** `GET /owner/sources?from&to`, `GET /owner/velocity`, `GET /owner/forecast`, `PUT /lead-source-costs`.

**UI.** Desktop: one table (source · leads · appointments · closings · commission · cost · cost per closing), velocity strip, forecast range with the method in one sentence. Phone: the same table as cards.

**Rules.**
- **R-OWNER-1** Owner view is Owner/Admin only and every number shows its denominator; deals excluded (no commission entered, no source) are counted and listed ("3 closings have no commission yet"). [api + web]
- **R-OWNER-2** Dollars by source sum `deal_financials.gross_commission_cents` (team share shown separately) of deals closed in the period, by the deal's immutable `lead_source_id`; cost per closing is cost ÷ closings and "— (0 closings)" when there are none. [core + view]
- **R-OWNER-3** Velocity is median stage dwell from `deal_stage_history` with sample sizes. Forecast is Σ (open deal expected commission × trailing-365-day stage→close rate) shown as a low/high range with its method; fewer than 10 historical transitions for a stage ⇒ "not enough history". No model, no confidence. [core]
- **R-OWNER-4** Cost edits are Owner/Admin, audited (redacted diff). [api]

### 3.10 Goals and AI weekly plans for agents

**Jobs.** Agent (phone): Monday morning, one card: "Your week: 3 things", each with a reason and a link; Accept turns it into tasks. TL: sets or reviews team goals (desktop).

**Data.** `agent_goals` (exists). `assistant_actions kind='weekly_plan'`, contact-less, owner = agent, payload `{weekStart, items[{kind, ref, why}]}`; evidence source `metric` (locator `{kind:'field', name:'appointments_set_week'}`), `deal`, `task`, `appointment`.

**Core** (`core/insights`): `goalPace(goal, scoreboard)`; `planWeek(i: {goals, pace, slowDeals, openPromises, apptsWithoutOutcome, tasks}): PlanItem[]` (deterministic, 3–5 items, ranked by deadline and gap). The model only phrases items (optional, `ai_enabled`).

**Worker.** `insights.weekly_plan` (Monday 06:00 agent's tenant zone).

**Rules.**
- **R-PLAN-1** Goal pace uses the 0012 scoreboard definers, so periods and touches on leads that moved on still count. [api]
- **R-PLAN-2** A weekly plan is 3–5 items chosen by `planWeek` (pure); every item has evidence; accepting creates tasks; nothing is created without the agent's tap. [core + api]
- **R-PLAN-3** Items whose source the agent can no longer see are dropped at render (R-AST-7 analogue). [api]

### 3.11 Calendar sync

**Jobs.** Agent: appointments made in the app appear on their phone's calendar; the app knows when they are busy when suggesting times.

**Data.**
```
user_integrations (tenant_id, id) PK
  user_id → memberships, provider CHECK IN ('google_calendar','microsoft_calendar'),
  secret_enc bytea, key_version, scopes text[], external_calendar_id, status CHECK IN ('active','error','revoked'),
  last_synced_at, last_error, revoked_at;  UNIQUE (tenant_id, user_id, provider)
```
`appointments` + `external_provider`, `external_event_ref`, `external_etag`, `external_detached_at`.

**RLS.** `user_integrations`: self and system only (Owner/Admin see nothing; connection counts come from an aggregate definer if needed).

**Core.** `calendarEventFromAppointment(appt, detail)` (title PII-minimized per setting), `busyBlocksOverlap`.

**API/Worker.** `GET /me/integrations`, OAuth `POST /me/integrations/:provider/connect|callback`, `DELETE`. `calendar.push` on appointment create/update/cancel; `GET /me/busy?from&to` (live, never stored).

**Rules.**
- **R-CAL-1** Calendar tokens are field-encrypted, self-only, with the minimal scopes (write to one calendar, read free/busy). [DB + api]
- **R-CAL-2** Sync is one-way (app → calendar). If the external event changed since our last write (etag), we stop syncing that event (`external_detached_at`) and say so; we never overwrite the agent's edit. [api]
- **R-CAL-3** Busy blocks are read per request and never stored. [api]
- **R-CAL-4** Revocation or disconnect stops sync; in-app appointments are unaffected. [api]

### 3.12 Call scoring and one specific fix a day (Phase 2 start)

**Jobs.** Agent (phone): one card a day, "Today's fix: ask about timeline before price. Missed in 4 of your last 6 calls," with two links that open the calls at the right second. No leaderboard.

**Data.**
```
call_scores (tenant_id, call_id) PK → calls
  agent_user_id → memberships, contact_id → contacts, rubric_version text,
  items jsonb NOT NULL   -- [{key, status: met|missed|not_applicable|not_scored, claim_id?}]
  met_count int, scored_count int CHECK (met_count <= scored_count),
  assistant_action_id → assistant_actions (kind 'call_review'; claims carry transcript evidence), created_at
```

**RLS.** SELECT: contact detail visible **and** the RESTRICTIVE recording scope (the same predicate as `recordings`), so exactly the people who may hear the call may see its review. Write: system.

**Core** (`core/coaching`): `RUBRIC_V1` (platform-versioned items such as "asked timeline", "asked financing", "set next step", "summarized back"), tenant can disable items; `scoreFromClaims(claims, rubric): CallScore` (an item without a verified quote is `not_scored`); `dailyFix(scores, now): Fix | null` (min 3 scored calls in 14 days).

**Worker.** `coaching.review_call` (after a transcript is ready; skips calls R-COACH-1 excludes), `coaching.daily_fix` (06:00 agent zone ⇒ feed item `coaching_fix`).

**Rules.**
- **R-COACH-1** Only calls with a transcript and a recording basis of `announced_all_parties` or `one_party_policy` are reviewed; imported recordings never are unless the agent asks for one. [api]
- **R-COACH-2** Each rubric item is met, missed, not applicable or not scored, with transcript evidence for met/missed; an item without a verified quote is not scored and is excluded from the denominator; the UI shows "6 of 8 checks", never a bare percentage. [core + DB deferred trigger]
- **R-COACH-3** A call review is visible to exactly those who may play the recording (recording-scope RLS). **VERIFY WITH COUNSEL** (employee-monitoring rules). [DB RESTRICTIVE]
- **R-COACH-4** The daily fix is one rubric item per agent per day, the one missed most often in the last 10 scored calls (minimum 3), ties broken by rubric order, with up to two evidence links; no data ⇒ no card. [core]
- **R-COACH-5** Call scores never feed routing, ownership, prediction or any automatic consequence. [core types]

### 3.13 Expanded admin: merged into each module

There is no separate admin module. Each feature module owns its admin endpoints (connections, MLS feed, AVM provider, brand kit, milestone templates, review link, rubric toggles, seller-update cadence, coaching visibility) and the `web/admin-p2` module adds their screens to the existing Admin surface. This removes a cross-cutting module that would otherwise block on every other one.

---

## 4. Phase 3 capabilities

### 4.1 Voice AI answering missed and after-hours inbound calls

**Jobs.** Agent: a missed call at 9 PM is answered, qualified, booked or warm-transferred, and arrives as a handback with a summary and quotes. Hot leads ring the on-duty person live. Owner/Admin approve the voice playbook once (desktop).

**Data.** `calls.handled_by` + `assistant`; `calls.ai_disclosed_at`, `calls.voice_playbook_version_id`, `calls.transferred_to_user_id`, `calls.transfer_outcome` (`connected/no_answer/declined`). CHECKs: `handled_by = 'assistant' ⇒ direction = 'inbound' AND voice_playbook_version_id IS NOT NULL AND (answered_at IS NULL OR ai_disclosed_at IS NOT NULL)`; `direction = 'outbound' ⇒ initiator = 'human'` is **kept** (no AI-originated calls). `playbooks.kind` + `voice_answering` (team scope; steps = greeting/disclosure from pack, qualifying questions, booking rules, transfer rule, message-taking). Voice settings in `tenant_settings`: `voice_answer_after_seconds` (20), `voice_answer_when` (`missed_and_after_hours` | `after_hours_only`), `voice_languages`.

**RLS.** Unchanged call/recording rules.

**Core** (`core/voice`): `VoicePlaybookSchema`; `shouldAnswer(call, settings, routingHours, now)`; `turnPolicy(intentOfUtterance): 'answer'|'decline_topic'|'transfer'|'take_message'` (money, offers, contract, commission, legal, lending advice ⇒ decline politely and take a message); `isHot(answers, rule)` (deterministic: e.g. timeline ≤ 90 days or asks to see a home this week); `pickTransferTarget(owner, onDuty, accepting)`; `bookSlot(busy, rules, now)`.

**API/Worker.** Telephony webhook branch: inbound call → ring humans (Phase 1) → `shouldAnswer` → hand media to `VoiceAgentProvider` with the approved playbook; transfer leg via `dialOutbound` (`dialAgent` user leg, not a contact communication); on hang-up: transcript → `call_summary` + claims → handback (existing ingestion pause semantics) → booked appointment (`created_by_kind='assistant'`) + confirmation SMS via `dispatchOutbound` (booking_confirmation).

**UI.** Phone: handback card "The assistant answered Jane at 9:12 PM · booked Thu 4 PM · quotes". Admin desktop: voice playbook editor with the fixed disclosure line and a test call against the fake.

**Autonomy.** Inside the approved `voice_answering` playbook only; booking falls under `booking_confirmation`; everything else is a message for the human.

**Opt-outs.** Answering an inbound call is not a contact attempt. A caller whose number revoked voice is still answered; the assistant never schedules a callback by the assistant itself; follow-up SMS is gated. "Don't call me again" on the call writes a voice revoke (`inbound_language`, call evidence, `needs_review`) and per R-INBOX-5 a person-level do-not-contact if phrased as such.

**Adapter + fake.** `VoiceAgentProvider` (`startSession`, `endSession`, transcript stream) with a scripted fake; telephony gains media-stream support (fake).

**Rules.**
- **R-VOICE-1** (replaces R-GATE-9, which is marked **Retired**) The assistant may handle inbound calls only, under an approved `voice_answering` playbook version; AI-originated outbound calls stay impossible (DB CHECK). [DB]
- **R-VOICE-2** Before anything else the assistant says it is the agent's (or team's) automated assistant, using pack wording (**VERIFY WITH COUNSEL**: state AI-disclosure laws; FCC treats AI voices as artificial under the TCPA for outbound calls); `ai_disclosed_at` is required once answered; no setting disables it; asked "are you a person?", it answers truthfully. [DB CHECK + core]
- **R-VOICE-3** It answers only after the ring-through fails (`voice_answer_after_seconds`) or outside routing hours, per the tenant setting. [core]
- **R-VOICE-4** Scope is qualify, book, take a message, warm-transfer. Price, offers, contracts, commission, legal or lending advice are declined and passed to the human; no first-person human claims. [core + content guard]
- **R-VOICE-5** AI-handled calls always announce recording/processing before it starts, whatever the one-party setting; a caller who declines goes to voicemail. **VERIFY WITH COUNSEL** (all-party states; whether real-time processing is "recording"). [core + DB]
- **R-VOICE-6** Warm transfer only for callers `isHot` marks, to the contact owner if accepting and reachable, else the on-duty Team Lead; the target hears a short whisper summary first; a transfer never changes ownership (an unknown caller goes through intake routing as today). [core + api]
- **R-VOICE-7** Every AI call ends in a `call_summary` with transcript evidence and a handback to the owner (or TL); unverifiable details are needs-review and never become appointment times. [api + DB]
- **R-VOICE-8** Vendor failure or latency beyond the pack threshold falls back to voicemail; the caller is never left in silence. [api]

### 4.2 90-day transaction prediction

**Jobs.** Agent (phone): a few "worth a call this week" cards about their own sphere and past clients, each with plain reasons. Owner: an honest back-test.

**Data.**
```
property_records (tenant_id, id) PK
  contact_address_id → contact_addresses, provider, purchase_date, purchase_price_cents, est_loan_balance_cents,
  owner_occupied boolean, owner_name_match boolean, fetched_at, provider_ref, retention_until
contact_predictions (tenant_id, contact_id) PK → contacts
  model_version, band CHECK IN ('likely_90d','watch','none'), reasons jsonb (≥ 1 when band <> 'none'; evidence refs),
  computed_at
```

**RLS.** Both: contact detail visible. System writes. Client principal: none.

**Core** (`core/prediction`): `PredictionFeatures` type with **no** field for protected-proxy attributes, names, demographics, household composition, geography or life events (compile-time); `score(features, model): {band, reasons}` (additive, versioned weights; no probability shown); `backtest(predictions, deals): {flagged, transacted}`.

**Worker.** `prediction.refresh` (weekly, bulk), `records.refresh` (quarterly per address).

**Rules.**
- **R-PRED-1** Features come only from a counsel-reviewed allowlist (pack data, minimal default: time in home, estimated equity, the contact's own behavior with us, prior inquiries). Protected classes and proxies (incl. military status, source of income, familial and marital status, age, disability, and geography) are excluded by type; life-event data is excluded by default. **VERIFY WITH COUNSEL** (fair housing, state lists). [core types + test]
- **R-PRED-2** Output is a band plus reasons with evidence; no probability or confidence appears in any agent-facing schema. [core + R-AST-13 snapshot]
- **R-PRED-3** Predictions only create feed cards for humans; they never trigger messages, routing, ownership, pricing, ad targeting or any automated decision about a person. [core + api]
- **R-PRED-4** The back-test is shown with its denominator ("of 40 flagged 90+ days ago, 6 transacted"). [core + web]
- **R-PRED-5** A public record attaches only on exact normalized address match plus owner-name match; otherwise needs review; vendor data keeps to its license retention. [core + api]

### 4.3 Ad spend that shifts itself toward what closes

**Jobs.** Owner (desktop): set a monthly cap once; every week see "Move $300 from Campaign A to Campaign B: B produced 4 agreements, A 0, from similar spend" and apply it with one tap.

**Data.**
```
ad_campaigns (tenant_id, id) PK
  connection_id → channel_connections (kind meta_ads|google_ads), external_campaign_id, name,
  lead_source_id → lead_sources, campaign_ref text (matches lead_inquiries.campaign_ref), status, daily_budget_cents
ad_budget_versions [AO] (tenant_id, id) PK
  monthly_cap_cents, effective_from, approved_by_user_id (Owner), attestation, created_at
```
Reallocations are `assistant_actions kind='ad_reallocation'` (category `money`, `requires_approval`), payload = per-campaign new daily budgets, with claims citing attributed agreements and spend. Spend syncs daily into `lead_source_costs` (`origin ads_sync`).

**RLS.** Owner/Admin only; system writes sync rows.

**Core** (`core/ads`): `proposeReallocation(campaigns, spend, outcomes, cap, rules): Proposal | {hold: reason}` (moves budget only, Σ ≤ cap; minimum sample ≥ 5 agreements per campaign in 90 d else hold; uses agreements as the leading signal and closings when present).

**Rules.**
- **R-ADS-1** The monthly cap is an append-only version approved by the Owner with re-auth and attestation; no proposal or applied change can exceed it. [DB + core + api]
- **R-ADS-2** Every budget change is a `money` assistant action that needs the Owner's tap (the Phase 1 autonomy rule). Auto-applying shifts within the cap is **not built**; it would be a new owner decision (D-ADS, §9). [DB CHECK + api]
- **R-ADS-3** Proposals rely on attributed agreements/closings through `campaign_ref`/`ad_ref`; below the minimum sample the proposal is "hold", with the counts shown. [core]
- **R-ADS-4** Housing ads use each platform's housing special ad category and its targeting limits; no customer-list uploads or lookalike audiences (cut). **VERIFY WITH COUNSEL.** [api + adapter]
- **R-ADS-5** The UI states that platforms may spend somewhat over a daily budget on a given day. [web copy]

### 4.4 Client portal

**Jobs.** Buyer/seller (phone first): timeline, documents, showings, feedback, next steps for their deal or listing. Agent: one tap "Invite Jane to her portal"; fewer "what's next?" texts.

**Data.**
```
client_accounts (tenant_id, id) PK: contact_id → contacts, email citext, status, created_at   UNIQUE (tenant_id, email)
client_sessions: token_hash UQ, client_account_id, tenant_id, idle/absolute expiry, revoked_at
client_grants (tenant_id, id) PK: client_account_id, deal_id XOR listing_id, granted_by_user_id, granted_at, revoked_at
portal_entries (tenant_id, id) PK: grant_id, kind CHECK IN ('milestone','document','showing','feedback','seller_update',
  'next_step','request'), title, body, due_on, object_id, source_type/source_id, published_at, retracted_at
documents (shared with 4.5)
```
`tasks.client_visible boolean` (next steps). GUCs: `app.principal_type = 'client'`, `app.client_account_id`. Definers: `auth.resolve_client_session`, `auth.issue_client_magic_link`, `app.my_client_grant_ids()`.

**RLS.** Staff tables: unchanged (staff only). Portal tables: Layer 1 allows staff or client; Layer 2 for clients: own account row, own grants (not revoked), entries of those grants (not retracted). Staff: grant/revoke by the deal owner, listing agent, TL, Admin.

**Core** (`core/portal`): `publishEntries(grantScope, sources): EntrySpec[]` (only client-visible kinds; confirmed dates only; shared items only); `entryDiff(prev, next)`.

**Worker.** `portal.sync` on relevant writes + nightly republish per active grant.

**UI.** `apps/web` second shell at `/portal` (same design system, client session, no staff navigation). "Message {Agent}" opens the phone's SMS/email app (deep link); no new channel.

**Rules.**
- **R-PORTAL-1** A client session sets `principal_type = 'client'` and `app.client_account_id` from the client session only; every staff table returns zero rows to a client context (generated test over all pre-0016 tables). [DB, smoke]
- **R-PORTAL-2** A client reads only entries (and documents through entries) of their own unrevoked grants; a grant is per deal or per listing and is created only by staff who can write that deal/listing. [DB]
- **R-PORTAL-3** Entries are published only from client-visible sources: confirmed milestones, documents shared to the portal, showings (date/status) for sellers, feedback the agent shared, sent seller updates, tasks marked client-visible; internal notes, commission, messages and other contacts never. [core + api]
- **R-PORTAL-4** Clients sign in with a single-use magic link (hashed, 15 min) and get a separate `__Host-csid` session (7 d idle / 30 d absolute); rate-limited; no password. [api + DB]
- **R-PORTAL-5** The portal invite is an informational message through `dispatchOutbound` (opt-outs apply); magic-link emails the client requests are account emails. [api]
- **R-PORTAL-6** Revoking a grant hides everything on the next request; document views are audited. [DB + api]
- **R-PORTAL-7** A client may upload only into an open document request; uploads are quarantined until a malware scan passes. [api + DB]

### 4.5 Deeper documents

**Data.** `documents (tenant_id, id)`: scope (`deal_id`/`listing_id`/`contact_id`, one), `object_id → stored_objects (purpose 'document')`, kind, version_no, `shared_to_portal`, `uploaded_by_kind (staff/client)`, `scan_status (pending/clean/infected)`. Contract extraction = `assistant_actions kind='contract_extraction'` (category `contract`) with claims citing page + character range; its dates become `deal_dates (source='document')`, unconfirmed.

**Rules.**
- **R-DOC-1** Document visibility = its scope's visibility; `shared_to_portal` is an explicit staff tap. [DB]
- **R-DOC-2** Extracted contract dates are proposals with page evidence; they drive nothing until confirmed (R-TXN-1); extraction is never autonomous. [core + DB]
- **R-DOC-3** No download before `scan_status = 'clean'`. [api + DB CHECK]
- E-signature is not built (link out).

### 4.6 Google Business Profile tools

**Data.** `channel_connections kind='gbp'`; `marketing_pieces kind='gbp_post'`; `assistant_actions kind='review_reply_draft'` (category `novel_message`).

**Rules.**
- **R-GBP-1** GBP posts follow R-MKT-1…6; publishing uses the API only when access is granted, otherwise export. [api]
- **R-GBP-2** Review replies are drafted on request or on a new review and always need a tap; the guard strips client names and transaction details; nothing auto-replies. [core + DB CHECK]

### 4.7 Advanced coaching reporting

A view, not a feature module: `v_coaching_weekly` (security_invoker over `call_scores`) and a TL desktop page.

- **R-COACH-6** Improving/slipping compares each rubric item's met rate over the last 4 weeks against the prior 4, only with ≥ 5 scored calls in each window, else "not enough calls"; shown per agent to the agent and to whoever has recording scope; no ranking across agents. [core + view]

---

## 5. Autonomy and opt-out summary (one table)

| Output | Autonomous inside an approved rule? | Always a tap | Opt-out checked |
|---|---|---|---|
| 60-s first response on DM/chat | yes (`new_lead_response`) | | send time + guard |
| Trigger: price drop, new match, anniversary | yes (trigger playbook) | | send time + guard |
| Trigger: rate move | | **yes** (money) | send time + guard |
| Milestone update to client/lender | yes (`transaction_updates`); contract/money wording ⇒ draft | | send time + guard |
| Home value update | yes if `avmSendable`, else draft | | send time + guard |
| Review request | yes (post-closing) | | send time + guard |
| Seller update | never | **yes** + recommendation | send time + guard |
| Marketing piece | | **yes**, once per version | invites: per recipient |
| Weekly plan, daily fix, prediction card | internal (no client message) | accept ⇒ tasks | n/a |
| Voice answering | yes (voice playbook), inbound only | | follow-up SMS gated |
| Ad reallocation | never | **yes** (money) | n/a |
| Review reply (GBP) | never | **yes** | n/a |
| Contract extraction | never | **yes** (confirm dates) | n/a |

---

## 6. Edge cases (continuing after E70)

| # | Case | Handling | Rules |
|---|---|---|---|
| E71 | Facebook DM from someone unknown | Intake creates "Unknown (Messenger)" with the connection's lead source, routes it, and the 60-s reply goes out in Messenger | R-INBOX-10, R-INBOX-7 |
| E72 | Agent replies to a Messenger lead 25 h after their last message | `CHANNEL_WINDOW_CLOSED`; compose offers the contact's SMS/email if any | R-INBOX-6 |
| E73 | Lead texted STOP last week, now writes on Instagram | SMS stays revoked; Instagram is a separate channel and the person wrote first, so a human can answer on Instagram; automation is paused by the inbound anyway | R-INBOX-4 |
| E74 | "Please stop contacting me" arrives on Messenger | Every channel on every point of the contact is revoked (needs_review); queued SMS/email canceled; handback says what happened | R-INBOX-5 |
| E75 | Messenger profile name matches an existing contact | Never merged automatically; suggestion card; merge through R-OWN-24 | R-INBOX-10 |
| E76 | Same person messages two of the tenant's Facebook Pages | Two points (page-scoped ids) on one contact after merge; STOP on one revokes both Messenger points | R-INBOX-4 |
| E77 | Chat visitor closes the tab mid-conversation | Session ends after 30 min idle; replies go by SMS/email if given; chat send denied `CHANNEL_SESSION_ENDED` | R-INBOX-8 |
| E78 | Zillow changes its lead email template | Parser finds no phone/email ⇒ Admin review card with the encrypted raw email; nothing routed silently; if a phone or email is found, intake proceeds | R-INBOX-9 |
| E79 | Same lead arrives by email parse and partner API | Dedup by `(source, external_id)` or 10-minute fingerprint | R-OWN-25, R-INBOX-9 |
| E80 | DM inserted before the guard knows the channel | Cannot happen: the channel CHECK and guard change in one migration; a test shows the guard refuses a DM to a revoked address and raises on an unmapped channel | R-INBOX-3 |
| E81 | MLS feed contains the team's own listing | Linked by `mls_number`; team row authoritative; status mismatch shown | R-MLS-2 |
| E82 | MLS listing withdrawn while its alert is scheduled | Send-time re-check ⇒ `skipped_ineligible` | R-NURT-4 |
| E83 | Price drops, then rises, inside the coalescing window | The message reflects the current price; no net drop ⇒ skipped | R-NURT-3, R-NURT-4 |
| E84 | Five saved homes drop price the same day | One coalesced message listing five homes | R-NURT-3 |
| E85 | MLS feed down for three days | Admin shows "Last synced 3 days ago"; seller updates say "MLS data as of …"; new-match triggers stop for unseen listings | R-MLS-5 |
| E86 | Seller opted out of IDX display | Never shown to clients (alerts, updates, previews) | R-MLS-3 |
| E87 | A week with zero showings | The update says "No showings this week"; the agent may skip it | R-SELL-2 |
| E88 | Agent taps Send without a recommendation | `RECOMMENDATION_REQUIRED` | R-SELL-3 |
| E89 | Buyer-agent feedback is rude or personal | Shown verbatim to the agent with a remove control | R-SELL-5 |
| E90 | Price changes after the website page was approved | The page shows the new price immediately (bound fact); no re-approval; prose stays as approved | R-MKT-2 |
| E91 | Listing withdrawn with invites queued | Unsent invites canceled; page 410/"No longer available"; exports flagged | R-MKT-9 |
| E92 | Pack requires the brokerage name at least as prominent as the team name and the flyer fails | Cannot approve; the reason is shown | R-MKT-3 |
| E93 | Draft says "perfect for young families" | Blocked term ⇒ must edit before approval | R-MKT-4 |
| E94 | An invitee unsubscribes between approval and send | That recipient is blocked; result "Sent 41 of 45; 4 opted out" | R-MKT-8 |
| E95 | Template places the inspection deadline on a holiday | Proposed date shown with the rule used; never silently moved; human confirms | R-TXN-1 |
| E96 | Closing date moved by amendment | Old firings canceled; one update with the new date | R-TXN-5 |
| E97 | Lender's email is unsubscribed | Lender update blocked; `failed_send` to the deal owner/TC | R-TXN-4, R-GATE-1 |
| E98 | AVM value 30 % below last month | Jump check ⇒ draft for the agent | R-AVM-2 |
| E99 | AVM has no value for a condo | `skipped_ineligible` with "No estimate available" | R-AVM-2 |
| E100 | Rates move 30 bps | Drafts per contact for approval; never autonomous | R-NURT-6 |
| E101 | Home anniversary on Feb 29 | Fires Feb 28 in non-leap years | R-NURT-2 |
| E102 | Agent revokes the calendar app in Google | Status `revoked`; in-app appointments unaffected; reconnect card | R-CAL-4 |
| E103 | Agent edits the synced event in Google | Detached; never overwritten; "Edited in Google; times may differ" | R-CAL-2 |
| E104 | Imported FUB recording | Not reviewed | R-COACH-1 |
| E105 | A rubric quote fails verification | Item not scored; excluded from the denominator | R-COACH-2 |
| E106 | Agent has two scored calls in 14 days | No daily fix ("Not enough calls yet") | R-COACH-4 |
| E107 | Closed deal without commission | Excluded from dollars, listed in the "missing commission" line | R-OWNER-1 |
| E108 | A source with cost and zero closings | "— (0 closings)" | R-OWNER-2 |
| E109 | Fewer than 10 transitions for a stage | Forecast shows "not enough history" | R-OWNER-3 |
| E110 | Agent has no goals | Plan built from pipeline only, and says so | R-PLAN-2 |
| E111 | Plan cites a deal reassigned since | Item dropped at render | R-PLAN-3 |
| E112 | After-hours call from a number that asked not to be called | Answered (inbound); no assistant callback; SMS confirmation gated | R-VOICE-3, R-GATE-1 |
| E113 | Caller asks "Am I talking to a real person?" | Truthful answer | R-VOICE-2 |
| E114 | Caller asks what the seller would take | Declined politely; message taken; money handback | R-VOICE-4 |
| E115 | Warm-transfer target does not answer in 20 s | Back to the caller; message taken; critical handback | R-VOICE-6 |
| E116 | Caller in an all-party recording state | Announcement before recording; decline ⇒ voicemail | R-VOICE-5 |
| E117 | Voice vendor outage | Voicemail fallback | R-VOICE-8 |
| E118 | Two calls at once from the same unknown number | Address lock ⇒ one contact | R-OWN-25 |
| E119 | Caller speaks a language the playbook does not cover | Takes a short message or goes to voicemail; says so | R-VOICE-4 |
| E120 | Contact has a self-reported PCS timeline | Not representable in `PredictionFeatures` (compile-time test) | R-PRED-1 |
| E121 | Contact flagged "likely" | Feed card only; no message is sent because of it | R-PRED-3 |
| E122 | Public record owner name differs from the contact | Not attached; needs review | R-PRED-5 |
| E123 | Reallocation proposed while at the cap | Moves money between campaigns only; Σ ≤ cap | R-ADS-1 |
| E124 | Owner lowers the cap below month-to-date spend | New proposals pause all campaigns to stay at cap (still a tap); copy explains platform overspend | R-ADS-1, R-ADS-5 |
| E125 | Grant revoked while the client is browsing | Next request returns nothing | R-PORTAL-6 |
| E126 | Client edits a URL to another deal's id | 404 (RLS) | R-PORTAL-2 |
| E127 | Spouses share one email | One client account; each grant explicit | R-PORTAL-2 |
| E128 | Agent removes feedback already published | Entry retracted; disappears | R-PORTAL-3 |
| E129 | Client context queries a staff table | 0 rows for every pre-0016 table | R-PORTAL-1 |
| E130 | Client uploads a file with malware | Quarantined; never served | R-PORTAL-7, R-DOC-3 |
| E131 | Extraction quotes a closing date that is not in the PDF | Needs review; never a milestone until confirmed | R-DOC-2 |
| E132 | Google review names the client and the price | Reply draft omits both | R-GBP-2 |
| E133 | Negative review | Drafted on tap only; review requests were never gated by sentiment | R-GBP-2, R-MKT-11 |

---

## 7. Module breakdown (dependency order)

Mirrors Phase 1 layering: core (pure) → db (one schema migration per phase) → api (one module per capability, each owning its admin endpoints, repos, handlers, routes) → web (surfaces). Registration through the CONVENTIONS §3 additive-edit protocol. Core subpaths are new where possible so no two modules edit the same core file; the two exceptions (`core/compliance` channels, `core/assistant` triggers) each have one owner.

### 7.1 Phase 2

| # | Name | Path | Depends on | Critical | Summary |
|---|---|---|---|---|---|
| P2-1 | core/compliance-channels | `packages/core/src/compliance/**` (extend; owner of 2.2.0) | P1 core/compliance | **yes** | `ChannelSpec` registry, consent-channel mapping, `optOutFanout`, `CHANNEL_WINDOW_CLOSED` / `CHANNEL_SESSION_ENDED`, DM keyword handling; `RULES_VERSION = core-compliance/2.2.0`. Property test: adding a channel never relaxes a deny. R-INBOX-3…6. |
| P2-2 | core/listings | `packages/core/src/listings/**` (new subpath) | P1 foundation, assistant (`SearchCriteria`) | yes | RESO-shaped normalization, IDX display check, competing selection with reasons, match reasons, freshness. R-MLS-*. |
| P2-3 | core/assistant-triggers | `packages/core/src/assistant/**` (extend: `playbook.ts`, new `triggers.ts`) | P1 assistant, P2-2 types | **yes** | Trigger step schema + playbook kind, new intents, `detectFirings`, `coalesce`, `recheckFact`, rate-update guard. R-NURT-*, R-MKT-11. |
| P2-4 | core/marketing | `packages/core/src/marketing/**` (new) | P1 assistant (claims), P2-2 | yes | Piece schemas, deterministic renderers with bound facts, identity check, fair-housing ad guard, export bundle, public snapshot, seller-update assembly. R-MKT-*, R-SELL-*. |
| P2-5 | core/transactions | `packages/core/src/transactions/**` (new) | P1 foundation, priority | yes | `planMilestones`, `deriveMilestoneRisks` (feeds `deriveExceptions`). R-TXN-*. |
| P2-6 | core/insights | `packages/core/src/insights/**` (new) | P1 priority | no | Owner metrics, forecast, goal pace, `planWeek`, AVM sendability. R-OWNER-*, R-PLAN-*, R-AVM-2. |
| P2-7 | core/coaching | `packages/core/src/coaching/**` (new) | P1 assistant (claims) | no | Rubric v1, `scoreFromClaims`, `dailyFix`. R-COACH-1…5. |
| P2-8 | db/phase2-schema | `packages/db/migrations/0015_phase2_schema.sql`, `packages/db/src/schema.ts`, `packages/db/test/**` | P1 db; P2-1 mapping (for the guard) | **yes** | All Phase 2 tables/columns/CHECKs, Layer 1+2 policies, replaced `messages_dispatch_guard`, `app.resolve_public_page`, `app.resolve_channel_connection`, `app.resolve_chat_widget` (security review). Smoke extensions; dispatch-guard tests for every new channel; isolation test auto-covers new tables. |
| P2-9 | api/channels | `apps/api/src/channels/**`, `dispatch.ts` branch (coordinated edit), providers `meta`/`webchat` + fakes, lint reserved names (flagged scaffold edit) | P2-1, P2-8, P1 comms/leads | **yes** | Meta webhooks, lead-email intake, public chat endpoints + SSE, connections admin, DM/chat dispatch. Every new outbound path has a gate-runs test (R-GATE-10 style). |
| P2-10 | api/listings-feed | `apps/api/src/listings-feed/**` | P2-2, P2-8 | yes | `mls.sync`, `mls.prune`, MLS admin, competing endpoint, `avm.refresh`, AVM admin. |
| P2-11 | api/triggers | `apps/api/src/triggers/**` | P2-3, P2-8, P2-10, P1 assistant | **yes** | `triggers.detect` from every fact source, trigger step runs, coalescing batches; send via existing `executePlaybookStep`. |
| P2-12 | api/seller-updates | `apps/api/src/seller-updates/**` | P2-4, P2-10 | yes | Weekly assembly job, recommendation-required approval, send. |
| P2-13 | api/transactions | `apps/api/src/transactions/**` | P2-5, P2-11 | yes | Milestone plan/confirm, risk exceptions in recompute, `transaction_updates` template. |
| P2-14 | api/marketing | `apps/api/src/marketing/**`, `DocumentRenderer` provider + fake | P2-4, P2-8 | no | Generate/approve/publish/export/retract, public page route, invites, asset rendering, review link setting. |
| P2-15 | api/calendar | `apps/api/src/calendar/**`, calendar providers + fakes | P2-8 | no | OAuth connect, one-way push, busy lookup. |
| P2-16 | api/coaching | `apps/api/src/coaching/**` | P2-7, P2-8 | no | Call review job, daily fix job, rubric settings. |
| P2-17 | api/insights | `apps/api/src/insights/**` | P2-6, P2-8 | no | Owner view endpoints, source costs, goals CRUD, weekly plan job. |
| P2-18 | web/inbox | `apps/web/src/surfaces/{thread,compose}/**` (extend), `apps/web/src/widget/**` | P2-9 | **yes** | Channel chips, channel-aware compose with honest window copy, chat widget bundle. Phone + desktop Playwright. |
| P2-19 | web/listing-hub | `apps/web/src/surfaces/listings/**` (extend), `surfaces/approvals` (card types) | P2-10, P2-12, P2-14 | yes | Seller update card, marketing tab, competing listings. |
| P2-20 | web/deals-milestones | `apps/web/src/surfaces/deals/**` (extend) | P2-13 | yes | Milestone timeline with confirm chips, risk cards. |
| P2-21 | web/insights | `apps/web/src/surfaces/{owner,goals}/**` (new), feed card types | P2-16, P2-17 | no | Owner desktop view, goals, weekly plan card, daily fix card. |
| P2-22 | web/admin-p2 | `apps/web/src/surfaces/admin/**` (extend) | P2-9…P2-17 endpoints | no | Connections, MLS/AVM, brand kit, milestone templates, review link, rubric, cadence. |

Parallelism: P2-1…P2-7 in parallel; P2-8 after P2-1's mapping is fixed (it needs only the table of channels, so it can start in parallel and merge last); then P2-9, P2-10, P2-15, P2-16, P2-17 in parallel; then P2-11, P2-12, P2-14; then P2-13; web modules follow their APIs.

**Release waves (most valuable phone-first jobs first):**
- **2A** P2-1, P2-2, P2-3, P2-8, P2-9, P2-10, P2-11, P2-18: every lead in one thread; MLS-wide alerts. These remove the most daily work for every agent, on the phone.
- **2B** P2-4 (seller part), P2-5, P2-12, P2-13, P2-15, P2-19 (seller card), P2-20: seller updates, milestones, calendar.
- **2C** P2-4 (marketing part), P2-14, AVM in P2-10, P2-19 (marketing tab), P2-22.
- **2D** P2-6, P2-7, P2-16, P2-17, P2-21: plans, coaching, owner view (Owner value is high but the agent's daily work is not blocked on it).

### 7.2 Phase 3

| # | Name | Path | Depends on | Critical | Summary |
|---|---|---|---|---|---|
| P3-1 | core/voice | `packages/core/src/voice/**` | P1 assistant, compliance | **yes** | Voice playbook schema, `shouldAnswer`, `turnPolicy`, `isHot`, transfer target, slot booking. R-VOICE-*. |
| P3-2 | core/prediction | `packages/core/src/prediction/**` | P1 foundation | **yes** (fair housing) | `PredictionFeatures` (exclusions by type), additive model, reasons, back-test. R-PRED-*. |
| P3-3 | core/ads | `packages/core/src/ads/**` | P2-6 | no | `proposeReallocation` within cap, sample holds. R-ADS-1/3. |
| P3-4 | core/portal | `packages/core/src/portal/**` | P2-5 | **yes** | Entry projection, client-visible filters. R-PORTAL-3. |
| P3-5 | db/phase3-schema | `packages/db/migrations/0016_phase3_schema.sql`, schema.ts, tests | P2-8 | **yes** | Phase 3 tables, client-aware Layer 1 on portal tables only, client definers, voice CHECKs (R-GATE-9 retired, outbound-human CHECK kept); generated "client sees no staff table" test. |
| P3-6 | api/voice | `apps/api/src/voice/**`, `dial.ts` transfer leg (coordinated), `VoiceAgentProvider` + fake | P3-1, P3-5, P2-15 (busy) | **yes** | Answer flow, transfer, summary/handback, booking + confirmation. |
| P3-7 | api/portal | `apps/api/src/portal/**` (separate auth plugin) | P3-4, P3-5 | **yes** | Client magic-link auth, sessions, grants, `portal.sync`, client routes, document streaming + audit. |
| P3-8 | api/documents | `apps/api/src/documents/**`, scanner adapter + fake | P3-5, P2-13 | yes | Upload/version/share, scan, contract extraction ⇒ unconfirmed dates. |
| P3-9 | api/prediction | `apps/api/src/prediction/**`, public-records adapter + fake | P3-2, P3-5 | no | Records refresh, prediction refresh, feed cards, back-test. |
| P3-10 | api/ads | `apps/api/src/ads/**`, ads adapters + fakes | P3-3, P3-5, P2-17 | no | Accounts, cap versions, spend sync, weekly proposals. |
| P3-11 | api/gbp | `apps/api/src/gbp/**`, GBP adapter + fake | P2-14, P3-5 | no | Posts, review list, reply drafts. |
| P3-12 | web/portal | `apps/web/src/portal/**` (second shell) | P3-7 | **yes** | Client timeline, documents, showings, feedback, next steps; phone first. |
| P3-13 | web/p3-surfaces | `apps/web/src/surfaces/{voice,ads,documents}/**`, feed card types, `v_coaching_weekly` page | P3-6, P3-8…P3-11 | no | Voice playbook editor, handback cards, prediction cards, ads desktop, documents, coaching trends. |

**Release waves:** **3A** voice (P3-1, P3-5 voice part, P3-6): answers the calls agents miss every night. **3B** portal + documents (P3-4, P3-7, P3-8, P3-12). **3C** prediction + coaching trends (P3-2, P3-9). **3D** ads + GBP (P3-3, P3-10, P3-11).

---

## 8. Cuts, merges and deferrals

| Item | Decision | Why |
|---|---|---|
| "Seller report" as a marketing piece | **Merged** into seller updates | Same artifact twice is two approvals for one job. |
| Expanded admin as its own module | **Merged** into each feature module + one web module | A cross-cutting admin module would block on everything. |
| Separate trigger/firing table | **Merged** into `playbook_step_runs` | Reuses status lattice, sweeper, gate, failed-send exception. |
| Client/lender update sequences as enrollments | **Merged** into trigger playbooks | One live enrollment per contact must stay. |
| SMS open-house blasts | **Cut** (email only) | Bulk SMS was cut in Phase 1 for TCPA exposure; D1 makes this more, not less, important. |
| Facebook Marketplace posting | **Export only** | No general API we know of; we say so. |
| Auto-posting social by default | **Export first**; API publish only behind an approved connection | Platform app review; honest status. |
| Two-way calendar sync | **Cut** (one-way + live busy read) | Conflict resolution is a product of its own. |
| Gmail/Outlook inbox sync | **Deferred** (not in scope) | Restricted OAuth scopes, security assessment. |
| Multi-turn autonomous SMS qualification (ARCH §18 "Phase 2") | **Defer again**; voice answering covers the qualification job in Phase 3 | Accuracy and TCPA risk; one message + handoff works. |
| Portal messaging channel | **Cut**; "Message {Agent}" deep-links to SMS/email | Avoids a seventh channel and its opt-out keys. |
| E-signature | **Deferred**; link out | Vendor integration, not core work. |
| ML prediction model | **Deferred**; deterministic additive model with reasons | Explainable, testable, fair-housing reviewable. |
| Life-event data in prediction | **Excluded by default** | Mostly protected-class proxies (familial/marital status, disability). |
| Custom audiences / lookalikes | **Cut** | Opt-out leakage to ad platforms; housing ad rules. |
| Auto-apply ad shifts within cap | **Not built**; owner decision D-ADS | Money always needs a tap (ARCH §11). |
| Coaching leaderboards / numeric agent ranking | **Cut** | Not honest about small samples; demotivating; monitoring risk. |
| Rate-move autonomous sends | **Cut** (drafts only) | Money-adjacent; lending-ad rules. |
| Zillow/realtor.com native API connectors | **Deferred** until partner access; email parse ships first | Access unconfirmed. |

---

## 9. Risks and open decisions

**Risks (with mitigations):**
- **D1 plus more automation.** Triggers, transaction updates and home-value notes add automated marketing SMS with no quiet hours or caps (D1). State mini-TCPA laws (e.g. Florida FTSA) may limit this even with consent. Mitigation: opt-out block everywhere (core + DB), coalescing (product), email-first built-in trigger templates. **VERIFY WITH COUNSEL**; reinstating limits stays a policy change.
- **New public surfaces** (public pages, chat widget, client portal) are the first unauthenticated or non-staff entries. Mitigation: definer-only resolution, projection tables, generated client-isolation test, rate limits, security review of every new definer.
- **The opt-out guard change.** Replacing `messages_dispatch_guard` again touches the most important DB control; tests must prove it blocks at least what 0014 blocks for SMS/email, plus the new channels.
- **Meta platform dependency** (app review, messaging window, policy changes). Mitigation: channel window in config; honest status; inbox works without DMs.
- **MLS licensing and volume.** Per-tenant MLS copies could reach millions of rows; RLS performance on `listings` must be benchmarked; prune job; display rules differ per MLS. **VERIFY WITH COUNSEL / MLS.**
- **Lead email parsing is brittle.** Mitigation: per-source templates with fixtures, Admin review card on failure, never silent drops.
- **Fair housing** in marketing copy and prediction. Mitigation: pack lexicons, compile-time feature exclusion, no automated decisions from predictions. **VERIFY WITH COUNSEL.**
- **AVM accuracy** and state valuation rules. Mitigation: range and jump checks, "estimate, not an appraisal". **VERIFY.**
- **Voice AI:** disclosure laws, all-party recording, latency, a hallucinated booking. Mitigation: inbound only, fixed disclosure, evidence-bound summaries, unverified times never become appointments, voicemail fallback. **VERIFY.**
- **Employee monitoring** (call reviews visible to TLs). Mitigation: reuse recording scope; setting; no rankings. **VERIFY.**
- **Ads:** platforms can overspend daily budgets; housing special ad category; attribution lag (closings take months). Mitigation: cap versions, agreements as leading signal, sample holds, honest copy.
- **Shared-file contention:** `dispatch.ts`, `dial.ts`, the lint plugin and the guard are edited by P2-9/P3-6/P2-8. Mitigation: one owner each, edits coordinated, called out.
- **Single schema migration per phase** is a bottleneck. Mitigation: it is written first, from this design, and reviewed adversarially before feature modules start (as 0001 was).

**Open owner decisions:**
- **D-ADS:** may the system apply ad shifts within the Owner's cap without a per-change tap? (Default here: no; every change is a tap. VISION's "shifts itself" would need this decision and an amendment to the money rule.)
- **D-OPTOUT-LANG:** confirm that opt-out *language* on any channel revokes every channel for the person (this draft's default, stricter than per-channel).
- **D-FEEDBACK:** are buyer-agent feedback items included by default in seller updates (default here: yes, each removable), and shared to the portal only when the agent shared them?
- **D-VOICE:** answer missed calls during business hours too, or only after hours? (Default: both, setting.)
- **D-COACH:** do Team Leads see call reviews by default (default: same as `team_lead_recording_access`, on)?
- **Q2 (carried over):** can Team Leads approve team playbooks (now also `transaction_updates` and `voice_answering`)?
- **D-MLS-STORE:** per-tenant MLS copies (default) versus a shared platform cache with per-tenant license gating.

---

## 10. Rule-id register (new prefixes)

R-INBOX-1…11, R-MLS-1…5, R-NURT-1…8, R-SELL-1…5, R-TXN-1…5, R-AVM-1…3, R-MKT-1…11, R-OWNER-1…4, R-PLAN-1…3, R-CAL-1…4, R-COACH-1…6, R-VOICE-1…8, R-PRED-1…5, R-ADS-1…5, R-PORTAL-1…7, R-DOC-1…3, R-GBP-1…2. Edge cases E71…E133. **Retired by this design:** R-GATE-9 (replaced by R-VOICE-1 in Phase 3). Tightened (never loosened): R-CONSENT-8 by R-INBOX-5.
