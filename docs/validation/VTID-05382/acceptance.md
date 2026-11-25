# VTID-05382 acceptance — hand-off PR (quality-checks-followup/reviewer-requester-rule)

This PR changes no code. It records the planner's prepared correction and hands the protected lane to its builder
(Claude Code, or the exceptions seat `exafyltd` while Claude is unavailable). The lane's own Acceptance (tasks.md) is
checked on the builder's PR, which needs a legacy `claude` review or an owner instruction naming this plan.

AC-1 The proposal lists the conflicting instructions with file:line, the exact replacement text for
`.kiro/agents/vitana-lane-reviewer.md:43-44` and the test; the lane log records the scratch-copy check
(test 2 fail on base, 3/3 with the proposed text; guard 67/67).
TEST: outputs/proposal-check.txt
