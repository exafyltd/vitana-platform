/**
 * VTID-04018 (W4a): the Operator Console's session bootstrap pack.
 *
 * `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §4.1: the console's
 * codebase knowledge was a hand-typed six-bullet constant
 * (`CODEBASE_OVERVIEW_BLOCK`, VTID-03930). A Claude Code session starts
 * with CLAUDE.md, the service map, the schema, the recent change log and
 * what is live; this pack gives the operator model the same start, on
 * every turn, from real sources rather than prose:
 *
 *   governance rules   — CLAUDE.md Part 1 (read from GitHub; the container
 *                        has no CLAUDE.md), bounded
 *   service path map   — config/service-path-map.json (repo root, GitHub)
 *   schema table index — DATABASE_SCHEMA.md `### table` headings
 *   recent change log  — the last N CHANGE LOG rows of CLAUDE.md, compressed
 *   live build-info    — the gateways named in OPERATOR_BOOTSTRAP_BUILD_INFO_URLS
 *   open PRs           — both repos, with the platform repo's CI state
 *   recent events      — the last N deploy.* / dev_autopilot.* OASIS events
 *   tool catalog       — rendered from the declarations the model is
 *                        actually given this turn (never a hand-typed list)
 *
 * Every source is independently bounded, timed out and fail-open: a source
 * that cannot be read renders one "(unavailable: …)" line and the turn
 * proceeds. The fetched sections are cached in-process for BOOTSTRAP_TTL_MS
 * and concurrent builds coalesce, so a cold cache costs one round of
 * fetches, not one per request. `OPERATOR_BOOTSTRAP_PACK_ENABLED=true`
 * gates the whole thing (default off — deploying this changes nothing).
 * VTID-04173: when `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS` is unset, the
 * build-info section still renders its "(no build-info targets …)" line and
 * one process-wide warning names the missing env var — a misconfigured
 * deployment is discoverable in the logs instead of degrading silently.
 * Not a replacement for dev_read_file / dev_search_codebase: the pack is
 * orientation, the tools are the detail.
 */

import { getFileContents, listOpenPrsBare, listOpenPrsWithStatus } from './github-service';

export const BOOTSTRAP_TTL_MS = 5 * 60_000;
export const SOURCE_TIMEOUT_MS = 2_500;
/** VTID-04024: how long the open-PR source waits for the CI-enriched list
 *  before falling back to the one-call bare list. Leaves room for the bare
 *  call inside SOURCE_TIMEOUT_MS. */
export const OPEN_PRS_ENRICH_BUDGET_MS = 1_500;
export const OPEN_PRS_FALLBACK_NOTE = '(platform CI state omitted: enrichment exceeded its budget — dev_github_feed has it)';
export const PACK_MAX_CHARS = 40_000;

const LIMITS = {
  rulesChars: 8_000,
  pathMapChars: 3_000,
  schemaIndexChars: 3_000,
  changelogRows: 20,
  changelogRowChars: 240,
  openPrs: 20,
  events: 10,
  catalogChars: 5_000,
};

const PLATFORM_REPO = 'exafyltd/vitana-platform';
const FRONTEND_REPO = 'exafyltd/vitana-v1';

export function isBootstrapPackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPERATOR_BOOTSTRAP_PACK_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// VTID-04173: make a missing build-info configuration discoverable
// ---------------------------------------------------------------------------

export const MISSING_BUILD_INFO_ENV_NAME = 'OPERATOR_BOOTSTRAP_BUILD_INFO_URLS';

export const MISSING_BUILD_INFO_ENV_WARNING =
  `[VTID-04173] ${MISSING_BUILD_INFO_ENV_NAME} is unset or empty — the session bootstrap pack omits live build-info for every gateway it reports on. ` +
  `Set it (e.g. "${MISSING_BUILD_INFO_ENV_NAME}='staging=https://…/api/v1/admin/build-info,prod=https://…/api/v1/admin/build-info'") to restore that section.`;

