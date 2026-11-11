-- =============================================================================
-- Lead-handling follow-ups (FUB parity module 57 and erasure; docs/PARITY_PLAN.md §4.4, DATA_MODEL R-DATA-4,
-- R-DATA-5, R-PAR-11, R-PAR-12). The number is a placeholder: the orchestrator renumbers at merge, and nothing
-- in code or tests names this file. 0001-0036 are not edited.
--
-- 1. Address delete (module 57). FUB lets an agent delete a person's address; app_user had no DELETE grant on
--    contact_addresses, so module 57 offered add and edit only. The grant comes with a RESTRICTIVE delete
--    policy, so a delete needs what an edit needs: the person's detail visible (the existing contact_detail
--    policy) and an editing role acting as itself (the database form of contact.edit, as for contact_tags and
--    contact_field_values: never a TC, never the system, never support). The route also checks
--    core.can('contact.edit') for the caller's scope (own / collaborator / team).
--
-- 2. Erasing or purging a merge survivor. contacts.merged_into_contact_id is ON DELETE SET NULL (0001), and a
--    merged record without its survivor fails the contacts CHECK (closed_reason 'merged' needs a survivor).
--    So app.erase_contact refused every contact that had a duplicate merged into it (the API answered a
--    confusing 422), and app.retention_sweep failed as a whole (every tenant, every retention step) once a
--    soft-deleted survivor passed purge_after, and again every hour after. Nothing ever resurfaced, because the
--    whole transaction rolled back. Now a contact is erased or purged together with every record merged into
--    it, along merge chains (app.contact_merge_tree), deepest first: a merge says those records are one
--    person, and erasing the person erases all of them. This is the most privacy-protective reading and an
--    OWNER / COUNSEL QUESTION (what erasure of a person means for their merged records); VERIFY WITH COUNSEL.
--    Consent and suppressions are keyed by HMAC and survive erasure, as before (R-CONSENT-1, R-DATA-4). The
--    deal and document refusals now cover every record of the person: erasure refuses CONTACT_ON_DEAL /
--    DOCUMENT_RETAINED when any of them is on a deal or holds a retained document, and the sweep skips such a
--    person instead of failing.
--
-- 2b. A person's do-not-contact outlives the person (D1). The person-level do-not-contact (0018,
--    contacts.do_not_contact_at) is a column of the person's rows, so deleting them deletes it; only the
--    HMAC-keyed ledger survives. And the ledger did not hold all of it: POST /contacts/:id/do-not-contact revokes
--    only the live points the record had at that moment, and a merge copies only the flag onto the survivor
--    (contacts_dnc_follow_merge), so the survivor's own phones and emails, and any point added after the
--    do-not-contact, had no revoke. Erasing or purging such a person (both possible since item 2) made those
--    addresses contactable again: a review probe texted a re-created contact through the fake provider. Now the
--    application records an agent_revoke (purpose all) on each such address and channel before any record of
--    the person is deleted (the erase route as the Owner/Admin; the worker as the system, before each sweep),
--    and the database refuses the deletion while one is missing: purge_contact_internal raises
--    PERSON_DO_NOT_CONTACT_UNCARRIED and the sweep skips such a person. app.person_optout_uncarried is the one
--    predicate both sides use.
--
-- 3. app.contact_points_immutable(): its refusal to restore a confirmed wrong number said "add the number
--    again", which cannot work on the same person (UNIQUE (tenant, contact, kind, address)); the text now says
--    the number is final for that person. The code prefix, and every condition, is unchanged.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * GRANT DELETE ON contact_addresses TO app_user, narrowed by the new RESTRICTIVE policy
--     contact_addresses_delete (detail visible AND a user actor AND role owner/admin/team_lead/agent/isa).
--     The table keeps FORCE RLS, tenant_isolation, support_read_only_del and the support_read_only statement
--     trigger. A delete cascades only to the address's property_records row (and sets a home_valuations
--     reference to it to NULL).
--   * new function app.contact_merge_tree(uuid, uuid): plain SQL, NOT security definer, pinned search_path,
--     explicit tenant filter; a CYCLE clause makes it terminate even on corrupt data. EXECUTE revoked from
--     PUBLIC and granted to app_retention (its definer callers below) and to app_user, only so that
--     app.person_optout_uncarried can run as its caller: called by app_user it returns only records the
--     caller's RLS shows.
--   * new function app.person_optout_uncarried(uuid, uuid): plain SQL, NOT security definer, pinned
--     search_path, explicit tenant filter, writes nothing; EXECUTE revoked from PUBLIC and granted to app_user
--     and app_retention. Called by app_user it reads points, consent_state and consent_events through the
--     caller's own RLS, so it shows nothing the caller could not select; the API calls it as the Owner/Admin
--     and the worker as the system (both tenant-wide), the definers below as app_retention.
--   * new SECURITY DEFINER function app.retention_optout_carry_due(timestamptz, integer): owner app_retention,
--     pinned search_path, EXECUTE revoked from PUBLIC and granted to app_user; it answers only with NO tenant
--     and NO user context (as 0004's worker read-outs) and returns at most 500 (tenant id, contact id) pairs of
--     soft-deleted people past purge_after whose do-not-contact is not carried yet: no names, addresses or
--     payloads. Residual risk as for 0004: a process that clears its GUCs can learn those ids.
--   * replaces app.purge_contact_internal, app.erase_contact and app.retention_sweep (SECURITY DEFINER, owner
--     app_retention, pinned search_path, grants unchanged). Each keeps its latest version's statements (0018,
--     0001, 0018); the merge-tree and do-not-contact lines are marked. erase_contact writes one extra
--     contact.erase audit row per merged record erased with the person (ids only, no PII). They only refuse
--     more: purge_contact_internal also refuses PERSON_DO_NOT_CONTACT_UNCARRIED, and the sweep skips such a
--     person; inside a subtransaction per person it also skips one whose purge refuses with that code or with
--     DOCUMENT_RETAINED after the candidate scan (a race), and counts them; every other error still fails it.
--   * replaces app.contact_points_immutable() (invoker trigger function, 0021) verbatim except one message.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Address delete (module 57)
-- -----------------------------------------------------------------------------
GRANT DELETE ON contact_addresses TO app_user;
CREATE POLICY contact_addresses_delete ON contact_addresses AS RESTRICTIVE FOR DELETE USING (
  app.contact_detail_visible(tenant_id, contact_id)
  AND (SELECT app.actor_kind()) = 'user'
  AND (SELECT app.my_role()) IN ('owner','admin','team_lead','agent','isa'));

