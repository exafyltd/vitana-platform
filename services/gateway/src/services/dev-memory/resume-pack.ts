/**
 * VTID-05060 — the resume pack: where one VTID stands, for whoever picks it up.
 *
 * A conversation cannot move between tools (Claude Code, Kiro IDE, the
 * Command Hub Operator), but what a session leaves behind can: the ledger
 * row, the PRs and their bodies, the evidence under docs/validation/<VTID>/,
 * handoff notes in dev_agent_memory, and whether the merge commit is on
 * staging and production. This builds one read-only start prompt from them.
 *
 * Read-only. Every section fails open to `unavailable` with the reason, as
 * morning-pack.ts does, so a slow GitHub or table never blocks a start.
 * GitHub budget per pack: 1 search + 1 PR read + 2 evidence files + 2
 * compares = 6 calls, 8s each. Built packs are cached 60s per VTID.
 *
 * Admin-facing, English by design: the reader is an engineer or an agent.
 */

import { getSupabase, supa } from '../dev-autopilot-execute';
import { searchPullRequests, compareStatus, getFileContents, getPullRequest, type GitHubPrSearchHit } from '../github-service';
import { AWS_STAGING_GATEWAY_URL, AWS_PROD_GATEWAY_URL } from '../aws-gateway-admin';

export const VTID_RE = /^VTID-\d{5}$/;
export const RESUME_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
export const RESUME_TEXT_MAX_CHARS = 8_000;
export const RESUME_PR_BODY_CHARS = 1_500;
export const RESUME_FILE_CHARS = 1_500;
export const RESUME_CALL_TIMEOUT_MS = 8_000;
export const RESUME_CACHE_MS = 60_000;
export const RESUME_MEMORY_LIMIT = 5;

/** Separate from `text` on purpose: the shell script prints it, the Operator tool leaves it out. */
export const RESUME_INSTRUCTIONS = [
  'You are continuing an existing VTID. Do not allocate a new VTID for this work.',
  "Follow this repository's standing rules (CLAUDE.md): plan sparring for any new plan, never test against production, never write as the test account.",
  'Production is reached only after STAGING-VERIFY passes on the exact commit and the owner answers yes to Gate 2.',
].join('\n');

export interface ResumeLedgerRow {
  vtid: string;
  title: string | null;
  summary: string | null;
  status: string | null;
  spec_status: string | null;
  is_terminal: boolean | null;
  metadata: Record<string, unknown> | null;
}

export interface ResumePr {
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  url: string;
  body: string;
  head_branch?: string | null;
  merge_commit?: string | null;
}

export interface ResumeDeploy {
  env: 'staging' | 'production';
  commit: string | null;
  /** true/false = the newest merged PR's merge commit is/isn't in this env; null = unknown. */
  contains_merge: boolean | null;
}

export interface ResumeMemoryRow {
  category: string;
  title: string | null;
  content: string;
  created_at: string;
}

export interface ResumePack {
  vtid: string;
  generated_at: string;
  ledger: ResumeLedgerRow;
  prs: ResumePr[];
  evidence: { acceptance: string | null; plan: string | null };
  memory: ResumeMemoryRow[];
  deploy: ResumeDeploy[];
  unavailable: string[];
  text: string;
  instructions: string;
}

export interface ResumeDeps {
  loadLedger(vtid: string): Promise<{ ok: true; row: ResumeLedgerRow | null } | { ok: false; error: string }>;
  loadMemory(vtid: string): Promise<ResumeMemoryRow[]>;
  searchPrs(vtid: string): Promise<GitHubPrSearchHit[]>;
  prDetail(repo: string, n: number): Promise<{ head_branch: string | null; merge_commit: string | null }>;
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  buildInfoCommit(env: 'staging' | 'production'): Promise<string | null>;
  compare(repo: string, base: string, head: string): Promise<string>;
  now(): Date;
}

