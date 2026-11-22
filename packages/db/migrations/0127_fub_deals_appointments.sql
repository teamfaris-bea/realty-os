-- 0127: Follow Up Boss deals and appointments are imported (owner reversal of B7, 2026-11-21).
-- Numbered after 0124 (tasks), 0125 (email) and 0126 (crm tokens).
-- Tasks stay count-only. Appointments and deals become import stages 7 and 8, after consent,
-- so a revert removes appointments before the deals they could name.
--
-- An imported appointment is live on the calendar but reminders_enabled is false until cutover
-- (nothing here sends a reminder; the flag is what a later sender must honor).
--
-- Commission rows are written by the import system. Humans still own every read and every later
-- edit (R-PERM-10): the new policy is INSERT-only for the tenant-wide system actor.

ALTER TABLE import_stages DROP CONSTRAINT import_stages_category_check;
ALTER TABLE import_stages ADD CONSTRAINT import_stages_category_check
  CHECK (category IN ('contacts','ownership','notes','messages','call_recordings','consent','deals','appointments'));

DO $$
DECLARE c name;
BEGIN
  SELECT con.conname INTO c
    FROM pg_constraint con
   WHERE con.conrelid = 'public.import_stages'::regclass
     AND pg_get_constraintdef(con.oid) LIKE '%consent%THEN 6%';
  IF c IS NULL THEN
    RAISE EXCEPTION 'import_stages seq check not found';
  END IF;
  EXECUTE format('ALTER TABLE public.import_stages DROP CONSTRAINT %I', c);
END $$;

ALTER TABLE import_stages ADD CONSTRAINT import_stages_seq_check
  CHECK (seq = CASE category
    WHEN 'contacts' THEN 1 WHEN 'ownership' THEN 2 WHEN 'notes' THEN 3
    WHEN 'messages' THEN 4 WHEN 'call_recordings' THEN 5 WHEN 'consent' THEN 6
    WHEN 'deals' THEN 7 WHEN 'appointments' THEN 8 END);

-- NOT VALID takes no exclusive lock and does not scan existing rows. VALIDATE then checks them
-- without blocking reads and writes the way a validating ADD CONSTRAINT would.
ALTER TABLE external_refs DROP CONSTRAINT external_refs_entity_type_check;
ALTER TABLE external_refs ADD CONSTRAINT external_refs_entity_type_check
  CHECK (entity_type IN ('contact','note','message','call','recording','user','deal','appointment')) NOT VALID;
ALTER TABLE external_refs VALIDATE CONSTRAINT external_refs_entity_type_check;

ALTER TABLE appointments ADD COLUMN reminders_enabled boolean NOT NULL DEFAULT true;

-- R-PERM-10 stays: a human Owner, Admin, the deal's agent, or their Team Lead can read and edit.
-- The import (system, tenant-wide, app.actor_via = import) may insert the row it just created
-- and cannot select it back. An assistant or any other system via cannot.
CREATE POLICY financials_import_insert ON deal_financials FOR INSERT
  WITH CHECK (
    (SELECT app.actor_kind()) = 'system'
    AND (SELECT app.is_tenant_wide())
    AND current_setting('app.actor_via', true) = 'import'
  );

