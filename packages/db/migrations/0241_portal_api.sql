-- =============================================================================
-- 0241_portal_api.sql : client-portal API support (PHASE2_3_PLAN module 45, lane api-portal).
-- (Lane placeholder number; the orchestrator renumbers it when merging. Forward-only; edits no earlier migration.)
--
-- What it changes
--   (a) portal_grants.display jsonb: the published copy of a grant's title, scope and contact card (R-PORTAL-18;
--       finding F6). Allowlisted keys and lengths in a CHECK. The grant guard is unchanged: it already refuses a
--       client write and freezes only its five binding columns; the update policy admits deal/listing writers and
--       tenant-wide actors (the system), exactly who may write the copy.
--   (b) portal_items: the full UNIQUE (tenant, grant, source_type, source_id, source_version) counted retracted
--       rows, so "retract it and publish again" (0018's own guard message) was impossible (F4). Replaced by a
--       unique index over LIVE rows only: two live copies of one source version are still refused.
--   (c) portal_items.retracted_by_user_id + a replaced app.portal_items_guard() (R-PORTAL-14, R-PORTAL-19):
--       (i)  through the deal's listing, a showing, its feedback or a seller update reaches a deal grant only
--            for a seller or co_seller of that deal in deal_contacts (core/portal's rule; F5, conflict note 1):
--            PORTAL_NOT_SELLER_SIDE;
--       (ii) retracted_at and retracted_by_user_id are written once, together: the person's own user id (stamped
--            when the writer leaves it out), or NULL for the system (so the sync can tell its retraction from a
--            person's, F13); another person's id is refused. An item is inserted live.
--       Every other branch is 0018's, word for word.
--   (d) gate_decisions.action_category admits 'portal_login_link' (the client's sign-in link, R-PORTAL-11; F7).
--       The list is 0080's plus the new category.
--   (e) portal.document_download(token_hash, ip, ua): portal.document_object's steps and audit, plus the
--       WRAPPED tenant `object` key of the object's own key_version (F1: a client transaction cannot read
--       app.tenant_key_material(), members only). portal.document_object stays for module 43's tests.
--   (f) indexes for portal.sync and the staff views.
--   (g) self-check: every `portal` function owned by app_definer, search_path pinned, not executable by PUBLIC;
--       the client allowlist is still exactly the three portal tables.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.43):
--   portal.document_download(bytea, inet, text)  SECURITY DEFINER, owner app_definer, search_path pinned,
--       EXECUTE to app_user only. Client context only (app.principal_type() = 'client' and an account id), the
--       stream token single use, 60 s, of the calling account; the whole chain re-checked by
--       portal.document_chain_internal; returns one wrapped key: purpose 'object', the object's key_version, not
--       destroyed (a retired key is still returned: older objects stay readable). The key is still wrapped under
--       the platform KEK, which lives only in the API process; the database never sees an unwrapped key.
--   app.portal_items_guard()  replaced (trigger, invoker rights): stricter only (seller side; retraction author).
--   portal_grants.display, portal_items.retracted_by_user_id: new columns on client-readable tables. The client
--       reads display (its own copy); retracted_by_user_id is only on retracted rows, which no client policy admits.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- (a) portal_grants.display
-- -----------------------------------------------------------------------------
ALTER TABLE portal_grants ADD COLUMN display jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE portal_grants ADD CONSTRAINT portal_grants_display_shape CHECK (
  jsonb_typeof(display) = 'object'
  AND (display - ARRAY['title','scope','agentName','textTo','emailTo']) = '{}'::jsonb
  AND (NOT display ? 'title' OR (jsonb_typeof(display->'title') = 'string'
        AND char_length(display->>'title') BETWEEN 1 AND 120 AND btrim(display->>'title') <> ''
        AND display->>'title' !~ '[[:cntrl:]]'))
  AND (NOT display ? 'scope' OR display->>'scope' IN ('purchase','sale','listing'))
  AND (NOT display ? 'scope' OR jsonb_typeof(display->'scope') = 'string')
  AND (NOT display ? 'agentName' OR (jsonb_typeof(display->'agentName') = 'string'
        AND char_length(display->>'agentName') BETWEEN 1 AND 120 AND display->>'agentName' !~ '[[:cntrl:]]'))
  AND (NOT display ? 'textTo' OR (jsonb_typeof(display->'textTo') = 'string' AND display->>'textTo' ~ '^\+[1-9][0-9]{6,14}$'))
  AND (NOT display ? 'emailTo' OR (jsonb_typeof(display->'emailTo') = 'string'
        AND char_length(display->>'emailTo') BETWEEN 3 AND 320 AND display->>'emailTo' ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'))
);

-- -----------------------------------------------------------------------------
-- (b) live-only uniqueness of a published source version
-- -----------------------------------------------------------------------------
DO $$
DECLARE c text;
BEGIN
  SELECT con.conname INTO c
    FROM pg_constraint con
   WHERE con.conrelid = 'public.portal_items'::regclass AND con.contype = 'u'
     AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
         = ARRAY['tenant_id','grant_id','source_type','source_id','source_version'];
  IF c IS NULL THEN RAISE EXCEPTION 'portal_items: the 0018 source-version UNIQUE was not found'; END IF;
  EXECUTE format('ALTER TABLE public.portal_items DROP CONSTRAINT %I', c);
END $$;
CREATE UNIQUE INDEX portal_items_live_source ON portal_items (tenant_id, grant_id, source_type, source_id, source_version)
  WHERE retracted_at IS NULL;

-- -----------------------------------------------------------------------------
-- (c) who retracted, and the replaced items guard
-- -----------------------------------------------------------------------------
ALTER TABLE portal_items ADD COLUMN retracted_by_user_id uuid;
-- DEFERRABLE INITIALLY DEFERRED (checked at commit): an immediate FK here made app.purge_contact_internal's cascade
-- fail a lead_email_messages inquiry FK re-check during an erase (apps/api/src/leadEmail/erasure.test.ts, admin/erasure.race.test.ts);
-- the guard already writes only the acting member's own id.
ALTER TABLE portal_items ADD CONSTRAINT portal_items_retracted_by_fk FOREIGN KEY (tenant_id, retracted_by_user_id)
  REFERENCES memberships (tenant_id, user_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE portal_items ADD CONSTRAINT portal_items_retracted_by_with_at CHECK (retracted_by_user_id IS NULL OR retracted_at IS NOT NULL);

-- An item copies a source that belongs to its grant's own deal or listing (a confirmed milestone of the deal,
-- a clean shared document of it, a showing or its feedback on its listing or attended by the client, the
-- listing's approved seller update, a task of the deal or listing), visible to the publisher. Through the deal's
-- listing only a seller or co_seller of the deal is reached (R-PORTAL-19). An item is inserted live; once
-- published only its retraction may be written, once, with its author: the person as themselves, NULL for the
-- system (R-PORTAL-14).
CREATE OR REPLACE FUNCTION app.portal_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g record; ok boolean; via_deal_listing boolean := false; seller_side boolean := false;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF app.principal_type() = 'client' THEN
    RAISE EXCEPTION 'CLIENT_READ_ONLY: a client principal never writes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.grant_id, NEW.kind, NEW.title, NEW.body, NEW.occurs_on, NEW.document_id, NEW.source_type, NEW.source_id,
        NEW.source_version, NEW.published_by_kind, NEW.published_by_user_id, NEW.published_at)
       IS DISTINCT FROM (OLD.grant_id, OLD.kind, OLD.title, OLD.body, OLD.occurs_on, OLD.document_id, OLD.source_type, OLD.source_id,
        OLD.source_version, OLD.published_by_kind, OLD.published_by_user_id, OLD.published_at) THEN
      RAISE EXCEPTION 'PORTAL_ITEM_IMMUTABLE: a published item never changes or moves; retract it and publish again'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.retracted_at IS NOT NULL THEN
      IF (NEW.retracted_at, NEW.retracted_by_user_id) IS DISTINCT FROM (OLD.retracted_at, OLD.retracted_by_user_id) THEN
        RAISE EXCEPTION 'PORTAL_ITEM_RETRACTED: a retraction is final' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.retracted_at IS NULL THEN
      IF NEW.retracted_by_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'PORTAL_RETRACTOR: the retraction and its author are written together' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    -- a person's retraction is stamped with their own id when the writer leaves it out (module 43's callers do)
    IF NEW.retracted_by_user_id IS NULL AND app.actor_kind() = 'user' THEN NEW.retracted_by_user_id := app.user_id(); END IF;
    IF NEW.retracted_by_user_id IS DISTINCT FROM (CASE WHEN app.actor_kind() = 'user' THEN app.user_id() END)
       OR app.actor_kind() IS NULL OR app.actor_kind() NOT IN ('user','system') THEN
      RAISE EXCEPTION 'PORTAL_RETRACTOR: a person retracts as themselves; the system records no person'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.retracted_at IS NOT NULL OR NEW.retracted_by_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'PORTAL_ITEM_RETRACTED: an item is published live; retract it afterwards' USING ERRCODE = 'check_violation';
  END IF;
  SELECT pg.deal_id, pg.listing_id, a.contact_id, d.listing_id AS deal_listing_id INTO g
    FROM public.portal_grants pg
    JOIN public.portal_accounts a ON a.tenant_id = pg.tenant_id AND a.id = pg.portal_account_id
    LEFT JOIN public.deals d ON d.tenant_id = pg.tenant_id AND d.id = pg.deal_id
   WHERE pg.tenant_id = NEW.tenant_id AND pg.id = NEW.grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PORTAL_SOURCE_NOT_IN_GRANT: the grant is not visible to the publisher' USING ERRCODE = 'check_violation';
  END IF;
  ok := CASE NEW.source_type
    WHEN 'deal_date' THEN EXISTS (SELECT 1 FROM public.deal_dates dd
           WHERE dd.tenant_id = NEW.tenant_id AND dd.id = NEW.source_id AND dd.deal_id = g.deal_id AND dd.status = 'confirmed')
    WHEN 'document' THEN EXISTS (SELECT 1 FROM public.documents doc
           WHERE doc.tenant_id = NEW.tenant_id AND doc.id = NEW.source_id AND doc.shared_to_portal AND doc.scan_status = 'clean'
             AND (doc.deal_id = g.deal_id OR doc.listing_id = g.listing_id))
    WHEN 'showing' THEN EXISTS (SELECT 1 FROM public.showings s
           WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.source_id
             AND (s.listing_id = g.listing_id OR s.buyer_contact_id = g.contact_id))
    WHEN 'showing_feedback' THEN EXISTS (SELECT 1 FROM public.showing_feedback f
           JOIN public.showings s ON s.tenant_id = f.tenant_id AND s.id = f.showing_id
           WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.source_id
             AND (s.listing_id = g.listing_id OR s.buyer_contact_id = g.contact_id))
    WHEN 'assistant_action' THEN EXISTS (SELECT 1 FROM public.assistant_actions aa
           WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.source_id AND aa.kind = 'seller_update_draft'
             AND aa.status IN ('approved','executed')
             AND aa.trigger_ref->>'listing_id' = g.listing_id::text)
    WHEN 'task' THEN EXISTS (SELECT 1 FROM public.tasks t
           WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.source_id
             AND (t.deal_id = g.deal_id OR t.listing_id = g.listing_id))
  END;
  -- R-PORTAL-19: the deal's own listing reaches the deal grant for a seller-side client only (core/portal 2(b))
  IF NOT COALESCE(ok, false) AND g.deal_listing_id IS NOT NULL AND NEW.source_type IN ('showing','showing_feedback','assistant_action') THEN
    via_deal_listing := CASE NEW.source_type
      WHEN 'showing' THEN EXISTS (SELECT 1 FROM public.showings s
             WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.source_id AND s.listing_id = g.deal_listing_id)
      WHEN 'showing_feedback' THEN EXISTS (SELECT 1 FROM public.showing_feedback f
             JOIN public.showings s ON s.tenant_id = f.tenant_id AND s.id = f.showing_id
             WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.source_id AND s.listing_id = g.deal_listing_id)
      WHEN 'assistant_action' THEN EXISTS (SELECT 1 FROM public.assistant_actions aa
             WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.source_id AND aa.kind = 'seller_update_draft'
               AND aa.status IN ('approved','executed') AND aa.trigger_ref->>'listing_id' = g.deal_listing_id::text)
    END;
    IF via_deal_listing THEN
      seller_side := EXISTS (SELECT 1 FROM public.deal_contacts dc
                              WHERE dc.tenant_id = NEW.tenant_id AND dc.deal_id = g.deal_id AND dc.contact_id = g.contact_id
                                AND dc.role IN ('seller','co_seller'));
      IF NOT seller_side THEN
        RAISE EXCEPTION 'PORTAL_NOT_SELLER_SIDE: through the deal''s listing, only a seller or co-seller of the deal sees showings, feedback and seller updates'
          USING ERRCODE = 'check_violation';
      END IF;
      ok := true;
    END IF;
  END IF;
  IF NOT COALESCE(ok, false) THEN
    RAISE EXCEPTION 'PORTAL_SOURCE_NOT_IN_GRANT: an item copies only a shareable source of the grant''s own deal or listing'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- (d) the sign-in link's gate category
-- -----------------------------------------------------------------------------
ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_action_category_check;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_action_category_check CHECK (action_category = ANY (ARRAY['none','speed_to_lead_reply',
  'reminder','booking_confirmation','document_chase','nurture_step','search_alert','opt_out_confirmation','help_reply','agent_alert','money',
  'contract','novel_message','seller_update','ai_isa_message','ai_isa_confirmation','ai_isa_holding_line','portal_login_link']));

-- -----------------------------------------------------------------------------
-- (e) the client download definer: the object's metadata plus its one wrapped tenant object key
-- -----------------------------------------------------------------------------
-- Redeems a download token once (the calling client's own, unexpired), re-checks the whole chain at download time
-- (portal.document_chain_internal), and returns the object plus the tenant `object` key of the object's key_version,
-- still wrapped under the platform KEK (the API unwraps it in process). No row when anything fails, including a
-- destroyed key (crypto-shred): the token stays used. Audited only when it returns a row.
CREATE FUNCTION portal.document_download(p_token_hash bytea, p_ip inet DEFAULT NULL, p_user_agent text DEFAULT NULL)
RETURNS TABLE (document_id uuid, display_name text, object_id uuid, storage_key text, content_type text, byte_size bigint,
               sha256 bytea, dek_wrapped bytea, key_version integer, object_key_wrapped bytea, object_key_version integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tok record; c record; k record;
BEGIN
  IF app.principal_type() IS DISTINCT FROM 'client' OR app.portal_account_id() IS NULL OR app.tenant_id() IS NULL THEN RETURN; END IF;
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN RETURN; END IF;
  UPDATE public.portal_stream_tokens st SET used_at = now()
   WHERE st.tenant_id = app.tenant_id() AND st.token_hash = p_token_hash
     AND st.portal_account_id = app.portal_account_id() AND st.used_at IS NULL AND st.expires_at > now()
  RETURNING st.portal_item_id, st.document_id INTO tok;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO c FROM portal.document_chain_internal(tok.portal_item_id);
  IF NOT FOUND OR c.document_id IS DISTINCT FROM tok.document_id THEN RETURN; END IF;
  SELECT tk.wrapped_key, tk.key_version INTO k
    FROM public.tenant_keys tk
   WHERE tk.tenant_id = c.tenant_id AND tk.purpose = 'object' AND tk.key_version = c.key_version
     AND tk.wrapped_key IS NOT NULL AND tk.destroyed_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM portal.audit_internal(c.tenant_id, c.portal_account_id, 'portal.document_downloaded', 'document', c.document_id,
                                jsonb_build_object('portal_item_id', c.item_id), p_ip, p_user_agent);
  document_id := c.document_id; display_name := c.display_name; object_id := c.object_id; storage_key := c.storage_key;
  content_type := c.content_type; byte_size := c.byte_size; sha256 := c.sha256; dek_wrapped := c.dek_wrapped;
  key_version := c.key_version; object_key_wrapped := k.wrapped_key; object_key_version := k.key_version;
  RETURN NEXT;
END $$;
ALTER FUNCTION portal.document_download(bytea, inet, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION portal.document_download(bytea, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal.document_download(bytea, inet, text) TO app_user;

-- -----------------------------------------------------------------------------
-- (f) indexes
-- -----------------------------------------------------------------------------
CREATE INDEX portal_items_source_live_idx ON portal_items (tenant_id, source_type, source_id) WHERE retracted_at IS NULL;
CREATE INDEX portal_grants_deal_live_idx ON portal_grants (tenant_id, deal_id) WHERE revoked_at IS NULL;
CREATE INDEX portal_grants_listing_live_idx ON portal_grants (tenant_id, listing_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- (g) self-check
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
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0241 self-check failed: portal function %', bad; END IF;
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation'
     AND pg_get_expr(p.polqual, p.polrelid) LIKE '%client%'
     AND c.relname NOT IN ('portal_accounts','portal_grants','portal_items');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0241 self-check failed: client principal admitted outside the portal allowlist: %', bad; END IF;
  IF NOT has_function_privilege('app_user', 'portal.document_download(bytea, inet, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0241 self-check failed: app_user cannot call portal.document_download';
  END IF;
END $$;
