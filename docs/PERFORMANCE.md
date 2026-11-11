# Realty OS: Performance at 250,000 contacts (lane scale-250k)

This page answers one question with measurements: does the app stay fast for a large team? It covers a team with
250,000 contacts and 50 agents, with row-level security (RLS) on, measured the way the API really runs.
It also lists what was fixed, what still misses its budget, and what it would take to fix that.

**Short answer.** Most of the phone's daily reads now pass with margin:
- contact page
- thread
- timeline
- exception queue
- pond
- an agent's scoreboard
- send/dispatch

Five things still miss their budget at 250k:
- **The Priority Feed** (p95 2.5 s for the busiest agent, 1.4 s for the median one, against 150 ms; before: 32 s
  and 10 s). It recomputes the whole book on every GET.
- **Search.** It waits out its 300 ms branch timeout because messages and notes cannot use an index under RLS.
- **The team scoreboards** (lead 0.40 s, admin 0.93 s).
- **A TC's thread** on a TC who sits on about 2,900 deals (0.71 s).
- **Accept and claim** when 40+ agents tap at once (0.63–0.69 s).

The 50k-row import dry run used to fail every time and now finishes (in 2.6 minutes). The remaining misses need
design decisions. None of them can be fixed by an index, and each is described under [Still missing](#still-missing).

## 1. Machine

All numbers come from one machine. The database and the API process ran on the same host, and nothing else was running
during a timed run.

| | |
|---|---|
| CPU | Intel Xeon @ 2.10 GHz, 4 cores (cloud VM) |
| RAM | 16 GB |
| Disk | network block device (cloud VM) |
| Postgres | 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), default settings (shared_buffers 128 MB) |
| Node | 22 |

Expect a production database (more cores, tuned `shared_buffers`) to be faster. Read the before/after ratios as
the result, and the absolute numbers as an upper bound.

## 2. Data set (`pnpm load:seed --contacts 250000`)

The generator is deterministic. Every id, name, count and time offset is a hash of (tenant, row, salt), and times are
offsets from one anchor instant per run. The data is bulk-loaded as the owner role with **every trigger and constraint
on**. It goes through:
- the ownership ledger guard: every contact has a 1–3 event ledger whose head matches the projection
- the 0013/0014 dispatch guards: every outbound message and call was checked against opt-outs at insert time
- the consent projection guard
- the append-only ledgers

Then it runs the real exception recompute and `ANALYZE`.

Opt-out addresses are HMACed with each tenant's own HMAC key, so `canContact` and the database guards see them exactly
as they see real ones. The benchmark checks this: a STOP number is never sent to.

| table (all tenants) | rows |
|---|---:|
| contacts | 265,000 (250,000 in the large tenant + 3 × 5,000) |
| contact_points | 482,363 |
| messages | 2,074,527 |
| calls | 264,294 |
| notes | 154,906 |
| lead_ownership_events | 750,399 |
| tasks / appointments | 51,073 / 5,736 |
| deals / deal_members / listings | 3,176 / 3,024 / 560 |
| consent_events / consent_state / suppressions | 89,321 / 96,269 / 9,176 |
| behavior_events / lead_inquiries | 278,884 / 265,000 |
| exception_items (from the real recompute) | 11,344 in the large tenant |

**People in the large tenant.** 1 owner, 1 admin, 3 team leads with their teams and team ponds, 50 agents, 1 ISA and 1 TC.

**Ownership states and books.**
- States: 85.5 % owned, 10 % in a pond, 0.5 % live offers, 2 % unassigned, 2 % closed.
- Books are skewed. The busiest agent owns 18,660 contacts and the median agent 3,492.
- The TC sits on every active deal (about 2,900).
- The ISA collaborates on 1 % of leads.

**Opt-outs.**
- 2 % of phones texted STOP (with the inbound STOP message).
- 1 % of emails unsubscribed.
- 0.3 % have an agent-recorded do-not-contact.
- Hard bounces, spam complaints and landline suppressions are included too.

