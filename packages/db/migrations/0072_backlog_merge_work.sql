-- =============================================================================
-- A merge moves the loser's tasks and appointments (lane backlog-gaps; DATA_MODEL R-OWN-24, R-PLAN-3, E549-E552).
-- The number is a placeholder: the orchestrator renumbers at merge, and nothing in code or tests names this file.
-- Earlier migrations are not edited.
--
-- The gap. A merge moved the loser's points, tags, notes, stage history (0027), chat sessions (0046), listing and deal
-- roles (0053/0059), messages, handbacks and enrollments (db ownership/merge.ts), but not its tasks and appointments:
-- they kept naming the merged-away record, which no screen lists and the weekly plan rightly skips (b7 ownership-data/
-- F5), so a promise, a callback or an appointment awaiting its outcome silently left the agent's work.
--
-- The fix. A new trigger on the same event as the other merge triggers moves every task and appointment of the loser
-- to the survivor, in the merge transaction itself (whoever the merging actor is: a Team Lead's merge included, with
-- no follow-up). Only contact_id (and updated_at) change: the assignee, the appointment's user, the status and the
-- times stay. The invoker triggers on those tables still run: appointments_sync_version (0018) bumps sync_version once
-- (contact_id is a content column, so calendar.reconcile re-pushes a FUTURE appointment once: the event title may name
-- the person; a past one is never re-pushed, apps/api calendar/repos/links.ts), and feed_mark_tasks /
-- feed_mark_appointments (0034) mark the feed groups of the old and new contact for the assignee or user.
-- Rows of records merged before this migration move to the ROOT survivor of their merge chain (section 2).
--
-- Ordering. contacts_merge_children < contacts_merge_roles < contacts_merge_webchat_sessions < contacts_merge_work, so
-- this fires last; it reads nothing the others write.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21 "backlog-gaps: merge work"):
--   * new SECURITY DEFINER trigger function app.contacts_merge_work() (owner app_definer, search_path pinned to
--     pg_catalog, public, EXECUTE revoked from PUBLIC; nobody may execute it). It acts only for a row the ownership
--     engine's merge just marked merged away (the same fence as app.contacts_merge_roles: the current ownership command
--     appended that row's merged_away event, and *_backlog_merge_guard's contacts_guard refuses any other write of
--     the column under a tenant), only inside that row's tenant, only on rows naming the merged-away record, and only
--     towards the survivor the merge chose. It moves no opt-out state, sends nothing and reveals nothing: who may read a
--     task or an appointment is decided by the unchanged policies (assignee / user and their contact).
--   * least-privilege grants to app_definer: UPDATE (contact_id, updated_at) ON tasks and ON appointments. sync_version
--     is set by the BEFORE trigger on NEW (no column privilege needed); INSERT ON feed_dirty exists (0034); SELECT on
--     every table (0001).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The merge trigger
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.contacts_merge_work() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  s uuid := NEW.merged_into_contact_id;
  l uuid := NEW.id;
  t uuid := NEW.tenant_id;
BEGIN
  IF app.tenant_id() IS NOT NULL AND t IS DISTINCT FROM app.tenant_id() THEN RETURN NULL; END IF;
  IF s IS NULL OR s = l OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = t AND c.id = s) THEN
    RETURN NULL;
  END IF;
  -- only the ownership engine's merge: merged_into_contact_id set in the same ownership command that appended the
  -- loser's merged_away event (as app.contacts_merge_roles; a superuser's bare UPDATE with no tenant context moves nothing)
  IF app.ownership_command() IS NULL OR NEW.ownership_command_id IS DISTINCT FROM app.ownership_command()
     OR NOT EXISTS (SELECT 1 FROM public.lead_ownership_events e
                     WHERE e.tenant_id = t AND e.contact_id = l AND e.type = 'merged_away' AND e.command_id = app.ownership_command()) THEN
    RETURN NULL;
  END IF;
  -- the person's work follows the person: assignee, user, status and times unchanged
  UPDATE public.tasks x SET contact_id = s, updated_at = now() WHERE x.tenant_id = t AND x.contact_id = l;
  UPDATE public.appointments x SET contact_id = s, updated_at = now() WHERE x.tenant_id = t AND x.contact_id = l;
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_merge_work() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contacts_merge_work() FROM PUBLIC;
GRANT UPDATE (contact_id, updated_at) ON tasks TO app_definer;
GRANT UPDATE (contact_id, updated_at) ON appointments TO app_definer;
CREATE TRIGGER contacts_merge_work AFTER UPDATE OF merged_into_contact_id ON contacts
  FOR EACH ROW WHEN (OLD.merged_into_contact_id IS NULL AND NEW.merged_into_contact_id IS NOT NULL)
  EXECUTE FUNCTION app.contacts_merge_work();

