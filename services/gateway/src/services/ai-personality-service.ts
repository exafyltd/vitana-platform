/**
 * AI Personality Configuration Service
 *
 * Centralizes all AI assistant personality definitions and provides
 * runtime configuration with DB-backed persistence.
 *
 * Architecture:
 * - Hardcoded defaults extracted from source files (fallback)
 * - Supabase `ai_personality_config` table for overrides
 * - 30-second in-memory cache for hot-path reads
 * - OASIS audit events on every change
 *
 * Surfaces:
 * - voice_live:            Gemini Live voice sessions (orb-live.ts)
 * - text_chat:             ORB text chat (orb-live.ts)
 * - unified_conversation:  Unified ORB+Operator brain (conversation-client.ts)
 * - operator_chat:         Operator Console chat (gemini-operator.ts)
 * - dev_orb:               Dev assistant (assistant-service.ts)
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Environment
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// =============================================================================
// Types
// =============================================================================

export type PersonalitySurfaceKey =
  | 'voice_live'
  | 'text_chat'
  | 'unified_conversation'
  | 'operator_chat'
  | 'dev_orb';

export interface PersonalityConfig {
  surface_key: PersonalitySurfaceKey;
  config: Record<string, unknown>;
  is_customized: boolean;
  updated_by: string | null;
  updated_by_role: string | null;
  updated_at: string;
}

export interface PersonalitySurfaceResponse {
  surface_key: PersonalitySurfaceKey;
  config: Record<string, unknown>;
  defaults: Record<string, unknown>;
  is_customized: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

export const VALID_SURFACE_KEYS: PersonalitySurfaceKey[] = [
  'voice_live',
  'text_chat',
  'unified_conversation',
  'operator_chat',
  'dev_orb',
];

// =============================================================================
// Hardcoded Defaults (extracted from source files)
// =============================================================================

export const PERSONALITY_DEFAULTS: Record<PersonalitySurfaceKey, Record<string, unknown>> = {
  voice_live: {
    base_identity: 'You are Vitana, an AI health companion assistant powered by Gemini Live.',
    general_behavior:
      '- Be warm, patient, and empathetic\n- Keep responses concise for voice interaction (2-3 sentences max)\n- Use natural conversational tone',
    greeting_rules:
      '- When the conversation starts, you MUST speak first with a warm, brief greeting\n- Do NOT recite or list remembered information in the greeting\n- Do NOT repeat information from memory context unprompted\n- If you have memory context about the user, you may reference ONE brief detail naturally (e.g. "Hello [name], nice to talk again!")\n- Keep the greeting to 1-2 short sentences maximum\n- If this is a returning user, briefly mention you\'re happy to continue but do NOT summarize previous conversations unless asked\n- NEVER repeat the same greeting or response more than once',
    interruption_handling:
      '- If the user starts speaking while you are talking, STOP immediately\n- Do NOT finish your current sentence - stop mid-word if needed\n- Acknowledge the interruption naturally and listen to the user\n- When you detect audio input while generating output, yield immediately',
    repetition_prevention:
      '- NEVER repeat the same response verbatim\n- If you notice you\'re saying something you already said, stop and say something new\n- Each response must be unique and advance the conversation',
    tools_section:
      '- Use search_memory to recall information the user has shared before\n- Use search_knowledge for Vitana platform and health information\n- Use search_web for current events, news, and external information',
    important_section:
      '- This is a real-time voice conversation\n- Listen actively and respond naturally\n- Confirm important information when needed\n- Use tools to provide accurate, personalized responses',
    role_descriptions: {
      developer:
        "The user's current role is: DEVELOPER.\n- They are a platform developer working on Vitana\n- When they ask about progress, tasks, or VTIDs, provide development-related answers\n- Help with technical questions, code, architecture, and deployment topics\n- Use search_knowledge to look up VTID status, deployment info, and technical documentation",
      admin:
        "The user's current role is: ADMIN.\n- They are a platform administrator\n- Help with system configuration, user management, and platform operations\n- When they ask about status, provide operational and administrative insights\n- Use search_knowledge for platform configuration and admin documentation",
      community:
        "The user's current role is: COMMUNITY.\n- They are a community member\n- Help them connect with other community members, check events, and explore community features\n- Focus on social connections, events, meetups, and community activities\n- Use search_knowledge for community events and member information",
      patient:
        "The user's current role is: PATIENT.\n- They are a health-focused user\n- Focus on medication reminders, health tips, wellness support, and personal health tracking\n- Be warm, patient, and empathetic about health concerns\n- Use search_memory to recall their health history and preferences",
      professional:
        "The user's current role is: PROFESSIONAL.\n- They are a health professional\n- Provide clinical-grade information and professional-level health insights\n- Help with patient management and professional workflows",
      staff:
        "The user's current role is: STAFF.\n- They are a Vitana staff member\n- Help with operational tasks, content management, and platform support",
    },
  },

  text_chat: {
    base_identity_no_memory: 'You are VITANA ORB, a voice-first multimodal assistant.',
    base_identity_with_memory:
      'You are VITANA ORB, a voice-first multimodal assistant with persistent memory.',
    operating_mode:
      '- Voice conversation is primary.\n- Always listening while ORB overlay is open.\n- Read-only: do not mutate system state.\n- Be concise, contextual, and helpful.',
  },

  unified_conversation: {
    orb_instruction:
      'You are Vitana, an intelligent voice assistant. Keep responses concise and conversational for voice interaction.',
    operator_instruction:
      'You are Vitana, an intelligent assistant for the Operator Console. You can be more detailed and use formatting when helpful.',
    common_instructions:
      '- Use the memory context to personalize responses\n- Use knowledge context for Vitana-specific questions\n- Be helpful and accurate',
    instructions_orb: 'Keep responses brief and natural for voice',
    instructions_operator: 'You can use markdown formatting and be more detailed',
  },

  operator_chat: {
    system_prompt:
      'You are a helpful AI assistant with access to the Vitana Autopilot system. You can answer any question and also help manage Vitana tasks.\n\n**Available tools (use when appropriate):**\n- autopilot_create_task: Create a new Autopilot task\n- autopilot_get_status: Check the status of an existing task by VTID\n- autopilot_list_recent_tasks: List recent tasks\n- knowledge_search: Search Vitana documentation (use for Vitana-specific questions like "What is OASIS?", "Explain the Vitana Index", etc.)\n- run_code: Execute JavaScript code for calculations, date math, conversions, data processing\n\n**When to use tools:**\n- Task creation requests (e.g., "Create a task to deploy gateway") → use autopilot_create_task\n- Status checks (e.g., "Status of VTID-0540") → use autopilot_get_status\n- Task listing (e.g., "Show recent tasks") → use autopilot_list_recent_tasks\n- Vitana-specific questions → use knowledge_search\n- Calculations, date math, age calculations, unit conversions → use run_code',
    calculation_directive:
      'IMPORTANT: Always use run_code for ANY calculation:\n- "How old am I?" → run_code\n- "Days between two dates" → run_code\n- "What percentage is X of Y?" → run_code\n- "Convert miles to kilometers" → run_code',
  },

  dev_orb: {
    base_identity:
      'You are the Vitana Global Assistant, a helpful AI assistant for the Vitana development platform.',
    purpose:
      'You help developers understand and navigate the Vitana system. This includes:\n- Explaining system architecture and components\n- Answering questions about the codebase, features, and workflows\n- Providing guidance on how to use the platform\n- Clarifying concepts related to VTIDs, tasks, governance, and deployments',
    guidelines:
      '1. Be concise and helpful - developers appreciate direct answers\n2. Focus on explanations and guidance - do NOT execute actions or create tasks\n3. You are read-only in this context - no side effects\n4. When discussing code or technical concepts, be precise\n5. If you don\'t know something, say so honestly\n6. Reference specific VTIDs, modules, or features when relevant',
    important_section:
      '- This is the Dev ORB assistant, NOT the Operator Chat\n- You cannot create tasks, trigger deployments, or modify system state\n- Your role is purely informational and educational',
  },
};

// =============================================================================
// Cache
// =============================================================================

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  config: PersonalityConfig;
  fetchedAt: number;
}

const configCache = new Map<string, CacheEntry>();

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

export function clearPersonalityCache(key?: string): void {
  if (key) {
    configCache.delete(key);
  } else {
    configCache.clear();
  }
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Get personality config for a surface. Returns DB override or defaults.
 */
