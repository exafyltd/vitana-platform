-- VTID-04868 assertions. Runs after vtid_04868_fixture.sql, the current
-- allocator migration (20260628120000), the VTID-04868 migration and the
-- VTID-04868 hardening migration (20261004120000; both applied twice, to
-- prove they re-run cleanly). Any failed assertion raises, and the
-- runner uses ON_ERROR_STOP, so the script exits non-zero.
-- Local throwaway Postgres only — never a live database.

-- ---------------------------------------------------------------------------
-- A. Shape: functions, grants, role, config
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  -- 3-arg and 4-arg allocators are gone, exactly one 5-arg allocator with 5 defaults.
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'public' AND p.proname = 'allocate_global_vtid';
  ASSERT n = 1, 'exactly one allocate_global_vtid, found ' || n;
  ASSERT (SELECT pronargs FROM pg_proc WHERE proname = 'allocate_global_vtid') = 5, '5 args';
  ASSERT (SELECT pronargdefaults FROM pg_proc WHERE proname = 'allocate_global_vtid') = 5, 'all 5 args defaulted';
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text)') IS NULL, '3-arg dropped';
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text,uuid)') IS NULL, '4-arg dropped';
  ASSERT pg_get_function_arguments('public.allocate_global_vtid(text,text,text,uuid,text)'::regprocedure)
         LIKE '%p_sparring_id uuid DEFAULT NULL%p_plan_hash text DEFAULT NULL%', 'p_sparring_id/p_plan_hash DEFAULT NULL';
  ASSERT (SELECT proconfig FROM pg_proc WHERE proname = 'allocate_global_vtid') @> ARRAY['search_path=public, pg_temp'],
         'allocator search_path pinned';

  -- Exactly one round-append RPC, the 3-arg one.
  ASSERT to_regprocedure('public.plan_sparring_append_round(uuid,jsonb)') IS NULL, '2-arg append dropped';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'plan_sparring_append_round') = 1, 'one append_round';

  -- Grants: service_role only.
  ASSERT NOT has_function_privilege('anon', 'public.allocate_global_vtid(text,text,text,uuid,text)', 'EXECUTE'), 'anon cannot allocate';
  ASSERT NOT has_function_privilege('authenticated', 'public.allocate_global_vtid(text,text,text,uuid,text)', 'EXECUTE'), 'authenticated cannot allocate';
  ASSERT has_function_privilege('service_role', 'public.allocate_global_vtid(text,text,text,uuid,text)', 'EXECUTE'), 'service_role allocates';
  ASSERT NOT has_function_privilege('anon', 'public.plan_sparring_append_round(uuid,jsonb,int)', 'EXECUTE'), 'anon cannot append';
  ASSERT has_function_privilege('service_role', 'public.plan_sparring_append_round(uuid,jsonb,int)', 'EXECUTE'), 'service_role appends';
  ASSERT NOT has_function_privilege('anon', 'public.submit_plan_sparring_record(uuid,text,text,text,jsonb,text,text,jsonb,text[])', 'EXECUTE'), 'anon cannot submit';
  ASSERT NOT has_function_privilege('authenticated', 'public.submit_plan_sparring_record(uuid,text,text,text,jsonb,text,text,jsonb,text[])', 'EXECUTE'), 'authenticated cannot submit';
  ASSERT has_function_privilege('service_role', 'public.submit_plan_sparring_record(uuid,text,text,text,jsonb,text,text,jsonb,text[])', 'EXECUTE'), 'service_role submits';
  ASSERT NOT has_function_privilege('authenticated', 'public.plan_sparring_append_round(uuid,jsonb,int)', 'EXECUTE'), 'authenticated cannot append';
  ASSERT NOT has_function_privilege('authenticated', 'public._plan_sparring_gate_eval(text,jsonb,text)', 'EXECUTE'), 'authenticated cannot call eval';

  -- Tables: nothing for anon/authenticated; no rounds UPDATE, no DELETE for service_role.
  ASSERT NOT has_table_privilege('anon', 'public.plan_sparring_sessions', 'SELECT'), 'anon no sessions';
  ASSERT NOT has_table_privilege('authenticated', 'public.plan_sparring_sessions', 'SELECT,INSERT,UPDATE,DELETE'), 'authenticated no sessions';
  ASSERT NOT has_table_privilege('authenticated', 'public.plan_sparring_config', 'SELECT,UPDATE'), 'authenticated no config';
  ASSERT NOT has_table_privilege('authenticated', 'public.plan_sparring_shadow_log', 'SELECT,INSERT'), 'authenticated no shadow log';
  ASSERT NOT has_column_privilege('service_role', 'public.plan_sparring_sessions', 'rounds', 'UPDATE'), 'rounds not updatable';
  ASSERT NOT has_column_privilege('service_role', 'public.plan_sparring_sessions', 'rounds', 'INSERT'), 'rounds not insertable';
  ASSERT NOT has_table_privilege('service_role', 'public.plan_sparring_sessions', 'DELETE'), 'no session delete';
  ASSERT NOT has_table_privilege('service_role', 'public.plan_sparring_config', 'UPDATE,INSERT,DELETE'), 'service_role cannot change mode';
  ASSERT NOT has_table_privilege('service_role', 'public.plan_sparring_shadow_log', 'INSERT,UPDATE,DELETE'), 'service_role cannot forge the log';
  ASSERT (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN
          ('plan_sparring_sessions','plan_sparring_config','plan_sparring_shadow_log')), 'RLS on';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename LIKE 'plan_sparring_%'
                      AND (roles && ARRAY['anon','authenticated','public']::name[])), 'no anon/authenticated policies';

  -- Role: NOLOGIN, held by nobody.
  ASSERT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vitana_governance_owner' AND NOT rolcanlogin), 'role NOLOGIN';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
                      WHERE r.rolname = 'vitana_governance_owner'), 'role granted to nobody';
  ASSERT NOT pg_has_role('service_role', 'vitana_governance_owner', 'MEMBER'), 'service_role is not the owner';

  -- Config: one row, log mode.
  ASSERT (SELECT count(*) FROM plan_sparring_config) = 1, 'one config row';
  ASSERT (SELECT mode FROM plan_sparring_config WHERE id = 1) = 'log', 'log mode';

  -- Trigger present and enabled, partial unique index present.
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_plan_sparring_check'
                  AND tgrelid = 'public.vtid_ledger'::regclass AND tgenabled = 'O'), 'trigger enabled';
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'vtid_ledger_sparring_id_unique'
                  AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%'), 'partial unique index';

  -- Existing rows were not logged by the migration.
  ASSERT (SELECT count(*) FROM plan_sparring_shadow_log) = 0, 'empty shadow log after migration';
