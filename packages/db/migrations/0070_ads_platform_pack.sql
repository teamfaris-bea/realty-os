-- =============================================================================
-- Ads platform pack and gates (PHASE2_3_PLAN module 52; owner decisions D2, D7, D-ADS; DATA_MODEL R-ADS-7..9).
-- Placeholder number: the orchestrator renumbers it at merge. It edits no earlier migration.
--
-- The p3-cores lane found that nothing kept Google Ads dark (packages/core/src/ads/index.ts): 0018 seeds no
-- `platform:ads` pack and its deferred definer app.ad_allocation_cap_check() checks no clearance. This migration
-- adds ONE pack row and TWO SECURITY INVOKER trigger functions. It adds no table, column, RLS policy, grant or
-- SECURITY DEFINER.
--
--   platform:ads                          ships published and unreviewed (D7). Cleared only with counsel review AND
--                                         rules.vendor_ready_at (app.platform_cleared('platform:ads', true)). Owner
--                                         decision D11 does not cover it: no migration, seed or code default sets
--                                         either field (the counsel-review command records the review per deployment;
--                                         the vendor check is a separate platform step).
--   app.ad_allocation_events_ads_gate()   BEFORE INSERT of a PLANNED ledger row: the pack is cleared
--                                         (ADS_NOT_CLEARED), the campaign is one the caller sees on an `ads_google`
--                                         connection (ADS_GOOGLE_ONLY, D2) and that connection is connected or degraded
--                                         (ADS_CONNECTION_NOT_LIVE). Applied, failed and paused rows are never gated:
--                                         they record outcomes of earlier plans or only lower spend.
--   app.assistant_actions_ads_gate()      an `ad_reallocation` enters `approved` only while the pack is cleared
--                                         (ADS_NOT_CLEARED); once approved or executed its payload and edited_payload
--                                         never change and it keeps its kind (AD_APPROVAL_FROZEN). Executed,
--                                         status-only and trigger_ref updates are never gated, so the system can
--                                         always finish a run it started.
--
-- Both functions run as the CALLER (SECURITY INVOKER): they read jurisdiction_packs (readable by app_user),
-- ad_campaigns and integration_connections through the caller's RLS. A row the caller cannot see is refused
-- (fail closed). There is no superuser bypass. search_path is pinned and every table is `public.`-qualified (R-TEN-5).
-- Trigger order: PostgreSQL fires same-event BEFORE triggers in name order, so `assistant_actions_ads_gate_*`
-- fires before `assistant_actions_decision_guard` (0018) and an approval while dark is refused as ADS_NOT_CLEARED.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The pack (R-INT-6, R-ADS-7). Ships unreviewed, like 0018's seven packs and 0025's platform:gmail.
-- -----------------------------------------------------------------------------
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:ads', '2026.11.0', 'published', '{}', NULL,
   'Google Ads budget changes and pauses (C3 housing ad rules, N14). vendor_ready_at is set once a real Google Ads '
   'adapter passes its check against the team''s account at the deployment''s API access level (VERIFY). Not part of '
   'owner decision D11. Engineering placeholder. VERIFY WITH COUNSEL.');

-- -----------------------------------------------------------------------------
-- 2. Planned ledger rows wait for the pack, Google Ads and a live connection (R-ADS-7, R-ADS-8; D2, D7).
--    Raised before 0018's deferred cap check, so a non-Google or unknown campaign never reaches AD_CAMPAIGN_UNKNOWN.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.ad_allocation_events_ads_gate() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE conn_kind text; conn_status text;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT app.platform_cleared('platform:ads', true) THEN
    RAISE EXCEPTION 'ADS_NOT_CLEARED: applying a Google Ads change waits for counsel review and the vendor check (platform:ads)'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT ic.kind, ic.status INTO conn_kind, conn_status
    FROM public.ad_campaigns c
    JOIN public.integration_connections ic ON ic.tenant_id = c.tenant_id AND ic.id = c.connection_id
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.campaign_id;
  IF conn_kind IS DISTINCT FROM 'ads_google' THEN
    RAISE EXCEPTION 'ADS_GOOGLE_ONLY: budget changes are planned only for a Google Ads campaign the caller can see'
      USING ERRCODE = 'check_violation';
  END IF;
  IF conn_status IS NULL OR conn_status NOT IN ('connected','degraded') THEN
    RAISE EXCEPTION 'ADS_CONNECTION_NOT_LIVE: the Google Ads account is not connected' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ad_allocation_events_ads_gate BEFORE INSERT ON ad_allocation_events
  FOR EACH ROW WHEN (NEW.event_kind = 'planned') EXECUTE FUNCTION app.ad_allocation_events_ads_gate();

-- -----------------------------------------------------------------------------
-- 3. An ad_reallocation is approved only while the pack is cleared, and an approval is never edited (R-ADS-7, R-ADS-9).
--    Without the freeze, a post-approval edited_payload could name a campaign the approver never saw, and a later
--    planned row for it would pass 0018's check (it reads COALESCE(edited_payload, payload)->'changes').
--    Two triggers share the function: INSERT (WHEN NEW.kind) and UPDATE (WHEN either kind), so a row cannot become
--    or stop being an ad_reallocation to slip past either rule.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.assistant_actions_ads_gate() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' AND OLD.status IN ('approved','executed')
     AND (NEW.kind IS DISTINCT FROM OLD.kind OR NEW.payload IS DISTINCT FROM OLD.payload
          OR NEW.edited_payload IS DISTINCT FROM OLD.edited_payload) THEN
    RAISE EXCEPTION 'AD_APPROVAL_FROZEN: an approved budget shift is not edited; propose a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'ad_reallocation' AND NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved' OR OLD.kind IS DISTINCT FROM 'ad_reallocation')
     AND NOT app.platform_cleared('platform:ads', true) THEN
    RAISE EXCEPTION 'ADS_NOT_CLEARED: approving a Google Ads change waits for counsel review and the vendor check (platform:ads)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistant_actions_ads_gate_ins BEFORE INSERT ON assistant_actions
  FOR EACH ROW WHEN (NEW.kind = 'ad_reallocation') EXECUTE FUNCTION app.assistant_actions_ads_gate();
CREATE TRIGGER assistant_actions_ads_gate_upd BEFORE UPDATE ON assistant_actions
  FOR EACH ROW WHEN (NEW.kind = 'ad_reallocation' OR OLD.kind = 'ad_reallocation') EXECUTE FUNCTION app.assistant_actions_ads_gate();
