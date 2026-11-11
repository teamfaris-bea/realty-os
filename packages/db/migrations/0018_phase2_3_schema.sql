-- =============================================================================
-- 0015: Phase 2 and Phase 3 schema (design-first, like 0001). docs/PHASE2_3_PLAN.md module 18 (db/p23-schema).
--
-- Written before any Phase 2/3 feature module, from docs/DATA_MODEL.md "Phase 2-3" (§6-§10), and revised
-- after the round-2 adversarial review (docs/ARCHITECTURE.md §20, "Phase 2-3 design review, round 2").
-- Feature modules add only indexes, views and the definer entry points their own section names, in later
-- files. 0001-0014 are not edited.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * replaces app.messages_dispatch_guard / app.calls_dispatch_guard (SECURITY DEFINER, app_definer, pinned
--     search_path). Each change only refuses MORE sends: explicit channel map with CHANNEL_UNKNOWN (no ELSE
--     'sms' fallthrough), DM channels, PERSON_DO_NOT_CONTACT (also when a do-not-contact duplicate was merged
--     into the recipient), PLATFORM_NOT_CLEARED for Meta DMs, open-house invites only from an approved version.
--   * replaces app.purge_contact_internal and app.retention_sweep (SECURITY DEFINER, app_retention): erasure
--     refuses while a contact document is on legal hold or inside its retention period, purge skips such
--     contacts, and erasure shreds the contact's document objects. Everything else is verbatim from 0001.
--   * a second principal: app.principal_type() = 'client' (Phase 3 client portal). Every table that existed
--     before 0015, and every new staff table, keeps the staff-only Layer 1. Exactly three new tables
--     (portal_accounts, portal_grants, portal_items) admit a client principal, read-only, and only rows tied
--     to the client's own unrevoked, unexpired grants on a deal or listing the client is a party to.
--   * new SECURITY DEFINER functions, each owned by app_definer with a pinned search_path:
--       app.ad_allocation_cap_check()     deferred constraint trigger: approved, single-use, under the cap in force
--       app.contacts_dnc_follow_merge()   copies a person-level do-not-contact to the merge survivor
--       app.portal_party_ok(...)          boolean: is the portal account's contact a party to the deal/listing
--   No pre-tenant entry point is added here: public pages, web chat, Meta webhooks and portal sessions add
--   theirs in their own module migrations (0016-0021), each a review item.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The client principal (R-PORTAL-1, R-TEN-14). Fail closed: NULL unless principal_type = 'client'.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.portal_account_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT CASE WHEN app.principal_type() = 'client'
               THEN NULLIF(current_setting('app.portal_account_id', true), '')::uuid END $$;
GRANT EXECUTE ON FUNCTION app.portal_account_id() TO app_user, app_definer, app_retention;

-- -----------------------------------------------------------------------------
-- 1a. Platform clearance packs (R-INT-6). A capability that waits on counsel review, or on a vendor check,
--     is gated on a published platform pack (jurisdiction_packs key 'platform:<name>') whose
--     reviewed_by_counsel_at is set and, where a vendor check is required, whose rules carry vendor_ready_at.
--     Packs are platform data: app_user reads them and never writes them. They ship unreviewed.
-- -----------------------------------------------------------------------------
ALTER TABLE jurisdiction_packs DROP CONSTRAINT jurisdiction_packs_key_check;
ALTER TABLE jurisdiction_packs ADD CONSTRAINT jurisdiction_packs_key_check
  CHECK (key ~ '^[A-Z]{2}(-[A-Z]{2})?$' OR key ~ '^platform:[a-z_]+$');

CREATE FUNCTION app.platform_cleared(p_key text, p_vendor_ready boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.jurisdiction_packs j
                  WHERE j.key = p_key AND j.status = 'published' AND j.reviewed_by_counsel_at IS NOT NULL
                    AND (NOT p_vendor_ready OR (j.rules->>'vendor_ready_at') IS NOT NULL))
$$;
GRANT EXECUTE ON FUNCTION app.platform_cleared(text, boolean) TO app_user, app_definer, app_retention;

INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:meta', '2026.11.0', 'published', '{"window_hours": 24}', NULL,
   'Messenger and Instagram sending (counsel items C1, C12; Meta policy). Engineering placeholder. VERIFY WITH COUNSEL.'),
  ('platform:voice', '2026.11.0', 'published', '{"max_turn_latency_ms": 1500}', NULL,
   'Voice answering (C2). vendor_ready_at is set once a real vendor passes the latency spike (N12). VERIFY WITH COUNSEL.'),
  ('platform:fair_housing', '2026.11.0', 'published', '{"lexicon_version": "fh/1"}', NULL,
   'Fair-housing lexicon and housing advertising rules (C3, C5); gates publishing marketing. VERIFY WITH COUNSEL.'),
  ('platform:avm', '2026.11.0', 'published', '{"max_age_days": 35}', NULL,
   'Home-value wording and display (C6, N8). Engineering placeholder. VERIFY WITH COUNSEL.'),
  ('platform:review_requests', '2026.11.0', 'published', '{}', NULL,
   'Review requests (C8). Engineering placeholder. VERIFY WITH COUNSEL.'),
  ('platform:coaching', '2026.11.0', 'published', '{}', NULL,
   'Call reviews (C11); gates turning call scoring on. Engineering placeholder. VERIFY WITH COUNSEL.'),
  ('platform:portal', '2026.11.0', 'published', '{}', NULL,
   'Client portal (C10); gates portal sign-in (module 43). Engineering placeholder. VERIFY WITH COUNSEL.');

-- -----------------------------------------------------------------------------
-- 2. Integrations: one honest-status row per external connection (R-INT-1..6)
-- -----------------------------------------------------------------------------
-- Credentials for the new external services live where every credential lives (Owner/Admin/system only).
ALTER TABLE provider_credentials DROP CONSTRAINT provider_credentials_provider_check;
ALTER TABLE provider_credentials ADD CONSTRAINT provider_credentials_provider_check CHECK (provider IN ('telephony','email',
  'fub','mls','avm','dnc','meta','google','zillow','realtor','showing_service'));

-- Platform-procured vendors (AVM, public records, voice stack, malware scanner, text extractor) are platform
-- configuration, not tenant connections: their availability is what the adapter reports plus the platform packs.
CREATE TABLE integration_connections (
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  id                     uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('messenger_page','instagram_account','web_chat_widget','lead_email',
                           'zillow_feed','realtor_feed','meta_lead_ads','mls_feed','showing_service','ads_meta','ads_google',
                           'gbp_location')),
  status                 text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured','needs_partner_access',
                           'pending_review','connected','degraded','revoked','disconnected')),
  status_reason          text CHECK (status_reason ~ '^[A-Z][A-Z0-9_]*$'),
  display_name           text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  external_account_id    text,                    -- Page id, IG account id, MLS feed id, ad account, GBP location
  credential_id          uuid,                    -- secrets stay in provider_credentials (Owner/Admin/system only)
  lead_source_id         uuid,                    -- attribution for contacts this connection creates
  capabilities           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(capabilities) = 'object'),   -- what the adapter REPORTS
  license_pack           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(license_pack) = 'object'),   -- MLS/IDX display rules (VERIFY)
  allowed_origins        text[] NOT NULL DEFAULT '{}',                                                -- web_chat_widget only
  allowed_sender_domains text[] NOT NULL DEFAULT '{}',          -- lead_email only: DKIM-aligned sender domains (R-INBOX-9)
  widget_key_hash        bytea CHECK (widget_key_hash IS NULL OR octet_length(widget_key_hash) = 32),
  sync_cursor            text,
  last_synced_at         timestamptz,
  next_sync_at           timestamptz,              -- stored instant (R-OWN-27)
  last_error_code        text CHECK (last_error_code ~ '^[A-Z][A-Z0-9_]*$'),
  connected_by_user_id   uuid,
  connected_at           timestamptz,
  disconnected_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, credential_id)        REFERENCES provider_credentials (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_source_id)       REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, connected_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK (status NOT IN ('connected','degraded') OR connected_at IS NOT NULL),
  CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL)),
  CHECK (kind = 'web_chat_widget' OR (widget_key_hash IS NULL AND cardinality(allowed_origins) = 0)),
  CHECK (kind = 'lead_email' OR cardinality(allowed_sender_domains) = 0),
  -- an external account is live only with the account id and the credential the provider callback stored
  CHECK (kind IN ('web_chat_widget','lead_email') OR status NOT IN ('pending_review','connected','degraded')
         OR (external_account_id IS NOT NULL AND credential_id IS NOT NULL)),
  CHECK (kind NOT IN ('messenger_page','instagram_account','web_chat_widget','lead_email','zillow_feed','realtor_feed','meta_lead_ads')
         OR status NOT IN ('connected','degraded') OR lead_source_id IS NOT NULL)
);
-- An external account is live in at most ONE tenant (cross-tenant index, like phone_numbers). Webhooks route
-- only to connected/degraded rows (app.resolve_channel_account, 0016); pending_review reserves the account.
CREATE UNIQUE INDEX integration_connections_live_account ON integration_connections (kind, external_account_id)
  WHERE external_account_id IS NOT NULL AND status IN ('pending_review','connected','degraded');
CREATE UNIQUE INDEX integration_connections_widget_key ON integration_connections (widget_key_hash) WHERE widget_key_hash IS NOT NULL;
CREATE INDEX integration_connections_sync_idx ON integration_connections (tenant_id, next_sync_at)
  WHERE status IN ('connected','degraded') AND next_sync_at IS NOT NULL;
CREATE TRIGGER integration_connections_touch_updated_at BEFORE UPDATE ON integration_connections
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The routing key (kind, external_account_id) and the honest status are written only by the system actor,
-- i.e. the provider callback after the adapter proved that the token manages that account (R-INT-3, R-TEN-11).
-- Owner/Admin create unconfigured rows, edit names, sources, origins, sender domains and licence packs, and
-- disconnect. A different external account is a new row. Web-chat widgets and lead inboxes have no external
-- account: their routing keys are unguessable and server-generated, so Owner/Admin may switch them on.
CREATE FUNCTION app.integration_connections_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sys boolean := COALESCE(app.actor_kind() = 'system', false) OR current_user IN ('app_definer','app_retention');
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' THEN
    IF NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'CONNECTION_KIND_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.external_account_id IS NOT NULL AND NEW.external_account_id IS DISTINCT FROM OLD.external_account_id THEN
      RAISE EXCEPTION 'CONNECTION_ACCOUNT_IMMUTABLE: a different external account is a new connection' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT sys THEN
    IF (TG_OP = 'INSERT' AND (NEW.external_account_id IS NOT NULL OR NEW.credential_id IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND (NEW.external_account_id, NEW.credential_id) IS DISTINCT FROM (OLD.external_account_id, OLD.credential_id))
       OR (NEW.kind NOT IN ('web_chat_widget','lead_email') AND NEW.status IN ('pending_review','connected','degraded')
           AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)) THEN
      RAISE EXCEPTION 'CONNECTION_PROOF_REQUIRED: only the provider callback, after proving control of the account, links or connects it'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (TG_OP = 'INSERT' AND NEW.capabilities <> '{}'::jsonb)
       OR (TG_OP = 'UPDATE' AND NEW.capabilities IS DISTINCT FROM OLD.capabilities) THEN
      RAISE EXCEPTION 'CONNECTION_CAPABILITIES_REPORTED: capabilities are what the adapter reports' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_connections_guard BEFORE INSERT OR UPDATE ON integration_connections
  FOR EACH ROW EXECUTE FUNCTION app.integration_connections_guard();

-- Per-user calendar OAuth link (self-only; Owner/Admin see nothing) (R-CAL-1..4). Tokens refresh lazily
-- inside calendar.push, so no renew instant is stored.
CREATE TABLE user_calendar_links (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  id                    uuid NOT NULL,
  user_id               uuid NOT NULL,
  provider              text NOT NULL CHECK (provider IN ('google_calendar','microsoft_calendar')),
  status                text NOT NULL CHECK (status IN ('pending_review','connected','degraded','revoked')),
  scopes                text[] NOT NULL DEFAULT '{}',
  access_enc            bytea,
  refresh_enc           bytea,
  key_version           integer,
  external_calendar_ref text,
  last_synced_at        timestamptz,
  last_error_code       text CHECK (last_error_code ~ '^[A-Z][A-Z0-9_]*$'),
  revoked_at            timestamptz,
  purge_after           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id, provider),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status <> 'connected' OR (access_enc IS NOT NULL AND key_version IS NOT NULL)),
  CHECK (revoked_at IS NULL OR purge_after IS NOT NULL)
);
CREATE TRIGGER user_calendar_links_touch_updated_at BEFORE UPDATE ON user_calendar_links
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One-way push (R-CAL-2): sync_version moves on every content change and fences calendar.push, so an older
-- push can never overwrite a newer one; external_pushed_version is the last version the calendar accepted.
ALTER TABLE appointments
  ADD COLUMN external_event_ref      text,
  ADD COLUMN external_etag           text,
  ADD COLUMN external_sync_status    text NOT NULL DEFAULT 'not_synced'
             CHECK (external_sync_status IN ('not_synced','synced','detached','failed')),
  ADD COLUMN external_detached_at    timestamptz,
  ADD COLUMN sync_version            integer NOT NULL DEFAULT 1 CHECK (sync_version >= 1),
  ADD COLUMN external_pushed_version integer CHECK (external_pushed_version >= 1),
  ADD CONSTRAINT appointments_external_detached CHECK ((external_sync_status = 'detached') = (external_detached_at IS NOT NULL)),
  ADD CONSTRAINT appointments_pushed_version CHECK (external_pushed_version IS NULL OR external_pushed_version <= sync_version);
CREATE FUNCTION app.appointments_sync_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- computed, never written by a caller: content changes bump it, sync bookkeeping does not
  IF (NEW.contact_id, NEW.deal_id, NEW.user_id, NEW.kind, NEW.starts_at, NEW.ends_at, NEW.location, NEW.status)
     IS DISTINCT FROM (OLD.contact_id, OLD.deal_id, OLD.user_id, OLD.kind, OLD.starts_at, OLD.ends_at, OLD.location, OLD.status) THEN
    NEW.sync_version := OLD.sync_version + 1;
  ELSE
    NEW.sync_version := OLD.sync_version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_sync_version BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION app.appointments_sync_version();

-- -----------------------------------------------------------------------------
-- 3. Channels: Messenger, Instagram, web chat are addresses like phones and emails (R-CHAN-1..3)
-- -----------------------------------------------------------------------------
ALTER TABLE contact_points DROP CONSTRAINT contact_points_kind_check;
ALTER TABLE contact_points ADD CONSTRAINT contact_points_kind_check
  CHECK (kind IN ('phone','email','messenger','instagram','web_chat'));
-- Page/account-scoped ids carry the external account id, so a reconnected Page keeps its HMACs (E134).
ALTER TABLE contact_points ADD CONSTRAINT contact_points_platform_address CHECK (
  (kind <> 'messenger' OR address ~ '^fb:[0-9]{1,32}:[0-9]{1,32}$')
  AND (kind <> 'instagram' OR address ~ '^ig:[0-9]{1,32}:[0-9]{1,32}$')
  AND (kind <> 'web_chat' OR address ~ '^wc:[0-9a-f]{32}$'));
ALTER TABLE contact_points
  ADD COLUMN platform_window_until timestamptz,   -- last inbound on this identity + platform pack window (stored, R-INBOX-6)
  ADD CONSTRAINT contact_points_window_platform_only CHECK (platform_window_until IS NULL OR kind IN ('messenger','instagram','web_chat')),
  -- lets a row name "a point of THIS contact" with a composite FK (the portal login point, R-PORTAL-5)
  ADD CONSTRAINT contact_points_contact_point_uq UNIQUE (tenant_id, contact_id, id);

