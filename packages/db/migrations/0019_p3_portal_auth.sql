-- =============================================================================
-- 0019_p3_portal_auth.sql : client-portal authentication base (PHASE2_3_PLAN module 43, db/p3-portal-auth).
-- (Lane migration; the orchestrator renumbers it when merging. Forward-only; never edits 0001-0018.)
--
-- What it adds
--   * three definer-only tenant tables (app_user has no privilege on them at all):
--       portal_login_tokens   single-use magic-link tokens (SHA-256 only, 15 minutes, superseded on re-request)
--       portal_sessions       client sessions (SHA-256 of the cookie token, idle + absolute expiry, revocable)
--       portal_stream_tokens  single-use 60-second document download tokens (R-PORTAL-7)
--   * schema `portal`: the only entry points of the client principal (pre-tenant or client context).
--   * no change to any existing table, policy or function.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4). Every function below is SECURITY DEFINER, owned by app_definer,
-- with search_path pinned to pg_catalog, public, and is listed with its threat notes in ARCHITECTURE §21.7:
--   portal.request_login(slug, address_hash, token_hashes[])  pre-tenant; refuses until platform:portal is cleared
--   portal.consume_login(token_hash, session_hash, ip, ua)    pre-tenant; single use; creates the session
--   portal.resolve_session(session_hash)                      pre-tenant; the ONLY source of a client context
--   portal.end_session(session_hash, reason)                  pre-tenant; sign out
--   portal.issue_document_stream(item_id, token_hash)          client context; re-checks the item chain
--   portal.document_object(token_hash)                         client context; single use; re-checks the chain again
--   portal.record_audit(action, entity_type, entity_id, ip, ua) client context; the portal audit definer
-- plus one helper that is NOT executable by app_user (portal.document_chain_internal, invoker rights, called
-- only from the two document definers).
--
-- Hardening choices (each closes a known foot-gun):
--   * no definer takes a caller-supplied "now": every expiry is compared with the database clock, so a caller
--     cannot back-date a check (the class 0016 fixed in app.retention_sweep).
--   * the client context (app.tenant_id, app.principal_type = 'client', app.portal_account_id) is never trusted
--     by itself: the document definers re-check the account, grant, party list, item, document and object rows.
--   * audit rows written for a client are actor_kind 'system', actor_via 'api', with changes.principal = 'client'
--     and changes.portal_account_id (audit_log.actor_kind has no 'client' value and this module changes no table).
--   * session lengths are engineering defaults (idle 24 h, absolute 14 days). VERIFY WITH COUNSEL (C10) and the
--     owner; the CHECKs cap them at 7 days idle and 30 days absolute.
-- =============================================================================

CREATE SCHEMA portal;
REVOKE ALL ON SCHEMA portal FROM PUBLIC;
GRANT USAGE ON SCHEMA portal TO app_user, app_definer;

-- -----------------------------------------------------------------------------
-- 1. Tables (definer-only). Layer 1 like every tenant table; the single permissive policy is `false`, so even a
--    future accidental GRANT to app_user reads and writes nothing. Only app_definer (BYPASSRLS) touches them.
-- -----------------------------------------------------------------------------
CREATE TABLE portal_login_tokens (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL,
  token_hash        bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),   -- sha256(raw token)
  portal_account_id uuid NOT NULL,
  login_point_id    uuid NOT NULL,                 -- the point the link was sent to; must still be the login point
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  superseded_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, portal_account_id) REFERENCES portal_accounts (tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK (num_nonnulls(used_at, superseded_at) <= 1)
);
CREATE INDEX portal_login_tokens_account_idx ON portal_login_tokens (tenant_id, portal_account_id, created_at DESC);

CREATE TABLE portal_sessions (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  token_hash          bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),  -- sha256(__Host-psid cookie)
  portal_account_id   uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_reason      text CHECK (revoked_reason IN ('logout','rotation','suspicious')),
  ip                  inet,
  user_agent          text CHECK (length(user_agent) <= 512),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, portal_account_id) REFERENCES portal_accounts (tenant_id, id) ON DELETE CASCADE,
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (idle_expires_at <= last_seen_at + interval '7 days'),
  CHECK (absolute_expires_at <= created_at + interval '30 days'),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX portal_sessions_account_idx ON portal_sessions (tenant_id, portal_account_id) WHERE revoked_at IS NULL;