function timeout<T>(p: Promise<T>, ms = RESUME_CALL_TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms).unref?.())]);
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 80);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 12)}\n…[clipped]` : s;
}

/** The text between the plan markers of a plan-sparring.md, else the file head. */
export function planBlock(md: string): string {
  const a = md.indexOf('<!-- plan:begin -->');
  const b = md.indexOf('<!-- plan:end -->');
  return a >= 0 && b > a ? md.slice(a + '<!-- plan:begin -->'.length, b).trim() : md;
}

/** compare(base=commit, head=deployed): `ahead`/`identical` = the deployed commit contains it. */
export function containsFromCompare(status: string): boolean | null {
  if (status === 'ahead' || status === 'identical') return true;
  if (status === 'behind' || status === 'diverged') return false;
  return null;
}

export function renderResumePack(p: Omit<ResumePack, 'text' | 'instructions'>): string {
  const out: string[] = [];
  const l = p.ledger;
  out.push(`# Resume ${p.vtid} — ${l.title ?? '(no title)'}`);
  out.push(`Ledger: status=${l.status ?? '?'} spec_status=${l.spec_status ?? '?'} terminal=${l.is_terminal ? 'yes' : 'no'}`);
  if (l.summary) out.push(`Summary: ${l.summary}`);
  const md = l.metadata || {};
  if (md.plan_hash || md.sparring_record) out.push(`Plan: hash=${md.plan_hash ?? '?'} record=${md.sparring_record ?? `docs/validation/${p.vtid}/plan-sparring.md`}`);
  out.push('', '## Pull requests');
  if (!p.prs.length) out.push('- none found');
  for (const pr of p.prs) {
    const state = pr.merged ? 'merged' : pr.state;
    out.push(`- ${pr.repo}#${pr.number} [${state}] ${pr.title} — ${pr.url}${pr.head_branch ? ` (branch ${pr.head_branch})` : ''}${pr.merge_commit ? ` (merge ${pr.merge_commit.slice(0, 8)})` : ''}`);
  }
  const open = p.prs.find((x) => x.state === 'open') || p.prs[0];
  if (open?.body) out.push('', `## PR body (${open.repo}#${open.number}, first ${RESUME_PR_BODY_CHARS} chars)`, open.body.slice(0, RESUME_PR_BODY_CHARS));
  out.push('', '## Deploy state');
  for (const d of p.deploy) {
    const has = d.contains_merge === null ? 'unknown' : d.contains_merge ? 'yes' : 'no';
    out.push(`- ${d.env}: ${d.commit ? d.commit.slice(0, 8) : 'unknown'} — contains the merge commit: ${has}`);
  }
  if (p.evidence.acceptance) out.push('', '## acceptance.md', p.evidence.acceptance);
  if (p.evidence.plan) out.push('', '## Approved plan (plan-sparring.md)', p.evidence.plan);
  if (p.memory.length) {
    out.push('', '## Handoff notes and knowledge');
    for (const m of p.memory) out.push(`- [${m.category}] ${m.title ? `${m.title}: ` : ''}${m.content.slice(0, 500)}`);
  }
  if (p.unavailable.length) out.push('', `(unavailable: ${p.unavailable.join('; ')})`);
  return clip(out.join('\n'), RESUME_TEXT_MAX_CHARS);
}

export async function buildResumePackWith(
  deps: ResumeDeps,
  vtid: string,
): Promise<{ ok: true; pack: ResumePack } | { ok: false; error: 'invalid_vtid' | 'not_found' | 'unavailable' }> {
  if (!VTID_RE.test(vtid)) return { ok: false, error: 'invalid_vtid' };
  const ledger = await deps.loadLedger(vtid).catch((e) => ({ ok: false as const, error: errText(e) }));
  if (!ledger.ok) return { ok: false, error: 'unavailable' };
  if (!ledger.row) return { ok: false, error: 'not_found' };

  const unavailable: string[] = [];
  const [hits, memory, stagingCommit, prodCommit] = await Promise.all([
    timeout(deps.searchPrs(vtid)).catch((e) => { unavailable.push(`prs: ${errText(e)}`); return [] as GitHubPrSearchHit[]; }),
    deps.loadMemory(vtid).catch((e) => { unavailable.push(`memory: ${errText(e)}`); return [] as ResumeMemoryRow[]; }),
    timeout(deps.buildInfoCommit('staging')).catch((e) => { unavailable.push(`staging build-info: ${errText(e)}`); return null; }),
    timeout(deps.buildInfoCommit('production')).catch((e) => { unavailable.push(`production build-info: ${errText(e)}`); return null; }),
  ]);

  const prs: ResumePr[] = hits.map((h) => ({ repo: h.repo, number: h.number, title: h.title, state: h.state, merged: h.merged, url: h.html_url, body: h.body.slice(0, RESUME_PR_BODY_CHARS) }));
  // One PR read: the open PR (for its branch) or else the newest merged one (for its merge commit).
  const focus = prs.find((x) => x.state === 'open') || prs.find((x) => x.merged) || null;
  if (focus) {
    try {
      const d = await timeout(deps.prDetail(focus.repo, focus.number));
      focus.head_branch = d.head_branch;
      focus.merge_commit = focus.merged ? d.merge_commit : null;
    } catch (e) { unavailable.push(`pr detail: ${errText(e)}`); }
  }

  // Evidence lives in the repo of the focus PR; main once merged, else the PR's branch.
  const evRepo = focus?.repo ?? RESUME_REPOS[0];
  const evRef = focus && !focus.merged && focus.head_branch ? focus.head_branch : 'main';
  const [acceptance, plan] = await Promise.all([
    timeout(deps.readFile(evRepo, `docs/validation/${vtid}/acceptance.md`, evRef)).catch((e) => { unavailable.push(`acceptance.md: ${errText(e)}`); return null; }),
    timeout(deps.readFile(evRepo, `docs/validation/${vtid}/plan-sparring.md`, evRef)).catch((e) => { unavailable.push(`plan-sparring.md: ${errText(e)}`); return null; }),
  ]);

  const merge = focus?.merged ? focus.merge_commit ?? null : null;
  const deploy: ResumeDeploy[] = [];
  for (const [env, commit] of [['staging', stagingCommit], ['production', prodCommit]] as const) {
    let contains: boolean | null = null;
    // Only the gateway's build-info is read, so only a vitana-platform merge can be placed.
    if (merge && commit && focus?.repo === RESUME_REPOS[0]) {
      try { contains = containsFromCompare(await timeout(deps.compare(focus.repo, merge, commit))); }
      catch (e) { unavailable.push(`${env} compare: ${errText(e)}`); }
    }
    deploy.push({ env, commit, contains_merge: contains });
  }

  const base = {
    vtid,
    generated_at: deps.now().toISOString(),
    ledger: ledger.row,
    prs,
    evidence: {
      acceptance: acceptance ? clip(acceptance, RESUME_FILE_CHARS) : null,
      plan: plan ? clip(planBlock(plan), RESUME_FILE_CHARS) : null,
    },
    memory,
    deploy,
    unavailable,
  };
  return { ok: true, pack: { ...base, text: renderResumePack(base), instructions: RESUME_INSTRUCTIONS } };
}

