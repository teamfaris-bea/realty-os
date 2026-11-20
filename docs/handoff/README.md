# Delegation plan: who builds what next (20 Nov 2026)

This hands the Realty OS build from one session to three: **Chat**, **Grok** and **Grokbot**. It is self-contained. Each lane has a full brief in `docs/handoff/briefs/`.

Nothing here authorizes live operation. Every rule in section 2 still binds.

## 1. Where things stand

`main` and `staging` are at `64b0dbf6` (batches 1 to 18 plus the stage flow).

| Work | Branch, head | Pull request | State |
|---|---|---|---|
| Batch A: Today follow-up, handoff visibility with the minute-three backup alert, lead-email parser fix | `merge/batch19a` `b07f602e` | 14, 15, 16 (drafts) | Reviewed and fixed. Full suite was 20 of 30 segments passed, none failed, when this was written. **Owner has approved landing it when the full suite is green on that exact head.** |
| Team AI policy and seller panel | `next/cma-ai` (was `405c273a`; fix commits follow) | 13 (draft) | Independent review found 13 defects (listed on the pull request). Fix pass under way: brief `cma-ai-fix2.md`. Run `git log` to see which fixes are already committed. **Not ready to land.** |
| Reasons to call | `next/reasons-to-call`, cut from `b07f602e` | none yet | Just started. Brief `reasons-step1.md`. |
| Navigation prototype | `explore/navigation` `c2c1144c` | none | Owner chose "slim rail + phone More page". Adoption brief `nav-adopt.md`. |
| Capture, lock-screen alerts, scorecard, nurture control | not started | none | Briefs written. |

If a branch named above has moved, trust `git log`, not this table.

## 2. Rules that bind every bot

These come from the owner and are not negotiable.

**Never, without the owner's explicit say-so:**
- No real lead enrolled, no live message or call, no production change, deploy or provisioning, no DNS or provider-setting change, no purchase or subscription.
- No new credential and no secret in chat, code, a pull request or an issue. `MLS_LIVE_CALLS` and `AI_ISA_LIVE_SENDS` stay false.
- No invented approval from counsel, a vendor or the owner.
- No weakening of consent, STOP handling, source restrictions, plan approval or any existing test assertion.

**Git:**
- Never force-push. Never rebase a pushed branch: merge `origin/main` into it.
- Only the integrator pushes `main` and `staging`, fast-forward only, after a green full suite on the exact head.
- Applied migrations (0001 to 0111, and any later one once on `main`) are never edited. Use only the numbers in your lane.

**This is a public repository:**
- No real names, emails, phone numbers, addresses, account ids or case numbers. Write "the owner", "an agent", "the team lead", "a referral partner".
- Do not build on data pulled from the previous CRM's API. Use invented people and fake providers.

**How work is done:**
- Failing test first. One commit per item.
- Every message to a client goes through `apps/api/src/comms/dispatch.ts`. Do not add another send path.
- Say only what you ran. Label emulator results as emulation. Nobody may claim a real-iPhone result without a real iPhone.
- Automated messages never count as a human first touch.
- Do not call unfinished work complete.

## 3. Who does what

One bot integrates; the other two build. Builders never push `main`.

| Bot | Role | Lanes, in order |
|---|---|---|
| **Chat** | Integrator | 1. Land batch A. 2. Finish and land the AI policy (pull request 13). 3. Navigation adoption. Also: runs the full suite before every landing and merges `main` into waiting branches. |
| **Grok** | Builder, agent's day | 1. Reasons to call. 2. Capture without typing. 3. Outcome funnel (no brief yet; ask the owner for scope). |
| **Grokbot** | Builder, team and platform | 1. Lock-screen alerts. 2. Scorecard that explains itself. 3. Nurture control. |

The integrator needs a machine that can run Postgres 16, Node with pnpm, and Playwright with Chromium. If Chat cannot, the owner should swap the integrator role to whichever bot can.

**Review rule:** no bot lands its own lane. Grok and Grokbot review each other's lanes; Grok reviews Chat's. The reviewer changes no code and reports findings with file, line, a concrete scenario and how it was confirmed. `cma-ai-review2.md` is the pattern.

## 4. The lanes

Each lane owns its migration numbers, rule family, edge-case ids and architecture sections, so lanes do not collide. Do not use another lane's.

