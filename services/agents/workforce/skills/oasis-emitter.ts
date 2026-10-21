/**
 * OASIS Event Emitter for Skills - VTID-01164
 *
 * Utility for emitting OASIS events from skill handlers.
 * Provides a consistent interface for skill telemetry.
 */

import { OasisEventStatus } from './types';

/**
 * OASIS Event payload structure
 */
interface OasisEventPayload {
  vtid: string;
  type: string;
  source: string;
  status: OasisEventStatus;
  message: string;
  payload: Record<string, unknown>;
}

/**
 * Emit an OASIS event
 */
export async function emitSkillEvent(
  event: OasisEventPayload
): Promise<{ ok: boolean; event_id?: string; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Skill Event] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE - event not emitted');
    // Return success to avoid blocking skill execution
    return { ok: true, event_id: 'mock-' + Date.now() };
  }

  const eventId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const payload = {
    id: eventId,
    created_at: timestamp,
    vtid: event.vtid,
    topic: event.type,
    service: event.source,
    role: 'WORKER',
    model: 'skill-pack-v1',
    status: event.status,
    message: event.message,
    link: null,
    metadata: event.payload || {},
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Skill Event] Failed to emit event: ${response.status} - ${errorText}`);
      return { ok: false, error: `Failed to emit event: ${response.status}` };
    }

    console.log(`[Skill Event] Emitted: ${event.type} for ${event.vtid} (${eventId})`);
    return { ok: true, event_id: eventId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Skill Event] Error emitting event: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Create a skill context emitter for a specific skill
 */
export function createSkillEmitter(
  vtid: string,
  skillId: string,
  domain: string
) {
  return async (
    stage: string,
    status: OasisEventStatus,
    message: string,
    payload: Record<string, unknown> = {}
  ) => {
    return emitSkillEvent({
      vtid,
      type: `vtid.stage.worker_${domain}.${skillId.split('.').pop()}.${stage}`,
      source: `worker-${domain}`,
      status,
      message,
      payload: {
        ...payload,
        skill_id: skillId,
        emitted_at: new Date().toISOString(),
      },
    });
  };
}
