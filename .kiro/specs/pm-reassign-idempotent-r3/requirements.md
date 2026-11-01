# Requirements — pm-reassign-idempotent-r3
- R1. A PM tick that would change nothing writes no commit and pushes nothing.
- R2. Staging deploys keep the PM paused until the owner re-enables it.
- R3. The PM never writes a lane whose `seat` equals its `reviewer_seat`; a stale-ready lane whose only possible
  target is its `reviewer_seat` is not reassigned.
- R4. The lane is buildable by Kiro and can pass CI: `executor: kiro`, `paths` include `types.ts` and the generated
  `conversation-flag-pins.generated.ts` that the R2 pin change makes stale. Supersedes
  `pm-reassign-idempotent-r2/reassign-noop-r2` (VTID-05414, to be retired).