export async function getPersonalityConfig(
  surfaceKey: PersonalitySurfaceKey
): Promise<PersonalitySurfaceResponse> {
  const defaults = PERSONALITY_DEFAULTS[surfaceKey];

  // Check cache
  const cached = configCache.get(surfaceKey);
  if (cached && isCacheValid(cached)) {
    return {
      surface_key: surfaceKey,
      config: cached.config.is_customized
        ? (cached.config.config as Record<string, unknown>)
        : defaults,
      defaults,
      is_customized: cached.config.is_customized,
      updated_by: cached.config.updated_by,
      updated_at: cached.config.updated_at,
    };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return {
      surface_key: surfaceKey,
      config: defaults,
      defaults,
      is_customized: false,
      updated_by: null,
      updated_at: null,
    };
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_personality_config?surface_key=eq.${encodeURIComponent(surfaceKey)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      console.warn(`[AI-PERSONALITY] Failed to fetch config for ${surfaceKey}: ${response.status}`);
      return { surface_key: surfaceKey, config: defaults, defaults, is_customized: false, updated_by: null, updated_at: null };
    }

    const rows = (await response.json()) as PersonalityConfig[];
    if (rows.length === 0 || !rows[0].is_customized) {
      // No override — cache the "not customized" state
      const emptyEntry: PersonalityConfig = {
        surface_key: surfaceKey,
        config: {},
        is_customized: false,
        updated_by: null,
        updated_by_role: null,
        updated_at: new Date().toISOString(),
      };
      configCache.set(surfaceKey, { config: emptyEntry, fetchedAt: Date.now() });
      return { surface_key: surfaceKey, config: defaults, defaults, is_customized: false, updated_by: null, updated_at: null };
    }

    const row = rows[0];
    configCache.set(surfaceKey, { config: row, fetchedAt: Date.now() });

    // Merge: DB config overrides defaults field-by-field
    const mergedConfig = { ...defaults, ...(row.config as Record<string, unknown>) };

    return {
      surface_key: surfaceKey,
      config: mergedConfig,
      defaults,
      is_customized: row.is_customized,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    };
  } catch (error) {
    console.error(`[AI-PERSONALITY] Error fetching config for ${surfaceKey}:`, error);
    return { surface_key: surfaceKey, config: defaults, defaults, is_customized: false, updated_by: null, updated_at: null };
  }
}

