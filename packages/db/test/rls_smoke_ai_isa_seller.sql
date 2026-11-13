-- =============================================================================
-- Smoke proof of the AI ISA seller migration (lane ISA-3; its number is assigned at merge, and nothing here names the
-- file): the seller-watch table's RLS shape, its invoker guards (no SECURITY DEFINER), the email-only trigger on the
-- shared facts and the platform:ai_isa_seller_data@2026.11.1 pack. docs/AI_ISA.md §8.2-§8.4.
--   R-ISA-18  the seller-data pack ships published and unreviewed at 2026.11.1, with its scope and the four client lines;
--             2026.11.0 is retired, so a review recorded on it no longer clears anything (E534);
--   R-ISA-21  FORCE RLS, the restrictive tenant and support policies and the support statement trigger; no DELETE grant;
--   R-TEN-1   no new SECURITY DEFINER function.
-- ONE transaction, rolled back; schema reads run as the owner, the pack read as app_user. Run by
-- packages/db/test/rls_smoke_ai_isa_seller.test.ts. The per-role behaviour (owner, collaborator, system, support,
-- another tenant) is proved in that file through withTenantTx.
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
BEGIN;

CREATE FUNCTION pg_temp.fail(p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FAIL  %', p_msg;
END $$;
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN PERFORM pg_temp.fail(p_label); RETURN; END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;

SELECT pg_temp.ok(
  (SELECT relforcerowsecurity AND relrowsecurity FROM pg_class WHERE oid = 'public.ai_isa_seller_watch'::regclass)
  AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.ai_isa_seller_watch'::regclass AND polname = 'tenant_isolation' AND NOT polpermissive)
  AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.ai_isa_seller_watch'::regclass AND polname LIKE 'support_read_only_%' AND NOT polpermissive) = 3
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ai_isa_seller_watch'::regclass AND tgname = 'support_read_only'),
  'R-ISA-21 R-TEN-1: ai_isa_seller_watch has FORCE RLS, the restrictive tenant policy, the three support policies and the support statement trigger');

SELECT pg_temp.ok(
  NOT has_table_privilege('app_user', 'public.ai_isa_seller_watch', 'DELETE')
  AND has_table_privilege('app_user', 'public.ai_isa_seller_watch', 'UPDATE')
  AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.ai_isa_seller_watch'::regclass AND polcmd = 'd' AND polpermissive),
  'R-ISA-21: app_user has no DELETE on ai_isa_seller_watch (rows go with their assignment)');

SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.prosecdef
                 AND p.proname IN ('ai_isa_seller_watch_guard','ai_isa_subject_address_cleared','ai_isa_seller_fact_email_only'))
  AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
          AND p.proname IN ('ai_isa_seller_watch_guard','ai_isa_subject_address_cleared','ai_isa_seller_fact_email_only')) = 3,
  'R-TEN-1: the three seller functions are invokers (no SECURITY DEFINER)');

SELECT pg_temp.ok(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.contact_addresses'::regclass AND tgname = 'ai_isa_subject_address_cleared')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ai_isa_shared_facts'::regclass AND tgname = 'ai_isa_seller_fact_email_only'),
  'R-ISA-18 E538: the address-clearing trigger is on contact_addresses and the email-only trigger on ai_isa_shared_facts');

SET LOCAL ROLE app_user;
SELECT pg_temp.ok(
  (SELECT count(*) FROM jurisdiction_packs WHERE key = 'platform:ai_isa_seller_data' AND status = 'published') = 1
  AND EXISTS (SELECT 1 FROM jurisdiction_packs WHERE key = 'platform:ai_isa_seller_data' AND version = '2026.11.1' AND status = 'published'
                 AND reviewed_by_counsel_at IS NULL
                 AND rules ->> 'scope' = 'automated sold comps to seller leads by email, with this wording'
                 AND rules -> 'client_lines' = jsonb_build_array(
                       'These are sales records, not an appraisal or a price for your home.',
                       'Condition and updates aren''t in the MLS record.',
                       'Prices are as recorded in the MLS and may include seller concessions.',
                       'Only sales the MLS allows us to show are included.')
                 AND notes LIKE '%VERIFY WITH COUNSEL / MLS.')
  AND EXISTS (SELECT 1 FROM jurisdiction_packs WHERE key = 'platform:ai_isa_seller_data' AND version = '2026.11.0' AND status = 'retired')
  AND NOT app.platform_cleared('platform:ai_isa_seller_data') AND NOT app.platform_cleared('platform:cma'),
  'R-ISA-18 E534: platform:ai_isa_seller_data ships published and unreviewed at 2026.11.1 with its scope and client lines; 2026.11.0 is retired; neither seller pack is cleared');
RESET ROLE;

SELECT pg_temp.ok(true, 'ALL AI ISA SELLER SMOKE CHECKS PASSED');
ROLLBACK;
