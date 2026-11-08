// VTID-05552 (agentic-delivery/verify-on-gitlab) — run.mjs `--deploy-runs-file` (plan agentic-delivery §3.6 step 3).
// Run: node --test scripts/ci/staging-verify/deploy-runs.test.mjs (UNIT.yml runs it on every PR: Node 20, no install).
//
// On GitHub, a run that staging superseded mid-run lists the service's staging deploy runs with the GitHub Actions API
// (`gh api …/actions/workflows/<AWS-STAGE-DEPLOY-*.yml>/runs`) to find the attribution cutoff T_cut (VTID-05144). On
// GitLab the deploy job writes those runs to a file, `[{"service","sha","started_at","finished_at","outcome"}]` (lane
// deploy-path), and `--deploy-runs-file` reads it in place of the API call. These tests prove: the file gives the same
// T_cut as the GitHub listing of the same deploys; given the flag, run.mjs never calls `gh` (a missing or broken file
// fails closed: T_cut = run start, nothing attributed, and the log says why); without the flag the GitHub call is the
// one it was. The last tests are the V4 dry runs: `run.mjs verify` end to end for the gateway and the community app, with
// a deploy-runs fixture, no network (fetch is replaced before run.mjs loads) and fake `gh` / `npx` that record every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('./lib.cjs');
const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = join(HERE, 'run.mjs');
const loadRun = () => import(pathToFileURL(RUN_MJS).href);

const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const START = Date.parse('2026-11-05T12:00:00.000Z');

// ── The same deploys, as the GitHub API lists them and as the GitLab deploy job writes them ──────────────────────
// Each scenario: GitHub runs ({created_at, updated_at, status, conclusion}), the equivalent deploy-runs entries for the
// gateway (plus entries of the other service, which must be ignored), and the T_cut both must give.
const OTHER = { service: 'community-app', sha: 'f'.repeat(40), started_at: iso(START + 1 * MIN), finished_at: null, outcome: 'deployed' };
const SCENARIOS = [
  {
    name: 'a deploy that started mid-run bounds T_cut',
    github: [
      { created_at: iso(START - 40 * MIN), updated_at: iso(START - 30 * MIN), status: 'completed', conclusion: 'success' },
      { created_at: iso(START + 20 * MIN), updated_at: iso(START + 26 * MIN), status: 'in_progress', conclusion: null },
    ],
    gitlab: [
      { service: 'gateway', sha: 'a'.repeat(40), started_at: iso(START - 40 * MIN), finished_at: iso(START - 30 * MIN), outcome: 'deployed' },
      OTHER,
      { service: 'gateway', sha: 'b'.repeat(40), started_at: iso(START + 20 * MIN), finished_at: null, outcome: 'deploying' },
    ],
    cut: START + 20 * MIN,
  },
  {
    name: 'a deploy that finished inside the 5-minute margin clamps T_cut to the run start',
    github: [{ created_at: iso(START - 9 * MIN), updated_at: iso(START - 2 * MIN), status: 'completed', conclusion: 'success' }],
    gitlab: [{ service: 'gateway', sha: 'a'.repeat(40), started_at: iso(START - 9 * MIN), finished_at: iso(START - 2 * MIN), outcome: 'deployed' }],
    cut: START,
  },
  {
    name: 'a skipped deploy never counts; the next real one does',
    github: [
      { created_at: iso(START + 10 * MIN), updated_at: iso(START + 10 * MIN), status: 'completed', conclusion: 'skipped' },
      { created_at: iso(START + 30 * MIN), updated_at: iso(START + 41 * MIN), status: 'completed', conclusion: 'success' },
    ],
    gitlab: [
      { service: 'gateway', sha: 'a'.repeat(40), started_at: iso(START + 10 * MIN), finished_at: iso(START + 10 * MIN), outcome: 'skipped' },
      { service: 'gateway', sha: 'b'.repeat(40), started_at: iso(START + 30 * MIN), finished_at: iso(START + 41 * MIN), outcome: 'deployed' },
    ],
    cut: START + 30 * MIN,
  },
  {
    name: 'a failed deploy counts (it may have rolled tasks)',
    github: [{ created_at: iso(START + 15 * MIN), updated_at: iso(START + 19 * MIN), status: 'completed', conclusion: 'failure' }],
    gitlab: [{ service: 'gateway', sha: 'b'.repeat(40), started_at: iso(START + 15 * MIN), finished_at: iso(START + 19 * MIN), outcome: 'failed' }],
    cut: START + 15 * MIN,
  },
  {
    name: 'a deploy older than the 6-hour lookback is ignored',
    github: [{ created_at: iso(START - 7 * 60 * MIN), updated_at: null, status: 'in_progress', conclusion: null }],
    gitlab: [{ service: 'gateway', sha: 'a'.repeat(40), started_at: iso(START - 7 * 60 * MIN), finished_at: null, outcome: 'deploying' }],
    cut: START,
  },
  {
    name: 'no deploy of this service: T_cut = run start (nothing attributed)',
    github: [],
    gitlab: [OTHER],
    cut: START,
  },
];

