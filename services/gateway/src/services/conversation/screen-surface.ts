/**
 * Conversation Flow — screen awareness & action completion.
 *
 * Vitana must know WHICH screen the user is on before it speaks, and once the
 * user is on a screen (especially one Vitana just sent them to), the next step
 * must go DEEPER toward COMPLETING the action there — never bounce the user
 * elsewhere or re-suggest "go look at X" while they are already on X.
 *
 *   on /matches  → pick a match & start a joint activity / explain who one is /
 *                  suggest an activity for their Vitana Index / refine match
 *                  criteria / enrich the profile for better matches
 *   on /chat     → actually send the reply
 *   on compose   → actually write & publish the post / activity
 *   on /diary    → make today's entry now (it lifts the Index)
 *   on /index    → the concrete action to raise it (weakest pillar)
 *
 * The current screen comes from `session.current_route` (sent by the client at
 * session start and kept fresh on navigation). This module maps a route to a
 * coarse ConversationSurface and supplies the screen's completion action.
 */

import type { NextBestAction, NbaKey } from './next-best-action';
import { capabilityForNba } from './next-best-action';

export type ConversationSurface =
  | 'matches'
  | 'community'
  | 'chat'
  | 'diary'
  | 'index'
  | 'profile'
  | 'journey'
  | 'news'
  | 'home'
  | 'other';

/** Map a client route to a coarse conversation surface. Best-effort substring
 *  matching against the community-app route names; unknown → 'other'. */
export function surfaceForRoute(route: string | null | undefined): ConversationSurface {
  const r = (route || '').toLowerCase();
  if (!r) return 'other';
  // Order matters — check the more specific routes first.
  if (/(^|\/)(matches|matchmaker|discover-matches)\b/.test(r)) return 'matches';
  if (/(^|\/)(chat|messages|inbox|dm)\b/.test(r)) return 'chat';
  if (/(^|\/)(diary|journal)\b/.test(r)) return 'diary';
  if (/(^|\/)(vitana-index|longevity-index|health-index|index|pillars)\b/.test(r)) return 'index';
  if (/(^|\/)(profile|my-profile|account)\b/.test(r)) return 'profile';
  if (/(^|\/)(my-journey|journey|sessions|guided)\b/.test(r)) return 'journey';
  if (/(^|\/)(news|longevity-news|feed)\b/.test(r)) return 'news';
  if (/(^|\/)(community|posts?|activities|activity|create-post|compose)\b/.test(r)) return 'community';
  if (r === '/' || /(^|\/)(home|dashboard|overview)\b/.test(r)) return 'home';
  return 'other';
}

/**
 * The DEEPER, completion-oriented next step when the user is already on a given
 * surface. The `detail` lists the concrete on-screen moves the model can offer
 * (it should pick ONE and propose it as the next step), and `redirect_key` is
 * the "go to this screen" NBA that must be SUPPRESSED while the user is already
 * here (so Vitana never says "let's look at your matches" on the matches screen).
 */
export interface ScreenCompletion {
  action: NextBestAction;
  /** The redirect-style NBA key to drop while on this surface (already here). */
  redirect_key: NbaKey | null;
}

const COMPLETION_BAND = 115; // above every redirect/discovery action

export function screenCompletionFor(surface: ConversationSurface): ScreenCompletion | null {
  const comp = _rawScreenCompletion(surface);
  // Attach the executing tool (capability-gating) so the opener tells the model
  // to CALL it on acceptance — completing the action, not just describing it.
  if (comp) comp.action.capability = capabilityForNba(comp.action.key);
  return comp;
}

function _rawScreenCompletion(surface: ConversationSurface): ScreenCompletion | null {
  switch (surface) {
    case 'matches':
      return {
        redirect_key: 'review_matches',
        action: {
          key: 'complete_matches',
          domain: 'community',
          band: COMPLETION_BAND,
          detail:
            'pick ONE of the matches and start a joint activity, OR tell the user who one match is, OR suggest an activity that also helps their Vitana Index, OR refine the match criteria, OR add info to the profile for better matches',
          rationale:
            'The user is ON the matches screen — help them ACT on a specific match (start an activity / learn about a person / refine search / enrich profile), never tell them to "open matches".',
        },
      };
    case 'chat':
      return {
        redirect_key: 'reply_messages',
        action: {
          key: 'complete_chat',
          domain: 'community',
          band: COMPLETION_BAND,
          detail: 'help the user actually write and send a reply in the open conversation',
          rationale: 'The user is ON the chat screen — help them compose and send the message, not navigate to it.',
        },
      };
    case 'community':
      return {
        redirect_key: 'make_post',
        action: {
          key: 'complete_post',
          domain: 'community',
          band: COMPLETION_BAND,
          detail: 'help the user draft and publish a post or create an activity others can join, right now',
          rationale: 'The user is ON the community/compose screen — help them finish and publish, not navigate to it.',
        },
      };
    case 'diary':
      return {
        redirect_key: 'diary_entry',
        action: {
          key: 'complete_diary',
          domain: 'health',
          band: COMPLETION_BAND,
          detail: 'help the user make today’s diary entry now (a quick note lifts the Vitana Index)',
          rationale: 'The user is ON the diary screen — help them capture an entry, not navigate to it.',
        },
      };
    case 'index':
      return {
        redirect_key: 'focus_pillar',
        action: {
          key: 'complete_index',
          domain: 'health',
          band: COMPLETION_BAND,
          detail: 'propose ONE concrete action on the weakest pillar that will raise the Vitana Index, and offer to set it up',
          rationale: 'The user is ON the Index screen — propose a concrete action to raise it, not navigate to it.',
        },
      };
    case 'profile':
      return {
        redirect_key: null,
        action: {
          key: 'complete_profile',
          domain: 'community',
          band: COMPLETION_BAND,
          detail: 'help the user add one more piece of profile info so others see more of them and matches improve',
          rationale: 'The user is ON the profile screen — help them enrich it, which improves match quality.',
        },
      };
    // journey / news / home / other → no specific on-screen completion; the
    // normal value-ranked next step applies.
    default:
      return null;
  }
}
