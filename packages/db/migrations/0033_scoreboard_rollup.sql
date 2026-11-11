-- 0033 (written as 0027 in lane perf-misses, item 3): a daily rollup of the scoreboard numbers, read for full past days, with
-- a live count for the rest of the range (today, and any day not rolled yet or marked dirty).
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): five new tables, new SECURITY DEFINER functions (the rollup job's
-- writer, its horizon sample, and the dirty-day mark triggers; none returns a row to its caller beyond a
-- run summary of counts), and a new body for the 0012 definer app.scoreboard_speed that returns the same
-- rows (section 0). No existing policy changes.
--
-- Why. GET /team/scoreboard?range=30d spent its 0.40 s (team lead) / 0.93 s (admin) at 250k contacts
-- counting the same past days again on every request: per member and range, app.scoreboard_speed walks
-- the SLA ownership periods with a per-period first-touch lookup, and app.scoreboard_activity counts
-- calls, texts, appointments and agreements (docs/PERFORMANCE.md §7 item 3).
--
-- What the numbers are (unchanged). The scoreboard reads the 0012 SECURITY DEFINER aggregates, NOT the
-- security_invoker views: a member's numbers are the same whoever asks and whatever happened to the
-- contacts since (reassigned, released, in a pond, soft-deleted); the only viewer-dependent part is WHICH
-- members' numbers the caller may see (app.scoreboard_allowed_users: tenant-wide callers anyone, a Team
-- Lead their team, everyone else themselves). So a rollup keyed by (tenant, member, day) holds exactly
-- what the live aggregates return for that member and day, for every viewer; the read path keeps the
-- viewer rule by joining the rollup to app.scoreboard_allowed_users (and the rollup's own RLS is that same
-- rule), and it uses the rollup only for whole days in [from, to).
--
-- Day boundaries: day d is [d 00:00, d+1 00:00) in the tenant's default_timezone, as instants
-- ((d::timestamp) AT TIME ZONE zone), the same expression rangeBounds() uses, so DST days are 23 or 25 h
-- long in both paths. A rolled day remembers the zone it was rolled in; after a zone change it is not
-- used until re-rolled.
--
-- When a rolled day is exact (the invariant the read path relies on):
--   a) Late and backdated writes. Every write that can change a counted row of a day before the writer's
--      current local day (a backdated import of human rows does not count, imported rows never do; a
--      re-dispatch, an appointment marked held days later, a late first touch on an older SLA period, a
--      deal changing owner, a retention delete) inserts a dirty mark for that day in the SAME
--      transaction (triggers below). A marked day is computed live until the job re-rolls it. The job
--      deletes only the marks it read, so a mark committed while it computed survives to the next run.
--   b) Writes that were in flight when the day ended. A day is rolled only once every transaction that
--      could still write into it unmarked has finished: the job samples (clock, a fresh xid Y) in a
--      transaction of its own, and the sample becomes the "safe" horizon only once
--      pg_snapshot_xmin(pg_current_snapshot()) > Y, i.e. every transaction that had an xid when the
--      sample was taken has ended. An unmarked write into day d happened (trigger time) before d ended,
--      so before any sample that can make d safe, so it has committed (or aborted) before d is rolled.
--   c) SLA periods that close later: the period's own day is marked when its first touch (or any later
--      ledger change) arrives (a), so pending/untouched periods stay exact.

