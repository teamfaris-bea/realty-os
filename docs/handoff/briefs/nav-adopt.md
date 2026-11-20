<task>
You are a senior front-end engineer on Realty OS. The owner has chosen the app's navigation: a slim left rail on desktop with search always on top, and on the phone search on top with five tabs plus More as a full page. A working prototype exists behind a switch. Make it the real, default navigation for every role, remove the old one, and update every test that depended on the old one without weakening any check. Tests first where behaviour is new. Do not push.
</task>

<context>
Worktree: {{WT}}, branch next/navigation, cut from origin/main {{BASE}} with the prototype commit from origin/explore/navigation (c2c1144c) applied on top. The prototype's code is in apps/web/src/shell: exploreNavModel.ts (the per-role primary pages and groups), GlobalSearch.tsx, NavExplore.tsx, with edits to Layout.tsx, ShellPages.tsx and App.tsx; `?nav=a` is the chosen direction on desktop and `?nav=b`'s More PAGE is the chosen behaviour on the phone. Its author's report, with measurements and what adoption needs: <your scratch folder>/status.md (search for "NAVIGATION EXPLORATION DONE" and "OWNER PICKED THE NAVIGATION"), and 84 screenshots in <your scratch folder>/nav-shots/.
The owner's words: "search bar needs to be up on top at all times". The users are agents working from an iPhone between showings, a team lead and an owner; they found their previous CRM hard to learn.
Local facts: Postgres 16 runs locally (`service postgresql start` if needed). Do NOT run `pnpm db:setup`. 4 cores, other work may be running: Playwright single spec files with `--workers=2 --trace off` and `E2E_WEB_PORT=5381`; vitest with `--maxWorkers=2`; never a whole suite; never a detached process.
Commit messages: prefix "b19: ", ending with your own tool's attribution line (see docs/handoff/README.md).
Commit after every item. If you are resumed, run `git log --oneline origin/main..HEAD` and `git status --short` first.
</context>

<instructions>
1. Make the chosen navigation the only one: desktop slim rail (primary pages with icon and label, then More opening the grouped panel), top bar with the search field, Add person and the account menu; phone top bar with the search field, bottom tabs of the five primary pages plus More, and More as the /more PAGE with the groups. Remove the `?nav=` switch, the "Navigation preview" menu entry, the old sidebar, the old tab bar and the old More list. No route, permission or page may change; every page a role could open before is still reachable in at most two clicks or taps (keep and extend the prototype's unit tests that prove this for all six roles on desktop and phone).
2. Put placement where the codebase keeps it. Today each page declares its own `nav` in its surface registration; the prototype keeps primary pages and groups in one shell file. Add a `group` (and `primaryFor` roles, or the equivalent) to the page declaration type so a new page states where it goes and a test fails if a page has no placement; move the prototype's table into those declarations.
3. Primary pages per role. Start from the prototype's sets. Two corrections: an Owner or Admin who also works leads must keep Tasks and Approvals one click away (make the owner's desktop rail: Home, People, Approvals, Tasks, Owner view, Needs attention, with Scoreboard and Deals first under More; say what you did for Admin); keep the labels "Home" and "Approvals" unless the page titles change too.
4. Search. Results rank the viewer's OWN people first, then people shared with them, then other matches the API returned such as a masked pond lead (the prototype put a masked pond lead first). Do the ordering from fields the search API already returns; if it returns nothing to rank by, add the smallest additive field to the API with a test, never widen what a role can see. Enter opens the highlighted row, or the Search page when none is highlighted (never silently the first row). Keep: "/" and Cmd or Ctrl+K, arrow keys, Escape, "See all results", page names as results, and on the phone the field that expands with Cancel. Make the Search page follow the query itself instead of being remounted. A person row shows what matched ("Matched on phone") without revealing the phone or email text, as today.
5. Accessibility and layout, no check relaxed: landmarks named, aria-current, visible focus, 44 px targets, focus never hidden under the top bar (teach apps/web/e2e/a11y/checks.ts about the new fixed top bar, by declaring it the way other fixed elements are declared), no sideways scroll at 320 px, long page and person names wrap. The a11y sweep opens More, the account menu and the search results for each role, in light and dark. Check dark mode by eye in screenshots.
6. Update the tests that depended on the old navigation: every unit test and e2e spec or helper that uses the "Main" or "Main tabs" landmarks, clicks the Search link or tab, opens Account from the sidebar, or goes "More then page" on the phone. Change selectors and step counts only where the navigation itself changed; where a tap budget changes, say so in the test title and in the handback (finding a person on the phone should drop by one; a desktop page now under More gains one). Do not delete or loosen any other assertion.
7. Retake the navigation screenshots for an agent and an owner, desktop 1440x900 at deviceScaleFactor 2 and the iPhone 13 descriptor, light and dark: home, People, a contact, More open, search with results. Save to <your scratch folder>/nav-final/ and LOOK at each.
8. Docs: the conventions and parity documents that name the sidebar and tab bar; a short section in docs/ARCHITECTURE.md.
9. Checks: `pnpm -r typecheck`; `pnpm lint`; apps/web `TZ=UTC npx vitest run --maxWorkers=2` and under `TZ=America/New_York`; every e2e spec you changed, one at a time; a11y by role, one invocation per role; journeys j1, j5, j7, j10 and agent/jobs. Report each exact result line, and list the e2e specs you did NOT run.
</instructions>

<examples>
A page declaration after item 2: `nav: { group: 'work', primaryFor: ['agent', 'isa'], icon: 'tasks', order: 4 }`.
Not acceptable: a page that became unreachable for a role; search showing something the API did not return; a relaxed accessibility or layout check; a tap silently moved outside a counter; decorative restyling beyond the navigation (the visual identity pass is separate); real names, emails or phone numbers in fixtures; claiming a real-iPhone result.
</examples>

<final_output>
<handback>
<head>branch head commit</head>
<items>items 1 to 8: done, partly or not done; the change; the test</items>
<budgets>every tap or click budget that changed, old and new, and where it is asserted</budgets>
<checks>each command and spec with its exact result line; the specs not run</checks>
<screenshots>each file, what it shows, and that you looked at it</screenshots>
<not_verified>what you did not run or could not prove (everything on the phone is Chromium emulation)</not_verified>
<questions>questions for the owner, each with the default you built</questions>
</handback>
</final_output>

Reminder: search on top of every page; nothing becomes unreachable; no permission or route changes; no check relaxed; own people rank first in search; single spec files on port 5381; do not push; on a usage-limit or quota error stop at once and report it verbatim. If you are not confident of something, say so; do not invent.
