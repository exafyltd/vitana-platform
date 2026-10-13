/**
 * VTID-05146 (Dev Autopilot autonomy, Phase C): no collisions with people.
 *
 * Before the autopilot claims an execution (against the plan's file list) and
 * before it auto-merges a PR (against the PR's real changed files), it asks
 * GitHub for every open pull request in the repository — any author, any
 * branch, drafts included — and each one's complete file list. A shared file
 * puts the execution on hold (`held_overlap`, blocking PR numbers recorded)
 * instead of running or merging. The watcher re-checks held executions every
 * tick and releases them when the blocking PRs merge or close; a hold older
 * than `overlap_hold_max_hours` ends the execution as failed
 * (`overlap_hold_timeout`). Nothing is ever merged on a timeout.
 *
 * `frozen_scope` (dev_autopilot_config, temporary globs set while people work
 * an area) is checked here too: a plan touching it is never approved, and an
 * open autopilot PR touching it is held, never merged.
 *
 * GitHub failures never count as "no overlap": the caller refuses the claim or
 * the merge for this tick and tries again on the next one.
 */

import githubService from './github-service';
import { matchGlob } from './dev-autopilot-safety';
import { emitOasisEvent } from './oasis-event-service';

export const HELD_OVERLAP = 'held_overlap';
export const OVERLAP_HOLD_MAX_HOURS_DEFAULT = 72;

/** One open pull request and the files it changes. `complete=false` → GitHub's 3,000-file cap was hit. */
export interface OpenPrFiles {
  number: number;
  branch: string;
  files: string[];
  complete: boolean;
}

export interface OverlapBlock {
  pr: number;
  branch: string;
  files: string[];
}

/** What is recorded on a held execution: `metadata.overlap_hold`. */
export interface OverlapHoldRecord {
  from: 'cooling' | 'ci';
  held_at: string;
  checked_at: string;
  blocking_prs: OverlapBlock[];
  frozen_files: string[];
}

export type OpenPrSnapshot = { ok: true; prs: OpenPrFiles[] } | { ok: false; error: string };

export interface OverlapGithub {
  listOpenPullRequests: typeof githubService.listOpenPullRequests;
  getAllPrFiles: typeof githubService.getAllPrFiles;
}

/** A PR's files by its head commit, so one tick never fetches the same list twice. */
const fileCache = new Map<string, { files: string[]; complete: boolean; at: number }>();
const FILE_CACHE_TTL_MS = 10 * 60_000;

/** Test seam: forget cached file lists. */
export function resetOverlapCache(): void {
  fileCache.clear();
}

/**
 * Every open PR in `repo` with its complete file list. Fails as a whole (never
 * a partial "no overlap") when GitHub cannot list the PRs or one PR's files.
 */
