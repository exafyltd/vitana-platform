-- VTID-04337 — Commerce partner onboarding Phase 1, SEC-2
-- (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §3.3).
--
-- The VTID-03932 SELECT policy on partner_organization_members queried
-- partner_organization_members from inside its own USING clause. Postgres
-- evaluates that subquery under the same policy, so every browser read
-- (role `authenticated`) failed with:
--
--   ERROR 42P17: infinite recursion detected in policy for relation
--   "partner_organization_members"
--
-- Measured read-only on the live project 2026-09-23 (BEGIN READ ONLY;
-- SET LOCAL ROLE authenticated; SELECT count(*) ...; ROLLBACK). The
-- partner_organizations SELECT policy has the same EXISTS on members, so a
-- non-owner member reading their org hit the same recursion. The gateway
-- was unaffected only because it reads with the service role.
--
-- Fix: membership is checked through a SECURITY DEFINER helper that reads
-- the table as its owner (RLS not applied), so no policy re-enters itself.
-- The helper only answers "is the CALLER a member of this org" — it never
-- takes a user id argument, so it cannot be used to probe other users.

CREATE OR REPLACE FUNCTION public.is_partner_org_member(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.partner_organization_members pom
    WHERE pom.partner_organization_id = p_org_id
      AND pom.user_id = public.current_user_id()
  );
$$;

COMMENT ON FUNCTION public.is_partner_org_member(uuid) IS
  'VTID-04337: true if the calling user is a member of the given partner organization. SECURITY DEFINER so RLS policies on partner_organization_members / partner_organizations can use it without recursing.';

-- Every role that can SELECT these tables must be able to execute the helper,
-- because Postgres checks EXECUTE on functions in a policy expression even
-- when an earlier OR branch is already true. anon holds SELECT on
-- partner_organizations, so revoking it here would turn an anonymous read of
-- active organizations into "permission denied for function". Granting it is
-- harmless: the helper answers only for the caller, and an anonymous caller
-- has no current_user_id(), so it returns false.
REVOKE ALL ON FUNCTION public.is_partner_org_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_partner_org_member(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS partner_organization_members_select ON public.partner_organization_members;
CREATE POLICY partner_organization_members_select ON public.partner_organization_members
    FOR SELECT USING (public.is_partner_org_member(partner_organization_id));

DROP POLICY IF EXISTS partner_organizations_select ON public.partner_organizations;
CREATE POLICY partner_organizations_select ON public.partner_organizations
    FOR SELECT USING (
        status = 'active'
        OR owner_user_id = public.current_user_id()
        OR public.is_partner_org_member(id)
    );
