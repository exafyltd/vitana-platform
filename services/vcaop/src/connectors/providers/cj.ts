/**
 * CJ (Commission Junction / CJ Affiliate) adapter — affiliate network.
 *
 * Behind ApiConnector. MOCK-only until creds; `live` refuses without a vaulted
 * personal access token. Deep links carry a `sid` for per-user SubID attribution.
 * Sec. 0.8: CJ API not verified here → DECISIONS VER-007 / BLOCKERS BLK-008.
 */
import { ApiClient } from '../api-connector';
import { OperateAction, OperateResult, HealthResult, ProviderAccount, JobContext } from '../connector';

export const CJ_PROVIDER_ID = 'cj';
export const CJ_PROGRAM_ID = 'cj';

export interface CjConfig {
  /** CJ personal access token (vault ref). */
  patRef?: string;
  /** CJ publisher/website id (PID). */
  websiteId?: string;
  live?: boolean;
}

export class CjApiClient implements ApiClient {
  readonly providerId = CJ_PROVIDER_ID;
  constructor(private readonly cfg: CjConfig = {}) {}

  async operate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    if (this.cfg.live) {
      if (!this.cfg.patRef || !this.cfg.websiteId) throw new Error('CJ live requires patRef + websiteId (vault)');
      throw new Error('CJ live API not yet wired — supply creds (BLK-008)');
    }
    if (action.kind === 'search_products') {
      return { ok: true, data: { advertiser: 'mock-advertiser', products: [{ sku: 'CJMOCK1', title: 'mock product', price: 12.5 }] } };
    }
    return { ok: true, data: { provider: this.providerId, action: action.kind, accountId: ctx.accountId ?? null, mock: true } };
  }

  async healthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'healthy', details: { provider: this.providerId, mock: !this.cfg.live, accountId: account.id } };
  }
}

/** CJ deep link with publisher id + per-user SubID (`sid`). */
export function decorateCjLink(advertiserUrl: string, opts: { websiteId: string; subId: string }): string {
  const u = new URL(advertiserUrl);
  u.searchParams.set('cjpid', opts.websiteId);
  u.searchParams.set('sid', opts.subId); // per-user SubID for attribution
  return u.toString();
}
