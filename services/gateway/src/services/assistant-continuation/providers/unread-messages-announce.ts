/**
 * BOOTSTRAP-ORB-UNREAD-MESSAGES-NAV — Unread-messages announce provider.
 *
 * Reported live: Vitana opens with "schön dich wiederzusehen. Ich zeige dir
 * die neuesten Nachrichten" and then just listens — no inbox ever opens.
 * Root cause, confirmed by reading every provider registered on `orb_wake`
 * (wake-brief-wiring.ts): NONE of them was grounded in real unread-message
 * data. The line the user heard was the model's own paraphrase of whatever
 * generic content won that turn (most likely login-briefing's routine
 * recap) — "Nachrichten" is ambiguous in German between "messages" and
 * "news", and nothing forced the navigate tool call regardless of which the
 * model meant. That is a `grounded-or-silent` violation of the same kind
 * this codebase already fixed once in voice-wake-brief.ts
 * (BOOTSTRAP-ORB-NO-HARDCODED-GREETING) — a provider was implicitly
 * "speaking" about unread messages without ever having queried them.
 *
 * This provider is the actual grounded signal: it queries real unread
 * `chat_messages`, names the sender(s) when there are 1-2, and requests a
 * DETERMINISTIC navigate effect via `cta.type === 'navigate'` (the same
 * shape first-time-welcome/index.ts already uses) so opening the inbox is
 * never left to the model's discretion — see compute-greeting-decision.ts's
 * `wakeBriefNavigateCta` / `GreetingEffects.navigateEffect`, and the
 * `handleNavigateToScreen` dispatch in routes/orb-live.ts's `_renderSync`.
 *
 * Priority 93.5 — between login-briefing (93, the routine journey recap)
 * and new-day-return (94, the richer first-of-the-day summary). Unread
 * messages are a real, actionable, time-sensitive signal, so they outrank
 * the routine recap; they don't preempt the once-a-day rich return summary
 * or an explicit guided-topic tap (96) / first-time welcome (95).
 *
 * Content is deliberately short and plain — a name/count, nothing more. No
 * quoted dialogue, no exemplar framing: exactly the shape that has NOT
 * tripped Nova's content filter elsewhere in this codebase (see
 * nova-instruction-sanitizer.ts's and VTID-03674's shared lesson: quoted
 * persona-voiced speech is what trips it, not short factual leads).
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
  AssistantContinuation,
} from '../types';
import { fetchExclusions, fetchUnreadMessageSummary } from '../../social-memory/social-memory-repository';

export const UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY = 'unread_messages_announce' as const;
export const UNREAD_MESSAGES_ANNOUNCE_EXTRA_KEY = 'unreadMessagesAnnounce' as const;

/** Between login-briefing (93) and new-day-return (94) — see file header. */
export const UNREAD_MESSAGES_ANNOUNCE_PRIORITY = 93.5;

export interface UnreadMessagesAnnounceInputs {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  lang: string;
}

export interface UnreadMessagesAnnounceProviderOptions {
  newId?: () => string;
  now?: () => number;
  priority?: number;
}

function readInputs(ctx: ContinuationDecisionContext): UnreadMessagesAnnounceInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[UNREAD_MESSAGES_ANNOUNCE_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.userId !== 'string' || o.userId.length === 0) return null;
  if (typeof o.tenantId !== 'string' || o.tenantId.length === 0) return null;
  if (!o.supabase) return null;
  return {
    supabase: o.supabase as SupabaseClient,
    userId: o.userId,
    tenantId: o.tenantId,
    lang: typeof o.lang === 'string' && o.lang.length > 0 ? o.lang : 'en',
  };
}

/**
 * Pure render — exported for tests. `senderNames` has exactly 1 or 2
 * entries when `senderCount` is 1 or 2; ignored (count-only wording) for
 * 3+, per the product ask ("if more, just the count + offer to dictate").
 */
export function renderUnreadMessagesLine(args: {
  lang: string;
  count: number;
  senderCount: number;
  senderNames: string[];
}): string {
  const de = args.lang.toLowerCase().startsWith('de');
  if (args.senderCount === 1) {
    const name = args.senderNames[0];
    if (de) {
      return args.count === 1
        ? `Du hast eine neue Nachricht von ${name}.`
        : `Du hast ${args.count} neue Nachrichten von ${name}.`;
    }
    return args.count === 1
      ? `You have a new message from ${name}.`
      : `You have ${args.count} new messages from ${name}.`;
  }
  if (args.senderCount === 2) {
    const [a, b] = args.senderNames;
    return de ? `Du hast neue Nachrichten von ${a} und ${b}.` : `You have new messages from ${a} and ${b}.`;
  }
  return de
    ? `Du hast ${args.count} ungelesene Nachrichten von ${args.senderCount} Personen.`
    : `You have ${args.count} unread messages from ${args.senderCount} people.`;
}

function displayName(person: { display_name: string | null; handle: string | null }, lang: string): string {
  if (person.display_name) return person.display_name;
  if (person.handle) return person.handle;
  return lang.toLowerCase().startsWith('de') ? 'jemandem' : 'someone';
}

export function makeUnreadMessagesAnnounceProvider(
  opts: UnreadMessagesAnnounceProviderOptions = {},
): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? UNREAD_MESSAGES_ANNOUNCE_PRIORITY;

  return {
    key: UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_unread_messages_inputs',
        };
      }

      let summary;
      try {
        const excl = await fetchExclusions(inputs.userId);
        summary = await fetchUnreadMessageSummary(inputs.userId, inputs.tenantId, excl.blocked);
      } catch (err) {
        return {
          providerKey: UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (summary.count === 0) {
        return {
          providerKey: UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_unread_messages',
        };
      }

      const senderNames = summary.senders.map((s) => displayName(s.person, inputs.lang));
      const line = renderUnreadMessagesLine({
        lang: inputs.lang,
        count: summary.count,
        senderCount: summary.senderCount,
        senderNames,
      });

      const candidate: AssistantContinuation = {
        id: `unread-messages-announce-${newId()}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: line,
        cta: {
          type: 'navigate',
          route: '/inbox',
          payload: { screen_id: 'INBOX.OVERVIEW' },
        },
        evidence: [
          { kind: 'unread_messages', detail: `count=${summary.count} senders=${summary.senderCount}` },
        ],
        // Changes when the unread STATE changes (new message arrives, or the
        // user reads some) so a genuinely fresh batch is never suppressed by
        // stale-dedupe rotation; stays stable while unchanged, letting the
        // framework's normal recency penalty behave exactly like every
        // sibling provider's dedupeKey already does.
        dedupeKey: `unread-messages:${summary.count}:${summary.senderCount}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}
