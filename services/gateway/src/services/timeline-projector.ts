/**
 * Timeline Projector - BOOTSTRAP-HISTORY-AWARE-TIMELINE
 *
 * Fans user-observable backend events into `user_activity_log` so the
 * /memory/timeline screen and the UserContextProfiler read a single source
 * of truth. Writes are fire-and-forget — caller paths (emitOasisEvent,
 * diary create, recommendation interaction) MUST NOT block on this.
 *
 * Design choices (see plan `we-were-always-talking-optimized-owl.md`):
 *   - No new canonical table; `user_activity_log` already exists and is read
 *     by the frontend timeline hook.
 *   - No DB triggers; Supabase IO pressure history makes app-level fan-in safer.
 *   - No queue/retry; oasis_events remains source of truth for backend events.
 *   - Bumps `user_profiler_version` so the in-proc profiler cache invalidates
 *     on new activity without TTL-only eviction.
 */
import { randomUUID } from 'crypto';

const PROJECTOR_DISABLED = process.env.TIMELINE_PROJECTOR_ENABLED === 'false';

interface ProjectorInput {
  user_id: string;
  activity_type: string;
  activity_data?: Record<string, unknown>;
  context_data?: Record<string, unknown>;
  dedupe_key?: string;
  source: string;
  session_id?: string;
}

/**
 * Map an OASIS event topic to a user-facing activity_type.
 * Returns null for topics that don't belong on a user timeline
 * (CICD, deploy, governance — those stay in oasis_events only).
 *
 * Kept in sync with the frontend `ACTIVITY_TYPE_CONFIG` in vitana-v1's
 * useActivityHistory.ts by prefix; exact codes are preserved where the
 * frontend has specific renderers, otherwise we pass the topic through
 * and let the prefix-fallback handle rendering.
 */
export function mapOasisTopicToActivityType(topic: string): string | null {
  if (!topic) return null;
  const t = topic.toLowerCase();

  // Autopilot lifecycle → autopilot.*
  if (t.startsWith('autopilot.recommendation.')) {
    if (t.endsWith('.accepted') || t.endsWith('.accept')) return 'autopilot.action.execute';
    if (t.endsWith('.dismissed') || t.endsWith('.dismiss')) return 'autopilot.action.dismiss';
    if (t.endsWith('.snoozed') || t.endsWith('.snooze')) return 'autopilot.action.snooze';
    if (t.endsWith('.selected') || t.endsWith('.select')) return 'autopilot.action.select';
    return 'autopilot.action.update';
  }
  if (t.startsWith('autopilot.')) return t;

  // ORB session lifecycle
  if (t === 'orb.session.started' || t === 'orb.live.session.start' || t === 'vtid.live.session.start') {
    return 'orb.session.start';
  }
  if (t === 'orb.session.stopped' || t === 'orb.live.session.stop' || t === 'vtid.live.session.stop') {
    return 'orb.session.stop';
  }
  if (t.startsWith('orb.') || t.startsWith('vtid.live.')) return t.replace('vtid.live.', 'orb.');

  // Recommendation interactions
  if (t.startsWith('recommendation.interaction.')) return t;
  if (t.startsWith('recommendation.')) return t;

  // Task lifecycle (user-owned tasks only — CICD vtid.* events are filtered below)
  if (t === 'task.intake' || t === 'task.created') return 'task.create';
  if (t === 'task.completed') return 'task.complete';
  if (t === 'task.approved') return 'task.approve';
  if (t === 'task.rejected') return 'task.reject';
  if (t.startsWith('task.')) return t;

  // Diary
  if (t.startsWith('diary.')) return t;

  // Memory
  if (t === 'memory.promote' || t.startsWith('memory.')) return t;

  // Community rooms / events
  if (t.startsWith('community.room.')) return t.replace('community.room.', 'community.live.');
  if (t.startsWith('community.event.')) return t;

  // Health
  if (t.startsWith('health.biomarker.')) return t;
  if (t.startsWith('health.')) return t;

  // Everything else — CICD, governance, deploy, worker, spec — NOT user timeline material
  return null;
}

/**
 * Write a single row to user_activity_log with idempotent dedupe.
 * Fire-and-forget. Never throws; errors are logged but swallowed so
 * user-facing code paths are never blocked.
 */
export async function writeTimelineRow(input: ProjectorInput): Promise<void> {
  if (PROJECTOR_DISABLED) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !supabaseKey) return;

  if (!input.user_id || !input.activity_type) return;

  // Basic constraint guard so we don't trigger CHECK violations.
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/.test(input.activity_type)) {
    console.warn(`[TimelineProjector] invalid activity_type skipped: ${input.activity_type}`);
    return;
  }

  // VTID-01969: denormalize actor_vitana_id so support tooling and Voice Lab
  // can render @<id> without joining profiles. Cached lookup is null-tolerant.
  let actorVitanaId: string | null = null;
  try {
    const { resolveVitanaId } = await import('../middleware/auth-supabase-jwt');
    actorVitanaId = await resolveVitanaId(input.user_id);
  } catch {
    // Silent — fallback is null, support reads still work via user_id join.
  }

  const row: Record<string, unknown> = {
    id: randomUUID(),
    user_id: input.user_id,
    activity_type: input.activity_type,
    activity_data: input.activity_data || {},
    context_data: input.context_data || {},
    dedupe_key: input.dedupe_key,
    session_id: input.session_id,
    source: input.source,
    ...(actorVitanaId && { actor_vitana_id: actorVitanaId }),
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/user_activity_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!response.ok && response.status !== 409) {
      const errText = await response.text().catch(() => '');
      // Silent for CHECK violations (23514) during the rollout window;
      // loud for anything else.
      if (!errText.includes('chk_activity_type')) {
        console.warn(`[TimelineProjector] insert failed ${response.status}: ${errText.slice(0, 200)}`);
      }
      return;
    }

    // Bump profiler cache version. Best-effort; ignore failures.
    bumpProfilerVersion(supabaseUrl, supabaseKey, input.user_id).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.warn(`[TimelineProjector] network error: ${msg}`);
  }
}

async function bumpProfilerVersion(supabaseUrl: string, supabaseKey: string, userId: string): Promise<void> {
  try {
    const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/bump_user_profiler_version`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (rpc.ok) return;
  } catch {
    // fallthrough
  }

  // RPC not available — upsert via PostgREST.
  try {
    await fetch(`${supabaseUrl}/rest/v1/user_profiler_version?on_conflict=user_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ user_id: userId, updated_at: new Date().toISOString() }),
    });
  } catch {
    // Best-effort — the profiler TTL will cover us.
  }
}

/**
 * Project an OASIS event onto the user timeline.
 * Called by emitOasisEvent after a successful write. Never throws.
 */
export async function projectOasisEventToTimeline(params: {
  topic: string;
  actor_id?: string;
  event_id?: string;
  status?: string;
  message?: string;
  payload?: Record<string, unknown>;
  surface?: string;
  conversation_turn_id?: string;
}): Promise<void> {
  if (!params.actor_id) return; // CICD events without a user have no business on a user timeline
  const activityType = mapOasisTopicToActivityType(params.topic);
  if (!activityType) return;

  await writeTimelineRow({
    user_id: params.actor_id,
    activity_type: activityType,
    activity_data: {
      message: params.message,
      status: params.status,
      ...(params.payload || {}),
    },
    context_data: {
      surface: params.surface,
      conversation_turn_id: params.conversation_turn_id,
      original_topic: params.topic,
    },
    dedupe_key: params.event_id ? `oasis:${params.event_id}` : undefined,
    source: 'projector:oasis_events',
  });
}
