-- =============================================================================
-- 0019: Owner decision D2 (2026-11-11): the Phase 2-3 scope change, and Gmail inbox sync.
--       docs/PHASE2_3_PLAN.md §2.2 (D2), §3, modules 29, 56, 57; docs/DATA_MODEL.md Part 2 (§6.3, R-GMAIL-1..14,
--       R-MKT-12, E162-E188); docs/ARCHITECTURE.md §20 (D2 entry) and §21.7.
--
-- Design-first, like 0018: written before modules 56 (api/mail-sync) and 57 (web/mail-sync), and before module
-- 29 publishes anything. 0001-0018 are not edited. Every change here only ADDS: 0018's Messenger/Instagram/Meta
-- enum values, CHECKs, guard branches and the platform:meta pack stay until one reviewed cleanup migration after
-- the running lanes merge (PHASE2_3_PLAN §3, "later cleanup"), because those lanes' code and tests still name them.
--
-- What D2 needs from the schema:
--   * Meta is for content publishing only: publishing-only connection kinds (facebook_page, instagram_business)
--     that, unlike 0018's inbound DM kinds, need no lead source; and one row per post that went (or tried to go)
--     live on a Page, an Instagram business account or a GBP location (marketing_publications), so the product
--     says "published" only for a post the provider confirmed, and knows what to take down.
--   * Gmail inbox sync (new): the agent's own read-only mailbox link (user_mail_links), the synced copies of
--     their client mail (mail_messages), the threads they removed (mail_thread_exclusions), the Owner's switch and
--     backfill window (tenant_settings), the platform:gmail clearance pack, the RFC Message-ID of inbound platform
--     email (dedupe), and a new evidence source type.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * new SECURITY DEFINER function, owned by app_definer with a pinned search_path:
--       app.mail_sync_live(tenant, link, thread)  boolean: Gmail sync is on and cleared, the link is live, its user
--                                                 an active member, and the thread not excluded. Used by the
--                                                 RESTRICTIVE policy on mail_messages (readers cannot see other
--                                                 users' links or exclusions) and by the insert guard.
--   * a per-user OAuth table holding one field-encrypted refresh token (self and system only; Owner/Admin see
--     nothing; a revoked link holds no token, by CHECK).
--   * a table of copies of agents' mailbox content: written and deleted only by the system; read like the contact's
--     timeline (plus the mailbox owner); never by a support actor (Google API user-data policy, VERIFY) and never by
--     a client principal (staff-only Layer 1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Platform clearance pack for Gmail sync (R-INT-6, R-GMAIL-1). Ships unreviewed, like 0018's seven packs.
--    platform:meta now gates nothing in the product (D2): its notes say so, so counsel never clears it by mistake.
-- -----------------------------------------------------------------------------
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:gmail', '2026.11.0', 'published', '{"poll_interval_seconds": 120, "backfill_max_messages": 5000}', NULL,
   'Gmail inbox sync (C14, N19). vendor_ready_at is set once Google OAuth verification of the restricted gmail.readonly '
   'scope and its security assessment have passed (VERIFY current requirements). Engineering placeholder. VERIFY WITH COUNSEL.');
UPDATE jurisdiction_packs
   SET notes = 'Messenger and Instagram DMs: OUT OF SCOPE (owner decision D2, 2026-11-11). Do not clear: this pack only '
               'gates DM sending in the 0018 guard, which no product path writes. Removed with the Meta enum cleanup '
               '(PHASE2_3_PLAN §3).'
 WHERE key = 'platform:meta' AND status = 'published';

-- -----------------------------------------------------------------------------
-- 2. Meta is for content publishing only (D2). New publishing kinds; 0018's DM, lead-ads and Meta-ads kinds stay
--    in the CHECK until the cleanup, and the integrations API (module 21) never offers them.
-- -----------------------------------------------------------------------------
ALTER TABLE integration_connections DROP CONSTRAINT integration_connections_kind_check;
ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_kind_check CHECK (kind IN (
  'messenger_page','instagram_account','web_chat_widget','lead_email','zillow_feed','realtor_feed','meta_lead_ads','mls_feed',
  'showing_service','ads_meta','ads_google','gbp_location',
  'facebook_page','instagram_business'));           -- D2: publishing only, never an inbound channel (no lead source)

-- One row per publication of an approved piece version to one external account (R-MKT-12). Written through
-- module 29's single publishPost path: TX1 'publishing' (a person, as themselves) -> provider -> TX2 'published'
-- with the provider's post id, 'failed', or 'unknown' (reconciled, never re-posted blindly).
CREATE TABLE marketing_publications (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL,
  piece_id             uuid NOT NULL,
  connection_id        uuid NOT NULL,
  status               text NOT NULL DEFAULT 'publishing'
                       CHECK (status IN ('publishing','published','failed','unknown','retracted')),
  external_post_id     text CHECK (length(external_post_id) BETWEEN 1 AND 200),
  error_code           text CHECK (error_code ~ '^[A-Z][A-Z0-9_]*$'),
  requested_by_user_id uuid NOT NULL,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  published_at         timestamptz,
  retracted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, piece_id)             REFERENCES marketing_pieces (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id)        REFERENCES integration_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by_user_id) REFERENCES memberships (tenant_id, user_id),
  -- "published" only with the provider's own post id (R-MKT-6: never claim a post went live unverified)
  CHECK ((status = 'published') <= (external_post_id IS NOT NULL AND published_at IS NOT NULL)),
  CHECK ((status = 'retracted') = (retracted_at IS NOT NULL)),
  CHECK (status <> 'retracted' OR external_post_id IS NOT NULL),
  CHECK ((status = 'failed') <= (error_code IS NOT NULL))
);
-- one live publication per piece version and target
CREATE UNIQUE INDEX marketing_publications_one_live ON marketing_publications (tenant_id, piece_id, connection_id)
  WHERE status IN ('publishing','published','unknown');
