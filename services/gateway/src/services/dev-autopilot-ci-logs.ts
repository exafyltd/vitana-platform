/**
 * VTID-04005: GitHub Actions job-log evidence for Dev Autopilot CI failures.
 *
 * Until now the CI watcher handed the self-healing triage agent only the
 * NAMES of the failing checks (VTID-04003) — never a line of what actually
 * failed. Triage then "diagnosed" from the name alone and the child retry
 * re-ran the identical prompt (docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md
 * §2.3). This module turns a failing check-run into a bounded excerpt of its
 * real Actions log so the failure reason carries evidence.
 *
 * Shape: pure text-selection helpers (unit-tested) + one network function
 * that is best-effort by construction — a log fetch that fails, times out or
 * returns nothing degrades to "no excerpt", never to a thrown error on the
 * watcher's hot path.
 *
 * GitHub wiring: a check-run created by Actions carries `details_url` of the
 * form https://github.com/<owner>/<repo>/actions/runs/<run_id>/job/<job_id>.
 * `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` answers 302 to a
 * short-lived download URL; Node's fetch follows it and returns the plain
 * text log.
 */

const LOG_PREFIX = '[dev-autopilot-ci-logs]';
const GITHUB_API_BASE = 'https://api.github.com';

/** Per-job excerpt budget (chars). Three jobs × 3 KB stays inside the
 *  metadata jsonb comfortably and inside the triage prompt budget. */
export const CI_LOG_EXCERPT_MAX_CHARS = 3000;
export const CI_LOG_MAX_JOBS = 3;
const FETCH_TIMEOUT_MS = 8000;

export interface CiLogExcerpt {
  check_name: string;
  job_id: number;
  /** Bounded selection of the most diagnostic lines, oldest first. */
  excerpt: string;
  /** True when the fetch/parsing failed and `excerpt` explains why. */
  unavailable?: boolean;
}