**Exception material.** The data includes material for every exception type (untouched leads, overdue promises, failed
sends, missing outcomes).

**This data is deliberately busy.** About a third of the contacts had activity in the last 14 days. The feed's cost
grows with the number of *unanswered* conversations in a book (about 3,000 for the busiest agent here), so a quieter
real book will be faster than these numbers.

## 3. Method (`pnpm load:bench`)

The bench drives **the real server in process** (`buildServer` + `app.inject`), with sessions issued by the real
`issueSessionTx`. Each call goes through:
- cookie resolution
- the route's `authorize`
- `withTenantTx` (`SET LOCAL` tenant, user, actor and principal, exactly as production does)
- the repositories, connected as `app_user` with FORCE RLS
- Zod response serialization

The providers are the deterministic fakes, so no network is involved. The pool has 20 connections and the statement
timeout is the production default (30 s). Every operation gets warm-up calls first. Then n timed sequential calls
give p50 and p95. A failed call counts at the time it took to fail.

Plans were collected with `pnpm load:bench --explain`. This turns on `auto_explain`
(`log_analyze`, `log_buffers`, every statement over a threshold) for the load database, so the plans are of the
API's own SQL under the API's own RLS context. Timings from an `--explain` run are instrumented and are never
reported as results.

**Budgets.**
- Feed p95 < 150 ms and search p95 < 300 ms: from the [BUILD_PLAN](BUILD_PLAN.md) Phase 1 exit criterion 4.
- Every other read used on a phone: p95 < 300 ms, the lane rule.
- Taps (accept, claim, send): the same 300 ms. There is no doc budget for them.
- The import dry run: reported only, as a background job.

**Before and after.**
- Before = commit `5ef8089` (migrations 0001–0014, original queries), on a fresh 250k seed.
- After = the lane's final commit (0016 + query rewrites + JIT off), on a fresh 250k seed of the same deterministic
  data.

Each run consumes live offers, pond leads and send targets, so every run starts from a fresh seed.

## 4. Results

Raw results: `docs/perf/before-250k.json` and `docs/perf/after-250k.json` (`node scripts/perf-table.mjs` renders this table). The before feed and import rows use n = 3 and n = 1 (a call takes 10–32 s); every other row uses n = 20 (n = 10 for the after feed). Accept and claim rows time every request of the concurrent batch.

