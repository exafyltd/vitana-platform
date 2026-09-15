-- VTID-03914 — role_preferences_role_check was missing backoffice/developer/infra.
--
-- VTID-03832 (2026-09-13) threaded `backoffice` through three layers: the
-- vitana_role enum, the tenant_role enum, and the four role RPCs
-- (get_my_permitted_roles / validate_role_assignment / set_role_preference /
-- me_set_active_role). It missed a fourth, independent guard: role_preferences
-- is a plain TEXT column (not the enum) protected by its own hand-written
-- CHECK constraint that predates the role and was never in VTID-03832's
-- three-layer table.
--
-- Live constraint before this migration (confirmed via pg_get_constraintdef,
-- read-only, 2026-09-15):
--   CHECK (role = ANY (ARRAY['community','patient','professional','staff','admin']))
--
-- Effect: set_role_preference()'s final INSERT INTO role_preferences fails
-- with a check-constraint violation for ANY user switching to backoffice,
-- developer, or infra — including exafy_admins, who bypass every other grant
-- check in that function. Reported symptom: "Failed to switch role. Please
-- try again." when switching to Back Office from the profile drawer.
--
-- Fix: widen the constraint to the same eight roles the enums and RPCs
-- already recognize (community < patient < professional < staff <
-- backoffice < admin < developer < infra), rather than drop it — the table
-- stays defense-in-depth consistent with vitana_role/tenant_role.

ALTER TABLE public.role_preferences DROP CONSTRAINT role_preferences_role_check;

ALTER TABLE public.role_preferences ADD CONSTRAINT role_preferences_role_check
  CHECK (role = ANY (ARRAY[
    'community'::text,
    'patient'::text,
    'professional'::text,
    'staff'::text,
    'backoffice'::text,
    'admin'::text,
    'developer'::text,
    'infra'::text
  ]));

COMMENT ON CONSTRAINT role_preferences_role_check ON public.role_preferences IS
  'VTID-03914: widened to the 8 roles in vitana_role/tenant_role (VTID-03832 added backoffice/developer/infra to the enums but missed this constraint).';
