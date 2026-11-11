# Realty OS: FUB parity plan (authoritative)

Status: the authoritative design and build plan for FUB parity. The owner asked: "We need the ability like FUB, to send emails, write notes, tags, texts, calls, etc."

| Document | What it holds |
|---|---|
| `docs/FUB_PARITY.md` | The gap analysis (what FUB does, what we have, the gap, ordered by frequency) |
| `docs/DATA_MODEL.md` Part 3 (§11–§14) | Tables, RLS, the capability matrix, rules R-PAR-1…46, edge cases E162–E193 and E230–E233 (the FUB migration owner decisions, §2.2) |
| `packages/db/migrations/0021_fub_parity.sql` | The schema (a placeholder number: the orchestrator renumbers at merge; nothing in code or tests names the file) |
| `packages/db/test/rls_smoke_parity.sql` | The proof (run by `rls_smoke_parity.test.ts`) |

How this plan was made: two independent drafts (`docs/parity/draft-a.md`, simplicity-first; `docs/parity/draft-b.md`, risk-first) were merged by the lead. A security critic and a simplicity critic then reviewed the result, and §2.3 and ARCHITECTURE §20 record what was applied.

What it does not touch: Phase 1 and the Phase 2-3 plan stay in force, and nothing here weakens them.
- **D1 opt-outs**: checked in `canContact` and both DB guards, with no override and no bulk exemption.
- **D2**: no Messenger/Instagram messaging.
- **Tenancy**: FORCE RLS with `(tenant_id, id)` keys.
- **Ownership**: changes only through `applyOwnershipCommand`.
- **Sending**: one outbound path, `dispatchOutbound`.
- **Assistant autonomy**: only inside approved playbooks.
- **Human taps**: money, contracts and new kinds of client message always need one.

---

## 1. What ships (one line per job)

| Job (FUB) | Realty OS answer | Removes from an agent's day |
|---|---|---|
| Write a note, @mention, pin | Notes API + composer. Each mention is checked as the mentioned person, at save. The notification never has note text | texting teammates about a lead |
| Log an outside call/text/email | One sheet: kind, outcome, time, note, optional "Remind me in N days" task. Never a touch | double-keeping call notes elsewhere |
| Tag / untag; tap a tag to see everyone with it | Tag catalog + chips; typing creates; Admin rename/merge | spreadsheets of "who is a VA buyer" |
| Change stage | Stage pill with team labels; history in the timeline; locked stages say why | — |
| Template text/email; signature; send later | Personal + team templates with safe merge fields; plain-text signature; the existing `scheduleAt` exposed | retyping the same five messages |
| Add / edit a person | Add-person sheet (dedup as intake); inline edit; phones/emails with labels; replace-number flow | — |
| Smart lists and the People page | Saved definitions (personal or team) over stage, tag, source, owner, activity, next task, dates, custom fields; "Next person" when working a list | finding who to call |
| Custom fields, birthdays, anniversaries | Typed fields (≤ 50), `annual` dates with "coming up" clauses and reminder tasks | remembering dates |
| Relationships | Spouse/co-buyer/referred-by links, shown only when both people are visible | — |
| Bulk tag, stage, assign, enroll, email, (text) | Audited bulk actions, frozen targets, run as their creator, each send through dispatch; batch text behind an Owner switch, off by default | one-by-one clicks |
| Action plan on stage change | `playbooks.auto_enroll_stage` on an approved playbook | remembering to start the plan |
| Merge duplicates | Review list of duplicate candidates + merge through the engine (moves the new child rows) | duplicate leads |
| Tasks/appointments from the person | Add task / appointment on the contact page (APIs exist) | switching screens |
| Collaborators, reassign, delete/restore | UI for the existing engine commands + a collaborator API | asking an Admin |
| FUB import of tags, stages, custom fields | Admin stage map, tag catalog, typed field mapping | re-tagging after migration |

**Deferred, with reasons:**

