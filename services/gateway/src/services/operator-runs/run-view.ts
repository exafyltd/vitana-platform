/**
 * VTID-05069 — the live pipeline tree of one VTID, for the Operator Console.
 *
 * `buildRunView(vtid)` assembles, read-only, where a VTID stands:
 *   Plan → Repositories (vitana-platform, vitana-v1: Implement → Pull request →
 *   CI → Fix forward → Merge) → Staging deploy → STAGING-VERIFY → Gate 2 → Production.
 *
 * Every node comes from an existing record; nothing is written and nothing is
 * inferred beyond the rules written next to each node below:
 *   Plan            plan_sparring_sessions (vtid) — fallback: vtid_ledger.metadata
 *   Implement       kiro_runs / kiro_run_events of the threads linked to the VTID
 *                   (operator.kiro.* OASIS events carry thread_id + for_vtid), or the
 *                   Dev Autopilot execution of a platform VTID it runs instead of Kiro
 *   Pull request,   one GitHub search per thread (`"VTID-a" OR "VTID-b" in:title`,
 *   CI, Merge       both repos), then PR detail / check runs / PR commits only for
 *                   PRs that are not merged yet (a merged PR's detail is cached for good)
 *   Staging deploy  STAGING-VERIFY events (a verification runs only on a deployed
 *                   commit), else the AWS-STAGE-DEPLOY-* workflow runs after the merge
 *   STAGING-VERIFY  oasis_events staging.verify.passed|failed|superseded whose
 *                   metadata.vtids holds the VTID or metadata.commit is the merge commit
 *   Gate 2          derived: verify passed and production does not contain the merge yet
 *   Production      production build-info commit (gateway) / version stamp
 *                   (community-app) compared with the merge commit; AWS-PROD-DEPLOY-*
 *                   runs for "deploying"
 *
 * Failure posture (the resume-pack pattern): every source fails open — only
 * its own nodes become `unknown` and the source is named in `unavailable[]`;
 * the view itself never fails because one source did.
 *
 * GitHub budget: views are cached 30 s per VTID (shared by every viewer);
 * the search runs once per thread for all of its VTIDs; search calls from
 * this module are capped at 10 per minute (GitHub's search limit is 30/min,
 * shared with the resume pack, Kiro writes and Dev Autopilot) — past the cap
 * the last search result is reused and the view says `stale: true`.
 *
 * Admin-facing, English by design (Command Hub Operator Console).
 */

import { getSupabase, supa } from '../dev-autopilot-execute';
import {
  searchPullRequests,
  getPullRequest,
  getCheckRuns,
  getPullRequestCommits,
  getWorkflowRuns,
  compareStatus,
  getCommitsBetween,
  type GitHubPrSearchHit,
} from '../github-service';
import { repoGitHubToken, type VitanaRepo } from '../vitana-repos';
import { AWS_PROD_GATEWAY_URL } from '../aws-gateway-admin';

export const RUN_VIEW_VTID_RE = /^VTID-\d{5}$/;
export const RUN_VIEW_THREAD_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const RUN_VIEW_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
export const RUN_VIEW_CACHE_MS = 30_000;
export const RUN_VIEW_SEARCH_BUDGET_PER_MIN = 10;
export const RUN_VIEW_CALL_TIMEOUT_MS = 8_000;
export const RUN_VIEW_MAX_THREAD_VTIDS = 5;
export const RUN_VIEW_FIX_ATTEMPTS = 3;
/** SSE: re-check every 15 s while a node runs, every 60 s otherwise; close 60 s after terminal or after 2 h. */
export const RUN_VIEW_STREAM = { runningMs: 15_000, idleMs: 60_000, terminalGraceMs: 60_000, maxMs: 2 * 60 * 60 * 1000 };

const SERVICE_OF: Record<string, 'gateway' | 'community-app'> = {
  'exafyltd/vitana-platform': 'gateway',
  'exafyltd/vitana-v1': 'community-app',
};
const STAGE_WORKFLOW: Record<string, string> = {
  'exafyltd/vitana-platform': 'AWS-STAGE-DEPLOY-GATEWAY.yml',
  'exafyltd/vitana-v1': 'AWS-STAGE-DEPLOY-FRONTEND.yml',
};
const PROD_WORKFLOW: Record<string, string> = {
  'exafyltd/vitana-platform': 'AWS-PROD-DEPLOY-GATEWAY.yml',
  'exafyltd/vitana-v1': 'AWS-PROD-DEPLOY-FRONTEND.yml',
};
const FRONTEND_PUBLISH_URL = 'https://github.com/exafyltd/vitana-v1/actions/workflows/AWS-PROD-DEPLOY-FRONTEND.yml';

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

export type RunNodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'waiting' | 'skipped' | 'unknown';
export type RunViewStatus = 'pending' | 'running' | 'failed' | 'waiting' | 'done';

export interface RunNodeLink { href: string; label: string }
export interface RunNode {
  id: string;
  label: string;
  status: RunNodeStatus;
  detail?: string;
  meta?: string;
  /** ISO time shown next to the meta (HH:MM, the viewer's clock). */
  at?: string;
  links?: RunNodeLink[];
  chip?: { text: string; kind: 'parallel' | 'loop' | 'gate' };
  /** Red line under the node (the failing check). */
  error?: string;
  /** "now:" line under the node (the running Kiro step). */
  live?: string;
  collapsed?: boolean;
  children?: RunNode[];
}

export interface Gate2Commit { sha: string; message: string; mine: boolean }
export interface Gate2Box {
  question: string;
  since: string | null;
  services: Array<{ service: 'gateway' | 'community-app'; repo: string; verified_commit: string | null; production_commit: string | null }>;
  /** Every commit a PUBLISH would ship (production → verified staging), newest first. */
  commits: Gate2Commit[];
  commits_unavailable?: boolean;
  publish: Array<{ service: 'gateway' | 'community-app'; kind: 'publish_flow' | 'link'; href?: string }>;
}

export interface RunView {
  vtid: string;
  title: string | null;
  status: RunViewStatus;
  summary: string;
  started_at: string | null;
  generated_at: string;
  terminal: boolean;
  stale: boolean;
  unavailable: string[];
  nodes: RunNode[];
  gate2: Gate2Box | null;
  /** The existing cancel paths Stop may call (only while they run). */
  actions: { kiro_run_id: string | null; autopilot_execution_id: string | null };
  thread_ids: string[];
}

// ---------------------------------------------------------------------------
// Source records (what the deps return)
// ---------------------------------------------------------------------------

export interface RunLedgerRow {
  vtid: string;
  title: string | null;
  status: string | null;
  is_terminal: boolean | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
}
export interface RunSparring { rounds: number; verdict: string; approved_at: string | null; created_at: string | null }
export interface KiroLinkEvent { topic: string; created_at: string; thread_id: string | null; repo: string | null; branch: string | null; commit_sha: string | null; files: number | null }
export interface KiroRunSummary {
  id: string;
  thread_id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  tool_calls: number;
  last_tool_title: string | null;
}
export interface AutopilotExec { id: string; status: string; created_at: string; updated_at: string | null }
export interface PrDetail { head_sha: string | null; head_ref: string | null; draft: boolean; merged_at: string | null; merge_commit_sha: string | null; closed_at: string | null }
export interface CheckSummary { total: number; passed: number; failed: number; running: number; first_failure: { name: string; summary: string | null; url: string | null } | null; url: string | null }
export interface VerifyEvent {
  topic: string;
  created_at: string;
  service: string | null;
  commit: string | null;
  production_commit: string | null;
  run_url: string | null;
  vtids: string[];
  results: Array<{ suite?: string; name?: string; ok?: boolean; problems?: unknown }>;
}
export interface WorkflowRunRow { id: number; status: string; conclusion: string | null; html_url: string; created_at: string; head_sha: string | null; head_branch: string | null }

