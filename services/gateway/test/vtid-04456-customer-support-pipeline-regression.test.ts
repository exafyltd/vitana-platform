/**
 * VTID-04456 — customer support pipeline regression suite.
 *
 * Owner ask (2026-09-24): "a test that always verifies that any new update
 * will not damage or destroy the existing process" — for a bug reported in
 * the community app, a bug reported by voice to Vitana, and a bug raised
 * while the member is talking to Devon.
 *
 * Every other support test checks one piece with the pieces around it mocked
 * away. This suite runs the REAL code of every stage, in the order a real
 * ticket goes through them, over one in-memory copy of the database
 * (test/support-pipeline/fake-platform.ts):
 *
 *   intake (app route / report_to_specialist / typed ORB tool)
 *     → Vitana→Devon hand-off (tool STATUS, voice gate, persona swap)
 *     → Devon enriches the ticket (append_to_ticket)
 *     → classifier + SQL auto-triage (placeholder spec)       [emulated DB side]
 *     → spec drafter replaces the placeholder with a real spec
 *     → auto-dispatch → execution bridge: recommendation, VTID, execution
 *     → PR title carries (FB-…, VTID-…)
 *     → completion reconciler: resolved (or reopened on a failed fix)
 *
 * Only the edges are stubbed: the LLM that writes the spec, the Dev
 * Autopilot executor that writes code (bridgeActivationToExecution), the VTID
 * allocator's ledger RPC, the reporter notification, OASIS emission (captured,
 * not sent) and the persona registry lookup. Anything that changes what a
 * stage writes, reads or hands to the next stage fails here.
 *
 * If this suite fails after your change, the change broke the support
 * pipeline for a real member. Fix the change; do not loosen the assertion
 * unless the pipeline's contract was changed on purpose — and then say so in
 * the PR.
 */

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

import { FakePlatform, FAKE_SUPABASE_URL, AUTO_TRIAGE_PLACEHOLDER_HEADING } from './support-pipeline/fake-platform';

// ---------------------------------------------------------------------------
// Edges (the things outside the support pipeline)
// ---------------------------------------------------------------------------

let mockPlatform: FakePlatform;
const mockOasis: Array<Record<string, any>> = [];
let mockVtidSeq = 9000;

jest.mock('../src/services/oasis-event-service', () => ({
  ...jest.requireActual('../src/services/oasis-event-service'),
  emitOasisEvent: jest.fn(async (e: Record<string, any>) => {
    mockOasis.push(e);
    return { ok: true };
  }),
}));

jest.mock('../src/services/persona-registry', () => ({
  ...jest.requireActual('../src/services/persona-registry'),
  // Live registry (VTID-03044): only Devon is an active specialist.
  pickPersonaForKind: jest.fn(async (kind: string) => (kind === 'bug' || kind === 'ux_issue' ? 'devon' : null)),
  pickPersonaForKindForTenant: jest.fn(async (kind: string) => (kind === 'bug' || kind === 'ux_issue' ? 'devon' : null)),
}));

jest.mock('../src/services/dev-autopilot-execute', () => {
  const { isUuidString } = jest.requireActual('../src/services/dev-autopilot-execute');
  return {
  isUuidString,
  bridgeActivationToExecution: jest.fn(async (findingId: string, approvedBy: string | null = null) => {
    // VTID-04649: the real approveAutoExecute refuses a non-UUID approver
    // (dev_autopilot_executions.approved_by is uuid, VTID-03839). The stub
    // enforces the same rule so a label such as 'auto-dispatch' fails here
    // exactly as it failed live on staging.
    if (approvedBy && !isUuidString(approvedBy)) {
      return { ok: false, error: `approved_by must be a user UUID (dev_autopilot_executions.approved_by is uuid) — got "${approvedBy}". ` };
    }
    const ex = mockPlatform.insert('dev_autopilot_executions', {
      finding_id: findingId,
      status: 'cooling',
      pr_url: null,
      failure_stage: null,
      completed_at: null,
    });
    return { ok: true, execution_id: ex.id };
  }),
  };
});

