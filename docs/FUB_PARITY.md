# FUB parity: gap analysis

Status: design input for `docs/PARITY_PLAN.md` (the build plan) and `docs/DATA_MODEL.md` Part 3 (tables, RLS, rules R-PAR-*, edge cases E162+). Written 2026-11-11 on branch `design/fub-parity` from a code inventory of `apps/api/src`, `apps/web/src`, `packages/core/src` and `packages/db/migrations`, plus two independent design drafts (`docs/parity/draft-a.md`, simplicity-first; `docs/parity/draft-b.md`, risk-first).

The owner's request: "We need the ability like FUB, to send emails, write notes, tags, texts, calls, etc."

**How to read the FUB column.** It records how Follow Up Boss does the job as we understand it. Anything we are not sure of is marked **VERIFY**: check it against the current FUB web app and iOS app before relying on it. No FUB tap count in this repository has been measured; all of them are VERIFY.

Abbreviations in citations: A = `apps/api/src`, W = `apps/web/src`, C = `packages/core/src`, M = `packages/db/migrations`.

## 1. Corrections to the brief (checked in code)

| Brief said | What the code shows |
|---|---|
| "no manual add of a person" | The API exists: `POST /contacts`, with dedup through `app.lock_address` + `find_contacts_by_address` (A/leads/contacts.ts:73-152). Phones get the label `mobile` and emails get no label. **No web screen calls it**; only the seed script does. Edit is missing. |
| "the FUB import does not bring over tags, stages or custom fields" | It does, but weakly. Tags go into `contacts.tags` (C/import/fub.ts:247; A/imports/commit.ts:259). Stages map through a fixed word list, and an unknown stage becomes `new` with `STAGE_UNMAPPED` (C/import/csv.ts:297-321). FUB `custom*` fields land as display-only strings in `imported_fields` (fub.ts:251-262). What is missing is an Admin stage mapping, a tag catalog and typed custom fields. A stage is not updated on an existing contact. |
| "no merge duplicates" (implied) | The merge API exists: `POST /leads/:id/merge` through the ownership engine (A/leads/commands.ts:127). Two things are missing: a review list of duplicate candidates, and any web UI. |
| (not in the brief) | **Live opt-out gap.** Both dispatch guards build "the contact's other phones" only from points with `removed_at IS NULL` (M/0018:404-409, 490). An agent could remove the phone that texted STOP and then text the same person on another number. The parity migration fixes this (R-PAR-12). |

## 2. Gaps, ordered by how often an agent hits them

Frequency is a judgement about an agent's day: several times an hour, several times a day, weekly, or rare/Admin. **VERIFY** it against FUB usage data if the owner has any.