for (const s of SCENARIOS) {
  test(`deploy-runs file and GitHub listing give the same T_cut: ${s.name}`, async () => {
    const run = await loadRun();
    assert.equal(typeof run.deployRunsFromEntries, 'function', 'run.mjs exports deployRunsFromEntries');
    const mapped = run.deployRunsFromEntries(s.gitlab, 'gateway');
    assert.equal(mapped.ok, true, mapped.error);
    assert.equal(lib.deployCutoff(s.github, START), s.cut, 'the GitHub fixture gives the expected cutoff');
    assert.equal(lib.deployCutoff(mapped.runs, START), s.cut, 'the deploy-runs file gives the same cutoff');
  });
}

test('deploy-runs entries become the run shape deployCutoff reads, only for the service under test', async () => {
  const run = await loadRun();
  const mapped = run.deployRunsFromEntries(SCENARIOS[0].gitlab, 'gateway');
  assert.deepEqual(mapped, {
    ok: true,
    runs: [
      { created_at: iso(START - 40 * MIN), updated_at: iso(START - 30 * MIN), status: 'completed', conclusion: 'deployed' },
      { created_at: iso(START + 20 * MIN), updated_at: null, status: 'in_progress', conclusion: 'deploying' },
    ],
  });
  assert.deepEqual(run.deployRunsFromEntries(SCENARIOS[0].gitlab, 'community-app').runs.length, 1);
});

test('a malformed deploy-runs file is refused as a whole (fail closed), never partly read', async () => {
  const run = await loadRun();
  for (const [why, entries] of [
    ['not an array', { service: 'gateway' }],
    ['an entry that is not an object', ['gateway']],
    ['an entry without a service', [{ sha: 'a'.repeat(40), started_at: iso(START), finished_at: null, outcome: 'deployed' }]],
    ['an entry of this service without a valid started_at', [{ service: 'gateway', sha: 'a'.repeat(40), started_at: 'soon', finished_at: null, outcome: 'deployed' }]],
  ]) {
    const r = run.deployRunsFromEntries(entries, 'gateway');
    assert.equal(r.ok, false, why);
    assert.match(r.error, /\S/, `${why}: says why`);
  }
});

