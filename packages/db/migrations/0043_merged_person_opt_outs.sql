-- =============================================================================
-- A merged-away record is the whole person (review finding F1 of batch 5; owner rule D1; DATA_MODEL R-CHAN-2,
-- R-CONSENT-7, R-PAR-12, R-OWN-24, E140). The number is a placeholder: the orchestrator renumbers at merge, and
-- nothing in code or tests names this file. 0001-0040 are not edited.
--
-- The gap. A merge copies the loser's points onto the survivor (0027 app.contacts_merge_children) and carries the
-- loser's person-level do-not-contact up to the survivor's own row (0018 app.contacts_dnc_follow_merge), so a send
-- addressed to the SURVIVOR sees every opt-out of the person. Nothing carried anything down: the dispatch guards
-- checked the do-not-contact of the recipient and of the records merged INTO it, and fanned an SMS/voice opt-out out
-- over the recipient record's own phones only. So the survivor's do-not-contact, or a STOP from a phone only the
-- survivor had, both recorded before the merge, never blocked a send addressed to the merged-away record on that
-- record's own phone or email; core canContact read the same facts (api comms/repos/gate.ts) and agreed. The review
-- sent human texts, an enrolled plan's texts and an automatic saved-search alert to such a person through the fake
-- providers. The API now refuses anything newly addressed to a merged-away record (409 CONTACT_MERGED), and this
-- migration is the D1 backstop for whatever reaches one anyway (a message composed while the merge committed).
--
-- The fix: both guards judge the recipient as its whole person, the records app.contact_person_ids returns: the root
-- survivor reached by following merged_into_contact_id up from the recipient, and every record merged into that root,
-- along merge chains. The person-level do-not-contact of ANY of them blocks every channel (R-CHAN-2), and the
-- "any of the person's phones" opt-out fan-out (R-CONSENT-7, outbound-3, R-PAR-12: removed phones count unless
-- removed as a confirmed wrong number) reads the phones of all of them. For a recipient nobody merged anything into
-- or away, the person is the recipient alone and nothing changes; for a survivor it changes nothing either (the
-- merge already copied the losers' points and carried their do-not-contact onto it). The keyword-reply exemption
-- (only the number that texted the keyword, within 24 h, informational) and the suppressions (the recipient address
-- only) are unchanged. Every other line of the two guards is verbatim from 0021.
--
-- canContact reads the same set through the same function (api repos/gate.ts personDoNotContact,
-- optOutFanoutPhoneHmacs) under the caller's RLS, so for a caller who sees the person's records it refuses first and
-- says why; a caller who does not see them all never reaches the gate for a merged-away record (the API refuses it),
-- and the guard below, which sees every record, still refuses (defence in depth, gateInput.ts GUARD_DENY_REASONS).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * new function app.contact_person_ids(uuid, uuid) RETURNS uuid[]: plain SQL, NOT security definer, STABLE,
--     pinned search_path, explicit tenant filter, schema-qualified tables, writes nothing; CYCLE clauses make both
--     walks terminate even on corrupt data. EXECUTE revoked from PUBLIC and granted to app_user (it runs under the
--     caller's RLS and returns only records the caller can select) and to app_definer (the guards below run it as
--     their owner, which sees every record of the tenant, exactly as they already read contacts and contact_points).
--   * replaces app.messages_dispatch_guard() and app.calls_dispatch_guard() (SECURITY DEFINER, owner app_definer,
--     pinned search_path, trigger bindings unchanged). The only change, marked F1 in each: the do-not-contact check
--     and the phone fan-out read the recipient's whole person instead of the recipient record (and the records merged
--     directly into it). A larger set of records only refuses MORE sends; nothing is allowed that 0021 refused.
-- =============================================================================

