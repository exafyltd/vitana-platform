#!/bin/bash
# Run a lane pgTAP file in PGlite. Stages: base stand-in schema, real legacy writer migrations, then every lane migration
# listed in LANE_MIGRATIONS (space separated, repo-relative) before the test. Usage: lane.sh <test.sql>
R=/projects/sandbox/vitana-platform; H=$(dirname "$0"); A=()
A+=(--sql $H/base_schema.sql)
for f in supabase/migrations/20260102200000_vtid_01127_availability_readiness_engine.sql database/migrations/20260102_vtid_01135_boundary_consent.sql database/migrations/20260102_vtid_01137_d43_longitudinal_adaptation.sql database/migrations/20260103_vtid_01138_d44_signal_detection.sql database/migrations/20260103_vtid_01139_d45_predictive_risk_forecasting.sql database/migrations/20260103_vtid_01144_positive_trajectory_reinforcement.sql database/migrations/20260103_vtid_01142_d48_opportunity_surfacing.sql database/migrations/20260103_vtid_01143_d49_risk_mitigation.sql supabase/migrations/20260105_vtid_01146_d46_anticipatory_guidance.sql $LANE_MIGRATIONS; do A+=(--sql $R/$f); done
exec node $H/run.mjs "${A[@]}" "$1"
