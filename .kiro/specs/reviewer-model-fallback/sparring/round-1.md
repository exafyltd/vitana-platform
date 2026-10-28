# Sparring round 1 — in_progress

Session: `a64cc2b2-9167-48f0-af23-be70c780596c` · plan hash `5b929c5bdfac7fdac6c6586f210bf726def7464acbbadc321ef5f7779280d9f4`

## Summary

Three findings across the plan. Two are major and must be fixed before implementation. The core premises about the existing code (governance.ts lines, guard.cjs mirror, lib.cjs coverage parsing, PLAN-SPAR trigger paths, /mode public route, decide.ts verify decision) all hold correctly. The two major issues are: (1) the staging-tests.json spec omits the mandatory `reason` field for the `existing` test entry, and no pre-merge validation step catches this because check-pr exits early for docs-only PRs — meaning a malformed manifest can only fail post-merge in STAGING-VERIFY; (2) the protected-gate-file unlock mechanism for the amendment-required contingency is wrong — the code exclusively allows legacy `claude` review and ignores both agent accepts and any "owner's instruction" pathway. One minor finding is a slightly understated line-range citation.

## Findings

### R1-F1 [major]

The `staging-tests.json` spec omits the mandatory `reason` field for the `existing` test, and no local or pre-merge step validates the manifest — so a malformed manifest can only be caught post-merge in STAGING-VERIFY, where it lands in `plan.invalid` and fails the run.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:192` — case 'existing': {
  ...
  if (typeof t.reason !== 'string' || t.reason.trim().length < 10) {
    errors.push(`${where}: reason must say why this suite covers the change`);
  }
- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:469` — function checkPr(args) {
  ...
  if (!lib.touchesService(files, service)) {
    log(`PR touches no ${service} deploy path — nothing deploys, no staging suite needed.`);
    return;
  }
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:36` — deployPaths: [
  'services/gateway/**',
  '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml',
],
- `exafyltd/vitana-platform:docs/validation/VTID-05281/staging-tests.json:36` — "kind": "existing",
"name": "observer CLAUDE_AVAILABLE read + env fallback",
"ref": "npx jest test/project-manager/observe-live.test.ts",
"cwd": "services/gateway",
"reason": "B1-B7: REST 404/403 unreadable, 200 value read, env fallback, variable wins, 4 h rule kept"
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:505` — if (failed || plan.missing.length > 0 || plan.invalid.length > 0) return 'failed';

Suggestion: Add `"reason"` (≥10 chars) to the `existing` test entry in the staged `staging-tests.json` spec, e.g. `"reason": "Pins the reviewer fallback chain order, Claude-only constraint, and exact accepted/rejected identity strings from governance.ts AGENT_REVIEWER_VALUES"`. Additionally, add an explicit local validation step: `node -e "const lib=require('./scripts/ci/staging-verify/lib.cjs'); const m=JSON.parse(require('fs').readFileSync('docs/validation/<VTID>/staging-tests.json','utf8')); const v=lib.validateManifest(m,{vtid:'<VTID>',service:'gateway'}); if(!v.ok){console.error(v.errors);process.exit(1);}"` to the Verification section so a malformed manifest is caught before the lane PR is raised. The `check-pr` command cannot be used here because `docs/validation/**` is not a gateway deploy path and `touchesService` exits early.

### R1-F2 [major]

The plan incorrectly describes the protected-gate-file unlock for the amendment-required contingency. It says the lane PR needs 'a legacy `claude` review on the current head **or** the owner's instruction, **in addition to** the reviewer-agent accept.' The code exclusively uses `isLegacyClaudeReview` to unlock a protected gate file — agent accepts are not evaluated in that branch at all, and there is no technical pathway for an 'owner's instruction' to serve as an unlock.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:180` — export function governanceMergeAllowed(
  lane: ObservedLane,
  pr: ObservedPr | null,
  review: ReviewEntry | null,
): GovernanceVerdict {
  const files = pr?.files ?? lane.paths;
  if (touchesProtectedGate(files)) {
    const unlocked =
      review != null && pr != null && isLegacyClaudeReview(review) && review.head_sha === pr.head_sha;
    return unlocked ? { ok: true } : { ok: false, reason: 'protected_gate_file' };
  }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:137` — export function isLegacyClaudeReview(r: ReviewEntry): boolean {
  return r.verdict === 'approve' && r.reviewer_seat === GOVERNANCE_REVIEWER && !r.reviewer;
}
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:43` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([
  ...
  'services/gateway/src/services/project-manager/governance.ts',
  ...

Suggestion: Replace the contingency description with the accurate mechanism: 'If a code amendment to `governance.ts` is required, the lane PR can only be merged by a legacy `claude` approve (verdict=`approve`, reviewer_seat=`claude`, no `reviewer` field) on the current head — `governanceMergeAllowed` short-circuits on the protected gate check and never evaluates agent accepts or any owner instruction for this file. In practice this means an admin merge or a seat-`claude` human approve. There is no automated path.' Alternatively, move any `governance.ts` amendment into its own separate PR with an explicit note that it requires a legacy claude review, keeping the `chain-coverage` lane PR to docs-only changes.

### R1-F3 [minor]

Two test line-range citations in the plan are slightly understated. `governance.test.ts lines 216-241` stops mid-test: the near-miss rejection test body and closing bracket extend to line 247. `guard.test.cjs:92-97` stops before line 98's Claude-only `startsWith('claude-')` assertion, which is part of the same test.

- `exafyltd/vitana-platform:services/gateway/test/project-manager/governance.test.ts:232` — it.each([
  ['agent:vitana-lane-reviewer (claude-opus-4.8)'],
  ...
  ['agent:vitana-lane-reviewer (claude-opus-5.5) x'],
])('fallback: reviewer %p (model outside the chain) → no merge', (reviewer) => {
  const r = agentAccept({ reviewer });
  const l = lane({ reviews: [r] });
  expect(isAgentReview(r)).toBe(false);
  expect(mergeDecision(l, [l])).toBeNull();
});
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.test.cjs:92` — test('agents: the reviewer model chain mirrors governance.ts REVIEWER_AGENT_MODELS (Claude only)', () => {
  assert.deepStrictEqual([...REVIEWER_MODELS], ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-sonnet-4.5']);
  ...
  assert.deepStrictEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), [...REVIEWER_MODELS]);
  assert.ok(REVIEWER_MODELS.every((x) => x.startsWith('claude-')));
});

Suggestion: Correct the citations to `governance.test.ts lines 216-247` and `guard.test.cjs:92-99` to accurately bound the covered tests.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
