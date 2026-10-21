/**
 * VTID-03853: wiring guard — the LLM merge review must sit AFTER the CI +
 * risk-class gates and BEFORE the actual mergePullRequest() call in
 * ciWatcherTick(), and must transition to 'failed' + bridge on a block,
 * exactly like the existing auto_merge_declined gate right above it.
 *
 * ciWatcherTick() itself needs a live Supabase + GitHub connection and isn't
 * unit-testable in isolation (same established scope limit as this module's
 * pure-helper tests in dev-autopilot-watcher.test.ts). This is a
 * source-level regression guard, matching the pattern already used for
 * dev-autopilot-execute.ts (vtid-03820/03821 sibling tests).
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE: string = fs.readFileSync(
  path.join(__dirname, '../src/services/dev-autopilot-watcher.ts'),
  'utf8'
);

describe('ciWatcherTick LLM review wiring (VTID-03853, source check)', () => {
  it('imports the review gate from dev-autopilot-llm-review', () => {
    expect(SOURCE).toContain("import { isLlmMergeReviewEnabled, runLlmMergeReview } from './dev-autopilot-llm-review';");
  });

  it('the review gate sits after the risk-class gate and before mergePullRequest', () => {
    const riskGateIdx = SOURCE.indexOf('const gate = shouldAutoMerge(riskClass);');
    const reviewIdx = SOURCE.indexOf('if (isLlmMergeReviewEnabled()) {');
    const mergeCallIdx = SOURCE.indexOf('const mergeRes = await githubService.mergePullRequest(');
    expect(riskGateIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(riskGateIdx);
    expect(mergeCallIdx).toBeGreaterThan(reviewIdx);
  });

  it('a blocked review transitions merging -> failed and bridges to self-healing, same shape as the risk-class decline', () => {
    const reviewIdx = SOURCE.indexOf('if (isLlmMergeReviewEnabled()) {');
    const mergeCallIdx = SOURCE.indexOf('const mergeRes = await githubService.mergePullRequest(');
    const block = SOURCE.slice(reviewIdx, mergeCallIdx);
    expect(block).toContain("await transitionStatus(s, exec.id, 'merging', 'failed'");
    expect(block).toContain("await bridgeFailure(exec.id, 'ci',");
    expect(block).toContain('continue;');
  });

  it('emits an OASIS event for both the passed and blocked outcomes', () => {
    const reviewIdx = SOURCE.indexOf('if (isLlmMergeReviewEnabled()) {');
    const mergeCallIdx = SOURCE.indexOf('const mergeRes = await githubService.mergePullRequest(');
    const block = SOURCE.slice(reviewIdx, mergeCallIdx);
    expect(block).toContain("'dev_autopilot.execution.llm_review_passed'");
    expect(block).toContain("'dev_autopilot.execution.llm_review_blocked'");
  });
});
