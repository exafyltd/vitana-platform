# Sparring round 1 — in_progress

Session: `c221868c-7dc1-400b-b306-1d366d778b2f` · plan hash `c94c972907f58db8d2f4b6eea1883c36abe14b6b7f99d52dc5dba10b7c4375c7`

## Summary

The plan introduces an "owner-plan" path as an alternative to the two-model reviewer-agent accept rule for protected gate files. I verified the key premises about the existing code and found them accurate. However, there are significant gaps in the plan regarding how `governance.ts` (the PM's runtime guard) will implement the owner-plan bypass, the absence of gateway service tests, and missing validation for the new `protected_files` front-matter key.

## Findings

### R1-F1 [major]

The plan specifies the owner-plan path check at merge time in both `land-guard.mjs` and `governance.ts`, but the mechanism for `governance.ts` is architecturally unclear. Currently `governanceMergeAllowed(lane, pr, review, reviews)` receives `ObservedLane`, `ObservedPr`, and `ReviewEntry` objects — it has no access to commit trailers like `Owner-Approved-Plan: <slug>`. The plan's Stage 2 says the trailer on a commit authored by `exafyltd` is the signal, but doesn't explain how the PM's observation pipeline would surface this trailer to `governance.ts`. Without this, the PM path would still require two model accepts for any protected gate file change, even one on the owner-plan path, making the new path dead code in the PM runtime.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:200` — export function governanceMergeAllowed(
  lane: ObservedLane,
  pr: ObservedPr | null,
  review: ReviewEntry | null,
  reviews: readonly ReviewEntry[] = lane.reviews ?? (review ? [review] : []),
): GovernanceVerdict {
  const files = pr?.files ?? lane.paths;
  if (touchesProtectedGate(files)) {
    if (protectedAcceptModels(reviews, pr).length < PROTECTED_ACCEPTS_REQUIRED) return { ok: false, reason: 'protected_gate_file' };
    return { ok: true };
  }

Suggestion: Specify exactly how governance.ts will learn whether the owner-plan path applies. Options: (a) add an `owner_plan` field to ObservedLane/ObservedPr populated by the observer from commit trailers, (b) have governance.ts read `protected_gate: owner-plan` from the lane's trusted front matter plus verify the verdict, or (c) have the PM delegate to land-guard.mjs for the trailer check. Whatever the choice, the plan must name the data path and the new function signature.

### R1-F2 [major]

The plan lists `governance.ts` as a changed file but the Tests section says 'No staging or production test; repository scripts and rules only.' governance.ts is a TypeScript file inside `services/gateway/src/services/project-manager/` — it runs in the gateway service at runtime. Changes to it require at minimum the gateway's jest/integration tests to be run and updated with the new owner-plan path scenarios. The plan omits these tests entirely.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:1` — /**
 * VTID-05274 — Project Manager: the governance guard (plan kiro-autonomy-fallback §4.1, §4.3, §5 C1).
 *
 * PROTECTED GATE FILE. This file is itself on the protected list below, so a
 * change to it never merges on a reviewer-agent accept alone...

Suggestion: Add the gateway's PM governance test suite to the Tests section (likely a jest test file for governance.ts). Write test cases for: (1) owner-plan lane with valid verdict + correct trailer → merge allowed, (2) owner-plan lane with missing/non-converged verdict → refused, (3) owner-plan lane with changed file outside protected_files → refused, (4) owner-plan lane without the trailer → refused.

### R1-F3 [major]

The plan adds `protected_files:` as a new front-matter key on plans (handoff.md) but doesn't mention adding validation for it in `validatePlan()`. Without validation, a plan could declare arbitrary paths (including paths outside the protected gate list), and the constraint 'exact paths, no globs beyond the existing protected list' would be enforced only at merge time by the new `isOwnerPlanLane` function, not at the plan-validation level. A malformed or overly broad `protected_files` value would pass `queue.mjs validate` silently.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:203` — export function validatePlan(fm, slug) {
  const e = [];
  if (!fm) return ['no front matter'];
  if (fm.slug !== slug) e.push(`slug "${fm.slug ?? ''}" must equal the folder name "${slug}"`);
  ...
  if (fm.state === 'parked' && !PLAN_EDGES[fm.parked_from]) e.push('parked_from must name the non-terminal state the plan was parked from');
  if (fm.author_seat !== undefined && !SEAT_RE.test(fm.author_seat)) e.push(`author_seat "${fm.author_seat}" must be 1-12 lowercase letters`);
  return e;
}

Suggestion: Add validation in `validatePlan` that, when `protected_files` is present, every entry is a string that matches at least one glob in `PROTECTED_GATE_PATHS`. This enforces the 'exact paths within the existing protected list' invariant early, at PR validation time.

### R1-F4 [minor]

The plan's gate-invariant assertions (items 1-4) do not include a mutation test for the owner-plan path itself. The existing mutation test only covers setting `PROTECTED_ACCEPTS_REQUIRED = 1` (the two-model path). There is no invariant test that verifies the owner-plan path cannot be weakened — e.g., a mutation that removes the verdict check or the `protected_files` subset check from `isOwnerPlanLane` would not be caught by the gate-invariant suite.

- `exafyltd/vitana-platform:scripts/collab/gate-invariants.test.mjs:133` — T('mutation: one accept unlocking a protected gate file fails', async () => {
    const dir = fixture();
    edit(dir, 'scripts/collab/land-guard.mjs', (s) => s.replace('export const PROTECTED_ACCEPTS_REQUIRED = 2;', 'export const PROTECTED_ACCEPTS_REQUIRED = 1;'));
    const { failures } = await checkInvariants(dir);
    assert.ok(failures.some((f) => /with one accept/.test(f)), failures.join('\n'));
});

Suggestion: Add mutation tests in gate-invariants.test.mjs for the owner-plan path: (a) removing the verdict-convergence check still fails, (b) removing the protected_files subset check still fails. This ensures the new path has the same mechanical protection against weakening as the existing two-model path.

### R1-F5 [minor]

The plan's declared change class is 'standard' but it modifies `governance.ts`, a protected gate file that runs in the gateway production service. While the bootstrapping note correctly states the PR needs two reviewer-agent accepts under the current rule, the deployment of the governance.ts change will affect the PM's runtime merge-guard behavior in staging and then production. The plan should explicitly note the deployment dependency and staging verification step for the governance.ts change.

- `exafyltd/vitana-platform:scripts/collab/protected-gate-files.json:10` — "services/gateway/src/services/project-manager/governance.ts",

Suggestion: Add a 'Deployment' section that notes: the governance.ts change takes effect when the gateway service is next deployed to staging, and the PM's merge-guard behavior should be verified there before production promotion.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
