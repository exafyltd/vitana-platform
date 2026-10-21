-- VTID-03832 — BackOffice role, step 2 of 3: extend enum public.tenant_role
--
-- Live state read on 2026-09-12 (read-only): tenant_role = {community, patient,
-- professional, reseller, staff, admin}; used by memberships.role. set_role_preference()
-- (the RPC useRole.setRole calls) validates a memberships row whose role::text equals the
-- requested role, so a role that cannot exist in this enum can never be switched into via
-- the membership path. `backoffice` is added for decision 4; `developer` and `infra` are
-- added so every role the switcher can show can also be carried by a memberships row
-- (the design gate agreed — GOLDEN-WORKFLOWS.md §1.2 row 4/4b). Nothing here removes
-- `reseller` (a legacy value; reseller is a capability now, see useRole.tsx).
--
-- Own file for the same ADD VALUE transaction rule as step 1.

ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'backoffice';
ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'developer';
ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'infra';
