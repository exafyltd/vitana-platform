-- VTID-04868 assertions. Runs after vtid_04868_fixture.sql, the current
-- allocator migration (20260628120000) and the VTID-04868 migration (applied
-- twice, to prove it re-runs cleanly). Any failed assertion raises, and the
-- runner uses ON_ERROR_STOP, so the script exits non-zero.
-- Local throwaway Postgres only — never a live database.

-- ---------------------------------------------------------------------------
-- A. Shape: functions, grants, role, config
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  -- 3-arg allocator is gone, exactly one 4-arg allocator with 4 defaults.
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'public' AND p.proname = 'allocate_global_vtid';
  ASSERT n = 1, 'exactly one allocate_global_vtid, found ' || n;
  ASSERT (SELECT pronargs FROM pg_proc WHERE proname = 'allocate_global_vtid') = 4, '4 args';
  ASSERT (SELECT pronargdefaults FROM pg_proc WHERE proname = 'allocate_global_vtid') = 4, 'all 4 args defaulted';
  ASSERT to_regprocedure('public.allocate_global_vtid(text,text,text)') IS NULL, '3-arg dropped';
  ASSERT pg_get_function_arguments('public.allocate_global_vtid(text,text,text,uuid)'::regprocedure)
         LIKE '%p_sparring_id uuid DEFAULT NULL%', 'p_sparring_id DEFAULT NULL';

  -- Grants: service_role only.
  ASSERT NOT has_function_privilege('anon', 'public.allocate_global_vtid(text,text,text,uuid)', 'EXECUTE'), 'anon cannot allocate';
  ASSERT NOT has_function_privilege('authenticated', 'public.allocate_global_vtid(text,text,text,uuid)', 'EXECUTE'), 'authenticated cannot allocate';
  ASSERT has_function_privilege('service_role', 'public.allocate_global_vtid(text,text,text,uuid)', 'EXECUTE'), 'service_role allocates';
  ASSERT NOT has_function_privilege('anon', 'public.submit_plan_sparring_record(uuid,text,text,text,jsonb,text,text,jsonb,text[])', 'EXECUTE'), 'anon cannot submit';
  ASSERT NOT has_function_privilege('authenticated', 'public.submit_plan_sparring_record(uuid,text,text,text,jsonb,text,text,jsonb,text[])', 'EXECUTE'), 'authenticated cannot submit';
  ASSERT has_function_privilege('service_role', 'public.submit_plan_sparring_record(uuid,text,text,text,jsonb,text,text,jsonb,text[])', 'EXECUTE'), 'service_role submits';
  ASSERT NOT has_function_privilege('authenticated', 'public.plan_sparring_append_round(uuid,jsonb)', 'EXECUTE'), 'authenticated cannot append';
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

-- Re-running the migration must not reset a mode set later (the runner passes
-- the migration path as -v migration=...).
UPDATE plan_sparring_config SET mode = 'off';
\i :migration
DO $$ BEGIN
  ASSERT (SELECT mode FROM plan_sparring_config) = 'off', 're-run keeps the mode';
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
   'converged', '99999999-9999-9999-9999-999999999999', now());

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

  -- B2. Valid converged + approved record → ok, session bound, id kept on the row.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000001');
  SELECT * INTO l FROM plan_sparring_shadow_log WHERE vtid = r.vtid;
  ASSERT l.outcome = 'ok' AND l.sparring_id = 'aaaaaaaa-0000-0000-0000-000000000001', 'ok logged: ' || row_to_json(l)::text;
  ASSERT (SELECT vtid FROM plan_sparring_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') = r.vtid, 'session bound';
  ASSERT (SELECT metadata->>'sparring_id' FROM vtid_ledger WHERE vtid = r.vtid) = 'aaaaaaaa-0000-0000-0000-000000000001', 'sparring_id on ledger';
  v := r.vtid;

  -- B3. Escalated + human-approved also counts as valid.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000002');
  ASSERT (SELECT outcome FROM plan_sparring_shadow_log WHERE vtid = r.vtid) = 'ok', 'escalated+approved ok';

  -- B4. Double bind of an already-bound record → invalid, insert still proceeds,
  --     id moved off the indexed key.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000001');
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
  j := plan_sparring_append_round(sid, '{"round":2,"acks":["F1 accepted"]}'::jsonb);
  ASSERT (j->>'round_count')::int = 2, 'appended: ' || j::text;
  ASSERT plan_sparring_append_round(sid, '"x"'::jsonb)->>'error' = 'ROUND_MUST_BE_OBJECT', 'object only';
  ASSERT plan_sparring_append_round('aaaaaaaa-0000-0000-0000-000000000001', '{}'::jsonb)->>'error' = 'SESSION_FROZEN', 'bound session frozen';
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

  -- C5. Valid record → passes and binds.
  SELECT * INTO r FROM allocate_global_vtid('claude-code', 'DEV', 'TASK', 'aaaaaaaa-0000-0000-0000-000000000004');
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

\echo 'VTID-04868: all assertions passed'