// ── deployRunsFor: the one place that chooses the source ─────────────────────────────────────────────────────────
// A fake `gh` first on PATH records every call and prints the GitHub fixture, so a GitHub call cannot go unnoticed.
function fakeBin(dir, { ghOut = '[]' } = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'gh-out.json'), ghOut);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "gh $*" >> "${join(dir, 'gh.log')}"\ncat "${join(dir, 'gh-out.json')}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\nprintf '%s\\n' "npx $*" >> "${join(dir, 'npx.log')}"\nexit 0\n`, { mode: 0o755 });
  return bin;
}
const ghCalls = (dir) => (existsSync(join(dir, 'gh.log')) ? readFileSync(join(dir, 'gh.log'), 'utf8').trim().split('\n') : []);

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('with --deploy-runs-file there is no gh call, even with a GitHub token present, and T_cut matches GitHub', async () => {
  const run = await loadRun();
  const dir = mkdtempSync(join(tmpdir(), 'deploy-runs-'));
  try {
    const s = SCENARIOS[0];
    const bin = fakeBin(dir, { ghOut: JSON.stringify(s.github) });
    const file = join(dir, 'deploy-runs.json');
    writeFileSync(file, JSON.stringify(s.gitlab));
    const runs = await withEnv({ PATH: `${bin}:${process.env.PATH}`, GITHUB_TOKEN: 'fake-token-for-the-test', VITANA_V1_READ_TOKEN: 'fake-token-for-the-test' },
      () => run.deployRunsFor('gateway', START, { 'deploy-runs-file': file }));
    assert.deepEqual(ghCalls(dir), [], 'no gh call');
    assert.equal(lib.deployCutoff(runs, START), lib.deployCutoff(s.github, START));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --deploy-runs-file the GitHub path is unchanged: the same gh call per service, the same runs', async () => {
  const run = await loadRun();
  const dir = mkdtempSync(join(tmpdir(), 'deploy-runs-'));
  try {
    const s = SCENARIOS[0];
    const bin = fakeBin(dir, { ghOut: JSON.stringify(s.github) });
    const env = { PATH: `${bin}:${process.env.PATH}`, GITHUB_TOKEN: 'fake-token-for-the-test', VITANA_V1_READ_TOKEN: 'fake-token-for-the-test' };
    const gw = await withEnv(env, () => run.deployRunsFor('gateway', START, {}));
    const app = await withEnv(env, () => run.deployRunsFor('community-app', START, {}));
    assert.deepEqual(gw, s.github);
    assert.deepEqual(app, s.github);
    const calls = ghCalls(dir);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^gh api -X GET repos\/exafyltd\/vitana-platform\/actions\/workflows\/AWS-STAGE-DEPLOY-GATEWAY\.yml\/runs -f created=>=\S+ -F per_page=100 --jq /);
    assert.match(calls[1], /^gh api -X GET repos\/exafyltd\/vitana-v1\/actions\/workflows\/AWS-STAGE-DEPLOY-FRONTEND\.yml\/runs /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing, empty or unreadable deploy-runs file fails closed: null (T_cut = run start), no GitHub fallback', async () => {
  const run = await loadRun();
  const dir = mkdtempSync(join(tmpdir(), 'deploy-runs-'));
  try {
    const bin = fakeBin(dir, { ghOut: JSON.stringify(SCENARIOS[0].github) });
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    const env = { PATH: `${bin}:${process.env.PATH}`, GITHUB_TOKEN: 'fake-token-for-the-test' };
    for (const value of [join(dir, 'missing.json'), join(dir, 'broken.json'), '', undefined]) {
      const runs = await withEnv(env, () => run.deployRunsFor('gateway', START, { 'deploy-runs-file': value }));
      assert.equal(runs, null, `deploy-runs-file=${JSON.stringify(value)}`);
      assert.equal(lib.deployCutoff(runs, START), START);
    }
    assert.deepEqual(ghCalls(dir), [], 'never a gh call');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── V4 dry runs: `run.mjs verify` end to end, no network ─────────────────────────────────────────────────────────
// fetch is replaced (node --import) before run.mjs loads: it answers the staging and production version stamps and the
// smoke suites from a table and refuses every other URL. Staging serves the commit under test for the pre-run check and
// a descendant afterwards (merged and deployed mid-run), so the run is superseded and T_cut decides attribution.
const FETCH_STUB = `
import { appendFileSync, readFileSync } from 'node:fs';
const sc = JSON.parse(readFileSync(process.env.STUB_SCENARIO, 'utf8'));
let stamps = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (stamp) => new Response('<html><head><meta name="vitana-app-version" content="' + stamp + '"></head><body><div id="root"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const stamp = () => (++stamps <= sc.beforeSamples ? sc.sha : sc.newer);
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  appendFileSync(process.env.STUB_LOG, method + ' ' + u.origin + u.pathname + '\\n');
  if (u.origin === 'https://preview-aws-gateway.vitanaland.com') {
    if (u.pathname === '/api/v1/admin/build-info') return json(200, { ok: true, env: 'staging', git_commit: sc.service === 'gateway' ? stamp() : sc.sha });
    if (u.pathname === '/api/v1/admin/health') return json(200, { ok: true, env: 'staging' });
    if (u.pathname === '/api/v1/community/members' || u.pathname === '/api/v1/operator/publish') return json(401, { ok: false });
    return json(200, { ok: true });
  }
  if (u.origin === 'https://preview-aws.vitanaland.com') {
    if (u.pathname === '/' && u.searchParams.has('staging-verify')) return html(stamp().slice(0, 12));
    if (u.pathname === '/nav-registry.json') return json(200, { screens: [] });
    return html(sc.sha.slice(0, 12));
  }
  if (u.origin === 'https://gateway.vitanaland.com' && u.pathname === '/api/v1/admin/build-info') return json(200, { git_commit: sc.production });
  if (u.origin === 'https://vitanaland.com' && u.pathname === '/') return html(sc.production.slice(0, 12));
  appendFileSync(process.env.STUB_LOG, 'REFUSED ' + u.href + '\\n');
  throw new TypeError('fetch failed: offline stub has no answer for ' + u.href);
};
`;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0',
};
const g = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// origin (bare) ← work; `target` is the job-start checkout at the commit under test; `newer` is merged after it.
function repoFixture(dir, service) {
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  g(dir, 'init', '-q', '--bare', origin);
  g(dir, 'init', '-q', work);
  const commit = (name) => {
    writeFileSync(join(work, 'notes', `${name}.txt`), name);
    g(work, 'add', '.');
    g(work, 'commit', '-q', '-m', name);
    return g(work, 'rev-parse', 'HEAD');
  };
  mkdirSync(join(work, 'notes'), { recursive: true });
  if (service === 'community-app') {
    // The community-app smoke suite names two Playwright specs; the fake npx stands in for Playwright.
    mkdirSync(join(work, 'tests', 'e2e', 'staging'), { recursive: true });
    for (const f of ['smoke.staging.spec.ts', 'screen-journey.staging.spec.ts']) {
      writeFileSync(join(work, 'tests', 'e2e', 'staging', f), "import { test, expect } from './staging-guard';\n");
    }
  }
  const production = commit('production');
  const sha = commit('under-test');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const target = join(dir, 'target');
  g(dir, 'clone', '-q', origin, target);
  const newer = commit('merged-mid-run');
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return { production, sha, newer, target };
}

function dryRun(service, { deployRuns, githubRuns, flag = true }) {
  const dir = mkdtempSync(join(tmpdir(), `dry-run-${service}-`));
  const repo = repoFixture(dir, service);
  const bin = fakeBin(dir, { ghOut: JSON.stringify(githubRuns || []) });
  const stub = join(dir, 'fetch-stub.mjs');
  writeFileSync(stub, FETCH_STUB);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ service, sha: repo.sha, newer: repo.newer, production: repo.production, beforeSamples: 5 }));
  const file = join(dir, 'deploy-runs.json');
  if (deployRuns !== undefined) writeFileSync(file, typeof deployRuns === 'string' ? deployRuns : JSON.stringify(deployRuns));
  const out = join(dir, 'out');
  const args = [
    '--import', pathToFileURL(stub).href, RUN_MJS, 'verify',
    '--service', service, '--sha', repo.sha, '--repo-root', repo.target, '--out', out, '--full', 'false', '--chain', '0',
    ...(flag ? ['--deploy-runs-file', file] : []),
  ];
  const r = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...GIT_ENV,
      STUB_SCENARIO: join(dir, 'scenario.json'), STUB_LOG: join(dir, 'fetch.log'),
      // A token is present on purpose: with the flag, run.mjs must still never call GitHub.
      GITHUB_TOKEN: 'fake-token-for-the-test', VITANA_V1_READ_TOKEN: 'fake-token-for-the-test',
      STAGING_VERIFY_SKIP_BROWSER_INSTALL: '1',
    },
  });
  const results = existsSync(join(out, 'results.json')) ? JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) : null;
  const fetchLog = existsSync(join(dir, 'fetch.log')) ? readFileSync(join(dir, 'fetch.log'), 'utf8') : '';
  const npxLog = existsSync(join(dir, 'npx.log')) ? readFileSync(join(dir, 'npx.log'), 'utf8') : '';
  const transcript = `$ node --import <offline fetch stub> run.mjs verify --service ${service} …${flag ? ' --deploy-runs-file deploy-runs.json' : ''}\nexit ${r.status}\n${r.stdout}${r.stderr}\n-- gh calls: ${JSON.stringify(ghCalls(dir))}\n-- npx calls: ${JSON.stringify(npxLog.trim().split('\n').filter(Boolean))}\n-- requests run.mjs made, all answered by the offline fetch stub (none left the process):\n${fetchLog}`;
  if (process.env.STAGING_VERIFY_DRY_RUN_OUT) {
    mkdirSync(process.env.STAGING_VERIFY_DRY_RUN_OUT, { recursive: true });
    writeFileSync(join(process.env.STAGING_VERIFY_DRY_RUN_OUT, `dry-run-${service}-${flag ? (deployRuns === undefined ? 'missing-file' : 'deploy-runs') : 'github'}.txt`), transcript);
  }
  const result = { status: r.status, output: `${r.stdout}${r.stderr}`, results, gh: ghCalls(dir), fetchLog, repo, transcript };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