export interface RunViewDeps {
  loadLedger(vtid: string): Promise<RunLedgerRow | null>;
  loadSparring(vtid: string): Promise<RunSparring | null>;
  loadKiroEvents(vtid: string): Promise<KiroLinkEvent[]>;
  loadKiroRuns(threadIds: string[], since: string | null): Promise<KiroRunSummary[]>;
  loadAutopilotExecution(vtid: string): Promise<AutopilotExec | null>;
  searchPrs(vtids: string[]): Promise<GitHubPrSearchHit[]>;
  prDetail(repo: string, n: number, merged: boolean): Promise<PrDetail>;
  prCommits(repo: string, n: number): Promise<string[]>;
  checkSummary(repo: string, sha: string): Promise<CheckSummary>;
  loadVerifyEvents(vtid: string, commits: string[]): Promise<VerifyEvent[]>;
  workflowRuns(repo: string, workflow: string): Promise<WorkflowRunRow[]>;
  productionCommit(service: 'gateway' | 'community-app'): Promise<string | null>;
  compare(repo: string, base: string, head: string): Promise<string>;
  commitsBetween(repo: string, base: string, head: string): Promise<Array<{ sha: string; message: string }>>;
  now(): Date;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 160);
}

function timeout<T>(p: Promise<T>, ms = RUN_VIEW_CALL_TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms).unref?.())]);
}

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');
const repoName = (repo: string): string => repo.replace(/^.*\//, '');

/** compare(base=commit, head=deployed): `ahead`/`identical` = the deployed commit contains it. */
export function containsFromCompare(status: string): boolean {
  return status === 'ahead' || status === 'identical';
}

/**
 * The status of a parent from its children: a running child wins (a failed CI
 * being fixed is still moving), then failed, waiting, unknown; all passed or
 * not needed = passed; anything else = pending.
 */
export function aggregateStatus(children: RunNode[]): RunNodeStatus {
  const s = children.map((c) => c.status);
  if (s.length === 0) return 'pending';
  if (s.includes('running')) return 'running';
  if (s.includes('failed')) return 'failed';
  if (s.includes('waiting')) return 'waiting';
  if (s.every((x) => x === 'passed' || x === 'skipped')) return s.every((x) => x === 'skipped') ? 'skipped' : 'passed';
  if (s.includes('unknown')) return 'unknown';
  return 'pending';
}

const ACTIVE_RUN = new Set(['queued', 'running', 'waiting_permission']);
const AUTOPILOT_RUNNING = new Set(['cooling', 'running']);
const AUTOPILOT_FAILED = new Set(['failed', 'cancelled', 'reverted']);

// ---------------------------------------------------------------------------
// Search budget + per-VTID PR cache (module state, shared by every viewer)
// ---------------------------------------------------------------------------

const searchCalls: number[] = [];
const prHitsByVtid = new Map<string, { at: number; hits: GitHubPrSearchHit[] }>();
const viewCache = new Map<string, { at: number; view: RunView }>();

function searchBudgetLeft(now: number): boolean {
  while (searchCalls.length && now - searchCalls[0] > 60_000) searchCalls.shift();
  return searchCalls.length < RUN_VIEW_SEARCH_BUDGET_PER_MIN;
}

/**
 * PR hits for each VTID: fresh cached hits first; the rest in ONE search. Past the
 * search budget the last result is reused (`stale`), or the VTID has none (`failed`).
 */
export async function prHitsFor(
  deps: Pick<RunViewDeps, 'searchPrs'>,
  vtids: string[],
  now: number,
): Promise<{ hits: Map<string, GitHubPrSearchHit[]>; stale: Set<string>; failed: Map<string, string> }> {
  const hits = new Map<string, GitHubPrSearchHit[]>();
  const stale = new Set<string>();
  const failed = new Map<string, string>();
  const need: string[] = [];
  for (const v of vtids) {
    const c = prHitsByVtid.get(v);
    if (c && now - c.at < RUN_VIEW_CACHE_MS) hits.set(v, c.hits);
    else need.push(v);
  }
  if (need.length === 0) return { hits, stale, failed };
  const fallBack = (reason: string): void => {
    for (const v of need) {
      const c = prHitsByVtid.get(v);
      if (c) { hits.set(v, c.hits); stale.add(v); } else failed.set(v, reason);
    }
  };
  if (!searchBudgetLeft(now)) { fallBack('GitHub search budget reached (10/min)'); return { hits, stale, failed }; }
  searchCalls.push(now);
  try {
    const all = await timeout(deps.searchPrs(need));
    for (const v of need) {
      const mine = all.filter((h) => typeof h.title === 'string' && h.title.includes(v));
      prHitsByVtid.set(v, { at: now, hits: mine });
      hits.set(v, mine);
    }
  } catch (e) {
    fallBack(`GitHub search: ${errText(e)}`);
  }
  return { hits, stale, failed };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface RepoState {
  repo: string;
  pr: GitHubPrSearchHit | null;
  detail: PrDetail | null;
  merged: boolean;
  mergeSha: string | null;
  mergedAt: string | null;
  node: RunNode;
  hasEvidence: boolean;
  fixAttempts: number;
  fixExhausted: boolean;
}

export interface BuildRunViewOptions {
  /** The thread the viewer is in: its Kiro runs count as this VTID's work. */
  threadId?: string | null;
  /** PR hits already fetched for this VTID (a batched thread search). */
  prHits?: { hits: GitHubPrSearchHit[] | null; stale: boolean; error: string | null };
}

export async function buildRunViewWith(
  deps: RunViewDeps,
  vtid: string,
  opts: BuildRunViewOptions = {},
): Promise<{ ok: true; view: RunView } | { ok: false; error: 'invalid_vtid' }> {
  if (!RUN_VIEW_VTID_RE.test(vtid)) return { ok: false, error: 'invalid_vtid' };
  const now = deps.now();
  const unavailable: string[] = [];
  const fail = (what: string) => (e: unknown) => { unavailable.push(`${what}: ${errText(e)}`); return undefined; };

  // ---- independent reads -------------------------------------------------
  const prHitsP = opts.prHits
    ? Promise.resolve(opts.prHits)
    : prHitsFor(deps, [vtid], now.getTime()).then((r) => ({ hits: r.hits.get(vtid) ?? null, stale: r.stale.has(vtid), error: r.failed.get(vtid) ?? null }));
  const [ledger, sparring, kiroEvents, autopilot, prHits] = await Promise.all([
    timeout(deps.loadLedger(vtid)).catch(fail('ledger')),
    timeout(deps.loadSparring(vtid)).catch(fail('plan sparring')),
    timeout(deps.loadKiroEvents(vtid)).catch(fail('Kiro events')),
    timeout(deps.loadAutopilotExecution(vtid)).catch(fail('Dev Autopilot')),
    prHitsP,
  ]);
  if (prHits.error) unavailable.push(`pull requests: ${prHits.error}`);

  const threadIds = [...new Set([...(kiroEvents || []).map((e) => e.thread_id).filter((t): t is string => !!t), ...(opts.threadId ? [opts.threadId] : [])])];
  const kiroRuns = threadIds.length
    ? await timeout(deps.loadKiroRuns(threadIds, ledger?.created_at ?? null)).catch(fail('Kiro runs'))
    : [];

  // ---- Plan ------------------------------------------------------------
  const plan: RunNode = { id: 'plan', label: 'Plan', status: 'pending' };
  if (sparring === undefined) { plan.status = 'unknown'; plan.detail = 'sparring record unavailable'; }
  else if (sparring) {
    const verdict = sparring.verdict === 'in_progress' ? 'sparring in progress' : sparring.verdict;
    plan.detail = `sparred ${sparring.rounds} round${sparring.rounds === 1 ? '' : 's'} · ${verdict}`;
    if (sparring.approved_at) { plan.status = 'passed'; plan.meta = 'Gate 1 approved'; plan.at = sparring.approved_at; }
    else if (sparring.verdict === 'in_progress') plan.status = 'running';
    else { plan.status = 'waiting'; plan.meta = 'Gate 1 — your approval'; }
  } else if (ledger && ledger.metadata && (ledger.metadata.sparring_id || ledger.metadata.plan_hash)) {
    plan.status = 'passed';
    plan.detail = 'sparring record linked in the ledger';
  } else {
    plan.detail = ledger ? 'no sparring record linked to this VTID' : 'VTID not in the ledger';
  }

  // ---- Kiro / Dev Autopilot activity --------------------------------------
  const runs = kiroRuns || [];
  const activeRun = runs.find((r) => ACTIVE_RUN.has(r.status)) || null;
  const toolCalls = runs.reduce((n, r) => n + (r.tool_calls || 0), 0);
  const lastRun = runs[0] || null;
  const autopilotRunning = autopilot && AUTOPILOT_RUNNING.has(autopilot.status) ? autopilot : null;
  const workActive = !!activeRun || !!autopilotRunning;

  // ---- Repositories --------------------------------------------------------
  const pushes = (kiroEvents || []).filter((e) => e.topic === 'operator.kiro.branch_pushed');
  const repoStates: RepoState[] = [];
  for (const repo of RUN_VIEW_REPOS) {
    const hits = (prHits.hits || []).filter((h) => h.repo === repo);
    const pr = hits.find((h) => h.state === 'open') || hits.find((h) => h.merged) || hits[0] || null;
    const repoPushes = pushes.filter((p) => p.repo === repo);
    const hasAutopilot = repo === RUN_VIEW_REPOS[0] && !!autopilot;
    const node: RunNode = { id: `repo:${repoName(repo)}`, label: repoName(repo), status: 'pending', children: [] };
    const branch = repoPushes[0]?.branch ?? null;
    if (branch) node.detail = branch;
    repoStates.push({
      repo, pr, detail: null, merged: !!pr?.merged, mergeSha: null, mergedAt: null, node,
      hasEvidence: !!pr || repoPushes.length > 0 || hasAutopilot, fixAttempts: 0, fixExhausted: false,
    });
  }
  const evidenceRepos = repoStates.filter((r) => r.hasEvidence);

  const kiroDetail = (): { meta: string; live: string | null } => {
    const parts = ['Kiro'];
    if (toolCalls) parts.push(`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`);
    return { meta: parts.join(' · '), live: activeRun && activeRun.last_tool_title ? activeRun.last_tool_title : null };
  };

  const implementNode = (rs: RepoState): RunNode => {
    const n: RunNode = { id: `${rs.node.id}:implement`, label: 'Implement', status: 'pending' };
    const repoPushes = pushes.filter((p) => p.repo === rs.repo);
    if (rs.repo === RUN_VIEW_REPOS[0] && autopilot) {
      n.meta = 'Dev Autopilot';
      n.at = autopilot.created_at;
      if (AUTOPILOT_RUNNING.has(autopilot.status)) { n.status = 'running'; n.detail = `execution ${autopilot.status}`; }
      else if (autopilot.status === 'awaiting_approval') { n.status = 'waiting'; n.detail = 'diff waiting for your review'; }
      else if (AUTOPILOT_FAILED.has(autopilot.status)) { n.status = 'failed'; n.detail = `execution ${autopilot.status}`; }
      else { n.status = 'passed'; n.detail = `execution ${autopilot.status}`; }
      return n;
    }
    if (kiroRuns === undefined && !rs.pr && repoPushes.length === 0) { n.status = 'unknown'; return n; }
    const k = kiroDetail();
    if (runs.length) n.meta = k.meta;
    if (activeRun) {
      n.status = activeRun.status === 'waiting_permission' ? 'waiting' : 'running';
      n.detail = activeRun.status === 'waiting_permission' ? 'Kiro asks for your approval' : activeRun.status === 'queued' ? 'queued' : undefined;
      if (k.live && !rs.pr) n.live = k.live;
      n.at = activeRun.started_at || activeRun.created_at;
      if (rs.pr) { n.status = 'passed'; n.detail = 'pull request opened'; }
      return n;
    }
    if (repoPushes.length) {
      n.status = 'passed';
      const files = repoPushes.reduce((s, p) => s + (p.files || 0), 0);
      n.detail = `${repoPushes.length} push${repoPushes.length === 1 ? '' : 'es'}${files ? ` · ${files} file${files === 1 ? '' : 's'}` : ''}`;
      n.at = repoPushes[0].created_at;
      return n;
    }
    if (rs.pr) { n.status = 'passed'; n.detail = runs.length ? 'pull request opened' : 'pull request opened outside the Operator'; return n; }
    if (lastRun && (lastRun.status === 'failed' || lastRun.status === 'interrupted')) {
      n.status = 'failed';
      n.error = `Kiro run ${lastRun.status}${lastRun.error ? `: ${lastRun.error}` : ''}`;
      return n;
    }
    if (lastRun) n.detail = 'edits not pushed yet';
    return n;
  };

  // PR detail + CI + fix forward per repo with a PR.
  await Promise.all(repoStates.map(async (rs) => {
    if (!rs.pr) return;
    try {
      rs.detail = await timeout(deps.prDetail(rs.repo, rs.pr.number, rs.pr.merged));
      rs.mergeSha = rs.detail.merge_commit_sha;
      rs.mergedAt = rs.detail.merged_at;
    } catch (e) { unavailable.push(`${repoName(rs.repo)} PR #${rs.pr.number}: ${errText(e)}`); }
  }));

  for (const rs of repoStates) {
    const kids: RunNode[] = [];
    if (rs.hasEvidence || workActive) kids.push(implementNode(rs));
    const prNode: RunNode = { id: `${rs.node.id}:pr`, label: 'Pull request', status: 'pending' };
    const ciNode: RunNode = { id: `${rs.node.id}:ci`, label: 'CI', status: 'pending' };
    const mergeNode: RunNode = { id: `${rs.node.id}:merge`, label: 'Merge to main', status: 'pending' };
    let fixNode: RunNode | null = null;
    if (prHits.hits === null && !prHits.stale) {
      prNode.status = ciNode.status = mergeNode.status = 'unknown';
    } else if (rs.pr) {
      const pr = rs.pr;
      prNode.links = [{ href: pr.html_url, label: `#${pr.number}` }];
      if (pr.merged) {
        prNode.status = 'passed';
        ciNode.status = 'passed'; ciNode.detail = 'passed before merge';
        mergeNode.status = 'passed';
        mergeNode.meta = short(rs.mergeSha) || undefined;
        if (rs.mergedAt) mergeNode.at = rs.mergedAt;
      } else if (pr.state === 'closed') {
        prNode.status = 'failed'; prNode.detail = 'closed without merging';
        ciNode.status = 'skipped'; mergeNode.status = 'skipped';
      } else {
        prNode.status = rs.detail?.draft ? 'running' : 'passed';
        if (rs.detail?.draft) prNode.detail = 'draft';
        if (!rs.detail || !rs.detail.head_sha) { ciNode.status = 'unknown'; }
        else {
          try {
            const head = await timeout(deps.checkSummary(rs.repo, rs.detail.head_sha));
            applyCheckSummary(ciNode, head);
            fixNode = await fixForwardNode(deps, rs, head, workActive, unavailable);
          } catch (e) {
            ciNode.status = 'unknown';
            unavailable.push(`${repoName(rs.repo)} checks: ${errText(e)}`);
          }
        }
      }
    }
    kids.push(prNode, ciNode);
    if (fixNode) {
      kids.push(fixNode);
      // The "now:" line follows the step Kiro is on: the fix, once there is one.
      if (fixNode.status === 'running') {
        const k = kiroDetail();
        if (k.live) fixNode.live = k.live;
        if (runs.length && !fixNode.meta) fixNode.meta = k.meta;
      }
    } else if (ciNode.status === 'failed' && workActive) {
      const k = kiroDetail();
      if (k.live) ciNode.live = k.live;
    }
    kids.push(mergeNode);
    rs.node.children = kids;
  }

  // ---- Staging deploy / STAGING-VERIFY / Gate 2 / Production -------------
  const merged = repoStates.filter((r) => r.merged);
  const mergeShas = merged.map((r) => r.mergeSha).filter((s): s is string => !!s);
  const verifyEvents = merged.length
    ? await timeout(deps.loadVerifyEvents(vtid, mergeShas)).catch(fail('STAGING-VERIFY events'))
    : [];

  const latestVerify = (rs: RepoState): VerifyEvent | null => {
    const svc = SERVICE_OF[rs.repo];
    const evs = (verifyEvents || [])
      .filter((e) => (e.service === svc || e.service === `staging-verify-${svc}`) && (e.vtids.includes(vtid) || (!!rs.mergeSha && e.commit === rs.mergeSha)))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return evs[0] || null;
  };

  const deployChildren: string[] = [];
  const staging: RunNode = { id: 'staging', label: 'Staging deploy', status: 'pending' };
  const verify: RunNode = { id: 'verify', label: 'STAGING-VERIFY', status: 'pending' };
  const gate2: RunNode = { id: 'gate2', label: 'Gate 2', status: 'pending', chip: { text: 'your approval', kind: 'gate' } };
  const production: RunNode = { id: 'production', label: 'Production', status: 'pending' };
  const svcLabel = (evidenceRepos.length ? evidenceRepos : repoStates.slice(0, 1)).map((r) => SERVICE_OF[r.repo]).join(' · ');
  staging.detail = svcLabel;
  production.detail = svcLabel;

  const deploySt: RunNodeStatus[] = [];
  const verifySt: RunNodeStatus[] = [];
  const passedVerify: Array<{ rs: RepoState; ev: VerifyEvent }> = [];
  const verifyDetails: string[] = [];
  for (const rs of merged) {
    const svc = SERVICE_OF[rs.repo];
    const ev = latestVerify(rs);
    if (verifyEvents === undefined) { verifySt.push('unknown'); }
    if (ev) {
      deploySt.push('passed');
      deployChildren.push(`${svc} ${short(ev.commit)}`);
      if (ev.topic === 'staging.verify.passed') {
        verifySt.push('passed');
        passedVerify.push({ rs, ev });
        const ok = ev.results.filter((r) => r.ok).length;
        verifyDetails.push(`${merged.length > 1 ? `${svc} ` : ''}${ev.results.length ? `${ok}/${ev.results.length} suites passed` : 'passed'}`);
        verify.detail = verifyDetails.join(' · ');
        if (ev.run_url) verify.links = [...(verify.links || []), { href: ev.run_url, label: merged.length > 1 ? `${svc} run` : 'run' }];
        verify.at = ev.created_at;
      } else if (ev.topic === 'staging.verify.failed') {
        verifySt.push('failed');
        const bad = ev.results.find((r) => r.ok === false);
        const problems = bad && Array.isArray(bad.problems) ? String(bad.problems[0] ?? '') : '';
        verify.error = `✕ ${svc}${bad ? ` › ${[bad.suite, bad.name].filter(Boolean).join(' › ')}` : ''}${problems ? ` — ${problems}` : ''}`.slice(0, 300);
        if (ev.run_url) verify.links = [...(verify.links || []), { href: ev.run_url, label: 'run log' }];
      } else {
        verifySt.push('pending');
        verify.detail = 'superseded by a newer commit — waiting for its verification';
      }
      continue;
    }
    if (verifyEvents !== undefined) verifySt.push('pending');
    // No verification yet: the staging deploy workflow run after the merge.
    try {
      const wf = await timeout(deps.workflowRuns(rs.repo, STAGE_WORKFLOW[rs.repo]));
      const after = wf.filter((r) => (rs.mergeSha && r.head_sha === rs.mergeSha) || (!!rs.mergedAt && r.created_at >= rs.mergedAt && (r.head_branch ?? 'main') === 'main'));
      const run = after.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0] || null;
      if (!run) deploySt.push('pending');
      else {
        const st: RunNodeStatus = run.status !== 'completed' ? 'running' : run.conclusion === 'success' ? 'passed' : 'failed';
        deploySt.push(st);
        deployChildren.push(`${svc} ${short(run.head_sha)}`);
        staging.links = [...(staging.links || []), { href: run.html_url, label: merged.length > 1 ? `${svc} run` : 'run' }];
      }
    } catch (e) {
      deploySt.push('unknown');
      unavailable.push(`${svc} staging deploy runs: ${errText(e)}`);
    }
  }
  if (merged.length) {
    staging.status = aggregateStatus(deploySt.map((s, i) => ({ id: String(i), label: '', status: s })));
    if (deployChildren.length) staging.detail = deployChildren.join(' · ');
    verify.status = aggregateStatus(verifySt.map((s, i) => ({ id: String(i), label: '', status: s })));
  }

  // Production + Gate 2: only once every merged repo verified.
  const allMergedDone = evidenceRepos.length > 0 && evidenceRepos.every((r) => r.merged);
  let gate2Box: Gate2Box | null = null;
  const prodSt: RunNodeStatus[] = [];
  const prodInfo: Gate2Box['services'] = [];
  if (merged.length) {
    for (const rs of merged) {
      const svc = SERVICE_OF[rs.repo];
      let prodCommit: string | null = null;
      try { prodCommit = await timeout(deps.productionCommit(svc)); }
      catch (e) { unavailable.push(`${svc} production version: ${errText(e)}`); prodSt.push('unknown'); continue; }
      const pv = passedVerify.find((p) => p.rs === rs);
      prodInfo.push({ service: svc, repo: rs.repo, verified_commit: pv?.ev.commit ?? null, production_commit: prodCommit });
      if (!prodCommit || !rs.mergeSha) { prodSt.push('unknown'); continue; }
      try {
        const contains = containsFromCompare(await timeout(deps.compare(rs.repo, rs.mergeSha, prodCommit)));
        if (contains) { prodSt.push('passed'); continue; }
      } catch (e) { unavailable.push(`${svc} production compare: ${errText(e)}`); prodSt.push('unknown'); continue; }
      // Not in production yet: a production deploy running now?
      try {
        const wf = await timeout(deps.workflowRuns(rs.repo, PROD_WORKFLOW[rs.repo]));
        const running = wf.find((r) => r.status !== 'completed' && (!pv || r.created_at >= pv.ev.created_at));
        if (running) { prodSt.push('running'); production.links = [...(production.links || []), { href: running.html_url, label: `${svc} deploy` }]; continue; }
      } catch (e) { unavailable.push(`${svc} production deploy runs: ${errText(e)}`); }
      prodSt.push('pending');
    }
    production.status = aggregateStatus(prodSt.map((s, i) => ({ id: String(i), label: '', status: s })));
    if (production.status === 'passed') production.detail = `${svcLabel} · live`;
  }

  if (production.status === 'passed') gate2.status = 'passed';
  // Production unreadable: whether the yes is still needed is unknown, not "waiting".
  else if (production.status === 'unknown' && verify.status === 'passed') gate2.status = 'unknown';
  else if (allMergedDone && verify.status === 'passed' && passedVerify.length === merged.length && merged.length > 0) {
    if (production.status === 'running') gate2.status = 'passed';
    else {
      gate2.status = 'waiting';
      const since = passedVerify.map((p) => p.ev.created_at).sort().slice(-1)[0] ?? null;
      gate2.at = since ?? undefined;
      gate2Box = await buildGate2Box(deps, vtid, prodInfo, since, unavailable);
    }
  } else if (verify.status === 'unknown' || production.status === 'unknown') {
    gate2.status = 'unknown';
  }

  // ---- repo statuses (after their children) --------------------------------
  const anyRepoMergedAndDeploying = merged.length > 0 && (staging.status === 'running' || staging.status === 'passed');
  for (const rs of repoStates) {
    if (!rs.hasEvidence) {
      rs.node.children = [];
      rs.node.collapsed = true;
      if (prHits.hits === null && !prHits.stale) { rs.node.status = 'unknown'; rs.node.detail = 'pull requests unavailable'; }
      else if (anyRepoMergedAndDeploying) { rs.node.status = 'skipped'; rs.node.detail = 'no changes needed in this repo'; }
      else { rs.node.status = 'pending'; rs.node.detail = 'no branch or pull request yet'; }
      continue;
    }
    rs.node.status = aggregateStatus(rs.node.children || []);
    if (rs.merged) { rs.node.collapsed = true; rs.node.detail = rs.node.detail || `#${rs.pr?.number} merged`; }
  }

  const reposNode: RunNode = { id: 'repos', label: 'Repositories', status: 'pending', chip: { text: 'parallel', kind: 'parallel' }, children: repoStates.map((r) => r.node) };
  // Kiro is working but no repo is known yet: show the work at this level.
  if (workActive && evidenceRepos.length === 0) {
    const k = kiroDetail();
    const kiroNode: RunNode = {
      id: 'repos:kiro',
      label: autopilotRunning ? 'Dev Autopilot' : 'Kiro workspace',
      status: activeRun?.status === 'waiting_permission' ? 'waiting' : 'running',
      detail: activeRun?.status === 'waiting_permission' ? 'Kiro asks for your approval' : 'implementing — no branch pushed yet',
      meta: autopilotRunning ? undefined : k.meta,
      ...(k.live ? { live: k.live } : {}),
    };
    reposNode.children = [kiroNode, ...(reposNode.children || [])];
  }
  reposNode.status = workActive && evidenceRepos.length === 0
    ? (activeRun?.status === 'waiting_permission' ? 'waiting' : 'running')
    : aggregateStatus(repoStates.filter((r) => r.hasEvidence).map((r) => r.node));
  if (evidenceRepos.length === 0 && !workActive) reposNode.status = prHits.hits === null && !prHits.stale ? 'unknown' : 'pending';
  if (reposNode.status === 'passed') {
    reposNode.collapsed = true;
    const prs = evidenceRepos.filter((r) => r.pr).map((r) => r.pr!);
    reposNode.detail = `${prs.length} PR${prs.length === 1 ? '' : 's'} merged`;
    reposNode.links = prs.map((p) => ({ href: p.html_url, label: `#${p.number}` }));
  }

  const nodes: RunNode[] = [plan, reposNode, staging, verify, gate2, production];

  // ---- overall ------------------------------------------------------------
  const fixExhausted = repoStates.some((r) => r.fixExhausted);
  const ledgerTerminal = !!ledger?.is_terminal;
  const terminal = production.status === 'passed' || fixExhausted || ledgerTerminal;
  let status: RunViewStatus;
  if (production.status === 'passed') status = 'done';
  else if (gate2.status === 'waiting') status = 'waiting';
  else if (nodes.some((n) => n.status === 'running')) status = 'running';
  else if (nodes.some((n) => n.status === 'failed')) status = 'failed';
  else if (nodes.some((n) => n.status === 'waiting')) status = 'waiting';
  else status = ledgerTerminal ? 'done' : 'pending';

  const stages = [plan, reposNode, staging, verify, gate2, production];
  const step = stages.findIndex((n) => n.status !== 'passed' && n.status !== 'skipped');
  const fixing = repoStates.map((r) => (r.node.children || []).find((c) => c.id.endsWith(':fix') && c.status === 'running')).find(Boolean);
  const repoCount = `${evidenceRepos.length || 'no'} repo${evidenceRepos.length === 1 ? '' : 's'}`;
  let summary: string;
  if (status === 'done') summary = production.status === 'passed' ? 'in production' : `closed in the ledger (${ledger?.status ?? 'terminal'})`;
  else if (status === 'waiting' && gate2.status === 'waiting') summary = 'waiting for you';
  else if (fixing) summary = `${repoCount} · fix ${fixing.chip?.text ?? 'attempt'}`;
  else if (status === 'failed') summary = `${repoCount} · failed at ${(nodes.find((n) => n.status === 'failed') || plan).label}`;
  else summary = `${repoCount} · step ${step < 0 ? stages.length : step + 1} of ${stages.length}`;

  const startedCandidates = [sparring?.created_at, ledger?.created_at].filter((x): x is string => !!x).sort();
  const view: RunView = {
    vtid,
    title: ledger?.title ?? null,
    status,
    summary,
    started_at: startedCandidates[0] ?? null,
    generated_at: now.toISOString(),
    terminal,
    stale: prHits.stale,
    unavailable,
    nodes,
    gate2: gate2Box,
    actions: { kiro_run_id: activeRun ? activeRun.id : null, autopilot_execution_id: autopilotRunning ? autopilotRunning.id : null },
    thread_ids: threadIds,
  };
  return { ok: true, view };
}

function applyCheckSummary(ci: RunNode, s: CheckSummary): void {
  if (s.total === 0) { ci.status = 'pending'; ci.detail = 'no checks yet'; return; }
  const done = s.passed + s.failed;
  if (s.failed > 0) {
    ci.status = 'failed';
    ci.detail = `${s.passed} of ${s.total} checks passed`;
    if (s.first_failure) {
      ci.error = `✕ ${s.first_failure.name}${s.first_failure.summary ? ` — ${s.first_failure.summary}` : ''}`.slice(0, 300);
      if (s.first_failure.url) ci.links = [{ href: s.first_failure.url, label: 'run log' }];
    }
  } else if (s.running > 0) {
    ci.status = 'running';
    ci.detail = `${done} of ${s.total} checks done`;
  } else {
    ci.status = 'passed';
    ci.detail = `${s.passed} of ${s.total} checks passed`;
  }
}

/**
 * Fix forward = pushes to the PR after its first failed CI (the PR's commits;
 * the newest RUN_VIEW_FIX_ATTEMPTS + 1 are checked). No failure → no node.
 */
async function fixForwardNode(
  deps: RunViewDeps,
  rs: RepoState,
  head: CheckSummary,
  workActive: boolean,
  unavailable: string[],
): Promise<RunNode | null> {
  if (!rs.pr) return null;
  let shas: string[];
  try { shas = await timeout(deps.prCommits(rs.repo, rs.pr.number)); }
  catch (e) { unavailable.push(`${repoName(rs.repo)} PR commits: ${errText(e)}`); return null; }
  const window = shas.slice(-(RUN_VIEW_FIX_ATTEMPTS + 1));
  if (window.length === 0) return null;
  const summaries: CheckSummary[] = [];
  for (let i = 0; i < window.length; i++) {
    if (i === window.length - 1) { summaries.push(head); continue; }
    try { summaries.push(await timeout(deps.checkSummary(rs.repo, window[i]))); }
    catch (e) { unavailable.push(`${repoName(rs.repo)} checks of ${short(window[i])}: ${errText(e)}`); summaries.push({ total: 0, passed: 0, failed: 0, running: 0, first_failure: null, url: null }); }
  }
  const firstFail = summaries.findIndex((s) => s.failed > 0);
  if (firstFail < 0) return null;
  const attempts = window.length - 1 - firstFail;
  rs.fixAttempts = attempts;
  const node: RunNode = { id: `${rs.node.id}:fix`, label: 'Fix forward', status: 'pending' };
  const of = `of ${RUN_VIEW_FIX_ATTEMPTS}`;
  if (head.failed > 0) {
    if (attempts >= RUN_VIEW_FIX_ATTEMPTS) {
      node.status = 'failed';
      node.chip = { text: `attempt ${attempts} ${of}`, kind: 'loop' };
      node.error = `${RUN_VIEW_FIX_ATTEMPTS} fix attempts failed — it stops and asks you`;
      rs.fixExhausted = true;
    } else {
      node.chip = { text: `attempt ${attempts + 1} ${of}`, kind: 'loop' };
      node.status = workActive ? 'running' : 'pending';
      if (!workActive) node.detail = 'not started';
    }
  } else if (head.running > 0) {
    node.status = 'running';
    node.chip = { text: `attempt ${Math.max(1, attempts)} ${of}`, kind: 'loop' };
    node.detail = 'CI running on the fix';
  } else {
    node.status = 'passed';
    node.detail = `fixed in attempt ${Math.max(1, attempts)} ${of}`;
  }
  return node;
}

async function buildGate2Box(
  deps: RunViewDeps,
  vtid: string,
  services: Gate2Box['services'],
  since: string | null,
  unavailable: string[],
): Promise<Gate2Box> {
  const commits: Gate2Commit[] = [];
  let commitsUnavailable = false;
  for (const s of services) {
    if (!s.production_commit || !s.verified_commit) { commitsUnavailable = true; continue; }
    try {
      const list = await timeout(deps.commitsBetween(s.repo, s.production_commit, s.verified_commit));
      for (const c of list) commits.push({ sha: c.sha, message: services.length > 1 ? `[${s.service}] ${c.message}` : c.message, mine: c.message.includes(vtid) });
    } catch (e) {
      commitsUnavailable = true;
      unavailable.push(`${s.service} commits production→staging: ${errText(e)}`);
    }
  }
  return {
    question: 'Staging verified — ready for deployment to production?',
    since,
    services,
    commits,
    ...(commitsUnavailable ? { commits_unavailable: true } : {}),
    publish: services.map((s) => (s.service === 'gateway'
      ? { service: s.service, kind: 'publish_flow' as const }
      : { service: s.service, kind: 'link' as const, href: FRONTEND_PUBLISH_URL })),
  };
}

// ---------------------------------------------------------------------------
// Thread linking
// ---------------------------------------------------------------------------

export interface ThreadLinkDeps {
  loadThreadOwner(threadId: string): Promise<{ exists: boolean; user_id: string | null }>;
  loadThreadKiroVtids(threadId: string): Promise<Array<{ vtid: string; at: string }>>;
  loadThreadAssistantTexts(threadId: string): Promise<Array<{ content: string; at: string }>>;
  ledgerExisting(vtids: string[]): Promise<string[]>;
}

const VTID_IN_TEXT = /\bVTID-\d{5}\b/g;

/**
 * The VTIDs a thread works on, newest first (at most RUN_VIEW_MAX_THREAD_VTIDS):
 * `for_vtid` of the thread's operator.kiro.* events, then VTIDs the assistant named
 * in the thread ("VTID-xxxxx") that exist in the ledger.
 */
export async function linkedVtidsFor(deps: ThreadLinkDeps, threadId: string): Promise<string[]> {
  const [kiro, texts] = await Promise.all([deps.loadThreadKiroVtids(threadId), deps.loadThreadAssistantTexts(threadId)]);
  const seen = new Map<string, string>();
  for (const k of kiro) if (RUN_VIEW_VTID_RE.test(k.vtid) && (!seen.has(k.vtid) || seen.get(k.vtid)! < k.at)) seen.set(k.vtid, k.at);
  const mentioned = new Map<string, string>();
  for (const t of texts) {
    for (const m of t.content.match(VTID_IN_TEXT) || []) if (!seen.has(m) && (!mentioned.has(m) || mentioned.get(m)! < t.at)) mentioned.set(m, t.at);
  }
  let mentionedOk: string[] = [];
  if (mentioned.size) {
    const exist = new Set(await deps.ledgerExisting([...mentioned.keys()]));
    mentionedOk = [...mentioned.keys()].filter((v) => exist.has(v));
  }
  const all = [...seen.entries(), ...mentionedOk.map((v) => [v, mentioned.get(v)!] as [string, string])];
  return all.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([v]) => v).slice(0, RUN_VIEW_MAX_THREAD_VTIDS);
}

