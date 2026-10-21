/**
 * VTID-04229 — the S3-published codebase index every agent queries.
 *
 * CLAUDE.md's "Mandatory Codebase Intelligence Workflow" names RepoWise and
 * Graphify, and VTID-04116/04118 tried to give the Operator Console both by
 * baking the CLIs into the gateway image. That never worked: `repowise`
 * depends on `lancedb`, which publishes no musl wheel, so on the
 * node:20-alpine image `pip install` fails and `dev_repowise`/`dev_graphify`
 * report `not_configured` on every deployment (verified live, VTID-04222 §3).
 * The executor task has the same image lineage and the same problem.
 *
 * This module moves the index OUT of the image: CODEINTEL-INDEX.yml builds
 * both tools on an ubuntu runner on every merge to main, derives a small
 * self-contained bundle (scripts/codeintel/build-code-index.mjs) and
 * publishes it to s3://<CODE_INDEX_BUCKET>/<repo>/<sha>/ plus
 * <repo>/latest/manifest.json. The gateway (Operator Console tools
 * dev_index_query / dev_graph_path / dev_get_risk) and the ECS executor
 * (the same three tools in agent-tools.ts) load that bundle here — no CLI,
 * no Python, no per-query subprocess.
 *
 * Posture, same as every other optional provider (CLAUDE.md IF-THEN 31): a
 * missing bucket/object/credential is reported as a real error string,
 * never thrown into a turn and never silently swallowed. The bundle is
 * cached in memory per repo and re-resolved against latest/manifest.json
 * after CODE_INDEX_LATEST_TTL_MS. Everything in here that answers a
 * question is a pure function over the loaded bundle, so it is unit-tested
 * against a fixture without S3.
 */

import { promises as fs } from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { LLMRouterTool } from './llm-router';

export const CODE_INDEX_DEFAULT_BUCKET = 'vitana-code-index';
export const CODE_INDEX_LATEST_TTL_MS = 10 * 60 * 1000;
export const CODE_INDEX_S3_TIMEOUT_MS = 20_000;
export const CODE_INDEX_QUERY_BUDGET_CHARS = 6_000;
export const CODE_INDEX_QUERY_MAX_BUDGET_CHARS = 16_000;
export const CODE_INDEX_MAX_SEEDS = 6;
export const CODE_INDEX_PATH_MAX_VISITS = 250_000;
export const CODE_INDEX_RISK_MAX_CHARS = 5_000;

export const ALLOWED_CODE_INDEX_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
export type CodeIndexRepo = (typeof ALLOWED_CODE_INDEX_REPOS)[number];

export function resolveCodeIndexRepo(repo: unknown): CodeIndexRepo | null {
  const key = (typeof repo === 'string' && repo.trim()) ? repo.trim() : 'exafyltd/vitana-platform';
  return (ALLOWED_CODE_INDEX_REPOS as readonly string[]).includes(key) ? (key as CodeIndexRepo) : null;
}

// ---------------------------------------------------------------- bundle shapes

/** [id, label, kind, source_file, source_location, file_type] */
export type GraphNodeRow = [string, string, string, string, string, string];
/** [sourceIdx, targetIdx, relationIdx] */
export type GraphEdgeRow = [number, number, number];

export interface GraphIndexData {
  format: number;
  nodes: GraphNodeRow[];
  relations: string[];
  edges: GraphEdgeRow[];
}

export interface RiskFileRecord {
  commits_total: number | null;
  commits_90d: number | null;
  last_commit: string | null;
  owner: string | null;
  owner_pct: number | null;
  bug_fixes: number;
  hotspot: boolean;
  layer: string | null;
  role: string | null;
  public_symbols: number | null;
  depends_on: string[];
  used_by: string[];
  changes_together_with: string[];
  overview: string;
}

export interface RiskIndexData {
  format: number;
  files: Record<string, RiskFileRecord>;
  hotspots: Record<string, { churn_percentile: number | null; commit_count_90d: number | null; primary_owner: string | null; bus_factor: number | null }>;
  dead_code: Record<string, Array<{ symbol: string | null; kind: string | null; confidence: number | null; safe_to_delete: boolean }>>;
  decisions: Array<{ title: string; status: string | null; decision: string }>;
}

