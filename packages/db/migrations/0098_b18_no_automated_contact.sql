-- Batch 18 review B18S-5 (owner product boundary 2026-11-14): the lead-source setting is "No automated contact for
-- leads from this source". Security notes: docs/ARCHITECTURE.md §21.65.
--
--   A referral partner is not an AI cohort, and its first-week email introduction does not permit this CRM's autonomous
--   texting, calling or mass enrolment. 0094's setting (lead_sources.no_ai_care, Owner only) blocked AI care only; the
--   owner's boundary covers ALL automated contact for the people the source sent (any record of the person, any
--   inquiry: app.person_no_ai_care_source, 0094 and 0096, unchanged). The API refuses or skips every automated path
--   (apps/api/src/leads/automatedContact.ts lists them); these invoker guards are the database backstop beside it:
--   * app.playbook_enrollments_source_guard: no live plan enrolment for such a person (an insert as 'active', or a
--     paused or ended one made active again), whoever enrols them: a stage entry, a closed deal, a bulk enroll, the
--     first response's one-step plan, or a person by hand (OQ-B18-S5's conservative default). A pause, a stop and a
--     version migration pass, so plans can always be stopped.
--   * app.messages_source_guard: no automated message to such a person moves to 'dispatching' (the moment before the
--     provider send, dispatch TX1): an assistant message that is not a person-approved draft (autonomy
--     requires_approval), a system message other than the keyword replies the person asked for (opt_out_confirmation,
--     help_reply) and a client's own sign-in link (portal_login_link), and a person's bulk send or open-house invite
--     (bulk_action_id or marketing_piece_id). A person's one-to-one text, email or chat reply passes.
--   * app.calls_source_guard: the assistant never takes over (or places) a call with such a person
--     (calls.handled_by = 'assistant'); a person's own call passes.
--   * stage_automation_decisions.reason gains 'source_no_automated_contact' (the stage entry's recorded skip).
--   * lead_sources.no_ai_care's comment says what the setting now means (the column keeps its 0094 name; the API field
--     noAiCare and the route PUT /lead-sources/:id/ai-care keep theirs).
--   No definer is added or changed; no table, column, policy, grant or retention change; no existing record is touched.

COMMENT ON COLUMN lead_sources.no_ai_care IS
  'b18 B18S-5: "No automated contact for leads from this source" (Owner only; app.lead_sources_no_ai_care_guard). For any person the source sent (any record, any inquiry: app.person_no_ai_care_source) nothing automatic goes out: no first response, plan enrolment, trigger or alert message, bulk send, invite, AI care or AI-answered call. One-to-one calls, texts and emails by a person still go.';

CREATE FUNCTION app.playbook_enrollments_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF NEW.state = 'active' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'active')
     AND app.person_no_ai_care_source(NEW.tenant_id, NEW.contact_id) THEN
    RAISE EXCEPTION 'SOURCE_NO_AUTOMATED_CONTACT: "No automated contact for leads from this source" is on for this person''s lead source; no plan runs for them'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.playbook_enrollments_source_guard() FROM PUBLIC;
CREATE TRIGGER playbook_enrollments_source_guard BEFORE INSERT OR UPDATE OF state ON playbook_enrollments
  FOR EACH ROW EXECUTE FUNCTION app.playbook_enrollments_source_guard();

CREATE FUNCTION app.messages_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF NEW.direction = 'outbound' AND NOT NEW.imported
     AND ((NEW.initiator = 'human' AND (NEW.bulk_action_id IS NOT NULL OR NEW.marketing_piece_id IS NOT NULL))
          OR (NEW.initiator = 'system' AND NEW.action_category NOT IN ('opt_out_confirmation', 'help_reply', 'portal_login_link'))
          OR (NEW.initiator = 'assistant' AND NOT EXISTS (SELECT 1 FROM public.assistant_actions a
                WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assistant_action_id AND a.autonomy = 'requires_approval')))
     AND app.person_no_ai_care_source(NEW.tenant_id, NEW.contact_id) THEN
    RAISE EXCEPTION 'SOURCE_NO_AUTOMATED_CONTACT: "No automated contact for leads from this source" is on for this person''s lead source; only a person''s one-to-one message goes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.messages_source_guard() FROM PUBLIC;
CREATE TRIGGER messages_source_guard BEFORE UPDATE OF status ON messages
  FOR EACH ROW WHEN (NEW.status = 'dispatching' AND OLD.status IS DISTINCT FROM 'dispatching')
  EXECUTE FUNCTION app.messages_source_guard();

CREATE FUNCTION app.calls_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF NEW.handled_by = 'assistant' AND (TG_OP = 'INSERT' OR OLD.handled_by IS DISTINCT FROM 'assistant')
     AND app.person_no_ai_care_source(NEW.tenant_id, NEW.contact_id) THEN
    RAISE EXCEPTION 'SOURCE_NO_AUTOMATED_CONTACT: "No automated contact for leads from this source" is on for this caller''s lead source; the assistant does not answer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.calls_source_guard() FROM PUBLIC;
CREATE TRIGGER calls_source_guard BEFORE INSERT OR UPDATE OF handled_by ON calls
  FOR EACH ROW EXECUTE FUNCTION app.calls_source_guard();

ALTER TABLE stage_automation_decisions DROP CONSTRAINT stage_automation_decisions_reason_check;
ALTER TABLE stage_automation_decisions ADD CONSTRAINT stage_automation_decisions_reason_check
  CHECK (reason IN ('not_a_person_change','person_removed','stage_changed_again','not_visible',
                    'plan_not_approved','already_in_a_plan','cannot_be_reached','protected_audience','ai_isa_active',
                    'source_no_automated_contact'));

-- Self-check: the three guards are invokers that pin their path; the definer they ask is unchanged (0096's self-check).
DO $$
DECLARE f text; g record;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.playbook_enrollments_source_guard()', 'app.messages_source_guard()', 'app.calls_source_guard()'] LOOP
    SELECT prosecdef AS definer, proconfig AS config INTO g FROM pg_proc WHERE oid = f::regprocedure;
    IF g.definer THEN RAISE EXCEPTION '0098: % must be an invoker', f; END IF;
    IF NOT ('search_path=pg_catalog, public' = ANY (g.config)) THEN RAISE EXCEPTION '0098: % must pin its search_path', f; END IF;
  END LOOP;
  IF (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = 'app.person_no_ai_care_source(uuid,uuid)'::regprocedure) <> 'app_definer' THEN
    RAISE EXCEPTION '0098: app.person_no_ai_care_source must stay owned by app_definer';
  END IF;
END $$;
