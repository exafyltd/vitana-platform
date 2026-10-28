# Tasks — pm-reassign-idempotent-r2
Authoritative plan: `plan.md`. VTID: allocated by PLAN-SPAR. Supersedes `pm-reassign-idempotent/reassign-noop`
(VTID-05363).
<!-- lane: reassign-noop-r2 -->
## reassign-noop-r2
- [ ] R1. Tests first (red on base): `test/project-manager/reassign-idempotent.test.ts` (two ticks → one write, then
  zero; writer: same change twice → one `put`, W1 and W2); `test/project-manager/reassign-seat.test.ts` (stale-ready
  target never `reviewer_seat`; `applyLaneChange` refuses `seat == reviewer_seat`); wiring assertion
  `{name:"PM_AGENT_ENABLED", value:"false"}`. Save the red output to `docs/validation/<VTID>/red.log`.
- [ ] R2. `writers.ts` `laneChangeIsNoop` (compares only `state`, mapped `next_actor`, `seat`, `claimed_by` and the
  newest log entry's body, never `updated:` or the heading timestamp; runs before `applyLaneChange`) + skip `put` on
  W1/W2 + `seat == reviewer_seat` refusal; `act.ts` `LaneFileWriter.write` → `Promise<'written' | 'noop'>`,
  `unchanged` status, fakes updated; `types.ts` adds `'unchanged'` to `ActStatus`; `decide.ts` stale-ready target
  skips `reviewer_seat` (no decision when only `lane.seat`/`reviewer_seat` is left). No `stale_review` decide guard.
- [ ] R3. `AWS-STAGE-DEPLOY-GATEWAY.yml:1225` → `"false"`.
- [ ] R4. `docs/validation/<VTID>/staging-tests.json` + `commands.log`; `npm run test:operator` green.
Acceptance: the jest suites in `plan.md` are green on head and the new tests red on base; only the lane paths change;
the PM is not re-enabled.
<!-- lane: reassign-noop-r2 -->