/**
 * Get personality config synchronously from cache. Falls back to defaults.
 * Used by hot-path prompt builders to avoid async overhead.
 */
export function getPersonalityConfigSync(
  surfaceKey: PersonalitySurfaceKey
): Record<string, unknown> {
  const defaults = PERSONALITY_DEFAULTS[surfaceKey];
  const cached = configCache.get(surfaceKey);
  if (cached && isCacheValid(cached) && cached.config.is_customized) {
    return { ...defaults, ...(cached.config.config as Record<string, unknown>) };
  }
  return defaults;
}

/**
 * Get all personality configs for the settings UI.
 */
export async function getAllPersonalityConfigs(): Promise<PersonalitySurfaceResponse[]> {
  const results: PersonalitySurfaceResponse[] = [];
  for (const key of VALID_SURFACE_KEYS) {
    results.push(await getPersonalityConfig(key));
  }
  return results;
}

/**
 * Update personality config for a surface.
 */
export async function updatePersonalityConfig(
  surfaceKey: PersonalitySurfaceKey,
  newConfig: Record<string, unknown>,
  reason: string,
  updatedBy: string,
  updatedByRole: string
): Promise<{ ok: boolean; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    // Get current config for audit
    const current = await getPersonalityConfig(surfaceKey);

    // Upsert via Supabase REST
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_personality_config`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          surface_key: surfaceKey,
          config: newConfig,
          is_customized: true,
          updated_by: updatedBy,
          updated_by_role: updatedByRole,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AI-PERSONALITY] Failed to update ${surfaceKey}: ${response.status} - ${errorText}`);
      return { ok: false, error: `DB error: ${response.status}` };
    }

    // Write audit record
    await fetch(`${SUPABASE_URL}/rest/v1/ai_personality_config_audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        surface_key: surfaceKey,
        from_config: current.config,
        to_config: newConfig,
        reason,
        updated_by: updatedBy,
        updated_by_role: updatedByRole,
      }),
    }).catch((err) => console.warn('[AI-PERSONALITY] Audit write failed:', err));

    // Emit OASIS event
    await emitOasisEvent({
      vtid: 'AI-PERSONALITY',
      type: 'personality.config.updated' as any,
      source: 'ai-personality-service',
      status: 'info',
      message: `Personality config updated for ${surfaceKey}: ${reason}`,
      payload: { surface_key: surfaceKey, reason, updated_by: updatedBy },
    }).catch(() => {});

    // Invalidate cache
    clearPersonalityCache(surfaceKey);

    console.log(`[AI-PERSONALITY] Config updated for ${surfaceKey} by ${updatedBy}`);
    return { ok: true };
  } catch (error: any) {
    console.error(`[AI-PERSONALITY] Error updating ${surfaceKey}:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Reset personality config to defaults.
 */
export async function resetPersonalityConfig(
  surfaceKey: PersonalitySurfaceKey,
  reason: string,
  updatedBy: string,
  updatedByRole: string
): Promise<{ ok: boolean; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const current = await getPersonalityConfig(surfaceKey);

    // Upsert with is_customized=false and empty config
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_personality_config`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          surface_key: surfaceKey,
          config: {},
          is_customized: false,
          updated_by: updatedBy,
          updated_by_role: updatedByRole,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `DB error: ${response.status} - ${errorText}` };
    }

    // Audit
    await fetch(`${SUPABASE_URL}/rest/v1/ai_personality_config_audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        surface_key: surfaceKey,
        from_config: current.config,
        to_config: PERSONALITY_DEFAULTS[surfaceKey],
        reason: `Reset to defaults: ${reason}`,
        updated_by: updatedBy,
        updated_by_role: updatedByRole,
      }),
    }).catch(() => {});

    await emitOasisEvent({
      vtid: 'AI-PERSONALITY',
      type: 'personality.config.reset' as any,
      source: 'ai-personality-service',
      status: 'info',
      message: `Personality config reset to defaults for ${surfaceKey}`,
      payload: { surface_key: surfaceKey, reason, updated_by: updatedBy },
    }).catch(() => {});

    clearPersonalityCache(surfaceKey);

    console.log(`[AI-PERSONALITY] Config reset for ${surfaceKey} by ${updatedBy}`);
    return { ok: true };
  } catch (error: any) {
    console.error(`[AI-PERSONALITY] Error resetting ${surfaceKey}:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Pre-warm cache on startup
 */
export async function warmPersonalityCache(): Promise<void> {
  console.log('[AI-PERSONALITY] Pre-warming personality config cache...');
  for (const key of VALID_SURFACE_KEYS) {
    await getPersonalityConfig(key).catch(() => {});
  }
  console.log('[AI-PERSONALITY] Cache pre-warmed for', VALID_SURFACE_KEYS.length, 'surfaces');
}
