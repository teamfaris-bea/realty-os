-- Batch 18, owner decision 2026-11-14 on imported sources, the enforcement half (DATA_MODEL R-LSRC-9, E729 to E737).
-- Security notes: docs/ARCHITECTURE.md §21.68.
--
--   The owner decided that an imported person whose source nobody has reviewed stays "in review" with automations
--   disabled until the Owner classifies them: an unmapped label, a label two lead sources hold, and a person imported
--   with no label at all. Before this migration only a label the Owner had mapped to a MARKED source refused anything;
--   every other imported person was open to plans, triggers, bulk sends, AI care and AI-answered calls.
--
--   "Unclassified" is computed, never stored: a person has at least one COMMITTED contacts import record (outcome
--   'imported' or 'merged', targeting any record of the person: the merge tree, app.contact_person_ids) whose label is
--   not held by exactly one lead source (lead_sources.import_labels), or that carries no label and whose import's
--   no-label group is not held by exactly one lead source (lead_sources.import_unlabeled_batches, new). A dry run, a
--   rejected, skipped, duplicate or reverted record, a record that only matched a person, a record of another import
--   category and anything a caller sent at intake (contacts.original_source_detail) are not import evidence. A native
--   lead has no such record and is never unclassified.
--
--   * lead_sources.import_unlabeled_batches (uuid[], default empty): the imports (import_batches.id) whose people that
--     came in with NO source label are this source's. Per import, never across imports: a missing label in one file
--     says nothing about another file. Owner only, by the same invoker guard as a label (below).
--   * app.lead_sources_import_labels_guard (invoker; replaced, same name): also covers the new column; its trigger is
--     re-created on both columns. What it does with a missing tenant context is unchanged from 0099.
--   * app.person_from_lead_source(tenant, contact, source) (SECURITY DEFINER; replaced: same signature, owner
--     app_definer, pinned path, explicit tenant check, one boolean): an imported label is compared WHOLE (0099 compared
--     the first 120 characters, so two long labels that shared them counted as one), and a source that holds an import's
--     no-label group sent the people that import targeted or matched with no label.
--   * app.person_source_refusal(tenant, contact) (SECURITY DEFINER, new; owner app_definer, pinned path, explicit tenant
--     check, returns one text or NULL): 'SOURCE_NO_AUTOMATED_CONTACT' when a marked source sent the person (it wins),
--     else 'SOURCE_UNCLASSIFIED' when the person is unclassified as defined above, else NULL. It reads past the caller's
--     RLS (every record of the person), returns only the code, and is NULL for any tenant but the caller's.
--   * app.person_no_ai_care_source(tenant, contact) (SECURITY DEFINER; replaced: same signature, owner, path, grants):
--     true when app.person_source_refusal is not NULL. Every automated path, dispatch TX1 and the guards already ask
--     it, so each refuses an unclassified person exactly where it refuses a marked source's person.
--   * app.playbook_enrollments_source_guard, app.messages_source_guard, app.calls_source_guard and
--     app.ai_isa_assignments_source_guard (invokers; replaced, same names and triggers): each raises the reason that
--     applies ('SOURCE_NO_AUTOMATED_CONTACT: ...' or 'SOURCE_UNCLASSIFIED: ...'; AI care: 'AI_ISA_SOURCE_NO_AI_CARE: ...'
--     or 'AI_ISA_SOURCE_UNCLASSIFIED: ...'). They still look only at the activating write (a plan made active, a call
--     the assistant takes, AI care opened or resumed), read no lock and take none, so an opt-out, a pause, a stop, an
--     inbound message or call and a person's one-to-one send never wait on, or fail because of, a mapping or an import.
--     What each does with a missing or foreign tenant context is unchanged (it returns; §21.68 says why that is safe).
--   * the messages_source_guard trigger now fires on INSERT too: an automated message inserted directly in a sending
--     state ('dispatching', 'sent', 'delivered', 'dispatch_unknown') for a covered person is refused. On UPDATE it still
--     looks only at the move to 'dispatching' (a later status reconciliation of a message already sent is never refused).
--   * stage_automation_decisions.reason and ai_isa_assignments.pause_reason gain 'source_unclassified'.
--   * import_records_contact_label: an index on the contacts import records by label, so a mapping change finds one
--     label's people (to stop what is running, and to count them in its answer) without reading the tenant's whole
--     import history.
--   * app.import_source_people(tenant, label, import) (SECURITY DEFINER, new; owner app_definer, pinned path, explicit
--     tenant check): the people one imported label, or one import's no-label group, brought in (each contact id once,
--     with whether a COMMITTED record targets it). It exists only so that this lookup can use the index above: under
--     row-level security app_user's own query may not use an index condition built from non-leakproof functions
--     (left, ->>), so it would read every import record of the tenant. It answers only a caller who may read
--     import_records anyway (app.is_tenant_wide(): Owner, Admin, system), and nobody else and no other tenant: it
--     discloses nothing row-level security hides.
--
--   EXISTING DATA. This migration changes no plan, message, draft, AI care or import row. From the moment it is
--   applied, every already-imported person whose label is not already Owner-mapped (and every one imported with no
--   label) reads as unclassified, so every automated path, dispatch and the guards refuse them at once. Their running
--   plans, live AI care and pending drafts are NOT touched here: a plan stops when its next step job runs (the step
--   runner asks before anything else), AI care pauses at its next turn (chain link 11), a draft's approval is refused,
--   and the API stops them in bounded work when the Owner next maps a label or an import commits
--   (apps/api/src/leads/sources.ts). No table, policy or retention change; app_user gains only EXECUTE on the two new
--   definers.

