# Sparring round 1 — in_progress

Session: `e62568fb-01f1-458a-93c9-eb95a90cdebc` · plan hash `05fd9c2c65c88463593c8b0dd8645fe959ab3513a9cfa0632ea9a1a7353e4a84`

## Summary

The plan is well-structured with detailed premises that mostly hold against the code. I verified all major line-number references in VALIDATOR-CHECK.yml, kiro-web-session.mjs, preflight.mjs, driver.md, and AGENTS.md. The main concern is a merge-ordering regression window: the plan claims "either lane can merge first" (§3.3) but if `preflight-validator` lands before `session-reliability`, the existing PreToolUse guard would call the newly-tightened preflight without `--body-file`, blocking every gateway push for the duration of the gap. Two minor issues around CI fidelity of the local VALIDATOR-CHECK runner.

## Findings

### R1-F1 [major]

The plan states 'either lane can merge first' (§3.3), but if preflight-validator merges before session-reliability, the PreToolUse guard's checkPush (unchanged at that point) calls preflight without --body-file. The new VALIDATOR-CHECK check added by preflight-validator explicitly fails when --body-file is missing for gateway PRs ('No --body-file while the check applies → fail', §3.1.3). Since checkPush blocks on any preflight failure (line 432), every gateway push via the PreToolUse guard is blocked until session-reliability also merges. The §3.3 interface only covers the new pre-push hook (which doesn't exist until session-reliability merges), not the existing PreToolUse guard's checkPush code path.

- `exafyltd/vitana-platform:scripts/collab/kiro-web-session.mjs:411` — const args = [path.join(platformRoot, 'scripts', 'collab', 'preflight.mjs'), '--repo', top, '--base', 'origin/main', '--head', sha, '--branch', branch];
... args.push('--title', title);
... return block(`kiro-web-session guard: preflight failed on ${sha.slice(0, 12)} (${branch}) — CI would fail the same way.`
- `exafyltd/vitana-platform:scripts/collab/preflight.mjs:43` — else if (['repo', 'base', 'head', 'branch', 'title'].includes(k)) out[k] = val;
      else throw new Usage(`unknown option --${k}`);

Suggestion: Either (a) declare `depends_on: [session-reliability]` in the preflight-validator lane (or specify merge order as session-reliability first), or (b) have the new VALIDATOR-CHECK check fall back to the open PR body via `gh` when --body-file is missing (matching how checkPush already falls back on the open PR's title at line 413-415), or (c) have checkPush also pass --body-file when PR_BODY_FILE is available (§3.2.6 says it is parsed). If (c), state it explicitly in the plan — the current text only describes the pre-push hook passing --body-file, never checkPush.

### R1-F2 [minor]

The plan runs each VALIDATOR-CHECK workflow step in 'bash -e' (§3.1.2) but GitHub Actions executes run: blocks with 'bash --noprofile --norc -eo pipefail {0}'. Missing -o pipefail could produce a false pass when a pipeline command fails silently. For example, the CSP Governance Gate at line 261 uses a four-stage pipeline; without pipefail, a failing grep (no match → exit 1) would not propagate and the behavior diverges from CI.

- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:259` — BASE="${{ github.base_ref }}"
DIFF_BASE="origin/$BASE"
REVERTED_SHA="$(git log "origin/$BASE"..HEAD | grep -oE 'This reverts commit [0-9a-f]{40}' | head -n1 | awk '{print $4}')"

Suggestion: Use 'bash --noprofile --norc -eo pipefail' (or 'bash -eo pipefail') as the shell invocation, matching the GitHub Actions default.

### R1-F3 [minor]

The plan reads VALIDATOR-CHECK.yml from the **base** revision ('read from the base revision of .github/workflows/VALIDATOR-CHECK.yml', §3.1.2). GitHub Actions runs pull_request workflows from the HEAD commit (the merge commit of head into base). For this plan the file is unchanged, but the rationale — 'as Lane scope uses the base queue.mjs' — is a false analogy: Lane scope runs from base because PR-GATE.yml explicitly checks out base for scope-check, while VALIDATOR-CHECK.yml runs its own steps from the PR head. A future PR that modifies VALIDATOR-CHECK.yml would get stale step scripts in preflight.

- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:1` — name: VALIDATOR-CHECK
run-name: 'Validator Check [${{ github.head_ref || github.ref_name }}]'

on:
  pull_request:
    types: [opened, edited, synchronize, reopened, ready_for_review]

Suggestion: Read VALIDATOR-CHECK.yml from the HEAD (working-tree) revision, matching which version CI actually executes. Add a note that the workflow file itself is not in either lane's paths, so the base/HEAD distinction does not matter for this plan.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
