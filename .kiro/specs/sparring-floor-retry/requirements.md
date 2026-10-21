# Requirements — sparring-floor-retry

1. WHEN a partner round made at least one code-tool call and none succeeded, THE gateway SHALL escalate it as
   `code_access_unavailable`, whatever the floor or output check said.
2. WHEN a create matches a stored session escalated with `evidence_floor_not_met` or `partner_output_invalid` whose
   round-1 tool log is all failed, THE gateway SHALL start a new session instead of deduplicating, unless the
   session has `human_approved_by`.
3. WHEN PLAN-SPAR meets a legacy escalated entry (`infra: false, retryable: false`) whose live session has that
   shape, THE next run SHALL replace the session without using up one of `MAX_SESSIONS`, and SHALL check each such
   entry at most once.
4. A round-1 floor failure with at least one successful read, `round_cap_reached`, and every round ≥2 escalation
   SHALL behave exactly as today.