-- deal_stage_history is append-only (app.reject_mutation). An imported deal's one history row was written by
-- the stage trigger, and the deal cannot be removed while it remains (no ON DELETE CASCADE). Only the
-- revert function may delete those rows, and only while it has set app.import_revert_history for this
-- transaction. Any other app_definer function still cannot.
CREATE OR REPLACE FUNCTION app.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'app_retention' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND current_user = 'app_definer' AND TG_TABLE_NAME = 'deal_stage_history'
     AND current_setting('app.import_revert_history', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'APPEND_ONLY: % on % rejected', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- SECURITY REVIEW ITEM (CONVENTIONS §4): replaces the body of app.import_revert_delete. Owner,
-- search_path, grants and signature are unchanged. Adds appointments and deals, deleted only when
-- an imported record of the reverting stage points at the row and the external ref is this batch's.
CREATE OR REPLACE FUNCTION app.import_revert_delete(p_stage_id uuid, p_table text, p_ids uuid[])
RETURNS SETOF uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_batch uuid;
  v_status text;
  v_id uuid;
  v_n integer;
  v_objects uuid[];
BEGIN
  IF app.tenant_id() IS NULL OR NOT app.is_tenant_wide() OR app.actor_kind() NOT IN ('user','system') THEN
    RAISE EXCEPTION 'IMPORT_REVERT_FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.batch_id, s.status INTO v_batch, v_status
    FROM public.import_stages s WHERE s.tenant_id = app.tenant_id() AND s.id = p_stage_id;
  IF v_batch IS NULL OR v_status <> 'reverting' THEN
    RAISE EXCEPTION 'IMPORT_STAGE_NOT_REVERTING' USING ERRCODE = 'check_violation';
  END IF;
  IF p_table NOT IN ('notes','messages','calls','contact_points','contact_addresses','appointments','deals') THEN
    RAISE EXCEPTION 'IMPORT_REVERT_TABLE' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[]) LOOP
    BEGIN
      IF p_table = 'notes' THEN
        DELETE FROM public.notes t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.imported
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.id = t.import_record_id AND r.stage_id = p_stage_id);
      ELSIF p_table = 'messages' THEN
        DELETE FROM public.messages t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.imported
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.id = t.import_record_id AND r.stage_id = p_stage_id);
      ELSIF p_table = 'calls' THEN
        SELECT array_agg(rc.object_id) INTO v_objects
          FROM public.recordings rc
         WHERE rc.tenant_id = app.tenant_id() AND rc.call_id = v_id AND rc.source = 'import_fub';
        DELETE FROM public.calls t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.imported
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.id = t.import_record_id AND r.stage_id = p_stage_id);
      ELSIF p_table = 'contact_points' THEN
        DELETE FROM public.contact_points t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.import_batch_id = v_batch;
      ELSIF p_table = 'contact_addresses' THEN
        DELETE FROM public.contact_addresses t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.import_batch_id = v_batch;
      ELSIF p_table = 'appointments' THEN
        DELETE FROM public.appointments t
         WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.created_by_kind = 'import'
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.stage_id = p_stage_id AND r.target_id = t.id)
           AND EXISTS (SELECT 1 FROM public.external_refs er WHERE er.tenant_id = t.tenant_id AND er.entity_type = 'appointment'
                          AND er.entity_id = t.id AND er.import_batch_id = v_batch);
      ELSE
        -- stage history does not cascade; the rest does, but delete them explicitly so a later
        -- restrict on one child cannot leave the others behind. A deal with later work stays:
        -- those rows do not bump deals.row_version, and appointments.deal_id / portal_grants.deal_id
        -- cascade, so deleting the deal would take them with it.
        v_n := 0;
        IF EXISTS (
          SELECT 1 FROM public.deals d
           WHERE d.tenant_id = app.tenant_id() AND d.id = v_id
             AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = d.tenant_id AND r.stage_id = p_stage_id AND r.target_id = d.id)
             AND EXISTS (SELECT 1 FROM public.external_refs er WHERE er.tenant_id = d.tenant_id AND er.entity_type = 'deal'
                            AND er.entity_id = d.id AND er.import_batch_id = v_batch)
             AND d.row_version = 1
             AND NOT EXISTS (SELECT 1 FROM public.notes n WHERE n.tenant_id = d.tenant_id AND n.deal_id = d.id AND NOT n.imported)
             AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.tenant_id = d.tenant_id AND t.deal_id = d.id AND t.created_by_kind <> 'import')
             AND NOT EXISTS (SELECT 1 FROM public.documents doc WHERE doc.tenant_id = d.tenant_id AND doc.deal_id = d.id)
             AND NOT EXISTS (SELECT 1 FROM public.deal_dates x WHERE x.tenant_id = d.tenant_id AND x.deal_id = d.id
                               AND (x.status <> 'proposed' OR x.source <> 'import'))
             AND NOT EXISTS (SELECT 1 FROM public.deal_financials f WHERE f.tenant_id = d.tenant_id AND f.deal_id = d.id AND f.updated_at > d.created_at)
             AND NOT EXISTS (
               SELECT 1 FROM public.deal_members m
                WHERE m.tenant_id = d.tenant_id AND m.deal_id = d.id
                  AND (m.role <> 'co_agent'
                       OR NOT EXISTS (
                         SELECT 1 FROM public.import_records r
                          WHERE r.tenant_id = d.tenant_id AND r.target_id = d.id
                            AND COALESCE(r.normalized->'memberUserIds', '[]'::jsonb) @> to_jsonb(m.user_id::text)))
             )
             AND NOT EXISTS (SELECT 1 FROM public.appointments a WHERE a.tenant_id = d.tenant_id AND a.deal_id = d.id)
             AND NOT EXISTS (SELECT 1 FROM public.portal_grants g WHERE g.tenant_id = d.tenant_id AND g.deal_id = d.id)
             AND NOT EXISTS (
               SELECT 1 FROM public.deal_contacts dc
                WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id
                  AND NOT EXISTS (
                    SELECT 1 FROM public.import_records r
                      JOIN public.external_refs er
                        ON er.tenant_id = r.tenant_id AND er.entity_type = 'contact' AND er.entity_id = dc.contact_id
                     WHERE r.tenant_id = d.tenant_id AND r.target_id = d.id
                       AND COALESCE(r.normalized->'people', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('personRef', er.external_id)))
             )
        ) THEN
          PERFORM set_config('app.import_revert_history', 'on', true);
          DELETE FROM public.deal_stage_history h WHERE h.tenant_id = app.tenant_id() AND h.deal_id = v_id;
          DELETE FROM public.deal_dates x WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id;
          -- only the parties the import wrote; a person added later is later work and the deal stays
          DELETE FROM public.deal_contacts x
           WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id
             AND EXISTS (
               SELECT 1 FROM public.import_records r
                 JOIN public.external_refs er
                   ON er.tenant_id = r.tenant_id AND er.entity_type = 'contact' AND er.entity_id = x.contact_id
                WHERE r.tenant_id = x.tenant_id AND r.target_id = v_id
                  AND COALESCE(r.normalized->'people', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('personRef', er.external_id)));
          DELETE FROM public.deal_members x WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id;
          DELETE FROM public.deal_financials x WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id;
          DELETE FROM public.deals d WHERE d.tenant_id = app.tenant_id() AND d.id = v_id;
          GET DIAGNOSTICS v_n = ROW_COUNT;
        END IF;
      END IF;
      IF p_table <> 'deals' THEN
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      IF v_n = 1 THEN
        IF p_table = 'calls' AND v_objects IS NOT NULL THEN
          UPDATE public.stored_objects o SET deleted_at = COALESCE(o.deleted_at, now())
           WHERE o.tenant_id = app.tenant_id() AND o.id = ANY (v_objects);
        END IF;
        RETURN NEXT v_id;
      END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      -- something now references the row: it stays for a human decision
      NULL;
    END;
  END LOOP;
  RETURN;