CREATE INDEX marketing_publications_piece_idx ON marketing_publications (tenant_id, piece_id);
CREATE TRIGGER marketing_publications_touch_updated_at BEFORE UPDATE ON marketing_publications
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A publication is a person's tap on an approved social or GBP post, to a connected account of the matching kind,
-- once counsel cleared platform:fair_housing; it never moves to another piece or account; it only moves forward;
-- the provider's post id is written once.
CREATE FUNCTION app.marketing_publications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'publishing' THEN
      RAISE EXCEPTION 'PUBLICATION_BORN_PUBLISHING: a publication starts as an attempt' USING ERRCODE = 'check_violation';
    END IF;
    IF app.actor_kind() IS DISTINCT FROM 'user' OR NEW.requested_by_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'PUBLICATION_HUMAN_TAP: a person publishes, as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.marketing_pieces mp
                     JOIN public.integration_connections ic ON ic.tenant_id = mp.tenant_id AND ic.id = NEW.connection_id
                    WHERE mp.tenant_id = NEW.tenant_id AND mp.id = NEW.piece_id AND mp.status IN ('approved','published')
                      AND ((mp.kind = 'social_post' AND ic.kind IN ('facebook_page','instagram_business'))
                           OR (mp.kind = 'gbp_post' AND ic.kind = 'gbp_location'))) THEN
      RAISE EXCEPTION 'PUBLISH_TARGET_INVALID: an approved social post goes to a Facebook Page or Instagram business account, a GBP post to a GBP location'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.integration_connections ic
                    WHERE ic.tenant_id = NEW.tenant_id AND ic.id = NEW.connection_id AND ic.status IN ('connected','degraded')) THEN
      RAISE EXCEPTION 'CHANNEL_NOT_CONNECTED: publish only to a connected account; export otherwise' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.platform_cleared('platform:fair_housing') THEN
      RAISE EXCEPTION 'PLATFORM_NOT_CLEARED: publishing waits for counsel review of the platform:fair_housing pack'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.piece_id, NEW.connection_id, NEW.requested_by_user_id, NEW.requested_at)
     IS DISTINCT FROM (OLD.piece_id, OLD.connection_id, OLD.requested_by_user_id, OLD.requested_at) THEN
    RAISE EXCEPTION 'PUBLICATION_IMMUTABLE: a publication keeps its piece, account and requester' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.external_post_id IS NOT NULL AND NEW.external_post_id IS DISTINCT FROM OLD.external_post_id THEN
    RAISE EXCEPTION 'PUBLICATION_POST_ID_FINAL: the provider''s post id is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'publishing' AND NEW.status IN ('published','failed','unknown'))
    OR (OLD.status = 'unknown' AND NEW.status IN ('published','failed'))
    OR (OLD.status = 'published' AND NEW.status = 'retracted')) THEN
    RAISE EXCEPTION 'PUBLICATION_FORWARD_ONLY: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_publications_guard BEFORE INSERT OR UPDATE ON marketing_publications
  FOR EACH ROW EXECUTE FUNCTION app.marketing_publications_guard();

