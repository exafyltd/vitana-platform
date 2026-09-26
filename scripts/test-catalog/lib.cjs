'use strict';
// VTID-04637 — Test catalog: pure logic, no I/O.
//
// The Command Hub Testing & QA module shows every automated test Vitanaland
// has, where it runs (development / nightly / staging / production), how often
// and whether it runs at all. That list is GENERATED from the two repositories
// on every merge — never typed in by hand, which is how the old Unit Tests tab
// ended up showing a July table that named Cloud Build.
//
// build.mjs walks the checkouts and hands file contents to buildCatalog().
// Everything that decides what a file is, which suite it belongs to, which
// workflow runs it and which environment that workflow touches lives here, so
// it is unit-tested (services/gateway/test/scripts/test-catalog-lib.test.ts).

const CATALOG_SCHEMA_VERSION = 1;

const REPOS = {
  platform: 'exafyltd/vitana-platform',
  frontend: 'exafyltd/vitana-v1',
};

// ── Environments ─────────────────────────────────────────────────────────
// The four labels every catalog entry carries (owner decision 2026-09-26):
//   dev_pr     — before merge, no deployed environment
//   nightly    — on main after merge / on a schedule, no deployed environment
//   staging    — against preview-aws(-gateway).vitanaland.com
//   production — against vitanaland.com / gateway.vitanaland.com (read-only)
const ENVIRONMENTS = ['dev_pr', 'nightly', 'staging', 'production'];

const PRODUCTION_HOSTS = new Set([
  'vitanaland.com',
  'www.vitanaland.com',
  'gateway.vitanaland.com',
  'dr-app.vitanaland.com',
  'dr-gateway.vitanaland.com',
  'dr-oasis-operator.vitanaland.com',
]);
const STAGING_HOSTS = new Set([
  'preview-aws.vitanaland.com',
  'preview-aws-gateway.vitanaland.com',
]);
// Hosts that no longer serve anything (GCP is decommissioned; the Cloud Run
// preview returns 500). A workflow still pointing at one is flagged.
const DEAD_HOST_PATTERNS = [/\.run\.app$/, /^preview\.vitanaland\.com$/, /^preview-gateway\.vitanaland\.com$/];

// ── Domains ──────────────────────────────────────────────────────────────
// The 15 domains of the developer atlas (orb/developer/domain-atlas.ts) plus
// 'frontend' for community-app screens. Assignment is by path keyword, first
// match wins; ordering matters (more specific first).
const DOMAIN_RULES = [
  ['backoffice', /backoffice|erp[-_/]|erp-bridge/],
  ['payments', /wallet|stripe|payment|billing|financial|monetiz|credits?\b/],
  ['commerce', /commerce|partner|merchant|marketplace|shop|offer|catalog-ingest|vcaop|vaea|awin|supplier|discover|cart/],
  ['support', /feedback|support|specialist|ticket/],
  ['autopilot', /autopilot|self-healing|self_healing|execut|approval|routine|triage|repair/],
  ['agents', /operator|orchestrator|agent|delegation|pillar|workforce|worker/],
  ['deploy', /deploy|publish|cicd|command-hub|commandhub|staging-verify|staging|build-info/],
  ['llm', /llm|bedrock|router|model/],
  ['memory', /memory|intelligence|context|awareness|brain|cognee|fact|longitudinal|d4\d|d5\d|d3\d|signal/],
  ['voice', /orb|voice|live|nova|livekit|tts|polly|fish|cascade|greeting|speech|audio|vertex/],
  ['community', /community|matchmak|match|chat|group|message|notification|push|feed|post|social|relationship|presence|intent|topic|news/],
  ['health', /health|longevity|journey|calendar|diary|reminder|habit|vitana-index|wearable|biomarker|lab[-_]|sleep|nutrition/],
  ['oasis', /oasis|vtid|governance|ledger|scheduler|test-contract|contract|event/],
  ['admin', /admin|auth|role|tenant|i18n|locale|user|profile|me\b|nav|navigation|settings|security|middleware/],
  ['infra', /infra|aws|ecs|aurora|db|migration|supabase|redis|config|script|ci\b/],
];
const DOMAINS = DOMAIN_RULES.map(([d]) => d).concat(['frontend', 'other']);