| operation | budget (p95) | before p50 | before p95 | after p50 | after p95 | after |
|---|---:|---:|---:|---:|---:|---|
| feed: GET /feed (busiest agent) | 150 ms | 32.33 s | 32.33 s | 2.34 s | 2.50 s | **miss** |
| feed: GET /feed (median agent) | 150 ms | 10.28 s | 10.43 s | 1.12 s | 1.36 s | **miss** |
| search name: GET /search (agent) | 300 ms | 311 ms | 317 ms | 310 ms | 316 ms | **miss** |
| search phone: GET /search (agent) | 300 ms | 308 ms | 312 ms | 308 ms | 312 ms | **miss** |
| search email: GET /search (agent) | 300 ms | 308 ms | 312 ms | 308 ms | 313 ms | **miss** |
| search name: GET /search (admin) | 300 ms | 311 ms | 315 ms | 308 ms | 313 ms | **miss** |
| search phone: GET /search (admin) | 300 ms | 309 ms | 312 ms | 309 ms | 312 ms | **miss** |
| search email: GET /search (admin) | 300 ms | 307 ms | 311 ms | 307 ms | 312 ms | **miss** |
| contact page: 6 calls in parallel (busiest agent) | 300 ms | 67 ms | 83 ms | 53 ms | 69 ms | pass |
| contact timeline alone: GET /contacts/:id/timeline?limit=100 | 300 ms | 34 ms | 50 ms | 22 ms | 32 ms | pass |
| thread: contact + timeline (chattiest contacts, 97–57 messages) | 300 ms | 117 ms | 157 ms | 41 ms | 47 ms | pass |
| thread as the TC (deal visibility): contact + timeline | 300 ms | 326 ms | 710 ms | 326 ms | 714 ms | **miss** |
| exception queue: GET /team/exceptions?state=live&limit=200 (team lead) | 300 ms | 6.67 s | 6.91 s | 267 ms | 283 ms | pass |
| exception queue: GET /team/exceptions?state=live&limit=200 (admin) | 300 ms | 6.31 s | 6.61 s | 187 ms | 202 ms | pass |
| exception queue: GET /team/exceptions?state=live&limit=200 (busiest agent) | 300 ms | 1.01 s | 1.14 s | 78 ms | 94 ms | pass |
| scoreboard: GET /scoreboard?range=7d (busiest agent) | 300 ms | 546 ms | 598 ms | 40 ms | 52 ms | pass |
| scoreboard: GET /scoreboard?range=90d (busiest agent) | 300 ms | 805 ms | 900 ms | 188 ms | 212 ms | pass |
| team scoreboard: GET /team/scoreboard?range=30d (team lead) | 300 ms | 1.12 s | 1.25 s | 349 ms | 403 ms | **miss** |
| team momentum: GET /team/momentum (team lead) | 300 ms | 22 ms | 27 ms | 23 ms | 25 ms | pass |
| team scoreboard: GET /team/scoreboard?range=30d (admin) | 300 ms | 1.94 s | 2.08 s | 879 ms | 927 ms | **miss** |
| team momentum: GET /team/momentum (admin) | 300 ms | 31 ms | 38 ms | 31 ms | 46 ms | pass |
| pond cards: GET /ponds/:id/cards?limit=50 (median agent) | 300 ms | 213 ms | 248 ms | 216 ms | 256 ms | pass |
| pond cards: GET /ponds/:id/cards?limit=50 (team lead) | 300 ms | 144 ms | 154 ms | 151 ms | 187 ms | pass |
| pond list: GET /ponds (admin) | 300 ms | 24 ms | 28 ms | 24 ms | 27 ms | pass |
| accept: 200 live offers, 47 agents accepting at once | 300 ms | 417 ms | 763 ms | 428 ms | 693 ms | **miss** |
| claim: 20 pond leads, 10 agents racing on each (all requests) | 300 ms | 114 ms | 159 ms | 114 ms | 160 ms | pass |
| claim: 44 agents each claim a different lead at once | 300 ms | 528 ms | 569 ms | 576 ms | 625 ms | **miss** (wall 637 ms) |
| dispatch: 500 immediate SMS sends, concurrency 8 | 300 ms | 271 ms | 331 ms | 223 ms | 264 ms | pass (35.7 sends/s end to end) |
| import: 50000-row CSV dry run (job, one transaction) | — | 32.01 s | 32.01 s | 156.51 s | 156.51 s | no budget (create + snapshot 326 ms before it) |

Checks (after):
- ok: accept: every live offer accepted by its offeree: 200/200 accepted; others: none
- ok: claim race (E1): exactly one winner per lead: 20/20; losers: 409 LEAD_ALREADY_CLAIMED ×180
- ok: claim race (E1): every loser gets a 409 naming the reason: 409 LEAD_ALREADY_CLAIMED
- ok: uncontested claims all succeed: 44/44
- ok: dispatch: every reachable send went out: 500/500 sent; other results: none
- ok (re-checked): D1: opted-out numbers are never sent to: 30/30 not sent (200 blocked:CONSENT_REVOKED); 0 outbound rows went out to them. The first after-run reported this check as FAILED. Its own counting was wrong: it counted sent rows created in the last hour, and on a fresh seed, seeded history slid out of that window during the check (4,575 → 4,574, a decrease). The check now counts outbound rows to the opted-out contacts since the attempt began. The dispatch-only re-run (`docs/perf/after-250k-dispatch-recheck.json`: 500/500 sent, p95 284 ms, 34.7 sends/s) passes.
- ok: import dry run: counts reconcile: dry_run_ready {"source":50000,"willImport":1495,"imported":null,"needsReview":48505,"rejected":0,"duplicate":0}

