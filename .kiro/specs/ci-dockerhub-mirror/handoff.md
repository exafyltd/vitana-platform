---
slug: ci-dockerhub-mirror
author: kiro
author_seat: exafyltd
executor: claude
next_actor: kiro
state: done
updated: 2026-11-01T00:06Z
sparring_record: .kiro/specs/ci-dockerhub-mirror/sparring/verdict.md
vtids: [VTID-05415]
---
# Handoff — ci-dockerhub-mirror
vitana-v1 `pr-gate` fails at `Initialize containers`: its Postgres service image comes from
`public.ecr.aws/docker/library/postgres:16`, whose anonymous data cap returns `Data limit exceeded` (run 41200356754,
attempt 1). This plan moves the five v1 PR CI service images to the same official image on Docker Hub
(`postgres:16`), which GitHub-hosted runners pull without rate limits (vitana-platform does so in every PR service
container, 20/20 green). One lane, in vitana-v1, plus a guard test.
Plan: `plan.md`. Tasks: `tasks.md`.
Lanes:
- `v1-service-images`: repo `exafyltd/vitana-v1`, executor **claude** (it changes the protected gate file
  `.github/workflows/PR-GATE.yml`; exceptions seat `exafyltd` while Claude is unavailable).
## Log
### 2026-10-31T13:05Z · kiro-exafyltd-202610311247-830c · drafted
Written for the owner backlog-cleanup task (workflow `wf_df00c2efa5289a76`) from a read-only investigation (vitana-v1
`origin/main` `847a9f686`, vitana-platform `a8d36bad3b`). The task assumed v1 pulls from Docker Hub; it already pulls
from ECR Public (VTID-05015/05016), which is the registry failing, so the plan switches the other way (plan § Today 1).
Next: PLAN-SPAR spars this PR.

### 2026-10-31T14:29Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
### 2026-11-01T00:06Z · kiro-ide-202610272306-27b0 · approved → executing
Only lane `v1-service-images` built: exafyltd/vitana-v1#1522.
### 2026-11-01T00:06Z · kiro-ide-202610272306-27b0 · executing → in-review
Lane `v1-service-images` reviewed: accept by agent:vitana-lane-reviewer (claude-sonnet-5.5) on 77c09476.
### 2026-11-01T00:06Z · kiro-ide-202610272306-27b0 · in-review → verified
exafyltd/vitana-v1#1522 merged under §7b, merge: 988a3c5070a9459453a67793f15784ad8d361f9e. Authority: owner instruction naming this plan (2026-10-31, "come on, you execute your recommendations. move ahead") + reviewer accept on the current head.
### 2026-11-01T00:06Z · kiro-ide-202610272306-27b0 · verified → done
Plan closed: every lane done (exafyltd/vitana-v1#1522, `988a3c5070a9459453a67793f15784ad8d361f9e`). VTID-05415 ships no deploy (CI workflow + test), so no Gate 2.
