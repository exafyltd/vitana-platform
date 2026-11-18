-- VTID-05495 post-apply check. Read-only. Expect every column true.
SELECT
  to_regclass('public.tenant_content_overrides') IS NOT NULL AS table_exists,
  (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.tenant_content_overrides')) AS rls_on,
  NOT has_table_privilege('anon', 'public.tenant_content_overrides', 'SELECT') AS anon_denied,
  NOT has_table_privilege('authenticated', 'public.tenant_content_overrides', 'SELECT,INSERT,UPDATE,DELETE') AS authenticated_denied,
  has_table_privilege('service_role', 'public.tenant_content_overrides', 'SELECT,INSERT,UPDATE,DELETE') AS service_role_allowed,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.tenant_content_overrides') AND contype = 'p') AS has_pk;
