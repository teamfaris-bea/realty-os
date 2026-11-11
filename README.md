# Realty OS

A multi-tenant operating system for residential real-estate teams. It is one responsive web app,
built for the phone and the desktop. Agents use it to work a priority feed, accept and claim leads,
call, text and email (every send passes a compliance check at the moment it goes out), approve the
assistant's drafts (each one shows its evidence), log outcomes and find contacts. Team Leads get a live
queue of exceptions to handle, and admins get members, routing, numbers, the compliance policy and
staged imports from Follow Up Boss or CSV.

This repository holds **Phase 1**. What Phase 1 includes is fixed by [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md);
[`docs/VISION.md`](docs/VISION.md) describes where the product goes later.

## Architecture in one paragraph

This is a pnpm monorepo (TypeScript 6, Node 22, ESM). `packages/core` holds the pure domain logic: the
ownership engine, the `canContact` compliance gate, consent folding, the assistant's
evidence and autonomy rules, the priority feed, exception derivation and import planning. It has no
I/O, clock or randomness. `packages/db` holds the migrations, Kysely types, `withTenantTx` and the
persistence for ownership and consent. `apps/api` is one Fastify build with two entrypoints, the HTTP
server and the job worker. `apps/web` is the React 18 app. PostgreSQL 16 enforces tenant isolation with
FORCE ROW LEVEL SECURITY on every table: the application connects only as `app_user`, which has no
superuser rights and no RLS bypass. Lead ownership changes only through the ownership engine (an
append-only ledger). Every outbound text, email or call goes through one dispatch path that runs
`canContact` at send time.

