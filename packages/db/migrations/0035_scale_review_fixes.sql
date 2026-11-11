-- =============================================================================
-- Scale-lane merge review fixes (the review of migrations deal_visibility_once, search_visibility,
-- scoreboard_rollup and feed_incremental against main's FUB parity code). One migration for every database
-- fix; those four migrations are left byte-identical. Nothing in code or tests names this file (it may be
-- renumbered when the pending D2 review migration lands before it).
--
-- Every change below only narrows access, removes a wrong count, or adds a missing feed mark:
--   1. R-PAR-37: a bulk message is never a scoreboard touch. app.scoreboard_activity (0012, never replaced
--      since) and the rollup's writer app.scoreboard_rollup_roll counted every human outbound send, bulk ones
--      included (0021 fixed only v_agent_activity_daily, which nothing reads). Both now skip
--      bulk_action_id IS NOT NULL, the rollup's dirty-day mark ignores bulk rows (they count nowhere), the
--      count keeps its index-only scan, and every stored rollup day that counted a bulk send is marked dirty,
--      so it is read live (now exact) until the job re-rolls it.
--   2. The parity child tables' SELECT policies read through app.contact_detail_row like 0031's fifteen:
--      contact_tags, contact_field_values, contact_stage_events, contact_relationships (both people) and
--      bulk_action_items. USING only; every WITH CHECK, UPDATE and DELETE policy is unchanged.
--   3. Feed marks (all SECURITY INVOKER, as feed_incremental's self-check requires):
--      a. every app.feed_mark_* function writes public.feed_dirty, schema-qualified. Unqualified, the name
--         resolved through the session's temporary schema first (a definer's pinned search_path
--         `pg_catalog, public` does not list pg_temp, so Postgres searches it first for relations): a
--         TEMP TABLE feed_dirty with a trigger let any app_user session run its own code as app_definer or
--         app_retention (BYPASSRLS) whenever a definer wrote a marked table.
--      b. a contact's ownership or visibility change also marks everyone else who holds a card on it: the
--         assignees of its open tasks, the users of its open appointments and the owners of its proposed
--         assistant actions (the only card sources not tied to the contact's owner, workspace/repos/feedInputs.ts);
--         a person added to or removed from a deal, or a deal's new primary person, marks the deal's owner and
--         members for that person (app.my_deal_contact_ids); a member joining or leaving a team marks the
--         team's leads for a full recompute (app.my_team_member_ids).
--      c. only a change of tenant_settings.default_timezone marks the tenant's members '!full' (the feed reads
--         no other setting); any other settings write (stage labels, batch text, Gmail sync, routing hours)
--         marked every member's whole book.
--      d. a DELETE on contact_points (an import revert) marks the contact's owner (channel hints).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; docs/SECURITY.md §6):
--   * Three existing SECURITY DEFINER functions are REPLACED with CREATE OR REPLACE (same signature, so every
--     caller, trigger and grant stays) and re-asserted: owner app_definer, search_path pinned to
--     pg_catalog, public, EXECUTE revoked from PUBLIC; app.scoreboard_activity and app.scoreboard_rollup_roll
--     executable by app_user as before; app.scoreboard_mark_messages (a trigger function) by nobody. Each body
--     is its previous body plus the bulk exclusion. No definer is added.
--   * Five policies' USING clauses: EXISTS (SELECT 1 FROM app.contact_detail_row(t, c)) is word for word the
--     EXISTS of app.contact_detail_visible(t, c) (0031's proof); visibility is unchanged row by row for every
--     role (apps/api/src/load/deal_visibility_equivalence.test.ts).
--   * The feed functions stay SECURITY INVOKER; the new marks are looked up under the writer's RLS, so a mark
--     never reveals more than the writer may see (a mark the writer cannot derive is still repaired by the
--     hourly reconcile, docs/SECURITY.md §6.1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. R-PAR-37: bulk messages are never scoreboard touches
-- -----------------------------------------------------------------------------
-- a) the live counts (0012 body, plus the bulk exclusion)
CREATE OR REPLACE FUNCTION app.scoreboard_activity(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (user_id uuid, calls bigint, texts_and_emails bigint, appointments_set bigint,
               appointments_held bigint, appointments_due bigint, agreements_signed bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.user_id,
         (SELECT count(*) FROM public.calls c
           WHERE c.tenant_id = app.tenant_id() AND c.agent_user_id = a.user_id
             AND c.direction = 'outbound' AND c.initiator = 'human' AND NOT c.imported
             AND c.started_at >= p_from AND c.started_at < p_to),
         (SELECT count(*) FROM public.messages m
           WHERE m.tenant_id = app.tenant_id() AND m.initiated_by_user_id = a.user_id
             AND m.direction = 'outbound' AND m.initiator = 'human' AND NOT m.imported
             AND m.dispatched_at IS NOT NULL AND m.dispatched_at >= p_from AND m.dispatched_at < p_to
             AND m.bulk_action_id IS NULL),   -- R-PAR-37: a bulk send is never a touch
         (SELECT count(*) FROM public.appointments p
           WHERE p.tenant_id = app.tenant_id() AND COALESCE(p.set_by_user_id, p.user_id) = a.user_id
             AND p.created_by_kind = 'user' AND p.created_at >= p_from AND p.created_at < p_to),
         (SELECT count(*) FROM public.appointments p
           WHERE p.tenant_id = app.tenant_id() AND p.user_id = a.user_id AND p.created_by_kind <> 'import'
             AND p.status = 'held' AND p.starts_at >= p_from AND p.starts_at < p_to),
         (SELECT count(*) FROM public.appointments p
           WHERE p.tenant_id = app.tenant_id() AND p.user_id = a.user_id AND p.created_by_kind <> 'import'
             AND p.status NOT IN ('canceled','rescheduled')
             AND p.starts_at >= p_from AND p.starts_at < LEAST(p_to, clock_timestamp())),
         (SELECT count(*) FROM public.deal_stage_history h
            JOIN public.deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
           WHERE h.tenant_id = app.tenant_id() AND d.owner_user_id = a.user_id
             AND h.to_stage = 'agreement_signed' AND h.changed_at >= p_from AND h.changed_at < p_to)
    FROM app.scoreboard_allowed_users(p_user_ids) a
$$;

-- b) the rollup's writer (0033 body, plus the bulk exclusion in the messages leg)
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

    -- the same rows as app.scoreboard_speed (section 0), for every owner
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
                          'closed','merged_away','claimed','assigned','offer_accepted')
         ORDER BY f.seq LIMIT 1) nx ON true
     WHERE e.tenant_id = v_tenant AND e.owner_user_id IS NOT NULL
       AND e.type IN ('offer_accepted','claimed','assigned','reassigned') AND e.deadline_at IS NOT NULL
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

-- c) the dirty-day mark of a message (0033): a bulk message is counted on no day, so it marks none
CREATE OR REPLACE FUNCTION app.scoreboard_mark_messages() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.direction = 'outbound' AND OLD.initiator = 'human' AND NOT OLD.imported AND OLD.bulk_action_id IS NULL THEN
    PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.dispatched_at);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.direction = 'outbound' AND NEW.initiator = 'human' AND NOT NEW.imported AND NEW.bulk_action_id IS NULL THEN
    PERFORM app.scoreboard_mark(NEW.tenant_id, NEW.dispatched_at);
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.scoreboard_activity(uuid[], timestamptz, timestamptz)', 'app.scoreboard_rollup_roll(integer, integer)',
                           'app.scoreboard_mark_messages()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app.scoreboard_activity(uuid[], timestamptz, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION app.scoreboard_rollup_roll(integer, integer) TO app_user;

