-- VTID-03842 follow-up, applied to the live project 2026-09-14 right after the two BackOffice
-- migrations (owner's in-conversation "apply now").
--
-- Supabase grants ALL on every new public table to anon and authenticated by default. Row-level
-- security covers SELECT/INSERT/UPDATE/DELETE, but TRUNCATE is subject to neither RLS nor the
-- append-only trigger on erp_audit_log, and no BackOffice table is ever written by a browser role:
-- the gateway writes them all with the service role. Revoke everything from the browser roles and
-- re-grant exactly what VTID-03834 and VTID-03842 intended (the two SELECT-own policies).
REVOKE ALL ON public.erp_capability_grants, public.erp_commands, public.erp_approvals, public.erp_audit_log, public.erp_policy_settings FROM anon, authenticated;
GRANT SELECT ON public.erp_capability_grants TO authenticated;
GRANT SELECT ON public.erp_commands TO authenticated;
