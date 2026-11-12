-- Outbound photo and video texts, one-to-one human sends only (owner decision D5a, PHASE2_3_PLAN §2; DATA_MODEL Part 2
-- §6.4, R-MMS-1..9, E290-E299; ARCHITECTURE §21.20 security notes). The orchestrator renumbers this file at merge.
--
--   messages_mms_one_to_one_human      CHECK: an outbound, not imported 'mms' row is a human send with no bulk action,
--                                      assistant action, playbook step run or marketing piece (R-MMS-1)
--   messages_mms_channel_fixed         invoker trigger: no message moves into or out of 'mms' (R-MMS-1)
--   messages_mms_has_media             invoker, deferred constraint trigger: an outbound 'mms' has media at commit (R-MMS-2)
--   outbound_media_uploads             new table: a sender's staged upload, bound to tenant, uploader and person (R-MMS-3)
--   app.outbound_media_uploads_stamp   invoker: the DB sets the times and binds the row to the uploader's own object
--   app.outbound_media_upload_shred    SECURITY REVIEW ITEM: definer (app_retention), shreds the deleted upload's own
--                                      unattached 'mms' object and nothing else (removal, purge job, erasure)
--   media_outbound_sender_insert       message_media INSERT policy: the sender attaches to their own queued/scheduled mms
--   app.message_media_outbound_guard   invoker: re-checks every message_media insert with an outbound parent (R-MMS-2)
--
-- No existing function, policy or migration is replaced. Erasure reaches staged uploads through the contact cascade
-- (app.purge_contact_internal and app.retention_sweep delete the contact; the upload rows cascade; the shred trigger
-- fires), and attached media are already shredded there with the message's media.

-- -----------------------------------------------------------------------------
-- 1. messages: an outbound mms exists only as an agent's own one-to-one text (R-MMS-1)
-- -----------------------------------------------------------------------------
ALTER TABLE public.messages ADD CONSTRAINT messages_mms_one_to_one_human CHECK (
  channel <> 'mms' OR direction = 'inbound' OR imported
  OR (initiator = 'human' AND bulk_action_id IS NULL AND assistant_action_id IS NULL
      AND playbook_step_run_id IS NULL AND marketing_piece_id IS NULL)) NOT VALID;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_mms_one_to_one_human;

CREATE FUNCTION app.messages_mms_channel_fixed() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.channel IS DISTINCT FROM OLD.channel AND (OLD.channel = 'mms' OR NEW.channel = 'mms') THEN
    RAISE EXCEPTION 'MMS_CHANNEL_FIXED: a message never becomes a photo text and never stops being one'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_mms_channel_fixed BEFORE UPDATE OF channel ON public.messages
  FOR EACH ROW EXECUTE FUNCTION app.messages_mms_channel_fixed();

CREATE FUNCTION app.messages_mms_has_media() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  -- a message deleted in the same transaction (erasure) has nothing left to check
  IF NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.message_media mm WHERE mm.tenant_id = NEW.tenant_id AND mm.message_id = NEW.id) THEN
    RAISE EXCEPTION 'MMS_NO_MEDIA: a photo text carries at least one photo or video' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER messages_mms_has_media AFTER INSERT ON public.messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.direction = 'outbound' AND NOT NEW.imported AND NEW.channel = 'mms')
  EXECUTE FUNCTION app.messages_mms_has_media();

