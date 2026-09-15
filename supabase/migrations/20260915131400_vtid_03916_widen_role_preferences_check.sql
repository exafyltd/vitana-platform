-- VTID-03916 — VTID-03832 extended tenant_role/vitana_role (both enums) to 8 roles
-- and rewrote get_my_permitted_roles()/validate_role_assignment()/set_role_preference()/
-- me_set_active_role() to match, but role_preferences.role is a plain TEXT column with
-- its OWN independent CHECK constraint (role_preferences_role_check) — not tied to
-- either enum, so the enum ALTERs never touched it. set_role_preference()'s
-- `INSERT INTO role_preferences (...) VALUES (..., p_role)` therefore raised a 23514
-- CHECK violation for p_role IN ('backoffice','developer','infra') regardless of the
-- caller's permission (even an exafy_admin, who bypasses every permission check in
-- that function, still hit this — the constraint fires unconditionally on INSERT).
-- Reported live: those three roles fail to switch while the other five (already in
-- the old 5-value list) work.
--
-- Applied directly to the live project 2026-09-15 (read via pg_constraint first:
-- CHECK ((role = ANY (ARRAY['community','patient','professional','staff','admin'])))),
-- this file is that same statement for the repo's own migration history.
--
-- NOT fixed here, flagged only: `nav_catalog_role_chk` has the identical gap (missing
-- 'backoffice', though it does carry admin/developer/infra) — VTID-03832's own
-- changelog already lists "nav-catalog rows for the BackOffice Navigator role" as an
-- open decision, so this is a known, deliberately-deferred follow-up, not touched by
-- this migration. Also noted: a separate, older `user_active_role` (singular) table
-- carries an even narrower CHECK (community/developer/admin only) — it is not written
-- by any code path in either repo (me_set_active_role() writes the DIFFERENT,
-- unconstrained `user_active_roles` plural table, and nothing calls that RPC from the
-- frontend either), so it is dead weight, not a live bug; left alone.
ALTER TABLE public.role_preferences DROP CONSTRAINT role_preferences_role_check;
ALTER TABLE public.role_preferences ADD CONSTRAINT role_preferences_role_check
  CHECK (role = ANY (ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra']));
