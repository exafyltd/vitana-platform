---
slug: ci-dockerhub-mirror
author: kiro
author_seat: exafyltd
executor: claude
next_actor: kiro
state: approved
updated: 2026-11-01T12:15Z
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
### 2026-11-01T12:15Z · kiro-ide-202610272306-27b0 · merge record (lane v1-service-images)
exafyltd/vitana-v1#1522 squash-merged under §7b.
merge: 988a3c5070a9459453a67793f15784ad8d361f9e (2026-11-01T00:00:13Z, no --admin)
authority: owner instruction (named plan) + reviewer accept + §7b. Owner, 2026-10-31, session kiro-ide-202610272306-27b0, after the parent recommended plan ci-dockerhub-mirror by name: "come on, you execute your recommendations. move ahead". Protected gate file `.github/workflows/PR-GATE.yml` (§3a).
Review: accept by agent:vitana-lane-reviewer (claude-sonnet-5.5) on 77c09476914834872dc4c185ae112ee3f6bdf220 (lane log). Before merge the branch was updated from `main`; head 8011266ce70b1577d25acdb9356fdacd9587abde adds only main's commits (`lane-land.md` 3d). Required checks green on 8011266 (pr-gate, Vitest (jsdom), Edge data client, Realtime helper). NATIVE-CI "Parity ledger" / "core/tokens generators + native script tests" red, not required, red on `main` too (77ec053163).
Next: the lane's seat (exafyltd) moves lane v1-service-images ready → done with this merge sha (Lane scope refuses a lane edit from another seat), then the plan approved → done. Nothing deploys, so no Gate 2.
