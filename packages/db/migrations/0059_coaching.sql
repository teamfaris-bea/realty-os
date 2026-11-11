-- Module 36 api/coaching (PHASE2_3_PLAN §5.4 "35. core/coaching and 36. api/coaching"; DATA_MODEL Part 2
-- "Coaching", R-COACH-1..6, E104-E106). No new table (P1: module migrations add definers, views, indexes
-- and guard replacements only) and no SECURITY DEFINER function.
--
-- 1. call_scores_guard (replaced, same owner, invoker): a review also needs a lawful recording basis
--    (R-COACH-1, E104). The call must not be imported, and it must have a provider recording (never a FUB
--    import) whose basis is announced_all_parties or one_party_policy and which is not shredded. The 0018
--    subject check (a person handled the call; the row names that call's agent and contact) is unchanged.
--    The Owner's switch and the platform:coaching pack stay gated where 0018 put them (the toggle) and in
--    the review job at every run (a later unreviewed pack version turns reviewing off again, R-INT-6).
-- 2. call_scores_recording_scope (replaced): a review is readable only while its recording is playable by
--    the caller (recording-scope RLS inside the EXISTS) and not shredded (R-COACH-3).
-- 3. assistant_actions call_review_scope (new RESTRICTIVE policy): a call_review action, and through the
--    claims/evidence policies its claims and quotes, is readable exactly where its call_scores row is.
--    Without it a Team Lead who sees the contact could read the rubric claims of a team member's call
--    while the Owner's tl_sees_call_scores is off (actions_select lets Team Leads read team actions).
-- 4. tenant_settings_p23_guard (replaced, same body plus one column): coaching_rubric_disabled is a
--    call-scoring setting and Owner-only like call_scoring_enabled and tl_sees_call_scores (DATA_MODEL
--    tenant_settings row: "call-scoring settings are Owner-only").
-- 5. call_scores_agent_idx: the daily fix reads an agent's latest scored calls.
--
-- VERIFY WITH COUNSEL: which recording bases make reviewing an agent's calls lawful (employee monitoring,
-- counsel item C11). The two bases admitted here are the ones Phase 1 already records calls under.

-- -----------------------------------------------------------------------------
-- 1. A review needs a human-handled call with a lawful recording (R-COACH-1, R-COACH-3, E104)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.call_scores_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT EXISTS (SELECT 1 FROM public.calls c
                  WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.call_id AND c.handled_by = 'human'
                    AND c.agent_user_id = NEW.agent_user_id AND c.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'CALL_REVIEW_SUBJECT: a review covers a call a person handled, for the agent on that call'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.calls c
                   JOIN public.recordings r ON r.tenant_id = c.tenant_id AND r.call_id = c.id
                  WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.call_id AND NOT c.imported
                    AND r.source = 'provider' AND r.consent_basis IN ('announced_all_parties','one_party_policy')
                    AND r.status <> 'shredded') THEN
    RAISE EXCEPTION 'CALL_REVIEW_RECORDING_BASIS: only a call recorded on a lawful basis is reviewed, never an imported recording'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Readable only while the caller may play the recording, and it still exists (R-COACH-3)
-- -----------------------------------------------------------------------------
DROP POLICY call_scores_recording_scope ON call_scores;
CREATE POLICY call_scores_recording_scope ON call_scores AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM recordings r WHERE r.tenant_id = call_scores.tenant_id AND r.call_id = call_scores.call_id
                                       AND r.status <> 'shredded'));

-- -----------------------------------------------------------------------------
-- 3. A call review's claims and quotes are as private as the review (R-COACH-3)
-- -----------------------------------------------------------------------------
-- Tenant-wide actors (Owner, Admin, the system writing the review) pass directly, so the job's INSERT ...
-- RETURNING works before the call_scores row exists; everyone else reads a call_review action only through
-- a call_scores row they can read (its own policies: the agent on the call, or their Team Lead with the
-- Owner's setting, and the recording scope).
CREATE POLICY call_review_scope ON assistant_actions AS RESTRICTIVE FOR SELECT USING (
  kind <> 'call_review'
  OR (SELECT app.is_tenant_wide())
  OR EXISTS (SELECT 1 FROM call_scores s WHERE s.tenant_id = assistant_actions.tenant_id AND s.assistant_action_id = assistant_actions.id));

-- -----------------------------------------------------------------------------
-- 4. Every call-scoring setting is the Owner's (0018 body, plus coaching_rubric_disabled)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tenant_settings_p23_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF current_user IN ('app_definer','app_retention') THEN RETURN NEW; END IF;
  IF (NEW.call_scoring_enabled, NEW.tl_sees_call_scores, NEW.coaching_rubric_disabled)
       IS DISTINCT FROM (OLD.call_scoring_enabled, OLD.tl_sees_call_scores, OLD.coaching_rubric_disabled)
     AND COALESCE(app.my_role(), '') <> 'owner' THEN
    RAISE EXCEPTION 'OWNER_ONLY_SETTING' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.call_scoring_enabled AND NOT OLD.call_scoring_enabled AND NOT app.platform_cleared('platform:coaching') THEN
    RAISE EXCEPTION 'COACHING_NOT_CLEARED: call scoring waits for counsel review of the platform:coaching pack'
      USING ERRCODE = 'check_violation';
  END IF;
  -- only the Owner turns voice answering on, including by re-activating an older voice-on policy version;
  -- turning it off stays open to Admins (R-VOICE-9, E150)
  IF NEW.active_policy_id IS DISTINCT FROM OLD.active_policy_id
     AND EXISTS (SELECT 1 FROM public.compliance_policy_versions cp
                  WHERE cp.tenant_id = NEW.tenant_id AND cp.id = NEW.active_policy_id AND cp.voice_answering_enabled)
     AND COALESCE(app.my_role(), '') <> 'owner' THEN
    RAISE EXCEPTION 'OWNER_ONLY_VOICE: only the Owner turns on voice answering' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- 5. The daily fix reads an agent's latest reviews
-- -----------------------------------------------------------------------------
CREATE INDEX call_scores_agent_idx ON call_scores (tenant_id, agent_user_id, created_at DESC);