END $$;

-- Re-running the migrations must not reset a mode set later (the runner passes
-- the migration paths as -v migration=... -v hardening=...). The hardening
-- migration is re-applied after the first one, as it is in deployment order.
UPDATE plan_sparring_config SET mode = 'off';
\i :migration
\i :hardening
DO $$ BEGIN
  ASSERT (SELECT mode FROM plan_sparring_config) = 'off', 're-run keeps the mode';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'allocate_global_vtid') = 1, 're-run: one allocator';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'plan_sparring_append_round') = 1, 're-run: one append_round';
END $$;
UPDATE plan_sparring_config SET mode = 'log';

-- Fixture sessions (written as the gateway would, service_role).
SET ROLE service_role;
INSERT INTO plan_sparring_sessions (id, plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier,
                                    verdict, human_approved_by, human_approved_at)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', gen_random_uuid(), repeat('a', 64), repeat('b', 64), 'claude-code', 'standard', 'gateway',
   'converged', '99999999-9999-9999-9999-999999999999', now()),
  ('aaaaaaaa-0000-0000-0000-000000000002', gen_random_uuid(), repeat('c', 64), repeat('d', 64), 'operator-chat', 'light', 'gateway',
   'escalated', '99999999-9999-9999-9999-999999999999', now()),
  ('aaaaaaaa-0000-0000-0000-000000000003', gen_random_uuid(), repeat('e', 64), NULL, 'claude-code', 'standard', 'gateway',
   'converged', NULL, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000004', gen_random_uuid(), repeat('f', 64), repeat('0', 64), 'claude-code', 'expedited', 'gateway',
   'converged', '99999999-9999-9999-9999-999999999999', now()),
  ('aaaaaaaa-0000-0000-0000-000000000005', gen_random_uuid(), repeat('1', 64), repeat('2', 64), 'claude-code', 'standard', 'gateway',
   'converged', '99999999-9999-9999-9999-999999999999', now()),
  ('aaaaaaaa-0000-0000-0000-000000000006', gen_random_uuid(), repeat('7', 64), NULL, 'claude-code', 'standard', 'gateway',
   'in_progress', NULL, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000007', gen_random_uuid(), repeat('8', 64), repeat('9', 64), 'claude-code', 'standard', 'gateway',
   'converged', '99999999-9999-9999-9999-999999999999', now()),
  ('aaaaaaaa-0000-0000-0000-000000000008', gen_random_uuid(), repeat('a', 63) || '1', repeat('c', 63) || '1', 'claude-code', 'standard', 'gateway',
   'converged', '99999999-9999-9999-9999-999999999999', now());