-- -----------------------------------------------------------------------------
-- 3. Gmail inbox sync (R-GMAIL-1..14). Read-only, per user, dark until platform:gmail is cleared and the Owner
--    turns it on. Synced mail is never a channel: nothing is ever sent through it (no messages rows, no guard).
-- -----------------------------------------------------------------------------
-- The Owner's switch and the backfill window. Owner-only to turn on (and only once platform:gmail is cleared,
-- vendor check included) and to change the window; turning it off stays open to Admins, as for voice (R-GMAIL-1).
ALTER TABLE tenant_settings
  ADD COLUMN mail_sync_enabled  boolean  NOT NULL DEFAULT false,
  ADD COLUMN mail_backfill_days smallint NOT NULL DEFAULT 30 CHECK (mail_backfill_days BETWEEN 0 AND 90);   -- VERIFY WITH COUNSEL
CREATE FUNCTION app.tenant_settings_mail_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.mail_sync_enabled THEN
      RAISE EXCEPTION 'MAIL_SYNC_STARTS_OFF: Gmail sync starts off; the Owner turns it on' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user IN ('app_definer','app_retention') THEN RETURN NEW; END IF;
  IF NEW.mail_sync_enabled AND NOT OLD.mail_sync_enabled THEN
    IF COALESCE(app.my_role(), '') <> 'owner' THEN
      RAISE EXCEPTION 'OWNER_ONLY_MAIL_SYNC: only the Owner turns Gmail sync on' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.platform_cleared('platform:gmail', true) THEN
      RAISE EXCEPTION 'MAIL_SYNC_NOT_CLEARED: Gmail sync waits for counsel review and Google''s verification (platform:gmail)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.mail_backfill_days IS DISTINCT FROM OLD.mail_backfill_days AND COALESCE(app.my_role(), '') <> 'owner' THEN
    RAISE EXCEPTION 'OWNER_ONLY_MAIL_SYNC: only the Owner sets the Gmail backfill window' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings_mail_guard BEFORE INSERT OR UPDATE OF mail_sync_enabled, mail_backfill_days ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION app.tenant_settings_mail_guard();

