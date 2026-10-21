/**
 * VTID-03827 — Cognito auth-proxy client.
 *
 * Wraps `InitiateAuth` (USER_PASSWORD_AUTH + REFRESH_TOKEN_AUTH) so
 * `routes/auth.ts`'s `/login` and `/refresh` can proxy to Cognito the same
 * way they've always proxied to Supabase GoTrue — the frontend's request/
 * response shape at those two endpoints does not change either way.
 *
 * Additive + gated exactly like the JWT verification path added alongside
 * this (auth-supabase-jwt.ts's Cognito branch): `isCognitoAuthConfigured()`
 * gates every call site in routes/auth.ts, so with COGNITO_USER_POOL_ID/
 * COGNITO_APP_CLIENT_ID unset (as on every live task def today) this module
 * is never invoked and behavior is byte-for-byte the pre-existing Supabase
 * proxy.
 *
 * NOT YET EXERCISED against a live Cognito pool — this repo's AWS
 * credentials are denied all cognito-idp:* actions by an IAM permissions
 * boundary (see infra/cognito-migration/README.md). Treat this as reviewed
 * but unverified; the first real login attempt against a real pool is the
 * actual test.
 *
 * DELIBERATELY NOT IMPLEMENTED: `RespondToAuthChallenge`. The User Pool
 * this targets (infra/cognito-migration/cognito.tf) sets
 * `admin_create_user_config.allow_admin_create_user_only = true`, and the
 * only thing that ever creates a user is the User Migration Lambda, which
 * always sets `finalUserStatus: 'CONFIRMED'` — so a login challenge
 * (NEW_PASSWORD_REQUIRED, MFA, …) should never occur for this pool's design
 * as it stands today. If `InitiateAuth` ever returns a `ChallengeName`
 * instead of an `AuthenticationResult`, that is surfaced as an explicit
 * `CHALLENGE_REQUIRED` error rather than silently mishandled or ignored —
 * implement the real challenge flow if/when this pool's config changes to
 * actually need one.
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  type InitiateAuthCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import * as jose from 'jose';

export interface CognitoTokenResult {
  ok: true;
  access_token: string; // Cognito's ID token — see decodeIdToken()'s doc comment for why
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  user?: { id: string; email: string | null };
}

export interface CognitoAuthError {
  ok: false;
  error: string;
  message: string;
}

export type CognitoAuthResult = CognitoTokenResult | CognitoAuthError;

export function isCognitoAuthConfigured(): boolean {
  return !!(process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_APP_CLIENT_ID);
}

/** Region resolution mirrors the Bedrock/Polly adapters' precedence (CLAUDE.md §2b). */
export function getCognitoAuthRegion(): string {
  return process.env.COGNITO_REGION || process.env.AWS_REGION || 'eu-central-1';
}

let cognitoClient: CognitoIdentityProviderClient | null = null;

function getCognitoClient(): CognitoIdentityProviderClient {
  if (!cognitoClient) {
    cognitoClient = new CognitoIdentityProviderClient({ region: getCognitoAuthRegion() });
  }
  return cognitoClient;
}

/** Test seam — drop the memoized client so a new region/credential set applies. */
export function resetCognitoClientForTests(): void {
  cognitoClient = null;
}

/**
 * Decodes (does NOT verify — Cognito's own SDK response over TLS is already
 * the trust boundary here, the same way routes/auth.ts already trusts
 * `authData.user.id` straight out of a direct GoTrue response) the ID token
 * Cognito just issued, to pull out:
 *   - `user_id`: the `custom:legacy_user_id` claim, NOT Cognito's own `sub`
 *     — see auth-supabase-jwt.ts's `extractCognitoIdentity()` for why every
 *     FK/RLS policy/app_users row needs the ORIGINAL Supabase id, not
 *     Cognito's freshly-assigned one.
 *   - `email`.
 *
 * Returning the ID token (not Cognito's AccessToken) as `access_token` is
 * deliberate: the gateway's own JWT verification
 * (auth-supabase-jwt.ts::verifyAndExtractIdentity) only accepts
 * `token_use==='id'`, because Cognito access tokens carry no email/custom
 * claims at all. Whatever this module returns as `access_token` is exactly
 * what a client is expected to send back as `Authorization: Bearer <...>`.
 */
