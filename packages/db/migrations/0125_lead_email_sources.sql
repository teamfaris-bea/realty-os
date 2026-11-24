-- Universal lead-email intake (cutover): more parser kinds, a timeline note the system can write, and the
-- realtor.com / Opcity referral reminder.
--
--   parser_kind                 adds agentdash, homes, opcity, fallback (a trusted email no template read)
--   notes.source                adds lead_email: the system writes one timeline line per created lead, with no author
--   referral_update_cues        one row per inquiry once the day-5 reminder has opened a task (their rule is 7 days)
--
-- Nothing here sends to a client. The cue is written by the system actor only.

-- -----------------------------------------------------------------------------
-- 1. Parsers
-- -----------------------------------------------------------------------------
ALTER TABLE lead_email_messages DROP CONSTRAINT lead_email_messages_parser_kind_check;
ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_parser_kind_check
  CHECK (parser_kind IN ('zillow','realtor','generic','leadmetadata','agentdash','homes','opcity','fallback'));

-- -----------------------------------------------------------------------------
-- 2. A system timeline note for the lead email (no author; not a logged activity, so it is not a touch)
-- -----------------------------------------------------------------------------
ALTER TABLE notes DROP CONSTRAINT notes_source_check;
ALTER TABLE notes ADD CONSTRAINT notes_source_check
  CHECK (source IN ('manual','call_summary','import','logged_activity','lead_email'));

DO $$
DECLARE c name;
BEGIN
  SELECT con.conname INTO c
    FROM pg_constraint con
   WHERE con.conrelid = 'public.notes'::regclass
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%author_user_id IS NOT NULL%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%activity%';
  IF c IS NULL THEN
    RAISE EXCEPTION '0125: notes author check not found';
  END IF;
  EXECUTE format('ALTER TABLE notes DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE notes ADD CONSTRAINT notes_author_required
  CHECK (imported OR author_user_id IS NOT NULL OR source = 'lead_email');
ALTER TABLE notes ADD CONSTRAINT notes_lead_email_shape
  CHECK (source <> 'lead_email' OR (author_user_id IS NULL AND contact_id IS NOT NULL AND NOT imported));

-- lead_email notes are read-only, like an import (verbatim from 0027, plus that one source).
CREATE OR REPLACE FUNCTION app.notes_edit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.activity_at IS DISTINCT FROM OLD.activity_at
     OR NEW.activity_direction IS DISTINCT FROM OLD.activity_direction OR NEW.activity_outcome IS DISTINCT FROM OLD.activity_outcome THEN
    IF OLD.source IN ('import','call_summary','lead_email') THEN
      RAISE EXCEPTION 'NOTE_READ_ONLY: imported notes, call summaries and lead-email notes are not edited' USING ERRCODE = 'check_violation';
    END IF;
    IF app.actor_kind() <> 'user' OR OLD.author_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'NOTE_AUTHOR_ONLY: only the author edits a note' USING ERRCODE = 'check_violation';
    END IF;
    NEW.edited_at := now();
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id
         AND NOT (current_user = 'app_definer' AND OLD.contact_id IS NOT NULL AND NEW.contact_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.contact_id
                                 AND c.merged_into_contact_id = NEW.contact_id)))
     OR NEW.deal_id IS DISTINCT FROM OLD.deal_id OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.activity_kind IS DISTINCT FROM OLD.activity_kind OR NEW.imported IS DISTINCT FROM OLD.imported THEN
    RAISE EXCEPTION 'NOTE_IMMUTABLE: a note keeps its parent, author and kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- 3. The day-5 referral reminder (one task per inquiry, ever)
-- -----------------------------------------------------------------------------
CREATE TABLE referral_update_cues (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL,
  inquiry_id  uuid NOT NULL,
  contact_id  uuid NOT NULL,
  task_id     uuid NOT NULL,
  user_id     uuid NOT NULL,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, inquiry_id),
  FOREIGN KEY (tenant_id, inquiry_id) REFERENCES lead_inquiries (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, task_id)    REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)    REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX lead_inquiries_referral_update_idx ON lead_inquiries (tenant_id, received_at)
  WHERE (source_detail->>'referral_update') = 'true';

ALTER TABLE referral_update_cues ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_update_cues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_update_cues AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON referral_update_cues AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON referral_update_cues AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON referral_update_cues AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON referral_update_cues
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
CREATE POLICY referral_update_cues_select ON referral_update_cues FOR SELECT
  USING ((SELECT app.is_tenant_wide()));
CREATE POLICY referral_update_cues_insert ON referral_update_cues FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'system');
GRANT SELECT, INSERT ON referral_update_cues TO app_user;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.referral_update_cues'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0125: referral_update_cues must force row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.referral_update_cues'::regclass AND polname = 'tenant_isolation' AND NOT polpermissive) THEN
    RAISE EXCEPTION '0125: referral_update_cues needs the restrictive tenant policy';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.referral_update_cues'::regclass AND polname LIKE 'support_read_only_%' AND NOT polpermissive) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.referral_update_cues'::regclass AND tgname = 'support_read_only' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0125: referral_update_cues needs the support read-only policies and trigger';
  END IF;
  IF has_table_privilege('app_user', 'public.referral_update_cues', 'DELETE') OR has_table_privilege('app_user', 'public.referral_update_cues', 'TRUNCATE')
     OR has_table_privilege('app_user', 'public.referral_update_cues', 'UPDATE') THEN
    RAISE EXCEPTION '0125: app_user must not update or delete referral_update_cues rows';
  END IF;
END $$;
