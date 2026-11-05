/**
 * VTID-05274 — the PM's writes (plan kiro-autonomy-fallback §4.5, §5 C4/C6).
 *
 * All PM commits carry `Collab-Session: pm-agent` and may change only the lane
 * keys `state`, `parked_from`, `next_actor`, `seat`, `claimed_by`, `updated`
 * plus one appended log entry (the scope-check `pm-agent` exemption):
 *   - W1 (`target: 'pr_branch'`): on the lane PR branch before merge
 *     (`in-review → verified`), trailer `Collab-Lane: <slug>/<lane>`;
 *   - W2 (default): on the bookkeeping branch `pm-agent/<slug>` with one PR
 *     `VTID-<plan VTID> (<slug>/_plan): PM bookkeeping`, trailer
 *     `Collab-Lane: <slug>/_plan` (done, reassign, park, claim cleared).
 * The PM merges W2 on green through safe-merge (decide `merge_bookkeeping`).
 *
 * Also: `githubUpdateBranch` (`PUT /pulls/{n}/update-branch`, expected head) and
 * `SupabaseLedgerWriter` (status in_progress + spec_status approved on the VTID
 * row, only from allocated|scheduled — the same row write the governed
 * `PATCH /api/v1/oasis/tasks/:id` performs, done in-process).
 *
 * No deploy, no workflow run, no VTID allocation is reachable from here.
 */
import type { LaneFileChange, LaneFileWriter, LedgerWriter, UpdateBranchFn, WriteOutcome } from './act';
import { PM_SESSION } from './types';
import { prNumberFromUrl } from './act';
import { gh, supaRest } from './github-rest';

const PLATFORM = 'exafyltd/vitana-platform';
const LANE_ACTORS = ['claude', 'kiro', 'owner'];
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** ISO minute, the lane-log timestamp style (`2026-10-20T20:00Z`). */
function isoMinute(iso: string): string {
  return iso.slice(0, 16) + 'Z';
}

function getKey(fm: string, key: string): string {
  return new RegExp(`^${key}:[ \t]*(.*)$`, 'm').exec(fm)?.[1]?.trim() ?? '';
}

/**
 * VTID-05387 (operating-workflow/pm-noop, sparring R1-F3): lane keys the PM never
 * changes. Lane scope (scripts/collab/queue.mjs PERM rule) refuses a change of any
 * of them on a `pm-agent` commit, so such a write would keep its PR red forever.
 */
export const PERMISSION_KEYS = ['executor', 'seat', 'reviewer_seat', 'paths'] as const;

/** The body of the newest `### …` log entry (heading excluded), trimmed. */
function newestLogBody(text: string): string | null {
  const at = text.lastIndexOf('\n### ');
  if (at < 0) return null;
  const nl = text.indexOf('\n', at + 1);
  return nl < 0 ? '' : text.slice(nl + 1).trim();
}

/**
 * VTID-05387: true when applying `change` would change nothing but `updated:` and
 * the heading time — every key it sets already has that value (`next_actor` after
 * the LANE_ACTORS mapping, `claimed_by` empty on `release_claim`) and the newest
 * log entry already carries the same `change.log` text.
 */
export function laneChangeIsNoop(text: string, change: LaneFileChange): boolean {
  const m = FM_RE.exec(text);
  if (!m) return false;
  const fm = m[1].replace(/\r/g, '');
  if (change.state !== undefined && change.state !== getKey(fm, 'state')) return false;
  if (change.next_actor) {
    const mapped = LANE_ACTORS.includes(change.next_actor) ? change.next_actor : 'kiro';
    if (mapped !== getKey(fm, 'next_actor')) return false;
  }
  if (change.seat !== undefined && change.seat !== getKey(fm, 'seat')) return false;
  if (change.release_claim && !['', 'null', '~'].includes(getKey(fm, 'claimed_by'))) return false;
  return newestLogBody(text) === change.log.trim();
}

function setKey(fm: string, key: string, value: string | null): string {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (value === null) return re.test(fm) ? fm.replace(new RegExp(`^${key}:.*(?:\\r?\\n|$)`, 'm'), '') : fm;
  if (re.test(fm)) return fm.replace(re, `${key}: ${value}`);
  return `${fm}\n${key}: ${value}`;
}

