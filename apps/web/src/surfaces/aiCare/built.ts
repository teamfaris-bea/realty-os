// What this deployment has built (Q6). One constant each; ISA-2b widens BUILT (share_listings, propose_saved_search,
// book_appointments) and flips EMAIL_SENDER_CHECKS when the DKIM verdicts reach the turn path (ISA-2 report, gaps).
export const BUILT: ReadonlySet<string> = new Set(['converse']);

/**
 * Email replies are turns only with an aligned DKIM pass (isa/ingest.ts dkimAligned). ISA-2b wired the provider verdicts
 * (cb7932c), so the opt-in form no longer says email replies always come back to the agent. false restores the note.
 */
export const EMAIL_SENDER_CHECKS = true;
