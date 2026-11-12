-- =============================================================================
-- Batch 7 interaction review fixes, group "merges, sends and listings" (b7 sends/F1, sends/F2, ownership-data/F1).
-- The number is a placeholder: the orchestrator renumbers at merge, and nothing in code or tests names this file.
-- 0001-0052 are not edited. Every replaced function starts from its newest definition (named in each section) and
-- changes only the lines marked with its finding key.
--
-- 1. sends/F1 (R-MKT-8, R-OWN-14, R-PAR-37, D8): an open-house invite is never a touch. Invites are sent one email per
--    recipient through the human send path (module 29), up to 1000 at a time: a mass send in all but name. The API no
--    longer records them as the agent's first touch (comms/dispatch.ts), the waiting-client check skips them
--    (workspace/repos/feedInputs.ts), and here every scoreboard count that keeps a bulk send from being a person's
--    contact also skips marketing_piece_id rows: app.scoreboard_activity (0035), app.scoreboard_rollup_roll (0047)
--    and the rollup's dirty-day mark app.scoreboard_mark_messages (0035). Module 40's "touches" goal reads
--    app.scoreboard_activity, so it follows. The partial index the count scans is narrowed to match (0035 §1d), and
--    every rolled day that counted an invite is marked dirty (read live, now exact, until the job re-rolls it).
-- 2. sends/F2 (R-GATE-4, R-AST-7, R-NURT-1): a within_playbook message reaches dispatching only while its assistant
--    action is still 'proposed'. app.messages_dispatch_guard (0043 body) refuses anything else
--    (ASSISTANT_ACTION_WITHDRAWN); dispatch TX1 refuses it first with the same code and a sentence. A merge
--    invalidates the loser's autonomous actions (db/ownership/merge.ts), so a trigger message queued before the merge
--    is no longer sent; the merge also skips the loser's scheduled trigger firings.
-- 3. ownership-data/F1 (R-OWN-24, R-PAR-45, R-SELL-1, R-NURT-1): listing roles, deal roles and a deal's primary
--    person follow a merge, in the merge transaction, the way 0046 makes chat sessions follow. A new definer trigger
--    on contacts.merged_into_contact_id re-points listing_contacts, deal_contacts and deals.primary_contact_id from the
--    loser to the survivor, deduping on the primary keys: a listing role the survivor already holds keeps the
--    stronger of the two (seller > co_seller > interested); a deal role the survivor already holds is kept. So the
--    seller keeps getting seller updates (sellerContacts / HAS_SELLER), an "interested" person keeps their listing
--    alerts (nurture listingFollowers) and the anniversary of a closed deal fires for the survivor (closedDealsOn).
--    The open seller-update card of a listing whose seller moved says so (one honest sentence; the draft itself
--    holds no recipient, its recipients are the listing's sellers at send time). Records merged away before this
--    migration are moved the same way, to the root survivor of their merge chain (section 3b).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.16 "batch 7 review fixes, merges, sends and listings"):
--   * Four existing SECURITY DEFINER functions are replaced with CREATE OR REPLACE (same signatures, so every
--     trigger binding and grant stays) and re-asserted: owner app_definer, search_path pinned to pg_catalog, public,
--     EXECUTE revoked from PUBLIC; app.scoreboard_activity and app.scoreboard_rollup_roll executable by app_user as
--     before; the two trigger functions by nobody. Each only counts fewer rows or refuses more sends.
--   * New SECURITY DEFINER trigger function app.contacts_merge_roles() (owner app_definer, pinned search_path,
--     EXECUTE revoked from PUBLIC). It acts only for a row whose merged_into_contact_id the ownership engine's merge
--     just set, only inside that row's tenant, only on rows that name the merged-away record, and only towards the
--     survivor the merge chose. It moves no opt-out state, sends nothing and reveals nothing: who may read a listing
--     role, a deal role or a deal is unchanged (the existing policies judge the survivor as they judged the loser,
--     and the merge already made the survivor the person). Least-privilege grants to app_definer:
--     INSERT, DELETE, UPDATE (role) ON listing_contacts; INSERT, DELETE ON deal_contacts; UPDATE (primary_contact_id) ON deals;
--     UPDATE (reasons, updated_at) ON priority_feed_items. app_definer already reads all four (SELECT).
--   * No table, policy or app_user grant is added.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. sends/F1: an open-house invite is never a scoreboard touch
-- -----------------------------------------------------------------------------
-- a) the live counts (0035 body)
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
             AND h.to_stage = 'agreement_signed' AND h.changed_at >= p_from AND h.changed_at < p_to)
    FROM app.scoreboard_allowed_users(p_user_ids) a
