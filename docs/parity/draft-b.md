# FUB parity: design draft B (risk-first)

Independent draft for the lead's merge with draft A. Scope: notes + @mentions, tags, manual add/edit of a person, stages, custom fields, relationships, templates, smart lists, bulk actions, manual activity logging, FUB import extension. Everything in DATA_MODEL Part 1 and Part 2 stays in force; nothing here weakens D1, FORCE RLS / composite keys, `applyOwnershipCommand`, or the autonomy rules. Rule ids `R-PAR-*` and edge ids `E-B*` are provisional (the lead renumbers). **VERIFY** = FUB behaviour I am not sure of; **VERIFY WITH COUNSEL** = legal.

Design stance in one line: every parity feature is a *human* tool that reads and writes under the caller's own RLS, sends only through `dispatchOutbound`, never counts as a touch unless it is a real gate-allowed one-to-one send, and never lets a free-text label (tag, field, template, list) become a back door around opt-outs, visibility or fair housing.

---

## 0. Current state (verified in code)

| Job | State today | Evidence |
|---|---|---|
| Add a person (API) | **Exists**: `POST /contacts`, self-owned via `applyOwnershipCommandInTx({kind:'create',via:'self'})`, dedup with `lockAddresses` + `findByAddress`, `DUPLICATE_CONTACT` names only visible matches (R-PERM-12), `confirmDistinct` records a duplicate candidate. Body: names, ≤ 5 phones, ≤ 5 emails, intent, contactType. No audit row, no lead source, no address, no tags | `apps/api/src/leads/contacts.ts:74-131`, `leads/schemas.ts:71` |
| Add a person (web) | **Missing**: no caller of `POST /contacts` outside `apps/api/src/seed/main.ts` | grep `apps/web/src` |
| Edit a person / points | **Missing**: no `PATCH /contacts/:id`, no point add/remove route | route list (`apps/api/src/**/routes.ts`, `leads/contacts.ts`) |
| Merge two people | Engine exists (R-OWN-24, `packages/core/src/ownership/merge.ts`); **no API/UI** | no merge route |
| Notes | Table + RLS exist (`notes_select/insert/update`, no DELETE grant); notes appear in `contact_timeline` and search; **no notes API or UI** | `0001_init.sql:2011`, `:3207-3216`, `:3849`; `workspace/search.ts` |
| @mentions | **Missing**; `notifications.kind` CHECK has no mention kind; `notifications_insert` is `is_member()` (any member may insert for any user) | `0001_init.sql:2186-2206`, `:3368-3370` |
| Tags | `contacts.tags text[]` + GIN, returned read-only in the contact view; **no tag API/UI, no catalog** (no rename/merge/colour) | `0001_init.sql:713`, `leads/repos/contacts.ts:41,63`, `leads/views.ts:105` |
| Stages | Fixed 8-value CHECK; engine depends on it (inactivity release only for `new/attempting`, R-OWN-23); **no stage edit route** | `0001_init.sql` contacts; DATA_MODEL R-OWN-23 |
| Custom fields | **Missing**; FUB/CSV custom values land in display-only `imported_fields` | `packages/core/src/import/fub.ts:251-263`, `csv.ts:16` |
| Relationships | **Missing** | — |
| Templates | **Missing** for human sends (playbook templates in `assistant/templates.ts` are a different, approval-bound thing) | — |
| Smart lists | **Missing** (only `GET /search`) | `workspace/routes.ts:268` |
| Bulk actions | **Missing** (Phase 1 cut bulk SMS; Phase 2 open-house invites are the only per-recipient batch, R-MKT-8) | PHASE2_3_PLAN §3 |
| Manual activity log | **Missing** (only `POST /calls/:id/outcome` for platform calls; appointments can be created) | `comms/routes.ts:158`, `workspace/routes.ts:101` |
| FUB import of tags/stages/custom | **Brief is partly wrong**: FUB import already brings **tags** (`collectTags` → `contacts.tags`, ≤ 100, case-insensitive dedupe; E41 fill adds new tags), maps **stage** labels onto the 8 fixed stages (`mapStage`, unknown ⇒ `new` + issue, original kept as `imported_fields['FUB stage']`), and keeps every `custom*` field as display-only `imported_fields`. A FUB tag that reads "DNC"/"Opted out"/"Unsubscribed" already becomes an opt-out (`TAG_READ_AS_OPT_OUT`) | `core/import/fub.ts:247-263, 330-350`, `apps/api/src/imports/repos/writes.ts:31-41` |
| Send path | `composeHumanMessage` → `renderHumanBody` (brokerage footer; marketing email gets unsubscribe URL + RFC 8058 headers) → `dispatchOutbound` TX1 (`canContact`, guard, **touch for owner/collaborator**) | `comms/compose.ts:144-222`, `comms/render.ts:54-64`, `comms/dispatch.ts:157-210` |
| Email body | Plain text only (inbound stored as text; outbound body is text; `providers/types.ts` has an optional `html` nobody sets) | SECURITY.md §2.3, `comms/render.ts` |
| Guard "other phones" | `messages_dispatch_guard` / `calls_dispatch_guard` compute the contact's other phones with **`removed_at IS NULL`**: removing an opted-out phone un-blocks texting the person's other phones (see R-PAR-12) | `0018_phase2_3_schema.sql:404-409, 490` |
| Activity views | `v_agent_activity_daily` counts every non-imported human outbound message as a touch; `contact_timeline` takes notes at `created_at` | `0001_init.sql:3849-3920` |
| Support writes | statement trigger `support_read_only` on every table (0016), re-attached for new tables by the idempotent DO block at the end of 0018; every 0019 table needs it (invariant test `rule_coverage_0016.test.ts`) | `0016_rule_coverage.sql:62-86`, `0018…sql:2096-2110` |

---

## 1. Hazard register (what this design is built around)

| # | Hazard | Where it bites | Control (rule) |
|---|---|---|---|
| H1 | A mention leaks a contact's name or note text to someone who cannot see the contact | notes | delivery decided **as the mentioned user** under their own RLS; notification carries no note text (R-PAR-2, -3) |
| H2 | Removing / editing an opted-out phone or email makes the person reachable again | points | addresses immutable; removed points still count for the SMS fan-out; HMAC opt-outs untouched (R-PAR-11, -12) |
| H3 | A "DNC" tag looks like an opt-out but blocks nothing (or removing it looks like a lift) | tags | tags never affect sending; DNC-looking tag prompts a real do-not-contact (R-PAR-7) |
| H4 | A tag or custom field becomes a protected-class proxy used to target or exclude people | tags, fields, lists, bulk | proxy classification (lexicon + manual, tighten-only); proxy-referencing lists cannot drive bulk marketing or enrollment (R-PAR-8, -16, -24) **VERIFY WITH COUNSEL** |
| H5 | Template merge fields inject markup/headers, read another contact, or read hidden fields | templates | closed field set, single-contact context built under sender RLS, text-only output, CR/LF stripped in subject (R-PAR-19, -20) |
| H6 | A smart-list definition becomes SQL injection or a visibility bypass | lists | Zod AST in core, whitelisted fragments, bound parameters only, executed in the caller's `withTenantTx` (R-PAR-21, -22) |
| H7 | Bulk email/text fakes activity: resets inactivity, satisfies speed-to-lead, inflates scoreboards | bulk | `messages.bulk_job_id`; dispatch writes no touch; views exclude bulk (R-PAR-27) |
| H8 | Bulk text exposure under state mini-TCPA laws (FL FTSA "automated system for the selection or dialing", time-of-day, frequency) with D1 (no consent check) | bulk SMS | Owner switch off by default, re-auth + attestation, small caps, STOP hint (R-PAR-30) **VERIFY WITH COUNSEL** |
| H9 | Bulk assign floods notifications / SLAs, or bypasses the engine | bulk | one ownership command per contact, same rules as a single reassign (no SLA, R-OWN-18), one summary notice (R-PAR-28) |
| H10 | Logged outside activity fakes speed-to-lead or keeps a hoarded lead from release | activity | logged activity is a note: never a touch, never clears an exception, shown "logged by agent, not verified" (R-PAR-33) |
| H11 | Stage edits game the inactivity release (move untouched `new` leads to `nurture`) | stages | leaving `new/attempting` without a human touch in the period is refused for Agent/ISA (R-PAR-14) |
| H12 | Relationship rows reveal a person the viewer cannot see | relationships | row visible only when both contacts are detail-visible (R-PAR-18) |
| H13 | Shared (team) lists/templates leak PII typed by their author, or let an Admin silently change what agents send | lists, templates | no free-text PII clauses in team lists; templates never used by playbooks; bulk freezes template content (R-PAR-20, -23, -26) |
| H14 | Erasure / purge misses new contact-scoped rows | all | every contact child cascades; the one append-only child is deleted explicitly by the purge definer (R-PAR-35) |

