-- Lane ISA-2 (module 75; owner decision D12 PROPOSED, docs/AI_ISA.md §8): the AI ISA schema, its triggers and the
-- ai_isa_mandate branch of app.messages_dispatch_guard. Placeholder number (the orchestrator renumbers at merge).
--
-- Default off everywhere: nobody is enrolled by this migration, no tenant switch is turned on, and both packs ship
-- unreviewed (platform_cleared() is false until the counsel-review command records a review), so the guard refuses
-- every AI ISA send until an operator, counsel, the Owner, the team policy, the agent and the lead's owner have each
-- acted. Engineering defaults throughout: VERIFY WITH COUNSEL (C-ISA-1…12).
--
--  1. §8.1 changed objects: tenant_settings (switch, cap, owner-only guard), the two packs, playbooks kind ai_isa,
--     playbook_versions.narrows_previous, assistant_actions kinds/categories/autonomy and the mandate CHECK,
--     gate_decisions categories, messages.email_dkim_aligned, consent_disclosures.scope_stated, ai_runs purposes,
--     notification kinds, feed item types.
--  2. §8.2 tables (ai_isa_seller_watch is ISA-3's 0191): optins, assignments, controls, stop signals, person blocks,
--     turns, slot offers, shared facts, handoffs, daily counts, and the global zone reference tables.
--  3. Guards (all invoker): optins, assignments (insert and update), handoffs (ack columns only), the playbook
--     enrollment AI_ISA_ACTIVE refusal, zone validation.
--  4. Stop-signal triggers on consent_events, suppressions and contacts.do_not_contact_at (R-ISA-31).
--  5. The appointments lock and assistant-overlap trigger (R-ISA-13, E532).
--  6. app.ai_isa_send_check (invoker, EXECUTE only for app_definer) and the guard's ai_isa_mandate branch (§5.4).
-- SECURITY REVIEW ITEMS: docs/ARCHITECTURE.md §21.37 "Security notes: AI ISA".

-- =============================================================================
-- 1. Changed objects
-- =============================================================================

-- tenant switch and cap (R-ISA-32): only the Owner turns it on or raises the cap; Owner or Admin may turn it off
ALTER TABLE tenant_settings
  ADD COLUMN ai_isa_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_isa_enabled_by uuid,
  ADD COLUMN ai_isa_enabled_at timestamptz,
  ADD COLUMN ai_isa_daily_cap integer NOT NULL DEFAULT 100 CHECK (ai_isa_daily_cap BETWEEN 0 AND 1000);
CREATE FUNCTION app.tenant_settings_ai_isa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE loosening boolean;
BEGIN
  loosening := (NEW.ai_isa_enabled AND NOT COALESCE(OLD.ai_isa_enabled, false))
               OR (TG_OP = 'UPDATE' AND NEW.ai_isa_daily_cap > OLD.ai_isa_daily_cap);
  IF loosening AND NOT (app.actor_kind() = 'user' AND app.my_role() = 'owner') THEN
    RAISE EXCEPTION 'AI_ISA_OWNER_ONLY: only the Owner turns the AI assistant (ISA) on or raises its daily cap'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.ai_isa_enabled AND NOT COALESCE(OLD.ai_isa_enabled, false)
     AND (NEW.ai_isa_enabled_by IS DISTINCT FROM app.user_id() OR NEW.ai_isa_enabled_at IS NULL) THEN
    RAISE EXCEPTION 'AI_ISA_OWNER_ONLY: the switch records who turned it on' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings_ai_isa_guard BEFORE INSERT OR UPDATE OF ai_isa_enabled, ai_isa_daily_cap, ai_isa_enabled_by
  ON tenant_settings FOR EACH ROW EXECUTE FUNCTION app.tenant_settings_ai_isa_guard();

-- the packs (§8.1), published and unreviewed. platform:ai_isa's rules hold the platform constants and the consent,
-- window and cap defaults the guard reads; d12_effective_at is null until the owner confirms D12, so no grant counts
-- for the initiated tier (strict default). VERIFY WITH COUNSEL.
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:ai_isa', '2026.11.0', 'published',
   jsonb_build_object(
     'reply_window_hours', 24,
     'dnc_freshness_days', 31,
     'd12_effective_at', NULL,
     'window_ceiling', jsonb_build_object('start', '08:00', 'end', '20:00'),
     'window_default', jsonb_build_object('start', '09:00', 'end', '20:00'),
     'initiated_days', jsonb_build_array(1, 2, 3, 4, 5, 6),
     'caps', jsonb_build_object('ai24h', 3, 'automated24h', 3, 'initiated24h', 1, 'initiated7d', 3, 'min_gap_seconds', 120),
     'continental_zones', jsonb_build_array('America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'),
     'disclosure', 'Hi, this is {Agent}''s AI assistant at {Brokerage}.',
     'sign_off', '— {Agent}''s AI assistant, {Brokerage}',
     'from_name', '{Agent}''s AI assistant ({Team})'),
   NULL,
   'AI ISA texting and email: consent tiers, quiet hours, caps, AI disclosure and sign-off constants, reply window, DNC freshness, D12 effective date (C-ISA-1…7, 11, 12). Engineering placeholder. VERIFY WITH COUNSEL.'),
  ('platform:ai_isa_seller_data', '2026.11.0', 'published', '{}', NULL,
   'Automated sold comps and nearby sales to seller leads by email, and the client wording for them (C-ISA-8, 9). Engineering placeholder. VERIFY WITH COUNSEL / MLS.');

-- the team policy is a playbook of kind ai_isa, team scope only (§3.2)
ALTER TABLE playbooks DROP CONSTRAINT playbooks_kind_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_kind_check CHECK (kind = ANY (ARRAY['new_lead_response','nurture','post_closing',
  'booking_confirmation','reminder','document_chase','trigger','voice_answering','ai_isa']));
ALTER TABLE playbooks ADD CONSTRAINT playbooks_ai_isa_team_scope CHECK (kind <> 'ai_isa' OR scope = 'team');
-- set by core narrowsPrevious() at approval, for kind ai_isa only (§3.2)
ALTER TABLE playbook_versions ADD COLUMN narrows_previous boolean;

-- assistant actions: the AI ISA kinds, categories and the mandate (§8.1; R-ISA-23)
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check CHECK (kind = ANY (ARRAY['message_draft','autonomous_message',
  'call_summary','handback','promise_extraction','saved_search_proposal','next_step','lead_summary','seller_update_draft','weekly_plan',
  'marketing_draft','call_review','ad_reallocation','review_reply_draft','contract_extraction','ai_isa_message','ai_isa_handoff']));
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_action_category_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_action_category_check CHECK (action_category = ANY (ARRAY['speed_to_lead_reply',
  'reminder','booking_confirmation','document_chase','nurture_step','search_alert','money','contract','novel_message','seller_update',
  'internal','ai_isa_message','ai_isa_confirmation','ai_isa_holding_line']));
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_autonomy_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_autonomy_check CHECK (autonomy = ANY (ARRAY['requires_approval','within_playbook',
  'internal','ai_isa_mandate']));
ALTER TABLE assistant_actions ADD COLUMN ai_isa_turn_id uuid, ADD COLUMN epoch integer;
ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_action_category_check;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_action_category_check CHECK (action_category = ANY (ARRAY['none','speed_to_lead_reply',
  'reminder','booking_confirmation','document_chase','nurture_step','search_alert','opt_out_confirmation','help_reply','agent_alert','money',
  'contract','novel_message','seller_update','ai_isa_message','ai_isa_confirmation','ai_isa_holding_line']));

-- the provider's DKIM verdict for an inbound email (true = an aligned pass for the From domain; R-ISA-28)
ALTER TABLE messages ADD COLUMN email_dkim_aligned boolean;
-- saved searches the AI ISA proposed (R-ISA-17): no alerts of their own while care is live; paused at the handoff
ALTER TABLE saved_searches ADD COLUMN origin text NOT NULL DEFAULT 'standard' CHECK (origin IN ('standard','ai_isa'));
-- whether the disclosure stated its channel and purpose scope (written by storeDisclosure; NULL on older rows = refused)
ALTER TABLE consent_disclosures ADD COLUMN scope_stated boolean;

ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_purpose_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_purpose_check CHECK (purpose = ANY (ARRAY['draft','call_summary','claims_extraction',
  'handback_enrichment','lead_summary','first_response','search_proposal','pond_summary','opt_out_review','seller_update','marketing_draft',
  'call_review','weekly_plan','voice_session','contract_extraction','review_reply','ai_isa_turn','ai_isa_summary']));
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind = ANY (ARRAY['lead_offer','first_touch_due',
  'first_touch_escalation','handback','handback_hot','inbound_message','missed_call','pond_new','task_due','promise_due','exception',
  'reassigned_to_you','reassigned_away','inactivity_warning','opt_out','import_ready','system','seller_update_ready','weekly_plan',
  'integration_status','ad_overspend','mention','bulk_finished','ai_isa_handoff','ai_isa_handoff_hot','ai_isa_escalation','ai_isa_ended',
  'ai_isa_paused','ai_isa_handoff_overdue']));
ALTER TABLE priority_feed_items DROP CONSTRAINT priority_feed_items_item_type_check;
ALTER TABLE priority_feed_items ADD CONSTRAINT priority_feed_items_item_type_check CHECK (item_type = ANY (ARRAY['lead_offer',
  'first_touch_due','unanswered_inbound','handback','assistant_draft','task_due','promise_due','deal_date','appointment_outcome','reinquiry',
  'inactivity_warning','pond_new','saved_search_review','missed_call','seller_update','marketing_review','weekly_plan','coaching_fix',
  'likely_to_move','ai_isa_handoff','ai_isa_activity','ai_isa_escalation']));

