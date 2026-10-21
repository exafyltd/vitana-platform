/**
 * Embedded OAuth 2.1 authorization server (BLK-007, VTID-03545).
 *
 * Decision (user-approved 2026-08-09): self-host the AS inside vcaop-mcp,
 * delegating END-USER IDENTITY to the existing Supabase Auth — no new
 * identity vendor, and the trio MCP connector clients (Claude/ChatGPT)
 * require is all here: RFC 8414 AS metadata, RFC 7591 dynamic client
 * registration, and authorization-code + PKCE (S256 REQUIRED — `plain` is
 * rejected). Public clients only (`token_endpoint_auth_method: none`), as
 * OAuth 2.1 prescribes for native/AI clients; possession is proven by PKCE.
 *
 * Hard security properties, enforced in code + pinned by tests:
 *  - authorization codes are single-use; REUSE revokes every token the code
 *    ever minted (OAuth 2.1 §4.1.2 code-replay defense);
 *  - refresh tokens rotate on every use; reuse of a rotated token revokes
 *    the whole family;
 *  - redirect_uri must EXACTLY match a registered value (https, or
 *    localhost/127.0.0.1 for dev tooling);
 *  - scopes granted = requested ∩ registered ∩ user-approved — the consent
 *    UI (vitana-v1) posts the approved set; nothing widens it server-side;
 *  - access tokens are ES256 JWTs bound to the resource audience, 15 min
 *    TTL, with jti for per-request revocation checks;
 *  - the AS renders NO html — the browser-facing /oauth/authorize 302s to
 *    the frontend consent page, which authenticates the user with their
 *    normal Supabase session and calls back /oauth/authorize/decision.
 */
import * as crypto from 'crypto';
import { ALL_SCOPES } from './scopes';
import { SigningKeys, signEs256Jwt } from './keys';

export interface IdentityVerifier {
  /** Verify a Supabase access token → the authenticated end user, or null. */
  verify(supabaseAccessToken: string): Promise<{ userId: string; tenantId: string } | null>;
}

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  scope: string;
  created_at: string;
}

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  tenantId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  used: boolean;
  /** jtis of tokens minted from this code — revoked wholesale on code reuse. */
  mintedJtis: string[];
  /** Refresh families minted from this code — burned wholesale on code reuse.
   * Without this, replaying the code revokes the access token but the
   * original exchange's refresh token survives and can immediately mint a
   * fresh, unrevoked access token — defeating the replay defense. */
  mintedFamilyIds: string[];
}

interface RefreshRecord {
  token: string;
  familyId: string;
  clientId: string;
  userId: string;
  tenantId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  rotated: boolean;
  mintedJtis: string[];
}

export class OAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'unauthorized_client'
      | 'unsupported_grant_type'
      | 'access_denied',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface AuthServerOptions {
  /** AS issuer origin, e.g. https://mcp.vitanaland.com */
  issuer: string;
  /** The protected resource this AS mints tokens for. */
  resourceUrl: string;
  /** Frontend consent page (vitana-v1) the authorize endpoint hands off to. */
  consentUrl: string;
  keys: SigningKeys;
  identity: IdentityVerifier;
  now?: () => number;
  codeTtlMs?: number; // default 5 min
  accessTokenTtlSec?: number; // default 15 min
  refreshTokenTtlSec?: number; // default 30 days
}

const HTTPS_OR_LOOPBACK = (uri: string): boolean => {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
};

