# Plan sparring record — reviewer-model-fallback (VTID-05335, lane chain-coverage)
- Partner: CI PLAN-SPAR (vitana-platform `PLAN-SPAR.yml`), session `a64cc2b2-9167-48f0-af23-be70c780596c`.
- Class: standard
- Plan hash (sha256 of the text between the plan markers, final): e94a76d9d40ea093625c855e335d1bfc5362c86d412eda2e05b8a448f720ec1c
- Verdict: **CONVERGED** (round 3; R1-F1 major, R1-F2 major, R1-F3 minor, R2-F1 major — all ACCEPTED).
- Owner approval (Gate 1): not asked — policy approval `converged-auto-v1` at 2026-10-22T13:36:26Z replaces Gate 1 for a
  CI-sparred plan. Owner instruction behind the change (2026-10-21): "if one model is not available it should pick up
  another one as fallback ... then a third one".
- VTIDs: VTID-05335 (lane `chain-coverage`), allocated by CI PLAN-SPAR.
- Spec: `.kiro/specs/reviewer-model-fallback/` (plan PR #4321, head 1bcaba9e9893b897fe90bdac61cbab02f2cbc6da).
- Covers: commit `91d26a1560763d0835d85276cda7d139e496aa12` (#4295),
  `services/gateway/src/services/project-manager/governance.ts`.
## Round 1 (verbatim)
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
## Responses 1 (verbatim)
# Responses — round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified lib.cjs:192 requires reason (>=10 chars) on an existing test and run.mjs:469 checkPr returns early for a PR that touches no gateway deploy path (lib.cjs:36), so a docs-only lane PR is not validated pre-merge. Plan changed: the existing jest entry now carries the mandatory reason (text as suggested), and Verification adds the local lib.validateManifest(m,{vtid,service:'gateway'}) command (lib.cjs:211, exported at :770) that must pass before the lane PR is raised.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified governance.ts:180 governanceMergeAllowed short-circuits on touchesProtectedGate and unlocks only with isLegacyClaudeReview (governance.ts:137) on the current head; agent accepts and owner instructions are not evaluated. Plan changed: the chain-coverage lane PR is docs-only and changes neither governance.ts nor its test; any future governance.ts amendment goes in its own separate PR that states it needs a legacy claude approve (seat-claude approve or owner admin merge), never the automated PM merge. The lane keeps governance.ts in paths only as the recorded owner of the 91d26a15 change.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified the near-miss it.each closes at governance.test.ts:247 and the Claude-only assert is guard.test.cjs:98. Plan citations corrected to governance.test.ts:216-247 / 221-247 and guard.test.cjs:92-99 (also in requirements.md and design.md).",
    "deferred_to": ""
  }
]
```
## Round 2 (verbatim)
# Sparring round 2 — in_progress

Session: `a64cc2b2-9167-48f0-af23-be70c780596c` · plan hash `775deb435011d183af5ba22a407e7dcc4e4e672ed874ab9219970c1d4a151265`

## Summary

Round 2 review of the revised plan. All three prior findings (R1-F1 missing reason, R1-F2 protected-gate unlock mechanism, R1-F3 line citations) were accepted and are correctly addressed in the revision: the `existing` test now carries a `reason`, Verification adds a local `validateManifest` step, the contingency now accurately describes the legacy-claude-only unlock, and citations are corrected (verified governance.test.ts:216-247 and guard.test.cjs:92-99). One new finding (R2-F1) concerns the lane deliberately declaring a protected gate file in its `paths`: under `governanceMergeAllowed`'s `pr?.files ?? lane.paths` fallback this can trigger the protected-gate block and require a legacy claude approve, contradicting the plan's assertion that the docs-only PR merges via the automated PM path.

## Findings

### R2-F1 [major]

The plan keeps `services/gateway/src/services/project-manager/governance.ts` (and its test) in the lane's declared `paths` "only as the recorded owner", but `governanceMergeAllowed` falls back to `pr?.files ?? lane.paths`, and `protectedFilesIn` matches the literal governance.ts path against `PROTECTED_GATE_GLOBS`. If the observer does not supply `pr.files` (the exact case the `?? lane.paths` fallback and the docs comment in governance.ts:176-179 exist to handle), `touchesProtectedGate(lane.paths)` returns true and the merge is blocked with `protected_gate_file` unless a legacy `claude` approve on the current head is present — contradicting the plan's stated design that the docs-only lane PR merges through the automated PM accept.

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
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:43` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([
  'CLAUDE.md',
  ...
  'services/gateway/src/services/project-manager/governance.ts',
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:100` — export function protectedFilesIn(files: readonly string[]): string[] {
  return files.filter((f) => {
    const norm = String(f).replace(/^\.?\//, '');
    return PROTECTED_RES.some((re) => re.test(norm));
  });
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:175` —   * The final merge guard (decide precondition + act defence in depth).
  * Changed files are `pr.files` when the observer supplied them, else the lane's
  * declared paths are checked as file names.
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/decide.ts:184` —     // 10. VTID-05274: protected gate files / governance paths (governance.ts).
    if (!governanceMergeAllowed(lane, pr, review).ok) return null;

Suggestion: Either do not list `governance.ts` / `governance.test.ts` in the lane's `paths` (rely on the commit-coverage entry's `reason` and the plan-sparring.md to record ownership, since `paths` is only evaluated as a fallback and provides no coverage value), or, if the lane must include them for ownership traceability, add an explicit note that the chain-coverage lane PR could fall into the protected-gate fork when the observer omits `pr.files`, and in that case requires a legacy `claude` approve (seat-claude or owner admin merge) on the current head — i.e., the docs-only PR is not guaranteed to merge via the automated accept. Recommend the first option to keep the lane PR cleanly mergable by the agent accept.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Revision adds the mandatory reason to the existing test and a local validateManifest verification step, matching lib.cjs:200 and the exported validateManifest at lib.cjs:770.
- R1-F2: acknowledged — Revision now accurately states governanceMergeAllowed short-circuits on the protected gate check and unlocks only with a legacy claude approve; confirmed against governance.ts:180-190 and isLegacyClaudeReview at :137-140.
- R1-F3: acknowledged — Citations corrected to governance.test.ts:216-247 and guard.test.cjs:92-99, both confirmed.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
## Responses 2 (verbatim)
# Responses — round 2

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified governance.ts:175-185 checks pr?.files ?? lane.paths and decide.ts:184 calls it. Took the partner's second option, because the lane must keep governance.ts in paths: the lane is the recorded owner of the 91d26a15 governance.ts change that rule 47 counts, and the coverage entry and lane must name the same file. Plan changed: an explicit note that the live observer supplies pr.files from pulls/<n>/files for an active lane PR (observe-live.ts:384-405, :683), so normally the docs-only PR is judged on its real files and merges on the agent accept; if pr.files is absent (types.ts:106-107) the PR falls into the protected-gate fork, is not guaranteed to merge on the agent accept, and needs a legacy claude approve (seat-claude or owner admin merge) on the current head. The driver does not route around it; a lane stuck on protected_gate_file is parked with the five-part stop message.",
    "deferred_to": ""
  }
]
```
## Round 3 (verbatim)
# Sparring round 3 — converged

Session: `a64cc2b2-9167-48f0-af23-be70c780596c` · plan hash `e94a76d9d40ea093625c855e335d1bfc5362c86d412eda2e05b8a448f720ec1c`

## Summary

The revised plan correctly and accurately addresses R2-F1. I verified the key code premises and the planner's new contingency analysis is correct. Key confirmations: (1) governance.ts:180-203 — with pr.files present (docs-only), touchesProtectedGate returns false AND laneTouchesGovernance returns false (governance.ts is in PROTECTED_GATE_GLOBS, NOT GOVERNANCE_PATHS which only lists .github/, .claude/, .kiro/steering/, .kiro/automations/, scripts/collab/, CLAUDE.md, docs/programs/areas.yaml), so the merge proceeds on the agent accept. (2) observe-live.ts:384-407 supplies pr.files via pullFiles (observe-live.ts:682-684), and ghPages (github-rest.ts:51-60) fetches per_page=100 × maxPages=10 → up to 1000 files, no truncation concern for a docs-only PR. (3) types.ts:106-107 documents files as optional "absent = unknown (lane paths are checked)". (4) The staging probe routes are real: /mode is public ({ok:true}) and /status requires requireServiceOrAdmin (401 without bearer), confirmed in routes/project-manager.ts and route.test.ts. (5) parseCommitCoverage (lib.cjs:280-292) matches the plan's entry shape. The plan correctly documents the residual protected-gate fallback when pr.files is absent. No new findings; the plan is sound and ready.

## Findings

_none_
## Acknowledgements of earlier responses

- R2-F1: acknowledged — The planner took my recommended path and the revised plan now accurately documents the merge mechanics. I independently verified the deeper consequence the plan does not need to belabor: governance.ts is in PROTECTED_GATE_GLOBS but NOT in GOVERNANCE_PATHS, so laneTouchesGovernance returns false and the docs-only PR (with pr.files present) merges cleanly via agent accept. The residual fallback (pr.files absent → lane.paths hits protected-gate fork) is correctly flagged as not-guaranteed and parked for the owner. Rationale is sound.
## Verdict (verbatim)
# Verdict — reviewer-model-fallback

CONVERGED and approved by policy `converged-auto-v1` at 2026-10-22T13:36:26.068+00:00.
Session `a64cc2b2-9167-48f0-af23-be70c780596c` · final plan hash `e94a76d9d40ea093625c855e335d1bfc5362c86d412eda2e05b8a448f720ec1c`.
VTIDs: VTID-05335
