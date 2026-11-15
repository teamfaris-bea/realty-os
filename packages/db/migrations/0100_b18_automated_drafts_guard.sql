-- Batch 18 round 3 item 3 (owner boundary B18S-5, OQ-B18-S6): a draft automation wrote stays automated contact even
-- when a person approves it. Security notes: docs/ARCHITECTURE.md §21.67.
--
--   0098's app.messages_source_guard let every assistant message whose action is a person-approved draft (autonomy
--   requires_approval) through for a person a source marked "No automated contact for leads from this source" sent. That
--   is right for a reply the assistant drafted to the person's own message or call, a handback reply and a seller
--   update: a person reads and sends those one to one. It is wrong for a draft a plan step (assistant/steps.ts,
--   trigger_ref.kind 'playbook_step') or a module 26 trigger firing (nurture/execute.ts, 'trigger_run') wrote: the
--   plan or the alert chose the person, the moment and the words, and the tap only releases it. One made before the
--   source was marked outlived the stop and went out on a tap.
--   * app.messages_source_guard is replaced (same name, trigger, invoker, pinned path and tenant check): an assistant
--     message passes only when its action is a person-approved draft that is NOT one of those two kinds. The API
--     withdraws such drafts when the setting is turned on and refuses their approval
--     (apps/api/src/leads/automatedContact.ts withdrawAutomatedDrafts, assistant/drafts.ts); dispatch TX1 refuses one
--     approved before the mark and still queued; this guard is the database backstop beside them.
--   No definer is added or changed; no table, column, policy, grant or retention change; no existing record is touched.

CREATE OR REPLACE FUNCTION app.messages_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF NEW.direction = 'outbound' AND NOT NEW.imported
     AND ((NEW.initiator = 'human' AND (NEW.bulk_action_id IS NOT NULL OR NEW.marketing_piece_id IS NOT NULL))
          OR (NEW.initiator = 'system' AND NEW.action_category NOT IN ('opt_out_confirmation', 'help_reply', 'portal_login_link'))
          OR (NEW.initiator = 'assistant' AND NOT EXISTS (SELECT 1 FROM public.assistant_actions a
                WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assistant_action_id AND a.autonomy = 'requires_approval'
                  AND COALESCE(a.trigger_ref ->> 'kind', '') NOT IN ('playbook_step', 'trigger_run'))))
     AND app.person_no_ai_care_source(NEW.tenant_id, NEW.contact_id) THEN
    RAISE EXCEPTION 'SOURCE_NO_AUTOMATED_CONTACT: "No automated contact for leads from this source" is on for this person''s lead source; only a person''s one-to-one message goes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.messages_source_guard() FROM PUBLIC;

-- Self-check: still an invoker that pins its path, still on its trigger; the definer it asks is unchanged (0099's self-check).
DO $$
DECLARE g record;
BEGIN
  SELECT prosecdef AS definer, proconfig AS config INTO g FROM pg_proc WHERE oid = 'app.messages_source_guard()'::regprocedure;
  IF g.definer THEN RAISE EXCEPTION '0100: app.messages_source_guard must be an invoker'; END IF;
  IF NOT ('search_path=pg_catalog, public' = ANY (g.config)) THEN RAISE EXCEPTION '0100: app.messages_source_guard must pin its search_path'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.messages'::regclass AND t.tgname = 'messages_source_guard'
                    AND t.tgfoid = 'app.messages_source_guard()'::regprocedure AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0100: the messages_source_guard trigger must still call app.messages_source_guard';
  END IF;
  IF (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = 'app.person_no_ai_care_source(uuid,uuid)'::regprocedure) <> 'app_definer' THEN
    RAISE EXCEPTION '0100: app.person_no_ai_care_source must stay owned by app_definer';
  END IF;
END $$;