-- d) the count stays an index-only scan: 0020's partial index matched the old filter exactly, so the new
--    predicate (bulk_action_id is not in the index) would visit the heap for every counted send. Same name,
--    same columns, the predicate narrowed by the bulk exclusion; nothing else reads it (0020 §5).
DROP INDEX public.messages_human_sent_idx;
CREATE INDEX messages_human_sent_idx ON public.messages (tenant_id, initiated_by_user_id, dispatched_at)
  WHERE direction = 'outbound' AND initiator = 'human' AND NOT imported AND dispatched_at IS NOT NULL AND bulk_action_id IS NULL;

-- e) stored rollup days that counted a bulk send (rolled with the old filter): marked dirty, so the read path
--    computes them live (with the new filter) until the job re-rolls them and clears the marks. Only days that
--    are rolled and hold such a send, in the zone they were rolled in.
INSERT INTO public.scoreboard_rollup_dirty (tenant_id, day)
SELECT r.tenant_id, r.day
  FROM public.scoreboard_rollup_days r
 WHERE EXISTS (SELECT 1 FROM public.messages m
                WHERE m.tenant_id = r.tenant_id AND m.bulk_action_id IS NOT NULL
                  AND m.direction = 'outbound' AND m.initiator = 'human' AND NOT m.imported AND m.initiated_by_user_id IS NOT NULL
                  AND m.dispatched_at >= (r.day::timestamp AT TIME ZONE r.zone)
                  AND m.dispatched_at < ((r.day + 1)::timestamp AT TIME ZONE r.zone));

