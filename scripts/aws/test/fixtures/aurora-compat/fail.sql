-- Supabase-only fixture: each statement below must be flagged by aurora-compat-lint.
CREATE TABLE IF NOT EXISTS public.vtid_fixture_fail (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES auth.users(id)
);
CREATE POLICY vtid_fixture_fail_owner ON public.vtid_fixture_fail
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE EXTENSION IF NOT EXISTS pg_graphql;
GRANT SELECT ON public.vtid_fixture_fail TO service_role;
