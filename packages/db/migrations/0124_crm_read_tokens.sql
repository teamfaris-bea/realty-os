-- =============================================================================
-- 0124_crm_read_tokens.sql : per-tenant read-only service tokens for the CRM read API (WP3a).
--
-- Prducer syncs people, activities, deals, users and stages. A token is created by the Owner, stored
-- only as sha256, and revoked by the Owner. The read API resolves it through app.resolve_crm_read_token
-- and never writes CRM rows. Revocation is checked on every request (no cache).
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4; ARCHITECTURE §21.92; SECURITY §21):
--   app.resolve_crm_read_token(bytea)  SECURITY DEFINER, owner app_definer, search_path pinned,
--       STABLE, no write, EXECUTE to app_user only. Pre-tenant. Returns the tenant and token id of one
--       live token of an active tenant, or no row (unknown, revoked, or inactive tenant). The hash is
--       matched by equality only.
--   app.crm_read_tokens_guard()  INVOKER trigger (not a definer): a token is inserted live by the Owner
--       as themselves; an update may only revoke, once, as the acting Owner.
-- =============================================================================

CREATE TABLE crm_read_tokens (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  name               text NOT NULL,
  token_hash         bytea NOT NULL,
  token_prefix       text NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_by_user_id uuid,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT crm_read_tokens_hash_uq UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CONSTRAINT crm_read_tokens_name_chk CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  CONSTRAINT crm_read_tokens_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT crm_read_tokens_prefix_chk CHECK (token_prefix ~ '^ros_[A-Za-z0-9_-]{6}$'),
  CONSTRAINT crm_read_tokens_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);
COMMENT ON TABLE crm_read_tokens IS
  'WP3a: one read-only service token for the CRM read API. The secret is never stored; token_hash is sha256 of the bearer token. token_prefix is the first ten characters so an Owner can tell tokens apart. A revocation is final.';

CREATE INDEX contacts_crm_read_idx ON contacts (tenant_id, updated_at, id)
  WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL;
CREATE INDEX deals_crm_read_idx ON deals (tenant_id, updated_at, id);
CREATE INDEX calls_crm_read_idx ON calls (tenant_id, updated_at, id);
CREATE INDEX messages_crm_read_idx ON messages (tenant_id, updated_at, id);
CREATE INDEX notes_crm_read_idx ON notes (tenant_id, updated_at, id);
CREATE INDEX appointments_crm_read_idx ON appointments (tenant_id, updated_at, id);

ALTER TABLE crm_read_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_read_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_read_tokens AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON crm_read_tokens AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON crm_read_tokens AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON crm_read_tokens AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_read_tokens
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

-- The Owner manages tokens. The read path does not use these policies: the resolver is a definer.
CREATE POLICY crm_read_tokens_select ON crm_read_tokens FOR SELECT
  USING ((SELECT app.actor_kind()) = 'user' AND (SELECT app.my_role()) = 'owner');
CREATE POLICY crm_read_tokens_insert ON crm_read_tokens FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'user' AND (SELECT app.my_role()) = 'owner'
              AND created_by_user_id = (SELECT app.user_id()));
CREATE POLICY crm_read_tokens_update ON crm_read_tokens FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'user' AND (SELECT app.my_role()) = 'owner')
  WITH CHECK ((SELECT app.actor_kind()) = 'user' AND (SELECT app.my_role()) = 'owner');

CREATE FUNCTION app.crm_read_tokens_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- A foreign tenant is rejected by the restrictive policy. Say nothing first, so the error is the
  -- row-level security failure and not a hint about this table's rules.
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'CRM_READ_TOKEN_REVOKED: a token is created live' USING ERRCODE = 'check_violation';
    END IF;
    IF app.my_role() IS DISTINCT FROM 'owner' OR NEW.created_by_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'CRM_READ_TOKEN_OWNER: only the Owner creates a read token' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.name, NEW.token_hash, NEW.token_prefix, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.name, OLD.token_hash, OLD.token_prefix, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'CRM_READ_TOKEN_IMMUTABLE: only revocation is written' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_READ_TOKEN_REVOKED: a revocation is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NULL OR NEW.revoked_by_user_id IS NULL OR NEW.revoked_by_user_id IS DISTINCT FROM app.user_id() THEN
    RAISE EXCEPTION 'CRM_READ_TOKEN_REVOKED: the Owner revokes as themselves' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_read_tokens_guard BEFORE INSERT OR UPDATE ON crm_read_tokens
  FOR EACH ROW EXECUTE FUNCTION app.crm_read_tokens_guard();
REVOKE ALL ON FUNCTION app.crm_read_tokens_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.crm_read_tokens_guard() TO app_user;

-- Pre-tenant. sha256 of the bearer token, equality only. A revoked token, an unknown hash and an
-- inactive tenant are the same answer: no row.
CREATE FUNCTION app.resolve_crm_read_token(p_token_hash bytea)
RETURNS TABLE (tenant_id uuid, token_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.tenant_id, t.id
    FROM public.crm_read_tokens t
    JOIN public.tenants n ON n.id = t.tenant_id AND n.status = 'active'
   WHERE octet_length(p_token_hash) = 32
     AND t.token_hash = p_token_hash
     AND t.revoked_at IS NULL
$$;
ALTER FUNCTION app.resolve_crm_read_token(bytea) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.resolve_crm_read_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_crm_read_token(bytea) TO app_user;

GRANT SELECT, INSERT, UPDATE ON crm_read_tokens TO app_user;
GRANT SELECT ON crm_read_tokens TO app_definer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.crm_read_tokens'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0124: crm_read_tokens must force row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.crm_read_tokens'::regclass AND polname = 'tenant_isolation' AND NOT polpermissive) THEN
    RAISE EXCEPTION '0124: crm_read_tokens needs the restrictive tenant policy';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.crm_read_tokens'::regclass AND polname LIKE 'support_read_only_%' AND NOT polpermissive) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.crm_read_tokens'::regclass AND tgname = 'support_read_only' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0124: crm_read_tokens needs the support read-only policies and trigger';
  END IF;
  IF has_table_privilege('app_user', 'public.crm_read_tokens', 'DELETE')
     OR has_table_privilege('app_user', 'public.crm_read_tokens', 'TRUNCATE') THEN
    RAISE EXCEPTION '0124: app_user must not delete crm_read_tokens rows';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'app' AND p.proname = 'resolve_crm_read_token' AND p.prosecdef
      AND r.rolname = 'app_definer'
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION '0124: app.resolve_crm_read_token must be a definer owned by app_definer with search_path pinned';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'crm_read_tokens_guard' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION '0124: the token guard must not be a security definer';
  END IF;
  IF has_function_privilege('public', 'app.resolve_crm_read_token(bytea)', 'EXECUTE')
     OR NOT has_function_privilege('app_user', 'app.resolve_crm_read_token(bytea)', 'EXECUTE') THEN
    RAISE EXCEPTION '0124: only app_user may execute app.resolve_crm_read_token';
  END IF;
END $$;
