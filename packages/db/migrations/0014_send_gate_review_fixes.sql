-- 0014: send-gate review fixes (core-compliance/2.1.0). Every statement is idempotent (CREATE OR
-- REPLACE, UPDATE/INSERT of rows still in the retired state), so the file can be re-applied safely.
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): replaces the two SECURITY DEFINER trigger functions of 0013
-- (app.messages_dispatch_guard, app.calls_dispatch_guard). Ownership (app_definer), the pinned search_path,
-- the tables read and the return value are unchanged; each change only refuses MORE sends.
--
-- 1. outbound-1 (R-CONSENT-7): the system's STOP/HELP keyword reply may reach a revoked number only when
--    that number is the one that texted the keyword (NEW.to_address = the keyword message's from_address,
--    an SMS in the same conversation in the last 24 hours). Before, any keyword in the conversation let the
--    reply go to whichever phone compose picked (the contact's primary), e.g. a number that had opted out
--    a week earlier. Core canContact applies the same rule (GateInput.keywordSenders).
-- 2. outbound-3: a revoked voice consent_state row on ANY of the contact's non-removed phones blocks the call
--    (an agent-recorded "do not call me" is about the person, as an SMS STOP already is for texts). Core
--    canContact applies the same rule (optedOut, voice).
-- 3. integrity-1: messages left waiting for the retired "confirm anyway" tap (status 'queued',
--    scheduled_for NULL, status_reason NEEDS_CONFIRMATION, written by the pre-0013 dispatcher) can never be
--    swept, sent, canceled from the UI or surfaced as failed. They are canceled (CONFIRMATION_RETIRED) and
--    their sender (the human, or the approver of an approved assistant draft) gets an in-app notice; the
--    approved draft becomes 'invalidated' and a scheduled step run 'skipped_ineligible'. Nothing is sent.

-- ---- 1. message dispatch guard: the keyword exemption answers only the number that sent the keyword ----
CREATE OR REPLACE FUNCTION app.messages_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE a record; paused timestamptz; ch text; own bytea[]; others bytea[]; exempt boolean;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN RETURN NEW; END IF;
  IF NEW.direction <> 'outbound' OR NEW.imported
     OR NEW.status NOT IN ('dispatching','sent','delivered','failed','undelivered','bounced','dispatch_unknown')
     OR (TG_OP = 'UPDATE' AND OLD.status NOT IN ('scheduled','queued')) THEN
    RETURN NEW;
  END IF;

  -- Opt-out block (R-CONSENT-7, -10, -20): no override, for any initiator.
  ch := CASE WHEN NEW.channel = 'email' THEN 'email' ELSE 'sms' END;
  IF NOT EXISTS (SELECT 1 FROM public.contact_points p
                  WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id
                    AND p.kind = CASE WHEN ch = 'email' THEN 'email' ELSE 'phone' END AND p.address = NEW.to_address) THEN
    RAISE EXCEPTION 'RECIPIENT_NOT_A_CONTACT_POINT: the recipient''s opt-out status cannot be checked' USING ERRCODE = 'check_violation';
  END IF;
  own := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                WHERE p.tenant_id = NEW.tenant_id AND p.kind = CASE WHEN ch = 'email' THEN 'email' ELSE 'phone' END
                  AND p.address = NEW.to_address);
  others := CASE WHEN ch = 'sms' THEN ARRAY(SELECT p.address_hmac FROM public.contact_points p
                                             WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id
                                               AND p.kind = 'phone' AND p.removed_at IS NULL)
                 ELSE '{}'::bytea[] END;
  exempt := NEW.initiator = 'system' AND NEW.action_category IN ('opt_out_confirmation','help_reply')
            AND NEW.purpose = 'informational' AND ch = 'sms'
            AND EXISTS (SELECT 1 FROM public.messages im
                         WHERE im.tenant_id = NEW.tenant_id AND im.conversation_id = NEW.conversation_id
                           AND im.direction = 'inbound' AND im.channel = 'sms' AND im.opt_out_keyword IS NOT NULL
                           AND im.from_address = NEW.to_address
                           AND im.created_at >= now() - interval '24 hours');
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

  -- Assistant autonomy (R-GATE-4, A3/A7), unchanged from 0013.
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

-- ---- 2. call dispatch guard: a voice revoke on any of the contact's phones blocks the call -------------
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
  own := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                WHERE p.tenant_id = NEW.tenant_id AND p.kind = 'phone' AND p.address = NEW.client_address);
  others := ARRAY(SELECT p.address_hmac FROM public.contact_points p
                   WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id AND p.kind = 'phone' AND p.removed_at IS NULL);
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

-- ---- 3. retire the "confirm anyway" waits (one statement: every step reads the same snapshot) ---------------
WITH r AS (
  SELECT m.tenant_id, m.id, m.assistant_action_id, m.playbook_step_run_id,
         COALESCE(m.initiated_by_user_id, aa.decided_by_user_id) AS notify_user_id
    FROM public.messages m
    LEFT JOIN public.assistant_actions aa ON aa.tenant_id = m.tenant_id AND aa.id = m.assistant_action_id
   WHERE m.direction = 'outbound' AND NOT m.imported AND m.status = 'queued' AND m.status_reason = 'NEEDS_CONFIRMATION'
), canceled AS (
  UPDATE public.messages m SET status = 'canceled', status_reason = 'CONFIRMATION_RETIRED', updated_at = now()
    FROM r WHERE m.tenant_id = r.tenant_id AND m.id = r.id
  RETURNING m.id
), drafts AS (
  UPDATE public.assistant_actions aa SET status = 'invalidated', updated_at = now()
    FROM r WHERE aa.tenant_id = r.tenant_id AND aa.id = r.assistant_action_id AND aa.status = 'approved'
  RETURNING aa.id
), steps AS (
  UPDATE public.playbook_step_runs sr SET status = 'skipped_ineligible', updated_at = now()
    FROM r WHERE sr.tenant_id = r.tenant_id AND sr.id = r.playbook_step_run_id AND sr.status = 'scheduled'
  RETURNING sr.id
), notices AS (
  INSERT INTO public.notifications (tenant_id, id, user_id, kind, priority, title, body, subject_type, subject_id, dedupe_key)
  SELECT r.tenant_id, gen_random_uuid(), r.notify_user_id, 'system', 'normal',
         'A message waiting for your OK was not sent',
         'The extra confirmation step was retired, so this message was canceled. Open the conversation to send it again.',
         'message', r.id, 'confirmation_retired:' || r.id::text
    FROM r JOIN public.memberships ms ON ms.tenant_id = r.tenant_id AND ms.user_id = r.notify_user_id
  ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING
  RETURNING id
)
SELECT (SELECT count(*) FROM canceled) AS canceled, (SELECT count(*) FROM drafts) AS drafts,
       (SELECT count(*) FROM steps) AS steps, (SELECT count(*) FROM notices) AS notices;
