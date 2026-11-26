/**
 * The agent workspace on a GitLab merge-request branch (services/autopilot-agent/agent-workspace.ts).
 *
 * A GitLab-native repair may add exactly one thing to the merge request's branch: a commit on top of the head that failed. So:
 *   - the clone is of that branch from the GitLab remote it is given, and it is refused when the branch no longer points at the failing
 *     head (someone pushed since) before anything else runs;
 *   - the push carries a lease on that head: it is accepted only while the remote still points at it, which makes every accepted push a
 *     fast-forward, and it is never a bare `--force`;
 *   - finding the merge request's base reads history and never merges, resets, checks out or pushes.
 * git is a fake here (`exec` is injectable); the argv is the contract.
 */
import { commitAndPush, mergeBaseWithTarget, prepareWorkspace, type ExecFn } from '../src/services/autopilot-agent/agent-workspace';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const TOKEN = 'glpat-executor-token-not-real-0000';
const REMOTE = `https://oauth2:${TOKEN}@gitlab.vitanaland.com/vitana/vitana-platform.git`;
const BRANCH = 'delivery-loop/fix-greeting';

function fakeGit(answers: { head?: string; status?: string; mergeBase?: string; failUnshallow?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { stdout: `${answers.head ?? HEAD}\n`, stderr: '' };
    if (args[0] === 'status') return { stdout: answers.status ?? ' M services/gateway/src/services/greeting.ts\n', stderr: '' };
    if (args[0] === 'merge-base') return { stdout: `${answers.mergeBase ?? OTHER}\n`, stderr: '' };
    if (args[0] === 'fetch' && args[1] === '--unshallow' && answers.failUnshallow) throw new Error('fatal: --unshallow on a complete repository does not make sense');
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('prepareWorkspace on a GitLab merge-request branch', () => {
  it('clones the branch itself from the GitLab remote it is given, stays on it, and reports the head', async () => {
    const g = fakeGit();
    const ws = await prepareWorkspace({ owner: 'vitana', repo: 'vitana-platform', baseBranch: 'main', branch: BRANCH, token: TOKEN, existingBranch: true, remoteUrl: REMOTE, expectHeadSha: HEAD, exec: g.exec });
    expect(g.calls[0]).toEqual(['clone', '--depth', '1', '--branch', BRANCH, '--single-branch', REMOTE, ws.repoDir]);
    expect(g.calls.some((a) => a[0] === 'checkout')).toBe(false); // no new branch
    expect(g.calls.some((a) => a.join(' ').includes('github.com'))).toBe(false);
    expect(ws.baseSha).toBe(HEAD);
    expect(ws.branch).toBe(BRANCH);
  });

  it('refuses a branch that moved since the failure, before anything else runs, and the error carries no token', async () => {
    const g = fakeGit({ head: OTHER });
    await expect(
      prepareWorkspace({ owner: 'vitana', repo: 'vitana-platform', baseBranch: 'main', branch: BRANCH, token: TOKEN, existingBranch: true, remoteUrl: REMOTE, expectHeadSha: HEAD, exec: g.exec }),
    ).rejects.toThrow(/branch moved/);
    await prepareWorkspace({ owner: 'vitana', repo: 'vitana-platform', baseBranch: 'main', branch: BRANCH, token: TOKEN, existingBranch: true, remoteUrl: REMOTE, expectHeadSha: HEAD, exec: g.exec })
      .catch((e: Error) => expect(e.message).not.toContain(TOKEN));
    // clone, the identity, then rev-parse: nothing after the check (no edit, no fetch, no push).
    expect(g.calls.map((a) => a[0])).toEqual(['clone', 'config', 'config', 'rev-parse', 'clone', 'config', 'config', 'rev-parse']);
  });

  it('without a remote it is the GitHub clone, unchanged', async () => {
    const g = fakeGit();
    await prepareWorkspace({ owner: 'exafyltd', repo: 'vitana-platform', baseBranch: 'main', branch: 'dev-autopilot/abc', token: 'ghp-x', exec: g.exec });
    expect(g.calls[0][6]).toBe('https://x-access-token:ghp-x@github.com/exafyltd/vitana-platform.git');
    expect(g.calls[3]).toEqual(['checkout', '-b', 'dev-autopilot/abc']);
  });
});

describe('commitAndPush with a lease on the failing head', () => {
  it('pushes with --force-with-lease on that exact head and never with a bare --force', async () => {
    const g = fakeGit({ head: OTHER });
    const r = await commitAndPush('/tmp/ws', { message: 'fix(ci): x', branch: BRANCH, token: TOKEN, force: true, leaseSha: HEAD, exec: g.exec });
    expect(r.sha).toBe(OTHER);
    const push = g.calls.find((a) => a[0] === 'push');
    expect(push).toEqual(['push', `--force-with-lease=refs/heads/${BRANCH}:${HEAD}`, '-u', 'origin', BRANCH]);
    expect(g.calls.flat()).not.toContain('--force'); // the lease wins over force: true
  });

  it('refuses a lease that is not a full sha before anything is committed or pushed', async () => {
    const g = fakeGit();
    await expect(commitAndPush('/tmp/ws', { message: 'm', branch: BRANCH, token: TOKEN, leaseSha: 'abc', exec: g.exec })).rejects.toThrow(/lease/);
    expect(g.calls).toEqual([]);
  });

  it('a push the remote refuses (the branch moved) is an error, with the token scrubbed', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_c, args) => {
      calls.push(args);
      if (args[0] === 'status') return { stdout: ' M a.ts\n', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: `${OTHER}\n`, stderr: '' };
      if (args[0] === 'push') throw new Error(`! [rejected] ${BRANCH} (stale info) to ${REMOTE}`);
      return { stdout: '', stderr: '' };
    };
    await expect(commitAndPush('/tmp/ws', { message: 'm', branch: BRANCH, token: TOKEN, leaseSha: HEAD, exec })).rejects.toThrow(/stale info/);
    await commitAndPush('/tmp/ws', { message: 'm', branch: BRANCH, token: TOKEN, leaseSha: HEAD, exec }).catch((e: Error) => expect(e.message).not.toContain(TOKEN));
  });
});

describe('mergeBaseWithTarget', () => {
  it('deepens, fetches the target branch and answers the merge base; it never merges, resets, checks out or pushes', async () => {
    const g = fakeGit({ mergeBase: OTHER });
    expect(await mergeBaseWithTarget('/tmp/ws', 'main', g.exec)).toBe(OTHER);
    expect(g.calls).toEqual([
      ['fetch', '--unshallow', 'origin'],
      ['fetch', 'origin', 'main'],
      ['merge-base', 'HEAD', 'FETCH_HEAD'],
    ]);
  });

  it('falls back to a plain fetch on a complete clone', async () => {
    const g = fakeGit({ failUnshallow: true });
    await mergeBaseWithTarget('/tmp/ws', 'main', g.exec);
    expect(g.calls.map((a) => a.join(' '))).toEqual(['fetch --unshallow origin', 'fetch origin', 'fetch origin main', 'merge-base HEAD FETCH_HEAD']);
  });

  it('refuses a target branch that would be read as an option', async () => {
    const g = fakeGit();
    await expect(mergeBaseWithTarget('/tmp/ws', '--upload-pack=x', g.exec)).rejects.toThrow(/target branch/);
    expect(g.calls).toEqual([]);
  });
});
