-- A follow-up job queued before its payload carried `at` is identified by jobs.run_at (R-ISA-4).
-- app_user inserts jobs and cannot read them, so the turn asks this function for that one instant.
-- Numbered 0150: 0123 is on main, and 0160 is the AI-budget index on the branch that lands after this one.
-- 0124-0149 and 0151-0159 stay open.

CREATE FUNCTION app.job_run_at(p_id bigint) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.run_at FROM public.jobs j
   WHERE j.id = p_id AND j.tenant_id = app.tenant_id()
$$;

ALTER FUNCTION app.job_run_at(bigint) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.job_run_at(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.job_run_at(bigint) TO app_user;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'job_run_at' AND p.prosecdef
      AND pg_get_function_identity_arguments(p.oid) = 'p_id bigint'
  ) THEN
    RAISE EXCEPTION '0150: app.job_run_at(bigint) must be SECURITY DEFINER';
  END IF;
  IF (SELECT proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'job_run_at') IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] THEN
    RAISE EXCEPTION '0150: app.job_run_at must pin search_path';
  END IF;
  IF has_function_privilege('public', 'app.job_run_at(bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION '0150: PUBLIC must not execute app.job_run_at';
  END IF;
  IF NOT has_function_privilege('app_user', 'app.job_run_at(bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION '0150: app_user must execute app.job_run_at';
  END IF;
END $$;