// A deploy that started 10 minutes after the test started: later than the run start, so T_cut is this instant whatever
// the exact run start, in both processes.
function midRunDeploy(service) {
  const at = Date.now() + 10 * MIN;
  return {
    at,
    deployRuns: [
      { service: service === 'gateway' ? 'community-app' : 'gateway', sha: 'e'.repeat(40), started_at: iso(at - 3 * MIN), finished_at: null, outcome: 'deploying' },
      { service, sha: 'd'.repeat(40), started_at: iso(at), finished_at: null, outcome: 'deploying' },
    ],
    githubRuns: [{ created_at: iso(at), updated_at: iso(at), status: 'in_progress', conclusion: null }],
  };
}

for (const service of ['gateway', 'community-app']) {
  test(`dry run, ${service}: run.mjs verify with a deploy-runs file — no network, no gh call, T_cut from the file`, () => {
    const d = midRunDeploy(service);
    const r = dryRun(service, { deployRuns: d.deployRuns });
    assert.ok(r.results, `results.json written\n${r.transcript}`);
    assert.equal(r.results.outcome, 'superseded', r.transcript);
    assert.equal(r.results.superseded_by, r.repo.newer);
    assert.equal(r.results.attribution_cutoff, iso(lib.deployCutoff(d.githubRuns, d.at - 20 * MIN)), 'the same T_cut as the GitHub listing of the same deploy');
    assert.ok(r.results.results.length > 0 && r.results.results.every((x) => x.ok && x.attributed === true), r.transcript);
    assert.deepEqual(r.gh, [], 'no gh call');
    assert.doesNotMatch(r.fetchLog, /REFUSED/, 'every request was answered by the offline stub');
    assert.equal(r.status, 0, r.transcript);
  });

  test(`dry run, ${service}: without the flag the GitHub listing is used, with the same T_cut`, () => {
    const d = midRunDeploy(service);
    const r = dryRun(service, { githubRuns: d.githubRuns, flag: false });
    assert.equal(r.results?.outcome, 'superseded', r.transcript);
    assert.equal(r.results.attribution_cutoff, iso(d.at));
    assert.equal(r.gh.length, 1, r.transcript);
    assert.match(r.gh[0], service === 'gateway' ? /AWS-STAGE-DEPLOY-GATEWAY\.yml\/runs/ : /AWS-STAGE-DEPLOY-FRONTEND\.yml\/runs/);
  });
}

test('dry run, gateway: deploy-runs file missing on GitLab — fails closed (nothing attributed), says why, no GitHub fallback', () => {
  const before = Date.now();
  const r = dryRun('gateway', { deployRuns: undefined });
  assert.equal(r.results?.outcome, 'superseded', r.transcript);
  const cut = Date.parse(r.results.attribution_cutoff);
  assert.ok(cut >= before && cut <= Date.now(), 'T_cut = the run start');
  assert.ok(r.results.results.every((x) => x.attributed === false || x.static === true), 'no request result is attributed');
  assert.match(r.output, /deploy-runs file .*missing.*no GitHub fallback/i);
  assert.deepEqual(r.gh, [], 'no gh call');
});
