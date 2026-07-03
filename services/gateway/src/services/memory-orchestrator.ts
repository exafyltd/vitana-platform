/**
 * VITANA MEMORY ORCHESTRATOR — Mandatory pre-answer memory step
 * (BOOTSTRAP-MEMORY-ORCHESTRATOR-MANDATORY)
 *
 * One single service that runs BEFORE every assistant answer, on every
 * surface (text chat, Operator console, ORB voice, streaming). It does
 * not rebuild retrieval — it composes the systems that already exist:
 *
 *   - context-pack-builder  → identity facts, episodic memory, diary,
 *                             relationships, calendar, session buffer,
 *                             health/marketplace context, knowledge, web
 *   - memory-broker         → GOVERNANCE block (dismissed recommendations
 *                             + proactive pauses = the do-not-repeat list)
 *   - life_compass          → active goals
 *   - user_preferences /    → explicit + inferred preferences
 *     user_inferred_preferences
 *
 * and returns ONE prompt block wrapped in an unmistakable sentinel:
 *
 *   === USER MEMORY CONTEXT ===
 *   ...memory sections...
 *   === HOW TO USE THIS MEMORY (MANDATORY SELF-CHECK) ===
 *   ...
 *   === END USER MEMORY CONTEXT ===
 *
 * CONTRACT (the "memory first" rule, made enforceable):
 *   1. Every assistant-response path MUST call buildAssistantMemoryContext()
 *      and inject `memory_prompt_block` into the system instruction.
 *   2. Right before the LLM call, the path MUST call
 *      assertMemoryContextInjected() — for community-facing channels this
 *      THROWS when the sentinel is missing (no answer without memory).
 *   3. After the reply, the path SHOULD call emitMemoryTurnTelemetry()
 *      so the Command Hub "Memory Alive / Memory Dead" card has per-turn
 *      proof that memory was retrieved, injected, and used.
 *
 * ENRICH, DON'T CONFLICT: the self-check block is deliberately written to
 * complement the existing conversation flow (proactive guide rules, Life
 * Compass goal directives, opening-shape matrix). Memory deepens the
 * personality of what Vitana says — it never overrides WHAT the proactive
 * layer decided to lead with, and it explicitly forbids "here's a summary
 * of what I know about you" recitation.
 */

import { emitOasisEvent } from './oasis-event-service';
import {
  buildContextPack,
  formatContextPackForLLM,
  extractLanguageFromContextPack,
  BuildContextPackInput,
} from './context-pack-builder';
import {
  computeRetrievalRouterDecision,
} from './retrieval-router';
import { ContextLens, createContextLens } from '../types/context-lens';
import {
  ContextPack,
  ConversationChannel,
  RetrievalRouterDecision,
  UIContext,
} from '../types/conversation';
import { getSupabase } from '../lib/supabase';

// =============================================================================
// Sentinels — the enforcement layer greps for these
// =============================================================================

export const MEMORY_CONTEXT_SENTINEL = '=== USER MEMORY CONTEXT ===';
export const MEMORY_CONTEXT_END_SENTINEL = '=== END USER MEMORY CONTEXT ===';

const LOG_PREFIX = '[MEMORY-ORCHESTRATOR]';
const ORCHESTRATOR_VERSION = '1.0.0';

/** OASIS event types emitted by this module. */
export const MEMORY_ORCHESTRATOR_EVENT_TYPES = {
  /** Emitted once per buildAssistantMemoryContext() call. */
  CONTEXT_BUILT: 'memory.orchestrator.context_built',
  /** Emitted once per completed assistant turn (has assistant_used_memory). */
  TURN: 'memory.orchestrator.turn',
  /** Emitted when an LLM call is attempted without the memory block. */
  BYPASS_DETECTED: 'memory.orchestrator.bypass_detected',
} as const;

// =============================================================================
// Types
// =============================================================================

export interface ActiveGoal {
  primary_goal: string;
  category: string;
  is_system_seeded?: boolean;
}

export interface PreferenceEntry {
  category: string;
  key: string;
  value: string;
  source: 'explicit' | 'inferred';
}