Checks (before):
- ok: accept: every live offer accepted by its offeree: 200/200 accepted; others: none
- ok: claim race (E1): exactly one winner per lead: 20/20; losers: 409 LEAD_ALREADY_CLAIMED ×180
- ok: claim race (E1): every loser gets a 409 naming the reason: 409 LEAD_ALREADY_CLAIMED
- ok: uncontested claims all succeed: 44/44
- ok: dispatch: every reachable send went out: 500/500 sent; other results: none
- ok: D1: opted-out numbers are never sent to: 30/30 not sent (200 blocked:CONSENT_REVOKED); sent rows 500 → 500
- FAILED: import dry run: counts reconcile: failed null

## 5. What was slow, and why

### 5.1 Per-row visibility checks (the root cause)

Child tables (messages, calls, notes, contact_points, recordings, …) check every row with
`app.contact_detail_visible(tenant_id, contact_id)`.

**Why it is expensive.**
- Postgres never inlines that SQL function: its body has an `EXISTS` sublink, and `inline_function` refuses
  `hasSubLinks`. So every row runs it separately.
- Inside, the `contacts` SELECT policy is evaluated again, with its InitPlans.
- Those InitPlans are SECURITY DEFINER helpers with their own `search_path`. A nested definer call costs about 0.1 ms.

**The cost is decided by branch order.** InitPlans run lazily, in the order the OR branches are written, so the order
of the branches decides how many helpers run per row. Measured as an agent, through RLS:

