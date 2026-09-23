// VTID-04422 harness: Command Hub statics from the working tree + the new
// shadow-ranking endpoint served by the REAL summarizer over synthetic wake
// timelines whose shadow rankings were produced by the REAL scorer. No user
// data; nothing here calls a live system.
require('/home/user/vitana-platform/services/gateway/node_modules/tsx/dist/cjs/api/index.cjs').register();
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const SC = require('/home/user/vitana-platform/services/gateway/src/services/conversation/candidate-scoring.ts');
const CMP = require('/home/user/vitana-platform/services/gateway/src/services/conversation/shadow-comparison.ts');
const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const W = SC.DEFAULT_SCORING_WEIGHTS;
const c = (provider, priority, dedupeKey, ctaRoute = null, kind = 'wake_brief') => ({ provider, kind, dedupeKey, priority, ctaRoute });
const scenarios = [];
for (let i = 0; i < 40; i++) {
  const cands = [c('login_briefing', 85, 'lb:' + (i % 3)), c('unread_messages_announce', 80, 'um'), c('journey_guide', 70, 'jg', '/journey', 'next_step')];
  const stale = i % 4 === 0;
  const ranking = SC.rankInShadow(cands, 'login_briefing', {
    recentlyServed: stale ? ['lb:' + (i % 3)] : [], recentWindow: 5, currentRoute: '/home', partOfDay: 'morning',
    outcomes: i % 5 === 0 ? { login_briefing: { accepted: 0, settled: 8 }, journey_guide: { accepted: 6, settled: 8 } } : {},
  }, { ...W, version: 1 });
  scenarios.push({ session_id: 'live-harness-' + String(i).padStart(3, '0'), started_at: new Date(Date.UTC(2026, 8, 23, 8, i)).toISOString(),
    events: [{ name: 'continuation_shadow_ranked', metadata: ranking }] });
}
const app = express();
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/admin/conversation/shadow-ranking', (q, r) => r.json({ ok: true, data: CMP.summarizeShadowComparisons(scenarios, Number(q.query.days) || 7) }));
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(18522, () => console.log('harness up'));