-- -----------------------------------------------------------------------------
-- 0. The live part stays live, so make it cheaper (same results)
-- -----------------------------------------------------------------------------
-- a) app.scoreboard_speed (0012) found a period's first touch with two probes per period: the first
--    first_touch_recorded after it, then an anti-join for an event that ended the window in between (on
--    loe_prev_owner_idx, filtering the contact's whole ledger). Equivalent with ONE probe on the primary
--    key: the first event after the period that is either a first touch or one of the window-ending
--    types; it is the period's first touch iff it is a first_touch_recorded. (If the first such event is a
--    first touch, nothing ended the window before it and no earlier first touch exists; if it is a
--    window-ending event, every later first touch has it in between.) Same signature, same owner, same
--    caller filter (app.scoreboard_allowed_users), same rows; old vs new is proved row for row for every
--    role in scoreboard_rollup.test.ts. Measured at 250k (admin, 30 d, 33.8k periods): 554 ms -> 220 ms.
CREATE OR REPLACE FUNCTION app.scoreboard_speed(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (user_id uuid, owned_at timestamptz, first_touch_due_at timestamptz, first_touch_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.owner_user_id, e.occurred_at, e.deadline_at, CASE WHEN nx.type = 'first_touch_recorded' THEN nx.occurred_at END
    FROM public.lead_ownership_events e
    LEFT JOIN LATERAL (
      SELECT f.type, f.occurred_at FROM public.lead_ownership_events f
       WHERE f.tenant_id = e.tenant_id AND f.contact_id = e.contact_id AND f.seq > e.seq
         AND f.type IN ('first_touch_recorded','reassigned','released','auto_released','inactivity_released','sent_to_pond',
                        'closed','merged_away','claimed','assigned','offer_accepted')
       ORDER BY f.seq LIMIT 1) nx ON true
   WHERE e.tenant_id = app.tenant_id()
     AND e.owner_user_id IN (SELECT a.user_id FROM app.scoreboard_allowed_users(p_user_ids) a)
     AND e.type IN ('offer_accepted','claimed','assigned','reassigned') AND e.deadline_at IS NOT NULL
     AND e.actor_kind <> 'import'
     AND e.occurred_at >= p_from AND e.occurred_at < p_to
$$;
ALTER FUNCTION app.scoreboard_speed(uuid[], timestamptz, timestamptz) OWNER TO app_definer;

-- b) app.scoreboard_activity (0012) counts per member; two of its counts had no index for the member and
--    read the tenant's whole table once per member (appointments set: COALESCE(set_by_user_id, user_id);
--    agreements: every agreement_signed history row, then the deal's owner). Partial indexes whose
--    predicates match those filters exactly.
CREATE INDEX appointments_set_by_idx ON appointments (tenant_id, (COALESCE(set_by_user_id, user_id)), created_at)
  WHERE created_by_kind = 'user';
CREATE INDEX deal_stage_history_agreement_idx ON deal_stage_history (tenant_id, changed_at, deal_id)
  WHERE to_stage = 'agreement_signed';

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
-- Days rolled per tenant (and the zone they were rolled in).
CREATE TABLE scoreboard_rollup_days (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  day        date NOT NULL,
  zone       text NOT NULL,
  rolled_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);

-- Per member and rolled day: the counts app.scoreboard_activity returns for [day start, day end).
-- No row = all zero (a member with no activity that day).
CREATE TABLE scoreboard_activity_daily (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  user_id            uuid NOT NULL,
  day                date NOT NULL,
  calls              integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  texts_and_emails   integer NOT NULL DEFAULT 0 CHECK (texts_and_emails >= 0),
  appointments_set   integer NOT NULL DEFAULT 0 CHECK (appointments_set >= 0),
  appointments_held  integer NOT NULL DEFAULT 0 CHECK (appointments_held >= 0),
  appointments_due   integer NOT NULL DEFAULT 0 CHECK (appointments_due >= 0),
  agreements_signed  integer NOT NULL DEFAULT 0 CHECK (agreements_signed >= 0),
  PRIMARY KEY (tenant_id, user_id, day)
);
CREATE INDEX scoreboard_activity_daily_day_idx ON scoreboard_activity_daily (tenant_id, day);

-- Per member and rolled day: the rows app.scoreboard_speed returns (one per SLA ownership period whose
-- period started that day). Timings only, like the function: no contact id crosses this boundary.
CREATE TABLE scoreboard_speed_daily (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  user_id             uuid NOT NULL,
  day                 date NOT NULL,
  ord                 integer NOT NULL CHECK (ord >= 1),
  owned_at            timestamptz NOT NULL,
  first_touch_due_at  timestamptz NOT NULL,
  first_touch_at      timestamptz,
  PRIMARY KEY (tenant_id, user_id, day, ord)
);
CREATE INDEX scoreboard_speed_daily_day_idx ON scoreboard_speed_daily (tenant_id, day);

-- Days to re-roll (a write changed a counted row of a closed day). Append-only for writers; the job
-- deletes exactly the marks it processed.
CREATE TABLE scoreboard_rollup_dirty (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  id         bigint GENERATED ALWAYS AS IDENTITY,
  day        date NOT NULL,
  marked_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX scoreboard_rollup_dirty_day_idx ON scoreboard_rollup_dirty (tenant_id, day);

-- The job's horizon per tenant: safe_until = every write into a day ending at or before it has ended;
-- pending_* = the last sample, not yet known to be safe (pending_xid is a full 64-bit xid8 as bigint).
CREATE TABLE scoreboard_rollup_state (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  zone         text,
  safe_until   timestamptz,
  pending_at   timestamptz,
  pending_xid  bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  CHECK ((pending_at IS NULL) = (pending_xid IS NULL))
);

-- -----------------------------------------------------------------------------
-- 2. Row-level security (the 0018 Layer 1 text) and read policies
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scoreboard_rollup_days','scoreboard_activity_daily','scoreboard_speed_daily',
                           'scoreboard_rollup_dirty','scoreboard_rollup_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    -- app_user reads only; every write goes through the definers below
    EXECUTE format('GRANT SELECT ON public.%I TO app_user', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_definer', t);
    EXECUTE format('GRANT SELECT, DELETE ON public.%I TO app_retention', t);
  END LOOP;
END $$;

-- The per-member numbers: exactly the members app.scoreboard_allowed_users admits (minus its "has a
-- membership" join, which the read path applies by joining to that function): tenant-wide callers
-- anyone, a Team Lead the members of a team they lead, everyone else themselves.
CREATE POLICY scoreboard_activity_daily_read ON scoreboard_activity_daily FOR SELECT USING (
  (SELECT app.is_member()) AND (
       (SELECT app.is_tenant_wide())
    OR user_id = (SELECT app.user_id())
    OR ((SELECT app.my_role()) = 'team_lead' AND user_id = ANY ((SELECT app.my_team_member_ids())::uuid[]))));
CREATE POLICY scoreboard_speed_daily_read ON scoreboard_speed_daily FOR SELECT USING (
  (SELECT app.is_member()) AND (
       (SELECT app.is_tenant_wide())
    OR user_id = (SELECT app.user_id())
    OR ((SELECT app.my_role()) = 'team_lead' AND user_id = ANY ((SELECT app.my_team_member_ids())::uuid[]))));
-- Which days are rolled / dirty: dates only, no member and no number; every member reads them.
CREATE POLICY scoreboard_rollup_days_read ON scoreboard_rollup_days FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY scoreboard_rollup_dirty_read ON scoreboard_rollup_dirty FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY scoreboard_rollup_state_read ON scoreboard_rollup_state FOR SELECT USING ((SELECT app.is_tenant_wide()));

-- -----------------------------------------------------------------------------
-- 3. The day of an instant in a zone, by the same instant boundaries the range uses
-- -----------------------------------------------------------------------------
-- d such that (d::timestamp AT TIME ZONE zone) <= at < ((d+1)::timestamp AT TIME ZONE zone). Equal to the
-- local date except where a zone skips its midnight (then the boundary instant decides).
CREATE FUNCTION app.scoreboard_day_of(p_at timestamptz, p_zone text) RETURNS date LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN p_at < (((p_at AT TIME ZONE p_zone)::date)::timestamp AT TIME ZONE p_zone) THEN (p_at AT TIME ZONE p_zone)::date - 1
           WHEN p_at >= ((((p_at AT TIME ZONE p_zone)::date + 1))::timestamp AT TIME ZONE p_zone) THEN (p_at AT TIME ZONE p_zone)::date + 1
           ELSE (p_at AT TIME ZONE p_zone)::date
         END
$$;
GRANT EXECUTE ON FUNCTION app.scoreboard_day_of(timestamptz, text) TO app_user, app_definer, app_retention;

-- -----------------------------------------------------------------------------
-- 4. Dirty-day marks (invariant a)
-- -----------------------------------------------------------------------------
-- Marks the day of p_at when it is a day before the current local day (clock_timestamp()) and inside the
-- longest range (90 d, with margin). One mark per day per writing transaction. Writes no number and
-- returns nothing; SECURITY DEFINER only so every writer (app_user, the system actor, app_retention) can
-- add the mark and read the tenant's zone.
CREATE FUNCTION app.scoreboard_mark(p_tenant uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_now  timestamptz := clock_timestamp();
  v_zone text;
  v_day  date;
BEGIN
  IF p_tenant IS NULL OR p_at IS NULL OR p_at >= v_now OR p_at < v_now - interval '100 days' THEN
    RETURN;
  END IF;
  SELECT s.default_timezone INTO v_zone FROM public.tenant_settings s WHERE s.tenant_id = p_tenant;
  IF v_zone IS NULL THEN
    RETURN;
  END IF;
  v_day := app.scoreboard_day_of(p_at, v_zone);
  IF v_day >= app.scoreboard_day_of(v_now, v_zone) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.scoreboard_rollup_dirty m
              WHERE m.tenant_id = p_tenant AND m.day = v_day AND m.xmin = pg_current_xact_id()::xid) THEN
    RETURN;
  END IF;
  INSERT INTO public.scoreboard_rollup_dirty (tenant_id, day) VALUES (p_tenant, v_day);
END $$;

-- messages: human outbound, not imported, counted at dispatched_at (app.scoreboard_activity)
CREATE FUNCTION app.scoreboard_mark_messages() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.direction = 'outbound' AND OLD.initiator = 'human' AND NOT OLD.imported THEN
    PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.dispatched_at);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.direction = 'outbound' AND NEW.initiator = 'human' AND NOT NEW.imported THEN
    PERFORM app.scoreboard_mark(NEW.tenant_id, NEW.dispatched_at);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER scoreboard_mark_ins AFTER INSERT ON messages FOR EACH ROW
  WHEN (NEW.direction = 'outbound' AND NEW.initiator = 'human' AND NOT NEW.imported AND NEW.dispatched_at IS NOT NULL)
  EXECUTE FUNCTION app.scoreboard_mark_messages();
CREATE TRIGGER scoreboard_mark_upd AFTER UPDATE OF dispatched_at, initiated_by_user_id, direction, initiator, imported ON messages FOR EACH ROW
  WHEN (OLD.dispatched_at IS DISTINCT FROM NEW.dispatched_at OR OLD.initiated_by_user_id IS DISTINCT FROM NEW.initiated_by_user_id
        OR OLD.direction IS DISTINCT FROM NEW.direction OR OLD.initiator IS DISTINCT FROM NEW.initiator OR OLD.imported IS DISTINCT FROM NEW.imported)
  EXECUTE FUNCTION app.scoreboard_mark_messages();
CREATE TRIGGER scoreboard_mark_del AFTER DELETE ON messages FOR EACH ROW
  WHEN (OLD.direction = 'outbound' AND OLD.initiator = 'human' AND NOT OLD.imported AND OLD.dispatched_at IS NOT NULL)
  EXECUTE FUNCTION app.scoreboard_mark_messages();

-- calls: human outbound, not imported, counted at started_at
CREATE FUNCTION app.scoreboard_mark_calls() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.direction = 'outbound' AND OLD.initiator = 'human' AND NOT OLD.imported THEN
    PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.started_at);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.direction = 'outbound' AND NEW.initiator = 'human' AND NOT NEW.imported THEN
    PERFORM app.scoreboard_mark(NEW.tenant_id, NEW.started_at);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER scoreboard_mark_ins AFTER INSERT ON calls FOR EACH ROW
  WHEN (NEW.direction = 'outbound' AND NEW.initiator = 'human' AND NOT NEW.imported)
  EXECUTE FUNCTION app.scoreboard_mark_calls();
CREATE TRIGGER scoreboard_mark_upd AFTER UPDATE OF started_at, agent_user_id, direction, initiator, imported ON calls FOR EACH ROW
  WHEN (OLD.started_at IS DISTINCT FROM NEW.started_at OR OLD.agent_user_id IS DISTINCT FROM NEW.agent_user_id
        OR OLD.direction IS DISTINCT FROM NEW.direction OR OLD.initiator IS DISTINCT FROM NEW.initiator OR OLD.imported IS DISTINCT FROM NEW.imported)
  EXECUTE FUNCTION app.scoreboard_mark_calls();
CREATE TRIGGER scoreboard_mark_del AFTER DELETE ON calls FOR EACH ROW
  WHEN (OLD.direction = 'outbound' AND OLD.initiator = 'human' AND NOT OLD.imported)
  EXECUTE FUNCTION app.scoreboard_mark_calls();

-- appointments: set (created_at, created_by_kind 'user'), held / due (starts_at, status, not imported)
CREATE FUNCTION app.scoreboard_mark_appointments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.created_by_kind <> 'import' THEN
    PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.created_at);
    PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.starts_at);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.created_by_kind <> 'import' THEN
    PERFORM app.scoreboard_mark(NEW.tenant_id, NEW.created_at);
    PERFORM app.scoreboard_mark(NEW.tenant_id, NEW.starts_at);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER scoreboard_mark_ins AFTER INSERT ON appointments FOR EACH ROW
  WHEN (NEW.created_by_kind <> 'import')
  EXECUTE FUNCTION app.scoreboard_mark_appointments();
