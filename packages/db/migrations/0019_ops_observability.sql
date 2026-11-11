-- Lane ops-observability: read-only operational views for metrics and the System admin page, and the
-- two job commands an Owner/Admin may run from it (retry, cancel). No new tables.
--
-- Two kinds of SECURITY DEFINER function (each is a security-review item, ARCHITECTURE §21.1):
--   platform-wide (metrics): callable only with NO tenant and NO user context (the same guard as
--     app.dead_jobs_after), return aggregates only: counts, ages and bounded label values (queue, job
--     kind, channel, status, scrubbed reason codes). No ids, no tenant ids, no payloads, no addresses.
--       app.ops_queue_stats()                 jobs by queue/kind: ready, scheduled, running, retrying, dead, lag
--       app.ops_message_stats()               outbound messages stuck in dispatching / dispatch_unknown, overdue
--       app.ops_dispatch_results(p_since)     sent / failed (provider code) / blocked (gate reason) by channel
--       app.ops_timer_lateness(p_since)       offer expiry, first-touch SLA and auto-release lateness (ledger)
--       app.ops_tenant_count()                active tenants (the exporter buckets it)
--       app.ops_first_response(p_since)       new-lead first response: inquiries answered within / over 60 s
--   tenant-scoped (System page): filter tenant_id = app.tenant_id() and require a live Owner/Admin
--     user actor (app.my_role()), so support actors and other roles get nothing.
--       app.ops_tenant_jobs(p_view, p_limit)  dead (last 7 days) or retrying jobs: ids, kinds, scrubbed codes
--       app.ops_retry_job(p_id)               dead -> pending (attempts reset) / retrying -> due now
--       app.ops_cancel_job(p_id)              pending -> cancelled
--   Jobs hold ids and fences only and every handler re-checks its fence under lock, so a retried job
--   never re-sends a message (dispatch only claims scheduled/queued messages) and never moves a lead
--   whose state moved on; a cancelled timer whose deadline is still due is re-issued by the sweeper from
--   the stored deadline (R-OWN-15). Neither command can reach another tenant's jobs.
--
-- Timer lateness comes from the append-only ownership ledger, never from job rows (which are reaped):
--   offer_expired          due = deadline_at of the `offered` event with the same offer_id
--   first_touch_breached   due = deadline_at of the latest earlier `owned` event that carries one (the
--                          period start; in-period events carry none, a period without SLA never breaches)
--   auto_released          due = payload.releaseDueAt (epoch ms) of the latest earlier `owned` event with one

-- ---- indexes: every scan below is a small partial-index range -----------------------------------
CREATE INDEX jobs_tenant_trouble_idx ON jobs (tenant_id, status, finished_at DESC)
  WHERE status = 'dead' OR (status = 'pending' AND attempts > 0);
CREATE INDEX loe_timer_fired_idx ON lead_ownership_events (occurred_at)
  WHERE type IN ('offer_expired','first_touch_breached','auto_released');
CREATE INDEX gate_decisions_send_deny_idx ON gate_decisions (evaluated_at)
  WHERE phase = 'send' AND outcome = 'deny';
CREATE INDEX messages_outbound_dispatched_idx ON messages (dispatched_at)
  WHERE direction = 'outbound' AND dispatched_at IS NOT NULL;
CREATE INDEX lead_inquiries_received_idx ON lead_inquiries (received_at);