CREATE TABLE portal_stream_tokens (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  token_hash        bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  portal_account_id uuid NOT NULL,
  portal_item_id    uuid NOT NULL,
  document_id       uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  PRIMARY KEY (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, portal_account_id) REFERENCES portal_accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, portal_item_id)    REFERENCES portal_items (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id)       REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 seconds'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_login_tokens','portal_sessions','portal_stream_tokens'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY definer_only ON public.%I FOR ALL USING (false) WITH CHECK (false)$p$, t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, app_user', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO app_definer', t);
    EXECUTE format('GRANT SELECT, DELETE ON public.%I TO app_retention', t);
  END LOOP;
END $$;

-- The definers below activate an invited account on its first sign-in and write portal audit rows.
GRANT UPDATE (status, activated_at) ON portal_accounts TO app_definer;
GRANT INSERT ON audit_log TO app_definer;

-- -----------------------------------------------------------------------------
-- 2. Internal helpers (not executable by app_user)
-- -----------------------------------------------------------------------------
-- An audit row on behalf of a client principal or a pre-tenant portal step. Called only from portal definers.
CREATE FUNCTION portal.audit_internal(p_tenant uuid, p_account uuid, p_action text, p_entity_type text, p_entity_id uuid,
                                      p_changes jsonb, p_ip inet, p_user_agent text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, public AS $$
  INSERT INTO public.audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, action, entity_type, entity_id, changes,
                                ip, user_agent)
  VALUES (p_tenant, gen_random_uuid(), now(), 'system', 'api', p_action, p_entity_type, p_entity_id,
          jsonb_build_object('principal', 'client', 'portal_account_id', p_account) || COALESCE(p_changes, '{}'::jsonb),
          p_ip, left(p_user_agent, 512))
$$;

