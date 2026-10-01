// VTID-04438 harness: Command Hub statics from the working tree + the learning-health
// endpoint, whose profile block comes from the REAL summarizeNarrativeFreshness over
// synthetic stamps/counts (no narrative text, no user data). Nothing calls a live system.
require('/home/user/vitana-platform/services/gateway/node_modules/tsx/dist/cjs/api/index.cjs').register();
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const M = require('/home/user/vitana-platform/services/gateway/src/services/conversation/conversation-metrics.ts');
const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const NOW = Date.now();
const at = (h) => new Date(NOW - h * 3600_000).toISOString();
const stamps = [];
for (let i = 0; i < 26; i++) {
  const v2 = i < 18;
  stamps.push(v2
    ? { generated_at: at(2 + i), schema_version: '2', sections_filled: String(2 + (i % 5)), summaries: String(i % 3), diary: String(i % 4 === 0 ? 2 : 0), outcome_providers: String(i % 2) }
    : { generated_at: at(24 * (10 + i)) });
}
const app = express();
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/admin/conversation/metrics/learning', (_q, r) => r.json({ ok: true, data: {
  window_hours: 168, jobs: [], coverage: null, errors: [],
  profile_narrative: M.summarizeNarrativeFreshness(stamps, NOW),
} }));
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18529), () => console.log('harness up'));
