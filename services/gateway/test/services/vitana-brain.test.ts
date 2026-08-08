/**
 * Vitana Brain (VTID-01927/01931/01932/01933/01934/01935/01936/01952/03183/
 * 03259/03262/BOOTSTRAP-DYK-TOUR) — unit tests for src/services/vitana-brain.ts.
 *
 * This is the central conversation orchestrator every surface (ORB voice,
 * Operator text) routes through. Scope of this suite is vitana-brain's OWN
 * contract:
 *   1. processBrainTurn — wraps processConversationTurn, brain telemetry,
 *      graceful error handling.
 *   2. buildAwarenessBlock — pure prompt-formatting function (branches not
 *      already covered by vitana-brain-awareness-reconcile.test.ts).
 *   3. buildLifeCompassGoalBlock — Supabase-backed goal block.
 *   4. buildProactiveGuideBlock — the proactive-opener orchestration (flag
 *      gates, role gate, V2 arbiter branch, initiative/tour-hint mutual
 *      exclusion, telemetry).
 *   5. buildBrainToolDefinitions — tool registry merge (ORB tools + registry,
 *      de-duped).
 *   6. executeBrainTool — the brain's own tool executor (search_calendar,
 *      pause/clear/record_feature_introduction, unknown tool, thrown error).
 *
 * Mocking strategy: every sibling service vitana-brain.ts imports is mocked
 * wholesale at the module boundary (conversation-client, context-pack-builder,
 * retrieval-router, memory-orchestrator, ai-personality-service,
 * journey-modes-prompt, oasis-event-service, lib/supabase,
 * system-controls-service, identity-guardrail-block, services/guide,
 * journey-foundation-state, tool-registry, calendar-service) — this suite
 * verifies vitana-brain's own wiring/decisions, not those services' internals.
 */

process.env.NODE_ENV = 'test';

jest.mock('../../src/services/conversation-client', () => ({
  processConversationTurn: jest.fn(),
}));

jest.mock('../../src/services/context-pack-builder', () => ({
  extractLanguageFromContextPack: jest.fn(),
  buildLanguageDirective: jest.fn(),
}));

jest.mock('../../src/services/retrieval-router', () => ({
  computeRetrievalRouterDecision: jest.fn(),
}));

jest.mock('../../src/services/memory-orchestrator', () => ({
  buildAssistantMemoryContext: jest.fn(),
}));

jest.mock('../../src/services/ai-personality-service', () => ({
  getPersonalityConfigSync: jest.fn(),
}));

jest.mock('../../src/orb/live/instruction/journey-modes-prompt', () => ({
  buildJourneyModesSection: jest.fn(),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/system-controls-service', () => ({
  getSystemControl: jest.fn(),
}));

jest.mock('../../src/services/identity-guardrail-block', () => ({
  buildIdentityGuardrailBlock: jest.fn(),
}));

jest.mock('../../src/services/guide', () => ({
  pickOpenerCandidate: jest.fn(),
  getAwarenessContext: jest.fn(),
  recordFeatureIntroduction: jest.fn(),
  PAUSE_PROACTIVE_GUIDANCE_TOOL: { name: 'pause_proactive_guidance', description: 'pause', parameters: { type: 'object', properties: {} } },
  CLEAR_PROACTIVE_PAUSES_TOOL: { name: 'clear_proactive_pauses', description: 'clear', parameters: { type: 'object', properties: {} } },
  RECORD_FEATURE_INTRODUCTION_TOOL: { name: 'record_feature_introduction', description: 'record', parameters: { type: 'object', properties: {} } },
  executePauseProactiveGuidance: jest.fn(),
  executeClearProactivePauses: jest.fn(),
  emitGuideTelemetry: jest.fn(),
  canSurfaceProactively: jest.fn(),
  recordTouch: jest.fn(),
  resolveNextTip: jest.fn(),
  pickProactiveInitiative: jest.fn(),
  buildJourneyConversationV2Block: jest.fn(),
}));

jest.mock('../../src/services/journey-foundation/journey-foundation-state', () => ({
  buildJourneyFoundationSnapshot: jest.fn(),
}));

jest.mock('../../src/services/tool-registry', () => ({
  getGeminiToolDefinitions: jest.fn(),
}));

jest.mock('../../src/services/calendar-service', () => ({
  getUserTodayEvents: jest.fn(),
  getUserUpcomingEvents: jest.fn(),
  getCalendarGaps: jest.fn(),
}));

import {
  processBrainTurn,
  buildAwarenessBlock,
  buildLifeCompassGoalBlock,
  buildProactiveGuideBlock,
  buildBrainToolDefinitions,
  executeBrainTool,
  type BrainTurnInput,
  type FoundationAwarenessSignal,
} from '../../src/services/vitana-brain';
import { processConversationTurn } from '../../src/services/conversation-client';
import { emitOasisEvent } from '../../src/services/oasis-event-service';
import { getSupabase } from '../../src/lib/supabase';
import { getSystemControl } from '../../src/services/system-controls-service';
import { getPersonalityConfigSync } from '../../src/services/ai-personality-service';
import {
  pickOpenerCandidate,
  getAwarenessContext,
  executePauseProactiveGuidance,
  executeClearProactivePauses,
  recordFeatureIntroduction,
  emitGuideTelemetry,
  canSurfaceProactively,
  recordTouch,
  resolveNextTip,
  pickProactiveInitiative,
  buildJourneyConversationV2Block,
} from '../../src/services/guide';
import { buildJourneyFoundationSnapshot } from '../../src/services/journey-foundation/journey-foundation-state';
import { getGeminiToolDefinitions } from '../../src/services/tool-registry';
import { getUserTodayEvents, getUserUpcomingEvents, getCalendarGaps } from '../../src/services/calendar-service';
import type { UserAwareness, OpenerCandidate } from '../../src/services/guide/types';

