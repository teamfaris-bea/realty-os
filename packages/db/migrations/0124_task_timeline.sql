-- A task about a person is part of their timeline (the contact page and the promises screen).
-- Open tasks sit at created_at. Completing one moves the same row to completed_at, so Done shows
-- up as a new timeline line ("promise:done") without a second table. security_invoker stays: the
-- caller sees a task only when tasks RLS already lets them see it.
CREATE OR REPLACE VIEW contact_timeline WITH (security_invoker = true) AS
  SELECT m.tenant_id, m.contact_id, m.occurred_at, 'message'::text AS item_type, m.id AS item_id,
         m.initiated_by_user_id AS actor_user_id, m.channel || ':' || m.direction AS detail,
         left(m.body, 280) AS preview, CASE WHEN m.imported THEN 'imported' ELSE 'native' END AS provenance
    FROM messages m
  UNION ALL
  SELECT c.tenant_id, c.contact_id, c.started_at, 'call', c.id, c.agent_user_id, c.direction || ':' || c.status,
         c.outcome, CASE WHEN c.imported THEN 'imported' ELSE 'native' END
    FROM calls c
  UNION ALL
  SELECT n.tenant_id, n.contact_id, COALESCE(n.activity_at, n.created_at), 'note', n.id, n.author_user_id,
         n.source || COALESCE(':' || n.activity_kind, ''), left(n.body, 280),
         CASE WHEN n.imported THEN 'imported' ELSE 'native' END
    FROM notes n WHERE n.contact_id IS NOT NULL
  UNION ALL
  SELECT e.tenant_id, e.contact_id, e.occurred_at, 'ownership', e.event_id, e.actor_user_id, e.type, e.reason_code,
         CASE WHEN e.actor_kind = 'import' THEN 'imported' ELSE 'native' END
    FROM lead_ownership_events e
  UNION ALL
  SELECT a.tenant_id, a.contact_id, a.starts_at, 'appointment', a.id, a.user_id, a.kind || ':' || a.status, a.outcome, 'native'
    FROM appointments a WHERE a.contact_id IS NOT NULL
  UNION ALL
  SELECT b.tenant_id, b.contact_id, b.occurred_at, 'behavior', b.id, NULL::uuid, b.event_type, b.reliability, 'native'
    FROM behavior_events b
  UNION ALL
  SELECT s.tenant_id, s.contact_id, s.occurred_at, 'stage', s.id, s.actor_user_id,
         COALESCE(s.from_stage, '') || '>' || s.to_stage, NULL::text, 'native'
    FROM contact_stage_events s
  UNION ALL
  SELECT t.tenant_id, t.contact_id,
         CASE WHEN t.status = 'done' AND t.completed_at IS NOT NULL THEN t.completed_at ELSE t.created_at END,
         'task', t.id,
         CASE WHEN t.status = 'done' THEN t.completed_by_user_id ELSE t.created_by_user_id END,
         t.kind || ':' || t.status, left(t.title, 280),
         CASE WHEN t.created_by_kind = 'import' THEN 'imported' ELSE 'native' END
    FROM tasks t WHERE t.contact_id IS NOT NULL;
