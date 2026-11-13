-- =============================================================================
-- Google Business Profile gate and guards (module 53, M53) and the aggregate-only coaching trends definer
-- (module 54, M54). DATA_MODEL R-GBP-1..5, R-COACH-7, R-COACH-8, R-MKT-12, R-INT-6; E460-E474; ARCHITECTURE §21.40 and §21.41
-- "GBP and coaching trends".
-- The number is a placeholder: the orchestrator renumbers at merge, and nothing in code or tests names this file.
-- No existing migration is edited; no table shape, CHECK or RLS policy changes (PHASE2_3_PLAN §4).
--
-- What this adds:
--   M53 a) platform:gbp, a new clearance pack, unreviewed and counsel-only (owner decision D7: GBP stays dark behind
--          its platform pack; owner attestation D11 does not cover it). Posts and replies also need platform:fair_housing.
--       b) app.gbp_reviews_guard (invoker, BEFORE INSERT OR UPDATE on gbp_reviews): a review row exists only for a
--          live GBP location while platform:gbp is cleared; its identity never changes; a removed review keeps no text;
--          the reply state moves only along the allowed edges and names a matching review_reply_draft.
--       c) app.marketing_publications_gbp_gate (invoker, BEFORE INSERT on marketing_publications): a publication to a
--          gbp_location waits for platform:gbp. A second trigger next to the 0054 guard (which is not replaced): both
--          refuse independently, and its name sorts after the guard's, so the guard's refusals come first.
--   M54 d) app.coaching_trends(user_ids, weeks, rubric_version): SECURITY DEFINER, aggregate-only weekly counts per
--          rubric item, with a cell floor against small numbers and differencing (R-COACH-7, R-COACH-8).
--       e) the self-check.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.40 and §21.41):
--   * One new SECURITY DEFINER function, app.coaching_trends: owner app_definer (BYPASSRLS), search_path pinned to
--     pg_catalog, public, every table schema-qualified and filtered by app.tenant_id(); EXECUTE revoked from PUBLIC and
--     granted to app_user only. It reads call_scores past RLS: the aggregate exception R-COACH-7 grants ("a Team Lead
--     sees aggregates only"). It returns counts only (no call, contact, quote or score), refuses every caller but a
--     staff user with a reviewed role, and scopes the ids itself (self; Owner/Admin any member; a Team Lead their team
--     only while the Owner's tl_sees_call_scores is on).
--   * Two new invoker trigger functions (app.gbp_reviews_guard, app.marketing_publications_gbp_gate): they only refuse
--     (and normalise one FK-driven state); EXECUTE revoked from PUBLIC; RLS still decides who writes (the system only,
--     for gbp_reviews; a person's tap, for publications).
--   * One new invoker helper, app.coaching_trend_bounds (pure, STABLE: time-zone data): the week windows, testable at any instant.
--   * No new policy, no new table grant, no new column.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. platform:gbp (M53 a). Ships unreviewed; only the counsel-review command records its review on a deployment.
-- -----------------------------------------------------------------------------
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:gbp', '2026.11.0', 'published', '{}', NULL,
   'Google Business Profile: review sync, reply drafts and replies; posts and replies also need platform:fair_housing. '
   'Not covered by owner attestation D11. VERIFY WITH COUNSEL (C15).');

-- -----------------------------------------------------------------------------
-- 2. gbp_reviews guard (M53 b)
-- -----------------------------------------------------------------------------
-- reply_status / reply_action_id:
--   none     no action
--   drafted  a review_reply_draft of this review, proposed or approved (a person's tap is in flight while approved)
--   replied  with an action: the reply Realty OS posted (the action executed); without: replied outside Realty OS
-- Moves: none→drafted, drafted→drafted (a new draft supersedes), drafted→none, drafted→replied, none→replied,
-- replied→none (the owner reply was deleted at Google). The FK's ON DELETE SET NULL of a drafted row's action (it
-- fires this BEFORE UPDATE trigger) is let through and the row goes back to none. Nothing deletes actions today.
CREATE FUNCTION app.gbp_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.tenant_id, NEW.id, NEW.connection_id, NEW.external_review_id, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.connection_id, OLD.external_review_id, OLD.created_at) THEN
      RAISE EXCEPTION 'GBP_REVIEW_IMMUTABLE: a review keeps its location, Google id and creation time' USING ERRCODE = 'check_violation';
    END IF;
    -- the FK's ON DELETE SET NULL of a drafted review's action: the draft is gone, so the review needs a reply again
    IF OLD.reply_status = 'drafted' AND NEW.reply_status = 'drafted' AND OLD.reply_action_id IS NOT NULL AND NEW.reply_action_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.assistant_actions x WHERE x.tenant_id = OLD.tenant_id AND x.id = OLD.reply_action_id) THEN
      NEW.reply_status := 'none';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.integration_connections c
                    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.connection_id AND c.kind = 'gbp_location'
                      AND c.status IN ('connected','degraded')) THEN
      RAISE EXCEPTION 'CHANNEL_NOT_CONNECTED: reviews are stored only for a connected Google Business Profile location' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.platform_cleared('platform:gbp') THEN
      RAISE EXCEPTION 'GBP_NOT_CLEARED: Google Business Profile waits for counsel review of the platform:gbp pack' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reply_status NOT IN ('none','replied') OR NEW.reply_action_id IS NOT NULL THEN
      RAISE EXCEPTION 'GBP_REPLY_STATE: a review is stored as needing a reply or as replied at Google, with no draft' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- "Removed at Google": no rating, so no text and no reviewer either
  IF NEW.rating IS NULL AND (NEW.body IS NOT NULL OR NEW.reviewer_display IS NOT NULL) THEN
    RAISE EXCEPTION 'GBP_REVIEW_IMMUTABLE: a review removed at Google keeps no text and no reviewer' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reply_status = 'none' AND NEW.reply_action_id IS NOT NULL THEN
    RAISE EXCEPTION 'GBP_REPLY_STATE: a review that needs a reply names no draft' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reply_status = 'drafted' AND NEW.reply_action_id IS NULL THEN
    RAISE EXCEPTION 'GBP_REPLY_STATE: a drafted review names its draft' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.reply_status IS DISTINCT FROM OLD.reply_status AND NOT (
       (OLD.reply_status = 'none' AND NEW.reply_status IN ('drafted','replied'))
    OR (OLD.reply_status = 'drafted' AND NEW.reply_status IN ('none','replied'))
    OR (OLD.reply_status = 'replied' AND NEW.reply_status = 'none')) THEN
    RAISE EXCEPTION 'GBP_REPLY_STATE: % cannot become %', OLD.reply_status, NEW.reply_status USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.reply_action_id IS NOT NULL
     AND (NEW.reply_action_id IS DISTINCT FROM OLD.reply_action_id OR NEW.reply_status IS DISTINCT FROM OLD.reply_status) THEN
    SELECT x.kind, x.status, x.payload->>'review_id' AS review_id INTO a
      FROM public.assistant_actions x WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.reply_action_id;
    IF NOT FOUND OR a.kind <> 'review_reply_draft' OR a.review_id IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'GBP_REPLY_STATE: the draft must be a review reply draft of this review' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reply_status = 'drafted' THEN
      IF NOT app.platform_cleared('platform:gbp') THEN
        RAISE EXCEPTION 'GBP_NOT_CLEARED: reply drafts wait for counsel review of the platform:gbp pack' USING ERRCODE = 'check_violation';
      END IF;
      IF a.status NOT IN ('proposed','approved') THEN
        RAISE EXCEPTION 'GBP_REPLY_STATE: a drafted review names a draft that is waiting or being posted' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.reply_status = 'none' AND NEW.rating IS NULL THEN
        RAISE EXCEPTION 'GBP_REPLY_STATE: a review removed at Google takes no reply' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.reply_status = 'replied' AND a.status <> 'executed' THEN
      RAISE EXCEPTION 'GBP_REPLY_STATE: a reply counts as posted only after Google confirmed it' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.gbp_reviews_guard() FROM PUBLIC;