-- The agent's own mailbox (users/me), linked by the OAuth callback (the system actor) after it read the mailbox
-- profile. Only the refresh token is kept, field-encrypted (tenant field key, AAD bound to the row); access tokens
-- live in memory for one sync pass (R-GMAIL-4). Self and system only: Owner/Admin see nothing, like calendar links.
CREATE TABLE user_mail_links (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  id                    uuid NOT NULL,
  user_id               uuid NOT NULL,
  provider              text NOT NULL CHECK (provider IN ('gmail')),
  mailbox_address       text NOT NULL CHECK (mailbox_address = lower(mailbox_address) AND length(mailbox_address) <= 320
                                             AND mailbox_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- read-only, nothing else: a token that grants more is refused by the callback and cannot be stored (R-GMAIL-3; VERIFY)
  scopes                text[] NOT NULL CHECK (scopes = ARRAY['https://www.googleapis.com/auth/gmail.readonly']::text[]),
  disclosure_sha256     text NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),   -- the connect text the agent accepted
  status                text NOT NULL CHECK (status IN ('connected','degraded','revoked')),
  refresh_enc           bytea,
  key_version           integer,
  history_id            text CHECK (history_id ~ '^[0-9]{1,20}$'),       -- Gmail history cursor (R-GMAIL-10)
  connected_at          timestamptz NOT NULL,      -- mail that reached the mailbox at or after this is live (R-GMAIL-8)
  next_sync_at          timestamptz,               -- stored instant, woken by module 56's reconcile handler (R-OWN-27)
  last_synced_at        timestamptz,
  backfill_requested_at timestamptz,
  backfill_page_token   text CHECK (length(backfill_page_token) BETWEEN 1 AND 512),
  backfill_done_at      timestamptz,
  last_error_code       text CHECK (last_error_code ~ '^[A-Z][A-Z0-9_]*$'),
  revoked_at            timestamptz,
  revoke_reason         text CHECK (revoke_reason IN ('USER_DISCONNECTED','MEMBER_INACTIVE','SYNC_TURNED_OFF',
                                                      'PLATFORM_NOT_CLEARED','PROVIDER_REVOKED')),
  purge_after           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoke_reason IS NOT NULL)),
  -- a live link holds its encrypted refresh token; a revoked one holds none, and is purged later (R-GMAIL-13)
  CHECK (status = 'revoked' OR (refresh_enc IS NOT NULL AND key_version IS NOT NULL)),
  CHECK (status <> 'revoked' OR (refresh_enc IS NULL AND backfill_page_token IS NULL AND purge_after IS NOT NULL))
);
CREATE UNIQUE INDEX user_mail_links_one_live ON user_mail_links (tenant_id, user_id, provider) WHERE status <> 'revoked';
-- a mailbox is live in at most ONE link across all tenants: a shared login, a second teammate or a second
-- workspace cannot link it again (R-GMAIL-2; a cross-tenant index, like phone numbers and external accounts)
CREATE UNIQUE INDEX user_mail_links_live_mailbox ON user_mail_links (provider, mailbox_address) WHERE status <> 'revoked';
CREATE INDEX user_mail_links_sync_idx ON user_mail_links (tenant_id, next_sync_at)
  WHERE status <> 'revoked' AND next_sync_at IS NOT NULL;
CREATE TRIGGER user_mail_links_touch_updated_at BEFORE UPDATE ON user_mail_links
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Threads the mailbox owner removed from Realty OS: their copies disappear at once (RESTRICTIVE policy below)
-- and are deleted by module 56's reconcile pass; later messages in the thread are never stored (R-GMAIL-12).
CREATE TABLE mail_thread_exclusions (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  link_id         uuid NOT NULL,
  gmail_thread_id text NOT NULL CHECK (gmail_thread_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  excluded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, link_id, gmail_thread_id),
  FOREIGN KEY (tenant_id, link_id) REFERENCES user_mail_links (tenant_id, id) ON DELETE CASCADE
);

