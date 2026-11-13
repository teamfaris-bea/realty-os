-- =============================================================================
-- 0081_b12_review_ai_isa: batch 12 interaction review fixes for module 75 (AI ISA; owner decision D12 PROPOSED, the
-- feature stays dark: platform:ai_isa uncleared, AI_ISA_LIVE_SENDS=false) and the 0080 appointment lock. Why schema
-- and not code: every gap below is in a guard, a policy or a CHECK.
--
--  1. db-isa-merge-1 (R-ISA-31, R-ISA-16, E505): a person block on a merged-away record never stopped a restart on the
--     survivor. The start check ran under the starting agent's RLS (app.contact_person_ids is INVOKER and contacts RLS
--     hides the closed, unowned loser), and every later check counted only blocks written since the new start. Now
--     the guard asks app.ai_isa_person_blocked (below) over the whole person, the send check counts every unlifted block
--     of the person whenever it was written (lifts are explicit), and the survivor's owner lifts a merged-away record's
--     block after a new message from the person on any record of it.
--  2. db-isa-merge-2 / F6 (R-ISA-22, R-ISA-16, E526): the ai_isa_* rows of a merged-away record were hidden from the
--     survivor's agent and Team Lead (the gap 0075/0077 closed for documents and CMAs). Each SELECT policy (and the
--     block lift's UPDATE policy) also admits a row whose record's ROOT SURVIVOR the caller sees in detail, through
--     0075's app.contact_merge_root, unchanged. For a record never merged away the root is the record itself, so the
--     branch admits nothing new.
--  3. B12X-2 / F3 (R-ISA-30, E521): a handoff no human touch can ever clear (D1 blocks every channel to the person, or
--     the lead is closed) is written with sla_class 'none': no deadline, so no false "not picked up" alert.
--  4. B12X-1 / F4 (R-ISA-13, E532): app.appointments_book_lock refused a person's own edit, reschedule or outcome of a
--     voice-booked appointment once they had added an overlapping one (which E532 allows). The overlap refusal now
--     applies only to the assistant or system booking path, only when the booking is new or its time or organizer
--     moves, and only 'scheduled' counts as busy ('held' is the logged outcome "it took place", never a hold).
--  5. B12X-6 (§5.4): the guard refuses an initiated AI message on a US federal holiday in any zone, re-derived by the
--     immutable app.ai_isa_us_federal_holiday (equal to core usFederalHolidays; the team policy must set
--     noInitiatedOnHolidays, content.ts HOLIDAYS_REQUIRED). It was applied only in TX1.
--  6. B12X-4 (R-ISA-2): stage_automation_decisions.reason adds 'ai_isa_active', the skip stage automation records while
--     the person is under live AI care (0080's enrollment guard rolled the whole decision back, so the scan retried it).
--  7. db-guard-selfcheck-1: the self-check below also asserts D1's refusals and the non-mandate AI-category refusal are
--     still in app.messages_dispatch_guard (0080's DO block checked only the post-0021 markers). b12 recheck R6: that
--     refusal is matched as its own branch (the ELSIF on the AI ISA categories followed by its RAISE): its message text
--     alone is a prefix of the assistant branch's "... mandate (assistant)" refusal, so it proved nothing.
--  8. b12 recheck R19 (R-ISA-30): ai_isa_handoffs.closed_at and closed_reason record that the system closed a done
--     handoff and why ('deadline_met', 'acknowledged', 'lead_closed', 'care_restarted'; b12 recheck R23:
--     'care_continued', the owner's Continue AI care on the continued-from assignment's own handoff), so the panel can
--     say so; only the system sets them, once (the handoff guard), and a close is final.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; docs/ARCHITECTURE.md §21.43):
--   * new function app.ai_isa_person_blocked(uuid, uuid) RETURNS boolean: SECURITY DEFINER (owner app_definer,
--     BYPASSRLS), STABLE, pinned search_path, schema-qualified, writes nothing. True when an unlifted
--     ai_isa_person_blocks row exists on any record of the person of p_contact (app.contact_person_ids run as its owner,
--     which sees every record of the tenant), inside the CALLER's tenant only (p_tenant must equal app.tenant_id();
--     another tenant's id answers false), and only for a caller who may know it (b12 recheck R5): the user who owns the
--     record's root survivor (the start check's caller) or a tenant-wide actor; anyone else gets false, so it is no
--     oracle on records they cannot see. Output: one boolean, never a row, a reason or an id. EXECUTE: app_user only
--     (the guard that calls it is an invoker trigger, so the starter's role needs it).
--   * replaced (invoker, trigger bindings unchanged): app.ai_isa_assignments_guard (the block check only),
--     app.ai_isa_person_blocks_guard (the lift's owner and inbound checks follow the merge root), app.ai_isa_send_check
--     (EXECUTE still only app_definer: the person-block clause and the holiday refusal only), app.appointments_book_lock.
--     Each is 0080's body verbatim except the lines marked "b12 review".
--   * new function app.ai_isa_us_federal_holiday(date): plain SQL, IMMUTABLE, reads nothing.
--   * ALTER POLICY on ai_isa_assignments (select), ai_isa_controls (select), ai_isa_stop_signals (select),
--     ai_isa_person_blocks (select, update), ai_isa_turns, ai_isa_slot_offers, ai_isa_shared_facts, ai_isa_handoffs
--     (isa_select): 0080's expression verbatim OR the root-survivor branch. ai_isa_handoffs isa_update also admits the
--     current owner of the root survivor (the card follows the lead's owner; the guard still allows a user only the
--     acknowledged_* columns, as themselves). Other writes stay as they were (inserts are the system's; an ended
--     assignment never changes).
--     A larger set of readers only for rows of a person the reader already sees, as for documents (0075).
--   * ai_isa_handoffs.sla_class CHECK adds 'none'. No grant changes.
--   * b12 recheck R19: ai_isa_handoffs adds closed_at and closed_reason (CHECKs: a known reason; both or neither).
--     app.ai_isa_handoffs_guard is replaced (invoker, trigger binding unchanged): 0080's body verbatim except the
--     lines marked "b12 recheck R19": closed_* join the columns only the system sets, and once set they never change.
--     No policy or grant changes (isa_update already admits the system; a user still sets only acknowledged_*).
-- =============================================================================

-- =============================================================================
-- 1. db-isa-merge-1: person blocks over the whole person
-- =============================================================================
CREATE FUNCTION app.ai_isa_person_blocked(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_tenant = app.tenant_id()
     -- b12 recheck R5: an answer only for the user who owns the record's root survivor (the start check's caller, whom
     -- the guard has already required to own the record) or a tenant-wide actor (who reads every block row anyway);
     -- anyone else gets false whatever the blocks are (a definer cannot ask the caller's RLS, so ownership is checked)
     AND (app.is_tenant_wide()
          OR (app.actor_kind() = 'user' AND EXISTS (
                SELECT 1 FROM public.contacts r
                 WHERE r.tenant_id = p_tenant AND r.id = app.contact_merge_root(p_tenant, p_contact) AND r.owner_user_id = app.user_id())))
     AND EXISTS (
    SELECT 1 FROM public.ai_isa_person_blocks b
     WHERE b.tenant_id = p_tenant AND b.lifted_at IS NULL AND b.contact_id = ANY (app.contact_person_ids(p_tenant, p_contact)))
$$;
ALTER FUNCTION app.ai_isa_person_blocked(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.ai_isa_person_blocked(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_isa_person_blocked(uuid, uuid) TO app_user;

-- 0080's assignments guard verbatim except the block check (marked)
CREATE OR REPLACE FUNCTION app.ai_isa_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT ct.owner_user_id, ct.ownership_period_seq, ct.merged_into_contact_id, ct.first_touch_at, ct.release_due_at, ct.deleted_at
      INTO c FROM public.contacts ct WHERE ct.tenant_id = NEW.tenant_id AND ct.id = NEW.contact_id;
    IF NOT FOUND OR app.actor_kind() <> 'user' OR NEW.started_by_user_id IS DISTINCT FROM app.user_id()
       OR c.owner_user_id IS DISTINCT FROM app.user_id() OR NEW.owner_user_id IS DISTINCT FROM c.owner_user_id THEN
      RAISE EXCEPTION 'AI_ISA_NOT_OWNER: only the lead''s current owner starts AI care, as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF c.merged_into_contact_id IS NOT NULL OR c.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'AI_ISA_NOT_ROOT: start AI care on the surviving record' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.bound_ownership_seq IS DISTINCT FROM c.ownership_period_seq THEN
      RAISE EXCEPTION 'AI_ISA_STALE_OWNERSHIP: the ownership period changed' USING ERRCODE = 'check_violation';
    END IF;
    IF c.first_touch_at IS NULL AND c.release_due_at IS NOT NULL THEN
      RAISE EXCEPTION 'AI_ISA_FIRST_TOUCH_PENDING: text or call them yourself first' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ai_isa_agent_optins o
                    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.optin_id AND o.user_id = NEW.owner_user_id AND o.status = 'active'
                      AND o.playbook_version_id = NEW.playbook_version_id) THEN
      RAISE EXCEPTION 'AI_ISA_NO_OPTIN: opt in to the AI assistant first' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.playbook_versions v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.playbook_version_id AND v.status = 'approved') THEN
      RAISE EXCEPTION 'AI_ISA_POLICY_NOT_APPROVED' USING ERRCODE = 'check_violation';
    END IF;
    -- b12 review db-isa-merge-1: the whole person past the starter's RLS (a merged-away record is hidden from them)
    IF app.ai_isa_person_blocked(NEW.tenant_id, NEW.contact_id) THEN
      RAISE EXCEPTION 'AI_ISA_PERSON_DECLINED: this person declined or stopped AI care' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.ended_at IS NOT NULL OR NEW.paused_at IS NOT NULL OR NEW.epoch <> 1 THEN
      RAISE EXCEPTION 'AI_ISA_START_SHAPE' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'AI_ISA_ENDED: an ended assignment never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.contact_id, NEW.owner_user_id, NEW.optin_id, NEW.playbook_version_id, NEW.bound_ownership_seq,
      NEW.bound_points, NEW.side, NEW.started_by_user_id, NEW.started_at, NEW.from_handback_id, NEW.continued_from_assignment_id)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.contact_id, OLD.owner_user_id, OLD.optin_id, OLD.playbook_version_id,
      OLD.bound_ownership_seq, OLD.bound_points, OLD.side, OLD.started_by_user_id, OLD.started_at, OLD.from_handback_id,
      OLD.continued_from_assignment_id) THEN
    RAISE EXCEPTION 'AI_ISA_IMMUTABLE: the assignment''s bindings never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.epoch < OLD.epoch THEN RAISE EXCEPTION 'AI_ISA_EPOCH_MONOTONE' USING ERRCODE = 'check_violation'; END IF;
  IF app.actor_kind() = 'user' THEN
    -- a user resumes (clears paused_at) only as the owner, and the epoch increments (stale actions are refused)
    IF OLD.paused_at IS NOT NULL AND NEW.paused_at IS NULL THEN
      IF app.user_id() IS DISTINCT FROM OLD.owner_user_id OR NEW.epoch <> OLD.epoch + 1 THEN
        RAISE EXCEPTION 'AI_ISA_RESUME_OWNER_ONLY: only the lead''s owner resumes AI care' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.epoch <> OLD.epoch THEN
      RAISE EXCEPTION 'AI_ISA_EPOCH_ON_RESUME_ONLY' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.paused_at IS NOT NULL AND OLD.paused_at IS NULL
       AND (NEW.paused_by_kind <> 'user' OR NEW.paused_by_user_id IS DISTINCT FROM app.user_id()) THEN
      RAISE EXCEPTION 'AI_ISA_PAUSE_AS_SELF' USING ERRCODE = 'check_violation';
    END IF;
    -- ending: the owner, a Team Lead of the owner's team, or Owner/Admin
    IF NEW.ended_at IS NOT NULL AND NOT (app.user_id() = OLD.owner_user_id OR app.is_tenant_wide()
         OR (app.my_role() = 'team_lead' AND OLD.owner_user_id = ANY (app.my_team_member_ids()))) THEN
      RAISE EXCEPTION 'AI_ISA_END_NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.ended_at IS NOT NULL AND (NEW.ended_by_kind <> 'user' OR NEW.ended_by_user_id IS DISTINCT FROM app.user_id()) THEN
      RAISE EXCEPTION 'AI_ISA_END_AS_SELF' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- the system never clears a pause and never moves the epoch (R-ISA-15)
    IF OLD.paused_at IS NOT NULL AND NEW.paused_at IS NULL THEN
      RAISE EXCEPTION 'AI_ISA_SYSTEM_NEVER_RESUMES: only the lead''s owner resumes AI care' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.epoch <> OLD.epoch THEN RAISE EXCEPTION 'AI_ISA_EPOCH_ON_RESUME_ONLY' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.paused_at IS NOT NULL AND OLD.paused_at IS NULL AND NEW.paused_by_kind <> 'system' THEN
      RAISE EXCEPTION 'AI_ISA_PAUSE_AS_SELF' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.ended_at IS NOT NULL AND NEW.ended_by_kind <> 'system' THEN
      RAISE EXCEPTION 'AI_ISA_END_AS_SELF' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 0080's person-blocks guard verbatim except the lift's owner and inbound checks (marked)
CREATE OR REPLACE FUNCTION app.ai_isa_person_blocks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF app.actor_kind() = 'system' AND OLD.lifted_at IS NULL AND NEW.lifted_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.lifted_at IS NOT NULL
     OR (NEW.tenant_id, NEW.id, NEW.contact_id, NEW.assignment_id, NEW.reason, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.contact_id, OLD.assignment_id, OLD.reason, OLD.created_at)
     OR app.actor_kind() <> 'user' OR NEW.lifted_by_user_id IS DISTINCT FROM app.user_id()
     -- b12 review db-isa-merge-1: the owner of the record's root survivor (the record itself when never merged away)
     OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = NEW.tenant_id AND c.id = app.contact_merge_root(NEW.tenant_id, NEW.contact_id)
                     AND c.owner_user_id = app.user_id())
     OR NOT EXISTS (SELECT 1 FROM public.messages m
                     WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.lift_inbound_message_id AND m.direction = 'inbound'
                       AND m.contact_id = ANY (app.contact_merge_tree_ids(NEW.tenant_id, app.contact_merge_root(NEW.tenant_id, NEW.contact_id)))
                       AND m.created_at > OLD.created_at)
     OR (OLD.reason IN ('opted_out','do_not_contact','wrong_number') ) THEN
    RAISE EXCEPTION 'AI_ISA_BLOCK_LIFT_REFUSED: a block lifts only by the owner, after a new message from the person, with an attestation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================
