/**
 * VTID-05211 (plan profile-vitana-cards, R7 "no dead cards") — enrichment
 * cards whose action cannot work on this stack, so no screen offers them.
 *
 * E6 "Connect Instagram" and E7 "Connect Facebook" start the gateway OAuth
 * flow (GET /api/v1/social-accounts/connect/:provider). Without the provider's
 * OAuth client (client id AND secret) that route answers 400 "not configured"
 * and the card can only show "connect failed". As of 2026-10-15 no gateway
 * stack has the Meta credentials (owner is creating the Meta app; lane
 * `meta-oauth`), so both cards stay hidden and come back on their own as soon
 * as the four values are provisioned — no code change, no deploy of this file.
 *
 * `profile_completion_pct` is not affected: it is computed over every
 * enrichment card's completion state, independent of what is shown.
 */
import { isProviderConfigured, type SocialProvider } from '../social-connect-service';
import type { EnrichmentCardType } from './card-catalog';

/** The enrichment cards that need a social OAuth client, and which one. */
export const SOCIAL_CONNECT_CARDS: Readonly<Partial<Record<EnrichmentCardType, SocialProvider>>> = {
  E6: 'instagram',
  E7: 'facebook',
};

/** Enrichment cards to leave out everywhere on this stack (read from the env on every call). */
export function unavailableEnrichmentCards(env: NodeJS.ProcessEnv = process.env): ReadonlySet<EnrichmentCardType> {
  const out = new Set<EnrichmentCardType>();
  for (const [card, provider] of Object.entries(SOCIAL_CONNECT_CARDS) as Array<[EnrichmentCardType, SocialProvider]>) {
    if (!isProviderConfigured(provider, env)) out.add(card);
  }
  return out;
}
