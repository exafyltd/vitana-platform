/**
 * VTID-05078 (Dev Autopilot autonomy, Phase B): the planner reads both
 * repositories and the codebase index instead of one pre-fetched file.
 *
 * Tools (all read-only):
 *   read_file / list_dir / search — the plan-sparring partner's GitHub tools
 *     (plan-sparring/github-tools.ts), repos exafyltd/vitana-platform and
 *     exafyltd/vitana-v1, every read pinned to that repo's `main` commit at
 *     the start of the plan.
 *   dev_index_query / dev_graph_path / dev_get_risk — the VTID-04229 codebase
 *     index (codeintel-index.ts), both repos (a repo with no published bundle
 *     answers "not indexed" as a tool error, never a failure of the plan).
 *
 * Credential: PLAN_SPARRING_GITHUB_TOKEN only (contents:read + metadata:read).
 * Never GITHUB_SAFE_MERGE_TOKEN: the planner model must not hold a credential
 * that can push or merge. With no such token the tools are OFF and the planner
 * works exactly as before (one pre-fetched file) — no failure.
 *
 * Also here: plan-path validation (plan B3). Every path in "Files to modify"
 * must exist at main or be marked new, and must not be in the effective deny
 * scope. A path written as `exafyltd/vitana-v1:<path>` is a change in the
 * community app, which the executor cannot make (plan B4): such a plan goes to
 * the human queue.
 */

import {
  PARTNER_CODE_TOOLS,
  PLAN_SPARRING_REPOS,
  createCodeToolExecutor,
  planSparringGithubToken,
  type FetchLike,
} from '../plan-sparring/github-tools';
import {
  codeIndexRouterTools,
  isCodeIndexToolName,
  loadCodeIndex,
  runCodeIndexTool,
  type LoadedCodeIndex,
} from '../codeintel-index';
import { isDeniedPath } from '../dev-autopilot-safety';
import type { LLMRouterTool } from '../llm-router';
import type { StageToolOutcome } from '../llm-stage-tool-loop';

/** Plan B2: the exploration budget per plan (the 2026-04 unbounded attempt timed out). */
export const PLANNER_MAX_TOOL_CALLS = 12;
export const PLANNER_DEADLINE_MS = 90_000;
export const PLANNER_MAX_TURNS = 14;

/** Prefix a "Files to modify" line uses for a change in the community app. */
export const COMMUNITY_APP_PATH_PREFIX = 'exafyltd/vitana-v1:';

/**
 * Tools are on when the read-only token exists, unless switched off with
 * DEV_PLANNER_TOOLS_ENABLED=false (exact string) for a controlled rollback.
 */
export function plannerToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.DEV_PLANNER_TOOLS_ENABLED || '').trim() === 'false') return false;
  const t = (env.PLAN_SPARRING_GITHUB_TOKEN || '').trim();
  return t.length > 0;
}

/** The planner's tool list in the router's provider-neutral shape. */
export function plannerRouterTools(): LLMRouterTool[] {
  return [...PARTNER_CODE_TOOLS, ...codeIndexRouterTools()];
}

/**
 * Each repo's `main` commit, read once at the start of a plan so every tool
 * call in that plan sees the same snapshot. A repo whose ref cannot be read is
 * left out — its file tools then answer "no pinned ref" (an honest tool error).
 */
export async function resolveMainRefs(opts: { token?: string; fetchImpl?: FetchLike } = {}): Promise<Record<string, string>> {
  const token = opts.token ?? planSparringGithubToken();
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
  const refs: Record<string, string> = {};
  if (!token) return refs;
  await Promise.all(PLAN_SPARRING_REPOS.map(async (repo) => {
    try {
      const resp = await doFetch(`https://api.github.com/repos/${repo}/commits/main`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'vitana-dev-autopilot-planner',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!resp.ok) return;
      const body = (await resp.json()) as { sha?: string };
      if (typeof body?.sha === 'string' && /^[0-9a-f]{40}$/i.test(body.sha)) refs[repo] = body.sha;
    } catch {
      /* left out: the tools report it */
    }
  }));
  return refs;
}

