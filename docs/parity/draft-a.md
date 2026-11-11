# FUB parity: design draft A (simplicity-first)

Branch `design/fub-parity`. Independent draft for the lead, who merges it with draft B, writes `0019_fub_parity.sql` and renumbers rules (R-PAR-n) and edge cases (E-An). Bias: **fewest new concepts, reuse existing tables and machinery.** Nothing here weakens D1 (opt-outs only, no override, every send through `comms/dispatch.ts`), tenancy (FORCE RLS, `tenant_id`-leading PKs, composite FKs), the ownership engine (`applyOwnershipCommand` only) or the autonomy rules. `VERIFY` = FUB behaviour I am not sure of; `VERIFY WITH COUNSEL` = legal.

## 0. The whole design on one page

| Job | Reuse | New (schema) | New concept? |
|---|---|---|---|
| Notes + @mentions | `notes` table, `notifications` (+ kind `mention`), `contact_timeline` | none for mentions (tokens in the body); DELETE policy on notes | no |
| Manual activity log (call/text/email) | `notes` (+ `kind`, `occurred_at`, `direction`, `logged_outcome`) | 4 columns | no (a note with a kind) |
| Manual meeting log | `appointments` + `POST /appointments/:id/outcome` (both exist) | none | no |
| Tags | `contacts.tags text[]` + existing GIN index | `tags` catalog (name, color, `merged_into_tag_id`) + canonicalizing trigger | catalog only |
| Add / edit person | `POST /contacts` (exists), `contact_points`, `contact_addresses`, dedup definers | `PATCH /contacts/:id` + point/address routes (no schema) | no |
| Stages | fixed `contacts.stage` CHECK (8 values) | `tenant_settings.stage_labels jsonb` (rename only) | no |
| Custom fields | `contact_attributes` (key/value jsonb, detail-visible RLS) for values; `imported_fields` stays raw provenance | `custom_field_defs` + `contact_attributes.field_def_id` | one (field definitions) |
| Relationships | — | `contact_relationships` (one row per pair) | small |
| Templates | `comms/render.ts` footer (brokerage, postal, unsubscribe), core render semantics (one pass, literal) | `message_templates` | yes (unavoidable) |
| Smart lists | `contacts` columns + indexes, RLS does row scoping | `smart_lists` (Zod definition jsonb) | yes (unavoidable) |
| Bulk actions | `jobs`, `audit_log`, `applyOwnershipCommand`, `playbook_enrollments`, `composeHumanMessage` → `dispatchOutbound` | `bulk_actions`, `bulk_action_items`, `messages.bulk_action_id`, `tenant_settings.batch_text_enabled` | one (a bulk action) |
| FUB import of tags/stages/custom fields | `import_batches.options` (already holds the CSV mapping), `collectTags`, `mapStage`, `putImportedField` | none beyond the above | no |

**7 new tables** (`tags`, `custom_field_defs`, `contact_relationships`, `message_templates`, `smart_lists`, `bulk_actions`, `bulk_action_items`). **Changed:** `notes` (+ kind, occurred_at, direction, logged_outcome), `notifications.kind`, `contact_attributes` (+ field_def_id, import_record_id), `messages`, `tenant_settings`, the `contact_timeline` and `v_agent_activity_daily` views, a DELETE policy on `notes`. Every new table: `tenant_id uuid NOT NULL` leading the PK, every reference a composite `(tenant_id, x_id)` FK, Layer-1 `tenant_isolation` + `support_read_only_*` (generated, as 0001 §22 / 0018), `updated_at` trigger where it has one, enums as `text + CHECK`, UUIDv7 ids from core (no DB defaults). Contact children `ON DELETE CASCADE` so `app.purge_contact_internal` / `app.erase_contact` need no change except where noted.

## 1. Current state (verified in code, 2026-11-11)

