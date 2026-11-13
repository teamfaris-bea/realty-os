-- =============================================================================
-- 0088_portal_link_seal.sql : the client's sign-in link never sits in a readable message body (PHASE2_3_PLAN module 45,
-- lane api-portal; batch 14 audit finding F2, orchestrator decision (a): approved as a flagged module-22 edit).
-- (Lane number 0242, renumbered 0088 at the batch 14 merge, after 0087_portal_api (lane number 0241). Forward-only;
-- edits no earlier migration.)
--
-- Before: a portal_login_link message stored the whole link in messages.body (plaintext, indexed, tokenized by 0032's
-- trigger, read by threads, the inbox, search and the handback and AI readers) until its status was final, which on
-- the worker-wins path was about 60 seconds and longer while dispatch_unknown.
-- Now: messages.body holds only a fixed line from the insert on. The URL lives here, sealed, keyed by the message id,
-- and only comms/dispatch.ts reads it, as the system, to render it into the SMS or email at the provider send and into
-- the reconcile's lookup.
--
-- What it adds
--   * portal_link_seals: one row per sign-in link message. url_enc is the link envelope-encrypted by the API under the
--     tenant `field` key with AAD = tenant | portal_link_seals | url_enc | <message id>, so a copy moved to another
--     message, column or tenant does not open. Definer-only like 0023's tables: FORCE RLS, the single permissive policy
--     is `false`, app_user has no privilege on it at all. A row lives at most 15 minutes (CHECK; the link's own life)
--     and goes at the message's first final status (trigger), at 15 minutes (portal.unseal_link from the link job,
--     portal.sweep_link_seals from portal.sync), and with the message (ON DELETE CASCADE: erasure, retention).
--   * portal.seal_link(message_id, url_enc)   system only; the message is this tenant's queued or scheduled outbound
--                                              portal_login_link message; one seal per message.
--   * portal.link_for_send(message_id)         system only; the sealed bytes while the message is dispatching or
--                                              dispatch_unknown and the seal is under 15 minutes old, else NULL.
--   * portal.unseal_link(message_id)           system only; deletes that message's seal.
--   * portal.sweep_link_seals()                system only; deletes this tenant's expired seals and those of messages
--                                              whose status is final.
--   * app.portal_link_seal_on_final()          trigger function (AFTER UPDATE OF status ON messages, only for a
--                                              portal_login_link row reaching a final status): deletes its seal.
-- No change to any column, policy or function of messages or of any earlier migration.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.52 "the sealed sign-in link"): the four portal definers and
-- the trigger function are SECURITY DEFINER, owned by app_definer, search_path pinned, never executable by PUBLIC;
-- app_user may execute the four portal ones (each refuses or answers nothing outside a system actor's own tenant), not
-- the trigger function. No definer returns plaintext: the database never sees the URL.
-- =============================================================================

CREATE TABLE portal_link_seals (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  message_id  uuid NOT NULL,
  url_enc     bytea NOT NULL CHECK (octet_length(url_enc) BETWEEN 32 AND 4096),   -- envelope ciphertext, never the URL
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, message_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX portal_link_seals_expiry_idx ON portal_link_seals (tenant_id, expires_at);

ALTER TABLE public.portal_link_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_link_seals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.portal_link_seals AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON public.portal_link_seals AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON public.portal_link_seals AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON public.portal_link_seals AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY definer_only ON public.portal_link_seals FOR ALL USING (false) WITH CHECK (false);
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.portal_link_seals
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
REVOKE ALL ON public.portal_link_seals FROM PUBLIC, app_user;
GRANT SELECT, INSERT, DELETE ON public.portal_link_seals TO app_definer;
GRANT SELECT, DELETE ON public.portal_link_seals TO app_retention;

-- The calling transaction is the system actor of a tenant (the API's asSystem / the worker), never a person, support
-- or a client principal. Internal (not executable by app_user); invoker rights, called only from the definers below.
CREATE FUNCTION portal.link_seal_caller_ok_internal() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT app.tenant_id() IS NOT NULL AND app.principal_type() = 'staff' AND app.actor_kind() = 'system'
$$;
ALTER FUNCTION portal.link_seal_caller_ok_internal() OWNER TO app_definer;
REVOKE ALL ON FUNCTION portal.link_seal_caller_ok_internal() FROM PUBLIC;

-- Seals a link right after queueOutboundInTx inserted its message, in the same transaction.
CREATE FUNCTION portal.seal_link(p_message_id uuid, p_url_enc bytea) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT portal.link_seal_caller_ok_internal() THEN
    RAISE EXCEPTION 'PORTAL_LINK_SEAL: only the system seals a sign-in link' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.messages m
                  WHERE m.tenant_id = app.tenant_id() AND m.id = p_message_id AND m.direction = 'outbound'
                    AND m.action_category = 'portal_login_link' AND m.status IN ('queued','scheduled')) THEN
    RAISE EXCEPTION 'PORTAL_LINK_SEAL: not a queued sign-in link of this tenant' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.portal_link_seals (tenant_id, message_id, url_enc, created_at, expires_at)
  VALUES (app.tenant_id(), p_message_id, p_url_enc, now(), now() + interval '15 minutes');
END $$;

-- The sealed bytes, for comms/dispatch.ts only: while the message is being sent (dispatching: providerSend) or its
-- outcome is unknown (dispatch_unknown: reconcileOutbound), and only within the link's 15 minutes.
CREATE FUNCTION portal.link_for_send(p_message_id uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.url_enc
    FROM public.portal_link_seals s
    JOIN public.messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
   WHERE portal.link_seal_caller_ok_internal()
     AND s.tenant_id = app.tenant_id() AND s.message_id = p_message_id AND s.expires_at > now()
     AND m.direction = 'outbound' AND m.action_category = 'portal_login_link' AND m.status IN ('dispatching','dispatch_unknown')
$$;

CREATE FUNCTION portal.unseal_link(p_message_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT portal.link_seal_caller_ok_internal() THEN RETURN false; END IF;
  DELETE FROM public.portal_link_seals s WHERE s.tenant_id = app.tenant_id() AND s.message_id = p_message_id;
  RETURN FOUND;
END $$;

CREATE FUNCTION portal.sweep_link_seals() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  IF NOT portal.link_seal_caller_ok_internal() THEN RETURN 0; END IF;
  DELETE FROM public.portal_link_seals s
   WHERE s.tenant_id = app.tenant_id()
     AND (s.expires_at <= now()
          OR EXISTS (SELECT 1 FROM public.messages m WHERE m.tenant_id = s.tenant_id AND m.id = s.message_id
                        AND m.status NOT IN ('queued','scheduled','dispatching','dispatch_unknown')));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['portal.seal_link(uuid, bytea)', 'portal.link_for_send(uuid)', 'portal.unseal_link(uuid)', 'portal.sweep_link_seals()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', f);
  END LOOP;
END $$;

-- The first final status of a link message drops its seal, whichever path wrote it (TX2, the reconcile, a status
-- webhook, a block, a cancel). The WHEN clause keeps every other message off this function.
CREATE FUNCTION app.portal_link_seal_on_final() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.portal_link_seals s WHERE s.tenant_id = NEW.tenant_id AND s.message_id = NEW.id;
  RETURN NULL;
END $$;
ALTER FUNCTION app.portal_link_seal_on_final() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.portal_link_seal_on_final() FROM PUBLIC;
CREATE TRIGGER messages_portal_link_seal_final AFTER UPDATE OF status ON public.messages
  FOR EACH ROW WHEN (NEW.action_category = 'portal_login_link'
                     AND NEW.status IN ('sent','delivered','failed','undelivered','bounced','blocked','canceled'))
  EXECUTE FUNCTION app.portal_link_seal_on_final();

-- -----------------------------------------------------------------------------
-- Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE (n.nspname = 'portal' OR p.oid = 'app.portal_link_seal_on_final()'::regprocedure)
     AND (pg_get_userbyid(p.proowner) <> 'app_definer'
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
          OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0088 self-check failed: function %', bad; END IF;
  IF has_function_privilege('app_user', 'app.portal_link_seal_on_final()', 'EXECUTE')
     OR has_function_privilege('app_user', 'portal.link_seal_caller_ok_internal()', 'EXECUTE') THEN
    RAISE EXCEPTION '0088 self-check failed: app_user may execute an internal function';
  END IF;
  IF has_table_privilege('app_user', 'public.portal_link_seals', 'SELECT')
     OR has_table_privilege('app_user', 'public.portal_link_seals', 'INSERT')
     OR has_table_privilege('app_user', 'public.portal_link_seals', 'UPDATE')
     OR has_table_privilege('app_user', 'public.portal_link_seals', 'DELETE') THEN
    RAISE EXCEPTION '0088 self-check failed: app_user has a privilege on portal_link_seals';
  END IF;
END $$;
