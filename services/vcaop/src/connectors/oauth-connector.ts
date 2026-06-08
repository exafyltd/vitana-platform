/**
 * OAuthConnector (CONN-OAUTH-0003, runbook Sec. 4.4 / 4.5).
 *
 * OAuth/app-install adapter with token lifecycle:
 *  - proactive refresh when the access token is near expiry
 *  - refresh-on-401 with bounded backoff retry
 *  - refresh-token revocation -> emit a REAUTH human task (re-auth magic link) and
 *    mark the account `degraded` (never silently fail)
 *
 * Tokens flow through a swappable OAuthClient + TokenStore (the store holds vault
 * refs in prod). CI/dev run against mocks only. Guardrails are enforced by
 * BaseConnector before any do* hook runs.
 */
import { BaseConnector } from './base-connector';
import {
  ConnectorMode,
  BusinessIdentity,
  JobContext,
  OperateAction,
  RegisterResult,
  VerifyResult,
  OperateResult,
  HealthResult,
  ProviderAccount,
} from './connector';
import { PolicyEngine } from '../guardrails/policy-engine';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

export interface TokenStore {
  get(accountId: string): Promise<TokenSet | null>;
  save(accountId: string, token: TokenSet): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly m = new Map<string, TokenSet>();
  async get(accountId: string) {
    return this.m.get(accountId) ?? null;
  }
  async save(accountId: string, token: TokenSet) {
    this.m.set(accountId, token);
  }
}

/** Thrown by OAuthClient.operate when the access token is rejected (HTTP 401). */
export class UnauthorizedError extends Error {
  constructor(msg = 'unauthorized (401)') {
    super(msg);
    this.name = 'UnauthorizedError';
  }
}
/** Thrown by OAuthClient.refresh when the refresh token has been revoked. */
export class TokenRevokedError extends Error {
  constructor(msg = 'refresh token revoked') {
    super(msg);
    this.name = 'TokenRevokedError';
  }
}

export interface OAuthClient {
  providerId: string;
  refresh(refreshToken: string): Promise<TokenSet>; // throws TokenRevokedError if revoked
  operate(action: OperateAction, accessToken: string, ctx: JobContext): Promise<OperateResult>; // throws UnauthorizedError on 401
}

export interface OAuthConnectorOptions {
  /** Refresh proactively when the token expires within this skew (ms). Default 60s. */
  refreshSkewMs?: number;
  /** Backoff before the post-401 retry (ms). Default 0 (tests); real use sets a few hundred ms. */
  retryBackoffMs?: number;
}

export class OAuthConnector extends BaseConnector {
  private readonly skew: number;
  private readonly backoff: number;

  constructor(
    policyEngine: PolicyEngine,
    private readonly client: OAuthClient,
    private readonly store: TokenStore,
    opts: OAuthConnectorOptions = {},
  ) {
    super(policyEngine);
    this.skew = opts.refreshSkewMs ?? 60_000;
    this.backoff = opts.retryBackoffMs ?? 0;
  }

  mode(): ConnectorMode {
    return 'oauth';
  }

  protected async doRegister(_identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult> {
    // App-install/registration is the human-authorized OAuth grant; gate it.
    this.requireHuman('IRREVERSIBLE_SUBMIT', ctx, { providerId: ctx.providerId, reason: 'oauth app-install/grant' });
  }

  protected async doVerify(ctx: JobContext): Promise<VerifyResult> {
    const token = await this.ensureValidToken(ctx);
    return { verified: !!token, details: { providerId: ctx.providerId } };
  }

  protected async doOperate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    let token = await this.ensureValidToken(ctx);
    try {
      return await this.client.operate(action, token.accessToken, ctx);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      // refresh-on-401 + backoff, then one retry
      if (this.backoff > 0) await new Promise((r) => setTimeout(r, this.backoff));
      token = await this.refreshOrEscalate(token, ctx);
      return this.client.operate(action, token.accessToken, ctx);
    }
  }

  protected async doHealthCheck(account: ProviderAccount): Promise<HealthResult> {
    const token = await this.store.get(account.id);
    if (!token) return { status: 'degraded', details: { reason: 'no token' } };
    const expired = token.expiresAt <= Date.now();
    return { status: expired ? 'degraded' : 'healthy', details: { providerId: account.providerId } };
  }

  /** Return a non-expired token, refreshing proactively if near expiry. */
  private async ensureValidToken(ctx: JobContext): Promise<TokenSet> {
    const accountId = ctx.accountId;
    if (!accountId) throw new Error('oauth operate requires ctx.accountId');
    const token = await this.store.get(accountId);
    if (!token) {
      // No token at all -> human re-auth required.
      this.escalateReauth(accountId, ctx, 'no token on file');
    }
    const now = ctx.now ?? Date.now();
    if (token!.expiresAt - now <= this.skew) {
      return this.refreshOrEscalate(token!, ctx);
    }
    return token!;
  }

  /** Refresh the token; on revocation, mark degraded + emit REAUTH human task and halt. */
  private async refreshOrEscalate(token: TokenSet, ctx: JobContext): Promise<TokenSet> {
    const accountId = ctx.accountId!;
    try {
      const next = await this.client.refresh(token.refreshToken);
      await this.store.save(accountId, next);
      return next;
    } catch (e) {
      if (e instanceof TokenRevokedError) {
        this.escalateReauth(accountId, ctx, 'refresh token revoked');
      }
      throw e;
    }
  }

  /** Mark the account degraded and route a REAUTH human task; throws HumanTaskRequired. */
  private escalateReauth(accountId: string, ctx: JobContext, reason: string): never {
    ctx.markDegraded?.(accountId, reason);
    this.requireHuman('REAUTH', ctx, { accountId, providerId: ctx.providerId, reason });
  }
}

/** Mock OAuth client for tests/dev — configurable refresh/operate behavior. No live calls. */
export class MockOAuthClient implements OAuthClient {
  revoked = false;
  unauthorizeOnce = false;
  refreshCount = 0;
  constructor(public readonly providerId: string) {}

  async refresh(_refreshToken: string): Promise<TokenSet> {
    this.refreshCount += 1;
    if (this.revoked) throw new TokenRevokedError();
    return { accessToken: `acc_${this.refreshCount}`, refreshToken: `ref_${this.refreshCount}`, expiresAt: Date.now() + 3600_000 };
  }

  async operate(action: OperateAction, accessToken: string, ctx: JobContext): Promise<OperateResult> {
    if (this.unauthorizeOnce) {
      this.unauthorizeOnce = false;
      throw new UnauthorizedError();
    }
    return { ok: true, data: { provider: this.providerId, action: action.kind, accessToken, accountId: ctx.accountId ?? null } };
  }
}
