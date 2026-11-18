-- VTID-05803 staging reconciliation, part 0 of the one-transaction batch (vitana-aurora-staging ONLY; never production).
-- The live staging database already holds the 5-argument allocate_global_vtid created by
-- 20261004110000_vtid_04868_plan_sparring_gate.sql, applied out of order (before 20251217..20260628). With it present,
-- 20251217000000 line 164 and 20260628120000 line 144 name allocate_global_vtid without arguments and fail with
-- "function name is not unique". This drops that function only (code; no rows). The same batch re-creates it,
-- identical, at 20261004110000. Tables and their rows are not touched.
DROP FUNCTION public.allocate_global_vtid(text, text, text, uuid, text);