| Item | Why |
|---|---|
| Email attachments and outbound MMS | They need a dispatch branch and compose changes. Phase 2 module 22 owns `comms/dispatch.ts` and module 37 owns compose, so this lands as their follow-up: schema change none (`stored_objects` + `message_media`), owner question Q-PAR-6 |
| Tag-triggered automations | — |
| Custom stages | — |
| Private notes | — |
| Power dialer | — |
| Scheduled bulk | — |
| Contact export | — |
| Importing FUB smart lists, templates and action plans | — |

The full list with reasons is `docs/FUB_PARITY.md` §4.

## 2. Decision record

### 2.1 Merge of the drafts (A = simplicity-first, B = risk-first)

| Topic | Taken | Why |
|---|---|---|
| Tag storage | **B**: `tags` + `contact_tags`; `contacts.tags` backfilled and retired | `contacts.tags` sits on the contact row, which pond/offer card viewers can SELECT, so a person's tags were readable without detail. A rename on an array rewrites up to 250k guarded rows, but on a catalog it is one row. A join row gives "visible exactly when the person is" by construction |
| Custom field values | **B**: typed `contact_field_values` | `contact_attributes` is the assistant's evidence-backed fact store. Typed columns make list filters indexable |
| Mentions | **B's rule** ("decided as the mentioned user, no definer") with the **simplicity critic's timing** (checked synchronously at save, no mentions table) | A's `app.user_sees_contact_detail` definer would re-implement the central RLS rule for another user and drift. A save-time check tells the author at once and lets the picker show who can see the person |
| Logged activity | **A + B agree**: a note with `source = 'logged_activity'` | `messages`/`calls` are the dispatch record (guards, touches, inbox) |
| Stages | **Fixed eight + labels (both)**, history table (B), anti-parking guard (B) | Engine meaning of `new`/`attempting`. The guard stops a lead being hidden from the inactivity release |
| Removed points | **B's live-gap fix** in both guards | An opt-out on a removed phone must keep blocking the person's other phones (D1) |
| Templates | **A's** "render, then the existing compose/send" path; **B's** closed field set, version, team = Owner/Admin | Zero dispatch change for one-to-one templates |
| Smart lists | **B's** whitelisted compiler + **A's** detail-only results and indexes | Injection-proof, and no pond-card leak |
| Bulk | **B's** lifecycle + **A's** "always marketing, never a touch" | — |
| Merge duplicates UI | **In scope** (B flagged, simplicity critic) | New add/edit flows create candidates that need a place to be resolved |

### 2.2 Owner questions (default in force until decided)

| # | Question | Default |
|---|---|---|
| Q-PAR-1 | Configurable stages beyond labels? | No: fixed eight + labels + "keep FUB stage as tag" on import |
| Q-PAR-2 | Should a logged outside call count as a touch (SLA, inactivity) or unlock R-PAR-14's stage guard? | Never a touch; it does not unlock the guard. Scoreboard shows a separate "logged" column |
| Q-PAR-3 | Accept over-blocking from R-PAR-12 (a removed phone's STOP keeps blocking the person's other phones unless it was a confirmed wrong number)? | Yes (D1: an opt-out is final) |
| Q-PAR-4 | May Team Leads edit team templates? | No (Owner/Admin); TLs copy to personal |
| Q-PAR-5 | Batch text: allow at all, and cap per action? | Switch off by default; Owner-only on; ≤ 200 per action (DB ceiling; a lower tenant setting may follow); counsel first (C-PAR-1) |
| Q-PAR-6 | Email attachments and outbound MMS: build with Phase 2 modules 22/37? | Yes, as their follow-up; not in this plan's lanes |
| Q-PAR-7 | Bulk size limits (tag/untag 10,000; stage, enroll, email, assign 2,000; text 200) and a per-tenant daily bulk-email cap (2,000) | As stated |
| Q-PAR-8 | Custom field limit (50 live) and tag limit (1,000)? | As stated; FUB limits VERIFY |
| Q-PAR-9 | In bulk email, skip people who wrote in the last 24 h? | Yes, default on, shown in the preview |

Counsel items (**VERIFY WITH COUNSEL**):
- **C-PAR-1**: batch text under state mini-TCPA laws (FL FTSA, OK, MD, others): automated-system definitions, written consent, hours, frequency.
- **C-PAR-2**: the CAN-SPAM footer wording for bulk email.
- **C-PAR-3**: the protected-proxy lexicon for tags and custom field names (military status, source of income, familial status and others, per state).

