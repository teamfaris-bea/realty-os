-- Channels and inbox (module 22, the rest after the lead-email slice; PHASE2_3_PLAN §5.4 #22, §2.2 D2/D4;
-- DATA_MODEL R-INBOX-1..9, R-CHAN-2/3, R-TEN-12, R-NURT-5, R-GMAIL-12; ARCHITECTURE §21 security notes).
--
-- No table shape and no RLS policy changes (PHASE2_3_PLAN §3 migration policy): web-chat sessions, web-chat
-- messages (messages.channel 'web_chat'), web-chat identities (contact_points.kind 'web_chat', address wc:<hex>)
-- and messages.rfc_message_id_sha256 all exist since 0018 / 0025 / 0030. This migration adds:
--
--   app.resolve_webchat_widget(bytea)        SECURITY REVIEW ITEM: pre-tenant definer, widget key hash -> the widget
--   app.webchat_session(bytea)               SECURITY REVIEW ITEM: pre-tenant definer, session token hash -> session
--   app.webchat_poll(bytea, timestamptz, uuid, int)
--                                            SECURITY REVIEW ITEM: pre-tenant definer, that session's delivered
--                                            outbound chat messages only (R-TEN-12)
--   app.record_person_opt_out(uuid, uuid)    invoker (NOT a definer): sets the person-level do-not-contact citing a
--                                            revoke of that contact in the ledger; the caller's RLS applies
--   messages_webchat_poll_idx                the poll's index
--
-- Visitors are not principals (R-TEN-12): the three definers are the only way an unauthenticated chat request reads
-- anything, and each returns minimal columns. Every write after resolution runs as the system actor of the tenant the
-- definer returned (the API's withTenantTx), under the ordinary FORCE RLS policies (webchat_system, messages, ...).
-- The lifting definers the plan lists for M22 (app.reinstate_person_contact, app.undo_language_opt_out) are not added
-- here: lifting a person-level opt-out is the person's own action (R-CHAN-2/3) and stays fail-closed until those are
-- specified with counsel (lane report gap).

-- -----------------------------------------------------------------------------
-- 1. The widget resolver (SECURITY REVIEW ITEM)
-- -----------------------------------------------------------------------------
-- Input: sha256 of the public widget key the embed carries. Output: at most one row.
--   live = true:  a connected/degraded web_chat_widget connection with a lead source, in an active tenant:
--                 (tenant_id, connection_id, lead_source_id, true, allowed_origins)
--   live = false: a known key whose widget is not live (disconnected, revoked, not configured) or whose tenant is not
--                 active: (NULL, NULL, NULL, false, '{}') — no tenant is revealed; the API answers CHANNEL_NOT_CONNECTED
--   no row:       unknown key (NOT_FOUND)
-- Owned by app_definer (BYPASSRLS), pinned search_path, STABLE, writes nothing.
CREATE FUNCTION app.resolve_webchat_widget(p_key_hash bytea)
RETURNS TABLE (tenant_id uuid, connection_id uuid, lead_source_id uuid, live boolean, allowed_origins text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN ok THEN x.tenant_id END, CASE WHEN ok THEN x.id END, CASE WHEN ok THEN x.lead_source_id END,
         ok, CASE WHEN ok THEN x.allowed_origins ELSE '{}'::text[] END
    FROM (SELECT c.tenant_id, c.id, c.lead_source_id, c.allowed_origins,
                 (c.status IN ('connected','degraded') AND c.lead_source_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = c.tenant_id AND t.status = 'active')) AS ok
            FROM public.integration_connections c
           WHERE octet_length(p_key_hash) = 32 AND c.kind = 'web_chat_widget' AND c.widget_key_hash = p_key_hash) x
$$;
ALTER FUNCTION app.resolve_webchat_widget(bytea) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.resolve_webchat_widget(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_webchat_widget(bytea) TO app_user;

-- -----------------------------------------------------------------------------
-- 2. The session resolver (SECURITY REVIEW ITEM)
-- -----------------------------------------------------------------------------
-- Input: sha256 of the session token the visitor holds (issued once by /public/chat/:widgetKey/start). Output: at
-- most one row: the session's tenant, ids, its contact (NULL for a session that never got one, e.g. spam), whether it
-- is open (not closed, seen in the last 30 minutes: E77) and whether its widget is still live (R-INBOX-7). An inactive
-- tenant's sessions resolve to nothing. STABLE, writes nothing, minimal columns.
CREATE FUNCTION app.webchat_session(p_token_hash bytea)
RETURNS TABLE (tenant_id uuid, session_id uuid, connection_id uuid, contact_id uuid, contact_point_id uuid,
               open boolean, widget_live boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id, s.id, s.connection_id, s.contact_id, s.contact_point_id,
         (s.closed_at IS NULL AND s.last_seen_at > now() - interval '30 minutes'),
         (c.status IN ('connected','degraded'))
    FROM public.webchat_sessions s
    JOIN public.integration_connections c ON c.tenant_id = s.tenant_id AND c.id = s.connection_id AND c.kind = 'web_chat_widget'
    JOIN public.tenants t ON t.id = s.tenant_id AND t.status = 'active'
   WHERE octet_length(p_token_hash) = 32 AND s.token_hash = p_token_hash
$$;
ALTER FUNCTION app.webchat_session(bytea) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.webchat_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.webchat_session(bytea) TO app_user;

-- -----------------------------------------------------------------------------
-- 3. The visitor's poll (SECURITY REVIEW ITEM, R-TEN-12, R-INBOX-5)
-- -----------------------------------------------------------------------------
-- The outbound web-chat messages sent to THIS session's own chat identity (contact_points.address wc:<hex>, unique
-- per session and never typed by anyone) through this session's widget, that actually went out (sent/delivered; a
-- blocked, canceled, queued or failed message is never shown), after the (sent_at, id) cursor, oldest first, at most
-- 50. Columns: id, body, sent instant, and who wrote it ('team' for a person, 'assistant' otherwise: the assistant
-- never passes as a human). Nothing about the contact, the team or other channels is returned. A merge that moves the
-- identity to another contact keeps the match (the address is the session's own). The widget must still be live
-- (R-INBOX-7) and the tenant active. STABLE, writes nothing.
CREATE FUNCTION app.webchat_poll(p_token_hash bytea, p_after_at timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (message_id uuid, body text, sent_at timestamptz, author text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.id, m.body, m.dispatched_at, CASE WHEN m.initiator = 'human' THEN 'team' ELSE 'assistant' END
    FROM public.webchat_sessions s
    JOIN public.integration_connections c ON c.tenant_id = s.tenant_id AND c.id = s.connection_id
                                         AND c.kind = 'web_chat_widget' AND c.status IN ('connected','degraded')
    JOIN public.tenants t ON t.id = s.tenant_id AND t.status = 'active'
    JOIN public.contact_points p ON p.tenant_id = s.tenant_id AND p.id = s.contact_point_id AND p.kind = 'web_chat'
    JOIN public.messages m ON m.tenant_id = s.tenant_id AND m.channel = 'web_chat' AND m.direction = 'outbound'
                          AND m.integration_connection_id = s.connection_id AND m.to_address = p.address
                          AND m.status IN ('sent','delivered') AND m.dispatched_at IS NOT NULL
   WHERE octet_length(p_token_hash) = 32 AND s.token_hash = p_token_hash
     AND (p_after_at IS NULL OR (m.dispatched_at, m.id) > (p_after_at, COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
   ORDER BY m.dispatched_at, m.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50)
$$;
ALTER FUNCTION app.webchat_poll(bytea, timestamptz, uuid, integer) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.webchat_poll(bytea, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.webchat_poll(bytea, timestamptz, uuid, integer) TO app_user;
-- app_definer reads the four tables it joins (SELECT on messages, contact_points and tenants exists since 0001;
-- integration_connections and webchat_sessions since 0018). Stated again here so the dependency is explicit.
GRANT SELECT ON webchat_sessions, integration_connections TO app_definer;

CREATE INDEX messages_webchat_poll_idx ON messages (tenant_id, to_address, dispatched_at, id)
  WHERE channel = 'web_chat' AND direction = 'outbound';

-- -----------------------------------------------------------------------------
-- 4. The person-level opt-out (R-CHAN-2/3, F19). INVOKER, not a definer.
-- -----------------------------------------------------------------------------
-- Sets contacts.do_not_contact_at once, citing a revoke of THAT contact in the consent ledger (the 0018 guard checks
-- the citation too). It runs with the caller's privileges and RLS: a person can set it only on a contact they may
-- update; the system actor on its tenant's contacts. It only ever refuses more: it never clears or moves an existing
-- do-not-contact (the 0018 guard makes clearing a reviewed definer's job only). Returns true when it set it now.
CREATE FUNCTION app.record_person_opt_out(p_contact uuid, p_event uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  IF app.tenant_id() IS NULL THEN
    RAISE EXCEPTION 'TENANT_REQUIRED: app.record_person_opt_out needs a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.consent_events e
                  WHERE e.tenant_id = app.tenant_id() AND e.id = p_event AND e.event_type = 'revoke'
                    AND e.contact_id = p_contact) THEN
    RAISE EXCEPTION 'PERSON_OPT_OUT_EVIDENCE: a do-not-contact must cite a revoke of this contact in the consent ledger'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.contacts SET do_not_contact_at = now(), do_not_contact_event_id = p_event, updated_at = now()
   WHERE tenant_id = app.tenant_id() AND id = p_contact AND do_not_contact_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
REVOKE ALL ON FUNCTION app.record_person_opt_out(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_person_opt_out(uuid, uuid) TO app_user;

-- -----------------------------------------------------------------------------
-- 5. SCHEMA GAP FIX (security review item; PHASE2_3_PLAN §3 migration policy): gate_decisions.channel
-- -----------------------------------------------------------------------------
-- 0018 widened the channel CHECK of messages, consent_events, consent_state and suppressions to the web-chat
-- channel but not gate_decisions', so a BLOCKED chat send could not be recorded (R-GATE-14: every blocked send
-- writes gate_decisions and reaches no provider). This adds 'web_chat' only; nothing else in the table changes, and
-- the out-of-scope Meta channels (D2) stay refused.
ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_channel_check;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_channel_check CHECK (channel IN ('sms','voice','email','web_chat'));

-- -----------------------------------------------------------------------------
-- 6. The 30-day purge of contact-less chat sessions (SECURITY REVIEW ITEM, R-INBOX-5)
-- -----------------------------------------------------------------------------
-- A session that never got a contact (spam, E137) is purged at purge_after. app_user has no DELETE on
-- webchat_sessions, and app.retention_sweep is left alone (0018 left these rows to module 22), so this definer is
-- owned by app_retention (which holds DELETE). It deletes only rows of the CALLER's tenant (app.tenant_id(), required),
-- only when called by the system actor, only contact-less sessions whose purge_after has passed. Returns the count.
CREATE FUNCTION app.purge_webchat_sessions(p_now timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t uuid := app.tenant_id(); n integer;
BEGIN
  IF t IS NULL OR app.actor_kind() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'WEBCHAT_PURGE_SYSTEM_ONLY: only the system actor of a tenant purges its chat sessions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.webchat_sessions
   WHERE tenant_id = t AND contact_id IS NULL AND purge_after IS NOT NULL AND purge_after <= p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION app.purge_webchat_sessions(timestamptz) OWNER TO app_retention;
REVOKE ALL ON FUNCTION app.purge_webchat_sessions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_webchat_sessions(timestamptz) TO app_user;

-- -----------------------------------------------------------------------------
-- 7. Self-check: the three definers are owned by app_definer with a pinned search_path; the opt-out function is not
--    a definer; nothing is executable by PUBLIC.
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid IN ('app.resolve_webchat_widget(bytea)'::regprocedure, 'app.webchat_session(bytea)'::regprocedure,
                       'app.webchat_poll(bytea,timestamptz,uuid,integer)'::regprocedure)
         AND p.prosecdef AND r.rolname = 'app_definer' AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) <> 3 THEN
    bad := bad || ' definer_shape';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'app.record_person_opt_out(uuid,uuid)'::regprocedure) THEN
    bad := bad || ' opt_out_definer';
  END IF;
  IF NOT (SELECT p.prosecdef AND r.rolname = 'app_retention' FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'app.purge_webchat_sessions(timestamptz)'::regprocedure) THEN
    bad := bad || ' purge_shape';
  END IF;
  IF has_function_privilege('public', 'app.purge_webchat_sessions(timestamptz)', 'EXECUTE')
     OR has_function_privilege('public', 'app.webchat_poll(bytea,timestamptz,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('public', 'app.webchat_session(bytea)', 'EXECUTE')
     OR has_function_privilege('public', 'app.resolve_webchat_widget(bytea)', 'EXECUTE')
     OR has_function_privilege('public', 'app.record_person_opt_out(uuid,uuid)', 'EXECUTE') THEN
    bad := bad || ' public_execute';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'channels_inbox self-check failed:%', bad; END IF;
END $$;
