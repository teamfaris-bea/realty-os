-- AI ISA seller grounding (lane ISA-3; module 75 seller part; owner decision D12 PROPOSED; docs/AI_ISA.md §6.3, §8.2,
-- §8.3). Lane number 0191, renumbered 0084 at the batch 13 merge (after 0083); no code or test names this file.
-- Security notes: docs/ARCHITECTURE.md §21.46.
--
--   1. ai_isa_seller_watch: one row per seller- or both-side assignment. The owner's subject confirmation, the
--      near-match dismissals, the comps suspension and resume, the competition snapshot and the last comps check
--      (codes only). FORCE RLS, the tenant and support policies, the support statement trigger.
--   2. Invoker guards (no SECURITY DEFINER function; §8.4):
--      ai_isa_seller_watch_guard        only the live assignment's owner, as a user, confirms the subject, dismisses a
--                                       near match or resumes comps; the system never confirms; any other user may
--                                       only clear the subject; contact_address_id becoming NULL clears it for anyone.
--      ai_isa_subject_address_cleared   an edit of the confirmed address clears the confirmation, as the editor.
--      ai_isa_seller_fact_email_only    a sold_comp_set or nearby_sale fact is never on a non-email message.
--   3. platform:ai_isa_seller_data@2026.11.1: published unreviewed with its scope and client lines (D11: a new version
--      ships unreviewed even if 2026.11.0 was recorded; packages/db/src/counselReview.ts). VERIFY WITH COUNSEL.
--   Batch 13 merge (this file was applied nowhere before it, so the changes are made here):
--   4. db-isa-merge-2 (R-ISA-22, E526): seller_watch_select and seller_watch_update also admit a row whose record's
--      ROOT SURVIVOR the caller sees in detail (0075's app.contact_merge_root, unchanged), as 0081 does for every other
--      ai_isa_* read policy. For a record never merged away the root is the record itself, so it admits nothing new.
--   5. R-DATA-7 (ISA-3 audit F7): the guard's address-gone branch runs before its foreign-tenant early return, so the
--      foreign key's SET NULL during the retention purge (run as the table owner with no app.tenant_id) clears a
--      confirmed subject instead of leaving it to the CHECK, which aborted the purge. The branch reads nothing.
--   6. ISA-3 audit F11: a user points the watch at another address only by confirming (never by clearing, so a clear
--      cannot repoint it to another of the contact's addresses), and subject_cleared_reason changes only with a clear or
--      a confirmation; a user's clear always records 'address_changed' (the guard's value, not the caller's).

-- =============================================================================
-- 1. ai_isa_seller_watch
-- =============================================================================
CREATE TABLE ai_isa_seller_watch (
  tenant_id                    uuid NOT NULL,
  assignment_id                uuid NOT NULL,
  contact_id                   uuid NOT NULL,
  contact_address_id           uuid,
  subject_address_key          text,
  subject_connection_id        uuid,
  subject_record_listing_id    uuid,
  subject_record_date          timestamptz,
  -- the record's facts as confirmed: {type, beds, baths_x10, sqft} and nothing else
  subject_facts                jsonb CHECK (subject_facts IS NULL OR (jsonb_typeof(subject_facts) = 'object'
                                 AND subject_facts - 'type' - 'beds' - 'baths_x10' - 'sqft' = '{}'::jsonb)),
  subject_confirmed_by_user_id uuid,
  subject_confirmed_at         timestamptz,
  subject_disputed_at          timestamptz,
  subject_cleared_reason       text CHECK (subject_cleared_reason IN ('address_changed','address_deleted','record_changed','default_changed')),
  near_match_dismissed         uuid[] NOT NULL DEFAULT '{}',
  -- competition: listing id -> {status, mls_modified_at, price_kind, price_cents} (asking prices only; never sold data)
  last_snapshot                jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(last_snapshot) = 'object'),
  -- the display-rules and rule versions the snapshot was taken under (sha256 hex per connection, the rule version)
  snapshot_versions            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(snapshot_versions) = 'object'),
  -- the last comps check: codes, the comp-set hash and when; never a price, an address or a name
  last_comps_check             jsonb CHECK (last_comps_check IS NULL OR (jsonb_typeof(last_comps_check) = 'object'
                                 AND last_comps_check - 'codes' - 'comp_set_hash' - 'checked_at' = '{}'::jsonb
                                 AND app.ai_isa_codes_only(COALESCE(last_comps_check -> 'codes', '[]'::jsonb))
                                 AND (last_comps_check -> 'comp_set_hash' IS NULL OR last_comps_check ->> 'comp_set_hash' ~ '^[0-9a-f]{64}$'))),
  comps_suspended_at           timestamptz,
  comps_resumed_at             timestamptz,
  comps_resumed_by_user_id     uuid,
  comps_resumed_reason         text CHECK (comps_resumed_reason IN ('owner_resume','cma_prepared','cma_shared')),
  last_run_at                  timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, assignment_id),
  CHECK ((subject_confirmed_at IS NULL) = (subject_confirmed_by_user_id IS NULL)),
  CHECK (subject_confirmed_at IS NULL OR (contact_address_id IS NOT NULL AND subject_address_key IS NOT NULL AND subject_record_listing_id IS NOT NULL
         AND subject_facts IS NOT NULL)),
  CHECK ((comps_resumed_at IS NULL) = (comps_resumed_reason IS NULL)),
  CHECK (cardinality(near_match_dismissed) <= 50),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES ai_isa_assignments (tenant_id, id) ON DELETE CASCADE,
  -- the composite target is 0061's unique index; a deleted address nulls only the address (the guard clears the subject)
  FOREIGN KEY (tenant_id, contact_id, contact_address_id) REFERENCES contact_addresses (tenant_id, contact_id, id) ON DELETE SET NULL (contact_address_id)
);
CREATE INDEX ai_isa_seller_watch_address_idx ON ai_isa_seller_watch (tenant_id, contact_address_id) WHERE contact_address_id IS NOT NULL;
CREATE INDEX ai_isa_seller_watch_contact_idx ON ai_isa_seller_watch (tenant_id, contact_id);