-- decisions and denials are codes and handles only (R-ISA-5): every string leaf is a short code, every key too
CREATE FUNCTION app.ai_isa_codes_only(j jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog AS $$
  SELECT j IS NULL OR NOT EXISTS (
    WITH RECURSIVE walk(v) AS (
      SELECT j
      UNION ALL
      SELECT e.v FROM walk w, LATERAL (
        SELECT x.value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) x
        UNION ALL
        SELECT y.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) y) e)
    SELECT 1 FROM walk w
     WHERE (jsonb_typeof(w.v) = 'string' AND (w.v #>> '{}') !~ '^[A-Za-z0-9_:.@-]{1,64}$')
        OR (jsonb_typeof(w.v) = 'object' AND EXISTS (SELECT 1 FROM jsonb_object_keys(w.v) k WHERE k !~ '^[A-Za-z0-9_]{1,40}$')))
$$;

-- =============================================================================
-- 2. Tables
-- =============================================================================

-- ---- the agent's opt-in (§3.3) ---------------------------------------------------------------------------------
CREATE TABLE ai_isa_agent_optins (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL,
  user_id              uuid NOT NULL,
  playbook_version_id  uuid NOT NULL,
  attestation          text NOT NULL CHECK (length(attestation) BETWEEN 40 AND 4000),
  attestation_sha256   text NOT NULL CHECK (attestation_sha256 ~ '^[0-9a-f]{64}$'),
  capabilities         text[] NOT NULL CHECK (capabilities <@ ARRAY['converse','share_listings','propose_saved_search','seller_competition',
                                              'seller_sold_comps','book_appointments'] AND 'converse' = ANY (capabilities)),
  channels             text[] NOT NULL CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY['sms','email']),
  timezone             text NOT NULL,
  availability         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(availability) = 'array'),
  booking              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(booking) = 'object'),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','revoked')),
  revoked_at           timestamptz,
  revoked_by_user_id   uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, playbook_version_id) REFERENCES playbook_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX ai_isa_agent_optins_active_uq ON ai_isa_agent_optins (tenant_id, user_id) WHERE status = 'active';

-- ---- the assignment (§3.4, §8.2) -------------------------------------------------------------------------------
CREATE TABLE ai_isa_assignments (
  tenant_id                    uuid NOT NULL,
  id                           uuid NOT NULL,
  contact_id                   uuid NOT NULL,
  owner_user_id                uuid NOT NULL,
  optin_id                     uuid NOT NULL,
  playbook_version_id          uuid NOT NULL,
  bound_ownership_seq          bigint NOT NULL,
  -- {sms:{point_id,hmac}, email:{point_id,hmac}}: hmac is the point's address_hmac in hex (R-ISA-28)
  bound_points                 jsonb NOT NULL CHECK (jsonb_typeof(bound_points) = 'object' AND bound_points <> '{}'
                                 AND bound_points - 'sms' - 'email' = '{}'::jsonb),
  side                         text NOT NULL CHECK (side IN ('buyer','seller','both')),
  state                        text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting','awaiting_reply','engaged','nurture','scheduling',
                                 'booking','awaiting_agent','paused','ended')),
  -- the core machine state (packages/core/src/isa/machine.ts IsaState): ids, codes, instants and verified quotes
  machine                      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(machine) = 'object'),
  awaiting_agent               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(awaiting_agent) = 'array'),
  epoch                        integer NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  started_by_user_id           uuid NOT NULL,
  started_at                   timestamptz NOT NULL DEFAULT now(),
  from_handback_id             uuid,
  continued_from_assignment_id uuid,
  paused_at                    timestamptz,
  paused_by_kind               text CHECK (paused_by_kind IN ('user','system')),
  paused_by_user_id            uuid,
  pause_reason                 text CHECK (pause_reason IN ('user','human_contact','unverified_sender','call','chat','synced_mail','media',
                                 'pack_withdrawn','ai_off','approval_revoked','policy_updated','reinquiry','possible_listing','check_this',
                                 'taking_over','ending')),
  ended_at                     timestamptz,
  end_reason                   text,
  ended_by_kind                text CHECK (ended_by_kind IN ('user','system')),
  ended_by_user_id             uuid,
  consent_snapshot             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(consent_snapshot) = 'object'),
  messages_sent                integer NOT NULL DEFAULT 0 CHECK (messages_sent >= 0),
  unanswered_initiated         integer NOT NULL DEFAULT 0 CHECK (unanswered_initiated >= 0),
  undelivered_streak           integer NOT NULL DEFAULT 0 CHECK (undelivered_streak >= 0),
  last_inbound_seq             bigint NOT NULL DEFAULT 0,
  next_follow_up_at            timestamptz,
  -- the take-over / end undo window (R-ISA-15): the finalize job runs at this instant unless Undo cancels it
  finalize_at                  timestamptz,
  finalize_kind                text CHECK (finalize_kind IN ('take_over','end')),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, optin_id) REFERENCES ai_isa_agent_optins (tenant_id, id),
  FOREIGN KEY (tenant_id, playbook_version_id) REFERENCES playbook_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, continued_from_assignment_id) REFERENCES ai_isa_assignments (tenant_id, id),
  CHECK ((paused_at IS NULL) = (pause_reason IS NULL) AND (paused_at IS NULL) = (paused_by_kind IS NULL)),
  CHECK (paused_by_kind IS DISTINCT FROM 'user' OR paused_by_user_id IS NOT NULL),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL) = (ended_by_kind IS NULL)),
  CHECK (end_reason IS NULL OR end_reason IN ('appointment_booked','ready_buyer','ready_seller','escalated','opted_out','suppressed',
    'do_not_contact','wrong_number','owner_change','merged','owner_inactive','tenant_off','optin_revoked','policy_updated',
    'inactivity_warning','dormant','limit_reached','delivery_problem','listed_elsewhere','active_client','shared_address','point_removed',
    'pause_expired','ended_by_user','taken_over','has_agent','not_interested','not_a_lead','reinquiry_period','zone_windows_do_not_overlap')),
  CHECK ((finalize_at IS NULL) = (finalize_kind IS NULL))
);
CREATE UNIQUE INDEX ai_isa_assignments_live_uq ON ai_isa_assignments (tenant_id, contact_id) WHERE ended_at IS NULL;
CREATE INDEX ai_isa_assignments_owner_idx ON ai_isa_assignments (tenant_id, owner_user_id) WHERE ended_at IS NULL;
CREATE INDEX ai_isa_assignments_contact_idx ON ai_isa_assignments (tenant_id, contact_id, started_at DESC);
CREATE TRIGGER ai_isa_assignments_touch_updated_at BEFORE UPDATE ON ai_isa_assignments FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---- the controls ledger (insert-only; §3.7) -------------------------------------------------------------------
CREATE TABLE ai_isa_controls (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  assignment_id  uuid NOT NULL,
  contact_id     uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('pause','resume','take_over','end','undo','finalize','continue','pause_all','system_pause','system_end','hold_start','hold_end')),
  by_kind        text NOT NULL CHECK (by_kind IN ('user','system')),
  by_user_id     uuid,
  reason         text NOT NULL CHECK (reason ~ '^[a-z_:]{1,64}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES ai_isa_assignments (tenant_id, id) ON DELETE CASCADE,
  CHECK ((by_kind = 'user') = (by_user_id IS NOT NULL))
);
CREATE INDEX ai_isa_controls_assignment_idx ON ai_isa_controls (tenant_id, assignment_id, created_at);

-- ---- stop signals (insert-only; R-ISA-31) ----------------------------------------------------------------------
CREATE TABLE ai_isa_stop_signals (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  address_hmac  bytea CHECK (address_hmac IS NULL OR octet_length(address_hmac) = 32),
  contact_id    uuid,
  reason        text NOT NULL CHECK (reason IN ('opted_out','suppressed','do_not_contact','wrong_number','owner_change','merged')),
  source_table  text NOT NULL CHECK (source_table ~ '^[a-z_]{1,40}$'),
  source_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((address_hmac IS NULL) <> (contact_id IS NULL))
);
CREATE INDEX ai_isa_stop_signals_hmac_idx ON ai_isa_stop_signals (tenant_id, address_hmac, created_at) WHERE address_hmac IS NOT NULL;
CREATE INDEX ai_isa_stop_signals_contact_idx ON ai_isa_stop_signals (tenant_id, contact_id, created_at) WHERE contact_id IS NOT NULL;

