-- VTID-05491 (mt-tenant-admin-r2/tenant-admin-moderation-db) — pgTAP: moderation P2 (tenant stamping), P3 (tenant-scoped
-- moderation RPCs and review guard) and the moderator tenant-scope policies (tasks M1-M4).
-- Runs on a throwaway Postgres after vtid_05491_fixture.sql and 20261102070100 / 070150 / 070600 _vtid_05491_*.sql.
-- One transaction, rolled back at the end: never against a shared or live database.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(73);

CREATE SCHEMA t05491;
GRANT USAGE ON SCHEMA t05491 TO authenticated, anon, service_role;

-- First column of the first row of p_sql, run as p_role with JWT sub = p_user (+ p_claims); 'error:<SQLSTATE>' on failure.
CREATE FUNCTION t05491.val(p_role text, p_user uuid, p_sql text, p_claims jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('role', p_role) || coalesce(jsonb_build_object('sub', p_user), '{}'::jsonb) || p_claims)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'error:' || SQLSTATE || ':' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;
CREATE FUNCTION t05491.auth(p_user uuid, p_sql text, p_claims jsonb DEFAULT '{}'::jsonb)
RETURNS text LANGUAGE sql AS $$ SELECT t05491.val('authenticated', p_user, p_sql, p_claims) $$;
CREATE FUNCTION t05491.exafy(p_sql text) RETURNS text LANGUAGE sql AS
$$ SELECT t05491.val('authenticated', '05491000-0000-4000-8000-000000000003'::uuid, p_sql, '{"app_metadata":{"exafy_admin":true}}'::jsonb) $$;

CREATE FUNCTION t05491.id(p_k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_k
  WHEN 'TA' THEN '05491000-0000-4000-8000-0000000000a1' WHEN 'TB' THEN '05491000-0000-4000-8000-0000000000b1'
  WHEN 'TC' THEN '05491000-0000-4000-8000-0000000000c9'
  WHEN 'uA' THEN '05491000-0000-4000-8000-000000000001' WHEN 'uB' THEN '05491000-0000-4000-8000-000000000002'
  WHEN 'uR1' THEN '05491000-0000-4000-8000-000000000011' WHEN 'uR2' THEN '05491000-0000-4000-8000-000000000012'
  WHEN 'uR3' THEN '05491000-0000-4000-8000-000000000013' WHEN 'uR4' THEN '05491000-0000-4000-8000-000000000014'
  WHEN 'uR5' THEN '05491000-0000-4000-8000-000000000015' WHEN 'uR6' THEN '05491000-0000-4000-8000-000000000016'
  WHEN 'e1' THEN '05491000-0000-4000-8000-0000000001e1' WHEN 'e2' THEN '05491000-0000-4000-8000-0000000001e2'
  WHEN 'e3' THEN '05491000-0000-4000-8000-0000000001e3' WHEN 'e4' THEN '05491000-0000-4000-8000-0000000001e4'
  WHEN 'a1' THEN '05491000-0000-4000-8000-0000000002a1' WHEN 'a2' THEN '05491000-0000-4000-8000-0000000002a2'
  WHEN 'a3' THEN '05491000-0000-4000-8000-0000000002a3'
  WHEN 'n1' THEN '05491000-0000-4000-8000-0000000003e1' WHEN 'n2' THEN '05491000-0000-4000-8000-0000000003e2'
  WHEN 'n3' THEN '05491000-0000-4000-8000-0000000003e3' WHEN 'n4' THEN '05491000-0000-4000-8000-0000000003e4'
  WHEN 'n5' THEN '05491000-0000-4000-8000-0000000003e5' WHEN 'n6' THEN '05491000-0000-4000-8000-0000000003e6'
  WHEN 'post' THEN '05491000-0000-4000-8000-0000000000f1' END::uuid $$;

-- ---------------------------------------------------------------------------
-- P2 (20261102070100): columns, backfill, snapshot, helpers, stamping trigger
-- ---------------------------------------------------------------------------
SELECT has_function('public', 'is_tenant_moderator', 'P2: is_tenant_moderator() exists');
SELECT is((SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public'
            AND table_name IN ('content_reports', 'moderation_actions') AND column_name = 'tenant_id'), 2,
          'P2: content_reports and moderation_actions both gain tenant_id');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('e1')), t05491.id('TA'),
          'P2 backfill: a reporter with exactly one membership gets that tenant');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('e2')), t05491.id('TA'),
          'P2 backfill: a reporter with several memberships gets the primary one');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('e3')), NULL::uuid,
          'P2 backfill: several memberships and no primary stays NULL (never oldest-tenant)');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('e4')), NULL::uuid,
          'P2 backfill: a reporter without a membership stays NULL');
