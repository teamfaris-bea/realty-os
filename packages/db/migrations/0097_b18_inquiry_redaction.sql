-- Batch 18 review B18S-2 (PHASE2_3_PLAN Q-PORTAL-16; owner product direction 2026-11-14; R-PORTAL-20): the label of an
-- inquiry whose quoted portal sign-in token was removed before it was stored. Security notes: docs/ARCHITECTURE.md §21.64.
--
--   0093 labelled the message row of a web-chat opening message, but the same text is also the person's inquiry: the
--   intake (apps/api/src/leads/intake.ts) wrote it unredacted to lead_inquiries.message and to the encrypted raw
--   payload, and the person page and the assistant's prompt read it from there. The intake now replaces a quoted
--   `#token=` value (apps/api/src/portal/shared/redact.ts) in the message, the property text and the raw payload before
--   the row is written, and writes this label on the row, so the stored inquiry says it is not the exact original.
--   * lead_inquiries.content_redacted: NULL or 'portal_signin_token' (NULL: stored as received).
--   * Fixed once written: app.lead_inquiries_content_redacted_fixed (invoker trigger) refuses any change of it after
--     the insert, so no later update can clear it or put it on an inquiry stored as received.
--   Additive only: one nullable column with no default (no table rewrite; every existing row keeps NULL: no existing
--   record is touched), one CHECK, one invoker trigger function and one trigger. No definer, policy, grant or retention
--   change: app_user's existing INSERT/UPDATE grants cover the column; the raw payload purge (90 days) and erasure work
--   on the rows exactly as before.

ALTER TABLE lead_inquiries ADD COLUMN content_redacted text
  CHECK (content_redacted IS NULL OR content_redacted = 'portal_signin_token');

COMMENT ON COLUMN lead_inquiries.content_redacted IS
  'b18 review B18S-2 (Q-PORTAL-16): portal_signin_token when a quoted sign-in token was removed from this inquiry (message, property text, raw payload) before it was stored; NULL = stored as received. Fixed once written.';

CREATE FUNCTION app.lead_inquiries_content_redacted_fixed() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.content_redacted IS DISTINCT FROM OLD.content_redacted THEN
    RAISE EXCEPTION 'CONTENT_REDACTED_FIXED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_inquiries_content_redacted_fixed() FROM PUBLIC;

CREATE TRIGGER lead_inquiries_content_redacted_fixed BEFORE UPDATE OF content_redacted ON lead_inquiries
  FOR EACH ROW EXECUTE FUNCTION app.lead_inquiries_content_redacted_fixed();

-- Self-check: the column exists and is nullable, and every existing row is unlabelled.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lead_inquiries'
                   AND column_name = 'content_redacted' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION '0097: lead_inquiries.content_redacted missing';
  END IF;
  IF EXISTS (SELECT 1 FROM lead_inquiries WHERE content_redacted IS NOT NULL) THEN
    RAISE EXCEPTION '0097: an existing row was labelled';
  END IF;
END $$;