/** Process-wide, not per turn: the first build-info section with nothing to
 *  fetch warns; every later one (cache rebuild, another turn, another role)
 *  stays quiet. */
let warnedMissingBuildInfoEnv = false;

/** VTID-04173: returns true exactly once per process when the env var is
 *  unset/blank; silent (returns false) when the var is set. */
export function warnMissingBuildInfoEnvOnce(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env[MISSING_BUILD_INFO_ENV_NAME] || '').trim()) return false;
  if (warnedMissingBuildInfoEnv) return false;
  warnedMissingBuildInfoEnv = true;
  console.warn(MISSING_BUILD_INFO_ENV_WARNING);
  return true;
}

/** Test hook — the process-wide flag is intentionally not resettable in prod. */
export function resetMissingBuildInfoEnvWarning(): void { warnedMissingBuildInfoEnv = false; }

/** `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS="staging=https://…/build-info,prod=https://…/build-info"` */
export function parseBuildInfoTargets(env: NodeJS.ProcessEnv = process.env): Array<{ label: string; url: string }> {
  const raw = (env.OPERATOR_BOOTSTRAP_BUILD_INFO_URLS || '').trim();
  if (!raw) return [];
  const out: Array<{ label: string; url: string }> = [];
  for (const part of raw.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const label = part.slice(0, i).trim();
    const url = part.slice(i + 1).trim();
    if (label && /^https:\/\//.test(url)) out.push({ label, url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure renderers (unit-tested; no I/O)
// ---------------------------------------------------------------------------

function clip(text: string, max: number, note = '…[abridged]'): string {
  return text.length > max ? `${text.slice(0, max)}\n${note}` : text;
}

/** CLAUDE.md up to "# PART 2" (the rules), bounded. */
export function extractClaudeMdPart1(text: string, maxChars = LIMITS.rulesChars): string {
  const cut = text.indexOf('# PART 2');
  const part1 = cut > 0 ? text.slice(0, cut) : text;
  return clip(part1.trim(), maxChars);
}

/** The newest N rows of the CHANGE LOG table, each compressed to one line. */
export function extractChangelogRows(text: string, maxRows = LIMITS.changelogRows, maxRowChars = LIMITS.changelogRowChars): string[] {
  const header = text.indexOf('| Date | Change | VTID |');
  if (header < 0) return [];
  const body = text.slice(header);
  const rows: string[] = [];
  for (const line of body.split('\n').slice(2)) {
    if (!line.startsWith('| ')) { if (rows.length) break; continue; }
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const date = cells[1];
    const change = cells[2].replace(/\*\*/g, '').replace(/`/g, '');
    const vtid = cells[3];
    const firstSentence = change.split(/(?<=[.!?])\s+/)[0] || change;
    rows.push(`${date} ${vtid}: ${clip(firstSentence, maxRowChars, '…')}`);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

/** `### table_name` headings from DATABASE_SCHEMA.md, as one bounded line list. */
export function extractSchemaTableIndex(text: string, maxChars = LIMITS.schemaIndexChars): string {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^###\s+`?([A-Za-z0-9_.]+)`?/.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return clip(names.join(', '), maxChars);
}

export function renderServicePathMap(json: string, maxChars = LIMITS.pathMapChars): string {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const lines: string[] = [];
    const walk = (obj: unknown, prefix: string) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const o = v as Record<string, unknown>;
          const path = typeof o.path === 'string' ? o.path : typeof o.source === 'string' ? o.source : null;
          if (path) lines.push(`${prefix}${k} → ${path}`);
          else walk(v, `${prefix}${k}.`);
        } else if (typeof v === 'string') lines.push(`${prefix}${k} → ${v}`);
      }
    };
    walk(parsed, '');
    return clip(lines.join('\n') || json.trim(), maxChars);
  } catch {
    return clip(json.trim(), maxChars);
  }
}

export function renderToolCatalog(defs: Array<{ name: string; description: string }>, maxChars = LIMITS.catalogChars): string {
  const lines = defs.map((d) => {
    const first = (d.description || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)[0] || '';
    return `- ${d.name} — ${first.slice(0, 160)}`;
  });
  return clip(lines.join('\n'), maxChars);
}

export interface OpenPrSummary { repo: string; number: number; title: string; branch?: string; ci?: string; mergeable?: boolean | null; updated_at?: string }

export function renderOpenPrs(items: OpenPrSummary[], max = LIMITS.openPrs): string {
  if (items.length === 0) return '(no open PRs)';
  return items.slice(0, max).map((p) => {
    const flags = [p.ci ? `ci=${p.ci}` : null, p.mergeable === true ? 'mergeable' : p.mergeable === false ? 'not-mergeable' : null].filter(Boolean).join(', ');
    return `- ${p.repo}#${p.number} ${p.title.slice(0, 90)}${p.branch ? ` [${p.branch}]` : ''}${flags ? ` (${flags})` : ''}`;
  }).join('\n');
}

export interface RecentEvent { topic: string; status?: string | null; message?: string | null; created_at: string }

export function renderRecentEvents(rows: RecentEvent[], max = LIMITS.events): string {
  if (rows.length === 0) return '(no recent deploy/autopilot events)';
  return rows.slice(0, max).map((e) => `- ${e.created_at.slice(0, 16).replace('T', ' ')} ${e.topic}${e.status ? ` [${e.status}]` : ''}: ${(e.message || '').replace(/\s+/g, ' ').slice(0, 140)}`).join('\n');
}

export function renderBuildInfo(results: Array<{ label: string; ok: boolean; env?: string; git_commit?: string; booted_at?: string; error?: string }>): string {
  if (results.length === 0) return '(no build-info targets configured — set OPERATOR_BOOTSTRAP_BUILD_INFO_URLS)';
  return results.map((r) => r.ok
    ? `- ${r.label}: env=${r.env || '?'} commit=${(r.git_commit || '?').slice(0, 12)} booted=${r.booted_at || '?'}`
    : `- ${r.label}: (unavailable: ${r.error || 'unknown'})`).join('\n');
}

export interface PackSection { title: string; body?: string; error?: string }

export function assembleBootstrapPack(sections: PackSection[], builtAt: string, maxChars = PACK_MAX_CHARS): string {
  const parts = [
    `**Session bootstrap pack (VTID-04018) — assembled ${builtAt}, cached ${Math.round(BOOTSTRAP_TTL_MS / 60_000)} min. Orientation only: use dev_read_file / dev_search_codebase / dev_db_query / dev_query_oasis_events for anything specific.**`,
  ];
  for (const s of sections) {
    parts.push(`\n### ${s.title}\n${s.error ? `(unavailable: ${s.error})` : (s.body || '').trim() || '(empty)'}`);
  }
  return clip(parts.join('\n'), maxChars, '…[pack truncated at the size budget]');
}

// ---------------------------------------------------------------------------
// I/O (injectable for tests)
// ---------------------------------------------------------------------------

export interface BootstrapDeps {
  readRepoFile: (path: string) => Promise<string>;
  listPlatformOpenPrs: () => Promise<OpenPrSummary[]>;
  /** VTID-04024: one-call list without CI state; used when the enriched list is late or fails. */
  listPlatformOpenPrsBare?: () => Promise<OpenPrSummary[]>;
  listFrontendOpenPrs: () => Promise<OpenPrSummary[]>;
  queryRecentEvents: () => Promise<RecentEvent[]>;
  fetchBuildInfo: (url: string) => Promise<{ env?: string; git_commit?: string; booted_at?: string }>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t) clearTimeout(t); }
}