SELECT is((SELECT tenant_id FROM public.moderation_actions WHERE id = t05491.id('a1')), t05491.id('TA'),
          'P2 backfill: a profile_post action takes the post tenant');
SELECT is((SELECT tenant_id FROM public.moderation_actions WHERE id = t05491.id('a2')), t05491.id('TB'),
          'P2 backfill: a user action takes the target user''s sole tenant');
SELECT is((SELECT tenant_id FROM public.moderation_actions WHERE id = t05491.id('a3')), NULL::uuid,
          'P2 backfill: an ambiguous target user stays NULL');
SELECT is((SELECT count(*)::int FROM legacy_archive.bak_05491_content_reports), 4,
          'P2: the pre-change content_reports rows are snapshotted');
SELECT is((SELECT count(*)::int FROM legacy_archive.bak_05491_moderation_actions), 3,
          'P2: the pre-change moderation_actions rows are snapshotted');

SELECT is(t05491.auth(t05491.id('uA'), format('select public.is_tenant_moderator(%L)', t05491.id('TA'))), 'true',
          'P2: a staff member of T_A moderates T_A');
SELECT is(t05491.auth(t05491.id('uA'), format('select public.is_tenant_moderator(%L)', t05491.id('TB'))), 'false',
          'P2: a staff member of T_A does not moderate T_B');
SELECT is(t05491.auth(t05491.id('uB'), format('select public.is_tenant_moderator(%L)', t05491.id('TA'))), 'false',
          'P2: an admin of T_B does not moderate T_A');
SELECT is(t05491.exafy(format('select public.is_tenant_moderator(%L)', t05491.id('TB'))), 'true',
          'P2: the exafy_admin claim moderates every tenant');
SELECT is(t05491.auth(t05491.id('uA'), 'select public.is_tenant_moderator(NULL)'), 'false',
          'P2: a NULL tenant is nobody''s but exafy''s');
SELECT is(t05491.auth(t05491.id('uR1'), format('select public.is_tenant_moderator(%L)', t05491.id('TA'))), 'false',
          'P2: a plain member moderates nothing');
SELECT ok(NOT has_function_privilege('anon', 'public.moderation_home_tenant(uuid)', 'EXECUTE'),
          'P2: the internal home-tenant helper is not executable by anon');
SELECT ok(NOT has_function_privilege('authenticated', 'public.moderation_home_tenant(uuid)', 'EXECUTE'),
          'P2: the internal home-tenant helper is not executable by authenticated');

-- Stamping on insert (RETURNING would need a SELECT policy the reporter does not have, so the row is read back afterwards).
CREATE FUNCTION t05491.ins(p_new uuid, p_post uuid, p_tenant uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.content_reports(id, reporter_user_id, content_type, content_id, reason, tenant_id)
  VALUES (p_new, auth.uid(), 'post', p_post, 'new', p_tenant);
  RETURN 'inserted';
END $$;
CREATE FUNCTION t05491.report_as(p_user text, p_new text, p_tenant text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT t05491.auth(t05491.id(p_user), format('select t05491.ins(%L, %L, %L)', t05491.id(p_new), t05491.id('post'), t05491.id(p_tenant))) $$;
SELECT is(t05491.report_as('uR1', 'n1'), 'inserted', 'P2 trigger: (setup) uR1 inserts a report');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('n1')), t05491.id('TA'),
          'P2 trigger: a report by a T_A member is stamped T_A');
SELECT is(t05491.report_as('uR2', 'n2'), 'inserted', 'P2 trigger: (setup) uR2 inserts a report');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('n2')), t05491.id('TB'),
          'P2 trigger: a report by a T_B member is stamped T_B');