---

## 2. Notes API and @mentions

### 2.1 Tables

| Table / change | Columns | Constraints | RLS |
|---|---|---|---|
| `notes` (changed) | + `edited_at`, + `activity_kind` (`call/text/email/meeting_outside/other`), `activity_direction` (`outbound/inbound`), `activity_at`, `activity_outcome` (`connected/left_message/no_answer/wrong_number/other`, calls only); `source` + `logged_activity` | `source='logged_activity'` ⇔ `activity_kind` and `activity_at` set; `activity_at` ≤ `created_at + 5 min` and ≥ `created_at − 30 d`; imported notes never `logged_activity` | unchanged select/insert/update; **new `notes_delete`**: author of a non-imported note, or tenant-wide; `GRANT DELETE ON notes` |
| `note_mentions` (new) | (tenant_id, note_id, user_id) PK, status (`pending/notified/no_access/self/inactive`), notification_id, resolved_at, created_at | FK `(tenant_id,note_id)` → notes ON DELETE CASCADE; FK user → memberships; ≤ 10 per note (trigger) | select: the note is visible (EXISTS through `notes` RLS) — **not** "mentioned = me" (a user who lost the contact must not read the row); insert: note author as self; update: system only |
| `notifications.kind` | + `mention` | — | unchanged |
| `contact_timeline` (replaced view) | notes row uses `COALESCE(activity_at, created_at)` and `detail = source || ':' || coalesce(activity_kind,'')` | security_invoker kept | unchanged |

### 2.2 API (`apps/api/src/people/notes.ts`)

`POST /contacts/:id/notes` · `POST /deals/:id/notes` · `PATCH /notes/:id` (author only; body, pinned) · `DELETE /notes/:id` · `GET /contacts/:id/notes?cursor` (the timeline already lists them; this is for the Notes tab and pinned first). Body ≤ 20,000 (existing CHECK). Mentions are sent as `mentions: userId[]`; the body carries plain `@Display Name` text (no markup is parsed back out of the body: the id list is the truth).

### 2.3 Mention delivery (H1)

1. In the note's transaction: insert `note_mentions` (status `pending`, or `self`) and enqueue job `notes.mention {noteId, userId}` (ids only, R-TEN-7).
2. The job rebuilds **the mentioned user as the actor** (active membership required, exactly as `dispatchOutbound` rebuilds a human sender for a scheduled send) and, in that user's `withTenantTx`, checks `contact_detail_visible` (or `deal_visible` for deal notes). No new definer: visibility is decided by the same RLS that will serve the note.
3. Visible ⇒ insert the notification as that user (`kind='mention'`, `priority='normal'`, dedupe `mention:{note}`), title per `notification_detail`: `"Pat mentioned you · Jane D."` or `"Pat mentioned you"`; **body is never the note text** (lock-screen rule, ARCHITECTURE §12). Status `notified`.
4. Not visible ⇒ status `no_access`, no notification. The author (who can see the contact) sees "Sam can't see this contact, so they weren't told" with **Share** (adds a `contact_collaborators` row; only Owner/Admin/TL or the contact owner may, existing RLS; audited `collaborator.add`). A mention never grants access.
5. Later visibility loss: the notification row stays (PII-minimized, 90-day retention as every kind); opening it resolves `/contacts/:id#note-:id` under current RLS ⇒ 404 ⇒ "You no longer have access to this person." No note text was ever copied out. Optional (lead decides): on `reassigned_away`/collaborator removal, mark that user's unread `mention` notifications read.
6. Edits that add mentions notify only the new ids; edits never re-notify. Imported notes are never parsed for mentions (R-IMPORT-6).

### 2.4 Rules

- **R-PAR-1** Notes are readable by exactly whoever sees the contact's detail (or the deal); there are no private notes. The UI says "Everyone who can see Jane can read this note." (FUB private notes: **VERIFY**.)
- **R-PAR-2** A mention notifies a user only if, at delivery, that user's own RLS shows the note's contact (deal); the check runs as that user. A mention never adds access. [api + job test]
- **R-PAR-3** A mention notification never contains note text; its title holds at most the contact's first name + initial (tenant `notification_detail`). [api + snapshot test]
- **R-PAR-4** Only the author edits a note; author or tenant-wide deletes it (hard delete, audited `note.delete`, diff `{changed:true}`); imported notes are deleted only by tenant-wide. A deleted note's evidence refs read `source_available = false`. [DB + api]
- **R-PAR-5** Notes, including logged activities and mentions, never count as a touch (R-OWN-14 unchanged). [core + view test]

---

## 3. Tags

### 3.1 Tables (single source of truth)

| Table / change | Columns | Constraints | RLS |
|---|---|---|---|
| `tags` (new) | (tenant_id, id) PK, name (≤ 64, trimmed), name_key (= lower(NFKC(name)), UQ per tenant), color (nullable; one of 12 token names, not free hex), sensitivity (`normal/protected_proxy`), sensitivity_source (`lexicon/manual`), created_by_user_id, created_at, updated_at | ≤ 500 tags per tenant (trigger); `protected_proxy` never goes back to `normal` once `lexicon` (trigger: tighten-only, R-PAR-8) | select: members; insert: members except TC; update/delete (rename, colour, merge, protect): Owner/Admin |
| `contact_tags` (new) | (tenant_id, contact_id, tag_id) PK, added_by_kind (`user/import/bulk`), added_by_user_id, bulk_job_id, import_batch_id, created_at | composite FKs; contact ON DELETE CASCADE; tag ON DELETE CASCADE; index `(tenant_id, tag_id, contact_id)`; ≤ 100 tags per contact (trigger) | select: `contact_detail_visible`; insert/delete: detail-visible **and** not TC (unless tenant-wide); `GRANT SELECT, INSERT, DELETE` |
| `contacts.tags` (retired) | backfilled into `tags` + `contact_tags` by 0019 (case-insensitive, first spelling wins); then a trigger refuses any non-empty write; readers switched (`leads/repos/contacts.ts`, `leads/views.ts`, `imports/repos/{writes,existing,revert}.ts`, web `feed/lib/types.ts`); column dropped one release later | — | — |

Why normalize instead of keeping `text[]`: rename/merge on an array means rewriting up to 250k `contacts` rows (each a guarded row with `updated_at`, search vectors and import-revert fingerprints); a catalog row makes rename one UPDATE, gives colours and protection a home, and lets list filters use a btree on `(tenant_id, tag_id, contact_id)`. Cost: two writers of tags (contacts stage of imports, people API) must move at once; listed in §11.

### 3.2 Operations

| Op | Who | Mechanics | Audit |
|---|---|---|---|
| Add tag to person | owner/collab/TL/Admin (not TC) | upsert `tags` by `name_key` (create if allowed), insert link | none (not a sensitive action; bulk is audited at job level) |
| Remove tag | same | delete link | none |
| Rename | Owner/Admin | update `name` (+`name_key`); refuse if it collides (offer merge) | `tag.rename` (names are labels, not PII: `{from,to}`) |
| Merge A → B | Owner/Admin | one tx: `INSERT … SELECT … ON CONFLICT DO NOTHING` links of A as B, delete A; smart lists referencing A rewritten to B in the same tx; B inherits the stricter sensitivity | `tag.merge` with counts |
| Delete | Owner/Admin | cascades links; lists referencing it become "1 filter refers to a deleted tag" (matches nothing) | `tag.delete` with link count |
| Protect | Owner/Admin | `sensitivity = protected_proxy` (manual); unprotect only if `sensitivity_source = manual` and Owner | `tag.protect/unprotect` |

