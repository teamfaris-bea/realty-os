-- Batch 19, team-queue lane, review fixes (handoff visibility; findings M1 to M5 and L1 to L7 of the independent
-- review of draft pull request 15). DATA_MODEL R-TEAMQ-19 onward. Security notes: docs/ARCHITECTURE.md §21.74.
--
--   1. (M1, R-TEAMQ-20) lead_ownership_events.type gains 'sla_restored'. The waiver of a covered source's
--      auto-release (0107's `sla_waived`, which clears the stored release deadline) is re-evaluated, not one-shot:
--      when the source stops being covered, or the lead's own owner stops being an active member, the system writes
--      `sla_restored` with a NEW release deadline (payload.releaseDueAt) for the same ownership period, and the
--      ordinary `ownership.auto_release` timer decides at that time. contacts.release_due_at is set again by the
--      projection, so app.due_work (the sweeper) re-issues a lost timer as for any stored deadline. The ledger stays
--      append-only: no event is changed or removed, and no existing row has the new type.
--   2. (M2, R-TEAMQ-21) lead_backup_alerts: a waiting lead from a covered source always tells someone other than the
--      person already holding it. recipient gains 'admins' (the team's Owners and Admins, alerted when there is no
--      team lead to tell); fallback_reason says why it was not the named backup ('backup_unavailable', or
--      'backup_is_holder': the backup is the person holding the lead); alerted_count is how many members were alerted
--      (alerted_user_id stays the one member for 'backup' and 'team_lead', and is the first of them for 'admins':
--      each alerted member has their own notification row, keyed on the inquiry). Codes and a number only.
--   3. (M5, R-TEAMQ-23) a first touch made by the source's BACKUP is not the owner's response. The ledger is
--      unchanged (it already records who made the first touch); what reads it now says whose it was:
--      * v_speed_to_lead (security_invoker as before) gains first_touch_user_id and first_touch_by_backup; for a
--        period first touched by the backup, response_seconds is NULL and within_sla is false (first_touch_at still
--        says when the lead was first touched). "By the backup" is the response report's own rule (R-TEAMQ-18): the
--        first touch was made by someone other than the period's owner, who had been alerted as the `backup` of an
--        inquiry of that person at or before the touch (lead_backup_alerts: written once, never changed).
--      * app.scoreboard_backup_first_touches(user ids, from, to): the scoreboard's periods (app.scoreboard_speed's
--        own rows: the member rule, the range, the period and its window are the same) whose first touch the backup
--        made. SECURITY REVIEW ITEM: one NEW SECURITY DEFINER function, owner app_definer, search_path pinned to
--        pg_catalog, public, EXECUTE revoked from PUBLIC and granted to app_user. Like app.scoreboard_speed it
--        returns timings only (a member id the caller may already see on the scoreboard, and two instants): no
--        contact id, no inquiry, no alert row, and only for the members app.scoreboard_allowed_users admits.
--        app.scoreboard_speed, app.scoreboard_rollup_roll and the daily rollup are NOT replaced: the scoreboard read
--        marks its rows from this function, so rolled days stay exactly what they were.
--      * lead_backup_alerts_backup_idx: the alerted-backup rows of a tenant, which that function starts from.
--        One grant: SELECT on lead_backup_alerts to app_definer (the NOLOGIN definer role that owns that function;
--        0001 granted it SELECT on the tables that existed then, and this table is newer). app_user's grants on the
--        table are unchanged (SELECT, INSERT; never UPDATE or DELETE).
--   4. (L7, R-TEAMQ-28) contact_collaborators_backup_time_boxed: a `backup` collaborator row always has an expiry.
--      The alerted backup's access is time-boxed by construction (0108); this makes it a rule of the database, so no
--      path can turn a `backup` row permanent. A person's manual share of that member writes another role (isa, tc,
--      co_agent: the API's own choices) with its own audit entry, which this check does not touch.
--   5. (review step 7, R-TEAMQ-29) lead_inquiries_source_arrival_idx (tenant_id, lead_source_id, created_at DESC):
--      the queue, the report and the alert sweep range on the one arrival instant (R-TEAMQ-19: the moment the inquiry
--      reached the team, lead_inquiries.created_at), per lead source. 0062's lead_inquiries_source_received_idx stays
--      for the readers of the source-claimed time (the sources overview).
--   No table, no policy and no retention change: the new columns of part 2 are read and written under
--   lead_backup_alerts' existing policies.

-- 1. the ledger's event types (0001's unnamed CHECK, found by its definition and replaced with the one more type)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.lead_ownership_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%sla_waived%' LOOP
    EXECUTE format('ALTER TABLE lead_ownership_events DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE lead_ownership_events ADD CONSTRAINT lead_ownership_events_type_check CHECK (type IN (
  'created','imported','offered','offer_accepted','offer_declined','offer_expired',
  'offer_rescinded','claimed','assigned','reassigned','released','sent_to_pond',
  'auto_released','reinquiry','first_touch_recorded','first_touch_breached','sla_waived','sla_restored',
  'inactivity_warned','inactivity_released','closed','reopened','merged_away','merged_in'));

