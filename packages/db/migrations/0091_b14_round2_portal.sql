-- Batch 14 round 2: the client portal (module 45). Security notes: docs/ARCHITECTURE.md §21.56.
--
--   1. platform:portal@2026.11.1 (PHASE2_3_PLAN Q-PORTAL-19; owner decision D11; the batch 14 review's F1,
--      db-security). Counsel's review reported on 2026-11-12 was of 0018's 2026.11.0 placeholder, the day before
--      module 45 was built, and module 45 lists counsel items "before platform:portal is cleared" (ARCHITECTURE
--      §21.52 VERIFY 1-6, Q-PORTAL-16, module 46's client page). As 0084 did for platform:ai_isa_seller_data,
--      2026.11.0 is retired (any review recorded on it is kept as history) and 2026.11.1 is published unreviewed, so a
--      review recorded on 2026.11.0 never clears the module-45 portal, and the counsel-review command refuses the old
--      pin (packages/db/src/counselReview.ts). DEPLOY's D11 command names six keys. VERIFY WITH COUNSEL.
--   2. B14-OWN-1 (PHASE2_3_PLAN Q-PORTAL-20, the conservative default): a soft-deleted client gets no new sign-in
--      link, and their sessions and grants see nothing; restoring the contact (POST /leads/:id/reopen clears
--      deleted_at) restores access. Before this, after a soft delete the account stayed active, an old session's
--      /api/portal/me answered 200 with its grant, and a new sign-in link was sent and opened a session. Four
--      functions are replaced, each verbatim from its migration plus ONE condition, marked "-- 0091": the contact of
--      the portal account is not deleted (contacts.deleted_at IS NULL):
--        app.portal_party_ok(uuid, uuid, uuid, uuid)   0018; SECURITY DEFINER, owner app_definer; the grant guard,
--                                                       the client grant policy, the document chain, the sync's
--                                                       publishing and the staff grant view read it
--        portal.request_login(citext, bytea, bytea[])  0023; SECURITY DEFINER, owner app_definer; no token, no audit,
--                                                       no row returned (so no link queued) for a deleted contact
--        portal.consume_login(bytea, bytea, inet, text) 0023; SECURITY DEFINER, owner app_definer; a link issued
--                                                       before the delete opens no session (the token stays used)
--        portal.resolve_session(bytea)                 0023; SECURITY DEFINER, owner app_definer; the only source of
--                                                       a client context: no context for a deleted contact
--      Each keeps its signature, search_path (pg_catalog, public) and ACL (CREATE OR REPLACE keeps it; the owner and
--      the REVOKE from PUBLIC are restated). No table, policy, grant or trigger changes. The account row is not
--      touched, so nothing is disabled, revoked or retracted by a delete and a restore needs no repair. Only stricter.
--      The merge (B14-OWN-2) is unchanged and stays open (Q-PORTAL-20).

-- =============================================================================
-- 1. platform:portal@2026.11.1 (unreviewed; D11's review was of 2026.11.0)
-- =============================================================================
UPDATE jurisdiction_packs SET status = 'retired' WHERE key = 'platform:portal' AND status = 'published';
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:portal', '2026.11.1', 'published', '{}', NULL,
   'Client portal (C10), module 45 as built: gates client sign-in (portal.request_login, consume_login, resolve_session). '
   'Ships unreviewed: a review recorded on 2026.11.0 (0018''s placeholder, reviewed before module 45 was built) does not '
   'clear it. Counsel items before it is cleared: VERIFY 1-6 (ARCHITECTURE §21.52), Q-PORTAL-16 (a client''s message '
   'quoting their sign-in link), and module 46''s client page, which is not shipped yet. Engineering placeholder. '
   'VERIFY WITH COUNSEL.');

-- =============================================================================
-- 2. B14-OWN-1: a soft-deleted client gets no new sign-in link, and their sessions and grants see nothing
-- =============================================================================
-- 0018's app.portal_party_ok, verbatim except the marked 0091 line.
CREATE OR REPLACE FUNCTION app.portal_party_ok(p_tenant uuid, p_account uuid, p_deal uuid, p_listing uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (
    SELECT 1 FROM public.portal_accounts a
     WHERE a.tenant_id = p_tenant AND a.id = p_account
       AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = a.tenant_id AND c.id = a.contact_id AND c.deleted_at IS NULL)   -- 0091
       AND ((p_deal IS NOT NULL AND p_listing IS NULL AND (
              EXISTS (SELECT 1 FROM public.deals d
                       WHERE d.tenant_id = p_tenant AND d.id = p_deal AND d.primary_contact_id = a.contact_id)
              OR EXISTS (SELECT 1 FROM public.deal_contacts dc
                          WHERE dc.tenant_id = p_tenant AND dc.deal_id = p_deal AND dc.contact_id = a.contact_id
                            AND dc.role IN ('buyer','seller','co_buyer','co_seller'))))
         OR (p_listing IS NOT NULL AND p_deal IS NULL AND EXISTS (
              SELECT 1 FROM public.listing_contacts lc
               WHERE lc.tenant_id = p_tenant AND lc.listing_id = p_listing AND lc.contact_id = a.contact_id
                 AND lc.role IN ('seller','co_seller')))))
$$;
ALTER FUNCTION app.portal_party_ok(uuid, uuid, uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.portal_party_ok(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- 0023's portal.request_login, verbatim except the marked 0091 line.
CREATE OR REPLACE FUNCTION portal.request_login(p_tenant_slug citext, p_address_hash bytea, p_token_hashes bytea[])
RETURNS TABLE (tenant_id uuid, portal_account_id uuid, contact_id uuid, login_point_id uuid, login_kind text, token_hash bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; i integer := 0; n integer := COALESCE(array_length(p_token_hashes, 1), 0);
BEGIN
  IF NOT app.platform_cleared('platform:portal') THEN
    RAISE EXCEPTION 'PORTAL_NOT_CLEARED: client sign-in waits for the platform:portal counsel review'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_address_hash IS NULL OR octet_length(p_address_hash) <> 32 OR n = 0 OR n > 8
     OR EXISTS (SELECT 1 FROM unnest(p_token_hashes) h WHERE h IS NULL OR octet_length(h) <> 32) THEN
    RAISE EXCEPTION 'PORTAL_BAD_REQUEST: 32-byte hashes, 1 to 8 token hashes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR r IN
    SELECT a.tenant_id, a.id, a.contact_id, a.login_point_id, p.kind
      FROM public.tenants t
      JOIN public.portal_accounts a ON a.tenant_id = t.id
      JOIN public.contact_points p  ON p.tenant_id = a.tenant_id AND p.id = a.login_point_id AND p.contact_id = a.contact_id
     WHERE t.slug = p_tenant_slug AND t.status = 'active'
       AND a.status IN ('invited','active')
       AND p.removed_at IS NULL AND p.kind IN ('email','phone')
       AND sha256(convert_to(p.address, 'UTF8')) = p_address_hash
       AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = a.tenant_id AND c.id = a.contact_id AND c.deleted_at IS NULL)   -- 0091
     ORDER BY a.created_at, a.id
     FOR UPDATE OF a
  LOOP
    EXIT WHEN i >= n;
    CONTINUE WHEN (SELECT count(*) FROM public.portal_login_tokens lt
                    WHERE lt.tenant_id = r.tenant_id AND lt.portal_account_id = r.id
                      AND lt.created_at > now() - interval '1 hour') >= 5;
    i := i + 1;
    UPDATE public.portal_login_tokens lt SET superseded_at = now()
     WHERE lt.tenant_id = r.tenant_id AND lt.portal_account_id = r.id AND lt.used_at IS NULL AND lt.superseded_at IS NULL;
    INSERT INTO public.portal_login_tokens (tenant_id, id, token_hash, portal_account_id, login_point_id, created_at, expires_at)
    VALUES (r.tenant_id, gen_random_uuid(), p_token_hashes[i], r.id, r.login_point_id, now(), now() + interval '15 minutes');
    PERFORM portal.audit_internal(r.tenant_id, r.id, 'portal.login_link_issued', 'portal_account', r.id,
                                  jsonb_build_object('login_point_id', r.login_point_id), NULL, NULL);
    tenant_id := r.tenant_id; portal_account_id := r.id; contact_id := r.contact_id; login_point_id := r.login_point_id;
    login_kind := r.kind; token_hash := p_token_hashes[i];
    RETURN NEXT;
  END LOOP;
END $$;
ALTER FUNCTION portal.request_login(citext, bytea, bytea[]) OWNER TO app_definer;
REVOKE ALL ON FUNCTION portal.request_login(citext, bytea, bytea[]) FROM PUBLIC;

-- 0023's portal.consume_login, verbatim except the marked 0091 line.
CREATE OR REPLACE FUNCTION portal.consume_login(p_token_hash bytea, p_session_token_hash bytea, p_ip inet, p_user_agent text)
RETURNS TABLE (session_id uuid, tenant_id uuid, portal_account_id uuid, idle_expires_at timestamptz, absolute_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tok record; acc record; sid uuid := gen_random_uuid(); ts timestamptz := now();
BEGIN
  IF NOT app.platform_cleared('platform:portal') THEN
    RAISE EXCEPTION 'PORTAL_NOT_CLEARED: client sign-in waits for the platform:portal counsel review'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_session_token_hash IS NULL OR octet_length(p_session_token_hash) <> 32 THEN
    RAISE EXCEPTION 'PORTAL_BAD_REQUEST: 32-byte session token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.portal_login_tokens lt SET used_at = ts
   WHERE lt.token_hash = p_token_hash AND lt.used_at IS NULL AND lt.superseded_at IS NULL AND lt.expires_at > ts
  RETURNING lt.tenant_id, lt.portal_account_id, lt.login_point_id INTO tok;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT a.status, a.login_point_id INTO acc
    FROM public.portal_accounts a
    JOIN public.tenants t ON t.id = a.tenant_id AND t.status = 'active'
    JOIN public.contact_points p ON p.tenant_id = a.tenant_id AND p.id = a.login_point_id AND p.contact_id = a.contact_id
                                AND p.removed_at IS NULL
   WHERE a.tenant_id = tok.tenant_id AND a.id = tok.portal_account_id
     AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = a.tenant_id AND c.id = a.contact_id AND c.deleted_at IS NULL)   -- 0091
   FOR UPDATE OF a;
  IF NOT FOUND OR acc.status NOT IN ('invited','active') OR acc.login_point_id IS DISTINCT FROM tok.login_point_id THEN
    RETURN;
  END IF;
  IF acc.status = 'invited' THEN
    UPDATE public.portal_accounts a SET status = 'active', activated_at = ts
     WHERE a.tenant_id = tok.tenant_id AND a.id = tok.portal_account_id;
  END IF;
  INSERT INTO public.portal_sessions (tenant_id, id, token_hash, portal_account_id, created_at, last_seen_at,
                                      idle_expires_at, absolute_expires_at, ip, user_agent)
  VALUES (tok.tenant_id, sid, p_session_token_hash, tok.portal_account_id, ts, ts, ts + interval '24 hours',
          ts + interval '14 days', p_ip, left(p_user_agent, 512));
  PERFORM portal.audit_internal(tok.tenant_id, tok.portal_account_id, 'portal.signed_in', 'portal_account',
                                tok.portal_account_id, jsonb_build_object('session_id', sid,
                                'activated', acc.status = 'invited'), p_ip, p_user_agent);
  session_id := sid; tenant_id := tok.tenant_id; portal_account_id := tok.portal_account_id;
  idle_expires_at := ts + interval '24 hours'; absolute_expires_at := ts + interval '14 days';
  RETURN NEXT;
END $$;
ALTER FUNCTION portal.consume_login(bytea, bytea, inet, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION portal.consume_login(bytea, bytea, inet, text) FROM PUBLIC;

-- 0023's portal.resolve_session, verbatim except the marked 0091 line.
CREATE OR REPLACE FUNCTION portal.resolve_session(p_token_hash bytea)
RETURNS TABLE (session_id uuid, tenant_id uuid, portal_account_id uuid, contact_id uuid, idle_expires_at timestamptz,
               absolute_expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record; ts timestamptz := now();
BEGIN
  SELECT ps.tenant_id, ps.id, ps.portal_account_id, a.contact_id, ps.last_seen_at, ps.idle_expires_at, ps.absolute_expires_at
    INTO s
    FROM public.portal_sessions ps
    JOIN public.portal_accounts a ON a.tenant_id = ps.tenant_id AND a.id = ps.portal_account_id AND a.status = 'active'
    JOIN public.tenants t ON t.id = ps.tenant_id AND t.status = 'active'
   WHERE ps.token_hash = p_token_hash AND ps.revoked_at IS NULL
     AND ps.idle_expires_at > ts AND ps.absolute_expires_at > ts
     AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = a.tenant_id AND c.id = a.contact_id AND c.deleted_at IS NULL)   -- 0091
     AND app.platform_cleared('platform:portal');
  IF NOT FOUND THEN RETURN; END IF;
  IF s.last_seen_at < ts - interval '1 minute' THEN
    UPDATE public.portal_sessions ps
       SET last_seen_at = ts, idle_expires_at = LEAST(ts + interval '24 hours', ps.absolute_expires_at)
     WHERE ps.tenant_id = s.tenant_id AND ps.id = s.id
    RETURNING ps.idle_expires_at INTO s.idle_expires_at;
  END IF;
  session_id := s.id; tenant_id := s.tenant_id; portal_account_id := s.portal_account_id; contact_id := s.contact_id;
  idle_expires_at := s.idle_expires_at; absolute_expires_at := s.absolute_expires_at;
  RETURN NEXT;
END $$;
ALTER FUNCTION portal.resolve_session(bytea) OWNER TO app_definer;
REVOKE ALL ON FUNCTION portal.resolve_session(bytea) FROM PUBLIC;

-- Self-check: each of the four is still a SECURITY DEFINER owned by app_definer with the pinned search_path, carries
-- the deleted-contact condition, is executable by app_user and not by PUBLIC.
DO $$
DECLARE f text; p record;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.portal_party_ok(uuid, uuid, uuid, uuid)', 'portal.request_login(citext, bytea, bytea[])',
                           'portal.consume_login(bytea, bytea, inet, text)', 'portal.resolve_session(bytea)'] LOOP
    SELECT pr.prosecdef, pg_get_userbyid(pr.proowner) AS owner, pr.proconfig, pr.prosrc INTO p FROM pg_proc pr WHERE pr.oid = f::regprocedure;
    IF NOT p.prosecdef OR p.owner <> 'app_definer' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
       OR p.prosrc NOT LIKE '%c.deleted_at IS NULL%'
       OR NOT has_function_privilege('app_user', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc pr, aclexplode(COALESCE(pr.proacl, acldefault('f', pr.proowner))) x
                   WHERE pr.oid = f::regprocedure AND x.grantee = 0 AND x.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '0091 self-check failed: %', f;
    END IF;
  END LOOP;
END $$;