ALTER TABLE consent_events DROP CONSTRAINT consent_events_address_kind_check;
ALTER TABLE consent_events DROP CONSTRAINT consent_events_channel_check;
ALTER TABLE consent_events DROP CONSTRAINT consent_events_check14;
ALTER TABLE consent_events
  ADD CONSTRAINT consent_events_address_kind_check CHECK (address_kind IN ('phone','email','messenger','instagram','web_chat')),
  ADD CONSTRAINT consent_events_channel_check CHECK (channel IN ('sms','voice','email','messenger','instagram','web_chat')),
  ADD CONSTRAINT consent_events_platform_kind CHECK (
    (address_kind NOT IN ('messenger','instagram','web_chat') OR channel = address_kind)
    AND (channel NOT IN ('messenger','instagram','web_chat') OR address_kind = channel)),
  ADD CONSTRAINT consent_events_resubscribe_keyword CHECK (
    event_type <> 'resubscribe' OR (channel IN ('sms','messenger','instagram') AND source = 'inbound_keyword'));

ALTER TABLE consent_state DROP CONSTRAINT consent_state_channel_check;
ALTER TABLE consent_state ADD CONSTRAINT consent_state_channel_check
  CHECK (channel IN ('sms','voice','email','messenger','instagram','web_chat'));

ALTER TABLE suppressions DROP CONSTRAINT suppressions_address_kind_check;
ALTER TABLE suppressions DROP CONSTRAINT suppressions_channel_check;
ALTER TABLE suppressions DROP CONSTRAINT suppressions_reason_check;
ALTER TABLE suppressions
  ADD CONSTRAINT suppressions_address_kind_check CHECK (address_kind IN ('phone','email','messenger','instagram','web_chat')),
  ADD CONSTRAINT suppressions_channel_check CHECK (channel IN ('sms','voice','email','messenger','instagram','web_chat','all')),
  ADD CONSTRAINT suppressions_reason_check CHECK (reason IN ('hard_bounce','spam_complaint','undeliverable','landline_no_sms',
    'internal_dnc','admin_block','wrong_number','provider_opt_out','import_dnc','platform_blocked'));

ALTER TABLE lead_sources DROP CONSTRAINT lead_sources_kind_check;
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_kind_check CHECK (kind IN ('portal','website','referral','sphere',
  'open_house','ads','sign_call','inbound_sms','inbound_call','manual','import','other','social_dm','web_chat'));

-- Parsed lead emails cite the span each field came from; nothing is guessed (R-INBOX-9).
ALTER TABLE lead_inquiries
  ADD COLUMN parse_status   text NOT NULL DEFAULT 'structured' CHECK (parse_status IN ('structured','parsed','needs_review')),
  ADD COLUMN parse_evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(parse_evidence) = 'object');

-- Person-level opt-out ("do not contact me" on any channel, agent-recorded do-not-contact): blocks every
-- channel of this contact, including points added later, for every initiator, in core and in both guards.
-- Setting it is open to any writer of the contact (it only refuses more); clearing it is possible only
-- inside a reviewed definer that records the person's own reinstating action (none exists yet: fail closed).
ALTER TABLE contacts
  ADD COLUMN do_not_contact_at       timestamptz,
  ADD COLUMN do_not_contact_event_id uuid,
  ADD CONSTRAINT contacts_dnc_pair CHECK ((do_not_contact_at IS NULL) = (do_not_contact_event_id IS NULL)),
  ADD CONSTRAINT contacts_dnc_event_fk FOREIGN KEY (tenant_id, do_not_contact_event_id) REFERENCES consent_events (tenant_id, id);
CREATE INDEX contacts_merged_into_idx ON contacts (tenant_id, merged_into_contact_id) WHERE merged_into_contact_id IS NOT NULL;

CREATE FUNCTION app.contacts_person_opt_out_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev uuid;
BEGIN
  -- NOT security definer: current_user is the caller, so only a reviewed app_definer function can clear.
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' THEN
    prev := OLD.do_not_contact_event_id;
    IF OLD.do_not_contact_at IS NOT NULL AND NEW.do_not_contact_at IS NULL
       AND current_user NOT IN ('app_definer','app_retention') THEN
      RAISE EXCEPTION 'PERSON_OPT_OUT_FINAL: only the person''s own action can lift a do-not-contact'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.do_not_contact_event_id IS NOT NULL AND NEW.do_not_contact_event_id IS DISTINCT FROM prev
     AND NOT EXISTS (SELECT 1 FROM public.consent_events e
                      WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.do_not_contact_event_id
                        AND e.event_type = 'revoke') THEN
    RAISE EXCEPTION 'PERSON_OPT_OUT_EVIDENCE: a do-not-contact must cite a revoke in the consent ledger'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_person_opt_out_guard BEFORE INSERT OR UPDATE OF do_not_contact_at, do_not_contact_event_id ON contacts
  FOR EACH ROW EXECUTE FUNCTION app.contacts_person_opt_out_guard();

-- A merge never loses a person-level do-not-contact (E140): when a contact that carries one is merged (or a
-- merged contact gets one), the survivor takes the earliest do_not_contact_at and its ledger event, along
-- merge chains. Definer: a Team Lead's merge may not be able to update the survivor under RLS.
CREATE FUNCTION app.contacts_dnc_follow_merge() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.merged_into_contact_id IS NULL OR NEW.do_not_contact_at IS NULL THEN RETURN NULL; END IF;
  UPDATE public.contacts s SET do_not_contact_at = NEW.do_not_contact_at, do_not_contact_event_id = NEW.do_not_contact_event_id
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.merged_into_contact_id
     AND (s.do_not_contact_at IS NULL OR s.do_not_contact_at > NEW.do_not_contact_at);
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_dnc_follow_merge() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contacts_dnc_follow_merge() FROM PUBLIC;
CREATE TRIGGER contacts_dnc_follow_merge AFTER UPDATE OF merged_into_contact_id, do_not_contact_at, do_not_contact_event_id ON contacts
  FOR EACH ROW EXECUTE FUNCTION app.contacts_dnc_follow_merge();

-- Web-chat sessions: system-only until a real first message links a contact (R-INBOX-5). Visitors are not
-- principals; their reads go through the definer module 22 adds (app.webchat_poll). The phone or email a
-- visitor types is an unverified claim stored here, never a contact point the system writes: nothing is sent
-- to it automatically, and the session is never attached to an existing contact because of it (R-INBOX-1).
CREATE TABLE webchat_sessions (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL,
  connection_id    uuid NOT NULL,
  token_hash       bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  origin           text NOT NULL,
  ip_hash          bytea CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32),
  started_at       timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  closed_at        timestamptz,
  contact_id       uuid,
  contact_point_id uuid,
  claimed_kind     text CHECK (claimed_kind IN ('phone','email')),
  claimed_address  text CHECK (length(claimed_address) BETWEEN 3 AND 320),
  purge_after      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id)    REFERENCES integration_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)       REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,          -- erasure removes the session
  FOREIGN KEY (tenant_id, contact_point_id) REFERENCES contact_points (tenant_id, id) ON DELETE CASCADE,
  CHECK (last_seen_at >= started_at),
  CHECK (contact_id IS NOT NULL OR purge_after IS NOT NULL),
  CHECK ((claimed_kind IS NULL) = (claimed_address IS NULL))
);

-- Messages on the new channels: same table, same conversation per person (R-INBOX-1).
ALTER TABLE messages DROP CONSTRAINT messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('sms','mms','email','messenger','instagram','web_chat'));
ALTER TABLE messages DROP CONSTRAINT messages_check12;      -- "non-email outbound ⇒ phone number" (would force DMs onto a phone number)
ALTER TABLE messages
  ADD COLUMN integration_connection_id uuid,
  ADD COLUMN marketing_piece_id        uuid,
  ADD CONSTRAINT messages_sms_sender CHECK (channel NOT IN ('sms','mms') OR direction = 'inbound' OR imported OR phone_number_id IS NOT NULL),
  ADD CONSTRAINT messages_platform_sender CHECK (channel NOT IN ('messenger','instagram','web_chat') OR direction = 'inbound'
                                                 OR imported OR integration_connection_id IS NOT NULL),
  ADD CONSTRAINT messages_connection_fk FOREIGN KEY (tenant_id, integration_connection_id) REFERENCES integration_connections (tenant_id, id);

-- The opt-out guard, now with an explicit channel map. Unknown channel ⇒ CHANNEL_UNKNOWN (fails closed;
-- 0014 fell through to 'sms'). Person-level do-not-contact ⇒ PERSON_DO_NOT_CONTACT, also when a duplicate
-- that carries one was merged into the recipient. Meta DMs wait for counsel review (PLATFORM_NOT_CLEARED,
-- operational, not consent: D1 stands). An invite needs an approved invite version. Everything else verbatim.
CREATE OR REPLACE FUNCTION app.messages_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE a record; paused timestamptz; ch text; pk text; own bytea[]; others bytea[]; exempt boolean;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN RETURN NEW; END IF;
  IF NEW.direction <> 'outbound' OR NEW.imported
     OR NEW.status NOT IN ('dispatching','sent','delivered','failed','undelivered','bounced','dispatch_unknown')
     OR (TG_OP = 'UPDATE' AND OLD.status NOT IN ('scheduled','queued')) THEN
    RETURN NEW;
  END IF;

  -- channel → (consent channel, contact point kind); R-GATE-13: the map, core's Channel union and the gate
  -- table test change together.
  CASE NEW.channel
    WHEN 'sms'       THEN ch := 'sms';       pk := 'phone';
    WHEN 'mms'       THEN ch := 'sms';       pk := 'phone';
    WHEN 'email'     THEN ch := 'email';     pk := 'email';
    WHEN 'messenger' THEN ch := 'messenger'; pk := 'messenger';
    WHEN 'instagram' THEN ch := 'instagram'; pk := 'instagram';
    WHEN 'web_chat'  THEN ch := 'web_chat';  pk := 'web_chat';
    ELSE RAISE EXCEPTION 'CHANNEL_UNKNOWN: no opt-out mapping for channel %', NEW.channel USING ERRCODE = 'check_violation';
  END CASE;

  IF NOT EXISTS (SELECT 1 FROM public.contact_points p
                  WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id
                    AND p.kind = pk AND p.address = NEW.to_address) THEN
    RAISE EXCEPTION 'RECIPIENT_NOT_A_CONTACT_POINT: the recipient''s opt-out status cannot be checked' USING ERRCODE = 'check_violation';
  END IF;
  IF ch IN ('messenger','instagram') AND NOT app.platform_cleared('platform:meta') THEN
    RAISE EXCEPTION 'PLATFORM_NOT_CLEARED: Messenger and Instagram sending is off until counsel reviews the platform:meta pack'
      USING ERRCODE = 'check_violation';
  END IF;
  own := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                WHERE p.tenant_id = NEW.tenant_id AND p.kind = pk AND p.address = NEW.to_address);
  -- an SMS or DM keyword revoke on any of the contact's points of that kind blocks all of them
  others := CASE WHEN ch IN ('sms','messenger','instagram','web_chat')
                 THEN ARRAY(SELECT p.address_hmac FROM public.contact_points p
                             WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id
                               AND p.kind = pk AND p.removed_at IS NULL)
                 ELSE '{}'::bytea[] END;
  exempt := NEW.initiator = 'system' AND NEW.action_category IN ('opt_out_confirmation','help_reply')
            AND NEW.purpose = 'informational' AND ch IN ('sms','messenger','instagram')
            AND EXISTS (SELECT 1 FROM public.messages im
                         WHERE im.tenant_id = NEW.tenant_id AND im.conversation_id = NEW.conversation_id
                           AND im.direction = 'inbound' AND im.channel = NEW.channel AND im.opt_out_keyword IS NOT NULL
                           AND im.from_address = NEW.to_address
                           AND im.created_at >= now() - interval '24 hours');

  IF NOT exempt AND EXISTS (SELECT 1 FROM public.contacts c
                             WHERE c.tenant_id = NEW.tenant_id AND c.do_not_contact_at IS NOT NULL
                               AND (c.id = NEW.contact_id OR c.merged_into_contact_id = NEW.contact_id)) THEN
    RAISE EXCEPTION 'PERSON_DO_NOT_CONTACT: this person asked not to be contacted; nobody can send to them' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT exempt AND EXISTS (SELECT 1 FROM public.consent_state cs
                             WHERE cs.tenant_id = NEW.tenant_id AND cs.channel = ch AND cs.purpose = NEW.purpose
                               AND cs.status = 'revoked' AND cs.address_hmac = ANY (own || others)) THEN
    RAISE EXCEPTION 'RECIPIENT_OPTED_OUT: this address opted out; nobody can send to it' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppressions s
              WHERE s.tenant_id = NEW.tenant_id AND s.address_hmac = ANY (own) AND s.lifted_at IS NULL
                AND s.channel IN ('all', ch)) THEN
    RAISE EXCEPTION 'RECIPIENT_SUPPRESSED: this address is suppressed for %', ch USING ERRCODE = 'check_violation';
  END IF;

  -- an open-house invite goes out only from an approved (or published) invite version (R-MKT-1, R-MKT-8)
  IF NEW.marketing_piece_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.marketing_pieces mp
        WHERE mp.tenant_id = NEW.tenant_id AND mp.id = NEW.marketing_piece_id
          AND mp.kind = 'open_house_invite' AND mp.status IN ('approved','published')) THEN
    RAISE EXCEPTION 'MARKETING_PIECE_NOT_APPROVED: an invite is sent only from an approved open-house invite version'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Assistant autonomy (R-GATE-4, A3/A7), unchanged from 0013/0014.
  IF NEW.initiator = 'assistant' THEN
    SELECT aa.autonomy, aa.status, aa.decided_by_user_id, aa.playbook_version_id INTO a
      FROM public.assistant_actions aa WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.assistant_action_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSISTANT_ACTION_MISSING' USING ERRCODE = 'check_violation';
    ELSIF a.autonomy = 'within_playbook' THEN
      IF NOT EXISTS (SELECT 1 FROM public.playbook_versions v
                      WHERE v.tenant_id = NEW.tenant_id AND v.id = a.playbook_version_id AND v.status = 'approved') THEN
        RAISE EXCEPTION 'PLAYBOOK_NOT_APPROVED' USING ERRCODE = 'check_violation';
      END IF;
      SELECT c.automation_paused_at INTO paused FROM public.conversations c
       WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.conversation_id;
      IF paused IS NOT NULL THEN
        RAISE EXCEPTION 'AUTOMATION_PAUSED: the client replied; hand back instead' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF a.autonomy = 'requires_approval' THEN
      IF a.status NOT IN ('approved','executed') OR a.decided_by_user_id IS NULL THEN
        RAISE EXCEPTION 'ASSISTANT_ACTION_NOT_APPROVED' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'ASSISTANT_ACTION_NOT_SENDABLE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.messages_dispatch_guard() OWNER TO app_definer;

