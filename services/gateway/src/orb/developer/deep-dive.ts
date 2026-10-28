/**
 * VTID-04563 — the developer Vitana's deep-dive engine.
 *
 * Some questions cannot be answered from the opening snapshot or one tool
 * call: "why did the executor revert PR 3543", "where does the Serbian
 * greeting come from and what changed there last week", "what happens
 * between tapping My Journey and the first spoken word". The deep dive is an
 * investigator that reads the code, the history, the rows, the logs and the
 * live endpoints until it can answer with evidence, then returns FINDINGS to
 * the voice assistant (or the Operator Console), which says them in its own
 * words.
 *
 * It runs as a `delegate_to_agent` target (async job: the voice turn gets a
 * job id at once, the answer arrives on a later turn), on the `planner`
 * stage (Bedrock Opus 4.5 under the routing policy) through the shared
 * bounded stage loop. Every tool is read-only:
 *
 *   codebase     dev_index_query, dev_graph_path, dev_get_risk (the S3 index,
 *                both repos), read_repo_file (GitHub contents, main)
 *   history      dev_git_history (commits touching a path)
 *   runtime      dev_probe_endpoint (GET only, allow-listed hosts and paths,
 *                labelled staging/production), dev_system_status
 *   data/logs    query_oasis_events, dev_cloudwatch_logs, dev_ecs_tasks,
 *                dev_run_sql_readonly, get_architecture_reports (the
 *                self-healing triage tools, same switches and gates)
 *   screens      dev_screen_trace (screen registry → route → component)
 *   map          dev_domain_atlas
 *
 * Only developer callers on the Command Hub reach it (dispatcher surface
 * check + the role check in `runDeepDive`).
 */
import type { LLMRouterTool, LLMStage } from '../../services/llm-router';
import { runStageToolLoop, type StageToolLoopResult, type StageToolOutcome } from '../../services/llm-stage-tool-loop';
import type { DelegationCaller, DelegationOutcome, DelegationTarget } from '../../services/orchestrator/dispatcher';
import { DOMAIN_ATLAS, findDomain, renderAtlasDomain, renderAtlasIndex } from './domain-atlas';

export const DEEP_DIVE_AGENT_ID = 'deep_dive';
export const DEEP_DIVE_SERVICE = 'developer-deep-dive';
export const DEEP_DIVE_STAGE: LLMStage = 'planner';
export const DEEP_DIVE_MAX_TURNS = 10;
export const DEEP_DIVE_MAX_TOOL_CALLS = 12;
export const DEEP_DIVE_DEADLINE_MS = 150_000;
export const DEEP_DIVE_FINDINGS_MAX_CHARS = 4_000;
export const DEEP_DIVE_FILE_MAX_LINES = 300;
export const DEEP_DIVE_PROBE_MAX_CHARS = 3_000;

const DEVELOPER_ROLES = new Set(['developer', 'admin', 'infra', 'exafy_admin']);
const REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
type Repo = (typeof REPOS)[number];

/** GET-only probe targets. Production is read, never written. */
export const PROBE_HOSTS: Record<'staging' | 'production', string> = {
  staging: 'https://preview-aws-gateway.vitanaland.com',
  production: 'https://gateway.vitanaland.com',
};
const PROBE_PATH = /^\/(alive|api\/v1\/[A-Za-z0-9_\-./]*)(\?[A-Za-z0-9_\-=&.%]*)?$/;

export const DEEP_DIVE_SYSTEM_PROMPT = [
  'You are the Vitanaland deep-dive investigator. The developer\'s assistant asked you a question that needs a real investigation across code, history, data and runtime.',
  'Work like a senior engineer: locate the relevant code with the index first, read only what you need, check history when the question is "what changed", check runtime (events, logs, endpoints, rows) when the question is "what is happening".',
  'Reply with FINDINGS for the assistant, not a speech:',
  '- Answer first, in 1-3 sentences.',
  '- Then the evidence: each point names its source (file:line, commit, table, event topic, endpoint + environment) and, for runtime facts, when it was observed.',
  '- Then what you could not verify, and the next check you would run.',
  'Never invent a file, a line, a commit, a number or a cause; if the tools did not show it, say it is unverified. Production is read-only and only through the probe tool.',
].join('\n');