/** Apply a PM lane change to a lane file's text (pure). */
export function applyLaneChange(text: string, change: LaneFileChange, nowIso: string): string {
  const m = FM_RE.exec(text);
  if (!m) throw new Error(`lane file ${change.slug}/${change.lane} has no front matter`);
  let fm = m[1].replace(/\r/g, '');
  const oldState = /^state:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? '';
  if (change.state !== undefined && change.state !== oldState) {
    fm = setKey(fm, 'state', change.state);
    if (change.state === 'parked') fm = setKey(fm, 'parked_from', oldState || 'ready');
  }
  // A lane's next_actor is claude|kiro|owner (queue.mjs validateLane); a seat
  // (e.g. the exceptions seat) is a Kiro actor — the seat itself goes in `seat`.
  if (change.next_actor) fm = setKey(fm, 'next_actor', LANE_ACTORS.includes(change.next_actor) ? change.next_actor : 'kiro');
  if (change.seat !== undefined && change.seat !== getKey(fm, 'seat')) {
    throw new Error(
      `invalid lane change ${change.slug}/${change.lane}: permission key seat (${getKey(fm, 'seat') || 'unset'} → ${change.seat}); ` +
        'Lane scope refuses a pm-agent change of executor, seat, reviewer_seat or paths (scripts/collab/queue.mjs PERM rule)',
    );
  }
  if (change.release_claim) fm = setKey(fm, 'claimed_by', null);
  fm = setKey(fm, 'updated', isoMinute(nowIso));
  const rest = text.slice(m[0].length);
  const transition = change.state !== undefined && change.state !== oldState ? `${oldState} → ${change.state}` : 'update';
  const body = rest.endsWith('\n') ? rest : `${rest}\n`;
  return `---\n${fm}\n---${body}### ${isoMinute(nowIso)} · ${PM_SESSION} · ${transition}\n${change.log}\n`;
}

/** The GitHub calls the writer needs (fake in tests). */
export interface GithubWriteClient {
  file(repo: string, path: string, ref: string): Promise<{ text: string; sha: string } | null>;
  put(repo: string, path: string, branch: string, text: string, sha: string | null, message: string): Promise<void>;
  pullHead(repo: string, n: number): Promise<{ ref: string; sha: string }>;
  refSha(repo: string, branch: string): Promise<string | null>;
  createRef(repo: string, branch: string, sha: string): Promise<void>;
  findOpenPull(repo: string, headBranch: string): Promise<string | null>;
  createPull(repo: string, head: string, base: string, title: string, body: string): Promise<string>;
}

const laneFilePath = (slug: string, lane: string) => `.kiro/specs/${slug}/lanes/${lane}.md`;
const bookkeepingBranch = (slug: string) => `pm-agent/${slug}`;

function commitMessage(subject: string, laneKey: string): string {
  return `${subject}\n\nCollab-Session: ${PM_SESSION}\nCollab-Lane: ${laneKey}`;
}

export class GithubRepoFileWriter implements LaneFileWriter {
  constructor(
    private readonly client: GithubWriteClient,
    private readonly opts: { now?: () => number } = {},
  ) {}

  private nowIso(): string {
    return new Date((this.opts.now ?? Date.now)()).toISOString();
  }

  /**
   * VTID-05387: returns `'noop'` — no commit, no push, no branch or PR created —
   * when the change is already in the file on the branch it would write (the PR
   * head for W1; `pm-agent/<slug>`, or `main` while that branch does not exist, for W2).
   */
  async write(change: LaneFileChange): Promise<WriteOutcome> {
    const repo = change.repo ?? PLATFORM;
    const path = laneFilePath(change.slug, change.lane);
    if (change.target === 'pr_branch') {
      const n = change.pr_url ? prNumberFromUrl(change.pr_url) : null;
      if (n == null) throw new Error('W1 needs the lane PR url');
      const head = await this.client.pullHead(repo, n);
      const cur = await this.client.file(repo, path, head.ref);
      if (!cur) throw new Error(`${path} not on ${head.ref}`);
      if (laneChangeIsNoop(cur.text, change)) return 'noop';
      const next = applyLaneChange(cur.text, change, this.nowIso());
      await this.client.put(repo, path, head.ref, next, cur.sha, commitMessage(`pm: ${change.slug}/${change.lane} ${change.state ?? 'update'}`, `${change.slug}/${change.lane}`));
      return 'written';
    }
    const bookkeeping = bookkeepingBranch(change.slug);
    const readRef = (await this.client.refSha(repo, bookkeeping)) ? bookkeeping : 'main';
    const before = await this.client.file(repo, path, readRef);
    if (!before) throw new Error(`${path} not on ${readRef}`);
    if (laneChangeIsNoop(before.text, change)) return 'noop';
    const branch = await this.ensureBookkeepingBranch(repo, change.slug);
    const cur = readRef === branch ? before : await this.client.file(repo, path, branch);
    if (!cur) throw new Error(`${path} not on ${branch}`);
    const next = applyLaneChange(cur.text, change, this.nowIso());
    await this.client.put(repo, path, branch, next, cur.sha, commitMessage(`pm: ${change.slug}/${change.lane} ${change.state ?? 'update'}`, `${change.slug}/_plan`));
    await this.ensureBookkeepingPull(repo, change.slug, branch);
    return 'written';
  }

  /** W2 for a non-lane file (e.g. `docs/validation/<plan VTID>/timings.json`); `'noop'` when the text is unchanged. */
  async writeFile(repo: string, slug: string, path: string, text: string, subject: string): Promise<WriteOutcome> {
    const bookkeeping = bookkeepingBranch(slug);
    const readRef = (await this.client.refSha(repo, bookkeeping)) ? bookkeeping : 'main';
    const before = await this.client.file(repo, path, readRef);
    if (before && before.text === text) return 'noop';
    const branch = await this.ensureBookkeepingBranch(repo, slug);
    const cur = readRef === branch ? before : await this.client.file(repo, path, branch);
    await this.client.put(repo, path, branch, text, cur?.sha ?? null, commitMessage(subject, `${slug}/_plan`));
    await this.ensureBookkeepingPull(repo, slug, branch);
    return 'written';
  }

