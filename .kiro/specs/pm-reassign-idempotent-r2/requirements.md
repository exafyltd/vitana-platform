# Requirements — pm-reassign-idempotent-r2
- R1. A PM tick that would change nothing writes no commit and pushes nothing.
- R2. Staging deploys keep the PM paused until the owner re-enables it.
- R3. The PM never writes a lane whose `seat` equals its `reviewer_seat`; a stale-ready lane whose only possible
  target is its `reviewer_seat` is not reassigned.
- R4. The lane is buildable by Kiro: `executor: kiro`, `paths` include `types.ts`. Supersedes
  `pm-reassign-idempotent/reassign-noop` (VTID-05363, to be retired).
