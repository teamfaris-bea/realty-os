-- 0016 (lane production-readiness): resolve a Twilio subaccount to its tenant, for webhook signatures.
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): one new SECURITY DEFINER read.
--
-- Why: Twilio signs every webhook (X-Twilio-Signature) with the auth token of the account that owns the
-- resource. Each tenant has its own subaccount (ARCHITECTURE §7), so the webhook guard must find which
-- tenant's subaccount a request claims (the AccountSid form field) BEFORE any tenant context exists, then
-- decrypt that tenant's subaccount secret as the system actor and verify the signature. Nothing is written
-- for a tenant until the signature is valid.
--
-- What it returns: for ONE exact subaccount ref, only the tenant id, and only for an active credential of
-- an active tenant. No secret, no ciphertext, no other columns. It is not a listing: an unknown ref returns
-- no row, the same as for a revoked credential or a suspended tenant.
CREATE FUNCTION app.resolve_telephony_account(p_account_ref text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT pc.tenant_id FROM public.provider_credentials pc
    JOIN public.tenants t ON t.id = pc.tenant_id AND t.status = 'active'
   WHERE pc.provider = 'telephony' AND pc.status = 'active' AND pc.external_account_ref = p_account_ref
     AND p_account_ref IS NOT NULL AND length(p_account_ref) BETWEEN 1 AND 64
$$;
ALTER FUNCTION app.resolve_telephony_account(text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.resolve_telephony_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_telephony_account(text) TO app_user;

CREATE INDEX provider_credentials_account_ref_idx ON provider_credentials (external_account_ref)
  WHERE provider = 'telephony' AND status = 'active';