SELECT like(t05491.report_as('uR1', 'n3', 'TB'), 'error:%TENANT_NOT_MEMBER%',
          'P2 trigger: a reporter cannot stamp a tenant they are not a member of');
SELECT is(t05491.report_as('uR3', 'n4', 'TB'), 'inserted', 'P2 trigger: (setup) uR3 names T_B');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('n4')), t05491.id('TB'),
          'P2 trigger: a member of two tenants may name either');
SELECT is(t05491.report_as('uR4', 'n5'), 'inserted', 'P2 trigger: (setup) uR4 inserts without a tenant');
SELECT ok((SELECT tenant_id IS NULL FROM public.content_reports WHERE id = t05491.id('n5')),
          'P2 trigger: an ambiguous reporter is stored with a NULL tenant (fail closed)');

-- ---------------------------------------------------------------------------
-- P3 (20261102070150): tenant-scoped RPCs and the review guard
-- ---------------------------------------------------------------------------
SELECT has_function('public', 'moderation_list_reports', 'P3: moderation_list_reports() exists');
SELECT has_function('public', 'moderation_resolve_report', 'P3: moderation_resolve_report() exists');
SELECT is(t05491.auth(t05491.id('uA'), format('select count(*) from public.moderation_list_reports(%L)', t05491.id('TA'))),
          (SELECT count(*)::text FROM public.content_reports WHERE tenant_id = t05491.id('TA')),
          'P3: listing T_A as its moderator returns exactly the T_A reports');
SELECT is(t05491.auth(t05491.id('uA'), format('select count(*) from public.moderation_list_reports(%L) where tenant_id <> %L', t05491.id('TA'), t05491.id('TA'))),
          '0', 'P3: the T_A listing contains no other tenant''s report');
SELECT like(t05491.auth(t05491.id('uB'), format('select count(*) from public.moderation_list_reports(%L)', t05491.id('TA'))), 'error:%NOT_AUTHORIZED%',
          'P3: a T_B moderator cannot list T_A');
SELECT like(t05491.auth(t05491.id('uA'), 'select count(*) from public.moderation_list_reports(NULL)'), 'error:%NOT_AUTHORIZED%',
          'P3: the all-tenants listing is exafy_admin only');
SELECT is(t05491.exafy('select count(*) from public.moderation_list_reports(NULL)'),
          (SELECT count(*)::text FROM public.content_reports), 'P3: exafy_admin lists every tenant (and NULL-tenant rows)');
SELECT is(t05491.auth(t05491.id('uA'), format('select count(*) from public.moderation_list_reports(%L, %L)', t05491.id('TA'), 'resolved')),
          '0', 'P3: the status filter applies');
SELECT is(t05491.auth(t05491.id('uA'), format('select count(*) from public.moderation_list_reports(%L, NULL, 1)', t05491.id('TA'))),
          '1', 'P3: the limit applies');
SELECT is(t05491.auth(t05491.id('uA'), format('select count(*) from public.moderation_list_reports(%L, NULL, 100000)', t05491.id('TA'))),
          (SELECT count(*)::text FROM public.content_reports WHERE tenant_id = t05491.id('TA')), 'P3: an oversized limit is clamped, not an error');

SELECT is(t05491.auth(t05491.id('uA'), format($q$select status from public.moderation_resolve_report(%L, 'dismissed', 'none', 'not a violation')$q$, t05491.id('n1'))),
          'dismissed', 'P3: a T_A moderator resolves a T_A report');
SELECT is((SELECT reviewed_by FROM public.content_reports WHERE id = t05491.id('n1')), t05491.id('uA'), 'P3: reviewed_by is the caller');
SELECT isnt((SELECT reviewed_at FROM public.content_reports WHERE id = t05491.id('n1')), NULL::timestamptz, 'P3: reviewed_at is stamped');
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE target_id = t05491.id('n1') AND tenant_id = t05491.id('TA')
            AND action = 'report_dismissed' AND actor_id = t05491.id('uA')), 1,
          'P3: one tenant-stamped audit row is written');