-- Self-check: exactly one type check, and it admits both the waiver and its restoration.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.lead_ownership_events'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%sla_waived%' AND pg_get_constraintdef(oid) LIKE '%sla_restored%' AND convalidated) <> 1 THEN
    RAISE EXCEPTION '0109: lead_ownership_events needs one validated type check admitting sla_waived and sla_restored';
  END IF;
  IF EXISTS (SELECT 1 FROM lead_ownership_events WHERE type = 'sla_restored') THEN
    RAISE EXCEPTION '0109: no existing ledger event may have the new type';
  END IF;
END $$;

-- 2. who was alerted, and why it was not the backup
ALTER TABLE lead_backup_alerts DROP CONSTRAINT lead_backup_alerts_recipient_check;
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_recipient_check CHECK (recipient IN ('backup','team_lead','admins'));
ALTER TABLE lead_backup_alerts ADD COLUMN fallback_reason text CHECK (fallback_reason IN ('backup_unavailable','backup_is_holder'));
ALTER TABLE lead_backup_alerts ADD COLUMN alerted_count integer NOT NULL DEFAULT 0 CHECK (alerted_count >= 0);
UPDATE lead_backup_alerts SET alerted_count = 1 WHERE outcome = 'alerted';
UPDATE lead_backup_alerts SET fallback_reason = 'backup_unavailable' WHERE recipient = 'team_lead';
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_count_matches CHECK ((outcome = 'alerted') = (alerted_count >= 1));
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_reason_matches CHECK ((fallback_reason IS NOT NULL) = (recipient IN ('team_lead','admins')));
ALTER TABLE lead_backup_alerts ADD CONSTRAINT lead_backup_alerts_one_unless_admins CHECK (recipient = 'admins' OR alerted_count <= 1);
COMMENT ON COLUMN lead_backup_alerts.fallback_reason IS 'b19 R-TEAMQ-21: why someone other than the source''s named backup was alerted: backup_unavailable, or backup_is_holder (the backup is the person holding the lead). Null when the backup was alerted or nobody was.';
COMMENT ON COLUMN lead_backup_alerts.alerted_count IS 'b19 R-TEAMQ-21: how many members were alerted (several only for recipient admins: the team''s Owners and Admins). 0 unless outcome is alerted.';

-- Self-check: the recipient check admits admins; app_user still can neither change nor delete a row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lead_backup_alerts'::regclass AND conname = 'lead_backup_alerts_recipient_check'
                   AND pg_get_constraintdef(oid) LIKE '%admins%') THEN
    RAISE EXCEPTION '0109: lead_backup_alerts.recipient must admit admins';
  END IF;
  IF has_table_privilege('app_user', 'public.lead_backup_alerts', 'UPDATE') OR has_table_privilege('app_user', 'public.lead_backup_alerts', 'DELETE') THEN
    RAISE EXCEPTION '0109: app_user must not change or delete lead_backup_alerts rows';
  END IF;
END $$;

-- 3. a first touch by the backup is not the owner's response
CREATE INDEX lead_backup_alerts_backup_idx ON lead_backup_alerts (tenant_id, decided_at) WHERE outcome = 'alerted' AND recipient = 'backup';

