# Sparring round 1 — in_progress

Session: `4ad2defb-c30f-413f-9169-d9d6412727c9` · plan hash `b199a3c2a5ee1b50cd73e13d7397d71995180ddc069c123207fab80fafb46e2e`

## Summary

The plan is well-scoped and the core logic change (accept policy approval as an alternative to owner approval in `evaluateSparringRecord`) is sound. The premises about vitana-platform code are verified and accurate. The main concern is that the vitana-v1 lane cannot be verified — no pinned ref is available for that repo, and multiple approximate searches returned zero results for any PR-GATE related code. If the PR-GATE code doesn't exist in vitana-v1, the second lane is superfluous or will fail. One minor gap in test coverage is also noted.

## Findings

### R1-F1 [major]

The plan claims vitana-v1 has an identical copy of `evaluateSparringRecord` at `scripts/ci/pr-gate/lib.mjs:202-209` and a matching test at `scripts/ci/pr-gate/__tests__/lib.test.mjs:75-78`, and declares a second lane `policy-approval-record-v1` to change both. No pinned ref for vitana-v1 is available in this session, and six separate approximate searches (for `evaluateSparringRecord`, `owner approval`, `PR-GATE`, `sparring`, `node --test scripts/ci/pr-gate`, `scripts ci pr-gate`) all returned zero results in that repo. If the PR-GATE infrastructure does not exist in vitana-v1, the second lane is invalid scope and will fail at implementation.

- `exafyltd/vitana-platform:scripts/ci/pr-gate/lib.mjs:153` — export function evaluateSparringRecord(text) {
    const t = String(text || '');
    const problems = [];
    if (!/\b(CONVERGED|ESCALATED)\b/.test(t)) problems.push('no verdict (CONVERGED / ESCALATED)');
    if (!/owner approval/i.test(t)) problems.push('no owner-approval line');
    if (!/plan hash/i.test(t)) problems.push('no plan hash');
    return problems;
  }

Suggestion: Before implementation, verify that `scripts/ci/pr-gate/lib.mjs` actually exists in vitana-v1 at the claimed line range. If it does not, drop the `policy-approval-record-v1` lane. If it does, note the evidence (commit hash and line range) so the implementer can confirm.

### R1-F2 [minor]

The test cases listed in the plan do not include a case for a policy-approved CONVERGED record that is missing the plan hash line. The plan says 'The verdict and plan-hash checks stay as they are,' and the existing test at line 77 covers the missing-plan-hash scenario for owner-approved records, but a dedicated test for the policy-approval path with a missing plan hash would confirm the two checks compose correctly and prevent regressions.

- `exafyltd/vitana-platform:scripts/ci/pr-gate/__tests__/lib.test.mjs:75` — test('sparring record needs verdict, owner approval and plan hash', () => {
    assert.deepEqual(L.evaluateSparringRecord('Plan hash: abc\nverdict **CONVERGED**\n**Owner approval (Gate 1): yes'), []);
    assert.equal(L.evaluateSparringRecord('CONVERGED').length, 2);
  });

Suggestion: Add a test case: a CONVERGED record with policy approval text but no 'plan hash' line should return exactly one problem ('no plan hash').

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