const mockProcessConversationTurn = processConversationTurn as jest.Mock;
const mockEmitOasisEvent = emitOasisEvent as jest.Mock;
const mockGetSupabase = getSupabase as jest.Mock;
const mockGetSystemControl = getSystemControl as jest.Mock;
const mockGetPersonalityConfigSync = getPersonalityConfigSync as jest.Mock;
const mockPickOpenerCandidate = pickOpenerCandidate as jest.Mock;
const mockGetAwarenessContext = getAwarenessContext as jest.Mock;
const mockExecutePause = executePauseProactiveGuidance as jest.Mock;
const mockExecuteClear = executeClearProactivePauses as jest.Mock;
const mockRecordFeatureIntroduction = recordFeatureIntroduction as jest.Mock;
const mockEmitGuideTelemetry = emitGuideTelemetry as jest.Mock;
const mockCanSurfaceProactively = canSurfaceProactively as jest.Mock;
const mockRecordTouch = recordTouch as jest.Mock;
const mockResolveNextTip = resolveNextTip as jest.Mock;
const mockPickProactiveInitiative = pickProactiveInitiative as jest.Mock;
const mockBuildJourneyConversationV2Block = buildJourneyConversationV2Block as jest.Mock;
const mockBuildJourneyFoundationSnapshot = buildJourneyFoundationSnapshot as jest.Mock;
const mockGetGeminiToolDefinitions = getGeminiToolDefinitions as jest.Mock;
const mockGetUserTodayEvents = getUserTodayEvents as jest.Mock;
const mockGetUserUpcomingEvents = getUserUpcomingEvents as jest.Mock;
const mockGetCalendarGaps = getCalendarGaps as jest.Mock;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  return {
    tenure: { stage: 'day1', days_since_signup: 3, active_usage_days: 2, registered_at: '2026-05-30T10:00:00Z' },
    journey: { current_wave: { id: 'w1', name: 'Momentum', description: 'build the habit' }, day_in_journey: 3, is_past_90_day: false },
    goal: null,
    community_signals: { diary_streak_days: 0, connection_count: 0, group_count: 0, pending_match_count: 0, memory_goals: [], memory_interests: [] },
    recent_activity: { open_autopilot_recs: 0, activated_recs_last_7d: 0, dismissed_recs_last_7d: 0, overdue_calendar_count: 0, upcoming_calendar_24h_count: 0 },
    last_interaction: null,
    feature_introductions: [],
    prior_session_themes: [],
    user_timezone: 'Europe/Berlin',
    sessions_today: { count: 0, entries: [] },
    last_session_yesterday: null,
    adaptation_plans: null,
    routines: [],
    tastes_preferences: null,
    ...overrides,
  } as unknown as UserAwareness;
}

function makeCandidate(overrides: Partial<OpenerCandidate> = {}): OpenerCandidate {
  return {
    nudge_key: 'nudge-1',
    kind: 'autopilot_recommendation',
    title: 'Try the new diary flow',
    reason: 'user has an open recommendation',
    ...overrides,
  };
}

function makeFoundationSignal(overrides: Partial<FoundationAwarenessSignal> = {}): FoundationAwarenessSignal {
  return {
    on_foundation: false,
    graduated: false,
    next_step_title: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Defaults that keep every code path fail-open unless a test overrides.
  mockEmitOasisEvent.mockResolvedValue(undefined);
  mockGetSupabase.mockReturnValue(null);
  mockGetSystemControl.mockResolvedValue(null);
  mockGetPersonalityConfigSync.mockReturnValue({});
  mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });
  mockGetAwarenessContext.mockResolvedValue(null);
  mockExecutePause.mockResolvedValue({ success: true, paused_until: '2026-07-29T00:00:00Z', scope: 'all' });
  mockExecuteClear.mockResolvedValue({ success: true, cleared_count: 1 });
  mockRecordFeatureIntroduction.mockResolvedValue({ success: true });
  mockEmitGuideTelemetry.mockResolvedValue(undefined);
  mockCanSurfaceProactively.mockResolvedValue({ allow: false });
  mockRecordTouch.mockResolvedValue(undefined);
  mockResolveNextTip.mockReturnValue(null);
  mockPickProactiveInitiative.mockResolvedValue(null);
  mockBuildJourneyConversationV2Block.mockResolvedValue('');
  mockBuildJourneyFoundationSnapshot.mockResolvedValue({ foundation_steps: [], graduated: false, current_next_step: null });
  mockGetGeminiToolDefinitions.mockReturnValue({ functionDeclarations: [] });
  mockGetUserTodayEvents.mockResolvedValue([]);
  mockGetUserUpcomingEvents.mockResolvedValue([]);
  mockGetCalendarGaps.mockResolvedValue([]);
});

// =============================================================================
// 1. processBrainTurn
// =============================================================================

