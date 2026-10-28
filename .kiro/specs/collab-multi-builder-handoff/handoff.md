---
slug: collab-multi-builder-handoff
author: kiro
author_seat: exafyltd
executor: claude
next_actor: kiro
state: approved
updated: 2026-10-23T09:05Z
sparring_record: .kiro/specs/collab-multi-builder-handoff/sparring/verdict.md
vtids: [VTID-05331]
---
# Handoff — collab-multi-builder-handoff

Collab handoff accepts several sessions of the lane's own seat working one after another (no overlap, every takeover
logged, no reviewer as builder); everything else unchanged. Plan: `plan.md`. Lane: `sequential-builders`
(executor claude — protected gate file; built by the exceptions seat exafyltd while Claude is unavailable).

## Log

### 2026-10-22T07:43Z · kiro-exafyltd-202610220742-67f3 · drafted
Owner decision 2026-10-22: fix Collab handoff first, no `--admin` on #4198, governance-only, PLAN-SPAR and the normal
protected-file review. Pushed as a `plan(` PR. No VTID, no code.
Supersedes #4293, whose second commit edited the lane file its first commit created (a `_plan` commit may only create
a lane file); recreated as one commit rather than force-pushing.

### 2026-10-22T08:06Z · kiro-exafyltd-202610220742-67f3 · re-plan after partner escalation
Session 1 escalated on `evidence_floor_not_met`: the partner cited no file it had read. That is not a plan
finding, so there is nothing to answer. Added an explicit premise-check list (files and line ranges) to the plan
block; the changed text starts the re-plan session (`plan-spar.mjs:307`, max 2 sessions).

### 2026-10-22T09:01Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.

### 2026-10-23T09:05Z · kiro-jtadic-202610230823-7721 · approved (driver takeover, stale claim broken)
Driver session for this plan. The `_plan` claim of kiro-exafyltd-202610220742-67f3 was 25 h old with no commit on
`kiro/collab-multi-builder-handoff/plan-v2` since 2026-10-22T09:01Z and no driver heartbeat ever, so I broke it with
`release --stale` (§5) and took the `_plan` claim and the driver heartbeat (§8). Reason: this plan unblocks
`commerce-step-owner/gateway-step-owner` (#4198, Collab handoff red on five sequential `kiro-exafy-…` sessions), whose
driver I also hold. Merged `origin/main` into this branch (48 commits behind, no conflict). Next: plan PR #4294 lands
under §7b so lane `sequential-builders` reads its files from `main`; that lane is `executor: claude`, seat `exafyltd`
(it changes the protected `scripts/collab/queue.mjs`), so it is built by Claude Code or the exceptions seat
`exafyltd`, not by this driver's seat, and merges only with a `claude` review or the owner's instruction (§3a).
