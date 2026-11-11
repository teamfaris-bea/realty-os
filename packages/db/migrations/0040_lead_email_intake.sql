-- Lead-email intake (module 22's lead-email slice, pulled forward by the owner on 2026-11-11; PHASE2_3_PLAN §5.4 #22,
-- §2.2 D2; DATA_MODEL R-INBOX-9, R-INT-3, R-LEM-1..8; ARCHITECTURE §21 "Webhooks", §21.8).
--
-- A lead source can have ONE lead-email inbox (an integration_connections row of kind 'lead_email'). Its inbound
-- address is leads+<key>@<platform inbound domain>, where <key> is a server-generated, unguessable token:
--   lead_email_inbox_keys    the inbox's keys. Only sha256(key) routes (global unique index); the key itself is kept
--                            envelope-encrypted (key_enc) so Owner/Admin can see and copy the address again. Rotation
--                            retires the current key (retired_at, final) and adds a new one in one transaction; a
--                            retired key routes nothing.
--   lead_email_messages      every lead email that reached a live inbox: created a lead (DKIM pass aligned with an
--                            allowlisted sender domain and a parsed contact point), or held in "Needs review" with
--                            the reason (hold_code) until an Owner/Admin/Team Lead accepts it (through the same
--                            intake path) or discards it. One row per (tenant, provider message key): replay-safe
--                            beyond the webhook_events purge window.
--   app.resolve_lead_email_key(bytea)
--                            SECURITY REVIEW ITEM (CONVENTIONS §4): pre-tenant definer, key hash -> (tenant,
--                            connection, lead source) of a CURRENT key of a connected/degraded lead_email connection
--                            whose lead source is active, in an active tenant; nothing otherwise. It never reads the
--                            payload, returns three ids, writes nothing. Lead inboxes have no external account and are
--                            never resolved by app.resolve_channel_account (ARCHITECTURE §21.8).
-- Nothing here weakens RLS: both tables are FORCE RLS with the Layer-1 tenant and support-read-only policies; writes
-- are the system actor's only (the webhook, and human decisions that re-read the role under the system actor).

-- -----------------------------------------------------------------------------
-- 1. Keys
-- -----------------------------------------------------------------------------
CREATE TABLE lead_email_inbox_keys (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  connection_id      uuid NOT NULL,
  key_hash           bytea NOT NULL CHECK (octet_length(key_hash) = 32),   -- sha256(key): the only routing input
  key_enc            bytea NOT NULL,                                       -- envelope-encrypted key (shown to Owner/Admin)
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz,                                          -- rotation; final
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id)      REFERENCES integration_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id)
);
-- a key routes in at most one tenant, ever (retired keys keep their hash so they can never be re-issued)
CREATE UNIQUE INDEX lead_email_inbox_keys_hash ON lead_email_inbox_keys (key_hash);
-- one current key per inbox
CREATE UNIQUE INDEX lead_email_inbox_keys_current ON lead_email_inbox_keys (tenant_id, connection_id) WHERE retired_at IS NULL;

-- Keys are inserted for lead_email connections only, and the only change ever allowed is retiring a current key.
CREATE FUNCTION app.lead_email_inbox_keys_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.integration_connections c
                    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.connection_id AND c.kind = 'lead_email') THEN
      RAISE EXCEPTION 'LEAD_EMAIL_KEY_KIND: keys belong to lead_email connections only' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'LEAD_EMAIL_KEY_NEW_RETIRED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.connection_id, NEW.key_hash, NEW.key_enc, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.connection_id, OLD.key_hash, OLD.key_enc, OLD.created_by_user_id, OLD.created_at)
     OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'LEAD_EMAIL_KEY_IMMUTABLE: a key is only ever retired, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_email_inbox_keys_guard BEFORE INSERT OR UPDATE ON lead_email_inbox_keys
  FOR EACH ROW EXECUTE FUNCTION app.lead_email_inbox_keys_guard();