jest.mock('../src/services/dev-autopilot-vtid-allocate', () => ({
  allocateAndRegisterFindingVtid: jest.fn(async (_s: unknown, input: { findingId: string }) => {
    mockVtidSeq += 1;
    const vtid = `VTID-${String(mockVtidSeq).padStart(5, '0')}`;
    const rec = mockPlatform.table('autopilot_recommendations').find((r) => r.id === input.findingId);
    if (rec) rec.activated_vtid = vtid;
    return { ok: true, vtid };
  }),
}));

jest.mock('../src/services/feedback-reporter-notify', () => ({
  notifyFeedbackReporter: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../src/services/feedback-llm-resolvers', () => ({
  // The bridge's own auto-retry redraft — never reached when the spec is good.
  llmDraftDevonSpec: jest.fn(async () => ({ markdown: '', provider: 'fallback' })),
}));

jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => mockPlatform.client()),
}));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../src/middleware/auth-supabase-jwt'),
  resolveVitanaId: jest.fn(async () => '@member1'),
}));

// ---------------------------------------------------------------------------
// The real pipeline
// ---------------------------------------------------------------------------

import feedbackRouter from '../src/routes/feedback';
import {
  executeReportToSpecialist,
  reportToSpecialistToolMessage,
  executeAppendToTicket,
  appendToTicketToolMessage,
  feedbackSurfaceForOrb,
  isVagueSummary,
} from '../src/services/report-to-specialist-core';
import { tool_submit_bug_report } from '../src/services/orb-tools/feedback-settings-tools';
import { draftPlaceholderSpecsTick, isPlaceholderSpec, resetSpecDraftThrottle } from '../src/services/feedback-spec-drafter';
import { reconcileCompletedFeedbackTickets } from '../src/services/feedback-completion-reconciler';
import { stampVtidOnTitle } from '../src/services/dev-autopilot-pr-contract';
import { personaVoiceAvailability } from '../src/orb/live/voice/specialist-voice-availability';
import { buildInProcessPersonaSwap } from '../src/orb/live/session/in-process-persona-swap';
import { notifyFeedbackReporter } from '../src/services/feedback-reporter-notify';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMBER = 'a1111111-1111-4111-8111-111111111111';
const OTHER_MEMBER = 'b2222222-2222-4222-8222-222222222222';
const TENANT = 'c3333333-3333-4333-8333-333333333333';
const APP_VERSION = '2026.09.24-abc123';
const S = { url: FAKE_SUPABASE_URL, key: 'service-role' };
const AUTO_ON = { FEEDBACK_AUTO_DISPATCH_ENABLED: 'true' } as NodeJS.ProcessEnv;
const TICKET_NUMBER_RE = /^FB-\d{4}-\d{2}-\d{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jwt(sub: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
  return `${b({ alg: 'none' })}.${b({ sub })}.sig`;
}

/** What Devon's LLM draft looks like: a headline, a Files-to-touch list with
 *  an allow-scoped source file and its test. */
function devonSpec(t: { ticket_number: string | null }, headline = 'Diary save button does nothing'): string {
  return [
    `# ${t.ticket_number} — ${headline}`,
    '',
    '## Root cause (best guess)',
    'The save handler never awaits the insert.',
    '',
    '## Files to touch (best guess)',
    '- services/gateway/src/services/diary-service.ts',
    '- services/gateway/test/diary-service.test.ts',
    '',
    '## Risk + rollback',
    'Low. Revert the PR.',
  ].join('\n');
}

const draftCalls: Array<Record<string, any>> = [];
const goodDraft = jest.fn(async (t: any) => {
  draftCalls.push(t);
  return { markdown: devonSpec(t), provider: 'llm' as const };
});

function eventsOfType(type: string) {
  return mockOasis.filter((e) => e.type === type);
}

const flush = () => new Promise((r) => setImmediate(r));

function newPlatform(): FakePlatform {
  const p = new FakePlatform({
    pickSpecialist: (text) =>
      /\b(bug|broken|crash|error|nothing happens|does nothing|doesn't work|fehler|kaputt)\b/i.test(text)
        ? { persona_key: 'devon', matched_phrase: 'bug', confidence: 0.9 }
        : null,
  });
  p.insert('dev_autopilot_config', {
    id: 1,
    kill_switch: false,
    allow_scope: ['services/gateway/src/**', 'services/gateway/test/**'],
    deny_scope: ['supabase/migrations/**', '**/orb-live.ts', '.github/workflows/**', '**/.env*'],
  });
  return p;
}

/**
 * The part every intake path shares: classify → auto-triage → draft → auto
 * dispatch. Asserts every hand-over on the way and returns the ticket VTID.
 */
async function driveTicketToExecution(ticketId: string): Promise<{ vtid: string; findingId: string; executionId: string }> {
  // Classifier + SQL auto-triage (database side).
  mockPlatform.classify(ticketId);
  expect(mockPlatform.runAutoTriage()).toContain(ticketId);
  let t = mockPlatform.ticket(ticketId);
  expect(t.status).toBe('spec_ready');
  expect(t.resolver_agent).toBe('devon');
  expect(isPlaceholderSpec(t.spec_md)).toBe(true);

  // Spec drafter replaces the placeholder, then auto-dispatch starts the fix.
  const tick = await draftPlaceholderSpecsTick(S, { draft: goodDraft as any, env: AUTO_ON, force: true });
  expect(tick).toEqual(expect.objectContaining({ drafted: 1, failed: 0, dispatched: 1, dispatch_failed: 0 }));

  t = mockPlatform.ticket(ticketId);
  expect(isPlaceholderSpec(t.spec_md)).toBe(false);
  expect(t.classifier_meta.spec_drafted_by).toBe('devon-llm');
  expect(t.classifier_meta.auto_dispatch_attempts).toBe(1);
  expect(t.status).toBe('in_progress');
  expect(t.linked_vtid).toMatch(/^VTID-\d{5}$/);
  expect(t.linked_finding_id).toMatch(UUID_RE);

  // The Dev Autopilot finding points back at the ticket, and knows its number + VTID.
  const rec = mockPlatform.table('autopilot_recommendations').find((r) => r.id === t.linked_finding_id)!;
  expect(rec).toBeDefined();
  expect(rec.source_type).toBe('dev_autopilot');
  expect(rec.source_ref).toBe(`feedback_ticket:${ticketId}`);
  expect(rec.signal_fingerprint).toBe(`feedback:${ticketId}`);
  expect(rec.activated_vtid).toBe(t.linked_vtid);
  expect(rec.spec_snapshot.file_path).toBe('services/gateway/src/services/diary-service.ts');
  expect(rec.spec_snapshot.proposed_files).toEqual([
    'services/gateway/src/services/diary-service.ts',
    'services/gateway/test/diary-service.test.ts',
  ]);
  expect(rec.spec_snapshot.feedback).toEqual(expect.objectContaining({
    ticket_id: ticketId,
    ticket_number: t.ticket_number,
    linked_vtid: t.linked_vtid,
    spec_md: t.spec_md,
  }));

  // One execution exists for the finding.
  const execs = mockPlatform.table('dev_autopilot_executions').filter((e) => e.finding_id === rec.id);
  expect(execs).toHaveLength(1);

  // The dispatch is on the ticket VTID's event trail, marked as automatic.
  const dispatched = eventsOfType('feedback.ticket.dispatched').filter((e) => e.payload.ticket_id === ticketId);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0].vtid).toBe(t.linked_vtid);
  expect(dispatched[0].payload).toEqual(expect.objectContaining({
    ticket_number: t.ticket_number,
    execution_id: execs[0].id,
    auto_dispatch: true,
  }));

  // The fix PR is titled with the member ticket number and the VTID.
  const title = stampVtidOnTitle('fix(diary): persist entry on save', t.linked_vtid, t.ticket_number);
  expect(title).toBe(`fix(diary): persist entry on save (${t.ticket_number}, ${t.linked_vtid})`);

  return { vtid: t.linked_vtid, findingId: rec.id, executionId: execs[0].id };
}