ALTER TABLE ai_isa_seller_watch ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_isa_seller_watch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_isa_seller_watch AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON ai_isa_seller_watch AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON ai_isa_seller_watch AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON ai_isa_seller_watch AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ai_isa_seller_watch FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

-- SELECT: the contact-detail audience (staff only, the tenant policy) or tenant-wide.
-- (batch 13 merge, db-isa-merge-2) or the detail audience of the record's root survivor, as every other ai_isa_* read policy (0081)
CREATE POLICY seller_watch_select ON ai_isa_seller_watch FOR SELECT USING ((SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)
  OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));
-- INSERT: the system, or the assignment's owner as themselves (the assignment is read under its own RLS).
CREATE POLICY seller_watch_insert ON ai_isa_seller_watch FOR INSERT WITH CHECK (
  (SELECT app.actor_kind()) = 'system'
  OR ((SELECT app.actor_kind()) = 'user' AND EXISTS (
        SELECT 1 FROM public.ai_isa_assignments a
         WHERE a.tenant_id = ai_isa_seller_watch.tenant_id AND a.id = ai_isa_seller_watch.assignment_id
           AND a.owner_user_id = (SELECT app.user_id()))));
-- UPDATE: the system or the contact-detail audience, narrowed by the guard (wider than §8.3 so the address trigger
-- can run as the editor, who always passes contact_detail_visible), and the root survivor's (batch 13 merge, as 0081's
-- blocks_update).
CREATE POLICY seller_watch_update ON ai_isa_seller_watch FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'system' OR (SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)
         OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)))
  WITH CHECK ((SELECT app.actor_kind()) = 'system' OR (SELECT app.is_tenant_wide()) OR app.contact_detail_visible(tenant_id, contact_id)
         OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));
-- no DELETE: rows go with their assignment (cascade)
GRANT SELECT, INSERT, UPDATE ON ai_isa_seller_watch TO app_user;

-- =============================================================================
-- 2. Guards (invoker)
-- =============================================================================
CREATE FUNCTION app.ai_isa_seller_watch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind      text := app.actor_kind();
  me        uuid := app.user_id();
  a_owner   uuid;
  a_contact uuid;
  a_side    text;
  a_ended   timestamptz;
  is_owner  boolean;
  subj_old  jsonb;
  subj_new  jsonb;
  confirming boolean;
  clearing   boolean;
  sys_changed boolean;