SELECT is(t05491.auth(t05491.id('uA'), format($q$select status from public.moderation_resolve_report(%L, 'dismissed', 'none', 'not a violation')$q$, t05491.id('n1'))),
          'dismissed', 'P3: resolving with the same values again succeeds');
SELECT is((SELECT count(*)::int FROM public.moderation_actions WHERE target_id = t05491.id('n1')), 1,
          'P3: ... and is idempotent: no second audit row');
SELECT like(t05491.auth(t05491.id('uB'), format($q$select status from public.moderation_resolve_report(%L, 'actioned')$q$, t05491.id('n1'))),
          'error:%NOT_AUTHORIZED%', 'P3: a T_B moderator cannot resolve a T_A report');
SELECT like(t05491.auth(t05491.id('uA'), format($q$select status from public.moderation_resolve_report(%L, 'bogus')$q$, t05491.id('n1'))),
          'error:%BAD_STATUS%', 'P3: an unknown status is refused');
SELECT like(t05491.auth(t05491.id('uA'), format($q$select status from public.moderation_resolve_report(%L, 'actioned')$q$, '05491000-0000-4000-8000-0000000009ff')),
          'error:%REPORT_NOT_FOUND%', 'P3: an unknown report id is refused');
SELECT like(t05491.auth(t05491.id('uA'), format($q$select status from public.moderation_resolve_report(%L, 'actioned')$q$, t05491.id('e3'))),
          'error:%NOT_AUTHORIZED%', 'P3: a tenant moderator cannot resolve a NULL-tenant report');
SELECT is(t05491.exafy(format($q$select status from public.moderation_resolve_report(%L, 'actioned', 'hidden', 'exafy')$q$, t05491.id('e3'))),
          'actioned', 'P3: exafy_admin resolves a NULL-tenant report');
SELECT like(t05491.val('anon', NULL, format($q$select status from public.moderation_resolve_report(%L, 'actioned')$q$, t05491.id('n2'))),
          'error:42501%', 'P3: anon cannot execute the resolve RPC');
SELECT is(t05491.val('service_role', NULL, format($q$update public.content_reports set tenant_id = %L where id = %L returning tenant_id::text$q$, t05491.id('TA'), t05491.id('n2'))),
          t05491.id('TB')::text, 'P3 guard: a tenant-bearing report keeps its tenant on UPDATE (assign-once)');
SELECT is(t05491.val('service_role', NULL, format($q$update public.content_reports set tenant_id = %L where id = %L returning tenant_id::text$q$, t05491.id('TA'), t05491.id('e4'))),
          t05491.id('TA')::text, 'P3 guard: a NULL tenant can be assigned once');
UPDATE public.content_reports SET tenant_id = NULL WHERE id = t05491.id('e4');
SELECT is((SELECT tenant_id FROM public.content_reports WHERE id = t05491.id('e4')), t05491.id('TA'), 'P3 guard: ... and cannot be cleared again');

-- ---------------------------------------------------------------------------
-- 20261102070600: moderator tenant-scope policies (flag mt.moderator_tenant_scope per tenant)
-- ---------------------------------------------------------------------------
SELECT has_function('public', 'moderator_tenant_scope_enabled', 'M3: moderator_tenant_scope_enabled() exists');
-- Flag off everywhere: exactly today's behaviour, any staff/admin moderator reads every report.
SELECT is(t05491.auth(t05491.id('uB'), 'select count(*) from public.content_reports'),
          (SELECT count(*)::text FROM public.content_reports), 'M3 flag off: a T_B moderator still reads every report (today''s behaviour)');
SELECT is(t05491.auth(t05491.id('uA'), 'select count(*) from public.moderation_actions'),
          (SELECT count(*)::text FROM public.moderation_actions), 'M3 flag off: a T_A moderator still reads every audit row (today''s behaviour)');
SELECT is(t05491.auth(t05491.id('uR1'), 'select count(*) from public.content_reports'), '0', 'M3 flag off: a plain member reads no report');

INSERT INTO public.tenant_settings (tenant_id, feature_flags) VALUES
  (t05491.id('TA'), '{"mt":{"moderator_tenant_scope":true}}'), (t05491.id('TB'), '{"mt":{"moderator_tenant_scope":true}}');
