/**
 * Supported chat reaction emojis, gateway side. Identical list to vitana-v1
 * (src/lib/reactions/reaction-emojis.json, apps/mobile). Canonical form is
 * fully-qualified (U+FE0F where it applies); legacy bare forms normalize to it.
 */
import list from './reaction-emojis.json';

export const REACTION_EMOJIS: readonly string[] = list.emojis;
export const QUICK_REACTIONS: readonly string[] = list.quick;
export const MAX_DISTINCT_REACTIONS_PER_USER = 6;
export const REACTION_CAP_ERROR = 'reaction_cap_reached';

const stripVs16 = (s: string) => s.replace(/️/g, '');
const byBare = new Map(REACTION_EMOJIS.map((e) => [stripVs16(e), e] as const));

export function normalizeReactionEmoji(input: string): string | null {
  return byBare.get(stripVs16(input)) ?? null;
}

export function isSupportedReactionEmoji(input: string): boolean {
  return normalizeReactionEmoji(input) !== null;
}
