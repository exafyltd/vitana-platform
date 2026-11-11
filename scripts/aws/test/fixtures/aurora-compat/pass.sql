-- Aurora-compatible migration fixture: no Supabase-only schema, role or extension.
-- Mentioning auth.uid() in a comment is allowed.
CREATE TABLE IF NOT EXISTS public.vtid_fixture_pass (
  id uuid PRIMARY KEY,
  note text DEFAULT 'auth.users is only text here'
);
CREATE POLICY vtid_fixture_pass_owner ON public.vtid_fixture_pass
  FOR SELECT TO public USING (true);
