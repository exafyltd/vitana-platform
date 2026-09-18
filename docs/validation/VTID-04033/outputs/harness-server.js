// VTID-04033 local visual-verification harness (adapted from VTID-04031):
// Command Hub statics from the working tree + stubbed boot APIs, a scripted
// POST /api/v1/operator/chat/stream turn whose reply carries a successful
// autopilot_run_task result (execution_id), and the per-execution SSE tail
// GET /api/v1/dev-autopilot/executions/:id/stream emitting a few agent steps
// and then the awaiting_approval terminal frame. Nothing live.
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');

const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const EXEC = '9a4d2c7e-2222-4333-8444-555566667777';
const app = express();
app.use(express.json());

app.get('/api/v1/auth/me', (_req, res) => res.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_req, res) => res.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_req, res) => res.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': hb\n\n'); });

const STEP_MS = Number(process.env.HARNESS_STEP_MS || 900);
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/api/v1/operator/chat/stream', async (req, res) => {
  const threadId = req.body.threadId || '11111111-1111-4111-8111-111111111111';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  sse(res, 'turn.started', { threadId, started_at: new Date().toISOString() });
  await sleep(STEP_MS);
  sse(res, 'model.turn', { stage: 'plan', provider: 'deepseek', model: 'deepseek-flash', tool_calls: 1, duration_ms: 980, usage: { input_tokens: 3210, output_tokens: 180 }, cost_usd: 0.00061, cost_priced: true });
  sse(res, 'tool.call', { index: 0, name: 'autopilot_run_task', args: { request: 'renderCiEvidence() gains totalFailing; the watcher passes analysis.failedNames.length' } });
  await sleep(STEP_MS);
  sse(res, 'tool.result', { index: 0, name: 'autopilot_run_task', ok: true, duration_ms: 1320, excerpt: '{"ok":true,"execution_id":"' + EXEC + '"}' });
  sse(res, 'model.turn', { stage: 'final', provider: 'deepseek', model: 'deepseek-flash', tool_calls: 0, duration_ms: 1400, usage: { input_tokens: 3600, output_tokens: 96 }, cost_usd: 0.00058, cost_priced: true });
  sse(res, 'reply', {
    ok: true,
    reply: 'Allocated **VTID-04008** and queued an agent-mode execution (`' + EXEC.slice(0, 8) + '`). The agent will locate the code, make the change, run tsc + jest and open a pull request on the next executor tick.',
    attachments: [], oasis_ref: 'OASIS-CHAT-HARNESS',
    meta: { provider: 'deepseek', model: 'deepseek-flash', tool_calls: 1, duration_ms: 3700, usage: { input_tokens: 6810, output_tokens: 276 }, cost_usd: 0.00119, cost_priced: true, model_calls: 2 },
    threadId, messageId: 'm-harness', createdAt: new Date().toISOString(),
    toolResults: [
      { name: 'autopilot_run_task', response: { ok: true, execution_id: EXEC, finding_id: 'f-1', vtid: 'VTID-04008', message: 'queued' } },
    ],
  });
  sse(res, 'done', { ok: true });
  res.end();
});
app.post('/api/v1/operator/chat', (_req, res) => res.status(404).json({ ok: false, error: 'harness: use /chat/stream' }));

const STEPS = [
  { topic: 'dev_autopilot.execution.claimed', status: 'info', message: 'claimed by staging (agent executor)', metadata: { execution_id: EXEC } },
  { topic: 'dev_autopilot.agent.tool', status: 'info', message: 'search_text renderCiEvidence\\(', metadata: { execution_id: EXEC, turn: 2, kind: 'tool', tool: 'search_text', ms: 412 } },
  { topic: 'dev_autopilot.agent.tool', status: 'info', message: 'read_file services/gateway/src/services/dev-autopilot-watcher.ts', metadata: { execution_id: EXEC, turn: 3, kind: 'tool', tool: 'read_file', ms: 88 } },
  { topic: 'dev_autopilot.agent.tool', status: 'info', message: 'edit_file services/gateway/src/services/dev-autopilot-ci-logs.ts', metadata: { execution_id: EXEC, turn: 5, kind: 'tool', tool: 'edit_file', ms: 41 } },
  { topic: 'dev_autopilot.agent.check', status: 'error', message: 'run_check jest test/vtid-04005-ci-log-excerpts.test.ts → 1 failing', metadata: { execution_id: EXEC, turn: 6, kind: 'check', tool: 'run_check', ms: 9120, is_error: true } },
  { topic: 'dev_autopilot.agent.check', status: 'success', message: 'run_check jest test/vtid-04005-ci-log-excerpts.test.ts → green', metadata: { execution_id: EXEC, turn: 8, kind: 'check', tool: 'run_check', ms: 8710 } },
  { topic: 'dev_autopilot.execution.awaiting_approval', status: 'info', message: 'branch dev-autopilot/9a4d2c7e pushed — held for approval (3 files, +41 −6)', metadata: { execution_id: EXEC } },
];

app.get(`/api/v1/dev-autopilot/executions/${EXEC}/stream`, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  sse(res, 'connected', { status: 'connected', execution_id: EXEC, access_token_seen: typeof req.query.access_token === 'string' });
  for (const s of STEPS) {
    await sleep(STEP_MS);
    sse(res, 'step', Object.assign({ id: 'ev-' + Math.random().toString(16).slice(2), created_at: new Date().toISOString() }, s));
    if (s.topic === 'dev_autopilot.execution.awaiting_approval') sse(res, 'terminal', { topic: s.topic });
  }
  res.end();
});
app.all('/api/*', (_req, res) => res.json({ ok: true, data: [], items: [], events: [], tasks: [], findings: [], executions: [], runs: [] }));

app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
app.get('/', (_req, res) => res.redirect('/command-hub/'));

const port = Number(process.env.PORT || 18435);
app.listen(port, () => console.log(`harness on http://127.0.0.1:${port}`));