-- -----------------------------------------------------------------------------
-- 2. Parity detail tables read through the inlined helper (USING only)
-- -----------------------------------------------------------------------------
-- 0021 wrote these SELECT policies with app.contact_detail_visible(tenant_id, contact_id), which Postgres
-- never inlines: for a TC every tag, custom value, stage event, relationship and bulk item row rebuilt the
-- TC's deal-contact set (about 13 ms per row for a TC with 6,000 deal-contact ids, the 250k shape: 2.6-3.3 s
-- for 200 tag rows, against the 3 s list statement timeout; 16-36 ms after). Same rewrite as 0031: EXISTS over
-- the set-returning twin.
ALTER POLICY contact_tags_select ON public.contact_tags USING (
  EXISTS (SELECT 1 FROM app.contact_detail_row(contact_tags.tenant_id, contact_tags.contact_id)));
ALTER POLICY contact_field_values_select ON public.contact_field_values USING (
  EXISTS (SELECT 1 FROM app.contact_detail_row(contact_field_values.tenant_id, contact_field_values.contact_id)));
ALTER POLICY contact_stage_events_select ON public.contact_stage_events USING (
  EXISTS (SELECT 1 FROM app.contact_detail_row(contact_stage_events.tenant_id, contact_stage_events.contact_id)));
-- a relationship exists for a viewer only when both people's detail is visible to them
ALTER POLICY contact_relationships_select ON public.contact_relationships USING (
  EXISTS (SELECT 1 FROM app.contact_detail_row(contact_relationships.tenant_id, contact_relationships.contact_id))
  AND EXISTS (SELECT 1 FROM app.contact_detail_row(contact_relationships.tenant_id, contact_relationships.related_contact_id)));
-- an item is read through a visible action AND only for a person the reader sees
ALTER POLICY bulk_action_items_select ON public.bulk_action_items USING (
  EXISTS (SELECT 1 FROM public.bulk_actions b WHERE b.tenant_id = bulk_action_items.tenant_id AND b.id = bulk_action_items.bulk_action_id)
  AND EXISTS (SELECT 1 FROM app.contact_detail_row(bulk_action_items.tenant_id, bulk_action_items.contact_id)));
-- (mail_messages_select, the D2 table with the same per-row shape, is left to the pending D2 review migration,
--  which reorders it and pins its text in its own smoke test; it has no read route yet.)

