---
slug: retire-claude-code
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-20T10:45Z
---
# Handoff — Retire Claude Code; every step done by Kiro
Owner decision 2026-10-20 (Kiro Web session): "let's eliminate Claude Code completely … so everything is done by
Kiro". Production after Gate 2: option (a) PUBLISH by the owner or (b) Kiro dispatch on an explicit "yes, deploy",
both kept. Governance guard: owner's explicit per-PR merge instruction + approving review from a different Kiro seat;
automations never touch governance lanes. Plan block: `plan.md`. Lanes: `lanes/*.md` (5).

## Log
### 2026-10-20T10:45Z · kiro-exafyltd-202610201041-ab5d · created → drafted
Holder of the `retire-claude-code/_plan` claim. Measured on origin/main: queue.mjs governance and permission rules,
the Claude Routine's duties, the PM agent (dry_run), the ubuntu-26.04 / Playwright 1.51.0 break (13 workflows).
Wrote requirements, design, tasks, plan and 5 lanes. No VTID allocated, no code changed, no live system touched.
Expected: Collab handoff flags the four governance lanes (today's rule needs executor: claude). That is the
bootstrap false positive described in plan.md; it disappears once lane `scope-rules` is on main.
Next: PLAN-SPAR spars this PR; this session (seat exafyltd) answers each round in `sparring/responses-<n>.md`.
