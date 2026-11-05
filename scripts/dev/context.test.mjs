// Tests for scripts/dev/context.mjs (plan context-map). node --test scripts/dev/context.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMounts, parseHandlers, pathMatches, mostSpecific, parseAtlas, globExists, deadRefs, resolveSpec,
  findRoots, route, screen, check, domain, vtid, why, uses, main, COMMANDS,
} from './context.mjs';

const PLATFORM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_V1 = { platform: PLATFORM, v1: null };

function tmpTree(files) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    writeFileSync(path.join(d, f), body);
  }
  return d;
}

test('parseMounts maps every require/import form in index.ts to its route file', () => {
  const idx = [
    "  const { vtidRouter } = require('./routes/vtid');",
    "  const { router: tasksRouter } = require('./routes/tasks');",
    "  const boardAdapter = require('./routes/board-adapter').default;",
    "  const intentsRouter = enabled ? require('./routes/intents').default : null;",
    "  const mcpModule = require('./routes/community-mcp');",
    "import healthRouter, { statusRouter as st } from './routes/health';",
    "  mountRouterSync(app, '/api/v1/vtid', vtidRouter, { owner: 'vtid' });",
    "  mountRouterSync(app, '/api/v1/tasks', tasksRouter, { owner: 'tasks' });",
    "  app.use('/api/v1/board', boardAdapter);",
    "  if (intentsRouter) mountRouterSync(app, '/api/v1/intents', intentsRouter, { owner: 'intents' });",
    "  mountRouterSync(app, '/mcp/community', mcpModule.default, { owner: 'community-mcp' });",
    "  mountRouterSync(app, '/api/v1/operator/runs', require('./routes/operator-runs').default, { owner: 'x' });",
    "  app.use('/health', healthRouter);",
    "  app.use('/status', st);",
    "  app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }));",
  ].join('\n');
  const m = Object.fromEntries(parseMounts(idx).map((x) => [x.prefix, x.file]));
  assert.deepEqual(m, {
    '/api/v1/vtid': 'vtid', '/api/v1/tasks': 'tasks', '/api/v1/board': 'board-adapter', '/api/v1/intents': 'intents',
    '/mcp/community': 'community-mcp', '/api/v1/operator/runs': 'operator-runs', '/health': 'health', '/status': 'health',
  });
  assert.equal(parseMounts(idx).find((x) => x.prefix === '/api/v1/vtid').line, 7);
});

test('parseHandlers, pathMatches and mostSpecific pick the literal handler over params and wildcards', () => {
  const src = 'router.post("/allocate", auth, h);\nrouter.get("/:vtid", h);\nrouter.options("*", h);\n  workerRouter.get(`/tasks/:id/claim`, h);';
  const hs = parseHandlers(src);
  assert.deepEqual(hs.map((h) => [h.method, h.path, h.line]),
    [['POST', '/allocate', 1], ['GET', '/:vtid', 2], ['OPTIONS', '*', 3], ['GET', '/tasks/:id/claim', 4]]);
  assert.ok(pathMatches('/:vtid', '/allocate'));
  assert.ok(pathMatches('/tasks/:id/claim', '/tasks/abc/claim'));
  assert.ok(!pathMatches('/tasks/:id/claim', '/tasks/abc'));
  assert.ok(pathMatches('*', '/anything/at/all'));
  const matching = hs.filter((h) => pathMatches(h.path, '/allocate'));
  assert.deepEqual(mostSpecific(matching, (h) => h.path).map((h) => h.path), ['/allocate']);
});

test('parseAtlas reads keys, regex route patterns with escaped slashes, and string arrays', () => {
  const t = [
    'export const DOMAIN_ATLAS = [', '  {', "    key: 'voice',", "    title: 'ORB voice',",
    "    summary:", "      'One session controller; the orchestrator\\'s tools.',",
    '    routes: [/^orb-/, /^tenant-admin\\/assistant-/],', "    code: ['orb/live/', 'routes/orb-live.ts'],",
    "    tables: ['oasis_events'],", "    flags: ['NOVA_SONIC_GLOBAL_ENABLED'],", "    docs: ['CLAUDE.md §2c', 'docs/X.md'],",
    "    aliases: ['orb', 'nova'],", '  },', '  {', "    key: 'oasis',", "    title: 'OASIS',", "    summary: 'Ledger.',",
    '    routes: [/^vtid/],', '    code: [],', '    tables: [],', '    flags: [],', '    docs: [],', '    aliases: [],', '  },', '];',
  ].join('\n');
  const a = parseAtlas(t);
  assert.equal(a.length, 2);
  assert.equal(a[0].key, 'voice');
  assert.equal(a[0].line, 3);
  assert.equal(a[0].summary, "One session controller; the orchestrator's tools.");
  assert.deepEqual(a[0].routes, ['^orb-', '^tenant-admin\\/assistant-']);
  assert.ok(new RegExp(a[0].routes[1]).test('tenant-admin/assistant-config'));
  assert.deepEqual(a[0].code, ['orb/live/', 'routes/orb-live.ts']);
  assert.deepEqual(a[0].docs, ['CLAUDE.md §2c', 'docs/X.md']);
  assert.deepEqual(a[1].routes, ['^vtid']);
  assert.deepEqual(a[1].code, []);
});

