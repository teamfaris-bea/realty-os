-- Batch 14 round 2: the client portal (module 45). Security notes: docs/ARCHITECTURE.md §21.56.
--
--   1. platform:portal@2026.11.1 (PHASE2_3_PLAN Q-PORTAL-19; owner decision D11; the batch 14 review's F1,
--      db-security). Counsel's review reported on 2026-11-12 was of 0018's 2026.11.0 placeholder, the day before
--      module 45 was built, and module 45 lists counsel items "before platform:portal is cleared" (ARCHITECTURE
--      §21.52 VERIFY 1-6, Q-PORTAL-16, module 46's client page). As 0084 did for platform:ai_isa_seller_data,
--      2026.11.0 is retired (any review recorded on it is kept as history) and 2026.11.1 is published unreviewed, so a
--      review recorded on 2026.11.0 never clears the module-45 portal, and the counsel-review command refuses the old
--      pin (packages/db/src/counselReview.ts). DEPLOY's D11 command names six keys. VERIFY WITH COUNSEL.

-- =============================================================================
-- 1. platform:portal@2026.11.1 (unreviewed; D11's review was of 2026.11.0)
-- =============================================================================
UPDATE jurisdiction_packs SET status = 'retired' WHERE key = 'platform:portal' AND status = 'published';
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:portal', '2026.11.1', 'published', '{}', NULL,
   'Client portal (C10), module 45 as built: gates client sign-in (portal.request_login, consume_login, resolve_session). '
   'Ships unreviewed: a review recorded on 2026.11.0 (0018''s placeholder, reviewed before module 45 was built) does not '
   'clear it. Counsel items before it is cleared: VERIFY 1-6 (ARCHITECTURE §21.52), Q-PORTAL-16 (a client''s message '
   'quoting their sign-in link), and module 46''s client page, which is not shipped yet. Engineering placeholder. '
   'VERIFY WITH COUNSEL.');
