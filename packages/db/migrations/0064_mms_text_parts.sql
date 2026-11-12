-- Lane telephony-safeguards S3 (R-TWL-11): text carried in MMS text/plain parts. Placeholder number (the orchestrator
-- renumbers at merge).
--
-- Before this, comms/media.ts skipped every text/plain part (not an allowed attachment type), so a STOP carried only in
-- a text part was never seen. message_text_parts holds one row per declared text/plain part of an inbound MMS:
--   pending  the SMS webhook's own ingestion transaction inserted it and enqueued comms.mms_text (same transaction)
--   read     comms.mms_text fetched it by SID (≤ 16 KiB, strict UTF-8, BOM stripped, no NUL), and in ONE transaction
--            (address lock, then the contact locks) marked it read and applied every revoking kind the Body did not
--            already produce. A part never lifts an opt-out and never gets a reply of its own.
-- An unreadable, oversized or refused part keeps its pending row and gets a message_media_skipped row (the existing
-- honest "not saved" record) plus one notice to the conversation's handler.
--
-- Policies mirror message_media_skipped: restrictive tenant isolation and support read-only, SELECT through the
-- message's own visibility (EXISTS on messages under the caller's RLS, so whoever sees the message sees its parts and
-- nobody else), INSERT and UPDATE only tenant-wide (the system's ingestion and job), and an UPDATE may only move
-- pending → read (a trigger; nothing else ever changes). Erasure needs nothing new: ON DELETE CASCADE from messages.
-- No SECURITY DEFINER function is added.

CREATE TABLE message_text_parts (
  tenant_id          uuid NOT NULL,
  message_id         uuid NOT NULL,
  position           integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  provider_media_ref text CHECK (provider_media_ref IS NULL OR provider_media_ref ~ '^ME[0-9a-f]{32}$'),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','read')),
  body               text CHECK (body IS NULL OR octet_length(body) <= 16384),
  classification     text CHECK (classification IS NULL OR classification IN ('none','stop','start','help','wrong_number','opt_out_language')),
  read_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id, position),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending' AND body IS NULL AND read_at IS NULL AND classification IS NULL)
      OR (status = 'read' AND body IS NOT NULL AND read_at IS NOT NULL AND classification IS NOT NULL))
);
ALTER TABLE message_text_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_text_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_text_parts AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON message_text_parts AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON message_text_parts AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON message_text_parts AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
-- the same visibility as message_media / message_media_skipped: whoever sees the message
CREATE POLICY text_parts_select ON message_text_parts FOR SELECT USING (EXISTS (
  SELECT 1 FROM messages m WHERE m.tenant_id = message_text_parts.tenant_id AND m.id = message_text_parts.message_id));
CREATE POLICY text_parts_insert ON message_text_parts FOR INSERT WITH CHECK ((SELECT app.is_tenant_wide()));
CREATE POLICY text_parts_update ON message_text_parts FOR UPDATE USING ((SELECT app.is_tenant_wide())) WITH CHECK ((SELECT app.is_tenant_wide()));
GRANT SELECT, INSERT, UPDATE ON message_text_parts TO app_user;
GRANT SELECT ON message_text_parts TO app_definer;

CREATE FUNCTION app.message_text_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status <> 'read'
     OR (NEW.tenant_id, NEW.message_id, NEW.position, NEW.provider_media_ref, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.message_id, OLD.position, OLD.provider_media_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'TEXT_PART_TRANSITION: a text part only moves pending -> read' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_text_parts_guard BEFORE UPDATE ON message_text_parts
  FOR EACH ROW EXECUTE FUNCTION app.message_text_parts_guard();
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON message_text_parts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