CREATE TRIGGER scoreboard_mark_upd AFTER UPDATE OF status, starts_at, created_at, user_id, set_by_user_id, created_by_kind ON appointments FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.starts_at IS DISTINCT FROM NEW.starts_at OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.set_by_user_id IS DISTINCT FROM NEW.set_by_user_id
        OR OLD.created_by_kind IS DISTINCT FROM NEW.created_by_kind)
  EXECUTE FUNCTION app.scoreboard_mark_appointments();
CREATE TRIGGER scoreboard_mark_del AFTER DELETE ON appointments FOR EACH ROW
  WHEN (OLD.created_by_kind <> 'import')
  EXECUTE FUNCTION app.scoreboard_mark_appointments();

-- agreements: deal_stage_history to agreement_signed at changed_at, credited to the deal's CURRENT owner
CREATE FUNCTION app.scoreboard_mark_stage_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.to_stage = 'agreement_signed' THEN
    PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.changed_at);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.to_stage = 'agreement_signed' THEN
    PERFORM app.scoreboard_mark(NEW.tenant_id, NEW.changed_at);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER scoreboard_mark_ins AFTER INSERT ON deal_stage_history FOR EACH ROW
  WHEN (NEW.to_stage = 'agreement_signed')
  EXECUTE FUNCTION app.scoreboard_mark_stage_history();
