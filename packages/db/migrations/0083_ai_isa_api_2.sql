-- =============================================================================
-- 0083_ai_isa_api_2: lane ISA-2b (module 75; owner decision D12 PROPOSED, docs/AI_ISA.md §5.3, §5.4): what its
-- placeholder 0192 added to the guard's holiday rule that 0081 does not already hold (R-ISA-10). The feature stays
-- dark: platform:ai_isa uncleared, AI_ISA_LIVE_SENDS=false.
--
-- Reconciled at batch 13. 0192 was written on 0080 (lane number 0190): it created app.ai_isa_us_federal_holiday and
-- replaced app.ai_isa_send_check with 0080's body verbatim plus a holiday refusal. Batch 12's review migration 0081
-- since created the same holiday function (B12X-6; equal to core usFederalHolidays, proved on 2020-2045) and replaced
-- the send check (the person-block clause, db-isa-merge-1, and a holiday refusal for the derived tier). So 0192's
-- CREATE FUNCTION would fail ('already exists') and its verbatim 0080 body would bring back
-- `AND b.created_at >= asg.started_at` and silently undo db-isa-merge-1. What remains of 0192, applied to 0081's
-- body (the newest; no later migration replaces the send check):
--
--  1. The zone loop's weekday check and holiday check run when `t.message_kind = 'initiated' OR tier = 'initiated'`
--     (0081: the derived tier alone), as TX1 (isa/send.ts) and core count the turn's kind too: a message the turn
--     planned as initiated never goes out on a non-initiated day or a federal holiday because the person wrote
--     recently. The refusal texts stay 0081's (deferrable ISA_QUIET_HOURS); 0192's second holiday refusal is not added.
--  2. EXECUTE on app.ai_isa_us_federal_holiday only for app_definer, as 0192 granted it: its only caller is the send
--     check, which runs inside app.messages_dispatch_guard (SECURITY DEFINER, owner app_definer); 0081 also granted
--     app_user, which no path needs. Its body is 0081's, unchanged.
--
-- Everything else in app.ai_isa_send_check is 0081's body verbatim (the two lines marked "0083" differ).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; docs/ARCHITECTURE.md §21.45): no new function, table, column, policy or
-- SECURITY DEFINER. One REVOKE (app_user loses EXECUTE on the holiday function). app.ai_isa_send_check replaced
-- (invoker; trigger bindings unchanged; EXECUTE still only app_definer): two conditions widened, each refusing more,
-- never less.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION app.ai_isa_us_federal_holiday(date) FROM app_user;

-- 0081's send check verbatim except the two zone-loop conditions (marked 0083)
CREATE OR REPLACE FUNCTION app.ai_isa_send_check(m public.messages) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE
  aa record; t record; asg record; c record; ts record; pack jsonb; person uuid[]; bound_id uuid; ch text; pk text;
  hmacs bytea[]; live boolean; post boolean; has_facts boolean; reply_ok boolean; tier text; minz text[]; z text;
  wstart time; wend time; caps jsonb; n_ai int; n_auto int; n_init24 int; n_init7 int; last_ai timestamptz; d12 timestamptz;
  v_day date; got int; ok boolean; lt timestamp; isa_cats text[] := ARRAY['ai_isa_message','ai_isa_confirmation','ai_isa_holding_line'];
  counted text[] := ARRAY['dispatching','dispatch_unknown','sent','delivered','failed','undelivered'];
