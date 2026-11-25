/**
 * VTID-05702 (plan agentic-delivery-v2 §10, §11, Phase 0 P3) — lane delivery-bedrock.
 *
 * Delivery stages (the plan-sparring responder and the review service — built
 * in the later lanes `spar-responder`/`review-service`, both `depends_on:
 * [delivery-bedrock]`) call Bedrock through a role, `vitana-delivery-bedrock`,
 * in the SEPARATE `vitana-engineering` AWS account, so their traffic never
 * shares — or depends on — production's Bedrock quota in account
 * 472838866351 (plan.md §10: "Gateway delivery stages | task role → role
 * vitana-delivery-bedrock in vitana-engineering"). `scripts/aws/
 * setup-delivery-bedrock.sh` provisions that role's AWS side (run by the
 * owner only — this session has no credentials into vitana-engineering).
 * This suite covers the gateway's side: `invokeBedrock({ useDeliveryRole:
 * true, ... })` resolves a cross-account credential via `sts:AssumeRole`
 * instead of using the caller's own task role / BEDROCK_ROLE_ARN gate.
 *
 * Every EXISTING call site (llm-router.ts etc.) is unaffected — none of them
 * sets `useDeliveryRole`, so `invokeBedrock()` runs its original code path
 * byte-for-byte (see the "default call path is unaffected" test below).
 *
 * Why a hand-rolled AWS Signature Version 4 signer (`signAwsRequestV4`)
 * instead of `@aws-sdk/client-sts` / `@aws-sdk/credential-providers`: this
 * lane's declared paths (`.kiro/specs/agentic-delivery-v2/lanes/
 * delivery-bedrock.md`) are exactly `scripts/aws/setup-delivery-bedrock.sh`,
 * this file, and `services/gateway/src/providers/bedrock.ts` — not
 * `package.json` / `pnpm-lock.yaml` — so a new npm dependency cannot be added
 * from inside this lane (the PR-GATE "Lane scope" check fails any file
 * outside those three). Neither package is already installed, even
 * transitively reachable from this package (`services/gateway`'s own direct
 * dependencies resolve only `@aws-sdk/credential-provider-node`, already
 * used below for the CALLER's own credentials — see getGatewayTaskRoleCredentials).
 * The one `sts:AssumeRole` call this needs is therefore signed directly with
 * Node's built-in `crypto`. `signAwsRequestV4`'s output for a fixed worked
 * example below was cross-checked, byte-for-byte, against the independent,
 * widely-used `aws4` npm reference signer for the identical inputs during
 * development (not part of this repository — see the PR description for the
 * verification transcript); the fixed-vector tests below pin that result as
 * a regression anchor.
 */

import {
  invokeBedrock,
  signAwsRequestV4,
  getDeliveryBedrockCredentials,
  __resetDeliveryBedrockCredentialsCacheForTests,
  type AssumedRoleCredentials,
} from '../../src/providers/bedrock';

// plan sparring-eu-guard C2: tests set the region explicitly (there is no default region)
process.env.AWS_REGION = process.env.AWS_REGION || 'eu-central-1';

