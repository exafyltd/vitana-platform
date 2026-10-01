/**
 * VTID-04379: a Dev Autopilot PR merges only when it carries current main.
 */
import * as fs from 'fs';
import * as path from 'path';
import { decideBranchUpdate, MAX_BRANCH_UPDATES } from '../src/services/dev-autopilot-watcher';

describe('decideBranchUpdate', () => {
  it('merges when up to date', () => {
    expect(decideBranchUpdate(0, 0)).toBe('merge');
    expect(decideBranchUpdate(0, MAX_BRANCH_UPDATES + 3)).toBe('merge');
  });
  it('updates a behind branch, up to the cap', () => {
    expect(decideBranchUpdate(2, 0)).toBe('update');
    expect(decideBranchUpdate(1, MAX_BRANCH_UPDATES - 1)).toBe('update');
    expect(decideBranchUpdate(1, MAX_BRANCH_UPDATES)).toBe('give_up');
  });
});

describe('wiring', () => {
  const w = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
  const gh = fs.readFileSync(path.resolve(__dirname, '../src/services/github-service.ts'), 'utf8');
  it('the compare/update step runs before the merge gate and before the `behind` wait', () => {
    const step = w.indexOf('githubService.getBehindBy(');
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(w.indexOf("mState === 'behind' || !mState"));
    expect(step).toBeLessThan(w.indexOf("const enteredMerging = await transitionStatus(s, exec.id, 'ci', 'merging')"));
    expect(w).toContain("type: 'dev_autopilot.execution.branch_updated'");
  });
  it('update-branch is a merge pinned to the head we judged, never a rebase', () => {
    expect(gh).toMatch(/pulls\/\$\{prNumber\}\/update-branch/);
    expect(gh).toContain('expected_head_sha: expectedHeadSha');
    expect(gh).not.toMatch(/update-branch[\s\S]{0,200}rebase/);
  });
  it('a compare failure refuses the merge this tick', () => {
    expect(w).toMatch(/compare failed: \$\{err\}; refusing merge this tick`\);\n\s+continue;/);
  });
});