/** Routes one planner tool call to the GitHub tools or the code index. Never throws. */
export function createPlannerToolExecutor(opts: {
  refs: Record<string, string>;
  token?: string;
  fetchImpl?: FetchLike;
  loadIndex?: (repo: string) => Promise<LoadedCodeIndex>;
}): (name: string, args: Record<string, unknown>) => Promise<StageToolOutcome> {
  const github = createCodeToolExecutor({ refs: opts.refs, token: opts.token, fetchImpl: opts.fetchImpl });
  const loadIndex = opts.loadIndex ?? ((repo: string) => loadCodeIndex(repo));
  return async (name, args) => {
    if (isCodeIndexToolName(name)) {
      const repo = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : 'exafyltd/vitana-platform';
      try {
        const loaded = await loadIndex(repo);
        const out = runCodeIndexTool(name, args, loaded.bundle);
        return { result: out.text, isError: !out.ok };
      } catch (err) {
        return { result: `code index not available for ${repo}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
    const r = await github(name, args);
    return { result: r.result, isError: r.isError };
  };
}

// ---------------------------------------------------------------- plan paths (B3/B4)

export interface PlanPathEntry {
  path: string;
  isNew: boolean;
  communityApp: boolean;
}

/**
 * The "Files to modify" entries with their markers. A line marked "(new)" or
 * "new file" declares a file that does not exist yet. Pure.
 */
export function readPlanPathEntries(planMarkdown: string): PlanPathEntry[] {
  const section = planMarkdown.match(/##\s*Files\s*[- ]\s*to\s*[- ]\s*(?:modify|touch|change|edit)[\s\S]+?(?=\n##\s|$)/i);
  if (!section) return [];
  const out: PlanPathEntry[] = [];
  const seen = new Set<string>();
  for (const line of section[0].split('\n').slice(1)) {
    const m = line.match(/((?:exafyltd\/vitana-v1:)?[a-zA-Z0-9_.\-][a-zA-Z0-9_./\-]*\.(?:tsx|ts|jsx|js|mjs|cjs|sql|yaml|yml|json|md|css|html))(?![a-zA-Z0-9])/);
    if (!m || !m[1].includes('/')) continue;
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const communityApp = raw.startsWith(COMMUNITY_APP_PATH_PREFIX);
    out.push({
      path: communityApp ? raw.slice(COMMUNITY_APP_PATH_PREFIX.length) : raw,
      isNew: /\(new\)|\bnew file\b/i.test(line),
      communityApp,
    });
  }
  return out;
}

export interface PlanPathCheck {
  ok: boolean;
  /** The plan changes the community app: route to the human queue (B4). */
  communityApp: boolean;
  problems: string[];
}

/**
 * B3: every platform path must exist at main or be marked new, and must not be
 * denied. `exists` answers for exafyltd/vitana-platform at main. Pure apart
 * from `exists`.
 */
export async function checkPlanPaths(
  entries: PlanPathEntry[],
  opts: { deny: string[]; exists: (path: string) => Promise<boolean | null> },
): Promise<PlanPathCheck> {
  const problems: string[] = [];
  const communityApp = entries.some((e) => e.communityApp);
  for (const e of entries) {
    if (e.communityApp) continue;
    if (isDeniedPath(e.path, opts.deny, { isNewFile: e.isNew })) {
      problems.push(`${e.path} is in the deny scope — the autopilot may not change it`);
      continue;
    }
    if (e.isNew) {
      const there = await opts.exists(e.path);
      if (there === true) problems.push(`${e.path} is marked new but already exists at main`);
      continue;
    }
    const there = await opts.exists(e.path);
    if (there === false) problems.push(`${e.path} does not exist at main (mark it "(new)" if the plan creates it)`);
  }
  return { ok: problems.length === 0, communityApp, problems };
}

/** The one revision round's feedback (B3). */
export function pathFeedback(problems: string[]): string {
  return [
    'Path validation rejected your previous plan:',
    ...problems.map((p) => `- ${p}`),
    'Fix every listed path. Check paths with read_file/list_dir when the tools are available.',
    'Mark a file the plan creates with "(new)" on its line in "Files to modify".',
  ].join('\n');
}

/** The prompt block that replaces "do not ask to see other files" when the tools are on. */
export function plannerToolsPromptBlock(): string {
  return [
    `## Your tools (read-only)`,
    `You can read code before you plan: read_file, list_dir and search on`,
    `exafyltd/vitana-platform and exafyltd/vitana-v1 (pinned to main), and`,
    `dev_index_query / dev_graph_path / dev_get_risk on the codebase index.`,
    `Budget: at most ${PLANNER_MAX_TOOL_CALLS} tool calls; then write the plan with what you have.`,
    `Use them to confirm every path you cite, to find the callers and the`,
    `existing tests of what you change, and to follow existing patterns.`,
    `Large files (for example the Command Hub app.js) must be read by line range.`,
    ``,
    `Path rules for "Files to modify":`,
    `- one repo-relative path per line, in exafyltd/vitana-platform;`,
    `- mark a file the plan creates with "(new)" on its line;`,
    `- a change in the community app is written as ${COMMUNITY_APP_PATH_PREFIX}<path> — such a plan`,
    `  is handed to a human (the autopilot only changes vitana-platform).`,
    ``,
  ].join('\n');
}