// ---------------------------------------------------------------------------
// signAwsRequestV4 — pure, no network, no mocking. Exported for tests, same
// convention as buildBedrockRequestBody/parseBedrockContent in this file.
// ---------------------------------------------------------------------------
describe('VTID-05702 signAwsRequestV4', () => {
  // The well-known AWS-docs-style example credentials (AKIDEXAMPLE / wJalrXUtnFEMI...)
  // against a realistic sts:AssumeRole request for the delivery role. Fixed
  // date/credentials/body so the signature is fully deterministic.
  const fixture = {
    method: 'POST',
    host: 'sts.eu-central-1.amazonaws.com',
    path: '/',
    region: 'eu-central-1',
    service: 'sts',
    body:
      'Action=AssumeRole&DurationSeconds=3600&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Fvitana-delivery-bedrock&RoleSessionName=vitana-gateway-delivery-bedrock&Version=2011-06-15',
    amzDate: '20261111T120000Z',
    contentType: 'application/x-www-form-urlencoded; charset=utf-8',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('matches an independently cross-checked signature, with a caller session token', () => {
    const out = signAwsRequestV4({
      ...fixture,
      sessionToken: 'FQoDYXdzEXAMPLEtokenONLYFORSIGV4CROSSCHECK',
    });
    expect(out.signedHeaders).toBe('content-length;content-type;host;x-amz-date;x-amz-security-token');
    expect(out.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261111/eu-central-1/sts/aws4_request, ' +
        'SignedHeaders=content-length;content-type;host;x-amz-date;x-amz-security-token, ' +
        'Signature=6d59486b8e4e02b8f7ebb5540e4c6b3f2c4738dc0c7790764faf65542565917c',
    );
  });

  it('matches an independently cross-checked signature, with no session token', () => {
    const out = signAwsRequestV4(fixture);
    expect(out.signedHeaders).toBe('content-length;content-type;host;x-amz-date');
    expect(out.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261111/eu-central-1/sts/aws4_request, ' +
        'SignedHeaders=content-length;content-type;host;x-amz-date, ' +
        'Signature=705e78e697e84561cb5d017edc9745cee2c741d73f0856085cdf1aca5b9bd785',
    );
  });

  it('is deterministic: identical input always produces an identical signature', () => {
    const a = signAwsRequestV4(fixture);
    const b = signAwsRequestV4({ ...fixture });
    expect(a.authorization).toBe(b.authorization);
  });

  it('changes the signature when the secret key changes (the key is actually used)', () => {
    const a = signAwsRequestV4(fixture);
    const b = signAwsRequestV4({ ...fixture, secretAccessKey: 'differentSecretKeyEXAMPLEEXAMPLE1234567' });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('changes the signature when the body changes (the payload hash is covered)', () => {
    const a = signAwsRequestV4(fixture);
    const b = signAwsRequestV4({ ...fixture, body: `${fixture.body}&Extra=1` });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('includes x-amz-security-token in SignedHeaders only when a session token is present', () => {
    const withToken = signAwsRequestV4({ ...fixture, sessionToken: 'tok' });
    const withoutToken = signAwsRequestV4(fixture);
    expect(withToken.signedHeaders).toContain('x-amz-security-token');
    expect(withoutToken.signedHeaders).not.toContain('x-amz-security-token');
  });
});

// ---------------------------------------------------------------------------
// invokeBedrock — the public gate. No mocking beyond what the suite's shared
// setup already does (global fetch is mocked process-wide by
// test/__mocks__/setup-tests.ts; its default handler 200s with a plain-text
// body for any URL it doesn't special-case, which is what an STS host hits).
// Same "let a real credential/network failure surface as invoke_failed"
// convention as the existing BEDROCK_ROLE_ARN gate tests in
// bedrock-vision-tools.test.ts.
// ---------------------------------------------------------------------------
describe('VTID-05702 invokeBedrock delivery-role gate', () => {
  const ENV_KEYS = [
    'DELIVERY_BEDROCK_ROLE_ARN',
    'DELIVERY_BEDROCK_REGION',
    'BEDROCK_ROLE_ARN',
    'AWS_BEDROCK_REGION',
    'AWS_REGION',
  ] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    __resetDeliveryBedrockCredentialsCacheForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reports not_configured when DELIVERY_BEDROCK_ROLE_ARN is unset, even if BEDROCK_ROLE_ARN IS set', async () => {
    delete process.env.DELIVERY_BEDROCK_ROLE_ARN;
    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/vitana-ecs-task-role';
    const res = await invokeBedrock({
      model: 'eu.anthropic.claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      useDeliveryRole: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('not_configured');
      expect(res.message).toMatch(/DELIVERY_BEDROCK_ROLE_ARN/);
    }
  });

  it('does not require BEDROCK_ROLE_ARN for a delivery-role call — the two gates are independent', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    process.env.DELIVERY_BEDROCK_ROLE_ARN = 'arn:aws:iam::999999999999:role/vitana-delivery-bedrock';
    process.env.DELIVERY_BEDROCK_REGION = 'eu-central-1';
    const res = await invokeBedrock({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      useDeliveryRole: true,
    });
    // Gets PAST the config gate; fails for real further down (no AWS
    // credentials for this sandbox's own identity to assume the delivery
    // role with, and the mocked fetch's default 200/plain-text response has
    // no <Credentials> block to parse) — the same not_configured-vs-
    // invoke_failed distinction bedrock-vision-tools.test.ts already relies on.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invoke_failed');
  }, 30_000);

  it('the default (non-delivery) call path is unaffected: still gated by BEDROCK_ROLE_ARN alone', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    process.env.DELIVERY_BEDROCK_ROLE_ARN = 'arn:aws:iam::999999999999:role/vitana-delivery-bedrock';
    const res = await invokeBedrock({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      // useDeliveryRole omitted — byte-for-byte today's behaviour.
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not_configured');
  });

  it('reports a region-specific not_configured message when no region can be resolved', async () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_BEDROCK_REGION;
    delete process.env.DELIVERY_BEDROCK_REGION;
    process.env.DELIVERY_BEDROCK_ROLE_ARN = 'arn:aws:iam::999999999999:role/vitana-delivery-bedrock';
    const res = await invokeBedrock({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      useDeliveryRole: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('not_configured');
      expect(res.message).toMatch(/DELIVERY_BEDROCK_REGION/);
    }
  });
});

// ---------------------------------------------------------------------------
// getDeliveryBedrockCredentials — the assumption + cache, with a fake caller-
// credential provider injected (so no real AWS identity is needed) and the
// suite's already-mocked global `fetch` programmed with a realistic STS
// AssumeRole XML response. This is the strong, deterministic proof that the
// delivery path really does perform a distinct sts:AssumeRole exchange and
// caches/refreshes it, not just "eventually fails for some reason".
// ---------------------------------------------------------------------------
describe('VTID-05702 getDeliveryBedrockCredentials', () => {
  const ROLE_ARN = 'arn:aws:iam::999999999999:role/vitana-delivery-bedrock';
  const REGION = 'eu-central-1';

  const fakeCaller = async () => ({
    accessKeyId: 'ASIAFAKECALLERTASKROLE',
    secretAccessKey: 'fakeCallerTaskRoleSecretKeyEXAMPLE1234567',
    sessionToken: 'fakeCallerTaskRoleSessionTokenEXAMPLE',
  });

  function stsXml(opts: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: number }) {
    return `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>${opts.accessKeyId}</AccessKeyId>
      <SecretAccessKey>${opts.secretAccessKey}</SecretAccessKey>
      <SessionToken>${opts.sessionToken}</SessionToken>
      <Expiration>${new Date(opts.expiresAt).toISOString()}</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <AssumedRoleId>AROAEXAMPLE:vitana-gateway-delivery-bedrock</AssumedRoleId>
      <Arn>arn:aws:sts::999999999999:assumed-role/vitana-delivery-bedrock/vitana-gateway-delivery-bedrock</Arn>
    </AssumedRoleUser>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>example-request-id</RequestId></ResponseMetadata>
</AssumeRoleResponse>`;
  }

  let fetchMock: jest.Mock;

  beforeEach(() => {
    __resetDeliveryBedrockCredentialsCacheForTests();
    fetchMock = fetch as unknown as jest.Mock;
  });

  it('calls sts:AssumeRole with the delivery role ARN and parses the returned credentials', async () => {
    const expiresAt = Date.now() + 3600_000;
    fetchMock.mockImplementationOnce(async (url: unknown, init?: { method?: string; body?: string }) => {
      expect(String(url)).toBe(`https://sts.${REGION}.amazonaws.com/`);
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain(`RoleArn=${encodeURIComponent(ROLE_ARN)}`);
      expect(String(init?.body)).toContain('Action=AssumeRole');
      return {
        ok: true,
        status: 200,
        text: async () =>
          stsXml({
            accessKeyId: 'ASIADELIVERYEXAMPLE',
            secretAccessKey: 'deliverySecretKeyEXAMPLE1234567890',
            sessionToken: 'deliverySessionTokenEXAMPLE',
            expiresAt,
          }),
      };
    });

    const creds: AssumedRoleCredentials = await getDeliveryBedrockCredentials(ROLE_ARN, REGION, fakeCaller);

    expect(creds.accessKeyId).toBe('ASIADELIVERYEXAMPLE');
    expect(creds.secretAccessKey).toBe('deliverySecretKeyEXAMPLE1234567890');
    expect(creds.sessionToken).toBe('deliverySessionTokenEXAMPLE');
    expect(creds.expiresAt).toBe(expiresAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches the assumed credentials: a second call within the TTL does not call fetch again', async () => {
    const expiresAt = Date.now() + 3600_000;
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        stsXml({
          accessKeyId: 'ASIACACHEHIT',
          secretAccessKey: 'cacheHitSecretKeyEXAMPLE123456789',
          sessionToken: 'cacheHitSessionTokenEXAMPLE',
          expiresAt,
        }),
    }));

    const first = await getDeliveryBedrockCredentials(ROLE_ARN, REGION, fakeCaller);
    const second = await getDeliveryBedrockCredentials(ROLE_ARN, REGION, fakeCaller);

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-assumes the role once the cached credentials are within the refresh skew of expiry', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        stsXml({
          accessKeyId: 'ASIAFIRST',
          secretAccessKey: 'firstSecretKeyEXAMPLE1234567890AB',
          sessionToken: 'firstSessionTokenEXAMPLE',
          // Already inside the refresh skew: must be treated as unusable.
          expiresAt: Date.now() + 1_000,
        }),
    }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        stsXml({
          accessKeyId: 'ASIASECOND',
          secretAccessKey: 'secondSecretKeyEXAMPLE1234567890',
          sessionToken: 'secondSessionTokenEXAMPLE',
          expiresAt: Date.now() + 3600_000,
        }),
    }));

    const first = await getDeliveryBedrockCredentials(ROLE_ARN, REGION, fakeCaller);
    const second = await getDeliveryBedrockCredentials(ROLE_ARN, REGION, fakeCaller);

    expect(first.accessKeyId).toBe('ASIAFIRST');
    expect(second.accessKeyId).toBe('ASIASECOND');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when STS answers success with no usable Credentials block', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, text: async () => 'OK' }));
    await expect(getDeliveryBedrockCredentials(ROLE_ARN, REGION, fakeCaller)).rejects.toThrow(
      /no usable Credentials/,
    );
  });

  it('throws a clear error, including the STS error code, on a non-2xx response', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      text: async () =>
        '<ErrorResponse><Error><Code>AccessDenied</Code><Message>not authorized to assume this role</Message></Error></ErrorResponse>',
    }));
    await expect(getDeliveryBedrockCredentials(ROLE_ARN, REGION, fakeCaller)).rejects.toThrow(/AccessDenied/);
  });
});
