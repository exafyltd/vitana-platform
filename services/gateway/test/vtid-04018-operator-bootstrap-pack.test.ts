/**
 * VTID-04018 (W4a): the Operator Console's session bootstrap pack.
 *
 * Pins: the pure renderers (rules excerpt, change-log compression, schema
 * index, path map, tool catalog, PRs, events, build-info), the assembly and
 * size budget, the flag gate, fail-open per source, the 5-minute cache with
 * coalesced concurrent builds, and the wiring into BOTH operator turns plus
 * the staging pin.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BOOTSTRAP_TTL_MS, PACK_MAX_CHARS, SOURCE_TIMEOUT_MS,
  assembleBootstrapPack, buildBootstrapSections, extractChangelogRows, extractClaudeMdPart1, extractSchemaTableIndex,
  getOperatorBootstrapPack, isBootstrapPackEnabled, parseBuildInfoTargets, renderBuildInfo, renderOpenPrs, renderRecentEvents,
  renderServicePathMap, renderToolCatalog, resetBootstrapPackCache, withTimeout, type BootstrapDeps,
} from '../src/services/operator-bootstrap-pack';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const REAL_CLAUDE_MD = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
const REAL_SCHEMA = fs.readFileSync(path.join(REPO_ROOT, 'DATABASE_SCHEMA.md'), 'utf8');
const REAL_PATH_MAP = fs.readFileSync(path.join(REPO_ROOT, 'config/service-path-map.json'), 'utf8');

function deps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    readRepoFile: async (p) => (p === 'CLAUDE.md' ? REAL_CLAUDE_MD : p === 'DATABASE_SCHEMA.md' ? REAL_SCHEMA : REAL_PATH_MAP),
    listPlatformOpenPrs: async () => [{ repo: 'exafyltd/vitana-platform', number: 3387, title: 'W2 open-ended intake', branch: 'claude/x', ci: 'passing', mergeable: true }],
    listFrontendOpenPrs: async () => [{ repo: 'exafyltd/vitana-v1', number: 1102, title: 'mobile fix', branch: 'f' }],
    queryRecentEvents: async () => [{ topic: 'dev_autopilot.execution.pr_opened', status: 'success', message: 'Execution 4f5d7ea4 opened https://x', created_at: '2026-09-17T20:15:04.000Z' }],
    fetchBuildInfo: async (url) => ({ env: url.includes('preview') ? 'staging' : 'production', git_commit: 'ecfc0dff2a91b630b00060038bf1158572739360', booted_at: '2026-09-17T20:34:17.465Z' }),
    env: { OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true', OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'staging=https://preview.example/build-info,prod=https://prod.example/build-info' },
    ...overrides,
  };
}

describe('VTID-04018 pure renderers', () => {
  it('extracts CLAUDE.md Part 1 (the rules), bounded, and never the change log', () => {
    const rules = extractClaudeMdPart1(REAL_CLAUDE_MD);
    expect(rules).toContain('# PART 1: CORE RULES');
    expect(rules).not.toContain('# PART 2');
    expect(rules).not.toContain('## CHANGE LOG');
    expect(rules.length).toBeLessThanOrEqual(8_000 + 20);
    expect(extractClaudeMdPart1('no marker here', 5)).toBe('no ma\n…[abridged]');
  });

  it('compresses the newest change-log rows to one line each with date + VTID', () => {
    const rows = extractChangelogRows(REAL_CLAUDE_MD, 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/^2026-\d\d-\d\d VTID-\d{5}/);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(240 + 40);
    expect(extractChangelogRows('nothing')).toEqual([]);
    const mini = '| Date | Change | VTID |\n|------|--------|------|\n| 2026-01-01 | **First.** Second sentence. | VTID-00001 |\n| 2026-01-02 | `x` | VTID-00002 |\n\nafter';
    expect(extractChangelogRows(mini)).toEqual(['2026-01-01 VTID-00001: First.', '2026-01-02 VTID-00002: x']);
  });

  it('indexes DATABASE_SCHEMA.md table headings and the service path map', () => {
    const idx = extractSchemaTableIndex(REAL_SCHEMA);
    expect(idx).toContain('vtid_ledger');
    expect(idx).toContain('oasis_events');
    expect(idx.length).toBeLessThanOrEqual(3_000 + 20);
    expect(extractSchemaTableIndex('### `a`\n### a\n### b_c\ntext')).toBe('a, b_c');
    const map = renderServicePathMap(REAL_PATH_MAP);
    expect(map).toMatch(/gateway/);
    expect(renderServicePathMap('{"svc":{"path":"services/svc"},"k":"v"}')).toBe('svc → services/svc\nk → v');
    expect(renderServicePathMap('not json')).toBe('not json');
  });

  it('renders the tool catalog from declarations (first sentence only), PRs, events and build-info', () => {
    expect(renderToolCatalog([{ name: 'a', description: 'Does A. Ignored second sentence.' }, { name: 'b', description: '' }])).toBe('- a — Does A.\n- b — ');
    expect(renderOpenPrs([])).toBe('(no open PRs)');
    expect(renderOpenPrs([{ repo: 'r', number: 1, title: 't', branch: 'b', ci: 'passing', mergeable: false }])).toBe('- r#1 t [b] (ci=passing, not-mergeable)');
    expect(renderRecentEvents([])).toMatch(/no recent/);
    expect(renderRecentEvents([{ topic: 'deploy.gateway.success', status: 'success', message: 'ok  done', created_at: '2026-09-17T20:34:17.465Z' }])).toBe('- 2026-09-17 20:34 deploy.gateway.success [success]: ok done');
    expect(renderBuildInfo([])).toMatch(/OPERATOR_BOOTSTRAP_BUILD_INFO_URLS/);
    expect(renderBuildInfo([{ label: 'staging', ok: true, env: 'staging', git_commit: 'abcdef1234567890' }, { label: 'prod', ok: false, error: 'HTTP 503' }]))
      .toBe('- staging: env=staging commit=abcdef123456 booted=?\n- prod: (unavailable: HTTP 503)');
  });

  it('parses build-info targets and the flag', () => {
    expect(parseBuildInfoTargets({ OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'a=https://x/b, b=https://y , bad, c=http://insecure' })).toEqual([{ label: 'a', url: 'https://x/b' }, { label: 'b', url: 'https://y' }]);
    expect(parseBuildInfoTargets({})).toEqual([]);
    expect(isBootstrapPackEnabled({})).toBe(false);
    expect(isBootstrapPackEnabled({ OPERATOR_BOOTSTRAP_PACK_ENABLED: 'TRUE' })).toBe(false);
    expect(isBootstrapPackEnabled({ OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true' })).toBe(true);
  });

  it('assembles sections with a header, renders failures inline, and clips at the size budget', () => {
    const pack = assembleBootstrapPack([{ title: 'A', body: 'x' }, { title: 'B', error: 'nope' }, { title: 'C', body: '' }], '2026-09-17T21:00:00.000Z');
    expect(pack).toContain('Session bootstrap pack (VTID-04018) — assembled 2026-09-17T21:00:00.000Z, cached 5 min');
    expect(pack).toContain('### A\nx');
    expect(pack).toContain('### B\n(unavailable: nope)');
    expect(pack).toContain('### C\n(empty)');
    const big = assembleBootstrapPack([{ title: 'A', body: 'y'.repeat(PACK_MAX_CHARS) }], 'now');
    expect(big.length).toBeLessThanOrEqual(PACK_MAX_CHARS + 60);
    expect(big).toMatch(/pack truncated at the size budget/);
  });

  it('withTimeout rejects late promises', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 20, 'x')).rejects.toThrow(/x timed out after 20ms/);
    await expect(withTimeout(Promise.resolve(7), 20, 'x')).resolves.toBe(7);
  });
});

describe('VTID-04018 sections, fail-open and cache', () => {
  beforeEach(() => resetBootstrapPackCache());

  it('builds every section from the injected sources', async () => {
    const sections = await buildBootstrapSections(deps());
    expect(sections.map((s) => s.title)).toEqual([
      'Governance rules (CLAUDE.md Part 1, abridged)', 'Recent change log (newest first)', 'Service path map (config/service-path-map.json)',
      'Database tables (DATABASE_SCHEMA.md index)', 'Live build-info', 'Open pull requests', 'Recent deploy / autopilot events (OASIS)',
    ]);
    expect(sections.every((s) => !s.error)).toBe(true);
    expect(sections[4].body).toContain('- staging: env=staging commit=ecfc0dff2a91');
    expect(sections[4].body).toContain('- prod: env=production');
    expect(sections[5].body).toContain('exafyltd/vitana-platform#3387');
    expect(sections[5].body).toContain('exafyltd/vitana-v1#1102');
    expect(sections[6].body).toContain('dev_autopilot.execution.pr_opened');
  });

  it('a failing or hanging source renders as unavailable and does not block the others', async () => {
    const hang = new Promise<never>(() => undefined);
    const t0 = Date.now();
    const sections = await buildBootstrapSections(deps({
      queryRecentEvents: async () => { throw new Error('oasis_events 503'); },
      listPlatformOpenPrs: () => hang as Promise<never>,
      listFrontendOpenPrs: async () => { throw new Error('FRONTEND_DEPLOY_TOKEN not set'); },
    }));
    expect(Date.now() - t0).toBeLessThan(SOURCE_TIMEOUT_MS + 1_500);
    expect(sections[6].error).toBe('oasis_events 503');
    expect(sections[5].error).toMatch(/exceeded|timed out/); // VTID-04024: the enriched list is raced against its own budget first
    expect(sections[0].body).toContain('# PART 1');
  });

  it('a missing build-info target is one unavailable line, not a failed section', async () => {
    const sections = await buildBootstrapSections(deps({ fetchBuildInfo: async (url) => { if (url.includes('prod')) throw new Error('HTTP 503'); return { env: 'staging', git_commit: 'abc' }; } }));
    expect(sections[4].body).toContain('- prod: (unavailable: HTTP 503)');
    expect(sections[4].body).toContain('- staging: env=staging');
  });

  it('is empty when disabled and never calls a source', async () => {
    const spy = jest.fn(async () => 'x');
    expect(await getOperatorBootstrapPack({ toolDefs: [], deps: deps({ readRepoFile: spy }), env: {} })).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('caches the fetched sections for 5 minutes, coalesces concurrent builds, and renders the catalog per call', async () => {
    let now = 1_000_000;
    let reads = 0;
    const d = deps({ readRepoFile: async (p) => { reads += 1; await new Promise((r) => setTimeout(r, 10)); return p === 'CLAUDE.md' ? REAL_CLAUDE_MD : p === 'DATABASE_SCHEMA.md' ? REAL_SCHEMA : REAL_PATH_MAP; }, now: () => now });
    const env = d.env!;
    const [a, b] = await Promise.all([
      getOperatorBootstrapPack({ toolDefs: [{ name: 'dev_read_file', description: 'Read a file.' }], deps: d, env }),
      getOperatorBootstrapPack({ toolDefs: [{ name: 'autopilot_run_task', description: 'Run.' }], deps: d, env }),
    ]);
    expect(reads).toBe(3); // one build: CLAUDE.md, path map, schema — not two
    expect(a).toContain('- dev_read_file — Read a file.');
    expect(b).toContain('- autopilot_run_task — Run.');
    expect(b).not.toContain('- dev_read_file —');
    now += BOOTSTRAP_TTL_MS - 1;
    await getOperatorBootstrapPack({ toolDefs: [], deps: d, env });
    expect(reads).toBe(3);
    now += 2;
    await getOperatorBootstrapPack({ toolDefs: [], deps: d, env });
    expect(reads).toBe(6);
  });

  it('never throws — a broken deps set fails open to an empty pack', async () => {
    const pack = await getOperatorBootstrapPack({ toolDefs: [], deps: { readRepoFile: undefined as unknown as BootstrapDeps['readRepoFile'] }, env: { OPERATOR_BOOTSTRAP_PACK_ENABLED: 'true' } });
    expect(typeof pack).toBe('string');
  });
});

describe('VTID-04018 wiring', () => {
  const SRC = path.resolve(__dirname, '../src/services');
  const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');
  const WF = path.resolve(__dirname, '../../../.github/workflows');
  const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

  it('the main operator turn appends the pack after the VTID-03930 orientation block and passes the same tool defs it renders', () => {
    const i = operator.indexOf('async function callVertexWithTools(');
    const body = operator.slice(i, operator.indexOf('async function sendToolResultsToVertex(', i));
    // VTID-04560: the pack is gated on engineeringContextAllowed (console / developer / admin callers only).
    expect(body).toMatch(/const routerTools = getRouterToolDefinitions\(userRole\);/);
    expect(body).toMatch(/const bootstrapPack = engineering \? await getOperatorBootstrapPack\(\{ toolDefs: routerTools \}\) : '';/);
    expect(body).toMatch(/\$\{CODEBASE_OVERVIEW_BLOCK\}\$\{bootstrapPack \? `\\n\\n\$\{bootstrapPack\}` : ''\}/);
    expect(body).toMatch(/tools: routerTools,/);
  });

  it('the tool-result turn carries the same pack (§4.1)', () => {
    const i = operator.indexOf('async function sendToolResultsToVertex(');
    const body = operator.slice(i, i + 3_000);
    expect(body).toMatch(/const toolResultPack = engineering \? await getOperatorBootstrapPack\(/);
    expect(body).toMatch(/const systemPrompt = toolResultPack \? `\$\{baseToolResultPrompt\}\\n\\n\$\{toolResultPack\}` : baseToolResultPrompt;/);
  });

  it('staging pins the flag and the two build-info targets; prod declares the same (VTID-04230)', () => {
    expect(staging).toMatch(/\{name:"OPERATOR_BOOTSTRAP_PACK_ENABLED", value:"true"\}/);
    expect(staging).toMatch(/\{name:"OPERATOR_BOOTSTRAP_BUILD_INFO_URLS", value:"staging=https:\/\/[^"]+\/api\/v1\/admin\/build-info,prod=https:\/\/[^"]+\/api\/v1\/admin\/build-info"\}/);
    const stripBlock = staging.slice(staging.indexOf('.containerDefinitions[0].environment |='), staging.indexOf('.containerDefinitions[0].secrets |='));
    const strip = stripBlock.slice(0, stripBlock.indexOf('| not) ]'));
    expect(strip).toContain('"OPERATOR_BOOTSTRAP_PACK_ENABLED"');
    expect(strip).toContain('"OPERATOR_BOOTSTRAP_BUILD_INFO_URLS"');
    // VTID-04230: prod now declares the same pin and the same two targets.
    expect(prod).toMatch(/\{name:"OPERATOR_BOOTSTRAP_PACK_ENABLED", value:"true"\}/);
    expect(prod).toMatch(/\{name:"OPERATOR_BOOTSTRAP_BUILD_INFO_URLS", value:"staging=https:\/\/[^"]+\/api\/v1\/admin\/build-info,prod=https:\/\/[^"]+\/api\/v1\/admin\/build-info"\}/);
  });
});