describe('processBrainTurn', () => {
  const baseInput: BrainTurnInput = {
    channel: 'orb',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    role: 'community',
    message: 'hello there',
  };

  function convResult(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      reply: 'Hi!',
      thread_id: 'thread-1',
      turn_number: 1,
      context_pack: {
        memory_hits: [{ id: 'm1' }],
        knowledge_hits: [],
        web_hits: [],
        calendar_context: { events: [] },
      },
      tool_calls: [{ id: 't1', name: 'search_calendar', args: {}, result: 'ok', success: true, duration_ms: 5 }],
      meta: { channel: 'orb', model_used: 'gemini-2.5-pro', latency_ms: 123, tokens_used: { prompt: 10, completion: 20, total: 30 } },
      oasis_ref: 'oasis-ref-1',
      ...overrides,
    };
  }

  it('delegates to processConversationTurn with a mapped input and returns the wrapped success result', async () => {
    mockProcessConversationTurn.mockResolvedValue(convResult());

    const out = await processBrainTurn(baseInput);

    expect(mockProcessConversationTurn).toHaveBeenCalledTimes(1);
    const callArg = mockProcessConversationTurn.mock.calls[0][0];
    expect(callArg).toMatchObject({
      channel: 'orb',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      role: 'community',
      message: 'hello there',
    });

    expect(out.ok).toBe(true);
    expect(out.reply).toBe('Hi!');
    expect(out.thread_id).toBe('thread-1');
    expect(out.turn_number).toBe(1);
    expect(out.tool_calls).toHaveLength(1);
    expect(out.oasis_ref).toBe('oasis-ref-1');
    // brain-level meta fields are computed by vitana-brain itself, not
    // passed through verbatim from processConversationTurn.
    expect(out.meta.brain_version).toBe('1.0.0');
    expect(out.meta.model_used).toBe('gemini-2.5-pro');
    expect(typeof out.meta.latency_ms).toBe('number');
    expect(out.meta.tokens_used).toEqual({ prompt: 10, completion: 20, total: 30 });
  });

  it('emits a brain.turn.received event and a brain.turn.processed event with status=success on ok result', async () => {
    mockProcessConversationTurn.mockResolvedValue(convResult({ ok: true }));

    await processBrainTurn(baseInput);

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(2);
    const [receivedEvt, processedEvt] = mockEmitOasisEvent.mock.calls.map((c) => c[0]);
    expect(receivedEvt.type).toBe('brain.turn.received');
    expect(receivedEvt.status).toBe('info');
    expect(receivedEvt.payload.channel).toBe('orb');
    expect(receivedEvt.payload.role).toBe('community');
    expect(processedEvt.type).toBe('brain.turn.processed');
    expect(processedEvt.status).toBe('success');
    expect(processedEvt.payload.tool_calls_count).toBe(1);
    expect(processedEvt.payload.context_sources).toEqual({
      memory_hits: 1,
      knowledge_hits: 0,
      web_hits: 0,
      has_calendar: true,
    });
  });

  it('emits status=warning on the processed event when the conversation result is not ok (but does not throw)', async () => {
    mockProcessConversationTurn.mockResolvedValue(convResult({ ok: false, error: 'llm_failed' }));

    const out = await processBrainTurn(baseInput);

    expect(out.ok).toBe(false);
    expect(out.error).toBe('llm_failed');
    const processedEvt = mockEmitOasisEvent.mock.calls[1][0];
    expect(processedEvt.status).toBe('warning');
  });

  it('returns a graceful-degradation error result when processConversationTurn throws, and emits brain.turn.error', async () => {
    mockProcessConversationTurn.mockRejectedValue(new Error('downstream boom'));

    const out = await processBrainTurn({ ...baseInput, thread_id: 'existing-thread' });

    expect(out.ok).toBe(false);
    expect(out.error).toBe('downstream boom');
    expect(out.reply).toBe('');
    expect(out.turn_number).toBe(0);
    expect(out.tool_calls).toEqual([]);
    // thread_id falls back to the input's thread_id, not a fresh empty string.
    expect(out.thread_id).toBe('existing-thread');
    expect(out.meta.model_used).toBe('unknown');
    expect(out.meta.brain_version).toBe('1.0.0');

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(2);
    const errorEvt = mockEmitOasisEvent.mock.calls[1][0];
    expect(errorEvt.type).toBe('brain.turn.error');
    expect(errorEvt.status).toBe('error');
    expect(errorEvt.payload.error).toBe('downstream boom');
  });

  it('falls back to an empty thread_id on error when the input never supplied one', async () => {
    mockProcessConversationTurn.mockRejectedValue(new Error('boom'));

    const out = await processBrainTurn(baseInput); // no thread_id on baseInput

    expect(out.thread_id).toBe('');
  });

  it('never throws even when emitOasisEvent itself rejects (fire-and-forget telemetry)', async () => {
    mockProcessConversationTurn.mockResolvedValue(convResult());
    mockEmitOasisEvent.mockRejectedValue(new Error('oasis down'));

    await expect(processBrainTurn(baseInput)).resolves.toMatchObject({ ok: true });
  });
});

// =============================================================================
// 2. buildAwarenessBlock
// =============================================================================
// (Journey-foundation reconciliation branches are covered by
// vitana-brain-awareness-reconcile.test.ts — this describe block covers the
// remaining branches: null-awareness, last_interaction, goal, community
// signals, taste rule, recent activity, routines, prior sessions, sessions
// today with ordinal suffixes, and feature introductions.)

