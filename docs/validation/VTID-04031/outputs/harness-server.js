// VTID-04031 local visual-verification harness (adapted from VTID-04028): serves the Command Hub
// statics from the working tree and stubs the few APIs the boot needs plus
// POST /api/v1/operator/chat/stream (a scripted SSE turn) and /chat.
// Nothing here talks to any live system.
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');

const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const app = express();
app.use(express.json());

app.get('/api/v1/auth/me', (_req, res) => res.json({
  ok: true,
  identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true },
  memberships: [{ role: 'developer', tenant_id: 't-harness' }],
}));
app.get('/api/v1/me', (_req, res) => res.json({
  ok: true,
  me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't-harness', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] },
}));
app.get('/api/v1/roles/my-roles', (_req, res) => res.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': hb\n\n'); });

const SLOW = Number(process.env.HARNESS_STEP_MS || 1200);
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/api/v1/operator/chat/stream', async (req, res) => {
  const threadId = req.body.threadId || '11111111-1111-4111-8111-111111111111';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  sse(res, 'turn.started', { threadId, started_at: new Date().toISOString() });
  await sleep(SLOW);
  sse(res, 'model.turn', { stage: 'plan', provider: 'deepseek', model: 'deepseek-flash', tool_calls: 3, duration_ms: 1180, usage: { input_tokens: 3517, output_tokens: 412 }, cost_usd: 0.000775, cost_priced: true });
  sse(res, 'tool.call', { index: 0, name: 'dev_search_codebase', args: { query: 'renderCiEvidence(', repo: 'exafyltd/vitana-platform' } });
  await sleep(SLOW);
  sse(res, 'tool.result', { index: 0, name: 'dev_search_codebase', ok: true, duration_ms: 1210, excerpt: '{"matches":3}' });
  sse(res, 'tool.call', { index: 1, name: 'dev_read_file', args: { path: 'services/gateway/src/services/dev-autopilot-watcher.ts' } });
  await sleep(SLOW);
  sse(res, 'tool.result', { index: 1, name: 'dev_read_file', ok: true, duration_ms: 640, excerpt: '{"content":"…"}' });
  sse(res, 'tool.call', { index: 2, name: 'dev_cloudwatch_logs', args: { log_group: '/ecs/vitana-gateway', minutes: 30 } });
  await sleep(SLOW);
  sse(res, 'tool.result', { index: 2, name: 'dev_cloudwatch_logs', ok: false, duration_ms: 388, error: 'AccessDeniedException: not authorized to perform: logs:FilterLogEvents', excerpt: '{}' });
  await sleep(SLOW);
  sse(res, 'model.turn', { stage: 'final', provider: 'deepseek', model: 'deepseek-flash', tool_calls: 0, duration_ms: 2100, usage: { input_tokens: 4102, output_tokens: 288 }, cost_usd: 0.000788, cost_priced: true });
  sse(res, 'reply', {
    ok: true,
    reply: 'Found **3** call sites of `renderCiEvidence(`; the watcher passes `analysis.failedNames.length`. CloudWatch logs are still denied for the task role (`logs:FilterLogEvents`) — the owner grant is pending.',
    attachments: [],
    oasis_ref: 'OASIS-CHAT-HARNESS',
    meta: { provider: 'deepseek', model: 'deepseek-flash', tool_calls: 3, duration_ms: 5960, usage: { input_tokens: 7619, output_tokens: 700 }, cost_usd: 0.001563, cost_priced: true, model_calls: 2 },
    threadId,
    messageId: 'm-harness',
    createdAt: new Date().toISOString(),
    toolResults: [
      { name: 'dev_search_codebase', response: { ok: true } },
      { name: 'dev_read_file', response: { ok: true } },
      { name: 'dev_cloudwatch_logs', response: { ok: false, error: 'AccessDeniedException' } },
    ],
  });
  sse(res, 'done', { threadId });
  res.end();
});

app.post('/api/v1/operator/chat', (req, res) => res.json({ ok: true, reply: 'one-shot fallback reply', threadId: 'fallback', meta: {}, attachments: [] }));

// Everything else under /api: empty ok so the dashboard boots quietly.
app.all('/api/*', (_req, res) => res.json({ ok: true, data: [], items: [], events: [], tasks: [] }));

app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
app.get('/', (_req, res) => res.redirect('/command-hub/'));

const port = Number(process.env.PORT || 18431);
app.listen(port, () => console.log(`harness on http://127.0.0.1:${port}`));
