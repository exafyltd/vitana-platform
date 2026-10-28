-- VTID-05012: assertions after the base (VTID-04754) and VTID-05012 migrations. Local Postgres only.
\set ON_ERROR_STOP 1
BEGIN;

-- Existing outcome values still insert; 'skipped' now does, with a reason.
INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, system_action, agreed, created_at)
VALUES ('g1','d','shadow','internal','t','s1','decided','a', true,  now() - interval '1 day'),
       ('g1','d','shadow','internal','t','s2','abstained','a', NULL, now() - interval '1 day');
UPDATE public.jev_shadow_decisions SET lean_agreed = true WHERE subject_ref = 's2';
INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, skip_reason, system_action)
VALUES ('g1','d','shadow','internal','t','s3','skipped','no_ci_evidence','a');

-- Same (gate, subject_ref, skip_reason) again: rejected by the partial unique index.
DO $$ BEGIN
  INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, skip_reason, system_action)
  VALUES ('g1','d','shadow','internal','t','s3','skipped','no_ci_evidence','a');
  RAISE EXCEPTION 'duplicate skip was accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;

-- A different reason for the same subject is a new row; non-skipped rows are not constrained.
INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, skip_reason, system_action)
VALUES ('g1','d','shadow','internal','t','s3','skipped','error','a');
INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, system_action)
VALUES ('g1','d','shadow','internal','t','s1','decided','a');

-- skipped needs a reason; a reason needs skipped; unknown outcome rejected.
DO $$ BEGIN
  INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, system_action)
  VALUES ('g1','d','shadow','internal','t','s9','skipped','a');
  RAISE EXCEPTION 'skipped without reason was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, skip_reason, system_action)
  VALUES ('g1','d','shadow','internal','t','s9','decided','x','a');
  RAISE EXCEPTION 'reason on a decided row was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO public.jev_shadow_decisions (gate, decision, mode, plane, subject_type, subject_ref, jev_outcome, system_action)
  VALUES ('g1','d','shadow','internal','t','s9','unknown','a');
  RAISE EXCEPTION 'unknown outcome was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- The RPC: calls excludes skipped rows; new fields present.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.jev_shadow_gate_stats(14) WHERE gate = 'g1';
  IF r.calls <> 3 THEN RAISE EXCEPTION 'calls=% (want 3)', r.calls; END IF;
  IF r.decided <> 2 THEN RAISE EXCEPTION 'decided=% (want 2)', r.decided; END IF;
  IF r.with_outcome <> 1 OR r.agreed <> 1 OR r.agreement_rate <> 1 THEN RAISE EXCEPTION 'agreement changed: % % %', r.with_outcome, r.agreed, r.agreement_rate; END IF;
  IF r.skipped <> 2 THEN RAISE EXCEPTION 'skipped=% (want 2)', r.skipped; END IF;
  IF r.lean_compared <> 1 OR r.lean_agreed <> 1 THEN RAISE EXCEPTION 'lean % %', r.lean_compared, r.lean_agreed; END IF;
  IF r.last_row_at IS NULL OR r.last_row_at < now() - interval '1 minute' THEN RAISE EXCEPTION 'last_row_at=%', r.last_row_at; END IF;
END $$;

-- Grants: service_role only.
DO $$ BEGIN
  IF NOT has_function_privilege('service_role', 'public.jev_shadow_gate_stats(int)', 'EXECUTE') THEN RAISE EXCEPTION 'service_role lost EXECUTE'; END IF;
  IF has_function_privilege('anon', 'public.jev_shadow_gate_stats(int)', 'EXECUTE') THEN RAISE EXCEPTION 'anon can EXECUTE'; END IF;
  IF has_function_privilege('authenticated', 'public.jev_shadow_gate_stats(int)', 'EXECUTE') THEN RAISE EXCEPTION 'authenticated can EXECUTE'; END IF;
END $$;

ROLLBACK;
\echo 'VTID-05012 SQL assertions passed'
