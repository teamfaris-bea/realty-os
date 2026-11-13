-- =============================================================================
-- 0086_b13_review_seller_guard: batch 13 review fix for the AI ISA seller watch's guard (finding db-security/F1;
-- R-ISA-18, R-ISA-15, E502, E538; docs/ARCHITECTURE §21.51, correcting §21.46). Why schema and not code: the gap is in
-- the guard (0084), which exists to hold the column split against any app_user write, whatever route issues it.
--
-- 0084's app.ai_isa_seller_watch_guard() starts with the address-gone branch (an UPDATE that sets contact_address_id
-- from a value to NULL): it nulls the subject and, for an UPDATE, RETURNs at once (moved first by the batch 13 merge
-- for R-DATA-7, so the tenantless retention purge's foreign key action clears a confirmed subject). That return skipped
-- every later rule, so one UPDATE by anyone in seller_watch_update's audience (a Team Lead, a collaborator, the
-- survivor's agent after a merge) that nulled the address could also clear the system's pricing suspension
-- (comps_suspended_at), forge an owner resume (comps_resumed_* with the owner's id), dismiss near matches, write the
-- snapshots, the comps check or last_run_at, clear a dispute or set the cleared reason, with no audit row. No API route
-- issues such an UPDATE (every write to the table is in isa/seller/*), so this is defence in depth for the column split.
--
-- The change: in that branch, before the early RETURN, an UPDATE by a non-system actor that changes any column other
-- than the subject (which the branch nulls itself) and updated_at is refused ISA_SUBJECT_OWNER_ONLY; the cleared
-- reason must be the guard's value ('address_deleted' for a confirmed subject, else the old one). The foreign key's
-- SET NULL (contact_address_id) changes nothing else, so an address delete (whoever deletes, as 0084) and the
-- tenantless purge still clear the subject. The system's own writes are unchanged. Every other line of the function
-- is 0084's, verbatim (diffed by the self-check below only for the new rule and the branch order).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * no new function, grant, policy or definer: CREATE OR REPLACE of 0084's INVOKER guard (owner and ACL unchanged:
--     CREATE OR REPLACE keeps them); the trigger ai_isa_seller_watch_guard (0084) is unchanged and still points at it.
--   * only narrows: every write refused before is refused now; the one new refusal is a non-system address-nulling
--     UPDATE that also changes another column.
--   * self-check below: the branch still runs before the foreign-tenant return (0084's assertion), and it now carries
--     the non-system rule before its RETURN.
-- Proof: packages/db/test/rls_smoke_ai_isa_seller.test.ts (b13 review F1 case; fails without this migration).
-- =============================================================================

CREATE OR REPLACE FUNCTION app.ai_isa_seller_watch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind      text := app.actor_kind();
  me        uuid := app.user_id();
  a_owner   uuid;
  a_contact uuid;
  a_side    text;
  a_ended   timestamptz;
  is_owner  boolean;
  subj_old  jsonb;
  subj_new  jsonb;
  confirming boolean;
  clearing   boolean;
  sys_changed boolean;
BEGIN
  -- the address is gone (its delete's foreign key action, run as the table owner, or any actor): the subject goes
  -- with it. Nothing else is read here, so the foreign key path never depends on the caller's RLS. It runs before the
  -- foreign-tenant return below (batch 13 merge, ISA-3 F7): the retention purge deletes addresses with no
  -- app.tenant_id, and a confirmed subject left behind would fail the CHECK and abort the purge (R-DATA-7).
  IF NEW.contact_address_id IS NULL AND (TG_OP = 'INSERT' OR OLD.contact_address_id IS NOT NULL) THEN
    IF TG_OP = 'UPDATE' AND OLD.subject_confirmed_at IS NOT NULL THEN NEW.subject_cleared_reason := 'address_deleted'; END IF;
    NEW.subject_address_key := NULL; NEW.subject_connection_id := NULL; NEW.subject_record_listing_id := NULL;
    NEW.subject_record_date := NULL; NEW.subject_facts := NULL;
    NEW.subject_confirmed_by_user_id := NULL; NEW.subject_confirmed_at := NULL;
    IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.assignment_id, NEW.contact_id) IS DISTINCT FROM (OLD.tenant_id, OLD.assignment_id, OLD.contact_id) THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the assignment and contact of a seller watch never change' USING ERRCODE = 'check_violation';
    END IF;
    -- 0086 (b13 review F1): the early return below skips every later rule, so a non-system UPDATE that nulls the
    -- address may change nothing else. The foreign key's SET NULL (an address delete, the tenantless purge) changes
    -- only contact_address_id and passes; the subject columns are the guard's own (nulled above), and the cleared
    -- reason is the guard's value ('address_deleted' for a confirmed subject, else unchanged).
    IF TG_OP = 'UPDATE' AND app.actor_kind() IS DISTINCT FROM 'system'
       AND ((NEW.near_match_dismissed, NEW.last_snapshot, NEW.snapshot_versions, NEW.last_comps_check, NEW.last_run_at, NEW.comps_suspended_at,
             NEW.comps_resumed_at, NEW.comps_resumed_by_user_id, NEW.comps_resumed_reason, NEW.subject_disputed_at, NEW.created_at)
            IS DISTINCT FROM
            (OLD.near_match_dismissed, OLD.last_snapshot, OLD.snapshot_versions, OLD.last_comps_check, OLD.last_run_at, OLD.comps_suspended_at,
             OLD.comps_resumed_at, OLD.comps_resumed_by_user_id, OLD.comps_resumed_reason, OLD.subject_disputed_at, OLD.created_at)
        OR NEW.subject_cleared_reason IS DISTINCT FROM (CASE WHEN OLD.subject_confirmed_at IS NOT NULL THEN 'address_deleted' ELSE OLD.subject_cleared_reason END)) THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: an address that goes takes only the subject with it; nothing else changes in the same write' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); RETURN NEW; END IF;
  END IF;

  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  NEW.updated_at := now();

  SELECT a.owner_user_id, a.contact_id, a.side, a.ended_at INTO a_owner, a_contact, a_side, a_ended
    FROM public.ai_isa_assignments a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assignment_id;
  IF a_owner IS NULL OR a_contact IS DISTINCT FROM NEW.contact_id OR a_side NOT IN ('seller','both') THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: a seller watch belongs to a seller- or both-side assignment of its contact' USING ERRCODE = 'check_violation';
  END IF;
  is_owner := kind = 'user' AND me IS NOT NULL AND me = a_owner AND a_ended IS NULL;

  subj_new := jsonb_build_array(NEW.contact_address_id, NEW.subject_address_key, NEW.subject_connection_id, NEW.subject_record_listing_id,
                                NEW.subject_record_date, NEW.subject_facts, NEW.subject_confirmed_by_user_id, NEW.subject_confirmed_at);
  IF TG_OP = 'INSERT' THEN
    subj_old := jsonb_build_array(NEW.contact_address_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  ELSE
    IF (NEW.tenant_id, NEW.assignment_id, NEW.contact_id, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.assignment_id, OLD.contact_id, OLD.created_at) THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the assignment and contact of a seller watch never change' USING ERRCODE = 'check_violation';
    END IF;
    subj_old := jsonb_build_array(OLD.contact_address_id, OLD.subject_address_key, OLD.subject_connection_id, OLD.subject_record_listing_id,
                                  OLD.subject_record_date, OLD.subject_facts, OLD.subject_confirmed_by_user_id, OLD.subject_confirmed_at);
  END IF;
  confirming := subj_new IS DISTINCT FROM subj_old AND NEW.subject_confirmed_at IS NOT NULL;
  clearing := subj_new IS DISTINCT FROM subj_old AND NEW.subject_confirmed_at IS NULL
              AND NEW.subject_address_key IS NULL AND NEW.subject_connection_id IS NULL AND NEW.subject_record_listing_id IS NULL
              AND NEW.subject_record_date IS NULL AND NEW.subject_facts IS NULL;
  IF subj_new IS DISTINCT FROM subj_old AND NOT confirming AND NOT clearing AND NOT (TG_OP = 'UPDATE'
       AND NEW.contact_address_id IS DISTINCT FROM OLD.contact_address_id AND NEW.subject_confirmed_at IS NULL AND OLD.subject_confirmed_at IS NULL
       AND (NEW.subject_address_key, NEW.subject_connection_id, NEW.subject_record_listing_id, NEW.subject_record_date, NEW.subject_facts) IS NOT DISTINCT FROM
           (OLD.subject_address_key, OLD.subject_connection_id, OLD.subject_record_listing_id, OLD.subject_record_date, OLD.subject_facts)) THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the subject is confirmed whole or cleared whole' USING ERRCODE = 'check_violation';
  END IF;

  -- the confirmation: only the live assignment's owner, as themselves, at the database clock; the system never
  IF confirming THEN
    IF kind = 'system' THEN
      RAISE EXCEPTION 'ISA_SUBJECT_SYSTEM_NEVER_CONFIRMS: only the lead''s owner confirms the seller''s home' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT is_owner OR NEW.subject_confirmed_by_user_id IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner, as themselves, confirms the seller''s home' USING ERRCODE = 'check_violation';
    END IF;
    NEW.subject_confirmed_at := now();
    NEW.subject_cleared_reason := NULL;
    NEW.subject_disputed_at := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.subject_disputed_at IS NOT NULL OR NEW.comps_suspended_at IS NOT NULL OR NEW.comps_resumed_at IS NOT NULL OR cardinality(NEW.near_match_dismissed) > 0
       OR NEW.last_snapshot <> '{}'::jsonb OR NEW.snapshot_versions <> '{}'::jsonb OR NEW.last_comps_check IS NOT NULL OR NEW.last_run_at IS NOT NULL THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: a seller watch starts empty' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- the owner's own columns: near-match dismissals and an owner resume
  IF NEW.near_match_dismissed IS DISTINCT FROM OLD.near_match_dismissed AND NOT is_owner THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner says a live listing is a different home' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.comps_resumed_at, NEW.comps_resumed_by_user_id, NEW.comps_resumed_reason) IS DISTINCT FROM (OLD.comps_resumed_at, OLD.comps_resumed_by_user_id, OLD.comps_resumed_reason) THEN
    IF NEW.comps_resumed_at IS NULL THEN
      IF kind <> 'system' THEN RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the system clears a comps resume' USING ERRCODE = 'check_violation'; END IF;
    ELSIF kind = 'system' THEN
      IF NEW.comps_resumed_reason NOT IN ('cma_prepared','cma_shared') THEN
        RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the system resumes comps only after the owner''s CMA' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT is_owner OR NEW.comps_resumed_reason <> 'owner_resume' OR NEW.comps_resumed_by_user_id IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner, as themselves, lets the assistant keep sharing recent sales' USING ERRCODE = 'check_violation';
    ELSE
      NEW.comps_resumed_at := now();
    END IF;
  END IF;

  -- the system's columns: snapshots, the comps check, runs and the suspension. A user may mark the subject disputed
  -- (set, never clear) and the owner's confirmation clears it.
  sys_changed := (NEW.last_snapshot, NEW.snapshot_versions, NEW.last_comps_check, NEW.last_run_at, NEW.comps_suspended_at)
                 IS DISTINCT FROM (OLD.last_snapshot, OLD.snapshot_versions, OLD.last_comps_check, OLD.last_run_at, OLD.comps_suspended_at);
  IF sys_changed AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the watch''s runs and checks are the system''s' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.subject_disputed_at IS DISTINCT FROM OLD.subject_disputed_at AND NOT confirming AND NEW.subject_disputed_at IS NULL AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: a dispute is cleared by the owner''s confirmation' USING ERRCODE = 'check_violation';
  END IF;

  -- any other user: only clears the subject (an address edit's trigger runs as the editor) or marks it disputed
  IF kind = 'user' AND NOT is_owner AND subj_new IS DISTINCT FROM subj_old AND NOT clearing THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner confirms the seller''s home' USING ERRCODE = 'check_violation';
  END IF;
  -- (batch 13, ISA-3 audit F11) the watch's address and the cleared reason the panel shows: a user points the watch at
  -- another address only by confirming (the owner, at the current default), never by clearing; the reason changes only
  -- with a clear or a confirmation, and a user's clear is always an address change (the guard's value, not the caller's)
  IF NEW.contact_address_id IS DISTINCT FROM OLD.contact_address_id AND NOT confirming AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner, confirming the home, points the watch at another address' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.subject_cleared_reason IS DISTINCT FROM OLD.subject_cleared_reason AND NOT confirming AND NOT clearing AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the cleared reason changes only when the subject is cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF clearing AND kind <> 'system' THEN NEW.subject_cleared_reason := 'address_changed';
  ELSIF clearing AND NEW.subject_cleared_reason IS NULL THEN NEW.subject_cleared_reason := 'address_changed'; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = 'app.ai_isa_seller_watch_guard()'::regprocedure;
  IF position('IF NEW.contact_address_id IS NULL AND' IN src) = 0
     OR position('IF NEW.contact_address_id IS NULL AND' IN src) > position('IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id' IN src) THEN
    RAISE EXCEPTION '0086 self-check failed: the address-gone branch must run before the foreign-tenant return';
  END IF;
  IF position('an address that goes takes only the subject with it' IN src) = 0
     OR position('an address that goes takes only the subject with it' IN src) > position('IF TG_OP = ''UPDATE'' THEN NEW.updated_at := now(); RETURN NEW; END IF;' IN src) THEN
    RAISE EXCEPTION '0086 self-check failed: the address-gone branch refuses no other column before its early return';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app.ai_isa_seller_watch_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0086 self-check failed: the seller watch guard must stay an invoker';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.ai_isa_seller_watch'::regclass AND t.tgname = 'ai_isa_seller_watch_guard'
                   AND t.tgfoid = 'app.ai_isa_seller_watch_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0086 self-check failed: the seller watch guard trigger is missing';
  END IF;
END $$;