$$;

-- b) the rollup's writer (0047 body)
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

    -- the same filters as app.scoreboard_activity (0012, with the R-PAR-37 bulk and the b7 invite exclusions), bucketed by the same day boundaries
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
         AND m.marketing_piece_id IS NULL   -- b7 sends/F1 (R-MKT-8, R-OWN-14): nor is an open-house invite
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

-- c) the dirty-day mark of a message (0035 body): an invite is counted on no day, so it marks none
CREATE OR REPLACE FUNCTION app.scoreboard_mark_messages() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.direction = 'outbound' AND OLD.initiator = 'human' AND NOT OLD.imported AND OLD.bulk_action_id IS NULL
     AND OLD.marketing_piece_id IS NULL THEN
    PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.dispatched_at);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.direction = 'outbound' AND NEW.initiator = 'human' AND NOT NEW.imported AND NEW.bulk_action_id IS NULL
     AND NEW.marketing_piece_id IS NULL THEN
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

-- d) the count stays an index-only scan (0035 §1d): same name and columns, the predicate narrowed by the invite
--    exclusion; nothing else reads it.
DROP INDEX public.messages_human_sent_idx;
CREATE INDEX messages_human_sent_idx ON public.messages (tenant_id, initiated_by_user_id, dispatched_at)
  WHERE direction = 'outbound' AND initiator = 'human' AND NOT imported AND dispatched_at IS NOT NULL
    AND bulk_action_id IS NULL AND marketing_piece_id IS NULL;

-- e) stored rollup days that counted an invite (rolled with the old filter): marked dirty, read live until re-rolled
INSERT INTO public.scoreboard_rollup_dirty (tenant_id, day)
SELECT r.tenant_id, r.day
  FROM public.scoreboard_rollup_days r
 WHERE EXISTS (SELECT 1 FROM public.messages m
                WHERE m.tenant_id = r.tenant_id AND m.marketing_piece_id IS NOT NULL AND m.bulk_action_id IS NULL
                  AND m.direction = 'outbound' AND m.initiator = 'human' AND NOT m.imported AND m.initiated_by_user_id IS NOT NULL
                  AND m.dispatched_at >= (r.day::timestamp AT TIME ZONE r.zone)
                  AND m.dispatched_at < ((r.day + 1)::timestamp AT TIME ZONE r.zone));

