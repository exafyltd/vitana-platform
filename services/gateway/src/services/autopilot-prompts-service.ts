/**
 * Autopilot Prompts Service - VTID-01089 Autopilot Matchmaking Prompts
 *
 * Business logic for autopilot prompt generation, preferences, and actions.
 * Implements:
 * - User preference management (rate limits, quiet hours, opt-out)
 * - Prompt generation from matches_daily (deterministic, no AI)
 * - Prompt action handling (yes, not_now, options)
 * - OASIS event emission for audit trail
 */

import { randomUUID } from 'crypto';
import {
  AutopilotPrompt,
  PromptPrefs,
  PromptPrefsResponse,
  UpdatePrefsRequest,
  GeneratePromptsRequest,
  GeneratePromptsResponse,
  TodayPromptsResponse,
  PromptActionRequest,
  PromptActionResponse,
  MatchType,
  PromptState,
  PromptActionKey,
  MatchDaily,
  AutopilotPromptEventPayload,
} from '../types/autopilot-prompts';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const VTID = 'VTID-01089';

// ==================== OASIS Event Emission ====================

/**
 * Emit an autopilot prompts event to OASIS
 */
async function emitPromptEvent(
  eventType: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: AutopilotPromptEventPayload
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01089] Supabase not configured, skipping event emit');
    return;
  }

  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  const eventPayload = {
    id: eventId,
    created_at: timestamp,
    vtid: payload.vtid || VTID,
    topic: eventType,
    service: 'autopilot-prompts',
    role: 'AUTOPILOT',
    model: 'matchmaking-prompts',
    status,
    message,
    metadata: payload,
  };

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(eventPayload),
    });

    if (!response.ok) {
      console.warn(`[VTID-01089] Failed to emit event: ${response.status}`);
    } else {
      console.log(`[VTID-01089] Event emitted: ${eventType} (${eventId})`);
    }
  } catch (error) {
    console.warn(`[VTID-01089] Error emitting event:`, error);
  }
}

// ==================== User Preferences ====================

/**
 * Get user prompt preferences
 */
export async function getPromptPrefs(
  tenantId: string,
  userId: string
): Promise<PromptPrefsResponse> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    // Use the helper function to get prefs with computed fields
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_prompt_prefs`;
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        p_tenant_id: tenantId,
        p_user_id: userId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[VTID-01089] Failed to get prefs: ${response.status} - ${errorText}`);

      // Fallback: return defaults if function doesn't exist yet
      return {
        ok: true,
        prefs: {
          id: null,
          enabled: true,
          max_prompts_per_day: 5,
          quiet_hours: null,
          allow_types: ['person', 'group', 'event', 'service'],
          prompts_today: 0,
          in_quiet_hours: false,
        },
      };
    }

    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : rows;

    if (!row) {
      // Return defaults
      return {
        ok: true,
        prefs: {
          id: null,
          enabled: true,
          max_prompts_per_day: 5,
          quiet_hours: null,
          allow_types: ['person', 'group', 'event', 'service'],
          prompts_today: 0,
          in_quiet_hours: false,
        },
      };
    }

    return {
      ok: true,
      prefs: {
        id: row.id,
        enabled: row.enabled,
        max_prompts_per_day: row.max_prompts_per_day,
        quiet_hours: row.quiet_hours,
        allow_types: row.allow_types || ['person', 'group', 'event', 'service'],
        prompts_today: row.prompts_today || 0,
        in_quiet_hours: row.in_quiet_hours || false,
      },
    };
  } catch (error) {
    console.error(`[VTID-01089] Error getting prefs:`, error);
    return { ok: false, error: 'Failed to get preferences' };
  }
}

/**
 * Update user prompt preferences
 */
