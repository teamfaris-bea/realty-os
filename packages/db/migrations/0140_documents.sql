-- Module 42 api/documents (PHASE2_3_PLAN §5.4 #42; DATA_MODEL Part 2 R-DOC-1..10, E400-E419). The orchestrator
-- renumbers this file at merge. Invoker triggers and indexes only: no table shape, policy, grant or definer changes
-- (plan §4 migration policy; the 0055 precedent for module triggers).
--
-- SECURITY REVIEW ITEMS (each an invoker trigger; each runs with the caller's RLS, so what it reads is what the
-- caller may read; a foreign-tenant row returns early so RLS, not a module error, refuses it; app_definer and
-- app_retention are skipped exactly as app.documents_guard does):
--   app.documents_integrity_guard     BEFORE INSERT OR UPDATE OF shared_to_portal ON documents (fires after
--                                     documents_guard by name). INSERT: the uploader is the acting person
--                                     (DOCUMENT_UPLOADER_SELF); the row names that person's own live, unshredded
--                                     'document' object of an allowed type and size, used by no other document
--                                     (DOCUMENT_OBJECT_INVALID: referential checks bypass RLS, so the FK alone would
--                                     accept another person's or another purpose's object); a new version supersedes
--                                     a document the caller can read, in the same scope (DOCUMENT_VERSION_INVALID),
--                                     and takes version_no = prev + 1 and the previous kind. UPDATE: only a person
--                                     who may write the deal (app.deal_writable) or the listing (app.listing_writable)
--                                     changes shared_to_portal (DOCUMENT_SHARE_NOT_ALLOWED): TCs and ISAs never share.
--   app.deal_dates_evidence_guard     BEFORE INSERT OR UPDATE OF evidence_claim_id ON deal_dates: a date cites a
--                                     claim only as a 'document' date, and only a verified (not needs_review)
--                                     'date_time' claim of a contract_extraction of the same deal, read under the
--                                     caller's RLS (DEAL_DATE_EVIDENCE_INVALID; R-AST-1, R-DOC-10).
-- Indexes: one document per object; linear version chains; scope lookups; the pending-scan queue; one date per claim.

CREATE FUNCTION app.documents_integrity_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE prev record;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF current_user IN ('app_definer','app_retention') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF app.actor_kind() IS DISTINCT FROM 'user' OR NEW.uploaded_by_user_id IS DISTINCT FROM app.user_id() THEN
      RAISE EXCEPTION 'DOCUMENT_UPLOADER_SELF: a person uploads a document as themselves' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stored_objects o
                    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.object_id AND o.purpose = 'document'
                      AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL
                      AND o.created_by_user_id = NEW.uploaded_by_user_id
                      AND o.content_type IN ('application/pdf','image/jpeg','image/png')
                      AND o.byte_size BETWEEN 1 AND 10000000)
       OR EXISTS (SELECT 1 FROM public.documents d WHERE d.tenant_id = NEW.tenant_id AND d.object_id = NEW.object_id) THEN
      RAISE EXCEPTION 'DOCUMENT_OBJECT_INVALID: a document names the uploader''s own unused document file (PDF, JPEG or PNG, at most 10 MB)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.supersedes_id IS NULL THEN
      NEW.version_no := 1;
    ELSE
      SELECT d.version_no, d.kind, d.deal_id, d.listing_id, d.contact_id INTO prev
        FROM public.documents d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.supersedes_id;
      IF NOT FOUND OR (prev.deal_id, prev.listing_id, prev.contact_id) IS DISTINCT FROM (NEW.deal_id, NEW.listing_id, NEW.contact_id) THEN
        RAISE EXCEPTION 'DOCUMENT_VERSION_INVALID: a new version replaces a document you can read, in the same deal, listing or contact'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.version_no := prev.version_no + 1;
      NEW.kind := prev.kind;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.shared_to_portal IS DISTINCT FROM OLD.shared_to_portal
     AND (app.actor_kind() IS DISTINCT FROM 'user'
          OR NOT ((NEW.deal_id IS NOT NULL AND app.deal_writable(NEW.tenant_id, NEW.deal_id))
                  OR (NEW.listing_id IS NOT NULL AND app.listing_writable(NEW.tenant_id, NEW.listing_id)))) THEN
    RAISE EXCEPTION 'DOCUMENT_SHARE_NOT_ALLOWED: the deal''s or listing''s agent, a Team Lead, the Owner or an Admin shares documents'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_integrity_guard BEFORE INSERT OR UPDATE OF shared_to_portal ON public.documents
  FOR EACH ROW EXECUTE FUNCTION app.documents_integrity_guard();

CREATE FUNCTION app.deal_dates_evidence_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF current_user IN ('app_definer','app_retention') THEN RETURN NEW; END IF;
  IF NEW.evidence_claim_id IS NULL THEN RETURN NEW; END IF;                        -- also ON DELETE SET NULL
  IF TG_OP = 'UPDATE' AND NEW.evidence_claim_id IS NOT DISTINCT FROM OLD.evidence_claim_id AND NEW.source = OLD.source THEN
    RETURN NEW;
  END IF;
  IF NEW.source IS DISTINCT FROM 'document' OR NOT EXISTS (
       SELECT 1 FROM public.assistant_claims c
         JOIN public.assistant_actions a ON a.tenant_id = c.tenant_id AND a.id = c.action_id
        WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.evidence_claim_id
          AND NOT c.needs_review AND c.claim_kind = 'date_time'
          AND a.kind = 'contract_extraction' AND a.trigger_ref->>'dealId' = NEW.deal_id::text) THEN
    RAISE EXCEPTION 'DEAL_DATE_EVIDENCE_INVALID: a date cites only a verified contract date of its own deal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deal_dates_evidence_guard BEFORE INSERT OR UPDATE OF evidence_claim_id ON public.deal_dates
  FOR EACH ROW EXECUTE FUNCTION app.deal_dates_evidence_guard();

CREATE UNIQUE INDEX documents_object_uq ON public.documents (tenant_id, object_id);
CREATE UNIQUE INDEX documents_supersedes_uq ON public.documents (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX documents_deal_idx ON public.documents (tenant_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX documents_listing_idx ON public.documents (tenant_id, listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX documents_contact_idx ON public.documents (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX documents_pending_idx ON public.documents (tenant_id, created_at) WHERE scan_status = 'pending';
CREATE UNIQUE INDEX deal_dates_evidence_claim_uq ON public.deal_dates (tenant_id, evidence_claim_id) WHERE evidence_claim_id IS NOT NULL;