export class AuthorizationServer {
  private clients = new Map<string, RegisteredClient>();
  private codes = new Map<string, AuthCode>();
  private refresh = new Map<string, RefreshRecord>();
  private revokedJtis = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly opts: AuthServerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** RFC 8414 authorization-server metadata. */
  metadata(): Record<string, unknown> {
    return {
      issuer: this.opts.issuer,
      authorization_endpoint: `${this.opts.issuer}/oauth/authorize`,
      token_endpoint: `${this.opts.issuer}/oauth/token`,
      registration_endpoint: `${this.opts.issuer}/oauth/register`,
      jwks_uri: `${this.opts.issuer}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ALL_SCOPES,
    };
  }

  jwks(): { keys: unknown[] } {
    return this.opts.keys.jwks();
  }

  /** RFC 7591 dynamic client registration — public clients, PKCE-bound. */
  registerClient(input: {
    client_name?: unknown;
    redirect_uris?: unknown;
    scope?: unknown;
  }): RegisteredClient {
    const name = typeof input.client_name === 'string' ? input.client_name.slice(0, 120) : '';
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
    if (!name.trim()) throw new OAuthError('invalid_request', 'client_name is required');
    if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && HTTPS_OR_LOOPBACK(u))) {
      throw new OAuthError('invalid_request', 'redirect_uris must be 1-10 https (or loopback) URIs');
    }
    const requested = typeof input.scope === 'string' ? input.scope.split(' ').filter(Boolean) : [...ALL_SCOPES];
    const scopes = requested.filter((s) => (ALL_SCOPES as readonly string[]).includes(s));
    if (scopes.length === 0) throw new OAuthError('invalid_scope', 'no recognized scopes requested');

    const client: RegisteredClient = {
      client_id: crypto.randomUUID(),
      client_name: name,
      redirect_uris: uris as string[],
      token_endpoint_auth_method: 'none',
      scope: scopes.join(' '),
      created_at: new Date(this.now()).toISOString(),
    };
    this.clients.set(client.client_id, client);
    return { ...client, redirect_uris: [...client.redirect_uris] };
  }

  getClient(clientId: string): RegisteredClient | null {
    const c = this.clients.get(clientId);
    return c ? { ...c, redirect_uris: [...c.redirect_uris] } : null;
  }

  /**
   * Validate an authorize request and produce the consent-page handoff URL.
   * No identity is involved yet — the frontend authenticates the user and
   * calls decision() with the outcome.
   */
  buildConsentRedirect(q: Record<string, unknown>): string {
    this.validateAuthorizeParams(q);
    const u = new URL(this.opts.consentUrl);
    for (const k of ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource']) {
      if (typeof q[k] === 'string') u.searchParams.set(k, q[k] as string);
    }
    const client = this.clients.get(String(q.client_id))!;
    u.searchParams.set('client_name', client.client_name);
    return u.toString();
  }

  private validateAuthorizeParams(q: Record<string, unknown>): RegisteredClient {
    const client = this.clients.get(String(q.client_id ?? ''));
    if (!client) throw new OAuthError('invalid_client', 'unknown client_id');
    if (q.response_type !== 'code') throw new OAuthError('invalid_request', 'response_type must be code');
    if (typeof q.redirect_uri !== 'string' || !client.redirect_uris.includes(q.redirect_uri)) {
      throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
    }
    if (typeof q.code_challenge !== 'string' || q.code_challenge.length < 43) {
      throw new OAuthError('invalid_request', 'PKCE code_challenge is required');
    }
    if (q.code_challenge_method !== 'S256') {
      throw new OAuthError('invalid_request', 'code_challenge_method must be S256');
    }
    return client;
  }

  /**
   * Consent decision from the frontend: the user's Supabase access token
   * proves identity; approvedScopes is what the human actually ticked.
   * Returns the client redirect URL carrying the single-use code.
   */
  async decision(input: {
    params: Record<string, unknown>;
    supabaseAccessToken: string;
    approved: boolean;
    approvedScopes?: string[];
  }): Promise<{ redirectTo: string }> {
    const client = this.validateAuthorizeParams(input.params);
    const redirectUri = String(input.params.redirect_uri);
    const state = typeof input.params.state === 'string' ? input.params.state : undefined;
    const back = new URL(redirectUri);
    if (state) back.searchParams.set('state', state);

    if (!input.approved) {
      back.searchParams.set('error', 'access_denied');
      return { redirectTo: back.toString() };
    }

    const user = await this.opts.identity.verify(input.supabaseAccessToken);
    if (!user) throw new OAuthError('access_denied', 'end-user authentication failed');

    const clientScopes = client.scope.split(' ');
    const requested = typeof input.params.scope === 'string'
      ? (input.params.scope as string).split(' ').filter(Boolean)
      : clientScopes;
    // granted = requested ∩ registered ∩ human-approved. Nothing widens it.
    const approvedSet = new Set(input.approvedScopes ?? requested);
    const granted = requested.filter((s) => clientScopes.includes(s) && approvedSet.has(s));
    if (granted.length === 0) throw new OAuthError('invalid_scope', 'no scopes were approved');

    const code: AuthCode = {
      code: crypto.randomBytes(32).toString('base64url'),
      clientId: client.client_id,
      redirectUri,
      codeChallenge: String(input.params.code_challenge),
      userId: user.userId,
      tenantId: user.tenantId,
      scopes: granted,
      resource: this.opts.resourceUrl,
      expiresAt: this.now() + (this.opts.codeTtlMs ?? 5 * 60_000),
      used: false,
      mintedJtis: [],
      mintedFamilyIds: [],
    };
    this.codes.set(code.code, code);
    back.searchParams.set('code', code.code);
    return { redirectTo: back.toString() };
  }

  /** Token endpoint: authorization_code + PKCE, and refresh_token rotation. */
  token(body: Record<string, unknown>): {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_token: string;
    scope: string;
  } {
    const grantType = body.grant_type;
    if (grantType === 'authorization_code') return this.tokenFromCode(body);
    if (grantType === 'refresh_token') return this.tokenFromRefresh(body);
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  private tokenFromCode(body: Record<string, unknown>) {
    const record = this.codes.get(String(body.code ?? ''));
    if (!record || record.expiresAt < this.now()) throw new OAuthError('invalid_grant', 'unknown or expired code');
    if (record.used) {
      // OAuth 2.1 replay defense: a reused code revokes everything it minted —
      // access-token jtis AND the refresh families the exchange created, so a
      // surviving refresh token cannot re-mint around the revocation.
      for (const jti of record.mintedJtis) this.revokedJtis.add(jti);
      this.burnFamilies(record.mintedFamilyIds);
      throw new OAuthError('invalid_grant', 'code already used — issued tokens revoked');
    }
    if (String(body.client_id ?? '') !== record.clientId) throw new OAuthError('invalid_client', 'client mismatch');
    if (String(body.redirect_uri ?? '') !== record.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
    }
    const verifier = String(body.code_verifier ?? '');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (verifier.length < 43 || !timingSafeEq(challenge, record.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }
    record.used = true;
    return this.mint(record.clientId, record.userId, record.tenantId, record.scopes, record.resource, record.mintedJtis, undefined, record.mintedFamilyIds);
  }

  private burnFamilies(familyIds: string[]): void {
    if (familyIds.length === 0) return;
    const burn = new Set(familyIds);
    for (const [, r] of this.refresh) {
      if (burn.has(r.familyId)) {
        r.rotated = true;
        for (const jti of r.mintedJtis) this.revokedJtis.add(jti);
      }
    }
  }

  private tokenFromRefresh(body: Record<string, unknown>) {
    const record = this.refresh.get(String(body.refresh_token ?? ''));
    if (!record || record.expiresAt < this.now()) throw new OAuthError('invalid_grant', 'unknown or expired refresh token');
    if (record.rotated) {
      // Reuse of a rotated refresh token → the whole family is burned.
      this.burnFamilies([record.familyId]);
      throw new OAuthError('invalid_grant', 'refresh token reuse detected — family revoked');
    }
    if (String(body.client_id ?? '') !== record.clientId) throw new OAuthError('invalid_client', 'client mismatch');
    record.rotated = true;
    return this.mint(record.clientId, record.userId, record.tenantId, record.scopes, record.resource, record.mintedJtis, record.familyId);
  }

  private mint(
    clientId: string,
    userId: string,
    tenantId: string,
    scopes: string[],
    resource: string,
    parentJtis: string[],
    familyId?: string,
    familyOut?: string[],
  ) {
    const nowSec = Math.floor(this.now() / 1000);
    const ttl = this.opts.accessTokenTtlSec ?? 15 * 60;
    const jti = crypto.randomUUID();
    parentJtis.push(jti);
    const accessToken = signEs256Jwt(this.opts.keys, {
      iss: this.opts.issuer,
      sub: userId,
      aud: resource,
      tenant_id: tenantId,
      client_id: clientId,
      scope: scopes.join(' '),
      iat: nowSec,
      exp: nowSec + ttl,
      jti,
    });
    const refreshRecord: RefreshRecord = {
      token: crypto.randomBytes(32).toString('base64url'),
      familyId: familyId ?? crypto.randomUUID(),
      clientId,
      userId,
      tenantId,
      scopes,
      resource,
      expiresAt: this.now() + (this.opts.refreshTokenTtlSec ?? 30 * 86_400) * 1000,
      rotated: false,
      mintedJtis: [jti],
    };
    this.refresh.set(refreshRecord.token, refreshRecord);
    familyOut?.push(refreshRecord.familyId);
    return {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: ttl,
      refresh_token: refreshRecord.token,
      scope: scopes.join(' '),
    };
  }

  /** Revocation feed for the resource server's per-request check. */
  isJtiRevoked(jti: string): boolean {
    return this.revokedJtis.has(jti);
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Production identity delegation: verify a Supabase access token via GoTrue.
 *
 * Tenant resolution mirrors the gateway's canonical identity middleware
 * (auth-supabase-jwt.ts extractIdentity): the ACTIVE tenant claim is
 * `app_metadata.active_tenant_id`. A user without one is REJECTED rather
 * than silently elevated to the platform tenant — a wrong-tenant token
 * routes requests and audit records to the wrong tenant.
 */
export class SupabaseIdentityVerifier implements IdentityVerifier {
  constructor(
    private readonly supabaseUrl: string,
    private readonly anonKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string): Promise<{ userId: string; tenantId: string } | null> {
    if (!token) return null;
    try {
      const res = await this.fetchImpl(`${this.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: this.anonKey },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        id?: string;
        app_metadata?: { active_tenant_id?: string; tenant_id?: string };
      };
      if (!body.id) return null;
      // Canonical claim first; legacy tenant_id tolerated for older tokens.
      const tenantId = body.app_metadata?.active_tenant_id ?? body.app_metadata?.tenant_id;
      if (!tenantId) return null;
      return { userId: body.id, tenantId };
    } catch {
      return null;
    }
  }
}
