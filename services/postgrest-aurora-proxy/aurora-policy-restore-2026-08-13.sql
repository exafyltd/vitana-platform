-- Restores the 6 RLS policies dropped by aurora-policy-drop-2026-08-13.sql,
-- verbatim from pg_policies captured immediately before the drop.
-- Run once the DMS full-load has finished reloading affected tables --
-- these are real tenant-isolation/ownership policies, not cosmetic.

CREATE POLICY "user_intents_public_read" ON public.user_intents
  AS PERMISSIVE FOR SELECT TO public
  USING (
    (visibility = 'public'::text)
    AND (status = ANY (ARRAY['open'::text, 'matched'::text, 'engaged'::text]))
    AND (tenant_id IN (
      SELECT m.tenant_id FROM memberships m
      WHERE ((m.user_id = auth.uid()) AND (m.status = 'active'::text))
    ))
  );

CREATE POLICY "user_intents_tenant_read" ON public.user_intents
  AS PERMISSIVE FOR SELECT TO public
  USING (
    (visibility = 'tenant'::text)
    AND (status = ANY (ARRAY['open'::text, 'matched'::text, 'engaged'::text]))
    AND (tenant_id IN (
      SELECT m.tenant_id FROM memberships m
      WHERE ((m.user_id = auth.uid()) AND (m.status = 'active'::text))
    ))
  );

CREATE POLICY "Community users can delete events they created or co-create" ON public.global_community_events
  AS PERMISSIVE FOR DELETE TO public
  USING (
    is_community_user()
    AND (
      (created_by = auth.uid())
      OR (EXISTS (
        SELECT 1 FROM event_co_creators ecc
        WHERE ((ecc.event_id = global_community_events.id) AND (ecc.user_id = auth.uid()))
      ))
    )
  );

CREATE POLICY "Community users can update events they created or co-create" ON public.global_community_events
  AS PERMISSIVE FOR UPDATE TO public
  USING (
    is_community_user()
    AND (
      (created_by = auth.uid())
      OR (EXISTS (
        SELECT 1 FROM event_co_creators ecc
        WHERE ((ecc.event_id = global_community_events.id) AND (ecc.user_id = auth.uid()))
      ))
    )
  );

CREATE POLICY "Event creators can add co-creators" ON public.event_co_creators
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM global_community_events gce
      WHERE ((gce.id = event_co_creators.event_id) AND (gce.created_by = auth.uid()))
    )
  );

CREATE POLICY "Event creators can remove co-creators" ON public.event_co_creators
  AS PERMISSIVE FOR DELETE TO public
  USING (
    EXISTS (
      SELECT 1 FROM global_community_events gce
      WHERE ((gce.id = event_co_creators.event_id) AND (gce.created_by = auth.uid()))
    )
  );
