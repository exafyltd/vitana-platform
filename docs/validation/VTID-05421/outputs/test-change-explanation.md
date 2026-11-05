# Test changes on the reassign-noop-r3 head (VTID-05421)

All fixture and assertion changes against origin/main, with the reason for each.

1. `services/gateway/test/project-manager/observe-live.test.ts` (line 309). One assertion was changed from
   `seat: exafyltd` to `seat: jtadic`, and the change's input seat was changed to match. Reason: VTID-05414 makes
   `applyLaneChange` refuse any change that introduces `seat == reviewer_seat` (queue.mjs validateLane rejects that lane
   file). This fixture's reviewer_seat is `exafyltd`, so the old input would now throw. The assertion still checks that a
   seat change is written. It is a contract update, not a weakened test.
2. `services/gateway/test/project-manager/decide.test.ts`. A `reviewer_seat: 'hotmail'` fixture field was added to the
   stale-ready case, with a comment. No assertion was removed. It exercises the VTID-05414 rule that the target seat is
   never the reviewer seat.
3. `services/gateway/test/project-manager/reassign-seat.test.ts`, park case. An assertion that a park keeps the seat
   (`seat: exafyltd`) was added, so the park case verifies the seat is unchanged. This strengthens the test.

No assertion was removed without a replacement that checks the same behaviour under the new rule.
