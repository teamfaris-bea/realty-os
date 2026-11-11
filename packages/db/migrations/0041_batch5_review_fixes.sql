-- =============================================================================
-- Batch 5 review fixes (docs/SECURITY.md §7.4, docs/ARCHITECTURE.md §21.12, DATA_MODEL R-DATA-3, R-DATA-4, R-LEM-5,
-- R-PAR-8, R-PAR-16). 0001-0040 are not edited. Every change only refuses more, purges more, or adds a missing mark.
--
-- 1. F1-ERASE-DNC-TOCTOU (D1). app.purge_contact_internal checked app.person_optout_uncarried on its statement
--    snapshot and deleted the person afterwards, with no lock in between: a phone that a still-open transaction had
--    just added to the person (a lead-email intake or accept, POST /contacts/:id/points, an import filling an empty
--    phone) was invisible to the check; the DELETE then waited for that writer and cascade-deleted the phone with no
--    revoke carried, and the number was texted afterwards (a review probe: an agent's text 'sent', and the lead-email
--    first response). The purge now locks every record of the person FOR UPDATE, sorted, before it checks anything
--    (and re-reads the merge tree until it is stable). FOR UPDATE conflicts with the FOR KEY SHARE that every child
--    row's foreign-key check takes on its contact, so an in-flight point writer is waited for and its point is seen by
--    the next statement's snapshot (the check refuses PERSON_DO_NOT_CONTACT_UNCARRIED), and a later writer waits and
--    then fails its foreign key. The erase route (apps/api/src/admin/erasure.ts) takes the same locks first, in the
--    global lock order, so it carries the new point instead of being refused; the worker's carry-then-sweep gets the
--    backstop here.
-- 2. F2-ERASE-HELD-LEAD-EMAIL (R-DATA-4, R-DATA-3, R-LEM-5). A held ("Needs review") lead email is never linked to a
--    contact, so erasure never found it: after a privacy erasure the person's held email stayed decrypted in Needs
--    review and accepting it re-created the person; held content never expired either. Now:
--      * lead_email_messages.point_hmacs: the tenant-HMACs of the addresses the held email names (the API computes them
--        as intake keys its points; keys only, never an address), cleared on every decision;
--      * app.purge_contact_internal purges every held email naming an address of any record of the person (live or
--        removed, a confirmed wrong number excepted: that number reaches someone else, R-PAR-12): status 'erased',
--        content, parse, keys, sender domain and DKIM domains gone, the row kept as the replay tombstone of its message
--        key; and it drops the sender and DKIM domains of the lead emails linked to the person (the ON DELETE SET NULL
--        of contact_id then unlinks them);
--      * app.retention_sweep expires held content 30 days after receipt by the database clock (status 'expired', the
--        same columns gone). VERIFY WITH COUNSEL (the period).
--    The guard lets only the retention role (the erasure and retention definers) make those two transitions and drop
--    the trust facts; every other writer is refused as before.
-- 3. F4-ERASE-POND-PHANTOM-COUNT (feed_incremental). The contacts feed marks fire on INSERT and UPDATE only: an erased
--    or purged contact's cards cascaded away but each member's stored count (feed_groups.n_open, GET /feed's total)
--    kept them until the hourly reconcile. A DELETE now marks every member holding a feed group of a deleted record.
-- 4. F1 bulk stage (R-PAR-8, R-PAR-16). A bulk Change stage into a stage that starts a plan enrolled a protected-tag
--    audience into the plan, around the AUDIENCE_PROTECTED_PROXY refusal bulk enroll gets. contact_stage_events now
--    records the bulk action a stage change was made by (bulk_action_id: the history definer stores it only when the
--    transaction names, in app.bulk_action_id, a running stage action of this tenant created by the user making the
--    change), and the stage automation skips such an event with the new reason 'protected_audience' when that action's
--    audience is protected when it decides.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * replaces app.purge_contact_internal and app.retention_sweep (SECURITY DEFINER, owner app_retention, pinned
--     search_path, grants unchanged): 0037's statements verbatim plus the marked 0041 lines. They lock, purge or skip
--     more; nothing they did before is dropped. The new UPDATEs touch lead_email_messages only, by tenant.
--   * replaces app.contacts_stage_history (SECURITY DEFINER trigger, owner app_definer, pinned search_path): 0021's
--     statement plus one validated column. The GUC can only ADD a restriction (a recorded id makes the automation
--     check the action's audience); a value that is not this user's running stage action of this tenant records NULL,
--     which is what every stage change recorded before.
--   * replaces app.lead_email_messages_guard (invoker trigger): refuses everything it refused, and lets only
--     current_user = 'app_retention' (inside the two definers above) end a held email as erased/expired or drop its
--     sender/DKIM domains; point_hmacs may only be cleared.
--   * new invoker trigger function app.feed_mark_contacts_deleted (EXECUTE revoked from PUBLIC), writes
--     public.feed_dirty only; inside the purge it runs as app_retention, which already has INSERT on feed_dirty and
--     SELECT on feed_groups and memberships (0001, 0034).
--   * no table, policy or grant is added or widened; lead_email_messages, contact_stage_events and
--     stage_automation_decisions keep FORCE RLS, their policies and the support_read_only statement trigger.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2. Held lead emails: the address keys, and the two purge states
-- -----------------------------------------------------------------------------
ALTER TABLE lead_email_messages ADD COLUMN point_hmacs bytea[] NOT NULL DEFAULT '{}';
ALTER TABLE lead_email_messages DROP CONSTRAINT lead_email_messages_status_check;
ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_status_check
  CHECK (status IN ('lead_created','needs_review','accepted','discarded','erased','expired'));
-- keys only while held (at most 5 phones + 5 emails, as the parser keeps), never on a decided or purged row
ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_point_hmacs_held
  CHECK (cardinality(point_hmacs) <= 10 AND (status = 'needs_review' OR point_hmacs = '{}'));
-- an erased or expired email keeps nothing of the person: only its tombstone (message key, origin, hold code)
ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_purged_empty
  CHECK (status NOT IN ('erased','expired')
         OR (content_enc IS NULL AND parsed_enc IS NULL AND sender_domain IS NULL AND dkim_pass_domains = '{}'));

-- 0040's guard, verbatim except the marked 0041 lines.
CREATE OR REPLACE FUNCTION app.lead_email_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retention boolean := current_user = 'app_retention';   -- 0041: the erasure and retention definers
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('lead_created','needs_review') THEN
      RAISE EXCEPTION 'LEAD_EMAIL_STATUS: a lead email starts as lead_created or needs_review' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- 0041: the trust facts (sender and DKIM domains) left the immutable list; they only ever go (both at once), and
  -- only by the retention role; the address keys are only ever cleared
  IF (NEW.tenant_id, NEW.id, NEW.connection_id, NEW.lead_source_id, NEW.message_key_sha256, NEW.provider_format, NEW.received_at,
      NEW.hold_code, NEW.parser_kind, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.connection_id, OLD.lead_source_id, OLD.message_key_sha256, OLD.provider_format, OLD.received_at,
      OLD.hold_code, OLD.parser_kind, OLD.created_at)
     OR ((NEW.sender_domain, NEW.dkim_pass_domains) IS DISTINCT FROM (OLD.sender_domain, OLD.dkim_pass_domains)
         AND NOT (retention AND NEW.sender_domain IS NULL AND NEW.dkim_pass_domains = '{}'))   -- 0041
     OR (NEW.point_hmacs IS DISTINCT FROM OLD.point_hmacs AND NEW.point_hmacs <> '{}') THEN    -- 0041
    RAISE EXCEPTION 'LEAD_EMAIL_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'needs_review' AND NEW.status IN ('accepted','discarded'))
    OR (OLD.status = 'needs_review' AND NEW.status IN ('erased','expired') AND retention)) THEN   -- 0041
    RAISE EXCEPTION 'LEAD_EMAIL_TRANSITION: only a held email is decided, once' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.contact_id IS NOT NULL AND NEW.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     OR (OLD.inquiry_id IS NOT NULL AND NEW.inquiry_id IS NOT NULL AND NEW.inquiry_id IS DISTINCT FROM OLD.inquiry_id) THEN
    RAISE EXCEPTION 'LEAD_EMAIL_LINK_FINAL' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'discarded' AND NEW.contact_id IS NOT NULL AND OLD.contact_id IS NULL THEN
    RAISE EXCEPTION 'LEAD_EMAIL_DISCARD_NO_LEAD' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- 1 + 2. Erasure and purge: lock the person first; their held lead emails go with them
-- -----------------------------------------------------------------------------
-- 0037's statements, verbatim except the marked 0041 lines.
CREATE OR REPLACE FUNCTION app.purge_contact_internal(p_tenant uuid, p_contact uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m record;   -- 0037
  tree uuid[]; locked uuid[] := '{}';   -- 0041
BEGIN
  -- 0041 (1): every record of the person is locked before anything is checked. FOR UPDATE waits for any transaction
  -- that inserted a child row of one of them (its foreign-key check holds FOR KEY SHARE on the record), so the checks
  -- below see that row; a writer that comes later waits for this transaction and then fails its foreign key. The
  -- tree is read again after each lock until no record joined it meanwhile (a merge into the person).
  LOOP
    tree := ARRAY(SELECT t.contact_id FROM app.contact_merge_tree(p_tenant, p_contact) t ORDER BY t.contact_id);
    EXIT WHEN tree <@ locked;
    PERFORM 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id = ANY (tree) ORDER BY c.id FOR UPDATE;
    locked := tree;
  END LOOP;
  -- 0037: the documents check covers every record of the person (the contact and those merged into it)
  IF EXISTS (SELECT 1 FROM app.contact_merge_tree(p_tenant, p_contact) t JOIN public.documents d
                ON d.tenant_id = p_tenant AND d.contact_id = t.contact_id
              WHERE d.legal_hold OR d.retention_until > now()) THEN
    RAISE EXCEPTION 'DOCUMENT_RETAINED: a document of this contact is on legal hold or inside its retention period'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0037 (2b): the person's do-not-contact goes with their rows, so it must already be on every one of their
  -- addresses in the consent ledger (the erase route and the worker record it first)
  IF EXISTS (SELECT 1 FROM app.person_optout_uncarried(p_tenant, p_contact)) THEN
    RAISE EXCEPTION 'PERSON_DO_NOT_CONTACT_UNCARRIED: this person asked not to be contacted; record that on each of their addresses before deleting them'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0041 (2): the held lead emails naming an address of the person (live or removed; a confirmed wrong number reaches
  -- someone else) keep nothing of them: the row stays only as the replay tombstone of its message key
  UPDATE public.lead_email_messages lm
     SET status = 'erased', content_enc = NULL, parsed_enc = NULL, point_hmacs = '{}', sender_domain = NULL, dkim_pass_domains = '{}'
   WHERE lm.tenant_id = p_tenant AND lm.status = 'needs_review'
     AND lm.point_hmacs && ARRAY(SELECT p.address_hmac FROM public.contact_points p
                                  WHERE p.tenant_id = p_tenant AND p.contact_id = ANY (locked)
                                    AND p.removed_reason IS DISTINCT FROM 'wrong_number');
  -- 0041 (2): the lead emails that created or reached a record of the person lose its sender and DKIM domains (the
  -- person's own domain when a reviewer accepted their own email); contact_id is unlinked by its ON DELETE SET NULL
  UPDATE public.lead_email_messages lm SET sender_domain = NULL, dkim_pass_domains = '{}'
   WHERE lm.tenant_id = p_tenant AND lm.contact_id = ANY (locked)
     AND (lm.sender_domain IS NOT NULL OR lm.dkim_pass_domains <> '{}');
  -- 0037: deepest first, so a merged record is deleted before the contact it was merged into and is never left
  -- without its survivor (merged_into_contact_id is ON DELETE SET NULL; the contacts CHECK refuses that state)
  FOR m IN SELECT t.contact_id AS id FROM app.contact_merge_tree(p_tenant, p_contact) t ORDER BY t.depth DESC, t.contact_id LOOP
    DELETE FROM public.behavior_events WHERE tenant_id = p_tenant AND contact_id = m.id;
    DELETE FROM public.message_status_events s USING public.messages mm
     WHERE s.tenant_id = p_tenant AND mm.tenant_id = p_tenant AND s.message_id = mm.id AND mm.contact_id = m.id;
    UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = now()
      FROM public.recordings r
     WHERE r.tenant_id = p_tenant AND r.contact_id = m.id AND o.tenant_id = p_tenant AND o.id = r.object_id
       AND o.deleted_at IS NULL;
    UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = now()
      FROM public.message_media me JOIN public.messages mm ON mm.tenant_id = me.tenant_id AND mm.id = me.message_id
     WHERE mm.tenant_id = p_tenant AND mm.contact_id = m.id AND o.tenant_id = p_tenant AND o.id = me.object_id
       AND o.deleted_at IS NULL;
    UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = now()
      FROM public.documents d
     WHERE d.tenant_id = p_tenant AND d.contact_id = m.id AND o.tenant_id = p_tenant AND o.id = d.object_id
       AND o.deleted_at IS NULL;
    DELETE FROM public.external_refs WHERE tenant_id = p_tenant AND entity_type = 'contact' AND entity_id = m.id;
    DELETE FROM public.contacts WHERE tenant_id = p_tenant AND id = m.id;   -- children cascade
  END LOOP;
END $$;
ALTER FUNCTION app.purge_contact_internal(uuid, uuid) OWNER TO app_retention;

-- The retention sweep: 0037's statements verbatim except the marked 0041 lines.
CREATE OR REPLACE FUNCTION app.retention_sweep(p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rec record;
  n_contacts integer := 0; n_sessions integer; n_jobs integer; n_auth integer; n_notif integer;
  n_audit integer; n_rec integer; n_raw integer; n_ai integer; n_webhooks integer;
  n_skipped integer := 0;   -- 0037
  n_lead_emails integer;    -- 0041
BEGIN
  DELETE FROM public.sessions WHERE COALESCE(revoked_at, absolute_expires_at) < p_now - interval '30 days';
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  DELETE FROM public.jobs WHERE (status = 'succeeded' AND finished_at < p_now - interval '14 days')
                             OR (status IN ('dead','cancelled') AND finished_at < p_now - interval '90 days');
  GET DIAGNOSTICS n_jobs = ROW_COUNT;
  DELETE FROM public.auth_events WHERE occurred_at < p_now - interval '1 year';
  GET DIAGNOSTICS n_auth = ROW_COUNT;
  DELETE FROM public.auth_attempts WHERE window_start < p_now - interval '1 day';
  DELETE FROM public.auth_tokens WHERE expires_at < p_now - interval '7 days';
  UPDATE public.webhook_events SET payload_enc = NULL WHERE payload_enc IS NOT NULL AND received_at < p_now - interval '30 days';
  GET DIAGNOSTICS n_webhooks = ROW_COUNT;
  DELETE FROM public.notifications WHERE created_at < p_now - interval '90 days';
  GET DIAGNOSTICS n_notif = ROW_COUNT;
  DELETE FROM public.audit_log WHERE occurred_at < p_now - interval '7 years';      -- VERIFY WITH COUNSEL
  GET DIAGNOSTICS n_audit = ROW_COUNT;
  UPDATE public.import_records SET raw_enc = NULL, raw_purged_at = p_now
   WHERE raw_enc IS NOT NULL AND created_at < p_now - interval '30 days';
  GET DIAGNOSTICS n_raw = ROW_COUNT;
  UPDATE public.ai_runs SET output_enc = NULL, output_purged_at = p_now
   WHERE output_enc IS NOT NULL AND created_at < p_now - interval '30 days';
  GET DIAGNOSTICS n_ai = ROW_COUNT;
  UPDATE public.lead_inquiries SET raw_payload_enc = NULL
   WHERE raw_payload_enc IS NOT NULL AND received_at < p_now - interval '90 days';
  -- 0041 (2): held lead emails (Needs review) keep their content 30 days after receipt (VERIFY WITH COUNSEL). By the
  -- database clock as well: a far-future p_now never expires a lead someone could still review.
  UPDATE public.lead_email_messages
     SET status = 'expired', content_enc = NULL, parsed_enc = NULL, point_hmacs = '{}', sender_domain = NULL, dkim_pass_domains = '{}'
   WHERE status = 'needs_review' AND received_at < LEAST(p_now, now()) - interval '30 days';
  GET DIAGNOSTICS n_lead_emails = ROW_COUNT;
  UPDATE public.provider_credentials SET secret_enc = NULL, status = 'purged', purged_at = p_now
   WHERE status <> 'purged' AND purge_after IS NOT NULL AND purge_after <= p_now;
  -- recordings past retention (not on legal hold): shred DEK, transcript, transcript snippets
  UPDATE public.recordings SET status = 'shredded', shredded_at = p_now
   WHERE status IN ('stored','quarantined','pending_copy') AND NOT legal_hold AND retain_until <= p_now;
  GET DIAGNOSTICS n_rec = ROW_COUNT;
  UPDATE public.stored_objects o SET dek_wrapped = NULL, deleted_at = p_now
    FROM public.recordings r
   WHERE r.tenant_id = o.tenant_id AND r.object_id = o.id AND r.status = 'shredded' AND o.deleted_at IS NULL;
  UPDATE public.transcripts tr SET status = 'shredded', segments_enc = NULL
    FROM public.recordings r
   WHERE r.tenant_id = tr.tenant_id AND r.id = tr.recording_id AND r.status = 'shredded' AND tr.status <> 'shredded';
  UPDATE public.evidence_refs e SET snippet = NULL, snippet_enc = NULL, source_available = false
   WHERE e.source_type = 'call' AND e.source_available AND EXISTS (
         SELECT 1 FROM public.recordings r WHERE r.tenant_id = e.tenant_id AND r.call_id = e.source_id AND r.status = 'shredded');
  -- soft-deleted contacts past purge_after, with no record of the person (the contact or one merged into it,
  -- 0037) on any deal or holding a document still held or retained, and the person's do-not-contact, if any,
  -- already on each of their addresses (0037, 2b)
  FOR rec IN SELECT c.tenant_id, c.id FROM public.contacts c
              WHERE c.deleted_at IS NOT NULL AND c.purge_after <= p_now
                AND NOT EXISTS (SELECT 1 FROM app.contact_merge_tree(c.tenant_id, c.id) m
                                 WHERE EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = m.contact_id)
                                    OR EXISTS (SELECT 1 FROM public.deal_contacts dc WHERE dc.tenant_id = c.tenant_id AND dc.contact_id = m.contact_id)
                                    OR EXISTS (SELECT 1 FROM public.documents dd WHERE dd.tenant_id = c.tenant_id AND dd.contact_id = m.contact_id
                                                  AND (dd.legal_hold OR dd.retention_until > p_now)))
                AND NOT EXISTS (SELECT 1 FROM app.person_optout_uncarried(c.tenant_id, c.id))   -- 0037 (2b)
              ORDER BY c.purge_after LIMIT 500 LOOP
    BEGIN   -- 0037: one person's refusal skips that person, never the sweep
      PERFORM app.purge_contact_internal(rec.tenant_id, rec.id);
      n_contacts := n_contacts + 1;
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM NOT LIKE 'PERSON_DO_NOT_CONTACT_UNCARRIED%' AND SQLERRM NOT LIKE 'DOCUMENT_RETAINED%' THEN RAISE; END IF;
      n_skipped := n_skipped + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('sessions', n_sessions, 'jobs', n_jobs, 'auth_events', n_auth, 'notifications', n_notif,
                            'audit_log', n_audit, 'recordings_shredded', n_rec, 'import_raw_purged', n_raw,
                            'ai_outputs_purged', n_ai, 'webhook_payloads_purged', n_webhooks, 'contacts_purged', n_contacts,
                            'contacts_skipped', n_skipped,   -- 0037
                            'lead_emails_expired', n_lead_emails);   -- 0041
END $$;
ALTER FUNCTION app.retention_sweep(timestamptz) OWNER TO app_retention;

-- -----------------------------------------------------------------------------
-- 3. Feed marks for a deleted contact
-- -----------------------------------------------------------------------------
-- Every member whose stored feed state holds a group of a deleted record (its count, its next change instant) is
-- marked, so their next materialization re-scores the group: the cards cascaded away, so it stores nothing for it.
-- Through memberships: each probe is the feed_groups primary key (tenant, user, group), never a tenant-wide scan.
-- Inside the purge this runs as app_retention (BYPASSRLS); a writer under RLS marks what it can see, and the hourly
-- reconcile repairs the rest (0034).
CREATE FUNCTION app.feed_mark_contacts_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.feed_dirty (tenant_id, user_id, group_key)
  SELECT g.tenant_id, g.user_id, g.group_key
    FROM (SELECT DISTINCT o.tenant_id, 'c:' || o.id AS group_key FROM old_rows o) d
    JOIN public.memberships m ON m.tenant_id = d.tenant_id
    JOIN public.feed_groups g ON g.tenant_id = d.tenant_id AND g.user_id = m.user_id AND g.group_key = d.group_key;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.feed_mark_contacts_deleted() FROM PUBLIC;
CREATE TRIGGER feed_mark_del AFTER DELETE ON public.contacts REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_contacts_deleted();

-- -----------------------------------------------------------------------------
-- 4. Stage changes made by a bulk action name it; a protected audience never starts a plan
-- -----------------------------------------------------------------------------
-- The bulk action whose run made this stage change (ids only). No foreign key: the history is append-only, and the
-- definer below stores only an id it has just checked.
ALTER TABLE contact_stage_events ADD COLUMN bulk_action_id uuid;

-- 0021's statement, verbatim except the marked 0041 lines.
CREATE OR REPLACE FUNCTION app.contacts_stage_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE ak text := COALESCE(NULLIF(current_setting('app.actor_kind', true), ''), 'none');
  uid uuid; bulk text := NULLIF(current_setting('app.bulk_action_id', true), ''); bid uuid;   -- 0041
BEGIN
  IF ak NOT IN ('user','system','support') THEN ak := 'none'; END IF;
  uid := CASE WHEN ak = 'user' THEN NULLIF(current_setting('app.user_id', true), '')::uuid END;   -- 0041 (as 0021's VALUES)
  -- 0041: the bulk runner names its action (app.bulk_action_id); kept only for a running stage action of this tenant
  -- created by the user making this change, else NULL
  IF uid IS NOT NULL AND bulk ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT b.id INTO bid FROM public.bulk_actions b
     WHERE b.tenant_id = NEW.tenant_id AND b.id = bulk::uuid AND b.kind = 'stage' AND b.status = 'running'
       AND b.created_by_user_id = uid;
  END IF;
  INSERT INTO public.contact_stage_events (tenant_id, id, contact_id, from_stage, to_stage, actor_kind, actor_user_id, bulk_action_id)   -- 0041: bulk_action_id
  VALUES (NEW.tenant_id, gen_random_uuid(), NEW.id, OLD.stage, NEW.stage, ak, uid, bid);
  RETURN NULL;
END $$;
ALTER FUNCTION app.contacts_stage_history() OWNER TO app_definer;

-- the closed set of skip reasons (apps/api/src/stageAutomation/decide.ts SKIP_REASONS), plus protected_audience
ALTER TABLE stage_automation_decisions DROP CONSTRAINT stage_automation_decisions_reason_check;
ALTER TABLE stage_automation_decisions ADD CONSTRAINT stage_automation_decisions_reason_check
  CHECK (reason IN ('not_a_person_change','person_removed','stage_changed_again','not_visible',
                    'plan_not_approved','already_in_a_plan','cannot_be_reached','protected_audience'));

-- -----------------------------------------------------------------------------
-- 5. Self-checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  -- the replaced definers: reviewed owner, SECURITY DEFINER, pinned search_path; the purge locks before it checks
  IF EXISTS (SELECT 1 FROM (VALUES ('app.purge_contact_internal(uuid,uuid)', 'app_retention'), ('app.retention_sweep(timestamptz)', 'app_retention'),
                                   ('app.contacts_stage_history()', 'app_definer')) v(fn, owner)
              JOIN pg_proc p ON p.oid = v.fn::regprocedure
             WHERE pg_get_userbyid(p.proowner) <> v.owner OR NOT p.prosecdef
                OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']) THEN
    bad := bad || ' definers';
  END IF;
  IF (SELECT position('FOR UPDATE' IN p.prosrc) = 0 OR position('FOR UPDATE' IN p.prosrc) > position('person_optout_uncarried' IN p.prosrc)
        FROM pg_proc p WHERE p.oid = 'app.purge_contact_internal(uuid,uuid)'::regprocedure) THEN
    bad := bad || ' purge_lock_order';
  END IF;
  IF NOT has_function_privilege('app_retention', 'app.purge_contact_internal(uuid,uuid)', 'EXECUTE') THEN bad := bad || ' purge_grant'; END IF;
  -- the feed mark stays an invoker, not executable by PUBLIC, and its trigger exists
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'app.feed_mark_contacts_deleted()'::regprocedure AND (p.prosecdef OR has_function_privilege('public', p.oid, 'EXECUTE')))
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.contacts'::regclass AND tgname = 'feed_mark_del') THEN
    bad := bad || ' feed_mark_del';
  END IF;
  -- the tables keep FORCE RLS and the support write block
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN ('public.lead_email_messages'::regclass, 'public.contact_stage_events'::regclass,
                                                      'public.stage_automation_decisions'::regclass)
                AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
                     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only'))) THEN
    bad := bad || ' rls';
  END IF;
  -- the guard still guards
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lead_email_messages'::regclass AND tgname = 'lead_email_messages_guard') THEN
    bad := bad || ' lead_email_guard';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (batch 5 review fixes):%', bad;
  END IF;
END $$;
