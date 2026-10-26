# Sparring round 1 — in_progress

Session: `f6ce4455-d462-4a10-8e98-82927189a637` · plan hash `ec9232daed8b71b5bdc8a6117dbc7e7e685fd1797cef37ea4c2c22dce503bc9c`

## Summary

The motivating diagnosis (multiple seat-scoped Kiro sessions per lane breaking `validateRange`) is correct and well-evidenced. The proposed relaxation is structurally sound. However, three implementation gaps make the plan incomplete: (1) the overlap / contiguity check in rule 2c specifies `--topo-order --reverse` commit ordering but `commitsInRange` does not use it, and the plan does not say whether to change `commitsInRange` (which would affect `scopeCheck` as well) or sort separately for the overlap check; (2) rule 2c's committer-date sub-condition and rule 2e's "last builder session" identification both depend on knowing commit order, but neither `commitsInRange`'s return value nor an alternative ordering path is specified; (3) rule 2d's secondary clause ("in an entry's text written by a later session of the same seat") cannot be resolved from the lane file at HEAD alone — it requires per-commit authorship from git history, which no existing function in `queue.mjs` provides. Additionally, a false premise about `ci-plan-spar` being already excluded today could mislead the implementer, and the explicit test-run command misses one test file that CI will actually execute.

## Findings

### R1-F1 [major]

Rule 2c specifies `--topo-order --reverse` commit ordering for the contiguity check, but `commitsInRange` uses plain `git log --no-merges` (reverse-chronological, newest-first) and the plan does not specify whether to change `commitsInRange` or sort independently. Changing `commitsInRange` would also alter the ordering seen by `scopeCheck` (a separate caller). Leaving it unchanged means the implementer must sort the commits before the overlap check without any guidance on how. Either path is a silent implementation decision not described in the plan.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:490` — function commitsInRange(repo, base, head) {
  // ...
  const out = git(repo, ['log', '--no-merges', `--format=${fmt}`, `${base}..${head}`]);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:628` — export function scopeCheck(repo, { base, head, branch = '', fetchLane = null, fetchPlanLane = null }) {
  ...
  const commits = commitsInRange(repo, base, head);

Suggestion: Explicitly state in the plan which path is taken. The safest approach: do not touch `commitsInRange`; inside the new multi-session branch of `validateRange`, extract the builder-session commits from the existing `commits` array and sort them by committer date (or re-query with `--topo-order --reverse`) independently. Name the helper and its inputs. This keeps `scopeCheck` untouched and makes the ordering unambiguous for rules 2c and 2e.

### R1-F2 [major]

Rule 2c's sub-condition 'each run starts no earlier (committer date) than the previous run ends', and rule 2e's 'claimed_by equals the last builder session', both require knowing each commit's committer date. `commitsInRange`'s format string and return value do not include committer dates. The plan is silent on how they are obtained — whether the format string at line 493 gains a `%cd` field, or a separate `git log` is issued. Without explicit specification this is an implementation gap that could produce a silently broken check.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:492` — const keys = ['Collab-Session', 'Collab-Lane', 'Collab-Review', 'Collab-Verdict', 'Collab-Reviewer', 'Collab-Reviewed-Head'];
const fmt = `%H${keys.map((k) => `%x1f%(trailers:key=${k},valueonly,separator=%x2c)`).join('')}%x1e`;
...
return { sha, session, lane, review, verdict, reviewer, reviewedHead, files };

Suggestion: Either (a) add `%cd` (ISO format) to the `commitsInRange` format string and extend the returned object with a `date` field, calling this out explicitly in the plan; or (b) drop the committer-date sub-condition from rule 2c — topo-order contiguity already prevents interleaved work in the DAG, and the claim mechanism prevents real-time overlap. Explain the choice. If (a), update all destructuring sites.

### R1-F3 [major]

Rule 2d's secondary acceptance criterion — 'in an entry's text written by a later session of the same seat' — cannot be evaluated by reading the lane file at HEAD alone. Lane file markdown bodies carry no per-line authorship. Determining which session wrote which body text requires walking `git log` history for the lane file and correlating per-commit diffs with body content. No existing function in `queue.mjs` does this, and the plan does not describe any new helper for it. An implementer will either drop the clause silently (making the rule stricter than specified) or attempt a fragile heuristic.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:490` — function commitsInRange(repo, base, head) { ... return { sha, session, lane, review, verdict, reviewer, reviewedHead, files }; }
- `exafyltd/vitana-platform:scripts/collab/queue.test.mjs:23` — const laneMd = (lane, o = {}) => `---\n${...}\n---\n## Log\n### 2026-10-13 · start\n`;

Suggestion: Remove the 'in an entry's text written by a later session' clause from rule 2d. Require only the primary criterion: every builder session must appear as the session field in at least one log entry header (`### <timestamp> · <session> · …`). This is checkable from the lane file text at HEAD with a single regex, is unambiguous, and is the pattern already used in the plan's test case ('B not named in the lane log → fail'). If the secondary clause is needed, it must be specified as a distinct rule with an explicit implementation path.

### R1-F4 [minor]

The plan states 'excluding `pm-agent` and `ci-plan-spar` (as today)' for the builder-session set, implying `ci-plan-spar` is already excluded from `sessionsByLane` in current code. It is not. Line 570 excludes only `pm-agent`. `ci-plan-spar` is practically absent from work-lane sessions because it always carries `Collab-Lane: <slug>/_plan` (not a work lane), but there is no explicit code exclusion. Labelling new `ci-plan-spar` exclusion logic as pre-existing could cause an implementer to omit the guard.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:569` — // VTID-05276 (plan §4.5): the Project Manager's lane-state commits do not count for one-session-per-lane or claimed_by.
if (k.lane && k.session !== PM_AGENT) {
  if (!sessionsByLane.has(k.lane)) sessionsByLane.set(k.lane, new Set());
  sessionsByLane.get(k.lane).add(k.session);
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:66` — const CI_PLAN_SPAR = 'ci-plan-spar';
const PM_AGENT = 'pm-agent';

Suggestion: Change 'as today' to 'newly excluded' for `ci-plan-spar` in the plan text, and add an explicit `k.session !== CI_PLAN_SPAR` guard alongside the existing `PM_AGENT` guard (line 570). Reference the VTID comment convention the codebase uses for such exclusions.

### R1-F5 [minor]

The plan's explicit test-run command lists `queue.test.mjs`, `plan-spar.test.mjs`, and `plan-driver.test.mjs`, omitting `automations.test.mjs`, which exists in `scripts/collab/` at the pinned ref. The CI job at PR-GATE line 133 runs `node --test scripts/collab/*.test.mjs` (glob), so `automations.test.mjs` will run in CI regardless. But a developer following the plan's command locally will skip it, making the local and CI runs diverge.

- `exafyltd/vitana-platform:scripts/collab` — automations.test.mjs  plan-driver.mjs  plan-driver.test.mjs  plan-spar.mjs  plan-spar.test.mjs  protected-gate-files.json  queue.mjs  queue.test.mjs  routine-prompt.md
- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:133` — run: node --test scripts/collab/*.test.mjs

Suggestion: Replace the explicit file list in the plan's run command with the same glob CI uses: `node --test scripts/collab/*.test.mjs`. This keeps the plan consistent with the CI job and future-proofs it against new test files being added.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