CREATE OR REPLACE FUNCTION app.calls_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE own bytea[]; others bytea[];
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN RETURN NEW; END IF;
  IF NEW.direction <> 'outbound' OR NEW.imported THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contact_points p
                  WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id AND p.kind = 'phone'
                    AND p.address = NEW.client_address) THEN
    RAISE EXCEPTION 'RECIPIENT_NOT_A_CONTACT_POINT: the recipient''s opt-out status cannot be checked' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contacts c
              WHERE c.tenant_id = NEW.tenant_id AND c.do_not_contact_at IS NOT NULL
                AND (c.id = NEW.contact_id OR c.merged_into_contact_id = NEW.contact_id)) THEN
    RAISE EXCEPTION 'PERSON_DO_NOT_CONTACT: this person asked not to be contacted; nobody can call them' USING ERRCODE = 'check_violation';
  END IF;
  own := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                WHERE p.tenant_id = NEW.tenant_id AND p.kind = 'phone' AND p.address = NEW.client_address);
  others := ARRAY(SELECT p.address_hmac FROM public.contact_points p
                   WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id AND p.kind = 'phone' AND p.removed_at IS NULL);
  IF EXISTS (SELECT 1 FROM public.consent_state cs
              WHERE cs.tenant_id = NEW.tenant_id AND cs.channel = 'voice' AND cs.status = 'revoked'
                AND cs.address_hmac = ANY (own || others)) THEN
    RAISE EXCEPTION 'RECIPIENT_OPTED_OUT: this number asked not to be called; nobody can call it' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppressions s
              WHERE s.tenant_id = NEW.tenant_id AND s.address_hmac = ANY (own) AND s.lifted_at IS NULL
                AND s.channel IN ('all', 'voice')) THEN
    RAISE EXCEPTION 'RECIPIENT_SUPPRESSED: this number is suppressed for voice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.calls_dispatch_guard() OWNER TO app_definer;

-- -----------------------------------------------------------------------------
-- 4. MLS/IDX listings (R-MLS-1..5). New matches keep the Phase 1 saved-search alert path (one sender per
--    fact); price drops and back-on-market are trigger playbook firings keyed per listing_price_history row.
-- -----------------------------------------------------------------------------
ALTER TABLE listings
  ADD COLUMN mls_connection_id        uuid,
  ADD COLUMN mls_modified_at          timestamptz,
  ADD COLUMN listing_brokerage_name   text,
  ADD COLUMN display_allowed          boolean NOT NULL DEFAULT false,   -- IDX/internet display flag; never defaulted to allowed
  ADD COLUMN last_seen_in_feed_at     timestamptz,
  ADD COLUMN off_market_at            timestamptz,
  ADD COLUMN team_listing_id          uuid,                             -- an mls row mirroring one of our own listings
  ADD COLUMN seller_update_next_due_at timestamptz,                     -- stored instant (R-SELL-1, R-OWN-27)
  ADD CONSTRAINT listings_mls_connection_fk FOREIGN KEY (tenant_id, mls_connection_id) REFERENCES integration_connections (tenant_id, id),
  ADD CONSTRAINT listings_team_listing_fk FOREIGN KEY (tenant_id, team_listing_id) REFERENCES listings (tenant_id, id),
  ADD CONSTRAINT listings_mls_shape CHECK (source <> 'mls' OR (mls_connection_id IS NOT NULL AND mls_modified_at IS NOT NULL
                                                               AND listing_brokerage_name IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT listings_team_shape CHECK (source <> 'team' OR (mls_connection_id IS NULL AND team_listing_id IS NULL)),
  ADD CONSTRAINT listings_seller_update_team_only CHECK (seller_update_next_due_at IS NULL OR source = 'team');
CREATE INDEX listings_seller_update_due_idx ON listings (tenant_id, seller_update_next_due_at) WHERE seller_update_next_due_at IS NOT NULL;

CREATE FUNCTION app.listings_mls_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'mls' AND OLD.mls_modified_at IS NOT NULL
     AND (NEW.mls_modified_at IS NULL OR NEW.mls_modified_at < OLD.mls_modified_at) THEN
    RAISE EXCEPTION 'MLS_STALE_UPDATE: an older MLS modification cannot overwrite a newer one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listings_mls_monotonic BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION app.listings_mls_monotonic();

-- -----------------------------------------------------------------------------
-- 5. Playbooks: trigger playbooks (a step run without an enrollment) and voice answering (R-NURT-1, R-VOICE-1)
-- -----------------------------------------------------------------------------
ALTER TABLE playbooks DROP CONSTRAINT playbooks_kind_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_kind_check CHECK (kind IN ('new_lead_response','nurture','post_closing',
  'booking_confirmation','reminder','document_chase','trigger','voice_answering'));
ALTER TABLE playbooks ADD CONSTRAINT playbooks_voice_team_scope CHECK (kind <> 'voice_answering' OR scope = 'team');
-- `steps` holds the version's content: PlaybookStep[] for step playbooks (Phase 1) or one PlaybookContent
-- object for trigger and voice playbooks (core module 25). The frozen tuple and content_sha256 already cover it.
ALTER TABLE playbook_versions DROP CONSTRAINT playbook_versions_steps_check;
ALTER TABLE playbook_versions ADD CONSTRAINT playbook_versions_steps_check CHECK (jsonb_typeof(steps) IN ('array','object'));

ALTER TABLE playbook_step_runs ALTER COLUMN enrollment_id DROP NOT NULL;
ALTER TABLE playbook_step_runs
  ADD COLUMN contact_id  uuid,
  ADD COLUMN trigger_key text,
  ADD COLUMN trigger_ref jsonb,
  ADD CONSTRAINT playbook_step_runs_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  -- exactly one of: an enrollment step, or a trigger firing (unique per fact, so at most once per contact and fact)
  ADD CONSTRAINT playbook_step_runs_trigger_shape CHECK (
    (enrollment_id IS NOT NULL AND trigger_key IS NULL AND trigger_ref IS NULL)
    OR (enrollment_id IS NULL AND trigger_key IS NOT NULL AND contact_id IS NOT NULL
        AND trigger_ref IS NOT NULL AND jsonb_typeof(trigger_ref) = 'object'));
CREATE UNIQUE INDEX playbook_step_runs_trigger_key ON playbook_step_runs (tenant_id, trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX playbook_step_runs_trigger_contact ON playbook_step_runs (tenant_id, contact_id, status) WHERE enrollment_id IS NULL;
-- the per-tenant trigger reconcile handler (module 26) wakes scheduled firings from this stored instant
CREATE INDEX playbook_step_runs_trigger_due ON playbook_step_runs (tenant_id, scheduled_for)
  WHERE enrollment_id IS NULL AND status = 'scheduled';
CREATE POLICY step_runs_trigger ON playbook_step_runs FOR ALL
  USING (enrollment_id IS NULL AND ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)))
  WITH CHECK ((SELECT app.is_tenant_wide()));

-- -----------------------------------------------------------------------------
-- 6. Assistant: new kinds, purposes, evidence sources; decisions bound to the person (R-AST-19, R-AST-21, R-SELL-3)
-- -----------------------------------------------------------------------------
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check CHECK (kind IN ('message_draft','autonomous_message',
  'call_summary','handback','promise_extraction','saved_search_proposal','next_step','lead_summary','seller_update_draft',
  'weekly_plan','marketing_draft','call_review','ad_reallocation','review_reply_draft','contract_extraction'));
ALTER TABLE assistant_actions
  ADD COLUMN decided_by_role text CHECK (decided_by_role IN ('owner','admin','team_lead','agent','isa','tc')),
  ADD CONSTRAINT assistant_actions_p23_autonomy CHECK (
    (kind NOT IN ('marketing_draft','ad_reallocation','review_reply_draft','contract_extraction') OR autonomy = 'requires_approval')
    AND (kind <> 'ad_reallocation' OR action_category = 'money')
    AND (kind <> 'contract_extraction' OR action_category = 'contract')
    AND (kind <> 'review_reply_draft' OR action_category = 'novel_message')
    AND (kind NOT IN ('call_review','weekly_plan') OR autonomy = 'internal')),
  -- the approver writes the recommendation; the assistant never prefills it (R-SELL-3). One shape: the
  -- approval's edited_payload carries `recommendation` (>= 20 characters). NOT VALID spares pre-0015 rows.
  ADD CONSTRAINT assistant_actions_seller_update_recommendation CHECK (
    kind <> 'seller_update_draft' OR status NOT IN ('approved','executed')
    OR length(btrim(COALESCE(edited_payload->>'recommendation', ''))) >= 20) NOT VALID,
  -- the team's ad money moves only on an Owner's or Admin's tap (R-ADS-2, D-ADS)
  ADD CONSTRAINT assistant_actions_ad_shift_approver CHECK (
    kind <> 'ad_reallocation' OR status NOT IN ('approved','executed') OR COALESCE(decided_by_role IN ('owner','admin'), false));

-- A decision on an assistant action is a person's, made as themselves (R-AST-21): approving or rejecting
-- needs a user actor naming itself as the decider, and the decider's role is recorded from memberships at
-- that moment. A decision never changes afterwards (a revert to 'proposed' clears it), and a
-- requires-approval action is executed only after a person approved it. Superuser sessions (migrations,
-- test fixtures) are maintenance; no application path runs as a superuser (ARCHITECTURE §16).
CREATE FUNCTION app.assistant_actions_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deciding boolean;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF current_setting('is_superuser') = 'on' THEN RETURN NEW; END IF;
  deciding := NEW.decided_by_user_id IS NOT NULL
              AND (TG_OP = 'INSERT' OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
                   OR (NEW.status IN ('approved','rejected') AND OLD.status NOT IN ('approved','rejected')));
  IF deciding THEN
    IF app.actor_kind() IS DISTINCT FROM 'user' OR NEW.decided_by_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'DECISION_ACTOR: a person approves or rejects an assistant action, as themselves'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.decided_by_role := app.my_role();
  ELSIF TG_OP = 'UPDATE' AND OLD.decided_by_user_id IS NOT NULL AND NEW.status <> 'proposed'
        AND (NEW.decided_by_user_id, NEW.decided_at, NEW.decided_by_role)
            IS DISTINCT FROM (OLD.decided_by_user_id, OLD.decided_at, OLD.decided_by_role) THEN
    RAISE EXCEPTION 'DECISION_FINAL: a decision is not rewritten; revert to proposed and decide again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by_user_id IS NULL THEN NEW.decided_by_role := NULL; END IF;
  IF NEW.status = 'executed' AND NEW.autonomy = 'requires_approval'
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('approved','executed')) THEN
    RAISE EXCEPTION 'ACTION_NOT_APPROVED: an action that needs approval is executed only after a person approved it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistant_actions_decision_guard BEFORE INSERT OR UPDATE ON assistant_actions
  FOR EACH ROW EXECUTE FUNCTION app.assistant_actions_decision_guard();

ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_purpose_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_purpose_check CHECK (purpose IN ('draft','call_summary','claims_extraction',
  'handback_enrichment','lead_summary','first_response','search_proposal','pond_summary','opt_out_review',
  'seller_update','marketing_draft','call_review','weekly_plan','voice_session','contract_extraction','review_reply'));

ALTER TABLE evidence_refs DROP CONSTRAINT evidence_refs_source_type_check;
ALTER TABLE evidence_refs ADD CONSTRAINT evidence_refs_source_type_check CHECK (source_type IN ('call','message','email','note',
  'listing','import','behavior_event','deal','task','appointment','showing','showing_feedback','marketing_activity',
  'home_valuation','deal_date','metric','document','property_record'));

-- Phase 2/3 cards are materialized by their owning module under its own key family (the Phase 1 extension
-- point: the scorer leaves foreign keys alone); one Phase 2 module owns the shared feed code (module 18a).
ALTER TABLE priority_feed_items DROP CONSTRAINT priority_feed_items_item_type_check;
ALTER TABLE priority_feed_items ADD CONSTRAINT priority_feed_items_item_type_check CHECK (item_type IN ('lead_offer',
  'first_touch_due','unanswered_inbound','handback','assistant_draft','task_due','promise_due','deal_date',
  'appointment_outcome','reinquiry','inactivity_warning','pond_new','saved_search_review','missed_call',
  'seller_update','marketing_review','weekly_plan','coaching_fix','likely_to_move'));

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('lead_offer','first_touch_due',
  'first_touch_escalation','handback','handback_hot','inbound_message','missed_call','pond_new','task_due','promise_due',
  'exception','reassigned_to_you','reassigned_away','inactivity_warning','opt_out','import_ready','system',
  'seller_update_ready','weekly_plan','integration_status','ad_overspend'));

ALTER TABLE stored_objects DROP CONSTRAINT stored_objects_purpose_check;
ALTER TABLE stored_objects ADD CONSTRAINT stored_objects_purpose_check
  CHECK (purpose IN ('recording','mms','import_file','consent_evidence','marketing_asset','document'));

-- -----------------------------------------------------------------------------
-- 7. Marketing pieces: approve each version once, bound to its content; facts render live (R-MKT-1..11)
-- -----------------------------------------------------------------------------
CREATE TABLE marketing_pieces (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  listing_id          uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('website_page','social_post','open_house_invite','flyer',
                        'marketplace_export','gbp_post')),
  version_no          integer NOT NULL CHECK (version_no >= 1),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','exported',
                        'retracted','superseded')),
  prose               jsonb NOT NULL CHECK (jsonb_typeof(prose) = 'object'),        -- the only approved text
  bound_fields        text[] NOT NULL DEFAULT '{}' CHECK (bound_fields <@ ARRAY['price','status','beds','baths','sqft',
                        'address','open_house_at','photos']),
  template_key        text NOT NULL,
  content_sha256      text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),  -- computed by the guard, never the writer's
  guard_result        jsonb NOT NULL CHECK (jsonb_typeof(guard_result) = 'object'),  -- core guardResult over that content
  assistant_action_id uuid,
  public_slug         text CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]{2,80}$'),
  open_house          jsonb CHECK (open_house IS NULL OR jsonb_typeof(open_house) = 'object'),
  approved_by_user_id uuid,
  approved_at         timestamptz,
  published_at        timestamptz,
  exported_at         timestamptz,
  retracted_at        timestamptz,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, listing_id, kind, version_no),
  UNIQUE (tenant_id, public_slug),
  FOREIGN KEY (tenant_id, listing_id)          REFERENCES listings (tenant_id, id),
  FOREIGN KEY (tenant_id, assistant_action_id) REFERENCES assistant_actions (tenant_id, id) ON DELETE SET NULL (assistant_action_id),
  FOREIGN KEY (tenant_id, approved_by_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, created_by_user_id)  REFERENCES memberships (tenant_id, user_id),
  CHECK (public_slug IS NULL OR kind = 'website_page'),
  CHECK (open_house IS NULL OR kind = 'open_house_invite'),
  -- no approval, publication or export without the brokerage name, with any hard fair-housing match or
  -- pack-rule failure, or with a guard result computed over other content (R-MKT-1, R-FH-1, R-GATE-12).
  -- COALESCE: a guard result missing any of these keys is a refusal, never a NULL that a CHECK lets through.
  CHECK (status = 'draft' OR COALESCE(approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
         AND (guard_result->>'content_sha256') = content_sha256
         AND (guard_result->>'brokerage_name_present') = 'true'
         AND (guard_result->>'hard_count') = '0'
         AND CASE WHEN jsonb_typeof(guard_result->'pack_rule_failures') = 'array'
                  THEN jsonb_array_length(guard_result->'pack_rule_failures') = 0 ELSE false END, false)),
  CHECK ((status = 'published') <= (published_at IS NOT NULL)),
  CHECK ((status = 'exported') <= (exported_at IS NOT NULL)),
  CHECK ((status = 'retracted') = (retracted_at IS NOT NULL))
);
CREATE INDEX marketing_pieces_listing_idx ON marketing_pieces (tenant_id, listing_id, kind);
CREATE TRIGGER marketing_pieces_touch_updated_at BEFORE UPDATE ON marketing_pieces
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A piece's images, in order: live marketing assets of the same tenant only (composite FKs), frozen with the
-- piece once it leaves draft. The public page definer (0018) reads assets only through this table.
CREATE TABLE marketing_piece_assets (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  piece_id  uuid NOT NULL,
  position  smallint NOT NULL CHECK (position BETWEEN 1 AND 50),
  object_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, piece_id, position),
  UNIQUE (tenant_id, piece_id, object_id),
  FOREIGN KEY (tenant_id, piece_id)  REFERENCES marketing_pieces (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, object_id) REFERENCES stored_objects (tenant_id, id)
);

