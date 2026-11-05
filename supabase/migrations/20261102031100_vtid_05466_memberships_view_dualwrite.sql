-- VTID-05466 (mt-identity-r2 / membership-unification, M2, plan Amendment 1): memberships -> user_tenants
-- dual-write. The file name is the lane's path; per Amendment 1 `memberships` stays a TABLE in this lane
-- (no view): memberships.role is a grant store (set_role_preference 20261013233000_vtid_05147_…:85-95,
-- get_my_permitted_roles 20260917100000_vtid_03995_…:86,127, gateway lib/permitted-roles.ts:46, ~50 RLS
-- policies), and switch_to_tenant_by_slug's INSERT … ON CONFLICT (user_id, tenant_id) fails against an
-- INSTEAD OF view. The view cutover is a later, separately sparred lane.
--
-- Apply after 20261102031000_vtid_05466_user_tenants_canonical.sql (which backfills the existing rows),
-- in its own RUN-MIGRATION dispatch, only after the owner approves the files and the target database
-- (collaboration.md §7d). Nothing is applied from the PR.
--
-- memberships_dualwrite_user_tenants: a CONSTRAINT trigger, AFTER INSERT ON public.memberships,
-- DEFERRABLE INITIALLY DEFERRED, FOR EACH ROW. At commit it writes
--   INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary) … 'community' …
--   ON CONFLICT (tenant_id, user_id) DO NOTHING
-- for the inserted row when, at commit, the memberships row still exists with status 'active', the user is
-- not the bot 00000000-0000-0000-0000-000000000001 (lib/vitana-bot.ts:9) or a public.service_bot_accounts
-- user, and the user has an app_users row (user_tenants.user_id REFERENCES app_users).
--  * Deferred on purpose: the two legacy writers insert memberships first and their own (primary)
--    user_tenants row after it (switch_to_tenant_by_slug 20261010180200_vtid_05043_…:78,91; handle_new_user
--    20261014000200_vtid_05149_…:130,201). At commit their row exists and the dual-write is a no-op, so their
--    primary flag and their side effects are exactly as before.
--  * N1: membership_side_effects_suppressed() is true for the dual-write's own insert (transaction-local,
--    restored right after), so the four AFTER INSERT triggers on user_tenants never fire from it, and a
--    re-insert of an existing membership is a no-op (ON CONFLICT DO NOTHING).
--  * Never a grant: active_role is always 'community'; memberships.role is not read; user_permitted_roles,
--    role_preferences and user_active_roles are not touched.
--  * is_primary only when the user has no primary membership yet (same rule as the M1 backfill and
--    VTID-05043 Migration B), so primary-tenant resolution stays defined.
--  * Fail-open for the legacy writer: an error in the dual-write is reported as a WARNING and the writer's
--    transaction commits; the nightly drift report (20261102031200) counts the row.
-- Grants follow VTID-05147 AC-5: nothing is granted to anon/authenticated; the function is SECURITY DEFINER,
-- EXECUTE revoked from PUBLIC, anon, authenticated.
--
-- Rollback: 20261102031000_vtid_05466_membership_unification_rollback.sql (drops the trigger and function;
-- user_tenants rows the trigger wrote while it was live are real memberships and are kept).

-- impact-allow-solo-migration: an expand-only trigger; no code reads anything new.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.memberships_dualwrite_user_tenants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_prev text;
BEGIN
  IF NEW.user_id = '00000000-0000-0000-0000-000000000001'::uuid THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = NEW.user_id) THEN RETURN NULL; END IF;
  -- Deferred: re-read the row as it stands at commit (it may have been deleted or deactivated since).
  IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.id = NEW.id AND m.status = 'active') THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = NEW.user_id) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.user_tenants ut
              WHERE ut.tenant_id = NEW.tenant_id AND ut.user_id = NEW.user_id) THEN RETURN NULL; END IF;

  v_prev := current_setting('vitana.suppress_membership_side_effects', true);
  BEGIN
    PERFORM set_config('vitana.suppress_membership_side_effects', 'on', true);
    INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
    VALUES (NEW.tenant_id, NEW.user_id, 'community',
            NOT EXISTS (SELECT 1 FROM public.user_tenants p WHERE p.user_id = NEW.user_id AND p.is_primary))
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
    PERFORM set_config('vitana.suppress_membership_side_effects', coalesce(v_prev, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('vitana.suppress_membership_side_effects', coalesce(v_prev, ''), true);
    RAISE WARNING 'VTID-05466: memberships -> user_tenants dual-write skipped for % / %: % (%)',
      NEW.user_id, NEW.tenant_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.memberships_dualwrite_user_tenants() IS
  'VTID-05466: deferred dual-write of an active, non-bot legacy memberships insert into user_tenants '
  '(active_role community, ON CONFLICT (tenant_id, user_id) DO NOTHING, side effects suppressed). '
  'Never writes or derives a grant.';

REVOKE ALL ON FUNCTION public.memberships_dualwrite_user_tenants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memberships_dualwrite_user_tenants() TO service_role;

DROP TRIGGER IF EXISTS memberships_dualwrite_user_tenants ON public.memberships;
CREATE CONSTRAINT TRIGGER memberships_dualwrite_user_tenants
  AFTER INSERT ON public.memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.memberships_dualwrite_user_tenants();

-- Self-check, by effect.
DO $check$
DECLARE t text; r text; p text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.memberships'::regclass
                    AND tgname = 'memberships_dualwrite_user_tenants'
                    AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'VTID-05466 self-check: the deferred dual-write trigger is missing';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.memberships'::regclass) <> 'r' THEN
    RAISE EXCEPTION 'VTID-05466 self-check: memberships must stay a table (Amendment 1)';
  END IF;
  FOREACH t IN ARRAY ARRAY['public.user_tenants', 'public.role_preferences', 'public.user_active_roles', 'public.user_permitted_roles'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(r, t, p) THEN
          RAISE EXCEPTION 'VTID-05466 self-check: % has % on % (VTID-05147 AC-5)', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.memberships_dualwrite_user_tenants()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.memberships_dualwrite_user_tenants()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05466 self-check: members can execute the dual-write function';
  END IF;
END
$check$;

COMMIT;
