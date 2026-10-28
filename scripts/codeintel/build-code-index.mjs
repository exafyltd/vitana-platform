#!/usr/bin/env node
/**
 * VTID-04229 — build the S3 code-index bundle every agent reads.
 *
 * Input:  graphify-out/graph.json (Graphify) and the RepoWise JSON export
 *         (`repowise export --format json --full` → wiki_pages.json).
 * Output: a directory holding
 *           manifest.json        — repo, sha, built_at, counts, file list
 *           graph-index.json.gz  — compact node table + adjacency lists
 *           risk-index.json.gz   — per-file history/hotspot/dead-code facts
 *
 * Why a derived bundle and not the raw artifacts: graph.json is ~50 MB and
 * the RepoWise database is a 250 MB SQLite file that needs the `repowise`
 * CLI — which cannot be installed in the gateway's Alpine image at all
 * (`lancedb` has no musl wheel; VTID-04222 §3). Both agents (gateway
 * Operator Console, ECS executor) therefore query a small, self-contained
 * JSON index the CI job (CODEINTEL-INDEX.yml) builds on an ubuntu runner
 * and publishes to s3://vitana-code-index/<repo>/<sha>/ (+ latest/).
 *
 * No dependencies beyond Node ≥ 18 — this runs on a CI runner and in tests.
 *
 *   node scripts/codeintel/build-code-index.mjs \
 *     --graph graphify-out/graph.json \
 *     --export .repowise/export/wiki_pages.json \
 *     --repo exafyltd/vitana-platform --sha <commit> --out out/
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const BUNDLE_FORMAT_VERSION = 1;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

/**
 * Compact the Graphify graph: nodes become [id, label, kind, file, loc,
 * fileType]; links become [sourceIdx, targetIdx, relationIdx]. Node ids are
 * kept verbatim (they are stable slugs Graphify derives from paths), labels
 * and files are what queries match on.
 */
export function buildGraphIndex(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph?.links) ? graph.links : [];
  const idToIdx = new Map();
  const outNodes = [];
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') continue;
    if (idToIdx.has(n.id)) continue;
    idToIdx.set(n.id, outNodes.length);
    outNodes.push([
      n.id,
      typeof n.label === 'string' ? n.label : n.id,
      (n.metadata && typeof n.metadata.kind === 'string') ? n.metadata.kind : '',
      typeof n.source_file === 'string' ? n.source_file : '',
      typeof n.source_location === 'string' ? n.source_location : '',
      typeof n.file_type === 'string' ? n.file_type : '',
    ]);
  }
  const relations = [];
  const relIdx = new Map();
  const edges = [];
  let dropped = 0;
  const seen = new Set();
  for (const l of links) {
    const s = idToIdx.get(l?.source);
    const t = idToIdx.get(l?.target);
    if (s === undefined || t === undefined) { dropped++; continue; }
    const rel = typeof l.relation === 'string' ? l.relation : 'related';
    let r = relIdx.get(rel);
    if (r === undefined) { r = relations.length; relations.push(rel); relIdx.set(rel, r); }
    const key = `${s}:${t}:${r}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([s, t, r]);
  }
  return { format: BUNDLE_FORMAT_VERSION, nodes: outNodes, relations, edges, dropped_edges: dropped };
}

const HISTORY_RE = /(\d+) commits? in its history, (\d+) in the last 90 days\.(?: The last landed on (\d{4}-\d{2}-\d{2})\.)?/;
const OWNER_RE = /\*\*([^*]+)\*\* is its primary maintainer, at (\d+)% of commits/;
const BUGFIX_RE = /(\d+) bug fix(?:es)?/;
const LAYER_RE = /\*\*Layer:\*\*\s*([^|\n]+?)\s*(?:\||\n)/;
const ROLE_RE = /\*\*Role:\*\*\s*([^\n]+)/;
const SYMBOLS_RE = /It exposes (\d+) public symbols?/;

function section(content, title) {
  const i = content.indexOf(`## ${title}`);
  if (i < 0) return '';
  const j = content.indexOf('\n## ', i + 3);
  return content.slice(i, j < 0 ? content.length : j);
}

function listedPaths(sectionText) {
  const out = [];
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(sectionText))) {
    const p = m[1];
    if (p.includes('/') || p.includes('.')) out.push(p);
  }
  return Array.from(new Set(out)).slice(0, 40);
}

/**
 * Per-file facts from the RepoWise export. Only `file_page` pages are
 * used (one per source file); module/spotlight pages are navigation, not
 * risk. The prose is RepoWise's own template output, so the regexes are
 * pinned by a test against a real page.
 */