BEGIN
  SELECT x.kind, x.status, x.contact_id, x.pinned_inbound_seq, x.epoch, x.ai_isa_turn_id, x.action_category, x.playbook_version_id
    INTO aa FROM public.assistant_actions x WHERE x.tenant_id = m.tenant_id AND x.id = m.assistant_action_id;
  -- ---- binding ----
  IF aa.kind IS DISTINCT FROM 'ai_isa_message' OR aa.status IS DISTINCT FROM 'proposed' THEN
    RAISE EXCEPTION 'ASSISTANT_ACTION_WITHDRAWN: this AI assistant message was withdrawn before it went out' USING ERRCODE = 'check_violation';
  END IF;
  IF m.action_category IS DISTINCT FROM aa.action_category OR NOT (m.action_category = ANY (isa_cats)) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the message category is not an AI assistant category' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO t FROM public.ai_isa_turns x WHERE x.tenant_id = m.tenant_id AND x.id = aa.ai_isa_turn_id;
  IF NOT FOUND OR t.message_id IS DISTINCT FROM m.id OR t.assistant_action_id IS DISTINCT FROM m.assistant_action_id THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the message is not bound to its turn' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO asg FROM public.ai_isa_assignments x WHERE x.tenant_id = m.tenant_id AND x.id = t.assignment_id;
  IF NOT FOUND OR aa.contact_id IS DISTINCT FROM m.contact_id OR asg.contact_id IS DISTINCT FROM m.contact_id THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the message is not for the person under AI care' USING ERRCODE = 'check_violation';
  END IF;
  IF m.purpose IS DISTINCT FROM 'marketing' OR t.purpose IS DISTINCT FROM 'marketing' THEN
    RAISE EXCEPTION 'ISA_PURPOSE_MISMATCH: AI assistant messages are sent as marketing' USING ERRCODE = 'check_violation';
  END IF;
  IF m.channel NOT IN ('sms','email') OR t.channel IS DISTINCT FROM m.channel THEN
    RAISE EXCEPTION 'ISA_CHANNEL_NOT_ALLOWED: the AI assistant texts and emails only' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message_media mm WHERE mm.tenant_id = m.tenant_id AND mm.message_id = m.id) THEN
    RAISE EXCEPTION 'ISA_CHANNEL_NOT_ALLOWED: the AI assistant never sends media' USING ERRCODE = 'check_violation';
  END IF;
  IF encode(sha256(convert_to(m.body, 'UTF8')), 'hex') IS DISTINCT FROM t.body_sha256 THEN
    RAISE EXCEPTION 'ISA_BODY_CHANGED: the message text changed after the turn froze it' USING ERRCODE = 'check_violation';
  END IF;
  ch := m.channel; pk := CASE WHEN ch = 'sms' THEN 'phone' ELSE 'email' END;
  bound_id := NULLIF(asg.bound_points -> ch ->> 'point_id', '')::uuid;
  IF bound_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.contact_points p
                                      WHERE p.tenant_id = m.tenant_id AND p.id = bound_id AND p.contact_id = asg.contact_id
                                        AND p.kind = pk AND p.address = m.to_address AND p.removed_at IS NULL
                                        AND encode(p.address_hmac, 'hex') = asg.bound_points -> ch ->> 'hmac') THEN
    RAISE EXCEPTION 'ISA_UNBOUND_RECIPIENT: AI assistant messages go only to the address bound at start' USING ERRCODE = 'check_violation';
  END IF;

  person := app.contact_person_ids(m.tenant_id, asg.contact_id);
  hmacs := ARRAY(SELECT DISTINCT p.address_hmac FROM public.contact_points p
                  WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person)
                    AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number') ORDER BY 1);

  -- ---- liveness: live care, or the post-handoff closed set ----
  live := asg.ended_at IS NULL;
  post := NOT live AND m.action_category IN ('ai_isa_confirmation','ai_isa_holding_line');
  IF EXISTS (SELECT 1 FROM public.ai_isa_stop_signals s WHERE s.tenant_id = m.tenant_id AND s.created_at >= asg.started_at
               AND (s.address_hmac = ANY (hmacs) OR s.contact_id = ANY (person)))
     -- b12 review db-isa-merge-1: every unlifted block of the person, whenever it was written (lifts are explicit)
     OR EXISTS (SELECT 1 FROM public.ai_isa_person_blocks b WHERE b.tenant_id = m.tenant_id AND b.contact_id = ANY (person) AND b.lifted_at IS NULL) THEN
    RAISE EXCEPTION 'ISA_STOPPED: an opt-out, suppression or do-not-contact stopped AI care' USING ERRCODE = 'check_violation';
  END IF;
  IF live THEN
    IF asg.paused_at IS NOT NULL THEN
      RAISE EXCEPTION 'ISA_PAUSED: AI care is paused' USING ERRCODE = 'check_violation';
    END IF;
    IF aa.epoch IS DISTINCT FROM asg.epoch THEN
      RAISE EXCEPTION 'ISA_STALE_EPOCH: AI care was paused and resumed after this message was written' USING ERRCODE = 'check_violation';
    END IF;
    IF aa.pinned_inbound_seq IS DISTINCT FROM (SELECT cv.inbound_seq FROM public.conversations cv WHERE cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id) THEN
      RAISE EXCEPTION 'ISA_STALE_REPLY: the person wrote again after this message was written' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF post THEN
    IF NOT EXISTS (SELECT 1 FROM public.ai_isa_handoffs h WHERE h.tenant_id = m.tenant_id AND h.assignment_id = asg.id AND h.pending_message_id = m.id)
       OR EXISTS (SELECT 1 FROM public.ai_isa_handoffs h JOIN public.messages hm ON hm.tenant_id = h.tenant_id
                   WHERE h.tenant_id = m.tenant_id AND h.assignment_id = asg.id AND hm.contact_id = ANY (person)
                     AND hm.direction = 'outbound' AND hm.initiator = 'human' AND hm.created_at > h.created_at
                     AND hm.status NOT IN ('canceled','blocked'))
       OR EXISTS (SELECT 1 FROM public.ai_isa_handoffs h JOIN public.calls cl ON cl.tenant_id = h.tenant_id
                   WHERE h.tenant_id = m.tenant_id AND h.assignment_id = asg.id AND cl.contact_id = ANY (person) AND cl.created_at > h.created_at) THEN
      RAISE EXCEPTION 'ISA_HANDOFF_CLOSED: after a handoff only its pending confirmation or holding line may go, until a person takes over'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'ISA_PAUSED: AI care has ended' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- the chain (§3.1 links 2–6) ----
  SELECT j.rules INTO pack FROM public.jurisdiction_packs j WHERE j.key = 'platform:ai_isa' AND j.status = 'published';
  SELECT s.ai_enabled, s.ai_isa_enabled, s.ai_isa_daily_cap, s.default_timezone, s.team_name, s.brokerage_legal_name
    INTO ts FROM public.tenant_settings s WHERE s.tenant_id = m.tenant_id;
  IF NOT app.platform_cleared('platform:ai_isa') OR pack IS NULL THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: platform:ai_isa is not cleared by counsel' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(ts.ai_enabled, false) OR NOT COALESCE(ts.ai_isa_enabled, false) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the AI assistant is off for this team' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT live THEN NULL;  -- post-handoff: the policy and opt-in may have moved on; the confirmation was approved at handoff
  ELSIF NOT EXISTS (
      SELECT 1 FROM public.playbook_versions v
       WHERE v.tenant_id = m.tenant_id AND v.id = asg.playbook_version_id
         AND ((v.status = 'approved'
               AND (SELECT pa.decision = 'approve' AND pa.content_sha256 = v.content_sha256 FROM public.playbook_approvals pa
                     WHERE pa.tenant_id = v.tenant_id AND pa.playbook_version_id = v.id ORDER BY pa.decided_at DESC LIMIT 1))
              OR (v.status = 'superseded'
                  AND NOT EXISTS (SELECT 1 FROM public.playbook_versions w WHERE w.tenant_id = v.tenant_id AND w.playbook_id = v.playbook_id
                                    AND w.version_no > v.version_no AND w.status IN ('approved','superseded','revoked')
                                    AND (w.status = 'revoked' OR w.narrows_previous IS NOT TRUE))
                  AND EXISTS (SELECT 1 FROM public.playbook_versions w WHERE w.tenant_id = v.tenant_id AND w.playbook_id = v.playbook_id
                                AND w.version_no > v.version_no AND w.status = 'approved')))) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the team''s AI assistant policy is not approved' USING ERRCODE = 'check_violation';
  ELSIF NOT EXISTS (SELECT 1 FROM public.ai_isa_agent_optins o WHERE o.tenant_id = m.tenant_id AND o.id = asg.optin_id AND o.status = 'active'
                      AND o.user_id = asg.owner_user_id AND o.attestation_sha256 = encode(sha256(convert_to(o.attestation, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the agent''s AI assistant opt-in is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ct.owner_user_id, ct.ownership_period_seq, ct.merged_into_contact_id, ct.deleted_at, ct.timezone, ct.timezone_source
    INTO c FROM public.contacts ct WHERE ct.tenant_id = m.tenant_id AND ct.id = asg.contact_id;
  IF live AND (c.owner_user_id IS DISTINCT FROM asg.owner_user_id OR c.ownership_period_seq IS DISTINCT FROM asg.bound_ownership_seq
               OR c.merged_into_contact_id IS NOT NULL OR c.deleted_at IS NOT NULL
               OR NOT EXISTS (SELECT 1 FROM public.memberships mb WHERE mb.tenant_id = m.tenant_id AND mb.user_id = asg.owner_user_id AND mb.status = 'active')) THEN
    RAISE EXCEPTION 'ISA_NOT_AUTHORIZED: the lead''s owner or ownership period changed' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- shared address and active client (R-ISA-2) ----
  IF EXISTS (SELECT 1 FROM public.contact_points p JOIN public.contacts o ON o.tenant_id = p.tenant_id AND o.id = p.contact_id
              WHERE p.tenant_id = m.tenant_id AND p.address_hmac = ANY (hmacs) AND p.removed_at IS NULL
                AND NOT (p.contact_id = ANY (person)) AND o.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ISA_SHARED_ADDRESS: another person shares this address' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.deal_contacts dc JOIN public.deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
              WHERE dc.tenant_id = m.tenant_id AND dc.contact_id = ANY (person) AND d.stage NOT IN ('closed','lost'))
     OR EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = m.tenant_id AND d.primary_contact_id = ANY (person) AND d.stage NOT IN ('closed','lost'))
     OR EXISTS (SELECT 1 FROM public.listing_contacts lc JOIN public.listings l ON l.tenant_id = lc.tenant_id AND l.id = lc.listing_id
                 WHERE lc.tenant_id = m.tenant_id AND lc.contact_id = ANY (person) AND l.source = 'team'
                   AND l.status IN ('coming_soon','active','pending')) THEN
    RAISE EXCEPTION 'ISA_ACTIVE_CLIENT: this person is a client on an open deal or an active listing' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- an unread MMS text part of an inbound since care started ----
  IF EXISTS (SELECT 1 FROM public.message_text_parts tp JOIN public.messages im ON im.tenant_id = tp.tenant_id AND im.id = tp.message_id
              WHERE tp.tenant_id = m.tenant_id AND im.conversation_id = m.conversation_id AND im.direction = 'inbound'
                AND im.created_at >= asg.started_at AND tp.status = 'pending') THEN
    RAISE EXCEPTION 'ISA_UNREAD_PART: a message part from the person has not been read yet' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- seller packs (12g) ----
  has_facts := EXISTS (SELECT 1 FROM public.ai_isa_shared_facts f WHERE f.tenant_id = m.tenant_id AND f.message_id = m.id);
  IF EXISTS (SELECT 1 FROM public.ai_isa_shared_facts f WHERE f.tenant_id = m.tenant_id AND f.message_id = m.id AND f.fact_kind IN ('sold_comp_set','nearby_sale'))
     AND NOT (app.platform_cleared('platform:cma') AND app.platform_cleared('platform:ai_isa_seller_data')) THEN
    RAISE EXCEPTION 'ISA_SELLER_DATA_NOT_CLEARED: recent sales wait on counsel review of platform:cma and platform:ai_isa_seller_data' USING ERRCODE = 'check_violation';
  END IF;

  -- ---- consent evidence, re-derived (R-ISA-9) ----
  -- a revoke of either purpose on any of the person's points of this channel blocks every AI message on it
  IF EXISTS (SELECT 1 FROM public.consent_state cs JOIN public.contact_points p ON p.tenant_id = cs.tenant_id AND p.address_hmac = cs.address_hmac
              WHERE cs.tenant_id = m.tenant_id AND cs.channel = ch AND cs.status = 'revoked' AND p.contact_id = ANY (person) AND p.kind = pk
                AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number')) THEN
    RAISE EXCEPTION 'ISA_CONSENT_EVIDENCE_MISSING: this person opted out on this channel' USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(om.dispatched_at) INTO last_ai FROM public.messages om
   WHERE om.tenant_id = m.tenant_id AND om.conversation_id = m.conversation_id AND om.channel = ch AND om.id <> m.id
     AND om.initiator = 'assistant' AND om.action_category = ANY (isa_cats) AND om.status = ANY (counted);
  reply_ok := EXISTS (SELECT 1 FROM public.messages im
                       WHERE im.tenant_id = m.tenant_id AND im.conversation_id = m.conversation_id AND im.direction = 'inbound'
                         AND im.channel = ch AND im.from_address = m.to_address AND NOT im.is_auto_reply
                         AND im.created_at >= now() - make_interval(hours => COALESCE((pack->>'reply_window_hours')::int, 24))
                         AND im.created_at > COALESCE(last_ai, '-infinity'::timestamptz)
                         AND (ch <> 'email' OR im.email_dkim_aligned IS TRUE));
  tier := CASE WHEN reply_ok AND NOT has_facts THEN 'reply' ELSE 'initiated' END;
  IF t.message_kind = 'reply' AND tier = 'initiated' AND NOT has_facts THEN
    RAISE EXCEPTION 'ISA_REPLY_WINDOW_CLOSED: the reply window of the person''s own message has closed' USING ERRCODE = 'check_violation';
  END IF;
  IF tier = 'initiated' THEN
    d12 := NULLIF(pack->>'d12_effective_at', '')::timestamptz;
    ok := d12 IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.consent_events g
        LEFT JOIN public.consent_disclosures d ON d.tenant_id = g.tenant_id AND d.id = g.disclosure_id
       WHERE g.tenant_id = m.tenant_id AND g.event_type = 'grant' AND g.channel = ch AND g.purpose IN ('marketing','all')
         AND g.address_hmac = decode(asg.bound_points -> ch ->> 'hmac', 'hex')
         AND NOT g.imported AND g.source <> 'agent_entry' AND g.needs_review IS NOT TRUE
         AND (CASE WHEN ch = 'sms' THEN g.consent_level = 'express_written' ELSE g.consent_level IN ('inquiry','express','express_written') END)
         AND (g.expires_at IS NULL OR g.expires_at > now())
         AND (g.occurred_at >= d12 OR g.source = 'signed_document')
         AND ((g.source = 'signed_document' AND g.evidence_object_id IS NOT NULL)
              OR (d.id IS NOT NULL AND d.scope_stated IS TRUE AND ch = ANY (d.channel_scope) AND 'marketing' = ANY (d.purpose_scope)
                  AND EXISTS (SELECT 1 FROM public.lead_inquiries li WHERE li.tenant_id = d.tenant_id AND li.consent_disclosure_id = d.id
                                AND li.contact_id = ANY (person))
                  AND NOT EXISTS (SELECT 1 FROM public.lead_sources ls WHERE ls.tenant_id = d.tenant_id AND ls.consent_disclosure_id = d.id)
                  AND ((length(btrim(COALESCE(ts.team_name, ''))) > 0 AND position(lower(ts.team_name) IN lower(d.body)) > 0)
                       OR position(lower(ts.brokerage_legal_name) IN lower(d.body)) > 0)))
         AND NOT EXISTS (SELECT 1 FROM public.consent_events r
                          WHERE r.tenant_id = g.tenant_id AND r.channel = ch AND r.event_type IN ('revoke','expire','import_revert')
                            AND r.occurred_at > g.occurred_at
                            AND r.address_hmac = ANY (ARRAY(SELECT p.address_hmac FROM public.contact_points p
                                                             WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person) AND p.kind = pk))));
    IF NOT ok THEN
      RAISE EXCEPTION 'ISA_CONSENT_EVIDENCE_MISSING: initiated AI messages and facts need written consent from the person''s own form'
        USING ERRCODE = 'check_violation';
    END IF;
    IF ch = 'sms' AND NOT EXISTS (SELECT 1 FROM public.dnc_checks k
                                   WHERE k.tenant_id = m.tenant_id AND k.phone_hmac = decode(asg.bound_points -> 'sms' ->> 'hmac', 'hex')
                                     AND k.listed = false AND k.registry = 'us_national' AND k.valid_until > now()
                                     AND k.checked_at >= now() - make_interval(days => COALESCE((pack->>'dnc_freshness_days')::int, 31))) THEN
      RAISE EXCEPTION 'ISA_DNC_UNVERIFIED: an initiated AI text needs a fresh national Do Not Call result' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ---- quiet hours (R-ISA-10): the turn's zones cover the DB-derived minimum set; every zone is inside the window ----
  IF c.timezone_source = 'explicit' AND c.timezone IS NOT NULL THEN
    minz := ARRAY[c.timezone];
  ELSE
    minz := ARRAY(SELECT DISTINCT zz FROM (
      SELECT jsonb_array_elements_text(COALESCE(pack->'continental_zones', '[]')) AS zz
      UNION SELECT ts.default_timezone
      UNION SELECT acz.zone FROM public.contact_points p JOIN public.ai_isa_area_code_zones acz ON acz.area_code = substr(p.address, 3, 3)
             WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person) AND p.kind = 'phone' AND p.address LIKE '+1%'
      UNION SELECT p.timezone FROM public.contact_points p WHERE p.tenant_id = m.tenant_id AND p.contact_id = ANY (person) AND p.timezone IS NOT NULL
      UNION SELECT sz.zone FROM public.contact_addresses ca JOIN public.ai_isa_state_zones sz ON sz.state = upper(ca.region)
             WHERE ca.tenant_id = m.tenant_id AND ca.contact_id = ANY (person)) q WHERE zz IS NOT NULL);
  END IF;
  IF t.zones IS NULL OR NOT (minz <@ t.zones) THEN
    RAISE EXCEPTION 'ISA_ZONE_UNRESOLVED: the turn''s time zones do not cover every zone the person may be in' USING ERRCODE = 'check_violation';
  END IF;
  wstart := greatest(t.window_start, COALESCE((pack #>> '{window_ceiling,start}')::time, '08:00'));
  wend := least(t.window_end, COALESCE((pack #>> '{window_ceiling,end}')::time, '20:00'));
  FOREACH z IN ARRAY t.zones LOOP
    lt := now() AT TIME ZONE z;
    IF NOT (lt::time >= wstart AND lt::time < wend) THEN
      RAISE EXCEPTION 'ISA_QUIET_HOURS: it is outside the send window in %', z USING ERRCODE = 'check_violation';
    END IF;
    -- 0083 (ISA-2b, R-ISA-10): the weekday and holiday checks run by the turn's kind OR the derived tier, as TX1 does
    IF (t.message_kind = 'initiated' OR tier = 'initiated') AND NOT (extract(isodow FROM lt)::int IN (SELECT jsonb_array_elements_text(COALESCE(pack->'initiated_days', '[1,2,3,4,5,6]'))::int)) THEN
      RAISE EXCEPTION 'ISA_QUIET_HOURS: initiated AI messages wait for a permitted day in %', z USING ERRCODE = 'check_violation';
    END IF;
    -- b12 review B12X-6 (§5.4): never on a US federal holiday in any zone (the team policy must set noInitiatedOnHolidays)
    IF (t.message_kind = 'initiated' OR tier = 'initiated') AND app.ai_isa_us_federal_holiday(lt::date) THEN  -- 0083
      RAISE EXCEPTION 'ISA_QUIET_HOURS: initiated AI messages wait past a federal holiday in %', z USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- ---- caps (R-ISA-11): sorted per-address locks, then counts across all the person's addresses ----
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_isa.send:' || m.tenant_id::text || ':' || encode(h, 'hex'), 0)) FROM unnest(hmacs) h ORDER BY h;
  caps := COALESCE(pack->'caps', '{}');
  SELECT count(*) FILTER (WHERE om.initiator = 'assistant' AND om.action_category = ANY (isa_cats)),
         count(*) FILTER (WHERE om.initiator IN ('assistant','system') OR om.bulk_action_id IS NOT NULL OR om.marketing_piece_id IS NOT NULL),
         max(om.dispatched_at) FILTER (WHERE om.initiator = 'assistant' AND om.action_category = ANY (isa_cats))
    INTO n_ai, n_auto, last_ai
    FROM public.messages om
   WHERE om.tenant_id = m.tenant_id AND om.contact_id = ANY (person) AND om.direction = 'outbound' AND om.id <> m.id
     AND om.status = ANY (counted) AND om.dispatched_at >= now() - interval '24 hours';
  IF n_ai >= COALESCE((caps->>'ai24h')::int, 3) OR n_auto >= COALESCE((caps->>'automated24h')::int, 3) THEN
    RAISE EXCEPTION 'ISA_CAP_REACHED: this person had the most messages allowed in 24 hours' USING ERRCODE = 'check_violation';
  END IF;
  IF last_ai IS NOT NULL AND last_ai > now() - make_interval(secs => COALESCE((caps->>'min_gap_seconds')::int, 120)) THEN
    RAISE EXCEPTION 'ISA_MIN_GAP: AI assistant messages are spaced at least two minutes apart' USING ERRCODE = 'check_violation';
  END IF;
  IF t.message_kind = 'initiated' OR tier = 'initiated' THEN
    SELECT count(*) FILTER (WHERE om.dispatched_at >= now() - interval '24 hours'), count(*) INTO n_init24, n_init7
      FROM public.messages om JOIN public.ai_isa_turns tt ON tt.tenant_id = om.tenant_id AND tt.message_id = om.id
     WHERE om.tenant_id = m.tenant_id AND om.contact_id = ANY (person) AND om.id <> m.id AND om.status = ANY (counted)
       AND tt.message_kind = 'initiated' AND om.dispatched_at >= now() - interval '7 days';
    IF n_init24 >= COALESCE((caps->>'initiated24h')::int, 1) OR n_init7 >= COALESCE((caps->>'initiated7d')::int, 3) THEN
      RAISE EXCEPTION 'ISA_CAP_REACHED: initiated AI messages are limited per day and week' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_day := (now() AT TIME ZONE ts.default_timezone)::date;
  INSERT INTO public.ai_isa_daily_counts AS dc (tenant_id, local_day, n)
  SELECT m.tenant_id, v_day, 1 WHERE ts.ai_isa_daily_cap >= 1
  ON CONFLICT (tenant_id, local_day) DO UPDATE SET n = dc.n + 1 WHERE dc.n < ts.ai_isa_daily_cap
  RETURNING dc.n INTO got;
  IF got IS NULL THEN
    RAISE EXCEPTION 'ISA_CAP_REACHED: the team''s daily AI assistant limit is reached' USING ERRCODE = 'check_violation';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.ai_isa_send_check(public.messages) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_isa_send_check(public.messages) TO app_definer;

-- Self-check (0192's, re-based): the dispatch guard keeps its shape and its rules (0080's isa-2-2 body is still the
-- newest), the send check and the holiday function run only inside it, the widened conditions are in place, and
-- db-isa-merge-1 (0081) is not undone.
DO $$
DECLARE src text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'app.messages_dispatch_guard()'::regprocedure
              AND (pg_get_userbyid(p.proowner) <> 'app_definer' OR NOT p.prosecdef
                   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                   OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION '0083 self-check failed: messages_dispatch_guard definer shape changed';
  END IF;
  IF (SELECT position('app.contact_person_ids' IN p.prosrc) = 0 OR position('wrong_number' IN p.prosrc) = 0
             OR position('MARKETING_PIECE_NOT_APPROVED' IN p.prosrc) = 0 OR position('ASSISTANT_ACTION_WITHDRAWN' IN p.prosrc) = 0
             OR position('im.from_address = NEW.to_address' IN p.prosrc) = 0
             OR position('NEW.channel = ''sms'' AND im.channel = ''mms''' IN p.prosrc) = 0
             OR position('app.ai_isa_send_check(NEW)' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'app.messages_dispatch_guard()'::regprocedure) THEN
    RAISE EXCEPTION '0083 self-check failed: messages_dispatch_guard lost a rule';
  END IF;
  IF has_function_privilege('app_user', 'app.ai_isa_send_check(public.messages)', 'EXECUTE') THEN
    RAISE EXCEPTION '0083 self-check failed: ai_isa_send_check must run only inside the guard';
  END IF;
  IF has_function_privilege('app_user', 'app.ai_isa_us_federal_holiday(date)', 'EXECUTE')
     OR has_function_privilege('public', 'app.ai_isa_us_federal_holiday(date)', 'EXECUTE')
     OR NOT has_function_privilege('app_definer', 'app.ai_isa_us_federal_holiday(date)', 'EXECUTE') THEN
    RAISE EXCEPTION '0083 self-check failed: ai_isa_us_federal_holiday must run only inside the guard';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'app.ai_isa_send_check(public.messages)'::regprocedure;
  IF position('(t.message_kind = ''initiated'' OR tier = ''initiated'') AND app.ai_isa_us_federal_holiday(lt::date)' IN src) = 0
     OR position('(t.message_kind = ''initiated'' OR tier = ''initiated'') AND NOT (extract(isodow FROM lt)::int IN' IN src) = 0
     OR position('IF tier = ''initiated'' AND app.ai_isa_us_federal_holiday' IN src) > 0
     OR position('IF tier = ''initiated'' AND NOT (extract(isodow FROM lt)' IN src) > 0 THEN
    RAISE EXCEPTION '0083 self-check failed: the weekday or holiday check does not run by the turn kind';
  END IF;
  IF position('b.created_at >= asg.started_at' IN src) > 0
     OR position('b.contact_id = ANY (person) AND b.lifted_at IS NULL) THEN' IN src) = 0 THEN
    RAISE EXCEPTION '0083 self-check failed: the send check lost 0081''s person-block clause (db-isa-merge-1)';
  END IF;
END $$;
