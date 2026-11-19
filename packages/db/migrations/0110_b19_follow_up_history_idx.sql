-- Batch 19, warm follow-up in Today (fix pass, M9): the indexes the follow-up history read needs
-- (apps/api workspace/repos/followUp.ts followUpHistorySql; DATA_MODEL R-TODAY-17). Security notes: none are needed.
-- These are plain indexes: no function, no policy and no grant changes, and row-level security on both tables is as it was.
--
--   GET /feed reads, for every follow-up card and every candidate of the daily plan, the newest row of each kind that
--   could be "what was last discussed". Two of those reads had no index that fits them:
--
--   * appointments: "the newest HELD appointment of this person". The only indexes were by organizer
--     (appointments_user_idx) and by ends_at for the missing-outcome scan, so each person's read scanned every
--     appointment of the tenant: 139 of 145 ms of the statement with 20,000 appointments, on a 30-second poll.
--   * notes: "the newest call, text or email the agent LOGGED for this person", ordered by when the agent said it
--     happened (activity_at), which notes_contact_idx (by created_at) cannot give: every note of the person was read
--     and sorted.
--
--   A third is partial and tiny: "the latest IMPORTED note of this person" otherwise walks the person's whole note
--   history looking for one, and most people have none.
--
-- All three are partial, so they hold only the rows those reads want; a write to any other row pays nothing.
-- (0106 to 0109 are other batch-19 branches' numbers; this one is 0110 by the fix brief.)

CREATE INDEX appointments_contact_held_idx ON appointments (tenant_id, contact_id, starts_at DESC, id DESC)
  WHERE status = 'held';

-- (notes_logged_activity_shape, 0021: a logged activity always has its kind and its activity_at)
CREATE INDEX notes_logged_activity_idx ON notes (tenant_id, contact_id, activity_at DESC, id DESC)
  WHERE source = 'logged_activity' AND NOT imported;

CREATE INDEX notes_imported_contact_idx ON notes (tenant_id, contact_id, created_at DESC)
  WHERE imported;

-- M11 (R-TODAY-18): "Recent people" of the person picker is the caller's OWN recent activity: the people they most
-- recently logged for or wrote a note about (and called: calls_agent_idx, 0001). Read by author, newest first; notes
-- had no index by author. No write happens when a person or the picker is opened.
CREATE INDEX notes_author_recent_idx ON notes (tenant_id, author_user_id, created_at DESC)
  WHERE author_user_id IS NOT NULL AND contact_id IS NOT NULL;