-- -----------------------------------------------------------------------------
-- 2. sends/F2: the dispatch guard (0043 body) sends an autonomous message only from a proposed action
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.messages_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE a record; paused timestamptz; ch text; pk text; own bytea[]; others bytea[]; exempt boolean; person uuid[];
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN RETURN NEW; END IF;
  IF NEW.direction <> 'outbound' OR NEW.imported
     OR NEW.status NOT IN ('dispatching','sent','delivered','failed','undelivered','bounced','dispatch_unknown')
     OR (TG_OP = 'UPDATE' AND OLD.status NOT IN ('scheduled','queued')) THEN
    RETURN NEW;
  END IF;

  -- channel → (consent channel, contact point kind); R-GATE-13: the map, core's Channel union and the gate
  -- table test change together.
  CASE NEW.channel
    WHEN 'sms'       THEN ch := 'sms';       pk := 'phone';
    WHEN 'mms'       THEN ch := 'sms';       pk := 'phone';
    WHEN 'email'     THEN ch := 'email';     pk := 'email';
    WHEN 'messenger' THEN ch := 'messenger'; pk := 'messenger';
    WHEN 'instagram' THEN ch := 'instagram'; pk := 'instagram';
    WHEN 'web_chat'  THEN ch := 'web_chat';  pk := 'web_chat';
    ELSE RAISE EXCEPTION 'CHANNEL_UNKNOWN: no opt-out mapping for channel %', NEW.channel USING ERRCODE = 'check_violation';
  END CASE;

  IF NOT EXISTS (SELECT 1 FROM public.contact_points p
                  WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id
                    AND p.kind = pk AND p.address = NEW.to_address) THEN
    RAISE EXCEPTION 'RECIPIENT_NOT_A_CONTACT_POINT: the recipient''s opt-out status cannot be checked' USING ERRCODE = 'check_violation';
  END IF;
  IF ch IN ('messenger','instagram') AND NOT app.platform_cleared('platform:meta') THEN
    RAISE EXCEPTION 'PLATFORM_NOT_CLEARED: Messenger and Instagram sending is off until counsel reviews the platform:meta pack'
      USING ERRCODE = 'check_violation';
  END IF;
  -- F1: the recipient's whole person (a merged-away record is the person its root survivor is)
  person := app.contact_person_ids(NEW.tenant_id, NEW.contact_id);
  own := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                WHERE p.tenant_id = NEW.tenant_id AND p.kind = pk AND p.address = NEW.to_address);
  -- an SMS or DM keyword revoke on any of the person's points of that kind blocks all of them
  others := CASE WHEN ch IN ('sms','messenger','instagram','web_chat')
                 THEN ARRAY(SELECT p.address_hmac FROM public.contact_points p
                             WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = ANY (person)   -- F1: every record of the person
                               AND p.kind = pk
                               -- R-PAR-12: a removed point still counts unless removed as a confirmed wrong number
                               AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number'))
                 ELSE '{}'::bytea[] END;
  exempt := NEW.initiator = 'system' AND NEW.action_category IN ('opt_out_confirmation','help_reply')
            AND NEW.purpose = 'informational' AND ch IN ('sms','messenger','instagram')
            AND EXISTS (SELECT 1 FROM public.messages im
                         WHERE im.tenant_id = NEW.tenant_id AND im.conversation_id = NEW.conversation_id
                           AND im.direction = 'inbound' AND im.channel = NEW.channel AND im.opt_out_keyword IS NOT NULL
                           AND im.from_address = NEW.to_address
                           AND im.created_at >= now() - interval '24 hours');

  IF NOT exempt AND EXISTS (SELECT 1 FROM public.contacts c
                             WHERE c.tenant_id = NEW.tenant_id AND c.do_not_contact_at IS NOT NULL
                               AND c.id = ANY (person)) THEN   -- F1: any record of the person
    RAISE EXCEPTION 'PERSON_DO_NOT_CONTACT: this person asked not to be contacted; nobody can send to them' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT exempt AND EXISTS (SELECT 1 FROM public.consent_state cs
                             WHERE cs.tenant_id = NEW.tenant_id AND cs.channel = ch AND cs.purpose = NEW.purpose
                               AND cs.status = 'revoked' AND cs.address_hmac = ANY (own || others)) THEN
    RAISE EXCEPTION 'RECIPIENT_OPTED_OUT: this address opted out; nobody can send to it' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppressions s
              WHERE s.tenant_id = NEW.tenant_id AND s.address_hmac = ANY (own) AND s.lifted_at IS NULL
                AND s.channel IN ('all', ch)) THEN
    RAISE EXCEPTION 'RECIPIENT_SUPPRESSED: this address is suppressed for %', ch USING ERRCODE = 'check_violation';
  END IF;

  -- an open-house invite goes out only from an approved (or published) invite version (R-MKT-1, R-MKT-8)
  IF NEW.marketing_piece_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.marketing_pieces mp
        WHERE mp.tenant_id = NEW.tenant_id AND mp.id = NEW.marketing_piece_id
          AND mp.kind = 'open_house_invite' AND mp.status IN ('approved','published')) THEN
    RAISE EXCEPTION 'MARKETING_PIECE_NOT_APPROVED: an invite is sent only from an approved open-house invite version'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Assistant autonomy (R-GATE-4, A3/A7), unchanged from 0013/0014 except the line marked b7 sends/F2.
  IF NEW.initiator = 'assistant' THEN
    SELECT aa.autonomy, aa.status, aa.decided_by_user_id, aa.playbook_version_id INTO a
      FROM public.assistant_actions aa WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.assistant_action_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSISTANT_ACTION_MISSING' USING ERRCODE = 'check_violation';
    ELSIF a.autonomy = 'within_playbook' THEN
      -- b7 sends/F2: an autonomous message goes out only while its action is still proposed (it turns executed only
      -- after the provider accepted it); an action a merge or an ownership change invalidated withdrew the message
      IF a.status IS DISTINCT FROM 'proposed' THEN
        RAISE EXCEPTION 'ASSISTANT_ACTION_WITHDRAWN: this automatic message was withdrawn before it went out' USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.playbook_versions v
                      WHERE v.tenant_id = NEW.tenant_id AND v.id = a.playbook_version_id AND v.status = 'approved') THEN
        RAISE EXCEPTION 'PLAYBOOK_NOT_APPROVED' USING ERRCODE = 'check_violation';
      END IF;
      SELECT c.automation_paused_at INTO paused FROM public.conversations c
       WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.conversation_id;
      IF paused IS NOT NULL THEN
        RAISE EXCEPTION 'AUTOMATION_PAUSED: the client replied; hand back instead' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF a.autonomy = 'requires_approval' THEN
      IF a.status NOT IN ('approved','executed') OR a.decided_by_user_id IS NULL THEN
        RAISE EXCEPTION 'ASSISTANT_ACTION_NOT_APPROVED' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'ASSISTANT_ACTION_NOT_SENDABLE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.messages_dispatch_guard() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.messages_dispatch_guard() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 3. ownership-data/F1: listing roles, deal roles and a deal's primary person follow a merge
