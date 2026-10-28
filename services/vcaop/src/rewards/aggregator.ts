/**
 * Affiliate aggregator adapter (RWD-AGG-0001, runbook Sec. 4.6 / Sec. 2.1).
 *
 * Integrates ONE aggregator (Skimlinks/Sovrn/Wildfire-class) to inherit many
 * merchants. Swappable behind `AggregatorClient` (vendor unverified — mock-to-
 * interface per Sec. 0.8, BLK-002-class). Decorates a merchant link with a
 * per-user SubID for attribution.
 */
import { mintSubId } from '../agents/monetization';

export interface DecoratedLink {
  url: string;
  subId: string;
  merchant: string;
}

export interface AggregatorClient {
  name: string;
  /** Wrap a merchant URL in the aggregator's tracking redirect, carrying subId. */
  decorateLink(merchantUrl: string, subId: string): string;
}

export class AffiliateAggregator {
  constructor(private readonly client: AggregatorClient) {}

  /** Decorate a merchant link for a user; SubID is deterministic per (user, program). */
  decorate(merchantUrl: string, merchant: string, userId: string, programId: string): DecoratedLink {
    const subId = mintSubId(userId, programId);
    return { url: this.client.decorateLink(merchantUrl, subId), subId, merchant };
  }
}

/** Mock aggregator client — deterministic tracking URL; no live calls. */
export class MockAggregatorClient implements AggregatorClient {
  name = 'mock-aggregator';
  decorateLink(merchantUrl: string, subId: string): string {
    const u = encodeURIComponent(merchantUrl);
    return `https://track.mock-agg.example/redirect?url=${u}&subid=${subId}`;
  }
}
