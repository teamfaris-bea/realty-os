-- =============================================================================
-- contacts_guard covers merged_into_contact_id (lane backlog-gaps; DATA_MODEL R-OWN-24, E546-E548). The number is a
-- placeholder: the orchestrator renumbers at merge, and nothing in code or tests names this file. Earlier migrations
-- are not edited.
--
-- The gap. app_user holds UPDATE on contacts.merged_into_contact_id, and app.contacts_guard() (0001) never looked at
-- the column: its `changed` tuple does not list it, so an UPDATE of only that column returned early as "nothing
-- changed". Each merge trigger (0027 contacts_merge_children, 0046 contacts_merge_webchat_sessions, 0053/0059
-- contacts_merge_roles) re-checks the ownership command on its own, but 0018 contacts_dnc_follow_merge and every
-- reader of the column (app.contact_person_ids, merge chains, the plan, the inbox, erasure) trusted it: an Owner's bare
-- UPDATE made a live record look merged away into any other record of the tenant, with no ledger event, no merge of
-- its points, tags, notes, sessions or roles, and a do-not-contact copied to the "survivor".
--
-- The fix. app.contacts_guard() is replaced (CREATE OR REPLACE, so its BEFORE INSERT OR UPDATE binding stays) with
-- 0001's body verbatim plus ONE block, after the foreign-tenant return and before the UPDATE branch (so it covers
-- INSERT too and runs before the "nothing changed" return). With a tenant context, setting merged_into_contact_id to a
-- non-NULL value (on INSERT, or an UPDATE that changes it) is allowed only when ALL hold:
--   * it is an UPDATE of a row that was not merged (OLD.merged_into_contact_id IS NULL): no re-pointing, no INSERT;
--   * app.ownership_command() is set and equals NEW.ownership_command_id;
--   * NEW.ownership_state = 'closed' and NEW.closed_reason = 'merged';
--   * the ledger holds this row's merged_away event of that command naming this survivor
--     (lower(payload->>'survivorId') = NEW.merged_into_contact_id::text; the engine may be handed an upper-case id,
--     db/locks.ts lower-cases only its lock keys, and it writes the events before the projection, apply.ts applyMerge).
-- Otherwise MERGE_UNAUDITED (insufficient_privilege). Clearing the column (the FK's ON DELETE SET NULL when a survivor
-- is erased or purged, 0001/0037) is never checked. With no tenant context nothing is checked: only a superuser or a
-- BYPASSRLS role reaches a contact row then (RESTRICTIVE tenant policies + FORCE RLS, 0001), and no definer writes the
-- column.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21 "backlog-gaps: merge guard"):
--   * app.contacts_guard() (SECURITY DEFINER) is replaced, same signature and trigger; re-asserted: owner app_definer,
--     search_path pinned to pg_catalog, public, EXECUTE revoked from PUBLIC. It only refuses more: every 0001 rule is
--     verbatim. It reads lead_ownership_events (app_definer already reads every table, 0001). No new grant, table,
--     policy or definer. The other merge triggers are not edited.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.contacts_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  cmd uuid := app.ownership_command();
  changed boolean;
  merge_set boolean;                  -- backlog-gaps
  merge_ok boolean;                   -- backlog-gaps
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN
    RETURN NEW;                       -- foreign tenant: RLS WITH CHECK rejects the row
  END IF;
  -- backlog-gaps (R-OWN-24, E546-E548): merged_into_contact_id is set only by the ownership engine's merge. Checked
  -- before the UPDATE branch, whose `changed` tuple does not list the column (a bare UPDATE would return early there).
  -- A clear to NULL (the FK's ON DELETE SET NULL) is never checked; with no tenant context only a superuser or a
  -- BYPASSRLS role reaches the row (RESTRICTIVE + FORCE RLS), so nothing is checked either.
  IF app.tenant_id() IS NOT NULL AND NEW.merged_into_contact_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      merge_set := true;
    ELSE
      merge_set := NEW.merged_into_contact_id IS DISTINCT FROM OLD.merged_into_contact_id;
    END IF;
    IF merge_set THEN
      IF TG_OP <> 'UPDATE' THEN
        merge_ok := false;                -- a record is never created merged away
      ELSE
        merge_ok := OLD.merged_into_contact_id IS NULL   -- never re-pointed
          AND cmd IS NOT NULL AND NEW.ownership_command_id IS NOT DISTINCT FROM cmd
          AND NEW.ownership_state = 'closed' AND NEW.closed_reason IS NOT DISTINCT FROM 'merged'
          AND EXISTS (SELECT 1 FROM public.lead_ownership_events e
                       WHERE e.tenant_id = NEW.tenant_id AND e.contact_id = NEW.id AND e.type = 'merged_away'
                         AND e.command_id = cmd
                         AND lower(e.payload->>'survivorId') = NEW.merged_into_contact_id::text);
      END IF;
      IF merge_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'MERGE_UNAUDITED: merged_into_contact_id is set only by the ownership engine''s merge'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.original_lead_source_id IS NOT NULL AND NEW.original_lead_source_id IS DISTINCT FROM OLD.original_lead_source_id
       OR OLD.original_campaign_ref IS NOT NULL AND NEW.original_campaign_ref IS DISTINCT FROM OLD.original_campaign_ref
       OR OLD.original_ad_ref IS NOT NULL AND NEW.original_ad_ref IS DISTINCT FROM OLD.original_ad_ref
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'ATTRIBUTION_IMMUTABLE: first-touch attribution and creator cannot change'
        USING ERRCODE = 'check_violation';
    END IF;
    changed := (NEW.ownership_state, NEW.owner_user_id, NEW.pond_id, NEW.offer_id, NEW.offered_to_user_id,
                NEW.offer_expires_at, NEW.offer_round, NEW.routing_rule_id, NEW.owned_at, NEW.first_touch_due_at,
                NEW.first_touch_at, NEW.first_touch_breached_at, NEW.release_due_at, NEW.closed_reason,
                NEW.ownership_period_seq, NEW.route_due_at,
                NEW.ownership_command_id, NEW.ownership_actor_user_id, NEW.deleted_at)
           IS DISTINCT FROM
               (OLD.ownership_state, OLD.owner_user_id, OLD.pond_id, OLD.offer_id, OLD.offered_to_user_id,
                OLD.offer_expires_at, OLD.offer_round, OLD.routing_rule_id, OLD.owned_at, OLD.first_touch_due_at,
                OLD.first_touch_at, OLD.first_touch_breached_at, OLD.release_due_at, OLD.closed_reason,
                OLD.ownership_period_seq, OLD.route_due_at,
                OLD.ownership_command_id, OLD.ownership_actor_user_id, OLD.deleted_at);
    IF NOT changed THEN
      IF NEW.ownership_seq <> OLD.ownership_seq THEN
        RAISE EXCEPTION 'OWNERSHIP_SEQ: seq changed without an ownership change' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF cmd IS NULL OR NEW.ownership_command_id IS DISTINCT FROM cmd THEN
    RAISE EXCEPTION 'OWNERSHIP_UNAUDITED: ownership may only change inside an ownership command'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.ownership_seq <= OLD.ownership_seq THEN
    RAISE EXCEPTION 'OWNERSHIP_SEQ: ownership change must advance seq' USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.lead_ownership_events e
        WHERE e.tenant_id = NEW.tenant_id AND e.contact_id = NEW.id AND e.seq = NEW.ownership_seq
          AND e.command_id = cmd
          AND e.to_state = NEW.ownership_state
          AND e.owner_user_id IS NOT DISTINCT FROM NEW.owner_user_id
          AND e.pond_id IS NOT DISTINCT FROM NEW.pond_id
          AND e.offered_to_user_id IS NOT DISTINCT FROM NEW.offered_to_user_id
          AND (e.actor_kind = 'user') = (NEW.ownership_actor_user_id IS NOT NULL)
          AND e.actor_user_id IS NOT DISTINCT FROM NEW.ownership_actor_user_id) THEN
    RAISE EXCEPTION 'OWNERSHIP_UNAUDITED: contact % seq % has no matching ledger event', NEW.id, NEW.ownership_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- F3: the projection always points at the ledger HEAD, so prev+1 computed from it is always the next seq.
  IF EXISTS (SELECT 1 FROM public.lead_ownership_events e
              WHERE e.tenant_id = NEW.tenant_id AND e.contact_id = NEW.id AND e.seq > NEW.ownership_seq) THEN
    RAISE EXCEPTION 'OWNERSHIP_SEQ_HEAD: projection seq % is behind the ledger head', NEW.ownership_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.contacts_guard() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contacts_guard() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Self-check: the definer's shape, the new rule and every 0001 rule in its body, the trigger still bound
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF NOT (SELECT p.prosecdef AND r.rolname = 'app_definer' AND p.proconfig = ARRAY['search_path=pg_catalog, public']
            FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'app.contacts_guard()'::regprocedure) THEN
    bad := bad || ' definer_shape';
  END IF;
  IF has_function_privilege('public', 'app.contacts_guard()', 'EXECUTE') THEN bad := bad || ' public_execute'; END IF;
  IF has_function_privilege('app_user', 'app.contacts_guard()', 'EXECUTE') THEN bad := bad || ' app_user_execute'; END IF;
  IF NOT (SELECT p.prosrc LIKE '%MERGE_UNAUDITED%' AND p.prosrc LIKE '%merged_away%' AND p.prosrc LIKE '%lower(e.payload->>''survivorId'')%'
                 AND p.prosrc LIKE '%ATTRIBUTION_IMMUTABLE%' AND p.prosrc LIKE '%OWNERSHIP_UNAUDITED%'
                 AND p.prosrc LIKE '%OWNERSHIP_SEQ_HEAD%' AND p.prosrc LIKE '%OWNERSHIP_SEQ: seq changed%'
            FROM pg_proc p WHERE p.oid = 'app.contacts_guard()'::regprocedure) THEN
    bad := bad || ' guard_rules';
  END IF;
  -- still bound BEFORE INSERT OR UPDATE, FOR EACH ROW, on contacts (tgtype bits: ROW 1, BEFORE 2, INSERT 4, UPDATE 16)
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.contacts'::regclass AND t.tgname = 'contacts_guard' AND NOT t.tgisinternal
                    AND t.tgfoid = 'app.contacts_guard()'::regprocedure AND t.tgenabled = 'O'
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16
                    AND (t.tgtype & 8) = 0 AND t.tgattr = ''::int2vector) THEN
    bad := bad || ' trigger_binding';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (backlog merge guard):%', bad; END IF;
END $$;
