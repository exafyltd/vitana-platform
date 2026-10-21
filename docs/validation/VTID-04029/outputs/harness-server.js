// VTID-04029 local visual-verification harness: Command Hub statics from the
// working tree + stubbed boot APIs + a Dev Autopilot panel with one execution
// in 'awaiting_approval' carrying a pending diff preview. Nothing live.
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');

const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const EXEC = '4f7d5ea4-1111-4222-8333-444455556666';
const app = express();
app.use(express.json());

app.get('/api/v1/auth/me', (_req, res) => res.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_req, res) => res.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_req, res) => res.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': hb\n\n'); });

const PATCH = [
  'diff --git a/services/gateway/src/services/dev-autopilot-watcher.ts b/services/gateway/src/services/dev-autopilot-watcher.ts',
  'index 3f1c2d0..9a8b7c6 100644',
  '--- a/services/gateway/src/services/dev-autopilot-watcher.ts',
  '+++ b/services/gateway/src/services/dev-autopilot-watcher.ts',
  '@@ -412,7 +412,7 @@ export function buildCiFailureReason(analysis: CiAnalysis): string {',
  '   if (analysis.failedNames.length === 0) return \'CI failed (no named checks)\';',
  '-  return renderCiEvidence(analysis.failedNames.slice(0, 3));',
  '+  return renderCiEvidence(analysis.failedNames.slice(0, 3), analysis.failedNames.length);',
  ' }',
  ' ',
  'diff --git a/services/gateway/test/vtid-04008-ci-evidence.test.ts b/services/gateway/test/vtid-04008-ci-evidence.test.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/services/gateway/test/vtid-04008-ci-evidence.test.ts',
  '@@ -0,0 +1,9 @@',
  "+import { renderCiEvidence } from '../src/services/dev-autopilot-ci-logs';",
  '+',
  "+describe('renderCiEvidence totalFailing', () => {",
  "+  it('reserves budget for the not-fetched line', () => {",
  "+    expect(renderCiEvidence(['a', 'b', 'c'], 5)).toContain('and 2 more failing check(s) not fetched');",
  '+  });',
  '+});',
].join('\n');

const pending = {
  branch: 'dev-autopilot/4f7d5ea4',
  base_sha: 'e104099b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f',
  head_sha: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
  pr_title: 'fix(autopilot): renderCiEvidence reports the total failing count (VTID-04008)',
  pr_body: 'VTID: VTID-04008 …',
  session_id: 'agent_9f2c1a7e3b4d',
  staged_at: new Date().toISOString(),
  diff: {
    base_sha: 'e104099b', head_sha: '9a8b7c6d',
    files: ['services/gateway/src/services/dev-autopilot-watcher.ts', 'services/gateway/test/vtid-04008-ci-evidence.test.ts'],
    files_total: 2,
    stat: ' services/gateway/src/services/dev-autopilot-watcher.ts   | 2 +-\n services/gateway/test/vtid-04008-ci-evidence.test.ts     | 9 ++++++\n 2 files changed, 10 insertions(+), 1 deletion(-)',
    patch: PATCH, patch_chars_total: PATCH.length, truncated: false,
  },
};

let status = 'awaiting_approval';
function execRow() {
  return {
    id: EXEC, finding_id: 'f-1', plan_version: 1, status, branch: pending.branch, pr_url: status === 'ci' ? 'https://github.com/exafyltd/vitana-platform/pull/3382' : null,
    pr_number: status === 'ci' ? 3382 : null, auto_fix_depth: 0, created_at: new Date(Date.now() - 12 * 60000).toISOString(), updated_at: new Date().toISOString(),
    last_event_at: new Date(Date.now() - 3 * 60000).toISOString(), self_healing_vtid: 'VTID-04008',
    metadata: { executor: 'agent', claimed_env: 'staging', llm_on_ramp_override: { provider: 'deepseek', model: 'deepseek-flash' }, require_approval: true, pending_approval: pending },
  };
}

app.get('/__reset', (_req, res) => { status = 'awaiting_approval'; res.json({ ok: true }); });
app.get('/api/v1/dev-autopilot/runs', (_req, res) => res.json({ ok: true, runs: [] }));
app.get('/api/v1/dev-autopilot/queue', (_req, res) => res.json({ ok: true, findings: [] }));
app.get('/api/v1/dev-autopilot/config', (_req, res) => res.json({ ok: true, config: { kill_switch: false, daily_budget: 10, concurrency_cap: 2, auto_approve_enabled: false, allow_scope: [], deny_scope: [] } }));
app.get('/api/v1/dev-autopilot/executions', (_req, res) => res.json({ ok: true, executions: [execRow()] }));
app.get(`/api/v1/dev-autopilot/executions/${EXEC}/diff`, (_req, res) => res.json({ ok: true, status, pending }));
app.post(`/api/v1/dev-autopilot/executions/${EXEC}/approve`, (_req, res) => { status = 'ci'; res.json({ ok: true, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3382', pr_number: 3382 }); });
app.post(`/api/v1/dev-autopilot/executions/${EXEC}/reject`, (_req, res) => { status = 'cancelled'; res.json({ ok: true, branch_deleted: true }); });
app.all('/api/*', (_req, res) => res.json({ ok: true, data: [], items: [], events: [], tasks: [], findings: [], executions: [], runs: [] }));

app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
app.get('/', (_req, res) => res.redirect('/command-hub/'));

const port = Number(process.env.PORT || 18429);
app.listen(port, () => console.log(`harness on http://127.0.0.1:${port}`));