-- -----------------------------------------------------------------------------
-- 2. Tasks and appointments of records merged away before this migration (runs as the migration owner): each moves to
--    the ROOT survivor of its record's merge chain (merged_into_contact_id followed up, at most 64 hops, as 0046/0053).
--    A future appointment's sync_version moves, so the next calendar.reconcile re-pushes it once.
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE backlog_merge_work_root ON COMMIT DROP AS
WITH RECURSIVE up(tenant_id, loser, cur, depth) AS (
  SELECT c.tenant_id, c.id, c.merged_into_contact_id, 1 FROM public.contacts c WHERE c.merged_into_contact_id IS NOT NULL
  UNION ALL
  SELECT up.tenant_id, up.loser, c.merged_into_contact_id, up.depth + 1
    FROM up JOIN public.contacts c ON c.tenant_id = up.tenant_id AND c.id = up.cur AND c.merged_into_contact_id IS NOT NULL
   WHERE up.depth < 64
)
SELECT DISTINCT ON (tenant_id, loser) tenant_id, loser, cur AS root FROM up ORDER BY tenant_id, loser, depth DESC;

UPDATE public.tasks x SET contact_id = m.root, updated_at = now()
  FROM backlog_merge_work_root m WHERE m.tenant_id = x.tenant_id AND m.loser = x.contact_id AND m.root <> x.contact_id;
UPDATE public.appointments x SET contact_id = m.root, updated_at = now()
  FROM backlog_merge_work_root m WHERE m.tenant_id = x.tenant_id AND m.loser = x.contact_id AND m.root <> x.contact_id;

-- -----------------------------------------------------------------------------
-- 3. Self-check: the definer's shape and fence, its grants, its trigger (binding and order)
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF NOT (SELECT p.prosecdef AND r.rolname = 'app_definer' AND p.proconfig = ARRAY['search_path=pg_catalog, public']
            FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'app.contacts_merge_work()'::regprocedure) THEN
    bad := bad || ' definer_shape';
  END IF;
  IF has_function_privilege('public', 'app.contacts_merge_work()', 'EXECUTE') THEN bad := bad || ' public_execute'; END IF;
  IF has_function_privilege('app_user', 'app.contacts_merge_work()', 'EXECUTE') THEN bad := bad || ' app_user_execute'; END IF;
  IF NOT (SELECT p.prosrc LIKE '%merged_away%' AND p.prosrc LIKE '%app.ownership_command()%'
                 AND p.prosrc LIKE '%UPDATE public.tasks x SET contact_id = s%' AND p.prosrc LIKE '%UPDATE public.appointments x SET contact_id = s%'
                 AND p.prosrc LIKE '%x.tenant_id = t AND x.contact_id = l%'
            FROM pg_proc p WHERE p.oid = 'app.contacts_merge_work()'::regprocedure) THEN
    bad := bad || ' merge_work_rules';
  END IF;
  IF NOT (has_column_privilege('app_definer', 'public.tasks', 'contact_id', 'UPDATE')
          AND has_column_privilege('app_definer', 'public.tasks', 'updated_at', 'UPDATE')
          AND has_column_privilege('app_definer', 'public.appointments', 'contact_id', 'UPDATE')
          AND has_column_privilege('app_definer', 'public.appointments', 'updated_at', 'UPDATE')) THEN
    bad := bad || ' grants';
  END IF;
  IF has_table_privilege('app_definer', 'public.tasks', 'UPDATE') OR has_table_privilege('app_definer', 'public.appointments', 'UPDATE')
     OR has_column_privilege('app_definer', 'public.tasks', 'assignee_user_id', 'UPDATE')
     OR has_column_privilege('app_definer', 'public.appointments', 'user_id', 'UPDATE') THEN
    bad := bad || ' grants_too_wide';
  END IF;
  -- AFTER UPDATE OF merged_into_contact_id, FOR EACH ROW (tgtype: ROW 1, BEFORE 2 unset, UPDATE 16), with the WHEN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg
                  WHERE tg.tgrelid = 'public.contacts'::regclass AND tg.tgname = 'contacts_merge_work' AND NOT tg.tgisinternal
                    AND tg.tgfoid = 'app.contacts_merge_work()'::regprocedure AND tg.tgenabled = 'O'
                    AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 0 AND (tg.tgtype & 16) = 16 AND (tg.tgtype & (4 | 8)) = 0
                    AND tg.tgattr = (SELECT attnum::text::int2vector FROM pg_attribute
                                      WHERE attrelid = 'public.contacts'::regclass AND attname = 'merged_into_contact_id')
                    AND tg.tgqual IS NOT NULL) THEN
    bad := bad || ' trigger_binding';
  END IF;
  -- it fires last among the merge triggers (same event: name order)
  IF (SELECT max(tgname COLLATE "C") FROM pg_trigger WHERE tgrelid = 'public.contacts'::regclass AND tgname LIKE 'contacts\_merge\_%')
     IS DISTINCT FROM 'contacts_merge_work' THEN
    bad := bad || ' trigger_order';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (backlog merge work):%', bad; END IF;
END $$;