-- ---- person blocks (§5.1) --------------------------------------------------------------------------------------
CREATE TABLE ai_isa_person_blocks (
  tenant_id                uuid NOT NULL,
  id                       uuid NOT NULL,
  contact_id               uuid NOT NULL,
  assignment_id            uuid,
  reason                   text NOT NULL CHECK (reason IN ('opted_out','possible_opt_out','complaint','wrong_number','has_agent','ai_declined',
                             'consent_dispute','do_not_contact')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  lifted_at                timestamptz,
  lifted_by_user_id        uuid,
  lift_inbound_message_id  uuid,
  lift_attestation         text CHECK (lift_attestation IS NULL OR length(lift_attestation) BETWEEN 20 AND 2000),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CHECK ((lifted_at IS NULL) = (lifted_by_user_id IS NULL) AND (lifted_at IS NULL) = (lift_inbound_message_id IS NULL)
         AND (lifted_at IS NULL) = (lift_attestation IS NULL))
);
CREATE INDEX ai_isa_person_blocks_contact_idx ON ai_isa_person_blocks (tenant_id, contact_id) WHERE lifted_at IS NULL;

-- ---- turns (§8.2): the system appends; status moves only through attempt-guarded updates --------------------------
CREATE TABLE ai_isa_turns (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL,
  assignment_id        uuid NOT NULL,
  contact_id           uuid NOT NULL,
  seq                  integer NOT NULL CHECK (seq >= 1),
  epoch                integer NOT NULL CHECK (epoch >= 1),
  attempt              integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  trigger_kind         text NOT NULL CHECK (trigger_kind IN ('start','inbound','timer','listing_event','offer','booking','control','sweep')),
  trigger_key          text NOT NULL CHECK (trigger_key ~ '^[A-Za-z0-9_:.-]{1,120}$'),
  pinned_inbound_seq   bigint NOT NULL,
  state_before         text NOT NULL,
  state_after          text,
  status               text NOT NULL DEFAULT 'deciding' CHECK (status IN ('deciding','sending','sent','deferred','no_reply','stale','canceled_paused',
                         'blocked','canceled','unknown','escalated','handed_off')),
  ai_run_id            uuid,
  assistant_action_id  uuid,
  message_id           uuid,
  channel              text CHECK (channel IN ('sms','email')),
  purpose              text NOT NULL DEFAULT 'marketing' CHECK (purpose = 'marketing'),
  message_kind         text CHECK (message_kind IN ('reply','initiated')),
  basis_kind           text CHECK (basis_kind IN ('own_inbound','grant')),
  consent_event_id     uuid,
  basis_message_id     uuid,
  dnc_check_id         uuid,
  zones                text[],
  zone_source          text CHECK (zone_source IN ('explicit','union')),
  icu_tz_version       text,
  pg_tzdata_version    text,
  window_start         time,
  window_end           time,
  not_before           timestamptz,
  body_sha256          text CHECK (body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'),
  decision             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(decision) = 'object' AND app.ai_isa_codes_only(decision)),
  denied               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(denied) = 'array' AND app.ai_isa_codes_only(denied)),
  rules_version        text NOT NULL,
  policy_version       text NOT NULL,
  prompt_version       text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, assignment_id, trigger_key),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES ai_isa_assignments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (message_id),
  CHECK (zones IS NULL OR cardinality(zones) >= 1),
  CHECK (message_id IS NULL OR (channel IS NOT NULL AND message_kind IS NOT NULL AND zones IS NOT NULL AND body_sha256 IS NOT NULL
                                AND window_start IS NOT NULL AND window_end IS NOT NULL AND window_start < window_end))
);
CREATE INDEX ai_isa_turns_assignment_idx ON ai_isa_turns (tenant_id, assignment_id, seq DESC);
CREATE UNIQUE INDEX ai_isa_turns_message_uq ON ai_isa_turns (tenant_id, message_id) WHERE message_id IS NOT NULL;
CREATE TRIGGER ai_isa_turns_touch_updated_at BEFORE UPDATE ON ai_isa_turns FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_ai_isa_turn_fk FOREIGN KEY (tenant_id, ai_isa_turn_id)
  REFERENCES ai_isa_turns (tenant_id, id) ON DELETE SET NULL (ai_isa_turn_id) NOT VALID;
ALTER TABLE assistant_actions VALIDATE CONSTRAINT assistant_actions_ai_isa_turn_fk;
-- the mandate is tied to the AI ISA categories, a turn, a frozen policy version and an epoch (R-ISA-23; §8.1);
-- a deleted turn (contact erasure cascades) nulls the turn id, which the CHECK then accepts only for non-proposed rows
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_ai_isa_mandate CHECK (
  (autonomy = 'ai_isa_mandate') = (kind = 'ai_isa_message' AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')
                                   AND (ai_isa_turn_id IS NOT NULL OR status <> 'proposed') AND playbook_version_id IS NOT NULL AND epoch IS NOT NULL));
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_ai_isa_handoff CHECK (kind <> 'ai_isa_handoff' OR (autonomy = 'internal' AND action_category = 'internal'));
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_ai_isa_categories CHECK (
  action_category NOT IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') OR autonomy = 'ai_isa_mandate');
-- one open (proposed) AI message per contact (§4.2)
CREATE UNIQUE INDEX assistant_actions_ai_isa_open_uq ON assistant_actions (tenant_id, contact_id) WHERE kind = 'ai_isa_message' AND status = 'proposed';

-- ---- slot offers (§4.6) ----------------------------------------------------------------------------------------
CREATE TABLE ai_isa_slot_offers (
  tenant_id                   uuid NOT NULL,
  id                          uuid NOT NULL,
  assignment_id               uuid NOT NULL,
  contact_id                  uuid NOT NULL,
  turn_id                     uuid,
  organizer_user_id           uuid NOT NULL,
  kind                        text NOT NULL CHECK (kind IN ('buyer_consult','listing_appointment','consult')),
  slots                       jsonb NOT NULL CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) BETWEEN 1 AND 3),
  zones                       text[] NOT NULL CHECK (cardinality(zones) >= 1),
  availability_link_id        uuid NOT NULL,
  read_at                     timestamptz NOT NULL,
  expires_at                  timestamptz NOT NULL,
  offered_message_id          uuid,
  status                      text NOT NULL DEFAULT 'pending_delivery' CHECK (status IN ('pending_delivery','offered','accepting','accepted','expired','superseded','refused')),
  accepted_slot               integer CHECK (accepted_slot BETWEEN 1 AND 3),
  accepted_message_id         uuid,
  accepted_quote              text CHECK (accepted_quote IS NULL OR length(accepted_quote) <= 200),
  appointment_id              uuid,
  refusal_code                text CHECK (refusal_code IS NULL OR refusal_code ~ '^[A-Z_]{1,40}$'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES ai_isa_assignments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, id) ON DELETE SET NULL (appointment_id),
  CHECK (status NOT IN ('accepting','accepted') OR (accepted_slot IS NOT NULL AND accepted_message_id IS NOT NULL)),
  CHECK (status <> 'accepted' OR appointment_id IS NOT NULL)
);
CREATE UNIQUE INDEX ai_isa_slot_offers_live_uq ON ai_isa_slot_offers (tenant_id, assignment_id) WHERE status IN ('pending_delivery','offered','accepting');
CREATE UNIQUE INDEX ai_isa_slot_offers_appointment_uq ON ai_isa_slot_offers (tenant_id, appointment_id) WHERE appointment_id IS NOT NULL;
CREATE TRIGGER ai_isa_slot_offers_touch_updated_at BEFORE UPDATE ON ai_isa_slot_offers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---- facts shared (§6.1): pending at queue time, sent at TX2, canceled otherwise ----------------------------------
CREATE TABLE ai_isa_shared_facts (
  tenant_id              uuid NOT NULL,
  id                     uuid NOT NULL,
  assignment_id          uuid NOT NULL,
  contact_id             uuid NOT NULL,
  turn_id                uuid,
  message_id             uuid,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','canceled')),
  fact_kind              text NOT NULL CHECK (fact_kind IN ('listing_active','listing_coming_soon','listing_pending','competitor','sold_comp_set',
                           'nearby_sale','competition_count')),
  listing_id             uuid,
  mls_connection_id      uuid,
  price_kind             text CHECK (price_kind IN ('asking','sold')),
  price_cents            bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  status_at_build        text,
  as_of                  timestamptz,
  display_rules_version  text,
  gate                   jsonb NOT NULL DEFAULT '[]' CHECK (app.ai_isa_codes_only(gate)),
  method_version         text,
  valuation_date         date,
  tier                   text,
  comp_set_hash          text,
  line_sha256            text NOT NULL CHECK (line_sha256 ~ '^[0-9a-f]{64}$'),
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES ai_isa_assignments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (message_id)
);
CREATE UNIQUE INDEX ai_isa_shared_facts_sent_uq ON ai_isa_shared_facts (tenant_id, message_id, listing_id, fact_kind) WHERE status = 'sent';
CREATE INDEX ai_isa_shared_facts_contact_idx ON ai_isa_shared_facts (tenant_id, contact_id, listing_id) WHERE status = 'sent';
CREATE INDEX ai_isa_shared_facts_message_idx ON ai_isa_shared_facts (tenant_id, message_id);

-- ---- handoffs (§4.7): exactly one per assignment, the package frozen -----------------------------------------------
CREATE TABLE ai_isa_handoffs (
  tenant_id                 uuid NOT NULL,
  id                        uuid NOT NULL,
  assignment_id             uuid NOT NULL,
  contact_id                uuid NOT NULL,
  reason                    text NOT NULL,
  basis                     jsonb NOT NULL DEFAULT '{}' CHECK (app.ai_isa_codes_only(basis)),
  assistant_action_id       uuid NOT NULL,
  appointment_id            uuid,
  package                   jsonb NOT NULL CHECK (jsonb_typeof(package) = 'object'),
  package_sha256            text NOT NULL CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  pending_message_id        uuid,
  confirmation_status       text NOT NULL DEFAULT 'none' CHECK (confirmation_status IN ('none','scheduled','queued','sent','canceled','refused')),
  sla_class                 text NOT NULL CHECK (sla_class IN ('critical','high','normal','low')),
  sla_due_at                timestamptz NOT NULL,
  sla_met_at                timestamptz,
  sla_escalated_at          timestamptz,
  sla_escalation_level      integer NOT NULL DEFAULT 0 CHECK (sla_escalation_level BETWEEN 0 AND 2),
  recipient_user_id         uuid,
  acknowledged_at           timestamptz,
  acknowledged_by_user_id   uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, assignment_id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES ai_isa_assignments (tenant_id, id) ON DELETE CASCADE,
  -- CASCADE (isa-2-1): only erasure deletes an assistant action, and it deletes the person's actions one cascade level
  -- before their handoffs (contacts -> assignments -> handoffs); a NO ACTION check there would refuse the erasure
  FOREIGN KEY (tenant_id, assistant_action_id) REFERENCES assistant_actions (tenant_id, id) ON DELETE CASCADE,
  CHECK (package_sha256 = encode(sha256(convert_to(package::text, 'UTF8')), 'hex')),
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL))
);
CREATE INDEX ai_isa_handoffs_sla_idx ON ai_isa_handoffs (tenant_id, sla_due_at) WHERE sla_met_at IS NULL;