function domainFor(relPath) {
  const p = String(relPath).toLowerCase();
  for (const [domain, re] of DOMAIN_RULES) if (re.test(p)) return domain;
  return 'other';
}

// ── Test files ───────────────────────────────────────────────────────────
// Returns { runner, suite } for a path that is an automated test, else null.
// `suite` = { id, name, kind } — files are grouped into suites a supervisor
// can reason about (one per gateway test area, one per frontend area, one per
// sibling service, one per Playwright project folder).
function classifyTestFile(repo, relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  if (/(^|\/)node_modules\//.test(p) || /(^|\/)(dist|build|coverage)\//.test(p)) return null;

  if (repo === 'platform') {
    // Gateway Jest — only files under services/gateway/test/ are collected
    // (jest.config.js roots). services/gateway/tests/ and src/**/*.test.ts are
    // listed too but marked as never run.
    let m = p.match(/^services\/gateway\/test\/(.+\.test\.ts)$/);
    if (m) {
      const rest = m[1];
      const parts = rest.split('/');
      if (parts.length === 1) {
        return rest.startsWith('vtid-')
          ? { runner: 'jest', suite: { id: 'platform:gateway:regression', name: 'Gateway — change regressions (vtid-*)', kind: 'regression' } }
          : { runner: 'jest', suite: { id: 'platform:gateway:root', name: 'Gateway — top-level tests', kind: 'unit' } };
      }
      const area = parts[0];
      const sub = area === 'orb' || area === 'services' ? parts.slice(0, parts.length > 2 ? 2 : 1).join('/') : area;
      return { runner: 'jest', suite: { id: `platform:gateway:${sub}`, name: `Gateway — ${sub}`, kind: area === 'routes' ? 'integration' : 'unit' } };
    }
    if (/^services\/gateway\/tests\/.+\.test\.ts$/.test(p) || /^services\/gateway\/src\/.+\.test\.ts$/.test(p)) {
      return { runner: 'jest', suite: { id: 'platform:gateway:uncollected', name: 'Gateway — tests outside Jest roots (never run)', kind: 'unit' } };
    }
    m = p.match(/^e2e\/([^/]+)\/.+\.spec\.ts$/);
    if (m) return { runner: 'playwright', suite: { id: `platform:e2e:${m[1]}`, name: `E2E — ${m[1]}`, kind: 'e2e' } };
    if (/^e2e\/[^/]+\.spec\.ts$/.test(p)) return { runner: 'playwright', suite: { id: 'platform:e2e:root', name: 'E2E — root specs', kind: 'e2e' } };
    m = p.match(/^services\/([^/]+(?:\/[^/]+)?)\/.*\.(test|spec)\.(ts|tsx|js|mjs)$/);
    if (m && !p.startsWith('services/gateway/')) {
      const svc = p.startsWith('services/agents/') ? p.split('/').slice(1, 3).join('/') : p.split('/')[1];
      const runner = /openclaw-bridge/.test(svc) ? 'vitest' : 'jest';
      return { runner, suite: { id: `platform:svc:${svc}`, name: `Service — ${svc}`, kind: 'unit' } };
    }
    m = p.match(/^services\/(.+?)\/(?:.*\/)?test_[^/]+\.py$/);
    if (m) {
      const svc = p.startsWith('services/agents/') ? p.split('/').slice(1, 3).join('/') : p.split('/')[1];
      return { runner: 'pytest', suite: { id: `platform:py:${svc}`, name: `Python — ${svc}`, kind: 'unit' } };
    }
    if (/^scripts\/ci\/.+\.test\.cjs$/.test(p)) {
      return { runner: 'node-test', suite: { id: 'platform:scripts:ci', name: 'CI scripts (node --test)', kind: 'unit' } };
    }
    return null;
  }

  if (repo === 'frontend') {
    if (/^src\/tests\//.test(p) && /\.test\.tsx?$/.test(p)) {
      return { runner: 'vitest', suite: { id: 'frontend:src:tests-excluded', name: 'Frontend — src/tests (excluded self-checks)', kind: 'unit' } };
    }
    let m = p.match(/^src\/(.+)\.test\.tsx?$/);
    if (m) {
      const parts = p.split('/');
      let area = parts[1];
      if (/__regression__/.test(p)) {
        return { runner: 'vitest', suite: { id: 'frontend:calendar-golden', name: 'Frontend — calendar golden regression', kind: 'regression' } };
      }
      if ((area === 'components' || area === 'pages') && parts.length > 3) area = `${area}/${parts[2]}`;
      return { runner: 'vitest', suite: { id: `frontend:${area}`, name: `Frontend — ${area}`, kind: 'unit' } };
    }
    if (/^scripts\/.*-regression\.mjs$/.test(p)) {
      return { runner: 'node-script', suite: { id: 'frontend:node-regressions', name: 'Frontend — Node regression scripts', kind: 'regression' } };
    }
    if (/^tests\/e2e\/.+\.(mjs|ts|cjs)$/.test(p) || /^e2e-[^/]+\.cjs$/.test(p) || /^scripts\/e2e\/.+\.mjs$/.test(p) || /^tests\/[^/]+\.cjs$/.test(p)) {
      return { runner: 'playwright', suite: { id: 'frontend:e2e-scripts', name: 'Frontend — Playwright scripts', kind: 'e2e' } };
    }
    if (/^supabase\/functions\/.+_test\.ts$/.test(p)) {
      return { runner: 'deno', suite: { id: 'frontend:edge-functions', name: 'Supabase edge functions', kind: 'unit' } };
    }
    return null;
  }
  return null;
}

// Static count of test cases: it(/test( calls (incl. .each/.only/.skip) and
// python `def test_`. Parametrised expansion is not counted — a live run gives
// the real number.
function countCases(text, runner) {
  const s = String(text || '');
  if (runner === 'pytest') return (s.match(/^\s*(async\s+)?def\s+test_/gm) || []).length;
  // it( / test( / it.skip( / it.only( / it.each( / it.concurrent.each( … —
  // one call site counts once. `regex.test(` is excluded by the lookbehind on
  // a preceding dot or identifier character.
  return (s.match(/(^|[^.\w$])(it|test)(\.(only|skip|concurrent|todo|failing))?(\.each)?\s*\(/g) || []).length;
}

// ── Workflows ────────────────────────────────────────────────────────────
function extractHosts(text) {
  const hosts = new Set();
  const re = /https?:\/\/((?:[a-z0-9-]+\.)*vitanaland\.com|[a-z0-9.-]+\.run\.app)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) hosts.add(m[1].toLowerCase().replace(/\.$/, ''));
  return [...hosts].sort();
}

function hostClass(host) {
  if (DEAD_HOST_PATTERNS.some((re) => re.test(host))) return 'dead';
  if (STAGING_HOSTS.has(host)) return 'staging';
  if (PRODUCTION_HOSTS.has(host)) return 'production';
  if (/^pr-\d+|cloudfront/.test(host)) return 'preview';
  return 'other';
}

function parseTriggers(text) {
  const t = String(text || '');
  // Only look at the top-level `on:` block, up to the next top-level key.
  const onMatch = t.match(/^on:\s*\n([\s\S]*?)(?=^\S)/m) || t.match(/^on:\s*(.+)$/m);
  const block = onMatch ? onMatch[1] : '';
  const has = (k) => new RegExp(`(^|[\\s,\\[])${k}\\s*[:,\\]\\n]|^\\s*${k}\\s*$`, 'm').test(block) || new RegExp(`\\b${k}\\b`).test(block);
  const crons = [];
  const re = /cron:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(block))) crons.push(m[1].trim());
  return {
    pull_request: has('pull_request') || has('pull_request_target'),
    push: has('push'),
    schedule: crons,
    workflow_dispatch: has('workflow_dispatch'),
    workflow_run: has('workflow_run'),
    repository_dispatch: has('repository_dispatch'),
    workflow_call: has('workflow_call'),
  };
}

