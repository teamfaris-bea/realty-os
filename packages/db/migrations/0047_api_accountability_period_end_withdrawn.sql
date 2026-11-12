-- =============================================================================
-- 0047 (api/accountability): one rule for when a lead leaves its owner, and withdrawn exception items.
-- Batch 6 interaction review, group ownership: ownership-sla/F5 (and the stored items of F2). Nothing in code or
-- tests names this file by number (the orchestrator renumbers at merge).
--
-- Why (F5). A first-touch window ends when the lead leaves its agent (DATA_MODEL R-ACC-2). The untouched-lead card
-- already read "leaves" as any ledger event that takes the lead out of `owned` or gives it to someone else
-- (exceptions.ts LEAVES_OWNER). The derivation (slaFacts) and the four speed-to-lead definitions read only the 0001
-- type list, which misses two ways a lead leaves its owner:
--   * a merge that hands the survivor to the loser's owner writes only `merged_in` on it (owned by B, a new period
--     with no deadline): B's later first touch became A's period's first touch, so A was credited with B's response
--     time, or A's miss read "fixed late" by B;
--   * a deactivation re-route (R-OWN-22 stage 3) goes straight from owned to `offered`: the window ran on to the
--     later accept, so a period that left its owner before its deadline could still be a miss.
-- The rule now, everywhere (the same as slaFacts in apps/api/src/accountability/repos/exceptions.ts): a period's
-- first-touch window ends at the first later event that is on the 0001 list, is a newPeriod reinquiry (0045), or
-- takes the lead from the period's owner (`to_state <> 'owned' OR owner_user_id IS DISTINCT FROM` the period's).
-- Nothing that ended a window before stops ending it.
--
-- Why (withdrawn items, F2 and F5). A stored untouched_lead item whose period the current rules make no item (rule 3:
-- a re-inquiry superseded it before its deadline; now also: its lead left its owner before it) was cleared like a
-- late fix: condition_cleared_at set, so the Team Lead's live queue said "Fixed late: This was put right after it was
-- due" of a period nobody missed. Such an item is now withdrawn (core withdrawnUntouched): `withdrawn_at` is set, its
-- evidence says why, it leaves the live queue and its counts, and its human events stand. Only untouched_lead items
-- are withdrawn (CHECK).
--
-- Sections:
--   1. exception_items.withdrawn_at (with a CHECK: untouched_lead items only).
--   2-4. Replaced, same signatures, columns and grants; each body is its 0045 body with the rule above:
--      v_speed_to_lead (security_invoker as before), app.scoreboard_speed, and app.scoreboard_rollup_roll (only its
--      speed rows' probe changes).
--   5. Rolled days whose speed rows change are marked dirty (read live, now exact, until the job re-rolls them): for
--      every event that takes the lead from its owner and is not on the 0001 list (an owner-changing merged_in, an
--      owned -> offered re-route, an import revert), the day of the latest SLA period start before it.
--   6-7. Ownership and grants re-asserted; self-check.
-- Not replaced: app.scoreboard_mark_ledger (0045). Its INSERT trigger marks a period start's day and, for an appended
-- first touch, the day of the latest period start before it. An appended event that ends a window is the contact's
-- new head, so no first touch follows it yet and it cannot change an earlier period's row; a touch after it marks a
-- day whose row it no longer changes, which only makes that day read live until the next re-roll.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; docs/SECURITY.md §6; ARCHITECTURE §21.1): two existing SECURITY DEFINER
-- functions are replaced with CREATE OR REPLACE and re-asserted: owner app_definer, search_path pinned to
-- pg_catalog, public, EXECUTE revoked from PUBLIC and granted to app_user as before. They return the same columns as
-- before (timings and counts only, no contact id), and the member rule is unchanged. No definer, table or policy is
-- added; exception_items gets one nullable column under its existing policies and grants.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. exception_items.withdrawn_at: a stored item the current definitions derive no item for (core withdrawnUntouched)
-- -----------------------------------------------------------------------------
ALTER TABLE exception_items ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE exception_items ADD CONSTRAINT exception_items_withdrawn_untouched_only
  CHECK (withdrawn_at IS NULL OR item_type = 'untouched_lead');

-- -----------------------------------------------------------------------------
-- 2. v_speed_to_lead (0045): the documented definition (R-ACC-2, R-ACC-4)
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
                            AND (x.type IN ('reassigned','released','auto_released','inactivity_released','sent_to_pond',
                                            'closed','merged_away','claimed','assigned','offer_accepted')
                                 OR (x.type = 'reinquiry' AND x.payload @> '{"newPeriod": true}')
                                 -- 0047: any event that takes the lead from the period's owner
                                 OR x.to_state <> 'owned' OR x.owner_user_id IS DISTINCT FROM e.owner_user_id))
       ORDER BY f.seq LIMIT 1) ft ON true
   WHERE e.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
     AND (e.type <> 'reinquiry' OR e.payload @> '{"newPeriod": true}')
     AND e.deadline_at IS NOT NULL;
GRANT SELECT ON v_speed_to_lead TO app_user;

