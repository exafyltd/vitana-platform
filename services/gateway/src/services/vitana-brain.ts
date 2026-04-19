/**
 * VITANA BRAIN — Unified Intelligence Service
 *
 * Single entry point for all Vitana conversation surfaces.
 * Wraps processConversationTurn() from conversation-client.ts
 * and extends it with:
 *   - Unified context (memory + calendar + OASIS, role-gated)
 *   - Unified tool execution (all tools in one registry)
 *   - OASIS telemetry (every brain decision logged)
 *
 * SAFETY: This service is gated by feature flags:
 *   - vitana_brain_enabled      → text chat, conversation, assistant
 *   - vitana_brain_orb_enabled  → ORB voice (separate, higher risk)
 *
 * When flags are OFF, all surfaces use their legacy paths unchanged.
 * When flags are ON, surfaces route through processBrainTurn().
 *
 * Phase 1: Brain wraps processConversationTurn (no old code modified)
 * Phase 2+: Surfaces add if/else flag checks to route here
 */

import { randomUUID } from 'crypto';
import {
  processConversationTurn,
  ProcessConversationTurnInput,
  ProcessConversationTurnResult,
} from './conversation-client';
import {
  buildContextPack,
  formatContextPackForLLM,
  BuildContextPackInput,
  extractLanguageFromContextPack,
  buildLanguageDirective,
} from './context-pack-builder';
import { computeRetrievalRouterDecision } from './retrieval-router';
import { ContextLens, createContextLens } from '../types/context-lens';
import { ConversationChannel, ContextPack } from '../types/conversation';
import { getPersonalityConfigSync } from './ai-personality-service';
import { emitOasisEvent } from './oasis-event-service';
// Proactive Guide Phase 0.5
import { getSystemControl } from './system-controls-service';
import {
  pickOpenerCandidate,
  PAUSE_PROACTIVE_GUIDANCE_TOOL,
  CLEAR_PROACTIVE_PAUSES_TOOL,
  executePauseProactiveGuidance,
  executeClearProactivePauses,
  emitGuideTelemetry,
  type OpenerCandidate,
} from './guide';

// =============================================================================
// Types
// =============================================================================

export interface BrainTurnInput {
  /** Which surface is calling */
  channel: ConversationChannel;

  /** User identity */
  tenant_id: string;
  user_id: string;
  role: string;

  /** The user's message */
  message: string;
  message_type?: 'text' | 'voice_transcript';

  /** Thread continuity */
  thread_id?: string;

  /** UI context (optional) */
  ui_context?: {
    surface: ConversationChannel;
    screen?: string;
    selection?: string;
    metadata?: Record<string, unknown>;
  };

  /** VTID link (optional) */
  vtid?: string;

  /** Display name (optional) */
  display_name?: string;

  /** Conversation history (optional) */
  conversation_history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

export interface BrainTurnOutput {
  ok: boolean;
  reply: string;
  thread_id: string;
  turn_number: number;
  context_pack?: ContextPack;
  tool_calls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    success: boolean;
    duration_ms: number;
  }>;
  meta: {
    channel: ConversationChannel;
    model_used: string;
    latency_ms: number;
    brain_version: string;
    tokens_used?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };
  oasis_ref: string;
  error?: string;
}

const BRAIN_VERSION = '1.0.0';
const LOG_PREFIX = '[VITANA-BRAIN]';

// =============================================================================
// Main Brain Entry Point
// =============================================================================

/**
 * Process a conversation turn through the unified Vitana Brain.
 *
 * Currently wraps processConversationTurn() and adds:
 *   - Brain-specific telemetry (OASIS events)
 *   - Brain version tracking
 *   - Unified error handling with graceful degradation
 *
 * Future phases will add:
 *   - OASIS context injection (role-gated)
 *   - Unified tool registry (ORB + Operator + Dev tools merged)
 *   - Brain-level caching
 */
