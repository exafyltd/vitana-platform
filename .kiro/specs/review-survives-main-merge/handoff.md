---
slug: review-survives-main-merge
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T01:55Z
---
# Handoff — review-survives-main-merge
Every merge to `main` voids the reviewer-agent accept of every waiting PR, because §3 only lets entry-only commits
follow the reviewed head and §7b/§8a require the PR to be up to date before it merges (platform #4533 needed 4
reviews for one unchanged diff). This plan lets an accept stay current across a clean, conflict-free merge of `main`
that leaves the PR's own diff byte-identical and touches no protected gate file. One lane in vitana-platform.
Plan: `plan.md`. Tasks: `tasks.md`.
Lanes:
- `land-guard-merge`: repo `exafyltd/vitana-platform`, executor **kiro**, seat `exafy` (area `platform`).
  `collaboration.md` and `land-guard.mjs` are treated as protected gate files for this plan: merge needs the owner's
  instruction naming this plan (plan premise 6).
## Log
### 2026-11-01T01:55Z · kiro-hotmail-202611010146-1707 · drafted
Written for the owner backlog-cleanup task (workflow `wf_c66636d402deaa3e`) from a read-only investigation
(vitana-platform `origin/main` `601cc2c3e8`). vitana-v1 `collaboration.md` is not byte-identical to the platform
copy, so the rule text is not mirrored there (plan premise 7). Next: PLAN-SPAR spars this PR.
