-- =============================================================================
-- A website chat follows a person merge (batch 6 review findings optouts/F2, tenancy-public/F1, ui-compose/F2;
-- DATA_MODEL R-OWN-24, R-INBOX-1, E138, E140). The number is a placeholder: the orchestrator renumbers at merge, and
-- nothing in code or tests names this file. 0001-0045 are not edited.
--
-- The gap. A merge copies every point of the loser onto the survivor under a new id (0027 app.contacts_merge_children,
-- R-PAR-11: a point's contact never changes) and moves the loser's messages to the survivor (db/ownership/merge.ts),
-- and inbound already follows the merge: a visitor's next message resolves the session's chat identity by address over
-- live records, so it lands on the survivor. Nothing moved webchat_sessions: a session kept naming the merged-away
-- record and its original point. Every reply path finds a chat through the session's point (api
-- channels/repos/webchat.ts chatRoutesFor: s.contact_point_id = p.id, used by reachability, compose and dispatch), so
-- the survivor had no chat (a reply was 422 CONTACT_POINT_MISSING), the merged-away record refused (409
-- CONTACT_MERGED), and the visitor's still-open chat could never be answered; the claim the visitor typed was read only
-- from sessions of the record they name (leads/repos/contacts.ts chatClaims), so it vanished from the survivor, and a
-- returning visitor who typed it again matched nobody (contactsWithClaim skips merged-away records).
--
-- The fix: in the merge transaction itself, the loser's sessions move to the survivor and to the survivor's copy of the
-- same chat identity (same address, kind web_chat; the copy 0027 just made). The visitor's poll and messages keep
-- working unchanged: both match on that identity's address, which is the session's own (0044 app.webchat_poll), and the
-- dispatch guard's RECIPIENT_NOT_A_CONTACT_POINT check finds the copy on the survivor. Sessions of records merged away
-- before this migration are moved the same way, to the root survivor of their merge chain (section 2).
--
-- Ordering. Both this trigger and 0027's contacts_merge_children are AFTER UPDATE OF merged_into_contact_id row
-- triggers on contacts with the same WHEN; PostgreSQL fires triggers of the same event in name order, and
-- "contacts_merge_children" < "contacts_merge_webchat_sessions", so the copy exists when this runs. A session whose
-- copy is missing anyway (0027 never aborts a merge, so a failed copy leaves the loser its point) stays where it was:
-- nothing is pointed at a point that does not exist.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.13):
--   * new SECURITY DEFINER trigger function app.webchat_sessions_follow_merge() (owner app_definer, pinned
--     search_path, EXECUTE revoked from PUBLIC). It acts only for a row whose merged_into_contact_id was just set by
--     the ownership engine's merge (applyOwnershipCommand, whoever the actor is: a person cannot write webchat_sessions
--     at all, 0018 webchat_system), only inside that row's tenant, only on sessions of the merged-away record, and only
--     towards the survivor's own chat identity with the session's own address. It writes no opt-out state and moves no
--     message; it reveals nothing: a staff user reads a session only through 0018 webchat_staff_read (the survivor's
--     detail), exactly as they read the messages the merge already moved to the survivor.
--   * grant to app_definer (least privilege for the above): UPDATE (contact_id, contact_point_id) ON webchat_sessions.
--     SELECT on webchat_sessions (0018, 0044) and on contact_points (0027) exists already.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The merge trigger
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.webchat_sessions_follow_merge() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
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
  -- each session of the loser moves to the survivor's copy of its own chat identity (the address is the session's own)
  UPDATE public.webchat_sessions ws
     SET contact_id = s, contact_point_id = sp.id
    FROM public.contact_points lp
    JOIN public.contact_points sp ON sp.tenant_id = lp.tenant_id AND sp.contact_id = s AND sp.kind = 'web_chat'
                                 AND sp.address = lp.address
   WHERE ws.tenant_id = t AND ws.contact_id = l
     AND lp.tenant_id = t AND lp.id = ws.contact_point_id AND lp.contact_id = l AND lp.kind = 'web_chat';
  RETURN NULL;
END $$;
ALTER FUNCTION app.webchat_sessions_follow_merge() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.webchat_sessions_follow_merge() FROM PUBLIC;
GRANT UPDATE (contact_id, contact_point_id) ON webchat_sessions TO app_definer;
CREATE TRIGGER contacts_merge_webchat_sessions AFTER UPDATE OF merged_into_contact_id ON contacts
  FOR EACH ROW WHEN (OLD.merged_into_contact_id IS NULL AND NEW.merged_into_contact_id IS NOT NULL)
  EXECUTE FUNCTION app.webchat_sessions_follow_merge();

-- -----------------------------------------------------------------------------
-- 2. Sessions of records merged away before this migration (runs as the migration owner)
-- -----------------------------------------------------------------------------
-- Each one moves to the ROOT survivor of its record's merge chain (merged_into_contact_id followed up, at most 64 hops)
-- and to that survivor's copy of the session's own chat identity: every merge along the chain copied the points of the
-- record merged away, the earlier copies included. A session whose root holds no such copy stays where it is.
WITH RECURSIVE up(session_id, tenant_id, cur, address, depth) AS (
  SELECT ws.id, ws.tenant_id, c.merged_into_contact_id, p.address, 1
    FROM public.webchat_sessions ws
    JOIN public.contacts c ON c.tenant_id = ws.tenant_id AND c.id = ws.contact_id AND c.merged_into_contact_id IS NOT NULL
    JOIN public.contact_points p ON p.tenant_id = ws.tenant_id AND p.id = ws.contact_point_id AND p.kind = 'web_chat'
  UNION ALL
  SELECT up.session_id, up.tenant_id, c.merged_into_contact_id, up.address, up.depth + 1
    FROM up JOIN public.contacts c ON c.tenant_id = up.tenant_id AND c.id = up.cur AND c.merged_into_contact_id IS NOT NULL
   WHERE up.depth < 64
),
root AS (SELECT DISTINCT ON (session_id) session_id, tenant_id, cur, address FROM up ORDER BY session_id, depth DESC)
UPDATE public.webchat_sessions ws
   SET contact_id = root.cur, contact_point_id = sp.id
  FROM root
  JOIN public.contact_points sp ON sp.tenant_id = root.tenant_id AND sp.contact_id = root.cur AND sp.kind = 'web_chat'
                               AND sp.address = root.address
 WHERE ws.tenant_id = root.tenant_id AND ws.id = root.session_id;

-- -----------------------------------------------------------------------------
-- 3. Self-check: the definer's shape, its trigger after 0027's copy, nothing executable by PUBLIC
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF NOT (SELECT p.prosecdef AND r.rolname = 'app_definer' AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
            FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'app.webchat_sessions_follow_merge()'::regprocedure) THEN
    bad := bad || ' definer_shape';
  END IF;
  IF has_function_privilege('public', 'app.webchat_sessions_follow_merge()', 'EXECUTE') THEN
    bad := bad || ' public_execute';
  END IF;
  -- the copy (0027) fires first: same event, earlier name
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.contacts'::regclass AND tgname = 'contacts_merge_children')
     OR NOT ('contacts_merge_children' < 'contacts_merge_webchat_sessions' COLLATE "C") THEN
    bad := bad || ' trigger_order';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'webchat_sessions_follow_merge self-check failed:%', bad; END IF;
END $$;
