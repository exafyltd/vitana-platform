-- Harness only: the state after the rollbacks, as the rollback-check expects it.
SELECT slug, is_active FROM public.tenants ORDER BY slug;
