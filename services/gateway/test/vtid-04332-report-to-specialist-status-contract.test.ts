/**
 * VTID-04332 — the report_to_specialist STATUS contract, pinned end to end.
 *
 * live-system-instruction.ts's VTID-03033 HARD RULE lets the model announce a
 * hand-off only when the tool reply begins with "STATUS: handoff_created." and
 * treats every other STATUS as "no hand-off". For months no handler returned
 * any STATUS text, so after a successful call the model was told the hand-off
 * did not happen. This suite parses the rule's own STATUS list and checks
 * every handler outcome against it, so the two cannot drift apart again.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../src/services/report-to-specialist-core-repository', () => ({
  pickSpecialistForText: jest.fn(),
  insertFeedbackTicket: jest.fn(),
  insertFeedbackHandoffEvent: jest.fn().mockResolvedValue({ error: null }),
  fetchTicketForAppend: jest.fn(),
  updateTicketIntakeMessages: jest.fn(),
}));
jest.mock('../src/services/persona-registry', () => ({
  pickPersonaForKind: jest.fn().mockResolvedValue('devon'),
  pickPersonaForKindForTenant: jest.fn().mockResolvedValue('devon'),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));

import * as repo from '../src/services/report-to-specialist-core-repository';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import {
  REPORT_TO_SPECIALIST_STATUSES,
  REPORT_TO_SPECIALIST_MIN_SUMMARY_WORDS,
  executeReportToSpecialist,
  reportToSpecialistToolMessage,
  feedbackSurfaceForOrb,
  executeAppendToTicket,
  appendToTicketToolMessage,
  type ReportToSpecialistResult,
} from '../src/services/report-to-specialist-core';
import { tool_report_to_specialist } from '../src/services/orb-tools-shared';

const SRC = join(__dirname, '../src');
const instructionSrc = readFileSync(join(SRC, 'orb/live/instruction/live-system-instruction.ts'), 'utf8');
const orbLiveSrc = readFileSync(join(SRC, 'routes/orb-live.ts'), 'utf8');

const sb = {} as never;
const identity = { user_id: 'u-1', tenant_id: 't-1', vitana_id: 'v1', lang: 'de' };
const CONCRETE = 'the diary save button does nothing on the diary screen';

/** Parse the rule: the success STATUS and the "Any other STATUS (...)" list. */
function parseRuleStatuses(): { success: string; others: string[] } {
  const line = instructionSrc.split('\n').find((l) => l.includes('HARD RULE — handoff truthfulness'));
  if (!line) throw new Error('handoff truthfulness HARD RULE not found');
  const success = /begins with "STATUS: ([a-z_]+)\."/.exec(line)?.[1];
  const others = /Any other STATUS \(([^)]+)\)/.exec(line)?.[1];
  if (!success || !others) throw new Error('could not parse STATUS list from the rule');
  return { success, others: others.split('/').map((s) => s.trim()) };
}

const rule = parseRuleStatuses();
const RECOGNIZED = new Set([rule.success, ...rule.others]);

function statusOf(text: string): string | null {
  const m = /^STATUS: ([a-z_]+)\. /.exec(text);
  return m ? m[1] : null;
}

function expectRecognized(text: string, expected?: string) {
  const s = statusOf(text);
  expect(s).not.toBeNull();
  expect(RECOGNIZED.has(s as string)).toBe(true);
  if (expected) expect(s).toBe(expected);
  expect(text).toContain('ACTION: ');
}

beforeEach(() => {
  jest.clearAllMocks();
  (repo.pickSpecialistForText as jest.Mock).mockResolvedValue({
    data: [{ decision: 'forward', gate: 'forward', persona_key: 'devon', matched_phrase: 'bug', confidence: 0.9 }],
    error: null,
  });
  (repo.insertFeedbackTicket as jest.Mock).mockResolvedValue({
    data: { id: 'tk-1', ticket_number: 'FB-2026-09-000200' },
    error: null,
  });
});

describe('the rule and the code agree on the STATUS set', () => {
  it('the success STATUS is handoff_created', () => {
    expect(rule.success).toBe('handoff_created');
  });

  it('every STATUS the code can emit is one the rule names, and vice versa', () => {
    expect([...RECOGNIZED].sort()).toEqual([...REPORT_TO_SPECIALIST_STATUSES].sort());
  });
});

