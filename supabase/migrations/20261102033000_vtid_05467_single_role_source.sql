-- VTID-05467 (mt-identity-r2 / role-source-and-bootstrap, R1): one selected-role source.
--
-- The selected role of a member in a tenant is user_tenants.active_role. role_preferences is derived from it: the
-- trigger user_tenants_derive_role_preference writes role_preferences on every insert of a membership and on every
-- change of active_role. user_permitted_roles stays a separate grant store. Nothing in this file writes it, and no
-- trigger derives a grant from active_role (directive §5). The gateway gate requireTenantAdmin
-- (services/gateway/src/middleware/require-tenant-admin.ts) checks both the selected role and the permitted grants.
--
-- Premises, checked against origin/main 058251d5 (details in docs/validation/VTID-05467/acceptance.md):
--  * user_tenants: 20251231000000_vtid_01101_phase_a_bootstrap.sql:87-101 (active_role :94, UNIQUE (tenant_id, user_id) :98).
--  * role_preferences: vitana-v1 20250831074859_3d469276-a217-499e-a67e-03e97240262c.sql:44-50 (UNIQUE (user_id, tenant_id));
--    eight-role CHECK from 20260915131400_vtid_03916_widen_role_preferences_check.sql.
--  * set_role_preference: last body 20261013233000_vtid_05147_s_m_membership_role_lockdown.sql (section 5).
--  * me_set_active_role: last body 20260926150000_vtid_04655_me_set_active_role_writes_role_preferences.sql.
--  * No migration writes user_tenants.active_role from a switch. The only writers are inserts with 'community'
--    (20260218000000_fix_maxina_signup_tenant_association.sql:179-184, 20260226100000_backfill_app_users_from_auth.sql:25-30).
--
-- Expand/contract, snapshot first:
--   1. Snapshot user_tenants, role_preferences and user_active_roles into legacy_archive (30 days, service role only).
--   2. Derivation trigger: role_preferences follows user_tenants.active_role.
--   3. Contract of the write path: set_role_preference() and me_set_active_role() write user_tenants.active_role, and
--      the trigger writes role_preferences. Every check of their previous bodies is kept.
--   4. No data moves. user_tenants.active_role is not aligned to role_preferences in this file. The switch paths never
--      wrote it, so an alignment would change the value the gate reads for users who did nothing. The counts of the
--      current disagreement are in docs/validation/VTID-05467/live-before.sql for the owner.
--   5. Self-checks at the end: client roles have no write privilege on the four role tables, the derivation writes no
--      grant, and both switch functions write the selected role to user_tenants.
--
-- user_active_roles (one row per user, no tenant key) is still written by both switch functions in the same
-- transaction. This lane does not derive it, because the plan does not name it (acceptance.md, Decisions taken).
--
-- Apply order: this file, then 20261102033100_vtid_05467_fix_bootstrap_admin_user.sql, one RUN-MIGRATION dispatch each,
-- only after the owner approves the files and the target database (collaboration.md §7d). Rollback:
-- 20261102033000_vtid_05467_role_source_rollback.sql.
--
-- impact-allow-solo-migration: DB-only change. The gateway reads user_tenants, role_preferences and user_active_roles
-- with the same columns, and both functions keep their signatures and grants.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Snapshot first. Exact copies, service role only, dropped by the rollback file.
CREATE SCHEMA IF NOT EXISTS "legacy_archive";

CREATE TABLE "legacy_archive".bak_05467_user_tenants AS SELECT * FROM public.user_tenants;
CREATE TABLE "legacy_archive".bak_05467_role_preferences AS SELECT * FROM public.role_preferences;
CREATE TABLE "legacy_archive".bak_05467_user_active_roles AS SELECT * FROM public.user_active_roles;

ALTER TABLE "legacy_archive".bak_05467_user_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legacy_archive".bak_05467_role_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legacy_archive".bak_05467_user_active_roles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON "legacy_archive".bak_05467_user_tenants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON "legacy_archive".bak_05467_role_preferences FROM PUBLIC, anon, authenticated;
REVOKE ALL ON "legacy_archive".bak_05467_user_active_roles FROM PUBLIC, anon, authenticated;
GRANT ALL ON "legacy_archive".bak_05467_user_tenants TO service_role;
GRANT ALL ON "legacy_archive".bak_05467_role_preferences TO service_role;
GRANT ALL ON "legacy_archive".bak_05467_user_active_roles TO service_role;

COMMENT ON TABLE "legacy_archive".bak_05467_user_tenants IS
  'VTID-05467: user_tenants at the apply of 20261102033000 (restore point for the rollback). Drop after 2026-12-02.';
