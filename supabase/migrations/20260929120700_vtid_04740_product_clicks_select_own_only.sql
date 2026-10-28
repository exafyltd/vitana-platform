-- VTID-04740 (follow-up): a signed-in user reads only their own clicks.
--
-- product_clicks_select_own (20260416120000) also let every authenticated
-- client read every anonymous click (`user_id IS NULL`). Since VTID-04740 a
-- click carries referrer_user_id, so that would expose which member referred
-- each signed-out visitor (Codex review of #3820). No client reads this table
-- (the frontend never does; every gateway read uses the service role, which
-- this policy does not govern), so the rule is narrowed to the caller's own
-- rows. Owner go-ahead given 2026-09-29. No data changes.

DROP POLICY IF EXISTS product_clicks_select_own ON public.product_clicks;
CREATE POLICY product_clicks_select_own ON public.product_clicks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
