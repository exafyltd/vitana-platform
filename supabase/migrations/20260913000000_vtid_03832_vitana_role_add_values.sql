-- VTID-03832 — BackOffice role, step 1 of 3: extend enum public.vitana_role
--
-- Live state read on 2026-09-12 (read-only): vitana_role = {community, patient,
-- professional, staff, admin, developer}. `infra` is grantable (user_permitted_roles.role
-- is text) but can never be ACTIVATED — set_active_role() casts p_role::vitana_role and
-- role_sessions.active_role / user_roles.role are this enum. That latent bug is closed
-- here together with the new `backoffice` value (BackOffice plan decisions 4/4b/7,
-- docs/backoffice/GOLDEN-WORKFLOWS.md §1.2).
--
-- ALTER TYPE ... ADD VALUE must not share a transaction with any statement that USES the
-- new value, so this file contains nothing else. Functions that reference the values are
-- in 20260913000002_vtid_03832_role_functions.sql.
--
-- Ladder position (rank) for the record: community 1 < patient 2 < professional 3 <
-- staff 4 < backoffice 5 < admin 6 < developer 7 < infra 8. Enum declaration order is
-- not the ladder — the ladder lives in validate_role_assignment() and the frontend.

ALTER TYPE public.vitana_role ADD VALUE IF NOT EXISTS 'infra';
ALTER TYPE public.vitana_role ADD VALUE IF NOT EXISTS 'backoffice';
