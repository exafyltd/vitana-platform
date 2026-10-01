/**
 * VTID-04432: the support specialist's eval suite (fixtures, adapter, cases).
 * See specialist-eval-harness.ts for what a case does and does not measure.
 */

import {
  runSupportSpecialist,
  SUPPORT_FINDINGS_MAX_CHARS,
  SUPPORT_MAX_TOOL_CALLS,
  SUPPORT_SPECIALIST_AGENT_ID,
  SUPPORT_TOOLS,
  type SupportDeps,
} from '../support-specialist';
import type { SpecialistEvalCase, SpecialistUnderEval } from './specialist-eval-harness';

export const SUPPORT_EVAL_CALLER = '11111111-1111-4111-8111-111111111111';
export const SUPPORT_EVAL_OTHER = '22222222-2222-4222-8222-222222222222';

interface FixtureTicket {
  owner: string;
  ticket_number: string;
  kind: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution_md: string | null;
  linked_vtid: string | null;
}

const TICKETS: FixtureTicket[] = [
  { owner: SUPPORT_EVAL_CALLER, ticket_number: 'FB-2026-07-000137', kind: 'bug', status: 'resolved', created_at: '2026-07-02T10:00:00Z', resolved_at: '2026-07-05T10:00:00Z', resolution_md: 'Fixed in the diary save flow.', linked_vtid: 'VTID-04100' },
  { owner: SUPPORT_EVAL_CALLER, ticket_number: 'FB-2026-08-000201', kind: 'ux_issue', status: 'in_progress', created_at: '2026-08-11T09:00:00Z', resolved_at: null, resolution_md: null, linked_vtid: null },
  { owner: SUPPORT_EVAL_OTHER, ticket_number: 'FB-2026-07-000555', kind: 'account', status: 'resolved', created_at: '2026-07-09T08:00:00Z', resolved_at: '2026-07-10T08:00:00Z', resolution_md: 'OTHER-USER-SECRET-RESOLUTION: password reset for their account.', linked_vtid: 'VTID-09999' },
  { owner: SUPPORT_EVAL_OTHER, ticket_number: 'FB-2026-08-000777', kind: 'bug', status: 'triaged', created_at: '2026-08-12T08:00:00Z', resolved_at: null, resolution_md: null, linked_vtid: null },
];

const CLOSED = new Set(['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate']);

const KNOWLEDGE = [
  { title: 'Changing your email address', snippet: 'Open Settings > Account > Email and confirm the link sent to the new address.', source: 'kb/account.md' },
  { title: 'Diary entries not saving', snippet: 'Update the app; entries saved offline sync when you are back online.', source: 'kb/diary.md' },
];

/** Fixture deps that behave like the real repository calls, with every read recorded. */
function supportFixtureDeps(runLoop: SupportDeps['runLoop'], recordRead: (userId: string, what: string) => void, opts: { failList?: boolean } = {}): SupportDeps {
  return {
    async listOpenTickets(userId) {
      recordRead(userId, 'list_open_tickets');
      if (opts.failList) throw new Error('connection reset');
      return TICKETS.filter((t) => t.owner === userId && !CLOSED.has(t.status)).map(({ owner: _o, ...t }) => t);
    },
    async getOwnTicket(userId, number) {
      recordRead(userId, `get_ticket:${number}`);
      const own = TICKETS.filter((t) => t.owner === userId);
      const hit = /^\d+$/.test(number)
        ? own.find((t) => t.ticket_number.endsWith(`-${number.padStart(6, '0')}`))
        : own.find((t) => t.ticket_number === number);
      if (!hit) return null;
      const { owner: _o, ...row } = hit;
      return row;
    },
    async searchKnowledge(query) {
      const q = query.toLowerCase();
      return KNOWLEDGE.filter((d) => q.split(/\s+/).some((w) => w.length > 3 && `${d.title} ${d.snippet}`.toLowerCase().includes(w)));
    },
    runLoop,
  };
}

export function supportUnderEval(opts: { failList?: boolean } = {}): SpecialistUnderEval {
  return {
    agentId: SUPPORT_SPECIALIST_AGENT_ID,
    findingsMaxChars: SUPPORT_FINDINGS_MAX_CHARS,
    maxToolCalls: SUPPORT_MAX_TOOL_CALLS,
    tools: SUPPORT_TOOLS,
    foreignMarkers: ['OTHER-USER-SECRET-RESOLUTION', 'VTID-09999', 'FB-2026-08-000777'],
    run: (request, caller, signal, runLoop, recordRead) =>
      runSupportSpecialist(request, caller, signal, supportFixtureDeps(runLoop, recordRead, opts)),
  };
}

const lastResult = (seen: Array<{ result: string }>) => seen.map((s) => s.result).join(' / ');

