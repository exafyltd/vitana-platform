// VTID-04421 harness: Command Hub statics from the working tree + the new
// offer-outcomes endpoint served through the REAL row mapper over synthetic
// per-provider counts (no user data). Nothing here calls a live system.
require('/home/user/vitana-platform/services/gateway/node_modules/tsx/dist/cjs/api/index.cjs').register();
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const S = require('/home/user/vitana-platform/services/gateway/src/services/conversation/offer-outcome-stats.ts');
const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const RAW = [
  { provider: 'journey_guide', made: 42, accepted: 17, declined: 6, ignored: 15, open: 4 },
  { provider: 'wake_brief', made: 31, accepted: 9, declined: 3, ignored: 17, open: 2 },
  { provider: 'offer_action', made: 12, accepted: 8, declined: 1, ignored: 2, open: 1 },
  { provider: 'navigator_ambiguous', made: 5, accepted: 0, declined: 0, ignored: 0, open: 5 },
];
const app = express();
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/admin/conversation/offer-outcomes', (q, r) => {
  const days = Number(q.query.days) || 7;
  r.json({ ok: true, data: { days, user_id: null, providers: RAW.map(S.toOfferOutcomeStatRow) } });
});
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(18521, () => console.log('harness up'));
