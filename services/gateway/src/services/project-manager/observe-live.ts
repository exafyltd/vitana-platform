/**
 * VTID-05274 — the live OBSERVE step (plan kiro-autonomy-fallback §3, §4.1,
 * §4.7, §5 C6). Read-only by contract: GitHub REST reads and Supabase REST
 * reads; it never writes.
 *
 * Per tick it reads, for each repo:
 *   - the spec tree on `main` (`.kiro/specs/<slug>/handoff.md`, `lanes/*.md`;
 *     blobs cached by sha) — specs whose handoff is `done` are skipped;
 *   - the open PRs once; a lane PR is matched by branch `kiro|claude/<slug>/<lane>`
 *     (or the lane's `branch:` / `pr:`); for an active lane: mergeable, files,
 *     commits (§4.1 trailers), checks on the head, `behind_by` vs main, the lane
 *     file at the PR head (review entries), `review_only_since`;
 *   - claim refs `collab-claim/<slug>/<lane>` and the driver heartbeat ref
 *     `collab-driver/<slug>` (committer dates);
 *   - `plan(` PRs (spec files, head trailer, handoff + plan.md + sparring state
 *     at the head) and the PM's bookkeeping PRs `pm-agent/<slug>`;
 *   - the Claude inputs: repo variable CLAUDE_AVAILABLE (env CLAUDE_AVAILABLE when
 *     the variable is unreadable, unset or unparseable — VTID-05281), the
 *     oldest open `next_actor: claude` item and the newest `session_…` commit;
 *   - from Supabase: STAGING-VERIFY passes, Gate 2 records (pm_digests),
 *     ledger status, the sparring session of a plan PR.
 * Every source fails open: one PR that fails to load becomes `pr: null` (no
 * merge), never a thrown tick.
 */
import { canonicalPlanHash } from '../plan-sparring/canonical-hash';
import { GithubHttpError, gh, ghPages, supaRest } from './github-rest';
import type { PmObserver } from './observe';
import type {
  AreaSeatRotation,
  CheckRun,
  CheckConclusion,
  ExecutingLogEntry,
  LaneState,
  ObservedBookkeepingPr,
  ObservedClaude,
  ObservedLane,
  ObservedPlanPr,
  ObservedPlanSparring,
  ObservedPr,
  ObservedState,
  PmMode,
  ReviewEntry,
  ReviewVerdict,
} from './types';

export interface GhPull {
  number: number;
  html_url: string;
  title: string;
  head_ref: string;
  head_sha: string;
  created_at: string;
}
export interface GhCommit {
  sha: string;
  message: string;
  /** Committer date, ISO. */
  date: string;
}

/** The GitHub reads the observer needs (fake in tests). */
export interface GithubReader {
  tree(repo: string, ref: string): Promise<Array<{ path: string; sha: string }>>;
  blob(repo: string, sha: string): Promise<string>;
  file(repo: string, path: string, ref: string): Promise<string | null>;
  openPulls(repo: string): Promise<GhPull[]>;
  pullMergeable(repo: string, n: number): Promise<boolean | null>;
  pullFiles(repo: string, n: number): Promise<string[]>;
  /** Oldest first. */
  pullCommits(repo: string, n: number): Promise<GhCommit[]>;
  commitFiles(repo: string, sha: string): Promise<string[]>;
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
  behindBy(repo: string, base: string, head: string): Promise<number>;
  /**
   * A repository Actions variable. Resolves the value when read; `null` only when
   * the reader can prove "unset"; throws when it cannot be read (the REST reader:
   * a 404 — unset or no access, indistinguishable — or a 200 without a string value).
   */
  variable(repo: string, name: string): Promise<string | null>;
  /** Committer date of a branch tip (`refs/heads/<ref>`); null when the ref does not exist. */
  refDate(repo: string, ref: string): Promise<string | null>;
  commitsSince(repo: string, ref: string, sinceIso: string): Promise<GhCommit[]>;
}

/** The Supabase reads the observer needs (fake in tests). */
export interface PmDataReader {
  /** vtid → earliest staging.verify.passed time for that VTID. */
  verifyPassed(vtids: string[]): Promise<Record<string, string>>;
  /** VTIDs a Gate 2 message was already posted for (pm_digests gate2_batch). */
  gate2SentVtids(): Promise<Set<string>>;
  ledgerStatus(vtids: string[]): Promise<Record<string, string>>;
  sparringSession(id: string): Promise<ObservedPlanSparring | null>;
}