-- -----------------------------------------------------------------------------
-- a) the merge trigger. Same event as 0027 contacts_merge_children and 0046 contacts_merge_webchat_sessions; it reads
--    nothing they write, so its place in the name order does not matter.
CREATE FUNCTION app.contacts_merge_roles() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  s uuid := NEW.merged_into_contact_id;
  l uuid := NEW.id;
  t uuid := NEW.tenant_id;
  sold uuid[];
BEGIN
  IF app.tenant_id() IS NOT NULL AND t IS DISTINCT FROM app.tenant_id() THEN RETURN NULL; END IF;
  IF s IS NULL OR s = l OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = t AND c.id = s) THEN
    RETURN NULL;
  END IF;

  -- the listings on which the loser was a seller (their open seller-update card says the seller moved)
  sold := ARRAY(SELECT lc.listing_id FROM public.listing_contacts lc
                 WHERE lc.tenant_id = t AND lc.contact_id = l AND lc.role IN ('seller','co_seller'));

  -- listing roles: the survivor keeps the stronger role (seller > co_seller > interested)
  INSERT INTO public.listing_contacts AS x (tenant_id, listing_id, contact_id, role, created_at)
  SELECT t, lc.listing_id, s, lc.role, lc.created_at FROM public.listing_contacts lc WHERE lc.tenant_id = t AND lc.contact_id = l
  ON CONFLICT (tenant_id, listing_id, contact_id) DO UPDATE SET role = EXCLUDED.role
   WHERE (CASE EXCLUDED.role WHEN 'seller' THEN 1 WHEN 'co_seller' THEN 2 ELSE 3 END)
       < (CASE x.role WHEN 'seller' THEN 1 WHEN 'co_seller' THEN 2 ELSE 3 END);
  DELETE FROM public.listing_contacts lc WHERE lc.tenant_id = t AND lc.contact_id = l;

  -- deal roles: a role the survivor already holds on the deal is kept
  INSERT INTO public.deal_contacts (tenant_id, deal_id, contact_id, role)
  SELECT t, dc.deal_id, s, dc.role FROM public.deal_contacts dc WHERE dc.tenant_id = t AND dc.contact_id = l
  ON CONFLICT (tenant_id, deal_id, contact_id) DO NOTHING;
  DELETE FROM public.deal_contacts dc WHERE dc.tenant_id = t AND dc.contact_id = l;

  -- a deal's primary person
  UPDATE public.deals d SET primary_contact_id = s WHERE d.tenant_id = t AND d.primary_contact_id = l;

  -- the open seller-update card of such a listing says what happened (the draft's recipients are the listing's
  -- sellers when it is sent, so it now goes to the merged record; nothing names either record)
  IF cardinality(sold) > 0 THEN
    UPDATE public.priority_feed_items f
       SET reasons = jsonb_build_array(jsonb_build_object('code', 'SELLER_UPDATE_SELLER_MERGED',
                       'label', 'A seller on this listing was merged with a duplicate record, so this update now goes to the merged record. Check who it goes to, add your recommendation and send')),
           updated_at = now()
     WHERE f.tenant_id = t AND f.item_type = 'seller_update' AND f.subject_type = 'listing' AND f.subject_id = ANY (sold)
       AND f.state IN ('open','snoozed');
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_merge_roles() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contacts_merge_roles() FROM PUBLIC;
GRANT INSERT, DELETE ON listing_contacts TO app_definer;
GRANT UPDATE (role) ON listing_contacts TO app_definer;   -- ON CONFLICT DO UPDATE (stronger role kept) needs it
GRANT INSERT, DELETE ON deal_contacts TO app_definer;
GRANT UPDATE (primary_contact_id) ON deals TO app_definer;
GRANT UPDATE (reasons, updated_at) ON priority_feed_items TO app_definer;
CREATE TRIGGER contacts_merge_roles AFTER UPDATE OF merged_into_contact_id ON contacts
  FOR EACH ROW WHEN (OLD.merged_into_contact_id IS NULL AND NEW.merged_into_contact_id IS NOT NULL)
  EXECUTE FUNCTION app.contacts_merge_roles();