ALTER TABLE lead_sources ADD COLUMN import_unlabeled_batches uuid[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(import_unlabeled_batches) <= 200 AND array_position(import_unlabeled_batches, NULL) IS NULL);
COMMENT ON COLUMN lead_sources.import_unlabeled_batches IS
  'b18 owner decision 2026-11-14: the imports (import_batches.id) whose people that came in with no source label are this source''s (Owner only; app.lead_sources_import_labels_guard). Per import, never across imports. app.person_from_lead_source and app.person_source_refusal read it.';
COMMENT ON COLUMN lead_sources.import_labels IS
  'b18 round 3 item 1, 0101: imported source labels (exactly as a FUB or CSV import stored them, compared whole) that mean this source (Owner only; app.lead_sources_import_labels_guard). app.person_from_lead_source counts the people they label as sent by this source; a committed imported label no source holds, or two hold, leaves its people unclassified (app.person_source_refusal).';

CREATE OR REPLACE FUNCTION app.lead_sources_import_labels_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF (TG_OP = 'INSERT' AND (cardinality(NEW.import_labels) > 0 OR cardinality(NEW.import_unlabeled_batches) > 0))
     OR (TG_OP = 'UPDATE' AND (NEW.import_labels IS DISTINCT FROM OLD.import_labels
                               OR NEW.import_unlabeled_batches IS DISTINCT FROM OLD.import_unlabeled_batches)) THEN
    IF NOT (app.actor_kind() = 'user' AND app.my_role() = 'owner') THEN
      RAISE EXCEPTION 'LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY: only the Owner maps an imported source label to a lead source'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_sources_import_labels_guard() FROM PUBLIC;
DROP TRIGGER lead_sources_import_labels_guard ON lead_sources;
CREATE TRIGGER lead_sources_import_labels_guard BEFORE INSERT OR UPDATE OF import_labels, import_unlabeled_batches ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION app.lead_sources_import_labels_guard();

-- One label's people, for the API's bounded work when a mapping changes (leads/sourceStop.ts: the committed ones, to
-- stop what is running; leads/importLabels.ts: the count in the answer). The first 200 characters keep every index
-- entry small whatever a writer stores; each query re-checks the whole label.
CREATE INDEX import_records_contact_label ON import_records (tenant_id, (left(COALESCE(normalized ->> 'leadSourceLabel', ''), 200)))
  WHERE (normalized ->> 'category') = 'contacts';