| per-row check | cost |
|---|---:|
| `contact_detail_visible` on the agent's own contact, before 0016 | 0.65 ms |
| … after 0016 | 0.14 ms (the floor for any RLS'd SQL-function `EXISTS` here is 0.13 ms) |
| on a contact the caller **cannot** see (every policy branch runs) | about 1.5 ms |
| on a deal contact, as the TC on about 2,900 deals | 11.7 ms (`my_deal_contact_ids()` alone is 9.5 ms per call) |

The third row was the big one. **Any scan that reaches rows the caller cannot see pays about 1.5 ms per row.** Example:
the feed's "waiting for your reply" query scanned the tenant's 14-day message window, about 375k rows at 250k. RLS
then threw away other agents' rows one function call at a time.

### 5.2 Other causes

- **JIT.**
  - RLS row estimates and set-returning definers (default `ROWS 1000`) pushed short statements past `jit_above_cost`.
  - Compiling a 36 ms scoreboard query took 605 ms.
  - 21 of the slowest app statements at 20k were paying for JIT.
- **Exception queue.**
  - To count by type, the queue loaded up to 10,000 full queue rows a second time, each with a visibility check and an
    un-hoisted definer call.
- **Dispatch guard.**
  - The 0013/0014 guards look recipients up by `(tenant, kind, address)`, including removed points.
  - The only index on those columns is partial (`removed_at IS NULL`), so the guard used the trigram GIN index:
    0.39 ms per send.
- **Opt-out lookups by address.**
  - `consent_state`'s primary key has `purpose` between `channel` and `address_hmac`, so each probe walked the
    channel's range.
- **Scoreboard counts.**
  - Index scans with a heap visit per row, because the partial index lacked the function's `NOT imported` filter.
- **Import dry run.**
  - It reads the whole book: 265k contacts and 455k points, each through RLS at ≥ 0.1 ms even for the tenant-wide
    system actor.
  - That is longer than the pool's 30 s statement timeout, so **every dry run failed** at 250k.

### 5.3 The plan that mattered most (auto_explain, ANALYZE + BUFFERS)

The feed's "waiting for your reply" query for the busiest agent.

**Before** (20k contacts, already 25 s). Every message of the tenant's 14-day window goes through the per-row check
before the join narrows it to the agent's book:

```
Bitmap Heap Scan on messages m  (actual time=18.465..25203.805 rows=5706 loops=1)
  Filter: ((NOT imported) AND (direction = 'inbound') AND app.contact_detail_visible(tenant_id, contact_id))
  Rows Removed by Filter: 24750
  Buffers: shared hit=379473 read=6453
  ->  Bitmap Index Scan on messages_contact_idx  (rows=30776)
        Index Cond: ((tenant_id = app.tenant_id()) AND (occurred_at > (now - '14 days')))
```

**After** (250k contacts, 18,678 contacts in the book). One index range probe per own contact. Only messages after
the contact's last touch reach the check:

```
Nested Loop  (actual rows=4662 loops=1)
  ->  Index Scan using messages_contact_idx on messages m  (actual rows=0 loops=18678)
        Index Cond: ((tenant_id = c.tenant_id) AND (contact_id = c.id) AND (occurred_at > c.since))
        Filter: ((NOT imported) AND (direction = 'inbound') AND app.contact_detail_visible(tenant_id, contact_id))
  Buffers: shared hit=65854 read=27058
```

The full plan logs are produced by `pnpm load:bench --explain`. They are not committed: they hold synthetic addresses
and are 10–15 MB per run.

## 6. What changed

**Who sees what does not change.** None of these adds a SECURITY DEFINER function or bypasses RLS.

| change | where | effect |
|---|---|---|
| `contact_detail_visible` tests the row's `ownership_state` before calling `sees_all_detail()` | `0020_scale_250k.sql` | 0.65 → 0.14 ms per child row |
| `contacts_select` leads with the caller's own-book disjunct (a copy of the first alternative of its last branch) | `0020_scale_250k.sql` | `is_tenant_wide()` no longer runs per row for one's own book |
| index `contact_points (tenant_id, kind, address)` | `0020_scale_250k.sql` | dispatch guard 0.39 → 0.14 ms per send; bulk load of 1.95M messages 3,215 s → 574 s |
| index `consent_state (tenant_id, address_hmac)` | `0020_scale_250k.sql` | opt-out probes across purposes |
| partial indexes matching `app.scoreboard_activity`'s filters | `0020_scale_250k.sql` | index-only counts |
| feed: unanswered messages and missed calls read by per-contact index range scans from the agent's own book (a materialized CTE keeps `since` a plain column, so it stays an index condition under RLS) | `workspace/repos/feedInputs.ts` | no row of another agent ever reaches the visibility check |
| feed: computed cards parsed once per statement (materialized CTE) | `workspace/feed.ts` | no re-parse per stored card |
| exception queue: live counts are counted (`liveCounts`), not loaded; `my_team_member_ids()` hoisted to an InitPlan | `accountability/repos/exceptions.ts`, `accountability/exceptions.ts` | team lead 6.9 s → 283 ms (p95) |
| `jit=off` on every pooled application connection | `packages/db/src/client.ts` | removes compile time from short statements |
| the dry run's whole-book read gets a 10-minute statement timeout, scoped to its own transaction | `imports/repos/existing.ts` | the 50k dry run completes instead of failing |

**Proof that visibility is unchanged.** The equivalence tests check every change above that could affect who sees
what or what a query returns:

- **`apps/api/src/load/rls_equivalence.test.ts`.** It compares the 0001 and 0016 versions for:
  - every role (owner, admin, team lead, agent, ISA, TC) and the system actor
  - every contact of a generated tenant: owned, offered, team pond, unassigned, closed, collaborated, on a deal
  - four variants of each row: soft-deleted, and moved by the caller's current ownership command

  The `contacts_select` expression is compared row by row (0 differences out of 8,000 rows per actor), and
  `contact_detail_visible` call by call through RLS as `app_user`.
- **`apps/api/src/load/feed_inputs.test.ts`.** The rewritten feed inputs equal the original SQL for every agent, plus
  boundary rows: before or after the last touch, inside or outside the 14-day window, another agent's contact.
- **`apps/api/src/load/exception_counts.test.ts`.** For every viewer, with and without the owner filter, the counts
  equal the queue rows they summarize.

One behaviour changed on purpose. With more than 10,000 live items, the queue's counts used to stop at 10,000 (the
cap of the read they came from). They now count every live item the viewer can see.

## 7. Still missing

These miss their budget after the fixes. Each needs a decision from the owner, not an index.