CREATE TRIGGER gbp_reviews_guard BEFORE INSERT OR UPDATE ON gbp_reviews
  FOR EACH ROW EXECUTE FUNCTION app.gbp_reviews_guard();

-- -----------------------------------------------------------------------------
-- 3. The GBP publication gate (M53 c). A second trigger: the 0054 guard stays as it is; its name sorts after
--    marketing_publications_guard, so the guard's refusals (wrong pairing, not connected, fair housing) come first.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.marketing_publications_gbp_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF EXISTS (SELECT 1 FROM public.integration_connections c
              WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.connection_id AND c.kind = 'gbp_location')
     AND NOT app.platform_cleared('platform:gbp') THEN
    RAISE EXCEPTION 'PLATFORM_NOT_CLEARED: publishing to a Google Business Profile location waits for counsel review of the platform:gbp pack'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.marketing_publications_gbp_gate() FROM PUBLIC;
CREATE TRIGGER marketing_publications_guard_gbp BEFORE INSERT ON marketing_publications
  FOR EACH ROW EXECUTE FUNCTION app.marketing_publications_gbp_gate();

-- -----------------------------------------------------------------------------
-- 4. Coaching trends (M54 d)
-- -----------------------------------------------------------------------------
-- The two windows at `p_now` in zone `p_zone`: whole local weeks, ISO Monday 00:00 start. "after" is the p_weeks
-- weeks ending at this week's Monday 00:00 (the current, unfinished week is never counted), "before" the p_weeks weeks
-- before that. Computed on local timestamps and converted once, so a DST change or a year boundary inside a window
-- moves nothing. `last_day` is the window's last local date (a Sunday).
CREATE FUNCTION app.coaching_trend_bounds(p_now timestamptz, p_zone text, p_weeks integer)
RETURNS TABLE (window_kind text, starts_at timestamptz, ends_at timestamptz, first_day date, last_day date)
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  WITH m AS (SELECT date_trunc('week', p_now AT TIME ZONE p_zone) AS monday)
  SELECT k.kind,
         (m.monday - make_interval(weeks => k.back_to)) AT TIME ZONE p_zone,
         (m.monday - make_interval(weeks => k.back_from)) AT TIME ZONE p_zone,
         (m.monday - make_interval(weeks => k.back_to))::date,
         ((m.monday - make_interval(weeks => k.back_from))::date - 1)
    FROM m, (VALUES ('before', 2 * p_weeks, p_weeks), ('after', p_weeks, 0)) AS k(kind, back_to, back_from)