// ---------------------------------------------------------------------------
// Live dependencies (Supabase REST + GitHub + build-info), with caches for
// immutable answers (merged PR detail, completed check summaries, compares,
// commit ranges) and 30 s caches for shared moving ones (workflow runs,
// production commit).
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V): void { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
  clear(): void { this.m.clear(); }
}
const mergedPrCache = new Lru<PrDetail>(300);
const checkCache = new Lru<CheckSummary>(500);
const compareCache = new Lru<string>(500);
const rangeCache = new Lru<Array<{ sha: string; message: string }>>(50);
const shortCache = new Map<string, { at: number; value: unknown }>();

async function cachedShort<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = shortCache.get(key);
  if (hit && Date.now() - hit.at < RUN_VIEW_CACHE_MS) return hit.value as T;
  const value = await fn();
  shortCache.set(key, { at: Date.now(), value });
  return value;
}

function tokenFor(repo: string): string | undefined {
  return repoGitHubToken(repo as VitanaRepo);
}

async function rest<T>(path: string): Promise<T> {
  const s = getSupabase();
  if (!s) throw new Error('supabase not configured');
  const r = await supa<T>(s, path);
  if (!r.ok) throw new Error(r.error || `status ${r.status}`);
  return (r.data ?? ([] as unknown)) as T;
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

export function summarizeCheckRuns(runs: Array<Record<string, any>>): CheckSummary {
  let passed = 0; let failed = 0; let running = 0;
  let first: CheckSummary['first_failure'] = null;
  for (const r of runs) {
    if (r.status !== 'completed') { running++; continue; }
    if (FAILED_CONCLUSIONS.has(String(r.conclusion))) {
      failed++;
      if (!first) first = { name: String(r.name || 'check'), summary: r.output?.title ? String(r.output.title).slice(0, 200) : null, url: r.html_url ? String(r.html_url) : null };
    } else passed++;
  }
  return { total: runs.length, passed, failed, running, first_failure: first, url: null };
}

export function parseFrontendVersion(html: string): string | null {
  const m = /<meta name="vitana-app-version" content="([0-9a-f]{7,40})"/.exec(String(html || ''));
  return m ? m[1] : null;
}

export function liveRunViewDeps(): RunViewDeps {
  return {
    async loadLedger(vtid) {
      const rows = await rest<RunLedgerRow[]>(`/rest/v1/vtid_ledger?vtid=eq.${enc(vtid)}&select=vtid,title,status,is_terminal,created_at,metadata&limit=1`);
      return rows[0] ?? null;
    },
    async loadSparring(vtid) {
      const rows = await rest<Array<{ verdict: string; human_approved_at: string | null; created_at: string | null; rounds: unknown[] | null }>>(
        `/rest/v1/plan_sparring_sessions?vtid=eq.${enc(vtid)}&select=verdict,human_approved_at,created_at,rounds&order=created_at.desc&limit=1`,
      );
      const r = rows[0];
      return r ? { verdict: r.verdict, approved_at: r.human_approved_at, created_at: r.created_at, rounds: Array.isArray(r.rounds) ? r.rounds.length : 0 } : null;
    },
    async loadKiroEvents(vtid) {
      const rows = await rest<Array<{ topic: string; created_at: string; metadata: Record<string, any> | null }>>(
        `/rest/v1/oasis_events?topic=in.(operator.kiro.branch_pushed,operator.kiro.write_tool_called)&metadata->>for_vtid=eq.${enc(vtid)}&select=topic,created_at,metadata&order=created_at.desc&limit=100`,
      );
      return rows.map((r) => ({
        topic: r.topic,
        created_at: r.created_at,
        thread_id: typeof r.metadata?.thread_id === 'string' ? r.metadata.thread_id : null,
        repo: typeof r.metadata?.repo === 'string' ? r.metadata.repo : null,
        branch: typeof r.metadata?.branch === 'string' ? r.metadata.branch : null,
        commit_sha: typeof r.metadata?.commit_sha === 'string' ? r.metadata.commit_sha : null,
        files: typeof r.metadata?.files === 'number' ? r.metadata.files : null,
      }));
    },
    async loadKiroRuns(threadIds, since) {
      const ids = threadIds.filter((t) => RUN_VIEW_THREAD_RE.test(t)).slice(0, 10);
      if (!ids.length) return [];
      const runs = await rest<Array<{ id: string; thread_id: string; status: string; created_at: string; started_at: string | null; ended_at: string | null; error: string | null }>>(
        `/rest/v1/kiro_runs?thread_id=in.(${ids.map(enc).join(',')})${since ? `&created_at=gte.${enc(since)}` : ''}&select=id,thread_id,status,created_at,started_at,ended_at,error&order=created_at.desc&limit=10`,
      );
      if (!runs.length) return [];
      const ev = await rest<Array<{ run_id: string; seq: number; payload: Record<string, any> | null }>>(
        `/rest/v1/kiro_run_events?run_id=in.(${runs.map((r) => enc(r.id)).join(',')})&type=eq.kiro.tool_call&select=run_id,seq,payload&order=seq.desc&limit=2000`,
      );
      return runs.map((r) => {
        const mine = ev.filter((e) => e.run_id === r.id);
        const title = mine[0]?.payload?.title;
        return { ...r, tool_calls: mine.length, last_tool_title: typeof title === 'string' && title ? title.slice(0, 200) : null };
      });
    },
    async loadAutopilotExecution(vtid) {
      const recs = await rest<Array<{ id: string }>>(`/rest/v1/autopilot_recommendations?activated_vtid=eq.${enc(vtid)}&select=id&limit=5`);
      if (!recs.length) return null;
      const ex = await rest<AutopilotExec[]>(
        `/rest/v1/dev_autopilot_executions?finding_id=in.(${recs.map((r) => enc(r.id)).join(',')})&select=id,status,created_at,updated_at&order=created_at.desc&limit=1`,
      );
      return ex[0] ?? null;
    },
    searchPrs: (vtids) => searchPullRequests(vtids, RUN_VIEW_REPOS, { perPage: 30 }),
    async prDetail(repo, n, merged) {
      const key = `${repo}#${n}`;
      const hit = mergedPrCache.get(key);
      if (hit) return hit;
      const pr = (await getPullRequest(repo, n, tokenFor(repo))) as unknown as Record<string, any>;
      const d: PrDetail = {
        head_sha: pr.head?.sha ?? null, head_ref: pr.head?.ref ?? null, draft: !!pr.draft,
        merged_at: pr.merged_at ?? null, merge_commit_sha: pr.merged_at ? pr.merge_commit_sha ?? null : null, closed_at: pr.closed_at ?? null,
      };
      if (merged && d.merged_at) mergedPrCache.set(key, d);
      return d;
    },
    async prCommits(repo, n) {
      return (await getPullRequestCommits(repo, n, tokenFor(repo))).map((c) => c.sha);
    },
    async checkSummary(repo, sha) {
      const key = `${repo}@${sha}`;
      const hit = checkCache.get(key);
      if (hit) return hit;
      const r = await getCheckRuns(repo, sha, tokenFor(repo), { perPage: 100 });
      const s = summarizeCheckRuns((r.check_runs || []) as unknown as Array<Record<string, any>>);
      if (s.total > 0 && s.running === 0) checkCache.set(key, s);
      return s;
    },
    async loadVerifyEvents(vtid, commits) {
      const base = '/rest/v1/oasis_events?topic=in.(staging.verify.passed,staging.verify.failed,staging.verify.superseded)&select=topic,created_at,service,metadata&order=created_at.desc&limit=20';
      const byVtid = rest<Array<{ topic: string; created_at: string; service: string | null; metadata: Record<string, any> | null }>>(
        `${base}&metadata->vtids=cs.${enc(JSON.stringify([vtid]))}`,
      );
      const byCommit = commits.length
        ? rest<Array<{ topic: string; created_at: string; service: string | null; metadata: Record<string, any> | null }>>(`${base}&metadata->>commit=in.(${commits.map(enc).join(',')})`)
        : Promise.resolve([]);
      const rows = [...(await byVtid), ...(await byCommit)];
      const seen = new Set<string>();
      return rows.filter((r) => { const k = `${r.topic}|${r.created_at}|${r.service}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((r) => ({
        topic: r.topic,
        created_at: r.created_at,
        service: typeof r.metadata?.service === 'string' ? r.metadata.service : r.service,
        commit: typeof r.metadata?.commit === 'string' ? r.metadata.commit : null,
        production_commit: typeof r.metadata?.production_commit === 'string' ? r.metadata.production_commit : null,
        run_url: typeof r.metadata?.run_url === 'string' ? r.metadata.run_url : null,
        vtids: Array.isArray(r.metadata?.vtids) ? r.metadata!.vtids.map(String) : [],
        results: Array.isArray(r.metadata?.results) ? r.metadata!.results : [],
      }));
    },
    workflowRuns: (repo, workflow) => cachedShort(`wf:${repo}:${workflow}`, async () => {
      const r = await getWorkflowRuns(repo, workflow, tokenFor(repo));
      return (r.workflow_runs || []).map((w) => ({ id: w.id, status: w.status, conclusion: w.conclusion, html_url: w.html_url, created_at: w.created_at, head_sha: w.head_sha ?? null, head_branch: w.head_branch ?? null }));
    }),
    productionCommit: (service) => cachedShort(`prod:${service}`, async () => {
      if (service === 'gateway') {
        const res = await fetch(`${AWS_PROD_GATEWAY_URL}/api/v1/admin/build-info`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(RUN_VIEW_CALL_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { git_commit?: string };
        return typeof body.git_commit === 'string' ? body.git_commit : null;
      }
      // The public version stamp — the same read STAGING-VERIFY makes to list what would ship.
      const res = await fetch(`https://vitanaland.com/?operator-runs=${Date.now()}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(RUN_VIEW_CALL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseFrontendVersion(await res.text());
    }),
    async compare(repo, base, head) {
      const key = `${repo}:${base}...${head}`;
      const hit = compareCache.get(key);
      if (hit) return hit;
      const s = await compareStatus(repo, base, head, { tokenOverride: tokenFor(repo) });
      compareCache.set(key, s);
      return s;
    },
    async commitsBetween(repo, base, head) {
      const key = `${repo}:${base}...${head}`;
      const hit = rangeCache.get(key);
      if (hit) return hit;
      const list = (await getCommitsBetween(repo, base, head, 250, { files: false, tokenOverride: tokenFor(repo) })).map((c) => ({ sha: c.sha, message: c.message }));
      rangeCache.set(key, list);
      return list;
    },
    now: () => new Date(),
  };
}

export function liveThreadLinkDeps(): ThreadLinkDeps {
  return {
    async loadThreadOwner(threadId) {
      const rows = await rest<Array<{ user_id: string | null }>>(`/rest/v1/operator_threads?id=eq.${enc(threadId)}&select=user_id&limit=1`);
      return rows[0] ? { exists: true, user_id: rows[0].user_id } : { exists: false, user_id: null };
    },
    async loadThreadKiroVtids(threadId) {
      const rows = await rest<Array<{ created_at: string; metadata: Record<string, any> | null }>>(
        `/rest/v1/oasis_events?topic=in.(operator.kiro.branch_pushed,operator.kiro.write_tool_called)&metadata->>thread_id=eq.${enc(threadId)}&select=created_at,metadata&order=created_at.desc&limit=100`,
      );
      return rows.filter((r) => typeof r.metadata?.for_vtid === 'string').map((r) => ({ vtid: String(r.metadata!.for_vtid), at: r.created_at }));
    },
    async loadThreadAssistantTexts(threadId) {
      const rows = await rest<Array<{ content: string; created_at: string }>>(
        `/rest/v1/operator_messages?thread_id=eq.${enc(threadId)}&role=eq.assistant&select=content,created_at&order=created_at.desc&limit=50`,
      );
      return rows.map((r) => ({ content: String(r.content || ''), at: r.created_at }));
    },
    async ledgerExisting(vtids) {
      const ok = vtids.filter((v) => RUN_VIEW_VTID_RE.test(v));
      if (!ok.length) return [];
      const rows = await rest<Array<{ vtid: string }>>(`/rest/v1/vtid_ledger?vtid=in.(${ok.map(enc).join(',')})&select=vtid`);
      return rows.map((r) => r.vtid);
    },
  };
}

// ---------------------------------------------------------------------------
// Cached entry points (30 s per VTID, shared by all viewers)
// ---------------------------------------------------------------------------

let depsOverride: RunViewDeps | null = null;
let linkDepsOverride: ThreadLinkDeps | null = null;
/** Tests only. */
export function setRunViewDepsForTests(d: RunViewDeps | null, l: ThreadLinkDeps | null = null): void { depsOverride = d; linkDepsOverride = l; }
export function resetRunViewCaches(): void {
  viewCache.clear(); prHitsByVtid.clear(); searchCalls.length = 0; shortCache.clear();
  mergedPrCache.clear(); checkCache.clear(); compareCache.clear(); rangeCache.clear();
}
function deps(): RunViewDeps { return depsOverride ?? liveRunViewDeps(); }
function linkDeps(): ThreadLinkDeps { return linkDepsOverride ?? liveThreadLinkDeps(); }

export async function buildRunView(vtid: string, opts: { threadId?: string | null; fresh?: boolean } = {}): Promise<{ ok: true; view: RunView } | { ok: false; error: 'invalid_vtid' }> {
  if (!RUN_VIEW_VTID_RE.test(vtid)) return { ok: false, error: 'invalid_vtid' };
  const d = deps();
  const key = `${vtid}|${opts.threadId ?? ''}`;
  const now = d.now().getTime();
  const hit = viewCache.get(key);
  if (!opts.fresh && hit && now - hit.at < RUN_VIEW_CACHE_MS) return { ok: true, view: hit.view };
  const r = await buildRunViewWith(d, vtid, { threadId: opts.threadId ?? null });
  if (r.ok) viewCache.set(key, { at: now, view: r.view });
  return r;
}

export type ThreadRunsResult =
  | { ok: true; thread_id: string; vtids: string[]; views: RunView[]; unavailable: string[] }
  | { ok: false; error: 'invalid_thread' | 'forbidden' | 'unavailable' };

/** The thread's linked VTIDs and their views, with ONE GitHub search for all of them. */
export async function buildThreadRuns(threadId: string, userId: string | null): Promise<ThreadRunsResult> {
  if (!RUN_VIEW_THREAD_RE.test(threadId)) return { ok: false, error: 'invalid_thread' };
  const l = linkDeps();
  let owner: { exists: boolean; user_id: string | null };
  try { owner = await timeout(l.loadThreadOwner(threadId)); }
  catch { return { ok: false, error: 'unavailable' }; }
  if (owner.exists && owner.user_id && owner.user_id !== userId) return { ok: false, error: 'forbidden' };
  let vtids: string[];
  try { vtids = await timeout(linkedVtidsFor(l, threadId)); }
  catch { return { ok: false, error: 'unavailable' }; }
  if (vtids.length === 0) return { ok: true, thread_id: threadId, vtids: [], views: [], unavailable: [] };

  const d = deps();
  const now = d.now().getTime();
  const views: RunView[] = [];
  const unavailable: string[] = [];
  const toBuild: string[] = [];
  for (const v of vtids) {
    const hit = viewCache.get(`${v}|${threadId}`);
    if (hit && now - hit.at < RUN_VIEW_CACHE_MS) views.push(hit.view); else toBuild.push(v);
  }
  if (toBuild.length) {
    const prs = await prHitsFor(d, toBuild, now);
    const built = await Promise.all(toBuild.map((v) => buildRunViewWith(d, v, {
      threadId,
      prHits: { hits: prs.hits.get(v) ?? null, stale: prs.stale.has(v), error: prs.failed.get(v) ?? null },
    })));
    for (const b of built) if (b.ok) { viewCache.set(`${b.view.vtid}|${threadId}`, { at: now, view: b.view }); views.push(b.view); }
  }
  views.sort((a, b) => vtids.indexOf(a.vtid) - vtids.indexOf(b.vtid));
  return { ok: true, thread_id: threadId, vtids, views, unavailable };
}

// ---------------------------------------------------------------------------
// Live follow (the SSE route's loop)
// ---------------------------------------------------------------------------

/** The part of a view whose change is worth a resend (not `generated_at`). */
export function viewFingerprint(v: RunView): string {
  return JSON.stringify({ ...v, generated_at: undefined });
}

export function nextPollMs(v: RunView): number {
  const running = (nodes: RunNode[]): boolean => nodes.some((n) => n.status === 'running' || running(n.children || []));
  return running(v.nodes) ? RUN_VIEW_STREAM.runningMs : RUN_VIEW_STREAM.idleMs;
}

export interface FollowClock { sleep(ms: number): Promise<void>; now(): number }
const realClock: FollowClock = {
  sleep: (ms) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
  now: () => Date.now(),
};
let clock: FollowClock = realClock;
/** Tests only. */
export function setRunViewClockForTests(c: FollowClock | null): void { clock = c ?? realClock; }

/**
 * Send the view, then re-send it only when it changed: every 15 s while a node
 * runs, every 60 s otherwise. Ends 60 s after the view turns terminal, after 2 h,
 * or when the listener goes away (`isClosed`).
 */
export async function followRunView(
  vtid: string,
  threadId: string | null,
  onView: (v: RunView) => void,
  isClosed: () => boolean,
): Promise<'terminal' | 'max_time' | 'closed' | 'invalid'> {
  const started = clock.now();
  let last: string | null = null;
  let terminalAt: number | null = null;
  for (;;) {
    if (isClosed()) return 'closed';
    const r = await buildRunView(vtid, { threadId });
    if (!r.ok) return 'invalid';
    const fp = viewFingerprint(r.view);
    if (fp !== last && !isClosed()) { last = fp; onView(r.view); }
    if (r.view.terminal && terminalAt === null) terminalAt = clock.now();
    if (!r.view.terminal) terminalAt = null;
    const t = clock.now();
    if (terminalAt !== null && t - terminalAt >= RUN_VIEW_STREAM.terminalGraceMs) return 'terminal';
    if (t - started >= RUN_VIEW_STREAM.maxMs) return 'max_time';
    const wait = terminalAt !== null ? Math.min(RUN_VIEW_STREAM.terminalGraceMs, nextPollMs(r.view)) : nextPollMs(r.view);
    await clock.sleep(wait);
  }
}