-- 2. db-isa-merge-2 / F6: the root-survivor branch on the AI ISA read policies (0075/0077's rule)
-- =============================================================================
ALTER POLICY assignments_select ON ai_isa_assignments USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)
  OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));
ALTER POLICY controls_select ON ai_isa_controls USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)
  OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));
ALTER POLICY stop_signals_select ON ai_isa_stop_signals USING ((SELECT app.is_tenant_wide())
  OR (contact_id IS NOT NULL AND (app.contact_detail_visible(tenant_id, contact_id)
      OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)))));
ALTER POLICY blocks_select ON ai_isa_person_blocks USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)
  OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));
ALTER POLICY blocks_update ON ai_isa_person_blocks
  USING ((SELECT app.actor_kind()) = 'system' OR app.contact_detail_visible(tenant_id, contact_id)
         OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' OR app.contact_detail_visible(tenant_id, contact_id)
         OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));
-- the handoff ack: also the CURRENT owner of the record its merge chain ends at (b12 review F2, F3: a pending handoff's
-- card follows the lead's current owner, while recipient_user_id stays frozen; the guard still lets a user set only
-- acknowledged_* and only as themselves)
ALTER POLICY isa_update ON ai_isa_handoffs
  USING ((SELECT app.actor_kind()) = 'system' OR recipient_user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide())
         OR EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = ai_isa_handoffs.tenant_id
                      AND c.id = app.contact_merge_root(ai_isa_handoffs.tenant_id, ai_isa_handoffs.contact_id) AND c.owner_user_id = (SELECT app.user_id())))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' OR recipient_user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide())
         OR EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = ai_isa_handoffs.tenant_id
                      AND c.id = app.contact_merge_root(ai_isa_handoffs.tenant_id, ai_isa_handoffs.contact_id) AND c.owner_user_id = (SELECT app.user_id())));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_isa_turns','ai_isa_slot_offers','ai_isa_shared_facts','ai_isa_handoffs'] LOOP
    EXECUTE format('ALTER POLICY isa_select ON %I USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)
      OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)))', t);
  END LOOP;