The authoritative design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) (tables, RLS and the numbered rules `R-*`),
[`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) and [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) (where code
goes and how to test it). Running it for real teams (vendor adapters, container build, DNS, backups, key
rotation) is in [`docs/DEPLOY.md`](docs/DEPLOY.md); a fake-provider staging VM is [`docs/STAGING.md`](docs/STAGING.md).

## Setup

You need:
- Node 22 and pnpm 10 (`corepack enable`).
- PostgreSQL 16 on `localhost:5432`, with a superuser the dev tooling can use. `.env.example` assumes `app_owner` / `dev`.
- For browser tests and the screenshot walk: Playwright with Chromium (CONVENTIONS §1).

```sh
pnpm install
pnpm db:setup      # writes .env (fresh dev KEK + session secret) if missing, creates realty_dev,
                   # provisions the RLS-bound app_user role, applies every migration
pnpm seed          # the demo tenant below (refuses to run twice; `pnpm seed --reset` rebuilds the dev DB)
```

Run the three processes, each in its own terminal:

```sh
pnpm dev:api       # http://localhost:3001 (all routes under /api)
pnpm dev:worker    # job loop, sweeper (every 15 s), maintenance (every 60 s)
pnpm dev:web       # http://localhost:5173 (proxies /api to the API, so cookies are same-origin)
```

Open http://localhost:5173 and sign in with one of the demo logins.

Other commands:

| What | Command |
|---|---|
| typecheck everything | `pnpm -r typecheck` |
| all tests | `pnpm -r test` (each DB test gets its own Postgres database through `createTestDb`; `realty_dev` is never used) |
| lint, including the architecture rules | `pnpm lint` |
| browser tests (phone and desktop) | `pnpm --filter @realty/web test:e2e` (starts Vite on `E2E_WEB_PORT`, default 5173, and fails at once if that port is taken: stop `dev:web` first, or run another checkout's suite on another port, `E2E_WEB_PORT=5273 pnpm --filter @realty/web test:e2e`) |
| rule and edge-case coverage | `pnpm rule-coverage` |
| apply new migrations to the dev DB | `pnpm db:migrate` |
| load test at 250k contacts (see [docs/PERFORMANCE.md](docs/PERFORMANCE.md)) | `pnpm load:seed --contacts 250000`, then `pnpm load:bench`; CI-sized check: `pnpm load:smoke` |

## Demo logins

`pnpm seed` builds the tenant **Harbor & Pine Team** (brokerage *Harbor & Pine Realty LLC*, timezone
America/New_York). Every user's password is **`harbor-pine-demo-2026`**.

| Role | Name | Email | Notes |
|---|---|---|---|
| Owner | Olivia Grant | `owner@demo.realty-os.test` | MFA is required for Owners and Admins. `pnpm demo:totp` prints the current 6-digit code. |
| Team Lead | Taylor Morgan | `lead@demo.realty-os.test` | Leads "Harbor Team" and sees the "Needs attention" queue. |
| Agent | Avery Brooks | `avery@demo.realty-os.test` | The main demo agent. |
| Agent | Blake Chen | `blake@demo.realty-os.test` | |
| Agent | Casey Diaz | `casey@demo.realty-os.test` | |
| ISA | Isabel Reyes | `isabel@demo.realty-os.test` | |
| TC | Toni Walsh | `toni@demo.realty-os.test` | |

The seed writes these logins and the Owner's TOTP secret to `.demo/credentials.json` (gitignored,
mode 600). They are for the local dev database only.

### What the seed creates

Almost everything goes through the real API in-process, as `app_user` with the dev keys. The
exceptions are marked in `apps/api/src/seed/demo.ts`:
- Users are invited by email and accept through the link. Agents register a (fake) push device.
- One team, a buyer pond plus the default pond, a round-robin routing rule, a signed lead source,
  30-minute offers with round-the-clock routing, and the brokerage identity with its postal address.
- A team number with an approved 10DLC registration, and a team email identity.
- **40 contacts**, each with a different consent situation (since owner decision D1 only opt-outs block a send; consent entries are history):
  - most carry staff-entered express consent for texts, calls and email;
  - **Owen Price** texted `STOP` through the signed telephony webhook and has opted out of texts (the one block nobody can override);
  - **Dana Whitfield** is an ordinary seller lead (the national Do Not Call registry is no longer checked, so no scrub row is seeded);
  - **Grace Kim** has a Los Angeles, CA address. California is an all-party recording-consent state, and with no counsel-reviewed CA pack the call gate announces recording;
  - **Aria Jensen** has consent for email only.
- **9 inquiries** through the signed intake webhook, offered round robin. They end up in several states:
  - Avery holds two live offers; one is set to expire about 6 minutes after the seed finishes;
  - Blake and Casey each accepted a lead and never touched it, so the first-contact SLA lapsed (untouched leads);
  - one lead was released to the buyer pond;
  - one was declined and re-offered by the ownership follow-up job;
  - one was released and then claimed from the pond;
  - one was closed as spam.
- Conversations: inbound texts from Jane, Lena and Ryan, with **assistant drafts waiting for approval**. Each draft carries evidence quotes; the fake model always adds one deliberately unverifiable quote, which the UI flags "Check this".
- A text the carrier rejected (Liam Foster) and a text that went through (Noah Bennett).
- Appointments, including two consults that ended hours ago with no outcome logged, plus tasks, **5 listings** and **7 deals** (prospect, agreement signed, active, under contract, closed, lost).
- An **approved team nurture playbook**, "Sphere check-ins" (two emails), with 4 enrollments.
- A recorded call with Sophia Nguyen 5 days ago. The real call pipeline turned it into a summary, a promise that is now **overdue**, and a **saved buyer search pending Avery's approval**. Each criterion is quoted at its offset in the call.
- **Tags** on 11 people (Pre-approved, First-time buyer, Investor, Past client, Relocating), each typed on by the agent who owns the person, and four **custom fields** the Owner defined: Budget (a number), Timeline (choices), Pre-approval expires (a date) and Birthday (a yearly date: the person's agent gets a reminder task the week before). Several people have values; Sophia Nguyen has all four.
- **Lead email**: a "Zillow" lead source with email intake on (allowed sender `zillow.com`), and one email waiting in **Needs review**. It claims to come from `leads@zillow.com` but was signed by another domain, so the trust rule held it and no lead exists yet. The "Website inquiry form" source's email intake stays off, so you can try *Turn on lead email*. (Only when the deployment has an inbound domain, `LEAD_EMAIL_INBOUND_DOMAIN`: dev has one by default; the staging demo has none, so the seed skips this there.)
- The exception queue then holds every type: untouched lead, overdue promise, undelivered text and missing outcome.

Offers and SLAs are real timers. If you open the demo long after seeding, the worker will have moved
things on (expired offers re-route, untouched leads auto-release after 24 h). `pnpm seed --reset`
starts over.

### A five-minute tour

1. **Avery** (phone-sized window works best): see the Home feed's "Due now" band with live countdowns. **Accept** an offer. Use **Search** to find Noah and send him a text. Open **Owen Price** and try to text him: the send is blocked inline with "Opted out of texts", and the thread marks the attempt "Not sent". In **Approvals**, send Jane's or Lena's draft. Look at Sophia's saved-search proposal and its call quotes.
2. **Taylor** (Team Lead): open **Needs attention**. **Reassign** an untouched lead (2 taps), then **Verify** an item. In **Needs review**, read why Elena Marsh's Zillow email is waiting, then **Accept** it to make the lead or **Discard** it (dev only: a deployment without `LEAD_EMAIL_INBOUND_DOMAIN`, such as the staging demo, has no lead email, so its Needs review is empty).
3. **Olivia** (Owner, MFA code from `pnpm demo:totp`): **Imports**, choose a CSV file, then *Count what's there*, *Take snapshot* and *Run dry run* on Contacts. Read the per-category report and the per-record review list. Nothing is written until each category is approved.

## What is real and what is faked

Phase 1 ships an adapter interface for every outside service. Each has a deterministic fake that is
the default in dev and in tests.

| Service | Phase 1 status |
|---|---|
| PostgreSQL, RLS, encryption | **Real.** AES-256-GCM envelope encryption with per-tenant keys wrapped by a local KEK (`KEK_BASE64`; a KMS-backed KEK is not built), plus HMAC address keys. |
| Object storage | **Real** local encrypted filesystem (`STORAGE_DIR`, default `.storage/`). S3 is not built. |
| Telephony and SMS (Twilio-shaped) | **Fake** (`TELEPHONY_PROVIDER=fake`). Nothing is sent. The webhook signature algorithm is real, and `=real` refuses to start because there is no vendor adapter. |
| Contact email | **Fake** (`EMAIL_PROVIDER=fake`). Account email (invites, password reset) is a fake mailer that records the link. |
| AI model | **Fake** by default: deterministic drafts and claims, plus one deliberately unverifiable quote per run so evidence checking is always exercised. Fake explanations end with a short `(ref …)` digest. A real Anthropic adapter exists (`AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`) but has not been run against the live service. |
| Web push | **Fake** by default. A real `web-push` adapter exists (VAPID keys) but has not been exercised live. The web app does not register a service worker yet. |
| Transcription, MLS/IDX, AVM, DNC scrub, carrier lookup | **Fake** only. AVM always answers "not available" (Phase 2). |
| Follow Up Boss import | **Fake** connector by default (`FUB_PROVIDER=fake`). The HTTP connector is tested only against a recorded stand-in, not a live FUB account. Field names need checking against a real export. |

## Phase 1 scope

The 17 BUILD_PLAN modules:
- core: foundation, compliance, ownership, assistant, priority and import;
- db/client;
- api: platform (auth, MFA, sessions, RBAC, audit, crypto), jobs-worker, admin, leads, comms, assistant, workspace (feed, tasks, appointments, deals, listings, search, notifications), accountability (exception queue, scoreboard) and imports;
- web: the shell plus the agent, Team Lead and admin surfaces.

Out of scope, per ARCHITECTURE §18: seller updates, AVM home-value steps, multi-turn autonomous
qualification, native apps and anything else VISION.md lists for later phases.

## Known gaps

These are open. Each module's report has the full list.

- **Not automatable here, pending:**
  - counsel review of every VERIFY WITH COUNSEL default (jurisdiction packs, recording announcements, attestation wording, opt-out and footer text), and of owner decision D1: relying on third-party consent with no consent minimums, DNC registry check, quiet hours or frequency caps may conflict with state mini-TCPA laws such as Florida's FTSA (ARCHITECTURE §19). The UI says plainly that the US pack has not been reviewed;
  - the Phase 1 load test (3 tenants × 250k contacts × 50 agents). Only smaller smoke proxies run;
  - Lighthouse runs on real devices, and usability sessions with agents against their FUB baseline;
  - the security review of the SECURITY DEFINER functions added in migrations 0002–0012, and the ASVS L2 checklist.
- **Missing application paths:**
  - no route edits a contact's address. The seed writes that row directly (marked in the seed);
  - intake does not record consent events. Since D1 that no longer stops the 60-second first response (it texts unless the number opted out), but no consent history is kept for web leads;
  - there is no thread endpoint with full message bodies (the timeline preview is 280 characters);
  - recordings cannot be played at a quoted offset in the web app;
  - there is no call-status endpoint, so the post-call sheet opens when the call starts rather than at hang-up.
- **Notifications:** the sweeper enqueues `notify.deliver`, so a push can arrive up to about 15 s late. There is no agent-alert email sender.
- **Search** is prefix-based on names, phone digits, email and street. It is not typo-tolerant, because trigram indexes are not usable under RLS.
- **Demo data caveats:**
  - the fake telephony provider numbers purchases from a per-process counter, so buying a number in the running app can collide with the seeded one;
  - offers in the seed expire in real time.