-- -----------------------------------------------------------------------------
-- 3. Feed marks
-- -----------------------------------------------------------------------------
-- contacts: the old and the new owner and offeree of every inserted or updated row; and, when a row's
-- ownership or visibility changed, everyone else who holds a card on that contact (workspace/repos/feedInputs.ts:
-- tasks are read by assignee, appointments by user and assistant actions by owner, whatever the contact's
-- owner; materializeFeed writes such a card only while its contact is visible to the member, and GET's total
-- counts the visible ones). Looked up under the writer's RLS, like the owner lookups below.
CREATE OR REPLACE FUNCTION app.feed_mark_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, u.user_id, 'c:' || n.id
      FROM new_rows n CROSS JOIN LATERAL (VALUES (n.owner_user_id), (n.offered_to_user_id)) u(user_id)
     WHERE u.user_id IS NOT NULL;
  ELSE
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, u.user_id, 'c:' || n.id
      FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
     CROSS JOIN LATERAL (VALUES (o.owner_user_id), (o.offered_to_user_id), (n.owner_user_id), (n.offered_to_user_id)) u(user_id)
     WHERE u.user_id IS NOT NULL;
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT h.tenant_id, h.user_id, 'c:' || h.contact_id
      FROM (SELECT n.tenant_id, n.id FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
             WHERE (o.owner_user_id, o.offered_to_user_id, o.ownership_state, o.pond_id, o.deleted_at, o.merged_into_contact_id)
                   IS DISTINCT FROM (n.owner_user_id, n.offered_to_user_id, n.ownership_state, n.pond_id, n.deleted_at, n.merged_into_contact_id)) c
     CROSS JOIN LATERAL (
       SELECT t.tenant_id, t.assignee_user_id AS user_id, t.contact_id FROM public.tasks t
        WHERE t.tenant_id = c.tenant_id AND t.contact_id = c.id AND t.status = 'open' AND t.assignee_user_id IS NOT NULL
       UNION ALL
       SELECT a.tenant_id, a.user_id, a.contact_id FROM public.appointments a
        WHERE a.tenant_id = c.tenant_id AND a.contact_id = c.id AND a.status IN ('scheduled','held') AND a.outcome_logged_at IS NULL
          AND a.user_id IS NOT NULL
       UNION ALL
       SELECT x.tenant_id, x.owner_user_id, x.contact_id FROM public.assistant_actions x
        WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.id AND x.status = 'proposed' AND x.owner_user_id IS NOT NULL) h;
  END IF;
  RETURN NULL;
END $$;
-- the open appointments of a contact (the lookup above; appointments had no contact index)
CREATE INDEX appointments_open_contact_idx ON public.appointments (tenant_id, contact_id)
  WHERE contact_id IS NOT NULL AND status IN ('scheduled','held') AND outcome_logged_at IS NULL;

-- rows of a contact that reach its owner's feed: messages, calls, ownership events (re-inquiries), saved
-- searches, contact points (channel hints). The owner is looked up under the writer's RLS. A deleted contact
-- point (an import revert removes the points it added) changes the channel hints too.
CREATE OR REPLACE FUNCTION app.feed_mark_contact_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT c.tenant_id, c.owner_user_id, 'c:' || c.id
      FROM (SELECT DISTINCT tenant_id, contact_id FROM new_rows WHERE contact_id IS NOT NULL) n
      JOIN public.contacts c ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
     WHERE c.owner_user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT c.tenant_id, c.owner_user_id, 'c:' || c.id
      FROM (SELECT tenant_id, contact_id FROM new_rows UNION SELECT tenant_id, contact_id FROM old_rows) n
      JOIN public.contacts c ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
     WHERE c.owner_user_id IS NOT NULL;
  ELSE
    -- DELETE: only the old rows exist (when the contact itself was deleted, the join finds nothing)
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT c.tenant_id, c.owner_user_id, 'c:' || c.id
      FROM (SELECT DISTINCT tenant_id, contact_id FROM old_rows WHERE contact_id IS NOT NULL) o
      JOIN public.contacts c ON c.tenant_id = o.tenant_id AND c.id = o.contact_id
     WHERE c.owner_user_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_del AFTER DELETE ON public.contact_points REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_contact_rows();

