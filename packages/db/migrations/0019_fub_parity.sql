-- =============================================================================
-- FUB parity schema (design-first, like 0001 and 0018). docs/PARITY_PLAN.md module P0 (db/parity-schema).
--
-- Written before any parity feature module, from docs/DATA_MODEL.md "Part 3: FUB parity" (§11-§14), and
-- revised after the parity design review (docs/ARCHITECTURE.md §20, "FUB parity design review").
-- The file number is a placeholder: other branches also add migrations, and the orchestrator renumbers at
-- merge. Nothing in code or tests names this file. 0001-0018 are not edited.
--
-- What it adds (DATA_MODEL §11): tags + contact_tags (the tag catalog and the one source of a contact's
-- tags), note_mentions and logged-activity columns on notes, contact_stage_events (append-only stage
-- history) and stage labels, custom_field_defs + contact_field_values, contact_relationships,
-- message_templates and the email signature, smart_lists, bulk_actions + bulk_action_items and the Owner's
-- batch-text switch, stage-entry enrollment on playbooks, list indexes, and two replaced views.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * replaces app.messages_dispatch_guard / app.calls_dispatch_guard (SECURITY DEFINER, app_definer, pinned
--     search_path) with ONE change each, which only refuses MORE sends: the "any of the contact's phones"
--     opt-out fan-out now also reads REMOVED points, unless the point was removed as a confirmed wrong number
--     (R-PAR-12). Before this, removing a phone that texted STOP made the contact's other phones textable.
--     Everything else is verbatim from 0018.
--   * new SECURITY DEFINER functions, each owned by app_definer with a pinned search_path:
--       app.contacts_stage_history()   writes contact_stage_events (app_user cannot insert history itself)
--   * new invoker triggers (no privilege change): stage-change guard, tag/field/limit guards, the bulk
--     message guard (a bulk message is a human marketing send of a running action of its own creator, and a
--     text only while the Owner's batch-text switch is on), the batch-text switch guard (Owner only to turn on).
--   * contact_timeline and v_agent_activity_daily are replaced (same columns, security_invoker kept).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Contact points: an address never changes; removing a point never un-blocks the person (R-PAR-11, R-PAR-12)
-- -----------------------------------------------------------------------------
-- Why a point was removed. 'wrong_number' is allowed only for a point already marked wrong_number (by the
-- call-outcome or wrong-number-reply paths, which also record the revoke): only such a point stops counting
-- for the contact's other phones. Points removed before this migration have no reason and keep counting.
ALTER TABLE contact_points ADD COLUMN removed_reason text
  CHECK (removed_reason IN ('typo','not_theirs','replaced','old','duplicate','wrong_number'));
ALTER TABLE contact_points ADD CONSTRAINT contact_points_removed_reason_removed
  CHECK (removed_reason IS NULL OR removed_at IS NOT NULL);

CREATE FUNCTION app.contact_points_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.address IS DISTINCT FROM OLD.address OR NEW.address_hmac IS DISTINCT FROM OLD.address_hmac THEN
    RAISE EXCEPTION 'CONTACT_POINT_IMMUTABLE: a phone or email never changes; remove it and add the new one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.removed_reason = 'wrong_number' AND OLD.removed_reason IS DISTINCT FROM 'wrong_number'
     AND OLD.status <> 'wrong_number' THEN
    RAISE EXCEPTION 'REMOVED_REASON_WRONG_NUMBER: only a point already marked wrong number can be removed as one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.removed_reason IS NOT NULL AND NEW.removed_at IS NOT NULL AND NEW.removed_reason IS DISTINCT FROM OLD.removed_reason THEN
    RAISE EXCEPTION 'REMOVED_REASON_IMMUTABLE: a removal reason never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_points_immutable BEFORE UPDATE ON contact_points
  FOR EACH ROW EXECUTE FUNCTION app.contact_points_immutable();

-- The two opt-out guards, verbatim from 0018 except the R-PAR-12 lines (marked). Trigger bindings are unchanged.
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
                               AND p.kind = pk
                               -- R-PAR-12: a removed point still counts unless removed as a confirmed wrong number
                               AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number'))
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
                   WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id AND p.kind = 'phone'
                     -- R-PAR-12: a removed phone still counts unless removed as a confirmed wrong number
                     AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number'));
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
-- 2. Notes: delete, edit marker, logged outside activity (R-PAR-1..5, R-PAR-30..32)
-- -----------------------------------------------------------------------------
-- A logged activity is a note a person wrote about a call, text, email or meeting that happened outside
-- Realty OS. It is never a messages/calls row (those are the dispatch record), never a touch, and always
-- shown as "Logged by <name>".
ALTER TABLE notes ADD COLUMN edited_at          timestamptz;
ALTER TABLE notes ADD COLUMN activity_kind      text CHECK (activity_kind IN ('call','text','email','meeting','other'));
ALTER TABLE notes ADD COLUMN activity_direction text CHECK (activity_direction IN ('outbound','inbound'));
ALTER TABLE notes ADD COLUMN activity_at        timestamptz;
ALTER TABLE notes ADD COLUMN activity_outcome   text
  CHECK (activity_outcome IN ('connected','left_voicemail','no_answer','wrong_number','other'));
ALTER TABLE notes DROP CONSTRAINT notes_source_check;
ALTER TABLE notes ADD CONSTRAINT notes_source_check CHECK (source IN ('manual','call_summary','import','logged_activity'));
ALTER TABLE notes ADD CONSTRAINT notes_logged_activity_shape CHECK (
  (source = 'logged_activity') = (activity_kind IS NOT NULL)
  AND (activity_kind IS NULL) = (activity_at IS NULL)
  AND (activity_direction IS NULL OR activity_kind IS NOT NULL)
  AND (activity_outcome IS NULL OR activity_kind = 'call'));
-- the time a person says it happened: not in the future, not more than a year back (R-PAR-31)
ALTER TABLE notes ADD CONSTRAINT notes_activity_at_window CHECK (
  activity_at IS NULL OR (activity_at <= created_at + interval '5 minutes' AND activity_at >= created_at - interval '366 days'));
ALTER TABLE notes ADD CONSTRAINT notes_logged_activity_on_contact CHECK (source <> 'logged_activity' OR contact_id IS NOT NULL);

-- Only the author edits a note (0001 lets tenant-wide roles update too: they may pin and unpin, not rewrite);
-- an imported note and a call summary keep their body. Logged-activity facts never change after save.
CREATE FUNCTION app.notes_edit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    IF OLD.source IN ('import','call_summary') THEN
      RAISE EXCEPTION 'NOTE_READ_ONLY: imported notes and call summaries are not edited' USING ERRCODE = 'check_violation';
    END IF;
    IF app.actor_kind() <> 'user' OR OLD.author_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'NOTE_AUTHOR_ONLY: only the author edits a note' USING ERRCODE = 'check_violation';
    END IF;
    NEW.edited_at := now();
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.deal_id IS DISTINCT FROM OLD.deal_id OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.activity_kind IS DISTINCT FROM OLD.activity_kind OR NEW.activity_at IS DISTINCT FROM OLD.activity_at
     OR NEW.activity_direction IS DISTINCT FROM OLD.activity_direction
     OR NEW.activity_outcome IS DISTINCT FROM OLD.activity_outcome OR NEW.imported IS DISTINCT FROM OLD.imported THEN
    RAISE EXCEPTION 'NOTE_IMMUTABLE: a note keeps its parent, author and logged facts' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notes_edit_guard BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION app.notes_edit_guard();

-- Deleting: the author of a manual or logged note, or a tenant-wide role (R-PAR-4). Hard delete, audited by the API.
CREATE POLICY notes_delete ON notes FOR DELETE USING (
  (SELECT app.is_tenant_wide())
  OR (author_user_id = (SELECT app.user_id()) AND source IN ('manual','logged_activity')
      AND ((contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id))
           OR (contact_id IS NULL AND app.deal_visible(tenant_id, deal_id)))));

