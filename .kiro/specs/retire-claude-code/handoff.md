---
slug: retire-claude-code
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-20T10:58Z
sparring_record: .kiro/specs/retire-claude-code/sparring/verdict.md
vtids: [VTID-05255, VTID-05256, VTID-05257, VTID-05258, VTID-05259]
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

### 2026-10-20T10:51Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 5 lane(s) got a VTID and are handed to Kiro.

### 2026-10-20T10:58Z · kiro-exafyltd-202610201041-ab5d · approved (PLAN-SPAR converged, round 2)
Policy approval `converged-auto-v1`; VTIDs written to the lanes by CI. Round 2 left one minor finding (R2-F1), handled in
lane `ci-runner-v1` without reopening the plan, as the narrower, conservative reading:
- `vitana-v1/.github/workflows/STAGING-TESTS-REQUIRED.yml` runs `run.mjs check-pr` only and never a browser, so it is
  left unpinned;
- the pin test matches any `playwright` install/test invocation (incl. `npx -y`/`bunx`) and `run.mjs verify` by
  regex, not literal strings.

Next: the owner's explicit merge instruction for this plan PR (bootstrap merge 1). Then lane `scope-rules`.
