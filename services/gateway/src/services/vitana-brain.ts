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
import { getSupabase } from '../lib/supabase';
// Proactive Guide Phase 0.5 + Companion Awareness Phase A (VTID-01927)
// + Phase B personality config (VTID-01931) + Phase G feature introductions (VTID-01932)
import { getSystemControl } from './system-controls-service';
import {
  pickOpenerCandidate,
  getAwarenessContext,
  recordFeatureIntroduction,
  PAUSE_PROACTIVE_GUIDANCE_TOOL,
  CLEAR_PROACTIVE_PAUSES_TOOL,
  RECORD_FEATURE_INTRODUCTION_TOOL,
  executePauseProactiveGuidance,
  executeClearProactivePauses,
  emitGuideTelemetry,
  type OpenerCandidate,
  type UserAwareness,
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

  // BOOTSTRAP-ORB-GREETING-LATENCY: fire the three blocking context queries
  // in parallel. Previously serialized (contextPack -> lifeCompass ->
  // proactiveGuide) which stacked ~2-3s of DB latency on top of the upstream
  // WS handshake and pushed the time-to-greeting on the orb from instant to
  // 4-5s. These three queries are independent — contextPack builds from
  // memory/calendar/OASIS, Life Compass reads life_compass, and the
  // proactive guide block reads its own awareness tables — so a single
  // Promise.all is safe.
  const [contextPack, lifeCompassBlock, proactiveGuideBlock] = await Promise.all([
    buildContextPack(contextPackInput),
    buildLifeCompassGoalBlock({ user_id: input.user_id }),
    buildProactiveGuideBlock({
      user_id: input.user_id,
      tenant_id: input.tenant_id,
      role: input.role,
      channel: input.channel,
    }),
  ]);
  const contextForLLM = formatContextPackForLLM(contextPack, { userTimezone: input.user_timezone });

  // Build personality-driven instruction
  const preferredLanguage = extractLanguageFromContextPack(contextPack);
  const languageDirective = buildLanguageDirective(preferredLanguage);

  const ucConfig = getPersonalityConfigSync('unified_conversation') as Record<string, any>;
  const baseInstruction = input.channel === 'orb'
    ? (ucConfig.orb_instruction || 'You are Vitana, an intelligent voice assistant. Keep responses concise and conversational for voice interaction.')
    : (ucConfig.operator_instruction || 'You are Vitana, an intelligent assistant. You can be detailed and use formatting when helpful.');

  // PROMPT ORDER MATTERS: the proactive guide block goes LAST so it has
  // recency primacy in Gemini's attention. Putting it before the brevity
  // rule caused Gemini to default to "What can I do for you?" on the first
  // utterance because the brevity rule reinforced its trained habit.
  const instruction = `${baseInstruction}
${languageDirective}
${contextForLLM}
${lifeCompassBlock}

Current conversation channel: ${input.channel}
User's role: ${input.role}

General instructions (DEFAULT — overridden by Proactive Guide Rules below):
${ucConfig.common_instructions || '- Use the memory context to personalize responses\n- Use knowledge context for Vitana-specific questions\n- Be helpful and accurate'}
- ${input.channel === 'orb' ? (ucConfig.instructions_orb || 'Keep responses brief and natural for voice') : (ucConfig.instructions_operator || 'You can use markdown formatting and be more detailed')}
${proactiveGuideBlock}`;

  const latencyMs = Date.now() - startTime;
  console.log(`${LOG_PREFIX} System instruction built in ${latencyMs}ms (${instruction.length} chars, ${contextPack.memory_hits?.length || 0} memory hits, calendar=${!!contextPack.calendar_context}, compass=${lifeCompassBlock.length > 0 ? 'on' : 'off'}, guide=${proactiveGuideBlock.length > 0 ? 'on' : 'off'})`);

  return { instruction, contextPack };
}

// =============================================================================
// Always-on Life Compass goal block (independent of proactive opener flag)
// =============================================================================

