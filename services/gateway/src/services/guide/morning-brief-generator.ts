/**
 * Companion Phase H.3 — Morning Brief generator (VTID-01949)
 *
 * Assembles a one-notification morning brief for a single user from:
 *   - UserAwareness (tenure + journey + last_interaction + recent_activity + community_signals)
 *   - Priority rule engine (re-uses priority-rules.ts for body copy)
 *
 * Returns { title, body, data } or null when the user should NOT receive
 * a brief today (paused, just spoke to ORB, nothing meaningful to say).
 */

import { getAwarenessContext } from './awareness-context';
import { resolvePriorityMessage } from './priority-rules';
import { canSurfaceProactively } from './presence-pacer';
import type { NotificationPayload } from '../notification-service';

export interface MorningBriefInput {
  user_id: string;
  tenant_id: string;
  user_name?: string | null;
  now?: Date;
}

export interface MorningBriefOutput extends NotificationPayload {
  reason_tag: string;
  variant: string;
  bucket: string | null;
}

/**
 * Decides whether to send a brief and what to say.
 * Returns null when the brief should be skipped.
 */
export async function buildMorningBrief(
  input: MorningBriefInput
): Promise<MorningBriefOutput | null> {
  const now = input.now || new Date();

  // Pacer guard — respects pauses, daily caps, per-surface cooldowns
  const decision = await canSurfaceProactively(input.user_id, 'morning_brief');
  if (!decision.allow) return null;

  const awareness = await getAwarenessContext(input.user_id, input.tenant_id);

  // If the user opened ORB already today, skip the brief — the conversation
  // itself satisfies the "daily touch" purpose.
  const bucket = awareness.last_interaction?.bucket;
  if (bucket === 'reconnect' || bucket === 'recent' || bucket === 'same_day') {
    return null;
  }

  // Pull priority message for the body — same rules that power the Home card
  const priority = resolvePriorityMessage({
    awareness,
    now,
    user_name: input.user_name ?? null,
  });

  // Fabricate the title — short, warm, awareness-driven
  const firstName = (input.user_name || '').split(' ')[0] || '';
  const timeOfDay = pickGreeting(now);
  const title = firstName
    ? `${timeOfDay}, ${firstName}`
    : `${timeOfDay}`;

  // Body = priority message; truncate for notification width
  const body = priority.message.length > 140
    ? priority.message.slice(0, 137) + '…'
    : priority.message;

  return {
    title,
    body,
    data: {
      kind: 'morning_brief',
      reason_tag: priority.reason_tag,
      variant: priority.variant,
      cta_url: priority.cta_url || '/',
    },
    reason_tag: priority.reason_tag,
    variant: priority.variant,
    bucket: bucket || null,
  };
}

function pickGreeting(now: Date): string {
  const hr = now.getUTCHours();
  if (hr < 12) return 'Good morning';
  if (hr < 18) return 'Good afternoon';
  return 'Good evening';
}