-- The whole chain a client document download depends on, evaluated now (R-PORTAL-7): the client context names an
-- active account of an active tenant; the item is an unretracted document item of an unrevoked, unexpired grant of
-- that account; the account's contact is still a party to the grant's deal/listing; the document is that item's
-- document, of the grant's own deal or listing (never contact-scoped), shared to the portal and scanned clean;
-- its stored object is a live `document` object. Returns no row when anything fails. Invoker rights: it runs as
-- the calling definer (app_definer), never as app_user.
CREATE FUNCTION portal.document_chain_internal(p_item uuid)
RETURNS TABLE (tenant_id uuid, portal_account_id uuid, item_id uuid, document_id uuid, display_name text, object_id uuid,
               storage_key text, content_type text, byte_size bigint, sha256 bytea, dek_wrapped bytea, key_version integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT i.tenant_id, a.id, i.id, d.id, d.display_name, o.id, o.storage_key, o.content_type, o.byte_size, o.sha256,
         o.dek_wrapped, o.key_version
    FROM public.portal_items i
    JOIN public.portal_grants g   ON g.tenant_id = i.tenant_id AND g.id = i.grant_id
    JOIN public.portal_accounts a ON a.tenant_id = g.tenant_id AND a.id = g.portal_account_id
    JOIN public.tenants t         ON t.id = i.tenant_id
    JOIN public.documents d       ON d.tenant_id = i.tenant_id AND d.id = i.document_id
    JOIN public.stored_objects o  ON o.tenant_id = d.tenant_id AND o.id = d.object_id
   WHERE app.principal_type() = 'client'
     AND i.tenant_id = app.tenant_id() AND a.id = app.portal_account_id()
     AND i.id = p_item AND i.kind = 'document' AND i.retracted_at IS NULL
     AND a.status = 'active' AND t.status = 'active'
     AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
     AND app.portal_party_ok(g.tenant_id, g.portal_account_id, g.deal_id, g.listing_id)
     AND d.shared_to_portal AND d.scan_status = 'clean' AND d.contact_id IS NULL
     AND ((g.deal_id IS NOT NULL AND d.deal_id = g.deal_id) OR (g.listing_id IS NOT NULL AND d.listing_id = g.listing_id))
     AND o.purpose = 'document' AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL
     AND app.platform_cleared('platform:portal')
$$;

-- -----------------------------------------------------------------------------
-- 3. Pre-tenant entry points
-- -----------------------------------------------------------------------------
-- Magic-link request (R-PORTAL-5). p_address_hash = sha256 of the normalized address (lower-case email or E.164
-- phone, as core normalizes it). For every invited or active account of the tenant whose CURRENT login point has
-- that address (spouses may share an email: one account per contact, each gets its own link, E127), the i-th
-- account (oldest first) gets a 15-minute token whose hash is p_token_hashes[i]; earlier unused tokens of that
-- account are superseded. An account that already had 5 links in the last hour gets none (mail-bomb throttle).
-- Unknown slug, suspended tenant, unknown address or a throttled account: zero rows, nothing written. The caller
-- (module 45) must answer the HTTP request identically in every case and send the link through dispatchOutbound
-- in a system transaction of the returned tenant, to the returned login point (opt-outs apply).
CREATE FUNCTION portal.request_login(p_tenant_slug citext, p_address_hash bytea, p_token_hashes bytea[])
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

-- Magic-link sign-in (R-PORTAL-5). The token is used at most once (concurrent attempts: exactly one wins), must be
-- unexpired and not superseded, and the account must still be invited or active with the same, still-current
-- login point the link was sent to. A used token stays used even when a later check fails. On success an invited
-- account becomes active and a session is created (idle 24 h, absolute 14 days).
CREATE FUNCTION portal.consume_login(p_token_hash bytea, p_session_token_hash bytea, p_ip inet, p_user_agent text)
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

-- The only source of a client context (R-TEN-14). A live session of an active account of an active tenant, while
-- platform:portal is cleared; slides the idle expiry (at most once a minute) up to the absolute expiry. Staff
-- session tokens are in another table, so a staff cookie never resolves here and a portal cookie never resolves in
-- auth.resolve_session (E148, DB half).
CREATE FUNCTION portal.resolve_session(p_token_hash bytea)
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

-- Sign out (or rotation). Returns whether a live session was ended.
CREATE FUNCTION portal.end_session(p_token_hash bytea, p_reason text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('logout','rotation','suspicious') THEN
    RAISE EXCEPTION 'PORTAL_BAD_REQUEST: reason is logout, rotation or suspicious' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.portal_sessions ps SET revoked_at = now(), revoked_reason = p_reason
   WHERE ps.token_hash = p_token_hash AND ps.revoked_at IS NULL
  RETURNING ps.tenant_id, ps.id, ps.portal_account_id INTO s;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM portal.audit_internal(s.tenant_id, s.portal_account_id, 'portal.signed_out', 'portal_account', s.portal_account_id,
                                jsonb_build_object('session_id', s.id, 'reason', p_reason), NULL, NULL);
  RETURN true;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Client-context entry points (called inside withPortalTx)
-- -----------------------------------------------------------------------------
-- A 60-second single-use download token for a document item the client may open now (R-PORTAL-7).
CREATE FUNCTION portal.issue_document_stream(p_item_id uuid, p_token_hash bytea)
RETURNS TABLE (document_id uuid, display_name text, content_type text, byte_size bigint, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c record; ts timestamptz := now();
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'PORTAL_BAD_REQUEST: 32-byte token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO c FROM portal.document_chain_internal(p_item_id);
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.portal_stream_tokens (tenant_id, token_hash, portal_account_id, portal_item_id, document_id,
                                           created_at, expires_at)
  VALUES (c.tenant_id, p_token_hash, c.portal_account_id, c.item_id, c.document_id, ts, ts + interval '60 seconds');
  document_id := c.document_id; display_name := c.display_name; content_type := c.content_type;
  byte_size := c.byte_size; expires_at := ts + interval '60 seconds';
  RETURN NEXT;
END $$;

-- Redeems a download token once and re-checks the whole chain at download time; audited. Returns what the API
-- needs to stream and decrypt the object (the DEK is still wrapped under the platform KEK).
CREATE FUNCTION portal.document_object(p_token_hash bytea, p_ip inet DEFAULT NULL, p_user_agent text DEFAULT NULL)
RETURNS TABLE (document_id uuid, display_name text, object_id uuid, storage_key text, content_type text, byte_size bigint,
               sha256 bytea, dek_wrapped bytea, key_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tok record; c record;
BEGIN
  IF app.principal_type() IS DISTINCT FROM 'client' OR app.portal_account_id() IS NULL THEN RETURN; END IF;
  UPDATE public.portal_stream_tokens st SET used_at = now()
   WHERE st.tenant_id = app.tenant_id() AND st.token_hash = p_token_hash
     AND st.portal_account_id = app.portal_account_id() AND st.used_at IS NULL AND st.expires_at > now()
  RETURNING st.portal_item_id, st.document_id INTO tok;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO c FROM portal.document_chain_internal(tok.portal_item_id);
  IF NOT FOUND OR c.document_id IS DISTINCT FROM tok.document_id THEN RETURN; END IF;
  PERFORM portal.audit_internal(c.tenant_id, c.portal_account_id, 'portal.document_downloaded', 'document', c.document_id,
                                jsonb_build_object('portal_item_id', c.item_id), p_ip, p_user_agent);
  document_id := c.document_id; display_name := c.display_name; object_id := c.object_id; storage_key := c.storage_key;
  content_type := c.content_type; byte_size := c.byte_size; sha256 := c.sha256; dek_wrapped := c.dek_wrapped;
  key_version := c.key_version;
  RETURN NEXT;
END $$;

-- The portal audit definer: a client principal cannot write audit_log itself (staff-only Layer 1), so the
-- client routes record what a client did here. Only for the calling client's own, active account.
CREATE FUNCTION portal.record_audit(p_action text, p_entity_type text, p_entity_id uuid, p_ip inet DEFAULT NULL,
                                    p_user_agent text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.principal_type() IS DISTINCT FROM 'client' OR app.portal_account_id() IS NULL OR app.tenant_id() IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.portal_accounts a
                     WHERE a.tenant_id = app.tenant_id() AND a.id = app.portal_account_id() AND a.status = 'active') THEN
    RAISE EXCEPTION 'PORTAL_NOT_CLIENT: the portal audit definer records a signed-in client''s own actions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action IS NULL OR p_action !~ '^portal\.[a-z_]+(\.[a-z_]+)*$'
     OR p_entity_type NOT IN ('portal_account','portal_grant','portal_item','document') THEN
    RAISE EXCEPTION 'PORTAL_BAD_REQUEST: action portal.<verb>, entity portal_account/portal_grant/portal_item/document'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM portal.audit_internal(app.tenant_id(), app.portal_account_id(), p_action, p_entity_type, p_entity_id, '{}'::jsonb,
                                p_ip, p_user_agent);
END $$;

-- -----------------------------------------------------------------------------
-- 5. Ownership and grants: app_definer owns everything; app_user may call only the seven entry points.
-- -----------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'portal.audit_internal(uuid, uuid, text, text, uuid, jsonb, inet, text)',
    'portal.document_chain_internal(uuid)',
    'portal.request_login(citext, bytea, bytea[])',
    'portal.consume_login(bytea, bytea, inet, text)',
    'portal.resolve_session(bytea)',
    'portal.end_session(bytea, text)',
    'portal.issue_document_stream(uuid, bytea)',
    'portal.document_object(bytea, inet, text)',
    'portal.record_audit(text, text, uuid, inet, text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION portal.request_login(citext, bytea, bytea[]), portal.consume_login(bytea, bytea, inet, text),
  portal.resolve_session(bytea), portal.end_session(bytea, text), portal.issue_document_stream(uuid, bytea),
  portal.document_object(bytea, inet, text), portal.record_audit(text, text, uuid, inet, text) TO app_user;
-- the two helpers run inside the definers (as app_definer) only
GRANT EXECUTE ON FUNCTION portal.audit_internal(uuid, uuid, text, text, uuid, jsonb, inet, text),
  portal.document_chain_internal(uuid) TO app_definer;

-- -----------------------------------------------------------------------------
-- 6. Self-check (0001 §22 scans only the app and auth schemas): every SECURITY DEFINER function in `portal` is
--    owned by app_definer and pins search_path; nothing in `portal` is executable by PUBLIC; the three new tables
--    are invisible to app_user.
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'portal'
     AND (pg_get_userbyid(p.proowner) <> 'app_definer'
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
          OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED: portal function %', bad; END IF;
  SELECT string_agg(t, ', ') INTO bad FROM unnest(ARRAY['portal_login_tokens','portal_sessions','portal_stream_tokens']) t
   WHERE has_table_privilege('app_user', 'public.' || t, 'SELECT') OR has_table_privilege('app_user', 'public.' || t, 'INSERT')
      OR has_table_privilege('app_user', 'public.' || t, 'UPDATE') OR has_table_privilege('app_user', 'public.' || t, 'DELETE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED: app_user can reach definer-only table %', bad; END IF;
END $$;
