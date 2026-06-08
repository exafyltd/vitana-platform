/**
 * HTTP affiliate-aggregator client scaffold (Phase 3 — affiliate-first).
 *
 * One aggregator (Skimlinks / Sovrn / Wildfire-class) inherits ~50k merchants in a
 * single integration. Implemented behind the existing `AggregatorClient` interface
 * so the rest of the rewards engine is unchanged. MOCK-only until real creds: the
 * `live` flag refuses any live call without a vaulted API key (no silent live calls).
 *
 * Sec. 0.8: aggregator API/terms NOT independently verified here → mock-to-interface
 * (DECISIONS VER-004, BLOCKERS BLK-005). The API key lives in the vault; config holds
 * a reference only (no-credential-store).
 */
import { AggregatorClient } from '../aggregator';

export interface AggregatorConfig {
  /** Which aggregator (for logging/routing). */
  network?: 'skimlinks' | 'sovrn' | 'wildfire' | 'generic';
  /** Secret Manager reference to the API key — never the raw value. */
  apiKeyRef?: string;
  /** Publisher/site id issued by the aggregator. */
  publisherId?: string;
  /** Base of the aggregator's tracking redirect. */
  trackingBase?: string;
  /** True only once a real client is wired AND the key is verified. Default false → mock. */
  live?: boolean;
}

export class HttpAggregatorClient implements AggregatorClient {
  readonly name: string;
  constructor(private readonly cfg: AggregatorConfig = {}) {
    this.name = cfg.network ?? 'generic-aggregator';
  }

  /** Decorate a merchant URL with the aggregator's tracking redirect + per-user SubID. */
  decorateLink(merchantUrl: string, subId: string): string {
    if (this.cfg.live) {
      if (!this.cfg.apiKeyRef || !this.cfg.publisherId) {
        throw new Error('aggregator live mode requires apiKeyRef + publisherId (vault) — not configured');
      }
      // TODO(live): some aggregators decorate client-side via a publisher id, others
      // via a link-API call using the vaulted key. Wire per the chosen vendor; behind
      // a feature flag + cost-guard. Not enabled here (BLK-005).
      throw new Error('aggregator live link decoration not yet wired — supply creds (BLK-005)');
    }
    // Deterministic mock tracking URL carrying publisher id + per-user SubID.
    const base = this.cfg.trackingBase ?? 'https://track.aggregator.example/redirect';
    const pub = this.cfg.publisherId ?? 'pub_mock';
    const u = encodeURIComponent(merchantUrl);
    return `${base}?pub=${pub}&url=${u}&subid=${subId}`;
  }
}

/**
 * Verify an inbound aggregator postback signature before crediting (placeholder).
 * Real impl validates the vendor's HMAC/signature with the vaulted secret. Until
 * wired, callers must treat postbacks as unverified (mock e2e uses trusted fixtures).
 */
export function verifyAggregatorPostbackSignature(_payload: unknown, _signature: string, cfg: AggregatorConfig = {}): boolean {
  if (cfg.live) throw new Error('aggregator postback signature verification not yet wired (BLK-005)');
  return true; // mock/fixture path only
}
