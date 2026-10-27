# Sparring round 2 — converged

Session: `2fa9d1a5-25cf-42cf-aee3-947923d43d79` · plan hash `3e174360a2574aba580f9db8b73ceaf0448e40f0f2b8932c30c94c7b30a1961f`

## Summary

The revised plan properly addresses R1-F1 (accepted): D3 removes driver.md from TEXT_ONLY_REFS, T-F adds driver.md to the RUNBOOKS fixture, and a deletion case tests the missing-file error. All key premises verified against code. The plan is sound and ready for implementation. One minor finding on an existing test that needs attention.

## Findings

### R2-F1 [minor]

Existing test at guard.test.cjs:292 is named '(driver.md is text-only)' and its assertion at line 296 (`doesNotMatch(e, /driver\.md/)`) currently passes because driver.md is in TEXT_ONLY_REFS. After the plan removes driver.md from TEXT_ONLY_REFS (D3) and adds it to the RUNBOOKS fixture (R1-F1 fix), the assertion will still pass — but only because driver.md now exists in the fixture via RUNBOOKS. The test name becomes misleading. More importantly, if someone later reads this test as proof that driver.md is still text-only-exempt, they'd be wrong. Consider renaming the test and updating or removing the driver.md-specific assertion to reflect the new semantics.

- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.test.cjs:292` — test('workflow: the steering entry point may only name pipeline files that exist (driver.md is text-only)', () => {
    const steer = '# p\nKiro IDE: `.kiro/workflows/vitana-pipeline.workflow.json`. Kiro Web: `.kiro/pipeline/driver.md`. See `.kiro/pipeline/gone.md`.\n';
    const e = errs({ '.kiro/steering/vitana-pipeline.md': steer });
    assert.match(e, /vitana-pipeline\.md names \.kiro\/pipeline\/gone\.md/);
    assert.doesNotMatch(e, /driver\.md/);
});
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:113` — // Named as text only and owned by another lane (plan section 7, "text-only cross references"); not required to exist.
const TEXT_ONLY_REFS = new Set(['.kiro/pipeline/driver.md']);

Suggestion: Rename the test to remove the '(driver.md is text-only)' parenthetical (e.g. 'workflow: the steering entry point may only name pipeline files that exist') and either drop the driver.md-specific doesNotMatch or replace it with a positive check that driver.md existence is now enforced (e.g. delete driver.md from the fixture and assert an error).

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The plan properly addresses R1-F1: D3 removes driver.md from TEXT_ONLY_REFS, T-F adds driver.md to the RUNBOOKS fixture list so pipelineRepo() writes it, and a further test case deletes driver.md from the fixture to verify the missing-file error. The planner's rationale is sound.