-- The content hash is the database's own, over prose, template, bound fields and the ordered assets, so a
-- guard result written for other content can never satisfy the approval CHECK. Module 29 reads it with this
-- function right before it writes guard_result.
CREATE FUNCTION app.marketing_content_sha256(p_tenant uuid, p_piece uuid, p_prose jsonb, p_template_key text, p_bound text[])
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(public.digest(jsonb_build_object(
           'prose', p_prose, 'template_key', p_template_key, 'bound_fields', to_jsonb(p_bound),
           'assets', COALESCE((SELECT jsonb_agg(a.object_id ORDER BY a.position) FROM public.marketing_piece_assets a
                                WHERE a.tenant_id = p_tenant AND a.piece_id = p_piece), '[]'::jsonb))::text, 'sha256'), 'hex')
$$;
GRANT EXECUTE ON FUNCTION app.marketing_content_sha256(uuid, uuid, jsonb, text, text[]) TO app_user, app_definer, app_retention;

CREATE FUNCTION app.marketing_pieces_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'MARKETING_BORN_DRAFT: a piece version starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.listings l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.listing_id AND l.source = 'team') THEN
      RAISE EXCEPTION 'MARKETING_TEAM_LISTING_ONLY: only the team''s own listings get marketing' USING ERRCODE = 'check_violation';
    END IF;
    NEW.content_sha256 := app.marketing_content_sha256(NEW.tenant_id, NEW.id, NEW.prose, NEW.template_key, NEW.bound_fields);
    RETURN NEW;
  END IF;
  IF (NEW.kind, NEW.listing_id, NEW.version_no) IS DISTINCT FROM (OLD.kind, OLD.listing_id, OLD.version_no) THEN
    RAISE EXCEPTION 'MARKETING_IDENTITY_IMMUTABLE: a piece version keeps its listing, kind and number' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' THEN
    NEW.content_sha256 := app.marketing_content_sha256(NEW.tenant_id, NEW.id, NEW.prose, NEW.template_key, NEW.bound_fields);
  ELSIF (NEW.prose, NEW.bound_fields, NEW.template_key, NEW.content_sha256, NEW.guard_result, NEW.approved_by_user_id, NEW.approved_at)
        IS DISTINCT FROM (OLD.prose, OLD.bound_fields, OLD.template_key, OLD.content_sha256, OLD.guard_result,
                          OLD.approved_by_user_id, OLD.approved_at) THEN
    RAISE EXCEPTION 'MARKETING_FROZEN: an approved version cannot change; create a new version' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('retracted','superseded') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'MARKETING_TERMINAL: % is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status <> 'draft' THEN
    IF NEW.status NOT IN ('approved','superseded') THEN
      RAISE EXCEPTION 'MARKETING_APPROVE_FIRST' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'approved' AND (app.actor_kind() IS DISTINCT FROM 'user' OR NEW.approved_by_user_id IS DISTINCT FROM app.user_id()) THEN
      RAISE EXCEPTION 'MARKETING_HUMAN_APPROVAL: a person approves a piece, as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- publishing to pages and channels we control waits for counsel review of the fair-housing pack (C3, C5)
  IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' AND NOT app.platform_cleared('platform:fair_housing') THEN
    RAISE EXCEPTION 'PLATFORM_NOT_CLEARED: publishing waits for counsel review of the platform:fair_housing pack'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_pieces_guard BEFORE INSERT OR UPDATE ON marketing_pieces
  FOR EACH ROW EXECUTE FUNCTION app.marketing_pieces_guard();

-- Assets change only while their piece is a draft, and only to live marketing assets the caller can see.
CREATE FUNCTION app.marketing_piece_assets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = 'app_retention'
       OR NOT EXISTS (SELECT 1 FROM public.marketing_pieces mp WHERE mp.tenant_id = OLD.tenant_id AND mp.id = OLD.piece_id) THEN
      RETURN OLD;     -- retention, or the cascade of a deleted piece
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.marketing_pieces mp
                    WHERE mp.tenant_id = OLD.tenant_id AND mp.id = OLD.piece_id AND mp.status = 'draft') THEN
      RAISE EXCEPTION 'MARKETING_FROZEN: an approved version keeps its images' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT EXISTS (SELECT 1 FROM public.marketing_pieces mp
                  WHERE mp.tenant_id = NEW.tenant_id AND mp.id = NEW.piece_id AND mp.status = 'draft')
     OR (TG_OP = 'UPDATE' AND NOT EXISTS (SELECT 1 FROM public.marketing_pieces mp
                  WHERE mp.tenant_id = OLD.tenant_id AND mp.id = OLD.piece_id AND mp.status = 'draft')) THEN
    RAISE EXCEPTION 'MARKETING_FROZEN: an approved version keeps its images' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stored_objects o
                  WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.object_id
                    AND o.purpose = 'marketing_asset' AND o.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'MARKETING_ASSET_INVALID: a piece shows only live marketing assets' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_piece_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON marketing_piece_assets
  FOR EACH ROW EXECUTE FUNCTION app.marketing_piece_assets_guard();

ALTER TABLE messages ADD CONSTRAINT messages_marketing_piece_fk
  FOREIGN KEY (tenant_id, marketing_piece_id) REFERENCES marketing_pieces (tenant_id, id);
-- an open-house invite is an email, always marketing (SMS blasts stay cut: R-MKT-8)
ALTER TABLE messages ADD CONSTRAINT messages_marketing_piece_email CHECK (marketing_piece_id IS NULL OR (channel = 'email' AND purpose = 'marketing'));

