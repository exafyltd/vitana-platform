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
import type { LaneFileChange, LaneFileWriter, LedgerWriter, UpdateBranchFn } from './act';
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

function setKey(fm: string, key: string, value: string | null): string {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (value === null) return re.test(fm) ? fm.replace(new RegExp(`^${key}:.*(?:\\r?\\n|$)`, 'm'), '') : fm;
  if (re.test(fm)) return fm.replace(re, `${key}: ${value}`);
  return `${fm}\n${key}: ${value}`;
}

function fmKey(fm: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim();
}

const mapActor = (a: string) => (LANE_ACTORS.includes(a) ? a : 'kiro');

/**
 * VTID-05414: true when `text` already has everything `change` would set — the
 * front-matter keys (`state`, mapped `next_actor`, `seat`, `claimed_by` on
 * `release_claim`) and, as the newest log entry's body, `change.log`. Never
 * compares `updated:` or the log heading timestamp. Pure; runs before
 * `applyLaneChange`.
 */
export function laneChangeIsNoop(text: string, change: LaneFileChange): boolean {
  const m = FM_RE.exec(text);
  if (!m) return false;
  const fm = m[1].replace(/\r/g, '');
  if (change.state !== undefined && change.state !== (fmKey(fm, 'state') ?? '')) return false;
  if (change.next_actor && mapActor(change.next_actor) !== fmKey(fm, 'next_actor')) return false;
  if (change.seat !== undefined && change.seat !== fmKey(fm, 'seat')) return false;
  if (change.release_claim && fmKey(fm, 'claimed_by') !== undefined) return false;
  const rest = text.slice(m[0].length).replace(/\r/g, '');
  const at = rest.lastIndexOf('\n### ');
  if (at < 0) return false;
  const entry = rest.slice(at + 1);
  const nl = entry.indexOf('\n');
  const body = nl < 0 ? '' : entry.slice(nl + 1);
  return body.trim() === change.log.trim();
}

/** Apply a PM lane change to a lane file's text (pure). */
export function applyLaneChange(text: string, change: LaneFileChange, nowIso: string): string {
  const m = FM_RE.exec(text);
  if (!m) throw new Error(`lane file ${change.slug}/${change.lane} has no front matter`);
  let fm = m[1].replace(/\r/g, '');
  // VTID-05414: never introduce seat == reviewer_seat (queue.mjs validateLane rejects it). A
  // lane that already has it still takes other PM writes.
  const reviewerSeat = fmKey(fm, 'reviewer_seat');
  if (change.seat !== undefined && change.seat !== fmKey(fm, 'seat') && reviewerSeat && change.seat === reviewerSeat) {
    throw new Error('invalid lane change: seat equals reviewer_seat');
  }
  const oldState = /^state:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? '';
  if (change.state !== undefined && change.state !== oldState) {
    fm = setKey(fm, 'state', change.state);
    if (change.state === 'parked') fm = setKey(fm, 'parked_from', oldState || 'ready');
  }
  // A lane's next_actor is claude|kiro|owner (queue.mjs validateLane); a seat
  // (e.g. the exceptions seat) is a Kiro actor — the seat itself goes in `seat`.
  if (change.next_actor) fm = setKey(fm, 'next_actor', mapActor(change.next_actor));
  if (change.seat !== undefined) fm = setKey(fm, 'seat', change.seat);
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

  async write(change: LaneFileChange): Promise<'written' | 'noop'> {
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
    // VTID-05414: read the bookkeeping branch when it exists (else main) and decide the
    // no-op before any ref, commit or PR is created.
    const branch = `pm-agent/${change.slug}`;
    const exists = (await this.client.refSha(repo, branch)) != null;
    const ref = exists ? branch : 'main';
    const cur = await this.client.file(repo, path, ref);
    if (!cur) throw new Error(`${path} not on ${ref}`);
    if (laneChangeIsNoop(cur.text, change)) return 'noop';
    const next = applyLaneChange(cur.text, change, this.nowIso());
    if (!exists) await this.ensureBookkeepingBranch(repo, change.slug);
    await this.client.put(repo, path, branch, next, cur.sha, commitMessage(`pm: ${change.slug}/${change.lane} ${change.state ?? 'update'}`, `${change.slug}/_plan`));
    await this.ensureBookkeepingPull(repo, change.slug, branch);
    return 'written';
  }

  /** W2 for a non-lane file (e.g. `docs/validation/<plan VTID>/timings.json`). */
  async writeFile(repo: string, slug: string, path: string, text: string, subject: string): Promise<void> {
    const branch = await this.ensureBookkeepingBranch(repo, slug);
    const cur = await this.client.file(repo, path, branch);
    await this.client.put(repo, path, branch, text, cur?.sha ?? null, commitMessage(subject, `${slug}/_plan`));
    await this.ensureBookkeepingPull(repo, slug, branch);
  }

  private async ensureBookkeepingBranch(repo: string, slug: string): Promise<string> {
    const branch = `pm-agent/${slug}`;
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