-- tasks: the old and new assignee; the task's contact group, or its own group without a contact (0034, qualified)
CREATE OR REPLACE FUNCTION app.feed_mark_tasks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, assignee_user_id, CASE WHEN contact_id IS NULL THEN 't:' || id ELSE 'c:' || contact_id END
      FROM new_rows WHERE assignee_user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, assignee_user_id, CASE WHEN contact_id IS NULL THEN 't:' || id ELSE 'c:' || contact_id END
      FROM (SELECT tenant_id, id, assignee_user_id, contact_id FROM new_rows UNION SELECT tenant_id, id, assignee_user_id, contact_id FROM old_rows) x
     WHERE assignee_user_id IS NOT NULL;
  ELSE
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, assignee_user_id, CASE WHEN contact_id IS NULL THEN 't:' || id ELSE 'c:' || contact_id END
      FROM old_rows WHERE assignee_user_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;

-- appointments: the old and new user; the contact group, or the appointment's own group (0034, qualified)
CREATE OR REPLACE FUNCTION app.feed_mark_appointments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, user_id, CASE WHEN contact_id IS NULL THEN 'a:' || id ELSE 'c:' || contact_id END FROM new_rows WHERE user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, user_id, CASE WHEN contact_id IS NULL THEN 'a:' || id ELSE 'c:' || contact_id END
      FROM (SELECT tenant_id, id, user_id, contact_id FROM new_rows UNION SELECT tenant_id, id, user_id, contact_id FROM old_rows) x WHERE user_id IS NOT NULL;
  ELSE
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, user_id, CASE WHEN contact_id IS NULL THEN 'a:' || id ELSE 'c:' || contact_id END FROM old_rows WHERE user_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;

-- assistant actions (handbacks, drafts): the old and new owner, on the action's contact (0034, qualified)
CREATE OR REPLACE FUNCTION app.feed_mark_actions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, owner_user_id, 'c:' || contact_id FROM new_rows WHERE owner_user_id IS NOT NULL AND contact_id IS NOT NULL;
  ELSE
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, owner_user_id, 'c:' || contact_id
      FROM (SELECT tenant_id, owner_user_id, contact_id FROM new_rows UNION SELECT tenant_id, owner_user_id, contact_id FROM old_rows) x
     WHERE owner_user_id IS NOT NULL AND contact_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;