-- Who was @mentioned in a note, and what happened. The notification is decided by a job running AS the
-- mentioned user, under that user's own RLS (R-PAR-2): no definer evaluates another user's visibility.
CREATE TABLE note_mentions (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  note_id         uuid NOT NULL,
  user_id         uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','notified','no_access','inactive')),
  notification_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  PRIMARY KEY (tenant_id, note_id, user_id),
  FOREIGN KEY (tenant_id, note_id)         REFERENCES notes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)         REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, notification_id) REFERENCES notifications (tenant_id, id) ON DELETE SET NULL (notification_id),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (status = 'notified' OR notification_id IS NULL)
);
CREATE INDEX note_mentions_user_idx ON note_mentions (tenant_id, user_id, created_at DESC);
-- at most 10 people per note; a person never mentions themselves (R-PAR-3)
CREATE FUNCTION app.note_mentions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF EXISTS (SELECT 1 FROM public.notes n WHERE n.tenant_id = NEW.tenant_id AND n.id = NEW.note_id AND n.author_user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'MENTION_SELF: a note does not mention its own author' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM public.note_mentions m WHERE m.tenant_id = NEW.tenant_id AND m.note_id = NEW.note_id) >= 10 THEN
    RAISE EXCEPTION 'TOO_MANY_MENTIONS: at most 10 people per note' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER note_mentions_guard BEFORE INSERT ON note_mentions FOR EACH ROW EXECUTE FUNCTION app.note_mentions_guard();

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('lead_offer','first_touch_due',
  'first_touch_escalation','handback','handback_hot','inbound_message','missed_call','pond_new','task_due','promise_due',
  'exception','reassigned_to_you','reassigned_away','inactivity_warning','opt_out','import_ready','system',
  'seller_update_ready','weekly_plan','integration_status','ad_overspend',
  'mention','bulk_finished'));

-- -----------------------------------------------------------------------------
-- 3. Tags: a tenant catalog and one row per tagged contact (R-PAR-6..10)
-- -----------------------------------------------------------------------------
CREATE TABLE tags (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64 AND name = btrim(name)
                                          AND name !~ '[[:cntrl:]]'),
  name_key           text GENERATED ALWAYS AS (lower(normalize(name, NFKC))) STORED,
  color              text CHECK (color IN ('gray','red','orange','amber','green','teal','blue','indigo','purple','pink','brown','slate')),
  protected_proxy    boolean NOT NULL DEFAULT false,      -- fair-housing proxy (R-PAR-8): never a bulk audience
  created_by_kind    text NOT NULL CHECK (created_by_kind IN ('user','import')),
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name_key),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((created_by_kind = 'user') = (created_by_user_id IS NOT NULL))
);
CREATE TRIGGER tags_touch_updated_at BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- at most 1,000 tags per tenant; protection only tightens unless the Owner lifts it (R-PAR-8, R-PAR-9)
CREATE FUNCTION app.tags_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('tags:' || NEW.tenant_id::text, 0));
    IF (SELECT count(*) FROM public.tags t WHERE t.tenant_id = NEW.tenant_id) >= 1000 THEN
      RAISE EXCEPTION 'TAG_LIMIT: a team has at most 1,000 tags; merge some first' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.protected_proxy AND NOT NEW.protected_proxy AND app.my_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'TAG_PROTECTION_OWNER_ONLY: only the Owner lifts a tag''s fair-housing protection' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tags_guard BEFORE INSERT OR UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION app.tags_guard();

CREATE TABLE contact_tags (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  contact_id       uuid NOT NULL,
  tag_id           uuid NOT NULL,
  added_by_kind    text NOT NULL CHECK (added_by_kind IN ('user','bulk','import','migrated')),   -- migrated: backfilled from contacts.tags
  added_by_user_id uuid,
  bulk_action_id   uuid,
  import_batch_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, tag_id),
  FOREIGN KEY (tenant_id, contact_id)       REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tag_id)           REFERENCES tags (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, added_by_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, import_batch_id)  REFERENCES import_batches (tenant_id, id),
  CHECK ((added_by_kind IN ('user','bulk')) = (added_by_user_id IS NOT NULL)),
  CHECK ((added_by_kind = 'import') = (import_batch_id IS NOT NULL)),
  CHECK ((added_by_kind = 'bulk') = (bulk_action_id IS NOT NULL))
);
CREATE INDEX contact_tags_tag_idx ON contact_tags (tenant_id, tag_id, contact_id);
CREATE FUNCTION app.contact_tags_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM public.contact_tags x WHERE x.tenant_id = NEW.tenant_id AND x.contact_id = NEW.contact_id) >= 100 THEN
    RAISE EXCEPTION 'CONTACT_TAG_LIMIT: a person has at most 100 tags' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_tags_limit BEFORE INSERT ON contact_tags FOR EACH ROW EXECUTE FUNCTION app.contact_tags_limit();

-- contacts.tags (0001) is retired: backfilled here into the catalog (first spelling wins, case- and
-- width-insensitive), and read by nothing new. The import lane (P5) moves its writer to contact_tags and
-- its own migration then blanks and drops the column (R-PAR-10). This runs as the migration owner.
INSERT INTO tags (tenant_id, id, name, created_by_kind)
SELECT DISTINCT ON (x.tenant_id, lower(normalize(btrim(x.name), NFKC)))
       x.tenant_id, gen_random_uuid(), left(btrim(x.name), 64), 'import'
  FROM (SELECT c.tenant_id, unnest(c.tags) AS name, c.created_at FROM contacts c) x
 WHERE length(btrim(x.name)) > 0 AND btrim(x.name) !~ '[[:cntrl:]]'
 ORDER BY x.tenant_id, lower(normalize(btrim(x.name), NFKC)), x.created_at
ON CONFLICT DO NOTHING;
INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, import_batch_id)
SELECT DISTINCT c.tenant_id, c.id, t.id, 'migrated', NULL::uuid
  FROM contacts c CROSS JOIN LATERAL unnest(c.tags) AS u(name)
  JOIN tags t ON t.tenant_id = c.tenant_id AND t.name_key = lower(normalize(left(btrim(u.name), 64), NFKC))
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Stages: the fixed eight, tenant display labels, append-only history (R-PAR-13..15)
-- -----------------------------------------------------------------------------
ALTER TABLE tenant_settings ADD COLUMN stage_labels jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(stage_labels) = 'object');   -- keys and lengths: the trigger below (and core)
CREATE FUNCTION app.tenant_settings_stage_labels_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; v jsonb;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each(NEW.stage_labels) LOOP
    IF k NOT IN ('new','attempting','connected','nurture','active','under_contract','closed','lost')
       OR jsonb_typeof(v) <> 'string' OR length(v #>> '{}') NOT BETWEEN 1 AND 24 THEN
      RAISE EXCEPTION 'STAGE_LABEL_INVALID: a label renames one of the eight stages and is 1-24 characters' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings_stage_labels_guard BEFORE INSERT OR UPDATE OF stage_labels ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION app.tenant_settings_stage_labels_guard();

-- Append-only: app_user may only read it; the definer trigger below is the only writer. Rows go with the
-- contact (cascade on purge/erasure); no UPDATE is ever possible.
CREATE TABLE contact_stage_events (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL,
  contact_id    uuid NOT NULL,
  from_stage    text,
  to_stage      text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('user','system','support','none')),
  actor_user_id uuid,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CHECK (actor_kind <> 'user' OR actor_user_id IS NOT NULL)
);
CREATE INDEX contact_stage_events_contact_idx ON contact_stage_events (tenant_id, contact_id, occurred_at DESC);
CREATE FUNCTION app.contact_stage_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: contact_stage_events rows never change' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER contact_stage_events_immutable BEFORE UPDATE ON contact_stage_events
  FOR EACH ROW EXECUTE FUNCTION app.contact_stage_events_immutable();

