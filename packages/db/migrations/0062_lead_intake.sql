-- Lead intake expansion (module 22 intake continuation + the Lead sources page; DATA_MODEL R-LSRC-1..7, R-LEM-9..12,
-- R-GADS-1..4, R-TRK-1..3; ARCHITECTURE §21 "Lead intake: sources, forms, tracking numbers"). The orchestrator renumbers
-- this file at merge; nothing in code or tests names it.
--
--   (a) phone_numbers.lead_source_id     a live tracking number may be tied to one lead source (R-TRK-1)
--   (b) google_lead_form_hooks           a source's Google Ads lead form webhook key (R-GADS-1): only sha256(key) routes,
--                                        the key itself is envelope-encrypted and re-showable to Owner/Admin (as
--                                        lead_email_inbox_keys.key_enc); retirement is final
--   (c) lead_source_webhook_secrets      a source's own X-Realty-Signature secret (R-LSRC-3), system-only (lead_sources is
--                                        member-readable, so the secret is not a column there)
--   (d) app.resolve_google_lead_form     SECURITY REVIEW ITEM: pre-tenant definer, key hash -> (tenant, hook, source)
--   (e) lead_email_messages              hold_code adds PERSONAL_MAILBOX, FORWARDING_CONFIRMATION; parser_kind adds
--                                        leadmetadata (R-LEM-10..12)
--   (f) lead_inquiries index             (tenant_id, lead_source_id, received_at DESC) for the overview
--   (g) lead_sources.active_changed_at   when a source was last turned off or on (R-LSRC-2)
--   (h) webhook_events.last_attempt_at + app.rearm_webhook_event   SECURITY REVIEW ITEM: a failed or crashed delivery is
--                                        processed again when the provider retries (R-LSRC-7)
-- Design decision (ARCHITECTURE §21): a Google lead form is NOT an integration_connections kind. It has no external
-- account and no OAuth, and only the system writes it; a new kind would widen 0018's live-account CHECK and the guard's
-- exemption list. The integrations page's ads_google (module 52's OAuth account) stays separate.

-- -----------------------------------------------------------------------------
-- (a) Tracking numbers credited to a source
-- -----------------------------------------------------------------------------
ALTER TABLE phone_numbers ADD COLUMN lead_source_id uuid;
ALTER TABLE phone_numbers ADD CONSTRAINT phone_numbers_lead_source_fk
  FOREIGN KEY (tenant_id, lead_source_id) REFERENCES lead_sources (tenant_id, id);
ALTER TABLE phone_numbers ADD CONSTRAINT phone_numbers_lead_source_tracking
  CHECK (lead_source_id IS NULL OR purpose = 'tracking');
CREATE INDEX phone_numbers_lead_source_idx ON phone_numbers (tenant_id, lead_source_id)
  WHERE lead_source_id IS NOT NULL AND released_at IS NULL;

-- -----------------------------------------------------------------------------
-- (g) When a source was turned off / on
-- -----------------------------------------------------------------------------
ALTER TABLE lead_sources ADD COLUMN active_changed_at timestamptz;

-- -----------------------------------------------------------------------------
-- (b) Google Ads lead form hooks
-- -----------------------------------------------------------------------------
CREATE TABLE google_lead_form_hooks (
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  id                      uuid NOT NULL,
  lead_source_id          uuid NOT NULL,
  key_hash                bytea NOT NULL CHECK (octet_length(key_hash) = 32),   -- sha256(key): the only routing input
  key_enc                 bytea NOT NULL,                                       -- envelope-encrypted key (shown to Owner/Admin)
  inquiry_type            text NOT NULL DEFAULT 'general' CHECK (inquiry_type IN ('buy','sell','rent','value','general')),
  cites_source_disclosure boolean NOT NULL DEFAULT false,
  created_by_user_id      uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  retired_at              timestamptz,                                          -- turned off or rotated; final
  last_test_at            timestamptz,
  last_unreadable_at      timestamptz,
  unreadable_count        integer NOT NULL DEFAULT 0 CHECK (unreadable_count >= 0),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_source_id)     REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id)
);
-- a key routes in at most one tenant, ever (retired keys keep their hash so they can never be re-issued)
CREATE UNIQUE INDEX google_lead_form_hooks_hash ON google_lead_form_hooks (key_hash);
-- one current hook per source
CREATE UNIQUE INDEX google_lead_form_hooks_current ON google_lead_form_hooks (tenant_id, lead_source_id) WHERE retired_at IS NULL;
CREATE TRIGGER google_lead_form_hooks_touch_updated_at BEFORE UPDATE ON google_lead_form_hooks
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Identity, key_hash and key_enc never change; a hook starts current; retirement is final and a retired row takes no
-- further writes.
CREATE FUNCTION app.google_lead_form_hooks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'GOOGLE_LEAD_FORM_NEW_RETIRED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'GOOGLE_LEAD_FORM_RETIRED: a retired hook takes no further writes' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.lead_source_id, NEW.key_hash, NEW.key_enc, NEW.created_by_user_id, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.lead_source_id, OLD.key_hash, OLD.key_enc, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'GOOGLE_LEAD_FORM_IMMUTABLE: a hook''s identity and key never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER google_lead_form_hooks_guard BEFORE INSERT OR UPDATE ON google_lead_form_hooks
  FOR EACH ROW EXECUTE FUNCTION app.google_lead_form_hooks_guard();