-- ---- the tenant's AI ISA sends per tenant-local day (written only by the guard; R-ISA-11) --------------------------
CREATE TABLE ai_isa_daily_counts (
  tenant_id  uuid NOT NULL,
  local_day  date NOT NULL,
  n          integer NOT NULL CHECK (n >= 0),
  PRIMARY KEY (tenant_id, local_day)
);

-- ---- global reference data (like jurisdiction_packs): area code and state zones (R-ISA-10) ------------------------
-- seeded from packages/core/src/isa/{areaCodes,stateZones}.ts; a test keeps them equal. Every row VERIFY.
CREATE TABLE ai_isa_area_code_zones (area_code text NOT NULL CHECK (area_code ~ '^[2-9][0-9]{2}$'), zone text NOT NULL, PRIMARY KEY (area_code, zone));
CREATE TABLE ai_isa_state_zones (state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'), zone text NOT NULL, PRIMARY KEY (state, zone));
INSERT INTO ai_isa_area_code_zones (area_code, zone) VALUES
  ('201','America/New_York'), ('202','America/New_York'), ('203','America/New_York'), ('204','America/Winnipeg'), ('205','America/Chicago'), ('206','America/Los_Angeles'), ('207','America/New_York'), ('208','America/Boise'),
  ('208','America/Los_Angeles'), ('209','America/Los_Angeles'), ('210','America/Chicago'), ('210','America/Denver'), ('212','America/New_York'), ('213','America/Los_Angeles'), ('214','America/Chicago'), ('214','America/Denver'),
  ('215','America/New_York'), ('216','America/New_York'), ('217','America/Chicago'), ('218','America/Chicago'), ('219','America/Indiana/Indianapolis'), ('219','America/Chicago'), ('220','America/New_York'), ('223','America/New_York'),
  ('224','America/Chicago'), ('225','America/Chicago'), ('226','America/Toronto'), ('226','America/Winnipeg'), ('227','America/New_York'), ('228','America/Chicago'), ('229','America/New_York'), ('231','America/Detroit'),
  ('231','America/Menominee'), ('234','America/New_York'), ('235','America/Chicago'), ('236','America/Vancouver'), ('236','America/Edmonton'), ('236','America/Creston'), ('239','America/New_York'), ('239','America/Chicago'),
  ('240','America/New_York'), ('248','America/Detroit'), ('248','America/Menominee'), ('249','America/Toronto'), ('249','America/Winnipeg'), ('250','America/Vancouver'), ('250','America/Edmonton'), ('250','America/Creston'),
  ('251','America/Chicago'), ('252','America/New_York'), ('253','America/Los_Angeles'), ('254','America/Chicago'), ('254','America/Denver'), ('256','America/Chicago'), ('257','America/Vancouver'), ('257','America/Edmonton'),
  ('257','America/Creston'), ('260','America/Indiana/Indianapolis'), ('260','America/Chicago'), ('262','America/Chicago'), ('263','America/Toronto'), ('263','America/Halifax'), ('267','America/New_York'), ('269','America/Detroit'),
  ('269','America/Menominee'), ('270','America/New_York'), ('270','America/Chicago'), ('272','America/New_York'), ('274','America/Chicago'), ('276','America/New_York'), ('279','America/Los_Angeles'), ('281','America/Chicago'),
  ('281','America/Denver'), ('283','America/New_York'), ('289','America/Toronto'), ('289','America/Winnipeg'), ('301','America/New_York'), ('302','America/New_York'), ('303','America/Denver'), ('304','America/New_York'),
  ('305','America/New_York'), ('305','America/Chicago'), ('306','America/Regina'), ('307','America/Denver'), ('308','America/Chicago'), ('308','America/Denver'), ('309','America/Chicago'), ('310','America/Los_Angeles'),
  ('312','America/Chicago'), ('313','America/Detroit'), ('313','America/Menominee'), ('314','America/Chicago'), ('315','America/New_York'), ('316','America/Chicago'), ('316','America/Denver'), ('317','America/Indiana/Indianapolis'),
  ('317','America/Chicago'), ('318','America/Chicago'), ('319','America/Chicago'), ('320','America/Chicago'), ('321','America/New_York'), ('321','America/Chicago'), ('323','America/Los_Angeles'), ('324','America/New_York'),
  ('324','America/Chicago'), ('325','America/Chicago'), ('325','America/Denver'), ('326','America/New_York'), ('327','America/Chicago'), ('329','America/New_York'), ('330','America/New_York'), ('331','America/Chicago'),
  ('332','America/New_York'), ('334','America/Chicago'), ('336','America/New_York'), ('337','America/Chicago'), ('339','America/New_York'), ('340','America/St_Thomas'), ('341','America/Los_Angeles'), ('343','America/Toronto'),
  ('343','America/Winnipeg'), ('346','America/Chicago'), ('346','America/Denver'), ('347','America/New_York'), ('350','America/Los_Angeles'), ('351','America/New_York'), ('352','America/New_York'), ('352','America/Chicago'),
  ('353','America/Chicago'), ('354','America/Toronto'), ('354','America/Halifax'), ('360','America/Los_Angeles'), ('361','America/Chicago'), ('361','America/Denver'), ('363','America/New_York'), ('364','America/New_York'),
  ('364','America/Chicago'), ('365','America/Toronto'), ('365','America/Winnipeg'), ('367','America/Toronto'), ('367','America/Halifax'), ('368','America/Edmonton'), ('380','America/New_York'), ('382','America/Toronto'),
  ('382','America/Winnipeg'), ('385','America/Denver'), ('386','America/New_York'), ('386','America/Chicago'), ('387','America/Toronto'), ('387','America/Winnipeg'), ('401','America/New_York'), ('402','America/Chicago'),
  ('402','America/Denver'), ('403','America/Edmonton'), ('404','America/New_York'), ('405','America/Chicago'), ('406','America/Denver'), ('407','America/New_York'), ('407','America/Chicago'), ('408','America/Los_Angeles'),
  ('409','America/Chicago'), ('409','America/Denver'), ('410','America/New_York'), ('412','America/New_York'), ('413','America/New_York'), ('414','America/Chicago'), ('415','America/Los_Angeles'), ('416','America/Toronto'),
  ('416','America/Winnipeg'), ('417','America/Chicago'), ('418','America/Toronto'), ('418','America/Halifax'), ('419','America/New_York'), ('423','America/Chicago'), ('423','America/New_York'), ('424','America/Los_Angeles'),
  ('425','America/Los_Angeles'), ('428','America/Moncton'), ('430','America/Chicago'), ('430','America/Denver'), ('431','America/Winnipeg'), ('432','America/Chicago'), ('432','America/Denver'), ('434','America/New_York'),
  ('435','America/Denver'), ('436','America/New_York'), ('437','America/Toronto'), ('437','America/Winnipeg'), ('438','America/Toronto'), ('438','America/Halifax'), ('440','America/New_York'), ('442','America/Los_Angeles'),
  ('443','America/New_York'), ('445','America/New_York'), ('447','America/Chicago'), ('448','America/New_York'), ('448','America/Chicago'), ('450','America/Toronto'), ('450','America/Halifax'), ('458','America/Los_Angeles'),
  ('458','America/Boise'), ('463','America/Indiana/Indianapolis'), ('463','America/Chicago'), ('464','America/Chicago'), ('468','America/Toronto'), ('468','America/Halifax'), ('469','America/Chicago'), ('469','America/Denver'),
  ('470','America/New_York'), ('472','America/New_York'), ('474','America/Regina'), ('475','America/New_York'), ('478','America/New_York'), ('479','America/Chicago'), ('480','America/Phoenix'), ('480','America/Denver'),
  ('484','America/New_York'), ('501','America/Chicago'), ('502','America/New_York'), ('502','America/Chicago'), ('503','America/Los_Angeles'), ('503','America/Boise'), ('504','America/Chicago'), ('505','America/Denver'),
  ('506','America/Moncton'), ('507','America/Chicago'), ('508','America/New_York'), ('509','America/Los_Angeles'), ('510','America/Los_Angeles'), ('512','America/Chicago'), ('512','America/Denver'), ('513','America/New_York'),
  ('514','America/Toronto'), ('514','America/Halifax'), ('515','America/Chicago'), ('516','America/New_York'), ('517','America/Detroit'), ('517','America/Menominee'), ('518','America/New_York'), ('519','America/Toronto'),
  ('519','America/Winnipeg'), ('520','America/Phoenix'), ('520','America/Denver'), ('530','America/Los_Angeles'), ('531','America/Chicago'), ('531','America/Denver'), ('534','America/Chicago'), ('539','America/Chicago'),
  ('540','America/New_York'), ('541','America/Los_Angeles'), ('541','America/Boise'), ('548','America/Toronto'), ('548','America/Winnipeg'), ('551','America/New_York'), ('557','America/Chicago'), ('559','America/Los_Angeles'),
  ('561','America/New_York'), ('561','America/Chicago'), ('562','America/Los_Angeles'), ('563','America/Chicago'), ('564','America/Los_Angeles'), ('567','America/New_York'), ('570','America/New_York'), ('571','America/New_York'),
  ('572','America/Chicago'), ('573','America/Chicago'), ('574','America/Indiana/Indianapolis'), ('574','America/Chicago'), ('575','America/Denver'), ('579','America/Toronto'), ('579','America/Halifax'), ('580','America/Chicago'),
  ('581','America/Toronto'), ('581','America/Halifax'), ('582','America/New_York'), ('584','America/Winnipeg'), ('585','America/New_York'), ('586','America/Detroit'), ('586','America/Menominee'), ('587','America/Edmonton'),
  ('601','America/Chicago'), ('602','America/Phoenix'), ('602','America/Denver'), ('603','America/New_York'), ('604','America/Vancouver'), ('604','America/Edmonton'), ('604','America/Creston'), ('605','America/Chicago'),
  ('605','America/Denver'), ('606','America/New_York'), ('606','America/Chicago'), ('607','America/New_York'), ('608','America/Chicago'), ('609','America/New_York'), ('610','America/New_York'), ('612','America/Chicago'),
  ('613','America/Toronto'), ('613','America/Winnipeg'), ('614','America/New_York'), ('615','America/Chicago'), ('615','America/New_York'), ('616','America/Detroit'), ('616','America/Menominee'), ('617','America/New_York'),
  ('618','America/Chicago'), ('619','America/Los_Angeles'), ('620','America/Chicago'), ('620','America/Denver'), ('623','America/Phoenix'), ('623','America/Denver'), ('624','America/New_York'), ('626','America/Los_Angeles'),
  ('628','America/Los_Angeles'), ('629','America/Chicago'), ('629','America/New_York'), ('630','America/Chicago'), ('631','America/New_York'), ('636','America/Chicago'), ('639','America/Regina'), ('640','America/New_York'),
  ('641','America/Chicago'), ('645','America/New_York'), ('645','America/Chicago'), ('646','America/New_York'), ('647','America/Toronto'), ('647','America/Winnipeg'), ('650','America/Los_Angeles'), ('651','America/Chicago'),
  ('656','America/New_York'), ('656','America/Chicago'), ('657','America/Los_Angeles'), ('659','America/Chicago'), ('660','America/Chicago'), ('661','America/Los_Angeles'), ('662','America/Chicago'), ('667','America/New_York'),
  ('669','America/Los_Angeles'), ('670','Pacific/Saipan'), ('671','Pacific/Guam'), ('672','America/Vancouver'), ('672','America/Edmonton'), ('672','America/Creston'), ('678','America/New_York'), ('679','America/Detroit'),
  ('679','America/Menominee'), ('680','America/New_York'), ('681','America/New_York'), ('682','America/Chicago'), ('682','America/Denver'), ('683','America/Toronto'), ('683','America/Winnipeg'), ('684','Pacific/Pago_Pago'),
  ('686','America/New_York'), ('689','America/New_York'), ('689','America/Chicago'), ('701','America/Chicago'), ('701','America/Denver'), ('702','America/Los_Angeles'), ('702','America/Denver'), ('703','America/New_York'),
  ('704','America/New_York'), ('705','America/Toronto'), ('705','America/Winnipeg'), ('706','America/New_York'), ('707','America/Los_Angeles'), ('708','America/Chicago'), ('709','America/St_Johns'), ('709','America/Goose_Bay'),
  ('712','America/Chicago'), ('713','America/Chicago'), ('713','America/Denver'), ('714','America/Los_Angeles'), ('715','America/Chicago'), ('716','America/New_York'), ('717','America/New_York'), ('718','America/New_York'),
  ('719','America/Denver'), ('720','America/Denver'), ('724','America/New_York'), ('725','America/Los_Angeles'), ('725','America/Denver'), ('726','America/Chicago'), ('726','America/Denver'), ('727','America/New_York'),
  ('727','America/Chicago'), ('728','America/New_York'), ('728','America/Chicago'), ('730','America/Chicago'), ('731','America/Chicago'), ('731','America/New_York'), ('732','America/New_York'), ('734','America/Detroit'),
  ('734','America/Menominee'), ('737','America/Chicago'), ('737','America/Denver'), ('740','America/New_York'), ('742','America/Toronto'), ('742','America/Winnipeg'), ('743','America/New_York'), ('747','America/Los_Angeles'),
  ('753','America/Toronto'), ('753','America/Winnipeg'), ('754','America/New_York'), ('754','America/Chicago'), ('757','America/New_York'), ('760','America/Los_Angeles'), ('762','America/New_York'), ('763','America/Chicago'),
  ('765','America/Indiana/Indianapolis'), ('765','America/Chicago'), ('769','America/Chicago'), ('770','America/New_York'), ('771','America/New_York'), ('772','America/New_York'), ('772','America/Chicago'), ('773','America/Chicago'),
  ('774','America/New_York'), ('775','America/Los_Angeles'), ('775','America/Denver'), ('778','America/Vancouver'), ('778','America/Edmonton'), ('778','America/Creston'), ('779','America/Chicago'), ('780','America/Edmonton'),
  ('781','America/New_York'), ('782','America/Halifax'), ('785','America/Chicago'), ('785','America/Denver'), ('786','America/New_York'), ('786','America/Chicago'), ('787','America/Puerto_Rico'), ('801','America/Denver'),
  ('802','America/New_York'), ('803','America/New_York'), ('804','America/New_York'), ('805','America/Los_Angeles'), ('806','America/Chicago'), ('806','America/Denver'), ('807','America/Toronto'), ('807','America/Winnipeg'),
  ('808','Pacific/Honolulu'), ('810','America/Detroit'), ('810','America/Menominee'), ('812','America/Indiana/Indianapolis'), ('812','America/Chicago'), ('813','America/New_York'), ('813','America/Chicago'), ('814','America/New_York'),
  ('815','America/Chicago'), ('816','America/Chicago'), ('817','America/Chicago'), ('817','America/Denver'), ('818','America/Los_Angeles'), ('819','America/Toronto'), ('819','America/Halifax'), ('820','America/Los_Angeles'),
  ('821','America/New_York'), ('825','America/Edmonton'), ('826','America/New_York'), ('828','America/New_York'), ('830','America/Chicago'), ('830','America/Denver'), ('831','America/Los_Angeles'), ('832','America/Chicago'),
  ('832','America/Denver'), ('835','America/New_York'), ('838','America/New_York'), ('839','America/New_York'), ('840','America/Los_Angeles'), ('843','America/New_York'), ('845','America/New_York'), ('847','America/Chicago'),
  ('848','America/New_York'), ('850','America/New_York'), ('850','America/Chicago'), ('854','America/New_York'), ('856','America/New_York'), ('857','America/New_York'), ('858','America/Los_Angeles'), ('859','America/New_York'),
  ('859','America/Chicago'), ('860','America/New_York'), ('861','America/Chicago'), ('862','America/New_York'), ('863','America/New_York'), ('863','America/Chicago'), ('864','America/New_York'), ('865','America/Chicago'),
  ('865','America/New_York'), ('867','America/Whitehorse'), ('867','America/Yellowknife'), ('867','America/Iqaluit'), ('867','America/Winnipeg'), ('867','America/Edmonton'), ('870','America/Chicago'), ('872','America/Chicago'),
  ('873','America/Toronto'), ('873','America/Halifax'), ('878','America/New_York'), ('879','America/St_Johns'), ('879','America/Goose_Bay'), ('901','America/Chicago'), ('901','America/New_York'), ('902','America/Halifax'),
  ('903','America/Chicago'), ('903','America/Denver'), ('904','America/New_York'), ('904','America/Chicago'), ('905','America/Toronto'), ('905','America/Winnipeg'), ('906','America/Detroit'), ('906','America/Menominee'),
  ('907','America/Anchorage'), ('907','America/Adak'), ('908','America/New_York'), ('909','America/Los_Angeles'), ('910','America/New_York'), ('912','America/New_York'), ('913','America/Chicago'), ('913','America/Denver'),
  ('914','America/New_York'), ('915','America/Chicago'), ('915','America/Denver'), ('916','America/Los_Angeles'), ('917','America/New_York'), ('918','America/Chicago'), ('919','America/New_York'), ('920','America/Chicago'),
  ('924','America/Chicago'), ('925','America/Los_Angeles'), ('928','America/Phoenix'), ('928','America/Denver'), ('929','America/New_York'), ('930','America/Indiana/Indianapolis'), ('930','America/Chicago'), ('931','America/Chicago'),
  ('931','America/New_York'), ('934','America/New_York'), ('936','America/Chicago'), ('936','America/Denver'), ('937','America/New_York'), ('938','America/Chicago'), ('939','America/Puerto_Rico'), ('940','America/Chicago'),
  ('940','America/Denver'), ('941','America/New_York'), ('941','America/Chicago'), ('942','America/Toronto'), ('942','America/Winnipeg'), ('943','America/New_York'), ('945','America/Chicago'), ('945','America/Denver'),
  ('947','America/Detroit'), ('947','America/Menominee'), ('948','America/New_York'), ('949','America/Los_Angeles'), ('951','America/Los_Angeles'), ('952','America/Chicago'), ('954','America/New_York'), ('954','America/Chicago'),
  ('956','America/Chicago'), ('956','America/Denver'), ('959','America/New_York'), ('970','America/Denver'), ('971','America/Los_Angeles'), ('971','America/Boise'), ('972','America/Chicago'), ('972','America/Denver'),
  ('973','America/New_York'), ('975','America/Chicago'), ('978','America/New_York'), ('979','America/Chicago'), ('979','America/Denver'), ('980','America/New_York'), ('983','America/Denver'), ('984','America/New_York'),
  ('985','America/Chicago'), ('986','America/Boise'), ('986','America/Los_Angeles'), ('989','America/Detroit'), ('989','America/Menominee');
INSERT INTO ai_isa_state_zones (state, zone) VALUES
  ('AB','America/Edmonton'), ('AK','America/Anchorage'), ('AK','America/Adak'), ('AL','America/Chicago'), ('AR','America/Chicago'), ('AS','Pacific/Pago_Pago'), ('AZ','America/Phoenix'), ('AZ','America/Denver'),
  ('BC','America/Vancouver'), ('BC','America/Edmonton'), ('BC','America/Creston'), ('CA','America/Los_Angeles'), ('CO','America/Denver'), ('CT','America/New_York'), ('DC','America/New_York'), ('DE','America/New_York'),
  ('FL','America/New_York'), ('FL','America/Chicago'), ('GA','America/New_York'), ('GU','Pacific/Guam'), ('HI','Pacific/Honolulu'), ('IA','America/Chicago'), ('ID','America/Boise'), ('ID','America/Los_Angeles'),
  ('IL','America/Chicago'), ('IN','America/Indiana/Indianapolis'), ('IN','America/Chicago'), ('KS','America/Chicago'), ('KS','America/Denver'), ('KY','America/New_York'), ('KY','America/Chicago'), ('LA','America/Chicago'),
  ('MA','America/New_York'), ('MB','America/Winnipeg'), ('MD','America/New_York'), ('ME','America/New_York'), ('MI','America/Detroit'), ('MI','America/Menominee'), ('MN','America/Chicago'), ('MO','America/Chicago'),
  ('MP','Pacific/Saipan'), ('MS','America/Chicago'), ('MT','America/Denver'), ('NB','America/Moncton'), ('NC','America/New_York'), ('ND','America/Chicago'), ('ND','America/Denver'), ('NE','America/Chicago'),
  ('NE','America/Denver'), ('NH','America/New_York'), ('NJ','America/New_York'), ('NL','America/St_Johns'), ('NL','America/Goose_Bay'), ('NM','America/Denver'), ('NS','America/Halifax'), ('NT','America/Yellowknife'),
  ('NU','America/Iqaluit'), ('NU','America/Winnipeg'), ('NU','America/Edmonton'), ('NV','America/Los_Angeles'), ('NV','America/Denver'), ('NY','America/New_York'), ('OH','America/New_York'), ('OK','America/Chicago'),
  ('ON','America/Toronto'), ('ON','America/Winnipeg'), ('OR','America/Los_Angeles'), ('OR','America/Boise'), ('PA','America/New_York'), ('PE','America/Halifax'), ('PR','America/Puerto_Rico'), ('QC','America/Toronto'),
  ('QC','America/Halifax'), ('RI','America/New_York'), ('SC','America/New_York'), ('SD','America/Chicago'), ('SD','America/Denver'), ('SK','America/Regina'), ('TN','America/Chicago'), ('TN','America/New_York'),
  ('TX','America/Chicago'), ('TX','America/Denver'), ('UT','America/Denver'), ('VA','America/New_York'), ('VI','America/St_Thomas'), ('VT','America/New_York'), ('WA','America/Los_Angeles'), ('WI','America/Chicago'),
  ('WV','America/New_York'), ('WY','America/Denver'), ('YT','America/Whitehorse');

-- =============================================================================
-- RLS (§8.3). Every tenant table: FORCE RLS, the restrictive tenant policy, the restrictive support policies and the
-- support_read_only statement trigger. Support is read-only everywhere.
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_isa_agent_optins','ai_isa_assignments','ai_isa_controls','ai_isa_stop_signals','ai_isa_person_blocks',
                           'ai_isa_turns','ai_isa_slot_offers','ai_isa_shared_facts','ai_isa_handoffs','ai_isa_daily_counts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE FOR ALL USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = ''staff'') WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = ''staff'')', t);
    EXECUTE format('CREATE POLICY support_read_only_ins ON %I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> ''support'')', t);
    EXECUTE format('CREATE POLICY support_read_only_upd ON %I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> ''support'')', t);
    EXECUTE format('CREATE POLICY support_read_only_del ON %I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> ''support'')', t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', t);
  END LOOP;
END $$;
ALTER TABLE ai_isa_area_code_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_isa_area_code_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY zones_read ON ai_isa_area_code_zones FOR SELECT USING ((SELECT app.principal_type()) = 'staff');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ai_isa_area_code_zones FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
ALTER TABLE ai_isa_state_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_isa_state_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY zones_read ON ai_isa_state_zones FOR SELECT USING ((SELECT app.principal_type()) = 'staff');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ai_isa_state_zones FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
GRANT SELECT ON ai_isa_area_code_zones, ai_isa_state_zones TO app_user, app_definer;

-- opt-ins: self; Owner/Admin (tenant-wide) all; a Team Lead their team's members. INSERT as self; UPDATE status only
CREATE POLICY optins_select ON ai_isa_agent_optins FOR SELECT USING (
  user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide())
  OR ((SELECT app.my_role()) = 'team_lead' AND user_id = ANY (app.my_team_member_ids())));
