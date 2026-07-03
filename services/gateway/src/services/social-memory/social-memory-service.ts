/**
 * BOOTSTRAP-SOCIAL-MEMORY — top-level service.
 *
 * buildAssistantSocialContext(): the one call the assistant flow and the
 * POST /assistant-context endpoint use — intent detection, pack assembly,
 * meaningful-moment memory persistence, and OASIS telemetry.
 *
 * Memory persistence is deliberately selective (do NOT store everything):
 * only person-focus moments (the user asked about a specific person) are
 * written, via the existing writeMemoryItemWithIdentity path, category
 * network_relationships — so future turns know who matters to the user.
 */

import { emitOasisEvent } from '../oasis-event-service';
import {
  SocialContextPack,
  SocialIntentDecision,
} from './social-memory-types';
import { buildSocialContextPack } from './social-context-builder';
import { detectSocialIntent, formatSocialContextForPrompt } from './social-memory-prompts';

const LOG_PREFIX = '[SOCIAL-MEMORY]';

export { detectSocialIntent, formatSocialContextForPrompt };

export interface AssistantSocialContextInput {
  tenant_id: string;
  user_id: string;
  question: string;
  conversation_id?: string;
  surface?: 'vitana_assistant' | 'maxina_community' | 'group_chat' | 'profile' | 'feed';
  compact?: boolean;
}

export interface AssistantSocialContextResult {
  ok: boolean;
  intent: SocialIntentDecision;
  pack: SocialContextPack;
  /** Ready-to-inject <social_context> prompt section. */
  prompt_block: string;
}

export async function buildAssistantSocialContext(
  input: AssistantSocialContextInput,
): Promise<AssistantSocialContextResult> {
  const intent = detectSocialIntent(input.question || '');

  const pack = await buildSocialContextPack({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    question: input.question,
    surface: input.surface,
    compact: input.compact,
    intent,
  });

  // Meaningful-moment memory: the user focused on a specific person.
  if (pack.person_context && intent.person_hint) {
    persistPersonFocusMemory(input, pack).catch(() => {});
  }

  // Telemetry — retrieval + recommendation event, metadata only (counts,
  // never names/content, so the log cannot leak private data).
  emitOasisEvent({
    vtid: 'BOOTSTRAP-SOCIAL-MEMORY',
    type: 'memory.social.context_built',
    source: `social-memory-${input.surface || 'vitana_assistant'}`,
    status: pack.meta.degraded_sections.length > 0 ? 'warning' : 'info',
    message: `Social context built: ${pack.meta.sections_loaded.length} sections, ${pack.matches.length} matches, ${pack.interesting_posts.length} posts, ${pack.interesting_events.length} events`,
    payload: {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      conversation_id: input.conversation_id,
      surface: input.surface || 'vitana_assistant',
      intent_kinds: intent.kinds,
      person_resolved: !!pack.person_context,
      person_privacy_limited: pack.person_context?.privacy_limited ?? false,
      following_count: pack.relationships.following_count,
      followers_count: pack.relationships.followers_count,
      matches_count: pack.matches.length,
      message_contacts_count: pack.messages.length,
      group_chats_count: pack.group_chats.length,
      interesting_posts_count: pack.interesting_posts.length,
      interesting_events_count: pack.interesting_events.length,
      recommended_actions_count: pack.recommended_actions.length,
      degraded_sections: pack.meta.degraded_sections,
      latency_ms: pack.meta.latency_ms,
    },
  }).catch(() => {});

  console.log(
    `${LOG_PREFIX} context built in ${pack.meta.latency_ms}ms — intent=[${intent.kinds.join(',')}] ` +
      `follows=${pack.relationships.following_count}/${pack.relationships.followers_count} ` +
      `matches=${pack.matches.length} posts=${pack.interesting_posts.length} events=${pack.interesting_events.length} ` +
      `person=${pack.person_context ? 'yes' : 'no'} degraded=[${pack.meta.degraded_sections.join(',')}]`,
  );

  return {
    ok: pack.meta.degraded_sections.length === 0,
    intent,
    pack,
    prompt_block: formatSocialContextForPrompt(pack),
  };
}

/**
 * Durable memory for a meaningful person-focus moment. Uses the existing
 * memory write path (memory_items via orb-memory-bridge) — never raw SQL.
 */
async function persistPersonFocusMemory(
  input: AssistantSocialContextInput,
  pack: SocialContextPack,
): Promise<void> {
  const pc = pack.person_context!;
  // Privacy: never memorize details of privacy-limited profiles.
  if (pc.privacy_limited) return;
  try {
    const { writeMemoryItemWithIdentity } = await import('../orb-memory-bridge');
    const name = pc.person.display_name || pc.person.handle || 'a member';
    await writeMemoryItemWithIdentity(
      { user_id: input.user_id, tenant_id: input.tenant_id },
      {
        content: `User asked about ${name}${pc.match?.score != null ? ` (match score ${pc.match.score})` : ''} — ${pc.you_follow ? 'follows them' : 'does not follow them yet'}.`,
        source: 'orb_text',
        category_key: 'network_relationships',
        importance: 35,
        content_json: {
          direction: 'system',
          kind: 'person_focus',
          person_id: pc.person.user_id,
          surface: input.surface || 'vitana_assistant',
        },
      },
    );
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} person-focus memory write failed: ${err?.message}`);
  }
}