-- -----------------------------------------------------------------------------
-- 8. Transactions: milestones are deal_dates with confirmation and stored instants (R-TXN-1..6)
-- -----------------------------------------------------------------------------
-- Completion has one representation, completed_at (Phase 1); status says whether a date is proposed,
-- confirmed or waived. due_at is the end of the due day in tenant_settings.default_timezone (the zone is
-- recorded in basis); module 31 is the only writer of deal dates and computes due_at/reminder_at at confirm time.
ALTER TABLE deal_dates
  ADD COLUMN source               text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','template','document','import')),
  ADD COLUMN status               text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed','confirmed','waived')),
  ADD COLUMN confirmed_by_user_id uuid,
  ADD COLUMN confirmed_at         timestamptz,
  ADD COLUMN responsible          text CHECK (responsible IN ('buyer','seller','lender','title','agent','tc','other')),
  ADD COLUMN due_at               timestamptz,              -- end of the due day in the tenant zone, computed at confirm time
  ADD COLUMN reminder_at          timestamptz,              -- stored instant (R-OWN-27)
  ADD COLUMN due_version          integer NOT NULL DEFAULT 1 CHECK (due_version >= 1),
  ADD COLUMN basis                jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(basis) = 'object'),   -- template rule, zone
  ADD COLUMN evidence_claim_id    uuid,
  ADD CONSTRAINT deal_dates_confirmer_fk FOREIGN KEY (tenant_id, confirmed_by_user_id) REFERENCES memberships (tenant_id, user_id),
  ADD CONSTRAINT deal_dates_claim_fk FOREIGN KEY (tenant_id, evidence_claim_id) REFERENCES assistant_claims (tenant_id, id)
    ON DELETE SET NULL (evidence_claim_id),
  -- proposals (template, document) drive nothing until a person confirms them
  ADD CONSTRAINT deal_dates_confirmed_by_human CHECK (source = 'manual' OR status = 'proposed'
                                                      OR (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  ADD CONSTRAINT deal_dates_reminder_confirmed CHECK (reminder_at IS NULL OR (status = 'confirmed' AND completed_at IS NULL));

CREATE FUNCTION app.deal_dates_confirm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev uuid;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' THEN prev := OLD.confirmed_by_user_id; END IF;
  IF current_user NOT IN ('app_definer','app_retention') THEN
    IF NEW.confirmed_by_user_id IS NOT NULL AND NEW.confirmed_by_user_id IS DISTINCT FROM prev
       AND (app.actor_kind() IS DISTINCT FROM 'user' OR NEW.confirmed_by_user_id IS DISTINCT FROM app.user_id()) THEN
      RAISE EXCEPTION 'DATE_HUMAN_CONFIRMATION: a person confirms a milestone date, as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- confirmed dates drive client and lender messages: a 'manual' one is a person's fact, and only a person
    -- moves a confirmed date (imports use source 'import' through their own definer)
    IF app.actor_kind() IS DISTINCT FROM 'user'
       AND ((NEW.status = 'confirmed' AND NEW.source = 'manual' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed'))
            OR (TG_OP = 'UPDATE' AND OLD.status = 'confirmed' AND NEW.due_on IS DISTINCT FROM OLD.due_on)) THEN
      RAISE EXCEPTION 'DATE_HUMAN_CONFIRMATION: a person enters and moves confirmed dates' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- Moving a confirmed date always bumps due_version (drafts and trigger firings bound to the old version go
  -- stale), and drops stored instants the writer did not recompute in the same statement (R-TXN-5, R-OWN-27).
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' AND NEW.due_on IS DISTINCT FROM OLD.due_on THEN
    NEW.due_version := GREATEST(NEW.due_version, OLD.due_version + 1);
    IF NEW.due_at IS NOT DISTINCT FROM OLD.due_at THEN NEW.due_at := NULL; END IF;
    IF NEW.reminder_at IS NOT DISTINCT FROM OLD.reminder_at THEN NEW.reminder_at := NULL; END IF;
  END IF;
  -- a completed or waived milestone is never reminded
  IF NEW.completed_at IS NOT NULL OR NEW.status <> 'confirmed' THEN NEW.reminder_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deal_dates_confirm_guard BEFORE INSERT OR UPDATE ON deal_dates
  FOR EACH ROW EXECUTE FUNCTION app.deal_dates_confirm_guard();
-- the per-tenant milestone reconcile handler (module 31) wakes reminders from this stored instant
CREATE INDEX deal_dates_reminder_idx ON deal_dates (tenant_id, reminder_at) WHERE reminder_at IS NOT NULL;

ALTER TABLE deal_contacts DROP CONSTRAINT deal_contacts_role_check;
ALTER TABLE deal_contacts ADD CONSTRAINT deal_contacts_role_check
  CHECK (role IN ('buyer','seller','co_buyer','co_seller','other','lender','title','attorney'));

ALTER TABLE exception_items DROP CONSTRAINT exception_items_item_type_check;
ALTER TABLE exception_items ADD CONSTRAINT exception_items_item_type_check
  CHECK (item_type IN ('untouched_lead','overdue_promise','failed_send','missing_outcome','milestone_at_risk'));
ALTER TABLE exception_items DROP CONSTRAINT exception_items_subject_type_check;
ALTER TABLE exception_items ADD CONSTRAINT exception_items_subject_type_check
  CHECK (subject_type IN ('contact','task','message','appointment','call','deal_date'));

-- -----------------------------------------------------------------------------
-- 9. Home values (R-AVM-1..3). The AVM vendor is platform configuration (provider names it); an estimate
--    that was unavailable carries no value at all.
-- -----------------------------------------------------------------------------
ALTER TABLE home_valuations ALTER COLUMN value_cents DROP NOT NULL;
ALTER TABLE home_valuations
  ADD COLUMN status                text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','unavailable','error')),
  ADD COLUMN as_of                 date,
  ADD COLUMN display_allowed       boolean NOT NULL DEFAULT false,       -- from the vendor licence (VERIFY)
  ADD COLUMN change_from_prior_bps integer,
  ADD CONSTRAINT home_valuations_value_when_ok CHECK ((status = 'ok') = (value_cents IS NOT NULL)),
  ADD CONSTRAINT home_valuations_range CHECK (low_cents IS NULL OR high_cents IS NULL OR low_cents <= high_cents);
CREATE UNIQUE INDEX home_valuations_one_per_month ON home_valuations
  (tenant_id, contact_address_id, (date_trunc('month', valued_at AT TIME ZONE 'UTC')))
  WHERE contact_address_id IS NOT NULL AND status = 'ok';

-- -----------------------------------------------------------------------------
-- 10. Owner view: source costs (R-OWNER-1..5)
-- -----------------------------------------------------------------------------
CREATE TABLE lead_source_costs (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  lead_source_id     uuid NOT NULL,
  month              date NOT NULL CHECK (extract(day FROM month) = 1),
  amount_cents       bigint NOT NULL CHECK (amount_cents >= 0),
  origin             text NOT NULL CHECK (origin IN ('manual','ads_sync')),
  note               text CHECK (length(note) <= 500),
  entered_by_user_id uuid,                      -- manual rows: the person who last entered the amount
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, lead_source_id, month, origin),
  FOREIGN KEY (tenant_id, lead_source_id)     REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, entered_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((origin = 'manual') = (entered_by_user_id IS NOT NULL))
);
CREATE TRIGGER lead_source_costs_touch_updated_at BEFORE UPDATE ON lead_source_costs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE FUNCTION app.lead_source_costs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin OR NEW.lead_source_id IS DISTINCT FROM OLD.lead_source_id OR NEW.month IS DISTINCT FROM OLD.month THEN
    RAISE EXCEPTION 'COST_ROW_IMMUTABLE: a cost row keeps its source, month and origin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lead_source_costs_guard BEFORE UPDATE ON lead_source_costs
  FOR EACH ROW EXECUTE FUNCTION app.lead_source_costs_guard();

-- -----------------------------------------------------------------------------
-- 11. Call reviews: rubric items with transcript evidence; private by default (R-COACH-1..6)
-- -----------------------------------------------------------------------------
CREATE TABLE call_scores (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  call_id             uuid NOT NULL,
  rubric_version      text NOT NULL CHECK (rubric_version ~ '^rubric/[0-9]+$'),
  agent_user_id       uuid NOT NULL,
  contact_id          uuid NOT NULL,
  items               jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),   -- [{key, status: met|missed|not_applicable|needs_review, claim_id}]
  met_count           integer NOT NULL CHECK (met_count >= 0),
  scored_count        integer NOT NULL CHECK (scored_count >= 0),
  assistant_action_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, call_id, rubric_version),
  FOREIGN KEY (tenant_id, call_id)             REFERENCES calls (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id)          REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, agent_user_id)       REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, assistant_action_id) REFERENCES assistant_actions (tenant_id, id) ON DELETE SET NULL (assistant_action_id),
  CHECK (met_count <= scored_count)
);
-- A review covers a call a person handled, for the agent and the contact of that call (R-COACH-3).
CREATE FUNCTION app.call_scores_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT EXISTS (SELECT 1 FROM public.calls c
                  WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.call_id AND c.handled_by = 'human'
                    AND c.agent_user_id = NEW.agent_user_id AND c.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'CALL_REVIEW_SUBJECT: a review covers a call a person handled, for the agent on that call'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER call_scores_guard BEFORE INSERT OR UPDATE ON call_scores FOR EACH ROW EXECUTE FUNCTION app.call_scores_guard();

-- -----------------------------------------------------------------------------
-- 12. Voice answering (Phase 3): inbound only, disclosed, announced, cleared (R-VOICE-1..10; R-GATE-9 rewritten)
-- -----------------------------------------------------------------------------
ALTER TABLE calls DROP CONSTRAINT calls_handled_by_check;
ALTER TABLE calls ADD CONSTRAINT calls_handled_by_check CHECK (handled_by IN ('human','voicemail','assistant'));
ALTER TABLE calls
  ADD COLUMN ai_disclosed_at           timestamptz,
  ADD COLUMN voice_playbook_version_id uuid,
  ADD COLUMN ai_takeover_at            timestamptz,     -- the telephony dial timeout decided at call start (R-VOICE-3)
  ADD COLUMN transferred_to_user_id    uuid,
  ADD COLUMN transfer_outcome          text CHECK (transfer_outcome IN ('connected','no_answer','declined')),
  ADD COLUMN voice_outcome             text CHECK (voice_outcome IN ('booked','transferred','message_taken','caller_ended',
                                                                       'opted_out','fallback_voicemail','error')),
  ADD COLUMN handback_action_id        uuid,
  ADD CONSTRAINT calls_voice_playbook_fk FOREIGN KEY (tenant_id, voice_playbook_version_id) REFERENCES playbook_versions (tenant_id, id),
  ADD CONSTRAINT calls_transfer_user_fk FOREIGN KEY (tenant_id, transferred_to_user_id) REFERENCES memberships (tenant_id, user_id),
  ADD CONSTRAINT calls_handback_fk FOREIGN KEY (tenant_id, handback_action_id) REFERENCES assistant_actions (tenant_id, id)
    ON DELETE SET NULL (handback_action_id),
  -- the assistant only ever ANSWERS: no AI-originated or AI-handled outbound call can exist (R-VOICE-1)
  ADD CONSTRAINT calls_assistant_inbound_only CHECK (handled_by <> 'assistant'
    OR (direction = 'inbound' AND initiator = 'client' AND voice_playbook_version_id IS NOT NULL)),
  -- for an AI call, answered_at is the moment processing began: never before the self-identifying disclosure
  -- AND the recording announcement played, whatever the call's final status (R-VOICE-2)
  ADD CONSTRAINT calls_assistant_disclosed CHECK (handled_by <> 'assistant' OR answered_at IS NULL
    OR (ai_disclosed_at IS NOT NULL AND recording_announced_at IS NOT NULL)),
  ADD CONSTRAINT calls_voice_fields_assistant_only CHECK (handled_by = 'assistant'
    OR (ai_disclosed_at IS NULL AND voice_outcome IS NULL AND voice_playbook_version_id IS NULL));

-- Turning voice answering on is the Owner's decision, with an attestation, and only once counsel cleared the
-- platform:voice pack and a real vendor passed the latency spike (R-VOICE-9, R-INT-6).
ALTER TABLE compliance_policy_versions
  ADD COLUMN voice_answering_enabled     boolean NOT NULL DEFAULT false,
  ADD COLUMN voice_answering_attestation text,
  ADD CONSTRAINT compliance_policy_voice_attested CHECK (NOT voice_answering_enabled OR voice_answering_attestation IS NOT NULL);
CREATE FUNCTION app.compliance_policy_voice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NEW.voice_answering_enabled AND current_user NOT IN ('app_definer','app_retention') THEN
    IF COALESCE(app.my_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'OWNER_ONLY_VOICE: only the Owner turns on voice answering' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.platform_cleared('platform:voice', true) THEN
      RAISE EXCEPTION 'VOICE_NOT_CLEARED: voice answering waits for counsel review and the vendor latency spike'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_policy_voice_guard BEFORE INSERT ON compliance_policy_versions
  FOR EACH ROW EXECUTE FUNCTION app.compliance_policy_voice_guard();

-- An AI-handled call needs an APPROVED voice_answering version, voice answering on in the tenant's active
-- compliance policy, and the platform pack still cleared (ships dark: R-VOICE-1, R-VOICE-9).
CREATE FUNCTION app.calls_voice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NEW.handled_by = 'assistant' AND (TG_OP = 'INSERT' OR OLD.handled_by IS DISTINCT FROM 'assistant'
                                       OR OLD.voice_playbook_version_id IS DISTINCT FROM NEW.voice_playbook_version_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.playbook_versions v JOIN public.playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
                    WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.voice_playbook_version_id
                      AND v.status = 'approved' AND p.kind = 'voice_answering') THEN
      RAISE EXCEPTION 'VOICE_PLAYBOOK_NOT_APPROVED: the assistant answers only under an approved voice playbook' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tenant_settings s JOIN public.compliance_policy_versions cp
                     ON cp.tenant_id = s.tenant_id AND cp.id = s.active_policy_id
                    WHERE s.tenant_id = NEW.tenant_id AND cp.voice_answering_enabled) THEN
      RAISE EXCEPTION 'VOICE_ANSWERING_OFF: the Owner has not turned on voice answering' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.platform_cleared('platform:voice', true) THEN
      RAISE EXCEPTION 'VOICE_NOT_CLEARED: voice answering waits for counsel review and the vendor latency spike'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calls_voice_guard BEFORE INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION app.calls_voice_guard();

-- Tool arguments are ids, codes and slot instants only: free text (and with it PII) is never stored in this
-- ledger, so it can outlive the call it belongs to (R-VOICE-4, R-DATA-6).
CREATE FUNCTION app.voice_tool_args_ok(p_tool text, p_args jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  iso  constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$';
  code constant text := '^[A-Z][A-Z0-9_]{0,63}$';
  uid  constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  k text;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(p_args) LOOP
    IF jsonb_typeof(p_args->k) <> 'string' THEN RETURN false; END IF;
  END LOOP;
  RETURN CASE p_tool
    WHEN 'check_availability' THEN (p_args - ARRAY['from','to']) = '{}'::jsonb
      AND COALESCE(p_args->>'from' ~ iso, true) AND COALESCE(p_args->>'to' ~ iso, true)
    WHEN 'book_appointment' THEN (p_args - ARRAY['slot_start','slot_end','kind']) = '{}'::jsonb
      AND COALESCE(p_args->>'slot_start' ~ iso, false) AND COALESCE(p_args->>'slot_end' ~ iso, false)
      AND COALESCE(p_args->>'kind' IN ('buyer_consult','listing_appointment','consult','other'), true)
    WHEN 'warm_transfer' THEN (p_args - ARRAY['target_user_id']) = '{}'::jsonb AND COALESCE(p_args->>'target_user_id' ~ uid, true)
    WHEN 'take_message' THEN (p_args - ARRAY['topic']) = '{}'::jsonb AND COALESCE(p_args->>'topic' ~ code, true)
    WHEN 'record_opt_out' THEN (p_args - ARRAY['channel']) = '{}'::jsonb AND COALESCE(p_args->>'channel' IN ('voice','sms','all'), true)
    WHEN 'end_call' THEN (p_args - ARRAY['reason_code']) = '{}'::jsonb AND COALESCE(p_args->>'reason_code' ~ code, true)
    ELSE false END;
END $$;
GRANT EXECUTE ON FUNCTION app.voice_tool_args_ok(text, jsonb) TO app_user, app_definer, app_retention;

-- Every tool request the voice model made and core's decision. A ledger: no FK to mutable rows, no PII.
CREATE TABLE voice_tool_calls (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL,
  call_id     uuid NOT NULL,
  seq         integer NOT NULL CHECK (seq >= 1),
  tool        text NOT NULL CHECK (tool IN ('check_availability','book_appointment','warm_transfer','take_message',
                'record_opt_out','end_call')),
  args        jsonb NOT NULL DEFAULT '{}' CONSTRAINT voice_tool_calls_args_check CHECK (app.voice_tool_args_ok(tool, args)),
  decision    text NOT NULL CHECK (decision IN ('allow','deny')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]*$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, call_id, seq)
);
CREATE TRIGGER voice_tool_calls_append_only BEFORE UPDATE OR DELETE ON voice_tool_calls
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER voice_tool_calls_no_truncate BEFORE TRUNCATE ON voice_tool_calls
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
-- a tool request belongs to an AI call that already disclosed itself and announced the recording (R-VOICE-2)
CREATE FUNCTION app.voice_tool_calls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT EXISTS (SELECT 1 FROM public.calls c
                  WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.call_id AND c.handled_by = 'assistant'
                    AND c.ai_disclosed_at <= NEW.occurred_at AND c.recording_announced_at <= NEW.occurred_at) THEN
    RAISE EXCEPTION 'VOICE_TOOL_BEFORE_DISCLOSURE: tool requests start only after the disclosure and the recording announcement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voice_tool_calls_guard BEFORE INSERT ON voice_tool_calls FOR EACH ROW EXECUTE FUNCTION app.voice_tool_calls_guard();

-- -----------------------------------------------------------------------------
-- 13. Tenant settings for Phase 2/3 (Owner-only where they widen who sees what or turn on a gated capability)
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_settings
  ADD COLUMN seller_update_cadence_days integer NOT NULL DEFAULT 7 CHECK (seller_update_cadence_days BETWEEN 0 AND 31),
  ADD COLUMN milestone_templates        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(milestone_templates) = 'array'),
  ADD COLUMN review_link_url            text CHECK (review_link_url ~ '^https://'),
  ADD COLUMN brand_color                text CHECK (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN avm_max_range_bps          integer NOT NULL DEFAULT 2500 CHECK (avm_max_range_bps BETWEEN 100 AND 10000),
  ADD COLUMN call_scoring_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN tl_sees_call_scores        boolean NOT NULL DEFAULT false,
  ADD COLUMN coaching_rubric_disabled   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN calendar_title_detail      text NOT NULL DEFAULT 'first_name_initial'
                                        CHECK (calendar_title_detail IN ('first_name_initial','none')),
  ADD COLUMN voice_answer_after_seconds integer NOT NULL DEFAULT 20 CHECK (voice_answer_after_seconds BETWEEN 10 AND 60),
  ADD COLUMN voice_answer_when          text NOT NULL DEFAULT 'missed_and_after_hours'
                                        CHECK (voice_answer_when IN ('missed_and_after_hours','after_hours_only'));
CREATE FUNCTION app.tenant_settings_p23_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF current_user IN ('app_definer','app_retention') THEN RETURN NEW; END IF;
  IF (NEW.call_scoring_enabled, NEW.tl_sees_call_scores) IS DISTINCT FROM (OLD.call_scoring_enabled, OLD.tl_sees_call_scores)
     AND COALESCE(app.my_role(), '') <> 'owner' THEN
    RAISE EXCEPTION 'OWNER_ONLY_SETTING' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.call_scoring_enabled AND NOT OLD.call_scoring_enabled AND NOT app.platform_cleared('platform:coaching') THEN
    RAISE EXCEPTION 'COACHING_NOT_CLEARED: call scoring waits for counsel review of the platform:coaching pack'
      USING ERRCODE = 'check_violation';
  END IF;
  -- only the Owner turns voice answering on, including by re-activating an older voice-on policy version;
  -- turning it off stays open to Admins (R-VOICE-9, E150)
  IF NEW.active_policy_id IS DISTINCT FROM OLD.active_policy_id
     AND EXISTS (SELECT 1 FROM public.compliance_policy_versions cp
                  WHERE cp.tenant_id = NEW.tenant_id AND cp.id = NEW.active_policy_id AND cp.voice_answering_enabled)
     AND COALESCE(app.my_role(), '') <> 'owner' THEN
    RAISE EXCEPTION 'OWNER_ONLY_VOICE: only the Owner turns on voice answering' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings_p23_guard BEFORE UPDATE ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION app.tenant_settings_p23_guard();

-- -----------------------------------------------------------------------------
-- 14. Prediction (Phase 3): property facts by construction, bands not probabilities (R-PRED-1..6)
-- -----------------------------------------------------------------------------
-- Global, platform-released scorecard versions. A model is usable only once counsel reviewed it and it carries
-- the platform back-test it is shown with; withdrawing it hides every score computed with it at once
-- (R-PRED-5). Its features can only name the allowed property and first-party facts (R-PRED-1). Seeded empty.
CREATE TABLE prediction_models (
  version              text PRIMARY KEY CHECK (version ~ '^predict/[0-9]+\.[0-9]+$'),
  status               text NOT NULL CHECK (status IN ('draft','approved','withdrawn')),
  features             text[] NOT NULL CHECK (cardinality(features) >= 1 AND features <@ ARRAY['years_in_home','equity_band',
                         'recent_saves','stated_timeline_days','past_client_years','recent_permit']::text[]),
  counsel_reviewed_at  timestamptz,
  review_note          text,
  backtest_flagged     integer CHECK (backtest_flagged >= 0),
  backtest_transacted  integer CHECK (backtest_transacted >= 0),
  backtest_window_days integer CHECK (backtest_window_days BETWEEN 30 AND 365),
  backtest_dataset     text CHECK (length(btrim(backtest_dataset)) BETWEEN 1 AND 300),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR counsel_reviewed_at IS NOT NULL),
  CHECK (num_nulls(backtest_flagged, backtest_transacted, backtest_window_days, backtest_dataset) IN (0, 4)),
  CHECK (backtest_transacted IS NULL OR backtest_transacted <= backtest_flagged),
  CHECK (status <> 'approved' OR backtest_flagged IS NOT NULL)
);
ALTER TABLE prediction_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE prediction_models FORCE ROW LEVEL SECURITY;
CREATE POLICY prediction_models_read ON prediction_models FOR SELECT USING (true);
GRANT SELECT ON prediction_models TO app_user, app_definer;

-- Property facts only: there is no column for any person-level life event or demographic (R-PRED-2). The
-- public-records vendor is platform configuration; provider_ref names its record.
CREATE TABLE property_records (
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  id                        uuid NOT NULL,
  contact_id                uuid NOT NULL,
  contact_address_id        uuid NOT NULL,
  last_sale_date            date,
  last_sale_price_cents     bigint CHECK (last_sale_price_cents >= 0),
  assessed_value_cents      bigint CHECK (assessed_value_cents >= 0),
  mortgage_origination_date date,
  owner_occupied            boolean,
  owner_name_match          boolean NOT NULL,
  recent_permit             boolean,
  provider_ref              text,
  fetched_at                timestamptz NOT NULL,
  retention_until           timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, contact_address_id),
  FOREIGN KEY (tenant_id, contact_id)         REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_address_id) REFERENCES contact_addresses (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE contact_predictions (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  contact_id    uuid NOT NULL,
  model_version text NOT NULL REFERENCES prediction_models (version),
  band          text NOT NULL CHECK (band IN ('likely_90d','watch','none','not_enough_data')),
  reasons       jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),   -- [{feature, points, evidence_ref}]
  inputs_sha256 text NOT NULL CHECK (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  computed_on   date NOT NULL,
  PRIMARY KEY (tenant_id, contact_id, model_version),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CHECK (band NOT IN ('likely_90d','watch') OR jsonb_array_length(reasons) >= 1)
);
-- every reason cites a feature of its own model (R-PRED-1)
CREATE FUNCTION app.contact_predictions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.reasons) r
              WHERE jsonb_typeof(r) <> 'object'
                 OR NOT EXISTS (SELECT 1 FROM public.prediction_models m
                                 WHERE m.version = NEW.model_version AND (r->>'feature') = ANY (m.features))) THEN
    RAISE EXCEPTION 'PREDICTION_REASON_FEATURE: a reason cites only a feature of its model' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_predictions_guard BEFORE INSERT OR UPDATE ON contact_predictions
  FOR EACH ROW EXECUTE FUNCTION app.contact_predictions_guard();

