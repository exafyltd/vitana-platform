/**
 * VTID-05080 — the REGEN-SCREENS-CATALOG PR helper keeps ONE rolling branch and
 * ONE open PR. Runs the real script against a local bare repo and a fake `gh`.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/ci/regen-screens-catalog-pr.sh');
const FILES = [
  'services/gateway/specs/dev-screen-inventory-v1.json',
  'services/gateway/src/frontend/command-hub/navigation-config.js',
];
const VTID = 'VTID-05080';
const BRANCH = 'auto/screens-catalog';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface Sandbox {
  dir: string;
  work: string;
  remote: string;
  ghLog: string;
  bin: string;
}

function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05080-'));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  const bin = path.join(dir, 'bin');
  const ghLog = path.join(dir, 'gh.log');
  fs.mkdirSync(bin);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.name', 'test');
  git(work, 'config', 'user.email', 'test@example.com');
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.writeFileSync(path.join(work, f), 'v0\n');
  }
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');

  // Fake gh: logs every call; `pr list ... length` answers FAKE_GH_COUNT (or fails
  // when FAKE_GH_FAIL_LIST is set); any other `pr list` answers the PR number 42.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
printf '@@CALL %s\n' "$*" >> "${ghLog}"
if [ "$1 $2" = "pr list" ]; then
  if [ -n "\${FAKE_GH_FAIL_LIST:-}" ]; then exit 1; fi
  case "$*" in
    *length*) echo "\${FAKE_GH_COUNT:-0}" ;;
    *) echo 42 ;;
  esac
fi
if [ "$1 $2" = "pr merge" ] && [ -n "\${FAKE_GH_FAIL_MERGE:-}" ]; then exit 1; fi
exit 0
`,
    { mode: 0o755 },
  );
  return { dir, work, remote, ghLog, bin };
}

function run(sb: Sandbox, mode: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, mode], {
    cwd: sb.work,
    encoding: 'utf8',
    env: {
      PATH: `${sb.bin}:${process.env.PATH}`,
      HOME: sb.dir,
      REGEN_STANDING_VTID: VTID,
      REGEN_REMOTE_URL: sb.remote,
      GITHUB_REPOSITORY: 'exafyltd/vitana-platform',
      GITHUB_TOKEN: 'default-token',
      ...extra,
    },
  });
}

function changeFiles(sb: Sandbox, value: string) {
  for (const f of FILES) fs.writeFileSync(path.join(sb.work, f), `${value}\n`);
}

function ghCalls(sb: Sandbox): string[] {
  if (!fs.existsSync(sb.ghLog)) return [];
  // A call's arguments may span lines (the PR body), so split on the call marker.
  return fs
    .readFileSync(sb.ghLog, 'utf8')
    .split('@@CALL ')
    .map((c) => c.trim())
    .filter(Boolean);
}

function remoteBranchSha(sb: Sandbox): string {
  return execFileSync('git', ['--git-dir', sb.remote, 'rev-parse', BRANCH], { encoding: 'utf8' }).trim();
}

describe('VTID-05080 regen-screens-catalog-pr.sh', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  });

  it('publish fails loudly, before touching anything, when the PAT secret is missing', () => {
    changeFiles(sb, 'v1');
    const r = run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: '' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('SCREENS_CATALOG_PR_TOKEN is not set');
    expect(ghCalls(sb)).toEqual([]);
    const branches = execFileSync('git', ['--git-dir', sb.remote, 'branch', '--list'], { encoding: 'utf8' });
    expect(branches).not.toContain(BRANCH);
  });

  it('first publish: branch absent -> pushed, one PR created with the standing VTID and validator markers, auto-merge on', () => {
    changeFiles(sb, 'v1');
    const r = run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_COUNT: '0' });
    expect(r.status).toBe(0);
    expect(remoteBranchSha(sb)).toBe(git(sb.work, 'rev-parse', 'HEAD'));
    const calls = ghCalls(sb);
    const create = calls.filter((c) => c.startsWith('pr create'));
    expect(create).toHaveLength(1);
    expect(create[0]).toContain(`(DEV-COMHU-0413) (${VTID})`);
    expect(create[0]).toContain('--head auto/screens-catalog');
    for (const marker of [
      `VTID: ${VTID}`,
      'VALIDATION_PROFILE: gateway_backend',
      'SCOPE_ALLOWLIST:',
      `ACCEPTANCE: docs/validation/${VTID}/acceptance.md`,
      'MERGE_PAYLOAD_PREVIEW:',
      'OASIS_IMPACT: no',
      'VTID_AUTO_CLOSE: no',
    ]) {
      expect(create[0]).toContain(marker);
    }
    expect(calls.some((c) => c.startsWith('pr merge --squash --auto'))).toBe(true);
    expect(git(sb.work, 'log', '-1', '--format=%s')).toBe(
      `chore(screens): auto-regenerate catalog from sources (DEV-COMHU-0413) (${VTID})`,
    );
  });

  it('second publish: branch exists, PR open -> head moves, NO second PR', () => {
    changeFiles(sb, 'v1');
    expect(run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_COUNT: '0' }).status).toBe(0);
    const first = remoteBranchSha(sb);

    git(sb.work, 'checkout', '-q', 'main');
    changeFiles(sb, 'v2');
    fs.writeFileSync(sb.ghLog, '');
    const r = run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_COUNT: '1' });
    expect(r.status).toBe(0);
    expect(remoteBranchSha(sb)).not.toBe(first);
    expect(ghCalls(sb).filter((c) => c.startsWith('pr create'))).toHaveLength(0);
    expect(r.stdout).toContain('already open');
  });

  it('merged-then-rerun: branch kept after the merge, no open PR -> a new PR opens', () => {
    changeFiles(sb, 'v1');
    expect(run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_COUNT: '0' }).status).toBe(0);
    git(sb.work, 'checkout', '-q', 'main');
    changeFiles(sb, 'v3');
    fs.writeFileSync(sb.ghLog, '');
    expect(run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_COUNT: '0' }).status).toBe(0);
    expect(ghCalls(sb).filter((c) => c.startsWith('pr create'))).toHaveLength(1);
  });

  it('a branch that moved underneath the run is never silently overwritten (lease)', () => {
    changeFiles(sb, 'v1');
    expect(run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_COUNT: '0' }).status).toBe(0);
    // A foreign push lands on the rolling branch, then a run whose ls-remote
    // happens before it would overwrite it: emulate by pushing with a stale lease.
    const other = path.join(sb.dir, 'other');
    execFileSync('git', ['clone', '-q', sb.remote, other]);
    git(other, 'config', 'user.name', 'x');
    git(other, 'config', 'user.email', 'x@example.com');
    git(other, 'checkout', '-q', BRANCH);
    fs.writeFileSync(path.join(other, 'foreign.txt'), 'x');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'foreign');
    git(other, 'push', '-q', 'origin', BRANCH);
    const stale = git(sb.work, 'rev-parse', 'HEAD');
    const push = spawnSync(
      'git',
      ['push', '-q', `--force-with-lease=${BRANCH}:${stale}`, 'origin', `HEAD:refs/heads/${BRANCH}`],
      { cwd: sb.work, encoding: 'utf8' },
    );
    expect(push.status).not.toBe(0);
  });

  it('API failure listing PRs is a warning, not a failure, and creates nothing', () => {
    changeFiles(sb, 'v1');
    const r = run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_FAIL_LIST: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('could not list PRs');
    expect(ghCalls(sb).filter((c) => c.startsWith('pr create'))).toHaveLength(0);
  });

  it('auto-merge that cannot be enabled is a warning, not a failure', () => {
    changeFiles(sb, 'v1');
    const r = run(sb, 'publish', { SCREENS_CATALOG_PR_TOKEN: 'pat', FAKE_GH_COUNT: '0', FAKE_GH_FAIL_MERGE: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('auto-merge could not be enabled');
  });

  it('cleanup: an open rolling PR is closed with a comment and its branch deleted', () => {
    const r = run(sb, 'cleanup', { FAKE_GH_COUNT: '1' });
    expect(r.status).toBe(0);
    const close = ghCalls(sb).filter((c) => c.startsWith('pr close'));
    expect(close).toHaveLength(1);
    expect(close[0]).toContain('pr close 42');
    expect(close[0]).toContain('--delete-branch');
  });

  it('cleanup: nothing open -> nothing closed, and no PAT is needed', () => {
    const r = run(sb, 'cleanup', { FAKE_GH_COUNT: '0', SCREENS_CATALOG_PR_TOKEN: '' });
    expect(r.status).toBe(0);
    expect(ghCalls(sb).filter((c) => c.startsWith('pr close'))).toHaveLength(0);
  });
});
