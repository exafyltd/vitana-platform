// VTID-04399 harness: the VTID-04371 harness plus the context-setup rows (7-day
// live totals read 2026-09-23 after the rollup migration: 52 of 157 signed-in
// sessions set up with no context, all source:unknown = pre-WS-1.2 code).
// Pattern of VTID-04282:
// Command Hub statics from the working tree + the three new metrics endpoints
// served by the REAL summarizers (tsx) over rows read read-only from the live
// rollup on 2026-09-23. Nothing here calls a live system.
require('/home/user/vitana-platform/services/gateway/node_modules/tsx/dist/cjs/api/index.cjs').register();
const path = require('path');
const fs = require('fs');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const M = require('/home/user/vitana-platform/services/gateway/src/services/conversation/conversation-metrics.ts');
const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const ROLLUP = JSON.parse(fs.readFileSync(path.join(__dirname, '../../VTID-04371/outputs/rollup-168h-live.json'), 'utf8')).rows;
const EXTRA = JSON.parse(fs.readFileSync(path.join(__dirname, 'context-setup-7d-live.json'), 'utf8')).rows;
ROLLUP.push(...EXTRA);
const LEARN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../VTID-04371/outputs/learning-live.json'), 'utf8'));
const NOW = Date.parse('2026-09-23T14:20:00.000Z');
const app = express();
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/admin/conversation/metrics/summary', (q, r) => r.json({ ok: true, data: M.summarizeConversationMetrics(ROLLUP, Number(q.query.window_hours) || 24) }));
app.get('/api/v1/admin/conversation/metrics/learning', (q, r) => {
  const wh = Number(q.query.window_hours) || 168;
  const sum = M.summarizeConversationMetrics(ROLLUP, wh);
  r.json({ ok: true, data: { window_hours: wh, jobs: M.summarizeLearningJobs(LEARN.runs, NOW - wh * 3600000, NOW), profile_narrative: M.summarizeNarrativeFreshness(LEARN.stamps, NOW), coverage: sum.learning, errors: [] } });
});
app.get('/api/v1/admin/conversation/decisions', (_q, r) => r.json({ ok: true, data: { window_hours: 24, count: 2, decisions: [
  { created_at: '2026-09-23T13:41:02Z', wake_opener: 'conv_resume', register: 'resume', bucket: 'same_day', nba: null, nba_domain: null, current_route: '/home', lang: 'de' },
  { created_at: '2026-09-23T12:05:44Z', wake_opener: 'legacy_default', register: 'default', bucket: 'recent', nba: null, nba_domain: null, current_route: '/autopilot/my-journey', lang: 'en' },
] } }));
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18499), () => console.log('harness up'));