/**
 * Fetch the user's active Life Compass goal and produce a short system-prompt
 * block that binds every recommendation to that goal.
 *
 * This runs on EVERY brain turn — including plain text chat with the
 * proactive opener flag OFF — so Vitana never produces off-goal suggestions.
 * Returns empty string when no goal exists and supabase is unavailable; the
 * opener-mvp layer will auto-seed a default goal when it runs.
 */
export async function buildLifeCompassGoalBlock(input: {
  user_id: string;
}): Promise<string> {
  const supabase = getSupabase();
  if (!supabase) return '';

  try {
    const { data: rows } = await supabase
      .from('life_compass')
      .select('primary_goal, category')
      .eq('user_id', input.user_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!rows || rows.length === 0) {
      return `
=== ACTIVE LIFE COMPASS GOAL — NOT SET ===
The user has not picked a Life Compass goal yet. Before offering any
domain-specific recommendation, gently invite them to open the Life Compass
(they can say "open my goals" or tap the Life Compass button in the utility
bar on any screen — it opens as an overlay). Until a goal is set, keep
recommendations broad and focused on helping them clarify what matters most.`;
    }

    const goal = rows[0] as { primary_goal: string; category: string };
    return `
=== ACTIVE LIFE COMPASS GOAL (apply to every recommendation this turn) ===
Primary goal: "${goal.primary_goal}"
Category: ${goal.category}

NON-NEGOTIABLE: every suggestion, tip, product, event, or nudge you produce
in this turn MUST visibly connect to this goal. When you recommend something,
state the link explicitly ("because your focus is ${goal.primary_goal}, ..."
or the equivalent in the user's language). Do not produce off-goal advice.
If the user asks for something unrelated, answer it — but if you volunteer
a recommendation, frame it through this goal.

If the user wants to change their focus, they can say "open my goals" /
"change my goals" and the Life Compass overlay opens on the current screen.
They can also tap the Life Compass button in the utility bar on any screen.`;
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} buildLifeCompassGoalBlock failed: ${err.message}`);
    return '';
  }
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
 *
 * Phase A (VTID-01927): now reads UserAwareness once and passes it through.
 * The opener block is structured around tenure × last_interaction so Vitana
 * speaks differently to a Day-0 newcomer vs a Day-231 veteran returning
 * after 10 days of silence.
 */
export async function buildProactiveGuideBlock(input: {
  user_id: string;
  tenant_id: string;
  role: string;
  channel: ConversationChannel;
}): Promise<string> {
  const flag = await getSystemControl('vitana_proactive_opener_enabled').catch(() => null);
  if (!flag || !flag.enabled) {
    return '';
  }

  const channel: 'voice' | 'text' = input.channel === 'orb' ? 'voice' : 'text';
  const guideRole = mapRoleForGuide(input.role);

  // Compute the unified awareness picture ONCE — every downstream signal flows from it
  let awareness: UserAwareness | null = null;
  try {
    awareness = await getAwarenessContext(input.user_id, input.tenant_id);
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} getAwarenessContext failed:`, err?.message);
  }

  // VTID-01931 Phase B: Read companion config from voice_live personality.
  // Admins edit these via /admin/assistant/personality — changes propagate
  // within ~30s without a deploy. Fallback hardcoded values if missing.
  const voiceLiveCfg = getPersonalityConfigSync('voice_live') as Record<string, any>;
  const forbiddenOpenings: string[] = Array.isArray(voiceLiveCfg.forbidden_openings)
    ? voiceLiveCfg.forbidden_openings
    : [
        'What can I do for you?',
        'How can I help you today?',
        'How may I assist you?',
        'Good morning. How are you?',
      ];
  const silentHonorMaxAck: string =
    voiceLiveCfg.silent_honor?.max_acknowledgement || 'got it';
  const silentHonorPivot: string =
    voiceLiveCfg.silent_honor?.pivot_rule ||
    'after dismissal, pivot naturally — no apology, no big deal';
  const reEngageFirstForAbsent: boolean =
    voiceLiveCfg.companion_behaviors?.re_engagement_first_for_absent !== false;

  // Best-effort opener fetch — never block instruction build on this.
  let candidate: OpenerCandidate | null = null;
  let suppressedByPause = false;
  try {
    const sel = await pickOpenerCandidate({
      user_id: input.user_id,
      active_role: guideRole,
      channel,
      awareness: awareness ?? undefined,
    });
    candidate = sel.candidate;
    suppressedByPause = sel.suppressed_by_pause;
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} pickOpenerCandidate failed:`, err?.message);
  }

  // Telemetry — fire-and-forget. Includes awareness summary so we can debug
  // tenure-aware behavior from OASIS without re-running the brain.
  const awarenessTelemetry = awareness
    ? {
        tenure_stage: awareness.tenure.stage,
        days_since_signup: awareness.tenure.days_since_signup,
        current_wave: awareness.journey.current_wave?.id ?? null,
        last_interaction_bucket: awareness.last_interaction?.bucket ?? null,
        motivation_signal: awareness.last_interaction?.motivation_signal ?? null,
        days_since_last: awareness.last_interaction?.days_since_last ?? null,
        diary_streak: awareness.community_signals.diary_streak_days,
      }
    : {};

  if (candidate) {
    emitGuideTelemetry('guide.opener.shown', {
      user_id: input.user_id,
      channel,
      role: guideRole,
      nudge_key: candidate.nudge_key,
      kind: candidate.kind,
      goal: candidate.goal_link?.primary_goal ?? null,
      ...awarenessTelemetry,
    }).catch(() => {});
  } else if (suppressedByPause) {
    emitGuideTelemetry('guide.opener.suppressed_by_pause', {
      user_id: input.user_id,
      channel,
      role: guideRole,
      ...awarenessTelemetry,
    }).catch(() => {});
  } else {
    emitGuideTelemetry('guide.opener.no_candidate', {
      user_id: input.user_id,
      channel,
      role: guideRole,
      ...awarenessTelemetry,
    }).catch(() => {});
  }

  // Phase A — tenure-aware introduction. Only TRUE Day-0 newcomers get the
  // full introduction shape. Day-30+ veterans get peer-like 1-2 sentences,
  // even on their actual first ORB session. The system-seeded goal is no
  // longer the trigger — tenure is.
  const introductionMode = awareness?.tenure.stage === 'day0';

  // Awareness block — single source of truth for "who is on the line right now"
  const awarenessBlock = buildAwarenessBlock(awareness);

  // Always include the rules — even with no candidate today, the LLM still
  // needs to know how to honor dismissals if the user volunteers one.
  const rulesBlock = `