/** Extract the Actions job id from a check-run `details_url`/`html_url`. */
export function parseActionsJobId(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(url);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

const NOISE_LINE = /^\s*$|^##\[(group|endgroup)\]|^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/;
const SIGNAL_LINE = /(error|fail|✕|✖|×|exit code|Exit code|expected|received|Cannot find|TS\d{4}|assert|Timeout|timed out|##\[error\])/i;

/** Strip the `2026-09-17T17:49:46.1234567Z ` timestamp prefix Actions adds. */
function stripTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

/**
 * Select the most diagnostic part of a raw Actions job log.
 *
 * Strategy: prefer the window around the FIRST signal line (the root cause
 * usually precedes a cascade of follow-on failures), then append the tail
 * (where jest/tsc print their summaries), de-duplicated, until the budget is
 * spent. A log with no signal lines yields its tail. Always ≤ maxChars.
 */
export function extractLogExcerpt(rawLog: string, maxChars: number = CI_LOG_EXCERPT_MAX_CHARS): string {
  if (!rawLog) return '';
  const lines = rawLog
    .split(/\r?\n/)
    .map(stripTimestamp)
    .filter((l) => !NOISE_LINE.test(l));
  if (lines.length === 0) return '';

  const firstSignal = lines.findIndex((l) => SIGNAL_LINE.test(l));
  const picked: string[] = [];
  const seen = new Set<number>();
  const take = (i: number) => {
    if (i < 0 || i >= lines.length || seen.has(i)) return;
    seen.add(i);
    picked.push(lines[i]);
  };

  if (firstSignal >= 0) {
    for (let i = Math.max(0, firstSignal - 3); i < Math.min(lines.length, firstSignal + 25); i++) take(i);
  }
  // Tail — summaries live here.
  const tailStart = Math.max(0, lines.length - 40);
  const tailIdx: number[] = [];
  for (let i = tailStart; i < lines.length; i++) if (!seen.has(i)) tailIdx.push(i);
  if (firstSignal >= 0 && tailIdx.length > 0 && tailIdx[0] > firstSignal + 25) picked.push('…');
  for (const i of tailIdx) take(i);

  let out = picked.join('\n');
  if (out.length > maxChars) {
    // Keep the head (root cause) and the very end (summary) of what we picked.
    const headBudget = Math.floor(maxChars * 0.6);
    const tailBudget = maxChars - headBudget - 5;
    out = `${out.slice(0, headBudget)}\n…\n${out.slice(out.length - tailBudget)}`;
  }
  return out;
}

/**
 * Render excerpts into the single string that travels on the failure reason
 * (bridgeFailure → triage → child execution prompt). Bounded.
 *
 * @param excerpts     The log excerpts to render.
 * @param maxChars     Budget for the entire rendered string.
 * @param totalFailing When provided and greater than excerpts.length, appends
 *                     a line indicating how many failing checks were not fetched.
 */
export function renderCiEvidence(
  excerpts: CiLogExcerpt[],
  maxChars: number = 2 * CI_LOG_EXCERPT_MAX_CHARS,
  totalFailing?: number,
): string {
  if (!excerpts || excerpts.length === 0) return '';
  const parts = excerpts.map((e) =>
    `--- ${e.check_name} (job ${e.job_id})${e.unavailable ? ' [log unavailable]' : ''} ---\n${e.excerpt}`,
  );
  let joined = parts.join('\n');

  // Append notice about unfetched failing checks if applicable
  if (typeof totalFailing === 'number' && totalFailing > excerpts.length) {
    const unfetchedCount = totalFailing - excerpts.length;
    joined += `\n…and ${unfetchedCount} more failing check(s) not fetched (cap CI_LOG_MAX_JOBS=${CI_LOG_MAX_JOBS})`;
  }

  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…[truncated]` : joined;
}

interface CheckRunLike {
  id?: number;
  name: string;
  conclusion?: string | null;
  status?: string;
  details_url?: string | null;
  html_url?: string | null;
}

async function githubGet<T>(path: string, token: string, accept = 'application/vnd.github+json'): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
    if (accept === 'application/vnd.github+json') return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch bounded log excerpts for the failing check-runs on a commit.
 * Best-effort: never throws; returns [] when the token is missing.
 *
 * @param failedNames  names of failing checks (from analyzeCiStatus) — only
 *                     these are fetched, at most CI_LOG_MAX_JOBS of them.
 */
export async function collectCiFailureEvidence(input: {
  owner: string;
  repo: string;
  headSha: string;
  failedNames: string[];
  token?: string;
  /** Test seam. */
  fetchCheckRuns?: (owner: string, repo: string, sha: string) => Promise<CheckRunLike[]>;
  fetchJobLog?: (owner: string, repo: string, jobId: number) => Promise<string>;
}): Promise<CiLogExcerpt[]> {
  const token = input.token ?? process.env.GITHUB_SAFE_MERGE_TOKEN;
  if (!token || input.failedNames.length === 0) return [];
  const wanted = new Set(input.failedNames);
  const out: CiLogExcerpt[] = [];
  try {
    const fetchCheckRuns = input.fetchCheckRuns
      ?? (async (o: string, r: string, sha: string) =>
        (await githubGet<{ check_runs: CheckRunLike[] }>(`/repos/${o}/${r}/commits/${sha}/check-runs?per_page=100`, token)).check_runs);
    const fetchJobLog = input.fetchJobLog
      ?? ((o: string, r: string, jobId: number) => githubGet<string>(`/repos/${o}/${r}/actions/jobs/${jobId}/logs`, token, 'text/plain'));

    const runs = await fetchCheckRuns(input.owner, input.repo, input.headSha);
    const failing = runs.filter((cr) => wanted.has(cr.name) && cr.conclusion && cr.conclusion !== 'success' && cr.conclusion !== 'neutral' && cr.conclusion !== 'skipped');
    for (const cr of failing.slice(0, CI_LOG_MAX_JOBS)) {
      const jobId = parseActionsJobId(cr.details_url) ?? parseActionsJobId(cr.html_url);
      if (!jobId) {
        out.push({ check_name: cr.name, job_id: 0, excerpt: 'no Actions job id on this check-run (external status?)', unavailable: true });
        continue;
      }
      try {
        const raw = await fetchJobLog(input.owner, input.repo, jobId);
        const excerpt = extractLogExcerpt(raw);
        out.push({ check_name: cr.name, job_id: jobId, excerpt: excerpt || '(empty log)' });
      } catch (err) {
        out.push({ check_name: cr.name, job_id: jobId, excerpt: `log fetch failed: ${err instanceof Error ? err.message : String(err)}`, unavailable: true });
      }
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} check-run listing failed for ${input.headSha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}