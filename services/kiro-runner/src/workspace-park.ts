/**
 * VTID-05064: a session that ends with uncommitted work keeps its directory.
 *
 * Kiro edits files in its own worktrees and leaves them only through the
 * gateway's dev_push_kiro_branch. A session that idles out before that push
 * used to lose the edits (relay end() removed the directory). Now:
 *
 * - end() asks git whether any worktree is dirty. Clean → removed as before.
 *   Dirty → the directory is "parked": a marker file is written and the
 *   directory stays at the SAME path (the mirror's `git worktree` admin data
 *   keeps pointing at it, so `worktree prune` does not drop it).
 * - The next session of the same user and thread takes the parked directory
 *   over (exclusively: the entry is removed before the hand-off).
 * - Parked directories are swept after a TTL and capped in number; a revoked
 *   key removes that user's. A runner restart on the same task rescans the
 *   markers; a new task (redeploy) starts with an empty disk — the gateway
 *   notices that from the "fresh" workspace frame and says so.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export const PARK_MARKER = '.kiro-parked.json';
const GIT_STATUS_TIMEOUT_MS = 5_000;

export interface ParkedWorkspace { dir: string; userId: string; threadId: string; parkedAt: number }
export interface ParkLimits { ttlMs: number; maxParked: number }

const parked = new Map<string, ParkedWorkspace>();
const keyOf = (userId: string, threadId: string) => `${userId}\u0000${threadId}`;

export function parkedCount(): number { return parked.size; }
export function resetParked(): void { parked.clear(); }

/** The repo worktrees directly under a session directory (a `.git` file or directory). */
function worktrees(dir: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => !n.startsWith('.') && fs.existsSync(path.join(dir, n, '.git')));
}

function gitStatus(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: GIT_STATUS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // An unreadable worktree counts as dirty: keeping it is the safe side.
      resolve(err ? '?? unreadable' : String(stdout));
    });
  });
}

/** Names of the worktrees under `dir` that hold uncommitted changes. */
export async function dirtyRepos(dir: string): Promise<string[]> {
  const names = worktrees(dir);
  const states = await Promise.all(names.map(async (n) => ((await gitStatus(path.join(dir, n))).trim() ? n : null)));
  return states.filter((n): n is string => n !== null);
}

/** Keep `dir` for the next session of this user and thread. */
export function park(dir: string, userId: string, threadId: string, limits: ParkLimits, log: (m: string) => void, now = Date.now()): void {
  const entry: ParkedWorkspace = { dir, userId, threadId, parkedAt: now };
  try { fs.writeFileSync(path.join(dir, PARK_MARKER), JSON.stringify({ user_id: userId, thread_id: threadId, parked_at: now }), { mode: 0o600 }); } catch { /* the map still holds it */ }
  const old = parked.get(keyOf(userId, threadId));
  if (old && old.dir !== dir) remove(old, 'replaced', log);
  parked.set(keyOf(userId, threadId), entry);
  enforceCap(limits, log);
}

/** Hand a parked directory to a new session of the same user and thread (exclusive), or null. */
export function takeParked(userId: string, threadId: string): string | null {
  const k = keyOf(userId, threadId);
  const entry = parked.get(k);
  if (!entry) return null;
  parked.delete(k);
  if (!fs.existsSync(entry.dir)) return null;
  try { fs.rmSync(path.join(entry.dir, PARK_MARKER), { force: true }); } catch { /* harmless */ }
  return entry.dir;
}

function remove(entry: ParkedWorkspace, why: string, log: (m: string) => void): void {
  parked.delete(keyOf(entry.userId, entry.threadId));
  fs.rm(entry.dir, { recursive: true, force: true }, () => {});
  log(`[kiro-runner] parked workspace for thread ${entry.threadId.slice(0, 64)} removed (${why})`);
}

function enforceCap(limits: ParkLimits, log: (m: string) => void): void {
  if (parked.size <= limits.maxParked) return;
  const oldest = [...parked.values()].sort((a, b) => a.parkedAt - b.parkedAt);
  for (const e of oldest.slice(0, parked.size - limits.maxParked)) remove(e, 'over the parked cap', log);
}

/** Remove parked directories older than the TTL. */
export function sweepParked(limits: ParkLimits, log: (m: string) => void, now = Date.now()): number {
  let n = 0;
  for (const e of [...parked.values()]) if (now - e.parkedAt > limits.ttlMs) { remove(e, 'retention expired', log); n++; }
  return n;
}

/** A revoked key: that user's parked work goes too. */
export function dropUserParked(userId: string, log: (m: string) => void): number {
  let n = 0;
  for (const e of [...parked.values()]) if (e.userId === userId) { remove(e, 'key revoked', log); n++; }
  return n;
}

/** After a process restart on the same task: rebuild the map from the markers on disk. */
export function rescanParked(workRoot: string, limits: ParkLimits, log: (m: string) => void): number {
  let names: string[] = [];
  try { names = fs.readdirSync(workRoot); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(workRoot, name);
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, PARK_MARKER), 'utf8'); } catch { continue; }
    try {
      const m = JSON.parse(raw) as { user_id?: unknown; thread_id?: unknown; parked_at?: unknown };
      if (typeof m.user_id !== 'string' || typeof m.thread_id !== 'string' || typeof m.parked_at !== 'number') continue;
      parked.set(keyOf(m.user_id, m.thread_id), { dir, userId: m.user_id, threadId: m.thread_id, parkedAt: m.parked_at });
      n++;
    } catch { /* a broken marker is ignored; the directory is not adopted */ }
  }
  enforceCap(limits, log);
  sweepParked(limits, log);
  return n;
}