CREATE POLICY optins_insert ON ai_isa_agent_optins FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()));
CREATE POLICY optins_update ON ai_isa_agent_optins FOR UPDATE USING (user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide()))
  WITH CHECK (user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide()));
GRANT SELECT, INSERT, UPDATE (status, revoked_at, revoked_by_user_id) ON ai_isa_agent_optins TO app_user;

-- assignments and controls: the contact-detail audience or tenant-wide. INSERT by the owner as self (the guard);
-- UPDATE per the guard; controls are insert-only
CREATE POLICY assignments_select ON ai_isa_assignments FOR SELECT USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY assignments_insert ON ai_isa_assignments FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'user' AND started_by_user_id = (SELECT app.user_id()));
CREATE POLICY assignments_update ON ai_isa_assignments FOR UPDATE USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id))
  WITH CHECK ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id));
GRANT SELECT, INSERT, UPDATE ON ai_isa_assignments TO app_user;
CREATE POLICY controls_select ON ai_isa_controls FOR SELECT USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY controls_insert ON ai_isa_controls FOR INSERT WITH CHECK (
  ((SELECT app.actor_kind()) = 'system' AND by_kind = 'system')
  OR ((SELECT app.actor_kind()) = 'user' AND by_kind = 'user' AND by_user_id = (SELECT app.user_id())
      AND ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id))));