export interface DeepDiveDeps {
  runLoop: typeof runStageToolLoop;
  indexTool: (name: string, args: Record<string, unknown>) => Promise<StageToolOutcome>;
  readRepoFile: (repo: Repo, path: string) => Promise<string>;
  gitHistory: (repo: Repo, path: string, limit: number) => Promise<Array<{ sha: string; date: string; author: string; message: string }>>;
  fetchImpl: typeof fetch;
  triageTool: (name: string, args: Record<string, unknown>) => Promise<StageToolOutcome>;
  systemStatus: () => Promise<string>;
  emit: (ok: boolean, payload: Record<string, unknown>) => void;
  now: () => number;
}

function prop(type: string, description: string): Record<string, unknown> {
  return { type, description };
}

export const DEEP_DIVE_LOCAL_TOOLS: LLMRouterTool[] = [
  {
    name: 'read_repo_file',
    description: 'Read a file from main of exafyltd/vitana-platform or exafyltd/vitana-v1, numbered; pass start_line/end_line for a window (max 300 lines per call).',
    inputSchema: { type: 'object', properties: { repo: prop('string', 'exafyltd/vitana-platform (default) or exafyltd/vitana-v1'), path: prop('string', 'Repo-root-relative path'), start_line: prop('integer', '1-based'), end_line: prop('integer', 'inclusive') }, required: ['path'] },
  },
  {
    name: 'dev_git_history',
    description: 'Recent commits on main that touched a path (file or directory): sha, date, author, first line of the message.',
    inputSchema: { type: 'object', properties: { repo: prop('string', 'exafyltd/vitana-platform (default) or exafyltd/vitana-v1'), path: prop('string', 'Repo-root-relative path'), limit: prop('integer', 'Max commits (default 10, max 30)') }, required: ['path'] },
  },
  {
    name: 'dev_probe_endpoint',
    description: 'GET one gateway endpoint on staging or production (read-only, no credentials): status, content type, latency and the first 3000 characters of the body. Only /alive and /api/v1/* paths.',
    inputSchema: { type: 'object', properties: { env: prop('string', 'staging (default) or production'), path: prop('string', 'e.g. /api/v1/admin/build-info') }, required: ['path'] },
  },
  {
    name: 'dev_screen_trace',
    description: 'Trace a community-app screen: find it in the screen registry by id, route or title, then the route line and page component in App.tsx. Follow up with dev_index_query (repo exafyltd/vitana-v1) on the component.',
    inputSchema: { type: 'object', properties: { screen: prop('string', 'Screen id, route or title, e.g. "/ai/companion" or "Memory Garden"') }, required: ['screen'] },
  },
  {
    name: 'dev_domain_atlas',
    description: 'The map of the system: with no domain the index; with a domain or topic its code, tables, flags and docs.',
    inputSchema: { type: 'object', properties: { domain: prop('string', 'Domain key or topic') } },
  },
  {
    name: 'dev_system_status',
    description: 'Live system snapshot: builds per stack, Dev Autopilot state, last hour of errors.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function repoOf(v: unknown): Repo {
  return v === 'exafyltd/vitana-v1' ? 'exafyltd/vitana-v1' : 'exafyltd/vitana-platform';
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

export function numberedWindow(content: string, start?: unknown, end?: unknown): string {
  const lines = content.split('\n');
  const s = Math.max(1, Number.isFinite(Number(start)) && Number(start) > 0 ? Math.floor(Number(start)) : 1);
  const eReq = Number.isFinite(Number(end)) && Number(end) >= s ? Math.floor(Number(end)) : s + DEEP_DIVE_FILE_MAX_LINES - 1;
  const e = Math.min(lines.length, eReq, s + DEEP_DIVE_FILE_MAX_LINES - 1);
  const out = [];
  for (let i = s; i <= e; i++) out.push(`${i}\t${lines[i - 1]}`);
  const more = e < lines.length ? `\n…(${lines.length} lines total; next window starts at ${e + 1})` : '';
  return out.join('\n') + more;
}

/** Validate a probe request. Returns the URL, or an error for the model. */
export function probeUrl(envArg: unknown, pathArg: unknown): { ok: true; url: string; env: 'staging' | 'production' } | { ok: false; error: string } {
  const env = envArg === 'production' ? 'production' : 'staging';
  const path = typeof pathArg === 'string' ? pathArg.trim() : '';
  if (!PROBE_PATH.test(path) || path.includes('..')) return { ok: false, error: 'path must be /alive or /api/v1/... (no "..", simple query only)' };
  return { ok: true, url: `${PROBE_HOSTS[env]}${path}`, env };
}

interface ScreenEntry { id: string; route: string; i18n?: Record<string, { title?: string }> }

export function findScreen(screens: ScreenEntry[], q: string): ScreenEntry | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  return screens.find((x) => x.id.toLowerCase() === s || x.route.toLowerCase() === s)
    || screens.find((x) => Object.values(x.i18n || {}).some((l) => (l.title || '').toLowerCase() === s))
    || screens.find((x) => x.route.toLowerCase().includes(s) || Object.values(x.i18n || {}).some((l) => (l.title || '').toLowerCase().includes(s)))
    || null;
}

/** Lines of App.tsx that mount a route, with the element they render. */
export function routeLines(appTsx: string, route: string): string[] {
  const lines = appTsx.split('\n');
  const out: string[] = [];
  const needle = `path="${route}"`;
  lines.forEach((l, i) => { if (l.includes(needle)) out.push(`${i + 1}\t${l.trim()}`); });
  return out;
}

export function buildDeepDiveExecutor(deps: DeepDiveDeps, signal?: AbortSignal) {
  return async (name: string, args: Record<string, unknown>): Promise<StageToolOutcome> => {
    if (signal?.aborted) return { result: 'cancelled', isError: true };
    try {
      switch (name) {
        case 'dev_index_query':
        case 'dev_graph_path':
        case 'dev_get_risk':
          return await deps.indexTool(name, args);
        case 'read_repo_file': {
          const path = typeof args.path === 'string' ? args.path.trim().replace(/^\/+/, '') : '';
          if (!path) return { result: 'path is required', isError: true };
          const repo = repoOf(args.repo);
          const content = await deps.readRepoFile(repo, path);
          return { result: `${repo}:${path}\n${numberedWindow(content, args.start_line, args.end_line)}` };
        }
        case 'dev_git_history': {
          const path = typeof args.path === 'string' ? args.path.trim().replace(/^\/+/, '') : '';
          if (!path) return { result: 'path is required', isError: true };
          const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
          const commits = await deps.gitHistory(repoOf(args.repo), path, limit);
          if (commits.length === 0) return { result: `No commits on main touch ${path}.` };
          return { result: commits.map((c) => `${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} ${c.author}: ${c.message}`).join('\n') };
        }
        case 'dev_probe_endpoint': {
          const p = probeUrl(args.env, args.path);
          if (!p.ok) return { result: p.error, isError: true };
          const started = deps.now();
          const res = await deps.fetchImpl(p.url, { method: 'GET', headers: { Accept: 'application/json' } });
          const body = await res.text();
          return { result: `[${p.env}] GET ${p.url} → ${res.status} ${res.headers.get('content-type') || ''} in ${deps.now() - started} ms (observed ${new Date(deps.now()).toISOString()})\n${clip(body, DEEP_DIVE_PROBE_MAX_CHARS)}` };
        }
        case 'dev_screen_trace': {
          const q = typeof args.screen === 'string' ? args.screen : '';
          const raw = JSON.parse(await deps.readRepoFile('exafyltd/vitana-v1', 'src/navigation/registry/screens.json')) as Record<string, unknown>;
          const list = (Array.isArray(raw) ? raw : Object.values((raw as { screens?: unknown }).screens ?? raw)) as ScreenEntry[];
          const hit = findScreen(list.filter((x) => x && typeof x.route === 'string'), q);
          if (!hit) return { result: `No screen in the registry matches "${q}".` };
          const app = await deps.readRepoFile('exafyltd/vitana-v1', 'src/App.tsx');
          const lines = routeLines(app, hit.route);
          const title = hit.i18n?.en?.title || hit.id;
          return {
            result: [
              `Screen ${hit.id} "${title}" → route ${hit.route} (exafyltd/vitana-v1 src/navigation/registry/screens.json)`,
              lines.length ? `App.tsx mounts:\n${lines.join('\n')}` : `No literal path="${hit.route}" in src/App.tsx (it may be a nested or parameterised route).`,
              'Next: dev_index_query with repo exafyltd/vitana-v1 on the element named above.',
            ].join('\n'),
          };
        }
        case 'dev_domain_atlas': {
          const q = typeof args.domain === 'string' ? args.domain : '';
          if (!q.trim()) return { result: renderAtlasIndex() };
          const d = findDomain(q);
          return { result: d ? renderAtlasDomain(d) : `No domain matches "${q}". Domains: ${DOMAIN_ATLAS.map((x) => x.key).join(', ')}.` };
        }
        case 'dev_system_status':
          return { result: await deps.systemStatus() };
        default:
          return await deps.triageTool(name, args);
      }
    } catch (e) {
      return { result: `${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  };
}

export async function deepDiveTools(): Promise<LLMRouterTool[]> {
  const { codeIndexRouterTools } = await import('../../services/codeintel-index');
  const { triageRouterTools } = await import('../../services/self-healing-triage-tools');
  return [...codeIndexRouterTools(), ...DEEP_DIVE_LOCAL_TOOLS, ...triageRouterTools()];
}

async function githubGet<T>(url: string, token: string | undefined): Promise<T> {
  if (!token) throw new Error('no GitHub token configured for this repo');
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return (await res.json()) as T;
}

function tokenFor(repo: Repo): string | undefined {
  return repo === 'exafyltd/vitana-v1' ? process.env.FRONTEND_DEPLOY_TOKEN : process.env.GITHUB_SAFE_MERGE_TOKEN;
}

export function defaultDeepDiveDeps(vtid: string): DeepDiveDeps {
  return {
    runLoop: runStageToolLoop,
    indexTool: async (name, args) => {
      const { loadCodeIndex, runCodeIndexTool, isCodeIndexToolName } = await import('../../services/codeintel-index');
      if (!isCodeIndexToolName(name)) return { result: `unknown index tool ${name}`, isError: true };
      const { bundle } = await loadCodeIndex(typeof args.repo === 'string' ? args.repo : 'exafyltd/vitana-platform');
      const r = runCodeIndexTool(name, args, bundle);
      return { result: r.text, isError: !r.ok };
    },
    readRepoFile: async (repo, path) => {
      const { getFileContents } = await import('../../services/github-service');
      const r = await getFileContents(repo, path, 'main', tokenFor(repo));
      if (r.type !== 'file') return `(directory) ${r.entries.map((e) => `${e.type === 'dir' ? 'd' : 'f'} ${e.path}`).join('\n')}`;
      return r.content;
    },
    gitHistory: async (repo, path, limit) => {
      const rows = await githubGet<Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>>(
        `https://api.github.com/repos/${repo}/commits?sha=main&path=${encodeURIComponent(path)}&per_page=${limit}`, tokenFor(repo));
      return rows.map((r) => ({ sha: r.sha, date: r.commit.author.date, author: r.commit.author.name, message: r.commit.message.split('\n')[0].slice(0, 160) }));
    },
    fetchImpl: fetch,
    triageTool: async (name, args) => {
      const { createTriageToolExecutor } = await import('../../services/self-healing-triage-tools');
      const { queryOasisEvents } = await import('../../services/self-healing-triage-service');
      return createTriageToolExecutor({ vtid, queryOasisEvents })(name, args);
    },
    systemStatus: async () => {
      const { getSystemSnapshot } = await import('./system-snapshot');
      return (await getSystemSnapshot()).text;
    },
    emit: (ok, payload) => {
      void import('../../services/oasis-event-service').then(({ emitOasisEvent }) => emitOasisEvent({
        vtid,
        type: ok ? 'orb.deep_dive.completed' : 'orb.deep_dive.failed',
        source: DEEP_DIVE_SERVICE,
        status: ok ? 'success' : 'warning',
        message: `deep dive ${ok ? 'completed' : 'failed'}: ${String(payload.question ?? '').slice(0, 120)}`,
        payload,
        surface: 'command-hub',
        actor_role: 'agent',
      })).catch(() => { /* telemetry never breaks the answer */ });
    },
    now: Date.now,
  };
}

export function isDeveloperCaller(caller: DelegationCaller): boolean {
  if (caller.surface !== 'command-hub') return false;
  if (caller.exafy_admin) return true;
  return DEVELOPER_ROLES.has(String(caller.platform_role || '').toLowerCase());
}

export async function runDeepDive(
  question: string,
  caller: DelegationCaller,
  signal: AbortSignal,
  deps: DeepDiveDeps = defaultDeepDiveDeps('VTID-04563'),
): Promise<DelegationOutcome> {
  if (!isDeveloperCaller(caller)) return { ok: false, result: null, error: 'deep dives are for developers on the Command Hub' };
  const q = question.trim();
  if (!q) return { ok: false, result: null, error: 'the deep dive needs a question' };
  const started = deps.now();
  const loop: StageToolLoopResult = await deps.runLoop({
    stage: DEEP_DIVE_STAGE,
    service: DEEP_DIVE_SERVICE,
    systemPrompt: DEEP_DIVE_SYSTEM_PROMPT,
    prompt: `Developer's question (relayed by their assistant): ${q}`,
    tools: await deepDiveTools(),
    execute: buildDeepDiveExecutor(deps, signal),
    maxTurns: DEEP_DIVE_MAX_TURNS,
    maxToolCalls: DEEP_DIVE_MAX_TOOL_CALLS,
    deadlineMs: DEEP_DIVE_DEADLINE_MS,
    maxTokens: 4_000,
  });
  const telemetry = {
    question: q.slice(0, 300),
    user_id: caller.user_id,
    session_id: caller.session_id,
    channel: caller.channel,
    duration_ms: deps.now() - started,
    tool_calls: loop.toolCalls,
    tools_used: loop.toolNames,
    turns: loop.turns,
    provider: loop.provider ?? null,
    model: loop.model ?? null,
    fallback_used: loop.fallbackUsed,
    budget_exhausted: loop.budgetExhausted,
    input_tokens: loop.usage.inputTokens,
    output_tokens: loop.usage.outputTokens,
  };
  if (!loop.ok || !loop.text) {
    deps.emit(false, { ...telemetry, error: loop.error ?? 'no findings' });
    return { ok: false, result: null, error: loop.error ?? 'the deep dive returned no findings' };
  }
  deps.emit(true, telemetry);
  return {
    ok: true,
    result: {
      findings: clip(loop.text.trim(), DEEP_DIVE_FINDINGS_MAX_CHARS),
      tools_used: loop.toolNames,
      duration_ms: telemetry.duration_ms,
      budget_exhausted: loop.budgetExhausted,
      note: 'Findings for you, not a script: tell the developer the answer first, then the evidence and its sources, in your own words.',
    },
  };
}

export const DEEP_DIVE_TARGET: DelegationTarget = {
  agent_id: DEEP_DIVE_AGENT_ID,
  description: 'Deep-dive investigator for developers: reads code, git history, OASIS events, logs, rows and live endpoints (read-only) and returns findings with sources.',
  surfaces: ['command-hub'],
  domain: 'dev',
  tier: 'read',
  run: (request, caller, signal) => runDeepDive(request, caller, signal),
};