-- One synced copy of one Gmail message for one matched contact (R-GMAIL-5): the contact's own address and role
-- only, a COUNT of the other recipients (never their addresses, so a Bcc never reveals anyone), plain text only
-- (no HTML is stored), attachments listed and never fetched. Rows are immutable (Gmail messages are); they are
-- deleted, never edited: by Trash/Spam/delete in Gmail, by an exclusion, by a disconnect, by erasure.
CREATE TABLE mail_messages (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  id                    uuid NOT NULL,
  link_id               uuid NOT NULL,
  contact_id            uuid NOT NULL,
  contact_point_id      uuid NOT NULL,
  contact_address_hmac  bytea NOT NULL CHECK (octet_length(contact_address_hmac) = 32),
  gmail_message_id      text NOT NULL CHECK (gmail_message_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  gmail_thread_id       text NOT NULL CHECK (gmail_thread_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  rfc_message_id_sha256 bytea CHECK (octet_length(rfc_message_id_sha256) = 32),   -- dedupe with platform email (R-GMAIL-5)
  sender                text NOT NULL CHECK (sender IN ('contact','mailbox','other')),   -- who sent it, seen from this contact
  contact_role          text NOT NULL CHECK (contact_role IN ('from','to','cc','bcc')),  -- how this contact appears on it
  other_recipient_count smallint NOT NULL DEFAULT 0 CHECK (other_recipient_count BETWEEN 0 AND 10000),
  subject               text CHECK (length(subject) <= 998),
  body                  text NOT NULL CHECK (length(body) <= 20000),
  body_truncated        boolean NOT NULL DEFAULT false,
  attachments           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20),
  internal_at           timestamptz NOT NULL,      -- Gmail's internalDate, never the sender's Date header
  origin                text NOT NULL CHECK (origin IN ('live','backfill')),   -- computed by the guard (R-GMAIL-8)
  opt_out_keyword       text CHECK (length(opt_out_keyword) <= 40),             -- what the opt-out classifier matched
  created_at            timestamptz NOT NULL DEFAULT now(),
  search_tsv            tsvector GENERATED ALWAYS AS (
                          to_tsvector('simple'::regconfig, coalesce(subject, '') || ' ' || body)) STORED,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, link_id, gmail_message_id, contact_id),        -- replays are no-ops (R-GMAIL-10)
  FOREIGN KEY (tenant_id, link_id)                      REFERENCES user_mail_links (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id)                   REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,   -- erasure
  FOREIGN KEY (tenant_id, contact_id, contact_point_id) REFERENCES contact_points (tenant_id, contact_id, id) ON DELETE CASCADE,
  CHECK ((sender = 'contact') = (contact_role = 'from'))
);
CREATE INDEX mail_messages_contact_idx ON mail_messages (tenant_id, contact_id, internal_at DESC, id DESC);
CREATE INDEX mail_messages_thread_idx  ON mail_messages (tenant_id, link_id, gmail_thread_id);
CREATE INDEX mail_messages_rfc_idx     ON mail_messages (tenant_id, contact_id, rfc_message_id_sha256)
  WHERE rfc_message_id_sha256 IS NOT NULL;