-- Finding 1: the gateway's session insert (no `rounds` key) works as
-- service_role; the column default supplies '[]'.
INSERT INTO plan_sparring_sessions (plan_id, plan_hash, producer, change_class, trust_tier, base_ref,
                                    verdict, model_log, escalation_reasons)
VALUES (gen_random_uuid(), repeat('e', 63) || '1', 'claude-code', 'standard', 'gateway', repeat('0', 40),
        'in_progress', '[]'::jsonb, '{}');
DO $$ BEGIN
  ASSERT (SELECT rounds FROM plan_sparring_sessions WHERE plan_hash = repeat('e', 63) || '1') = '[]'::jsonb,
         'insert without rounds: default []';
  BEGIN
    INSERT INTO plan_sparring_sessions (plan_id, plan_hash, producer, change_class, trust_tier, rounds)
    VALUES (gen_random_uuid(), repeat('e', 63) || '2', 'claude-code', 'standard', 'gateway', '[]'::jsonb);
    RAISE EXCEPTION 'expected permission denied inserting rounds';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- B. LOG mode — never raises, records ok|missing|invalid|exempt
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; v text; m jsonb; l record;
BEGIN
  -- B1. Existing 3-positional-arg callers keep working; no record → missing.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK');
  ASSERT r.vtid ~ '^VTID-\d{5}$', 'allocated ' || r.vtid;
  SELECT * INTO l FROM plan_sparring_shadow_log WHERE vtid = r.vtid;
  ASSERT l.outcome = 'missing' AND l.detail->>'mode' = 'log', 'missing logged: ' || row_to_json(l)::text;
  ASSERT (SELECT metadata FROM vtid_ledger WHERE vtid = r.vtid) ? 'allocator_version', 'shell row shape unchanged';
  ASSERT NOT ((SELECT metadata FROM vtid_ledger WHERE vtid = r.vtid) ? 'sparring_id'), 'no sparring_id key';

  -- B1b. Named-arg PostgREST call shape.
  SELECT * INTO r FROM allocate_global_vtid(p_source => 'operator-console', p_layer => 'DEV', p_module => 'operator-onramp');
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'missing', 'named args → missing';

  -- B2. Valid converged + approved record + matching plan hash → ok, session
  --     bound, id and hash kept on the row.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000001', repeat('b', 64));
  SELECT * INTO l FROM plan_sparring_shadow_log WHERE vtid = r.vtid;
  ASSERT l.outcome = 'ok' AND l.sparring_id = 'aaaaaaaa-0000-0000-0000-000000000001', 'ok logged: ' || row_to_json(l)::text;
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') = r.vtid, 'session bound';
  ASSERT (SELECT metadata->>'sparring_id' FROM vtid_ledger WHERE vtid = r.vtid) = 'aaaaaaaa-0000-0000-0000-000000000001', 'sparring_id on ledger';
  ASSERT (SELECT metadata->>'plan_hash' FROM vtid_ledger WHERE vtid = r.vtid) = repeat('b', 64), 'plan_hash on ledger';
  v := r.vtid;

  -- B3. Escalated + human-approved also counts as valid.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000002', repeat('d', 64));
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'ok', 'escalated+approved ok';

  -- B4. Double bind of an already-bound record → invalid, insert still proceeds,
  --     id moved off the indexed key.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000001', repeat('b', 64));
  SELECT * INTO l FROM plan_sparring_shadow_log WHERE vtid = r.vtid;
  ASSERT l.outcome = 'invalid' AND l.detail->>'reason' = 'session_bound_to_other_vtid', 'double bind: ' || row_to_json(l)::text;
  m := (SELECT metadata FROM vtid_ledger WHERE vtid = r.vtid);
  ASSERT NOT (m ? 'sparring_id') AND m->>'sparring_id_unverified' = 'aaaaaaaa-0000-0000-0000-000000000001', 'moved: ' || m::text;
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') = v, 'first binding kept';

  -- B5. Not human-approved → invalid.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000003');
  ASSERT (SELECT detail->>'reason' FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'not_human_approved', 'unapproved';
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000003') IS NULL, 'unapproved not bound';

  -- B6. Unknown record → invalid / session_not_found.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'bbbbbbbb-0000-0000-0000-000000000000');
  ASSERT (SELECT detail->>'reason' FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'session_not_found', 'unknown record';

  -- B6b. Approved record, plan hash MISSING (4-arg-shaped call) → invalid,
  --      never raises, id moved off the indexed key, session stays unbound.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000007');
  SELECT * INTO l FROM plan_sparring_shadow_log WHERE vtid = r.vtid;
  ASSERT l.outcome = 'invalid' AND l.detail->>'reason' = 'plan_hash_missing', 'hash missing: ' || row_to_json(l)::text;
  m := (SELECT metadata FROM vtid_ledger WHERE vtid = r.vtid);
  ASSERT NOT (m ? 'sparring_id') AND m->>'sparring_id_unverified' = 'aaaaaaaa-0000-0000-0000-000000000007', 'hash missing moved: ' || m::text;
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000007') IS NULL, 'hash missing: not bound';

  -- B6c. Approved record, plan hash of a DIFFERENT plan (the session's
  --      original plan_hash, not the approved final one) → invalid.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000007', repeat('8', 64));
  SELECT * INTO l FROM plan_sparring_shadow_log WHERE vtid = r.vtid;
  ASSERT l.outcome = 'invalid' AND l.detail->>'reason' = 'plan_hash_mismatch', 'hash mismatch: ' || row_to_json(l)::text;
  ASSERT l.detail->>'plan_hash' = repeat('8', 64), 'presented hash logged';
  m := (SELECT metadata FROM vtid_ledger WHERE vtid = r.vtid);
  ASSERT NOT (m ? 'sparring_id') AND m->>'sparring_id_unverified' = 'aaaaaaaa-0000-0000-0000-000000000007', 'hash mismatch moved: ' || m::text;
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000007') IS NULL, 'hash mismatch: not bound';

  -- B6d. Same record, now with the approved final_plan_hash → ok and bound.
  SELECT * INTO r FROM allocate_global_vtid(p_source => 'claude-code', p_layer => 'DEV', p_module => 'TASK',
                                            p_sparring_id => 'aaaaaaaa-0000-0000-0000-000000000007', p_plan_hash => repeat('9', 64));
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'ok', 'matching hash ok';
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000007') = r.vtid, 'matching hash binds';
END $$;

-- B7. Attested submission can never self-approve; pending record → invalid.
DO $$
DECLARE j jsonb; r record; sid uuid;
BEGIN
  j := submit_plan_sparring_record(gen_random_uuid(), repeat('3', 64), 'claude-code', 'standard',
                                   '[{"round":1,"findings":["F1 verbatim"]}]'::jsonb, 'abc123', repeat('4', 64));
  ASSERT (j->>'ok')::boolean AND j->>'verdict' = 'pending_human_approval', 'submitted: ' || j::text;
  sid := (j->>'id')::uuid;
  ASSERT (SELECT trust_tier = 'attested' AND verdict = 'pending_human_approval' AND human_approved_by IS NULL
                 AND human_approved_at IS NULL FROM plan_sparring_sessions WHERE id = sid), 'attested, unapproved';
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', sid);
  ASSERT (SELECT detail->>'reason' FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'verdict_pending_human_approval', 'pending is invalid';

  -- idempotent
  j := submit_plan_sparring_record((SELECT plan_id FROM plan_sparring_sessions WHERE id = sid), repeat('3', 64), 'claude-code', 'standard');
  ASSERT (j->>'duplicate')::boolean AND (j->>'id')::uuid = sid, 'duplicate submit: ' || j::text;

  -- bad input
  ASSERT submit_plan_sparring_record(gen_random_uuid(), 'nothex', 'x', 'standard')->>'error' = 'INVALID_PLAN_HASH', 'hash checked';
  ASSERT submit_plan_sparring_record(gen_random_uuid(), repeat('5', 64), 'x', 'huge')->>'error' = 'INVALID_CHANGE_CLASS', 'class checked';

  -- No verdict / approval parameter exists at all.
  BEGIN
    PERFORM submit_plan_sparring_record(p_plan_id => gen_random_uuid(), p_plan_hash => repeat('6', 64),
                                        p_producer => 'x', p_change_class => 'light', p_verdict => 'converged');
    RAISE EXCEPTION 'expected undefined_function for p_verdict';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  -- Rounds: append-only through the RPC; direct UPDATE refused.
  -- An in_progress session takes round 1, then round 2, in order.
  j := plan_sparring_append_round('aaaaaaaa-0000-0000-0000-000000000006', '{"round":1,"findings":["F1"]}'::jsonb, 1);
  ASSERT (j->>'ok')::boolean AND (j->>'round_count')::int = 1, 'appended round 1: ' || j::text;
  -- A stale / duplicate append of round 1 (two racing POST /:id/rounds) → PS409.
  BEGIN
    PERFORM plan_sparring_append_round('aaaaaaaa-0000-0000-0000-000000000006', '{"round":1,"dup":true}'::jsonb, 1);
    RAISE EXCEPTION 'expected round_conflict for duplicate round 1';
  EXCEPTION WHEN SQLSTATE 'PS409' THEN
    ASSERT SQLERRM LIKE 'round_conflict:%', 'conflict message: ' || SQLERRM;
  END;
  -- Skipping ahead is refused too.
  BEGIN
    PERFORM plan_sparring_append_round('aaaaaaaa-0000-0000-0000-000000000006', '{"round":3}'::jsonb, 3);
    RAISE EXCEPTION 'expected round_conflict for round 3';
  EXCEPTION WHEN SQLSTATE 'PS409' THEN NULL;
  END;
  j := plan_sparring_append_round('aaaaaaaa-0000-0000-0000-000000000006', '{"round":2,"acks":["F1 accepted"]}'::jsonb, 2);
  ASSERT (j->>'round_count')::int = 2, 'appended round 2: ' || j::text;
  ASSERT jsonb_array_length((SELECT rounds FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000006')) = 2,
         'duplicate never landed';
  -- A session that is no longer in_progress (attested pending record) → PS409.
  BEGIN
    PERFORM plan_sparring_append_round(sid, '{"round":2}'::jsonb, 2);
    RAISE EXCEPTION 'expected round_conflict for a pending_human_approval session';
  EXCEPTION WHEN SQLSTATE 'PS409' THEN NULL;
  END;
  ASSERT plan_sparring_append_round(sid, '"x"'::jsonb, 2)->>'error' = 'ROUND_MUST_BE_OBJECT', 'object only';
  ASSERT plan_sparring_append_round(sid, '{}'::jsonb, NULL)->>'error' = 'EXPECTED_ROUND_REQUIRED', 'expected round required';
  ASSERT plan_sparring_append_round('aaaaaaaa-0000-0000-0000-000000000001', '{}'::jsonb, 1)->>'error' = 'SESSION_FROZEN', 'bound session frozen';
  -- The old 2-arg signature no longer exists.
  BEGIN
    PERFORM plan_sparring_append_round(sid, '{}'::jsonb);
    RAISE EXCEPTION 'expected undefined_function for the 2-arg append';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
  BEGIN
    UPDATE plan_sparring_sessions SET rounds = '[]'::jsonb WHERE id = sid;
    RAISE EXCEPTION 'expected permission denied on rounds';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM plan_sparring_sessions WHERE id = sid;
    RAISE EXCEPTION 'expected permission denied on delete';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE plan_sparring_config SET mode = 'off';
    RAISE EXCEPTION 'expected permission denied on config';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO plan_sparring_shadow_log (vtid, outcome) VALUES ('VTID-00001', 'ok');
    RAISE EXCEPTION 'expected permission denied on shadow log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- B8. Upsert path: an existing VTID passes without a new log row.
DO $$
DECLARE before int;
BEGIN
  before := (SELECT count(*) FROM plan_sparring_shadow_log);
  INSERT INTO vtid_ledger (vtid, title, status, metadata) VALUES ('VTID-04800', 'upserted', 'in_progress', '{}')
  ON CONFLICT (vtid) DO UPDATE SET title = EXCLUDED.title;
  ASSERT (SELECT title FROM vtid_ledger WHERE vtid = 'VTID-04800') = 'upserted', 'upsert applied';
  ASSERT (SELECT count(*) FROM plan_sparring_shadow_log) = before, 'upsert not logged';
END $$;

-- B9. service_role cannot claim break-glass: exempt reason without the role → invalid.
DO $$ BEGIN
  INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-09001', 'direct', '{"sparring_exempt_reason":"incident"}');
  ASSERT (SELECT outcome || '/' || (detail->>'reason') FROM plan_sparring_shadow_log WHERE vtid = 'VTID-09001')
         = 'invalid/exempt_reason_without_governance_role', 'exempt needs the role';
  ASSERT (SELECT detail->>'actor' FROM plan_sparring_shadow_log WHERE vtid = 'VTID-09001') = 'service_role', 'actor recorded';
END $$;
RESET ROLE;

-- B10. Break-glass as vitana_governance_owner → exempt.
SET ROLE vitana_governance_owner;
INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-09002', 'break-glass', '{"sparring_exempt_reason":"P1: gateway down"}');
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = 'VTID-09002') = 'exempt', 'exempt logged';
  ASSERT (SELECT detail->>'exempt_reason' FROM plan_sparring_shadow_log WHERE vtid = 'VTID-09002') = 'P1: gateway down', 'reason kept';
END $$;

-- B11. LOG mode never raises even if the gate itself fails.
REVOKE EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) FROM service_role;
SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-09003', 'gate broken', '{}');
  ASSERT EXISTS (SELECT 1 FROM vtid_ledger WHERE vtid = 'VTID-09003'), 'insert proceeded';
  ASSERT NOT EXISTS (SELECT 1 FROM plan_sparring_shadow_log WHERE vtid = 'VTID-09003'), 'nothing logged (warning only)';
END $$;
RESET ROLE;
GRANT EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) TO service_role;

-- B12. Mode off: nothing evaluated, nothing logged.
UPDATE plan_sparring_config SET mode = 'off';
SET ROLE service_role;
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK');
  ASSERT NOT EXISTS (SELECT 1 FROM plan_sparring_shadow_log WHERE vtid = r.vtid), 'off: not logged';
END $$;
RESET ROLE;

-- B13. The partial unique index: one sparring_id binds one VTID (mode off, so
-- the gate does not rewrite the metadata).
DO $$ BEGIN
  INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-09004', 'dup', '{"sparring_id":"aaaaaaaa-0000-0000-0000-000000000001"}');
  RAISE EXCEPTION 'expected unique_violation';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- C. ENFORCE mode (implemented and tested, NOT enabled by the migration)
-- ---------------------------------------------------------------------------
UPDATE plan_sparring_config SET mode = 'enforce';
SET ROLE service_role;
DO $$ DECLARE r record; n int; BEGIN
  n := (SELECT count(*) FROM vtid_ledger);
  -- C1. No record → raises, nothing inserted.
  BEGIN
    PERFORM allocate_global_vtid('claude-code', 'DEV', 'TASK');
    RAISE EXCEPTION 'expected enforce to raise';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- C2. Unapproved record → raises.
  BEGIN
    PERFORM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000003');
    RAISE EXCEPTION 'expected enforce to raise (unapproved)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- C3. Already-bound record → raises.
  BEGIN
    PERFORM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'expected enforce to raise (double bind)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- C4. Exempt reason without the role → raises.
  BEGIN
    INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-09005', 'x', '{"sparring_exempt_reason":"x"}');
    RAISE EXCEPTION 'expected enforce to raise (exempt w/o role)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM vtid_ledger) = n, 'nothing inserted while enforcing';

  -- C4b. Approved record without / with the wrong plan hash → raises.
  BEGIN
    PERFORM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000004');
    RAISE EXCEPTION 'expected enforce to raise (plan hash missing)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000004', repeat('f', 64));
    RAISE EXCEPTION 'expected enforce to raise (plan hash mismatch)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM vtid_ledger) = n, 'nothing inserted while enforcing (hash)';
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000004') IS NULL, 'enforce: not bound by a bad hash';

  -- C5. Valid record + approved plan hash → passes and binds.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000004', repeat('0', 64));
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000004') = r.vtid, 'enforce ok binds';
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'ok', 'enforce ok logged';

  -- C6. Upsert of an existing VTID passes.
  INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-04801', 'upserted', '{}')
  ON CONFLICT (vtid) DO UPDATE SET title = EXCLUDED.title;
  ASSERT (SELECT title FROM vtid_ledger WHERE vtid = 'VTID-04801') = 'upserted', 'enforce upsert passes';