-- -----------------------------------------------------------------------------
-- 2. outbound_media_uploads: a sender's staged photo or video (R-MMS-3)
-- -----------------------------------------------------------------------------
CREATE TABLE public.outbound_media_uploads (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL,
  contact_id          uuid NOT NULL,
  uploaded_by_user_id uuid NOT NULL,
  object_id           uuid NOT NULL,
  content_type        text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/gif','video/mp4','video/quicktime')),
  byte_size           bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= CASE WHEN content_type LIKE 'video/%' THEN 500000 ELSE 5000000 END),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, uploaded_by_user_id) REFERENCES public.memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, object_id) REFERENCES public.stored_objects (tenant_id, id),
  UNIQUE (tenant_id, object_id)
);
CREATE INDEX outbound_media_uploads_expiry ON public.outbound_media_uploads (tenant_id, expires_at);
CREATE INDEX outbound_media_uploads_uploader ON public.outbound_media_uploads (tenant_id, uploaded_by_user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbound_media_uploads'] LOOP
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

-- only the uploader (or the system: the purge job) sees and removes an upload; only the uploader inserts it, for a
-- person they see in detail; no role may UPDATE (so no SELECT ... FOR UPDATE either, and object_id never changes)
CREATE POLICY outbound_media_uploads_select ON public.outbound_media_uploads FOR SELECT
  USING (uploaded_by_user_id = (SELECT app.user_id()) OR (SELECT app.actor_kind()) = 'system');
CREATE POLICY outbound_media_uploads_delete ON public.outbound_media_uploads FOR DELETE
  USING (uploaded_by_user_id = (SELECT app.user_id()) OR (SELECT app.actor_kind()) = 'system');
CREATE POLICY outbound_media_uploads_insert ON public.outbound_media_uploads FOR INSERT
  WITH CHECK (uploaded_by_user_id = (SELECT app.user_id()) AND (SELECT app.is_member())
              AND app.contact_detail_visible(tenant_id, contact_id));

CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.outbound_media_uploads
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

GRANT SELECT, INSERT, DELETE ON public.outbound_media_uploads TO app_user;
GRANT SELECT, DELETE ON public.outbound_media_uploads TO app_retention;

-- The DB sets the times (24 h by the database clock) and binds the row to an unshredded 'mms' object the uploader
-- created, with the same type and size. A foreign-tenant row returns early so that RLS, not an MMS_ error, refuses it.
CREATE FUNCTION app.outbound_media_uploads_stamp() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN RETURN NEW; END IF;
  NEW.created_at := now();
  NEW.expires_at := now() + interval '24 hours';
  IF NOT EXISTS (SELECT 1 FROM public.stored_objects o
                  WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.object_id AND o.purpose = 'mms'
                    AND o.created_by_user_id = NEW.uploaded_by_user_id AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL
                    AND o.content_type = NEW.content_type AND o.byte_size = NEW.byte_size) THEN
    RAISE EXCEPTION 'MMS_UPLOAD_OBJECT: an upload names the uploader''s own stored photo or video, with its type and size'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_media_uploads_stamp BEFORE INSERT ON public.outbound_media_uploads
  FOR EACH ROW EXECUTE FUNCTION app.outbound_media_uploads_stamp();

-- SECURITY REVIEW ITEM. Keyed only on OLD: shreds the deleted upload's own object, and only when that object is an
-- 'mms' object created by that uploader, not yet deleted, and attached to no message (an attached one follows its
-- message: R-MMS-7). Reached by removal (the sender), the purge job (the system) and erasure (the contact cascade).
CREATE FUNCTION app.outbound_media_upload_shred() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = now()
   WHERE o.tenant_id = OLD.tenant_id AND o.id = OLD.object_id AND o.purpose = 'mms'
     AND o.created_by_user_id = OLD.uploaded_by_user_id AND o.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.message_media mm WHERE mm.tenant_id = OLD.tenant_id AND mm.object_id = OLD.object_id);
  RETURN NULL;
END $$;
ALTER FUNCTION app.outbound_media_upload_shred() OWNER TO app_retention;
REVOKE ALL ON FUNCTION app.outbound_media_upload_shred() FROM PUBLIC;
CREATE TRIGGER outbound_media_upload_shred AFTER DELETE ON public.outbound_media_uploads
  FOR EACH ROW EXECUTE FUNCTION app.outbound_media_upload_shred();

-- -----------------------------------------------------------------------------
-- 3. message_media: only the sender attaches, to their own queued or scheduled human mms (R-MMS-2)
-- -----------------------------------------------------------------------------
CREATE POLICY media_outbound_sender_insert ON public.message_media FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.messages m
           WHERE m.tenant_id = message_media.tenant_id AND m.id = message_media.message_id
             AND m.direction = 'outbound' AND NOT m.imported AND m.channel = 'mms' AND m.initiator = 'human'
             AND m.initiated_by_user_id = (SELECT app.user_id()) AND m.status IN ('queued','scheduled'))
  AND EXISTS (SELECT 1 FROM public.outbound_media_uploads u
               WHERE u.tenant_id = message_media.tenant_id AND u.object_id = message_media.object_id
                 AND u.uploaded_by_user_id = (SELECT app.user_id())));