1. **Priority Feed (p95 2.5 s busiest / 1.4 s median against 150 ms).**
   - `GET /feed` recomputes every card from source rows for the whole book on each call (and the web app polls it every
     30 s).
   - After the fixes, the remaining cost is legitimate per-row RLS on the agent's own unanswered messages (about 3,000
     in the busiest book × 0.14 ms), plus the channel hints and the card upserts.
   - It now scales with the size of the book's backlog, not with the tenant.
   - Meeting 150 ms needs an incremental feed. Cards would be written by the events and jobs that create or clear them
     (the outbox the feed already uses for offers and drafts), and the GET would read only stored cards.
   - That is an architecture change to module 14.
2. **Search (p95 about 310 ms against 300 ms).**
   - The contact, phone, email and address branches are fast (indexed, leakproof keys from 0011).
   - The `notes` and `messages` branches cannot use their GIN index. `tsvector @@ tsquery` is not leakproof, so under
     RLS Postgres must run the visibility check on every message before matching. The branches therefore always reach
     their 300 ms timeout and come back `incomplete`, and that sets the request's latency.
   - Options, all for the owner:
     1. a security review that allows marking `ts_match_vq` LEAKPROOF (superuser, platform-wide)
     2. a visibility-scoped token index
     3. a shorter branch timeout for notes/messages (a product change: more `incomplete`)
3. **Team scoreboard (p95: lead 0.40 s, admin 0.93 s).** The agent's own 7-day and 90-day scoreboards now pass (52 ms and 212 ms).
   - The remaining time is real counting: SLA periods from the ledger, plus calls, texts and appointments per member and
     range.
   - The usual fix is a daily rollup table that the scoreboard reads for full past days, plus a live count for today.
   - That is a new table and job, out of this lane's scope.
4. **Thread as a TC on about 2,900 deals (p95 about 0.7 s).**
   - The contacts policy's deal branch rebuilds `app.my_deal_contact_ids()` (about 5,800 ids, 9.5 ms) for every row the
     TC reads. This is the "TC on 1,000 deals" risk in ARCHITECTURE §risks.
   - A fix needs either a per-row definer membership test or a policy redesign. Both are security-review items, and
     this lane may not add definers.
5. **Accept and claim with 40+ agents tapping at once (p95 0.63–0.69 s).**
   - Single taps and the 10-way race on one lead pass (the race test: exactly one winner, every loser gets a 409
     `LEAD_ALREADY_CLAIMED`).
   - With 44–47 simultaneous requests on a 20-connection pool, part of the latency is queueing for a connection.
   - The next step is a profile of the ownership command under that load, and a decision on pool size per API instance.
6. **Import dry run (157 s for 50k rows against a 250k book).** It completes now, but it reads the whole book
   through RLS. If imports into large tenants must be interactive, dedupe should read only the candidates matching
   the file's addresses and names. That changes core/import's interface.
7. **Exception recompute (16 s for the large tenant).**
   - The 60-second `exceptions.recompute` job took 16 s for the large tenant, on the final schema and with JIT off
     (measured during the final seed).
   - It is not on a phone path, but it is a quarter of its own period. Re-measure it on the final schema, and consider a
     per-contact recompute driven by events.

## Smart lists (R-PAR-29, lane par-lists)

Measured on the same machine on the 250k seed plus the list workload (`apps/api/src/lists/perf/seedLists.ts`:
200 tags, 5 of them protected; 10 custom fields; 1,033,178 tag links and 2,119,746 typed values across all
tenants, 975,407 links in the large tenant), through the real server in process (`listsBench.ts`, n = 20 per
operation after 2 warm-ups), for the Owner and for the agent whose book is closest to 2,000 (2,634 people).
Budget: first page p95 ≤ 400 ms, count p95 ≤ 800 ms, 3 s statement timeout.