CREATE FUNCTION app.contacts_stage_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE ak text := COALESCE(NULLIF(current_setting('app.actor_kind', true), ''), 'none');
BEGIN
  IF ak NOT IN ('user','system','support') THEN ak := 'none'; END IF;
  INSERT INTO public.contact_stage_events (tenant_id, id, contact_id, from_stage, to_stage, actor_kind, actor_user_id)
  VALUES (NEW.tenant_id, gen_random_uuid(), NEW.id, OLD.stage, NEW.stage, ak,
          CASE WHEN ak = 'user' THEN NULLIF(current_setting('app.user_id', true), '')::uuid END);
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_stage_history() OWNER TO app_definer;
CREATE TRIGGER contacts_stage_history AFTER UPDATE OF stage ON contacts
  FOR EACH ROW WHEN (NEW.stage IS DISTINCT FROM OLD.stage) EXECUTE FUNCTION app.contacts_stage_history();

-- R-PAR-14: an Agent or ISA cannot park an untouched routed lead outside new/attempting (where the
-- inactivity release does not apply) without reaching them first; marking it lost stays possible.
CREATE FUNCTION app.contacts_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stage IN ('new','attempting') AND NEW.stage NOT IN ('new','attempting','lost')
     AND OLD.ownership_state = 'owned' AND OLD.first_touch_due_at IS NOT NULL AND OLD.first_touch_at IS NULL
     AND app.actor_kind() = 'user' AND app.my_role() IN ('agent','isa') THEN
    RAISE EXCEPTION 'STAGE_NEEDS_CONTACT: reach this lead first, or mark it lost' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_stage_guard BEFORE UPDATE OF stage ON contacts
  FOR EACH ROW WHEN (NEW.stage IS DISTINCT FROM OLD.stage) EXECUTE FUNCTION app.contacts_stage_guard();

-- Stage-entry enrollment (FUB "action plan on stage change"): an approved playbook may name ONE stage whose
-- entry enrolls the contact (R-PAR-16). Team playbooks apply to every contact, agent playbooks to their
-- owner's contacts; one per (scope, owner, stage). Enrollment still needs an approved version and no live one.
ALTER TABLE playbooks ADD COLUMN auto_enroll_stage text
  CHECK (auto_enroll_stage IN ('new','attempting','connected','nurture','active','under_contract','closed','lost'));
ALTER TABLE playbooks ADD CONSTRAINT playbooks_auto_enroll_not_new_lead CHECK (auto_enroll_stage IS NULL OR kind <> 'new_lead_response');
CREATE UNIQUE INDEX playbooks_auto_enroll_one ON playbooks
  (tenant_id, scope, COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), auto_enroll_stage)
  WHERE auto_enroll_stage IS NOT NULL AND status = 'active';
ALTER TABLE playbook_enrollments DROP CONSTRAINT playbook_enrollments_enrolled_by_check;
ALTER TABLE playbook_enrollments ADD CONSTRAINT playbook_enrollments_enrolled_by_check
  CHECK (enrolled_by IN ('user','new_lead','deal_closed','stage_change','bulk'));
ALTER TABLE playbook_enrollments ADD CONSTRAINT playbook_enrollments_bulk_by_user
  CHECK (enrolled_by <> 'bulk' OR enrolled_by_user_id IS NOT NULL);

-- -----------------------------------------------------------------------------
-- 5. Custom fields: typed definitions and typed values (R-PAR-17..20)
-- -----------------------------------------------------------------------------
CREATE TABLE custom_field_defs (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  key                text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label              text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60 AND label !~ '[[:cntrl:]]'),
  field_type         text NOT NULL CHECK (field_type IN ('text','number','date','single_select','multi_select')),
  options            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 100),
  annual             boolean NOT NULL DEFAULT false,      -- a date that comes round every year (birthday, home anniversary)
  protected_proxy    boolean NOT NULL DEFAULT false,      -- fair-housing proxy (R-PAR-8): values self-reported, never an audience
  position           smallint NOT NULL DEFAULT 0,
  origin             text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','fub_import','csv_import')),
  created_by_user_id uuid,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK (annual = false OR field_type = 'date'),
  CHECK (field_type IN ('single_select','multi_select') OR options = '[]'::jsonb),
  -- the built-in protected attributes keep their own home (contact_attributes, R-AST-12)
  CHECK (key NOT IN ('military_status','va_loan_interest','pcs_orders','pcs_timeline','source_of_income',
                     'familial_status','disability','religion','national_origin'))
);
CREATE UNIQUE INDEX custom_field_defs_label_live ON custom_field_defs (tenant_id, lower(label)) WHERE archived_at IS NULL;
CREATE TRIGGER custom_field_defs_touch_updated_at BEFORE UPDATE ON custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- at most 50 live fields; key and type never change; options are [{id, label, archived?}] with unique ids and
-- are never removed (archive one instead); protection only tightens unless the Owner lifts it
CREATE FUNCTION app.custom_field_defs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; ids text[] := '{}';
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  FOR o IN SELECT * FROM jsonb_array_elements(NEW.options) LOOP
    IF jsonb_typeof(o) <> 'object' OR jsonb_typeof(o->'id') <> 'string' OR (o->>'id') !~ '^[a-z0-9_]{1,40}$'
       OR jsonb_typeof(o->'label') <> 'string' OR length(o->>'label') NOT BETWEEN 1 AND 60
       OR (o->>'id') = ANY (ids) THEN
      RAISE EXCEPTION 'CUSTOM_FIELD_OPTIONS_INVALID: options are {id, label} with unique ids' USING ERRCODE = 'check_violation';
    END IF;
    ids := ids || (o->>'id');
  END LOOP;
  IF TG_OP = 'INSERT' OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cfdefs:' || NEW.tenant_id::text, 0));
    IF NEW.archived_at IS NULL AND (SELECT count(*) FROM public.custom_field_defs d
                                     WHERE d.tenant_id = NEW.tenant_id AND d.archived_at IS NULL AND d.id <> NEW.id) >= 50 THEN
      RAISE EXCEPTION 'CUSTOM_FIELD_LIMIT: a team has at most 50 live custom fields' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.key IS DISTINCT FROM OLD.key OR NEW.field_type IS DISTINCT FROM OLD.field_type THEN
      RAISE EXCEPTION 'CUSTOM_FIELD_IMMUTABLE: a field keeps its key and type' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.options) x
                WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.options) y WHERE y->>'id' = x->>'id')) THEN
      RAISE EXCEPTION 'CUSTOM_FIELD_OPTION_REMOVED: archive an option instead of removing it' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.protected_proxy AND NOT NEW.protected_proxy AND app.my_role() IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'CUSTOM_FIELD_PROTECTION_OWNER_ONLY: only the Owner lifts a field''s fair-housing protection' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_field_defs_guard BEFORE INSERT OR UPDATE ON custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION app.custom_field_defs_guard();