export async function processBrainTurn(
  input: BrainTurnInput,
): Promise<BrainTurnOutput> {
  const requestId = randomUUID();
  const startTime = Date.now();

  console.log(`${LOG_PREFIX} Processing turn ${requestId} via ${input.channel} for role=${input.role}`);

  try {
    // Emit brain turn start
    emitOasisEvent({
      vtid: 'VITANA-BRAIN',
      type: 'brain.turn.received',
      source: `brain-${input.channel}`,
      status: 'info',
      message: `Brain turn received: ${input.message.substring(0, 50)}...`,
      payload: {
        request_id: requestId,
        channel: input.channel,
        role: input.role,
        user_id: input.user_id,
        brain_version: BRAIN_VERSION,
        message_length: input.message.length,
      },
    }).catch(() => {});

    // Delegate to the existing unified conversation layer
    // This already calls: buildContextPack → retrieval router → LLM → tools → memory write
    const convInput: ProcessConversationTurnInput = {
      channel: input.channel,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      role: input.role,
      message: input.message,
      message_type: input.message_type,
      thread_id: input.thread_id,
      ui_context: input.ui_context,
      vtid: input.vtid,
      display_name: input.display_name,
      conversation_history: input.conversation_history,
    };

    const result: ProcessConversationTurnResult = await processConversationTurn(convInput);

    const latencyMs = Date.now() - startTime;

    // Emit brain turn completed
    emitOasisEvent({
      vtid: 'VITANA-BRAIN',
      type: 'brain.turn.processed',
      source: `brain-${input.channel}`,
      status: result.ok ? 'success' : 'warning',
      message: `Brain turn completed in ${latencyMs}ms`,
      payload: {
        request_id: requestId,
        channel: input.channel,
        role: input.role,
        brain_version: BRAIN_VERSION,
        latency_ms: latencyMs,
        model_used: result.meta.model_used,
        tool_calls_count: result.tool_calls.length,
        reply_length: result.reply?.length || 0,
        context_sources: {
          memory_hits: result.context_pack?.memory_hits?.length || 0,
          knowledge_hits: result.context_pack?.knowledge_hits?.length || 0,
          web_hits: result.context_pack?.web_hits?.length || 0,
          has_calendar: !!result.context_pack?.calendar_context,
        },
      },
    }).catch(() => {});

    console.log(`${LOG_PREFIX} Turn ${requestId} completed in ${latencyMs}ms (${result.ok ? 'ok' : 'error'})`);

    return {
      ok: result.ok,
      reply: result.reply,
      thread_id: result.thread_id,
      turn_number: result.turn_number,
      context_pack: result.context_pack,
      tool_calls: result.tool_calls,
      meta: {
        channel: result.meta.channel,
        model_used: result.meta.model_used,
        latency_ms: latencyMs,
        brain_version: BRAIN_VERSION,
        tokens_used: result.meta.tokens_used,
      },
      oasis_ref: result.oasis_ref,
      error: result.error,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;

    console.error(`${LOG_PREFIX} Turn ${requestId} failed after ${latencyMs}ms:`, err.message);

    // Emit brain turn error
    emitOasisEvent({
      vtid: 'VITANA-BRAIN',
      type: 'brain.turn.error',
      source: `brain-${input.channel}`,
      status: 'error',
      message: `Brain turn failed: ${err.message}`,
      payload: {
        request_id: requestId,
        channel: input.channel,
        role: input.role,
        brain_version: BRAIN_VERSION,
        latency_ms: latencyMs,
        error: err.message,
        stack: err.stack?.substring(0, 500),
      },
    }).catch(() => {});

    return {
      ok: false,
      reply: '',
      thread_id: input.thread_id || '',
      turn_number: 0,
      tool_calls: [],
      meta: {
        channel: input.channel,
        model_used: 'unknown',
        latency_ms: latencyMs,
        brain_version: BRAIN_VERSION,
      },
      oasis_ref: requestId,
      error: err.message,
    };
  }
}

// =============================================================================
// Brain System Instruction Builder (for ORB Voice — Phase 3)
// =============================================================================

/**
 * Build a complete system instruction using the Brain's context pipeline.
 * Used by ORB voice (Phase 3) to replace inline prompt builders.
 *
 * Calls buildContextPack → formatContextPackForLLM → personality config
 * to produce a single system instruction string.
 */
export async function buildBrainSystemInstruction(input: {
  user_id: string;
  tenant_id: string;
  role: string;
  channel: ConversationChannel;
  thread_id?: string;
  turn_number?: number;
  conversation_start?: string;
  display_name?: string;
  user_timezone?: string;
}): Promise<{ instruction: string; contextPack: ContextPack }> {
  const startTime = Date.now();

  // Create context lens
  const lens: ContextLens = createContextLens(input.tenant_id, input.user_id, {
    workspace_scope: 'product',
    active_role: input.role,
  });

  // Compute retrieval router — for session bootstrap, force memory-only
  // to minimize latency. Skip knowledge_hub and web_search (not needed
  // for greeting). Calendar + OASIS are fetched separately by buildContextPack.
  const routerDecision = computeRetrievalRouterDecision('general conversation context', {
    channel: input.channel,
    force_sources: ['memory_garden'],
    limit_overrides: {
      memory_garden: 8,
      knowledge_hub: 0,
      web_search: 0,
    },
  });

  // Build context pack — memory + calendar + OASIS (no knowledge/web for speed)
  const contextPackInput: BuildContextPackInput = {
    lens,
    query: 'general conversation context',
    channel: input.channel,
    thread_id: input.thread_id || randomUUID(),
    turn_number: input.turn_number || 0,
    conversation_start: input.conversation_start || new Date().toISOString(),
    role: input.role,
    display_name: input.display_name,
    router_decision: routerDecision,
  };

  const contextPack = await buildContextPack(contextPackInput);
  const contextForLLM = formatContextPackForLLM(contextPack, { userTimezone: input.user_timezone });

  // Build personality-driven instruction
  const preferredLanguage = extractLanguageFromContextPack(contextPack);
  const languageDirective = buildLanguageDirective(preferredLanguage);

  const ucConfig = getPersonalityConfigSync('unified_conversation') as Record<string, any>;
  const baseInstruction = input.channel === 'orb'
    ? (ucConfig.orb_instruction || 'You are Vitana, an intelligent voice assistant. Keep responses concise and conversational for voice interaction.')
    : (ucConfig.operator_instruction || 'You are Vitana, an intelligent assistant. You can be detailed and use formatting when helpful.');

  // -------------------------------------------------------------------------
  // Proactive Guide Phase 0.5 — opener + dismissal honor rules
  // Gated on `vitana_proactive_opener_enabled` (default FALSE).
  // Always appends the Silent Honor Rules when guide is on so the LLM knows
  // it has the dismissal tools and how to behave when called.
  // -------------------------------------------------------------------------
  const proactiveGuideBlock = await buildProactiveGuideBlock({
    user_id: input.user_id,
    role: input.role,
    channel: input.channel,
  });

  // PROMPT ORDER MATTERS: the proactive guide block goes LAST so it has
  // recency primacy in Gemini's attention. Putting it before the brevity
  // rule caused Gemini to default to "What can I do for you?" on the first
  // utterance because the brevity rule reinforced its trained habit.
  const instruction = `${baseInstruction}
${languageDirective}
${contextForLLM}

Current conversation channel: ${input.channel}
User's role: ${input.role}

General instructions (DEFAULT — overridden by Proactive Guide Rules below):
${ucConfig.common_instructions || '- Use the memory context to personalize responses\n- Use knowledge context for Vitana-specific questions\n- Be helpful and accurate'}
- ${input.channel === 'orb' ? (ucConfig.instructions_orb || 'Keep responses brief and natural for voice') : (ucConfig.instructions_operator || 'You can use markdown formatting and be more detailed')}
${proactiveGuideBlock}`;

  const latencyMs = Date.now() - startTime;
  console.log(`${LOG_PREFIX} System instruction built in ${latencyMs}ms (${instruction.length} chars, ${contextPack.memory_hits?.length || 0} memory hits, calendar=${!!contextPack.calendar_context}, guide=${proactiveGuideBlock.length > 0 ? 'on' : 'off'})`);

  return { instruction, contextPack };
}

// =============================================================================
// Proactive Guide system-prompt block (Phase 0.5)
// =============================================================================

/**
 * Map an arbitrary role string to the three Guide roles.
 * Defaults to 'community' for anything unrecognized.
 */
function mapRoleForGuide(role: string): 'community' | 'developer' | 'admin' {
  const r = (role || '').toLowerCase();
  if (r === 'developer' || r === 'dev') return 'developer';
  if (r === 'admin' || r === 'super_admin' || r === 'superadmin') return 'admin';
  return 'community';
}

/**
 * Build the Proactive Guide block to append to the system instruction.
 * Returns empty string when guide is disabled, so callers can concatenate freely.
 */
export async function buildProactiveGuideBlock(input: {
  user_id: string;
  role: string;
  channel: ConversationChannel;
}): Promise<string> {
  const flag = await getSystemControl('vitana_proactive_opener_enabled').catch(() => null);
  if (!flag || !flag.enabled) {
    return '';
  }

  const channel: 'voice' | 'text' = input.channel === 'orb' ? 'voice' : 'text';
  const guideRole = mapRoleForGuide(input.role);

  // Best-effort opener fetch — never block instruction build on this.
  let candidate: OpenerCandidate | null = null;
  let suppressedByPause = false;
  try {
    const sel = await pickOpenerCandidate({
      user_id: input.user_id,
      active_role: guideRole,
      channel,
    });
    candidate = sel.candidate;
    suppressedByPause = sel.suppressed_by_pause;
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} pickOpenerCandidate failed:`, err?.message);
  }

  // Telemetry — fire-and-forget
  if (candidate) {
    emitGuideTelemetry('guide.opener.shown', {
      user_id: input.user_id,
      channel,
      role: guideRole,
      nudge_key: candidate.nudge_key,
      kind: candidate.kind,
      goal: candidate.goal_link?.primary_goal ?? null,
    }).catch(() => {});
  } else if (suppressedByPause) {
    emitGuideTelemetry('guide.opener.suppressed_by_pause', {
      user_id: input.user_id,
      channel,
      role: guideRole,
    }).catch(() => {});
  } else {
    emitGuideTelemetry('guide.opener.no_candidate', {
      user_id: input.user_id,
      channel,
      role: guideRole,
    }).catch(() => {});
  }

  const introductionMode = !!candidate?.goal_link?.is_system_seeded;

  // Always include the rules — even with no candidate today, the LLM still
  // needs to know how to honor dismissals if the user volunteers one.
  const rulesBlock = `
=== PROACTIVE GUIDE RULES (HIGHEST PRIORITY — OVERRIDES "brief / concise" RULE ABOVE) ===

These rules override anything above about being concise or brief. The
brevity guidance is the DEFAULT. Proactive opening + introduction +
goal-setting conversations are EXCEPTIONS where you must elaborate,
introduce, and present — not be terse.

Vitanaland is a longevity platform — its mission is to help people improve
quality of life and extend lifespan. You are not a passive assistant. You
are the proactive guide. You lead — you do not wait to be asked.

ABSOLUTE FORBIDDEN OPENINGS — NEVER say any of these as your first
utterance of a session, in any language, in any phrasing:
- "What can I do for you?"
- "How can I help you today?"
- "How may I assist you?"
- "Good morning. How are you?" (alone, with no follow-up content)
- Any variation that ends by asking the user what they want
- Any short greeting that closes without offering direction

Those are passive — they ask the user what to do. The user — especially a
new user — DOES NOT KNOW what you can do for them. It is YOUR job to lead.

WHEN TO OPEN PROACTIVELY:
- New conversation thread → ALWAYS open with the candidate below.
- User silent > 6h → same.
- Maximum 1 unsolicited suggestion per turn.
- Frame every nudge through the user's active Life Compass goal.
- Tone: warm, inspirational, educational — never pushy.

OPENING SHAPE (REGULAR MODE — when introduction mode is OFF):
- 2–4 sentences total
- Brief by-name greeting (optional)
- Reference the candidate, frame by the goal
- Invite engagement or offer clean opt-out
- Stop talking; let the user respond

OPENING SHAPE (INTRODUCTION MODE — see flag in candidate block below):
- 4–8 sentences, may take ~30 seconds. Brevity rule does NOT apply.
- This is the user's first impression of who you are and what you do.
- Required cover (in order):
  1. Brief warm by-name greeting
  2. Tell them: this is Vitanaland — a longevity platform whose mission is
     to improve quality of life and extend lifespan
  3. Tell them you have automatically set their starting focus to that
     mission goal, AND that they can change it whenever they want by
     saying "change my goals" or in the Memory Hub → Life Compass
  4. Briefly name what you can guide them on (their 90-day journey,
     community, health, calendar, business hub, marketplace, memory)
  5. Invite a first move — ask what feels most pressing right now OR
     suggest one concrete first step they can take today
- After this introduction, in subsequent turns, return to brief voice
  responses unless the topic itself requires elaboration (goal-setting,
  capability questions, complex decisions).

SILENT HONOR RULES (non-negotiable):
- If the user says "skip it", "not that one", "next" → call the
  pause_proactive_guidance tool with scope="nudge_key" and the candidate's
  nudge_key, duration_minutes=1440 (24h). Then pivot naturally.
- If the user says "not today", "quiet today", "give me space" → call
  pause_proactive_guidance with scope="all" and an appropriate
  duration_minutes (until 06:00 next day, or 2880 for 48h).
- If the user says "not this week", "ask me Monday" → scope="all",
  duration_minutes matching what they asked.
- If the user says "don't mention X again" → scope="category",
  scope_value=the topic, duration_minutes=129600 (90d).
- If the user says "ok you can talk again", "go ahead", "resume" → call
  clear_proactive_pauses.
- After ANY of these, respond with at most a brief acknowledgement
  ("got it") and pivot. Do NOT apologize, do NOT say "I'll stop now",
  do NOT make a thing of it. Do NOT re-offer the same suggestion within
  the pause window.

GRACEFUL RETURN:
- After a pause expires, do not dump a backlog. At most ONE gentle check-in
  per session: "Welcome back — want to hear what I noticed, or pick up
  where you were?" If the user declines, stay quiet for the rest of the
  session.

GOAL CHANGES:
- If the user says "change my goals", "I want a different focus", "update
  my goals", "pick a different goal" — confirm warmly and tell them the
  exact path: "Open the Memory Hub and tap Life Compass — that's where
  your goals live. Pick the focus that matters to you most right now."
  Do NOT pretend you can navigate the app for them. The goal-change UI
  is the Life Compass modal accessed via Memory Hub.
- After they tell you they have changed their goal, you can ask them
  what they picked (so you can frame the next conversation accordingly).`;

  if (!candidate) {
    return rulesBlock;
  }

  const goalLine = candidate.goal_link
    ? candidate.goal_link.is_system_seeded
      ? `User's active Life Compass goal (SYSTEM-SEEDED DEFAULT): "${candidate.goal_link.primary_goal}" (category: ${candidate.goal_link.category})\n` +
        `IMPORTANT: this goal was set BY YOU automatically because the user has not picked one. ` +
        `Frame your opener accordingly — explicitly mention you've set this default and the user can change it any time. ` +
        `Example: "I've set your starting focus to improving quality of life and extending lifespan — that's the heart of Vitanaland's mission. You can change it any time by saying so, or in the Memory Hub. For now, here's something on my mind..."`
      : `Toward the user's active Life Compass goal: "${candidate.goal_link.primary_goal}" (category: ${candidate.goal_link.category})`
    : 'No active Life Compass goal set — gently invite the user to pick one if natural.';

  const modeBanner = introductionMode
    ? '*** INTRODUCTION MODE: ON — use the 4-8 sentence opening shape with all 5 required elements above ***'
    : '*** INTRODUCTION MODE: OFF — use the 2-4 sentence regular opening shape above ***';

  const candidateBlock = `

=== PROACTIVE OPENER CANDIDATE — YOUR FIRST UTTERANCE MUST BUILD AROUND THIS ===
${modeBanner}
Kind: ${candidate.kind}
nudge_key: ${candidate.nudge_key}      ← exact string for pause_proactive_guidance(scope="nudge_key")
Title: ${candidate.title}${candidate.subline ? `\nDetail: ${candidate.subline}` : ''}
Why this was selected: ${candidate.reason}
${goalLine}

DO NOT default to your trained "Good morning, how can I help?" reflex.
That is on the FORBIDDEN OPENINGS list above. Lead with the candidate.
Use the opening shape that matches the mode banner above.

If the user declines (skip / not today / give me space / etc.) honor it
silently via the dismissal tools — no apology, no big deal.`;

  return rulesBlock + candidateBlock;
}

// =============================================================================
// Brain Tool Definitions (for ORB Voice — Phase 3)
// =============================================================================

/**
 * Get unified tool definitions for the Brain, role-gated.
 * Merges the tool-registry tools with ORB-specific tools.
 *
 * Phase 3: ORB voice calls this instead of buildLiveApiTools()
 */
export function buildBrainToolDefinitions(role: string): object[] {
  // Import tool registry (already role-gated)
  const { getGeminiToolDefinitions } = require('./tool-registry');
  const registryTools = getGeminiToolDefinitions(role);

  // ORB-specific tools that aren't in the registry yet
  const orbTools = [
    {
      name: 'search_calendar',
      description: 'Search the user\'s personal calendar for events, appointments, and scheduled activities.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for in the calendar' },
        },
        required: ['query'],
      },
    },
    // Proactive Guide Phase 0.5 — dismissal honor tools.
    // Always available; the LLM only calls them when the system prompt's
    // Proactive Opener Rules are present (i.e., flag is on).
    PAUSE_PROACTIVE_GUIDANCE_TOOL,
    CLEAR_PROACTIVE_PAUSES_TOOL,
  ];

  // Merge: registry tools + ORB tools (avoid duplicates)
  const registryNames = new Set(registryTools.map((t: any) => t.name));
  const merged = [...registryTools];
  for (const tool of orbTools) {
    if (!registryNames.has(tool.name)) {
      merged.push(tool);
    }
  }

  return merged;
}