-- -----------------------------------------------------------------------------
-- 15. Ads (Phase 3): Owner cap versions [AO], an allocation ledger [AO] the DB keeps under the cap (R-ADS-1..6)
-- -----------------------------------------------------------------------------
CREATE TABLE ad_campaigns (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL,
  connection_id        uuid NOT NULL,
  external_campaign_id text NOT NULL,
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  lead_source_id       uuid NOT NULL,
  campaign_ref         text NOT NULL,              -- matches lead_inquiries.campaign_ref / deals.campaign_ref
  listing_id           uuid,
  creative_piece_id    uuid,
  special_category     text NOT NULL DEFAULT 'housing' CHECK (special_category = 'housing'),
  targeting            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(targeting) = 'object'),   -- TargetingSpec (R-FH-4)
  status               text NOT NULL CHECK (status IN ('draft','active','paused','ended','rejected')),
  daily_budget_cents   bigint NOT NULL CHECK (daily_budget_cents >= 0),   -- the platform's budget, synced by the system
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, connection_id, external_campaign_id),
  FOREIGN KEY (tenant_id, connection_id)     REFERENCES integration_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_source_id)    REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, listing_id)        REFERENCES listings (tenant_id, id),
  FOREIGN KEY (tenant_id, creative_piece_id) REFERENCES marketing_pieces (tenant_id, id),
  CHECK (status <> 'active' OR (creative_piece_id IS NOT NULL AND listing_id IS NOT NULL))
);
CREATE TRIGGER ad_campaigns_touch_updated_at BEFORE UPDATE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- A campaign runs only an approved creative of its own listing (R-MKT-1, R-ADS-4), and its budget mirror moves
-- only with the system (provider sync after an applied ledger change, R-ADS-3): people never type a budget in.
CREATE FUNCTION app.ad_campaigns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active'
       OR NEW.creative_piece_id IS DISTINCT FROM OLD.creative_piece_id OR NEW.listing_id IS DISTINCT FROM OLD.listing_id)
     AND NOT EXISTS (SELECT 1 FROM public.marketing_pieces mp
                      WHERE mp.tenant_id = NEW.tenant_id AND mp.id = NEW.creative_piece_id
                        AND mp.status IN ('approved','published') AND mp.listing_id = NEW.listing_id) THEN
    RAISE EXCEPTION 'AD_CREATIVE_NOT_APPROVED: a campaign runs only an approved piece of its own listing' USING ERRCODE = 'check_violation';
  END IF;
  IF app.actor_kind() IS DISTINCT FROM 'system' AND current_user NOT IN ('app_definer','app_retention')
     AND ((TG_OP = 'INSERT' AND NEW.daily_budget_cents <> 0)
          OR (TG_OP = 'UPDATE' AND NEW.daily_budget_cents IS DISTINCT FROM OLD.daily_budget_cents)) THEN
    RAISE EXCEPTION 'AD_BUDGET_THROUGH_LEDGER: budgets change only through an approved, applied ledger change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ad_campaigns_guard BEFORE INSERT OR UPDATE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION app.ad_campaigns_guard();

CREATE TABLE ad_budget_caps (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  version_no          integer NOT NULL CHECK (version_no >= 1),
  monthly_cap_cents   bigint NOT NULL CHECK (monthly_cap_cents >= 0),
  daily_ceiling_cents bigint NOT NULL CHECK (daily_ceiling_cents >= 0),
  effective_from      timestamptz NOT NULL,
  approved_by_user_id uuid NOT NULL,
  attestation         text NOT NULL CHECK (length(btrim(attestation)) >= 10),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, version_no),
  FOREIGN KEY (tenant_id, approved_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK (daily_ceiling_cents <= monthly_cap_cents)
);
CREATE TRIGGER ad_budget_caps_append_only BEFORE UPDATE OR DELETE ON ad_budget_caps FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER ad_budget_caps_no_truncate BEFORE TRUNCATE ON ad_budget_caps FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE FUNCTION app.ad_budget_caps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF current_user NOT IN ('app_definer','app_retention')
     AND (app.actor_kind() IS DISTINCT FROM 'user' OR NEW.approved_by_user_id IS DISTINCT FROM app.user_id()
          OR COALESCE(app.my_role(), '') <> 'owner') THEN
    RAISE EXCEPTION 'OWNER_ONLY_AD_CAP: only the Owner, as themselves, sets the ad budget cap' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ad_budget_caps_guard BEFORE INSERT ON ad_budget_caps FOR EACH ROW EXECUTE FUNCTION app.ad_budget_caps_guard();

-- One row per planned / applied / failed / paused change. A ledger: no FK to mutable rows, no PII.
CREATE TABLE ad_allocation_events (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  run_id              uuid NOT NULL,
  campaign_id         uuid NOT NULL,
  event_kind          text NOT NULL CHECK (event_kind IN ('planned','applied','failed','paused')),
  cap_version_id      uuid NOT NULL,
  assistant_action_id uuid,                     -- the approved ad_reallocation (D-ADS: every shift is a tap)
  from_daily_cents    bigint NOT NULL CHECK (from_daily_cents >= 0),
  to_daily_cents      bigint NOT NULL CHECK (to_daily_cents >= 0),
  reason_code         text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]*$'),
  provider_ref        text,
  occurred_at         timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, run_id, campaign_id, event_kind),
  FOREIGN KEY (tenant_id, cap_version_id) REFERENCES ad_budget_caps (tenant_id, id),
  CHECK (event_kind <> 'planned' OR assistant_action_id IS NOT NULL),
  CHECK (event_kind <> 'paused' OR to_daily_cents = 0)
);
-- an approval moves each campaign once: it cannot be replayed in another run (R-ADS-2)
CREATE UNIQUE INDEX ad_allocation_events_approval_once ON ad_allocation_events (tenant_id, assistant_action_id, campaign_id)
  WHERE event_kind = 'planned';
CREATE TRIGGER ad_allocation_events_append_only BEFORE UPDATE OR DELETE ON ad_allocation_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER ad_allocation_events_no_truncate BEFORE TRUNCATE ON ad_allocation_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
-- At COMMIT, under a per-tenant lock (so two runs cannot both pass):
--   * planned: cites the cap version in force and an ad_reallocation an Owner/Admin approved that names this
--     exact (campaign, new daily budget); and the tenant-wide daily total after the run stays within that
--     version's ceiling. The total counts this run's planned budgets, every other campaign's latest planned or
--     applied budget (or its synced budget if higher), 0 for paused campaigns, and the synced budget otherwise.
--   * applied / failed: match a planned row of the same run, campaign and amount.
--   * paused (to 0) only lowers spend and is always accepted.
-- Definer so the check sees every row of the tenant whoever writes.
CREATE FUNCTION app.ad_allocation_cap_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE total bigint; cap record; changes jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ads:' || NEW.tenant_id::text, 0));
  IF NEW.event_kind = 'paused' THEN RETURN NULL; END IF;
  IF NEW.event_kind IN ('applied','failed') THEN
    IF NOT EXISTS (SELECT 1 FROM public.ad_allocation_events p
                    WHERE p.tenant_id = NEW.tenant_id AND p.run_id = NEW.run_id AND p.campaign_id = NEW.campaign_id
                      AND p.event_kind = 'planned' AND p.to_daily_cents = NEW.to_daily_cents) THEN
      RAISE EXCEPTION 'AD_APPLY_WITHOUT_PLAN: a budget change is applied only as it was planned and approved'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT c.id, c.daily_ceiling_cents INTO cap FROM public.ad_budget_caps c
   WHERE c.tenant_id = NEW.tenant_id AND c.effective_from <= now()
   ORDER BY c.effective_from DESC, c.version_no DESC LIMIT 1;
  IF NOT FOUND OR cap.id <> NEW.cap_version_id THEN
    RAISE EXCEPTION 'AD_CAP_VERSION_STALE: a plan cites the cap version in force' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(aa.edited_payload, aa.payload)->'changes' INTO changes FROM public.assistant_actions aa
   WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.assistant_action_id AND aa.kind = 'ad_reallocation'
     AND aa.status IN ('approved','executed') AND aa.decided_by_user_id IS NOT NULL AND aa.decided_by_role IN ('owner','admin');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AD_SHIFT_NOT_APPROVED: every budget shift needs an Owner''s or Admin''s tap' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(changes) IS DISTINCT FROM 'array' OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(changes) x
        WHERE x->>'campaign_id' = NEW.campaign_id::text AND x->>'to_daily_cents' = NEW.to_daily_cents::text) THEN
    RAISE EXCEPTION 'AD_SHIFT_NOT_IN_APPROVAL: the approval does not name this campaign and amount' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ad_campaigns c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.campaign_id) THEN
    RAISE EXCEPTION 'AD_CAMPAIGN_UNKNOWN' USING ERRCODE = 'check_violation';
  END IF;
  WITH latest AS (
    SELECT DISTINCT ON (e.campaign_id) e.campaign_id, e.run_id, e.event_kind, e.to_daily_cents
      FROM public.ad_allocation_events e
     WHERE e.tenant_id = NEW.tenant_id
     ORDER BY e.campaign_id, (e.run_id = NEW.run_id AND e.event_kind = 'planned') DESC, e.occurred_at DESC, e.id DESC)
  SELECT COALESCE(sum(CASE
           WHEN l.run_id = NEW.run_id AND l.event_kind = 'planned' THEN l.to_daily_cents
           WHEN c.status <> 'active' THEN 0
           WHEN l.event_kind IN ('planned','applied') THEN GREATEST(l.to_daily_cents, c.daily_budget_cents)
           WHEN l.event_kind = 'paused' THEN 0
           ELSE c.daily_budget_cents END), 0) INTO total
    FROM public.ad_campaigns c LEFT JOIN latest l ON l.campaign_id = c.id
   WHERE c.tenant_id = NEW.tenant_id;
  IF total > cap.daily_ceiling_cents THEN
    RAISE EXCEPTION 'AD_CAP_EXCEEDED: daily budgets would total % against the cap''s daily ceiling %', total, cap.daily_ceiling_cents
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION app.ad_allocation_cap_check() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.ad_allocation_cap_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ad_allocation_cap_check AFTER INSERT ON ad_allocation_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.ad_allocation_cap_check();

-- -----------------------------------------------------------------------------
-- 16. Documents (Phase 3): unreadable until a scan reports clean, retained, never moved (R-DOC-1..4)
-- -----------------------------------------------------------------------------
CREATE TABLE documents (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  deal_id             uuid,
  listing_id          uuid,
  contact_id          uuid,
  object_id           uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('purchase_contract','addendum','disclosure','inspection','appraisal',
                        'listing_agreement','other')),
  display_name        text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  version_no          integer NOT NULL DEFAULT 1 CHECK (version_no >= 1),
  supersedes_id       uuid,
  shared_to_portal    boolean NOT NULL DEFAULT false,
  scan_status         text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected')),
  uploaded_by_user_id uuid NOT NULL,
  retention_until     timestamptz,
  legal_hold          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, deal_id)             REFERENCES deals (tenant_id, id),
  FOREIGN KEY (tenant_id, listing_id)          REFERENCES listings (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)          REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,   -- refused while retained
  FOREIGN KEY (tenant_id, object_id)           REFERENCES stored_objects (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id)       REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK (num_nonnulls(deal_id, listing_id, contact_id) = 1),
  CHECK (NOT shared_to_portal OR (scan_status = 'clean' AND contact_id IS NULL))
);
CREATE TRIGGER documents_touch_updated_at BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Every upload starts quarantined and unshared; only the scan (the system) moves it out of 'pending', once;
-- legal hold and shortening retention are a human Owner's or Admin's (audited by the API); scope, object,
-- uploader and version never change (a new version is a new row through supersedes_id).
CREATE FUNCTION app.documents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE human_admin boolean := COALESCE(app.my_role(), '') IN ('owner','admin');
        sys boolean := COALESCE(app.actor_kind() = 'system', false);
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF current_user IN ('app_definer','app_retention') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.scan_status := 'pending';
    NEW.shared_to_portal := false;
    IF NEW.legal_hold AND NOT human_admin THEN
      RAISE EXCEPTION 'DOCUMENT_HOLD_OWNER_ADMIN: only an Owner or Admin places a legal hold' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.retention_until IS NOT NULL AND NOT (human_admin OR sys) THEN
      RAISE EXCEPTION 'DOCUMENT_RETENTION_OWNER_ADMIN' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.deal_id, NEW.listing_id, NEW.contact_id, NEW.object_id, NEW.uploaded_by_user_id, NEW.version_no, NEW.supersedes_id)
     IS DISTINCT FROM (OLD.deal_id, OLD.listing_id, OLD.contact_id, OLD.object_id, OLD.uploaded_by_user_id, OLD.version_no, OLD.supersedes_id) THEN
    RAISE EXCEPTION 'DOCUMENT_IMMUTABLE: a document keeps its scope, file and uploader; upload a new version' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status AND (NOT sys OR OLD.scan_status <> 'pending') THEN
    RAISE EXCEPTION 'DOCUMENT_SCAN_SYSTEM_ONLY: only the scan moves a document out of quarantine, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.legal_hold IS DISTINCT FROM OLD.legal_hold AND NOT human_admin THEN
    RAISE EXCEPTION 'DOCUMENT_HOLD_OWNER_ADMIN: only an Owner or Admin places or lifts a legal hold' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.retention_until IS DISTINCT FROM OLD.retention_until AND NOT human_admin
     AND NOT (sys AND NEW.retention_until IS NOT NULL AND (OLD.retention_until IS NULL OR NEW.retention_until > OLD.retention_until)) THEN
    RAISE EXCEPTION 'DOCUMENT_RETENTION_OWNER_ADMIN: only an Owner or Admin shortens retention' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_guard BEFORE INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION app.documents_guard();
-- erasure and purge refuse while a document is held or retained, whoever deletes, cascades included (R-DOC-4)
CREATE FUNCTION app.documents_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.legal_hold OR OLD.retention_until > now() THEN
    RAISE EXCEPTION 'DOCUMENT_RETAINED: this document is on legal hold or inside its retention period' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER documents_retained BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION app.documents_retained();

-- Erasure (R-DATA-7, R-DOC-4): refuses while a contact document is held or retained, and shreds the contact's
-- document objects with its recordings and media. Verbatim from 0001 otherwise.
CREATE OR REPLACE FUNCTION app.purge_contact_internal(p_tenant uuid, p_contact uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.documents d
              WHERE d.tenant_id = p_tenant AND d.contact_id = p_contact AND (d.legal_hold OR d.retention_until > now())) THEN
    RAISE EXCEPTION 'DOCUMENT_RETAINED: a document of this contact is on legal hold or inside its retention period'
      USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM public.behavior_events WHERE tenant_id = p_tenant AND contact_id = p_contact;
  DELETE FROM public.message_status_events s USING public.messages m
   WHERE s.tenant_id = p_tenant AND m.tenant_id = p_tenant AND s.message_id = m.id AND m.contact_id = p_contact;
  UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = now()
    FROM public.recordings r
   WHERE r.tenant_id = p_tenant AND r.contact_id = p_contact AND o.tenant_id = p_tenant AND o.id = r.object_id
     AND o.deleted_at IS NULL;
  UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = now()
    FROM public.message_media mm JOIN public.messages m ON m.tenant_id = mm.tenant_id AND m.id = mm.message_id
   WHERE m.tenant_id = p_tenant AND m.contact_id = p_contact AND o.tenant_id = p_tenant AND o.id = mm.object_id
     AND o.deleted_at IS NULL;
  UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = now()
    FROM public.documents d
   WHERE d.tenant_id = p_tenant AND d.contact_id = p_contact AND o.tenant_id = p_tenant AND o.id = d.object_id
     AND o.deleted_at IS NULL;
  DELETE FROM public.external_refs WHERE tenant_id = p_tenant AND entity_type = 'contact' AND entity_id = p_contact;
  DELETE FROM public.contacts WHERE tenant_id = p_tenant AND id = p_contact;   -- children cascade
END $$;
ALTER FUNCTION app.purge_contact_internal(uuid, uuid) OWNER TO app_retention;

