# Sparring round 1 — in_progress

Session: `ae817842-960d-4a44-9da6-fbd94919b3d9` · plan hash `34bdb0089f902d53612ae9843c832f069dd28e30fe26df4d76615731d11af592`

## Summary

The plan is thorough and well-evidenced. Its premises about the codebase are overwhelmingly correct — line-level citations for queue.mjs, land-guard.mjs, writers.ts, decide.ts, governance.ts, observe-live.ts, kiro-web-steering.mjs, plan-driver.mjs, protected-gate-files.json, and collaboration.md all check out. The inventory of contradictions (C1–C17) is grounded in code I read. I raise one major finding (the new governance authority file isn't protected) and two minor findings (land-guard.mjs gap, stale-ready bug description imprecision).

## Findings

### R1-F1 [major]

The plan creates `.claude/rules/operating-policy.md` as 'the authority for who may do what, when to stop, and the end point' (§4), making it the single highest-precedence governance file below owner instructions. However, neither `policy-text` nor `review-independence` adds `operating-policy.md` (or its Kiro twin `vitana-operating-policy.md`) to `scripts/collab/protected-gate-files.json`. This means a future lane with `executor: kiro` and a reviewer-agent accept can modify the governance authority — including stops, actor roles, and the unattended-merge permission — without a Claude review or owner instruction. Since the file explicitly supersedes content from `vitana-owner-autonomy.md`, `collaboration.md` §7 lists, and the CLAUDE.md Autonomy Contract, weakening it has outsized impact.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:1` — "globs": [
  "CLAUDE.md",
  "scripts/collab/plan-spar.mjs",
  "scripts/collab/queue.mjs",
  ...
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:186` — if (touchesProtectedGate(files)) {
  const unlocked = review != null && pr != null && isLegacyClaudeReview(review) && review.head_sha === pr.head_sha;
  return unlocked ? { ok: true } : { ok: false, reason: 'protected_gate_file' };

Suggestion: Add `.claude/rules/operating-policy.md` and `.kiro/steering/vitana-operating-policy.md` (both repos) to `protected-gate-files.json` globs. This belongs in the `review-independence` lane (which already edits that JSON file) or in `policy-text` (which creates the files). Without this, the new governance authority can be weakened by a non-Claude lane.

### R1-F2 [minor]

After the `review-independence` lane, `land-guard.mjs` imports the new `review-rule.mjs` and becomes the merge-time enforcer of review independence. But `land-guard.mjs` is not in `protected-gate-files.json`. A future change to `land-guard.mjs` (e.g., removing the review-rule import or skipping the call) could bypass the independence check and merge on a reviewer-agent accept alone. The new `review-rule.mjs` IS added to the protected list, but its caller is not.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:4` — "globs": [
  "CLAUDE.md",
  "scripts/collab/plan-spar.mjs",
  "scripts/collab/queue.mjs",
  "scripts/collab/protected-gate-files.json",
  ...
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:24` — import { globToRegex, PROTECTED_GATE_PATHS } from './queue.mjs';

Suggestion: Consider adding `scripts/collab/land-guard.mjs` to `protected-gate-files.json` as part of the `review-independence` lane. It's already a merge-governance file; after this change it becomes the runtime enforcer of review independence.

### R1-F3 [minor]

The plan's §2.4 states 'decide.ts:244-260 stale-ready can set seat == reviewer_seat, which queue.mjs:227 rejects'. The code at queue.mjs:227 does reject seat==reviewer_seat, but on a PM bookkeeping PR the scope check's PERM-change rule (queue.mjs:683-684) rejects ANY seat change by a non-Claude session before line 227 is ever reached. The effective rejection mechanism is the PERM-change rule, not the equality check. This doesn't affect the fix (pm-noop adds guards in both decide.ts and applyLaneChange), but the plan's diagnosis should be precise since it defines the test cases.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:678` — if (trustedFm) {
  const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
  const changed = PERM.filter((k) => JSON.stringify(asList(trustedFm[k])) !== JSON.stringify(asList(fm[k])));
  const sessions = new Set(commits.filter((k) => k.files.includes(lanePath) && k.session !== PM_AGENT).map((k) => k.session));
  const claudeOnly = sessions.size > 0 && [...sessions].every((x) => /^session_/.test(x));
  if (changed.length && !(trustedFm.executor === 'claude' && claudeOnly)) {
    errors.push(...);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:227` — if (fm.seat && fm.reviewer_seat === fm.seat) e.push('reviewer_seat must differ from seat (one Kiro account never reviews its own lane)');

Suggestion: Clarify in the plan that the blockage is the PERM-change rule (queue.mjs scope check rejects any seat change by a non-Claude session on a bookkeeping PR), and ensure the pm-noop test suite covers this rejection path (not just the seat==reviewer_seat equality). The applyLaneChange guard in writers.ts is still correct defense-in-depth.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
