// VTID-04419 harness: Command Hub statics from the working tree + the two new
// inspector endpoints served by the REAL summarizer (tsx) over one real,
// sanitized staging session (session-events-sanitized.json). Nothing here
// calls a live system.
require('/home/user/vitana-platform/services/gateway/node_modules/tsx/dist/cjs/api/index.cjs').register();
const path = require('path');
const fs = require('fs');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const I = require('/home/user/vitana-platform/services/gateway/src/services/conversation/session-brain-inspector.ts');
const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const ROWS = JSON.parse(fs.readFileSync(path.join(__dirname, 'session-events-sanitized.json'), 'utf8')).rows;
const app = express();
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/admin/conversation/sessions', (_q, r) => {
  const sessions = ROWS.filter((x) => x.topic === 'vtid.live.session.start').slice(0, 1).map(I.toSessionListItem);
  r.json({ ok: true, data: { hours: 72, count: sessions.length, sessions } });
});
app.get('/api/v1/admin/conversation/sessions/:id/brain', (q, r) => {
  if (!I.isValidSessionId(q.params.id)) return r.status(400).json({ ok: false, error: 'invalid session id' });
  const s = I.summarizeSessionEvents(q.params.id, ROWS.filter((x) => x.metadata.session_id === q.params.id));
  if (!s.found) return r.status(404).json({ ok: false, error: 'session not found in the last 14 days' });
  r.json({ ok: true, data: s });
});
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18519), () => console.log('harness up'));