-- b) roles of records merged away before this migration (runs as the migration owner): each moves to the ROOT
--    survivor of its record's merge chain (at most 64 hops), with the same dedupe rules.
CREATE TEMP TABLE b7_merge_root ON COMMIT DROP AS
WITH RECURSIVE up(tenant_id, loser, cur, depth) AS (
  SELECT c.tenant_id, c.id, c.merged_into_contact_id, 1 FROM public.contacts c WHERE c.merged_into_contact_id IS NOT NULL
  UNION ALL
  SELECT up.tenant_id, up.loser, c.merged_into_contact_id, up.depth + 1
    FROM up JOIN public.contacts c ON c.tenant_id = up.tenant_id AND c.id = up.cur AND c.merged_into_contact_id IS NOT NULL
   WHERE up.depth < 64
)
SELECT DISTINCT ON (tenant_id, loser) tenant_id, loser, cur AS root FROM up ORDER BY tenant_id, loser, depth DESC;

INSERT INTO public.listing_contacts AS x (tenant_id, listing_id, contact_id, role, created_at)
SELECT DISTINCT ON (lc.tenant_id, lc.listing_id, m.root) lc.tenant_id, lc.listing_id, m.root, lc.role, lc.created_at
  FROM public.listing_contacts lc JOIN b7_merge_root m ON m.tenant_id = lc.tenant_id AND m.loser = lc.contact_id
 WHERE m.root <> lc.contact_id
 ORDER BY lc.tenant_id, lc.listing_id, m.root, (CASE lc.role WHEN 'seller' THEN 1 WHEN 'co_seller' THEN 2 ELSE 3 END), lc.created_at
