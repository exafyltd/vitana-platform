---
slug: mt-local-stack-replay-skips-r1
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-08T14:58Z
sparring_record: .kiro/specs/mt-local-stack-replay-skips-r1/sparring/verdict.md
vtids: [VTID-05673]
---
# Handoff — mt-local-stack-replay-skips-r1
Adds the two VTID-05579 migrations that cannot replay on PGlite  to
`replay-skip.json`, so the "MT local stack (PGlite)" check on `main` is green. Plan: `plan.md`.

## Log

### 2026-11-08T15:00Z · kiro-hotmail-202611061752-cc1f · drafted
Gate red on `main` since `b670aa2b99`; lane `local-test-stack-pglite` is done and never reopened, so this is a new plan.

### 2026-11-08T14:58Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.

### 2026-11-08T15:10Z · kiro-hotmail-202611061752-cc1f · drafted
Sparring converged in 2 rounds (R1-F1 accepted: chat_groups is created by `20260525000000_VTID_03089_chat_groups.sql`, itself skipped). Lane VTID-05673. Plan PR #4904 ready to merge once its checks are green on this head.