export interface GithubObserverDeps {
  gh: GithubReader;
  data: PmDataReader;
  repos?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (msg: string) => void;
}

const PLATFORM = 'exafyltd/vitana-platform';
const DEFAULT_REPOS = [PLATFORM, 'exafyltd/vitana-v1'];
const LANE_STATES: LaneState[] = ['ready', 'executing', 'in-review', 'verified', 'done', 'parked'];
const ACTIVE: LaneState[] = ['executing', 'in-review', 'verified'];

// ── Parsing (pure) ───────────────────────────────────────────────────────

/** Minimal YAML front matter, same rules as scripts/collab/queue.mjs parseFrontMatter. */
export function parseFrontMatter(text: string): Record<string, string | string[]> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  const clean = (s: string) => {
    const t = String(s).trim();
    return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
  };
  for (const raw of m[1].split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      (out[listKey] as string[]).push(clean(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const v = kv[2].replace(/\s+#.*$/, '').trim();
    if (v === '') {
      listKey = kv[1];
      out[listKey] = [];
      continue;
    }
    listKey = null;
    if (/^\[.*\]$/.test(v)) out[kv[1]] = v.slice(1, -1).split(',').map(clean).filter(Boolean);
    else out[kv[1]] = clean(v);
  }
  return out;
}

const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(',') : v ?? '');
const list = (v: string | string[] | undefined): string[] => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]);

/** Git trailers of a commit message (last paragraph `Key: value` lines). */
export function parseTrailers(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  const paras = String(message || '').trimEnd().split(/\r?\n\s*\r?\n/);
  const last = paras[paras.length - 1] ?? '';
  for (const line of last.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export interface LaneLogEntry {
  at: string;
  session: string;
  desc: string;
  body: string[];
}
export interface ParsedLaneLog {
  entries: LaneLogEntry[];
  reviews: Array<{ at: string; session: string; verdict: string; head: string | null; reviewer: string | null }>;
  decisions: string[];
}

/** Split a lane file's `## Log` entries (`### <ts> · <session> · <desc>`), review entries and "Decisions taken". */
export function parseLaneLog(text: string): ParsedLaneLog {
  const entries: LaneLogEntry[] = [];
  let cur: LaneLogEntry | null = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    // `·` is the collaboration.md separator; ` - ` is accepted too (entries written by scripts).
    const h = /^###\s+(\S+)\s+(?:·|-)\s+(\S+)\s+(?:·|-)\s*(.*)$/.exec(line);
    if (h) {
      cur = { at: h[1], session: h[2], desc: h[3].trim(), body: [] };
      entries.push(cur);
      continue;
    }
    if (/^##\s/.test(line)) {
      cur = null;
      continue;
    }
    if (cur) cur.body.push(line);
  }
  const reviews: ParsedLaneLog['reviews'] = [];
  const decisions: string[] = [];
  for (const e of entries) {
    const field = (k: string) => {
      const l = e.body.find((b) => new RegExp(`^\\s*${k}:\\s*`).test(b));
      return l ? l.replace(new RegExp(`^\\s*${k}:\\s*`), '').trim() : null;
    };
    const verdict = field('review');
    if (/^review\b/.test(e.desc) || verdict) {
      if (verdict) reviews.push({ at: e.at, session: e.session, verdict, head: field('head'), reviewer: field('reviewer') });
    }
    for (const b of e.body) {
      const d = /^\s*Decisions taken:\s*(.+)$/.exec(b);
      if (d) decisions.push(...d[1].split(';').map((s) => s.trim()).filter(Boolean));
    }
  }
  return { entries, reviews, decisions };
}

/** Lane-log timestamp (`2026-10-20T19:20Z`) → ISO. */
function isoOf(ts: string): string {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? ts : new Date(n).toISOString();
}

const isReviewOnly = (t: Record<string, string>, laneKey: string): boolean =>
  t['Collab-Review'] === laneKey || (t['Collab-Session'] === 'pm-agent' && t['Collab-Lane'] === laneKey);

/**
 * Heads H after which every commit only touched this lane's file with a review
 * or pm-agent trailer for this lane (plan §4.1 "current head"). Walks from the
 * newest commit backwards; stops at the first commit that is not review-only.
 */
export async function reviewOnlySince(
  r: GithubReader,
  repo: string,
  commits: GhCommit[],
  laneKey: string,
  laneFile: string,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = commits.length - 1; i >= 1; i--) {
    const c = commits[i];
    if (!isReviewOnly(parseTrailers(c.message), laneKey)) break;
    const files = await r.commitFiles(repo, c.sha);
    if (files.length !== 1 || files[0] !== laneFile) break;
    out.push(commits[i - 1].sha);
  }
  return out;
}