CREATE TRIGGER scoreboard_mark_upd AFTER UPDATE ON deal_stage_history FOR EACH ROW
  EXECUTE FUNCTION app.scoreboard_mark_stage_history();
CREATE TRIGGER scoreboard_mark_del AFTER DELETE ON deal_stage_history FOR EACH ROW
  WHEN (OLD.to_stage = 'agreement_signed')
  EXECUTE FUNCTION app.scoreboard_mark_stage_history();

-- a deal changing owner moves every agreement it ever signed to the new owner
CREATE FUNCTION app.scoreboard_mark_deal_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT h.changed_at FROM public.deal_stage_history h
            WHERE h.tenant_id = NEW.tenant_id AND h.deal_id = NEW.id AND h.to_stage = 'agreement_signed' LOOP
    PERFORM app.scoreboard_mark(NEW.tenant_id, r.changed_at);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER scoreboard_mark_owner AFTER UPDATE OF owner_user_id ON deals FOR EACH ROW
  WHEN (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id)
  EXECUTE FUNCTION app.scoreboard_mark_deal_owner();

-- the ownership ledger: a row r can change the speed row of r itself (an SLA period start) and of the
-- period r falls in (the latest period start before r: a first touch, or an event that ends the window)
CREATE FUNCTION app.scoreboard_mark_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.type IN ('offer_accepted','claimed','assigned','reassigned') THEN
      PERFORM app.scoreboard_mark(OLD.tenant_id, OLD.occurred_at);
    END IF;
    SELECT e.occurred_at INTO v FROM public.lead_ownership_events e
     WHERE e.tenant_id = OLD.tenant_id AND e.contact_id = OLD.contact_id AND e.seq < OLD.seq
       AND e.type IN ('offer_accepted','claimed','assigned','reassigned')
     ORDER BY e.seq DESC LIMIT 1;
    PERFORM app.scoreboard_mark(OLD.tenant_id, v);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.type IN ('offer_accepted','claimed','assigned','reassigned') THEN
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
       AND e.type IN ('offer_accepted','claimed','assigned','reassigned')
     ORDER BY e.seq DESC LIMIT 1;
    PERFORM app.scoreboard_mark(NEW.tenant_id, v);
  END IF;
  RETURN NULL;
