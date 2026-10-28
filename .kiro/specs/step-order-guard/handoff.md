---
slug: step-order-guard
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-28T10:09Z
sparring_record: .kiro/specs/step-order-guard/sparring/verdict.md
vtids: [VTID-05362]
---
# Handoff — land-guard
`scripts/collab/land-guard.mjs` enforces pipeline step order in code: evidence before the commit, review on the
current head, checks finished before the merge, and closing records before claims and heartbeats are released.
Plan: `plan.md`.

## Log

### 2026-10-28T09:55Z · kiro-exafyltd-202610261510-099d · drafted
Owner task 2026-10-28 (sequencing enforced in code). Re-submitted from #4428 (land-guard), whose PLAN-SPAR session got stuck when a concurrent run lost its round commit. Pushed as a `plan(` PR.

### 2026-10-28T10:09Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