/** areas.yaml → one rotation per area (the area's seat). */
export function parseAreas(text: string): AreaSeatRotation[] {
  const out: AreaSeatRotation[] = [];
  let inAreas = false;
  let area: string | null = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^areas:\s*$/.test(line)) {
      inAreas = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inAreas = false;
      continue;
    }
    if (!inAreas) continue;
    const a = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
    if (a) {
      area = a[1];
      continue;
    }
    const s = /^ {4}seat:\s*([a-z]{1,12})\s*$/.exec(line);
    if (s && area) out.push({ area, seats: [s[1]] });
  }
  return out;
}

const deploysFor = (repo: string, paths: string[]): boolean =>
  repo === PLATFORM
    ? paths.some((p) => p.startsWith('services/gateway/'))
    : paths.some((p) => /^(src|public)\//.test(p) || p === 'index.html');

// ── The observer ─────────────────────────────────────────────────────────

interface SpecLane {
  repo: string;
  slug: string;
  lane: string;
  path: string;
  text: string;
  fm: Record<string, string | string[]>;
}

export class GithubObserver implements PmObserver {
  constructor(private readonly deps: GithubObserverDeps) {}

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.warn(`[PM] observe: ${m}`)))(msg);
  }

  async observe(mode: PmMode): Promise<ObservedState> {
    const { gh: r, data } = this.deps;
    const repos = this.deps.repos ?? DEFAULT_REPOS;
    const env = this.deps.env ?? process.env;

    // 1. Specs on main.
    const specLanes: SpecLane[] = [];
    const openClaudeItems: string[] = [];
    for (const repo of repos) {
      let tree: Array<{ path: string; sha: string }> = [];
      try {
        tree = await r.tree(repo, 'main');
      } catch (e) {
        this.log(`${repo} tree: ${String((e as Error)?.message ?? e)}`);
        continue;
      }
      const handoffs = tree.filter((t) => /^\.kiro\/specs\/[^/]+\/handoff\.md$/.test(t.path));
      for (const h of handoffs) {
        const slug = h.path.split('/')[2];
        let hfm: Record<string, string | string[]> | null = null;
        try {
          hfm = parseFrontMatter(await r.blob(repo, h.sha));
        } catch {
          continue;
        }
        if (!hfm || str(hfm.state) === 'done') continue;
        if (str(hfm.next_actor) === 'claude' && hfm.updated) openClaudeItems.push(str(hfm.updated));
        for (const t of tree.filter((x) => x.path.startsWith(`.kiro/specs/${slug}/lanes/`) && x.path.endsWith('.md'))) {
          try {
            const text = await r.blob(repo, t.sha);
            const fm = parseFrontMatter(text);
            if (!fm) continue;
            const lane = t.path.split('/').pop()!.replace(/\.md$/, '');
            specLanes.push({ repo, slug, lane, path: t.path, text, fm });
            if (str(fm.next_actor) === 'claude' && str(fm.state) !== 'done' && fm.updated) openClaudeItems.push(str(fm.updated));
          } catch {
            // one unreadable lane file does not stop the tick
          }
        }
      }
    }

    // 2. Open PRs per repo.
    const pulls = new Map<string, GhPull[]>();
    for (const repo of repos) {
      try {
        pulls.set(repo, await r.openPulls(repo));
      } catch (e) {
        this.log(`${repo} pulls: ${String((e as Error)?.message ?? e)}`);
        pulls.set(repo, []);
      }
    }

    // 3. Supabase reads (fail open).
    const vtids = specLanes.map((l) => str(l.fm.vtid)).filter((v) => /^VTID-\d{5}$/.test(v));
    const verify = await data.verifyPassed(vtids.filter((v) => {
      const l = specLanes.find((x) => str(x.fm.vtid) === v);
      return !!l && deploysFor(l.repo, list(l.fm.paths));
    })).catch((e) => { this.log(`verify: ${String(e?.message ?? e)}`); return {} as Record<string, string>; });
    const sent = await data.gate2SentVtids().catch(() => new Set<string>());
    const building = specLanes.filter((l) => ['executing', 'in-review'].includes(str(l.fm.state))).map((l) => str(l.fm.vtid)).filter(Boolean);
    const ledger = building.length
      ? await data.ledgerStatus(building).catch(() => ({} as Record<string, string>))
      : {};

    // 4. Driver heartbeats per slug.
    const drivers = new Map<string, string | null | undefined>();
    for (const slug of new Set(specLanes.map((l) => l.slug))) {
      try {
        drivers.set(slug, await r.refDate(PLATFORM, `collab-driver/${slug}`));
      } catch {
        drivers.set(slug, undefined); // unknown → today's windows
      }
    }

    const sessionCommits: GhCommit[] = [];
    const nowMs = (this.deps.now ?? Date.now)();

    // 5. Lanes.
    const lanes: ObservedLane[] = [];
    for (const sl of specLanes) {
      const state = str(sl.fm.state) as LaneState;
      if (!LANE_STATES.includes(state)) continue;
      const vtid = /^VTID-\d{5}$/.test(str(sl.fm.vtid)) ? str(sl.fm.vtid) : null;
      const paths = list(sl.fm.paths);
      const log = parseLaneLog(sl.text);
      const hb = drivers.get(sl.slug);
      const alive = hb === undefined ? null : hb != null && nowMs - Date.parse(hb) < 45 * 60 * 1000;
      const laneKey = `${sl.slug}/${sl.lane}`;
      let pr: ObservedPr | null = null;
      let reviews: ReviewEntry[] = log.reviews.map((x) => toReview(x, str(sl.fm.reviewer_seat)));
      let lastActivity: string | null = null;

      const pull = ACTIVE.includes(state) ? findPull(pulls.get(sl.repo) ?? [], sl) : null;
      if (pull) {
        try {
          const [mergeable, files, commits, checks, behind] = await Promise.all([
            r.pullMergeable(sl.repo, pull.number),
            r.pullFiles(sl.repo, pull.number),
            r.pullCommits(sl.repo, pull.number),
            r.checkRuns(sl.repo, pull.head_sha),
            r.behindBy(sl.repo, 'main', pull.head_sha),
          ]);
          sessionCommits.push(...commits);
          const headText = await r.file(sl.repo, sl.path, pull.head_sha);
          const headLog = headText ? parseLaneLog(headText) : log;
          reviews = mergeTrailerReviews(headLog.reviews.map((x) => toReview(x, str(sl.fm.reviewer_seat))), commits, laneKey, str(sl.fm.reviewer_seat));
          const since = await reviewOnlySince(r, sl.repo, commits, laneKey, sl.path);
          pr = {
            url: pull.html_url,
            title: pull.title,
            head_sha: pull.head_sha,
            checks,
            mergeable: mergeable === true,
            merged: false,
            consecutive_ci_failures: checks.some((c) => isFailure(c.conclusion)) ? await this.consecutiveFailures(sl.repo, commits, laneKey) : 0,
            review_only_since: since,
            files,
            behind_by: behind,
          };
          lastActivity = commits.length ? commits[commits.length - 1].date : null;
        } catch (e) {
          this.log(`${sl.repo}#${pull.number}: ${String((e as Error)?.message ?? e)}`);
          pr = null;
        }
      }

      let claimedAt: string | null = null;
      if (['executing', 'in-review', 'verified'].includes(state)) {
        try {
          claimedAt = await r.refDate(sl.repo, `collab-claim/${sl.slug}/${sl.lane}`);
        } catch {
          claimedAt = null;
        }
      }

      const execSessions = new Set<string>();
      const executing: ExecutingLogEntry[] = [];
      for (const e of log.entries) {
        if (/^review\b/.test(e.desc) || e.session === 'pm-agent' || e.session === 'ci-plan-spar') continue;
        if (execSessions.has(e.session)) continue;
        execSessions.add(e.session);
        executing.push({ session_id: e.session, seat: str(sl.fm.seat), at: isoOf(e.at) });
      }

      lanes.push({
        slug: sl.slug,
        lane: sl.lane,
        vtid,
        state,
        seat: str(sl.fm.seat),
        reviewer_seat: str(sl.fm.reviewer_seat),
        area: str(sl.fm.area) || null,
        paths,
        depends_on: list(sl.fm.depends_on),
        pr,
        reviews,
        executing_log: executing,
        state_since: sl.fm.updated ? isoOf(str(sl.fm.updated)) : new Date(nowMs).toISOString(),
        last_branch_activity: lastActivity,
        claimed_at: claimedAt,
        // The plan driver is the automation now (plan §4.7): unknown → assume it ran.
        seat_ran_automation_in_window: alive !== false,
        staging_verified: vtid != null && verify[vtid] != null,
        deploys: deploysFor(sl.repo, paths),
        staging_verified_at: vtid != null ? verify[vtid] ?? null : null,
        gate2_sent: vtid != null && sent.has(vtid),
        repo: sl.repo,
        driver_heartbeat_at: hb,
        ledger_status: vtid != null ? ledger[vtid] ?? null : null,
        decisions_taken: log.decisions,
      });
    }

    // 6. Rotations.
    let rotations: AreaSeatRotation[] = [];
    try {
      rotations = parseAreas((await r.file(PLATFORM, 'docs/programs/areas.yaml', 'main')) ?? '');
    } catch {
      rotations = [];
    }

    // 7. plan( PRs and bookkeeping PRs.
    const plan_prs: ObservedPlanPr[] = [];
    const bookkeeping_prs: ObservedBookkeepingPr[] = [];
    for (const [repo, ps] of pulls) {
      for (const p of ps) {
        const pm = /^plan\(([a-z0-9][a-z0-9-]*)\)/.exec(p.title);
        try {
          if (pm) plan_prs.push(await this.observePlanPr(repo, p, pm[1], sessionCommits));
          else if (p.head_ref.startsWith('pm-agent/')) bookkeeping_prs.push(await this.observeBookkeeping(repo, p));
        } catch (e) {
          this.log(`${repo}#${p.number}: ${String((e as Error)?.message ?? e)}`);
        }
      }
    }

    // 8. Claude inputs (plan §3).
    const claude = await this.observeClaude(repos, openClaudeItems, sessionCommits, env);

    return { mode, lanes, rotations, claude, plan_prs, bookkeeping_prs };
  }

  private async consecutiveFailures(repo: string, commits: GhCommit[], laneKey: string): Promise<number> {
    let n = 0;
    const pushes = commits.filter((c) => !isReviewOnly(parseTrailers(c.message), laneKey)).slice(-3).reverse();
    for (const c of pushes) {
      const checks = await this.deps.gh.checkRuns(repo, c.sha);
      if (checks.some((x) => isFailure(x.conclusion))) n++;
      else break;
    }
    return n;
  }

  private async observePlanPr(repo: string, p: GhPull, slug: string, sessionCommits: GhCommit[]): Promise<ObservedPlanPr> {
    const r = this.deps.gh;
    const [files, commits, checks, mergeable, behind] = await Promise.all([
      r.pullFiles(repo, p.number),
      r.pullCommits(repo, p.number),
      r.checkRuns(repo, p.head_sha),
      r.pullMergeable(repo, p.number),
      r.behindBy(repo, 'main', p.head_sha),
    ]);
    sessionCommits.push(...commits);
    const head = commits[commits.length - 1];
    const handoff = parseFrontMatter((await r.file(repo, `.kiro/specs/${slug}/handoff.md`, p.head_sha)) ?? '');
    const planText = await r.file(repo, `.kiro/specs/${slug}/plan.md`, p.head_sha);
    const hash = planText ? canonicalPlanHash(planText) : null;
    let sparring: ObservedPlanSparring | null = null;
    const stateText = await r.file(repo, `.kiro/specs/${slug}/sparring/state.json`, p.head_sha);
    if (stateText) {
      try {
        const sessions = (JSON.parse(stateText) as { sessions?: Array<{ id?: string }> }).sessions ?? [];
        const id = sessions[sessions.length - 1]?.id;
        if (id) sparring = await this.deps.data.sparringSession(id);
      } catch {
        sparring = null;
      }
    }
    return {
      slug,
      url: p.html_url,
      title: p.title,
      head_sha: p.head_sha,
      head_commit_session: head ? parseTrailers(head.message)['Collab-Session'] ?? null : null,
      files,
      checks,
      mergeable: mergeable === true,
      merged: false,
      behind_by: behind,
      handoff_state: handoff ? str(handoff.state) || null : null,
      vtids: handoff ? list(handoff.vtids).filter((v) => /^VTID-\d{5}$/.test(v)) : [],
      head_plan_hash: hash && hash.ok ? hash.hash : null,
      sparring,
    };
  }

  private async observeBookkeeping(repo: string, p: GhPull): Promise<ObservedBookkeepingPr> {
    const r = this.deps.gh;
    const [files, commits, checks, mergeable, behind] = await Promise.all([
      r.pullFiles(repo, p.number),
      r.pullCommits(repo, p.number),
      r.checkRuns(repo, p.head_sha),
      r.pullMergeable(repo, p.number),
      r.behindBy(repo, 'main', p.head_sha),
    ]);
    return {
      slug: p.head_ref.slice('pm-agent/'.length),
      url: p.html_url,
      title: p.title,
      head_sha: p.head_sha,
      files,
      checks,
      mergeable: mergeable === true,
      merged: false,
      behind_by: behind,
      commit_sessions: commits.map((c) => parseTrailers(c.message)['Collab-Session'] ?? ''),
    };
  }

  private async observeClaude(repos: string[], openItems: string[], prCommits: GhCommit[], env: NodeJS.ProcessEnv): Promise<ObservedClaude> {
    const r = this.deps.gh;
    let flag: boolean | null = null;
    const parseFlag = (v: string | null | undefined) => (v === 'false' ? false : v === 'true' ? true : null);
    const envFlag = () => parseFlag(env.CLAUDE_AVAILABLE?.trim().toLowerCase());
    // Precedence (plan kaf-fallback-env §3): a readable true/false variable wins;
    // a read that threw, or returned null / an unparseable value → the env.
    try {
      flag = parseFlag((await r.variable(PLATFORM, 'CLAUDE_AVAILABLE'))?.trim().toLowerCase()) ?? envFlag();
    } catch {
      flag = envFlag();
    }
    const oldestMs = openItems.map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)[0];
    const oldest = oldestMs != null ? new Date(oldestMs).toISOString() : null;
    let last: number | null = null;
    const consider = (c: GhCommit) => {
      if (!/^session_/.test(parseTrailers(c.message)['Collab-Session'] ?? '')) return;
      const n = Date.parse(c.date);
      if (!Number.isNaN(n) && (last == null || n > last)) last = n;
    };
    prCommits.forEach(consider);
    if (oldest) {
      for (const repo of repos) {
        try {
          (await r.commitsSince(repo, 'main', oldest)).forEach(consider);
        } catch {
          // unreadable → no evidence from this repo
        }
      }
    }
    return { flag, oldest_assigned_at: oldest, last_action_at: last != null ? new Date(last).toISOString() : null };
  }
}

