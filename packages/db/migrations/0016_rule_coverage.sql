-- =============================================================================
-- 0016_rule_coverage.sql : close the database gaps behind R-PERM-11, R-AUDIT-6, R-AUDIT-9 and E59.
-- (Lane migration; the orchestrator renumbers it when merging. Forward-only; never edit 0001-0014.)
--
-- 1. R-PERM-11 support grants. 0001's CHECK measured the 72 h window from a caller-supplied
--    created_at, so a grant "created" in the future was valid for longer than 72 h, and an Owner
--    could UPDATE created_at/expires_at forward to extend a grant indefinitely. Now: created_at is the
--    database clock, the grant names the issuing Owner themself, and a grant can only ever be revoked
--    (every other column is immutable).
-- 2. R-PERM-11 read-only support. The RESTRICTIVE support_read_only_* policies cover RLS paths only;
--    a SECURITY DEFINER function (BYPASSRLS owner) called under a support context could still write.
--    A statement-level trigger on EVERY public table now rejects INSERT/UPDATE/DELETE/TRUNCATE whenever
--    the request context is a support actor, whichever role executes the statement.
-- 3. R-AUDIT-6 Team Leads read the ownership ledger for THEIR team. 0001's loe_select let every Team
--    Lead read every ledger row in the tenant (sees_all_detail()). The Team Lead branch is now limited
--    to events that involve a member of a team they lead, and to contacts such a member owns now (plus
--    their own collaborator/deal contacts). Owner/Admin/system/support (tenant-wide) are unchanged, and
--    so is everybody else (contact_detail_visible).
-- 4. R-AUDIT-9 audit retention is 7 years, after which only app.retention_sweep deletes (VERIFY WITH
--    COUNSEL). app.retention_sweep(p_now) is callable by app_user with ANY p_now, so a far-future
--    p_now deleted young audit rows; and audit rows could be inserted backdated, so the sweep would
--    delete them at once. Now: app_retention deletes an audit row only once it is older than
--    app.audit_retention() by the real clock (younger rows are kept and the sweep carries on), and a
--    non-superuser cannot insert an audit row whose occurred_at is not "now" (one day of skew).
-- 5. E59 / R-DATA-4 erasure of a contact on a closed deal is refused (CONTACT_ON_DEAL, app.erase_contact
--    in 0001); the Owner removes the deal link first. A deal's primary contact was NOT NULL, so the link
--    of a closed single-contact deal could not be removed at all. Now primary_contact_id may become
--    NULL, but only by an Owner, only on a closed or lost deal (the transaction record stays; only the
--    person's link goes). VERIFY WITH COUNSEL: whether transaction records must keep the person.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Support grants: Owner-issued by the Owner themself, at most 72 h from the database clock,
--    revocation is the only change.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.support_access_grants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();      -- the window is measured from the database clock, never a caller value
    NEW.revoked_at := NULL;
    -- Under a request context the issuer must be the calling Owner (RLS grants_write already requires
    -- the Owner role; this pins granted_by to that Owner). Fixtures without a context are left alone.
    IF app.actor_kind() <> 'none' AND NEW.tenant_id IS NOT DISTINCT FROM app.tenant_id()   -- another tenant's row: RLS refuses it
       AND (app.actor_kind() <> 'user' OR NEW.granted_by_user_id IS DISTINCT FROM app.user_id()
            OR app.my_role() IS DISTINCT FROM 'owner') THEN
      RAISE EXCEPTION 'SUPPORT_GRANT_FORBIDDEN: a support grant is issued by the Owner themself'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: revocation only (NULL -> a time), nothing else ever changes
  IF (NEW.tenant_id, NEW.id, NEW.support_user_id, NEW.granted_by_user_id, NEW.reason, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.support_user_id, OLD.granted_by_user_id, OLD.reason, OLD.created_at, OLD.expires_at)
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SUPPORT_GRANT_IMMUTABLE: a support grant can only be revoked'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_access_grants_guard BEFORE INSERT OR UPDATE ON support_access_grants
  FOR EACH ROW EXECUTE FUNCTION app.support_access_grants_guard();

-- -----------------------------------------------------------------------------
-- 2. Support actors are read-only on every path, including SECURITY DEFINER functions.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.reject_support_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.actor_kind() = 'support' THEN
    RAISE EXCEPTION 'SUPPORT_READ_ONLY: % on % rejected', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname LOOP
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', r.relname);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Ownership ledger: Team Leads read their team's part only.
-- -----------------------------------------------------------------------------
-- Invoker (not definer): the contacts RLS of the caller applies, and a Team Lead sees their team's
-- contacts anyway. Used only by the Team Lead branch of loe_select.
CREATE FUNCTION app.contact_owned_by_my_team(p_tenant uuid, p_contact uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.tenant_id = p_tenant AND c.id = p_contact
                    AND c.owner_user_id = ANY (app.my_team_member_ids()))
$$;

DROP POLICY loe_select ON lead_ownership_events;
CREATE POLICY loe_select ON lead_ownership_events FOR SELECT USING (
  (SELECT app.is_tenant_wide())
  OR CASE WHEN (SELECT app.my_role()) = 'team_lead' THEN
         owner_user_id      = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR prev_owner_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR offered_to_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR actor_user_id      = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR contact_id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
      OR contact_id = ANY ((SELECT app.my_deal_contact_ids())::uuid[])
      OR app.contact_owned_by_my_team(tenant_id, contact_id)
     ELSE app.contact_detail_visible(tenant_id, contact_id) END);

-- -----------------------------------------------------------------------------
-- 4. Audit retention (R-AUDIT-9). VERIFY WITH COUNSEL: the period, and whether it differs by state.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.audit_retention() RETURNS interval LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT interval '7 years' $$;   -- VERIFY WITH COUNSEL

-- Row DELETE by app_retention (the only role app.reject_mutation lets delete): a row inside the
-- retention period by the REAL clock is kept (the statement skips it), so app.retention_sweep called
-- with a far-future p_now deletes nothing young and still finishes its other steps. Any other role is
-- refused by app.reject_mutation before or after this trigger.
CREATE FUNCTION app.audit_log_retention_floor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'app_retention' AND OLD.occurred_at > now() - app.audit_retention() THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER audit_log_retention_floor BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_retention_floor();

-- No backdating: an application role writes audit rows for actions happening now. A backdated row
-- would otherwise be swept long before its 7 years. Superuser fixtures (tests, ops backfills) are exempt.
CREATE FUNCTION app.audit_log_occurred_now() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)
     AND (NEW.occurred_at < clock_timestamp() - interval '1 day' OR NEW.occurred_at > clock_timestamp() + interval '1 hour') THEN
    RAISE EXCEPTION 'AUDIT_OCCURRED_AT_INVALID: an audit row records an action happening now'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_occurred_now BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_occurred_now();

