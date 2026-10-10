-- VTID-05023 part 4 (auth -> Aurora bridge), Aurora side. Owner decision R2 accepted.
--
-- After the cutover GoTrue (auth.users) stays on Supabase and `public` lives on
-- Aurora, which has no auth.users. Six AFTER INSERT triggers on Supabase's
-- auth.users provisioned every new member synchronously in `public`; at the
-- flip they are disabled (scripts/aws/supabase-cutover-auth-bridge.sql) and
-- the same provisioning runs here, through three idempotent layers:
--   (a) lazy: PostgREST db-pre-request -> provisioning_pre_request(), for
--       read-write requests of a signed-in member with no app_users row;
--   (b) fast path: auth.users webhook -> gateway
--       POST /api/v1/internal/auth-bridge/user-event -> ensure_provisioned();
--   (c) reconciliation every 5 min in the gateway (AUTH_BRIDGE_RECONCILE_ENABLED).
--
-- ensure_provisioned() reproduces, in the triggers' firing order (AFTER
-- triggers fire alphabetically by name), the latest definition of:
--   on_auth_user_created                   -> handle_new_user
--       vitana-v1 supabase/migrations/20260503000100_vitana_id_v2_generator.sql:142
--   on_auth_user_created_generate_discount -> generate_maxina_discount_code
--       vitana-v1 supabase/migrations/20260210141933_0d5c2768-22f0-40bb-9c45-a621094bb458.sql:52
--   on_auth_user_created_preferences       -> initialize_user_preferences
--       vitana-v1 supabase/migrations/20251013135605_0859f836-d45a-4fb4-85db-6b9764711a62.sql:45
--   on_auth_user_created_wallet            -> provision_wallet_accounts
--       vitana-platform supabase/migrations/20260529000000_VTID_03200_wallet_stripe_deposits.sql:210
--   on_auth_user_platform_provision        -> provision_platform_user
--       vitana-platform supabase/migrations/20260318100000_role_admission_system.sql:200
--   on_user_journey_created                -> initialize_user_journey
--       vitana-v1 supabase/migrations/20251012161057_74d3b565-ad05-4b47-a106-5a62c60edf36.sql:126
-- Same rows, same column values, same defaults. Differences, all required by
-- idempotency or by Aurora having no auth.users:
--   * every insert is guarded (ON CONFLICT DO NOTHING on the triggers' own
--     conflict targets, or NOT EXISTS where the trigger had none), and a
--     per-user advisory lock serialises concurrent calls (webhook vs lazy hook
--     vs reconciler), so a second call inserts nothing; a user who already has
--     both app_users and profiles rows is returned untouched, so a later call
--     with different (member-editable) user_metadata cannot add memberships
--     or discount codes;
--   * app_users: ON CONFLICT (user_id) DO NOTHING instead of DO UPDATE, so a
--     repeat call never rewrites a member's edited display name;
--   * the 'community' literal is not cast to public.tenant_role (an untyped
--     literal is assigned to the column's type, enum or text);
--   * handle_new_user's UPDATE auth.users SET raw_app_meta_data.active_tenant_id
--     cannot run here: the result carries `active_tenant_id` and the gateway
--     writes it through the GoTrue admin API.
-- The lazy hook and the reconciler (layers that act on their own) skip accounts
-- registered in service_bot_accounts / notification_test_actors (CLAUDE.md
-- rules 43-45); the webhook reproduces the sign-up triggers exactly.
-- p_created_at is the auth user's created_at; rows keep their column defaults
-- exactly as the triggers did, and it is used only to log the provisioning lag.
--
-- Deletion: Supabase's 127 public->auth.users foreign keys are not on Aurora
-- (aurora-cutover-recreate-foreign-keys.sql). auth_bridge_handle_deleted_user()
-- does what the database did on DELETE FROM auth.users: the kept BEFORE DELETE
-- trigger's contacts cleanup, then each FK's ON DELETE action (CASCADE, SET
-- NULL, SET DEFAULT), read from public.auth_user_fk_map, which is loaded from
-- Supabase's live pg_constraint by scripts/aws/supabase-auth-fk-map-export.sql
-- right before the window. Nothing else (no erase_user_data: account deletion
-- keeps calling that itself, before it deletes the auth user).
--
-- One statement per line, for scripts/aws/aurora-run-sql.sh. Idempotent: safe
-- to re-run. Run as the table owner (the master user), BEFORE the PostgREST
-- proxy is deployed with PGRST_DB_PRE_REQUEST (that setting fails every request
-- while the function is missing).
--
-- Tested on a throwaway local Postgres by scripts/aws/test/auth-bridge.sh
-- (npm run test:auth-bridge).
CREATE TABLE IF NOT EXISTS public.auth_user_fk_map (table_name text NOT NULL, column_name text NOT NULL, on_delete text NOT NULL CHECK (on_delete IN ('a','r','c','n','d')), loaded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (table_name, column_name));
CREATE TABLE IF NOT EXISTS public.auth_bridge_deleted_users (user_id uuid PRIMARY KEY, source text NOT NULL, result jsonb NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.auth_user_fk_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_bridge_deleted_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_user_fk_map, public.auth_bridge_deleted_users FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_user_fk_map, public.auth_bridge_deleted_users TO service_role;
CREATE OR REPLACE FUNCTION public.ensure_provisioned(p_user_id uuid, p_email text, p_raw_user_meta jsonb, p_created_at timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ DECLARE v_meta jsonb := COALESCE(p_raw_user_meta, '{}'::jsonb); v_tenant_slug text; v_tenant_id uuid; v_full_name text; v_display_name text; v_vitana_id text; v_seq bigint; v_code text; v_attempts integer := 0; v_rows integer; v_created text[] := '{}'; BEGIN IF p_user_id IS NULL THEN RAISE EXCEPTION 'ensure_provisioned: p_user_id is required'; END IF; PERFORM pg_advisory_xact_lock(hashtextextended('ensure_provisioned:' || p_user_id::text, 0)); IF EXISTS (SELECT 1 FROM public.app_users WHERE user_id = p_user_id) AND EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user_id) THEN RETURN jsonb_build_object('user_id', p_user_id, 'created', '[]'::jsonb, 'provisioned', false, 'active_tenant_id', (SELECT a.tenant_id FROM public.app_users a WHERE a.user_id = p_user_id)); END IF; v_tenant_slug := v_meta ->> 'tenant_slug'; v_full_name := v_meta ->> 'full_name'; v_display_name := COALESCE(v_meta ->> 'display_name', v_full_name, split_part(p_email, '@', 1)); IF v_tenant_slug IS NOT NULL THEN SELECT t.tenant_id INTO v_tenant_id FROM public.tenants t WHERE t.slug = v_tenant_slug LIMIT 1; END IF; IF v_tenant_id IS NULL THEN SELECT t.tenant_id INTO v_tenant_id FROM public.tenants t ORDER BY t.created_at ASC LIMIT 1; END IF; IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user_id) THEN SELECT a.vitana_id, a.registration_seq INTO v_vitana_id, v_seq FROM public.allocate_vitana_id(v_display_name, v_full_name, p_email) a; INSERT INTO public.profiles (user_id, full_name, display_name, handle, email, vitana_id, vitana_id_locked, registration_seq) VALUES (p_user_id, v_full_name, v_display_name, v_vitana_id, p_email, v_vitana_id, false, v_seq); v_created := v_created || 'profiles'::text; END IF; INSERT INTO public.global_community_profiles (user_id, display_name, is_visible) VALUES (p_user_id, v_display_name, true) ON CONFLICT (user_id) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_created := v_created || 'global_community_profiles'::text; END IF; IF v_tenant_id IS NOT NULL THEN IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE user_id = p_user_id AND tenant_id = v_tenant_id) THEN INSERT INTO public.memberships (user_id, tenant_id, role, status) VALUES (p_user_id, v_tenant_id, 'community', 'active'); v_created := v_created || 'memberships'::text; END IF; IF NOT EXISTS (SELECT 1 FROM public.role_preferences WHERE user_id = p_user_id AND tenant_id = v_tenant_id) THEN INSERT INTO public.role_preferences (user_id, tenant_id, role) VALUES (p_user_id, v_tenant_id, 'community'); v_created := v_created || 'role_preferences'::text; END IF; END IF; IF v_tenant_slug = 'maxina' AND NOT EXISTS (SELECT 1 FROM public.user_discount_codes WHERE user_id = p_user_id AND tenant_slug = 'maxina') THEN LOOP v_code := public.generate_discount_code('MAXINA'); BEGIN INSERT INTO public.user_discount_codes (user_id, code, discount_percent, valid_for, tenant_slug) VALUES (p_user_id, v_code, 10, 'events', 'maxina'); EXIT; EXCEPTION WHEN unique_violation THEN v_attempts := v_attempts + 1; IF v_attempts > 5 THEN RAISE EXCEPTION 'Could not generate unique discount code after 5 attempts'; END IF; END; END LOOP; v_created := v_created || 'user_discount_codes'::text; END IF; INSERT INTO public.user_preferences (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_created := v_created || 'user_preferences'::text; END IF; INSERT INTO public.wallet_accounts (user_id, currency) VALUES (p_user_id, 'EUR'), (p_user_id, 'USD') ON CONFLICT (user_id, currency) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_created := v_created || 'wallet_accounts'::text; END IF; INSERT INTO public.app_users (user_id, email, display_name, tenant_id) VALUES (p_user_id, p_email, v_display_name, v_tenant_id) ON CONFLICT (user_id) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_created := v_created || 'app_users'::text; END IF; IF v_tenant_id IS NOT NULL THEN INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary) VALUES (v_tenant_id, p_user_id, 'community', true) ON CONFLICT (tenant_id, user_id) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_created := v_created || 'user_tenants'::text; END IF; INSERT INTO public.user_permitted_roles (user_id, tenant_id, role, granted_by) VALUES (p_user_id, v_tenant_id, 'community', NULL) ON CONFLICT (user_id, tenant_id, role) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_created := v_created || 'user_permitted_roles'::text; END IF; END IF; INSERT INTO public.user_journey (user_id, onboarding_stage, experience_level, engagement_score, days_active) VALUES (p_user_id, 'new', 'beginner', 0, 0) ON CONFLICT (user_id) DO NOTHING; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_created := v_created || 'user_journey'::text; END IF; IF cardinality(v_created) > 0 THEN RAISE LOG 'ensure_provisioned: user % provisioned %, lag %', p_user_id, v_created, now() - p_created_at; END IF; RETURN jsonb_build_object('user_id', p_user_id, 'created', to_jsonb(v_created), 'provisioned', cardinality(v_created) > 0, 'active_tenant_id', v_tenant_id); END; $fn$;
REVOKE ALL ON FUNCTION public.ensure_provisioned(uuid, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_provisioned(uuid, text, jsonb, timestamptz) TO service_role;
CREATE OR REPLACE FUNCTION public.provisioning_pre_request() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ DECLARE v_uid uuid; v_claims jsonb; BEGIN IF current_setting('transaction_read_only', true) = 'on' THEN RETURN; END IF; v_uid := auth.uid(); IF v_uid IS NULL THEN RETURN; END IF; IF EXISTS (SELECT 1 FROM public.app_users WHERE user_id = v_uid) THEN RETURN; END IF; v_claims := COALESCE(auth.jwt(), '{}'::jsonb); IF COALESCE(v_claims ->> 'role', '') <> 'authenticated' THEN RETURN; END IF; IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = v_uid) OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = v_uid) THEN RETURN; END IF; BEGIN PERFORM public.ensure_provisioned(v_uid, v_claims ->> 'email', COALESCE(v_claims -> 'user_metadata', '{}'::jsonb), NULL); EXCEPTION WHEN OTHERS THEN RAISE WARNING 'provisioning_pre_request: provisioning user % failed: % (%); the webhook and the reconciler retry', v_uid, SQLERRM, SQLSTATE; END; END; $fn$;
REVOKE ALL ON FUNCTION public.provisioning_pre_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provisioning_pre_request() TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.auth_bridge_handle_deleted_user(p_user_id uuid, p_source text DEFAULT 'webhook') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ DECLARE v_map record; v_pending text[] := '{}'; v_next text[]; v_key text; v_table text; v_column text; v_action text; v_rows bigint; v_pass integer := 0; v_affected jsonb := '{}'::jsonb; v_blocked jsonb := '{}'::jsonb; v_errors jsonb; v_contacts bigint := 0; v_result jsonb; BEGIN IF p_user_id IS NULL THEN RAISE EXCEPTION 'auth_bridge_handle_deleted_user: p_user_id is required'; END IF; IF NOT EXISTS (SELECT 1 FROM public.auth_user_fk_map) THEN RAISE EXCEPTION 'auth_bridge_handle_deleted_user: public.auth_user_fk_map is empty; load it from Supabase (scripts/aws/supabase-auth-fk-map-export.sql) first'; END IF; PERFORM pg_advisory_xact_lock(hashtextextended('ensure_provisioned:' || p_user_id::text, 0)); IF to_regclass('public.contacts') IS NOT NULL THEN DELETE FROM public.contacts WHERE contact_user_id = p_user_id AND contact_phone IS NULL; GET DIAGNOSTICS v_contacts = ROW_COUNT; END IF; FOR v_map IN SELECT m.table_name, m.column_name, m.on_delete FROM public.auth_user_fk_map m ORDER BY m.table_name, m.column_name LOOP IF to_regclass(format('public.%I', v_map.table_name)) IS NULL THEN CONTINUE; END IF; IF v_map.on_delete IN ('c', 'n', 'd') THEN v_pending := v_pending || (v_map.on_delete || ':' || v_map.table_name || '.' || v_map.column_name); ELSE EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', v_map.table_name, v_map.column_name) INTO v_rows USING p_user_id; IF v_rows > 0 THEN v_blocked := v_blocked || jsonb_build_object(v_map.table_name || '.' || v_map.column_name, v_rows); END IF; END IF; END LOOP; LOOP v_pass := v_pass + 1; v_next := '{}'; v_errors := '{}'::jsonb; FOREACH v_key IN ARRAY v_pending LOOP v_action := split_part(v_key, ':', 1); v_table := split_part(split_part(v_key, ':', 2), '.', 1); v_column := split_part(split_part(v_key, ':', 2), '.', 2); BEGIN IF v_action = 'c' THEN EXECUTE format('DELETE FROM public.%I WHERE %I = $1', v_table, v_column) USING p_user_id; ELSIF v_action = 'n' THEN EXECUTE format('UPDATE public.%I SET %I = NULL WHERE %I = $1', v_table, v_column, v_column) USING p_user_id; ELSE EXECUTE format('UPDATE public.%I SET %I = DEFAULT WHERE %I = $1', v_table, v_column, v_column) USING p_user_id; END IF; GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_affected := v_affected || jsonb_build_object(v_table || '.' || v_column, COALESCE((v_affected ->> (v_table || '.' || v_column))::bigint, 0) + v_rows); END IF; EXCEPTION WHEN foreign_key_violation OR check_violation OR not_null_violation THEN v_next := v_next || v_key; v_errors := v_errors || jsonb_build_object(v_table || '.' || v_column, SQLERRM); END; END LOOP; EXIT WHEN cardinality(v_next) = 0; IF v_pass >= 5 OR cardinality(v_next) = cardinality(v_pending) THEN RAISE EXCEPTION 'auth_bridge_handle_deleted_user: user % not cleaned up, nothing changed: %', p_user_id, v_errors; END IF; v_pending := v_next; END LOOP; v_result := jsonb_build_object('user_id', p_user_id, 'contacts_deleted', v_contacts, 'affected', v_affected, 'blocked', v_blocked, 'passes', v_pass); INSERT INTO public.auth_bridge_deleted_users (user_id, source, result) VALUES (p_user_id, COALESCE(p_source, 'webhook'), v_result) ON CONFLICT (user_id) DO UPDATE SET source = EXCLUDED.source, result = EXCLUDED.result, processed_at = now(); RETURN v_result; END; $fn$;
REVOKE ALL ON FUNCTION public.auth_bridge_handle_deleted_user(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_bridge_handle_deleted_user(uuid, text) TO service_role;
CREATE OR REPLACE FUNCTION public.auth_bridge_unprovisioned(p_user_ids uuid[]) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ SELECT u.id FROM unnest(p_user_ids) AS u(id) WHERE NOT EXISTS (SELECT 1 FROM public.app_users a WHERE a.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors n WHERE n.user_id = u.id) $fn$;
REVOKE ALL ON FUNCTION public.auth_bridge_unprovisioned(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_bridge_unprovisioned(uuid[]) TO service_role;