**Decided by the owner on 2026-11-11** (the owner accepted the recommended defaults):
- Bulk tag keeps the preview and confirm step (R-PAR-33, R-PAR-34); the §5 targets are 6 taps on a phone and 5 on desktop.
- Stage automation (module 67) as built: bulk stage changes and PATCH also start plans through the worker scan; Undo of a stage change puts the stage back but does not stop a plan that started (the toast says so); a stage event left undecided for more than 1 hour is never decided; when an agent's own plan for the stage is not approved, the team plan does not start in its place; annual reminders are created 7 days ahead, and contacts with no owner get none.
- Owner smart-list counts and first pages may use a semantically identical policy rewrite, provided row-by-row equivalence tests for every role prove identical rows and docs/SECURITY.md §6 documents it.

**Decided by the owner on 2026-11-11, FUB migration** (the owner accepted the recommended defaults for the gaps the FUB migration journeys lane found; DATA_MODEL Part 3 §14 E230–E233, ARCHITECTURE §13):
- **B4: a member who can no longer hold leads when the ownership stage commits** (suspended between the ownership approval and the commit; also no longer an active member, or a role that holds no leads). Nothing is ever assigned to them. The people mapped to them come in unassigned, and each record says why in plain words, for example "Brought in unassigned: Blake Chen's account is suspended." The ownership stage verifies: a planned assignment brought in unassigned for this reason is a documented outcome, counted as not imported, never a recount mismatch. The later stages proceed. The Owner reassigns the people afterwards: the stage report lists them and offers "Assign these people", which opens the existing bulk Assign with exactly their ids selected (Owner and Admin; a Team Lead reaches no unassigned person, R-OWN-18; an agent cannot bulk-assign). The import still starts no offer, SLA job or routing. A member reactivated before the commit gets their people normally, and a suspension while the commit runs never lets an assignment to that member commit after it (E230–E232).
- **B7: Follow Up Boss tasks and appointments** are not imported, and the import now says so instead of saying nothing. It counts them, read-only, at the connection test ("Count what's there") and again at the snapshot (one-record count pages, never a record; an export file's own lists are counted), and says plainly that they won't come over on the Imports page and in the final report: "Follow Up Boss has 1,240 tasks and 85 appointments. Realty OS doesn't bring tasks or appointments over: finish or note the open ones in Follow Up Boss before you switch." A count that cannot be read is said so; counting never blocks a stage. The fake FUB connector serves the counts; the real FUB endpoints (`tasks`, `appointments`) are marked VERIFY and stay configurable (`FUB_TASKS_PATH`, `FUB_APPOINTMENTS_PATH`) (E233).

### 2.3 Review (two critics; verdicts in ARCHITECTURE §20 "FUB parity design review")

Applied changes are listed there, each with the finding that caused it.

- **Security:** S1–S8, all applied. The highest was S1: an agent could make a STOP stop counting for the person's other phones with two status edits. Removing a number as a wrong number now needs a ledger record.
- **Simplicity:** cut the mentions table, the template provenance columns, custom-field protection, the smart-list ref arrays, the bulk re-preview loop, and the reason picker on phone edits. Added "Next person", the merge UI, a follow-up task on the log sheet, and tap a tag to see everyone with it.
- **Kept against a critic:** the DB batch-text ceiling, and the tag provenance kind (needed by S7).

## 3. Schema

There is one migration (`0021_fub_parity.sql`, renumbered at merge). It follows 0018's patterns:
- `tenant_id`-leading PKs and composite FKs.
- ENABLE + FORCE RLS, the RESTRICTIVE staff-only tenant policy, and support read-only policies.
- The `support_read_only` statement trigger on every new table.
- Least-privilege grants.

Details are in DATA_MODEL §11. Lanes **never change table shapes or RLS policies**. A lane that needs an index, view or definer writes it in its own migration and lists it as a security-review item. If a lane finds a schema gap, it stops and asks.

Security review items in the migration:
1. The two replaced dispatch guards. Each has one change, and it only refuses more.
2. The definer `app.contacts_stage_history` (insert-only into `contact_stage_events`).
3. The invoker guards (stage, tags, fields, templates, bulk lifecycle, bulk messages, batch-text switch, point immutability, note edits).

## 4. Modules and lanes

Numbering continues after Phase 3 (55). **Critical** means the module is on a risk path: opt-outs, tenancy, ownership, autonomy, fair housing. A critical module needs:
- property or mutation tests on its decision functions;
- an `adversarial.test.ts`;
- a security review of anything it adds to the database.

BUILD_PLAN's ground rules apply to every module:
- pure core;
- real Postgres per test (`createTestDb()`);
- Zod snapshots without confidence or tenant_id fields;
- lint rules;
- rule ids in test names for `pnpm rule-coverage --phase=parity`.

### 4.1 Lanes (5, parallel after P0)

| Lane | Modules |
|---|---|
| L1 people & notes | 56, 57, 58 |
| L2 lists | 59, 60, 61 |
| L3 templates & bulk | 62, 63, 64 |
| L4 import & duplicates | 65, 66 |
| L5 automation | 67 |

P0 is done on this branch.

| # | Name | Path (owned) | Depends on | Critical | Summary |
|---|---|---|---|---|---|
| P0 | db/parity-schema | `packages/db/migrations/0021_fub_parity.sql`, `packages/db/src/schema.ts`, `packages/db/test/{rls_smoke_parity.sql,rls_smoke_parity.test.ts,isolationFixture.ts}`, `scripts/rule-coverage.mjs` (`--phase=parity`) | — | **yes** | **Done.** Schema, guards, smoke proof. |
| 56 | core/parity-people | `packages/core/src/parity/people/**` | P0 | **yes** | Contact patch validation, replace-number plan, stage rules (R-PAR-14 mirror), mention parse, logged-activity validation, annual-date math. |
| 57 | api/people | `apps/api/src/people/**`; flagged edits listed in §4.3 | 56 | **yes** | PATCH contact, points (add/replace/remove/primary), addresses, collaborators, stage + labels, relationships, notes CRUD + mentions + logged activity, delete/restore wrappers. |
| 58 | web/people | `apps/web/src/surfaces/people-edit/**`, `apps/web/src/surfaces/notes/**`, `apps/web/src/surfaces/contact/sections.ts` (new slot registry, owned here) | 57 | no | Add-person sheet, Details section, note composer with mention picker, Log sheet, stage pill, relationships, collaborators, tasks/appointments from the person. |
| 59 | core/parity-lists | `packages/core/src/parity/{tags,fields,lists}/**` | P0 | **yes** | Tag name normalizer + lexicon classification (calls core module 20), field value validation, `SmartListDefinition` v1 + compiler plan, "coming up" date clauses. |
| 60 | api/lists | `apps/api/src/lists/**` | 59 | **yes** | Tag catalog API (create/rename/merge/protect/delete, audited), contact tag add/remove, custom field defs + values, smart lists CRUD, run/count (`GET /people?list=…`, `POST /people/query`), the perf test; exports `resolveSelection(tx, def)` for 63. |
| 61 | web/lists | `apps/web/src/surfaces/people/**` (People page; new nav entry via `shell/registry.ts`), `apps/web/src/surfaces/admin/parity/**` (tags, fields, stage labels) | 60 | no | People tab, list picker, multi-select, bulk action bar (rendering 64's sheets), tag chips, "Next person". |
| 62 | core/parity-templates-bulk | `packages/core/src/parity/{templates,bulk}/**` | P0 | **yes** | `renderTemplate` (pure, closed set, one pass), merge-field parse, bulk preflight + skip reasons, derived command ids, caps. |
| 63 | api/templates-bulk | `apps/api/src/templates/**`, `apps/api/src/bulk/**` (incl. the `bulk.run` handler, batch-text switch route); flagged edits §4.3 | 62; 60's `resolveSelection` (stub until merged) | **yes** | Templates CRUD + render-for-one; bulk create/preview/confirm/cancel/run; signature endpoint; `bulk_finished` notification. |
| 64 | web/templates-bulk | `apps/web/src/surfaces/templates/**`, `apps/web/src/surfaces/bulk/**`, `apps/web/src/surfaces/settings/batch-text/**` | 63 | no | Template picker component (exported for the compose edit), template library, bulk confirm sheets, batch-text settings page with the counsel text. |
| 65 | api/import-parity | `packages/core/src/import/**`, `apps/api/src/imports/**`, `apps/web/src/surfaces/imports/**` (Phase 1 module 6/16 files; no Phase 2 owner) | P0, 60 (tag/field writers) | **yes** | Stage map, keep-stage-as-tag, tag catalog upsert, custom field mapping, move the tag writer off `contacts.tags` + a migration that drops it (R-PAR-10). |
| 66 | api/duplicates | `apps/api/src/duplicates/**`, `apps/web/src/surfaces/duplicates/**`; one flagged edit: `packages/db/src/ownership/merge.ts` (move tags, values, relationships, stage history) | P0 | **yes** | Duplicate candidates list/dismiss, merge UI calling the existing `POST /leads/:id/merge`. |
| 67 | api/stage-automation | `apps/api/src/stageAutomation/**` (reconcile handler: stage event → enrollment; annual-date reminder tasks) | 57, 62 | **yes** (autonomy) | `auto_enroll_stage` settings route (Owner/Admin team; agent own), enrollment via the existing enrollment function, skip reasons, reminder tasks for `annual` fields. |

Release waves:

| Wave | Modules | What it delivers |
|---|---|---|
| A | 56, 57, 58 | Notes, log, edit, add, stage |
| B | 59, 60, 61 | Tags, fields, lists |
| C | 62, 63, 64 | Templates, bulk |
| D | 65, 66, 67 | Import, duplicates, automation |

The lanes run in parallel; a wave is a release unit, not a build order.

### 4.2 Interfaces (the seams between lanes)

```ts
// 56 core/parity/people
validateContactPatch(input): Result<ContactPatch>          // strict: never ownership, attribution, imported_fields
planReplacePoint(old, newAddress): { remove: {id, reason: 'replaced'}, add: NewPoint }
stageChangeAllowed(contact, actorRole): ok | 'STAGE_NEEDS_CONTACT'      // mirrors the DB guard
parseMentions(body, ids): UserId[]                          // ≤ 10, deduped, self dropped
nextAnnualOccurrence(date, tz, now): LocalDate              // 29 Feb → 28 Feb

// 59 core/parity/lists
normalizeTagName(raw): { name, key } | Issue
classifyProtected(name, lexicon): boolean                   // core module 20 lexicon
validateFieldValue(def, raw): TypedValue | Issue
SmartListDefinition (Zod v1), compileList(def, viewer): ListPlan   // plan nodes only; no SQL
// 60 api/lists
resolveSelection(tx, { contactIds } | { listId } | { definition }): ContactId[]   // detail-visible only, ≤ cap

// 62 core/parity
renderTemplate(template, ctx: OnePersonContext): { subject?, body, missing: Field[] }
bulkPreflight(kind, person, facts): ok | SkipReason          // same checks as canContact for sends
derivedCommandId(actionId, contactId): Uuid                  // v5, idempotent ownership commands
```

### 4.3 Flagged edits in files other modules own (minimal and additive; the owner reviews)

| File (owner) | Lane / module | Exact edit |
|---|---|---|
| `apps/api/src/comms/dispatch.ts` (Phase 2 module 22) | 63 | In TX1, no `touch` when `m.bulkActionId !== null` (one condition). The DB view already excludes bulk |
| `apps/api/src/comms/repos/messages.ts` (22) | 63 | Select `bulk_action_id` into `MessageRow.bulkActionId` |
| `apps/api/src/comms/compose.ts` (22) | 63 | `ComposeInput.bulkActionId?` + `purposeOverride?: 'marketing'` passed to the insert. No behaviour change when absent |
| `apps/api/src/comms/render.ts` (22) | 63 | Append `memberships.email_signature` (plain text) above the brokerage footer |
| `apps/api/src/leads/{schemas,contacts}.ts` (22) | 57 | Optional `stage`, `tags`, `leadSourceId`, `address` on create, in the same transaction; email points get a label |
| `apps/api/src/leads/repos/timeline.ts` (22) | 57 | Map `stage` items and `logged_activity:<kind>` detail |
| `apps/api/src/leads/views.ts`, `leads/repos/contacts.ts` (22) | 60 | Read tags from `contact_tags` (detail view only) instead of `contacts.tags` |
| `packages/core/src/priority/**` / `accountability` `deriveExceptions` (18a) | 63 | Exclude `messages.bulk_action_id IS NOT NULL` from `failed_send` inputs (like R-MKT-8) |
| `apps/web/src/surfaces/compose/ComposeBox.tsx` (37) | 64 | One optional prop `templatePicker?: ReactNode` rendered beside Send, plus a "Send later" control for the existing `scheduleAt`. Inserts text only; no send logic |
| `apps/web/src/surfaces/contact/ContactPage.tsx` (Phase 1 web) | 58 | One import + `<ContactSections/>` rendering `sections.ts`; 61/64 add one entry each to `sections.ts` |
| `packages/db/src/ownership/merge.ts` (Phase 1 module 7) | 66 | Move `contact_tags`, `contact_field_values`, `contact_relationships`, `contact_stage_events` of the loser (R-PAR-45) |
| `apps/api/src/assistant/enrollments.ts` (26) | 67 | Export the existing single-enrollment function, if it is not exported yet; no logic change |
| Registries (`routes.ts`, `worker/handlers/index.ts`, `errors.ts`, `foundation/authz.ts`, `shell/registry.ts`, `audit.ts` action union) | each lane | CONVENTIONS §3 additive protocol |
| `apps/api/src/audit.ts` field classification | each lane, for its own columns | P0 left every new column in the fail-closed PII class (snapshot `audit.test.ts.snap`). A lane may move a column it owns to a non-PII class (e.g. `kind`, `status`, `field_type`) with the snapshot update in the same commit |
| `apps/web/src/surfaces/feed/**`, `thread/**` | — | **No edit.** Mentions arrive as notifications |

### 4.4 Module details

Each module lists its rules, tests and acceptance criteria. Every module also has a role × route matrix test (generated from `foundation/authz.ts`).

**56 core/parity-people.**
- Rules: R-PAR-3, 11, 14, 20, 31, 43.
- Tests: property tests for `stageChangeAllowed` against the DB guard's truth table, `parseMentions` (dedupe, ≤ 10, self), and `nextAnnualOccurrence` (leap years, DST).
- Accept: the replace plan never edits an address in place.

**57 api/people.**
- Rules: R-PAR-1–5, 7 (opt-out tag prompt), 11–15, 21–22, 30–32, 43–44.
- Tests:
  - per route × role (Owner/Admin/TL/Agent/ISA/TC + support read-only);
  - adversarial: pond card PATCH → 404; edit a removed opted-out point → still blocked; mention someone without access → `no_access` and no notification;
  - mention check runs as the mentioned user (a separate read-only `withTenantTx`), and the author's transaction writes the notification;
  - concurrency: two tabs with `row_version`.
- Accept: add note in 2 taps on phone; edit a phone in 3; log a call in 3.

**58 web/people.**
- Rules: genuineness (logged items say "Logged by"; locked stages show "Reach them first: Call · Text" before the tap, not after).
- Tests: Playwright phone (iPhone 14) + desktop for add person, note + mention, log call + follow-up task, stage change with Undo toast, replace number, add relationship; axe; 44 pt targets.
- Accept: the tap targets in §5.

**59 core/parity-lists.**
- Rules: R-PAR-6, 8, 17–20, 27–29.
- Tests:
  - fuzz the definition compiler: every value is a bound parameter; no clause produces raw SQL;
  - lexicon classification cases;
  - field validation per type.
- Accept: a definition referencing a protected tag is flagged for the audience check.

**60 api/lists.**
- Rules: R-PAR-6–10, 17–19, 27–29.
- Tests:
  - per-role list results: the TL's team list run by an agent; pond cards never returned;
  - tag merge counts (`tag.merge` audit);
  - perf test at 250k contacts / 1M tag links / 2M values: p95 first page ≤ 400 ms, count ≤ 800 ms, for an Owner and for an Agent with 2k, plus `EXPLAIN` index-use assertions;
  - `LIST_TOO_SLOW` at 3 s.
- Accept: open a list in 1 tap on desktop and 2 on phone.

**61 web/lists.**
- Tests: Playwright phone + desktop for the People tab, select all, the bulk bar, tag chip → unsaved list, "Next person" from a list.
- Accept: bulk-tag 30 people from a list in 5 taps on phone; inline (no preview step) up to 500 people with one count-confirm sheet.

**62 core/parity-templates-bulk.**
- Rules: R-PAR-24, 26, 33–40.
- Tests:
  - property: rendering for person X never outputs a value of any other fixture person;
  - literal one-pass (`{{agent.email}}` in a name);
  - CR/LF stripped in the subject;
  - `bulkPreflight` agrees with `canContact` on the shared opt-out case table (`packages/db/test/fixtures/opt_out_cases.json`).
- Accept: no template can produce "Hi ,".

**63 api/templates-bulk.**
- Rules: R-PAR-23–26, 33–42.
- Tests:
  - adversarial: a bulk send to an opted-out address is blocked by the DB guard even with core bypassed;
  - a creator who loses visibility mid-run → `skipped NOT_VISIBLE`;
  - a suspended creator stops the run;
  - batch text refused while off and when switched off mid-run;
  - `assign` by an agent refused;
  - idempotent replay of `bulk.run` after a crash (no double send; the stale-dispatch sweeper owns `dispatching` rows);
  - one send per address;
  - no `failed_send` exception for bulk;
  - `bulk_finished` counts by reason.
- Accept: bulk email from a list in 5 taps on phone, with skip counts by reason shown before Confirm.

**64 web/templates-bulk.**
- Tests: template picker inserts text and the preview shows the footer; batch-text page shows the counsel text and requires re-auth; confirm sheets list skips by reason.
- Accept: a template text in 3 taps on phone.

**65 api/import-parity.**
- Rules: R-PAR-10, 46.
- Tests:
  - FUB e2e with custom fields of each type;
  - 1,400 tags → `TAG_LIMIT`;
  - stage map reset on change;
  - revert removes only batch rows;
  - fill-empty never overwrites;
  - the column-drop migration leaves no reader (grep test).
- Accept: a FUB stage label never silently becomes `new`; it is either mapped by the Admin or reported.

**66 api/duplicates.**
- Rules: R-PAR-44, 45, R-OWN merge rules.
- Tests: a merge moves tags/values/relationships/stage history and drops self-pairs; a person-level do-not-contact follows the merge (E140 unchanged).
- Accept: resolve a duplicate in 3 taps.

**67 api/stage-automation.**
- Rules: R-PAR-16, 20.
- Tests:
  - stage entry enrolls only from an approved version;
  - never a second live enrollment;
  - an import stage change never enrolls;
  - the agent playbook wins over the team playbook for the agent's own contacts (E172);
  - the skip reason is shown to the person who changed the stage;
  - annual reminders are created once per occurrence (dedupe key).
- Accept: "Stage → Active starts the buyer plan", visible on the stage change toast.

## 5. Phone and desktop UI, with tap targets versus FUB

The phone layout:
- A **People** tab joins Home, Approvals, Search and Tasks (the More menu keeps the rest).
- The contact page gains:
  - **Tags** chips under the name;
  - a **Details** section (custom fields, addresses, relationships, collaborators, pencil to edit);
    - *As built (lead-journey fixes, J6).* Other modules add to Details through module 58's slot registry
      (`apps/web/src/surfaces/contact/sections.ts`, `slot: 'details'`, rendered by `DetailsSlots` inside
      `DetailsSection`). The custom fields entry (`people/ContactFields.tsx`) shows each live field's value in the
      field's own terms (number, date, choice names) from module 60's `GET /contacts/:id/fields`; archived fields
      are not shown. "Edit fields" appears only when the details say the viewer may edit the person (`contact.edit`)
      and saves each changed value with `PUT /contacts/:id/fields/:fieldId`; everyone else reads them.
    - *Removing a number (R-PAR-12, J3.3).* The pencil's sheet keeps the one-tap **Remove** (reason `old`, with
      Undo). **Remove as a wrong number** is offered only on a point whose consent ledger holds a wrong-number report
      (a call from the app marked "Wrong number", or a reply saying so: `GET /contacts/:id/points`
      `wrongNumberReported`, the remove route's own test); every other saved point says why it is not offered. A
      wrong-number removal has no Undo (a confirmed wrong number is never added back).
  - a sticky **Note** button and **Log** next to Call/Text/Email;
  - **Add task** and **Add appointment** in their sections.
- A global **+** opens Add person.

The desktop layout:
- The same sections.
- An always-visible note box.
- The People page with lists in the sidebar, checkboxes and a bulk bar.

iOS is the bar:
- 44 pt targets;
- bottom-sheet pickers;
- keyboard-safe Save;
- VoiceOver labels ("Tag Buyer, remove");
- Undo toasts instead of confirm modals for reversible one-person edits.

Taps are counted from the person's page (or the People tab where stated); typing is not counted. **Every FUB count is VERIFY** against the current FUB iOS app and web.

| Job | Phone | Desktop | FUB (VERIFY) |
|---|---|---|---|
| Add a note | Note → Save = **2** | type in box → ⌘↵ = **1** | ~3 / ~2 |
| @mention | `@` + tap name (+0) | same | similar |
| Tag (existing or new) | + → tap tag = **2** | + → ↵ = **1** | ~4 / ~3 |
| See everyone with a tag | tap chip = **1** | click chip = **1** | ~3 |
| Add a person | + → Save = **2** (+1 on duplicate warning) | + → ↵ = **1** | ~4 / ~3 |
| Edit / replace a phone | Details ✎ → field → Save = **3** (no reason picker) | inline → ↵ = **1** | ~3 / ~2 |
| Change stage | pill → stage = **2** (toast with Undo) | **2** | ~2–3 |
| Template text | Text → Templates → template → Send = **4**; **3** from the composer | Text → `/name` ↵ → Send = **3** | ~4 / ~4 |
| Log an outside call | Log (Call preselected) → outcome → Save = **3** | **3** | ~4 / ~3 |
| Open a smart list | People → list = **2** | **1** | ~2 / ~1 |
| Next person in a list | Next = **1** | J / → = **1** | ~2 |
| Bulk tag 30 | People → list → Select all → Tag → tag → Confirm = **6** (the preview and confirm that R-PAR-33/34 require; owner decision 2026-11-11) | **5** | ~6 / ~5 |
| Bulk email | People → list → Select all → Email → template → Confirm = **6** (skips shown on the confirm sheet) | **5** | ~7 / ~6 |
| Bulk assign (Owner/Admin/TL) | desktop-first; phone same as tag + target = **6** | **5** | ~5 |
| Resolve a duplicate | Duplicates → pair → Merge = **3** | **3** | ~4 |

Honest UI rules:
- Skipped people are listed by reason, never hidden.
- Logged items always say "Logged by …".
- The batch-text page states the counsel note.
- No bulk option exists to include opted-out people: there is nothing to pre-tick.
- Lists say "Showing people you can see".

## 6. Exit criteria

1. `pnpm -r typecheck && pnpm lint && pnpm --filter @realty/db test && pnpm --filter @realty/api test` green. `pnpm rule-coverage` (Phase 1) exits 0, and `pnpm rule-coverage --phase=parity` exits 0, with every R-PAR rule and E162–E193 linked to a passing test.
2. The parity smoke proof (`rls_smoke_parity.sql`) passes with all applied review findings named.
3. Playwright phone + desktop runs for every job in §5 meet the tap targets.
4. The perf test meets R-PAR-29 at 250k contacts.
5. Counsel items C-PAR-1–3 are answered before batch text is enabled for any tenant and before the protected-proxy lexicon is called complete.
