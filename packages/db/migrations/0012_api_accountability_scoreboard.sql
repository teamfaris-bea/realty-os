-- 0012 (BUILD_PLAN module 15, api/accountability): scoreboard aggregates for a member's own numbers.
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): two new SECURITY DEFINER reads. No new table, no policy change.
--
-- Why: R-ACC-4 says agents see their own scoreboard and Team Leads their team's. The invoker views
-- v_speed_to_lead and v_agent_activity_daily read the ledger, messages and calls under the CALLER's RLS,
-- which follows contact visibility. A lead an agent missed and that was then auto-released or reassigned
-- is no longer visible to them (R-PERM-7), so their own speed-to-lead and touch counts would silently drop
-- the periods they missed and the touches they made on leads that moved on: the numbers would look better
-- than they are (A2 genuineness, "every number shows its denominator"). These functions return the
-- caller's own (or their team's) numbers whatever happened to the contacts since.
--
-- What they return: per user, timings and counts only. No contact id, no name, no address, no body.
--   app.scoreboard_speed     one row per SLA ownership period: user, owned_at, due, first human touch
--   app.scoreboard_activity  one row per user: counts of touches, appointments set/held/due, agreements
-- Who may ask about whom: tenant-wide callers (Owner/Admin, system, support read) about anyone; a Team
-- Lead about members of a team they lead; everyone else only about themselves. Ids outside that set are
-- silently dropped (no existence oracle: memberships are readable by every member anyway). Without tenant
-- context (app.tenant_id() NULL) both return no rows.
--
-- Definitions (the same as the 0001 views, plus the R-IMPORT-6 exclusions spelled out):
--   speed-to-lead   ledger periods offer_accepted/claimed/assigned/reassigned with a first-touch deadline
--                   (imports and self-created contacts start no SLA, R-OWN-13/19); the first touch is the
--                   period's first_touch_recorded before the lead moved on (only a human touch writes it,
--                   R-OWN-14, R-AST-15).
--   touches         human outbound texts/emails that passed the send-time gate (TX1 stamped dispatched_at;
--                   a later provider failure does not undo the touch, R-OWN-14) plus human outbound calls
--                   (a calls row exists only after the dial-time gate allowed it). Never imported, never
--                   assistant or system messages (R-AST-15, R-IMPORT-6).
--   appointments    set: created by a person in the range; held: status held, starting in the range;
--                   due: started in the range (up to now), not canceled or rescheduled (the denominator of
--                   held). Imported appointments never count (R-IMPORT-6).
--   agreements      deal stage changes to agreement_signed in the range, credited to the deal owner.

CREATE FUNCTION app.scoreboard_allowed_users(p_user_ids uuid[])
RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT u.user_id
    FROM unnest(p_user_ids) AS u(user_id)
    JOIN public.memberships m ON m.tenant_id = app.tenant_id() AND m.user_id = u.user_id
   WHERE app.tenant_id() IS NOT NULL AND app.is_member()
     AND (app.is_tenant_wide()
          OR u.user_id = app.user_id()
          OR (app.my_role() = 'team_lead' AND u.user_id = ANY (app.my_team_member_ids())))
$$;

CREATE FUNCTION app.scoreboard_speed(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (user_id uuid, owned_at timestamptz, first_touch_due_at timestamptz, first_touch_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.owner_user_id, e.occurred_at, e.deadline_at, ft.occurred_at
    FROM public.lead_ownership_events e
    LEFT JOIN LATERAL (
      SELECT f.occurred_at FROM public.lead_ownership_events f
       WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq
         AND f.type = 'first_touch_recorded'
         AND NOT EXISTS (SELECT 1 FROM public.lead_ownership_events x
                          WHERE x.tenant_id = e.tenant_id AND x.contact_id = e.contact_id
                            AND x.seq > e.seq AND x.seq < f.seq
                            AND x.type IN ('reassigned','released','auto_released','inactivity_released','sent_to_pond',
                                           'closed','merged_away','claimed','assigned','offer_accepted'))
       ORDER BY f.seq LIMIT 1) ft ON true
   WHERE e.tenant_id = app.tenant_id()
     AND e.owner_user_id IN (SELECT a.user_id FROM app.scoreboard_allowed_users(p_user_ids) a)
     AND e.type IN ('offer_accepted','claimed','assigned','reassigned') AND e.deadline_at IS NOT NULL
     AND e.actor_kind <> 'import'
     AND e.occurred_at >= p_from AND e.occurred_at < p_to
$$;

CREATE FUNCTION app.scoreboard_activity(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
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
             AND m.dispatched_at IS NOT NULL AND m.dispatched_at >= p_from AND m.dispatched_at < p_to),
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

ALTER FUNCTION app.scoreboard_allowed_users(uuid[]) OWNER TO app_definer;
ALTER FUNCTION app.scoreboard_speed(uuid[], timestamptz, timestamptz) OWNER TO app_definer;
ALTER FUNCTION app.scoreboard_activity(uuid[], timestamptz, timestamptz) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.scoreboard_allowed_users(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.scoreboard_speed(uuid[], timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.scoreboard_activity(uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scoreboard_allowed_users(uuid[]) TO app_user;
GRANT EXECUTE ON FUNCTION app.scoreboard_speed(uuid[], timestamptz, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION app.scoreboard_activity(uuid[], timestamptz, timestamptz) TO app_user;

-- Touch counts per sender (the 0001 indexes key messages by contact, not by the human who sent them).
CREATE INDEX messages_human_touch_idx ON messages (tenant_id, initiated_by_user_id, dispatched_at)
  WHERE direction = 'outbound' AND initiator = 'human';
