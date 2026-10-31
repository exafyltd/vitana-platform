# Requirements — pm-reassign-idempotent
- R1. A PM tick that would change nothing writes no commit and pushes nothing.
- R2. Staging deploys keep the PM paused until the owner re-enables it.
- R3. (amendment) The PM never writes a lane whose `seat` equals its `reviewer_seat`; a stale-ready lane whose only
  possible target is its `reviewer_seat` is not reassigned.
