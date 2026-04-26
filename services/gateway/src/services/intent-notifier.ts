/**
 * VTID-01973: Intent notifier (P2-A stub).
 *
 * P2-A baseline: emit OASIS audit event only — no push notifications yet.
 * P2-B wires this to the FCM/Appilix push pipeline via notification-service.ts
 * with per-kind frequency caps in Redis. P2-A keeps the surface stable so
 * the intents route can call it without conditional code.
 */

import { emitOasisEvent } from './oasis-event-service';
import type { MatchRow } from './intent-matcher';

interface NotifyArgs {
  match: MatchRow;
  kind: string;
}

/**
 * Audit-only notification for P2-A. Emits an OASIS event so the dashboard
 * can count surfaced matches; no user-facing push.
 */
export async function notifyMatchSurfaced(args: NotifyArgs): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01973',
    type: 'voice.message.sent', // P2-A reuses an existing audit type; P2-B introduces 'intent_match_found_for_dictator' etc.
    source: 'intent-notifier',
    status: 'info',
    message: `Intent match surfaced: ${args.match.kind_pairing} score=${args.match.score}`,
    payload: {
      match_id: args.match.match_id,
      intent_a_id: args.match.intent_a_id,
      intent_b_id: args.match.intent_b_id,
      score: args.match.score,
      compass_aligned: args.match.compass_aligned,
      // P2-A: no push side-effect.
      pushed: false,
    },
    actor_id: undefined,
    surface: 'api',
    vitana_id: args.match.vitana_id_a ?? undefined,
  });
}