export async function updatePromptPrefs(
  tenantId: string,
  userId: string,
  updates: UpdatePrefsRequest
): Promise<PromptPrefsResponse> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    // First, check if prefs exist
    const existingUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompt_prefs?tenant_id=eq.${tenantId}&user_id=eq.${userId}&select=id`;
    const existingResp = await fetch(existingUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const existing = await existingResp.json();
    const prefsExist = Array.isArray(existing) && existing.length > 0;

    // Build update/insert payload
    const payload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (updates.enabled !== undefined) {
      payload.enabled = updates.enabled;
    }
    if (updates.max_prompts_per_day !== undefined) {
      payload.max_prompts_per_day = updates.max_prompts_per_day;
    }
    if (updates.quiet_hours !== undefined) {
      payload.quiet_hours = updates.quiet_hours;
    }
    if (updates.allow_types !== undefined) {
      payload.allow_types = updates.allow_types;
    }

    let response: Response;

    if (prefsExist) {
      // Update existing
      const updateUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompt_prefs?tenant_id=eq.${tenantId}&user_id=eq.${userId}`;
      response = await fetch(updateUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(payload),
      });
    } else {
      // Insert new
      const insertPayload = {
        ...payload,
        id: randomUUID(),
        tenant_id: tenantId,
        user_id: userId,
        enabled: updates.enabled ?? true,
        max_prompts_per_day: updates.max_prompts_per_day ?? 5,
        quiet_hours: updates.quiet_hours ?? null,
        allow_types: updates.allow_types ?? ['person', 'group', 'event', 'service'],
        created_at: new Date().toISOString(),
      };

      const insertUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompt_prefs`;
      response = await fetch(insertUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(insertPayload),
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[VTID-01089] Failed to update prefs: ${response.status} - ${errorText}`);
      return { ok: false, error: 'Failed to update preferences' };
    }

    // Emit OASIS event
    await emitPromptEvent(
      'autopilot.prefs.updated',
      'info',
      `Autopilot prompt preferences updated for user ${userId}`,
      {
        vtid: VTID,
        tenant_id: tenantId,
        user_id: userId,
      }
    );

    // Return updated prefs
    return getPromptPrefs(tenantId, userId);
  } catch (error) {
    console.error(`[VTID-01089] Error updating prefs:`, error);
    return { ok: false, error: 'Failed to update preferences' };
  }
}

// ==================== Prompt Generation ====================

/**
 * Fixed message template for prompts (deterministic, no AI)
 */
function generatePromptMessage(topic: string, action: string, targetTitle: string): string {
  return `You're aligned with **${topic}**. Want to **${action}**: **${targetTitle}**?`;
}

/**
 * Get action verb based on match type
 */
function getActionVerb(matchType: MatchType): string {
  switch (matchType) {
    case 'person':
      return 'connect with';
    case 'group':
      return 'join';
    case 'event':
      return 'attend';
    case 'service':
      return 'book';
    case 'product':
      return 'check out';
    case 'location':
      return 'visit';
    default:
      return 'explore';
  }
}

/**
 * Check if current time is in quiet hours
 */
function isInQuietHours(quietHours: { from: string; to: string } | null): boolean {
  if (!quietHours) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [fromHour, fromMin] = quietHours.from.split(':').map(Number);
  const [toHour, toMin] = quietHours.to.split(':').map(Number);

  const fromMinutes = fromHour * 60 + fromMin;
  const toMinutes = toHour * 60 + toMin;

  // Handle overnight quiet hours (e.g., 22:00 to 08:00)
  if (fromMinutes > toMinutes) {
    return currentMinutes >= fromMinutes || currentMinutes < toMinutes;
  } else {
    return currentMinutes >= fromMinutes && currentMinutes < toMinutes;
  }
}

/**
 * Generate prompts from matches_daily for a user
 * Deterministic rules, no AI involved
 */
