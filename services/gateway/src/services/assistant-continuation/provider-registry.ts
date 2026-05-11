/**
 * VTID-02913 (B0d.1) — Continuation provider registry.
 *
 * Providers register themselves by stable `key`. The orchestrator
 * (`decide-continuation.ts`) asks the registry for all providers that
 * service a given surface, invokes each, and aggregates the results.
 *
 * B0d.1 ships the registry mechanics only — no providers register
 * themselves at module load. Tests register fakes; B0d.2+ providers
 * register themselves via dedicated module side-effects from their own
 * files so they remain individually testable.
 */

import type {
  ContinuationProvider,
  ContinuationSurface,
} from './types';

// ---------------------------------------------------------------------------
// Registry — a factory keeps tests isolated. The shared default singleton
// is exported for production wiring.
// ---------------------------------------------------------------------------

export interface ContinuationProviderRegistry {
  /** Register a provider under its `key`. Throws on duplicate keys. */
  register(provider: ContinuationProvider): void;
  /** Remove a registered provider (used by tests). */
  unregister(key: string): void;
  /** Look up by key. Returns undefined if absent. */
  get(key: string): ContinuationProvider | undefined;
  /** Every provider whose surfaces include `surface` (empty = all). */
  forSurface(surface: ContinuationSurface): ContinuationProvider[];
  /** Snapshot of every registered provider key (stable order). */
  list(): string[];
  /** Clear everything — for tests. */
  clear(): void;
}

export function createProviderRegistry(): ContinuationProviderRegistry {
  const providers = new Map<string, ContinuationProvider>();

  return {
    register(provider) {
      if (!provider.key || provider.key.trim().length === 0) {
        throw new Error('provider-registry.register: provider.key is required');
      }
      if (providers.has(provider.key)) {
        throw new Error(
          `provider-registry.register: duplicate key '${provider.key}'`,
        );
      }
      providers.set(provider.key, provider);
    },
    unregister(key) {
      providers.delete(key);
    },
    get(key) {
      return providers.get(key);
    },
    forSurface(surface) {
      const out: ContinuationProvider[] = [];
      for (const p of providers.values()) {
        // Empty `surfaces` array means "all surfaces" by convention.
        if (p.surfaces.length === 0 || p.surfaces.includes(surface)) {
          out.push(p);
        }
      }
      return out;
    },
    list() {
      return Array.from(providers.keys());
    },
    clear() {
      providers.clear();
    },
  };
}

/**
 * Shared default registry. Production code that doesn't need test
 * isolation uses this. Tests call `createProviderRegistry()` for fresh
 * state.
 */
export const defaultProviderRegistry: ContinuationProviderRegistry =
  createProviderRegistry();