test('globExists handles plain paths, * in a segment, ** and trailing-slash directories', () => {
  const d = tmpTree({ 'services/dev-autopilot-a.ts': '', 'orb/live/x.ts': '', 'deep/a/b/c.md': '' });
  assert.ok(globExists(d, 'services/dev-autopilot-a.ts'));
  assert.ok(globExists(d, 'services/dev-autopilot-*.ts'));
  assert.ok(!globExists(d, 'services/stripe*.ts'));
  assert.ok(globExists(d, 'orb/live/'));
  assert.ok(globExists(d, 'deep/**/c.md'));
  assert.ok(!globExists(d, 'orb/missing/'));
  assert.ok(!globExists(d, 'services/dev-autopilot-a.ts/'), 'a trailing / needs a directory, not a file of that name');
  assert.ok(!globExists(d, 'services/dev-*/'), 'a glob with a trailing / needs a directory');
  assert.ok(globExists(d, '**/live/x.ts'), '** in the directory part globs');
  assert.ok(globExists(path.join(d, 'orb'), '../deep/a/'), '../ climbs from the base');
});

test('deadRefs reports unresolved backticked repo paths and skips placeholders and generated output', () => {
  const t = 'See `docs/A.md`, `docs/Gone.md`, `graphify-out/GRAPH_REPORT.md`, `.kiro/specs/<slug>/plan.md`, `~/.x/y.md`.\nAlso `a/b.ts`.';
  const exists = new Set(['docs/A.md']);
  assert.deepEqual(deadRefs(t, [(p) => exists.has(p)]), [{ ref: 'docs/Gone.md', line: 1 }, { ref: 'a/b.ts', line: 2 }]);
});

test('resolveSpec resolves relative, .js-for-.ts and @/ specifiers to repo files', () => {
  const d = tmpTree({ 'src/lib/a.ts': '', 'src/pages/P.tsx': '', 'src/hooks/index.ts': '' });
  assert.equal(resolveSpec(d, 'src/pages/P.tsx', '../lib/a'), 'src/lib/a.ts');
  assert.equal(resolveSpec(d, 'src/pages/P.tsx', '../lib/a.js'), 'src/lib/a.ts');
  assert.equal(resolveSpec(d, 'src/App.tsx', '@/hooks'), 'src/hooks/index.ts');
  assert.equal(resolveSpec(d, 'src/App.tsx', 'react'), null);
  assert.equal(resolveSpec(d, 'src/App.tsx', './missing'), null);
});

// A small committed git repo with the shapes the commands read, so no command test depends on this repo's files.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function fixtureRepo(extra = {}) {
  const atlas = "export const DOMAIN_ATLAS = [\n  {\n    key: 'oasis',\n    title: 'OASIS, VTIDs and governance',\n    summary: 'Ledger and events.',\n    routes: [/^vtid/],\n    code: ['services/vtid-helper.ts'],\n    tables: ['vtid_ledger'],\n    flags: ['VTID_ALLOCATOR_ENABLED'],\n    docs: ['docs/VTID.md'],\n    aliases: ['ledger', 'allocator'],\n  },\n];\n";
  const d = tmpTree({
    'services/gateway/src/index.ts': "  const { vtidRouter } = require('./routes/vtid');\n  mountRouterSync(app, '/api/v1/vtid', vtidRouter, { owner: 'vtid' });\n",
    'services/gateway/src/routes/vtid.ts': "import { help } from '../services/vtid-helper';\nrouter.post('/allocate', h);\nrouter.get('/:vtid', h);\nrouter.options('*', h);\n",
    'services/gateway/src/services/vtid-helper.ts': 'export const help = 1;\n',
    'services/gateway/src/orb/developer/domain-atlas.ts': atlas,
    'services/gateway/src/orb/live/session/x-controller.ts': '',
    'services/gateway/test/vtid-alloc.test.ts': "import { help } from '../src/services/vtid-helper';\nit('posts /api/v1/vtid/allocate', () => {});\n",
    'CLAUDE.md': '# Rules\n## Two execution planes (VTID-09998)\nThe worker-runner claims only autonomous rows.\n',
    'docs/CHANGELOG.md': '# CHANGE LOG\n| 2026-08-06 | worker-runner claimed session VTIDs (VTID-09998) |\n',
    'docs/VTID.md': '', 'docs/CONTEXT-MAP.md': 'x\n',
    '.kiro/specs/s/lanes/l.md': '---\nlane: l\nstate: done\nvtid: VTID-09999\n---\n',
    'docs/validation/VTID-09999/acceptance.md': '',
    ...extra,
  });
  const g = (...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: GIT_ENV });
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'VTID-09999 (s/l): first');
  return { platform: d, v1: null };
}