async function section(title: string, ms: number, fn: () => Promise<string>): Promise<PackSection> {
  try {
    return { title, body: await withTimeout(fn(), ms, title) };
  } catch (err) {
    return { title, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

function defaultDeps(): BootstrapDeps {
  const supaUrl = process.env.SUPABASE_URL || '';
  const supaKey = process.env.SUPABASE_SERVICE_ROLE || '';
  return {
    readRepoFile: async (path) => {
      const r = await getFileContents(PLATFORM_REPO, path, 'main');
      if (r.type !== 'file') throw new Error(`${path} is a directory`);
      return r.content;
    },
    listPlatformOpenPrs: async () => (await listOpenPrsWithStatus(PLATFORM_REPO, LIMITS.openPrs)).map((f) => ({
      repo: PLATFORM_REPO, number: f.pr_number, title: f.title || f.branch, branch: f.branch, ci: f.ci_state, mergeable: f.mergeable,
    })),
    listPlatformOpenPrsBare: async () => (await listOpenPrsBare(PLATFORM_REPO, LIMITS.openPrs)).map((p) => ({
      repo: PLATFORM_REPO, number: p.number, title: p.title, branch: p.branch, updated_at: p.updated_at,
    })),
    listFrontendOpenPrs: async () => {
      const token = process.env.FRONTEND_DEPLOY_TOKEN;
      if (!token) throw new Error('FRONTEND_DEPLOY_TOKEN not set');
      const res = await fetch(`https://api.github.com/repos/${FRONTEND_REPO}/pulls?state=open&sort=updated&direction=desc&per_page=10`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const prs = (await res.json()) as Array<{ number: number; title: string; head: { ref: string }; updated_at: string }>;
      return prs.map((p) => ({ repo: FRONTEND_REPO, number: p.number, title: p.title, branch: p.head.ref, updated_at: p.updated_at }));
    },
    queryRecentEvents: async () => {
      if (!supaUrl || !supaKey) throw new Error('Supabase not configured');
      const url = `${supaUrl}/rest/v1/oasis_events?or=(topic.like.deploy.*,topic.like.dev_autopilot.*)&select=topic,status,message,created_at&order=created_at.desc&limit=${LIMITS.events}`;
      const res = await fetch(url, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } });
      if (!res.ok) throw new Error(`oasis_events ${res.status}`);
      return (await res.json()) as RecentEvent[];
    },
    fetchBuildInfo: async (url) => {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { env?: string; git_commit?: string; booted_at?: string };
    },
  };
}

/** The fetched (cacheable) part of the pack — everything except the per-role tool catalog. */
/**
 * VTID-04024: the CI-enriched list is one GitHub call per PR on top of the
 * listing (parallel since this VTID, sequential before — the live cause of
 * "(unavailable: Open pull requests timed out after 2500ms)" on the first
 * staging turn). Race it against a partial budget; if it is late or fails
 * and a bare lister exists, serve the PRs without CI state rather than no
 * PRs at all. Errors never escape as unhandled rejections.
 */
export async function resolvePlatformOpenPrs(
  deps: Pick<BootstrapDeps, 'listPlatformOpenPrs' | 'listPlatformOpenPrsBare'>,
  budgetMs = OPEN_PRS_ENRICH_BUDGET_MS,
): Promise<{ items: OpenPrSummary[]; degraded: boolean }> {
  const rich = deps.listPlatformOpenPrs().then(
    (items) => ({ ok: true as const, items }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  const bare = deps.listPlatformOpenPrsBare ? deps.listPlatformOpenPrsBare().then(
    (items) => ({ ok: true as const, items }),
    (err: unknown) => ({ ok: false as const, err }),
  ) : null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), budgetMs); });
  const first = await Promise.race([rich, late]);
  if (timer) clearTimeout(timer);
  if (first !== 'late' && first.ok) return { items: first.items, degraded: false };
  const richErr = first === 'late' ? `enriched list exceeded ${budgetMs}ms` : (first.err instanceof Error ? first.err.message : String(first.err));
  if (!bare) throw new Error(`platform: ${richErr}`);
  const b = await bare;
  if (b.ok) return { items: b.items, degraded: true };
  throw new Error(`platform: ${richErr}; bare list: ${b.err instanceof Error ? b.err.message : String(b.err)}`);
}

