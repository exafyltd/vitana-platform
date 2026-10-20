# Tasks — plan-spar-retry-invalid

<!-- lane: retry-invalid -->
- [ ] T1 `plan-spar.mjs` and `plan-sparring-service.ts`: `partner_output_invalid` is retryable on both sides (plan
      Change 1–2).
- [ ] T2 Loop guard (plan Change 3):
      - the gateway counts the producer's escalated `partner_output_invalid` sessions (a new repository query) and
        re-runs below 2, dedups with `retry_exhausted: true` at 2;
      - the create route returns `retry_exhausted`;
      - `gatewayClient.create` returns `{ session, deduplicated, retry_exhausted }`, also from its re-post path, and
        `step()` makes `entry.retryable` false on either.
- [ ] T3 No hand-off to Claude (plan Change 4): `next_actor: kiro` when a retry will run, `owner` when it will not or
      when the plan is parked, and the log line names the reason.
- [ ] T4 Tests (plan "Tests"), `tsc --noEmit`, and the `docs/validation/<VTID>/` evidence pack with a change suite.

Acceptance:
- plan Change 1–4;
- `node --test scripts/collab/` and the plan-sparring Jest suites green;
- `create` is called exactly twice for one producer, and a third push creates nothing;
- every check is green with no override. #4210 must be on `main` before the lane starts.