| # | Job | How often | FUB (as we understand it) | Realty OS today (cited) | Gap |
|---|---|---|---|---|---|
| 1 | **Write a note on a person** (with @mention, pin) | hourly | Note box on the person page; @mention notifies a teammate; notes can be pinned (VERIFY pinning) | `notes` table exists with `pinned` (M/0001:2011-2035). **No write API or UI**. Notes arrive only from imports (A/imports/repos/writes.ts:129) and call summaries; they are read in the timeline (W/surfaces/contact/ContactPage.tsx:255) and search (A/workspace/search.ts:163). No mentions anywhere | **missing**: notes API/UI, @mentions, notification, delete |
| 2 | **Log a call/text/email/meeting done outside the app** | hourly | "Log a call" / log an activity with an outcome (VERIFY exact options); logged calls appear in the timeline | Calls placed in the app have outcomes (A/comms/routes.ts:152-158; the outcome is an enum with no note, A/comms/schemas.ts:96-98). `calls.initiator` allows only human/client/import (M/0001:1393). There is no logging route | **missing**: logged activity, call notes |
| 3 | **Tag / untag a person** | hourly | Tags on the person; typing creates a tag; tags drive lists and action plans (VERIFY tag-triggered plans) | `contacts.tags text[]` + GIN (M/0001:713, 779), written only by import; returned by GET /contacts/:id (A/leads/views.ts:105) but **not rendered**. No API, no catalog, no rename/merge | **missing** |
| 4 | **Change stage** | several/day | Stage dropdown on the person; stages are configurable per account (VERIFY); stage changes can start action plans (VERIFY) | Fixed 8 stages (M/0001:677). **No API changes a contact's stage** (set only at create, D/ownership/rows.ts:317, and by import); shown as text (ContactPage.tsx:159) | **missing**: stage change, history, labels |
| 5 | **Send a one-off text or email using a template** | several/day | Template picker in the composer with merge fields; personal and shared templates (VERIFY sharing rules) | Sending exists (POST /contacts/:id/messages + /preview, A/comms/routes.ts:122-125; ComposeBox W/surfaces/compose/ComposeBox.tsx). **No templates** (A/assistant/templates.ts holds playbook starters, not message templates) | **missing**: templates, merge fields |
| 6 | **Edit a person** (name, phones/emails with labels, primary, address, source) | several/day | Inline edit on the person page; multiple phones/emails with labels (VERIFY label set) | **No PATCH** (A/leads/routes.ts). Points are shown read-only with label/status (ContactPage.tsx:179-192) | **missing** |
| 7 | **Add a person by hand** | daily | "Add person" button (web and app) | API only (above). **No web UI** | **UI missing**; API needs stage/tags/source/address on create |
| 8 | **Smart lists / saved filters** (stage, tag, source, owner, last activity, next task, dates, custom fields) | daily | Smart lists are central to FUB's daily workflow (VERIFY exact filter set); personal and shared | **No contact list endpoint at all**; only type-ahead `GET /search?q=` (A/workspace/schemas.ts:335), `/feed`, `/ponds/:id/cards`. No People page in the nav (W/shell/Layout.tsx) | **built** (lanes par-lists, people-filters): People page filter builder (stage, source, owner, intent, contact type with is / is not; tags any/all/none; activity, created, next task; custom fields; match any of), name search, chips, save / edit as personal or team lists. Name search only, not phone/email (gap) |
| 9 | **Tasks and appointments from the person** | daily | Add task / appointment from the person page | Tasks API exists (A/workspace/routes.ts:79-90) and TasksPage creates title+due; **ContactPage cannot add a task** (lines 286-306). Appointments API exists (routes.ts:98-112); **no create UI**, only the outcome sheet (W/surfaces/feed/lib/AgentSheets.tsx:169-195) | **partial**: UI on the person page |
| 10 | **Email signature, scheduling, attachments** | daily | Per-user signature; schedule send (VERIFY); attachments (VERIFY size limits) | `scheduleAt` exists in ComposeBody (A/comms/schemas.ts:29-36) but **the web never sends it**. **No signature** (only the brokerage footer, A/comms/render.ts:54-62; `email_identities` has no signature column, M/0001:1246). **No attachments** | **partial**: signature and schedule now; attachments with Phase 2 module 22/37 |
| 11 | **Text with an image (MMS)** | weekly | Send a photo in a text (VERIFY) | `messages.channel` allows `mms` (M/0001:1289); `message_media` is inbound-only (M/0001:1360); ComposeBody is sms/email only | **missing**: needs a dispatch branch (module 22 owns it) |
| 12 | **Reassign / collaborators** | weekly | Assigned agent dropdown; collaborators ("shared with") on the person (VERIFY) | Reassign API through the engine (A/leads/commands.ts:115-121); web only in the TL exceptions queue (W/surfaces/team/TeamPage.tsx:192-214). `contact_collaborators` table (M/0001:894); **no API**, and only the engine adds an ISA on handoff (D/ownership/effects.ts:251) | **partial**: UI + collaborator API |
| 13 | **Custom fields** (incl. important dates: birthday, home anniversary) | weekly | Admin-defined custom fields of several types (VERIFY types and limit); important dates with reminders (VERIFY) | `imported_fields` jsonb, display-only and **never exposed** by any API (views.ts). `contact_attributes` is the assistant's fact store, read-only (A/assistant/repos/context.ts:114). No birthday/anniversary except a playbook step 365 days after closing (A/assistant/templates.ts:64) | **missing** |
| 14 | **Bulk: tag, assign, add to an action plan, email, text** | weekly | Select many in a list, then act on them (VERIFY exact bulk actions and caps; FUB "mass email" and "mass text" VERIFY) | **No bulk endpoints**. A `bulk` job queue exists (M/0001:2299), used by imports only | **missing** |
| 15 | **Relationships** (spouse, co-buyer, referred by) | weekly | Relationships on the person (VERIFY shape: separate people vs. name/phone fields) | None | **missing** |
| 16 | **Action plans and stage-change automations** | weekly (setup rare) | Action plans (drips) applied by hand, in bulk, or automatically on stage change/lead source (VERIFY) | Playbooks with approve-once versions and enrollment pause/resume/stop (A/assistant/routes.ts:119-160); `enrolled_by` is user/new_lead/deal_closed only (A/assistant/firstResponse.ts:97, enrollments.ts:334). **No stage trigger; no enroll UI** in the web (grep `/enrollments` in W: none) | **partial**: enroll UI, bulk enroll, stage-entry enrollment |
| 17 | **Merge duplicates** | weekly | Duplicate detection and merge (VERIFY) | Merge API (above); candidates are created (A/leads/repos/contacts.ts:176) but no route lists or decides them; merge moves messages, calls, enrollment, handbacks, drafts (D/ownership/merge.ts:1-11) | **partial**: review list, UI, moving new child rows |
| 18 | **Delete and restore a person** | rare | Delete, with restore for a while (VERIFY) | `POST /leads/:id/delete` (soft) and `/reopen`, the latter for TL/Owner/Admin (C/ownership/decide.ts:836-846). No UI | **UI missing** |
| 19 | **Templates library admin** | rare (Admin) | Shared template library (VERIFY folders) | None | **missing** (with #5) |
| 20 | **FUB import of the above** | once per team | — | People, notes, texts, emails, calls, users; tags and stages weakly; custom fields as text; **not**: relationships, collaborators, typed custom fields, important dates, smart lists, templates, action plans (C/import/fub.ts:21, 231-499) | **partial**: stage mapping, tag catalog, typed fields |
| 21 | **Calls: click-to-call and the call outcome** | hourly | Dialer in app; call outcome and notes | **Exists**: POST /contacts/:id/calls, outcome sheet (A/comms/routes.ts:152-158; W/surfaces/feed/lib/AgentSheets.tsx:99-162). Gap: a note with the outcome (#2) | covered by #1/#2 |
| 22 | **One-off text/email** | hourly | Composer | **Exists**, with preview and D1 opt-out checks (A/comms/routes.ts:122-125; A/comms/dispatch.ts) | covered |
| 24 | **Lead Flow: lead sources setup** | Admin, rare | FUB creates a source on the first lead it receives; Lead Flow rules per source (VERIFY) | Lead sources page `/admin/lead-sources` (module 22, 2026-11-12): every path per source, in words, with the routing preview. Ours are made by the Owner, by design (no source appears from a stranger's post) | covered |
| 25 | **Portal email intake** | hourly (passive) | Inbox "Lead Processing" parses portal emails (VERIFY) | Generic labelled format + leadmetadata.org v1.0 + per-portal sender domains and forwarding (R-LEM-9..12). Vendor parsers for Redfin, Homes.com, Trulia, Opcity wait for samples and counsel. Gmail sync never creates leads (R-GMAIL-14) | **partial** |
| 26 | **Google Ads lead forms** | passive | Lead form integrations (VERIFY) | Webhook with a per-source key (R-GADS-1..4); fakes only until a deployed test (D2: no Meta lead ads) | covered (fake) |
| 27 | **Calls to a tracking number credited to a source** | daily (passive) | No number-to-source setting found (VERIFY); LSA via a labelled Team Inbox number | A live tracking number tied to one source: new callers become leads credited to it (R-TRK-1..3); the ring target is unchanged until module 48 | covered (fake) |
| 28 | **Per-agent routing address** | Admin, rare | Per-agent lead email (VERIFY) | Agent forwarding: a "Forwarded by <name>" source, its inbox and a direct rule, with the preview (R-LSRC-5) | covered |
| 29 | **Website / IDX posts** | passive | FUB `/v1/events` API (VERIFY) | Signed per-source webhook (`/intake/:token`, its own secret, R-LSRC-3) | covered |

## 3. What the design does about each gap

The model is in `docs/DATA_MODEL.md` Part 3 and the build in `docs/PARITY_PLAN.md`. In one line each:

1. **Notes**: a notes API with @mentions. Each mention is checked **as the mentioned person** while saving, so the author learns at once who was not told. The notification never contains note text. Notes can be deleted (author) and pinned.
2. **Logged activity**: a note with `source = 'logged_activity'` plus kind, direction, time and outcome. It is never a `messages`/`calls` row, never a touch, and always labelled "Logged by …".
3. **Tags**: a `tags` catalog (case- and width-insensitive, colours, rename in one row, Admin merge) and `contact_tags`, whose rows are visible exactly when the person's details are. `contacts.tags` is backfilled and retired.
4. **Stages**: the fixed eight stay. Teams get display labels, an append-only `contact_stage_events` history, and a guard against parking an untouched routed lead outside `new`/`attempting`.
5. **Templates**: `message_templates` (personal, plus team templates edited by Owner/Admin) with a closed set of merge fields, rendered for one person under the sender's own access. The brokerage footer stays the send path's job.
6. **Edit / add a person**: `PATCH /contacts/:id` plus point and address routes. A phone or email is never edited in place: "edit" means remove and add. Removing a point never lifts an opt-out (R-PAR-12).
7. **Smart lists**: `smart_lists` stores a typed definition, compiled only to parameterised SQL and always run under the viewer's own access. New list indexes, with a 250k-contact performance budget.
8. **Tasks / appointments**: UI only (APIs exist).
9. **Signature / schedule**: `memberships.email_signature` (plain text); the composer exposes the existing `scheduleAt`. Attachments and MMS are deferred to Phase 2 modules 22/37 (they own dispatch and compose).
10. **Custom fields**: `custom_field_defs` (text, number, date, single select, multi select; at most 50 live; `annual` for birthdays and anniversaries) and typed `contact_field_values`. A field name matching the fair-housing lexicon is refused, and those facts stay in the built-in self-reported attributes. Protected tags are never a bulk audience.
11. **Bulk**: `bulk_actions` + `bulk_action_items`. The target is frozen at confirm, and only the creator confirms. Each item runs as the creator. Every send goes through `dispatchOutbound` and both DB guards. Bulk email is always marketing and never a touch. Batch text sits behind an Owner switch that is off by default (**VERIFY WITH COUNSEL**).
12. **Relationships**: `contact_relationships`, which a viewer sees only when they can see both people.
13. **Stage-entry enrollment**: `playbooks.auto_enroll_stage` (approved versions only, one live enrollment per person).
14. **Merge**: a candidates review list, plus moving the new child rows (tags, values, relationships, mentions follow their notes) inside the existing merge transaction.
15. **Import**: Admin stage mapping, the tag catalog, and FUB custom fields mapped to typed definitions.

## 4. What we are not building (and why)

| Item | Why |
|---|---|
| Tenant-defined stages and pipelines | The eight stages carry engine meaning: inactivity release applies only to `new`/`attempting` (C/ownership/timers.ts:62), and handbacks are hot for those stages. Labels plus "keep the FUB stage as a tag" cover the naming need. Owner question Q-PAR-1. |
| Tag-triggered automations | A tag would become a new kind of autonomous send trigger. Use stage-entry enrollment or bulk enroll instead. |
| Private notes, threaded note comments | One visibility rule (the person's) keeps notes honest and simple. FUB private notes: VERIFY. |
| HTML template builder, open/click stats per template | Plain text plus the existing footer. Opens are signals only (Apple MPP). |
| Power dialer, bulk calling | TCPA exposure; not a daily need we can justify (VERIFY WITH COUNSEL). |
| Scheduled bulk sends, recurring list audiences | Each bulk action is one confirmed, frozen set; scheduling would add a re-check state. |
| Contact export, unmerge | Still deferred (PHASE2_3_PLAN §3; Q12). |
| Importing FUB smart lists, templates, action plans | They would not map onto the approval model (FUB API coverage: VERIFY). |
| Facebook/Instagram messaging | Owner decision D2. |
