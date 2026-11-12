-- =============================================================================
-- 0070 Texting reactions (owner decision D5b, 2026-11-11; R-REACT-2, R-REACT-5; E300–E309). Renumbered at merge.
--
-- A phone that reacts to a text from a sender not on iMessage/RCS sends a text such as `Loved “See you at 3”`. The
-- inbound transaction (apps/api/src/comms/reactions.ts) recognises it only when the whole body is one template form
-- (core/compliance/reactions.ts) and the quote equals the whole body of a text the team sent that same phone; it then
-- classifies the text by its own words only and records the link here. VERIFY WITH COUNSEL (R-CONSENT-8,
-- R-CONSENT-11, R-CHAN-3 are narrowed only for quoted words provably the team's own).
--
-- message_reactions: one row per linked reaction text, written once by the system inside the inbound transaction,
-- never updated, deleted only by cascade with either message (erasure, merge clean-up, import revert need nothing
-- more). Staff Layer 1 with FORCE RLS; readable exactly by those who can read the reaction message (EXISTS on
-- messages, as media_select); inserted only by the system; no UPDATE or DELETE grant or policy.
--
-- The invoker trigger app.message_reactions_guard re-checks the API's candidate bounds (R-REACT-2): the reaction row
-- is an inbound, non-imported SMS; the target a non-imported outbound sms/mms on the same contact, sent from the
-- number the reaction came in on to the reaction's sender, at least dispatching and not failed, dispatched before
-- the reaction and created in the 30 days before it. A NULL actor is refused (COALESCE form of 0030:240).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4): no SECURITY DEFINER function. New invoker trigger function
-- app.message_reactions_guard() (EXECUTE revoked from PUBLIC; a trigger needs no grant to fire): reads the two
-- messages under the caller's RLS (the system reads its tenant's rows) and raises or returns NEW. New table with
-- FORCE RLS, RESTRICTIVE tenant isolation, the support_read_only policies and statement trigger, a SELECT policy
-- through the message and a system-only INSERT policy. Grants: SELECT, INSERT to app_user only.
-- =============================================================================

CREATE TABLE message_reactions (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL,
  message_id         uuid NOT NULL,                     -- the reaction text (inbound)
  target_message_id  uuid NOT NULL,                     -- the team's text it quotes (outbound)
  action             text NOT NULL CHECK (action IN ('add','remove')),
  reaction           text NOT NULL CHECK (reaction IN ('love','like','dislike','laugh','emphasize','question','sticker','emoji')),
  emoji              text CHECK (emoji IS NULL OR char_length(emoji) BETWEEN 1 AND 16),
  whole_text_reading text NOT NULL CHECK (whole_text_reading IN ('none','stop','start','help','wrong_number','opt_out_language')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, message_id),
  CHECK ((reaction = 'emoji') = (emoji IS NOT NULL)),
  FOREIGN KEY (tenant_id, message_id)        REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX message_reactions_target_idx ON message_reactions (tenant_id, target_message_id);

-- -----------------------------------------------------------------------------
-- Guard (invoker): system only; the link only within R-REACT-2's bounds.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.message_reactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR r.contact_id <> t.contact_id
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
CREATE TRIGGER message_reactions_guard BEFORE INSERT ON message_reactions
  FOR EACH ROW EXECUTE FUNCTION app.message_reactions_guard();

-- -----------------------------------------------------------------------------
-- Row-level security (Layer 1 as 0040) and grants
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_reactions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
  END LOOP;
END $$;

-- read through the message (as media_select); only the system inserts; no UPDATE/DELETE policy or grant
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (EXISTS (
  SELECT 1 FROM messages m WHERE m.tenant_id = message_reactions.tenant_id AND m.id = message_reactions.message_id));
CREATE POLICY message_reactions_insert ON message_reactions FOR INSERT WITH CHECK ((SELECT app.actor_kind()) = 'system');

-- the statement-level support write block (0016) every public table carries
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON message_reactions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

GRANT SELECT, INSERT ON message_reactions TO app_user;