CREATE INDEX mail_messages_tsv_idx     ON mail_messages USING gin (search_tsv);
CREATE TRIGGER mail_messages_immutable BEFORE UPDATE ON mail_messages
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Is a synced row's link live? Gmail sync cleared and on, the link connected or degraded, its user an active
-- member, and (with a thread) the thread not excluded. Definer: readers other than the mailbox owner cannot see the
-- link or its exclusions, yet their reads must stop the moment any of these turns false (R-GMAIL-1, -12, -13).
CREATE FUNCTION app.mail_sync_live(p_tenant uuid, p_link uuid, p_thread text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(p_tenant = app.tenant_id(), false)
     AND app.platform_cleared('platform:gmail', true)
     AND EXISTS (SELECT 1 FROM public.tenant_settings s WHERE s.tenant_id = p_tenant AND s.mail_sync_enabled)
     AND EXISTS (SELECT 1 FROM public.user_mail_links l
                   JOIN public.memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id AND m.status = 'active'
                  WHERE l.tenant_id = p_tenant AND l.id = p_link AND l.status IN ('connected','degraded'))
     AND (p_thread IS NULL OR NOT EXISTS (SELECT 1 FROM public.mail_thread_exclusions x
                                           WHERE x.tenant_id = p_tenant AND x.link_id = p_link AND x.gmail_thread_id = p_thread))
$$;
ALTER FUNCTION app.mail_sync_live(uuid, uuid, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.mail_sync_live(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mail_sync_live(uuid, uuid, text) TO app_user;

-- Only the OAuth callback (the system, after reading the mailbox profile) links a mailbox, and only while sync is
-- on and cleared for an active member. A link keeps its user, mailbox, scopes, disclosure and connect time; a
-- revoked link stays revoked (connect again = a new link). The user may only disconnect, or ask to import again.
CREATE FUNCTION app.user_mail_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sys boolean := COALESCE(app.actor_kind() = 'system', false) OR current_user IN ('app_definer','app_retention');
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NOT sys THEN
      RAISE EXCEPTION 'MAIL_LINK_PROOF_REQUIRED: only the OAuth callback, after reading the mailbox profile, links a mailbox'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status <> 'connected' THEN
      RAISE EXCEPTION 'MAIL_LINK_BORN_CONNECTED: a link starts connected' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (app.platform_cleared('platform:gmail', true)
            AND EXISTS (SELECT 1 FROM public.tenant_settings s WHERE s.tenant_id = NEW.tenant_id AND s.mail_sync_enabled)
            AND EXISTS (SELECT 1 FROM public.memberships m
                         WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.user_id AND m.status = 'active')) THEN
      RAISE EXCEPTION 'MAIL_SYNC_OFF: Gmail sync is off, not cleared, or the user is not an active member'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.user_id, NEW.provider, NEW.mailbox_address, NEW.scopes, NEW.disclosure_sha256, NEW.connected_at)
     IS DISTINCT FROM (OLD.user_id, OLD.provider, OLD.mailbox_address, OLD.scopes, OLD.disclosure_sha256, OLD.connected_at) THEN
    RAISE EXCEPTION 'MAIL_LINK_IMMUTABLE: a link keeps its user, mailbox, scopes and connect time; connecting again is a new link'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked' OR NEW.refresh_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'MAIL_LINK_REVOKED: a disconnected mailbox stays disconnected; connect again' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT sys THEN
    IF NEW.status = 'revoked' AND OLD.status <> 'revoked' THEN
      IF NEW.revoke_reason IS DISTINCT FROM 'USER_DISCONNECTED' THEN
        RAISE EXCEPTION 'MAIL_LINK_SYSTEM_ONLY: a person disconnects their own mailbox (USER_DISCONNECTED)' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF (NEW.status, NEW.refresh_enc, NEW.key_version, NEW.history_id, NEW.next_sync_at, NEW.last_synced_at,
           NEW.backfill_page_token, NEW.backfill_done_at, NEW.last_error_code, NEW.revoked_at, NEW.revoke_reason, NEW.purge_after)
          IS DISTINCT FROM (OLD.status, OLD.refresh_enc, OLD.key_version, OLD.history_id, OLD.next_sync_at, OLD.last_synced_at,
           OLD.backfill_page_token, OLD.backfill_done_at, OLD.last_error_code, OLD.revoked_at, OLD.revoke_reason, OLD.purge_after) THEN
      RAISE EXCEPTION 'MAIL_LINK_SYSTEM_ONLY: tokens and sync state are the system''s; a person may disconnect or import again'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_mail_links_guard BEFORE INSERT OR UPDATE ON user_mail_links
  FOR EACH ROW EXECUTE FUNCTION app.user_mail_links_guard();

-- What may be stored (R-GMAIL-5, -8, -11, -12): only while the link is live and the thread not excluded; only for
-- a contact the mailbox owner owns, collaborates on (live) or shares a deal with, never a deleted or merged one;
-- only under one of that contact's own current email points. The origin is the database's: mail that reached the
-- mailbox before the link connected is history, and only inside the backfill window.
CREATE FUNCTION app.mail_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l record; days integer;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT app.mail_sync_live(NEW.tenant_id, NEW.link_id, NULL) THEN
    RAISE EXCEPTION 'MAIL_SYNC_OFF: this mailbox link is not live (disconnected, member inactive, sync off or not cleared)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT app.mail_sync_live(NEW.tenant_id, NEW.link_id, NEW.gmail_thread_id) THEN
    RAISE EXCEPTION 'MAIL_THREAD_EXCLUDED: the mailbox owner removed this thread from Realty OS' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ml.user_id, ml.connected_at INTO l FROM public.user_mail_links ml WHERE ml.tenant_id = NEW.tenant_id AND ml.id = NEW.link_id;
  IF NOT EXISTS (
       SELECT 1 FROM public.contacts c
        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contact_id AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
          AND (c.owner_user_id = l.user_id
               OR EXISTS (SELECT 1 FROM public.contact_collaborators k
                           WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND k.user_id = l.user_id
                             AND k.removed_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()))
               OR EXISTS (SELECT 1 FROM public.deal_members dm JOIN public.deals d ON d.tenant_id = dm.tenant_id AND d.id = dm.deal_id
                           WHERE dm.tenant_id = c.tenant_id AND dm.user_id = l.user_id
                             AND (d.primary_contact_id = c.id
                                  OR EXISTS (SELECT 1 FROM public.deal_contacts dc
                                              WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = c.id))))) THEN
    RAISE EXCEPTION 'MAIL_CONTACT_NOT_RELATED: mail is stored only for a contact the mailbox owner owns, collaborates on or shares a deal with'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contact_points p
                  WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.contact_point_id AND p.contact_id = NEW.contact_id
                    AND p.kind = 'email' AND p.removed_at IS NULL AND p.address_hmac = NEW.contact_address_hmac) THEN
    RAISE EXCEPTION 'MAIL_ADDRESS_NOT_A_CONTACT_POINT: a synced message is stored only under one of the contact''s own email addresses'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.origin := CASE WHEN NEW.internal_at >= l.connected_at THEN 'live' ELSE 'backfill' END;
  IF NEW.origin = 'backfill' THEN
    SELECT s.mail_backfill_days INTO days FROM public.tenant_settings s WHERE s.tenant_id = NEW.tenant_id;
    IF NEW.internal_at < now() - make_interval(days => COALESCE(days, 0)) THEN
      RAISE EXCEPTION 'MAIL_OLDER_THAN_BACKFILL: mail older than the backfill window is never imported' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mail_messages_guard BEFORE INSERT ON mail_messages
  FOR EACH ROW EXECUTE FUNCTION app.mail_messages_guard();

