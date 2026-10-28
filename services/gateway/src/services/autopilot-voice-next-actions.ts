/**
 * VTID-02969: Voice next-action resolver.
 *
 * After a voice tool completes (e.g. tool_send_chat_message), we want to
 * offer the user the next action they would most plausibly take. The
 * canonical source for that is the Autopilot recommendations system —
 * the same one driving the Autopilot popup. This module fetches the
 * user's top recommendations from that single source and projects them
 * into a small, voice-friendly NextAction shape that voice tool
 * responses embed under `next_actions`.
 *
 * Hard rules:
 *   - One source. Uses queryRecommendationsByRole (the same function the
 *     /api/v1/autopilot/recommendations HTTP route uses). Never invent
 *     suggestions client-side or in the prompt.
 *   - Read path mirrors the popup. For community-role users we apply the
 *     same index-pillar-weighter re-rank the popup applies, so the voice
 *     surface and the visual surface always agree on the top pick.
 *   - Tool result, not prompt. Returned actions ride on the tool JSON
 *     result; Gemini Live's MESSAGING_CONTRACT instructs the model to
 *     verbalize ONLY tool-provided next_actions and never to invent one.
 *   - Degrades silently. Any error (RPC failure, ranker exception,
 *     missing creds) returns [] so the send itself never fails because
 *     of a follow-up suggestion.
 */

import { queryRecommendationsByRole } from '../routes/autopilot-recommendations';

export type NextActionType = 'activate_recommendation';
export type NextActionSource = 'autopilot';

export interface NextAction {
  /** Stable id of the underlying action — for activate_recommendation, this is autopilot_recommendations.id. */
  id: string;
  /** The tool Gemini should dispatch if the user accepts this action. */
  type: NextActionType;
  /** Short, voice-friendly label Gemini may speak verbatim. */
  label: string;
  /** Where the action came from. For now only 'autopilot'. */
  source: NextActionSource;
}

const VOICE_LABEL_MAX = 80; // keep voice utterances tight

function truncateLabel(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= VOICE_LABEL_MAX) return trimmed;
  return trimmed.slice(0, VOICE_LABEL_MAX - 1).trimEnd() + '…';
}

/**
 * Fetch the user's top N autopilot recommendations and project to
 * NextAction shape suitable for voice tool responses. Never throws —
 * returns [] on any internal failure (caller does not need a try/catch).
 *
 * @param args.user_id   Sender's user_id. Required for community role.
 * @param args.role      'community' | 'developer' | 'admin'. Picks the
 *                       filter used by queryRecommendationsByRole.
 * @param args.limit     Maximum NextActions to return. Clamped to [1, 3].
 */
export async function getTopAutopilotNextActions(args: {
  user_id: string;
  role?: string | null;
  limit?: number;
}): Promise<NextAction[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 1, 3));
  const role = (args.role ?? 'community').toLowerCase();
  try {
    // We fetch a few extra so the ranker has signal to pick from, then
    // trim to `limit` after re-rank. Community role goes through the
    // index-pillar-weighter to match the popup ordering.
    const fetchLimit = Math.max(limit * 3, 5);
    const result = await queryRecommendationsByRole(role, args.user_id, ['new'], fetchLimit, 0);
    if (!result.ok || !result.data || result.data.length === 0) {
      return [];
    }
    let recs = result.data as Array<{
      id: string;
      title?: string | null;
      summary?: string | null;
    }>;

    if (role === 'community') {
      try {
        const { buildRankerContext, rankBatch } = await import(
          './recommendation-engine/ranking/index-pillar-weighter'
        );
        const { createClient } = await import('@supabase/supabase-js');
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE;
        if (url && key) {
          const svc = createClient(url, key);
          const ctx = await buildRankerContext(svc, args.user_id);
          // rankBatch accepts the raw recommendation array (untyped — the
          // popup path treats it as any too, see autopilot-recommendations
          // route line ~507).
          const ranked = rankBatch(recs as any, ctx) as Array<{ rec: any }>;
          recs = ranked.map((r) => r.rec) as typeof recs;
        }
      } catch {
        // Rank failure is non-fatal — fall back to query ordering.
      }
    }

    const actions: NextAction[] = [];
    for (const rec of recs.slice(0, limit)) {
      if (!rec.id) continue;
      const label = truncateLabel(rec.title ?? rec.summary ?? '');
      if (!label) continue;
      actions.push({
        id: rec.id,
        type: 'activate_recommendation',
        label,
        source: 'autopilot',
      });
    }
    return actions;
  } catch {
    // Total degradation — voice send must NOT fail because next_actions
    // could not be fetched.
    return [];
  }
}
