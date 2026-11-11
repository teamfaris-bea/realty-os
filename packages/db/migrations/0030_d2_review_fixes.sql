-- =============================================================================
-- D2 review fixes: hardening of the D2 schema (the Gmail inbox sync and Meta publishing migration, 0025) after
-- the post-merge review. 0025 was written before 0019-0024 landed; independent reviewers checked it against the
-- merged tree and a separate verifier reproduced each finding below on a clone of the merged template.
-- docs/DATA_MODEL.md Part 2 (§6.3, §7, R-GMAIL-6, -9, -12, E201), docs/ARCHITECTURE.md §21.8, §21.10,
-- docs/PHASE2_3_PLAN.md §4, §4.1, modules 22 and 68.
--
-- The file number is a placeholder: the orchestrator may renumber it at merge, so nothing in code or tests names
-- this file. 0001-0029 are not edited. Gmail sync (module 68) is not built yet, so nothing writes the Gmail tables
-- today. Every change only narrows access, except #1, which corrects an over-refusal: no RLS policy, FORCE RLS,
-- opt-out (D1) or support read-only rule is weakened, and no grant is added.
--
-- 1. consent_events_synced_gmail (0025) refused the wrong_number revoke that platform email writes for the same
--    classifier result. R-GMAIL-9 says synced Gmail runs the same deterministic classifier as platform inbound email;
--    classifyInbound checks "wrong person" / "wrong e-mail" BEFORE opt-out language, and platform email records that
--    result as an email revoke with source 'wrong_number' (R-CONSENT-11). Module 68 could only fail the sync page
--    (the cursor stalls), drop the revoke (the address stays emailable), or write it without its citation (losing
--    the R-GMAIL-9/S-D2-3 provenance); and 0021's "remove as a confirmed wrong number" (R-PAR-12) needs exactly that
--    revoke. The CHECK is re-created with 'wrong_number' added to its sources and nothing else changed: every event
--    citing synced Gmail is still a revoke, by the system actor, on channel and address kind email, with no
--    evidence_message_id and exactly one well-formed citation, so synced mail still never grants, resubscribes or
--    otherwise lifts an opt-out, and never marks a phone. The new CHECK is strictly looser than 0025's, so VALIDATE
--    cannot fail on existing rows (added NOT VALID, then validated).
-- 2. app.resolve_channel_account (0024) still routed 'ads_meta'. D2 removed Meta ads (never offered; no Meta
--    webhooks), and 0024 already made the other out-of-scope Meta kinds unroutable in the database whatever the API
--    does. Replaced without 'ads_meta' (security notes below).
-- 3. app.mail_copy_live (0025 definer) answered callers that the mail_messages read policies exclude: a support
--    actor under an Owner grant, a client principal, a staff session with no actor, and a peer who holds a copy's
--    uuid (published in consent_events evidence, which every reader of a contact point with the same address sees)
--    could ask, repeatedly, whether another agent's copy is still live, and so learn that agent's disconnect,
--    private thread exclusion (R-GMAIL-7), withdrawn confirmation or deactivation, against R-GMAIL-6 and
--    ARCHITECTURE §21.10. Replaced with the read policies' own gates (security notes below).
-- 4. Any user who can write a message could set messages.rfc_message_id_sha256, and app.mail_messages_guard trusts
--    it to refuse the system's Gmail copy (R-GMAIL-12): a TL, an initiator or an Owner could plant (or clear) a hash
--    to suppress (or duplicate) a copy in another agent's mailbox, and module 68's reconcile would delete a copy
--    once a "platform row" with its hash exists. New invoker trigger app.messages_rfc_guard: only the system actor
--    (platform inbound ingestion and dispatch TX2 both run as the system) sets a non-NULL hash, on INSERT or on an
--    UPDATE from NULL; once set it never changes, for anyone; NULL inserts and every other edit by people are
--    unchanged; the standard early return for a foreign tenant leaves the refusal to RLS.
-- 5. Policy mail_messages_select tested app.contact_detail_visible (a non-inlined SQL function, about 0.2 ms per row)
--    before the cheap mailbox-link EXISTS, so the system's sync (the guard's per-thread count), purge and re-point
--    statements and the mailbox owner paid the helper on every row (0020, docs/PERFORMANCE.md §5). ALTER POLICY puts
--    the EXISTS first. OR is commutative and both operands are side-effect-free STABLE boolean expressions that are
--    never NULL, so the policy admits exactly the same rows (smoke: row for row, per actor).
-- 6. (docs) The database refuses a Gmail duplicate only of platform email whose row carries the hash; rows saved
--    before module 22 writes it, and imported email, carry none. The platform:gmail pack notes get the rollout
--    precondition (appended once; 0025's INSERT is not edited).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4): no new SECURITY DEFINER function. Two definers are REPLACED, each with
-- CREATE OR REPLACE (same signature, so every caller and the policy binding stay), and re-asserted: owner
-- app_definer, STABLE, search_path pinned to pg_catalog, public, EXECUTE revoked from PUBLIC and granted to
-- app_user only, exactly as before.
--   * app.resolve_channel_account(p_kind, p_external_account_id) -> (tenant_id, connection_id): the pre-tenant
--     router of R-TEN-11. The body is 0024's verbatim except the enumerated kind allowlist, which loses 'ads_meta':
--     zillow_feed, realtor_feed, mls_feed, showing_service, ads_google, gbp_location. It still reads only
--     integration_connections joined to active tenants, routes only connected/degraded rows, returns two ids and
--     no payload, and writes nothing. Only narrows: a live ads_meta row (only the system can create one, by 0018's
--     integration_connections_guard) now routes nothing, like 0024's messenger_page, instagram_account and
--     meta_lead_ads. The kind CHECK is unchanged (the D2 cleanup removes the kind).
--   * app.mail_copy_live(p_tenant, p_copy) boolean: still called per row only by the RESTRICTIVE mail_messages_live
--     policy (the system short-circuits it there), still takes only a copy's own row identity, looks the row up
--     itself, reads no content and writes nothing; the liveness test is 0025's verbatim (link live, thread not
--     excluded, point current and confirmed, address no live link's mailbox). New: it answers only a caller whom
--     the mail_messages read policies admit for that very row, and is false for anyone else whatever the copy's
--     state, so it reveals nothing a SELECT of the row does not:
--       - tenant_isolation: p_tenant is the context tenant (as before) and the principal is staff (never a client);
--       - mail_messages_no_support: the actor is a user or the system (never support, never no actor);
--       - mail_messages_select, as the caller: the system; the link's own user (mail_links_select; the active
--         membership it also asks for is implied by the liveness test); an Owner/Admin (is_tenant_wide); or a reader
--         of the contact's timeline. app.contact_detail_visible cannot be called for that here: it reads contacts
--         under the CALLER's RLS, which a definer (app_definer, BYPASSRLS) does not have. So the function writes it
--         out, as 0020 defines it: contacts_select AND contact_detail_visible's detail filter, branch by branch,
--         with each helper set of 0001 (my_role, is_tenant_wide, sees_all_detail, my_collab_contact_ids,
--         my_deal_contact_ids, my_team_member_ids, my_pond_ids) probed for this one contact instead of called. It is
--         now PL/pgSQL: it returns at once for the system, the mailbox owner and an Owner/Admin, and runs a probe
--         only when a branch needs it. Calling the helpers, or one SQL query holding every probe, ran a chain of
--         nested definers or initialized every probe on each call, per row: measured on 500 copies of one contact
--         that made an Owner's or Team Lead's read 25-70% slower. As written, the Owner's read costs what it did
--         under the D2 migration, a Team Lead's or collaborator's about 10% more, and the mailbox owner's, a
--         non-reader's and the system's less (finding 5). If contacts_select, contact_detail_visible or one of those
--         helpers ever changes, this copy must change with it. Exactness: for every actor of a generated 2,000-contact
--         tenant (each role, every ownership state, collaborators, deals, with and without the actor's ownership
--         command) this function and SELECT gave app.contact_detail_visible's answer for every copy; the D2 review
--         smoke compares this function's answer with what each actor can SELECT, copy by copy, so a stale copy fails.
--     A member who reads the copy gets the same answer as before; everyone else now gets false.
--   * new invoker trigger function app.messages_rfc_guard() (EXECUTE revoked from PUBLIC; a trigger needs no
--     grant to fire): reads only GUCs and the row, raises or returns NEW.
--   * policy mail_messages_select: reordered, row-identical (finding 5). consent_events_synced_gmail: one more
--     revoke source (finding 1). jurisdiction_packs: one notes text (finding 6).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. R-GMAIL-9: a synced-Gmail opt-out records what platform inbound email records for the same classifier
--    result, including a wrong_number revoke; still only ever a cited system email revoke.
-- -----------------------------------------------------------------------------
ALTER TABLE consent_events DROP CONSTRAINT consent_events_synced_gmail;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_synced_gmail CHECK (
  NOT (evidence ? 'mail_message_id' OR evidence ? 'gmail_message_ref' OR evidence->>'kind' = 'synced_gmail')
  OR (event_type = 'revoke' AND channel = 'email' AND address_kind = 'email' AND actor_kind = 'system'
      AND source IN ('inbound_keyword','inbound_language','wrong_number') AND evidence_message_id IS NULL
      AND COALESCE(evidence->>'kind', '') = 'synced_gmail'
      AND ((COALESCE(evidence->>'mail_message_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND NOT evidence ? 'gmail_message_ref')
           OR (COALESCE(evidence->>'gmail_message_ref', '') ~ '^[0-9a-f]{64}$' AND NOT evidence ? 'mail_message_id')))) NOT VALID;
ALTER TABLE consent_events VALIDATE CONSTRAINT consent_events_synced_gmail;

-- -----------------------------------------------------------------------------
-- 2. R-TEN-11 (D2): the pre-tenant router never returns a Meta kind. SECURITY DEFINER (review item, see header).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.resolve_channel_account(p_kind text, p_external_account_id text)
RETURNS TABLE (tenant_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id, c.id
    FROM public.integration_connections c
    JOIN public.tenants t ON t.id = c.tenant_id AND t.status = 'active'
   WHERE p_kind IN ('zillow_feed','realtor_feed','mls_feed','showing_service','ads_google','gbp_location')
     AND c.kind = p_kind
     AND c.external_account_id = p_external_account_id
     AND c.status IN ('connected','degraded')
$$;
ALTER FUNCTION app.resolve_channel_account(text, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.resolve_channel_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_channel_account(text, text) TO app_user;

-- -----------------------------------------------------------------------------
-- 3. R-GMAIL-6: the copy check answers only a caller the mail_messages read policies admit for that row.
--    SECURITY DEFINER (review item, see header).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.mail_copy_live(p_tenant uuid, p_copy uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  me    uuid := app.user_id();
  actor text := app.actor_kind();
  r     record;     -- the copy: its contact, its link's user, the caller's role (app.my_role(): NULL for the system)
  c     record;     -- the copy's contact
  sel   boolean;    -- contacts_select (0020) for the caller
  rel   boolean;    -- the caller collaborates on the contact or shares a deal with it (my_collab / my_deal_contact_ids)
BEGIN
  -- tenant_isolation (the context tenant, staff only) and mail_messages_no_support (a user or the system; no actor
  -- reads nothing): false before anything is read
  IF NOT (COALESCE(p_tenant = app.tenant_id(), false) AND COALESCE(app.principal_type() = 'staff', false)
          AND actor IN ('user','system')) THEN
    RETURN false;
  END IF;
  -- the copy is live (0025's test, unchanged): its link live, its thread not excluded, its point current and confirmed
  -- by the mailbox owner, its address no live link's mailbox
  SELECT mm.contact_id, l.user_id AS link_user, m.role INTO r
    FROM public.mail_messages mm
    JOIN public.user_mail_links l ON l.tenant_id = mm.tenant_id AND l.id = mm.link_id
    JOIN public.contact_points p
      ON p.tenant_id = mm.tenant_id AND p.id = mm.contact_point_id AND p.contact_id = mm.contact_id AND p.removed_at IS NULL
    JOIN public.mail_sync_points sp
      ON sp.tenant_id = mm.tenant_id AND sp.link_id = mm.link_id AND sp.contact_point_id = mm.contact_point_id
    LEFT JOIN public.memberships m
      ON m.tenant_id = mm.tenant_id AND m.user_id = me AND m.status = 'active' AND actor = 'user'
   WHERE mm.tenant_id = p_tenant AND mm.id = p_copy
     AND app.mail_link_live(mm.tenant_id, mm.link_id)
     AND NOT EXISTS (SELECT 1 FROM public.mail_thread_exclusions x
                      WHERE x.tenant_id = mm.tenant_id AND x.link_id = mm.link_id AND x.gmail_thread_id = mm.gmail_thread_id)
     AND NOT EXISTS (SELECT 1 FROM public.user_mail_links ml
                      WHERE ml.tenant_id = mm.tenant_id AND ml.status <> 'revoked' AND ml.mailbox_address_hmac = mm.contact_address_hmac);
  IF NOT FOUND THEN RETURN false; END IF;
  -- mail_messages_select, as the caller. The system and the link's own user see the link (mail_links_select; that
  -- user's active membership follows from mail_link_live); an Owner or Admin reads every contact's timeline
  -- (is_tenant_wide()).
  IF actor = 'system' OR r.link_user = me OR r.role IN ('owner','admin') THEN RETURN true; END IF;
  -- Anyone else reads the copy like the contact's timeline: app.contact_detail_visible (0020) = contacts_select AND
  -- the detail filter, written out (see the header), each helper set of 0001 probed for this one contact.
  SELECT x.deleted_at, x.owner_user_id, x.offered_to_user_id, x.ownership_state, x.pond_id,
         x.ownership_actor_user_id, x.ownership_command_id
    INTO c FROM public.contacts x WHERE x.tenant_id = p_tenant AND x.id = r.contact_id;
  IF NOT FOUND THEN RETURN false; END IF;
  sel := COALESCE(c.deleted_at IS NULL AND c.owner_user_id = me AND r.role IS NOT NULL, false)
         OR COALESCE(c.ownership_actor_user_id = me AND c.ownership_command_id = app.ownership_command(), false);
  IF NOT sel AND c.deleted_at IS NULL AND r.role IS NOT NULL THEN
    sel := COALESCE(c.owner_user_id = me, false) OR COALESCE(c.offered_to_user_id = me, false)
           OR (c.ownership_state = 'in_pond' AND r.role = 'team_lead');
    IF NOT sel AND r.role = 'team_lead' THEN               -- owner_user_id / offered_to_user_id = ANY (my_team_member_ids())
      sel := EXISTS (SELECT 1 FROM public.team_members lead
                       JOIN public.team_members tm ON tm.tenant_id = lead.tenant_id AND tm.team_id = lead.team_id
                      WHERE lead.tenant_id = p_tenant AND lead.user_id = me AND lead.is_lead
                        AND tm.user_id IN (c.owner_user_id, c.offered_to_user_id));
    END IF;
    IF NOT sel THEN                                        -- id = ANY (my_collab_contact_ids()) / ANY (my_deal_contact_ids())
      rel := EXISTS (SELECT 1 FROM public.contact_collaborators k
                      WHERE k.tenant_id = p_tenant AND k.contact_id = r.contact_id AND k.user_id = me
                        AND k.removed_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()))
          OR EXISTS (SELECT 1 FROM public.deal_contacts dc
                       JOIN public.deal_members dm ON dm.tenant_id = dc.tenant_id AND dm.deal_id = dc.deal_id
                      WHERE dc.tenant_id = p_tenant AND dc.contact_id = r.contact_id AND dm.user_id = me)
          OR EXISTS (SELECT 1 FROM public.deals d
                       JOIN public.deal_members dm ON dm.tenant_id = d.tenant_id AND dm.deal_id = d.id
                      WHERE d.tenant_id = p_tenant AND d.primary_contact_id = r.contact_id AND dm.user_id = me);
      sel := rel;
    END IF;
    IF NOT sel AND c.ownership_state = 'in_pond' THEN      -- pond_id = ANY (my_pond_ids())
      sel := EXISTS (SELECT 1 FROM public.ponds pd
                      WHERE pd.tenant_id = p_tenant AND pd.id = c.pond_id AND pd.archived_at IS NULL
                        AND r.role = ANY (pd.eligible_roles)
                        AND (pd.open_to_all OR EXISTS (SELECT 1 FROM public.pond_members pm
                                                        WHERE pm.tenant_id = pd.tenant_id AND pm.pond_id = pd.id AND pm.user_id = me)));
    END IF;
  END IF;
  IF NOT sel THEN RETURN false; END IF;
  -- the detail filter: never through a pond or offer card alone, unless the caller sees all detail (sees_all_detail():
  -- a Team Lead here) or collaborates on the contact or shares a deal with it
  IF c.ownership_state NOT IN ('in_pond','offered') OR r.role = 'team_lead' THEN RETURN true; END IF;
  IF r.role IS NULL THEN RETURN false; END IF;
  IF rel IS NULL THEN
    rel := EXISTS (SELECT 1 FROM public.contact_collaborators k
                    WHERE k.tenant_id = p_tenant AND k.contact_id = r.contact_id AND k.user_id = me
                      AND k.removed_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()))
        OR EXISTS (SELECT 1 FROM public.deal_contacts dc
                     JOIN public.deal_members dm ON dm.tenant_id = dc.tenant_id AND dm.deal_id = dc.deal_id
                    WHERE dc.tenant_id = p_tenant AND dc.contact_id = r.contact_id AND dm.user_id = me)
        OR EXISTS (SELECT 1 FROM public.deals d
                     JOIN public.deal_members dm ON dm.tenant_id = d.tenant_id AND dm.deal_id = d.id
                    WHERE d.tenant_id = p_tenant AND d.primary_contact_id = r.contact_id AND dm.user_id = me);
  END IF;
  RETURN rel;
END $$;
ALTER FUNCTION app.mail_copy_live(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.mail_copy_live(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mail_copy_live(uuid, uuid) TO app_user;

-- -----------------------------------------------------------------------------
-- 4. R-GMAIL-12: the platform email Message-ID hash, which app.mail_messages_guard trusts, is the system's and is
--    written once. Platform inbound ingestion and dispatch TX2 run as the system actor; a person's transaction
--    (dispatch TX1 included) never writes it.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.messages_rfc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' AND OLD.rfc_message_id_sha256 IS NOT NULL
     AND NEW.rfc_message_id_sha256 IS DISTINCT FROM OLD.rfc_message_id_sha256 THEN
    RAISE EXCEPTION 'RFC_MESSAGE_ID_FINAL: a platform email''s Message-ID hash is written once and never changed or cleared'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.rfc_message_id_sha256 IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.rfc_message_id_sha256 IS NULL)
     AND NOT (COALESCE(app.actor_kind() = 'system', false) OR current_user IN ('app_definer','app_retention')) THEN
    RAISE EXCEPTION 'RFC_MESSAGE_ID_SYSTEM_ONLY: only platform email ingestion and dispatch (the system) record a Message-ID hash'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.messages_rfc_guard() FROM PUBLIC;
CREATE TRIGGER messages_rfc_guard BEFORE INSERT OR UPDATE OF rfc_message_id_sha256 ON messages
  FOR EACH ROW EXECUTE FUNCTION app.messages_rfc_guard();

-- -----------------------------------------------------------------------------
-- 5. mail_messages_select: the mailbox-link EXISTS first (a hashed subplan, run once per statement), so the system
--    and the mailbox owner never call contact_detail_visible per row. Same rows (OR is commutative; see header).
-- -----------------------------------------------------------------------------
ALTER POLICY mail_messages_select ON mail_messages USING (
  EXISTS (SELECT 1 FROM user_mail_links l WHERE l.tenant_id = mail_messages.tenant_id AND l.id = mail_messages.link_id)
  OR app.contact_detail_visible(tenant_id, contact_id));

-- -----------------------------------------------------------------------------
-- 6. platform:gmail rollout precondition (R-GMAIL-12, E201), appended once to the pack notes.
-- -----------------------------------------------------------------------------
UPDATE jurisdiction_packs
   SET notes = concat_ws(' ', notes,
               'Rollout precondition (R-GMAIL-12, E201): set vendor_ready_at only after module 22 has written '
               'messages.rfc_message_id_sha256 on platform email for at least 90 days (the largest mail_backfill_days), or '
               'after a one-time module 22 repair has filled it on the platform email rows of that window it can recover: '
               'the database refuses a Gmail copy only of platform email whose row carries the hash, so an earlier row (and '
               'imported email, which never has one) shows a backfilled message twice.')
 WHERE key = 'platform:gmail' AND status = 'published' AND COALESCE(position('Rollout precondition' IN notes), 0) = 0;

-- -----------------------------------------------------------------------------
-- 7. Self-check: the two replaced definers keep their reviewed owner, pinned search_path and grants; the new
--    trigger function is executable by nobody but its owner; the CHECK is validated; the policy leads with the link.
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('app.resolve_channel_account(text,text)'::regprocedure, 'app.mail_copy_live(uuid,uuid)'::regprocedure)
                AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef OR p.provolatile <> 's'
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                     OR has_function_privilege('public', p.oid, 'EXECUTE')
                     OR NOT has_function_privilege('app_user', p.oid, 'EXECUTE'))) THEN
    bad := bad || ' replaced_definer';
  END IF;
  IF has_function_privilege('public', 'app.messages_rfc_guard()', 'EXECUTE')
     OR has_function_privilege('app_user', 'app.messages_rfc_guard()', 'EXECUTE')
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'app.messages_rfc_guard()'::regprocedure) THEN
    bad := bad || ' rfc_guard';
  END IF;
  IF NOT (SELECT convalidated FROM pg_constraint
           WHERE conrelid = 'public.consent_events'::regclass AND conname = 'consent_events_synced_gmail') THEN
    bad := bad || ' synced_gmail_check';
  END IF;
  IF (SELECT position('user_mail_links' IN q) = 0 OR position('contact_detail_visible' IN q) < position('user_mail_links' IN q)
        FROM (SELECT pg_get_expr(p.polqual, p.polrelid) AS q FROM pg_policy p
               WHERE p.polrelid = 'public.mail_messages'::regclass AND p.polname = 'mail_messages_select') s) THEN
    bad := bad || ' mail_messages_select_order';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'SCHEMA SELF-CHECK FAILED (D2 review fixes):%', bad;
  END IF;
END $$;