-- claims (a draft's "check this", a promise's evidence, a proposed search's unchecked criteria) (0034, qualified)
CREATE OR REPLACE FUNCTION app.feed_mark_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
  SELECT DISTINCT x.tenant_id, x.user_id, x.g FROM (
    SELECT a.tenant_id, a.owner_user_id AS user_id, 'c:' || a.contact_id AS g
      FROM new_rows n JOIN public.assistant_actions a ON a.tenant_id = n.tenant_id AND a.id = n.action_id
     WHERE a.owner_user_id IS NOT NULL AND a.contact_id IS NOT NULL
    UNION ALL
    SELECT t.tenant_id, t.assignee_user_id, CASE WHEN t.contact_id IS NULL THEN 't:' || t.id ELSE 'c:' || t.contact_id END
      FROM new_rows n JOIN public.tasks t ON t.tenant_id = n.tenant_id AND t.source_claim_id = n.id
     WHERE t.assignee_user_id IS NOT NULL
    UNION ALL
    SELECT c.tenant_id, c.owner_user_id, 'c:' || c.id
      FROM new_rows n JOIN public.saved_searches s ON s.tenant_id = n.tenant_id AND s.proposed_by_action_id = n.action_id
      JOIN public.contacts c ON c.tenant_id = s.tenant_id AND c.id = s.contact_id
     WHERE c.owner_user_id IS NOT NULL) x;
  RETURN NULL;
END $$;

-- deal dates: the deal's owner and members, for each date of the changed deal / date / membership; and the
-- people of a deal: a person added to or removed from it, or a new primary person, is gained or lost by the
-- deal's members (app.my_deal_contact_ids), so their cards on that person (a TC's task) are re-scored.
CREATE OR REPLACE FUNCTION app.feed_mark_deal_dates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'deal_dates' THEN
    IF TG_OP = 'DELETE' THEN
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT d.tenant_id, u.user_id, 'd:' || o.id FROM old_rows o JOIN public.deals d ON d.tenant_id = o.tenant_id AND d.id = o.deal_id
       CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
       WHERE u.user_id IS NOT NULL;
    ELSE
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT d.tenant_id, u.user_id, 'd:' || n.id FROM new_rows n JOIN public.deals d ON d.tenant_id = n.tenant_id AND d.id = n.deal_id
       CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
       WHERE u.user_id IS NOT NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'deals' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT dd.tenant_id, u.user_id, 'd:' || dd.id
      FROM (SELECT tenant_id, id, owner_user_id FROM new_rows UNION SELECT tenant_id, id, owner_user_id FROM old_rows) d
      JOIN public.deal_dates dd ON dd.tenant_id = d.tenant_id AND dd.deal_id = d.id
     CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
     WHERE u.user_id IS NOT NULL;
    -- a new primary person: the old and the new one, for the deal's owner and members
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, u.user_id, 'c:' || p.contact_id
      FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
     CROSS JOIN LATERAL (VALUES (o.primary_contact_id), (n.primary_contact_id)) p(contact_id)
     CROSS JOIN LATERAL (SELECT n.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = n.tenant_id AND dm.deal_id = n.id) u(user_id)
     WHERE o.primary_contact_id IS DISTINCT FROM n.primary_contact_id AND p.contact_id IS NOT NULL AND u.user_id IS NOT NULL;
  ELSIF TG_TABLE_NAME = 'deal_contacts' THEN
    IF TG_OP = 'DELETE' THEN
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT d.tenant_id, u.user_id, 'c:' || o.contact_id FROM old_rows o JOIN public.deals d ON d.tenant_id = o.tenant_id AND d.id = o.deal_id
       CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
       WHERE u.user_id IS NOT NULL;
    ELSE
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT d.tenant_id, u.user_id, 'c:' || n.contact_id FROM new_rows n JOIN public.deals d ON d.tenant_id = n.tenant_id AND d.id = n.deal_id
       CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
       WHERE u.user_id IS NOT NULL;
    END IF;
  ELSE -- deal_members: the member joining or leaving (the deal's dates, and its contacts: deal visibility)
    IF TG_OP = 'DELETE' THEN
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT x.tenant_id, x.user_id, x.g FROM (
        SELECT dd.tenant_id, o.user_id, 'd:' || dd.id AS g FROM old_rows o JOIN public.deal_dates dd ON dd.tenant_id = o.tenant_id AND dd.deal_id = o.deal_id
        UNION ALL SELECT dc.tenant_id, o.user_id, 'c:' || dc.contact_id FROM old_rows o JOIN public.deal_contacts dc ON dc.tenant_id = o.tenant_id AND dc.deal_id = o.deal_id
        UNION ALL SELECT d.tenant_id, o.user_id, 'c:' || d.primary_contact_id FROM old_rows o JOIN public.deals d ON d.tenant_id = o.tenant_id AND d.id = o.deal_id
         WHERE d.primary_contact_id IS NOT NULL) x
       WHERE EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = x.tenant_id AND m.user_id = x.user_id);
    ELSE
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT x.tenant_id, x.user_id, x.g FROM (
        SELECT dd.tenant_id, n.user_id, 'd:' || dd.id AS g FROM new_rows n JOIN public.deal_dates dd ON dd.tenant_id = n.tenant_id AND dd.deal_id = n.deal_id
        UNION ALL SELECT dc.tenant_id, n.user_id, 'c:' || dc.contact_id FROM new_rows n JOIN public.deal_contacts dc ON dc.tenant_id = n.tenant_id AND dc.deal_id = n.deal_id
        UNION ALL SELECT d.tenant_id, n.user_id, 'c:' || d.primary_contact_id FROM new_rows n JOIN public.deals d ON d.tenant_id = n.tenant_id AND d.id = n.deal_id
         WHERE d.primary_contact_id IS NOT NULL) x;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_ins AFTER INSERT ON public.deal_contacts REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();
