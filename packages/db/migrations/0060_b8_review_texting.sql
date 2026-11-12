-- =============================================================================
-- Batch 8 interaction review, texting group (b8 texting ownership-data/F6; R-REACT-2, R-REACT-3, R-OWN-24, E301).
-- The orchestrator renumbers this file at merge.
--
-- A Team Lead's merge moves the loser's messages to the survivor later, in its ownership.followup job (an Owner's or
-- Admin's merge moves them inline). In between, an inbound text from the person's phone resolves to the survivor while
-- the team's text it quotes still sits on the loser. 0056's guard required the reaction and its target on the SAME
-- contact, so the tapback was not linked and its whole body, quote included, was classified: a quoted "no more
-- texts" became the person's own opt-out (a false person-level do-not-contact). The candidate query
-- (apps/api/src/comms/reactions.ts) and this guard now both accept a target on any record of the reaction's person,
-- app.contact_person_ids (0043): the root survivor and every record merged into it. Every other bound is unchanged:
-- the team's own text, sent from the number the reaction came in on to the very phone that reacted, at least
-- dispatching and not failed, dispatched before the reaction, created in the 30 days before it.
--
-- CREATE OR REPLACE of app.message_reactions_guard: its only definition is 0056_sms_reactions.sql; this body is that
-- one verbatim except the line marked F6 (r.contact_id <> t.contact_id → NOT t.contact_id = ANY(person)).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4): no SECURITY DEFINER function, no new table, policy or grant. The guard stays
-- an invoker trigger function (EXECUTE revoked from PUBLIC, re-stated). app.contact_person_ids is invoker SQL (0043)
-- that reads contacts under the caller's RLS; the guard runs only for the system (REACTION_SYSTEM_ONLY first), which
-- sees its own tenant's rows and no other tenant's.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.message_reactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r public.messages%ROWTYPE;
  t public.messages%ROWTYPE;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT COALESCE(app.actor_kind() = 'system', false) THEN
    RAISE EXCEPTION 'REACTION_SYSTEM_ONLY: only inbound ingestion (the system) links a reaction text'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM public.messages WHERE tenant_id = NEW.tenant_id AND id = NEW.message_id;
  SELECT * INTO t FROM public.messages WHERE tenant_id = NEW.tenant_id AND id = NEW.target_message_id;
  IF r.id IS NULL OR t.id IS NULL
     OR r.direction <> 'inbound' OR r.channel <> 'sms' OR r.imported
     OR t.direction <> 'outbound' OR t.channel NOT IN ('sms','mms') OR t.imported
     OR NOT (t.contact_id = ANY (app.contact_person_ids(NEW.tenant_id, r.contact_id)))   -- F6: any record of the person
     OR t.to_address <> r.from_address
     OR t.phone_number_id IS DISTINCT FROM r.phone_number_id OR r.phone_number_id IS NULL
     OR t.status NOT IN ('dispatching','sent','delivered','dispatch_unknown')
     OR t.dispatched_at IS NULL OR t.dispatched_at > r.occurred_at
     OR t.occurred_at < r.occurred_at - interval '30 days' THEN
    RAISE EXCEPTION 'REACTION_TARGET_INVALID: a reaction links only an inbound SMS to a text the team sent that phone from that number in the 30 days before'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.message_reactions_guard() FROM PUBLIC;