function isFailure(c: CheckConclusion): boolean {
  return c === 'failure' || c === 'timed_out' || c === 'cancelled' || c === 'action_required';
}

function findPull(pulls: GhPull[], sl: SpecLane): GhPull | null {
  const branches = new Set([`kiro/${sl.slug}/${sl.lane}`, `claude/${sl.slug}/${sl.lane}`, str(sl.fm.branch)].filter(Boolean));
  const prRef = str(sl.fm.pr);
  return pulls.find((p) => branches.has(p.head_ref) || (prRef !== '' && (prRef === p.html_url || prRef === String(p.number) || prRef === `#${p.number}`))) ?? null;
}

const VERDICTS: ReviewVerdict[] = ['approve', 'accept', 'changes', 'risk'];

function toReview(x: ParsedLaneLog['reviews'][number], reviewerSeat: string): ReviewEntry {
  const v = x.verdict.toLowerCase().split(/\s/)[0] as ReviewVerdict;
  return {
    session_id: x.session,
    reviewer_seat: reviewerSeat,
    verdict: VERDICTS.includes(v) ? v : 'changes',
    head_sha: x.head ?? '',
    at: isoOf(x.at),
    reviewer: x.reviewer,
  };
}

/** Review commits' §4.1 trailers win over the lane-log body (verdict, reviewer, reviewed head). */
function mergeTrailerReviews(fromLog: ReviewEntry[], commits: GhCommit[], laneKey: string, reviewerSeat: string): ReviewEntry[] {
  const out = [...fromLog];
  for (const c of commits) {
    const t = parseTrailers(c.message);
    if (t['Collab-Review'] !== laneKey) continue;
    const session = t['Collab-Session'] ?? '';
    const verdictRaw = (t['Collab-Verdict'] ?? '').toLowerCase() as ReviewVerdict;
    const idx = out.findIndex((e) => e.session_id === session);
    const merged: ReviewEntry = {
      session_id: session,
      reviewer_seat: idx >= 0 ? out[idx].reviewer_seat : reviewerSeat,
      verdict: VERDICTS.includes(verdictRaw) ? verdictRaw : idx >= 0 ? out[idx].verdict : 'changes',
      head_sha: t['Collab-Reviewed-Head'] ?? (idx >= 0 ? out[idx].head_sha : ''),
      at: idx >= 0 ? out[idx].at : c.date,
      reviewer: t['Collab-Reviewer'] ?? (idx >= 0 ? out[idx].reviewer ?? null : null),
    };
    if (idx >= 0) out[idx] = merged;
    else out.push(merged);
  }
  return out;
}

