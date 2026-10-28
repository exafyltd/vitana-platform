/**
 * VTID-04217: fix mode merges the base branch into the PR branch first and
 * hands conflict markers to the agent; the runner never pushes a marker.
 *
 * Evidence: 2026-09-21 batch — 4 of 16 approved executions (c5a4f0bf,
 * 9e1c371f, add20bb2, c80751b5) failed `merge conflict (dirty)` after a
 * sibling PR merged first. Their fix-mode children received that text as
 * CI evidence and had no way to bring `main` into the branch.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  commitAndPush,
  defaultExec,
  findFilesWithConflictMarkers,
  listUnmergedFiles,
  mergeBaseIntoBranch,
  textHasConflictMarkers,
  type ExecFn,
} from '../src/services/autopilot-agent/agent-workspace';
import { buildFixModeTaskPrompt, buildMergeConflictSection } from '../src/services/autopilot-agent/agent-prompt';

const execFileP = promisify(execFile);

type Call = { cmd: string; args: string[] };

/** A scripted exec: records calls; `script` decides each git verb's result. */
function fakeExec(script: (args: string[]) => { stdout?: string; throw?: string } | undefined, calls: Call[]): ExecFn {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    const r = script(args) || {};
    if (r.throw) throw new Error(r.throw);
    return { stdout: r.stdout || '', stderr: '' };
  };
}

