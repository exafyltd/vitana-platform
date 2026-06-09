/**
 * Amazon provider adapter — SP-API (supply) + Associates (affiliate).
 *
 * SP-API uses LWA (Login with Amazon) OAuth: refresh token → short-lived access
 * token. Behind ApiConnector. MOCK-only until creds; `live` refuses without vaulted
 * LWA creds. Associates affiliate links carry the store `tag`.
 * Sec. 0.8: SP-API/Associates not verified here → DECISIONS VER-006 / BLOCKERS BLK-007.
 */
import { ApiClient } from '../api-connector';
import { OperateAction, OperateResult, HealthResult, ProviderAccount, JobContext } from '../connector';

export const AMAZON_PROVIDER_ID = 'amazon';
export const AMAZON_ASSOCIATES_PROGRAM_ID = 'amazon_associates';

export interface AmazonConfig {
  lwaClientIdRef?: string;
  lwaClientSecretRef?: string;
  refreshTokenRef?: string;
  region?: 'na' | 'eu' | 'fe';
  /** Amazon Associates store/tracking tag for affiliate attribution. */
  associatesTag?: string;
  live?: boolean;
}

export class AmazonSpApiClient implements ApiClient {
  readonly providerId = AMAZON_PROVIDER_ID;
  constructor(private readonly cfg: AmazonConfig = {}) {}

  async operate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    if (this.cfg.live) {
      if (!this.cfg.lwaClientIdRef || !this.cfg.lwaClientSecretRef || !this.cfg.refreshTokenRef) {
        throw new Error('Amazon SP-API live requires lwaClientIdRef + lwaClientSecretRef + refreshTokenRef (vault)');
      }
      // TODO(live): LWA token exchange -> SP-API call (region endpoint). Behind flag + cost-guard.
      throw new Error('Amazon SP-API live not yet wired — supply creds (BLK-007)');
    }
    if (action.kind === 'search_catalog') {
      return { ok: true, data: { region: this.cfg.region ?? 'eu', items: [{ asin: 'B0MOCK123', title: 'mock item', price: 24.99 }] } };
    }
    return { ok: true, data: { provider: this.providerId, action: action.kind, accountId: ctx.accountId ?? null, mock: true } };
  }

  async healthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'healthy', details: { provider: this.providerId, mock: !this.cfg.live, accountId: account.id } };
  }
}

/** Amazon Associates affiliate link: append the store `tag` (and optional SubID via ascsubtag). */
export function decorateAmazonAffiliateLink(productUrl: string, opts: { tag: string; subId?: string }): string {
  const u = new URL(productUrl);
  u.searchParams.set('tag', opts.tag);
  if (opts.subId) u.searchParams.set('ascsubtag', opts.subId); // per-user SubID for attribution
  return u.toString();
}
