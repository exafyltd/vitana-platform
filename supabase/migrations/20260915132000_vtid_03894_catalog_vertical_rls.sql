-- VTID-03894 — RLS on the two new catalog tables.
--
-- CAUGHT AFTER THE FACT, WHICH IS THE POINT OF WRITING IT DOWN
--
-- 20260915100000 created catalog_verticals and catalog_vertical_fields with no
-- RLS at all, while every sibling table it sits beside — catalog_vocabulary,
-- products, merchants — has RLS on with two policies. In Supabase a table in
-- `public` with RLS disabled is reachable through PostgREST with the ANON key,
-- for reads AND writes. So between that migration and this one, the questions
-- every supplier is asked were writable by anyone holding the publishable key:
-- a field could be renamed to ask for anything, or the verticals deleted
-- outright and the portal's first step emptied.
--
-- Nothing in the gateway noticed, because the gateway uses the service role and
-- would have worked identically either way. The Supabase security advisor is
-- what surfaces this class of mistake; run it after any migration that creates
-- a table (`get_advisors type=security`, lint rls_disabled_in_public).
--
-- POSTURE: mirrors catalog_vocabulary exactly, which is the right analogue —
-- both are reference data the app reads and only the gateway writes.
--
--   authenticated -> SELECT, active rows only
--   service_role  -> ALL
--
-- Deliberately NO anon policy. The supplier portal is behind auth, and Discover
-- reads `products`, never these tables, so anonymous access buys nothing and
-- widens the surface for no gain.

ALTER TABLE public.catalog_verticals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_vertical_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_verticals_select ON public.catalog_verticals;
CREATE POLICY catalog_verticals_select ON public.catalog_verticals
  FOR SELECT TO authenticated USING (is_active = TRUE);

DROP POLICY IF EXISTS catalog_verticals_service ON public.catalog_verticals;
CREATE POLICY catalog_verticals_service ON public.catalog_verticals
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS catalog_vertical_fields_select ON public.catalog_vertical_fields;
CREATE POLICY catalog_vertical_fields_select ON public.catalog_vertical_fields
  FOR SELECT TO authenticated USING (is_active = TRUE);

DROP POLICY IF EXISTS catalog_vertical_fields_service ON public.catalog_vertical_fields;
CREATE POLICY catalog_vertical_fields_service ON public.catalog_vertical_fields
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