| Job | State | Evidence |
|---|---|---|
| Notes API/UI | **Missing.** Table + RLS exist (select: contact detail or deal visible; insert: author = me; update: author or tenant-wide; **no DELETE policy**). Only the importer writes notes. Notes show in timeline and search. | `packages/db/migrations/0001_init.sql:2011-2035, 3207-3216`; `apps/api/src/imports/repos/writes.ts:129`; `apps/api/src/leads/repos/timeline.ts`; `apps/api/src/workspace/search.ts`; no `/notes` route in any `routes.ts` |
| @mentions | **Missing.** `notifications.kind` CHECK has no `mention`. | `0001_init.sql:2186-2206` |
| Tags | **Storage only.** `contacts.tags text[]` + GIN `contacts_tags_idx`; serialized only in the full view; import writes them (case-insensitive dedup, ≤ 64 chars, ≤ 100/contact). No catalog, no tag API/UI, no colors, no rename/merge. | `0001_init.sql:713, 779`; `apps/api/src/leads/views.ts:105`; `packages/core/src/import/csv.ts:501-516`; `apps/api/src/imports/repos/writes.ts:41` |
| Add person | **API only.** `POST /contacts` (lock_address + find_contacts_by_address, `DUPLICATE_CONTACT`, `confirmDistinct`); body has names, ≤5 phones, ≤5 emails, intent, contactType; **no stage, tags, address, source**. **No web UI** (no add-person surface in `apps/web/src/surfaces/**`). | `apps/api/src/leads/contacts.ts:1-30, 73`; `apps/api/src/leads/schemas.ts:71-82` |
| Edit person | **Missing.** No `PATCH /contacts/:id`; no point/address routes. `row_version` exists for optimistic concurrency. | route list in `apps/api/src/**/routes.ts` |
| Stages | Fixed CHECK of 8. **No API changes a contact's stage** (set only at create/import). Stage has semantics: inactivity release only for `new/attempting`; handbacks "hot" for `new/attempting`. | `0001_init.sql:677`; `packages/core/src/ownership/types.ts:45-48`; `apps/api/src/comms/inbound.ts:300` |
| Custom fields | **Display-only.** FUB `custom*` fields and the original FUB stage/source/type/background/price land in `contacts.imported_fields` as strings. `contact_attributes` (typed jsonb, protected-proxy CHECK) exists and is read by the assistant's prompt bundle (protected proxies dropped). | `packages/core/src/import/fub.ts:13-14, 251-262`; `0001_init.sql:908-928`; `apps/api/src/assistant/repos/context.ts:111-121` |
| Relationships | **Missing** (only "the same address may sit on several contacts"). | `0001_init.sql:843-868` |
| Templates | **Missing** for humans. Only playbook step templates (`apps/api/src/assistant/templates.ts`, core `assistant/render.ts`: `{{slot}}`, one literal pass). Human email/SMS footer (brokerage legal name, postal address, unsubscribe + List-Unsubscribe) is added by `comms/render.ts`; purpose is classified server-side (`classifyHumanPurpose`: marketing unless a reply ≤ 30 d or a deal/appointment). | `packages/core/src/assistant/render.ts:1-17`; `apps/api/src/comms/render.ts:1-10`; `packages/core/src/compliance/content.ts:118` |
| Smart lists | **Missing.** There is no contact list endpoint at all, only type-ahead `GET /search`. | `apps/api/src/workspace/routes.ts:268` |
| Bulk actions | **Missing.** | — |
| Unsubscribe | **Exists**: public `GET/POST /email/unsubscribe/:token` (MAC-signed, one-click). | `apps/api/src/comms/routes.ts:231-243`; `comms/unsubscribe.oneclick.test.ts` |
| Logging outside calls/texts/emails | **Missing.** `messages`/`calls` CHECKs tie outbound to dispatch (status lattice, sender identity, guard triggers). Appointments can be created and given an outcome. | `0001_init.sql:1284-1400`; `apps/api/src/workspace/routes.ts:101-112` |
| FUB import: tags / stages / custom fields | **Partly there (the brief's claim is too strong).** Tags ARE imported into `contacts.tags`; stages ARE mapped by a fixed word list (`STAGE_UNMAPPED` → `new`, original label kept in `imported_fields['FUB stage']`); custom fields ARE imported, but only as display strings. Missing: an Admin stage mapping, a tag catalog, typed custom fields. | `packages/core/src/import/csv.ts:355-361`; `fub.ts:247-262` |
| Background human sends | `dispatchOutbound` already rebuilds a **human** sender from the message row in the worker, so RLS re-decides visibility at send time, and a human send by owner/collaborator is a **touch**. | `apps/api/src/comms/dispatch.ts:17-22, 75-100, 160-165` |

## 2. Notes and @mentions

**Tables.** `notes` unchanged except §10's activity columns. New policy `notes_delete`: USING `(is_tenant_wide() OR author_user_id = app.user_id()) AND NOT imported`. `notifications.kind` + `mention`.

**Mention format.** Body stores `@[Display Name](user:<uuid>)`; core `parseMentions(body) → userId[]` (≤ 10 per note, deduped). The display text is re-resolved from `memberships` at render (a renamed or removed user shows the current name or "former member"). **No `note_mentions` table**: the notification row is the record; "mentions of me" = my `mention` notifications.

**API (new `apps/api/src/notes/**`).** `POST /contacts/:id/notes`, `POST /deals/:id/notes` {body, pinned?}; `PATCH /notes/:id` {body?, pinned?, rowVersion}; `DELETE /notes/:id`; `GET /contacts/:id/mentionable?q=` (members who can see this contact's detail). Timeline already lists notes.

| Role | Read note | Write | Edit/delete | Mention target |
|---|---|---|---|---|
| Owner/Admin | all (tenant-wide) | any visible parent | any non-imported | anyone who can see the parent |
| Team Lead | team's contacts + pond detail per §2 | same set | own notes | same |
| Agent / ISA | O (+D for agents) | same set | own notes | same |
| TC | D (deal contacts, deal notes) | same set | own notes | same |

RLS row rule (exists): a note on a contact is visible exactly when the contact's detail is; a deal-only note when the deal is.

**Rules**
- **R-PAR-1** A mention is saved only if **every** mentioned user is an active member who can see the note's parent (contact detail, or the deal) **at save time**; otherwise the save is refused `MENTION_NOT_VISIBLE` naming only users the author already named, with the fix "Add Maya as a collaborator first" (owner/TL/Admin only, existing `contact_collaborators`). The check is the definer `app.user_sees_contact_detail(p_user, p_contact)` / `app.user_sees_deal(p_user, p_deal)` (boolean only, app_definer, pinned search_path; **security review item**) which evaluates the §2 central rule for another user; a generated test asserts it equals the real RLS answer for every role fixture × contact state.
- **R-PAR-2** The `mentionable` list returns only users for whom R-PAR-1 holds (ids + display names). It reveals nothing about contacts the caller cannot see (the caller must see the parent: 404 otherwise, R-PERM-5).
- **R-PAR-3** A mention notification is PII-minimized like every notification: title "Ben mentioned you", body "on a note" (never the note text, never the contact name beyond `notification_detail` = `first_name_initial`), subject `note`, dedupe `mention:{note_id}:{user_id}` (an edit that re-mentions does not re-notify). Opening it fetches under the reader's RLS; if they lost sight since, it is a 404 "You no longer have access".
- **R-PAR-4** Editing a note re-parses mentions; only newly added users are checked and notified. Removing a mention does not delete the notification (it already said nothing).
- **R-PAR-5** Imported notes are read-only (no edit, no delete; `CHECK imported = (source='import')` kept); edits to own notes write `audit_log` `note.edited` / `note.deleted` with ids only (R-TEN-7).
- **R-PAR-6** Mention parsing is literal: tokens inside the body are never expanded into anything else, and a token naming a non-member uuid is rejected `MENTION_UNKNOWN`.

**Edge cases**
| # | Case | Handling |
|---|---|---|
| E-A1 | Agent @mentions an ISA who is no longer a collaborator on the lead | `MENTION_NOT_VISIBLE`; UI offers "Remove mention" or (owner) "Add as collaborator" |
| E-A2 | Mentioned user loses visibility (lead reassigned) after the notification | Tap ⇒ 404 sentence; notification text carried nothing |
| E-A3 | Note on a deal-only contact by a TC mentions the agent | Allowed when the agent sees the deal |
| E-A4 | Author hand-types `@[Owner](user:<random uuid>)` | `MENTION_UNKNOWN` |
| E-A5 | Pond viewer tries to add a note to a pond card | 404 (needs detail; insert policy uses `contact_detail_visible`) |
| E-A6 | Mention spam: 40 mentions | > 10 ⇒ `TOO_MANY_MENTIONS` |

**Cut:** threaded replies and reactions on notes (FUB comments VERIFY); `note_mentions` table; mentioning teams ("@buyers"); notes visibility levels (private notes): one rule, the contact's.

## 3. Tags

**Tables.**
- `tags` (tenant_id, id, name text 1-64 NFC trimmed, `name_key text GENERATED (lower(name)) STORED`, color text CHECK in a fixed palette of 12 token names or NULL, `merged_into_tag_id uuid NULL` (composite FK to `tags`), created_by_user_id, created_at, updated_at, archived_at). PK (tenant_id, id); UNIQUE (tenant_id, name_key); CHECK merged ⇒ archived; CHECK no self-merge.
- `contacts.tags text[]` stays the storage (GIN `contacts_tags_idx` reused). New trigger **`contacts_tags_canonical`** BEFORE INSERT OR UPDATE OF tags: each element is matched by `lower()` to the catalog, follows `merged_into_tag_id` (bounded depth 8), is replaced by the target's spelling, duplicates removed, unknown names refused `TAG_UNKNOWN`, archived (not merged) names refused `TAG_ARCHIVED`, > 100 refused. Runs under the caller (no definer needed: catalog is member-readable).

Why not a join table: the array is already indexed, imported, read by the import-revert fingerprint and the feed types; the trigger makes it case-insensitive and catalog-backed; rename/merge reduce to one mechanism (below). The cost is a chunked rewrite on merge, which is rare and Admin-only.

**Rename = merge.** Renaming "Buyer" to "Buyers" inserts (or finds) the target row and sets the old row `merged_into_tag_id` + `archived_at`; a job `tags.rewrite` (system actor, 1,000 contacts/tx, `array_replace` WHERE `tags @> ARRAY[old]`) rewrites arrays. Until it finishes, the trigger already maps writes of the old spelling to the new one, and smart lists query **both** spellings (the catalog resolver expands a tag filter to the target + its aliases). Color-only edits touch only the catalog. Delete = archive + `tags.rewrite` removing it.

| Action | Owner | Admin | TL | Agent | ISA | TC |
|---|---|---|---|---|---|---|
| Read catalog | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create a tag (by typing a new one) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Tag/untag a contact | ✅ | ✅ | T | O | O | — |
| Rename, merge, recolor, delete | ✅ | ✅ | — | — | — | — |

RLS: `tags` select members; insert members except TC (`my_role() <> 'tc'`) as themselves; update/delete-by-archive Owner/Admin. Contact tagging needs contact UPDATE RLS **and** API `contact.edit` (detail) — UPDATE RLS alone includes pond cards (§2), so the API check is load-bearing (R-PAR-9).

**Rules**
- **R-PAR-7** Tag names are case-insensitively unique per tenant; the stored spelling on contacts is always the catalog's (DB trigger). [DB, smoke]
- **R-PAR-8** Tag names are tenant-visible metadata. The create field says "Everyone on the team can see tag names." Tags on a contact are detail data: never on cards, pond cards, offer cards, notifications or job payloads (R-PERM-6, R-TEN-7).
- **R-PAR-9** Tagging requires `contact.view_detail` + `contact.edit` (core) on top of UPDATE RLS; a pond/offer-card viewer gets 404.
- **R-PAR-10** A merge never loses a contact's tag: after `tags.rewrite` the count of contacts carrying the target ≥ the pre-merge union (job asserts, audits `tag.merged` with counts).
- **R-PAR-11** Per-tenant catalog limit 1,000 live tags (`TAG_LIMIT`); per contact 100 (existing import limit). FUB limits VERIFY.
- **R-PAR-12** A tag never means anything to the system: no tag reads as an opt-out, routes, or triggers a send. (The importer's opt-out tag reading stays an *import-time* conversion into revocations/suppressions, ARCHITECTURE §13.)
- **R-PAR-13** Tagging is not a touch and never changes ownership; it bumps `row_version`, and it counts as a human edit for the import-revert fingerprint (the revert then lists the contact for a human decision, as today).

**Edge cases**
| # | Case | Handling |
|---|---|---|
| E-A7 | Agent types "buyer" while "Buyer" exists | Stored as "Buyer" |
| E-A8 | Admin merges "Hot" into "A-Lead" while an agent tags someone "Hot" | Trigger maps to "A-Lead"; job converges |
| E-A9 | Admin renames "A" → "B" then "B" → "A" | Second rename finds the archived "A"; it is un-archived as target (merge chain cleared), "B" becomes alias; rewrite job is idempotent |
| E-A10 | Two agents create "Investor"/"investor" at once | UNIQUE (tenant, name_key) ⇒ second upserts to the first |
| E-A11 | Tag named "STOP" or "DNC" | Allowed and meaningless (R-PAR-12); UI hint "Tags don't stop messages. Use Do not contact." |
| E-A12 | Tag catalog at 1,000 and FUB import brings 1,400 | Import dry run reports `TAG_LIMIT` per record; Admin merges or skips; imported_fields keeps the raw list |

**Cut:** tag groups/folders, per-tag permissions, private tags, tag-triggered automations (FUB "action plans on tag" VERIFY) — an automation trigger would be a new kind of autonomous send; enroll in bulk instead (§11).

## 4. Add and edit a person

**No schema.** New routes in `apps/api/src/people/**` (not `leads/**`, which module 22 owns):

| Route | Does | Auth |
|---|---|---|
| `POST /contacts` | **existing**; one flagged additive edit (§15): optional `leadSourceId`, `stage`, `tags`, `address` in the same transaction | `contact.create` |
| `PATCH /contacts/:id` {rowVersion, firstName?, lastName?, displayName?, contactType?, intent?, stage?, timezone?, tags?} | optimistic `WHERE row_version = $v` ⇒ `STALE_CONTACT`; never ownership, attribution, `do_not_contact_*`, `imported_fields` | `contact.edit` (new action) |
| `POST /contacts/:id/points` {kind, address, label, isPrimary?} | normalize (core), HMAC, `app.lock_address`, `find_contacts_by_address` ⇒ warn (not refuse) "Also on Jane Doe (Ben's)" per R-PERM-12; insert | `contact.edit` |
| `PATCH /contact-points/:id` {label?, isPrimary?, status: `wrong_number`/`removed`?} | the address itself is immutable | `contact.edit` |
| `POST/PATCH/DELETE /contacts/:id/addresses[/:aid]` | `contact_addresses`; jurisdiction/timezone recomputed by core | `contact.edit` |

`contact.edit` matrix = the UPDATE set: Owner/Admin ✅, TL T, Agent O, ISA O, TC — (TCs edit deal data, not people; DATA_MODEL §3 already gives TC no contact writes).

**Rules**
- **R-PAR-14** A contact point's address never changes in place (HMAC and opt-out keys depend on it): "edit a number" = add the new point + mark the old `removed`. Removing a point never lifts anything: consent and suppressions are address-keyed and stay; re-adding an opted-out address stays blocked. [DB guard unchanged + api test]
- **R-PAR-15** Adding a point that matches another contact never merges and never refuses: it records a `contact_duplicate_candidates` pair and shows the R-PERM-12 sentence (name only if the caller can see that contact). Merge stays the existing human flow.
- **R-PAR-16** Owner, offer and pond change only through `applyOwnershipCommand` (assign/reassign/release buttons); `PATCH` rejects ownership fields at the Zod layer (strict object) and the guard trigger would refuse them anyway.
- **R-PAR-17** Attribution (`original_*`) is immutable (existing trigger); manual create may set `leadSourceId` once at creation only (default: the tenant's `manual` source if present, else none, and the UI says "Source: added by Ben").
- **R-PAR-18** A self-created contact is owned by the creator with no SLA (R-OWN-19 unchanged); an Admin creating "for" an agent creates then assigns (two ledger events, both audited).
- **R-PAR-19** Every edit writes `audit_log` `contact.edited` with a redacted diff (field names only for PII fields, R-TEN-7).

**Edge cases**
| # | Case | Handling |
|---|---|---|
| E-A13 | Two tabs edit the same person | Second save `STALE_CONTACT`; UI reloads the fields and keeps the user's unsaved text |
| E-A14 | Agent adds spouse's mobile, which opted out last year | Point added; compose shows "Won't send: Opted out of texts"; nothing overridable |
| E-A15 | Agent "fixes" a number by retyping one digit | New point + old removed; old one's STOP stays attached to the old number only |
| E-A16 | ISA edits after the handoff window expired | 404 (collaborator expired ⇒ not visible) |
| E-A17 | Phone typed as "(555) 010-2000 ext 4" | core normalize rejects the extension `PHONE_EXTENSION_UNSUPPORTED` (VERIFY whether FUB keeps extensions) |
| E-A18 | Change stage of a merged-away contact | Merged contacts are closed ⇒ `CONTACT_CLOSED` |

**Cut:** birthday/anniversary as core columns (custom date fields, §6), photos/avatars, social profile URLs (custom text field), editing `imported_fields` (raw provenance stays read-only), unmerge (still deferred, PHASE2_3_PLAN §3).

## 5. Stages: keep the fixed CHECK

**Decision: not tenant-configurable.** The 8 stages carry system meaning: inactivity release applies only to `new/attempting` (`INACTIVITY_STAGES`), handbacks are hot for `new/attempting`, the speed-to-lead and momentum views and the scoreboard read them. Configurable stages would force a "meaning" column on every custom stage (a second concept) or silently change ownership timers. FUB stages are configurable (VERIFY: FUB ships a default set and lets admins add/rename). Parity is delivered by:

1. `tenant_settings.stage_labels jsonb` (Owner/Admin): display label per fixed key, e.g. `nurture` → "Long-term nurture"; ≤ 40 chars; keys ⊆ the 8 (CHECK via a core-validated trigger). Labels are display-only; code and smart lists use keys.
2. Import maps every FUB stage label to one of the 8 (§12), with an option to **keep the FUB stage as a tag** ("FUB: Hot Prospect"), so custom FUB segments stay filterable without new stages.
3. `PATCH /contacts/:id {stage}` and bulk "Set stage".

**Rules**
- **R-PAR-20** Stage is a contact field any `contact.edit` holder may change; it never changes ownership. Moving **out of** `new/attempting` needs no timer work: the stored inactivity deadlines stay, and the release is a no-op at fire time because core re-reads the live stage (verified: `packages/core/src/ownership/timers.ts:62` `inactivityApplies`, used at `decide.ts:717`). Moving **into** them creates no deadline until the next ownership start or human touch recomputes them (`inactivityDeadlines`, R-OWN-23 unchanged): a manual stage change never starts a release clock by itself.
- **R-PAR-21** A stage change writes `audit_log` `contact.stage_changed` (from/to keys) **and**, in the same transaction, a `notes` row `kind = 'stage_change'` ("Stage: Attempting → Connected"), so it appears in the timeline under the contact's own visibility (`audit_log` is Owner/Admin-only, so the timeline cannot read it). See §10.
- **R-PAR-22** `under_contract`/`closed` set by hand do not create or close deals; the deal pipeline (`deals.stage`) stays separate (VERIFY that FUB "Closed" vs deal stages is a frequent confusion; the UI says "This is the person's stage, not a deal").

**Cut:** custom stages, custom pipelines, per-stage automations, stage-dwell reporting for contacts (deal dwell exists).

## 6. Custom fields

**Tables.**
- `custom_field_defs` (tenant_id, id, key text CHECK `^cf_[a-z0-9_]{1,40}$` (immutable), label 1-60, type CHECK (`text/number/date/single_select/multi_select`), options jsonb (selects: array of {value ≤ 60}, ≤ 50, unique case-insensitively), position smallint, created_by_user_id, created_at, updated_at, archived_at). PK (tenant_id, id); UNIQUE (tenant_id, key); UNIQUE (tenant_id, lower(label)) WHERE archived_at IS NULL. Trigger: ≤ **25 live defs per tenant** (`CUSTOM_FIELD_LIMIT`; FUB's limit VERIFY); type and key never change; options may be appended or renamed, never removed while in use (archive the option instead: `{value, archived: true}`).
- Values reuse **`contact_attributes`** (+ `field_def_id uuid NULL`, composite FK `(tenant_id, field_def_id)` → defs ON DELETE CASCADE). CHECKs: `field_def_id IS NOT NULL ⇒ key LIKE 'cf\_%' AND sensitivity = 'normal' AND NOT self_reported AND evidence_claim_id IS NULL`; `key LIKE 'cf\_%' ⇒ field_def_id IS NOT NULL`. A deferred trigger checks `key = def.key` and value shape per type: text = JSON string ≤ 500; number = JSON number (finite, ≤ 15 significant digits); date = string `YYYY-MM-DD`; single = one of the def's live options; multi = array of distinct live options (≤ 20).
- `imported_fields` stays: raw, read-only provenance shown under "From Follow Up Boss".

Why `contact_attributes`: already per-contact, typed jsonb, `UNIQUE (tenant, contact, key)`, detail-visible RLS, cascades with purge/erasure, and the fair-housing protected-proxy CHECK lives there. The `cf_` prefix keeps user fields disjoint from assistant keys and from the protected key list.

| Action | Owner | Admin | TL | Agent | ISA | TC |
|---|---|---|---|---|---|---|
| Read defs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/edit/archive defs | ✅ | ✅ | — | — | — | — |
| Read values | per contact detail visibility (existing `contact_attributes` RLS) |
| Write values | `contact.edit` (Owner/Admin ✅, TL T, Agent O, ISA O) |

**Rules**
- **R-PAR-23** Defining a field whose label or options match the fair-housing protected lexicon (core `fairhousing` module 20; e.g. religion, national origin, familial status, disability, military status) is refused `CUSTOM_FIELD_PROTECTED`; such facts stay in the existing self-reported `protected_proxy` attributes. **VERIFY WITH COUNSEL** (lexicon scope; whether storing them at all is advisable).
- **R-PAR-24** Custom field values reach the assistant prompt only as untrusted data (existing `contactBundle` path; they are `normal` attributes) and are never merge fields in **autonomous** sends (playbook steps use their closed slot set, unchanged).
- **R-PAR-25** Archiving a def hides it and its values everywhere (UI, smart lists, merge fields) but keeps values until purge; un-archive restores them. Deleting a def is not offered.
- **R-PAR-26** Values are typed at write (DB trigger + core Zod); a smart-list filter is typed by the def (number range, date range/relative, option in/contains-any, text equals/contains).

**Edge cases**
| # | Case | Handling |
|---|---|---|
| E-A19 | Admin renames option "Pre-approved" → "Preapproved" | Options carry a stable `value`; values reference the value, label changes are display-only (store `{id, label}` pairs; the lead may prefer this to `value`) |
| E-A20 | Two Admins add the 25th and 26th field at once | Trigger counts under `pg_advisory_xact_lock(tenant, 'cfdefs')`; second `CUSTOM_FIELD_LIMIT` |
| E-A21 | Date "02/03/2026" from FUB | Ambiguous ⇒ import issue `CUSTOM_FIELD_UNPARSEABLE`, raw kept in `imported_fields` |
| E-A22 | Field named "Military status" | `CUSTOM_FIELD_PROTECTED` with the sentence pointing to the self-reported fact |
| E-A23 | Agent-scoped visibility of a sensitive field ("Divorce case #") | Same rule as the contact; no per-field permission (cut) — UI copy on def create: "Anyone who can see the person sees this field" |

**Cut:** per-field permissions, required fields, computed fields, deal/listing custom fields, URL/phone/email types (use text), custom fields as routing inputs.

## 7. Relationships

**Table** `contact_relationships` (tenant_id, id, contact_a_id, contact_b_id, kind CHECK (`spouse_partner/household/family/co_buyer/co_seller/friend/other`), label text ≤ 40 NULL, created_by_user_id, created_at). PK (tenant_id, id); composite FKs to contacts ON DELETE CASCADE; CHECK `contact_a_id < contact_b_id`; UNIQUE (tenant_id, contact_a_id, contact_b_id). Index (tenant_id, contact_b_id). All kinds are symmetric (one row per pair).

**RLS:** select/insert/delete only when **both** contacts are detail-visible (`app.contact_detail_visible` on a and b); insert/delete also `contact.edit` on the contact the user is on (API). No update (delete + insert).

**Rules**
- **R-PAR-27** A relationship is shown only when both people's details are visible to the viewer; otherwise it does not exist for them (no "1 hidden relationship" count). Linking a person you cannot see is impossible: the picker is the RLS-scoped search.
- **R-PAR-28** A relationship grants nothing: no visibility, no merge, no shared opt-out, no merge fields from the related person (R-PAR-34).
- **R-PAR-29** On merge, the survivor takes the loser's relationships (dedupe the pair; a self-pair is dropped) inside the existing merge transaction (one flagged additive edit in the merge code owner's file, §15).

**Edge cases:** E-A24 an agent who sees only one spouse sees no relationship; E-A25 merging A into B where A–B were "spouses" drops the self-pair; E-A26 erasing one person cascades the row.

**Cut:** directional kinds (referred-by: use attribution/lead source), relationships to deals (exists: `deal_contacts`), relationship-based visibility.

## 8. Templates

**Table** `message_templates` (tenant_id, id, scope CHECK (`personal/team`), owner_user_id NULL, channel CHECK (`sms/email`), name 1-80, subject ≤ 300 NULL, body 1-10,000, created_by_user_id, row_version, created_at, updated_at, archived_at). PK (tenant_id, id); CHECK `(scope='personal') = (owner_user_id IS NOT NULL)`; CHECK `(channel='email') = (subject IS NOT NULL)`; UNIQUE (tenant_id, scope, coalesce(owner_user_id, nil), lower(name)) WHERE archived_at IS NULL.

**RLS:** select: team rows for members; personal rows for the owner only (Owner/Admin do **not** read others' personal templates; system does). Insert/update: personal by owner as self; team by Owner/Admin (and TL, if the owner wants; default no).

**Merge fields (closed set).** `{{contact.first_name}}`, `{{contact.last_name}}`, `{{contact.display_name}}`, `{{contact.cf_<key>}}` (live text/number/date/single defs), `{{me.first_name}}`, `{{me.last_name}}`, `{{me.phone}}` (my agent_direct number), `{{me.email}}` (my email identity), `{{team.name}}`, `{{brokerage.name}}`. Fallback `{{contact.first_name|there}}`. Nothing else: no addresses, no other contacts, no deal money, no listing data (listing marketing has its own approved pieces).

**Render path.** New `POST /contacts/:id/template-render {templateId, channel}` → `{subject, body, missing: [field]}`. It loads **one** contact's facts under the caller's RLS (detail visible, else 404), renders with a new pure `core/parity/merge.ts` (same semantics as `assistant/render.ts`: one literal pass, values cleaned of CR/LF/control chars, ≤ 200 chars, never re-expanded; email bodies HTML-escaped by the existing email renderer). The client places the result in ComposeBox; the user may edit; then the **existing** `POST /contacts/:id/messages` (+ `/preview`) sends it. **Zero change to compose or dispatch for one-to-one templates**; the existing `renderHumanBody` adds the brokerage name to marketing SMS and the brokerage/postal/unsubscribe footer to email, and the existing classifier decides marketing vs informational.

**Rules**
- **R-PAR-30** Templates are inserted text, not approvals: a human sends every one-to-one message (one tap), so a template never makes a send autonomous; the assistant cannot use human templates.
- **R-PAR-31** Brokerage identity: a template's preview always shows the footer the send will carry; a template that is marketing in purpose cannot remove it (the footer is outside the template). A template body containing a payment/wire pattern is flagged at save with the same core check the gate runs (check 7), and blocked at send as today.
- **R-PAR-32** The renderer receives a facts object built from exactly one contact id and the sender; it has no lookup capability (pure function), so a template cannot read another contact's data. Property test: rendering for contact X never outputs a value belonging to any other fixture contact.
- **R-PAR-33** A missing merge field without a fallback is returned in `missing`; one-to-one compose highlights it and refuses to auto-send `{{…}}` literals (core rejects a body still containing `{{`); bulk skips that recipient with `MERGE_FIELD_MISSING`.
- **R-PAR-34** Related people's data, custom fields of other contacts, ownership data and opt-out state are never merge fields.
- **R-PAR-35** SMS templates show segment count and say "Your brokerage name is added to marketing texts" where the renderer will add it.

**Edge cases**
| # | Case | Handling |
|---|---|---|
| E-A27 | First name contains `{{me.email}}` | Inserted literally (one pass) |
| E-A28 | Personal template of a removed member | Stays owner-only (unreadable by anyone else); deleted by the member-removal job; the lead sets the retention |
| E-A29 | Team template edited while an agent has it open | `row_version`; the agent's inserted text is already in compose, unaffected |
| E-A30 | Template refers to an archived custom field | Render returns it as missing |

**Cut:** HTML/visual email builder (plain text + the existing footer; VERIFY FUB has rich templates), attachments in templates, template folders/sharing to individuals, open/click tracking per template (opens are signals only, R-AST), A/B tests, "send as the assigned agent" (impersonation; honesty).

## 9. Smart lists

**Table** `smart_lists` (tenant_id, id, name 1-80, scope CHECK (`personal/team`), owner_user_id NULL, definition jsonb (Zod `SmartListDefinition` v1, ≤ 8 KB), sort CHECK (`last_activity_desc/created_desc/name_asc/next_task_asc`), position smallint, created_by_user_id, row_version, created_at, updated_at, archived_at). CHECK `(scope='personal') = (owner_user_id IS NOT NULL)`.

**Definition (v1):** `{ v: 1, all: Clause[] }` (AND of clauses; each clause OR-within-values). Fields: `stage in`, `contactType in`, `intent in`, `tag hasAny | hasAll | hasNone`, `source in` (lead_source ids), `owner in` (user ids | `me` | `unassigned` | `pond`), `lastActivity olderThanDays | withinDays | never`, `nextTask overdue | dueWithinDays | none`, `created withinDays | between`, `cf <key> eq | in | containsAny | between | before | after | isEmpty`, `optedOut channel` (read-only facet: shows who is blocked; never a way to message them). No free text, no SQL, no OR across clauses (cut).

**Execution.** `GET /smart-lists/:id/contacts?after=` and `POST /contacts/query {definition}` (unsaved). Core compiles the definition to a typed AST; the API builds a parameterized Kysely query; RLS scopes the rows. Keyset pagination (sort key, id), page 50. Counts via `GET …/count` capped at 10,000 ("10,000+"), computed with the same query.

| Action | Owner | Admin | TL | Agent | ISA | TC |
|---|---|---|---|---|---|---|
| Personal lists | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (D contacts only) |
| Create/edit team lists | ✅ | ✅ | ✅ | — | — | — |
| Run any visible list | results always = **the viewer's** detail-visible contacts |

**Rules**
- **R-PAR-36** A list returns only contacts whose **detail** is visible to the viewer (`app.contact_detail_visible`), never pond or offer cards, because its filters read detail data (tags, custom fields, tasks, activity); a filter must not reveal a pond card's tags. Pond browsing stays on the pond page. [DB + api test per role]
- **R-PAR-37** A shared (team) list is a definition, not a result set: two viewers see different rows; the list page says "Showing people you can see".
- **R-PAR-38** Tag filters expand to the target tag plus its merged aliases (R-PAR-10 window); archived defs make their clauses inert with a visible "field archived" chip.
- **R-PAR-39** `lastActivity` = `greatest(last_human_touch_at, last_inbound_at)`; logged activity (§10) does not move it (default; owner question Q2).
- **R-PAR-40** Performance budget: first page p95 ≤ 300 ms and count ≤ 1 s for an Owner over 250,000 contacts with up to 5 clauses, proven by a seeded perf test (pattern: `apps/api/src/workspace/perf.test.ts`) with `EXPLAIN` assertions that the planner uses an index for each indexed clause.

**Indexes (0019, by the lead).**
| Index | Serves |
|---|---|
| `contacts (tenant_id, stage, id) WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL` | stage clause + keyset |
| `contacts (tenant_id, (greatest(last_human_touch_at, last_inbound_at)) DESC NULLS LAST, id) WHERE deleted_at IS NULL` | last-activity sort/filter (default sort) |
| `contacts (tenant_id, created_at DESC, id) WHERE deleted_at IS NULL` | created clause/sort |
| `contacts (tenant_id, original_lead_source_id) WHERE deleted_at IS NULL` | source |
| existing `contacts_owner_idx (tenant_id, owner_user_id)` | owner / agent's own rows |
| existing GIN `contacts_tags_idx` | tag hasAny/hasAll (`&&`, `@>`) |
| `tasks (tenant_id, contact_id, due_at) WHERE status = 'open' AND contact_id IS NOT NULL` | next task (EXISTS / MIN) |
| `contact_attributes (tenant_id, key, value) WHERE field_def_id IS NOT NULL` (btree on jsonb) | cf eq/in/between/before/after (jsonb numeric and ISO-date string ordering) |
| `contact_attributes USING gin (value jsonb_path_ops) WHERE field_def_id IS NOT NULL` | multi-select containsAny |
| `contact_attributes (tenant_id, contact_id)` exists via UNIQUE | EXISTS join back |

At 250k, the expensive part for non-tenant-wide roles is the RLS predicate, which is cheap because their sets start from `owner_user_id`/collaborator indexes; tenant-wide roles short-circuit `is_tenant_wide()`. Optional `sort = next_task_asc` uses a LATERAL MIN over the tasks index (bounded by page size after filtering; if EXPLAIN shows it scanning, the lead may cut that sort).

**Edge cases:** E-A31 a TL's team list run by an agent shows only the agent's people; E-A32 a list referencing a deleted lead source id shows "source removed" and matches nothing; E-A33 a definition from a newer client version (`v: 2`) on an older server ⇒ `SMART_LIST_VERSION`; E-A34 an agent loses a lead while paging ⇒ the next page simply omits it (keyset, no offset drift).

**Cut:** OR groups / nested logic, sorting by custom fields, list-level notifications ("tell me when someone enters"), list-based automations, map view, CSV export of a list (contact export stays deferred, Q12).

## 10. Manual activity logging

**Reuse `notes`** (+ columns): `kind` CHECK (`note/logged_call/logged_text/logged_email/stage_change`) DEFAULT `note`; `occurred_at timestamptz NOT NULL DEFAULT now()` (logged: chosen by the user, ≤ now + 5 min, ≥ now − 365 d; CHECK in API, sanity CHECK `occurred_at ≤ created_at + interval '5 min'` in DB); `direction` CHECK (`inbound/outbound`) NULL; `logged_outcome` CHECK (`connected/left_voicemail/no_answer/wrong_number/do_not_contact_request`) NULL. CHECKs: `kind LIKE 'logged_%' ⇒ direction IS NOT NULL`; `logged_outcome ⇒ kind = 'logged_call'`; `kind='stage_change' ⇒ body` is a fixed system sentence and `author_user_id` the editor. Body may be empty for logged items? Keep `length ≥ 1`; the UI pre-fills "Called (outside Realty OS)". Meetings use **appointments** (create + outcome, both existing routes; the UI does both in one sheet).

Why not `messages`/`calls` with an `initiator = 'logged'`: those rows are the dispatch record (status lattice, sender identity CHECKs, guard triggers, touch, failed-send exceptions, the inbox and the opt-out evidence). A self-reported row there would need exemptions in each of them; a note with a kind needs none and is already in the timeline, search, retention, import revert and RLS.

**Rules**
- **R-PAR-41** A logged activity is labelled "Logged by Ben · outside Realty OS" everywhere; it is never shown as a delivered message or recorded call, never pauses automation, never hands back, never counts as a touch (no first-touch, no inactivity reset, no SLA), and never appears in `v_agent_activity_daily` touch counts; the scoreboard may show a separate "logged" column (owner question Q2).
- **R-PAR-42** Logging outcome `do_not_contact_request` (or `wrong_number`) runs the existing path in the same request: person-level do-not-contact (`POST /contacts/:id/do-not-contact`, module 22) or the existing wrong-number point status — never only a note. If that route is not yet shipped, the outcome is not offered (no silent note-only opt-out).
- **R-PAR-43** A logged text/email never stores the client's words as if received (direction inbound is just a label on a note); the assistant treats it as a note (staff-authored), not as client evidence.

**Edge cases:** E-A35 an agent logs a call dated tomorrow ⇒ `OCCURRED_AT_FUTURE`; E-A36 agent logs "they said stop" in free text only ⇒ nothing is blocked; the sheet asks "Did they ask not to be contacted?" with the button (R-PAR-42); E-A37 logged call on a pond card ⇒ 404.

**Cut:** logging attachments, duration fields, logged-email threading/BCC dropbox (FUB has a BCC address VERIFY; Gmail sync is deferred).

## 11. Bulk actions (audited jobs)

**Tables.**
- `bulk_actions` (tenant_id, id, kind CHECK (`tag_add/tag_remove/set_stage/assign/enroll/email/text`), params jsonb (ids and codes only: tag ids, stage key, target user id, playbook version id, template id; no free text), body_snapshot text NULL, subject_snapshot text NULL (email/text: the template as confirmed, so later template edits do not change a running action; plaintext like `messages.body`), source CHECK (`selection/smart_list`), smart_list_id NULL, status CHECK (`previewed/confirmed/running/done/canceled/failed`), counts jsonb {total, done, skipped, failed}, created_by_user_id, created_by_role, confirmed_at, finished_at, created_at). PK (tenant_id, id).
- `bulk_action_items` (tenant_id, bulk_action_id, contact_id, status CHECK (`pending/done/skipped/failed`), reason_code UPPER_SNAKE NULL, message_id NULL, ownership_command_id NULL, updated_at). PK (tenant_id, bulk_action_id, contact_id); FKs composite; contact FK ON DELETE CASCADE; index (tenant_id, bulk_action_id, status).
- `messages.bulk_action_id` NULL (composite FK). `tenant_settings.batch_text_enabled boolean NOT NULL DEFAULT false` (Owner-only trigger, like brokerage identity).

**Flow.** (1) `POST /bulk-actions {kind, params, contactIds[] | smartListId}` resolves the selection **under the caller's RLS** (detail-visible only), snapshots it into items (≤ 5,000; `BULK_TOO_LARGE`), computes a preview (per item: would-skip reasons from the same pure checks: no email, opted out, suppressed, person do-not-contact, already enrolled, not owned by playbook owner, merge field missing) and returns counts; status `previewed`. (2) `POST /bulk-actions/:id/confirm` (one tap; re-auth not required except `assign` > 500 VERIFY) ⇒ `confirmed` + job `bulk.run` (dedupe `bulk:{id}`). (3) The job processes 50 items/tx, resumable, idempotent per item; each item's transaction runs **as the creating user** rebuilt from the row while the membership is active (the precedent: `dispatchOutbound` rebuilding a human sender, `comms/dispatch.ts:17-22`), so RLS and `core.can` re-decide visibility per item at run time; an item no longer visible is `skipped NOT_VISIBLE`. (4) `audit_log` `bulk.confirmed` / `bulk.finished` (kind, counts, ids only); per-item effects audit themselves (ownership ledger + mirror, enrollments, messages).

| Kind | Per item | Capability (Owner/Admin/TL/Agent/ISA/TC) |
|---|---|---|
| tag_add / tag_remove / set_stage | `UPDATE contacts` (trigger canonicalizes) | ✅/✅/T/O/O/— |
| assign | `applyOwnershipCommand(assign|reassign)` with `command_id = derivedCommandId(bulk_id, contact_id)` (idempotent replay) | ✅/✅/T (to team members)/—/—/— |
| enroll | existing enrollment path; approved version only; one live enrollment per contact (skip `ALREADY_ENROLLED`); agent playbook only for contacts its owner owns | ✅/✅/T/O/O/— |
| email | template rendered per recipient (§8) → `composeHumanMessage` (purpose forced `marketing`, `bulk_action_id` set) → `dispatchOutbound` | ✅/✅/T/O/O/— |
| text | same, SMS; only while `batch_text_enabled` | same, and only when the Owner switch is on |

**Rules**
- **R-PAR-44** Every bulk send is one `messages` row per recipient through `dispatchOutbound`; the send-time check (D1 opt-outs, suppressions, person do-not-contact, sender registration, brokerage identity, CAN-SPAM footer) and both DB dispatch guards apply per message with no override and no bulk exemption. An unsubscribe or STOP arriving mid-run blocks the remaining messages at TX1. [DB guard + api test]
- **R-PAR-45** Bulk sends are always `purpose = 'marketing'` (never classified informational), so the brokerage name, postal address and unsubscribe link are always present (existing render), and a marketing-only opt-out always blocks them.
- **R-PAR-46** A bulk message is **not a touch**: `dispatchOutbound` skips the touch when `bulk_action_id IS NOT NULL` (one flagged line, §15), and `v_agent_activity_daily` excludes them; otherwise a mass email could hold every new lead against first-touch and inactivity release.
- **R-PAR-47** Batch text is off by default; only the Owner turns it on (DB trigger, re-auth 🔒, typed attestation stored in `audit_log`); it is limited to 250 recipients per action and to senders with an approved registration whose use case covers marketing (VERIFY with the 10DLC campaign rules); every batch text ends with "Reply STOP to opt out" (renderer adds it if absent). **VERIFY WITH COUNSEL:** state mini-TCPA laws (e.g. Florida FTSA, Oklahoma OTSA, Maryland, Washington — scope, "automated system" definitions, prior express written consent, time-of-day and frequency limits) may treat a batch text as an automated marketing text needing express written consent and quiet hours, which D1 removed from the send gate; the switch's settings page says this plainly and links the counsel register entry. Until counsel answers, the owner should keep it off.
- **R-PAR-48** Bulk actions never create autonomy: an assistant/system actor cannot create or confirm one; `enroll` only enrolls into versions already approved (R-AST rules); bulk never approves drafts.
- **R-PAR-49** The confirm screen states exactly what will happen ("Email 412 people. 37 will be skipped: 21 unsubscribed, 9 no email, 7 do not contact.") and the result reports the same categories ("Sent 398 of 412 · 14 skipped"); skipped/blocked bulk messages do **not** raise `failed_send` exceptions (exclusion in `deriveExceptions`, as R-MKT-8 does for invites; module 18a owns that file → one flagged edit there).
- **R-PAR-50** Cancel stops pending items; done items stay done (no "unsend"); undo for tags/stage is a new bulk action, not a rollback.
- **R-PAR-51** Job payloads hold `{bulkActionId}` only (R-TEN-7); one job is one tenant (R-TEN-6).

**Edge cases**
| # | Case | Handling |
|---|---|---|
| E-A38 | Agent bulk-emails 300; 20 were reassigned away mid-run | Those items `skipped NOT_VISIBLE` (or `SENDER_NOT_AUTHORIZED` at TX1); new owners are not emailed by the old agent |
| E-A39 | Creator is suspended mid-run | Job stops; remaining items `skipped CREATOR_INACTIVE`; action `failed` with a sentence |
| E-A40 | Bulk assign of 200 to an agent at capacity | Ownership engine decides per item; rejections land in `ownership_command_rejections`; items `skipped` with the engine's code |
| E-A41 | Enroll a contact already in another live enrollment | `skipped ALREADY_ENROLLED` (unique live enrollment); never stops the other |
| E-A42 | Recipient replied between preview and send | Not a re-tap case for bulk (no scheduled pin); the send-time check still applies; automation pause does not block humans (as today) — VERIFY with the owner that "replied today" should skip (offer as an option: "Skip people who wrote in the last 24 h", default on) |
| E-A43 | Same person twice in the selection (merged duplicate) | Items keyed by contact; the merged-away one is closed ⇒ `skipped CONTACT_CLOSED`; the dispatch guard also blocks through merge DNC |
| E-A44 | Owner turns batch text off mid-run | Remaining text items `skipped BATCH_TEXT_DISABLED` (re-read per chunk) |
| E-A45 | Worker crash mid-chunk | Chunk tx rolled back; items stay `pending`; messages already `dispatching` follow the existing stale-dispatch sweeper (never re-sent) |
| E-A46 | Spouses sharing an email both selected | Two contacts, two messages to the same address; preview flags "2 people share an address" and offers "send once per address" (default on) |

**Cut:** bulk SMS beyond the Owner switch (and no MMS), scheduling a bulk send for later (v1 sends now; scheduling adds a re-check state), bulk delete/merge/release, bulk calling/power dialer (FUB has one VERIFY; out: TCPA), drip "campaigns" separate from playbooks (use playbooks).

## 12. Extending the FUB import (tags, stages, custom fields)

No new stage category; all inside the existing **contacts** stage (dry run → approve → commit → verify).

| Item | Today | Change |
|---|---|---|
| Tags | `collectTags` → `contacts.tags` | Commit upserts each distinct tag into `tags` (case-insensitive; first spelling wins) **before** the contact chunk writes (trigger needs the catalog); dry run reports new-tag count and `TAG_LIMIT` |
| Stages | fixed word map; unknown ⇒ `new` + `STAGE_UNMAPPED` | Dry run lists distinct FUB stage labels with counts; Admin maps each to one of the 8 keys in `import_batches.options.stageMap` (PUT `/imports/:id/field-mapping`, resets dry runs like the CSV mapping); option `keepStageAsTag` adds tag `FUB: <label>`; the raw label stays in `imported_fields` |
| Custom fields | `custom*` ⇒ `imported_fields` strings | Snapshot also reads FUB's custom-field metadata (`/customFields`; names, types — **VERIFY** endpoint and type names); Admin maps each to a new or existing def (`options.customFieldMap: {fubKey: {defId | create: {label, type, options}}}`); values coerced per type; failures ⇒ issue `CUSTOM_FIELD_UNPARSEABLE`, raw kept; defs over the limit ⇒ the rest stay display-only |
| Relationships | not imported | FUB relationships (VERIFY whether the people API exposes them) imported only when both people are in the batch; else kept in `imported_fields` |
| Revert | deletes untouched imported contacts | Imported `cf_` values cascade with imported contacts; for values written onto **existing** contacts (E41 fill-empty rule) add `contact_attributes.import_record_id NULL` (composite FK) so revert deletes exactly those rows unless edited since; tags the batch created that no contact carries after revert are archived |

**Rules**
- **R-PAR-52** The import never creates stages, never lets a FUB tag act as anything but a tag (except the existing opt-out tag conversion into revocations/suppressions), and never overwrites a value an agent already set on an existing contact (E41 fill-empty rule extended to `cf_` keys).
- **R-PAR-53** Mappings are batch data in `import_batches.options` (no PII: header/field names and target ids); changing a mapping resets uncommitted dry runs (same as `PUT /csv-mapping`).

**Edge cases:** E-A47 two FUB stages map to `nurture` and the team wants them distinct ⇒ `keepStageAsTag`; E-A48 FUB custom field of type "dropdown" with 80 options ⇒ first 50 become options, values outside ⇒ issue + raw kept; E-A49 a FUB tag "Do Not Text" ⇒ existing opt-out reading plus the tag itself (harmless, R-PAR-12).

**Cut:** importing FUB smart lists, templates, action plans (VERIFY FUB API exposes them; they would not map to our approvals model), FUB deals' custom fields.

## 13. Capability matrix additions (DATA_MODEL §3 style)

| Capability (new `Action`) | Owner | Admin | Team Lead | Agent | ISA | TC |
|---|---|---|---|---|---|---|
| `contact.edit` (fields, points, addresses, stage, tags, custom values, relationships) | ✅ | ✅ | T | O | O | — |
| `note.write` (own; mention visible users) | ✅ | ✅ | T + pond detail | O + D | O | D |
| `tag.manage` (rename/merge/color/delete) | ✅ | ✅ | — | — | — | — |
| `custom_field.manage` | ✅ | ✅ | — | — | — | — |
| `template.team_manage` | ✅ | ✅ | — (option) | — | — | — |
| `smart_list.team_manage` | ✅ | ✅ | ✅ | — | — | — |
| `bulk.run` (tag/stage/enroll/email) | ✅ | ✅ | T | O | O | — |
| `bulk.assign` | ✅ | ✅ | T | — | — | — |
| `bulk.text` (also needs the switch) | ✅ | ✅ | T | O | O | — |
| `settings.batch_text` | ✅ 🔒 | — | — | — | — | — |
| `settings.stage_labels` | ✅ | ✅ | — | — | — | — |

## 14. UX: daily jobs, phone and desktop

Contact page gets four new sections registered through a tiny slot list (`surfaces/contact/sections.ts`, §15): **Tags** chips under the name, **Details** (custom fields, addresses, relationships, edit pencil), **Notes** in the timeline with a sticky "Note" button, **Log** button next to Call/Text/Email. A new **People** page (phone tab "People", desktop sidebar) lists smart lists on the left (desktop) or as a top picker (phone); checkboxes on desktop, long-press multi-select on phone; a bottom action bar "Tag · Stage · Assign · Enroll · Email · Text". Global "+" (phone FAB on Feed/People; desktop top-bar button) opens **Add person**.

Tap counts from the app's home screen with the person already open where stated. Typing is not counted. FUB counts are estimates: **all VERIFY** against the current FUB iOS app and web.

| Job | Realty OS phone | Realty OS desktop | FUB (VERIFY) | Notes |
|---|---|---|---|---|
| Add a note (person open) | Note (1) → type → Save (2) = **2** | click in note box (1) → type → ⌘↵ = **1** | ~3 / ~2 | Desktop note box always visible on the contact page |
| @mention a teammate | type `@` + 1 tap on name | same | similar | picker lists only users who can see the person |
| Tag a person (existing tag) | tag chip "+" (1) → type 2 letters → tap tag (2) → Done (3) = **3** | "+" (1) → type → ↵ = **1** | ~4 / ~3 | new tag = same taps, "Create 'x'" row |
| Add a person | + (1) → name, phone → Save (2) = **2** (dup warning adds 1) | + (1) → fill → ↵ = **1** | ~4 / ~3 | stage/tags/source optional, collapsed |
| Edit phone / add email | Details ✎ (1) → field → Save (2) = **2** | inline click-edit (1) → ↵ = **1** | ~3 / ~2 | |
| Change stage | stage pill (1) → stage (2) = **2** | pill (1) → stage (2) = **2** | ~2-3 | |
| Send a template text | Text (1) → Templates (2) → template (3) → Send (4) = **4** | Text (1) → `/` + name → ↵ (2) → Send (3) = **3** | ~4 / ~4 | preview shows footer + "Won't send" reasons before Send |
| Log an outside call | Log (1) → Call (2) → outcome (3) → Save (4) = **4** | Log (1) → Call/outcome (2) → Save (3) = **3** | ~4 / ~3 | time defaults to now; editable |
| Log a meeting | Log (1) → Meeting (2) → outcome (3) → Save (4) = **4** | 3 | ~4 | creates appointment + outcome |
| Open a smart list | People (1) → list (2) = **2** | sidebar list (1) = **1** | ~2 / ~1 | |
| Bulk tag 30 people from a list | People (1) → list (2) → Select all (3) → Tag (4) → tag (5) → Confirm (6) = **6** | list (1) → header checkbox (2) → Tag (3) → tag (4) → Confirm (5) = **5** | ~6 / ~5 | |
| Bulk email from a list | … Select all (3) → Email (4) → template (5) → Review (6) → Confirm (7) = **7** | 6 | ~7 / ~6 | confirm screen shows skip counts by reason |
| Bulk assign | desktop-first; phone same as tag | 5 | ~5 | TL sees only team members as targets |

Honest UI: skipped people are listed by reason, never hidden; batch-text settings show the counsel note; logged items always say "Logged · outside Realty OS"; no dark patterns (no pre-ticked "send to all including unsubscribed" — there is no such option at all).

Accessibility/iOS bar: 44 pt targets, bottom-sheet pickers, swipe-to-dismiss, keyboard-safe Save buttons, VoiceOver labels for chips ("Tag Buyer, remove").

## 15. Build lanes (5, parallel after 0019)

The lead writes `0019_fub_parity.sql` (+ `rls_smoke_parity.sql`, `packages/db/src/schema.ts` members) first. Lanes then run in parallel. Each lane owns its directories; shared registries use the CONVENTIONS §3 additive protocol (`routes.ts`, `worker/handlers/index.ts`, `errors.ts`, `foundation/authz.ts`, `shell/registry.ts`).

| Lane | Owns (new paths) | Depends on | Delivers |
|---|---|---|---|
| **P1 people** | `packages/core/src/parity/people.ts`, `apps/api/src/people/**` (PATCH contact, points, addresses, stage, relationships, `stage_labels` setting), `apps/web/src/surfaces/people-edit/**` (Add person sheet, Details section), `apps/web/src/surfaces/contact/sections.ts` (**new** slot registry, owned by P1) | 0019 | R-PAR-14…22, 27…29 |
| **P2 notes & log** | `packages/core/src/parity/mentions.ts`, `apps/api/src/notes/**` (notes CRUD, mentionable, mention notifications, logged activity, `app.user_sees_contact_detail` definer in a lane migration `0020_parity_mention_definer.sql` — security review), `apps/web/src/surfaces/notes/**` | 0019 | R-PAR-1…6, 41…43 |
| **P3 tags, fields, lists** | `packages/core/src/parity/{tags,customFields,smartList}.ts`, `apps/api/src/lists/**` (tag catalog + rewrite job, custom field defs/values, smart lists + query compiler + count), `apps/web/src/surfaces/people/**` (People page), `apps/web/src/surfaces/admin/parity/**` (tags, fields, stage labels admin) | 0019 | R-PAR-7…13, 23…26, 36…40; exports `resolveSelection(tx, definition)` for P4 |
| **P4 templates & bulk** | `packages/core/src/parity/{merge,bulk}.ts`, `apps/api/src/templates/**`, `apps/api/src/bulk/**` (bulk actions, `bulk.run` handler, batch-text switch), `apps/web/src/surfaces/templates/**`, `apps/web/src/surfaces/bulk/**` | 0019; P3's `resolveSelection` (stub until merged) | R-PAR-30…35, 44…51 |
| **P5 import** | `packages/core/src/import/**`, `apps/api/src/imports/**`, `apps/web/src/surfaces/imports/**` (Phase 1 module files; no Phase 2 owner) | 0019; calls P3's tag/def writers | R-PAR-52, 53 |

**Flagged additive edits in files owned by others** (each minimal; done by the named lane after re-reading the file; reviewed by the owner):

| File (owner) | Lane | Exact edit |
|---|---|---|
| `apps/api/src/comms/dispatch.ts` (module 22) | P4 | in TX1, `touch = ok && … && m.bulkActionId === null` (one condition) |
| `apps/api/src/comms/repos/messages.ts` (module 22) | P4 | select `bulk_action_id` into `MessageRow.bulkActionId` (one column, one field) |
| `apps/api/src/comms/compose.ts` (module 22) | P4 | `ComposeInput.bulkActionId?: string` and `purposeOverride?: 'marketing'`, passed to the insert (two optional fields; no behaviour change when absent) |
| `apps/api/src/comms/render.ts` (comms, 22) | P4 | none: batch-text STOP line is appended by `bulk/` before calling compose |
| `apps/api/src/leads/schemas.ts` + `leads/contacts.ts` (module 22) | P1 | optional `leadSourceId`, `stage`, `tags` on `CreateContactBody`, written in the existing create transaction (R-PAR-17) |
| `apps/api/src/leads/repos/timeline.ts` (module 22) | P2 | map the view's new `note_kind`, `direction`, `logged_outcome` into `TimelineItem.detail` |
| merge code (owner per BUILD_PLAN; `leads/**` ⇒ 22) | P1 | move `contact_relationships` to the survivor in the merge transaction (R-PAR-29) |
| `packages/core/src/priority/**` / accountability `deriveExceptions` (module 18a) | P4 | exclude `messages.bulk_action_id IS NOT NULL` from `failed_send` inputs (one predicate, like R-MKT-8) |
| `apps/web/src/surfaces/compose/ComposeBox.tsx` (module 37) | P4 | one optional prop `onPickTemplate` + a "Templates" button rendering P4's `<TemplatePicker/>`; inserts text, no send logic |
| `apps/web/src/surfaces/thread/**` (module 37) | — | **no edit** |
| `apps/web/src/surfaces/contact/ContactPage.tsx` (Phase 1 web) | P1 | one import + one `<ContactSections/>` element rendering `sections.ts`; P2/P3 add one entry each to `sections.ts` |
| `apps/web/src/surfaces/feed/**` (18a) | — | **no edit** (mentions arrive as notifications, not feed cards) |

Order: 0019 → P1, P2, P3, P5 start together; P4 starts templates at once and bulk once P3 exports `resolveSelection`. Tests per lane: role × route matrix (generated), RLS smoke rows for every new table (each role, cross-tenant, support read-only), dispatch-guard case table unchanged and passing, P4's "bulk send to an opted-out address is blocked by the DB guard even with core bypassed", P3's 250k perf test.

## 16. Owner questions and VERIFY register

| # | Question / item | Default in this draft |
|---|---|---|
| Q1 | Configurable stages? | No: fixed 8 + rename labels + FUB stage as tag |
| Q2 | Should logged outside calls count as touches (inactivity/SLA) or in the scoreboard? | Never a touch; separate "logged" column only |
| Q3 | May Team Leads manage team templates? | No (Owner/Admin) |
| Q4 | Bulk size limits (5,000; text 250) | as stated; VERIFY FUB limits |
| Q5 | Skip people who wrote in the last 24 h in bulk email | option, default on |
| V1 | FUB tap counts, tag/field limits, custom-field API types, relationships API, BCC logging, templates richness | VERIFY |
| C1 | Batch text under state mini-TCPA laws (FL, OK, MD, WA and others), autodialer definitions, quiet hours, frequency | **VERIFY WITH COUNSEL**; switch off by default |
| C2 | Bulk marketing email footer wording (CAN-SPAM) | existing `render.ts` placeholder; **VERIFY WITH COUNSEL** |
| C3 | Protected-class custom fields lexicon | **VERIFY WITH COUNSEL** |

## 17. What this draft cut, in one list

Custom stages and pipelines; tag automations; private notes, note threads and reactions; `note_mentions` table; per-field permissions, required/computed fields, deal custom fields; directional relationships; HTML template builder, attachments, open/click stats, send-as-owner; smart-list OR logic, custom-field sorting, list alerts, list export; scheduled bulk sends, bulk delete/merge/release, power dialer, MMS; logged-activity attachments and BCC dropbox; importing FUB smart lists, templates and action plans. Each cut keeps "fewer concepts" and keeps every send a human tap or an approved playbook step.