describe('VTID-04217: textHasConflictMarkers', () => {
  it('detects each marker kind at line start only', () => {
    expect(textHasConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> FETCH_HEAD\n')).toBe(true);
    expect(textHasConflictMarkers('=======\n')).toBe(true);
    expect(textHasConflictMarkers('const s = "<<<<<<< not at line start";\n')).toBe(false);
    expect(textHasConflictMarkers('// ======== eight equals is a divider, not a marker\n')).toBe(false);
    expect(textHasConflictMarkers('plain file\n')).toBe(false);
  });
});

describe('VTID-04217: mergeBaseIntoBranch (scripted git)', () => {
  it('deepens, fetches the base, merges FETCH_HEAD and reports a clean merge', async () => {
    const calls: Call[] = [];
    const exec = fakeExec((a) => {
      if (a[0] === 'rev-parse') return { stdout: 'abc123def456\n' };
      if (a[0] === 'merge') return { stdout: 'Merge made by the ort strategy.\n' };
      return {};
    }, calls);
    const r = await mergeBaseIntoBranch('/repo', 'main', { exec });
    expect(r).toEqual({ status: 'merged', conflicts: [], baseSha: 'abc123def456' });
    const verbs = calls.map((c) => c.args.slice(0, 3).join(' '));
    expect(verbs[0]).toBe('fetch --unshallow origin');
    expect(verbs[1]).toBe('fetch origin main');
    expect(calls.find((c) => c.args[0] === 'merge')?.args).toEqual(expect.arrayContaining(['--no-edit', 'FETCH_HEAD']));
  });

  it('falls back to a plain fetch when the clone is already complete', async () => {
    const calls: Call[] = [];
    const exec = fakeExec((a) => {
      if (a[0] === 'fetch' && a[1] === '--unshallow') return { throw: 'fatal: --unshallow on a complete repository does not make sense' };
      if (a[0] === 'rev-parse') return { stdout: 'b\n' };
      if (a[0] === 'merge') return { stdout: 'Already up to date.\n' };
      return {};
    }, calls);
    const r = await mergeBaseIntoBranch('/repo', 'main', { exec });
    expect(r.status).toBe('up_to_date');
    expect(calls.map((c) => c.args.join(' '))).toEqual(expect.arrayContaining(['fetch origin', 'fetch origin main']));
  });

  it('returns the conflicted paths when git leaves the merge in progress', async () => {
    const calls: Call[] = [];
    const exec = fakeExec((a) => {
      if (a[0] === 'rev-parse') return { stdout: 'b\n' };
      if (a[0] === 'merge') return { throw: 'CONFLICT (content): Merge conflict in services/gateway/src/x.ts' };
      if (a[0] === 'diff' && a.includes('--diff-filter=U')) return { stdout: 'services/gateway/src/x.ts\nservices/gateway/src/frontend/command-hub/app.js\n' };
      return {};
    }, calls);
    const r = await mergeBaseIntoBranch('/repo', 'main', { exec });
    expect(r.status).toBe('conflict');
    expect(r.conflicts).toEqual(['services/gateway/src/x.ts', 'services/gateway/src/frontend/command-hub/app.js']);
  });

  it('rethrows a merge failure that produced no unmerged paths (not a conflict)', async () => {
    const exec = fakeExec((a) => {
      if (a[0] === 'rev-parse') return { stdout: 'b\n' };
      if (a[0] === 'merge') return { throw: 'fatal: refusing to merge unrelated histories' };
      if (a[0] === 'diff') return { stdout: '' };
      return {};
    }, []);
    await expect(mergeBaseIntoBranch('/repo', 'main', { exec })).rejects.toThrow(/merge of main failed: .*unrelated histories/);
  });
});

describe('VTID-04217: commitAndPush skips the commit when the tree is already clean', () => {
  it('pushes HEAD without committing when git status is empty (clean auto-merge)', async () => {
    const calls: Call[] = [];
    const exec = fakeExec((a) => {
      if (a[0] === 'status') return { stdout: '' };
      if (a[0] === 'rev-parse') return { stdout: 'headsha\n' };
      return {};
    }, calls);
    const r = await commitAndPush('/repo', { message: 'm', branch: 'b', token: 't', exec, force: false });
    expect(r.sha).toBe('headsha');
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
  });

  it('still commits when something is staged', async () => {
    const calls: Call[] = [];
    const exec = fakeExec((a) => {
      if (a[0] === 'status') return { stdout: ' M a.ts\n' };
      if (a[0] === 'rev-parse') return { stdout: 'headsha\n' };
      return {};
    }, calls);
    await commitAndPush('/repo', { message: 'm', branch: 'b', token: 't', exec });
    expect(calls.some((c) => c.args[0] === 'commit')).toBe(true);
  });
});

describe('VTID-04217: fix-mode prompt carries the merge outcome', () => {
  const base = { vtid: 'VTID-04217', planMarkdown: 'plan', prUrl: 'https://x/pull/1', branch: 'dev-autopilot/abc', prFiles: ['a.ts'], ciEvidence: 'merge conflict (dirty)', attempt: 1, maxAttempts: 3 };

  it('lists the conflicted files and forbids discarding main', () => {
    const p = buildFixModeTaskPrompt({ ...base, mergeBase: { status: 'conflict', conflicts: ['a.ts', 'b.ts'], baseBranch: 'main' } });
    expect(p).toContain('## Merge conflicts to resolve FIRST');
    expect(p).toContain('- a.ts');
    expect(p).toContain('- b.ts');
    expect(p).toMatch(/keep BOTH intents/);
    expect(p).toMatch(/refuses to push while any marker remains/);
    expect(p.indexOf('Merge conflicts to resolve FIRST')).toBeLessThan(p.indexOf('CI failure evidence'));
  });

  it('says the merge already happened when it was clean', () => {
    const p = buildFixModeTaskPrompt({ ...base, mergeBase: { status: 'merged', conflicts: [], baseBranch: 'main' } });
    expect(p).toContain('## Base branch already merged');
    expect(p).toMatch(/only a merge conflict/);
  });

  it('adds nothing when up to date or when merge info is absent (pre-VTID-04217 prompt unchanged)', () => {
    expect(buildMergeConflictSection({ status: 'up_to_date', conflicts: [], baseBranch: 'main' })).toBe('');
    expect(buildMergeConflictSection(undefined)).toBe('');
    expect(buildFixModeTaskPrompt(base)).not.toContain('Merge conflicts');
  });
});

describe('VTID-04217: real git — conflict round trip on a local remote', () => {
  let root: string;
  let remote: string;
  let clone: string;
  const git = async (cwd: string, ...args: string[]) => (await execFileP('git', args, { cwd })).stdout.toString();
  const gitAvailable = async () => { try { await execFileP('git', ['--version']); return true; } catch { return false; } };

  beforeAll(async () => {
    if (!(await gitAvailable())) return;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vtid-04217-'));
    remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    await fs.mkdir(seed);
    await git(seed, 'init', '-q', '-b', 'main');
    await git(seed, 'config', 'user.email', 't@t');
    await git(seed, 'config', 'user.name', 't');
    await fs.writeFile(path.join(seed, 'f.txt'), 'line1\nline2\nline3\n');
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-q', '-m', 'base');
    // PR branch changes line2 one way …
    await git(seed, 'checkout', '-q', '-b', 'dev-autopilot/abc');
    await fs.writeFile(path.join(seed, 'f.txt'), 'line1\nline2-pr\nline3\n');
    await git(seed, 'commit', '-q', '-am', 'pr change');
    // … main changes it another way after the fork
    await git(seed, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(seed, 'f.txt'), 'line1\nline2-main\nline3\n');
    await git(seed, 'commit', '-q', '-am', 'main change');
    await git(root, 'clone', '-q', '--bare', seed, remote);
    clone = path.join(root, 'clone');
    // Same shape as prepareWorkspace({ existingBranch: true }): shallow, single branch.
    await git(root, 'clone', '-q', '--depth', '1', '--branch', 'dev-autopilot/abc', '--single-branch', remote, clone);
    await git(clone, 'config', 'user.email', 't@t');
    await git(clone, 'config', 'user.name', 't');
  }, 60_000);

  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it('reports the conflict, leaves markers, refuses until resolved, then pushes the merge commit', async () => {
    if (!(await gitAvailable())) return;
    const r = await mergeBaseIntoBranch(clone, 'main', { exec: defaultExec });
    expect(r.status).toBe('conflict');
    expect(r.conflicts).toEqual(['f.txt']);
    expect(await listUnmergedFiles(clone)).toEqual(['f.txt']);
    expect(await findFilesWithConflictMarkers(clone, ['f.txt', 'missing.txt'])).toEqual(['f.txt']);
    // The agent resolves by editing the file (exactly what edit_file does).
    await fs.writeFile(path.join(clone, 'f.txt'), 'line1\nline2-pr+main\nline3\n');
    expect(await findFilesWithConflictMarkers(clone, ['f.txt'])).toEqual([]);
    const pushed = await commitAndPush(clone, { message: 'resolve', branch: 'dev-autopilot/abc', token: 'unused', force: false });
    expect(pushed.sha).toMatch(/^[0-9a-f]{40}$/);
    const parents = (await git(clone, 'log', '-1', '--format=%P')).trim().split(' ');
    expect(parents).toHaveLength(2); // a real merge commit
    const remoteTip = (await git(remote, 'rev-parse', 'dev-autopilot/abc')).trim();
    expect(remoteTip).toBe(pushed.sha);
    const merged = (await git(remote, 'show', `${remoteTip}:f.txt`));
    expect(merged).toBe('line1\nline2-pr+main\nline3\n');
  }, 60_000);
});