export interface CodeIndexManifest {
  format: number;
  repo: string;
  sha: string;
  built_at: string;
  files: { graph: string; risk: string };
  counts: Record<string, number>;
}

export interface CodeIndexBundle {
  repo: string;
  sha: string;
  builtAt: string;
  manifest: CodeIndexManifest;
  graph: GraphIndexData;
  risk: RiskIndexData;
  /** Outgoing edge indices per node. */
  out: number[][];
  /** Incoming edge indices per node. */
  inn: number[][];
  /** lowercase label → node indices */
  byLabel: Map<string, number[]>;
  /** source_file → node indices (the file's own node first when present) */
  byFile: Map<string, number[]>;
}

export function assembleBundle(manifest: CodeIndexManifest, graph: GraphIndexData, risk: RiskIndexData): CodeIndexBundle {
  const n = graph.nodes.length;
  const out: number[][] = Array.from({ length: n }, () => []);
  const inn: number[][] = Array.from({ length: n }, () => []);
  graph.edges.forEach((e, i) => {
    const [s, t] = e;
    if (s >= 0 && s < n && t >= 0 && t < n) { out[s].push(i); inn[t].push(i); }
  });
  const byLabel = new Map<string, number[]>();
  const byFile = new Map<string, number[]>();
  graph.nodes.forEach((row, i) => {
    const label = (row[1] || '').toLowerCase();
    if (label) { const arr = byLabel.get(label) || []; arr.push(i); byLabel.set(label, arr); }
    const file = row[3] || '';
    if (file) {
      const arr = byFile.get(file) || [];
      if (row[2] === 'file' || row[1] === path.basename(file)) arr.unshift(i); else arr.push(i);
      byFile.set(file, arr);
    }
  });
  return { repo: manifest.repo, sha: manifest.sha, builtAt: manifest.built_at, manifest, graph, risk, out, inn, byLabel, byFile };
}

// ---------------------------------------------------------------- sources

export interface CodeIndexSource {
  kind: 's3' | 'dir';
  describe(): string;
  /** Returns null when the key does not exist. Throws on any other failure. */
  read(key: string): Promise<Buffer | null>;
}