describe('buildAwarenessBlock', () => {
  it('returns an empty string when awareness is null', () => {
    expect(buildAwarenessBlock(null)).toBe('');
  });

  it('renders the tenure line with stage/days/registration date', () => {
    const out = buildAwarenessBlock(makeAwareness({ tenure: { stage: 'day7', days_since_signup: 9, active_usage_days: 5, registered_at: '2026-07-01T08:00:00Z' } }));
    expect(out).toContain('Tenure: day7 (registered 9 days ago, on 2026-07-01)');
  });

  it('renders "NEVER" for a first-ever ORB session (bucket=first)', () => {
    const out = buildAwarenessBlock(makeAwareness({ last_interaction: { bucket: 'first', time_ago: '', days_since_last: 0, motivation_signal: 'engaged', was_failure: false } as any }));
    expect(out).toContain('Last interaction: NEVER — this is their first ever ORB session.');
  });

  it('renders bucket/days/motivation for a non-first last_interaction, including the failure marker', () => {
    const out = buildAwarenessBlock(makeAwareness({
      last_interaction: { bucket: 'week', time_ago: '3 days ago', days_since_last: 3, motivation_signal: 'cooling', was_failure: true } as any,
    }));
    expect(out).toContain('Last interaction: 3 days ago (bucket=week, 3 days, motivation=cooling)');
    expect(out).toContain('[LAST SESSION FAILED — audio/connection]');
  });

  it('omits the failure marker when was_failure is false', () => {
    const out = buildAwarenessBlock(makeAwareness({
      last_interaction: { bucket: 'today', time_ago: '2 hours ago', days_since_last: 0, motivation_signal: 'engaged', was_failure: false } as any,
    }));
    expect(out).not.toContain('[LAST SESSION FAILED');
  });

  it('renders the system-seeded goal line distinctly from a user-chosen goal', () => {
    const seeded = buildAwarenessBlock(makeAwareness({ goal: { primary_goal: 'Improve sleep', category: 'health', is_system_seeded: true } }));
    expect(seeded).toContain('SYSTEM-SEEDED DEFAULT, you set this for them, they can change anytime');

    const chosen = buildAwarenessBlock(makeAwareness({ goal: { primary_goal: 'Improve sleep', category: 'health', is_system_seeded: false } }));
    expect(chosen).toContain('user-chosen');
    expect(chosen).not.toContain('SYSTEM-SEEDED');
  });

  it('invites the user to set a goal when none is active', () => {
    const out = buildAwarenessBlock(makeAwareness({ goal: null }));
    expect(out).toContain('Active Life Compass goal: NONE');
  });

  it('formats community signals with correct singular/plural and omits the line entirely when all signals are zero', () => {
    const zero = buildAwarenessBlock(makeAwareness());
    expect(zero).not.toContain('Community signals:');

    const singular = buildAwarenessBlock(makeAwareness({
      community_signals: { diary_streak_days: 5, connection_count: 1, group_count: 1, pending_match_count: 1, memory_goals: [], memory_interests: [] },
    }));
    expect(singular).toContain('5-day diary streak');
    expect(singular).toContain('1 connection;');
    expect(singular).toContain('1 group;');
    expect(singular).toContain('1 pending match');

    const plural = buildAwarenessBlock(makeAwareness({
      community_signals: { diary_streak_days: 0, connection_count: 2, group_count: 3, pending_match_count: 4, memory_goals: [], memory_interests: [] },
    }));
    expect(plural).toContain('2 connections');
    expect(plural).toContain('3 groups');
    expect(plural).toContain('4 pending matches');
  });

  it('applies the "match stated interests" taste rule when interests/goals are known, else the "discover" rule', () => {
    const withInterests = buildAwarenessBlock(makeAwareness({
      community_signals: { diary_streak_days: 0, connection_count: 0, group_count: 0, pending_match_count: 0, memory_goals: [], memory_interests: ['hiking'] },
    }));
    expect(withInterests).toContain("prefer items that align with the user's stated interests/goals");

    const withoutInterests = buildAwarenessBlock(makeAwareness());
    expect(withoutInterests).toContain("Don't guess");
  });

  it('formats recent_activity with singular/plural and is omitted entirely when all zero', () => {
    const zero = buildAwarenessBlock(makeAwareness());
    expect(zero).not.toContain('Recent activity:');

    const out = buildAwarenessBlock(makeAwareness({
      recent_activity: { open_autopilot_recs: 1, activated_recs_last_7d: 2, dismissed_recs_last_7d: 1, overdue_calendar_count: 1, upcoming_calendar_24h_count: 3 },
    }));
    expect(out).toContain('1 open autopilot recommendation;');
    expect(out).toContain('2 activated in last 7d;');
    expect(out).toContain('1 dismissed in last 7d (be gentle);');
    expect(out).toContain('1 overdue autopilot calendar event;');
    expect(out).toContain('3 upcoming in next 24h');
  });

  it('lists up to 4 known routines with confidence percentages and is omitted when empty', () => {
    const empty = buildAwarenessBlock(makeAwareness({ routines: [] }));
    expect(empty).not.toContain('Known routines');

    const routines = [1, 2, 3, 4, 5].map((n) => ({ routine_kind: `kind${n}`, title: `Routine ${n}`, summary: `Summary ${n}`, confidence: 0.5 }));
    const out = buildAwarenessBlock(makeAwareness({ routines }));
    expect(out).toContain('Routine 1: Summary 1 (confidence 50%)');
    expect(out).toContain('Routine 4: Summary 4 (confidence 50%)');
    expect(out).not.toContain('Routine 5:');
  });

  it('renders the most recent prior session with themes and dedupes older themes, and is omitted when empty', () => {
    const empty = buildAwarenessBlock(makeAwareness({ prior_session_themes: [] }));
    expect(empty).not.toContain('Last session (');

    const out = buildAwarenessBlock(makeAwareness({
      prior_session_themes: [
        { session_id: 's1', summary: 'Talked about sleep.', themes: ['sleep', 'sleep', 'diary'], ended_at: '2026-07-27T10:00:00Z' },
        { session_id: 's2', summary: 'Talked about work.', themes: ['work'], ended_at: '2026-07-20T10:00:00Z' },
      ],
    }));
    expect(out).toContain('Last session (2026-07-27) (themes: sleep, sleep, diary): Talked about sleep.');
    expect(out).toContain('Earlier sessions touched: work.');
  });

  it('omits the sessions-today block entirely when count is 0 and no yesterday session exists', () => {
    const out = buildAwarenessBlock(makeAwareness({ sessions_today: { count: 0, entries: [] } }));
    expect(out).not.toContain('Sessions today:');
    expect(out).not.toContain('this is the');
  });

  it('renders sessions_today with correct ordinal suffixes (2nd, 3rd, 11th)', () => {
    const two = buildAwarenessBlock(makeAwareness({
      sessions_today: { count: 1, entries: [{ session_id: 's1', channel: 'voice', summary: 'x', themes: [], ended_at: '2026-07-28T09:00:00Z' }] },
    }));
    expect(two).toContain('this is the 2nd');

    const three = buildAwarenessBlock(makeAwareness({
      sessions_today: {
        count: 2,
        entries: [
          { session_id: 's1', channel: 'voice', summary: 'x', themes: [], ended_at: '2026-07-28T09:00:00Z' },
          { session_id: 's2', channel: 'text', summary: 'y', themes: [], ended_at: '2026-07-28T10:00:00Z' },
        ],
      },
    }));
    expect(three).toContain('this is the 3rd');

    const eleven = buildAwarenessBlock(makeAwareness({
      sessions_today: {
        count: 10,
        entries: Array.from({ length: 10 }, (_, i) => ({ session_id: `s${i}`, channel: 'voice' as const, summary: `sess ${i}`, themes: [], ended_at: '2026-07-28T09:00:00Z' })),
      },
    }));
    expect(eleven).toContain('this is the 11th');
  });

  it('truncates a session summary longer than 240 chars with an ellipsis', () => {
    const longSummary = 'x'.repeat(300);
    const out = buildAwarenessBlock(makeAwareness({
      sessions_today: { count: 1, entries: [{ session_id: 's1', channel: 'voice', summary: longSummary, themes: [], ended_at: '2026-07-28T09:00:00Z' }] },
    }));
    expect(out).toContain('x'.repeat(239) + '…');
    expect(out).not.toContain(longSummary);
  });

  it('renders last_session_yesterday when present, and omits the whole sessions block when absent and count=0', () => {
    const withYesterday = buildAwarenessBlock(makeAwareness({
      last_session_yesterday: { session_id: 'y1', channel: 'text', summary: 'Talked about goals.', themes: ['goals'], ended_at: '2026-07-27T15:00:00Z' },
    }));
    expect(withYesterday).toContain("Yesterday's last session");
    expect(withYesterday).toContain('Talked about goals.');

    const without = buildAwarenessBlock(makeAwareness());
    expect(without).not.toContain("Yesterday's last session");
    expect(without).not.toContain('Sessions today:');
  });

  it('lists feature_introductions when present, and instructs the LLM to call record_feature_introduction when empty', () => {
    const withFeatures = buildAwarenessBlock(makeAwareness({ feature_introductions: ['life_compass', 'autopilot'] }));
    expect(withFeatures).toContain('DO NOT re-explain');
    expect(withFeatures).toContain('life_compass, autopilot');

    const noFeatures = buildAwarenessBlock(makeAwareness({ feature_introductions: [] }));
    expect(noFeatures).toContain('Features already introduced: NONE');
    expect(noFeatures).toContain('call the record_feature_introduction tool');
  });
});

