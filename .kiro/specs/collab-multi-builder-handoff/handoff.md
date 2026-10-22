---
slug: collab-multi-builder-handoff
author: kiro
author_seat: exafyltd
executor: claude
next_actor: kiro
state: drafted
updated: 2026-10-22T07:43Z
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
