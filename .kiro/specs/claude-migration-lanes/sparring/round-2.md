# Sparring round 2 — in_progress

Session: `b6f117fc-d1f7-4b08-9819-b40ff2fa71b1` · plan hash `98be72db324b4f4c5967e487160801ee0fe687b242bc3d508092b6d48f341a9a`

## Summary

The revised plan correctly addressed R1-F2 (executor-switch withdrawn) and R1-F3 (github-bridge conditional). R1-F1's rejection is reasonable since the lane is withdrawn regardless. Three key premises verified against code. One new finding: the plan's `reinstate-rules` scope description doesn't mention updating the lane_admin prose in collaboration.md §7a, which still says "seat and narrow its paths" only — but `reassign-migration` will change executor and reviewer_seat on target lanes. The reviewer agent for reassign-migration could reject based on the stale prose.

## Findings

### R2-F1 [major]

The collaboration.md §7a lane_admin prose (lines 251–253) says a lane_admin lane may only 'reassign that TARGET lane's seat and narrow its paths'. The `reassign-migration` lane will change `executor` and `reviewer_seat` on target lanes — fields the prose does not mention. The plan's description of `reinstate-rules` says it will 'Remove the retirement wording of collaboration.md (P1) and state that Claude Code builds executor: claude lanes in any plan' — it does not say it will update the lane_admin prose to include executor and reviewer_seat. Since `reassign-migration` depends on `reinstate-rules`, and the reviewer agent reviews against the prose rules in collaboration.md, the reviewer agent for `reassign-migration` would see the old prose and could reject the executor/reviewer_seat change as exceeding the documented lane_admin scope. The CI code gate would pass (it allows all four PERM fields), but the reviewer agent's accept is required for the PM merge rule (§7b).

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:251` — **Lane administration — the one reviewed exception to "edit another lane's file" (kiro-lane-admin).** An authorized
`executor: kiro` lane carrying `lane_admin: true` with `reviewer_seat: agent:vitana-lane-reviewer`, whose `paths`
cover the target lane file, may reassign that TARGET lane's `seat` and narrow its `paths`
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1000` — const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
      ...
      const permAllowed = (trustedFm.executor === 'claude' && claudeOnly) || targetOfAdmin;
      if (changed.length && !permAllowed) {
        errors.push(...);

Suggestion: Explicitly include in `reinstate-rules`'s scope that it must update the lane_admin prose in collaboration.md §7a to document that a lane_admin lane may also change `executor` and `reviewer_seat` on a target lane (matching what the code already allows). This ensures the reviewer agent for `reassign-migration` sees the updated prose when it reviews.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The executor-switch lane is withdrawn in the revised plan, making this finding moot regardless of the file's state at any commit. The planner's rationale references a commit (d9ae102bdb) that isn't the pinned commit, and the file doesn't exist at the pinned commit (0f45367bb6) — but since the lane is withdrawn, the chicken-and-egg problem is eliminated.
- R1-F2: acknowledged — Accepted and addressed: executor-switch withdrawn, P3 corrected to state the code allows all four PERM fields.
- R1-F3: acknowledged — Accepted and addressed: github-bridge is now conditionally included only if ready and unclaimed when the lane runs.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