-- -----------------------------------------------------------------------------
-- 3. app.scoreboard_speed (0045 body: one probe per period, plus the leaves-the-owner rule)
-- -----------------------------------------------------------------------------
-- The probe is the first event after the period that is a first touch or ends the window; the period's first
-- touch is that event iff it is a first_touch_recorded. An event that takes the lead from its owner now ends it too.
CREATE OR REPLACE FUNCTION app.scoreboard_speed(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (user_id uuid, owned_at timestamptz, first_touch_due_at timestamptz, first_touch_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.owner_user_id, e.occurred_at, e.deadline_at, CASE WHEN nx.type = 'first_touch_recorded' THEN nx.occurred_at END
    FROM public.lead_ownership_events e
    LEFT JOIN LATERAL (
      SELECT f.type, f.occurred_at FROM public.lead_ownership_events f
       WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq
         AND (f.type IN ('first_touch_recorded','reassigned','released','auto_released','inactivity_released','sent_to_pond',
                         'closed','merged_away','claimed','assigned','offer_accepted')
              OR (f.type = 'reinquiry' AND f.payload @> '{"newPeriod": true}')
              -- 0047: any event that takes the lead from the period's owner (out of owned, or to someone else)
              OR f.to_state <> 'owned' OR f.owner_user_id IS DISTINCT FROM e.owner_user_id)
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
-- 4. The rollup's writer (0045 body; only the speed rows' probe changes, to section 3's)
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

    -- the same rows as app.scoreboard_speed (section 3 above), for every owner
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
           AND (f.type IN ('first_touch_recorded','reassigned','released','auto_released','inactivity_released','sent_to_pond',
                           'closed','merged_away','claimed','assigned','offer_accepted')
                OR (f.type = 'reinquiry' AND f.payload @> '{"newPeriod": true}')
                -- 0047: any event that takes the lead from the period's owner (out of owned, or to someone else)
                OR f.to_state <> 'owned' OR f.owner_user_id IS DISTINCT FROM e.owner_user_id)
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
-- 5. Rolled days whose speed rows change: marked dirty (read live, now exact, until the job re-rolls them)
-- -----------------------------------------------------------------------------
-- An event that takes the lead from its owner and was not on the 0001 list (so it ended no window before) can only
-- change the row of the period it falls in: the latest SLA period start before it, whose first touch may have been one
-- made after it (now none). Only events leaving `owned` can (a lead out of `owned` has no window left to end). Only
-- days that are rolled, in the zone they were rolled in. Marking a day whose rows turn out unchanged only makes it read
-- live until the next re-roll.
WITH x AS (
  SELECT x.tenant_id, x.contact_id, x.seq, x.to_state, x.owner_user_id
    FROM (SELECT DISTINCT r.tenant_id FROM public.scoreboard_rollup_days r) t
    JOIN public.lead_ownership_events x ON x.tenant_id = t.tenant_id
   WHERE x.from_state = 'owned'
     AND x.type NOT IN ('reassigned','released','auto_released','inactivity_released','sent_to_pond','closed','merged_away',
                        'claimed','assigned','offer_accepted','reinquiry','first_touch_recorded')
), at AS (
  SELECT x.tenant_id, p.occurred_at AS at
    FROM x CROSS JOIN LATERAL (
      SELECT p.occurred_at, p.owner_user_id FROM public.lead_ownership_events p
       WHERE p.tenant_id = x.tenant_id AND p.contact_id = x.contact_id AND p.seq < x.seq
         AND p.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
         AND (p.type <> 'reinquiry' OR p.payload @> '{"newPeriod": true}')
         AND p.deadline_at IS NOT NULL
       ORDER BY p.seq DESC LIMIT 1) p
   WHERE x.to_state <> 'owned' OR x.owner_user_id IS DISTINCT FROM p.owner_user_id
)
INSERT INTO public.scoreboard_rollup_dirty (tenant_id, day)
SELECT DISTINCT r.tenant_id, r.day
  FROM at JOIN public.scoreboard_rollup_days r
    ON r.tenant_id = at.tenant_id
   AND at.at >= (r.day::timestamp AT TIME ZONE r.zone) AND at.at < ((r.day + 1)::timestamp AT TIME ZONE r.zone);

-- -----------------------------------------------------------------------------
-- 6. Ownership and grants of the replaced definers (as 0045)
-- -----------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.scoreboard_speed(uuid[], timestamptz, timestamptz)', 'app.scoreboard_rollup_roll(integer, integer)'] LOOP
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
  -- the replaced definers keep their reviewed owner, pinned search_path and grants, and carry both rules
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('app.scoreboard_speed(uuid[],timestamptz,timestamptz)'::regprocedure,
                              'app.scoreboard_rollup_roll(integer,integer)'::regprocedure)
                AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                     OR has_function_privilege('public', p.oid, 'EXECUTE')
                     OR position('payload @> ''{"newPeriod": true}''' IN p.prosrc) = 0
                     OR position('f.owner_user_id IS DISTINCT FROM e.owner_user_id' IN p.prosrc) = 0)) THEN
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
  -- the view stays security_invoker, readable by app_user, and carries both rules
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.v_speed_to_lead'::regclass AND 'security_invoker=true' = ANY (c.reloptions))
     OR NOT has_table_privilege('app_user', 'public.v_speed_to_lead', 'SELECT')
     OR position('newPeriod' IN pg_get_viewdef('public.v_speed_to_lead'::regclass)) = 0
     OR position('IS DISTINCT FROM' IN pg_get_viewdef('public.v_speed_to_lead'::regclass)) = 0 THEN
    bad := bad || ' v_speed_to_lead';
  END IF;
  -- exception_items keeps FORCE RLS; app_user reaches the new column through the table grants (no column grants)
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.exception_items'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
     OR NOT has_column_privilege('app_user', 'public.exception_items', 'withdrawn_at', 'UPDATE')
     OR has_table_privilege('app_user', 'public.exception_items', 'DELETE') THEN
    bad := bad || ' exception_items';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (period end / withdrawn items):%', bad;
  END IF;
END $$;