CREATE TRIGGER feed_mark_del AFTER DELETE ON public.deal_contacts REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();

-- opt-outs and suppressions (channel hints): every owner of a contact with that address (0034, qualified)
CREATE OR REPLACE FUNCTION app.feed_mark_address() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
  SELECT DISTINCT c.tenant_id, c.owner_user_id, 'c:' || c.id
    FROM (SELECT DISTINCT tenant_id, address_hmac FROM new_rows) n
    JOIN public.contact_points p ON p.tenant_id = n.tenant_id AND p.address_hmac = n.address_hmac
    JOIN public.contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
   WHERE c.owner_user_id IS NOT NULL;
  RETURN NULL;
END $$;

-- visibility changes of one member: a role or status change, a team move, a collaboration: whole book. A team
-- move also changes what the team's leads see (app.my_team_member_ids): they get a whole-book recompute too.
-- (The tenant_settings branch of 0034 is gone: the zone has its own trigger below.)
CREATE OR REPLACE FUNCTION app.feed_mark_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key) SELECT DISTINCT o.tenant_id, o.user_id, '!full' FROM old_rows o
     WHERE EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = o.tenant_id AND m.user_id = o.user_id);
    IF TG_TABLE_NAME = 'team_members' THEN
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT l.tenant_id, l.user_id, '!full'
        FROM (SELECT DISTINCT tenant_id, team_id FROM old_rows) o
        JOIN public.team_members l ON l.tenant_id = o.tenant_id AND l.team_id = o.team_id AND l.is_lead;
    END IF;
  ELSE
    INSERT INTO public.feed_dirty (tenant_id, user_id, group_key) SELECT DISTINCT n.tenant_id, n.user_id, '!full' FROM new_rows n;
    IF TG_TABLE_NAME = 'team_members' AND TG_OP = 'INSERT' THEN
      INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT l.tenant_id, l.user_id, '!full'
        FROM (SELECT DISTINCT tenant_id, team_id FROM new_rows) n
        JOIN public.team_members l ON l.tenant_id = n.tenant_id AND l.team_id = n.team_id AND l.is_lead;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- the tenant's zone (every contract date and appointment window): the only setting the feed reads
-- (feedInputs.ts reads tenant_settings.default_timezone and nothing else). Row level, because Postgres refuses
-- a column list on a trigger with transition tables; the WHEN skips a write that re-saves the same zone.
CREATE FUNCTION app.feed_mark_tenant_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
  SELECT m.tenant_id, m.user_id, '!full' FROM public.memberships m WHERE m.tenant_id = NEW.tenant_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.feed_mark_tenant_zone() FROM PUBLIC;
DROP TRIGGER feed_mark_upd ON public.tenant_settings;
CREATE TRIGGER feed_mark_zone AFTER UPDATE OF default_timezone ON public.tenant_settings
  FOR EACH ROW WHEN (OLD.default_timezone IS DISTINCT FROM NEW.default_timezone)
  EXECUTE FUNCTION app.feed_mark_tenant_zone();