END $$;
-- appended rows (the only app path) change a period only as its start or its first touch
CREATE TRIGGER scoreboard_mark_ins AFTER INSERT ON lead_ownership_events FOR EACH ROW
  WHEN (NEW.type IN ('first_touch_recorded','offer_accepted','claimed','assigned','reassigned'))
  EXECUTE FUNCTION app.scoreboard_mark_ledger();
CREATE TRIGGER scoreboard_mark_upd AFTER UPDATE ON lead_ownership_events FOR EACH ROW
  EXECUTE FUNCTION app.scoreboard_mark_ledger();
CREATE TRIGGER scoreboard_mark_del AFTER DELETE ON lead_ownership_events FOR EACH ROW
  EXECUTE FUNCTION app.scoreboard_mark_ledger();

-- -----------------------------------------------------------------------------
-- 5. The rollup job's definers (system actor of the tenant only)
-- -----------------------------------------------------------------------------
-- Horizon sample (invariant b). Must be the first write of a fresh transaction, so the xid it takes is
-- newer than every xid assigned before its clock reading. Keeps an older unconsumed sample (progress is
-- guaranteed once the transactions older than it end). Returns whether a sample was recorded.
CREATE FUNCTION app.scoreboard_rollup_sample() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid := app.tenant_id();
  v_at     timestamptz;
  v_xid    bigint;
  v_n      integer;