export function dirSource(rootDir: string): CodeIndexSource {
  return {
    kind: 'dir',
    describe: () => `dir:${rootDir}`,
    async read(key) {
      try {
        return await fs.readFile(path.join(rootDir, key));
      } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

export function s3Source(bucket: string, region: string): CodeIndexSource {
  let client: any = null;
  let mod: any = null;
  return {
    kind: 's3',
    describe: () => `s3://${bucket} (${region})`,
    async read(key) {
      if (!mod) mod = await import('@aws-sdk/client-s3');
      if (!client) client = new mod.S3Client({ region });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), CODE_INDEX_S3_TIMEOUT_MS);
      try {
        const res = await client.send(new mod.GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: ac.signal });
        const bytes = await res.Body.transformToByteArray();
        return Buffer.from(bytes);
      } catch (err: any) {
        const code = err?.name || err?.Code;
        if (code === 'NoSuchKey' || code === 'NotFound') return null;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Where the bundle comes from, by env: CODE_INDEX_LOCAL_DIR (a directory laid
 * out exactly like the bucket — tests, local runs, or a pre-pulled copy on
 * the executor) wins; otherwise the bucket (CODE_INDEX_BUCKET, default
 * vitana-code-index) in CODE_INDEX_REGION → AWS_BEDROCK_REGION → AWS_REGION →
 * eu-central-1.
 */
export function resolveCodeIndexSource(env: NodeJS.ProcessEnv = process.env): CodeIndexSource {
  const local = (env.CODE_INDEX_LOCAL_DIR || '').trim();
  if (local) return dirSource(local);
  const bucket = (env.CODE_INDEX_BUCKET || '').trim() || CODE_INDEX_DEFAULT_BUCKET;
  const region = (env.CODE_INDEX_REGION || env.AWS_BEDROCK_REGION || env.AWS_REGION || '').trim() || 'eu-central-1';
  return s3Source(bucket, region);
}

function gunzipJson<T>(buf: Buffer, key: string): T {
  const isGz = key.endsWith('.gz') || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  const text = (isGz ? zlib.gunzipSync(buf) : buf).toString('utf8');
  return JSON.parse(text) as T;
}

export interface LoadedCodeIndex {
  bundle: CodeIndexBundle;
  fromCache: boolean;
  source: string;
  loadMs: number;
}

interface CacheEntry { bundle: CodeIndexBundle; checkedAt: number }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LoadedCodeIndex>>();

export function clearCodeIndexCache(): void { cache.clear(); inflight.clear(); }

/**
 * Loads (or reuses) the latest bundle for `repo`. `latest/manifest.json` is
 * re-read after `ttlMs`; a manifest naming the sha already cached is a
 * cache hit. Throws with a plain message when the bundle is absent or
 * unreadable — callers turn that into a tool error, never a crash.
 */
export async function loadCodeIndex(
  repo: string,
  opts: { source?: CodeIndexSource; env?: NodeJS.ProcessEnv; ttlMs?: number; now?: () => number } = {},
): Promise<LoadedCodeIndex> {
  const key = resolveCodeIndexRepo(repo);
  if (!key) throw new Error(`repo must be one of: ${ALLOWED_CODE_INDEX_REPOS.join(', ')}`);
  const source = opts.source || resolveCodeIndexSource(opts.env || process.env);
  const now = opts.now || Date.now;
  const ttl = opts.ttlMs ?? CODE_INDEX_LATEST_TTL_MS;
  const cacheKey = `${source.describe()}|${key}`;
  const hit = cache.get(cacheKey);
  if (hit && now() - hit.checkedAt < ttl) return { bundle: hit.bundle, fromCache: true, source: source.describe(), loadMs: 0 };
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  const p = (async () => {
    const started = now();
    const manifestBuf = await source.read(`${key}/latest/manifest.json`);
    if (!manifestBuf) throw new Error(`code index not published for ${key} at ${source.describe()} (no latest/manifest.json — has CODEINTEL-INDEX.yml run since the bucket was provisioned?)`);
    const manifest = JSON.parse(manifestBuf.toString('utf8')) as CodeIndexManifest;
    if (!manifest?.sha || !manifest?.files?.graph || !manifest?.files?.risk) throw new Error(`code index manifest for ${key} is malformed`);
    if (hit && hit.bundle.sha === manifest.sha) {
      cache.set(cacheKey, { bundle: hit.bundle, checkedAt: now() });
      return { bundle: hit.bundle, fromCache: true, source: source.describe(), loadMs: now() - started };
    }
    const prefix = `${key}/${manifest.sha}/`;
    const [graphBuf, riskBuf] = await Promise.all([source.read(prefix + manifest.files.graph), source.read(prefix + manifest.files.risk)]);
    if (!graphBuf || !riskBuf) throw new Error(`code index bundle ${prefix} is incomplete (graph=${!!graphBuf} risk=${!!riskBuf})`);
    const graph = gunzipJson<GraphIndexData>(graphBuf, manifest.files.graph);
    const risk = gunzipJson<RiskIndexData>(riskBuf, manifest.files.risk);
    const bundle = assembleBundle(manifest, graph, risk);
    cache.set(cacheKey, { bundle, checkedAt: now() });
    return { bundle, fromCache: false, source: source.describe(), loadMs: now() - started };
  })();
  inflight.set(cacheKey, p);
  try { return await p; } finally { inflight.delete(cacheKey); }
}

// ---------------------------------------------------------------- queries (pure)

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'where', 'how', 'does', 'into', 'are', 'was', 'were', 'when', 'which', 'who', 'why', 'use', 'used', 'uses', 'call', 'calls', 'called', 'file', 'files', 'code', 'function', 'functions', 'class', 'module', 'service', 'services', 'src', 'gateway', 'vitana']);

export function tokenize(query: string): string[] {
  const raw = (query || '').toLowerCase().split(/[^a-z0-9_.\/-]+/).filter(Boolean);
  const out = new Set<string>();
  for (const t of raw) {
    const clean = t.replace(/^[./-]+|[./-]+$/g, '');
    if (clean.length < 3 || STOP.has(clean)) continue;
    out.add(clean);
    // camelCase / snake_case / kebab-case parts help label matches
    for (const part of clean.split(/[_\-.]/)) if (part.length >= 4 && !STOP.has(part)) out.add(part);
  }
  return Array.from(out).slice(0, 12);
}

function nodeLine(b: CodeIndexBundle, i: number): string {
  const [, label, kind, file, loc, ftype] = b.graph.nodes[i];
  const where = file ? `${file}${loc ? `:${loc}` : ''}` : '';
  return `${label}${kind ? ` (${kind})` : ftype && ftype !== 'code' ? ` (${ftype})` : ''}${where ? ` — ${where}` : ''}`;
}

function scoreNode(row: GraphNodeRow, tokens: string[], phrase: string): number {
  const label = (row[1] || '').toLowerCase();
  const file = (row[3] || '').toLowerCase();
  const id = (row[0] || '').toLowerCase();
  let s = 0;
  if (phrase && (label === phrase || file === phrase || file.endsWith(`/${phrase}`))) s += 12;
  for (const t of tokens) {
    if (label === t) s += 8;
    else if (label.includes(t)) s += 4;
    if (file.includes(t)) s += 2;
    else if (id.includes(t)) s += 1;
  }
  if (s > 0 && row[5] === 'code') s += 1;
  if (s > 0 && row[2] === 'file') s += 1;
  return s;
}

export interface IndexQueryResult {
  ok: boolean;
  query: string;
  tokens: string[];
  seeds: Array<{ label: string; file: string; kind: string; score: number }>;
  nodes_touched: number;
  text: string;
  truncated: boolean;
}

/**
 * Token-scored seed search over labels/paths, then a depth-limited walk over
 * the graph from the best seeds, rendered as a compact "what is this, what
 * does it touch, what touches it" block bounded by `budgetChars`.
 */
export function indexQuery(b: CodeIndexBundle, query: string, opts: { budgetChars?: number; maxSeeds?: number; depth?: 1 | 2 } = {}): IndexQueryResult {
  const tokens = tokenize(query);
  const phrase = (query || '').trim().toLowerCase();
  const budget = Math.max(800, Math.min(CODE_INDEX_QUERY_MAX_BUDGET_CHARS, opts.budgetChars || CODE_INDEX_QUERY_BUDGET_CHARS));
  const maxSeeds = Math.max(1, Math.min(12, opts.maxSeeds || CODE_INDEX_MAX_SEEDS));
  const depth = opts.depth === 2 ? 2 : 1;
  if (tokens.length === 0) {
    return { ok: false, query, tokens, seeds: [], nodes_touched: 0, text: 'query is empty after tokenization — give a symbol, file path or a few descriptive words', truncated: false };
  }
  const scored: Array<[number, number]> = [];
  b.graph.nodes.forEach((row, i) => {
    const s = scoreNode(row, tokens, phrase);
    if (s > 0) scored.push([i, s]);
  });
  scored.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
  const seeds = scored.slice(0, maxSeeds);
  if (seeds.length === 0) {
    return { ok: true, query, tokens, seeds: [], nodes_touched: 0, text: `no index node matches "${query}" (tokens: ${tokens.join(', ')}). Try a file path suffix, an exported symbol name, or fewer words.`, truncated: false };
  }
  const lines: string[] = [`Code index ${b.repo}@${b.sha.slice(0, 8)} — ${seeds.length} seed(s) for "${query}"`];
  const touched = new Set<number>();
  let truncated = false;
  const push = (l: string) => {
    if (truncated) return;
    if (lines.join('\n').length + l.length + 1 > budget) { truncated = true; lines.push('…[budget reached — narrow the query or raise budget_chars]'); return; }
    lines.push(l);
  };
  const perSeedEdges = depth === 2 ? 16 : 12;
  for (const [i, s] of seeds) {
    touched.add(i);
    push('');
    push(`## ${nodeLine(b, i)}  [score ${s}]`);
    const rk = b.risk.files[b.graph.nodes[i][3]];
    if (rk && b.graph.nodes[i][2] === 'file' && rk.overview) push(`   ${rk.overview.slice(0, 220)}`);
    let shown = 0;
    for (const ei of b.out[i]) {
      if (shown >= perSeedEdges) { push(`   … ${b.out[i].length - shown} more outgoing`); break; }
      const [, t, r] = b.graph.edges[ei];
      touched.add(t);
      push(`   → ${b.graph.relations[r]} ${nodeLine(b, t)}`);
      shown++;
    }
    shown = 0;
    for (const ei of b.inn[i]) {
      if (shown >= perSeedEdges) { push(`   … ${b.inn[i].length - shown} more incoming`); break; }
      const [sIdx, , r] = b.graph.edges[ei];
      touched.add(sIdx);
      push(`   ← ${b.graph.relations[r]} ${nodeLine(b, sIdx)}`);
      shown++;
    }
    if (depth === 2) {
      // one more hop out from the seed's first few callees/imports
      let hops = 0;
      for (const ei of b.out[i].slice(0, 4)) {
        const [, t] = b.graph.edges[ei];
        for (const ej of b.inn[t].slice(0, 3)) {
          const [sIdx, , r] = b.graph.edges[ej];
          if (sIdx === i) continue;
          touched.add(sIdx);
          push(`      ↳ ${nodeLine(b, t)} ← ${b.graph.relations[r]} ${nodeLine(b, sIdx)}`);
          if (++hops >= 8) break;
        }
        if (hops >= 8) break;
      }
    }
  }
  return {
    ok: true, query, tokens,
    seeds: seeds.map(([i, s]) => ({ label: b.graph.nodes[i][1], file: b.graph.nodes[i][3], kind: b.graph.nodes[i][2], score: s })),
    nodes_touched: touched.size, text: lines.join('\n'), truncated,
  };
}

/** Resolve a user-supplied name to one node: exact id, exact label, exact file, then suffix/contains. */
export function resolveNode(b: CodeIndexBundle, name: string): { idx: number | null; candidates: number[] } {
  const raw = (name || '').trim();
  if (!raw) return { idx: null, candidates: [] };
  const lower = raw.toLowerCase();
  const byId = b.graph.nodes.findIndex((r) => r[0] === raw);
  if (byId >= 0) return { idx: byId, candidates: [byId] };
  const fileHit = b.byFile.get(raw) || b.byFile.get(raw.replace(/^\.?\//, ''));
  if (fileHit && fileHit.length) return { idx: fileHit[0], candidates: fileHit.slice(0, 5) };
  const labelHit = b.byLabel.get(lower);
  if (labelHit && labelHit.length) {
    const sorted = [...labelHit].sort((x, y) => (b.out[y].length + b.inn[y].length) - (b.out[x].length + b.inn[x].length));
    return { idx: sorted[0], candidates: sorted.slice(0, 5) };
  }
  const cands: Array<[number, number]> = [];
  b.graph.nodes.forEach((r, i) => {
    const label = (r[1] || '').toLowerCase();
    const file = (r[3] || '').toLowerCase();
    // the file's own node outranks the symbols it contains on a path match
    const fileBonus = r[2] === 'file' || r[1] === path.basename(r[3] || '') ? 1 : 0;
    if (file.endsWith(lower) || file.endsWith(`/${lower}`)) cands.push([i, 4 + fileBonus]);
    else if (label.includes(lower)) cands.push([i, 2]);
    else if (file.includes(lower)) cands.push([i, 1 + fileBonus]);
  });
  cands.sort((x, y) => y[1] - x[1] || (b.graph.nodes[x[0]][1].length - b.graph.nodes[y[0]][1].length));
  return { idx: cands.length ? cands[0][0] : null, candidates: cands.slice(0, 5).map((c) => c[0]) };
}

export interface GraphPathResult {
  ok: boolean;
  found: boolean;
  source: string;
  target: string;
  hops: number;
  text: string;
}

/** Shortest path over the undirected graph (BFS), bounded in visits. */
export function graphPath(b: CodeIndexBundle, source: string, target: string, opts: { maxVisits?: number } = {}): GraphPathResult {
  const s = resolveNode(b, source);
  const t = resolveNode(b, target);
  if (s.idx === null || t.idx === null) {
    const miss = s.idx === null ? source : target;
    const alt = (s.idx === null ? s.candidates : t.candidates).map((i) => nodeLine(b, i));
    return { ok: false, found: false, source, target, hops: 0, text: `could not resolve "${miss}" to an index node${alt.length ? `; closest: ${alt.join(' | ')}` : ''}` };
  }
  if (s.idx === t.idx) return { ok: true, found: true, source, target, hops: 0, text: `source and target resolve to the same node: ${nodeLine(b, s.idx)}` };
  const maxVisits = opts.maxVisits || CODE_INDEX_PATH_MAX_VISITS;
  const prev = new Map<number, [number, number, boolean]>(); // node → [prevNode, edgeIdx, forward]
  const queue: number[] = [s.idx];
  prev.set(s.idx, [-1, -1, true]);
  let visits = 0;
  let head = 0;
  let reached = false;
  while (head < queue.length && visits < maxVisits) {
    const cur = queue[head++];
    visits++;
    if (cur === t.idx) { reached = true; break; }
    for (const ei of b.out[cur]) {
      const nxt = b.graph.edges[ei][1];
      if (!prev.has(nxt)) { prev.set(nxt, [cur, ei, true]); queue.push(nxt); }
    }
    for (const ei of b.inn[cur]) {
      const nxt = b.graph.edges[ei][0];
      if (!prev.has(nxt)) { prev.set(nxt, [cur, ei, false]); queue.push(nxt); }
    }
  }
  if (!reached) {
    return { ok: true, found: false, source, target, hops: 0, text: `no path between ${nodeLine(b, s.idx)} and ${nodeLine(b, t.idx)} within ${visits} visited nodes` };
  }
  const steps: string[] = [];
  let cur = t.idx;
  while (cur !== s.idx) {
    const [p, ei, fwd] = prev.get(cur)!;
    const rel = b.graph.relations[b.graph.edges[ei][2]];
    steps.unshift(`${fwd ? `—${rel}→` : `←${rel}—`} ${nodeLine(b, cur)}`);
    cur = p;
  }
  const text = [`Path (${steps.length} hop${steps.length === 1 ? '' : 's'}) in ${b.repo}@${b.sha.slice(0, 8)}:`, `  ${nodeLine(b, s.idx)}`, ...steps.map((l) => `  ${l}`)].join('\n');
  return { ok: true, found: true, source, target, hops: steps.length, text };
}

export interface RiskResult {
  ok: boolean;
  found: boolean;
  file: string;
  text: string;
  record?: RiskFileRecord;
  importers?: string[];
  dependents_count?: number;
}

function normalizeFilePath(p: string): string {
  return (p || '').trim().replace(/^\.?\//, '');
}

const IMPORT_RELATIONS = new Set(['imports', 'imports_from', 'dynamic_import', 're_exports', 'depends_on', 'uses']);

/**
 * Risk facts for one file: RepoWise history/ownership/hotspot/dead-code plus
 * the Graphify import fan-in (files importing this one). A file missing from
 * the RepoWise export (it caps page generation) still gets the graph half.
 */
export function getRisk(b: CodeIndexBundle, filePath: string): RiskResult {
  const file = normalizeFilePath(filePath);
  if (!file) return { ok: false, found: false, file, text: 'file path is required' };
  const record = b.risk.files[file];
  const nodeIdxs = b.byFile.get(file) || [];
  if (!record && nodeIdxs.length === 0) {
    const cands = Object.keys(b.risk.files).filter((k) => k.endsWith(file) || k.endsWith(`/${file}`)).slice(0, 5);
    const graphCands = cands.length ? [] : Array.from(b.byFile.keys()).filter((k) => k.endsWith(file)).slice(0, 5);
    const alt = cands.length ? cands : graphCands;
    return { ok: false, found: false, file, text: `"${file}" is not in the index${alt.length ? `; closest: ${alt.join(' | ')}` : ''}` };
  }
  const importers = new Set<string>();
  let dependents = 0;
  for (const i of nodeIdxs) {
    for (const ei of b.inn[i]) {
      const [sIdx, , r] = b.graph.edges[ei];
      if (!IMPORT_RELATIONS.has(b.graph.relations[r])) continue;
      const sf = b.graph.nodes[sIdx][3];
      if (sf && sf !== file) { importers.add(sf); dependents++; }
    }
  }
  const hot = b.risk.hotspots[file];
  const dead = b.risk.dead_code[file] || [];
  const symbols = nodeIdxs.filter((i) => b.graph.nodes[i][2] !== 'file' && b.graph.nodes[i][1] !== path.basename(file)).length;
  const lines: string[] = [`Risk for ${file} (${b.repo}@${b.sha.slice(0, 8)})`];
  if (record) {
    lines.push(`- history: ${record.commits_total ?? '?'} commits total, ${record.commits_90d ?? '?'} in 90d, last ${record.last_commit || '?'}; ${record.bug_fixes} bug fix(es)${record.hotspot ? '; CHANGE HOTSPOT' : ''}`);
    if (record.owner) lines.push(`- ownership: ${record.owner} at ${record.owner_pct ?? '?'}% of commits${hot?.bus_factor != null ? `; bus factor ${hot.bus_factor}` : ''}`);
    if (record.layer || record.role) lines.push(`- layer/role: ${record.layer || '?'} / ${record.role || '?'}; public symbols ${record.public_symbols ?? symbols}`);
    if (record.overview) lines.push(`- overview: ${record.overview}`);
  } else {
    lines.push(`- RepoWise page not in export (graph facts only); ${symbols} symbol node(s)`);
  }
  if (hot) lines.push(`- churn percentile ${hot.churn_percentile}, ${hot.commit_count_90d} commits/90d (RepoWise hotspot list)`);
  lines.push(`- import fan-in (graph): ${importers.size} file(s) import this one${importers.size ? `: ${Array.from(importers).slice(0, 15).join(', ')}${importers.size > 15 ? ` … +${importers.size - 15}` : ''}` : ''}`);
  if (record?.used_by?.length) lines.push(`- used by (RepoWise): ${record.used_by.slice(0, 12).join(', ')}`);
  if (record?.depends_on?.length) lines.push(`- depends on (RepoWise): ${record.depends_on.slice(0, 12).join(', ')}`);
  if (record?.changes_together_with?.length) lines.push(`- co-changes with: ${record.changes_together_with.slice(0, 8).join(', ')}`);
  if (dead.length) lines.push(`- dead-code candidates: ${dead.slice(0, 8).map((d) => `${d.symbol || d.kind || '?'}${d.confidence != null ? ` (${d.confidence})` : ''}`).join(', ')}${dead.length > 8 ? ` … +${dead.length - 8}` : ''}`);
  const testHint = /(^|\/)test\//.test(file) ? '' : `- tests: search services/**/test for "${path.basename(file).replace(/\.[jt]sx?$/, '')}" before editing; a hotspot with importers needs its callers' suites re-run too`;
  if (testHint) lines.push(testHint);
  let text = lines.join('\n');
  if (text.length > CODE_INDEX_RISK_MAX_CHARS) text = `${text.slice(0, CODE_INDEX_RISK_MAX_CHARS)}…`;
  return { ok: true, found: true, file, text, record, importers: Array.from(importers).slice(0, 50), dependents_count: importers.size };
}

export function describeBundle(b: CodeIndexBundle): string {
  const c = b.manifest.counts || {};
  return `code index ${b.repo}@${b.sha.slice(0, 12)} built ${b.builtAt}: ${c.nodes ?? b.graph.nodes.length} nodes, ${c.edges ?? b.graph.edges.length} edges, ${c.risk_files ?? Object.keys(b.risk.files).length} file risk records, ${c.hotspots ?? 0} hotspots`;
}

// ---------------------------------------------------------------- tool surface (shared by operator + executor)

export const CODE_INDEX_TOOL_NAMES = ['dev_index_query', 'dev_graph_path', 'dev_get_risk'] as const;
export type CodeIndexToolName = (typeof CODE_INDEX_TOOL_NAMES)[number];

export function isCodeIndexToolName(name: string): name is CodeIndexToolName {
  return (CODE_INDEX_TOOL_NAMES as readonly string[]).includes(name);
}

/** JSON-schema `properties` shared by both declaration shapes. */
export const CODE_INDEX_TOOL_SCHEMAS: Record<CodeIndexToolName, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  dev_index_query: {
    description: 'Query the precomputed codebase index (Graphify graph + RepoWise facts, rebuilt on every merge to main): finds the symbols/files matching a question, symbol name or path and returns what each one imports/calls/contains and what imports/calls it. Use this BEFORE reading files to locate the right ones. Read-only.',
    properties: {
      query: { type: 'string', description: 'A symbol name, a file path (or suffix), or a few descriptive words, e.g. "dev-autopilot-watcher merge_sha" or "buildCiFailureReason"' },
      depth: { type: 'integer', description: '1 (default) = direct neighbours; 2 = also who calls the seeds\' callees' },
      budget_chars: { type: 'integer', description: `Output budget in characters (default ${CODE_INDEX_QUERY_BUDGET_CHARS}, max ${CODE_INDEX_QUERY_MAX_BUDGET_CHARS})` },
      repo: { type: 'string', description: `Which repo's index: ${ALLOWED_CODE_INDEX_REPOS.join(' or ')} (default exafyltd/vitana-platform)` },
    },
    required: ['query'],
  },
  dev_graph_path: {
    description: 'Shortest dependency/call path between two nodes of the codebase index (files, symbols) — how does A reach B. Names resolve by exact id, exact label, file path, or suffix. Read-only.',
    properties: {
      source: { type: 'string', description: 'Source symbol or file path' },
      target: { type: 'string', description: 'Target symbol or file path' },
      repo: { type: 'string', description: `Which repo's index: ${ALLOWED_CODE_INDEX_REPOS.join(' or ')} (default exafyltd/vitana-platform)` },
    },
    required: ['source', 'target'],
  },
  dev_get_risk: {
    description: 'Change-risk facts for one file from the codebase index: commit history and 90-day churn, bug fixes, ownership/bus factor, hotspot flag, import fan-in (which files import it), co-change partners and dead-code candidates. Call it before editing any shared or central file. Read-only.',
    properties: {
      path: { type: 'string', description: 'Repo-root-relative file path, e.g. services/gateway/src/services/dev-autopilot-watcher.ts' },
      repo: { type: 'string', description: `Which repo's index: ${ALLOWED_CODE_INDEX_REPOS.join(' or ')} (default exafyltd/vitana-platform)` },
    },
    required: ['path'],
  },
};

/** The three tools in the router's provider-neutral shape (agent executor). */
export function codeIndexRouterTools(): LLMRouterTool[] {
  return CODE_INDEX_TOOL_NAMES.map((name) => ({
    name,
    description: CODE_INDEX_TOOL_SCHEMAS[name].description,
    inputSchema: { type: 'object', properties: CODE_INDEX_TOOL_SCHEMAS[name].properties, required: CODE_INDEX_TOOL_SCHEMAS[name].required },
  }));
}

export interface CodeIndexToolOutcome {
  ok: boolean;
  text: string;
  data?: Record<string, unknown>;
}

/** Runs one of the three tools against an already-loaded bundle. Pure. */
export function runCodeIndexTool(name: CodeIndexToolName, args: Record<string, unknown>, b: CodeIndexBundle): CodeIndexToolOutcome {
  switch (name) {
    case 'dev_index_query': {
      const q = typeof args.query === 'string' ? args.query : '';
      const r = indexQuery(b, q, {
        depth: Number(args.depth) === 2 ? 2 : 1,
        budgetChars: typeof args.budget_chars === 'number' ? args.budget_chars : undefined,
      });
      return { ok: r.ok, text: r.text, data: { seeds: r.seeds, tokens: r.tokens, nodes_touched: r.nodes_touched, truncated: r.truncated, sha: b.sha } };
    }
    case 'dev_graph_path': {
      const r = graphPath(b, String(args.source || ''), String(args.target || ''));
      return { ok: r.ok, text: r.text, data: { found: r.found, hops: r.hops, sha: b.sha } };
    }
    case 'dev_get_risk': {
      const r = getRisk(b, String(args.path || ''));
      return { ok: r.ok, text: r.text, data: { found: r.found, dependents_count: r.dependents_count ?? 0, importers: r.importers ?? [], sha: b.sha } };
    }
    default:
      return { ok: false, text: `unknown code index tool ${String(name)}` };
  }
}
