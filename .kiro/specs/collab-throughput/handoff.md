---
slug: collab-throughput
author: kiro
author_seat: exafy
executor: claude
next_actor: claude
state: drafted
updated: 2026-10-18T23:05Z
---
# Handoff — collab-throughput

Speeds up the collaboration pipeline in three places:
- the queue runs in one pass instead of one git diff per branch;
- PLAN-SPAR checks sparring answers locally and comments on the PR instead of failing silently;
- a sparring code-access health route, checked before each round and by a scheduled alert.

Plan: `plan.md`. Requirements, design and tasks are alongside.

Lanes:
- `throughput-code`: executor **claude** (governance paths `scripts/collab/**`, `.github/**`), reviewer `exafy`.
  Build it after `sparring-floor-retry` (#4186), because both edit `plan-spar.mjs`.

Owner settings that are not part of this plan (see plan "Out of scope"): vitana-v1 auto-delete head branches, and
how often the authoring seats' automations run.

## Log

### 2026-10-18T20:40Z · kiro-exafy-202610181845-661d · drafted
Authored from the measured bottlenecks (queue ~0.9 s per branch diff × 496 branches; run 39157408933's silent
`unknown_finding`; 10 sessions with 0 successful reads on 2026-10-17). Pushed as a plan( PR for PLAN-SPAR. No VTID
allocated by this session.

### 2026-10-18T22:45Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T23:05Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