| list (14 definitions) | Owner page p95 | Owner count p95 | Agent page p95 | Agent count p95 |
|---|---:|---:|---:|---:|
| everyone (People tab) | 54 | 16 | 84 | 9 |
| tag: popular (≈ 4 % of people) | 84 | **3,015 (timeout)** | 96 | 56 |
| tag: rare (≈ 1 %) | 116 | **1,773** | 48 | 26 |
| tag: none of | 93 | 206 | 91 | 46 |
| stage + active in 30 days | 52 | 28 | 49 | 9 |
| my new leads with a tag | 8 | 7 | 28 | 13 |
| budget ≥ 1.5M (number field) | 120 | **3,012 (timeout)** | 316 | 308 |
| birthday in 14 days (annual date) | 386 | **3,008 (timeout)** | 324 | 326 |
| features pool + timeline now (choices) | 292 | **3,015 (timeout)** | **406** | 363 |
| overdue task | 54 | 311 | 52 | 20 |
| name contains | 240 | 101 | 46 | 16 |
| OR group (tag or stage) | 87 | **925** | 61 | 23 |
| everyone by name | 313 | 16 | 53 | 12 |
| everyone by next task | **638** | 18 | 66 | 17 |

50 of 58 within budget (second pages included). Every Agent run but one is within budget. What misses:

- **Owner counts of a broad tag or field filter.** Under the P0 policies every `contact_tags` /
  `contact_field_values` row read costs one `app.contact_detail_visible()` call (≈ 0.19 ms), and numeric,
  array, EXTRACT and LIKE comparisons are not leakproof, so they cannot run as index conditions before the
  policy. An exact count to 10,000 therefore pays up to 10,000 policy calls. A 3 s run ends `LIST_TOO_SLOW`
  and the page says "Count unavailable" (the rows still load).
- **Owner "by next task" first page** (638 ms): the sort key is a per-person sub-query over 250k people.
- **Agent "features pool + timeline now"** (406 ms): two per-person value probes, each paying the policy.

Two plan rules made the rest pass (both in `apps/api/src/lists/repos/people.ts`, proven by the CI-sized
`lists.perf.test.ts` and the equality tests): every detail predicate is a per-person probe by primary key
(a scalar sub-query the planner cannot turn into a hash over the whole table), and for an Agent, ISA or TC
the implied "owned, collaborating or on my deal" predicate lets the planner start from the owner index.

**Evidence for the owner (not applied: lanes do not change policies).** On the scratch load database only,
the provably equivalent policy form `(SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id,
contact_id)` on `contact_tags` and `contact_field_values` (reverted afterwards) gave Owner first pages of
12-36 ms (from 84-386 ms) and counts of 240-1,982 ms (from 925-3,015 ms). Counts would then also need the
value-driven count shape (a semi-join from the tag or value index, cheap once the policy is) to meet 800 ms.

Reproduce: `pnpm load:seed --contacts 250000`, then
`pnpm --filter @realty/api exec tsx --env-file-if-exists=../../.env --conditions=@realty/source src/lists/perf/seedLists.ts`
and `… src/lists/perf/listsBench.ts --n 20 --explain off`.

## 8. Reproducing

```sh
pnpm load:seed --contacts 250000            # recreates realty_load (18 min on the final schema, 74 min on 0001–0014)
pnpm load:bench --out after.json            # about 30 min; consumes offers, pond leads and send targets
pnpm load:bench --explain --explain-ms 30 --out plans.log   # auto_explain plans of the app's SQL
pnpm load:smoke                             # CI-sized: 20k contacts, about 3.5 min, loose ceilings
node scripts/perf-table.mjs before.json after.json   # the table in §4
```

`pnpm load:smoke` is the repeatable CI check. It seeds 20k contacts into a throwaway database, runs every operation
with fewer iterations, and fails on:
- any correctness check (claim race, offers, sends, opt-outs never sent to, import counts)
- any p95 above 4 × its budget
- for the operations listed in §7, any p95 above an explicit regression ceiling (`KNOWN_MISS_CEILING_MS` in
  `apps/api/src/load/smoke.ts`)

Load users log in with `agent01@load-big.load.test` / `load-test-password-only`. Owner and admin sessions are minted by
the bench, because their MFA secret is a placeholder.