// =============================================================================
// 3. buildLifeCompassGoalBlock
// =============================================================================

describe('buildLifeCompassGoalBlock', () => {
  it('returns an empty string when supabase is unavailable', async () => {
    mockGetSupabase.mockReturnValue(null);
    const out = await buildLifeCompassGoalBlock({ user_id: 'u1' });
    expect(out).toBe('');
  });

  function chain(finalResult: { data: unknown }) {
    const c: any = {};
    c.from = jest.fn(() => c);
    c.select = jest.fn(() => c);
    c.eq = jest.fn(() => c);
    c.order = jest.fn(() => c);
    c.limit = jest.fn(() => Promise.resolve(finalResult));
    return c;
  }

  it('invites the user to pick a goal when no active life_compass row exists', async () => {
    mockGetSupabase.mockReturnValue(chain({ data: [] }));
    const out = await buildLifeCompassGoalBlock({ user_id: 'u1' });
    expect(out).toContain('NOT SET');
    expect(out).toContain('open my goals');
  });

  it('returns a goal-bound directive block when an active goal exists', async () => {
    const c = chain({ data: [{ primary_goal: 'Extend healthspan', category: 'longevity' }] });
    mockGetSupabase.mockReturnValue(c);

    const out = await buildLifeCompassGoalBlock({ user_id: 'u1' });

    expect(out).toContain('Primary goal: "Extend healthspan"');
    expect(out).toContain('Category: longevity');
    expect(out).toContain('NON-NEGOTIABLE');
    expect(c.eq).toHaveBeenCalledWith('user_id', 'u1');
    expect(c.eq).toHaveBeenCalledWith('is_active', true);
  });

  it('fails open to an empty string when the query throws', async () => {
    const c: any = { from: jest.fn(() => { throw new Error('db down'); }) };
    mockGetSupabase.mockReturnValue(c);

    const out = await buildLifeCompassGoalBlock({ user_id: 'u1' });
    expect(out).toBe('');
  });
});

// =============================================================================
// 4. buildProactiveGuideBlock
// =============================================================================

