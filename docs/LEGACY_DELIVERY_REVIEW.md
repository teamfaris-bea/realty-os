# Legacy uncertain-delivery review

**Read-only investigation, not a release approval or a repair command.** Migration 0102 remains blocked when eligible legacy messages have ambiguous dependent states. No workflow here authorizes resending, restarting care, changing consent/source/live gates, clearing a reason to bypass preflight, or guessing that a message failed to reach its recipient.

## Report contract

`pnpm --filter @realty/db legacy-delivery-report -- --tenant <tenant-uuid> [--limit 100] [--after <returned-message-uuid>]`

Use an already authorized operator's existing `MIGRATION_DATABASE_URL` and the project's database TLS settings. Do not put credentials in command arguments or reports. This CLI deliberately does not load `.env`; the operator must select the connection explicitly. It requires a superuser/BYPASSRLS operator connection and existing read privileges, and refuses RLS-bound application credentials rather than presenting a filtered result as complete. It creates no credentials, grants, roles or database objects. It is not an application API or an Owner-facing authorization endpoint.

Each call opens its own connection, begins a repeatable-read **READ ONLY** transaction, applies a 15-second statement timeout, reads one explicit tenant, and rolls back/closes the connection. It does not call providers, job handlers, migration code or state-changing functions. Only diagnostic transaction/session-local settings are set. Query/connection failures produce fixed codes without raw database errors, URLs, hosts or credentials. The normal TLS validator remains in use.

Output is JSON with a version, tenant ID, snapshot time, page limit/input cursor, candidate and blocked-message counts, message IDs and dependency IDs/states. It contains no names, addresses, phone numbers, message bodies, provider credentials, free-text explanations or payloads. IDs are still sensitive internal identifiers: keep reports in restricted operational evidence storage, never in the public repository or a public PR.

The candidate predicate exactly matches 0102: status failed, reason DISPATCH_UNKNOWN_UNRESOLVED, and no provider reference/error code. It reports only these migration candidates. Dependency rows match the preflight:

| Dependency | Blocking states |
| --- | --- |
| Assistant action linked by tenant and action ID | blocked |
| Shared fact linked by tenant and message ID | canceled |
| Turn linked by tenant and message ID | blocked, canceled, canceled_paused |
| Handoff linked by tenant and pending message ID | refused, canceled |

All relationships include tenant ID, including colliding UUIDs. Counts are message counts, not dependency counts. A candidate with no listed dependency can be classified by 0102, but this report does not apply that classification. A zero count proves neither non-delivery nor release readiness: it says only that this narrow predicate found no matching rows in this tenant snapshot. Historical rows with changed reasons, provider references, or other classifications remain outside its scope.

The default page size is 100, maximum 500. Begin without `--after`; use only the returned `nextAfterMessageId` while `truncated` is true. Every call is a separate snapshot; collect the ordered pages and their input/output cursors, verify candidate totals and unique IDs, and reject incomplete or inconsistent collections. Aggregate totals cover the tenant even when the page is truncated. A timeout/error is not an empty report. Exit 1 is invalid input, role, connection or query failure; exit 2 means blockers or a truncated page; exit 0 means a successful untruncated page without listed blockers. **Every output still says `releaseReady:false` and `drainVerified:false`.**

## Manual review and resolution workflow

1. **Establish the operational barrier first.** An authorized operator must stop all old API/job writers, prevent restart/lease reaping by an old version, and drain running work, including unresolved provider responses. Record deployed versions, worker/lease inventories, the stop/drain evidence and reviewer. This project has not executed or verified that barrier. If any old writer may remain, keep rollout blocked. Do not run migration concurrently with old workers or resume them afterward.
2. **Collect one tenant's complete report.** Confirm the explicitly selected tenant and environment out of band. Keep the restricted JSON, command version/commit, timestamps, page cursors and totals in the review case. No production data was inspected while developing this tool; all recorded verification used synthetic data.
3. **Build a case per message and exact dependency.** An authorized reviewer can inspect existing restricted audit/status events, command/job history and verified provider records through approved read-only processes. Record evidence references and timestamps, not bodies or credentials. Check whether the dependent state preceded the unknown send, came from the old failure handler, or reflects a later human decision, cancellation, consent/source change or ended care. The current schema often lacks enough transition-cause provenance; record that absence rather than inferring the cause.
4. **Classify the evidence without changing state.** Explicitly distinguish: provider-linked acceptance/delivery evidence; definitive non-acceptance evidence; and inconclusive evidence. A lookup miss, elapsed time, a unique body/time heuristic match, local job failure or absent provider reference is not proof of non-delivery. An accepted send is not proof of delivery. Provider evidence does not by itself authorize restoring workflow state or contact permission.
5. **Draft a narrowly scoped repair proposal for separate review.** Include tenant/message/dependency IDs, observed current values, exact evidence, human decisions that must be retained, expected before/after values, and rollback/audit requirements. If attribution is missing or conflicting, mark the case unresolved and leave migration blocked. Do not set blocked actions to executed, canceled facts to pending, or refused handoffs to queued merely to make preflight pass. Do not remove the unresolved reason or unlink a dependency as a bypass.
6. **Implement only after an evidence-backed repair design is separately authorized and tested.** No repair executor is included here. Any future implementation must lock/revalidate the exact tenant-scoped records, reject changed preconditions, preserve consent/opt-out/no-AI/source restrictions and conservative send counts, and never restart ended care, enqueue outbound work or resend. Evidence may support correcting delivery history while leaving a human cancellation intact; those are separate decisions. A reviewer must explicitly assess that distinction.
7. **Re-run the report and migration preflight only after the approved repair.** Retain both reports and the repair audit. Continue to block release if any case remains unresolved, the drain cannot be verified, or another release blocker remains. Empty reports do not satisfy the broader admission and matching blockers.

## Remaining release blockers

The provider admission race is unchanged: revocation and network start are not atomic, and an in-flight request cannot be recalled. Twilio lookup still uses heuristic address/body/time matching, not provider idempotency; a deliberate new command can duplicate a possibly accepted send. Safe legacy dependency repair is not implemented. The old-worker drain and mixed-version behavior remain unverified; there is no compatibility backstop. This reporting feature changes no live gates and does not make PR #3 release-ready.

## Synthetic verification

Tests use the actual PostgreSQL query under the supported non-superuser migration role, plus the application-role rejection case. They cover explicit tenant scope, a colliding blocked-action UUID in another tenant, pagination, exact candidate totals, no content leakage, and unchanged message/action/job snapshots. The existing legacy-failure harness verifies reporting of canceled facts, blocked turns and refused handoffs created by actual failure processing. CLI tests reject missing scope, an apply option and malformed connection configuration with fixed safe codes.

Failing-first report contracts: two failed, three filtered out before implementation. Final verification:

- `vitest run --root packages/db test/import_source_upgrade.test.ts --maxWorkers=1 --testTimeout=120000`: six passed (including non-superuser report/upgrade, role refusal, tenant collision, paging and CLI outcomes).
- `vitest run --root apps/api src/isa/review12.test.ts -t 'legacy failed processing' --maxWorkers=1`: one passed, 50 filtered out; verifies report rows against actual synthetic failure-handler dependencies.
- `tsc -p packages/db/tsconfig.json --noEmit` and `tsc -p apps/api/tsconfig.json --noEmit`: passed.
- ESLint on changed TypeScript files with `--max-warnings=0`, and `git diff --check`: passed.

 Production data, provider networks, load/large-tenant performance and an actual operational drain were not accessed or tested.