END $$;

ALTER FUNCTION app.import_revert_delete(uuid, text, uuid[]) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.import_revert_delete(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_revert_delete(uuid, text, uuid[]) TO app_user;
GRANT DELETE ON appointments, deals, deal_stage_history, deal_dates, deal_contacts, deal_members, deal_financials TO app_definer;

-- An imported deal's opening history row is stamped changed_at = now() by app.deals_stage_history, with
-- actor_kind system and from_stage null. Counting it would put a historical agreement on today's scoreboard.
-- A later stage change (from_stage set, or a person acting) still counts. Bodies otherwise match 0053.
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
             AND m.bulk_action_id IS NULL       -- R-PAR-37: a bulk send is never a touch
             AND m.marketing_piece_id IS NULL), -- b7 sends/F1 (R-MKT-8, R-OWN-14): nor is an open-house invite
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
             AND h.to_stage = 'agreement_signed' AND h.changed_at >= p_from AND h.changed_at < p_to
             AND NOT (h.actor_kind = 'system' AND h.from_stage IS NULL))
    FROM app.scoreboard_allowed_users(p_user_ids) a
$$;

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
  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':scoreboard_rollup', 0));
  SELECT ts.default_timezone INTO v_zone FROM public.tenant_settings ts WHERE ts.tenant_id = v_tenant;
  IF v_zone IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, 0, 0, NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO public.scoreboard_rollup_state (tenant_id, zone) VALUES (v_tenant, v_zone) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO v_state FROM public.scoreboard_rollup_state s WHERE s.tenant_id = v_tenant FOR UPDATE;
  IF v_state.zone IS DISTINCT FROM v_zone THEN
    UPDATE public.scoreboard_rollup_state s SET zone = v_zone, safe_until = NULL, pending_at = NULL, pending_xid = NULL, updated_at = now()
     WHERE s.tenant_id = v_tenant;
    v_safe := NULL;
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

  SELECT array_agg(m.id) INTO v_marks FROM public.scoreboard_rollup_dirty m WHERE m.tenant_id = v_tenant;

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
         AND m.bulk_action_id IS NULL
         AND m.marketing_piece_id IS NULL
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
         AND NOT (h.actor_kind = 'system' AND h.from_stage IS NULL)
    )
    INSERT INTO public.scoreboard_activity_daily (tenant_id, user_id, day, calls, texts_and_emails, appointments_set,
                                                  appointments_held, appointments_due, agreements_signed)
    SELECT v_tenant, x.user_id, x.day, sum(x.calls), sum(x.texts), sum(x.aset), sum(x.aheld), sum(x.adue), sum(x.agr)
      FROM counts x GROUP BY x.user_id, x.day;
    GET DIAGNOSTICS v_act = ROW_COUNT;

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

  DELETE FROM public.scoreboard_rollup_dirty m
   WHERE m.tenant_id = v_tenant AND m.id = ANY (COALESCE(v_marks, '{}'))
     AND (m.day = ANY (COALESCE(v_days, '{}')) OR m.day < v_first);
  GET DIAGNOSTICS v_clr = ROW_COUNT;

  DELETE FROM public.scoreboard_activity_daily a WHERE a.tenant_id = v_tenant AND a.day < v_first;
  DELETE FROM public.scoreboard_speed_daily s WHERE s.tenant_id = v_tenant AND s.day < v_first;
  DELETE FROM public.scoreboard_rollup_days r WHERE r.tenant_id = v_tenant AND r.day < v_first;

  RETURN QUERY SELECT COALESCE(array_length(v_days, 1), 0), v_act, v_spd, v_clr,
                      GREATEST(COALESCE(array_length(v_all, 1), 0) - COALESCE(array_length(v_days, 1), 0), 0), v_safe;
END $$;

ALTER FUNCTION app.scoreboard_activity(uuid[], timestamptz, timestamptz) OWNER TO app_definer;
ALTER FUNCTION app.scoreboard_rollup_roll(integer, integer) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.scoreboard_activity(uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.scoreboard_rollup_roll(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scoreboard_activity(uuid[], timestamptz, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION app.scoreboard_rollup_roll(integer, integer) TO app_user;
