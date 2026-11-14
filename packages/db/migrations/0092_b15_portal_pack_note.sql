-- Batch 15: the platform:portal@2026.11.1 note names module 46's client page as shipped, with its counsel items.
-- Security notes: docs/ARCHITECTURE.md §21.58.
--
--   0091 published platform:portal@2026.11.1 unreviewed (PHASE2_3_PLAN Q-PORTAL-19; owner decision D11) with a note
--   listing the counsel items before it is cleared, ending "and module 46's client page, which is not shipped yet".
--   Batch 15 ships that page (module 46 `web/portal`, /portal.html; ARCHITECTURE §21.57), so that sentence is
--   replaced by the page's own counsel items (module 46 VERIFY 1 and 2) and the engineering checks to run first
--   (VERIFY 4 and 5, SECURITY §3). The note is stored data that the platform reads as the pack's record, so the
--   change is a migration; 0091 itself is not edited.
--   Only the 2026.11.1 row, and only while it is unreviewed, its notes hold no counsel review recorded or withdrawn
--   (packages/db/src/counselReview.ts appends those) and the old sentence is still there: a re-run changes nothing,
--   and a note that carries a review history is left exactly as it was. Data only: no table, function, policy,
--   grant or trigger changes; version, status, rules and reviewed_by_counsel_at are not touched, so
--   app.platform_cleared('platform:portal') answers exactly as before (the portal stays dark until counsel's review
--   of 2026.11.1 is recorded per deployment). VERIFY WITH COUNSEL.

UPDATE jurisdiction_packs
   SET notes = replace(notes,
         'and module 46''s client page, which is not shipped yet.',
         'and module 46''s client page as built (batch 15, ARCHITECTURE §21.57): its VERIFY 1 (counsel sees the '
         'client-facing words: signed out, nothing shared, "You can see this until {date}", "Shared {date}", not '
         'available, the staff preview banner, and dates with no done mark) and VERIFY 2 (the team slug remembered on '
         'the client''s device, never the address; Q-PORTALWEB-2). Before it is cleared, module 46''s engineering '
         'checks VERIFY 4 (Lighthouse) and VERIFY 5 (iOS Safari and in-app mail browsers) are run and recorded '
         '(SECURITY §3).')
 WHERE key = 'platform:portal' AND version = '2026.11.1' AND reviewed_by_counsel_at IS NULL
   AND position('Counsel review ' IN notes) = 0
   AND position('and module 46''s client page, which is not shipped yet.' IN notes) > 0;

-- Self-check: an unreviewed 2026.11.1 with no review history no longer says the page is not shipped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM jurisdiction_packs
              WHERE key = 'platform:portal' AND version = '2026.11.1' AND reviewed_by_counsel_at IS NULL
                AND position('Counsel review ' IN notes) = 0 AND position('which is not shipped yet' IN notes) > 0) THEN
    RAISE EXCEPTION '0092 self-check failed: the unreviewed platform:portal@2026.11.1 note still says module 46 is not shipped';
  END IF;
END $$;
