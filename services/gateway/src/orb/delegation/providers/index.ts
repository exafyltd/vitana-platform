/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Provider registry.
 *
 * Each provider self-registers by calling registerProvider() from its module.
 * The delegation router, the verify endpoint, and the budget checker all
 * read from this registry — adding a new provider is a single new file plus
 * a one-line import.
 *
 * Note (corrected 2026-08-28, see docs/GATEWAY-GOOGLE-DEPENDENCY-AUDIT-2026-08-28.md):
 * this comment previously said openai/anthropic/google-ai were empty stubs
 * throwing `scaffold_not_wired`. That's no longer true of any of the three —
 * all three `call()` methods make real API calls. `google-ai` in particular
 * is a live, reachable ORB tool (`consult_external_ai`) using the connecting
 * user's own BYOK Google AI Studio key, not a platform credential.
 */
import type { DelegationProviderId, ProviderAdapter } from '../types';

// Static imports so the side-effect registration happens on module load
import { adapter as chatgptAdapter } from './openai';
import { adapter as claudeAdapter } from './anthropic';
import { adapter as googleAiAdapter } from './google-ai';

const REGISTRY = new Map<DelegationProviderId, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  REGISTRY.set(adapter.manifest.providerId, adapter);
}

export function getProvider(providerId: DelegationProviderId): ProviderAdapter | null {
  return REGISTRY.get(providerId) ?? null;
}

export function listProviders(): ProviderAdapter[] {
  return Array.from(REGISTRY.values());
}

// Register the built-in providers on module load
registerProvider(chatgptAdapter);
registerProvider(claudeAdapter);
registerProvider(googleAiAdapter);