CREATE TABLE contact_field_values (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  contact_id         uuid NOT NULL,
  field_id           uuid NOT NULL,
  value_text         text CHECK (length(value_text) BETWEEN 1 AND 1000),
  value_number       numeric CHECK (value_number = value_number AND abs(value_number) < 1e15),
  value_date         date,
  value_options      text[] CHECK (cardinality(value_options) BETWEEN 1 AND 50),
  self_reported      boolean NOT NULL DEFAULT false,
  updated_by_kind    text NOT NULL CHECK (updated_by_kind IN ('user','bulk','import')),
  updated_by_user_id uuid,
  import_batch_id    uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, field_id),
  FOREIGN KEY (tenant_id, contact_id)         REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, field_id)           REFERENCES custom_field_defs (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, import_batch_id)    REFERENCES import_batches (tenant_id, id),
  CHECK (num_nonnulls(value_text, value_number, value_date, value_options) = 1),
  CHECK ((updated_by_kind IN ('user','bulk')) = (updated_by_user_id IS NOT NULL)),
  CHECK ((updated_by_kind = 'import') = (import_batch_id IS NOT NULL))
);
CREATE INDEX contact_field_values_num_idx  ON contact_field_values (tenant_id, field_id, value_number) WHERE value_number IS NOT NULL;
CREATE INDEX contact_field_values_date_idx ON contact_field_values (tenant_id, field_id, value_date) WHERE value_date IS NOT NULL;
CREATE INDEX contact_field_values_md_idx   ON contact_field_values (tenant_id, field_id, ((EXTRACT(MONTH FROM value_date) * 100 + EXTRACT(DAY FROM value_date)))) WHERE value_date IS NOT NULL;
CREATE INDEX contact_field_values_text_idx ON contact_field_values (tenant_id, field_id, lower(value_text)) WHERE value_text IS NOT NULL;
CREATE INDEX contact_field_values_opt_idx  ON contact_field_values USING gin (value_options) WHERE value_options IS NOT NULL;
CREATE TRIGGER contact_field_values_touch_updated_at BEFORE UPDATE ON contact_field_values
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- the value has the def's type; select values are live option ids; a protected field takes only what the
-- person said (self_reported); an archived field is read-only (R-PAR-17, R-PAR-18)
CREATE FUNCTION app.contact_field_values_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' AND NEW.field_id IS DISTINCT FROM OLD.field_id THEN
    RAISE EXCEPTION 'CUSTOM_VALUE_IMMUTABLE: a value keeps its field' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM public.custom_field_defs f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.field_id;
  IF d.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOM_FIELD_ARCHIVED: this field is archived' USING ERRCODE = 'check_violation';
  END IF;
  IF (d.field_type = 'text' AND NEW.value_text IS NULL) OR (d.field_type = 'number' AND NEW.value_number IS NULL)
     OR (d.field_type = 'date' AND NEW.value_date IS NULL)
     OR (d.field_type IN ('single_select','multi_select') AND NEW.value_options IS NULL)
     OR (d.field_type = 'single_select' AND cardinality(NEW.value_options) <> 1) THEN
    RAISE EXCEPTION 'CUSTOM_VALUE_TYPE: the value does not match the field type %', d.field_type USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.value_options IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(NEW.value_options) v
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.options) o
                           WHERE o->>'id' = v AND COALESCE((o->>'archived')::boolean, false) = false)) THEN
    RAISE EXCEPTION 'CUSTOM_VALUE_OPTION: not a live option of this field' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.value_options IS NOT NULL AND cardinality(NEW.value_options) <> (SELECT count(DISTINCT v) FROM unnest(NEW.value_options) v) THEN
    RAISE EXCEPTION 'CUSTOM_VALUE_OPTION: options repeat' USING ERRCODE = 'check_violation';
  END IF;
  IF d.protected_proxy AND NOT NEW.self_reported THEN
    RAISE EXCEPTION 'CUSTOM_VALUE_SELF_REPORTED: a protected field holds only what the person told you' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_field_values_guard BEFORE INSERT OR UPDATE ON contact_field_values
  FOR EACH ROW EXECUTE FUNCTION app.contact_field_values_guard();

-- -----------------------------------------------------------------------------
-- 6. Relationships between people (R-PAR-21, R-PAR-22)
-- -----------------------------------------------------------------------------
CREATE TABLE contact_relationships (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  contact_id         uuid NOT NULL,
  related_contact_id uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('spouse_partner','family','household','co_buyer','co_seller','referred_by','other')),
  label              text CHECK (length(btrim(label)) BETWEEN 1 AND 40 AND label !~ '[[:cntrl:]]'),
  created_by_user_id uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)         REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, related_contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK (contact_id <> related_contact_id),
  CHECK ((kind = 'other') = (label IS NOT NULL))
);
-- one row per pair and kind; 'referred_by' is directional (contact_id was referred by related_contact_id)
CREATE UNIQUE INDEX contact_relationships_pair ON contact_relationships
  (tenant_id, LEAST(contact_id, related_contact_id), GREATEST(contact_id, related_contact_id), kind) WHERE kind <> 'referred_by';
CREATE UNIQUE INDEX contact_relationships_referral ON contact_relationships (tenant_id, contact_id, related_contact_id)
  WHERE kind = 'referred_by';
CREATE INDEX contact_relationships_related_idx ON contact_relationships (tenant_id, related_contact_id);

-- -----------------------------------------------------------------------------
-- 7. Templates and the email signature (R-PAR-23..26)
-- -----------------------------------------------------------------------------
CREATE TABLE message_templates (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  scope              text NOT NULL CHECK (scope IN ('team','personal')),
  owner_user_id      uuid,
  channel            text NOT NULL CHECK (channel IN ('sms','email')),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  subject            text CHECK (length(subject) BETWEEN 1 AND 200 AND subject !~ '[\r\n]'),
  body               text NOT NULL CHECK (length(body) >= 1),
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  merge_fields       text[] NOT NULL DEFAULT '{}',      -- parsed by core at save (closed set); provenance for review
  updated_by_user_id uuid NOT NULL,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id)      REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((scope = 'personal') = (owner_user_id IS NOT NULL)),
  CHECK ((channel = 'email') = (subject IS NOT NULL)),
  CHECK (channel <> 'sms' OR length(body) <= 1600),
  CHECK (channel <> 'email' OR length(body) <= 20000),
  -- the closed merge-field set (R-PAR-24); custom fields are 'field.<key>' of a live, unprotected def (core checks)
  CHECK (array_to_string(merge_fields, ',') ~ '^((contact\.(first_name|last_name|display_name)|agent\.(first_name|last_name|phone|email)|team\.name|brokerage\.name|field\.[a-z][a-z0-9_]{1,40})(,(contact\.(first_name|last_name|display_name)|agent\.(first_name|last_name|phone|email)|team\.name|brokerage\.name|field\.[a-z][a-z0-9_]{1,40}))*)?$')
);
CREATE UNIQUE INDEX message_templates_name_live ON message_templates
  (tenant_id, scope, COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), channel, lower(name))
  WHERE archived_at IS NULL;
