-- =============================================================================
-- 0042 (api/accountability): a re-inquiry that starts a new ownership period is a speed-to-lead period of
-- its own, and it ends the earlier period's first-touch window. Owner decision 2026-11-11 (docs/DATA_MODEL.md
-- R-ACC-2, E68). Nothing in code or tests names this file by number (lane mls-sync holds 0041; renumber
-- freely).
--
-- Why. R-OWN-20 / E68: when an owned lead inquires again more than reinquiry_sla_after_days after its last
-- human touch, the ownership engine writes a `reinquiry` event with payload.newPeriod = true and a new
-- first-touch deadline. fold's startsPeriod makes it a new ownership period of the same owner (the first touch
-- resets), and the exception queue gives it a new item key. The speed-to-lead definitions still ended a
-- period's first-touch window only when the lead left the agent, and counted only accept, claim, assign and
-- reassign periods. So a touch made after the re-inquiry counted as the EARLIER period's late first touch (its
-- response time measured to it), and the re-inquiry period itself counted nowhere.
--
-- The rule now, in every definition (the same as slaFacts in apps/api/src/accountability/repos/exceptions.ts):
--   * a period starts at offer_accepted, claimed, assigned or reassigned, or at a reinquiry whose payload has
--     newPeriod = true, with a first-touch deadline (imports start none);
--   * its first touch is the first first_touch_recorded before its window ends: at an event that took the lead
--     from the agent (the 0001 list) or at a newPeriod reinquiry. A plain reinquiry (no new SLA) ends nothing.
--
-- Replaced (same signatures, columns and grants; each body is its previous body plus the rule above):
--   1. v_speed_to_lead (0001), security_invoker as before.
--   2. app.scoreboard_speed (0033 body).
--   3. app.scoreboard_rollup_roll (0035 body): only its speed rows change.
--   4. app.scoreboard_mark_ledger (0033) and its INSERT trigger: a newPeriod reinquiry is a period start (it
--      marks its own day), and a first touch marks the day of the latest period start before it, re-inquiry
--      periods included (the period the touch now belongs to).
--   5. Rolled days whose speed rows change are marked dirty, so they are read live until the job re-rolls
--      them: the day of every newPeriod reinquiry (its period's row was missing) and the day of the period
--      before it (its first touch may have been one made after the reinquiry, which is now none).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; docs/SECURITY.md §6): three existing SECURITY DEFINER functions are
-- replaced with CREATE OR REPLACE and re-asserted: owner app_definer, search_path pinned to
-- pg_catalog, public, EXECUTE revoked from PUBLIC; app.scoreboard_speed and app.scoreboard_rollup_roll
-- executable by app_user as before; app.scoreboard_mark_ledger (a trigger function) by nobody. They return
-- the same columns as before (timings and counts only, no contact id). No definer, table or policy is added.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. v_speed_to_lead (0001): the documented definition (R-ACC-2, R-ACC-4)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_speed_to_lead WITH (security_invoker = true) AS
  SELECT e.tenant_id, e.owner_user_id AS user_id, e.contact_id, e.seq AS owned_seq,
         e.occurred_at AS owned_at, e.deadline_at AS first_touch_due_at, ft.occurred_at AS first_touch_at,
         CASE WHEN ft.occurred_at IS NOT NULL THEN EXTRACT(EPOCH FROM (ft.occurred_at - e.occurred_at))::bigint END AS response_seconds,
         (ft.occurred_at IS NOT NULL AND ft.occurred_at <= e.deadline_at) AS within_sla
    FROM lead_ownership_events e
    LEFT JOIN LATERAL (
      SELECT f.occurred_at FROM lead_ownership_events f
       WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq
         AND f.type = 'first_touch_recorded'
         AND NOT EXISTS (SELECT 1 FROM lead_ownership_events x
                          WHERE x.tenant_id = e.tenant_id AND x.contact_id = e.contact_id
                            AND x.seq > e.seq AND x.seq < f.seq
                            AND x.type IN ('reassigned','released','auto_released','inactivity_released','sent_to_pond',
                                           'closed','merged_away','claimed','assigned','offer_accepted','reinquiry')
                            AND (x.type <> 'reinquiry' OR x.payload @> '{"newPeriod": true}'))
       ORDER BY f.seq LIMIT 1) ft ON true
   WHERE e.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
     AND (e.type <> 'reinquiry' OR e.payload @> '{"newPeriod": true}')
     AND e.deadline_at IS NOT NULL;