GRANT SELECT, INSERT ON ai_isa_controls TO app_user;

-- stop signals: any tenant actor may insert (a spurious row can only stop care); no UPDATE or DELETE
CREATE POLICY stop_signals_select ON ai_isa_stop_signals FOR SELECT USING (
  (SELECT app.is_tenant_wide()) OR (contact_id IS NOT NULL AND app.contact_detail_visible(tenant_id, contact_id)));
CREATE POLICY stop_signals_insert ON ai_isa_stop_signals FOR INSERT WITH CHECK (tenant_id = (SELECT app.tenant_id()));
GRANT SELECT, INSERT ON ai_isa_stop_signals TO app_user;
-- the stop-signal triggers also fire inside definer functions (e.g. app.contacts_dnc_follow_merge)
GRANT INSERT ON ai_isa_stop_signals TO app_definer;
GRANT INSERT ON jobs TO app_definer;

-- person blocks: the contact-detail audience reads; the system writes; the owner lifts (the guard)
CREATE POLICY blocks_select ON ai_isa_person_blocks FOR SELECT USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY blocks_insert ON ai_isa_person_blocks FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY blocks_update ON ai_isa_person_blocks FOR UPDATE USING ((SELECT app.actor_kind()) = 'system' OR app.contact_detail_visible(tenant_id, contact_id))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' OR app.contact_detail_visible(tenant_id, contact_id));
GRANT SELECT, INSERT, UPDATE ON ai_isa_person_blocks TO app_user;

-- turns, slot offers, shared facts: staff in the contact-detail audience read; the system writes
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_isa_turns','ai_isa_slot_offers','ai_isa_shared_facts'] LOOP
    EXECUTE format('CREATE POLICY isa_select ON %I FOR SELECT USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id))', t);
    EXECUTE format('CREATE POLICY isa_insert ON %I FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = ''system'')', t);
    EXECUTE format('CREATE POLICY isa_update ON %I FOR UPDATE USING ((SELECT app.actor_kind()) = ''system'') WITH CHECK ((SELECT app.actor_kind()) = ''system'')', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_user', t);
    EXECUTE format('GRANT SELECT ON %I TO app_definer', t);
  END LOOP;
END $$;
-- handoffs: the system writes; the recipient (or a tenant-wide role) may set acknowledged_* only (the guard)
CREATE POLICY isa_select ON ai_isa_handoffs FOR SELECT USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY isa_insert ON ai_isa_handoffs FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');
CREATE POLICY isa_update ON ai_isa_handoffs FOR UPDATE USING ((SELECT app.actor_kind()) = 'system' OR recipient_user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide()))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' OR recipient_user_id = (SELECT app.user_id()) OR (SELECT app.is_tenant_wide()));
GRANT SELECT, INSERT, UPDATE ON ai_isa_handoffs TO app_user;
GRANT SELECT ON ai_isa_handoffs, ai_isa_assignments, ai_isa_agent_optins, ai_isa_stop_signals, ai_isa_person_blocks, ai_isa_controls TO app_definer;
-- daily counts: Owner/Admin read; written only by the guard (app_definer bypasses RLS; app_user has no write grant)
CREATE POLICY counts_select ON ai_isa_daily_counts FOR SELECT USING ((SELECT app.my_role()) IN ('owner','admin') OR (SELECT app.actor_kind()) = 'system');
GRANT SELECT ON ai_isa_daily_counts TO app_user;
GRANT SELECT, INSERT, UPDATE ON ai_isa_daily_counts TO app_definer;

