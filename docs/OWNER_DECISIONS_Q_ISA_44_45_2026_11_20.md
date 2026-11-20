# Owner decisions: Q-ISA-44 and Q-ISA-45

Date: 2026-11-20 (America/New_York).

Status: **Owner-approved product direction. Implementation and live activation remain pending.**

The owner requested “Push” after reviewing the recommendations for Q-ISA-44 and Q-ISA-45. This record publishes those two product decisions. It does not authorize application changes in this task, approve PR #13 for merge, change the integrator assignment, record counsel or MLS clearance, approve D12 as a whole, or authorize deployment, enrollment or live messages.

## Reviewed repository state

- `main`: `64b0dbf6042d71dc7b9d8a5121f1c935dc27d7b4`.
- PR #13, `next/cma-ai`: `6ddae187726dcea1a5639a95a6718664350cc775`, open and draft.
- At that head, Q-ISA-44 and Q-ISA-45 remained open in `docs/AI_ISA.md`, and both seller delivery helpers returned `NOT_BUILT`.
- A `FACT_CHANGED` cancellation already schedules the existing replan. The separate revised-facts helper is unconnected. The competition watch records events without sending them.

This is a separate documentation change. It leaves the active engineering branches and their shared requirements files untouched. The designated integrator can reconcile this record with `docs/AI_ISA.md` in the normal integration sequence; the implementation must not be described as complete merely because its product choices are now recorded.

