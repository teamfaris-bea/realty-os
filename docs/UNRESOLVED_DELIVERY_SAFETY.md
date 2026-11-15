# Unresolved delivery remains unknown

Local follow-up to the malformed Twilio successful-response fix. No deployment or live provider request was performed. This is not production readiness or a solution to the admission/send race.

## State machine

Dispatch TX1 claims queued/scheduled work, commits dispatching, then calls the provider outside that transaction. TX2 records the result. Uncertain submissions become dispatch_unknown. Reconciliation performs provider lookup outside its write transaction, then locks the contact/message and rechecks the state. A lookup miss or exception is not evidence that the provider refused the submission.

Previously, the ten-minute deadline called markFailed with DISPATCH_UNKNOWN_UNRESOLVED. The compose outcome could say “Nothing reached them”; a new command could submit again. The original command was not automatically replayed, but the presentation invited a duplicate.

Now that deadline sets the unresolved reason while keeping dispatch_unknown. The reconciliation job finishes without another scheduled lookup. Migration 0102 excludes these rows from the sweeper, and repeated reconciliation calls perform no provider request. Signed late callbacks still resolve the message; a resolved provider status clears the stale unresolved reason. Existing provider lookup matching is unchanged.

Migration 0102 repairs only legacy failed rows with the exact unresolved reason and no provider reference/error code. It does not rewrite evidenced provider failures. Repaired AI messages receive an unknown result job so pending legacy failure jobs cannot lose safety accounting. Existing job deduplication and counted message IDs prevent double counting. The function replacement preserves ownership and grants.

Unknown messages cannot be sent by dispatch or the existing-message send endpoint. A deliberate new command is still allowed and can duplicate a possibly accepted submission; the UI explicitly says this. Automatic checks end; late status callbacks remain possible. There is no claim of recall or proof of non-delivery.

## Dependent safety behavior

MMS serving stops at the unresolved deadline despite the retained unknown status. The existing 24-hour provider cleanup job remains scheduled. Portal sign-in seals still expire under the existing lifecycle. Unknown AI facts/turns and handoff confirmations stay pending/unknown. The prior conservative AI send-cap and delivery-problem accounting is retained: the machine receives its existing failure accounting event for a deadline-unresolved attempt, without persisting or displaying a failed delivery. The message counts once; duplicate result jobs do not increment the streak twice. This accounting classification is not evidence of carrier rejection.

## Verification

All data and transport responses are synthetic. Raw HTTP counts in unknownResponse.test.ts assert one POST across replay, deadline exhaustion, repeated recovery and a late callback; tests do not rely on fake provider deduplication. Failing-first: API unknown-response/media tests 2 failed / 7 passed; AI R15 tests 2 failed / 1 passed; UI 1 failed / 1 passed. These failures captured the old failed status and false assurance before implementation.

Commands use Node 22 on PATH and TEST_ADMIN_DATABASE_URL pointing at the existing local test-only PostgreSQL server:

- `vitest run --root apps/api src/comms/unknownResponse.test.ts src/comms/outboundMedia.cleanup.test.ts src/comms/dispatch.test.ts src/comms/webhooks.contract.test.ts src/portal/seal.test.ts src/portal/signin.test.ts src/observability/system.test.ts --maxWorkers=1`
- `vitest run --root apps/api src/isa/review12.test.ts -t 'b12 recheck R15' --maxWorkers=1`
- `vitest run --root apps/web src/surfaces/feed/lib/sendOutcomeText.test.ts`
- `vitest run --root packages/db test/import_source_upgrade.test.ts --maxWorkers=1 --testTimeout=120000`
- `tsc -p apps/api/tsconfig.json --noEmit`; ESLint on all changed TypeScript files with `--max-warnings=0`; `git diff --check`.

Final focused results: 78 API tests passed; three AI R15 tests passed; final migration/AI repair selection passed four tests (51 intentionally filtered out); four UI text tests passed; one populated non-superuser upgrade test passed; API typecheck, changed-file ESLint and diff whitespace checks passed. Logs are retained outside the repository in the task directory. Earlier portal/media/dispatch checks passed; a new late-callback assertion exposed the stale reason and was fixed. An additional duplicate-job test initially used the wrong emitter export; correcting the test made it pass. The subsequent AI backfill test caught a missing required job run_at value; it now passes with the required timestamp.

## Unverified and remaining risks

- Strict prevention of network start after revocation is not implemented. An admitted/in-flight send cannot be recalled; the broader admission contract remains a separate policy/design decision.
- Twilio submission idempotency is not provided by the adapter. Lookup still uses body/time/address heuristics and may misassociate indistinguishable messages. No live provider behavior was tested.
- Voice, verification and agent-alert lifecycles are not redesigned here. Their uncertainty/retry behavior needs separate review.
- No new browser-level compose verification: the preceding branch recorded baseline useViewer/casing failures. UI coverage here is focused outcome/thread text. Full repository tests, scale/performance, production migration and mixed-version rollout are not verified. Workers must be coordinated with the new migration/code; older workers can still write the old failed classification.
- Backfill cannot recover purged messages, prove whether a send occurred, or reconstruct unknown outcomes mislabeled with other reasons. Existing sent counters are deliberately not decremented.
- The callback path still records status without backfilling a missing provider reference; the existing event retains its provider SID.