/** The live dependencies: Supabase REST, the GitHub API (GITHUB_SAFE_MERGE_TOKEN) and the gateways' build-info. */
export function liveResumeDeps(): ResumeDeps {
  return {
    async loadLedger(vtid) {
      const s = getSupabase();
      if (!s) return { ok: false, error: 'supabase not configured' };
      const r = await supa<ResumeLedgerRow[]>(s, `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=vtid,title,summary,status,spec_status,is_terminal,metadata&limit=1`);
      if (!r.ok) return { ok: false, error: r.error || `status ${r.status}` };
      return { ok: true, row: r.data && r.data[0] ? r.data[0] : null };
    },
    async loadMemory(vtid) {
      const s = getSupabase();
      if (!s) throw new Error('supabase not configured');
      const r = await supa<ResumeMemoryRow[]>(s, `/rest/v1/dev_agent_memory?vtid=eq.${encodeURIComponent(vtid)}&superseded_by=is.null&select=category,title,content,created_at&order=created_at.desc&limit=${RESUME_MEMORY_LIMIT}`);
      if (!r.ok) throw new Error(r.error || `status ${r.status}`);
      return r.data || [];
    },
    searchPrs: (vtid) => searchPullRequests(vtid, RESUME_REPOS),
    async prDetail(repo, n) {
      const pr = (await getPullRequest(repo, n)) as unknown as { head?: { ref?: string }; merge_commit_sha?: string | null };
      return { head_branch: pr.head?.ref ?? null, merge_commit: pr.merge_commit_sha ?? null };
    },
    async readFile(repo, path, ref) {
      try {
        const f = await getFileContents(repo, path, ref);
        return f.type === 'file' ? f.content : null;
      } catch (e) {
        if (/404|Not Found/i.test(errText(e))) return null;
        throw e;
      }
    },
    async buildInfoCommit(env) {
      const base = env === 'staging' ? AWS_STAGING_GATEWAY_URL : AWS_PROD_GATEWAY_URL;
      const res = await fetch(`${base}/api/v1/admin/build-info`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(RESUME_CALL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { git_commit?: string };
      return typeof body.git_commit === 'string' ? body.git_commit : null;
    },
    compare: (repo, base, head) => compareStatus(repo, base, head),
    now: () => new Date(),
  };
}

const cache = new Map<string, { at: number; pack: ResumePack }>();

export async function buildResumePack(vtid: string, deps: ResumeDeps = liveResumeDeps()) {
  const hit = cache.get(vtid);
  const now = deps.now().getTime();
  if (hit && now - hit.at < RESUME_CACHE_MS) return { ok: true as const, pack: hit.pack };
  const r = await buildResumePackWith(deps, vtid);
  if (r.ok) cache.set(vtid, { at: now, pack: r.pack });
  return r;
}

export function clearResumePackCache(): void { cache.clear(); }
