<task>
You are an independent, skeptical senior reviewer on Realty OS, a real-estate team CRM. Another engineer built "the team AI policy" (create, new draft version, approve, revoke) and wired the seller side of AI care to the screen. Your job is to find what is wrong with it: defects that would let the AI assistant act with wider permission than an authorized person approved, leak across tenants or roles, or mislead a person on screen. You change no product code and you push nothing. You report findings with evidence.
</task>

<context>
Worktree: <your checkout of next/cma-ai>, branch next/cma-ai, head 405c273a (pushed; draft pull request 13). It contains origin/main (64b0dbf6). The work to review is everything this branch adds for the policy and the seller panel: `git log --oneline origin/main..HEAD` lists it; the policy step is the last ten or so commits (from "isa: the team AI policy" onward to the docs commit). Use `git diff origin/main..HEAD -- <path>` per file rather than one giant diff.
Start with: apps/api/src/isa/policy.ts (the routes' logic), the policy routes file beside it, apps/api/src/isa/repo.ts (`effectivePolicy` and the consent chain; link 4 reads the approval state), packages/core/src/isa (policy validation, the narrower/wider comparison, the attestation and approval texts), apps/api/src/isa/send.ts and effects.ts (what a narrower approval changes for queued messages), apps/api/src/assistant (the generic playbook routes that now refuse kind `ai_isa`), apps/api/src/isa/testing.ts (`isaWorld` now builds the policy through routes), apps/api/src/isa/seller/routes.ts (the new `actions` block), apps/web/src/surfaces/aiCare (TeamAssistantPage, the policy form and diff, the agent's page, the seller panel), docs/AI_ISA.md sections 3.2, 3.5, 6.5, 9.1, 10.1, and docs/DATA_MODEL.md rules R-ISA-33 to R-ISA-35 and edge cases E1000 to E1008.
What the engineer claims (verify each; do not take it on trust):
C1. Only an Owner, re-authenticated, can approve; an Owner or Admin can create, draft and revoke; Agent, ISA, TC and Team Lead can do none of it; another tenant cannot read or change it.
C2. A version that is WIDER than the last approved one pauses running AI care until each agent re-confirms; a NARROWER or equal one takes effect at once and care continues; a revoked policy pauses care at once. Nothing is sent to any client by any policy action.
C3. The effective policy for a send is never wider than what was approved and what the agent attested to: a draft never takes effect; approving version N while an agent attested to version N-1 uses the narrower of the two where N is narrower, and pauses where N is wider.
C4. Approval is bound to a content hash and to the exact served attestation text; a replay is idempotent; a stale hash or a changed text is refused.
C5. The generic playbook routes cannot create, version, approve or revoke an `ai_isa` playbook (so the stricter policy rules cannot be bypassed), and no other write path to those rows exists in application code.
C6. `narrows_previous` is written only by the approval route. The engineer says the database guard does not freeze it: decide whether that is a real hole (who could write it, with what effect).
C7. The seller panel shows each control only when the API says the action is available and shows the server's reason on refusal; the two seller stubs in apps/api/src/isa/seller/isa2Seam.ts still send nothing.
C8. Tests for source restrictions, hostile AI output and consent are unchanged in strength (no assertion lowered, deleted or skipped): compare those test files against origin/main.
Not yet proven by the engineer, by their own account: that a message queued BEFORE a narrower approval goes out only inside the narrower send window. Try to prove or refute it by reading, and if a single-file test can show it, write that test in a scratch file OUTSIDE the repository's tracked tree or as an uncommitted file you delete afterwards.
Machine limits, strict: a full test suite for another branch is running on this machine right now. You may read anything, and you may run SINGLE test files only, one at a time, in the foreground, with `--maxWorkers=1` (for example in apps/api: `npx vitest run src/isa/policy.test.ts --maxWorkers=1`). No Playwright. No `pnpm -r`, no directory-wide runs, no background or detached processes, no `pnpm db:setup`. Postgres 16 is already running.
</context>