## Review follow-up: race, seeded upgrade and migration blocker

A deterministic raw-HTTP barrier reproduced a slow successful lookup being discarded after a competing miss marked the message unresolved (one failing regression; final-callback control passed). Reconciliation now applies a usable result from an already-running lookup before checking the exhausted-window marker. It still checks current message status first: a terminal callback wins, and a miss cannot regress it. Exhausted rows do not start new lookups. No submit/replay or matching policy changed.

The non-superuser upgrade fixture now contains six actual legacy submissions across two tenants: eligible system and AI submissions plus genuine refusal controls. It verifies repaired states and exactly one unknown-result job per eligible AI message. All constraints/triggers remain enabled; no messages are dispatched. Earlier fixture construction failures were corrected to conform to the published sender and AI mandate constraints; they were not migration failures.

**Unresolved blocker:** the old failed-result handler cancels shared facts, blocks turns and marks handoff confirmations refused. The new regression executes that actual old status/result path and confirms all three effects. Existing late delivery handling does not repair them: the legacy failed message itself also rejects the tested late delivered event. These records lack trustworthy per-transition cause provenance: ending care also cancels pending facts, and human decisions must not be inferred away. No automatic restoration is implemented. Migration 0102 now aborts before changing anything with `UNRESOLVED_LEGACY_DEPENDENCIES_REQUIRE_REVIEW` when an eligible legacy message has those terminal dependencies. This is a conservative stop, not completion of legacy repair. The guard does not detect historical cases whose message reason was already cleared by a later callback; those need a separate evidence-backed audit. Do not publish this as release-ready.

**Hard rollout barrier (required, not executed or operationally verified):** stop all old API/job writers and drain running work, including pending provider responses, before migration. Confirm no old process can resume; do not overlap old and new workers. Run migration only after that barrier. A dependency preflight rejection blocks rollout until the affected records receive an evidence-backed repair design; never clear the marker just to bypass it. Start only the updated workers after migration succeeds. There is no mixed-version compatibility guarantee or database enforcement preventing an old worker from writing failed again.


Follow-up verification commands/results (same synthetic local PostgreSQL and Node 22 setup):
- Before the race fix: `vitest run --root apps/api src/comms/unknownResponse.test.ts -t 'slow positive' --maxWorkers=1`: one failed, one passed, five filtered out.
- Before the dependency guard: `vitest run --root apps/api src/isa/review12.test.ts -t 'legacy failed processing' --maxWorkers=1`: one failed, 50 filtered out; the migration wrongly succeeded despite the reproduced terminal dependencies.
- After both changes: `vitest run --root apps/api src/isa/review12.test.ts src/comms/unknownResponse.test.ts -t 'b12 recheck R15|slow positive' --maxWorkers=1`: six passed, 52 filtered out. These include an explicit regression documenting the still-unrepaired legacy states.
- Full raw-HTTP file: `vitest run --root apps/api src/comms/unknownResponse.test.ts --maxWorkers=1`: seven passed.
- Seeded non-superuser upgrade command above: one passed, with six legacy rows across two tenants and AI result-job assertions.
- API typecheck, changed-file ESLint and whitespace checks passed. No full browser, production migration, live provider, mixed-version or load tests were run for this follow-up.


### Blocked assistant-action preflight correction

The dependency preflight also checks `assistant_actions` through both `messages.tenant_id` and `messages.assistant_action_id`, refusing a linked action whose status is blocked. No cause is inferred and no action is restored. The earlier successful-upgrade fixture incorrectly contained blocked actions; its eligible AI controls now use executed actions, while isolated blocked-action cases explicitly test rejection.

Failing-first command: `vitest run --root packages/db test/import_source_upgrade.test.ts -t 'blocked action alone' --maxWorkers=1 --testTimeout=120000`: one failed, one passed, one filtered out. The failing case contained no turn, shared fact or handoff associated with the target message; the other case inserted the same action UUID as blocked only in the other tenant and correctly did not block the target. Both execute the actual migration SQL under the supported non-superuser role, in rollback-only transactions. The release block and unverified old-worker drain remain unchanged.

After the predicate change: the full seeded non-superuser upgrade file passed all three tests; `vitest run --root apps/api src/isa/review12.test.ts -t 'b12 recheck R15' --maxWorkers=1` passed four tests (47 filtered out). Changed-test ESLint and `git diff --check` passed. No new typecheck was run for this SQL/test/documentation-only follow-up.

A separate operator-only [read-only report and manual review workflow](LEGACY_DELIVERY_REVIEW.md) inventories exact tenant-scoped blockers. It supplies no repair executor, provider calls or release approval.
