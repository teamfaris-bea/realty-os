-- =============================================================================
-- 0050 calendar: removing a member revokes their calendar link in the same transaction (module 34; R-INT-5)
-- =============================================================================
-- R-INT-5: "Disconnecting, or removing the member who owns a calendar link, revokes the grant at the provider
-- (best effort) and locally in the same transaction; tokens are purged within 30 days."
--
-- The member is removed by an Owner/Admin (api/admin) or by the deactivation flow. user_calendar_links is
-- self-and-system only (0018 calendar_links_self, R-CAL-1), so the remover's transaction cannot touch the
-- link under RLS. This trigger revokes it locally in that same transaction: status 'revoked', revoked_at,
-- purge_after (now + 30 days) and last_error_code 'MEMBER_REMOVED'. It keeps the encrypted token so that the
-- system actor's hourly calendar.reconcile can revoke the grant at the provider (best effort) and then purge
-- the token; a revoked link is never used again (every reader requires connected/degraded), and a revoked
-- link with a token left after reconcile is purged by the same job.
--
-- Suspension is NOT removal: a suspended member keeps their link (sync pauses while they are not active).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * new SECURITY DEFINER trigger function app.calendar_links_revoke_on_member_removed(), owned by app_definer,
--     search_path pinned to pg_catalog, public, EXECUTE revoked from PUBLIC. It runs only as an AFTER UPDATE OF
--     status trigger on memberships, when status becomes 'removed'; it takes no argument and touches only the
--     links of NEW.tenant_id / NEW.user_id, only their status/revocation columns. Definer because the remover
--     (an Owner/Admin, or the system) may not see or write the member's link under RLS (R-CAL-1).
--   * new column grant: app_definer gets UPDATE (status, revoked_at, purge_after, last_error_code) on
--     user_calendar_links (it had SELECT only, 0018). No token column is writable by app_definer.
-- =============================================================================

CREATE FUNCTION app.calendar_links_revoke_on_member_removed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.user_calendar_links l
     SET status = 'revoked', revoked_at = clock_timestamp(), purge_after = clock_timestamp() + interval '30 days',
         last_error_code = 'MEMBER_REMOVED'
   WHERE l.tenant_id = NEW.tenant_id AND l.user_id = NEW.user_id AND l.status <> 'revoked';
  RETURN NULL;
END $$;
ALTER FUNCTION app.calendar_links_revoke_on_member_removed() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.calendar_links_revoke_on_member_removed() FROM PUBLIC;
GRANT UPDATE (status, revoked_at, purge_after, last_error_code) ON public.user_calendar_links TO app_definer;

CREATE TRIGGER memberships_calendar_links_revoke AFTER UPDATE OF status ON memberships
  FOR EACH ROW WHEN (NEW.status = 'removed' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.calendar_links_revoke_on_member_removed();
