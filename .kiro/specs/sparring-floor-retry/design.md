# Design — sparring-floor-retry

- Gateway: `RETRYABLE_REASONS` in `plan-sparring-service.ts` gains `evidence_floor_not_met`. `partner.ts`
  emits that reason only when the failed submission matched `/round 1 needs at least/`, so a retried session
  never discards a real review.
- `plan-spar.mjs`: the reason joins `INFRA_REASONS` and `RETRYABLE_REASONS`. In `step()`, before the
  `retryInfra` / `replan` decision: if `cur.verdict === 'escalated' && !cur.infra`, call `client.get(cur.id)`.
  If the live session's `producer === ci-plan-spar.<slug>`, recompute `cur.infra` / `cur.retryable` from
  `escalation_reasons`. On `null` or a producer mismatch, keep the stored values.
- Order: gateway first (otherwise the client retry is deduped back to the old session). Both ship in one PR.
  `plan-spar.mjs` runs from the base checkout, so it takes effect on merge, and the gateway part takes effect
  when staging deploys. Pushes before both are live stay no-ops, which is harmless.