// YAML comment lines are documentation, not steps: a commented-out `npx jest`
// (CICDL-GATEWAY-CI.yml) must not make a workflow look like it runs tests.
function stripYamlComments(text) {
  return String(text || '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

function detectRunners(text) {
  const t = stripYamlComments(text);
  const r = [];
  if (/\bjest\b/.test(t) || /npm (run )?test\b|npm run test:|pnpm test/.test(t)) r.push('jest');
  if (/\bvitest\b|test:unit/.test(t)) r.push('vitest');
  if (/playwright/.test(t)) r.push('playwright');
  if (/\bpytest\b/.test(t)) r.push('pytest');
  if (/curl\s/.test(t)) r.push('http');
  if (/\/rest\/v1\/|psql\s|SUPABASE_SERVICE_ROLE|AURORA_DATABASE_URL/.test(t)) r.push('db');
  return [...new Set(r)];
}

// What kind of workflow this is, for the catalog. Only test / monitor / gate /
// smoke workflows are catalogued as runners; deploys without a check and
// one-shot ops workflows are listed as `other`.
// Explicit kinds for workflows whose file name does not say what they are.
// Scheduled JOBS (they change data, they do not check anything) are 'job' and
// are not catalogued as tests.
const WORKFLOW_KIND_OVERRIDES = {
  'CRON-AUTO-PROMOTER.yml': 'job',
  'CRON-GRADUATION-RECOMMENDER.yml': 'job',
  'DEV-AUTOPILOT.yml': 'job',
  'MARKETPLACE-SYNC-CRON.yml': 'job',
  'I18N-DB-SEED.yml': 'job',
  'I18N-PROPAGATE.yml': 'job',
  'CODEINTEL-INDEX.yml': 'job',
  'TEST-CATALOG.yml': 'job',
  'CRON-SHADOW-COMPARISON-REPORT.yml': 'monitor',
  'i18n-audit-llm.yml': 'monitor',
  'VALIDATOR-CHECK.yml': 'gate',
  'STAGING-TESTS-REQUIRED.yml': 'gate',
  'STAGING-VERIFY.yml': 'e2e',
  'SMOKE-WELCOME-GREETING.yml': 'monitor',
  'AWS-STAGING-VALIDATION.yml': 'e2e',
};

function classifyWorkflowKind(file, text, triggers, runners) {
  if (WORKFLOW_KIND_OVERRIDES[file]) return WORKFLOW_KIND_OVERRIDES[file];
  const f = file.toUpperCase();
  const tokens = f.replace(/\.YA?ML$/, '').split(/[-_]/);
  const t = stripYamlComments(text);
  const runsTests = runners.some((r) => ['jest', 'vitest', 'pytest', 'playwright'].includes(r));
  if (/^APPLY$|^RUN$/.test(tokens[0]) || tokens.includes('MIGRATION')) return 'job';
  if (tokens[0] === 'ALERT' || /MONITOR|HEALTH|STATUS|SCREEN-LOAD|SHADOW/.test(f)) return 'monitor';
  if (tokens.includes('DEPLOY')) return runsTests || /smoke|verify/i.test(t) ? 'deploy_smoke' : 'other';
  if (tokens.includes('E2E') || /VERIFY|SMOKE/.test(f)) return 'e2e';
  if (tokens.some((x) => ['TEST', 'TESTS', 'UNIT', 'REGRESSION', 'INTEGRATION', 'PERSISTENCE', 'CI', 'GUARDRAILS'].includes(x)) || runsTests) {
    return runsTests ? 'test' : (triggers.pull_request ? 'gate' : 'placeholder');
  }
  if (triggers.pull_request && /VALIDATOR|GUARD|CHECK|LINT|ENFORCE|GATE|NAMING|DOC|DRIFT|SCANNER|RECONCILE|PARITY|IMPACT|REQUIRED|I18N/.test(f)) return 'gate';
  return 'other';
}

// Environments a workflow touches. Hosts named in the file decide staging vs
// production; deploy workflows are labelled by what they deploy; database
// monitors read the one shared (production) Supabase project.
const WORKFLOW_ENV_OVERRIDES = {
  'STAGING-VERIFY.yml': ['staging'],
  'STAGING-TESTS-REQUIRED.yml': ['dev_pr'],
};

function environmentsForWorkflow(triggers, hosts, kind, file = '', runners = []) {
  if (WORKFLOW_ENV_OVERRIDES[file]) return WORKFLOW_ENV_OVERRIDES[file];
  const env = new Set();
  const f = file.toUpperCase();
  if (kind === 'deploy_smoke') {
    if (/PROD/.test(f) || f === 'DEPLOY.YML') env.add('production');
    else env.add('staging');
    return ENVIRONMENTS.filter((e) => env.has(e));
  }
  const classes = hosts.map(hostClass);
  if (classes.includes('staging') || classes.includes('preview')) env.add('staging');
  if (classes.includes('production')) env.add('production');
  if (kind === 'monitor' && runners.includes('db') && !env.has('staging')) env.add('production');
  const deployed = env.size > 0;
  if (triggers.pull_request && (kind === 'test' || kind === 'gate' || !deployed)) env.add('dev_pr');
  if (!deployed && (triggers.push || triggers.schedule.length) && kind === 'test') env.add('nightly');
  return ENVIRONMENTS.filter((e) => env.has(e));
}

function parseWorkflow(repo, file, text) {
  const t = String(text || '');
  const nameMatch = t.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
  const triggers = parseTriggers(t);
  const hosts = extractHosts(stripYamlComments(t));
  const runners = detectRunners(t);
  const kind = classifyWorkflowKind(file, t, triggers, runners);
  const deadHosts = hosts.filter((h) => hostClass(h) === 'dead');
  const flags = [];
  if (deadHosts.length) flags.push('dead_host');
  if (runners.includes('playwright') && hosts.some((h) => hostClass(h) === 'production')) flags.push('ui_test_touches_production');
  if (kind === 'placeholder') flags.push('placeholder_no_tests');
  return {
    id: `${repo}:${file}`,
    repo: REPOS[repo],
    file,
    name: nameMatch ? nameMatch[1] : file,
    kind,
    triggers,
    schedules: triggers.schedule.map((c) => ({ cron: c, human: describeCron(c) })),
    hosts,
    dead_hosts: deadHosts,
    runners,
    environments: environmentsForWorkflow(triggers, hosts, kind, file, runners),
    manual_trigger: triggers.workflow_dispatch,
    flags,
  };
}

// Human text for a 5-field cron, UTC. Covers the shapes used in both repos;
// anything else falls back to the raw expression.
function describeCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f;
  const pad = (n) => String(n).padStart(2, '0');
  const days = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun' };
  if (dom === '*' && mon === '*') {
    let m = min.match(/^\*\/(\d+)$/);
    if (m && hour === '*' && dow === '*') return `every ${m[1]} min`;
    if (min === '*' && hour === '*' && dow === '*') return 'every minute';
    if (/^\d+(,\d+)+$/.test(min) && hour === '*' && dow === '*') return `twice hourly at :${min.split(',').map(pad).join(', :')}`;
    if (/^\d+$/.test(min) && hour === '*' && dow === '*') return `hourly at :${pad(min)}`;
    m = hour.match(/^\*\/(\d+)$/);
    if (/^\d+$/.test(min) && m && dow === '*') return `every ${m[1]} h at :${pad(min)}`;
    if (/^\d+$/.test(min) && /^\d+(,\d+)*$/.test(hour)) {
      const times = hour.split(',').map((h) => `${pad(h)}:${pad(min)}`).join(', ');
      if (dow === '*') return `daily ${times} UTC`;
      if (/^[0-7](,[0-7])*$/.test(dow)) return `${dow.split(',').map((d) => days[d]).join(', ')} ${times} UTC`;
      if (dow === '1-5') return `weekdays ${times} UTC`;
    }
  }
  return expr;
}

// Runs per day implied by a cron, for "how often" totals. Approximate.
function runsPerDay(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const count = (field, span) => {
    if (field === '*') return span;
    const step = field.match(/^\*\/(\d+)$/);
    if (step) return Math.ceil(span / Number(step[1]));
    return field.split(',').length;
  };
  let perDay = count(min, 60) * count(hour, 24);
  if (dow !== '*') perDay = perDay * (dow.split(',').length) / 7;
  if (dom !== '*' || mon !== '*') perDay = perDay / 30;
  return Math.round(perDay * 100) / 100;
}

// ── Suite → workflow wiring ──────────────────────────────────────────────
// Which workflows execute each suite. Patterns match suite ids. A suite that
// matches nothing is `never_run` — shown as a gap, not hidden.
const SUITE_RUNNERS = [
  [/^platform:gateway:(?!uncollected)/, ['platform:TEST-SUITE.yml']],
  [/^platform:svc:vcaop$/, ['platform:TEST-SUITE.yml', 'platform:VCAOP-CICD.yml', 'platform:VCAOP-GUARDRAILS-CI.yml', 'platform:VCAOP-HEALTH.yml']],
  [/^platform:svc:(oasis-projector|openclaw-bridge)$/, ['platform:TEST-SUITE.yml']],
  [/^platform:py:erp-bridge$/, ['platform:AWS-STAGE-DEPLOY-ERP-BRIDGE.yml']],
  [/^platform:e2e:(community-desktop|community-mobile|command-hub)$/, ['platform:E2E-TEST-RUN.yml', 'platform:E2E-ORB-MONITOR.yml', 'platform:SCREEN-LOAD-TIMING.yml']],
  [/^platform:e2e:mobile-sim$/, ['platform:MOBILE-DEVICE-E2E.yml', 'platform:ANDROID-DEVICE-E2E.yml']],
  [/^platform:scripts:ci$/, ['platform:TEST-SUITE.yml']],
  [/^frontend:calendar-golden$/, ['frontend:UNIT-TESTS.yml', 'frontend:CALENDAR-REGRESSION.yml']],
  [/^frontend:(?!src:tests-excluded|node-regressions|e2e-scripts|edge-functions)/, ['frontend:UNIT-TESTS.yml']],
  [/^frontend:e2e-scripts$/, ['frontend:E2E-PREVIEW-ORB.yml']],
];

function runnersForSuite(suiteId, workflowIds) {
  const known = new Set(workflowIds);
  for (const [re, ids] of SUITE_RUNNERS) {
    if (re.test(suiteId)) return ids.filter((id) => known.has(id));
  }
  return [];
}

// ── Named suites (npm scripts) ───────────────────────────────────────────
// Regression suites a supervisor asks for by name. `files` lists the test
// files the script runs; resolved against the scanned files.
function parseNamedSuites(repo, pkgJsonText, pkgDir) {
  let pkg;
  try { pkg = JSON.parse(pkgJsonText); } catch { return []; }
  const out = [];
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (!/^test:/.test(name) || /:(watch|coverage|headed)$/.test(name)) continue;
    const args = String(cmd).split(/\s+/).filter((a) => a && !a.startsWith('-') && !/^(jest|vitest|run|node|npx)$/.test(a));
    out.push({
      id: `${repo}:named:${pkgDir}:${name}`,
      repo: REPOS[repo],
      name: `npm run ${name}`,
      package_dir: pkgDir,
      command: String(cmd),
      targets: args.map((a) => (pkgDir && pkgDir !== '.' ? `${pkgDir}/${a}` : a)),
    });
  }
  return out;
}