function decodeIdToken(idToken: string): { user_id: string; email: string | null } {
  const claims = jose.decodeJwt(idToken);
  const legacyUserId = (claims['custom:legacy_user_id'] as string) || claims.sub || '';
  return { user_id: legacyUserId, email: (claims.email as string) || null };
}

function mapCognitoError(err: unknown, fallbackError: string, genericMessage: string): CognitoAuthError {
  const name = (err as { name?: string })?.name || 'UnknownError';
  const message = (err as Error)?.message || 'Authentication failed';
  console.warn(`[VTID-03827] Cognito auth error (${name}): ${message}`);
  // Deliberately collapse every failure mode (bad password, unknown user,
  // unconfirmed, rate-limited, expired refresh token) to one generic
  // per-endpoint message — matches the existing Supabase branch's posture
  // and this pool's own prevent_user_existence_errors=ENABLED setting
  // (don't leak which part was wrong).
  return { ok: false, error: fallbackError, message: genericMessage };
}

function handleChallenge(result: InitiateAuthCommandOutput): CognitoAuthError {
  console.warn(
    `[VTID-03827] Cognito InitiateAuth returned a challenge (${result.ChallengeName}) instead of tokens — not implemented, see cognito-auth-client.ts header comment`
  );
  return {
    ok: false,
    error: 'CHALLENGE_REQUIRED',
    message: 'Additional authentication step required — not supported by this login endpoint.',
  };
}

/**
 * Cognito equivalent of GoTrue's `POST /auth/v1/token?grant_type=password`.
 * On a user's first-ever attempt, this is also what triggers the User
 * Migration Lambda (infra/cognito-migration/lambda/index.js) behind the
 * scenes — Cognito calls it automatically as part of this same
 * InitiateAuth call when the user doesn't exist yet in the pool.
 */
export async function cognitoLogin(email: string, password: string): Promise<CognitoAuthResult> {
  const clientId = process.env.COGNITO_APP_CLIENT_ID;
  if (!clientId) {
    return { ok: false, error: 'INTERNAL_ERROR', message: 'Cognito configuration not available' };
  }

  try {
    const result = await getCognitoClient().send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    );

    const tokens = result.AuthenticationResult;
    if (!tokens?.IdToken) {
      return handleChallenge(result);
    }

    const { user_id, email: tokenEmail } = decodeIdToken(tokens.IdToken);
    return {
      ok: true,
      access_token: tokens.IdToken,
      refresh_token: tokens.RefreshToken,
      expires_in: tokens.ExpiresIn,
      token_type: tokens.TokenType || 'Bearer',
      user: { id: user_id, email: tokenEmail || email },
    };
  } catch (err) {
    return mapCognitoError(err, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
}

/**
 * Cognito equivalent of GoTrue's `POST /auth/v1/token?grant_type=refresh_token`.
 * Cognito does NOT issue a new refresh token on refresh — the original one
 * keeps working until its own (much longer) expiry, so callers should keep
 * reusing the refresh_token they already have; this still echoes it back
 * for parity with the Supabase response shape, which does rotate it.
 */
export async function cognitoRefresh(refreshToken: string): Promise<CognitoAuthResult> {
  const clientId = process.env.COGNITO_APP_CLIENT_ID;
  if (!clientId) {
    return { ok: false, error: 'INTERNAL_ERROR', message: 'Cognito configuration not available' };
  }

  try {
    const result = await getCognitoClient().send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      })
    );

    const tokens = result.AuthenticationResult;
    if (!tokens?.IdToken) {
      return handleChallenge(result);
    }

    return {
      ok: true,
      access_token: tokens.IdToken,
      refresh_token: tokens.RefreshToken || refreshToken,
      expires_in: tokens.ExpiresIn,
      token_type: tokens.TokenType || 'Bearer',
    };
  } catch (err) {
    return mapCognitoError(err, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }
}
