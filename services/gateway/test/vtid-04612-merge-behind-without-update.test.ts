/**
 * VTID-04612: a green operator PR that is behind main merges on its CI when the
 * commits main gained touch none of its files. Observed 2026-09-26 on staging:
 * main took a merge every 5-10 minutes, each forced a branch update and ~8
 * minutes of CI on the PR, and after MAX_BRANCH_UPDATES the watcher gave up —
 * PR #3726 reached update 3 of 5 in 20 minutes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { canMergeBehindWithoutUpdate } from '../src/services/dev-autopilot-watcher';

describe('canMergeBehindWithoutUpdate', () => {
  it('merges when main touched none of the PR files', () => {
    expect(canMergeBehindWithoutUpdate({
      prFiles: ['services/gateway/src/services/dev-autopilot-supervisor.ts', 'services/gateway/test/a.test.ts'],
      baseChangedFiles: ['services/gateway/src/orb/live/greeting.ts', 'docs/x.md'],
      baseTruncated: false,
    })).toEqual({ ok: true, overlap: [] });
  });

  it('refuses and names the overlap when main touched a PR file', () => {
    expect(canMergeBehindWithoutUpdate({
      prFiles: ['a.ts', 'b.ts'],
      baseChangedFiles: ['b.ts', 'c.ts'],
      baseTruncated: false,
    })).toEqual({ ok: false, overlap: ['b.ts'] });
  });

  it('refuses when the file lists are incomplete or missing', () => {
    expect(canMergeBehindWithoutUpdate({ prFiles: ['a.ts'], baseChangedFiles: ['c.ts'], baseTruncated: true }).ok).toBe(false);
    expect(canMergeBehindWithoutUpdate({ prFiles: null, baseChangedFiles: ['c.ts'], baseTruncated: false }).ok).toBe(false);
    expect(canMergeBehindWithoutUpdate({ prFiles: [], baseChangedFiles: ['c.ts'], baseTruncated: false }).ok).toBe(false);
    expect(canMergeBehindWithoutUpdate({ prFiles: ['a.ts'], baseChangedFiles: null, baseTruncated: false }).ok).toBe(false);
  });
});

describe('wiring', () => {
  const w = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
  const gh = fs.readFileSync(path.resolve(__dirname, '../src/services/github-service.ts'), 'utf8');

  it('the overlap check only runs for a clean PR, before the update step', () => {
    const check = w.indexOf("if (decision !== 'merge' && mState === 'clean')");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(w.indexOf("if (decision === 'update') {"));
  });

  it('a failed overlap check keeps the branch-update path', () => {
    expect(w).toMatch(/overlap check failed: \$\{err\}; keeping the branch-update path/);
  });

  it('getBaseChangesSince compares head...base and reports truncation', () => {
    expect(gh).toMatch(/compare\/\$\{encodeURIComponent\(headSha\)\}\.\.\.\$\{encodeURIComponent\(base\)\}/);
    expect(gh).toContain('r.files.length >= 300');
  });
});