CREATE TRIGGER message_templates_touch_updated_at BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- a template keeps its scope, owner and channel; every content change bumps the version (bulk freezes a version)
CREATE FUNCTION app.message_templates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope IS DISTINCT FROM OLD.scope OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.channel IS DISTINCT FROM OLD.channel THEN
    RAISE EXCEPTION 'TEMPLATE_IMMUTABLE: a template keeps its scope, owner and channel' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.body IS DISTINCT FROM OLD.body OR NEW.subject IS DISTINCT FROM OLD.subject) AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'TEMPLATE_VERSION: a content change bumps the version by one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.body IS NOT DISTINCT FROM OLD.body AND NEW.subject IS NOT DISTINCT FROM OLD.subject AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'TEMPLATE_VERSION: the version moves only with the content' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_templates_guard BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION app.message_templates_guard();

-- the agent's own plain-text email signature (self-editable like alert_phone; rendered as text, R-PAR-25)
ALTER TABLE memberships ADD COLUMN email_signature text
  CHECK (length(email_signature) BETWEEN 1 AND 1000 AND email_signature !~ '[\x00-\x08\x0b\x0c\x0e-\x1f]');

-- provenance of a sent message (nullable; no behaviour hangs on it except the bulk guard below)
ALTER TABLE messages ADD COLUMN template_id      uuid;
ALTER TABLE messages ADD COLUMN template_version integer;
ALTER TABLE messages ADD COLUMN bulk_action_id   uuid;
ALTER TABLE messages ADD CONSTRAINT messages_template_fk FOREIGN KEY (tenant_id, template_id)
  REFERENCES message_templates (tenant_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_template_version CHECK ((template_id IS NULL) = (template_version IS NULL));
ALTER TABLE messages ADD CONSTRAINT messages_bulk_human_marketing
  CHECK (bulk_action_id IS NULL OR (initiator = 'human' AND direction = 'outbound' AND purpose = 'marketing'
                                    AND channel IN ('sms','email')));
CREATE INDEX messages_bulk_action_idx ON messages (tenant_id, bulk_action_id) WHERE bulk_action_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 8. Smart lists: saved filter definitions, run under the viewer's RLS (R-PAR-27..29)
-- -----------------------------------------------------------------------------
CREATE TABLE smart_lists (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL,
  scope              text NOT NULL CHECK (scope IN ('team','personal')),
  owner_user_id      uuid,
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  definition         jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 8192),
  definition_version smallint NOT NULL CHECK (definition_version >= 1),
  sort               text NOT NULL DEFAULT 'last_activity_desc'
                     CHECK (sort IN ('last_activity_desc','created_desc','name_asc','next_task_asc','stage_entered_desc')),
  ref_tag_ids        uuid[] NOT NULL DEFAULT '{}',       -- computed by core at save (protected-audience check, tag delete)
  ref_field_ids      uuid[] NOT NULL DEFAULT '{}',
  position           smallint NOT NULL DEFAULT 0,
  updated_by_user_id uuid NOT NULL,
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id)      REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by_user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((scope = 'personal') = (owner_user_id IS NOT NULL))
);
CREATE INDEX smart_lists_owner_idx ON smart_lists (tenant_id, owner_user_id) WHERE archived_at IS NULL;
CREATE TRIGGER smart_lists_touch_updated_at BEFORE UPDATE ON smart_lists FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE FUNCTION app.smart_lists_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.scope IS DISTINCT FROM OLD.scope OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id) THEN
    RAISE EXCEPTION 'SMART_LIST_IMMUTABLE: a list keeps its scope and owner (copy it instead)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER smart_lists_guard BEFORE UPDATE ON smart_lists FOR EACH ROW EXECUTE FUNCTION app.smart_lists_guard();

-- List indexes (R-PAR-29: first page p95 <= 400 ms at 250k contacts). Live contacts only.
CREATE INDEX contacts_list_stage_idx    ON contacts (tenant_id, stage, id)
  WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL;
CREATE INDEX contacts_list_activity_idx ON contacts (tenant_id, (GREATEST(last_human_touch_at, last_inbound_at)) DESC NULLS LAST, id)
  WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL;
CREATE INDEX contacts_list_created_idx  ON contacts (tenant_id, created_at DESC, id)
  WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL;
CREATE INDEX contacts_list_source_idx   ON contacts (tenant_id, original_lead_source_id)
  WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL AND original_lead_source_id IS NOT NULL;
CREATE INDEX tasks_open_contact_due_idx ON tasks (tenant_id, contact_id, due_at)
  WHERE status = 'open' AND contact_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 9. Bulk actions: audited jobs, one item per contact, run as their creator (R-PAR-33..42)
-- -----------------------------------------------------------------------------
CREATE TABLE bulk_actions (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('tag','untag','stage','assign','enroll','email','text')),
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','confirmed','running','completed','canceled','failed')),
  created_by_user_id  uuid NOT NULL,
  created_by_role     text NOT NULL CHECK (created_by_role IN ('owner','admin','team_lead','agent','isa','tc')),
  source              text NOT NULL CHECK (source IN ('selection','smart_list')),
  smart_list_id       uuid,
  definition_sha256   bytea CHECK (octet_length(definition_sha256) = 32),
  params              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),   -- ids and codes only
  template_id         uuid,
  template_version    integer,
  subject_snapshot    text CHECK (length(subject_snapshot) <= 200 AND subject_snapshot !~ '[\r\n]'),
  body_snapshot       text CHECK (length(body_snapshot) <= 20000),
  target_count        integer CHECK (target_count BETWEEN 0 AND 10000),
  counts              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  confirmed_at        timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by uuid,
  failure_code        text CHECK (failure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, created_by_user_id)  REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, cancel_requested_by) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, smart_list_id)       REFERENCES smart_lists (tenant_id, id) ON DELETE SET NULL (smart_list_id),
  FOREIGN KEY (tenant_id, template_id)         REFERENCES message_templates (tenant_id, id),
  CHECK ((source = 'smart_list') = (definition_sha256 IS NOT NULL)),
  CHECK (status = 'draft' OR (kind IN ('email','text')) = (body_snapshot IS NOT NULL)),
  CHECK (kind IN ('email','text') OR (template_id IS NULL AND body_snapshot IS NULL AND subject_snapshot IS NULL)),
  CHECK (kind <> 'email' OR status = 'draft' OR subject_snapshot IS NOT NULL),
  CHECK ((template_id IS NULL) = (template_version IS NULL)),
  CHECK ((status = 'draft') = (confirmed_at IS NULL)),
  CHECK ((status IN ('completed','canceled','failed')) = (finished_at IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK ((cancel_requested_at IS NULL) = (cancel_requested_by IS NULL)),
  CHECK (status = 'draft' OR target_count IS NOT NULL),
  CHECK (kind <> 'text' OR target_count IS NULL OR target_count <= 200),
  CHECK (kind <> 'assign' OR created_by_role IN ('owner','admin','team_lead')),
  CHECK (created_by_role <> 'tc')
);
CREATE INDEX bulk_actions_creator_idx ON bulk_actions (tenant_id, created_by_user_id, created_at DESC);
CREATE TRIGGER bulk_actions_touch_updated_at BEFORE UPDATE ON bulk_actions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Owner's batch-text switch (R-PAR-40): off by default; only the Owner turns it on (re-auth and the counsel
-- attestation are the API's, audited); Owner or Admin may turn it off.
ALTER TABLE tenant_settings ADD COLUMN batch_text_enabled boolean NOT NULL DEFAULT false;
CREATE FUNCTION app.tenant_settings_batch_text_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.batch_text_enabled AND NOT COALESCE(OLD.batch_text_enabled, false)
     AND NOT (app.actor_kind() = 'user' AND app.my_role() = 'owner') THEN
    RAISE EXCEPTION 'BATCH_TEXT_OWNER_ONLY: only the Owner turns batch texting on' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings_batch_text_guard BEFORE INSERT OR UPDATE OF batch_text_enabled ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION app.tenant_settings_batch_text_guard();

-- Lifecycle: draft -> confirmed (creator, as self) -> running -> completed | failed; cancel from any live state.
-- Kind, creator, source and params never change; the content and target are frozen at confirm; a text
-- action is confirmed only while the switch is on (R-PAR-33, R-PAR-34, R-PAR-40).
CREATE FUNCTION app.bulk_actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'BULK_LIFECYCLE: a bulk action is born a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_by_role IS DISTINCT FROM OLD.created_by_role OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.params IS DISTINCT FROM OLD.params OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'BULK_IMMUTABLE: a bulk action keeps its kind, creator, source and parameters' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.body_snapshot IS DISTINCT FROM OLD.body_snapshot OR NEW.subject_snapshot IS DISTINCT FROM OLD.subject_snapshot
       OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.target_count IS DISTINCT FROM OLD.target_count OR NEW.definition_sha256 IS DISTINCT FROM OLD.definition_sha256) THEN
    RAISE EXCEPTION 'BULK_FROZEN: content and target are frozen at confirm' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'     AND NEW.status IN ('confirmed','canceled'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('running','canceled','failed'))
    OR (OLD.status = 'running'   AND NEW.status IN ('completed','canceled','failed'))) THEN
    RAISE EXCEPTION 'BULK_LIFECYCLE: % -> % is not a bulk transition', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'confirmed' THEN
    IF NOT (app.actor_kind() = 'user' AND app.user_id() = NEW.created_by_user_id
            AND app.my_role() IS NOT DISTINCT FROM NEW.created_by_role) THEN
      RAISE EXCEPTION 'BULK_CONFIRM_CREATOR: only its creator, in the same role, confirms a bulk action' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'text' AND NOT EXISTS (SELECT 1 FROM public.tenant_settings s WHERE s.tenant_id = NEW.tenant_id AND s.batch_text_enabled) THEN
      RAISE EXCEPTION 'BATCH_TEXT_DISABLED: the Owner has not turned batch texting on' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bulk_actions_guard BEFORE INSERT OR UPDATE ON bulk_actions FOR EACH ROW EXECUTE FUNCTION app.bulk_actions_guard();

