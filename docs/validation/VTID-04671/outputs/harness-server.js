// VTID-04671 local visual-verification harness (adapted from VTID-04033):
// Command Hub statics from THIS worktree + stubbed boot APIs, a stubbed
// GET /api/v1/dev-autopilot/pending-approvals with three realistic rows (an
// executable dev_autopilot finding with a full quality.review, an oasis
// finding awaiting review, a health finding without a P2 score), stubbed
// activate / reject, and a fake per-execution SSE tail. Nothing live.
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');

const STATIC = path.resolve(__dirname, '../../../../services/gateway/src/frontend/command-hub');
const EXEC = '7c1e9b42-1111-4222-8333-444455556666';
const STEP_MS = Number(process.env.HARNESS_STEP_MS || 700);
const app = express();
app.use(express.json());
const posted = [];

app.get('/api/v1/auth/me', (_req, res) => res.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_req, res) => res.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_req, res) => res.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': hb\n\n'); });

const NOW = new Date().toISOString();
const RECS = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    title: 'Unhandled rejection in orb-memory-bridge write path',
    summary: 'writeMemoryItemWithIdentity() awaits a PostgREST insert without a catch; 23 unhandled rejections in 7 days.',
    domain: 'memory', risk_class: 'medium', source_type: 'dev_autopilot', seen_count: 4, created_at: NOW,
    impact_score: 7, effort_score: 3, priority_score: 0.4231,
    spec_snapshot: { scanner: 'unhandled-rejection-scanner-v1', file_path: 'services/gateway/src/services/orb-memory-bridge.ts' },
    quality: {
      version: 1, value: 0.71, confidence: 0.85, success_odds: 0.62, expected_cost_usd: 0.84, expected_input_tokens: 1_450_000, executable: true,
      basis: { audience: 'members (signal missing_auth)', severity: 'risk_class medium', frequency: 'seen 4×, 23 events', trend: 'active (seen in the last 3 days)', confidence: ['names 1 file(s)', 'file exists in the code index', '23 events', 'reproduced across 4 runs', 'named scanner/rule'], success_odds: 'unhandled-rejection-scanner-v1: 4/6 recent executions landed (Laplace)', cost: 'median of 6 recorded agent run(s) for unhandled-rejection-scanner-v1' },
      scored_at: NOW,
      review: {
        verdict: 'keep',
        problem: 'A failed memory insert rejects without a handler, so the ORB turn loses the write silently and Node logs an unhandled rejection.',
        evidence: ['23 unhandledRejection log lines pointing at orb-memory-bridge.ts:212 in the last 7 days', 'writeMemoryItemWithIdentity() has no try/catch around the insert', 'dev_get_risk: 11 commits / 90 d, used by 6 modules'],
        files: [{ path: 'services/gateway/src/services/orb-memory-bridge.ts', risk: 'high churn; used by the live voice path' }, { path: 'services/gateway/test/orb-memory-bridge.test.ts', risk: 'low — test only' }],
        acceptance: ['The insert failure is caught and logged with the session id', 'A unit test forces the insert to fail and asserts no unhandled rejection'],
        why_now: 'Seen in every one of the last 4 scans and rising; each occurrence drops a member memory.',
        reviewed_at: NOW,
      },
    },
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    title: 'OASIS error spike: voice.healing.dispatch_failed',
    summary: '41 error events in 24 h from the voice healing dispatcher.',
    domain: 'voice', risk_class: 'high', source_type: 'oasis', seen_count: 2, created_at: NOW,
    impact_score: 6, effort_score: 4, priority_score: 0.1512,
    quality: { version: 1, value: 0.66, confidence: 0.63, success_odds: 0.3, expected_cost_usd: 1, expected_input_tokens: 1_000_000, executable: false, basis: { audience: 'members (source oasis)', severity: 'risk_class high', frequency: 'seen 2×, 41 events', trend: 'active (seen in the last 3 days)', confidence: ['41 events', 'reproduced across 2 runs'], success_odds: 'non-executable type: fixed prior 0.3', cost: 'prior $1 (non-executable)' }, scored_at: NOW },
  },
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000003',
    title: 'Health check: /api/v1/vtid/health slow (p95 4.1 s)',
    summary: 'The VTID health route exceeded the 3 s budget on 3 of the last 10 polls.',
    domain: 'health', risk_level: 'low', source_type: 'health', seen_count: 1, created_at: NOW,
    impact_score: 4, effort_score: 2, priority_score: null, quality: null,
  },
];

app.get('/api/v1/dev-autopilot/pending-approvals', (_req, res) => res.json({ ok: true, recommendations: RECS, count: RECS.length, below_floor_count: 7, awaiting_review_count: 3 }));
app.get('/api/v1/dev-autopilot/pending-approvals/count', (_req, res) => res.json({ ok: true, count: RECS.length, below_floor_count: 7, awaiting_review_count: 3 }));
app.post('/api/v1/autopilot/recommendations/:id/activate', (req, res) => {
  posted.push({ path: req.path, body: req.body });
  res.json({ ok: true, vtid: 'VTID-04699', recommendation_id: req.params.id, execution: { state: 'queued', execution_id: EXEC } });
});
app.post('/api/v1/autopilot/recommendations/:id/reject', (req, res) => {
  posted.push({ path: req.path, body: req.body });
  res.json({ ok: true, recommendation_id: req.params.id, status: 'rejected', reason_code: req.body.reason_code, dismiss_recorded: true });
});
app.get('/__posted', (_req, res) => res.json(posted));

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEPS = [
  { topic: 'dev_autopilot.execution.claimed', status: 'info', message: 'claimed by staging (agent executor)' },
  { topic: 'dev_autopilot.agent.tool', status: 'info', message: 'dev_index_query orb-memory-bridge write path', metadata: { turn: 1, tool: 'dev_index_query' } },
  { topic: 'dev_autopilot.agent.tool', status: 'info', message: 'read_file services/gateway/src/services/orb-memory-bridge.ts', metadata: { turn: 2, tool: 'read_file' } },
  { topic: 'dev_autopilot.agent.tool', status: 'info', message: 'edit_file services/gateway/src/services/orb-memory-bridge.ts', metadata: { turn: 4, tool: 'edit_file' } },
  { topic: 'dev_autopilot.agent.check', status: 'success', message: 'run_check jest test/orb-memory-bridge.test.ts → green', metadata: { turn: 6, tool: 'run_check' } },
];
app.get(`/api/v1/dev-autopilot/executions/${EXEC}/stream`, async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  sse(res, 'connected', { status: 'connected', execution_id: EXEC });
  for (const s of STEPS) {
    await sleep(STEP_MS);
    sse(res, 'step', Object.assign({ id: 'ev-' + Math.random().toString(16).slice(2), created_at: new Date().toISOString(), metadata: {} }, s));
  }
  // Stays open (running) — the screenshot shows the live state.
});
app.all('/api/*', (_req, res) => res.json({ ok: true, data: [], items: [], events: [], tasks: [], findings: [], executions: [], runs: [] }));

app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
app.get('/', (_req, res) => res.redirect('/command-hub/'));

const port = Number(process.env.PORT || 18471);
app.listen(port, () => console.log(`harness on http://127.0.0.1:${port}`));
