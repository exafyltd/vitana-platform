# Sparring round 1 — in_progress

Session: `6f2d854a-85b8-4727-b10b-4b9ac49378d1` · plan hash `e85401d431472b1b9e38b7f68f908f7b992226fc59aa2ab40b78dd6b2961da1e`

## Summary

The plan's core mechanism (an allowlisted `reviewer_exception` bypass for the `in-review → verified` evidence check in `transitionChain`) is sound in concept. However, the plan's step 5 describes a universal transition chain that is factually wrong for two of the three lane files and both handoffs at the pinned commit. Implementation following step 5 literally will be rejected by `queue.mjs` validation. A secondary issue is that `transitionChain` currently has no access to the spec slug, which the allowlist check requires.

## Findings

### R1-F1 [blocker]

Step 5 says all lanes and handoffs follow `parked → in-review → verified → done`, but at the pinned commit: (1) lane `runner` has `state: parked`, `parked_from: executing` — `checkTransition` (line 271) only allows parked to return to `parked_from`, so the valid chain is `parked → executing → in-review → verified → done`. (2) lane `manifests` has `state: ready` (not parked at all), so its chain must be `ready → executing → in-review → verified → done`. (3) Both handoffs (`profile-posts-full-width` and `staging-verify-runner-fix`) are at `state: approved`, not parked, so they need `approved → executing → in-review → verified → done`. Implementing the plan's stated chain will be rejected by the validator for 4 of the 5 files.

- `exafyltd/vitana-platform:.kiro/specs/staging-verify-runner-fix/lanes/runner.md:1` — state: parked
...
parked_from: executing
- `exafyltd/vitana-platform:.kiro/specs/staging-verify-runner-fix/lanes/manifests.md:1` — state: ready
- `exafyltd/vitana-platform:.kiro/specs/profile-posts-full-width/handoff.md:1` — state: approved
- `exafyltd/vitana-platform:.kiro/specs/staging-verify-runner-fix/handoff.md:1` — state: approved
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:269` — if (a === 'parked') return b === before.parked_from ? [] : [`a parked ${kind} may only return to "${before.parked_from}" (got "${b}")`];

Suggestion: Correct step 5 to list the actual chain per file: card-layout `parked → in-review → verified → done`; runner `parked → executing → in-review → verified → done`; manifests `ready → executing → in-review → verified → done`; both handoffs `approved → executing → in-review → verified → done`. Each `executing → in-review` edge requires a PR URL in its log entry (line 372); runner and manifests closing entries must include those PR references.

### R1-F2 [major]

`transitionChain` (the function where the `in-review → verified` review evidence is enforced) does not receive the spec slug. Its signature is `transitionChain(kind, beforeText, afterText, { reviewCommits, laneStates })`. The plan requires the slug to check the `CLOSED_BY_OWNER_EXCEPTION` allowlist, but the slug is not available inside this function — it is only available in `validateRange` at the call site (`c.slug`). The plan should specify the interface change: either thread the slug into `transitionChain` or check the allowlist in `validateRange` and pass a flag.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:328` — export function transitionChain(kind, beforeText, afterText, { reviewCommits = [], laneStates = null } = {}) {
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:817` — const key = `${c.slug}/${c.lane}`;
        const reviewCommits = reviewBacking(repo, commits, key, p, parseFrontMatter(showFile(repo, mergeBase, p)));
        ...for (const x of transitionChain(c.kind, beforeText, afterText, { reviewCommits, laneStates })) errors.push(`${p}: ${x}`);

Suggestion: Either (a) add an optional `slug` (or `{ slug }`) parameter to `transitionChain`'s options and pass `c.slug` from `validateRange`, or (b) resolve the allowlist in `validateRange` and pass a boolean `reviewerException` flag through. Option (a) is simpler and keeps the logic co-located with the other evidence checks. Update the test plan accordingly.

### R1-F3 [minor]

`queue.mjs` is in the protected-gate-files list (line 94). Changing it requires 'the owner's instruction naming the plan plus a reviewer-agent accept on the current head' (collaboration.md §3a). The plan's Risks section mentions 'sparring and owner approval' but does not name the protected-gate-file merge procedure explicitly. This should be stated so the implementer knows the PR merge path.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:94` — export const PROTECTED_GATE_BUILTIN = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs', ...
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:138` — except the protected gate files, which never merge on a reviewer-agent accept alone: they need the owner's instruction naming the plan plus a reviewer-agent accept on the current head.

Suggestion: Add a sentence to the Risks section: 'The implementation PR changes a protected gate file (`queue.mjs`); it merges only after the owner's instruction naming this plan and a reviewer-agent accept on the final head (§3a).'

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