CREATE TRIGGER google_lead_form_hooks_no_delete BEFORE DELETE ON google_lead_form_hooks
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- -----------------------------------------------------------------------------
-- (c) A source's own webhook signing secret
-- -----------------------------------------------------------------------------
CREATE TABLE lead_source_webhook_secrets (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  lead_source_id     uuid NOT NULL,
  secret_enc         bytea NOT NULL,                     -- envelope-encrypted 32-byte secret (shown once, at rotation)
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, lead_source_id),
  FOREIGN KEY (tenant_id, lead_source_id)     REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id)
);
-- rotation replaces the secret in place; the row's identity never moves
CREATE FUNCTION app.lead_source_webhook_secrets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF (NEW.tenant_id, NEW.lead_source_id) IS DISTINCT FROM (OLD.tenant_id, OLD.lead_source_id) THEN
    RAISE EXCEPTION 'LEAD_SOURCE_SECRET_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_source_webhook_secrets_guard BEFORE UPDATE ON lead_source_webhook_secrets
  FOR EACH ROW EXECUTE FUNCTION app.lead_source_webhook_secrets_guard();
CREATE TRIGGER lead_source_webhook_secrets_no_delete BEFORE DELETE ON lead_source_webhook_secrets
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- -----------------------------------------------------------------------------
-- RLS (Layer 1 as 0040) and grants
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['google_lead_form_hooks','lead_source_webhook_secrets'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', t);
  END LOOP;
END $$;

-- Hooks: Owner/Admin and the system read (support never: a key is a secret); only the system writes (the API re-reads
-- the role as the system), mirroring lead_email_keys_read.
CREATE POLICY google_lead_form_hooks_read ON google_lead_form_hooks FOR SELECT
  USING ((SELECT app.is_tenant_wide()) AND (SELECT app.actor_kind()) <> 'support');
CREATE POLICY google_lead_form_hooks_insert ON google_lead_form_hooks FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY google_lead_form_hooks_update ON google_lead_form_hooks FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'system') WITH CHECK ((SELECT app.actor_kind()) = 'system');

-- Secrets: the system only (the webhook guard decrypts as the system actor of the token's tenant).
CREATE POLICY lead_source_webhook_secrets_read ON lead_source_webhook_secrets FOR SELECT USING ((SELECT app.actor_kind()) = 'system');
CREATE POLICY lead_source_webhook_secrets_insert ON lead_source_webhook_secrets FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY lead_source_webhook_secrets_update ON lead_source_webhook_secrets FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'system') WITH CHECK ((SELECT app.actor_kind()) = 'system');

GRANT SELECT, INSERT, UPDATE ON google_lead_form_hooks, lead_source_webhook_secrets TO app_user;
GRANT SELECT ON google_lead_form_hooks, lead_source_webhook_secrets TO app_definer;
GRANT SELECT ON google_lead_form_hooks, lead_source_webhook_secrets TO app_retention;