describe('core outcomes all begin with a recognized STATUS', () => {
  it('vague → STATUS: vague', async () => {
    const r = await executeReportToSpecialist({ kind: 'bug', summary: 'bug report' }, identity, sb);
    expect(r.decision).toBe('vague');
    expectRecognized((r as { llm_instruction: string }).llm_instruction, 'vague');
  });

  it('stay_inline (gate A answer_inline) → STATUS: stay_inline', async () => {
    (repo.pickSpecialistForText as jest.Mock).mockResolvedValue({
      data: [{ decision: 'answer_inline', gate: 'stay_inline' }],
      error: null,
    });
    const r = await executeReportToSpecialist({ kind: 'bug', summary: CONCRETE }, identity, sb);
    expect(r.decision).toBe('stay_inline');
    expectRecognized((r as { llm_instruction: string }).llm_instruction, 'stay_inline');
  });

  const created: ReportToSpecialistResult = {
    decision: 'created',
    ticket: { id: 'tk-1', ticket_number: 'FB-2026-09-000200' },
    persona: 'devon',
    matched_keyword: null,
    confidence: null,
    rpc_decision: 'forward',
    rpc_gate: 'forward',
  };

  it('created + hand-off queued → STATUS: handoff_created, with the role and never the persona name', () => {
    const m = reportToSpecialistToolMessage(created, { handoffQueued: true, roleLabel: 'unser Tech-Support' });
    expect(m.status).toBe('handoff_created');
    expectRecognized(m.text, 'handoff_created');
    expect(m.text).toContain('unser Tech-Support');
    expect(m.text).not.toMatch(/\bDevon\b/);
  });

  it('created but no hand-off queued → STATUS: ticket_filed_no_handoff with the ticket number', () => {
    const m = reportToSpecialistToolMessage(created, { handoffQueued: false });
    expectRecognized(m.text, 'ticket_filed_no_handoff');
    expect(m.text).toContain('FB-2026-09-000200');
  });

  it('created with no persona is never handoff_created, even if a caller says queued', () => {
    const m = reportToSpecialistToolMessage({ ...created, persona: null }, { handoffQueued: true });
    expect(m.status).toBe('ticket_filed_no_handoff');
  });

  it('failed → STATUS: failed, and failed_network when the cause is a connection', () => {
    const failed: ReportToSpecialistResult = { decision: 'failed', error: 'x' };
    expectRecognized(reportToSpecialistToolMessage(failed, { handoffQueued: false }).text, 'failed');
    expectRecognized(
      reportToSpecialistToolMessage(failed, { handoffQueued: false, network: true }).text,
      'failed_network',
    );
  });

  it('no ACTION text contains a quoted spoken sentence (NEVER-rule 41)', () => {
    const texts = [
      reportToSpecialistToolMessage(created, { handoffQueued: true, roleLabel: 'tech support' }).text,
      reportToSpecialistToolMessage(created, { handoffQueued: false }).text,
      reportToSpecialistToolMessage({ decision: 'failed', error: 'x' }, { handoffQueued: false }).text,
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/Examples?\s*\(/);
      expect(t).not.toMatch(/"I'll connect you/);
      expect(t).not.toMatch(/übernimmt/);
    }
  });
});

describe('orb-live.ts report_to_specialist arm builds every reply through the STATUS builders', () => {
  const start = orbLiveSrc.indexOf("case 'report_to_specialist': {");
  const end = orbLiveSrc.indexOf("case 'append_to_ticket': {", start);
  const block = orbLiveSrc.slice(start, end);

  it('the arm exists and is followed by append_to_ticket', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('no reply is a hand-written string — every result comes from a builder or the core', () => {
    expect(block).not.toMatch(/result:\s*[`'"]/);
    const results = block.match(/result:\s*[^,\n]+/g) ?? [];
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toMatch(/buildReportToSpecialistToolMessage|reportToSpecialistToolMessage|reply\.text|helperResult\.llm_instruction/);
    }
  });

  it('never returns success:false (a failure must reach the model as a STATUS, not an error the grace layer rewrites)', () => {
    expect(block).not.toMatch(/success:\s*false/);
  });

  it('the specialist refusal keeps STAY_IN_INTAKE and points to append_to_ticket', () => {
    expect(block).toContain('STAY_IN_INTAKE');
    expect(block).toContain('append_to_ticket');
  });

  it('handoff_created is only reachable through the handoffQueued flag set where the swap is queued', () => {
    const queuedAt = block.indexOf('handoffQueued = true');
    const pendingAt = block.indexOf('(session as any).pendingPersonaSwap = swapTo');
    expect(pendingAt).toBeGreaterThan(-1);
    expect(queuedAt).toBeGreaterThan(pendingAt);
  });
});

describe('shared (LiveKit / HTTP) path', () => {
  const id = { user_id: 'u-1', tenant_id: 't-1', role: 'community', lang: 'de', session_id: 's-1' };

  it('created → text begins with STATUS: handoff_created', async () => {
    const r = await tool_report_to_specialist({ kind: 'bug', summary: CONCRETE }, id, sb);
    expect(r.ok).toBe(true);
    expectRecognized((r as { text: string }).text, 'handoff_created');
  });

  it('vague → text begins with STATUS: vague', async () => {
    const r = await tool_report_to_specialist({ kind: 'bug', summary: 'bug report' }, id, sb);
    expectRecognized((r as { text: string }).text, 'vague');
  });

  it('failed → error begins with STATUS: failed', async () => {
    (repo.insertFeedbackTicket as jest.Mock).mockResolvedValue({ data: null, error: { message: 'boom' } });
    const r = await tool_report_to_specialist({ kind: 'bug', summary: CONCRETE }, id, sb);
    expect(r.ok).toBe(false);
    expectRecognized((r as { error: string }).error, 'failed');
  });
});

describe('calling rules are no longer tuned toward never calling', () => {
  const catalogSrc = readFileSync(join(SRC, 'orb/live/tools/live-tool-catalog.ts'), 'utf8');
  const start = catalogSrc.indexOf("name: 'report_to_specialist'");
  const decl = catalogSrc.slice(start, catalogSrc.indexOf("name: 'append_to_ticket'", start));
  const instrLine = instructionSrc.split('\n').find((l) => l.includes('- Use report_to_specialist')) ?? '';

  it('the tool description drops "RARE — less than 5%" and the 15-word minimum', () => {
    expect(start).toBeGreaterThan(-1);
    expect(decl).not.toMatch(/RARE/);
    expect(decl).not.toMatch(/less than 5%/);
    expect(decl).not.toMatch(/15 words/);
    expect(decl).toMatch(/That IS a hand-off case/);
    expect(decl).toMatch(/One short confirmation is enough/);
  });

  it('the system instruction keeps one short confirmation, not a propose-then-wait ritual', () => {
    expect(instrLine).toMatch(/Confirm once/);
    expect(instrLine).not.toMatch(/Shall I bring in Devon/);
    expect(instrLine).not.toMatch(/Implicit consent does not count/);
  });

  it('"you ARE the instruction manual" is scoped to how-to questions and names bugs as a hand-off case', () => {
    const manual = instructionSrc.split('\n').find((l) => l.includes('You ARE the instruction manual')) ?? '';
    expect(manual).toMatch(/HOW-TO questions only/);
    expect(manual).toMatch(/IS a hand-off case/);
  });

  it('every filing tool the prompt describes survives the Nova catalog trim (priority list)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { VERTEX_BRIDGE_PRIORITY_TOOLS } = require('../src/orb/live/tools/vertex-tool-catalog-budget');
    for (const name of ['report_to_specialist', 'append_to_ticket', 'submit_bug_report', 'submit_support_ticket']) {
      expect(VERTEX_BRIDGE_PRIORITY_TOOLS).toContain(name);
    }
  });
});

describe('summary minimum (was 12 words)', () => {
  it('is 5 words', () => {
    expect(REPORT_TO_SPECIALIST_MIN_SUMMARY_WORDS).toBe(5);
  });

  it('rejects 4 words as vague', async () => {
    const r = await executeReportToSpecialist({ kind: 'bug', summary: 'diary button is broken' }, identity, sb);
    expect(r.decision).toBe('vague');
  });

  it('files a concrete 5-word report', async () => {
    const r = await executeReportToSpecialist({ kind: 'bug', summary: 'diary save button does nothing' }, identity, sb);
    expect(r.decision).toBe('created');
  });

  it('still rejects the placeholder summaries even when long enough', async () => {
    const r = await executeReportToSpecialist(
      { kind: 'bug', summary: 'user wants to report a technical issue' },
      identity,
      sb,
    );
    expect(r.decision).toBe('vague');
  });
});

describe('ticket fields', () => {
  it('pins surface, and stores tenant, language, session id and route in structured_fields', async () => {
    await executeReportToSpecialist({ kind: 'bug', summary: CONCRETE }, identity, sb, {
      surface: 'admin',
      session_id: 'live-abc',
      current_route: '/admin/users',
    });
    const row = (repo.insertFeedbackTicket as jest.Mock).mock.calls[0][1];
    expect(row.surface).toBe('admin');
    expect(row.structured_fields).toMatchObject({
      tenant_id: 't-1',
      language: 'de',
      session_id: 'live-abc',
      current_route: '/admin/users',
    });
    expect(row).not.toHaveProperty('tenant_id');
    const evt = (emitOasisEvent as jest.Mock).mock.calls[0][0];
    expect(evt.payload).toMatchObject({ session_id: 'live-abc', surface: 'admin', language: 'de' });
  });

  it('defaults surface to community — never null for voice', async () => {
    await executeReportToSpecialist({ kind: 'bug', summary: CONCRETE }, identity, sb);
    const row = (repo.insertFeedbackTicket as jest.Mock).mock.calls[0][1];
    expect(row.surface).toBe('community');
  });

  it('maps ORB surfaces onto the feedback_tickets surface enum', () => {
    expect(feedbackSurfaceForOrb('vitanaland')).toBe('community');
    expect(feedbackSurfaceForOrb('command-hub')).toBe('command-hub');
    expect(feedbackSurfaceForOrb('admin')).toBe('admin');
    expect(feedbackSurfaceForOrb('backoffice')).toBe('admin');
    expect(feedbackSurfaceForOrb(undefined)).toBe('community');
  });
});

describe('append_to_ticket', () => {
  const ctx = { user_id: 'u-1', active_persona: 'devon', handoff_ticket_id: 'tk-1' };

  beforeEach(() => {
    (repo.fetchTicketForAppend as jest.Mock).mockResolvedValue({
      data: {
        id: 'tk-1',
        user_id: 'u-1',
        ticket_number: 'FB-2026-09-000200',
        intake_messages: [{ agent: 'vitana', role: 'user', content: 'x', ts: 't' }],
      },
      error: null,
    });
    (repo.updateTicketIntakeMessages as jest.Mock).mockResolvedValue({ error: null });
  });

  it('appends {agent, role, content, ts} to the hand-off ticket for "current"', async () => {
    const r = await executeAppendToTicket({ ticket_id: 'current', note: 'crashes after tapping save' }, ctx, sb);
    expect(r).toMatchObject({ ok: true, ticket_id: 'tk-1', message_count: 2 });
    expect(repo.fetchTicketForAppend).toHaveBeenCalledWith(sb, 'tk-1');
    const [, ticketId, userId, messages] = (repo.updateTicketIntakeMessages as jest.Mock).mock.calls[0];
    expect(ticketId).toBe('tk-1');
    expect(userId).toBe('u-1');
    expect(messages[1]).toMatchObject({ agent: 'devon', role: 'assistant', content: 'crashes after tapping save' });
    expect(typeof messages[1].ts).toBe('string');
    expect(appendToTicketToolMessage(r)).toMatch(/^STATUS: appended\./);
  });

  it('refuses Vitana — only a specialist appends', async () => {
    const r = await executeAppendToTicket({ note: 'x' }, { ...ctx, active_persona: 'vitana' }, sb);
    expect(r).toEqual({ ok: false, reason: 'not_specialist' });
    expect(repo.updateTicketIntakeMessages).not.toHaveBeenCalled();
  });

  it('refuses a session without a hand-off ticket', async () => {
    const r = await executeAppendToTicket({ note: 'x' }, { ...ctx, handoff_ticket_id: null }, sb);
    expect(r).toEqual({ ok: false, reason: 'no_handoff_ticket' });
  });

  it("refuses another user's ticket (owner check)", async () => {
    (repo.fetchTicketForAppend as jest.Mock).mockResolvedValue({
      data: { id: 'tk-9', user_id: 'someone-else', ticket_number: null, intake_messages: [] },
      error: null,
    });
    const r = await executeAppendToTicket({ ticket_id: 'tk-9', note: 'x' }, ctx, sb);
    expect(r).toEqual({ ok: false, reason: 'not_owner' });
    expect(repo.updateTicketIntakeMessages).not.toHaveBeenCalled();
  });

  it('refuses an empty note', async () => {
    const r = await executeAppendToTicket({ note: '   ' }, ctx, sb);
    expect(r).toEqual({ ok: false, reason: 'empty_note' });
  });

  it('is dispatched in orb-live.ts with the session persona and hand-off ticket', () => {
    const at = orbLiveSrc.indexOf("case 'append_to_ticket': {");
    const arm = orbLiveSrc.slice(at, at + 1500);
    expect(arm).toContain('executeAppendToTicket');
    expect(arm).toContain('activePersona');
    expect(arm).toContain('handoffTicketId');
  });
});