/** The executor finished: the reconciler closes (or reopens) the ticket. */
async function finishExecution(ticketId: string, executionId: string, outcome: 'completed' | 'failed') {
  const ex = mockPlatform.table('dev_autopilot_executions').find((e) => e.id === executionId)!;
  ex.status = outcome;
  ex.pr_url = 'https://github.com/exafyltd/vitana-platform/pull/9999';
  ex.completed_at = outcome === 'completed' ? new Date().toISOString() : null;
  ex.failure_stage = outcome === 'failed' ? 'ci' : null;
  const r = await reconcileCompletedFeedbackTickets(S);
  await flush();
  return r;
}

async function expectResolved(ticketId: string, executionId: string) {
  const r = await finishExecution(ticketId, executionId, 'completed');
  expect(r).toEqual({ closed: 1, failed: 0 });
  const t = mockPlatform.ticket(ticketId);
  expect(t.status).toBe('resolved');
  expect(t.auto_resolved).toBe(true);
  expect(t.linked_pr_url).toBe('https://github.com/exafyltd/vitana-platform/pull/9999');
  const resolved = eventsOfType('feedback.ticket.resolved').filter((e) => e.payload.ticket_id === ticketId);
  expect(resolved).toHaveLength(1);
  expect(resolved[0].vtid).toBe(t.linked_vtid);
  expect(notifyFeedbackReporter).toHaveBeenCalledWith(ticketId);

  // Idempotent: a second reconcile pass does nothing to a resolved ticket.
  expect(await reconcileCompletedFeedbackTickets(S)).toEqual({ closed: 0, failed: 0 });
}