${awarenessBlock}

=== PROACTIVE GUIDE RULES (HIGHEST PRIORITY — OVERRIDES "brief / concise" RULE ABOVE) ===

These rules override anything above about being concise or brief. The
brevity guidance is the DEFAULT. Proactive opening + introduction +
absent-user re-engagement + goal-setting conversations are EXCEPTIONS where
you must elaborate, introduce, and present — not be terse.

Vitanaland is a longevity platform — its mission is to help people improve
quality of life and extend lifespan. You are not a passive assistant. You
are the proactive companion. You lead — you do not wait to be asked.

ABSOLUTE FORBIDDEN OPENINGS — NEVER say any of these as your first
utterance of a session, in any language, in any phrasing:
${forbiddenOpenings.map((p) => `- "${p}"`).join('\n')}

Those are passive — they ask the user what to do. The user — especially a
new user — DOES NOT KNOW what you can do for them. It is YOUR job to lead.

WHEN TO OPEN PROACTIVELY:
- New conversation thread → ALWAYS open per the OPENING SHAPE matrix below.
- User silent > 6h → same.
- Maximum 1 unsolicited suggestion per turn.
- Frame every nudge through the user's active Life Compass goal.
- Tone: warm, inspirational, educational — never pushy.

=== OPENING SHAPE MATRIX (TENURE × LAST_INTERACTION) ===