test('route: mount → most specific handler file:line, atlas domain, tests naming it (fixture repo)', () => {
  const roots = fixtureRepo();
  const r = route(roots, 'POST /api/v1/vtid/allocate');
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].mount, 'services/gateway/src/index.ts:2');
  assert.equal(r.matches[0].file, 'services/gateway/src/routes/vtid.ts');
  assert.deepEqual(r.matches[0].handlers, [{ method: 'POST', path: '/allocate', at: 'services/gateway/src/routes/vtid.ts:2' }]);
  assert.deepEqual(r.matches[0].domains, ['oasis (services/gateway/src/orb/developer/domain-atlas.ts:3)']);
  assert.deepEqual(r.tests, ['services/gateway/test/vtid-alloc.test.ts']);
  assert.deepEqual(route(roots, '/api/v1/vtid/VTID-00001').matches[0].handlers.map((h) => h.path), ['/:vtid'], 'OPTIONS * is not shown');
  assert.deepEqual(route(roots, '/api/v1/vtid/allocate').matches[0].handlers.map((h) => `${h.method} ${h.path}`), ['POST /allocate'],
    'without a method the literal path beats GET /:vtid');
  assert.equal(route(roots, '/nowhere').matches.length, 0);
});

test('domain, uses and why answer with file:line from the fixture sources', () => {
  const roots = fixtureRepo();
  const d = domain(roots, 'allocator');
  assert.equal(d.domains.length, 1);
  assert.deepEqual(d.domains[0].routeFiles, ['services/gateway/src/routes/vtid.ts']);
  const u = uses(roots, path.join(roots.platform, 'services/gateway/src/services/vtid-helper.ts'));
  assert.deepEqual(u.code, ['services/gateway/src/routes/vtid.ts:1']);
  assert.deepEqual(u.tests, ['services/gateway/test/vtid-alloc.test.ts:1']);
  const w = why(roots, 'worker-runner');
  assert.deepEqual(w.hits.map((h) => h.at), ['vitana-platform/CLAUDE.md:3', 'vitana-platform/docs/CHANGELOG.md:2'], 'rules rank before the changelog');
  assert.equal(w.hits[0].heading, 'Two execution planes (VTID-09998)');
});

