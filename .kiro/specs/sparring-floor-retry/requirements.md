# Requirements — sparring-floor-retry

1. WHEN round 1 of a sparring session escalates with `evidence_floor_not_met`, THE gateway SHALL treat the
   session as retryable (no plan-hash dedup on the next create), unless it has `human_approved_by`.
2. WHEN PLAN-SPAR records such an escalation, THE state entry SHALL be `infra: true, retryable: true`, and the
   handoff log SHALL say the partner could not review. The plan SHALL NOT be parked.
3. WHEN an existing state entry says `infra: false` but the live session's reasons are now retryable, THE next
   PLAN-SPAR run SHALL retry it by replacing the session, without using up one of the plan's `MAX_SESSIONS`.
4. Escalations for real non-convergence (`round_cap_reached`, a round ≥2 failure, `partner_output_invalid`)
   SHALL behave exactly as today.