// ── Production readers ───────────────────────────────────────────────────

const enc = encodeURIComponent;

/** Production `GithubReader` on the GitHub REST API (blob cache by sha). */
export class GithubRestReader implements GithubReader {
  private readonly blobs = new Map<string, string>();

  async tree(repo: string, ref: string): Promise<Array<{ path: string; sha: string }>> {
    const r = await gh<{ tree?: Array<{ path: string; sha: string; type: string }> }>(repo, `git/trees/${enc(ref)}?recursive=1`);
    return (r.data?.tree ?? []).filter((t) => t.type === 'blob' && t.path.startsWith('.kiro/specs/')).map((t) => ({ path: t.path, sha: t.sha }));
  }
  async blob(repo: string, sha: string): Promise<string> {
    const hit = this.blobs.get(sha);
    if (hit !== undefined) return hit;
    const r = await gh<{ content?: string }>(repo, `git/blobs/${enc(sha)}`);
    const text = Buffer.from(r.data?.content ?? '', 'base64').toString('utf8');
    if (this.blobs.size > 4000) this.blobs.clear();
    this.blobs.set(sha, text);
    return text;
  }
  async file(repo: string, path: string, ref: string): Promise<string | null> {
    const r = await gh<{ content?: string }>(repo, `contents/${path.split('/').map(enc).join('/')}?ref=${enc(ref)}`);
    return r.data && typeof r.data.content === 'string' ? Buffer.from(r.data.content, 'base64').toString('utf8') : null;
  }
  async openPulls(repo: string): Promise<GhPull[]> {
    const rows = await ghPages<{ number: number; html_url: string; title: string; created_at: string; head: { ref: string; sha: string } }>(repo, 'pulls?state=open');
    return rows.map((p) => ({ number: p.number, html_url: p.html_url, title: p.title, head_ref: p.head.ref, head_sha: p.head.sha, created_at: p.created_at }));
  }
  async pullMergeable(repo: string, n: number): Promise<boolean | null> {
    const r = await gh<{ mergeable: boolean | null }>(repo, `pulls/${n}`);
    return r.data?.mergeable ?? null;
  }
  async pullFiles(repo: string, n: number): Promise<string[]> {
    return (await ghPages<{ filename: string }>(repo, `pulls/${n}/files`, 10)).map((f) => f.filename);
  }
  async pullCommits(repo: string, n: number): Promise<GhCommit[]> {
    const rows = await ghPages<{ sha: string; commit: { message: string; committer?: { date?: string } } }>(repo, `pulls/${n}/commits`, 3);
    return rows.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.committer?.date ?? '' }));
  }
  async commitFiles(repo: string, sha: string): Promise<string[]> {
    const r = await gh<{ files?: Array<{ filename: string }> }>(repo, `commits/${enc(sha)}`);
    return (r.data?.files ?? []).map((f) => f.filename);
  }
  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const r = await gh<{ check_runs?: Array<{ name: string; status: string; conclusion: string | null; head_sha: string }> }>(repo, `commits/${enc(sha)}/check-runs?per_page=100`);
    return (r.data?.check_runs ?? []).map((c) => ({
      name: c.name,
      conclusion: (c.status !== 'completed' ? 'pending' : c.conclusion ?? 'pending') as CheckConclusion,
      head_sha: c.head_sha,
    }));
  }
  async behindBy(repo: string, base: string, head: string): Promise<number> {
    const r = await gh<{ behind_by?: number }>(repo, `compare/${enc(base)}...${enc(head)}`);
    return r.data?.behind_by ?? 0;
  }
  async variable(repo: string, name: string): Promise<string | null> {
    // VTID-05281: GitHub answers 404 both for "not set" and for "this token has
    // no Variables access", so a 404 (or a 200 without a string value) is
    // unreadable, not unset — throw so observeClaude falls back to the env.
    const r = await gh<{ value?: unknown }>(repo, `actions/variables/${enc(name)}`);
    if (r.status === 200 && typeof r.data?.value === 'string') return r.data.value;
    throw new GithubHttpError(
      r.status,
      r.status === 404 ? 'variable unreadable (404: unset or no access)' : `variable unreadable (${r.status}: no string value)`,
    );
  }
  async refDate(repo: string, ref: string): Promise<string | null> {
    const r = await gh<{ commit?: { committer?: { date?: string } } }>(repo, `commits/${ref.split('/').map(enc).join('/')}`);
    return r.data?.commit?.committer?.date ?? null;
  }
  async commitsSince(repo: string, ref: string, sinceIso: string): Promise<GhCommit[]> {
    const rows = await ghPages<{ sha: string; commit: { message: string; committer?: { date?: string } } }>(repo, `commits?sha=${enc(ref)}&since=${enc(sinceIso)}`, 2);
    return rows.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.committer?.date ?? '' }));
  }
}