-- The retention sweep skips contacts whose documents are still retained (R-DOC-4). Verbatim from 0001 otherwise.
CREATE OR REPLACE FUNCTION app.retention_sweep(p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rec record;
  n_contacts integer := 0; n_sessions integer; n_jobs integer; n_auth integer; n_notif integer;
  n_audit integer; n_rec integer; n_raw integer; n_ai integer; n_webhooks integer;
BEGIN
  DELETE FROM public.sessions WHERE COALESCE(revoked_at, absolute_expires_at) < p_now - interval '30 days';
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  DELETE FROM public.jobs WHERE (status = 'succeeded' AND finished_at < p_now - interval '14 days')
                             OR (status IN ('dead','cancelled') AND finished_at < p_now - interval '90 days');
  GET DIAGNOSTICS n_jobs = ROW_COUNT;
  DELETE FROM public.auth_events WHERE occurred_at < p_now - interval '1 year';
  GET DIAGNOSTICS n_auth = ROW_COUNT;
  DELETE FROM public.auth_attempts WHERE window_start < p_now - interval '1 day';
  DELETE FROM public.auth_tokens WHERE expires_at < p_now - interval '7 days';
  UPDATE public.webhook_events SET payload_enc = NULL WHERE payload_enc IS NOT NULL AND received_at < p_now - interval '30 days';
  GET DIAGNOSTICS n_webhooks = ROW_COUNT;
  DELETE FROM public.notifications WHERE created_at < p_now - interval '90 days';
  GET DIAGNOSTICS n_notif = ROW_COUNT;
  DELETE FROM public.audit_log WHERE occurred_at < p_now - interval '7 years';      -- VERIFY WITH COUNSEL
  GET DIAGNOSTICS n_audit = ROW_COUNT;
  UPDATE public.import_records SET raw_enc = NULL, raw_purged_at = p_now
   WHERE raw_enc IS NOT NULL AND created_at < p_now - interval '30 days';
  GET DIAGNOSTICS n_raw = ROW_COUNT;
  UPDATE public.ai_runs SET output_enc = NULL, output_purged_at = p_now
   WHERE output_enc IS NOT NULL AND created_at < p_now - interval '30 days';
  GET DIAGNOSTICS n_ai = ROW_COUNT;
  UPDATE public.lead_inquiries SET raw_payload_enc = NULL
   WHERE raw_payload_enc IS NOT NULL AND received_at < p_now - interval '90 days';
  UPDATE public.provider_credentials SET secret_enc = NULL, status = 'purged', purged_at = p_now
   WHERE status <> 'purged' AND purge_after IS NOT NULL AND purge_after <= p_now;
  -- recordings past retention (not on legal hold): shred DEK, transcript, transcript snippets
  UPDATE public.recordings SET status = 'shredded', shredded_at = p_now
   WHERE status IN ('stored','quarantined','pending_copy') AND NOT legal_hold AND retain_until <= p_now;
  GET DIAGNOSTICS n_rec = ROW_COUNT;
  UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = p_now
    FROM public.recordings r
   WHERE r.tenant_id = o.tenant_id AND r.object_id = o.id AND r.status = 'shredded' AND o.deleted_at IS NULL;
  UPDATE public.transcripts tr SET status = 'shredded', segments_enc = NULL
    FROM public.recordings r
   WHERE r.tenant_id = tr.tenant_id AND r.id = tr.recording_id AND r.status = 'shredded' AND tr.status <> 'shredded';
  UPDATE public.evidence_refs e SET snippet = NULL, snippet_enc = NULL, source_available = false
   WHERE e.source_type = 'call' AND e.source_available AND EXISTS (
         SELECT 1 FROM public.recordings r WHERE r.tenant_id = e.tenant_id AND r.call_id = e.source_id AND r.status = 'shredded');
  -- soft-deleted contacts past purge_after, not on any deal, with no document still held or retained
  FOR rec IN SELECT c.tenant_id, c.id FROM public.contacts c
              WHERE c.deleted_at IS NOT NULL AND c.purge_after <= p_now
                AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = c.id)
                AND NOT EXISTS (SELECT 1 FROM public.deal_contacts dc WHERE dc.tenant_id = c.tenant_id AND dc.contact_id = c.id)
                AND NOT EXISTS (SELECT 1 FROM public.documents dd WHERE dd.tenant_id = c.tenant_id AND dd.contact_id = c.id
                                   AND (dd.legal_hold OR dd.retention_until > p_now))
              ORDER BY c.purge_after LIMIT 500 LOOP
    PERFORM app.purge_contact_internal(rec.tenant_id, rec.id);
    n_contacts := n_contacts + 1;
  END LOOP;
  RETURN jsonb_build_object('sessions', n_sessions, 'jobs', n_jobs, 'auth_events', n_auth, 'notifications', n_notif,
                            'audit_log', n_audit, 'recordings_shredded', n_rec, 'import_raw_purged', n_raw,
                            'ai_outputs_purged', n_ai, 'webhook_payloads_purged', n_webhooks, 'contacts_purged', n_contacts);
END $$;
ALTER FUNCTION app.retention_sweep(timestamptz) OWNER TO app_retention;

-- -----------------------------------------------------------------------------
-- 17. Google Business Profile reviews (Phase 3) (R-GBP-1..2)
-- -----------------------------------------------------------------------------
CREATE TABLE gbp_reviews (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  connection_id      uuid NOT NULL,
  external_review_id text NOT NULL,
  rating             smallint CHECK (rating BETWEEN 1 AND 5),
  body               text CHECK (length(body) <= 5000),
  reviewer_display   text CHECK (length(reviewer_display) <= 120),
  reviewed_at        timestamptz NOT NULL,
  reply_status       text NOT NULL DEFAULT 'none' CHECK (reply_status IN ('none','drafted','replied')),
  reply_action_id    uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, connection_id, external_review_id),
  FOREIGN KEY (tenant_id, connection_id)   REFERENCES integration_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, reply_action_id) REFERENCES assistant_actions (tenant_id, id) ON DELETE SET NULL (reply_action_id)
);

-- -----------------------------------------------------------------------------
-- 18. Client portal (Phase 3): accounts, grants, published items (R-PORTAL-1..8)
--     Clients never read a staff table. They read three tables, and only what their own active grants reach,
--     on deals and listings they are a party to. Grants and items are bound to their deal/listing on insert
--     and never move.
-- -----------------------------------------------------------------------------
CREATE TABLE portal_accounts (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  contact_id         uuid NOT NULL,
  login_point_id     uuid NOT NULL,              -- one of THIS contact's emails/phones (magic link via dispatchOutbound)
  status             text NOT NULL CHECK (status IN ('invited','active','disabled')),
  invited_by_user_id uuid NOT NULL,
  activated_at       timestamptz,
  disabled_at        timestamptz,
  disabled_reason    text CHECK (disabled_reason ~ '^[A-Z][A-Z0-9_]*$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)                 REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id, login_point_id) REFERENCES contact_points (tenant_id, contact_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invited_by_user_id)         REFERENCES memberships (tenant_id, user_id),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL AND disabled_reason IS NOT NULL)),
  CHECK (status <> 'active' OR activated_at IS NOT NULL)
);
CREATE UNIQUE INDEX portal_accounts_one_live ON portal_accounts (tenant_id, contact_id) WHERE status <> 'disabled';
CREATE TRIGGER portal_accounts_touch_updated_at BEFORE UPDATE ON portal_accounts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE FUNCTION app.portal_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF app.principal_type() = 'client' THEN
    RAISE EXCEPTION 'CLIENT_READ_ONLY: a client principal never writes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' AND app.actor_kind() = 'user' AND NEW.invited_by_user_id IS DISTINCT FROM app.user_id() THEN
    RAISE EXCEPTION 'PORTAL_INVITER: a person invites, as themselves' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.contact_id, NEW.invited_by_user_id) IS DISTINCT FROM (OLD.contact_id, OLD.invited_by_user_id) THEN
      RAISE EXCEPTION 'PORTAL_ACCOUNT_IMMUTABLE: an account belongs to one contact' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'disabled' AND NEW.status <> 'disabled' THEN
      RAISE EXCEPTION 'PORTAL_ACCOUNT_DISABLED: a disabled account stays disabled; invite again' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.login_point_id IS DISTINCT FROM OLD.login_point_id) AND NOT EXISTS (
       SELECT 1 FROM public.contact_points p
        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.login_point_id AND p.contact_id = NEW.contact_id
          AND p.kind IN ('email','phone') AND p.removed_at IS NULL) THEN
    RAISE EXCEPTION 'PORTAL_LOGIN_POINT: the magic link goes to one of the client''s own current emails or phones'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_accounts_guard BEFORE INSERT OR UPDATE ON portal_accounts FOR EACH ROW EXECUTE FUNCTION app.portal_accounts_guard();

CREATE TABLE portal_grants (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  portal_account_id  uuid NOT NULL,
  deal_id            uuid,
  listing_id         uuid,
  granted_by_user_id uuid NOT NULL,
  granted_at         timestamptz NOT NULL,
  expires_at         timestamptz,                -- default: deal closed + 90 d, stored at close; only ever shortened
  revoked_at         timestamptz,
  revoked_by_user_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, portal_account_id)  REFERENCES portal_accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, deal_id)            REFERENCES deals (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, listing_id)         REFERENCES listings (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, granted_by_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK (num_nonnulls(deal_id, listing_id) = 1),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);
CREATE INDEX portal_grants_account_idx ON portal_grants (tenant_id, portal_account_id) WHERE revoked_at IS NULL;

-- Is the account's contact a party to the deal (its primary contact, or a buyer/seller/co-buyer/co-seller) or
-- to the listing (a seller/co-seller)? Definer: clients, and most staff, cannot read the party tables. It is
-- checked when a grant is made and again on every client read, so removing a co-buyer hides everything at once.
CREATE FUNCTION app.portal_party_ok(p_tenant uuid, p_account uuid, p_deal uuid, p_listing uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (
    SELECT 1 FROM public.portal_accounts a
     WHERE a.tenant_id = p_tenant AND a.id = p_account
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
GRANT EXECUTE ON FUNCTION app.portal_party_ok(uuid, uuid, uuid, uuid) TO app_user;

-- A grant names a party's own deal or listing; once made it never moves; revocation is final and done by the
-- person revoking, as themselves; expiry is only ever brought forward.
CREATE FUNCTION app.portal_grants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF app.principal_type() = 'client' THEN
    RAISE EXCEPTION 'CLIENT_READ_ONLY: a client principal never writes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT app.portal_party_ok(NEW.tenant_id, NEW.portal_account_id, NEW.deal_id, NEW.listing_id) THEN
      RAISE EXCEPTION 'PORTAL_NOT_A_PARTY: a client sees only a deal or listing they are a party to' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.portal_account_id, NEW.deal_id, NEW.listing_id, NEW.granted_by_user_id, NEW.granted_at)
     IS DISTINCT FROM (OLD.portal_account_id, OLD.deal_id, OLD.listing_id, OLD.granted_by_user_id, OLD.granted_at) THEN
    RAISE EXCEPTION 'PORTAL_GRANT_IMMUTABLE: a grant never moves to another account, deal or listing' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by_user_id) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by_user_id) THEN
    RAISE EXCEPTION 'PORTAL_GRANT_REVOKED: a revoked grant stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND (app.actor_kind() IS DISTINCT FROM 'user' OR NEW.revoked_by_user_id IS DISTINCT FROM app.user_id()) THEN
    RAISE EXCEPTION 'PORTAL_REVOKER: a person revokes, as themselves' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.expires_at IS NOT NULL AND (NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at) THEN
    RAISE EXCEPTION 'PORTAL_GRANT_EXPIRY: expiry is only ever brought forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_grants_guard BEFORE INSERT OR UPDATE ON portal_grants FOR EACH ROW EXECUTE FUNCTION app.portal_grants_guard();

-- A published COPY of what a person shared or confirmed; never a live join to staff rows.
CREATE TABLE portal_items (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL,
  grant_id             uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('milestone','document','showing','feedback','seller_update','next_step')),
  title                text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  body                 text CHECK (length(body) <= 4000),
  occurs_on            date,
  document_id          uuid,
  source_type          text NOT NULL CHECK (source_type IN ('deal_date','document','showing','showing_feedback','assistant_action','task')),
  source_id            uuid NOT NULL,
  source_version       integer NOT NULL DEFAULT 1,
  published_by_kind    text NOT NULL CHECK (published_by_kind IN ('user','system')),
  published_by_user_id uuid,
  published_at         timestamptz NOT NULL,
  retracted_at         timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, grant_id, source_type, source_id, source_version),
  FOREIGN KEY (tenant_id, grant_id)             REFERENCES portal_grants (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id)          REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, published_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((published_by_kind = 'user') = (published_by_user_id IS NOT NULL)),
  CHECK ((kind = 'document') = (document_id IS NOT NULL)),
  CHECK (document_id IS NULL OR document_id = source_id),
  CHECK ((kind, source_type) IN (('milestone','deal_date'), ('document','document'), ('showing','showing'),
                                 ('feedback','showing_feedback'), ('seller_update','assistant_action'), ('next_step','task'))),
  CHECK (kind NOT IN ('feedback','seller_update') OR published_by_kind = 'user')   -- never rule-published
);
CREATE INDEX portal_items_grant_idx ON portal_items (tenant_id, grant_id, published_at) WHERE retracted_at IS NULL;

-- An item copies a source that belongs to its grant's own deal or listing (a confirmed milestone of the deal,
-- a clean shared document of it, a showing or its feedback on its listing or attended by the client, the
-- listing's approved seller update, a task of the deal or listing), visible to the publisher. Once published
-- only its retraction may be written, once.
CREATE FUNCTION app.portal_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g record; ok boolean;
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
    IF OLD.retracted_at IS NOT NULL AND NEW.retracted_at IS DISTINCT FROM OLD.retracted_at THEN
      RAISE EXCEPTION 'PORTAL_ITEM_RETRACTED: a retraction is final' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
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
             AND (s.listing_id = g.listing_id OR s.listing_id = g.deal_listing_id OR s.buyer_contact_id = g.contact_id))
    WHEN 'showing_feedback' THEN EXISTS (SELECT 1 FROM public.showing_feedback f
           JOIN public.showings s ON s.tenant_id = f.tenant_id AND s.id = f.showing_id
           WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.source_id
             AND (s.listing_id = g.listing_id OR s.listing_id = g.deal_listing_id OR s.buyer_contact_id = g.contact_id))
    WHEN 'assistant_action' THEN EXISTS (SELECT 1 FROM public.assistant_actions aa
           WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.source_id AND aa.kind = 'seller_update_draft'
             AND aa.status IN ('approved','executed')
             AND aa.trigger_ref->>'listing_id' IN (g.listing_id::text, g.deal_listing_id::text))
    WHEN 'task' THEN EXISTS (SELECT 1 FROM public.tasks t
           WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.source_id
             AND (t.deal_id = g.deal_id OR t.listing_id = g.listing_id))
  END;
  IF NOT COALESCE(ok, false) THEN
    RAISE EXCEPTION 'PORTAL_SOURCE_NOT_IN_GRANT: an item copies only a shareable source of the grant''s own deal or listing'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_items_guard BEFORE INSERT OR UPDATE ON portal_items FOR EACH ROW EXECUTE FUNCTION app.portal_items_guard();

