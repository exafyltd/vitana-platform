/**
 * VTID-01930: Marketplace provider registry.
 *
 * Import this module wherever you need to iterate, look up, or list
 * supported marketplace providers. Do NOT reach into individual provider
 * files directly — go through the registry so adding a new provider stays
 * a one-line change.
 */

import type { MarketplaceProvider } from '../provider';
import { shopifyProvider } from './shopify';
import { cjProvider } from './cj';

/** Order here == display order in the admin UI dropdown. */
const PROVIDERS: readonly MarketplaceProvider[] = [shopifyProvider, cjProvider];

const BY_KEY = new Map<string, MarketplaceProvider>(PROVIDERS.map((p) => [p.key, p]));

export function listProviders(): readonly MarketplaceProvider[] {
  return PROVIDERS;
}

export function getProvider(key: string): MarketplaceProvider | undefined {
  return BY_KEY.get(key);
}

export function providerKeys(): string[] {
  return PROVIDERS.map((p) => p.key);
}