END $$;
RESET ROLE;

-- C7. Break-glass passes while enforcing.
SET ROLE vitana_governance_owner;
INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-09006', 'break-glass', '{"sparring_exempt_reason":"P1"}');
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = 'VTID-09006') = 'exempt', 'enforce exempt';
END $$;

-- C8. A broken gate fails CLOSED while enforcing.
REVOKE EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) FROM service_role;
SET ROLE service_role;
DO $$ BEGIN
  BEGIN
    -- (allocate_global_vtid runs as its owner, who keeps EXECUTE, so the
    -- broken-gate case is a direct service_role insert.)
    INSERT INTO vtid_ledger (vtid, title, metadata) VALUES ('VTID-09007', 'x', '{"sparring_id":"aaaaaaaa-0000-0000-0000-000000000005"}');
    RAISE EXCEPTION 'expected fail-closed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT NOT EXISTS (SELECT 1 FROM vtid_ledger WHERE vtid = 'VTID-09007'), 'fail-closed: not inserted';
END $$;
RESET ROLE;
GRANT EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) TO service_role;

UPDATE plan_sparring_config SET mode = 'log';

-- Reconciler status RPC: present + enabled ('O'); flips when the trigger is disabled.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.plan_sparring_trigger_status();
  ASSERT r.present AND r.tgenabled = 'O', 'trigger_status: present and enabled';
  ALTER TABLE vtid_ledger DISABLE TRIGGER trg_plan_sparring_check;
  SELECT * INTO r FROM public.plan_sparring_trigger_status();
  ASSERT r.present AND r.tgenabled = 'D', 'trigger_status: disabled is visible';
  ALTER TABLE vtid_ledger ENABLE TRIGGER trg_plan_sparring_check;