export function buildRiskIndex(exported) {
  const pages = Array.isArray(exported?.pages) ? exported.pages : [];
  const hotspots = Array.isArray(exported?.hotspots) ? exported.hotspots : [];
  const dead = Array.isArray(exported?.dead_code) ? exported.dead_code : [];
  const decisions = Array.isArray(exported?.decisions) ? exported.decisions : [];
  const files = {};
  for (const p of pages) {
    if (p?.page_type !== 'file_page' || typeof p.target_path !== 'string') continue;
    const c = typeof p.content === 'string' ? p.content : '';
    const hist = c.match(HISTORY_RE);
    const owner = c.match(OWNER_RE);
    const bug = c.match(BUGFIX_RE);
    const layer = c.match(LAYER_RE);
    const role = c.match(ROLE_RE);
    const syms = c.match(SYMBOLS_RE);
    const overview = section(c, 'Overview').split('\n').slice(2).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    files[p.target_path] = {
      commits_total: hist ? Number(hist[1]) : null,
      commits_90d: hist ? Number(hist[2]) : null,
      last_commit: hist && hist[3] ? hist[3] : null,
      owner: owner ? owner[1] : null,
      owner_pct: owner ? Number(owner[2]) : null,
      bug_fixes: bug ? Number(bug[1]) : 0,
      hotspot: /change hotspots?/.test(c),
      layer: layer ? layer[1].trim() : null,
      role: role ? role[1].trim() : null,
      public_symbols: syms ? Number(syms[1]) : null,
      depends_on: listedPaths(section(c, 'Depends on')),
      used_by: listedPaths(section(c, 'Used by')),
      changes_together_with: listedPaths(section(c, 'Changes together with')),
      overview,
    };
  }
  const hot = {};
  for (const h of hotspots) {
    if (!h || typeof h.file_path !== 'string') continue;
    hot[h.file_path] = {
      churn_percentile: typeof h.churn_percentile === 'number' ? Number(h.churn_percentile.toFixed(4)) : null,
      commit_count_90d: h.commit_count_90d ?? null,
      primary_owner: h.primary_owner ?? null,
      bus_factor: h.bus_factor ?? null,
    };
  }
  const deadByFile = {};
  for (const d of dead) {
    if (!d || typeof d.file_path !== 'string') continue;
    (deadByFile[d.file_path] ||= []).push({
      symbol: d.symbol_name ?? null,
      kind: d.kind ?? null,
      confidence: d.confidence ?? null,
      safe_to_delete: !!d.safe_to_delete,
    });
  }
  return {
    format: BUNDLE_FORMAT_VERSION,
    files,
    hotspots: hot,
    dead_code: deadByFile,
    decisions: decisions.slice(0, 50).map((d) => ({
      title: String(d?.title || '').slice(0, 200),
      status: d?.status ?? null,
      decision: String(d?.decision || '').slice(0, 1200),
    })),
  };
}

export function buildManifest({ repo, sha, graphIndex, riskIndex, builtAt }) {
  return {
    format: BUNDLE_FORMAT_VERSION,
    repo,
    sha,
    built_at: builtAt || new Date().toISOString(),
    files: { graph: 'graph-index.json.gz', risk: 'risk-index.json.gz' },
    counts: {
      nodes: graphIndex.nodes.length,
      edges: graphIndex.edges.length,
      relations: graphIndex.relations.length,
      risk_files: Object.keys(riskIndex.files).length,
      hotspots: Object.keys(riskIndex.hotspots).length,
      dead_code_files: Object.keys(riskIndex.dead_code).length,
      decisions: riskIndex.decisions.length,
    },
  };
}

export async function buildBundle({ graphPath, exportPath, repo, sha, outDir, builtAt }) {
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const exported = exportPath ? JSON.parse(await fs.readFile(exportPath, 'utf8')) : { pages: [], hotspots: [], dead_code: [], decisions: [] };
  const graphIndex = buildGraphIndex(graph);
  const riskIndex = buildRiskIndex(exported);
  const manifest = buildManifest({ repo, sha, graphIndex, riskIndex, builtAt });
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'graph-index.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(graphIndex)), { level: 9 }));
  await fs.writeFile(path.join(outDir, 'risk-index.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(riskIndex)), { level: 9 }));
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const graphPath = args.graph || 'graphify-out/graph.json';
  const exportPath = args.export || '';
  const repo = args.repo;
  const sha = args.sha;
  const outDir = args.out || 'code-index-out';
  if (!repo || !sha) {
    console.error('usage: build-code-index.mjs --graph <graph.json> [--export <wiki_pages.json>] --repo <owner/name> --sha <commit> --out <dir>');
    process.exit(2);
  }
  buildBundle({ graphPath, exportPath: exportPath || undefined, repo, sha, outDir })
    .then((m) => { console.log(JSON.stringify(m, null, 2)); })
    .catch((err) => { console.error(`build-code-index failed: ${err?.stack || err}`); process.exit(1); });
}
