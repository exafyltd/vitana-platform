/**
 * VTID-03827 — Cognito auth-proxy client tests.
 *
 * Mirrors the S3Client mocking pattern from
 * test/providers/storage-provider.test.ts: mock the SDK client's `.send`,
 * not the whole module's logic.
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const send = jest.fn();
  return {
    CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send })),
    InitiateAuthCommand: jest.fn((input) => ({ __type: 'InitiateAuthCommand', input })),
  };
});

import {
  isCognitoAuthConfigured,
  getCognitoAuthRegion,
  cognitoLogin,
  cognitoRefresh,
  resetCognitoClientForTests,
} from '../../src/services/cognito-auth-client';

function mockSend(): jest.Mock {
  return (new CognitoIdentityProviderClient({}) as any).send;
}

/** A structurally-valid (unsigned, unverified) JWT — decodeJwt() never checks the signature. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64url = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.fake-signature`;
}

describe('cognito-auth-client (VTID-03827)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    resetCognitoClientForTests();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_APP_CLIENT_ID;
    delete process.env.COGNITO_REGION;
    delete process.env.AWS_REGION;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('isCognitoAuthConfigured / getCognitoAuthRegion', () => {
    it('is false unless both pool id and app client id are set', () => {
      expect(isCognitoAuthConfigured()).toBe(false);
      process.env.COGNITO_USER_POOL_ID = 'pool-1';
      expect(isCognitoAuthConfigured()).toBe(false);
      process.env.COGNITO_APP_CLIENT_ID = 'client-1';
      expect(isCognitoAuthConfigured()).toBe(true);
    });

    it('defaults region to eu-central-1, honoring COGNITO_REGION then AWS_REGION', () => {
      expect(getCognitoAuthRegion()).toBe('eu-central-1');
      process.env.AWS_REGION = 'us-east-1';
      expect(getCognitoAuthRegion()).toBe('us-east-1');
      process.env.COGNITO_REGION = 'eu-west-1';
      expect(getCognitoAuthRegion()).toBe('eu-west-1');
    });
  });

  describe('cognitoLogin', () => {
    beforeEach(() => {
      process.env.COGNITO_USER_POOL_ID = 'eu-central-1_TestPool';
      process.env.COGNITO_APP_CLIENT_ID = 'test-client-id';
    });

    it('returns tokens and maps custom:legacy_user_id to user.id', async () => {
      mockSend().mockResolvedValue({
        AuthenticationResult: {
          IdToken: makeIdToken({
            sub: 'cognito-random-sub',
            email: 'user@example.com',
            'custom:legacy_user_id': 'legacy-uuid-123',
          }),
          RefreshToken: 'refresh-abc',
          ExpiresIn: 3600,
          TokenType: 'Bearer',
        },
      });

      const result = await cognitoLogin('user@example.com', 'hunter2');

      expect(result).toMatchObject({
        ok: true,
        refresh_token: 'refresh-abc',
        expires_in: 3600,
        token_type: 'Bearer',
        user: { id: 'legacy-uuid-123', email: 'user@example.com' },
      });
      expect(InitiateAuthCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: 'test-client-id',
          AuthParameters: { USERNAME: 'user@example.com', PASSWORD: 'hunter2' },
        })
      );
    });

    it('falls back to the Cognito sub when custom:legacy_user_id is absent', async () => {
      mockSend().mockResolvedValue({
        AuthenticationResult: {
          IdToken: makeIdToken({ sub: 'cognito-sub-xyz', email: 'user@example.com' }),
          ExpiresIn: 3600,
          TokenType: 'Bearer',
        },
      });

      const result = await cognitoLogin('user@example.com', 'hunter2');
      expect(result.ok).toBe(true);
      expect((result as any).user.id).toBe('cognito-sub-xyz');
    });

    it('returns CHALLENGE_REQUIRED when Cognito responds with a challenge instead of tokens', async () => {
      mockSend().mockResolvedValue({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-1' });

      const result = await cognitoLogin('user@example.com', 'hunter2');
      expect(result).toEqual({
        ok: false,
        error: 'CHALLENGE_REQUIRED',
        message: 'Additional authentication step required — not supported by this login endpoint.',
      });
    });

    it('collapses any thrown Cognito error to a generic INVALID_CREDENTIALS without leaking which part was wrong', async () => {
      mockSend().mockRejectedValue(Object.assign(new Error('Incorrect username or password.'), { name: 'NotAuthorizedException' }));

      const result = await cognitoLogin('user@example.com', 'wrong');
      expect(result).toEqual({
        ok: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    });

    it('reports INTERNAL_ERROR without calling Cognito when COGNITO_APP_CLIENT_ID is unset', async () => {
      delete process.env.COGNITO_APP_CLIENT_ID;
      const result = await cognitoLogin('user@example.com', 'hunter2');
      expect(result).toEqual({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Cognito configuration not available',
      });
      expect(mockSend()).not.toHaveBeenCalled();
    });

    it('memoizes the Cognito client across calls until resetCognitoClientForTests()', async () => {
      const send = mockSend(); // this setup call itself constructs one client instance
      send.mockResolvedValue({
        AuthenticationResult: { IdToken: makeIdToken({ sub: 's1' }), TokenType: 'Bearer' },
      });
      const ctorCallsBeforeLogins = (CognitoIdentityProviderClient as unknown as jest.Mock).mock.calls.length;

      await cognitoLogin('a@example.com', 'p');
      await cognitoLogin('b@example.com', 'p');

      // Exactly one more construction (the module's own lazy init on the
      // first call) — the second cognitoLogin() reuses the memoized client.
      expect((CognitoIdentityProviderClient as unknown as jest.Mock).mock.calls.length).toBe(
        ctorCallsBeforeLogins + 1
      );
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('cognitoRefresh', () => {
    beforeEach(() => {
      process.env.COGNITO_USER_POOL_ID = 'eu-central-1_TestPool';
      process.env.COGNITO_APP_CLIENT_ID = 'test-client-id';
    });

    it('returns fresh tokens and echoes the original refresh token when Cognito does not issue a new one', async () => {
      mockSend().mockResolvedValue({
        AuthenticationResult: {
          IdToken: makeIdToken({ sub: 's1' }),
          ExpiresIn: 3600,
          TokenType: 'Bearer',
          // no RefreshToken field — Cognito's normal refresh behavior
        },
      });

      const result = await cognitoRefresh('original-refresh-token');
      expect(result).toMatchObject({ ok: true, refresh_token: 'original-refresh-token' });
      expect(InitiateAuthCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: { REFRESH_TOKEN: 'original-refresh-token' },
        })
      );
    });

    it('maps a thrown Cognito error to INVALID_REFRESH_TOKEN', async () => {
      mockSend().mockRejectedValue(Object.assign(new Error('Refresh Token has expired'), { name: 'NotAuthorizedException' }));

      const result = await cognitoRefresh('stale-token');
      expect(result).toEqual({
        ok: false,
        error: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or expired',
      });
    });
  });
});
