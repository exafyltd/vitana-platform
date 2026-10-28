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
