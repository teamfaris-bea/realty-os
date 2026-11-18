-- Batch 18, review round 5: a saved-search alert the source check refused is held, so it is not asked again on every run
-- (DATA_MODEL R-LSRC-10, E747, E756). Security notes: docs/ARCHITECTURE.md §21.71.
--
--   A saved-search alert is automated contact: nothing goes to a marked source's person or to an imported person whose
--   source is not reviewed (R-LSRC-8, R-LSRC-9). The alert sender left such a person out by calling the source definer
--   inside its due-batch query. Their matches are never recorded as alerted (that is the point), so the same searches
--   came back on every run, every ten minutes and once per newly matched listing, and each run asked the definer again
--   for every one of them: about 5,000 calls a run at 5,000 such searches, and the 30 s statement timeout at a few tens
--   of thousands, which stops alerts for the whole team.
--
--   * saved_searches.alerts_held_until (timestamptz, NULL: not held). Set by the alert sender (the system actor,
--     apps/api assistant/searches.ts) to one hour ahead on every active search of a person the source check has just
--     refused; the due-batch query skips a search while the time is in the future, with a plain column comparison and
--     no definer. Cleared by the API, in the Owner's own transaction, for the people a mapping change or the setting
--     being turned off may have released (leads/sourceStop.ts). It is a "do not ask again before" time and nothing
--     else: it never lets a message go. The sender still asks the source check under the person's lock before anything
--     is queued, dispatch TX1 and app.messages_source_guard still refuse, and a hold that outlives its reason only
--     delays an alert by up to the hour.
--   * saved_searches_held_contact: a partial index on the held searches by person, so clearing the holds of one
--     label's or one source's people reads the held rows only.
--   No new table, policy, grant or definer: saved_searches keeps its FORCE row-level security, its tenant and support
--   policies and its triggers; the column is written under the same UPDATE rights as last_alerted_at.
--
--   EXISTING DATA. Every search starts not held. Nothing is rewritten.

ALTER TABLE saved_searches ADD COLUMN alerts_held_until timestamptz;
COMMENT ON COLUMN saved_searches.alerts_held_until IS
  'b18 0104: the alert sender does not look at this search again before this time (NULL: not held). Set an hour ahead when the source check refuses its person (a marked source''s person, or imported and not reviewed: R-LSRC-8, R-LSRC-9); cleared when the Owner''s mapping or setting change may have released them. Never a permission to send: the source check is asked again before anything is queued.';
CREATE INDEX saved_searches_held_contact ON saved_searches (tenant_id, contact_id) WHERE alerts_held_until IS NOT NULL;

-- Self-check: the table still forces row-level security with its restrictive tenant policy and the support trigger.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.saved_searches'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0104: saved_searches must force row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.saved_searches'::regclass AND NOT polpermissive) THEN
    RAISE EXCEPTION '0104: saved_searches must keep its restrictive tenant policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.saved_searches'::regclass AND tgname = 'support_read_only' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0104: saved_searches must keep the support read-only trigger';
  END IF;
END $$;