-- -----------------------------------------------------------------------------
-- 4. Self-checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := ''; r record; txt text := '';
BEGIN
  -- 1. the replaced definers keep their reviewed owner, pinned search_path and grants, and exclude bulk sends
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('app.scoreboard_activity(uuid[],timestamptz,timestamptz)'::regprocedure,
                              'app.scoreboard_rollup_roll(integer,integer)'::regprocedure, 'app.scoreboard_mark_messages()'::regprocedure)
                AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                     OR has_function_privilege('public', p.oid, 'EXECUTE')
                     OR position('bulk_action_id IS NULL' IN p.prosrc) = 0)) THEN
    bad := bad || ' scoreboard_definer';
  END IF;
  IF NOT has_function_privilege('app_user', 'app.scoreboard_activity(uuid[],timestamptz,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('app_user', 'app.scoreboard_rollup_roll(integer,integer)', 'EXECUTE')
     OR has_function_privilege('app_user', 'app.scoreboard_mark_messages()', 'EXECUTE') THEN
    bad := bad || ' scoreboard_grants';
  END IF;
  -- 2. the five parity policies read through the helper; their tables' other policies are unchanged
  SELECT string_agg(format('%s.%s', v.t, v.p), ',') INTO txt
    FROM (VALUES ('contact_tags','contact_tags_select'), ('contact_field_values','contact_field_values_select'),
                 ('contact_stage_events','contact_stage_events_select'), ('contact_relationships','contact_relationships_select'),
                 ('bulk_action_items','bulk_action_items_select')) v(t, p)
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies x WHERE x.schemaname = 'public' AND x.tablename = v.t AND x.policyname = v.p
                        AND x.cmd = 'SELECT' AND x.qual LIKE '%app.contact_detail_row(%' AND x.qual NOT LIKE '%contact_detail_visible%');
  IF txt IS NOT NULL THEN bad := bad || ' parity_policy:' || txt; END IF;
  txt := NULL;
  SELECT string_agg(format('%s.%s', x.tablename, x.policyname), ',') INTO txt
    FROM pg_policies x
   WHERE x.schemaname = 'public' AND x.tablename IN ('contact_tags','contact_field_values','contact_relationships','bulk_action_items')
     AND x.cmd IN ('INSERT','UPDATE','DELETE') AND x.policyname NOT LIKE 'support_read_only%' AND x.policyname <> 'tenant_isolation'
     AND COALESCE(x.qual, '') || COALESCE(x.with_check, '') LIKE '%contact_detail_row%';
  IF txt IS NOT NULL THEN bad := bad || ' write_policy_changed:' || txt; END IF;
  -- 3. inlined: a policy-shaped EXISTS over a parity table plans the contacts scan, never a Function Scan
  txt := '';
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) SELECT 1 FROM public.contact_tags t '
                   'WHERE EXISTS (SELECT 1 FROM app.contact_detail_row(t.tenant_id, t.contact_id))' LOOP
    txt := txt || r."QUERY PLAN" || E'\n';
  END LOOP;
  IF txt LIKE '%Function Scan%' OR txt NOT LIKE '%contacts%' THEN bad := bad || ' not_inlined'; END IF;
  -- 4. the feed functions stay invoker, and no function names feed_dirty without its schema
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'app' AND p.proname LIKE 'feed\_%' AND p.prosecdef) THEN
    bad := bad || ' feed_definer';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ',') INTO txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app','auth','portal','public') AND p.prosrc ~* '(into|from|join|update)\s+feed_dirty\M';
  IF txt IS NOT NULL THEN bad := bad || ' unqualified_feed_dirty:' || txt; END IF;
  -- 5. the marks this migration adds exist, and a settings write other than the zone marks nothing
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.contact_points'::regclass AND tgname = 'feed_mark_del')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.deal_contacts'::regclass AND tgname = 'feed_mark_ins')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.deal_contacts'::regclass AND tgname = 'feed_mark_del')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.tenant_settings'::regclass AND tgname = 'feed_mark_zone')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.tenant_settings'::regclass AND tgname = 'feed_mark_upd') THEN
    bad := bad || ' feed_triggers';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (scale review fixes):%', bad;
  END IF;
END $$;