-- -----------------------------------------------------------------------------
-- 19. Row-level security for every new tenant table
-- -----------------------------------------------------------------------------
-- Layer 1, staff only: the same policy text 0001 generated, for every new staff table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections','user_calendar_links','webchat_sessions','marketing_pieces',
     'marketing_piece_assets','lead_source_costs','call_scores','voice_tool_calls','property_records','contact_predictions',
     'ad_campaigns','ad_budget_caps','ad_allocation_events','documents','gbp_reviews'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
  END LOOP;
  -- Layer 1 for the three client-readable tables (the explicit allowlist): staff OR client, and a client
  -- may never write (client_read_only_*).
  FOREACH t IN ARRAY ARRAY['portal_accounts','portal_grants','portal_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) IN ('staff','client'))
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY client_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY client_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY client_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
  END LOOP;
END $$;

-- integration_connections: members read status and capabilities (secrets live in provider_credentials);
-- Owner/Admin and the system write (the guard above decides which columns).
CREATE POLICY connections_read ON integration_connections FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY connections_write ON integration_connections FOR INSERT WITH CHECK ((SELECT app.is_tenant_wide()));
CREATE POLICY connections_update ON integration_connections FOR UPDATE
  USING ((SELECT app.is_tenant_wide())) WITH CHECK ((SELECT app.is_tenant_wide()));

-- user_calendar_links: self and the system only. Owner/Admin see nothing (R-CAL-1).
CREATE POLICY calendar_links_self ON user_calendar_links FOR ALL
  USING (((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
         OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())))
  WITH CHECK (((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
              OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));

-- webchat_sessions: the system writes; staff read a session only once it is linked to a contact they may
-- see in detail.
CREATE POLICY webchat_system ON webchat_sessions FOR ALL
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));
CREATE POLICY webchat_staff_read ON webchat_sessions FOR SELECT
  USING (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id));

-- marketing_pieces and their assets: members read (like listings); listing writers draft and approve; the
-- system publishes, exports and retracts.
CREATE POLICY marketing_read ON marketing_pieces FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY marketing_insert ON marketing_pieces FOR INSERT WITH CHECK (app.listing_writable(tenant_id, listing_id));
CREATE POLICY marketing_update ON marketing_pieces FOR UPDATE
  USING (app.listing_writable(tenant_id, listing_id)) WITH CHECK (app.listing_writable(tenant_id, listing_id));
CREATE POLICY marketing_assets_read ON marketing_piece_assets FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY marketing_assets_write ON marketing_piece_assets FOR ALL
  USING (EXISTS (SELECT 1 FROM marketing_pieces mp WHERE mp.tenant_id = marketing_piece_assets.tenant_id
                   AND mp.id = marketing_piece_assets.piece_id AND app.listing_writable(mp.tenant_id, mp.listing_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM marketing_pieces mp WHERE mp.tenant_id = marketing_piece_assets.tenant_id
                        AND mp.id = marketing_piece_assets.piece_id AND app.listing_writable(mp.tenant_id, mp.listing_id)));

-- stored_objects (Phase 1 table): a marketing asset on a piece is readable like the piece; a document's
-- object is readable like the document, and only once it scanned clean (R-DOC-3).
CREATE POLICY objects_marketing_assets ON stored_objects FOR SELECT USING (
  EXISTS (SELECT 1 FROM marketing_piece_assets a WHERE a.tenant_id = stored_objects.tenant_id AND a.object_id = stored_objects.id));
CREATE POLICY objects_documents ON stored_objects FOR SELECT USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id = stored_objects.tenant_id AND d.object_id = stored_objects.id
            AND d.scan_status = 'clean'));

-- lead_source_costs: human Owner/Admin read every row and write manual rows as themselves; the system reads
-- and writes only ads_sync rows (R-OWNER-5).
CREATE POLICY costs_owner_admin ON lead_source_costs FOR ALL
  USING ((SELECT app.my_role()) IN ('owner','admin'))
  WITH CHECK ((SELECT app.my_role()) IN ('owner','admin') AND origin = 'manual' AND entered_by_user_id = (SELECT app.user_id()));
CREATE POLICY costs_system_ads_sync ON lead_source_costs FOR ALL
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()) AND origin = 'ads_sync')
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()) AND origin = 'ads_sync');

-- call_scores: the agent on the call, Owner/Admin, or their TL only when the Owner turned tl_sees_call_scores
-- on; AND the recording must be playable by the caller (recording-scope RLS inside the EXISTS) (R-COACH-3).
CREATE POLICY call_scores_select ON call_scores FOR SELECT USING (
  app.contact_detail_visible(tenant_id, contact_id)
  AND ((SELECT app.is_tenant_wide())
       OR ((SELECT app.actor_kind()) = 'user' AND agent_user_id = (SELECT app.user_id()))
       OR ((SELECT app.my_role()) = 'team_lead' AND agent_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
           AND EXISTS (SELECT 1 FROM tenant_settings s WHERE s.tenant_id = call_scores.tenant_id AND s.tl_sees_call_scores))));
CREATE POLICY call_scores_recording_scope ON call_scores AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM recordings r WHERE r.tenant_id = call_scores.tenant_id AND r.call_id = call_scores.call_id));
CREATE POLICY call_scores_write ON call_scores FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));

-- voice_tool_calls: whoever sees the call; written by the system.
CREATE POLICY voice_tools_select ON voice_tool_calls FOR SELECT USING (
  EXISTS (SELECT 1 FROM calls c WHERE c.tenant_id = voice_tool_calls.tenant_id AND c.id = voice_tool_calls.call_id));
CREATE POLICY voice_tools_insert ON voice_tool_calls FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));

-- prediction: contact detail visibility; a withdrawn model hides its scores, and the feed cards made from
-- them, at once (R-PRED-5).
CREATE POLICY property_records_select ON property_records FOR SELECT USING (app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY property_records_write ON property_records FOR ALL
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));
CREATE POLICY predictions_select ON contact_predictions FOR SELECT USING (
  app.contact_detail_visible(tenant_id, contact_id)
  AND EXISTS (SELECT 1 FROM prediction_models m WHERE m.version = contact_predictions.model_version AND m.status = 'approved'));
CREATE POLICY predictions_write ON contact_predictions FOR ALL
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));
CREATE POLICY likely_to_move_model_live ON priority_feed_items AS RESTRICTIVE FOR SELECT USING (
  item_type <> 'likely_to_move' OR EXISTS (
    SELECT 1 FROM contact_predictions p
     WHERE p.tenant_id = priority_feed_items.tenant_id AND p.contact_id = priority_feed_items.contact_id
       AND p.band IN ('likely_90d','watch')
       AND EXISTS (SELECT 1 FROM prediction_models m WHERE m.version = p.model_version AND m.status = 'approved')));

-- ads: human Owner/Admin and the system. Team Leads and agents see nothing.
CREATE POLICY ad_campaigns_all ON ad_campaigns FOR ALL
  USING ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())))
  WITH CHECK ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY ad_caps_select ON ad_budget_caps FOR SELECT
  USING ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY ad_caps_insert ON ad_budget_caps FOR INSERT
  WITH CHECK ((SELECT app.my_role()) = 'owner' AND approved_by_user_id = (SELECT app.user_id()));
CREATE POLICY ad_events_select ON ad_allocation_events FOR SELECT
  USING ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY ad_events_insert ON ad_allocation_events FOR INSERT
  WITH CHECK ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));

-- documents: the scope's visibility. A listing document (a listing agreement carries commission terms and
-- seller PII) is for the listing's writers and the members of a listing-side deal on it, not every member
-- (R-DOC-1, R-PERM-10). RESTRICTIVE: unreadable until clean, except to the uploader and tenant-wide roles (R-DOC-3).
CREATE POLICY documents_select ON documents FOR SELECT USING (
  (deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id))
  OR (listing_id IS NOT NULL AND (app.listing_writable(tenant_id, listing_id)
       OR EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = documents.tenant_id AND d.listing_id = documents.listing_id
                    AND d.side IN ('sell','dual'))))
  OR (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id)));
CREATE POLICY documents_write ON documents FOR INSERT WITH CHECK (
  ((deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id))
   OR (listing_id IS NOT NULL AND app.listing_writable(tenant_id, listing_id))
   OR (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id)))
  AND (((SELECT app.actor_kind()) = 'user' AND uploaded_by_user_id = (SELECT app.user_id())) OR (SELECT app.is_tenant_wide())));
CREATE POLICY documents_update ON documents FOR UPDATE
  USING ((deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id))
         OR (listing_id IS NOT NULL AND app.listing_writable(tenant_id, listing_id))
         OR (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id)))
  WITH CHECK ((deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id))
              OR (listing_id IS NOT NULL AND app.listing_writable(tenant_id, listing_id))
              OR (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id)));
CREATE POLICY documents_clean_only ON documents AS RESTRICTIVE FOR SELECT USING (
  scan_status = 'clean' OR (SELECT app.is_tenant_wide())
  OR ((SELECT app.actor_kind()) = 'user' AND uploaded_by_user_id = (SELECT app.user_id())));

-- gbp_reviews: members read; the system writes.
CREATE POLICY gbp_reviews_read ON gbp_reviews FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY gbp_reviews_write ON gbp_reviews FOR ALL
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));

-- portal_accounts. Staff: whoever sees the contact in detail. Client: its own active account.
CREATE POLICY portal_accounts_staff ON portal_accounts FOR ALL
  USING ((SELECT app.principal_type()) = 'staff' AND app.contact_detail_visible(tenant_id, contact_id))
  WITH CHECK ((SELECT app.principal_type()) = 'staff' AND app.contact_detail_visible(tenant_id, contact_id)
              AND ((SELECT app.is_tenant_wide()) OR (SELECT app.my_role()) IS NOT NULL));
CREATE POLICY portal_accounts_client ON portal_accounts FOR SELECT
  USING ((SELECT app.principal_type()) = 'client' AND id = (SELECT app.portal_account_id()) AND status = 'active');

-- portal_grants. Staff: deal visible / listing member to read, deal or listing writable to grant or revoke.
-- Client: its own grants, unrevoked and unexpired (evaluated against now(), so a lapse is immediate), of an
-- account the client can see (active), on a deal or listing the account's contact is still a party to.
CREATE POLICY portal_grants_staff_read ON portal_grants FOR SELECT
  USING ((SELECT app.principal_type()) = 'staff'
         AND ((deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id)) OR (listing_id IS NOT NULL AND (SELECT app.is_member()))));
CREATE POLICY portal_grants_staff_insert ON portal_grants FOR INSERT
  WITH CHECK ((SELECT app.principal_type()) = 'staff' AND granted_by_user_id = (SELECT app.user_id())
              AND ((deal_id IS NOT NULL AND app.deal_writable(tenant_id, deal_id))
                   OR (listing_id IS NOT NULL AND app.listing_writable(tenant_id, listing_id))));
CREATE POLICY portal_grants_staff_update ON portal_grants FOR UPDATE
  USING ((SELECT app.principal_type()) = 'staff'
         AND ((deal_id IS NOT NULL AND app.deal_writable(tenant_id, deal_id))
              OR (listing_id IS NOT NULL AND app.listing_writable(tenant_id, listing_id)) OR (SELECT app.is_tenant_wide())))
  WITH CHECK ((SELECT app.principal_type()) = 'staff');
CREATE POLICY portal_grants_client ON portal_grants FOR SELECT
  USING ((SELECT app.principal_type()) = 'client' AND portal_account_id = (SELECT app.portal_account_id())
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
         AND EXISTS (SELECT 1 FROM portal_accounts a WHERE a.tenant_id = portal_grants.tenant_id AND a.id = portal_grants.portal_account_id)
         AND app.portal_party_ok(tenant_id, portal_account_id, deal_id, listing_id));

-- portal_items. Staff: through a grant they can see; the system publishes, staff with write access to the
-- deal/listing publish and retract. Client: unretracted items of a grant it can see (the subquery runs
-- under the client's own policies above).
CREATE POLICY portal_items_staff_read ON portal_items FOR SELECT
  USING ((SELECT app.principal_type()) = 'staff'
         AND EXISTS (SELECT 1 FROM portal_grants g WHERE g.tenant_id = portal_items.tenant_id AND g.id = portal_items.grant_id));
CREATE POLICY portal_items_staff_write ON portal_items FOR INSERT
  WITH CHECK ((SELECT app.principal_type()) = 'staff'
              AND (((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()) AND published_by_kind = 'system')
                   OR (published_by_kind = 'user' AND published_by_user_id = (SELECT app.user_id())
                       AND EXISTS (SELECT 1 FROM portal_grants g WHERE g.tenant_id = portal_items.tenant_id AND g.id = portal_items.grant_id
                                     AND ((g.deal_id IS NOT NULL AND app.deal_writable(g.tenant_id, g.deal_id))
                                          OR (g.listing_id IS NOT NULL AND app.listing_writable(g.tenant_id, g.listing_id)))))));
CREATE POLICY portal_items_staff_retract ON portal_items FOR UPDATE
  USING ((SELECT app.principal_type()) = 'staff' AND ((SELECT app.is_tenant_wide())
         OR EXISTS (SELECT 1 FROM portal_grants g WHERE g.tenant_id = portal_items.tenant_id AND g.id = portal_items.grant_id
                      AND ((g.deal_id IS NOT NULL AND app.deal_writable(g.tenant_id, g.deal_id))
                           OR (g.listing_id IS NOT NULL AND app.listing_writable(g.tenant_id, g.listing_id))))))
  WITH CHECK ((SELECT app.principal_type()) = 'staff');
CREATE POLICY portal_items_client ON portal_items FOR SELECT
  USING ((SELECT app.principal_type()) = 'client' AND retracted_at IS NULL
         AND grant_id IN (SELECT g.id FROM portal_grants g WHERE g.tenant_id = portal_items.tenant_id));

-- -----------------------------------------------------------------------------
-- 20. Grants (least privilege, as 0001 §20)
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections','user_calendar_links','webchat_sessions','marketing_pieces',
     'lead_source_costs','call_scores','property_records','contact_predictions','ad_campaigns','documents',
     'gbp_reviews','portal_accounts','portal_grants','portal_items'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO app_user', t);
  END LOOP;
  -- a draft piece's images are genuinely removed
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_piece_assets TO app_user;
  FOREACH t IN ARRAY ARRAY['voice_tool_calls','ad_budget_caps','ad_allocation_events'] LOOP
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO app_user', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['integration_connections','user_calendar_links','webchat_sessions','marketing_pieces',
     'marketing_piece_assets','lead_source_costs','call_scores','voice_tool_calls','property_records','contact_predictions',
     'ad_campaigns','ad_budget_caps','ad_allocation_events','documents','gbp_reviews','portal_accounts','portal_grants',
     'portal_items'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO app_definer', t);
    EXECUTE format('GRANT SELECT, UPDATE, DELETE ON public.%I TO app_retention', t);
  END LOOP;
END $$;
GRANT SELECT, UPDATE, DELETE ON prediction_models TO app_retention;
-- app.contacts_dnc_follow_merge writes only the person-level opt-out of the merge survivor
GRANT UPDATE (do_not_contact_at, do_not_contact_event_id) ON contacts TO app_definer;

-- -----------------------------------------------------------------------------
-- 21. Self-check: the client allowlist is exactly the three portal tables (R-PORTAL-1)
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation'
     AND pg_get_expr(p.polqual, p.polrelid) LIKE '%client%'
     AND c.relname NOT IN ('portal_accounts','portal_grants','portal_items');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED: client principal admitted outside the portal allowlist: %', bad;
  END IF;
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND NOT p.polpermissive
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT IN ('portal_accounts','portal_grants','portal_items')
     AND (pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%principal_type() AS principal_type) = ''staff''::text)%'
          OR pg_get_expr(p.polqual, p.polrelid) LIKE '%client%');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED: staff-only Layer 1 missing on: %', bad;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- R-PERM-11 (0016_rule_coverage.sql): support actors are read-only on every table, including through
-- SECURITY DEFINER functions. 0016 attached the statement-level support_read_only trigger to every table
-- that existed then; this migration's new tables get it here. Idempotent: only tables still lacking it.
-- -----------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
              AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only')
            ORDER BY c.relname LOOP
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', r.relname);
  END LOOP;
END $$;
