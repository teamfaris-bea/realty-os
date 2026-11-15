-- End polling without asserting non-delivery. Preserve existing function ownership and grants.
CREATE OR REPLACE FUNCTION app.due_work(p_now timestamptz, p_limit integer)
RETURNS TABLE (tenant_id uuid, work_kind text, ref_id uuid, due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  (SELECT c.tenant_id, 'offer_expiry', c.id, c.offer_expires_at FROM public.contacts c
    WHERE c.ownership_state = 'offered' AND c.offer_expires_at <= p_now ORDER BY c.offer_expires_at LIMIT p_limit)
  UNION ALL
  (SELECT c.tenant_id, 'first_touch_breach', c.id, c.first_touch_due_at FROM public.contacts c
    WHERE c.ownership_state = 'owned' AND c.first_touch_at IS NULL AND c.first_touch_breached_at IS NULL
      AND c.first_touch_due_at <= p_now ORDER BY c.first_touch_due_at LIMIT p_limit)
  UNION ALL
  (SELECT c.tenant_id, 'auto_release', c.id, c.release_due_at FROM public.contacts c
    WHERE c.ownership_state = 'owned' AND c.first_touch_at IS NULL AND c.release_due_at <= p_now
    ORDER BY c.release_due_at LIMIT p_limit)
  UNION ALL
  (SELECT c.tenant_id, 'inactivity', c.id, LEAST(c.inactivity_warn_at, c.inactivity_release_at)
     FROM public.contacts c
    WHERE c.ownership_state = 'owned' AND c.stage IN ('new','attempting')
      -- F6: stored instants only (computed by core when ownership started / at the last human touch);
      -- a settings change never moves an existing deadline
      AND (c.inactivity_warn_at <= p_now OR c.inactivity_release_at <= p_now)
      AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = c.id
                         AND d.stage NOT IN ('closed','lost'))
      AND NOT EXISTS (SELECT 1 FROM public.deal_contacts dc JOIN public.deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
                       WHERE dc.tenant_id = c.tenant_id AND dc.contact_id = c.id AND d.stage NOT IN ('closed','lost'))
    LIMIT p_limit)
  UNION ALL
  (SELECT c.tenant_id, 'route', c.id, c.route_due_at FROM public.contacts c   -- F1: lost ownership.followup backstop
    WHERE c.ownership_state = 'unassigned' AND c.route_due_at <= p_now - interval '15 seconds'
    ORDER BY c.route_due_at LIMIT p_limit)
  UNION ALL
  (SELECT m.tenant_id, 'message_dispatch', m.id, m.scheduled_for FROM public.messages m
    WHERE m.status IN ('scheduled','queued') AND m.scheduled_for <= p_now ORDER BY m.scheduled_for LIMIT p_limit)
  UNION ALL
  (SELECT m.tenant_id, 'dispatch_reconcile', m.id, m.dispatched_at FROM public.messages m
    WHERE m.status = 'dispatch_unknown' AND m.status_reason IS DISTINCT FROM 'DISPATCH_UNKNOWN_UNRESOLVED' AND m.dispatched_at <= p_now - interval '2 minutes' LIMIT p_limit)
  UNION ALL
  -- F2: TX1 committed 'dispatching' but no TX2 followed (worker died around provider.send). Past the
  -- maximum job lease (15 min) + 5 min margin the worker is certainly gone: -> dispatch_unknown, reconcile.
  (SELECT m.tenant_id, 'dispatch_stale', m.id, m.dispatched_at FROM public.messages m
    WHERE m.status = 'dispatching' AND m.dispatched_at <= p_now - interval '20 minutes' LIMIT p_limit)
  UNION ALL
  (SELECT e.tenant_id, 'playbook_step', e.id, e.next_step_due_at FROM public.playbook_enrollments e
    WHERE e.state = 'active' AND e.next_step_due_at <= p_now ORDER BY e.next_step_due_at LIMIT p_limit)
  UNION ALL
  (SELECT d.tenant_id, 'notification_delivery', d.id, d.next_attempt_at FROM public.notification_deliveries d
    WHERE d.status = 'pending' AND d.next_attempt_at <= p_now ORDER BY d.next_attempt_at LIMIT p_limit)
$$;

-- Repair only the legacy timeout classification, not evidenced provider failures.
DO $$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT id FROM tenants LOOP
   PERFORM set_config('app.tenant_id',t::text,true);
   WITH repaired AS (UPDATE messages SET status='dispatch_unknown'
    WHERE tenant_id=t AND status='failed' AND status_reason='DISPATCH_UNKNOWN_UNRESOLVED'
      AND provider_message_ref IS NULL AND provider_error_code IS NULL
    RETURNING id,initiator,action_category)
   INSERT INTO jobs (tenant_id,queue,kind,payload,dedupe_key,run_at)
    SELECT t,'realtime','ai_isa.send_result',jsonb_build_object('messageId',id,'status','dispatch_unknown'),
           'ai_isa.send_result:' || id::text || ':dispatch_unknown',now()
      FROM repaired WHERE initiator='assistant'
       AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')
    ON CONFLICT DO NOTHING; -- A live unknown job re-reads the repaired reason; counted sends are idempotent.
 END LOOP;
 PERFORM set_config('app.tenant_id','',true);
END $$;