CREATE TABLE bulk_action_items (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  bulk_action_id uuid NOT NULL,
  contact_id     uuid NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','blocked','failed','canceled')),
  reason_code    text CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  address_hmac   bytea CHECK (octet_length(address_hmac) = 32),     -- sends: one message per address per action
  message_id     uuid,
  processed_at   timestamptz,
  PRIMARY KEY (tenant_id, bulk_action_id, contact_id),
  FOREIGN KEY (tenant_id, bulk_action_id) REFERENCES bulk_actions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id)     REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id)     REFERENCES messages (tenant_id, id) ON DELETE SET NULL (message_id),
  CHECK ((status = 'pending') = (processed_at IS NULL)),
  CHECK (status IN ('pending','done') OR reason_code IS NOT NULL)
);
CREATE UNIQUE INDEX bulk_action_items_one_per_address ON bulk_action_items (tenant_id, bulk_action_id, address_hmac)
  WHERE address_hmac IS NOT NULL;
CREATE INDEX bulk_action_items_pending_idx ON bulk_action_items (tenant_id, bulk_action_id) WHERE status = 'pending';
-- items are added only while the action is a draft (the frozen target), by its creator as self (R-PAR-34)
CREATE FUNCTION app.bulk_action_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.bulk_actions b
                                       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.bulk_action_id AND b.status = 'draft') THEN
    RAISE EXCEPTION 'BULK_FROZEN: people are added only before confirm' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.address_hmac IS DISTINCT FROM OLD.address_hmac AND OLD.address_hmac IS NOT NULL) THEN
    RAISE EXCEPTION 'BULK_FROZEN: an item keeps its address' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bulk_action_items_guard BEFORE INSERT OR UPDATE ON bulk_action_items
  FOR EACH ROW EXECUTE FUNCTION app.bulk_action_items_guard();

