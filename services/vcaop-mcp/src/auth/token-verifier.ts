/**
 * OAuth 2.1 resource-server side: access-token verification.
 *
 * The authorization-server choice is an open security decision (BLK-007), so
 * verification is behind the `TokenVerifier` interface. `HmacTokenVerifier`
 * is the DEV/TEST implementation (HS256, shared secret from env) used against
 * the spec-shaped test AS; the production implementation (JWKS/RS256 against
 * the approved AS) drops in behind the same interface without touching any
 * caller. No implementation here ever mints tokens.
 */
import * as crypto from 'crypto';
import { AuthContext } from '../types';

export interface VerifyResult {
  ok: boolean;
  /** Machine-readable failure reason (stable). */
  reason?:
    | 'malformed'
    | 'bad_signature'
    | 'expired'
    | 'wrong_audience'
    | 'revoked'
    | 'missing_claims';
  context?: AuthContext;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifyResult>;
}

/** Revocation is checked on EVERY request so revoking access bites immediately. */
export interface RevocationStore {
  isRevoked(jti: string): Promise<boolean>;
}

export class InMemoryRevocationStore implements RevocationStore {
  private revoked = new Set<string>();
  revoke(jti: string): void {
    this.revoked.add(jti);
  }
  async isRevoked(jti: string): Promise<boolean> {
    return this.revoked.has(jti);
  }
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface HmacVerifierOptions {
  /** Shared HS256 secret (dev/test AS only — never a production credential). */
  secret: string;
  /** Expected audience, e.g. https://mcp.vitanaland.com/mcp */
  audience: string;
  revocations?: RevocationStore;
  /** Injectable clock for expiry tests. */
  now?: () => number;
}

export class HmacTokenVerifier implements TokenVerifier {
  constructor(private readonly opts: HmacVerifierOptions) {}

  async verify(token: string): Promise<VerifyResult> {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [headerB64, payloadB64, sigB64] = parts;

    let header: { alg?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
      payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (header.alg !== 'HS256') return { ok: false, reason: 'malformed' };

    const expected = crypto
      .createHmac('sha256', this.opts.secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const actual = b64urlDecode(sigB64);
    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual)
    ) {
      return { ok: false, reason: 'bad_signature' };
    }

    const nowSec = Math.floor((this.opts.now ? this.opts.now() : Date.now()) / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      return { ok: false, reason: 'expired' };
    }
    const aud = payload.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(this.opts.audience)
      : aud === this.opts.audience;
    if (!audOk) return { ok: false, reason: 'wrong_audience' };

    const sub = payload.sub;
    const tenantId = payload.tenant_id;
    const clientId = payload.client_id;
    const scope = payload.scope;
    if (
      typeof sub !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof clientId !== 'string' ||
      typeof scope !== 'string'
    ) {
      return { ok: false, reason: 'missing_claims' };
    }

    const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
    if (jti && this.opts.revocations && (await this.opts.revocations.isRevoked(jti))) {
      return { ok: false, reason: 'revoked' };
    }

    return {
      ok: true,
      context: {
        userId: sub,
        tenantId,
        clientId,
        scopes: scope.split(' ').filter(Boolean),
        jti,
      },
    };
  }
}

/** Test/dev helper: mint an HS256 token. Lives here so tests and the dev AS share one implementation. */
export function mintHs256Token(
  secret: string,
  claims: Record<string, unknown>,
): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const headerB64 = enc({ alg: 'HS256', typ: 'JWT' });
  const payloadB64 = enc(claims);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}