// ── Catalog assembly ─────────────────────────────────────────────────────
// input: {
//   generated_at, sources: { platform: {sha}, frontend: {sha} },
//   files: [{ repo:'platform'|'frontend', path, text }],
//   workflows: [{ repo, file, text }],
//   packages: [{ repo, dir, text }],
// }
function buildCatalog(input) {
  const workflows = (input.workflows || []).map((w) => parseWorkflow(w.repo, w.file, w.text));
  const wfById = new Map(workflows.map((w) => [w.id, w]));
  const wfIds = workflows.map((w) => w.id);

  const suites = new Map();
  const files = [];
  for (const f of input.files || []) {
    const c = classifyTestFile(f.repo, f.path);
    if (!c) continue;
    const cases = countCases(f.text, c.runner);
    let domain = domainFor(f.path);
    if (domain === 'other' && f.repo === 'frontend') domain = 'frontend';
    files.push({ repo: REPOS[f.repo], path: f.path, suite_id: c.suite.id, runner: c.runner, cases, domain });
    let s = suites.get(c.suite.id);
    if (!s) {
      s = { ...c.suite, repo: REPOS[f.repo], runner: c.runner, files: 0, cases: 0, domains: {} };
      suites.set(c.suite.id, s);
    }
    s.files += 1;
    s.cases += cases;
    s.domains[domain] = (s.domains[domain] || 0) + 1;
  }

  const suiteList = [...suites.values()].map((s) => {
    const runsIn = runnersForSuite(s.id, wfIds);
    const envs = new Set();
    const schedules = [];
    for (const id of runsIn) {
      const w = wfById.get(id);
      w.environments.forEach((e) => envs.add(e));
      w.schedules.forEach((sc) => schedules.push({ workflow: w.file, ...sc }));
    }
    const topDomain = Object.entries(s.domains).sort((a, b) => b[1] - a[1])[0];
    const flags = [];
    if (runsIn.length === 0) flags.push('never_run');
    if (s.id === 'platform:gateway:uncollected' || s.id === 'frontend:src:tests-excluded') flags.push('outside_runner_roots');
    return {
      id: s.id,
      name: s.name,
      repo: s.repo,
      kind: s.kind,
      runner: s.runner,
      files: s.files,
      cases: s.cases,
      domain: topDomain ? topDomain[0] : 'other',
      domains: s.domains,
      runs_in: runsIn.map((id) => wfById.get(id).file),
      environments: ENVIRONMENTS.filter((e) => envs.has(e)),
      schedules,
      never_run: runsIn.length === 0,
      flags,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const fileSet = new Set(files.map((f) => `${f.repo}|${f.path}`));
  const named = [];
  for (const p of input.packages || []) {
    for (const n of parseNamedSuites(p.repo, p.text, p.dir)) {
      const targetFiles = files.filter((f) => f.repo === n.repo && n.targets.some((t) => f.path === t || f.path.startsWith(t.replace(/\/$/, '') + '/')));
      named.push({
        ...n,
        files: targetFiles.length,
        cases: targetFiles.reduce((a, f) => a + f.cases, 0),
        resolved: targetFiles.length > 0 || n.targets.some((t) => fileSet.has(`${n.repo}|${t}`)),
      });
    }
  }

  const catalogued = workflows.filter((w) => w.kind !== 'other' && w.kind !== 'job');
  const summary = summarize(suiteList, files, catalogued);

  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    generated_at: input.generated_at || null,
    sources: input.sources || {},
    summary,
    suites: suiteList,
    named_suites: named.sort((a, b) => a.id.localeCompare(b.id)),
    workflows: catalogued.sort((a, b) => a.id.localeCompare(b.id)),
    other_workflows: workflows.filter((w) => w.kind === 'other' || w.kind === 'job').map((w) => ({ id: w.id, file: w.file, name: w.name, kind: w.kind, schedules: w.schedules, flags: w.flags })),
    files,
  };
}

function summarize(suites, files, workflows) {
  const byEnv = Object.fromEntries(ENVIRONMENTS.map((e) => [e, { suites: 0, workflows: 0 }]));
  suites.forEach((s) => s.environments.forEach((e) => { byEnv[e].suites += 1; }));
  workflows.forEach((w) => w.environments.forEach((e) => { byEnv[e].workflows += 1; }));
  const byRunner = {};
  files.forEach((f) => {
    byRunner[f.runner] = byRunner[f.runner] || { files: 0, cases: 0 };
    byRunner[f.runner].files += 1;
    byRunner[f.runner].cases += f.cases;
  });
  const byDomain = {};
  files.forEach((f) => {
    byDomain[f.domain] = byDomain[f.domain] || { files: 0, cases: 0 };
    byDomain[f.domain].files += 1;
    byDomain[f.domain].cases += f.cases;
  });
  const scheduledRunsPerDay = workflows.reduce((a, w) => a + w.schedules.reduce((b, s) => b + (runsPerDay(s.cron) || 0), 0), 0);
  return {
    files: files.length,
    cases: files.reduce((a, f) => a + f.cases, 0),
    suites: suites.length,
    never_run_suites: suites.filter((s) => s.never_run).map((s) => s.id),
    workflows: workflows.length,
    scheduled_workflows: workflows.filter((w) => w.schedules.length).length,
    scheduled_runs_per_day: Math.round(scheduledRunsPerDay),
    flagged_workflows: workflows.filter((w) => w.flags.length).map((w) => ({ file: w.file, flags: w.flags })),
    by_environment: byEnv,
    by_runner: byRunner,
    by_domain: byDomain,
  };
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  REPOS,
  ENVIRONMENTS,
  DOMAINS,
  PRODUCTION_HOSTS,
  STAGING_HOSTS,
  domainFor,
  classifyTestFile,
  countCases,
  extractHosts,
  hostClass,
  parseTriggers,
  detectRunners,
  classifyWorkflowKind,
  stripYamlComments,
  WORKFLOW_KIND_OVERRIDES,
  environmentsForWorkflow,
  parseWorkflow,
  describeCron,
  runsPerDay,
  runnersForSuite,
  parseNamedSuites,
  buildCatalog,
};
