// What this deployment has built (Q6). One constant each; ISA-2b widens BUILT (share_listings, propose_saved_search,
// book_appointments) and flips EMAIL_SENDER_CHECKS when the DKIM verdicts reach the turn path (ISA-2 report, gaps).
export const BUILT: ReadonlySet<string> = new Set(['converse']);

/** Email replies from the person are not turns until DKIM verdicts are wired: they pause care and come to the owner. */
export const EMAIL_SENDER_CHECKS = false;