Two axes determine your opening shape:
  1. tenure.stage          — how long the user has been with Vitana
  2. last_interaction.bucket — how recently they last spoke with you

TENURE AXIS — sets depth of orientation needed:
- day0       → 5–8 sentences. FULL INTRODUCTION (mission, capabilities, agency offer).
               Only on the very first session. Tenure dominates over last_interaction here.
- day1, day3 → 3–5 sentences. Light reintroduction to the journey if needed.
- day7, day14 → 2–4 sentences. Mid-journey, knows the basics.
- day30plus  → 1–2 sentences. Veteran. NEVER re-explain platform basics.

LAST_INTERACTION AXIS — modulates warmth and absence acknowledgement.
IMPORTANT: for early-tenure users (day0/day1/day3/day7), even a SHORT absence
(1-2 days) is meaningful — they're forming the habit and you want to make
them feel welcomed back. For day14/day30plus users, short absences are normal
and don't warrant special acknowledgement.

- reconnect (< 2 min) → No greeting at all. Continue mid-flow.
- recent (< 15 min)   → No "hello/hi", no name. Brief warmth, lead with content.
- same_day (< 8h)     → "back so soon" tone, no name greeting.
- today (< 24h)       → Light: "Good {morning/afternoon/evening}, {Name}".
- yesterday (1 day)   → For day0/day1/day3 users: "Hi {Name}, happy you came
                         back. Yesterday was your [N]th day with us."
                       For day7+ users: "Good {morning/afternoon/evening}, {Name}".
- week (2-7 days)     → For day0/day1/day3/day7 users: warm + slightly concerned
                         tone — "Hi {Name}, it's been {N} days. Glad you're back.
                         Want to pick up where we left off?"
                       For day14+ users: "Good to hear from you again — been
                         a few days."
- long, motivation_signal=cooling (8-14 days)
                      → "Hi {Name}, it's been {N} days since we last talked.
                         Welcome back." Warm. No guilt. Doubly important for
                         early-tenure users — likely a sign they need re-engagement.
- long, motivation_signal=absent (>14 days)
                      → "Hi {Name}, haven't seen you in {N} days. I'm glad
                         you're back. Where have you been?"
                         Pause for the user to respond BEFORE launching into a
                         candidate. Re-engagement comes first; productivity second.
                         After they answer, ask one warm check-in question
                         ("how have you been?") before steering to any goal.
- first (no past sessions) → defer to tenure axis. day0 → FULL INTRODUCTION.
                              day1 onward → "Good {morning/afternoon/evening},
                              {Name} — first time we're talking by voice."

COMPOSITION EXAMPLES (these are the realistic test scenarios — every new
signup is day0/day1):
- day0 newcomer + first ever session → 5–8 sentence FULL INTRODUCTION (mission,
   capabilities, agency offer, first-step invitation)
- day1 user + bucket=today → 3–5 sentences, "Good morning, {Name} — day two
   with us. Yesterday you [reference], let's continue with [candidate]."
- day3 user + bucket=yesterday → "Hi {Name}, glad you're back. Picking up
   where we left off — [candidate]."
- day3 user + bucket=week (2 days silent) → "Hi {Name}, two days since we
   talked. I'm glad you came back. [candidate]" — early-tenure absence is
   a churn signal; warmth matters.
- day7 user + bucket=yesterday → "Good morning, {Name}. [candidate]."
- day14 user + bucket=week (3 days silent) → "Good to hear from you — been
   a few days. [candidate]."
- day30plus user + bucket=same_day → "Back so soon — [candidate]." (no greeting)
- day30plus user + bucket=long (10 days) → "Hi {Name}, it's been ten days.
   Welcome back. [candidate]."

INTRODUCTION MODE (only when tenure.stage='day0'):
Required cover, in order:
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
After introduction, return to brief voice responses unless the topic itself
requires elaboration.

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
  ("${silentHonorMaxAck}") and ${silentHonorPivot}. Do NOT apologize, do NOT
  say "I'll stop now", do NOT make a thing of it. Do NOT re-offer the same
  suggestion within the pause window.

