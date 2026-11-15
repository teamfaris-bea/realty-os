-- Forward-only repair for targeted import source checks under PostgreSQL generic plans.
-- No source refusal, withdrawal, tenant, support or visibility rule changes.
CREATE OR REPLACE FUNCTION app.stop_import_automation(p_tenant uuid, p_contact uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; actions uuid[];
BEGIN
  IF p_tenant IS DISTINCT FROM app.tenant_id() THEN RETURN; END IF;
  -- Separate the whole-tenant mapping operation from the targeted row-trigger operation.
  -- A nullable OR makes a cached generic plan evaluate refusal for every tenant contact
  -- on each imported row. Both branches retain the same tenant and person-family checks.
  IF p_contact IS NULL THEN
    SELECT array_agg(c.id) INTO ids FROM public.contacts c WHERE c.tenant_id = p_tenant
      AND app.person_source_refusal(p_tenant,c.id) IS NOT NULL;
  ELSE
    WITH person_contacts AS MATERIALIZED (
      SELECT c.id FROM public.contacts c WHERE c.tenant_id = p_tenant
        AND c.id = ANY((SELECT app.contact_person_ids(p_tenant,p_contact))::uuid[])
    )
    SELECT array_agg(c.id) INTO ids FROM person_contacts c
      WHERE app.person_source_refusal(p_tenant,c.id) IS NOT NULL;
  END IF;
  IF ids IS NULL THEN RETURN; END IF;
  UPDATE public.playbook_enrollments SET state = 'stopped',
    stop_reason = lower(app.person_source_refusal(p_tenant,contact_id)), ended_at = now(),
    next_step_due_at = NULL, paused_at = NULL, pause_reason = NULL
    WHERE tenant_id = p_tenant AND contact_id = ANY(ids) AND state IN ('active','paused');
  UPDATE public.messages m SET status = 'canceled', status_reason = app.person_source_refusal(p_tenant,m.contact_id)
    WHERE m.tenant_id = p_tenant AND m.contact_id = ANY(ids) AND m.status IN ('queued','scheduled')
      AND m.playbook_step_run_id IS NOT NULL;
  UPDATE public.playbook_step_runs r SET status = 'canceled_paused', updated_at = now()
    WHERE r.tenant_id = p_tenant AND r.status = 'scheduled' AND EXISTS (
      SELECT 1 FROM public.playbook_enrollments e WHERE e.tenant_id = r.tenant_id AND e.id = r.enrollment_id
        AND e.contact_id = ANY(ids) AND e.state = 'stopped')
      AND (r.message_id IS NULL OR EXISTS (SELECT 1 FROM public.messages m WHERE m.tenant_id = r.tenant_id AND m.id = r.message_id AND m.status = 'canceled'));
  WITH changed AS (
    UPDATE public.assistant_actions SET status = 'invalidated', payload = coalesce(payload,'{}'::jsonb) ||
      jsonb_build_object('withdrawn',jsonb_build_object('reason',app.person_source_refusal(p_tenant,contact_id),'at',now()))
    WHERE tenant_id = p_tenant AND contact_id = ANY(ids) AND status = 'proposed' AND autonomy = 'requires_approval'
      AND trigger_ref->>'kind' IN ('playbook_step','trigger_run') RETURNING id
  ) SELECT array_agg(id) INTO actions FROM changed;
  UPDATE public.priority_feed_items SET state = 'done', resolved_at = now(), snoozed_until = NULL, updated_at = now()
    WHERE tenant_id = p_tenant AND assistant_action_id = ANY(actions) AND state IN ('open','snoozed');
  UPDATE public.playbook_step_runs r SET status = 'skipped_ineligible', updated_at = now(),
    trigger_ref = coalesce(r.trigger_ref,'{}'::jsonb) || jsonb_build_object('skip',jsonb_build_object('reason',a.payload->'withdrawn'->>'reason','text','Source policy blocks automated contact; draft withdrawn.'))
    FROM public.assistant_actions a
    WHERE r.tenant_id = p_tenant AND a.tenant_id = r.tenant_id AND a.id = r.assistant_action_id
      AND r.assistant_action_id = ANY(actions) AND r.enrollment_id IS NULL AND r.status = 'converted_to_draft';
END $$;
ALTER FUNCTION app.stop_import_automation(uuid,uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.stop_import_automation(uuid,uuid) FROM PUBLIC;
