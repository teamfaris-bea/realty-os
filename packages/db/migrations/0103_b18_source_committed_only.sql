-- Batch 18, review round 5: only a COMMITTED import outcome is import evidence, for a marked source too
-- (DATA_MODEL R-LSRC-8, R-LSRC-9, E728, E735, E743, E755). Security notes: docs/ARCHITECTURE.md §21.71.
--
--   0099 let a label the Owner mapped to a lead source cover every person an import record with that label TARGETED or
--   only MATCHED, whatever the record's outcome, and every person whose own record carried the label as
--   original_source_detail.import_source. 0101 kept that reading for the marked reason and gave an import's no-label
--   group the same two readings. So for a label mapped to a source marked "No automated contact for leads from this
--   source":
--     * a dry run alone (a preview: nothing is imported) made a native person the file merely matched read as that
--       source's lead; every automated path refused them, and their running plan stopped for good at its next step;
--     * a record waiting for review, a skipped duplicate, a rejected or reverted row and a whole abandoned import kept
--       doing that, and the only release was to un-map the label or turn the setting off, which opens the real source's
--       people;
--     * a token-authenticated intake caller chooses its own sourceDetail keys, so a caller-sent `import_source` equal
--       to a mapped label counted as import evidence.
--   The binding rule (owner decision 2026-11-14): a preview has no side effects, and only a committed import outcome
--   (a person imported or merged) is import evidence. 0101 already read "unclassified" that way; this migration reads
--   the marked reason the same way, so both reasons rest on one set of records.
--
--   * app.person_from_lead_source(tenant, contact, source) (SECURITY DEFINER; replaced: same signature, owner
--     app_definer, pinned path, explicit tenant check, one boolean). A lead source sent a person when a record of the
--     person (the merge tree) has it as its original lead source, or an inquiry of theirs came from it (both unchanged),
--     or a COMMITTED contacts import record (outcome 'imported' or 'merged', category 'contacts') that TARGETS a record
--     of the person carries a label the source holds, or carries no label in an import whose no-label group the source
--     holds. The match_contact_id branches and the contacts.original_source_detail branch are gone.
--   * app.person_source_refusal(tenant, contact) (SECURITY DEFINER; replaced: same signature, owner, path, tenant
--     check, one text or NULL, the same two codes). One set-based query: the person's committed import keys (each
--     label, each no-label import) are read once and joined to the lead sources that hold them; the marked reason and
--     the unclassified reason are both read from that join. 0101 called app.person_from_lead_source once per marked
--     source, and that inner SQL function was planned again on every call (about 1 ms per marked source per person).
--     The answer is the same as "a marked source sent the person" by app.person_from_lead_source: the db test compares
--     them person by person.
--   * COST 20000 on both, and on app.person_no_ai_care_source (unchanged otherwise). Each walks the merge tree and
--     probes contacts, lead_inquiries, import_records and lead_sources: tens of planner cost units, not the 0.25 of
--     the default (COST 100). With the default the planner was free to put the call under a nested loop and run it
--     once per joined row. No caller's result changes.
--   Not changed: app.import_source_people (it still lists the people a label's records targeted or matched, each with
--   whether a committed record targets them; the API reads the committed ones only), the five guards, every grant,
--   table, policy and retention rule.
--
--   EXISTING DATA. No row is changed. From the moment this is applied, a person who was covered ONLY by a record that
--   matched them, by a record that was not committed, or by an `import_source` key on their own record is no longer
--   refused: a new plan, alert or AI care may start for them. Nothing is restarted: a plan that already stopped stays
--   stopped, a withdrawn draft stays withdrawn and paused AI care stays paused until a person resumes it. A person an
--   import committed (imported or merged) reads exactly as before.

CREATE OR REPLACE FUNCTION app.person_from_lead_source(p_tenant uuid, p_contact uuid, p_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public COST 20000 AS $$
  WITH person AS (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id),
       src AS (SELECT s.import_labels AS labels, s.import_unlabeled_batches AS batches FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND s.id = p_source)
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (SELECT 1 FROM src) AND (
    EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person) AND c.original_lead_source_id = p_source)
    OR EXISTS (SELECT 1 FROM public.lead_inquiries i WHERE i.tenant_id = p_tenant AND i.contact_id IN (SELECT id FROM person) AND i.lead_source_id = p_source)
    -- a label this source holds, on a COMMITTED contacts record that targets a record of the person
    OR EXISTS (SELECT 1 FROM src, public.import_records r WHERE cardinality(src.labels) > 0 AND r.tenant_id = p_tenant AND r.target_table = 'contacts'
                AND r.target_id IN (SELECT id FROM person) AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'
                AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) <> '' AND (r.normalized ->> 'leadSourceLabel') = ANY (src.labels))
    -- an import's no-label group this source holds: a COMMITTED contacts record of that import, with no label, that
    -- targets a record of the person
    OR EXISTS (SELECT 1 FROM src, public.import_records r JOIN public.import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
                WHERE cardinality(src.batches) > 0 AND r.tenant_id = p_tenant AND r.target_table = 'contacts' AND r.target_id IN (SELECT id FROM person)
                  AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'
                  AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) = '' AND st.batch_id = ANY (src.batches)))