  private async ensureBookkeepingBranch(repo: string, slug: string): Promise<string> {
    const branch = bookkeepingBranch(slug);
    if (!(await this.client.refSha(repo, branch))) {
      const main = await this.client.refSha(repo, 'main');
      if (!main) throw new Error('main ref not readable');
      await this.client.createRef(repo, branch, main);
    }
    return branch;
  }

  private async ensureBookkeepingPull(repo: string, slug: string, branch: string): Promise<void> {
    if (await this.client.findOpenPull(repo, branch)) return;
    const handoff = await this.client.file(repo, `.kiro/specs/${slug}/handoff.md`, 'main');
    const vtid = /^vtids:\s*\[\s*(VTID-\d{5})/m.exec(handoff?.text ?? '')?.[1] ?? /^vtid:\s*(VTID-\d{5})/m.exec(handoff?.text ?? '')?.[1];
    if (!vtid) throw new Error(`no plan VTID in .kiro/specs/${slug}/handoff.md`);
    await this.client.createPull(
      repo,
      branch,
      'main',
      `${vtid} (${slug}/_plan): PM bookkeeping`,
      'Project Manager bookkeeping (lane state, timings). Commits by `pm-agent` only; merged by the PM on green (plan kiro-autonomy-fallback §4.5).',
    );
  }
}

const enc = encodeURIComponent;

/** Production `GithubWriteClient` on the GitHub REST API. */
export class GithubRestWriteClient implements GithubWriteClient {
  async file(repo: string, path: string, ref: string): Promise<{ text: string; sha: string } | null> {
    const r = await gh<{ content?: string; sha: string; encoding?: string }>(repo, `contents/${path.split('/').map(enc).join('/')}?ref=${enc(ref)}`);
    if (!r.data || typeof r.data.content !== 'string') return null;
    return { text: Buffer.from(r.data.content, 'base64').toString('utf8'), sha: r.data.sha };
  }
  async put(repo: string, path: string, branch: string, text: string, sha: string | null, message: string): Promise<void> {
    await gh(repo, `contents/${path.split('/').map(enc).join('/')}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) }),
    });
  }
  async pullHead(repo: string, n: number): Promise<{ ref: string; sha: string }> {
    const r = await gh<{ head: { ref: string; sha: string } }>(repo, `pulls/${n}`);
    if (!r.data) throw new Error(`PR ${repo}#${n} not found`);
    return { ref: r.data.head.ref, sha: r.data.head.sha };
  }
  async refSha(repo: string, branch: string): Promise<string | null> {
    const r = await gh<{ object?: { sha: string } }>(repo, `git/ref/heads/${branch.split('/').map(enc).join('/')}`);
    return r.data?.object?.sha ?? null;
  }
  async createRef(repo: string, branch: string, sha: string): Promise<void> {
    await gh(repo, 'git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
  }
  async findOpenPull(repo: string, headBranch: string): Promise<string | null> {
    const owner = repo.split('/')[0];
    const r = await gh<Array<{ html_url: string }>>(repo, `pulls?state=open&head=${enc(`${owner}:${headBranch}`)}`);
    return r.data?.[0]?.html_url ?? null;
  }
  async createPull(repo: string, head: string, base: string, title: string, body: string): Promise<string> {
    const r = await gh<{ html_url: string }>(repo, 'pulls', { method: 'POST', body: JSON.stringify({ head, base, title, body }) });
    return r.data?.html_url ?? '';
  }
}

/** Production `UpdateBranchFn`: `PUT /repos/{r}/pulls/{n}/update-branch` with `expected_head_sha`. */
export const githubUpdateBranch: UpdateBranchFn = async (repo, prNumber, expectedHeadSha) => {
  try {
    const r = await gh(repo, `pulls/${prNumber}/update-branch`, { method: 'PUT', body: JSON.stringify({ expected_head_sha: expectedHeadSha }) });
    return { ok: r.status === 202 || r.status === 200, status: r.status };
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    return { ok: false, status, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
};

/** Production `LedgerWriter` (service role; only moves a row out of allocated|scheduled). */
export class SupabaseLedgerWriter implements LedgerWriter {
  async patch(vtid: string, set: { status: 'in_progress'; spec_status: 'approved' }): Promise<{ ok: boolean; detail?: string }> {
    if (!/^VTID-\d{5}$/.test(vtid)) return { ok: false, detail: 'bad vtid' };
    try {
      const rows = await supaRest<unknown[]>(`/rest/v1/vtid_ledger?vtid=eq.${enc(vtid)}&status=in.(allocated,scheduled)`, {
        method: 'PATCH',
        body: JSON.stringify({ status: set.status, spec_status: set.spec_status, updated_at: new Date().toISOString() }),
      });
      return { ok: true, detail: rows.length ? undefined : 'no row in allocated|scheduled' };
    } catch (e) {
      return { ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
  }
}
