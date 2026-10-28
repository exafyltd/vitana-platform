// VTID-04032 local visual-verification harness (adapted from VTID-04029):
// Command Hub statics from the working tree + stubbed boot APIs + one Dev
// Autopilot execution in 'running' (an agent run on the ECS executor) whose
// POST /cancel flips it to 'cancelled'. Nothing live.
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');

const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const EXEC = '7c2e9b1d-1111-4222-8333-444455556666';
const ARN = 'arn:aws:ecs:eu-central-1:472838866351:task/Vitana-ECS-Cluster/0f3a9c1e2b4d';
const app = express();
app.use(express.json());

app.get('/api/v1/auth/me', (_req, res) => res.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_req, res) => res.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_req, res) => res.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': hb\n\n'); });

let status = 'running';
let cancelled = null;
function execRow() {
  return {
    id: EXEC, finding_id: 'f-1', plan_version: 1, status, branch: null, pr_url: null, pr_number: null, auto_fix_depth: 0,
    created_at: new Date(Date.now() - 6 * 60000).toISOString(), updated_at: new Date().toISOString(),
    last_event_at: new Date(Date.now() - 40000).toISOString(), self_healing_vtid: 'VTID-04008',
    cancelled_at: cancelled ? cancelled.at : null,
    metadata: { executor: 'agent', claimed_env: 'staging', llm_on_ramp_override: { provider: 'deepseek', model: 'deepseek-flash' }, ecs_task_arn: ARN, dispatched_at: new Date(Date.now() - 5 * 60000).toISOString(), ...(cancelled ? { cancelled } : {}) },
  };
}

app.get('/__reset', (_req, res) => { status = 'running'; cancelled = null; res.json({ ok: true }); });
app.get('/api/v1/dev-autopilot/runs', (_req, res) => res.json({ ok: true, runs: [] }));
app.get('/api/v1/dev-autopilot/queue', (_req, res) => res.json({ ok: true, findings: [] }));
app.get('/api/v1/dev-autopilot/config', (_req, res) => res.json({ ok: true, config: { kill_switch: false, daily_budget: 10, concurrency_cap: 2, auto_approve_enabled: false, allow_scope: [], deny_scope: [] } }));
app.get('/api/v1/dev-autopilot/executions', (_req, res) => res.json({ ok: true, executions: [execRow()] }));
app.post(`/api/v1/dev-autopilot/executions/${EXEC}/cancel`, (req, res) => {
  if (status !== 'running' && status !== 'cooling') return res.status(400).json({ ok: false, error: `execution is ${status}, only cooling/running can be cancelled` });
  const was = status;
  cancelled = { by: 'harness@example.test', at: new Date().toISOString(), reason: (req.body && req.body.reason) || null, was, ecs_task_arn: ARN, ecs_task_stopped: true };
  status = 'cancelled';
  res.json({ ok: true, was, ecs_task_stopped: true });
});
app.all('/api/*', (_req, res) => res.json({ ok: true, data: [], items: [], events: [], tasks: [], findings: [], executions: [], runs: [] }));

app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
app.get('/', (_req, res) => res.redirect('/command-hub/'));

const port = Number(process.env.PORT || 18434);
app.listen(port, () => console.log(`harness on http://127.0.0.1:${port}`));