// ---------------------------------------------------------------------------

let app: express.Express;

beforeEach(() => {
  mockPlatform = newPlatform();
  mockOasis.length = 0;
  draftCalls.length = 0;
  goodDraft.mockClear();
  (global as any).fetch = mockPlatform.fetch;
  resetSpecDraftThrottle();
  process.env.SUPABASE_URL = FAKE_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE = 'service-role';
  process.env.SUPABASE_ANON_KEY = 'anon';
  delete process.env.TTS_FISH_FALLBACK_ENABLED;
  delete process.env.FISH_API_KEY;
  app = express();
  app.use(express.json());
  app.use('/api/v1/feedback/tickets', feedbackRouter);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// Scenario 1 — a community member reports a bug in the app
// ===========================================================================

describe('Scenario 1: a community member files a bug in the app', () => {
  async function fileInApp() {
    const res = await request(app)
      .post('/api/v1/feedback/tickets')
      .set('Authorization', `Bearer ${jwt(MEMBER)}`)
      .send({
        kind: 'bug',
        raw_text: 'When I tap Save in my diary nothing happens and the entry is lost.',
        screen_path: '/diary',
        app_version: APP_VERSION,
      });
    return res;
  }

  it('the ticket is filed for the member and announced', async () => {
    const res = await fileInApp();
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.ticket_number).toMatch(TICKET_NUMBER_RE);

    const t = mockPlatform.ticket(res.body.id);
    expect(t).toEqual(expect.objectContaining({
      user_id: MEMBER,
      vitana_id: '@member1',
      kind: 'bug',
      status: 'new',
      screen_path: '/diary',
      app_version: APP_VERSION,
    }));
    expect(t.raw_transcript).toContain('Save in my diary');

    const created = eventsOfType('feedback.ticket.created');
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual(expect.objectContaining({ ticket_id: t.id, ticket_number: t.ticket_number, kind: 'bug' }));
  });

  it('goes all the way: spec → dispatch → PR title → resolved, member notified', async () => {
    const res = await fileInApp();
    const { executionId } = await driveTicketToExecution(res.body.id);
    await expectResolved(res.body.id, executionId);
  });

  it('a fix that fails reopens the ticket for review instead of closing it', async () => {
    const res = await fileInApp();
    const { executionId, vtid } = await driveTicketToExecution(res.body.id);
    expect(await finishExecution(res.body.id, executionId, 'failed')).toEqual({ closed: 0, failed: 1 });
    const t = mockPlatform.ticket(res.body.id);
    expect(t.status).toBe('needs_more_info');
    expect(t.supervisor_notes).toContain(executionId.slice(0, 8));
    const failed = eventsOfType('feedback.ticket.fix_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].vtid).toBe(vtid);
    expect(notifyFeedbackReporter).not.toHaveBeenCalled();
  });

  it('an unauthenticated request files nothing', async () => {
    const res = await request(app).post('/api/v1/feedback/tickets').send({ kind: 'bug', raw_text: 'x' });
    expect(res.status).toBe(401);
    expect(mockPlatform.table('feedback_tickets')).toHaveLength(0);
  });
});

// ===========================================================================
// Scenario 2 — a member tells Vitana about a bug (ORB voice)
// ===========================================================================

const VOICE_SUMMARY = 'The diary save button does nothing when I tap it, the entry is lost';

async function reportToVitana(lang = 'de') {
  const result = await executeReportToSpecialist(
    { kind: 'bug', summary: VOICE_SUMMARY },
    { user_id: MEMBER, tenant_id: TENANT, vitana_id: '@member1', lang },
    mockPlatform.client(),
    {
      gate_input: `I want to report a bug. ${VOICE_SUMMARY}`,
      source: 'orb-voice-tool',
      screen_path: '/orb/voice',
      surface: feedbackSurfaceForOrb('community'),
      session_id: 'live-session-1',
      current_route: '/diary',
      app_version: APP_VERSION,
    },
  );
  if (result.decision !== 'created') throw new Error(`expected a ticket, got ${result.decision}`);
  return result;
}

describe('Scenario 2: a member reports a bug to Vitana by voice', () => {
  it('files a triaged ticket routed to Devon, with the session context', async () => {
    const r = await reportToVitana();
    expect(r.persona).toBe('devon');
    expect(r.ticket.ticket_number).toMatch(TICKET_NUMBER_RE);

    const t = mockPlatform.ticket(r.ticket.id);
    expect(t).toEqual(expect.objectContaining({
      user_id: MEMBER,
      kind: 'bug',
      status: 'triaged',
      surface: 'community',
      resolver_agent: 'devon',
      app_version: APP_VERSION,
      raw_transcript: VOICE_SUMMARY,
    }));
    expect(t.structured_fields).toEqual(expect.objectContaining({
      voice_origin: true,
      source: 'orb-voice-tool',
      tenant_id: TENANT,
      language: 'de',
      session_id: 'live-session-1',
      current_route: '/diary',
    }));
    expect(t.intake_messages).toEqual([expect.objectContaining({ agent: 'vitana', role: 'user', content: VOICE_SUMMARY })]);

    // Live Handoffs panel row.
    expect(mockPlatform.table('feedback_handoff_events')).toEqual([
      expect.objectContaining({ ticket_id: t.id, user_id: MEMBER, from_agent: 'vitana', to_agent: 'devon' }),
    ]);
    const created = eventsOfType('feedback.ticket.created');
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual(expect.objectContaining({ ticket_id: t.id, voice_origin: true, session_id: 'live-session-1' }));
  });

  it('Vitana is told the hand-off happened, and Devon joins in his own (male) voice', async () => {
    const r = await reportToVitana('de');
    const gate = personaVoiceAvailability({ persona: 'devon', lang: 'de', provider: 'nova_sonic' });
    expect(gate.ok).toBe(true);

    const msg = reportToSpecialistToolMessage(r, { handoffQueued: gate.ok, roleLabel: 'our technical support' });
    expect(msg.status).toBe('handoff_created');
    expect(msg.text.startsWith('STATUS: handoff_created.')).toBe(true);
    expect(msg.text).toContain(r.ticket.ticket_number!);

    const swap = buildInProcessPersonaSwap({ personaSystemOverride: 'devon prompt' }, 'devon');
    expect(swap).toEqual(expect.objectContaining({ persona: 'devon', voiceRole: 'specialist', openWithGreeting: true }));
  });

  it('with no male voice on the pipeline, Devon does not join — the ticket is still filed and still fixed', async () => {
    const r = await reportToVitana('tr');
    const gate = personaVoiceAvailability({ persona: 'devon', lang: 'tr', provider: 'cascaded' });
    expect(gate.ok).toBe(false);

    const msg = reportToSpecialistToolMessage(r, { handoffQueued: gate.ok, roleLabel: 'our technical support' });
    expect(msg.status).toBe('ticket_filed_no_handoff');
    expect(msg.text).not.toContain('handoff_created');

    const { executionId } = await driveTicketToExecution(r.ticket.id);
    await expectResolved(r.ticket.id, executionId);
  });

  it('goes all the way: spec → dispatch → PR title → resolved', async () => {
    const r = await reportToVitana();
    const { executionId } = await driveTicketToExecution(r.ticket.id);
    await expectResolved(r.ticket.id, executionId);
  });

  it('a vague report files nothing and asks the member for detail', async () => {
    const r = await executeReportToSpecialist(
      { kind: 'bug', summary: 'user wants to report a bug' },
      { user_id: MEMBER, tenant_id: TENANT, lang: 'en' },
      mockPlatform.client(),
    );
    expect(r.decision).toBe('vague');
    expect(reportToSpecialistToolMessage(r, { handoffQueued: false }).status).toBe('vague');
    expect(mockPlatform.table('feedback_tickets')).toHaveLength(0);
    expect(isVagueSummary(VOICE_SUMMARY)).toBe(false);
  });

  it('the typed voice tool (submit_bug_report) files through the same path and is fixed the same way', async () => {
    const res = await tool_submit_bug_report(
      { summary: VOICE_SUMMARY, screen: '/diary' },
      {
        user_id: MEMBER,
        tenant_id: TENANT,
        role: 'community',
        vitana_id: '@member1',
        lang: 'en',
        session_id: 'live-session-2',
        current_route: '/diary',
        app_version: APP_VERSION,
      } as any,
      mockPlatform.client(),
    );
    expect(res.ok).toBe(true);
    const out = (res as any).result;
    expect(out).toEqual(expect.objectContaining({ decision: 'created', kind: 'bug', specialist: 'devon' }));

    const t = mockPlatform.ticket(out.ticket_id);
    expect(t.status).toBe('triaged');
    expect(t.surface).toBe('community');
    expect(t.app_version).toBe(APP_VERSION);
    expect(t.structured_fields).toEqual(expect.objectContaining({ source: 'orb-voice-typed-tool', session_id: 'live-session-2' }));

    const { executionId } = await driveTicketToExecution(t.id);
    await expectResolved(t.id, executionId);
  });
});

// ===========================================================================
// Scenario 3 — a bug raised while the member is talking to Devon
// ===========================================================================

describe('Scenario 3: a bug raised in the conversation with Devon', () => {
  const NOTE = 'Happens on Android 14 since the September update; the text vanishes right after tapping Save.';

  it('Devon adds what he learns to the hand-off ticket; Vitana cannot', async () => {
    const r = await reportToVitana();

    const asVitana = await executeAppendToTicket(
      { ticket_id: 'current', note: NOTE },
      { user_id: MEMBER, active_persona: 'vitana', handoff_ticket_id: r.ticket.id },
      mockPlatform.client(),
    );
    expect(asVitana).toEqual({ ok: false, reason: 'not_specialist' });

    const asDevon = await executeAppendToTicket(
      { ticket_id: 'current', note: NOTE },
      { user_id: MEMBER, active_persona: 'devon', handoff_ticket_id: r.ticket.id },
      mockPlatform.client(),
    );
    expect(asDevon).toEqual(expect.objectContaining({ ok: true, ticket_id: r.ticket.id, message_count: 2 }));
    expect(appendToTicketToolMessage(asDevon).startsWith('STATUS: appended.')).toBe(true);

    const t = mockPlatform.ticket(r.ticket.id);
    expect(t.intake_messages).toEqual([
      expect.objectContaining({ agent: 'vitana', role: 'user', content: VOICE_SUMMARY }),
      expect.objectContaining({ agent: 'devon', role: 'assistant', content: NOTE }),
    ]);
  });

  it("Devon cannot write to another member's ticket", async () => {
    const r = await reportToVitana();
    mockPlatform.ticket(r.ticket.id).user_id = OTHER_MEMBER;
    const res = await executeAppendToTicket(
      { ticket_id: r.ticket.id, note: NOTE },
      { user_id: MEMBER, active_persona: 'devon', handoff_ticket_id: r.ticket.id },
      mockPlatform.client(),
    );
    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    expect(mockPlatform.ticket(r.ticket.id).intake_messages).toHaveLength(1);
  });

  it('the enriched ticket reaches the spec writer with Devon\'s note, and is fixed', async () => {
    const r = await reportToVitana();
    await executeAppendToTicket(
      { ticket_id: 'current', note: NOTE },
      { user_id: MEMBER, active_persona: 'devon', handoff_ticket_id: r.ticket.id },
      mockPlatform.client(),
    );
    const { executionId } = await driveTicketToExecution(r.ticket.id);
    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0].intake_messages.map((m: any) => m.content)).toContain(NOTE);
    await expectResolved(r.ticket.id, executionId);
  });

  it('a second bug the member mentions to Devon becomes its own ticket, fixed on its own', async () => {
    const first = await reportToVitana();
    const second = await tool_submit_bug_report(
      { summary: 'Also the reminder bell icon crashes the app when I open it', screen: '/reminders' },
      {
        user_id: MEMBER, tenant_id: TENANT, role: 'community', lang: 'de',
        session_id: 'live-session-1', current_route: '/reminders', app_version: APP_VERSION,
      } as any,
      mockPlatform.client(),
    );
    const secondId = (second as any).result.ticket_id;
    expect(secondId).not.toBe(first.ticket.id);
    expect(mockPlatform.ticket(secondId).structured_fields.session_id).toBe('live-session-1');

    // Both are fixed, independently, each under its own VTID.
    const a = await driveTicketToExecution(first.ticket.id);
    const b = await driveTicketToExecution(secondId);
    expect(a.vtid).not.toBe(b.vtid);
    expect(a.findingId).not.toBe(b.findingId);
    await expectResolved(first.ticket.id, a.executionId);
    await expectResolved(secondId, b.executionId);
  });

  it('when Devon hands the member back, Vitana returns quietly as herself', () => {
    const back = buildInProcessPersonaSwap({ specialistContextSection: 'Devon filed FB-…' }, 'vitana');
    expect(back).toEqual(expect.objectContaining({ persona: 'vitana', voiceRole: 'receptionist', openWithGreeting: false }));
    expect(back.appendix).toContain('Devon filed');
  });
});

