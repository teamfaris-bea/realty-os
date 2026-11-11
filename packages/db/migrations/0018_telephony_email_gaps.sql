-- 0018 (lane telephony-email-gaps): inbound calls on real Twilio, inbound MMS media, webhook-id purge.
--
-- 1. voice_settings: one row per tenant (absent = defaults). How long an inbound call rings the agent
--    before it goes to voicemail, and the voicemail greeting. Read by members (and the system actor
--    that answers the call), written by Owner/Admin through PUT /voice-settings (audited).
-- 2. calls.ring_user_id: who an inbound call rings (the contact's owner, or the team's on-duty routing
--    target for unknown callers and unowned contacts). Stored so a retried Twilio fetch rings the same
--    person. calls.agent_user_id stays "who was on the call": it is set only when the agent accepts
--    (or, as before, the owner at insert), so recording access (R-PERM-8 on_call) is not widened to a
--    person who never picked up.
-- 3. message_media: position + provider_media_ref (idempotent copy, provider-side delete), and
--    message_media_skipped: media of an inbound MMS that was NOT stored (type not allowed, too large,
--    too many, content not matching its type, fetch failed), so the thread says so honestly.
-- 4. app.purge_webhook_events(): SECURITY REVIEW ITEM (CONVENTIONS §4): one new SECURITY DEFINER
--    write. Deletes webhook_events rows after their replay window (see the function). It uses the REAL
--    clock (now()) and takes no time or window argument, so app_user cannot shorten a window or pass a
--    far-future instant to wipe replay protection (unlike app.retention_sweep's p_now).

-- -----------------------------------------------------------------------------
-- 1. voice_settings
-- -----------------------------------------------------------------------------
CREATE TABLE voice_settings (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  ring_timeout_seconds integer NOT NULL DEFAULT 20 CHECK (ring_timeout_seconds BETWEEN 5 AND 60),
  voicemail_greeting   text CHECK (voicemail_greeting IS NULL OR length(btrim(voicemail_greeting)) BETWEEN 1 AND 500),
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id   uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES memberships (tenant_id, user_id)
);

ALTER TABLE voice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_settings AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON voice_settings AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON voice_settings AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON voice_settings AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY voice_settings_select ON voice_settings FOR SELECT USING ((SELECT app.is_tenant_wide()) OR (SELECT app.is_member()));
CREATE POLICY voice_settings_insert ON voice_settings FOR INSERT WITH CHECK (
  (SELECT app.is_member()) AND (SELECT app.my_role()) IN ('owner','admin') AND updated_by_user_id = (SELECT app.user_id()));
CREATE POLICY voice_settings_update ON voice_settings FOR UPDATE
  USING ((SELECT app.is_member()) AND (SELECT app.my_role()) IN ('owner','admin'))
  WITH CHECK ((SELECT app.is_member()) AND (SELECT app.my_role()) IN ('owner','admin') AND updated_by_user_id = (SELECT app.user_id()));
GRANT SELECT, INSERT, UPDATE ON voice_settings TO app_user;
GRANT SELECT ON voice_settings TO app_definer;
CREATE TRIGGER voice_settings_touch BEFORE UPDATE ON voice_settings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON voice_settings
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

-- -----------------------------------------------------------------------------
-- 2. calls.ring_user_id
-- -----------------------------------------------------------------------------
ALTER TABLE calls ADD COLUMN ring_user_id uuid;
ALTER TABLE calls ADD CONSTRAINT calls_ring_user_fk FOREIGN KEY (tenant_id, ring_user_id) REFERENCES memberships (tenant_id, user_id);
ALTER TABLE calls ADD CONSTRAINT calls_ring_user_inbound CHECK (ring_user_id IS NULL OR direction = 'inbound');

-- -----------------------------------------------------------------------------
-- 3. inbound MMS media
-- -----------------------------------------------------------------------------
ALTER TABLE message_media ADD COLUMN position integer CHECK (position IS NULL OR position BETWEEN 0 AND 99);
ALTER TABLE message_media ADD COLUMN provider_media_ref text CHECK (provider_media_ref IS NULL OR length(provider_media_ref) <= 64);
CREATE UNIQUE INDEX message_media_position_uq ON message_media (tenant_id, message_id, position) WHERE position IS NOT NULL;

CREATE TABLE message_media_skipped (
  tenant_id     uuid NOT NULL,
  message_id    uuid NOT NULL,
  position      integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  reason        text NOT NULL CHECK (reason IN ('TYPE_NOT_ALLOWED','TOO_LARGE','TOO_MANY','CONTENT_MISMATCH','FETCH_FAILED')),
  declared_type text CHECK (declared_type IS NULL OR length(declared_type) <= 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id, position),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE message_media_skipped ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_media_skipped FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_media_skipped AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON message_media_skipped AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON message_media_skipped AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON message_media_skipped AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
-- the same visibility as message_media: whoever sees the message
CREATE POLICY media_skipped_select ON message_media_skipped FOR SELECT USING (EXISTS (
  SELECT 1 FROM messages m WHERE m.tenant_id = message_media_skipped.tenant_id AND m.id = message_media_skipped.message_id));
CREATE POLICY media_skipped_write ON message_media_skipped FOR INSERT WITH CHECK ((SELECT app.is_tenant_wide()));
GRANT SELECT, INSERT ON message_media_skipped TO app_user;
GRANT SELECT ON message_media_skipped TO app_definer;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON message_media_skipped
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

-- -----------------------------------------------------------------------------
-- 4. webhook id purge (replay windows)
-- -----------------------------------------------------------------------------
-- webhook_events (provider, provider_event_id) is the first replay/idempotency guard. Windows:
--   rejected (bad signature: tenant-less, no payload)  30 days   forensics for signature-failure alerts
--   lead      X-Realty-Signature, t at most 5 min old     2 days   a replay older than ~5.5 min fails the signature
--   email     generic signed and SendGrid/Mailgun/SNS     35 days  timestamped formats fail after minutes; the
--             timestamps, plus Postmark Basic auth (no              Basic-auth formats have no timestamp, so the
--             timestamp)                                            downstream unique keys take over after 35 days:
--                                                                  messages (provider, provider_message_ref) for
--                                                                  inbound, message_status_events
--                                                                  (provider_event_ref) for events; a replayed
--                                                                  bounce/complaint/unsubscribe only ever blocks
--   telephony Twilio signs no timestamp                  400 days the same downstream keys (messages, calls,
--                                                                  recordings provider refs; status events) keep
--                                                                  deduplicating after the purge (SECURITY.md §3)
-- At most 20,000 rows per provider per call, oldest first, so one pass never holds long locks; the
-- worker's maintenance pass calls it hourly and a backlog drains over several passes.
CREATE FUNCTION app.purge_webhook_events()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n_rejected integer; n_lead integer; n_email integer; n_telephony integer;
BEGIN
  DELETE FROM public.webhook_events WHERE id IN (
    SELECT id FROM public.webhook_events WHERE status = 'rejected' AND received_at < now() - interval '30 days'
     ORDER BY received_at LIMIT 20000);
  GET DIAGNOSTICS n_rejected = ROW_COUNT;
  DELETE FROM public.webhook_events WHERE id IN (
    SELECT id FROM public.webhook_events WHERE status <> 'rejected' AND provider = 'lead' AND received_at < now() - interval '2 days'
     ORDER BY received_at LIMIT 20000);
  GET DIAGNOSTICS n_lead = ROW_COUNT;
  DELETE FROM public.webhook_events WHERE id IN (
    SELECT id FROM public.webhook_events WHERE status <> 'rejected' AND provider = 'email' AND received_at < now() - interval '35 days'
     ORDER BY received_at LIMIT 20000);
  GET DIAGNOSTICS n_email = ROW_COUNT;
  DELETE FROM public.webhook_events WHERE id IN (
    SELECT id FROM public.webhook_events WHERE status <> 'rejected' AND provider = 'telephony' AND received_at < now() - interval '400 days'
     ORDER BY received_at LIMIT 20000);
  GET DIAGNOSTICS n_telephony = ROW_COUNT;
  RETURN jsonb_build_object('rejected', n_rejected, 'lead', n_lead, 'email', n_email, 'telephony', n_telephony);
END $$;
ALTER FUNCTION app.purge_webhook_events() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.purge_webhook_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_webhook_events() TO app_user;
GRANT DELETE ON webhook_events TO app_definer;
CREATE INDEX webhook_events_received_idx ON webhook_events (provider, received_at);
