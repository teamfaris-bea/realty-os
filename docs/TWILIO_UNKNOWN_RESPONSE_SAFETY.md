> Follow-up: `UNRESOLVED_DELIVERY_SAFETY.md` supersedes the ten-minute failure behavior and limitation below on the local follow-up branch. The results here describe the preceding narrow patch.

# Unreadable successful Twilio submit responses

This narrow local fix is based directly on draft PR #2 (`7a0613fd5186f47c10cbf35e4968576eac587dbb`). It does not implement or change the separate final-admission proposal, source gates, consent/opt-out, live switches, retries, or provider configuration.

## Defect and retry analysis

The HTTP helper previously parsed a successful submit response outside the correct uncertainty classification. Invalid JSON after HTTP 201 threw `ProviderError('unavailable', 'TWILIO_BAD_RESPONSE')`. `comms/dispatch.ts` treats that as a plain failed send: `PROVIDER_UNAVAILABLE`, with no reconciliation job. A body-read failure escaped as an arbitrary error (the message dispatcher happened to map that to timeout, but the adapter contract was inconsistent).

No automatic resend of the original failed message was found. The transport performs one submit attempt; dispatch claims only queued/scheduled rows; a repeated compose request with the same command key returns the original message; and `/messages/:id/send` rejects failed or unknown messages. This is application-level replay protection, not Twilio idempotency.

The unsafe consequence is false certainty and loss of recovery. The existing failed-send UI says “Nothing reached them” and keeps the draft text. A deliberate new command uses a new key and can submit again even if the first request was accepted. A synthetic test now demonstrates two new commands produce two raw HTTP POSTs. Classification alone cannot make a new send duplicate-safe.

## Change

`providers/twilio/http.ts` reads and parses a successful response inside one catch boundary. If `opts.submit` is true, an unreadable or malformed success becomes `ProviderError('timeout', 'TWILIO_BAD_RESPONSE')`, the existing adapter representation of an unknown submit outcome. Reads/non-submit requests retain `unavailable`. The helper does not retry the POST, add an unsupported idempotency header, or log response bodies/credentials.

The existing message dispatcher then records `dispatch_unknown`, preserves no fabricated provider reference, and enqueues `comms.reconcile`. It can recover from a later lookup or signed callback without another submit. A callback can mark the message delivered while leaving its provider reference null; the existing event records the SID. That reference-backfill limitation is documented, not changed here.

The unknown-outcome UI now says the service may have accepted the request and that this attempt will not be automatically sent again. It no longer assumes every unknown is a timeout or promises that no duplicate could ever occur. The UI still allows a deliberate new command, which remains a duplication risk.

## Regression evidence

Before the fix, the new adapter and API tests produced seven failures and three passes. The three API failures all observed one raw POST and `failed` where `dispatch_unknown` was expected. Adapter failures covered malformed SMS/voice/verification submit JSON and an unreadable body. The separate UI regression failed on the previous timeout-specific assurance.

The end-to-end harness uses the actual dispatcher, PostgreSQL, encrypted synthetic credentials and the actual Twilio adapter, with every HTTP call terminated by an injected recording stub at an example.test URL. The provider's fake deduplication is not involved. A test-only adapter instance has `liveRequests: true` solely to reach that stub; no environment/live messaging configuration is enabled and no real provider request or credential is used.

Recovery tests assert raw adapter/HTTP counts for:

- One malformed accepted response creates `dispatch_unknown` and exactly one reconcile job.
- Same-command repost, repeated dispatch and a re-tap cannot resubmit that attempt.
- A later unique lookup candidate records delivered with its reference; GET only.
- A signed callback and duplicate callback record delivered; no subsequent lookup or POST is required.
- Missing lookup evidence stays unknown initially, then follows the existing ten-minute unresolved failure path; still no automatic POST.
- A deliberate new command is a second submit, explicitly demonstrating the limit of the guarantee.

Adapter tests cover missing/invalid SID, malformed JSON and body-read failure, shared voice/verification submit classification, and unchanged malformed-read behavior. Existing kill-switch, MMS and dispatcher tests also ran.

## Verification

Commands ran from the isolated repository with `PATH=/tmp/node-v22.23.5-darwin-arm64/bin:$PATH`. Database tests used only `TEST_ADMIN_DATABASE_URL=postgres://app_owner@127.0.0.1:56479/postgres` and isolated generated test databases.

- `node_modules/.bin/vitest run --root apps/api src/providers/twilio/unknownResponse.test.ts src/providers/twilio/telephony.test.ts src/providers/twilio/killswitch.test.ts src/providers/twilio/mms.test.ts src/comms/unknownResponse.test.ts src/comms/dispatch.test.ts --maxWorkers=2`: 52 passed.
- After adding the deliberate-new-command case, `node_modules/.bin/vitest run --root apps/api src/comms/unknownResponse.test.ts`: four passed. This adds one unique passing test to the previous run, for 53 unique focused tests.
- API typecheck (`tsc -p apps/api/tsconfig.json --noEmit`), changed-file ESLint and diff-check passed.
- New UI outcome regression passed in the combined run. Broader ComposeBox/MediaTray execution had 49 failures and three passes, due to `useViewer is not a function` from unchanged AI Care imports. A representative compose test failed identically with the published AgentSheets implementation restored; it was then restored to the local fix. Full compose UI verification remains blocked.
- Existing dial suite: 13 passed, one failure expecting `/check/i` but receiving `SOURCE_TENANT_CONTEXT_REQUIRED`. A targeted rerun with the published HTTP implementation restored failed identically; the narrow fix was then restored. This pre-exists on PR #2 and was not changed here.

One intermediate post-fix run could not connect because the shared synthetic cluster had been stopped. It was restored using its existing loopback-only startup parameters and existing roles; no new credentials or configuration changes were made. Subsequent API tests passed. The temporary infrastructure failure is not counted as a code regression or a test pass.

## Limits and follow-up

- The provider-send/source-revocation gap is unchanged. There is no final-admission or strict provider-start fencing implementation here, and already-in-flight requests cannot be recalled.
- The existing ten-minute `DISPATCH_UNKNOWN_UNRESOLVED` transition still produces a failed status despite lack of proof of non-delivery. Its UI and any deliberate human new-send flow need separate review. This patch prevents premature failure on malformed success; it does not resolve all uncertainty presentation.
- Twilio lookup ignores the local key and uses a limited sender/recipient/body/time heuristic. A unique visible candidate is not proof of identity. No provider idempotency is assumed.
- The shared helper also classifies voice and verification submissions as unknown at the adapter boundary. Their caller lifecycles were not redesigned: voice still maps provider failures to failed, and verification does not use message reconciliation. Do not claim this fixes end-to-end uncertainty for those flows.
- Callback recovery does not backfill a missing provider reference, and its later maintenance consequences remain unverified.
- Full web typecheck remains affected by the existing case-colliding AI Care imports; full repository tests, physical-network retries/redirects, live vendors and production load were not verified.

No deployment, merge, live send, publication or new credentials are part of this local change.
