/**
 * Shopify provider adapter (supply-side / merchant ops; OAuth app-install).
 *
 * Behind the existing OAuthConnector/ApiConnector interfaces. MOCK-only until real
 * creds: `live` refuses without vaulted app key/secret (no silent live calls).
 * Sec. 0.8: Shopify Admin API/OAuth not verified here → DECISIONS VER-005 / BLOCKERS BLK-006.
 */
import { ApiClient } from '../api-connector';
import { OAuthClient, TokenSet, UnauthorizedError, TokenRevokedError } from '../oauth-connector';
import { OperateAction, OperateResult, HealthResult, ProviderAccount, JobContext } from '../connector';

export const SHOPIFY_PROVIDER_ID = 'shopify';

export interface ShopifyConfig {
  apiKeyRef?: string;
  apiSecretRef?: string;
  /** {shop}.myshopify.com */
  shop?: string;
  apiVersion?: string;
  live?: boolean;
}

export class ShopifyOAuthClient implements OAuthClient {
  readonly providerId = SHOPIFY_PROVIDER_ID;
  revoked = false;
  constructor(private readonly cfg: ShopifyConfig = {}) {}

  async refresh(_refreshToken: string): Promise<TokenSet> {
    if (this.revoked) throw new TokenRevokedError();
    if (this.cfg.live) {
      if (!this.cfg.apiKeyRef || !this.cfg.apiSecretRef) throw new Error('Shopify live requires apiKeyRef + apiSecretRef (vault)');
      throw new Error('Shopify live token exchange not yet wired — supply creds (BLK-006)');
    }
    // Shopify offline tokens don't expire; mock a long-lived token.
    return { accessToken: `shpat_mock_${Date.now()}`, refreshToken: 'shopify_offline', expiresAt: Date.now() + 365 * 24 * 3600_000 };
  }

  async operate(action: OperateAction, accessToken: string, ctx: JobContext): Promise<OperateResult> {
    if (!accessToken) throw new UnauthorizedError();
    if (this.cfg.live) throw new Error('Shopify live Admin API not yet wired — supply creds (BLK-006)');
    return { ok: true, data: { provider: this.providerId, shop: this.cfg.shop ?? 'mock.myshopify.com', action: action.kind, accountId: ctx.accountId ?? null, mock: true } };
  }
}

export class ShopifyApiClient implements ApiClient {
  readonly providerId = SHOPIFY_PROVIDER_ID;
  constructor(private readonly cfg: ShopifyConfig = {}) {}
  async operate(action: OperateAction, _ctx: JobContext): Promise<OperateResult> {
    if (this.cfg.live) throw new Error('Shopify live Admin API not yet wired (BLK-006)');
    return { ok: true, data: { provider: this.providerId, action: action.kind, mock: true } };
  }
  async healthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'healthy', details: { provider: this.providerId, mock: !this.cfg.live, accountId: account.id } };
  }
}
