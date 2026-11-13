---
slug: staging-manifest-remainder
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-12T11:55Z
sparring_record: .kiro/specs/staging-manifest-remainder/sparring/verdict.md
vtids: [VTID-05775, VTID-05776, VTID-05777]
---
# Handoff - staging-manifest-remainder

Owner decision 2026-11-11: the four manifest changes left in PR #4964 (VTID-05504, 05506, 05507, 05609, and the gateway
test that moves with 05504) are part of the staging failures. They are not covered by the approved plan
`staging-verify-manifest-repair`, so they get their own plan. PR #4964 closes when this plan's PR is open.

This plan also unblocks `drift-guard` (VTID-05602, PR #4993): that guard is red on exactly these four manifests and
merges once this plan has merged.

## Log

### 2026-11-11T21:30Z · kiro-exafy · drafted
Pushed as a `plan(` PR for CI PLAN-SPAR.

### 2026-11-12T11:55Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 3 lane(s) got a VTID and are handed to Kiro.