GRACEFUL RETURN:
- After a pause expires, do not dump a backlog. At most ONE gentle check-in
  per session: "Welcome back — want to hear what I noticed, or pick up
  where you were?" If the user declines, stay quiet for the rest of the
  session.

GOAL CHANGES:
- If the user says "change my goals", "I want a different focus", "update
  my goals", "pick a different goal", "open my goals", "open my life
  compass", "show me my compass", or "set a new goal" — this is a direct
  request to surface the Life Compass modal. Respond with a warm, short
  acknowledgement AND rely on the navigator to dispatch the Life Compass
  overlay (screen_id "LIFE_COMPASS.OVERLAY", route "/?open=life_compass").
  The overlay pops on top of whatever screen they are on, so they never
  lose context. Do NOT tell them to hunt for a menu — the button lives
  in the utility bar on every screen, and voice opens the popup directly.
- Suggested phrasing: "Opening your Life Compass now — pick the focus
  that matters most to you right now. You can also choose 'Spiritual
  Life' or define a custom goal." (Adapt language to the user.)
- After they tell you they have picked a new goal, ask what they chose
  so you can frame the next suggestion accordingly.

GOAL-GROUNDED RECOMMENDATIONS (NON-NEGOTIABLE):
- Every recommendation, suggestion, or proactive nudge you offer MUST be
  filtered through the user's active Life Compass goal supplied in the
  OPENER CANDIDATE block below (field: goal_link.primary_goal + category).
- If no goal_link is present in this turn's candidate, you still have the
  user's active goal via the memory context pack — consult it before
  offering any suggestion. If no goal is set, gently invite the user to
  pick one before producing domain-specific recommendations.
- Do NOT make generic off-topic suggestions. Every piece of advice should
  visibly connect to the goal ("because your focus is X, here's Y").`;

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

  const tenureLine = awareness
    ? `*** ACTIVE TENURE STAGE: ${awareness.tenure.stage} (day ${awareness.tenure.days_since_signup} since registration) ***`
    : '*** ACTIVE TENURE STAGE: unknown — default to day30plus shape (1-2 sentences) ***';
  const lastInteractionLine = awareness?.last_interaction
    ? `*** LAST INTERACTION: bucket=${awareness.last_interaction.bucket} (${awareness.last_interaction.time_ago}) motivation=${awareness.last_interaction.motivation_signal} ***`
    : '*** LAST INTERACTION: none — first ORB session ***';
  const modeBanner = introductionMode
    ? '*** INTRODUCTION MODE: ON — Day-0 user, use the 5-8 sentence INTRODUCTION shape with all 5 required elements above ***'
    : '*** INTRODUCTION MODE: OFF — use the OPENING SHAPE MATRIX above (tenure × last_interaction) ***';

  const candidateBlock = `

=== PROACTIVE OPENER CANDIDATE — YOUR FIRST UTTERANCE MUST BUILD AROUND THIS ===
${tenureLine}
${lastInteractionLine}
${modeBanner}
Kind: ${candidate.kind}
nudge_key: ${candidate.nudge_key}      ← exact string for pause_proactive_guidance(scope="nudge_key")
Title: ${candidate.title}${candidate.subline ? `\nDetail: ${candidate.subline}` : ''}
Why this was selected: ${candidate.reason}
${goalLine}

DO NOT default to your trained "Good morning, how can I help?" reflex.
That is on the FORBIDDEN OPENINGS list above. Lead with the candidate AND
respect the OPENING SHAPE MATRIX (tenure × last_interaction).