describe('buildProactiveGuideBlock', () => {
  const baseInput = { user_id: 'u1', tenant_id: 't1', role: 'community', channel: 'orb' as const };

  it('returns empty when the proactive-opener flag is off', async () => {
    mockGetSystemControl.mockResolvedValue({ key: 'vitana_proactive_opener_enabled', enabled: false });
    const out = await buildProactiveGuideBlock(baseInput);
    expect(out).toBe('');
    expect(mockGetAwarenessContext).not.toHaveBeenCalled();
  });

  it('returns empty for the flag lookup rejecting (fail-closed, not fail-open)', async () => {
    mockGetSystemControl.mockRejectedValue(new Error('control lookup failed'));
    const out = await buildProactiveGuideBlock(baseInput);
    expect(out).toBe('');
  });

  it('returns empty for a non-community role (developer/admin) even when the flag is on — VTID-03183', async () => {
    mockGetSystemControl.mockResolvedValue({ key: 'vitana_proactive_opener_enabled', enabled: true });
    const outDev = await buildProactiveGuideBlock({ ...baseInput, role: 'developer' });
    expect(outDev).toBe('');
    const outAdmin = await buildProactiveGuideBlock({ ...baseInput, role: 'admin' });
    expect(outAdmin).toBe('');
    expect(mockGetAwarenessContext).not.toHaveBeenCalled();
  });

  describe('when enabled for a community role', () => {
    beforeEach(() => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        // journey_conversation_v2 and did_you_know / initiative flags default off
        return Promise.resolve({ key, enabled: false });
      });
    });

    it('always includes the awareness + PROACTIVE GUIDE RULES block, even with no candidate and no awareness', async () => {
      mockGetAwarenessContext.mockResolvedValue(null);
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('PROACTIVE GUIDE RULES');
      expect(out).toContain('OPENING SHAPE MATRIX');
      expect(mockEmitGuideTelemetry).toHaveBeenCalledWith('guide.opener.no_candidate', expect.objectContaining({ user_id: 'u1' }));
    });

    it('emits guide.opener.suppressed_by_pause telemetry when the pause suppressed a candidate', async () => {
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: true });

      await buildProactiveGuideBlock(baseInput);

      expect(mockEmitGuideTelemetry).toHaveBeenCalledWith('guide.opener.suppressed_by_pause', expect.objectContaining({ user_id: 'u1' }));
    });

    it('builds the PROACTIVE OPENER CANDIDATE block with tenure/last-interaction/mode banners and the goal line, and emits guide.opener.shown', async () => {
      const awareness = makeAwareness({ tenure: { stage: 'day0', days_since_signup: 0, active_usage_days: 0, registered_at: '2026-07-28T08:00:00Z' } });
      mockGetAwarenessContext.mockResolvedValue(awareness);
      mockPickOpenerCandidate.mockResolvedValue({
        candidate: makeCandidate({ goal_link: { primary_goal: 'Extend healthspan', category: 'longevity', is_system_seeded: false } }),
        suppressed_by_pause: false,
      });

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('PROACTIVE OPENER CANDIDATE');
      expect(out).toContain('ACTIVE TENURE STAGE: day0');
      expect(out).toContain('INTRODUCTION MODE: ON');
      expect(out).toContain('Toward the user\'s active Life Compass goal: "Extend healthspan"');
      expect(mockEmitGuideTelemetry).toHaveBeenCalledWith('guide.opener.shown', expect.objectContaining({ nudge_key: 'nudge-1' }));
    });

    it('renders a system-seeded goal_link with the agency-offer framing, distinct from a user-chosen one', async () => {
      mockGetAwarenessContext.mockResolvedValue(makeAwareness({ tenure: { stage: 'day7', days_since_signup: 8, active_usage_days: 4, registered_at: '2026-07-20T08:00:00Z' } }));
      mockPickOpenerCandidate.mockResolvedValue({
        candidate: makeCandidate({ goal_link: { primary_goal: 'Extend healthspan', category: 'longevity', is_system_seeded: true } }),
        suppressed_by_pause: false,
      });

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('SYSTEM-SEEDED DEFAULT');
      expect(out).toContain('INTRODUCTION MODE: OFF');
    });

    it('falls back to a null-awareness banner when getAwarenessContext fails', async () => {
      mockGetAwarenessContext.mockRejectedValue(new Error('awareness fetch failed'));
      mockPickOpenerCandidate.mockResolvedValue({ candidate: makeCandidate(), suppressed_by_pause: false });

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('ACTIVE TENURE STAGE: unknown');
      expect(out).toContain('LAST INTERACTION: none — first ORB session');
    });

    it('uses the Journey Conversation V2 arbiter block and skips the legacy candidate block when the V2 flag is on and it builds successfully', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_journey_conversation_v2_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: makeCandidate(), suppressed_by_pause: false });
      mockBuildJourneyConversationV2Block.mockResolvedValue('=== V2 ARBITER BLOCK ===');

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('=== V2 ARBITER BLOCK ===');
      expect(out).not.toContain('PROACTIVE OPENER CANDIDATE');
      expect(mockBuildJourneyConversationV2Block).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1', channel: 'voice' }));
    });

    it('falls back to the legacy candidate path when the V2 flag is on but the block builder returns empty', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_journey_conversation_v2_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: makeCandidate(), suppressed_by_pause: false });
      mockBuildJourneyConversationV2Block.mockResolvedValue('');

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('PROACTIVE OPENER CANDIDATE');
    });

    it('does not attempt V2 at all when awareness is null (V2 requires awareness)', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_journey_conversation_v2_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(null);

      await buildProactiveGuideBlock(baseInput);

      expect(mockBuildJourneyConversationV2Block).not.toHaveBeenCalled();
    });

    it('mutual exclusion: when the proactive initiative fires, the Did-You-Know tour hint is suppressed', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_proactive_initiative_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_did_you_know_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });
      mockCanSurfaceProactively.mockResolvedValue({ allow: true });
      const initiative = {
        initiative_key: 'morning_diary_capture',
        pillar_link: 'Mental',
        on_yes_tool: 'save_diary_entry',
        on_yes_payload_hint: 'capture the dictated content',
        requires_user_dictation: true,
        voice_confirm: 'Want to dictate it to me?',
        voice_on_consent: 'Great — go ahead.',
        build_voice_on_complete: () => 'Nice work — that is logged.',
      };
      mockPickProactiveInitiative.mockResolvedValue({
        initiative,
        target: null,
        voice_opener: 'Did you journal today?',
      });
      mockResolveNextTip.mockReturnValue({
        tip_key: 'tip-1',
        feature_key: 'life_compass',
        index_pillar_link: 'meta',
        voice_opener: 'Did you know you can set a goal?',
        voice_confirm: 'Want me to show you?',
        voice_on_nav: 'Here it is.',
        cta_url: '/goals',
      });

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('PROACTIVE INITIATIVE OFFER');
      expect(out).toContain('Did you journal today?');
      expect(out).not.toContain('DID-YOU-KNOW TOUR HINT');
      // Tour resolution short-circuits before resolveNextTip is even reached
      // because the tour hint builder is skipped entirely when initiative fires.
      expect(mockResolveNextTip).not.toHaveBeenCalled();
    });

    it('offers the Did-You-Know tour hint when no initiative fires and the tour flag/pacer/tip all allow it', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_did_you_know_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });
      mockPickProactiveInitiative.mockResolvedValue(null);
      mockCanSurfaceProactively.mockResolvedValue({ allow: true });
      mockResolveNextTip.mockReturnValue({
        tip_key: 'tip-1',
        feature_key: 'life_compass',
        index_pillar_link: 'meta',
        voice_opener: 'Did you know you can set a goal?',
        voice_confirm: 'Want me to show you?',
        voice_on_nav: 'Here it is.',
        cta_url: '/goals',
      });

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).toContain('DID-YOU-KNOW TOUR HINT');
      expect(out).toContain('Did you know you can set a goal?');
      expect(mockRecordTouch).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1', surface: 'voice_opener_tour' }));
      expect(mockEmitGuideTelemetry).toHaveBeenCalledWith('guide.did_you_know.offered', expect.objectContaining({ tip_key: 'tip-1' }));
    });

    it('does not offer the tour hint on the text channel (voice-only surface)', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_did_you_know_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });
      mockResolveNextTip.mockReturnValue({
        tip_key: 'tip-1', feature_key: 'life_compass', index_pillar_link: 'meta',
        voice_opener: 'x', voice_confirm: 'y', voice_on_nav: 'z', cta_url: '/goals',
      });
      mockCanSurfaceProactively.mockResolvedValue({ allow: true });

      const out = await buildProactiveGuideBlock({ ...baseInput, channel: 'operator' });

      expect(out).not.toContain('DID-YOU-KNOW TOUR HINT');
      expect(mockCanSurfaceProactively).not.toHaveBeenCalled();
    });

    it('does not offer the tour hint when the pacer disallows it', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_did_you_know_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });
      mockCanSurfaceProactively.mockResolvedValue({ allow: false });

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).not.toContain('DID-YOU-KNOW TOUR HINT');
      expect(mockResolveNextTip).not.toHaveBeenCalled();
    });

    it('does not offer the tour hint when the curriculum has no tip to resolve', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_did_you_know_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });
      mockCanSurfaceProactively.mockResolvedValue({ allow: true });
      mockResolveNextTip.mockReturnValue(null);

      const out = await buildProactiveGuideBlock(baseInput);

      expect(out).not.toContain('DID-YOU-KNOW TOUR HINT');
    });

    it('does not offer the initiative on the text channel', async () => {
      mockGetSystemControl.mockImplementation((key: string) => {
        if (key === 'vitana_proactive_opener_enabled') return Promise.resolve({ key, enabled: true });
        if (key === 'vitana_proactive_initiative_enabled') return Promise.resolve({ key, enabled: true });
        return Promise.resolve({ key, enabled: false });
      });
      mockGetAwarenessContext.mockResolvedValue(makeAwareness());
      mockPickOpenerCandidate.mockResolvedValue({ candidate: null, suppressed_by_pause: false });

      const out = await buildProactiveGuideBlock({ ...baseInput, channel: 'operator' });

      expect(out).not.toContain('PROACTIVE INITIATIVE OFFER');
      expect(mockPickProactiveInitiative).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// 5. buildBrainToolDefinitions
// =============================================================================

describe('buildBrainToolDefinitions', () => {
  it('merges the role-gated registry tools with the ORB-specific brain tools', () => {
    mockGetGeminiToolDefinitions.mockReturnValue({
      functionDeclarations: [
        { name: 'get_user_profile', description: 'x', parameters: {} },
        { name: 'search_knowledge', description: 'y', parameters: {} },
      ],
    });

    const tools = buildBrainToolDefinitions('community') as Array<{ name: string }>;
    const names = tools.map((t) => t.name);

    expect(mockGetGeminiToolDefinitions).toHaveBeenCalledWith('community');
    expect(names).toEqual(
      expect.arrayContaining([
        'get_user_profile',
        'search_knowledge',
        'search_calendar',
        'pause_proactive_guidance',
        'clear_proactive_pauses',
        'record_feature_introduction',
      ]),
    );
    expect(tools).toHaveLength(6);
  });

  it('does not duplicate a tool that already exists in the registry under the same name', () => {
    mockGetGeminiToolDefinitions.mockReturnValue({
      functionDeclarations: [{ name: 'search_calendar', description: 'registry version', parameters: {} }],
    });

    const tools = buildBrainToolDefinitions('community') as Array<{ name: string; description: string }>;
    const searchCalendarTools = tools.filter((t) => t.name === 'search_calendar');

    expect(searchCalendarTools).toHaveLength(1);
    expect(searchCalendarTools[0].description).toBe('registry version');
  });
});

// =============================================================================
// 6. executeBrainTool
// =============================================================================

describe('executeBrainTool', () => {
  const ctx = { user_id: 'u1', tenant_id: 't1', role: 'community', user_timezone: 'Europe/Berlin' };

  describe('search_calendar', () => {
    it('reports "no events scheduled" when there is nothing today/upcoming/no gaps', async () => {
      mockGetUserTodayEvents.mockResolvedValue([]);
      mockGetUserUpcomingEvents.mockResolvedValue([]);
      mockGetCalendarGaps.mockResolvedValue([]);

      const out = await executeBrainTool('search_calendar', { query: 'today' }, ctx);

      expect(out.success).toBe(true);
      expect(out.result).toContain("Today's schedule: No events scheduled.");
      expect(out.result).not.toContain('Upcoming');
      expect(out.result).not.toContain('Free time today');
    });

    it('formats today, upcoming, and gap sections when data is present', async () => {
      mockGetUserTodayEvents.mockResolvedValue([
        { title: 'Doctor visit', event_type: 'health', start_time: '2026-07-28T14:00:00Z' },
      ]);
      mockGetUserUpcomingEvents.mockResolvedValue([
        { title: 'Business call', event_type: 'business', start_time: '2026-07-30T09:00:00Z' },
      ]);
      mockGetCalendarGaps.mockResolvedValue([{ start: '2026-07-28T10:00:00Z', end: '2026-07-28T12:00:00Z', duration_minutes: 120 }]);

      const out = await executeBrainTool('search_calendar', { query: 'today' }, ctx);

      expect(out.success).toBe(true);
      expect(out.result).toContain("Today's schedule");
      expect(out.result).toContain('Doctor visit (health)');
      expect(out.result).toContain('Upcoming (next 7 days');
      expect(out.result).toContain('Business call');
      expect(out.result).toContain('Free time today');
      expect(out.result).toContain('120 min free');
      expect(mockGetUserTodayEvents).toHaveBeenCalledWith('u1', 'community');
    });

    it('falls back to UTC when no user_timezone is supplied', async () => {
      mockGetUserTodayEvents.mockResolvedValue([
        { title: 'Doctor visit', event_type: 'health', start_time: '2026-07-28T14:00:00Z' },
      ]);
      const out = await executeBrainTool('search_calendar', {}, { user_id: 'u1', tenant_id: 't1', role: 'community' });
      expect(out.result).toContain('times in UTC');
    });
  });

  describe('pause_proactive_guidance', () => {
    it('returns a success message with the paused-until timestamp', async () => {
      mockExecutePause.mockResolvedValue({ success: true, paused_until: '2026-07-29T12:00:00.000Z', scope: 'nudge_key', scope_value: 'nudge-1' });

      const out = await executeBrainTool('pause_proactive_guidance', { scope: 'nudge_key', scope_value: 'nudge-1', duration_minutes: 1440 }, ctx);

      expect(out.success).toBe(true);
      expect(out.result).toContain('scope=nudge_key:nudge-1');
      expect(out.result).toContain('2026-07-29T12:00:00.000Z');
      expect(mockExecutePause).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'nudge_key', scope_value: 'nudge-1', duration_minutes: 1440 }),
        { user_id: 'u1', channel: 'voice' },
      );
    });

    it('defaults scope to "all" when omitted', async () => {
      await executeBrainTool('pause_proactive_guidance', {}, ctx);
      expect(mockExecutePause).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all' }), expect.anything());
    });

    it('surfaces a failure without throwing', async () => {
      mockExecutePause.mockResolvedValue({ success: false, error: 'scope_value_required' });

      const out = await executeBrainTool('pause_proactive_guidance', { scope: 'nudge_key' }, ctx);

      expect(out.success).toBe(false);
      expect(out.error).toBe('scope_value_required');
      expect(out.result).toContain('pause failed');
    });
  });

  describe('clear_proactive_pauses', () => {
    it('reports the number of cleared pauses, with correct pluralization', async () => {
      mockExecuteClear.mockResolvedValue({ success: true, cleared_count: 3 });
      const out = await executeBrainTool('clear_proactive_pauses', {}, ctx);
      expect(out.success).toBe(true);
      expect(out.result).toBe('Cleared 3 active pauses.');
    });

    it('uses singular phrasing for exactly one cleared pause', async () => {
      mockExecuteClear.mockResolvedValue({ success: true, cleared_count: 1 });
      const out = await executeBrainTool('clear_proactive_pauses', {}, ctx);
      expect(out.result).toBe('Cleared 1 active pause.');
    });

    it('surfaces a failure without throwing', async () => {
      mockExecuteClear.mockResolvedValue({ success: false, error: 'db_error' });
      const out = await executeBrainTool('clear_proactive_pauses', {}, ctx);
      expect(out.success).toBe(false);
      expect(out.error).toBe('db_error');
    });
  });

  describe('record_feature_introduction', () => {
    it('rejects a missing feature_key without calling the underlying service', async () => {
      const out = await executeBrainTool('record_feature_introduction', {}, ctx);
      expect(out.success).toBe(false);
      expect(out.error).toBe('missing_feature_key');
      expect(mockRecordFeatureIntroduction).not.toHaveBeenCalled();
    });

    it('records the introduction and reports success', async () => {
      mockRecordFeatureIntroduction.mockResolvedValue({ success: true });
      const out = await executeBrainTool('record_feature_introduction', { feature_key: 'life_compass' }, ctx);
      expect(out.success).toBe(true);
      expect(out.result).toContain('life_compass');
      expect(mockRecordFeatureIntroduction).toHaveBeenCalledWith('u1', 'life_compass', 'voice');
    });

    it('surfaces a failure without throwing', async () => {
      mockRecordFeatureIntroduction.mockResolvedValue({ success: false, error: 'write_failed' });
      const out = await executeBrainTool('record_feature_introduction', { feature_key: 'life_compass' }, ctx);
      expect(out.success).toBe(false);
      expect(out.error).toBe('write_failed');
    });
  });

  it('returns an unhandled_tool error for a tool the brain executor does not own', async () => {
    const out = await executeBrainTool('some_other_tool', {}, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toBe('unhandled_tool:some_other_tool');
  });

  it('catches a thrown error from a tool handler and returns success:false instead of rejecting', async () => {
    mockGetUserTodayEvents.mockRejectedValue(new Error('calendar service down'));

    const out = await executeBrainTool('search_calendar', {}, ctx);

    expect(out.success).toBe(false);
    expect(out.error).toBe('calendar service down');
    expect(out.result).toContain('Tool execution failed');
  });
});