CREATE OR REPLACE FUNCTION app.person_from_lead_source(p_tenant uuid, p_contact uuid, p_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH person AS (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id),
       src AS (SELECT s.import_labels AS labels, s.import_unlabeled_batches AS batches FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND s.id = p_source)
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (SELECT 1 FROM src) AND (
    EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person) AND c.original_lead_source_id = p_source)
    OR EXISTS (SELECT 1 FROM public.lead_inquiries i WHERE i.tenant_id = p_tenant AND i.contact_id IN (SELECT id FROM person) AND i.lead_source_id = p_source)
    OR EXISTS (SELECT 1 FROM src, public.contacts c WHERE cardinality(src.labels) > 0 AND c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person)
                AND (c.original_source_detail ->> 'import_source') = ANY (src.labels))
    OR EXISTS (SELECT 1 FROM src, public.import_records r WHERE cardinality(src.labels) > 0 AND r.tenant_id = p_tenant AND r.target_table = 'contacts'
                AND r.target_id IN (SELECT id FROM person) AND (r.normalized ->> 'leadSourceLabel') = ANY (src.labels))
    OR EXISTS (SELECT 1 FROM src, public.import_records r WHERE cardinality(src.labels) > 0 AND r.tenant_id = p_tenant
                AND r.match_contact_id IN (SELECT id FROM person) AND (r.normalized ->> 'leadSourceLabel') = ANY (src.labels))
    -- an import's no-label group this source holds: the contacts records of that import with no label, that targeted
    -- or matched a record of the person (the same two readings as a label, above)
    OR EXISTS (SELECT 1 FROM src, public.import_records r JOIN public.import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
                WHERE cardinality(src.batches) > 0 AND r.tenant_id = p_tenant AND r.target_table = 'contacts' AND r.target_id IN (SELECT id FROM person)
                  AND (r.normalized ->> 'category') = 'contacts' AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) = ''
                  AND st.batch_id = ANY (src.batches))
    OR EXISTS (SELECT 1 FROM src, public.import_records r JOIN public.import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
                WHERE cardinality(src.batches) > 0 AND r.tenant_id = p_tenant AND r.match_contact_id IN (SELECT id FROM person)
                  AND (r.normalized ->> 'category') = 'contacts' AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) = ''
                  AND st.batch_id = ANY (src.batches)))