COMMENT ON TABLE "legacy_archive".bak_05467_role_preferences IS
  'VTID-05467: role_preferences at the apply of 20261102033000 (evidence; not restored by the rollback). Drop after 2026-12-02.';
COMMENT ON TABLE "legacy_archive".bak_05467_user_active_roles IS
  'VTID-05467: user_active_roles at the apply of 20261102033000 (evidence; not restored by the rollback). Drop after 2026-12-02.';

-- 2. Derivation: role_preferences follows user_tenants.active_role on insert and on every change of it.
CREATE OR REPLACE FUNCTION public.user_tenants_derive_role_preference()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.role_preferences AS rp (user_id, tenant_id, role, updated_at)
  VALUES (NEW.user_id, NEW.tenant_id, NEW.active_role, now())
  ON CONFLICT (user_id, tenant_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = now()
  WHERE rp.role IS DISTINCT FROM EXCLUDED.role;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.user_tenants_derive_role_preference() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS user_tenants_derive_role_preference ON public.user_tenants;
CREATE TRIGGER user_tenants_derive_role_preference
  AFTER INSERT OR UPDATE OF active_role ON public.user_tenants
  FOR EACH ROW EXECUTE FUNCTION public.user_tenants_derive_role_preference();

-- 3a. Contract of the write path: the community app's switch writes the selected role to user_tenants.
--     Previous body: 20261013233000_vtid_05147_s_m_membership_role_lockdown.sql (section 5). Checks unchanged.
CREATE OR REPLACE FUNCTION public.set_role_preference(p_tenant_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  is_exafy_admin boolean;
  has_membership_role boolean;
  is_permitted_role boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  is_exafy_admin := COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false);
  -- VTID-05147: only a tenant the caller is a member of.
  IF NOT is_exafy_admin AND NOT EXISTS (
    SELECT 1 FROM public.user_tenants ut
     WHERE ut.user_id = auth.uid() AND ut.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT is_exafy_admin AND p_role <> 'community' THEN
    is_permitted_role := public.check_role_permitted(auth.uid(), p_tenant_id, p_role);
    IF NOT is_permitted_role THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.memberships m
        WHERE m.user_id = auth.uid()
          AND m.tenant_id = p_tenant_id
          AND m.role::text = p_role
          AND m.status = 'active'
      ) INTO has_membership_role;
      IF NOT has_membership_role THEN
        RAISE EXCEPTION 'Role not granted for this tenant';
      END IF;
    END IF;
  END IF;
  IF p_role = 'admin' AND NOT is_exafy_admin THEN
    RAISE EXCEPTION 'Admin role can only be assigned by super administrators';
  END IF;
  -- VTID-05467: the selected role is user_tenants.active_role. The derivation trigger writes the preference row.
  UPDATE public.user_tenants
     SET active_role = p_role,
         updated_at = now()
   WHERE user_id = auth.uid()
     AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not a member of this tenant' USING ERRCODE = '42501';
  END IF;
  -- VTID-04561: the Command Hub reads user_active_roles, so it is written in the same transaction.
  INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
  VALUES (auth.uid(), p_role, now())
  ON CONFLICT (user_id) DO UPDATE SET
    active_role = EXCLUDED.active_role,
    updated_at = now();
  INSERT INTO public.audit_events (user_id, tenant_id, event_type, event_data)
  VALUES (
    auth.uid(),
    p_tenant_id,
    CASE WHEN is_exafy_admin THEN 'admin_role_switch' ELSE 'user_role_switch' END,
    jsonb_build_object(
      'new_role', p_role,
      'timestamp', now(),
      'is_exafy_admin', is_exafy_admin,
      'source', 'set_role_preference',
      'user_agent', current_setting('request.headers', true)::json->>'user-agent'
    )
  );
END;
$function$;

-- 3b. Contract of the Command Hub's switch: the selected role of the tenant the switch is made in is user_tenants.active_role.
--     Previous body: 20260926150000_vtid_04655_me_set_active_role_writes_role_preferences.sql. Checks unchanged.
--     A caller with no membership row in the target tenant gets NOT_A_MEMBER before anything is written.
CREATE OR REPLACE FUNCTION public.me_set_active_role(p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_pref_tenant UUID;
    v_claim_tenant TEXT;
    v_permitted BOOLEAN;
    v_allowed_roles TEXT[] := ARRAY['community', 'patient', 'professional', 'staff', 'backoffice', 'admin', 'developer', 'infra'];
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'UNAUTHENTICATED',
            'message', 'No authenticated user'
        );
    END IF;

    IF p_role IS NULL OR NOT (p_role = ANY(v_allowed_roles)) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'INVALID_ROLE',
            'message', 'Role must be one of: community, patient, professional, staff, backoffice, admin, developer, infra'
        );
    END IF;

    v_tenant_id := public.current_tenant_id();

    IF v_tenant_id IS NOT NULL THEN
        v_permitted := public.check_role_permitted(v_user_id, v_tenant_id, p_role);

        IF NOT v_permitted THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'ROLE_NOT_PERMITTED',
                'message', 'You do not have permission to use this role. Contact your tenant admin.'
            );
        END IF;
    ELSE
        DECLARE
            v_is_exafy_admin BOOLEAN;
        BEGIN
            SELECT COALESCE((raw_app_meta_data->>'exafy_admin')::BOOLEAN, false)
              INTO v_is_exafy_admin FROM auth.users WHERE id = v_user_id;
            IF NOT v_is_exafy_admin AND p_role != 'community' THEN
                RETURN jsonb_build_object(
                    'ok', false,
                    'error', 'ROLE_NOT_PERMITTED',
                    'message', 'No tenant context available. Contact support.'
                );
            END IF;
        END;
    END IF;

    -- The tenant the switch is made in (VTID-04655 resolution order, unchanged).
    v_pref_tenant := v_tenant_id;
    IF v_pref_tenant IS NULL THEN
        v_claim_tenant := auth.jwt() -> 'app_metadata' ->> 'active_tenant_id';
        IF v_claim_tenant ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            SELECT ut.tenant_id INTO v_pref_tenant
              FROM public.user_tenants ut
             WHERE ut.user_id = v_user_id AND ut.tenant_id = v_claim_tenant::uuid
             LIMIT 1;
        END IF;
    END IF;
    IF v_pref_tenant IS NULL THEN
        SELECT ut.tenant_id INTO v_pref_tenant
          FROM public.user_tenants ut
         WHERE ut.user_id = v_user_id AND ut.is_primary
         LIMIT 1;
    END IF;

    -- VTID-05467: the selected role is user_tenants.active_role of that tenant. The derivation trigger writes the
    -- preference row. No membership row means nothing is written.
    IF v_pref_tenant IS NOT NULL THEN
        UPDATE public.user_tenants
           SET active_role = p_role,
               updated_at = NOW()
         WHERE user_id = v_user_id
           AND tenant_id = v_pref_tenant;
        IF NOT FOUND THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'NOT_A_MEMBER',
                'message', 'You are not a member of this tenant.'
            );
        END IF;
    END IF;

    -- user_active_roles has no tenant key, so it is still written here (VTID-01051, VTID-04561).
    INSERT INTO public.user_active_roles (user_id, active_role, updated_at)
    VALUES (v_user_id, p_role, NOW())
    ON CONFLICT (user_id) DO UPDATE SET active_role = EXCLUDED.active_role, updated_at = NOW();

    PERFORM set_config('request.active_role', p_role, true);

    RETURN jsonb_build_object('ok', true, 'user_id', v_user_id, 'active_role', p_role,
                              'tenant_id', v_tenant_id, 'preference_tenant_id', v_pref_tenant);
