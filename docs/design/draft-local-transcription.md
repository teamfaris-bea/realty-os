# DRAFT: local call transcription

Status: draft lane. Nothing here is deployed, no recording is turned on, and FUB stays in place.

## Why

Agents skip notes. FUB exposes no call recordings or transcripts, so a call that was not typed up is lost to the
lead summary and to the timing-cue scan. Realty OS already has a recording and transcript model (0001_init.sql
`recordings`, `transcripts`; `comms/recordings.ts`) but no transcriber: production runs `UnconfiguredTranscription`.
This adds a local one. Audio is transcribed on the team's own GPU machine for $0 and never sent to a cloud service.

## What this change adds

| Piece | Where | What it does |
|---|---|---|
| Provider | `apps/api/src/providers/transcription/localWhisper.ts` | `LocalWhisperTranscription`: posts decrypted audio to the sidecar. Host must be loopback, private LAN or a private overlay range (100.64/10); any DNS name but `localhost` is refused, so there is no way to point it at a cloud API. Token required off loopback, redirects refused, 10 min timeout, 4 MiB response cap, zod-checked response, nothing logged. |
| Config | `apps/api/src/config.ts` | `TRANSCRIPTION_PROVIDER=none\|local_whisper` (default `none`, so today's behaviour is unchanged), `TRANSCRIPTION_LOCAL_URL`, `TRANSCRIPTION_LOCAL_TOKEN`. Bad values fail at boot. The token is not in `redactConfig`. |
| Sidecar | `tools/transcriber/server.py` | faster-whisper `large-v3-turbo` fp16 on CUDA. Splits dual-channel audio into agent and client. One job at a time, 2 CPU threads. |
| Ingest plan | `packages/core/src/transcription/policy.ts` | `planIngest`: whether an arriving recording is kept and transcribed, with retention dates. Off by default. Refuses a call with no consent basis, never invents one. |
| Data model | existing `recordings` / `transcripts` | Linked to the call and contact. Audio retention is `recordings.retain_until`, with legal hold and shredding already there. Transcripts are AES-256-GCM per tenant and not searchable. `transcripts.provider` now records `local_whisper` instead of a hard-coded `fake`. |
| Timing-cue scan | `packages/core/src/transcription/timing.ts`, `apps/api/src/comms/transcriptHooks.ts` | Deterministic scan of the client's words for buy/sell timing ("by March", "next spring", "in two months"). Lease talk is flagged and never counts, which was the notes pilot's one false positive. `CommsDeps.onTranscriptReady` runs after a transcript is stored, best effort. The hook hands on ids, horizon and transcript ranges, never the words. |
| Lead summaries | existing `assistant/prompt.ts` | Already reads every stored call transcript as evidence. No change is needed. |

## How recordings would arrive

1. **Realty OS dialer (the intended path).** Twilio-shaped telephony already records per the call's stored recording
   decision (`comms/dial.ts decideRecording`). The recording webhook goes to `onRecordingReady`, which encrypts the
   audio into storage, then the `comms.transcribe` job, then this provider, then the transcript row and the
   timing-cue hook. Today the telephony kill switch is off and no Twilio account is live.
2. **Agent upload (not built).** An agent uploads a recording of a call made elsewhere. `planIngest` refuses
   `source: 'upload'` until uploads are turned on. They also need a `recordings.source` migration and decision T1.
3. **FUB: none.** FUB exposes no recordings. Imported FUB calls stay `import_fub` / `unknown_imported` and are never
   transcribed or reviewed.

## Where the sidecar runs

The API reaches `TRANSCRIPTION_LOCAL_URL`. If the API runs on the same machine as the GPU, that is
`http://127.0.0.1:8765` with no token. If the API runs elsewhere, such as the app VM, it needs a private path to the
GPU machine, for example a private overlay network in the 100.64/10 range, plus a token. That is new access: decision T4.

## Benchmark (synthetic speech, RTX 4080 SUPER)

large-v3-turbo fp16: 10 minutes of audio in 11.3 s (51x realtime), 1.0% word error rate on TTS speech, 3.4 GB peak
GPU memory. Details are in `tools/transcriber/README.md`. One GPU covers far more call volume than a team makes. Real
phone audio will have a higher error rate than TTS.

## OPEN DECISIONS (owner: Hamza; VERIFY WITH COUNSEL where marked)

- **T1 Recording consent and disclosure (VERIFY WITH COUNSEL).** South Carolina is generally described as a one-party
  consent state, but a call to or from a client in an all-party state (for example a military client already in
  another state) may need every party's consent. Agents may also need to be told their calls are recorded. Which mode
  applies (`announce_all` or `one_party_where_permitted`), whether to always play an announcement, and whether
  agent uploads are allowed are owner and counsel decisions. This change decides none of them.
- **T2 Who may read transcripts.** The existing recording-scope policy limits playback and transcript views to the
  contact's scope, and every view is audited. Should agents see their own calls' transcripts only, or the whole team's?
- **T3 Retention.** The placeholders are 90 days for audio and 730 days for transcript text. The transcript is never
  kept shorter than its audio. The Owner sets the real numbers.
- **T4 Network path.** Whether the production API may reach the office GPU machine over a private overlay, and
  who holds the token. This is new access and is not set up here.
- **T5 Timing-cue sink.** Where cues are stored for the nudge list (a new table and migration) and whether they create
  tasks or only rank the Monday list. Not wired: `onTranscriptReady` is unset in every runtime.
- **T6 Speaker separation.** Dual-channel recording (agent and client on separate channels) gives reliable labels. Mono
  gets none. Should the dialer record dual-channel? (It is a Twilio recording setting.)
