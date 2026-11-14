-- Batch 18 item a (PHASE2_3_PLAN Q-PORTAL-16; owner product direction 2026-11-14): the label of an inbound record whose
-- quoted portal sign-in token was removed before it was stored. Security notes: docs/ARCHITECTURE.md §21.60.
--
--   Module 22's ingestion (apps/api/src/comms/inbound.ts) and the MMS text-part reader (comms/mmsTextJob.ts) replace a
--   quoted `#token=` value (apps/api/src/portal/shared/redact.ts) before the row is written, and write this label on
--   the row, so the stored record says it is not the exact original. A NULL label is a record stored as received.
--   * messages.content_redacted, message_text_parts.content_redacted: NULL or 'portal_signin_token'.
--   * The label is fixed once written: a message's at its insert, a text part's when the part is read (pending ->
--     read, the one UPDATE that writes its body). An invoker trigger refuses any other change, so no later update can
--     clear it or put it on a record that was stored as received (the record would then claim a redaction that did
--     not happen).
--   Additive only: two nullable columns with no default (no table rewrite, every existing row keeps NULL: no existing
--   record is touched), one CHECK each, one invoker trigger function and two triggers. No definer, policy, grant or
--   retention change: app_user's existing INSERT/UPDATE grants on both tables cover the new columns, and erasure
--   deletes or blanks the rows exactly as before.

ALTER TABLE messages ADD COLUMN content_redacted text
  CHECK (content_redacted IS NULL OR content_redacted = 'portal_signin_token');
ALTER TABLE message_text_parts ADD COLUMN content_redacted text
  CHECK (content_redacted IS NULL OR content_redacted = 'portal_signin_token');

COMMENT ON COLUMN messages.content_redacted IS
  'b18 Q-PORTAL-16: portal_signin_token when a quoted sign-in token was removed from this inbound record before it was stored; NULL = stored as received. Fixed once written.';
COMMENT ON COLUMN message_text_parts.content_redacted IS
  'b18 Q-PORTAL-16: portal_signin_token when a quoted sign-in token was removed from this text part before it was stored; written with the part''s body, then fixed.';

CREATE FUNCTION app.content_redacted_fixed() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.content_redacted IS NOT DISTINCT FROM OLD.content_redacted THEN
    RETURN NEW;
  END IF;
  -- a text part gets its label with its body, in the one pending -> read update (comms/mmsTextJob.ts)
  IF TG_TABLE_NAME = 'message_text_parts' AND OLD.status = 'pending' AND NEW.status = 'read' AND OLD.content_redacted IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CONTENT_REDACTED_FIXED' USING ERRCODE = 'check_violation';
END $$;
REVOKE ALL ON FUNCTION app.content_redacted_fixed() FROM PUBLIC;

CREATE TRIGGER messages_content_redacted_fixed BEFORE UPDATE OF content_redacted ON messages
  FOR EACH ROW EXECUTE FUNCTION app.content_redacted_fixed();
CREATE TRIGGER message_text_parts_content_redacted_fixed BEFORE UPDATE OF content_redacted ON message_text_parts
  FOR EACH ROW EXECUTE FUNCTION app.content_redacted_fixed();

-- Self-check: both columns exist, are nullable, and every existing row is unlabelled.
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'content_redacted' AND is_nullable = 'YES'
         AND table_name IN ('messages', 'message_text_parts')) <> 2 THEN
    RAISE EXCEPTION '0093: content_redacted columns missing';
  END IF;
  IF EXISTS (SELECT 1 FROM messages WHERE content_redacted IS NOT NULL)
     OR EXISTS (SELECT 1 FROM message_text_parts WHERE content_redacted IS NOT NULL) THEN
    RAISE EXCEPTION '0093: an existing row was labelled';
  END IF;
END $$;