export interface DoNotRepeatEntry {
  title: string;
  reason: string;
  until: string | null;
}

/** Per-turn telemetry — the proof that memory ran. */
export interface MemoryTurnTelemetry {
  memory_orchestrator_called: true;
  orchestrator_version: string;
  /** Total memory-garden hits in the context pack (facts + episodic + diary). */
  memory_hits: number;
  /** Structured facts (memory_facts / identity core) loaded. */
  facts_loaded: number;
  /** Episodic (non-fact, non-diary) memories loaded. */
  episodic_loaded: number;
  /** Diary entries surfaced. */
  diary_loaded: number;
  goals_loaded: number;
  preferences_loaded: number;
  relationships_loaded: number;
  /** Dismissed recommendations + active proactive pauses (do-not-repeat). */
  dismissed_loaded: number;
  /** Recent turns from the Tier 0 session buffer. */
  recent_turns_loaded: number;
  /** True when the sentinel-wrapped block was produced and non-degenerate. */
  memory_injected_to_prompt: boolean;
  /** Sources that failed or timed out during retrieval (best-effort). */
  degraded_sources: string[];
  latency_ms: number;
}

export interface BuildAssistantMemoryContextInput {
  tenant_id: string;
  user_id: string;
  role: string;
  channel: ConversationChannel;
  /** The user's message this turn (drives semantic retrieval). */
  message: string;
  ui_context?: UIContext;
  thread_id?: string;
  turn_number?: number;
  conversation_start?: string;
  display_name?: string;
  user_timezone?: string;
  /** Session buffer lookup key (defaults to thread_id). */
  session_id?: string;
  /**
   * Caller-computed router decision. When provided, the orchestrator still
   * FORCES memory_garden into the source list — memory is not optional.
   */
  router_decision?: RetrievalRouterDecision;
  /**
   * Set by callers that inject their own directive-heavy Life Compass block
   * (ORB brain path). Goals are still LOADED (telemetry + relevance), but
   * the orchestrator omits its own goals section to avoid two competing
   * goal directives in one prompt.
   */
  skip_goal_section?: boolean;
  /** Optional VTID for OASIS event correlation. */
  vtid?: string;
}

export interface AssistantMemoryContext {
  ok: boolean;
  /** The full sentinel-wrapped block to inject into the system instruction. */
  memory_prompt_block: string;
  /** The underlying context pack (for callers that surface it, e.g. Operator). */
  context_pack: ContextPack;
  /** Preferred language extracted from memory facts (for language directive). */
  preferred_language: string | null;
  goals: ActiveGoal[];
  preferences: PreferenceEntry[];
  do_not_repeat: DoNotRepeatEntry[];
  telemetry: MemoryTurnTelemetry;
  error?: string;
}

// =============================================================================
// Auxiliary fetchers (goals / preferences / governance)
// =============================================================================

/**
 * VTID-03183 mirror: Life Compass goals are community-wellness prose. On
 * developer/admin surfaces they must not be loaded or rendered — the user
 * hears community recommendations on the Command Hub otherwise.
 */
function isCommunityRole(role: string): boolean {
  const r = (role || '').toLowerCase();
  return !(
    r === 'developer' ||
    r === 'dev' ||
    r === 'admin' ||
    r === 'super_admin' ||
    r === 'superadmin'
  );
}

/**
 * Active Life Compass goals. Mirrors the canonical read in
 * vitana-brain.buildLifeCompassGoalBlock (life_compass table,
 * is_active=true, newest first) but returns structured rows.
 */