/** Production `PmDataReader` on Supabase REST (read-only selects). */
export class SupabasePmDataReader implements PmDataReader {
  async verifyPassed(vtids: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const v of vtids.filter((x) => /^VTID-\d{5}$/.test(x)).slice(0, 40)) {
      const rows = await supaRest<Array<{ created_at: string }>>(
        `/rest/v1/oasis_events?topic=eq.staging.verify.passed&metadata->vtids=cs.${enc(JSON.stringify([v]))}&select=created_at&order=created_at.asc&limit=1`,
      );
      if (rows[0]) out[v] = rows[0].created_at;
    }
    return out;
  }
  async gate2SentVtids(): Promise<Set<string>> {
    const rows = await supaRest<Array<{ payload: { vtids?: unknown } | null }>>(`/rest/v1/pm_digests?kind=eq.gate2_batch&select=payload&order=created_at.desc&limit=500`);
    const out = new Set<string>();
    for (const r of rows) for (const v of Array.isArray(r.payload?.vtids) ? r.payload!.vtids as unknown[] : []) out.add(String(v));
    return out;
  }
  async ledgerStatus(vtids: string[]): Promise<Record<string, string>> {
    const ok = vtids.filter((v) => /^VTID-\d{5}$/.test(v));
    if (!ok.length) return {};
    const rows = await supaRest<Array<{ vtid: string; status: string }>>(`/rest/v1/vtid_ledger?vtid=in.(${ok.map(enc).join(',')})&select=vtid,status`);
    return Object.fromEntries(rows.map((r) => [r.vtid, r.status]));
  }
  async sparringSession(id: string): Promise<ObservedPlanSparring | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await supaRest<Array<{ id: string; producer: string | null; verdict: string | null; policy_approved_at: string | null; final_plan_hash: string | null }>>(
      `/rest/v1/plan_sparring_sessions?id=eq.${enc(id)}&select=id,producer,verdict,policy_approved_at,final_plan_hash&limit=1`,
    );
    const s = rows[0];
    return s ? { session_id: s.id, producer: s.producer, verdict: s.verdict, policy_approved_at: s.policy_approved_at, final_plan_hash: s.final_plan_hash } : null;
  }
}