-- -----------------------------------------------------------------------------
-- 2. Erasure and purge take the whole person: the contact and every record merged into it
-- -----------------------------------------------------------------------------
-- The contact (depth 0) and every contact merged into it, directly or along a merge chain (depth = hops).
CREATE FUNCTION app.contact_merge_tree(p_tenant uuid, p_contact uuid)
RETURNS TABLE (contact_id uuid, depth integer) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE tree(contact_id, depth) AS (
    SELECT c.id, 0 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id = p_contact
    UNION ALL
    SELECT l.id, t.depth + 1 FROM tree t
      JOIN public.contacts l ON l.tenant_id = p_tenant AND l.merged_into_contact_id = t.contact_id
  ) CYCLE contact_id SET is_cycle USING path
  SELECT tree.contact_id, tree.depth FROM tree WHERE NOT tree.is_cycle
$$;
REVOKE ALL ON FUNCTION app.contact_merge_tree(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_merge_tree(uuid, uuid) TO app_retention, app_user;

-- -----------------------------------------------------------------------------
-- 2b. A person's do-not-contact outlives the person: it is carried onto every address before any record goes
-- -----------------------------------------------------------------------------
-- Every (point, channel) of the person on which their person-level do-not-contact is not carried yet; empty
-- when no record of the person (the contact and every record merged into it) carries one. Points: live or
-- removed, except one removed as a confirmed wrong number (that number reaches someone else, R-PAR-12).
-- Channels: as the dispatch guards map a point's kind (a phone is texted and called). Carried: for that channel
-- and each purpose, a revoked consent_state row whose basis is a revoke only the person's own reinstating action
-- lifts: not a keyword STOP (the person's START pops it) and not opt-out language (a reviewer may mark it "not
-- an opt-out"), since a person-level do-not-contact yields to neither. Runs as its caller: the API
-- (Owner/Admin) and the worker (system) see every record of the person under RLS, and the definers below run
-- it as app_retention, so the application carries exactly what the database refuses to delete.
CREATE FUNCTION app.person_optout_uncarried(p_tenant uuid, p_contact uuid)
RETURNS TABLE (point_id uuid, kind text, address text, address_hmac bytea, channel text, do_not_contact_event_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH tree AS (SELECT t.contact_id FROM app.contact_merge_tree(p_tenant, p_contact) t),
  dnc AS (SELECT c.do_not_contact_event_id AS event_id FROM public.contacts c JOIN tree ON tree.contact_id = c.id
           WHERE c.tenant_id = p_tenant AND c.do_not_contact_at IS NOT NULL
           ORDER BY c.do_not_contact_at, c.id LIMIT 1)
  SELECT p.id, p.kind, p.address, p.address_hmac, ch.channel, dnc.event_id
    FROM dnc CROSS JOIN tree
    JOIN public.contact_points p ON p.tenant_id = p_tenant AND p.contact_id = tree.contact_id
    CROSS JOIN LATERAL unnest(CASE WHEN p.kind = 'phone' THEN ARRAY['sms','voice'] ELSE ARRAY[p.kind] END) AS ch(channel)
   WHERE p.removed_reason IS DISTINCT FROM 'wrong_number'
     AND EXISTS (SELECT 1 FROM unnest(ARRAY['marketing','informational']) AS pu(purpose)
                  WHERE NOT EXISTS (
                    SELECT 1 FROM public.consent_state cs
                      JOIN public.consent_events e ON e.tenant_id = cs.tenant_id AND e.id = cs.basis_event_id
                     WHERE cs.tenant_id = p_tenant AND cs.channel = ch.channel AND cs.purpose = pu.purpose
                       AND cs.address_hmac = p.address_hmac AND cs.status = 'revoked'
                       AND e.event_type = 'revoke' AND e.source NOT IN ('inbound_keyword','inbound_language')))
   ORDER BY p.address_hmac, ch.channel, p.id
$$;
REVOKE ALL ON FUNCTION app.person_optout_uncarried(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_optout_uncarried(uuid, uuid) TO app_user, app_retention;

-- The worker's list before each sweep: soft-deleted people past purge_after whose do-not-contact is not carried
-- yet. The worker carries it as the system actor, in each person's own tenant transaction (R-TEN-6); the sweep
-- then purges them. Answers only without tenant and user context, as 0004's worker read-outs; ids only.
CREATE FUNCTION app.retention_optout_carry_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (tenant_id uuid, contact_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id, c.id FROM public.contacts c
   WHERE app.tenant_id() IS NULL AND app.user_id() IS NULL
     AND c.deleted_at IS NOT NULL AND c.purge_after <= p_now
     AND EXISTS (SELECT 1 FROM app.person_optout_uncarried(c.tenant_id, c.id))
   ORDER BY c.purge_after, c.tenant_id, c.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
ALTER FUNCTION app.retention_optout_carry_due(timestamptz, integer) OWNER TO app_retention;
REVOKE ALL ON FUNCTION app.retention_optout_carry_due(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retention_optout_carry_due(timestamptz, integer) TO app_user;

-- Erasure (R-DATA-4, R-DATA-7, R-DOC-4): 0018's statements, run once per record of the person (the loop, the
-- documents check over the merge tree and the do-not-contact check are marked; inside the loop only the contact
-- id and two table aliases differ).
CREATE OR REPLACE FUNCTION app.purge_contact_internal(p_tenant uuid, p_contact uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m record;   -- 0037
BEGIN
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

-- Privacy erasure (Owner/Admin): verbatim from 0001 except the marked merge-tree lines. VERIFY WITH COUNSEL.
CREATE OR REPLACE FUNCTION app.erase_contact(p_contact_id uuid, p_audit_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t uuid := app.tenant_id(); r text := app.my_role(); merged uuid[];   -- 0037: merged
BEGIN
  IF t IS NULL OR r IS NULL OR r NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'ERASE_FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = t AND c.id = p_contact_id) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  -- 0037: no record of the person (the contact or one merged into it) may be on a deal
  IF EXISTS (SELECT 1 FROM app.contact_merge_tree(t, p_contact_id) m
              WHERE EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = t AND d.primary_contact_id = m.contact_id)
                 OR EXISTS (SELECT 1 FROM public.deal_contacts dc WHERE dc.tenant_id = t AND dc.contact_id = m.contact_id)) THEN
    RAISE EXCEPTION 'CONTACT_ON_DEAL: remove from deals first (transaction records)' USING ERRCODE = 'check_violation';
  END IF;
  -- 0037: the records merged into the person, erased with it: each gets its own contact.erase row (ids only)
  merged := ARRAY(SELECT m.contact_id FROM app.contact_merge_tree(t, p_contact_id) m WHERE m.depth > 0 ORDER BY m.depth, m.contact_id);
  PERFORM app.purge_contact_internal(t, p_contact_id);
  INSERT INTO public.audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, actor_user_id, actor_role,
                                action, entity_type, entity_id, changes, reason)
  VALUES (t, p_audit_id, now(), 'user', 'api', app.user_id(), r, 'contact.erase', 'contact', p_contact_id,
          '{"erased": true}', p_reason);
  -- 0037
  INSERT INTO public.audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, actor_user_id, actor_role,
                                action, entity_type, entity_id, changes, reason)
  SELECT t, gen_random_uuid(), now(), 'user', 'api', app.user_id(), r, 'contact.erase', 'contact', x,
         jsonb_build_object('erased', true, 'erased_with_contact_id', p_contact_id), p_reason
    FROM unnest(merged) AS x;
END $$;
ALTER FUNCTION app.erase_contact(uuid, uuid, text) OWNER TO app_retention;

-- The retention sweep: verbatim from 0018 except the marked lines. The candidate filter now skips a person any
-- of whose records is on a deal or holds a retained document (as it already skipped the contact itself), or
-- whose do-not-contact is not carried yet (2b), so the purge does not refuse inside the sweep; a purge that
-- still refuses with one of those two codes (a point or a held document added since the scan) skips that person
-- until the next sweep instead of failing the sweep, and is counted.
CREATE OR REPLACE FUNCTION app.retention_sweep(p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  rec record;
  n_contacts integer := 0; n_sessions integer; n_jobs integer; n_auth integer; n_notif integer;
  n_audit integer; n_rec integer; n_raw integer; n_ai integer; n_webhooks integer;
  n_skipped integer := 0;   -- 0037
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
                            'contacts_skipped', n_skipped);   -- 0037
END $$;
ALTER FUNCTION app.retention_sweep(timestamptz) OWNER TO app_retention;

-- -----------------------------------------------------------------------------
-- 3. Points: a confirmed wrong number is final for its person (R-PAR-12). Verbatim from 0021 except the
--    marked message text.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.contact_points_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.address IS DISTINCT FROM OLD.address OR NEW.address_hmac IS DISTINCT FROM OLD.address_hmac THEN
    RAISE EXCEPTION 'CONTACT_POINT_IMMUTABLE: a phone or email never changes; remove it and add the new one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.removed_reason = 'wrong_number' AND OLD.removed_reason IS DISTINCT FROM 'wrong_number'
     AND NOT EXISTS (SELECT 1 FROM public.consent_events e
                      WHERE e.tenant_id = NEW.tenant_id AND e.address_hmac = NEW.address_hmac
                        AND e.source = 'wrong_number' AND e.event_type = 'revoke') THEN
    RAISE EXCEPTION 'REMOVED_REASON_WRONG_NUMBER: only an address with a recorded wrong-number report is removed as one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.removed_reason IS NOT NULL AND NEW.removed_at IS NOT NULL AND NEW.removed_reason IS DISTINCT FROM OLD.removed_reason THEN
    RAISE EXCEPTION 'REMOVED_REASON_IMMUTABLE: a removal reason never changes' USING ERRCODE = 'check_violation';
  END IF;
  -- a point restored after a wrong-number removal never comes back as anything but a fresh removal (S1)
  IF OLD.removed_reason = 'wrong_number' AND NEW.removed_at IS NULL THEN
    -- 0037: the message only (it said "add the number again", which the person's unique key refuses)
    RAISE EXCEPTION 'REMOVED_REASON_IMMUTABLE: a confirmed wrong number is final; it is never added back to this person'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