$$;
ALTER FUNCTION app.person_from_lead_source(uuid, uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_from_lead_source(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_from_lead_source(uuid, uuid, uuid) TO app_user;

CREATE FUNCTION app.person_source_refusal(p_tenant uuid, p_contact uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH person AS (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id)
  SELECT CASE
    WHEN NOT COALESCE(p_tenant = app.tenant_id(), false) THEN NULL
    -- a marked source wins: the Owner's setting is the stronger, more specific reason
    WHEN EXISTS (SELECT 1 FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND s.no_ai_care AND app.person_from_lead_source(p_tenant, p_contact, s.id))
      THEN 'SOURCE_NO_AUTOMATED_CONTACT'
    -- unclassified: a committed contacts import record of the person whose label (or, with no label, whose import's
    -- no-label group) is not held by exactly one lead source
    WHEN EXISTS (
      SELECT 1 FROM public.import_records r
       WHERE r.tenant_id = p_tenant AND r.target_table = 'contacts' AND r.target_id IN (SELECT id FROM person)
         AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'
         AND CASE WHEN btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) <> ''
                  THEN (SELECT count(*) FROM public.lead_sources s
                         WHERE s.tenant_id = p_tenant AND (r.normalized ->> 'leadSourceLabel') = ANY (s.import_labels)) <> 1
                  ELSE (SELECT count(*) FROM public.lead_sources s JOIN public.import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
                         WHERE s.tenant_id = p_tenant AND st.batch_id = ANY (s.import_unlabeled_batches)) <> 1 END)
      THEN 'SOURCE_UNCLASSIFIED'
    ELSE NULL END
$$;
ALTER FUNCTION app.person_source_refusal(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_source_refusal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_source_refusal(uuid, uuid) TO app_user;

CREATE FUNCTION app.import_source_people(p_tenant uuid, p_label text, p_batch uuid) RETURNS TABLE (contact_id uuid, committed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH recs AS (
    -- one label, compared whole, through import_records_contact_label
    SELECT r.target_table, r.target_id, r.outcome, r.match_contact_id FROM public.import_records r
     WHERE p_label IS NOT NULL AND r.tenant_id = p_tenant AND (r.normalized ->> 'category') = 'contacts'
       AND left(COALESCE(r.normalized ->> 'leadSourceLabel', ''), 200) = left(p_label, 200)
       AND COALESCE(r.normalized ->> 'leadSourceLabel', '') = p_label
    UNION ALL
    -- one import's records with no label, through the import's contacts stage
    SELECT r.target_table, r.target_id, r.outcome, r.match_contact_id
      FROM public.import_stages st JOIN public.import_records r ON r.tenant_id = st.tenant_id AND r.stage_id = st.id
     WHERE p_batch IS NOT NULL AND st.tenant_id = p_tenant AND st.batch_id = p_batch AND st.category = 'contacts'
       AND (r.normalized ->> 'category') = 'contacts' AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) = '')
  SELECT x.id, bool_or(x.committed)
    FROM recs CROSS JOIN LATERAL (VALUES (CASE WHEN recs.target_table = 'contacts' THEN recs.target_id END,
                                          recs.target_table = 'contacts' AND recs.outcome IN ('imported', 'merged')),
                                         (recs.match_contact_id, false)) AS x(id, committed)
   WHERE COALESCE(p_tenant = app.tenant_id(), false) AND (SELECT app.is_tenant_wide()) AND x.id IS NOT NULL
   GROUP BY x.id
$$;
ALTER FUNCTION app.import_source_people(uuid, text, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.import_source_people(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_source_people(uuid, text, uuid) TO app_user;

CREATE OR REPLACE FUNCTION app.person_no_ai_care_source(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.person_source_refusal(p_tenant, p_contact) IS NOT NULL
$$;
ALTER FUNCTION app.person_no_ai_care_source(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_no_ai_care_source(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_no_ai_care_source(uuid, uuid) TO app_user;

-- The four invoker guards, each verbatim from 0094, 0098 and 0100 except that it raises the reason that applies.
CREATE OR REPLACE FUNCTION app.playbook_enrollments_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE why text;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF NEW.state = 'active' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'active') THEN
    why := app.person_source_refusal(NEW.tenant_id, NEW.contact_id);
    IF why = 'SOURCE_UNCLASSIFIED' THEN
      RAISE EXCEPTION 'SOURCE_UNCLASSIFIED: this person came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources); no plan runs for them'
        USING ERRCODE = 'check_violation';
    ELSIF why IS NOT NULL THEN
      RAISE EXCEPTION 'SOURCE_NO_AUTOMATED_CONTACT: "No automated contact for leads from this source" is on for this person''s lead source; no plan runs for them'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.playbook_enrollments_source_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.messages_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE why text;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  -- only the write that makes a message a send: a row inserted in a sending state, or the move to 'dispatching'
  -- (dispatch TX1). Decided on the row alone, before anything is read.
  IF NOT ((TG_OP = 'INSERT' AND NEW.status IN ('dispatching', 'sent', 'delivered', 'dispatch_unknown'))
          OR (TG_OP = 'UPDATE' AND NEW.status = 'dispatching' AND OLD.status IS DISTINCT FROM 'dispatching')) THEN
    RETURN NEW;
  END IF;
  IF NEW.direction = 'outbound' AND NOT NEW.imported
     AND ((NEW.initiator = 'human' AND (NEW.bulk_action_id IS NOT NULL OR NEW.marketing_piece_id IS NOT NULL))
          OR (NEW.initiator = 'system' AND NEW.action_category NOT IN ('opt_out_confirmation', 'help_reply', 'portal_login_link'))
          OR (NEW.initiator = 'assistant' AND NOT EXISTS (SELECT 1 FROM public.assistant_actions a
                WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assistant_action_id AND a.autonomy = 'requires_approval'
                  AND COALESCE(a.trigger_ref ->> 'kind', '') NOT IN ('playbook_step', 'trigger_run')))) THEN
    why := app.person_source_refusal(NEW.tenant_id, NEW.contact_id);
    IF why = 'SOURCE_UNCLASSIFIED' THEN
      RAISE EXCEPTION 'SOURCE_UNCLASSIFIED: this person came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources); only a person''s one-to-one message goes'
        USING ERRCODE = 'check_violation';
    ELSIF why IS NOT NULL THEN
      RAISE EXCEPTION 'SOURCE_NO_AUTOMATED_CONTACT: "No automated contact for leads from this source" is on for this person''s lead source; only a person''s one-to-one message goes'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.messages_source_guard() FROM PUBLIC;
DROP TRIGGER messages_source_guard ON messages;
CREATE TRIGGER messages_source_guard BEFORE INSERT OR UPDATE OF status ON messages
  FOR EACH ROW EXECUTE FUNCTION app.messages_source_guard();

CREATE OR REPLACE FUNCTION app.calls_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE why text;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF NEW.handled_by = 'assistant' AND (TG_OP = 'INSERT' OR OLD.handled_by IS DISTINCT FROM 'assistant') THEN
    why := app.person_source_refusal(NEW.tenant_id, NEW.contact_id);
    IF why = 'SOURCE_UNCLASSIFIED' THEN
      RAISE EXCEPTION 'SOURCE_UNCLASSIFIED: this caller came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources); the assistant does not answer'
        USING ERRCODE = 'check_violation';
    ELSIF why IS NOT NULL THEN
      RAISE EXCEPTION 'SOURCE_NO_AUTOMATED_CONTACT: "No automated contact for leads from this source" is on for this caller''s lead source; the assistant does not answer'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.calls_source_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.ai_isa_assignments_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE why text;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF (TG_OP = 'INSERT' AND NEW.ended_at IS NULL)
     OR (TG_OP = 'UPDATE' AND OLD.paused_at IS NOT NULL AND NEW.paused_at IS NULL AND NEW.ended_at IS NULL) THEN
    why := app.person_source_refusal(NEW.tenant_id, NEW.contact_id);
    IF why = 'SOURCE_UNCLASSIFIED' THEN
      RAISE EXCEPTION 'AI_ISA_SOURCE_UNCLASSIFIED: this person came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources); AI care does not start or resume for them'
        USING ERRCODE = 'check_violation';
    ELSIF why IS NOT NULL THEN
      RAISE EXCEPTION 'AI_ISA_SOURCE_NO_AI_CARE: the Owner set "No AI care for leads from this source" on this person''s lead source'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.ai_isa_assignments_source_guard() FROM PUBLIC;

ALTER TABLE stage_automation_decisions DROP CONSTRAINT stage_automation_decisions_reason_check;
ALTER TABLE stage_automation_decisions ADD CONSTRAINT stage_automation_decisions_reason_check
  CHECK (reason IN ('not_a_person_change','person_removed','stage_changed_again','not_visible',
                    'plan_not_approved','already_in_a_plan','cannot_be_reached','protected_audience','ai_isa_active',
                    'source_no_automated_contact','source_unclassified'));

ALTER TABLE ai_isa_assignments DROP CONSTRAINT ai_isa_assignments_pause_reason_check;
ALTER TABLE ai_isa_assignments ADD CONSTRAINT ai_isa_assignments_pause_reason_check CHECK (pause_reason IN ('user','human_contact','unverified_sender',
  'call','chat','synced_mail','media','pack_withdrawn','ai_off','approval_revoked','policy_updated','reinquiry','possible_listing','check_this',
  'taking_over','ending','source_no_ai_care','source_unclassified'));

-- Self-check: the four definers are owned by app_definer with their path pinned, executable by app_user and not by
-- PUBLIC; the five guards are invokers that pin their path and still sit on their triggers; the messages trigger fires
-- on INSERT; no source holds a no-label group yet.
DO $$
DECLARE f text; p record;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.person_from_lead_source(uuid,uuid,uuid)', 'app.person_source_refusal(uuid,uuid)', 'app.person_no_ai_care_source(uuid,uuid)',
                           'app.import_source_people(uuid,text,uuid)'] LOOP
    SELECT r.rolname AS owner, x.prosecdef AS definer, x.proconfig AS config, x.proacl AS acl INTO p
      FROM pg_proc x JOIN pg_roles r ON r.oid = x.proowner WHERE x.oid = f::regprocedure;
    IF p.owner <> 'app_definer' OR NOT p.definer OR NOT ('search_path=pg_catalog, public' = ANY (p.config)) THEN
      RAISE EXCEPTION '0101: % must be a definer owned by app_definer with a pinned search_path', f;
    END IF;
    IF NOT has_function_privilege('app_user', f, 'EXECUTE') OR EXISTS (SELECT 1 FROM aclexplode(p.acl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '0101: % EXECUTE must be app_user only', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['app.lead_sources_import_labels_guard()', 'app.playbook_enrollments_source_guard()', 'app.messages_source_guard()',
                           'app.calls_source_guard()', 'app.ai_isa_assignments_source_guard()'] LOOP
    SELECT prosecdef AS definer, proconfig AS config INTO p FROM pg_proc WHERE oid = f::regprocedure;
    IF p.definer OR NOT ('search_path=pg_catalog, public' = ANY (p.config)) THEN RAISE EXCEPTION '0101: % must be an invoker that pins its search_path', f; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = f::regprocedure AND NOT t.tgisinternal) THEN RAISE EXCEPTION '0101: % must still be on its trigger', f; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.messages'::regclass AND t.tgname = 'messages_source_guard'
                    AND (t.tgtype::int & 4) <> 0 AND (t.tgtype::int & 16) <> 0 AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0101: messages_source_guard must fire on INSERT and UPDATE';
  END IF;
  IF EXISTS (SELECT 1 FROM lead_sources WHERE cardinality(import_unlabeled_batches) > 0) THEN RAISE EXCEPTION '0101: an existing source holds a no-label group'; END IF;
END $$;
