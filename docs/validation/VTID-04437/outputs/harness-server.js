// VTID-04437 local visual-verification harness (adapted from VTID-04031):
// serves the Command Hub statics from the working tree and stubs the boot
// APIs plus GET /api/v1/operator/threads and /threads/:id/messages.
// Nothing here talks to any live system.
const path = require('path');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');

const STATIC = '/home/user/vitana-platform/services/gateway/src/frontend/command-hub';
const app = express();
app.use(express.json());

app.get('/api/v1/auth/me', (_req, res) => res.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't-harness' }] }));
app.get('/api/v1/me', (_req, res) => res.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't-harness', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_req, res) => res.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': hb\n\n'); });

const PHONE = '22222222-2222-4222-8222-222222222222';
const VOICE = '33333333-3333-4333-8333-333333333333';
app.get('/api/v1/operator/threads', (_req, res) => res.json({ ok: true, threads: [
  { id: PHONE, title: 'Staging deploy check (from phone)', summary: null, turns: 2, last_message_at: new Date(Date.now() - 20 * 60e3).toISOString(), created_at: new Date(Date.now() - 60 * 60e3).toISOString() },
  { id: VOICE, title: null, summary: null, turns: 1, last_message_at: new Date(Date.now() - 3 * 3600e3).toISOString(), created_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
] }));
app.get('/api/v1/operator/threads/:id/messages', (req, res) => {
  if (req.params.id !== PHONE) return res.json({ ok: true, messages: [] });
  const t0 = Date.now() - 25 * 60e3;
  res.json({ ok: true, messages: [
    { id: 'm1', role: 'user', content: 'Is the staging gateway on the memory merge yet?', created_at: new Date(t0).toISOString(), meta: {} },
    { id: 'm2', role: 'tool', content: '{"git_commit":"72b5a38"}', tool_name: 'dev_build_info', created_at: new Date(t0 + 2000).toISOString(), meta: {} },
    { id: 'm3', role: 'assistant', content: 'Yes — staging reports commit `72b5a38` (the memory system merge).', created_at: new Date(t0 + 4000).toISOString(), meta: {} },
    { id: 'm4', role: 'user', content: 'Thanks, and the handoff sweep?', created_at: new Date(t0 + 60000).toISOString(), meta: { channel: 'voice' } },
    { id: 'm5', role: 'assistant', content: 'Not scheduled yet: the EventBridge job needs the owner-run --apply.', created_at: new Date(t0 + 64000).toISOString(), meta: { channel: 'voice' } },
  ] });
});

app.all('/api/*', (_req, res) => res.json({ ok: true, data: [], items: [], events: [], tasks: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_req, res) => res.sendFile(path.join(STATIC, 'index.html')));
app.get('/', (_req, res) => res.redirect('/command-hub/'));
const port = Number(process.env.PORT || 18437);
app.listen(port, () => console.log(`harness on http://127.0.0.1:${port}`));