export async function generatePrompts(
  tenantId: string,
  userId: string,
  options: GeneratePromptsRequest = { score_threshold: 75, limit: 5 }
): Promise<GeneratePromptsResponse> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, generated: 0, error: 'Supabase not configured' };
  }

  try {
    // 1. Get user preferences
    const prefsResult = await getPromptPrefs(tenantId, userId);
    if (!prefsResult.ok || !prefsResult.prefs) {
      return { ok: false, generated: 0, error: 'Failed to get user preferences' };
    }

    const prefs = prefsResult.prefs;

    // 2. Check if prompts are enabled
    if (!prefs.enabled) {
      console.log(`[VTID-01089] Prompts disabled for user ${userId}`);
      return {
        ok: true,
        generated: 0,
        prompts: [],
        rate_limit_info: {
          max_per_day: prefs.max_prompts_per_day,
          used_today: prefs.prompts_today,
          remaining: 0,
        },
      };
    }

    // 3. Check quiet hours
    if (prefs.in_quiet_hours || isInQuietHours(prefs.quiet_hours)) {
      console.log(`[VTID-01089] In quiet hours for user ${userId}`);
      return {
        ok: true,
        generated: 0,
        prompts: [],
        rate_limit_info: {
          max_per_day: prefs.max_prompts_per_day,
          used_today: prefs.prompts_today,
          remaining: prefs.max_prompts_per_day - prefs.prompts_today,
        },
      };
    }

    // 4. Check rate limit
    const remaining = prefs.max_prompts_per_day - prefs.prompts_today;
    if (remaining <= 0) {
      console.log(`[VTID-01089] Rate limit reached for user ${userId}`);
      return {
        ok: true,
        generated: 0,
        prompts: [],
        rate_limit_info: {
          max_per_day: prefs.max_prompts_per_day,
          used_today: prefs.prompts_today,
          remaining: 0,
        },
      };
    }

    // 5. Fetch eligible matches from matches_daily
    // Note: matches_daily is from VTID-01088 (dependency)
    const maxToGenerate = Math.min(remaining, options.limit || 5);
    const allowTypesFilter = prefs.allow_types.map(t => `match_type.eq.${t}`).join(',');
    const today = new Date().toISOString().split('T')[0];

    const matchesUrl = `${SUPABASE_URL}/rest/v1/matches_daily?` +
      `tenant_id=eq.${tenantId}&` +
      `user_id=eq.${userId}&` +
      `match_date=eq.${today}&` +
      `score=gte.${options.score_threshold || 75}&` +
      `state=eq.suggested&` +
      `or=(${allowTypesFilter})&` +
      `order=score.desc&` +
      `limit=${maxToGenerate}`;

    const matchesResp = await fetch(matchesUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    let matches: MatchDaily[] = [];

    if (matchesResp.ok) {
      matches = await matchesResp.json();
    } else {
      // matches_daily table might not exist yet (VTID-01088 dependency)
      console.warn(`[VTID-01089] matches_daily query failed (table may not exist yet): ${matchesResp.status}`);
      matches = [];
    }

    // 6. Filter out matches that already have prompts
    if (matches.length > 0) {
      const matchIds = matches.map(m => m.id);
      const existingUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompts?` +
        `tenant_id=eq.${tenantId}&` +
        `user_id=eq.${userId}&` +
        `match_id=in.(${matchIds.join(',')})&` +
        `select=match_id`;

      const existingResp = await fetch(existingUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      });

      if (existingResp.ok) {
        const existing = await existingResp.json();
        const existingMatchIds = new Set(existing.map((e: any) => e.match_id));
        matches = matches.filter(m => !existingMatchIds.has(m.id));
      }
    }

    // 7. Create prompts for remaining matches
    const generatedPrompts: AutopilotPrompt[] = [];

    for (const match of matches) {
      const promptId = randomUUID();
      const now = new Date().toISOString();
      const actionVerb = getActionVerb(match.match_type);
      const message = generatePromptMessage(match.topic, actionVerb, match.target_title);

      const prompt: AutopilotPrompt = {
        id: promptId,
        tenant_id: tenantId,
        user_id: userId,
        prompt_date: today,
        prompt_type: 'match_suggestion',
        match_id: match.id,
        match_type: match.match_type,
        title: `New ${match.match_type} suggestion`,
        message,
        actions: [
          { key: 'yes', label: 'Yes' },
          { key: 'not_now', label: 'Not now' },
          { key: 'options', label: 'See options' },
        ],
        state: 'shown',
        action_taken: null,
        target_id: match.target_id,
        target_type: match.match_type,
        target_title: match.target_title,
        topic: match.topic,
        created_at: now,
        shown_at: now,
        actioned_at: null,
      };

      // Insert prompt into database
      const insertUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompts`;
      const insertResp = await fetch(insertUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          id: promptId,
          tenant_id: tenantId,
          user_id: userId,
          prompt_date: today,
          prompt_type: 'match_suggestion',
          match_id: match.id,
          match_type: match.match_type,
          title: prompt.title,
          message: prompt.message,
          actions: prompt.actions,
          state: 'shown',
          target_id: match.target_id,
          target_type: match.match_type,
          target_title: match.target_title,
          topic: match.topic,
          created_at: now,
          shown_at: now,
        }),
      });

      if (insertResp.ok) {
        generatedPrompts.push(prompt);

        // Emit OASIS event for each prompt shown
        await emitPromptEvent(
          'autopilot.prompt.shown',
          'info',
          `Autopilot prompt shown: ${prompt.title}`,
          {
            vtid: VTID,
            tenant_id: tenantId,
            user_id: userId,
            prompt_id: promptId,
            match_id: match.id,
            match_type: match.match_type,
          }
        );
      } else {
        console.warn(`[VTID-01089] Failed to insert prompt: ${insertResp.status}`);
      }
    }

    // 8. Emit aggregate event
    if (generatedPrompts.length > 0) {
      await emitPromptEvent(
        'autopilot.prompts.generated',
        'success',
        `Generated ${generatedPrompts.length} autopilot prompts for user ${userId}`,
        {
          vtid: VTID,
          tenant_id: tenantId,
          user_id: userId,
          count: generatedPrompts.length,
        }
      );
    }

    return {
      ok: true,
      generated: generatedPrompts.length,
      prompts: generatedPrompts,
      rate_limit_info: {
        max_per_day: prefs.max_prompts_per_day,
        used_today: prefs.prompts_today + generatedPrompts.length,
        remaining: remaining - generatedPrompts.length,
      },
    };
  } catch (error) {
    console.error(`[VTID-01089] Error generating prompts:`, error);
    return { ok: false, generated: 0, error: 'Failed to generate prompts' };
  }
}