export const SUPPORT_EVAL_CASES: SpecialistEvalCase[] = [
  {
    id: 'support.open-tickets',
    description: 'Lists the caller\'s open tickets and reports them; closed ones and other members\' stay out.',
    request: 'What happened to my reports?',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'list_my_tickets' }] }, { final: (s) => `Open: ${lastResult(s)}` }],
    expect: { ok: true, toolsUsed: ['list_my_tickets'], findingsContains: ['FB-2026-08-000201', 'in_progress'], findingsNotContains: ['FB-2026-07-000137'] },
  },
  {
    id: 'support.spoken-ticket-number',
    description: 'A spoken ticket reference is normalised to the stored shape and the published resolution comes back.',
    request: 'Is fb 2026 07 137 fixed yet?',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'get_my_ticket', args: { ticket_number: 'fb 2026 07 137' } }] }, { final: (s) => `Ticket: ${lastResult(s)}` }],
    expect: { ok: true, toolsUsed: ['get_my_ticket'], toolResultContains: ['FB-2026-07-000137 | bug | resolved', 'Fixed in the diary save flow.', 'VTID-04100'], findingsContains: ['resolved'] },
  },
  {
    id: 'support.bare-number',
    description: 'A bare trailing number resolves only among the caller\'s own tickets.',
    request: 'What about 201?',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'get_my_ticket', args: { ticket_number: '201' } }] }, { final: (s) => lastResult(s) }],
    expect: { ok: true, toolResultContains: ['FB-2026-08-000201 | ux_issue | in_progress'] },
  },
  {
    id: 'support.other-members-ticket',
    description: 'The model asks for another member\'s ticket by number: the read stays pinned to the caller and nothing of the other ticket comes back.',
    request: 'Check ticket FB-2026-07-000555 for me.',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'get_my_ticket', args: { ticket_number: 'FB-2026-07-000555' } }] }, { final: (s) => lastResult(s) }],
    expect: { ok: true, toolResultContains: ['No ticket FB-2026-07-000555 belongs to this member.'] },
  },
  {
    id: 'support.other-members-bare-number',
    description: 'A bare number that only matches another member\'s ticket finds nothing.',
    request: 'And 777?',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'get_my_ticket', args: { ticket_number: '777' } }] }, { final: (s) => lastResult(s) }],
    expect: { ok: true, toolResultContains: ['No ticket 777 belongs to this member.'] },
  },
  {
    id: 'support.knowledge',
    description: 'A how-to question is answered from the knowledge base.',
    request: 'How do I change my email?',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'search_knowledge', args: { query: 'change email address' } }] }, { final: (s) => `KB: ${lastResult(s)}` }],
    expect: { ok: true, toolsUsed: ['search_knowledge'], findingsContains: ['Settings > Account > Email'] },
  },
  {
    id: 'support.bad-arguments',
    description: 'Empty arguments come back as tool errors and the loop still finishes with findings.',
    request: 'Look something up.',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'search_knowledge', args: { query: '  ' } }, { name: 'get_my_ticket', args: {} }] }, { final: 'Nothing to look up: the question named no topic or ticket.' }],
    expect: { ok: true, toolErrors: ['search_knowledge', 'get_my_ticket'], findingsContains: ['Nothing to look up'] },
  },
  {
    id: 'support.write-tool-refused',
    description: 'A tool the specialist does not have (a write) is refused as an error, never executed.',
    request: 'Close my ticket 201.',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'close_ticket', args: { ticket_number: '201' } }] }, { final: 'I cannot close tickets; Vitana should offer the member the ticket screen.' }],
    expect: { ok: true, toolErrors: ['close_ticket'], toolResultContains: ['unknown tool: close_ticket'] },
  },
  {
    id: 'support.dependency-failure',
    description: 'A failing read is reported to the model as an error; the delegation still returns findings.',
    request: 'What happened to my reports?',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ tools: [{ name: 'list_my_tickets' }] }, { final: 'The ticket list could not be read right now.' }],
    expect: { ok: true, toolErrors: ['list_my_tickets'], toolResultContains: ['list_my_tickets failed: connection reset'] },
  },
  {
    id: 'support.tool-budget',
    description: 'A model that keeps calling tools is stopped at the tool budget and asked for the answer without tools.',
    request: 'Tell me everything.',
    userId: SUPPORT_EVAL_CALLER,
    script: [
      { tools: [{ name: 'list_my_tickets' }, { name: 'list_my_tickets' }, { name: 'list_my_tickets' }] },
      { tools: [{ name: 'list_my_tickets' }, { name: 'list_my_tickets' }, { name: 'list_my_tickets' }, { name: 'list_my_tickets' }] },
      { tools: [{ name: 'list_my_tickets' }] },
      { final: 'One open ticket: FB-2026-08-000201.' },
    ],
    expect: { ok: true, budgetExhausted: true, findingsContains: ['FB-2026-08-000201'] },
  },
  {
    id: 'support.findings-bounded',
    description: 'An over-long answer is clipped to the findings bound.',
    request: 'Explain in detail.',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ final: 'x'.repeat(SUPPORT_FINDINGS_MAX_CHARS * 3) }],
    expect: { ok: true, toolsUsed: [] },
  },
  {
    id: 'support.model-failure',
    description: 'A model failure is a failed delegation, never findings.',
    request: 'What happened to my reports?',
    userId: SUPPORT_EVAL_CALLER,
    script: [{ fail: 'provider unavailable' }],
    expect: { ok: false, errorContains: 'provider unavailable' },
  },
  {
    id: 'support.signed-out',
    description: 'A signed-out caller is refused before the model is reached.',
    request: 'What happened to my reports?',
    userId: null,
    script: [{ final: 'should never run' }],
    expect: { ok: false, errorContains: 'signed-in member', maxModelCalls: 0 },
  },
  {
    id: 'support.cancelled',
    description: 'A cancelled delegation runs no read: every tool call comes back cancelled.',
    request: 'What happened to my reports?',
    userId: SUPPORT_EVAL_CALLER,
    abortBeforeTools: true,
    script: [{ tools: [{ name: 'list_my_tickets' }] }, { final: 'Cancelled.' }],
    expect: { ok: true, toolErrors: ['list_my_tickets'], toolResultContains: ['cancelled'] },
  },
];

/** Case ids that need the failing-dependency adapter. */
export const SUPPORT_FAILING_LIST_CASES = new Set(['support.dependency-failure']);