Sources: [PR #13](https://github.com/teamfaris-bea/realty-os/pull/13), [open questions at the reviewed head](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/docs/AI_ISA.md#L1518-L1521), [seller stubs](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/apps/api/src/isa/seller/isa2Seam.ts), and [later coordination record](https://github.com/teamfaris-bea/realty-os/issues/8#issuecomment-7028990164).

## Q-ISA-44: revised facts after an unsent message becomes stale

**Decision: keep the existing replan as the sole replacement path for the initial release. Do not connect a parallel revised-facts sender.**

1. Replacement is allowed only when the original message is provably unsent. An accepted, already sent or uncertain delivery must not be automatically resent as a replacement. The agent receives a review item with the original message, changed facts and delivery status.
2. Allow at most one replacement of that original message. A further fact change or a failed final freshness check stops the replacement cycle and creates an internal agent review item. This is a required future acceptance rule, not a claim about the current replan.
3. Preserve the original purpose and channel eligibility. A replacement cannot introduce unrelated listings, extra nurture, a new offer or pricing advice. A newer seller question or human takeover takes priority.
4. A dispute or change to the subject home's identity or confirmed facts retains the existing agent-reconfirmation requirement. A seller's correction is not treated as a verified MLS refresh that can silently replace the confirmed subject.
5. If an unsolicited update has no safe facts left, withhold it and explain the reason to the agent. Do not send the seller an unsolicited `data_unavailable` holding message.
6. If the seller actually asked an unanswered question, preserve that question and its human handback/backstop. A holding response may use the ordinary approved workflow and all its existing gates; a watch event alone is not a customer request.
7. A human-approved message that changes materially loses that message approval and requires fresh review. Team-policy approval is not approval of every individual revised email.

The dedicated re-render stub stays disabled under this initial decision. A later model-free renderer would require a separate decision and must exclusively replace the eligible replan responsibility within the existing workflow. Running both responders is not approved.

Reason for choosing this option: it avoids a second sender competing with the existing replan while preserving the current authorization and dispatch path. The tradeoff is the possible additional model call. Human review handles ambiguity and repeated changes.

Sources: [existing replan scheduling](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/apps/api/src/isa/handlers.ts#L109-L116), [why the two helpers remain unbuilt](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/docs/AI_ISA.md#L796-L797), and [subject confirmation](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/docs/AI_ISA.md#L723-L729).

## Q-ISA-45: proactive competition updates

**Decision: specify an optional weekly email digest, initially reviewed by the lead's agent before every send. It shares all existing outreach limits and never displaces a requested answer.**

### Frequency and content

- At most one competition digest per seller/person in any rolling seven days, including continued care. A stricter effective policy or unanswered-message slowdown wins.
- No message without a relevant new change. The daily watch schedule is monitoring frequency, not delivery permission.
- The digest uses a normal proactive follow-up opportunity and the existing initiated allowance. It does not add a separate quota alongside nurture.
- Record the seller's preference to receive these updates. That preference supplements, and does not replace, required channel-consent evidence.
- Initial delivery is email only. The agent reviews the exact email and supporting facts. A material change invalidates the approval.
- Use currently eligible competition facts with correct status labels, asking-price labels, source dates and attribution. New listings, asking-price changes, pending status and returns to market are within this scope when independently permitted by the existing data rules.
- This decision does not authorize sold/off-market event messages, sold-derived statistics, market-count messages, valuation estimates or pricing advice. The separate sold-comps path retains its complete-set, email-only and changed-set/30-day refresh requirements.

### One shared unanswered limit

- All proactive AI outreach, including competition digests and ordinary follow-ups, uses the same unanswered limit.
- After three unanswered proactive contacts, the next unsolicited attempt is no sooner than 14 days later, or the effective policy's longer interval.
- After six unanswered proactive contacts, no seventh unsolicited attempt is allowed; the lead is handed back.
- Reserve the shared allowance before concurrent jobs can each claim it. Count one logical outreach once when the provider accepts it for dispatch or the outcome indicates it may have been sent. Do not wait for confirmed delivery or release an allowance when dispatch may already have occurred.
- A canceled, provably unsent draft is not another client contact. Replacing that unsent draft does not create an additional unanswered attempt. These rules do not exempt a facts message from initiated-message consent or frequency checks.
- A new listing, different channel or continuation of care does not silently reset the unanswered limit.
- A verified seller reply may reset the unanswered count under the applicable inbound rules. Delivery receipts, opens, clicks and an agent's draft approval do not. An opt-out stops care rather than authorizing a restart.

At the reviewed head, the follow-up timer increments `unansweredInitiated`, while a listing event does not. The rules above therefore require implementation; they are not a description of a completed watch-delivery feature. The unanswered counter is distinct from the total-message counter and undelivered-message streak.

### Priority, freshness and held events

- A digest never cancels or supersedes a pending response to the seller, an appointment flow or a human handoff. Keep lower-priority listing events internal while those are pending.
- Rebuild the digest from current eligible data at the next permitted opportunity. Collapse multiple changes to one listing into its latest relevant state.
- If the next digest cycle overtakes a held draft, discard the old draft and prepare a current one for review. Do not flush a backlog after a pause or initial activation.
- Existing watch events recorded as not delivered are not an approved queue for future catch-up messages.

Reason for choosing this option: weekly email preserves useful competition awareness with less contact pressure than per-event or daily delivery. Agent review checks relevance and routes urgent matters to the agent during the first release. Unattended delivery requires another owner decision.

Sources: [current counter behavior](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/packages/core/src/isa/machine.ts#L565-L598), [verified inbound reset](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/packages/core/src/isa/machine.ts#L322-L340), [watch implementation](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/apps/api/src/isa/seller/watch.ts), and [seller-content restrictions](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/docs/AI_ISA.md#L731-L801).

## Requirements preserved for both decisions

These choices narrow the proposed behavior. They grant no exception to existing requirements:

- Every facts message retains the initiated/any-fact evidence tier even when answering a recent seller question. Preserve the applicable SMS written-consent and DNC checks, email evidence and sending-domain/footer checks, opt-outs, suppressions and channel permissions.
- Human review does not reclassify an automated digest as personal outreach or bypass marked-source and unclassified-import restrictions.
- Preserve the existing shared caps: no more than three AI messages per rolling 24 hours, AI yielding at the applicable shared automated/marketing threshold, initiated limits of one per rolling 24 hours and three per rolling seven days, and the 120-second minimum AI gap. Stricter effective settings win.
- Preserve recipient-zone send windows, initiated days/holidays, assignment limits, current owner/agent authorization, the first human touch, per-lead start and confirmed seller subject.
- Keep this prospect-nurture scope separate from active-client seller updates. Pricing, negotiation, listing decisions, contracts, commission and value opinions remain human responsibilities.
- Team-policy approval remains bound to the exact policy version and content hash. The required owner approval, agent confirmation and all deployment/data permissions must still hold at send time.
- No new send path, automatic retry of uncertain deliveries, provider setting, live switch or enrollment is authorized by this record.

Sources: [consent and caps](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/docs/AI_ISA.md#L598-L645), [policy approval](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/docs/AI_ISA.md#L250-L258), and [product boundaries and remaining approvals](https://github.com/teamfaris-bea/realty-os/blob/6ddae187726dcea1a5639a95a6718664350cc775/docs/PHASE2_3_PLAN.md#L205-L214).

## Integration and verification status

This commit adds only this decision record. No product code, tests, migrations, existing requirements, PR #13 content or live configuration is changed.

No application suite was run for this documentation change. No runtime behavior or live readiness is claimed. The existing engineering review and exact-commit verification requirements continue to apply to any later implementation.

The owner decisions are recorded; the features remain unbuilt or constrained as described at the reviewed head until separately implemented, verified and authorized for activation.