// ===========================================================================
// Safety rails that must hold for every intake path
// ===========================================================================

describe('Safety rails', () => {
  it('a placeholder spec never reaches Dev Autopilot', async () => {
    const r = await reportToVitana();
    mockPlatform.classify(r.ticket.id);
    mockPlatform.runAutoTriage();
    const failingDraft = jest.fn(async () => ({ markdown: 'x (LLM unavailable, placeholder)', provider: 'fallback' as const }));
    const tick = await draftPlaceholderSpecsTick(S, { draft: failingDraft as any, env: AUTO_ON, force: true });
    expect(tick.dispatched).toBe(0);
    expect(mockPlatform.ticket(r.ticket.id).status).toBe('spec_ready');
    expect(mockPlatform.table('autopilot_recommendations')).toHaveLength(0);
    expect(mockPlatform.table('dev_autopilot_executions')).toHaveLength(0);
  });

  it('an armed kill switch stops auto-dispatch before anything is allocated', async () => {
    mockPlatform.table('dev_autopilot_config')[0].kill_switch = true;
    const r = await reportToVitana();
    mockPlatform.classify(r.ticket.id);
    mockPlatform.runAutoTriage();
    const tick = await draftPlaceholderSpecsTick(S, { draft: goodDraft as any, env: AUTO_ON, force: true });
    expect(tick).toEqual(expect.objectContaining({ drafted: 1, dispatched: 0 }));
    expect(mockPlatform.ticket(r.ticket.id).linked_vtid).toBeNull();
    expect(mockPlatform.table('autopilot_recommendations')).toHaveLength(0);
  });

  it('auto-dispatch is off unless FEEDBACK_AUTO_DISPATCH_ENABLED is exactly "true"', async () => {
    const r = await reportToVitana();
    mockPlatform.classify(r.ticket.id);
    mockPlatform.runAutoTriage();
    const tick = await draftPlaceholderSpecsTick(S, {
      draft: goodDraft as any, env: { FEEDBACK_AUTO_DISPATCH_ENABLED: 'TRUE' } as NodeJS.ProcessEnv, force: true,
    });
    expect(tick).toEqual(expect.objectContaining({ drafted: 1, dispatched: 0 }));
    expect(mockPlatform.ticket(r.ticket.id).status).toBe('spec_ready');
  });

  it('a ticket from the human-only Support screen is never auto-triaged or auto-fixed', async () => {
    const res = await request(app)
      .post('/api/v1/feedback/tickets')
      .set('Authorization', `Bearer ${jwt(MEMBER)}`)
      .send({ kind: 'bug', raw_text: 'The diary save button does nothing at all', surface: 'support' });
    expect(res.status).toBe(201);
    mockPlatform.classify(res.body.id);
    expect(mockPlatform.runAutoTriage()).toEqual([]);
    expect(mockPlatform.ticket(res.body.id).status).toBe('triaged');
  });
});