async function fetchActiveGoals(userId: string): Promise<ActiveGoal[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    // Column set mirrors buildLifeCompassGoalBlock exactly — the live
    // life_compass table has NO is_system_seeded column, and selecting a
    // missing column makes PostgREST return an error (silently mapped to
    // zero goals). Verified against production data 2026-07-03.
    const { data, error } = await supabase
      .from('life_compass')
      .select('primary_goal, category')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(3);
    if (error) throw new Error(error.message);
    return (data || []).map((r: any) => ({
      primary_goal: r.primary_goal,
      category: r.category,
    }));
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} fetchActiveGoals failed: ${err.message}`);
    throw err;
  }
}

/**
 * Explicit + high-confidence inferred preferences. Same tables and
 * thresholds as user-context-profiler.fetchPreferences (explicit wins,
 * inferred only above 0.55 confidence).
 */
async function fetchPreferences(userId: string): Promise<PreferenceEntry[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const out: PreferenceEntry[] = [];
  const [explicit, inferred] = await Promise.all([
    supabase
      .from('user_preferences')
      .select('category, preference_key, preference_value')
      .eq('user_id', userId)
      .limit(15),
    supabase
      .from('user_inferred_preferences')
      .select('category, preference_key, preference_value, confidence')
      .eq('user_id', userId)
      .order('confidence', { ascending: false })
      .limit(10),
  ]);
  if (!explicit.error && explicit.data) {
    for (const row of explicit.data as any[]) {
      out.push({
        category: row.category ?? 'preference',
        key: row.preference_key ?? '',
        value: stringifyPreferenceValue(row.preference_value),
        source: 'explicit',
      });
    }
  }
  const seen = new Set(out.map((p) => `${p.category}:${p.key}`));
  if (!inferred.error && inferred.data) {
    for (const row of inferred.data as any[]) {
      if ((row.confidence ?? 0) < 0.55) continue;
      const dedupeKey = `${row.category ?? 'preference'}:${row.preference_key ?? ''}`;
      if (seen.has(dedupeKey)) continue; // explicit always wins
      out.push({
        category: row.category ?? 'preference',
        key: row.preference_key ?? '',
        value: stringifyPreferenceValue(row.preference_value),
        source: 'inferred',
      });
    }
  }
  return out;
}

function stringifyPreferenceValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Do-not-repeat list: dismissed/snoozed recommendations + active proactive
 * pauses, via the memory-broker GOVERNANCE block. Degrades to [] when the
 * broker flag is off — degradation is recorded in telemetry so the admin
 * card shows it instead of silently shipping weak memory.
 */
async function fetchDoNotRepeat(
  tenantId: string,
  userId: string,
): Promise<{ entries: DoNotRepeatEntry[]; degraded: boolean }> {
  try {
    const { getMemoryContext } = await import('./memory-broker');
    const pack = await getMemoryContext({
      tenant_id: tenantId,
      user_id: userId,
      intent: 'community_intent',
      channel: 'conversation',
      role: 'community',
      latency_budget_ms: 1200,
      required_blocks: ['GOVERNANCE'],
    });
    if (!pack.ok) {
      return { entries: [], degraded: true };
    }
    const gov = pack.blocks.GOVERNANCE as
      | import('./memory-broker').GovernanceBlock
      | undefined;
    if (!gov) return { entries: [], degraded: false };

    const now = Date.now();
    const entries: DoNotRepeatEntry[] = [];
    for (const d of gov.dismissals || []) {
      // Only surface dismissals still inside their cooldown window.
      if (d.cooldown_until && Date.parse(d.cooldown_until) < now) continue;
      entries.push({
        title: d.title,
        reason: d.reason,
        until: d.cooldown_until,
      });
    }
    for (const p of gov.pauses || []) {
      if (p.pause_until && Date.parse(p.pause_until) < now) continue;
      entries.push({
        title: `proactive suggestions paused (scope: ${p.scope})`,
        reason: p.reason || 'user asked for quiet',
        until: p.pause_until,
      });
    }
    return { entries, degraded: false };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} fetchDoNotRepeat failed: ${err?.message}`);
    return { entries: [], degraded: true };
  }
}

// =============================================================================
// Prompt block composition
// =============================================================================

function buildGoalsSection(goals: ActiveGoal[], skip: boolean): string {
  if (skip || goals.length === 0) return '';
  let s = `<user_goals>\n`;
  s += `The user's active Life Compass goals (their chosen focus):\n`;
  for (const g of goals) {
    s += `- "${g.primary_goal}" (category: ${g.category}${g.is_system_seeded ? ', system-seeded default' : ''})\n`;
  }
  s += `</user_goals>\n\n`;
  return s;
}

