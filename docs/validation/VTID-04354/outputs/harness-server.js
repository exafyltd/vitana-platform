// VTID-04354 local visual-verification harness (pattern of VTID-04282):
// Command Hub statics from the working tree + stubbed /api/v1/orchestrator/*.
// Run rows and agent cards are LIVE rows read (read-only) from
// agent_runs_unified / agents_registry on 2026-09-23, trimmed. Nothing here
// calls a live system.
const path = require('path');
const fs = require('fs');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'orchestrator-fixture-live-rows.json'), 'utf8'));
const app = express();
const planes = FX.planes.map((p) => ({ ...p, total: Object.values(p.by_status).reduce((a, b) => a + b, 0) }));
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/orchestrator/runs/summary', (q, r) => r.json({ ok: true, data: { days: Number(q.query.days) || 7, truncated: false, planes } }));
app.get('/api/v1/orchestrator/runs', (q, r) => {
  let runs = FX.runs;
  if (q.query.plane) runs = runs.filter((x) => x.plane === q.query.plane);
  if (q.query.status) runs = runs.filter((x) => x.status === q.query.status);
  r.json({ ok: true, data: { runs } });
});
app.get('/api/v1/orchestrator/agents', (_q, r) => r.json({ ok: true, data: { agents: FX.agents } }));
app.get('/api/v1/orchestrator/policy', (_q, r) => {
  // The real policyDefaults() / ceilingsFor() output, transpiled from src at harness time.
  const pol = require('/tmp/claude-0/orchpol/policy.js');
  const ctx = { platform_role: 'developer', orgs: [], channel: 'web' };
  r.json({ ok: true, data: { defaults: pol.policyDefaults(), platform_role: 'developer', channel: 'web', ceilings: pol.ceilingsFor(ctx), evaluation: null } });
});
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [], findings: [], executions: [], runs: [], recommendations: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18483), () => console.log('harness up'));
