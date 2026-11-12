-- Module 50 api/predict: retention of property records and predictions (R-DATA-6, R-DATA-7; PHASE2_3_PLAN §5.4
-- "49. core/predict and 50. api/predict").
--
-- app_user holds SELECT, INSERT and UPDATE on property_records and contact_predictions but no DELETE (0018 §20), and
-- app.retention_sweep is left alone. This one definer, owned by app_retention (which holds DELETE and is BYPASSRLS),
-- deletes for the CALLER's tenant only:
--   - property_records whose retention_until has passed (the licence term, at most 12 months; VERIFY WITH COUNSEL);
--   - contact_predictions not evaluated for PREDICTION_KEEP_DAYS days ("latest + 90 d": the nightly pass re-stamps
--     computed_on on every row it evaluates, so a row stops being re-stamped only when its contact leaves the scored
--     population or its model stops scoring). The day is the tenant's local date (tenant_settings.default_timezone),
--     the same calendar computed_on is written in.
-- It runs on the database clock (now()) and takes no instant from the caller (the 0016 lesson; unlike
-- app.purge_webchat_sessions it has no p_now parameter), only with a tenant context and the system actor, and filters
-- every statement by app.tenant_id() because its owner bypasses RLS. Erasure already cascades (0018 foreign keys).
-- Security note: docs/ARCHITECTURE.md §21 "Security notes: module 50 api/predict".
-- No table is added and no model is seeded: prediction_models stays empty (rls_smoke_p23; models ship withdrawn).

CREATE FUNCTION app.purge_prediction_data(OUT records_deleted integer, OUT predictions_deleted integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t uuid := app.tenant_id();
  today date;
BEGIN
  IF t IS NULL OR app.actor_kind() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'PREDICTION_PURGE_SYSTEM_ONLY: only the system actor of a tenant purges its prediction data' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT (now() AT TIME ZONE s.default_timezone)::date INTO today FROM public.tenant_settings s WHERE s.tenant_id = t;
  IF today IS NULL THEN today := (now() AT TIME ZONE 'UTC')::date; END IF;
  DELETE FROM public.property_records WHERE tenant_id = t AND retention_until <= now();
  GET DIAGNOSTICS records_deleted = ROW_COUNT;
  DELETE FROM public.contact_predictions WHERE tenant_id = t AND computed_on < today - 90;
  GET DIAGNOSTICS predictions_deleted = ROW_COUNT;
END $$;
ALTER FUNCTION app.purge_prediction_data() OWNER TO app_retention;
REVOKE ALL ON FUNCTION app.purge_prediction_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_prediction_data() TO app_user;

-- Self-check: a definer owned by app_retention with a pinned search_path, not executable by PUBLIC, executable by
-- app_user; app_user still cannot DELETE either table (the purge is the only delete path besides erasure).
DO $$
DECLARE bad text := '';
BEGIN
  IF NOT (SELECT p.prosecdef AND r.rolname = 'app_retention' AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
            FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'app.purge_prediction_data()'::regprocedure) THEN
    bad := bad || ' purge_shape';
  END IF;
  IF has_function_privilege('public', 'app.purge_prediction_data()', 'EXECUTE') THEN bad := bad || ' public_execute'; END IF;
  IF NOT has_function_privilege('app_user', 'app.purge_prediction_data()', 'EXECUTE') THEN bad := bad || ' app_user_execute'; END IF;
  IF has_table_privilege('app_user', 'public.property_records', 'DELETE')
     OR has_table_privilege('app_user', 'public.contact_predictions', 'DELETE') THEN
    bad := bad || ' app_user_delete';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = 'app.purge_prediction_data()'::regprocedure AND p.pronargs = 0) <> 1 THEN
    bad := bad || ' takes_an_instant';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'predict_retention self-check failed:%', bad; END IF;
END $$;
