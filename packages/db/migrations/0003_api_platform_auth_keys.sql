-- 0003 (BUILD_PLAN module 8, api/platform): tenant key material for members, TOTP replay guard.
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): one new SECURITY DEFINER read, app.tenant_key_material().
--
-- Why: field encryption (push endpoints, transcripts, AI outputs, provider credentials, ...) and the
-- address HMAC (contact points, consent, suppressions) are needed by request code running as ANY
-- active member: an agent registering a push subscription encrypts its endpoint with the tenant
-- `field` key; an agent adding a phone computes its HMAC with the tenant `hmac` key. tenant_keys is
-- readable only by tenant-wide actors (Owner/Admin/system: `admin_all`), so an agent's request
-- could not load the keys it must use.
--
-- What it returns: for the caller's tenant only (app.tenant_id(), filtered explicitly), and only to
-- an active member (app.is_member()), the WRAPPED keys (ciphertext under the platform KEK, which
-- lives in the API process / KMS, never in the database) with purpose, version, KEK reference and
-- retirement flag. Destroyed keys (crypto-shredded, wrapped_key NULL) are never returned. Without
-- tenant context, or for a non-member, it returns no rows. It writes nothing.
CREATE FUNCTION app.tenant_key_material()
RETURNS TABLE (purpose text, key_version integer, wrapped_key bytea, kek_ref text, retired boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT k.purpose, k.key_version, k.wrapped_key, k.kek_ref, k.retired_at IS NOT NULL
    FROM public.tenant_keys k
   WHERE k.tenant_id = app.tenant_id() AND app.is_member()
     AND k.wrapped_key IS NOT NULL AND k.destroyed_at IS NULL
   ORDER BY k.purpose, k.key_version
$$;
ALTER FUNCTION app.tenant_key_material() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.tenant_key_material() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_key_material() TO app_user;

-- TOTP replay guard (OWASP ASVS L2 2.8.4: a time-based code is accepted at most once). The API
-- advances it atomically: UPDATE users SET mfa_last_used_step = $step WHERE id = app.user_id() AND
-- (mfa_last_used_step IS NULL OR mfa_last_used_step < $step). The users UPDATE policy is self-only.
ALTER TABLE users ADD COLUMN mfa_last_used_step bigint CHECK (mfa_last_used_step IS NULL OR mfa_last_used_step >= 0);
GRANT SELECT (mfa_last_used_step), UPDATE (mfa_last_used_step) ON users TO app_user;
