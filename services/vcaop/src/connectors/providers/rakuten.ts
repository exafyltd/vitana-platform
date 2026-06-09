/**
 * Rakuten Advertising adapter — affiliate network (OAuth2 client-credentials).
 *
 * Behind ApiConnector. MOCK-only until creds; `live` refuses without vaulted creds.
 * Links carry `u1` for per-user SubID attribution.
 * Sec. 0.8: Rakuten Advertising API not verified here → DECISIONS VER-008 / BLOCKERS BLK-009.
 */
import { ApiClient } from '../api-connector';
import { OperateAction, OperateResult, HealthResult, ProviderAccount, JobContext } from '../connector';

export const RAKUTEN_PROVIDER_ID = 'rakuten_advertising';
export const RAKUTEN_PROGRAM_ID = 'rakuten_advertising';

export interface RakutenConfig {
  clientIdRef?: string;
  clientSecretRef?: string;
  /** Rakuten publisher site id (SID). */
  sid?: string;
  live?: boolean;
}

export class RakutenApiClient implements ApiClient {
  readonly providerId = RAKUTEN_PROVIDER_ID;
  constructor(private readonly cfg: RakutenConfig = {}) {}

  async operate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    if (this.cfg.live) {
      if (!this.cfg.clientIdRef || !this.cfg.clientSecretRef) throw new Error('Rakuten live requires clientIdRef + clientSecretRef (vault)');
      throw new Error('Rakuten Advertising live API not yet wired — supply creds (BLK-009)');
    }
    if (action.kind === 'search_products') {
      return { ok: true, data: { advertisers: ['mock'], products: [{ sku: 'RKMOCK1', title: 'mock product', price: 33.0 }] } };
    }
    return { ok: true, data: { provider: this.providerId, action: action.kind, accountId: ctx.accountId ?? null, mock: true } };
  }

  async healthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'healthy', details: { provider: this.providerId, mock: !this.cfg.live, accountId: account.id } };
  }
}

/** Rakuten affiliate link with merchant id + per-user SubID (`u1`). */
export function decorateRakutenLink(deeplinkBase: string, opts: { mid: string; subId: string }): string {
  const u = new URL(deeplinkBase);
  u.searchParams.set('mid', opts.mid);
  u.searchParams.set('u1', opts.subId); // per-user SubID for attribution
  return u.toString();
}
