// VTID-04282 local visual-verification harness (pattern of VTID-04032):
// Command Hub statics from the working tree + stubbed APIs. The supervisor
// payload is supervisor-snapshot-from-live-rows.json — the REAL
// buildSupervisorSnapshot() run over staging/prod rows read on 2026-09-22
// (read-only). Scanner / rule / execution rows are the live rows too,
// descriptions shortened. Nothing here calls a live system.
const path = require('path');
const fs = require('fs');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const SUP = JSON.parse(fs.readFileSync(path.join(__dirname, 'supervisor-snapshot-from-live-rows.json'), 'utf8'));
const app = express();
app.use(express.json());

const S = (scanner, title, category, maturity, sev, risk, enabled) => ({ scanner, title, category, maturity, default_severity: sev, default_risk_class: risk, enabled, signal_type: scanner.replace(/-scanner-v1$/, ''), description: title + ' (live registry row, description shortened for the harness).' });
const scanners = [
  S('safety-gap-scanner-v1', 'Infrastructure test gaps', 'architecture', 'stable', 'medium', 'medium', true),
  S('schema-drift-scanner-v1', 'Gateway reads missing columns', 'data_integrity', 'beta', 'high', 'medium', true),
  S('npm-audit-scanner-v1', 'Dependency CVEs', 'dependencies', 'stable', 'high', 'medium', true),
  S('product-gap-scanner-v1', 'LLM-proposed extension opportunities', 'product', 'alpha', 'low', 'medium', false),
  S('dead-code-scanner-v1', 'Unreferenced exports', 'quality', 'alpha', 'low', 'low', true),
  S('large-file-scanner-v1', 'Files above line threshold', 'quality', 'stable', 'medium', 'high', true),
  S('missing-tests-scanner-v1', 'Routes/services without tests', 'quality', 'stable', 'medium', 'medium', true),
  S('stale-feature-flag-scanner-v1', 'Feature flags stale for 90+ days', 'quality', 'beta', 'low', 'low', true),
  S('todo-scanner-v1', 'TODO / FIXME / HACK markers', 'quality', 'stable', 'low', 'medium', true),
  S('rls-policy-scanner-v1', 'Unprotected write-target tables', 'security', 'beta', 'high', 'medium', true),
  S('route-auth-scanner-v1', 'Routes without auth middleware', 'security', 'beta', 'high', 'medium', true),
  S('secret-exposure-scanner-v1', 'Hardcoded secrets in source', 'security', 'beta', 'high', 'high', true),
];
const allow = ['safety-gap-scanner-v1','secret-exposure-scanner-v1','stale-feature-flag-scanner-v1','todo-scanner-v1','npm-audit-scanner-v1','dead-code-scanner-v1','missing-tests-scanner-v1','large-file-scanner-v1','route-auth-scanner-v1','rls-policy-scanner-v1','schema-drift-scanner-v1'];
const open = {};
SUP.findings.items.filter((f) => f.status === 'new').forEach((f) => { open[f.detector] = (open[f.detector] || 0) + 1; });
const scannerRows = scanners.map((s) => ({ ...s, open_findings: open[s.scanner] || 0, last_signal_at: '2026-09-22T12:21:59Z', auto_approved: allow.includes(s.scanner), in_auto_approve_list: allow.includes(s.scanner) }));
const R = (rule, title, category, severity) => ({ rule, title, category, severity, enabled: true, description: title + ' (live registry row, description shortened for the harness).' });
const ruleAllow = ['new-mutation-without-oasis-emit','migration-requires-code-touch','new-route-needs-test','new-route-without-auth-middleware','new-env-var-requires-workflow-binding'];
const rules = [
  R('migration-requires-code-touch', 'Migration added without any gateway code change', 'companion', 'warning'),
  R('new-env-var-requires-workflow-binding', 'New process.env.X without a binding', 'companion', 'warning'),
  R('new-impact-rule-needs-seed-migration', 'New impact rule file needs a DB seed migration', 'companion', 'warning'),
  R('new-oasis-event-requires-union', 'emitOasisEvent type must be in the union', 'companion', 'blocker'),
  R('new-route-needs-test', 'New gateway route without a sibling test', 'companion', 'warning'),
  R('new-scanner-needs-seed-migration', 'New scanner file needs a DB seed migration', 'companion', 'warning'),
  R('new-signal-type-requires-registry', 'New SignalType needs a scanner registry entry', 'companion', 'blocker'),
  R('duplicate-route-registration', 'New route path collides with an existing registration', 'conflict', 'blocker'),
  R('duplicate-table-name', 'New CREATE TABLE matches an existing table name', 'conflict', 'blocker'),
  R('new-mutation-without-oasis-emit', 'New state-mutating route without an emitOasisEvent call', 'semantic', 'warning'),
  R('new-route-without-auth-middleware', 'New gateway route without auth middleware', 'semantic', 'warning'),
].map((r) => ({ ...r, auto_approved: ruleAllow.includes(r.rule), in_auto_approve_list: ruleAllow.includes(r.rule) }));
const recent = JSON.parse(fs.readFileSync(path.join(__dirname, 'recent-executions-live.json'), 'utf8'));

app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/dev-autopilot/supervisor', (_q, r) => r.json(SUP));
app.get('/api/v1/dev-autopilot/scanners', (_q, r) => r.json({ ok: true, scanners: scannerRows }));
app.get('/api/v1/dev-autopilot/impact-rules', (_q, r) => r.json({ ok: true, rules }));
app.get('/api/v1/dev-autopilot/auto-approve', (_q, r) => r.json({ ok: true,
  config: { kill_switch: false, daily_budget: 500, concurrency_cap: 4, baseline: { enabled: true, max_effort: 8, risk_classes: ['low','medium'], allowed_scanners: allow }, impact: { enabled: true, allowed_rules: ruleAllow } },
  budget: { approved_today: 10, daily_budget: 500, running_now: 0, concurrency_cap: 4 },
  progress: { auto_approved_surfaces: 16, total_surfaces: 23, autonomy_percent: 70 }, scanners: scannerRows, rules }));
app.get('/api/v1/dev-autopilot/runs', (_q, r) => r.json({ ok: true, runs: [] }));
app.get('/api/v1/dev-autopilot/executions', (q, r) => r.json({ ok: true, executions: q.query.status === 'all' ? recent : [] }));
app.get('/api/v1/automations/registry', (_q, r) => r.json({ ok: true, automations: [
  { id: 'AP-0101', name: 'Daily Match Delivery', domain: 'connect-people', triggerType: 'cron', triggerConfig: { cronExpression: '0 8 * * *' }, status: 'IMPLEMENTED', targetRoles: ['community'], handler: 'runDailyMatchDelivery', priority: 'P1' },
  { id: 'AP-0102', name: '"Someone Shares Your Interest" Nudge', domain: 'connect-people', triggerType: 'heartbeat', triggerConfig: { intervalMinutes: 360 }, status: 'IMPLEMENTED', targetRoles: ['community'], handler: 'runInterestNudge', priority: 'P2' },
] }));
app.get('/api/v1/automations/registry/summary', (_q, r) => r.json({ total: 147, executable: 141, planned: 5 }));
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [], findings: [], executions: [], runs: [], recommendations: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18482), () => console.log('harness up'));
