-- 0013: simplify the send-time gate (owner decision: every lead consented through third-party sources;
-- "Remove the check entirely" for the send-time consent/compliance decision). core-compliance/2.0.0.
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): replaces two SECURITY DEFINER trigger functions
-- (app.messages_dispatch_guard, app.calls_dispatch_guard). Both stay owned by app_definer with a pinned
-- search_path, read only the row being written plus contact_points / consent_state / suppressions /
-- the assistant tables of the same tenant, and return nothing but the row.
--
-- REMOVED
--   * R-GATE-1/-3 per-send gate decision: the CHECKs requiring gate_decision_id on messages, calls and
--     notification_deliveries (SMS); the 10-minute staleness rule; GATE_NOT_ALLOWED / GATE_DECISION_STALE /
--     GATE_CHANNEL_MISMATCH. (playbook_step_runs never had such a CHECK; its last_gate_decision_id stays a
--     nullable link.)
--   * contact window / quiet hours, frequency caps, deferral bookkeeping: the compliance_policy_versions
--     columns, playbook_step_runs.deferrals and its 'deferred' status, the caps index.
--
-- KEPT / ADDED
--   * The assistant-autonomy half of messages_dispatch_guard, verbatim (ASSISTANT_ACTION_MISSING,
--     PLAYBOOK_NOT_APPROVED, AUTOMATION_PAUSED, ASSISTANT_ACTION_NOT_APPROVED, ASSISTANT_ACTION_NOT_SENDABLE).
--   * NEW database-level opt-out block, no override for any role: an outbound message or call is refused
--     at dispatch when its recipient address opted out or is suppressed, exactly as core canContact
--     decides it (never less):
--       messages  revoked consent_state for (channel, purpose) on the recipient address; for SMS also on
--                 any of the contact's other (non-removed) phones; an active suppression on the
--                 recipient address for the channel or 'all'.
--       calls     revoked voice consent_state of EITHER purpose on the called address (an agent-recorded
--                 "do not call me"), or an active voice/'all' suppression.
--     Recipient linkage: messages.to_address / calls.client_address are the normalized plaintext address
--     (E.164 / lower-case email), the same string contact_points.address holds, and contact_points carries
--     the tenant HMAC that keys consent_state and suppressions (the database cannot compute the HMAC: the
--     key lives outside it). The guard takes the HMAC of EVERY contact point in the tenant with that
--     address (removed ones included), so a stray or forged point with a wrong HMAC cannot hide the real
--     one, and it refuses a send whose address is not a contact point of the message's contact at all
--     (RECIPIENT_NOT_A_CONTACT_POINT: its opt-out status could not be checked).
--     The one exemption mirrors core: the system's own informational SMS reply to a STOP/HELP keyword
--     (categories opt_out_confirmation / help_reply) may reach the just-revoked number, and only when the
--     conversation received a keyword message in the last 24 hours. Suppressions still apply to it.
--   * gate_decisions stays an append-only log, written only when a send is blocked: new rows must be
--     outcome 'deny', phase 'send' (rows written before this migration keep their old values; NOT VALID).
--     messages.gate_decision_id / calls.gate_decision_id / notification_deliveries.gate_decision_id /
--     playbook_step_runs.last_gate_decision_id stay nullable links to that blocked-send row.
--
-- NOT COVERED BY A DB GUARD (documented): agent-alert SMS (notification_deliveries). The recipient is
-- memberships.alert_phone_e164, which has no stored HMAC, so the database cannot key its consent rows; the
-- only path that sends it (comms dispatchAgentAlertSms) runs canContact(recipient = user) at send time.

-- ---- 1. per-send gate decision CHECKs ---------------------------------------------------------------
DO $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT c.conrelid::regclass AS tbl, c.conname FROM pg_constraint c
            WHERE c.contype = 'c'
              AND c.conrelid IN ('public.messages'::regclass, 'public.calls'::regclass, 'public.notification_deliveries'::regclass)
              AND pg_get_constraintdef(c.oid) LIKE '%gate_decision_id IS NOT NULL%' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    n := n + 1;
  END LOOP;
  IF n <> 3 THEN
    RAISE EXCEPTION '0013: expected 3 gate_decision_id CHECKs (messages, calls, notification_deliveries), found %', n;
  END IF;
END $$;

-- ---- 2. gate_decisions: blocked sends only -------------------------------------------------------------
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_blocked_send_only
  CHECK (outcome = 'deny' AND phase = 'send') NOT VALID;
COMMENT ON TABLE gate_decisions IS
  'Append-only log of blocked sends (core-compliance/2.0.0): one row per send the gate denied, with reasons. Rows before 0013 may be allow/defer/needs_confirmation and preview/confirm.';

-- ---- 3. compliance policy: no contact window, caps or deferrals -----------------------------------------
-- Dropping a column drops the CHECKs that mention it (the window floor and the window-or-attestation
-- CHECK); the recording half of the attestation rule is re-added.
ALTER TABLE compliance_policy_versions
  DROP COLUMN contact_window_start,
  DROP COLUMN contact_window_end,
  DROP COLUMN human_reply_window_minutes,
  DROP COLUMN email_quiet_hours,
  DROP COLUMN auto_sms_per_24h,
  DROP COLUMN auto_sms_per_7d,
  DROP COLUMN auto_email_per_24h,
  DROP COLUMN auto_email_per_7d,
  DROP COLUMN auto_cross_channel_per_24h,
  DROP COLUMN manual_sms_confirm_after_24h,
  DROP COLUMN call_attempts_per_24h,
  DROP COLUMN max_deferrals;
ALTER TABLE compliance_policy_versions ADD CONSTRAINT compliance_policy_versions_recording_attested
  CHECK (recording_mode = 'announce_all' OR loosening_attestation IS NOT NULL);

-- ---- 4. playbook steps are never deferred ---------------------------------------------------------------
-- A step run waiting on a deferral goes back to 'scheduled': its message is already scheduled and the
-- sweeper's message_dispatch branch sends it at scheduled_for, re-checked at send time.
UPDATE playbook_step_runs SET status = 'scheduled', updated_at = now() WHERE status = 'deferred';
DO $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT c.conname FROM pg_constraint c
            WHERE c.contype = 'c' AND c.conrelid = 'public.playbook_step_runs'::regclass
              AND pg_get_constraintdef(c.oid) LIKE '%''deferred''%' LOOP
    EXECUTE format('ALTER TABLE playbook_step_runs DROP CONSTRAINT %I', r.conname);
    n := n + 1;
  END LOOP;
  IF n <> 1 THEN RAISE EXCEPTION '0013: expected 1 playbook_step_runs status CHECK, found %', n; END IF;
END $$;
ALTER TABLE playbook_step_runs ADD CONSTRAINT playbook_step_runs_status_check
  CHECK (status IN ('scheduled','sent','converted_to_draft','skipped_ineligible','canceled_paused','failed'));
ALTER TABLE playbook_step_runs DROP COLUMN deferrals;

DROP INDEX messages_caps_idx;

-- ---- 5. message dispatch guard -------------------------------------------------------------------------
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
                           AND im.direction = 'inbound' AND im.opt_out_keyword IS NOT NULL
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

  -- Assistant autonomy (R-GATE-4, A3/A7), unchanged.
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

-- ---- 6. call dispatch guard ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.calls_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE own bytea[];
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
  IF EXISTS (SELECT 1 FROM public.consent_state cs
              WHERE cs.tenant_id = NEW.tenant_id AND cs.channel = 'voice' AND cs.status = 'revoked'
                AND cs.address_hmac = ANY (own)) THEN
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