export async function buildBootstrapSections(deps: BootstrapDeps): Promise<PackSection[]> {
  const env = deps.env || process.env;
  const claudeMd = deps.readRepoFile('CLAUDE.md');
  const [rules, changelog, pathMap, schema, buildInfo, prs, events] = await Promise.all([
    section('Governance rules (CLAUDE.md Part 1, abridged)', SOURCE_TIMEOUT_MS, async () => extractClaudeMdPart1(await claudeMd)),
    section('Recent change log (newest first)', SOURCE_TIMEOUT_MS, async () => extractChangelogRows(await claudeMd).join('\n')),
    section('Service path map (config/service-path-map.json)', SOURCE_TIMEOUT_MS, async () => renderServicePathMap(await deps.readRepoFile('config/service-path-map.json'))),
    section('Database tables (DATABASE_SCHEMA.md index)', SOURCE_TIMEOUT_MS, async () => extractSchemaTableIndex(await deps.readRepoFile('DATABASE_SCHEMA.md'))),
    section('Live build-info', SOURCE_TIMEOUT_MS, async () => {
      const targets = parseBuildInfoTargets(env);
      // VTID-04173: an unconfigured deployment degrades silently otherwise —
      // warn once per process, naming the env var, then render as before.
      if (targets.length === 0) warnMissingBuildInfoEnvOnce(env);
      const results = await Promise.all(targets.map(async (t) => {
        try { const r = await withTimeout(deps.fetchBuildInfo(t.url), SOURCE_TIMEOUT_MS - 200, t.label); return { label: t.label, ok: true, ...r }; }
        catch (err) { return { label: t.label, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 120) }; }
      }));
      return renderBuildInfo(results);
    }),
    section('Open pull requests', SOURCE_TIMEOUT_MS, async () => {
      const [platform, frontend] = await Promise.all([
        resolvePlatformOpenPrs(deps),
        deps.listFrontendOpenPrs().catch(() => [] as OpenPrSummary[]),
      ]);
      const body = renderOpenPrs([...platform.items, ...frontend]);
      return platform.degraded ? `${body}\n${OPEN_PRS_FALLBACK_NOTE}` : body;
    }),
    section('Recent deploy / autopilot events (OASIS)', SOURCE_TIMEOUT_MS, async () => renderRecentEvents(await deps.queryRecentEvents())),
  ]);
  return [rules, changelog, pathMap, schema, buildInfo, prs, events];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry { builtAt: number; builtAtIso: string; sections: PackSection[] }
