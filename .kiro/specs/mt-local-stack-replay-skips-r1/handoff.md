---
slug: mt-local-stack-replay-skips-r1
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-08T15:00Z
---
# Handoff — mt-local-stack-replay-skips-r1
Adds the two VTID-05579 migrations that cannot replay on PGlite  to
`replay-skip.json`, so the "MT local stack (PGlite)" check on `main` is green. Plan: `plan.md`.

## Log

### 2026-11-08T15:00Z · kiro-hotmail-202611061752-cc1f · drafted
Gate red on `main` since `b670aa2b99`; lane `local-test-stack-pglite` is done and never reopened, so this is a new plan.
