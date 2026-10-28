# Tasks — pm-reassign-idempotent
Authoritative plan: `plan.md`. VTID: allocated by PLAN-SPAR.

<!-- lane: reassign-noop -->
## reassign-noop
- [ ] R1. Tests first (red on base): `test/project-manager/reassign-idempotent.test.ts` (two ticks → one write, then zero;
  writer: same change twice → one `put`, W1 and W2); `test/project-manager/reassign-seat.test.ts` (stale-ready target
  never `reviewer_seat`; `applyLaneChange` refuses `seat == reviewer_seat`); wiring assertion
  `{name:"PM_AGENT_ENABLED", value:"false"}`.
- [ ] R2. `writers.ts` `laneChangeIsNoop` + skip `put` on W1/W2 + `seat == reviewer_seat` refusal; `act.ts`
  `LaneFileWriter.write` → `Promise<'written' | 'noop'>`, `unchanged` status, fakes updated; `decide.ts` stale-ready
  target skips `reviewer_seat` (no decision when only `reviewer_seat` is left). No `stale_review` decide guard.
  Round 2 notes: `laneChangeIsNoop` compares only `state`, mapped `next_actor`, `seat`, `claimed_by` and the newest
  log entry's body, never `updated:` or the heading timestamp, and runs before `applyLaneChange` (R2-F1);
  `'unchanged'` is added to `ActStatus` in `types.ts`, which needs `types.ts` in the lane's `paths` (R2-F2,
  `responses-2.md`).
- [ ] R3. `AWS-STAGE-DEPLOY-GATEWAY.yml:1225` → `"false"`.
- [ ] R4. `docs/validation/<VTID>/staging-tests.json` + `commands.log`.

Acceptance: the jest suites in `plan.md` are green on head and the new tests red on base; only the lane paths change;
the PM is not re-enabled.
<!-- lane: reassign-noop -->
