# Sparring round 1 — in_progress

Session: `2fa9d1a5-25cf-42cf-aee3-947923d43d79` · plan hash `f34d88f6cf873f9c14ed5bd470ca35b8f5e93aff3b1bb1013e77b5746ba9d3aa`

## Summary

The plan is thorough, well-researched, and the design decisions are sound. The root cause analysis is correct: the prompts name all three chain models in one sentence, and the agent's self-check has no unambiguous rule for extracting "its" model, leading to spurious model_unavailable outputs that win the race and park slots. The fix (a fixed prefix line keyed by both the agent and the guard) is minimal and testable. All major premises verified against the code. One minor gap found in the test fixture for driver.md.

## Findings

### R1-F1 [minor]

Test T-F claims that removing the label from `driver.md` triggers an error, but `driver.md` is not in the test fixture's `RUNBOOKS` array (guard.test.cjs:61), so `pipelineRepo()` never writes it to the temp directory. The guard's runbook loop (guard.cjs:240-248) scans `.kiro/pipeline/*.md` via `readdirSync` and would not find `driver.md` in the fixture. Additionally, `driver.md` is in `TEXT_ONLY_REFS` (guard.cjs:114), meaning the guard currently tolerates it not existing. The plan must add `driver.md` to the `RUNBOOKS` fixture list and ensure the new content check handles the TEXT_ONLY_REFS / optional-existence case gracefully.

- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.test.cjs:61` — const RUNBOOKS = ['README.md', 'common-rules.md', 'planning.md', 'lane-code.md', 'lane-review.md', 'lane-land.md'].map((f) => `.kiro/pipeline/${f}`);
function real(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function pipelineRepo(over = {}) {
  const files = { 'CLAUDE.md': 'x', '.kiro/steering/a.md': ALWAYS, 'scripts/collab/queue.mjs': '// marker\n' };
  for (const p of [AGENT, WORKFLOW, HOOK, ...RUNBOOKS]) files[p] = real(p);
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:113` — // Named as text only and owned by another lane (plan section 7, "text-only cross references"); not required to exist.
const TEXT_ONLY_REFS = new Set(['.kiro/pipeline/driver.md']);
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:239` —     const pipeDir = path.join(root, PIPELINE_DIR);
    const runbooks = fs.existsSync(pipeDir) ? fs.readdirSync(pipeDir).filter((f) => f.endsWith('.md')) : [];
    for (const f of runbooks) {
      const text = fs.readFileSync(path.join(pipeDir, f), 'utf8');

Suggestion: Add `'driver.md'` to the `RUNBOOKS` array in guard.test.cjs so the fixture includes it, and ensure the new guard content check for the label in `driver.md` is conditional on file existence (consistent with TEXT_ONLY_REFS semantics), or remove `driver.md` from TEXT_ONLY_REFS now that the plan requires it to exist with specific content.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
