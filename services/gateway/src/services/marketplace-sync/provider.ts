/**
 * VTID-01930: Marketplace provider registry — extensibility layer.
 *
 * Adding a new catalog source (Amazon, Rakuten, Awin, Impact, …) should be:
 *   1. Drop a file at ./providers/<name>.ts implementing MarketplaceProvider.
 *   2. Register it in ./providers/index.ts.
 *   3. Everything else (admin UI dropdown, scheduler, internal sync route,
 *      tenant-admin trigger) picks it up automatically via this registry.
 *
 * The previous shopify/cj hardcoded if/else branches across the admin UI,
 * the internal sync route, and the scheduler were the technical debt this
 * module retires.
 */

export interface SyncTotals {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface ProviderSyncResult {
  ok: boolean;
  totals: SyncTotals;
  duration_ms: number;
  /** Optional provider-specific payload (per-shop breakdown, pages fetched, etc). */
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * A single field in a provider's "Add source" admin form.
 * Drives the Command Hub dropdown + input form without any per-provider
 * frontend wiring.
 */
export interface ConfigFieldSpec {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'textarea';
  placeholder?: string;
  required?: boolean;
  help?: string;
  /** If set, the field's value is parsed as a comma-separated list before save. */
  list?: boolean;
}

export interface MarketplaceProvider {
  /** Stable slug persisted on catalog rows — NEVER change after launch. */
  key: string;
  /** Human-readable name shown in admin UI. */
  displayName: string;
  /** One-line description shown beneath the dropdown in the Add-source form. */
  description: string;
  /** Drives the Add-source form. */
  configSchema: ConfigFieldSpec[];
  /**
   * Optional pre-save sanity check. Return `{ ok: false, error }` to reject
   * a proposed source config before it hits Supabase. Keep this cheap —
   * structural checks only, not live-API probes.
   */
  validateConfig?(cfg: Record<string, unknown>): { ok: boolean; error?: string };
  /** Run a full catalog sync for this provider. */
  runSync(triggered_by: string): Promise<ProviderSyncResult>;
}