// ==================== Today's Prompts ====================

/**
 * Get today's prompts for a user
 */
export async function getTodayPrompts(
  tenantId: string,
  userId: string
): Promise<TodayPromptsResponse> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return {
      ok: false,
      prompts: [],
      rate_limit_info: { max_per_day: 5, used_today: 0, remaining: 5, in_quiet_hours: false },
      error: 'Supabase not configured',
    };
  }

  try {
    // Get preferences
    const prefsResult = await getPromptPrefs(tenantId, userId);
    const prefs = prefsResult.prefs || {
      max_prompts_per_day: 5,
      prompts_today: 0,
      in_quiet_hours: false,
    };

    // Get today's prompts
    const today = new Date().toISOString().split('T')[0];
    const promptsUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompts?` +
      `tenant_id=eq.${tenantId}&` +
      `user_id=eq.${userId}&` +
      `prompt_date=eq.${today}&` +
      `order=created_at.desc`;

    const promptsResp = await fetch(promptsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!promptsResp.ok) {
      const errorText = await promptsResp.text();
      console.warn(`[VTID-01089] Failed to get prompts: ${promptsResp.status} - ${errorText}`);
      return {
        ok: true,
        prompts: [],
        rate_limit_info: {
          max_per_day: prefs.max_prompts_per_day,
          used_today: 0,
          remaining: prefs.max_prompts_per_day,
          in_quiet_hours: prefs.in_quiet_hours || false,
        },
      };
    }

    const prompts = await promptsResp.json();

    return {
      ok: true,
      prompts,
      rate_limit_info: {
        max_per_day: prefs.max_prompts_per_day,
        used_today: prompts.length,
        remaining: Math.max(0, prefs.max_prompts_per_day - prompts.length),
        in_quiet_hours: prefs.in_quiet_hours || false,
      },
    };
  } catch (error) {
    console.error(`[VTID-01089] Error getting today's prompts:`, error);
    return {
      ok: false,
      prompts: [],
      rate_limit_info: { max_per_day: 5, used_today: 0, remaining: 5, in_quiet_hours: false },
      error: 'Failed to get prompts',
    };
  }
}

// ==================== Prompt Actions ====================

/**
 * Execute an action on a prompt
 */
