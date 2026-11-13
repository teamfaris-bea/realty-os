-- =============================================================================
-- 0089_b14_erase_trigger_order: contact erasure no longer depends on the order the RI triggers fire in (batch 14
-- to-do, privacy-critical; R-DATA-3, R-DATA-7, R-LEM-5; docs/ARCHITECTURE §21.54, found in §21.52's F6 analysis).
-- Why schema and not code: the defect is inside app.purge_contact_internal, which every erasure (the erase route's
-- app.erase_contact) and the retention sweep run.
--
-- The cause. purge_contact_internal UPDATEs the person's lead_email_messages rows (0041: their sender and DKIM
-- domains) and then deletes each record. lead_email_messages has two ON DELETE SET NULL foreign keys: to the contact
-- and to the inquiry, which the contact's delete cascades away (lead_inquiries ON DELETE CASCADE). PostgreSQL
-- re-checks every foreign key of a row that an RI action updates when the old row version is this transaction's own
-- (ri_triggers.c RI_FKey_fk_upd_check_required), and the contact's RI actions fire in trigger-name order,
-- RI_ConstraintTrigger_a_<oid> compared as text. When the email's SET NULL (contact_id) sorts before the inquiries'
-- cascade, the inquiry key is re-checked after the inquiry is gone and before inquiry_id is nulled, and the erase
-- fails: "lead_email_messages violates foreign key constraint lead_email_messages_tenant_id_inquiry_id_fkey". The
-- person is then not erased (POST /contacts/:id/erase answers an error; the sweep skips them). The order is an
-- accident of oids: a template or a database built while the oid counter crosses a power of ten, or a migration that
-- re-creates either foreign key, flips it.
--
-- The change. The same UPDATE that drops the domains now also unlinks the rows, before any record is deleted:
-- contact_id when it names a record of the person (the locked merge tree), inquiry_id when it names one of their
-- inquiries, and it covers every row linked either way (an email reached through the person's inquiry alone loses the
-- domains too, which it kept before). The end state is the one the two SET NULL actions produced: the email row stays,
-- unlinked, as the replay tombstone of its message key. Both SET NULL actions then find no row, so nothing is re-checked
-- and the outcome is the same in either order. Every other line of the function is 0041's, verbatim (marked 0089).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * replaces app.purge_contact_internal (SECURITY DEFINER, owner app_retention, pinned search_path; grants unchanged:
--     CREATE OR REPLACE keeps the ACL, and the owner is restated). No table, policy, grant or trigger is added or
--     changed. The UPDATE touches lead_email_messages of p_tenant only, and only rows linked to the person's records
--     or inquiries; it only nulls a link or a trust fact, which app.lead_email_messages_guard (0041) allows the
--     retention role, and which the foreign keys' own ON DELETE SET NULL did a moment later before.
--   * only purges more: the domains of an email linked to the person by inquiry alone are dropped too.
-- Proof: packages/db/test/erase_trigger_order_0089.test.ts forces each order by re-creating a foreign key (fails
-- without this migration with the error above), and portal_retracted_by_fk.test.ts' F6 reproduction now succeeds.
-- =============================================================================

-- 0041's statements, verbatim except the marked 0089 lines.
CREATE OR REPLACE FUNCTION app.purge_contact_internal(p_tenant uuid, p_contact uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE m record;   -- 0037
  tree uuid[]; locked uuid[] := '{}';   -- 0041
  inq uuid[];   -- 0089
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
  -- person's own domain when a reviewer accepted their own email)
  -- 0089: and they are unlinked here, before any record is deleted: contact_id when it names a record of the person,
  -- inquiry_id when it names one of their inquiries (which the contact's delete cascades away). An email reached
  -- through the person's inquiry alone loses the domains as well. The two ON DELETE SET NULL actions then find no row
  -- to update, so no foreign key of a row this transaction already wrote is re-checked against a half-deleted person,
  -- whatever order the RI triggers fire in (their names sort by oid as text; ARCHITECTURE §21.54).
  inq := ARRAY(SELECT i.id FROM public.lead_inquiries i WHERE i.tenant_id = p_tenant AND i.contact_id = ANY (locked) ORDER BY i.id);   -- 0089
  UPDATE public.lead_email_messages lm SET sender_domain = NULL, dkim_pass_domains = '{}',
         contact_id = CASE WHEN lm.contact_id = ANY (locked) THEN NULL ELSE lm.contact_id END,   -- 0089
         inquiry_id = CASE WHEN lm.inquiry_id = ANY (inq) THEN NULL ELSE lm.inquiry_id END       -- 0089
   WHERE lm.tenant_id = p_tenant AND (lm.contact_id = ANY (locked) OR lm.inquiry_id = ANY (inq));   -- 0089: every linked row
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