BEGIN
  IF v_tenant IS NULL OR app.actor_kind() <> 'system' OR app.principal_type() IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'SCOREBOARD_ROLLUP_SYSTEM_ONLY' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'SCOREBOARD_ROLLUP_SAMPLE_NOT_FIRST: the horizon sample needs a transaction of its own'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_at := clock_timestamp();
  v_xid := pg_current_xact_id()::text::bigint;
  INSERT INTO public.scoreboard_rollup_state AS s (tenant_id, zone, pending_at, pending_xid)
  SELECT v_tenant, ts.default_timezone, v_at, v_xid FROM public.tenant_settings ts WHERE ts.tenant_id = v_tenant
  ON CONFLICT (tenant_id) DO UPDATE SET pending_at = EXCLUDED.pending_at, pending_xid = EXCLUDED.pending_xid, updated_at = now()
   WHERE s.pending_xid IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

-- Rolls the tenant's closed, safe days that are missing (or rolled in another zone) or marked dirty,
-- most recent first, at most p_max_days per call, inside the last p_window_days days; drops what is
-- older. Idempotent: a day is recomputed from the base tables and replaced whole.
CREATE FUNCTION app.scoreboard_rollup_roll(p_window_days integer DEFAULT 92, p_max_days integer DEFAULT 31)
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

    -- the same filters as app.scoreboard_activity (0012), bucketed by the same day boundaries
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

-- -----------------------------------------------------------------------------
-- 6. Ownership and grants (definers: app_definer, pinned search_path; 0001 §22 self-check)
-- -----------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.scoreboard_mark(uuid, timestamptz)','app.scoreboard_mark_messages()','app.scoreboard_mark_calls()',
                           'app.scoreboard_mark_appointments()','app.scoreboard_mark_stage_history()','app.scoreboard_mark_deal_owner()',
                           'app.scoreboard_mark_ledger()','app.scoreboard_rollup_sample()','app.scoreboard_rollup_roll(integer, integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app.scoreboard_mark(uuid, timestamptz) TO app_definer;
GRANT EXECUTE ON FUNCTION app.scoreboard_rollup_sample() TO app_user;
GRANT EXECUTE ON FUNCTION app.scoreboard_rollup_roll(integer, integer) TO app_user;

-- -----------------------------------------------------------------------------
-- 7. R-PERM-11: the statement-level support_read_only trigger on the new tables (the 0018 loop)
-- -----------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
              AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only')
            ORDER BY c.relname LOOP
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', r.relname);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 8. Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(t, ', ') INTO bad
    FROM unnest(ARRAY['scoreboard_rollup_days','scoreboard_activity_daily','scoreboard_speed_daily',
                      'scoreboard_rollup_dirty','scoreboard_rollup_state']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity AND c.relforcerowsecurity)
      OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = ('public.' || t)::regclass AND p.polname = 'tenant_isolation' AND NOT p.polpermissive)
      OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || t)::regclass AND g.tgname = 'support_read_only')
      OR has_table_privilege('app_user', 'public.' || t, 'INSERT')
      OR has_table_privilege('app_user', 'public.' || t, 'UPDATE')
      OR has_table_privilege('app_user', 'public.' || t, 'DELETE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED: scoreboard rollup table invariants: %', bad;
  END IF;
END $$;
