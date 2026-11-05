# Sparring round 1 — in_progress

Session: `b6f117fc-d1f7-4b08-9819-b40ff2fa71b1` · plan hash `061a5cd6bc467ef36f7f1e53fbb0a924ff0e78cdbd38312c241108d583486eb0`

## Summary

Verified 7 premises (P1–P7) against the pinned commit. Three findings: one blocker (the executor-switch lane declares an executor/reviewer_seat combination the code rejects), one major (P4 misstates what the code enforces for lane_admin), and one major (P5 is wrong about github-bridge's state).

## Findings

### R1-F1 [blocker]

The `executor-switch` lane is declared as `executor: claude` with `reviewer agent` (i.e., `reviewer_seat: agent:vitana-lane-reviewer`). But `validateLane` at line 230 explicitly rejects this combination: `if (fm.executor !== 'kiro') e.push('reviewer_seat … is a reviewer agent; it reviews only lanes with executor: kiro')`. The lane file would fail CI validation in both the plan PR (`validateRange` → `validateLane`) and its own lane PR (`scopeCheck`), so it cannot be created under the current code. This is a chicken-and-egg problem: the lane that would change the code cannot itself pass validation before the code is changed.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:228` — if (isReviewerAgent(fm.reviewer_seat)) {
        if (fm.executor !== 'kiro') e.push(`reviewer_seat "${fm.reviewer_seat}" is a reviewer agent; it reviews only lanes with executor: kiro`);

Suggestion: Either (1) give `executor-switch` a non-agent reviewer_seat (e.g. `reviewer_seat: claude` or a Kiro seat) so it passes validation, or (2) split the plan so a preceding `executor: kiro` lane first loosens the validateLane check to allow reviewer agents on `executor: claude` lanes (that lane itself can be executor: kiro with a reviewer agent since it touches only queue.mjs — but queue.mjs is a protected gate file, so it still needs the owner's instruction). Option 1 is simpler; the reviewer would then be whoever `reviewer_seat` names, not the Kiro reviewer agent.

### R1-F2 [major]

P4 claims `queue.mjs:249` lets a lane_admin lane change only `seat` and `paths` of the target lane, never `executor`. This is wrong in two ways. (a) Line 249 validates the admin lane's OWN format (executor: kiro, reviewer agent, lane-file path); it says nothing about what the admin may change on a target. (b) The actual target-PERM enforcement is in `scopeCheck` at lines 1014–1017: when `targetOfAdmin` is true, `permAllowed` is true for ALL four PERM fields (`executor`, `seat`, `reviewer_seat`, `paths`). There is no code that restricts the admin to only `seat` and `paths`. The 'seat and paths only' wording exists in collaboration.md §7 (line 253) as a prose rule for the reviewer agent, not as a code gate. Consequence: the code already lets a lane_admin lane change `executor` on a target — the `executor-switch` change (a) to queue.mjs may be redundant, or if it introduces a 'nothing else' restriction it could break the existing seat/paths-only admin path.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1000` — const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
      ...
      const targetOfAdmin = selfTrustedLaneAdmin && laneAdminCovers(repo, base, head, key, lanePath, fetchPlanLane, fetchLane);
      const permAllowed = (trustedFm.executor === 'claude' && claudeOnly) || targetOfAdmin;
      if (changed.length && !permAllowed) {
        errors.push(...);
      }
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:244` — if (toBool(fm.lane_admin) && !(fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && paths.some((g) => globToRegex('.kiro/specs/*/lanes/*.md').test(g)))) {
      e.push(`lane_admin: true needs executor: kiro, reviewer_seat: ${REVIEWER_AGENTS[0]}, and a lane-file path (.kiro/specs/*/lanes/*.md)`);
    }
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:251` — **Lane administration — the one reviewed exception to "edit another lane's file" (kiro-lane-admin).** An authorized
`executor: kiro` lane carrying `lane_admin: true` with `reviewer_seat: agent:vitana-lane-reviewer`, whose `paths`
cover the target lane file, may reassign that TARGET lane's `seat` and narrow its `paths`

Suggestion: Correct P4 to state that the code (scopeCheck) already allows all PERM changes on a target when targetOfAdmin is true, and the 'seat and paths' limit is only a prose rule. Then decide: (a) if the goal is to keep the existing prose limit and extend it to executor, executor-switch should add code enforcement that restricts a lane_admin target change to exactly {seat, paths, executor} and nothing else; (b) if the code's current permissiveness is intentional, executor-switch only needs to update the collaboration.md prose rule, not queue.mjs. Either way, clarify what executor-switch actually needs to change and why.

### R1-F3 [major]

P5 states 'The four target lanes are ready, executor: kiro, seat: exafy.' This is false for `github-bridge`, which at the pinned commit is `state: in-review` with `claimed_by: kiro-exafy-202611050107-c4a6`, an open PR (#4689), and an `accept` review on head `4b59a16f`. It is actively being landed — not idle and not `ready`. The `reassign-migration` lane would need to change executor on a lane that is mid-flight. The plan does not address what happens if github-bridge has already merged (then executor is moot for it) or is still executing (then changing its executor could disrupt the builder's session and invalidate the trusted PERM source for its PR's scopeCheck).

- `exafyltd/vitana-platform:.kiro/specs/agentic-delivery/lanes/github-bridge.md:1` — ---
lane: github-bridge
state: in-review
next_actor: kiro
...
executor: kiro
seat: exafy
...
claimed_by: kiro-exafy-202611050107-c4a6
branch: kiro/agentic-delivery/github-bridge
pr: https://github.com/exafyltd/vitana-platform/pull/4689
- `exafyltd/vitana-platform:.kiro/specs/agentic-delivery/lanes/github-bridge.md:92` — ### 2026-11-05T17:34Z · agent-vitana-lane-reviewer-202611051734-fa1b · review
review: accept
head: 4b59a16f2e0e91709e096d4a48ad6798e49aa1c4
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)

Suggestion: Acknowledge that github-bridge may be `done` by the time this plan executes, and exclude it from `reassign-migration`'s target list if it has already merged. If it is still active when reassign-migration runs, the plan needs to either wait for it to complete or explain how changing executor on a mid-flight lane is safe (scopeCheck reads the trusted PERM from the merge-base; changing executor on main while a PR is open would change the trusted source for the next merge-base computation).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