// ===========================================================================
// The emulated database side must match the real migration
// ===========================================================================

describe('Contract: emulated auto-triage matches the live SQL definition', () => {
  const dir = path.join(__dirname, '../../../supabase/migrations');
  const latest = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => /FUNCTION\s+public\.auto_triage_pending_feedback_tickets/i.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .pop();

  it('finds the migration that last defines auto_triage_pending_feedback_tickets()', () => {
    expect(latest).toBeDefined();
  });

  it('selects the same tickets and writes the same placeholder the fake does', () => {
    const sql = fs.readFileSync(path.join(dir, latest!), 'utf8');
    // Selection (FakePlatform.runAutoTriage mirrors each of these).
    expect(sql).toMatch(/status\s*=\s*'triaged'/);
    expect(sql).toMatch(/triaged_at\s*<\s*NOW\(\)\s*-\s*INTERVAL\s*'5 minutes'/i);
    expect(sql).toMatch(/duplicate_of\s+IS\s+NULL/i);
    expect(sql).toMatch(/classifier_meta\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/COALESCE\(surface,\s*''\)\s*<>\s*'support'/i);
    // Bug branch.
    expect(sql).toMatch(/r\.kind\s+IN\s*\('bug',\s*'ux_issue'\)/i);
    expect(sql).toMatch(/status\s*=\s*'spec_ready'/);
    expect(sql).toMatch(/resolver_agent\s*=\s*'devon'/);
    expect(sql).toContain(`'${AUTO_TRIAGE_PLACEHOLDER_HEADING}'`);
  });

  it('the placeholder the database writes is one the drafter recognises and the bridge refuses', () => {
    expect(isPlaceholderSpec(`${AUTO_TRIAGE_PLACEHOLDER_HEADING}\n## User report\nx`)).toBe(true);
  });
});