$$;
REVOKE ALL ON FUNCTION app.coaching_trend_bounds(timestamptz, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.coaching_trend_bounds(timestamptz, text, integer) TO app_user, app_definer;

-- Aggregate-only weekly trends per rubric item (R-COACH-7, R-COACH-8). One row per (member, window, item) and, when
-- more than one id is named, per (all named members together, window, item) with agent_user_id NULL:
--   scored  calls whose first entry for the item is met or missed (needs_review / not_applicable leave the n, as core)
--   met     of those, met; NULL when withheld (below)
--   calls   distinct reviewed calls (a call_scores row of the version) of the member(s) in the window
-- Counted: call_scores of p_rubric_version, joined to the call (its started_at in the window: when it happened, not
-- when it was scored), with a recording that is not shredded (the 0052 RESTRICTIVE policy's condition).
-- The floor (also against differencing): cells are (member, ISO week, item). met is returned only when scored >= 5 AND
-- every cell inside the row has 0 or >= 5 scored, so two overlapping answers (other weeks, other id sets) differ only
-- by whole cells of >= 5. A caller asking for exactly themselves gets only the scored >= 5 rule: they may read those
-- reviews anyway (R-COACH-3).
CREATE FUNCTION app.coaching_trends(p_user_ids uuid[], p_weeks integer, p_rubric_version text)
RETURNS TABLE (agent_user_id uuid, window_kind text, window_start date, window_end date, item_key text, scored integer, met integer, calls integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_me uuid := app.user_id();
  v_role text := app.my_role();
  v_zone text;
  v_tl boolean;
  v_on boolean;
  v_self boolean;
  v_n integer;
BEGIN
  IF v_tenant IS NULL OR v_me IS NULL OR app.actor_kind() IS DISTINCT FROM 'user' OR app.principal_type() IS DISTINCT FROM 'staff'
     OR v_role IS NULL OR v_role NOT IN ('owner','admin','team_lead','agent','isa') THEN
    RAISE EXCEPTION 'COACHING_TRENDS_SCOPE: trends are read by a staff member who takes call reviews' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 4 OR p_rubric_version IS NULL OR p_rubric_version !~ '^rubric/[0-9]+$' THEN
    RAISE EXCEPTION 'COACHING_TRENDS_SCOPE: 1 to 4 weeks of one rubric version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_n := COALESCE(cardinality(p_user_ids), 0);
  IF v_n < 1 OR v_n > 200 OR array_position(p_user_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT u) FROM unnest(p_user_ids) AS u) <> v_n
     OR (SELECT count(*) FROM public.memberships m WHERE m.tenant_id = v_tenant AND m.user_id = ANY (p_user_ids)) <> v_n THEN
    RAISE EXCEPTION 'COACHING_TRENDS_SCOPE: 1 to 200 distinct members of this team' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.default_timezone, s.tl_sees_call_scores, s.call_scoring_enabled INTO v_zone, v_tl, v_on
    FROM public.tenant_settings s WHERE s.tenant_id = v_tenant;
  v_self := v_n = 1 AND p_user_ids[1] = v_me;
  IF NOT (v_role IN ('owner','admin')
          OR NOT EXISTS (SELECT 1 FROM unnest(p_user_ids) AS u WHERE u <> v_me)
          OR (v_role = 'team_lead' AND COALESCE(v_tl, false)
              AND NOT EXISTS (SELECT 1 FROM unnest(p_user_ids) AS u WHERE u <> v_me AND NOT (u = ANY (app.my_team_member_ids()))))) THEN
    RAISE EXCEPTION 'COACHING_TRENDS_SCOPE: these members'' trends are not yours to read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- off, or uncleared again: nothing is read
  IF NOT app.platform_cleared('platform:coaching') OR NOT COALESCE(v_on, false) THEN RETURN; END IF;

  RETURN QUERY
  WITH b AS (
    SELECT x.window_kind AS wk, x.starts_at, x.ends_at, x.first_day, x.last_day FROM app.coaching_trend_bounds(now(), v_zone, p_weeks) x
  ), scored_calls AS (
    SELECT cs.agent_user_id AS uid, cs.call_id AS cid, cs.items, b.wk, b.first_day, b.last_day,
           date_trunc('week', c.started_at AT TIME ZONE v_zone) AS week
      FROM public.call_scores cs
      JOIN public.calls c ON c.tenant_id = cs.tenant_id AND c.id = cs.call_id
      JOIN b ON c.started_at >= b.starts_at AND c.started_at < b.ends_at
     WHERE cs.tenant_id = v_tenant AND cs.rubric_version = p_rubric_version AND cs.agent_user_id = ANY (p_user_ids)
       AND EXISTS (SELECT 1 FROM public.recordings r WHERE r.tenant_id = cs.tenant_id AND r.call_id = cs.call_id AND r.status <> 'shredded')
  ), entries AS (   -- the first entry per item key, as core's trend() reads it
    SELECT DISTINCT ON (sc.cid, e.value->>'key') sc.uid, sc.cid, sc.wk, sc.week, e.value->>'key' AS ikey, e.value->>'status' AS st
      FROM scored_calls sc CROSS JOIN LATERAL jsonb_array_elements(sc.items) WITH ORDINALITY AS e(value, ord)
     WHERE jsonb_typeof(e.value) = 'object' AND jsonb_typeof(e.value->'key') = 'string'
     ORDER BY sc.cid, e.value->>'key', e.ord
  ), cells AS (     -- (member, week, item)
    SELECT en.uid, en.wk, en.week, en.ikey, count(*) FILTER (WHERE en.st IN ('met','missed'))::integer AS n
      FROM entries en GROUP BY en.uid, en.wk, en.week, en.ikey
  ), per_member AS (
    SELECT en.uid, en.wk, en.ikey,
           count(*) FILTER (WHERE en.st IN ('met','missed'))::integer AS n,
           count(*) FILTER (WHERE en.st = 'met')::integer AS m,
           bool_and(NOT EXISTS (SELECT 1 FROM cells ce WHERE ce.uid = en.uid AND ce.wk = en.wk AND ce.ikey = en.ikey AND ce.n BETWEEN 1 AND 4)) AS whole
      FROM entries en GROUP BY en.uid, en.wk, en.ikey
  ), per_group AS (
    SELECT en.wk, en.ikey,
           count(*) FILTER (WHERE en.st IN ('met','missed'))::integer AS n,
           count(*) FILTER (WHERE en.st = 'met')::integer AS m,
           bool_and(NOT EXISTS (SELECT 1 FROM cells ce WHERE ce.wk = en.wk AND ce.ikey = en.ikey AND ce.n BETWEEN 1 AND 4)) AS whole
      FROM entries en WHERE v_n > 1 GROUP BY en.wk, en.ikey
  ), member_calls AS (
    SELECT sc.uid, sc.wk, count(DISTINCT sc.cid)::integer AS k FROM scored_calls sc GROUP BY sc.uid, sc.wk
  ), group_calls AS (
    SELECT sc.wk, count(DISTINCT sc.cid)::integer AS k FROM scored_calls sc GROUP BY sc.wk
  )
  SELECT pm.uid, pm.wk, b.first_day, b.last_day, pm.ikey, pm.n,
         CASE WHEN pm.n >= 5 AND (v_self OR pm.whole) THEN pm.m END, mc.k
    FROM per_member pm JOIN b ON b.wk = pm.wk JOIN member_calls mc ON mc.uid = pm.uid AND mc.wk = pm.wk
  UNION ALL
  SELECT NULL::uuid, pg.wk, b.first_day, b.last_day, pg.ikey, pg.n,
         CASE WHEN pg.n >= 5 AND pg.whole THEN pg.m END, gc.k
    FROM per_group pg JOIN b ON b.wk = pg.wk JOIN group_calls gc ON gc.wk = pg.wk;
END $$;
ALTER FUNCTION app.coaching_trends(uuid[], integer, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.coaching_trends(uuid[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.coaching_trends(uuid[], integer, text) TO app_user;

-- -----------------------------------------------------------------------------
-- 5. Self-check (M53 e)
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jurisdiction_packs WHERE key = 'platform:gbp' AND status = 'published' AND reviewed_by_counsel_at IS NULL)
     OR EXISTS (SELECT 1 FROM jurisdiction_packs WHERE key = 'platform:gbp' AND reviewed_by_counsel_at IS NOT NULL) THEN
    bad := bad || ' pack';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'app.coaching_trends(uuid[],integer,text)'::regprocedure
                    AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'app_definer'
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public'])
     OR has_function_privilege('public', 'app.coaching_trends(uuid[],integer,text)', 'EXECUTE')
     OR NOT has_function_privilege('app_user', 'app.coaching_trends(uuid[],integer,text)', 'EXECUTE') THEN
    bad := bad || ' definer_shape';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('app.gbp_reviews_guard()'::regprocedure, 'app.marketing_publications_gbp_gate()'::regprocedure,
                                                    'app.coaching_trend_bounds(timestamptz,text,integer)'::regprocedure)
                AND (p.prosecdef OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    bad := bad || ' invoker_shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.gbp_reviews'::regclass AND tgname = 'gbp_reviews_guard')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.marketing_publications'::regclass AND tgname = 'marketing_publications_guard_gbp')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.marketing_publications'::regclass AND tgname = 'marketing_publications_guard') THEN
    bad := bad || ' triggers';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (gbp and coaching trends):%', bad; END IF;
END $$;