CREATE TRIGGER lead_email_inbox_keys_no_delete BEFORE DELETE ON lead_email_inbox_keys
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- -----------------------------------------------------------------------------
-- 2. Messages (created leads and the "Needs review" list)
-- -----------------------------------------------------------------------------
CREATE TABLE lead_email_messages (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  connection_id       uuid NOT NULL,
  lead_source_id      uuid NOT NULL,
  message_key_sha256  bytea NOT NULL CHECK (octet_length(message_key_sha256) = 32),   -- sha256(provider message id)
  provider_format     text NOT NULL CHECK (provider_format IN ('generic','postmark','sendgrid')),
  received_at         timestamptz NOT NULL,
  status              text NOT NULL CHECK (status IN ('lead_created','needs_review','accepted','discarded')),
  hold_code           text CHECK (hold_code IN ('DKIM_MISSING','DKIM_FAILED','DKIM_UNALIGNED','SENDER_NOT_ALLOWED',
                        'FROM_INVALID','UNKNOWN_FORMAT','PARTIAL_FORMAT','NO_CONTACT_POINT')),
  parser_kind         text CHECK (parser_kind IN ('zillow','realtor','generic')),
  sender_domain       text CHECK (sender_domain IS NULL OR length(sender_domain) <= 253),   -- the From header's domain
  dkim_pass_domains   text[] NOT NULL DEFAULT '{}',                                        -- d= of passing signatures (provider verdict)
  content_enc         bytea,            -- subject + text (HTML stripped, capped), envelope-encrypted; NULL once decided
  parsed_enc          bytea,            -- the parsed fields with their source spans, envelope-encrypted; NULL once decided
  contact_id          uuid,
  inquiry_id          uuid,
  decided_by_user_id  uuid,
  decided_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, message_key_sha256),
  FOREIGN KEY (tenant_id, connection_id)      REFERENCES integration_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_source_id)     REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)         REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, inquiry_id)         REFERENCES lead_inquiries (tenant_id, id) ON DELETE SET NULL (inquiry_id),
  FOREIGN KEY (tenant_id, decided_by_user_id) REFERENCES memberships (tenant_id, user_id),
  -- a lead is created automatically only from a trusted, parsed email (no hold reason); held mail always says why
  CHECK ((status = 'lead_created') = (hold_code IS NULL)),
  CHECK (status <> 'lead_created' OR parser_kind IS NOT NULL),
  CHECK ((status IN ('accepted','discarded')) = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)),
  CHECK (status NOT IN ('accepted','discarded') OR (content_enc IS NULL AND parsed_enc IS NULL))
);
CREATE INDEX lead_email_messages_review_idx ON lead_email_messages (tenant_id, received_at DESC) WHERE status = 'needs_review';
CREATE INDEX lead_email_messages_contact_idx ON lead_email_messages (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE TRIGGER lead_email_messages_touch_updated_at BEFORE UPDATE ON lead_email_messages
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The only transitions: needs_review -> accepted | discarded (once). A row's identity, trust facts and origin never
-- change; contact_id / inquiry_id are written once (or cleared by erasure's ON DELETE SET NULL).
CREATE FUNCTION app.lead_email_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('lead_created','needs_review') THEN
      RAISE EXCEPTION 'LEAD_EMAIL_STATUS: a lead email starts as lead_created or needs_review' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.connection_id, NEW.lead_source_id, NEW.message_key_sha256, NEW.provider_format, NEW.received_at,
      NEW.hold_code, NEW.parser_kind, NEW.sender_domain, NEW.dkim_pass_domains, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.connection_id, OLD.lead_source_id, OLD.message_key_sha256, OLD.provider_format, OLD.received_at,
      OLD.hold_code, OLD.parser_kind, OLD.sender_domain, OLD.dkim_pass_domains, OLD.created_at) THEN
    RAISE EXCEPTION 'LEAD_EMAIL_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'needs_review' AND NEW.status IN ('accepted','discarded')) THEN
    RAISE EXCEPTION 'LEAD_EMAIL_TRANSITION: only a held email is decided, once' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.contact_id IS NOT NULL AND NEW.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     OR (OLD.inquiry_id IS NOT NULL AND NEW.inquiry_id IS NOT NULL AND NEW.inquiry_id IS DISTINCT FROM OLD.inquiry_id) THEN
    RAISE EXCEPTION 'LEAD_EMAIL_LINK_FINAL' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'discarded' AND NEW.contact_id IS NOT NULL AND OLD.contact_id IS NULL THEN
    RAISE EXCEPTION 'LEAD_EMAIL_DISCARD_NO_LEAD' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_email_messages_guard BEFORE INSERT OR UPDATE ON lead_email_messages
  FOR EACH ROW EXECUTE FUNCTION app.lead_email_messages_guard();

-- -----------------------------------------------------------------------------
-- 3. Row-level security (Layer 1 as 0001/0018; Layer 2 below) and grants
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_email_inbox_keys','lead_email_messages'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
  END LOOP;
END $$;

-- Keys: Owner/Admin and the system read (support never: a key is a secret); only the system writes (the API
-- re-reads the role as the system).
CREATE POLICY lead_email_keys_read ON lead_email_inbox_keys FOR SELECT
  USING ((SELECT app.is_tenant_wide()) AND (SELECT app.actor_kind()) <> 'support');
CREATE POLICY lead_email_keys_insert ON lead_email_inbox_keys FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY lead_email_keys_update ON lead_email_inbox_keys FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'system') WITH CHECK ((SELECT app.actor_kind()) = 'system');

