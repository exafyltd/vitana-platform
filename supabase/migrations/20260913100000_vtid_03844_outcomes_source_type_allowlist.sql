-- VTID-03844: dev_autopilot_outcomes.source_type CHECK must match the
-- executor-lane allowlist.
--
-- The table was created (20260427100000_BOOTSTRAP_autopilot_realign_substrate)
-- with CHECK (source_type IN ('dev_autopilot', 'dev_autopilot_impact')).
-- VTID-02984 later made autopilot-executable-source-types.ts the single
-- place that lists which recommendation source_types may enter the executor
-- lane, and VTID-03820 added 'operator_onramp' to it — but this constraint
-- never followed, and recordOutcome() had its own hard-coded copy of the
-- original pair, so on-ramp executions never produced an outcome row.
--
-- This widens the CHECK to the full allowlist. Keep the list here in sync
-- with EXECUTABLE_RECOMMENDATION_SOURCE_TYPES; a gateway test
-- (test/vtid-03844-outcomes-record-operator-onramp.test.ts) reads this file
-- and fails if the two drift.

ALTER TABLE public.dev_autopilot_outcomes
  DROP CONSTRAINT IF EXISTS dev_autopilot_outcomes_source_type_check;

ALTER TABLE public.dev_autopilot_outcomes
  ADD CONSTRAINT dev_autopilot_outcomes_source_type_check
  CHECK (source_type IN (
    'missing-test-scanner',
    'test-contract-failure-scanner',
    'dev_autopilot',
    'dev_autopilot_impact',
    'operator_onramp'
  ));

COMMENT ON CONSTRAINT dev_autopilot_outcomes_source_type_check
  ON public.dev_autopilot_outcomes IS
  'VTID-03844: mirrors EXECUTABLE_RECOMMENDATION_SOURCE_TYPES (services/gateway/src/services/autopilot-executable-source-types.ts).';