END;
$function$;

-- 4. Self-checks, by effect. A failed check raises and rolls the whole file back.
DO $check$
DECLARE
  t text;
  r text;
  p text;
  v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.user_tenants'::regclass
       AND tgname = 'user_tenants_derive_role_preference'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'VTID-05467 self-check: the derivation trigger is missing or disabled';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = 'public.user_tenants_derive_role_preference()'::regprocedure;
  IF position('user_permitted_roles' IN v_src) > 0 THEN
    RAISE EXCEPTION 'VTID-05467 self-check: the derivation trigger must not touch user_permitted_roles';
  END IF;

  FOREACH t IN ARRAY ARRAY['public.user_tenants', 'public.role_preferences', 'public.user_active_roles', 'public.user_permitted_roles'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'VTID-05467 self-check: % still has % on % (members must not write role tables)', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.set_role_preference(uuid, text)'::regprocedure;
  IF position('UPDATE public.user_tenants' IN v_src) = 0
     OR position('INSERT INTO public.role_preferences' IN v_src) > 0
     OR position('INSERT INTO public.user_permitted_roles' IN v_src) > 0 THEN
    RAISE EXCEPTION 'VTID-05467 self-check: set_role_preference must write the selected role to user_tenants only';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.me_set_active_role(text)'::regprocedure;
  IF position('UPDATE public.user_tenants' IN v_src) = 0
     OR position('INSERT INTO public.role_preferences' IN v_src) > 0
     OR position('INSERT INTO public.user_permitted_roles' IN v_src) > 0 THEN
    RAISE EXCEPTION 'VTID-05467 self-check: me_set_active_role must write the selected role to user_tenants only';
  END IF;
END
$check$;

COMMIT;