GRANT SELECT ON v_speed_to_lead TO app_user;

-- -----------------------------------------------------------------------------
-- 2. app.scoreboard_speed (0033 body: one probe per period, plus the re-inquiry rule)
-- -----------------------------------------------------------------------------
-- The probe is the first event after the period that is a first touch or ends the window; the period's first
-- touch is that event iff it is a first_touch_recorded. A newPeriod reinquiry now ends the window too.
CREATE OR REPLACE FUNCTION app.scoreboard_speed(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (user_id uuid, owned_at timestamptz, first_touch_due_at timestamptz, first_touch_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.owner_user_id, e.occurred_at, e.deadline_at, CASE WHEN nx.type = 'first_touch_recorded' THEN nx.occurred_at END
    FROM public.lead_ownership_events e
    LEFT JOIN LATERAL (
      SELECT f.type, f.occurred_at FROM public.lead_ownership_events f
       WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq
         AND f.type IN ('first_touch_recorded','reassigned','released','auto_released','inactivity_released','sent_to_pond',
                        'closed','merged_away','claimed','assigned','offer_accepted','reinquiry')
         AND (f.type <> 'reinquiry' OR f.payload @> '{"newPeriod": true}')
       ORDER BY f.seq LIMIT 1) nx ON true
   WHERE e.tenant_id = app.tenant_id()
     AND e.owner_user_id IN (SELECT a.user_id FROM app.scoreboard_allowed_users(p_user_ids) a)
     AND e.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
     AND (e.type <> 'reinquiry' OR e.payload @> '{"newPeriod": true}')
     AND e.deadline_at IS NOT NULL
     AND e.actor_kind <> 'import'
     AND e.occurred_at >= p_from AND e.occurred_at < p_to
$$;

-- -----------------------------------------------------------------------------
-- 3. The rollup's writer (0035 body; only the speed rows change, to section 2's rows)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.scoreboard_rollup_roll(p_window_days integer DEFAULT 92, p_max_days integer DEFAULT 31)
RETURNS TABLE (days_rolled integer, activity_rows integer, speed_rows integer, marks_cleared integer,
               pending_days integer, safe_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_zone   text;
  v_state  public.scoreboard_rollup_state%ROWTYPE;
  v_safe   timestamptz;
  v_today  date;
  v_first  date;
  v_days   date[];
  v_all    date[];
  v_marks  bigint[];
  v_act    integer := 0;
  v_spd    integer := 0;
  v_clr    integer := 0;
BEGIN
  IF v_tenant IS NULL OR app.actor_kind() <> 'system' OR app.principal_type() IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'SCOREBOARD_ROLLUP_SYSTEM_ONLY' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_window_days < 1 OR p_window_days > 400 OR p_max_days < 1 THEN
    RAISE EXCEPTION 'SCOREBOARD_ROLLUP_BAD_ARGS' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- one run per tenant at a time
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':scoreboard_rollup', 0));
  SELECT ts.default_timezone INTO v_zone FROM public.tenant_settings ts WHERE ts.tenant_id = v_tenant;
  IF v_zone IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, 0, 0, NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO public.scoreboard_rollup_state (tenant_id, zone) VALUES (v_tenant, v_zone) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO v_state FROM public.scoreboard_rollup_state s WHERE s.tenant_id = v_tenant FOR UPDATE;
  IF v_state.zone IS DISTINCT FROM v_zone THEN
    -- the zone changed: no earlier sample proves anything about the new day boundaries
    UPDATE public.scoreboard_rollup_state s SET zone = v_zone, safe_until = NULL, pending_at = NULL, pending_xid = NULL, updated_at = now()
     WHERE s.tenant_id = v_tenant;
    v_safe := NULL;
    -- days rolled in another zone are never read (the read path matches the zone); drop them
    DELETE FROM public.scoreboard_rollup_days r WHERE r.tenant_id = v_tenant AND r.zone <> v_zone;
    DELETE FROM public.scoreboard_activity_daily a WHERE a.tenant_id = v_tenant
       AND NOT EXISTS (SELECT 1 FROM public.scoreboard_rollup_days r WHERE r.tenant_id = v_tenant AND r.day = a.day);
    DELETE FROM public.scoreboard_speed_daily s WHERE s.tenant_id = v_tenant
       AND NOT EXISTS (SELECT 1 FROM public.scoreboard_rollup_days r WHERE r.tenant_id = v_tenant AND r.day = s.day);
  ELSE
    v_safe := v_state.safe_until;
    IF v_state.pending_xid IS NOT NULL AND pg_snapshot_xmin(pg_current_snapshot())::text::bigint > v_state.pending_xid THEN
      v_safe := GREATEST(COALESCE(v_safe, v_state.pending_at), v_state.pending_at);
      UPDATE public.scoreboard_rollup_state s SET safe_until = v_safe, pending_at = NULL, pending_xid = NULL, updated_at = now()
       WHERE s.tenant_id = v_tenant;
    END IF;
  END IF;

  v_today := app.scoreboard_day_of(clock_timestamp(), v_zone);
  v_first := v_today - p_window_days;

  -- the marks this run sees (only these are deleted below)
  SELECT array_agg(m.id) INTO v_marks FROM public.scoreboard_rollup_dirty m WHERE m.tenant_id = v_tenant;

  -- every candidate day (closed, safe, inside the window): missing, rolled in another zone, or marked
  SELECT array_agg(g.day ORDER BY g.day DESC) INTO v_all
    FROM (SELECT v_first + i AS day FROM generate_series(0, p_window_days - 1) i) g
   WHERE v_safe IS NOT NULL
     AND (((g.day + 1)::timestamp) AT TIME ZONE v_zone) <= v_safe
     AND (NOT EXISTS (SELECT 1 FROM public.scoreboard_rollup_days r WHERE r.tenant_id = v_tenant AND r.day = g.day AND r.zone = v_zone)
          OR EXISTS (SELECT 1 FROM public.scoreboard_rollup_dirty m WHERE m.tenant_id = v_tenant AND m.day = g.day AND m.id = ANY (v_marks)));
  v_days := v_all[1:p_max_days];

  IF COALESCE(array_length(v_days, 1), 0) > 0 THEN
    DELETE FROM public.scoreboard_activity_daily a WHERE a.tenant_id = v_tenant AND a.day = ANY (v_days);
    DELETE FROM public.scoreboard_speed_daily s WHERE s.tenant_id = v_tenant AND s.day = ANY (v_days);

    -- the same filters as app.scoreboard_activity (0012, with the R-PAR-37 bulk exclusion), bucketed by the same day boundaries
    WITH days AS (
      SELECT d AS day, (d::timestamp AT TIME ZONE v_zone) AS lo, ((d + 1)::timestamp AT TIME ZONE v_zone) AS hi FROM unnest(v_days) d
    ), b AS (SELECT min(lo) AS lo, max(hi) AS hi FROM days),
    counts AS (
      SELECT c.agent_user_id AS user_id, dd.day, 1 AS calls, 0 AS texts, 0 AS aset, 0 AS aheld, 0 AS adue, 0 AS agr
        FROM b, public.calls c JOIN days dd ON c.started_at >= dd.lo AND c.started_at < dd.hi
       WHERE c.tenant_id = v_tenant AND c.direction = 'outbound' AND c.initiator = 'human' AND NOT c.imported
         AND c.started_at >= b.lo AND c.started_at < b.hi AND c.agent_user_id IS NOT NULL
      UNION ALL
      SELECT m.initiated_by_user_id, dd.day, 0, 1, 0, 0, 0, 0
        FROM b, public.messages m JOIN days dd ON m.dispatched_at >= dd.lo AND m.dispatched_at < dd.hi
       WHERE m.tenant_id = v_tenant AND m.direction = 'outbound' AND m.initiator = 'human' AND NOT m.imported
         AND m.dispatched_at IS NOT NULL AND m.dispatched_at >= b.lo AND m.dispatched_at < b.hi AND m.initiated_by_user_id IS NOT NULL
         AND m.bulk_action_id IS NULL   -- R-PAR-37: a bulk send is never a touch
      UNION ALL
      SELECT COALESCE(p.set_by_user_id, p.user_id), dd.day, 0, 0, 1, 0, 0, 0
        FROM b, public.appointments p JOIN days dd ON p.created_at >= dd.lo AND p.created_at < dd.hi
       WHERE p.tenant_id = v_tenant AND p.created_by_kind = 'user' AND p.created_at >= b.lo AND p.created_at < b.hi
      UNION ALL
      SELECT p.user_id, dd.day, 0, 0, 0, (p.status = 'held')::int, (p.status NOT IN ('canceled','rescheduled'))::int, 0
        FROM b, public.appointments p JOIN days dd ON p.starts_at >= dd.lo AND p.starts_at < dd.hi
       WHERE p.tenant_id = v_tenant AND p.created_by_kind <> 'import' AND p.starts_at >= b.lo AND p.starts_at < b.hi
         AND p.status NOT IN ('canceled','rescheduled')
      UNION ALL
      SELECT d.owner_user_id, dd.day, 0, 0, 0, 0, 0, 1
        FROM b, public.deal_stage_history h
        JOIN public.deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
        JOIN days dd ON h.changed_at >= dd.lo AND h.changed_at < dd.hi
       WHERE h.tenant_id = v_tenant AND h.to_stage = 'agreement_signed' AND h.changed_at >= b.lo AND h.changed_at < b.hi
         AND d.owner_user_id IS NOT NULL
    )
    INSERT INTO public.scoreboard_activity_daily (tenant_id, user_id, day, calls, texts_and_emails, appointments_set,
                                                  appointments_held, appointments_due, agreements_signed)
    SELECT v_tenant, x.user_id, x.day, sum(x.calls), sum(x.texts), sum(x.aset), sum(x.aheld), sum(x.adue), sum(x.agr)
      FROM counts x GROUP BY x.user_id, x.day;
    GET DIAGNOSTICS v_act = ROW_COUNT;

    -- the same rows as app.scoreboard_speed (section 2 above), for every owner
    WITH days AS (
      SELECT d AS day, (d::timestamp AT TIME ZONE v_zone) AS lo, ((d + 1)::timestamp AT TIME ZONE v_zone) AS hi FROM unnest(v_days) d
    ), b AS (SELECT min(lo) AS lo, max(hi) AS hi FROM days)
    INSERT INTO public.scoreboard_speed_daily (tenant_id, user_id, day, ord, owned_at, first_touch_due_at, first_touch_at)
    SELECT v_tenant, e.owner_user_id, dd.day,
           row_number() OVER (PARTITION BY e.owner_user_id, dd.day ORDER BY e.occurred_at, e.contact_id, e.seq),
           e.occurred_at, e.deadline_at, CASE WHEN nx.type = 'first_touch_recorded' THEN nx.occurred_at END
      FROM b, public.lead_ownership_events e
      JOIN days dd ON e.occurred_at >= dd.lo AND e.occurred_at < dd.hi
      LEFT JOIN LATERAL (
        SELECT f.type, f.occurred_at FROM public.lead_ownership_events f
         WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq
           AND f.type IN ('first_touch_recorded','reassigned','released','auto_released','inactivity_released','sent_to_pond',
                          'closed','merged_away','claimed','assigned','offer_accepted','reinquiry')
           AND (f.type <> 'reinquiry' OR f.payload @> '{"newPeriod": true}')
         ORDER BY f.seq LIMIT 1) nx ON true
     WHERE e.tenant_id = v_tenant AND e.owner_user_id IS NOT NULL
       AND e.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
       AND (e.type <> 'reinquiry' OR e.payload @> '{"newPeriod": true}')
       AND e.deadline_at IS NOT NULL
       AND e.actor_kind <> 'import'
       AND e.occurred_at >= b.lo AND e.occurred_at < b.hi;
    GET DIAGNOSTICS v_spd = ROW_COUNT;

    INSERT INTO public.scoreboard_rollup_days AS r (tenant_id, day, zone, rolled_at)
    SELECT v_tenant, d, v_zone, clock_timestamp() FROM unnest(v_days) d
    ON CONFLICT (tenant_id, day) DO UPDATE SET zone = EXCLUDED.zone, rolled_at = EXCLUDED.rolled_at;
  END IF;

  -- marks of the days just rolled, and marks outside the window, are done
  DELETE FROM public.scoreboard_rollup_dirty m
   WHERE m.tenant_id = v_tenant AND m.id = ANY (COALESCE(v_marks, '{}'))
     AND (m.day = ANY (COALESCE(v_days, '{}')) OR m.day < v_first);
  GET DIAGNOSTICS v_clr = ROW_COUNT;

  -- nothing older than the window is ever read
  DELETE FROM public.scoreboard_activity_daily a WHERE a.tenant_id = v_tenant AND a.day < v_first;
  DELETE FROM public.scoreboard_speed_daily s WHERE s.tenant_id = v_tenant AND s.day < v_first;
  DELETE FROM public.scoreboard_rollup_days r WHERE r.tenant_id = v_tenant AND r.day < v_first;

  RETURN QUERY SELECT COALESCE(array_length(v_days, 1), 0), v_act, v_spd, v_clr,
                      GREATEST(COALESCE(array_length(v_all, 1), 0) - COALESCE(array_length(v_days, 1), 0), 0), v_safe;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Dirty-day marks of the ledger (0033): re-inquiry periods are period starts
