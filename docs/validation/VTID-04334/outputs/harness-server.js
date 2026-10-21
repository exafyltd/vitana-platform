// VTID-04334 local visual-verification harness (pattern of VTID-04033 /
// VTID-04282): Command Hub statics from THIS working tree + stubbed APIs with
// fake ticket / execution data. Nothing here calls a live system.
//
// The ticket-detail stub returns the VTID-04333 shape (linked_vtid,
// linked_finding_id, linked_pr_url on the ticket, plus a latest_execution
// object); a second ticket returns the OLD shape (no linked_* at all) so the
// "—" fallbacks are exercised too.
const path = require('path');
const fs = require('fs');
const express = require('/home/user/vitana-platform/services/gateway/node_modules/express');
const STATIC = path.resolve(__dirname, '../../../../services/gateway/src/frontend/command-hub');
const SUP = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../VTID-04282/outputs/supervisor-snapshot-from-live-rows.json'), 'utf8'));

const TICKET_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TICKET_OLD_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const FINDING_ID = 'b7e4c1a9-2f3d-4e5a-9b8c-7d6e5f4a3b2c';
const EXEC_ID = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f';

// One supervisor finding that came from a member report.
SUP.findings.items.unshift({
  id: FINDING_ID, title: '[FB-2026-09-000137] Diary save button does nothing on iPhone', status: 'new',
  source_type: 'dev_autopilot', source_ref: 'feedback_ticket:' + TICKET_ID, detector: 'feedback_pipeline',
  file_path: 'src/components/diary/DiaryEntryForm.tsx', risk_class: 'medium', effort_score: 5, impact_score: 7,
  has_plan: true, age_days: 0, attempts: 1,
  blocker: { code: 'awaiting_approval', actor: 'human', label: 'Waiting for you', detail: 'Branch pushed, PR held for approval.' },
});

const ticket = {
  id: TICKET_ID, ticket_number: 'FB-2026-09-000137', vitana_id: '@maria.k', kind: 'bug', status: 'in_progress',
  priority: 'p1', surface: 'community', resolver_agent: 'devon', created_at: '2026-09-23T08:12:00Z',
  raw_transcript: 'When I tap "Save" in my diary on the iPhone nothing happens. The entry is gone when I come back.',
  linked_vtid: 'VTID-04412', linked_finding_id: FINDING_ID, linked_pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3619',
  auto_resolved: false, rolled_back_at: null,
};
const ticketResolved = {
  ...ticket, id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b', ticket_number: 'FB-2026-09-000121', status: 'resolved',
  auto_resolved: true, resolved_at: '2026-09-22T18:00:00Z', linked_vtid: 'VTID-04398',
  raw_transcript: 'The calendar showed the wrong week after midnight.',
};
const ticketOld = {
  id: TICKET_OLD_ID, ticket_number: 'FB-2026-09-000140', vitana_id: '@jon', kind: 'support_question', status: 'triaged',
  priority: 'p2', surface: 'community', resolver_agent: null, created_at: '2026-09-23T09:40:00Z',
  raw_transcript: 'How do I change the language of the voice assistant?',
};
const exec = {
  id: EXEC_ID, finding_id: FINDING_ID, status: 'verifying', pr_url: ticket.linked_pr_url, pr_number: 3619,
  branch: 'dev-autopilot/c9d8e7f6', failure_stage: null, created_at: '2026-09-23T09:02:00Z', updated_at: '2026-09-23T09:31:00Z',
};

