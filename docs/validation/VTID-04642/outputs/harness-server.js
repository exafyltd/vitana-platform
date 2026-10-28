// VTID-04642 local visual-verification harness (pattern of VTID-04282):
// Command Hub statics from the working tree + stubbed APIs. Nothing here
// calls a live system.
//  - /api/v1/testing/catalog: the REAL catalog, built by scripts/test-catalog
//    over this checkout and exafyltd/vitana-v1 (catalog.json next to this file
//    when run; not committed, it is ~1 MB).
//  - /api/v1/testing/results/*: the REAL summarizeWorkflows/summarizeEnvironments
//    (compiled from src/services/testing/test-results.ts) over synthetic runs
//    for real catalog workflows (this sandbox has no GitHub Actions token), and
//    the STAGING-VERIFY verdicts read from OASIS on 2026-09-26 (read-only).
const path = require('path');
const fs = require('fs');
const ts = require('/home/user/vitana-platform/services/gateway/node_modules/typescript');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const ROOT = process.env.WORKTREE || '/home/user/vp-p3';
const STATIC = path.join(ROOT, 'services/gateway/src/frontend/command-hub');
const CATALOG = JSON.parse(fs.readFileSync(process.env.CATALOG_JSON, 'utf8'));

const src = fs.readFileSync(path.join(ROOT, 'services/gateway/src/services/testing/test-results.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { summarizeWorkflows, summarizeEnvironments, buildWorkflowIndex } = mod.exports;

const now = Date.now();
const index = buildWorkflowIndex(CATALOG);
const plan = {
  'exafyltd/vitana-platform|TEST-SUITE.yml': ['success', 'success', 'failure', 'success', 'success', 'success'],
  'exafyltd/vitana-platform|VALIDATOR-CHECK.yml': ['success', 'failure', 'success', 'success'],
  'exafyltd/vitana-platform|STAGING-VERIFY.yml': ['success', 'failure', 'failure', 'success'],
  'exafyltd/vitana-platform|E2E-ORB-MONITOR.yml': ['failure', 'failure', 'failure', 'success'],
  'exafyltd/vitana-platform|ALERT-PUSH-DISPATCH-HEALTH.yml': ['success', 'success', 'success'],
  'exafyltd/vitana-v1|UNIT-TESTS.yml': ['success', 'success', 'success'],
  'exafyltd/vitana-v1|CALENDAR-REGRESSION.yml': ['success', 'failure'],
};
const rows = [];
let id = 36240000000;
for (const [key, verdicts] of Object.entries(plan)) {
  const [repo, file] = key.split('|');
  const entry = index.get(key);
  if (!entry) continue;
  verdicts.forEach((conclusion, i) => {
    const created = new Date(now - (i * 7 + 1) * 3600e3).toISOString();
    rows.push({ repo, run_id: id++, run_attempt: 1, workflow_file: file, workflow_name: entry.name, kind: entry.kind, environments: entry.environments,
      event: i % 2 ? 'push' : 'pull_request', branch: 'main', head_sha: (key === 'exafyltd/vitana-platform|VALIDATOR-CHECK.yml' ? 'a1b2c3d4' : 'f' + id.toString(16)), status: 'completed', conclusion,
      html_url: `https://github.com/${repo}/actions/runs/${id}`, run_created_at: created, run_started_at: created, run_updated_at: created, duration_s: 60 + i * 37,
      jobs: conclusion === 'failure' ? [{ name: 'verify', conclusion: 'failure' }] : [{ name: 'build', conclusion: 'success' }] });
  });
}
const workflows = summarizeWorkflows(rows, now);
const summary = { ok: true, window_days: 30, runs: rows.length, environments: summarizeEnvironments(workflows), workflows,
  staging_verify: [
    { service: 'gateway', outcome: 'passed', commit: '8a2b6bf81a803a453530760e5516e92fac2ecdd2', at: '2026-09-26T12:09:52Z', run_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/36240937272', tests: 38, failed: [] },
    { service: 'community-app', outcome: 'failed', commit: 'ccdc7efeb38f1330c9f62bc6828dd2d4b409a099', at: '2026-09-26T12:21:26Z', run_url: null, tests: 8, failed: [{ suite: 'smoke', name: 'app boots against the staging gateway without runtime errors', problems: ['staging-guard aborted 1 request(s) — staging writes reach production data, and a staging build must not call production'] }] },
  ],
  sync: { synced: false, sync_error: null, state: [
    { repo: 'exafyltd/vitana-platform', last_synced_at: new Date(now - 90e3).toISOString(), last_error: null },
    { repo: 'exafyltd/vitana-v1', last_synced_at: new Date(now - 90e3).toISOString(), last_error: null } ] } };

const app = express();
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/testing/catalog', (_q, r) => r.json({ ok: true, from_cache: true, source: 'harness', ...CATALOG }));
app.get('/api/v1/testing/catalog/suite', (q, r) => {
  const suite = CATALOG.suites.find((s) => s.id === q.query.id);
  if (!suite) return r.status(404).json({ ok: false, error: 'suite_not_found' });
  r.json({ ok: true, suite, files: CATALOG.files.filter((f) => f.suite_id === suite.id), workflows: [] });
});
app.get('/api/v1/testing/results/summary', (_q, r) => r.json(summary));
app.get('/api/v1/testing/results/runs', (q, r) => {
  let out = rows.slice().sort((a, b) => b.run_created_at.localeCompare(a.run_created_at));
  if (q.query.environment) out = out.filter((x) => x.environments.includes(q.query.environment));
  if (q.query.conclusion) out = out.filter((x) => x.conclusion === q.query.conclusion);
  if (q.query.repo) out = out.filter((x) => x.repo === q.query.repo);
  r.json({ ok: true, runs: out, count: out.length, sync_error: null });
});
app.post('/api/v1/testing/results/sync', (_q, r) => r.json({ ok: true, synced: true, results: [] }));
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [], runs: [], suites: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18642), () => console.log('harness up'));
