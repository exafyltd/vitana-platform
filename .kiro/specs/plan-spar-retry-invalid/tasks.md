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

**Sparring notes from the converging round 3** (minor; acceptance notes for the builder, approved plan block unchanged):
- **R3-F1, the `retryInfra` formula (T2).** `PARTNER_INVALID_CAP = 2` and `PARTNER_INVALID_WINDOW_MS = 24 * 3600 * 1000`
  are module-level constants in `plan-spar.mjs`, next to `RETRYABLE_REASONS`, and in `plan-sparring-service.ts`.
  `plan-spar.mjs:188` becomes:
  `const windowExpired = cur?.exhausted_at != null && now() - new Date(cur.exhausted_at).getTime() > PARTNER_INVALID_WINDOW_MS;`
  `const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && (cur.retryable || windowExpired);`
  The test "with `now` moved past the window, the next push creates once more" pins it.
- **R3-F2, the comment at `plan-spar.mjs:32`–`:33` (T3).** It says that a stuck plan goes to Claude and anything else
  waits for Claude Code. It is rewritten to match Change 4:
  - retryable infra is re-run on the next push (`next_actor: kiro`);
  - a non-retryable reason, `retry_exhausted`, or a plan parked after `MAX_SESSIONS` goes to `owner`.

Acceptance:
- plan Change 1–4;
- `node --test scripts/collab/` and the plan-sparring Jest suites green;
- `create` is called exactly twice for one producer, and a third push creates nothing;
- every check is green with no override. #4210 must be on `main` before the lane starts.
