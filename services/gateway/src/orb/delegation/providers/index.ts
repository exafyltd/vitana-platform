/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Provider registry.
 *
 * Each provider self-registers by calling registerProvider() from its module.
 * The delegation router, the verify endpoint, and the budget checker all
 * read from this registry — adding a new provider is a single new file plus
 * a one-line import.
 *
 * Note: the scaffolding ships with three empty-stub providers (openai,
 * anthropic, google-ai). Their `call()` methods throw with a clear
 * `scaffold_not_wired` error. Phase 7 replaces the stubs with real
 * implementations.
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