-- A bulk message is its action's: a human marketing send by the action's creator while the action runs, to a
-- person in its frozen target; a text only while the switch is on. This is in addition to the opt-out guard,
-- which applies to every message with no bulk exemption (R-PAR-36, D1).
CREATE FUNCTION app.messages_bulk_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  IF NEW.bulk_action_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.bulk_action_id IS NOT DISTINCT FROM OLD.bulk_action_id THEN RETURN NEW; END IF;
  SELECT * INTO b FROM public.bulk_actions x WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.bulk_action_id;
  IF b.id IS NULL OR b.status <> 'running' OR b.kind NOT IN ('email','text')
     OR (b.kind = 'email') <> (NEW.channel = 'email') OR NEW.initiated_by_user_id IS DISTINCT FROM b.created_by_user_id
     OR NOT EXISTS (SELECT 1 FROM public.bulk_action_items i
                     WHERE i.tenant_id = NEW.tenant_id AND i.bulk_action_id = b.id AND i.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'BULK_MESSAGE_INVALID: a bulk message belongs to a running send of its creator, to a person in it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF b.kind = 'text' AND NOT EXISTS (SELECT 1 FROM public.tenant_settings s WHERE s.tenant_id = NEW.tenant_id AND s.batch_text_enabled) THEN
    RAISE EXCEPTION 'BATCH_TEXT_DISABLED: the Owner has not turned batch texting on' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_bulk_guard BEFORE INSERT OR UPDATE OF bulk_action_id ON messages
  FOR EACH ROW EXECUTE FUNCTION app.messages_bulk_guard();
ALTER TABLE messages ADD CONSTRAINT messages_bulk_action_fk FOREIGN KEY (tenant_id, bulk_action_id)
  REFERENCES bulk_actions (tenant_id, id);
ALTER TABLE contact_tags ADD CONSTRAINT contact_tags_bulk_action_fk FOREIGN KEY (tenant_id, bulk_action_id)
  REFERENCES bulk_actions (tenant_id, id);

-- -----------------------------------------------------------------------------
-- 10. Views (same columns; security_invoker kept): the timeline shows stage changes and the time a logged
--     activity happened; bulk messages are never touches in the activity view (R-PAR-37)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW contact_timeline WITH (security_invoker = true) AS
  SELECT m.tenant_id, m.contact_id, m.occurred_at, 'message'::text AS item_type, m.id AS item_id,
         m.initiated_by_user_id AS actor_user_id, m.channel || ':' || m.direction AS detail,
         left(m.body, 280) AS preview, CASE WHEN m.imported THEN 'imported' ELSE 'native' END AS provenance
    FROM messages m
  UNION ALL
  SELECT c.tenant_id, c.contact_id, c.started_at, 'call', c.id, c.agent_user_id, c.direction || ':' || c.status,
         c.outcome, CASE WHEN c.imported THEN 'imported' ELSE 'native' END
    FROM calls c
  UNION ALL
  SELECT n.tenant_id, n.contact_id, COALESCE(n.activity_at, n.created_at), 'note', n.id, n.author_user_id,
         n.source || COALESCE(':' || n.activity_kind, ''), left(n.body, 280),
         CASE WHEN n.imported THEN 'imported' ELSE 'native' END
    FROM notes n WHERE n.contact_id IS NOT NULL
  UNION ALL
  SELECT e.tenant_id, e.contact_id, e.occurred_at, 'ownership', e.event_id, e.actor_user_id, e.type, e.reason_code,
         CASE WHEN e.actor_kind = 'import' THEN 'imported' ELSE 'native' END
    FROM lead_ownership_events e
  UNION ALL
  SELECT a.tenant_id, a.contact_id, a.starts_at, 'appointment', a.id, a.user_id, a.kind || ':' || a.status, a.outcome, 'native'
    FROM appointments a WHERE a.contact_id IS NOT NULL
  UNION ALL
  SELECT b.tenant_id, b.contact_id, b.occurred_at, 'behavior', b.id, NULL::uuid, b.event_type, b.reliability, 'native'
    FROM behavior_events b
  UNION ALL
  SELECT s.tenant_id, s.contact_id, s.occurred_at, 'stage', s.id, s.actor_user_id,
         COALESCE(s.from_stage, '') || '>' || s.to_stage, NULL::text, 'native'
    FROM contact_stage_events s;

CREATE OR REPLACE VIEW v_agent_activity_daily WITH (security_invoker = true) AS
  WITH rows AS (
    SELECT m.tenant_id, m.initiated_by_user_id AS user_id, m.occurred_at AS at, 'text_or_email'::text AS metric
      FROM messages m
     WHERE m.direction = 'outbound' AND m.initiator = 'human'
       AND m.status IN ('sent','delivered','dispatch_unknown')
       AND m.bulk_action_id IS NULL                       -- R-PAR-37: a bulk send is not a touch
    UNION ALL
    SELECT c.tenant_id, c.agent_user_id, c.started_at, 'call' FROM calls c
     WHERE c.direction = 'outbound' AND c.initiator = 'human'
    UNION ALL
    SELECT a.tenant_id, COALESCE(a.set_by_user_id, a.user_id), a.created_at, 'appointment_set' FROM appointments a
     WHERE a.created_by_kind = 'user'
    UNION ALL
    SELECT a.tenant_id, a.user_id, a.starts_at, 'appointment_held' FROM appointments a WHERE a.status = 'held'
    UNION ALL
    SELECT h.tenant_id, d.owner_user_id, h.changed_at, 'agreement_signed' FROM deal_stage_history h
      JOIN deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
     WHERE h.to_stage = 'agreement_signed')
  SELECT r.tenant_id, r.user_id, (r.at AT TIME ZONE s.default_timezone)::date AS day,
         count(*) FILTER (WHERE r.metric IN ('text_or_email','call')) AS touches,
         count(*) FILTER (WHERE r.metric = 'call') AS calls,
         count(*) FILTER (WHERE r.metric = 'text_or_email') AS texts_and_emails,
         count(*) FILTER (WHERE r.metric = 'appointment_set') AS appointments_set,
         count(*) FILTER (WHERE r.metric = 'appointment_held') AS appointments_held,
         count(*) FILTER (WHERE r.metric = 'agreement_signed') AS agreements_signed
    FROM rows r JOIN tenant_settings s ON s.tenant_id = r.tenant_id
   WHERE r.user_id IS NOT NULL
   GROUP BY r.tenant_id, r.user_id, (r.at AT TIME ZONE s.default_timezone)::date;

-- -----------------------------------------------------------------------------
-- 11. Row-level security for every new table (Layer 1 as 0001/0018; then the role policies)
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['note_mentions','tags','contact_tags','contact_stage_events','custom_field_defs',
     'contact_field_values','contact_relationships','message_templates','smart_lists','bulk_actions','bulk_action_items'] LOOP
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

-- note_mentions: whoever can read the note sees who it mentions (never "mentioned = me": a user who lost the
-- contact must not read the row). The author adds mentions as self; only the system resolves them.
CREATE POLICY note_mentions_select ON note_mentions FOR SELECT USING (
  EXISTS (SELECT 1 FROM notes n WHERE n.tenant_id = note_mentions.tenant_id AND n.id = note_mentions.note_id));
CREATE POLICY note_mentions_insert ON note_mentions FOR INSERT WITH CHECK (
  status = 'pending' AND (SELECT app.actor_kind()) = 'user'
  AND EXISTS (SELECT 1 FROM notes n WHERE n.tenant_id = note_mentions.tenant_id AND n.id = note_mentions.note_id
                AND n.author_user_id = (SELECT app.user_id())));
CREATE POLICY note_mentions_resolve ON note_mentions FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));

-- tags: the catalog is team metadata (members read); any member but a TC creates one by typing it; Owner/Admin
-- rename, recolor, protect, merge and delete; the system writes import tags.
CREATE POLICY tags_select ON tags FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY tags_insert ON tags FOR INSERT WITH CHECK (
  (created_by_kind = 'user' AND created_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
   AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'))
  OR (created_by_kind = 'import' AND (SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY tags_manage ON tags FOR UPDATE
  USING ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())))
  WITH CHECK ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY tags_delete ON tags FOR DELETE USING ((SELECT app.my_role()) IN ('owner','admin'));

-- contact_tags: visible exactly when the contact's detail is (never on a pond or offer card); written by
-- someone who sees that detail, as themselves, and is not a TC; or by the system (import).
CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY contact_tags_insert ON contact_tags FOR INSERT WITH CHECK (
  app.contact_detail_visible(tenant_id, contact_id)
  AND ((added_by_kind IN ('user','bulk') AND added_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
        AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'))
       OR (added_by_kind IN ('import','migrated') AND (SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))));
CREATE POLICY contact_tags_delete ON contact_tags FOR DELETE USING (
  app.contact_detail_visible(tenant_id, contact_id)
  AND (((SELECT app.actor_kind()) = 'user' AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'))
       OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))));

-- contact_stage_events: read with the contact's detail; written only by the definer trigger.
CREATE POLICY contact_stage_events_select ON contact_stage_events FOR SELECT USING (app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY contact_stage_events_definer ON contact_stage_events FOR INSERT TO app_definer WITH CHECK (true);

-- custom_field_defs: members read the definitions; Owner/Admin (and the system, for imports) write them.
CREATE POLICY custom_field_defs_select ON custom_field_defs FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY custom_field_defs_write ON custom_field_defs FOR INSERT WITH CHECK (
  ((SELECT app.my_role()) IN ('owner','admin') AND created_by_user_id = (SELECT app.user_id()))
  OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()) AND origin <> 'manual'));
CREATE POLICY custom_field_defs_update ON custom_field_defs FOR UPDATE
  USING ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())))
  WITH CHECK ((SELECT app.my_role()) IN ('owner','admin') OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));