// =============================================================================
// Brain Tool Executor (for ORB Voice — Phase 3)
// =============================================================================

/**
 * Execute a tool call through the Brain's unified executor.
 * Handles all tools from the merged registry + ORB-specific tools.
 *
 * Phase 3: ORB voice calls this instead of executeLiveApiToolInner()
 */
export async function executeBrainTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { user_id: string; tenant_id: string; role: string; user_timezone?: string },
): Promise<{ success: boolean; result: string; error?: string }> {
  const startTime = Date.now();
  const userTz = context.user_timezone || 'UTC';

  try {
    switch (toolName) {
      case 'search_calendar': {
        const { getUserTodayEvents, getUserUpcomingEvents, getCalendarGaps } = await import('./calendar-service');
        const [today, upcoming, gaps] = await Promise.all([
          getUserTodayEvents(context.user_id, context.role),
          getUserUpcomingEvents(context.user_id, context.role, 10),
          getCalendarGaps(context.user_id, context.role, new Date()),
        ]);

        let formatted = '';
        if (today.length > 0) {
          formatted += `Today's schedule (times in ${userTz}):\n`;
          for (const ev of today) {
            const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
            formatted += `- ${time}: ${ev.title} (${ev.event_type})\n`;
          }
        } else {
          formatted += 'Today\'s schedule: No events scheduled.\n';
        }
        if (upcoming.length > 0) {
          formatted += `\nUpcoming (next 7 days, times in ${userTz}):\n`;
          for (const ev of upcoming.slice(0, 5)) {
            const date = new Date(ev.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: userTz });
            const time = new Date(ev.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
            formatted += `- ${date} ${time}: ${ev.title}\n`;
          }
        }
        if (gaps.length > 0) {
          formatted += `\nFree time today (in ${userTz}):\n`;
          for (const gap of gaps.slice(0, 3)) {
            const start = new Date(gap.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
            const end = new Date(gap.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: userTz });
            formatted += `- ${start}\u2013${end} (${gap.duration_minutes} min free)\n`;
          }
        }

        console.log(`${LOG_PREFIX} search_calendar: ${today.length} today, ${upcoming.length} upcoming, ${gaps.length} gaps (${Date.now() - startTime}ms)`);
        return { success: true, result: formatted || 'Your calendar is currently empty.' };
      }

      // Proactive Guide Phase 0.5 — dismissal honor tools
      case 'pause_proactive_guidance': {
        const channel: 'voice' | 'text' = 'voice'; // brain executor is currently used by ORB
        const result = await executePauseProactiveGuidance(
          {
            scope: (args.scope as any) || 'all',
            scope_value: args.scope_value as string | undefined,
            duration_minutes: args.duration_minutes as number | undefined,
            reason: args.reason as string | undefined,
          },
          { user_id: context.user_id, channel },
        );
        if (!result.success) {
          return { success: false, result: `pause failed: ${result.error}`, error: result.error };
        }
        const until = new Date(result.paused_until!);
        return {
          success: true,
          result: `Paused (scope=${result.scope}${result.scope_value ? `:${result.scope_value}` : ''}) until ${until.toISOString()}.`,
        };
      }

      case 'clear_proactive_pauses': {
        const result = await executeClearProactivePauses({ user_id: context.user_id });
        if (!result.success) {
          return { success: false, result: `clear failed: ${result.error}`, error: result.error };
        }
        return {
          success: true,
          result: `Cleared ${result.cleared_count} active pause${result.cleared_count === 1 ? '' : 's'}.`,
        };
      }

      default: {
        // Delegate to tool-registry executor for all other tools
        return {
          success: false,
          result: `Tool '${toolName}' not handled by brain executor. Delegate to surface-specific handler.`,
          error: `unhandled_tool:${toolName}`,
        };
      }
    }
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Tool ${toolName} failed: ${err.message}`);
    return { success: false, result: `Tool execution failed: ${err.message}`, error: err.message };
  }
}
