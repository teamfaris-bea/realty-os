# Vision

North star for the product. Most of this is **later phases**; the phase each item belongs to is noted. Phase 1 scope is defined by `BUILD_PLAN.md`, not by this file.

## Decision: standalone product

This is a standalone platform that teams move onto, not a layer on top of Follow Up Boss. Teams come over through the staged FUB migration (export test, then dry run, then a check for each data category).

## Product values

- **Simplicity.** Fewer concepts, fewer screens. Nothing ships unless it removes real work.
- **Genuineness.** Honest UI: no fake activity, inflated numbers, or dark patterns. Assistant messages sound like the agent and never pretend to be something they are not.
- **One product on phone and desktop.** Many agents live on their phones. Daily agent jobs are first-class on mobile and desktop; admin is desktop-first but works on a phone.
- **Approve rules, not every message.** The assistant acts inside rules set once. Money, contracts, or a new kind of client message always wait for a tap.
- **Evidence over confidence.** Every assistant claim shows its source and a short explanation ("Callback due Thursday 4 PM, confirmed at 2:14 in the call"). Unclear details are flagged for review.

## Capabilities

| Capability | What it means | Phase |
|---|---|---|
| Today feed | Who to call now and why, deals at risk, agents behind on speed-to-lead; one tap to call, approve a text, or reassign | 1 |
| 60-second AI speed-to-lead | New leads get a consent-checked reply within 60s around the clock, qualifying questions (timeline, financing, VA/PCS), handoff with summary | 1 |
| Playbook autonomy | Agent approves a playbook once; the assistant sends eligible routine follow-ups, re-checks consent at send time, pauses on reply and hands back with context | 1 |
| Team Lead exception queue | Untouched leads, overdue promises, failed sends, consults missing outcomes; each with owner, evidence, resolve/reassign/verify | 1 |
| Agent scoreboard | Speed-to-lead, touches, appointments, agreements signed | 1 |
| Buyer searches | Confirmed call preferences become an editable search; agent approves and activates | 1 (own listings); MLS feed later |
| Behavior-aware nurture | Price drop on a saved home, new listing in their search, home anniversary, rate change — instead of 12-step drips | 1 (event capture + playbooks); richer triggers 2 |
| Lead source → commission | Every source traced to commission earned | 1 (capture); owner view 2 |
| Staged FUB migration | Export test and dry run first; contacts, ownership, notes, messages, recordings, consent verified separately | 1 |
| Brokerage identity | Brokerage name on all outbound marketing; jurisdiction rule packs (e.g. SC team-name/advertising rules) | 1 (name); packs grow |
| Unified inbox beyond SMS/email/call | Facebook/Instagram DMs, Zillow/realtor.com leads, website chat in one thread per person | 2 |
| Active seller updates | Showings, feedback, marketing activity, competing listings assembled; agent adds recommendation before sending | 2 |
| Post-closing program | Long-term nurture, referral asks, review requests, monthly home value updates | 1 (playbook template); value updates 2 |
| Marketing built in | One listing in → website page, social posts, open house blast, Marketplace post, flyer, seller report; approve each once | 2 |
| Transaction milestones | Contract dates become milestones with risk flags and client/lender updates | 2 |
| Call scoring and self-coaching | Every call scored; one specific fix a day per agent; weekly improving/slipping view | 2–3 |
| Owner view | Dollars by lead source, cost per closing, pipeline velocity, forecast | 2 |
| Voice AI | Answers missed and after-hours calls live, qualifies, books, warm-transfers hot leads to the on-duty agent | 3 |
| 90-day prediction | Who will transact, from behavior plus public records (equity, time in home, life events) | 3 |
| Ad spend that shifts itself | Toward what closes, within a budget cap you set (cap changes require a tap) | 3 |
| Client portal | Buyers and sellers see their timeline, documents, showings, feedback, next steps | 3 |

## Compliance flags (VERIFY WITH COUNSEL)

- **AI voice.** The FCC treats AI-generated voices as "artificial" under the TCPA for outbound calls, and AI-disclosure laws vary by state. Consistent with the genuineness value, the assistant identifies itself as the agent's assistant by default.
- **Prediction and fair housing.** Scoring must exclude protected-class data and proxies. Military status and source of income are protected in some jurisdictions. PCS orders are not public records; use only self-reported data with consent.
- **Email engagement.** Opens are unreliable (Apple Mail Privacy Protection); show them as signals, never as facts.
- **Jurisdiction rules.** Advertising and team-name rules (e.g. South Carolina) live in configurable jurisdiction packs, never hard-coded for one state.
