// VTID-04420 harness (copied from VTID-04419's): Command Hub statics from the working tree + the two new
// inspector endpoints served by the REAL summarizer (tsx) over one real,
// sanitized staging session (session-events-sanitized.json). Nothing here
// calls a live system.
require('/home/user/vitana-platform/services/gateway/node_modules/tsx/dist/cjs/api/index.cjs').register();
const path = require('path');
const fs = require('fs');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const I = require('/home/user/vitana-platform/services/gateway/src/services/conversation/session-brain-inspector.ts');
const D = require('/home/user/vitana-platform/services/gateway/src/services/conversation/decide-conversation-flow.ts');
// Synthetic provider results with the shape and statuses measured over 30 days (no user data).
const TIMELINE = [
  { name: 'wake_brief_selected', metadata: { decisionId: 'd-harness', selected_continuation_kind: 'wake_brief' } },
  { name: 'continuation_decision_finished', metadata: { decisionId: 'd-harness', durationMs: 806, providerResults: [
    { key: 'voice_wake_brief', status: 'suppressed', latencyMs: 4, reason: 'superseded' },
    { key: 'contextual_next_action', status: 'suppressed', latencyMs: 210, reason: 'no_source_candidate' },
    { key: 'feature_discovery_teacher', status: 'errored', latencyMs: 800, reason: 'provider_timeout' },
    { key: 'new_day_return', status: 'suppressed', latencyMs: 95, reason: 'same_day' },
    { key: 'first_time_welcome', status: 'suppressed', latencyMs: 2, reason: 'not_first_time' },
    { key: 'goal_completion_inquiry', status: 'suppressed', latencyMs: 120, reason: 'no_goal_due' },
    { key: 'journey_guide', status: 'returned', latencyMs: 180 },
    { key: 'guided_topic_narration', status: 'skipped', latencyMs: 0, reason: 'no_topic_selected' },
    { key: 'login_briefing', status: 'returned', latencyMs: 340 },
    { key: 'unread_messages_announce', status: 'returned', latencyMs: 150 },
    { key: 'partner_health_result_ready', status: 'suppressed', latencyMs: 60, reason: 'no_unsurfaced_result' },
    { key: 'conversation_flow_v3', status: 'skipped', latencyMs: 1, reason: 'flag_off' },
    { key: 'real_life_invite', status: 'suppressed', latencyMs: 2, reason: 'flag_off' },
  ] } },
];
const WINNER = { id: 'c-harness', kind: 'wake_brief', dedupeKey: 'login_briefing:harness' };
const WB = { selectedContinuation: WINNER, sourceProviderResults: [
  { providerKey: 'journey_guide', status: 'returned', candidate: { id: 'c-jg' } },
  { providerKey: 'login_briefing', status: 'returned', candidate: WINNER },
  { providerKey: 'unread_messages_announce', status: 'returned', candidate: { id: 'c-um' } },
] };
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
  const rows = ROWS.filter((x) => x.metadata.session_id === q.params.id).map((x) =>
    x.metadata.stage === 'greeting_sent'
      // Synthetic candidate columns (the fixture predates VTID-04420): built by the REAL resolver.
      ? { ...x, metadata: { ...x.metadata, ...D.resolveCandidateOutcome(x.metadata.wake_opener, WB) } }
      : x);
  const s = I.summarizeSessionEvents(q.params.id, rows);
  s.candidates = I.summarizeWakeTimeline(TIMELINE);
  if (!s.found) return r.status(404).json({ ok: false, error: 'session not found in the last 14 days' });
  r.json({ ok: true, data: s });
});
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18520), () => console.log('harness up'));
