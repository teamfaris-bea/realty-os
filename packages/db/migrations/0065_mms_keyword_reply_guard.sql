-- Lane telephony-safeguards S3 (R-TWL-11): the keyword-reply exemption of app.messages_dispatch_guard also accepts a
-- keyword that arrived by MMS. Placeholder number (the orchestrator renumbers at merge).
--
-- The exemption lets the platform's own STOP confirmation / HELP reply (system, informational, opt_out_confirmation or
-- help_reply) reach a number that just opted out, but only the number that texted the keyword in this conversation in
-- the last 24 hours. It required the inbound row's channel to EQUAL the reply's: an inbound MMS ('mms') carrying STOP,
-- in its Body (an existing gap) or now only in a text part, could never be confirmed by the SMS reply ('sms'), so the
-- guard refused a confirmation the gate had allowed (comms/repos/gate.ts keywordSenderHmacs counts MMS too). The one
-- change: an 'sms' reply also matches an 'mms' inbound keyword. Everything else is the newest body verbatim (0053):
-- the same recipient (im.from_address = NEW.to_address), conversation, 24-hour window, categories and purpose; nothing
-- else is exempted. SECURITY REVIEW ITEM: docs/ARCHITECTURE.md §21 "messages_dispatch_guard: MMS keyword replies".

CREATE OR REPLACE FUNCTION app.messages_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE a record; paused timestamptz; ch text; pk text; own bytea[]; others bytea[]; exempt boolean; person uuid[];
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
  -- F1: the recipient's whole person (a merged-away record is the person its root survivor is)
  person := app.contact_person_ids(NEW.tenant_id, NEW.contact_id);
  own := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                WHERE p.tenant_id = NEW.tenant_id AND p.kind = pk AND p.address = NEW.to_address);
  -- an SMS or DM keyword revoke on any of the person's points of that kind blocks all of them
  others := CASE WHEN ch IN ('sms','messenger','instagram','web_chat')
                 THEN ARRAY(SELECT p.address_hmac FROM public.contact_points p
                             WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = ANY (person)   -- F1: every record of the person
                               AND p.kind = pk
                               -- R-PAR-12: a removed point still counts unless removed as a confirmed wrong number
                               AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number'))
                 ELSE '{}'::bytea[] END;
  exempt := NEW.initiator = 'system' AND NEW.action_category IN ('opt_out_confirmation','help_reply')
            AND NEW.purpose = 'informational' AND ch IN ('sms','messenger','instagram')
            AND EXISTS (SELECT 1 FROM public.messages im
                         WHERE im.tenant_id = NEW.tenant_id AND im.conversation_id = NEW.conversation_id
                           AND im.direction = 'inbound' AND im.opt_out_keyword IS NOT NULL
                           -- 0065 (R-TWL-11): a keyword that arrived by MMS (its Body or a text part) is answered by SMS
                           AND (im.channel = NEW.channel OR (NEW.channel = 'sms' AND im.channel = 'mms'))
                           AND im.from_address = NEW.to_address
                           AND im.created_at >= now() - interval '24 hours');

  IF NOT exempt AND EXISTS (SELECT 1 FROM public.contacts c
                             WHERE c.tenant_id = NEW.tenant_id AND c.do_not_contact_at IS NOT NULL
                               AND c.id = ANY (person)) THEN   -- F1: any record of the person
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

  -- Assistant autonomy (R-GATE-4, A3/A7), unchanged from 0013/0014 except the line marked b7 sends/F2.
  IF NEW.initiator = 'assistant' THEN
    SELECT aa.autonomy, aa.status, aa.decided_by_user_id, aa.playbook_version_id INTO a
      FROM public.assistant_actions aa WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.assistant_action_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSISTANT_ACTION_MISSING' USING ERRCODE = 'check_violation';
    ELSIF a.autonomy = 'within_playbook' THEN
      -- b7 sends/F2: an autonomous message goes out only while its action is still proposed (it turns executed only
      -- after the provider accepted it); an action a merge or an ownership change invalidated withdrew the message
      IF a.status IS DISTINCT FROM 'proposed' THEN
        RAISE EXCEPTION 'ASSISTANT_ACTION_WITHDRAWN: this automatic message was withdrawn before it went out' USING ERRCODE = 'check_violation';
      END IF;
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
REVOKE ALL ON FUNCTION app.messages_dispatch_guard() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'app.messages_dispatch_guard()'::regprocedure
              AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef
                   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                   OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'messages_dispatch_guard definer shape changed';
  END IF;
  -- every earlier rule is still in the replaced body, plus this migration's
  IF (SELECT position('app.contact_person_ids' IN p.prosrc) = 0 OR position('wrong_number' IN p.prosrc) = 0
             OR position('MARKETING_PIECE_NOT_APPROVED' IN p.prosrc) = 0 OR position('ASSISTANT_ACTION_WITHDRAWN' IN p.prosrc) = 0
             OR position('im.from_address = NEW.to_address' IN p.prosrc) = 0
             OR position('NEW.channel = ''sms'' AND im.channel = ''mms''' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.messages_dispatch_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'messages_dispatch_guard lost a rule';
  END IF;
END $$;