function buildPreferencesSection(preferences: PreferenceEntry[]): string {
  if (preferences.length === 0) return '';
  let s = `<user_preferences>\n`;
  s += `Known preferences (explicit ones were stated by the user; inferred ones were learned from behavior):\n`;
  for (const p of preferences.slice(0, 20)) {
    s += `- [${p.source}] ${p.category} / ${p.key}: ${p.value}\n`;
  }
  s += `</user_preferences>\n\n`;
  return s;
}

function buildDoNotRepeatSection(entries: DoNotRepeatEntry[]): string {
  if (entries.length === 0) return '';
  let s = `<do_not_repeat>\n`;
  s += `The user dismissed or paused these — do NOT re-suggest or re-open them:\n`;
  for (const e of entries.slice(0, 15)) {
    s += `- ${e.title} (${e.reason}${e.until ? `, until ${e.until}` : ''})\n`;
  }
  s += `</do_not_repeat>\n\n`;
  return s;
}

/**
 * The mandatory self-check. Written to ENRICH the existing conversation
 * flow: it governs HOW memory colors the reply, and explicitly defers to
 * the proactive-guide / Life Compass directives on WHAT to lead with.
 */
function buildSelfCheckSection(): string {
  return `=== HOW TO USE THIS MEMORY (MANDATORY SELF-CHECK) ===
Before you answer, silently decide:
  1. Is any of the memory above relevant to what the user just said?
  2. Does it change your answer or recommendation? If yes, follow the
     memory — and let that show naturally ("since your focus is X...",
     "you mentioned Y last week, so...").
  3. Should the answer reference it explicitly? Only when it adds warmth
     or precision — never as proof that you remember.
  4. Is any memory conflicting or outdated? The user's CURRENT message
     always wins over stored memory; treat the stored version as stale
     and do not argue from it.

Style rules for memory (non-negotiable):
- Weave memory into your voice so the conversation feels deeply personal
  and continuous — like a companion who genuinely knows the user.
- Do NOT recite memory back, do NOT open with a summary of recent
  updates, and do NOT say "according to my memory" / "my records show".
  Reference at most one or two memory details per reply, chosen because
  they make THIS answer better.
- Never re-offer anything in the do_not_repeat list above.
- These rules complement (and never override) any proactive-opener,
  Life Compass, or persona directives elsewhere in this prompt: those
  decide WHAT to lead with; this memory decides how personally you say it.
`;
}

/**
 * Compose the full sentinel-wrapped memory block.
 */
export function formatMemoryContextForPrompt(input: {
  context_pack: ContextPack;
  goals: ActiveGoal[];
  preferences: PreferenceEntry[];
  do_not_repeat: DoNotRepeatEntry[];
  skip_goal_section?: boolean;
  user_timezone?: string;
}): string {
  const packBlock = formatContextPackForLLM(input.context_pack, {
    userTimezone: input.user_timezone,
  });

  return `${MEMORY_CONTEXT_SENTINEL}
${packBlock}${buildGoalsSection(input.goals, input.skip_goal_section === true)}${buildPreferencesSection(input.preferences)}${buildDoNotRepeatSection(input.do_not_repeat)}${buildSelfCheckSection()}
${MEMORY_CONTEXT_END_SENTINEL}
`;
}

/**
 * Wrap a legacy memory preamble (e.g. the ORB voice brain-OFF bootstrap
 * context from buildBootstrapContextPack) in the orchestrator sentinels +
 * the mandatory self-check. This upgrades legacy paths to the memory
 * contract (sentinel present → enforcement passes, self-check rules
 * injected) without changing their retrieval, until they are migrated to
 * buildAssistantMemoryContext() proper.
 */
