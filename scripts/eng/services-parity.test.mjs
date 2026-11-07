// VTID-05550 (plan agentic-delivery §3.3, §2.2): the service list agrees with config/service-path-map.json (the map the
// gateway reads, routes/cicd.ts:111) and claims every path filter of today's pull-request workflows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE = process.env.PIPELINE_GEN_MODULE || path.join(ROOT, 'scripts/eng/pipeline-gen.mjs');
const gen = await import(pathToFileURL(MODULE).href);
const config = gen.loadServices(ROOT);
const map = JSON.parse(readFileSync(path.join(ROOT, 'config/service-path-map.json'), 'utf8'));
const platform = config.repositories['vitana-platform'];

test('the service list has schema vitana.delivery-services/v1 and both repositories', () => {
  assert.equal(config.schema, 'vitana.delivery-services/v1');
  assert.deepEqual(Object.keys(config.repositories).sort(), ['vitana-platform', 'vitana-v1']);
  for (const r of Object.values(config.repositories)) for (const [name, s] of Object.entries(r.services)) {
    assert.ok(Array.isArray(s.paths) && s.paths.length > 0, `${name} has no paths`);
    for (const c of s.checks) assert.ok(r.checks[c], `${name} names unknown check ${c}`);
  }
});

test('platform service paths equal config/service-path-map.json', () => {
  const fromMap = Object.fromEntries(Object.entries(map.mappings).map(([k, v]) => [k, v.paths.map((p) => `${p.replace(/\/$/, '')}/**/*`).sort()]));
  const fromList = Object.fromEntries(Object.entries(platform.services).filter(([, s]) => s.path_map === true).map(([k, s]) => [k, [...s.paths].sort()]));
  assert.deepEqual(fromList, fromMap);
  for (const p of map.shared.paths) assert.ok(platform.shared_paths.includes(`${p.replace(/\/$/, '')}/**/*`), `shared ${p}`);
  for (const [k, s] of Object.entries(platform.services)) if (s.path_map !== true) assert.ok(s.path_map === false || s.area === true, `${k}: path_map must be true, false or an area`);
});

test('the gateway service carries the env_overrides of plan §3.6 step 2; the deployable services have images and staging targets', () => {
  assert.deepEqual(platform.services.gateway.env_overrides, { PM_AGENT_ENABLED: 'false', DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' });
  const deploys = Object.entries(platform.services).filter(([, s]) => s.staging).map(([k]) => k).sort();
  assert.deepEqual(deploys, ['erp-bridge', 'gateway', 'kiro-runner', 'postgrest-aurora-proxy']);
  const v1 = config.repositories['vitana-v1'];
  assert.deepEqual(Object.keys(v1.services).sort(), ['calendar', 'community-app', 'edge-functions', 'i18n', 'mobile', 'sql']);
  assert.equal(v1.services['community-app'].staging_verify, 'community-app');
  assert.equal(v1.services['community-app'].preview, 'spa');
  assert.equal(platform.services.gateway.staging_verify, 'gateway');
  assert.deepEqual(Object.keys(v1.assist_rules).sort(), ['i18n-nightly', 'i18n-propagate']);
});

// A path a GitHub path filter can match: wildcards replaced by a literal segment.
const sample = (p) => p.replace(/\{([^,}]*)[^}]*\}/g, '$1').replace(/\*\*\//g, 'x/').replace(/\/\*\*$/, '/x/y').replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x');

function prWorkflowFilters() {
  const dir = path.join(ROOT, '.github/workflows');
  const out = {};
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const lines = readFileSync(path.join(dir, f), 'utf8').split('\n');
    let inPR = false; let inPaths = false; const paths = [];
    for (const l of lines) {
      if (/^  pull_request:/.test(l)) { inPR = true; continue; }
      if (inPR && /^  [a-z_]+:/.test(l)) { inPR = false; inPaths = false; }
      if (/^[a-z]/.test(l) && !/^on:/.test(l)) { inPR = false; inPaths = false; }
      if (inPR && /^    paths:/.test(l)) { inPaths = true; continue; }
      if (inPaths) { const m = l.match(/^      - ['"]?([^'"#]+?)['"]?\s*(#.*)?$/); if (m) paths.push(m[1].trim()); else if (l.trim() && !/^\s*#/.test(l)) inPaths = false; }
    }
    if (paths.length) out[f] = paths;
  }
  return out;
}

test('every path filter of the platform pull-request workflows maps to a service, and selects that workflow\'s checks', () => {
  const filters = prWorkflowFilters();
  const failures = [];
  for (const [wf, paths] of Object.entries(filters)) {
    const e = platform.github_workflows[wf];
    if (!e) { failures.push(`${wf}: not in the registry`); continue; }
    if (e.fate === 'kept' || e.fate === 'dead') continue;
    const jobs = e.fate === 't1' ? e.jobs : e.pr_jobs || [];
    for (const p of paths) {
      const s = sample(p);
      const { selected, unknown } = gen.selectChecks(config, 'vitana-platform', [s]);
      if (unknown.length) failures.push(`${wf}: ${p} (${s}) maps to no service`);
      for (const j of jobs) if (!selected.includes(j)) failures.push(`${wf}: ${p} (${s}) does not select ${j}`);
    }
  }
  assert.deepEqual(failures, []);
  // The reader found the filter of every registry entry that says it has one (so a parse gap cannot pass silently).
  const unread = Object.entries(platform.github_workflows)
    .filter(([wf, e]) => e.path_filter === true && e.fate === 't1' && existsSync(path.join(ROOT, '.github/workflows', wf)) && !filters[wf])
    .map(([wf]) => wf);
  assert.deepEqual(unread, []);
  assert.ok(Object.keys(filters).length > 0, 'no pull-request path filter found');
});

test('every vitana-v1 workflow path filter recorded in the service list selects its checks', () => {
  const v1 = config.repositories['vitana-v1'];
  const failures = [];
  for (const [svc, s] of Object.entries(v1.services)) for (const p of s.paths) {
    const { selected, unknown } = gen.selectChecks(config, 'vitana-v1', [sample(p)]);
    if (unknown.length) failures.push(`${svc}: ${p} unknown`);
    for (const c of s.checks) if (!selected.includes(c)) failures.push(`${svc}: ${p} does not select ${c}`);
  }
  assert.deepEqual(failures, []);
});