BEGIN
  -- the address is gone (its delete's foreign key action, run as the table owner, or any actor): the subject goes
  -- with it. Nothing else is read here, so the foreign key path never depends on the caller's RLS. It runs before the
  -- foreign-tenant return below (batch 13 merge, ISA-3 F7): the retention purge deletes addresses with no
  -- app.tenant_id, and a confirmed subject left behind would fail the CHECK and abort the purge (R-DATA-7).
  IF NEW.contact_address_id IS NULL AND (TG_OP = 'INSERT' OR OLD.contact_address_id IS NOT NULL) THEN
    IF TG_OP = 'UPDATE' AND OLD.subject_confirmed_at IS NOT NULL THEN NEW.subject_cleared_reason := 'address_deleted'; END IF;
    NEW.subject_address_key := NULL; NEW.subject_connection_id := NULL; NEW.subject_record_listing_id := NULL;
    NEW.subject_record_date := NULL; NEW.subject_facts := NULL;
    NEW.subject_confirmed_by_user_id := NULL; NEW.subject_confirmed_at := NULL;
    IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.assignment_id, NEW.contact_id) IS DISTINCT FROM (OLD.tenant_id, OLD.assignment_id, OLD.contact_id) THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the assignment and contact of a seller watch never change' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); RETURN NEW; END IF;
  END IF;

  -- another tenant's row: RLS refuses it (the guard never runs ahead of the tenant policy)
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  NEW.updated_at := now();

  SELECT a.owner_user_id, a.contact_id, a.side, a.ended_at INTO a_owner, a_contact, a_side, a_ended
    FROM public.ai_isa_assignments a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assignment_id;
  IF a_owner IS NULL OR a_contact IS DISTINCT FROM NEW.contact_id OR a_side NOT IN ('seller','both') THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: a seller watch belongs to a seller- or both-side assignment of its contact' USING ERRCODE = 'check_violation';
  END IF;
  is_owner := kind = 'user' AND me IS NOT NULL AND me = a_owner AND a_ended IS NULL;

  subj_new := jsonb_build_array(NEW.contact_address_id, NEW.subject_address_key, NEW.subject_connection_id, NEW.subject_record_listing_id,
                                NEW.subject_record_date, NEW.subject_facts, NEW.subject_confirmed_by_user_id, NEW.subject_confirmed_at);
  IF TG_OP = 'INSERT' THEN
    subj_old := jsonb_build_array(NEW.contact_address_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  ELSE
    IF (NEW.tenant_id, NEW.assignment_id, NEW.contact_id, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.assignment_id, OLD.contact_id, OLD.created_at) THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the assignment and contact of a seller watch never change' USING ERRCODE = 'check_violation';
    END IF;
    subj_old := jsonb_build_array(OLD.contact_address_id, OLD.subject_address_key, OLD.subject_connection_id, OLD.subject_record_listing_id,
                                  OLD.subject_record_date, OLD.subject_facts, OLD.subject_confirmed_by_user_id, OLD.subject_confirmed_at);
  END IF;
  confirming := subj_new IS DISTINCT FROM subj_old AND NEW.subject_confirmed_at IS NOT NULL;
  clearing := subj_new IS DISTINCT FROM subj_old AND NEW.subject_confirmed_at IS NULL
              AND NEW.subject_address_key IS NULL AND NEW.subject_connection_id IS NULL AND NEW.subject_record_listing_id IS NULL
              AND NEW.subject_record_date IS NULL AND NEW.subject_facts IS NULL;
  IF subj_new IS DISTINCT FROM subj_old AND NOT confirming AND NOT clearing AND NOT (TG_OP = 'UPDATE'
       AND NEW.contact_address_id IS DISTINCT FROM OLD.contact_address_id AND NEW.subject_confirmed_at IS NULL AND OLD.subject_confirmed_at IS NULL
       AND (NEW.subject_address_key, NEW.subject_connection_id, NEW.subject_record_listing_id, NEW.subject_record_date, NEW.subject_facts) IS NOT DISTINCT FROM
           (OLD.subject_address_key, OLD.subject_connection_id, OLD.subject_record_listing_id, OLD.subject_record_date, OLD.subject_facts)) THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the subject is confirmed whole or cleared whole' USING ERRCODE = 'check_violation';
  END IF;

  -- the confirmation: only the live assignment's owner, as themselves, at the database clock; the system never
  IF confirming THEN
    IF kind = 'system' THEN
      RAISE EXCEPTION 'ISA_SUBJECT_SYSTEM_NEVER_CONFIRMS: only the lead''s owner confirms the seller''s home' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT is_owner OR NEW.subject_confirmed_by_user_id IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner, as themselves, confirms the seller''s home' USING ERRCODE = 'check_violation';
    END IF;
    NEW.subject_confirmed_at := now();
    NEW.subject_cleared_reason := NULL;
    NEW.subject_disputed_at := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.subject_disputed_at IS NOT NULL OR NEW.comps_suspended_at IS NOT NULL OR NEW.comps_resumed_at IS NOT NULL OR cardinality(NEW.near_match_dismissed) > 0
       OR NEW.last_snapshot <> '{}'::jsonb OR NEW.snapshot_versions <> '{}'::jsonb OR NEW.last_comps_check IS NOT NULL OR NEW.last_run_at IS NOT NULL THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: a seller watch starts empty' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- the owner's own columns: near-match dismissals and an owner resume
  IF NEW.near_match_dismissed IS DISTINCT FROM OLD.near_match_dismissed AND NOT is_owner THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner says a live listing is a different home' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.comps_resumed_at, NEW.comps_resumed_by_user_id, NEW.comps_resumed_reason) IS DISTINCT FROM (OLD.comps_resumed_at, OLD.comps_resumed_by_user_id, OLD.comps_resumed_reason) THEN
    IF NEW.comps_resumed_at IS NULL THEN
      IF kind <> 'system' THEN RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the system clears a comps resume' USING ERRCODE = 'check_violation'; END IF;
    ELSIF kind = 'system' THEN
      IF NEW.comps_resumed_reason NOT IN ('cma_prepared','cma_shared') THEN
        RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the system resumes comps only after the owner''s CMA' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT is_owner OR NEW.comps_resumed_reason <> 'owner_resume' OR NEW.comps_resumed_by_user_id IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner, as themselves, lets the assistant keep sharing recent sales' USING ERRCODE = 'check_violation';
    ELSE
      NEW.comps_resumed_at := now();
    END IF;
  END IF;

  -- the system's columns: snapshots, the comps check, runs and the suspension. A user may mark the subject disputed
  -- (set, never clear) and the owner's confirmation clears it.
  sys_changed := (NEW.last_snapshot, NEW.snapshot_versions, NEW.last_comps_check, NEW.last_run_at, NEW.comps_suspended_at)
                 IS DISTINCT FROM (OLD.last_snapshot, OLD.snapshot_versions, OLD.last_comps_check, OLD.last_run_at, OLD.comps_suspended_at);
  IF sys_changed AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the watch''s runs and checks are the system''s' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.subject_disputed_at IS DISTINCT FROM OLD.subject_disputed_at AND NOT confirming AND NEW.subject_disputed_at IS NULL AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: a dispute is cleared by the owner''s confirmation' USING ERRCODE = 'check_violation';
  END IF;

  -- any other user: only clears the subject (an address edit's trigger runs as the editor) or marks it disputed
  IF kind = 'user' AND NOT is_owner AND subj_new IS DISTINCT FROM subj_old AND NOT clearing THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner confirms the seller''s home' USING ERRCODE = 'check_violation';
  END IF;
  -- (batch 13, ISA-3 audit F11) the watch's address and the cleared reason the panel shows: a user points the watch at
  -- another address only by confirming (the owner, at the current default), never by clearing; the reason changes only
  -- with a clear or a confirmation, and a user's clear is always an address change (the guard's value, not the caller's)
  IF NEW.contact_address_id IS DISTINCT FROM OLD.contact_address_id AND NOT confirming AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: only the lead''s owner, confirming the home, points the watch at another address' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.subject_cleared_reason IS DISTINCT FROM OLD.subject_cleared_reason AND NOT confirming AND NOT clearing AND kind <> 'system' THEN
    RAISE EXCEPTION 'ISA_SUBJECT_OWNER_ONLY: the cleared reason changes only when the subject is cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF clearing AND kind <> 'system' THEN NEW.subject_cleared_reason := 'address_changed';
  ELSIF clearing AND NEW.subject_cleared_reason IS NULL THEN NEW.subject_cleared_reason := 'address_changed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_isa_seller_watch_guard BEFORE INSERT OR UPDATE ON ai_isa_seller_watch FOR EACH ROW EXECUTE FUNCTION app.ai_isa_seller_watch_guard();

-- an edit of the confirmed address clears the confirmation, as the editor (who passes contact_detail_visible,
-- 0001's contact_detail policy). A new default address (a property address added) is caught at read time.
CREATE FUNCTION app.ai_isa_subject_address_cleared() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.ai_isa_seller_watch w
     SET subject_address_key = NULL, subject_connection_id = NULL, subject_record_listing_id = NULL, subject_record_date = NULL,
         subject_facts = NULL, subject_confirmed_by_user_id = NULL, subject_confirmed_at = NULL, subject_cleared_reason = 'address_changed'
   WHERE w.tenant_id = NEW.tenant_id AND w.contact_address_id = NEW.id AND w.subject_confirmed_at IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER ai_isa_subject_address_cleared AFTER UPDATE OF line1, line2, city, region, postal_code, kind ON contact_addresses
  FOR EACH ROW WHEN ((OLD.line1, OLD.line2, OLD.city, OLD.region, OLD.postal_code, OLD.kind) IS DISTINCT FROM (NEW.line1, NEW.line2, NEW.city, NEW.region, NEW.postal_code, NEW.kind))
  EXECUTE FUNCTION app.ai_isa_subject_address_cleared();

-- the DB backstop of "sold-derived facts by email only" (core gate.ts is the core one): a sold_comp_set or
-- nearby_sale fact is never tied to a non-email message. A message the writer cannot read fails closed.
CREATE FUNCTION app.ai_isa_seller_fact_email_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fact_kind IN ('sold_comp_set','nearby_sale') AND NEW.message_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.messages m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.message_id AND m.channel = 'email') THEN
    RAISE EXCEPTION 'ISA_SELLER_FACT_EMAIL_ONLY: sold-derived facts go by email only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_isa_seller_fact_email_only BEFORE INSERT OR UPDATE OF message_id ON ai_isa_shared_facts
  FOR EACH ROW EXECUTE FUNCTION app.ai_isa_seller_fact_email_only();

-- =============================================================================
-- 3. platform:ai_isa_seller_data@2026.11.1 (unreviewed; D11 does not cover it)
-- =============================================================================
UPDATE jurisdiction_packs SET status = 'retired' WHERE key = 'platform:ai_isa_seller_data' AND status = 'published';
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:ai_isa_seller_data', '2026.11.1', 'published',
   jsonb_build_object(
     'scope', 'automated sold comps to seller leads by email, with this wording',
     'client_lines', jsonb_build_array(
       'These are sales records, not an appraisal or a price for your home.',
       'Condition and updates aren''t in the MLS record.',
       'Prices are as recorded in the MLS and may include seller concessions.',
       'Only sales the MLS allows us to show are included.')),
   NULL,
   'Automated sold comps to seller leads by email, and the client lines they carry verbatim (C-ISA-8, 9, 10). Nearby sales are not sent in this version. Engineering placeholder; ships unreviewed. VERIFY WITH COUNSEL / MLS.');

-- =============================================================================
-- Self-check (batch 13 merge): the root-survivor branch on both read/update policies, and the address-gone branch
-- ahead of the foreign-tenant return
-- =============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS c FROM pg_policy p
            WHERE p.polrelid = 'public.ai_isa_seller_watch'::regclass AND p.polname IN ('seller_watch_select','seller_watch_update') LOOP
    IF r.q NOT LIKE '%contact_merge_root%' OR (r.polname = 'seller_watch_update' AND r.c NOT LIKE '%contact_merge_root%') THEN
      RAISE EXCEPTION '0084 self-check failed: ai_isa_seller_watch.% has no root-survivor branch', r.polname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.ai_isa_seller_watch'::regclass AND p.polname IN ('seller_watch_select','seller_watch_update')) <> 2 THEN
    RAISE EXCEPTION '0084 self-check failed: a seller watch policy is missing';
  END IF;
  IF (SELECT position('IF NEW.contact_address_id IS NULL AND' IN p.prosrc) = 0
             OR position('IF NEW.contact_address_id IS NULL AND' IN p.prosrc) > position('IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id' IN p.prosrc)
        FROM pg_proc p WHERE p.oid = 'app.ai_isa_seller_watch_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0084 self-check failed: the address-gone branch must run before the foreign-tenant return';
  END IF;
END $$;