-- Messages: Owner/Admin/Team Lead (and support, read-only) read the review list; only the system writes.
CREATE POLICY lead_email_messages_read ON lead_email_messages FOR SELECT
  USING ((SELECT app.is_tenant_wide()) OR COALESCE((SELECT app.my_role()) = 'team_lead', false));
CREATE POLICY lead_email_messages_insert ON lead_email_messages FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY lead_email_messages_update ON lead_email_messages FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'system') WITH CHECK ((SELECT app.actor_kind()) = 'system');

GRANT SELECT, INSERT, UPDATE ON lead_email_inbox_keys, lead_email_messages TO app_user;
GRANT SELECT ON lead_email_inbox_keys, lead_email_messages TO app_definer;
GRANT SELECT, UPDATE, DELETE ON lead_email_messages TO app_retention;
GRANT SELECT ON lead_email_inbox_keys TO app_retention;

-- -----------------------------------------------------------------------------
-- 4. The key resolver (SECURITY REVIEW ITEM)
-- -----------------------------------------------------------------------------
-- Pre-tenant (called by the webhook before any tenant context exists). Input: sha256 of the token the provider's
-- recipient address carried. Output: at most one (tenant_id, connection_id, lead_source_id): the CURRENT key of a
-- connected/degraded lead_email connection, whose lead source is active, in an active tenant. A retired (rotated)
-- key, another kind's key, a disconnected inbox or an inactive source resolve to nothing (the caller records the
-- delivery as unrouted). Owned by app_definer (BYPASSRLS), pinned search_path, STABLE, no write, minimal columns.
CREATE FUNCTION app.resolve_lead_email_key(p_key_hash bytea)
RETURNS TABLE (tenant_id uuid, connection_id uuid, lead_source_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id, c.id, c.lead_source_id
    FROM public.lead_email_inbox_keys k
    JOIN public.integration_connections c ON c.tenant_id = k.tenant_id AND c.id = k.connection_id
    JOIN public.lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.lead_source_id AND s.active
    JOIN public.tenants t ON t.id = c.tenant_id AND t.status = 'active'
   WHERE octet_length(p_key_hash) = 32
     AND k.key_hash = p_key_hash
     AND k.retired_at IS NULL
     AND c.kind = 'lead_email'
     AND c.status IN ('connected','degraded')
$$;
ALTER FUNCTION app.resolve_lead_email_key(bytea) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.resolve_lead_email_key(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_lead_email_key(bytea) TO app_user;

-- one lead-email inbox per lead source (a second "enable" reuses the live one)
CREATE UNIQUE INDEX integration_connections_lead_email_source ON integration_connections (tenant_id, lead_source_id)
  WHERE kind = 'lead_email' AND status <> 'disconnected';