-- contact_field_values: exactly the contact's detail visibility; writers as for contact_tags.
CREATE POLICY contact_field_values_select ON contact_field_values FOR SELECT USING (app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY contact_field_values_insert ON contact_field_values FOR INSERT WITH CHECK (
  app.contact_detail_visible(tenant_id, contact_id)
  AND ((updated_by_kind IN ('user','bulk') AND updated_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
        AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'))
       OR (updated_by_kind = 'import' AND (SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))));
CREATE POLICY contact_field_values_update ON contact_field_values FOR UPDATE
  USING (app.contact_detail_visible(tenant_id, contact_id))
  WITH CHECK (app.contact_detail_visible(tenant_id, contact_id)
  AND ((updated_by_kind IN ('user','bulk') AND updated_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
        AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'))
       OR (updated_by_kind = 'import' AND (SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))));
CREATE POLICY contact_field_values_delete ON contact_field_values FOR DELETE USING (
  app.contact_detail_visible(tenant_id, contact_id)
  AND (((SELECT app.actor_kind()) = 'user' AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'))
       OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))));

-- contact_relationships: exists for a viewer only when both people's detail is visible to them.
CREATE POLICY contact_relationships_select ON contact_relationships FOR SELECT USING (
  app.contact_detail_visible(tenant_id, contact_id) AND app.contact_detail_visible(tenant_id, related_contact_id));
CREATE POLICY contact_relationships_insert ON contact_relationships FOR INSERT WITH CHECK (
  app.contact_detail_visible(tenant_id, contact_id) AND app.contact_detail_visible(tenant_id, related_contact_id)
  AND created_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
  AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'));
CREATE POLICY contact_relationships_delete ON contact_relationships FOR DELETE USING (
  app.contact_detail_visible(tenant_id, contact_id) AND app.contact_detail_visible(tenant_id, related_contact_id)
  AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'));

-- message_templates: team templates are read by members and written by Owner/Admin; a personal template is
-- its owner's alone (Owner/Admin do not read other people's personal templates); the system reads all.
CREATE POLICY message_templates_select ON message_templates FOR SELECT USING (
  (scope = 'team' AND (SELECT app.is_member()))
  OR (scope = 'personal' AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user')
  OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY message_templates_insert ON message_templates FOR INSERT WITH CHECK (
  updated_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
  AND ((scope = 'personal' AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL)
       OR (scope = 'team' AND (SELECT app.my_role()) IN ('owner','admin'))));
CREATE POLICY message_templates_update ON message_templates FOR UPDATE
  USING ((scope = 'personal' AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user')
         OR (scope = 'team' AND (SELECT app.my_role()) IN ('owner','admin')))
  WITH CHECK (updated_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
  AND ((scope = 'personal' AND owner_user_id = (SELECT app.user_id()))
       OR (scope = 'team' AND (SELECT app.my_role()) IN ('owner','admin'))));

-- smart_lists: a team list is a shared definition (members read; Owner/Admin/TL write); a personal list is
-- its owner's. Results are never stored: every run is under the viewer's own contacts RLS.
CREATE POLICY smart_lists_select ON smart_lists FOR SELECT USING (
  (scope = 'team' AND (SELECT app.is_member()))
  OR (scope = 'personal' AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user')
  OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));
CREATE POLICY smart_lists_insert ON smart_lists FOR INSERT WITH CHECK (
  updated_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
  AND ((scope = 'personal' AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL)
       OR (scope = 'team' AND (SELECT app.my_role()) IN ('owner','admin','team_lead'))));
CREATE POLICY smart_lists_update ON smart_lists FOR UPDATE
  USING ((scope = 'personal' AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user')
         OR (scope = 'team' AND (SELECT app.my_role()) IN ('owner','admin','team_lead')))
  WITH CHECK (updated_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
  AND ((scope = 'personal' AND owner_user_id = (SELECT app.user_id()))
       OR (scope = 'team' AND (SELECT app.my_role()) IN ('owner','admin','team_lead'))));
CREATE POLICY smart_lists_delete ON smart_lists FOR DELETE USING (
  (scope = 'personal' AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user')
  OR (scope = 'team' AND (SELECT app.my_role()) IN ('owner','admin','team_lead')));

-- bulk_actions: the creator, tenant-wide roles and the creator's Team Lead read; the creator creates and
-- confirms as self (in their current role); the creator or Owner/Admin cancel; the system runs.
CREATE POLICY bulk_actions_select ON bulk_actions FOR SELECT USING (
  created_by_user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide())
  OR created_by_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[]));
CREATE POLICY bulk_actions_insert ON bulk_actions FOR INSERT WITH CHECK (
  created_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user'
  AND created_by_role = (SELECT app.my_role()));
CREATE POLICY bulk_actions_update ON bulk_actions FOR UPDATE
  USING ((created_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user')
         OR (SELECT app.my_role()) IN ('owner','admin')
         OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())))
  WITH CHECK ((created_by_user_id = (SELECT app.user_id()) AND (SELECT app.actor_kind()) = 'user')
         OR (SELECT app.my_role()) IN ('owner','admin')
         OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));

-- bulk_action_items: read through a visible action AND only for people the reader can see (a TL reading an
-- agent's action never learns about contacts outside their own sight); the creator freezes the target from
-- contacts whose detail they see; the creator (the runner acts as them) or the system records outcomes.
CREATE POLICY bulk_action_items_select ON bulk_action_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM bulk_actions b WHERE b.tenant_id = bulk_action_items.tenant_id AND b.id = bulk_action_items.bulk_action_id)
  AND app.contact_visible(tenant_id, contact_id));
CREATE POLICY bulk_action_items_insert ON bulk_action_items FOR INSERT WITH CHECK (
  status = 'pending' AND (SELECT app.actor_kind()) = 'user' AND app.contact_detail_visible(tenant_id, contact_id)
  AND EXISTS (SELECT 1 FROM bulk_actions b WHERE b.tenant_id = bulk_action_items.tenant_id AND b.id = bulk_action_items.bulk_action_id
                AND b.created_by_user_id = (SELECT app.user_id())));
CREATE POLICY bulk_action_items_update ON bulk_action_items FOR UPDATE
  USING (((SELECT app.actor_kind()) = 'user' AND EXISTS (SELECT 1 FROM bulk_actions b
            WHERE b.tenant_id = bulk_action_items.tenant_id AND b.id = bulk_action_items.bulk_action_id
              AND b.created_by_user_id = (SELECT app.user_id())))
         OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())))
  WITH CHECK (((SELECT app.actor_kind()) = 'user' AND EXISTS (SELECT 1 FROM bulk_actions b
            WHERE b.tenant_id = bulk_action_items.tenant_id AND b.id = bulk_action_items.bulk_action_id
              AND b.created_by_user_id = (SELECT app.user_id())))
         OR ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide())));

-- -----------------------------------------------------------------------------
-- 12. Grants (least privilege, as 0001 §20 / 0018 §20)
-- -----------------------------------------------------------------------------
GRANT DELETE ON notes TO app_user;
GRANT SELECT, INSERT, UPDATE ON note_mentions, custom_field_defs, message_templates, bulk_actions, bulk_action_items TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tags, contact_field_values, smart_lists TO app_user;
GRANT SELECT, INSERT, DELETE ON contact_tags, contact_relationships TO app_user;
GRANT SELECT ON contact_stage_events TO app_user;
GRANT SELECT, INSERT ON contact_stage_events TO app_definer;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['note_mentions','tags','contact_tags','contact_stage_events','custom_field_defs',
     'contact_field_values','contact_relationships','message_templates','smart_lists','bulk_actions','bulk_action_items'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO app_definer', t);
    EXECUTE format('GRANT SELECT, UPDATE, DELETE ON public.%I TO app_retention', t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 13. R-PERM-11 (0016_rule_coverage.sql): support actors are read-only on every table, including through
--     SECURITY DEFINER functions. The new tables get the statement-level trigger here (idempotent).
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
