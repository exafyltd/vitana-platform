/**
 * VTID-05006: both Vitana repos inside every Kiro session's workspace.
 *
 * The runner keeps one shared, partial (blob-less) clone per repo under
 * <workRoot>/.mirrors, fetched again every 10 minutes. Each session gets its own
 * `git worktree` of origin/main inside its directory — seconds, not a fresh
 * clone — so Kiro can read, grep and edit locally. Kiro never gets a push
 * credential: its edits leave through the gateway's dev_push_kiro_branch.
 *
 * Never blocks a session: if a mirror is not ready yet, that session simply
 * starts without it. All git work for one repo is serialised.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface RepoSpec { name: string; url: string }

export const VITANA_REPOS: RepoSpec[] = [
  { name: 'vitana-platform', url: 'https://github.com/exafyltd/vitana-platform.git' },
  { name: 'vitana-v1', url: 'https://github.com/exafyltd/vitana-v1.git' },
];

export const MIRROR_REFRESH_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 10 * 60_000;

// A minimal git environment: no credentials, no prompts, no user config.
const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
});

function git(args: string[], cwd?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
  });
}

export class RepoMirrors {
  private ready = new Set<string>();
  private chains = new Map<string, Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private root: string, private repos: RepoSpec[] = VITANA_REPOS, private log: (m: string) => void = (m) => console.log(m)) {}

  mirrorDir(name: string): string { return path.join(this.root, '.mirrors', name); }
  isReady(name: string): boolean { return this.ready.has(name); }

  /** Serialise every git operation on one repo. */
  private run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(name) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(name, next.catch(() => undefined));
    return next;
  }

  /** Clone missing mirrors, fetch existing ones. Failures are logged, never thrown. */
  async refresh(): Promise<void> {
    fs.mkdirSync(path.join(this.root, '.mirrors'), { recursive: true });
    await Promise.all(this.repos.map((r) => this.run(r.name, async () => {
      const dir = this.mirrorDir(r.name);
      try {
        if (!fs.existsSync(path.join(dir, '.git'))) {
          fs.rmSync(dir, { recursive: true, force: true });
          await git(['clone', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', 'main', r.url, dir]);
        } else {
          await git(['fetch', '--prune', 'origin', 'main'], dir);
          await git(['worktree', 'prune'], dir);
        }
        this.ready.add(r.name);
      } catch (e) {
        this.log(`[kiro-runner] mirror ${r.name} refresh failed: ${(e as Error).message.split('\n')[0].slice(0, 200)}`);
      }
    })));
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, MIRROR_REFRESH_MS);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Give a session its own checkout of each ready repo (detached at origin/main). Never throws. */
  async addWorktrees(sessionDir: string): Promise<string[]> {
    const added: string[] = [];
    await Promise.all(this.repos.filter((r) => this.ready.has(r.name)).map((r) => this.run(r.name, async () => {
      const target = path.join(sessionDir, r.name);
      try {
        if (!fs.existsSync(sessionDir)) return; // the session already ended
        await git(['worktree', 'add', '--detach', target, 'origin/main'], this.mirrorDir(r.name));
        added.push(r.name);
      } catch (e) {
        this.log(`[kiro-runner] worktree ${r.name} failed: ${(e as Error).message.split('\n')[0].slice(0, 200)}`);
      }
    })));
    return added;
  }
}
