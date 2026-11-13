// What this deployment has built (Q6). b13 review B13S-2: which capabilities are built is the API's one list
// (apps/api/src/isa/sentences.ts ISA_BUILT_CAPABILITIES), read from GET /me/ai-isa `builtCapabilities` and each panel
// row's `built`; the web keeps no copy of it, so it can never say a capability the AI uses is unbuilt.

/**
 * Email replies are turns only with an aligned DKIM pass (isa/ingest.ts dkimAligned). ISA-2b wired the provider verdicts
 * (cb7932c), so the opt-in form no longer says email replies always come back to the agent. false restores the note.
 */
export const EMAIL_SENDER_CHECKS = true;
