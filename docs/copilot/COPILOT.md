# Lead copilot (local AI)

For one lead, the copilot gives the assigned agent three things:

1. **Summary**: confirmed facts from the records (touches, talk time, last touch, last reply, notes, call transcripts, timing cues), plus an optional short narrative from the local model labelled UNVERIFIED.
2. **Next message draft**: one text or email for the agent to review, edit and send themselves. It is checked against the team voice and content rules; a model draft that fails any check is replaced by the playbook template.
3. **Slipping flags**: the rules of the speed-to-lead and slipping-lead playbooks, each with why, the next action, a due time, a data label (CONFIRMED / UNVERIFIED / DATA GAP) and the escalation path.

Code: `packages/core/src/copilot/**` (pure: rules, prompts, checks, templates) and `apps/api/src/copilot/**` (the local model adapter, the input ports and the runner). Nothing is mounted on a route yet (see "Not in this change").

## Rules (CP-n ids are named in the tests)

| Id | Rule |
|---|---|
| CP-1 | Suggestions only. The copilot never sends, dials, changes a stage, reassigns, or writes to the CRM. Every result has `suggestionOnly: true` and every draft has `agentSendsThemselves: true`. Architecture tests scan both directories for send, dial, stage and reassignment calls and for DB or comms imports. |
| CP-2 | The summary's facts come only from logged records. A touch is a human outbound call, text or email, or an appointment a person set. Automations, drips, action plans and notes are not touches. The model narrative is optional, bounded and UNVERIFIED, and it is dropped if it has links, phone numbers or emails. |
| CP-3 | Voice: very short and leads with the answer. At most 3 sentences, then "Thank you" with nothing after it (no sign-off, name or "Best,"). It includes a next step with a time window. SMS is capped at 320 characters, email at 700. |
| CP-4 | Content: no rental wording anywhere in a draft. The brokerage name appears where the draft is marketing (first contact, and every email). No promises about price, value, availability or representation. No money, offer or contract topics. No payment instructions, links, placeholders, AI or assistant wording, look-alike characters, or fair-housing hits (the existing fair-housing pack). A model draft may not name a number the records don't contain. |
| CP-5 | Slipping flags: speed to lead (5 min in business hours 8a–7p, 15 min after hours, escalate past 30 min); no human touch for 48 business-day hours (Mon–Fri); no next step or an overdue one; a reply not re-contacted (at risk at 24 h); a dormant lead with a fresh visit, email open or timing cue; hot or appointment set without confirmation or follow-up; a stated move window open now with no touch in 7 days; unassigned; no reachable channel (DATA GAP). Closed, trashed and do-not-contact leads get none. |
| CP-6 | Re-surface: a flag still open 48 h after it was first flagged comes back AT RISK. It never lowers an escalation. |
| CP-7 | Daily order: worst severity first, then recent lead activity > source quality > days since last contact > estimated value. |
| CP-8 | Draft choice: first contact > answer a reply > confirm the appointment > timing call (window now or within 90 days) > "still planning to move?" check-in (plan date passed) > follow-up. The channel is SMS if reachable, else email, else none. Do-not-contact gets no draft. |
| CP-9 | Inputs come through ports (`apps/api/src/copilot/sources.ts`): `LeadHistorySource` (CRM), `TimingCueSource` (timing-cue scan lane) and `TranscriptSource` (call-transcription lane). The core shapes are `CopilotTimingCue` and `CopilotTranscript` in `packages/core/src/copilot/types.ts`. A cue the scan excluded (sold or listed, rental intent, not a plan) never drives a flag or a draft. |
| CP-10 | Local models only. `CopilotModel.locality` is the literal `'local'`, and the runner also refuses anything else at run time. The Ollama adapter accepts only loopback, private-network or CGNAT hosts, or host names listed explicitly. It refuses credentials in the URL and refuses redirects. The copilot never uses the shared `providers.ai`. Lead history goes into the prompt inside one nonce fence, neutralized, with phones and emails masked, and model output is parsed as one closed JSON object. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `COPILOT_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama. Must be loopback or private network. `off` turns the model off: facts, flags and templates only. |
| `COPILOT_OLLAMA_MODEL` | `qwen2.5:14b` | Model tag. |
| `COPILOT_OLLAMA_HOSTS` | (none) | Extra local host names, e.g. a docker service name. |
| `COPILOT_TIMEOUT_MS` | `60000` | Per model call. On timeout the deterministic result is used. |

`CopilotPolicy` holds the team zone, the business window and the brokerage name. It is tenant configuration. Fixtures use the invented name "Example Realty Group".

## Interfaces for the parallel lanes

- **Timing-cue scan**: implement `TimingCueSource.cuesFor(leadId)` and return `CopilotTimingCue[]`, with intent, window dates in the team zone, the time the lead said it, a short evidence quote, the origin (note, transcript or form) and the extractor tag. Use `excluded` for your own exclusions.
- **Call transcription**: implement `TranscriptSource.transcriptsFor(leadId)` and return `CopilotTranscript[]`, with speaker-tagged lines, the call time and duration, and the engine tag. The copilot keeps the latest 2 and caps each at 2,000 characters in the prompt.

## Not in this change (needs a decision or a shared-file edit)

- An HTTP route plus RBAC (`routes.ts`, `rbac.ts`, `capabilityPaths.json`), the web panel on the contact page, the `Providers` bag and `config.ts` wiring, and a `LeadHistorySource` repo over the real tables. Each touches shared registration files and is left for the integration step.
- A table to persist `priorFlags` so the re-surface rule works across days.
- Whether the brokerage name should also be required on non-first-contact texts. Today it is required only on first contact and on email.
