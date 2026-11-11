-- Lane spark-prep: provider_credentials least privilege (docs/SECURITY.md "Spark MLS (read-only)").
--
-- provider_credentials holds every tenant secret (telephony, email, FUB import key, the Spark MLS key, ...),
-- encrypted with the tenant field key. Its policy admin_all (0001, "Layer 2 (b)") uses app.is_tenant_wide(),
-- which is also true for a support session holding an active support_access_grant. Support is read-only and
-- would see ciphertext only, but least privilege says support has no reason to SELECT a credential row at
-- all. This adds ONE restrictive policy to this ONE table: whatever the permissive policies allow, a support
-- actor gets no row and writes nothing. Owner/Admin and the system actor are unchanged; definer paths
-- (app_definer / app_retention, BYPASSRLS: the retention sweep, the account resolvers) are unaffected; no
-- application path reads provider_credentials as support. FORCE RLS and the other tables of the 0001 loop
-- are untouched.
CREATE POLICY credentials_not_support ON provider_credentials AS RESTRICTIVE FOR ALL
  USING ((SELECT app.actor_kind()) IS DISTINCT FROM 'support')
  WITH CHECK ((SELECT app.actor_kind()) IS DISTINCT FROM 'support');
