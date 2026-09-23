/**
 * VTID-04334: the supervisor sees the member ticket next to its VTID and fix
 * run (docs/CUSTOMER-SUPPORT-REBUILD-BRIEF.md §2.6 / §3.1).
 *
 * - Feedback ticket drawer: a "Pipeline" block with chips for ticket FB-…,
 *   linked VTID, finding, latest execution (+ stage/status), PR and
 *   deploy/verify state; every chip reads its field defensively ("—").
 * - The three supervisor actions whose routes already existed but had no
 *   button: mark-duplicate (feedback-actions.ts), reclassify and rollback
 *   (tenant-specialists.ts).
 * - Inbox: a VTID column next to the ticket number.
 * - Autopilot rows (Live recent executions, Live dev executions, supervisor
 *   findings, Dev Autopilot finding cards): a "Member report FB-…" badge that
 *   opens the ticket drawer.
 *
 * app.js is a plain browser script with no module system, so the pure
 * helpers are evaluated in isolation and the wiring is pinned by source text
 * (the established pattern for app.js in this directory).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const FE = join(__dirname, '../../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const STYLES = readFileSync(join(FE, 'styles.css'), 'utf8');
const INDEX_HTML = readFileSync(join(FE, 'index.html'), 'utf8');
const ROUTES = join(__dirname, '../../src/routes');

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start === -1) throw new Error(`function ${name}() not found in app.js`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf('\nfunction ');
  return next === -1 ? rest : rest.slice(0, next);
}

function constLine(name: string): string {
  const m = new RegExp(`\\nvar ${name} = [^\\n]+\\n`).exec(APP_JS);
  if (!m) throw new Error(`var ${name} not found`);
  return m[0];
}

// Evaluate the two pure helpers exactly as shipped.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const helpers = new Function(
  constLine('FEEDBACK_TICKET_SOURCE_PREFIX') +
    constLine('FEEDBACK_TICKET_TITLE_RE') +
    fnBody(APP_JS, 'feedbackTicketRefFrom') +
    fnBody(APP_JS, 'feedbackDeployVerifyState') +
    'return { feedbackTicketRefFrom: feedbackTicketRefFrom, feedbackDeployVerifyState: feedbackDeployVerifyState };',
)() as {
  feedbackTicketRefFrom: (row: unknown) => null | { ticket_id: string | null; ticket_number: string | null; linked_vtid: string | null };
  feedbackDeployVerifyState: (exec: unknown, ticket: unknown) => { text: string; tone: string | null };
};

describe('VTID-04334 feedbackTicketRefFrom: which autopilot rows came from a member report', () => {
  const { feedbackTicketRefFrom } = helpers;

  it('reads the API feedback_ticket object (VTID-04333 shape) first', () => {
    expect(feedbackTicketRefFrom({
      id: 'e1',
      feedback_ticket: { ticket_id: 'a1b2', ticket_number: 'FB-2026-09-000123', linked_vtid: 'VTID-04400' },
    })).toEqual({ ticket_id: 'a1b2', ticket_number: 'FB-2026-09-000123', linked_vtid: 'VTID-04400' });
  });

  it('falls back to source_ref "feedback_ticket:<id>" on an embedded recommendation', () => {
    expect(feedbackTicketRefFrom({ id: 'e1', recommendation: { source_ref: 'feedback_ticket:uuid-1', title: 'x' } }))
      .toEqual({ ticket_id: 'uuid-1', ticket_number: null, linked_vtid: null });
  });

  it('falls back to spec_snapshot.feedback', () => {
    expect(feedbackTicketRefFrom({ spec_snapshot: { feedback: { ticket_id: 't9', ticket_number: 'FB-2026-09-000009' } } }))
      .toEqual({ ticket_id: 't9', ticket_number: 'FB-2026-09-000009', linked_vtid: null });
  });

  it('falls back to the "[FB-…]" title prefix (finding title or execution task_title)', () => {
    expect(feedbackTicketRefFrom({ title: '[FB-2026-09-000042] Button does nothing' }))
      .toEqual({ ticket_id: null, ticket_number: 'FB-2026-09-000042', linked_vtid: null });
    expect(feedbackTicketRefFrom({ task_title: '[FB-2026-08-000001] x' })!.ticket_number).toBe('FB-2026-08-000001');
  });

  it('combines sources: id from source_ref, number from the title', () => {
    expect(feedbackTicketRefFrom({ source_ref: 'feedback_ticket:u1', title: '[FB-2026-09-000001] y' }))
      .toEqual({ ticket_id: 'u1', ticket_number: 'FB-2026-09-000001', linked_vtid: null });
  });

  it('returns null for rows that did not come from a member report', () => {
    expect(feedbackTicketRefFrom({ title: 'Fix TODO in foo.ts', source_ref: 'scanner:todo', recommendation: { title: 'x' } })).toBeNull();
    expect(feedbackTicketRefFrom({ title: 'See [FB-2026-09-000001] later' })).toBeNull();
    expect(feedbackTicketRefFrom(null)).toBeNull();
    expect(feedbackTicketRefFrom('x')).toBeNull();
  });
});

describe('VTID-04334 feedbackDeployVerifyState', () => {
  const { feedbackDeployVerifyState } = helpers;
  it('maps execution states to plain words, never inventing a deploy', () => {
    expect(feedbackDeployVerifyState(null, { status: 'triaged' }).text).toBe('—');
    expect(feedbackDeployVerifyState({ status: 'running' }, {}).text).toBe('not deployed yet');
    expect(feedbackDeployVerifyState({ status: 'deploying' }, {})).toEqual({ text: 'deploying', tone: 'live' });
    expect(feedbackDeployVerifyState({ status: 'verifying' }, {}).text).toBe('deployed · verifying');
    expect(feedbackDeployVerifyState({ status: 'completed' }, {})).toEqual({ text: 'deployed · verified', tone: 'ok' });
    expect(feedbackDeployVerifyState({ status: 'failed', failure_stage: 'verifying' }, {}).text).toBe('failed at verifying');
    expect(feedbackDeployVerifyState({ status: 'failed', failure_stage: 'ci' }, {}).text).toBe('not deployed (failed)');
    expect(feedbackDeployVerifyState({ status: 'completed' }, { rolled_back_at: '2026-09-23' }).text).toBe('rolled back');
  });
});

describe('VTID-04334 Feedback drawer: Pipeline block + supervisor actions', () => {
  const drawer = fnBody(APP_JS, 'openFeedbackTicketDrawer');
  const pipeline = fnBody(APP_JS, 'renderFeedbackPipelineBlock');

  it('renders the Pipeline block from the ticket detail response', () => {
    expect(drawer).toContain('panel.appendChild(renderFeedbackPipelineBlock(t, data));');
  });

  it('has a chip for ticket, VTID, finding, execution, PR and deploy/verify, each defensive', () => {
    for (const key of ["'Ticket'", "'VTID'", "'Finding'", "'Execution'", "'PR'", "'Deploy / verify'"]) {
      expect(pipeline).toContain(`feedbackPipelineChip(${key}`);
    }
    expect(pipeline).toContain('t.linked_vtid || null');
    expect(pipeline).toContain('t.linked_finding_id');
    expect(pipeline).toContain('t.linked_pr_url');
    // latest-execution object under either name the API may use
    expect(pipeline).toMatch(/data\.latest_execution \|\| data\.execution/);
    expect(pipeline).toContain("'/command-hub/autopilot/live/#autopilot-live-exec-' + exec.id");
    expect(fnBody(APP_JS, 'feedbackPipelineChip')).toContain("v.textContent = value || '—';");
  });

  it('wires Mark duplicate / Reclassify / Rollback to the routes that already exist', () => {
    expect(drawer).toContain("'/api/v1/admin/feedback/tickets/' + ticketId + '/mark-duplicate'");
    expect(drawer).toContain("{ payload: { duplicate_of: originalId } }");
    expect(drawer).toMatch(/'\/api\/v1\/admin\/tenants\/' \+ encodeURIComponent\(fbTenantId\) \+ '\/tickets\/' \+ ticketId \+ '\/reclassify', \{ method: 'PUT'/);
    expect(drawer).toContain("'/api/v1/admin/tenants/' + encodeURIComponent(fbTenantId) + '/tickets/' + ticketId + '/rollback'");
    expect(drawer).toContain("method: (body && body.method) || 'POST'");

    const actions = readFileSync(join(ROUTES, 'feedback-actions.ts'), 'utf8');
    const tenant = readFileSync(join(ROUTES, 'tenant-specialists.ts'), 'utf8');
    expect(actions).toContain("adminRouter.post('/tickets/:id/mark-duplicate'");
    expect(actions).toContain('duplicate_of: z.string().uuid()');
    expect(tenant).toContain("router.put('/:tenantId/tickets/:id/reclassify'");
    expect(tenant).toContain("router.post('/:tenantId/tickets/:id/rollback'");
  });

  it('only offers each action when its route would accept it', () => {
    expect(drawer).toContain("t.status === 'resolved' && t.auto_resolved && !t.rolled_back_at && t.linked_pr_url");
    expect(drawer).toContain('!t.linked_finding_id && FEEDBACK_TERMINAL_STATUSES.indexOf(t.status) === -1');
  });
});

describe('VTID-04334 Inbox VTID column', () => {
  const inbox = fnBody(APP_JS, 'renderFeedbackInboxView');
  it('adds a VTID header after the ticket column and a linked_vtid cell per row', () => {
    expect(inbox).toContain("vtidTh.textContent = 'VTID';");
    expect(inbox).toContain('thead.firstChild.insertBefore(vtidTh, thead.firstChild.children[1]);');
    expect(inbox).toContain("vtidCell.textContent = t.linked_vtid || '—';");
    expect(inbox.indexOf('tr.appendChild(num);')).toBeLessThan(inbox.indexOf('tr.appendChild(vtidCell);'));
  });
});

describe('VTID-04334 Autopilot rows carry the member-report badge', () => {
  it('on Autopilot Live recent executions and dev executions', () => {
    const live = fnBody(APP_JS, 'renderAutopilotLiveView');
    expect(live).toContain('var fbRef = feedbackTicketRefFrom(e);');
    expect(live).toContain("fbRef ? 'member report'");
    expect(live).toContain('var execFbRef = feedbackTicketRefFrom(exec);');
    expect(live).toContain('label.appendChild(renderFeedbackTicketBadge(execFbRef));');
  });

  it('on supervisor findings and Dev Autopilot finding cards', () => {
    expect(fnBody(APP_JS, 'renderAutopilotOpenFindingsPanel')).toContain('renderFeedbackTicketBadge(findingFbRef)');
    expect(fnBody(APP_JS, 'renderDevAutopilotFindingCard')).toContain('renderFeedbackTicketBadge(cardFbRef)');
  });

  it('the badge opens the ticket drawer, resolving a bare FB number first', () => {
    const badge = fnBody(APP_JS, 'renderFeedbackTicketBadge');
    expect(badge).toContain("'Member report ' + label");
    expect(badge).toContain('openFeedbackTicketFromRef(ref);');
    const open = fnBody(APP_JS, 'openFeedbackTicketFromRef');
    expect(open).toContain('openFeedbackTicketDrawer(ref.ticket_id);');
    expect(open).toContain('feedbackResolveTicketId(ref.ticket_number)');
  });
});

describe('VTID-04334 CSP + cache-bust', () => {
  const added = [
    'feedbackTicketRefFrom', 'openFeedbackTicketFromRef', 'feedbackResolveTicketId', 'renderFeedbackTicketBadge',
    'feedbackDeployVerifyState', 'feedbackPipelineChip', 'feedbackCopyToClipboard', 'renderFeedbackPipelineBlock',
    'feedbackActionButton', 'feedbackTicketTenantId',
  ];
  it('new helpers use classes only — no inline style, no innerHTML', () => {
    for (const name of added) {
      const body = fnBody(APP_JS, name);
      expect(body).not.toMatch(/\.style\b/);
      expect(body).not.toMatch(/style\s*=/);
      expect(body).not.toContain('innerHTML');
    }
  });
  it('ships the styles and bumps ?v= on app.js and styles.css', () => {
    for (const cls of ['.fb-pipeline', '.fb-chip', '.fb-chip--empty', '.fb-member-badge', '.fb-inbox-vtid', '.fb-action-btn']) {
      expect(STYLES).toContain(cls);
    }
    expect(INDEX_HTML).toContain('app.js?v=20261004-vtid-04334-feedback-pipeline');
    expect(INDEX_HTML).toContain('styles.css?v=20261004-vtid-04334-feedback-pipeline');
  });
});