### 3.3 Rules

- **R-PAR-6** Tag names are unique per tenant case- and width-insensitively (`name_key`); display keeps the first spelling. [DB UQ + core normalizer test]
- **R-PAR-7** No tag changes whether anyone can be contacted. Adding a tag whose name matches the import's opt-out patterns (`TAG_DNC`, `TAG_OPT_OUT`, `TAG_UNSUB` in `core/import/fub.ts`) shows "Tags don't stop messages. Record 'do not contact' for Jane?" (one tap → the existing person-level do-not-contact path). Removing such a tag never lifts anything (opt-outs are HMAC- or person-keyed, R-CONSENT-1, R-CHAN-2). [core + web test]
- **R-PAR-8** A tag (or custom field) whose name matches the fair-housing protected-proxy lexicon (`core/fairhousing`, module 20; e.g. military, VA, Section 8, disability, religion, national origin, familial status, source of income, language) is `protected_proxy` (source `lexicon`, never downgraded). Owner/Admin may protect any tag (tighten-only). Protected tags work for viewing and one-to-one work and are hidden from pond cards; they can never define a bulk-marketing or enrollment audience (R-PAR-24). **VERIFY WITH COUNSEL** (which proxies, per state, e.g. military status). [core + DB trigger]

---

## 4. Manual add / edit of a person

### 4.1 API (`apps/api/src/people/contacts.ts`; reuses `leads/` functions by import, no edit of `leads/**`)

| Route | Notes |
|---|---|
| `POST /contacts` (exists) | web gains the form. Extensions (flagged edit by module 22 or a parity wrapper route `POST /people`): optional `leadSourceId` (attribution set at birth only; immutable after), `tags[]`, `fields{}`, `address`; Owner/Admin/TL "create for" = create self-owned then one `assign` command in the same request (two ledger events; R-OWN-19 + R-OWN-18; no SLA). Audit `contact.create` (new; names `{changed:true}`). |
| `PATCH /contacts/:id` | `row_version`-checked. Editable: first/last/display name, contact_type, intent, timezone (+source `explicit`), `pond_summary` (owner/TL only), stage (R-PAR-14). Never: projection, attribution, merged_into, deleted_at (DB guard already refuses projection/attribution). Audit `contact.update` (PII fields `{changed:true}`, stage/type/intent `{from,to}`). |
| `POST /contacts/:id/points` | add phone/email: normalize in core → `lockAddresses` → `findByAddress` → the same `DUPLICATE_CONTACT` / `confirmDistinct` flow as create (R-OWN-25, R-PERM-12); shows "This number opted out of texts" at once when its HMAC is revoked (R-CONSENT-1). Audit `contact_point.add`. |
| `POST /contact-points/:id/remove` | `{reason: typo/not_theirs/replaced/old/duplicate}`; sets `status='removed'`, `removed_at`, `removed_reason`. Audit `contact_point.remove`. |
| `POST /contact-points/:id/primary`, `PATCH /contact-points/:id` | label, primary, explicit timezone only. **Address is never edited**: "edit number" in the UI is remove + add (R-PAR-11). |
| `PUT /contacts/:id/addresses/:aid?` | `contact_addresses` CRUD (jurisdiction recomputed in core). |

### 4.2 Schema changes

| Change | Detail |
|---|---|
| `contact_points.removed_reason` | `typo/not_theirs/replaced/old/duplicate/wrong_number_reply` (last: system only, set by R-CONSENT-11 handling); `removed` ⇔ reason |
| trigger `contact_points_immutable` | `contact_id`, `kind`, `address`, `address_hmac` never change; a removed point is never un-removed (re-adding is a new row, which is impossible while the UQ `(contact,kind,address)` row exists ⇒ re-add = `restore` op that clears `removed_*`, allowed only for agent-chosen reasons) |
| both dispatch guards (replaced) | `others` = the contact's points of that kind **including removed ones**, except `removed_reason = 'wrong_number_reply'` |
| core `canContact` input | `GateInput` "other phones" built the same way (shared case table `opt_out_cases.json` gets the cases) |

### 4.3 Rules