export function wrapLegacyMemoryPreamble(preamble: string): string {
  if (!preamble || !preamble.trim()) return preamble;
  if (preamble.includes(MEMORY_CONTEXT_SENTINEL)) return preamble;
  return `${MEMORY_CONTEXT_SENTINEL}
${preamble}

${buildSelfCheckSection()}
${MEMORY_CONTEXT_END_SENTINEL}
`;
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Build the mandatory memory context for one assistant turn.
 *
 * NEVER throws — an assistant answer must not 500 because a memory stream
 * degraded. Failures are reflected in `ok`, `telemetry.degraded_sources`
 * and the OASIS context_built event, which is what turns the admin card
 * red. (The hard gate lives in assertMemoryContextInjected, which fires
 * only when a code path skipped this call entirely.)
 */
export async function buildAssistantMemoryContext(
  input: BuildAssistantMemoryContextInput,
): Promise<AssistantMemoryContext> {
  const startTime = Date.now();
  const degraded: string[] = [];

  // ---- Router decision: memory_garden is NON-OPTIONAL --------------------
  let routerDecision: RetrievalRouterDecision;
  try {
    routerDecision =
      input.router_decision ??
      computeRetrievalRouterDecision(input.message || 'general conversation context', {
        channel: input.channel,
      });
  } catch {
    routerDecision = {
      sources_to_query: ['memory_garden'],
      query_order: ['memory_garden'],
      limits: { memory_garden: 12, knowledge_hub: 0, web_search: 0, calendar: 5 },
      matched_rule: 'memory_orchestrator_fallback',
      decided_at: new Date().toISOString(),
      rationale: 'router failed — memory-only fallback',
    };
  }
  if (!routerDecision.sources_to_query.includes('memory_garden')) {
    routerDecision = {
      ...routerDecision,
      sources_to_query: [...routerDecision.sources_to_query, 'memory_garden'],
      query_order: [...routerDecision.query_order, 'memory_garden'],
      limits: {
        ...routerDecision.limits,
        memory_garden: Math.max(routerDecision.limits.memory_garden || 0, 8),
      },
      rationale: `${routerDecision.rationale} [memory_garden forced by memory-orchestrator]`,
    };
  }

  const lens: ContextLens = createContextLens(input.tenant_id, input.user_id, {
    workspace_scope: 'product',
    active_role: input.role,
  });

  const threadId = input.thread_id || `orchestrator-${Date.now()}`;
  const contextPackInput: BuildContextPackInput = {
    lens,
    query: input.message,
    channel: input.channel,
    thread_id: threadId,
    turn_number: input.turn_number ?? 0,
    conversation_start: input.conversation_start || new Date().toISOString(),
    role: input.role,
    display_name: input.display_name,
    ui_context: input.ui_context,
    router_decision: routerDecision,
    vtid: input.vtid,
    session_id: input.session_id || input.thread_id,
  };

  // ---- Parallel retrieval: pack + goals + preferences + governance -------
  let contextPack: ContextPack | null = null;
  let goals: ActiveGoal[] = [];
  let preferences: PreferenceEntry[] = [];
  let doNotRepeat: DoNotRepeatEntry[] = [];

  // VTID-03183: Life Compass goals are community prose — never load them
  // for developer/admin surfaces.
  const communityRole = isCommunityRole(input.role);
  const [packRes, goalsRes, prefsRes, dnrRes] = await Promise.allSettled([
    buildContextPack(contextPackInput),
    communityRole ? fetchActiveGoals(input.user_id) : Promise.resolve([]),
    fetchPreferences(input.user_id),
    fetchDoNotRepeat(input.tenant_id, input.user_id),
  ]);

  if (packRes.status === 'fulfilled') {
    contextPack = packRes.value;
  } else {
    degraded.push('context_pack');
    console.error(`${LOG_PREFIX} buildContextPack failed: ${packRes.reason?.message}`);
  }
  if (goalsRes.status === 'fulfilled') {
    goals = goalsRes.value;
  } else {
    degraded.push('goals');
  }
  if (prefsRes.status === 'fulfilled') {
    preferences = prefsRes.value;
  } else {
    degraded.push('preferences');
  }
  if (dnrRes.status === 'fulfilled') {
    doNotRepeat = dnrRes.value.entries;
    if (dnrRes.value.degraded) degraded.push('governance');
  } else {
    degraded.push('governance');
  }

  // Empty-but-valid pack when the builder itself failed, so callers always
  // get a well-formed result and the reply can still be produced (marked
  // degraded, never silently).
  const pack: ContextPack = contextPack ?? emptyContextPack(input, threadId, routerDecision);

  const factsLoaded = pack.memory_hits.filter((h) => h.category_key.startsWith('fact:')).length;
  const diaryLoaded = pack.memory_hits.filter((h) => h.source === 'diary').length;
  const episodicLoaded = pack.memory_hits.length - factsLoaded - diaryLoaded;

  const memoryPromptBlock = formatMemoryContextForPrompt({
    context_pack: pack,
    goals,
    preferences,
    do_not_repeat: doNotRepeat,
    skip_goal_section: input.skip_goal_section || !communityRole,
    user_timezone: input.user_timezone,
  });

  const telemetry: MemoryTurnTelemetry = {
    memory_orchestrator_called: true,
    orchestrator_version: ORCHESTRATOR_VERSION,
    memory_hits: pack.memory_hits.length,
    facts_loaded: factsLoaded,
    episodic_loaded: episodicLoaded,
    diary_loaded: diaryLoaded,
    goals_loaded: goals.length,
    preferences_loaded: preferences.length,
    relationships_loaded: pack.relationship_context?.length ?? 0,
    dismissed_loaded: doNotRepeat.length,
    recent_turns_loaded: pack.session_buffer?.turn_count ?? 0,
    memory_injected_to_prompt: memoryPromptBlock.includes(MEMORY_CONTEXT_SENTINEL),
    degraded_sources: degraded,
    latency_ms: Date.now() - startTime,
  };

  // Fire-and-forget context_built event — never blocks the reply.
  emitOasisEvent({
    vtid: input.vtid || 'MEMORY-ORCHESTRATOR',
    type: MEMORY_ORCHESTRATOR_EVENT_TYPES.CONTEXT_BUILT,
    source: `memory-orchestrator-${input.channel}`,
    status: degraded.length > 0 ? 'warning' : 'info',
    message: `Memory context built: ${telemetry.memory_hits} hits, ${telemetry.facts_loaded} facts, ${telemetry.goals_loaded} goals, ${telemetry.preferences_loaded} prefs${degraded.length ? ` (degraded: ${degraded.join(',')})` : ''}`,
    payload: {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      thread_id: threadId,
      channel: input.channel,
      role: input.role,
      ...telemetry,
    },
  }).catch(() => {});

  console.log(
    `${LOG_PREFIX} context built in ${telemetry.latency_ms}ms — ` +
      `hits=${telemetry.memory_hits} facts=${telemetry.facts_loaded} goals=${telemetry.goals_loaded} ` +
      `prefs=${telemetry.preferences_loaded} dnr=${telemetry.dismissed_loaded} degraded=[${degraded.join(',')}]`,
  );

  return {
    ok: degraded.length === 0,
    memory_prompt_block: memoryPromptBlock,
    context_pack: pack,
    preferred_language: extractLanguageFromContextPack(pack),
    goals,
    preferences,
    do_not_repeat: doNotRepeat,
    telemetry,
    error: degraded.length > 0 ? `degraded sources: ${degraded.join(', ')}` : undefined,
  };
}

function emptyContextPack(
  input: BuildAssistantMemoryContextInput,
  threadId: string,
  routerDecision: RetrievalRouterDecision,
): ContextPack {
  return {
    pack_id: `degraded-${Date.now()}`,
    pack_hash: 'degraded',
    assembled_at: new Date().toISOString(),
    assembly_duration_ms: 0,
    identity: {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      role: input.role,
      display_name: input.display_name,
    },
    session_state: {
      thread_id: threadId,
      channel: input.channel,
      turn_number: input.turn_number ?? 0,
      conversation_start: input.conversation_start || new Date().toISOString(),
    },
    memory_hits: [],
    knowledge_hits: [],
    web_hits: [],
    active_vtids: [],
    tenant_policies: [],
    tool_health: [],
    retrieval_trace: {
      router_decision: routerDecision,
      sources_queried: [],
      latencies: { memory_garden: 0, knowledge_hub: 0, web_search: 0, calendar: 0 },
      hit_counts: { memory_garden: 0, knowledge_hub: 0, web_search: 0, calendar: 0 },
    },
    token_budget: { total_budget: 0, used: 0, remaining: 0 },
  };
}

// =============================================================================
// Enforcement — no answer without memory
// =============================================================================

/** Channels where a missing memory block must hard-fail the turn. */
const ENFORCED_CHANNELS = new Set<string>(['orb', 'operator']);

function enforcementEnabled(): boolean {
  // Escape hatch for emergencies only: MEMORY_ORCHESTRATOR_ENFORCEMENT=off
  return (process.env.MEMORY_ORCHESTRATOR_ENFORCEMENT || 'on').toLowerCase() !== 'off';
}

/**
 * Hard gate: call this immediately before the LLM call on every assistant
 * path. If the system instruction does not contain the memory sentinel,
 * the orchestrator step was skipped — emit a bypass event and (for
 * user-facing channels, unless the escape hatch is set) THROW so no
 * un-personalized answer ships.
 */
export function assertMemoryContextInjected(
  systemInstruction: string,
  meta: {
    channel: string;
    user_id?: string;
    tenant_id?: string;
    thread_id?: string;
    caller: string;
  },
): void {
  if (systemInstruction && systemInstruction.includes(MEMORY_CONTEXT_SENTINEL)) {
    return;
  }

  console.error(
    `${LOG_PREFIX} MEMORY SKIPPED — ${meta.caller} attempted an LLM call without the memory block (channel=${meta.channel})`,
  );
  emitOasisEvent({
    vtid: 'MEMORY-ORCHESTRATOR',
    type: MEMORY_ORCHESTRATOR_EVENT_TYPES.BYPASS_DETECTED,
    source: `memory-orchestrator-${meta.channel}`,
    status: 'error',
    message: `Assistant path "${meta.caller}" skipped the memory orchestrator`,
    payload: {
      caller: meta.caller,
      channel: meta.channel,
      user_id: meta.user_id,
      tenant_id: meta.tenant_id,
      thread_id: meta.thread_id,
      enforced: enforcementEnabled() && ENFORCED_CHANNELS.has(meta.channel),
    },
  }).catch(() => {});

  if (enforcementEnabled() && ENFORCED_CHANNELS.has(meta.channel)) {
    throw new Error(
      `MEMORY_ORCHESTRATOR_SKIPPED: assistant path "${meta.caller}" must call buildAssistantMemoryContext() before generating a response (channel=${meta.channel})`,
    );
  }
}

/**
 * Soft detector for the shared LLM executor (processWithGemini): logs +
 * emits a bypass event when an instruction without the sentinel reaches
 * the model, WITHOUT throwing — the executor also serves non-assistant
 * internal callers (classifiers, extractors) that legitimately carry no
 * user memory. Detection makes unknown bypass paths visible on the admin
 * card so they can be wired in, one by one.
 */
export function detectMemoryBypass(
  systemInstruction: string | undefined,
  meta: { threadId?: string; caller: string },
): boolean {
  if (!systemInstruction) return false; // no instruction → internal utility call
  if (systemInstruction.includes(MEMORY_CONTEXT_SENTINEL)) return false;
  // Heuristic: only flag instructions that look like assistant personas —
  // internal utility prompts (classification, extraction) are exempt.
  const looksLikeAssistant = /you are vitana/i.test(systemInstruction);
  if (!looksLikeAssistant) return false;

  console.warn(
    `${LOG_PREFIX} bypass detected — assistant-looking instruction without memory block (caller=${meta.caller}, thread=${meta.threadId || 'n/a'})`,
  );
  emitOasisEvent({
    vtid: 'MEMORY-ORCHESTRATOR',
    type: MEMORY_ORCHESTRATOR_EVENT_TYPES.BYPASS_DETECTED,
    source: 'memory-orchestrator-executor',
    status: 'warning',
    message: `LLM executor received assistant instruction without memory block (${meta.caller})`,
    payload: { caller: meta.caller, thread_id: meta.threadId, enforced: false },
  }).catch(() => {});
  return true;
}

// =============================================================================
// Post-turn telemetry — did the assistant actually USE the memory?
// =============================================================================

const COMMON_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'your', 'have', 'has',
  'für', 'und', 'der', 'die', 'das', 'dein', 'deine', 'mit', 'von',
  'user', 'true', 'false', 'null', 'name', 'goal', 'text', 'value',
]);

