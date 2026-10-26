# Sparring round 2 — in_progress

Session: `f6ce4455-d462-4a10-8e98-82927189a637` · plan hash `ec9232daed8b71b5bdc8a6117dbc7e7e685fd1797cef37ea4c2c22dce503bc9c`

## Summary

All five findings from round 1 were accepted by the planner. None of them were actually applied to the revised plan text. R1-F1 through R1-F5 are re-raised as R2-F1 through R2-F5. No new independent findings were identified beyond those re-raises.

## Findings

### R2-F1 [major]

Re-raise R1-F1. The planner accepted the fix and explicitly stated 'New helper builderOrder(repo, base, head) = git rev-list --topo-order --reverse --no-merges base..head ... Named in the plan block.' The revised plan does NOT name builderOrder anywhere. Rule 2c says only 'In commit order (--topo-order --reverse)' with no specification of (a) what function to write, (b) that git rev-list is the right primitive vs. reversing the existing commitsInRange array, or (c) how to map the SHA list back onto the commitsInRange objects that carry trailer data. An implementer who reverses the commitsInRange array gets reverse-chronological, not topo-order, and the contiguity check in rule 2c will silently give wrong answers for non-linear DAG topologies.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:490` — function commitsInRange(repo, base, head) {
  const out = git(repo, ['log', '--no-merges', `--format=${fmt}`, `${base}..${head}`]);
  return ... { sha, session, lane, review, verdict, reviewer, reviewedHead, files };

Suggestion: Add an explicit paragraph to the Change section naming builderOrder(repo, base, head) and describing it as calling git rev-list --topo-order --reverse --no-merges base..head, returning an ordered SHA array. State that the multi-session branch of validateRange filters the existing commits array by matching .sha against each element of builderOrder output to obtain the lane's builder commits in topo order. commitsInRange and therefore scopeCheck remain untouched.

### R2-F2 [major]

Re-raise R1-F2. The planner accepted option (b) — 'the committer-date sub-condition is dropped' — but rule 2c in the revised plan still reads 'each run starts no earlier (committer date) than the previous run ends.' The clause has not been removed. The commitsInRange format string at line 492 contains no %cd field and its returned objects have no date property, so the clause is unimplementable as written and an implementer must silently invent or drop it.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:492` — const keys = ['Collab-Session', 'Collab-Lane', 'Collab-Review', 'Collab-Verdict', 'Collab-Reviewer', 'Collab-Reviewed-Head'];
const fmt = `%H${keys.map((k) => ...)}%x1e`;
...
return { sha, session, lane, review, verdict, reviewer, reviewedHead, files };

Suggestion: Remove the clause 'and each run starts no earlier (committer date) than the previous run ends' from rule 2c, exactly as the accepted rationale promised. Topo-order contiguity (A A B B vs. A B A) plus the claim ref are sufficient to prevent real-time overlap.

### R2-F3 [major]

Re-raise R1-F3. The planner accepted removing the body-text authorship clause, writing 'No body-text authorship is inferred. Rule 2d is now: every builder session id appears in the lane file log at head (entry author or named in an entry), one string search per session on the head file.' But rule 2d in the revised plan still reads 'as an entry author or in an entry text written by a later session of the same seat.' The 'written by a later session of the same seat' qualifier is still present and requires per-line authorship of lane log body text — something no function in queue.mjs performs and for which the plan describes no helper.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:490` — function commitsInRange(repo, base, head) {
  ...
  return { sha, session, lane, review, verdict, reviewer, reviewedHead, files };
}
- `exafyltd/vitana-platform:scripts/collab/queue.test.mjs:23` — const laneMd = (lane, o = {}) => `---\n...\n---\n## Log\n### 2026-10-13 · start\n`;

Suggestion: Delete 'or in an entry text written by a later session of the same seat' from rule 2d exactly as the accepted rationale states. The rule should read: every builder session is named in the lane log at head as an entry author (matching '### timestamp · session · ...') or named anywhere in a log entry. Bound the search to the ## Log section to avoid false-positives from front-matter fields such as claimed_by.

### R2-F4 [minor]

Re-raise R1-F4. The planner accepted changing '(as today)' to 'newly excluded' for ci-plan-spar and promised an explicit k.session !== CI_PLAN_SPAR guard. The revised plan still says 'excluding pm-agent and ci-plan-spar (as today).' The code at line 570 shows only PM_AGENT is excluded today; ci-plan-spar is not. The '(as today)' qualifier remains factually wrong and can cause an implementer to omit the new guard.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:569` — // VTID-05276 (plan §4.5): the Project Manager's lane-state commits do not count for one-session-per-lane or claimed_by.
if (k.lane && k.session !== PM_AGENT) {
  if (!sessionsByLane.has(k.lane)) sessionsByLane.set(k.lane, new Set());
  sessionsByLane.get(k.lane).add(k.session);
}

Suggestion: Replace '(as today)' with '(pm-agent as today; ci-plan-spar newly excluded)' and explicitly state that the guard becomes k.session !== PM_AGENT && k.session !== CI_PLAN_SPAR, with a VTID comment following the convention at line 569.

### R2-F5 [minor]

Re-raise R1-F5. The planner accepted using the CI glob and said 'Run command is now node --test scripts/collab/*.test.mjs.' The revised plan Tests section still reads 'Run: node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs scripts/collab/plan-driver.test.mjs' — the explicit three-file list, not the glob. This diverges from the CI job at PR-GATE.yml line 133.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:133` — run: node --test scripts/collab/*.test.mjs

Suggestion: Replace the explicit file list in the plan run command with node --test scripts/collab/*.test.mjs, matching the CI job exactly.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