-- =============================================================================
-- 3. Guards (invoker)
-- =============================================================================

-- a zone must be a real IANA zone of this Postgres (core ianaZone is checked again here)
CREATE FUNCTION app.ai_isa_zone_valid(z text) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT z IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = z)
$$;

-- opt-ins (§3.3; R-ISA-32): INSERT only by the user as themselves, with an eligible role, on an approved ai_isa
-- version; the attestation hash is recomputed and must embed the version hash. Status moves active -> superseded |
-- revoked only; nothing else ever changes.
CREATE FUNCTION app.ai_isa_optins_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vh text;
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF app.actor_kind() <> 'user' OR NEW.user_id IS DISTINCT FROM app.user_id()
       OR app.my_role() NOT IN ('owner','admin','team_lead','agent') THEN
      RAISE EXCEPTION 'AI_ISA_OPTIN_SELF_ONLY: an agent opts in as themselves (owner, admin, team lead or agent)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT v.content_sha256 INTO vh FROM public.playbook_versions v JOIN public.playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
     WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.playbook_version_id AND v.status = 'approved' AND p.kind = 'ai_isa';
    IF vh IS NULL THEN
      RAISE EXCEPTION 'AI_ISA_POLICY_NOT_APPROVED: opt in to an approved AI assistant policy' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attestation_sha256 <> encode(sha256(convert_to(NEW.attestation, 'UTF8')), 'hex') OR position(vh IN NEW.attestation) = 0
       OR position('I''m responsible for leads I put in AI care.' IN NEW.attestation) = 0 THEN
      RAISE EXCEPTION 'AI_ISA_ATTESTATION_INVALID: the attestation does not match the policy version' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.ai_isa_zone_valid(NEW.timezone) THEN
      RAISE EXCEPTION 'AI_ISA_TIMEZONE_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'AI_ISA_OPTIN_STATUS' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('active','superseded','revoked')
     OR (NEW.tenant_id, NEW.id, NEW.user_id, NEW.playbook_version_id, NEW.attestation, NEW.attestation_sha256, NEW.capabilities,
         NEW.channels, NEW.timezone, NEW.availability, NEW.booking, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.user_id, OLD.playbook_version_id, OLD.attestation, OLD.attestation_sha256,
         OLD.capabilities, OLD.channels, OLD.timezone, OLD.availability, OLD.booking, OLD.created_at) THEN
    RAISE EXCEPTION 'AI_ISA_OPTIN_IMMUTABLE: an opt-in only moves from active to superseded or revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_isa_optins_guard BEFORE INSERT OR UPDATE ON ai_isa_agent_optins FOR EACH ROW EXECUTE FUNCTION app.ai_isa_optins_guard();

-- assignments (§8.2; R-ISA-1, -15, -16, -28)
CREATE FUNCTION app.ai_isa_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; person uuid[];
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
    person := app.contact_person_ids(NEW.tenant_id, NEW.contact_id);
    IF EXISTS (SELECT 1 FROM public.ai_isa_person_blocks b WHERE b.tenant_id = NEW.tenant_id AND b.contact_id = ANY (person) AND b.lifted_at IS NULL) THEN
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
CREATE TRIGGER ai_isa_assignments_guard BEFORE INSERT OR UPDATE ON ai_isa_assignments FOR EACH ROW EXECUTE FUNCTION app.ai_isa_assignments_guard();

-- person blocks: the system writes; a user (the contact's owner) only lifts, with a person-initiated inbound after
-- the block and an attestation (§5.1). "Not an opt-out" never lifts a block (that path never writes this table).
CREATE FUNCTION app.ai_isa_person_blocks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF app.actor_kind() = 'system' AND OLD.lifted_at IS NULL AND NEW.lifted_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.lifted_at IS NOT NULL
     OR (NEW.tenant_id, NEW.id, NEW.contact_id, NEW.assignment_id, NEW.reason, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.contact_id, OLD.assignment_id, OLD.reason, OLD.created_at)
     OR app.actor_kind() <> 'user' OR NEW.lifted_by_user_id IS DISTINCT FROM app.user_id()
     OR NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contact_id AND c.owner_user_id = app.user_id())
     OR NOT EXISTS (SELECT 1 FROM public.messages m
                     WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.lift_inbound_message_id AND m.direction = 'inbound'
                       AND m.contact_id = ANY (app.contact_person_ids(NEW.tenant_id, NEW.contact_id)) AND m.created_at > OLD.created_at)
     OR (OLD.reason IN ('opted_out','do_not_contact','wrong_number') ) THEN
    RAISE EXCEPTION 'AI_ISA_BLOCK_LIFT_REFUSED: a block lifts only by the owner, after a new message from the person, with an attestation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_isa_person_blocks_guard BEFORE UPDATE ON ai_isa_person_blocks FOR EACH ROW EXECUTE FUNCTION app.ai_isa_person_blocks_guard();

-- handoffs: frozen. The recipient (or a tenant-wide role) sets acknowledged_*; the system sets the SLA and
-- confirmation columns. Nothing else ever changes (R-ISA-14).
CREATE FUNCTION app.ai_isa_handoffs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF (NEW.tenant_id, NEW.id, NEW.assignment_id, NEW.contact_id, NEW.reason, NEW.basis, NEW.assistant_action_id, NEW.appointment_id,
      NEW.package, NEW.package_sha256, NEW.sla_class, NEW.recipient_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.assignment_id, OLD.contact_id, OLD.reason, OLD.basis, OLD.assistant_action_id,
      OLD.appointment_id, OLD.package, OLD.package_sha256, OLD.sla_class, OLD.recipient_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'AI_ISA_HANDOFF_FROZEN: a handoff package never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF app.actor_kind() <> 'system' AND (NEW.pending_message_id, NEW.confirmation_status, NEW.sla_due_at, NEW.sla_met_at,
       NEW.sla_escalated_at, NEW.sla_escalation_level) IS DISTINCT FROM (OLD.pending_message_id, OLD.confirmation_status, OLD.sla_due_at,
       OLD.sla_met_at, OLD.sla_escalated_at, OLD.sla_escalation_level) THEN
    RAISE EXCEPTION 'AI_ISA_HANDOFF_ACK_ONLY: "Got it" acknowledges; only a human touch clears the deadline' USING ERRCODE = 'check_violation';
  END IF;
  IF app.actor_kind() = 'user' AND NEW.acknowledged_at IS NOT NULL AND OLD.acknowledged_at IS NULL
     AND NEW.acknowledged_by_user_id IS DISTINCT FROM app.user_id() THEN
    RAISE EXCEPTION 'AI_ISA_HANDOFF_ACK_AS_SELF' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_isa_handoffs_guard BEFORE UPDATE ON ai_isa_handoffs FOR EACH ROW EXECUTE FUNCTION app.ai_isa_handoffs_guard();

-- controls, stop signals and shared facts (sent rows) are append-only ledgers.
-- Erasure (isa-2-1; R-DATA-7): app.purge_contact_internal deletes the person's contacts rows and the children cascade
-- (contacts -> assignments -> controls, turns, facts, slot offers, handoffs). The guards below let exactly that
-- cascade through and nothing else: a control row is deleted only by the foreign-key cascade of its deleted assignment
-- (pg_trigger_depth() > 1: fired from the cascade's trigger, never a direct DELETE; the parent row already gone), and
-- the bound message_id of a turn or a fact becomes NULL only by its ON DELETE SET NULL (the message row already gone,
-- every other column unchanged). Nobody else can delete an assignment or an action (no DELETE grant; the purge is the
-- only path); the only other message delete is the import revert's (0009/0010), of imported messages, which no turn
-- binds. Stop signals have no foreign key and are never deleted: they stay as opt-out evidence, like consent_events,
-- holding only the keyed address hash or the erased contact's id (docs/AI_ISA.md §8.3).
CREATE FUNCTION app.ai_isa_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'ai_isa_controls' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM public.ai_isa_assignments a WHERE a.tenant_id = OLD.tenant_id AND a.id = OLD.assignment_id) THEN
    RETURN OLD;   -- the cascade of an erased person's assignment
  END IF;
  RAISE EXCEPTION 'AI_ISA_LEDGER_APPEND_ONLY: % is insert-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER ai_isa_controls_immutable BEFORE UPDATE OR DELETE ON ai_isa_controls FOR EACH ROW EXECUTE FUNCTION app.ai_isa_ledger_immutable();
CREATE TRIGGER ai_isa_stop_signals_immutable BEFORE UPDATE OR DELETE ON ai_isa_stop_signals FOR EACH ROW EXECUTE FUNCTION app.ai_isa_ledger_immutable();
CREATE FUNCTION app.ai_isa_shared_facts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  -- erasure (isa-2-1): the fact's message was deleted; the fact goes with its assignment in the same statement
  IF OLD.message_id IS NOT NULL AND NEW.message_id IS NULL AND pg_trigger_depth() > 1
     AND (to_jsonb(OLD) - 'message_id') = (to_jsonb(NEW) - 'message_id')
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.tenant_id = OLD.tenant_id AND m.id = OLD.message_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('pending','sent','canceled')
     OR (NEW.tenant_id, NEW.id, NEW.assignment_id, NEW.contact_id, NEW.listing_id, NEW.fact_kind, NEW.price_cents, NEW.line_sha256, NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.assignment_id, OLD.contact_id, OLD.listing_id, OLD.fact_kind, OLD.price_cents,
                          OLD.line_sha256, OLD.created_at) THEN
    RAISE EXCEPTION 'AI_ISA_FACT_FROZEN: a fact moves pending -> sent | canceled only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_isa_shared_facts_guard BEFORE UPDATE ON ai_isa_shared_facts FOR EACH ROW EXECUTE FUNCTION app.ai_isa_shared_facts_guard();