-- ---- helpers -------------------------------------------------------------------------------------
-- A label value safe for a metrics backend: bounded charset and length, else OTHER.
CREATE FUNCTION app.ops_label(p text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p IS NULL OR p = '' THEN 'none'
              WHEN p ~ '^[A-Za-z0-9_.:-]{1,40}$' THEN p
              ELSE 'OTHER' END
$$;
GRANT EXECUTE ON FUNCTION app.ops_label(text) TO app_user;

-- The ledger rows of fired ownership timers since p_since, with the instant each was due. Not a definer:
-- called by the definer below (platform view) and directly by app_user under RLS (tenant view).
CREATE FUNCTION app.ops_fired_timers(p_since timestamptz)
RETURNS TABLE (tenant_id uuid, contact_id uuid, type text, due_at timestamptz, fired_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT e.tenant_id, e.contact_id, e.type,
         CASE e.type
           WHEN 'offer_expired' THEN
             (SELECT o.deadline_at FROM public.lead_ownership_events o
               WHERE o.tenant_id = e.tenant_id AND o.contact_id = e.contact_id AND o.seq < e.seq
                 AND o.type = 'offered' AND o.offer_id = e.offer_id
               ORDER BY o.seq DESC LIMIT 1)
           WHEN 'first_touch_breached' THEN
             (SELECT p.deadline_at FROM public.lead_ownership_events p
               WHERE p.tenant_id = e.tenant_id AND p.contact_id = e.contact_id AND p.seq < e.seq
                 AND p.to_state = 'owned' AND p.deadline_at IS NOT NULL
               ORDER BY p.seq DESC LIMIT 1)
           ELSE
             (SELECT to_timestamp((p.payload->>'releaseDueAt')::numeric / 1000.0) FROM public.lead_ownership_events p
               WHERE p.tenant_id = e.tenant_id AND p.contact_id = e.contact_id AND p.seq < e.seq
                 AND p.to_state = 'owned' AND jsonb_typeof(p.payload->'releaseDueAt') = 'number'
               ORDER BY p.seq DESC LIMIT 1)
         END,
         e.occurred_at
    FROM public.lead_ownership_events e
   WHERE e.type IN ('offer_expired','first_touch_breached','auto_released')
     AND e.occurred_at >= p_since
$$;
GRANT EXECUTE ON FUNCTION app.ops_fired_timers(timestamptz) TO app_user;

-- ---- platform-wide aggregates (metrics exporter; no tenant, no user context) -----------------------
CREATE FUNCTION app.ops_queue_stats()
RETURNS TABLE (queue text, kind text, ready bigint, scheduled bigint, running bigint, retrying bigint,
               dead_24h bigint, oldest_ready_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH live AS (
    SELECT j.queue, j.kind,
           count(*) FILTER (WHERE j.status = 'pending' AND j.run_at <= now()) AS ready,
           count(*) FILTER (WHERE j.status = 'pending' AND j.run_at > now()) AS scheduled,
           count(*) FILTER (WHERE j.status = 'running') AS running,
           count(*) FILTER (WHERE j.status = 'pending' AND j.attempts > 0) AS retrying,
           GREATEST(0, EXTRACT(EPOCH FROM now() - min(j.run_at) FILTER (WHERE j.status = 'pending' AND j.run_at <= now())))::double precision AS oldest
      FROM public.jobs j WHERE j.status IN ('pending','running')
     GROUP BY j.queue, j.kind),
  dead AS (
    SELECT j.queue, j.kind, count(*) AS n FROM public.jobs j
     WHERE j.status = 'dead' AND j.finished_at >= now() - interval '24 hours'
     GROUP BY j.queue, j.kind)
  SELECT COALESCE(l.queue, d.queue), app.ops_label(COALESCE(l.kind, d.kind)),
         COALESCE(l.ready, 0), COALESCE(l.scheduled, 0), COALESCE(l.running, 0), COALESCE(l.retrying, 0),
         COALESCE(d.n, 0), COALESCE(l.oldest, 0)
    FROM live l FULL JOIN dead d ON d.queue = l.queue AND d.kind = l.kind
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
$$;

CREATE FUNCTION app.ops_message_stats()
RETURNS TABLE (channel text, status text, n bigint, oldest_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.channel, m.status, count(*),
         GREATEST(0, EXTRACT(EPOCH FROM now() - min(COALESCE(m.dispatched_at, m.scheduled_for))))::double precision
    FROM public.messages m
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
     AND (m.status IN ('dispatching','dispatch_unknown')
          OR (m.status IN ('scheduled','queued') AND m.scheduled_for <= now() - interval '1 minute'))
   GROUP BY m.channel, m.status
$$;

CREATE FUNCTION app.ops_dispatch_results(p_since timestamptz)
RETURNS TABLE (channel text, result text, reason text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT x.channel, x.result, x.reason, count(*) FROM (
    SELECT m.channel,
           CASE WHEN m.status IN ('sent','delivered') THEN 'sent'
                WHEN m.status IN ('failed','undelivered','bounced') THEN 'failed'
                WHEN m.status = 'blocked' THEN 'blocked'
                ELSE 'in_flight' END AS result,
           CASE WHEN m.status IN ('failed','undelivered','bounced') THEN app.ops_label(COALESCE(m.provider_error_code, m.status_reason))
                WHEN m.status = 'blocked' THEN app.ops_label(m.status_reason)
                ELSE 'none' END AS reason
      FROM public.messages m
     WHERE m.direction = 'outbound' AND m.dispatched_at IS NOT NULL AND m.dispatched_at >= p_since
    UNION ALL
    -- refused at send time (opt-outs and the other D1 blocks): one row per decision and reason code
    SELECT g.channel, 'blocked', app.ops_label(r.code)
      FROM public.gate_decisions g CROSS JOIN LATERAL unnest(g.reason_codes) AS r(code)
     WHERE g.phase = 'send' AND g.outcome = 'deny' AND g.evaluated_at >= p_since
  ) x
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
   GROUP BY x.channel, x.result, x.reason
$$;

CREATE FUNCTION app.ops_timer_lateness(p_since timestamptz)
RETURNS TABLE (kind text, fired bigint, late_60s bigint, p50_seconds double precision, p95_seconds double precision, max_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH t AS (
    SELECT f.type, GREATEST(0, EXTRACT(EPOCH FROM f.fired_at - f.due_at))::double precision AS late
      FROM app.ops_fired_timers(p_since) f WHERE f.due_at IS NOT NULL)
  SELECT t.type, count(*), count(*) FILTER (WHERE t.late > 60),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY t.late), percentile_cont(0.95) WITHIN GROUP (ORDER BY t.late), max(t.late)
    FROM t
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
   GROUP BY t.type
$$;

CREATE FUNCTION app.ops_tenant_count() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*)::int FROM public.tenants t
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL AND t.status = 'active'
$$;

-- New-lead first response (SLO: 60 s). Per inquiry received since p_since (and at least 60 s ago, so
-- every counted inquiry had its full minute): seconds until the first outbound message to that contact
-- left (sent or delivered). An inquiry whose contact cannot be messaged (an opt-out blocked the reply)
-- counts as 'blocked', never as a miss; one with no reply at all is 'none'.
CREATE FUNCTION app.ops_first_response(p_since timestamptz)
RETURNS TABLE (result text, n bigint, p50_seconds double precision, p95_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH i AS (
    SELECT q.tenant_id, q.contact_id, q.received_at,
           (SELECT min(m.dispatched_at) FROM public.messages m
             WHERE m.tenant_id = q.tenant_id AND m.contact_id = q.contact_id AND m.direction = 'outbound'
               AND m.status IN ('sent','delivered') AND m.dispatched_at >= q.received_at) AS first_at,
           EXISTS (SELECT 1 FROM public.gate_decisions g
                    WHERE g.tenant_id = q.tenant_id AND g.contact_id = q.contact_id AND g.phase = 'send'
                      AND g.outcome = 'deny' AND g.evaluated_at >= q.received_at) AS blocked
      FROM public.lead_inquiries q
     WHERE q.received_at >= p_since AND q.received_at <= now() - interval '60 seconds'),
  r AS (
    SELECT CASE WHEN i.first_at IS NOT NULL AND i.first_at - i.received_at <= interval '60 seconds' THEN 'within_60s'
                WHEN i.first_at IS NOT NULL THEN 'over_60s'
                WHEN i.blocked THEN 'blocked'
                ELSE 'none' END AS result,
           EXTRACT(EPOCH FROM i.first_at - i.received_at)::double precision AS secs
      FROM i)
  -- the quantiles are over every answered inquiry (the same two values on each row)
  SELECT r.result, count(*),
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a.secs) FROM r a WHERE a.secs IS NOT NULL),
         (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY a.secs) FROM r a WHERE a.secs IS NOT NULL)
    FROM r
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
   GROUP BY r.result
$$;

-- ---- tenant-scoped (System page; Owner/Admin user actors only) -----------------------------------
CREATE FUNCTION app.ops_tenant_jobs(p_view text, p_limit integer)
RETURNS TABLE (id bigint, queue text, kind text, status text, attempts integer, max_attempts integer,
               last_error text, run_at timestamptz, created_at timestamptz, finished_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.id, j.queue, j.kind, j.status, j.attempts, j.max_attempts, j.last_error, j.run_at, j.created_at, j.finished_at
    FROM public.jobs j
   WHERE j.tenant_id = app.tenant_id() AND app.my_role() IN ('owner','admin')
     AND CASE p_view
           WHEN 'dead' THEN j.status = 'dead' AND j.finished_at >= now() - interval '7 days'
           WHEN 'retrying' THEN j.status = 'pending' AND j.attempts > 0
           ELSE false END
   ORDER BY COALESCE(j.finished_at, j.run_at) DESC, j.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;

CREATE FUNCTION app.ops_tenant_job_counts()
RETURNS TABLE (dead_7d bigint, retrying bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*) FILTER (WHERE j.status = 'dead' AND j.finished_at >= now() - interval '7 days'),
         count(*) FILTER (WHERE j.status = 'pending' AND j.attempts > 0)
    FROM public.jobs j
   WHERE j.tenant_id = app.tenant_id() AND app.my_role() IN ('owner','admin')
     AND (j.status = 'dead' OR (j.status = 'pending' AND j.attempts > 0))
$$;

-- Returns the outcome: retried | not_found | not_retryable | duplicate_live (a live job with the same
-- dedupe key already covers this work).
CREATE FUNCTION app.ops_retry_job(p_id bigint) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  j public.jobs%ROWTYPE;
BEGIN
  IF app.tenant_id() IS NULL OR app.my_role() IS NULL OR app.my_role() NOT IN ('owner','admin') THEN
    RETURN 'not_found';
  END IF;
  SELECT * INTO j FROM public.jobs WHERE id = p_id AND tenant_id = app.tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF j.status = 'dead' THEN
    IF j.dedupe_key IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.jobs o WHERE o.tenant_id = j.tenant_id AND o.dedupe_key = j.dedupe_key
            AND o.status IN ('pending','running') AND o.id <> j.id) THEN
      RETURN 'duplicate_live';
    END IF;
    UPDATE public.jobs SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL
     WHERE id = j.id;
    RETURN 'retried';
  ELSIF j.status = 'pending' AND j.attempts > 0 THEN
    UPDATE public.jobs SET run_at = LEAST(run_at, now()) WHERE id = j.id;
    RETURN 'retried';
  END IF;
  RETURN 'not_retryable';
END
$$;

-- Returns: cancelled | not_found | not_cancellable (only waiting jobs can be cancelled; a running job
-- holds a lease and finishes or is reaped).
CREATE FUNCTION app.ops_cancel_job(p_id bigint) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  j public.jobs%ROWTYPE;
BEGIN
  IF app.tenant_id() IS NULL OR app.my_role() IS NULL OR app.my_role() NOT IN ('owner','admin') THEN
    RETURN 'not_found';
  END IF;
  SELECT * INTO j FROM public.jobs WHERE id = p_id AND tenant_id = app.tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF j.status <> 'pending' THEN RETURN 'not_cancellable'; END IF;
  UPDATE public.jobs SET status = 'cancelled', finished_at = now() WHERE id = j.id;
  RETURN 'cancelled';
END
$$;

-- ---- ownership and grants (least privilege) ---------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app.ops_queue_stats()', 'app.ops_message_stats()', 'app.ops_dispatch_results(timestamptz)',
    'app.ops_timer_lateness(timestamptz)', 'app.ops_tenant_count()', 'app.ops_first_response(timestamptz)', 'app.ops_tenant_jobs(text, integer)',
    'app.ops_tenant_job_counts()', 'app.ops_retry_job(bigint)', 'app.ops_cancel_job(bigint)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', f);
  END LOOP;
END
$$;
