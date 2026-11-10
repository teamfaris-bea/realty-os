-- 0005 (BUILD_PLAN module 9, api/jobs-worker): lease-checked job completion, attempt-neutral
-- reschedule, lease heartbeat, and a keyset-paged dead-job read. Found by the module's adversarial
-- verification (apps/api/src/worker/adversarial.test.ts):
--
--   * app.finish_job (0001) returns void and silently updates nothing when the caller no longer holds
--     the lease (reaped, maybe re-claimed by another worker). A job handler that finishes inside its
--     own transaction then COMMITS its writes next to the re-run. app.finish_job_leased returns
--     whether the lease was still held, so the worker rolls the handler's transaction back otherwise.
--   * A handler's `{ retryAt }` (an early timer wake, ARCHITECTURE §5 "an early wake reschedules") went
--     through the failure path of app.finish_job: it consumed an attempt, and at max_attempts the job
--     went `dead` and raised JOB_DEAD. app.reschedule_job puts the job back to pending at run_at and
--     refunds the claim's attempt.
--   * A job running longer than its lease was reaped and handed to a second worker while the first
--     one was still alive. app.extend_job_lease is the worker's heartbeat.
--   * app.dead_jobs (0004) pages by finished_at only: more than one page of jobs dying in ONE reap
--     (one finished_at) left all but the first page un-alerted forever. app.dead_jobs_after pages by
--     (finished_at, id) and replaces it (dropped here: one definer fewer).
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): three new SECURITY DEFINER functions (owner app_definer,
-- search_path pinned, EXECUTE to app_user only), one replaced. Authorization is the same as for
-- app.finish_job / app.claim_jobs: the caller must name the lease holder (jobs.locked_by, a per-process
-- random name). In addition:
--   - finish_job_leased / reschedule_job inside a tenant transaction only touch THAT tenant's job
--     (defence in depth against a handler finishing another tenant's job; R-TEN-6);
--   - extend_job_lease and dead_jobs_after answer only WITHOUT tenant and user context, like the 0004
--     worker read-outs;
--   - dead_jobs_after returns no payloads (ids, codes, scrubbed last_error ≤ 500 only).
-- Residual risk: as for app.claim_jobs (ARCHITECTURE §16, open question Q3).

CREATE FUNCTION app.finish_job_leased(p_id bigint, p_worker text, p_ok boolean, p_error text, p_retry_at timestamptz)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (
    UPDATE public.jobs j SET
      status = CASE WHEN p_ok THEN 'succeeded'
                    WHEN j.attempts >= j.max_attempts OR p_retry_at IS NULL THEN 'dead'
                    ELSE 'pending' END,
      run_at = CASE WHEN NOT p_ok AND p_retry_at IS NOT NULL THEN p_retry_at ELSE j.run_at END,
      locked_by = NULL, locked_until = NULL,
      last_error = left(p_error, 500),
      finished_at = CASE WHEN p_ok OR j.attempts >= j.max_attempts OR p_retry_at IS NULL THEN now() END
     WHERE j.id = p_id AND j.locked_by = p_worker AND j.status = 'running'
       AND (app.tenant_id() IS NULL OR j.tenant_id = app.tenant_id())
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;
ALTER FUNCTION app.finish_job_leased(bigint, text, boolean, text, timestamptz) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.finish_job_leased(bigint, text, boolean, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finish_job_leased(bigint, text, boolean, text, timestamptz) TO app_user;

-- An early wake: back to pending at p_run_at (never earlier than 1 s from now, so a handler bug cannot
-- hot-loop), the claim's attempt refunded, the lease released. Not a failure: no dead, no alert.
CREATE FUNCTION app.reschedule_job(p_id bigint, p_worker text, p_run_at timestamptz)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (
    UPDATE public.jobs j SET
      status = 'pending',
      run_at = GREATEST(p_run_at, now() + interval '1 second'),
      attempts = GREATEST(j.attempts - 1, 0),
      locked_by = NULL, locked_until = NULL,
      last_error = 'RESCHEDULED'
     WHERE j.id = p_id AND j.locked_by = p_worker AND j.status = 'running' AND p_run_at IS NOT NULL
       AND (app.tenant_id() IS NULL OR j.tenant_id = app.tenant_id())
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;
ALTER FUNCTION app.reschedule_job(bigint, text, timestamptz) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.reschedule_job(bigint, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reschedule_job(bigint, text, timestamptz) TO app_user;

-- The heartbeat of a running job: the lease holder pushes locked_until out (≤ 15 min, like claim_jobs).
-- Returns false once the lease is gone (reaped / finished), which tells the worker to stop and roll back.
CREATE FUNCTION app.extend_job_lease(p_id bigint, p_worker text, p_lease interval)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (
    UPDATE public.jobs j SET locked_until = now() + LEAST(GREATEST(p_lease, interval '1 second'), interval '15 minutes')
     WHERE j.id = p_id AND j.locked_by = p_worker AND j.status = 'running'
       AND app.tenant_id() IS NULL AND app.user_id() IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;
ALTER FUNCTION app.extend_job_lease(bigint, text, interval) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.extend_job_lease(bigint, text, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.extend_job_lease(bigint, text, interval) TO app_user;

-- Dead jobs after the keyset cursor (finished_at, id): ids, codes and the scrubbed error, never payloads.
CREATE FUNCTION app.dead_jobs_after(p_since timestamptz, p_after_id bigint, p_limit integer)
RETURNS TABLE (id bigint, tenant_id uuid, queue text, kind text, attempts integer, last_error text, finished_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.id, j.tenant_id, j.queue, j.kind, j.attempts, j.last_error, j.finished_at FROM public.jobs j
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
     AND j.status = 'dead' AND j.finished_at >= p_since
     AND (j.finished_at, j.id) > (p_since, COALESCE(p_after_id, 0))
   ORDER BY j.finished_at, j.id
   LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
ALTER FUNCTION app.dead_jobs_after(timestamptz, bigint, integer) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.dead_jobs_after(timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dead_jobs_after(timestamptz, bigint, integer) TO app_user;

DROP FUNCTION app.dead_jobs(timestamptz, integer);