-- -----------------------------------------------------------------------------
-- (d) The Google key resolver (SECURITY REVIEW ITEM)
-- -----------------------------------------------------------------------------
-- Pre-tenant (the webhook guard calls it before any tenant context exists). Input: sha256 of the google_key the body
-- carried. Output: at most one (tenant_id, hook_id, lead_source_id): the CURRENT (unretired) hook of an ACTIVE source in
-- an ACTIVE tenant. A retired key, an off source or an inactive tenant resolve to nothing (the guard answers the same
-- 403). Owned by app_definer (BYPASSRLS), pinned search_path, STABLE, no write, minimal columns, 32-byte input only.
CREATE FUNCTION app.resolve_google_lead_form(p_key_hash bytea)
RETURNS TABLE (tenant_id uuid, hook_id uuid, lead_source_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT h.tenant_id, h.id, h.lead_source_id
    FROM public.google_lead_form_hooks h
    JOIN public.lead_sources s ON s.tenant_id = h.tenant_id AND s.id = h.lead_source_id AND s.active
    JOIN public.tenants t ON t.id = h.tenant_id AND t.status = 'active'
   WHERE octet_length(p_key_hash) = 32
     AND h.key_hash = p_key_hash
     AND h.retired_at IS NULL
$$;
ALTER FUNCTION app.resolve_google_lead_form(bytea) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.resolve_google_lead_form(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_google_lead_form(bytea) TO app_user;

-- -----------------------------------------------------------------------------
-- (e) Lead email holds and parsers
-- -----------------------------------------------------------------------------
ALTER TABLE lead_email_messages DROP CONSTRAINT lead_email_messages_hold_code_check;
ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_hold_code_check CHECK (hold_code IN ('DKIM_MISSING','DKIM_FAILED',
  'DKIM_UNALIGNED','SENDER_NOT_ALLOWED','FROM_INVALID','UNKNOWN_FORMAT','PARTIAL_FORMAT','NO_CONTACT_POINT',
  'PERSONAL_MAILBOX','FORWARDING_CONFIRMATION'));
ALTER TABLE lead_email_messages DROP CONSTRAINT lead_email_messages_parser_kind_check;
ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_parser_kind_check
  CHECK (parser_kind IN ('zillow','realtor','generic','leadmetadata'));

-- -----------------------------------------------------------------------------
-- (f) The overview's per-source facts (last lead, leads in 30 days)
-- -----------------------------------------------------------------------------
CREATE INDEX lead_inquiries_source_received_idx ON lead_inquiries (tenant_id, lead_source_id, received_at DESC);

-- -----------------------------------------------------------------------------
-- (h) No lead lost to a transient fault (SECURITY REVIEW ITEM)
-- -----------------------------------------------------------------------------
ALTER TABLE webhook_events ADD COLUMN last_attempt_at timestamptz;   -- NULL: received_at

-- A provider retried a delivery that is already recorded. Re-arm it for one more run when, and only when, the first run
-- failed ('failed') or crashed without finishing ('received' and its last attempt is older than the stale window). A
-- processed, unrouted or rejected row never re-arms, nor does a row without a valid signature or a tenant. One
-- conditional UPDATE: two concurrent retries serialize on the row and the second sees a fresh last_attempt_at, so the
-- row re-arms once. Returns the row id to run, or NULL. Owner app_definer (webhook_events is definer-only), pinned
-- search_path, VOLATILE, EXECUTE for app_user only. The stale window (5 minutes) must exceed the slowest run() handler
-- (VERIFY 15).
CREATE FUNCTION app.rearm_webhook_event(p_provider text, p_provider_event_id text, p_now timestamptz)
RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.webhook_events
     SET status = 'received', error_code = NULL, processed_at = NULL, last_attempt_at = p_now
   WHERE provider = p_provider AND provider_event_id = p_provider_event_id
     AND signature_valid AND tenant_id IS NOT NULL
     AND (status = 'failed'
          OR (status = 'received' AND COALESCE(last_attempt_at, received_at) < p_now - interval '5 minutes'))
  RETURNING id
$$;
ALTER FUNCTION app.rearm_webhook_event(text, text, timestamptz) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.rearm_webhook_event(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rearm_webhook_event(text, text, timestamptz) TO app_user;
GRANT UPDATE ON webhook_events TO app_definer;

-- -----------------------------------------------------------------------------
-- (i) Leads skipped while their source was off (R-LSRC-2, E387; orchestrator 2026-11-12)
-- -----------------------------------------------------------------------------
-- A partner-feed lead that arrives while its lead source is off is skipped (the feed cursor advances, so turning the
-- source back on does not replay it), and one receipt per lead says so: which source, which path, when, and why.
-- Nothing of the lead is kept (only sha256 of the feed's own lead id, for idempotency), so a receipt is not a person.
CREATE TABLE lead_source_skips (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  lead_source_id     uuid NOT NULL,
  channel            text NOT NULL CHECK (channel IN ('partner_feed')),
  external_ref_sha256 bytea NOT NULL CHECK (octet_length(external_ref_sha256) = 32),
  reason             text NOT NULL CHECK (reason IN ('SOURCE_OFF')),
  skipped_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, lead_source_id, channel, external_ref_sha256),
  FOREIGN KEY (tenant_id, lead_source_id) REFERENCES lead_sources (tenant_id, id)
);
CREATE INDEX lead_source_skips_recent_idx ON lead_source_skips (tenant_id, lead_source_id, skipped_at DESC);
CREATE TRIGGER lead_source_skips_append_only BEFORE UPDATE OR DELETE ON lead_source_skips
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
ALTER TABLE lead_source_skips ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_source_skips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_source_skips AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON lead_source_skips AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON lead_source_skips AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON lead_source_skips AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON lead_source_skips
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
-- read: Owner/Admin and the system (the Lead sources page; support read-only); write: the system only (the feed poll)
CREATE POLICY lead_source_skips_read ON lead_source_skips FOR SELECT USING ((SELECT app.is_tenant_wide()));
CREATE POLICY lead_source_skips_insert ON lead_source_skips FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
GRANT SELECT, INSERT ON lead_source_skips TO app_user;
GRANT SELECT ON lead_source_skips TO app_definer, app_retention;