If the user declines (skip / not today / give me space / etc.) honor it
silently via the dismissal tools — no apology, no big deal.`;

  return rulesBlock + candidateBlock;
}

/**
 * Build the awareness summary block for the system prompt.
 * Returns empty string when no awareness available.
 */
function buildAwarenessBlock(awareness: UserAwareness | null): string {
  if (!awareness) return '';

  const lines: string[] = ['=== USER AWARENESS (right now) ==='];

  // Tenure — always include
  lines.push(
    `Tenure: ${awareness.tenure.stage} (registered ${awareness.tenure.days_since_signup} days ago, on ${awareness.tenure.registered_at.split('T')[0]})`,
  );

  // Last interaction — when did they last talk to you
  if (awareness.last_interaction) {
    const li = awareness.last_interaction;
    if (li.bucket === 'first') {
      lines.push(`Last interaction: NEVER — this is their first ever ORB session.`);
    } else {
      lines.push(
        `Last interaction: ${li.time_ago} (bucket=${li.bucket}, ${li.days_since_last} days, motivation=${li.motivation_signal})${li.was_failure ? ' [LAST SESSION FAILED — audio/connection]' : ''}`,
      );
    }
  }

  // Journey + active wave
  if (awareness.journey.is_past_90_day) {
    lines.push(`Journey: past the initial 90-day plan (day ${awareness.journey.day_in_journey}). No active wave.`);
  } else if (awareness.journey.current_wave) {
    lines.push(
      `Journey: day ${awareness.journey.day_in_journey} of 90, currently in wave "${awareness.journey.current_wave.name}" — ${awareness.journey.current_wave.description}`,
    );
  } else {
    lines.push(`Journey: day ${awareness.journey.day_in_journey}, between waves.`);
  }

  // Active goal
  if (awareness.goal) {
    lines.push(
      `Active Life Compass goal: "${awareness.goal.primary_goal}" (category: ${awareness.goal.category})${awareness.goal.is_system_seeded ? ' — SYSTEM-SEEDED DEFAULT, you set this for them, they can change anytime' : ' — user-chosen'}`,
    );
  } else {
    lines.push(`Active Life Compass goal: NONE — gently invite them to pick one in Memory Hub → Life Compass.`);
  }

  // Community signals — only when present + meaningful
  const cs = awareness.community_signals;
  const csParts: string[] = [];
  if (cs.diary_streak_days > 0) csParts.push(`${cs.diary_streak_days}-day diary streak`);
  if (cs.connection_count > 0) csParts.push(`${cs.connection_count} connection${cs.connection_count === 1 ? '' : 's'}`);
  if (cs.group_count > 0) csParts.push(`${cs.group_count} group${cs.group_count === 1 ? '' : 's'}`);
  if (cs.pending_match_count > 0) csParts.push(`${cs.pending_match_count} pending match${cs.pending_match_count === 1 ? '' : 'es'}`);
  if (cs.memory_goals.length > 0) csParts.push(`stated goals: ${cs.memory_goals.slice(0, 3).join(', ')}`);
  if (cs.memory_interests.length > 0) csParts.push(`interests: ${cs.memory_interests.slice(0, 3).join(', ')}`);
  if (csParts.length > 0) {
    lines.push(`Community signals: ${csParts.join('; ')}`);
  }

  // Phase D (VTID-01934) — taste & preference signals. When stated interests
  // or goals exist, prefer suggestions that match them. When no interests
  // known yet, gently discover them through conversation rather than guessing.
  if (cs.memory_interests.length > 0 || cs.memory_goals.length > 0) {
    lines.push(
      'Taste rule: when suggesting ANYTHING (activities, topics, meetups, content), prefer items that align with the user\'s stated interests/goals above. When you dismiss a candidate, note WHY — "that doesn\'t match your interest in X".',
    );
  } else {
    lines.push(
      'Taste rule: no interests/goals extracted yet. Don\'t guess — when the user mentions something they enjoy, care about, or want to avoid, acknowledge it naturally so future conversations can reflect it.',
    );
  }

  // Recent activity — what's pending or just happened
  const ra = awareness.recent_activity;
  const raParts: string[] = [];
  if (ra.open_autopilot_recs > 0) raParts.push(`${ra.open_autopilot_recs} open autopilot recommendation${ra.open_autopilot_recs === 1 ? '' : 's'}`);
  if (ra.activated_recs_last_7d > 0) raParts.push(`${ra.activated_recs_last_7d} activated in last 7d`);
  if (ra.dismissed_recs_last_7d > 0) raParts.push(`${ra.dismissed_recs_last_7d} dismissed in last 7d (be gentle)`);
  if (ra.overdue_calendar_count > 0) raParts.push(`${ra.overdue_calendar_count} overdue autopilot calendar event${ra.overdue_calendar_count === 1 ? '' : 's'}`);
  if (ra.upcoming_calendar_24h_count > 0) raParts.push(`${ra.upcoming_calendar_24h_count} upcoming in next 24h`);
  if (raParts.length > 0) {
    lines.push(`Recent activity: ${raParts.join('; ')}`);
  }

  // Phase F — prior session continuity. Brain weaves naturally rather than reciting.
  if (awareness.prior_session_themes && awareness.prior_session_themes.length > 0) {
    const recentSummary = awareness.prior_session_themes[0];
    const recentDate = recentSummary.ended_at.slice(0, 10);
    const themeList =
      recentSummary.themes && recentSummary.themes.length > 0
        ? ` (themes: ${recentSummary.themes.slice(0, 4).join(', ')})`
        : '';
    lines.push(
      `Last session (${recentDate})${themeList}: ${recentSummary.summary}`,
    );
    if (awareness.prior_session_themes.length > 1) {
      const olderThemes = new Set<string>();
      for (const s of awareness.prior_session_themes.slice(1)) {
        for (const t of s.themes) olderThemes.add(t);
      }
      if (olderThemes.size > 0) {
        lines.push(`Earlier sessions touched: ${Array.from(olderThemes).slice(0, 6).join(', ')}.`);
      }
    }
    lines.push(
      'Weave one of these into the conversation when natural — never recite the summary verbatim. Examples: "last time we talked about your sleep — how did that wind-down ritual go?", "you mentioned the business hub yesterday — any progress?".',
    );
  }

  // Phase G — feature introductions already given to this user
  if (awareness.feature_introductions && awareness.feature_introductions.length > 0) {
    lines.push(
      `Features already introduced to this user (DO NOT re-explain): ${awareness.feature_introductions.join(', ')}. Reference them by name only. If the user asks about one explicitly, you may give a brief refresher.`,
    );
  } else if (awareness.feature_introductions) {
    lines.push(
      `Features already introduced: NONE. When you explain any platform feature (life_compass, vitana_index, autopilot, memory_garden, calendar, business_hub, marketplace, journey_90day, voice_chat_basics, dismissal_phrases, goal_changing, navigator, community), call the record_feature_introduction tool with the feature_key so we don't re-explain next session.`,
    );
  }

  lines.push('');
  lines.push('Use this awareness to personalize EVERY response — not just the opener.');
  lines.push('Reference these signals naturally when relevant ("your diary streak is at 5 days",');
  lines.push('"you\'re in the Daily Anchors wave", etc). Never recite all of them at once.');

  return lines.join('\n');
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
    // Companion Phase G (VTID-01932) — feature-introduction tracking.
    // The LLM calls this after explaining a feature so we know not to
    // re-introduce it in future sessions.
    RECORD_FEATURE_INTRODUCTION_TOOL,
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

      // Companion Phase G — VTID-01932
      case 'record_feature_introduction': {
        const featureKey = String(args.feature_key || '').trim();
        if (!featureKey) {
          return { success: false, result: 'feature_key required', error: 'missing_feature_key' };
        }
        const channel: 'voice' | 'text' = 'voice';
        const result = await recordFeatureIntroduction(context.user_id, featureKey, channel);
        if (!result.success) {
          return { success: false, result: `record failed: ${result.error}`, error: result.error };
        }
        return { success: true, result: `Recorded introduction of ${featureKey}.` };
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
