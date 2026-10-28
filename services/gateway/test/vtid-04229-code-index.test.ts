/**
 * VTID-04229 — the S3-published codebase index every agent reads.
 *
 * Pins: the bundle builder (scripts/codeintel/build-code-index.mjs) against
 * a fixture Graphify graph + RepoWise export; the loader (dir source,
 * latest/ pointer, cache-by-sha, honest errors); the three pure queries;
 * the tool surface on both agents (Operator Console wiring incl. the
 * dev_repowise/dev_graphify not_configured fallback; executor tool
 * declaration + dispatch + workspace pull); and the CI/provisioning
 * contract (workflow publishes both repos to the bucket, latest/ last;
 * setup script is dry-run by default).
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ describeEcsServices: jest.fn(), ALLOWED_ECS_SERVICES: ['vitana-gateway'], ALLOWED_ECS_TASK_FAMILIES: ['vitana-autopilot-executor'], TASKS_DEFAULT_LIMIT: 10, TASKS_MAX_LIMIT: 25, listEcsTasks: jest.fn() }));
jest.mock('../src/services/aws-cloudwatch-logs-readonly', () => ({ filterVitanaLogs: jest.fn(), ALLOWED_LOG_GROUP_RE: /^\/ecs\/vitana-[a-z0-9-]{2,60}$/, LOGS_DEFAULT_MINUTES: 30, LOGS_MAX_MINUTES: 1440, LOGS_DEFAULT_LIMIT: 50, LOGS_MAX_LIMIT: 200 }));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: unknown[]) => (execFileMock as any)(...args) }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
const { execFileSync } = jest.requireActual('child_process') as typeof import('child_process');
import {
  assembleBundle, clearCodeIndexCache, dirSource, getRisk, graphPath, indexQuery, loadCodeIndex, resolveCodeIndexRepo, resolveCodeIndexSource,
  resolveNode, runCodeIndexTool, tokenize, codeIndexRouterTools, CODE_INDEX_TOOL_NAMES, type CodeIndexManifest, type GraphIndexData, type RiskIndexData,
} from '../src/services/codeintel-index';
import { AGENT_TOOLS, CODE_INDEX_TOOLS, agentToolsFor, executeAgentTool } from '../src/services/autopilot-agent/agent-tools';
import { pullCodeIndex, isAgentCodeIndexEnabled } from '../src/services/autopilot-agent/agent-workspace';
import { buildAgentSystemPrompt } from '../src/services/autopilot-agent/agent-prompt';
import { executeTool, setThreadIdentity } from '../src/services/gemini-operator';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts/codeintel/build-code-index.mjs');

// ---------------------------------------------------------------- fixture

const FIXTURE_GRAPH = {
  nodes: [
    { id: 'svc_watcher', label: 'dev-autopilot-watcher.ts', file_type: 'code', source_file: 'services/gateway/src/services/dev-autopilot-watcher.ts', source_location: 'L1', metadata: { kind: 'file' } },
    { id: 'svc_watcher_reason', label: 'buildCiFailureReason()', file_type: 'code', source_file: 'services/gateway/src/services/dev-autopilot-watcher.ts', source_location: 'L233', metadata: {} },
    { id: 'svc_watcher_tick', label: 'ciWatcherTick()', file_type: 'code', source_file: 'services/gateway/src/services/dev-autopilot-watcher.ts', source_location: 'L425', metadata: {} },
    { id: 'svc_github', label: 'github-service.ts', file_type: 'code', source_file: 'services/gateway/src/services/github-service.ts', source_location: 'L1', metadata: { kind: 'file' } },
    { id: 'svc_github_merge', label: 'mergePullRequest()', file_type: 'code', source_file: 'services/gateway/src/services/github-service.ts', source_location: 'L80', metadata: {} },
    { id: 'test_watcher', label: 'dev-autopilot-watcher-failure-reason.test.ts', file_type: 'code', source_file: 'services/gateway/test/dev-autopilot-watcher-failure-reason.test.ts', source_location: 'L1', metadata: { kind: 'file' } },
    { id: 'doc_changelog', label: 'CHANGE LOG', file_type: 'document', source_file: 'CLAUDE.md', source_location: 'L2186', metadata: {} },
    { id: 'orphan', label: 'orphan-thing.ts', file_type: 'code', source_file: 'scripts/orphan-thing.ts', source_location: 'L1', metadata: { kind: 'file' } },
  ],
  links: [
    { source: 'svc_watcher', target: 'svc_watcher_reason', relation: 'contains' },
    { source: 'svc_watcher', target: 'svc_watcher_tick', relation: 'contains' },
    { source: 'svc_watcher_tick', target: 'svc_watcher_reason', relation: 'calls' },
    { source: 'svc_watcher', target: 'svc_github', relation: 'imports_from' },
    { source: 'svc_watcher_tick', target: 'svc_github_merge', relation: 'calls' },
    { source: 'svc_github', target: 'svc_github_merge', relation: 'contains' },
    { source: 'test_watcher', target: 'svc_watcher_reason', relation: 'imports' },
    { source: 'doc_changelog', target: 'svc_watcher_reason', relation: 'references' },
    { source: 'svc_watcher', target: 'svc_watcher_reason', relation: 'contains' }, // duplicate edge — must be deduped
    { source: 'svc_watcher', target: 'ghost', relation: 'calls' }, // dangling — must be dropped
  ],
};

const WATCHER_PAGE = `# services/gateway/src/services/dev-autopilot-watcher.ts

## Overview

Gateway Services module dev-autopilot-watcher defining ciWatcherTick, buildCiFailureReason. It exposes 9 public symbols.

## History

41 commits in its history, 12 in the last 90 days. The last landed on 2026-09-21. **exafyltd** is its primary maintainer, at 100% of commits. It is one of the repository's change hotspots. 3 bug fixes.

## Depends on

- \`services/gateway/src/services/github-service.ts\`
- \`services/gateway/src/services/oasis-event-service.ts\`

## Used by

- \`services/gateway/src/index.ts\`

## Changes together with

- \`services/gateway/test/dev-autopilot-watcher-failure-reason.test.ts\`

## Usage Notes

**Layer:** Gateway Services | **Role:** internal module
`;

const FIXTURE_EXPORT = {
  pages: [
    { page_type: 'file_page', target_path: 'services/gateway/src/services/dev-autopilot-watcher.ts', content: WATCHER_PAGE },
    { page_type: 'module_page', target_path: 'services/gateway/src/services', content: '# module' },
    { page_type: 'file_page', target_path: 'services/gateway/src/services/github-service.ts', content: '# x\n\n## History\n\n5 commits in its history, 1 in the last 90 days. The last landed on 2026-08-01. **someone** is its primary maintainer, at 60% of commits.\n' },
  ],
  hotspots: [{ file_path: 'services/gateway/src/services/dev-autopilot-watcher.ts', churn_percentile: 0.98765, commit_count_90d: 12, primary_owner: 'exafyltd', bus_factor: 1 }],
  dead_code: [{ file_path: 'services/gateway/src/services/github-service.ts', symbol_name: 'unusedHelper', kind: 'unused_export', confidence: 0.65, safe_to_delete: false }],
  decisions: [{ title: 'ADR: something', status: 'proposed', decision: 'We decided.' }],
};

let tmp: string;
let bundleDir: string;
let localRoot: string;
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

function readGz<T>(p: string): T { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')) as T; }

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-04229-'));
  fs.writeFileSync(path.join(tmp, 'graph.json'), JSON.stringify(FIXTURE_GRAPH));
  fs.writeFileSync(path.join(tmp, 'export.json'), JSON.stringify(FIXTURE_EXPORT));
  bundleDir = path.join(tmp, 'bundle');
  execFileSync('node', [BUILD_SCRIPT, '--graph', path.join(tmp, 'graph.json'), '--export', path.join(tmp, 'export.json'), '--repo', 'exafyltd/vitana-platform', '--sha', SHA, '--out', bundleDir], { stdio: 'pipe' });
  // lay out a local "bucket": <repo>/<sha>/... + <repo>/latest/manifest.json
  localRoot = path.join(tmp, 'bucket');
  const shaDir = path.join(localRoot, 'exafyltd/vitana-platform', SHA);
  fs.mkdirSync(shaDir, { recursive: true });
  fs.mkdirSync(path.join(localRoot, 'exafyltd/vitana-platform/latest'), { recursive: true });
  for (const f of fs.readdirSync(bundleDir)) fs.copyFileSync(path.join(bundleDir, f), path.join(shaDir, f));
  fs.copyFileSync(path.join(bundleDir, 'manifest.json'), path.join(localRoot, 'exafyltd/vitana-platform/latest/manifest.json'));
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { clearCodeIndexCache(); execFileMock.mockReset(); });

// ---------------------------------------------------------------- builder

describe('VTID-04229 build-code-index.mjs (the CI bundle builder)', () => {
  it('writes manifest + gzipped graph and risk indexes with counts', () => {
    const m = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as CodeIndexManifest;
    expect(m.repo).toBe('exafyltd/vitana-platform');
    expect(m.sha).toBe(SHA);
    expect(m.files).toEqual({ graph: 'graph-index.json.gz', risk: 'risk-index.json.gz' });
    expect(m.counts.nodes).toBe(8);
    // 10 links → 1 duplicate deduped, 1 dangling dropped
    expect(m.counts.edges).toBe(8);
    expect(m.counts.risk_files).toBe(2);
    expect(m.counts.hotspots).toBe(1);
    expect(m.counts.decisions).toBe(1);
  });

  it('compacts nodes to [id,label,kind,file,loc,fileType] and edges to index triples', () => {
    const g = readGz<GraphIndexData>(path.join(bundleDir, 'graph-index.json.gz'));
    expect(g.nodes[0]).toEqual(['svc_watcher', 'dev-autopilot-watcher.ts', 'file', 'services/gateway/src/services/dev-autopilot-watcher.ts', 'L1', 'code']);
    expect(g.relations).toEqual(expect.arrayContaining(['contains', 'calls', 'imports_from', 'imports', 'references']));
    for (const e of g.edges) { expect(e).toHaveLength(3); expect(e[0]).toBeLessThan(g.nodes.length); expect(e[1]).toBeLessThan(g.nodes.length); }
  });

  it('parses RepoWise file-page prose into per-file risk facts (history, owner, bug fixes, hotspot, layer, neighbours)', () => {
    const r = readGz<RiskIndexData>(path.join(bundleDir, 'risk-index.json.gz'));
    const w = r.files['services/gateway/src/services/dev-autopilot-watcher.ts'];
    expect(w).toMatchObject({ commits_total: 41, commits_90d: 12, last_commit: '2026-09-21', owner: 'exafyltd', owner_pct: 100, bug_fixes: 3, hotspot: true, layer: 'Gateway Services', role: 'internal module', public_symbols: 9 });
    expect(w.depends_on).toEqual(['services/gateway/src/services/github-service.ts', 'services/gateway/src/services/oasis-event-service.ts']);
    expect(w.used_by).toEqual(['services/gateway/src/index.ts']);
    expect(w.changes_together_with).toEqual(['services/gateway/test/dev-autopilot-watcher-failure-reason.test.ts']);
    expect(r.files['services/gateway/src/services/github-service.ts']).toMatchObject({ commits_total: 5, owner: 'someone', owner_pct: 60, bug_fixes: 0, hotspot: false });
    expect(r.hotspots['services/gateway/src/services/dev-autopilot-watcher.ts']).toMatchObject({ churn_percentile: 0.9877, bus_factor: 1 });
    expect(r.dead_code['services/gateway/src/services/github-service.ts']).toEqual([{ symbol: 'unusedHelper', kind: 'unused_export', confidence: 0.65, safe_to_delete: false }]);
    expect(Object.keys(r.files)).not.toContain('services/gateway/src/services'); // module pages are not risk records
  });
});

// ---------------------------------------------------------------- loader

describe('VTID-04229 loadCodeIndex (dir source, latest pointer, cache)', () => {
  it('resolves latest/manifest.json → <sha>/ bundle and assembles adjacency + label/file indexes', async () => {
    const { bundle, fromCache } = await loadCodeIndex('exafyltd/vitana-platform', { source: dirSource(localRoot) });
    expect(fromCache).toBe(false);
    expect(bundle.sha).toBe(SHA);
    expect(bundle.graph.nodes).toHaveLength(8);
    expect(bundle.byLabel.get('buildcifailurereason()')).toEqual([1]);
    expect(bundle.byFile.get('services/gateway/src/services/dev-autopilot-watcher.ts')![0]).toBe(0); // the file node first
    expect(bundle.out[0].length).toBe(3); // contains ×2 + imports_from
    expect(bundle.inn[1].length).toBe(4); // contains, calls, imports, references
  });

  it('serves from cache within the TTL and re-validates the sha after it (same sha → still cached)', async () => {
    let now = 1_000_000;
    const src = dirSource(localRoot);
    const a = await loadCodeIndex('exafyltd/vitana-platform', { source: src, ttlMs: 1000, now: () => now });
    const b = await loadCodeIndex('exafyltd/vitana-platform', { source: src, ttlMs: 1000, now: () => now + 10 });
    expect(b.fromCache).toBe(true);
    expect(b.bundle).toBe(a.bundle);
    now += 5000;
    const c = await loadCodeIndex('exafyltd/vitana-platform', { source: src, ttlMs: 1000, now: () => now });
    expect(c.fromCache).toBe(true); // manifest re-read, same sha, bundle reused
    expect(c.bundle).toBe(a.bundle);
  });

  it('reports a plain reason when the index was never published, and refuses an unknown repo', async () => {
    const empty = fs.mkdtempSync(path.join(tmp, 'empty-'));
    await expect(loadCodeIndex('exafyltd/vitana-v1', { source: dirSource(empty) })).rejects.toThrow(/not published for exafyltd\/vitana-v1/);
    await expect(loadCodeIndex('someone/else', { source: dirSource(localRoot) })).rejects.toThrow(/repo must be one of/);
    expect(resolveCodeIndexRepo(undefined)).toBe('exafyltd/vitana-platform');
    expect(resolveCodeIndexRepo('exafyltd/vitana-v1')).toBe('exafyltd/vitana-v1');
    expect(resolveCodeIndexRepo('x/y')).toBeNull();
  });

  it('picks the local dir over S3 when CODE_INDEX_LOCAL_DIR is set, else the bucket in the resolved region', () => {
    expect(resolveCodeIndexSource({ CODE_INDEX_LOCAL_DIR: '/x' } as any).describe()).toBe('dir:/x');
    expect(resolveCodeIndexSource({} as any).describe()).toBe('s3://vitana-code-index (eu-central-1)');
    expect(resolveCodeIndexSource({ CODE_INDEX_BUCKET: 'b', AWS_REGION: 'eu-north-1' } as any).describe()).toBe('s3://b (eu-north-1)');
  });
});

// ---------------------------------------------------------------- queries

describe('VTID-04229 pure queries over the bundle', () => {
  async function bundle() { return (await loadCodeIndex('exafyltd/vitana-platform', { source: dirSource(localRoot) })).bundle; }

  it('tokenize drops stop words and short tokens, keeps identifiers and their parts', () => {
    expect(tokenize('where is buildCiFailureReason used in the watcher')).toEqual(expect.arrayContaining(['buildcifailurereason', 'watcher']));
    expect(tokenize('the and for')).toEqual([]);
    expect(tokenize('dev-autopilot-watcher merge_sha')).toEqual(expect.arrayContaining(['dev-autopilot-watcher', 'autopilot', 'watcher', 'merge_sha', 'merge']));
  });

  it('indexQuery finds the symbol, its container, callers, importing tests and referencing docs', async () => {
    const r = indexQuery(await bundle(), 'buildCiFailureReason');
    expect(r.ok).toBe(true);
    expect(r.seeds[0].label).toBe('buildCiFailureReason()');
    expect(r.text).toContain('← calls ciWatcherTick()');
    expect(r.text).toContain('← contains dev-autopilot-watcher.ts');
    expect(r.text).toContain('← imports dev-autopilot-watcher-failure-reason.test.ts');
    expect(r.text).toContain('← references CHANGE LOG (document) — CLAUDE.md:L2186');
    expect(r.nodes_touched).toBeGreaterThanOrEqual(5);
  });

  it('indexQuery honours the budget and says so; an empty/no-match query is reported not invented', async () => {
    const b = await bundle();
    const tight = indexQuery(b, 'dev-autopilot-watcher', { budgetChars: 800 });
    expect(tight.truncated).toBe(true);
    expect(tight.text).toContain('budget reached');
    expect(tight.text.length).toBeLessThanOrEqual(900);
    expect(indexQuery(b, 'zzz-nothing-like-this').text).toMatch(/no index node matches/);
    expect(indexQuery(b, 'the').ok).toBe(false); // stop-words only → no tokens → refused, not a full-graph scan
  });

  it('graphPath resolves by file path, label or suffix and walks the undirected graph', async () => {
    const b = await bundle();
    const p = graphPath(b, 'services/gateway/src/services/dev-autopilot-watcher-failure-reason.test.ts'.replace('src/services/', 'test/'), 'mergePullRequest()');
    expect(p.found).toBe(true);
    // test → (imports) buildCiFailureReason ← (calls) ciWatcherTick → (calls) mergePullRequest
    expect(p.hops).toBe(3);
    expect(p.text).toContain('—imports→ buildCiFailureReason()');
    expect(p.text).toContain('←calls— ciWatcherTick()');
    expect(p.text).toContain('—calls→ mergePullRequest()');
    expect(graphPath(b, 'github-service.ts', 'orphan-thing.ts').found).toBe(false);
    const miss = graphPath(b, 'no-such-node-anywhere', 'github-service.ts');
    expect(miss.ok).toBe(false);
    expect(miss.text).toMatch(/could not resolve "no-such-node-anywhere"/);
    expect(resolveNode(b, 'watcher.ts').idx).toBe(0); // suffix match on the file path
  });

  it('getRisk merges RepoWise facts with the graph import fan-in, and names closest paths on a miss', async () => {
    const b = await bundle();
    const r = getRisk(b, 'services/gateway/src/services/github-service.ts');
    expect(r.found).toBe(true);
    expect(r.dependents_count).toBe(1);
    expect(r.importers).toEqual(['services/gateway/src/services/dev-autopilot-watcher.ts']);
    expect(r.text).toContain('5 commits total, 1 in 90d, last 2026-08-01; 0 bug fix(es)');
    expect(r.text).toContain('dead-code candidates: unusedHelper (0.65)');
    const w = getRisk(b, './services/gateway/src/services/dev-autopilot-watcher.ts');
    expect(w.text).toContain('CHANGE HOTSPOT');
    expect(w.text).toContain('bus factor 1');
    expect(w.text).toContain('co-changes with: services/gateway/test/dev-autopilot-watcher-failure-reason.test.ts');
    expect(w.text).toContain('churn percentile 0.9877');
    const miss = getRisk(b, 'github-service.ts');
    expect(miss.found).toBe(false);
    expect(miss.text).toContain('closest: services/gateway/src/services/github-service.ts');
    // graph-only file (no RepoWise page)
    const o = getRisk(b, 'scripts/orphan-thing.ts');
    expect(o.found).toBe(true);
    expect(o.text).toContain('RepoWise page not in export');
  });

  it('runCodeIndexTool dispatches the three names and rejects an unknown one', async () => {
    const b = await bundle();
    expect(runCodeIndexTool('dev_index_query', { query: 'ciWatcherTick', depth: 2 }, b).ok).toBe(true);
    expect(runCodeIndexTool('dev_graph_path', { source: 'dev-autopilot-watcher.ts', target: 'github-service.ts' }, b).data).toMatchObject({ found: true, hops: 1 });
    expect(runCodeIndexTool('dev_get_risk', { path: 'scripts/orphan-thing.ts' }, b).ok).toBe(true);
    expect(runCodeIndexTool('nope' as any, {}, b).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- executor surface

describe('VTID-04229 executor: tool declaration, pull, dispatch, prompt', () => {
  it('declares the three tools only when a bundle is present; names are shared with the operator', () => {
    expect(CODE_INDEX_TOOLS.map((t) => t.name)).toEqual([...CODE_INDEX_TOOL_NAMES]);
    expect(codeIndexRouterTools().every((t) => t.inputSchema && (t.inputSchema as any).type === 'object')).toBe(true);
    expect(agentToolsFor({ codeIndex: null })).toBe(AGENT_TOOLS);
    expect(agentToolsFor({ codeIndex: {} as any }).map((t) => t.name)).toEqual([...AGENT_TOOLS.map((t) => t.name), ...CODE_INDEX_TOOL_NAMES]);
  });

  it('pullCodeIndex loads through the shared loader, reports stats, and fails open with the loader reason', async () => {
    const ok = await pullCodeIndex('exafyltd/vitana-platform', { env: { CODE_INDEX_LOCAL_DIR: localRoot } as any });
    expect(ok.bundle?.sha).toBe(SHA);
    expect(ok.stats).toMatchObject({ enabled: true, sha: SHA, nodes: 8, edges: 8, risk_files: 2, error: null });
    expect(ok.describe).toMatch(/^code index exafyltd\/vitana-platform@abcdef012345/);
    const empty = fs.mkdtempSync(path.join(tmp, 'empty2-'));
    const bad = await pullCodeIndex('exafyltd/vitana-platform', { env: { CODE_INDEX_LOCAL_DIR: empty } as any });
    expect(bad.bundle).toBeNull();
    expect(bad.stats.error).toMatch(/not published/);
    const off = await pullCodeIndex('exafyltd/vitana-platform', { env: { AGENT_CODE_INDEX_ENABLED: 'false' } as any });
    expect(off.stats.enabled).toBe(false);
    expect(off.bundle).toBeNull();
    expect(isAgentCodeIndexEnabled({} as any)).toBe(true);
    expect(isAgentCodeIndexEnabled({ AGENT_CODE_INDEX_ENABLED: 'FALSE' } as any)).toBe(false);
  });

  it('executeAgentTool answers the index tools from the bundle and refuses honestly without one', async () => {
    const { bundle } = await loadCodeIndex('exafyltd/vitana-platform', { source: dirSource(localRoot) });
    const ctx = { root: tmp, runCheck: async () => ({ ok: true, exit_code: 0, output: '' }), codeIndex: bundle };
    const q = await executeAgentTool('dev_index_query', { query: 'ciWatcherTick' }, ctx);
    expect(q.isError).toBeFalsy();
    expect(q.result).toContain('ciWatcherTick()');
    const r = await executeAgentTool('dev_get_risk', { path: 'services/gateway/src/services/github-service.ts' }, ctx);
    expect(r.result).toContain('import fan-in (graph): 1 file(s)');
    const none = await executeAgentTool('dev_graph_path', { source: 'a', target: 'b' }, { ...ctx, codeIndex: null });
    expect(none.isError).toBe(true);
    expect(none.result).toMatch(/not available in this run/);
  });

  it('the system prompt tells the model to use the index first, only when one loaded', () => {
    const base = { repo: 'exafyltd/vitana-platform', baseBranch: 'main', branch: 'b', vtid: 'VTID-04229', allowScope: ['x'], denyScope: ['y'], conventions: 'c', claudeMdExcerpt: 'm' };
    expect(buildAgentSystemPrompt({ ...base, codeIndex: 'code index exafyltd/vitana-platform@abc built now' })).toContain('call dev_index_query FIRST');
    expect(buildAgentSystemPrompt(base)).not.toContain('dev_index_query');
  });

  it('the runner wires the pull before the prompt and passes the per-run tool list to every router call (source contract)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'services/gateway/src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');
    expect(src).toContain("name: 'runner:code_index'");
    expect(src).toContain('codeIndex: codeIndex.describe || undefined');
    expect(src).toContain('const runTools = agentToolsFor(toolCtx)');
    expect(src).not.toMatch(/tools: AGENT_TOOLS/);
    expect(src.indexOf('pullCodeIndex(')).toBeLessThan(src.indexOf('buildAgentSystemPrompt({'));
  });
});

// ---------------------------------------------------------------- operator surface

describe('VTID-04229 Operator Console: dev_index_query / dev_graph_path / dev_get_risk', () => {
  const prevEnabled = process.env.OPERATOR_CODEINTEL_ENABLED;
  const prevDir = process.env.CODE_INDEX_LOCAL_DIR;
  beforeEach(() => {
    process.env.OPERATOR_CODEINTEL_ENABLED = 'true';
    process.env.CODE_INDEX_LOCAL_DIR = localRoot;
    setThreadIdentity('t-04229', { user_id: 'u', role: 'developer' } as any);
  });
  afterAll(() => {
    if (prevEnabled === undefined) delete process.env.OPERATOR_CODEINTEL_ENABLED; else process.env.OPERATOR_CODEINTEL_ENABLED = prevEnabled;
    if (prevDir === undefined) delete process.env.CODE_INDEX_LOCAL_DIR; else process.env.CODE_INDEX_LOCAL_DIR = prevDir;
  });

  it('refuses all three when OPERATOR_CODEINTEL_ENABLED is not "true"', async () => {
    delete process.env.OPERATOR_CODEINTEL_ENABLED;
    for (const name of CODE_INDEX_TOOL_NAMES) {
      const r = await executeTool(name, { query: 'x', source: 'a', target: 'b', path: 'p' }, 't-04229');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/operator_codeintel_disabled/);
    }
  });

  it('answers from the published bundle with the sha and the index description', async () => {
    const q = await executeTool('dev_index_query', { query: 'buildCiFailureReason' }, 't-04229');
    expect(q.ok).toBe(true);
    expect(q.data).toMatchObject({ sha: SHA, truncated: false });
    expect(String(q.data!.text)).toContain('← calls ciWatcherTick()');
    expect(String(q.data!.index)).toMatch(/^code index exafyltd\/vitana-platform@/);
    const p = await executeTool('dev_graph_path', { source: 'dev-autopilot-watcher.ts', target: 'mergePullRequest()' }, 't-04229');
    expect(p.ok).toBe(true);
    expect(p.data).toMatchObject({ found: true, hops: 2 });
    const r = await executeTool('dev_get_risk', { path: 'services/gateway/src/services/dev-autopilot-watcher.ts' }, 't-04229');
    expect(r.ok).toBe(true);
    // the failure-reason test imports buildCiFailureReason → one importing file
    expect(r.data).toMatchObject({ found: true, dependents_count: 1, importers: ['services/gateway/test/dev-autopilot-watcher-failure-reason.test.ts'] });
    expect(String(r.data!.text)).toContain('CHANGE HOTSPOT');
  });

  it('reports the loader reason when nothing is published, and rejects an unknown repo before loading', async () => {
    process.env.CODE_INDEX_LOCAL_DIR = fs.mkdtempSync(path.join(tmp, 'empty3-'));
    const r = await executeTool('dev_index_query', { query: 'x' }, 't-04229');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/code index unavailable: code index not published/);
    const bad = await executeTool('dev_get_risk', { path: 'p', repo: 'some/other' }, 't-04229');
    expect(bad.error).toMatch(/repo must be one of/);
  });

  it('dev_repowise / dev_graphify fall back to the index when the CLI is not installed (not_configured)', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
      cb(Object.assign(new Error('spawn repowise ENOENT'), { code: 'ENOENT' }));
    });
    const risk = await executeTool('dev_repowise', { command: 'risk', argument: 'services/gateway/src/services/github-service.ts' }, 't-04229');
    expect(risk.ok).toBe(true);
    expect(String(risk.data!.served_by)).toMatch(/dev_get_risk \(S3 code index/);
    const ask = await executeTool('dev_repowise', { command: 'ask', argument: 'ciWatcherTick callers' }, 't-04229');
    expect(ask.ok).toBe(true);
    expect(String(ask.data!.text)).toContain('ciWatcherTick()');
    const pathR = await executeTool('dev_graphify', { command: 'path', argument: 'dev-autopilot-watcher.ts github-service.ts' }, 't-04229');
    expect(pathR.ok).toBe(true);
    expect(pathR.data).toMatchObject({ found: true, hops: 1 });
    // a real CLI error (not ENOENT) is still passed through verbatim
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
      cb(Object.assign(new Error('boom'), { stderr: 'index missing' }));
    });
    const real = await executeTool('dev_graphify', { command: 'query', argument: 'x' }, 't-04229');
    expect(real.ok).toBe(false);
    expect(real.error).toMatch(/index missing|boom/);
  });

  it('is declared on the wire schema for developers and gated off for everyone else', async () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'services/gateway/src/services/gemini-operator.ts'), 'utf8');
    expect(src).toContain('...CODE_INDEX_TOOL_NAMES.map((name) => ({');
    expect(src).toContain("case 'dev_index_query':");
    expect(src).toContain('dev_index_query BEFORE dev_search_codebase'); // the codebase-orientation prompt block
    setThreadIdentity('t-04229-community', { user_id: 'u2', role: 'community' } as any);
    const r = await executeTool('dev_index_query', { query: 'x' }, 't-04229-community');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- CI + provisioning contract

describe('VTID-04229 CODEINTEL-INDEX.yml + setup script', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/CODEINTEL-INDEX.yml'), 'utf8');
  const sh = fs.readFileSync(path.join(REPO_ROOT, 'scripts/aws/setup-code-index-bucket.sh'), 'utf8');

  it('runs on merge to main (and by hand), indexes both repos, never on a deploy path', () => {
    expect(wf).toMatch(/push:\n\s+branches: \[main\]/);
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).toContain('repo: [exafyltd/vitana-platform, exafyltd/vitana-v1]');
    expect(wf).toContain('fail-fast: false');
    expect(wf).not.toMatch(/aws ecs|update-service|register-task-definition/);
  });

  it('builds with the same commands the bundle expects and derives via the tracked script', () => {
    expect(wf).toContain('graphify update . --no-cluster');
    expect(wf).toContain('repowise init --no-prose -y');
    expect(wf).toContain('repowise export --format json --full -o .repowise/export');
    expect(wf).toContain('node tools/scripts/codeintel/build-code-index.mjs');
    expect(wf).toContain('fetch-depth: 0');
  });

  it('publishes via OIDC to <repo>/<sha>/ and writes latest/manifest.json LAST', () => {
    expect(wf).toContain('role-to-assume: ${{ secrets.AWS_PROD_ROLE_ARN }}');
    expect(wf).toContain('CODE_INDEX_BUCKET: vitana-code-index');
    const publish = wf.slice(wf.indexOf('name: Publish to S3'));
    const shaCp = publish.indexOf('$PREFIX/manifest.json');
    const latestCp = publish.indexOf('/latest/manifest.json');
    expect(shaCp).toBeGreaterThan(-1);
    expect(latestCp).toBeGreaterThan(shaCp);
    expect(publish).toContain('--content-encoding gzip');
  });

  it('the setup script is dry-run by default, refuses the wrong account, and grants read to the task role / publish to the CI role', () => {
    expect(sh).toContain('[ "${1:-}" = "--apply" ] && APPLY=1');
    expect(sh).toContain('ACCOUNT_ID="472838866351"');
    expect(sh).toContain('Refusing to provision into the wrong account');
    expect(sh).toContain('TASK_ROLE="${ECS_TASK_ROLE:-vitana-ecs-task-role}"');
    expect(sh).toContain('CI_ROLE="${CI_DEPLOY_ROLE:-vitana-gateway-awsdr-deploy-role}"');
    expect(sh).toMatch(/"Action": \["s3:GetObject"\]/);
    expect(sh).toMatch(/"Action": \["s3:PutObject", "s3:GetObject"\]/);
    expect(sh).not.toContain('s3:DeleteObject');
    expect(sh).not.toMatch(/aws ecs register-task-definition/);
  });
});
