---
slug: step-order-gate
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: sparred
updated: 2026-10-28T10:35Z
sparring_record: .kiro/specs/step-order-gate/sparring/verdict.md
---
# Handoff — step-order-gate
`scripts/collab/land-guard.mjs` enforces pipeline step order in code: evidence before the commit, review on the
current head, checks finished before the merge, and closing records before claims and heartbeats are released.
Plan: `plan.md`.

## Log

### 2026-10-28T10:30Z · kiro-exafyltd-202610261510-099d · drafted
Owner task 2026-10-28. This re-creates #4429 (`step-order-guard`, converged) as one clean commit, because a commit
there edited a lane file under `_plan`. Pushed as a `plan(` PR.

### 2026-10-28T10:35Z · ci-plan-spar · drafted → sparred
Converged; approved by policy converged-auto-v1. 0 lane(s) got a VTID and are handed to Kiro.