-- v_speed_to_lead (0047's definition, its columns in the same order; two columns appended, and the owner's response
-- left empty when the backup made the first touch)
CREATE OR REPLACE VIEW v_speed_to_lead WITH (security_invoker = true) AS
  SELECT e.tenant_id, e.owner_user_id AS user_id, e.contact_id, e.seq AS owned_seq,
         e.occurred_at AS owned_at, e.deadline_at AS first_touch_due_at, ft.occurred_at AS first_touch_at,
         CASE WHEN ft.occurred_at IS NOT NULL AND NOT COALESCE(ft.by_backup, false) THEN EXTRACT(EPOCH FROM (ft.occurred_at - e.occurred_at))::bigint END AS response_seconds,
         (ft.occurred_at IS NOT NULL AND ft.occurred_at <= e.deadline_at AND NOT COALESCE(ft.by_backup, false)) AS within_sla,
         ft.actor_user_id AS first_touch_user_id,
         COALESCE(ft.by_backup, false) AS first_touch_by_backup
    FROM lead_ownership_events e
    LEFT JOIN LATERAL (
      SELECT f.occurred_at, f.actor_user_id,
             (f.actor_user_id IS DISTINCT FROM e.owner_user_id
              AND EXISTS (SELECT 1 FROM lead_backup_alerts a
                            JOIN lead_inquiries i ON i.tenant_id = a.tenant_id AND i.id = a.inquiry_id
                           WHERE a.tenant_id = e.tenant_id AND i.contact_id = e.contact_id AND a.outcome = 'alerted' AND a.recipient = 'backup'
                             AND a.alerted_user_id = f.actor_user_id AND a.decided_at <= f.occurred_at)) AS by_backup
        FROM lead_ownership_events f
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

-- The scoreboard's periods whose first touch the backup made. Starts from the tenant's alerted-backup rows (few),
-- finds the first touch that member made on that person at or after the alert, and the SLA period it belongs to by
-- app.scoreboard_speed's own rule (0047): the period's first probe event is that first touch.
CREATE FUNCTION app.scoreboard_backup_first_touches(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (user_id uuid, owned_at timestamptz, first_touch_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT e.owner_user_id, e.occurred_at, f.occurred_at
    FROM public.lead_backup_alerts a
    JOIN public.lead_inquiries i ON i.tenant_id = a.tenant_id AND i.id = a.inquiry_id
    JOIN public.lead_ownership_events f ON f.tenant_id = a.tenant_id AND f.contact_id = i.contact_id
         AND f.type = 'first_touch_recorded' AND f.actor_user_id = a.alerted_user_id AND f.occurred_at >= a.decided_at
         AND f.actor_user_id IS DISTINCT FROM f.owner_user_id
    JOIN LATERAL (
      -- the SLA period the touch belongs to: the latest period start before it
      SELECT p.seq, p.owner_user_id, p.occurred_at, p.deadline_at, p.actor_kind FROM public.lead_ownership_events p
       WHERE p.tenant_id = f.tenant_id AND p.contact_id = f.contact_id AND p.seq < f.seq
         AND p.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry')
         AND (p.type <> 'reinquiry' OR p.payload @> '{"newPeriod": true}')
       ORDER BY p.seq DESC LIMIT 1) e ON true
   WHERE a.tenant_id = app.tenant_id() AND a.outcome = 'alerted' AND a.recipient = 'backup'
     AND e.deadline_at IS NOT NULL AND e.actor_kind <> 'import'
     AND e.owner_user_id = f.owner_user_id
     AND e.occurred_at >= p_from AND e.occurred_at < p_to
     AND e.owner_user_id IN (SELECT u.user_id FROM app.scoreboard_allowed_users(p_user_ids) u)
     -- nothing ended the period's window between its start and the touch (app.scoreboard_speed's probe)
     AND NOT EXISTS (SELECT 1 FROM public.lead_ownership_events x
                      WHERE x.tenant_id = f.tenant_id AND x.contact_id = f.contact_id AND x.seq > e.seq AND x.seq < f.seq
                        AND (x.type IN ('first_touch_recorded','reassigned','released','auto_released','inactivity_released','sent_to_pond',
                                        'closed','merged_away','claimed','assigned','offer_accepted')
                             OR (x.type = 'reinquiry' AND x.payload @> '{"newPeriod": true}')
                             OR x.to_state <> 'owned' OR x.owner_user_id IS DISTINCT FROM e.owner_user_id))
$$;
ALTER FUNCTION app.scoreboard_backup_first_touches(uuid[], timestamptz, timestamptz) OWNER TO app_definer;
GRANT SELECT ON lead_backup_alerts TO app_definer;
REVOKE ALL ON FUNCTION app.scoreboard_backup_first_touches(uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scoreboard_backup_first_touches(uuid[], timestamptz, timestamptz) TO app_user;

-- Self-check: the view is still an invoker with its nine columns in order and the two new ones last; the new function
-- is a definer owned by app_definer with a pinned path, not executable by PUBLIC.
DO $$
DECLARE p record;
BEGIN
  IF (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = 'public.v_speed_to_lead'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
     <> 'tenant_id,user_id,contact_id,owned_seq,owned_at,first_touch_due_at,first_touch_at,response_seconds,within_sla,first_touch_user_id,first_touch_by_backup' THEN
    RAISE EXCEPTION '0109: v_speed_to_lead columns changed unexpectedly';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.v_speed_to_lead'::regclass AND c.reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION '0109: v_speed_to_lead must stay security_invoker';
  END IF;
  SELECT pr.prosecdef, pr.proconfig, r.rolname INTO p FROM pg_proc pr JOIN pg_roles r ON r.oid = pr.proowner
   WHERE pr.oid = 'app.scoreboard_backup_first_touches(uuid[], timestamptz, timestamptz)'::regprocedure;
  IF NOT p.prosecdef OR p.rolname <> 'app_definer' OR p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, public') THEN
    RAISE EXCEPTION '0109: app.scoreboard_backup_first_touches must be a definer owned by app_definer with a pinned search_path';
  END IF;
  IF has_function_privilege('public', 'app.scoreboard_backup_first_touches(uuid[], timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '0109: app.scoreboard_backup_first_touches must not be executable by PUBLIC';
  END IF;
END $$;

-- 4. a backup grant is always time-boxed
ALTER TABLE contact_collaborators ADD CONSTRAINT contact_collaborators_backup_time_boxed CHECK (role <> 'backup' OR expires_at IS NOT NULL);

-- Self-check: the constraint is there and validated (no existing backup row was permanent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.contact_collaborators'::regclass AND conname = 'contact_collaborators_backup_time_boxed' AND convalidated) THEN
    RAISE EXCEPTION '0109: contact_collaborators_backup_time_boxed is missing';
  END IF;
END $$;

-- 5. inquiries by source and arrival
CREATE INDEX lead_inquiries_source_arrival_idx ON lead_inquiries (tenant_id, lead_source_id, created_at DESC);