SELECT is(t05491.auth(t05491.id('uB'), format('select count(*) from public.content_reports where tenant_id = %L', t05491.id('TA'))), '0',
          'M3 flag on: a moderator of T_B sees 0 T_A reports');
SELECT is(t05491.auth(t05491.id('uB'), format('select count(*) from public.content_reports where tenant_id = %L', t05491.id('TB'))),
          (SELECT count(*)::text FROM public.content_reports WHERE tenant_id = t05491.id('TB')), 'M3 flag on: ... and sees all of T_B');
SELECT is(t05491.auth(t05491.id('uA'), format('select count(*) from public.content_reports where tenant_id = %L', t05491.id('TB'))), '0',
          'M3 flag on: a moderator of T_A sees 0 T_B reports');
SELECT is(t05491.auth(t05491.id('uA'), 'select count(*) from public.content_reports where tenant_id is null'), '0',
          'M3 flag on: a tenant moderator sees no NULL-tenant report (fail closed)');
SELECT is(t05491.exafy('select count(*) from public.content_reports'), (SELECT count(*)::text FROM public.content_reports),
          'M3 flag on: exafy_admin still reads every report');
SELECT is(t05491.auth(t05491.id('uR1'), 'select count(*) from public.content_reports'), '0', 'M3 flag on: a plain member reads no report');
SELECT is(t05491.auth(t05491.id('uB'), format($q$with u as (update public.content_reports set admin_notes = 'x' where tenant_id = %L returning 1) select count(*) from u$q$, t05491.id('TA'))),
          '0', 'M3 flag on: a T_B moderator updates 0 T_A reports');
SELECT is(t05491.auth(t05491.id('uA'), format($q$with u as (update public.content_reports set admin_notes = 'x' where tenant_id = %L returning 1) select count(*) from u$q$, t05491.id('TA'))),
          (SELECT count(*)::text FROM public.content_reports WHERE tenant_id = t05491.id('TA')), 'M3 flag on: a T_A moderator updates its own tenant''s reports');
SELECT is(t05491.auth(t05491.id('uB'), format('select count(*) from public.moderation_actions where tenant_id = %L', t05491.id('TA'))), '0',
          'M3 flag on: a moderator of T_B sees 0 T_A audit rows');
SELECT is(t05491.auth(t05491.id('uB'), 'select count(*) from public.moderation_actions where tenant_id is null'), '0',
          'M3 flag on: ... and no NULL-tenant audit row');
SELECT ok(t05491.auth(t05491.id('uA'), format('select count(*) from public.moderation_actions where tenant_id = %L', t05491.id('TA')))::int >= 2,
          'M3 flag on: a T_A moderator sees its tenant''s audit rows');
SELECT is(t05491.exafy('select count(*) from public.moderation_actions'), (SELECT count(*)::text FROM public.moderation_actions),
          'M3 flag on: exafy_admin still reads every audit row');
-- A tenant whose flag is off keeps today's behaviour (per-tenant rollout).
INSERT INTO auth.users (id, email) VALUES (t05491.id('uR6'), 'u16@example.test');
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES (t05491.id('TC'), t05491.id('uR6'), true);
INSERT INTO public.content_reports (id, reporter_user_id, content_type, content_id, reason) VALUES (t05491.id('n6'), t05491.id('uR6'), 'post', t05491.id('post'), 'T_C report');
SELECT is(t05491.auth(t05491.id('uB'), format('select count(*) from public.content_reports where id = %L', t05491.id('n6'))), '1',
          'M3: a tenant whose flag is off is still readable by any moderator (per-tenant rollout)');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.moderator_tenant_scope_enabled(uuid)'::regprocedure),
          'M3: moderator_tenant_scope_enabled() is SECURITY DEFINER');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('content_reports', 'moderation_actions')
            AND coalesce(qual, '') || coalesce(with_check, '') ~ 'current_tenant_id'), 0,
          'M3: no moderation policy uses a bare current_tenant_id()');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'content_reports'
            AND policyname IN ('Staff and admins can view all reports', 'Staff and admins can update reports', 'Users can create content reports')), 3,
          'M3: the three content_reports policies keep their names');

SELECT * FROM finish();
ROLLBACK;
