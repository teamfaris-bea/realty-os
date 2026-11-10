-- 0006 (BUILD_PLAN module 10, api/admin): archivable routing rules, deletable teams.
--
-- No new table, no SECURITY DEFINER function, no policy change.
--
-- 1. routing_rules.archived_at. A routing rule cannot be deleted once it routed a lead
--    (contacts.routing_rule_id references it, and the ownership ledger cites it), so "delete" in the
--    admin API archives it: archived ⇒ disabled (CHECK), so the router, which reads only enabled rules
--    (packages/db ownership context), never matches it again. Archived rules keep a unique position
--    (the deferrable UNIQUE (tenant_id, position)); the admin reorder places them after the live ones.
-- 2. Teams are deletable by Owner/Admin (the 0001 admin_delete policy already exists; app_user lacked
--    the DELETE grant). team_members rows cascade. The default team cannot be deleted (trigger), the
--    same protection the default pond has through its CHECK.
ALTER TABLE routing_rules ADD COLUMN archived_at timestamptz;
ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_archived_disabled CHECK (archived_at IS NULL OR NOT enabled);

GRANT DELETE ON teams TO app_user;

CREATE FUNCTION app.teams_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_default THEN
    RAISE EXCEPTION 'DEFAULT_TEAM_PROTECTED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER teams_guard BEFORE DELETE ON teams
  FOR EACH ROW EXECUTE FUNCTION app.teams_guard();

-- 3. R-PERM-2 race fix in memberships_guard (SECURITY REVIEW ITEM: trigger change, no definer).
--    The 0001 "last active Owner" check reads the other memberships with a fresh READ COMMITTED
--    snapshot but takes no lock, so two Owners demoting (or suspending/removing) each other at the same
--    moment each see the other still active and both commit: the tenant is left with no Owner. Any
--    change that touches an Owner row now first takes a per-tenant advisory lock, so such changes run
--    one after the other and the second one's check sees the first one's commit (api/admin two-session
--    test). The lock is taken after the row lock the UPDATE already holds. Application code updates
--    one membership per statement and takes no further membership row lock after an Owner change, so
--    the lock adds no cycle (a multi-row UPDATE across Owner rows could deadlock, which Postgres
--    detects and withTenantTx retries). Otherwise identical to 0001.
CREATE OR REPLACE FUNCTION app.memberships_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'owner' OR NEW.role = 'owner' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.tenant_id::text || ':memberships:owners', 0));
  END IF;
  IF current_user IN ('app_definer','app_retention') THEN
    NULL;   -- reviewed definer paths (provisioning, invite acceptance)
  ELSIF (NEW.role, NEW.status) IS DISTINCT FROM (OLD.role, OLD.status) THEN
    IF NOT app.is_tenant_wide() THEN
      RAISE EXCEPTION 'ROLE_CHANGE_FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (OLD.role = 'owner' OR NEW.role = 'owner') AND app.actor_kind() <> 'system'
       AND COALESCE(app.my_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'OWNER_ROLE_REQUIRES_OWNER' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD.role = 'owner' AND OLD.status = 'active' AND (NEW.role <> 'owner' OR NEW.status <> 'active')
     AND NOT EXISTS (SELECT 1 FROM public.memberships m
                      WHERE m.tenant_id = OLD.tenant_id AND m.user_id <> OLD.user_id
                        AND m.role = 'owner' AND m.status = 'active') THEN
    RAISE EXCEPTION 'LAST_OWNER: tenant must keep an active owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