- **R-PAR-9** Manual create and point add dedup exactly as intake (lock per HMAC in sorted order, exact match ⇒ `DUPLICATE_CONTACT` unless `confirmDistinct`, which records a duplicate candidate); a match the caller cannot see reveals only its owner's display name. [api + concurrency test]
- **R-PAR-10** Editing a person never changes ownership; ownership moves only by `applyOwnershipCommand` (existing guard). [DB]
- **R-PAR-11** A contact point's address, kind, HMAC and contact never change; "editing" a phone/email is remove + add. Consent, suppressions and opt-outs stay keyed by HMAC, so the old address keeps its opt-out forever and the new one starts with whatever its own HMAC already carries. [DB trigger + smoke]
- **R-PAR-12** Removing a point never un-blocks the person: the SMS (and DM) "any of the contact's points" fan-out and the voice "any phone" check include removed points, except a point the system removed after a wrong-number reply. Over-blocking is accepted: the UI says "Texting Jane is blocked because a number you removed (•••1234) opted out; she can text START from it." [DB guards + core + smoke] (Today's guards filter `removed_at IS NULL`: this is a **live gap**, fix in 0019 regardless of parity.)
- **R-PAR-13** A point never moves between contacts (merge re-points via the engine only). [DB trigger]

---

## 5. Stages

Decision: **no tenant-defined stages.** The 8 stages carry engine semantics (R-OWN-23 inactivity release only for `new/attempting`; CSV/FUB mapping; reports). Tenants get **display labels** for the 8 (FUB teams rename "Active" to "Hot", etc.) and may hide `attempting` from pickers. FUB custom stages (**VERIFY** that FUB allows them) map on import to a fixed stage plus a tag `FUB stage: <name>`, so nothing is lost.

| Change | Detail | Who |
|---|---|---|
| `tenant_settings.stage_labels jsonb` | `{stage: label ≤ 24}` for any of the 8; validated in core; settings diff audited | Owner/Admin |
| `contact_stage_events` [AO] (new) | (tenant_id, id) PK, contact_id (FK cascade), from_stage, to_stage, actor_kind, actor_user_id, occurred_at; written by trigger on `contacts.stage` change (as `deal_stage_history`); feeds the timeline and "time in stage" | system (trigger) |
| `contact_timeline` | + stage events | — |

- **R-PAR-14** An Agent or ISA cannot move a contact out of `new` or `attempting` to any stage other than `lost` while the current ownership period has no human touch (`first_touch_at IS NULL`): `STAGE_NEEDS_CONTACT` ("Reach them first, or mark lost"). TL/Owner/Admin may (audited). Moving to `lost` is allowed (it does not shelter a lead: closing is an ownership command, separate). This stops hoarding untouched leads in `nurture` past the inactivity release. [core + DB trigger]
- **R-PAR-15** Stage changes are append-only history (`contact_stage_events`) and audited `contact.stage_change` `{from,to}`. [DB]

---

## 6. Custom fields

### 6.1 Tables

| Table | Columns | Constraints | RLS |
|---|---|---|---|
| `custom_field_defs` | (tenant_id, id) PK, key (`^[a-z][a-z0-9_]{1,40}$`, UQ), label (≤ 60), type (`text/long_text/number/currency_cents/date/boolean/select/multi_select/url`), options jsonb (`[{id,label}]` ≤ 100, select types only), sensitivity (`normal/protected_proxy`), sensitivity_source, position, archived_at, origin (`manual/fub_import/csv_import`), created_by_user_id | ≤ 50 active per tenant (trigger; FUB limit **VERIFY**); key never changes; type never changes once a value exists; **key ∉ the `contact_attributes` protected key list** (`military_status`, `va_loan_interest`, … CHECK reused): "Use the built-in field"; protected tighten-only | select: members; write: Owner/Admin |
| `contact_field_values` | (tenant_id, contact_id, field_id) PK, value_text (≤ 1,000; long_text ≤ 5,000), value_num numeric, value_date date, value_bool, value_option_ids text[], self_reported bool, updated_by_user_id, updated_at, import_batch_id | trigger: exactly the column of the def's type is set, options ⊆ def options; **def protected ⇒ `self_reported`** (mirrors `contact_attributes`); contact cascade | select: `contact_detail_visible`; write: detail-visible, not TC (unless tenant-wide) |
| indexes | `(tenant_id, field_id, value_num)`, `(tenant_id, field_id, value_date)`, `(tenant_id, field_id, lower(value_text))`, GIN `(value_option_ids)` | — | — |

Why not store values in `contact_attributes`: that table is the assistant's evidence-backed fact store (`evidence_claim_id`, R-AST-12); mixing typed, agent-edited values into it changes its meaning and indexing. The protected-proxy *rules* are copied instead (key list CHECK, self-reported CHECK). Lead may choose the opposite to save a table.

### 6.2 Rules

- **R-PAR-16** A custom field cannot recreate a known protected attribute (key list CHECK), is `protected_proxy` when its key/label hits the lexicon (R-PAR-8 semantics), and a protected field's values must be self-reported (the person told us). Protected fields are excluded from: assistant prompts and drafts, merge fields, bulk-marketing and enrollment audiences, pond cards, and the default list columns. **VERIFY WITH COUNSEL.** [DB + core]
- **R-PAR-17** Values are typed and validated in core (`validateFieldValue(def, raw)`); an archived def keeps its values read-only; deleting a def is not offered (archive only; values purge with the contact). [core + DB]

Import mapping: §10.

---

## 7. Relationships

| Table | Columns | Constraints | RLS |
|---|---|---|---|
| `contact_relationships` | (tenant_id, id) PK, contact_id, related_contact_id, kind (`spouse/partner/co_buyer/co_seller/family/referred_by/other`), label (≤ 40, `other` only), created_by_user_id, created_at | contact ≠ related; UQ on (tenant, least, greatest, kind); both FKs cascade; symmetric kinds stored once, `referred_by` directional | select: **both** contacts `contact_detail_visible`; insert/delete: same + not TC |

- **R-PAR-18** A relationship is shown only to someone who sees both people's detail; otherwise it does not exist for them (no "1 hidden relationship" count). Adding one needs both visible. It grants no access, merges nothing, and moves no opt-out (shared addresses already share HMAC opt-outs; a person-level do-not-contact stays per person). [DB + smoke]
- FUB relationships (spouse name/phone/email on the person, **VERIFY** the FUB shape) import as `imported_fields` text only: **their phones/emails never become contact points** (we would be messaging someone who never inquired and whose opt-out we cannot read). An agent can create the spouse as a person by hand (dedup + R-PAR-9).

---

## 8. Templates (email + text, personal + team)

### 8.1 Table

| Table | Columns | Constraints | RLS |
|---|---|---|---|
| `message_templates` | (tenant_id, id) PK, scope (`team/personal`), owner_user_id (personal ⇔ set), channel (`sms/email`), name (≤ 80, UQ per scope+owner), subject (email, ≤ 200), body (sms ≤ 1,600; email ≤ 20,000), version int (bumped on edit), merge_fields text[] (parsed by core, stored), guard jsonb (fair-housing + payment-pattern result over this version), archived_at, updated_by_user_id | `guard.version = version` (as `marketing_pieces`); a hard fair-housing match or payment pattern ⇒ refused | select: team ⇒ members; personal ⇒ owner or tenant-wide; write: team ⇒ **Owner/Admin**; personal ⇒ owner |
| `messages` (changed) | + `template_id`, `template_version` (provenance only, nullable) | — | — |

### 8.2 Merge-field rendering (core `renderTemplate`, pure)

- Syntax `{{field}}` or `{{field|fallback}}`; no logic, loops, filters, partials or nested paths. Parsed at save; an unknown field is a save error.
- Closed field set: `contact.first_name`, `contact.last_name`, `contact.display_name`, `agent.first_name`, `agent.last_name`, `agent.phone` (the sender's own `agent_direct` number), `agent.email` (sender's identity), `team.name`, `brokerage.name`, `deal.address` / `listing.address` (only from a deal/listing the send is composed from), `field.<key>` for **non-protected** custom fields.
- Context: one `TemplateContext` built server-side for **one** contact, read in the sender's own `withTenantTx` (so a field the sender cannot see is absent, never fetched by definer); no field takes an id from the template.
- Output is **plain text** (the email path is text-only): values are inserted verbatim as text; control characters stripped; **subject values have CR/LF removed** (header injection); a URL value renders only if `safeUrl` accepts it. The web shows the rendered text via React text, never HTML.
- A field with no value and no fallback ⇒ `MERGE_FIELD_EMPTY` for that recipient (no "Hi ,"). In bulk, that item is `skipped` with the reason.
- The rendered text then goes through `renderHumanBody` (brokerage footer; marketing unsubscribe) and the send-time gate as any human message.

### 8.3 Rules

- **R-PAR-19** Template rendering reads exactly one contact, under the sender's RLS, from a closed field list; protected-proxy fields are never merge fields. [core property test: rendering never emits a value not in the context; api test: invisible field ⇒ absent]
- **R-PAR-20** Templates are human-send aids only: a playbook step never references a template (playbook content stays hash-bound to its approval, R-AST); editing a team template changes no approved content and no queued message (bulk freezes the rendered source, R-PAR-26). [core + architecture test]
- **R-PAR-21a** A template whose current version has a hard fair-housing match or a payment-instruction pattern cannot be saved; a soft match is saved with "Check this" and cannot be used for bulk. **VERIFY WITH COUNSEL.** [core + DB CHECK on `guard`]
- **R-PAR-21b** Brokerage identity is not a template's job: the send path adds it (R-GATE-12); a template cannot remove or override the footer.

Who edits team templates: Owner/Admin (FUB lets admins share templates; whether brokers/TLs can, **VERIFY**). TLs copy a team template to personal and edit that.

---

## 9. Smart lists

### 9.1 Table

| Table | Columns | Constraints | RLS |
|---|---|---|---|
| `smart_lists` | (tenant_id, id) PK, scope (`personal/team`), owner_user_id, name (≤ 80), definition jsonb, definition_version (schema version), sort (`{field, dir}`), ref_tag_ids uuid[], ref_field_ids uuid[] (computed by core at save, used by the protected-audience check), uses_protected bool (computed), position, archived_at | definition ≤ 8 KB; refs ⊆ tenant (trigger) | select: team ⇒ members; personal ⇒ owner (+tenant-wide); write: personal ⇒ owner; team ⇒ Owner/Admin/TL |

### 9.2 Definition schema (core `SmartListDefinition`, Zod)

`{ v: 1, all: Clause[] (≤ 20), any?: Clause[] (≤ 10, one OR group) }`, `Clause = {field, op, value}` from a whitelist:

| Field | Ops | Notes |
|---|---|---|
| `stage`, `contact_type`, `intent`, `ownership_state` | in / not_in | enum values only |
| `owner` | is `me` / user ids / `unassigned` / `pond:<id>` | `me` resolves per viewer at run time |
| `tag` | has_any / has_all / has_none | tag ids |
| `lead_source` | in | ids |
| `created_at`, `last_human_touch_at`, `last_inbound_at`, `first_touch_at` | before / after / within_days / never | — |
| `has_phone`, `has_email`, `do_not_contact`, `texting_blocked` | is true/false | computed through HMAC joins (reads opt-out state, never sets it) |
| `field.<id>` | by type: eq/in/range/before/after/is_empty | non-archived defs |
| `postal_code`, `city` (contact_addresses) | in | allowed for viewing; R-FH-4 forbids geography only for ads |
| `name_contains` | contains | **personal lists only** (H13) |

### 9.3 Compilation and execution

- Core compiles the definition into a typed plan (no SQL). `apps/api/src/lists/compile.ts` maps each plan node to a **fixed Kysely fragment** with bound values; there is no `sql.raw` with user input (lint rule `realty/no-raw-sql-in-lists` + test that fuzzes definitions and asserts every value travels as a parameter).
- Executed in the caller's `withTenantTx` against `contacts` (FORCE RLS): a shared team list shows each viewer only rows their policy admits; counts are per viewer. Detail-only predicates (tags, fields, points, `texting_blocked`) are `EXISTS` subqueries on RLS'd tables, so a pond/offer card row cannot be filtered by data the viewer cannot see (a card-only viewer simply gets no match on detail predicates).
- Keyset pagination on `(sort key, id)`, 50 per page; count exact up to 10,000 then "10,000+"; `statement_timeout` 3 s for list queries (`LIST_TOO_SLOW` with "narrow the filter").
- Indexes (0019): contacts partial indexes `WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL` on `(tenant_id, owner_user_id, stage)`, `(tenant_id, stage, last_human_touch_at)`, `(tenant_id, created_at)`, `(tenant_id, original_lead_source_id)`; `contact_tags (tenant_id, tag_id, contact_id)`; field value indexes (§6). Budget: **p95 ≤ 400 ms first page, ≤ 800 ms with count, at 250k contacts / 500 tags / 1M tag links / 2M field values**, for Owner (tenant-wide) and for an Agent owning 2k (RLS OR-branches), measured by a seeded perf test in CI (as the feed's p95 test). The RLS central rule's OR is the risk: if the Agent plan degrades, the lead may add a `my_visible_contact_ids()`-style invoker CTE, never a definer.

### 9.4 Rules

- **R-PAR-21** List definitions are validated in core and compiled only to parameterized SQL from whitelisted fragments. [core + api fuzz test + lint]
- **R-PAR-22** A list runs under the viewer's RLS; sharing a list shares the definition, never rows. [api + smoke-style test: TL list viewed by an agent returns only the agent's contacts]
- **R-PAR-23** Team lists carry no free-text clauses (no names/phones/emails typed into a shared definition). [core]
- **R-PAR-24** A list whose definition references a protected-proxy tag or field (`uses_protected`, recomputed at bulk confirm from the current tag/field sensitivity) can be viewed but cannot be the audience of bulk email, bulk text or bulk enrollment: `AUDIENCE_PROTECTED_PROXY`, no override. **VERIFY WITH COUNSEL.** [core + api]

---

## 10. Bulk actions (audited jobs)

### 10.1 Tables

| Table | Columns | Constraints | RLS |
|---|---|---|---|
| `bulk_jobs` | (tenant_id, id) PK, kind (`tag/untag/assign/enroll/email/sms/stage`), created_by_user_id, created_by_role, status (`draft/confirmed/running/completed/canceled/failed`), source (`list/selection`), smart_list_id, definition_sha256 (of the definition as run), params jsonb (**ids and codes only**: tag_id, to_user_id, playbook_version_id, template_id + template_version, stage), content_snapshot (subject/body source frozen at confirm, email/sms only), target_count, counts jsonb (done/skipped/blocked/failed/canceled), idempotency_key (UQ per tenant), confirmed_at, started_at, finished_at, cancel_requested_at/by | draft→confirmed only by creator as self; content frozen after confirm (trigger); `sms` ⇒ tenant `bulk_sms_enabled` at insert **and** at every item (guard) | select: creator, tenant-wide, TL of creator; insert/confirm/cancel: creator (cancel also tenant-wide); counts: system |
| `bulk_job_items` | (tenant_id, job_id, contact_id) PK, status (`pending/done/skipped/blocked/failed/canceled`), reason_code, message_id, address_hmac (email/sms dedupe), processed_at | UQ `(tenant_id, job_id, address_hmac)` where not null (one send per address per job); FK contact ON DELETE CASCADE | select: via job **and** contact visible to the reader; write: system |
| `messages` (changed) | + `bulk_job_id` (composite FK) | `bulk_job_id` ⇒ `initiator='human'` and `purpose='marketing'` | — |
| `tenant_settings` (changed) | + `bulk_sms_enabled` (false), `bulk_sms_attestation` (text), `bulk_email_daily_cap` (2,000) | trigger: enabling bulk SMS is Owner-only, needs re-auth (api) and an attestation; Admin may only turn it off or lower the cap | — |

### 10.2 Lifecycle

```
draft    POST /bulk-jobs {kind, source, params}            (creator; no side effects)
preview  GET  /bulk-jobs/:id/preview                       count + first 20 under the creator's RLS, per-item precheck:
         opted out / no point / do not contact / already enrolled / not yours; email: rendered sample, footer, unsubscribe
confirm  POST /bulk-jobs/:id/confirm {expectedCount}        ONE tx, creator's RLS: materialize items (frozen set), refuse if
         count ≠ expectedCount ± 0 (BULK_TARGET_CHANGED → re-preview), refuse over cap, recompute AUDIENCE_PROTECTED_PROXY,
         freeze content, audit bulk_job.confirm {kind,count,list id,definition hash}
run      worker job bulk.run {jobId} → chunks of 50 items, ONE TX PER ITEM, actor = the creator rebuilt from the job row
         (active membership, current role re-checked by can() per chunk) — as dispatchOutbound rebuilds a human sender
cancel   POST /bulk-jobs/:id/cancel → cancel_requested_at; the runner stops before the next item; pending → canceled;
         email/sms items already queued but not dispatching → message canceled (messages/:id/cancel path)
done     counts + one summary notification to the creator ("Emailed 398 of 412: 9 opted out, 5 no email")
```

Frozen vs re-evaluated: **frozen at confirm** (the person confirmed "412 people"; a list that grows mid-run must not send to people nobody saw). Each item still re-checks, at its own transaction: the contact is still visible to the creator and not deleted/merged (else `skipped NOT_VISIBLE` / `MERGED`: merges are not followed, the survivor may already be in the set), the action's eligibility, and for sends the full send-time gate. Nothing is re-filtered by the definition.

### 10.3 Per-kind behaviour

| Kind | Item transaction | Who may run (on contacts their RLS lets them write) | Cap per job |
|---|---|---|---|
| tag / untag | insert/delete `contact_tags` (`added_by_kind='bulk'`, `bulk_job_id`) | Owner, Admin, TL (team), Agent (own), ISA (own); TC — | 10,000 |
| stage | `PATCH` semantics incl. R-PAR-14 per item | Owner, Admin, TL; Agent/ISA (own, R-PAR-14 applies) | 5,000 |
| assign | `applyOwnershipCommand` reassign/assign per contact, `command_id = derived('bulk.assign', job, contact)` (idempotent), R-OWN-18 checks per item (TL: owner and target in their team), **no SLA** (as any manual reassign: `deadlineAt null`), per-contact notices batched (R-PAR-28) | Owner, Admin, TL (within team) | 2,000 |
| enroll | insert `playbook_enrollments` for an **approved** version; skip `ALREADY_ENROLLED` (one live enrollment), skip `DO_NOT_CONTACT`/`NO_REACHABLE_CHANNEL`; agent playbook only for contacts its owner owns | Owner, Admin, TL (team playbooks); Agent (own playbook, own contacts) | 2,000 |
| email | render template for this contact (R-PAR-19) → `queueBulkHumanMessageInTx` (initiator `human`, `initiated_by` creator, purpose **marketing** always, `bulk_job_id`) → `dispatchOutbound` (rate-limited queue) | Owner, Admin, TL (team), Agent (own), ISA (own) | 2,000/job; `bulk_email_daily_cap` per tenant |
| sms | as email, channel SMS, body + brokerage name + "Reply STOP to opt out" | **only while `bulk_sms_enabled`**: Owner, Admin, TL (team), Agent (own) | 200/job, 1,000/day/tenant |

Preconditions for email (preflight refuses the job, not item by item): verified sending domain, brokerage legal name and postal address set (R-CONSENT-18, `canContact` check 3/4); for SMS: an approved registration whose use case covers marketing (R-CONSENT-17).

### 10.4 Rules

- **R-PAR-25** Every bulk action is a `bulk_jobs` row created, previewed and confirmed by one person acting as themselves, executed one item per transaction as that person (RLS and `can()` re-decided per item), idempotent per (job, contact) and per (job, address), cancellable, and audited at create/confirm/cancel/complete with counts (no PII). [DB + api]
- **R-PAR-26** The target set and the message source are frozen at confirm; items are re-checked, never re-filtered. [api]
- **R-PAR-27** A bulk message is never a touch: TX1 writes no `touch` command when `bulk_job_id` is set; `v_agent_activity_daily` (replaced view) excludes bulk messages from touches/texts_and_emails and adds a separate `bulk_messages` count; speed-to-lead and `untouched_lead` are unaffected by construction. [dispatch test + view test]
- **R-PAR-28** Bulk assign goes through the ownership engine per contact under R-OWN-18; it starts no SLA; the engine is told `notice: 'summary'` so it emits no per-contact `reassigned_to/away` notification and the job sends one per affected user ("Pat moved 120 people to you"). [core + api]
- **R-PAR-29** Opt-outs are checked at each send by `canContact` and both DB guards (D1); a blocked item is `blocked` with the reason, writes the normal blocked-send `gate_decisions` row, and does not raise a `failed_send` exception (as R-MKT-8; the exclusion is one line in `deriveExceptions`, module 18a). A client reply between queue and dispatch cancels that item (`CLIENT_REPLIED`) instead of asking for a re-tap (no notification storm). A sender who lost the contact: item `skipped`, **no** draft offered to the new owner (unlike E15). [api]
- **R-PAR-30** Bulk text is off by default. Turning it on is the Owner's, with re-auth, an attestation, and a screen that says plainly: D1 removed consent checks; some states (e.g. Florida's FTSA, Oklahoma's TSA) regulate automated selection/dialing of marketing texts, require prior express written consent and limit hours and frequency; this product does not check those. Caps 200/job and 1,000/day. **VERIFY WITH COUNSEL** before any tenant enables it (counsel item C-PAR-1). [DB trigger + api]
- **R-PAR-31** Bulk email is marketing whatever the recent replies (the 30-day informational rule of R-CONSENT-5 applies to one-to-one only), so every bulk email carries the unsubscribe link, one-click headers, brokerage name and postal address. **VERIFY WITH COUNSEL.** [core + api]
- **R-PAR-32** Operational caps (per job, per day) are deliverability and blast-radius limits, not consent rules; they never block a one-to-one send. [api]

---

## 11. Manual activity logging (outside call/text/email/meeting)

Decision: a logged activity is a **note** with `source='logged_activity'` (§2.1), plus an outcome; meetings that matter go through the existing appointments flow ("Log a meeting" → past appointment with outcome, already agent-entered). No `calls`/`messages` row is ever written for an outside activity: those tables feed the gate, guards, touches, threads and scoreboards.

- **R-PAR-33** A logged activity never counts as a touch, never satisfies or delays first-touch SLA, auto-release or inactivity release, never clears an `untouched_lead`/`missing_outcome` exception, never appears in `v_speed_to_lead` or touch counts. It is shown everywhere as "Logged by Sam · not verified" with the time Sam entered it and the time Sam says it happened. The TL exception card shows logged activities in the period as context, so a TL can resolve the exception with a note (existing R-ACC flow). Scoreboard gets a separate, labelled "logged by agent" column. **Honest answer to "does it count for speed to lead": no.** (Whether FUB counts logged calls in its reports: **VERIFY**.) [view + core tests]
- **R-PAR-34** Logging is not consent: a logged "they said stop / don't call" offers the one-tap person-level do-not-contact (R-CHAN-3 path); the summary text is run through the opt-out-language regex and, on a hit, the app asks (does not auto-revoke: it is the agent's paraphrase). A logged activity never records a consent grant. [core + web]

---

## 12. FUB / CSV import extension

| Item | Today | Change |
|---|---|---|
| Tags | into `contacts.tags` | into `tags` + `contact_tags` (`added_by_kind='import'`, `import_batch_id`); lexicon protection applies to new tags; opt-out-reading tags still produce opt-outs (unchanged, R-CONSENT-3) |
| Stage | mapped to 8 + `imported_fields['FUB stage']` | + tenant mapping table: each distinct FUB stage label → one of the 8 (dry-run shows counts per label; default = `mapStage`); unmapped labels also become tag `FUB stage: <label>` |
| Custom fields | `imported_fields` (display only) | new `import_field_mappings` (batch_id, source_key) PK, target_kind (`custom_field/tag/keep_as_text/ignore`), custom_field_id, created_by — Owner/Admin/system (as `import_user_mappings`). Dry run proposes: create def with inferred type (number/date/select from distinct values ≤ 30) or map to existing; protected lexicon hits are proposed **protected**, and their values import with `self_reported=false` ⇒ refused by R-PAR-16 ⇒ kept as `imported_fields` text with issue `PROTECTED_FIELD_NOT_IMPORTED` (we cannot know the person told us). Values that fail type parsing stay in `imported_fields` + issue. `imported_fields` always keeps the original |
| Relationships | `imported_fields` text | unchanged (R-PAR-18: no points created) |
| Stage | no new import stage category | all of the above ride the existing `contacts` stage (R-IMPORT-3 ordering unchanged) |
| Revert | fingerprint over `contacts.tags` etc. | revert deletes import-added `contact_tags` / `contact_field_values` untouched since import (`updated_by_user_id IS NULL`); touched ones listed for a human (R-IMPORT-10); defs created by the batch archived if no values remain |
| CSV | `tags`, `stage` columns, `custom` → `imported_fields` | same mapping UI as FUB custom fields |

---

## 13. Capability matrix additions (server `core.can()`; RLS enforces rows)

| Capability | Owner | Admin | TL | Agent | ISA | TC |
|---|---|---|---|---|---|---|
| Write/edit/delete own notes; mention | ✅ | ✅ | T | O | O | D |
| Delete another's note | ✅ | ✅ | — | — | — | — |
| Add/remove tags on a person | ✅ | ✅ | T | O | O | — |
| Create a tag | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Rename/merge/delete/protect tags; stage labels; custom field defs | ✅ | ✅ | — | — | — | — |
| Add/edit person, points, addresses, custom values, relationships | ✅ | ✅ | T | O | O | — |
| Stage change (R-PAR-14 limits Agent/ISA) | ✅ | ✅ | T | O | O | — |
| Personal templates / lists | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (lists) |
| Team templates | ✅ | ✅ | use | use | use | use |
| Team smart lists | ✅ | ✅ | ✅ (create) | use | use | use |
| Bulk tag/untag | ✅ | ✅ | T | O | O | — |
| Bulk stage | ✅ | ✅ | T | O | O | — |
| Bulk assign | ✅ | ✅ | within team | — | — | — |
| Bulk enroll | ✅ | ✅ | T (team pb) | O (own pb) | — | — |
| Bulk email | ✅ | ✅ | T | O | O | — |
| Bulk text (only when enabled) | ✅ | ✅ | T | O | — | — |
| Enable bulk text | ✅ 🔒 + attestation | off only | — | — | — | — |
| Log outside activity | ✅ | ✅ | T | O | O | D |

---

## 14. Audit actions (added to the TS union in `apps/api/src/audit.ts`)

`contact.create`, `contact.update`, `contact.stage_change`, `contact_point.add`, `contact_point.remove`, `contact_point.restore`, `relationship.add`, `relationship.remove`, `note.delete`, `note.edit_other` (tenant-wide editing a note they did not write; author edits are not audited), `collaborator.add` (from the mention "Share"), `tag.rename`, `tag.merge`, `tag.delete`, `tag.protect`, `tag.unprotect`, `custom_field.define`, `custom_field.update`, `custom_field.archive`, `custom_field.protect`, `template.team_create`, `template.team_update`, `template.team_archive`, `smart_list.team_create`, `smart_list.team_update`, `bulk_job.confirm`, `bulk_job.cancel`, `bulk_job.complete`, `settings.bulk_sms` (diff incl. attestation present), `import.field_mapping`. Diffs follow R-AUDIT-4 (`tags`, `fields`, `value`, `body` are already PII-classified by the audit redactor regex).

---

## 15. Edge cases

| # | Case | Expected | Rule |
|---|---|---|---|
| E-B1 | Pat @mentions Sam on Jane; Sam is an agent who does not own Jane | Mention `no_access`; Sam gets nothing; Pat sees "Sam can't see Jane" + Share | R-PAR-2 |
| E-B2 | Sam was notified, then Jane is reassigned away from Sam | Notification stays (title "Pat mentioned you · Jane D."); tapping shows "no longer have access"; note text never left the note | R-PAR-3 |
| E-B3 | Pat edits a note to add a third mention | Only the new user is processed | §2.3 |
| E-B4 | A mention to a user who is suspended | `inactive`, no notification | §2.3 |
| E-B5 | An agent tags Jane "DNC" | Prompt to record do-not-contact; without the tap nothing is blocked and the tag chip says "Tags don't stop messages" | R-PAR-7 |
| E-B6 | Admin renames tag "buyer" to "Buyer" | Same `name_key`: rename allowed (display only) | R-PAR-6 |
| E-B7 | Admin renames "hot" to "warm" while "warm" exists | Refused with "Merge instead?" | §3.2 |
| E-B8 | Agent creates tag "VA buyer" | `protected_proxy` (lexicon); usable on the person; any list using it cannot drive bulk email | R-PAR-8, -24 |
| E-B9 | Agent removes Jane's phone that texted STOP, adds a new phone, taps Text | Blocked: removed opted-out phone still fans out; UI names the removed number | R-PAR-12 |
| E-B10 | Agent removes a phone after the system recorded "wrong number" from it | That point no longer blocks Jane's other phones (it was someone else) | R-PAR-12 |
| E-B11 | Agent "edits" Jane's email (typo fix) | remove + add; old address keeps its unsubscribe; new address checked on its own HMAC | R-PAR-11 |
| E-B12 | Agent adds a phone that is on another agent's contact | `DUPLICATE_CONTACT`-style refusal naming only that owner; confirm ⇒ duplicate candidate | R-PAR-9 |
| E-B13 | Agent moves an untouched `new` lead to `nurture` | `STAGE_NEEDS_CONTACT`; `lost` allowed | R-PAR-14 |
| E-B14 | Admin defines custom field `military` | Refused ("use the built-in Military status field") — or, as `vet_buyer`, created protected; values need "they told me" | R-PAR-16 |
| E-B15 | Template `Hi {{contact.first_name}}` for a contact with no first name, no fallback | Single send: compose shows the error; bulk: item skipped `MERGE_FIELD_EMPTY` | §8.2 |
| E-B16 | Contact's first name is `Jane\r\nBcc: x@y` used in a subject | CR/LF stripped; the name stays one header value | R-PAR-19 |
| E-B17 | Admin edits a team template while a bulk email using it is running | The job sends its frozen snapshot; the template version on each message records which version | R-PAR-26 |
| E-B18 | TL shares a list "owner = me, stage = active"; an agent opens it | Agent sees their own active contacts; `me` = the viewer | R-PAR-22 |
| E-B19 | Definition with `value: "x'); DROP TABLE contacts;--"` | Bound parameter; matches nothing | R-PAR-21 |
| E-B20 | Agent confirms bulk email to 412; 30 opt out before their item runs | 30 `blocked` with reasons, `gate_decisions` rows, no `failed_send`; summary "Emailed 382 of 412" | R-PAR-29 |
| E-B21 | Spouses share one email; both in the bulk set | One send (address dedupe), second item `skipped DUPLICATE_ADDRESS` | §10.1 |
| E-B22 | During a bulk email run, the creator is suspended | Remaining items `skipped CREATOR_INACTIVE`; job `failed` with counts; Owner notified | R-PAR-25 |
| E-B23 | Network retry of `confirm` | Idempotency key ⇒ same job; items PK ⇒ no second set | R-PAR-25 |
| E-B24 | Worker dies mid-item after TX1 of a send | Normal `dispatch_unknown` reconcile; the item re-run finds its message by idempotency key `bulk:{job}:{contact}` and does not resend | R-PAR-25, R-GATE-8 |
| E-B25 | TL bulk-assigns 120 leads, 3 now owned by another team | 117 reassigned; 3 `skipped NOT_IN_TEAM` (engine rejection rows); one summary per affected agent | R-PAR-28 |
| E-B26 | A contact in the bulk set merged into another mid-run | Item `skipped MERGED`; the survivor is not added | R-PAR-26 |
| E-B27 | Client replies to the bulk email before their own item dispatches (spouse replied?) | Item `canceled CLIENT_REPLIED`; no re-tap notification | R-PAR-29 |
| E-B28 | Bulk text with `bulk_sms_enabled` turned off mid-run | Next items `blocked BULK_SMS_DISABLED` (checked per item) | R-PAR-30 |
| E-B29 | Agent logs "called, connected" for an untouched lead at minute 14 | SLA still breaches at 15; exception shows the logged call as context | R-PAR-33 |
| E-B30 | Agent logs an outside text: "she said stop texting me" | App asks to record do-not-contact; one tap records it | R-PAR-34 |
| E-B31 | Relationship spouse ↔ Bob; viewer sees Jane but not Bob | No relationship shown, no count | R-PAR-18 |
| E-B32 | FUB custom field "Military" with values | Proposed protected; values not self-reported ⇒ kept as imported text with issue | §12 |
| E-B33 | Erase Jane | Tags links, field values, relationships, mentions (via notes), bulk items, stage events removed; HMAC opt-outs kept | R-PAR-35 |
| E-B34 | Support actor opens a list or a bulk preview | Reads allowed; confirm/any write refused (`SUPPORT_READ_ONLY` trigger on every new table) | R-PERM-11 |
| E-B35 | Team list filter on a protected tag, used for bulk enroll | `AUDIENCE_PROTECTED_PROXY` at confirm | R-PAR-24 |

---

## 16. Data, isolation and retention

- **R-PAR-35** Every new table: `tenant_id` leading PK, composite FKs, FORCE RLS, Layer 1 staff-only + `support_read_only_{ins,upd,del}`, the statement `support_read_only` trigger, least-privilege grants (`contact_tags`, `note_mentions`, `bulk_job_items`… DELETE only where rows are genuinely removed), listed in the migration self-check. Contact-scoped rows cascade on purge/erase; `contact_stage_events` is append-only, so `app.purge_contact_internal` (replaced again, `app_retention`) deletes it explicitly first (R-DATA-5 pattern). `bulk_jobs` keep counts only (no PII) for 2 years; items purge 90 days after the job finishes (**VERIFY WITH COUNSEL**). Job payloads carry ids only. [DB self-check + smoke + rule_coverage invariant]
- No new definer is needed: mention delivery and bulk runs execute as the real user (worker rebuilds the human actor from a row, the dispatch precedent). If the lead prefers a definer for mention visibility, it is a security-review item and must mirror the central contact rule exactly (drift risk; I recommend against).

---

## 17. Phone and desktop UX (tap counts; FUB counts all **VERIFY**)

| Job | Realty OS phone | Realty OS desktop | FUB (VERIFY) |
|---|---|---|---|
| Add a note | person → **Note** (action bar) → type → Save = **2 taps** + typing | `N` shortcut on person, Cmd-Enter | ~3 (person → Notes → + → Save) |
| @mention | type `@` → pick (1) | same | similar |
| Add tag | person → tag chip row **+** (1) → type 2 letters → pick or "Create" (2) = **2–3** | same + multi-select | ~4 (person → edit tags → search → select → done) |
| Add a person | **+** (1) → name, phone (keyboard) → Save (2); duplicate sheet if needed | `P` shortcut, same form | ~3–4 |
| Edit phone | person → phone row → **…** (1) → "Replace number" (2) → type → Save (3); the old number stays listed as removed with its opt-out shown | inline | ~3 |
| Change stage | person → stage pill (1) → pick (2) = **2** | same | ~2–3 |
| Text with template | person → Text (1) → template icon (2) → pick (3) → Send (4) | `/` in compose opens templates | ~4 |
| Log outside call | person → **Log** (1) → Call preselected, outcome chip (2) → Save (3) = **3** | same | ~4 |
| Open a smart list | Lists tab (1) → list (2) | left rail, one click | ~2 |
| Bulk tag | list → **Select** (1) → "All 412" (2) → Tag (3) → pick (4) → Confirm "Tag 412" (5) = **5** | checkbox header (1) → Actions (2) → Tag (3) → pick (4) → Confirm (5) | ~5 |
| Bulk email | list → Select (1) → All (2) → Email (3) → template (4) → Preview → **Send to 412** (5) = **5** (+ preview scroll) | same, preview side panel | ~5–6 |
| Bulk assign | desktop only (TL/Admin; phone shows "Use desktop for moving many people") | 5 | ~5 |

Honesty in UX: bulk confirm shows the frozen count, how many will be skipped and why (opted out, no email, not yours), the rendered footer and unsubscribe; "Tags don't stop messages"; "Logged by Sam · not verified"; "Bulk messages don't count as reaching out"; "Bulk assignment doesn't start a 15-minute clock"; the bulk-text switch shows the counsel warning verbatim. No dark patterns: no pre-checked "select all", cancel always visible while running, progress shows real counts.

---

## 18. Module split (5 lanes, non-colliding paths)

Schema: the lead writes `0019_fub_parity.sql` (tables §2–§12, guard fix R-PAR-12, replaced views, purge definer, self-check, `support_read_only` attach). **Numbering hazard:** PHASE2_3_PLAN §4 reserves module migrations by "next free number at merge"; lanes 21/22/29/33/43/54 may also want 0019 — the orchestrator renumbers at merge; parity lanes write no migration of their own.

| Lane | Path (owned) | Depends on | Critical | Content |
|---|---|---|---|---|
| PAR-A core/parity | `packages/core/src/parity/**` | 0019; imports `core/fairhousing` (module 20) read-only | **yes** | `SmartListDefinition` + plan compiler (no SQL), `renderTemplate` + merge-field parser, tag/field normalizers + proxy classification (calls the module-20 lexicon), `validateFieldValue`, `stageChangeAllowed` (R-PAR-14), bulk planning (caps, per-kind eligibility), opt-out-looking tag detector (reuses `core/import` patterns by import). Property tests: rendering never emits outside context; compile determinism; R-PAR-14 truth table |
| PAR-B api/people | `apps/api/src/people/**` | PAR-A | **yes** (points, mentions) | contact PATCH, points add/remove/restore, addresses, tags + catalog admin, custom field defs/values, relationships, stage labels, notes + mentions job, activity logging; `adversarial.test.ts` (mention leak, removed-point dodge, cross-tenant ids) |
| PAR-C api/lists-bulk-templates | `apps/api/src/{lists,bulk,templates}/**` | PAR-A, PAR-B (tags/fields repos) | **yes** (sends, assign) | templates CRUD, list compile/execute + perf test at 250k, bulk jobs (preview/confirm/run/cancel), summary notifications |
| PAR-D web/parity | `apps/web/src/surfaces/{people,lists,bulk,templates}/**`; contact page sections in `apps/web/src/surfaces/contact/**` (Phase 1 surface, no Phase 2 owner listed) | PAR-B, PAR-C | no | add/edit person, tag chips, notes tab + mention picker, fields panel, relationships, log sheet, lists, bulk flows, templates admin |
| PAR-E imports + proofs | `apps/api/src/imports/**`, `packages/core/src/import/**`, `packages/db/test/rls_smoke_parity.sql` (+ `.test.ts`), `fixtures/opt_out_cases.json` (append cases) | 0019 | **yes** (opt-out carry-over) | tag/stage/custom-field mapping, `import_field_mappings` API, revert extension, `contacts.tags` reader switch inside imports; RLS smoke for every new table/role |

**Flagged edits outside owned paths (small, additive; one owner each, PHASE2_3_PLAN §5.3):**

| File | Owner | Edit | By |
|---|---|---|---|
| `apps/api/src/comms/dispatch.ts` | module 22 | (1) no `touch` when `m.bulkJobId` set; (2) no E15 draft to the new owner for bulk; (3) bulk + client replied ⇒ cancel item instead of `needs_retap` | PAR-C after 22, or 22 lands it |
| `apps/api/src/comms/compose.ts` | module 22 | `queueBulkHumanMessageInTx` (human initiator, forced marketing, `bulk_job_id`, `template_id/version`) | same |
| `apps/api/src/leads/repos/contacts.ts`, `leads/views.ts` | module 22 | read tags from `contact_tags` (one query) | PAR-B after 22 |
| `packages/core/src/ownership/decide.ts` | Phase 1 (no Phase 2 owner) | `notice: 'summary'` option on assign/reassign | PAR-A |
| `packages/core/src/compliance/**` (gate "other phones" incl. removed) | module 19 | input builder change + cases | 19 (or PAR-E adds cases only) |
| `packages/core/src/accountability` / `deriveExceptions` | module 18a | exclude `bulk_job_id` messages from `failed_send` (like R-MKT-8) | 18a |
| `apps/web/src/surfaces/compose/ComposeBox.tsx` | module 37 | template picker slot (one button + sheet import) | PAR-D after 37 |
| `apps/web/src/surfaces/feed/lib/types.ts` | module 18a | `tags` source shape unchanged (server keeps the field name) — **no edit needed** | — |
| Registries: `routes.ts`, `worker/handlers/index.ts` (`notes.mention`, `bulk.run`), `errors.ts` (`STAGE_NEEDS_CONTACT`, `MERGE_FIELD_EMPTY`, `AUDIENCE_PROTECTED_PROXY`, `BULK_TARGET_CHANGED`, `BULK_SMS_DISABLED`, `LIST_TOO_SLOW`), `foundation/authz.ts` (§13), `shell/registry.ts`, `audit.ts` union | additive protocol (CONVENTIONS §3) | one entry each | each lane |
| `packages/eslint-plugin/**` | scaffold | `realty/no-raw-sql-in-lists` | PAR-C (one flagged edit) |

---

## 19. Cuts (and why)

| Cut | Why |
|---|---|
| Tenant-defined stages / pipelines | engine semantics (R-OWN-23) and reporting depend on the 8; labels cover the naming need |
| Private notes, note threads/replies, reactions | fewer concepts; visibility = contact visibility is the honest rule |
| Field-level permissions on custom fields | complexity; protected fields already restricted where it matters |
| Contact merge UI, unmerge | engine exists; UI is its own design (dup review screen, R-OWN-24 choices) — **flag to lead: FUB users merge daily** |
| Relationship-driven sends ("also email the spouse"), importing FUB relationship phones | sends to people who never inquired; unreadable opt-outs |
| Templates in playbooks; HTML email templates; attachments | approval binding (R-AST); text-only email path keeps XSS/injection impossible |
| Re-evaluated ("live") bulk targets, scheduled/recurring bulk sends | blast radius, honesty of the confirmed count; recurring = playbooks |
| Bulk text on by default; bulk SMS above 200/job | D1 + state mini-TCPA (VERIFY WITH COUNSEL) |
| Contact export from lists | deferred by PHASE2_3_PLAN (Q12), largest exfiltration path |
| Override of R-PAR-12 over-blocking ("that number belonged to someone else") | it would be a staff path around an opt-out fan-out; revisit with counsel if it bites |
| A definer to test another user's visibility | the worker-as-user precedent avoids policy drift |

## 20. Needs from the owner / counsel

| Id | Question |
|---|---|
| C-PAR-1 | **VERIFY WITH COUNSEL**: bulk texting under D1 with FL FTSA / OK TSA / similar (selection-or-dialing definition, consent, hours, 3-per-24 h); whether to keep the feature at all |
| C-PAR-2 | **VERIFY WITH COUNSEL**: which tags/fields are protected-class proxies per state (military status, source of income, language), and whether proxy-based audiences are barred for email marketing |
| C-PAR-3 | **VERIFY WITH COUNSEL**: bulk email always classified marketing (CAN-SPAM transactional/relationship exemption not used) |
| O-PAR-1 | Owner: accept over-blocking in R-PAR-12 (a removed opted-out phone keeps texting blocked) |
| O-PAR-2 | Owner: logged outside calls never count for SLA/inactivity (agents who dial from personal phones will feel this; the alternative is unverifiable activity in the engine) |
| O-PAR-3 | Owner: retire `contacts.tags` in favour of the catalog (one migration release of double readers) |
