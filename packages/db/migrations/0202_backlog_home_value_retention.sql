-- Backlog gaps: retention of home values (R-DATA-6; batch 8 review db-public/F5).
-- The number is a placeholder: the orchestrator renumbers at merge, and nothing in code or tests names this file.
-- No earlier migration is edited.
--
-- avm.refresh writes one home_valuations row per house and UTC month, app_user has no DELETE on the table (0001) and
-- its writes are system-only (0059 §2), so until now erasure was the only path that removed a valuation. This
-- definer, owned by app_retention (which holds DELETE and is BYPASSRLS, 0001), deletes for the CALLER's tenant only
-- the valuations recorded more than 13 months ago (valued_at, the database clock of the answer; never the vendor's
-- as_of), except one a pending client note still cites:
--   - a trigger run (playbook_step_runs) of the tenant that is still 'scheduled', or
--   - a run 'converted_to_draft' whose draft (assistant_actions via playbook_step_runs.assistant_action_id) is still
--     'proposed' or 'approved' (an agent may yet send it).
-- A run cites its valuation in trigger_ref->'ref'->>'valuationId' (core FiringRef kind 'home_value'; api nurture
-- StoredTriggerRef). Once the run is sent, skipped, canceled or failed, or its draft is executed, rejected, expired,
-- superseded or invalidated, the row goes with the next pass after it is 13 months old. A kept row goes on the first
-- pass after its last citing run or draft settles.
-- VERIFY WITH COUNSEL (C13 AVM vendor licence term, C6 retention ranges): 13 months is DATA_MODEL R-DATA-6's AVM
-- default ("13 months or the licence term"); a shorter licence term would shorten it.
-- It runs on the database clock (now()) and takes no instant from the caller (the 0016 lesson, as 0057's
-- app.purge_prediction_data), only with a tenant context and the system actor (support and users are refused), and
-- filters every statement by app.tenant_id() because its owner bypasses RLS. Called first by avm.refresh
-- (apps/api/src/nurture/avm.ts) in its own system transaction, whether or not an AVM vendor is configured.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21 "Security notes: app.purge_home_valuations"):
--   * one new SECURITY DEFINER function, app.purge_home_valuations(), owner app_retention, search_path pinned to
--     pg_catalog, public, EXECUTE revoked from PUBLIC and granted to app_user only; no arguments.
--   * no grant to app_user on any table; app_user still has no DELETE on home_valuations (self-check).
--   * one index, home_valuations (tenant_id, valued_at), for the purge's range scan.

CREATE INDEX home_valuations_tenant_valued_at ON home_valuations (tenant_id, valued_at);

CREATE FUNCTION app.purge_home_valuations(OUT valuations_deleted integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t uuid := app.tenant_id();
BEGIN
  IF t IS NULL OR app.actor_kind() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'HOME_VALUE_PURGE_SYSTEM_ONLY: only the system actor of a tenant purges its home values' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 13 months: VERIFY WITH COUNSEL (C13, C6)
  DELETE FROM public.home_valuations v
   WHERE v.tenant_id = t
     AND v.valued_at < now() - interval '13 months'
     AND NOT EXISTS (
           SELECT 1 FROM public.playbook_step_runs r
            WHERE r.tenant_id = t
              AND r.trigger_ref->'ref'->>'valuationId' = v.id::text
              AND (r.status = 'scheduled'
                   OR (r.status = 'converted_to_draft'
                       AND EXISTS (SELECT 1 FROM public.assistant_actions a
                                    WHERE a.tenant_id = t AND a.id = r.assistant_action_id
                                      AND a.status IN ('proposed','approved')))));
  GET DIAGNOSTICS valuations_deleted = ROW_COUNT;
END $$;
ALTER FUNCTION app.purge_home_valuations() OWNER TO app_retention;
REVOKE ALL ON FUNCTION app.purge_home_valuations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_home_valuations() TO app_user;

-- Self-check: a definer owned by app_retention with a pinned search_path, not executable by PUBLIC, executable by
-- app_user, taking no argument; app_user still cannot DELETE home_valuations (the purge and erasure are the only
-- delete paths); the index exists.
DO $$
DECLARE bad text := '';
BEGIN
  IF NOT (SELECT p.prosecdef AND r.rolname = 'app_retention' AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
            FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'app.purge_home_valuations()'::regprocedure) THEN
    bad := bad || ' purge_shape';
  END IF;
  IF has_function_privilege('public', 'app.purge_home_valuations()', 'EXECUTE') THEN bad := bad || ' public_execute'; END IF;
  IF NOT has_function_privilege('app_user', 'app.purge_home_valuations()', 'EXECUTE') THEN bad := bad || ' app_user_execute'; END IF;
  IF has_table_privilege('app_user', 'public.home_valuations', 'DELETE') THEN bad := bad || ' app_user_delete'; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.proname = 'purge_home_valuations' AND p.pronamespace = 'app'::regnamespace) <> 1
     OR (SELECT p.pronargs FROM pg_proc p WHERE p.oid = 'app.purge_home_valuations()'::regprocedure) <> 0 THEN
    bad := bad || ' takes_an_instant';
  END IF;
  IF to_regclass('public.home_valuations_tenant_valued_at') IS NULL THEN bad := bad || ' index'; END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'home_value_retention self-check failed:%', bad; END IF;
END $$;
