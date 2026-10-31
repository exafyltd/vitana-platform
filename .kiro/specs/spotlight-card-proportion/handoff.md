---
slug: spotlight-card-proportion
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
spar_refs:
  - exafyltd/vitana-v1: main
updated: 2026-10-31T14:00Z
---
# Handoff — spotlight-card-proportion
Planner and driver: Kiro seat `exafyltd` (session kiro-exafyltd-202610311330-7ae2), working the owner session
`kiro-202610152203-0347`. Plan: `plan.md`. Lanes (all vitana-v1): `lanes/layout-core.md` first, then
`lanes/health.md`, `lanes/discover.md`, `lanes/events.md` and `lanes/find-a-match.md` in parallel.

## Log
### 2026-10-31T14:00Z · kiro-exafyltd-202610311330-7ae2 · created → drafted
Owner instruction 2026-10-31: *"very good. yes, this you can build"*, given on the four approved mocks
(`health-proposed.png`, `discover-proposed.png`, `events-proposed.png`, `find-a-match-proposed.png`). This clears the
design-contract stop for exactly this layout.
- Supersedes `spotlight-compact-hero` (platform #4517, closed 2026-10-31). It converged on the rejected
  `approved-blend-v2`, with no lanes and no VTIDs. Its `_plan`/`main` claims on its branch are history.
- `spar_refs` pins vitana-v1 `main`, which was `77ec053163da0f8aa2df3668132aab62c39d5a67` at setup and is the commit
  the plan's `file:line` evidence comes from.
- Read-only investigation; no VTID allocated; no live system touched.

Next: PLAN-SPAR spars the plan. On convergence, this run builds `layout-core`, then the four page lanes, merges under
§7b, and watches STAGING-VERIFY.
