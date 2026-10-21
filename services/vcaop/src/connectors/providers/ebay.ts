/**
 * eBay provider adapter (first real integration — affiliate-first).
 *
 * Two surfaces, both behind the EXISTING connector interfaces so CI/dev stay
 * mock-only (no live eBay calls) until real sandbox/prod creds are supplied:
 *   - `EbayApiClient`  → drives the eBay Browse API via `ApiConnector` (find items
 *     to surface/decorate). App token (client_credentials) in prod.
 *   - `EbayOAuthClient`→ user-scoped OAuth (Sell APIs) via `OAuthConnector`.
 *   - `decorateEbayAffiliateLink` → eBay Partner Network (EPN) link with per-user
 *     SubID (customid) for attribution.
 *
 * Sec. 0.8: eBay API/auth/ToS NOT independently re-verified in this environment →
 * mock-to-interface (DECISIONS VER-003, BLOCKERS BLK-004). Credentials live in the
 * vault; the DB/config holds refs only (no-credential-store).
 */
import { ApiClient } from '../api-connector';
import { OAuthClient, TokenSet, UnauthorizedError, TokenRevokedError } from '../oauth-connector';
import { OperateAction, OperateResult, HealthResult, ProviderAccount, JobContext } from '../connector';

export const EBAY_PROVIDER_ID = 'ebay';
export const EBAY_PARTNER_PROGRAM_ID = 'ebay_partner';

export interface EbayConfig {
  /** Secret Manager refs — never raw values. */
  clientIdRef?: string;
  clientSecretRef?: string;
  /** EPN campaign id for affiliate attribution. */
  campaignId?: string;
  /** Sandbox by default — production requires explicit opt-in + verified creds. */
  sandbox?: boolean;
  /** True only once a real client is wired AND creds verified. Default false → mock. */
  live?: boolean;
}

const EBAY_ENDPOINTS = {
  sandbox: { oauth: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token', browse: 'https://api.sandbox.ebay.com/buy/browse/v1' },
  production: { oauth: 'https://api.ebay.com/identity/v1/oauth2/token', browse: 'https://api.ebay.com/buy/browse/v1' },
};

/**
 * eBay Browse API client for ApiConnector. MOCK until `live` + verified creds:
 * returns deterministic sample items so the cart/affiliate loop runs end-to-end.
 */
export class EbayApiClient implements ApiClient {
  readonly providerId = EBAY_PROVIDER_ID;
  constructor(private readonly cfg: EbayConfig = {}) {}

  private assertLive(): void {
    if (!this.cfg.live) return; // mock path — fine
    if (!this.cfg.clientIdRef || !this.cfg.clientSecretRef) {
      throw new Error('eBay live mode requires clientIdRef + clientSecretRef (vault) — not configured');
    }
  }

  async operate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    this.assertLive();
    const env = this.cfg.sandbox === false ? 'production' : 'sandbox';
    if (this.cfg.live) {
      // TODO(live): call ${EBAY_ENDPOINTS[env].browse}/item_summary/search with the
      // app token from the vault. Behind a feature flag + cost-guard. Not enabled here.
      throw new Error('eBay live operate not yet wired — supply sandbox creds (BLK-004)');
    }
    // Mock Browse response.
    if (action.kind === 'search_items') {
      const q = (action.payload?.q as string) ?? 'thing';
      return { ok: true, data: { env, items: [{ itemId: 'v1|mock123|0', title: `${q} (mock)`, price: 19.99, url: 'https://www.ebay.com/itm/mock123' }] } };
    }
    return { ok: true, data: { env, action: action.kind, accountId: ctx.accountId ?? null } };
  }

  async healthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'healthy', details: { provider: this.providerId, mock: !this.cfg.live, accountId: account.id } };
  }

  async verify(ctx: JobContext): Promise<{ verified: boolean; details?: Record<string, unknown> }> {
    return { verified: true, details: { provider: this.providerId, mock: !this.cfg.live, providerId: ctx.providerId } };
  }
}

/** eBay OAuth client for OAuthConnector (Sell APIs). MOCK until live + verified creds. */
export class EbayOAuthClient implements OAuthClient {
  readonly providerId = EBAY_PROVIDER_ID;
  revoked = false;
  constructor(private readonly cfg: EbayConfig = {}) {}

  async refresh(_refreshToken: string): Promise<TokenSet> {
    if (this.revoked) throw new TokenRevokedError();
    if (this.cfg.live) {
      // TODO(live): POST ${EBAY_ENDPOINTS[...].oauth} grant_type=refresh_token with
      // basic-auth(clientId:clientSecret) from the vault. Not enabled here.
      throw new Error('eBay live token refresh not yet wired — supply creds (BLK-004)');
    }
    return { accessToken: `ebay_mock_${Date.now()}`, refreshToken: 'ebay_mock_refresh', expiresAt: Date.now() + 7200_000 };
  }

  async operate(action: OperateAction, accessToken: string, ctx: JobContext): Promise<OperateResult> {
    if (!accessToken) throw new UnauthorizedError();
    if (this.cfg.live) throw new Error('eBay live OAuth operate not yet wired — supply creds (BLK-004)');
    return { ok: true, data: { provider: this.providerId, action: action.kind, accountId: ctx.accountId ?? null, mock: true } };
  }
}

/**
 * Decorate an eBay item URL with EPN affiliate tracking + per-user SubID (`customid`).
 * Attribution flows back through the postback → rewards ledger.
 */
export function decorateEbayAffiliateLink(itemUrl: string, opts: { campaignId: string; subId: string; toolId?: string }): string {
  const u = new URL(itemUrl);
  u.searchParams.set('mkevt', '1');
  u.searchParams.set('mkcid', '1');
  u.searchParams.set('campid', opts.campaignId);
  u.searchParams.set('toolid', opts.toolId ?? '10001');
  u.searchParams.set('customid', opts.subId); // per-user SubID for attribution
  return u.toString();
}
