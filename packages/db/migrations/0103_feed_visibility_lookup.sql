-- Keep the feed's existing contact visibility rule, but expose its indexed lookup to the planner.
-- app.contact_visible is a SECURITY INVOKER wrapper around this exact EXISTS query. Calling that
-- PL/pgSQL wrapper per stored card repeats the contacts policy's membership InitPlans per call.
-- Here contacts still uses the caller's FORCE RLS; its statement-stable InitPlans run once while
-- the (tenant_id, id) primary-key lookup remains per card. No visibility condition, grant, helper,
-- security mode, or other (including restrictive) feed policy changes.
-- Both open and snoozed historical cards must remain subject to current contact visibility.
ALTER POLICY feed_select ON priority_feed_items
  USING (
    (SELECT app.is_tenant_wide())
    OR (user_id = (SELECT app.user_id()) AND (
      contact_id IS NULL OR EXISTS (
        SELECT 1 FROM public.contacts visible_contact
        WHERE visible_contact.tenant_id = priority_feed_items.tenant_id
          AND visible_contact.id = priority_feed_items.contact_id
      )
    ))
  );