/**
 * Cheap lexical heuristic: does the reply reference any distinctive term
 * from the injected memory (fact values, goal text, relationship names,
 * diary snippets, preference values)? Not a semantic judge — a floor
 * signal for the dashboard, so "assistant_used_memory" is never claimed
 * on zero evidence.
 */
export function estimateAssistantUsedMemory(
  memory: Pick<AssistantMemoryContext, 'context_pack' | 'goals' | 'preferences'>,
  reply: string,
): boolean {
  if (!reply) return false;
  const replyLower = reply.toLowerCase();

  const candidateTerms: string[] = [];
  for (const hit of memory.context_pack.memory_hits) {
    // fact content is "fact_key: value" — the value side is the distinctive part
    const valueSide = hit.content.includes(':')
      ? hit.content.slice(hit.content.indexOf(':') + 1)
      : hit.content;
    candidateTerms.push(...valueSide.split(/[\s,.;!?()"']+/));
  }
  for (const g of memory.goals) candidateTerms.push(...g.primary_goal.split(/\s+/));
  for (const p of memory.preferences) candidateTerms.push(...p.value.split(/\s+/));
  for (const rel of memory.context_pack.relationship_context || []) {
    candidateTerms.push(...rel.split(/[\s:()]+/));
  }

  for (const raw of candidateTerms) {
    const term = raw.trim().toLowerCase();
    if (term.length < 4) continue;
    if (COMMON_WORDS.has(term)) continue;
    if (replyLower.includes(term)) return true;
  }
  return false;
}

/**
 * Emit the per-turn proof event AFTER the reply is generated. This is the
 * event the admin "Memory Alive / Memory Dead" card is computed from.
 */
export function emitMemoryTurnTelemetry(
  memory: AssistantMemoryContext,
  turn: {
    tenant_id: string;
    user_id: string;
    channel: string;
    thread_id?: string;
    reply: string;
    model_used?: string;
    vtid?: string;
  },
): void {
  const assistantUsedMemory = estimateAssistantUsedMemory(memory, turn.reply);
  const t = memory.telemetry;
  emitOasisEvent({
    vtid: turn.vtid || 'MEMORY-ORCHESTRATOR',
    type: MEMORY_ORCHESTRATOR_EVENT_TYPES.TURN,
    source: `memory-orchestrator-${turn.channel}`,
    status: t.memory_injected_to_prompt ? 'success' : 'error',
    message: `Memory turn: injected=${t.memory_injected_to_prompt} hits=${t.memory_hits} used=${assistantUsedMemory}`,
    payload: {
      tenant_id: turn.tenant_id,
      user_id: turn.user_id,
      thread_id: turn.thread_id,
      channel: turn.channel,
      model_used: turn.model_used,
      memory_orchestrator_called: t.memory_orchestrator_called,
      memory_hits: t.memory_hits,
      facts_loaded: t.facts_loaded,
      episodic_loaded: t.episodic_loaded,
      diary_loaded: t.diary_loaded,
      goals_loaded: t.goals_loaded,
      preferences_loaded: t.preferences_loaded,
      relationships_loaded: t.relationships_loaded,
      dismissed_loaded: t.dismissed_loaded,
      recent_turns_loaded: t.recent_turns_loaded,
      memory_injected_to_prompt: t.memory_injected_to_prompt,
      assistant_used_memory: assistantUsedMemory,
      degraded_sources: t.degraded_sources,
      memory_latency_ms: t.latency_ms,
    },
  }).catch(() => {});
}