-- -----------------------------------------------------------------------------
-- 4. Changed tables
-- -----------------------------------------------------------------------------
-- The RFC 5322 Message-ID of an inbound platform email, hashed (filled by the inbound path, module 56's flagged edit
-- of comms/inbound.ts): a client's Reply-All that reaches both the platform and the agent's Gmail is stored and
-- acted on once (R-GMAIL-5, E162).
ALTER TABLE messages
  ADD COLUMN rfc_message_id_sha256 bytea CHECK (rfc_message_id_sha256 IS NULL OR octet_length(rfc_message_id_sha256) = 32);
CREATE INDEX messages_rfc_idx ON messages (tenant_id, contact_id, rfc_message_id_sha256) WHERE rfc_message_id_sha256 IS NOT NULL;

-- A handback for synced mail cites the message by id and time, never by quoting it (R-GMAIL-8, -13).
ALTER TABLE evidence_refs DROP CONSTRAINT evidence_refs_source_type_check;
ALTER TABLE evidence_refs ADD CONSTRAINT evidence_refs_source_type_check CHECK (source_type IN ('call','message','email','note',
  'listing','import','behavior_event','deal','task','appointment','showing','showing_feedback','marketing_activity',
  'home_valuation','deal_date','metric','document','property_record','mail_message'));

-- -----------------------------------------------------------------------------
-- 5. Row-level security for the new tables
-- -----------------------------------------------------------------------------
-- Layer 1, staff only: the same policy text 0001 generated (a client principal reads none of these, R-GMAIL-6).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_publications','user_mail_links','mail_thread_exclusions','mail_messages'] LOOP
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

-- marketing_publications: members read (like pieces); the piece's listing writers publish, as themselves; they and
-- the system record the outcome and retract.
CREATE POLICY publications_read ON marketing_publications FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY publications_insert ON marketing_publications FOR INSERT WITH CHECK (
  (SELECT app.actor_kind()) = 'user' AND requested_by_user_id = (SELECT app.user_id())
  AND EXISTS (SELECT 1 FROM marketing_pieces mp WHERE mp.tenant_id = marketing_publications.tenant_id
                AND mp.id = marketing_publications.piece_id AND app.listing_writable(mp.tenant_id, mp.listing_id)));
