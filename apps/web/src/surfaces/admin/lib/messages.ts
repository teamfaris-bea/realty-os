// Error code → sentence for every code the lead-admin surfaces (team, admin, imports, settings) show
// (CONVENTIONS §7: the web never shows a raw code). Registered once, on the admin surface's
// `errorMessages`, so useCommand finds them through the page table; useAction reads the same map.
// Codes the agent surfaces or the shell already word (VERSION_CONFLICT, OWNER_REQUIRED, ...) are not
// repeated here: registry validation fails on two different sentences for one code.
import { AGENT_ERROR_MESSAGES } from '../../feed/lib/messages.js';

export const LEAD_ADMIN_ERROR_MESSAGES: Record<string, string> = {
  // members and invites (api/admin)
  LAST_OWNER: 'A team always needs one active Owner. Make someone else Owner first.',
  MEMBER_EXISTS: 'This person is already on the team. Change their role in the list instead.',
  INVITE_PENDING: 'This person already has an invite waiting. Revoke it to send a new one.',
  MEMBER_HAS_LEADS: 'They still hold leads. Use “Remove and move leads” so nothing is dropped.',
  DEACTIVATION_NOT_ALLOWED: "This person can't be removed from here.",
  // routing, ponds, teams (api/admin)
  RULE_INVALID: 'This rule is missing something it needs. Check the highlighted part and save again.',
  MEMBER_NOT_ELIGIBLE: "One of the people picked can't receive leads (not active, or a role that never takes leads).",
  POND_IN_USE: 'A routing rule still sends leads to this pond. Change that rule first.',
  POND_NOT_EMPTY: 'Leads are waiting in this pond. Assign or route them before archiving it.',
  DEFAULT_POND_PROTECTED: "The default pond can't be archived. Make another pond the default first.",
  DEFAULT_TEAM_PROTECTED: "The default team can't be deleted. Make another team the default first.",
  // numbers and email (api/comms)
  NUMBER_UNAVAILABLE: 'No number is available with that area code right now. Try a nearby one.',
  // R-TWL-1: the kill switch refused the number purchase / registration check before any request was made
  TELEPHONY_LIVE_OFF: 'Live texting and calling are off on this deployment.',
  // exceptions (api/accountability)
  EXCEPTION_STATE_CONFLICT: 'Someone handled this just now. The list below is up to date.',
  EXCEPTION_NOT_REASSIGNABLE: 'This item has no lead attached, so there is nothing to reassign.',
  // imports (api/imports)
  IMPORT_STATE_CONFLICT: 'This import changed since you opened it. What you see now is up to date.',
  IMPORT_STAGE_ORDER: 'Earlier categories must be verified or skipped before this one can be imported.',
  IMPORT_STAGE_BLOCKED: 'This category has problems to fix before it can go ahead. They are listed on the category.',
  SNAPSHOT_CHANGED: 'The source changed after this dry run. Take a new snapshot and run the dry run again.',
  IMPORT_DRY_RUN_STALE: 'The review list changed since the dry run. Run the dry run again before approving.',
  IMPORT_REVIEW_INVALID: "That decision doesn't fit this record. Pick another.",
  IMPORT_FILE_INVALID: "We couldn't read that file. Check it is a CSV (up to 50,000 rows) and try again.",
  FUB_KEY_INVALID: 'Follow Up Boss did not accept that API key. Copy it again from Follow Up Boss.',
  IMPORT_MAPPING_INVALID: 'Every Follow Up Boss agent needs a match on this team before ownership can be imported.',
  RECOUNT_MISMATCH: "The counts don't match yet, so this can't be marked verified. Check the differences listed.",
  SPOT_CHECKS_INCOMPLETE: 'Mark every side-by-side check before verifying.',
  SPOT_CHECK_FAILED: "A side-by-side check didn't match, so this can't be marked verified. Undo this category and check the source.",
  IMPORT_REVERT_ORDER: 'Undo later categories first: they depend on this one.',
  // playbooks (api/assistant)
  PLAYBOOK_INVALID: 'This version has problems to fix before it can be approved. They are listed on each message.',
  PLAYBOOK_HASH_MISMATCH: 'This version changed since you reviewed it. Review it again, then approve.',
  PLAYBOOK_VERSION_NOT_DRAFT: 'This version was already approved or replaced.',
  PLAYBOOK_NOT_APPROVED: 'This playbook has no approved version yet.',
  PLAYBOOK_OWNER_MISMATCH: 'Only the playbook’s owner can approve it. Team playbooks are approved by an Owner or Admin.',
  // the stage whose entry starts a playbook (api/stage-automation, R-PAR-16)
  AUTO_ENROLL_STAGE_TAKEN: 'Another playbook already starts on that stage. Clear the stage on that playbook first, or pick another one.',
  AUTO_ENROLL_NOT_ALLOWED: "An instant reply to new leads starts when a lead arrives, so it can't also start on a stage change.",
  PLAYBOOK_RETIRED: "This playbook was retired, so it can't start on a stage change.",
  // privacy erasure (api/admin erasure, R-DATA-4, E59)
  CONTACT_ON_DEAL: "This person is on a deal, so they can't be erased yet. The deal is a transaction record and stays; the Owner removes them from the deal first.",
  DEAL_STILL_OPEN: 'This person is the primary contact of a deal that is still open. Change the primary contact on the deal first, then remove them here.',
  // D1: their do-not-contact could not be kept on every one of their addresses (an old Messenger or Instagram identity)
  PERSON_DO_NOT_CONTACT_UNCARRIED: "This person asked not to be contacted, and Realty OS can't keep that on every one of their addresses yet, so they weren't erased. Nothing was changed.",
  // System page job commands (api/observability, lane ops-observability)
  JOB_NOT_RETRYABLE: "This job can't be retried now: it already finished, is running, or was cancelled. The list below is up to date.",
  JOB_ALREADY_QUEUED: 'A newer copy of this work is already waiting or running, so retrying this one would do it twice. Nothing was changed.',
  JOB_NOT_CANCELLABLE: 'Only a job that is waiting can be cancelled. This one is running or already finished; the list below is up to date.',
};

/** Every sentence these surfaces may need: theirs plus the agent surfaces' (shared codes). */
export const ADMIN_MESSAGES: Record<string, string> = { ...AGENT_ERROR_MESSAGES, ...LEAD_ADMIN_ERROR_MESSAGES };