-- Every inserter, the tenant-wide actors media_write allows included. Inbound parents pass unchanged.
CREATE FUNCTION app.message_media_outbound_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE dir text; m record; n integer; total bigint; obj_bytes bigint;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN RETURN NEW; END IF;
  SELECT x.direction INTO dir FROM public.messages x WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.message_id;
  IF dir IS NULL THEN
    RAISE EXCEPTION 'MMS_PARENT_INVISIBLE: media attach to a message the caller sees' USING ERRCODE = 'check_violation';
  END IF;
  IF dir = 'inbound' THEN RETURN NEW; END IF;
  SELECT x.id, x.imported, x.channel, x.initiator, x.initiated_by_user_id, x.status, x.contact_id, x.body,
         x.bulk_action_id, x.assistant_action_id, x.playbook_step_run_id, x.marketing_piece_id
    INTO m FROM public.messages x WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.message_id FOR UPDATE;
  IF m.imported OR m.channel <> 'mms' OR m.initiator <> 'human'
     OR m.bulk_action_id IS NOT NULL OR m.assistant_action_id IS NOT NULL OR m.playbook_step_run_id IS NOT NULL
     OR m.marketing_piece_id IS NOT NULL THEN
    RAISE EXCEPTION 'MMS_NOT_ONE_TO_ONE: media go only on an agent''s own one-to-one photo text' USING ERRCODE = 'check_violation';
  END IF;
  IF m.status NOT IN ('queued','scheduled') THEN
    RAISE EXCEPTION 'MMS_NOT_ATTACHABLE: media are attached only while the text is queued or scheduled' USING ERRCODE = 'check_violation';
  END IF;
  IF m.initiated_by_user_id IS DISTINCT FROM app.user_id() OR app.user_id() IS NULL THEN
    RAISE EXCEPTION 'MMS_NOT_SENDER: only the text''s sender attaches its photos and videos' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.position IS NULL OR NEW.position NOT BETWEEN 0 AND 9 OR NEW.provider_media_ref IS NOT NULL THEN
    RAISE EXCEPTION 'MMS_POSITION: an outbound item sits at positions 0-9 and has no provider reference' USING ERRCODE = 'check_violation';
  END IF;
  SELECT o.byte_size INTO obj_bytes
    FROM public.outbound_media_uploads u JOIN public.stored_objects o ON o.tenant_id = u.tenant_id AND o.id = u.object_id
   WHERE u.tenant_id = NEW.tenant_id AND u.object_id = NEW.object_id AND u.uploaded_by_user_id = app.user_id()
     AND u.contact_id = m.contact_id AND u.expires_at > now()
     AND o.purpose = 'mms' AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL;
  IF obj_bytes IS NULL THEN
    RAISE EXCEPTION 'MMS_UPLOAD_GONE: the object is not an unexpired upload of the sender for this person' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), COALESCE(sum(o.byte_size), 0) INTO n, total
    FROM public.message_media mm JOIN public.stored_objects o ON o.tenant_id = mm.tenant_id AND o.id = mm.object_id
   WHERE mm.tenant_id = NEW.tenant_id AND mm.message_id = NEW.message_id;
  IF n >= 10 THEN
    RAISE EXCEPTION 'MMS_TOO_MANY: a text carries at most 10 photos or videos' USING ERRCODE = 'check_violation';
  END IF;
  IF total + obj_bytes + octet_length(m.body) > 5000000 THEN
    RAISE EXCEPTION 'MMS_TOO_LARGE: photos, videos and text together are at most 5,000,000 bytes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_media_outbound_guard BEFORE INSERT ON public.message_media
  FOR EACH ROW EXECUTE FUNCTION app.message_media_outbound_guard();

-- -----------------------------------------------------------------------------
-- 4. Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'app' AND p.proname = 'outbound_media_upload_shred' AND p.prosecdef
                    AND pg_get_userbyid(p.proowner) = 'app_retention'
                    AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
                    AND NOT has_function_privilege('public', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION '0055 self-check: app.outbound_media_upload_shred must be an app_retention definer with a pinned search_path and no PUBLIC EXECUTE';
  END IF;
  FOREACH f IN ARRAY ARRAY['messages_mms_channel_fixed','messages_mms_has_media','outbound_media_uploads_stamp','message_media_outbound_guard'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'app' AND p.proname = f AND NOT p.prosecdef
                      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION '0055 self-check: app.% must be an invoker with a pinned search_path', f;
    END IF;
  END LOOP;
END $$;
