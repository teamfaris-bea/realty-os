-- =============================================================================
-- 0090_b14_review_portal_link_cap: batch 14 review fix B14-PORTAL-R1 (R-TWL-2, R-PORTAL-12; docs/ARCHITECTURE §21.55,
-- SECURITY §20 V11.1). Why schema and not code: the bound must be counted in the send-time transaction exactly as the
-- team's daily cap is (one row per tenant-local day, claimed by INSERT .. ON CONFLICT DO UPDATE .. WHERE under the
-- row lock), so two concurrent sign-in texts at the bound cannot both pass, and a rolled-back TX1 returns its unit.
--
-- The gap: POST /api/portal/login is public. A sign-in link by text (category portal_login_link, initiator system)
-- claimed one unit of the tenant's shared daily telephony cap (0063) like any text, so anyone who knows the team slug
-- (it is in every invite URL) and the phone of a client whose login point is that phone could spend the whole team's
-- budget, after which every outbound text (the agents' replies to leads, other clients' links, AI ISA messages) is
-- refused DAILY_SEND_CAP_REACHED until the tenant's next local day. The portal's limits are per IP, per address and
-- per account (0023), never per tenant.
--
-- The change: telephony_daily_usage.portal_link_sends counts the sign-in texts of the day. comms/dispatch.ts claims a
-- sign-in text with one statement that raises both counters only while sends < telephony_daily_cap AND
-- portal_link_sends < the sign-in share (telephonySafeguards.ts PORTAL_LINK_CAP_PERCENT, an owner default: 10 % of
-- the cap, rounded down, so a cap under 10 leaves sign-in texts none). Over the share the link is blocked
-- PORTAL_LINK_DAILY_CAP_REACHED with a stored decision and the team's budget is not touched; every other text claims
-- `sends` alone, as before. The 0063 guard is replaced so the new counter also only counts up (CHECK: it never exceeds
-- the day's sends, which include it).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * no new table, function, grant, policy or definer: one column with CHECKs on an existing FORCE RLS table (its
--     policies and grants, 0063, cover the column), and CREATE OR REPLACE of 0063's INVOKER trigger function
--     app.telephony_daily_usage_guard (owner and ACL kept; the trigger still points at it).
--   * only narrows: every row the guard refused before is refused now; the one new refusal is a lower
--     portal_link_sends. Existing rows get portal_link_sends = 0.
-- Proof: apps/api/src/portal/signin.test.ts ("b14 review R1"), apps/api/src/comms/telephony.safeguards.test.ts.
-- =============================================================================

ALTER TABLE telephony_daily_usage ADD COLUMN portal_link_sends integer NOT NULL DEFAULT 0
  CHECK (portal_link_sends BETWEEN 0 AND 100000);
ALTER TABLE telephony_daily_usage ADD CONSTRAINT telephony_daily_usage_portal_link_within_sends CHECK (portal_link_sends <= sends);
COMMENT ON COLUMN telephony_daily_usage.portal_link_sends IS
  'b14 review R1: how many of the day''s sends were client sign-in link texts (portal_login_link); bounded by telephonySafeguards.ts PORTAL_LINK_CAP_PERCENT of the cap';

CREATE OR REPLACE FUNCTION app.telephony_daily_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.day IS DISTINCT FROM OLD.day OR NEW.sends < OLD.sends
     OR NEW.portal_link_sends < OLD.portal_link_sends THEN
    RAISE EXCEPTION 'TELEPHONY_USAGE_COUNTS_UP: a day''s send count only grows' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'app.telephony_daily_usage_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0090: app.telephony_daily_usage_guard must stay an invoker';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'telephony_daily_usage_guard' AND tgrelid = 'public.telephony_daily_usage'::regclass
                    AND tgfoid = 'app.telephony_daily_usage_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0090: the telephony_daily_usage_guard trigger must still point at the guard';
  END IF;
END $$;
