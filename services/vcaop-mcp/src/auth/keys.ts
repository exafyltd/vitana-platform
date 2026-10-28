/**
 * ES256 signing keys for the embedded authorization server (BLK-007).
 *
 * Production: the private key arrives as a PEM via env (a secret REFERENCE
 * resolved by the deploy platform — never checked in). Dev/test: an
 * ephemeral P-256 keypair is generated at boot with a loud log line, so a
 * restart invalidates every outstanding token — acceptable for dev, and it
 * means a missing key can never silently become a hardcoded one.
 */
import * as crypto from 'crypto';

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  use: 'sig';
  alg: 'ES256';
}

export class SigningKeys {
  private constructor(
    readonly privateKey: crypto.KeyObject,
    readonly publicKey: crypto.KeyObject,
    readonly kid: string,
  ) {}

  static fromPem(privatePem: string): SigningKeys {
    const privateKey = crypto.createPrivateKey(privatePem);
    const publicKey = crypto.createPublicKey(privateKey);
    return new SigningKeys(privateKey, publicKey, thumbprint(publicKey));
  }

  static ephemeral(): SigningKeys {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return new SigningKeys(privateKey, publicKey, thumbprint(publicKey));
  }

  publicJwk(): PublicJwk {
    const jwk = this.publicKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    return { ...jwk, kid: this.kid, use: 'sig', alg: 'ES256' };
  }

  jwks(): { keys: PublicJwk[] } {
    return { keys: [this.publicJwk()] };
  }
}

/** RFC 7638 JWK thumbprint (P-256). */
function thumbprint(publicKey: crypto.KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Sign an ES256 JWT (IEEE P1363 signature encoding, per JWS). */
export function signEs256Jwt(keys: SigningKeys, claims: Record<string, unknown>): string {
  const headerB64 = b64url({ alg: 'ES256', typ: 'JWT', kid: keys.kid });
  const payloadB64 = b64url(claims);
  const sig = crypto
    .sign('sha256', Buffer.from(`${headerB64}.${payloadB64}`), {
      key: keys.privateKey,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}

export function verifyEs256Signature(publicKey: crypto.KeyObject, token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts;
  try {
    return crypto.verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    );
  } catch {
    return false;
  }
}