test('vtid: commits, spec files with state, validation folder; PR search is injectable', () => {
  const roots = fixtureRepo();
  const r = vtid(roots, 'VTID-09999', { prs: true, run: () => ({ status: 0, stdout: 'closed https://x/pull/1 t\n' }) });
  assert.equal(r.commits.length, 1);
  assert.match(r.commits[0], /^vitana-platform [0-9a-f]+ \d{4}-\d{2}-\d{2} VTID-09999 \(s\/l\): first$/);
  assert.deepEqual(r.specs, ['vitana-platform/.kiro/specs/s/lanes/l.md (state: done)']);
  assert.deepEqual(r.validation, ['vitana-platform/docs/validation/VTID-09999/ [acceptance.md]']);
  assert.deepEqual(r.prs, ['closed https://x/pull/1 t']);
  const failed = vtid(roots, 'VTID-09999', { prs: true, run: () => ({ status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials\n' }) });
  assert.deepEqual(failed.prs, ['gh search failed: HTTP 401: Bad credentials'], 'a failing gh prints one line, never throws');
  assert.equal(vtid(roots, 'VTID-09999').prs, null, 'no --prs, no gh call');
  assert.match(vtid(roots, 'nope').error, /usage/);
});

test('screen (vitana-v1 fixture): App.tsx route → lazy page file, registry, manifest, parity, exclusion, redirect', () => {
  const v1 = tmpTree({
    'src/App.tsx': [
      'const Messages = lazy(() => import("./pages/Messages"));',
      'const NotFound = lazy(() => import("./pages/NotFound"));',
      '          <Route path="/inbox" element={',
      '            <AuthGuard>',
      '              <Messages />',
      '            </AuthGuard>',
      '          } />',
      '          <Route path="/messages/*" element={<Navigate to="/inbox" replace />} />',
      '          <Route path="/admin/x" element={<NotFound />} />',
      '          <Route path="*" element={<NotFound />} />',
    ].join('\n'),
    'src/pages/Messages.tsx': '', 'src/pages/NotFound.tsx': '',
    'src/navigation/registry/screens.json': '{\n  "screens": [\n    {\n      "route": "/inbox"\n    }\n  ]\n}\n',
    'src/navigation/registry/exclusions.json': '{"prefixes":[{"prefix":"/admin","reason":"Admin surface"}]}',
    'src/design/screen-manifest.json': '{\n  "screens": [\n    {\n      "path": "/inbox"\n    }\n  ]\n}\n',
    'apps/mobile/parity/ledger.json': '{\n  "rows": [\n    {\n      "web_path": "/inbox"\n    }\n  ]\n}\n',
    'src/pages/Messages.test.tsx': "it('opens /inbox', () => {});\n",
  });
  spawnSync('git', ['-C', v1, 'init', '-q'], { env: GIT_ENV });
  spawnSync('git', ['-C', v1, 'add', '-A'], { env: GIT_ENV });
  spawnSync('git', ['-C', v1, 'commit', '-q', '-m', 'v1'], { env: GIT_ENV });
  const roots = { platform: fixtureRepo().platform, v1 };
  const r = screen(roots, '/inbox');
  assert.deepEqual(r.routes, [{ at: 'src/App.tsx:3', path: '/inbox', redirect: null,
    pages: [{ component: 'Messages', import: './pages/Messages', file: 'src/pages/Messages.tsx' }] }], 'the catch-all * is not shown');
  assert.deepEqual(r.navRegistry, ['src/navigation/registry/screens.json:4']);
  assert.deepEqual(r.manifest, ['src/design/screen-manifest.json:4']);
  assert.deepEqual(r.parity, ['apps/mobile/parity/ledger.json:4']);
  assert.deepEqual(r.tests, ['src/pages/Messages.test.tsx']);
  assert.equal(screen(roots, '/messages/old').routes[0].redirect, '/inbox');
  assert.deepEqual(screen(roots, '/admin/x').exclusions, ['prefix /admin: Admin surface']);
  assert.match(screen({ platform: roots.platform, v1: null }, '/inbox').error, /vitana-v1 checkout not found/);
});

test('check: a short form of a live file is not dead; a full path to a deleted file is (rule files)', () => {
  const roots = fixtureRepo({ 'AGENTS.md': 'See `session/x-controller.ts` and `services/gateway/src/services/gone.ts`.\n' });
  const rules = check(roots).findings.filter((f) => f.area === 'rules').map((f) => f.at);
  assert.deepEqual(rules, ['vitana-platform/AGENTS.md:1']);
  assert.match(check(roots).findings.find((f) => f.area === 'rules').msg, /services\/gateway\/src\/services\/gone\.ts/);
});

test('check: docs/CONTEXT-MAP.md has no dead link and names only real commands', () => {
  const r = check(NO_V1);
  const mapErrors = r.findings.filter((f) => f.area === 'context-map' && f.level === 'error');
  assert.deepEqual(mapErrors, []);
  assert.equal(r.counts.error, 0);
});

test('check: a dead context-map link is an error; a vitana-v1 link without that checkout is info', () => {
  const d = tmpTree({
    'docs/CONTEXT-MAP.md': 'Use `node scripts/dev/context.mjs route` and `node scripts/dev/context.mjs bogus`.\n`docs/Gone.md` `vitana-v1/src/App.tsx`\n',
    'services/gateway/src/routes/a.ts': '', 'services/gateway/src/orb/developer/domain-atlas.ts': '',
  });
  const r = check({ platform: d, v1: null });
  const msgs = r.findings.filter((f) => f.area === 'context-map').map((f) => `${f.level} ${f.msg}`);
  assert.ok(msgs.includes('error dead link docs/Gone.md'));
  assert.ok(msgs.includes('error unknown command "bogus"'));
  assert.ok(msgs.includes('info dead link vitana-v1/src/App.tsx (vitana-v1 not checked out)'));
  assert.equal(r.counts.error, 2);
});

test('check: stale atlas pointers and route patterns are warnings with the atlas line', () => {
  const atlas = "  {\n    key: 'pay',\n    title: 'P',\n    summary: 'S',\n    routes: [/^wallet/, /^nothing-claims-this$/],\n    code: ['services/stripe*.ts', 'services/ok.ts'],\n    tables: [],\n    flags: [],\n    docs: ['docs/Missing.md'],\n    aliases: [],\n  },\n";
  const d = tmpTree({ 'docs/CONTEXT-MAP.md': 'x\n', 'services/gateway/src/routes/wallet.ts': '',
    'services/gateway/src/services/ok.ts': '', 'services/gateway/src/orb/developer/domain-atlas.ts': atlas });
  const w = check({ platform: d, v1: null }).findings.filter((f) => f.area === 'atlas');
  assert.deepEqual(w.map((f) => f.msg), [
    'pay: code pointer "services/stripe*.ts" matches nothing (tried services/gateway/src, services/gateway, repo root)',
    'pay: doc "docs/Missing.md" does not exist',
    'pay: route pattern /^nothing-claims-this$/ claims no route file',
  ]);
  assert.ok(w.every((f) => f.level === 'warn'));
  assert.deepEqual(w.map((f) => f.at.split(':')[1]), ['6', '9', '2'], 'pointer findings cite the pointer line, route patterns the key line');
});

test('check: atlas directory, glob and ../ pointers resolve against src, services/gateway, repo root (R2-F1)', () => {
  const atlas = "  {\n    key: 'k',\n    title: 'T',\n    summary: 'S',\n    routes: [/^a$/],\n    code: ['orb/delegation/', 'services/commerce/', 'services/oasis-*.ts', 'services/governance-*.ts', '../erp-bridge/', '../gone-service/', '.github/workflows/AWS-*.yml'],\n    tables: [],\n    flags: [],\n    docs: [],\n    aliases: [],\n  },\n";
  const d = tmpTree({ 'docs/CONTEXT-MAP.md': 'x\n', 'services/gateway/src/routes/a.ts': '',
    'services/gateway/src/orb/delegation/x.ts': '', 'services/gateway/src/services/commerce-mcp.ts': '',
    'services/gateway/src/services/oasis-events.ts': '', 'services/erp-bridge/index.ts': '',
    '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml': '', 'services/gateway/src/orb/developer/domain-atlas.ts': atlas });
  const dead = check({ platform: d, v1: null }).findings.filter((f) => f.area === 'atlas').map((f) => f.msg.match(/"([^"]+)"/)[1]);
  assert.deepEqual(dead, ['services/commerce/', 'services/governance-*.ts', '../gone-service/']);
});

test('main: usage on a bad command, exit codes, JSON output, sibling vitana-v1 discovery', () => {
  assert.equal(main(['nope']).code, 2);
  assert.equal(main(['route']).code, 2);
  const j = main(['route', '/api/v1/vtid/allocate', '--json', '--platform', fixtureRepo().platform]);
  assert.equal(j.code, 0);
  assert.equal(JSON.parse(j.text).matches[0].file, 'services/gateway/src/routes/vtid.ts');
  // check exit codes through the CLI: 0 with warnings, 1 with --strict, 1 on a context-map error.
  const warnOnly = fixtureRepo({ 'AGENTS.md': 'See `services/gateway/src/services/gone.ts`.\n' }).platform;
  assert.equal(main(['check', '--platform', warnOnly]).code, 0);
  assert.equal(main(['check', '--strict', '--platform', warnOnly]).code, 1);
  const broken = fixtureRepo({ 'docs/CONTEXT-MAP.md': '`docs/Gone.md`\n' }).platform;
  const b = main(['check', '--platform', broken]);
  assert.equal(b.code, 1);
  assert.match(b.text, /error context-map docs\/CONTEXT-MAP\.md:1  dead link docs\/Gone\.md/);
  assert.deepEqual(COMMANDS, ['route', 'screen', 'domain', 'vtid', 'why', 'uses', 'check']);
  const ws = tmpTree({ 'vitana-platform/x': '', 'vitana-v1/src/App.tsx': '' });
  assert.equal(findRoots({ platform: path.join(ws, 'vitana-platform'), env: {} }).v1, path.join(ws, 'vitana-v1'));
  assert.equal(findRoots({ platform: path.join(ws, 'nowhere/p'), env: {} }).v1, null);
});