-- -----------------------------------------------------------------------------
-- 5. E59: the Owner may remove the person from a closed/lost deal (the transaction record stays).
-- -----------------------------------------------------------------------------
ALTER TABLE deals ALTER COLUMN primary_contact_id DROP NOT NULL;

CREATE FUNCTION app.deals_primary_contact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.primary_contact_id IS NULL
     AND (TG_OP = 'INSERT' OR OLD.primary_contact_id IS NOT NULL) THEN
    IF TG_OP = 'INSERT' OR NEW.stage NOT IN ('closed','lost') OR OLD.stage NOT IN ('closed','lost')
       OR app.my_role() IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'DEAL_PRIMARY_CONTACT_REQUIRED: only an Owner removes the person from a closed or lost deal'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deals_primary_contact_guard BEFORE INSERT OR UPDATE OF primary_contact_id ON deals
  FOR EACH ROW EXECUTE FUNCTION app.deals_primary_contact_guard();

-- -----------------------------------------------------------------------------
-- Least privilege for the new functions (CREATE FUNCTION grants EXECUTE to PUBLIC by default).
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.support_access_grants_guard(), app.reject_support_write(),
  app.contact_owned_by_my_team(uuid, uuid), app.audit_retention(), app.audit_log_retention_floor(),
  app.audit_log_occurred_now(), app.deals_primary_contact_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_owned_by_my_team(uuid, uuid), app.audit_retention() TO app_user, app_retention;