ON CONFLICT (tenant_id, listing_id, contact_id) DO UPDATE SET role = EXCLUDED.role
 WHERE (CASE EXCLUDED.role WHEN 'seller' THEN 1 WHEN 'co_seller' THEN 2 ELSE 3 END)
     < (CASE x.role WHEN 'seller' THEN 1 WHEN 'co_seller' THEN 2 ELSE 3 END);
DELETE FROM public.listing_contacts lc USING b7_merge_root m WHERE m.tenant_id = lc.tenant_id AND m.loser = lc.contact_id AND m.root <> lc.contact_id;

INSERT INTO public.deal_contacts (tenant_id, deal_id, contact_id, role)
SELECT DISTINCT ON (dc.tenant_id, dc.deal_id, m.root) dc.tenant_id, dc.deal_id, m.root, dc.role
  FROM public.deal_contacts dc JOIN b7_merge_root m ON m.tenant_id = dc.tenant_id AND m.loser = dc.contact_id
 WHERE m.root <> dc.contact_id
 ORDER BY dc.tenant_id, dc.deal_id, m.root, dc.role
ON CONFLICT (tenant_id, deal_id, contact_id) DO NOTHING;
DELETE FROM public.deal_contacts dc USING b7_merge_root m WHERE m.tenant_id = dc.tenant_id AND m.loser = dc.contact_id AND m.root <> dc.contact_id;

UPDATE public.deals d SET primary_contact_id = m.root
  FROM b7_merge_root m WHERE m.tenant_id = d.tenant_id AND m.loser = d.primary_contact_id AND m.root <> d.primary_contact_id;

-- -----------------------------------------------------------------------------
-- 4. Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('app.scoreboard_activity(uuid[],timestamptz,timestamptz)'::regprocedure,
                              'app.scoreboard_rollup_roll(integer,integer)'::regprocedure, 'app.scoreboard_mark_messages()'::regprocedure,
                              'app.messages_dispatch_guard()'::regprocedure, 'app.contacts_merge_roles()'::regprocedure)
                AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                     OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    bad := bad || ' definer_shape';
  END IF;
  -- every earlier rule is still in the replaced bodies, plus this migration's
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('app.scoreboard_activity(uuid[],timestamptz,timestamptz)'::regprocedure,
                              'app.scoreboard_rollup_roll(integer,integer)'::regprocedure, 'app.scoreboard_mark_messages()'::regprocedure)
                AND (position('bulk_action_id IS NULL' IN p.prosrc) = 0 OR position('marketing_piece_id IS NULL' IN p.prosrc) = 0)) THEN
    bad := bad || ' scoreboard_exclusions';
  END IF;
  IF position('f.owner_user_id IS DISTINCT FROM e.owner_user_id' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'app.scoreboard_rollup_roll(integer,integer)'::regprocedure)) = 0 THEN
    bad := bad || ' rollup_0047_rule';
  END IF;
  IF (SELECT position('app.contact_person_ids' IN p.prosrc) = 0 OR position('wrong_number' IN p.prosrc) = 0
             OR position('MARKETING_PIECE_NOT_APPROVED' IN p.prosrc) = 0 OR position('ASSISTANT_ACTION_WITHDRAWN' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.messages_dispatch_guard()'::regprocedure) THEN
    bad := bad || ' dispatch_guard_rules';
  END IF;
  IF NOT has_function_privilege('app_user', 'app.scoreboard_activity(uuid[],timestamptz,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('app_user', 'app.scoreboard_rollup_roll(integer,integer)', 'EXECUTE')
     OR has_function_privilege('app_user', 'app.scoreboard_mark_messages()', 'EXECUTE')
     OR has_function_privilege('app_user', 'app.contacts_merge_roles()', 'EXECUTE') THEN
    bad := bad || ' grants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.contacts'::regclass AND tgname = 'contacts_merge_roles') THEN
    bad := bad || ' merge_roles_trigger';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (b7 review sends/merges):%', bad; END IF;
END $$;
