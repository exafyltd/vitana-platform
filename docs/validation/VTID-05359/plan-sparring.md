# Plan sparring record — reviewer-step-model (VTID-05359)
Copied from `.kiro/specs/reviewer-step-model/sparring/` on origin/main 499ad9fcea.

Owner approval: policy approval `converged-auto-v1` (collaboration.md §7, VTID-05214). Verdict: CONVERGED and approved by policy `converged-auto-v1` at 2026-10-27T23:09:16.734+00:00, session `2fa9d1a5-25cf-42cf-aee3-947923d43d79`, final plan hash `3e174360a2574aba580f9db8b73ceaf0448e40f0f2b8932c30c94c7b30a1961f`.

## round-1.md
# Sparring round 1 ΓÇö in_progress

Session: `2fa9d1a5-25cf-42cf-aee3-947923d43d79` ┬╖ plan hash `f34d88f6cf873f9c14ed5bd470ca35b8f5e93aff3b1bb1013e77b5746ba9d3aa`

## Summary

The plan is thorough, well-researched, and the design decisions are sound. The root cause analysis is correct: the prompts name all three chain models in one sentence, and the agent's self-check has no unambiguous rule for extracting "its" model, leading to spurious model_unavailable outputs that win the race and park slots. The fix (a fixed prefix line keyed by both the agent and the guard) is minimal and testable. All major premises verified against the code. One minor gap found in the test fixture for driver.md.

## Findings

### R1-F1 [minor]

Test T-F claims that removing the label from `driver.md` triggers an error, but `driver.md` is not in the test fixture's `RUNBOOKS` array (guard.test.cjs:61), so `pipelineRepo()` never writes it to the temp directory. The guard's runbook loop (guard.cjs:240-248) scans `.kiro/pipeline/*.md` via `readdirSync` and would not find `driver.md` in the fixture. Additionally, `driver.md` is in `TEXT_ONLY_REFS` (guard.cjs:114), meaning the guard currently tolerates it not existing. The plan must add `driver.md` to the `RUNBOOKS` fixture list and ensure the new content check handles the TEXT_ONLY_REFS / optional-existence case gracefully.

- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.test.cjs:61` ΓÇö const RUNBOOKS = ['README.md', 'common-rules.md', 'planning.md', 'lane-code.md', 'lane-review.md', 'lane-land.md'].map((f) => `.kiro/pipeline/${f}`);
function real(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function pipelineRepo(over = {}) {
  const files = { 'CLAUDE.md': 'x', '.kiro/steering/a.md': ALWAYS, 'scripts/collab/queue.mjs': '// marker\n' };
  for (const p of [AGENT, WORKFLOW, HOOK, ...RUNBOOKS]) files[p] = real(p);
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:113` ΓÇö // Named as text only and owned by another lane (plan section 7, "text-only cross references"); not required to exist.
const TEXT_ONLY_REFS = new Set(['.kiro/pipeline/driver.md']);
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:239` ΓÇö     const pipeDir = path.join(root, PIPELINE_DIR);
    const runbooks = fs.existsSync(pipeDir) ? fs.readdirSync(pipeDir).filter((f) => f.endsWith('.md')) : [];
    for (const f of runbooks) {
      const text = fs.readFileSync(path.join(pipeDir, f), 'utf8');

Suggestion: Add `'driver.md'` to the `RUNBOOKS` array in guard.test.cjs so the fixture includes it, and ensure the new guard content check for the label in `driver.md` is conditional on file existence (consistent with TEXT_ONLY_REFS semantics), or remove `driver.md` from TEXT_ONLY_REFS now that the plan requires it to exist with specific content.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.

## responses-1.md
# Responses ΓÇö round 1 (session 2fa9d1a5)
```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Plan D3 now removes driver.md from TEXT_ONLY_REFS (guard.cjs:113-114), because the plan makes it a required runbook with required content, so a missing driver.md is a `missing` error. Test T-F adds 'driver.md' to the fixture's RUNBOOKS list (guard.test.cjs:61), so pipelineRepo() writes it and the label-removal case can go red. One extra case deletes driver.md from the fixture and expects `missing`. driver.md was already in the lane's paths."}
]
```

## round-2.md
# Sparring round 2 ΓÇö converged

Session: `2fa9d1a5-25cf-42cf-aee3-947923d43d79` ┬╖ plan hash `3e174360a2574aba580f9db8b73ceaf0448e40f0f2b8932c30c94c7b30a1961f`

## Summary

The revised plan properly addresses R1-F1 (accepted): D3 removes driver.md from TEXT_ONLY_REFS, T-F adds driver.md to the RUNBOOKS fixture, and a deletion case tests the missing-file error. All key premises verified against code. The plan is sound and ready for implementation. One minor finding on an existing test that needs attention.

## Findings

### R2-F1 [minor]

Existing test at guard.test.cjs:292 is named '(driver.md is text-only)' and its assertion at line 296 (`doesNotMatch(e, /driver\.md/)`) currently passes because driver.md is in TEXT_ONLY_REFS. After the plan removes driver.md from TEXT_ONLY_REFS (D3) and adds it to the RUNBOOKS fixture (R1-F1 fix), the assertion will still pass ΓÇö but only because driver.md now exists in the fixture via RUNBOOKS. The test name becomes misleading. More importantly, if someone later reads this test as proof that driver.md is still text-only-exempt, they'd be wrong. Consider renaming the test and updating or removing the driver.md-specific assertion to reflect the new semantics.

- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.test.cjs:292` ΓÇö test('workflow: the steering entry point may only name pipeline files that exist (driver.md is text-only)', () => {
    const steer = '# p\nKiro IDE: `.kiro/workflows/vitana-pipeline.workflow.json`. Kiro Web: `.kiro/pipeline/driver.md`. See `.kiro/pipeline/gone.md`.\n';
    const e = errs({ '.kiro/steering/vitana-pipeline.md': steer });
    assert.match(e, /vitana-pipeline\.md names \.kiro\/pipeline\/gone\.md/);
    assert.doesNotMatch(e, /driver\.md/);
});
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:113` ΓÇö // Named as text only and owned by another lane (plan section 7, "text-only cross references"); not required to exist.
const TEXT_ONLY_REFS = new Set(['.kiro/pipeline/driver.md']);

Suggestion: Rename the test to remove the '(driver.md is text-only)' parenthetical (e.g. 'workflow: the steering entry point may only name pipeline files that exist') and either drop the driver.md-specific doesNotMatch or replace it with a positive check that driver.md existence is now enforced (e.g. delete driver.md from the fixture and assert an error).

## Acknowledgements of earlier responses

- R1-F1: acknowledged ΓÇö The plan properly addresses R1-F1: D3 removes driver.md from TEXT_ONLY_REFS, T-F adds driver.md to the RUNBOOKS fixture list so pipelineRepo() writes it, and a further test case deletes driver.md from the fixture to verify the missing-file error. The planner's rationale is sound.

## verdict.md
# Verdict ΓÇö reviewer-step-model

CONVERGED and approved by policy `converged-auto-v1` at 2026-10-27T23:09:16.734+00:00.
Session `2fa9d1a5-25cf-42cf-aee3-947923d43d79` ┬╖ final plan hash `3e174360a2574aba580f9db8b73ceaf0448e40f0f2b8932c30c94c7b30a1961f`.
VTIDs: VTID-05359