-- -----------------------------------------------------------------------------
-- A row r can change the speed row of r itself (a period start) and of the period r falls in (the latest
-- period start before r: a first touch, or an event that ends the window).
CREATE OR REPLACE FUNCTION app.scoreboard_mark_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.type IN ('offer_accepted','claimed','assigned','reassigned')
       OR (OLD.type = 'reinquiry' AND OLD.payload @> '{"newPeriod": true}') THEN
      PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.occurred_at);
    END IF;
    SELECT e.occurred_at INTO v FROM public.lead_ownership_events e
     WHERE e.tenant_id = OLD.tenant_id AND e.contact_id = OLD.contact_id AND e.seq < OLD.seq
       AND e.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
       AND (e.type <> 'reinquiry' OR e.payload @> '{"newPeriod": true}')
     ORDER BY e.seq DESC LIMIT 1;
    PERFORM app.scoreboard_mark(OLD.tenant_id, v);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.type IN ('offer_accepted','claimed','assigned','reassigned')
       OR (NEW.type = 'reinquiry' AND NEW.payload @> '{"newPeriod": true}') THEN
      PERFORM app.scoreboard_mark(NEW.tenant_id, NEW.occurred_at);
    END IF;
    -- an appended period start (the guard makes every insert the contact's new head) cannot change an
    -- earlier period: no first touch follows it yet. Only an appended first touch reaches back.
    IF TG_OP = 'INSERT' AND NEW.type <> 'first_touch_recorded' THEN
      RETURN NULL;
    END IF;
    v := NULL;
    SELECT e.occurred_at INTO v FROM public.lead_ownership_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.contact_id = NEW.contact_id AND e.seq < NEW.seq
       AND e.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
       AND (e.type <> 'reinquiry' OR e.payload @> '{"newPeriod": true}')
     ORDER BY e.seq DESC LIMIT 1;
    PERFORM app.scoreboard_mark(NEW.tenant_id, v);
  END IF;
  RETURN NULL;
END $$;
-- appended rows (the only app path) change a period only as its start or its first touch
DROP TRIGGER scoreboard_mark_ins ON public.lead_ownership_events;
CREATE TRIGGER scoreboard_mark_ins AFTER INSERT ON public.lead_ownership_events FOR EACH ROW
  WHEN (NEW.type IN ('first_touch_recorded','offer_accepted','claimed','assigned','reassigned')
        OR (NEW.type = 'reinquiry' AND NEW.payload @> '{"newPeriod": true}'))
  EXECUTE FUNCTION app.scoreboard_mark_ledger();

-- -----------------------------------------------------------------------------
-- 5. Rolled days whose speed rows change: marked dirty (read live, now exact, until the job re-rolls them)
-- -----------------------------------------------------------------------------
-- For every newPeriod reinquiry of a tenant with rolled days: its own day (the rollup has no row for its
-- period) and the day of the period start before it (that period's first touch may have been one made after
-- the reinquiry; it is now none). Only days that are rolled, in the zone they were rolled in. Marking a day
-- whose rows turn out unchanged only makes it read live until the next re-roll.
WITH q AS (
  SELECT q.tenant_id, q.contact_id, q.seq, q.occurred_at
    FROM (SELECT DISTINCT r.tenant_id FROM public.scoreboard_rollup_days r) t
    JOIN public.lead_ownership_events q ON q.tenant_id = t.tenant_id AND q.type = 'reinquiry'
   WHERE q.payload @> '{"newPeriod": true}' AND q.deadline_at IS NOT NULL
), at AS (
  SELECT q.tenant_id, q.occurred_at AS at FROM q
  UNION
  SELECT q.tenant_id, p.occurred_at
    FROM q CROSS JOIN LATERAL (
      SELECT p.occurred_at FROM public.lead_ownership_events p
       WHERE p.tenant_id = q.tenant_id AND p.contact_id = q.contact_id AND p.seq < q.seq
         AND p.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
         AND (p.type <> 'reinquiry' OR p.payload @> '{"newPeriod": true}')
       ORDER BY p.seq DESC LIMIT 1) p
)
INSERT INTO public.scoreboard_rollup_dirty (tenant_id, day)
SELECT DISTINCT r.tenant_id, r.day
  FROM at JOIN public.scoreboard_rollup_days r
    ON r.tenant_id = at.tenant_id
   AND at.at >= (r.day::timestamp AT TIME ZONE r.zone) AND at.at < ((r.day + 1)::timestamp AT TIME ZONE r.zone);

-- -----------------------------------------------------------------------------
-- 6. Ownership and grants of the replaced definers (as 0033 / 0035)
-- -----------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.scoreboard_speed(uuid[], timestamptz, timestamptz)', 'app.scoreboard_rollup_roll(integer, integer)',
                           'app.scoreboard_mark_ledger()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app.scoreboard_speed(uuid[], timestamptz, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION app.scoreboard_rollup_roll(integer, integer) TO app_user;

-- -----------------------------------------------------------------------------
-- 7. Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  -- the replaced definers keep their reviewed owner, pinned search_path and grants, and carry the rule
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('app.scoreboard_speed(uuid[],timestamptz,timestamptz)'::regprocedure,
                              'app.scoreboard_rollup_roll(integer,integer)'::regprocedure, 'app.scoreboard_mark_ledger()'::regprocedure)
                AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                     OR has_function_privilege('public', p.oid, 'EXECUTE')
                     OR position('payload @> ''{"newPeriod": true}''' IN p.prosrc) = 0)) THEN
    bad := bad || ' scoreboard_definer';
  END IF;
  IF NOT has_function_privilege('app_user', 'app.scoreboard_speed(uuid[],timestamptz,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('app_user', 'app.scoreboard_rollup_roll(integer,integer)', 'EXECUTE')
     OR has_function_privilege('app_user', 'app.scoreboard_mark_ledger()', 'EXECUTE') THEN
    bad := bad || ' scoreboard_grants';
  END IF;
  -- the rollup writer still excludes bulk sends (R-PAR-37, 0035)
  IF position('bulk_action_id IS NULL' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'app.scoreboard_rollup_roll(integer,integer)'::regprocedure)) = 0 THEN
    bad := bad || ' rollup_bulk_exclusion';
  END IF;
  -- the view stays security_invoker, readable by app_user, and carries the rule
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.v_speed_to_lead'::regclass AND 'security_invoker=true' = ANY (c.reloptions))
     OR NOT has_table_privilege('app_user', 'public.v_speed_to_lead', 'SELECT')
     OR position('newPeriod' IN pg_get_viewdef('public.v_speed_to_lead'::regclass)) = 0 THEN
    bad := bad || ' v_speed_to_lead';
  END IF;
  -- the INSERT mark fires for a newPeriod reinquiry
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.lead_ownership_events'::regclass AND g.tgname = 'scoreboard_mark_ins'
                    AND g.tgfoid = 'app.scoreboard_mark_ledger()'::regprocedure AND position('newPeriod' IN pg_get_triggerdef(g.oid)) > 0) THEN
    bad := bad || ' scoreboard_mark_ins';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (re-inquiry speed periods):%', bad;
  END IF;
END $$;
