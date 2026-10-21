-- VTID-05147 (Track S / S-M) — EMERGENCY ROLLBACK. RE-OPENS THE HOLE.
-- Use only if a legitimate client writer was missed and cannot be fixed
-- forward, and only with the owner's explicit approval. Restores the live
-- state of 2026-10-13: the six member write policies (as pg_policies showed
-- them), the revoked table privileges, and the previous set_role_preference
-- body and ACL (PUBLIC + anon EXECUTE).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE POLICY user_tenants_update_own ON public.user_tenants FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY rp_upsert_self ON public.role_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY rp_update_self ON public.role_preferences FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY rp_delete_self ON public.role_preferences FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY user_active_roles_insert ON public.user_active_roles FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY user_active_roles_update ON public.user_active_roles FOR UPDATE USING (user_id = auth.uid());

GRANT INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON
  public.user_tenants, public.role_preferences, public.user_active_roles, public.user_permitted_roles TO authenticated;
GRANT TRUNCATE, TRIGGER, REFERENCES ON
  public.user_tenants, public.role_preferences, public.user_active_roles TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.user_permitted_roles TO anon;
GRANT TRUNCATE, TRIGGER, REFERENCES ON public.memberships, public.app_users TO anon, authenticated;

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
  is_exafy_admin := COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false);
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
  INSERT INTO public.role_preferences (user_id, tenant_id, role)
  VALUES (auth.uid(), p_tenant_id, p_role)
  ON CONFLICT (user_id, tenant_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = now();
  -- VTID-04561: the Command Hub reads user_active_roles — keep it in step.
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
GRANT EXECUTE ON FUNCTION public.set_role_preference(uuid, text) TO PUBLIC, anon, authenticated, service_role;

COMMIT;