<instructions>
1. Read the routes and the core comparison first. Write down, in your own words, the state machine (none, draft only, approved, approved with draft, revoked, revoked with draft) and for each transition who may do it and what happens to running care. Compare it with C1 to C4.
2. Attack authorization: every policy route for every role and for a second tenant, including read. Check the role matrix test covers each new route and action (`ai_isa.policy_draft`, `ai_isa.policy_approve`, `ai_isa.policy_revoke`). Check row-level security on every table the routes read or write.
3. Attack the widening rule: find a field change the comparison classes as narrower or equal that in fact lets the assistant do more (a longer send window, a higher message limit, a new channel, a new topic, a new lead source, a looser quiet-hours rule, removing a required hand-off, an added jurisdiction, a list field where removing an exclusion widens). List every policy field and say for each which direction widens and whether the comparison agrees. An unknown or newly added field must fail closed to "wider".
4. Attack the race: two approvals at once; approve while a draft is being saved; approve a version whose content changed after the hash was read; revoke while a send job is in flight; an agent re-confirming while a wider version is approved. Say which lock or constraint decides each, by file and line.
5. Attack the bypass: every writer of playbooks, playbook_versions and playbook_approvals rows in apps/api/src (grep), and whether any can touch an `ai_isa` row outside the policy routes. Include imports, seeds that run in production, and admin tools.
6. Check the queued-message question above and the claim that policy actions send nothing.
7. Check the web: the widening banner appears exactly when the server says wider; the approve button is absent for an Admin; the attestation text shown is the served text and the hash sent is the one for what is on screen; honest states for each of the six; the agent's page says what changed since they last attested; the seller controls follow `actions`. Read the web tests for assertions that would still pass if the server lied.
8. Compare the hostile-AI, consent and source-restriction test files with origin/main for any weakened assertion.
9. Check the docs say only what is built, and that every "VERIFY WITH COUNSEL" marker that was on main is still there.
10. For each finding, give: severity (blocker: the assistant could act wider than approved, cross-tenant or cross-role access, or a client could be messaged; high; medium; low), the file and line, a concrete scenario (state, request, wrong result), how you confirmed it (the test you ran or the lines you read), and the fix you recommend. Mark anything you could not confirm as PLAUSIBLE, not confirmed.
</instructions>

<examples>
A good finding: "BLOCKER. packages/core/src/isa/compare.ts:88. `maxMessagesPerDay` going from 3 to 10 is classed 'equal' because the comparison only looks at boolean permissions. Scenario: Owner approves v2 with 10; care continues with no re-confirmation; agent who attested to 3 now sends up to 10. Confirmed by a scratch test (below) that asserts 'wider' and fails."
A good non-finding: "C5 holds: the only writers of playbook_approvals are assistant/approvals.ts:41 (refuses ai_isa at :33) and isa/policy.ts:210."
Not acceptable: a finding with no file and line; "looks fine" without saying what you checked; running a directory of tests; editing product code; pushing.
</examples>

<final_output>
<review>
<state_machine>your own description, and where it differs from the claims</state_machine>
<findings>each finding in the form from instruction 10, most severe first</findings>
<claims>C1 to C8: holds, fails or not confirmed, with the evidence</claims>
<field_table>every policy field, which direction widens, whether the comparison agrees</field_table>
<tests_run>each single-file command and its exact result line</tests_run>
<not_checked>what you did not look at or could not run</not_checked>
</review>
</final_output>

Reminder: single test files only, one at a time, `--maxWorkers=1`, no Playwright, nothing in the background; change no product code, commit nothing, push nothing, and delete any scratch test you write; evidence for every finding; say PLAUSIBLE when not confirmed; on a usage-limit or quota error stop at once and report it verbatim. If you are not confident of something, say so; do not invent.
