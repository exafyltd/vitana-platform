# Design — sparring-floor-retry

- `partner.ts` exports `codeAccessFailed(toolLog)`: true when `toolLog.length > 0 && toolLog.every((e) => !e.ok)`.
  At both failure exits of `runPartnerPass` (more than `PARTNER_MAX_INVALID_SUBMISSIONS` invalid submissions, and
  the turn cap), a true result returns `code_access_unavailable` with the attempt count and the first error.
  Otherwise it returns the existing reason.
- `plan-sparring-service.ts` create dedup: `retryable` also holds when the reasons include `evidence_floor_not_met`
  or `partner_output_invalid` and `codeAccessFailed(session.rounds[0]?.tool_log ?? [])`. This is for sessions stored
  before the partner change.
- `plan-spar.mjs` `step()`: a one-time reclassification of legacy escalated entries (`infra: false,
  retryable: false`, no `reclassified` key). It reads the live session and applies the same all-failed test to
  round 1's `tool_log`. A match sets infra/retryable and takes the existing `retryInfra` path. A non-match stores
  `reclassified: false`.
- Order: both ship in one PR. `plan-spar.mjs` runs from the base checkout, so it takes effect on merge. The gateway
  part takes effect when staging deploys. A push between the two gets the old session back from dedup and changes
  nothing, which is harmless; it is retried on the next push.