CREATE POLICY publications_update ON marketing_publications FOR UPDATE
  USING (((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
         OR EXISTS (SELECT 1 FROM marketing_pieces mp WHERE mp.tenant_id = marketing_publications.tenant_id
                      AND mp.id = marketing_publications.piece_id AND app.listing_writable(mp.tenant_id, mp.listing_id)))
  WITH CHECK (((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
              OR EXISTS (SELECT 1 FROM marketing_pieces mp WHERE mp.tenant_id = marketing_publications.tenant_id
                           AND mp.id = marketing_publications.piece_id AND app.listing_writable(mp.tenant_id, mp.listing_id)));

-- user_mail_links: the user themselves and the system. Owner/Admin see nothing (R-GMAIL-6). Only the system
-- inserts (the OAuth callback) and deletes (purging a revoked link after purge_after).
CREATE POLICY mail_links_select ON user_mail_links FOR SELECT USING (
  ((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
  OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY mail_links_insert ON user_mail_links FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));
CREATE POLICY mail_links_update ON user_mail_links FOR UPDATE
  USING (((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
         OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())))
  WITH CHECK (((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
              OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY mail_links_purge ON user_mail_links FOR DELETE
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()) AND status = 'revoked');

-- mail_thread_exclusions: whoever sees the link (its user, the system); a revoked link takes no new exclusions.
CREATE POLICY mail_exclusions_all ON mail_thread_exclusions FOR ALL
  USING (EXISTS (SELECT 1 FROM user_mail_links l WHERE l.tenant_id = mail_thread_exclusions.tenant_id
                   AND l.id = mail_thread_exclusions.link_id))
  WITH CHECK (EXISTS (SELECT 1 FROM user_mail_links l WHERE l.tenant_id = mail_thread_exclusions.tenant_id
                        AND l.id = mail_thread_exclusions.link_id AND l.status <> 'revoked'));

-- mail_messages: read like the contact's timeline (Phase 1 "View phones, emails, timeline, history"), plus the
-- mailbox owner for their own link's rows; RESTRICTIVE: only while the link is live and the thread not excluded
-- (the system still sees hidden rows, to purge them); RESTRICTIVE: never a support actor, even under an Owner's
-- grant (Google API user-data policy: VERIFY). Written and deleted only by the system.
CREATE POLICY mail_messages_select ON mail_messages FOR SELECT USING (
  app.contact_detail_visible(tenant_id, contact_id)
  OR EXISTS (SELECT 1 FROM user_mail_links l WHERE l.tenant_id = mail_messages.tenant_id AND l.id = mail_messages.link_id));
CREATE POLICY mail_messages_live ON mail_messages AS RESTRICTIVE FOR SELECT USING (
  (SELECT app.actor_kind()) = 'system' OR app.mail_sync_live(tenant_id, link_id, gmail_thread_id));
CREATE POLICY mail_messages_no_support ON mail_messages AS RESTRICTIVE FOR SELECT USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY mail_messages_insert ON mail_messages FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));
CREATE POLICY mail_messages_purge ON mail_messages FOR DELETE
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));

-- -----------------------------------------------------------------------------
-- 6. Grants (least privilege, as 0001 §20). Synced copies are immutable: no UPDATE for app_user.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON marketing_publications TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mail_links TO app_user;
GRANT SELECT, INSERT, DELETE ON mail_thread_exclusions TO app_user;
GRANT SELECT, INSERT, DELETE ON mail_messages TO app_user;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_publications','user_mail_links','mail_thread_exclusions','mail_messages'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO app_definer', t);
    EXECUTE format('GRANT SELECT, UPDATE, DELETE ON public.%I TO app_retention', t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 7. R-PERM-11 (0016): the statement-level support_read_only trigger on every new table (idempotent).
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

-- -----------------------------------------------------------------------------
-- 8. Self-check (as 0018 §21): the client allowlist is still exactly the three portal tables, and every other
--    table keeps the staff-only Layer 1.
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