| Lane | Brief | Branch | Cut from | Migrations | Rules | Edge cases | Architecture |
|---|---|---|---|---|---|---|---|
| AI policy fixes | `cma-ai-fix2.md` | `next/cma-ai` | exists | 0112 | R-ISA-36 on | E1009 to E1019 | existing 21.79, 21.80 |
| Reasons to call | `reasons-step1.md` | `next/reasons-to-call` | exists | 0117, 0118 | R-REASON | E1120 to E1169 | 21.85, 21.86 |
| Capture | `capture-step1.md` | `next/capture` | `main` after batch A | 0119, 0120 | R-CAP | E1170 to E1219 | 21.87, 21.88 |
| Lock-screen alerts | `push-step1.md` | `next/lock-screen-alerts` | `main` after batch A | 0121, 0122 | R-PUSH | E1220 to E1259 | 21.89, 21.90 |
| Scorecard | `scorecard-step1.md` | `next/scorecard` | `main` after batch A | 0113, 0114 | R-SCORE | E1020 to E1069 | 21.81, 21.82 |
| Nurture control | `nurture-step1.md` | `next/nurture-control` | `main` after batch A | 0115, 0116 | R-NURT (continue after the last existing one) | E1070 to E1119 | 21.83, 21.84 |
| Navigation | `nav-adopt.md` | `next/navigation` | `main` after batch A | none | none | none | none |

Already taken on `main` or in batch A: migrations up to 0111; architecture sections up to 21.80; rule families R-STG, R-TEAMQ, R-TODAY, R-ISA-33 to 35.

**Reading a brief written for another machine:**
- `{{WT}}` is your checkout and `{{BASE}}` the commit you cut from.
- `<your scratch folder>` is any folder outside the repository.
- The "Local facts" lines (4 cores, single test files, no Playwright while another suite runs) described one small shared machine. On your own machine run what it can hold, but still run the checks the brief lists.
- End commits with your own tool's attribution line, not another tool's.

**Order matters in two places:**
- Capture and reasons to call both edit `packages/core/src/priority/followUp.ts`. Grok does them one after the other, never in parallel.
- Navigation rewrites the app shell. It lands when no other lane is waiting to land, and every other lane keeps out of the shell.

## 5. Handing work in

1. Push your branch. Open a **draft** pull request against `main`.
2. In the description give: what it contains, each check you ran with its exact result line, what you did **not** verify, and open questions for the owner with the default you built.
3. Post one line on issue 8 with the pull request number.
4. Wait for the review. Fix findings with a failing test first.

## 6. Landing (integrator only)

A branch lands only when all of this passes on its exact head, with `origin/main` merged in:

- `pnpm -r typecheck` and `pnpm lint`
- unit tests: `packages/core`, `packages/eslint-plugin`, `packages/db`, `apps/api` (all of it), and `apps/web` twice (`TZ=UTC` and `TZ=America/New_York`)
- Playwright: all of `apps/web/e2e`, phone and desktop projects
- the security-headers check and `pnpm rule-coverage` (default and parity)
- `apps/web`: `npx vitest run src/test` (the repository guards, including the private-detail guard)

Known and accepted rule-coverage gaps, phase 2-3 only: R-TEN-13, E128, E422, E428, E431, E435, E437, E438, E439. Anything else is a failure.

Then `git push origin <branch>:main` and `:staging`, fast-forward only, and confirm with `git ls-remote`. Post the totals on the pull request.

Lessons already paid for:
- The whole suite finds what single files miss: route tables, the role matrix, audit field classification, schema snapshots, import-cycle order. A new route, column or action must be added to those inventory tests.
- Never fix code while a suite runs on that tree. Rerun what the fix touches.
- A browser shard that fails with a page that never mounts, a five-minute accessibility timeout or "no space left" is the machine. Rerun that shard alone before calling it a bug.
- One full suite at a time on a small machine.

## 7. Not verified, and decisions only the owner can make

**Not verified anywhere:**
- Nothing has been checked on a real iPhone. Steps are on issue 8.
- No real model provider, push service, telephony or email provider has been called. Fakes only.

**Open with the owner (a default is built for each):**
- AI policy: may an Admin approve it (built: Owner only); does lowering the "ready within N days" threshold count as letting the assistant do more (built in the fix: any change needs agents to re-confirm); should revoking also cancel a hand-off confirmation already promised.
- Transcription vendor for call summaries: none chosen, none bought. Capture builds to the existing interface with fakes.
- Lock-screen alerts: how much of a lead's name shows on the lock screen.
- Reasons to call: the daily cap (built: 15), places kept for past clients (built: up to 5), what "nearby" means.
- Scorecard: how long a correction can hold a lead's release (built: 4 staffed hours).
- The pilot needs counsel's clearances and the owner's go-ahead. No bot can supply either.

## 8. First message for each bot

Paste this, with the bot's name and lanes from section 3:

> You are joining the Realty OS build as **[Chat / Grok / Grokbot]**. Repository: `teamfaris-bea/realty-os`. Read `docs/handoff/README.md` on the branch `handoff/delegation-1120` in full before anything else, then the brief for your first lane in `docs/handoff/briefs/`. Section 2 of the README binds you: no live sends, no production changes, no credentials, no force-push, nothing private in this public repository. Work on your lane's branch only, open a draft pull request, and report exactly what you ran and what you did not verify. Do not push `main` unless you are the integrator. Start by running `git log --oneline -15` on your branch and telling me what is already there.
