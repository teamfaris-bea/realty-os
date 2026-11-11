-- Module 21 api/integrations (PHASE2_3_PLAN §4 and §5.4 #21; DATA_MODEL R-TEN-11, R-INT-3).
--
-- One pre-tenant definer: app.resolve_channel_account(kind, external_account_id).
--
-- Every new webhook (Meta Messenger / Instagram / Lead Ads, partner lead feeds, MLS, showing service,
-- ads, GBP) resolves its tenant ONLY through this function. It returns (tenant_id, connection_id) for a
-- connection that is `connected` or `degraded` in an active tenant, and nothing otherwise:
--   * a `pending_review` row reserves the account (the global live-account index) but routes nothing;
--   * `not_configured`, `needs_partner_access`, `revoked`, `disconnected` route nothing (E136: the
--     caller records the event as unrouted and raises a platform alert);
--   * web-chat widgets and lead inboxes have no external account and are NOT resolved here (their
--     server-generated keys have their own resolvers, module 22).
-- The routing key (kind, external_account_id) is written only by the provider callback after the adapter
-- proved the token manages that account (integration_connections_guard, 0018), and it is live in at
-- most one tenant (integration_connections_live_account), so at most one row can match.
--
-- Security review (ARCHITECTURE §21.1, "Definer catalog additions"): owned by app_definer (BYPASSRLS),
-- pinned search_path, STABLE, reads one table plus tenants, returns two ids and no payload; no write.
-- Payload fields never choose the tenant: the caller passes the account id from the verified webhook
-- envelope, and a tenant id in the payload is never consulted.

CREATE FUNCTION app.resolve_channel_account(p_kind text, p_external_account_id text)
RETURNS TABLE (tenant_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id, c.id
    FROM public.integration_connections c
    JOIN public.tenants t ON t.id = c.tenant_id AND t.status = 'active'
   WHERE p_kind IN ('messenger_page','instagram_account','meta_lead_ads','zillow_feed','realtor_feed','mls_feed',
                    'showing_service','ads_meta','ads_google','gbp_location')
     AND c.kind = p_kind
     AND c.external_account_id = p_external_account_id
     AND c.status IN ('connected','degraded')
$$;

ALTER FUNCTION app.resolve_channel_account(text, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.resolve_channel_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_channel_account(text, text) TO app_user;