-- The records of one person: the root survivor reached from p_contact by following merged_into_contact_id (p_contact
-- itself when it was never merged away), and every record merged into that root, directly or along a chain. Always
-- contains p_contact. Runs as its caller: called by app_user it sees only the records the caller's RLS shows.
CREATE FUNCTION app.contact_person_ids(p_tenant uuid, p_contact uuid)
RETURNS uuid[] LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE up(id, next, depth) AS (
    SELECT c.id, c.merged_into_contact_id, 0 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id = p_contact
    UNION ALL
    SELECT c.id, c.merged_into_contact_id, up.depth + 1
      FROM up JOIN public.contacts c ON c.tenant_id = p_tenant AND c.id = up.next
  ) CYCLE id SET up_cycle USING up_path,
  root AS (SELECT up.id FROM up WHERE NOT up.up_cycle ORDER BY up.depth DESC LIMIT 1),
  person(id) AS (
    SELECT root.id FROM root
    UNION ALL
    SELECT l.id FROM person JOIN public.contacts l ON l.tenant_id = p_tenant AND l.merged_into_contact_id = person.id
  ) CYCLE id SET person_cycle USING person_path
  SELECT ARRAY(SELECT DISTINCT x.id FROM (SELECT person.id FROM person WHERE NOT person.person_cycle UNION SELECT p_contact) x ORDER BY x.id)
$$;
REVOKE ALL ON FUNCTION app.contact_person_ids(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_person_ids(uuid, uuid) TO app_user, app_definer;

-- The two opt-out guards, verbatim from 0021 except the lines marked F1. Trigger bindings are unchanged.
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
                           AND im.direction = 'inbound' AND im.channel = NEW.channel AND im.opt_out_keyword IS NOT NULL
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

  -- Assistant autonomy (R-GATE-4, A3/A7), unchanged from 0013/0014.
  IF NEW.initiator = 'assistant' THEN
    SELECT aa.autonomy, aa.status, aa.decided_by_user_id, aa.playbook_version_id INTO a
      FROM public.assistant_actions aa WHERE aa.tenant_id = NEW.tenant_id AND aa.id = NEW.assistant_action_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASSISTANT_ACTION_MISSING' USING ERRCODE = 'check_violation';
    ELSIF a.autonomy = 'within_playbook' THEN
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
    ELSE
      RAISE EXCEPTION 'ASSISTANT_ACTION_NOT_SENDABLE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.messages_dispatch_guard() OWNER TO app_definer;

CREATE OR REPLACE FUNCTION app.calls_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE own bytea[]; others bytea[]; person uuid[];
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id <> app.tenant_id() THEN RETURN NEW; END IF;
  IF NEW.direction <> 'outbound' OR NEW.imported THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contact_points p
                  WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = NEW.contact_id AND p.kind = 'phone'
                    AND p.address = NEW.client_address) THEN
    RAISE EXCEPTION 'RECIPIENT_NOT_A_CONTACT_POINT: the recipient''s opt-out status cannot be checked' USING ERRCODE = 'check_violation';
  END IF;
  -- F1: the recipient's whole person (a merged-away record is the person its root survivor is)
  person := app.contact_person_ids(NEW.tenant_id, NEW.contact_id);
  IF EXISTS (SELECT 1 FROM public.contacts c
              WHERE c.tenant_id = NEW.tenant_id AND c.do_not_contact_at IS NOT NULL
                AND c.id = ANY (person)) THEN   -- F1: any record of the person
    RAISE EXCEPTION 'PERSON_DO_NOT_CONTACT: this person asked not to be contacted; nobody can call them' USING ERRCODE = 'check_violation';
  END IF;
  own := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                WHERE p.tenant_id = NEW.tenant_id AND p.kind = 'phone' AND p.address = NEW.client_address);
  others := ARRAY(SELECT p.address_hmac FROM public.contact_points p
                   WHERE p.tenant_id = NEW.tenant_id AND p.contact_id = ANY (person) AND p.kind = 'phone'   -- F1: every record of the person
                     -- R-PAR-12: a removed phone still counts unless removed as a confirmed wrong number
                     AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number'));
  IF EXISTS (SELECT 1 FROM public.consent_state cs
              WHERE cs.tenant_id = NEW.tenant_id AND cs.channel = 'voice' AND cs.status = 'revoked'
                AND cs.address_hmac = ANY (own || others)) THEN
    RAISE EXCEPTION 'RECIPIENT_OPTED_OUT: this number asked not to be called; nobody can call it' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppressions s
              WHERE s.tenant_id = NEW.tenant_id AND s.address_hmac = ANY (own) AND s.lifted_at IS NULL
                AND s.channel IN ('all', 'voice')) THEN
    RAISE EXCEPTION 'RECIPIENT_SUPPRESSED: this number is suppressed for voice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.calls_dispatch_guard() OWNER TO app_definer;
