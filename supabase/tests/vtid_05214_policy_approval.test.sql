-- VTID-05214 assertions: policy approval of converged plans + Project Manager tables.
-- Runs after vtid_04868_fixture.sql, the prior allocator, both VTID-04868 migrations and the VTID-05214 migration
-- (applied twice). Local throwaway Postgres only — never a live database.

DO $$ BEGIN
  ASSERT has_column_privilege('service_role', 'public.plan_sparring_sessions', 'approval_policy', 'INSERT'), 'insert approval_policy';
  ASSERT has_column_privilege('service_role', 'public.plan_sparring_sessions', 'policy_approved_at', 'UPDATE'), 'update policy_approved_at';
  ASSERT NOT has_column_privilege('service_role', 'public.plan_sparring_sessions', 'rounds', 'UPDATE'), 'rounds still not updatable';
  ASSERT NOT has_table_privilege('authenticated', 'public.pm_digests', 'SELECT,INSERT'), 'authenticated no pm_digests';
  ASSERT NOT has_table_privilege('anon', 'public.pm_lease', 'SELECT,UPDATE'), 'anon no pm_lease';
  ASSERT NOT has_table_privilege('service_role', 'public.pm_digests', 'UPDATE,DELETE'), 'pm_digests append-only';
  ASSERT (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('pm_digests', 'pm_lease')), 'RLS on pm tables';
  ASSERT (SELECT count(*) FROM pm_lease) = 1, 'one lease row';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'plan_sparring_append_round') = 1, 'one append_round';
END $$;

SET ROLE service_role;
INSERT INTO plan_sparring_sessions (id, plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier,
                                    verdict, approval_policy)
VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), repeat('3', 64), repeat('4', 64), 'ci-plan-spar:x', 'standard', 'gateway', 'converged', 'converged-auto-v1'),
  ('bbbbbbbb-0000-0000-0000-000000000002', gen_random_uuid(), repeat('5', 64), repeat('6', 64), 'ci-plan-spar:y', 'standard', 'gateway', 'escalated', 'converged-auto-v1'),
  ('bbbbbbbb-0000-0000-0000-000000000003', gen_random_uuid(), repeat('7', 63) || '0', repeat('8', 63) || '0', 'claude-code', 'standard', 'gateway', 'converged', NULL),
  ('bbbbbbbb-0000-0000-0000-000000000004', gen_random_uuid(), repeat('9', 63) || '0', NULL, 'ci-plan-spar:z', 'standard', 'gateway', 'in_progress', 'converged-auto-v1');

DO $$ BEGIN
  -- P1. A converged session that asked for the policy can be policy-approved.
  UPDATE plan_sparring_sessions SET policy_approved_at = now(), policy_approval_rule = 'converged-auto-v1'
   WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001';
  -- P2. Escalated → CHECK refuses.
  BEGIN
    UPDATE plan_sparring_sessions SET policy_approved_at = now(), policy_approval_rule = 'converged-auto-v1'
     WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'expected check_violation (escalated)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- P3. Converged but never asked for the policy → refused.
  BEGIN
    UPDATE plan_sparring_sessions SET policy_approved_at = now(), policy_approval_rule = 'converged-auto-v1'
     WHERE id = 'bbbbbbbb-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'expected check_violation (no policy)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- P4. Unknown policy name → refused.
  BEGIN
    UPDATE plan_sparring_sessions SET approval_policy = 'yolo' WHERE id = 'bbbbbbbb-0000-0000-0000-000000000004';
    RAISE EXCEPTION 'expected check_violation (unknown policy)';
  EXCEPTION WHEN check_violation OR insufficient_privilege THEN NULL;
  END;
  -- P5. A policy-approved session is frozen for round appends.
  ASSERT (plan_sparring_append_round('bbbbbbbb-0000-0000-0000-000000000001', '{"round":1}'::jsonb, 1))->>'error' = 'SESSION_FROZEN',
         'policy-approved session frozen';
END $$;

-- G. The gate: log mode binds a policy-approved converged session; enforce mode accepts it, refuses the others.
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM allocate_global_vtid('ci-plan-spar', 'DEV', 'X', 'bbbbbbbb-0000-0000-0000-000000000001', repeat('4', 64));
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'ok', 'log: policy approval ok';
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001') = r.vtid, 'log: bound';
  SELECT * INTO r FROM allocate_global_vtid('ci-plan-spar', 'DEV', 'X', 'bbbbbbbb-0000-0000-0000-000000000003', repeat('8', 63) || '0');
  ASSERT (SELECT detail->>'reason' FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'not_human_approved', 'log: unapproved still refused';
END $$;
RESET ROLE;
UPDATE plan_sparring_config SET mode = 'enforce';
INSERT INTO plan_sparring_sessions (id, plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier, verdict, approval_policy,
                                    policy_approved_at, policy_approval_rule)
VALUES ('bbbbbbbb-0000-0000-0000-000000000005', gen_random_uuid(), repeat('a', 62) || '00', repeat('b', 62) || '00', 'ci-plan-spar:w',
        'standard', 'gateway', 'converged', 'converged-auto-v1', now(), 'converged-auto-v1');
SET ROLE service_role;
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM allocate_global_vtid('ci-plan-spar', 'DEV', 'X', 'bbbbbbbb-0000-0000-0000-000000000005', repeat('b', 62) || '00');
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'ok', 'enforce: policy approval ok';
  BEGIN
    PERFORM allocate_global_vtid('ci-plan-spar', 'DEV', 'X', 'bbbbbbbb-0000-0000-0000-000000000004', repeat('9', 63) || '0');
    RAISE EXCEPTION 'expected enforce to raise (in_progress)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
UPDATE plan_sparring_config SET mode = 'log';

-- L. The PM lease: one holder at a time.
SET ROLE service_role;
DO $$ DECLARE n int; BEGIN
  UPDATE pm_lease SET holder = 'task-a', expires_at = now() + interval '9 minutes' WHERE id = 1 AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; ASSERT n = 1, 'first tick takes the lease';
  UPDATE pm_lease SET holder = 'task-b', expires_at = now() + interval '9 minutes' WHERE id = 1 AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT; ASSERT n = 0, 'second task does not';
  INSERT INTO pm_digests (kind, mode, payload) VALUES ('decision', 'dry_run', '{"x":1}');
  BEGIN
    INSERT INTO pm_digests (kind, mode) VALUES ('nope', 'dry_run');
    RAISE EXCEPTION 'expected check_violation (kind)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
RESET ROLE;
SELECT 'VTID-05214: all assertions passed';