let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

export function resetBootstrapPackCache(): void { cache = null; inflight = null; }

async function getSections(deps: BootstrapDeps): Promise<CacheEntry> {
  const now = (deps.now || Date.now)();
  if (cache && now - cache.builtAt < BOOTSTRAP_TTL_MS) return cache;
  if (!inflight) {
    inflight = (async () => {
      try {
        const sections = await buildBootstrapSections(deps);
        cache = { builtAt: (deps.now || Date.now)(), builtAtIso: new Date((deps.now || Date.now)()).toISOString(), sections };
        return cache;
      } finally { inflight = null; }
    })();
  }
  return inflight;
}

/**
 * The pack for one turn: '' when disabled; otherwise the cached sections
 * plus the tool catalog rendered from the definitions this turn was given.
 * Never throws — the operator turn must not depend on it.
 */
export async function getOperatorBootstrapPack(opts: {
  toolDefs: Array<{ name: string; description: string }>;
  deps?: Partial<BootstrapDeps>;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = opts.env || process.env;
  if (!isBootstrapPackEnabled(env)) return '';
  try {
    const deps: BootstrapDeps = { ...defaultDeps(), ...(opts.deps || {}), env };
    const entry = await getSections(deps);
    const catalog: PackSection = { title: 'Tool catalog (rendered from the declarations you were given this turn)', body: renderToolCatalog(opts.toolDefs) };
    return assembleBootstrapPack([...entry.sections, catalog], entry.builtAtIso);
  } catch (err) {
    console.warn(`[VTID-04018] bootstrap pack failed open: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}