// Autopilot executions: one via the VTID-04333 feedback_ticket object, one via
// the source_ref fallback only, one via the title fallback only, one unrelated.
const execRows = [
  { ...exec, auto_fix_depth: 0, recommendation: { title: '[FB-2026-09-000137] Diary save button does nothing on iPhone', source_type: 'dev_autopilot', source_ref: 'feedback_ticket:' + TICKET_ID, spec_snapshot: { scanner: 'feedback_pipeline', file_path: 'src/components/diary/DiaryEntryForm.tsx' } },
    feedback_ticket: { ticket_id: TICKET_ID, ticket_number: 'FB-2026-09-000137', linked_vtid: 'VTID-04412' }, metadata: {} },
  { id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a', status: 'running', pr_url: null, auto_fix_depth: 0, created_at: '2026-09-23T09:20:00Z', updated_at: '2026-09-23T09:30:00Z',
    recommendation: { title: 'Calendar shows the wrong week after midnight', source_type: 'dev_autopilot', source_ref: 'feedback_ticket:' + ticketResolved.id, spec_snapshot: { scanner: 'feedback_pipeline', file_path: 'services/gateway/src/routes/calendar.ts' } }, metadata: {} },
  { id: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b', status: 'ci', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3620', pr_number: 3620, auto_fix_depth: 1, created_at: '2026-09-23T09:10:00Z', updated_at: '2026-09-23T09:29:00Z',
    recommendation: { title: '[FB-2026-09-000140] Voice language setting hard to find', source_type: 'dev_autopilot', spec_snapshot: { scanner: 'feedback_pipeline', file_path: 'src/pages/settings/Voice.tsx' } }, metadata: {} },
  { id: 'f0e1d2c3-b4a5-4968-8776-655443322110', status: 'completed', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3601', pr_number: 3601, auto_fix_depth: 0, created_at: '2026-09-23T07:00:00Z', updated_at: '2026-09-23T07:40:00Z',
    recommendation: { title: 'Stale feature flag — index.ts', source_type: 'dev_autopilot', source_ref: 'scanner:stale-feature-flag', spec_snapshot: { scanner: 'stale-feature-flag-scanner-v1', file_path: 'services/gateway/src/index.ts' } }, metadata: {} },
];

const app = express();
app.use(express.json());
const posted = [];
app.get('/api/v1/auth/me', (_q, r) => r.json({ ok: true, identity: { user_id: 'u-harness', email: 'harness@example.test', exafy_admin: true }, memberships: [{ role: 'developer', tenant_id: 't-harness' }] }));
app.get('/api/v1/me', (_q, r) => r.json({ ok: true, me: { user_id: 'u-harness', active_role: 'developer', tenant_id: 't-harness', display_name: 'Harness Dev', permitted_roles: ['developer', 'admin'] } }));
app.get('/api/v1/roles/my-roles', (_q, r) => r.json({ ok: true, roles: ['developer', 'admin'], is_super_admin: true }));
app.get('/api/v1/events/stream', (_q, r) => { r.setHeader('Content-Type', 'text/event-stream'); r.write(': hb\n\n'); });
app.get('/api/v1/dev-autopilot/supervisor', (_q, r) => r.json(SUP));
app.get('/api/v1/dev-autopilot/executions', (q, r) => r.json({ ok: true, executions: q.query.status === 'all' ? execRows : execRows.filter((e) => e.status !== 'completed') }));
app.get('/api/v1/admin/feedback/tickets', (_q, r) => r.json({ ok: true, tickets: [ticketOld, ticket, ticketResolved] }));
app.get('/api/v1/admin/feedback/tickets/:id', (q, r) => {
  if (q.params.id === TICKET_ID) return r.json({ ok: true, ticket, handoffs: [], similar: [], latest_execution: exec });
  if (q.params.id === ticketResolved.id) return r.json({ ok: true, ticket: ticketResolved, handoffs: [], similar: [], latest_execution: { ...exec, id: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d', status: 'completed', pr_number: 3598 } });
  if (q.params.id === TICKET_OLD_ID) return r.json({ ok: true, ticket: ticketOld, handoffs: [], similar: [] });
  return r.status(404).json({ ok: false, error: 'NOT_FOUND' });
});
// Record (never forward) the supervisor-action calls so the shoot script can assert them.
app.all(['/api/v1/admin/feedback/tickets/:id/:action', '/api/v1/admin/tenants/:tenant/tickets/:id/:action'], (q, r) => {
  posted.push({ method: q.method, path: q.path, body: q.body });
  r.json({ ok: true, ticket });
});
app.get('/__harness/posted', (_q, r) => r.json(posted));
app.all('/api/*', (_q, r) => r.json({ ok: true, data: [], items: [], events: [], tasks: [], findings: [], executions: [], runs: [], recommendations: [] }));
app.use('/command-hub', express.static(STATIC));
app.get('/command-hub/*', (_q, r) => r.sendFile(path.join(STATIC, 'index.html')));
app.listen(Number(process.env.PORT || 18534), () => console.log('harness up'));