export async function executePromptAction(
  tenantId: string,
  userId: string,
  promptId: string,
  action: PromptActionRequest
): Promise<PromptActionResponse> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, prompt_id: promptId, action: action.action, new_state: 'shown', error: 'Supabase not configured' };
  }

  try {
    // 1. Get the prompt
    const promptUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompts?` +
      `id=eq.${promptId}&` +
      `tenant_id=eq.${tenantId}&` +
      `user_id=eq.${userId}&` +
      `select=*`;

    const promptResp = await fetch(promptUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!promptResp.ok) {
      return { ok: false, prompt_id: promptId, action: action.action, new_state: 'shown', error: 'Failed to get prompt' };
    }

    const prompts = await promptResp.json();
    if (!prompts || prompts.length === 0) {
      return { ok: false, prompt_id: promptId, action: action.action, new_state: 'shown', error: 'Prompt not found' };
    }

    const prompt: AutopilotPrompt = prompts[0];

    // 2. Determine new state and execute action
    let newState: PromptState = prompt.state;
    let actionResult: PromptActionResponse['action_result'];
    let options: PromptActionResponse['options'];

    switch (action.action) {
      case 'yes':
        newState = 'accepted';
        actionResult = await executeYesAction(tenantId, userId, prompt);
        break;

      case 'not_now':
        newState = 'dismissed';
        break;

      case 'options':
        // Options action doesn't change state, just returns candidates
        options = await getTopCandidates(tenantId, userId, prompt.match_type || 'person', prompt.topic || '');
        break;
    }

    // 3. Update prompt state (except for 'options' which doesn't change state)
    if (action.action !== 'options') {
      const updateUrl = `${SUPABASE_URL}/rest/v1/autopilot_prompts?id=eq.${promptId}`;
      const updateResp = await fetch(updateUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          state: newState,
          action_taken: action.action,
          actioned_at: new Date().toISOString(),
        }),
      });

      if (!updateResp.ok) {
        console.warn(`[VTID-01089] Failed to update prompt state: ${updateResp.status}`);
      }
    }

    // 4. Emit OASIS event
    const eventType = action.action === 'yes'
      ? 'autopilot.prompt.action.accepted'
      : action.action === 'not_now'
        ? 'autopilot.prompt.action.dismissed'
        : 'autopilot.prompt.action.options_opened';

    await emitPromptEvent(
      eventType,
      action.action === 'yes' ? 'success' : 'info',
      `Prompt action: ${action.action} on ${prompt.title}`,
      {
        vtid: VTID,
        tenant_id: tenantId,
        user_id: userId,
        prompt_id: promptId,
        match_id: prompt.match_id || undefined,
        match_type: prompt.match_type || undefined,
        action: action.action,
      }
    );

    return {
      ok: true,
      prompt_id: promptId,
      action: action.action,
      new_state: newState,
      action_result: actionResult,
      options,
    };
  } catch (error) {
    console.error(`[VTID-01089] Error executing prompt action:`, error);
    return { ok: false, prompt_id: promptId, action: action.action, new_state: 'shown', error: 'Failed to execute action' };
  }
}

/**
 * Execute the 'yes' action based on match type
 */
async function executeYesAction(
  tenantId: string,
  userId: string,
  prompt: AutopilotPrompt
): Promise<PromptActionResponse['action_result']> {
  const targetId = prompt.target_id;
  const targetType = prompt.target_type || prompt.match_type || 'person';

  if (!targetId) {
    return {
      type: 'interest_saved',
      target_id: '',
      target_type: targetType,
      success: false,
      message: 'No target specified',
    };
  }

  // Determine action type based on match type
  let actionType: 'connection_request' | 'group_join' | 'event_rsvp' | 'interest_saved';

  switch (targetType) {
    case 'person':
      actionType = 'connection_request';
      // TODO: Create relationship edge with pending state
      // For now, log the intent
      console.log(`[VTID-01089] Connection request: ${userId} -> ${targetId}`);
      break;

    case 'group':
      actionType = 'group_join';
      // TODO: Add user to group
      console.log(`[VTID-01089] Group join: ${userId} -> ${targetId}`);
      break;

    case 'event':
      actionType = 'event_rsvp';
      // TODO: Create RSVP/attendance record
      console.log(`[VTID-01089] Event RSVP: ${userId} -> ${targetId}`);
      break;

    case 'service':
    case 'product':
    case 'location':
    default:
      actionType = 'interest_saved';
      // TODO: Create interest edge
      console.log(`[VTID-01089] Interest saved: ${userId} -> ${targetId} (${targetType})`);
      break;
  }

  return {
    type: actionType,
    target_id: targetId,
    target_type: targetType,
    success: true,
    message: `Action ${actionType} recorded`,
  };
}

/**
 * Get top candidates for 'options' action
 */
async function getTopCandidates(
  tenantId: string,
  userId: string,
  matchType: MatchType,
  topic: string
): Promise<PromptActionResponse['options']> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return [];
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    // Query matches_daily for top 5 same type
    const matchesUrl = `${SUPABASE_URL}/rest/v1/matches_daily?` +
      `tenant_id=eq.${tenantId}&` +
      `user_id=eq.${userId}&` +
      `match_date=eq.${today}&` +
      `match_type=eq.${matchType}&` +
      `state=eq.suggested&` +
      `order=score.desc&` +
      `limit=5`;

    const matchesResp = await fetch(matchesUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!matchesResp.ok) {
      console.warn(`[VTID-01089] Failed to get candidates: ${matchesResp.status}`);
      return [];
    }

    const matches = await matchesResp.json();

    return matches.map((m: MatchDaily) => ({
      id: m.id,
      type: m.match_type,
      title: m.target_title,
      score: m.score,
      topic: m.topic,
    }));
  } catch (error) {
    console.error(`[VTID-01089] Error getting candidates:`, error);
    return [];
  }
}