$$;
ALTER FUNCTION app.person_from_lead_source(uuid, uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_from_lead_source(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_from_lead_source(uuid, uuid, uuid) TO app_user;

CREATE OR REPLACE FUNCTION app.person_source_refusal(p_tenant uuid, p_contact uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public COST 20000 AS $$
  WITH person AS MATERIALIZED (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id),
       -- the person's COMMITTED contacts import records, each as the key the Owner maps: its label, or, with no label,
       -- its import (that import's no-label group)
       keys AS MATERIALIZED (
         SELECT DISTINCT CASE WHEN btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) <> '' THEN r.normalized ->> 'leadSourceLabel' END AS label,
                         CASE WHEN btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) = '' THEN st.batch_id END AS batch_id
           FROM public.import_records r JOIN public.import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
          WHERE r.tenant_id = p_tenant AND r.target_table = 'contacts' AND r.target_id IN (SELECT id FROM person)
            AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'),
       -- each key with the lead sources that hold it: how many, and whether one of them is marked
       held AS MATERIALIZED (
         SELECT count(s.id) AS holders, COALESCE(bool_or(s.no_ai_care), false) AS marked
           FROM keys k LEFT JOIN public.lead_sources s
             ON s.tenant_id = p_tenant AND ((k.label IS NOT NULL AND k.label = ANY (s.import_labels)) OR (k.batch_id IS NOT NULL AND k.batch_id = ANY (s.import_unlabeled_batches)))
          GROUP BY k.label, k.batch_id)
  SELECT CASE
    WHEN NOT COALESCE(p_tenant = app.tenant_id(), false) THEN NULL
    -- a marked source wins: the Owner's setting is the stronger, more specific reason. The same three ways a source
    -- sends a person as app.person_from_lead_source, asked for every marked source at once
    WHEN EXISTS (SELECT 1 FROM public.contacts c JOIN public.lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.original_lead_source_id
                  WHERE c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person) AND s.no_ai_care)
      OR EXISTS (SELECT 1 FROM public.lead_inquiries i JOIN public.lead_sources s ON s.tenant_id = i.tenant_id AND s.id = i.lead_source_id
                  WHERE i.tenant_id = p_tenant AND i.contact_id IN (SELECT id FROM person) AND s.no_ai_care)
      OR EXISTS (SELECT 1 FROM held WHERE held.marked)
      THEN 'SOURCE_NO_AUTOMATED_CONTACT'
    -- unclassified: a committed key that is not held by exactly one lead source
    WHEN EXISTS (SELECT 1 FROM held WHERE held.holders <> 1) THEN 'SOURCE_UNCLASSIFIED'
    ELSE NULL END
$$;
ALTER FUNCTION app.person_source_refusal(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_source_refusal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_source_refusal(uuid, uuid) TO app_user;

ALTER FUNCTION app.person_no_ai_care_source(uuid, uuid) COST 20000;

COMMENT ON COLUMN lead_sources.import_labels IS
  'b18 round 3 item 1, 0101, 0103: imported source labels (exactly as a FUB or CSV import stored them, compared whole) that mean this source (Owner only; app.lead_sources_import_labels_guard). app.person_from_lead_source counts the people a COMMITTED contacts import record (imported or merged) brought in with one as sent by this source; a committed imported label no source holds, or two hold, leaves its people unclassified (app.person_source_refusal). A dry run, a record that only matched a person and an abandoned import count for nobody.';

-- Self-check: the three definers keep their owner, pinned path and grants, and declare their cost; neither of the two
-- that read import records reads a match or a key on the person's own record any more.
DO $$
DECLARE f text; p record;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.person_from_lead_source(uuid,uuid,uuid)', 'app.person_source_refusal(uuid,uuid)', 'app.person_no_ai_care_source(uuid,uuid)'] LOOP
    SELECT r.rolname AS owner, x.prosecdef AS definer, x.proconfig AS config, x.proacl AS acl, x.procost AS cost, x.prosrc AS src INTO p
      FROM pg_proc x JOIN pg_roles r ON r.oid = x.proowner WHERE x.oid = f::regprocedure;
    IF p.owner <> 'app_definer' OR NOT p.definer OR NOT ('search_path=pg_catalog, public' = ANY (p.config)) THEN
      RAISE EXCEPTION '0103: % must be a definer owned by app_definer with a pinned search_path', f;
    END IF;
    IF NOT has_function_privilege('app_user', f, 'EXECUTE') OR EXISTS (SELECT 1 FROM aclexplode(p.acl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '0103: % EXECUTE must be app_user only', f;
    END IF;
    IF p.cost < 5000 THEN RAISE EXCEPTION '0103: % must declare its cost', f; END IF;
    IF position('match_contact_id' IN p.src) > 0 OR position('original_source_detail' IN p.src) > 0 THEN
      RAISE EXCEPTION '0103: % must read committed import records only', f;
    END IF;
  END LOOP;
END $$;
