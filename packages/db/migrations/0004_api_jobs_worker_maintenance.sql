-- 0004 (BUILD_PLAN module 9, api/jobs-worker): worker maintenance read-outs.
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): three new SECURITY DEFINER reads, all owned by app_definer,
-- search_path pinned, callable by app_user ONLY WITHOUT tenant and user context (the worker's
-- cross-tenant entry points, like app.claim_jobs / app.due_work). Inside a request or job transaction
-- (app.tenant_id() or app.user_id() set) they return no rows. None returns names, addresses, bodies or
-- payloads. Residual risk is the same as for app.claim_jobs (ARCHITECTURE §16, open question Q3): a
-- compromised API process could clear its GUCs and call them, and would learn tenant ids, global audit
-- seq counts and dead-job kinds, nothing else.
--
-- 1. app.worker_tenant_ids(): tenant ids + status. Why: per-tenant periodic jobs (the nightly ownership
--    drift job R-OWN-4, the consent drift verifier R-CONSENT-6, blob deletes) are enqueued in each
--    tenant's own system transaction (R-TEN-6), so the worker must know which tenants exist. The
--    tenants SELECT policy shows a session only its own tenant.
-- 2. app.audit_seq_stats(): min/max/count of the GLOBAL audit_log.seq identity. Why: R-AUDIT-8's gap
--    check is global by nature (one identity across tenants); per-tenant reads would see "gaps" that are
--    other tenants' rows. Returns three numbers.
-- 3. app.dead_jobs(since, limit): dead jobs finished since an instant (id, tenant, queue, kind,
--    attempts, scrubbed last_error ≤ 500, finished_at; never the payload). Why: "a dead job raises a
--    platform alert" (ARCHITECTURE §6) must also cover jobs that die in app.reap_stuck_jobs (lease
--    expired with attempts exhausted), which returns only a count. app_user cannot read jobs.

CREATE FUNCTION app.worker_tenant_ids()
RETURNS TABLE (tenant_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id, t.status FROM public.tenants t
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
   ORDER BY t.id
$$;
ALTER FUNCTION app.worker_tenant_ids() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.worker_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_tenant_ids() TO app_user;

CREATE FUNCTION app.audit_seq_stats()
RETURNS TABLE (min_seq bigint, max_seq bigint, row_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT min(a.seq), max(a.seq), count(*) FROM public.audit_log a
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
$$;
ALTER FUNCTION app.audit_seq_stats() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.audit_seq_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_seq_stats() TO app_user;

CREATE FUNCTION app.dead_jobs(p_since timestamptz, p_limit integer)
RETURNS TABLE (id bigint, tenant_id uuid, queue text, kind text, attempts integer, last_error text, finished_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.id, j.tenant_id, j.queue, j.kind, j.attempts, j.last_error, j.finished_at FROM public.jobs j
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
     AND j.status = 'dead' AND j.finished_at > p_since
   ORDER BY j.finished_at, j.id
   LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
ALTER FUNCTION app.dead_jobs(timestamptz, integer) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.dead_jobs(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dead_jobs(timestamptz, integer) TO app_user;

-- the dead-job scan reads by finish time; dead jobs are rare, so the partial index stays tiny
CREATE INDEX jobs_dead_idx ON jobs (finished_at) WHERE status = 'dead';