export async function loadOpenPrFiles(repo: string, gh: OverlapGithub = githubService): Promise<OpenPrSnapshot> {
  try {
    const listed = await gh.listOpenPullRequests(repo);
    if (!listed.complete) return { ok: false, error: 'more open pull requests than the overlap check pages through' };
    const now = Date.now();
    for (const [k, v] of fileCache) if (now - v.at > FILE_CACHE_TTL_MS) fileCache.delete(k);
    const prs: OpenPrFiles[] = [];
    for (const pr of listed.prs) {
      const key = `${repo}#${pr.number}@${pr.head_sha}`;
      let entry = fileCache.get(key);
      if (!entry || now - entry.at > FILE_CACHE_TTL_MS) {
        const got = await gh.getAllPrFiles(repo, pr.number);
        entry = { files: got.files, complete: got.complete, at: now };
        fileCache.set(key, entry);
      }
      prs.push({ number: pr.number, branch: pr.branch, files: entry.files, complete: entry.complete });
    }
    return { ok: true, prs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Pure. The open PRs (other than `excludePr`) that change any of `files`. A PR
 * whose file list hit GitHub's cap blocks everything: its full list is unknown.
 */
export function findOverlaps(files: string[], prs: OpenPrFiles[], excludePr?: number | null): OverlapBlock[] {
  const mine = new Set(files);
  const blocks: OverlapBlock[] = [];
  for (const pr of prs) {
    if (excludePr && pr.number === excludePr) continue;
    if (!pr.complete) {
      blocks.push({ pr: pr.number, branch: pr.branch, files: ['(file list incomplete — more than 3,000 files)'] });
      continue;
    }
    const shared = pr.files.filter((f) => mine.has(f));
    if (shared.length) blocks.push({ pr: pr.number, branch: pr.branch, files: Array.from(new Set(shared)).sort() });
  }
  return blocks;
}

/** Pure. The files that match a `frozen_scope` glob. */
export function frozenHits(files: string[], frozenScope: unknown): string[] {
  const globs = Array.isArray(frozenScope) ? frozenScope.filter((g): g is string => typeof g === 'string' && g.trim().length > 0) : [];
  if (globs.length === 0) return [];
  return files.filter((f) => globs.some((g) => matchGlob(f, g)));
}

/** Pure. Has a hold that started at `heldAt` run past `maxHours`? An unreadable start counts as expired. */
export function holdExpired(heldAt: string | null | undefined, maxHours: number, now: number = Date.now()): boolean {
  const t = heldAt ? Date.parse(heldAt) : NaN;
  if (!Number.isFinite(t)) return true;
  const hours = Number.isFinite(maxHours) && maxHours > 0 ? maxHours : OVERLAP_HOLD_MAX_HOURS_DEFAULT;
  return now - t > hours * 3_600_000;
}

/** Pure. Same blocking PRs (numbers and files) as last time? Avoids a row write every tick. */
export function sameBlocks(a: OverlapBlock[] | undefined, b: OverlapBlock[]): boolean {
  const key = (x: OverlapBlock[]) => JSON.stringify([...x].sort((p, q) => p.pr - q.pr).map((p) => [p.pr, p.files]));
  return key(a || []) === key(b);
}

/** The hold record read back from an execution's metadata. */
export function readHold(metadata: Record<string, unknown> | null | undefined): OverlapHoldRecord | null {
  const h = metadata && (metadata as { overlap_hold?: unknown }).overlap_hold;
  if (!h || typeof h !== 'object') return null;
  const rec = h as Partial<OverlapHoldRecord>;
  if (rec.from !== 'cooling' && rec.from !== 'ci') return null;
  return {
    from: rec.from,
    held_at: String(rec.held_at || ''),
    checked_at: String(rec.checked_at || ''),
    blocking_prs: Array.isArray(rec.blocking_prs) ? rec.blocking_prs : [],
    frozen_files: Array.isArray(rec.frozen_files) ? rec.frozen_files : [],
  };
}

/** One line for an OASIS message or a PR comment. */
export function describeBlocks(blocks: OverlapBlock[], frozen: string[]): string {
  const parts: string[] = [];
  if (blocks.length) parts.push(`open PR${blocks.length === 1 ? '' : 's'} ${blocks.map((b) => `#${b.pr} (${b.files.slice(0, 3).join(', ')}${b.files.length > 3 ? ', …' : ''})`).join('; ')}`);
  if (frozen.length) parts.push(`frozen scope (${frozen.slice(0, 3).join(', ')}${frozen.length > 3 ? ', …' : ''})`);
  return parts.join(' and ') || 'nothing';
}

// ---------------------------------------------------------------------------
// Runtime: config, the check, and the hold write (shared by the executor's
// claim and the CI watcher's merge — neither imports the other).
// ---------------------------------------------------------------------------


const OVERLAP_VTID = 'VTID-DEV-AUTOPILOT';

export interface OverlapSupa { url: string; key: string }

async function rest<T>(s: OverlapSupa, path: string, init: RequestInit = {}): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${s.url}${path}`, {
      ...init,
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    const text = await res.text();
    return { ok: true, data: text ? (JSON.parse(text) as T) : undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export interface OverlapConfig { frozen_scope: string[]; overlap_hold_max_hours: number }

/** frozen_scope and the hold limit. A failed read is `null`: the caller must not proceed as if nothing were frozen. */
export async function loadOverlapConfig(s: OverlapSupa): Promise<OverlapConfig | null> {
  const r = await rest<Array<{ frozen_scope?: unknown; overlap_hold_max_hours?: unknown }>>(
    s, `/rest/v1/dev_autopilot_config?id=eq.1&select=frozen_scope,overlap_hold_max_hours&limit=1`,
  );
  if (!r.ok || !r.data || !r.data[0]) return null;
  const row = r.data[0];
  const frozen = Array.isArray(row.frozen_scope) ? row.frozen_scope.filter((g): g is string => typeof g === 'string') : [];
  const hours = Number(row.overlap_hold_max_hours);
  return { frozen_scope: frozen, overlap_hold_max_hours: Number.isFinite(hours) && hours > 0 ? hours : OVERLAP_HOLD_MAX_HOURS_DEFAULT };
}

export type GuardVerdict =
  | { ok: true; blocks: OverlapBlock[]; frozen: string[] }
  | { ok: false; error: string };

/** The check itself: open PRs sharing `files` (except `ownPr`), and the frozen files among them. */
export async function guardFiles(
  repo: string,
  files: string[],
  opts: { ownPr?: number | null; frozenScope?: string[]; gh?: OverlapGithub } = {},
): Promise<GuardVerdict> {
  const snap = await loadOpenPrFiles(repo, opts.gh);
  if (!snap.ok) return { ok: false, error: snap.error };
  return { ok: true, blocks: findOverlaps(files, snap.prs, opts.ownPr), frozen: frozenHits(files, opts.frozenScope || []) };
}

/**
 * Move `from` → held_overlap (conditional on the row still being in `from`),
 * record why, emit `dev_autopilot.execution.held_overlap`. Returns whether the
 * row moved.
 */
export async function holdExecution(
  s: OverlapSupa,
  exec: { id: string; finding_id?: string; pr_url?: string | null; pr_number?: number | null; metadata?: Record<string, unknown> | null },
  from: 'cooling' | 'ci',
  blocks: OverlapBlock[],
  frozen: string[],
  extraMeta: Record<string, unknown> = {},
): Promise<boolean> {
  const now = new Date().toISOString();
  const hold: OverlapHoldRecord = { from, held_at: now, checked_at: now, blocking_prs: blocks, frozen_files: frozen };
  const r = await rest<unknown[]>(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}&status=eq.${from}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: HELD_OVERLAP, updated_at: now, metadata: { ...(exec.metadata || {}), ...extraMeta, overlap_hold: hold } }),
  });
  const moved = r.ok && Array.isArray(r.data) && r.data.length > 0;
  if (!moved) return false;
  await emitOasisEvent({
    vtid: OVERLAP_VTID,
    type: 'dev_autopilot.execution.held_overlap',
    source: 'dev-autopilot-overlap',
    status: 'warning',
    message: `Execution ${exec.id.slice(0, 8)} held (${from === 'cooling' ? 'before the claim' : 'before the merge'}): ${describeBlocks(blocks, frozen)}`,
    payload: { execution_id: exec.id, finding_id: exec.finding_id, pr_url: exec.pr_url ?? null, from, blocking_prs: blocks.map((b) => b.pr), blocks, frozen_files: frozen },
  });
  return true;
}

/** Plan files for an execution (the plan version it was approved on). Empty = unknown (open-ended plan). */
export async function loadPlanFiles(s: OverlapSupa, findingId: string, planVersion: number | null | undefined): Promise<string[] | null> {
  const versionClause = planVersion ? `&version=eq.${planVersion}` : '&order=version.desc';
  const r = await rest<Array<{ files_referenced?: unknown }>>(
    s, `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${findingId}${versionClause}&select=files_referenced&limit=1`,
  );
  if (!r.ok) return null;
  const files = r.data && r.data[0] && Array.isArray(r.data[0].files_referenced) ? r.data[0].files_referenced : [];
  return files.filter((f): f is string => typeof f === 'string' && f.includes('/'));
}