END $$;

-- ---------------------------------------------------------------------------
-- D. Collision-skipping allocator (restored 20260628120000 loop)
-- ---------------------------------------------------------------------------
SET ROLE service_role;
DO $$
DECLARE n bigint; r record; before int;
BEGIN
  -- D1. The next sequence value is already taken by an out-of-band row →
  --     allocation skips it instead of failing on vtid_ledger_vtid_unique.
  n := nextval('global_vtid_seq');             -- consumed; next draw is n + 1
  INSERT INTO vtid_ledger (vtid, title, metadata)
  VALUES ('VTID-' || lpad((n + 1)::text, 5, '0'), 'out-of-band', '{"source":"self-healing"}'),
         ('VTID-' || lpad((n + 2)::text, 5, '0'), 'out-of-band', '{"source":"self-healing"}');
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK');
  ASSERT r.num = n + 3, 'skipped taken slots: got ' || r.num || ', expected ' || (n + 3);
  ASSERT r.vtid = 'VTID-' || lpad((n + 3)::text, 5, '0'), 'vtid matches num';
  ASSERT (SELECT title FROM vtid_ledger WHERE vtid = 'VTID-' || lpad((n + 1)::text, 5, '0')) = 'out-of-band', 'taken row untouched';
  ASSERT (SELECT metadata->>'allocator_version' FROM vtid_ledger WHERE vtid = r.vtid) = 'VTID-0542', 'shell row shape';
  ASSERT (SELECT status FROM vtid_ledger WHERE vtid = r.vtid) = 'allocated', 'shell row status';

  -- D2. 1000 taken slots in a row → fails loudly with unique_violation,
  --     inserts nothing.
  n := nextval('global_vtid_seq');
  INSERT INTO vtid_ledger (vtid, title, metadata)
  SELECT 'VTID-' || lpad(g::text, 5, '0'), 'blocked', '{}'::jsonb FROM generate_series(n + 1, n + 1000) g;
  before := (SELECT count(*) FROM vtid_ledger);
  BEGIN
    PERFORM allocate_global_vtid('claude-code', 'DEV', 'TASK');
    RAISE EXCEPTION 'expected unique_violation after 1000 taken slots';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM LIKE 'allocate_global_vtid: no free VTID slot found in 1000 tries%', 'loud failure: ' || SQLERRM;
  END;
  ASSERT (SELECT count(*) FROM vtid_ledger) = before, 'nothing inserted on exhaustion';

  -- D3. And the next call finds the free slot right after the blocked range.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK');
  ASSERT r.num = n + 1001, 'resumes after the blocked range: ' || r.num;
END $$;
RESET ROLE;

\echo 'VTID-04868: all assertions passed'
