# Responses — round 2

```json
[
  {
    "finding_id": "R2-N1",
    "disposition": "accepted",
    "rationale": "Confirmed: gatewayClient.create (plan-spar.mjs:114-121) returns only r.json.session, dropping the route's top-level deduplicated (routes/plans-spar.ts:49-50). B.3 now: the client returns { session, deduplicated, retry_exhausted } (also from its lost-response re-post path); the route adds a top-level retry_exhausted on the exhausted dedup; entry.retryable = reasons-retryable && !deduplicated && !retry_exhausted. Response fields only, so SparringSession, SESSION_COLUMNS and the table stay unchanged. routes/plans-spar.ts added to the lane paths; test: a third push with a dedup/retry_exhausted answer does not create again."
  },
  {
    "finding_id": "R2-N2",
    "disposition": "accepted",
    "rationale": "Confirmed: validateLane judges the head file only (queue.mjs:346-349); the base/head pair is read in validateRange (:356-357). A.3a now puts the self-grant check in validateRange next to the transition check: for a lane file present at the merge base, a change of governance is an error unless every commit touching the file in range is a _plan commit and the lane is ready at head (same rule as PLAN-SPAR's VTID write, :386). validateLane keeps only the field-shape rule. Self-grant is refused by scopeCheck (PERM) and validateRange."
  }
]
```