-- turns: zones are real zones; status moves only from deciding/sending (attempt-guarded in the API)
CREATE FUNCTION app.ai_isa_turns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF NEW.zones IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(NEW.zones) z WHERE NOT app.ai_isa_zone_valid(z)) THEN
    RAISE EXCEPTION 'AI_ISA_ZONE_INVALID' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.id, NEW.assignment_id, NEW.contact_id, NEW.seq, NEW.trigger_key, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.assignment_id, OLD.contact_id, OLD.seq, OLD.trigger_key, OLD.created_at) THEN
    RAISE EXCEPTION 'AI_ISA_TURN_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  -- the frozen send plan never changes once a message is bound, except (isa-2-1) the ON DELETE SET NULL of an erased
  -- message: the turn goes with its assignment in the same statement
  IF TG_OP = 'UPDATE' AND OLD.message_id IS NOT NULL AND NEW.message_id IS NULL AND pg_trigger_depth() > 1
     AND (to_jsonb(OLD) - 'message_id' - 'updated_at') = (to_jsonb(NEW) - 'message_id' - 'updated_at')
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.tenant_id = OLD.tenant_id AND m.id = OLD.message_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.message_id IS NOT NULL
     AND (NEW.message_id, NEW.body_sha256, NEW.channel, NEW.message_kind) IS DISTINCT FROM (OLD.message_id, OLD.body_sha256, OLD.channel, OLD.message_kind) THEN
    RAISE EXCEPTION 'AI_ISA_TURN_PLAN_FROZEN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_isa_turns_guard BEFORE INSERT OR UPDATE ON ai_isa_turns FOR EACH ROW EXECUTE FUNCTION app.ai_isa_turns_guard();

-- a new live enrollment is refused while the contact has a live assignment (R-ISA-2). Invoker: an enroller who
-- cannot see the assignment is refused by the API check instead (enrollments.ts).
CREATE FUNCTION app.playbook_enrollments_ai_isa_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  IF NEW.state = 'active' AND (TG_OP = 'INSERT' OR OLD.state <> 'active')
     AND EXISTS (SELECT 1 FROM public.ai_isa_assignments a WHERE a.tenant_id = NEW.tenant_id AND a.ended_at IS NULL
                   AND a.contact_id = ANY (app.contact_person_ids(NEW.tenant_id, NEW.contact_id))) THEN
    RAISE EXCEPTION 'AI_ISA_ACTIVE: this person is under AI care; playbooks wait until it ends' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER playbook_enrollments_ai_isa_guard BEFORE INSERT OR UPDATE OF state ON playbook_enrollments
  FOR EACH ROW EXECUTE FUNCTION app.playbook_enrollments_ai_isa_guard();

-- =============================================================================
-- 4. Stop-signal triggers (R-ISA-31). AFTER, invoker, un-deduped job (a trigger never aborts the writer on a
-- duplicate). They write only within the writer's own tenant context: a writer without one (none exists today)
-- still meets D1's checks in the guard, which read consent_state, suppressions and do_not_contact directly.
-- =============================================================================
CREATE FUNCTION app.ai_isa_signal(p_tenant uuid, p_hmac bytea, p_contact uuid, p_reason text, p_table text, p_source uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE sid uuid := gen_random_uuid();
BEGIN
  IF app.tenant_id() IS DISTINCT FROM p_tenant THEN RETURN; END IF;
  INSERT INTO public.ai_isa_stop_signals (tenant_id, id, address_hmac, contact_id, reason, source_table, source_id)
  VALUES (p_tenant, sid, p_hmac, p_contact, p_reason, p_table, p_source);
  INSERT INTO public.jobs (tenant_id, queue, kind, payload, run_at)
  VALUES (p_tenant, 'realtime', 'ai_isa.stop_signal', jsonb_build_object('signalId', sid), clock_timestamp());
END $$;
CREATE FUNCTION app.ai_isa_signal_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IN ('revoke','expire','import_revert') THEN
    PERFORM app.ai_isa_signal(NEW.tenant_id, NEW.address_hmac, NULL,
      CASE WHEN NEW.source = 'wrong_number' THEN 'wrong_number' ELSE 'opted_out' END, 'consent_events', NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ai_isa_signal_consent AFTER INSERT ON consent_events FOR EACH ROW EXECUTE FUNCTION app.ai_isa_signal_consent();
CREATE FUNCTION app.ai_isa_signal_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.ai_isa_signal(NEW.tenant_id, NEW.address_hmac, NULL,
    CASE WHEN NEW.reason = 'wrong_number' THEN 'wrong_number' ELSE 'suppressed' END, 'suppressions', NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER ai_isa_signal_suppression AFTER INSERT ON suppressions FOR EACH ROW EXECUTE FUNCTION app.ai_isa_signal_suppression();
CREATE FUNCTION app.ai_isa_signal_dnc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.do_not_contact_at IS NOT NULL AND OLD.do_not_contact_at IS NULL THEN
    PERFORM app.ai_isa_signal(NEW.tenant_id, NULL, NEW.id, 'do_not_contact', 'contacts', NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ai_isa_signal_dnc AFTER UPDATE OF do_not_contact_at ON contacts FOR EACH ROW EXECUTE FUNCTION app.ai_isa_signal_dnc();

-- =============================================================================
-- 5. Appointments: the booking lock before the row is written, and no assistant overlap (R-ISA-13, E532).
-- The key is calendar/repos/links.ts's, so it is re-entrant inside the booking job.
-- =============================================================================
CREATE FUNCTION app.appointments_book_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('calendar.book:' || NEW.tenant_id::text || ':' || NEW.user_id::text, 0));
  IF NEW.created_by_kind = 'assistant' AND NEW.status IN ('scheduled','held')
     AND EXISTS (SELECT 1 FROM public.appointments o
                  WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id AND o.id <> NEW.id
                    AND o.status IN ('scheduled','held') AND o.starts_at < NEW.ends_at AND o.ends_at > NEW.starts_at) THEN
    RAISE EXCEPTION 'APPOINTMENT_OVERLAP: the organizer already has an appointment at that time' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_book_lock BEFORE INSERT OR UPDATE OF starts_at, ends_at, status, user_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION app.appointments_book_lock();

-- =============================================================================
-- 6. The guard's ai_isa_mandate branch (§5.4; R-ISA-1, -4, -8, -9, -10, -11, -28, -31).
-- app.ai_isa_send_check is an INVOKER function whose EXECUTE is granted only to app_definer: it runs only inside
-- app.messages_dispatch_guard (a definer, BYPASSRLS), so every read is keyed by NEW.tenant_id explicitly. Called by
-- anyone else it is refused by the grant. It raises one code per refusal, in the order: binding, freshness,
-- liveness, chain, shared address / active client, unread part, consent, quiet hours, caps (the daily upsert last,
-- so a refusal never counts).
-- =============================================================================
CREATE FUNCTION app.ai_isa_send_check(m public.messages) RETURNS void LANGUAGE plpgsql
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
     OR EXISTS (SELECT 1 FROM public.ai_isa_person_blocks b WHERE b.tenant_id = m.tenant_id AND b.contact_id = ANY (person) AND b.lifted_at IS NULL
                  AND b.created_at >= asg.started_at) THEN
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
REVOKE ALL ON FUNCTION app.ai_isa_send_check(public.messages) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_isa_send_check(public.messages) TO app_definer;

-- The guard: the newest body (0065, telephony S3) verbatim, plus the ai_isa_mandate branch in the autonomy CASE and
-- (batch 12, isa-2-2) the refusal of an AI ISA category under any other autonomy.
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
    ELSIF NEW.action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') AND a.autonomy IS DISTINCT FROM 'ai_isa_mandate' THEN
      -- 0190 (batch 12, isa-2-2): an AI ISA category goes out only under the mandate, whoever sends it
      RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: AI assistant categories are sent only under the AI assistant mandate (assistant)' USING ERRCODE = 'check_violation';
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
    ELSIF a.autonomy = 'ai_isa_mandate' THEN
      -- 0190 (D12, R-ISA-8): every AI ISA check of docs/AI_ISA.md §5.4, after D1's above
      PERFORM app.ai_isa_send_check(NEW);
    ELSE
      RAISE EXCEPTION 'ASSISTANT_ACTION_NOT_SENDABLE' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line') THEN
    -- 0190: an AI ISA category is never sent by a human or the system
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: AI assistant categories are sent only under the AI assistant mandate' USING ERRCODE = 'check_violation';
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
  IF (SELECT position('app.contact_person_ids' IN p.prosrc) = 0 OR position('wrong_number' IN p.prosrc) = 0
             OR position('MARKETING_PIECE_NOT_APPROVED' IN p.prosrc) = 0 OR position('ASSISTANT_ACTION_WITHDRAWN' IN p.prosrc) = 0
             OR position('im.from_address = NEW.to_address' IN p.prosrc) = 0
             OR position('NEW.channel = ''sms'' AND im.channel = ''mms''' IN p.prosrc) = 0
             OR position('app.ai_isa_send_check(NEW)' IN p.prosrc) = 0
             OR position('a.autonomy IS DISTINCT FROM ''ai_isa_mandate''' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.messages_dispatch_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'messages_dispatch_guard lost a rule';
  END IF;
  IF has_function_privilege('app_user', 'app.ai_isa_send_check(public.messages)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_isa_send_check must run only inside the guard';
  END IF;
END $$;