END $$;

-- =============================================================================
-- 3. B12X-2 / F3: a handoff with no deadline (no human touch can clear it)
-- =============================================================================
ALTER TABLE ai_isa_handoffs DROP CONSTRAINT ai_isa_handoffs_sla_class_check;
ALTER TABLE ai_isa_handoffs ADD CONSTRAINT ai_isa_handoffs_sla_class_check CHECK (sla_class IN ('critical','high','normal','low','none'));
ALTER TABLE ai_isa_handoffs ADD CONSTRAINT ai_isa_handoffs_no_deadline CHECK (sla_class <> 'none' OR (sla_due_at = created_at AND sla_escalation_level = 0));

-- =============================================================================
-- 4. B12X-1 / F4: the assistant books no overlap; a person's own edits and outcomes are never refused (E532)
-- =============================================================================
CREATE OR REPLACE FUNCTION app.appointments_book_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('calendar.book:' || NEW.tenant_id::text || ':' || NEW.user_id::text, 0));
  -- b12 review B12X-1/F4: only the assistant or system booking path (never a person's write), only a new booking or
  -- one whose time or organizer moves (or that is scheduled again), and only 'scheduled' is busy ('held' is the outcome)
  IF NEW.created_by_kind = 'assistant' AND NEW.status = 'scheduled' AND app.actor_kind() IS DISTINCT FROM 'user'
     AND (TG_OP = 'INSERT' OR (NEW.starts_at, NEW.ends_at, NEW.user_id) IS DISTINCT FROM (OLD.starts_at, OLD.ends_at, OLD.user_id)
          OR OLD.status IS DISTINCT FROM 'scheduled')
     AND EXISTS (SELECT 1 FROM public.appointments o
                  WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id AND o.id <> NEW.id
                    AND o.status = 'scheduled' AND o.starts_at < NEW.ends_at AND o.ends_at > NEW.starts_at) THEN
    RAISE EXCEPTION 'APPOINTMENT_OVERLAP: the organizer already has an appointment at that time' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================
-- 5. B12X-6 and db-isa-merge-1 in the send check
-- =============================================================================
-- US federal holidays, as core usFederalHolidays (packages/core/src/isa/zones.ts): the five fixed dates observed on the
-- Friday before a Saturday or the Monday after a Sunday (New Year's Day of the next year on Dec 31), and the five
-- Monday holidays and Thanksgiving. VERIFY WITH COUNSEL (C-ISA-8) like the rest of the window.
CREATE FUNCTION app.ai_isa_us_federal_holiday(d date) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
      SELECT 1 FROM (VALUES (1, 1), (6, 19), (7, 4), (11, 11), (12, 25)) f(m, dd), (VALUES (0), (1)) y(k),
        LATERAL (SELECT make_date(extract(year FROM d)::int + y.k, f.m, f.dd) AS h) x
       WHERE d = x.h OR (extract(isodow FROM x.h) = 6 AND d = x.h - 1) OR (extract(isodow FROM x.h) = 7 AND d = x.h + 1))
    OR (extract(isodow FROM d) = 1 AND (
          (extract(month FROM d) IN (1, 2) AND extract(day FROM d) BETWEEN 15 AND 21)   -- MLK Day, Washington's Birthday
       OR (extract(month FROM d) = 5 AND extract(day FROM d) >= 25)                     -- Memorial Day
       OR (extract(month FROM d) = 9 AND extract(day FROM d) <= 7)                      -- Labor Day
       OR (extract(month FROM d) = 10 AND extract(day FROM d) BETWEEN 8 AND 14)))       -- Columbus Day
    OR (extract(isodow FROM d) = 4 AND extract(month FROM d) = 11 AND extract(day FROM d) BETWEEN 22 AND 28)  -- Thanksgiving
$$;
REVOKE ALL ON FUNCTION app.ai_isa_us_federal_holiday(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_isa_us_federal_holiday(date) TO app_user, app_definer;

-- 0080's send check verbatim except the person-block clause and the holiday refusal (marked)
CREATE OR REPLACE FUNCTION app.ai_isa_send_check(m public.messages) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE
  aa record; t record; asg record; c record; ts record; pack jsonb; person uuid[]; bound_id uuid; ch text; pk text;
  hmacs bytea[]; live boolean; post boolean; has_facts boolean; reply_ok boolean; tier text; minz text[]; z text;
  wstart time; wend time; caps jsonb; n_ai int; n_auto int; n_init24 int; n_init7 int; last_ai timestamptz; d12 timestamptz;
  v_day date; got int; ok boolean; lt timestamp; isa_cats text[] := ARRAY['ai_isa_message','ai_isa_confirmation','ai_isa_holding_line'];
  counted text[] := ARRAY['dispatching','dispatch_unknown','sent','delivered','failed','undelivered'];
BEGIN
  SELECT x.kind, x.status, x.contact_id, x.pinned_inbound_seq, x.epoch, x.ai_isa_turn_id, x.action_category, x.playbook_version_id
    INTO aa FROM public.assistant_actions x WHERE x.tenant_id = m.tenant_id AND x.id = m.assistant_action_id;
  -- ---- binding ----
  IF aa.kind IS DISTINCT FROM 'ai_isa_message' OR aa.status IS DISTINCT FROM 'proposed' THEN
    RAISE EXCEPTION 'ASSISTANT_ACTION_WITHDRAWN: this AI assistant message was withdrawn before it went out' USING ERRCODE = 'check_violation';
  END IF;
  IF m.action_category IS DISTINCT FROM aa.action_category OR NOT (m.action_category = ANY (isa_cats)) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the message category is not an AI assistant category' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO t FROM public.ai_isa_turns x WHERE x.tenant_id = m.tenant_id AND x.id = aa.ai_isa_turn_id;
  IF NOT FOUND OR t.message_id IS DISTINCT FROM m.id OR t.assistant_action_id IS DISTINCT FROM m.assistant_action_id THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the message is not bound to its turn' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO asg FROM public.ai_isa_assignments x WHERE x.tenant_id = m.tenant_id AND x.id = t.assignment_id;
  IF NOT FOUND OR aa.contact_id IS DISTINCT FROM m.contact_id OR asg.contact_id IS DISTINCT FROM m.contact_id THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the message is not for the person under AI care' USING ERRCODE = 'check_violation';
  END IF;
  IF m.purpose IS DISTINCT FROM 'marketing' OR t.purpose IS DISTINCT FROM 'marketing' THEN
    RAISE EXCEPTION 'ISA_PURPOSE_MISMATCH: AI assistant messages are sent as marketing' USING ERRCODE = 'check_violation';
  END IF;
  IF m.channel NOT IN ('sms','email') OR t.channel IS DISTINCT FROM m.channel THEN
    RAISE EXCEPTION 'ISA_CHANNEL_NOT_ALLOWED: the AI assistant texts and emails only' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message_media mm WHERE mm.tenant_id = m.tenant_id AND mm.message_id = m.id) THEN
    RAISE EXCEPTION 'ISA_CHANNEL_NOT_ALLOWED: the AI assistant never sends media' USING ERRCODE = 'check_violation';
  END IF;
  IF encode(sha256(convert_to(m.body, 'UTF8')), 'hex') IS DISTINCT FROM t.body_sha256 THEN
    RAISE EXCEPTION 'ISA_BODY_CHANGED: the message text changed after the turn froze it' USING ERRCODE = 'check_violation';
  END IF;
  ch := m.channel; pk := CASE WHEN ch = 'sms' THEN 'phone' ELSE 'email' END;
  bound_id := NULLIF(asg.bound_points -> ch ->> 'point_id', '')::uuid;
  IF bound_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.contact_points p
                                      WHERE p.tenant_id = m.tenant_id AND p.id = bound_id AND p.contact_id = asg.contact_id
                                        AND p.kind = pk AND p.address = m.to_address AND p.removed_at IS NULL
                                        AND encode(p.address_hmac, 'hex') = asg.bound_points -> ch ->> 'hmac') THEN
    RAISE EXCEPTION 'ISA_UNBOUND_RECIPIENT: AI assistant messages go only to the address bound at start' USING ERRCODE = 'check_violation';
  END IF;

  person := app.contact_person_ids(m.tenant_id, asg.contact_id);
  hmacs := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                  WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person)
                    AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number') ORDER BY 1);

  -- ---- liveness: live care, or the post-handoff closed set ----
  live := asg.ended_at IS NULL;
  post := NOT live AND m.action_category IN ('ai_isa_confirmation','ai_isa_holding_line');
  IF EXISTS (SELECT 1 FROM public.ai_isa_stop_signals s WHERE s.tenant_id = m.tenant_id AND s.created_at >= asg.started_at
               AND (s.address_hmac = ANY (hmacs) OR s.contact_id = ANY (person)))
     -- b12 review db-isa-merge-1: every unlifted block of the person, whenever it was written (lifts are explicit)
     OR EXISTS (SELECT 1 FROM public.ai_isa_person_blocks b WHERE b.tenant_id = m.tenant_id AND b.contact_id = ANY (person) AND b.lifted_at IS NULL) THEN
    RAISE EXCEPTION 'ISA_STOPPED: an opt-out, suppression or do-not-contact stopped AI care' USING ERRCODE = 'check_violation';
  END IF;
  IF live THEN
    IF asg.paused_at IS NOT NULL THEN
      RAISE EXCEPTION 'ISA_PAUSED: AI care is paused' USING ERRCODE = 'check_violation';
    END IF;
    IF aa.epoch IS DISTINCT FROM asg.epoch THEN
      RAISE EXCEPTION 'ISA_STALE_EPOCH: AI care was paused and resumed after this message was written' USING ERRCODE = 'check_violation';
    END IF;
    IF aa.pinned_inbound_seq IS DISTINCT FROM (SELECT cv.inbound_seq FROM public.conversations cv WHERE cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id) THEN
      RAISE EXCEPTION 'ISA_STALE_REPLY: the person wrote again after this message was written' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF post THEN
    IF NOT EXISTS (SELECT 1 FROM public.ai_isa_handoffs h WHERE h.tenant_id = m.tenant_id AND h.assignment_id = asg.id AND h.pending_message_id = m.id)
       OR EXISTS (SELECT 1 FROM public.ai_isa_handoffs h JOIN public.messages hm ON hm.tenant_id = h.tenant_id
                   WHERE h.tenant_id = m.tenant_id AND h.assignment_id = asg.id AND hm.contact_id = ANY (person)
                     AND hm.direction = 'outbound' AND hm.initiator = 'human' AND hm.created_at > h.created_at
                     AND hm.status NOT IN ('canceled','blocked'))
       OR EXISTS (SELECT 1 FROM public.ai_isa_handoffs h JOIN public.calls cl ON cl.tenant_id = h.tenant_id
                   WHERE h.tenant_id = m.tenant_id AND h.assignment_id = asg.id AND cl.contact_id = ANY (person) AND cl.created_at > h.created_at) THEN
      RAISE EXCEPTION 'ISA_HANDOFF_CLOSED: after a handoff only its pending confirmation or holding line may go, until a person takes over'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'ISA_PAUSED: AI care has ended' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- the chain (§3.1 links 2–6) ----
  SELECT j.rules INTO pack FROM public.jurisdiction_packs j WHERE j.key = 'platform:ai_isa' AND j.status = 'published';
  SELECT s.ai_enabled, s.ai_isa_enabled, s.ai_isa_daily_cap, s.default_timezone, s.team_name, s.brokerage_legal_name
    INTO ts FROM public.tenant_settings s WHERE s.tenant_id = m.tenant_id;
  IF NOT app.platform_cleared('platform:ai_isa') OR pack IS NULL THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: platform:ai_isa is not cleared by counsel' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(ts.ai_enabled, false) OR NOT COALESCE(ts.ai_isa_enabled, false) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the AI assistant is off for this team' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT live THEN NULL;  -- post-handoff: the policy and opt-in may have moved on; the confirmation was approved at handoff
  ELSIF NOT EXISTS (
      SELECT 1 FROM public.playbook_versions v
       WHERE v.tenant_id = m.tenant_id AND v.id = asg.playbook_version_id
         AND ((v.status = 'approved'
               AND (SELECT pa.decision = 'approve' AND pa.content_sha256 = v.content_sha256 FROM public.playbook_approvals pa
                     WHERE pa.tenant_id = v.tenant_id AND pa.playbook_version_id = v.id ORDER BY pa.decided_at DESC LIMIT 1))
              OR (v.status = 'superseded'
                  AND NOT EXISTS (SELECT 1 FROM public.playbook_versions w WHERE w.tenant_id = v.tenant_id AND w.playbook_id = v.playbook_id
                                    AND w.version_no > v.version_no AND w.status IN ('approved','superseded','revoked')
                                    AND (w.status = 'revoked' OR w.narrows_previous IS NOT TRUE))
                  AND EXISTS (SELECT 1 FROM public.playbook_versions w WHERE w.tenant_id = v.tenant_id AND w.playbook_id = v.playbook_id
                                AND w.version_no > v.version_no AND w.status = 'approved')))) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the team''s AI assistant policy is not approved' USING ERRCODE = 'check_violation';
  ELSIF NOT EXISTS (SELECT 1 FROM public.ai_isa_agent_optins o WHERE o.tenant_id = m.tenant_id AND o.id = asg.optin_id AND o.status = 'active'
                      AND o.user_id = asg.owner_user_id AND o.attestation_sha256 = encode(sha256(convert_to(o.attestation, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the agent''s AI assistant opt-in is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ct.owner_user_id, ct.ownership_period_seq, ct.merged_into_contact_id, ct.deleted_at, ct.timezone, ct.timezone_source
    INTO c FROM public.contacts ct WHERE ct.tenant_id = m.tenant_id AND ct.id = asg.contact_id;
  IF live AND (c.owner_user_id IS DISTINCT FROM asg.owner_user_id OR c.ownership_period_seq IS DISTINCT FROM asg.bound_ownership_seq
               OR c.merged_into_contact_id IS NOT NULL OR c.deleted_at IS NOT NULL
               OR NOT EXISTS (SELECT 1 FROM public.memberships mb WHERE mb.tenant_id = m.tenant_id AND mb.user_id = asg.owner_user_id AND mb.status = 'active')) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the lead''s owner or ownership period changed' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- shared address and active client (R-ISA-2) ----
  IF EXISTS (SELECT 1 FROM public.contact_points p JOIN public.contacts o ON o.tenant_id = p.tenant_id AND o.id = p.contact_id
              WHERE p.tenant_id = m.tenant_id AND p.address_hmac = ANY (hmacs) AND p.removed_at IS NULL
                AND NOT (p.contact_id = ANY (person)) AND o.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ISA_SHARED_ADDRESS: another person shares this address' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.deal_contacts dc JOIN public.deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
              WHERE dc.tenant_id = m.tenant_id AND dc.contact_id = ANY (person) AND d.stage NOT IN ('closed','lost'))
     OR EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = m.tenant_id AND d.primary_contact_id = ANY (person) AND d.stage NOT IN ('closed','lost'))
     OR EXISTS (SELECT 1 FROM public.listing_contacts lc JOIN public.listings l ON l.tenant_id = lc.tenant_id AND l.id = lc.listing_id
                 WHERE lc.tenant_id = m.tenant_id AND lc.contact_id = ANY (person) AND l.source = 'team'
                   AND l.status IN ('coming_soon','active','pending')) THEN
    RAISE EXCEPTION 'ISA_ACTIVE_CLIENT: this person is a client on an open deal or an active listing' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- an unread MMS text part of an inbound since care started ----
  IF EXISTS (SELECT 1 FROM public.message_text_parts tp JOIN public.messages im ON im.tenant_id = tp.tenant_id AND im.id = tp.message_id
              WHERE tp.tenant_id = m.tenant_id AND im.conversation_id = m.conversation_id AND im.direction = 'inbound'
                AND im.created_at >= asg.started_at AND tp.status = 'pending') THEN
    RAISE EXCEPTION 'ISA_UNREAD_PART: a message part from the person has not been read yet' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- seller packs (12g) ----
  has_facts := EXISTS (SELECT 1 FROM public.ai_isa_shared_facts f WHERE f.tenant_id = m.tenant_id AND f.message_id = m.id);
  IF EXISTS (SELECT 1 FROM public.ai_isa_shared_facts f WHERE f.tenant_id = m.tenant_id AND f.message_id = m.id AND f.fact_kind IN ('sold_comp_set','nearby_sale'))
     AND NOT (app.platform_cleared('platform:cma') AND app.platform_cleared('platform:ai_isa_seller_data')) THEN
    RAISE EXCEPTION 'ISA_SELLER_DATA_NOT_CLEARED: recent sales wait on counsel review of platform:cma and platform:ai_isa_seller_data' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- consent evidence, re-derived (R-ISA-9) ----
  -- a revoke of either purpose on any of the person's points of this channel blocks every AI message on it
  IF EXISTS (SELECT 1 FROM public.consent_state cs JOIN public.contact_points p ON p.tenant_id = cs.tenant_id AND p.address_hmac = cs.address_hmac
              WHERE cs.tenant_id = m.tenant_id AND cs.channel = ch AND cs.status = 'revoked' AND p.contact_id = ANY (person) AND p.kind = pk
                AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number')) THEN
    RAISE EXCEPTION 'ISA_CONSENT_EVIDENCE_MISSING: this person opted out on this channel' USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(om.dispatched_at) INTO last_ai FROM public.messages om
   WHERE om.tenant_id = m.tenant_id AND om.conversation_id = m.conversation_id AND om.channel = ch AND om.id <> m.id
     AND om.initiator = 'assistant' AND om.action_category = ANY (isa_cats) AND om.status = ANY (counted);
  reply_ok := EXISTS (SELECT 1 FROM public.messages im
                       WHERE im.tenant_id = m.tenant_id AND im.conversation_id = m.conversation_id AND im.direction = 'inbound'
                         AND im.channel = ch AND im.from_address = m.to_address AND NOT im.is_auto_reply
                         AND im.created_at >= now() - make_interval(hours => COALESCE((pack->>'reply_window_hours')::int, 24))
                         AND im.created_at > COALESCE(last_ai, '-infinity'::timestamptz)
                         AND (ch <> 'email' OR im.email_dkim_aligned IS TRUE));
  tier := CASE WHEN reply_ok AND NOT has_facts THEN 'reply' ELSE 'initiated' END;
  IF t.message_kind = 'reply' AND tier = 'initiated' AND NOT has_facts THEN
    RAISE EXCEPTION 'ISA_REPLY_WINDOW_CLOSED: the reply window of the person''s own message has closed' USING ERRCODE = 'check_violation';
  END IF;
  IF tier = 'initiated' THEN
    d12 := NULLIF(pack->>'d12_effective_at', '')::timestamptz;
    ok := d12 IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.consent_events g
        LEFT JOIN public.consent_disclosures d ON d.tenant_id = g.tenant_id AND d.id = g.disclosure_id
       WHERE g.tenant_id = m.tenant_id AND g.event_type = 'grant' AND g.channel = ch AND g.purpose IN ('marketing','all')
         AND g.address_hmac = decode(asg.bound_points -> ch ->> 'hmac', 'hex')
         AND NOT g.imported AND g.source <> 'agent_entry' AND g.needs_review IS NOT TRUE
         AND (CASE WHEN ch = 'sms' THEN g.consent_level = 'express_written' ELSE g.consent_level IN ('inquiry','express','express_written') END)
         AND (g.expires_at IS NULL OR g.expires_at > now())
         AND (g.occurred_at >= d12 OR g.source = 'signed_document')
         AND ((g.source = 'signed_document' AND g.evidence_object_id IS NOT NULL)
              OR (d.id IS NOT NULL AND d.scope_stated IS TRUE AND ch = ANY (d.channel_scope) AND 'marketing' = ANY (d.purpose_scope)
                  AND EXISTS (SELECT 1 FROM public.lead_inquiries li WHERE li.tenant_id = d.tenant_id AND li.consent_disclosure_id = d.id
                                AND li.contact_id = ANY (person))
                  AND NOT EXISTS (SELECT 1 FROM public.lead_sources ls WHERE ls.tenant_id = d.tenant_id AND ls.consent_disclosure_id = d.id)
                  AND ((length(btrim(COALESCE(ts.team_name, ''))) > 0 AND position(lower(ts.team_name) IN lower(d.body)) > 0)
                       OR position(lower(ts.brokerage_legal_name) IN lower(d.body)) > 0)))
         AND NOT EXISTS (SELECT 1 FROM public.consent_events r
                          WHERE r.tenant_id = g.tenant_id AND r.channel = ch AND r.event_type IN ('revoke','expire','import_revert')
                            AND r.occurred_at > g.occurred_at
                            AND r.address_hmac = ANY (ARRAY(SELECT p.address_hmac FROM public.contact_points p
                                                             WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person) AND p.kind = pk))));
    IF NOT ok THEN
      RAISE EXCEPTION 'ISA_CONSENT_EVIDENCE_MISSING: initiated AI messages and facts need written consent from the person''s own form'
        USING ERRCODE = 'check_violation';
    END IF;
    IF ch = 'sms' AND NOT EXISTS (SELECT 1 FROM public.dnc_checks k
                                   WHERE k.tenant_id = m.tenant_id AND k.phone_hmac = decode(asg.bound_points -> 'sms' ->> 'hmac', 'hex')
                                     AND k.listed = false AND k.registry = 'us_national' AND k.valid_until > now()
                                     AND k.checked_at >= now() - make_interval(days => COALESCE((pack->>'dnc_freshness_days')::int, 31))) THEN
      RAISE EXCEPTION 'ISA_DNC_UNVERIFIED: an initiated AI text needs a fresh national Do Not Call result' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ---- quiet hours (R-ISA-10): the turn's zones cover the DB-derived minimum set; every zone is inside the window ----
  IF c.timezone_source = 'explicit' AND c.timezone IS NOT NULL THEN
    minz := ARRAY[c.timezone];
  ELSE
    minz := ARRAY(SELECT DISTINCT zz FROM (
      SELECT jsonb_array_elements_text(COALESCE(pack->'continental_zones', '[]')) AS zz
      UNION SELECT ts.default_timezone
      UNION SELECT acz.zone FROM public.contact_points p JOIN public.ai_isa_area_code_zones acz ON acz.area_code = substr(p.address, 3, 3)
             WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person) AND p.kind = 'phone' AND p.address LIKE '+1%'
      UNION SELECT p.timezone FROM public.contact_points p WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person) AND p.timezone IS NOT NULL
      UNION SELECT sz.zone FROM public.contact_addresses ca JOIN public.ai_isa_state_zones sz ON sz.state = upper(ca.region)
             WHERE ca.tenant_id = m.tenant_id AND ca.contact_id = ANY (person)) q WHERE zz IS NOT NULL);
  END IF;
  IF t.zones IS NULL OR NOT (minz <@ t.zones) THEN
    RAISE EXCEPTION 'ISA_ZONE_UNRESOLVED: the turn''s time zones do not cover every zone the person may be in' USING ERRCODE = 'check_violation';
  END IF;
  wstart := greatest(t.window_start, COALESCE((pack #>> '{window_ceiling,start}')::time, '08:00'));
  wend := least(t.window_end, COALESCE((pack #>> '{window_ceiling,end}')::time, '20:00'));
  FOREACH z IN ARRAY t.zones LOOP
    lt := now() AT TIME ZONE z;
    IF NOT (lt::time >= wstart AND lt::time < wend) THEN
      RAISE EXCEPTION 'ISA_QUIET_HOURS: it is outside the send window in %', z USING ERRCODE = 'check_violation';
    END IF;
    IF tier = 'initiated' AND NOT (extract(isodow FROM lt)::int IN (SELECT jsonb_array_elements_text(COALESCE(pack->'initiated_days', '[1,2,3,4,5,6]'))::int)) THEN
      RAISE EXCEPTION 'ISA_QUIET_HOURS: initiated AI messages wait for a permitted day in %', z USING ERRCODE = 'check_violation';
    END IF;
    -- b12 review B12X-6 (§5.4): never on a US federal holiday in any zone (the team policy must set noInitiatedOnHolidays)
    IF tier = 'initiated' AND app.ai_isa_us_federal_holiday(lt::date) THEN
      RAISE EXCEPTION 'ISA_QUIET_HOURS: initiated AI messages wait past a federal holiday in %', z USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- ---- caps (R-ISA-11): sorted per-address locks, then counts across all the person's addresses ----
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_isa.send:' || m.tenant_id::text || ':' || encode(h, 'hex'), 0)) FROM unnest(hmacs) h ORDER BY h;
  caps := COALESCE(pack->'caps', '{}');
  SELECT count(*) FILTER (WHERE om.initiator = 'assistant' AND om.action_category = ANY (isa_cats)),
         count(*) FILTER (WHERE om.initiator IN ('assistant','system') OR om.bulk_action_id IS NOT NULL OR om.marketing_piece_id IS NOT NULL),
         max(om.dispatched_at) FILTER (WHERE om.initiator = 'assistant' AND om.action_category = ANY (isa_cats))
    INTO n_ai, n_auto, last_ai
    FROM public.messages om
   WHERE om.tenant_id = m.tenant_id AND om.contact_id = ANY (person) AND om.direction = 'outbound' AND om.id <> m.id
     AND om.status = ANY (counted) AND om.dispatched_at >= now() - interval '24 hours';
  IF n_ai >= COALESCE((caps->>'ai24h')::int, 3) OR n_auto >= COALESCE((caps->>'automated24h')::int, 3) THEN
    RAISE EXCEPTION 'ISA_CAP_REACHED: this person had the most messages allowed in 24 hours' USING ERRCODE = 'check_violation';
  END IF;
  IF last_ai IS NOT NULL AND last_ai > now() - make_interval(secs => COALESCE((caps->>'min_gap_seconds')::int, 120)) THEN
    RAISE EXCEPTION 'ISA_MIN_GAP: AI assistant messages are spaced at least two minutes apart' USING ERRCODE = 'check_violation';
  END IF;
  IF t.message_kind = 'initiated' OR tier = 'initiated' THEN
    SELECT count(*) FILTER (WHERE om.dispatched_at >= now() - interval '24 hours'), count(*) INTO n_init24, n_init7
      FROM public.messages om JOIN public.ai_isa_turns tt ON tt.tenant_id = om.tenant_id AND tt.message_id = om.id
     WHERE om.tenant_id = m.tenant_id AND om.contact_id = ANY (person) AND om.id <> m.id AND om.status = ANY (counted)
       AND tt.message_kind = 'initiated' AND om.dispatched_at >= now() - interval '7 days';
    IF n_init24 >= COALESCE((caps->>'initiated24h')::int, 1) OR n_init7 >= COALESCE((caps->>'initiated7d')::int, 3) THEN
      RAISE EXCEPTION 'ISA_CAP_REACHED: initiated AI messages are limited per day and week' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_day := (now() AT TIME ZONE ts.default_timezone)::date;
  INSERT INTO public.ai_isa_daily_counts AS dc (tenant_id, local_day, n)
  SELECT m.tenant_id, v_day, 1 WHERE ts.ai_isa_daily_cap >= 1
  ON CONFLICT (tenant_id, local_day) DO UPDATE SET n = dc.n + 1 WHERE dc.n < ts.ai_isa_daily_cap
  RETURNING dc.n INTO got;
  IF got IS NULL THEN
    RAISE EXCEPTION 'ISA_CAP_REACHED: the team''s daily AI assistant limit is reached' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- =============================================================================
-- 6. B12X-4 (R-ISA-2): stage automation records its skip under live AI care (decide.ts SKIP_REASONS)
-- =============================================================================
ALTER TABLE stage_automation_decisions DROP CONSTRAINT stage_automation_decisions_reason_check;
ALTER TABLE stage_automation_decisions ADD CONSTRAINT stage_automation_decisions_reason_check
  CHECK (reason IN ('not_a_person_change','person_removed','stage_changed_again','not_visible',
                    'plan_not_approved','already_in_a_plan','cannot_be_reached','protected_audience','ai_isa_active'));

-- =============================================================================
-- 7. b12 recheck R19 (R-ISA-30): a handoff's closed marker (why it is done)
-- =============================================================================
ALTER TABLE ai_isa_handoffs ADD COLUMN closed_at timestamptz,
  -- b12 recheck R23: 'care_continued' (the owner's Continue AI care decides the continued-from assignment's handoff)
  ADD COLUMN closed_reason text CONSTRAINT ai_isa_handoffs_closed_reason_check CHECK (closed_reason IN ('deadline_met','acknowledged','lead_closed','care_restarted','care_continued'));
ALTER TABLE ai_isa_handoffs ADD CONSTRAINT ai_isa_handoffs_closed_pair CHECK ((closed_at IS NULL) = (closed_reason IS NULL));

-- 0080's handoffs guard verbatim except the lines marked "b12 recheck R19"
CREATE OR REPLACE FUNCTION app.ai_isa_handoffs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.assignment_id, NEW.contact_id, NEW.reason, NEW.basis, NEW.assistant_action_id, NEW.appointment_id,
      NEW.package, NEW.package_sha256, NEW.sla_class, NEW.recipient_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.assignment_id, OLD.contact_id, OLD.reason, OLD.basis, OLD.assistant_action_id,
      OLD.appointment_id, OLD.package, OLD.package_sha256, OLD.sla_class, OLD.recipient_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'AI_ISA_HANDOFF_FROZEN: a handoff package never changes' USING ERRCODE = 'check_violation';
  END IF;
  -- b12 recheck R19: closed_* are the system's too
  IF app.actor_kind() <> 'system' AND (NEW.pending_message_id, NEW.confirmation_status, NEW.sla_due_at, NEW.sla_met_at,
       NEW.sla_escalated_at, NEW.sla_escalation_level, NEW.closed_at, NEW.closed_reason) IS DISTINCT FROM (OLD.pending_message_id, OLD.confirmation_status, OLD.sla_due_at,
       OLD.sla_met_at, OLD.sla_escalated_at, OLD.sla_escalation_level, OLD.closed_at, OLD.closed_reason) THEN
    RAISE EXCEPTION 'AI_ISA_HANDOFF_ACK_ONLY: "Got it" acknowledges; only a human touch clears the deadline' USING ERRCODE = 'check_violation';
  END IF;
  -- b12 recheck R19: a close is final (never reopened, never re-dated, never given another reason)
  IF OLD.closed_at IS NOT NULL AND (NEW.closed_at, NEW.closed_reason) IS DISTINCT FROM (OLD.closed_at, OLD.closed_reason) THEN
    RAISE EXCEPTION 'AI_ISA_HANDOFF_CLOSE_FINAL: a closed handoff stays closed' USING ERRCODE = 'check_violation';
  END IF;
  IF app.actor_kind() = 'user' AND NEW.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS NULL
     AND NEW.acknowledged_by_user_id IS DISTINCT FROM app.user_id() THEN
    RAISE EXCEPTION 'AI_ISA_HANDOFF_ACK_AS_SELF' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- =============================================================================
-- 8. Self-check
-- =============================================================================
DO $$
DECLARE r record; q text;
BEGIN
  SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig, p.oid INTO r FROM pg_proc p WHERE p.oid = 'app.ai_isa_person_blocked(uuid, uuid)'::regprocedure;
  IF NOT r.prosecdef OR r.owner <> 'app_definer' OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) cfg WHERE cfg LIKE 'search_path=%')
     OR has_function_privilege('public', r.oid, 'EXECUTE') OR NOT has_function_privilege('app_user', r.oid, 'EXECUTE') THEN
    RAISE EXCEPTION '0081 self-check failed: app.ai_isa_person_blocked shape';
  END IF;
  -- b12 recheck R5: it answers only the root survivor's owner or a tenant-wide actor
  IF (SELECT p.prosrc !~ 'AND \(app\.is_tenant_wide\(\)\s+OR \(app\.actor_kind\(\) = ''user'' AND EXISTS \(\s+SELECT 1 FROM public\.contacts r\s+WHERE r\.tenant_id = p_tenant AND r\.id = app\.contact_merge_root\(p_tenant, p_contact\) AND r\.owner_user_id = app\.user_id\(\)\)\)\)'
        FROM pg_proc p WHERE p.oid = 'app.ai_isa_person_blocked(uuid, uuid)'::regprocedure) THEN
    RAISE EXCEPTION '0081 self-check failed: app.ai_isa_person_blocked answers a caller who cannot see the record';
  END IF;
  IF has_function_privilege('app_user', 'app.ai_isa_send_check(public.messages)', 'EXECUTE') THEN
    RAISE EXCEPTION '0081 self-check failed: ai_isa_send_check must run only inside the guard';
  END IF;
  -- the guard still holds D1's refusals and the non-mandate AI-category refusal (db-guard-selfcheck-1)
  IF (SELECT position('PERSON_DO_NOT_CONTACT' IN p.prosrc) = 0 OR position('RECIPIENT_OPTED_OUT' IN p.prosrc) = 0
             OR position('RECIPIENT_SUPPRESSED' IN p.prosrc) = 0 OR position('PLATFORM_NOT_CLEARED' IN p.prosrc) = 0
             OR position('RECIPIENT_NOT_A_CONTACT_POINT' IN p.prosrc) = 0 OR position('ASSISTANT_ACTION_NOT_APPROVED' IN p.prosrc) = 0
             OR position('PLAYBOOK_NOT_APPROVED' IN p.prosrc) = 0 OR position('AUTOMATION_PAUSED' IN p.prosrc) = 0
             -- b12 recheck R6: the non-mandate branch itself (its ELSIF and its RAISE), not a prefix that the assistant
             -- branch's "... mandate (assistant)" refusal also contains
             OR p.prosrc !~ 'ELSIF NEW\.action_category IN \(''ai_isa_message'',''ai_isa_confirmation'',''ai_isa_holding_line''\) THEN\s+(--[^\n]*\n\s*)?RAISE EXCEPTION ''ISA_NOT_AUTHORIZED: AI assistant categories are sent only under the AI assistant mandate'' USING'
             OR position('app.ai_isa_send_check(NEW)' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.messages_dispatch_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0081 self-check failed: messages_dispatch_guard lost a D1 refusal';
  END IF;
  IF (SELECT position('b.created_at >= asg.started_at' IN p.prosrc) > 0 OR position('app.ai_isa_us_federal_holiday(lt::date)' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.ai_isa_send_check(public.messages)'::regprocedure)
     OR (SELECT position('app.ai_isa_person_blocked(NEW.tenant_id, NEW.contact_id)' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.ai_isa_assignments_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0081 self-check failed: a person-block or holiday check is missing';
  END IF;
  FOR r IN SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
            WHERE (c.relname, p.polname) IN (('ai_isa_assignments','assignments_select'), ('ai_isa_controls','controls_select'),
                    ('ai_isa_stop_signals','stop_signals_select'), ('ai_isa_person_blocks','blocks_select'), ('ai_isa_person_blocks','blocks_update'),
                    ('ai_isa_turns','isa_select'), ('ai_isa_slot_offers','isa_select'), ('ai_isa_shared_facts','isa_select'), ('ai_isa_handoffs','isa_select')) LOOP
    IF r.q NOT LIKE '%contact_merge_root%' THEN RAISE EXCEPTION '0081 self-check failed: %.% has no root-survivor branch', r.relname, r.polname; END IF;
  END LOOP;
  SELECT count(*) INTO q FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname LIKE 'ai_isa_%' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%contact_merge_root%';
  IF q::int <> 10 THEN RAISE EXCEPTION '0081 self-check failed: % root-survivor policies', q; END IF;
  -- b12 recheck R19: only the system closes a handoff, and a close is final
  IF (SELECT p.prosrc !~ 'IF app\.actor_kind\(\) <> ''system'' AND \(NEW\.pending_message_id, [^)]*NEW\.closed_at, NEW\.closed_reason\) IS DISTINCT FROM \(OLD\.pending_message_id, [^)]*OLD\.closed_at, OLD\.closed_reason\)'
             OR position('IF OLD.closed_at IS NOT NULL AND (NEW.closed_at, NEW.closed_reason) IS DISTINCT FROM (OLD.closed_at, OLD.closed_reason) THEN' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.ai_isa_handoffs_guard()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_isa_handoffs'::regclass AND conname = 'ai_isa_handoffs_closed_pair') THEN
    RAISE EXCEPTION '0081 self-check failed: a user can close an AI handoff, or a close is not final';
  END IF;
  -- b12 recheck R23: a Continue AI care has its own close reason (review12.test.ts keeps the CHECK equal to the API's
  -- HANDOFF_CLOSE_REASONS)
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.ai_isa_handoffs'::regclass
        AND c.conname = 'ai_isa_handoffs_closed_reason_check') NOT LIKE '%''care_continued''%' THEN
    RAISE EXCEPTION '0081 self-check failed: ai_isa_handoffs.closed_reason has no care_continued';
  END IF;
END $$;
